'use strict';

/**
 * Skill library.
 *
 * A "skill" here is a reviewed procedure, not a fine-tuned model and not a
 * persona. It has typed parameters, preconditions, scoped permissions and an
 * evidence record from tests that actually ran. Skills move
 * candidate → validated → retired; validation needs a held-out gate result and
 * a named human approval. A regression against the currently validated version
 * is rejected instead of silently replacing it.
 */

const crypto = require('node:crypto');
const { newId } = require('./memory/store');

const STATUSES = ['candidate', 'validated', 'retired'];
const MAX_STEPS = 24;

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normaliseParam(name, spec = {}) {
  const type = ['string', 'number', 'boolean', 'array', 'object'].includes(spec.type) ? spec.type : null;
  if (!type) throw Object.assign(new Error(`parameter ${name} needs a JSON type`), { code: 'BAD_SKILL' });
  return { name, type, description: spec.description ? String(spec.description).slice(0, 300) : null, required: Boolean(spec.required), enum: Array.isArray(spec.enum) ? spec.enum.slice(0, 20) : null };
}

class SkillLibrary {
  constructor({ store = null, log = null, now = () => Date.now(), regressionTolerance = 0.02 } = {}) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.regressionTolerance = regressionTolerance;
    this.cache = new Map();
    this.counters = { proposed: 0, duplicates: 0, validated: 0, rejected: 0, regressions: 0, retired: 0, matches: 0 };
    if (store) {
      for (const record of store.list('skills', { limit: 5000 })) this.cache.set(record.id, record);
    }
  }

  persist(record) {
    this.cache.set(record.id, record);
    if (this.store) this.store.put('skills', record.id, record);
    return record;
  }

  all() {
    return [...this.cache.values()];
  }

  get(id) {
    return this.cache.get(id) || null;
  }

  history(name) {
    return this.all().filter((record) => record.name === name).sort((a, b) => b.version - a.version);
  }

  propose({ name, description = '', params = {}, steps = [], scope = 'workspace', permissions = [], evidence = null, precondition = null, proposes = null } = {}) {
    if (!name || typeof name !== 'string' || name.length > 80) throw Object.assign(new Error('a skill needs a short name'), { code: 'BAD_SKILL' });
    if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw Object.assign(new Error(`a skill needs 1..${MAX_STEPS} steps`), { code: 'BAD_SKILL' });
    for (const step of steps) {
      if (!step || typeof step.tool !== 'string' || !step.tool.length) throw Object.assign(new Error('every step must name a tool'), { code: 'BAD_SKILL' });
    }
    const normalisedParams = Object.entries(params || {}).map(([key, spec]) => normaliseParam(key, spec));
    const body = {
      name,
      description: String(description).slice(0, 600),
      params: normalisedParams,
      steps: steps.map((step) => ({ tool: step.tool, args: step.args || {}, note: step.note ? String(step.note).slice(0, 200) : null })),
      scope: ['workspace', 'system', 'network'].includes(scope) ? scope : 'workspace',
      permissions: [...new Set((permissions || []).map(String))].sort(),
      precondition,
      proposes,
    };
    const fingerprint = hash(body);
    const duplicate = this.all().find((record) => record.fingerprint === fingerprint && record.status !== 'retired');
    if (duplicate) {
      this.counters.duplicates += 1;
      return { ok: true, duplicate: true, skill: duplicate, message: 'an identical skill already exists; not duplicated' };
    }
    const version = Math.max(0, ...this.history(name).map((record) => record.version)) + 1;
    const record = {
      id: newId('skill'),
      ...body,
      fingerprint,
      version,
      status: 'candidate',
      evidence: evidence || null,
      tests: null,
      validation: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.counters.proposed += 1;
    this.persist(record);
    return { ok: true, duplicate: false, skill: record };
  }

  /**
   * Promotes a candidate only when a held-out gate actually passed and a human
   * approval was recorded. `gate` is the output of EvaluationRunner, not a
   * model's claim.
   */
  validate(id, { gate = null, approvedBy = null, note = null, baselineId = null } = {}) {
    const record = this.get(id);
    if (!record) return { ok: false, code: 'NOT_FOUND' };
    if (record.status === 'retired') return { ok: false, code: 'RETIRED', message: 'a retired skill cannot be promoted' };
    if (!gate || gate.heldOut !== true) return { ok: false, code: 'NOT_HELD_OUT', message: 'validation needs a held-out gate result' };
    if (!Number.isFinite(Number(gate.score))) return { ok: false, code: 'NO_SCORE', message: 'the gate result has no numeric score' };
    if (!gate.ok) {
      this.counters.rejected += 1;
      record.status = 'candidate';
      record.validation = { ok: false, score: Number(gate.score), at: this.now(), approvedBy: null, reason: 'gate failed' };
      this.persist(record);
      return { ok: false, code: 'GATE_FAILED', message: 'the held-out gate failed; the skill stays a candidate', validation: record.validation };
    }
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'a human must approve promotion by name' };
    const baseline = baselineId ? this.get(baselineId) : this.all().filter((entry) => entry.name === record.name && entry.status === 'validated' && entry.version < record.version).sort((a, b) => b.version - a.version)[0];
    if (baseline && Number(gate.score) + this.regressionTolerance < Number(baseline.validation && baseline.validation.score)) {
      this.counters.regressions += 1;
      record.validation = { ok: false, score: Number(gate.score), baselineScore: baseline.validation.score, at: this.now(), reason: 'regression' };
      this.persist(record);
      return { ok: false, code: 'REGRESSION', message: `score ${gate.score} is below the validated version ${baseline.version} (${baseline.validation.score})`, baseline: baseline.id };
    }
    record.status = 'validated';
    record.tests = {
      cases: Number(gate.cases) || 0,
      passed: Number(gate.passed) || 0,
      score: Number(gate.score),
      heldOut: true,
      mode: gate.mode || 'deterministic',
      at: this.now(),
    };
    record.validation = { ok: true, score: Number(gate.score), at: this.now(), approvedBy, note: note ? String(note).slice(0, 300) : null, baseline: baseline ? baseline.id : null };
    record.updatedAt = this.now();
    this.counters.validated += 1;
    if (baseline && baseline.status === 'validated') {
      baseline.status = 'superseded';
      baseline.supersededBy = record.id;
      this.persist(baseline);
    }
    this.persist(record);
    if (this.log) this.log.info('skills', `promoted ${record.name} v${record.version} (${record.validation.score})`);
    return { ok: true, skill: record };
  }

  retire(id, { reason = null, approvedBy = null } = {}) {
    const record = this.get(id);
    if (!record) return { ok: false, code: 'NOT_FOUND' };
    record.status = 'retired';
    record.retiredAt = this.now();
    record.retireReason = reason ? String(reason).slice(0, 300) : null;
    record.retireApprovedBy = approvedBy;
    this.persist(record);
    this.counters.retired += 1;
    return { ok: true, skill: record };
  }

  /** Deterministic keyword match over validated skills only. */
  match(query, { limit = 5 } = {}) {
    const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
    const scored = this.all()
      .filter((record) => record.status === 'validated')
      .map((record) => {
        const haystack = `${record.name} ${record.description} ${record.steps.map((step) => step.tool).join(' ')}`.toLowerCase();
        const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
        return { record, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
    this.counters.matches += 1;
    return { query, matches: scored.slice(0, limit).map((entry) => ({ id: entry.record.id, name: entry.record.name, version: entry.record.version, score: entry.score, steps: entry.record.steps.length })), considered: scored.length };
  }

  list({ status = null, name = null, limit = 100 } = {}) {
    return this.all()
      .filter((record) => (status ? record.status === status : true))
      .filter((record) => (name ? record.name === name : true))
      .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version)
      .slice(0, limit)
      .map((record) => ({ id: record.id, name: record.name, version: record.version, status: record.status, scope: record.scope, steps: record.steps.length, score: record.validation && record.validation.score }));
  }

  status() {
    const byStatus = {};
    for (const status of [...STATUSES, 'superseded']) byStatus[status] = this.all().filter((record) => record.status === status).length;
    return { total: this.all().length, byStatus, counters: { ...this.counters } };
  }
}

module.exports = { SkillLibrary, STATUSES };
