'use strict';

/**
 * Communication tools. Reading status is harmless. Starting a call or SMS is
 * `system` (approval required) and additionally needs a consent token that the
 * model cannot mint. Granting consent is deliberately not a tool.
 */

function manager(ctx) {
  if (!ctx.communication) throw Object.assign(new Error('communications are not available'), { code: 'NO_COMMUNICATION' });
  return ctx.communication;
}

module.exports = [
  {
    name: 'communication.status',
    title: 'Communication status',
    description: 'Configured provider, whether calls are live or mocked, daily limits, estimated cost, pending consents and delivery counts. It never claims a call happened when it did not.',
    category: 'communication', permission: 'read', tags: ['communication', 'calls', 'sms', 'provider'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...manager(ctx).status() }; },
    format: (data) => `${data.provider.name}, live: ${data.liveCalls}, historia: ${data.history}`,
  },
  {
    name: 'communication.history',
    title: 'Communication history',
    description: 'Recent calls and messages with channel, status, attempts, consent approver, cost estimate and simulated flag.',
    category: 'communication', permission: 'read', tags: ['communication', 'history', 'delivery'],
    parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 100 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, history: manager(ctx).history.slice(-(args.limit || 20)).map((entry) => ({ ...entry })) }; },
    format: (data) => `${data.history.length} wpisów`,
  },
  {
    name: 'communication.request_consent',
    title: 'Request consent for a call or SMS',
    description: 'Creates a one-use consent request bound to a channel, E.164 destination and expiry. It does not grant consent; a person must grant it.',
    category: 'communication', permission: 'write', tags: ['communication', 'consent', 'calls'],
    parameters: {
      type: 'object',
      properties: { channel: { type: 'string', enum: ['call', 'sms'] }, destination: { type: 'string', maxLength: 20 }, reason: { type: 'string', maxLength: 500 } },
      required: ['channel', 'destination'], additionalProperties: false,
    },
    async run(args, ctx) { return manager(ctx).requestConsent(args); },
    format: (data) => (data.ok ? `zgoszenie ${data.consent.token} — wymaga zgody człowieka` : data.code),
  },
  {
    name: 'communication.call',
    title: 'Place an authorised call',
    description: 'Places a call only through a configured provider, with a consumed system approval and a separately granted, unused consent token bound to this destination. The assistant identifies itself as AI. Emergency/premium numbers are blocked.',
    category: 'communication', permission: 'system', tags: ['communication', 'call', 'approval', 'consent'],
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', minLength: 8, maxLength: 20 }, message: { type: 'string', minLength: 1, maxLength: 1200 }, language: { type: 'string', enum: ['pl', 'en'] }, consentToken: { type: 'string', minLength: 10 } },
      required: ['to', 'message', 'consentToken'], additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.approval) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'a call needs a consumed system approval' };
      return manager(ctx).call(args);
    },
    format: (data) => (data.ok ? `${data.communication.status}${data.communication.simulated ? ' (symulacja)' : ''}` : data.code),
  },
  {
    name: 'communication.sms',
    title: 'Send an authorised SMS',
    description: 'Sends an SMS only through a configured provider, with a consumed system approval and a separately granted consent token. Development and CI use the mock adapter.',
    category: 'communication', permission: 'system', tags: ['communication', 'sms', 'approval', 'consent'],
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', minLength: 8, maxLength: 20 }, text: { type: 'string', minLength: 1, maxLength: 1600 }, consentToken: { type: 'string', minLength: 10 } },
      required: ['to', 'text', 'consentToken'], additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.approval) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'an SMS needs a consumed system approval' };
      return manager(ctx).sendSms(args);
    },
    format: (data) => (data.ok ? `${data.communication.status}${data.communication.simulated ? ' (symulacja)' : ''}` : data.code),
  },
];
