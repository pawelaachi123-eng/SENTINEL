'use strict';

/**
 * Task and automation tools. A task is a plan with state; an automation is a
 * schedule. Both are visible in the UI, both can be stopped, and neither can
 * quietly change the machine.
 */

module.exports = [
  {
    name: 'task.create',
    title: 'Create a task',
    description: 'Record a goal with ordered steps and dependencies, so progress can be tracked and cancelled.',
    category: 'tasks',
    permission: 'write',
    tags: ['task', 'plan', 'todo'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 160 },
        goal: { type: 'string', maxLength: 2000 },
        steps: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 200 },
              agent: { type: 'string', maxLength: 40 },
              dependsOn: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
        priority: { type: 'integer', default: 3, minimum: 1, maximum: 5 },
        timeoutMs: { type: 'integer', default: 600000, minimum: 5000, maximum: 3600000 },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.tasks) throw Object.assign(new Error('task tracking is not available'), { code: 'NO_TASKS' });
      const task = ctx.tasks.create({ ...args, sessionId: ctx.sessionId || null });
      return { id: task.id, title: task.title, steps: task.steps.length, status: task.status };
    },
  },
  {
    name: 'task.list',
    title: 'List tasks',
    description: 'Tasks with status and progress; filter by state.',
    category: 'tasks',
    permission: 'read',
    tags: ['task', 'list'],
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'planning', 'running', 'waiting_approval', 'verifying', 'done', 'failed', 'cancelled', 'timeout'] },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { tasks: ctx.tasks ? ctx.tasks.list({ status: args.status || null, limit: args.limit }) : [] };
    },
  },
  {
    name: 'task.get',
    title: 'Task detail',
    description: 'Full task record: steps, their state, results and timing.',
    category: 'tasks',
    permission: 'read',
    tags: ['task', 'status'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const task = ctx.tasks ? ctx.tasks.get(args.id) : null;
      if (!task) throw Object.assign(new Error(`no task ${args.id}`), { code: 'NOT_FOUND' });
      return task;
    },
  },
  {
    name: 'task.cancel',
    title: 'Cancel a task',
    description: 'Stop a running or pending task and mark its unfinished steps as cancelled.',
    category: 'tasks',
    permission: 'write',
    tags: ['task', 'cancel'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const ok = ctx.tasks ? ctx.tasks.cancel(args.id, 'cancelled by request') : false;
      if (!ok) throw Object.assign(new Error('that task is unknown or already finished'), { code: 'NOT_FOUND' });
      return { cancelled: args.id };
    },
  },
  {
    name: 'task.verify',
    title: 'Verify a task',
    description: 'Check whether every step of a finished task actually succeeded and produced a result.',
    category: 'tasks',
    permission: 'read',
    tags: ['task', 'verify'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const task = ctx.tasks ? ctx.tasks.get(args.id) : null;
      if (!task) throw Object.assign(new Error(`no task ${args.id}`), { code: 'NOT_FOUND' });
      const issues = [];
      for (const step of task.steps) {
        if (step.status !== 'done') issues.push(`${step.title}: ${step.status}${step.error ? ` (${step.error})` : ''}`);
        else if (step.result == null) issues.push(`${step.title}: done without a result`);
      }
      return { id: task.id, status: task.status, steps: task.steps.length, issues, verified: issues.length === 0 };
    },
  },
  {
    name: 'automation.create',
    title: 'Create an automation',
    description: 'Run a prompt or command every N minutes, or daily at a time.',
    category: 'automation',
    permission: 'write',
    tags: ['automation', 'schedule', 'recurring'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3, maxLength: 120 },
        type: { type: 'string', enum: ['interval', 'daily'], default: 'interval' },
        everyMinutes: { type: 'integer', default: 60, minimum: 5, maximum: 10080 },
        at: { type: 'string', maxLength: 5, description: 'HH:MM for daily triggers' },
        action: { type: 'string', enum: ['prompt', 'command'], default: 'prompt' },
        prompt: { type: 'string', maxLength: 2000 },
        command: { type: 'string', maxLength: 120 },
        enabled: { type: 'boolean', default: true },
      },
      required: ['name'],
      additionalProperties: false,
    },
    guard(args) {
      if (args.action === 'prompt' && !args.prompt) return { ok: false, code: 'BAD_ARGS', message: 'give a prompt for a prompt automation' };
      if (args.action === 'command' && !args.command) return { ok: false, code: 'BAD_ARGS', message: 'give a command for a command automation' };
      return { ok: true };
    },
    async run(args, ctx) {
      if (!ctx.automation) throw Object.assign(new Error('automations are not available'), { code: 'NO_AUTOMATION' });
      const item = ctx.automation.create({
        name: args.name,
        trigger: { type: args.type, everyMinutes: args.everyMinutes, at: args.at },
        action: { type: args.action, prompt: args.prompt, command: args.command },
        enabled: args.enabled,
      });
      return { id: item.id, name: item.name, trigger: item.trigger, enabled: item.enabled, nextRunAt: item.nextRunAt || null };
    },
  },
  {
    name: 'automation.list',
    title: 'List automations',
    description: 'Scheduled automations with trigger, last result and run counts.',
    category: 'automation',
    permission: 'read',
    tags: ['automation', 'list'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return { automations: ctx.automation ? ctx.automation.list() : [] };
    },
  },
  {
    name: 'automation.toggle',
    title: 'Enable or pause an automation',
    description: 'Turn a scheduled automation on or off without deleting it.',
    category: 'automation',
    permission: 'write',
    tags: ['automation', 'pause'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 }, enabled: { type: 'boolean' } },
      required: ['id', 'enabled'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.automation) throw Object.assign(new Error('automations are not available'), { code: 'NO_AUTOMATION' });
      const item = ctx.automation.toggle(args.id, args.enabled);
      return { id: item.id, enabled: item.enabled };
    },
  },
  {
    name: 'automation.run',
    title: 'Run an automation now',
    description: 'Trigger a scheduled automation immediately (useful for testing).',
    category: 'automation',
    permission: 'write',
    tags: ['automation', 'run'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    timeoutMs: 180000,
    async run(args, ctx) {
      if (!ctx.automation) throw Object.assign(new Error('automations are not available'), { code: 'NO_AUTOMATION' });
      return ctx.automation.run(args.id, { trigger: 'manual' });
    },
  },
  {
    name: 'automation.delete',
    title: 'Delete an automation',
    description: 'Remove a scheduled automation permanently.',
    category: 'automation',
    permission: 'write',
    tags: ['automation', 'delete'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, maxLength: 80 } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const removed = ctx.automation ? ctx.automation.remove(args.id) : false;
      if (!removed) throw Object.assign(new Error(`no automation ${args.id}`), { code: 'NOT_FOUND' });
      return { deleted: args.id };
    },
  },
  {
    name: 'automation.stats',
    title: 'Automation statistics',
    description: 'How many automations exist, how often they ran and what the last runs did.',
    category: 'automation',
    permission: 'read',
    tags: ['automation', 'stats'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return ctx.automation ? ctx.automation.stats() : { automations: 0 };
    },
  },
];
