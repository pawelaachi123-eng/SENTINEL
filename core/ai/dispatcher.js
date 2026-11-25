'use strict';

/**
 * The dispatcher: turns a request into work.
 *
 *   route → (plan) → run the chosen specialists → verify → answer
 *
 * Design rules that keep this honest:
 *   • one primary specialist, plus at most one helper. This is not a fan-out.
 *   • every tool call goes through the registry, so permissions, approvals,
 *     sandboxing and audit apply exactly as they do for the phone.
 *   • a step that needs approval is reported, never silently skipped.
 *   • deterministic agents work with no model installed; only reasoning needs
 *     one, and if the model is down the answer says so and reports the facts.
 */

const { parseJsonLoose } = require('./prompt');

/** Functional routing domains served by the specialist model → agent names. */
const SPECIALIST_AGENTS = {
  windows: 'windows',
  hardware: 'hardware',
  code: 'coding',
  knowledge: 'knowledge',
  security: 'security',
  devices: 'mobile',
  communication: 'conversation',
  operations: 'network',
};

class Dispatcher {
  constructor({ agents, tools, llm, config, log, memory, knowledge, tasks, approvals, services = {}, brain = null }) {
    this.agents = agents;
    this.tools = tools;
    this.llm = llm;
    this.config = config;
    this.log = log;
    this.memory = memory;
    this.knowledge = knowledge;
    this.tasks = tasks;
    this.approvals = approvals;
    this.services = services;
    this.brain = brain;
    this.counters = { requests: 0, runs: 0, toolCalls: 0, failures: 0, approvals: 0, noModel: 0 };
  }

  /**
   * Builds the object an agent sees. `tool()` is the only path to the machine.
   */
  createRuntime({ text, mode = 'balanced', sessionId = 'default', runId = null, signal = null, onToken = null, images = null, history = [], contextBlock = '', language = 'auto' }) {
    const dispatcher = this;
    const approvals = [];
    const toolLog = [];
    const limits = this.config.get('ai.limits') || {};
    return {
      request: { text, images },
      mode,
      language,
      limits,
      history,
      contextBlock,
      signal,
      onToken,
      llm: this.llm,
      registry: this.tools,
      memory: this.memory,
      knowledge: this.knowledge,
      tasks: this.tasks,
      config: this.config,
      log: this.log,
      approvals,
      toolLog,
      async tool(name, args = {}) {
        const result = await dispatcher.tools.execute(name, args, { source: 'ai', sessionId, signal, runId });
        dispatcher.counters.toolCalls += 1;
        toolLog.push({ name, ok: result.ok, code: result.code || null, ms: result.ms });
        if (result.code === 'APPROVAL_REQUIRED' && result.approval) {
          approvals.push(result.approval);
          dispatcher.counters.approvals += 1;
        }
        if (!result.ok && !['APPROVAL_REQUIRED', 'CANCELLED'].includes(result.code)) dispatcher.counters.failures += 1;
        return result;
      },
    };
  }

  /** Optional routing-model hint. It never overrides a strong keyword match. */
  specialistHint(text) {
    const specialists = this.services && this.services.specialists;
    if (!specialists || typeof specialists.route !== 'function') return null;
    try {
      const prediction = specialists.route(String(text || ''));
      if (!prediction || !prediction.ok) return null;
      return {
        domain: prediction.label,
        agent: SPECIALIST_AGENTS[prediction.label] || null,
        confidence: prediction.confidence,
        neural: prediction.neural || null,
        baseline: prediction.baseline || null,
        usedFallback: Boolean(prediction.usedFallback),
        model: prediction.model || null,
      };
    } catch (err) {
      if (this.log) this.log.debug('ai', `specialist routing unavailable: ${err.message}`);
      return null;
    }
  }

  route(text, { limit = 2 } = {}) {
    // Arithmetic is decided by the parser, not by keyword scoring: a bare
    // expression ("2+2*2") belongs to the mathematics agent even when the
    // conversation agent would otherwise win on generic words.
    const expression = String(text || '').match(/(?:^|\s)((?:\d[\d\s.,]*[-+*/^%×÷]\s*\d)|pierwiastek\s+z\s+\d+|\d+\s*%\s*(?:ze|z|of)\s+\d+)/i);
    const mathAgent = this.agents.get('mathematics');
    if (expression && mathAgent) {
      return { primary: mathAgent, helpers: [], candidates: [{ name: mathAgent.name, score: 1 }], reason: `arithmetic expression: ${expression[1].trim()}` };
    }
    const specialist = this.specialistHint(text);
    const candidates = this.agents.candidates(text, limit);
    if (!candidates.length) {
      const hintAgent = specialist && specialist.agent ? this.agents.get(specialist.agent) : null;
      if (hintAgent) {
        return { primary: hintAgent, helpers: [], candidates: [], specialist, reason: `specialist model: ${specialist.domain} (${specialist.confidence})` };
      }
      const conversation = this.agents.get('conversation');
      return { primary: conversation, helpers: [], candidates: [], specialist, reason: 'no specialist matched' };
    }
    const primary = candidates[0].agent;
    const helpers = candidates.slice(1).filter((entry) => entry.score >= candidates[0].score * 0.8).map((entry) => entry.agent);
    return { primary, helpers, candidates: candidates.map((entry) => ({ name: entry.agent.name, score: entry.score })), specialist, reason: 'keyword match' };
  }

