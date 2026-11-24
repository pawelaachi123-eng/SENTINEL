'use strict';

/**
 * Persistent memory.
 *
 * Eight kinds, one store:
 *
 *   short_term  — the current conversation, pruned aggressively
 *   working     — scratch space for the task being executed right now
 *   long_term   — durable facts about the user, machine and preferences
 *   episodic    — "what happened": task, strategy, outcome, duration
 *   semantic    — concepts and relations ("4060 Ti has 8 GB VRAM")
 *   procedural  — how to do something that worked before
 *   project     — repository/domain knowledge
 *   errors      — failures and the fix that actually worked
 *
 * Retrieval is hybrid (BM25 + vector, fused with RRF) and ranking adds recency,
 * importance and how often a memory has been useful. Duplicates collapse.
 *
 * Secrets are never stored: a memory that looks like a key, token, password or
 * card number is refused and reported, because "remember this" is exactly how a
 * credential ends up in a database nobody rotates.
 */

const { Bm25Index, hybridSearch } = require('./search');
const { HashingEmbedder, encodeVector, decodeVector, cosine, expandQuery } = require('./embeddings');
const { newId } = require('./store');

const KINDS = ['short_term', 'working', 'long_term', 'episodic', 'semantic', 'procedural', 'project', 'errors'];

const { scan: scanInjection } = require('../security/injection');

const SECRET_PATTERNS = [
  { name: 'hex key', re: /\b[0-9a-fA-F]{48,}\b/ },
  { name: 'openai-style key', re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'bearer token', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Polish puts a word between the label and the value: "hasło to abc123".
  { name: 'password assignment', re: /\b(password|passwd|hasło|haslo|secret|api[_-]?key|token|klucz)\b\s*(?:[:=]|to|jest|=)\s*\S{6,}/i },
  // "hasło do bazy: tajne123" — a few words may sit between the label and value.
  { name: 'password assignment', re: /\b(password|passwd|hasło|haslo|secret|api[_-]?key|token|klucz)\b[^.\n]{0,24}[:=]\s*\S{4,}/i },
  { name: 'aws key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'card number', re: /\b(?:\d[ -]*?){13,19}\b/ },
];

function looksSecret(text) {
  const value = String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(value)) return pattern.name;
  }
  return null;
}

const HALF_LIFE_DAYS = 21;

