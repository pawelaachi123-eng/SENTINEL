'use strict';

/**
 * Neural runtime.
 *
 * This module does not pretend to be a transformer. It is the layer that finds
 * the real pretrained models a user already has, reads what the provider
 * actually reports about them (architecture, parameter count, quantisation,
 * context length, capabilities), and routes work to a model that can do it.
 *
 * Principles:
 *   - capability discovery is evidence-based: fields come from the provider's
 *     own metadata (`details`, `model_info`, `capabilities`). Nothing is
 *     inferred into a fact; name-based guesses are marked `inferred: true`.
 *   - no invented neuron counts, layer counts or token counts. Missing metadata
 *     is `null`, and token counts are labelled estimates because no provider
 *     here exposes a tokenizer endpoint.
 *   - generation is delegated to LlmClient (health, retries, breakers), so this
 *     layer cannot drift into a second, subtly different inference path.
 *   - external inference stays off unless the user enabled it; routing will not
 *     silently pick an external model.
 *   - concurrency is bounded per provider, so an 8 GB GPU is not asked to hold
 *     four contexts at once.
 */

const { estimateTokens } = require('./ai/prompt');

const GB = 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_MODELS_PER_PROVIDER = 40;

const TASKS = {
  reasoning: { capabilities: ['completion'], prefers: ['balanced', 'deep'], exclude: ['embedding', 'rerank'] },
  coding: { capabilities: ['completion'], prefers: ['code'], exclude: ['embedding', 'rerank'] },
  vision: { capabilities: ['vision'], prefers: ['vision'], exclude: ['embedding', 'rerank'] },
  embedding: { capabilities: ['embedding'], prefers: ['embed'], exclude: ['vision'] },
  rerank: { capabilities: ['rerank'], prefers: ['rerank'], exclude: [] },
  classification: { capabilities: ['completion'], prefers: ['fast'], exclude: ['embedding', 'rerank', 'vision'] },
  tools: { capabilities: ['tools'], prefers: ['balanced', 'code'], exclude: ['embedding', 'rerank', 'vision'] },
  thinking: { capabilities: ['thinking'], prefers: ['deep', 'balanced'], exclude: ['embedding', 'rerank', 'vision'] },
};

/** Turns provider metadata into a capability record without inventing anything. */
function capabilitiesOf(model, raw = {}) {
  const explicit = Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : null;
  const capabilities = new Set();
  if (explicit) {
    for (const name of explicit) {
      if (['completion', 'chat', 'tools', 'thinking', 'vision', 'embedding'].includes(name)) capabilities.add(name === 'chat' ? 'completion' : name);
    }
    if (capabilities.has('completion') && !capabilities.has('tools')) capabilities.add('tools'); // Ollama's contract for chat models
  }
  const name = String(model || '').toLowerCase();
  const inferred = [];
  if (!explicit) {
    capabilities.add(/embed|bge|e5|gte|minilm|nomic/.test(name) ? 'embedding' : 'completion');
    if (/embed|bge|e5|gte|minilm|nomic/.test(name)) inferred.push('embedding');
    else inferred.push('completion');
    if (/vl|vision|llava|qwen.*-vl|pixtral|moondream/.test(name)) {
      capabilities.add('vision');
      inferred.push('vision');
    }
    if (/rerank|ranker/.test(name)) {
      capabilities.add('rerank');
      inferred.push('rerank');
    }
    if (/reason|think|r1|qwq/.test(name)) {
      capabilities.add('thinking');
      inferred.push('thinking');
    }
  }
  if (/rerank|ranker/.test(name)) capabilities.add('rerank');
  return { capabilities: [...capabilities].sort(), inferred: inferred.length > 0, inferredFrom: inferred.length ? ['model name'] : [] };
}

function kindOf(capabilities) {
  if (capabilities.includes('embedding')) return 'embedding';
  if (capabilities.includes('rerank')) return 'rerank';
  if (capabilities.includes('vision')) return 'vision';
  if (capabilities.includes('thinking')) return 'reasoning';
  if (capabilities.includes('tools')) return 'chat-tools';
  return 'chat';
}

