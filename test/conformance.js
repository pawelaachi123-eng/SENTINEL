#!/usr/bin/env node
'use strict';

/**
 * Numeric/date/text conformance matrix.
 *
 * Every row executes the real registered tool with different inputs from the
 * tool-pack example and compares the measured value with an independent
 * expectation. These are distinct cases, not repetitions of the smoke tests in
 * test/toolpacks.js. Only deterministic, offline tools are used.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-conformance-'));
const { Agent } = require('../core/agent');

const near = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => near(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.keys(b).every((key) => near(a[key], b[key]));
  }
  return a === b;
};

const CASES = [];
const add = (tool, args, expected, label = '') => CASES.push({ tool, args, expected, label });

/* arithmetic and number theory — 40 */
add('numext.add', { a: 123, b: 456 }, 579);
add('numext.subtract', { a: 2.5, b: 7.25 }, -4.75);
add('numext.multiply', { a: -12, b: 8 }, -96);
add('numext.divide', { a: 22, b: 7 }, 22 / 7);
add('numext.modulo', { a: 17, b: 5 }, 2);
add('numext.power', { a: 5, b: 3 }, 125);
add('numext.atan2', { a: 1, b: -1 }, -Math.PI / 4);
add('numext.hypot', { a: 5, b: 12 }, 13);
add('numext.log_base', { a: 1000, b: 10 }, 3);
add('numext.gcd', { a: 1071, b: 462 }, 21);
add('numext.lcm', { a: 18, b: 24 }, 72);
add('numext.safe_divide', { a: 1, b: 0 }, null);
add('numext.sqrt', { x: 0.25 }, 0.5);
add('numext.cbrt', { x: 8 }, 2);
add('numext.abs', { x: -7.25 }, 7.25);
add('numext.sign', { x: 0 }, 0);
add('numext.floor', { x: -2.5 }, -3);
add('numext.ceil', { x: -2.5 }, -2);
add('numext.round', { x: 2.5 }, 3);
add('numext.truncate', { x: -2.9 }, -2);
add('numext.exp', { x: 0 }, 1);
add('numext.ln', { x: Math.E }, 1);
add('numext.log10', { x: 10000 }, 4);
add('numext.sin', { x: Math.PI / 2 }, 1);
add('numext.cos', { x: 0 }, 1);
add('numext.tan', { x: Math.PI / 4 }, 1);
add('numext.asin', { x: 0.5 }, Math.PI / 6);
add('numext.acos', { x: 0.5 }, Math.PI / 3);
add('numext.atan', { x: 1 }, Math.PI / 4);
add('numext.degrees', { x: Math.PI }, 180);
add('numext.radians', { x: 180 }, Math.PI);
add('numext.factorial', { x: 6 }, 720);
add('numext.is_prime', { x: 97 }, true);
add('numext.min', { values: [3, 1, 2] }, 1);
add('numext.max', { values: [3, 1, 2] }, 3);
add('numext.sum', { values: [1, 2, 3, 4] }, 10);
add('numext.product', { values: [2, 3, 4] }, 24);
add('numext.hypot_many', { values: [3, 4, 12] }, 13);
add('numext.divisors', { n: 28 }, [1, 2, 4, 7, 14, 28]);
add('numext.fibonacci', { n: 10 }, 55);

