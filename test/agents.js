#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { AgentRegistry } = require('../core/ai/agents');
const cases = require('../core/ai/routing-data');
const packNames = new Set(require('../core/ai/agent-packs').map((spec) => spec.name));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const registry = new AgentRegistry();
const agents = [...registry.agents.values()];

check('roster reaches 120 functional agents', () => {
  assert.ok(agents.length >= 120, `only ${agents.length}`);
});

check('names and descriptions are unique', () => {
  assert.equal(new Set(agents.map((agent) => agent.name)).size, agents.length);
  assert.equal(new Set(agents.map((agent) => agent.description)).size, agents.length);
});

check('every agent has triggers, categories and a per-agent tool budget', () => {
  for (const agent of agents) {
    if (packNames.has(agent.name)) assert.ok(agent.triggers.length >= 1, `${agent.name} has no triggers`);
    if (agent.role !== 'orchestrator') assert.ok(agent.categories.length >= 1, `${agent.name} has no categories`);
    assert.ok(agent.maxToolCalls >= 1 && agent.maxToolCalls <= 8, `${agent.name} budget ${agent.maxToolCalls}`);
  }
});

check('every llm agent has substantive operating instructions', () => {
  for (const agent of agents.filter((entry) => entry.role === 'llm')) {
    assert.ok(String(agent.spec.instructions || '').length >= 80, `${agent.name} instructions too short`);
  }
});

check('tool agents have handlers and llm agents do not', () => {
  for (const agent of agents) {
    if (agent.role === 'tool') assert.equal(typeof agent.spec.handler, 'function', `${agent.name} has no handler`);
    if (agent.role === 'llm') assert.equal(agent.spec.handler, undefined, `${agent.name} unexpectedly has a handler`);
  }
});

check('no two agents have an identical trigger set', () => {
  const signatures = new Map();
  for (const agent of agents) {
    const signature = [...agent.triggers].map((trigger) => trigger.toLowerCase()).sort().join('|');
    if (!signature) continue;
    if (signatures.has(signature)) throw new Error(`${agent.name} duplicates the trigger set of ${signatures.get(signature)}`);
    signatures.set(signature, agent.name);
  }
});

const report = registry.routingEvaluation(cases);
check('routing smoke set reaches at least 75% top-1 accuracy', () => {
  assert.ok(report.accuracy >= 0.75, `${report.correct}/${report.cases} = ${(report.accuracy * 100).toFixed(1)}%; misses: ${report.results.filter((entry) => !entry.ok).slice(0, 8).map((entry) => `${entry.expected}→${entry.predicted}`).join(', ')}`);
});

if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure.name}\n    ${failure.error.message}`);
  console.error(`\n${failures.length} agent checks failed; routing ${report.correct}/${report.cases}.`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ ${agents.length} agents; routing ${report.correct}/${report.cases} (${(report.accuracy * 100).toFixed(1)}%)`);
  console.log(`  ✓ ${passed} agent checks passed`);
}
