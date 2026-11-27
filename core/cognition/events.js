'use strict';

/**
 * Typed cognitive event stream and goal arbitration.
 *
 * The blackboard stores state. This module records the *changes* to that state
 * as typed, bounded events so the UI, tools and diagnostics can observe a run
 * without reading a private reasoning transcript. Every event keeps the scope,
 * entry id, entry type and provenance of the change that caused it.
 *
 * The event buffer is intentionally bounded. Dropping old events is visible in
 * `stats().dropped`; it is never silent. Durable state remains the blackboard's
 * job.
 */

const crypto = require('node:crypto');

const EVENT_TYPES = new Set([
  'blackboard.added',
  'blackboard.updated',
  'blackboard.resolved',
  'blackboard.retracted',
  'blackboard.removed',
  'run.started',
  'run.retrieved',
  'run.answered',
  'run.verified',
  'run.corrected',
  'run.cancelled',
  'goal.submitted',
  'goal.activated',
  'goal.completed',
  'goal.failed',
  'goal.cancelled',
]);

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class CognitiveEventBus {
  constructor({ board = null, limit = 2000, perScopeLimit = 400, now = () => Date.now(), log = null } = {}) {
    this.board = board;
    this.limit = Math.max(50, Math.min(20000, Number(limit) || 2000));
    this.perScopeLimit = Math.max(20, Math.min(this.limit, Number(perScopeLimit) || 400));
    this.now = now;
    this.log = log;
    this.events = [];
    this.byScope = new Map();
    this.dropped = 0;
    this.listeners = new Set();
    this.unsubscribeBoard = null;
    if (board && typeof board.subscribe === 'function') {
      this.unsubscribeBoard = board.subscribe((change) => this.fromBoard(change));
    }
  }

  /** Convert a blackboard mutation into a compact typed event. */
  fromBoard(change) {
    if (!change || !change.entry) return null;
    const entry = change.entry;
    const map = {
      added: 'blackboard.added',
      added_many: 'blackboard.added',
      merged: 'blackboard.updated',
      updated: 'blackboard.updated',
      resolved: 'blackboard.resolved',
      retracted: 'blackboard.retracted',
      removed: 'blackboard.removed',
      pruned: 'blackboard.removed',
    };
    const type = map[change.action] || 'blackboard.updated';
    return this.publish({
      type,
      scope: entry.scope,
      entryId: entry.id,
      entryType: entry.type,
      key: entry.key || null,
      actor: change.actor || (entry.owner && entry.owner.agent) || 'system',
      provenance: entry.provenance || [],
      confidence: entry.confidence,
      status: entry.status,
      summary: summarize(entry),
      data: change.loserId || change.removed ? { loserId: change.loserId || null, removed: change.removed || null } : null,
    });
  }

  publish(input = {}) {
    if (!input || typeof input !== 'object') throw Object.assign(new Error('an event must be an object'), { code: 'BAD_EVENT' });
    if (!EVENT_TYPES.has(input.type)) throw Object.assign(new Error(`unknown cognitive event type ${input.type}`), { code: 'BAD_EVENT_TYPE' });
    const event = {
      id: input.id || id('ce'),
      at: Number(input.at) || this.now(),
      type: input.type,
      scope: input.scope || null,
      entryId: input.entryId || null,
      entryType: input.entryType || null,
      key: input.key || null,
      actor: input.actor || 'system',
      provenance: Array.isArray(input.provenance) ? clone(input.provenance) : [],
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
      status: input.status || null,
      summary: input.summary === undefined ? null : clone(input.summary),
      data: input.data === undefined ? null : clone(input.data),
    };
    this.events.push(event);
    if (event.scope) {
      if (!this.byScope.has(event.scope)) this.byScope.set(event.scope, []);
      this.byScope.get(event.scope).push(event);
      this.trim(this.byScope.get(event.scope), this.perScopeLimit);
    }
    this.trim(this.events, this.limit);
    for (const listener of this.listeners) {
      try {
        listener(clone(event));
      } catch (err) {
        if (this.log) this.log.debug('cognition', `event listener threw: ${err.message}`);
      }
    }
    return clone(event);
  }

  trim(list, cap) {
    if (list.length <= cap) return;
    const excess = list.length - cap;
    list.splice(0, excess);
    this.dropped += excess;
  }

  query({ scope = null, type = null, types = null, entryType = null, since = null, limit = 100, newestFirst = false } = {}) {
    const wanted = types ? new Set(types) : type ? new Set([type]) : null;
    let rows = scope ? (this.byScope.get(scope) || []) : this.events;
    if (wanted) rows = rows.filter((event) => wanted.has(event.type));
    if (entryType) rows = rows.filter((event) => event.entryType === entryType);
    if (since !== null) {
      const sinceMs = typeof since === 'number' ? since : Date.parse(since);
      if (Number.isFinite(sinceMs)) rows = rows.filter((event) => event.at > sinceMs);
    }
    const requested = Math.max(1, Math.min(2000, Number(limit) || 100));
    const ordered = newestFirst ? [...rows].reverse() : rows;
    return clone(ordered.slice(-requested));
  }

  latest({ scope = null, limit = 10 } = {}) {
    return this.query({ scope, limit, newestFirst: true });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw Object.assign(new Error('listener must be a function'), { code: 'BAD_LISTENER' });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(scope = null) {
    const rows = scope ? this.byScope.get(scope) || [] : this.events;
    const byType = {};
    for (const event of rows) byType[event.type] = (byType[event.type] || 0) + 1;
    return {
      buffered: rows.length,
      totalBuffered: this.events.length,
      dropped: this.dropped,
      scopes: this.byScope.size,
      byType,
      oldestAt: rows.length ? rows[0].at : null,
      newestAt: rows.length ? rows[rows.length - 1].at : null,
      bounded: true,
    };
  }

  close() {
    if (this.unsubscribeBoard) {
      try {
        this.unsubscribeBoard();
      } catch {
        /* already closed */
      }
      this.unsubscribeBoard = null;
    }
    this.listeners.clear();
  }
}

function summarize(entry) {
  const content = entry.content;
  if (typeof content === 'string') return content.slice(0, 240);
  try {
    return JSON.stringify(content).slice(0, 240);
  } catch {
    return null;
  }
}

/* ── goal arbitration ───────────────────────────────────────────────────── */

const GOAL_STATUS = new Set(['pending', 'active', 'blocked', 'done', 'failed', 'cancelled']);

/**
 * Deterministic competing-goal arbitration.
 *
 * Score = priority + urgency from the deadline + age (starvation) − dependency
 * penalty. The weights are fixed and returned with the ranking so the decision
 * can be inspected. A blocked goal is never activated.
 */
class GoalArbiter {
  constructor({ now = () => Date.now(), log = null, bus = null } = {}) {
    this.now = now;
    this.log = log;
    this.bus = bus;
    this.goals = new Map();
  }

  submit({ id: goalId = null, description, scope = 'global', priority = 0.5, deadline = null, estimatedMs = null, dependencies = [], tags = [] } = {}) {
    if (typeof description !== 'string' || !description.trim()) throw Object.assign(new Error('a goal needs a description'), { code: 'BAD_GOAL' });
    const goalIdFinal = goalId || id('goal');
    if (this.goals.has(goalIdFinal)) throw Object.assign(new Error(`goal ${goalIdFinal} already exists`), { code: 'DUPLICATE_GOAL' });
    const numericPriority = Number(priority);
    if (!Number.isFinite(numericPriority) || numericPriority < 0 || numericPriority > 1) throw Object.assign(new Error('priority must be within 0..1'), { code: 'BAD_PRIORITY' });
    const created = this.now();
    const goal = {
      id: goalIdFinal,
      description: description.trim(),
      scope,
      priority: numericPriority,
      deadline: deadline === null ? null : Number(deadline),
      estimatedMs: estimatedMs === null ? null : Math.max(0, Number(estimatedMs)),
      dependencies: [...new Set((dependencies || []).map(String))],
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 20) : [],
      status: 'pending',
      createdAt: created,
      updatedAt: created,
    };
    if (goal.deadline !== null && !Number.isFinite(goal.deadline)) throw Object.assign(new Error('deadline must be a timestamp'), { code: 'BAD_DEADLINE' });
    this.goals.set(goal.id, goal);
    this.emit('goal.submitted', goal);
    return clone(goal);
  }

  emit(type, goal, extra = {}) {
    if (this.bus) {
      try {
        this.bus.publish({ type, scope: goal.scope, actor: 'goal-arbiter', summary: goal.description, data: { goalId: goal.id, status: goal.status, ...extra } });
      } catch (err) {
        if (this.log) this.log.debug('cognition', `goal event failed: ${err.message}`);
      }
    }
  }

  get(goalId) {
    return this.goals.get(goalId) || null;
  }

  list({ scope = null, status = null } = {}) {
    return [...this.goals.values()]
      .filter((goal) => (!scope || goal.scope === scope) && (!status || goal.status === status))
      .map(clone);
  }

  update(goalId, patch = {}) {
    const goal = this.goals.get(goalId);
    if (!goal) throw Object.assign(new Error(`unknown goal ${goalId}`), { code: 'NO_GOAL' });
    if (patch.priority !== undefined) {
      const priority = Number(patch.priority);
      if (!Number.isFinite(priority) || priority < 0 || priority > 1) throw Object.assign(new Error('priority must be within 0..1'), { code: 'BAD_PRIORITY' });
      goal.priority = priority;
    }
    if (patch.deadline !== undefined) goal.deadline = patch.deadline === null ? null : Number(patch.deadline);
    if (patch.estimatedMs !== undefined) goal.estimatedMs = patch.estimatedMs === null ? null : Math.max(0, Number(patch.estimatedMs));
    if (patch.dependencies !== undefined) goal.dependencies = [...new Set((patch.dependencies || []).map(String))];
    if (patch.status !== undefined) {
      if (!GOAL_STATUS.has(patch.status)) throw Object.assign(new Error(`unknown goal status ${patch.status}`), { code: 'BAD_STATUS' });
      goal.status = patch.status;
      this.emit(patch.status === 'done' ? 'goal.completed' : patch.status === 'failed' ? 'goal.failed' : patch.status === 'cancelled' ? 'goal.cancelled' : 'goal.activated', goal);
    }
    goal.updatedAt = this.now();
    return clone(goal);
  }

  complete(goalId) {
    return this.update(goalId, { status: 'done' });
  }

  fail(goalId, reason = null) {
    const goal = this.goals.get(goalId);
    if (!goal) throw Object.assign(new Error(`unknown goal ${goalId}`), { code: 'NO_GOAL' });
    goal.error = reason ? String(reason).slice(0, 500) : null;
    return this.update(goalId, { status: 'failed' });
  }

  ready(goalId, provided = new Set()) {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    return goal.dependencies.every((dependency) => {
      if (provided.has(dependency)) return true;
      const parent = this.goals.get(dependency);
      return Boolean(parent && parent.status === 'done');
    });
  }

  score(goal, now = this.now()) {
    const ageMs = Math.max(0, now - goal.createdAt);
    const starvation = Math.min(0.25, ageMs / (12 * 60 * 60 * 1000) * 0.25);
    let deadlinePressure = 0;
    if (goal.deadline !== null) {
      const remaining = goal.deadline - now;
      const horizon = Math.max(60000, goal.estimatedMs || 3600000);
      deadlinePressure = remaining <= 0 ? 0.5 : Math.max(0, 0.5 * (1 - remaining / horizon));
    }
    return Number((goal.priority + starvation + deadlinePressure).toFixed(6));
  }

  /** Rank ready pending goals; blocked or unfinished goals are listed separately. */
  arbitrate({ scope = null, status = 'pending', now = this.now(), limit = 10 } = {}) {
    const candidates = [...this.goals.values()].filter((goal) => (!scope || goal.scope === scope) && (!status || goal.status === status));
    const ready = [];
    const blocked = [];
    for (const goal of candidates) {
      const unmet = goal.dependencies.filter((dependency) => {
        const parent = this.goals.get(dependency);
        return !(parent && parent.status === 'done');
      });
      if (unmet.length) blocked.push({ id: goal.id, description: goal.description, unmet });
      else ready.push({ id: goal.id, description: goal.description, priority: goal.priority, score: this.score(goal, now), deadline: goal.deadline, createdAt: goal.createdAt });
    }
    ready.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      ranking: ready.slice(0, Math.max(1, Number(limit) || 10)),
      blocked,
      next: ready.length ? ready[0].id : null,
      weights: { priority: 1, starvationMax: 0.25, deadlineMax: 0.5 },
      at: now,
    };
  }

  /** Dependency-aware activation order over pending goals. */
  activationOrder({ scope = null, now = this.now() } = {}) {
    const pending = [...this.goals.values()].filter((goal) => (!scope || goal.scope === scope) && goal.status === 'pending');
    const byId = new Map(pending.map((goal) => [goal.id, goal]));
    const done = new Set([...this.goals.values()].filter((goal) => goal.status === 'done').map((goal) => goal.id));
    const activated = [];
    const blocked = [];
    const remaining = new Set(byId.keys());
    let progress = true;
    while (progress) {
      progress = false;
      const batch = [];
      for (const goalId of [...remaining]) {
        const goal = byId.get(goalId);
        if (goal.dependencies.every((dependency) => done.has(dependency))) batch.push(goal);
      }
      if (!batch.length) break;
      batch.sort((a, b) => this.score(b, now) - this.score(a, now) || a.createdAt - b.createdAt);
      for (const goal of batch) {
        activated.push({ id: goal.id, description: goal.description, score: this.score(goal, now) });
        remaining.delete(goal.id);
        done.add(goal.id);
        progress = true;
      }
    }
    for (const goalId of remaining) {
      const goal = byId.get(goalId);
      blocked.push({ id: goal.id, unmet: goal.dependencies.filter((dependency) => !done.has(dependency)) });
    }
    return { order: activated, blocked, complete: remaining.size === 0, at: now };
  }

  snapshot() {
    return [...this.goals.values()].map(clone);
  }

  restore(rows) {
    if (!Array.isArray(rows)) throw Object.assign(new Error('restore expects an array'), { code: 'BAD_SNAPSHOT' });
    this.goals.clear();
    for (const row of rows) {
      if (!row || !row.id || !row.description) continue;
      this.goals.set(row.id, { ...clone(row), status: GOAL_STATUS.has(row.status) ? row.status : 'pending' });
    }
    return this.goals.size;
  }
}

module.exports = { CognitiveEventBus, GoalArbiter, EVENT_TYPES };
