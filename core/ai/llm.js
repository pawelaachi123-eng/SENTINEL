'use strict';

/**
 * LLM client.
 *
 * Responsibility: turn "answer this with model class 'balanced', these tools,
 * cancel if the user presses STOP" into one plain result, whatever local engine
 * is actually running.
 *
 *   • providers: Ollama (default), LM Studio, llama.cpp server, any
 *     OpenAI-compatible endpoint, plus an explicitly opted-in external API
 *   • routing: model class → model name, with health-checked fallback
 *   • limits: per-provider concurrency, priority queue, timeouts, retries
 *   • streaming: tokens go to `onToken` as they arrive
 *   • cancellation: every run gets an id; STOP aborts the socket, not just the UI
 *   • privacy: external providers are refused unless the user enabled them
 */

const { createOllama, createOpenAICompat, ProviderError } = require('./providers');
const { estimateTokens, trimMessages } = require('./prompt');
const { CircuitBreaker } = require('../reliability');

const HEALTH_TTL_MS = 30000;

class PriorityQueue {
  constructor() {
    this.items = [];
    this.sequence = 0;
  }

  push(task, priority = 5) {
    const entry = { task, priority, order: this.sequence++ };
    this.items.push(entry);
    this.sort();
    return entry;
  }

  sort() {
    this.items.sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  shift() {
    return this.items.shift();
  }

  get length() {
    return this.items.length;
  }
}

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return { signal: undefined, cleanup: () => {} };
  if (list.length === 1) return { signal: list[0], cleanup: () => {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(list), cleanup: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('aborted'));
  for (const signal of list) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => list.forEach((signal) => signal.removeEventListener('abort', onAbort)),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LlmClient {
  constructor({ config, log, fetchImpl = globalThis.fetch, metrics = null, events = null, experience = null }) {
    this.config = config;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.metrics = metrics;
    this.events = events;
    this.experience = experience;
    this.breakers = new Map();
    this.capabilities = new Map();
    this.providers = new Map();
    this.healthCache = new Map();
    this.queue = new PriorityQueue();
    this.active = 0;
    this.runs = new Map(); // runId → { controller, startedAt, modelClass, text }
    this.runSeq = 0;
    this.counters = { calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, cancelled: 0, fallbacks: 0, cacheHits: 0 };
    this.lastError = null;
    this.buildProviders();
  }

  ai() {
    return (this.config && this.config.get('ai')) || {};
  }

  buildProviders() {
    this.providers.clear();
    const ai = this.ai();
    const providers = ai.providers || {};
    const add = (key, factory) => {
      const entry = providers[key];
      if (!entry || entry.enabled === false) return;
      if (key === 'external' && !(ai.allowExternal && entry.enabled)) return;
      try {
        this.providers.set(key, factory(entry));
      } catch (err) {
        if (this.log) this.log.warn('llm', `provider ${key} not usable: ${err.message}`);
      }
    };
    add('ollama', (entry) =>
      createOllama({ baseUrl: entry.baseUrl, name: 'ollama', fetchImpl: this.fetchImpl, apiKey: entry.apiKey }),
    );
    add('lmstudio', (entry) =>
      createOpenAICompat({ baseUrl: entry.baseUrl, name: 'lmstudio', fetchImpl: this.fetchImpl, apiKey: entry.apiKey }),
    );
    add('llamacpp', (entry) =>
      createOpenAICompat({ baseUrl: entry.baseUrl, name: 'llamacpp', fetchImpl: this.fetchImpl, apiKey: entry.apiKey }),
    );
    add('external', (entry) =>
      createOpenAICompat({ baseUrl: entry.baseUrl, name: 'external', fetchImpl: this.fetchImpl, apiKey: entry.apiKey }),
    );
    this.healthCache.clear();
    this.breakers.clear();
    for (const name of this.providers.keys()) this.breakerFor(name);
  }

  /** One breaker per provider: a dead Ollama must not block every request. */
  breakerFor(name) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ name, failureThreshold: 3, recoveryMs: 30000 }));
    }
    return this.breakers.get(name);
  }

  /** Test seam: register a deterministic provider (never used in normal runs). */
  registerProvider(name, provider) {
    this.providers.set(name, provider);
    this.healthCache.delete(name);
  }

  providerList() {
    return [...this.providers.entries()];
  }

  /* ── health ─────────────────────────────────────────────────────────── */

  async health({ force = false } = {}) {
    const out = {};
    for (const [name, provider] of this.providers) {
      const cached = this.healthCache.get(name);
      if (!force && cached && Date.now() - cached.at < HEALTH_TTL_MS) {
        out[name] = cached.value;
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const value = await provider.health({ signal: controller.signal });
        const record = { ...value, provider: provider.kind, baseUrl: provider.baseUrl, at: Date.now() };
        this.healthCache.set(name, { at: Date.now(), value: record });
        this.breakerFor(name).success();
        if (this.metrics) this.metrics.gauge(`provider.${name}.ok`, 1);
        out[name] = record;
      } catch (err) {
        const value = {
          ok: false,
          error: err.name === 'AbortError' ? 'no answer within 2.5 s' : err.message,
          code: err.code || 'UNREACHABLE',
          provider: provider.kind,
          baseUrl: provider.baseUrl,
          models: [],
          at: Date.now(),
        };
        this.healthCache.set(name, { at: Date.now(), value });
        this.breakerFor(name).failure(err);
        if (this.metrics) this.metrics.gauge(`provider.${name}.ok`, 0);
        out[name] = value;
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }

  /** Counters and queue depth for the Diagnostics tab. */
  stats() {
    return {
      providers: [...this.providers.keys()],
      running: this.runs.size,
      ...this.counters,
      lastError: this.lastError,
      healthCache: this.healthCache.size,
      breakers: [...this.breakers.values()].map((breaker) => breaker.status()),
    };
  }

  clearHealthCache() {
    this.healthCache.clear();
  }

  async status() {
    const health = await this.health();
    const ai = this.ai();
    const models = ai.models || {};
    const available = {};
    for (const [class_, model] of Object.entries(models)) {
      const found = Object.values(health).find((entry) => (entry.models || []).some((item) => item.id === model));
      available[class_] = { model, provider: found ? found.baseUrl : null, present: Boolean(found) };
    }
    const anyUp = Object.values(health).some((entry) => entry.ok);
    return {
      enabled: ai.enabled !== false,
      mode: ai.mode || 'balanced',
      offline: ai.offline !== false,
      allowExternal: Boolean(ai.allowExternal),
      anyProviderUp: anyUp,
      providers: health,
      models,
      available,
      limits: ai.limits,
      counters: { ...this.counters },
      active: this.active,
      queued: this.queue.length,
      runs: [...this.runs.values()].map((run) => ({ id: run.id, modelClass: run.modelClass, startedAt: run.startedAt, chars: run.text.length })),
      lastError: this.lastError,
      breakers: [...this.breakers.values()].map((breaker) => breaker.status()),
      capabilities: Object.fromEntries(this.capabilities),
    };
  }

  /* ── model routing ──────────────────────────────────────────────────── */

  /**
   * Candidate (provider, model) pairs for a class, best first.
   * Config order is ollama → lmstudio → llamacpp → external.
   */
  candidates(modelClass = 'balanced', { model = null } = {}) {
    const ai = this.ai();
    const models = ai.models || {};
    const wanted = model || models[modelClass] || models.balanced || models.fast || ai.model;
    // Configured providers first, then anything registered later (a custom
    // OpenAI-compatible endpoint or a test double) in registration order.
    const order = ['ollama', 'lmstudio', 'llamacpp', 'external', ...[...this.providers.keys()].filter((name) => !['ollama', 'lmstudio', 'llamacpp', 'external'].includes(name))];
    const out = [];
    for (const name of order) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      if (name === 'external' && !ai.allowExternal) continue;
      const health = this.healthCache.get(name);
      const records = health && health.value && health.value.models ? health.value.models : [];
      const present = wanted ? records.some((item) => item.id === wanted) : false;
      // Preferred: the configured model on this provider.
      if (wanted) out.push({ name, provider, model: wanted, present });
      // Fallback: ask this provider for a model it actually has.
      if (!present && records.length) {
        const pick = pickModel(records, modelClass);
        if (pick && pick !== wanted) out.push({ name, provider, model: pick, present: true, substituted: true });
      }
    }
    return out;
  }

  /* ── execution ──────────────────────────────────────────────────────── */

  concurrency() {
    const limits = this.ai().limits || {};
    const wanted = Number(limits.concurrency) || 2;
    return Math.max(1, Math.min(8, wanted));
  }

  async acquire() {
    if (this.active < this.concurrency()) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => {
      const entry = this.queue.push(resolve, 5);
      // A cancelled waiter is drained by release().
      entry.resolve = resolve;
    });
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      next.task();
    }
  }

  registerRun({ id, modelClass, controller }) {
    const runId = id || `run_${Date.now().toString(36)}${(this.runSeq++).toString(36)}`;
    this.runs.set(runId, { id: runId, controller, startedAt: Date.now(), modelClass, text: '' });
    return runId;
  }

  cancel(runId, reason = 'cancelled by user') {
    const run = this.runs.get(runId);
    if (!run) return false;
    this.counters.cancelled += 1;
    run.controller.abort(Object.assign(new Error(reason), { code: 'CANCELLED' }));
    this.runs.delete(runId);
    return true;
  }

  cancelAll(reason = 'stopped') {
    let count = 0;
    for (const [id] of this.runs) {
      if (this.cancel(id, reason)) count += 1;
    }
    return count;
  }

  /**
   * Capabilities per model: context window, vision, tool calling.
   * Sources, in order: explicit config (`ai.capabilities.<model>`), provider
   * metadata, then conservative name heuristics. Never assume — an unknown model
   * gets the smallest safe context window.
   */
  capabilitiesFor(model, providerName = null) {
    if (!model) return { contextTokens: 4096, vision: false, tools: true, source: 'default' };
    const cached = this.capabilities.get(model);
    if (cached) return cached;
    const ai = this.ai();
    const configured = (ai.capabilities && ai.capabilities[model]) || null;
    let capability;
    if (configured) {
      capability = { contextTokens: Number(configured.contextTokens) || 4096, vision: Boolean(configured.vision), tools: configured.tools !== false, source: 'config' };
    } else {
      const meta = this.healthCache.size
        ? Object.values(Object.fromEntries(this.healthCache)).map((entry) => (entry && entry.value && entry.value.models) || []).flat().find((item) => item && item.id === model)
        : null;
      const details = (meta && meta.details) || {};
      const family = String(details.family || '').toLowerCase();
      const vision = /(vl|vision|llava|bakllava|moondream)/i.test(model);
      const tools = !/(llava|moondream)/i.test(model);
      const contextTokens = Number((configured && configured.contextTokens) || (meta && meta.context_length) || 0) || (vision ? 4096 : 8192);
      capability = { contextTokens, vision, tools, family: family || null, parameters: details.parameter_size || null, source: meta ? 'provider' : 'heuristic' };
    }
    this.capabilities.set(model, capability);
    return capability;
  }

  /**
   * JSON with a schema, validated in code and repaired at most once.
   * Models are good at roughly following a shape and bad at guaranteeing it;
   * the guarantee has to live on this side of the wire.
   */
  async structured({ messages, schema, modelClass = 'balanced', attempts = 2, validate = null, ...rest }) {
    const describe = JSON.stringify(schema);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const guided = attempt === 1
        ? messages
        : [
            ...messages,
            { role: 'system', content: `Your previous reply was not valid JSON for the required schema. Reply with JSON only, no prose, no code fences. Schema: ${describe}` },
          ];
      // eslint-disable-next-line no-await-in-loop
      const result = await this.chat({ ...rest, messages: guided, modelClass, json: true, temperature: 0 });
      let parsed = null;
      try {
        parsed = parseJsonLoose(result.text);
      } catch (err) {
        lastError = err;
      }
      if (parsed && validate) {
        const verdict = validate(parsed);
        if (verdict && verdict.ok === false) {
          lastError = Object.assign(new Error(verdict.reason || 'schema validation failed'), { code: 'INVALID_OUTPUT' });
          parsed = null;
        }
      }
      if (parsed) return { data: parsed, raw: result.text, model: result.model, provider: result.provider, attempts: attempt, usage: result.usage };
      this.counters.invalidOutputs = (this.counters.invalidOutputs || 0) + 1;
    }
    throw new ProviderError(`model did not produce schema-valid JSON: ${lastError ? lastError.message : 'unknown'}` , { code: 'INVALID_OUTPUT' });
  }

  /**
   * @returns {Promise<{text, toolCalls, usage, model, provider, ms, finish, runId, modelClass, substituted, streamed}>}
   */
  async chat({
    messages,
    tools = null,
    modelClass = 'balanced',
    model = null,
    temperature = 0.3,
    maxTokens = null,
    json = false,
    images = null,
    signal = null,
    onToken = null,
    runId = null,
    priority = 5,
    retries = 1,
  }) {
    const ai = this.ai();
    if (ai.enabled === false) throw new ProviderError('The AI engine is switched off in settings', { code: 'AI_DISABLED' });

    const limits = ai.limits || {};
    const budget = Number(maxTokens) || Number(limits.maxOutputTokens) || 1024;
    const configuredModel = model || (ai.models && ai.models[modelClass]) || null;
    const capability = this.capabilitiesFor(configuredModel);
    // The configured ceiling wins when it is lower than the model's window;
    // a 9B model with 8k context must not be fed a 14k prompt.
    const contextLimit = Math.min(Number(limits.maxContextTokens) || 8192, capability.contextTokens || 8192);
    const trimmed = trimMessages(messages, { maxTokens: contextLimit, reserve: budget });
    if (images && trimmed.length) {
      const last = trimmed[trimmed.length - 1];
      if (last.role === 'user') last.images = images;
    }

    if (!this.providers.size) {
      throw new ProviderError('No model provider is enabled (start Ollama, LM Studio or llama.cpp)', { code: 'NO_PROVIDER' });
    }

    await this.acquire();
    const controller = new AbortController();
    const id = this.registerRun({ id: runId, modelClass, controller });
    const combined = combineSignals([signal, controller.signal]);
    const started = Date.now();
    let attemptErrors = [];

    try {
      const chain = this.candidates(modelClass, { model });
      if (!chain.length) throw new ProviderError('No model provider is configured', { code: 'NO_PROVIDER' });

      for (const candidate of chain) {
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const timeout = setTimeout(() => controller.abort(Object.assign(new Error('model timeout'), { code: 'TIMEOUT' })), Number(limits.timeoutMs) || 120000);
          const breaker = this.breakerFor(candidate.name);
          if (!breaker.canAttempt()) {
            attemptErrors.push(`${candidate.name}: circuit open (${breaker.lastError || 'errors'})`);
            continue;
          }
          try {
            this.counters.calls += 1;
            const firstTokenAt = { at: null };
            const result = await candidate.provider.chat({
              model: candidate.model,
              messages: trimmed,
              temperature,
              maxTokens: budget,
              json,
              tools,
              keepAlive: (ai.providers && ai.providers.ollama && ai.providers.ollama.keepAlive) || '30m',
              signal: combined.signal,
              onToken: (piece) => {
                if (firstTokenAt.at === null) firstTokenAt.at = Date.now();
                const run = this.runs.get(id);
                if (run) run.text += piece;
                if (onToken) onToken(piece);
              },
            });
            clearTimeout(timeout);
            const ms = Date.now() - started;
            breaker.success();
            const tokensIn = (result.usage && result.usage.prompt) || estimateTokens(trimmed.map((m) => m.content).join(' '));
            const tokensOut = (result.usage && result.usage.completion) || estimateTokens(result.text);
            this.counters.tokensIn += tokensIn;
            this.counters.tokensOut += tokensOut;
            if (candidate.substituted) this.counters.fallbacks += 1;
            this.lastError = null;
            if (this.metrics) {
              this.metrics.observe('llm.latency', ms);
              if (firstTokenAt.at) this.metrics.observe('llm.firstToken', firstTokenAt.at - started);
              if (ms > 0) this.metrics.observe('llm.tokensPerSecond', Number(((tokensOut / ms) * 1000).toFixed(2)));
              this.metrics.increment(`llm.calls.${candidate.name}`);
            }
            if (this.events) this.events.model(id, 'answered', { provider: candidate.name, model: candidate.model, ms, tokensIn, tokensOut });
            return {
              ...result,
              model: candidate.model,
              provider: candidate.name,
              ms,
              runId: id,
              modelClass,
              substituted: Boolean(candidate.substituted),
              streamed: Boolean(onToken),
            };
          } catch (err) {
            clearTimeout(timeout);
            if (combined.signal && combined.signal.aborted) {
              const aborted = new ProviderError(
                controller.signal.aborted ? 'stopped' : 'cancelled',
                { code: 'CANCELLED' },
              );
              aborted.runId = id;
              throw aborted;
            }
            attemptErrors.push(`${candidate.name}/${candidate.model}: ${err.message}`);
            this.lastError = err.message;
            if (!(err instanceof ProviderError) || !['CANCELLED', 'INVALID_OUTPUT'].includes(err.code)) breaker.failure(err);
            if (this.metrics) this.metrics.increment('llm.errors');
            if (this.events) this.events.model(id, 'failed', { provider: candidate.name, model: candidate.model, code: err.code || 'FAILED', message: err.message });
            const retryable = !(err instanceof ProviderError) || ['TIMEOUT', 'HTTP_ERROR', 'UNREACHABLE', 'MODEL_MISSING'].includes(err.code);
            if (attempt < retries && retryable) {
              await sleep(300 * (attempt + 1));
              continue;
            }
            break; // next candidate
          }
        }
      }
      this.counters.failures += 1;
      const error = new ProviderError(`No model answered. Tried: ${attemptErrors.slice(0, 4).join(' | ')}`, {
        code: this.providers.size ? 'ALL_FAILED' : 'NO_PROVIDER',
      });
      error.attempts = attemptErrors;
      throw error;
    } finally {
      clearTimeout(undefined);
      this.runs.delete(id);
      combined.cleanup();
      this.release();
    }
  }

  /** Embeddings through the first provider that supports them. */
  async embed({ input, model = null, signal = null }) {
    const ai = this.ai();
    const modelName = model || (ai.models && ai.models.embed) || 'nomic-embed-text';
    const errors = [];
    for (const [name, provider] of this.providers) {
      if (name === 'external' && !ai.allowExternal) continue;
      if (typeof provider.embed !== 'function') continue;
      try {
        const vectors = await provider.embed({ model: modelName, input, signal });
        if (Array.isArray(vectors) && vectors.length) return vectors;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    throw new ProviderError(`no embedding model answered (${errors.join('; ') || 'none configured'})`, { code: 'NO_EMBEDDINGS' });
  }

  /** First token latency + tokens/second, measured, not guessed. */
  async benchmark({ modelClass = 'balanced', prompt = 'Reply with the single word: ready.' } = {}) {
    const started = Date.now();
    let firstTokenAt = null;
    const result = await this.chat({
      messages: [
        { role: 'system', content: 'You are a benchmark. Answer with exactly one short sentence.' },
        { role: 'user', content: prompt },
      ],
      modelClass,
      maxTokens: 64,
      temperature: 0,
      onToken: () => {
        if (!firstTokenAt) firstTokenAt = Date.now();
      },
    });
    const totalMs = Date.now() - started;
    const completion = (result.usage && result.usage.completion) || estimateTokens(result.text);
    return {
      model: result.model,
      provider: result.provider,
      totalMs,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
      tokensPerSecond: completion && totalMs ? Number(((completion / totalMs) * 1000).toFixed(1)) : null,
      tokens: completion,
      sample: result.text.slice(0, 200),
    };
  }
}

/** Picks something sensible when the configured model is not installed. */
function pickModel(models, modelClass) {
  const ids = models.map((model) => String(model.id).toLowerCase());
  const preferred = modelClass === 'fast' || modelClass === 'vision' ? ['qwen', 'llama', 'gemma', 'phi'] : ['qwen', 'llama', 'mistral', 'gemma'];
  for (const needle of preferred) {
    const index = ids.findIndex((id) => id.includes(needle));
    if (index >= 0) return models[index].id;
  }
  return models[0] ? models[0].id : null;
}

function parseJsonLoose(text) {
  const value = String(text || '').trim();
  if (!value) throw Object.assign(new Error('empty output'), { code: 'INVALID_OUTPUT' });
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : value;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw Object.assign(new Error('output is not JSON'), { code: 'INVALID_OUTPUT' });
  }
}

module.exports = { LlmClient, PriorityQueue, ProviderError, pickModel, combineSignals, parseJsonLoose };
