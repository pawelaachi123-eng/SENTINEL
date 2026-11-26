'use strict';

/** Explicit unit conversion tables. Unknown units fail rather than guessing. */
const N = { type: 'number' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, unit) => ({ ok: true, value, unit });
const fmt = (data) => `${Number(data.value.toPrecision(12))} ${data.unit}`;

function convert(name, title, description, table, example, expect, unit) {
  return {
    name, title, description, category: 'science', permission: 'read', tags: ['units', 'conversion', 'science'],
    parameters: object({ value: N, from: { type: 'string', minLength: 1, maxLength: 20 }, to: { type: 'string', minLength: 1, maxLength: 20 } }),
    examples: [{ args: { ...example }, expect, unit }],
    async run(args) {
      const from = String(args.from).toLowerCase();
      const to = String(args.to).toLowerCase();
      if (!(from in table)) throw Object.assign(new Error(`unknown unit: ${args.from}`), { code: 'UNKNOWN_UNIT' });
      if (!(to in table)) throw Object.assign(new Error(`unknown unit: ${args.to}`), { code: 'UNKNOWN_UNIT' });
      return result((args.value * table[from]) / table[to], to);
    },
    format: fmt,
  };
}

const length = { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 };
const mass = { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 };
const volume = { l: 1, ml: 0.001, m3: 1000, cm3: 0.001, gal_us: 3.785411784, qt_us: 0.946352946, pt_us: 0.473176473, floz_us: 0.0295735295625, gal_uk: 4.54609 };
const time = { s: 1, ms: 0.001, us: 1e-6, min: 60, h: 3600, d: 86400, wk: 604800 };
const data = { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
const energy = { j: 1, kj: 1000, cal: 4.184, kcal: 4184, wh: 3600, kwh: 3600000, ev: 1.602176634e-19 };
const pressure = { pa: 1, kpa: 1000, mpa: 1e6, bar: 100000, atm: 101325, psi: 6894.757293168, mmhg: 133.322387415 };
const speed = { mps: 1, kmh: 1 / 3.6, mph: 0.44704, kn: 0.514444444, fps: 0.3048 };
const angle = { rad: 1, deg: Math.PI / 180, grad: Math.PI / 200, turn: Math.PI * 2 };
const power = { w: 1, kw: 1000, mw: 1e6, hp: 745.6998715823 };

module.exports = [
  convert('unitsx.length', 'Length conversion', 'Converts SI, imperial and nautical length units through metres.', length, { value: 1, from: 'km', to: 'm' }, 1000, 'm'),
  convert('unitsx.mass', 'Mass conversion', 'Converts SI and imperial mass units through kilograms.', mass, { value: 1, from: 'kg', to: 'g' }, 1000, 'g'),
  convert('unitsx.volume', 'Volume conversion', 'Converts metric, US and UK volume units through litres.', volume, { value: 1, from: 'l', to: 'ml' }, 1000, 'ml'),
  convert('unitsx.time', 'Time conversion', 'Converts seconds, minutes, hours, days and weeks.', time, { value: 1, from: 'h', to: 'min' }, 60, 'min'),
  convert('unitsx.data_decimal', 'Decimal data conversion', 'Converts decimal storage units (kB=1000 B) and binary units (KiB=1024 B).', data, { value: 1, from: 'gib', to: 'mib' }, 1024, 'mib'),
  convert('unitsx.energy', 'Energy conversion', 'Converts joules, calories, watt-hours, kilowatt-hours and electronvolts.', energy, { value: 1, from: 'kwh', to: 'j' }, 3600000, 'J'),
  convert('unitsx.pressure', 'Pressure conversion', 'Converts pressure units including pascals, bar, atmospheres, psi and mmHg.', pressure, { value: 1, from: 'atm', to: 'pa' }, 101325, 'Pa'),
  convert('unitsx.speed', 'Speed conversion', 'Converts m/s, km/h, mph, knots and ft/s.', speed, { value: 36, from: 'kmh', to: 'mps' }, 10, 'm/s'),
  convert('unitsx.angle', 'Angle conversion', 'Converts radians, degrees, gradians and turns.', angle, { value: 180, from: 'deg', to: 'rad' }, Math.PI, 'rad'),
  convert('unitsx.power', 'Power conversion', 'Converts watts, kilowatts, megawatts and mechanical horsepower.', power, { value: 1, from: 'kw', to: 'w' }, 1000, 'W'),
  {
    name: 'unitsx.temperature', title: 'Temperature conversion', description: 'Converts between Celsius, Fahrenheit and Kelvin with absolute-zero validation.', category: 'science', permission: 'read', tags: ['units', 'temperature', 'science'],
    parameters: object({ value: N, from: { type: 'string', enum: ['C', 'F', 'K'] }, to: { type: 'string', enum: ['C', 'F', 'K'] } }),
    examples: [{ args: { value: 0, from: 'C', to: 'F' }, expect: 32 }],
    async run(args) {
      const celsius = args.from === 'C' ? args.value : args.from === 'F' ? ((args.value - 32) * 5) / 9 : args.value - 273.15;
      if (celsius < -273.15) throw Object.assign(new Error('temperature is below absolute zero'), { code: 'BELOW_ABSOLUTE_ZERO' });
      const value = args.to === 'C' ? celsius : args.to === 'F' ? (celsius * 9) / 5 + 32 : celsius + 273.15;
      return result(value, args.to);
    }, format: fmt,
  },
  {
    name: 'unitsx.si_prefix', title: 'SI prefix value', description: 'Expands an SI prefix (k, M, G, m, µ, n…) into its power-of-ten multiplier.', category: 'science', permission: 'read', tags: ['units', 'si'],
    parameters: object({ prefix: { type: 'string', enum: ['Y', 'Z', 'E', 'P', 'T', 'G', 'M', 'k', 'h', 'da', 'd', 'c', 'm', 'µ', 'n', 'p', 'f', 'a', 'z', 'y'] } }),
    examples: [{ args: { prefix: 'k' }, expect: 1000 }],
    async run(args) { const table = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24 }; return { ok: true, value: table[args.prefix], multiplier: table[args.prefix] }; }, format: (data) => String(data.value),
  },
  {
    name: 'unitsx.fuel_consumption', title: 'Fuel consumption conversion', description: 'Converts L/100 km to US or UK miles per gallon; zero consumption is rejected.', category: 'science', permission: 'read', tags: ['units', 'fuel'],
    parameters: object({ value: { ...N, minimum: 0.000001 }, from: { type: 'string', enum: ['l100km', 'mpg_us', 'mpg_uk'] }, to: { type: 'string', enum: ['l100km', 'mpg_us', 'mpg_uk'] } }),
    examples: [{ args: { value: 5, from: 'l100km', to: 'mpg_us' }, expect: 47.0429 }],
    async run(args) {
      const l100 = args.from === 'l100km' ? args.value : args.from === 'mpg_us' ? 235.214583 / args.value : 282.480936 / args.value;
      const value = args.to === 'l100km' ? l100 : args.to === 'mpg_us' ? 235.214583 / l100 : 282.480936 / l100;
      return { ok: true, value, unit: args.to };
    }, format: fmt,
  },
  {
    name: 'unitsx.dms_to_decimal', title: 'DMS to decimal degrees', description: 'Converts degrees/minutes/seconds to signed decimal degrees; minutes and seconds must be below 60.', category: 'science', permission: 'read', tags: ['units', 'coordinates'],
    parameters: object({ degrees: { type: 'number' }, minutes: { ...N, minimum: 0, maximum: 59.999999 }, seconds: { ...N, minimum: 0, maximum: 59.999999 }, hemisphere: { type: 'string', enum: ['N', 'S', 'E', 'W'], default: 'N' } }),
    examples: [{ args: { degrees: 52, minutes: 13, seconds: 0, hemisphere: 'N' }, expect: 52.2166666667 }],
    async run(args) { const sign = ['S', 'W'].includes(args.hemisphere) ? -1 : 1; return { ok: true, value: sign * (Math.abs(args.degrees) + args.minutes / 60 + args.seconds / 3600), unit: 'deg' }; }, format: fmt,
  },
  {
    name: 'unitsx.decimal_to_dms', title: 'Decimal degrees to DMS', description: 'Formats signed decimal degrees as degrees, minutes, seconds and hemisphere.', category: 'science', permission: 'read', tags: ['units', 'coordinates'],
    parameters: object({ value: { type: 'number', minimum: -180, maximum: 180 }, axis: { type: 'string', enum: ['lat', 'lon'], default: 'lat' } }),
    examples: [{ args: { value: 52.2166666667, axis: 'lat' }, expect: { degrees: 52, minutes: 13, seconds: 0, hemisphere: 'N' } }],
    async run(args) { const hemisphere = args.axis === 'lat' ? (args.value < 0 ? 'S' : 'N') : (args.value < 0 ? 'W' : 'E'); let rest = Math.abs(args.value); const degrees = Math.floor(rest); rest = (rest - degrees) * 60; const minutes = Math.floor(rest); const seconds = Number(((rest - minutes) * 60).toFixed(3)); return { ok: true, degrees, minutes, seconds, hemisphere }; }, format: (data) => `${data.degrees}°${data.minutes}′${data.seconds}″${data.hemisphere}`,
  },
];
