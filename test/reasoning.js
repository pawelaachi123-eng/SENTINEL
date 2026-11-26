#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const { forwardChain, abduce, solveCsp, bayesUpdate, causalPaths, intervalRelations, spatialRelations, decide } = require('../core/reasoning/engines');

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

const familyRules = [
  { id: 'parent-ancestor', if: [{ pred: 'parent', args: ['?x', '?y'] }], then: { pred: 'ancestor', args: ['?x', '?y'] } },
  { id: 'ancestor-transitive', if: [{ pred: 'parent', args: ['?x', '?y'] }, { pred: 'ancestor', args: ['?y', '?z'] }], then: { pred: 'ancestor', args: ['?x', '?z'] } },
];

check('forward chaining derives facts with a proof and rule provenance', () => {
  const result = forwardChain({
    facts: [
      { pred: 'parent', args: ['ann', 'bob'] },
      { pred: 'parent', args: ['bob', 'cid'] },
      { pred: 'parent', args: ['cid', 'dee'] },
    ],
    rules: familyRules,
  });
  const ancestor = result.facts.find((fact) => fact.pred === 'ancestor' && fact.args[0] === 'ann' && fact.args[1] === 'dee');
  assert.ok(ancestor);
  assert.equal(ancestor.derivedBy, 'ancestor-transitive');
  assert.ok(ancestor.supports.length >= 1);
  assert.equal(result.status, 'proven');
  assert.ok(result.explanation.length >= 2);
  return `${result.derived} derived in ${result.iterations} iterations`;
});

check('forward chaining rejects malformed rules and does not invent without premises', () => {
  assert.throws(() => forwardChain({ facts: [{ pred: 'p' }], rules: [] }), /rules/);
  assert.throws(() => forwardChain({ facts: [{ pred: 'p' }], rules: [{ if: [{ args: [] }], then: { pred: 'q' } }] }), /predicate/);
  const empty = forwardChain({ facts: [{ pred: 'rain', args: ['today'] }], rules: [{ id: 'wet', if: [{ pred: 'rain', args: ['?d'] }], then: { pred: 'wet', args: ['?d'] } }] });
  assert.equal(empty.derived, 1);
});

check('negated facts are kept separate and contradictions are reported', () => {
  const result = forwardChain({
    facts: [
      { pred: 'power', args: ['on'] },
      { pred: 'power', args: ['on'], negated: true },
    ],
    rules: [{ id: 'noop', if: [{ pred: 'power', args: ['?x'] }], then: { pred: 'seen', args: ['?x'] } }],
  });
  const pair = result.contradictions.find((entry) => entry.statement.includes('power'));
  assert.ok(pair, 'the opposite facts were not paired');
});

check('abduction returns the smallest explanation and labels it supported', () => {
  const result = abduce({
    facts: [{ pred: 'server', args: ['down'] }],
    rules: [
      { id: 'power-cause', if: [{ pred: 'power_cut', args: ['?x'], assumable: true }], then: { pred: 'server', args: ['?x'], negated: true } },
      { id: 'network-cause', if: [{ pred: 'router_failure', args: ['?x'], assumable: true }], then: { pred: 'no_route', args: ['?x'] } },
    ],
    observations: [{ pred: 'server', args: ['down'], negated: true }],
    maxHypotheses: 2,
  });
  assert.ok(result.candidates.length >= 1);
  assert.deepEqual(result.candidates[0].hypotheses, ['power_cut(down)']);
  assert.equal(result.candidates[0].cost, 1);
  assert.equal(result.status, 'supported');
});

check('abduction reports no explanation when nothing is assumable', () => {
  const result = abduce({ facts: [{ pred: 'p' }], rules: [{ if: [{ pred: 'q' }], then: { pred: 'r' } }], observations: [{ pred: 'r' }] });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.status, 'unsupported');
});

check('CSP solves a small map-colouring problem with all constraints checked', () => {
  const result = solveCsp({
    variables: { wa: ['r', 'g', 'b'], nt: ['r', 'g', 'b'], sa: ['r', 'g', 'b'] },
    constraints: [
      { vars: ['wa', 'nt'], op: 'neq' },
      { vars: ['wa', 'sa'], op: 'neq' },
      { vars: ['nt', 'sa'], op: 'neq' },
    ],
    limit: 2,
  });
  assert.equal(result.satisfiable, true);
  assert.equal(result.solutions.length, 2);
  for (const solution of result.solutions) {
    assert.notEqual(solution.wa, solution.nt);
    assert.notEqual(solution.wa, solution.sa);
    assert.notEqual(solution.nt, solution.sa);
  }
  assert.equal(result.status, 'proven');
});

check('CSP proves unsatisfiability only after exhausting the finite space', () => {
  const result = solveCsp({
    variables: { a: [1], b: [1] },
    constraints: [{ vars: ['a', 'b'], op: 'neq' }],
  });
  assert.equal(result.satisfiable, false);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'proven');
});

check('CSP reports an exhausted node budget as incomplete, never unsatisfiable', () => {
  const variables = {};
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) variables[name] = [0, 1];
  const result = solveCsp({ variables, constraints: [{ vars: ['a', 'b', 'c', 'd', 'e', 'f'], op: 'allDifferent' }], maxNodes: 5 });
  assert.equal(result.complete, false);
  assert.equal(result.satisfiable, false);
  assert.equal(result.status, 'estimated');
});

check('CSP honours ordering constraints as well as inequality', () => {
  const result = solveCsp({
    variables: { x: [1, 2, 3], y: [1, 2, 3] },
    constraints: [{ vars: ['x', 'y'], op: 'lt' }],
    limit: 1,
  });
  assert.ok(result.solutions[0].x < result.solutions[0].y);
});

