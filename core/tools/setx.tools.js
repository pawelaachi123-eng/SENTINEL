'use strict';

/** Set operations with JSON-comparable scalar values. */
const ITEMS = { type: 'array', items: {}, maxItems: 100000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => JSON.stringify(data.value).slice(0, 300);

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}

module.exports = [
  { name: 'setx.union', title: 'Set union', description: 'Unique values present in either array, preserving first-seen order.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2], b: [2, 3] }, expect: [1, 2, 3] }], async run(x) { return result(unique([...x.a, ...x.b])); }, format: fmt },
  { name: 'setx.intersection', title: 'Set intersection', description: 'Unique values present in both arrays, ordered by the first array.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2, 3], b: [2, 3, 4] }, expect: [2, 3] }], async run(x) { const keys = new Set(x.b.map((item) => JSON.stringify(item))); return result(unique(x.a.filter((item) => keys.has(JSON.stringify(item))))); }, format: fmt },
  { name: 'setx.difference', title: 'Set difference', description: 'Values in a that are not in b, deduplicated in first-seen order.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2, 3], b: [2] }, expect: [1, 3] }], async run(x) { const keys = new Set(x.b.map((item) => JSON.stringify(item))); return result(unique(x.a.filter((item) => !keys.has(JSON.stringify(item))))); }, format: fmt },
  { name: 'setx.symmetric_difference', title: 'Symmetric difference', description: 'Values in exactly one of the two arrays.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2], b: [2, 3] }, expect: [1, 3] }], async run(x) { const ka = new Set(x.a.map((item) => JSON.stringify(item))); const kb = new Set(x.b.map((item) => JSON.stringify(item))); return result(unique([...x.a.filter((item) => !kb.has(JSON.stringify(item))), ...x.b.filter((item) => !ka.has(JSON.stringify(item)))])); }, format: fmt },
  { name: 'setx.is_subset', title: 'Subset test', description: 'True when every value in a is present in b.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2], b: [1, 2, 3] }, expect: true }], async run(x) { const keys = new Set(x.b.map((item) => JSON.stringify(item))); return result(x.a.every((item) => keys.has(JSON.stringify(item)))); }, format: fmt },
  { name: 'setx.is_disjoint', title: 'Disjoint test', description: 'True when the two arrays share no value.', category: 'math', permission: 'read', tags: ['set', 'logic'],
    parameters: object({ a: ITEMS, b: ITEMS }), examples: [{ args: { a: [1, 2], b: [3, 4] }, expect: true }], async run(x) { const keys = new Set(x.b.map((item) => JSON.stringify(item))); return result(!x.a.some((item) => keys.has(JSON.stringify(item)))); }, format: fmt },
  { name: 'setx.power_set', title: 'Power set', description: 'All subsets of an array, capped at 20 input elements and 1,048,576 subsets.', category: 'math', permission: 'read', tags: ['set', 'combinatorics'],
    parameters: object({ values: { ...ITEMS, maxItems: 20 } }), examples: [{ args: { values: [1, 2] }, expect: [[], [1], [2], [1, 2]] }],
    async run(x) { const base = unique(x.values); const out = []; const total = 2 ** base.length; for (let mask = 0; mask < total; mask += 1) out.push(base.filter((_, index) => mask & (1 << index))); return result(out); }, format: fmt },
  { name: 'setx.cartesian_product', title: 'Cartesian product', description: 'Ordered pairs [a, b] from two arrays, capped at 100,000 pairs.', category: 'math', permission: 'read', tags: ['set', 'combinatorics'],
    parameters: object({ a: { ...ITEMS, maxItems: 1000 }, b: { ...ITEMS, maxItems: 1000 } }), examples: [{ args: { a: [1, 2], b: ['x', 'y'] }, expect: [[1, 'x'], [1, 'y'], [2, 'x'], [2, 'y']] }],
    async run(x) { if (x.a.length * x.b.length > 100000) throw Object.assign(new Error('product exceeds 100000 pairs'), { code: 'TOO_LARGE' }); return result(x.a.flatMap((left) => x.b.map((right) => [left, right]))); }, format: fmt },
];
