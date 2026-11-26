#!/usr/bin/env node
'use strict';

/**
 * Cross-subsystem integration checks.
 *
 * These caught real 8.0 defects: tools could not see services that the agent
 * had constructed (patch.propose failed with NO_PATCHES), and the schema
 * validator rejected a legal JSON-Schema type union used by calendar.add.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-integration-'));
const { Agent } = require('../core/agent');
const { validate } = require('../core/tools/schema');
const { GraphRAG } = require('../core/knowledge/graphrag');

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

(async () => {
  const agent = new Agent();
  try {
    await check('the service bag exposes every constructed subsystem to tools', () => {
      for (const key of ['patches', 'cognitive', 'context', 'semantics', 'executor', 'reasoning', 'memory', 'knowledge', 'executive', 'trainingLab', 'codeIndex']) {
        assert.ok(agent.services[key], `services.${key} is missing`);
      }
      assert.equal(agent.tools.services.patches, agent.patches);
      return Object.keys(agent.services).length + ' services';
    });

    await check('patch.propose works through the real registry', async () => {
      const workspace = agent.services.paths.workspaceDir();
      fs.mkdirSync(workspace, { recursive: true });
      const file = path.join(workspace, 'integration.js');
      fs.writeFileSync(file, "'use strict';\nfunction a() { return 1; }\n");
      const result = await agent.tools.execute('patch.propose', {
        path: 'integration.js',
        text: "'use strict';\nfunction a() { return 2; }\n",
        reason: 'integration test',
      }, { source: 'integration' });
      assert.equal(result.ok, true, result.message);
      assert.ok(result.data.id);
      const diff = await agent.tools.execute('patch.diff', { id: result.data.id }, { source: 'integration' });
      assert.equal(diff.ok, true, diff.message);
      assert.match(diff.data.diff, /return 2/);
      await agent.tools.execute('patch.discard', { id: result.data.id }, { source: 'integration' });
      return result.data.id;
    });

    await check('a JSON-Schema type union validates both members', () => {
      const schema = { type: 'object', properties: { start: { type: ['string', 'number'] } }, required: ['start'] };
      assert.equal(validate({ start: '2026-01-01T00:00:00Z' }, schema).ok, true);
      assert.equal(validate({ start: 1767225600000 }, schema).ok, true);
      assert.equal(validate({ start: true }, schema).ok, false);
      assert.equal(validate({ start: '123' }, schema).value.start, '123');
      const mixed = { type: 'object', properties: { value: { type: ['string', 'array'], items: { type: 'string' } } } };
      assert.equal(validate({ value: 'a,b' }, mixed).value.value, 'a,b');
      return 'string + number accepted, boolean refused, union strings preserved';
    });

    await check('calendar.add accepts an ISO string through the registry', async () => {
      const result = await agent.tools.execute('calendar.add', { summary: 'integration event', start: '2026-01-02T10:00:00Z', durationMinutes: 10 }, { source: 'integration' });
      assert.equal(result.ok, true, result.message);
      return 'event stored';
    });

    await check('the coding index loads code lazily and parses the workspace fixture', async () => {
      const result = await agent.tools.execute('coding.index', {}, { source: 'integration' });
      assert.equal(result.ok, true, result.message);
      assert.ok(result.data.stats.files >= 1, `indexed ${result.data.stats.files} files`);
      return `${result.data.stats.files} files, ${result.data.stats.symbols} symbols`;
    });

    await check('skill validate reaches promotion without a formatting crash', async () => {
      const proposed = await agent.tools.execute('skill.propose', { name: 'integration skill', description: 'Add two integers.', steps: [{ tool: 'numext.add', args: { a: 2, b: 3 } }] }, { source: 'integration' });
      assert.equal(proposed.ok, true, proposed.message);
      const id = proposed.data.skill.id;
      const validated = await agent.tools.execute('skill.validate', { id, score: 1, cases: 1, passed: 1, approvedBy: 'integration test' }, { source: 'integration' });
      assert.equal(validated.ok, true, validated.message);
      assert.equal(validated.data.skill.status, 'validated');
      await agent.tools.execute('skill.retire', { id, reason: 'integration cleanup', approvedBy: 'integration test' }, { source: 'integration' });
      return id;
    });

    await check('runtime.free reports provider state instead of crashing in its formatter', async () => {
      const result = await agent.tools.execute('runtime.free', {}, { source: 'integration' });
      assert.notEqual(result.code, 'TOOL_FAILED');
      assert.equal(typeof result.text, 'string');
      return `${result.ok ? 'ok' : result.code}: ${result.text.slice(0, 60)}`;
    });

    await check('blackboard and reasoning tools are reachable through the real registry', async () => {
      const added = await agent.tools.execute('blackboard.add', { type: 'fact', content: 'registry fact: orbit is 12 days', scope: 'session:registry', status: 'proven', confidence: 1 }, { source: 'integration' });
      assert.equal(added.ok, true, added.message);
      const id = added.data.entry.id;
      const got = await agent.tools.execute('blackboard.get', { id, scope: 'session:registry' }, { source: 'integration' });
      assert.equal(got.ok, true, got.message);
      const deduced = await agent.tools.execute('omega.deduce', {
        facts: [{ pred: 'parent', args: ['ann', 'bob'] }, { pred: 'parent', args: ['bob', 'cid'] }],
        rules: [{ id: 'ancestor', if: [{ pred: 'parent', args: ['?x', '?y'] }], then: { pred: 'ancestor', args: ['?x', '?y'] } }],
      }, { source: 'integration' });
      assert.equal(deduced.ok, true, deduced.message);
      assert.ok(deduced.data.facts.some((fact) => fact.pred === 'ancestor' && fact.args[1] === 'cid'));
      const meta = await agent.tools.execute('omega.metacognize', { text: 'A measured answer with enough words.', mode: 'balanced', verification: { ok: true, confidence: 0.9 } }, { source: 'integration' });
      assert.equal(meta.ok, true, meta.message);
      assert.equal(meta.data.action, 'proceed');
      const categories = agent.tools.categories();
      assert.ok(categories.some((entry) => entry.name === 'cognitive'));
      return `${agent.tools.list().length} tools in ${categories.length} categories`;
    });

    await check('training and executive services are the same objects the agent exposes', () => {
      assert.equal(agent.services.trainingLab, agent.trainingLab);
      assert.equal(agent.services.executive, agent.executive);
      return 'identity preserved';
    });

    await check('GraphRAG traversal is reachable through the knowledge tool', async () => {
      const graph = new GraphRAG({ dataDir: path.join(process.env.SENTINEL_HOME, 'integration-graph') });
      graph.ingest({ docId: 'i', chunkId: 'i:0000', text: 'Atlas depends on Sentinel. Sentinel depends on Node.' });
      agent.graphRag = graph;
      agent.services.graphRag = graph;
      const result = await agent.tools.execute('graph.query', { query: 'Atlas', depth: 2 }, { source: 'integration' });
      assert.equal(result.ok, true, result.message);
      return 'graph query returned';
    });

    await check('STOP-cancellable training queue is exposed to the agent', () => {
      assert.equal(typeof agent.trainingLab.cancel, 'function');
      assert.equal(agent.trainingLab.queue.concurrency, 1);
      return 'queue reachable';
    });

    await check('tool names remain unique after the integration changes', () => {
      const names = agent.tools.list().map((tool) => tool.name);
      assert.equal(new Set(names).size, names.length);
      return `${names.length} unique tools`;
    });

    await check('every registered tool can see the service bag it declares it needs', () => {
      const missing = [];
      for (const tool of agent.tools.list()) {
        const full = agent.tools.get(tool.name);
        for (const requirement of full.requires || []) {
          if (!agent.services[requirement]) missing.push(`${tool.name}:${requirement}`);
        }
      }
      assert.deepEqual(missing, []);
      return 'declared dependencies satisfied';
    });
  } finally {
    agent.stop();
  }
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`\n${checks.length - failed} of ${checks.length} integration checks passed.`);
  if (failed) process.exitCode = 1;
})();
