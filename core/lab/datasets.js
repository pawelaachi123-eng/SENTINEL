'use strict';

/**
 * Versioned, content-addressed datasets for the training lab.
 *
 * A dataset version is immutable: creating it writes JSONL plus a manifest that
 * records the SHA-256 of the exact bytes, row count, schema, parent version and
 * whether personal data is involved. Splits are deterministic from a seed, so a
 * reported evaluation can be reproduced. Personal data requires an approving
 * identity before it is written; the approval is stored in the manifest.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fnv1a(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < String(text).length; index += 1) {
    value ^= String(text).charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function validateRow(row, schema) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'row must be an object';
  for (const [key, rule] of Object.entries(schema || {})) {
    const type = typeof rule === 'string' ? rule : rule && rule.type;
    const value = row[key];
    if (rule && rule.required !== false && value === undefined) return `missing ${key}`;
    if (value === undefined) continue;
    if (type === 'string' && typeof value !== 'string') return `${key} must be a string`;
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${key} must be a finite number`;
    if (type === 'integer' && !Number.isInteger(value)) return `${key} must be an integer`;
    if (type === 'boolean' && typeof value !== 'boolean') return `${key} must be a boolean`;
    if (type === 'array' && !Array.isArray(value)) return `${key} must be an array`;
    if (rule && Number.isInteger(rule.maxLength) && typeof value === 'string' && value.length > rule.maxLength) return `${key} is longer than ${rule.maxLength}`;
  }
  return null;
}

/** Refuses to keep datasets inside the source tree. */
function assertOutsideSource(directory, sourceRoot) {
  if (!sourceRoot) return true;
  const resolved = path.resolve(directory);
  const root = path.resolve(sourceRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) throw fail(`datasets must live outside the source tree (${directory} is inside ${sourceRoot})`, 'DATA_INSIDE_SOURCE');
  return true;
}

class DatasetRegistry {
  constructor({ dataDir, sourceRoot = null, log = null, now = () => Date.now() } = {}) {
    if (!dataDir) throw fail('DatasetRegistry needs dataDir', 'BAD_ARGUMENT');
    assertOutsideSource(dataDir, sourceRoot);
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.root = path.join(dataDir, 'datasets');
  }

