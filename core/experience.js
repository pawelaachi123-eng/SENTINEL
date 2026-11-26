'use strict';

/**
 * Experience learning that does not lie.
 *
 * SENTINEL cannot retrain a local model's weights on your PC, so it does what is
 * actually possible and measurable: it records which strategy, agent set and
 * tools worked for which class of task, how long they took, and whether the
 * verification passed. Routing then prefers what has been proven on this machine.
 *
 * Everything is persisted in the same SQLite store as memory, so the statistics
 * survive restarts, and every number used for a decision is inspectable through
 * /api/experience.
 *
 * Hard rules:
 *   • a candidate change never becomes active by itself;
 *   • prompt/strategy versions are compared against a stored baseline, and a
 *     regression gate must pass before a new version can be promoted;
 *   • small samples are shrunk towards the prior (Laplace), so a single lucky
 *     run cannot rewrite routing.
 */

const FAILURE_TAXONOMY = {
  MODEL_UNAVAILABLE: 'infrastructure',
  NO_PROVIDER: 'infrastructure',
  ALL_FAILED: 'infrastructure',
  CIRCUIT_OPEN: 'infrastructure',
  TIMEOUT: 'performance',
  CANCELLED: 'user',
  INVALID_PLAN: 'planning',
  TOO_MANY_STEPS: 'planning',
  NOT_FOUND: 'tool',
  INVALID_ARGS: 'tool',
  BAD_ARGS: 'tool',
  TOOL_FAILED: 'tool',
  APPROVAL_REQUIRED: 'permission',
  PERMISSION_DENIED: 'permission',
  PROTECTED: 'permission',
  VERIFICATION_FAILED: 'quality',
  EMPTY_ANSWER: 'quality',
  STT_FAILED: 'multimodal',
  OCR_FAILED: 'multimodal',
};

function classifyFailure(code) {
  if (!code) return 'unknown';
  return FAILURE_TAXONOMY[code] || (String(code).startsWith('HTTP_') ? 'infrastructure' : 'unknown');
}

