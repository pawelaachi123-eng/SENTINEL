'use strict';

/**
 * The execution engine: it connects the durable DAG in `tasks.js` to the agents,
 * tools and approvals that actually do the work.
 *
 * Properties that matter more than throughput:
 *
 *   • **Every transition is persisted before the next step starts.** A crash
 *     leaves a task that can be reconciled, not a half-truth.
 *   • **Side effects are never blind-retried.** Only read-only steps (or steps
 *     explicitly marked idempotent) may be retried or run concurrently; a write
 *     is serialised and, if it fails after its attempt budget, the subgraph is
 *     marked failed rather than replayed.
 *   • **Cancellation goes all the way down.** One AbortController per step,
 *     linked to the caller's signal, reaches tools and providers.
 *   • **Approvals pause, they do not bypass.** A step that needs an approval is
 *     parked in `waiting_approval`, the executor waits on the queue, and the
 *     approval is consumed for that exact call. A timeout fails the step; it
 *     never proceeds.
 *   • **Replanning is bounded and additive.** A failed step can be replaced by
 *     a new subgraph; completed results are preserved and duplicate ids are
 *     rejected.
 */

const RETRYABLE = new Set(['TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'ALL_FAILED', 'UNREACHABLE', 'HTTP_ERROR', 'INVALID_OUTPUT', 'TOOL_TIMEOUT']);
const FATAL = new Set(['APPROVAL_DENIED', 'APPROVAL_TIMEOUT', 'PERMISSION_DENIED', 'PROTECTED', 'UNKNOWN_TOOL', 'BAD_ARGS', 'BAD_PATH', 'OUTSIDE_SANDBOX', 'TOOL_DISABLED', 'NETWORK_DISABLED', 'CANCELLED']);

const DEFAULTS = {
  concurrency: 2,
  maxSteps: 24,
  maxModelCalls: 8,
  maxToolCalls: 24,
  maxMs: 120000,
  approvalTimeoutMs: 120000,
  maxReplans: 1,
};

function isRetryable(code) {
  if (!code) return false;
  if (FATAL.has(code)) return false;
  return RETRYABLE.has(code) || /^(E_|ECONN|ETIMEDOUT|ENOTFOUND)/.test(code);
}

class Executor {
  constructor({ tasks, dispatcher, tools = null, approvals = null, agents = null, events = null, metrics = null, experience = null, log = null, now = () => Date.now(), config = null, replanner = null }) {
    this.tasks = tasks;
    this.dispatcher = dispatcher;
    this.tools = tools;
    this.approvals = approvals;
    this.agents = agents;
    this.events = events;
    this.metrics = metrics;
    this.experience = experience;
    this.log = log;
    this.now = now;
    this.config = config;
    this.replanner = replanner;
    this.children = new Map(); // taskId → Set<AbortController>
    this.counters = { runs: 0, steps: 0, failures: 0, replans: 0, cancellations: 0, approvalsWaited: 0, budgetStops: 0 };
  }

  defaults(overrides = {}) {
    const configured = (this.config && this.config.get && this.config.get('ai.execution')) || {};
    return { ...DEFAULTS, ...configured, ...overrides };
  }

  childController(taskId, parentSignal) {
    const controller = new AbortController();
    const set = this.children.get(taskId) || new Set();
    set.add(controller);
    this.children.set(taskId, set);
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason || Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
      else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason || Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
    }
    return controller;
  }

  abortTask(taskId) {
    const set = this.children.get(taskId);
    if (!set) return 0;
    let aborted = 0;
    for (const controller of set) {
      if (!controller.signal.aborted) {
        controller.abort(Object.assign(new Error('task cancelled'), { code: 'CANCELLED' }));
        aborted += 1;
      }
    }
    return aborted;
  }

  /* ── plan validation ─────────────────────────────────────────────────── */

  /** Rejects plans whose steps cannot run here: unknown agents/tools, missing budgets. */
  validatePlan(steps, { question = null, budget = {} } = {}) {
    const errors = [];
    const list = Array.isArray(steps) ? steps : [];
    const limits = this.defaults(budget);
    if (list.length > limits.maxSteps) errors.push(`plan has ${list.length} steps, limit is ${limits.maxSteps}`);
    for (const step of list) {
      if (!step || !step.id) continue;
      if (step.agent && this.agents && !this.agents.agents.has(step.agent)) errors.push(`step ${step.id} uses unknown agent ${step.agent}`);
      if (step.tool && this.tools && !this.tools.tools.has(step.tool)) errors.push(`step ${step.id} uses unknown tool ${step.tool}`);
      if (step.tool && !step.args) step.args = {};
      if (!step.tool && !step.agent && !step.title && !step.goal) errors.push(`step ${step.id} has nothing to do`);
      const perStepMs = Number(step.timeoutMs) || limits.maxMs;
      if (perStepMs <= 0 || perStepMs > 30 * 60 * 1000) errors.push(`step ${step.id} has an implausible timeout`);
    }
    // Budget feasibility: a plan cannot ask for more model calls than the run allows.
    const modelSteps = list.filter((step) => !step.tool).length;
    if (modelSteps > limits.maxModelCalls) errors.push(`plan needs ${modelSteps} model calls, budget is ${limits.maxModelCalls}`);
    return { ok: errors.length === 0, errors, question };
  }

  /** A small, explicit condition language; no eval and no model-generated code. */
  evaluateWhen(condition, results) {
    if (!condition) return true;
    if (typeof condition === 'boolean') return condition;
    if (typeof condition === 'string') {
      if (condition === 'true') return true;
      if (condition === 'false') return false;
      return Object.prototype.hasOwnProperty.call(results, condition) && Boolean(results[condition]);
    }
    if (typeof condition !== 'object') return true;
    if (Array.isArray(condition.all)) return condition.all.every((entry) => this.evaluateWhen(entry, results));
    if (Array.isArray(condition.any)) return condition.any.some((entry) => this.evaluateWhen(entry, results));
    if (condition.not) return !this.evaluateWhen(condition.not, results);
    const value = condition.step ? results[condition.step] : condition.value;
    const picked = condition.path && value && typeof value === 'object' ? condition.path.split('.').reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), value) : value;
    const op = condition.op || (condition.equals !== undefined ? 'eq' : condition.exists !== undefined ? 'exists' : 'eq');
    if (op === 'exists') return (picked !== undefined && picked !== null) === (condition.exists !== false);
    if (op === 'eq') return picked === condition.value;
    if (op === 'neq') return picked !== condition.value;
    if (op === 'truthy') return Boolean(picked);
    if (op === 'falsy') return !picked;
    if (op === 'contains') return Array.isArray(picked) ? picked.includes(condition.value) : String(picked ?? '').includes(String(condition.value));
    if (op === 'gte') return Number(picked) >= Number(condition.value);
    if (op === 'lte') return Number(picked) <= Number(condition.value);
    return false;
  }

  /** Classification used for concurrency and retry decisions. */
  classify(step) {
    if (step.tool) {
      const tool = this.tools && this.tools.tools.get(step.tool);
      const permission = tool ? tool.permission : 'write';
      return {
        kind: 'tool',
        readOnly: permission === 'read' || permission === 'network',
        idempotent: step.idempotent === true || (tool && tool.idempotent === true),
        permission,
      };
    }
    return { kind: 'agent', readOnly: false, idempotent: step.idempotent === true, permission: 'model' };
  }

  /* ── one step ────────────────────────────────────────────────────────── */

  async runStep({ taskId, step, runtime, limits, signal, results = {} }) {
    const controller = this.childController(taskId, signal);
    const started = this.now();
    const classification = this.classify(step);
    const stepRuntime = this.dispatcher.createRuntime({
      text: step.goal || step.title,
      mode: runtime ? runtime.mode : 'balanced',
      sessionId: runtime ? runtime.sessionId : 'default',
      runId: runtime ? runtime.runId : null,
      signal: controller.signal,
      onToken: null,
      images: runtime ? runtime.images : null,
      history: runtime ? runtime.history : [],
      contextBlock: [
        runtime ? runtime.contextBlock : '',
        step.acceptanceCriteria ? `Kryteria akceptacji kroku: ${[].concat(step.acceptanceCriteria).join('; ')}` : '',
        step.inputs ? `Dane wejściowe: ${JSON.stringify(step.inputs).slice(0, 1200)}` : '',
      ].filter(Boolean).join('\n'),
      language: runtime ? runtime.language : 'auto',
    });

    if (!step.tool) {
      const agent = step.agent && this.agents ? this.agents.agents.get(step.agent) : this.dispatcher.route(step.goal || step.title).primary;
      if (!agent) throw Object.assign(new Error(`no agent for ${step.title}`), { code: 'UNKNOWN_AGENT' });
      const result = await this.dispatcher.runAgent(agent, stepRuntime, { onStage: null });
      return {
        ok: Boolean(result && result.ok && String(result.text || '').trim()),
        text: result ? String(result.text || '') : '',
        agent: agent.name,
        agentTitle: agent.title,
        model: result ? result.model : null,
        provider: result ? result.provider : null,
        usage: result ? result.usage : null,
        toolsUsed: (result && result.toolsUsed) || [],
        data: (result && result.data) || null,
        code: result && result.ok ? null : (result && result.code) || 'EMPTY_ANSWER',
        ms: this.now() - started,
      };
    }

    const args = { ...(step.args || {}) };
    // Typed inputs: values produced by an earlier step are injected by name.
    if (step.inputs && typeof step.inputs === 'object') {
      for (const [key, source] of Object.entries(step.inputs)) {
        if (typeof source === 'string' && source.startsWith('$')) {
          const reference = source.slice(1);
          const value = results[reference];
          if (value !== undefined) args[key] = value;
        }
      }
    }
    const toolCall = (approvalId = null) => this.tools.execute(step.tool, args, {
      source: 'executor',
      sessionId: runtime ? runtime.sessionId : null,
      signal: controller.signal,
      approvalId,
      runId: runtime ? runtime.runId : null,
    });

    let result = await toolCall(null);
    if (!result.ok && result.code === 'APPROVAL_REQUIRED' && result.approval) {
      this.counters.approvalsWaited += 1;
      this.tasks.setState(taskId, 'waiting_approval', `${step.id}:${result.approval.id}`);
      this.emit(taskId, 'approval-required', { step: step.id, approval: result.approval.id, tool: step.tool });
      const decided = this.approvals ? await this.approvals.wait(result.approval.id, Math.min(limits.approvalTimeoutMs, 10 * 60 * 1000)) : null;
      this.tasks.setState(taskId, 'running', null);
      if (!decided) {
        return { ok: false, code: 'APPROVAL_TIMEOUT', text: '', message: 'the approval expired or was never answered', approvalId: result.approval.id, ms: this.now() - started };
      }
      if (decided.status !== 'approved' && decided.approvedByUser !== true) {
        return { ok: false, code: 'APPROVAL_DENIED', text: '', message: 'the user denied this step', approvalId: result.approval.id, ms: this.now() - started };
      }
      result = await toolCall(result.approval.id);
    }

    return {
      ok: Boolean(result.ok),
      text: result.text ? String(result.text) : result.data ? JSON.stringify(result.data).slice(0, 4000) : '',
      data: result.data || null,
      tool: step.tool,
      code: result.code || null,
      message: result.message || null,
      ms: this.now() - started,
      readOnly: classification.readOnly,
    };
  }

  emit(taskId, action, detail = {}) {
    if (!this.events) return;
    try {
      this.events.publish('execution', { taskId, action, ...detail }, { correlationId: taskId });
    } catch {
      /* the event log must never break execution */
    }
  }

  /* ── the loop ────────────────────────────────────────────────────────── */

  /**
   * Executes a task to completion, cancellation or budget exhaustion.
   * @returns {{ok, status, taskId, steps: Array, results: Object, counters, error}}
   */
  async run(taskId, { runtime = null, signal = null, budget = {}, replan = true, question = null } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw Object.assign(new Error(`no task ${taskId}`), { code: 'NOT_FOUND' });
    const limits = this.defaults(budget);
    const counters = { steps: 0, modelCalls: 0, toolCalls: 0, retries: 0, replans: 0, failed: 0 };
    const started = this.now();
    const results = {};
    this.counters.runs += 1;
    if (task.status === 'pending') this.tasks.start(taskId);
    if (!['running', 'paused'].includes(task.status)) {
      return { ok: false, status: task.status, taskId, steps: [], results, counters, error: `task is ${task.status}` };
    }
    const controller = this.childController(taskId, signal);
    this.emit(taskId, 'started', { steps: task.steps.length, concurrency: limits.concurrency });

    const finish = (status, error = null) => {
      if (!error) {
        const failedSteps = this.tasks.get(taskId).steps.filter((step) => step.status === 'failed');
        if (failedSteps.length) error = `steps failed: ${failedSteps.map((step) => `${step.id} (${(step.error || 'failed').slice(0, 80)})`).join(', ')}`;
      }
      const current = this.tasks.get(taskId);
      if (current && !['done', 'failed', 'cancelled', 'timeout'].includes(current.status)) {
        this.tasks.finish(taskId, {
          status,
          error,
          result: { steps: this.tasks.get(taskId).steps.map((step) => ({ id: step.id, title: step.title, status: step.status, ok: step.status === 'done', error: step.error || null, text: step.result && step.result.text ? String(step.result.text).slice(0, 800) : null })) },
        });
      }
      const finalTask = this.tasks.get(taskId);
      const payload = {
        ok: status === 'done',
        status,
        taskId,
        steps: finalTask.steps.map((step) => ({ step: { id: step.id, title: step.title, agent: step.agent }, ok: step.status === 'done', skipped: step.status === 'skipped', result: step.result || null, message: step.error || null, attempts: step.attempts || 0 })),
        results,
        counters,
        error,
        partial: Boolean(finalTask.partial),
        ms: this.now() - started,
      };
      this.emit(taskId, 'finished', { status, ms: payload.ms, steps: counters.steps });
      if (this.metrics) {
        this.metrics.observe('execution.duration', payload.ms);
        this.metrics.increment(`execution.${status}`);
      }
      return payload;
    };

    while (true) {
      if (controller.signal.aborted) {
        this.abortTask(taskId);
        this.tasks.cancel(taskId, 'cancelled during execution');
        this.counters.cancellations += 1;
        const current = this.tasks.get(taskId);
        return { ok: false, status: 'cancelled', taskId, steps: [], results, counters, error: current.error || 'cancelled', partial: Boolean(current.partial) };
      }
      const current = this.tasks.get(taskId);
      if (!current) return { ok: false, status: 'missing', taskId, steps: [], results, counters, error: 'task disappeared' };
      if (['done', 'failed', 'cancelled', 'timeout'].includes(current.status)) {
        return {
          ok: current.status === 'done',
          status: current.status,
          taskId,
          steps: current.steps.map((step) => ({ step: { id: step.id, title: step.title, agent: step.agent }, ok: step.status === 'done', skipped: step.status === 'skipped', result: step.result || null, message: step.error || null, attempts: step.attempts || 0 })),
          results,
          counters,
          error: current.error || null,
          partial: Boolean(current.partial),
          ms: this.now() - started,
        };
      }
      if (current.status === 'paused') {
        return { ok: false, status: 'paused', taskId, steps: [], results, counters, error: 'task paused' };
      }
      if (current.deadline && this.now() > current.deadline) {
        return finish('timeout', 'deadline exceeded');
      }
      if (counters.steps >= limits.maxSteps) {
        this.counters.budgetStops += 1;
        return finish('failed', `step budget exhausted (${limits.maxSteps})`);
      }
      if (counters.modelCalls >= limits.maxModelCalls && current.steps.some((step) => ['pending'].includes(step.status) && !step.tool)) {
        this.counters.budgetStops += 1;
        return finish('failed', `model-call budget exhausted (${limits.maxModelCalls})`);
      }

      const ready = this.tasks.readySteps(taskId);
      if (!ready.length) {
        const pending = current.steps.filter((step) => step.status === 'pending');
        if (!pending.length) {
          const allDone = current.steps.every((step) => step.status === 'done' || step.status === 'skipped');
          return finish(allDone ? 'done' : 'failed', null);
        }
        const statusById = new Map(current.steps.map((step) => [step.id, step.status]));
        const blocked = pending.filter((step) => (step.dependsOn || []).some((dependency) => ['failed', 'cancelled', 'skipped'].includes(statusById.get(dependency))));
        if (blocked.length === pending.length) {
          return finish('failed', `the remaining steps are blocked by a failed dependency: ${blocked.map((step) => step.id).join(', ')}`);
        }
        // Not ready yet, but not blocked either: we are waiting out a retry
        // backoff. Sleeping is the honest move; failing here would turn a
        // designed retry into a mystery.
        const nextAt = Math.min(...pending.map((step) => step.nextAttemptAt || this.now()));
        const waitMs = Math.max(0, nextAt - this.now());
        if (waitMs > 0 && waitMs <= 60000) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs + 5, 1000)));
          continue;
        }
        if (waitMs > 60000) return finish('failed', 'retry backoff is longer than the execution window');
        continue;
      }

      // Pick what to run now. A write step always runs alone; read-only tool
      // steps may share the window up to the concurrency limit.
      const classified = ready.map((step) => ({ step, info: this.classify(step) }));
      const firstWrite = classified.findIndex((entry) => !entry.info.readOnly);
      let batch;
      if (firstWrite === 0) batch = [classified[0]];
      else if (firstWrite > 0) batch = classified.slice(0, firstWrite);
      else batch = classified.slice(0, Math.max(1, limits.concurrency));

      this.emit(taskId, 'batch', { steps: batch.map((entry) => entry.step.id), parallel: batch.length > 1 });

      const runnable = [];
      for (const entry of batch) {
        const { step } = entry;
        const allowed = this.evaluateWhen(step.when, results);
        if (!allowed) {
          this.tasks.skipStep(taskId, step.id, `condition not met: ${JSON.stringify(step.when).slice(0, 160)}`, { conditional: true });
          this.emit(taskId, 'step-skipped', { step: step.id, reason: 'condition' });
          continue;
        }
        runnable.push(entry);
      }
      if (!runnable.length) continue;

      const outcomes = await Promise.all(runnable.map(async ({ step, info }) => {
        if (info.kind === 'tool') counters.toolCalls += 1;
        else counters.modelCalls += 1;
        this.tasks.stepStart(taskId, step.id);
        this.counters.steps += 1;
        counters.steps += 1;
        let outcome;
        try {
          outcome = await this.runStep({ taskId, step, runtime, limits, signal: controller.signal, results });
        } catch (err) {
          outcome = { ok: false, code: err.code || 'STEP_FAILED', message: err.message, text: '' };
        }
        if (outcome.ok) {
          this.tasks.stepDone(taskId, step.id, { text: outcome.text, data: outcome.data, agent: outcome.agent || step.agent || null, tool: outcome.tool || null, ms: outcome.ms || null });
          results[step.id] = outcome.data !== undefined && outcome.data !== null ? outcome.data : outcome.text;
          if (this.events) this.events.publish('execution', { taskId, action: 'step-done', step: step.id }, { correlationId: taskId });
          return { step, outcome, ok: true };
        }
        counters.failed += 1;
        this.counters.failures += 1;
        const retryable = isRetryable(outcome.code) && (info.readOnly || info.idempotent);
        this.tasks.stepFailed(taskId, step.id, `${outcome.code || 'FAILED'}: ${outcome.message || 'step failed'}`.slice(0, 300), { retryable });
        if (retryable) counters.retries += 1;
        if (this.events) this.events.publish('execution', { taskId, action: 'step-failed', step: step.id, code: outcome.code || null }, { severity: 'warn', correlationId: taskId });
        return { step, outcome, ok: false, retryable };
      }));

      const failedNow = outcomes.filter((entry) => !entry.ok);
      if (failedNow.length && replan && counters.replans < limits.maxReplans && this.replanner) {
        const failedStep = failedNow[0];
        const proposal = await this.replanner({
          question: question || current.goal || current.title,
          task: this.tasks.get(taskId),
          failedStep: failedStep.step,
          error: failedStep.outcome,
          results,
          completed: this.tasks.get(taskId).steps.filter((step) => step.status === 'done').map((step) => ({ id: step.id, title: step.title, result: step.result })),
        }).catch((err) => ({ steps: [], reason: err.message }));
        if (proposal && Array.isArray(proposal.steps) && proposal.steps.length) {
          const inserted = this.tasks.insertSteps(taskId, proposal.steps, { after: failedStep.step.id });
          if (inserted.ok) {
            this.tasks.skipStep(taskId, failedStep.step.id, `replanned after ${failedStep.outcome.code || 'failure'}: ${proposal.reason || 'alternative approach'}`);
            counters.replans += 1;
            this.counters.replans += 1;
            this.emit(taskId, 'replanned', { after: failedStep.step.id, steps: inserted.added, reason: proposal.reason || null });
            // The failed step must not block the new branch: mark it failed and
            // let the new steps depend on whatever they actually need.
            continue;
          }
          this.emit(taskId, 'replan-rejected', { errors: inserted.errors });
        }
      }
    }
  }
}

module.exports = { Executor, isRetryable, RETRYABLE, FATAL, DEFAULTS };