  namePath(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(String(name || ''))) throw fail('dataset name must be a simple slug', 'BAD_NAME');
    return path.join(this.root, name);
  }

  /** Creates an immutable version. Returns its manifest. */
  create({ name, rows, schema = null, source = 'authored', parent = null, personalData = false, approvedBy = null, notes = null, labels = null }) {
    if (!Array.isArray(rows) || !rows.length) throw fail('a dataset needs at least one row', 'EMPTY_DATASET');
    if (personalData && !approvedBy) throw fail('personal data needs an explicit approving identity (approvedBy)', 'APPROVAL_REQUIRED');
    rows.forEach((row, index) => {
      const problem = validateRow(row, schema);
      if (problem) throw fail(`row ${index}: ${problem}`, 'BAD_ROW');
    });
    const directory = this.namePath(name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const digest = hash(body);
    const existing = fs.existsSync(directory) ? this.versions(name) : [];
    const version = existing.length + 1;
    const file = path.join(directory, `v${version}.jsonl`);
    fs.writeFileSync(file, body, { mode: 0o600 });
    const manifest = {
      name,
      version,
      file,
      format: 'jsonl',
      rows: rows.length,
      schema,
      source,
      parent,
      personalData: Boolean(personalData),
      approvedBy: personalData ? approvedBy : null,
      notes,
      labels,
      sha256: digest,
      bytes: Buffer.byteLength(body),
      createdAt: this.now(),
    };
    const manifestFile = path.join(directory, `v${version}.json`);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (this.log) this.log.info('lab', `dataset ${name} v${version}: ${rows.length} rows (${digest.slice(0, 12)})`);
    return { ...manifest, manifestFile };
  }

  versions(name) {
    const directory = this.namePath(name);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((entry) => /^v\d+\.json$/.test(entry))
      .map((entry) => Number(entry.slice(1, -5)))
      .sort((a, b) => a - b);
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => this.versions(entry.name).map((version) => this.get(entry.name, version)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(name, version) {
    const directory = this.namePath(name);
    const file = path.join(directory, `v${version}.json`);
    if (!fs.existsSync(file)) throw fail(`dataset ${name} v${version} does not exist`, 'NOT_FOUND');
    return { ...JSON.parse(fs.readFileSync(file, 'utf8')), manifestFile: file };
  }

  latest(name) {
    const versions = this.versions(name);
    if (!versions.length) throw fail(`dataset ${name} has no versions`, 'NOT_FOUND');
    return this.get(name, versions[versions.length - 1]);
  }

  /** Reads and verifies bytes against the manifest hash before returning rows. */
  load(name, version = null) {
    const manifest = version == null ? this.latest(name) : this.get(name, version);
    const raw = fs.readFileSync(manifest.file);
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    if (digest !== manifest.sha256) throw fail(`dataset ${name} v${manifest.version} is corrupt (hash mismatch)`, 'CORRUPT_DATASET');
    const rows = raw.toString('utf8').split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw fail(`dataset ${name} v${manifest.version} line ${index + 1} is not JSON`, 'CORRUPT_DATASET'); }
    });
    if (rows.length !== manifest.rows) throw fail(`dataset ${name} v${manifest.version} row count mismatch`, 'CORRUPT_DATASET');
    return { manifest, rows };
  }

  /** Deterministic, group-aware split. The same seed always yields the same membership. */
  split(name, { version = null, seed = 42, ratios = { train: 0.7, validation: 0.15, test: 0.15 }, groupKey = null } = {}) {
    const { manifest, rows } = this.load(name, version);
    const total = Object.values(ratios).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 1e-6) throw fail('split ratios must sum to 1', 'BAD_SPLIT');
    const keys = Object.keys(ratios);
    // Rows that share a group key (the same normalised text by default) can
    // never appear in two splits. That is the difference between a random row
    // split and a leakage-free split: near-duplicate rows otherwise teach on
    // one side and grade on the other.
    const keyOf = (row) => {
      if (typeof groupKey === 'function') return String(groupKey(row));
      if (typeof groupKey === 'string') return String(row[groupKey]);
      const text = typeof row.text === 'string' ? row.text : JSON.stringify(row);
      return text.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
    };
    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const ordered = [...groups.entries()]
      .map(([key, members]) => ({ key, members, order: mulberry32(seed + fnv1a(key))() }))
      .sort((a, b) => a.order - b.order);
    const out = Object.fromEntries(keys.map((key) => [key, []]));
    if (ordered.length >= keys.length) {
      const counts = Object.fromEntries(keys.map((key) => [key, 0]));
      for (const group of ordered) {
        // Assign to the split furthest below its target share; this keeps the
        // ratios close without ever splitting a group.
        let best = keys[0];
        let bestDeficit = -Infinity;
        for (const key of keys) {
          const target = group.members.length === 0 ? 0 : (counts[key] + group.members.length) / Math.max(1e-9, ratios[key]);
          const deficit = -target;
          if (deficit > bestDeficit) { bestDeficit = deficit; best = key; }
        }
        out[best].push(...group.members);
        counts[best] += group.members.length;
      }
      // Guarantee every split gets at least one group when there are enough.
      for (const key of keys) {
        if (out[key].length) continue;
        const donor = keys.find((candidate) => out[candidate].length > 1);
        if (!donor) continue;
        out[key].push(out[donor].pop());
      }
    } else {
      const shuffledRows = rows.map((row, index) => ({ row, order: mulberry32(seed + index)() })).sort((a, b) => a.order - b.order).map((entry) => entry.row);
      let cursor = 0;
      for (const key of keys) {
        const size = key === keys[keys.length - 1] ? shuffledRows.length - cursor : Math.floor(shuffledRows.length * ratios[key]);
        out[key] = shuffledRows.slice(cursor, cursor + size);
        cursor += size;
      }
    }
    const membership = new Map();
    let leakedGroups = 0;
    for (const key of keys) {
      const seen = new Set();
      for (const row of out[key]) seen.add(keyOf(row));
      for (const group of seen) {
        if (membership.has(group) && membership.get(group) !== key) leakedGroups += 1;
        membership.set(group, key);
      }
    }
    const sizes = Object.fromEntries(keys.map((key) => [key, out[key].length]));
    return {
      manifest: { name: manifest.name, version: manifest.version, sha256: manifest.sha256 },
      seed,
      sizes,
      groups: groups.size,
      groupAware: ordered.length >= keys.length,
      leakage: { groupsAcrossSplits: leakedGroups, duplicateGroups: groups.size - ordered.length },
      ...out,
    };
  }

  /** Cheap dataset health: duplicates, empty text, label balance. */
  audit(name, { version = null, textKey = 'text', labelKey = 'label' } = {}) {
    const { manifest, rows } = this.load(name, version);
    const seen = new Map();
    const labels = {};
    let empty = 0;
    let duplicates = 0;
    for (const row of rows) {
      const text = typeof row[textKey] === 'string' ? row[textKey].trim() : '';
      if (!text) empty += 1;
      const key = text.toLowerCase();
      if (seen.has(key)) duplicates += 1;
      seen.set(key, true);
      if (row[labelKey] !== undefined) labels[row[labelKey]] = (labels[row[labelKey]] || 0) + 1;
    }
    return { name: manifest.name, version: manifest.version, rows: rows.length, empty, duplicates, labels, sha256: manifest.sha256, personalData: manifest.personalData };
  }
}

module.exports = { DatasetRegistry, validateRow, canonicalJson, assertOutsideSource, mulberry32 };
