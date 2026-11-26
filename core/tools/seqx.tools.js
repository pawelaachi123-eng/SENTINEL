'use strict';

/** Sequences and series, all bounded to avoid unbounded loops. */
const N = { type: 'number' };
const INT = { type: 'integer' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => (Array.isArray(data.value) ? data.value.join(', ') : String(data.value));

function bounded(n, max = 100000) {
  const value = Math.trunc(n);
  if (value < 0 || value > max) throw Object.assign(new Error(`length must be 0..${max}`), { code: 'OUT_OF_RANGE' });
  return value;
}

module.exports = [
  { name: 'seqx.arithmetic_nth', title: 'Arithmetic sequence term', description: 'nth term a + (n−1)d with n counted from 1.', category: 'math', permission: 'read', tags: ['sequence', 'math'],
    parameters: object({ a: N, d: N, n: { ...INT, minimum: 1, maximum: 100000000 } }), examples: [{ args: { a: 2, d: 3, n: 5 }, expect: 14 }],
    async run(x) { return result(x.a + (x.n - 1) * x.d); }, format: fmt },
  { name: 'seqx.arithmetic_sum', title: 'Arithmetic series sum', description: 'Sum of the first n terms of an arithmetic sequence.', category: 'math', permission: 'read', tags: ['sequence', 'series'],
    parameters: object({ a: N, d: N, n: { ...INT, minimum: 0, maximum: 100000000 } }), examples: [{ args: { a: 2, d: 3, n: 5 }, expect: 40 }],
    async run(x) { return result((x.n / 2) * (2 * x.a + (x.n - 1) * x.d)); }, format: fmt },
  { name: 'seqx.geometric_nth', title: 'Geometric sequence term', description: 'nth term a·r^(n−1); non-finite results are rejected.', category: 'math', permission: 'read', tags: ['sequence', 'math'],
    parameters: object({ a: N, r: N, n: { ...INT, minimum: 1, maximum: 10000 } }), examples: [{ args: { a: 2, r: 3, n: 4 }, expect: 54 }],
    async run(x) { const value = x.a * x.r ** (x.n - 1); if (!Number.isFinite(value)) throw Object.assign(new Error('result is not finite'), { code: 'NON_FINITE' }); return result(value); }, format: fmt },
  { name: 'seqx.geometric_sum', title: 'Geometric series sum', description: 'Sum of the first n geometric terms; r=1 uses the linear limit.', category: 'math', permission: 'read', tags: ['sequence', 'series'],
    parameters: object({ a: N, r: N, n: { ...INT, minimum: 0, maximum: 10000 } }), examples: [{ args: { a: 2, r: 3, n: 3 }, expect: 26 }],
    async run(x) { const value = x.r === 1 ? x.a * x.n : (x.a * (1 - x.r ** x.n)) / (1 - x.r); if (!Number.isFinite(value)) throw Object.assign(new Error('result is not finite'), { code: 'NON_FINITE' }); return result(value); }, format: fmt },
  { name: 'seqx.range_list', title: 'Integer range', description: 'Inclusive bounded integer range with an optional non-zero step.', category: 'math', permission: 'read', tags: ['sequence', 'list'],
    parameters: object({ start: INT, end: INT, step: { ...INT, minimum: -100000, maximum: 100000, default: 1 } }), examples: [{ args: { start: 1, end: 5, step: 2 }, expect: [1, 3, 5] }],
    async run(x) { if (x.step === 0) throw Object.assign(new Error('step cannot be zero'), { code: 'BAD_STEP' }); const out = []; if (x.step > 0) for (let i = x.start; i <= x.end && out.length < 100000; i += x.step) out.push(i); else for (let i = x.start; i >= x.end && out.length < 100000; i += x.step) out.push(i); if (out.length >= 100000) throw Object.assign(new Error('range exceeds 100000 items'), { code: 'TOO_LARGE' }); return result(out); }, format: fmt },
  { name: 'seqx.collatz', title: 'Collatz sequence', description: 'Collatz trajectory from a positive integer until 1, capped at 100000 steps.', category: 'math', permission: 'read', tags: ['sequence', 'number-theory'],
    parameters: object({ n: { ...INT, minimum: 1, maximum: 1000000000 } }), examples: [{ args: { n: 6 }, expect: [6, 3, 10, 5, 16, 8, 4, 2, 1] }],
    async run(x) { const out = [Math.trunc(x.n)]; let value = Math.trunc(x.n); while (value !== 1) { value = value % 2 === 0 ? value / 2 : 3 * value + 1; out.push(value); if (out.length > 100000) throw Object.assign(new Error('trajectory too long'), { code: 'TOO_LARGE' }); } return result(out); }, format: fmt },
  { name: 'seqx.triangular', title: 'Triangular number', description: 'Triangular number T(n)=n(n+1)/2 for n up to 1e8.', category: 'math', permission: 'read', tags: ['sequence', 'number-theory'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 100000000 } }), examples: [{ args: { n: 10 }, expect: 55 }], async run(x) { return result((x.n * (x.n + 1)) / 2); }, format: fmt },
  { name: 'seqx.square_pyramidal', title: 'Square pyramidal number', description: 'Square pyramidal number, the sum of squares from 1 to n.', category: 'math', permission: 'read', tags: ['sequence', 'number-theory'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 1000000 } }), examples: [{ args: { n: 4 }, expect: 30 }], async run(x) { return result((x.n * (x.n + 1) * (2 * x.n + 1)) / 6); }, format: fmt },
  { name: 'seqx.sum_squares', title: 'Sum of squares', description: 'Sum of squares of a numeric array, rejecting non-finite output.', category: 'math', permission: 'read', tags: ['sequence', 'aggregate'],
    parameters: object({ values: { type: 'array', items: N, minItems: 1, maxItems: 100000 } }), examples: [{ args: { values: [1, 2, 3] }, expect: 14 }],
    async run(x) { const value = x.values.reduce((sum, item) => sum + item * item, 0); if (!Number.isFinite(value)) throw Object.assign(new Error('non-finite result'), { code: 'NON_FINITE' }); return result(value); }, format: fmt },
  { name: 'seqx.consecutive_differences', title: 'Constant-difference test', description: 'Returns the common difference when the sequence is arithmetic, otherwise null.', category: 'math', permission: 'read', tags: ['sequence', 'analysis'],
    parameters: object({ values: { type: 'array', items: N, minItems: 2, maxItems: 10000 } }), examples: [{ args: { values: [2, 5, 8, 11] }, expect: 3 }],
    async run(x) { const d = x.values[1] - x.values[0]; return result(x.values.slice(2).every((value, index) => Math.abs(value - x.values[index + 1] - d) < 1e-12) ? d : null); }, format: fmt },
  { name: 'seqx.consecutive_ratios', title: 'Constant-ratio test', description: 'Returns the common ratio when the sequence is geometric and non-zero, otherwise null.', category: 'math', permission: 'read', tags: ['sequence', 'analysis'],
    parameters: object({ values: { type: 'array', items: N, minItems: 2, maxItems: 10000 } }), examples: [{ args: { values: [2, 6, 18] }, expect: 3 }],
    async run(x) { if (x.values[0] === 0) return result(null); const r = x.values[1] / x.values[0]; return result(x.values.slice(2).every((value, index) => Math.abs(value / x.values[index + 1] - r) < 1e-12) ? r : null); }, format: fmt },
  { name: 'seqx.batch', title: 'Split into batches', description: 'Splits an array into consecutive chunks of a fixed positive size; the last batch may be shorter.', category: 'math', permission: 'read', tags: ['sequence', 'list'],
    parameters: object({ values: { type: 'array', items: {}, maxItems: 100000 }, size: { ...INT, minimum: 1, maximum: 100000 } }), examples: [{ args: { values: [1, 2, 3, 4, 5], size: 2 }, expect: [[1, 2], [3, 4], [5]] }],
    async run(x) { const out = []; for (let i = 0; i < x.values.length; i += x.size) out.push(x.values.slice(i, i + x.size)); return result(out); }, format: fmt, examplesNote: 'bounded' },
];
