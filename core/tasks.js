'use strict';

/**
 * Durable task engine.
 *
 * A task is a goal plus a DAG of steps. The engine owns the parts that are easy
 * to get wrong: dependency order, cycle rejection, retry with backoff, budgets
 * and deadlines, checkpoints, pause/resume/cancel with explicit semantics, and
 * reconciliation after a restart — because a task that was "running" when the
 * machine rebooted must never be silently repeated or silently forgotten.
 *
 * Every transition is persisted before the caller is told it happened, so the
 * Tasks panel cannot show a state the store does not have.
 */

const { newId } = require('./memory/store');

const STATUSES = ['pending', 'planning', 'running', 'waiting_approval', 'verifying', 'paused', 'done', 'failed', 'cancelled', 'timeout', 'interrupted'];
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'timeout']);
const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];

const DEFAULT_POLICY = { maxAttempts: 2, backoffMs: 2000, backoffFactor: 2 };

/** Validates a plan. Returns {ok, errors, order} — never mutates the plan. */
function validateDag(steps, { maxSteps = 32 } = {}) {
  const errors = [];
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) errors.push('plan is empty');
  if (list.length > maxSteps) errors.push(`plan has ${list.length} steps (max ${maxSteps})`);
  const ids = new Set();
  for (const step of list) {
    if (!step || typeof step !== 'object') {
      errors.push('a step is not an object');
      continue;
    }
    const id = step.id || step.key;
    if (!id) errors.push('a step has no id');
    else if (ids.has(id)) errors.push(`duplicate step id ${id}`);
    else ids.add(id);
    if (!step.title && !step.goal && !step.description) errors.push(`step ${id || '?'} has no title`);
    if (step.agent && typeof step.agent !== 'string') errors.push(`step ${id || '?'} has a non-string agent`);
    if (step.tool && typeof step.tool !== 'string') errors.push(`step ${id || '?'} has a non-string tool`);
  }
  for (const step of list) {
    const id = step && (step.id || step.key);
    for (const dependency of (step && step.dependsOn) || []) {
      if (!ids.has(dependency)) errors.push(`step ${id} depends on unknown step ${dependency}`);
      if (dependency === id) errors.push(`step ${id} depends on itself`);
    }
  }
  // Kahn's algorithm: a cycle is a plan error, not a runtime surprise.
  const incoming = new Map(list.map((step) => [step.id || step.key, 0]));
  const outgoing = new Map(list.map((step) => [step.id || step.key, []]));
  for (const step of list) {
    const id = step.id || step.key;
    for (const dependency of step.dependsOn || []) {
      if (!incoming.has(id)) continue;
      incoming.set(id, incoming.get(id) + 1);
      if (outgoing.has(dependency)) outgoing.get(dependency).push(id);
    }
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id) || []) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== incoming.size) {
    const cyclic = [...incoming.entries()].filter(([, count]) => count > 0).map(([id]) => id);
    errors.push(`plan contains a cycle: ${cyclic.join(' → ')}`);
  }
  return { ok: errors.length === 0, errors, order };
}

class TaskManager {
  constructor({ store, log, now = () => Date.now(), maxTasks = 500, maxSteps = 32, timers = { setTimeout, clearTimeout } } = {}) {
    this.store = store || null;
    this.log = log;
    this.now = now;
    this.maxTasks = maxTasks;
    this.maxSteps = maxSteps;
    this.timers = timers;
    this.collection = 'tasks';
    this.tasks = new Map();
    this.timeouts = new Map();
    this.cancelHooks = new Map();
    this.counters = { created: 0, completed: 0, failed: 0, cancelled: 0, timeouts: 0, retries: 0, interrupted: 0, resumed: 0, reconciled: 0 };
    this.load();
  }

  load() {
    if (!this.store) return;
    for (const task of this.store.list(this.collection)) this.tasks.set(task.id, task);
    this.reconcile();
  }

