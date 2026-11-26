#!/usr/bin/env node
'use strict';

/**
 * Validate the machine-readable requirements graph.
 *
 * The graph is deliberately strict: a requirement cannot be VERIFIED unless it
 * names at least one implementation path, one test path and one piece of
 * evidence, and every named path exists in the checkout. This prevents a
 * version bump or a green CI run from being recorded as completion.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GRAPH = path.join(ROOT, 'docs', 'requirements-9.0.json');
const STATUSES = ['NOT_STARTED', 'IMPLEMENTED_UNTESTED', 'PARTIAL', 'VERIFIED', 'BLOCKED'];

function exists(relative) {
  return fs.existsSync(path.resolve(ROOT, relative));
}

function validate(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') return ['graph is not an object'];
  if (!Array.isArray(graph.requirements)) errors.push('requirements is not an array');
  if (!graph.targets || typeof graph.targets !== 'object') errors.push('targets missing');
  if (!graph.measured || typeof graph.measured !== 'object') errors.push('measured missing');

  const ids = new Set();
  for (const [index, requirement] of (graph.requirements || []).entries()) {
    const label = requirement.id || `#${index}`;
    for (const field of ['id', 'milestone', 'title', 'status']) {
      if (!requirement[field]) errors.push(`${label}: missing ${field}`);
    }
    if (ids.has(requirement.id)) errors.push(`${label}: duplicate id`);
    ids.add(requirement.id);
    if (!STATUSES.includes(requirement.status)) errors.push(`${label}: invalid status ${requirement.status}`);
    for (const field of ['implementation', 'tests', 'evidence', 'blockers']) {
      if (!Array.isArray(requirement[field])) errors.push(`${label}: ${field} must be an array`);
    }
    for (const file of requirement.implementation || []) {
      if (!exists(file)) errors.push(`${label}: implementation path does not exist: ${file}`);
    }
    for (const file of requirement.tests || []) {
      if (!exists(file)) errors.push(`${label}: test path does not exist: ${file}`);
    }
    if (requirement.status === 'VERIFIED') {
      if (!(requirement.implementation || []).length) errors.push(`${label}: VERIFIED without implementation`);
      if (!(requirement.tests || []).length) errors.push(`${label}: VERIFIED without a test`);
      if (!(requirement.evidence || []).length) errors.push(`${label}: VERIFIED without evidence`);
      if ((requirement.evidence || []).some((item) => /TODO|TBD|not tested|placeholder/i.test(item))) {
        errors.push(`${label}: VERIFIED with non-evidence text`);
      }
    }
    if (requirement.status === 'BLOCKED' && !(requirement.blockers || []).length) {
      errors.push(`${label}: BLOCKED without a blocker`);
    }
  }
  return errors;
}

function summarise(graph) {
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const byMilestone = {};
  for (const requirement of graph.requirements) {
    byStatus[requirement.status] += 1;
    byMilestone[requirement.milestone] = byMilestone[requirement.milestone] || { total: 0, verified: 0, partial: 0, blocked: 0, notStarted: 0 };
    const bucket = byMilestone[requirement.milestone];
    bucket.total += 1;
    if (requirement.status === 'VERIFIED') bucket.verified += 1;
    if (requirement.status === 'PARTIAL') bucket.partial += 1;
    if (requirement.status === 'BLOCKED') bucket.blocked += 1;
    if (requirement.status === 'NOT_STARTED') bucket.notStarted += 1;
  }
  return { total: graph.requirements.length, byStatus, byMilestone };
}

if (require.main === module) {
  const graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
  const errors = validate(graph);
  const summary = summarise(graph);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ version: graph.version, summary, errors }, null, 2));
  } else {
    console.log(`Requirements graph ${graph.version}: ${summary.total} requirements`);
    for (const status of STATUSES) console.log(`  ${status.padEnd(20)} ${summary.byStatus[status]}`);
    console.log('\nMilestones:');
    for (const [milestone, bucket] of Object.entries(summary.byMilestone)) {
      console.log(`  ${milestone.padEnd(4)} ${String(bucket.verified).padStart(2)} verified / ${String(bucket.total).padStart(2)} total, ${bucket.partial} partial, ${bucket.blocked} blocked, ${bucket.notStarted} not started`);
    }
    const verified = graph.requirements.filter((requirement) => requirement.status === 'VERIFIED').length;
    console.log(`\nVerified integration level: ${((verified / graph.requirements.length) * 100).toFixed(1)}% of tracked requirements (not of the 9.0 target set).`);
    if (errors.length) {
      console.log(`\n${errors.length} integrity error(s):`);
      for (const error of errors) console.log(`  ✗ ${error}`);
    } else {
      console.log('\nGraph integrity: OK');
    }
  }
  if (errors.length) process.exitCode = 1;
}

module.exports = { validate, summarise, STATUSES };
