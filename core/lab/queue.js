'use strict';

/**
 * Durable training queue.
 *
 * Jobs are persisted before they run and after every state transition, so a
 * crash leaves an explainable record rather than a stuck spinner. Each job has
 * a priority, an optional deadline, bounded retries and an AbortSignal for
 * cancellation. Checkpoints are written through a caller-supplied function and
 * are used to resume an interrupted job when its runner supports it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

class TrainingQueue {
  constructor({ dataDir, runners = {}, concurrency = 1, maxQueued = 64, log = null, now = () => Date.now(), retryBaseMs = 200 } = {}) {
    if (!dataDir) throw fail('TrainingQueue needs dataDir', 'BAD_ARGUMENT');
    this.dataDir = dataDir;
    this.runners = runners;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.maxQueued = Math.max(1, maxQueued);
    this.log = log;
    this.now = now;
    this.retryBaseMs = retryBaseMs;
    this.file = path.join(dataDir, 'training-queue.json');
    this.jobs = new Map();
    this.running = new Map();
    this.timer = null;
    this.stopped = true;
    this.counters = { enqueued: 0, started: 0, succeeded: 0, failed: 0, cancelled: 0, retried: 0, recovered: 0 };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const job of data.jobs || []) {
        // A job that was running when the process died is resumed, never shown as running.
        if (job.status === 'running') {
          job.status = 'queued';
          job.recovered = true;
          this.counters.recovered += 1;
        }
        this.jobs.set(job.id, job);
      }
      if (data.counters) this.counters = { ...this.counters, ...data.counters };
    } catch (err) {
      if (this.log) this.log.warn('lab-queue', `could not read queue: ${err.message}`);
    }
  }

  persist() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const payload = { version: 1, savedAt: nowIso(this.now), counters: this.counters, jobs: [...this.jobs.values()] };
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  enqueue({ kind, payload = {}, priority = 5, deadlineMs = null, maxRetries = 0, id = null, approval = null }) {
    if (!this.runners[kind]) throw fail(`no runner registered for ${kind}`, 'UNKNOWN_KIND');
    const active = [...this.jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running').length;
    if (active >= this.maxQueued) throw fail('training queue is full', 'QUEUE_FULL');
    const job = {
      id: id || `job_${crypto.randomBytes(6).toString('hex')}`,
      kind,
      payload,
      priority: Math.max(1, Math.min(9, Number(priority) || 5)),
      status: 'queued',
      createdAt: nowIso(this.now),
      startedAt: null,
      finishedAt: null,
      deadlineMs,
      maxRetries: Math.max(0, Math.min(5, Number(maxRetries) || 0)),
      attempts: 0,
      checkpoint: null,
      result: null,
      error: null,
      approval,
    };
    if (this.jobs.has(job.id)) throw fail(`job ${job.id} already exists`, 'DUPLICATE_JOB');
    this.jobs.set(job.id, job);
    this.counters.enqueued += 1;
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
    while (this.running.size < this.concurrency) {
      const job = this.next();
      if (!job) break;
      this.run(job).catch(() => {});
    }
  }

  async run(job) {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.status = 'running';
    job.startedAt = nowIso(this.now);
    job.attempts += 1;
    this.counters.started += 1;
    this.persist();
    const timeout = job.deadlineMs ? setTimeout(() => controller.abort(Object.assign(new Error(`job exceeded its ${job.deadlineMs} ms deadline`), { code: 'DEADLINE_EXCEEDED' })), job.deadlineMs) : null;
    const checkpoint = (value) => {
      job.checkpoint = { at: nowIso(this.now), value };
      this.persist();
    };
    try {
      const runner = this.runners[job.kind];
      const result = await runner(job.payload, { signal: controller.signal, checkpoint, job: { ...job }, now: this.now });
      if (controller.signal.aborted) throw controller.signal.reason || fail('cancelled', 'CANCELLED');
      job.status = 'succeeded';
      job.result = result === undefined ? null : result;
      job.error = null;
      this.counters.succeeded += 1;
    } catch (err) {
      if (controller.signal.aborted || err.code === 'CANCELLED') {
        job.status = 'cancelled';
        job.error = { code: 'CANCELLED', message: err.message };
        job.cancelledAt = nowIso(this.now);
        this.counters.cancelled += 1;
      } else if (job.attempts <= job.maxRetries) {
        job.status = 'queued';
        job.error = { code: err.code || 'FAILED', message: err.message };
        job.retryAt = nowIso(this.now + this.retryBaseMs * job.attempts);
        this.counters.retried += 1;
      } else {
        job.status = 'failed';
        job.error = { code: err.code || 'FAILED', message: err.message };
        this.counters.failed += 1;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.running.delete(job.id);
      job.finishedAt = ['succeeded', 'failed', 'cancelled'].includes(job.status) ? nowIso(this.now) : null;
      this.persist();
      if (this.stopped) return;
      if (job.status === 'queued' && job.retryAt) {
        const delay = Math.max(0, Date.parse(job.retryAt) - this.now());
        setTimeout(() => this.schedule(), delay);
      } else {
        this.schedule();
      }
    }
  }

  start() {
    this.stopped = false;
    this.schedule();
    return this;
  }

  async stop({ cancelRunning = false } = {}) {
    this.stopped = true;
    if (cancelRunning) this.cancelAll();
    if (this.timer) clearTimeout(this.timer);
    // Give runners a short chance to write their final state.
    await Promise.race([Promise.allSettled([...this.running.keys()].map((id) => this.wait(id))), new Promise((resolve) => setTimeout(resolve, 1000))]);
    return this.status();
  }

  wait(id, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const started = this.now();
      const check = () => {
        const job = this.jobs.get(id);
        if (!job) return reject(fail(`unknown job ${id}`, 'NOT_FOUND'));
        if (!['queued', 'running'].includes(job.status)) return resolve(job);
        if (this.now() - started > timeoutMs) return reject(fail(`job ${id} did not finish in ${timeoutMs} ms`, 'TIMEOUT'));
        setTimeout(check, 25);
      };
      check();
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, code: 'NOT_FOUND' };
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return { ok: false, code: 'ALREADY_FINISHED', status: job.status };
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = nowIso(this.now);
      job.error = { code: 'CANCELLED', message: 'cancelled before it started' };
      this.counters.cancelled += 1;
      this.persist();
      return { ok: true, id, status: 'cancelled' };
    }
    const controller = this.running.get(id);
    if (controller) controller.abort(fail('cancelled by the user', 'CANCELLED'));
    return { ok: true, id, status: 'cancelling' };
  }

  cancelAll() {
    const results = [];
    for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.status)) results.push(this.cancel(job.id));
    return results;
  }

  list({ status = null, limit = 50 } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((job) => ({ id: job.id, kind: job.kind, status: job.status, priority: job.priority, attempts: job.attempts, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error, checkpoint: job.checkpoint ? job.checkpoint.at : null, recovered: Boolean(job.recovered) }));
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  status() {
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const job of this.jobs.values()) counts[job.status] = (counts[job.status] || 0) + 1;
    return { stopped: this.stopped, concurrency: this.concurrency, running: this.running.size, counts, counters: { ...this.counters }, recent: this.list({ limit: 10 }) };
  }
}

module.exports = { TrainingQueue };
