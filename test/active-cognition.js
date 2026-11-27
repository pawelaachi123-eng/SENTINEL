#!/usr/bin/env node
'use strict';

/**
 * Active metacognition tests.
 *
 * These exercise the controller as an executor, not as an advisor: every test
 * asserts whether a transition actually happened, whether it was bounded, and
 * whether a failed correction was reported as a failure instead of a success.
 */

const assert = require('node:assert');
const { MetacognitiveController } = require('../core/cognition/metacognition');
const { ActiveCognitiveController } = require('../core/cognition/active');

const assessor = new MetacognitiveController();
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function assessment(overrides = {}) {
  return assessor.assess({
    text: 'A reasonably complete answer that is not obviously truncated.',
    brief: { intent: 'factual', complexity: { score: 0.9 }, uncertainty: 0.2 },
    verification: { ok: true, issues: [] },
    model: 'fake-model',
    evidence: {},
    mode: 'deep',
    ...overrides,
  });
}

/** A factual model answer with no evidence: the assessor asks to gather. */
function gatherAssessment(overrides = {}) {
  return assessment({
    text: 'A fluent factual answer that cites no evidence at all.',
    brief: { intent: 'factual', complexity: { score: 0.4 }, uncertainty: 0.2 },
    evidence: {},
    ...overrides,
  });
}

