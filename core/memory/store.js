'use strict';

/**
 * Durable document store for everything the assistant remembers.
 *
 * Two drivers, one interface:
 *
 *   sqlite  — real SQLite via node:sqlite (WAL, indices, transactions).
 *             Present in Node 22+, so this is what normally runs.
 *   jsonl   — append-only journal + in-memory index. Used when node:sqlite is
 *             missing (some packaged builds) so memory never silently vanishes.
 *
 * Records are `(collection, id) → JSON document`. Collections are the memory
 * kinds, knowledge chunks, tasks, automations, approvals and learning
 * statistics. Nothing here knows what the documents mean.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;

function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ── SQLite driver ─────────────────────────────────────────────────────── */

class SqliteDriver {
  constructor({ file }) {
    // node:sqlite is experimental; suppress the one-off warning noise but keep
    // it visible under SENTINEL_DEBUG.
    const originalEmit = process.emitWarning;
    if (!process.env.SENTINEL_DEBUG) {
      process.emitWarning = (warning, ...rest) => {
        const text = typeof warning === 'string' ? warning : warning && warning.message;
        if (text && text.includes('SQLite is an experimental feature')) return;
        return originalEmit.call(process, warning, ...rest);
      };
    }
    try {
      // eslint-disable-next-line global-require
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(file);
    } finally {
      process.emitWarning = originalEmit;
    }
    this.kind = 'sqlite';
    this.file = file;
    this.fts = false;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 4000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        doc TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS records_collection_ts ON records (collection, ts DESC);
    `);
    this.putStatement = this.db.prepare(
      'INSERT INTO records (collection, id, doc, ts) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc, ts = excluded.ts',
    );
    this.getStatement = this.db.prepare('SELECT doc FROM records WHERE collection = ? AND id = ?');
    this.deleteStatement = this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?');
    this.listStatement = this.db.prepare('SELECT doc FROM records WHERE collection = ? ORDER BY ts ASC');
    this.countStatement = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?');
    this.clearStatement = this.db.prepare('DELETE FROM records WHERE collection = ?');
    this.setMeta('schema', String(SCHEMA_VERSION));

    // FTS5 is a real lexical index living beside the JSON records: it survives
    // restarts, so a cold start can still search before every row is re-read.
    // It is optional — an SQLite build without FTS5 simply keeps the in-memory
    // BM25 path, and the store reports `fts: false` instead of pretending.
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(collection UNINDEXED, id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')",
      );
      this.ftsInsert = this.db.prepare('INSERT INTO records_fts (collection, id, body) VALUES (?, ?, ?)');
      this.ftsDelete = this.db.prepare('DELETE FROM records_fts WHERE collection = ? AND id = ?');
      this.ftsSearch = this.db.prepare(
        'SELECT collection, id, bm25(records_fts) AS rank FROM records_fts WHERE records_fts MATCH ? AND collection = ? ORDER BY rank LIMIT ?',
      );
      this.fts = true;
      // A store created before 3.0 is backfilled once, idempotently.
      if (this.getMeta('fts') !== '1') this.backfillFts();
    } catch (err) {
      this.ftsError = err.message;
    }
  }

  get schemaVersion() {
    const row = this.getStatement.get('meta', 'schema');
    return row ? Number(JSON.parse(row.doc).value) : 0;
  }

  setMeta(key, value) {
    this.putStatement.run('meta', key, JSON.stringify({ value }), Date.now());
  }

  getMeta(key, fallback = null) {
    const row = this.getStatement.get('meta', key);
    return row ? JSON.parse(row.doc).value : fallback;
  }

  put(collection, id, doc) {
    this.putStatement.run(collection, id, JSON.stringify(doc), Date.now());
    this.syncFts(collection, id, doc);
    return doc;
  }

  /** Keeps the lexical index in step; metadata rows are skipped. */
  syncFts(collection, id, doc) {
    if (!this.fts || !doc) return;
    const body = [doc.text, doc.title, doc.path, doc.error, (doc.tags || []).join(' ')].filter(Boolean).join(' ');
    if (!body) return;
    try {
      this.ftsDelete.run(collection, id);
      this.ftsInsert.run(collection, id, body.slice(0, 200000));
    } catch (err) {
      this.ftsError = err.message;
    }
  }

  searchFts(query, { collection = 'memory', limit = 20 } = {}) {
    if (!this.fts) return [];
    const terms = String(query || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 1)
      .slice(0, 12)
      .map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return [];
    try {
      return this.ftsSearch.all(terms.join(' OR '), collection, limit).map((row) => ({ collection: row.collection, id: row.id, rank: row.rank }));
    } catch {
      return [];
    }
  }

  /** One-off backfill for stores created before the FTS index existed. */
  backfillFts() {
    if (!this.fts) return { fts: false, indexed: 0 };
    const rows = this.db.prepare('SELECT collection, id, doc FROM records').all();
    let indexed = 0;
    for (const row of rows) {
      try {
        this.syncFts(row.collection, row.id, JSON.parse(row.doc));
        indexed += 1;
      } catch {
        /* a single bad row must not abort the migration */
      }
    }
    this.setMeta('fts', '1');
    return { fts: true, indexed };
  }

  putMany(collection, entries) {
    this.db.exec('BEGIN');
    try {
      for (const [id, doc] of entries) this.putStatement.run(collection, id, JSON.stringify(doc), Date.now());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return entries.length;
  }

  get(collection, id) {
    const row = this.getStatement.get(collection, id);
    return row ? JSON.parse(row.doc) : null;
  }

  delete(collection, id) {
    const info = this.deleteStatement.run(collection, id);
    if (this.fts) {
      try {
        this.ftsDelete.run(collection, id);
      } catch {
        /* the lexical index is an optimisation, never a source of truth */
      }
    }
    return info.changes > 0;
  }

  list(collection, { limit = 0, offset = 0 } = {}) {
    const rows = this.listStatement.all(collection);
    const docs = rows.map((row) => JSON.parse(row.doc));
    if (offset || limit) return docs.slice(offset, limit ? offset + limit : undefined);
    return docs;
  }

  count(collection) {
    return this.countStatement.get(collection).n;
  }

  clear(collection) {
    this.clearStatement.run(collection);
    if (this.fts) {
      try {
        this.db.prepare('DELETE FROM records_fts WHERE collection = ?').run(collection);
      } catch {
        /* ignore */
      }
    }
  }

  collections() {
    const rows = this.db.prepare('SELECT collection AS name, COUNT(*) AS n FROM records GROUP BY collection').all();
    return rows.map((row) => ({ name: row.name, count: row.n }));
  }

  stats() {
    return { driver: 'sqlite', file: this.file, bytes: fileSize(this.file), collections: this.collections(), fts: this.fts, ftsError: this.ftsError || null };
  }

  backup(destination) {
    ensureDir(path.dirname(destination));
    const { backup } = require('node:sqlite');
    // backup() is async in node:sqlite; callers use backupAsync().
    return backup(this.db, destination);
  }

  async backupAsync(destination) {
    ensureDir(path.dirname(destination));
    const { backup } = require('node:sqlite');
    await backup(this.db, destination);
    return destination;
  }

  compact() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/* ── JSONL driver ──────────────────────────────────────────────────────── */

class JsonlDriver {
  // The journal driver has no lexical index; callers check `fts` and fall back.
  fts = false;

  searchFts() {
    return [];
  }

  backfillFts() {
    return { fts: false, indexed: 0 };
  }

  constructor({ file }) {
    this.kind = 'jsonl';
    this.file = file;
    this.journal = `${file}.jsonl`;
    this.data = new Map(); // collection → Map(id → doc)
    ensureDir(path.dirname(file));
    this.load();
    this.fd = fs.openSync(this.journal, 'a');
    this.pending = 0;
  }

  get schemaVersion() {
    return Number(this.getMeta('schema', SCHEMA_VERSION));
  }

  setMeta(key, value) {
    this.meta.set(key, value);
    this.append({ c: 'meta', k: key, v: value });
  }

  getMeta(key, fallback = null) {
    return this.meta.has(key) ? this.meta.get(key) : fallback;
  }

  load() {
    this.meta = new Map();
    if (!fs.existsSync(this.journal)) return;
    const lines = fs.readFileSync(this.journal, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn final line after a crash: ignore it
      }
      if (entry.c === 'meta') {
        this.meta.set(entry.k, entry.v);
        continue;
      }
      if (entry.c === 'del') {
        const map = this.data.get(entry.col);
        if (map) map.delete(entry.id);
        continue;
      }
      if (!this.data.has(entry.col)) this.data.set(entry.col, new Map());
      this.data.get(entry.col).set(entry.id, entry.doc);
    }
  }

  append(entry) {
    fs.writeSync(this.fd, `${JSON.stringify(entry)}\n`);
    this.pending += 1;
  }

  put(collection, id, doc) {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    this.data.get(collection).set(id, doc);
    this.append({ c: 'put', col: collection, id, doc });
    return doc;
  }

  putMany(collection, entries) {
    for (const [id, doc] of entries) this.put(collection, id, doc);
    return entries.length;
  }

  get(collection, id) {
    const map = this.data.get(collection);
    return map ? map.get(id) || null : null;
  }

  delete(collection, id) {
    const map = this.data.get(collection);
    if (!map || !map.has(id)) return false;
    map.delete(id);
    this.append({ c: 'del', col: collection, id });
    return true;
  }

  list(collection, { limit = 0, offset = 0 } = {}) {
    const docs = [...(this.data.get(collection) || new Map()).values()];
    if (offset || limit) return docs.slice(offset, limit ? offset + limit : undefined);
    return docs;
  }

  count(collection) {
    const map = this.data.get(collection);
    return map ? map.size : 0;
  }

  clear(collection) {
    for (const id of [...(this.data.get(collection) || new Map()).keys()]) this.delete(collection, id);
  }

  collections() {
    return [...this.data.entries()].map(([name, map]) => ({ name, count: map.size }));
  }

  stats() {
    return { driver: 'jsonl', file: this.journal, bytes: fileSize(this.journal), collections: this.collections() };
  }

  compact() {
    const tmp = `${this.journal}.tmp`;
    const out = fs.openSync(tmp, 'w');
    try {
      for (const [k, v] of this.meta) fs.writeSync(out, `${JSON.stringify({ c: 'meta', k, v })}\n`);
      for (const [col, map] of this.data) {
        for (const [id, doc] of map) fs.writeSync(out, `${JSON.stringify({ c: 'put', col, id, doc })}\n`);
      }
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(tmp, this.journal);
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = fs.openSync(this.journal, 'a');
    this.pending = 0;
  }

  async backupAsync(destination) {
    ensureDir(path.dirname(destination));
    fs.copyFileSync(this.journal, destination);
    return destination;
  }

  backup(destination) {
    return this.backupAsync(destination);
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Opens (or creates) a store. `prefer: 'jsonl'` is used by tests to exercise
 * the fallback path on purpose.
 */
function openStore({ dir, name = 'memory', prefer = null }) {
  ensureDir(dir);
  const base = path.join(dir, name);
  if (prefer !== 'jsonl') {
    try {
      return new SqliteDriver({ file: `${base}.sqlite` });
    } catch (err) {
      if (prefer === 'sqlite') throw err;
      // Fall through to the journal driver.
    }
  }
  return new JsonlDriver({ file: base });
}

/** Moves an older single-file store forward if the schema changed. */
function migrate(driver, { log } = {}) {
  const current = driver.getMeta('schema', 0) || 0;
  if (current >= SCHEMA_VERSION) return { from: current, to: current, applied: false };
  driver.setMeta('schema', String(SCHEMA_VERSION));
  if (log) log.info('store', `store schema ${current} → ${SCHEMA_VERSION}`);
  return { from: current, to: SCHEMA_VERSION, applied: true };
}

module.exports = { openStore, migrate, newId, ensureDir, SCHEMA_VERSION };
