'use strict';

/**
 * Hybrid retrieval: BM25 (exact words, great for names, paths, error codes)
 * fused with vector similarity (paraphrase, different wording) using
 * Reciprocal Rank Fusion. RRF is used because it needs no score calibration
 * between the two rankers — a known-good property when the embedder can change.
 */

const { tokenize, cosine, expandQuery } = require('./embeddings');

const K1 = 1.5;
const B = 0.75;
const RRF_K = 60;

class Bm25Index {
  constructor() {
    this.docs = new Map(); // id → { tokens: Map<term, tf>, length }
    this.termDocs = new Map(); // term → Set<id>
    this.totalLength = 0;
  }

  get size() {
    return this.docs.size;
  }

  add(id, text) {
    this.remove(id);
    const tokens = tokenize(text);
    if (!tokens.length) return;
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
      if (!this.termDocs.has(token)) this.termDocs.set(token, new Set());
      this.termDocs.get(token).add(id);
    }
    this.docs.set(id, { tf, length: tokens.length });
    this.totalLength += tokens.length;
  }

  remove(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.tf.keys()) {
      const set = this.termDocs.get(term);
      if (set) {
        set.delete(id);
        if (!set.size) this.termDocs.delete(term);
      }
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
  }

  get averageLength() {
    return this.docs.size ? this.totalLength / this.docs.size : 0;
  }

  /** @returns {Array<{id: string, score: number}>} sorted, score > 0 */
  search(query, { limit = 50 } = {}) {
    const terms = [...new Set(tokenize(expandQuery(query)))];
    if (!terms.length || !this.docs.size) return [];
    const avg = this.averageLength || 1;
    const scores = new Map();
    for (const term of terms) {
      const set = this.termDocs.get(term);
      if (!set) continue;
      const df = set.size;
      // Terms in more than half the collection are near-noise here.
      if (df / this.docs.size > 0.6 && df > 8) continue;
      const idf = Math.log(1 + (this.docs.size - df + 0.5) / (df + 0.5));
      for (const id of set) {
        const doc = this.docs.get(id);
        const tf = doc.tf.get(term) || 0;
        if (!tf) continue;
        const contribution = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avg)));
        scores.set(id, (scores.get(id) || 0) + contribution);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Fuses lexical and vector rankings.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {Array<{id: string, text: string, vector?: Float32Array, vectorName?: string}>} args.records
 * @param {Bm25Index} args.index
 * @param {Float32Array|null} args.queryVector
 * @param {string} args.vectorName  embedder identity the query vector belongs to
 * @param {number} args.limit
 * @param {(record: object) => number} [args.boost]  extra multiplier (recency, importance)
 */
function hybridSearch({ query, records, index, queryVector = null, vectorName = null, limit = 10, boost = null }) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const lexical = index.search(query, { limit: 80 });

  let vectorRanking = [];
  if (queryVector) {
    const scored = [];
    for (const record of records) {
      if (!record.vector || record.dim !== queryVector.length) continue;
      // Vectors from different embedders live in different spaces.
      if (record.vectorName && vectorName && record.vectorName !== vectorName) continue;
      const similarity = cosine(queryVector, record.vector);
      if (similarity > 0.008) scored.push({ id: record.id, score: similarity });
    }
    vectorRanking = scored.sort((a, b) => b.score - a.score).slice(0, 80);
  }

  // Normalise each ranker to 0..1 and blend. Pure rank fusion (RRF) throws away
  // the strength of a match — with three memories, an exact "404" hit would tie
  // with a vague neighbour. Blending keeps magnitude; RRF still contributes as
  // a tiebreaker so agreement between both rankers is rewarded.
  const maxLex = lexical.length ? lexical[0].score : 0;
  const maxVec = vectorRanking.length ? vectorRanking[0].score : 0;
  const scores = new Map();

  const add = (id, lexPart, vecPart, source) => {
    const entry = scores.get(id) || { id, lex: 0, vec: 0, sources: [], rrf: 0 };
    entry.lex = Math.max(entry.lex, lexPart);
    entry.vec = Math.max(entry.vec, vecPart);
    entry.rrf += source === 'bm25' ? 0 : 0;
    if (!entry.sources.includes(source)) entry.sources.push(source);
    scores.set(id, entry);
  };

  lexical.forEach((hit, rank) => {
    add(hit.id, maxLex ? hit.score / maxLex : 0, 0, 'bm25');
    const entry = scores.get(hit.id);
    entry.rrf += 1 / (RRF_K + rank + 1);
  });
  vectorRanking.forEach((hit, rank) => {
    const existing = scores.get(hit.id);
    const vecPart = maxVec ? hit.score / maxVec : 0;
    if (existing) existing.vec = Math.max(existing.vec, vecPart);
    else add(hit.id, 0, vecPart, 'vector');
    scores.get(hit.id).rrf += 1 / (RRF_K + rank + 1);
  });

  const out = [];
  for (const entry of scores.values()) {
    const record = byId.get(entry.id);
    if (!record) continue;
    const blended = 0.65 * entry.lex + 0.35 * entry.vec + 0.2 * Math.min(1, entry.rrf * 60);
    const multiplier = boost ? boost(record) : 1;
    out.push({
      record,
      score: blended * multiplier,
      sources: entry.sources,
      lexicalScore: entry.lex,
      vectorScore: entry.vec,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { Bm25Index, hybridSearch, RRF_K };
