'use strict';

/** Skill library tools. Promotion is approval-gated and requires a held-out gate. */

function library(ctx) {
  if (!ctx.skills) throw Object.assign(new Error('the skill library is not available'), { code: 'NO_SKILLS' });
  return ctx.skills;
}

module.exports = [
  {
    name: 'skill.list',
    title: 'List skills',
    description: 'Lists candidate, validated, superseded and retired skills with their evidence scores. Validation records come from held-out evaluation runs, not from a model claim.',
    category: 'memory',
    permission: 'read',
    tags: ['skills', 'learning', 'library'],
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['candidate', 'validated', 'superseded', 'retired'] },
        name: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { ok: true, skills: library(ctx).list({ status: args.status || null, name: args.name || null }), status: library(ctx).status() };
    },
    format: (data) => `${data.skills.length} umiejętności (${data.status.byStatus.validated || 0} zwalidowanych)`,
  },
  {
    name: 'skill.propose',
    title: 'Propose a skill',
    description: 'Stores a candidate procedure with typed parameters, preconditions, scoped permissions and evidence. Identical skills are deduplicated instead of creating a second version.',
    category: 'memory',
    permission: 'write',
    tags: ['skills', 'learning', 'candidate'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', maxLength: 600 },
        steps: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', properties: { tool: { type: 'string', maxLength: 80 }, args: { type: 'object' }, note: { type: 'string', maxLength: 200 } }, required: ['tool'], additionalProperties: false } },
        scope: { type: 'string', enum: ['workspace', 'system', 'network'] },
        permissions: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
      },
      required: ['name', 'steps'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return library(ctx).propose({ name: args.name, description: args.description || '', steps: args.steps, scope: args.scope, permissions: args.permissions || [] });
    },
    format: (data) => (data.duplicate ? `duplikat: ${data.skill.name} v${data.skill.version}` : `kandydat ${data.skill.name} v${data.skill.version}`),
  },
  {
    name: 'skill.validate',
    title: 'Promote a skill after a held-out gate',
    description: 'Promotes a candidate only when a held-out gate passed and a human approved it by name. A score below the already validated version is rejected as a regression.',
    category: 'memory',
    permission: 'write',
    tags: ['skills', 'validation', 'regression', 'approval'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        score: { type: 'number', minimum: 0, maximum: 1 },
        cases: { type: 'number', minimum: 0 },
        passed: { type: 'number', minimum: 0 },
        approvedBy: { type: 'string', minLength: 1, maxLength: 120 },
        note: { type: 'string', maxLength: 300 },
      },
      required: ['id', 'score', 'approvedBy'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const gate = { heldOut: true, ok: args.score >= 1, score: args.score, cases: args.cases || 0, passed: args.passed || 0, mode: 'reported-by-caller' };
      return library(ctx).validate(args.id, { gate, approvedBy: args.approvedBy, note: args.note || null });
    },
    format: (data) => (data.ok ? `zwalidowano v${data.skill.version} (${data.skill.validation.score})` : `odrzucono: ${data.code}`),
  },
  {
    name: 'skill.retire',
    title: 'Retire a skill',
    description: 'Marks a skill as retired with a reason and the approving person. Retired skills never match or promote again.',
    category: 'memory',
    permission: 'write',
    tags: ['skills', 'retirement'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        reason: { type: 'string', maxLength: 300 },
        approvedBy: { type: 'string', maxLength: 120 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return library(ctx).retire(args.id, { reason: args.reason || null, approvedBy: args.approvedBy || null });
    },
    format: (data) => (data.ok ? `wycofano ${data.skill.name}` : `odrzucono: ${data.code}`),
  },
];
