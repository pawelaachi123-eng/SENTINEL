'use strict';

/**
 * Deterministic data, statistics and tabular tools.
 *
 * These are real computations over the arguments a caller supplies. They read
 * no files, touch no network and make no claims about statistical significance
 * beyond the formulas implemented (which are named in each description).
 * Numbers are reported exactly as computed; approximations are labelled.
 */

const MAX_ROWS = 5000;

function numbers(values) {
  if (!Array.isArray(values)) throw Object.assign(new Error('values must be an array of numbers'), { code: 'BAD_ARGS' });
  const parsed = values.map((value) => (typeof value === 'string' ? Number(value) : value));
  if (parsed.some((value) => typeof value !== 'number' || Number.isNaN(value))) throw Object.assign(new Error('every value must be a finite number'), { code: 'BAD_ARGS' });
  return parsed;
}

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function percentile(values, percent) {
  if (!values.length) return null;
  const p = Math.max(0, Math.min(100, percent));
  const position = ((values.length - 1) * p) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function parseCsv(text, { delimiter = ',', header = true } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const clean = rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ''));
  if (!header) return { columns: clean[0] ? clean[0].map((_, index) => `column_${index + 1}`) : [], rows: clean.map((entry) => Object.fromEntries(entry.map((cell, index) => [`column_${index + 1}`, cell]))), raw: clean.length };
  const columns = clean.shift() || [];
  const objects = clean.slice(0, MAX_ROWS).map((entry) => Object.fromEntries(columns.map((column, index) => [column, entry[index] ?? ''])));
  return { columns, rows: objects, raw: clean.length };
}

