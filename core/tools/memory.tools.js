'use strict';

/**
 * Memory and knowledge tools — the assistant's own long-term state, exposed to
 * itself through the same audited gate as everything else.
 *
 * Recall results are numbered `[M1]`, `[M2]` / `[K1]` so the model can cite
 * them; that is the whole point of retrieval here, and the prompt tells it to.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { truncate } = require('./helpers');

const KINDS = ['short_term', 'working', 'long_term', 'episodic', 'semantic', 'procedural', 'project', 'errors'];

function citationList(items, prefix) {
  return items.map((item, index) => {
    if (prefix === 'M') {
      return `[M${index + 1}] (${item.record.kind}, score ${item.score.toFixed(2)}) ${item.record.text}`;
    }
    return `[K${index + 1}] ${item.title}${item.chunk ? ` §${item.chunk}` : ''}: ${item.excerpt}`;
  });
}

module.exports = [
  {
    name: 'memory.remember',
    title: 'Remember something',
    description: 'Store a durable fact, preference, procedure or lesson. Secrets are refused, duplicates are merged.',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'remember', 'learning'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 3, maxLength: 4000 },
        kind: { type: 'string', enum: KINDS, default: 'long_term' },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
        importance: { type: 'number', default: 0.5, minimum: 0, maximum: 1 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const result = await ctx.memory.remember({
        kind: args.kind,
        text: args.text,
        tags: args.tags,
        importance: args.importance,
        source: 'assistant',
        sessionId: ctx.sessionId || null,
      });
      if (!result.record) {
        return { stored: false, reason: result.rejected, note: result.rejected && result.rejected.startsWith('looks like') ? 'that looks like a credential; SENTINEL does not store secrets' : null };
      }
      return { stored: true, merged: Boolean(result.merged), id: result.record.id, kind: result.record.kind };
    },
  },
  {
    name: 'memory.recall',
    title: 'Recall memories',
    description: 'Hybrid search over everything remembered: facts, episodes, procedures, error fixes and the current conversation.',
    category: 'memory',
    permission: 'read',
    tags: ['memory', 'recall', 'search'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS }, default: [] },
        limit: { type: 'integer', default: 6, minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const hits = await ctx.memory.recall(args.query, {
        kinds: args.kinds && args.kinds.length ? args.kinds : null,
        limit: args.limit,
        sessionId: ctx.sessionId || null,
      });
      return {
        query: args.query,
        count: hits.length,
        memories: hits.map((hit) => ({ id: hit.record.id, kind: hit.record.kind, text: hit.record.text, score: Number(hit.score.toFixed(3)), tags: hit.record.tags })),
        citations: citationList(hits, 'M'),
      };
    },
    format: (data) => (data.count ? data.citations.join('\n') : 'nothing remembered about that'),
  },
  {
    name: 'memory.list',
    title: 'List memories',
    description: 'Recent memories, optionally filtered by kind.',
    category: 'memory',
    permission: 'read',
    tags: ['memory', 'list'],
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const records = ctx.memory ? ctx.memory.list({ kind: args.kind || null, limit: args.limit }) : [];
      return {
        count: records.length,
        memories: records.map((record) => ({ id: record.id, kind: record.kind, text: truncate(record.text, 300), importance: record.importance, updatedAt: record.updatedAt })),
      };
    },
  },
  {
    name: 'memory.forget',
    title: 'Forget a memory',
    description: 'Remove one memory by id. This is permanent.',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'forget', 'delete'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const removed = ctx.memory ? ctx.memory.forget(args.id) : false;
      if (!removed) throw Object.assign(new Error(`no memory with id ${args.id}`), { code: 'NOT_FOUND' });
      return { forgotten: args.id };
    },
  },
  {
    name: 'memory.stats',
    title: 'Memory statistics',
    description: 'How many memories of each kind, database size and conversation counts.',
    category: 'memory',
    permission: 'read',
    tags: ['memory', 'stats'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return ctx.memory ? ctx.memory.stats() : { available: false };
    },
  },
  {
    name: 'memory.summarize',
    title: 'Summarise a conversation',
    description: 'Compress older turns of a conversation into a summary memory (keeps the last few turns verbatim).',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'summary', 'conversation'],
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', default: 'default', maxLength: 80 },
        keep: { type: 'integer', default: 12, minimum: 2, maximum: 60 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const summary = await ctx.memory.summarizeConversation(args.sessionId, { llm: ctx.llm, keep: args.keep });
      if (!summary) return { summarized: false, reason: 'the conversation is too short to compress' };
      return { summarized: true, ...summary };
    },
  },
  {
    name: 'memory.export',
    title: 'Export memory',
    description: 'Write all memories and conversations to a JSON file inside the workspace.',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'export', 'backup'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: 'memory-export.json' } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const payload = ctx.memory.exportAll();
      await fsp.mkdir(path.dirname(args.path), { recursive: true });
      await fsp.writeFile(args.path, JSON.stringify(payload, null, 2), 'utf8');
      const stat = await fsp.stat(args.path);
      return { path: args.path, bytes: stat.size, memories: payload.memories ? payload.memories.length : null, exportedAt: payload.exportedAt || null };
    },
  },
  {
    name: 'memory.import',
    title: 'Import memory',
    description: 'Merge a previously exported memory file (duplicates collapse).',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'import', 'restore'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const parsed = JSON.parse(await fsp.readFile(args.path, 'utf8'));
      return ctx.memory.importAll(parsed, { merge: true });
    },
  },
  {
    name: 'kb.index',
    title: 'Index documents',
    description: 'Add a file or folder (PDF, DOCX, XLSX, text, source code, logs) to the knowledge base for retrieval.',
    category: 'knowledge',
    permission: 'write',
    tags: ['knowledge', 'rag', 'index', 'pdf'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', default: true },
        maxFiles: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      const result = await ctx.knowledge.indexPath(args.path, { recursive: args.recursive, maxFiles: args.maxFiles, tags: args.tags, signal: ctx.signal });
      return {
        target: result.target,
        scanned: result.scanned,
        indexed: result.indexed,
        skipped: result.skipped,
        documents: result.documents.map((doc) => ({ id: doc.id, title: doc.title, chunks: doc.chunks, kind: doc.kind })),
        notes: result.details.map((detail) => `${detail.file}: ${detail.reason}`),
      };
    },
    format(data) {
      const lines = [`indexed ${data.indexed} of ${data.scanned} files (${data.skipped} skipped)`];
      for (const doc of data.documents.slice(0, 20)) lines.push(`  • ${doc.title} — ${doc.chunks} chunks`);
      for (const note of data.notes.slice(0, 10)) lines.push(`  · ${note}`);
      return lines.join('\n');
    },
  },
  {
    name: 'kb.index.text',
    title: 'Index a note',
    description: 'Add pasted text or a generated note to the knowledge base.',
    category: 'knowledge',
    permission: 'write',
    tags: ['knowledge', 'note'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        text: { type: 'string', minLength: 20, maxLength: 200000 },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      const result = await ctx.knowledge.indexText({ title: args.title, text: args.text, tags: args.tags });
      return { docId: result.doc.id, title: result.doc.title, chunks: result.chunks };
    },
  },
  {
    name: 'kb.search',
    title: 'Search the knowledge base',
    description: 'Hybrid search over indexed documents. Returns quotable excerpts with [K#] citations.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'rag', 'search', 'citations'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        limit: { type: 'integer', default: 5, minimum: 1, maximum: 20 },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      const hits = await ctx.knowledge.search(args.query, { limit: args.limit, tags: args.tags && args.tags.length ? args.tags : null });
      return {
        query: args.query,
        count: hits.length,
        results: hits.map((hit) => ({ id: hit.id, title: hit.title, source: hit.source, chunk: hit.chunk, score: hit.score, excerpt: hit.excerpt })),
        citations: citationList(hits, 'K'),
      };
    },
    format: (data) => (data.count ? data.citations.join('\n') : 'nothing in the knowledge base matches that'),
  },
  {
    name: 'kb.list',
    title: 'Indexed documents',
    description: 'What is in the knowledge base, with chunk counts.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'list'],
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 50, minimum: 1, maximum: 300 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { documents: ctx.knowledge ? ctx.knowledge.list({ limit: args.limit }) : [] };
    },
  },
  {
    name: 'kb.remove',
    title: 'Remove a document',
    description: 'Delete an indexed document and its chunks.',
    category: 'knowledge',
    permission: 'write',
    tags: ['knowledge', 'remove'],
    parameters: {
      type: 'object',
      properties: { docId: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['docId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const removed = ctx.knowledge ? ctx.knowledge.remove(args.docId) : false;
      if (!removed) throw Object.assign(new Error(`no document ${args.docId}`), { code: 'NOT_FOUND' });
      return { removed: args.docId };
    },
  },
  {
    name: 'kb.stats',
    title: 'Knowledge base statistics',
    description: 'Document and chunk counts, characters indexed and the embedder in use.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'stats'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return ctx.knowledge ? ctx.knowledge.stats() : { documents: 0, chunks: 0 };
    },
  },
  {
    name: 'kb.reindex',
    title: 'Re-embed everything',
    description: 'Rebuild vectors with the current embedding model (needed after switching embedders).',
    category: 'knowledge',
    permission: 'write',
    tags: ['knowledge', 'reindex', 'embeddings'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      return ctx.knowledge.reindex();
    },
  },
  {
    name: 'memory.conflicts',
    title: 'Contradictions in memory',
    description: 'Pairs of stored facts that disagree about the same subject, so you can ask the user which is true instead of silently overwriting.',
    category: 'memory',
    permission: 'read',
    tags: ['memory', 'conflict', 'quality'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      const pairs = ctx.memory.conflicts();
      return { count: pairs.length, pairs };
    },
    format: (data) => (data.count ? data.pairs.map((pair) => `A: ${pair.a.text}\nB: ${pair.b.text}`).join('\n\n') : 'memory contains no contradictions'),
  },
  {
    name: 'memory.integrity',
    title: 'Check memory integrity',
    description: 'Structural check of the memory store: dangling references, expired records, vector dimension and embedder mismatches.',
    category: 'memory',
    permission: 'read',
    tags: ['memory', 'integrity', 'diagnostics'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      return ctx.memory.integrity();
    },
    format: (data) => (data.ok ? `memory is consistent (${data.checked} records checked)` : `${data.problems.length} problem(s): ${data.problems.map((problem) => `${problem.id}:${problem.code}`).join(', ')}`),
  },
  {
    name: 'memory.consolidate',
    title: 'Consolidate episodic memory',
    description: 'Group same-day episodic memories into one semantic summary, deterministically and without a model.',
    category: 'memory',
    permission: 'write',
    tags: ['memory', 'consolidation', 'sleep'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.memory) throw Object.assign(new Error('memory is not available'), { code: 'NO_MEMORY' });
      return ctx.memory.consolidate();
    },
    format: (data) => (data.summaries ? `created ${data.summaries} summary record(s)` : 'nothing to consolidate yet'),
  },
  {
    name: 'kb.coverage',
    title: 'Knowledge base coverage',
    description: 'What the index actually contains: documents, chunks, kinds, stale files, untrusted-content flags and embedder coverage.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'coverage', 'quality'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      return ctx.knowledge.coverage();
    },
    format: (data) => `${data.documents} documents, ${data.chunks} chunks, ${data.stale} stale, ${data.withoutVectors} chunks without vectors`,
  },
  {
    name: 'kb.stale',
    title: 'Documents that changed',
    description: 'Files whose content or existence no longer matches the index.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'stale', 'index'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      const stale = ctx.knowledge.stale();
      return { count: stale.length, stale };
    },
    format: (data) => (data.count ? data.stale.map((entry) => `${entry.path}: ${entry.reason}`).join('\n') : 'every indexed file is unchanged'),
  },
  {
    name: 'kb.symbols',
    title: 'Find code symbols',
    description: 'Search functions, classes and methods by name in authorised code files. More precise than full-text search for code.',
    category: 'knowledge',
    permission: 'read',
    tags: ['knowledge', 'code', 'symbols'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 120 },
        path: { type: 'string', description: 'file or folder to scan' },
        limit: { type: 'number', default: 40, minimum: 1, maximum: 200 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args, ctx) {
      if (!ctx.knowledge) throw Object.assign(new Error('the knowledge base is not available'), { code: 'NO_KNOWLEDGE' });
      const fs = require('node:fs');
      const { walk } = require('./helpers');
      let files = [];
      if (args.path) {
        const stat = fs.statSync(args.path);
        files = stat.isDirectory() ? await walk(args.path, { maxDepth: 6, maxFiles: 400 }) : [args.path];
      } else {
        files = ctx.knowledge.list({ limit: 200 }).map((doc) => doc.path).filter(Boolean);
      }
      const hits = ctx.knowledge.findSymbols(args.query, { files, limit: args.limit });
      return { count: hits.length, hits };
    },
    format: (data) => (data.count ? data.hits.map((hit) => `${hit.kind} ${hit.name} — ${hit.file}:${hit.line}`).join('\n') : 'no symbol matched'),
  },
];

