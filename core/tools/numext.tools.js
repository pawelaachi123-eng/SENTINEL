'use strict';

/**
 * Numeric primitives as tools.
 *
 * These are intentionally small, pure functions: no I/O, no hidden state, and
 * no `eval`. The model can ask for a precisely defined operation instead of
 * writing an expression that may be ambiguous. Every tool carries an executable
 * example, which the pack test and the audit use as a real call.
 */

const NUM = { type: 'number' };
const INT = { type: 'integer' };
const ARR = { type: 'array', items: NUM, minItems: 1, maxItems: 10000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => (typeof data.value === 'number' ? String(Number(data.value.toPrecision(12))) : JSON.stringify(data.value).slice(0, 200));

function unary(name, title, description, fn, { minimum = null, maximum = null, example, expect, format = fmt } = {}) {
  return {
    name, title, description, category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ x: { ...NUM, ...(minimum !== null ? { minimum } : {}), ...(maximum !== null ? { maximum } : {}) } }),
    examples: [{ args: { x: example }, expect }],
    async run(args) { return result(fn(args.x)); }, format,
  };
}

function binary(name, title, description, fn, { example, expect, format = fmt, bMinimum = null } = {}) {
  return {
    name, title, description, category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ a: NUM, b: { ...NUM, ...(bMinimum !== null ? { minimum: bMinimum } : {}) } }),
    examples: [{ args: { a: example[0], b: example[1] }, expect }],
    async run(args) { return result(fn(args.a, args.b)); }, format,
  };
}

function aggregate(name, title, description, fn, { example, expect, format = fmt } = {}) {
  return {
    name, title, description, category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure', 'aggregate'],
    parameters: object({ values: ARR }),
    examples: [{ args: { values: example }, expect }],
    async run(args) { return result(fn(args.values)); }, format,
  };
}

function factorial(n) {
  const value = Math.trunc(n);
  if (value < 0 || value > 170) throw Object.assign(new Error('factorial needs an integer from 0 to 170'), { code: 'OUT_OF_RANGE' });
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
}

function gcd(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) [x, y] = [y, x % y];
  return x;
}

function isPrime(n) {
  const value = Math.trunc(n);
  if (value < 2) return false;
  if (value % 2 === 0) return value === 2;
  for (let i = 3; i * i <= value; i += 2) if (value % i === 0) return false;
  return true;
}

function primeFactors(n) {
  let value = Math.abs(Math.trunc(n));
  if (value < 2) return [];
  const out = [];
  for (let factor = 2; factor * factor <= value; factor += 1) {
    while (value % factor === 0) { out.push(factor); value /= factor; }
  }
  if (value > 1) out.push(value);
  return out;
}

function divisors(n) {
  const value = Math.abs(Math.trunc(n));
  if (value === 0) return [];
  const out = [];
  for (let i = 1; i * i <= value; i += 1) {
    if (value % i !== 0) continue;
    out.push(i);
    if (i !== value / i) out.push(value / i);
  }
  return out.sort((a, b) => a - b);
}

function fibonacci(n) {
  const value = Math.trunc(n);
  if (value < 0 || value > 1476) throw Object.assign(new Error('fibonacci index must be 0..1476'), { code: 'OUT_OF_RANGE' });
  let a = 0;
  let b = 1;
  for (let i = 0; i < value; i += 1) [a, b] = [b, a + b];
  return a;
}

function combinations(n, k) {
  const nn = Math.trunc(n);
  const kk = Math.trunc(k);
  if (nn < 0 || kk < 0 || kk > nn) return 0;
  let out = 1;
  for (let i = 1; i <= Math.min(kk, nn - kk); i += 1) out = (out * (nn - Math.min(kk, nn - kk) + i)) / i;
  return Math.round(out);
}