function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix || '$'] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, out));
    return out;
  }
  for (const [key, entry] of Object.entries(value)) flatten(entry, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

function pathGet(value, path) {
  const parts = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !(part in current)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

function groupRows(rows, key, operations) {
  const groups = new Map();
  for (const row of rows) {
    const label = row[key] === undefined ? 'undefined' : String(row[key]);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  const result = [];
  for (const [label, group] of groups) {
    const entry = { key: label, count: group.length };
    for (const operation of operations) {
      const values = group.map((row) => Number(row[operation.field])).filter((value) => Number.isFinite(value));
      if (operation.op === 'sum') entry[operation.as || `${operation.op}_${operation.field}`] = round(values.reduce((sum, value) => sum + value, 0));
      else if (operation.op === 'avg') entry[operation.as || `${operation.op}_${operation.field}`] = values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
      else if (operation.op === 'min') entry[operation.as || `${operation.op}_${operation.field}`] = values.length ? Math.min(...values) : null;
      else if (operation.op === 'max') entry[operation.as || `${operation.op}_${operation.field}`] = values.length ? Math.max(...values) : null;
    }
    result.push(entry);
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

const tableProperty = (description) => ({ type: 'array', maxItems: MAX_ROWS, description, items: { type: 'object' } });

module.exports = [
  {
    name: 'data.csv_parse',
    title: 'Parse CSV into rows',
    description: 'Parses delimiter-separated text with quoted fields, CRLF and a header row into objects. Bounded to 5000 rows; no file or network access.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'csv', 'table', 'parse'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        delimiter: { type: 'string', minLength: 1, maxLength: 2 },
        header: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const parsed = parseCsv(args.text, { delimiter: args.delimiter || ',', header: args.header !== false });
      return { ok: true, ...parsed, truncated: parsed.raw > MAX_ROWS, rowLimit: MAX_ROWS };
    },
    format: (data) => `${data.rows.length} wierszy, ${data.columns.length} kolumn`,
  },
  {
    name: 'data.csv_generate',
    title: 'Generate CSV text',
    description: 'Serialises an array of flat objects to CSV with correct quoting for commas, quotes and newlines. Column order can be supplied; otherwise keys are unioned in first-seen order.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'csv', 'serialize'],
    parameters: {
      type: 'object',
      properties: {
        rows: tableProperty('rows to serialise'),
        columns: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 120 } },
        delimiter: { type: 'string', minLength: 1, maxLength: 2 },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    async run(args) {
      const delimiter = args.delimiter || ',';
      const columns = args.columns && args.columns.length ? args.columns : [...new Set(args.rows.flatMap((row) => Object.keys(row)))];
      const escape = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /["\n\r]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = [columns.map(escape).join(delimiter), ...args.rows.map((row) => columns.map((column) => escape(row[column])).join(delimiter))];
      return { ok: true, columns, rows: args.rows.length, csv: `${lines.join('\n')}\n` };
    },
    format: (data) => `${data.rows} wierszy, ${data.columns.length} kolumn`,
  },
  {
    name: 'data.json_flatten',
    title: 'Flatten a JSON object',
    description: 'Flattens nested objects and arrays into path keys such as user.name and items[0].id. Useful for tabular export and diffing; no JSONPath evaluation.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'json', 'flatten'],
    parameters: {
      type: 'object',
      properties: { value: {} },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const flat = flatten(args.value);
      return { ok: true, keys: Object.keys(flat).length, flat };
    },
    format: (data) => `${data.keys} kluczy`,
  },
  {
    name: 'data.json_path',
    title: 'Read a JSON path',
    description: 'Reads a dot/bracket path (a.b[0].c) from a JSON value and reports found=false instead of throwing when the path is absent.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'json', 'path', 'query'],
    parameters: {
      type: 'object',
      properties: { value: {}, path: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['value', 'path'],
      additionalProperties: false,
    },
    async run(args) {
      return { ok: true, path: args.path, ...pathGet(args.value, args.path) };
    },
    format: (data) => (data.found ? 'znaleziono' : 'brak ścieżki'),
  },
  {
    name: 'data.json_diff',
    title: 'Diff two JSON values',
    description: 'Reports added, removed and changed paths between two JSON values using flattened paths. Values are compared structurally with JSON equality.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'json', 'diff', 'compare'],
    parameters: {
      type: 'object',
      properties: { left: {}, right: {} },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    async run(args) {
      const left = flatten(args.left);
      const right = flatten(args.right);
      const added = Object.keys(right).filter((key) => !(key in left)).map((key) => ({ path: key, value: right[key] }));
      const removed = Object.keys(left).filter((key) => !(key in right)).map((key) => ({ path: key, value: left[key] }));
      const changed = Object.keys(left)
        .filter((key) => key in right && JSON.stringify(left[key]) !== JSON.stringify(right[key]))
        .map((key) => ({ path: key, left: left[key], right: right[key] }));
      return { ok: true, added, removed, changed, equal: !added.length && !removed.length && !changed.length };
    },
    format: (data) => (data.equal ? 'identyczne' : `+${data.added.length} -${data.removed.length} ~${data.changed.length}`),
  },
  {
    name: 'data.table_group',
    title: 'Group rows and aggregate fields',
    description: 'Groups an array of objects by one key and computes count, sum, average, minimum or maximum over numeric fields. Non-numeric values are ignored and the count is reported.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'group', 'aggregate', 'table'],
    parameters: {
      type: 'object',
      properties: {
        rows: tableProperty('rows to group'),
        key: { type: 'string', minLength: 1, maxLength: 120 },
        operations: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1, maxLength: 120 },
              op: { type: 'string', enum: ['sum', 'avg', 'min', 'max'] },
              as: { type: 'string', maxLength: 120 },
            },
            required: ['field', 'op'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows', 'key'],
      additionalProperties: false,
    },
    async run(args) {
      const groups = groupRows(args.rows, args.key, args.operations || []);
      return { ok: true, groups, count: groups.length };
    },
    format: (data) => `${data.count} grup`,
  },
  {
    name: 'data.table_sort',
    title: 'Sort rows by keys',
    description: 'Stable multi-key sort of an array of objects with ascending or descending order per key. Missing values sort last; strings use localeCompare.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'sort', 'table'],
    parameters: {
      type: 'object',
      properties: {
        rows: tableProperty('rows to sort'),
        keys: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: { field: { type: 'string', minLength: 1, maxLength: 120 }, direction: { type: 'string', enum: ['asc', 'desc'] } },
            required: ['field'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows', 'keys'],
      additionalProperties: false,
    },
    async run(args) {
      const rows = [...args.rows];
      rows.sort((a, b) => {
        for (const key of args.keys) {
          const left = a[key.field];
          const right = b[key.field];
          if (left === right) continue;
          if (left === undefined || left === null) return 1;
          if (right === undefined || right === null) return -1;
          const factor = key.direction === 'desc' ? -1 : 1;
          if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
          return String(left).localeCompare(String(right)) * factor;
        }
        return 0;
      });
      return { ok: true, rows, count: rows.length };
    },
    format: (data) => `${data.count} wierszy`,
  },
  {
    name: 'data.table_filter',
    title: 'Filter rows by conditions',
    description: 'Filters an array of objects with eq, ne, gt, gte, lt, lte, contains, startsWith or exists conditions. All conditions must match; no expression evaluation.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'filter', 'table', 'query'],
    parameters: {
      type: 'object',
      properties: {
        rows: tableProperty('rows to filter'),
        conditions: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1, maxLength: 120 },
              op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'exists'] },
              value: {},
            },
            required: ['field', 'op'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows', 'conditions'],
      additionalProperties: false,
    },
    async run(args) {
      const rows = args.rows.filter((row) => args.conditions.every((condition) => {
        const value = row[condition.field];
        if (condition.op === 'exists') return value !== undefined && value !== null && value !== '';
        if (condition.op === 'eq') return value === condition.value;
        if (condition.op === 'ne') return value !== condition.value;
        if (condition.op === 'gt') return Number(value) > Number(condition.value);
        if (condition.op === 'gte') return Number(value) >= Number(condition.value);
        if (condition.op === 'lt') return Number(value) < Number(condition.value);
        if (condition.op === 'lte') return Number(value) <= Number(condition.value);
        if (condition.op === 'contains') return String(value ?? '').includes(String(condition.value ?? ''));
        if (condition.op === 'startsWith') return String(value ?? '').startsWith(String(condition.value ?? ''));
        return false;
      }));
      return { ok: true, rows, matched: rows.length, total: args.rows.length };
    },
    format: (data) => `${data.matched}/${data.total} wierszy`,
  },
  {
    name: 'data.columns',
    title: 'Infer column types and null counts',
    description: 'Inspects an array of objects and reports each column, non-null count, null count and inferred type (number, boolean, date-like, string or mixed).',
    category: 'data',
    permission: 'read',
    tags: ['data', 'columns', 'types', 'quality'],
    parameters: {
      type: 'object',
      properties: { rows: tableProperty('rows to inspect') },
      required: ['rows'],
      additionalProperties: false,
    },
    async run(args) {
      const names = [...new Set(args.rows.flatMap((row) => Object.keys(row)))];
      const columns = names.map((name) => {
        const values = args.rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined && value !== '');
        const types = new Set(values.map((value) => {
          if (typeof value === 'number') return 'number';
          if (typeof value === 'boolean') return 'boolean';
          if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date-like';
          return 'string';
        }));
        return { name, present: values.length, nulls: args.rows.length - values.length, type: types.size === 0 ? 'empty' : types.size === 1 ? [...types][0] : 'mixed', distinct: new Set(values.map((value) => JSON.stringify(value))).size };
      });
      return { ok: true, rows: args.rows.length, columns };
    },
    format: (data) => `${data.columns.length} kolumn`,
  },
  {
    name: 'data.dedupe',
    title: 'Deduplicate rows by keys',
    description: 'Removes duplicate rows by one or more keys, keeping the first occurrence and reporting how many duplicates were removed. Key values are compared by JSON equality.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'dedupe', 'quality', 'table'],
    parameters: {
      type: 'object',
      properties: {
        rows: tableProperty('rows to deduplicate'),
        keys: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 120 } },
      },
      required: ['rows', 'keys'],
      additionalProperties: false,
    },
    async run(args) {
      const seen = new Set();
      const rows = [];
      for (const row of args.rows) {
        const key = JSON.stringify(args.keys.map((field) => row[field]));
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
      return { ok: true, rows, removed: args.rows.length - rows.length, kept: rows.length };
    },
    format: (data) => `${data.kept} unikalnych, ${data.removed} duplikatów`,
  },
  {
    name: 'data.join',
    title: 'Join two tables',
    description: 'Inner or left join of two arrays of objects on a key, with configurable right-side prefix to avoid collisions. Reports unmatched rows instead of hiding them.',
    category: 'data',
    permission: 'read',
    tags: ['data', 'join', 'table', 'merge'],
    parameters: {
      type: 'object',
      properties: {
        left: tableProperty('left rows'),
        right: tableProperty('right rows'),
        leftKey: { type: 'string', minLength: 1, maxLength: 120 },
        rightKey: { type: 'string', minLength: 1, maxLength: 120 },
        type: { type: 'string', enum: ['inner', 'left'] },
        prefix: { type: 'string', maxLength: 40 },
      },
      required: ['left', 'right', 'leftKey'],
      additionalProperties: false,
    },
    async run(args) {
      const rightKey = args.rightKey || args.leftKey;
      const index = new Map();
      for (const row of args.right) {
        const key = String(row[rightKey]);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(row);
      }
      const prefix = args.prefix || 'right_';
      const matched = [];
      let unmatched = 0;
      for (const row of args.left) {
        const candidates = index.get(String(row[args.leftKey])) || [];
        if (!candidates.length) {
          unmatched += 1;
          if (args.type === 'left') matched.push({ ...row });
          continue;
        }
        for (const candidate of candidates) {
          const merged = { ...row };
          for (const [key, value] of Object.entries(candidate)) merged[key in merged ? `${prefix}${key}` : key] = value;
          matched.push(merged);
        }
      }
      return { ok: true, rows: matched, matched: matched.length, unmatched, left: args.left.length, right: args.right.length };
    },
    format: (data) => `${data.matched} dopasowań, ${data.unmatched} bez pary`,
  },
  {
    name: 'stats.describe',
    title: 'Describe a numeric sample',
    description: 'Computes count, min, max, sum, mean and population standard deviation. Each formula is standard; no distributional assumptions are asserted.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'describe', 'mean', 'standard deviation'],
    parameters: {
      type: 'object',
      properties: { values: { type: 'array', minItems: 1, maxItems: 100000, items: { type: 'number' } } },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = numbers(args.values);
      const sum = values.reduce((total, value) => total + value, 0);
      const mean = sum / values.length;
      const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
      return { ok: true, count: values.length, min: Math.min(...values), max: Math.max(...values), sum: round(sum), mean: round(mean), stdDev: round(Math.sqrt(variance)), variance: round(variance) };
    },
    format: (data) => `n=${data.count}, średnia ${data.mean}, σ ${data.stdDev}`,
  },
  {
    name: 'stats.percentile',
    title: 'Percentiles and median',
    description: 'Computes requested percentiles with linear interpolation, including p50/median, p90 and p95. Values are sorted first; empty input returns null.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'percentile', 'median', 'p95'],
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'array', minItems: 1, maxItems: 100000, items: { type: 'number' } },
        percentiles: { type: 'array', maxItems: 20, items: { type: 'number', minimum: 0, maximum: 100 } },
      },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = sorted(numbers(args.values));
      const requested = args.percentiles && args.percentiles.length ? args.percentiles : [50, 90, 95, 99];
      const result = {};
      for (const percent of requested) result[`p${percent}`] = round(percentile(values, percent));
      return { ok: true, count: values.length, min: values[0], max: values[values.length - 1], percentiles: result };
    },
    format: (data) => Object.entries(data.percentiles).map(([key, value]) => `${key}=${value}`).join(', '),
  },
  {
    name: 'stats.histogram',
    title: 'Build a histogram',
    description: 'Buckets numeric values into a requested number of equal-width bins and returns each bin range with its count. Empty bins are included.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'histogram', 'distribution'],
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'array', minItems: 1, maxItems: 100000, items: { type: 'number' } },
        bins: { type: 'number', minimum: 1, maximum: 200 },
      },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = numbers(args.values);
      const count = Math.max(1, Math.round(args.bins || 10));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const width = (max - min) / count || 1;
      const bins = Array.from({ length: count }, (_, index) => ({ from: round(min + index * width), to: round(min + (index + 1) * width), count: 0 }));
      for (const value of values) {
        const index = Math.min(count - 1, Math.floor((value - min) / width));
        bins[index].count += 1;
      }
      return { ok: true, min, max, binWidth: round(width), bins };
    },
    format: (data) => `${data.bins.length} przedziałów`,
  },
  {
    name: 'stats.correlation',
    title: 'Pearson correlation',
    description: 'Computes the Pearson correlation coefficient for two equal-length numeric samples, with n and an interpretation label (strong/moderate/weak). Correlation is not causation.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'correlation', 'pearson'],
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } },
        y: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args) {
      const x = numbers(args.x);
      const y = numbers(args.y);
      if (x.length !== y.length) return { ok: false, code: 'LENGTH_MISMATCH', message: 'x and y must have the same length' };
      const meanX = x.reduce((a, b) => a + b, 0) / x.length;
      const meanY = y.reduce((a, b) => a + b, 0) / y.length;
      let numerator = 0;
      let denomX = 0;
      let denomY = 0;
      for (let index = 0; index < x.length; index += 1) {
        numerator += (x[index] - meanX) * (y[index] - meanY);
        denomX += (x[index] - meanX) ** 2;
        denomY += (y[index] - meanY) ** 2;
      }
      const r = denomX && denomY ? numerator / Math.sqrt(denomX * denomY) : null;
      const magnitude = r === null ? null : Math.abs(r);
      return { ok: true, n: x.length, r: round(r), strength: magnitude === null ? 'undefined' : magnitude >= 0.7 ? 'strong' : magnitude >= 0.4 ? 'moderate' : 'weak', note: 'correlation is not causation' };
    },
    format: (data) => (data.r === null ? 'brak wariancji' : `r=${data.r} (${data.strength})`),
  },
  {
    name: 'stats.linear_regression',
    title: 'Simple least-squares regression',
    description: 'Fits y = slope*x + intercept by ordinary least squares and reports R² and residual standard deviation. Two variables only; no multiple regression.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'regression', 'least squares', 'trend'],
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } },
        y: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args) {
      const x = numbers(args.x);
      const y = numbers(args.y);
      if (x.length !== y.length) return { ok: false, code: 'LENGTH_MISMATCH', message: 'x and y must have the same length' };
      const meanX = x.reduce((a, b) => a + b, 0) / x.length;
      const meanY = y.reduce((a, b) => a + b, 0) / y.length;
      let sxy = 0;
      let sxx = 0;
      for (let index = 0; index < x.length; index += 1) {
        sxy += (x[index] - meanX) * (y[index] - meanY);
        sxx += (x[index] - meanX) ** 2;
      }
      if (!sxx) return { ok: false, code: 'NO_VARIANCE', message: 'x has no variance, so a slope cannot be estimated' };
      const slope = sxy / sxx;
      const intercept = meanY - slope * meanX;
      let ssRes = 0;
      let ssTot = 0;
      for (let index = 0; index < x.length; index += 1) {
        const predicted = slope * x[index] + intercept;
        ssRes += (y[index] - predicted) ** 2;
        ssTot += (y[index] - meanY) ** 2;
      }
      return { ok: true, n: x.length, slope: round(slope), intercept: round(intercept), r2: round(ssTot ? 1 - ssRes / ssTot : null), residualStdDev: round(Math.sqrt(ssRes / x.length)), equation: `y = ${round(slope)}x + ${round(intercept)}` };
    },
    format: (data) => (data.ok ? data.equation : `brak: ${data.code}`),
  },
  {
    name: 'stats.outliers',
    title: 'Detect outliers with the IQR rule',
    description: 'Returns values outside Q1 − 1.5·IQR and Q3 + 1.5·IQR, with the computed fences. It names the rule so a caller can disagree with it.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'outliers', 'iqr', 'quality'],
    parameters: {
      type: 'object',
      properties: { values: { type: 'array', minItems: 4, maxItems: 100000, items: { type: 'number' } } },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = sorted(numbers(args.values));
      const q1 = percentile(values, 25);
      const q3 = percentile(values, 75);
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      const outliers = values.filter((value) => value < lower || value > upper);
      return { ok: true, q1: round(q1), q3: round(q3), iqr: round(iqr), lowerFence: round(lower), upperFence: round(upper), outliers, rule: 'Tukey 1.5×IQR' };
    },
    format: (data) => `${data.outliers.length} odstających`,
  },
  {
    name: 'stats.zscores',
    title: 'Standard scores',
    description: 'Computes the z-score of every value using the population mean and standard deviation, and flags |z| >= 2 and >= 3. Constant input returns null scores.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'zscore', 'normalization'],
    parameters: {
      type: 'object',
      properties: { values: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } } },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = numbers(args.values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length);
      const zscores = values.map((value, index) => ({ index, value, z: sd ? round((value - mean) / sd) : null, extreme: sd ? Math.abs((value - mean) / sd) >= 3 : false }));
      return { ok: true, mean: round(mean), stdDev: round(sd), zscores, extremes: zscores.filter((entry) => entry.extreme).map((entry) => entry.index) };
    },
    format: (data) => `${data.zscores.length} wartości, ${data.extremes.length} skrajnych`,
  },
  {
    name: 'stats.sample',
    title: 'Deterministic sample',
    description: 'Draws a reproducible sample from numeric values using a seeded Fisher–Yates shuffle. The seed and algorithm are returned so the draw can be repeated exactly.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'sample', 'seed', 'reproducible'],
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'array', minItems: 1, maxItems: 100000, items: { type: 'number' } },
        size: { type: 'number', minimum: 1, maximum: 100000 },
        seed: { type: 'number', minimum: 1, maximum: 1000000 },
      },
      required: ['values', 'size'],
      additionalProperties: false,
    },
    async run(args) {
      let state = (args.seed || 42) >>> 0;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const values = [...args.values];
      for (let index = values.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [values[index], values[swap]] = [values[swap], values[index]];
      }
      return { ok: true, size: Math.min(args.size, values.length), seed: args.seed || 42, algorithm: 'LCG + Fisher-Yates', sample: values.slice(0, Math.min(args.size, values.length)) };
    },
    format: (data) => `${data.sample.length} z ${data.size}, seed ${data.seed}`,
  },
  {
    name: 'stats.mean_ci',
    title: 'Confidence interval for a mean',
    description: 'Computes a normal-approximation confidence interval for the mean (z=1.96 for 95%). It is explicitly approximate and not valid for tiny samples or heavy tails.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'confidence interval', 'mean'],
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'array', minItems: 2, maxItems: 100000, items: { type: 'number' } },
        level: { type: 'number', minimum: 0.5, maximum: 0.999 },
      },
      required: ['values'],
      additionalProperties: false,
    },
    async run(args) {
      const values = numbers(args.values);
      const level = args.level || 0.95;
      const z = level === 0.9 ? 1.645 : level === 0.99 ? 2.576 : 1.96;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1));
      const margin = (z * sd) / Math.sqrt(values.length);
      return { ok: true, n: values.length, mean: round(mean), sd: round(sd), level, z, low: round(mean - margin), high: round(mean + margin), method: 'normal approximation (not a t-interval)' };
    },
    format: (data) => `[${data.low}, ${data.high}]`,
  },
  {
    name: 'stats.two_proportion',
    title: 'Two-proportion z-test',
    description: 'Computes a pooled two-proportion z statistic and a two-sided normal p-value for A/B counts. It reports assumptions and warns when counts are small.',
    category: 'math',
    permission: 'read',
    tags: ['statistics', 'ab test', 'proportion', 'z test'],
    parameters: {
      type: 'object',
      properties: {
        successesA: { type: 'number', minimum: 0 },
        totalA: { type: 'number', minimum: 1 },
        successesB: { type: 'number', minimum: 0 },
        totalB: { type: 'number', minimum: 1 },
      },
      required: ['successesA', 'totalA', 'successesB', 'totalB'],
      additionalProperties: false,
    },
    async run(args) {
      if (args.successesA > args.totalA || args.successesB > args.totalB) return { ok: false, code: 'BAD_COUNTS', message: 'successes cannot exceed the total' };
      const pA = args.successesA / args.totalA;
      const pB = args.successesB / args.totalB;
      const pooled = (args.successesA + args.successesB) / (args.totalA + args.totalB);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / args.totalA + 1 / args.totalB));
      const z = se ? (pA - pB) / se : 0;
      const erf = (value) => {
        const sign = value < 0 ? -1 : 1;
        const x = Math.abs(value);
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        const t = 1 / (1 + p * x);
        const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
        return sign * y;
      };
      const pValue = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
      return { ok: true, pA: round(pA, 4), pB: round(pB, 4), difference: round(pA - pB, 4), z: round(z), pValue: round(pValue, 4), smallSample: args.totalA < 30 || args.totalB < 30, assumptions: 'independent observations, pooled normal approximation' };
    },
    format: (data) => (data.ok ? `z=${data.z}, p=${data.pValue}` : data.message),
  },
];
