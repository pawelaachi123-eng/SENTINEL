#!/usr/bin/env node
'use strict';

/**
 * Tool inventory audit.
 *
 * Structural checks are cheap and cover every tool: identity, permission,
 * schema, description quality, handler presence. They are necessary and not
 * sufficient — a well-described tool can still be broken.
 *
 * Execution checks are the only thing that yields a `verified` count, and they
 * run a fixed subset of read-only tools with explicit arguments inside the
 * workspace. Everything not actually executed is reported as `unexecuted`.
 * There is no path in this script that marks a tool verified without a real,
 * successful call.
 */

const fs = require('node:fs');
const { removeHome } = require('./lib/cleanup');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../core/agent');

const FILLER = /\b(lorem ipsum|placeholder text|not implemented yet|coming soon)\b/i;
const PERMISSIONS = ['read', 'write', 'system', 'network', 'privileged'];

const SAFE_CALLS = [
  { name: 'system.info', args: {} },
  { name: 'math.eval', args: { expression: '2+3*4' } },
  { name: 'math.percent', args: { mode: 'of', a: 15, b: 200 } },
  { name: 'graph.stats', args: {} },
  { name: 'runtime.status', args: {} },
  { name: 'mcp.status', args: {} },
  { name: 'task.list', args: {} },
  { name: 'memory.stats', args: {} },
  { name: 'kb.stats', args: {} },
  { name: 'kb.list', args: {} },
  { name: 'fs.list', args: { path: '.' } },
  { name: 'system.snapshot', args: {} },
  { name: 'org.status', args: {} },
  { name: 'org.plan', args: { capability: 'windows', workers: 2 } },
  { name: 'lab.status', args: {} },
  { name: 'models.capabilities', args: {} },
  { name: 'reason.contradictions', args: { facts: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] } },
  { name: 'skill.list', args: {} },
  { name: 'research.list', args: {} },
  { name: 'memory.due', args: {} },
  { name: 'memory.migrate_preview', args: {} },
  { name: 'repo.map', args: {} },
  { name: 'data.csv_parse', args: { text: 'a,b\n1,2\n' } },
  { name: 'data.csv_generate', args: { rows: [{ a: 1, b: 2 }] } },
  { name: 'data.json_flatten', args: { value: { a: { b: 1 } } } },
  { name: 'data.json_path', args: { value: { a: 1 }, path: 'a' } },
  { name: 'data.json_diff', args: { left: { a: 1 }, right: { a: 2 } } },
  { name: 'data.table_group', args: { rows: [{ k: 'a', v: 1 }], key: 'k', operations: [{ field: 'v', op: 'sum' }] } },
  { name: 'data.table_sort', args: { rows: [{ v: 2 }, { v: 1 }], keys: [{ field: 'v' }] } },
  { name: 'data.table_filter', args: { rows: [{ v: 1 }, { v: 2 }], conditions: [{ field: 'v', op: 'gte', value: 2 }] } },
  { name: 'data.columns', args: { rows: [{ a: 1 }] } },
  { name: 'data.dedupe', args: { rows: [{ a: 1 }, { a: 1 }], keys: ['a'] } },
  { name: 'data.join', args: { left: [{ id: 1 }], right: [{ id: 1, x: 2 }], leftKey: 'id' } },
  { name: 'stats.describe', args: { values: [1, 2, 3] } },
  { name: 'stats.percentile', args: { values: [1, 2, 3], percentiles: [50] } },
  { name: 'stats.histogram', args: { values: [1, 2, 3], bins: 2 } },
  { name: 'stats.correlation', args: { x: [1, 2], y: [2, 4] } },
  { name: 'stats.linear_regression', args: { x: [1, 2], y: [2, 4] } },
  { name: 'stats.outliers', args: { values: [1, 2, 3, 4, 100] } },
  { name: 'stats.zscores', args: { values: [1, 2, 3] } },
  { name: 'stats.sample', args: { values: [1, 2, 3], size: 2 } },
  { name: 'stats.mean_ci', args: { values: [1, 2, 3] } },
  { name: 'stats.two_proportion', args: { successesA: 5, totalA: 10, successesB: 6, totalB: 10 } },
  { name: 'text.extract', args: { text: 'mail a@b.pl i numer 12' } },
  { name: 'text.redact', args: { text: 'password=abcdef123' } },
  { name: 'text.slugify', args: { text: 'Zażółć gęślą jaźń' } },
  { name: 'text.levenshtein', args: { a: 'kot', b: 'koty' } },
  { name: 'text.similarity', args: { a: 'abc def', b: 'abc def' } },
  { name: 'text.chunk', args: { text: 'Akapit. Drugi akapit.', size: 100 } },
  { name: 'text.keywords', args: { text: 'dysk dysk pamiec' } },
  { name: 'text.stats', args: { text: 'Zdanie. Drugie zdanie.' } },
  { name: 'time.parse', args: { value: '2026-03-01T10:00:00Z' } },
  { name: 'time.diff', args: { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' } },
  { name: 'time.add', args: { value: '2026-03-01T00:00:00Z', days: 1 } },
  { name: 'encode.base64', args: { text: 'abc' } },
  { name: 'encode.hex', args: { text: 'abc' } },
  { name: 'encode.url', args: { text: 'a b' } },
  { name: 'encode.hash', args: { text: 'abc' } },
  { name: 'encode.uuid', args: { count: 2 } },
];

async function main() {
  const noWrite = process.argv.includes('--no-write');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-audit-'));
  process.env.SENTINEL_HOME = home;
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
  const agent = new Agent();
  const structural = { total: 0, categories: {}, permissions: {}, problems: [] };
  try {
    for (const tool of agent.tools.list()) {
      structural.total += 1;
      const full = agent.tools.get(tool.name) || tool;
      structural.categories[tool.category] = (structural.categories[tool.category] || 0) + 1;
      structural.permissions[tool.permission] = (structural.permissions[tool.permission] || 0) + 1;
      const problems = [];
      if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(tool.name)) problems.push('name is not a stable identifier');
      if (!PERMISSIONS.includes(tool.permission)) problems.push(`unknown permission ${tool.permission}`);
      if (String(tool.description || '').length < 40) problems.push('description is too short to choose the tool');
      if (FILLER.test(`${tool.title} ${tool.description}`)) problems.push('description looks like filler');
      if (!tool.parameters || typeof tool.parameters !== 'object' || (tool.parameters.type && tool.parameters.type !== 'object')) problems.push('parameters are not an object schema');
      if (typeof full.run !== 'function') problems.push('no run() function');
      if (tool.category === 'general') problems.push('uncategorised tool');
      if (problems.length) structural.problems.push({ tool: tool.name, problems });
    }
    const executed = [];
    for (const call of SAFE_CALLS) {
      const tool = agent.tools.get(call.name);
      if (!tool) {
        executed.push({ tool: call.name, ok: false, code: 'MISSING', message: 'not registered' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await agent.tools.execute(call.name, call.args, { source: 'audit' });
      executed.push({ tool: call.name, ok: Boolean(result.ok), code: result.code || null, ms: result.ms || null, message: result.message ? String(result.message).slice(0, 200) : null });
    }
    const report = {
      version: require('../package.json').version,
      at: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      tools: structural.total,
      categories: structural.categories,
      categoryCount: Object.keys(structural.categories).length,
      permissions: structural.permissions,
      structural: { checked: structural.total, problems: structural.problems, ok: structural.problems.length === 0 },
      execution: {
        attempted: executed.length,
        verified: executed.filter((entry) => entry.ok).length,
        failed: executed.filter((entry) => !entry.ok).length,
        results: executed,
        note: 'Only these tools were executed. Every other tool is unverified, not "verified".',
      },
      unexecuted: structural.total - executed.filter((entry) => entry.ok).length,
    };
    const major = String(require('../package.json').version).split('.')[0];
    const target = path.join(__dirname, '..', 'docs', `tool-audit-${major}.0.json`);
    if (!noWrite) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(`tools: ${report.tools} in ${report.categoryCount} categories`);
    console.log(`structural problems: ${structural.problems.length}`);
    console.log(`executed successfully: ${report.execution.verified}/${report.execution.attempted} (verified), unexecuted: ${report.unexecuted}`);
    console.log(noWrite ? 'report not written (--no-write)' : `written: ${target}`);
    return structural.problems.length ? 1 : 0;
  } finally {
    agent.stop();
    await removeHome(home, { agent });
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`audit failed: ${err.message}`);
    process.exitCode = 2;
  });
