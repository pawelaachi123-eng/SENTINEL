#!/usr/bin/env node
'use strict';

/**
 * Deterministic property tests.
 *
 * These are not a second copy of the example-based suites. Each property is
 * checked over fixed, seeded random inputs, so a failure is reproducible from
 * the printed seed and shrink value. The generator is intentionally small and
 * dependency-free; the value is in invariants, not in volume.
 */

const assert = require('node:assert/strict');
const { CalendarStore } = require('../core/calendar');
const { UnifiedRetriever, percentile } = require('../core/retrieval/unified');

let passed = 0;
const failures = [];

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function int(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}

const alphabet = 'abcĄĆĘŁŃÓŚŹŻ ,;\\\n-0123456789';

function text(random, max = 12) {
  let out = '';
  for (let i = 0, n = int(random, 1, max); i < n; i += 1) out += alphabet[int(random, 0, alphabet.length - 1)];
  return out;
}

check('calendar: every accepted event is finite, ordered and unique', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = rng(seed);
    const store = new CalendarStore({ now: () => 0 });
    for (let i = 0; i < 10; i += 1) {
      const start = int(random, 0, 2_000_000_000);
      const result = store.add({ summary: `event ${i} ${text(random, 4)}`, start, durationMs: int(random, 0, 86_400_000) });
      assert.equal(result.ok, true, `seed ${seed} event ${i}`);
    }
    const events = store.upcoming({ from: 0, to: 3_000_000_000, limit: 100 });
    assert.equal(new Set(events.map((event) => event.id)).size, events.length, `seed ${seed}: duplicate ids`);
    for (let i = 1; i < events.length; i += 1) assert.ok(events[i - 1].start <= events[i].start, `seed ${seed}: unordered`);
    for (const event of events) assert.ok(Number.isFinite(event.start) && Number.isFinite(event.end) && event.end >= event.start, `seed ${seed}: bad interval`);
  }
});

check('calendar: daily recurrence emits exactly COUNT bounded occurrences', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = rng(seed);
    const count = int(random, 1, 12);
    const store = new CalendarStore({ now: () => 0 });
    const start = 1_700_000_000_000 + int(random, 0, 10) * 86_400_000;
    const added = store.add({ summary: 'daily', start, durationMs: 3_600_000, rrule: `FREQ=DAILY;COUNT=${count}` });
    assert.equal(added.ok, true);
    const events = store.upcoming({ from: start, to: start + 40 * 86_400_000, limit: 100 });
    assert.equal(events.length, count, `seed ${seed}: expected ${count}, got ${events.length}`);
    assert.ok(events.every((event) => event.occurrence === (event.start !== start) || count === 1));
  }
});

check('calendar: ICS export/import round-trips summaries and instants', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = rng(seed);
    const source = new CalendarStore({ now: () => 0 });
    const originals = [];
    for (let i = 0; i < 6; i += 1) {
      const summary = text(random, 16).trim() || `e${i}`;
      const start = Math.floor(int(random, 1_700_000_000_000, 1_900_000_000_000) / 1000) * 1000;
      const added = source.add({ summary, start, durationMs: int(random, 0, 7_200_000), description: text(random, 20) });
      if (added.ok) originals.push(added.event);
    }
    const exported = source.exportIcs({ from: 1_600_000_000_000, to: 2_000_000_000_000, limit: 100 });
    const target = new CalendarStore({ now: () => 0 });
    const imported = target.importIcs(exported);
    assert.equal(imported.errors.length, 0, `seed ${seed}: ${JSON.stringify(imported.errors[0])}`);
    for (const original of originals) {
      const match = [...target.events.values()].find((event) => event.uid === original.uid);
      assert.ok(match, `seed ${seed}: missing ${original.uid}`);
      assert.equal(match.start, original.start, `seed ${seed}: instant changed`);
      assert.equal(match.summary, original.summary, `seed ${seed}: summary changed`);
    }
  }
});

check('retrieval: scores stay bounded and result ids stay unique', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = rng(seed);
    const documents = Array.from({ length: 12 }, (_, index) => ({ id: `d${index}`, text: `${text(random, 20)} ${index}`, group: `g${index % 3}` }));
    const retriever = new UnifiedRetriever({ documents });
    const query = text(random, 10).trim() || 'backup';
    const result = retriever.search(query, { limit: 5 });
    assert.equal(result.ok, true, `seed ${seed}: ${result.message || ''}`);
    assert.ok(result.results.length <= 5);
    assert.equal(new Set(result.results.map((row) => row.id)).size, result.results.length, `seed ${seed}: duplicate result`);
    for (const row of result.results) {
      assert.ok(row.score >= 0 && row.score <= 1.0000001, `seed ${seed}: score ${row.score}`);
      assert.ok(Number.isFinite(row.score));
    }
  }
});

check('statistics: percentiles are monotone for arbitrary finite samples', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const random = rng(seed);
    const values = Array.from({ length: int(random, 1, 50) }, () => int(random, -1000, 1000));
    const sorted = [...values].sort((a, b) => a - b);
    let previous = -Infinity;
    for (const p of [0, 5, 25, 50, 75, 95, 100]) {
      const value = percentile(values, p);
      assert.ok(value >= previous, `seed ${seed}: p${p} decreased`);
      assert.ok(value >= sorted[0] && value <= sorted[sorted.length - 1], `seed ${seed}: p${p} outside sample`);
      previous = value;
    }
  }
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} property checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} property checks passed.`);
}
