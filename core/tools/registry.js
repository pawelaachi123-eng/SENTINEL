'use strict';

/**
 * Universal tool engine.
 *
 * Every capability the assistant has is a tool registered here, and every tool
 * goes through the same gate:
 *
 *   schema validation → permission → sandbox → rate limit → timeout →
 *   cancellation → audit → size-limited result → injection screening
 *
 * The engine is deliberately the only way the model touches the machine. If it
 * is not a tool, the model cannot do it — no shell fallback, no dynamic import,
 * no "just run this".
 */

const { validate, describeParameters } = require('./schema');
const { SandboxError } = require('../security/sandbox');
const { guardToolOutput } = require('../security/injection');

const PERMISSION_ORDER = { read: 0, network: 1, write: 2, system: 3, privileged: 4 };

class ToolError extends Error {
  constructor(message, { code = 'TOOL_ERROR', detail = null } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.detail = detail;
  }
}

class ToolRegistry {
  constructor({ config, log, sandbox, approvals, services = {}, now = () => Date.now() }) {
    this.config = config;
    this.log = log;
    this.sandbox = sandbox;
    this.approvals = approvals;
    this.services = services;
    this.now = now;
    this.tools = new Map();
    this.counters = { calls: 0, errors: 0, denials: 0, timeouts: 0, truncated: 0, approvalsRequested: 0 };
    this.limits = new Map(); // name → timestamps
    this.sessionLimits = new Map(); // sessionId → timestamps
    this.recent = []; // last 50 calls, for Diagnostics
    this.execution = new Map(); // name → { calls, ok, fail, ms, lastAt } — "verified" needs evidence
  }

  /* ── registration ───────────────────────────────────────────────────── */