class Memory {
  constructor({ store, embedder, log, config, now = () => Date.now() }) {
    this.store = store;
    this.embedder = embedder || new HashingEmbedder();
    this.log = log;
    this.config = config;
    this.now = now;
    this.collection = 'memory';
    this.turnCollection = 'turns';
    this.summaryCollection = 'conversation_summaries';
    this.index = new Bm25Index();
    this.cache = new Map(); // id → record
    this.loaded = false;
    this.maxPerKind = 4000;
    this.vectorCache = new Map(); // id → Float32Array
    this.counters = { writes: 0, reads: 0, merges: 0, rejected: 0 };
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  load() {
    if (this.loaded) return;
    for (const record of this.store.list(this.collection)) {
      this.cache.set(record.id, record);
      this.index.add(record.id, `${record.text} ${(record.tags || []).join(' ')}`);
    }
    this.loaded = true;
  }

  vectorOf(record) {
    if (!record || !record.vector) return null;
    let vector = this.vectorCache.get(record.id);
    if (!vector || vector.length !== record.dim) {
      vector = decodeVector(record.vector);
      this.vectorCache.set(record.id, vector);
    }
    return vector;
  }

  async embedTexts(texts) {
    try {
      return await this.embedder.embed(texts);
    } catch (err) {
      if (this.log) this.log.warn('memory', `embedding failed (${err.message}); using local hashing`);
      const local = new HashingEmbedder();
      return local.embed(texts);
    }
  }

  /* ── writing ────────────────────────────────────────────────────────── */

  /**
   * @returns {Promise<{record: object|null, merged?: boolean, rejected?: string}>}
   */
  async remember({
    kind = 'long_term',
    text,
    tags = [],
    importance = 0.5,
    source = 'user',
    meta = {},
    sessionId = null,
    dedupe = true,
    scope = 'global',
    confidence = 0.8,
    provenance = null,
    expiresAt = null,
  } = {}) {
    this.load();
    const clean = String(text || '').trim();
    if (!clean) return { record: null, rejected: 'empty' };
    if (!KINDS.includes(kind)) kind = 'long_term';

    const secret = looksSecret(clean);
    if (secret) {
      this.counters.rejected += 1;
      if (this.log) this.log.warn('memory', `refused to store a ${secret} as a memory`, { source });
      return { record: null, rejected: `looks like a ${secret}` };
    }

    // "Remember this" is also how a hostile page gets instructions into future
    // turns, so memory is screened like any other untrusted text.
    const injection = scanInjection(clean);
    if (injection.findings.length && injection.risk >= 0.35) {
      this.counters.rejected += 1;
      if (this.log) this.log.warn('memory', 'refused to store text that looks like instructions to an AI', { source, ids: injection.findings.map((finding) => finding.id) });
      return { record: null, rejected: 'looks like an instruction to the assistant, not a fact' };
    }

    const [vector] = await this.embedTexts([clean]);
    const now = this.now();

    // A contradiction is not a duplicate: both facts are kept, both are marked,
    // and the caller is told so it can ask which one is true instead of silently
    // overwriting the user's reality.
    const conflicts = this.findConflicts({ kind, scope, vector, text: clean, dim: vector ? vector.length : 0 });

    if (dedupe) {
      const duplicate = this.findDuplicate(kind, vector, clean);
      if (duplicate) {
        duplicate.accessCount = (duplicate.accessCount || 0) + 1;
        duplicate.lastAccess = now;
        duplicate.importance = Math.min(1, (duplicate.importance || 0.5) + 0.05);
        duplicate.tags = [...new Set([...(duplicate.tags || []), ...tags])].slice(0, 12);
        if (meta && Object.keys(meta).length) duplicate.meta = { ...duplicate.meta, ...meta };
        duplicate.updatedAt = now;
        this.persist(duplicate);
        this.counters.merges += 1;
        return { record: duplicate, merged: true };
      }
    }

    const record = {
      id: newId('mem'),
      kind,
      scope,
      confidence: clamp01(confidence),
      provenance: provenance || { source, capturedAt: now, runId: null, documentId: null },
      expiresAt: expiresAt || null,
      supersededBy: null,
      conflictWith: conflicts.map((entry) => entry.id),
      text: clean,
      tags: [...new Set(tags.filter(Boolean))].slice(0, 12),
      source,
      importance: clamp01(importance),
      sessionId,
      meta,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccess: now,
      dim: vector ? vector.length : 0,
      vectorName: this.embedder.name || 'unknown',
      vector: vector ? encodeVector(vector) : null,
    };
    this.cache.set(record.id, record);
    if (vector) this.vectorCache.set(record.id, vector);
    this.index.add(record.id, `${record.text} ${record.tags.join(' ')}`);
    this.store.put(this.collection, record.id, record);
    this.counters.writes += 1;
    for (const conflict of conflicts) {
      const existing = this.cache.get(conflict.id);
      if (!existing) continue;
      existing.conflictWith = [...new Set([...(existing.conflictWith || []), record.id])];
      this.persist(existing);
    }
    if (conflicts.length) this.counters.conflicts = (this.counters.conflicts || 0) + 1;
    this.enforceKindLimit(kind);
    return { record, conflicts: conflicts.map((entry) => ({ id: entry.id, text: entry.text.slice(0, 160), similarity: entry.similarity })) };
  }

  findDuplicate(kind, vector, text) {
    if (!vector) return null;
    let best = null;
    let bestScore = 0;
    for (const record of this.cache.values()) {
      if (record.kind !== kind) continue;
      let similarity = 0;
      const other = this.vectorOf(record);
      if (other && record.dim === vector.length) similarity = cosine(vector, other);
      else similarity = record.text.trim().toLowerCase() === text.trim().toLowerCase() ? 1 : 0;
      if (similarity > bestScore) {
        bestScore = similarity;
        best = record;
      }
    }
    // Very short memories ("ok", "yes") would merge with everything; require a
    // near-exact match there.
    const threshold = text.length < 24 ? 0.99 : 0.93;
    return bestScore >= threshold ? best : null;
  }

  persist(record) {
    this.store.put(this.collection, record.id, record);
    this.counters.writes += 1;
  }

  enforceKindLimit(kind) {
    const ofKind = [...this.cache.values()].filter((record) => record.kind === kind);
    if (ofKind.length <= this.maxPerKind) return;
    ofKind
      .sort((a, b) => this.rank(b) - this.rank(a))
      .slice(this.maxPerKind)
      .forEach((record) => this.forget(record.id, { quiet: true }));
  }

  /* ── reading ────────────────────────────────────────────────────────── */

  rank(record, now = this.now()) {
    const ageDays = Math.max(0, (now - (record.updatedAt || record.createdAt || now)) / 86400000);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const importance = clamp01(record.importance ?? 0.5);
    const frequency = Math.min(1, Math.log1p(record.accessCount || 0) / Math.log(11));
    return 0.18 * recency + 0.14 * importance + 0.08 * frequency;
  }

  /**
   * Hybrid recall. Returns records with the reason they matched, so the
   * assistant can cite them and the user can see why something surfaced.
   */
  async recall(query, { kinds = null, limit = 8, minScore = 0.0008, sessionId = null, boostImportance = true, scope = null, asOf = null, includeSuperseded = false } = {}) {
    this.load();
    this.counters.reads += 1;
    const text = String(query || '').trim();
    const at = Number(asOf) || null;
    const candidates = [...this.cache.values()].filter((record) => {
      if (kinds && kinds.length && !kinds.includes(record.kind)) return false;
      if (sessionId && record.sessionId && record.sessionId !== sessionId && record.kind === 'short_term') return false;
      if (scope && (record.scope || 'global') !== scope) return false;
      if (!includeSuperseded && record.supersededBy) return false;
      if (!includeSuperseded && record.expiresAt && record.expiresAt < this.now()) return false;
      // Temporal query: "what did we know on that day".
      if (at && (record.createdAt || 0) > at) return false;
      return true;
    });
    if (!candidates.length) return [];
    if (!text) {
      return candidates
        .sort((a, b) => this.rank(b) - this.rank(a))
        .slice(0, limit)
        .map((record) => ({ record, score: this.rank(record), sources: ['recent'] }));
    }

    const [queryVector] = await this.embedTexts([expandQuery(text)]);
    const results = hybridSearch({
      query: text,
      records: candidates.map((record) => ({
        id: record.id,
        text: `${record.text} ${record.tags.join(' ')}`,
        vector: this.vectorOf(record),
        dim: record.dim,
        vectorName: record.vectorName,
      })),
      index: this.index,
      queryVector,
      vectorName: this.embedder.name,
      limit: limit * 3,
      boost: boostImportance ? (record) => 1 + this.rank(this.cache.get(record.id) || {}) : null,
    });

    // Exact-token rescue. Hybrid scoring is good at meaning and can miss a rare
    // identifier, a serial number or an acronym. SQLite FTS5 answers that in
    // microseconds, so any exact hit that the blend did not surface is added
    // with an explicit `fts` provenance instead of being silently lost.
    let ftsHits = [];
    try {
      ftsHits = this.store.searchFts ? this.store.searchFts(text, { collection: this.collection, limit: limit * 2 }) : [];
    } catch {
      ftsHits = [];
    }
    const seen = new Set(results.map((hit) => hit.record.id));

    const now = this.now();
    const out = [];
    for (const hit of results) {
      const record = this.cache.get(hit.record.id);
      if (!record) continue;
      record.lastAccess = now;
      record.accessCount = (record.accessCount || 0) + 1;
      this.store.put(this.collection, record.id, record);
      if (hit.score < minScore) continue;
      out.push({
        record,
        score: hit.score,
        sources: hit.sources,
        lexical: hit.lexicalScore,
        vector: hit.vectorScore,
        provenance: record.provenance || { source: record.source, capturedAt: record.createdAt },
        confidence: record.confidence ?? null,
        conflicted: Boolean((record.conflictWith || []).length),
      });
      if (out.length >= limit) break;
    }

    for (const hit of ftsHits) {
      if (seen.has(hit.id) || out.length >= limit) continue;
      const record = this.cache.get(hit.id);
      if (!record) continue;
      if (kinds && kinds.length && !kinds.includes(record.kind)) continue;
      if (scope && (record.scope || 'global') !== scope) continue;
      if (!includeSuperseded && (record.supersededBy || (record.expiresAt && record.expiresAt < this.now()))) continue;
      if (at && (record.createdAt || 0) > at) continue;
      record.lastAccess = now;
      record.accessCount = (record.accessCount || 0) + 1;
      this.store.put(this.collection, record.id, record);
      out.push({
        record,
        score: minScore + 1e-4,
        sources: ['fts'],
        lexical: 1,
        vector: null,
        provenance: record.provenance || { source: record.source, capturedAt: record.createdAt },
        confidence: record.confidence ?? null,
        conflicted: Boolean((record.conflictWith || []).length),
      });
    }
    return out;
  }


  /* ── memory 3.0: provenance, conflicts, temporal reads ──────────────── */

  /**
   * Finds records that state a *different* number about the same subject.
   * "Dysk ma 512 GB" vs "Dysk ma 2 TB" is a contradiction worth surfacing;
   * two unrelated records that merely share a word are not.
   */
  findConflicts({ kind, scope = 'global', vector, text, dim }) {
    const numbers = (value) => (String(value).match(/\b\d+(?:[.,]\d+)?\b/g) || []).map((number) => number.replace(',', '.'));
    const mine = numbers(text);
    if (!mine.length) return [];
    const myTokens = new Set(String(text).toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    const out = [];
    for (const record of this.cache.values()) {
      if (record.kind !== kind) continue;
      if ((record.scope || 'global') !== scope) continue;
      if (record.supersededBy) continue;
      const theirs = numbers(record.text);
      if (!theirs.length) continue;
      const theirTokens = new Set(String(record.text).toLowerCase().split(/\W+/).filter((token) => token.length > 2));
      let shared = 0;
      for (const token of myTokens) if (theirTokens.has(token)) shared += 1;
      const overlap = myTokens.size ? shared / myTokens.size : 0;
      if (overlap < 0.6) continue;
      if (mine.join(',') === theirs.join(',')) continue;
      out.push({ id: record.id, text: record.text, similarity: Number(overlap.toFixed(2)) });
      if (out.length >= 4) break;
    }
    return out;
  }

  /** Marks a record as replaced by a newer one; nothing is destroyed. */
  async supersede(id, { text, kind = null, reason = 'updated by the user' } = {}) {
    const old = this.get(id);
    if (!old) throw Object.assign(new Error(`no memory ${id}`), { code: 'NOT_FOUND' });
    const result = await this.remember({
      kind: kind || old.kind,
      text: text || old.text,
      tags: old.tags,
      importance: Math.max(old.importance || 0.5, 0.6),
      source: 'user',
      scope: old.scope || 'global',
      confidence: old.confidence ?? 0.8,
      provenance: { source: 'user', reason, replaces: id, capturedAt: this.now() },
    });
    old.supersededBy = result.record.id;
    this.persist(old);
    return { replaced: old.id, record: result.record };
  }

  /** All pairs the store knows to be in tension. */
  conflicts() {
    this.load();
    const seen = new Set();
    const pairs = [];
    for (const record of this.cache.values()) {
      for (const otherId of record.conflictWith || []) {
        const key = [record.id, otherId].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const other = this.cache.get(otherId);
        if (!other) continue;
        pairs.push({
          a: { id: record.id, text: record.text.slice(0, 200), at: record.createdAt },
          b: { id: other.id, text: other.text.slice(0, 200), at: other.createdAt },
        });
      }
    }
    return pairs.slice(0, 50);
  }

  /**
   * Deterministic consolidation: episodic records from the same day and scope
   * become one semantic summary. No model is involved, so it is cheap, offline
   * and reproducible.
   */
  async consolidate({ minGroup = 6, scope = null } = {}) {
    this.load();
    const groups = new Map();
    for (const record of this.cache.values()) {
      if (record.kind !== 'episodic') continue;
      if (scope && (record.scope || 'global') !== scope) continue;
      if (record.supersededBy) continue;
      const day = new Date(record.createdAt || this.now()).toISOString().slice(0, 10);
      const key = `${day}|${record.scope || 'global'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const created = [];
    for (const [key, records] of groups) {
      if (records.length < minGroup) continue;
      const [day, groupScope] = key.split('|');
      const lines = records.slice(0, 40).map((record) => `- ${record.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      const summary = `Podsumowanie dnia ${day} (${records.length} zdarzeń):\n${lines.join('\n')}`;
      const existing = [...this.cache.values()].find((record) => record.meta && record.meta.consolidates === key);
      if (existing) continue;
      // eslint-disable-next-line no-await-in-loop
      const { record } = await this.remember({
        kind: 'semantic',
        scope: groupScope,
        text: summary,
        tags: ['consolidated', day],
        importance: 0.55,
        confidence: 0.7,
        source: 'consolidator',
        provenance: { source: 'consolidator', capturedAt: this.now(), from: records.map((entry) => entry.id).slice(0, 40) },
        meta: { consolidates: key, events: records.length },
      });
      created.push(record.id);
      for (const entry of records) {
        entry.supersededBy = record.id;
        this.persist(entry);
      }
    }
    return { summaries: created.length, ids: created };
  }

  /** Structural check: dimensions, vector names, dangling references. */
  integrity() {
    this.load();
    const problems = [];
    let checked = 0;
    for (const record of this.cache.values()) {
      checked += 1;
      if (record.supersededBy && !this.cache.has(record.supersededBy)) problems.push({ id: record.id, code: 'DANGLING_SUPERSEDE' });
      for (const other of record.conflictWith || []) {
        if (!this.cache.has(other)) problems.push({ id: record.id, code: 'DANGLING_CONFLICT', other });
      }
      if (record.expiresAt && record.expiresAt < this.now()) problems.push({ id: record.id, code: 'EXPIRED' });
      if (record.vector && record.dim && record.vector.length !== record.dim) problems.push({ id: record.id, code: 'VECTOR_DIM_MISMATCH' });
      if (record.vector && record.vectorName !== this.embedder.name) problems.push({ id: record.id, code: 'VECTOR_EMBEDDER_MISMATCH' });
    }
    return { ok: problems.length === 0, checked, problems: problems.slice(0, 50), embedder: this.embedder.name };
  }

  get(id) {
    this.load();
    return this.cache.get(id) || null;
  }

  list({ kind = null, limit = 100, scope = null, includeSuperseded = false } = {}) {
    this.load();
    return [...this.cache.values()]
      .filter((record) => (kind ? record.kind === kind : true))
      .filter((record) => (scope ? (record.scope || 'global') === scope : true))
      .filter((record) => (includeSuperseded ? true : !record.supersededBy))
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .slice(0, limit);
  }

  forget(id, { quiet = false } = {}) {
    this.load();
    const record = this.cache.get(id);
    if (!record) return false;
    this.cache.delete(id);
    this.vectorCache.delete(id);
    this.index.remove(id);
    this.store.delete(this.collection, id);
    if (!quiet && this.log) this.log.info('memory', `forgot ${record.kind} memory ${id}`);
    return true;
  }

  forgetKind(kind) {
    let count = 0;
    for (const record of [...this.cache.values()]) {
      if (record.kind === kind && this.forget(record.id, { quiet: true })) count += 1;
    }
    return count;
  }

  /* ── conversation ───────────────────────────────────────────────────── */

  /**
   * Structured conversation state.
   *
   * Deterministic on purpose: decisions, constraints, open questions and topics
   * are extracted from what was actually said, with the source turn ids kept for
   * audit. A model may later rephrase the text, but it is never allowed to invent
   * a decision or drop a constraint. Turns that look like they contain a secret
   * are skipped entirely, so a summary cannot become a secret store.
   */
  summarise(sessionId = 'default', { limit = 60 } = {}) {
    const turns = this.turns(sessionId, limit);
    if (!turns.length) return null;
    const stop = new Set('i w na z do to jest sie nie tak jak co czy a the and of to in for is are it that this with без dla oraz ale lub ze za po pod nad przez'.split(' '));
    const topics = new Map();
    const decisions = [];
    const constraints = [];
    const skipped = [];
    const sentences = [];
    for (const turn of turns) {
      if (looksSecret(turn.text)) {
        skipped.push(turn.id);
        continue;
      }
      const text = String(turn.text).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (turn.role === 'user') {
        for (const word of text.toLowerCase().split(/[^a-ząćęłńóśźż0-9.-]+/)) {
          if (word.length < 4 || stop.has(word) || /^\d+$/.test(word)) continue;
          topics.set(word, (topics.get(word) || 0) + 1);
        }
        if (/(ustaw|wybra|postanow|zdecydow|od teraz|na stałe|preferuj|używaj|use |set |choose)/i.test(text)) decisions.push({ text: text.slice(0, 200), turn: turn.id, at: turn.at });
        if (/(nie usuwaj|bez usuwania|tylko (przeczytaj|odczytaj|sprawdź)|nie zmieniaj|do not|don't|read-only|bez zmian)/i.test(text)) constraints.push({ text: text.slice(0, 200), turn: turn.id, at: turn.at });
        sentences.push(text);
      }
    }
    // The last user question is only "open" if nothing followed it.
    const lastTurn = turns[turns.length - 1];
    const lastUserQuestion = [...turns].reverse().find((turn) => turn.role === 'user' && String(turn.text).trim().endsWith('?'));
    const open = [];
    if (lastUserQuestion && lastTurn.role === 'user' && lastUserQuestion.id === lastTurn.id) open.push({ text: String(lastUserQuestion.text).slice(0, 200), turn: lastUserQuestion.id, at: lastUserQuestion.at });
    const topTopics = [...topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([word, count]) => ({ word, count }));
    const summary = {
      id: newId('summary'),
      sessionId,
      turns: turns.length,
      coveredUpTo: lastTurn.id,
      firstAt: turns[0].at,
      lastAt: lastTurn.at,
      topics: topTopics,
      decisions: decisions.slice(-6),
      constraints: constraints.slice(-6),
      openQuestions: open.slice(-3),
      skippedSecrets: skipped.length,
      source: 'deterministic',
      text: [
        topTopics.length ? `Tematy: ${topTopics.map((topic) => topic.word).join(', ')}.` : null,
        decisions.length ? `Decyzje: ${decisions.slice(-3).map((entry) => entry.text).join(' | ')}.` : null,
        constraints.length ? `Ograniczenia: ${constraints.slice(-3).map((entry) => entry.text).join(' | ')}.` : null,
        open.length ? `Otwarte pytanie: ${open[0].text}` : null,
        skipped.length ? `Pominięto ${skipped.length} wypowiedź(-ci) wyglądającą na sekret.` : null,
      ].filter(Boolean).join(' ').slice(0, 1200),
      at: this.now(),
    };
    this.store.put(this.summaryCollection, summary.id, summary);
    return summary;
  }

  summaryFor(sessionId = 'default') {
    const rows = this.store.list(this.summaryCollection).filter((row) => row.sessionId === sessionId);
    return rows.sort((a, b) => b.at - a.at)[0] || null;
  }

  summaries(limit = 20) {
    return this.store.list(this.summaryCollection).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /** Refreshes the summary only when enough new turns accumulated. */
  maybeSummarise(sessionId = 'default', { minTurns = 6 } = {}) {
    const turns = this.turns(sessionId, 200);
    const previous = this.summaryFor(sessionId);
    if (!turns.length) return null;
    if (previous) {
      const recent = turns.filter((turn) => turn.at > previous.lastAt);
      if (recent.length < minTurns) return previous;
    }
    return this.summarise(sessionId);
  }

  appendTurn(sessionId, role, text, meta = {}) {
    const clean = String(text || '').slice(0, 8000);
    if (!clean) return null;
    const id = sessionId || 'default';
    // Two turns appended in the same millisecond used to sort unpredictably,
    // which scrambled the conversation state. Keep the per-session clock
    // strictly increasing instead of trusting the wall clock alone.
    const previous = this.turns(id, 1)[0];
    const at = previous ? Math.max(this.now(), (previous.at || 0) + 1) : this.now();
    const turn = {
      id: newId('turn'),
      sessionId: id,
      role,
      text: clean,
      meta,
      at,
    };
    this.store.put(this.turnCollection, turn.id, turn);
    return turn;
  }

  turns(sessionId = 'default', limit = 20) {
    return this.store
      .list(this.turnCollection)
      .filter((turn) => turn.sessionId === sessionId)
      .sort((a, b) => a.at - b.at)
      .slice(-limit);
  }

  conversations(limit = 50) {
    const bySession = new Map();
    for (const turn of this.store.list(this.turnCollection)) {
      const entry = bySession.get(turn.sessionId) || { sessionId: turn.sessionId, turns: 0, first: turn.at, last: turn.at, preview: '' };
      entry.turns += 1;
      entry.last = Math.max(entry.last, turn.at);
      if (turn.role === 'user' && !entry.preview) entry.preview = turn.text.slice(0, 120);
      bySession.set(turn.sessionId, entry);
    }
    return [...bySession.values()].sort((a, b) => b.last - a.last).slice(0, limit);
  }

  clearTurns(sessionId) {
    let count = 0;
    for (const turn of this.store.list(this.turnCollection)) {
      if (turn.sessionId === sessionId) {
        this.store.delete(this.turnCollection, turn.id);
        count += 1;
      }
    }
    return count;
  }

  /* ── summaries ──────────────────────────────────────────────────────── */

  async summarizeConversation(sessionId, { llm = null, keep = 12 } = {}) {
    const turns = this.turns(sessionId, 200);
    if (turns.length < keep) return null;
    const older = turns.slice(0, -keep);
    const transcript = older.map((turn) => `${turn.role}: ${turn.text}`).join('\n').slice(0, 12000);
    let summary = null;
    if (llm) {
      try {
        const result = await llm.chat({
          messages: [
            { role: 'system', content: 'Summarise this conversation for future recall. Keep facts, decisions, names, file paths and open questions. Max 200 words. Answer in the language of the conversation.' },
            { role: 'user', content: transcript },
          ],
          modelClass: 'fast',
          maxTokens: 400,
        });
        summary = result.text;
      } catch (err) {
        if (this.log) this.log.warn('memory', `summary model failed: ${err.message}`);
      }
    }
    if (!summary) {
      // Deterministic fallback: first sentences of each older turn.
      summary = older
        .slice(-20)
        .map((turn) => `${turn.role}: ${turn.text.replace(/\s+/g, ' ').slice(0, 140)}`)
        .join('\n');
    }
    const { record } = await this.remember({
      kind: 'long_term',
      text: `Summary of conversation ${sessionId} (${older.length} turns):\n${summary}`,
      tags: ['summary', 'conversation'],
      source: 'summarizer',
      importance: 0.6,
      meta: { sessionId, turns: older.length },
    });
    for (const turn of older) this.store.delete(this.turnCollection, turn.id);
    return record;
  }

  /* ── housekeeping ───────────────────────────────────────────────────── */

  stats() {
    this.load();
    const counts = {};
    for (const kind of KINDS) counts[kind] = 0;
    for (const record of this.cache.values()) counts[record.kind] = (counts[record.kind] || 0) + 1;
    return {
      kinds: counts,
      total: this.cache.size,
      turns: this.store.count(this.turnCollection),
      vectors: this.vectorCache.size,
      embedder: { name: this.embedder.name, provider: this.embedder.provider || 'local', dim: this.embedder.dim || null },
      counters: { ...this.counters },
      conflicts: this.conflicts().length,
      superseded: [...this.cache.values()].filter((record) => record.supersededBy).length,
      store: this.store.stats(),
    };
  }

  exportAll() {
    return {
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      memories: [...this.cache.values()],
      turns: this.store.list(this.turnCollection),
    };
  }

  importAll(payload, { merge = true } = {}) {
    if (!payload || !Array.isArray(payload.memories)) throw new Error('not a SENTINEL memory export');
    let added = 0;
    let skipped = 0;
    if (!merge) this.forgetKind('long_term');
    for (const record of payload.memories) {
      if (!record || !record.id || !record.text) {
        skipped += 1;
        continue;
      }
      if (looksSecret(record.text)) {
        skipped += 1;
        continue;
      }
      if (this.cache.has(record.id) && !merge) {
        skipped += 1;
        continue;
      }
      this.cache.set(record.id, record);
      if (record.vector) this.vectorCache.set(record.id, decodeVector(record.vector));
      this.index.add(record.id, `${record.text} ${(record.tags || []).join(' ')}`);
      this.store.put(this.collection, record.id, record);
      added += 1;
    }
    for (const turn of payload.turns || []) {
      if (turn && turn.id && !this.store.get(this.turnCollection, turn.id)) this.store.put(this.turnCollection, turn.id, turn);
    }
    return { added, skipped };
  }

  async backup(destination) {
    return this.store.backupAsync(destination);
  }

  prune({ maxAgeDays = 365, keepShortTerm = 300 } = {}) {
    const now = this.now();
    let removed = 0;
    for (const record of [...this.cache.values()]) {
      if (record.kind === 'short_term') continue;
      if (record.kind === 'working' && now - record.updatedAt > 86400000) {
        this.forget(record.id, { quiet: true });
        removed += 1;
        continue;
      }
      if (now - (record.updatedAt || record.createdAt) > maxAgeDays * 86400000 && (record.importance || 0.5) < 0.4) {
        this.forget(record.id, { quiet: true });
        removed += 1;
      }
    }
    const shortTerm = [...this.cache.values()]
      .filter((record) => record.kind === 'short_term')
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const record of shortTerm.slice(keepShortTerm)) {
      this.forget(record.id, { quiet: true });
      removed += 1;
    }
    return removed;
  }
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

module.exports = { Memory, KINDS, looksSecret, clamp01 };