  /**
   * Marks high-risk requests before an agent touches anything. These are the
   * actions that always need a human: shutdowns, deleting outside the
   * workspace, changing policy, installing software.
   */
  riskOf(text) {
    const lower = String(text).toLowerCase();
    const risks = [];
    if (/(wyłącz komputer|wylacz komputer|shutdown|zamknij system|restart komputera)/.test(lower)) risks.push('power');
    if (/(usuń|delete|skasuj).*(dysk|folder|katalog|plik|wszystko)/.test(lower)) risks.push('delete');
    if (/(uprawnienia|policy|polityka|zabezpiecze|security settings)/.test(lower)) risks.push('policy');
    if (/(zainstaluj|install|aktualizuj system)/.test(lower)) risks.push('install');
    if (/(format|dysk twardy|partition)/.test(lower)) risks.push('disk');
    return risks;
  }

  /**
   * Executes one agent, converting model/tool errors into an honest result.
   */
  async runAgent(agent, runtime, { onStage = null } = {}) {
    this.counters.runs += 1;
    if (onStage) onStage({ stage: 'working', agent: agent.name, title: agent.title });
    try {
      const result = await agent.run(runtime);
      return { ok: true, ...result };
    } catch (err) {
      const code = err.code || 'AGENT_FAILED';
      if (['NO_PROVIDER', 'ALL_FAILED', 'AI_DISABLED', 'MODEL_MISSING'].includes(code)) this.counters.noModel += 1;
      if (this.log) this.log.warn('ai', `${agent.name} failed: ${code} ${err.message}`);
      return { ok: false, agent: agent.name, title: agent.title, code, message: err.message, text: '', toolsUsed: [] };
    }
  }

  /**
   * Asks the planning agent for steps. Returns [] when planning is unnecessary
   * or the model is unavailable — the request still gets answered.
   */
  async plan(goal, runtime) {
    const planner = this.agents.get('planning');
    if (!planner || !this.llm) return [];
    try {
      const result = await this.llm.chat({
        messages: [
          { role: 'system', content: `${planner.spec.instructions}\nAvailable agents: ${this.agents
            .list()
            .filter((agent) => agent.role !== 'orchestrator')
            .map((agent) => agent.name)
            .join(', ')}.` },
          { role: 'user', content: `Goal: ${goal}\nReturn the JSON plan only.` },
        ],
        modelClass: 'balanced',
        json: true,
        temperature: 0.2,
        maxTokens: 700,
        signal: runtime.signal,
      });
      const parsed = parseJsonLoose(result.text);
      const steps = parsed && Array.isArray(parsed.steps) ? parsed.steps.slice(0, 6) : [];
      return steps
        .map((step, index) => ({
          id: String(step.id || `s${index + 1}`),
          title: String(step.title || step.goal || `step ${index + 1}`).slice(0, 160),
          agent: this.agents.get(String(step.agent || '').toLowerCase()) ? String(step.agent).toLowerCase() : null,
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
        }))
        .filter((step) => step.title);
    } catch (err) {
      if (this.log) this.log.debug('ai', `planning skipped: ${err.message}`);
      return [];
    }
  }

  /**
   * Runs a plan step by step, respecting dependencies. Each step is its own
   * agent run; a failed step stops dependent steps but not independent ones.
   */
  async runPlan(steps, runtime, { onStage = null } = {}) {
    const results = [];
    const done = new Set();
    const failed = new Set();
    for (const step of steps) {
      if (runtime.signal && runtime.signal.aborted) break;
      const blocked = step.dependsOn.some((dependency) => failed.has(dependency) || !done.has(dependency));
      if (blocked) {
        results.push({ step, ok: false, skipped: true, message: 'a dependency did not complete' });
        failed.add(step.id);
        continue;
      }
      const agent = (step.agent && this.agents.get(step.agent)) || this.route(step.title).primary;
      if (onStage) onStage({ stage: 'working', step: step.id, agent: agent.name, title: step.title });
      // eslint-disable-next-line no-await-in-loop
      const result = await this.runAgent(agent, { ...runtime, request: { ...runtime.request, text: step.title } }, { onStage });
      results.push({ step, ok: result.ok, result });
      if (result.ok && (result.text || result.data)) done.add(step.id);
      else failed.add(step.id);
    }
    return results;
  }

  stats() {
    return { ...this.counters, agents: this.agents ? this.agents.agents.size : 0, tools: this.tools ? this.tools.tools.size : 0 };
  }
}

module.exports = { Dispatcher };
