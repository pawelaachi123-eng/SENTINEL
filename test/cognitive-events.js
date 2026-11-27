#!/usr/bin/env node
'use strict';

/**
 * Typed cognitive events and goal arbitration.
 *
 * The event bus observes the real blackboard, so these tests use a real board.
 * They check bounded retention, scope isolation, provenance and the arbiter's
 * dependency rules rather than only its sort order.
 */

const assert = require('node:assert');
const { Blackboard } = require('../core/cognition/blackboard');
const { CognitiveEventBus, GoalArbiter } = require('../core/cognition/events');

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

let clock = 1000000;
const now = () => clock;

check('a blackboard write becomes a typed event with provenance', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now });
  const entry = board.add({
    type: 'fact',
    scope: 'session:events',
    content: 'the disk has 40 GB free',
    provenance: [{ source: 'disk.stat', ref: 'df' }],
    confidence: 0.9,
    status: 'proven',
  });
  const events = bus.query({ scope: 'session:events' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'blackboard.added');
  assert.equal(events[0].entryId, entry.id);
  assert.equal(events[0].entryType, 'fact');
  assert.equal(events[0].provenance[0].source, 'disk.stat');
  assert.equal(events[0].confidence, 0.9);
  bus.close();
});

check('updates, retractions and removals are distinct event types', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now });
  const entry = board.add({ type: 'belief', scope: 'session:kinds', content: 'a', confidence: 0.5 });
  board.update(entry.id, { confidence: 0.8 });
  board.retract(entry.id, { reason: 'test' });
  board.remove(entry.id);
  const types = bus.query({ scope: 'session:kinds' }).map((event) => event.type);
  assert.deepEqual(types, ['blackboard.added', 'blackboard.updated', 'blackboard.retracted', 'blackboard.removed']);
  bus.close();
});

check('scopes do not leak into each other', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now });
  board.add({ type: 'fact', scope: 'session:a', content: 'A' });
  board.add({ type: 'fact', scope: 'session:b', content: 'B' });
  assert.equal(bus.query({ scope: 'session:a' }).length, 1);
  assert.equal(bus.query({ scope: 'session:b' })[0].summary, 'B');
  assert.equal(bus.query({ scope: 'session:c' }).length, 0);
  bus.close();
});

check('retention is bounded and dropped events are counted', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now, limit: 50, perScopeLimit: 20 });
  for (let index = 0; index < 30; index += 1) board.add({ type: 'fact', scope: 'session:bounded', content: `fact ${index}` });
  const stats = bus.stats('session:bounded');
  assert.equal(stats.buffered, 20);
  assert.ok(stats.totalBuffered <= 50);
  assert.equal(stats.dropped, 10);
  assert.equal(stats.bounded, true);
  bus.close();
});

check('queries filter by type, entry type and time', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now });
  board.add({ type: 'fact', scope: 'session:filter', content: 'f1' });
  clock += 10;
  board.add({ type: 'goal', scope: 'session:filter', content: 'g1' });
  clock += 10;
  const goals = bus.query({ scope: 'session:filter', type: 'blackboard.added', entryType: 'goal' });
  assert.equal(goals.length, 1);
  assert.equal(goals[0].summary, 'g1');
  const recent = bus.query({ scope: 'session:filter', since: 1000005 });
  assert.equal(recent.length, 1);
  bus.close();
});

check('a throwing listener cannot break state capture', () => {
  const board = new Blackboard({ now });
  const bus = new CognitiveEventBus({ board, now });
  let called = 0;
  bus.subscribe(() => { called += 1; throw new Error('ui broke'); });
  bus.subscribe(() => { called += 1; });
  board.add({ type: 'fact', scope: 'session:listener', content: 'still recorded' });
  assert.equal(called, 2);
  assert.equal(bus.query({ scope: 'session:listener' }).length, 1);
  bus.close();
});

