'use strict';

/** Runtime profile tools. All three are real: they change the resident model budget. */

function manager(ctx) {
  if (!ctx.runtime) throw Object.assign(new Error('the runtime manager is not available'), { code: 'NO_RUNTIME' });
  return ctx.runtime;
}

module.exports = [
  {
    name: 'runtime.status',
    title: 'Model runtime status',
    description: 'Detected CPU/GPU/RAM, active profile, estimated model footprint, real resident models from the provider and switch history. Estimates are labelled as estimates.',
    category: 'system',
    permission: 'read',
    tags: ['runtime', 'models', 'hardware', 'vram'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return manager(ctx).status();
    },
    format: (data) => `${data.profile}: ${data.feasibility.model}${data.feasibility.estimate ? ` (~${data.feasibility.estimate.totalGb} GB, szacunek)` : ''}, VRAM ${data.hardware.gpu ? `${data.hardware.gpu.vramGb} GB` : 'nie wykryto'}, w pamięci ${data.resident.models.length} modeli`,
  },
  {
    name: 'runtime.set_profile',
    title: 'Switch the runtime profile',
    description: 'Switch between idle, balanced, deep and gaming. Deep is refused when the estimated model footprint does not fit detected VRAM. Gaming unloads every resident model.',
    category: 'system',
    permission: 'write',
    tags: ['runtime', 'profile', 'gaming'],
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', enum: ['idle', 'balanced', 'deep', 'gaming'] },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['profile'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return manager(ctx).apply(args.profile, { reason: args.reason || 'requested by a tool' });
    },
    format: (data) => (data.ok ? `profil ${data.profile}${data.unloaded && data.unloaded.length ? `, wyładowano ${data.unloaded.filter((entry) => entry.ok).length} modeli` : ''}` : `odmowa: ${data.message}`),
  },
  {
    name: 'runtime.free',
    title: 'Unload model from VRAM',
    description: 'Unload one model (or every resident model) from memory using the provider keep-alive control. Reports the provider response instead of assuming success.',
    category: 'system',
    permission: 'write',
    tags: ['runtime', 'models', 'vram', 'unload'],
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', maxLength: 100 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const runtime = manager(ctx);
      const resident = await runtime.resident();
      if (!resident.supported && args.model === undefined) return { ok: false, code: 'PROVIDER_UNSUPPORTED', message: resident.reason || 'cannot list resident models' };
      const targets = args.model ? [args.model] : resident.models.map((model) => model.name);
      const results = [];
      for (const model of targets) {
        // eslint-disable-next-line no-await-in-loop
        results.push({ model, ...(await runtime.unload(model)) });
      }
      return { ok: results.length > 0 && results.every((entry) => entry.ok), results };
    },
    format: (data) => (data.results || []).map((entry) => `${entry.model}: ${entry.ok ? 'wyładowany' : entry.message}`).join('\n') || data.message || data.code || 'brak modeli do wyładowania',
  },
];
