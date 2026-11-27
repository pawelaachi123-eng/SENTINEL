#!/usr/bin/env node
'use strict';

/**
 * The requirements graph is part of the test surface, not a document that rots.
 * A requirement may only be VERIFIED when its implementation and test paths
 * exist and it carries evidence; BLOCKED must explain the blocker.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validate, summarise, STATUSES } = require('../scripts/requirements-graph');

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'requirements-10.0.json'), 'utf8'));
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

check('the graph parses and passes every integrity rule', () => {
  const errors = validate(graph);
  assert.deepEqual(errors, []);
  return `${graph.requirements.length} requirements`;
});

check('requirement ids are unique and every status is from the fixed vocabulary', () => {
  const ids = graph.requirements.map((requirement) => requirement.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const requirement of graph.requirements) assert.ok(STATUSES.includes(requirement.status), requirement.id);
  return `${ids.length} ids, ${STATUSES.length} allowed statuses`;
});

check('the status summary accounts for every requirement exactly once', () => {
  const summary = summarise(graph);
  const total = Object.values(summary.byStatus).reduce((sum, value) => sum + value, 0);
  assert.equal(total, graph.requirements.length);
  return Object.entries(summary.byStatus).map(([status, count]) => `${status}=${count}`).join(', ');
});

check('the graph does not mark any target as met by a version number', () => {
  const verified = graph.requirements.filter((requirement) => requirement.status === 'VERIFIED');
  for (const requirement of verified) {
    assert.ok(requirement.implementation.length, requirement.id);
    assert.ok(requirement.tests.length, requirement.id);
    assert.ok(requirement.evidence.length, requirement.id);
  }
  assert.ok(graph.measured.tools < graph.targets.tools);
  assert.ok(graph.measured.sourceLines < graph.targets.sourceLines);
  assert.ok(graph.measured.agents < graph.targets.agents);
  return `${verified.length} verified; large targets remain open`;
});

check('every BLOCKED requirement states a concrete blocker', () => {
  for (const requirement of graph.requirements.filter((entry) => entry.status === 'BLOCKED')) {
    assert.ok(requirement.blockers.length, requirement.id);
  }
  return 'blockers documented';
});

check('the 2,000-check target is covered by a measured matrix of at least 2,000', () => {
  assert.ok(graph.measured.checks >= 2000, `measured ${graph.measured.checks}`);
  return `${graph.measured.checks} checks recorded`;
});

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed} of ${checks.length} requirements checks passed.`);
if (failed) process.exitCode = 1;
