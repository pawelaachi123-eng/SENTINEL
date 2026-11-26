'use strict';

/**
 * Executive scheduler tools: worker-pool jobs and durable DAG workflows.
 *
 * A workflow run is executed inside the tool call, so the tool timeout bounds
 * it. Every step is recorded before and after it runs. Tool steps go through the
 * same permission, approval and audit path as any other tool call. Agent steps
 * are rejected unless the caller supplies a runner; there is no hidden model
 * invocation.
 */

function executive(ctx) {
  if (!ctx.executive) throw Object.assign(new Error('the executive engine is not available'), { code: 'NO_EXECUTIVE' });
  return ctx.executive;
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw Object.assign(new Error('steps are required'), { code: 'BAD_STEPS' });
  return steps.map((step) => ({
    id: String(step.id || ''),
    tool: step.agent ? null : String(step.tool || ''),
    agent: step.agent ? String(step.agent) : null,
    args: step.args && typeof step.args === 'object' ? step.args : {},
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
    maxRetries: step.maxRetries,
    deadlineMs: step.deadlineMs,
  }));
}

module.exports = [
  {
    name: 'executive.status',
    title: 'Executive scheduler status',
    description: 'Worker pool, queue, workflow counts and honest scheduler counters.',
    category: 'orchestration',
    permission: 'read',
    tags: ['executive', 'scheduler', 'workflow', 'queue'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) { return { ok: true, ...executive(ctx).status() }; },
    format: (data) => `pula: ${data.pool.running}/${data.pool.size}, kolejka ${data.pool.queued}; workflow ${JSON.stringify(data.workflows.counts)}`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'executive.submit',
    title: 'Submit a worker job',
    description: 'Submits a bounded job with priority, deadline, retries and an optional idempotency key.',
    category: 'orchestration',
    permission: 'write',
    tags: ['executive', 'queue', 'idempotency'],
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', minLength: 1, maxLength: 40 },
        payload: { type: 'object' },
        priority: { type: 'integer', minimum: 1, maximum: 9, default: 5 },
        deadlineMs: { type: 'integer', minimum: 50, maximum: 600000 },
        maxRetries: { type: 'integer', minimum: 0, maximum: 6, default: 0 },
        idempotencyKey: { type: 'string', maxLength: 120 },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const engine = executive(ctx);
      engine.start();
      return { ok: true, ...engine.submit(args) };
    },
    format: (data) => (data.ok ? `${data.id} · ${data.status}${data.deduplicated ? ' (deduplicated)' : ''}` : data.code),
  },
  {
    name: 'executive.jobs',
    title: 'List worker jobs',
    description: 'Recent jobs with attempts, checkpoints, deadlines, errors and recovery flags.',
    category: 'orchestration',
    permission: 'read',
    tags: ['executive', 'queue'],
    parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 } }, additionalProperties: false },
    async run(args, ctx) { return { ok: true, jobs: executive(ctx).pool.list({ status: args.status || null, limit: args.limit }) }; },
    format: (data) => `${data.jobs.length} zadań`,
    examples: [{ args: {}, expect: { ok: true } }],
  },
  {
    name: 'executive.cancel',
    title: 'Cancel a worker job',
    description: 'Aborts a queued or running job through its AbortController.',
    category: 'orchestration',
    permission: 'write',
    tags: ['executive', 'cancel'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
    async run(args, ctx) { return executive(ctx).pool.cancel(args.id); },
    format: (data) => (data.ok ? `anulowano ${data.id}` : data.code),
  },
  {
    name: 'executive.workflow_create',
    title: 'Create a durable workflow',
    description: 'Validates a DAG (ids, dependencies, cycles), budgets and per-step retries, then persists it before execution.',
    category: 'orchestration',
    permission: 'write',
    tags: ['workflow', 'dag', 'durability'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 80, default: 'workflow' },
        steps: { type: 'array', minItems: 1, maxItems: 64 },
        budget: { type: 'object' },
        idempotencyKey: { type: 'string', maxLength: 120 },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const workflow = executive(ctx).workflows.create({ name: args.name, steps: validateSteps(args.steps), budget: args.budget || {}, idempotencyKey: args.idempotencyKey || null });
      return { ok: true, ...workflow };
    },
    format: (data) => (data.ok ? `${data.id} · ${data.steps.length} kroków` : data.code),
  },
  {
    name: 'executive.workflow_run',
    title: 'Run a durable workflow',
    description: 'Executes a stored DAG. Tool steps go through the audited tool registry; agent steps are refused unless a runner is supplied.',
    category: 'orchestration',
    permission: 'system',
    tags: ['workflow', 'dag', 'tools'],
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        concurrency: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const engine = executive(ctx);
      const workflow = engine.workflows.get(args.id);
      if (!workflow) return { ok: false, code: 'NOT_FOUND', message: `no workflow ${args.id}` };
      const result = await engine.workflows.run(args.id, {
        concurrency: args.concurrency,
        signal: ctx.signal,
        invoke: async (step, context) => {
          if (step.agent) throw Object.assign(new Error(`agent step ${step.id} has no runner in this surface`), { code: 'NO_AGENT_RUNNER' });
          if (!ctx.registry || typeof ctx.registry.execute !== 'function') throw Object.assign(new Error('the tool registry is unavailable'), { code: 'NO_REGISTRY' });
          const outcome = await ctx.registry.execute(step.tool, step.args, { source: 'workflow', signal: context.signal, sessionId: ctx.sessionId });
          if (!outcome.ok) throw Object.assign(new Error(outcome.message || outcome.code || 'tool failed'), { code: outcome.code || 'TOOL_FAILED' });
          return { tool: step.tool, data: outcome.data };
        },
      });
      return { ok: result.status === 'done', workflow: result };
    },
    format: (data) => (data.ok ? `${data.workflow.id}: ${data.workflow.steps.filter((step) => step.status === 'done').length}/${data.workflow.steps.length} gotowych` : `${data.code || 'failed'}`),
  },
  {
    name: 'executive.workflow_status',
    title: 'Workflow status',
    description: 'Full persisted workflow state, usage against budget and replan history.',
    category: 'orchestration',
    permission: 'read',
    tags: ['workflow', 'durability'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
    async run(args, ctx) {
      const workflow = executive(ctx).workflows.get(args.id);
      if (!workflow) return { ok: false, code: 'NOT_FOUND' };
      return { ok: true, workflow: executive(ctx).workflows.snapshot(workflow) };
    },
    format: (data) => (data.ok ? `${data.workflow.status} · ${data.workflow.usage.steps}/${data.workflow.budget.steps}` : data.code),
  },
  {
    name: 'executive.workflow_cancel',
    title: 'Cancel a workflow',
    description: 'Cancels a workflow and aborts its running steps. Completed steps stay recorded.',
    category: 'orchestration',
    permission: 'write',
    tags: ['workflow', 'cancel'],
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
    async run(args, ctx) { return executive(ctx).workflows.cancel(args.id); },
    format: (data) => (data.ok ? `anulowano ${data.id}` : data.code),
  },
  {
    name: 'executive.stop_all',
    title: 'Stop all executive work',
    description: 'Cancels every queued/running job and workflow. Used by the STOP path.',
    category: 'orchestration',
    permission: 'system',
    tags: ['executive', 'stop', 'cancel'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const result = await executive(ctx).stop('stopped by the user');
      return { ok: true, ...result };
    },
    format: (data) => `zatrzymano: ${data.pool.counts.cancelled || 0} zadań, ${data.workflows.counts.cancelled || 0} workflow`,
  },
];
