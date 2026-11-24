'use strict';

/**
 * Learning-lab tools.
 *
 * Training and promotion are approval-gated: the tools read only the consumed
 * approval record on the context, never a `confirm:true` supplied by a model.
 * Nothing here touches base model weights; artifacts live under SENTINEL_HOME.
 */

function lab(ctx) {
  if (!ctx.lab) throw Object.assign(new Error('the learning lab is not available'), { code: 'NO_LAB' });
  return ctx.lab;
}

function operator(ctx) {
  if (!ctx.approval) return null;
  return ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}`;
}

module.exports = [
  {
    name: 'lab.status',
    title: 'Learning lab status',
    description: 'Dataset provenance and hash, train/validation/test sizes, experiments with measured accuracy against the keyword baseline, active model and honest scope (small CPU MLP, not LoRA).',
    category: 'learning',
    permission: 'read',
    tags: ['lab', 'training', 'metrics', 'dataset'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return { ok: true, ...lab(ctx).status() };
    },
    format: (data) => `${data.experiments.length} eksperymentów, aktywne: ${data.active ? data.active.metrics.accuracy : 'brak'}`,
  },
  {
    name: 'lab.train_intent',
    title: 'Train the intent classifier (CPU)',
    description: 'Trains a small MLP on the bundled synthetic bilingual dataset with a deterministic split, deduplication, contamination check, baseline comparison, early stopping and a checksummed checkpoint outside the source tree. Requires a consumed human approval; it never starts from conversation content.',
    category: 'learning',
    permission: 'system',
    tags: ['lab', 'training', 'neural', 'classification', 'approval'],
    parameters: {
      type: 'object',
      properties: {
        epochs: { type: 'number', minimum: 5, maximum: 200 },
        seed: { type: 'number', minimum: 1, maximum: 1000000 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'training needs a consumed approval from a human' };
      const result = lab(ctx).trainIntent({ approvedBy, epochs: args.epochs || 40, seed: args.seed || 7 });
      if (!result.ok) return result;
      return { ok: true, experiment: result.experiment };
    },
    format: (data) => (data.ok ? `trening: test ${data.experiment.metrics.accuracy} vs baseline ${data.experiment.baseline.accuracy} (${data.experiment.status})` : `odmowa: ${data.code}`),
  },
  {
    name: 'lab.classify',
    title: 'Classify intent with the promoted model',
    description: 'Runs the promoted CPU classifier and returns the intent with calibrated-by-softmax probabilities. Refuses with NO_MODEL when no model has been promoted.',
    category: 'learning',
    permission: 'read',
    tags: ['lab', 'inference', 'classification', 'intent'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return lab(ctx).classify(args.text);
    },
    format: (data) => (data.ok ? `${data.intent} (${data.confidence})` : `brak modelu: ${data.code}`),
  },
  {
    name: 'lab.promote',
    title: 'Promote a trained model',
    description: 'Makes a candidate experiment active after a consumed human approval, recording the previous model for rollback. Validation metrics are re-checked; a rejected experiment cannot be promoted.',
    category: 'learning',
    permission: 'system',
    tags: ['lab', 'promotion', 'approval', 'rollback'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED' };
      return lab(ctx).promote(args.id, { approvedBy });
    },
    format: (data) => (data.ok ? `aktywne: ${data.active.experimentId}` : `odmowa: ${data.code}`),
  },
  {
    name: 'lab.rollback',
    title: 'Roll back the active model',
    description: 'Restores the previously promoted model checkpoint after a consumed human approval. Refuses when there is no previous model.',
    category: 'learning',
    permission: 'system',
    tags: ['lab', 'rollback', 'approval'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED' };
      return lab(ctx).rollback({ approvedBy });
    },
    format: (data) => (data.ok ? `przywrocono ${data.active.experimentId}` : `odmowa: ${data.code}`),
  },
];
