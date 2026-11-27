#!/usr/bin/env node
'use strict';

/**
 * Advanced reasoning tests: induction, structural counterfactuals, exact
 * Bayesian networks, constrained optimisation, hierarchical planning, graph
 * search and propositional proof. Each test checks the epistemic label too,
 * because "a solver returned a number" is not the same as "the claim is proven".
 */

const assert = require('node:assert');
const {
  induce,
  counterfactual,
  bayesNetwork,
  optimizeCsp,
  hierarchicalPlan,
  graphSearch,
  verifyPropositional,
} = require('../core/reasoning/engines');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const fruit = [
  { color: 'red', shape: 'round', class: 'apple' },
  { color: 'red', shape: 'round', class: 'apple' },
  { color: 'green', shape: 'round', class: 'apple' },
  { color: 'red', shape: 'long', class: 'pepper' },
  { color: 'green', shape: 'long', class: 'pepper' },
];

check('induction learns a rule with support and confidence', () => {
  const result = induce({ examples: fruit, target: 'class', minSupport: 2, minConfidence: 0.6 });
  assert.equal(result.status, 'estimated');
  assert.equal(result.classes.length, 2);
  assert.ok(result.rules.length >= 2);
  const apple = result.rules.find((rule) => rule.label === 'apple');
  assert.ok(apple);
  assert.equal(apple.condition, 'shape=round');
  assert.equal(apple.confidence, 1);
  assert.equal(apple.support, 3);
  assert.equal(result.uncovered.apple, 0);
  return `${result.rules.length} rules`;
});

check('induction refuses to learn from one row', () => {
  assert.throws(() => induce({ examples: [fruit[0]], target: 'class' }), (err) => err.code === 'NO_EXAMPLES');
});

check('induction reports positives that no rule covers', () => {
  const result = induce({
    examples: [
      { x: 1, y: 1, class: 'a' },
      { x: 1, y: 2, class: 'a' },
      { x: 2, y: 1, class: 'b' },
      { x: 2, y: 2, class: 'b' },
      { x: 9, y: 9, class: 'a' },
    ],
    target: 'class',
    minSupport: 2,
    minConfidence: 0.9,
    maxRules: 1,
  });
  assert.equal(result.rules.length, 1);
  assert.ok(result.uncovered.a + result.uncovered.b >= 1);
});

const rainModel = {
  rain: { parents: [], bias: 0 },
  wet: { parents: ['rain'], weights: { rain: 1 }, bias: 0 },
  slippery: { parents: ['wet'], weights: { wet: 0.5 }, bias: 0 },
};

check('a counterfactual returns the model-implied effect and decomposition', () => {
  const result = counterfactual({
    variables: rainModel,
    observed: { rain: 0 },
    interventions: { rain: 1 },
    outcome: 'slippery',
    treatment: 'rain',
  });
  assert.equal(result.factualOutcome, 0);
  assert.equal(result.counterfactualOutcome, 0.5);
  assert.equal(result.delta, 0.5);
  assert.equal(result.decomposition[0].variable, 'wet');
  assert.equal(result.decomposition[0].contribution, 0.5);
  assert.equal(result.status, 'estimated');
  assert.equal(result.identification, 'model-implied');
  assert.ok(result.note.includes('not an effect demonstrated'));
  return `delta ${result.delta}`;
});

check('a cyclic structural model is rejected', () => {
  const variables = {
    a: { parents: ['b'], weights: { b: 1 } },
    b: { parents: ['a'], weights: { a: 1 } },
  };
  assert.throws(() => counterfactual({ variables, interventions: { a: 1 }, outcome: 'a' }), (err) => err.code === 'CYCLIC_MODEL');
});

check('an intervention on an unknown variable is rejected', () => {
  assert.throws(() => counterfactual({ variables: rainModel, interventions: { wind: 1 }, outcome: 'wet' }), (err) => err.code === 'BAD_MODEL');
});

const weatherNetwork = [
  { name: 'rain', values: ['t', 'f'], cpt: { '': { t: 0.2, f: 0.8 } } },
  {
    name: 'wet',
    values: ['t', 'f'],
    parents: ['rain'],
    cpt: { 'rain=t': { t: 0.9, f: 0.1 }, 'rain=f': { t: 0.1, f: 0.9 } },
  },
];

check('exact enumeration computes a marginal', () => {
  const result = bayesNetwork({ nodes: weatherNetwork, query: ['wet'] });
  assert.equal(result.status, 'proven');
  const wet = result.marginals.wet.find((entry) => entry.value === 't');
  assert.ok(Math.abs(wet.probability - 0.26) < 1e-9);
  assert.equal(result.mostLikely.wet, 'f');
  assert.equal(result.assignments, 4);
});

check('evidence updates the posterior', () => {
  const result = bayesNetwork({ nodes: weatherNetwork, query: ['rain'], evidence: { wet: 't' } });
  const rain = result.marginals.rain.find((entry) => entry.value === 't');
  assert.ok(Math.abs(rain.probability - 0.18 / 0.26) < 1e-9);
  return `P(rain=t|wet=t)=${rain.probability.toFixed(4)}`;
});