check('an unknown event type is rejected', () => {
  const bus = new CognitiveEventBus({});
  assert.throws(() => bus.publish({ type: 'made.up' }), (err) => err.code === 'BAD_EVENT_TYPE');
  bus.close();
});

check('goal arbitration prefers the higher-priority ready goal', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'low', description: 'low work', priority: 0.2 });
  arbiter.submit({ id: 'high', description: 'high work', priority: 0.9 });
  const result = arbiter.arbitrate();
  assert.equal(result.next, 'high');
  assert.equal(result.ranking.length, 2);
  assert.ok(result.ranking[0].score > result.ranking[1].score);
  return `${result.next} at ${result.ranking[0].score}`;
});

check('deadline pressure changes the ranking', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'later', description: 'later', priority: 0.6, deadline: clock + 3600000, estimatedMs: 3600000 });
  arbiter.submit({ id: 'urgent', description: 'urgent', priority: 0.5, deadline: clock + 1000, estimatedMs: 3600000 });
  const result = arbiter.arbitrate();
  assert.equal(result.next, 'urgent');
});

check('a dependent goal is blocked, never activated', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'parent', description: 'parent work', priority: 0.4 });
  arbiter.submit({ id: 'child', description: 'child work', priority: 0.9, dependencies: ['parent'] });
  const result = arbiter.arbitrate();
  assert.equal(result.next, 'parent');
  assert.equal(result.blocked.length, 1);
  assert.deepEqual(result.blocked[0].unmet, ['parent']);
});

check('completing a dependency unblocks its child', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'parent', description: 'parent', priority: 0.4 });
  arbiter.submit({ id: 'child', description: 'child', priority: 0.9, dependencies: ['parent'] });
  arbiter.complete('parent');
  const result = arbiter.arbitrate();
  assert.equal(result.next, 'child');
  assert.equal(result.blocked.length, 0);
});

check('activation order respects a dependency chain', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'c', description: 'third', dependencies: ['b'] });
  arbiter.submit({ id: 'a', description: 'first' });
  arbiter.submit({ id: 'b', description: 'second', dependencies: ['a'] });
  const order = arbiter.activationOrder();
  assert.deepEqual(order.order.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(order.complete, true);
});

check('a dependency cycle is reported rather than looped forever', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'a', description: 'a', dependencies: ['b'] });
  arbiter.submit({ id: 'b', description: 'b', dependencies: ['a'] });
  const order = arbiter.activationOrder();
  assert.equal(order.complete, false);
  assert.equal(order.order.length, 0);
  assert.equal(order.blocked.length, 2);
});

check('waiting increases a goal score but is capped', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'old', description: 'waiting', priority: 0.1 });
  const fresh = arbiter.arbitrate().ranking[0].score;
  clock += 24 * 60 * 60 * 1000;
  const aged = arbiter.arbitrate().ranking[0].score;
  assert.ok(aged > fresh);
  assert.ok(aged - fresh <= 0.25);
});

check('goal state can be snapshotted and restored', () => {
  const arbiter = new GoalArbiter({ now });
  arbiter.submit({ id: 'persisted', description: 'keep me', priority: 0.7 });
  arbiter.complete('persisted');
  const snapshot = arbiter.snapshot();
  const restored = new GoalArbiter({ now });
  assert.equal(restored.restore(snapshot), 1);
  assert.equal(restored.get('persisted').status, 'done');
});

check('invalid priorities and duplicate goals are rejected', () => {
  const arbiter = new GoalArbiter({ now });
  assert.throws(() => arbiter.submit({ id: 'x', description: 'x', priority: 2 }), (err) => err.code === 'BAD_PRIORITY');
  arbiter.submit({ id: 'x', description: 'x' });
  assert.throws(() => arbiter.submit({ id: 'x', description: 'again' }), (err) => err.code === 'DUPLICATE_GOAL');
});

console.log(`\n${passed} of ${passed + failures.length} cognitive event checks passed.`);
if (failures.length) process.exitCode = 1;