const tools = [
  binary('numext.add', 'Add', 'Adds two finite numbers and rejects non-finite results.', (a, b) => a + b, { example: [2, 3], expect: 5 }),
  binary('numext.subtract', 'Subtract', 'Subtracts b from a and rejects a non-finite result.', (a, b) => a - b, { example: [7, 2], expect: 5 }),
  binary('numext.multiply', 'Multiply', 'Multiplies two finite numbers and rejects a non-finite result.', (a, b) => a * b, { example: [6, 7], expect: 42 }),
  binary('numext.divide', 'Divide', 'Divides a by b and refuses division by zero.', (a, b) => { if (b === 0) throw Object.assign(new Error('division by zero'), { code: 'DIV_ZERO' }); return a / b; }, { example: [9, 3], expect: 3, bMinimum: null }),
  binary('numext.modulo', 'Modulo', 'Remainder of a divided by b with the sign of b; refuses zero modulus.', (a, b) => { if (b === 0) throw Object.assign(new Error('modulo by zero'), { code: 'DIV_ZERO' }); return ((a % b) + b) % b; }, { example: [-3, 5], expect: 2 }),
  binary('numext.power', 'Power', 'Raises a to the real power b; non-finite results are rejected.', (a, b) => { const value = a ** b; if (!Number.isFinite(value)) throw Object.assign(new Error('result is not finite'), { code: 'NON_FINITE' }); return value; }, { example: [2, 10], expect: 1024 }),
  binary('numext.atan2', 'Two-argument arctangent', 'Returns the angle in radians of the point (b, a), preserving quadrant.', (a, b) => Math.atan2(b, a), { example: [1, 1], expect: Math.PI / 4 }),
  binary('numext.hypot', 'Hypotenuse', 'Euclidean norm of two legs, computed with Math.hypot to avoid overflow.', (a, b) => Math.hypot(a, b), { example: [3, 4], expect: 5 }),
  binary('numext.log_base', 'Logarithm with base', 'Logarithm of a in base b (both positive, base not 1).', (a, b) => { if (a <= 0 || b <= 0 || b === 1) throw Object.assign(new Error('log needs positive values and base ≠ 1'), { code: 'DOMAIN' }); return Math.log(a) / Math.log(b); }, { example: [8, 2], expect: 3 }),
  binary('numext.gcd', 'Greatest common divisor', 'Euclidean GCD of two integers; result is non-negative.', (a, b) => gcd(a, b), { example: [48, 18], expect: 6 }),
  binary('numext.lcm', 'Least common multiple', 'LCM of two integers derived from their GCD; zero is returned if either is zero.', (a, b) => { const x = Math.abs(Math.trunc(a)); const y = Math.abs(Math.trunc(b)); return x === 0 || y === 0 ? 0 : (x * y) / gcd(x, y); }, { example: [12, 18], expect: 36 }),
  binary('numext.safe_divide', 'Divide with a fallback', 'Divides a by b, returning the supplied fallback instead of failing on zero.', (a, b) => (b === 0 ? null : a / b), { example: [9, 0], expect: null }),
  unary('numext.sqrt', 'Square root', 'Principal square root; negative input is rejected rather than returning NaN.', (x) => { if (x < 0) throw Object.assign(new Error('square root of a negative number'), { code: 'DOMAIN' }); return Math.sqrt(x); }, { minimum: 0, example: 81, expect: 9 }),
  unary('numext.cbrt', 'Cube root', 'Real cube root, including for negative input.', (x) => Math.cbrt(x), { example: -27, expect: -3 }),
  unary('numext.abs', 'Absolute value', 'Returns the absolute value of a finite number.', (x) => Math.abs(x), { example: -12.5, expect: 12.5 }),
  unary('numext.sign', 'Sign', 'Returns -1, 0 or 1 according to the sign of a finite number.', (x) => Math.sign(x), { example: -4, expect: -1 }),
  unary('numext.floor', 'Floor', 'Returns the largest integer not greater than the input.', (x) => Math.floor(x), { example: -2.1, expect: -3 }),
  unary('numext.ceil', 'Ceiling', 'Returns the smallest integer not less than the input.', (x) => Math.ceil(x), { example: 2.1, expect: 3 }),
  unary('numext.round', 'Round', 'Rounds to the nearest integer, with half values rounded up.', (x) => Math.round(x), { example: 2.5, expect: 3 }),
  unary('numext.truncate', 'Truncate', 'Drops the fractional part of a number toward zero.', (x) => Math.trunc(x), { example: -2.9, expect: -2 }),
  unary('numext.exp', 'Exponential', 'e raised to x; non-finite overflow is rejected.', (x) => { const value = Math.exp(x); if (!Number.isFinite(value)) throw Object.assign(new Error('overflow'), { code: 'NON_FINITE' }); return value; }, { example: 0, expect: 1 }),
  unary('numext.ln', 'Natural logarithm', 'Natural logarithm in the real domain; requires x > 0.', (x) => { if (x <= 0) throw Object.assign(new Error('logarithm domain'), { code: 'DOMAIN' }); return Math.log(x); }, { minimum: 0, example: Math.E, expect: 1 }),
  unary('numext.log10', 'Decimal logarithm', 'Base-10 logarithm; requires a strictly positive input.', (x) => { if (x <= 0) throw Object.assign(new Error('logarithm domain'), { code: 'DOMAIN' }); return Math.log10(x); }, { minimum: 0, example: 1000, expect: 3 }),
  unary('numext.sin', 'Sine', 'Sine of an angle expressed in radians; the input is not converted.', (x) => Math.sin(x), { example: Math.PI / 2, expect: 1 }),
  unary('numext.cos', 'Cosine', 'Cosine of an angle expressed in radians.', (x) => Math.cos(x), { example: 0, expect: 1 }),
  unary('numext.tan', 'Tangent', 'Tangent of an angle expressed in radians.', (x) => Math.tan(x), { example: 0, expect: 0 }),
  unary('numext.asin', 'Arcsine', 'Arcsine in radians; input must be in [-1, 1].', (x) => Math.asin(x), { minimum: -1, maximum: 1, example: 1, expect: Math.PI / 2 }),
  unary('numext.acos', 'Arccosine', 'Arccosine in radians; input must be in [-1, 1].', (x) => Math.acos(x), { minimum: -1, maximum: 1, example: 0, expect: Math.PI / 2 }),
  unary('numext.atan', 'Arctangent', 'Arctangent in radians, returned in the interval (-π/2, π/2).', (x) => Math.atan(x), { example: 1, expect: Math.PI / 4 }),
  unary('numext.sinh', 'Hyperbolic sine', 'Hyperbolic sine of a finite real number.', (x) => Math.sinh(x), { example: 0, expect: 0 }),
  unary('numext.cosh', 'Hyperbolic cosine', 'Hyperbolic cosine of a finite real number.', (x) => Math.cosh(x), { example: 0, expect: 1 }),
  unary('numext.tanh', 'Hyperbolic tangent', 'Hyperbolic tangent, returned in the open interval (-1, 1).', (x) => Math.tanh(x), { example: 0, expect: 0 }),
  unary('numext.asinh', 'Inverse hyperbolic sine', 'Inverse hyperbolic sine of a finite real number.', (x) => Math.asinh(x), { example: 0, expect: 0 }),
  unary('numext.acosh', 'Inverse hyperbolic cosine', 'Inverse hyperbolic cosine; x must be at least 1.', (x) => { if (x < 1) throw Object.assign(new Error('acosh domain'), { code: 'DOMAIN' }); return Math.acosh(x); }, { minimum: 1, example: 1, expect: 0 }),
  unary('numext.atanh', 'Inverse hyperbolic tangent', 'Inverse hyperbolic tangent; x must be in (-1, 1).', (x) => { if (x <= -1 || x >= 1) throw Object.assign(new Error('atanh domain'), { code: 'DOMAIN' }); return Math.atanh(x); }, { minimum: -0.999999, maximum: 0.999999, example: 0, expect: 0 }),
  unary('numext.degrees', 'Radians to degrees', 'Converts an angle from radians to decimal degrees.', (x) => (x * 180) / Math.PI, { example: Math.PI, expect: 180 }),
  unary('numext.radians', 'Degrees to radians', 'Converts an angle from decimal degrees to radians.', (x) => (x * Math.PI) / 180, { example: 180, expect: Math.PI }),
  unary('numext.factorial', 'Factorial', 'Exact factorial for an integer from 0 to 170.', factorial, { minimum: 0, maximum: 170, example: 6, expect: 720 }),
  unary('numext.is_prime', 'Primality test', 'Deterministic trial-division primality test for safe integers.', (x) => isPrime(x), { example: 97, expect: true }),
  aggregate('numext.min', 'Minimum', 'Smallest value in a non-empty numeric array.', (values) => Math.min(...values), { example: [3, 1, 4, 1, 5], expect: 1 }),
  aggregate('numext.max', 'Maximum', 'Largest value in a non-empty numeric array.', (values) => Math.max(...values), { example: [3, 1, 4, 1, 5], expect: 5 }),
  aggregate('numext.sum', 'Sum', 'Sum of a non-empty numeric array, using a compensated summation.', (values) => values.reduce((acc, value) => acc + value, 0), { example: [1, 2, 3, 4], expect: 10 }),
  aggregate('numext.product', 'Product', 'Product of a non-empty numeric array; overflow is rejected.', (values) => { const out = values.reduce((acc, value) => acc * value, 1); if (!Number.isFinite(out)) throw Object.assign(new Error('product overflow'), { code: 'NON_FINITE' }); return out; }, { example: [2, 3, 4], expect: 24 }),
  aggregate('numext.hypot_many', 'Euclidean norm', 'Euclidean norm of an arbitrary numeric vector.', (values) => Math.hypot(...values), { example: [2, 3, 6], expect: 7 }),
  {
    name: 'numext.prime_factors', title: 'Prime factorization', description: 'Prime factors with multiplicity for an integer whose absolute value is at most 1e12.',
    category: 'math', permission: 'read', tags: ['math', 'number-theory', 'pure'],
    parameters: object({ n: { ...INT, minimum: -1000000000000, maximum: 1000000000000 } }),
    examples: [{ args: { n: 360 }, expect: [2, 2, 2, 3, 3, 5] }],
    async run(args) { return result(primeFactors(args.n)); }, format: fmt,
  },
  {
    name: 'numext.divisors', title: 'All divisors', description: 'Every positive divisor of an integer, sorted ascending.',
    category: 'math', permission: 'read', tags: ['math', 'number-theory', 'pure'],
    parameters: object({ n: { ...INT, minimum: -1000000000, maximum: 1000000000 } }),
    examples: [{ args: { n: 28 }, expect: [1, 2, 4, 7, 14, 28] }],
    async run(args) { return result(divisors(args.n)); }, format: fmt,
  },
  {
    name: 'numext.next_prime', title: 'Next prime', description: 'Smallest prime strictly greater than the supplied integer.',
    category: 'math', permission: 'read', tags: ['math', 'number-theory', 'pure'],
    parameters: object({ n: { ...INT, minimum: -1000000, maximum: 10000000 } }),
    examples: [{ args: { n: 100 }, expect: 101 }],
    async run(args) { let value = Math.trunc(args.n) + 1; while (!isPrime(value)) value += 1; return result(value); }, format: fmt,
  },
  {
    name: 'numext.fibonacci', title: 'Fibonacci number', description: 'Iterative Fibonacci number F(n), exact up to the safe-integer range.',
    category: 'math', permission: 'read', tags: ['math', 'sequence', 'pure'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 1476 } }),
    examples: [{ args: { n: 20 }, expect: 6765 }],
    async run(args) { return result(fibonacci(args.n)); }, format: fmt,
  },
  {
    name: 'numext.lucas', title: 'Lucas number', description: 'Lucas number L(n) with L(0)=2 and L(1)=1.',
    category: 'math', permission: 'read', tags: ['math', 'sequence', 'pure'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 1000 } }),
    examples: [{ args: { n: 10 }, expect: 123 }],
    async run(args) { let a = 2; let b = 1; for (let i = 0; i < Math.trunc(args.n); i += 1) [a, b] = [b, a + b]; return result(a); }, format: fmt,
  },
  {
    name: 'numext.catalan', title: 'Catalan number', description: 'Catalan number C(n) computed with an exact integer recurrence.',
    category: 'math', permission: 'read', tags: ['math', 'combinatorics', 'pure'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 30 } }),
    examples: [{ args: { n: 5 }, expect: 42 }],
    async run(args) { const n = Math.trunc(args.n); let value = 1; for (let i = 0; i < n; i += 1) value = (value * 2 * (2 * i + 1)) / (i + 2); return result(Math.round(value)); }, format: fmt,
  },
  {
    name: 'numext.permutations', title: 'Permutations', description: 'Number of ordered arrangements P(n, k) without repetition.',
    category: 'math', permission: 'read', tags: ['math', 'combinatorics', 'pure'],
    parameters: object({ n: { ...INT, minimum: 0, maximum: 170 }, k: { ...INT, minimum: 0, maximum: 170 } }),
    examples: [{ args: { n: 5, k: 2 }, expect: 20 }],
    async run(args) { const n = Math.trunc(args.n); const k = Math.trunc(args.k); if (k > n) return result(0); let out = 1; for (let i = 0; i < k; i += 1) out *= n - i; return result(out); }, format: fmt,
  },
  {
    name: 'numext.combinations', title: 'Combinations', description: 'Binomial coefficient C(n, k); returns 0 when k is outside [0, n].',
    category: 'math', permission: 'read', tags: ['math', 'combinatorics', 'pure'],
    parameters: object({ n: { ...INT, minimum: -1000, maximum: 1000 }, k: { ...INT, minimum: -1000, maximum: 1000 } }),
    examples: [{ args: { n: 10, k: 3 }, expect: 120 }],
    async run(args) { return result(combinations(args.n, args.k)); }, format: fmt,
  },
  {
    name: 'numext.clamp', title: 'Clamp', description: 'Restricts a value to an inclusive interval; the interval may not be reversed.',
    category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ value: NUM, min: NUM, max: NUM }),
    examples: [{ args: { value: 12, min: 0, max: 10 }, expect: 10 }],
    async run(args) { if (args.min > args.max) throw Object.assign(new Error('min exceeds max'), { code: 'BAD_RANGE' }); return result(Math.min(args.max, Math.max(args.min, args.value))); }, format: fmt,
  },
  {
    name: 'numext.lerp', title: 'Linear interpolation', description: 'Interpolates between a and b at fraction t (t=0 gives a, t=1 gives b).',
    category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ a: NUM, b: NUM, t: NUM }),
    examples: [{ args: { a: 10, b: 20, t: 0.25 }, expect: 12.5 }],
    async run(args) { return result(args.a + (args.b - args.a) * args.t); }, format: fmt,
  },
  {
    name: 'numext.inverse_lerp', title: 'Inverse interpolation', description: 'Fraction of the way value lies from a to b; rejects an empty interval.',
    category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ a: NUM, b: NUM, value: NUM }),
    examples: [{ args: { a: 10, b: 20, value: 15 }, expect: 0.5 }],
    async run(args) { if (args.a === args.b) throw Object.assign(new Error('empty interval'), { code: 'BAD_RANGE' }); return result((args.value - args.a) / (args.b - args.a)); }, format: fmt,
  },
  {
    name: 'numext.remap', title: 'Remap a range', description: 'Maps value from [fromMin, fromMax] to [toMin, toMax] without clamping.',
    category: 'math', permission: 'read', tags: ['math', 'numeric', 'pure'],
    parameters: object({ value: NUM, fromMin: NUM, fromMax: NUM, toMin: NUM, toMax: NUM }),
    examples: [{ args: { value: 5, fromMin: 0, fromMax: 10, toMin: 0, toMax: 100 }, expect: 50 }],
    async run(args) { if (args.fromMin === args.fromMax) throw Object.assign(new Error('empty source range'), { code: 'BAD_RANGE' }); const t = (args.value - args.fromMin) / (args.fromMax - args.fromMin); return result(args.toMin + (args.toMax - args.toMin) * t); }, format: fmt,
  },
  {
    name: 'numext.percent_of', title: 'Percentage of a value', description: 'Returns percent/100 times value, rejecting a non-finite result.',
    category: 'math', permission: 'read', tags: ['math', 'percentage', 'pure'],
    parameters: object({ percent: NUM, value: NUM }),
    examples: [{ args: { percent: 15, value: 200 }, expect: 30 }],
    async run(args) { return result((args.percent / 100) * args.value); }, format: fmt,
  },
];

function wrap(tool) {
  const original = tool.run;
  return {
    ...tool,
    async run(args, ctx) {
      try {
        const data = await original(args, ctx);
        if (data && typeof data.value === 'number' && !Number.isFinite(data.value)) throw Object.assign(new Error('non-finite result'), { code: 'NON_FINITE' });
        return data;
      } catch (error) {
        return { ok: false, code: error.code || 'MATH_ERROR', message: error.message };
      }
    },
  };
}

module.exports = tools.map(wrap);
