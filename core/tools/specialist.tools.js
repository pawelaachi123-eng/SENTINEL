'use strict';

/** Four small specialist classifiers with gated promotion. */

function zoo(ctx) {
  if (!ctx.specialists) throw Object.assign(new Error('the specialist zoo is not available'), { code: 'NO_SPECIALISTS' });
  return ctx.specialists;
}

function operator(ctx) {
  if (!ctx.approval) return null;
  return ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}`;
}

const TASKS = ['tools', 'routing', 'relevance', 'complexity'];

module.exports = [
  {
    name: 'specialists.status',
    title: 'Specialist model status',
    description: 'Datasets, labels, held-out metrics, baselines, promotion gates and the active checkpoint for tool selection, agent routing, memory relevance and task complexity. Models are small CPU feature networks, not language models.',
    category: 'learning', permission: 'read', tags: ['specialists', 'neural', 'metrics', 'datasets'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...zoo(ctx).status() }; },
    format: (data) => `${data.specialists.filter((entry) => entry.active).length}/${data.specialists.length} aktywnych modeli`,
  },
  {
    name: 'specialists.predict',
    title: 'Run a specialist model',
    description: 'Predicts a tool name, an agent domain, memory relevance or task complexity with a promoted model. Predictions expose confidence, the neural label, the lexical baseline and whether the baseline fallback was used.',
    category: 'learning', permission: 'read', tags: ['specialists', 'inference', 'routing', 'tool-selection'],
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: TASKS },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        memory: { type: 'string', maxLength: 4000 },
        recency: { type: 'number', minimum: 0, maximum: 1 },
        importance: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['task', 'text'], additionalProperties: false,
    },
    async run(args, ctx) {
      if (args.task === 'relevance') return zoo(ctx).memoryRelevance({ query: args.text, memory: args.memory, recency: args.recency, importance: args.importance });
      if (args.task === 'complexity') return zoo(ctx).complexity(args.text);
      return zoo(ctx).predict(args.task, args.text);
    },
    format: (data) => (data.ok ? `${data.label} (${data.confidence})` : data.code),
  },
  {
    name: 'specialists.train',
    title: 'Train a specialist model',
    description: 'Trains one specialist on its authored dataset with a stratified held-out split and a named baseline. Writes a checksummed checkpoint outside the source tree. Requires a consumed human approval; never promotes automatically.',
    category: 'learning', permission: 'system', tags: ['specialists', 'training', 'neural', 'approval'],
    parameters: { type: 'object', properties: { task: { type: 'string', enum: TASKS }, epochs: { type: 'number', minimum: 5, maximum: 1000 } }, required: ['task'], additionalProperties: false },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'training needs a consumed human approval' };
      return zoo(ctx).train(args.task, { approvedBy, epochs: args.epochs || null });
    },
    format: (data) => (data.ok ? `${data.experiment.metrics.accuracy} vs ${data.experiment.baseline.accuracy}` : data.code),
  },
  {
    name: 'specialists.promote',
    title: 'Promote a specialist model',
    description: 'Promotes a gated specialist experiment. A model whose held-out accuracy is below its baseline cannot be promoted. Requires a consumed human approval and keeps the previous checkpoint reference for rollback.',
    category: 'learning', permission: 'system', tags: ['specialists', 'promotion', 'neural', 'approval'],
    parameters: { type: 'object', properties: { task: { type: 'string', enum: TASKS }, id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['task', 'id'], additionalProperties: false },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs a consumed human approval' };
      return zoo(ctx).promote(args.task, args.id, { approvedBy });
    },
    format: (data) => (data.ok ? data.active.experimentId : data.code),
  },
];
