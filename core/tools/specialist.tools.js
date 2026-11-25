'use strict';

/** Gated specialist classifiers: seven tasks plus calibration-aware inference. */

function zoo(ctx) {
  if (!ctx.specialists) throw Object.assign(new Error('the specialist zoo is not available'), { code: 'NO_SPECIALISTS' });
  return ctx.specialists;
}

function operator(ctx) {
  if (!ctx.approval) return null;
  return ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}`;
}

const TASKS = ['tools', 'routing', 'relevance', 'complexity', 'semantic', 'context', 'failure'];

module.exports = [
  {
    name: 'specialists.status',
    title: 'Specialist model status',
    description: 'Datasets, labels, held-out metrics, baselines, calibration temperatures, promotion gates and active checkpoints for seven specialist classifiers. Models are small CPU feature networks, not language models.',
    category: 'learning', permission: 'read', tags: ['specialists', 'neural', 'metrics', 'datasets', 'calibration'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...zoo(ctx).status() }; },
    format: (data) => `${data.specialists.filter((entry) => entry.active).length}/${data.specialists.length} aktywnych modeli`,
  },
  {
    name: 'specialists.predict',
    title: 'Run a specialist model',
    description: 'Predicts a tool name, an agent domain, memory relevance, task complexity, semantic match or context importance. Predictions expose calibrated confidence, the neural label, the lexical baseline and whether the baseline fallback was used.',
    category: 'learning', permission: 'read', tags: ['specialists', 'inference', 'routing', 'tool-selection', 'calibration'],
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: TASKS },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        memory: { type: 'string', maxLength: 4000 },
        passage: { type: 'string', maxLength: 4000 },
        chunk: { type: 'string', maxLength: 4000 },
        position: { type: 'number', minimum: 0, maximum: 100 },
        recency: { type: 'number', minimum: 0, maximum: 1 },
        importance: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['task', 'text'], additionalProperties: false,
    },
    async run(args, ctx) {
      if (args.task === 'relevance') return zoo(ctx).memoryRelevance({ query: args.text, memory: args.memory, recency: args.recency, importance: args.importance });
      if (args.task === 'complexity') return zoo(ctx).complexity(args.text);
      if (args.task === 'semantic') return zoo(ctx).semanticSimilarity({ query: args.text, passage: args.passage });
      if (args.task === 'context') return zoo(ctx).contextImportance({ query: args.text, chunk: args.chunk, position: args.position });
      return zoo(ctx).predict(args.task, args.text);
    },
    format: (data) => (data.ok ? `${data.label} (${data.confidence})` : data.code),
  },
  {
    name: 'specialists.similarity',
    title: 'Semantic similarity',
    description: 'Scores whether a passage answers a question with a promoted 8-feature model trained with hard same-topic negatives. This is a feature classifier, not an embedding model or a language model.',
    category: 'learning', permission: 'read', tags: ['specialists', 'similarity', 'retrieval', 'neural'],
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, passage: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['query', 'passage'], additionalProperties: false },
    async run(args, ctx) { return zoo(ctx).semanticSimilarity({ query: args.query, passage: args.passage }); },
    format: (data) => (data.ok ? `${data.label} (${data.confidence})` : data.code),
  },
  {
    name: 'specialists.context_importance',
    title: 'Context importance',
    description: 'Classifies a candidate context chunk as critical, useful or background for a question. Used by the brain to demote background chunks before the prompt budget is spent.',
    category: 'learning', permission: 'read', tags: ['specialists', 'context', 'prompt', 'neural'],
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, chunk: { type: 'string', minLength: 1, maxLength: 4000 }, position: { type: 'number', minimum: 0, maximum: 100 }, recency: { type: 'number', minimum: 0, maximum: 1 }, prior: { type: 'number', minimum: 0, maximum: 1 } }, required: ['query', 'chunk'], additionalProperties: false },
    async run(args, ctx) { return zoo(ctx).contextImportance({ query: args.query, chunk: args.chunk, position: args.position, recency: args.recency, prior: args.prior }); },
    format: (data) => (data.ok ? `${data.label} (${data.confidence})` : data.code),
  },
  {
    name: 'specialists.failure_risk',
    title: 'Tool-call failure risk',
    description: 'Estimates low/elevated/high failure risk for a planned tool call from permission, network, argument size, timeout, retries, recent failures and concurrency. Synthetic rubric labels; advisory only, never a block.',
    category: 'learning', permission: 'read', tags: ['specialists', 'failure', 'execution', 'neural', 'advisory'],
    parameters: {
      type: 'object',
      properties: {
        permission: { type: 'string', enum: ['read', 'network', 'write', 'system', 'privileged'] },
        requiresNetwork: { type: 'boolean' },
        timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
        retries: { type: 'number', minimum: 0, maximum: 20 },
        recentFailures: { type: 'number', minimum: 0, maximum: 100 },
        approval: { type: 'boolean' },
        concurrentCalls: { type: 'number', minimum: 0, maximum: 100 },
        dependencyDepth: { type: 'number', minimum: 0, maximum: 20 },
        queueDelayMs: { type: 'number', minimum: 0, maximum: 600000 },
        payloadRisk: { type: 'boolean' },
        args: { type: 'object' },
      },
      required: ['permission'], additionalProperties: false,
    },
    async run(args, ctx) { return zoo(ctx).failureRisk(args); },
    format: (data) => (data.ok ? `${data.label} (${data.confidence})` : data.code),
  },
  {
    name: 'specialists.train',
    title: 'Train a specialist model',
    description: 'Trains one specialist on its dataset with a group-disjoint split, a named baseline and temperature calibration. Writes a checksummed checkpoint outside the source tree. Requires a consumed human approval; never promotes automatically.',
    category: 'learning', permission: 'system', tags: ['specialists', 'training', 'neural', 'approval', 'calibration'],
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
