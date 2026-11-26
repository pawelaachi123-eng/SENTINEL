'use strict';

/**
 * A typed, persistent cognitive blackboard.
 *
 * The board is the shared state that the rest of the system writes to while a
 * request is being understood, planned, executed and verified. It is deliberately
 * plain data with an explicit schema rather than a hidden prompt transcript:
 *
 *   - every entry has a type (fact, goal, hypothesis, evidence, result, ...)
 *   - every mutation keeps provenance and a bounded revision history
 *   - entries are isolated by session/task scope; global knowledge is explicit
 *   - confidence and epistemic status are separate (supported is not proven)
 *   - attention combines salience, confidence, recency and goal relevance
 *   - focus() enforces a character budget instead of dumping everything
 *   - contradictions are first class and are never silently overwritten
 *
 * Persistence is optional. With a dataDir the board survives restarts with an
 * atomic write; without one it is an in-memory board for tests and simulations.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = new Set([
  'perception',
  'question',
  'goal',
  'constraint',
  'fact',
  'belief',
  'hypothesis',
  'evidence',
  'plan',
  'task',
  'decision',
  'result',
  'verification',
  'error',
  'preference',
  'answer',
  'artifact',
  'observation',
]);

const STATUSES = new Set(['proven', 'supported', 'estimated', 'unsupported', 'contradicted', 'retracted']);
const STATUS_WEIGHT = { proven: 1, supported: 0.85, estimated: 0.6, unsupported: 0.3, contradicted: 0.05, retracted: 0 };
const SCOPE_PATTERN = /^(global|(?:session|task|workspace):[A-Za-z0-9_.:-]{1,120})$/;

function nowMs(clock) {
  return Number(clock()) || Date.now();
}

function identifier(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function stableContent(content) {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normaliseScope(scope) {
  const value = String(scope || 'global');
  if (!SCOPE_PATTERN.test(value)) throw Object.assign(new Error(`invalid blackboard scope: ${value}`), { code: 'BAD_SCOPE' });
  return value;
}

class Blackboard {
  constructor({
    dataDir = null,
    log = null,
    now = () => Date.now(),
    maxEntries = 4000,
    maxHistory = 24,
    decayHalfLifeMs = 6 * 60 * 60 * 1000,
    defaultTtlMs = null,
    persistDebounceMs = 40,
  } = {}) {
    this.dataDir = dataDir;
    this.file = dataDir ? path.join(dataDir, 'blackboard.json') : null;
    this.log = log;
    this.now = now;
    this.maxEntries = Math.max(50, Number(maxEntries) || 4000);
    this.maxHistory = Math.max(2, Number(maxHistory) || 24);
    this.decayHalfLifeMs = Math.max(1000, Number(decayHalfLifeMs) || 6 * 60 * 60 * 1000);
    this.defaultTtlMs = defaultTtlMs === null ? null : Math.max(1000, Number(defaultTtlMs) || 0);
    this.persistDebounceMs = Math.max(0, Number(persistDebounceMs) || 0);
    this.entries = new Map();
    this.listeners = new Set();
    this.counters = { added: 0, updated: 0, merged: 0, evicted: 0, conflicts: 0, resolved: 0, loaded: 0, writes: 0 };
    this.lastError = null;
    this._timer = null;
    this._writing = null;
    this.load();
  }

  /* ── validation ─────────────────────────────────────────────────────── */

  _entry({ type, content, scope, key = null, provenance = [], owner = {}, confidence = 0.7, status = 'supported', tags = [], salience = 0.5, ttlMs = undefined, expiresAt = null, supports = [], contradicts = [], metadata = null }) {
    if (!TYPES.has(type)) throw Object.assign(new Error(`unknown blackboard type: ${type}`), { code: 'BAD_TYPE' });
    if (content === undefined || content === null) throw Object.assign(new Error('blackboard content is required'), { code: 'NO_CONTENT' });
    if (stableContent(content).length > 200000) throw Object.assign(new Error('blackboard content exceeds 200,000 characters'), { code: 'CONTENT_TOO_LARGE' });
    if (!STATUSES.has(status)) throw Object.assign(new Error(`unknown epistemic status: ${status}`), { code: 'BAD_STATUS' });
    const score = Number(confidence);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw Object.assign(new Error('confidence must be between 0 and 1'), { code: 'BAD_CONFIDENCE' });
    const at = nowMs(this.now);
    const ttl = ttlMs === undefined ? this.defaultTtlMs : ttlMs;
    const expiry = expiresAt ? Date.parse(expiresAt) : ttl ? at + Number(ttl) : null;
    const provenanceList = (Array.isArray(provenance) ? provenance : [provenance]).filter(Boolean).map((item) => (typeof item === 'string'
      ? { source: item, at }
      : { source: String(item.source || 'unknown'), ref: item.ref == null ? null : String(item.ref), note: item.note == null ? null : String(item.note).slice(0, 400), at: item.at || at }));
    return {
      id: identifier('bb'),
      type,
      scope: normaliseScope(scope),
      key: key == null ? null : String(key).slice(0, 160),
      content: clone(content),
      provenance: provenanceList,
      owner: {
        sessionId: owner.sessionId == null ? null : String(owner.sessionId),
        runId: owner.runId == null ? null : String(owner.runId),
        agent: owner.agent == null ? null : String(owner.agent),
        taskId: owner.taskId == null ? null : String(owner.taskId),
      },
      confidence: score,
      status,
      tags: [...new Set((Array.isArray(tags) ? tags : [tags]).filter(Boolean).map((tag) => String(tag).slice(0, 40)))],
      salience: Math.min(1, Math.max(0, Number(salience) || 0)),
      supports: (Array.isArray(supports) ? supports : [supports]).filter(Boolean).map(String),
      contradicts: (Array.isArray(contradicts) ? contradicts : [contradicts]).filter(Boolean).map(String),
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : null,
      createdAt: at,
      updatedAt: at,
      expiresAt: expiry,
      revision: 1,
      accessCount: 0,
      lastAccess: at,
      history: [{ at, action: 'created', revision: 1, status, confidence: score }],
    };
  }

  /* ── writes ─────────────────────────────────────────────────────────── */

  add(input) {
    const entry = this._entry(input);
    const existing = entry.key ? [...this.entries.values()].find((candidate) => candidate.scope === entry.scope && candidate.key === entry.key && candidate.type === entry.type) : null;
    const sameContent = existing && stableContent(existing.content) === stableContent(entry.content);
    // An upsert whose content changed is a contradiction unless the caller
    // explicitly says it is a replacement. Silent overwrite would erase the
    // older claim while pretending the board never held it.
    if (existing && !sameContent && input.merge !== true) {
      entry.contradicts = [...new Set([...entry.contradicts, existing.id])];
      existing.contradicts = [...new Set([...existing.contradicts, entry.id])];
      existing.updatedAt = entry.createdAt;
      entry.updatedAt = entry.createdAt;
      this._history(existing, 'conflicted', { against: entry.id });
      this.entries.set(entry.id, entry);
      this.counters.added += 1;
      this._changed('added', entry);
      this._enforceCapacity();
      this.schedulePersist();
      return clone(entry);
    }
    if (existing) {
      const before = { revision: existing.revision, status: existing.status, confidence: existing.confidence };
      existing.content = entry.content;
      existing.confidence = Math.max(0, Math.min(1, (existing.confidence + entry.confidence) / 2));
      existing.status = entry.status;
      existing.updatedAt = entry.createdAt;
      existing.revision += 1;
      existing.provenance = [...existing.provenance, ...entry.provenance].slice(-12);
      existing.tags = [...new Set([...existing.tags, ...entry.tags])];
      existing.salience = Math.max(existing.salience, entry.salience);
      existing.expiresAt = entry.expiresAt;
      if (entry.metadata) existing.metadata = entry.metadata;
      this._history(existing, 'merged', { before });
      this.counters.merged += 1;
      this._changed('merged', existing);
      this.schedulePersist();
      return clone(existing);
    }
    this.entries.set(entry.id, entry);
    this.counters.added += 1;
    this._changed('added', entry);
    this._enforceCapacity();
    this.schedulePersist();
    return clone(entry);
  }

  update(id, patch = {}) {
    const entry = this.entries.get(id);
    if (!entry) throw Object.assign(new Error(`no blackboard entry ${id}`), { code: 'NOT_FOUND' });
    if (entry.status === 'retracted') throw Object.assign(new Error('a retracted entry cannot be updated'), { code: 'RETRACTED' });
    const before = { content: clone(entry.content), status: entry.status, confidence: entry.confidence, revision: entry.revision };
    if (patch.content !== undefined) {
      if (stableContent(patch.content).length > 200000) throw Object.assign(new Error('content too large'), { code: 'CONTENT_TOO_LARGE' });
      entry.content = clone(patch.content);
    }
    if (patch.confidence !== undefined) {
      const score = Number(patch.confidence);
      if (!Number.isFinite(score) || score < 0 || score > 1) throw Object.assign(new Error('confidence must be between 0 and 1'), { code: 'BAD_CONFIDENCE' });
      entry.confidence = score;
    }
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status)) throw Object.assign(new Error(`unknown status ${patch.status}`), { code: 'BAD_STATUS' });
      entry.status = patch.status;
    }
    if (patch.tags !== undefined) entry.tags = [...new Set([...entry.tags, ...(Array.isArray(patch.tags) ? patch.tags : [patch.tags]).map(String)])];
    if (patch.salience !== undefined) entry.salience = Math.min(1, Math.max(0, Number(patch.salience) || 0));
    if (patch.expiresAt !== undefined) entry.expiresAt = patch.expiresAt ? Date.parse(patch.expiresAt) : null;
    if (patch.provenance) {
      const extra = (Array.isArray(patch.provenance) ? patch.provenance : [patch.provenance]).filter(Boolean).map((item) => (typeof item === 'string' ? { source: item, at: nowMs(this.now) } : { source: String(item.source || 'unknown'), ref: item.ref || null, note: item.note || null, at: item.at || nowMs(this.now) }));
      entry.provenance = [...entry.provenance, ...extra].slice(-12);
    }
    if (patch.contradicts) entry.contradicts = [...new Set([...entry.contradicts, ...(Array.isArray(patch.contradicts) ? patch.contradicts : [patch.contradicts]).map(String)])];
    entry.revision += 1;
    entry.updatedAt = nowMs(this.now);
    if (patch.reason) this._history(entry, 'updated', { reason: String(patch.reason).slice(0, 300), before });
    else this._history(entry, 'updated', { before });
    this.counters.updated += 1;
    this._changed('updated', entry);
    this.schedulePersist();
    return clone(entry);
  }

  /**
   * Resolve a contradiction explicitly. The loser is retained with
   * status=contradicted so later evidence can revisit the decision; nothing is
   * deleted and the resolution itself carries provenance.
   */
  resolve({ winnerId, loserId, reason = null, actor = 'user', confidence = null } = {}) {
    const winner = this.entries.get(winnerId);
    const loser = this.entries.get(loserId);
    if (!winner || !loser) throw Object.assign(new Error('both winner and loser must exist'), { code: 'NOT_FOUND' });
    if (winner.scope !== loser.scope && winner.scope !== 'global' && loser.scope !== 'global') throw Object.assign(new Error('cannot resolve entries across isolated scopes'), { code: 'SCOPE_MISMATCH' });
    loser.status = 'contradicted';
    loser.confidence = Math.min(loser.confidence, Number.isFinite(Number(confidence)) ? Number(confidence) : 0.1);
    loser.updatedAt = nowMs(this.now);
    loser.revision += 1;
    loser.contradicts = [...new Set([...loser.contradicts, winner.id])];
    winner.contradicts = winner.contradicts.filter((id) => id !== loser.id);
    const at = nowMs(this.now);
    const note = { source: String(actor), ref: winner.id, note: reason ? String(reason).slice(0, 400) : null, at };
    winner.provenance = [...winner.provenance, note].slice(-12);
    loser.provenance = [...loser.provenance, note].slice(-12);
    this._history(winner, 'conflict-won', { against: loser.id, reason });
    this._history(loser, 'conflict-lost', { against: winner.id, reason });
    this.counters.resolved += 1;
    this._changed('resolved', winner, { loserId });
    this.schedulePersist();
    return { winner: clone(winner), loser: clone(loser), reason };
  }

  retract(id, { reason = null, actor = 'user' } = {}) {
    const entry = this.entries.get(id);
    if (!entry) throw Object.assign(new Error(`no blackboard entry ${id}`), { code: 'NOT_FOUND' });
    entry.status = 'retracted';
    entry.confidence = 0;
    entry.updatedAt = nowMs(this.now);
    entry.revision += 1;
    this._history(entry, 'retracted', { reason: reason ? String(reason).slice(0, 300) : null, actor: String(actor) });
    this.counters.resolved += 1;
    this._changed('retracted', entry);
    this.schedulePersist();
    return clone(entry);
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this._changed('removed', entry);
    this.schedulePersist();
    return true;
  }

  _history(entry, action, detail = {}) {
    const at = nowMs(this.now);
    entry.history.push({ at, action, revision: entry.revision, status: entry.status, confidence: entry.confidence, ...detail });
    if (entry.history.length > this.maxHistory) entry.history = entry.history.slice(-this.maxHistory);
  }

  _changed(action, entry, extra = {}) {
    const event = { action, at: nowMs(this.now), entry: clone(entry), ...extra };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        if (this.log) this.log.debug('blackboard', `listener failed: ${err.message}`);
      }
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ── reads, attention and focus ─────────────────────────────────────── */

  visible(entry, scope, { includeGlobal = true } = {}) {
    if (!entry) return false;
    if (entry.scope === scope) return true;
    return includeGlobal && entry.scope === 'global';
  }

  get(id, { scope = null } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (scope && !this.visible(entry, normaliseScope(scope))) return null;
    if (entry.expiresAt && entry.expiresAt <= nowMs(this.now)) return null;
    entry.accessCount += 1;
    entry.lastAccess = nowMs(this.now);
    return clone(entry);
  }

  relevance(entry, goal) {
    if (!goal) return 1;
    const haystack = `${stableContent(entry.content)} ${entry.tags.join(' ')} ${entry.key || ''}`.toLowerCase();
    const terms = [...new Set(String(goal).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 2))];
    if (!terms.length) return 1;
    const hits = terms.filter((term) => haystack.includes(term)).length;
    return 0.55 + 0.45 * (hits / terms.length);
  }

  attention(entry, { goal = null, now = null } = {}) {
    const at = now === null ? nowMs(this.now) : now;
    const age = Math.max(0, at - entry.updatedAt);
    const recency = 0.5 ** (age / this.decayHalfLifeMs);
    const status = STATUS_WEIGHT[entry.status] == null ? 0.3 : STATUS_WEIGHT[entry.status];
    const access = 1 + Math.min(0.25, entry.accessCount * 0.01);
    return Math.max(0, Math.min(1.5, recency * (0.35 + 0.65 * entry.salience) * (0.25 + 0.75 * entry.confidence) * status * this.relevance(entry, goal) * access));
  }

  query({ scope = 'global', includeGlobal = true, types = null, tags = null, status = null, text = null, minConfidence = null, limit = 50, goal = null, includeExpired = false } = {}) {
    const wantedTypes = types ? new Set((Array.isArray(types) ? types : [types]).map(String)) : null;
    const wantedTags = tags ? new Set((Array.isArray(tags) ? tags : [tags]).map(String)) : null;
    const needle = text ? String(text).toLowerCase() : null;
    const at = nowMs(this.now);
    const normalizedScope = normaliseScope(scope);
    return [...this.entries.values()]
      .filter((entry) => this.visible(entry, normalizedScope, { includeGlobal }))
      .filter((entry) => includeExpired || !entry.expiresAt || entry.expiresAt > at)
      .filter((entry) => !wantedTypes || wantedTypes.has(entry.type))
      .filter((entry) => !wantedTags || entry.tags.some((tag) => wantedTags.has(tag)))
      .filter((entry) => !status || entry.status === status)
      .filter((entry) => minConfidence === null || entry.confidence >= Number(minConfidence))
      .filter((entry) => !needle || `${stableContent(entry.content)} ${entry.tags.join(' ')} ${entry.key || ''}`.toLowerCase().includes(needle))
      .map((entry) => ({ ...clone(entry), attention: this.attention(entry, { goal, now: at }) }))
      .sort((a, b) => b.attention - a.attention || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  /**
   * The attention window. Entries are admitted by score until either the entry
   * limit or the character budget is reached; the caller is told exactly what
   * was left out, so a budget cut is never mistaken for completeness.
   */
  focus({ scope = 'global', goal = null, tokens = 800, types = null, limit = 16, minAttention = 0.02, includeGlobal = true } = {}) {
    const charBudget = Math.max(40, Number(tokens) * 4);
    const ranked = this.query({ scope, goal, types, limit: Math.max(1, Math.min(200, Number(limit) * 4 || 64)), includeGlobal });
    const selected = [];
    let used = 0;
    for (const entry of ranked) {
      if (entry.attention < minAttention) continue;
      const line = this.renderEntry(entry);
      if (used + line.length > charBudget && selected.length) break;
      selected.push({ ...entry, line });
      used += line.length + 1;
      if (selected.length >= limit) break;
    }
    return {
      scope: normaliseScope(scope),
      goal,
      selected,
      omitted: Math.max(0, ranked.length - selected.length),
      entries: selected.length,
      characters: used,
      tokenBudget: Number(tokens),
      estimatedTokens: Math.max(0, Math.ceil(used / 4)),
      block: selected.map((entry) => entry.line).join('\n'),
    };
  }

  renderEntry(entry) {
    const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
    const clipped = content.length > 240 ? `${content.slice(0, 237)}...` : content;
    const source = entry.provenance && entry.provenance.length ? entry.provenance[entry.provenance.length - 1].source : 'unknown';
    return `[${entry.type}/${entry.status} ${entry.confidence.toFixed(2)} @${source}] ${clipped.replace(/\s+/g, ' ')}`;
  }

  render(options) {
    return this.focus(options).block;
  }

  /* ── contradictions and integrity ───────────────────────────────────── */

  conflicts({ scope = 'global', includeGlobal = true } = {}) {
    const normalizedScope = normaliseScope(scope);
    const visible = [...this.entries.values()].filter((entry) => this.visible(entry, normalizedScope, { includeGlobal }) && entry.status !== 'retracted');
    const pairs = [];
    const seen = new Set();
    for (const entry of visible) {
      for (const otherId of entry.contradicts) {
        const other = this.entries.get(otherId);
        if (!other || !visible.includes(other)) continue;
        const pairKey = [entry.id, other.id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        pairs.push({
          a: { id: entry.id, type: entry.type, content: entry.content, status: entry.status, confidence: entry.confidence },
          b: { id: other.id, type: other.type, content: other.content, status: other.status, confidence: other.confidence },
          resolved: entry.status === 'contradicted' || other.status === 'contradicted',
          pairKey,
        });
      }
    }
    // Same key + same type + different content is an implicit contradiction
    // unless one side has already been marked contradicted/retracted.
    const groups = new Map();
    for (const entry of visible) {
      if (!entry.key) continue;
      const groupKey = `${entry.scope}|${entry.type}|${entry.key}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(entry);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const contents = new Set(group.map((entry) => stableContent(entry.content)));
      if (contents.size < 2) continue;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const pairKey = [group[i].id, group[j].id].sort().join('|');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          pairs.push({
            a: { id: group[i].id, type: group[i].type, content: group[i].content, status: group[i].status, confidence: group[i].confidence },
            b: { id: group[j].id, type: group[j].type, content: group[j].content, status: group[j].status, confidence: group[j].confidence },
            resolved: group[i].status === 'contradicted' || group[j].status === 'contradicted',
            pairKey,
          });
        }
      }
    }
    this.counters.conflicts = pairs.filter((pair) => !pair.resolved).length;
    return pairs;
  }

  stats(scope = null) {
    const at = nowMs(this.now);
    const entries = scope ? [...this.entries.values()].filter((entry) => this.visible(entry, normaliseScope(scope), { includeGlobal: true })) : [...this.entries.values()];
    const byType = {};
    const byStatus = {};
    let expired = 0;
    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
      if (entry.expiresAt && entry.expiresAt <= at) expired += 1;
    }
    return {
      entries: entries.length,
      total: this.entries.size,
      scope,
      byType,
      byStatus,
      expired,
      unresolvedConflicts: scope
        ? this.conflicts({ scope }).filter((pair) => !pair.resolved).length
        : [...new Set(entries.map((entry) => entry.scope))].reduce((sum, entryScope) => sum + this.conflicts({ scope: entryScope }).filter((pair) => !pair.resolved).length, 0),
      counters: { ...this.counters },
      persisted: Boolean(this.file),
      lastError: this.lastError,
    };
  }

  prune({ maxEntries = this.maxEntries, now = null } = {}) {
    const at = now === null ? nowMs(this.now) : now;
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= at && entry.status !== 'proven') {
        this.entries.delete(id);
        removed += 1;
      }
    }
    if (this.entries.size > maxEntries) {
      const ranked = [...this.entries.values()].sort((a, b) => this.attention(b, { now: at }) - this.attention(a, { now: at }));
      for (const entry of ranked.slice(maxEntries)) {
        this.entries.delete(entry.id);
        removed += 1;
      }
    }
    this.counters.evicted += removed;
    if (removed) {
      this._changed('pruned', { id: null }, { removed });
      this.schedulePersist();
    }
    return { removed, entries: this.entries.size };
  }

  _enforceCapacity() {
    if (this.entries.size > this.maxEntries) this.prune();
  }

  /* ── persistence ────────────────────────────────────────────────────── */

  load() {
    if (!this.file) return this;
    try {
      if (!fs.existsSync(this.file)) return this;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('unsupported blackboard file');
      for (const entry of parsed.entries) {
        if (!entry || !entry.id || !TYPES.has(entry.type) || !STATUSES.has(entry.status) || !SCOPE_PATTERN.test(entry.scope)) continue;
        this.entries.set(entry.id, {
          accessCount: 0,
          lastAccess: nowMs(this.now),
          history: [],
          provenance: [],
          tags: [],
          supports: [],
          contradicts: [],
          ...entry,
        });
        this.counters.loaded += 1;
      }
    } catch (err) {
      this.lastError = err.message;
      if (this.log) this.log.warn('blackboard', `could not load board: ${err.message}`);
    }
    return this;
  }

  schedulePersist() {
    if (!this.file) return;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.persist().catch((err) => {
        this.lastError = err.message;
        if (this.log) this.log.warn('blackboard', `persist failed: ${err.message}`);
      });
    }, this.persistDebounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  async persist() {
    if (!this.file) return { ok: true, persisted: false };
    if (this._writing) return this._writing;
    this._writing = (async () => {
      await fsp.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const payload = { version: 1, savedAt: new Date(nowMs(this.now)).toISOString(), entries: [...this.entries.values()] };
      await fsp.writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await fsp.rename(tmp, this.file);
      this.counters.writes += 1;
      return { ok: true, persisted: true, entries: this.entries.size };
    })();
    try {
      return await this._writing;
    } finally {
      this._writing = null;
    }
  }

  async close() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._writing) await this._writing;
    return this.persist();
  }

  clear({ scope = null, types = null } = {}) {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (scope && !this.visible(entry, normaliseScope(scope))) continue;
      if (types && !(Array.isArray(types) ? types : [types]).includes(entry.type)) continue;
      this.entries.delete(id);
      removed += 1;
    }
    if (removed) this.schedulePersist();
    return { removed, entries: this.entries.size };
  }
}

module.exports = { Blackboard, TYPES, STATUSES, SCOPE_PATTERN, estimateTokens };