/* units — 30 */
add('unitsx.length', { value: 2.5, from: 'km', to: 'm' }, 2500);
add('unitsx.mass', { value: 500, from: 'g', to: 'kg' }, 0.5);
add('unitsx.volume', { value: 2, from: 'l', to: 'ml' }, 2000);
add('unitsx.time', { value: 90, from: 'min', to: 'h' }, 1.5);
add('unitsx.data_decimal', { value: 1, from: 'gb', to: 'mb' }, 1000);
add('unitsx.data_decimal', { value: 1, from: 'gib', to: 'mib' }, 1024);
add('unitsx.energy', { value: 2, from: 'kwh', to: 'j' }, 7200000);
add('unitsx.pressure', { value: 2, from: 'atm', to: 'pa' }, 202650);
add('unitsx.speed', { value: 72, from: 'kmh', to: 'mps' }, 20);
add('unitsx.angle', { value: 90, from: 'deg', to: 'rad' }, Math.PI / 2);
add('unitsx.power', { value: 2, from: 'kw', to: 'w' }, 2000);
add('unitsx.temperature', { value: 100, from: 'C', to: 'F' }, 212);
add('unitsx.temperature', { value: 273.15, from: 'K', to: 'C' }, 0);
add('unitsx.temperature', { value: -40, from: 'C', to: 'F' }, -40);
add('unitsx.si_prefix', { prefix: 'M' }, 1000000);
add('unitsx.si_prefix', { prefix: 'm' }, 0.001);
add('unitsx.fuel_consumption', { value: 10, from: 'l100km', to: 'mpg_us' }, 23.5214583);
add('unitsx.dms_to_decimal', { degrees: 52, minutes: 13, seconds: 0, hemisphere: 'N' }, 52.2166666667);
add('unitsx.length', { value: 1, from: 'mi', to: 'km' }, 1.609344);
add('unitsx.length', { value: 1, from: 'ft', to: 'm' }, 0.3048);
add('unitsx.mass', { value: 1, from: 'lb', to: 'kg' }, 0.45359237);
add('unitsx.volume', { value: 1, from: 'gal_us', to: 'l' }, 3.785411784);
add('unitsx.time', { value: 1, from: 'd', to: 'h' }, 24);
add('unitsx.energy', { value: 1, from: 'cal', to: 'j' }, 4.184);
add('unitsx.pressure', { value: 1, from: 'bar', to: 'pa' }, 100000);
add('unitsx.speed', { value: 1, from: 'mps', to: 'kmh' }, 3.6);
add('unitsx.angle', { value: 360, from: 'deg', to: 'rad' }, 2 * Math.PI);
add('unitsx.power', { value: 1, from: 'hp', to: 'w' }, 745.6998715822702);
add('unitsx.temperature', { value: 32, from: 'F', to: 'C' }, 0);
add('unitsx.data_decimal', { value: 1, from: 'tb', to: 'gb' }, 1000);