check('a CPT that does not normalise is rejected', () => {
  const broken = [{ name: 'x', values: ['a', 'b'], cpt: { '': { a: 0.7, b: 0.7 } } }];
  assert.throws(() => bayesNetwork({ nodes: broken, query: ['x'] }), (err) => err.code === 'BAD_PROBABILITY');
});

check('impossible evidence is reported, not conditioned on', () => {
  assert.throws(() => bayesNetwork({ nodes: weatherNetwork, query: ['rain'], evidence: { rain: 'maybe' } }), (err) => err.code === 'BAD_EVIDENCE');
});

check('constrained optimisation finds and proves the optimum', () => {
  const result = optimizeCsp({
    variables: { x: [1, 2, 3], y: [1, 2, 3] },
    constraints: [{ vars: ['x', 'y'], op: 'neq' }],
    objective: { weights: { x: 2, y: 1 } },
  });
  assert.deepEqual(result.solution, { x: 3, y: 2 });
  assert.equal(result.score, 8);
  assert.equal(result.optimal, true);
  assert.equal(result.status, 'proven');
});

check('an infeasible constraint problem returns no solution', () => {
  const result = optimizeCsp({
    variables: { x: [1], y: [1] },
    constraints: [{ vars: ['x', 'y'], op: 'neq' }],
    objective: { weights: { x: 1 } },
  });
  assert.equal(result.solution, null);
  assert.equal(result.satisfiable, false);
  assert.equal(result.status, 'proven');
});

check('a node budget prevents an optimality claim', () => {
  const result = optimizeCsp({
    variables: { x: [1, 2, 3], y: [1, 2, 3] },
    constraints: [{ vars: ['x', 'y'], op: 'neq' }],
    objective: { weights: { x: 2, y: 1 } },
    maxNodes: 1,
  });
  assert.equal(result.complete, false);
  assert.equal(result.status, 'estimated');
});

const buildModel = {
  tasks: ['build'],
  methods: [{ task: 'build', name: 'with-tests', subtasks: ['compile', 'test'] }],
  actions: {
    compile: { requires: [{ var: 'toolchain', equals: 'ok' }], effects: { compiled: true } },
    test: { requires: [{ var: 'compiled', equals: true }], effects: { tested: true } },
  },
  state: { toolchain: 'ok' },
  goal: { tested: true },
};

check('hierarchical planning expands methods and verifies the goal', () => {
  const result = hierarchicalPlan(buildModel);
  assert.deepEqual(result.actions, ['compile', 'test']);
  assert.equal(result.achieved, true);
  assert.equal(result.status, 'proven');
  assert.equal(result.finalState.tested, true);
});

check('a missing decomposition fails the plan honestly', () => {
  const result = hierarchicalPlan({ ...buildModel, methods: [], goal: { tested: true } });
  assert.equal(result.achieved, false);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'proven');
  assert.match(result.note, /every reachable decomposition/);
});

check('graph search finds the shortest path', () => {
  const result = graphSearch({
    edges: [['a', 'b', 1], ['b', 'c', 2], ['a', 'c', 5]],
    start: 'a',
    goal: 'c',
  });
  assert.deepEqual(result.path, ['a', 'b', 'c']);
  assert.equal(result.cost, 3);
  assert.equal(result.status, 'proven');
  return result.note;
});

check('A* with a non-zero heuristic softens the optimality claim', () => {
  const result = graphSearch({
    edges: [['a', 'b', 1], ['b', 'c', 2]],
    start: 'a',
    goal: 'c',
    strategy: 'astar',
    heuristic: { a: 2, b: 1, c: 0 },
  });
  assert.deepEqual(result.path, ['a', 'b', 'c']);
  assert.equal(result.status, 'estimated');
});

check('negative edge costs are rejected', () => {
  assert.throws(() => graphSearch({ edges: [['a', 'b', -1]], start: 'a', goal: 'b' }), (err) => err.code === 'BAD_EDGE');
});

check('a propositional tautology is proven by truth table', () => {
  const formula = {
    op: 'imp',
    args: [
      { op: 'var', name: 'p' },
      { op: 'or', args: [{ op: 'var', name: 'p' }, { op: 'var', name: 'q' }] },
    ],
  };
  const result = verifyPropositional({ formula });
  assert.equal(result.kind, 'tautology');
  assert.equal(result.valid, true);
  assert.equal(result.assignments, 4);
  assert.equal(result.status, 'proven');
});

check('a contradiction is detected with a counterexample', () => {
  const result = verifyPropositional({
    formula: {
      op: 'and',
      args: [{ op: 'var', name: 'p' }, { op: 'not', args: [{ op: 'var', name: 'p' }] }],
    },
  });
  assert.equal(result.kind, 'contradiction');
  assert.equal(result.satisfiable, false);
  assert.ok(result.counterexample);
});

check('a malformed formula is rejected instead of coerced', () => {
  assert.throws(() => verifyPropositional({ formula: { op: 'xor', args: [] } }), (err) => err.code === 'BAD_FORMULA');
});

console.log(`\n${passed} of ${passed + failures.length} advanced reasoning checks passed.`);
if (failures.length) process.exitCode = 1;
