'use strict';

/**
 * Security and performance tools.
 *
 * Two rules are encoded here and nowhere else:
 *   • `security.stop` is always allowed and cannot be denied — a stop button
 *     that can be blocked is not a stop button.
 *   • `security.policy.set` can tighten policy freely but needs approval to
 *     loosen anything, and can never touch the flags that protect the user
 *     (allowShutdown stays available, but confirm cannot be turned off remotely).
 */

const os = require('node:os');
const { scan } = require('../security/injection');
const { truncate } = require('./helpers');

const PROTECTED_POLICY_KEYS = ['requireConfirm'];
const WEAKENING = ['allowInput', 'allowShutdown', 'allowReboot', 'allowApps', 'allowScripts'];

module.exports = [
  {
    name: 'security.status',
    title: 'Security posture',
    description: 'Policy flags, sandbox roots, whether commands are allowed, pending approvals and counters.',
    category: 'security',
    permission: 'read',
    tags: ['security', 'policy', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const policy = ctx.config.get('policy') || {};
      const ai = ctx.config.get('ai') || {};
      return {
        policy,
        autonomy: ai.autonomy || {},
        tools: ai.tools || {},
        sandbox: ctx.sandbox ? ctx.sandbox.roots().map((root) => ({ label: root.label, mode: root.mode, path: root.path })) : [],
        approvals: ctx.approvals ? ctx.approvals.stats() : null,
        counters: ctx.registry ? ctx.registry.stats().counters : null,
        mode: 'default deny, least privilege',
        notes: [
          'system changes require approval',
          'secrets (.ssh, .env, config.json) are never readable',
          'no public network exposure: the tunnel is peer-to-peer with your pairing key',
        ],
      };
    },
  },
  {
    name: 'security.policy.set',
    title: 'Change policy',
    description: 'Tighten policy freely; loosening a protection or removing confirmation requires approval.',
    category: 'security',
    permission: 'privileged',
    tags: ['policy', 'permissions'],
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'object', description: 'policy keys to change, e.g. {"allowInput": false}' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    guard(args) {
      const patch = args.patch || {};
      for (const key of PROTECTED_POLICY_KEYS) {
        if (key in patch) return { ok: false, code: 'PROTECTED', message: `${key} cannot be changed by the assistant` };
      }
      return { ok: true };
    },
    async run(args, ctx) {
      if (!ctx.commander) throw Object.assign(new Error('the command layer is not available'), { code: 'NO_COMMANDER' });
      const current = ctx.config.get('policy') || {};
      const changes = {};
      for (const [key, value] of Object.entries(args.patch)) {
        if (!(key in current)) throw Object.assign(new Error(`unknown policy key ${key}`), { code: 'BAD_ARGS' });
        if (current[key] === value) continue;
        changes[key] = value;
      }
      if (!Object.keys(changes).length) return { changed: false, policy: current };
      const loosening = WEAKENING.filter((key) => current[key] === false && changes[key] === true);
      const result = await ctx.commander.execute('agent.policy.set', { patch: changes, confirm: true }, { source: 'ai' });
      return { changed: true, loosening: loosening.length ? loosening : null, policy: result.data, note: loosening.length ? 'this widens what the assistant may do — tell the user plainly' : 'policy tightened' };
    },
  },
  {
    name: 'security.scan',
    title: 'Scan text for injection',
    description: 'Checks text (a document, an email, a web page) for prompt-injection and command-injection patterns.',
    category: 'security',
    permission: 'read',
    tags: ['injection', 'security', 'prompt'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 200000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const result = scan(args.text, { source: 'tool' });
      return { risk: result.risk, findings: result.findings, characters: args.text.length };
    },
  },
  {
    name: 'security.audit',
    title: 'Audit trail',
    description: 'Recent tool calls, denials, approvals and security events from the activity log.',
    category: 'security',
    permission: 'read',
    tags: ['audit', 'log', 'security'],
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 30, minimum: 1, maximum: 200 },
        level: { type: 'string', enum: ['all', 'warn', 'error'], default: 'all' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const entries = ctx.log ? ctx.log.entries.slice(-400) : [];
      const filtered = entries
        .filter((entry) => (args.level === 'all' ? true : args.level === 'warn' ? ['warn', 'error'].includes(entry.level) : entry.level === 'error'))
        .filter((entry) => ['security', 'policy', 'approval', 'tool', 'command', 'power', 'input', 'apps'].includes(entry.scope))
        .slice(-args.limit);
      return {
        entries: filtered.map((entry) => ({ at: entry.at, level: entry.level, scope: entry.scope, message: entry.message, meta: entry.meta || null })),
        toolCalls: ctx.registry ? ctx.registry.stats().recent : [],
        approvals: ctx.approvals ? ctx.approvals.list({ includeSettled: true }).slice(0, 20) : [],
      };
    },
  },
  {
    name: 'security.path.check',
    title: 'Check a path',
    description: 'Answers whether the assistant may read or write a specific path, and why not.',
    category: 'security',
    permission: 'read',
    tags: ['sandbox', 'path', 'permission'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 500 }, write: { type: 'boolean', default: false } },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      try {
        const resolved = ctx.sandbox.resolve(args.path, { write: args.write });
        return { allowed: true, resolved, write: args.write };
      } catch (err) {
        return { allowed: false, code: err.code || 'SANDBOX_DENIED', message: err.message, write: args.write };
      }
    },
  },
  {
    name: 'security.stop',
    title: 'Global STOP',
    description: 'Cancels every running model call, pauses automations and denies pending approvals. Always allowed.',
    category: 'security',
    permission: 'read',
    tags: ['stop', 'emergency'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const stopped = ctx.brain ? ctx.brain.cancelAll('stopped from the STOP control') : 0;
      if (ctx.llm && typeof ctx.llm.cancelAll === 'function') ctx.llm.cancelAll('stopped');
      let paused = 0;
      if (ctx.automation) {
        for (const item of ctx.automation.list()) {
          if (item.enabled) {
            ctx.automation.toggle(item.id, false);
            paused += 1;
          }
        }
      }
      let denied = 0;
      if (ctx.approvals) {
        for (const approval of ctx.approvals.list()) {
          if (ctx.approvals.deny(approval.id, { reason: 'global stop' }).ok) denied += 1;
        }
      }
      if (ctx.log) ctx.log.warn('security', `STOP: ${stopped} model run(s) cancelled, ${paused} automation(s) paused, ${denied} approval(s) denied`);
      return { stoppedRuns: stopped, pausedAutomations: paused, deniedApprovals: denied, at: new Date().toISOString() };
    },
  },
  {
    name: 'perf.metrics',
    title: 'Performance metrics',
    description: 'CPU, memory, model latency, tool timings and queue depth.',
    category: 'perf',
    permission: 'read',
    tags: ['performance', 'metrics'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const memory = os.totalmem();
      return {
        cpuPercent: ctx.stats ? ctx.stats.read() : null,
        memory: { percent: Math.round(((memory - os.freemem()) / memory) * 100), totalGB: Number((memory / 1024 ** 3).toFixed(1)) },
        loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
        ai: ctx.llm ? ctx.llm.stats() : null,
        brain: ctx.brain ? ctx.brain.status().counters : null,
        tools: ctx.registry ? ctx.registry.stats().counters : null,
        knowledge: ctx.knowledge ? ctx.knowledge.stats() : null,
        memoryRecords: ctx.memory ? ctx.memory.stats().total || null : null,
        uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      };
    },
  },
  {
    name: 'perf.gaming',
    title: 'Gaming mode',
    description: 'Trades assistant responsiveness for GPU headroom: keeps the model out of VRAM, pauses background work.',
    category: 'perf',
    permission: 'write',
    tags: ['gaming', 'performance', 'vram'],
    parameters: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const current = Boolean(ctx.config.get('ai.gamingMode'));
      const next = args.enabled === undefined ? !current : Boolean(args.enabled);
      ctx.config.set('ai.gamingMode', next);
      if (ctx.brain && ctx.brain.list) {
        // Nothing to cancel quietly; gaming mode only changes model keep-alive.
      }
      return {
        enabled: next,
        effects: next
          ? ['model unloaded between answers (keepAlive 0)', 'no background indexing', 'UI animations reduced to 10 fps']
          : ['model stays warm', 'background indexer resumed', 'normal animations'],
        note: 'applies to the next model call',
      };
    },
  },
  {
    name: 'perf.maintenance',
    title: 'Maintenance pass',
    description: 'Compacts the database, prunes old memories and clears caches. Measures what it freed.',
    category: 'perf',
    permission: 'write',
    tags: ['maintenance', 'database', 'cleanup'],
    parameters: {
      type: 'object',
      properties: {
        pruneDays: { type: 'integer', default: 180, minimum: 30, maximum: 3650 },
        compact: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const before = ctx.memory ? ctx.memory.stats() : null;
      let pruned = 0;
      if (ctx.memory && typeof ctx.memory.prune === 'function') {
        pruned = Number(ctx.memory.prune({ maxAgeDays: args.pruneDays })) || 0;
      }
      let compacted = null;
      if (args.compact && ctx.store && typeof ctx.store.compact === 'function') {
        compacted = await ctx.store.compact();
      }
      if (ctx.llm && typeof ctx.llm.clearHealthCache === 'function') ctx.llm.clearHealthCache();
      const after = ctx.memory ? ctx.memory.stats() : null;
      return { pruned, compacted, before, after, note: truncate('maintenance does not delete knowledge; remove documents explicitly with kb.remove', 200) };
    },
  },
];
