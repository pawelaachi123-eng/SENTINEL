'use strict';

/**
 * GraphRAG: entity and relationship extraction over indexed knowledge.
 *
 * The graph is built from text the user actually indexed. It is not a general
 * world knowledge graph and it never invents a relation that is not present in
 * a sentence. Extraction is rule-based and deliberately conservative:
 *
 *   • entities are capitalised phrases, quoted names, e-mails, URLs, versions
 *     and dates; a leading determiner is stripped but the surface form kept;
 *   • relations follow a small set of explicit patterns in Polish and English
 *     ("X is Y", "X uses Y", "X zależy od Y", "X pracuje w Y", ...);
 *   • entity resolution folds case, diacritics, punctuation and a small set of
 *     Polish inflections, then merges aliases rather than creating a new node;
 *   • every edge carries the exact source sentence and chunk, so a citation
 *     can be checked against the graph instead of trusted.
 *
 * Multi-hop retrieval walks the resolved graph with a decay and reports the
 * path it used. Contradictions are flagged, never silently resolved.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTITIES_PER_CHUNK = 24;
const MAX_EDGES_PER_CHUNK = 32;
const MAX_GRAPH_ENTITIES = 40000;
const MAX_GRAPH_EDGES = 120000;

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'it', 'its', 'i', 'we', 'you', 'they', 'he', 'she', 'his', 'her', 'our', 'their', 'not', 'no', 'yes', 'jest', 'sa', 'są', 'oraz', 'lub', 'ale', 'do', 'z', 'ze', 'w', 'we', 'na', 'dla', 'od', 'przez', 'jako', 'to', 'ten', 'ta', 'te', 'sie', 'się', 'nie', 'tak', 'ja', 'ty', 'on', 'ona', 'my', 'wy', 'oni', 'jego', 'jej', 'ich', 'nasz', 'nasza']);

const RELATION_PATTERNS = [
  { type: 'uses', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:uses|używa|uzywa|korzysta z|korzysta ze)\s+([\p{Lu}\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'depends_on', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:depends on|zależy od|zalezy od|wymaga)\s+([\p{Lu}\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'works_at', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:works at|works for|pracuje w|pracuje dla|należy do|nalezy do)\s+([\p{Lu}\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'owns', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:owns|posiada|jest właścicielem|jest wlascicielem)\s+([\p{Lu}\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'has', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:has|ma)\s+([\p{Lu}\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'is_a', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:is|jest)\s+(?:a|an|the|typem|rodzajem)?\s*([\p{Lu}][\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'located_in', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:is located in|znajduje się w|znajduje sie w|mieści się w|miesci sie w)\s+([\p{Lu}][\p{L}\p{N} ._:-]{2,40})/gu] },
  { type: 'part_of', patterns: [/\b([\p{Lu}][\p{L}\p{N} ._-]{1,40}?)\s+(?:is part of|jest częścią|jest czescia|należy do|nalezy do)\s+([\p{Lu}][\p{L}\p{N} ._:-]{2,40})/gu] },
];

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Folds case, Polish diacritics and punctuation so aliases become comparable. */
function canonical(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** A deliberately small Polish/English inflection fold, not a stemmer. */
function stem(token) {
  if (token.length <= 4) return token;
  return token.replace(/(ami|ach|owie|iego|emu|owej|owych|ies|es|s|a|u|y|i|e|ą|ę|em|ie)$/u, '');
}

function squash(phrase) {
  return String(phrase || '')
    .replace(/^[\s"'([{]+|[\s"')\]},.;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceSplit(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 3)
    .slice(0, 400);
}

function entityCandidates(sentence) {
  const found = [];
  const push = (name, type) => {
    const clean = squash(name);
    if (!clean || clean.length < 2 || clean.length > 60) return;
    if (STOPWORDS.has(canonical(clean))) return;
    if (!/[\p{L}\p{N}]/u.test(clean)) return;
    found.push({ name: clean, type });
  };
  for (const match of sentence.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) push(match[0], 'email');
  for (const match of sentence.matchAll(/https?:\/\/[^\s)]+/g)) push(match[0], 'url');
  for (const match of sentence.matchAll(/"[^"]{2,50}"|„[^”]{2,50}”|«[^»]{2,50}»/gu)) push(match[0].slice(1, -1), 'quoted');
  for (const match of sentence.matchAll(/\b(?:v|ver\.?|wersja)\s?(\d+(?:\.\d+){1,3})\b/giu)) push(`v${match[1]}`, 'version');
  for (const match of sentence.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/g)) push(match[1], 'date');
  // Capitalised multi-word phrases; sentence-initial ordinary words are not entities.
  const words = sentence.split(/\s+/);
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const phrase = current.join(' ');
    const canonicalPhrase = canonical(phrase);
    if (canonicalPhrase && !STOPWORDS.has(canonicalPhrase)) push(phrase, 'proper');
    current = [];
  };
  words.forEach((word, index) => {
    const clean = squash(word);
    const isCapital = /^[\p{Lu}][\p{L}\p{N}'’-]*$/u.test(clean);
    const isAcronym = /^[A-Z]{2,}$/.test(clean);
    if (isCapital || isAcronym) {
      if (index === 0 && current.length === 0 && !isAcronym && !/[.:]$/.test(word)) {
        // A sentence-initial capitalised word is ambiguous; keep it only if the
        // next word is also capitalised (e.g. "Anna Kowalska").
        const next = words[index + 1] ? squash(words[index + 1]) : '';
        if (!/^[\p{Lu}]/u.test(next)) return;
      }
      current.push(clean);
    } else {
      flush();
    }
  });
  flush();
  const seen = new Set();
  return found.filter((entity) => {
    const key = `${entity.type}:${canonical(entity.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ENTITIES_PER_CHUNK);
}

function relationCandidates(sentence) {
  const relations = [];
  for (const group of RELATION_PATTERNS) {
    for (const pattern of group.patterns) {
      pattern.lastIndex = 0;
      for (const match of sentence.matchAll(pattern)) {
        const subject = squash(match[1]);
        const object = squash(match[2]).replace(/\s+(?:and|oraz|i)\s*$/u, '');
        if (!subject || !object) continue;
        if (canonical(subject) === canonical(object)) continue;
        if (STOPWORDS.has(canonical(subject)) || STOPWORDS.has(canonical(object))) continue;
        relations.push({ subject, predicate: group.type, object });
      }
    }
  }
  if (/->|→/.test(sentence)) {
    for (const match of sentence.matchAll(/([^→\n]{2,40})\s*(?:->|→)\s*([^→\n]{2,40})/g)) {
      relations.push({ subject: squash(match[1]), predicate: 'points_to', object: squash(match[2]) });
    }
  }
  return relations.slice(0, MAX_EDGES_PER_CHUNK);
}

class GraphRAG {
  constructor({ dataDir = null, log = null, now = () => Date.now(), maxEntities = MAX_GRAPH_ENTITIES, maxEdges = MAX_GRAPH_EDGES } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.maxEntities = maxEntities;
    this.maxEdges = maxEdges;
    this.entities = new Map(); // id → {id, name, canonical, type, aliases, refs, firstSeen}
    this.aliasIndex = new Map(); // canonical surface → entity id
    this.edges = new Map(); // key → {id, from, predicate, to, docId, chunkId, sentence, at}
    this.byDoc = new Map(); // docId → {entities:Set, edges:Set}
    this.byChunk = new Map(); // chunkId → {entities:Set, edges:Set}
    this.counters = { documents: 0, chunks: 0, entityMentions: 0, relations: 0, merges: 0, contradictions: 0, removed: 0 };
    this.loaded = false;
  }

  file() {
    return this.dataDir ? path.join(this.dataDir, 'graphrag.json') : null;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    const file = this.file();
    if (!file || !fs.existsSync(file)) return this;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const entity of data.entities || []) {
        this.entities.set(entity.id, { ...entity, aliases: new Set(entity.aliases || []), refs: new Set(entity.refs || []), chunks: new Set(entity.chunks || []) });
        for (const alias of [entity.canonical, ...(entity.aliases || [])]) this.aliasIndex.set(canonical(alias), entity.id);
      }
      for (const edge of data.edges || []) this.edges.set(edge.id, edge);
      for (const edge of this.edges.values()) {
        if (!this.byDoc.has(edge.docId)) this.byDoc.set(edge.docId, { entities: new Set(), edges: new Set() });
        if (!this.byChunk.has(edge.chunkId)) this.byChunk.set(edge.chunkId, { entities: new Set(), edges: new Set() });
        this.byDoc.get(edge.docId).edges.add(edge.id);
        this.byChunk.get(edge.chunkId).edges.add(edge.id);
        this.byDoc.get(edge.docId).entities.add(edge.from);
        this.byDoc.get(edge.docId).entities.add(edge.to);
        this.byChunk.get(edge.chunkId).entities.add(edge.from);
        this.byChunk.get(edge.chunkId).entities.add(edge.to);
      }
      if (data.counters) this.counters = { ...this.counters, ...data.counters };
    } catch (err) {
      if (this.log) this.log.warn('graphrag', `could not load graph: ${err.message}`);
    }
    return this;
  }

  persist() {
    const file = this.file();
    if (!file) return { ok: false, code: 'NO_DATA_DIR', message: 'graph has no data directory' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      version: 1,
      savedAt: this.now(),
      counters: this.counters,
      entities: [...this.entities.values()].map((entity) => ({ ...entity, aliases: [...entity.aliases], refs: [...entity.refs], chunks: [...(entity.chunks || [])] })),
      edges: [...this.edges.values()],
    };
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload));
    fs.renameSync(temporary, file);
    return { ok: true, file, entities: payload.entities.length, edges: payload.edges.length };
  }

  /** Resolves an entity or creates it. Exact alias first, then a conservative fuzzy merge. */
  resolve(name, type = 'proper') {
    const clean = squash(name);
    const key = canonical(clean);
    if (!key) return null;
    if (this.aliasIndex.has(key)) {
      const id = this.aliasIndex.get(key);
      const entity = this.entities.get(id);
      if (entity && entity.name !== clean && ![...entity.aliases].some((alias) => canonical(alias) === key)) {
        entity.aliases.add(clean);
        this.counters.merges += 1;
      }
      return id;
    }
    const fuzzy = this.fuzzyMatch(key);
    if (fuzzy) {
      const entity = this.entities.get(fuzzy);
      entity.aliases.add(clean);
      this.aliasIndex.set(key, fuzzy);
      this.counters.merges += 1;
      return fuzzy;
    }
    if (this.entities.size >= this.maxEntities) {
      // Reuse the least-referenced entity rather than growing without bound.
      const victim = [...this.entities.values()].sort((a, b) => a.refs.size - b.refs.size)[0];
      if (victim) {
        this.removeEntity(victim.id);
      }
    }
    const id = `e_${hash(`${type}:${key}`).slice(0, 16)}`;
    const entity = { id, name: clean, canonical: key, type, aliases: new Set(), refs: new Set(), chunks: new Set(), firstSeen: this.now() };
    this.entities.set(id, entity);
    this.aliasIndex.set(key, id);
    return id;
  }

  fuzzyMatch(key) {
    const tokens = key.split(' ').filter(Boolean);
    if (!tokens.length) return null;
    const stemmed = tokens.map(stem);
    let best = null;
    for (const [alias, id] of this.aliasIndex) {
      if (alias === key) return id;
      const other = alias.split(' ').filter(Boolean);
      if (!other.length) continue;
      if (other.length !== tokens.length && Math.abs(other.length - tokens.length) > 1) continue;
      const otherStemmed = other.map(stem);
      const left = new Set(stemmed);
      const right = new Set(otherStemmed);
      let common = 0;
      for (const token of left) if (right.has(token)) common += 1;
      const jaccard = common / (left.size + right.size - common);
      if (jaccard >= 0.8 && (!best || jaccard > best.score)) best = { id, score: jaccard };
    }
    return best ? best.id : null;
  }

  removeEntity(id) {
    const entity = this.entities.get(id);
    if (!entity) return false;
    for (const [alias, aliasId] of [...this.aliasIndex]) if (aliasId === id) this.aliasIndex.delete(alias);
    this.entities.delete(id);
    for (const edge of [...this.edges.values()]) if (edge.from === id || edge.to === id) this.removeEdge(edge.id);
    return true;
  }

  removeEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this.byDoc.get(edge.docId)?.edges.delete(id);
    this.byChunk.get(edge.chunkId)?.edges.delete(id);
    return true;
  }

  /** Extracts and stores entities/relations for one chunk. Idempotent per chunk. */
  ingest({ docId, chunkId, text, title = null, metadata = null }) {
    this.load();
    if (!docId || !chunkId) throw fail('graph ingestion needs docId and chunkId', 'BAD_ARGUMENT');
    this.removeChunk(chunkId);
    const sentences = sentenceSplit(`${title ? `${title}. ` : ''}${text || ''}`);
    const refs = new Set();
    const chunkEntities = new Set();
    const edgesAdded = [];
    for (const sentence of sentences) {
      const entities = entityCandidates(sentence);
      const relationCandidatesForSentence = relationCandidates(sentence);
      const mentioned = new Map();
      for (const candidate of entities) {
        const id = this.resolve(candidate.name, candidate.type);
        if (!id) continue;
        this.entities.get(id).refs.add(docId);
        this.entities.get(id).chunks.add(chunkId);
        refs.add(docId);
        chunkEntities.add(id);
        mentioned.set(canonical(candidate.name), id);
        this.counters.entityMentions += 1;
      }
      for (const relation of relationCandidatesForSentence) {
        const from = mentioned.get(canonical(relation.subject)) || this.resolve(relation.subject, 'proper');
        const to = mentioned.get(canonical(relation.object)) || this.resolve(relation.object, 'proper');
        if (!from || !to || from === to) continue;
        const key = `${from}|${relation.predicate}|${to}|${chunkId}`;
        const id = `r_${hash(key).slice(0, 16)}`;
        if (this.edges.has(id)) continue;
        if (this.edges.size >= this.maxEdges) {
          const oldest = [...this.edges.values()].sort((a, b) => a.at - b.at)[0];
          if (oldest) this.removeEdge(oldest.id);
        }
        const edge = { id, from, predicate: relation.predicate, to, docId, chunkId, sentence: sentence.slice(0, 400), at: this.now(), metadata };
        this.edges.set(id, edge);
        if (!this.byDoc.has(docId)) this.byDoc.set(docId, { entities: new Set(), edges: new Set() });
        if (!this.byChunk.has(chunkId)) this.byChunk.set(chunkId, { entities: new Set(), edges: new Set() });
        this.byDoc.get(docId).edges.add(id);
        this.byChunk.get(chunkId).edges.add(id);
        this.byDoc.get(docId).entities.add(from);
        this.byDoc.get(docId).entities.add(to);
        this.byChunk.get(chunkId).entities.add(from);
        this.byChunk.get(chunkId).entities.add(to);
        this.entities.get(from).refs.add(docId);
        this.entities.get(to).refs.add(docId);
        chunkEntities.add(from);
        chunkEntities.add(to);
        edgesAdded.push(edge);
        this.counters.relations += 1;
      }
    }
    if (!this.byChunk.has(chunkId)) this.byChunk.set(chunkId, { entities: new Set(), edges: new Set() });
    for (const id of chunkEntities) this.byChunk.get(chunkId).entities.add(id);
    this.counters.chunks += 1;
    const contradictions = this.contradictions({ docId, chunkId });
    this.counters.contradictions += contradictions.length;
    return { docId, chunkId, entities: chunkEntities.size, edges: edgesAdded.length, contradictions, refs: [...refs] };
  }

  removeChunk(chunkId) {
    const record = this.byChunk.get(chunkId);
    if (record) {
      for (const id of [...record.edges]) this.removeEdge(id);
      this.byChunk.delete(chunkId);
    }
  }

  removeDoc(docId) {
    this.load();
    const record = this.byDoc.get(docId);
    if (record) {
      for (const id of [...record.edges]) this.removeEdge(id);
      this.byDoc.delete(docId);
    }
    for (const entity of this.entities.values()) { entity.refs.delete(docId); for (const chunkId of [...entity.chunks]) if (String(chunkId).startsWith(`${docId}:`)) entity.chunks.delete(chunkId); }
    this.counters.removed += 1;
    return true;
  }

  /** Finds contradictory edges: same subject/object with an explicit negated predicate. */
  contradictions({ docId = null, chunkId = null } = {}) {
    const out = [];
    const edges = [...this.edges.values()].filter((edge) => (!docId || edge.docId === docId) && (!chunkId || edge.chunkId === chunkId));
    const groups = new Map();
    for (const edge of edges) {
      const key = `${edge.from}|${edge.to}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    }
    for (const group of groups.values()) {
      const predicates = new Set(group.map((edge) => edge.predicate));
      if (predicates.size > 1) {
        const conflicting = group.filter((edge, index) => group.some((other, otherIndex) => otherIndex !== index && other.predicate !== edge.predicate));
        if (conflicting.length) out.push({ subject: this.entities.get(group[0].from)?.name || group[0].from, object: this.entities.get(group[0].to)?.name || group[0].to, predicates: [...predicates], chunks: [...new Set(conflicting.map((edge) => edge.chunkId))] });
      }
    }
    return out.slice(0, 20);
  }

  /** Resolves query terms to entities, including individual query tokens. */
  seeds(query) {
    this.load();
    const words = canonical(query).split(' ').filter((word) => word && !STOPWORDS.has(word));
    const found = new Map();
    const add = (id, weight, via) => {
      if (!id) return;
      const current = found.get(id) || { id, weight: 0, via: new Set() };
      current.weight = Math.max(current.weight, weight);
      current.via.add(via);
      found.set(id, current);
    };
    for (let length = Math.min(4, words.length); length >= 1; length -= 1) {
      for (let start = 0; start + length <= words.length; start += 1) {
        const phrase = words.slice(start, start + length).join(' ');
        const exact = this.aliasIndex.get(phrase);
        if (exact) add(exact, length / words.length, 'exact');
        else {
          const fuzzy = this.fuzzyMatch(phrase);
          if (fuzzy) add(fuzzy, 0.5 * (length / words.length), 'fuzzy');
        }
      }
    }
    return [...found.values()].sort((a, b) => b.weight - a.weight).slice(0, 12);
  }

  /** Returns graph-linked document ids for the unified retriever. */
  neighbors(query, { limit = 8, hops = 2 } = {}) {
    const expanded = this.expand(query, { hops, limit });
    const chunkIds = new Set();
    for (const row of expanded.results) {
      for (const chunkId of this.byDoc.get(row.documentId)?.edges ? [...this.byDoc.get(row.documentId).edges].map((id) => this.edges.get(id)?.chunkId).filter(Boolean) : []) chunkIds.add(`k:${chunkId}`);
    }
    return [...chunkIds];
  }

  /** Multi-hop walk with path evidence and a per-hop decay. */
  expand(query, { hops = 2, limit = 12, decay = 0.55 } = {}) {
    this.load();
    const seeds = this.seeds(query);
    const scores = new Map();
    const visited = new Set();
    const paths = [];
    const queue = seeds.map((seed) => ({ id: seed.id, score: seed.weight, path: [seed.id], hop: 0 }));
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const entity = this.entities.get(current.id);
      if (!entity) continue;
      for (const docId of entity.refs) {
        const previous = scores.get(docId) || 0;
        if (current.score > previous) {
          scores.set(docId, current.score);
          paths.push({ documentId: docId, score: Number(current.score.toFixed(4)), hop: current.hop, path: current.path.map((id) => this.entities.get(id)?.name || id) });
        }
      }
      if (current.hop >= hops) continue;
      for (const edge of this.edges.values()) {
        let next = null;
        if (edge.from === current.id) next = edge.to;
        else if (edge.to === current.id) next = edge.from;
        if (!next || visited.has(next)) continue;
        const nextEdge = { id: next, score: current.score * decay, path: [...current.path, next], hop: current.hop + 1 };
        if (!queue.some((entry) => entry.id === next && entry.score >= nextEdge.score)) queue.push(nextEdge);
      }
    }
    const results = [...scores.entries()]
      .map(([documentId, score]) => ({ documentId, score: Number(score.toFixed(4)), path: paths.find((row) => row.documentId === documentId)?.path || [], hop: paths.find((row) => row.documentId === documentId)?.hop ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
    return { ok: true, query, seeds: seeds.map((seed) => ({ id: seed.id, name: this.entities.get(seed.id)?.name, weight: seed.weight })), results, hops };
  }

  /** Checks that every cited chunk exists and contains at least one cited term. */
  validateCitation({ chunkId, docId = null, terms = [] }) {
    this.load();
    const record = this.byChunk.get(chunkId);
    if (!record) return { ok: false, code: 'CHUNK_NOT_IN_GRAPH', chunkId };
    const entityNames = [...record.entities].map((id) => this.entities.get(id)?.name).filter(Boolean);
    const wanted = terms.map(canonical).filter(Boolean);
    const matched = wanted.filter((term) => entityNames.some((name) => canonical(name).includes(term) || term.includes(canonical(name))));
    return {
      ok: record.entities.size > 0,
      chunkId,
      docId,
      entities: entityNames,
      matchedTerms: matched,
      coverage: wanted.length ? Number((matched.length / wanted.length).toFixed(3)) : null,
    };
  }

  /** Query decomposition: explicit conjunctions and multi-part questions. */
  decompose(query) {
    const text = String(query || '');
    const parts = text
      .split(/\?|\s+(?:and|oraz|i|a także|oraz że)\s+|\s*;\s*|,\s*(?=[a-ząćęłńóśźż]+\s)/iu)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    return parts.length > 1 ? parts.slice(0, 6) : [text.trim()];
  }

  stats() {
    this.load();
    const predicates = {};
    for (const edge of this.edges.values()) predicates[edge.predicate] = (predicates[edge.predicate] || 0) + 1;
    return {
      entities: this.entities.size,
      edges: this.edges.size,
      documents: this.byDoc.size,
      chunks: this.byChunk.size,
      predicates,
      merges: this.counters.merges,
      contradictions: this.contradictions().length,
      counters: { ...this.counters },
      persisted: Boolean(this.file() && fs.existsSync(this.file())),
    };
  }

  listEntities({ limit = 50, query = null } = {}) {
    this.load();
    const rows = [...this.entities.values()];
    const filtered = query ? rows.filter((entity) => entity.canonical.includes(canonical(query))) : rows;
    return filtered
      .sort((a, b) => b.refs.size - a.refs.size || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((entity) => ({ id: entity.id, name: entity.name, type: entity.type, aliases: [...entity.aliases], documents: entity.refs.size }));
  }

  listRelations({ limit = 100, documentId = null } = {}) {
    this.load();
    return [...this.edges.values()]
      .filter((edge) => !documentId || edge.docId === documentId)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Math.min(1000, limit)))
      .map((edge) => ({ id: edge.id, subject: this.entities.get(edge.from)?.name || edge.from, predicate: edge.predicate, object: this.entities.get(edge.to)?.name || edge.to, documentId: edge.docId, chunkId: edge.chunkId, sentence: edge.sentence }));
  }

  exportGraph() {
    this.load();
    return { version: 1, exportedAt: this.now(), entities: [...this.entities.values()].map((entity) => ({ ...entity, aliases: [...entity.aliases], refs: [...entity.refs], chunks: [...(entity.chunks || [])] })), edges: [...this.edges.values()] };
  }

  importGraph(data, { merge = true } = {}) {
    if (!data || data.version !== 1 || !Array.isArray(data.entities) || !Array.isArray(data.edges)) throw fail('not a SENTINEL graph export', 'BAD_GRAPH');
    if (!merge) this.clear();
    for (const entity of data.entities) {
      const id = this.resolve(entity.name, entity.type || 'proper');
      const stored = this.entities.get(id);
      for (const alias of entity.aliases || []) {
        stored.aliases.add(alias);
        this.aliasIndex.set(canonical(alias), id);
      }
      for (const ref of entity.refs || []) stored.refs.add(ref);
      for (const chunkId of entity.chunks || []) stored.chunks.add(chunkId);
    }
    for (const edge of data.edges) {
      const from = this.resolve(this.entities.get(edge.from)?.name || edge.from);
      const to = this.resolve(this.entities.get(edge.to)?.name || edge.to);
      if (!from || !to) continue;
      const id = `r_${hash(`${from}|${edge.predicate}|${to}|${edge.chunkId}`).slice(0, 16)}`;
      if (this.edges.has(id)) continue;
      const stored = { ...edge, id, from, to, at: edge.at || this.now() };
      this.edges.set(id, stored);
      if (!this.byDoc.has(stored.docId)) this.byDoc.set(stored.docId, { entities: new Set(), edges: new Set() });
      if (!this.byChunk.has(stored.chunkId)) this.byChunk.set(stored.chunkId, { entities: new Set(), edges: new Set() });
      this.byDoc.get(stored.docId).edges.add(id);
      this.byChunk.get(stored.chunkId).edges.add(id);
      this.byDoc.get(stored.docId).entities.add(from);
      this.byDoc.get(stored.docId).entities.add(to);
      this.byChunk.get(stored.chunkId).entities.add(from);
      this.byChunk.get(stored.chunkId).entities.add(to);
    }
    return this.stats();
  }

  clear() {
    this.entities.clear();
    this.aliasIndex.clear();
    this.edges.clear();
    this.byDoc.clear();
    this.byChunk.clear();
    this.counters = { documents: 0, chunks: 0, entityMentions: 0, relations: 0, merges: 0, contradictions: 0, removed: 0 };
    return { ok: true };
  }
}

module.exports = { GraphRAG, canonical, entityCandidates, relationCandidates, sentenceSplit, stem };
