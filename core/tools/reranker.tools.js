'use strict';

/** Reranker tools. Training and promotion stay approval-gated in the lab. */

function lab(ctx) {
  if (!ctx.reranker) throw Object.assign(new Error('the reranker lab is not available'), { code: 'NO_RERANKER' });
  return ctx.reranker;
}

module.exports = [
  {
    name: 'reranker.status',
    title: 'Retrieval reranker status',
    description: 'Dataset provenance and hash, features, experiments with held-out NDCG@3 against the lexical baseline, active model and honest scope (small CPU MLP, not a cross-encoder).',
    category: 'knowledge', permission: 'read', tags: ['retrieval', 'reranker', 'neural', 'metrics'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...lab(ctx).status() }; },
    format: (data) => (data.active ? `NDCG@3 ${data.active.metrics.ndcgAt3} vs baseline ${data.active.baseline.ndcgAt3}` : 'brak aktywnego rerankera'),
  },
  {
    name: 'reranker.rerank',
    title: 'Rerank passages with the promoted model',
    description: 'Scores up to 50 candidate passages with the promoted CPU reranker and returns the measured ordering and feature values. Refuses with NO_MODEL when nothing is promoted.',
    category: 'knowledge', permission: 'read', tags: ['retrieval', 'reranker', 'ranking', 'search'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1000 },
        candidates: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 2000 } },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
      required: ['query', 'candidates'], additionalProperties: false,
    },
    async run(args, ctx) { return lab(ctx).rerank(args); },
    format: (data) => (data.ok ? `${data.ranked.length} kandydatów, model NDCG ${data.model.ndcgAt3}` : data.code),
  },
];
