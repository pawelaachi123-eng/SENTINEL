'use strict';

/** Deterministic science and mathematics tools. No network, no model, bounded input. */

const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`${name} must be a finite number`), { code: 'BAD_NUMBER' });
  return number;
};
const positive = (value, name) => {
  const number = finite(value, name);
  if (number <= 0) throw Object.assign(new Error(`${name} must be positive`), { code: 'BAD_NUMBER' });
  return number;
};
const arr = (value, name, max = 1000) => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw Object.assign(new Error(`${name} must be a non-empty array of at most ${max}`), { code: 'BAD_INPUT' });
  return value.map((entry) => finite(entry, name));
};

const UNITS = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125 },
  data: { B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, knot: 0.514444 },
  energy: { J: 1, kJ: 1000, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3600000, eV: 1.602176634e-19 },
  pressure: { Pa: 1, kPa: 1000, bar: 100000, atm: 101325, psi: 6894.757293168, mmHg: 133.322387415 },
};

function convert(value, from, to) {
  const table = UNITS[from.table];
  if (!table || !(from.unit in table) || !(to.unit in table) || from.table !== to.table) throw Object.assign(new Error('units must belong to the same supported family'), { code: 'BAD_UNIT' });
  return finite(value, 'value') * table[from.unit] / table[to.unit];
}

function unitTool(name, title, family) {
  return {
    name,
    title,
    description: `Converts ${family} units using exact SI definitions where defined. Unknown units are rejected; this is not a currency or physical-property database.`,
    category: 'science',
    permission: 'read',
    tags: ['science', 'units', family],
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' }, from: { type: 'string', enum: Object.keys(UNITS[family]) }, to: { type: 'string', enum: Object.keys(UNITS[family]) } },
      required: ['value', 'from', 'to'], additionalProperties: false,
    },
    async run(args) {
      const result = convert(args.value, { table: family, unit: args.from }, { table: family, unit: args.to });
      return { ok: true, value: round(result, 10), from: args.from, to: args.to, family };
    },
    format: (data) => `${data.value} ${data.to}`,
  };
}

