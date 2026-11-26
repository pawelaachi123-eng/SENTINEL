#!/usr/bin/env node
'use strict';

/**
 * Blackboard semantics: typed state, provenance, scope isolation, attention,
 * contradictions, budgets, persistence and honesty about omissions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Blackboard } = require('../core/cognition/blackboard');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-board-'));
const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

(async () => {
  let clock = 1_700_000_000_000;
  const board = new Blackboard({ dataDir: dir, now: () => clock, persistDebounceMs: 0 });

  await check('an entry carries type, scope, provenance, owner and revision history', () => {
    const entry = board.add({ type: 'fact', content: 'Atlas orbit is 12 days', scope: 'session:s1', provenance: [{ source: 'user', ref: 'turn-1' }], owner: { sessionId: 's1', runId: 'r1' }, confidence: 0.9, status: 'proven', tags: ['atlas'] });
    assert.equal(entry.type, 'fact');
    assert.equal(entry.confidence, 0.9);
    assert.equal(entry.provenance[0].source, 'user');
    assert.equal(entry.owner.runId, 'r1');
    assert.equal(entry.history[0].action, 'created');
    assert.ok(entry.id.startsWith('bb_'));
    return entry;
  });

  await check('unknown types, scopes and confidences are refused', () => {
    assert.throws(() => board.add({ type: 'vibe', content: 'x' }), /unknown blackboard type/);
    assert.throws(() => board.add({ type: 'fact', content: 'x', scope: 'other:1' }), /invalid blackboard scope/);
    assert.throws(() => board.add({ type: 'fact', content: 'x', confidence: 1.4 }), /confidence/);
  });

  await check('session scopes are isolated while global facts remain visible', () => {
    board.add({ type: 'preference', content: 'Answer in Polish', scope: 'global', status: 'proven' });
    board.add({ type: 'fact', content: 'session one secret', scope: 'session:s1' });
    board.add({ type: 'fact', content: 'session two secret', scope: 'session:s2' });
    const one = board.query({ scope: 'session:s1', text: 'secret' }).map((entry) => entry.content);
    assert.deepEqual(one, ['session one secret']);
    const two = board.query({ scope: 'session:s2', text: 'secret' }).map((entry) => entry.content);
    assert.deepEqual(two, ['session two secret']);
    const isolated = board.query({ scope: 'session:s2', includeGlobal: false, text: 'Polish' });
    assert.equal(isolated.length, 0);
    const global = board.query({ scope: 'session:s2', text: 'Polish' });
    assert.equal(global.length, 1);
  });

  await check('re-adding identical content merges and increments the revision', () => {
    const first = board.add({ type: 'goal', key: 'plan', content: 'ship 9.0', scope: 'session:s1' });
    const second = board.add({ type: 'goal', key: 'plan', content: 'ship 9.0', scope: 'session:s1' });
    assert.equal(second.id, first.id);
    assert.equal(second.revision, 2);
    assert.equal(second.history.length, 2);
  });

  await check('changed keyed content creates a contradiction instead of overwriting', () => {
    const first = board.add({ type: 'belief', key: 'orbit', content: 'Atlas orbit is 12 days', scope: 'session:s1' });
    const second = board.add({ type: 'belief', key: 'orbit', content: 'Atlas orbit is 14 days', scope: 'session:s1' });
    assert.notEqual(second.id, first.id);
    assert.ok(second.contradicts.includes(first.id));
    const pair = board.conflicts({ scope: 'session:s1' }).find((entry) => entry.a.id === first.id || entry.b.id === first.id);
    assert.ok(pair && !pair.resolved);
    board.resolve({ winnerId: second.id, loserId: first.id, reason: 'new measurement', actor: 'test' });
    assert.equal(board.get(first.id).status, 'contradicted');
    const after = board.conflicts({ scope: 'session:s1' }).find((entry) => entry.a.id === first.id || entry.b.id === first.id);
    assert.equal(after.resolved, true);
  });

  await check('explicit update changes confidence and keeps a bounded history', () => {
    const entry = board.add({ type: 'hypothesis', content: 'The disk is full', scope: 'session:s1', confidence: 0.4, status: 'unsupported' });
    const updated = board.update(entry.id, { confidence: 0.8, status: 'supported', provenance: [{ source: 'df', ref: 'output' }], reason: 'df agrees' });
    assert.equal(updated.confidence, 0.8);
    assert.equal(updated.status, 'supported');
    assert.equal(updated.revision, 2);
    assert.ok(updated.provenance.some((item) => item.source === 'df'));
    assert.match(updated.history.at(-1).reason, /df agrees/);
  });

  await check('retraction removes an entry from attention without deleting its history', () => {
    const entry = board.add({ type: 'belief', content: 'A false claim', scope: 'session:s1', status: 'proven' });
    const retracted = board.retract(entry.id, { reason: 'wrong', actor: 'test' });
    assert.equal(retracted.status, 'retracted');
    assert.equal(retracted.confidence, 0);
    assert.equal(board.focus({ scope: 'session:s1', goal: 'false claim' }).selected.some((item) => item.id === entry.id), false);
    assert.ok(board.get(entry.id).history.some((item) => item.action === 'retracted'));
  });

  await check('attention decays with age and rises with goal relevance', () => {
    const old = board.add({ type: 'fact', content: 'Old unrelated note about weather', scope: 'session:att', salience: 0.5, confidence: 1, status: 'proven' });
    clock += 12 * 60 * 60 * 1000;
    const fresh = board.add({ type: 'fact', content: 'Atlas orbit measured at twelve days', scope: 'session:att', salience: 0.5, confidence: 1, status: 'proven' });
    const focused = board.focus({ scope: 'session:att', goal: 'Atlas orbit', tokens: 500 });
    assert.equal(focused.selected[0].id, fresh.id);
    const oldScore = board.attention(board.get(old.id), { goal: 'Atlas orbit', now: clock });
    const freshScore = board.attention(board.get(fresh.id), { goal: 'Atlas orbit', now: clock });
    assert.ok(freshScore > oldScore);
  });

  await check('focus enforces its character budget and reports omissions', () => {
    const scope = 'session:budget';
    for (let index = 0; index < 20; index += 1) {
      board.add({ type: 'evidence', content: `evidence line ${index} ${'x'.repeat(60)}`, scope, confidence: 1, status: 'proven', salience: 1 });
    }
    const focused = board.focus({ scope, goal: 'evidence line', tokens: 120 });
    assert.ok(focused.characters <= 120 * 4, `${focused.characters} characters`);
    assert.ok(focused.selected.length > 0);
    assert.ok(focused.omitted > 0);
    assert.ok(focused.estimatedTokens <= 120);
  });

  await check('query filters types, tags, status and text', () => {
    const scope = 'session:query';
    board.add({ type: 'result', content: 'tool ok', scope, tags: ['tool'], status: 'proven', confidence: 1 });
    board.add({ type: 'error', content: 'tool failed', scope, tags: ['tool'], status: 'unsupported', confidence: 0.2 });
    board.add({ type: 'fact', content: 'unrelated', scope, tags: ['misc'], status: 'supported' });
    assert.equal(board.query({ scope, types: 'error' }).length, 1);
    assert.equal(board.query({ scope, tags: ['tool'] }).length, 2);
    assert.equal(board.query({ scope, status: 'proven', includeGlobal: false }).length, 1);
    assert.equal(board.query({ scope, text: 'failed' }).length, 1);
    assert.equal(board.query({ scope, minConfidence: 0.8 }).length, 1);
  });

  await check('expired entries disappear from reads and can be pruned', () => {
    const scope = 'session:ttl';
    const entry = board.add({ type: 'observation', content: 'short lived', scope, ttlMs: 1000 });
    assert.ok(board.get(entry.id));
    clock += 2000;
    assert.equal(board.get(entry.id), null);
    assert.equal(board.query({ scope, text: 'short lived' }).length, 0);
    const pruned = board.prune({ now: clock });
    assert.ok(pruned.removed >= 1);
  });

  await check('subscribers see mutations with the entry that changed', () => {
    const events = [];
    const unsubscribe = board.subscribe((event) => events.push(event));
    const entry = board.add({ type: 'task', content: 'observe me', scope: 'session:events' });
    board.update(entry.id, { confidence: 0.9 });
    unsubscribe();
    board.add({ type: 'task', content: 'not observed', scope: 'session:events' });
    assert.deepEqual(events.map((event) => event.action), ['added', 'updated']);
    assert.equal(events[1].entry.id, entry.id);
  });

  await check('capacity eviction keeps high-attention entries and reports evictions', () => {
    const small = new Blackboard({ now: () => clock, maxEntries: 50 });
    for (let index = 0; index < 45; index += 1) small.add({ type: 'fact', content: `filler ${index}`, scope: 'global', salience: 0.1, confidence: 0.5 });
    const important = small.add({ type: 'fact', content: 'critical fact', scope: 'global', salience: 1, confidence: 1, status: 'proven' });
    for (let index = 0; index < 15; index += 1) small.add({ type: 'fact', content: `later ${index}`, scope: 'global', salience: 0.1, confidence: 0.5 });
    assert.ok(small.stats().total <= 50);
    assert.ok(small.stats().counters.evicted > 0);
    assert.ok(small.get(important.id));
  });

  await check('stats separate types, statuses and unresolved conflicts', () => {
    const stats = board.stats('session:s1');
    assert.ok(stats.entries > 0);
    assert.ok(stats.byType.fact >= 1);
    assert.ok(stats.byStatus.contradicted >= 1);
    assert.ok(stats.counters.added > 0);
    assert.equal(stats.persisted, true);
  });

  await check('persistence round-trips entries, provenance and history', async () => {
    await board.persist();
    const restored = new Blackboard({ dataDir: dir, now: () => clock });
    assert.equal(restored.stats().total, board.stats().total);
    const source = board.query({ scope: 'session:s1', text: 'Atlas orbit is 12 days' })[0];
    const copy = restored.get(source.id);
    assert.equal(copy.content, source.content);
    assert.equal(copy.provenance[0].source, source.provenance[0].source);
    assert.equal(copy.revision, source.revision);
  });

  await check('a corrupt persisted board is reported, not silently replaced', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-board-bad-'));
    fs.writeFileSync(path.join(corruptDir, 'blackboard.json'), '{not json');
    const warnings = [];
    const broken = new Blackboard({ dataDir: corruptDir, log: { warn: (...args) => warnings.push(args.join(' ')) } });
    assert.equal(broken.stats().total, 0);
    assert.match(broken.lastError, /JSON|Unexpected/);
    assert.equal(warnings.length, 1);
  });

  await check('clear removes only the requested scope', () => {
    board.add({ type: 'fact', content: 'remove me', scope: 'session:clear' });
    board.add({ type: 'fact', content: 'keep me', scope: 'session:keep' });
    const cleared = board.clear({ scope: 'session:clear' });
    assert.ok(cleared.removed >= 1);
    assert.equal(board.query({ scope: 'session:clear', text: 'remove me' }).length, 0);
    assert.equal(board.query({ scope: 'session:keep', text: 'keep me' }).length, 1);
  });

  await check('concurrent writers serialize persistence without losing entries', async () => {
    const concurrent = new Blackboard({ dataDir: path.join(dir, 'concurrent'), now: () => clock, persistDebounceMs: 0 });
    await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve(concurrent.add({ type: 'fact', content: `parallel ${index}`, scope: 'global' }))));
    await Promise.all([concurrent.persist(), concurrent.persist(), concurrent.persist()]);
    const reloaded = new Blackboard({ dataDir: path.join(dir, 'concurrent'), now: () => clock });
    assert.equal(reloaded.stats().total, 20);
  });

  await board.close();
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`\n${checks.length - failed} of ${checks.length} blackboard checks passed.`);
  if (failed) process.exitCode = 1;
})();