(async () => {
  await check('a gather transition adds evidence and a re-answer raises confidence', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    let gathered = 0;
    const result = await controller.run({
      mode: 'deep',
      assessment: gatherAssessment(),
      answer: { text: 'A fluent factual answer that cites no evidence at all.' },
      handlers: {
        gather: async () => {
          gathered += 1;
          return { added: 2, contextBlock: 'new evidence' };
        },
        evaluate: async ({ contextBlock }) => ({ ok: true, text: `a complete answer grounded in ${contextBlock}`, model: 'fake-model' }),
        assess: async (state) => assessment({ text: state.text, evidence: { memories: 2 }, citations: ['[M1]'], brief: { intent: 'factual' } }),
        qualify: (state) => ({ text: `${state.text}\n\nOgraniczenie: test` }),
      },
    });
    assert.equal(gathered, 1);
    assert.equal(result.corrections, 1);
    assert.equal(result.transitions[0].action, 'gather');
    assert.equal(result.transitions[0].outcome, 'applied');
    assert.ok(result.confidenceGain > 0, `confidence gain was ${result.confidenceGain}`);
    assert.match(result.answer.text, /new evidence/);
    return `${result.summary}, gain ${result.confidenceGain}`;
  });

  await check('gather that finds nothing does not pretend a new attempt was made', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    let evaluations = 0;
    const result = await controller.run({
      mode: 'deep',
      assessment: gatherAssessment(),
      answer: { text: 'A fluent factual answer that cites no evidence at all.' },
      handlers: {
        gather: async () => ({ added: 0, note: 'index is empty' }),
        evaluate: async () => {
          evaluations += 1;
          return { ok: true, text: 'should not run' };
        },
        qualify: (state) => ({ text: `${state.text}\n\nOgraniczenie: brak źródła` }),
      },
    });
    assert.equal(evaluations, 0);
    assert.equal(result.corrections, 0);
    assert.equal(result.exhausted, true);
    assert.ok(result.transitions.some((entry) => entry.outcome === 'no-new-evidence'));
    assert.match(result.answer.text, /Ograniczenie/);
    return result.summary;
  });

  await check('fast mode has no correction budget', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    let calls = 0;
    const result = await controller.run({
      mode: 'fast',
      assessment: assessment({ mode: 'fast' }),
      answer: { text: 'short' },
      handlers: {
        gather: async () => { calls += 1; return { added: 1 }; },
        evaluate: async () => { calls += 1; return { ok: true, text: 'long enough answer' }; },
      },
    });
    assert.equal(controller.budgetFor('fast'), 0);
    assert.equal(calls, 0);
    assert.equal(result.transitions.length, 0);
  });

  await check('balanced mode does not spend an un-budgeted retry and qualifies instead', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    let evaluations = 0;
    const result = await controller.run({
      mode: 'balanced',
      assessment: assessment({ mode: 'balanced', text: 'short', brief: { intent: 'conversation', complexity: { score: 0.9 } } }),
      answer: { text: 'short' },
      handlers: {
        evaluate: async () => { evaluations += 1; return { ok: true, text: 'should not run' }; },
        qualify: (state) => ({ text: `${state.text}\n\nOgraniczenie: zbyt krótka odpowiedź` }),
      },
    });
    assert.equal(evaluations, 0);
    assert.ok(result.transitions.some((entry) => entry.action === 'retry' && entry.outcome === 'not-budgeted'));
    assert.match(result.answer.text, /Ograniczenie/);
  });

  await check('deep mode can apply a retry with verifier issues', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const seen = [];
    const result = await controller.run({
      mode: 'deep',
      assessment: assessment({ text: 'A complete first answer, but one number was rejected.', brief: { intent: 'conversation' }, verification: { ok: false, issues: ['wrong number'] }, retryCount: 0 }),
      answer: { text: 'A complete first answer, but one number was rejected.' },
      handlers: {
        evaluate: async ({ issues }) => {
          seen.push(issues);
          return { ok: true, text: 'The verified answer is 43, checked against the measurement.', verification: { ok: true, issues: [] } };
        },
        assess: async (state) => assessment({ text: state.text, brief: { intent: 'conversation' }, verification: state.verification, retryCount: 1 }),
        qualify: (state) => ({ text: `${state.text} (qualified)` }),
      },
    });
    assert.equal(result.corrections, 1);
    assert.deepEqual(seen[0], ['verification-failed']);
    assert.equal(result.assessment.action, 'proceed');
    return result.summary;
  });

  await check('a throwing evaluator is recorded as failed and never as applied', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const result = await controller.run({
      mode: 'deep',
      assessment: gatherAssessment(),
      answer: { text: 'A fluent factual answer that cites no evidence at all.' },
      handlers: {
        gather: async () => ({ added: 1, contextBlock: 'x' }),
        evaluate: async () => { throw new Error('provider went offline'); },
        qualify: (state) => ({ text: `${state.text}\n\nOgraniczenie: provider offline` }),
      },
    });
    assert.equal(result.corrections, 0);
    assert.ok(!result.transitions.some((entry) => entry.outcome === 'applied'));
    assert.ok(result.transitions.some((entry) => entry.action === 'gather' && entry.outcome === 'evaluate-failed'));
  });

  await check('a throwing gather is recorded and the loop stops', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const result = await controller.run({
      mode: 'deep',
      assessment: gatherAssessment(),
      answer: { text: 'A fluent factual answer that cites no evidence at all.' },
      handlers: { gather: async () => { throw new Error('index unavailable'); } },
    });
    assert.equal(result.corrections, 0);
    assert.ok(result.transitions.some((entry) => entry.outcome === 'failed'));
  });

  await check('cancellation stops before another model call', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const signal = { aborted: true };
    let called = 0;
    const result = await controller.run({
      mode: 'deep',
      signal,
      assessment: assessment(),
      answer: { text: 'short' },
      handlers: { gather: async () => { called += 1; return { added: 1 }; } },
    });
    assert.equal(called, 0);
    assert.equal(result.cancelled, true);
    assert.equal(result.corrections, 0);
  });

  await check('the correction budget is enforced even when the answer stays insufficient', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor, maxCorrections: 2 });
    let evaluations = 0;
    const result = await controller.run({
      mode: 'research',
      assessment: assessment({ mode: 'research' }),
      answer: { text: 'short' },
      handlers: {
        gather: async () => ({ added: 1 }),
        evaluate: async () => { evaluations += 1; return { ok: true, text: `attempt ${evaluations} still short` }; },
        assess: async () => assessment({ mode: 'research', text: 'short' }),
        qualify: (state) => ({ text: `${state.text} (qualified)` }),
      },
    });
    assert.equal(evaluations, 2);
    assert.equal(result.corrections, 2);
    assert.equal(controller.budgetFor('research'), 2);
  });

  await check('the hard time limit prevents a correction that cannot finish', async () => {
    let clock = 0;
    const controller = new ActiveCognitiveController({ metacognitive: assessor, now: () => clock });
    const result = await controller.run({
      mode: 'deep',
      assessment: assessment({ elapsedMs: 179999 }),
      answer: { text: 'short' },
      handlers: {
        gather: async () => { clock += 500; return { added: 1 }; },
        evaluate: async () => ({ ok: true, text: 'should not run' }),
      },
    });
    assert.equal(result.corrections, 0);
    assert.equal(result.exhausted, true);
    assert.ok(result.transitions.some((entry) => entry.outcome === 'budget-exhausted'));
  });

  await check('qualification is applied once and is idempotent', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const state = { text: 'An answer.\n\nOgraniczenie: already known.' };
    const changed = await controller.run({
      mode: 'deep',
      assessment: assessment({ verification: { ok: false, issues: ['bad'] }, retryAllowed: false, mode: 'deep' }),
      answer: state,
      handlers: {
        qualify: (answer) => ({ text: answer.text.includes('Ograniczenie:') ? answer.text : `${answer.text}\nOgraniczenie: duplicate` }),
      },
    });
    assert.equal((changed.answer.text.match(/Ograniczenie:/g) || []).length, 1);
  });

  await check('a proceed assessment changes nothing', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    const original = { text: 'A complete, verified answer.' };
    const result = await controller.run({
      mode: 'balanced',
      assessment: assessment({ text: original.text, brief: { intent: 'conversation' }, evidence: { memories: 1 } }),
      answer: original,
      handlers: {},
    });
    assert.equal(result.answer.text, original.text);
    assert.equal(result.transitions.length, 0);
    assert.equal(result.summary, 'no corrective transition was needed');
  });

  await check('the controller refuses to run without state', async () => {
    const controller = new ActiveCognitiveController({ metacognitive: assessor });
    await assert.rejects(() => controller.run({ mode: 'deep' }), /initial assessment/);
    assert.throws(() => new ActiveCognitiveController({}), /assessor/);
  });

  console.log(`\n${passed} of ${passed + failures.length} active metacognition checks passed.`);
  if (failures.length) process.exitCode = 1;
})();