/* dates — 25 */
add('datex.add_days', { date: '2026-12-31T23:00:00Z', days: 1 }, '2027-01-01T23:00:00.000Z');
add('datex.add_hours', { date: '2026-01-01T00:00:00Z', hours: -2.5 }, '2025-12-31T21:30:00.000Z');
add('datex.add_months', { date: '2024-01-31T12:00:00Z', months: 1 }, '2024-02-29T12:00:00.000Z');
add('datex.diff_days', { from: '2024-02-28T00:00:00Z', to: '2024-03-01T00:00:00Z' }, 2);
add('datex.diff_ms', { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00.250Z' }, 250);
add('datex.start_of_day', { date: '2026-11-22T19:30:00Z' }, '2026-11-22T00:00:00.000Z');
add('datex.end_of_day', { date: '2026-02-28T01:00:00Z' }, '2026-02-28T23:59:59.999Z');
add('datex.start_of_week', { date: '2026-11-22T19:30:00Z' }, '2026-11-16T00:00:00.000Z');
add('datex.start_of_month', { date: '2026-12-31T19:30:00Z' }, '2026-12-01T00:00:00.000Z');
add('datex.end_of_month', { date: '2024-02-10T00:00:00Z' }, '2024-02-29T23:59:59.999Z');
add('datex.start_of_year', { date: '2026-11-22T00:00:00Z' }, '2026-01-01T00:00:00.000Z');
add('datex.day_of_week', { date: '2026-11-22T00:00:00Z' }, 7);
add('datex.day_of_year', { date: '2026-11-22T00:00:00Z' }, 326);
add('datex.iso_week', { date: '2026-11-22T00:00:00Z' }, { week: 47, year: 2026 });
add('datex.quarter', { date: '2026-11-22T00:00:00Z' }, 4);
add('datex.is_leap_year', { year: 1900 }, false);
add('datex.is_leap_year', { year: 2000 }, true);
add('datex.days_in_month', { year: 2023, month: 2 }, 28);
add('datex.days_in_month', { year: 2024, month: 2 }, 29);
add('datex.age', { birth: '2000-11-22T00:00:00Z', at: '2026-11-21T00:00:00Z' }, 25);
add('datex.easter_sunday', { year: 2025 }, '2025-04-20');
add('datex.easter_sunday', { year: 2026 }, '2026-04-05');
add('datex.to_unix', { date: '1970-01-02T00:00:00Z' }, 86400);
add('datex.from_unix', { seconds: 86400 }, '1970-01-02T00:00:00.000Z');
add('datex.range_overlaps', { startA: '2026-01-01T00:00:00Z', endA: '2026-01-05T00:00:00Z', startB: '2026-01-04T00:00:00Z', endB: '2026-01-10T00:00:00Z' }, true);

/* geometry — 25 */
add('geom.circle_area', { r: 1.5 }, Math.PI * 2.25);
add('geom.circle_circumference', { r: 2.5 }, 2 * Math.PI * 2.5);
add('geom.triangle_area_base_height', { base: 7, height: 3 }, 10.5);
add('geom.triangle_area_heron', { a: 6, b: 8, c: 10 }, 24);
add('geom.rectangle_area', { width: 7.5, height: 2 }, 15);
add('geom.rectangle_perimeter', { width: 7.5, height: 2 }, 19);
add('geom.square_area', { side: 9 }, 81);
add('geom.sphere_volume', { r: 2 }, (4 / 3) * Math.PI * 8);
add('geom.sphere_surface', { r: 3 }, 4 * Math.PI * 9);
add('geom.cylinder_volume', { r: 1, height: 10 }, Math.PI * 10);
add('geom.cone_volume', { r: 2, height: 6 }, (Math.PI * 4 * 6) / 3);
add('geom.cuboid_volume', { length: 3, width: 4, height: 5 }, 60);
add('geom.distance_2d', { x1: 1, y1: 2, x2: 4, y2: 6 }, 5);
add('geom.distance_3d', { x1: 1, y1: 2, z1: 3, x2: 3, y2: 5, z2: 9 }, 7);
add('geom.midpoint_2d', { x1: 2, y1: 4, x2: 6, y2: 8 }, [4, 6]);
add('geom.slope', { x1: 2, y1: 3, x2: 6, y2: 11 }, 2);
add('geom.point_line_distance', { a: 3, b: 4, c: -10, x: 0, y: 0 }, 2);
add('geom.regular_polygon_area', { n: 6, r: 2 }, (6 * 4 * Math.sin(Math.PI / 3)) / 2);
add('geom.triangle_area_base_height', { base: 0.5, height: 0.4 }, 0.1);
add('geom.rectangle_area', { width: 0.25, height: 8 }, 2);
add('geom.distance_2d', { x1: -1, y1: -1, x2: 2, y2: 3 }, 5);
add('geom.circle_area', { r: 10 }, 100 * Math.PI);
add('geom.arc_length', { r: 2, angleRadians: Math.PI / 2 }, Math.PI);
add('geom.sector_area', { r: 2, angleRadians: Math.PI / 2 }, Math.PI);
add('geom.regular_polygon_area', { n: 8, r: 1 }, (8 * Math.sin((2 * Math.PI) / 8)) / 2);

/* physics — 20 */
add('phys.velocity', { displacement: 250, time: 25 }, 10);
add('phys.acceleration', { deltaVelocity: 27, time: 3 }, 9);
add('phys.force', { mass: 5, acceleration: 2 }, 10);
add('phys.weight', { mass: 2 }, 19.6133);
add('phys.work', { force: 20, distance: 3, angleRadians: 0 }, 60);
add('phys.power', { work: 600, time: 4 }, 150);
add('phys.kinetic_energy', { mass: 4, velocity: 5 }, 50);
add('phys.potential_energy', { mass: 3, height: 10 }, 294.1995);
add('phys.ohms_law_voltage', { current: 0.5, resistance: 100 }, 50);
add('phys.ohms_law_current', { voltage: 12, resistance: 3 }, 4);
add('phys.ohms_law_resistance', { voltage: 9, current: 3 }, 3);
add('phys.electrical_power', { voltage: 120, current: 0.5 }, 60);
add('phys.density', { mass: 15, volume: 3 }, 5);
add('phys.pressure', { force: 200, area: 4 }, 50);
add('phys.heat_energy', { mass: 2, specificHeat: 4186, deltaTemperature: 5 }, 41860);
add('phys.wavelength', { speed: 340, frequency: 170 }, 2);
add('phys.wave_frequency', { speed: 300, wavelength: 1.5 }, 200);
add('phys.photon_energy', { frequency: 5e14 }, 3.313035075e-19);
add('phys.force', { mass: 0.5, acceleration: -4 }, -2);
add('phys.kinetic_energy', { mass: 10, velocity: 0 }, 0);

/* finance — 20 */
add('finx.simple_interest', { principal: 2500, annualRate: 0.04, years: 3 }, 300);
add('finx.compound_amount', { principal: 2000, annualRate: 0.05, years: 2, compoundsPerYear: 1 }, 2205);
add('finx.compound_interest', { principal: 2000, annualRate: 0.05, years: 2, compoundsPerYear: 1 }, 205);
add('finx.future_value_series', { deposit: 100, periodicRate: 0.01, periods: 12 }, 100 * ((1.01 ** 12 - 1) / 0.01));
add('finx.present_value', { futureValue: 1210, annualRate: 0.1, years: 2 }, 1000);
add('finx.npv', { cashFlows: [-1000, 600, 600], annualRate: 0.1 }, -1000 + 600 / 1.1 + 600 / 1.21);
add('finx.loan_payment', { principal: 120000, annualRate: 0.06, years: 30, paymentsPerYear: 12 }, (120000 * 0.005) / (1 - 1.005 ** -360));
add('finx.loan_total_interest', { principal: 120000, annualRate: 0.06, years: 30, paymentsPerYear: 12 }, ((120000 * 0.005) / (1 - 1.005 ** -360)) * 360 - 120000);
add('finx.savings_goal_deposit', { goal: 5000, periodicRate: 0.01, periods: 24 }, 5000 * 0.01 / (1.01 ** 24 - 1));
add('finx.rule_of_72', { annualPercent: 6 }, 12);
add('finx.percentage_change', { oldValue: 80, newValue: 100 }, 25);
add('finx.markup', { cost: 80, markupRate: 0.25 }, 100);
add('finx.margin', { revenue: 100, cost: 80 }, 20);
add('finx.discount', { price: 200, discountPercent: 15 }, 170);
add('finx.vat_add', { net: 100, vatPercent: 23 }, 123);
add('finx.vat_extract', { gross: 123, vatPercent: 23 }, 100);
add('finx.cagr', { begin: 100, end: 121, years: 2 }, 10);
add('finx.real_return', { nominalRate: 0.1, inflationRate: 0.03 }, 6.7961165049);
add('finx.break_even_units', { fixedCosts: 1000, pricePerUnit: 20, variableCostPerUnit: 10 }, 100);
add('finx.amortization_row', { principal: 100000, annualRate: 0.06, years: 30, paymentsPerYear: 12 }, { payment: (100000 * 0.005) / (1 - 1.005 ** -360), interest: 500 });

/* statistics — 20 */
add('statx.mean', { values: [2, 4, 6, 8] }, 5);
add('statx.median', { values: [7, 1, 5] }, 5);
add('statx.mode', { values: [4, 4, 1, 2] }, [4]);
add('statx.range', { values: [10, 2, 8] }, 8);
add('statx.variance_population', { values: [2, 4, 4, 4, 5, 5, 7, 9] }, 4);
add('statx.variance_sample', { values: [2, 4, 4, 4, 5, 5, 7, 9] }, 32 / 7);
add('statx.stddev_population', { values: [2, 4, 4, 4, 5, 5, 7, 9] }, 2);
add('statx.quantile', { values: [1, 2, 3, 4], p: 0.75 }, 3.25);
add('statx.iqr', { values: [1, 2, 3, 4, 5] }, 2);
add('statx.zscores', { values: [1, 2, 3] }, [-1, 0, 1]);
add('statx.covariance_population', { x: [2, 4, 6], y: [3, 6, 9] }, 4);
add('statx.covariance_sample', { x: [2, 4, 6], y: [3, 6, 9] }, 6);
add('statx.correlation_pearson', { x: [1, 2, 3], y: [2, 6, 10] }, 1);
add('statx.correlation_spearman', { x: [1, 2, 3], y: [10, 20, 30] }, 1);
add('statx.geometric_mean', { values: [1, 4, 16] }, 4);
add('statx.harmonic_mean', { values: [2, 6] }, 3);
add('statx.weighted_mean', { values: [1, 2], weights: [1, 3] }, 1.75);
add('statx.trimmed_mean', { values: [1, 2, 3, 4, 100], fraction: 0.2 }, 3);
add('statx.cumulative_sum', { values: [1, 2, 3] }, [1, 3, 6]);
add('statx.differences', { values: [1, 4, 9] }, [3, 5]);

/* text — 30 */
add('txtx.reverse', { text: 'kąt' }, 'tąk');
add('txtx.reverse_words', { text: 'Ala ma kota' }, 'kota ma Ala');
add('txtx.is_palindrome', { text: 'kajak' }, true);
add('txtx.is_palindrome', { text: 'kajaki' }, false);
add('txtx.count_words', { text: 'one two  three four' }, 4);
add('txtx.count_sentences', { text: 'A. B? C!' }, 3);
add('txtx.count_chars', { text: 'a b c', excludeWhitespace: true }, 3);
add('txtx.count_letters', { text: 'Ąćę 123' }, 3);
add('txtx.count_digits', { text: 'x1y22z333' }, 6);
add('txtx.frequency', { text: 'abca' }, [['a', 2], ['b', 1], ['c', 1]]);
add('txtx.top_words', { text: 'Ala ala kot', limit: 2 }, [['ala', 2], ['kot', 1]]);
add('txtx.ngrams', { text: 'a b c d', n: 3 }, [['a', 'b', 'c'], ['b', 'c', 'd']]);
add('txtx.caesar', { text: 'Xyz', shift: 2 }, 'Zab');
add('txtx.rot13', { text: 'SENTINEL' }, 'FRAGVARY');
add('txtx.upper', { text: 'zażółć gęślą' }, 'ZAŻÓŁĆ GĘŚLĄ');
add('txtx.lower', { text: 'ZAŻÓŁĆ' }, 'zażółć');
add('txtx.title_case', { text: 'ala ma kota' }, 'Ala Ma Kota');
add('txtx.sentence_case', { text: 'ALA MA KOTA. PIES' }, 'Ala ma kota. Pies');
add('txtx.snake_case', { text: 'Hello World Again' }, 'hello_world_again');
add('txtx.kebab_case', { text: 'Hello World' }, 'hello-world');
add('txtx.camel_case', { text: 'hello world again' }, 'helloWorldAgain');
add('txtx.pascal_case', { text: 'hello world' }, 'HelloWorld');
add('txtx.initials', { text: 'Jan Kowalski' }, 'JK');
add('txtx.remove_diacritics', { text: 'Zażółć gęślą jaźń' }, 'Zazolc gesla jazn');
add('txtx.normalize_whitespace', { text: '  a   b \n c ' }, 'a b c');
add('txtx.strip_html', { text: '<p>Hello <b>world</b></p>' }, 'Hello world');
add('txtx.escape_html', { text: '<a & b>' }, '&lt;a &amp; b&gt;');
add('txtx.is_anagram', { a: 'listen', b: 'silent' }, true);
add('txtx.vowel_count', { text: 'Ala ma kota' }, 5);
add('txtx.longest_word', { text: 'Ala ma bardzo długi wyraz' }, 'bardzo');

(async () => {
  const agent = new Agent();
  const failures = [];
  let passed = 0;
  try {
    for (const entry of CASES) {
      // eslint-disable-next-line no-await-in-loop
      const result = await agent.tools.execute(entry.tool, entry.args, { source: 'conformance' });
      const actual = result.ok ? (result.data && Object.prototype.hasOwnProperty.call(result.data, 'value') ? result.data.value : result.data) : undefined;
      const ok = result.ok && near(actual, entry.expected);
      if (ok) passed += 1;
      else failures.push({ ...entry, actual, code: result.code, message: result.message });
    }
  } finally {
    agent.stop();
  }
  for (const failure of failures) {
    console.log(`  ✗ ${failure.tool} ${JSON.stringify(failure.args)} → ${JSON.stringify(failure.actual)} (expected ${JSON.stringify(failure.expected)})${failure.code ? ` [${failure.code}]` : ''}`);
  }
  console.log(`\n${passed} of ${CASES.length} conformance checks passed.`);
  if (failures.length) process.exitCode = 1;
})();
