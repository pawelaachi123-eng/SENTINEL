'use strict';

/**
 * Training-lab tools.
 *
 * Every tool is a thin, validating surface over `TrainingLab`. Training tools
 * are CPU-sized and bounded; promotion and rollback require a consumed human
 * approval, not a model-supplied boolean. Nothing here can start a run on
 * personal data without an approved identity.
 */

function training(ctx) {
  if (!ctx.trainingLab) throw Object.assign(new Error('the training lab is not available'), { code: 'NO_TRAINING_LAB' });
  return ctx.trainingLab;
}

const operator = (ctx) => (ctx.approval ? ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}` : null);

module.exports = [
  {
    name: 'training.status',
    title: 'Training lab status',
    description: 'Datasets, adapters, active adapter, queue state and measured counters for the genuine CPU training lab.',
    category: 'learning',
    permission: 'read',
    tags: ['training', 'lab', 'lora', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...training(ctx).status() }; },
    format: (data) => `${data.datasets.length} zbiorów, ${data.adapters.length} adapterów, kolejka: ${data.queue.counts.running || 0} aktywnych`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'training.dataset_create',
    title: 'Create a versioned dataset',
    description: 'Writes an immutable JSONL dataset version with SHA-256, schema validation and an optional personal-data approval.',
    category: 'learning',
    permission: 'write',
    tags: ['dataset', 'versioning', 'provenance'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        rows: { type: 'array', minItems: 1, maxItems: 5000 },
        source: { type: 'string', maxLength: 200, default: 'user' },
        personalData: { type: 'boolean', default: false },
      },
      required: ['name', 'rows'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (args.personalData && !approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'personal data needs a consumed human approval' };
      return { ok: true, ...training(ctx).createDataset({ name: args.name, rows: args.rows, source: args.source, personalData: args.personalData, approvedBy }) };
    },
    format: (data) => (data.ok ? `${data.name} v${data.version}: ${data.rows} wierszy ${data.sha256.slice(0, 12)}` : data.code),
  },
  {
    name: 'training.dataset_list',
    title: 'List dataset versions',
    description: 'Lists immutable dataset versions with row counts, hashes and personal-data flags.',
    category: 'learning',
    permission: 'read',
    tags: ['dataset', 'versioning'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, datasets: training(ctx).listDatasets() }; },
    format: (data) => `${data.datasets.length} wersji`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'training.dataset_split',
    title: 'Deterministic dataset split',
    description: 'Splits a dataset version reproducibly by seed and reports membership counts and hashes.',
    category: 'learning',
    permission: 'read',
    tags: ['dataset', 'split', 'reproducible'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1 },
        seed: { type: 'integer', minimum: 1, default: 42 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const split = training(ctx).splitDataset(args.name, { version: args.version || null, seed: args.seed });
      return { ok: true, manifest: split.manifest, seed: split.seed, sizes: split.sizes };
    },
    format: (data) => (data.ok ? `train ${data.sizes.train}, val ${data.sizes.validation}, test ${data.sizes.test}` : data.code),
  },
  {
    name: 'training.lora',
    title: 'Train a LoRA adapter',
    description: 'Trains a genuine low-rank adapter on a frozen small network and reports adapted versus frozen held-out accuracy.',
    category: 'learning',
    permission: 'write',
    tags: ['lora', 'training', 'neural'],
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', minLength: 1 },
        sourceDataset: { type: 'string' },
        rank: { type: 'integer', minimum: 1, maximum: 16, default: 2 },
        epochs: { type: 'integer', minimum: 5, maximum: 400, default: 120 },
        dim: { type: 'integer', minimum: 8, maximum: 64, default: 24 },
        learningRate: { type: 'number', minimum: 0.001, maximum: 1, default: 0.1 },
        seed: { type: 'integer', minimum: 1, default: 42 },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).trainLora(args); },
    format: (data) => (data.ok ? `LoRA: ${data.evaluation.adapted.accuracy} vs ${data.evaluation.frozen.accuracy}, ${data.trainableParameters} parametrów` : data.code),
  },
  {
    name: 'training.qlora',
    title: 'Train a QLoRA adapter',
    description: 'Quantises the frozen base to 4-bit per-column affine values, trains a low-rank adapter and reports quantisation error.',
    category: 'learning',
    permission: 'write',
    tags: ['qlora', 'quantization', 'training'],
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', minLength: 1 },
        sourceDataset: { type: 'string' },
        rank: { type: 'integer', minimum: 1, maximum: 16, default: 2 },
        epochs: { type: 'integer', minimum: 5, maximum: 400, default: 120 },
        dim: { type: 'integer', minimum: 8, maximum: 64, default: 24 },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).trainQlora(args); },
    format: (data) => (data.ok ? `QLoRA 4-bit: ${data.evaluation.adapted.accuracy} (błąd ${data.quantization.w1RelativeError})` : data.code),
  },
  {
    name: 'training.distill',
    title: 'Distil a teacher into a student',
    description: 'Trains a teacher, distils its probability distribution into a smaller student and measures held-out accuracy against the same student trained on hard labels.',
    category: 'learning',
    permission: 'write',
    tags: ['distillation', 'training', 'teacher'],
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', minLength: 1 },
        teacherHidden: { type: 'integer', minimum: 8, maximum: 64, default: 32 },
        studentHidden: { type: 'integer', minimum: 4, maximum: 32, default: 8 },
        epochs: { type: 'integer', minimum: 5, maximum: 300, default: 100 },
        temperature: { type: 'number', minimum: 0.1, maximum: 10, default: 1.5 },
        alpha: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).distill(args); },
    format: (data) => (data.ok ? `destylacja: ${data.distilled.evaluation.accuracy} vs ${data.plain.evaluation.accuracy} (nauczyciel ${data.teacher.evaluation.accuracy})` : data.code),
  },
  {
    name: 'training.preference',
    title: 'Train a preference model',
    description: 'Bradley–Terry pairwise preference training with held-out pairwise accuracy and a zero-weight baseline.',
    category: 'learning',
    permission: 'write',
    tags: ['preference', 'ranking', 'training'],
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 20, maximum: 400, default: 120 },
        epochs: { type: 'integer', minimum: 5, maximum: 300, default: 80 },
        seed: { type: 'integer', minimum: 1, default: 42 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).preference({ count: args.count, epochs: args.epochs, seed: args.seed }); },
    format: (data) => (data.ok ? `preferencje: ${data.test.accuracy} (baseline ${data.baseline.accuracy})` : data.code),
  },
  {
    name: 'training.gpt',
    title: 'Train a compact autoregressive transformer',
    description: 'Trains a real char-level decoder-only transformer with causal attention on supplied text and reports loss and perplexity.',
    category: 'learning',
    permission: 'write',
    tags: ['gpt', 'transformer', 'language-model'],
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        texts: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 20000 } },
        name: { type: 'string', maxLength: 40, default: 'gpt' },
        epochs: { type: 'integer', minimum: 1, maximum: 60, default: 8 },
        maxLen: { type: 'integer', minimum: 8, maximum: 64, default: 32 },
        dim: { type: 'integer', minimum: 8, maximum: 64, default: 24 },
        blocks: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
      },
      required: ['texts'],
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).trainGpt(args); },
    format: (data) => (data.ok ? `GPT: loss ${data.report.final.trainLoss.toFixed(3)}, próbka: ${data.sample.text.slice(0, 60)}` : data.code),
  },
  {
    name: 'training.generate',
    title: 'Generate from a compact transformer',
    description: 'Samples from a checkpoint trained by this lab. It is a tiny character model, not a general assistant.',
    category: 'learning',
    permission: 'read',
    tags: ['gpt', 'generation'],
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        checkpointPath: { type: 'string' },
        prompt: { type: 'string', maxLength: 500, default: '' },
        maxNewTokens: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
        temperature: { type: 'number', minimum: 0, maximum: 3, default: 0.8 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) { return { ok: true, ...training(ctx).generateGpt(args) }; },
    format: (data) => (data.ok ? data.text : data.code),
  },
  {
    name: 'training.hpo',
    title: 'Hyper-parameter search',
    description: 'Grid or random search over rank and learning rate with measured trial scores and durations.',
    category: 'learning',
    permission: 'write',
    tags: ['hpo', 'search', 'tuning'],
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['grid', 'random'], default: 'random' },
        budget: { type: 'integer', minimum: 1, maximum: 20, default: 4 },
        epochs: { type: 'integer', minimum: 5, maximum: 200, default: 50 },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
    async run(args, ctx) { return training(ctx).hpo(args); },
    format: (data) => (data.ok ? `najlepsze: ${JSON.stringify(data.best.params)} → ${data.best.score}` : data.code),
  },
  {
    name: 'training.adapters',
    title: 'List saved adapters',
    description: 'Saved LoRA, QLoRA, distillation, preference and GPT artifacts with metrics and active status.',
    category: 'learning',
    permission: 'read',
    tags: ['adapter', 'registry'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, adapters: training(ctx).listAdapters(), active: training(ctx).adapters.active() }; },
    format: (data) => `${data.adapters.length} adapterów${data.active ? `, aktywny ${data.active.id}` : ''}`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'training.compare',
    title: 'Compare adapters',
    description: 'Compares adapters evaluated on the same metric set and reports the best by the primary metric.',
    category: 'learning',
    permission: 'read',
    tags: ['adapter', 'compare'],
    parameters: { type: 'object', properties: { ids: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' } } }, required: ['ids'], additionalProperties: false },
    async run(args, ctx) { return training(ctx).compareAdapters(args.ids); },
    format: (data) => (data.ok ? `najlepszy: ${data.best}` : data.code),
  },
  {
    name: 'training.promote',
    title: 'Promote an adapter',
    description: 'Activates an evaluated adapter. Requires a consumed human approval and rejects missing metrics or failed gates.',
    category: 'learning',
    permission: 'system',
    tags: ['adapter', 'promotion', 'approval'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, minAccuracy: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs a consumed human approval' };
      return training(ctx).promoteAdapter(args.id, { approvedBy, minMetrics: args.minAccuracy == null ? null : { accuracy: args.minAccuracy } });
    },
    format: (data) => (data.ok ? `aktywny: ${data.active.id}` : data.code || data.message),
  },
  {
    name: 'training.rollback',
    title: 'Roll back the active adapter',
    description: 'Moves the active pointer to the previous adapter. Requires a consumed human approval; no artifact is deleted.',
    category: 'learning',
    permission: 'system',
    tags: ['adapter', 'rollback', 'approval'],
    parameters: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false },
    async run(args, ctx) {
      const approvedBy = operator(ctx);
      if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'rollback needs a consumed human approval' };
      return training(ctx).rollbackAdapter({ approvedBy, to: args.to || null });
    },
    format: (data) => (data.ok ? `aktywny: ${data.active.id}` : data.code),
  },
  {
    name: 'training.queue',
    title: 'Training queue status',
    description: 'Durable queue counts, recent jobs, retries and checkpoints.',
    category: 'learning',
    permission: 'read',
    tags: ['queue', 'training', 'durability'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...training(ctx).queueStatus() }; },
    format: (data) => `kolejka: ${data.counts.queued} oczekuje, ${data.counts.running} działa, ${data.counts.failed} błędów`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'training.enqueue',
    title: 'Queue a training job',
    description: 'Queues a real training job with priority, deadline, retries and cancellation support.',
    category: 'learning',
    permission: 'write',
    tags: ['queue', 'training'],
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lora', 'qlora', 'distill', 'preference', 'gpt', 'hpo', 'synthetic'] },
        payload: { type: 'object' },
        priority: { type: 'integer', minimum: 1, maximum: 9, default: 5 },
        deadlineMs: { type: 'integer', minimum: 100, maximum: 3600000 },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    async run(args, ctx) { return { ok: true, ...training(ctx).enqueue(args.kind, args.payload || {}, { priority: args.priority, deadlineMs: args.deadlineMs || null }) }; },
    format: (data) => (data.ok ? `zadanie ${data.id}` : data.code),
  },
  {
    name: 'training.cancel',
    title: 'Cancel a training job',
    description: 'Cancels a queued or running job through its AbortSignal.',
    category: 'learning',
    permission: 'write',
    tags: ['queue', 'cancel'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
    async run(args, ctx) { return training(ctx).cancel(args.id); },
    format: (data) => (data.ok ? `anulowano ${data.id}` : data.code),
  },
];
