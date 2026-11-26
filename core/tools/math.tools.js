'use strict';

/**
 * Math tools. The evaluator is a hand-written parser, not eval(): the model can
 * ask for arithmetic without being able to run code by accident.
 *
 * Grammar (precedence climbing):
 *   expr    := term (('+'|'-') term)*
 *   term    := power (('*'|'/'|'%'|'×'|'÷') power)*
 *   power   := unary ('^' power)?            (right associative)
 *   unary   := ('-'|'+') unary | primary
 *   primary := number | constant | name '(' args ')' | '(' expr ')'
 */

const fail = (message, code = 'BAD_EXPRESSION') => Object.assign(new Error(message), { code });

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const FUNCTIONS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sign: Math.sign,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  log: Math.log10,
  ln: Math.log,
  log2: Math.log2,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  hypot: Math.hypot,
};

function tokenize(input) {
  const text = String(input)
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/,/g, ',')
    .replace(/\s+/g, '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/[0-9.]/.test(char)) {
      let number = '';
      while (index < text.length && /[0-9._]/.test(text[index])) {
        if (text[index] !== '_') number += text[index];
        index += 1;
      }
      if (text[index] === 'e' && /[0-9+-]/.test(text[index + 1] || '')) {
        number += text[index];
        index += 1;
        if (/[+-]/.test(text[index])) {
          number += text[index];
          index += 1;
        }
        while (/[0-9]/.test(text[index] || '')) {
          number += text[index];
          index += 1;
        }
      }
      const value = Number(number);
      if (!Number.isFinite(value)) throw fail(`invalid number "${number}"`);
      tokens.push({ type: 'number', value });
    } else if (/[a-zA-Z_]/.test(char)) {
      let name = '';
      while (index < text.length && /[a-zA-Z0-9_]/.test(text[index])) {
        name += text[index];
        index += 1;
      }
      tokens.push({ type: 'name', value: name.toLowerCase() });
    } else if ('+-*/%^(),'.includes(char)) {
      tokens.push({ type: char, value: char });
      index += 1;
    } else {
      throw fail(`unexpected character "${char}"`);
    }
  }
  return tokens;
}

