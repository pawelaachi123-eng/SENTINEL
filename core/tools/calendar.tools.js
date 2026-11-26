'use strict';

/** Calendar tools. They read and write the local calendar; nothing is sent anywhere. */

function calendar(ctx) {
  if (!ctx.calendar) throw Object.assign(new Error('calendar is not available'), { code: 'NO_CALENDAR' });
  return ctx.calendar;
}

module.exports = [
  {
    name: 'calendar.status',
    title: 'Calendar status',
    description: 'Event count, sources and the number of events in the next 24 hours. Reads only local state.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'assistant', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return calendar(ctx).status(); },
    format: (data) => `${data.events} wydarzeń, ${data.upcoming24h} w ciągu 24 h`,
  },
  {
    name: 'calendar.upcoming',
    title: 'Upcoming calendar events',
    description: 'Expanded occurrences between two epoch times (default: now to seven days). Recurrence is labelled, not guessed.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'assistant', 'schedule'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'number' },
        to: { type: 'number' },
        days: { type: 'number', minimum: 0.01, maximum: 366 },
        limit: { type: 'number', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const store = calendar(ctx);
      const base = Number.isFinite(Number(args.from)) ? Number(args.from) : store.now();
      const to = Number.isFinite(Number(args.to)) ? Number(args.to) : base + Math.max(0.01, Number(args.days) || 7) * 86400000;
      const events = store.upcoming({ from: base, to, limit: args.limit || 50 });
      return { ok: true, from: base, to, count: events.length, events };
    },
    format: (data) => `${data.count} wydarzeń`,
  },
  {
    name: 'calendar.add',
    title: 'Add a calendar event',
    description: 'Adds a local event with a summary and start. Optional duration, description and a supported RRULE. It does not invite anyone.',
    category: 'productivity', permission: 'write', tags: ['calendar', 'assistant', 'reminder'],
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 500 },
        start: { type: ['string', 'number'] },
        durationMinutes: { type: 'number', minimum: 0, maximum: 525600 },
        description: { type: 'string', maxLength: 4000 },
        rrule: { type: 'string', maxLength: 500 },
      },
      required: ['summary', 'start'], additionalProperties: false,
    },
    async run(args, ctx) {
      return calendar(ctx).add({
        summary: args.summary,
        start: args.start,
        durationMs: Math.max(0, Number(args.durationMinutes) || 0) * 60000,
        description: args.description,
        rrule: args.rrule,
      }, { source: 'tool' });
    },
    format: (data) => (data.ok ? `dodano ${data.event.summary}` : data.code),
  },
  {
    name: 'calendar.import_ics',
    title: 'Import an ICS calendar',
    description: 'Imports RFC 5545 VEVENTs from supplied text. Reports malformed events instead of dropping them silently; UID matches update the existing event.',
    category: 'productivity', permission: 'write', tags: ['calendar', 'import', 'ics'],
    parameters: { type: 'object', properties: { ics: { type: 'string', minLength: 1, maxLength: 2000000 } }, required: ['ics'], additionalProperties: false },
    async run(args, ctx) { return calendar(ctx).importIcs(args.ics); },
    format: (data) => `${data.imported || 0} nowych, ${data.updated || 0} zaktualizowanych`,
  },
  {
    name: 'calendar.export_ics',
    title: 'Export a calendar range',
    description: 'Exports local events in a range as RFC 5545 text. Recurring occurrences get deterministic UIDs; unresolved time zones are not invented.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'export', 'ics'],
    parameters: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' }, days: { type: 'number', minimum: 0.01, maximum: 366 } }, additionalProperties: false },
    async run(args, ctx) {
      const store = calendar(ctx);
      const from = Number.isFinite(Number(args.from)) ? Number(args.from) : store.now();
      const to = Number.isFinite(Number(args.to)) ? Number(args.to) : from + Math.max(0.01, Number(args.days) || 30) * 86400000;
      return { ok: true, from, to, ics: store.exportIcs({ from, to }) };
    },
    format: (data) => `${data.ics.length} znaków ICS`,
  },
];
