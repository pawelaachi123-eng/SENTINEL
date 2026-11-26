'use strict';

/** Typed cognitive-state tools. They expose real state, never hidden thoughts. */

function core(ctx) {
  if (!ctx.hypercore) throw Object.assign(new Error('the cognitive hypercore is not available'), { code: 'NO_HYPERCORE' });
  return ctx.hypercore;
}

module.exports = [
  {
    name: 'hypercore.status',
    title: 'Cognitive hypercore status',
    description: 'Counts of typed goals, beliefs, evidence, hypotheses, constraints, rules and open contradictions, attention budget and usage. It reports state, not consciousness.',
    category: 'reasoning', permission: 'read', tags: ['cognition', 'goals', 'beliefs', 'attention', 'budget'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...core(ctx).status() }; },
    format: (data) => `${data.counts.goals} celów, ${data.counts.beliefs} przekonań, ${data.counts.openConflicts} sprzeczności`,
  },
  {
    name: 'hypercore.goals',
    title: 'List typed goals',
    description: 'Returns goals with priority, deadline, status, acceptance criteria and provenance.',
    category: 'reasoning', permission: 'read', tags: ['cognition', 'goals', 'planning'],
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'active', 'blocked', 'done', 'failed', 'cancelled'] } }, additionalProperties: false },
    async run(args, ctx) {
      const result = core(ctx).inspect('goal');
      const goals = args.status ? result.items.filter((goal) => goal.status === args.status) : result.items;
      return { ok: true, goals };
    },
    format: (data) => `${data.goals.length} celów`,
  },
  {
    name: 'hypercore.add_goal',
    title: 'Register a goal',
    description: 'Adds a typed goal with priority, optional ISO deadline and acceptance criteria. This is durable state, not a promise that the goal will be completed.',
    category: 'reasoning', permission: 'write', tags: ['cognition', 'goals', 'planning'],
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 1000 },
        priority: { type: 'number', minimum: 0, maximum: 1 },
        deadline: { type: 'string', maxLength: 40 },
        acceptance: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 500 } },
        status: { type: 'string', enum: ['pending', 'active'] },
      },
      required: ['description'], additionalProperties: false,
    },
    async run(args, ctx) {
      try { return { ok: true, goal: core(ctx).addGoal(args) }; } catch (err) { return { ok: false, code: err.code || 'BAD_GOAL', message: err.message }; }
    },
    format: (data) => (data.ok ? `cel ${data.goal.id}` : data.code),
  },
  {
    name: 'hypercore.observe',
    title: 'Record evidence and a belief',
    description: 'Stores untrusted evidence separately from a belief and records a contradiction instead of overwriting an incompatible existing belief. Confidence is explicit.',
    category: 'reasoning', permission: 'write', tags: ['cognition', 'beliefs', 'evidence', 'conflict'],
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', minLength: 1, maxLength: 2000 },
        key: { type: 'string', maxLength: 120 },
        value: {},
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        source: { type: 'string', maxLength: 300 },
        evidence: { type: 'string', maxLength: 4000 },
        trust: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['statement'], additionalProperties: false,
    },
    async run(args, ctx) {
      try {
        const hypercore = core(ctx);
        const evidence = args.evidence ? hypercore.addEvidence({ content: args.evidence, source: args.source || 'tool', trust: args.trust ?? 0.4, untrusted: true }) : null;
        const result = hypercore.addBelief({ statement: args.statement, key: args.key || null, value: args.value, confidence: args.confidence ?? 0.5, source: args.source || 'tool', evidenceIds: evidence ? [evidence.id] : [] });
        return { ok: true, belief: result.belief, evidence, conflicts: result.conflicts };
      } catch (err) { return { ok: false, code: err.code || 'BAD_BELIEF', message: err.message }; }
    },
    format: (data) => (data.ok ? `${data.belief.id}${data.conflicts.length ? `, ${data.conflicts.length} konfliktów` : ''}` : data.code),
  },
  {
    name: 'hypercore.conflicts',
    title: 'Open contradictions',
    description: 'Lists contradictory beliefs side by side with both sources and confidences. Nothing is auto-resolved.',
    category: 'reasoning', permission: 'read', tags: ['cognition', 'conflict', 'verification'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const result = core(ctx).inspect('conflict');
      return { ok: true, conflicts: result.items.filter((conflict) => conflict.status === 'open') };
    },
    format: (data) => `${data.conflicts.length} otwartych sprzeczności`,
  },
  {
    name: 'hypercore.attention',
    title: 'Rank attention candidates',
    description: 'Deterministic softmax over goal priority/deadline, belief uncertainty, contradictions and hard constraints, with provenance and weights. Hard constraints cannot be dropped by focus.',
    category: 'reasoning', permission: 'read', tags: ['cognition', 'attention', 'priority'],
    parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 30 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, items: core(ctx).attention({ limit: args.limit || 8 }) }; },
    format: (data) => `${data.items.length} kandydatów`,
  },
  {
    name: 'hypercore.focus',
    title: 'Fit attention to a context budget',
    description: 'Selects attention candidates under a token budget using a characters/4 estimate, records a trace and always keeps hard constraints.',
    category: 'reasoning', permission: 'read', tags: ['cognition', 'attention', 'budget', 'context'],
    parameters: { type: 'object', properties: { tokenBudget: { type: 'number', minimum: 64, maximum: 8192 }, limit: { type: 'number', minimum: 1, maximum: 30 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...core(ctx).focus({ tokenBudget: args.tokenBudget || core(ctx).budgets.contextTokens, limit: args.limit || core(ctx).budgets.attentionItems, reason: 'tool' }) }; },
    format: (data) => `${data.items.length} elementów, ~${data.trace.estimatedTokens} tokenów (szacunek)`,
  },
  {
    name: 'hypercore.deduce',
    title: 'Bounded forward chaining',
    description: 'Applies explicit Horn-style rules to active beliefs, derives only what follows, records contradictions and stops at the iteration bound. It never invents a premise.',
    category: 'reasoning', permission: 'write', tags: ['cognition', 'deduction', 'rules', 'logic'],
    parameters: { type: 'object', properties: { maxIterations: { type: 'number', minimum: 1, maximum: 8 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...core(ctx).deduce({ maxIterations: args.maxIterations || 4 }) }; },
    format: (data) => `${data.derived.length} nowych przekonań`,
  },
  {
    name: 'hypercore.hypothesize',
    title: 'Propose a hypothesis',
    description: 'Adds a candidate explanation with an explicit prior. It is a hypothesis, not a fact, and posteriors are updated only by supplied support/contradiction counts.',
    category: 'reasoning', permission: 'write', tags: ['cognition', 'hypothesis', 'abduction', 'uncertainty'],
    parameters: {
      type: 'object',
      properties: { statement: { type: 'string', minLength: 1, maxLength: 1000 }, prior: { type: 'number', minimum: 0.01, maximum: 0.99 }, predicts: { type: 'array', maxItems: 10, items: { type: 'string' } } },
      required: ['statement'], additionalProperties: false,
    },
    async run(args, ctx) {
      const result = core(ctx).addHypothesis(args);
      return result.ok === false ? result : { ok: true, hypothesis: result };
    },
    format: (data) => (data.ok ? `hipoteza ${data.hypothesis.id} (prior ${data.hypothesis.prior})` : data.code),
  },
  {
    name: 'hypercore.resolve_conflict',
    title: 'Resolve a contradiction with approval',
    description: 'Explicitly accepts one side, keeps both or dismisses a contradiction. Accepting a side requires a consumed human approval and preserves the loser as superseded.',
    category: 'reasoning', permission: 'system', tags: ['cognition', 'conflict', 'approval'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, resolution: { type: 'string', enum: ['accepted-left', 'accepted-right', 'kept-both', 'dismissed'] }, note: { type: 'string', maxLength: 1000 } },
      required: ['id', 'resolution'], additionalProperties: false,
    },
    async run(args, ctx) {
      const operator = ctx.approval && (ctx.approval.by || ctx.approval.requestedBy || `approval:${ctx.approval.id}`);
      if (!operator && args.resolution !== 'kept-both') return { ok: false, code: 'APPROVAL_REQUIRED', message: 'resolving a conflict needs a consumed approval' };
      return core(ctx).resolveConflict(args.id, { resolution: args.resolution, approvedBy: operator, note: args.note });
    },
    format: (data) => (data.ok ? data.conflict.resolution : data.code),
  },
];