module.exports = [
  unitTool('science.length_convert', 'Convert length units', 'length'),
  unitTool('science.mass_convert', 'Convert mass units', 'mass'),
  unitTool('science.data_convert', 'Convert data units', 'data'),
  unitTool('science.speed_convert', 'Convert speed units', 'speed'),
  unitTool('science.energy_convert', 'Convert energy units', 'energy'),
  unitTool('science.pressure_convert', 'Convert pressure units', 'pressure'),
  {
    name: 'science.temperature_convert', title: 'Convert temperature',
    description: 'Converts between Celsius, Fahrenheit and kelvin with exact offsets. Refuses values below absolute zero.',
    category: 'science', permission: 'read', tags: ['science', 'temperature', 'units'],
    parameters: { type: 'object', properties: { value: { type: 'number' }, from: { type: 'string', enum: ['C', 'F', 'K'] }, to: { type: 'string', enum: ['C', 'F', 'K'] } }, required: ['value', 'from', 'to'], additionalProperties: false },
    async run(args) {
      const value = finite(args.value, 'value');
      const kelvin = args.from === 'C' ? value + 273.15 : args.from === 'F' ? (value - 32) * 5 / 9 + 273.15 : value;
      if (kelvin < 0) return { ok: false, code: 'BELOW_ABSOLUTE_ZERO', message: 'temperature is below absolute zero' };
      const result = args.to === 'C' ? kelvin - 273.15 : args.to === 'F' ? (kelvin - 273.15) * 9 / 5 + 32 : kelvin;
      return { ok: true, value: round(result, 6), from: args.from, to: args.to };
    },
    format: (data) => `${data.value} ${data.to}`,
  },
  {
    name: 'science.molarity', title: 'Molarity of a solution',
    description: 'Computes molarity (mol/L) from moles and litres, or mass, molar mass and volume. Each formula is returned with the result.',
    category: 'science', permission: 'read', tags: ['science', 'chemistry', 'molarity'],
    parameters: { type: 'object', properties: { moles: { type: 'number' }, massG: { type: 'number' }, molarMass: { type: 'number' }, volumeL: { type: 'number' } }, required: ['volumeL'], additionalProperties: false },
    async run(args) {
      const volume = positive(args.volumeL, 'volumeL');
      const moles = args.moles !== undefined ? finite(args.moles, 'moles') : args.massG !== undefined && args.molarMass !== undefined ? finite(args.massG, 'massG') / positive(args.molarMass, 'molarMass') : null;
      if (moles === null) return { ok: false, code: 'BAD_INPUT', message: 'provide moles or massG with molarMass' };
      return { ok: true, molarity: round(moles / volume, 6), moles: round(moles, 6), volumeL: volume, formula: 'M = mol / L' };
    },
    format: (data) => `${data.molarity} mol/L`,
  },
  {
    name: 'science.dilution', title: 'Dilution volumes',
    description: 'Uses C1V1 = C2V2 to find the missing value (volume in litres). Exactly one unknown is allowed.',
    category: 'science', permission: 'read', tags: ['science', 'chemistry', 'dilution'],
    parameters: { type: 'object', properties: { c1: { type: 'number' }, v1: { type: 'number' }, c2: { type: 'number' }, v2: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const values = ['c1', 'v1', 'c2', 'v2'].map((key) => args[key] === undefined ? null : finite(args[key], key));
      const missing = values.filter((value) => value === null).length;
      if (missing !== 1) return { ok: false, code: 'BAD_INPUT', message: 'exactly one of c1, v1, c2, v2 must be omitted' };
      const [c1, v1, c2, v2] = values;
      const answer = c1 === null ? (c2 * v2) / v1 : v1 === null ? (c2 * v2) / c1 : c2 === null ? (c1 * v1) / v2 : (c1 * v1) / c2;
      return { ok: true, value: round(answer, 6), formula: 'C1 × V1 = C2 × V2' };
    },
    format: (data) => `${data.value}`,
  },
  {
    name: 'science.ideal_gas', title: 'Ideal gas law',
    description: 'Solves PV = nRT for pressure, volume, moles or temperature (kelvin). R = 8.314462618 J/(mol·K).',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'gas'],
    parameters: { type: 'object', properties: { p: { type: 'number' }, v: { type: 'number' }, n: { type: 'number' }, t: { type: 'number' }, solve: { type: 'string', enum: ['p', 'v', 'n', 't'] } }, required: ['solve'], additionalProperties: false },
    async run(args) {
      const R = 8.314462618;
      const p = args.p === undefined ? null : positive(args.p, 'p');
      const v = args.v === undefined ? null : positive(args.v, 'v');
      const n = args.n === undefined ? null : positive(args.n, 'n');
      const t = args.t === undefined ? null : positive(args.t, 't');
      let value;
      if (args.solve === 'p' && n && t && v) value = (n * R * t) / v;
      else if (args.solve === 'v' && n && t && p) value = (n * R * t) / p;
      else if (args.solve === 'n' && p && v && t) value = (p * v) / (R * t);
      else if (args.solve === 't' && p && v && n) value = (p * v) / (n * R);
      else return { ok: false, code: 'BAD_INPUT', message: 'the other three quantities are required' };
      return { ok: true, solve: args.solve, value: round(value, 8), R, note: 'ideal-gas approximation; real gases deviate at high pressure' };
    },
    format: (data) => `${data.solve} = ${data.value}`,
  },
  {
    name: 'science.ohms_law', title: 'Ohm law and power',
    description: 'Solves V = IR and P = VI; supply exactly two of voltage, current, resistance to obtain the third and the power.',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'electronics'],
    parameters: { type: 'object', properties: { voltage: { type: 'number' }, current: { type: 'number' }, resistance: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const given = ['voltage', 'current', 'resistance'].filter((key) => args[key] !== undefined);
      if (given.length !== 2) return { ok: false, code: 'BAD_INPUT', message: 'provide exactly two of voltage, current, resistance' };
      let { voltage, current, resistance } = args;
      if (voltage === undefined) voltage = positive(current, 'current') * positive(resistance, 'resistance');
      else if (current === undefined) current = finite(voltage, 'voltage') / positive(resistance, 'resistance');
      else resistance = finite(voltage, 'voltage') / positive(current, 'current');
      return { ok: true, voltage: round(voltage, 6), current: round(current, 6), resistance: round(resistance, 6), powerW: round(voltage * current, 6), formulas: ['V = I × R', 'P = V × I'] };
    },
    format: (data) => `${data.voltage} V, ${data.current} A, ${data.powerW} W`,
  },
  {
    name: 'science.half_life', title: 'Radioactive decay',
    description: 'Computes remaining amount after elapsed time using N = N0 × (1/2)^(t/T). Not a safety or medical recommendation.',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'decay'],
    parameters: { type: 'object', properties: { initial: { type: 'number' }, halfLife: { type: 'number' }, elapsed: { type: 'number' } }, required: ['initial', 'halfLife', 'elapsed'], additionalProperties: false },
    async run(args) {
      const initial = finite(args.initial, 'initial');
      const halfLife = positive(args.halfLife, 'halfLife');
      const elapsed = Math.max(0, finite(args.elapsed, 'elapsed'));
      return { ok: true, remaining: round(initial * 0.5 ** (elapsed / halfLife), 8), halfLives: round(elapsed / halfLife, 6), formula: 'N = N0 × (1/2)^(t/T)' };
    },
    format: (data) => `${data.remaining} po ${data.halfLives} okresach`,
  },
  {
    name: 'science.ph', title: 'pH and pOH',
    description: 'Converts hydrogen-ion concentration to pH and pOH at 25 °C (Kw = 1e-14). Activity coefficients are not modelled.',
    category: 'science', permission: 'read', tags: ['science', 'chemistry', 'ph'],
    parameters: { type: 'object', properties: { concentration: { type: 'number' }, mode: { type: 'string', enum: ['h', 'oh'] } }, required: ['concentration'], additionalProperties: false },
    async run(args) {
      const concentration = positive(args.concentration, 'concentration');
      const pH = args.mode === 'oh' ? 14 + Math.log10(concentration) : -Math.log10(concentration);
      return { ok: true, ph: round(pH, 4), poh: round(14 - pH, 4), acidic: pH < 7, note: '25 °C approximation, concentration not activity' };
    },
    format: (data) => `pH ${data.ph}`,
  },
  {
    name: 'science.vector_dot', title: 'Dot product and angle',
    description: 'Computes the dot product and angle between two equal-length vectors; cos θ = a·b/(|a||b|).',
    category: 'science', permission: 'read', tags: ['science', 'math', 'vector'],
    parameters: { type: 'object', properties: { a: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'number' } }, b: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'number' } } }, required: ['a', 'b'], additionalProperties: false },
    async run(args) {
      const a = arr(args.a, 'a', 100);
      const b = arr(args.b, 'b', 100);
      if (a.length !== b.length) return { ok: false, code: 'DIMENSION_MISMATCH', message: 'vectors must have equal length' };
      const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
      const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
      const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
      const cosine = normA && normB ? dot / (normA * normB) : null;
      return { ok: true, dot: round(dot, 8), normA: round(normA, 8), normB: round(normB, 8), cosine: cosine === null ? null : round(cosine, 8), angleDeg: cosine === null ? null : round((Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI, 4) };
    },
    format: (data) => `${data.dot}`,
  },
  {
    name: 'science.matrix_multiply', title: 'Matrix multiplication',
    description: 'Multiplies two matrices with explicit shape checking. Row-major arrays.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'matrix'],
    parameters: { type: 'object', properties: { a: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'number' } } }, b: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'number' } } } }, required: ['a', 'b'], additionalProperties: false },
    async run(args) {
      const a = args.a.map((row) => arr(row, 'row', 50));
      const b = args.b.map((row) => arr(row, 'row', 50));
      const width = a[0].length;
      if (!b.every((row) => row.length === b[0].length) || !a.every((row) => row.length === width)) return { ok: false, code: 'RAGGED_MATRIX', message: 'all rows in each matrix must have the same length' };
      if (width !== b.length) return { ok: false, code: 'DIMENSION_MISMATCH', message: 'inner dimensions must match' };
      const result = a.map((row) => b[0].map((_, column) => round(row.reduce((sum, value, inner) => sum + value * b[inner][column], 0), 8)));
      return { ok: true, result, shape: [a.length, b[0].length] };
    },
    format: (data) => `${data.shape.join('×')}`,
  },
  {
    name: 'science.prime_factors', title: 'Prime factorisation',
    description: 'Trial-division factorisation for integers up to 1e12, with exponents. It refuses non-integers and values outside the bound.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'prime'],
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
    async run(args) {
      const n = Number(args.n);
      if (!Number.isSafeInteger(n) || n < 2 || n > 1e12) return { ok: false, code: 'BAD_INPUT', message: 'n must be an integer in [2, 1e12]' };
      let value = n;
      const factors = {};
      for (let divisor = 2; divisor * divisor <= value; divisor += divisor === 2 ? 1 : 2) {
        while (value % divisor === 0) {
          factors[divisor] = (factors[divisor] || 0) + 1;
          value /= divisor;
        }
      }
      if (value > 1) factors[value] = (factors[value] || 0) + 1;
      return { ok: true, n, factors, expression: Object.entries(factors).map(([prime, exponent]) => exponent > 1 ? `${prime}^${exponent}` : prime).join(' × ') };
    },
    format: (data) => data.expression,
  },
  {
    name: 'science.gcd_lcm', title: 'GCD and LCM',
    description: 'Euclidean greatest common divisor and least common multiple for a list of positive integers.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'gcd'],
    parameters: { type: 'object', properties: { values: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'number' } } }, required: ['values'], additionalProperties: false },
    async run(args) {
      const values = args.values.map(Number);
      if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) return { ok: false, code: 'BAD_INPUT', message: 'all values must be positive safe integers' };
      const gcd2 = (a, b) => b ? gcd2(b, a % b) : a;
      const gcd = values.reduce((a, b) => gcd2(a, b));
      const lcm = values.reduce((a, b) => (a / gcd2(a, b)) * b);
      return { ok: true, gcd, lcm };
    },
    format: (data) => `NWD ${data.gcd}, NWW ${data.lcm}`,
  },
  {
    name: 'science.combinations', title: 'Permutations and combinations',
    description: 'Computes nPr and nCr exactly using BigInt then returns a safe integer or a decimal string if too large.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'combinatorics'],
    parameters: { type: 'object', properties: { n: { type: 'number' }, k: { type: 'number' } }, required: ['n', 'k'], additionalProperties: false },
    async run(args) {
      const n = Number(args.n);
      const k = Number(args.k);
      if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n || n > 2000) return { ok: false, code: 'BAD_INPUT', message: 'require 0 <= k <= n <= 2000' };
      const fact = (value) => { let result = 1n; for (let index = 2n; index <= BigInt(value); index += 1n) result *= index; return result; };
      const nCr = fact(n) / (fact(k) * fact(n - k));
      const nPr = fact(n) / fact(n - k);
      const safe = (value) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
      return { ok: true, nPr: safe(nPr), nCr: safe(nCr), exact: n <= 100 };
    },
    format: (data) => `C=${data.nCr}`,
  },
  {
    name: 'science.mod_pow', title: 'Modular exponentiation',
    description: 'Computes base^exponent mod modulus with BigInt fast exponentiation. Refuses a zero modulus or a negative exponent.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'modular', 'crypto'],
    parameters: { type: 'object', properties: { base: { type: 'number' }, exponent: { type: 'number' }, modulus: { type: 'number' } }, required: ['base', 'exponent', 'modulus'], additionalProperties: false },
    async run(args) {
      const base = Number(args.base);
      const exponent = Number(args.exponent);
      const modulus = Number(args.modulus);
      if (![base, exponent, modulus].every(Number.isSafeInteger)) return { ok: false, code: 'BAD_INPUT', message: 'all values must be safe integers' };
      if (exponent < 0 || modulus <= 0) return { ok: false, code: 'BAD_INPUT', message: 'exponent must be >= 0 and modulus > 0' };
      let result = 1n;
      let b = ((BigInt(base) % BigInt(modulus)) + BigInt(modulus)) % BigInt(modulus);
      let e = BigInt(exponent);
      const m = BigInt(modulus);
      while (e > 0n) {
        if (e & 1n) result = (result * b) % m;
        b = (b * b) % m;
        e >>= 1n;
      }
      return { ok: true, result: result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result.toString() };
    },
    format: (data) => `${data.result}`,
  },
  {
    name: 'science.quadratic', title: 'Quadratic roots',
    description: 'Solves ax²+bx+c=0 with the discriminant and returns real or complex roots. a must not be zero.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'algebra'],
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } }, required: ['a', 'b', 'c'], additionalProperties: false },
    async run(args) {
      const a = finite(args.a, 'a');
      const b = finite(args.b, 'b');
      const c = finite(args.c, 'c');
      if (a === 0) return { ok: false, code: 'NOT_QUADRATIC', message: 'a must not be zero' };
      const discriminant = b * b - 4 * a * c;
      const real = -b / (2 * a);
      const imaginary = Math.sqrt(Math.abs(discriminant)) / (2 * Math.abs(a));
      const roots = discriminant >= 0
        ? [{ real: round((-b + Math.sqrt(discriminant)) / (2 * a), 8), imaginary: 0 }, { real: round((-b - Math.sqrt(discriminant)) / (2 * a), 8), imaginary: 0 }]
        : [{ real: round(real, 8), imaginary: round(imaginary, 8) }, { real: round(real, 8), imaginary: round(-imaginary, 8) }];
      return { ok: true, discriminant: round(discriminant, 8), roots, nature: discriminant > 0 ? 'two-real' : discriminant === 0 ? 'one-real' : 'complex' };
    },
    format: (data) => `${data.nature}: ${data.roots.map((root) => `${root.real}${root.imaginary ? `±${root.imaginary}i` : ''}`).join(', ')}`,
  },
  {
    name: 'science.density', title: 'Density, mass and volume',
    description: 'Solves ρ = m/V for the missing quantity; units must be provided consistently (kg, m³ → kg/m³).',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'density'],
    parameters: { type: 'object', properties: { mass: { type: 'number' }, volume: { type: 'number' }, density: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const given = ['mass', 'volume', 'density'].filter((key) => args[key] !== undefined);
      if (given.length !== 2) return { ok: false, code: 'BAD_INPUT', message: 'provide exactly two of mass, volume, density' };
      let { mass, volume, density } = args;
      if (density === undefined) density = finite(mass, 'mass') / positive(volume, 'volume');
      else if (mass === undefined) mass = positive(density, 'density') * positive(volume, 'volume');
      else volume = finite(mass, 'mass') / positive(density, 'density');
      return { ok: true, mass: round(mass, 8), volume: round(volume, 8), density: round(density, 8), formula: 'ρ = m / V' };
    },
    format: (data) => `${data.density}`,
  },
  {
    name: 'science.projectile_range', title: 'Projectile range (no drag)',
    description: 'Ideal projectile range and apex height from speed and launch angle with g = 9.80665 m/s². Air resistance is explicitly ignored.',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'projectile'],
    parameters: { type: 'object', properties: { speed: { type: 'number' }, angleDeg: { type: 'number', minimum: 0, maximum: 90 } }, required: ['speed', 'angleDeg'], additionalProperties: false },
    async run(args) {
      const speed = positive(args.speed, 'speed');
      const angle = finite(args.angleDeg, 'angleDeg');
      if (angle < 0 || angle > 90) return { ok: false, code: 'BAD_ANGLE', message: 'angle must be in [0, 90]' };
      const radians = (angle * Math.PI) / 180;
      const g = 9.80665;
      const range = (speed * speed * Math.sin(2 * radians)) / g;
      const apex = (speed * Math.sin(radians)) ** 2 / (2 * g);
      return { ok: true, rangeM: round(range, 4), apexM: round(apex, 4), flightTimeS: round((2 * speed * Math.sin(radians)) / g, 4), assumptions: 'vacuum, constant gravity, launch and landing at the same height' };
    },
    format: (data) => `${data.rangeM} m`,
  },
  {
    name: 'science.speed_distance_time', title: 'Speed, distance and time',
    description: 'Solves average speed, distance or time with consistent units (m and s, or km and h). It is an average, not instantaneous speed.',
    category: 'science', permission: 'read', tags: ['science', 'physics', 'kinematics'],
    parameters: { type: 'object', properties: { distance: { type: 'number' }, time: { type: 'number' }, speed: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const given = ['distance', 'time', 'speed'].filter((key) => args[key] !== undefined);
      if (given.length !== 2) return { ok: false, code: 'BAD_INPUT', message: 'provide exactly two of distance, time, speed' };
      let { distance, time, speed } = args;
      if (speed === undefined) speed = finite(distance, 'distance') / positive(time, 'time');
      else if (distance === undefined) distance = positive(speed, 'speed') * positive(time, 'time');
      else time = positive(distance, 'distance') / positive(speed, 'speed');
      return { ok: true, distance: round(distance, 8), time: round(time, 8), speed: round(speed, 8) };
    },
    format: (data) => `${data.speed}`,
  },
  {
    name: 'science.percentage_change', title: 'Percentage change',
    description: 'Computes (new − old)/old × 100 and the absolute difference. A zero baseline is refused rather than returning infinity.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'percentage'],
    parameters: { type: 'object', properties: { oldValue: { type: 'number' }, newValue: { type: 'number' } }, required: ['oldValue', 'newValue'], additionalProperties: false },
    async run(args) {
      const oldValue = finite(args.oldValue, 'oldValue');
      const newValue = finite(args.newValue, 'newValue');
      if (oldValue === 0) return { ok: false, code: 'ZERO_BASELINE', message: 'percentage change from zero is undefined' };
      return { ok: true, change: round(newValue - oldValue, 8), percent: round(((newValue - oldValue) / Math.abs(oldValue)) * 100, 6), direction: newValue > oldValue ? 'increase' : newValue < oldValue ? 'decrease' : 'unchanged' };
    },
    format: (data) => `${data.percent}%`,
  },
  {
    name: 'science.significant_figures', title: 'Round to significant figures',
    description: 'Rounds a finite number to 1–15 significant figures using decimal exponent arithmetic; it does not infer measurement uncertainty.',
    category: 'science', permission: 'read', tags: ['science', 'math', 'rounding'],
    parameters: { type: 'object', properties: { value: { type: 'number' }, figures: { type: 'number', minimum: 1, maximum: 15 } }, required: ['value', 'figures'], additionalProperties: false },
    async run(args) {
      const value = finite(args.value, 'value');
      const figures = Math.max(1, Math.min(15, Math.floor(Number(args.figures))));
      if (value === 0) return { ok: true, value: 0, figures, note: 'zero has no non-zero leading digit' };
      const magnitude = Math.floor(Math.log10(Math.abs(value)));
      const factor = 10 ** (figures - 1 - magnitude);
      return { ok: true, value: Math.round(value * factor) / factor, figures, magnitude };
    },
    format: (data) => `${data.value}`,
  },
];
