'use strict';

/**
 * Tools about the assistant itself: model status, benchmarks, agent roster,
 * the tool catalogue, mode switching and STOP.
 *
 * These are what make the Diagnostics tab and `sentinel doctor` tell the truth
 * about the machine instead of guessing.
 */

const { truncate } = require('./helpers');

module.exports = [
  {
    name: 'ai.status',
    title: 'AI engine status',
    description: 'Providers, models, whether they are reachable, current mode, limits and counters.',
    category: 'ai',
    permission: 'read',
    tags: ['ai', 'models', 'status', 'ollama'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20000,
    async run(args, ctx) {
      if (!ctx.llm) return { available: false, note: 'the AI client is not running' };
      const status = await ctx.llm.status();
      return {
        ...status,
        brain: ctx.brain ? ctx.brain.status().counters : null,
        tools: ctx.registry ? ctx.registry.stats().tools : null,
        agents: ctx.agents ? ctx.agents.stats().agents : null,
      };
    },
    format(data) {
      if (!data.providers) return 'AI client is not running';
      const providers = Object.entries(data.providers)
        .map(([name, entry]) => `${name}: ${entry.ok ? 'up' : `down (${entry.error || 'no answer'})`}${entry.models && entry.models.length ? ` [${entry.models.slice(0, 4).map((model) => model.id).join(', ')}]` : ''}`)
        .join('\n');
      return `mode ${data.mode}, ${data.anyProviderUp ? 'at least one provider up' : 'no provider reachable'}\n${providers}`;
    },
  },
  {
    name: 'ai.models',
    title: 'Installed models',
    description: 'Models available locally, with size and family, per provider.',
    category: 'ai',
    permission: 'read',
    tags: ['models', 'ollama'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20000,
    async run(args, ctx) {
      if (!ctx.llm) throw Object.assign(new Error('the AI client is not running'), { code: 'AI_DISABLED' });
      const status = await ctx.llm.status();
      const models = [];
      for (const [provider, entry] of Object.entries(status.providers || {})) {
        for (const model of entry.models || []) {
          models.push({ provider, id: model.id, sizeGB: model.size ? Number((model.size / 1024 ** 3).toFixed(1)) : null, family: model.details ? model.details.family : null });
        }
      }
      return { models, configured: status.models, anyProviderUp: status.anyProviderUp };
    },
    format: (data) =>
      data.models.map((model) => `${model.id} (${model.provider}${model.sizeGB ? `, ${model.sizeGB} GB` : ''})`).join('\n') ||
      'no local models found — run `ollama pull qwen3.5:9b`',
  },
  {
    name: 'ai.benchmark',
    title: 'Benchmark a model',
    description: 'Measures time to first token and tokens/second with a short prompt.',
    category: 'ai',
    permission: 'read',
    tags: ['benchmark', 'performance', 'tokens'],
    parameters: {
      type: 'object',
      properties: { modelClass: { type: 'string', enum: ['fast', 'balanced', 'deep', 'code'], default: 'balanced' } },
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.llm) throw Object.assign(new Error('the AI client is not running'), { code: 'AI_DISABLED' });
      return ctx.llm.benchmark({ modelClass: args.modelClass });
    },
    format: (data) => `${data.model}: first token ${data.firstTokenMs ?? '?'} ms, ${data.tokensPerSecond ?? '?'} tok/s over ${data.totalMs} ms`,
  },
  {
    name: 'ai.agents',
    title: 'Agent roster',
    description: 'The specialists, what each does, which tools it may use and its model class.',
    category: 'ai',
    permission: 'read',
    tags: ['agents'],
    parameters: {
      type: 'object',
      properties: { role: { type: 'string', enum: ['llm', 'tool', 'orchestrator'] } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.agents) return { agents: [], note: 'the agent registry is not loaded' };
      const agents = ctx.agents.list().filter((agent) => (args.role ? agent.role === args.role : true));
      return { count: agents.length, agents };
    },
  },
  {
    name: 'ai.tools',
    title: 'Tool catalogue',
    description: 'Every registered tool by category, with permissions and parameters.',
    category: 'ai',
    permission: 'read',
    tags: ['tools', 'catalogue'],
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', maxLength: 40 },
        search: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.registry) return { tools: [] };
      let tools = ctx.registry.list({ category: args.category || null });
      if (args.search) {
        const needle = args.search.toLowerCase();
        tools = tools.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(needle));
      }
      return { count: tools.length, categories: ctx.registry.categories(), tools };
    },
  },
  {
    name: 'ai.mode',
    title: 'Reasoning mode',
    description: 'Read or switch between fast, balanced and deep reasoning.',
    category: 'ai',
    permission: 'write',
    tags: ['mode', 'settings'],
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'balanced', 'deep'] } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.mode) return { mode: ctx.config.get('ai.mode') || 'balanced', options: ['fast', 'balanced', 'deep'] };
      ctx.config.set('ai.mode', args.mode);
      return { mode: args.mode, note: args.mode === 'deep' ? 'more iterations and verification, slower' : args.mode === 'fast' ? 'single pass, fastest' : 'default' };
    },
  },
  {
    name: 'ai.cancel',
    title: 'STOP',
    description: 'Cancel running model calls. Without an id it stops everything — the real STOP button.',
    category: 'ai',
    permission: 'read',
    tags: ['stop', 'cancel'],
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', maxLength: 80 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (args.runId && ctx.brain) {
        const ok = ctx.brain.cancel(args.runId);
        return { stopped: ok ? 1 : 0, runId: args.runId };
      }
      const count = ctx.brain ? ctx.brain.cancelAll() : ctx.llm ? ctx.llm.cancelAll() : 0;
      return { stopped: count, scope: 'all' };
    },
  },
  {
    name: 'ai.brain',
    title: 'Brain state',
    description: 'Cognitive counters, learned strategies, last run and active runs.',
    category: 'ai',
    permission: 'read',
    tags: ['brain', 'diagnostics'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return ctx.brain ? ctx.brain.status() : { available: false };
    },
  },
  {
    name: 'ai.ask',
    title: 'Ask the model directly',
    description: 'One short model call without agents or tools — for summarising or rewording text you already have.',
    category: 'ai',
    permission: 'read',
    tags: ['llm', 'generate'],
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000 },
        system: { type: 'string', maxLength: 2000 },
        maxTokens: { type: 'integer', default: 300, minimum: 32, maximum: 2000 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.llm) throw Object.assign(new Error('the AI client is not running'), { code: 'AI_DISABLED' });
      const result = await ctx.llm.chat({
        messages: [{ role: 'system', content: args.system || 'Be concise. Answer in the language of the prompt.' }, { role: 'user', content: args.prompt }],
        modelClass: 'fast',
        maxTokens: args.maxTokens,
        signal: ctx.signal,
      });
      return { text: truncate(result.text, 8000), model: result.model, provider: result.provider, usage: result.usage };
    },
    format: (data) => data.text,
  },
];
