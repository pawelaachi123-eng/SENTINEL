'use strict';

/**
 * Held-out evaluation for experience candidates.
 *
 * The rules that make this useful rather than decorative:
 *   - a case is either in the tuning split or the held-out split, decided by a
 *     stable hash of its id, so a candidate cannot be tuned on the cases it is
 *     graded on;
 *   - an evaluation records how it was produced (`mode: 'live' | 'mock'`) and a
 *     mock result can never satisfy a promotion gate;
 *   - the gate needs a minimum number of held-out cases, a real improvement and
 *     no case that used to pass and now fails;
 *   - promotion is a decision returned to the caller, not an automatic write.
 *
 * Scoring compares observable outcomes (exact text, contains, regex, the tools
 * actually called, an explicit refusal, or the absence of a tool) rather than
 * asking a model whether it did well.
 */

const crypto = require('node:crypto');

function stableSplit(id, salt = 'sentinel') {
  const digest = crypto.createHash('sha256').update(`${salt}:${id}`).digest();
  return digest[0] % 100 < 30 ? 'heldout' : 'train';
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCase(entry, observation) {
  const expected = entry.expected || {};
  const text = String((observation && observation.text) || '');
  const tools = (observation && observation.tools) || [];
  const reasons = [];
  let ok = true;
  if (expected.kind === 'equals') {
    ok = normalize(text) === normalize(expected.value);
    reasons.push(ok ? 'exact match' : `expected ${JSON.stringify(expected.value)}`);
  } else if (expected.kind === 'contains') {
    const missing = (Array.isArray(expected.value) ? expected.value : [expected.value]).filter((needle) => !normalize(text).includes(normalize(needle)));
    ok = missing.length === 0;
    if (!ok) reasons.push(`missing ${missing.join(', ')}`);
  } else if (expected.kind === 'regex') {
    ok = new RegExp(expected.value, expected.flags || 'i').test(text);
    if (!ok) reasons.push(`did not match /${expected.value}/`);
  } else if (expected.kind === 'tool') {
    ok = tools.includes(expected.value);
    if (!ok) reasons.push(`expected tool ${expected.value}, called ${tools.join(', ') || 'none'}`);
  } else if (expected.kind === 'noTool') {
    ok = !tools.some((name) => name === expected.value || String(name).startsWith(`${expected.value}.`));
    if (!ok) reasons.push(`used forbidden tool ${expected.value}`);
  } else if (expected.kind === 'refusal') {
    ok = observation && observation.ok === false;
    if (!ok) reasons.push('the request was not refused');
  } else {
    ok = Boolean(observation && observation.ok);
    reasons.push('no expectation declared; scored on success only');
  }
  if (entry.maxMs && observation && observation.ms > entry.maxMs) {
    ok = false;
    reasons.push(`took ${observation.ms} ms (limit ${entry.maxMs} ms)`);
  }
  return { id: entry.id, ok, reasons, ms: (observation && observation.ms) || null, tools, text: text.slice(0, 160) };
}

class EvaluationRunner {
  constructor({ log = null, now = () => Date.now(), splitter = stableSplit } = {}) {
    this.log = log;
    this.now = now;
    this.splitter = splitter;
  }

  /**
   * @param {Array} cases
   * @param {(entry) => Promise<{ok?:boolean,text?:string,tools?:string[],ms?:number}>} ask
   */
  async run({ cases, ask, split = 'all', mode = 'live', label = null, limit = null } = {}) {
    if (!Array.isArray(cases) || !cases.length) throw Object.assign(new Error('no evaluation cases'), { code: 'NO_CASES' });
    if (typeof ask !== 'function') throw Object.assign(new Error('evaluation needs an ask() function'), { code: 'NO_RUNNER' });
    const selected = cases.filter((entry) => (split === 'all' ? true : this.splitter(entry.id) === split)).slice(0, limit || cases.length);
    const results = [];
    for (const entry of selected) {
      const started = this.now();
      let observation;
      let thrown = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        observation = await ask(entry);
      } catch (err) {
        thrown = err;
        observation = { ok: false, text: '', tools: [], ms: this.now() - started };
      }
      const scored = scoreCase(entry, { ...observation, ms: (observation && observation.ms) || this.now() - started });
      if (thrown && scored.ok) scored.reasons.push('the runner threw even though the case was scored as a pass');
      results.push({ ...scored, error: thrown ? `THROWN: ${thrown.message}` : null });
    }
    const passed = results.filter((entry) => entry.ok).length;
    return {
      label,
      mode,
      split,
      cases: results.length,
      passed,
      failed: results.length - passed,
      score: results.length ? Number((passed / results.length).toFixed(3)) : 0,
      ms: results.reduce((sum, entry) => sum + (entry.ms || 0), 0),
      results,
      at: new Date(this.now()).toISOString(),
      honest: mode === 'live' ? 'executed against the configured provider' : 'deterministic mock/provider stub — not a model quality measurement',
    };
  }

  /**
   * Promotion gate. `baseline` and `candidate` are results from run(). Both must
   * be live and on the same held-out cases.
   */
  gate({ baseline, candidate, tolerance = 0.02, requireImprovement = true, minCases = 8 } = {}) {
    const reasons = [];
    const reject = (code, message) => ({ promoted: false, code, message, reasons, baseline: baseline && baseline.score, candidate: candidate && candidate.score });
    if (!baseline || !candidate) return reject('MISSING_RESULT', 'both a baseline and a candidate result are required');
    if (baseline.mode !== 'live' || candidate.mode !== 'live') return reject('MOCK_NOT_PROMOTABLE', 'evaluation ran against a mock; it cannot justify promotion');
    if (baseline.split !== 'heldout' || candidate.split !== 'heldout') return reject('NOT_HELDOUT', 'promotion is decided on the held-out split only');
    const baselineById = new Map(baseline.results.map((entry) => [entry.id, entry]));
    const candidateById = new Map(candidate.results.map((entry) => [entry.id, entry]));
    const common = [...baselineById.keys()].filter((id) => candidateById.has(id));
    if (common.length < Math.max(1, minCases)) return reject('INSUFFICIENT_CASES', `only ${common.length} held-out cases in common (need ${minCases})`);
    const regressions = common.filter((id) => baselineById.get(id).ok && !candidateById.get(id).ok).map((id) => ({ id, reasons: candidateById.get(id).reasons }));
    if (regressions.length) reasons.push(`${regressions.length} regression(s): ${regressions.map((entry) => entry.id).join(', ')}`);
    const baselineScore = common.filter((id) => baselineById.get(id).ok).length / common.length;
    const candidateScore = common.filter((id) => candidateById.get(id).ok).length / common.length;
    const delta = Number((candidateScore - baselineScore).toFixed(3));
    if (regressions.length) return { promoted: false, code: 'REGRESSION', message: `candidate regressed ${regressions.length} held-out case(s)`, reasons, regressions, baselineScore, candidateScore, delta };
    if (requireImprovement && delta <= tolerance) {
      return { promoted: false, code: 'NO_IMPROVEMENT', message: `delta ${delta} does not exceed the ${tolerance} tolerance`, reasons, baselineScore, candidateScore, delta };
    }
    return { promoted: true, code: 'PASSED', message: `held-out score ${baselineScore} → ${candidateScore} (delta ${delta})`, reasons, baselineScore, candidateScore, delta, cases: common.length };
  }
}

/** A small, explicit suite used by scripts/eval.js; cases live in eval/cases.json. */
function loadCases(json) {
  const cases = Array.isArray(json) ? json : json.cases;
  if (!Array.isArray(cases)) throw Object.assign(new Error('cases must be an array'), { code: 'BAD_CASES' });
  const seen = new Set();
  for (const entry of cases) {
    if (!entry.id || !entry.input) throw Object.assign(new Error('every case needs id and input'), { code: 'BAD_CASES' });
    if (seen.has(entry.id)) throw Object.assign(new Error(`duplicate case id ${entry.id}`), { code: 'BAD_CASES' });
    seen.add(entry.id);
  }
  return cases;
}

module.exports = { EvaluationRunner, scoreCase, stableSplit, loadCases };
