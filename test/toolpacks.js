#!/usr/bin/env node
'use strict';

/**
 * Executes every tool in the extended deterministic packs against its authored
 * example, and checks the schema, identity and expected value. This is a real
 * call through the tool's own run() path; it is not a registry-only check.
 */

const { validate } = require('../core/tools/schema');

const MODULES = ['numext', 'statx', 'txtx', 'datex', 'geom', 'phys', 'unitsx', 'seqx', 'matrix', 'setx', 'bits', 'fmtx', 'finx', 'checksumx'];
const PREFIXES = new Set([...MODULES, 'basex']);

let passed = 0;
const failures = [];

function close(actual, expected) {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-4);
  return Math.abs(actual - expected) <= tolerance;
}

function matches(actual, expected) {
  if (typeof expected === 'number') return close(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => matches(actual[key], value));
  }
  return actual === expected;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    return true;
  } catch (error) {
    failures.push({ name, error });
    return false;
  }
}

(async () => {
  const seen = new Set();
  let tools = 0;
  for (const moduleName of MODULES) {
    const definitions = require(`../core/tools/${moduleName}.tools`);
    for (const tool of definitions) {
      tools += 1;
      const identity = check(`${tool.name}: identity`, () => {
        if (!PREFIXES.has(tool.name.split('.')[0])) throw new Error(`unexpected prefix in ${tool.name}`);
        if (seen.has(tool.name)) throw new Error('duplicate tool name');
        seen.add(tool.name);
        if (!tool.description || tool.description.length < 40) throw new Error('description is too short');
        if (tool.permission !== 'read') throw new Error('pure pack tool must be read-only');
        if (typeof tool.run !== 'function') throw new Error('missing run()');
        if (!tool.parameters || tool.parameters.type !== 'object') throw new Error('missing object schema');
      });
      const example = (tool.examples || [])[0];
      if (!example) {
        failures.push({ name: `${tool.name}: no example`, error: new Error('a tool without an executable example cannot be audited') });
        continue;
      }
      const schema = validate(example.args, tool.parameters);
      check(`${tool.name}: example validates`, () => {
        if (!schema.ok) throw new Error(schema.errors.join('; '));
      });
      let result;
      try {
        result = await tool.run(schema.value, {});
      } catch (error) {
        failures.push({ name: `${tool.name}: run`, error });
        continue;
      }
      check(`${tool.name}: returns a result`, () => {
        if (!result || typeof result !== 'object') throw new Error('result is not an object');
        if (result.ok === false) throw new Error(`${result.code}: ${result.message}`);
      });
      if (example.expect !== undefined) {
        check(`${tool.name}: expected value`, () => {
          const actual = Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
          if (!matches(actual, example.expect) && !matches(result, example.expect)) throw new Error(`expected ${JSON.stringify(example.expect)}, got ${JSON.stringify(result)}`);
        });
      }
      check(`${tool.name}: malformed arguments are rejected`, () => {
        const bad = validate({ __not_a_parameter: true }, tool.parameters);
        if (bad.ok) throw new Error('additionalProperties:false was not enforced');
      });
      if (identity) { /* identity check is counted above */ }
    }
  }

  const total = passed + failures.length;
  if (failures.length) {
    for (const failure of failures) console.log(`  ✗ ${failure.name}\n    ${failure.error.message}`);
    console.error(`\n${failures.length} failure(s) across ${tools} tools (${passed}/${total} checks).`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${tools} tools, ${passed} schema/execute/expectation checks passed`);
  }
})();
