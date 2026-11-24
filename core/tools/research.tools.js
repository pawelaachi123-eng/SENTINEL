'use strict';

/** Persistent research tools. Sources are untrusted data, never instructions. */

function service(ctx) {
  if (!ctx.research) throw Object.assign(new Error('the research service is not available'), { code: 'NO_RESEARCH' });
  return ctx.research;
}

module.exports = [
  {
    name: 'research.start',
    title: 'Start a research session',
    description: 'Creates a durable question with a plan and decomposed sub-questions. Online mode requires an explicit approval; the default uses local sources only.',
    category: 'knowledge',
    permission: 'write',
    tags: ['research', 'plan', 'sources', 'offline'],
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 5, maxLength: 600 },
        online: { type: 'boolean' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const approvedBy = args.online && ctx.approval ? ctx.approval.by || `approval:${ctx.approval.id}` : null;
      return service(ctx).start({ question: args.question, online: Boolean(args.online), approvedBy });
    },
    format: (data) => (data.ok ? `sesja ${data.session.id}: ${data.session.subquestions.length} podpytań` : `odmowa: ${data.code}`),
  },
  {
    name: 'research.add_source',
    title: 'Add a source to a research session',
    description: 'Adds inline text or a UTF-8 file inside the workspace, records its SHA-256 fingerprint, rejects duplicates and marks every source as untrusted. Detects numeric contradictions between sources.',
    category: 'knowledge',
    permission: 'write',
    tags: ['research', 'source', 'citation', 'fingerprint'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', maxLength: 200 },
        text: { type: 'string', maxLength: 200000 },
        file: { type: 'string', maxLength: 1000 },
        url: { type: 'string', maxLength: 2000 },
        reliability: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return service(ctx).addSource(args.id, { title: args.title || null, text: args.text || null, file: args.file || null, url: args.url || null, reliability: args.reliability || 'unknown' });
    },
    format: (data) => (data.ok ? `${data.duplicate ? 'duplikat' : 'dodano'} ${data.source.title}, ${data.source.lines} linii` : `odmowa: ${data.code}`),
  },
  {
    name: 'research.evidence',
    title: 'Retrieve cited evidence from a session',
    description: 'Returns the highest-overlap lines from the session sources, each with source id, real line number and trust label. No generated summary is inserted.',
    category: 'knowledge',
    permission: 'read',
    tags: ['research', 'evidence', 'citation', 'retrieval'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        query: { type: 'string', maxLength: 600 },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return service(ctx).evidence(args.id, { query: args.query || null, limit: args.limit || 20 });
    },
    format: (data) => (data.ok ? `${data.evidence.length} cytatów z ${data.sources} źródeł` : `brak: ${data.code}`),
  },
  {
    name: 'research.report',
    title: 'Synthesize a citation-bound research report',
    description: 'Builds a markdown report with plan, sub-questions, quotes and line citations, unresolved numeric conflicts and declared gaps. It refuses with NO_SOURCES rather than inventing findings and never asserts a conclusion without evidence.',
    category: 'knowledge',
    permission: 'write',
    tags: ['research', 'report', 'citations', 'conflicts'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return service(ctx).synthesize(args.id, { approvedBy: ctx.sessionId || null });
    },
    format: (data) => (data.ok ? `raport: ${data.structured.evidence.length} cytatów, ${data.structured.conflicts.length} sprzeczności` : `odmowa: ${data.code}`),
  },
  {
    name: 'research.list',
    title: 'List research sessions',
    description: 'Lists sessions with status, source and evidence counts, conflict counts and whether a report exists. The status object states that online research is opt-in and was not exercised.',
    category: 'knowledge',
    permission: 'read',
    tags: ['research', 'sessions', 'status'],
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { ok: true, sessions: service(ctx).list({ limit: args.limit || 50 }), status: service(ctx).status() };
    },
    format: (data) => `${data.sessions.length} sesji badawczych`,
  },
];
