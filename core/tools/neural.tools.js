'use strict';

/**
 * Neural runtime tools.
 *
 * `models.discover` reads provider metadata; it returns what the provider
 * reported and labels inferred fields. `models.route` explains its choice and
 * refuses with NO_CAPABLE_MODEL instead of pretending a model can see images
 * or produce embeddings when none advertises that capability.
 */

function neural(ctx) {
  if (!ctx.neural) throw Object.assign(new Error('the neural runtime is not available'), { code: 'NO_NEURAL' });
  return ctx.neural;
}

module.exports = [
  {
    name: 'models.discover',
    title: 'Discover installed models',
    description: 'Queries every enabled provider (Ollama /api/tags + /api/show, LM Studio/llama.cpp/OpenAI-compatible /v1/models) and reports architecture, parameter size, quantisation, context length, layer/head counts, size and capabilities exactly as reported. Missing fields stay null; name-based guesses are marked inferred. External providers are skipped unless the user enabled them.',
    category: 'ai',
    permission: 'read',
    tags: ['models', 'discovery', 'ollama', 'capabilities', 'metadata'],
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'ignore the metadata cache' },
        provider: { type: 'string', enum: ['ollama', 'lmstudio', 'llamacpp', 'external'] },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await neural(ctx).discover({ force: Boolean(args.refresh), provider: args.provider || null });
      return { ok: true, ...result };
    },
    format: (data) => `${data.found} modeli${data.errors && data.errors.length ? `, ${data.errors.length} dostawców nie odpowiada` : ''}`,
  },
  {
    name: 'models.capabilities',
    title: 'Model capability report',
    description: 'Lists known models with their advertised capabilities, context length and quantisation, and states clearly which metadata is inferred rather than reported.',
    category: 'ai',
    permission: 'read',
    tags: ['models', 'capabilities', 'context', 'quantization'],
    parameters: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: ['completion', 'tools', 'thinking', 'vision', 'embedding', 'rerank'] },
        provider: { type: 'string', maxLength: 40 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const service = neural(ctx);
      const models = service.list({ capability: args.capability || null, provider: args.provider || null }).map((model) => service.summarise(model));
      return { ok: true, models, counts: service.status().counts, honest: 'null means the provider did not report the field.' };
    },
    format: (data) => `${data.models.length} modeli; ${data.counts.tools} z narzędziami`,
  },
  {
    name: 'models.route',
    title: 'Choose a model for a task',
    description: 'Routes a task (reasoning, coding, vision, embedding, rerank, classification, tools, thinking) to an installed model that advertises the required capabilities. Returns the reason, alternatives, or NO_CAPABLE_MODEL.',
    category: 'ai',
    permission: 'read',
    tags: ['models', 'routing', 'capabilities'],
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: ['reasoning', 'coding', 'vision', 'embedding', 'rerank', 'classification', 'tools', 'thinking'] },
        needs: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['completion', 'tools', 'thinking', 'vision', 'embedding', 'rerank'] } },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return neural(ctx).route({ task: args.task || 'reasoning', needs: args.needs || [] });
    },
    format: (data) => (data.ok ? `${data.ref}` : `brak modelu: ${data.message}`),
  },
  {
    name: 'models.unload',
    title: 'Unload a model from memory',
    description: 'Sends keep_alive:0 to Ollama so the weights are really released. Reports the provider response; unsupported providers are refused rather than reported as success.',
    category: 'ai',
    permission: 'write',
    tags: ['models', 'vram', 'unload', 'memory'],
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['model'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return neural(ctx).unload(args.model);
    },
    format: (data) => (data.ok ? `wyładowano ${data.model}` : `odmowa: ${data.message}`),
  },
];
