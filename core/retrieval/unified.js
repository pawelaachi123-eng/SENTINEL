'use strict';

/**
 * Unified retrieval: lexical BM25, hashed-vector cosine, graph proximity and
 * optional trained reranking in one transparent pipeline.
 *
 * Every stage returns its own score and provenance. Reciprocal-rank fusion is
 * used so no component dominates because of an arbitrary raw-score scale. The
 * semantic specialist and the retrieval reranker are optional: without a
 * promoted model the pipeline reports `neural: null` instead of pretending.
 */

const { vectorize, cosine, tokens } = require('../ml/features');

function bm25Scores(documents, query, { k1 = 1.2, b = 0.75 } = {}) {
  const queryTerms = [...new Set(tokens(query))];
  const docs = documents.map((document) => {
    const terms = tokens(`${document.text} ${(document.tags || []).join(' ')}`);
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return { tf, length: terms.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const term of queryTerms) df.set(term, docs.filter((doc) => doc.tf.has(term)).length);
  return docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = doc.tf.get(term) || 0;
      if (!frequency) continue;
      const idf = Math.log(1 + (documents.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (doc.length / Math.max(1, average)))));
    }
    return score;
  });
}

function ranks(scores) {
  const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const out = new Map();
  order.forEach((entry, rank) => out.set(entry.index, rank + 1));
  return out;
}

function ndcgAt(ranked, relevance, k = 3) {
  const dcg = ranked.slice(0, k).reduce((sum, doc, index) => sum + (2 ** (relevance.get(doc.id) || 0) - 1) / Math.log2(index + 2), 0);
  const ideal = [...relevance.values()].sort((a, b) => b - a).slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return ideal ? dcg / ideal : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(3));
}

class UnifiedRetriever {
  constructor({ documents = [], graph = null, reranker = null, specialists = null } = {}) {
    this.documents = documents.map((document, index) => ({
      id: String(document.id || `doc-${index}`),
      text: String(document.text || ''),
      tags: Array.isArray(document.tags) ? document.tags : [],
      group: document.group || null,
      metadata: document.metadata || null,
      vector: Array.from(vectorize(`${document.text || ''} ${(document.tags || []).join(' ')}`)),
    }));
    this.graph = graph;
    this.reranker = reranker;
    this.specialists = specialists;
    this.byGroup = new Map();
    for (const document of this.documents) {
      if (!document.group) continue;
      if (!this.byGroup.has(document.group)) this.byGroup.set(document.group, []);
      this.byGroup.get(document.group).push(document);
    }
    this.counters = { queries: 0, lexical: 0, vector: 0, graph: 0, neural: 0 };
  }

