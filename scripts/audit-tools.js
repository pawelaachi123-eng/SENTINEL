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
const EXTENDED_PURE = new Set(['numext', 'statx', 'txtx', 'datex', 'geom', 'phys', 'unitsx', 'seqx', 'matrix', 'setx', 'bits', 'basex', 'fmtx', 'finx', 'checksumx']);

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
  { name: 'hypercore.status', args: {} },
  { name: 'hypercore.goals', args: {} },
  { name: 'hypercore.conflicts', args: {} },
  { name: 'hypercore.attention', args: { limit: 5 } },
  { name: 'hypercore.focus', args: { tokenBudget: 512 } },
  { name: 'reranker.status', args: {} },
  { name: 'communication.status', args: {} },
  { name: 'communication.history', args: { limit: 5 } },
  { name: 'science.length_convert', args: { value: 1, from: 'km', to: 'm' } },
  { name: 'science.temperature_convert', args: { value: 0, from: 'C', to: 'K' } },
  { name: 'science.prime_factors', args: { n: 360 } },
  { name: 'science.quadratic', args: { a: 1, b: -3, c: 2 } },
  { name: 'science.gcd_lcm', args: { values: [12, 18] } },
  { name: 'science.mod_pow', args: { base: 2, exponent: 10, modulus: 1000 } },
  { name: 'planning.critical_path', args: { tasks: [{ id: 'a', duration: 2 }, { id: 'b', duration: 3, dependsOn: ['a'] }] } },
  { name: 'planning.pert', args: { optimistic: 2, likely: 4, pessimistic: 9 } },
  { name: 'planning.working_days', args: { date: '2026-03-02', days: 5 } },
  { name: 'calendar.week_number', args: { date: '2026-01-01' } },
  { name: 'finance.budget_split', args: { amount: 100, weights: [1, 1, 1] } },
  { name: 'decision.matrix', args: { criteria: [{ name: 'cost', weight: 1 }], options: [{ name: 'a', scores: [8] }, { name: 'b', scores: [6] }] } },
  { name: 'assistant.briefing', args: { horizonHours: 24 } },
  { name: 'calendar.status', args: {} },
  { name: 'calendar.upcoming', args: { days: 7 } },
  { name: 'calendar.export_ics', args: { days: 1 } },
  { name: 'proactive.status', args: {} },
  { name: 'lab.sentiment_status', args: {} },
  { name: 'specialists.status', args: {} },
  { name: 'time.add', args: { value: '2026-03-01T00:00:00Z', days: 1 } },
  { name: 'encode.base64', args: { text: 'abc' } },
  { name: 'encode.hex', args: { text: 'abc' } },
  { name: 'encode.url', args: { text: 'a b' } },
  { name: 'encode.hash', args: { text: 'abc' } },
  { name: 'encode.uuid', args: { count: 2 } },
  /* Read-only fixtures added for the 8.0 audit. Every entry executes the real
     tool against the temporary workspace; none of them can reach the network,
     install software or change a user file outside that workspace. */
  { name: 'ai.agents', args: {} },
  { name: 'ai.models', args: {} },
  { name: 'ai.status', args: {} },
  { name: 'ai.tools', args: {} },
  { name: 'models.route', args: { task: 'coding' } },
  { name: 'automation.list', args: {} },
  { name: 'automation.stats', args: {} },
  { name: 'code.dependencies', args: { path: 'audit-sample.js' } },
  { name: 'code.duplicates', args: { path: '.', minLines: 3 } },
  { name: 'code.file.summary', args: { path: 'audit-sample.js' } },
  { name: 'code.function', args: { path: 'audit-sample.js', name: 'add' } },
  { name: 'code.project.map', args: { path: '.' } },
  { name: 'code.stats', args: { path: '.' } },
  { name: 'code.symbols', args: { path: 'audit-sample.js' } },
  { name: 'code.todo', args: { path: '.' } },
  { name: 'repo.impact', args: { file: 'audit-sample.js' } },
  { name: 'repo.search', args: { query: 'add' } },
  { name: 'dev.lint.syntax', args: { path: 'audit-sample.js' } },
  { name: 'dev.scripts', args: {} },
  { name: 'dev.versions', args: {} },
  { name: 'project.roots', args: {} },
  { name: 'doc.csv.stats', args: { path: 'audit-sample.csv' } },
  { name: 'doc.encoding.detect', args: { path: 'audit-sample.txt' } },
  { name: 'doc.json.query', args: { path: 'audit-sample.json', query: 'a' } },
  { name: 'doc.log.analyze', args: { text: '2026-01-01 INFO start\n2026-01-01 ERROR boom\n' } },
  { name: 'doc.log.tail', args: { path: 'audit-sample.log', lines: 5 } },
  { name: 'doc.markdown.toc', args: { path: 'audit-sample.md' } },
  { name: 'doc.read', args: { path: 'audit-sample.txt' } },
  { name: 'fs.diff', args: { a: 'audit-sample.txt', b: 'audit-sample.txt' } },
  { name: 'fs.hash', args: { path: 'audit-sample.txt' } },
  { name: 'fs.read', args: { path: 'audit-sample.txt' } },
  { name: 'fs.recent', args: { path: '.', hours: 24 } },
  { name: 'fs.search', args: { pattern: 'sample', path: '.' } },
  { name: 'fs.stat', args: { path: 'audit-sample.txt' } },
  { name: 'fs.tree', args: { path: '.', depth: 2 } },
  { name: 'finance.break_even', args: { fixedCosts: 1000, price: 20, variableCost: 5 } },
  { name: 'finance.compound', args: { principal: 1000, annualRate: 5, years: 3 } },
  { name: 'finance.loan_payment', args: { principal: 100000, annualRate: 6, months: 120 } },
  { name: 'finance.roi', args: { gain: 1200, cost: 1000 } },
  { name: 'graph.query', args: { query: 'sentinel' } },
  { name: 'kb.coverage', args: {} },
  { name: 'kb.search', args: { query: 'sentinel' } },
  { name: 'kb.stale', args: {} },
  { name: 'kb.symbols', args: { query: 'add' } },
  { name: 'reranker.rerank', args: { query: 'test', candidates: ['a test', 'unrelated'] } },
  { name: 'lab.classify', args: { text: 'pokaż status komputera' } },
  { name: 'lab.sentiment', args: { text: 'to jest świetne' } },
  { name: 'specialists.similarity', args: { query: 'alpha beta', passage: 'alpha beta gamma' } },
  { name: 'specialists.predict', args: { task: 'complexity', text: 'zaplanuj projekt' } },
  { name: 'training.status', args: {} },
  { name: 'training.adapters', args: {} },
  { name: 'training.queue', args: {} },
  { name: 'training.dataset_list', args: {} },
  { name: 'math.base', args: { value: 'ff', from: 'hex' } },
  { name: 'math.convert', args: { value: 1000, from: 'm', to: 'km' } },
  { name: 'math.factor', args: { number: 360 } },
  { name: 'math.gcd', args: { numbers: [12, 18] } },
  { name: 'math.matrix', args: { action: 'multiply', a: [[1, 2], [3, 4]], b: [[1, 0], [0, 1]] } },
  { name: 'math.sequence', args: { values: [1, 4, 9, 16] } },
  { name: 'math.stats', args: { values: [1, 2, 3, 4] } },
  { name: 'mcp.list_tools', args: {} },
  { name: 'memory.conflicts', args: {} },
  { name: 'memory.integrity', args: {} },
  { name: 'memory.list', args: {} },
  { name: 'memory.recall', args: { query: 'sentinel' } },
  { name: 'mobile.pairing', args: {} },
  { name: 'mobile.sessions', args: {} },
  { name: 'net.interfaces', args: {} },
  { name: 'net.ports', args: {} },
  { name: 'net.route', args: {} },
  { name: 'executive.status', args: {} },
  { name: 'executive.jobs', args: {} },
  { name: 'perf.metrics', args: {} },
  { name: 'calendar.countdown', args: { now: '2026-01-01T00:00:00Z', deadline: '2026-01-10T00:00:00Z' } },
  { name: 'docs.reading_time', args: { words: 900 } },
  { name: 'meeting.agenda', args: { start: '2026-01-01T10:00:00Z', items: [{ title: 'one', minutes: 15 }] } },
  { name: 'notes.checklist', args: { markdown: '- [x] done\n- [ ] open' } },
  { name: 'notes.outline', args: { markdown: '# Title\n## Section' } },
  { name: 'planning.free_slots', args: { start: '2026-01-01T08:00:00Z', end: '2026-01-01T18:00:00Z' } },
  { name: 'planning.pomodoro', args: { minutes: 120 } },
  { name: 'planning.priority_matrix', args: { tasks: [{ title: 'a', urgency: 3, importance: 2 }] } },
  { name: 'planning.progress', args: { items: [{ done: 2, total: 5 }] } },
  { name: 'coding.index', args: {} },
  { name: 'coding.search', args: { query: 'add' } },
  { name: 'coding.bugs', args: { limit: 5 } },
  { name: 'coding.callgraph', args: {} },
  { name: 'coding.impact', args: { file: 'audit-sample.js' } },
  { name: 'coding.references', args: { symbol: 'add' } },
  { name: 'coding.rename', args: { symbol: 'add', to: 'sum' } },
  { name: 'coding.test_proposals', args: { limit: 3 } },
  { name: 'science.combinations', args: { n: 5, k: 2 } },
  { name: 'science.data_convert', args: { value: 1, from: 'MB', to: 'GB' } },
  { name: 'science.density', args: { mass: 10, volume: 2 } },
  { name: 'science.dilution', args: { c1: 2, v1: 1, c2: 1 } },
  { name: 'science.energy_convert', args: { value: 1, from: 'kWh', to: 'J' } },
  { name: 'science.half_life', args: { initial: 100, halfLife: 5, elapsed: 10 } },
  { name: 'science.ideal_gas', args: { p: 101325, v: 0.024, n: 1, t: 293.15, solve: 'v' } },
  { name: 'science.mass_convert', args: { value: 1, from: 'kg', to: 'g' } },
  { name: 'science.matrix_multiply', args: { a: [[1, 2], [3, 4]], b: [[1, 0], [0, 1]] } },
  { name: 'science.molarity', args: { moles: 0.5, volumeL: 2 } },
  { name: 'science.ohms_law', args: { voltage: 12, resistance: 4 } },
  { name: 'science.percentage_change', args: { oldValue: 100, newValue: 125 } },
  { name: 'science.ph', args: { concentration: 0.001 } },
  { name: 'science.pressure_convert', args: { value: 1, from: 'atm', to: 'kPa' } },
  { name: 'science.projectile_range', args: { speed: 20, angleDeg: 45 } },
  { name: 'science.significant_figures', args: { value: 12.3456, figures: 3 } },
  { name: 'science.speed_convert', args: { value: 36, from: 'km/h', to: 'm/s' } },
  { name: 'science.speed_distance_time', args: { distance: 100, time: 10 } },
  { name: 'science.vector_dot', args: { a: [1, 2, 3], b: [4, 5, 6] } },
  { name: 'security.audit', args: { limit: 5 } },
  { name: 'security.path.check', args: { path: 'audit-sample.txt' } },
  { name: 'security.scan', args: { text: 'password=secret123' } },
  { name: 'security.status', args: {} },
  { name: 'cpu.info', args: {} },
  { name: 'disk.usage', args: { path: '.' } },
  { name: 'disk.volumes', args: {} },
  { name: 'memory.status', args: {} },
  { name: 'process.list', args: { limit: 5 } },
  { name: 'screen.info', args: {} },
  { name: 'time.now', args: {} },
  { name: 'vision.status', args: {} },
  { name: 'voice.status', args: {} },
  { name: 'voice.voices', args: {} },
  { name: 'battery.status', args: {} },
  { name: 'env.get', args: { name: 'PATH' } },
  { name: 'eventlog.read', args: { limit: 2 } },
  { name: 'gpu.info', args: {} },
  { name: 'hotfix.list', args: { limit: 2 } },
  { name: 'installed.apps', args: { limit: 5 } },
  { name: 'process.find', args: { name: 'node' } },
  { name: 'process.top', args: {} },
  { name: 'service.list', args: { limit: 5 } },
  { name: 'startup.list', args: {} },
  { name: 'sensors.temps', args: {} },
  { name: 'windows.list', args: {} },
  { name: 'net.connections', args: { limit: 5 } },
  { name: 'net.wifi', args: {} },
  { name: 'tunnel.status', args: {} },
  { name: 'specialists.context_importance', args: { query: 'alpha', chunk: 'alpha beta gamma' } },
  { name: 'specialists.failure_risk', args: { permission: 'read' } },
  { name: 'app.list', args: {} },
  { name: 'macro.list', args: {} },
];