  /**
   * A restart is a real event. Anything that claimed to be running is marked
   * interrupted with the reason and time, instead of looking stuck forever or
   * being executed a second time.
   */
  reconcile() {
    let changed = 0;
    for (const task of this.tasks.values()) {
      if (['running', 'planning', 'verifying', 'waiting_approval'].includes(task.status)) {
        task.status = 'interrupted';
        task.error = `interrupted by a restart at ${new Date(this.now()).toISOString()}`;
        task.recoveredAt = this.now();
        task.checkpoint = task.checkpoint || { at: task.updatedAt || task.createdAt, seq: 0 };
        this.counters.interrupted += 1;
        this.counters.reconciled += 1;
        this.persist(task);
        changed += 1;
        if (this.log) this.log.warn('task', `reconciled interrupted task "${task.title}"`);
      }
    }
    return changed;
  }

  persist(task) {
    task.updatedAt = this.now();
    this.tasks.set(task.id, task);
    if (this.store) this.store.put(this.collection, task.id, task);
    this.trim();
    return task;
  }

  trim() {
    if (this.tasks.size <= this.maxTasks) return;
    const finished = [...this.tasks.values()]
      .filter((task) => TERMINAL.has(task.status))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    while (this.tasks.size > this.maxTasks && finished.length) {
      const task = finished.shift();
      this.tasks.delete(task.id);
      if (this.store) this.store.delete(this.collection, task.id);
    }
  }

  /** Registers a function that aborts whatever the task is doing right now. */
  onCancel(taskId, fn) {
    if (typeof fn !== 'function') return () => {};
    const set = this.cancelHooks.get(taskId) || new Set();
    set.add(fn);
    this.cancelHooks.set(taskId, set);
    return () => set.delete(fn);
  }

  create({
    title,
    goal = '',
    steps = [],
    priority = 3,
    timeoutMs = 10 * 60 * 1000,
    sessionId = null,
    runId = null,
    agent = null,
    acceptanceCriteria = [],
    idempotencyKey = null,
    policy = null,
    deadline = null,
  } = {}) {
    if (!title && !goal) throw Object.assign(new Error('a task needs a title or a goal'), { code: 'BAD_ARGS' });
    if (idempotencyKey) {
      const existing = [...this.tasks.values()].find((task) => task.idempotencyKey === idempotencyKey && !TERMINAL.has(task.status));
      if (existing) return existing;
    }
    const normalised = (steps || []).map((step, index) => ({
      id: step.id || `s${index + 1}`,
      title: step.title || step.goal || step.description || `step ${index + 1}`,
      goal: step.goal || step.title || null,
      agent: step.agent || null,
      tool: step.tool || null,
      args: step.args || null,
      inputs: step.inputs && typeof step.inputs === 'object' ? step.inputs : null,
      outputs: step.outputs && typeof step.outputs === 'object' ? step.outputs : null,
      idempotent: step.idempotent === true,
      parallel: step.parallel !== false,
      timeoutMs: Number(step.timeoutMs) || null,
      preconditions: Array.isArray(step.preconditions) ? step.preconditions.slice(0, 6) : [],
      acceptance: step.acceptance || step.acceptanceCriteria || null,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      status: 'pending',
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(Number(step.maxAttempts || (policy && policy.maxAttempts) || DEFAULT_POLICY.maxAttempts), 5)),
      nextAttemptAt: null,
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }));
    if (normalised.length > this.maxSteps) throw Object.assign(new Error(`a task can have at most ${this.maxSteps} steps`), { code: 'TOO_MANY_STEPS' });
    const validation = validateDag(normalised, { maxSteps: this.maxSteps });
    if (!validation.ok) {
      throw Object.assign(new Error(`invalid plan: ${validation.errors.join('; ')}`), { code: 'INVALID_PLAN', errors: validation.errors });
    }
    const task = {
      id: newId('task'),
      title: title || String(goal).slice(0, 80),
      goal,
      status: 'pending',
      priority,
      agent,
      sessionId,
      runId,
      idempotencyKey,
      acceptanceCriteria: (acceptanceCriteria || []).slice(0, 10),
      policy: { ...DEFAULT_POLICY, ...(policy || {}) },
      deadline: deadline || null,
      steps: normalised,
      progress: 0,
      result: null,
      error: null,
      checkpoint: { at: this.now(), seq: 0, completed: [] },
      createdAt: this.now(),
      updatedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      timeoutMs: Math.max(5000, Math.min(Number(timeoutMs) || 600000, 3600000)),
    };
    this.counters.created += 1;
    this.persist(task);
    if (this.log) this.log.info('task', `created "${task.title}" (${task.steps.length} steps)`);
    return task;
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  list({ status = null, limit = 50, sessionId = null } = {}) {
    return [...this.tasks.values()]
      .filter((task) => (status ? task.status === status : true))
      .filter((task) => (sessionId ? task.sessionId === sessionId : true))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map((task) => ({
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        progress: task.progress,
        steps: task.steps.length,
        done: task.steps.filter((step) => step.status === 'done').length,
        failed: task.steps.filter((step) => step.status === 'failed').length,
        retries: task.steps.reduce((sum, step) => sum + Math.max(0, (step.attempts || 0) - 1), 0),
        checkpoint: task.checkpoint ? task.checkpoint.seq : 0,
        deadline: task.deadline,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }));
  }

