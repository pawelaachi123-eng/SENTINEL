'use strict';

/** Organisation structure tools. Read-only: delegation is a plan, not an action. */

function org(ctx) {
  if (!ctx.org) throw Object.assign(new Error('the organisation is not available'), { code: 'NO_ORG' });
  return ctx.org;
}

module.exports = [
  {
    name: 'org.status',
    title: 'Organisation chart',
    description: 'Tiers (executive, lead, specialist, worker), real agent counts, domain leads and the delegation depth limit. Derived from the actual roster — no duplicate personas.',
    category: 'system',
    permission: 'read',
    tags: ['org', 'agents', 'structure'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return org(ctx).chart();
    },
    format: (data) => `${data.total} agentów: ${Object.entries(data.counts).map(([tier, count]) => `${tier} ${count}`).join(', ')}, ${Object.keys(data.domains).length} domen`,
  },
  {
    name: 'org.plan',
    title: 'Preview a delegation',
    description: 'For a capability, show which existing agent would lead and which workers would support it, with the depth check. Preview only: it does not execute work or change permissions.',
    category: 'system',
    permission: 'read',
    tags: ['org', 'delegation', 'agents'],
    parameters: {
      type: 'object',
      properties: {
        capability: { type: 'string', minLength: 2, maxLength: 60 },
        workers: { type: 'number', minimum: 0, maximum: 4, default: 2 },
      },
      required: ['capability'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return org(ctx).planDelegation({ capability: args.capability, workers: args.workers });
    },
    format: (data) => (data.ok ? `${data.lead} + ${data.workers.map((worker) => worker.name).join(', ') || 'bez wsparcia'} (głębokość ${data.depth})` : `brak: ${data.message}`),
  },
];
