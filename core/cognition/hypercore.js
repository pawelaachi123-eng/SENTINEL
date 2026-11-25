'use strict';

/**
 * Typed cognitive hypercore.
 *
 * It is a deterministic bookkeeping and arbitration layer around the existing
 * reasoning stack — not a claim of consciousness, emotion or biological
 * neurons. Every object has a type, an identity, provenance and a version:
 *
 *   goal        wanted state, priority, deadline, acceptance criteria
 *   belief      a statement with confidence, source and evidence links
 *   evidence    an observation from a tool/file/model, marked trusted/untrusted
 *   hypothesis  a candidate explanation with a prior and a posterior
 *   constraint  hard or soft limit on an answer or plan
 *   conflict    two incompatible beliefs, kept side by side
 *   rule        a Horn-style implication used only for explicit deduction
 *
 * Attention is a measured ranking of the above, not a hidden thought. Budgets
 * cap attention items, context tokens, tool calls and reasoning depth. State is
 * persisted transactionally; a failed save leaves the previous version intact.
 */

const crypto = require('node:crypto');

const TYPES = ['goal', 'belief', 'evidence', 'hypothesis', 'constraint'];
const GOAL_STATUS = ['pending', 'active', 'blocked', 'done', 'failed', 'cancelled'];
const HYPOTHESIS_STATUS = ['proposed', 'supported', 'refuted', 'undecided'];

function nowIso(now) {
  return new Date(now()).toISOString();
}

