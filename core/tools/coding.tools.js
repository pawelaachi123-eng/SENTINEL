'use strict';

/**
 * Parser-backed coding-intelligence tools.
 *
 * Reads are safe. A refactor is a proposal until a human approval is bound to
 * the exact patch hash; applying a different set is refused. The engine never
 * changes its own permissions or the tool registry.
 */

function coding(ctx) {
  if (!ctx.codeIndex) throw Object.assign(new Error('the code index is not available'), { code: 'NO_CODE_INDEX' });
  return ctx.codeIndex;
}

function refactor(ctx) {
  if (!ctx.refactorEngine) throw Object.assign(new Error('the refactor engine is not available'), { code: 'NO_REFACTOR' });
  return ctx.refactorEngine;
}

module.exports = [
  {
    name: 'coding.index',
    title: 'Index the code workspace',
    description: 'Parses supported source files into ASTs and reports symbols, languages, parse errors and skipped hostile files.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'ast', 'index'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...coding(ctx).scan(), stats: coding(ctx).stats() }; },
    format: (data) => `${data.files} plików, ${data.stats.uniqueSymbols} symboli, ${data.errors.length} błędów parsowania`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'coding.search',
    title: 'Search symbols',
    description: 'Searches the AST symbol index by name and returns definitions with file and line.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'symbols', 'search'],
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, required: ['query'], additionalProperties: false },
    async run(args, ctx) { return { ok: true, results: coding(ctx).search(args.query, { limit: args.limit }) }; },
    format: (data) => data.results.map((entry) => `${entry.name} (${entry.definitions.length})`).join(', ') || 'brak',
  },
  {
    name: 'coding.references',
    title: 'Find references',
    description: 'Finds identifier and call references from parsed expressions.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'references'],
    parameters: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }, required: ['symbol'], additionalProperties: false },
    async run(args, ctx) { return { ok: true, symbol: args.symbol, references: coding(ctx).references(args.symbol, { limit: args.limit }) }; },
    format: (data) => `${data.references.length} referencji`,
  },
  {
    name: 'coding.impact',
    title: 'Impact analysis',
    description: 'Walks import and reference edges to list files affected by a change.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'impact', 'dependencies'],
    parameters: { type: 'object', properties: { file: { type: 'string' }, symbol: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 6, default: 3 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...coding(ctx).impact({ file: args.file || null, symbol: args.symbol || null, depth: args.depth }) }; },
    format: (data) => `${data.files.length} plików`,
  },
  {
    name: 'coding.callgraph',
    title: 'Call and dependency graph',
    description: 'Returns known calls and the file edges they imply.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'callgraph'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...coding(ctx).callGraph() }; },
    format: (data) => `${data.nodes.length} symboli, ${data.edges.length} krawędzi`,
  },
  {
    name: 'coding.bugs',
    title: 'Static bug localisation',
    description: 'Reports evidence-backed static findings (injection, unsafe calls, secrets, swallowed errors) with severity.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'bugs', 'security'],
    parameters: { type: 'object', properties: { file: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300, default: 100 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, findings: coding(ctx).bugs({ file: args.file || null, limit: args.limit }) }; },
    format: (data) => `${data.findings.length} znalezisk`,
    examples: [{ args: { limit: 5 }, expect: { ok: true } }],
  },
  {
    name: 'coding.test_proposals',
    title: 'Propose tests',
    description: 'Generates deterministic test skeletons from real function names and parameters. They are proposals, not passing tests.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'tests'],
    parameters: { type: 'object', properties: { file: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, proposals: coding(ctx).proposeTests({ file: args.file || null, limit: args.limit }) }; },
    format: (data) => `${data.proposals.length} propozycji`,
  },
  {
    name: 'coding.rename',
    title: 'Propose a multi-file rename',
    description: 'Token-exact rename across parsed files. Returns verified patches and the approval hash; nothing is written.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'refactor', 'rename', 'proposal'],
    parameters: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }, required: ['symbol', 'to'], additionalProperties: false },
    async run(args, ctx) {
      const change = refactor(ctx).rename({ symbol: args.symbol, to: args.to });
      return { ok: change.ok, symbol: change.symbol, to: change.to, files: change.files, replacements: change.replacements, approvalHash: change.approvalHash, verification: change.verification, patches: change.patches.map((patch) => ({ file: patch.file, replacements: patch.replacements, beforeSha: patch.beforeSha, afterSha: patch.afterSha })) };
    },
    format: (data) => (data.ok ? `${data.files} plików, ${data.replacements} zmian; zatwierdź hash ${data.approvalHash.slice(0, 16)}…` : `odrzucono: ${data.verification.errors.map((entry) => entry.message).join('; ')}`),
  },
  {
    name: 'coding.rename_apply',
    title: 'Apply an approved rename',
    description: 'Applies a rename only when a consumed human approval matches the exact patch hash. Rejects stale files.',
    category: 'programming',
    permission: 'system',
    tags: ['code', 'refactor', 'approval', 'transactional'],
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 }, approvalHash: { type: 'string', minLength: 64, maxLength: 64 } },
      required: ['symbol', 'to', 'approvalHash'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.approval) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'a consumed human approval bound to the patch hash is required' };
      const approvedBy = ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}`;
      const change = refactor(ctx).rename({ symbol: args.symbol, to: args.to });
      if (!change.ok) return { ok: false, code: 'VERIFICATION_FAILED', verification: change.verification };
      return refactor(ctx).apply(change.patches, { approvedBy, approvalHash: args.approvalHash });
    },
    format: (data) => (data.ok ? `zastosowano w ${data.files.join(', ')}` : `${data.code}: ${data.message || ''}`),
  },
  {
    name: 'coding.verify',
    title: 'Verify patches in isolation',
    description: 'Copies proposed changes into a temporary tree and reparses them; the workspace is untouched.',
    category: 'programming',
    permission: 'read',
    tags: ['code', 'verify', 'isolated'],
    parameters: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }, required: ['symbol', 'to'], additionalProperties: false },
    async run(args, ctx) {
      const change = refactor(ctx).rename({ symbol: args.symbol, to: args.to });
      return { ok: change.ok, verification: refactor(ctx).verifyIsolated(change.patches), approvalHash: change.approvalHash };
    },
    format: (data) => (data.verification.ok ? `zweryfikowano ${data.verification.files.length} plików` : 'weryfikacja nie przeszła'),
  },
];
