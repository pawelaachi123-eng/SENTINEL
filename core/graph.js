'use strict';

/**
 * Persistent knowledge graph.
 *
 * The graph is deliberately boring: typed nodes, typed edges, provenance,
 * timestamps and bounded traversal. It is not a reasoner and it does not invent
 * relationships — every edge names where it came from (`memory`, `knowledge`,
 * `task`, `patch`, `user`, `tool`). That is what makes a multi-hop answer
 * auditable: the path is reproducible and every hop has a source.
 *
 * Entity resolution is normalisation, not guessing: a node's identity is
 * `type + normalised label` (case and diacritics folded, punctuation stripped),
 * with aliases merged into the same node. Two different spellings of the same
 * project do not become two projects.
 *
 * Traversal is bounded by depth and node count so a malformed graph can never
 * turn a question into an unbounded walk.
 */

const path = require('node:path');
const { newId } = require('./memory/store');
const { stripDiacritics } = require('./cognition');

const NODE_TYPES = ['project', 'file', 'folder', 'symbol', 'concept', 'decision', 'problem', 'solution', 'event', 'evidence', 'document', 'person', 'device', 'task', 'error'];
const EDGE_TYPES = ['contains', 'references', 'depends_on', 'implements', 'tests', 'caused', 'solved_by', 'decided', 'about', 'mentions', 'produced', 'related', 'supersedes'];

const MAX_DEPTH = 3;
const MAX_NODES = 240;

