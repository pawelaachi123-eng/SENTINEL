'use strict';

/**
 * Task tracking for multi-step work.
 *
 * A task has a goal, a plan of steps, dependencies between them, a status and a
 * result. It exists so that "do these five things" has a durable record the UI
 * and the assistant can both look at — and so a long job can be cancelled or
 * time out instead of looping forever.
 *
 * Every state transition is persisted, which is what makes the Tasks tab
 * truthful across restarts.
 */

const { newId } = require('./memory/store');

const STATUSES = ['pending', 'planning', 'running', 'waiting_approval', 'verifying', 'done', 'failed', 'cancelled', 'timeout'];

class TaskManager {
  constructor({ store, log, now = () => Date.now(), maxTasks = 500 }) {
    this.store = store || null;
    this.log = log;
    this.now = now;
    this.maxTasks = maxTasks;
    this.collection = 'tasks';
    this.tasks = new Map();
    this.timers = new Map();
    this.counters = { created: 0, completed: 0, failed: 0, cancelled: 0, timeouts: 0 };
    this.load();
  }

  load() {
    if (!this.store) return;
    for (const task of this.store.list(this.collection)) this.tasks.set(task.id, task);
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
      .filter((task) => ['done', 'failed', 'cancelled', 'timeout'].includes(task.status))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    while (this.tasks.size > this.maxTasks && finished.length) {
      const task = finished.shift();
      this.tasks.delete(task.id);
      if (this.store) this.store.delete(this.collection, task.id);
    }
  }

  create({ title, goal = '', steps = [], priority = 3, timeoutMs = 10 * 60 * 1000, sessionId = null, runId = null, agent = null } = {}) {
    if (!title && !goal) throw Object.assign(new Error('a task needs a title or a goal'), { code: 'BAD_ARGS' });
    const task = {
      id: newId('task'),
      title: title || String(goal).slice(0, 80),
      goal,
      status: 'pending',
      priority,
      agent,
      sessionId,
      runId,
      steps: (steps || []).map((step, index) => ({
        id: step.id || `s${index + 1}`,
        title: step.title || step.goal || `step ${index + 1}`,
        agent: step.agent || null,
        tool: step.tool || null,
        args: step.args || null,
        dependsOn: step.dependsOn || [],
        status: 'pending',
        result: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })),
      progress: 0,
      result: null,
      error: null,
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
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }));
  }

  start(id) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    task.status = 'running';
    task.startedAt = this.now();
    this.persist(task);
    const timer = setTimeout(() => {
      if (['done', 'failed', 'cancelled', 'timeout'].includes(task.status)) return;
      task.status = 'timeout';
      task.error = `task exceeded ${Math.round(task.timeoutMs / 1000)} s`;
      task.finishedAt = this.now();
      this.counters.timeouts += 1;
      this.persist(task);
      if (this.log) this.log.warn('task', `timeout: ${task.title}`);
    }, task.timeoutMs);
    if (timer.unref) timer.unref();
    this.timers.set(task.id, timer);
    return task;
  }

  stepDone(id, stepId, result) {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.status = 'done';
    step.result = result === undefined ? null : result;
    step.finishedAt = this.now();
    task.progress = Math.round((task.steps.filter((entry) => entry.status === 'done').length / Math.max(1, task.steps.length)) * 100);
    return this.persist(task);
  }

  stepFailed(id, stepId, error) {
    const task = this.get(id);
    if (!task) return null;
    const step = task.steps.find((entry) => entry.id === stepId);
    if (!step) return null;
    step.status = 'failed';
    step.error = String(error || 'failed');
    step.finishedAt = this.now();
    return this.persist(task);
  }

  finish(id, { result = null, status = 'done', error = null } = {}) {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error(`no task ${id}`), { code: 'NOT_FOUND' });
    task.status = STATUSES.includes(status) ? status : 'done';
    task.result = result;
    task.error = error;
    task.finishedAt = this.now();
    task.progress = task.status === 'done' ? 100 : task.progress;
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    if (task.status === 'done') this.counters.completed += 1;
    else if (task.status === 'failed') this.counters.failed += 1;
    this.persist(task);
    if (this.log) this.log.info('task', `${task.status}: ${task.title}`);
    return task;
  }

  cancel(id, reason = 'cancelled by user') {
    const task = this.get(id);
    if (!task) return false;
    if (['done', 'cancelled'].includes(task.status)) return false;
    task.status = 'cancelled';
    task.error = reason;
    task.finishedAt = this.now();
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.counters.cancelled += 1;
    this.persist(task);
    if (this.log) this.log.warn('task', `cancelled: ${task.title}`);
    return true;
  }

  /** Which steps are runnable right now (dependencies satisfied). */
  readySteps(id) {
    const task = this.get(id);
    if (!task) return [];
    const status = new Map(task.steps.map((step) => [step.id, step.status]));
    return task.steps.filter((step) => {
      if (step.status !== 'pending') return false;
      return step.dependsOn.every((dependency) => status.get(dependency) === 'done');
    });
  }

  stats() {
    const byStatus = {};
    for (const task of this.tasks.values()) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    return { total: this.tasks.size, byStatus, counters: { ...this.counters } };
  }
}

module.exports = { TaskManager, STATUSES };
