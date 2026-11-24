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
];

async function main() {
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
    const target = path.join(__dirname, '..', 'docs', 'tool-audit-4.0.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`tools: ${report.tools} in ${report.categoryCount} categories`);
    console.log(`structural problems: ${structural.problems.length}`);
    console.log(`executed successfully: ${report.execution.verified}/${report.execution.attempted} (verified), unexecuted: ${report.unexecuted}`);
    console.log(`written: ${target}`);
    return structural.problems.length ? 1 : 0;
  } finally {
    agent.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`audit failed: ${err.message}`);
    process.exitCode = 2;
  });
