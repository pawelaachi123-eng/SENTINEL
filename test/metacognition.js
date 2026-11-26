#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const { MetacognitiveController } = require('../core/cognition/metacognition');

const controller = new MetacognitiveController();
const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const goodVerification = { ok: true, issues: [], confidence: 0.9 };

check('sufficient evidence and verification proceed', () => {
  const result = controller.assess({ text: 'The disk has 40 GB free.', verification: goodVerification, evidence: { memories: 1 }, mode: 'balanced' });
  assert.equal(result.action, 'proceed');
  assert.equal(result.status, 'sufficient');
  assert.equal(result.issues.length, 0);
  return `${result.confidence}`;
});

check('an empty answer stops instead of inventing one', () => {
  const result = controller.assess({ text: '   ', verification: goodVerification });
  assert.equal(result.action, 'stop');
  assert.equal(result.status, 'insufficient');
  assert.equal(result.confidence, 0);
});

check('a request without a subject asks for clarification', () => {
  const result = controller.assess({ text: 'tell me more', brief: { needsClarification: true, intent: 'clarification' }, verification: goodVerification });
  assert.equal(result.action, 'clarify');
  assert.equal(result.status, 'partial');
});

check('unresolved contradictions force an explicit qualification', () => {
  const result = controller.assess({ text: 'Orbit is 12 days.', verification: goodVerification, conflicts: [{ resolved: false }] });
  assert.equal(result.action, 'qualify');
  assert.equal(result.unresolvedConflicts, 1);
  assert.ok(result.issues.some((issue) => issue.code === 'unresolved-conflict'));
});

check('deep mode may retry a failed verification once', () => {
  const result = controller.assess({ text: 'A wrong answer with some text.', verification: { ok: false, issues: ['citation missing'], confidence: 0.2 }, mode: 'deep', retryCount: 0 });
  assert.equal(result.action, 'retry');
  assert.equal(result.retryAllowed, true);
  const second = controller.assess({ text: 'A wrong answer with some text.', verification: { ok: false, issues: ['citation missing'], confidence: 0.2 }, mode: 'deep', retryCount: 1 });
  assert.equal(second.action, 'qualify');
  assert.equal(second.retryAllowed, false);
});

check('balanced mode does not spend a retry it did not budget', () => {
  const result = controller.assess({ text: 'A wrong answer with some text.', verification: { ok: false, issues: ['bad'], confidence: 0.2 }, mode: 'balanced' });
  assert.equal(result.action, 'qualify');
});

check('tool failures are reported as a qualification', () => {
  const result = controller.assess({ text: 'The check could not complete.', verification: goodVerification, toolLog: [{ name: 'system.info', ok: false }] });
  assert.equal(result.action, 'qualify');
  assert.equal(result.evidence.toolFailures, 1);
});

check('a retrieval-style model answer with no evidence asks for gathering', () => {
  const result = controller.assess({ text: 'I believe the answer is probably this.', model: 'local', brief: { intent: 'retrieval' }, verification: goodVerification });
  assert.equal(result.action, 'gather');
  assert.ok(result.issues.some((issue) => issue.code === 'no-evidence'));
});

check('retrieved evidence without citations is qualified', () => {
  const result = controller.assess({ text: 'The figure is twelve days.', model: 'local', brief: { intent: 'factual' }, verification: goodVerification, evidence: { documents: 2 }, citations: [] });
  assert.equal(result.action, 'qualify');
  assert.ok(result.issues.some((issue) => issue.code === 'uncited-evidence'));
});

check('high interpretation uncertainty with no evidence gathers more', () => {
  const result = controller.assess({ text: 'Maybe.', model: 'local', brief: { intent: 'action', uncertainty: 0.9 }, verification: goodVerification });
  assert.equal(result.action, 'gather');
});

check('a thin answer to a complex request is retried', () => {
  const result = controller.assess({ text: 'ok', brief: { intent: 'procedural', complexity: { score: 0.9 } }, verification: goodVerification, mode: 'deep' });
  assert.equal(result.action, 'retry');
  assert.ok(result.issues.some((issue) => issue.code === 'thin-complex-answer'));
});

check('soft resource overruns qualify; hard overruns stop', () => {
  const soft = controller.assess({ text: 'A sufficiently long answer for this test.', verification: goodVerification, elapsedMs: 21000, mode: 'balanced' });
  assert.equal(soft.action, 'qualify');
  assert.equal(soft.resources.overSoft, true);
  const hard = controller.assess({ text: 'A sufficiently long answer for this test.', verification: goodVerification, elapsedMs: 70000, mode: 'balanced' });
  assert.equal(hard.action, 'stop');
  assert.equal(hard.resources.overHard, true);
});

check('token budget overrun is visible in the assessment', () => {
  const result = controller.assess({ text: 'A sufficiently long answer for this test.', verification: goodVerification, budget: { tokens: 100, usedTokens: 160 } });
  assert.ok(result.issues.some((issue) => issue.code === 'token-budget'));
});

check('exact tool answers are not punished for lacking prose citations', () => {
  const result = controller.assess({ text: '21*3 = 63', model: null, brief: { intent: 'math' }, verification: goodVerification, toolLog: [{ name: 'math.eval', ok: true }] });
  assert.equal(result.action, 'proceed');
  assert.equal(result.evidence.toolCalls, 1);
});

check('confidence falls as issue severity rises and never leaves 0..1', () => {
  const clean = controller.assess({ text: 'A clean answer with enough words.', verification: goodVerification });
  const broken = controller.assess({ text: 'A flawed answer with enough words.', verification: { ok: false, issues: ['bad'], confidence: 0.9 }, toolLog: [{ ok: false }], conflicts: [{ resolved: false }], elapsedMs: 22000 });
  assert.ok(broken.confidence < clean.confidence);
  assert.ok(broken.confidence >= 0);
  assert.ok(broken.confidence <= 1);
});

check('the assessment is bounded and carries an actionable summary', () => {
  const result = controller.assess({ text: 'A sufficiently long answer for this test.', verification: { ok: false, issues: ['x'], confidence: 0.3 }, conflicts: [{ resolved: false }], elapsedMs: 25000 });
  assert.ok(result.summary.length > 20);
  assert.ok(result.issues.every((issue) => issue.code && issue.severity && issue.action));
});

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed} of ${checks.length} metacognition checks passed.`);
if (failed) process.exitCode = 1;