function stable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function text(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${name} must be a non-empty string`), { code: 'BAD_COGNITIVE_OBJECT' });
  return value.trim().slice(0, max);
}

const DEFAULT_BUDGETS = Object.freeze({
  attentionItems: 8,
  contextTokens: 2048,
  toolCalls: 12,
  reasoningDepth: 3,
  hypotheses: 12,
});

class CognitiveConflictError extends Error {
  constructor(message, conflict) {
    super(message);
    this.name = 'CognitiveConflictError';
    this.code = 'COGNITIVE_CONFLICT';
    this.conflict = conflict;
  }
}

class HyperCore {
  constructor({ store = null, log = null, now = () => Date.now(), budgets = {} } = {}) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    this.defaultBudgets = { ...this.budgets };
    this.usage = { tokens: 0, toolCalls: 0, depth: 0 };
    this.goals = new Map();
    this.beliefs = new Map();
    this.evidence = new Map();
    this.hypotheses = new Map();
    this.constraints = new Map();
    this.conflicts = new Map();
    this.rules = new Map();
    this.attentionTrace = [];
    this.counter = 0;
    this.version = 1;
    this.load();
  }

  id(prefix) {
    this.counter += 1;
    return `${prefix}_${this.now().toString(36)}_${this.counter.toString(36)}`;
  }

  touch() {
    this.version += 1;
  }

  /* ── goals ───────────────────────────────────────────────────────────── */

  addGoal({ description, priority = 0.5, deadline = null, parentId = null, acceptance = [], constraints = [], owner = 'user', status = 'pending' } = {}) {
    const goal = {
      type: 'goal',
      id: this.id('goal'),
      description: text(description, 'description'),
      priority: clamp(priority),
      deadline: deadline ? new Date(deadline).toISOString() : null,
      parentId: parentId || null,
      acceptance: Array.isArray(acceptance) ? acceptance.slice(0, 12).map((entry) => String(entry).slice(0, 500)) : [],
      constraints: Array.isArray(constraints) ? constraints.slice(0, 12).map(String) : [],
      owner: String(owner || 'user').slice(0, 100),
      status: GOAL_STATUS.includes(status) ? status : 'pending',
      createdAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
      attempts: 0,
      evidenceIds: [],
    };
    if (goal.deadline && Number.isNaN(Date.parse(goal.deadline))) throw Object.assign(new Error('deadline is not a date'), { code: 'BAD_COGNITIVE_OBJECT' });
    this.goals.set(goal.id, goal);
    this.touch();
    this.persist();
    return { ...goal };
  }

  updateGoal(id, patch = {}) {
    const goal = this.goals.get(id);
    if (!goal) return { ok: false, code: 'NOT_FOUND', message: `no goal ${id}` };
    if (patch.status && !GOAL_STATUS.includes(patch.status)) return { ok: false, code: 'BAD_STATUS', message: `unknown goal status ${patch.status}` };
    const next = { ...goal, updatedAt: nowIso(this.now) };
    if (patch.status) next.status = patch.status;
    if (patch.priority !== undefined) next.priority = clamp(patch.priority);
    if (patch.deadline !== undefined) {
      if (patch.deadline !== null && Number.isNaN(Date.parse(patch.deadline))) return { ok: false, code: 'BAD_DEADLINE', message: 'deadline is not a date' };
      next.deadline = patch.deadline ? new Date(patch.deadline).toISOString() : null;
    }
    if (patch.acceptance) next.acceptance = patch.acceptance.slice(0, 12).map(String);
    if (patch.note) next.note = String(patch.note).slice(0, 1000);
    if (patch.attempts !== undefined) next.attempts = Math.max(0, Number(patch.attempts) || 0);
    this.goals.set(id, next);
    this.touch();
    this.persist();
    return { ...next };
  }

  /* ── evidence, beliefs, conflicts ───────────────────────────────────── */

  addEvidence({ kind = 'observation', source = 'unknown', content = '', trust = 0.5, untrusted = true, tool = null, citation = null } = {}) {
    const body = text(content, 'content', 8000);
    const evidence = {
      type: 'evidence',
      id: this.id('ev'),
      kind: String(kind).slice(0, 40),
      source: String(source || 'unknown').slice(0, 300),
      content: body,
      trust: clamp(trust),
      untrusted: untrusted !== false,
      tool: tool ? String(tool).slice(0, 100) : null,
      citation: citation ? String(citation).slice(0, 300) : null,
      hash: stable({ kind, source, content: body }),
      observedAt: nowIso(this.now),
    };
    this.evidence.set(evidence.id, evidence);
    this.touch();
    this.persist();
    return { ...evidence };
  }

  /**
   * Adds a belief. If `key` already has a different value, the new belief is
   * stored alongside the old one and a conflict is recorded — nothing is
   * silently overwritten.
   */
  addBelief({ statement, key = null, value = null, confidence = 0.5, source = 'unknown', derived = false, evidenceIds = [], validUntil = null } = {}) {
    const belief = {
      type: 'belief',
      id: this.id('belief'),
      statement: text(statement, 'statement'),
      key: key ? String(key).slice(0, 120) : null,
      value: value === undefined ? null : value,
      confidence: clamp(confidence),
      source: String(source || 'unknown').slice(0, 300),
      derived: Boolean(derived),
      evidenceIds: Array.isArray(evidenceIds) ? evidenceIds.filter((id) => this.evidence.has(id)).slice(0, 20) : [],
      status: 'active',
      validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      createdAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
    };
    const conflicts = [];
    if (belief.key !== null) {
      for (const existing of this.beliefs.values()) {
        if (existing.status !== 'active' || existing.key !== belief.key) continue;
        if (JSON.stringify(existing.value) === JSON.stringify(belief.value)) continue;
        const conflict = {
          type: 'conflict',
          id: this.id('conflict'),
          key: belief.key,
          left: { beliefId: existing.id, value: existing.value, confidence: existing.confidence, source: existing.source },
          right: { beliefId: belief.id, value: belief.value, confidence: belief.confidence, source: belief.source },
          resolution: null,
          status: 'open',
          detectedAt: nowIso(this.now),
        };
        this.conflicts.set(conflict.id, conflict);
        existing.status = 'contested';
        belief.status = 'contested';
        conflicts.push(conflict);
      }
    }
    this.beliefs.set(belief.id, belief);
    this.touch();
    this.persist();
    return { belief: { ...belief }, conflicts: conflicts.map((conflict) => ({ ...conflict })) };
  }

  resolveConflict(id, { resolution = null, beliefId = null, approvedBy = null, note = null } = {}) {
    const conflict = this.conflicts.get(id);
    if (!conflict) return { ok: false, code: 'NOT_FOUND', message: `no conflict ${id}` };
    if (conflict.status !== 'open') return { ok: false, code: 'ALREADY_RESOLVED', message: 'conflict has already been resolved' };
    const allowed = ['accepted-left', 'accepted-right', 'kept-both', 'dismissed'];
    if (!allowed.includes(resolution)) return { ok: false, code: 'BAD_RESOLUTION', message: `resolution must be one of ${allowed.join(', ')}` };
    if (resolution !== 'kept-both' && !approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'resolving a contradiction needs an approving identity' };
    if (resolution === 'accepted-left' || resolution === 'accepted-right') {
      const winner = resolution === 'accepted-left' ? conflict.left.beliefId : conflict.right.beliefId;
      if (beliefId && beliefId !== winner) return { ok: false, code: 'MISMATCH', message: 'beliefId does not match the chosen side' };
      const loser = resolution === 'accepted-left' ? conflict.right.beliefId : conflict.left.beliefId;
      const winnerBelief = this.beliefs.get(winner);
      const loserBelief = this.beliefs.get(loser);
      if (winnerBelief) winnerBelief.status = 'active';
      if (loserBelief) {
        loserBelief.status = 'superseded';
        loserBelief.supersededBy = winner;
        loserBelief.supersededAt = nowIso(this.now);
      }
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedBy = approvedBy || 'system-keep-both';
    conflict.resolvedAt = nowIso(this.now);
    conflict.note = note ? String(note).slice(0, 1000) : null;
    this.touch();
    this.persist();
    return { ok: true, conflict: { ...conflict } };
  }

  /* ── hypotheses and constraints ────────────────────────────────────── */

  addHypothesis({ statement, prior = 0.5, predicts = [], explainGoal = null } = {}) {
    if (this.hypotheses.size >= this.budgets.hypotheses) return { ok: false, code: 'BUDGET_EXCEEDED', message: `hypothesis budget ${this.budgets.hypotheses} reached` };
    const hypothesis = {
      type: 'hypothesis',
      id: this.id('hyp'),
      statement: text(statement, 'statement'),
      prior: clamp(prior),
      posterior: clamp(prior),
      predicts: Array.isArray(predicts) ? predicts.slice(0, 10).map(String) : [],
      explainGoal: explainGoal ? String(explainGoal) : null,
      supports: 0,
      contradicts: 0,
      status: 'proposed',
      updatedAt: nowIso(this.now),
    };
    this.hypotheses.set(hypothesis.id, hypothesis);
    this.touch();
    this.persist();
    return { ...hypothesis };
  }

  /**
   * Bayesian update with explicit, fixed likelihoods (not learned):
   * support LR=3, contradiction LR=1/3, neutral LR=1. Priors and posteriors are
   * reported; the caller is never told a hypothesis is proven.
   */
  updateHypothesis(id, { supports = 0, contradicts = 0, note = null } = {}) {
    const hypothesis = this.hypotheses.get(id);
    if (!hypothesis) return { ok: false, code: 'NOT_FOUND', message: `no hypothesis ${id}` };
    const supportCount = Math.max(0, Math.floor(Number(supports) || 0));
    const contradictCount = Math.max(0, Math.floor(Number(contradicts) || 0));
    let odds = hypothesis.posterior / (1 - hypothesis.posterior);
    odds *= 3 ** supportCount;
    odds *= (1 / 3) ** contradictCount;
    const posterior = odds / (1 + odds);
    const next = {
      ...hypothesis,
      supports: hypothesis.supports + supportCount,
      contradicts: hypothesis.contradicts + contradictCount,
      posterior: Number(clamp(posterior).toFixed(4)),
      status: posterior >= 0.75 ? 'supported' : posterior <= 0.25 ? 'refuted' : 'undecided',
      updatedAt: nowIso(this.now),
      note: note ? String(note).slice(0, 500) : hypothesis.note || null,
    };
    this.hypotheses.set(id, next);
    this.touch();
    this.persist();
    return { ...next };
  }

  addConstraint({ statement, kind = 'soft', scope = 'answer', enforceable = false } = {}) {
    if (!['hard', 'soft'].includes(kind)) return { ok: false, code: 'BAD_CONSTRAINT', message: 'kind must be hard or soft' };
    const constraint = {
      type: 'constraint',
      id: this.id('constraint'),
      statement: text(statement, 'statement'),
      kind,
      scope: String(scope).slice(0, 60),
      enforceable: Boolean(enforceable),
      createdAt: nowIso(this.now),
      status: 'active',
    };
    this.constraints.set(constraint.id, constraint);
    this.touch();
    this.persist();
    return { ...constraint };
  }

  /* ── rules, deduction, abduction ───────────────────────────────────── */

  addRule({ when, then, confidence = 0.8, description = null } = {}) {
    if (!Array.isArray(when) || !when.length || !then || !then.key) return { ok: false, code: 'BAD_RULE', message: 'rule needs when[{key,value}] and then{key,value}' };
    const rule = {
      id: this.id('rule'),
      when: when.slice(0, 8).map((atom) => ({ key: String(atom.key), value: atom.value })),
      then: { key: String(then.key), value: then.value },
      confidence: clamp(confidence),
      description: description ? String(description).slice(0, 300) : null,
      createdAt: nowIso(this.now),
    };
    this.rules.set(rule.id, rule);
    this.touch();
    return { ...rule };
  }

  facts() {
    return [...this.beliefs.values()].filter((belief) => belief.status === 'active' || belief.status === 'contested');
  }

  /**
   * Bounded forward chaining. Derived beliefs carry `derived:true`, the rule id
   * and the minimum confidence of the premises. A contradiction is recorded,
   * never resolved automatically.
   */
  deduce({ maxIterations = 8 } = {}) {
    const iterations = Math.max(1, Math.min(8, Number(maxIterations) || 8));
    const derived = [];
    const conflicts = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let changed = false;
      for (const rule of this.rules.values()) {
        const premises = rule.when.map((atom) => this.facts().find((belief) => belief.key === atom.key && JSON.stringify(belief.value) === JSON.stringify(atom.value)));
        if (premises.some((premise) => !premise)) continue;
        const existing = this.facts().find((belief) => belief.key === rule.then.key && JSON.stringify(belief.value) === JSON.stringify(rule.then.value));
        if (existing) continue;
        const confidence = Math.min(rule.confidence, ...premises.map((premise) => premise.confidence));
        const result = this.addBelief({
          statement: `${rule.then.key} = ${JSON.stringify(rule.then.value)} (derived by ${rule.id})`,
          key: rule.then.key,
          value: rule.then.value,
          confidence,
          source: `rule:${rule.id}`,
          derived: true,
          evidenceIds: premises.flatMap((premise) => premise.evidenceIds),
        });
        derived.push(result.belief);
        conflicts.push(...result.conflicts);
        changed = true;
      }
      if (!changed) break;
    }
    return { derived, conflicts, facts: this.facts().length };
  }

  /**
   * Abduction proposes explanations only when a rule's conclusion is observed;
   * it does not assert the premises as facts.
   */
  abduce({ maxHypotheses = 3 } = {}) {
    const limit = Math.max(1, Math.min(this.budgets.hypotheses - this.hypotheses.size, Number(maxHypotheses) || 3));
    const proposals = [];
    for (const rule of this.rules.values()) {
      if (proposals.length >= limit) break;
      const observed = this.facts().find((belief) => belief.key === rule.then.key && JSON.stringify(belief.value) === JSON.stringify(rule.then.value));
      if (!observed) continue;
      const statement = `possibly ${rule.when.map((atom) => `${atom.key}=${JSON.stringify(atom.value)}`).join(' and ')}`;
      if ([...this.hypotheses.values()].some((hypothesis) => hypothesis.statement === statement)) continue;
      proposals.push(this.addHypothesis({ statement, prior: Math.min(0.4, observed.confidence * 0.5), predicts: rule.when.map((atom) => `${atom.key}=${JSON.stringify(atom.value)}`), explainGoal: observed.id }));
    }
    return { hypotheses: proposals, note: 'abduction proposes; it does not prove the premises' };
  }

  /* ── attention and budgets ─────────────────────────────────────────── */

  urgency(deadline) {
    if (!deadline) return 0;
    const remaining = Date.parse(deadline) - this.now();
    if (Number.isNaN(remaining)) return 0;
    if (remaining <= 0) return 1;
    const hours = remaining / 3600000;
    return clamp(1 - hours / 168); // a week to deadline → 0, now → 1
  }

  candidates() {
    const list = [];
    for (const goal of this.goals.values()) {
      if (['done', 'failed', 'cancelled'].includes(goal.status)) continue;
      const urgency = this.urgency(goal.deadline);
      const score = 0.55 * goal.priority + 0.3 * urgency + (goal.status === 'active' ? 0.15 : 0) - (goal.status === 'blocked' ? 0.25 : 0);
      list.push({ kind: 'goal', id: goal.id, label: goal.description, score: Number(clamp(score, 0, 2).toFixed(4)), uncertainty: 1 - goal.priority, provenance: { owner: goal.owner, deadline: goal.deadline, status: goal.status } });
    }
    for (const belief of this.facts()) {
      const score = 0.35 * (1 - belief.confidence) + (belief.status === 'contested' ? 0.35 : 0);
      list.push({ kind: 'belief', id: belief.id, label: belief.statement, score: Number(clamp(score, 0, 2).toFixed(4)), uncertainty: Number((1 - belief.confidence).toFixed(4)), provenance: { source: belief.source, derived: belief.derived, status: belief.status } });
    }
    for (const conflict of this.conflicts.values()) {
      if (conflict.status !== 'open') continue;
      list.push({ kind: 'conflict', id: conflict.id, label: `contradiction about ${conflict.key}`, score: 1, uncertainty: 1, provenance: { status: conflict.status } });
    }
    for (const constraint of this.constraints.values()) {
      if (constraint.status !== 'active' || constraint.kind !== 'hard') continue;
      list.push({ kind: 'constraint', id: constraint.id, label: constraint.statement, score: 1, uncertainty: 0, provenance: { kind: constraint.kind, scope: constraint.scope } });
    }
    return list;
  }

  /** Deterministic softmax over candidate scores; no hidden attention weights. */
  attention({ limit = this.budgets.attentionItems } = {}) {
    const candidates = this.candidates();
    if (!candidates.length) return [];
    const max = Math.max(...candidates.map((candidate) => candidate.score));
    const exponentials = candidates.map((candidate) => Math.exp((candidate.score - max) * 2));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const withWeights = candidates.map((candidate, index) => ({ ...candidate, weight: Number((exponentials[index] / total).toFixed(4)) }));
    withWeights.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    return withWeights.slice(0, Math.max(1, Math.min(50, Number(limit) || this.budgets.attentionItems)));
  }

  /**
   * Selects what fits the context budget. Hard constraints are never dropped.
   * Token cost is a deterministic estimate (characters / 4), labelled as such.
   */
  focus({ limit = this.budgets.attentionItems, tokenBudget = this.budgets.contextTokens, reason = 'turn' } = {}) {
    const ranked = this.attention({ limit });
    const selected = [];
    let tokens = 0;
    for (const item of ranked) {
      const estimate = Math.ceil(String(item.label).length / 4) + 8;
      if (item.kind !== 'constraint' && tokens + estimate > tokenBudget) continue;
      selected.push({ ...item, estimatedTokens: estimate });
      tokens += estimate;
    }
    const trace = { id: this.id('focus'), at: nowIso(this.now), reason: String(reason).slice(0, 100), selected: selected.map((item) => ({ kind: item.kind, id: item.id, weight: item.weight })), estimatedTokens: tokens, dropped: ranked.length - selected.length, tokenEstimateMethod: 'characters/4+8 per item (estimate, not tokenizer output)' };
    this.attentionTrace.push(trace);
    if (this.attentionTrace.length > 100) this.attentionTrace.shift();
    return { items: selected, trace };
  }

  beginTask({ budgets = {} } = {}) {
    this.usage = { tokens: 0, toolCalls: 0, depth: 0 };
    this.activeBudgets = { ...this.budgets, ...budgets };
    return { ...this.activeBudgets };
  }

  spend({ tokens = 0, toolCalls = 0, depth = 0 } = {}) {
    const budgets = this.activeBudgets || this.budgets;
    const requested = { tokens: Math.max(0, Number(tokens) || 0), toolCalls: Math.max(0, Number(toolCalls) || 0), depth: Math.max(0, Number(depth) || 0) };
    const next = { tokens: this.usage.tokens + requested.tokens, toolCalls: this.usage.toolCalls + requested.toolCalls, depth: this.usage.depth + requested.depth };
    if (next.tokens > budgets.contextTokens || next.toolCalls > budgets.toolCalls || next.depth > budgets.reasoningDepth) {
      return { ok: false, code: 'BUDGET_EXCEEDED', message: 'cognitive budget exhausted', requested, usage: next, budgets };
    }
    this.usage = next;
    return { ok: true, usage: next, budgets };
  }

  /* ── status, persistence, inspection ───────────────────────────────── */

  status() {
    const goals = [...this.goals.values()];
    const beliefs = [...this.beliefs.values()];
    return {
      version: this.version,
      counts: {
        goals: goals.length,
        activeGoals: goals.filter((goal) => goal.status === 'active').length,
        beliefs: beliefs.length,
        contestedBeliefs: beliefs.filter((belief) => belief.status === 'contested').length,
        evidence: this.evidence.size,
        hypotheses: this.hypotheses.size,
        constraints: this.constraints.size,
        rules: this.rules.size,
        openConflicts: [...this.conflicts.values()].filter((conflict) => conflict.status === 'open').length,
        attentionTraces: this.attentionTrace.length,
      },
      budgets: this.activeBudgets || this.budgets,
      usage: this.usage,
      nextAttention: this.attention({ limit: 3 }).map((item) => ({ kind: item.kind, label: item.label, weight: item.weight })),
      honest: 'typed state and deterministic arbitration; no consciousness, emotion or biological-neuron claims',
    };
  }

  insecureSnapshot() {
    return {
      version: this.version,
      counter: this.counter,
      goals: [...this.goals.values()],
      beliefs: [...this.beliefs.values()],
      evidence: [...this.evidence.values()],
      hypotheses: [...this.hypotheses.values()],
      constraints: [...this.constraints.values()],
      conflicts: [...this.conflicts.values()],
      rules: [...this.rules.values()],
      attentionTrace: this.attentionTrace.slice(-20),
      budgets: this.budgets,
    };
  }

  save() {
    if (!this.store) return { ok: false, code: 'NO_STORE', message: 'no store attached; state is in memory' };
    const snapshot = this.insecureSnapshot();
    this.store.put('hypercore_state', 'current', snapshot);
    return { ok: true, version: snapshot.version, counts: this.status().counts };
  }

  load() {
    if (!this.store) return false;
    const snapshot = this.store.get('hypercore_state', 'current');
    if (!snapshot) return false;
    try {
      this.goals = new Map((snapshot.goals || []).map((item) => [item.id, item]));
      this.beliefs = new Map((snapshot.beliefs || []).map((item) => [item.id, item]));
      this.evidence = new Map((snapshot.evidence || []).map((item) => [item.id, item]));
      this.hypotheses = new Map((snapshot.hypotheses || []).map((item) => [item.id, item]));
      this.constraints = new Map((snapshot.constraints || []).map((item) => [item.id, item]));
      this.conflicts = new Map((snapshot.conflicts || []).map((item) => [item.id, item]));
      this.rules = new Map((snapshot.rules || []).map((item) => [item.id, item]));
      this.attentionTrace = Array.isArray(snapshot.attentionTrace) ? snapshot.attentionTrace.slice(-100) : [];
      this.version = Number(snapshot.version) || 1;
      this.counter = Number(snapshot.counter) || 0;
      if (snapshot.budgets) this.budgets = { ...DEFAULT_BUDGETS, ...snapshot.budgets };
      return true;
    } catch (err) {
      if (this.log) this.log.warn('hypercore', `could not load state: ${err.message}`);
      return false;
    }
  }

  persist() {
    if (!this.store) return;
    try {
      this.store.put('hypercore_state', 'current', this.insecureSnapshot());
    } catch (err) {
      if (this.log) this.log.warn('hypercore', `state save failed: ${err.message}`);
    }
  }

  inspect(type, id) {
    const allowed = { goal: this.goals, belief: this.beliefs, evidence: this.evidence, hypothesis: this.hypotheses, constraint: this.constraints, conflict: this.conflicts, rule: this.rules };
    const map = allowed[type];
    if (!map) return { ok: false, code: 'BAD_TYPE', message: `unknown cognitive type ${type}` };
    if (!id) return { ok: true, items: [...map.values()] };
    const item = map.get(id);
    return item ? { ok: true, item } : { ok: false, code: 'NOT_FOUND', message: `no ${type} ${id}` };
  }
}

module.exports = { HyperCore, CognitiveConflictError, DEFAULT_BUDGETS, TYPES, GOAL_STATUS, HYPOTHESIS_STATUS };