  search(query, { limit = 10, useGraph = true, useNeural = true } = {}) {
    const started = process.hrtime.bigint();
    this.counters.queries += 1;
    if (!this.documents.length) return { ok: true, query, results: [], ms: 0, provenance: { lexical: 0, vector: 0, graph: 0, neural: null } };
    const lexical = bm25Scores(this.documents, query);
    const queryVector = vectorize(query);
    const vector = this.documents.map((document) => cosine(queryVector, document.vector));
    const lexicalRank = ranks(lexical);
    const vectorRank = ranks(vector);
    const graphScores = new Map();
    if (useGraph && this.graph && typeof this.graph.neighbors === 'function') {
      try {
        for (const id of this.graph.neighbors(query, { limit: 8 })) graphScores.set(String(id), 1);
      } catch { /* an unavailable graph is not a crash */ }
    }
    if (useGraph && !graphScores.size) {
      const topLexical = this.documents[[...lexicalRank.entries()].sort((a, b) => a[1] - b[1])[0][0]];
      const group = topLexical && topLexical.group;
      if (group) for (const document of this.byGroup.get(group) || []) graphScores.set(document.id, 1);
    }
    const graphRank = ranks(this.documents.map((document) => graphScores.get(document.id) || 0));
    const fused = this.documents.map((document, index) => ({
      id: document.id,
      document,
      lexical: Number(lexical[index].toFixed(4)),
      vector: Number(vector[index].toFixed(4)),
      graph: graphScores.get(document.id) || 0,
      score: 0.55 / (60 + lexicalRank.get(index)) + 0.35 / (60 + vectorRank.get(index)) + 0.10 / (60 + graphRank.get(index)),
    })).sort((a, b) => b.score - a.score).slice(0, Math.max(limit * 3, 20));
    let neural = null;
    if (useNeural && this.specialists) {
      try {
        for (const candidate of fused) {
          const result = this.specialists.semanticSimilarity({ query, passage: candidate.document.text });
          if (result && result.ok) {
            candidate.neural = { label: result.label, confidence: result.confidence, temperature: result.temperature };
            candidate.score += result.label === 'match' ? 0.02 * result.confidence : -0.01 * result.confidence;
          }
        }
        neural = 'semantic-specialist';
      } catch { neural = null; }
    }
    if (useNeural && this.reranker && this.reranker.rerank) {
      try {
        const output = this.reranker.rerank({ query, candidates: fused.map((candidate) => candidate.document.text), limit: fused.length });
        if (output && output.ok && Array.isArray(output.ranked)) {
          const order = new Map(output.ranked.map((entry, index) => [entry.doc, index]));
          for (const candidate of fused) {
            const rank = order.get(candidate.document.text);
            if (rank !== undefined) candidate.score += 0.015 / (rank + 1);
            candidate.reranker = rank === undefined ? null : rank + 1;
          }
          neural = neural ? `${neural}+retrieval-reranker` : 'retrieval-reranker';
        }
      } catch { /* keep the fused ranking if the model is unavailable */ }
    }
    fused.sort((a, b) => b.score - a.score);
    const results = fused.slice(0, limit).map((candidate) => ({
      id: candidate.id,
      text: candidate.document.text,
      score: Number(candidate.score.toFixed(6)),
      lexical: candidate.lexical,
      vector: candidate.vector,
      graph: candidate.graph,
      neural: candidate.neural || null,
      reranker: candidate.reranker ?? null,
      provenance: candidate.document.metadata || { group: candidate.document.group },
    }));
    const ms = Number(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2);
    return {
      ok: true,
      query,
      results,
      ms: Number(ms),
      provenance: {
        lexical: lexical.filter((score) => score > 0).length,
        vector: vector.filter((score) => score > 0.0001).length,
        graph: graphScores.size,
        neural,
      },
    };
  }

  benchmark(cases, { k = 3 } = {}) {
    const modes = ['lexical', 'vector', 'hybrid', 'neural'];
    const report = { cases: cases.length, k, modes: {}, latency: {} };
    for (const mode of modes) {
      const durations = [];
      let ndcg = 0;
      let reciprocal = 0;
      let recall = 0;
      for (const item of cases) {
        const relevance = new Map(item.candidates.map((candidate) => [String(candidate.id || candidate.doc), candidate.grade]));
        const started = process.hrtime.bigint();
        const search = this.search(item.query, {
          limit: Math.max(k, item.candidates.length),
          useGraph: mode !== 'vector',
          useNeural: mode === 'neural',
        });
        durations.push(Number(process.hrtime.bigint() - started) / 1e6);
        const ranked = search.results
          .map((result) => ({ id: result.id, score: mode === 'lexical' ? result.lexical : mode === 'vector' ? result.vector : result.score }))
          .sort((a, b) => b.score - a.score);
        ndcg += ndcgAt(ranked, relevance, k);
        const at = ranked.findIndex((result) => (relevance.get(result.id) || 0) >= 1);
        if (at >= 0) reciprocal += 1 / (at + 1);
        const found = ranked.slice(0, k).filter((result) => (relevance.get(result.id) || 0) >= 1).length;
        recall += found / Math.max(1, [...relevance.values()].filter((grade) => grade >= 1).length);
      }
      report.modes[mode] = {
        ndcgAtK: Number((ndcg / Math.max(1, cases.length)).toFixed(4)),
        mrr: Number((reciprocal / Math.max(1, cases.length)).toFixed(4)),
        recallAtK: Number((recall / Math.max(1, cases.length)).toFixed(4)),
      };
      report.latency[mode] = { p50: percentile(durations, 50), p95: percentile(durations, 95) };
    }
    return report;
  }
}

/** Builds a corpus and graded cases from the existing retrieval dataset. */
function benchmarkFromRelevanceData(data) {
  const documents = new Map();
  const cases = [];
  for (const item of data) {
    const candidates = item.candidates.map((candidate) => {
      const id = `doc-${Buffer.from(candidate.doc).toString('base64').slice(0, 24)}`;
      if (!documents.has(id)) documents.set(id, { id, text: candidate.doc, group: item.group });
      return { id, doc: candidate.doc, grade: candidate.grade };
    });
    cases.push({ query: item.query, group: item.group, candidates });
  }
  return { documents: [...documents.values()], cases };
}

module.exports = { UnifiedRetriever, bm25Scores, ndcgAt, percentile, benchmarkFromRelevanceData };