  checkpoint(id, extra = {}) {
    const task = this.get(id);
    if (!task) return null;
    task.checkpoint = {
      at: this.now(),
      seq: (task.checkpoint ? task.checkpoint.seq : 0) + 1,
      completed: task.steps.filter((step) => step.status === 'done').map((step) => step.id),
      ...extra,
    };
    this.persist(task);
    return task.checkpoint;
  }

  start(id) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    if (task.status === 'paused') return this.resume(id);
    if (TERMINAL.has(task.status)) throw Object.assign(new Error(`task ${id} is already ${task.status}`), { code: 'TASK_FINISHED' });
    task.status = 'running';
    task.startedAt = task.startedAt || this.now();
    task.error = null;
    this.persist(task);
    this.checkpoint(id, { event: 'started' });
    const timer = this.timers.setTimeout(() => {
      if (TERMINAL.has(task.status)) return;
      task.status = 'timeout';
      task.error = `task exceeded ${Math.round(task.timeoutMs / 1000)} s`;
      task.finishedAt = this.now();
      this.counters.timeouts += 1;
      this.persist(task);
      this.runCancelHooks(id, 'timeout');
      if (this.log) this.log.warn('task', `timeout: ${task.title}`);
    }, task.timeoutMs);
    if (timer.unref) timer.unref();
    this.timeouts.set(task.id, timer);
    return task;
  }

  runCancelHooks(id, reason) {
    const hooks = this.cancelHooks.get(id);
    if (!hooks) return 0;
    let called = 0;
    for (const hook of hooks) {
      try {
        hook(reason);
        called += 1;
      } catch {
        /* a failing hook cannot block cancellation */
      }
    }
    this.cancelHooks.delete(id);
    return called;
  }

  pause(id, reason = 'paused by user') {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    if (!['running', 'planning', 'verifying', 'waiting_approval'].includes(task.status)) return { ok: false, code: 'NOT_RUNNING', status: task.status };
    task.status = 'paused';
    task.pausedAt = this.now();
    task.pausedReason = reason;
    const timer = this.timeouts.get(id);
    if (timer) {
      this.timers.clearTimeout(timer);
      this.timeouts.delete(id);
    }
    this.persist(task);
    this.checkpoint(id, { event: 'paused', reason });
    // Pausing does not abort running work; it stops new steps from being taken.
    return { ok: true, task };
  }

  resume(id) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    if (!['paused', 'interrupted'].includes(task.status)) return { ok: false, code: 'NOT_PAUSED', status: task.status };
    task.status = 'running';
    task.resumedAt = this.now();
    this.counters.resumed += 1;
    this.persist(task);
    this.checkpoint(id, { event: 'resumed' });
    const remaining = Math.max(5000, (task.deadline || task.startedAt + task.timeoutMs) - this.now());
    const timer = this.timers.setTimeout(() => {
      if (TERMINAL.has(task.status)) return;
      task.status = 'timeout';
      task.error = `task exceeded its deadline`;
      task.finishedAt = this.now();
      this.counters.timeouts += 1;
      this.persist(task);
    }, remaining);
    if (timer.unref) timer.unref();
    this.timeouts.set(id, timer);
    return { ok: true, task };
  }

  /** Non-terminal state change used by the executor (waiting, verifying, retrying). */
  setState(id, status, detail = null) {
    const task = this.get(id);
    if (!task) return null;
    if (!STATUSES.includes(status)) return null;
    if (TERMINAL.has(task.status)) return task;
    task.status = status;
    if (detail) task.stateDetail = String(detail).slice(0, 400);
    this.persist(task);
    return task;
  }

  /**
   * Appends steps to a live task — used when replanning a failed subgraph.
   * Existing ids are never replaced; a colliding id is rejected, because a
   * silent overwrite would lose a completed result.
   */
  insertSteps(id, steps, { after = null } = {}) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length) return { ok: false, code: 'EMPTY_PLAN', errors: ['no steps'] };
    const existing = new Set(task.steps.map((step) => step.id));
    for (const step of list) {
      if (!step || !step.id) return { ok: false, code: 'INVALID_PLAN', errors: ['a new step has no id'] };
      if (existing.has(step.id)) return { ok: false, code: 'INVALID_PLAN', errors: [`step ${step.id} already exists`] };
      existing.add(step.id);
    }
    const combined = [...task.steps, ...list];
    const valid = validateDag(combined, { maxSteps: Number(task.policy.maxSteps) || 64 });
    if (!valid.ok) return { ok: false, code: 'INVALID_PLAN', errors: valid.errors };
    const insertAt = after ? task.steps.findIndex((step) => step.id === after) : -1;
    const normalised = list.map((step) => ({
      ...step,
      goal: step.goal || step.title || null,
      inputs: step.inputs || null,
      outputs: step.outputs || null,
      idempotent: step.idempotent === true,
      parallel: step.parallel !== false,
      status: 'pending',
      attempts: 0,
      maxAttempts: step.maxAttempts || task.policy.maxAttempts,
      dependsOn: step.dependsOn || [],
      nextAttemptAt: null,
      result: null,
      error: null,
    }));
    if (insertAt >= 0) task.steps.splice(insertAt + 1, 0, ...normalised);
    else task.steps.push(...normalised);
    task.replans = (task.replans || 0) + 1;
    if (TERMINAL.has(task.status)) task.status = 'running';
    this.persist(task);
    this.checkpoint(id, { event: 'replan', steps: normalised.map((step) => step.id) });
    return { ok: true, task, added: normalised.map((step) => step.id) };
  }

  stepStart(id, stepId) {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.status = 'running';
    step.attempts = (step.attempts || 0) + 1;
    step.startedAt = this.now();
    return this.persist(task);
  }

  stepDone(id, stepId, result) {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.status = 'done';
    step.result = result === undefined ? null : result;
    step.error = null;
    step.finishedAt = this.now();
    step.nextAttemptAt = null;
    task.progress = Math.round((task.steps.filter((entry) => entry.status === 'done').length / Math.max(1, task.steps.length)) * 100);
    this.persist(task);
    this.checkpoint(id, { event: 'step-done', step: stepId });
    return task;
  }

  /**
   * Records a failure. If attempts remain, the step stays runnable after a
   * backoff instead of being retried in a tight loop.
   */
  /** Marks a step as superseded by a replanned branch; its error is preserved. */
  skipStep(id, stepId, reason = 'superseded by a replanned step') {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.status = 'skipped';
    step.superseded = true;
    step.supersededReason = String(reason).slice(0, 200);
    step.finishedAt = this.now();
    task.progress = Math.round((task.steps.filter((entry) => entry.status === 'done' || entry.status === 'skipped').length / Math.max(1, task.steps.length)) * 100);
    this.persist(task);
    this.checkpoint(id, { event: 'step-skipped', step: stepId, reason: step.supersededReason });
    return task;
  }

  stepFailed(id, stepId, error, { retryable = true } = {}) {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.error = String(error || 'failed');
    step.finishedAt = this.now();
    const attempts = step.attempts || 1;
    if (retryable && attempts < (step.maxAttempts || task.policy.maxAttempts)) {
      step.status = 'pending';
      const delay = (task.policy.backoffMs || DEFAULT_POLICY.backoffMs) * (task.policy.backoffFactor || 2) ** (attempts - 1);
      step.nextAttemptAt = this.now() + delay;
      this.counters.retries += 1;
    } else {
      step.status = 'failed';
      step.nextAttemptAt = null;
    }
    this.persist(task);
    return task;
  }

  finish(id, { result = null, status = 'done', error = null } = {}) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    task.status = STATUSES.includes(status) ? status : 'done';
    task.result = result;
    task.error = error;
    task.finishedAt = this.now();
    if (task.status === 'done') task.progress = 100;
    const allDone = task.steps.every((step) => step.status === 'done');
    const someDone = task.steps.some((step) => step.status === 'done');
    task.partial = task.status !== 'done' && someDone;
    if (task.status === 'done' && !allDone) {
      task.status = 'failed';
      task.error = task.error || 'finished before every step succeeded';
      task.partial = true;
    }
    const timer = this.timeouts.get(id);
    if (timer) {
      this.timers.clearTimeout(timer);
      this.timeouts.delete(id);
    }
    if (task.status === 'done') this.counters.completed += 1;
    else if (task.status === 'failed') this.counters.failed += 1;
    this.persist(task);
    this.runCancelHooks(id, task.status);
    if (this.log) this.log.info('task', `${task.status}: ${task.title}`);
    return task;
  }

  cancel(id, reason = 'cancelled by user') {
    const task = this.get(id);
    if (!task) return false;
    if (TERMINAL.has(task.status)) return false;
    task.status = 'cancelled';
    task.error = reason;
    task.finishedAt = this.now();
    for (const step of task.steps) {
      if (['running', 'pending'].includes(step.status)) step.status = 'skipped';
    }
    const timer = this.timeouts.get(id);
    if (timer) {
      this.timers.clearTimeout(timer);
      this.timeouts.delete(id);
    }
    this.counters.cancelled += 1;
    this.persist(task);
    const hooks = this.runCancelHooks(id, reason);
    if (this.log) this.log.warn('task', `cancelled: ${task.title} (${hooks} hook(s))`);
    return true;
  }

  /** Which steps are runnable now: dependencies done, retry backoff elapsed. */
  readySteps(id) {
    const task = this.get(id);
    if (!task) return [];
    if (['paused', 'cancelled', 'done', 'failed', 'timeout', 'interrupted'].includes(task.status)) return [];
    if (task.deadline && this.now() > task.deadline) return [];
    const status = new Map(task.steps.map((step) => [step.id, step.status]));
    return task.steps.filter((step) => {
      if (['running', 'done', 'skipped', 'failed', 'cancelled'].includes(step.status)) return false;
      if (step.nextAttemptAt && step.nextAttemptAt > this.now()) return false;
      return (step.dependsOn || []).every((dependency) => status.get(dependency) === 'done');
    });
  }

  /** Blocked steps: pending with at least one failed/skipped dependency. */
  blockedSteps(id) {
    const task = this.get(id);
    if (!task) return [];
    const status = new Map(task.steps.map((step) => [step.id, step.status]));
    return task.steps.filter((step) => step.status === 'pending' && (step.dependsOn || []).some((dependency) => ['failed', 'skipped'].includes(status.get(dependency))));
  }

  cancelAll(reason = 'global stop') {
    let cancelled = 0;
    for (const task of this.tasks.values()) {
      if (this.cancel(task.id, reason)) cancelled += 1;
    }
    return cancelled;
  }

  stats() {
    const byStatus = {};
    for (const task of this.tasks.values()) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    return { total: this.tasks.size, byStatus, counters: { ...this.counters }, maxTasks: this.maxTasks };
  }
}

module.exports = { TaskManager, STATUSES, STEP_STATUSES, TERMINAL, validateDag, DEFAULT_POLICY };
