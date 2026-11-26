'use strict';

/**
 * Staged-patch tools.
 *
 * These are the coding workflow steps the assistant is allowed to take on its
 * own: propose a change, verify it in isolation, show the diff. Writing the file
 * needs `patch.apply`, which is a `write` permission and therefore goes through
 * the normal approval gate — a model cannot approve itself.
 */

const { truncate } = require('./helpers');

function requirePatches(ctx) {
  if (!ctx.patches) throw Object.assign(new Error('the patch manager is not available'), { code: 'NO_PATCHES' });
  return ctx.patches;
}

module.exports = [
  {
    name: 'patch.propose',
    title: 'Stage a code change',
    description: 'Stage a complete replacement for one file without writing it. Returns the diff, added/removed lines and a patch id for patch.verify / patch.apply.',
    category: 'code',
    permission: 'write',
    tags: ['code', 'patch', 'staged', 'safe'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file to change' },
        text: { type: 'string', description: 'the complete new content of the file', maxLength: 2000000 },
        reason: { type: 'string', description: 'why this change is proposed', maxLength: 2000 },
        verify: { type: 'string', enum: ['syntax', 'test', 'none'], default: 'syntax' },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args, ctx) {
      const patches = requirePatches(ctx);
      const session = patches.create({ file: args.path, newText: args.text, description: args.reason || null, verify: args.verify || 'syntax', requestedBy: ctx.source || 'assistant' });
      const diff = patches.diff(session.id);
      return {
        id: session.id,
        file: session.file,
        added: session.added,
        removed: session.removed,
        existed: session.existed,
        verifier: session.verifier,
        diff: truncate(diff, 12000),
        next: 'call patch.verify, then patch.apply (which needs approval)',
      };
    },
    format: (data) => `${data.id} · ${data.file} (+${data.added} −${data.removed})\n${data.diff}`,
  },
  {
    name: 'patch.verify',
    title: 'Verify a staged patch',
    description: 'Run the whitelisted verifier against the staged file in an isolated workspace. Nothing outside that workspace changes.',
    category: 'code',
    permission: 'read',
    tags: ['code', 'patch', 'test', 'verify'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = requirePatches(ctx).verify(args.id);
      return result;
    },
    format: (data) => (data.ok ? (data.skipped ? `verification skipped: ${data.reason}` : `verification passed in ${data.ms} ms (${data.command})`) : `verification failed: ${truncate(data.output || data.message || '', 1200)}`),
  },
  {
    name: 'patch.diff',
    title: 'Show a staged diff',
    description: 'The unified diff of a staged patch, exactly as it would be written.',
    category: 'code',
    permission: 'read',
    tags: ['code', 'patch', 'diff'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { id: args.id, diff: truncate(requirePatches(ctx).diff(args.id), 16000) };
    },
    format: (data) => data.diff,
  },
  {
    name: 'patch.apply',
    title: 'Apply a verified patch',
    description: 'Write a verified staged patch to its file, keeping a timestamped backup. Requires your approval; refuses unverified patches.',
    category: 'code',
    permission: 'write',
    tags: ['code', 'patch', 'apply', 'approval'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 3 },
        confirm: { type: 'boolean', description: 'ignored — consent is the approval, not a model-supplied flag' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const patches = requirePatches(ctx);
      // ctx.approvalId is set by the registry only when a real approval was
      // consumed for this exact tool and these exact arguments.
      const result = patches.apply(args.id, { approved: Boolean(ctx.approvalId), approvedBy: ctx.approvalId ? 'user' : null });
      const confirm = patches.confirm(args.id);
      return { ...result, confirmed: confirm.ok };
    },
    format: (data) => `applied ${data.id} to ${data.file}${data.backup ? ` (backup: ${data.backup})` : ''}${data.confirmed ? ', verified on disk' : ', WARNING: content on disk differs'}`,
  },
  {
    name: 'patch.discard',
    title: 'Discard a staged patch',
    description: 'Delete a staged patch without touching the target file.',
    category: 'code',
    permission: 'write',
    tags: ['code', 'patch', 'discard'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return requirePatches(ctx).discard(args.id);
    },
    format: (data) => `discarded ${data.id}`,
  },
  {
    name: 'patch.list',
    title: 'Staged patches',
    description: 'Every staged patch with its verification state.',
    category: 'code',
    permission: 'read',
    tags: ['code', 'patch', 'list'],
    parameters: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false },
    async run(args, ctx) {
      const patches = requirePatches(ctx);
      return { sessions: patches.list({ status: args.status || null }), stats: patches.stats() };
    },
    format: (data) => (data.sessions.length ? data.sessions.map((session) => `${session.id} ${session.status.padEnd(9)} ${session.relative} (+${session.added} −${session.removed})`).join('\n') : 'no staged patches'),
  },
];
