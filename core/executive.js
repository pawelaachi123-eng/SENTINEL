'use strict';

/**
 * Executive engine: bounded worker pools and durable workflows.
 *
 * This is the scheduling layer that actually runs things. It does not ask a
 * model to decide whether a step finished; every state transition is recorded,
 * every step has a deadline, and STOP aborts the AbortController that the step
 * is running under. Two guarantees matter:
 *
 *   • a process crash leaves a journal, not a stuck "running" row — a restart
 *     re-queues in-flight work and never re-executes a completed step;
 *   • an idempotency key is honoured across restarts, so a repeated request
 *     returns the original result instead of duplicating a side effect.
 *
 * Workflows are DAGs. A failed step is retried within its own retry budget,
 * then handed to an optional replanner that can replace downstream steps. The
 * replanner cannot resurrect a cancelled workflow and cannot exceed the budget.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function iso(now) {
  return new Date(now()).toISOString();
}

function id(prefix = 'job') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

class WorkerPool {
  constructor({ dataDir = null, size = 2, maxQueue = 100, handlers = {}, log = null, now = () => Date.now(), retryBaseMs = 100 } = {}) {
    this.dataDir = dataDir;
    this.size = Math.max(1, Math.min(8, size));
    this.maxQueue = Math.max(1, maxQueue);
    this.handlers = handlers;
    this.log = log;
    this.now = now;
    this.retryBaseMs = retryBaseMs;
    this.file = dataDir ? path.join(dataDir, 'executive-pool.json') : null;
    this.jobs = new Map();
    this.running = new Map();
    this.idempotency = new Map();
    this.stopped = true;
    this.counters = { submitted: 0, started: 0, succeeded: 0, failed: 0, cancelled: 0, retried: 0, deduped: 0, recovered: 0 };
    this.load();
  }

  load() {
    const data = readJson(this.file, null);
    if (!data) return;
    for (const job of data.jobs || []) {
      if (job.status === 'running') {
        job.status = 'queued';
        job.recovered = true;
        this.counters.recovered += 1;
      }
      this.jobs.set(job.id, job);
      if (job.idempotencyKey && ['succeeded', 'failed', 'cancelled'].includes(job.status)) this.idempotency.set(job.idempotencyKey, job.id);
    }
    if (data.counters) this.counters = { ...this.counters, ...data.counters };
  }

  persist() {
    if (!this.file) return;
    writeJson(this.file, { version: 1, savedAt: iso(this.now), counters: this.counters, jobs: [...this.jobs.values()] });
  }

  submit({ kind, payload = {}, priority = 5, deadlineMs = null, maxRetries = 0, idempotencyKey = null, approval = null, id: explicitId = null } = {}) {
    if (!kind) throw fail('a job needs a kind', 'BAD_ARGUMENT');
    if (idempotencyKey) {
      const existingId = this.idempotency.get(idempotencyKey);
      if (existingId && this.jobs.has(existingId)) {
        this.counters.deduped += 1;
        return { ...this.jobs.get(existingId), deduplicated: true };
      }
    }
    const active = [...this.jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running').length;
    if (active >= this.maxQueue) throw fail('executive queue is full', 'QUEUE_FULL');
    const job = {
      id: explicitId || id(),
      kind,
      payload,
      priority: Math.max(1, Math.min(9, Number(priority) || 5)),
      status: 'queued',
      createdAt: iso(this.now),
      startedAt: null,
      finishedAt: null,
      deadlineMs,
      maxRetries: Math.max(0, Math.min(6, Number(maxRetries) || 0)),
      attempts: 0,
      idempotencyKey,
      approval,
      checkpoint: null,
      result: null,
      error: null,
    };
    if (this.jobs.has(job.id)) throw fail(`job ${job.id} already exists`, 'DUPLICATE_JOB');
    this.jobs.set(job.id, job);
    this.counters.submitted += 1;
    this.persist();
    this.schedule();
    return { ...job };
  }

  next() {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'queued')
      .sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] || null;
  }

  schedule() {
    if (this.stopped) return;
    while (this.running.size < this.size) {
      const job = this.next();
      if (!job) break;
      this.execute(job).catch(() => {});
    }
  }

  async execute(job) {
    const handler = this.handlers[job.kind];
    if (!handler) {
      job.status = 'failed';
      job.error = { code: 'UNKNOWN_KIND', message: `no handler for ${job.kind}` };
      this.counters.failed += 1;
      this.persist();
      return;
    }
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.status = 'running';
    job.startedAt = iso(this.now);
    job.attempts += 1;
    this.counters.started += 1;
    this.persist();
    const timer = job.deadlineMs
      ? setTimeout(() => controller.abort(fail(`job ${job.id} exceeded its ${job.deadlineMs} ms deadline`, 'DEADLINE_EXCEEDED')), job.deadlineMs)
      : null;
    try {
      const result = await handler(job.payload, {
        signal: controller.signal,
        job: { ...job },
        checkpoint: (value) => {
          job.checkpoint = { at: iso(this.now), value };
          this.persist();
        },
        now: this.now,
      });
      if (controller.signal.aborted) throw controller.signal.reason || fail('cancelled', 'CANCELLED');
      job.status = 'succeeded';
      job.result = result === undefined ? null : result;
      job.error = null;
      this.counters.succeeded += 1;
      if (job.idempotencyKey) this.idempotency.set(job.idempotencyKey, job.id);
    } catch (err) {
      if (controller.signal.aborted || err.code === 'CANCELLED') {
        job.status = 'cancelled';
        job.error = { code: 'CANCELLED', message: err.message };
        this.counters.cancelled += 1;
      } else if (job.attempts <= job.maxRetries) {
        job.status = 'queued';
        job.error = { code: err.code || 'FAILED', message: err.message };
        job.retryAt = iso(() => this.now() + this.retryBaseMs * job.attempts);
        this.counters.retried += 1;
      } else {
        job.status = 'failed';
        job.error = { code: err.code || 'FAILED', message: err.message };
        this.counters.failed += 1;
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(job.id);
      if (!['queued'].includes(job.status)) job.finishedAt = iso(this.now);
      this.persist();
      if (!this.stopped) {
        if (job.status === 'queued' && job.retryAt) setTimeout(() => this.schedule(), Math.max(0, Date.parse(job.retryAt) - this.now()));
        else this.schedule();
      }
    }
  }

  start() { this.stopped = false; this.schedule(); return this; }

  async stop({ cancelRunning = true } = {}) {
    this.stopped = true;
    if (cancelRunning) this.cancelAll('executive pool stopped');
    await Promise.race([
      Promise.allSettled([...this.running.keys()].map((id_) => this.wait(id_, { timeoutMs: 2000 }))),
      new Promise((resolve) => setTimeout(resolve, 2200)),
    ]);
    return this.status();
  }

  wait(jobId, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const started = this.now();
      const check = () => {
        const job = this.jobs.get(jobId);
        if (!job) return reject(fail(`unknown job ${jobId}`, 'NOT_FOUND'));
        if (!['queued', 'running'].includes(job.status)) return resolve(job);
        if (this.now() - started > timeoutMs) return reject(fail(`job ${jobId} did not finish`, 'TIMEOUT'));
        setTimeout(check, 25);
      };
      check();
    });
  }

  cancel(jobId, reason = 'cancelled by the user') {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND' };
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return { ok: false, code: 'ALREADY_FINISHED', status: job.status };
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: reason };
      job.finishedAt = iso(this.now);
      this.counters.cancelled += 1;
      this.persist();
      return { ok: true, id: jobId, status: 'cancelled' };
    }
    this.running.get(jobId)?.abort(fail(reason, 'CANCELLED'));
    return { ok: true, id: jobId, status: 'cancelling' };
  }

  cancelAll(reason = 'global stop') {
    return [...this.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status)).map((job) => this.cancel(job.id, reason));
  }

  list({ status = null, limit = 50 } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((job) => ({ id: job.id, kind: job.kind, status: job.status, priority: job.priority, attempts: job.attempts, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, deadlineMs: job.deadlineMs, error: job.error, checkpoint: job.checkpoint ? job.checkpoint.at : null, idempotencyKey: job.idempotencyKey, recovered: Boolean(job.recovered) }));
  }

  status() {
    const counts = {};
    for (const job of this.jobs.values()) counts[job.status] = (counts[job.status] || 0) + 1;
    return { stopped: this.stopped, size: this.size, running: this.running.size, queued: counts.queued || 0, counts, counters: { ...this.counters }, jobs: this.list({ limit: 10 }) };
  }
}

class WorkflowEngine {
  constructor({ dataDir = null, log = null, now = () => Date.now(), maxConcurrent = 2, maxWorkflows = 100 } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.maxConcurrent = Math.max(1, Math.min(8, maxConcurrent));
    this.maxWorkflows = maxWorkflows;
    this.file = dataDir ? path.join(dataDir, 'workflows.json') : null;
    this.workflows = new Map();
    this.running = new Map();
    this.counters = { created: 0, completed: 0, failed: 0, cancelled: 0, replanned: 0, recovered: 0, retried: 0 };
    this.load();
  }

  load() {
    const data = readJson(this.file, null);
    if (!data) return;
    for (const workflow of data.workflows || []) {
      for (const step of workflow.steps || []) {
        // A step that was running when the process died is retried from the
        // journal; a step that was done is never executed again.
        if (step.status === 'running') {
          step.status = 'ready';
          step.recovered = true;
          this.counters.recovered += 1;
        }
      }
      this.workflows.set(workflow.id, workflow);
    }
    if (data.counters) this.counters = { ...this.counters, ...data.counters };
  }

  persist() {
    if (!this.file) return;
    writeJson(this.file, { version: 1, savedAt: iso(this.now), counters: this.counters, workflows: [...this.workflows.values()] });
  }

  create({ id: explicitId = null, name = 'workflow', steps = [], budget = {}, priority = 5, idempotencyKey = null } = {}) {
    if (!Array.isArray(steps) || !steps.length) throw fail('a workflow needs steps', 'BAD_ARGUMENT');
    if (steps.length > 64) throw fail('a workflow may have at most 64 steps', 'TOO_MANY_STEPS');
    const keys = new Set();
    for (const step of steps) {
      if (!step.id || !/^[a-zA-Z0-9._-]{1,64}$/.test(step.id)) throw fail(`invalid step id ${step.id}`, 'BAD_STEP');
      if (keys.has(step.id)) throw fail(`duplicate step id ${step.id}`, 'DUPLICATE_STEP');
      keys.add(step.id);
      if (step.tool && step.agent) throw fail(`step ${step.id} names both a tool and an agent`, 'BAD_STEP');
      if (!step.tool && !step.agent && !step.run) throw fail(`step ${step.id} has nothing to execute`, 'BAD_STEP');
    }
    for (const step of steps) for (const dependency of step.dependsOn || []) if (!keys.has(dependency)) throw fail(`step ${step.id} depends on unknown ${dependency}`, 'BAD_DEPENDENCY');
    // Cycle detection.
    const remaining = new Set(keys);
    let progress = true;
    while (remaining.size && progress) {
      progress = false;
      for (const stepId of [...remaining]) {
        const step = steps.find((entry) => entry.id === stepId);
        if ((step.dependsOn || []).every((dependency) => !remaining.has(dependency))) {
          remaining.delete(stepId);
          progress = true;
        }
      }
    }
    if (remaining.size) throw fail(`workflow contains a dependency cycle: ${[...remaining].join(', ')}`, 'CYCLE');
    if (idempotencyKey) {
      const existing = [...this.workflows.values()].find((workflow) => workflow.idempotencyKey === idempotencyKey);
      if (existing) return { ...existing, deduplicated: true };
    }
    if (this.workflows.size >= this.maxWorkflows) {
      const finished = [...this.workflows.values()].filter((workflow) => ['done', 'failed', 'cancelled'].includes(workflow.status)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (finished[0]) this.workflows.delete(finished[0].id);
    }
    const workflow = {
      id: explicitId || id('wf'),
      name,
      status: 'pending',
      priority: Math.max(1, Math.min(9, Number(priority) || 5)),
      budget: { steps: budget.steps || steps.length, ms: budget.ms || 120000, tokens: budget.tokens || 0, toolCalls: budget.toolCalls || 0 },
      usage: { steps: 0, ms: 0, tokens: 0, toolCalls: 0, retries: 0 },
      idempotencyKey,
      createdAt: iso(this.now),
      startedAt: null,
      finishedAt: null,
      steps: steps.map((step) => ({
        id: step.id,
        tool: step.tool || null,
        agent: step.agent || null,
        args: step.args || {},
        dependsOn: step.dependsOn || [],
        status: 'pending',
        attempts: 0,
        maxRetries: step.maxRetries == null ? 1 : Math.max(0, Math.min(3, step.maxRetries)),
        deadlineMs: step.deadlineMs || null,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        checkpoint: null,
        original: null,
      })),
      replans: [],
    };
    this.workflows.set(workflow.id, workflow);
    this.counters.created += 1;
    this.persist();
    return { ...workflow };
  }

  get(workflowId) { return this.workflows.get(workflowId) || null; }

  cancel(workflowId, reason = 'cancelled by the user') {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { ok: false, code: 'NOT_FOUND' };
    if (['done', 'failed', 'cancelled'].includes(workflow.status)) return { ok: false, code: 'ALREADY_FINISHED', status: workflow.status };
    workflow.status = 'cancelled';
    workflow.finishedAt = iso(this.now);
    for (const step of workflow.steps) {
      if (step.status === 'running') this.running.get(`${workflowId}:${step.id}`)?.abort(fail(reason, 'CANCELLED'));
      if (['pending', 'ready'].includes(step.status)) step.status = 'cancelled';
    }
    this.counters.cancelled += 1;
    this.persist();
    return { ok: true, id: workflowId, status: 'cancelled' };
  }

  cancelAll(reason = 'global stop') {
    return [...this.workflows.values()].filter((workflow) => !['done', 'failed', 'cancelled'].includes(workflow.status)).map((workflow) => this.cancel(workflow.id, reason));
  }

  ready(workflow) {
    return workflow.steps.filter((step) => ['pending', 'ready'].includes(step.status) && (step.dependsOn || []).every((dependency) => {
      const parent = workflow.steps.find((entry) => entry.id === dependency);
      return parent && parent.status === 'done';
    }));
  }

  /**
   * Executes a workflow. `invoke(step, context)` must perform the real work and
   * return a value or throw. `replan(workflow, failedStep)` may return replacement
   * steps; returned steps are validated and inserted after the failed one.
   */
  async run(workflowId, { invoke, replan = null, signal = null, concurrency = this.maxConcurrent } = {}) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw fail(`unknown workflow ${workflowId}`, 'NOT_FOUND');
    if (['done', 'failed', 'cancelled'].includes(workflow.status)) return { ...workflow };
    if (typeof invoke !== 'function') throw fail('workflow run needs an invoke function', 'BAD_ARGUMENT');
    workflow.status = 'running';
    workflow.startedAt = workflow.startedAt || iso(this.now);
    const startedAt = this.now();
    this.persist();
    const externalAbort = () => this.cancel(workflowId, 'cancelled during execution');
    if (signal) {
      if (signal.aborted) { this.cancel(workflowId, 'cancelled before start'); return { ...workflow }; }
      signal.addEventListener('abort', externalAbort, { once: true });
    }
    try {
      while (true) {
        if (workflow.status === 'cancelled') break;
        const pending = workflow.steps.filter((step) => ['pending', 'ready', 'running'].includes(step.status));
        if (!pending.length) {
          workflow.status = workflow.steps.some((step) => ['failed', 'cancelled'].includes(step.status)) ? 'failed' : 'done';
          break;
        }
        if (workflow.usage.steps >= workflow.budget.steps) {
          workflow.status = 'failed';
          workflow.error = { code: 'BUDGET_EXCEEDED', message: `step budget ${workflow.budget.steps} exhausted` };
          for (const step of pending) if (step.status === 'pending') step.status = 'skipped';
          break;
        }
        if (this.now() - startedAt > workflow.budget.ms) {
          workflow.status = 'failed';
          workflow.error = { code: 'DEADLINE_EXCEEDED', message: `workflow budget ${workflow.budget.ms} ms exhausted` };
          for (const step of pending) if (step.status === 'pending') step.status = 'skipped';
          break;
        }
        const ready = this.ready(workflow).slice(0, concurrency);
        if (!ready.length) {
          // A dependency failed, so downstream work cannot run.
          for (const step of pending) if (step.status === 'pending') step.status = 'skipped';
          workflow.status = 'failed';
          break;
        }
        await Promise.all(ready.map((step) => this.runStep(workflow, step, { invoke, replan })));
        if (workflow.status === 'failed' && workflow.steps.some((step) => step.status === 'pending')) {
          // A replanner may have inserted new ready work; continue if it did.
          const next = this.ready(workflow);
          if (!next.length) break;
          workflow.status = 'running';
        }
      }
      if (workflow.status === 'running') workflow.status = 'done';
    } catch (err) {
      workflow.status = 'failed';
      workflow.error = { code: err.code || 'FAILED', message: err.message };
    } finally {
      if (signal) signal.removeEventListener('abort', externalAbort);
      workflow.finishedAt = iso(this.now);
      workflow.usage.ms += this.now() - startedAt;
      if (workflow.status === 'done') this.counters.completed += 1;
      if (workflow.status === 'failed') this.counters.failed += 1;
      this.persist();
    }
    return this.snapshot(workflow);
  }

  async runStep(workflow, step, { invoke, replan }) {
    if (workflow.status === 'cancelled') return;
    if (workflow.usage.steps >= workflow.budget.steps) {
      step.status = 'failed';
      step.error = { code: 'BUDGET_EXCEEDED', message: 'step budget exhausted' };
      workflow.status = 'failed';
      return;
    }
    step.status = 'running';
    step.startedAt = iso(this.now);
    step.attempts += 1;
    workflow.usage.steps += 1;
    this.persist();
    const controller = new AbortController();
    const key = `${workflow.id}:${step.id}`;
    this.running.set(key, controller);
    const timer = step.deadlineMs
      ? setTimeout(() => controller.abort(fail(`step ${step.id} exceeded ${step.deadlineMs} ms`, 'STEP_DEADLINE')), step.deadlineMs)
      : null;
    try {
      const value = await invoke(step, {
        workflowId: workflow.id,
        signal: controller.signal,
        now: this.now,
        checkpoint: (checkpoint) => { step.checkpoint = { at: iso(this.now), value: checkpoint }; this.persist(); },
        usage: workflow.usage,
      });
      if (controller.signal.aborted) throw controller.signal.reason || fail('cancelled', 'CANCELLED');
      step.result = value === undefined ? null : value;
      step.error = null;
      step.status = 'done';
      step.finishedAt = iso(this.now);
    } catch (err) {
      step.error = { code: err.code || 'FAILED', message: err.message };
      step.finishedAt = iso(this.now);
      if (controller.signal.aborted || err.code === 'CANCELLED') {
        step.status = 'cancelled';
      } else if (step.attempts <= step.maxRetries) {
        step.status = 'pending';
        workflow.usage.retries += 1;
        this.counters.retried += 1;
      } else if (replan) {
        step.status = 'failed';
        try {
          const replacement = await replan(workflow, step);
          if (Array.isArray(replacement) && replacement.length) {
            const fresh = replacement.filter((entry) => entry && entry.id && !workflow.steps.some((existing) => existing.id === entry.id));
            for (const entry of fresh) {
              workflow.steps.push({ id: entry.id, tool: entry.tool || null, agent: entry.agent || null, args: entry.args || {}, dependsOn: entry.dependsOn || [step.id], status: 'pending', attempts: 0, maxRetries: entry.maxRetries == null ? 0 : entry.maxRetries, deadlineMs: entry.deadlineMs || null, startedAt: null, finishedAt: null, result: null, error: null, checkpoint: null, original: step.id });
            }
            step.status = 'replanned';
            workflow.replans.push({ at: iso(this.now), failedStep: step.id, replacement: fresh.map((entry) => entry.id) });
            workflow.status = 'running';
            this.counters.replanned += 1;
          }
        } catch (replanError) {
          step.error = { code: 'REPLAN_FAILED', message: replanError.message, cause: step.error };
        }
      } else {
        step.status = 'failed';
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(key);
      this.persist();
    }
  }

  snapshot(workflow) {
    return {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      budget: workflow.budget,
      usage: workflow.usage,
      createdAt: workflow.createdAt,
      startedAt: workflow.startedAt,
      finishedAt: workflow.finishedAt,
      replans: workflow.replans,
      error: workflow.error || null,
      steps: workflow.steps.map((step) => ({ id: step.id, status: step.status, attempts: step.attempts, tool: step.tool, agent: step.agent, dependsOn: step.dependsOn, result: step.result, error: step.error, checkpoint: step.checkpoint ? step.checkpoint.at : null, recovered: Boolean(step.recovered) })),
    };
  }

  list({ limit = 30 } = {}) {
    return [...this.workflows.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit).map((workflow) => this.snapshot(workflow));
  }

  status() {
    const counts = {};
    for (const workflow of this.workflows.values()) counts[workflow.status] = (counts[workflow.status] || 0) + 1;
    return { counts, counters: { ...this.counters }, workflows: this.list({ limit: 8 }) };
  }
}

class Executive {
  constructor({ dataDir = null, log = null, now = () => Date.now(), poolSize = 2, maxConcurrent = 2 } = {}) {
    this.pool = new WorkerPool({ dataDir, log, now, size: poolSize });
    this.workflows = new WorkflowEngine({ dataDir, log, now, maxConcurrent });
    this.log = log;
    this.now = now;
    this.counters = { stopAll: 0 };
  }

  register(kind, handler) { this.pool.handlers[kind] = handler; return this; }

  submit(options) { return this.pool.submit(options); }

  start() { this.pool.start(); return this; }

  async stop(reason = 'executive stopped') {
    this.counters.stopAll += 1;
    this.workflows.cancelAll(reason);
    await this.pool.stop({ cancelRunning: true });
    return this.status();
  }

  status() {
    return { pool: this.pool.status(), workflows: this.workflows.status(), counters: { ...this.counters }, honest: 'scheduler state only; no step is reported complete without a stored result' };
  }
}

module.exports = { Executive, WorkerPool, WorkflowEngine };