check('Bayesian updating normalises and keeps prior/posterior separate', () => {
  const result = bayesUpdate({
    hypotheses: { sick: null, healthy: null },
    priors: { sick: 0.01, healthy: 0.99 },
    evidence: [{ id: 'positive-test', likelihoods: { sick: 0.99, healthy: 0.05 } }],
  });
  assert.ok(Math.abs(result.prior.sick - 0.01) < 1e-12);
  assert.ok(Math.abs(result.posterior.sick + result.posterior.healthy - 1) < 1e-12);
  assert.ok(result.posterior.sick > 0.16 && result.posterior.sick < 0.17, String(result.posterior.sick));
  assert.equal(result.status, 'supported');
});

check('Bayesian updating skips unusable evidence and says so', () => {
  const result = bayesUpdate({ hypotheses: { a: null, b: null }, evidence: [{ id: 'broken', likelihoods: { a: 0.9 } }] });
  assert.equal(result.evidenceUsed.length, 0);
  assert.equal(result.evidenceSkipped.length, 1);
  assert.equal(result.status, 'estimated');
});

check('Bayesian updating rejects invalid priors', () => {
  assert.throws(() => bayesUpdate({ hypotheses: { a: null }, priors: { a: -1 } }), /prior/);
});

check('causal paths are ranked by strength and bounded by depth', () => {
  const result = causalPaths({
    from: 'disk',
    to: 'timeout',
    edges: [
      { from: 'disk', to: 'slow-io', weight: 0.8 },
      { from: 'slow-io', to: 'timeout', weight: 0.9 },
      { from: 'disk', to: 'timeout', weight: 0.2 },
    ],
    maxDepth: 3,
  });
  assert.equal(result.paths[0].nodes.join('>'), 'disk>slow-io>timeout');
  assert.ok(result.paths[0].strength > result.paths[1].strength);
  assert.equal(result.reached, true);
  assert.equal(result.status, 'supported');
});

check('causal search does not loop forever on cycles', () => {
  const result = causalPaths({
    from: 'a',
    to: 'd',
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
  });
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.paths[0].nodes, ['a', 'b', 'c', 'd']);
});

check('interval algebra distinguishes before, meets, overlaps and during', () => {
  assert.deepEqual(intervalRelations({ start: 1, end: 2 }, { start: 3, end: 4 }).relations, ['before']);
  assert.deepEqual(intervalRelations({ start: 1, end: 2 }, { start: 2, end: 4 }).relations, ['meets']);
  assert.deepEqual(intervalRelations({ start: 1, end: 3 }, { start: 2, end: 4 }).relations, ['overlaps']);
  assert.deepEqual(intervalRelations({ start: 2, end: 3 }, { start: 1, end: 4 }).relations, ['during']);
  assert.deepEqual(intervalRelations({ start: 1, end: 4 }, { start: 1, end: 4 }).relations, ['equals']);
});

check('interval algebra rejects malformed intervals', () => {
  assert.throws(() => intervalRelations({ start: 2, end: 1 }, { start: 3, end: 4 }), /starts before/);
  assert.throws(() => intervalRelations({ start: 'x' }, { start: 1, end: 2 }), /numeric/);
});

check('spatial relations compute overlap area, containment and distance', () => {
  const overlap = spatialRelations({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 });
  assert.equal(overlap.overlap, true);
  assert.equal(overlap.overlapArea, 4);
  const contained = spatialRelations({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 3, h: 3 });
  assert.equal(contained.contains, true);
  assert.equal(contained.within, false);
  const apart = spatialRelations({ x: 0, y: 0, w: 1, h: 1 }, { x: 4, y: 5, w: 1, h: 1 });
  assert.equal(apart.disjoint, true);
  assert.equal(apart.distance, 5);
});

check('touching rectangles are not counted as overlapping', () => {
  const result = spatialRelations({ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 });
  assert.equal(result.overlap, false);
  assert.equal(result.touches, true);
});

check('expected utility ranks deterministic options and reports the margin', () => {
  const result = decide({
    options: [
      { id: 'fast', speed: 9, quality: 5, risk: 2 },
      { id: 'careful', speed: 4, quality: 9, risk: 7 },
    ],
    criteria: [
      { id: 'speed', field: 'speed' },
      { id: 'quality', field: 'quality' },
      { id: 'risk', field: 'risk' },
    ],
    weights: { speed: 1, quality: 2, risk: 0.5 },
  });
  assert.equal(result.ranking.length, 2);
  assert.equal(result.winner, 'careful');
  assert.ok(result.margin > 0);
  assert.equal(result.status, 'supported');
});

check('expected utility refuses missing numbers instead of guessing', () => {
  assert.throws(() => decide({ options: [{ id: 'a', speed: 1 }], criteria: [{ id: 'quality' }] }), /no numeric/);
  assert.throws(() => decide({ options: [{ id: 'a', speed: 'fast' }], criteria: [{ id: 'speed' }] }), /no numeric/);
});

check('probabilistic decisions are labelled estimated', () => {
  const result = decide({
    options: [
      { id: 'a', value: 100, chance: 0.2 },
      { id: 'b', value: 30, chance: 0.9 },
    ],
    criteria: [{ id: 'value', field: 'value', probabilityField: 'chance' }],
  });
  assert.equal(result.winner, 'b');
  assert.equal(result.uncertain, true);
  assert.equal(result.status, 'estimated');
});

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed} of ${checks.length} reasoning checks passed.`);
if (failed) process.exitCode = 1;
