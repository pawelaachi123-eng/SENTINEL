'use strict';

/**
 * Knowledge-graph tools. Every node and edge records who created it, so a
 * multi-hop answer can be traced back to a memory record, a document, a task or
 * the user instead of appearing as model intuition.
 */

const { NODE_TYPES, EDGE_TYPES } = require('../graph');

function requireGraph(ctx) {
  if (!ctx.graph) throw Object.assign(new Error('the knowledge graph is not available'), { code: 'NO_GRAPH' });
  return ctx.graph;
}

function formatLines(result) {
  if (!result || !result.lines || !result.lines.length) return 'brak powiązań w grafie';
  return result.lines.join('\n');
}

module.exports = [
  {
    name: 'graph.add',
    title: 'Add a graph node',
    description: 'Add or merge a typed node (project, file, symbol, decision, problem, solution, evidence…). Labels are normalised, so the same entity is never duplicated by case or missing diacritics.',
    category: 'knowledge',
    permission: 'write',
    tags: ['graph', 'knowledge', 'entity'],
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: NODE_TYPES },
        label: { type: 'string', minLength: 2, maxLength: 200 },
        props: { type: 'object' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['type', 'label'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const node = requireGraph(ctx).upsertNode({ ...args, source: ctx.source || 'assistant' });
      return { id: node.id, type: node.type, label: node.label, confidence: node.confidence, provenance: node.provenance };
    },
    format: (data) => `${data.type} ${data.label} (${data.id}, pewność ${data.confidence})`,
  },
  {
    name: 'graph.link',
    title: 'Connect two graph nodes',
    description: 'Create a typed relationship. Existing nodes are reused; missing ones can be created with explicit types.',
    category: 'knowledge',
    permission: 'write',
    tags: ['graph', 'knowledge', 'relation'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 2, maxLength: 200 },
        fromType: { type: 'string', enum: NODE_TYPES },
        to: { type: 'string', minLength: 2, maxLength: 200 },
        toType: { type: 'string', enum: NODE_TYPES },
        relation: { type: 'string', enum: EDGE_TYPES },
      },
      required: ['from', 'to', 'relation'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const graph = requireGraph(ctx);
      const from = graph.find(args.from, { type: args.fromType || null }) || graph.upsertNode({ type: args.fromType || 'concept', label: args.from, source: ctx.source || 'assistant' });
      const to = graph.find(args.to, { type: args.toType || null }) || graph.upsertNode({ type: args.toType || 'concept', label: args.to, source: ctx.source || 'assistant' });
      const edge = graph.link(from, to, args.relation, { source: ctx.source || 'assistant' });
      return { id: edge.id, from: from.label, to: to.label, relation: edge.type, created: true };
    },
    format: (data) => `${data.from} —${data.relation}→ ${data.to}`,
  },
  {
    name: 'graph.query',
    title: 'Query the knowledge graph',
    description: 'Find nodes matching the question, expand one or more hops and return the relationships with provenance. This is the multi-hop retrieval primitive.',
    category: 'knowledge',
    permission: 'read',
    tags: ['graph', 'knowledge', 'search', 'multi-hop'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 400 },
        depth: { type: 'number', default: 1, minimum: 1, maximum: 3 },
        limit: { type: 'number', default: 8, minimum: 1, maximum: 40 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = requireGraph(ctx).contextFor(args.query, { limit: args.limit, depth: args.depth });
      return { seeds: result.seeds, nodes: result.nodes, edges: result.edges, lines: result.lines, count: result.nodes.length };
    },
    format: (data) => (data.count ? formatLines(data) : 'brak powiązań w grafie'),
  },
  {
    name: 'graph.neighbours',
    title: 'Expand a graph node',
    description: 'Bounded breadth-first expansion around one node, up to three hops.',
    category: 'knowledge',
    permission: 'read',
    tags: ['graph', 'knowledge', 'traversal'],
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', minLength: 2, maxLength: 200 },
        depth: { type: 'number', default: 2, minimum: 1, maximum: 3 },
      },
      required: ['node'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const graph = requireGraph(ctx);
      const node = graph.find(args.node);
      if (!node) return { ok: false, code: 'NOT_FOUND', message: `no node matching ${args.node}` };
      const result = graph.explore(node.id, { depth: args.depth });
      return { ok: true, start: result.start, nodes: result.nodes.map((entry) => ({ id: entry.id, type: entry.type, label: entry.label, depth: entry.depth })), edges: result.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })), truncated: result.truncated };
    },
    format: (data) => (data.ok ? data.edges.map((edge) => `${edge.from} —${edge.type}→ ${edge.to}`).join('\n') || 'brak krawędzi' : data.message),
  },
  {
    name: 'graph.path',
    title: 'Explain how two things are connected',
    description: 'Shortest paths between two nodes, with the edges and provenance that justify each hop.',
    category: 'knowledge',
    permission: 'read',
    tags: ['graph', 'knowledge', 'path', 'evidence'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 2, maxLength: 200 },
        to: { type: 'string', minLength: 2, maxLength: 200 },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const graph = requireGraph(ctx);
      const from = graph.find(args.from);
      const to = graph.find(args.to);
      if (!from || !to) return { ok: false, code: 'NOT_FOUND', message: `unknown node: ${!from ? args.from : args.to}` };
      const paths = graph.paths(from, to).map((entry) => ({
        nodes: entry.nodes.map((node) => node && node.label),
        edges: entry.edges.map((edge) => edge && ({ type: edge.type, source: edge.provenance && edge.provenance.source })),
      }));
      return { ok: true, paths, count: paths.length };
    },
    format: (data) => (data.ok && data.count ? data.paths.map((path) => path.nodes.join(' → ')).join('\n') : 'brak ścieżki'),
  },
  {
    name: 'graph.sync',
    title: 'Feed the graph from memory and documents',
    description: 'Incrementally add memory records and indexed documents as nodes with their scope and folder relationships. Idempotent.',
    category: 'knowledge',
    permission: 'write',
    tags: ['graph', 'knowledge', 'sync'],
    parameters: {
      type: 'object',
      properties: { source: { type: 'string', enum: ['memory', 'knowledge', 'all'], default: 'all' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const graph = requireGraph(ctx);
      const out = { memory: null, knowledge: null };
      if ((args.source === 'all' || args.source === 'memory') && ctx.memory) out.memory = graph.ingestMemory(ctx.memory);
      if ((args.source === 'all' || args.source === 'knowledge') && ctx.knowledge) out.knowledge = graph.ingestKnowledge(ctx.knowledge);
      return { ...out, stats: graph.stats() };
    },
    format: (data) => `graf: ${data.stats.nodes} węzłów, ${data.stats.edges} krawędzi`,
  },
  {
    name: 'graph.stats',
    title: 'Graph statistics',
    description: 'Node and edge counts by type, traversal counters and whether the graph is persisted.',
    category: 'knowledge',
    permission: 'read',
    tags: ['graph', 'stats'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return requireGraph(ctx).stats();
    },
    format: (data) => `${data.nodes} węzłów, ${data.edges} krawędzi${data.persisted ? ' (trwały)' : ' (w pamięci)'}`,
  },
];