function normaliseLabel(label) {
  return stripDiacritics(String(label || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function keyFor(type, label) {
  return `${type}:${normaliseLabel(label)}`;
}

class KnowledgeGraph {
  constructor({ store = null, log = null, now = () => Date.now(), maxNodes = 50000 } = {}) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.maxNodes = maxNodes;
    this.nodes = new Map();
    this.edges = new Map();
    this.byKey = new Map();
    this.adjacency = new Map(); // nodeId → Set<edgeId>
    this.counters = { upserts: 0, merges: 0, links: 0, traversals: 0, pruned: 0 };
    this.load();
  }

  load() {
    if (!this.store) return;
    try {
      for (const node of this.store.list('graph_nodes')) this.addNodeInMemory(node);
      for (const edge of this.store.list('graph_edges')) this.addEdgeInMemory(edge);
    } catch (err) {
      if (this.log) this.log.warn('graph', `could not load the graph: ${err.message}`);
    }
  }

  addNodeInMemory(node) {
    this.nodes.set(node.id, node);
    this.byKey.set(node.key, node.id);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, new Set());
  }

  addEdgeInMemory(edge) {
    this.edges.set(edge.id, edge);
    if (!this.adjacency.has(edge.from)) this.adjacency.set(edge.from, new Set());
    if (!this.adjacency.has(edge.to)) this.adjacency.set(edge.to, new Set());
    this.adjacency.get(edge.from).add(edge.id);
    this.adjacency.get(edge.to).add(edge.id);
  }

  persistNode(node) {
    if (this.store) this.store.put('graph_nodes', node.id, node);
  }

  persistEdge(edge) {
    if (this.store) this.store.put('graph_edges', edge.id, edge);
  }

  /* ── writes ──────────────────────────────────────────────────────────── */

  upsertNode({ type = 'concept', label, props = {}, scope = 'global', confidence = 0.7, source = 'user', aliases = [], id = null } = {}) {
    if (!NODE_TYPES.includes(type)) throw Object.assign(new Error(`unknown node type ${type}`), { code: 'BAD_TYPE' });
    const text = String(label || '').trim();
    if (!text) throw Object.assign(new Error('a node needs a label'), { code: 'BAD_ARGS' });
    const key = keyFor(type, text);
    const existingId = this.byKey.get(key);
    if (existingId) {
      const node = this.nodes.get(existingId);
      // Contradictory values are never silently replaced: the old value stays,
      // the incoming one is recorded as a conflict and both are surfaced.
      for (const [key, value] of Object.entries(props)) {
        const previous = node.props ? node.props[key] : undefined;
        if (previous !== undefined && previous !== null && JSON.stringify(previous) !== JSON.stringify(value)) {
          node.conflicts = [...(node.conflicts || []), { prop: key, kept: previous, incoming: value, source, at: this.now() }].slice(-8);
        }
      }
      const conflicting = new Set((node.conflicts || []).map((entry) => entry.prop));
      for (const [key, value] of Object.entries(props)) {
        if (!conflicting.has(key)) node.props[key] = value;
      }
      node.aliases = [...new Set([...(node.aliases || []), ...aliases, text])].slice(0, 12);
      node.updatedAt = this.now();
      node.confidence = Math.max(node.confidence || 0, Math.min(1, Number(confidence) || 0));
      if (node.label !== text) node.label = node.label.length <= text.length ? node.label : text;
      this.persistNode(node);
      this.counters.merges += 1;
      return node;
    }
    if (this.nodes.size >= this.maxNodes) this.prune();
    const node = {
      id: id || newId('node'),
      type,
      key,
      label: text.slice(0, 200),
      aliases: [...new Set([text, ...aliases.map((alias) => String(alias).slice(0, 200))])].slice(0, 12),
      props,
      scope,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0.7)),
      provenance: { source, at: this.now() },
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.addNodeInMemory(node);
    this.persistNode(node);
    this.counters.upserts += 1;
    return node;
  }

  /** Resolves a label to a node of any known type, for tool arguments. */
  find(label, { type = null } = {}) {
    if (type) {
      const id = this.byKey.get(keyFor(type, label));
      return id ? this.nodes.get(id) : null;
    }
    for (const candidate of NODE_TYPES) {
      const id = this.byKey.get(keyFor(candidate, label));
      if (id) return this.nodes.get(id);
    }
    return null;
  }

  link(from, to, type = 'related', { weight = 1, props = {}, source = 'user', confidence = 0.7 } = {}) {
    if (!EDGE_TYPES.includes(type)) throw Object.assign(new Error(`unknown edge type ${type}`), { code: 'BAD_TYPE' });
    const a = typeof from === 'string' ? this.nodes.get(from) || this.find(from) : from;
    const b = typeof to === 'string' ? this.nodes.get(to) || this.find(to) : to;
    if (!a || !b) throw Object.assign(new Error(`cannot link ${typeof from === 'string' ? from : from && from.id} → ${typeof to === 'string' ? to : to && to.id}: node missing`), { code: 'NODE_MISSING' });
    const existing = [...(this.adjacency.get(a.id) || [])]
      .map((edgeId) => this.edges.get(edgeId))
      .find((edge) => edge && edge.from === a.id && edge.to === b.id && edge.type === type);
    if (existing) {
      existing.weight = Math.max(existing.weight, Number(weight) || 1);
      existing.updatedAt = this.now();
      if (argsContradict(existing.props, props)) {
        existing.conflicts = [...(existing.conflicts || []), { at: this.now(), source, incoming: props }].slice(-4);
      }
      existing.props = { ...existing.props, ...props };
      this.persistEdge(existing);
      return existing;
    }
    const edge = {
      id: newId('edge'),
      from: a.id,
      to: b.id,
      type,
      weight: Number(weight) || 1,
      props,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0.7)),
      provenance: { source, at: this.now() },
      createdAt: this.now(),
    };
    this.addEdgeInMemory(edge);
    this.persistEdge(edge);
    this.counters.links += 1;
    return edge;
  }

  /** True when two nodes make opposite claims (A supersedes B while B supersedes A). */
  contradiction(aId, bId) {
    return [...(this.adjacency.get(aId) || [])].map((edgeId) => this.edges.get(edgeId)).filter((edge) => edge && edge.from === bId && edge.to === aId && edge.type === 'supersedes');
  }

  /** Convenience: upsert both ends and link them in one call. */
  relate(fromSpec, toSpec, type, options = {}) {
    const a = this.upsertNode(fromSpec);
    const b = this.upsertNode(toSpec);
    return { from: a, to: b, edge: this.link(a, b, type, options) };
  }

  removeNode(id) {
    const node = this.nodes.get(id) || this.find(id);
    if (!node) return { ok: false, code: 'NOT_FOUND' };
    for (const edgeId of [...(this.adjacency.get(node.id) || [])]) {
      const edge = this.edges.get(edgeId);
      this.adjacency.get(node.id) && this.adjacency.get(node.id).delete(edgeId);
      if (edge) {
        this.adjacency.get(edge.from) && this.adjacency.get(edge.from).delete(edgeId);
        this.adjacency.get(edge.to) && this.adjacency.get(edge.to).delete(edgeId);
      }
      this.edges.delete(edgeId);
      if (this.store) this.store.delete('graph_edges', edgeId);
    }
    this.nodes.delete(node.id);
    this.byKey.delete(node.key);
    this.adjacency.delete(node.id);
    if (this.store) this.store.delete('graph_nodes', node.id);
    return { ok: true, removed: node.id, edges: true };
  }

  /** Removes the least-connected nodes when the store grows past its cap. */
  prune(limit = null) {
    const target = limit || Math.floor(this.maxNodes * 0.9);
    if (this.nodes.size <= target) return { removed: 0 };
    const byDegree = [...this.nodes.values()].sort((a, b) => (this.adjacency.get(a.id).size - this.adjacency.get(b.id).size) || (a.updatedAt - b.updatedAt));
    let removed = 0;
    for (const node of byDegree) {
      if (this.nodes.size <= target) break;
      this.removeNode(node.id);
      removed += 1;
    }
    this.counters.pruned += removed;
    return { removed };
  }

  /* ── reads ───────────────────────────────────────────────────────────── */

  getNode(id) {
    return this.nodes.get(id) || this.find(id);
  }

  edgesOf(id) {
    return [...(this.adjacency.get(id) || [])].map((edgeId) => this.edges.get(edgeId)).filter(Boolean);
  }

  neighbours(id, { direction = 'both', types = null } = {}) {
    const node = this.getNode(id);
    if (!node) return [];
    const out = [];
    for (const edge of this.edgesOf(node.id)) {
      if (types && !types.includes(edge.type)) continue;
      if (direction !== 'in' && edge.from === node.id) out.push({ node: this.nodes.get(edge.to), edge, direction: 'out' });
      else if (direction !== 'out' && edge.to === node.id) out.push({ node: this.nodes.get(edge.from), edge, direction: 'in' });
    }
    return out.filter((entry) => entry.node);
  }

  /** Bounded breadth-first traversal. Returns nodes, edges and reproducible paths. */
  explore(id, { depth = 2, maxNodes = 60, types = null, direction = 'both' } = {}) {
    const start = this.getNode(id);
    if (!start) return { ok: false, code: 'NOT_FOUND', nodes: [], edges: [] };
    const limit = Math.min(MAX_DEPTH, Math.max(1, Number(depth) || 2));
    const cap = Math.min(MAX_NODES, Math.max(1, Number(maxNodes) || 60));
    const seen = new Map([[start.id, { node: start, depth: 0, via: null }]]);
    const edges = new Map();
    let frontier = [start.id];
    for (let level = 1; level <= limit && frontier.length && seen.size < cap; level += 1) {
      const next = [];
      for (const currentId of frontier) {
        for (const entry of this.neighbours(currentId, { direction, types })) {
          edges.set(entry.edge.id, entry.edge);
          if (seen.has(entry.node.id)) continue;
          seen.set(entry.node.id, { node: entry.node, depth: level, via: { edge: entry.edge.id, from: currentId } });
          next.push(entry.node.id);
          if (seen.size >= cap) break;
        }
      }
      frontier = next;
    }
    this.counters.traversals += 1;
    return {
      ok: true,
      start: { id: start.id, label: start.label, type: start.type },
      depth: limit,
      truncated: seen.size >= cap,
      nodes: [...seen.values()].map((entry) => ({ ...entry.node, depth: entry.depth })),
      edges: [...edges.values()],
    };
  }

  /** Every shortest path up to `maxDepth`, bounded and deterministic. */
  paths(from, to, { maxDepth = 3, limit = 3 } = {}) {
    const start = this.getNode(from);
    const goal = this.getNode(to);
    if (!start || !goal) return [];
    const depth = Math.min(MAX_DEPTH, Math.max(1, maxDepth));
    const results = [];
    const queue = [{ id: start.id, path: [start.id], edges: [] }];
    while (queue.length && results.length < limit) {
      const item = queue.shift();
      if (item.path.length - 1 >= depth) continue;
      for (const entry of this.neighbours(item.id)) {
        if (item.path.includes(entry.node.id)) continue;
        const path = [...item.path, entry.node.id];
        const edges = [...item.edges, entry.edge.id];
        if (entry.node.id === goal.id) results.push({ nodes: path.map((id) => this.nodes.get(id)), edges: edges.map((id) => this.edges.get(id)) });
        else queue.push({ id: entry.node.id, path, edges });
      }
    }
    return results;
  }

  /** Lexical seed selection, then one expansion hop. Used by the brain. */
  contextFor(text, { limit = 8, depth = 1, scope = null } = {}) {
    const terms = normaliseLabel(text).split(' ').filter((term) => term.length > 2);
    if (!terms.length) return { lines: [], nodes: [], edges: [] };
    const seeds = [];
    for (const node of this.nodes.values()) {
      if (scope && node.scope !== 'global' && node.scope !== scope) continue;
      const haystack = normaliseLabel([node.label, ...(node.aliases || [])].join(' '));
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 / (1 + haystack.indexOf(term) * 0.02) : 0), 0);
      if (score > 0) seeds.push({ node, score });
    }
    seeds.sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label));
    const chosen = seeds.slice(0, Math.max(1, Math.min(limit, 6)));
    const nodes = new Map();
    const edges = new Map();
    for (const seed of chosen) {
      const result = this.explore(seed.node.id, { depth, maxNodes: limit });
      for (const node of result.nodes || []) nodes.set(node.id, node);
      for (const edge of result.edges || []) edges.set(edge.id, edge);
      if (nodes.size >= limit * 3) break;
    }
    const label = (id) => {
      const node = nodes.get(id) || this.nodes.get(id);
      return node ? node.label : id;
    };
    const lines = [...edges.values()].slice(0, limit * 2).map((edge) => {
      const endpoints = [nodes.get(edge.from), nodes.get(edge.to)].filter(Boolean);
      const conflict = endpoints.some((node) => node.conflicts && node.conflicts.length) || (edge.conflicts && edge.conflicts.length);
      return `${conflict ? '⚠ konflikt: ' : ''}${label(edge.from)} —${edge.type}→ ${label(edge.to)}${edge.provenance && edge.provenance.source ? ` [${edge.provenance.source}]` : ''}`;
    });
    return {
      lines,
      nodes: [...nodes.values()].slice(0, limit * 3).map((node) => ({ id: node.id, type: node.type, label: node.label, depth: node.depth || 0, confidence: node.confidence, provenance: node.provenance })),
      edges: [...edges.values()].slice(0, limit * 3),
      seeds: chosen.map((entry) => ({ id: entry.node.id, label: entry.node.label, score: Number(entry.score.toFixed(2)) })),
    };
  }

  /* ── ingestion ───────────────────────────────────────────────────────── */

  /** Memory records become evidence/decision nodes attached to their scope. */
  ingestMemory(memory, { limit = 500 } = {}) {
    if (!memory || !memory.list) return { nodes: 0, edges: 0 };
    let nodes = 0;
    let edges = 0;
    for (const record of memory.list({ limit })) {
      const type = record.kind === 'procedural' ? 'solution' : record.kind === 'project' ? 'decision' : 'evidence';
      const node = this.upsertNode({
        type,
        label: String(record.text).slice(0, 160),
        aliases: [record.id],
        props: { memoryId: record.id, kind: record.kind, confidence: record.confidence || null, tags: record.tags || [] },
        scope: record.scope || 'global',
        confidence: record.confidence || 0.6,
        source: 'memory',
      });
      nodes += 1;
      if (record.scope && record.scope !== 'global') {
        const project = this.upsertNode({ type: 'project', label: record.scope, source: 'memory', confidence: 0.8 });
        this.link(project, node, 'contains', { source: 'memory' });
        edges += 1;
      }
    }
    return { nodes, edges };
  }

  /** Indexed documents become document nodes with their real path. */
  ingestKnowledge(knowledge, { limit = 500 } = {}) {
    if (!knowledge || !knowledge.list) return { nodes: 0, edges: 0 };
    let nodes = 0;
    let edges = 0;
    for (const doc of knowledge.list({ limit })) {
      const node = this.upsertNode({
        type: 'document',
        label: doc.title || doc.path || doc.id,
        aliases: [doc.id, doc.path].filter(Boolean),
        props: { docId: doc.id, path: doc.path || null, chunks: doc.chunks || 0, kind: doc.kind || 'text' },
        confidence: 0.9,
        source: 'knowledge',
      });
      nodes += 1;
      const folder = doc.path ? path.dirname(String(doc.path)) : null;
      if (folder) {
        const folderNode = this.upsertNode({ type: 'folder', label: folder, source: 'knowledge', confidence: 0.9 });
        this.link(folderNode, node, 'contains', { source: 'knowledge' });
        edges += 1;
      }
    }
    return { nodes, edges };
  }

  /** A finished task leaves a durable trace: task → decisions → problems. */
  ingestTask(task) {
    if (!task) return null;
    const node = this.upsertNode({
      type: 'task',
      label: String(task.title || task.id).slice(0, 160),
      aliases: [task.id],
      props: { status: task.status, steps: (task.steps || []).length, failed: (task.steps || []).filter((step) => step.status === 'failed').length },
      confidence: task.status === 'done' ? 0.9 : 0.5,
      source: 'task',
    });
    for (const step of task.steps || []) {
      if (step.status === 'failed') {
        const problem = this.upsertNode({ type: 'problem', label: `${step.title}: ${(step.error || 'failed').slice(0, 120)}`, source: 'task', confidence: 0.6 });
        this.link(problem, node, 'caused', { source: 'task' });
      }
    }
    return node;
  }

  stats() {
    const byType = {};
    const byEdge = {};
    for (const node of this.nodes.values()) byType[node.type] = (byType[node.type] || 0) + 1;
    for (const edge of this.edges.values()) byEdge[edge.type] = (byEdge[edge.type] || 0) + 1;
    return { nodes: this.nodes.size, edges: this.edges.size, byType, byEdge, counters: { ...this.counters }, persisted: Boolean(this.store) };
  }

  /** A compact, deterministic export for the API and the graph explorer. */
  export({ limit = 200 } = {}) {
    return {
      nodes: [...this.nodes.values()].slice(0, limit).map((node) => ({ id: node.id, type: node.type, label: node.label, confidence: node.confidence, provenance: node.provenance })),
      edges: [...this.edges.values()].slice(0, limit * 2).map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type, provenance: edge.provenance })),
      stats: this.stats(),
    };
  }
}

/** Shallow contradiction check used for repeated edges. */
function argsContradict(previous, incoming) {
  if (!previous || !incoming) return false;
  return Object.keys(incoming).some((key) => previous[key] !== undefined && JSON.stringify(previous[key]) !== JSON.stringify(incoming[key]));
}

module.exports = { KnowledgeGraph, normaliseLabel, keyFor, NODE_TYPES, EDGE_TYPES, MAX_DEPTH };
