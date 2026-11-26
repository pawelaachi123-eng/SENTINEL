'use strict';

/**
 * Small JSON-Schema validator, just big enough for tool parameters.
 *
 * Supported: type (string/number/integer/boolean/array/object), required,
 * properties, additionalProperties, enum, const, minimum, maximum, minLength,
 * maxLength, pattern, items, minItems, maxItems, default, description.
 *
 * Unknown keywords are ignored rather than rejected, so a schema written for a
 * newer validator still works here. Anything the model sends that fails is
 * reported with the exact path, which is what makes tool-call retries useful.
 */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function checkType(value, expected) {
  const actual = typeOf(value);
  if (Array.isArray(expected)) return expected.some((type) => checkType(value, type));
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/**
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
function validate(input, schema, { coerce = true } = {}) {
  const errors = [];
  const value = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return { ok: false, value: {}, errors: ['arguments must be an object'] };
  }

  const spec = schema || { type: 'object', properties: {} };
  const properties = spec.properties || {};
  const required = spec.required || [];

  for (const name of required) {
    if (value[name] === undefined || value[name] === null || value[name] === '') {
      errors.push(`${name} is required`);
    }
  }

  if (spec.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push(`${key} is not a known parameter`);
    }
  }

  for (const [name, property] of Object.entries(properties)) {
    let current = value[name];
    if (current === undefined) {
      if (property.default !== undefined) value[name] = property.default;
      continue;
    }
    if (current === null) {
      delete value[name];
      continue;
    }

    // JSON Schema permits a union of types (`["string", "number"]`). Treat the
    // first numeric member as the coercion target so a real ISO string is still
    // accepted alongside epoch milliseconds.
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const numeric = types.includes('number') || types.includes('integer');
    // Model output is stringly-typed surprisingly often: "30" for a number.
    // Never coerce a value that already satisfies one member of a union; a
    // string|array field must keep "a,b" as text, not split it just because an
    // array is also legal.
    if (coerce && !checkType(current, property.type)) {
      if (numeric) {
        if (typeof current === 'string' && current.trim() !== '' && Number.isFinite(Number(current))) current = Number(current);
        if (types.includes('integer') && !types.includes('number') && typeof current === 'number') current = Math.trunc(current);
      } else if (types.includes('boolean') && typeof current === 'string') {
        if (/^(true|yes|1)$/i.test(current)) current = true;
        else if (/^(false|no|0)$/i.test(current)) current = false;
      } else if (types.includes('array') && typeof current === 'string' && property.items) {
        current = current
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }
      value[name] = current;
    }

    if (property.type && !checkType(current, property.type)) {
      errors.push(`${name} must be ${types.join(' or ')} (got ${typeOf(current)})`);
      continue;
    }
    if (property.enum && !property.enum.includes(current)) {
      errors.push(`${name} must be one of ${property.enum.join(', ')}`);
    }
    if (property.const !== undefined && current !== property.const) {
      errors.push(`${name} must equal ${JSON.stringify(property.const)}`);
    }
    if ((property.type === 'number' || property.type === 'integer') && typeof current === 'number') {
      if (property.minimum !== undefined && current < property.minimum) errors.push(`${name} must be ≥ ${property.minimum}`);
      if (property.maximum !== undefined && current > property.maximum) errors.push(`${name} must be ≤ ${property.maximum}`);
    }
    if (typeof current === 'string') {
      if (property.minLength !== undefined && current.length < property.minLength) errors.push(`${name} is too short`);
      if (property.maxLength !== undefined && current.length > property.maxLength) errors.push(`${name} is too long (max ${property.maxLength})`);
      if (property.pattern && !new RegExp(property.pattern).test(current)) errors.push(`${name} has an invalid format`);
    }
    if (Array.isArray(current)) {
      if (property.minItems !== undefined && current.length < property.minItems) errors.push(`${name} needs at least ${property.minItems} items`);
      if (property.maxItems !== undefined && current.length > property.maxItems) errors.push(`${name} allows at most ${property.maxItems} items`);
      if (property.items && property.items.type) {
        current.forEach((item, index) => {
          if (!checkType(item, property.items.type)) errors.push(`${name}[${index}] must be ${property.items.type}`);
        });
      }
    }
  }

  return { ok: errors.length === 0, value, errors };
}

/** Example call rendered for the model's system prompt. */
function describeParameters(schema) {
  const properties = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  return Object.entries(properties)
    .map(([name, property]) => {
      const type = property.type || 'any';
      const flags = [
        required.has(name) ? 'required' : 'optional',
        property.enum ? `one of ${property.enum.join('|')}` : '',
        property.default !== undefined ? `default ${JSON.stringify(property.default)}` : '',
        property.minimum !== undefined ? `min ${property.minimum}` : '',
        property.maximum !== undefined ? `max ${property.maximum}` : '',
      ].filter(Boolean);
      return `${name}: ${type}${flags.length ? ` (${flags.join(', ')})` : ''}${property.description ? ` — ${property.description}` : ''}`;
    })
    .join('; ');
}

module.exports = { validate, describeParameters, typeOf };
