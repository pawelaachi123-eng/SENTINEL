'use strict';

/**
 * Adapter registry: saved LoRA/QLoRA/distillation/preference artifacts with
 * checksums, measured metrics, side-by-side comparison, promotion and rollback.
 *
 * Promotion requires an approving identity and a measured metric; an adapter
 * with no evaluation cannot become active. Rollback is a pointer move, not a
 * deletion, so the previous artifact remains reproducible.
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

function safeName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,70}$/i.test(String(name || ''));
}

class AdapterRegistry {
  constructor({ dataDir, log = null, now = () => Date.now() } = {}) {
    if (!dataDir) throw fail('AdapterRegistry needs dataDir', 'BAD_ARGUMENT');
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'adapters');
    this.log = log;
    this.now = now;
    this.indexFile = path.join(this.dir, 'index.json');
  }

  load() {
    if (!fs.existsSync(this.indexFile)) return { version: 1, active: null, history: [], artifacts: [] };
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch (err) { throw fail(`adapter index is corrupt: ${err.message}`, 'CORRUPT_INDEX'); }
  }

  saveIndex(index) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(index, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.indexFile);
  }

  create({ name, kind, payload, metrics = null, dataset = null, base = null, notes = null }) {
    if (!safeName(name)) throw fail('adapter name must be a simple slug', 'BAD_NAME');
    if (!payload || typeof payload !== 'object') throw fail('adapter payload must be an object', 'BAD_PAYLOAD');
    if (!['lora', 'qlora', 'distilled', 'preference', 'gpt', 'mlp', 'transformer'].includes(kind)) throw fail(`unknown adapter kind ${kind}`, 'BAD_KIND');
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw fail('adapter payload is larger than 64 MB', 'TOO_LARGE');
    const id = `${name}_${this.now()}_${hash(serialized).slice(0, 8)}`;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${id}.json`);
    const digest = hash(serialized);
    fs.writeFileSync(file, serialized, { mode: 0o600 });
    const index = this.load();
    const artifact = {
      id,
      name,
      kind,
      file,
      sha256: digest,
      bytes: Buffer.byteLength(serialized),
      metrics,
      dataset,
      base,
      notes,
      createdAt: this.now(),
      promotedAt: null,
      approvedBy: null,
    };
    index.artifacts.push(artifact);
    index.version = (index.version || 1) + 1;
    this.saveIndex(index);
    return { ...artifact };
  }

  list({ name = null, kind = null, limit = 50 } = {}) {
    const index = this.load();
    return index.artifacts
      .filter((artifact) => (!name || artifact.name === name) && (!kind || artifact.kind === kind))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((artifact) => ({ ...artifact, active: index.active === artifact.id }));
  }

  get(id) {
    const index = this.load();
    const artifact = index.artifacts.find((entry) => entry.id === id);
    return artifact ? { ...artifact, active: index.active === id } : null;
  }

  /** Reads an artifact and verifies its checksum. */
  loadArtifact(id) {
    const artifact = this.get(id);
    if (!artifact) throw fail(`adapter ${id} not found`, 'NOT_FOUND');
    const raw = fs.readFileSync(artifact.file);
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    if (digest !== artifact.sha256) throw fail(`adapter ${id} is corrupt (hash mismatch)`, 'CORRUPT_ADAPTER');
    return { artifact, payload: JSON.parse(raw.toString('utf8')) };
  }

  active() {
    const index = this.load();
    if (!index.active) return null;
    const artifact = index.artifacts.find((entry) => entry.id === index.active);
    return artifact ? { ...artifact, active: true } : null;
  }

  compare(ids) {
    if (!Array.isArray(ids) || ids.length < 2) throw fail('compare needs at least two adapter ids', 'BAD_ARGUMENT');
    const rows = ids.map((id) => {
      const artifact = this.get(id);
      if (!artifact) throw fail(`adapter ${id} not found`, 'NOT_FOUND');
      return artifact;
    });
    const metrics = new Set(rows.map((row) => row.metrics && typeof row.metrics === 'object' ? Object.keys(row.metrics).sort().join(',') : ''));
    if (metrics.size > 1) throw fail('adapters were evaluated on different metric sets', 'INCOMPARABLE');
    const keys = rows[0].metrics ? Object.keys(rows[0].metrics) : [];
    const table = keys.map((key) => ({ metric: key, values: rows.map((row) => row.metrics ? row.metrics[key] : null) }));
    const ranked = [...rows].sort((a, b) => {
      const left = a.metrics || {};
      const right = b.metrics || {};
      const primary = keys[0] ? (right[keys[0]] || 0) - (left[keys[0]] || 0) : 0;
      return primary;
    });
    return { ok: true, ids, table, ranked: ranked.map((row) => row.id), best: ranked[0] ? ranked[0].id : null };
  }

  evaluate(id, evaluator) {
    const { artifact, payload } = this.loadArtifact(id);
    const metrics = evaluator(payload, artifact);
    if (!metrics || typeof metrics !== 'object') throw fail('evaluator must return a metrics object', 'BAD_EVALUATION');
    const index = this.load();
    const stored = index.artifacts.find((entry) => entry.id === id);
    stored.metrics = metrics;
    stored.evaluatedAt = this.now();
    this.saveIndex(index);
    return { ...stored };
  }

  promote(id, { approvedBy = null, minMetrics = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs an approving identity' };
    const index = this.load();
    const artifact = index.artifacts.find((entry) => entry.id === id);
    if (!artifact) return { ok: false, code: 'NOT_FOUND' };
    if (!artifact.metrics || !Object.keys(artifact.metrics).length) return { ok: false, code: 'NO_METRICS', message: 'an adapter without evaluation cannot be promoted' };
    for (const [key, minimum] of Object.entries(minMetrics || {})) {
      const value = artifact.metrics[key];
      if (typeof value !== 'number' || value < minimum) return { ok: false, code: 'GATE_FAILED', message: `${key} ${value} is below ${minimum}`, metric: key, value, minimum };
    }
    if (index.active && index.active !== id) index.history.push({ id: index.active, replacedAt: this.now(), approvedBy });
    index.active = id;
    artifact.promotedAt = this.now();
    artifact.approvedBy = approvedBy;
    index.version = (index.version || 1) + 1;
    this.saveIndex(index);
    if (this.log) this.log.info('lab', `promoted adapter ${id} by ${approvedBy}`);
    return { ok: true, active: { ...artifact, active: true } };
  }

  rollback({ approvedBy = null, to = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED' };
    const index = this.load();
    const target = to || (index.history.length ? index.history[index.history.length - 1].id : null);
    if (!target) return { ok: false, code: 'NO_PREVIOUS' };
    const artifact = index.artifacts.find((entry) => entry.id === target);
    if (!artifact) return { ok: false, code: 'NOT_FOUND' };
    if (index.active) index.history.push({ id: index.active, replacedAt: this.now(), approvedBy, reason: 'rollback' });
    index.active = target;
    index.version = (index.version || 1) + 1;
    this.saveIndex(index);
    return { ok: true, active: { ...artifact, active: true }, history: index.history.slice(-5) };
  }

  /** Deterministic export for backup or moving an adapter between machines. */
  exportArtifact(id) {
    const { artifact, payload } = this.loadArtifact(id);
    const text = JSON.stringify({ format: 'sentinel-adapter-v1', artifact: { ...artifact, file: undefined }, payload });
    return { ok: true, id, sha256: hash(text), bytes: Buffer.byteLength(text), text };
  }
}

module.exports = { AdapterRegistry };