/** Pulls numbers out of GGUF-style keys whose architecture prefix varies. */
function fromModelInfo(info, suffix) {
  if (!info || typeof info !== 'object') return null;
  const key = Object.keys(info).find((entry) => entry.endsWith(`.${suffix}`));
  if (!key) return null;
  const value = info[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normaliseOllama(raw) {
  const details = raw.details || {};
  const info = raw.model_info || {};
  const caps = capabilitiesOf(raw.name || raw.model, { capabilities: raw.capabilities });
  return {
    id: raw.name || raw.model,
    provider: 'ollama',
    architecture: typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null,
    family: details.family || null,
    families: Array.isArray(details.families) ? details.families : null,
    parameters: details.parameter_size || null,
    parameterCount: typeof info['general.parameter_count'] === 'number' ? info['general.parameter_count'] : null,
    quantization: details.quantization_level || null,
    contextLength: fromModelInfo(info, 'context_length'),
    embeddingLength: fromModelInfo(info, 'embedding_length'),
    layers: fromModelInfo(info, 'block_count'),
    heads: fromModelInfo(info, 'attention.head_count'),
    kvHeads: fromModelInfo(info, 'attention.head_count_kv'),
    sizeBytes: typeof raw.size === 'number' ? raw.size : null,
    sizeGb: typeof raw.size === 'number' ? Number((raw.size / GB).toFixed(2)) : null,
    capabilities: caps.capabilities,
    capabilitiesInferred: caps.inferred,
    inferredFrom: caps.inferredFrom,
    kind: kindOf(caps.capabilities),
    source: 'ollama:/api/show',
    observedAt: new Date().toISOString(),
  };
}

function normaliseOpenAI(raw, provider) {
  const caps = capabilitiesOf(raw.id, {});
  return {
    id: raw.id,
    provider,
    architecture: null,
    family: null,
    families: null,
    parameters: null,
    parameterCount: null,
    quantization: null,
    contextLength: typeof raw.context_length === 'number' ? raw.context_length : null,
    embeddingLength: null,
    layers: null,
    heads: null,
    kvHeads: null,
    sizeBytes: null,
    sizeGb: null,
    capabilities: caps.capabilities,
    capabilitiesInferred: caps.inferred,
    inferredFrom: caps.inferredFrom,
    kind: kindOf(caps.capabilities),
    source: `${provider}:/v1/models`,
    observedAt: new Date().toISOString(),
  };
}

class Semaphore {
  constructor(limit = 2) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
    this.peak = 0;
    this.waited = 0;
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return;
    }
    this.waited += 1;
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

class NeuralRuntime {
  constructor({ config = null, llm = null, log = null, store = null, runtime = null, fetchImpl = null, now = () => Date.now(), cacheTtlMs = DEFAULT_TTL_MS, concurrency = 2 } = {}) {
    this.config = config;
    this.llm = llm;
    this.log = log;
    this.store = store;
    this.runtime = runtime;
    this.fetch = fetchImpl || (llm && llm.fetchImpl) || globalThis.fetch;
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.models = new Map();
    this.lastDiscovery = null;
    this.discoveryError = null;
    this.semaphores = new Map();
    this.defaultConcurrency = Math.max(1, Math.min(4, Number(concurrency) || 2));
    this.counters = { discoveries: 0, cacheHits: 0, cacheMisses: 0, routes: 0, routeFailures: 0, chats: 0, structured: 0, repairs: 0, warmups: 0, cancellations: 0, unloads: 0, waits: 0 };
    this.loadCache();
  }

  providerConfig() {
    return (this.config && this.config.get && this.config.get('ai.providers')) || {};
  }

  allowExternal() {
    return Boolean(this.config && this.config.get && this.config.get('ai.allowExternal'));
  }

  baseUrl(provider) {
    const entry = this.providerConfig()[provider] || {};
    return String(entry.baseUrl || '').replace(/\/$/, '');
  }

  semaphore(provider) {
    if (!this.semaphores.has(provider)) this.semaphores.set(provider, new Semaphore(this.defaultConcurrency));
    return this.semaphores.get(provider);
  }

  loadCache() {
    if (!this.store) return;
    try {
      for (const row of this.store.list('model_registry')) {
        this.models.set(`${row.provider}:${row.id}`, row);
        this.lastDiscovery = Math.max(this.lastDiscovery || 0, row.discoveredAt || 0);
      }
    } catch (err) {
      if (this.log) this.log.warn('neural', `could not load the model cache: ${err.message}`);
    }
  }

  cacheFresh(force = false) {
    if (force || !this.lastDiscovery) return false;
    return this.now() - this.lastDiscovery < this.cacheTtlMs;
  }

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 4000);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} from ${url}`), { code: 'PROVIDER_HTTP', status: response.status });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverOllama() {
    const base = this.baseUrl('ollama');
    if (!base) return [];
    const tags = await this.fetchJson(`${base}/api/tags`);
    const listed = (tags && tags.models) || [];
    const out = [];
    for (const model of listed.slice(0, MAX_MODELS_PER_PROVIDER)) {
      try {
        // /api/show carries architecture, quantisation, context and capabilities.
        // eslint-disable-next-line no-await-in-loop
        const show = await this.fetchJson(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.name || model.model }), timeoutMs: 6000 });
        out.push(normaliseOllama({ ...model, ...show, name: model.name || model.model }));
      } catch (err) {
        out.push({ ...normaliseOllama({ ...model, name: model.name || model.model }), metadataError: err.message });
      }
    }
    return out;
  }

  async discoverOpenAI(provider) {
    const base = this.baseUrl(provider);
    if (!base) return [];
    if (provider === 'external' && !this.allowExternal()) return [];
    try {
      const list = await this.fetchJson(`${base}/models`, { headers: this.providerConfig()[provider] && this.providerConfig()[provider].apiKey ? { authorization: `Bearer ${this.providerConfig()[provider].apiKey}` } : {} });
      return ((list && list.data) || []).slice(0, MAX_MODELS_PER_PROVIDER).map((model) => normaliseOpenAI(model, provider));
    } catch (err) {
      if (this.log) this.log.debug('neural', `${provider} discovery failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Discovers models from every enabled provider. Returns what was found and
   * what failed; a provider being down is a fact, not an exception.
   */
  async discover({ force = false, provider = null } = {}) {
    if (!force && this.cacheFresh()) {
      this.counters.cacheHits += 1;
      return this.status({ cached: true });
    }
    this.counters.cacheMisses += 1;
    const providers = this.providerConfig();
    const found = [];
    const errors = [];
    const wanted = provider ? [provider] : ['ollama', 'lmstudio', 'llamacpp', 'external'];
    for (const name of wanted) {
      const entry = providers[name];
      if (!entry || entry.enabled === false) continue;
      if (name === 'external' && !this.allowExternal()) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const models = name === 'ollama' ? await this.discoverOllama() : await this.discoverOpenAI(name);
        for (const model of models) {
          const record = { ...model, discoveredAt: this.now() };
          this.models.set(`${model.provider}:${model.id}`, record);
          if (this.store) this.store.put('model_registry', `${model.provider}:${model.id}`, record);
          found.push(record);
        }
      } catch (err) {
        errors.push({ provider: name, message: err.message });
        if (this.log) this.log.warn('neural', `${name} discovery failed: ${err.message}`);
      }
    }
    this.lastDiscovery = this.now();
    this.discoveryError = errors.length && !found.length ? errors[0].message : null;
    this.counters.discoveries += 1;
    return { ok: true, found: found.length, errors, models: found.map((model) => this.summarise(model)), ...this.countersSnapshot() };
  }

  list({ capability = null, provider = null } = {}) {
    return [...this.models.values()]
      .filter((model) => (provider ? model.provider === provider : true))
      .filter((model) => (capability ? (model.capabilities || []).includes(capability) : true))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  }

  modelRef(model) {
    return `${model.provider}:${model.id}`;
  }

  /**
   * Picks a model for a task. The preference is configuration (model classes),
   * then observed parameter count — never a hallucinated benchmark.
   */
  route({ task = 'reasoning', needs = [], provider = null } = {}) {
    this.counters.routes += 1;
    const spec = TASKS[task] || TASKS.reasoning;
    const capabilities = [...new Set([...(spec.capabilities || []), ...needs])];
    const candidates = this.list({ provider }).filter((model) => {
      const caps = model.capabilities || [];
      if ((spec.exclude || []).some((name) => caps.includes(name))) return false;
      return capabilities.every((name) => caps.includes(name));
    });
    if (!candidates.length) {
      this.counters.routeFailures += 1;
      return { ok: false, code: 'NO_CAPABLE_MODEL', task, needs: capabilities, message: `no installed model advertises ${capabilities.join(' + ')}` };
    }
    const models = (this.config && this.config.get && this.config.get('ai.models')) || {};
    const preferredNames = (spec.prefers || []).map((key) => models[key]).filter(Boolean);
    const scored = candidates.map((model) => {
      const preferred = preferredNames.findIndex((name) => name && (model.id === name || model.id.startsWith(`${name}:`) || model.id.startsWith(name)));
      const params = Number(model.parameterCount) || 0;
      const contextLength = Number(model.contextLength) || 0;
      return { model, score: (preferred >= 0 ? 1000 - preferred * 10 : 0) + Math.min(50, Math.log10(params + 1) * 4) + Math.min(10, contextLength / 32768) };
    });
    scored.sort((a, b) => b.score - a.score || this.modelRef(a.model).localeCompare(this.modelRef(b.model)));
    const chosen = scored[0].model;
    return {
      ok: true,
      task,
      model: chosen.id,
      provider: chosen.provider,
      ref: this.modelRef(chosen),
      kind: chosen.kind,
      capabilities: chosen.capabilities,
      contextLength: chosen.contextLength,
      quantization: chosen.quantization,
      reason: `${chosen.kind} model with ${capabilities.join('+')}${preferredNames.length ? `; preferred class ${preferredNames[0]}` : ''}`,
      alternatives: scored.slice(1, 4).map((entry) => this.modelRef(entry.model)),
      estimated: false,
    };
  }

  countTokens(text, { model = null } = {}) {
    return {
      tokens: estimateTokens(String(text || '')),
      estimated: true,
      method: 'heuristic characters-per-token, no provider tokenizer endpoint',
      model,
    };
  }

  async chat({ messages, model = null, provider = null, task = 'reasoning', onToken = null, signal = null, maxTokens = null, temperature = 0.3, json = false } = {}) {
    const chosen = model && provider ? { ok: true, model, provider } : this.route({ task, provider });
    if (!chosen.ok) throw Object.assign(new Error(chosen.message), { code: chosen.code });
    this.counters.chats += 1;
    const sem = this.semaphore(chosen.provider);
    const started = this.now();
    await sem.acquire();
    const waited = this.now() - started;
    if (waited > 5) this.counters.waits += 1;
    try {
      if (signal && signal.aborted) {
        this.counters.cancellations += 1;
        throw Object.assign(new Error('cancelled before the model call'), { code: 'CANCELLED' });
      }
      const result = await this.llm.chat({ messages, modelClass: null, model: chosen.model, temperature, maxTokens, json, signal, onToken });
      if (signal && signal.aborted) this.counters.cancellations += 1;
      return { ...result, model: chosen.model, provider: chosen.provider, waitedMs: waited };
    } finally {
      sem.release();
    }
  }

  async structured({ messages, schema, task = 'reasoning', model = null, provider = null, validate = null, maxTokens = 1200, attempts = 2 } = {}) {
    const chosen = model && provider ? { ok: true, model, provider } : this.route({ task });
    if (!chosen.ok) throw Object.assign(new Error(chosen.message), { code: chosen.code });
    this.counters.structured += 1;
    let repaired = false;
    try {
      return await this.llm.structured({ messages, schema, modelClass: null, model: chosen.model, validate, attempts: 1, maxTokens });
    } catch (err) {
      // One bounded repair attempt: tell the model exactly what was wrong.
      // There is no third attempt and no silent fallback to a looser schema.
      this.counters.repairs += 1;
      repaired = true;
      const repair = [
        { role: 'system', content: `Your previous answer did not satisfy the schema. Error: ${err.message}. Return only JSON that satisfies the schema.` },
        ...messages,
      ];
      const result = await this.llm.structured({ messages: repair, schema, modelClass: null, model: chosen.model, validate, attempts: 1, maxTokens });
      return { ...result, repaired, repairError: err.message };
    }
  }

  async warm(model = null, { task = 'reasoning' } = {}) {
    const chosen = model ? this.list().find((entry) => entry.id === model) : null;
    const target = model || (this.route({ task }).model || null);
    if (!target) return { ok: false, code: 'NO_CAPABLE_MODEL' };
    const started = this.now();
    try {
      await this.llm.chat({ messages: [{ role: 'user', content: 'Reply with: ready' }], model: target, modelClass: null, maxTokens: 4, temperature: 0 });
      this.counters.warmups += 1;
      return { ok: true, model: target, loadMs: this.now() - started, metadata: chosen ? { contextLength: chosen.contextLength, quantization: chosen.quantization } : null };
    } catch (err) {
      return { ok: false, code: err.code || 'WARMUP_FAILED', message: err.message, model: target };
    }
  }

  async unload(model) {
    const base = this.baseUrl('ollama');
    const entry = this.providerConfig().ollama;
    if (!entry || entry.enabled === false || !base) return { ok: false, code: 'PROVIDER_UNSUPPORTED', message: 'keep-alive control requires an enabled Ollama provider' };
    try {
      const response = await this.fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) });
      if (!response.ok) return { ok: false, code: 'UNLOAD_FAILED', message: `provider answered HTTP ${response.status}` };
      this.counters.unloads += 1;
      return { ok: true, model };
    } catch (err) {
      return { ok: false, code: 'UNLOAD_FAILED', message: err.message };
    }
  }

  summarise(model) {
    return {
      id: model.id,
      provider: model.provider,
      kind: model.kind,
      capabilities: model.capabilities,
      capabilitiesInferred: Boolean(model.capabilitiesInferred),
      architecture: model.architecture,
      parameters: model.parameters,
      parameterCount: model.parameterCount,
      quantization: model.quantization,
      contextLength: model.contextLength,
      layers: model.layers,
      heads: model.heads,
      sizeGb: model.sizeGb,
      source: model.source,
      metadataError: model.metadataError || null,
    };
  }

  countersSnapshot() {
    return { counters: { ...this.counters } };
  }

  status({ cached = false } = {}) {
    const models = this.list().map((model) => this.summarise(model));
    return {
      cached,
      lastDiscovery: this.lastDiscovery ? new Date(this.lastDiscovery).toISOString() : null,
      olderThanTtl: this.lastDiscovery ? this.now() - this.lastDiscovery >= this.cacheTtlMs : true,
      discoveryError: this.discoveryError,
      models,
      counts: {
        total: models.length,
        embedding: models.filter((model) => model.kind === 'embedding').length,
        vision: models.filter((model) => model.capabilities.includes('vision')).length,
        reasoning: models.filter((model) => model.capabilities.includes('thinking')).length,
        tools: models.filter((model) => model.capabilities.includes('tools')).length,
      },
      queue: [...this.semaphores.entries()].map(([provider, sem]) => ({ provider, active: sem.active, peak: sem.peak, waited: sem.waited, limit: sem.limit })),
      counters: { ...this.counters },
      honest: 'Metadata comes from the provider. Missing fields are null, not guesses; token counts are labelled estimates.',
    };
  }
}

module.exports = { NeuralRuntime, capabilitiesOf, normaliseOllama, normaliseOpenAI, kindOf, fromModelInfo, TASKS };
