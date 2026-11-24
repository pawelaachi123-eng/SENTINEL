'use strict';

/**
 * Bounded reasoning tools.
 *
 * Diagnose refuses to invent: it only builds hypotheses from signals that were
 * actually measured (passed in or collected from system.status/runtime.status)
 * and only reports a conclusion when a tool measurement supported one.
 */

function reasoner(ctx) {
  if (!ctx.reasoning) throw Object.assign(new Error('the reasoning service is not available'), { code: 'NO_REASONER' });
  return ctx.reasoning;
}

function signalsFrom(snapshot, volumes, runtime) {
  const signals = [];
  if (snapshot && snapshot.ok !== false) {
    const cpu = Number(snapshot.cpuPercent);
    if (Number.isFinite(cpu)) signals.push({ name: 'cpu.usage', value: cpu, source: 'system.snapshot' });
    const usedPercent = Number(snapshot.memory && snapshot.memory.percent);
    if (Number.isFinite(usedPercent)) signals.push({ name: 'memory.availableRatio', value: 1 - usedPercent / 100, source: 'system.snapshot' });
  }
  if (volumes && Array.isArray(volumes.volumes) && volumes.volumes.length) {
    const worst = Math.max(...volumes.volumes.map((volume) => Number(volume.percentUsed) || 0));
    signals.push({ name: 'disk.freeRatio', value: 1 - worst / 100, source: 'disk.volumes' });
  }
  if (runtime && runtime.counts && Number(runtime.counts.total) === 0) signals.push({ name: 'llm.reachable', value: false, source: 'runtime.status' });
  return signals;
}

module.exports = [
  {
    name: 'reason.diagnose',
    title: 'Evidence-bound diagnosis',
    description: 'Builds hypotheses only from measured signals, tests each with a real tool, and returns a conclusion only when a measurement supported one. Untested hypotheses are listed with the measurement still needed.',
    category: 'system',
    permission: 'read',
    tags: ['reasoning', 'diagnosis', 'evidence', 'hypothesis'],
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: 400 },
        signals: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 60 },
              value: { type: ['number', 'boolean', 'string'] },
              source: { type: 'string', maxLength: 80 },
            },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const snapshot = await ctx.registry.execute('system.snapshot', {}, { source: 'reason.diagnose' });
      const volumes = await ctx.registry.execute('disk.volumes', {}, { source: 'reason.diagnose' });
      const runtime = ctx.runtime ? ctx.runtime.status() : null;
      const signals = (args.signals && args.signals.length ? args.signals : signalsFrom(snapshot, volumes, runtime));
      const result = await reasoner(ctx).evaluate({ question: args.question || '', signals });
      return { ok: true, ...result, signalsUsed: signals.map((signal) => signal.name), measuredAt: new Date().toISOString() };
    },
    format: (data) => (data.conclusion ? `${data.conclusion} (pewność ${data.confidence})` : `brak potwierdzonej hipotezy; potrzeba: ${data.need.join(', ') || 'więcej pomiarów'}`),
  },
  {
    name: 'reason.contradictions',
    title: 'Keep contradictory facts',
    description: 'Groups facts by key and returns conflicts with both values and their sources. It never overwrites the older value: resolution is left to the user.',
    category: 'system',
    permission: 'read',
    tags: ['reasoning', 'contradiction', 'memory', 'provenance'],
    parameters: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', maxLength: 120 },
              value: { type: ['string', 'number', 'boolean'] },
              source: { type: 'string', maxLength: 120 },
              trusted: { type: 'boolean' },
            },
            required: ['key', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['facts'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = reasoner(ctx).contradictions(args.facts);
      return { ok: true, ...result };
    },
    format: (data) => (data.conflicted ? `${data.conflicted} sprzeczności zachowanych` : `${data.checked} faktów bez sprzeczności`),
  },
];
