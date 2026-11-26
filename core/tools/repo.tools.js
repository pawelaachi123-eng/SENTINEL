'use strict';

/** Repository map tools. Lexical intelligence, labelled as such. */

function map(ctx) {
  if (!ctx.repoMap) throw Object.assign(new Error('the repository map is not available'), { code: 'NO_REPO_MAP' });
  return ctx.repoMap;
}

module.exports = [
  {
    name: 'repo.map',
    title: 'Map the repository',
    description: 'Bounded lexical map of the workspace: languages, directories, entrypoints, declared symbols and imports. It states that it is not a type-aware parser.',
    category: 'code',
    permission: 'read',
    tags: ['repo', 'map', 'symbols', 'dependencies'],
    parameters: {
      type: 'object',
      properties: { refresh: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (args.refresh) map(ctx).scan();
      return { ok: true, ...map(ctx).summary() };
    },
    format: (data) => `${data.files} plików, ${data.symbols} symboli, ${data.tests} testów${data.truncated ? ' (obcięta)' : ''}`,
  },
  {
    name: 'repo.search',
    title: 'Find a symbol or file',
    description: 'Search declarations and paths in the repository map. Results include file, symbol name and declaration line.',
    category: 'code',
    permission: 'read',
    tags: ['repo', 'search', 'symbols'],
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 120 }, limit: { type: 'number', minimum: 1, maximum: 100 } },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { ok: true, ...map(ctx).search(args.query, { limit: args.limit || 20 }) };
    },
    format: (data) => `${data.matches.length} trafień`,
  },
  {
    name: 'repo.impact',
    title: 'What a change would touch',
    description: 'For a file or symbol, lists import dependents, textual references and the closest tests. Evidence for planning a patch, not a guarantee.',
    category: 'code',
    permission: 'read',
    tags: ['repo', 'impact', 'refactor', 'tests'],
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', maxLength: 300 }, symbol: { type: 'string', maxLength: 120 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = map(ctx).impact({ file: args.file || null, symbol: args.symbol || null });
      return { ok: result.ok, ...result };
    },
    format: (data) => (data.ok ? `${data.dependents.length} zależnych, ${data.references.length} referencji, ${data.tests.length} testów` : `brak danych: ${data.code}`),
  },
];