  register(tool) {
    if (!tool || !tool.name) throw new Error('a tool needs a name');
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`);
    if (typeof tool.run !== 'function') throw new Error(`tool ${tool.name} has no run()`);
    if ((tool.permission || 'read') in PERMISSION_ORDER === false) {
      throw new Error(`tool ${tool.name} has an unknown permission ${tool.permission}`);
    }
    const normalised = {
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || '',
      category: tool.category || 'general',
      permission: tool.permission || 'read',
      tags: tool.tags || [],
      parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false },
      pathParams: tool.pathParams || [],
      timeoutMs: Math.min(Number(tool.timeoutMs) || 15000, 600000),
      maxResultChars: Number(tool.maxResultChars) || 16000,
      requiresNetwork: Boolean(tool.requiresNetwork),
      enabled: tool.enabled !== false,
      format: tool.format || null,
      run: tool.run,
      guard: tool.guard || null,
      examples: tool.examples || [],
      since: tool.since || null,
    };
    this.tools.set(normalised.name, normalised);
    return normalised;
  }

  registerAll(list) {
    for (const tool of list) this.register(tool);
    return this.tools.size;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  has(name) {
    return this.tools.has(name);
  }

  /** Platform availability, counted separately from "implemented". */
  availability(tool) {
    const platforms = tool.platform ? [].concat(tool.platform) : null;
    if (platforms && !platforms.includes('all') && !platforms.includes(process.platform)) return { available: false, reason: `only on ${platforms.join('/')}` };
    if (!tool.enabled) return { available: false, reason: 'switched off' };
    return { available: true, reason: null };
  }

  executionStats(name) {
    return this.execution.get(name) || { calls: 0, ok: 0, fail: 0, ms: 0, lastAt: null };
  }

  list({ category = null, permission = null, tag = null, includeDisabled = false } = {}) {
    return [...this.tools.values()]
      .filter((tool) => (includeDisabled || tool.enabled))
      .filter((tool) => (category ? tool.category === category : true))
      .filter((tool) => (permission ? tool.permission === permission : true))
      .filter((tool) => (tag ? tool.tags.includes(tag) : true))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        category: tool.category,
        permission: tool.permission,
        tags: tool.tags,
        parameters: tool.parameters,
        summary: describeParameters(tool.parameters),
        examples: tool.examples,
        timeoutMs: tool.timeoutMs,
        risk: tool.permission === 'dangerous' || tool.permission === 'privileged' ? 'high' : tool.permission === 'write' || tool.permission === 'system' ? 'medium' : 'low',
        platform: tool.platform || 'all',
        available: this.availability(tool).available,
        unavailableReason: this.availability(tool).reason,
        dryRun: Boolean(tool.dryRun),
        executions: this.executionStats(tool.name),
        verified: this.executionStats(tool.name).ok > 0,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  /** Compact catalogue for a model prompt. */
  promptCatalogue({ categories = null, maxTools = 40 } = {}) {
    return this.list()
      .filter((tool) => (categories ? categories.includes(tool.category) : true))
      .slice(0, maxTools)
      .map((tool) => `- ${tool.name}: ${tool.description}${tool.summary ? ` [${tool.summary}]` : ''}`)
      .join('\n');
  }

  categories() {
    const map = new Map();
    for (const tool of this.tools.values()) map.set(tool.category, (map.get(tool.category) || 0) + 1);
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  stats() {
    const tools = [...this.tools.values()];
    const available = tools.filter((tool) => this.availability(tool).available).length;
    const verified = tools.filter((tool) => this.executionStats(tool.name).ok > 0).length;
    return {
      tools: this.tools.size,
      implemented: this.tools.size,
      available,
      verified,
      dryRunnable: tools.filter((tool) => Boolean(tool.dryRun)).length,
      categories: this.categories(),
      counters: { ...this.counters },
      recent: this.recent.slice(-20),
    };
  }

  /* ── permission ─────────────────────────────────────────────────────── */

  requiresApproval(permission) {
    const autonomy = (this.config.get('ai.autonomy') || {});
    if (permission === 'read' || permission === 'network') return false;
    if (permission === 'write') return Boolean(autonomy.requireApprovalForWrites);
    if (permission === 'system' || permission === 'privileged') return autonomy.requireApprovalForSystem !== false;
    return true;
  }

  rateLimitAllows(tool, sessionId) {
    const now = this.now();
    const perMinute = tool.permission === 'read' ? 120 : 30;
    const list = (this.limits.get(tool.name) || []).filter((at) => now - at < 60000);
    if (list.length >= perMinute) return { ok: false, reason: `${tool.name} is limited to ${perMinute} calls/minute` };
    list.push(now);
    this.limits.set(tool.name, list);

    if (sessionId) {
      const session = (this.sessionLimits.get(sessionId) || []).filter((at) => now - at < 60000);
      if (session.length >= 90) return { ok: false, reason: 'this session is limited to 90 tool calls/minute' };
      session.push(now);
      this.sessionLimits.set(sessionId, session);
    }
    return { ok: true };
  }

  /* ── execution ──────────────────────────────────────────────────────── */

  /**
   * @param {string} name
   * @param {object} args
   * @param {object} options
   * @param {string} [options.source]       'chat' | 'tool' | 'cli' | 'automation' | 'agent'
   * @param {string} [options.sessionId]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.approvalId]   an approval the user already granted
   */
  async execute(name, args = {}, options = {}) {
    const started = this.now();
    const { source = 'tool', sessionId = null, signal = null, approvalId = null, dryRun = false } = options;
    const tool = this.tools.get(name);
    const finish = (payload) => {
      const ms = this.now() - started;
      const stats = this.execution.get(name) || { calls: 0, ok: 0, fail: 0, ms: 0, lastAt: null };
      stats.calls += 1;
      stats.ms += ms;
      stats.lastAt = this.now();
      if (payload.ok) stats.ok += 1;
      else if (!['APPROVAL_REQUIRED', 'CANCELLED', 'TOOL_DISABLED', 'RATE_LIMITED'].includes(payload.code)) stats.fail += 1;
      this.execution.set(name, stats);
      const entry = {
        at: new Date(this.now()).toISOString(),
        tool: name,
        source,
        ok: payload.ok,
        ms: this.now() - started,
        code: payload.code || null,
        args: redact(args),
      };
      this.recent.push(entry);
      if (this.recent.length > 80) this.recent.shift();
      return { tool: name, ms: this.now() - started, ...payload };
    };

    if (!tool) {
      this.counters.errors += 1;
      return finish({ ok: false, code: 'UNKNOWN_TOOL', message: `no tool named ${name}` });
    }
    if (!tool.enabled) {
      this.counters.denials += 1;
      return finish({ ok: false, code: 'TOOL_DISABLED', message: `${name} is switched off` });
    }

    const validated = validate(args, tool.parameters);
    if (!validated.ok) {
      this.counters.errors += 1;
      return finish({
        ok: false,
        code: 'BAD_ARGS',
        message: `${name}: ${validated.errors.join('; ')}`,
        errors: validated.errors,
        parameters: describeParameters(tool.parameters),
      });
    }
    const value = validated.value;

    // Paths are checked before permission so an escape attempt is loud.
    let sandboxed = {};
    try {
      for (const entry of tool.pathParams) {
        const key = typeof entry === 'string' ? entry : entry.name;
        const mode = typeof entry === 'string' ? (tool.permission === 'write' ? 'write' : 'read') : entry.mode || 'read';
        if (value[key] === undefined) continue;
        sandboxed[key] = this.sandbox.resolve(value[key], { write: mode === 'write' });
        value[key] = sandboxed[key];
      }
    } catch (err) {
      this.counters.denials += 1;
      const code = err instanceof SandboxError ? err.code : 'BAD_PATH';
      if (this.log) this.log.warn('security', `sandbox refused ${name}: ${err.message}`, { args: redact(args) });
      return finish({ ok: false, code, message: err.message });
    }

    if (tool.requiresNetwork && this.config.get('ai.tools.allowNetwork') === false) {
      this.counters.denials += 1;
      return finish({ ok: false, code: 'NETWORK_DISABLED', message: 'network tools are disabled in settings' });
    }

    const gate = this.rateLimitAllows(tool, sessionId);
    if (!gate.ok) {
      this.counters.denials += 1;
      return finish({ ok: false, code: 'RATE_LIMITED', message: gate.reason });
    }

    let approval = null;
    if (approvalId) {
      const consumed = this.approvals
        ? this.approvals.consume(approvalId, { tool: name, args: value })
        : { ok: false, code: 'APPROVALS_OFF', message: 'approvals are not wired up' };
      if (!consumed.ok) {
        this.counters.denials += 1;
        return finish({ ok: false, code: consumed.code, message: consumed.message });
      }
      approval = consumed.entry;
    }
    if (this.requiresApproval(tool.permission) && !approvalId) {
      this.counters.approvalsRequested += 1;
      const granted = this.approvals
        ? this.approvals.request({
            tool: name,
            args: value,
            permission: tool.permission,
            requestedBy: source,
            runId: options.runId || null,
          })
        : null;
      return finish({
        ok: false,
        code: 'APPROVAL_REQUIRED',
        message: `${tool.title} needs your approval (${tool.permission})`,
        approval: granted,
      });
    }
    if (tool.guard) {
      try {
        const verdict = await tool.guard(value, { ...this.services, config: this.config, sandbox: this.sandbox });
        if (verdict && verdict.ok === false) {
          this.counters.denials += 1;
          return finish({ ok: false, code: verdict.code || 'GUARD_DENIED', message: verdict.message || 'refused by the tool guard' });
        }
      } catch (err) {
        this.counters.errors += 1;
        return finish({ ok: false, code: 'GUARD_FAILED', message: err.message });
      }
    }

    if (dryRun) {
      if (typeof tool.dryRun === 'function') {
        try {
          const preview = await tool.dryRun(value, { ...this.services, config: this.config, sandbox: this.sandbox });
          return finish({ ok: true, data: { dryRun: true, tool: name, preview }, dryRun: true });
        } catch (err) {
          return finish({ ok: false, code: err.code || 'DRY_RUN_FAILED', message: err.message });
        }
      }
      return finish({ ok: true, data: { dryRun: true, wouldRun: name, args: value, note: 'this tool does not implement a dry run; nothing was executed' }, dryRun: true });
    }

    // Timeout + caller cancellation, combined into one signal.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    if (signal) {
      if (signal.aborted) return finish({ ok: false, code: 'CANCELLED', message: 'cancelled before it started' });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = Math.min(tool.timeoutMs, Number(this.config.get('ai.limits.timeoutMs')) || tool.timeoutMs);
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('tool timeout'), { code: 'TIMEOUT' })), timeoutMs);
    if (timer.unref) timer.unref();

    const ctx = {
      ...this.services,
      config: this.config,
      log: this.log,
      sandbox: this.sandbox,
      signal: controller.signal,
      source,
      sessionId,
      now: this.now,
      registry: this,
    };

    this.counters.calls += 1;
    try {
      const data = await tool.run(value, ctx);
      let text;
      if (tool.format) {
        text = tool.format(data, value);
      } else if (typeof data === 'string') {
        text = data;
      } else {
        text = JSON.stringify(data, null, 1);
      }
      let truncated = false;
      if (typeof text === 'string' && text.length > tool.maxResultChars) {
        text = `${text.slice(0, tool.maxResultChars)}\n… [result truncated from ${text.length} characters]`;
        truncated = true;
        this.counters.truncated += 1;
      }
      const guarded = guardToolOutput(text, { limit: tool.maxResultChars });
      if (this.log) {
        this.log.debug('tool', `${name} ok in ${this.now() - started}ms`, { source, bytes: text.length });
      }
      return finish({
        ok: true,
        data,
        text: guarded.text,
        truncated,
        risk: guarded.risk,
        findings: guarded.findings,
        approvalId: approval ? approval.id : null,
      });
    } catch (err) {
      const code = err.code || 'TOOL_FAILED';
      if (code === 'TIMEOUT' || (err.name === 'AbortError' && !signal)) this.counters.timeouts += 1;
      if (code !== 'CANCELLED') this.counters.errors += 1;
      if (this.log) {
        const level = code === 'CANCELLED' ? 'debug' : 'warn';
        this.log[level]('tool', `${name} failed: ${code} ${err.message}`, { source });
      }
      return finish({ ok: false, code, message: err.message, detail: err.detail || null });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Audit-safe argument copy: long strings shortened, obvious secrets masked. */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 3) return '…';
  if (typeof value === 'string') {
    if (/(key|token|password|secret|hasło|haslo)/i.test(value) && value.length > 12) return '«redacted»';
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /(key|token|password|secret|psk)/i.test(key) ? '«redacted»' : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { ToolRegistry, ToolError, PERMISSION_ORDER, redact };
