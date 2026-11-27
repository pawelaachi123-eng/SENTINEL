'use strict';

/**
 * Cognitive-state and reasoning tools.
 *
 * The blackboard tools operate on the agent's real session board; the reasoning
 * tools call deterministic solvers. None of them produce prose confidence:
 * every result carries the epistemic status the solver can justify.
 */

const { forwardChain, abduce, solveCsp, bayesUpdate, causalPaths, intervalRelations, spatialRelations, decide, induce, counterfactual, bayesNetwork, optimizeCsp, hierarchicalPlan, graphSearch, verifyPropositional } = require('../reasoning/engines');
const { MetacognitiveController } = require('../cognition/metacognition');

const SCOPE = { type: 'string', minLength: 3, maxLength: 128, description: 'global, session:<id>, task:<id> or workspace:<id>' };
const TEXT = { type: 'string', minLength: 1, maxLength: 20000 };

function board(ctx) {
  if (!ctx.blackboard) throw Object.assign(new Error('the cognitive blackboard is not available'), { code: 'NO_BLACKBOARD' });
  return ctx.blackboard;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = [
  {
    name: 'blackboard.add',
    title: 'Write typed cognitive state',
    description: 'Adds a typed entry with provenance, owner, scope, confidence and epistemic status. Changed keyed content is kept as a contradiction rather than overwriting the old claim.',
    category: 'cognitive',
    permission: 'write',
    tags: ['blackboard', 'cognition', 'memory', 'provenance'],
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['perception', 'question', 'goal', 'constraint', 'fact', 'belief', 'hypothesis', 'evidence', 'plan', 'task', 'decision', 'result', 'verification', 'error', 'preference', 'answer', 'artifact', 'observation'] },
        content: {},
        scope: SCOPE,
        key: { type: 'string', maxLength: 160 },
        confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
        status: { type: 'string', enum: ['proven', 'supported', 'estimated', 'unsupported', 'contradicted', 'retracted'], default: 'supported' },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
        source: { type: 'string', maxLength: 120, default: 'tool' },
        ref: { type: 'string', maxLength: 300 },
        merge: { type: 'boolean', default: false },
      },
      required: ['type', 'content', 'scope'],
      additionalProperties: false,
    },
    examples: [{ args: { type: 'fact', content: 'Atlas orbit is 12 days', scope: 'session:demo', confidence: 0.9, status: 'proven' }, expect: { type: 'fact' } }],
    async run(args, ctx) {
      const entry = board(ctx).add({
        type: args.type,
        content: args.content,
        scope: args.scope,
        key: args.key || null,
        confidence: args.confidence,
        status: args.status,
        tags: args.tags,
        merge: args.merge,
        provenance: [{ source: args.source || 'tool', ref: args.ref || null }],
        owner: { sessionId: ctx.sessionId || null, runId: null, agent: 'tool' },
      });
      return { ok: true, entry };
    },
    format: (data) => `${data.entry.id} · ${data.entry.type}/${data.entry.status} ${data.entry.confidence.toFixed(2)}`,
  },
  {
    name: 'blackboard.get',
    title: 'Read one cognitive entry',
    description: 'Returns one entry by id if it is visible in the requested scope. Entries from another session are refused.',
    category: 'cognitive',
    permission: 'read',
    tags: ['blackboard', 'cognition'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 3 }, scope: SCOPE }, required: ['id', 'scope'], additionalProperties: false },
    examples: [{ args: { id: 'bb_missing', scope: 'session:demo' }, expect: { ok: false } }],
    async run(args, ctx) {
      const entry = board(ctx).get(args.id, { scope: args.scope });
      if (!entry) return { ok: false, code: 'NOT_FOUND', message: `no entry ${args.id} in ${args.scope}` };
      return { ok: true, entry };
    },
    format: (data) => (data.ok ? `${data.entry.type}: ${typeof data.entry.content === 'string' ? data.entry.content : JSON.stringify(data.entry.content)}` : data.code),
  },
  {
    name: 'blackboard.query',
    title: 'Query cognitive state',
    description: 'Filters typed entries by scope, type, tag, status, text and minimum confidence, ranked by dynamic attention.',
    category: 'cognitive',
    permission: 'read',
    tags: ['blackboard', 'cognition', 'query', 'attention'],
    parameters: {
      type: 'object',
      properties: {
        scope: SCOPE,
        types: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        text: { type: 'string', maxLength: 400 },
        minConfidence: { type: 'number', minimum: 0, maximum: 1 },
        goal: { type: 'string', maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
        includeGlobal: { type: 'boolean', default: true },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    examples: [{ args: { scope: 'session:demo', limit: 5 }, expect: { ok: true } }],
    async run(args, ctx) {
      const entries = board(ctx).query({ ...args, limit: args.limit });
      return { ok: true, entries, count: entries.length };
    },
    format: (data) => `${data.count} entries`,
  },
  {
    name: 'blackboard.focus',
    title: 'Allocate the attention window',
    description: 'Selects the highest-attention entries under an explicit token budget and reports what was omitted.',
    category: 'cognitive',
    permission: 'read',
    tags: ['blackboard', 'attention', 'budget'],
    parameters: {
      type: 'object',
      properties: {
        scope: SCOPE,
        goal: { type: 'string', maxLength: 1000 },
        tokens: { type: 'integer', minimum: 60, maximum: 8000, default: 600 },
        types: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 80, default: 16 },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    examples: [{ args: { scope: 'session:demo', goal: 'Atlas orbit', tokens: 300 }, expect: { ok: true } }],
    async run(args, ctx) {
      const focus = board(ctx).focus(args);
      return { ok: true, ...focus };
    },
    format: (data) => `${data.entries} entries, ~${data.estimatedTokens} tokens, ${data.omitted} omitted`,
  },
  {
    name: 'blackboard.conflicts',
    title: 'List contradictions',
    description: 'Lists explicit and same-key contradictions with whether each pair has been resolved.',
    category: 'cognitive',
    permission: 'read',
    tags: ['blackboard', 'contradiction', 'integrity'],
    parameters: { type: 'object', properties: { scope: SCOPE }, required: ['scope'], additionalProperties: false },
    examples: [{ args: { scope: 'session:demo' }, expect: { ok: true } }],
    async run(args, ctx) {
      const conflicts = board(ctx).conflicts({ scope: args.scope });
      return { ok: true, conflicts, unresolved: conflicts.filter((pair) => !pair.resolved).length };
    },
    format: (data) => `${data.unresolved} unresolved of ${data.conflicts.length}`,
  },
  {
    name: 'blackboard.resolve',
    title: 'Resolve a contradiction with provenance',
    description: 'Marks a loser entry contradicted and records who resolved it and why. The loser is retained for later reconsideration.',
    category: 'cognitive',
    permission: 'write',
    tags: ['blackboard', 'contradiction', 'decision'],
    parameters: {
      type: 'object',
      properties: {
        winnerId: { type: 'string', minLength: 3 },
        loserId: { type: 'string', minLength: 3 },
        reason: { type: 'string', maxLength: 500 },
        actor: { type: 'string', maxLength: 120, default: 'user' },
      },
      required: ['winnerId', 'loserId'],
      additionalProperties: false,
    },
    examples: [{ args: { winnerId: 'bb_missing', loserId: 'bb_missing2' }, expect: { ok: false } }],
    async run(args, ctx) {
      return { ok: true, ...board(ctx).resolve(args) };
    },
    format: (data) => `${data.winner.id} over ${data.loser.id}`,
  },
  {
    name: 'blackboard.retract',
    title: 'Retract a false entry',
    description: 'Marks an entry retracted with zero confidence and keeps its revision history instead of deleting the evidence trail.',
    category: 'cognitive',
    permission: 'write',
    tags: ['blackboard', 'correction', 'provenance'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 3 }, reason: { type: 'string', maxLength: 400 }, actor: { type: 'string', maxLength: 120, default: 'user' } }, required: ['id'], additionalProperties: false },
    examples: [{ args: { id: 'bb_missing' }, expect: { ok: false } }],
    async run(args, ctx) { return { ok: true, entry: board(ctx).retract(args.id, args) }; },
    format: (data) => `retracted ${data.entry.id}`,
  },
  {
    name: 'blackboard.stats',
    title: 'Cognitive board statistics',
    description: 'Entry counts by type and status, expired entries, unresolved conflicts and persistence state for one scope.',
    category: 'cognitive',
    permission: 'read',
    tags: ['blackboard', 'cognition', 'stats'],
    parameters: { type: 'object', properties: { scope: SCOPE }, additionalProperties: false },
    examples: [{ args: {}, expect: { ok: true } }],
    async run(args, ctx) { return { ok: true, ...board(ctx).stats(args.scope || null) }; },
    format: (data) => `${data.entries} entries, ${data.unresolvedConflicts} conflicts`,
  },

  {
    name: 'omega.deduce',
    title: 'Forward-chaining deduction',
    description: 'Derives every fact entailed by Horn-style rules, with proof support, bounded iterations and explicit contradictions.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'deduction', 'logic', 'proof'],
    parameters: {
      type: 'object',
      properties: {
        facts: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 500 },
        rules: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 200 },
        maxIterations: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
      },
      required: ['facts', 'rules'],
      additionalProperties: false,
    },
    examples: [{
      args: {
        facts: [{ pred: 'parent', args: ['ann', 'bob'] }],
        rules: [{ id: 'ancestor', if: [{ pred: 'parent', args: ['?x', '?y'] }], then: { pred: 'ancestor', args: ['?x', '?y'] } }],
      },
      expect: { derived: 1 },
    }],
    async run(args) {
      const result = forwardChain(args);
      return { ok: true, ...result };
    },
    format: (data) => `${data.derived} derived facts, ${data.contradictions.length} contradictions`,
  },
  {
    name: 'omega.abduce',
    title: 'Bounded abduction',
    description: 'Finds the smallest sets of assumable hypotheses that entail all observations. Candidates are labelled supported or estimated, never proven.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'abduction', 'diagnosis', 'hypothesis'],
    parameters: {
      type: 'object',
      properties: {
        facts: { type: 'array', items: { type: 'object' }, default: [] },
        rules: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 200 },
        observations: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 100 },
        maxHypotheses: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
        maxCandidates: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['rules', 'observations'],
      additionalProperties: false,
    },
    examples: [{
      args: {
        rules: [{ id: 'power', if: [{ pred: 'power_cut', args: ['?x'], assumable: true }], then: { pred: 'down', args: ['?x'] } }],
        observations: [{ pred: 'down', args: ['server'] }],
      },
      expect: { status: 'supported' },
    }],
    async run(args) { return { ok: true, ...abduce(args) }; },
    format: (data) => `${data.candidates.length} candidate explanations, ${data.status}`,
  },
  {
    name: 'omega.csp',
    title: 'Finite-domain constraint solver',
    description: 'Backtracking search with MRV, forward checking and a node budget. Unsatisfiability is only claimed after the finite space is exhausted.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'csp', 'constraints', 'search'],
    parameters: {
      type: 'object',
      properties: {
        variables: { type: 'object' },
        constraints: { type: 'array', items: { type: 'object' }, maxItems: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 200000, default: 50000 },
      },
      required: ['variables'],
      additionalProperties: false,
    },
    examples: [{
      args: { variables: { a: [1, 2], b: [1, 2] }, constraints: [{ vars: ['a', 'b'], op: 'neq' }] },
      expect: { satisfiable: true },
    }],
    async run(args) { return { ok: true, ...solveCsp(args) }; },
    format: (data) => `${data.solutions.length} solutions in ${data.nodes} nodes`,
  },
  {
    name: 'omega.bayes',
    title: 'Bayesian evidence update',
    description: 'Updates explicit priors with independent conditional likelihoods, normalises the posterior and lists skipped evidence.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'probability', 'bayes', 'uncertainty'],
    parameters: {
      type: 'object',
      properties: {
        hypotheses: { type: 'object' },
        priors: { type: 'object' },
        evidence: { type: 'array', items: { type: 'object' }, maxItems: 100 },
      },
      required: ['hypotheses'],
      additionalProperties: false,
    },
    examples: [{
      args: { hypotheses: { a: true, b: true }, evidence: [{ id: 'e', likelihoods: { a: 0.9, b: 0.1 } }] },
      expect: { posterior: { a: 0.9, b: 0.1 } },
    }],
    async run(args) { return { ok: true, ...bayesUpdate(args) }; },
    format: (data) => Object.entries(data.posterior).map(([name, value]) => `${name}=${value.toFixed(3)}`).join(', '),
  },
  {
    name: 'omega.causal',
    title: 'Enumerate causal paths',
    description: 'Finds simple directed paths between two variables with depth and count bounds. Strength is a product of edge weights, not an effect size.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'causal', 'graph'],
    parameters: {
      type: 'object',
      properties: {
        edges: { type: 'array', items: { type: 'object' }, maxItems: 5000 },
        from: { type: 'string', minLength: 1 },
        to: { type: 'string', minLength: 1 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      required: ['edges', 'from', 'to'],
      additionalProperties: false,
    },
    examples: [{ args: { from: 'a', to: 'c', edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }, expect: { reached: true } }],
    async run(args) { return { ok: true, ...causalPaths(args) }; },
    format: (data) => `${data.paths.length} paths`,
  },
  {
    name: 'omega.intervals',
    title: 'Interval (Allen) relations',
    description: 'Relates two numeric intervals using Allen interval algebra, including inverse relations and durations.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'temporal', 'intervals'],
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] },
        b: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    examples: [{ args: { a: { start: 1, end: 2 }, b: { start: 3, end: 4 } }, expect: { relations: ['before'] } }],
    async run(args) { return { ok: true, ...intervalRelations(args.a, args.b) }; },
    format: (data) => data.relations.join(', '),
  },
  {
    name: 'omega.spatial',
    title: '2-D spatial relations',
    description: 'Overlap, touch, containment, overlap area and Euclidean distance for axis-aligned rectangles.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'spatial', 'geometry'],
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'object' },
        b: { type: 'object' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    examples: [{ args: { a: { x: 0, y: 0, w: 2, h: 2 }, b: { x: 1, y: 1, w: 2, h: 2 } }, expect: { overlap: true } }],
    async run(args) { return { ok: true, ...spatialRelations(args.a, args.b) }; },
    format: (data) => `${data.overlap ? 'overlap' : 'disjoint'}, distance ${data.distance}`,
  },
  {
    name: 'omega.decide',
    title: 'Expected-utility choice',
    description: 'Ranks options by weighted criteria and optional probabilities. Missing utilities are refused rather than guessed; uncertain results are labelled estimated.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'decision', 'utility'],
    parameters: {
      type: 'object',
      properties: {
        options: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 50 },
        criteria: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 20 },
        weights: { type: 'object' },
      },
      required: ['options', 'criteria'],
      additionalProperties: false,
    },
    examples: [{
      args: { options: [{ id: 'a', speed: 1 }, { id: 'b', speed: 2 }], criteria: [{ id: 'speed' }], weights: { speed: 1 } },
      expect: { winner: 'b' },
    }],
    async run(args) { return { ok: true, ...decide(args) }; },
    format: (data) => `${data.winner} (+${data.margin.toFixed(3)})`,
  },
  {
    name: 'omega.metacognize',
    title: 'Assess answer sufficiency',
    description: 'Combines verification, evidence counts, citations, tool failures, contradictions, ambiguity, answer shape and elapsed resources into a bounded action: proceed, qualify, gather, retry, clarify or stop.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'metacognition', 'verification', 'budget'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 20000, default: '' },
        model: { type: 'string', maxLength: 120 },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'research'], default: 'balanced' },
        brief: { type: 'object' },
        verification: { type: 'object' },
        evidence: { type: 'object' },
        toolLog: { type: 'array', items: { type: 'object' }, default: [] },
        conflicts: { type: 'array', items: { type: 'object' }, default: [] },
        citations: { type: 'array', items: {}, default: [] },
        elapsedMs: { type: 'number', minimum: 0, default: 0 },
        retryCount: { type: 'integer', minimum: 0, maximum: 5, default: 0 },
        budget: { type: 'object' },
      },
      additionalProperties: false,
    },
    examples: [{
      args: { text: 'A measured answer with enough words.', mode: 'balanced', verification: { ok: true, confidence: 0.9 } },
      expect: { action: 'proceed' },
    }],
    async run(args) {
      const result = new MetacognitiveController().assess(args);
      return { ok: true, ...result };
    },
    format: (data) => `${data.action} (${data.status}, ${data.issues.length} issues)`,
  },
  {
    name: 'omega.induce',
    title: 'Induce classification rules',
    description: 'Learns deterministic separate-and-conquer rules from labelled examples, reporting support and confidence. The result is explicitly estimated, not proof.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'induction', 'rules', 'learning'],
    parameters: {
      type: 'object',
      properties: {
        examples: { type: 'array', minItems: 2, maxItems: 5000, items: { type: 'object' } },
        target: { type: 'string', minLength: 1, maxLength: 80, default: 'class' },
        attributes: { type: 'array', items: { type: 'string' }, default: [] },
        minSupport: { type: 'integer', minimum: 1, maximum: 1000, default: 2 },
        minConfidence: { type: 'number', minimum: 0, maximum: 1, default: 0.6 },
        maxRules: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['examples'],
      additionalProperties: false,
    },
    examples: [{
      args: { examples: [{ shape: 'round', class: 'apple' }, { shape: 'round', class: 'apple' }, { shape: 'long', class: 'pepper' }], target: 'class', minSupport: 2 },
      expect: { status: 'estimated' },
    }],
    async run(args) {
      return { ok: true, ...induce(args) };
    },
    format: (data) => `${data.rules.length} induced rules (${data.status})`,
  },
  {
    name: 'omega.counterfactual',
    title: 'Evaluate a structural counterfactual',
    description: 'Applies do() to a linear acyclic structural causal model and compares the factual and counterfactual outcome. Reports that the effect is model-implied, never observed causation.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'causal', 'counterfactual', 'scm'],
    parameters: {
      type: 'object',
      properties: {
        variables: { type: 'object', description: 'name -> {parents, weights, bias, noise}' },
        observed: { type: 'object', default: {} },
        interventions: { type: 'object' },
        outcome: { type: 'string', maxLength: 120 },
        treatment: { type: 'string', maxLength: 120 },
      },
      required: ['variables', 'interventions'],
      additionalProperties: false,
    },
    examples: [{
      args: { variables: { rain: { parents: [] }, wet: { parents: ['rain'], weights: { rain: 1 } } }, observed: { rain: 0 }, interventions: { rain: 1 }, outcome: 'wet', treatment: 'rain' },
      expect: { delta: 1 },
    }],
    async run(args) {
      return { ok: true, ...counterfactual(args) };
    },
    format: (data) => `${data.outcome}: ${data.factualOutcome} -> ${data.counterfactualOutcome} (${data.identification})`,
  },
  {
    name: 'omega.bayesnet',
    title: 'Exact discrete Bayesian inference',
    description: 'Computes an exact posterior by enumerating a finite discrete Bayesian network. The result is proven relative to the supplied graph and CPTs.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'bayesian', 'graphical-model', 'uncertainty'],
    parameters: {
      type: 'object',
      properties: {
        nodes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object' } },
        query: { type: 'array', minItems: 1, items: { type: 'string' } },
        evidence: { type: 'object', default: {} },
        maxAssignments: { type: 'integer', minimum: 1, maximum: 1000000, default: 200000 },
      },
      required: ['nodes', 'query'],
      additionalProperties: false,
    },
    examples: [{
      args: { nodes: [{ name: 'x', values: ['a', 'b'], cpt: { '': { a: 0.5, b: 0.5 } } }], query: ['x'] },
      expect: { status: 'proven' },
    }],
    async run(args) {
      return { ok: true, ...bayesNetwork(args) };
    },
    format: (data) => `${data.query.join(',')} (${data.assignments} assignments)`,
  },
  {
    name: 'omega.optimize',
    title: 'Optimise under finite constraints',
    description: 'Branch-and-bound maximisation of a linear objective over a finite-domain CSP. Optimality is claimed only when the search space was exhausted.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'optimization', 'constraints', 'decision'],
    parameters: {
      type: 'object',
      properties: {
        variables: { type: 'object' },
        constraints: { type: 'array', items: { type: 'object' }, default: [] },
        objective: { type: 'object' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 1000000, default: 200000 },
      },
      required: ['variables', 'objective'],
      additionalProperties: false,
    },
    examples: [{
      args: { variables: { x: [1, 2], y: [1, 2] }, constraints: [{ vars: ['x', 'y'], op: 'neq' }], objective: { weights: { x: 1, y: 1 } } },
      expect: { optimal: true },
    }],
    async run(args) {
      return { ok: true, ...optimizeCsp(args) };
    },
    format: (data) => data.solution ? `score ${data.score} (${data.status})` : `no solution (${data.status})`,
  },
  {
    name: 'omega.plan',
    title: 'Hierarchical task-network planning',
    description: 'Expands methods into actions with preconditions/effects and verifies the goal by deterministic simulation. Failure is proof only when the search was exhausted.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'planning', 'htn', 'goals'],
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', minItems: 1, items: { type: 'string' } },
        methods: { type: 'array', items: { type: 'object' }, default: [] },
        actions: { type: 'object' },
        state: { type: 'object', default: {} },
        goal: { type: 'object' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 1000000, default: 5000 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 128, default: 32 },
      },
      required: ['tasks', 'actions', 'goal'],
      additionalProperties: false,
    },
    examples: [{
      args: { tasks: ['a'], actions: { a: { effects: { done: true } } }, goal: { done: true } },
      expect: { achieved: true },
    }],
    async run(args) {
      return { ok: true, ...hierarchicalPlan(args) };
    },
    format: (data) => data.achieved ? data.actions.join(' → ') : `no plan (${data.status})`,
  },
  {
    name: 'omega.graph',
    title: 'Bounded shortest-path search',
    description: 'Breadth-first, Dijkstra or A* search over non-negative weighted edges with an expansion budget and an honest optimality label.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'graph', 'search', 'shortest-path'],
    parameters: {
      type: 'object',
      properties: {
        edges: { type: 'array', minItems: 1, items: {} },
        start: { type: 'string', maxLength: 200 },
        goal: { type: 'string', maxLength: 200 },
        strategy: { type: 'string', enum: ['bfs', 'dijkstra', 'astar'], default: 'dijkstra' },
        heuristic: { type: 'object', default: {} },
        maxExpansions: { type: 'integer', minimum: 1, maximum: 1000000, default: 50000 },
      },
      required: ['edges', 'start', 'goal'],
      additionalProperties: false,
    },
    examples: [{
      args: { edges: [['a', 'b', 1], ['b', 'c', 1]], start: 'a', goal: 'c' },
      expect: { cost: 2 },
    }],
    async run(args) {
      return { ok: true, ...graphSearch(args) };
    },
    format: (data) => data.found ? `${data.path.join(' → ')} (${data.cost})` : 'no path',
  },
  {
    name: 'omega.prove',
    title: 'Prove a propositional formula',
    description: 'Classifies a formula as tautology, contradiction or contingent by exhaustive truth table over its supplied syntax.',
    category: 'cognitive',
    permission: 'read',
    tags: ['reasoning', 'logic', 'proof', 'verification'],
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'object' },
        maxVariables: { type: 'integer', minimum: 1, maximum: 20, default: 16 },
      },
      required: ['formula'],
      additionalProperties: false,
    },
    examples: [{
      args: { formula: { op: 'or', args: [{ op: 'var', name: 'p' }, { op: 'not', args: [{ op: 'var', name: 'p' }] }] } },
      expect: { kind: 'tautology' },
    }],
    async run(args) {
      return { ok: true, ...verifyPropositional(args) };
    },
    format: (data) => `${data.kind} (${data.assignments} assignments)`,
  },
  {
    name: 'cognitive.events',
    title: 'Inspect typed cognitive events',
    requires: ['cognitiveEvents'],
    description: 'Reads the bounded typed event stream produced by real blackboard mutations and run lifecycle events. Scope-isolated and provenance-preserving.',
    category: 'cognitive',
    permission: 'read',
    tags: ['cognition', 'events', 'observability', 'provenance'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'latest', 'stats'], default: 'latest' },
        scope: { type: 'string', maxLength: 128 },
        type: { type: 'string', maxLength: 80 },
        entryType: { type: 'string', maxLength: 40 },
        since: { type: 'number', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 20 },
      },
      additionalProperties: false,
    },
    examples: [{ args: { action: 'latest', limit: 5 }, expect: {} }],
    async run(args, ctx) {
      if (!ctx.cognitiveEvents) throw fail('NO_COGNITIVE_EVENTS', 'the cognitive event stream is not available');
      if (args.action === 'stats') return { ok: true, ...ctx.cognitiveEvents.stats(args.scope || null) };
      if (args.action === 'query') return { ok: true, events: ctx.cognitiveEvents.query(args) };
      return { ok: true, events: ctx.cognitiveEvents.latest({ scope: args.scope || null, limit: args.limit }) };
    },
    format: (data) => `${data.events ? data.events.length : data.buffered} event(s)`,
  },
  {
    name: 'cognitive.goals',
    title: 'Arbitrate competing goals',
    requires: ['goalArbiter'],
    description: 'Submits, lists, ranks and completes goals with dependencies, deadlines and bounded priority scoring. A dependent goal is never activated early.',
    category: 'cognitive',
    permission: 'write',
    tags: ['cognition', 'goals', 'arbitration', 'planning'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['submit', 'list', 'arbitrate', 'activation', 'complete', 'fail'], default: 'list' },
        id: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        scope: { type: 'string', maxLength: 128 },
        priority: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        deadline: { type: 'number', minimum: 0 },
        dependencies: { type: 'array', items: { type: 'string' }, default: [] },
        reason: { type: 'string', maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
      additionalProperties: false,
    },
    examples: [{ args: { action: 'list' }, expect: {} }],
    async run(args, ctx) {
      if (!ctx.goalArbiter) throw fail('NO_GOAL_ARBITER', 'goal arbitration is not available');
      const arbiter = ctx.goalArbiter;
      switch (args.action) {
        case 'submit':
          return { ok: true, goal: arbiter.submit({
            id: args.id || null,
            description: args.description,
            scope: args.scope || 'global',
            priority: args.priority,
            deadline: args.deadline === undefined ? null : args.deadline,
            dependencies: args.dependencies,
          }) };
        case 'arbitrate':
          return { ok: true, ...arbiter.arbitrate({ scope: args.scope || null, limit: args.limit }) };
        case 'activation':
          return { ok: true, ...arbiter.activationOrder({ scope: args.scope || null }) };
        case 'complete':
          if (!args.id) throw fail('NO_GOAL_ID', 'id is required');
          return { ok: true, goal: arbiter.complete(args.id) };
        case 'fail':
          if (!args.id) throw fail('NO_GOAL_ID', 'id is required');
          return { ok: true, goal: arbiter.fail(args.id, args.reason || null) };
        default:
          return { ok: true, goals: arbiter.list({ scope: args.scope || null }), arbitration: arbiter.arbitrate({ scope: args.scope || null, limit: args.limit }) };
      }
    },
    format: (data) => data.goals ? `${data.goals.length} goal(s)` : data.goal ? `${data.goal.id}:${data.goal.status}` : `${data.ranking.length} ready`,
  },

];