function findId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  for (const key of ['id', 'trashId', 'taskId']) if (typeof value[key] === 'string') return value[key];
  for (const child of Object.values(value)) {
    const found = findId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Reversible fixture flows. Each call runs the real tool against the temporary
 * SENTINEL_HOME workspace; no call reaches outside it or performs an external
 * action. Results feed the same executed list as the static calls.
 */
async function runFlows(agent, record, workspace) {
  const exec = async (name, args = {}) => {
    const tool = agent.tools.get(name);
    if (!tool) { record({ tool: name, ok: false, code: 'MISSING', message: 'not registered' }); return null; }
    // eslint-disable-next-line no-await-in-loop
    const result = await agent.tools.execute(name, args, { source: 'audit-flow' });
    record({ tool: name, ok: Boolean(result.ok), code: result.code || null, ms: result.ms || null, message: result.message ? String(result.message).slice(0, 200) : null });
    return result.ok ? result : null;
  };
  const fsPath = (name) => `audit-flow/${name}`;

  await exec('fs.mkdir', { path: 'audit-flow' });
  await exec('fs.write', { path: fsPath('one.txt'), content: 'alpha beta\n', overwrite: true });
  await exec('fs.append', { path: fsPath('one.txt'), content: 'gamma\n' });
  await exec('fs.read', { path: fsPath('one.txt') });
  await exec('fs.replace', { path: fsPath('one.txt'), find: 'alpha', replace: 'ALPHA', all: true });
  await exec('fs.copy', { from: fsPath('one.txt'), to: fsPath('copy.txt'), overwrite: true });
  await exec('fs.move', { from: fsPath('copy.txt'), to: fsPath('moved.txt') });
  const deleted = await exec('fs.delete', { path: fsPath('moved.txt') });
  await exec('fs.trash.list');
  const trashId = deleted ? findId(deleted.data) : null;
  if (trashId) await exec('fs.restore', { trashId, to: fsPath('moved.txt') });

  const task = await exec('task.create', { title: 'Audit fixture task', goal: 'Exercise task lifecycle', steps: [{ title: 'step one' }] });
  const taskId = task ? findId(task.data) : null;
  if (taskId) {
    await exec('task.get', { id: taskId });
    await exec('task.cancel', { id: taskId });
    await exec('task.verify', { id: taskId });
  }

  const memory = await exec('memory.remember', { text: 'Audit fixture memory alpha beta', kind: 'semantic', tags: ['audit'] });
  const memoryId = memory ? findId(memory.data) : null;
  if (memoryId) {
    await exec('memory.history', { id: memoryId });
    await exec('memory.export', { path: fsPath('memory.json') });
    await exec('memory.forget', { id: memoryId });
    await exec('memory.import', { path: fsPath('memory.json') });
  }

  await exec('calendar.add', { summary: 'Audit fixture event', start: '2026-01-02T10:00:00Z', durationMinutes: 15 });
  await exec('calendar.import_ics', { ics: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:audit-1\nDTSTART:20260103T100000Z\nSUMMARY:Audit ICS\nEND:VEVENT\nEND:VCALENDAR\n' });

  const automation = await exec('automation.create', { name: 'audit-noop', type: 'interval', action: 'prompt', everyMinutes: 1440, prompt: 'audit fixture', enabled: false });
  const automationId = automation ? findId(automation.data) : null;
  if (automationId) {
    await exec('automation.toggle', { id: automationId, enabled: false });
    await exec('automation.delete', { id: automationId });
  }

  await exec('graph.add', { type: 'project', label: 'Audit Project', props: { source: 'fixture' } });
  await exec('graph.add', { type: 'file', label: 'audit-flow/one.txt' });
  await exec('graph.link', { from: 'Audit Project', to: 'audit-flow/one.txt', relation: 'contains' });
  await exec('graph.neighbours', { node: 'Audit Project', depth: 1 });
  await exec('graph.path', { from: 'Audit Project', to: 'audit-flow/one.txt' });
  await exec('graph.sync', {});

  const patch = await exec('patch.propose', { path: 'audit-sample.js', text: "'use strict';\n// AUDIT FLOW MARKER\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n", reason: 'audit fixture' });
  const patchId = patch ? findId(patch.data) : null;
  if (patchId) {
    await exec('patch.diff', { id: patchId });
    await exec('patch.verify', { id: patchId });
    await exec('patch.list', {});
    await exec('patch.discard', { id: patchId });
  }

  await exec('coding.verify', { symbol: 'add', to: 'sum' });
  await exec('healing.diagnose', { quick: true });
  await exec('healing.backups', {});
  await exec('healing.propose', { problem: 'audit fixture: no real problem' });
  await exec('perf.gaming', { enabled: false });
  await exec('perf.maintenance', { pruneDays: 30, compact: false });
  await exec('reason.diagnose', { question: 'Is the audit fixture healthy?', signals: [{ name: 'audit', value: true, source: 'audit' }] });
  await exec('hypercore.add_goal', { description: 'Audit fixture goal', priority: 0.5 });
  await exec('hypercore.observe', { statement: 'audit fixture observation', source: 'audit' });
  await exec('hypercore.deduce', { maxIterations: 2 });
  await exec('hypercore.hypothesize', { statement: 'audit fixture hypothesis', predicts: ['audit observation'] });
  await exec('proactive.add_rule', { name: 'audit rule', event: 'task.completed', channels: ['desktop'] });
  await exec('proactive.evaluate', { event: { type: 'task.completed', payload: {} } });
  await exec('security.stop', {});
  await exec('training.dataset_create', { name: 'audit-set', rows: [{ text: 'alpha sample', label: 'alpha' }, { text: 'beta sample', label: 'beta' }] });
  await exec('training.dataset_split', { name: 'audit-set', seed: 7 });
  // Deliberately not executed: fs.zip.*, provider calls, long training, process
  // control, desktop input, installer and anything with external side effects.
  return workspace;
}

async function main() {
  const noWrite = process.argv.includes('--no-write');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-audit-'));
  process.env.SENTINEL_HOME = home;
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // Safe fixtures. These are the only files the audit tools may touch.
  fs.writeFileSync(path.join(workspace, 'audit-sample.js'), "'use strict';\n// TODO: demonstrate a real symbol\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(workspace, 'audit-sample.json'), JSON.stringify({ a: 1, nested: { b: 2 } }));
  fs.writeFileSync(path.join(workspace, 'audit-sample.csv'), 'name,value\nalpha,1\nbeta,2\n');
  fs.writeFileSync(path.join(workspace, 'audit-sample.md'), '# Audit sample\n\n## Section\n\nText.\n');
  fs.writeFileSync(path.join(workspace, 'audit-sample.log'), '2026-01-01 INFO start\n2026-01-01 ERROR boom\n');
  fs.writeFileSync(path.join(workspace, 'audit-sample.txt'), 'sample text for the audit\n');
  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'nested', 'child.txt'), 'child\n');
  const agent = new Agent();
  // Extended deterministic packs ship an executable example. Running that
  // example is a real call, not a structural check, and keeps the audit honest
  // about the difference between registered and verified.
  for (const tool of agent.tools.list()) {
    if (!EXTENDED_PURE.has(tool.name.split('.')[0])) continue;
    const full = agent.tools.get(tool.name);
    const example = full && (full.examples || [])[0];
    if (example && example.args) SAFE_CALLS.push({ name: tool.name, args: example.args });
  }
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
    const record = (entry) => executed.push(entry);
    for (const call of SAFE_CALLS) {
      const tool = agent.tools.get(call.name);
      if (!tool) {
        record({ tool: call.name, ok: false, code: 'MISSING', message: 'not registered' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await agent.tools.execute(call.name, call.args, { source: 'audit' });
      record({ tool: call.name, ok: Boolean(result.ok), code: result.code || null, ms: result.ms || null, message: result.message ? String(result.message).slice(0, 200) : null });
    }
    await runFlows(agent, record, workspace);
    const verifiedTools = new Set(executed.filter((entry) => entry.ok).map((entry) => entry.tool));
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
        verified: verifiedTools.size,
        failed: executed.filter((entry) => !entry.ok).length,
        results: executed,
        note: 'Only these tools were executed. Every other tool is unverified, not "verified". A tool with several successful fixture calls is counted once.',
      },
      unexecuted: structural.total - verifiedTools.size,
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
    return structural.problems.length || executed.some((entry) => !entry.ok) ? 1 : 0;
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
