'use strict';

/** Daily briefing and opt-in proactive rules. Both return real state only. */

function briefing(ctx) {
  if (!ctx.briefing) throw Object.assign(new Error('daily briefing is not available'), { code: 'NO_BRIEFING' });
  return ctx.briefing;
}

function proactive(ctx) {
  if (!ctx.proactive) throw Object.assign(new Error('proactive engine is not available'), { code: 'NO_PROACTIVE' });
  return ctx.proactive;
}

module.exports = [
  {
    name: 'assistant.briefing',
    title: 'Daily briefing',
    description: 'Composes due reminders, active tasks, goals, contradictions and pending approvals into a cited list. Deterministic, no model, no invented dates.',
    category: 'productivity', permission: 'read', tags: ['assistant', 'briefing', 'reminders', 'planning'],
    parameters: { type: 'object', properties: { horizonHours: { type: 'number', minimum: 1, maximum: 720 }, limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...briefing(ctx).generate(args) }; },
    format: (data) => (data.counts ? `${data.items.length} pozycji (${data.counts.overdue} po terminie)` : 'brak danych'),
  },
  {
    name: 'proactive.status',
    title: 'Proactive rules status',
    description: 'Rules, quiet hours, rate limits, delivery configuration and delivered-today count. No covert monitoring.',
    category: 'communication', permission: 'read', tags: ['proactive', 'notifications', 'rules'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...proactive(ctx).status() }; },
    format: (data) => `${data.counts.rules} reguł, dostarczono ${data.counts.deliveredToday}`,
  },
  {
    name: 'proactive.add_rule',
    title: 'Add a proactive rule',
    description: 'Adds an opt-in typed rule for caller-supplied events, with cooldown, quiet hours and channel limits. It cannot monitor microphones, cameras or conversations.',
    category: 'communication', permission: 'write', tags: ['proactive', 'rules', 'notifications'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        event: { type: 'string', minLength: 1, maxLength: 100 },
        conditions: { type: 'array', maxItems: 10, items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'gte', 'lte', 'contains', 'exists'] }, value: {} }, required: ['field', 'op'], additionalProperties: false } },
        priority: { type: 'number', minimum: 0, maximum: 1 },
        cooldownMs: { type: 'number', minimum: 0, maximum: 604800000 },
        channels: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['desktop', 'sms', 'email', 'call'] } },
      },
      required: ['name', 'event'], additionalProperties: false,
    },
    async run(args, ctx) { return proactive(ctx).addRule(args); },
    format: (data) => (data.ok ? `reguła ${data.rule.id}` : data.code),
  },
  {
    name: 'proactive.evaluate',
    title: 'Evaluate a supplied event',
    description: 'Evaluates caller-supplied event data against enabled rules and returns matches plus explicit suppressions (quiet hours, cooldown, rate limit). Without a configured channel it reports NOT_CONFIGURED rather than claiming delivery.',
    category: 'communication', permission: 'read', tags: ['proactive', 'events', 'notifications'],
    parameters: { type: 'object', properties: { event: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, data: { type: 'object' } }, required: ['type'], additionalProperties: true } }, required: ['event'], additionalProperties: false },
    async run(args, ctx) { return proactive(ctx).evaluate(args.event); },
    format: (data) => `${data.candidates || 0} kandydatów, ${data.delivered || 0} dostarczonych`,
  },
];