function evaluate(expression) {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (type) => {
    const token = next();
    if (!token || token.type !== type) throw fail(`expected "${type}"${token ? ` but found "${token.value}"` : ' but the expression ended'}`);
    return token;
  };

  function primary() {
    const token = next();
    if (!token) throw fail('unexpected end of expression');
    if (token.type === 'number') return token.value;
    if (token.type === '(') {
      const value = expr();
      expect(')');
      return value;
    }
    if (token.type === 'name') {
      if (CONSTANTS[token.value] !== undefined) return CONSTANTS[token.value];
      const fn = FUNCTIONS[token.value];
      if (!fn) throw fail(`unknown function or constant "${token.value}"`);
      expect('(');
      const args = [];
      if (peek() && peek().type !== ')') {
        args.push(expr());
        while (peek() && peek().type === ',') {
          next();
          args.push(expr());
        }
      }
      expect(')');
      const value = fn(...args);
      if (Number.isNaN(value)) throw fail(`${token.value}() is undefined for those arguments`, 'MATH_ERROR');
      return value;
    }
    throw fail(`unexpected "${token.value}"`);
  }

  // Unary minus binds looser than '^' (-3^2 = -9), as in ordinary notation.
  function unary() {
    const token = peek();
    if (token && (token.type === '-' || token.type === '+')) {
      next();
      const value = unary();
      return token.type === '-' ? -value : value;
    }
    return power();
  }

  function power() {
    const base = primary();
    if (peek() && peek().type === '^') {
      next();
      return Math.pow(base, unary());
    }
    return base;
  }

  function term() {
    let value = unary();
    while (peek() && ['*', '/', '%'].includes(peek().type)) {
      const operator = next().type;
      const right = unary();
      if ((operator === '/' || operator === '%') && right === 0) throw fail('division by zero', 'MATH_ERROR');
      if (operator === '*') value *= right;
      else if (operator === '/') value /= right;
      else value %= right;
    }
    return value;
  }

  function expr() {
    let value = term();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const operator = next().type;
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  if (!tokens.length) throw fail('the expression is empty');
  const result = expr();
  if (position < tokens.length) throw fail(`unexpected "${tokens[position].value}"`);
  if (!Number.isFinite(result)) throw fail('the result is not a finite number', 'MATH_ERROR');
  return result;
}

function describe(value) {
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const median = count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const percentile = (p) => {
    const index = (count - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
  };
  return {
    count,
    sum: Number(sum.toPrecision(12)),
    mean: Number(mean.toPrecision(12)),
    median,
    min: sorted[0],
    max: sorted[count - 1],
    stdDev: Number(Math.sqrt(variance).toPrecision(12)),
    variance: Number(variance.toPrecision(12)),
    p25: Number(percentile(0.25).toPrecision(12)),
    p75: Number(percentile(0.75).toPrecision(12)),
    p95: Number(percentile(0.95).toPrecision(12)),
  };
}

const UNIT_TABLE = {
  // bytes
  b: { group: 'data', factor: 1 },
  kb: { group: 'data', factor: 1024 },
  mb: { group: 'data', factor: 1024 ** 2 },
  gb: { group: 'data', factor: 1024 ** 3 },
  tb: { group: 'data', factor: 1024 ** 4 },
  // time
  ms: { group: 'time', factor: 0.001 },
  s: { group: 'time', factor: 1 },
  min: { group: 'time', factor: 60 },
  h: { group: 'time', factor: 3600 },
  d: { group: 'time', factor: 86400 },
  // length
  mm: { group: 'length', factor: 0.001 },
  cm: { group: 'length', factor: 0.01 },
  m: { group: 'length', factor: 1 },
  km: { group: 'length', factor: 1000 },
  in: { group: 'length', factor: 0.0254 },
  ft: { group: 'length', factor: 0.3048 },
  mi: { group: 'length', factor: 1609.344 },
};

module.exports = [
  {
    name: 'math.eval',
    title: 'Calculate',
    description: 'Evaluate an arithmetic expression with parentheses, powers and functions (sqrt, log, sin, min...). Safe parser, not eval.',
    category: 'math',
    permission: 'read',
    tags: ['math', 'calculator', 'arithmetic'],
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', minLength: 1, maxLength: 500 },
        precision: { type: 'integer', default: 12, minimum: 1, maximum: 15 },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async run(args) {
      const value = evaluate(args.expression);
      return {
        expression: args.expression,
        value: Number(value.toPrecision(args.precision)),
        exact: Number.isInteger(value),
        formatted: value.toLocaleString('en-US', { maximumFractionDigits: args.precision }),
        hex: Number.isInteger(value) ? `0x${value.toString(16)}` : null,
      };
    },
    format: (data) => `${data.expression} = ${data.formatted}`,
  },
  {
    name: 'math.stats',
    title: 'Statistics of a series',
    description: 'Mean, median, standard deviation, quartiles and range for a list of numbers.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'mean', 'median'],
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 100000 },
        text: { type: 'string', description: 'or numbers separated by commas/spaces/newlines', maxLength: 200000 },
      },
      additionalProperties: false,
    },
    async run(args) {
      let values = args.values;
      if (!values && args.text) values = args.text.split(/[\s,;]+/).filter(Boolean).map(Number).filter((value) => Number.isFinite(value));
      if (!values || !values.length) throw fail('give values or text', 'BAD_ARGS');
      return { ...stats(values), first: values.slice(0, 5), last: values.slice(-5) };
    },
    format: (data) => `n=${data.count} mean=${data.mean} median=${data.median} sd=${data.stdDev} min=${data.min} max=${data.max}`,
  },
  {
    name: 'math.percent',
    title: 'Percentages',
    description: 'Percentage of a number, percentage change between two values, or what percent one number is of another.',
    category: 'math',
    permission: 'read',
    tags: ['percent', 'change', 'ratio'],
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['of', 'change', 'share'], default: 'of' },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    async run(args) {
      if (args.mode === 'of') return { mode: 'of', result: (args.a / 100) * args.b, explanation: `${args.a}% of ${args.b}` };
      if (args.mode === 'share') {
        if (args.b === 0) throw fail('the total cannot be zero', 'MATH_ERROR');
        return { mode: 'share', result: Number(((args.a / args.b) * 100).toPrecision(10)), explanation: `${args.a} is this % of ${args.b}` };
      }
      if (args.a === 0) throw fail('the starting value cannot be zero', 'MATH_ERROR');
      const change = ((args.b - args.a) / Math.abs(args.a)) * 100;
      return { mode: 'change', result: Number(change.toPrecision(10)), direction: change >= 0 ? 'increase' : 'decrease', explanation: `${args.a} → ${args.b}` };
    },
  },
  {
    name: 'math.convert',
    title: 'Unit conversion',
    description: 'Convert between bytes/KB/MB/GB/TB, time units, lengths, and temperature.',
    category: 'math',
    permission: 'read',
    tags: ['convert', 'units', 'bytes'],
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        from: { type: 'string', minLength: 1, maxLength: 12 },
        to: { type: 'string', minLength: 1, maxLength: 12 },
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false,
    },
    async run(args) {
      const from = args.from.toLowerCase().replace(/ib$/, 'b');
      const to = args.to.toLowerCase().replace(/ib$/, 'b');
      const temps = ['c', 'f', 'k', 'celsius', 'fahrenheit', 'kelvin'];
      if (temps.includes(from) && temps.includes(to)) {
        const toC = (value) => (from.startsWith('f') ? ((value - 32) * 5) / 9 : from.startsWith('k') ? value - 273.15 : value);
        const celsius = toC(args.value);
        const result = to.startsWith('f') ? (celsius * 9) / 5 + 32 : to.startsWith('k') ? celsius + 273.15 : celsius;
        return { value: args.value, from: args.from, to: args.to, result: Number(result.toFixed(4)) };
      }
      const source = UNIT_TABLE[from];
      const target = UNIT_TABLE[to];
      if (!source || !target) throw fail(`unknown unit (${!source ? args.from : args.to})`, 'BAD_UNIT');
      if (source.group !== target.group) throw fail(`cannot convert ${source.group} to ${target.group}`, 'BAD_UNIT');
      return { value: args.value, from: args.from, to: args.to, result: Number(((args.value * source.factor) / target.factor).toPrecision(12)) };
    },
  },
  {
    name: 'math.base',
    title: 'Number bases',
    description: 'Convert a number between decimal, hexadecimal, binary and octal.',
    category: 'math',
    permission: 'read',
    tags: ['hex', 'binary', 'converter'],
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', minLength: 1, maxLength: 40 },
        from: { type: 'string', enum: ['auto', 'dec', 'hex', 'bin', 'oct'], default: 'auto' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const text = args.value.trim().toLowerCase().replace(/_/g, '');
      let base = { dec: 10, hex: 16, bin: 2, oct: 8 }[args.from] || 10;
      if (args.from === 'auto') {
        if (/^0x/.test(text)) base = 16;
        else if (/^0b/.test(text)) base = 2;
        else if (/^0o/.test(text)) base = 8;
        else if (/^[01]+$/.test(text) && text.length > 8) base = 2;
      }
      const clean = text.replace(/^0[xbo]/, '');
      const value = Number.parseInt(clean, base);
      if (!Number.isFinite(value)) throw fail(`"${args.value}" is not a valid base-${base} number`, 'BAD_NUMBER');
      return { input: args.value, detectedBase: base, dec: value, hex: `0x${value.toString(16)}`, bin: `0b${value.toString(2)}`, oct: `0o${value.toString(8)}`, bits: value.toString(2).length };
    },
    format: (data) => `${data.input} → dec ${data.dec}, hex ${data.hex}, bin ${data.bin}, oct ${data.oct}`,
  },
  {
    name: 'math.factor',
    title: 'Factorise a number',
    description: 'Prime factors, divisor count and whether a number is prime.',
    category: 'math',
    permission: 'read',
    tags: ['prime', 'factors'],
    parameters: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 2, maximum: 1e15 } },
      required: ['number'],
      additionalProperties: false,
    },
    async run(args) {
      let n = args.number;
      const factors = [];
      for (let divisor = 2; divisor * divisor <= n && factors.length < 64; divisor += divisor === 2 ? 1 : 2) {
        while (n % divisor === 0) {
          factors.push(divisor);
          n /= divisor;
        }
      }
      if (n > 1) factors.push(n);
      return {
        number: args.number,
        factors,
        prime: factors.length === 1 && factors[0] === args.number,
        expression: factors.join(' × '),
      };
    },
    format: (data) => `${data.number} = ${data.expression}${data.prime ? ' (prime)' : ''}`,
  },
  {
    name: 'math.gcd',
    title: 'GCD and LCM',
    description: 'Greatest common divisor and least common multiple of two or more integers.',
    category: 'math',
    permission: 'read',
    tags: ['gcd', 'lcm', 'divisor'],
    parameters: {
      type: 'object',
      properties: { numbers: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 20 } },
      required: ['numbers'],
      additionalProperties: false,
    },
    async run(args) {
      const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));
      const gcdAll = args.numbers.reduce((acc, value) => gcd(acc, value));
      const lcmAll = args.numbers.reduce((acc, value) => Math.abs(acc * value) / gcd(acc, value));
      return { numbers: args.numbers, gcd: gcdAll, lcm: lcmAll };
    },
  },
  {
    name: 'math.sequence',
    title: 'Sum a series',
    description: 'Sum, product and step-wise differences of a numeric sequence; detects arithmetic/geometric patterns.',
    category: 'math',
    permission: 'read',
    tags: ['sequence', 'series', 'sum'],
    parameters: {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 5000 } },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const steps = args.values.slice(1).map((value, index) => value - args.values[index]);
      const ratios = args.values.slice(1).map((value, index) => (args.values[index] === 0 ? null : value / args.values[index]));
      const arithmetic = steps.every((step) => Math.abs(step - steps[0]) < 1e-9);
      const geometric = ratios.every((ratio) => ratio !== null && Math.abs(ratio - ratios[0]) < 1e-9);
      return {
        count: args.values.length,
        sum: Number(args.values.reduce((acc, value) => acc + value, 0).toPrecision(12)),
        product: Number(args.values.reduce((acc, value) => acc * value, 1).toPrecision(12)),
        arithmetic: arithmetic ? { step: steps[0], next: args.values[args.values.length - 1] + steps[0] } : null,
        geometric: geometric ? { ratio: ratios[0], next: args.values[args.values.length - 1] * ratios[0] } : null,
      };
    },
  },
  {
    name: 'math.matrix',
    title: 'Matrix operations',
    description: 'Multiply, transpose or take the determinant of small matrices (up to 6×6).',
    category: 'math',
    permission: 'read',
    tags: ['matrix', 'linear algebra'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['multiply', 'transpose', 'determinant'], default: 'multiply' },
        a: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        b: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
      },
      required: ['a'],
      additionalProperties: false,
    },
    async run(args) {
      const a = args.a;
      if (!Array.isArray(a) || !a.length || !Array.isArray(a[0])) throw fail('a must be a 2D array', 'BAD_ARGS');
      if (a.length > 6 || a[0].length > 6) throw fail('matrices are limited to 6×6', 'TOO_LARGE');
      if (args.action === 'transpose') {
        return { result: a[0].map((_, column) => a.map((row) => row[column])) };
      }
      if (args.action === 'determinant') {
        if (a.length !== a[0].length) throw fail('determinant needs a square matrix', 'BAD_ARGS');
        const det = (matrix) => {
          if (matrix.length === 1) return matrix[0][0];
          if (matrix.length === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
          return matrix[0].reduce((acc, value, column) => {
            const minor = matrix.slice(1).map((row) => row.filter((_, index) => index !== column));
            return acc + (column % 2 ? -1 : 1) * value * det(minor);
          }, 0);
        };
        return { determinant: Number(det(a).toPrecision(12)) };
      }
      const b = args.b;
      if (!Array.isArray(b) || b.length !== a[0].length) throw fail(`b must have ${a[0].length} rows`, 'BAD_ARGS');
      const result = a.map((row) => b[0].map((_, column) => row.reduce((acc, value, index) => acc + value * b[index][column], 0)));
      return { result };
    },
  },
];

module.exports.evaluate = evaluate;
module.exports.stats = stats;