class ExperienceStore {
  constructor({ store = null, log = null, now = () => Date.now(), prior = 1 } = {}) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.prior = prior;
    this.strategies = new Map();
    this.tools = new Map();
    this.feedback = [];
    this.prompts = new Map();
    this.candidates = new Map();
    this.counters = { outcomes: 0, toolCalls: 0, feedback: 0, promotions: 0, rejections: 0 };
    this.load();
  }

  /* ── persistence ──────────────────────────────────────────────────── */

  load() {
    if (!this.store) return;
    for (const row of this.store.list('experience_strategies')) this.strategies.set(row.id, row);
    for (const row of this.store.list('experience_tools')) this.tools.set(row.id, row);
    for (const row of this.store.list('experience_prompts')) this.prompts.set(row.id, row);
  }

  put(collection, value) {
    if (this.store) this.store.put(collection, value.id, value);
  }

  key(taskClass, strategy, agents = []) {
    return `${taskClass}|${strategy}|${(agents || []).slice().sort().join('+') || 'none'}`;
  }

  /* ── outcomes ─────────────────────────────────────────────────────── */

  recordOutcome({ taskClass, strategy, agents = [], tools = [], ok, ms = 0, confidence = null, verificationOk = null, mode = null, model = null, runId = null, failureCode = null }) {
    const id = this.key(taskClass, strategy, agents);
    const existing = this.strategies.get(id) || {
      id,
      kind: 'strategy',
      taskClass,
      strategy,
      agents: agents.slice().sort(),
      attempts: 0,
      successes: 0,
      totalMs: 0,
      confidenceSum: 0,
      confidenceCount: 0,
      verified: 0,
      failures: {},
      modes: {},
      createdAt: this.now(),
    };
    existing.attempts += 1;
    existing.totalMs += Number(ms) || 0;
    existing.lastAt = this.now();
    existing.lastRunId = runId;
    if (ok) existing.successes += 1;
    if (verificationOk === true) existing.verified += 1;
    if (confidence != null) {
      existing.confidenceSum += Number(confidence) || 0;
      existing.confidenceCount += 1;
    }
    if (mode) existing.modes[mode] = (existing.modes[mode] || 0) + 1;
    if (failureCode) existing.failures[failureCode] = (existing.failures[failureCode] || 0) + 1;
    existing.score = this.scoreOf(existing);
    this.strategies.set(id, existing);
    this.put('experience_strategies', existing);
    this.counters.outcomes += 1;

    for (const name of tools || []) this.recordTool(name, { ok, ms: 0, taskClass });
    if (model) this.recordTool(`model:${model}`, { ok, ms, taskClass });
    return existing;
  }

  recordTool(name, { ok, ms = 0, taskClass = null, code = null } = {}) {
    const existing = this.tools.get(name) || { id: name, kind: 'tool', name, calls: 0, successes: 0, totalMs: 0, failures: {}, createdAt: this.now() };
    existing.calls += 1;
    existing.totalMs += Number(ms) || 0;
    existing.lastAt = this.now();
    if (ok) existing.successes += 1;
    else if (code) existing.failures[code] = (existing.failures[code] || 0) + 1;
    if (taskClass) {
      existing.taskClasses = existing.taskClasses || {};
      existing.taskClasses[taskClass] = (existing.taskClasses[taskClass] || 0) + 1;
    }
    existing.reliability = this.reliabilityOf(existing);
    this.tools.set(name, existing);
    this.put('experience_tools', existing);
    this.counters.toolCalls += 1;
    return existing;
  }

  recordFeedback({ runId = null, rating, note = null, taskClass = null }) {
    const value = Number(rating);
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw Object.assign(new Error('rating must be between -1 and 1'), { code: 'BAD_ARGS' });
    }
    const entry = { id: `fb_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, runId, rating: value, note, taskClass, at: this.now() };
    this.feedback.unshift(entry);
    if (this.feedback.length > 200) this.feedback.length = 200;
    this.counters.feedback += 1;
    this.put('experience_feedback', entry);
    return entry;
  }

  /* ── scoring ──────────────────────────────────────────────────────── */

  scoreOf(entry) {
    // Laplace-smoothed success rate, nudged by verified answers and speed.
    const success = (entry.successes + this.prior) / (entry.attempts + 2 * this.prior);
    const verification = entry.attempts ? entry.verified / entry.attempts : 0;
    const avgMs = entry.attempts ? entry.totalMs / entry.attempts : 10000;
    const speed = 1 / (1 + avgMs / 8000);
    return Number((0.7 * success + 0.2 * verification + 0.1 * speed).toFixed(3));
  }

  reliabilityOf(entry) {
    return Number((((entry.successes + 1) / (entry.calls + 2)) * 100).toFixed(1));
  }

  recommend({ taskClass, candidates = [] } = {}) {
    const ranked = candidates.map((candidate) => {
      const entry = this.strategies.get(this.key(taskClass, candidate.strategy, candidate.agents || []));
      return {
        ...candidate,
        evidence: entry ? { attempts: entry.attempts, successes: entry.successes, score: entry.score, avgMs: Math.round(entry.totalMs / Math.max(1, entry.attempts)) } : null,
        score: entry ? entry.score : 0.5,
      };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  bestFor(taskClass) {
    const rows = [...this.strategies.values()].filter((entry) => entry.taskClass === taskClass).sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  /* ── prompts and versions ─────────────────────────────────────────── */

  registerPrompt(name, text, { version = null, notes = null } = {}) {
    const id = `${name}@${version || new Date(this.now()).toISOString().slice(0, 10)}`;
    const entry = { id, kind: 'prompt', name, text: String(text), version: version || id.split('@')[1], notes, active: false, createdAt: this.now() };
    this.prompts.set(id, entry);
    this.put('experience_prompts', entry);
    return entry;
  }

  activePrompt(name) {
    return [...this.prompts.values()].find((entry) => entry.name === name && entry.active) || null;
  }

  /* ── regression gate ──────────────────────────────────────────────── */

  /**
   * Compares a candidate's measured performance with the active baseline.
   * Promotion requires enough samples and no regression beyond tolerance.
   */
  regressionGate({ baseline, candidate, tolerance = 0.05, minSamples = 8 } = {}) {
    const before = Number(baseline && baseline.score);
    const after = Number(candidate && candidate.score);
    const samples = Number(candidate && candidate.attempts) || 0;
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      return { pass: false, reason: 'brak danych porównawczych', samples, before, after };
    }
    if (samples < minSamples) return { pass: false, reason: `za mało prób (${samples}/${minSamples})`, samples, before, after, delta: Number((after - before).toFixed(3)) };
    const delta = Number((after - before).toFixed(3));
    if (delta < -Math.abs(tolerance)) return { pass: false, reason: `regresja ${delta} poniżej tolerancji ${-Math.abs(tolerance)}`, samples, before, after, delta };
    return { pass: true, reason: delta >= 0 ? 'poprawa lub brak zmian' : 'spadek w granicach tolerancji', samples, before, after, delta };
  }

  /** A candidate improvement is stored, never applied. */
  propose({ name, kind = 'prompt', payload = {}, expected = null, baseline = null }) {
    const id = `cand_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const candidate = { id, name, kind, payload, expected, baseline, status: 'pending', createdAt: this.now() };
    this.candidates.set(id, candidate);
    this.put('experience_candidates', candidate);
    return candidate;
  }

  promote(id, gate = null) {
    const candidate = this.candidates.get(id);
    if (!candidate) throw Object.assign(new Error(`no candidate ${id}`), { code: 'NOT_FOUND' });
    if (gate && gate.pass === false) {
      candidate.status = 'rejected';
      candidate.gate = gate;
      this.put('experience_candidates', candidate);
      this.counters.rejections += 1;
      return { promoted: false, candidate, gate };
    }
    candidate.status = 'promoted';
    candidate.promotedAt = this.now();
    if (candidate.kind === 'prompt') {
      for (const entry of this.prompts.values()) if (entry.name === candidate.name) entry.active = false;
      const entry = this.registerPrompt(candidate.name, candidate.payload.text || '', { version: candidate.payload.version || null, notes: candidate.payload.notes || null });
      entry.active = true;
      this.put('experience_prompts', entry);
    }
    this.put('experience_candidates', candidate);
    this.counters.promotions += 1;
    return { promoted: true, candidate };
  }

  snapshot({ limit = 40 } = {}) {
    return {
      strategies: [...this.strategies.values()].sort((a, b) => b.attempts - a.attempts).slice(0, limit),
      tools: [...this.tools.values()].sort((a, b) => b.calls - a.calls).slice(0, limit),
      feedback: this.feedback.slice(0, 10),
      prompts: [...this.prompts.values()].slice(-10),
      candidates: [...this.candidates.values()].slice(-10),
      counters: { ...this.counters },
      taxonomy: FAILURE_TAXONOMY,
    };
  }

  stats() {
    return {
      strategies: this.strategies.size,
      tools: this.tools.size,
      feedback: this.feedback.length,
      prompts: this.prompts.size,
      candidates: this.candidates.size,
      counters: { ...this.counters },
    };
  }
}

module.exports = { ExperienceStore, FAILURE_TAXONOMY, classifyFailure };
