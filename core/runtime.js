'use strict';

/**
 * Model runtime and resource management.
 *
 * Target machine: i7-13700F, RTX 4060 Ti 8 GB, 32 GB RAM, Windows. The point of
 * this module is not to look clever about hardware; it is to stop the assistant
 * from thrashing a gaming session, and to say plainly when a model will not fit
 * instead of letting Ollama swap it and stutter.
 *
 * Four profiles: idle, balanced, deep, gaming.
 *   - idle      small model, short keep-alive (the assistant is parked)
 *   - balanced  default: fast model, 5-minute keep-alive
 *   - deep      big model, long keep-alive, heavy work allowed
 *   - gaming    no resident model: everything unloaded, deep work refused
 *
 * All memory figures here are estimates from parameter count and quantisation,
 * and are labelled `estimated: true`. Real usage is read from the provider
 * (`/api/ps`) and displayed next to the estimate; the module never presents an
 * estimate as a measurement. GPU detection uses `nvidia-smi` when present and
 * degrades to "unknown" otherwise.
 *
 * Detection is a one-way read of the hardware inventory. There is no process
 * scanning and no automatic game detection: switching to gaming is an explicit
 * user act (CLI, UI or tool), which keeps the assistant out of covert
 * monitoring.
 */

const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PROFILES = {
  idle: {
    name: 'idle',
    label: 'Bezczynny',
    modelClass: 'fast',
    mode: 'fast',
    keepAlive: '2m',
    numCtx: 4096,
    maxParallel: 1,
    heavy: false,
    description: 'mały model, krótki keep-alive; asystent tylko czeka',
  },
  balanced: {
    name: 'balanced',
    label: 'Zbalansowany',
    modelClass: 'balanced',
    mode: 'balanced',
    keepAlive: '10m',
    numCtx: 8192,
    maxParallel: 2,
    heavy: false,
    description: 'domyślny: jeden model 9B, 10 minut w pamięci',
  },
  deep: {
    name: 'deep',
    label: 'Głęboki',
    modelClass: 'deep',
    mode: 'deep',
    keepAlive: '30m',
    numCtx: 16384,
    maxParallel: 2,
    heavy: true,
    description: 'dłuższy kontekst i wieloetapowe zadania; blokowany przy braku VRAM',
  },
  gaming: {
    name: 'gaming',
    label: 'Gry',
    modelClass: 'fast',
    mode: 'fast',
    keepAlive: '0s',
    numCtx: 2048,
    maxParallel: 1,
    heavy: false,
    unloadAll: true,
    description: 'VRAM oddany grze: modele wyładowane, tryb deep odmawiany',
  },
};

const GB = 1024 * 1024 * 1024;

/** Rough 4-bit weight size: ~0.62 GB per billion parameters (Q4_K_M-ish). */
function estimateModelGb(name, { contextTokens = 8192 } = {}) {
  const match = String(name || '').match(/(\d+(?:\.\d+)?)\s*b/i);
  if (!match) return null;
  const params = Number(match[1]);
  if (!Number.isFinite(params) || params <= 0) return null;
  const weights = params * 0.62;
  // KV cache scales with context; the coefficient is a documented approximation,
  // not a benchmark. Labelled as an estimate wherever it is reported.
  const kv = (contextTokens / 1024) * 0.12 * Math.max(1, params / 7);
  return { name, params, weightsGb: Number(weights.toFixed(2)), kvGb: Number(kv.toFixed(2)), totalGb: Number((weights + kv).toFixed(2)), estimated: true };
}

function detectHardware({ spawn = spawnSync, now = () => Date.now(), cacheMs = 5 * 60 * 1000, state = {} } = {}) {
  if (state.hardware && now() - state.hardware.at < cacheMs) return state.hardware.value;
  const cpus = os.cpus() || [];
  const hardware = {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus.length ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    memoryGb: Number((os.totalmem() / GB).toFixed(1)),
    freeMemoryGb: Number((os.freemem() / GB).toFixed(1)),
    gpu: null,
    gpuSource: 'none',
    detectedAt: new Date(now()).toISOString(),
    at: now(),
  };
  try {
    const result = spawn('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 2500, encoding: 'utf8', windowsHide: true });
    if (result && result.status === 0 && result.stdout) {
      const line = String(result.stdout).split('\n').map((entry) => entry.trim()).find(Boolean);
      if (line) {
        const [name, memoryMb, driver] = line.split(',').map((part) => part.trim());
        hardware.gpu = { name, vramGb: Number((Number(memoryMb) / 1024).toFixed(1)), driver: driver || null };
        hardware.gpuSource = 'nvidia-smi';
      }
    }
  } catch {
    /* no NVIDIA GPU or no driver: unknown is the honest answer */
  }
  if (state) state.hardware = { at: now(), value: hardware };
  return hardware;
}

class RuntimeManager {
  constructor({ config = null, llm = null, log = null, now = () => Date.now(), fetchImpl = null, spawn = null, hardware = null } = {}) {
    this.config = config;
    this.llm = llm;
    this.log = log;
    this.now = now;
    this.fetch = fetchImpl || (llm && llm.fetchImpl) || globalThis.fetch;
    this.spawn = spawn || spawnSync;
    this.state = {};
    this.hardware = hardware || detectHardware({ spawn: this.spawn, now, state: this.state });
    this.profile = (config && config.get && config.get('ai.runtime.profile')) || 'balanced';
    if (!PROFILES[this.profile]) this.profile = 'balanced';
    this.history = [];
    this.counters = { switches: 0, unloads: 0, refusals: 0, gamingMinutes: 0, deepRequests: 0, deepRefused: 0 };
  }

  ollamaBase() {
    const providers = (this.config && this.config.get && this.config.get('ai.providers')) || {};
    return (providers.ollama && providers.ollama.baseUrl) || 'http://127.0.0.1:11434';
  }

  activeProfile() {
    return PROFILES[this.profile] || PROFILES.balanced;
  }

  modelFor(modelClass) {
    const models = (this.config && this.config.get && this.config.get('ai.models')) || {};
    return models[modelClass] || models.balanced || 'qwen3.5:9b';
  }

  /**
   * A profile is refused when the estimated footprint does not fit the detected
   * VRAM, and there is no detected GPU fast enough for CPU offload. Refusal is a
   * result, not an exception, and it names the numbers it used.
   */
  feasibility(profileName = this.profile) {
    const profile = PROFILES[profileName];
    if (!profile) return { ok: false, code: 'UNKNOWN_PROFILE', message: `unknown profile ${profileName}` };
    const model = this.modelFor(profile.modelClass);
    const estimate = estimateModelGb(model, { contextTokens: profile.numCtx });
    const vram = this.hardware.gpu ? this.hardware.gpu.vramGb : null;
    if (!estimate) return { ok: true, model, estimate: null, fits: null, note: 'model size is not encoded in its name; no estimate made' };
    // Leave ~1 GB for the desktop compositor and the game.
    const usable = vram ? vram - 1 : null;
    const fits = usable == null ? null : estimate.totalGb <= usable;
    const cpuFallback = usable == null || !fits;
    return {
      ok: profile.heavy ? fits !== false : true,
      code: profile.heavy && fits === false ? 'VRAM_INSUFFICIENT' : null,
      model,
      estimate,
      vramGb: vram,
      usableVramGb: usable,
      fits,
      cpuFallbackPossible: cpuFallback,
      message: profile.heavy && fits === false ? `${model} needs about ${estimate.totalGb} GB (estimate) but only ${usable} GB of VRAM is usable` : null,
    };
  }

  /** The mode that will actually be used, with the reason for a downgrade. */
  effectiveMode(requested, { force = false } = {}) {
    const wanted = ['fast', 'balanced', 'deep', 'research'].includes(requested) ? requested : 'balanced';
    const profile = this.activeProfile();
    const heavyWanted = wanted === 'deep' || wanted === 'research';
    if (heavyWanted) this.counters.deepRequests += 1;
    if (!heavyWanted) return { mode: wanted, reason: null, profile: profile.name };
    if (profile.unloadAll) {
      this.counters.deepRefused += 1;
      return { mode: 'fast', reason: `profile ${profile.name} keeps models unloaded`, profile: profile.name };
    }
    // Heavy work uses the deep model class even when the active profile is
    // balanced, so the fit is checked for that model, not the idle one.
    const feasibility = this.feasibility(PROFILES.deep.name);
    if (feasibility.ok === false && !force) {
      this.counters.deepRefused += 1;
      return { mode: 'balanced', reason: feasibility.message, estimated: true, profile: profile.name };
    }
    return { mode: wanted, reason: null, profile: profile.name };
  }

  /** Real resident models from the provider; an empty list is a real answer. */
  async resident() {
    const ollama = this.config.get && this.config.get('ai.providers.ollama');
    if (!ollama || ollama.enabled === false) return { supported: false, models: [], reason: 'the Ollama provider is disabled' };
    try {
      const response = await this.fetch(`${this.ollamaBase()}/api/ps`, { method: 'GET' });
      if (!response.ok) return { supported: false, models: [], reason: `provider answered HTTP ${response.status}` };
      const payload = await response.json();
      return {
        supported: true,
        models: ((payload && payload.models) || []).map((model) => ({
          name: model.name || model.model,
          sizeGb: Number(((model.size || 0) / GB).toFixed(2)),
          vramGb: Number(((model.size_vram || 0) / GB).toFixed(2)),
          expiresAt: model.expires_at || null,
        })),
      };
    } catch (err) {
      return { supported: false, models: [], reason: err.message };
    }
  }

  async unload(model) {
    const ollama = this.config.get && this.config.get('ai.providers.ollama');
    if (!ollama || ollama.enabled === false) return { ok: false, code: 'PROVIDER_UNSUPPORTED', message: 'keep-alive control is an Ollama feature; this provider cannot unload models' };
    try {
      const response = await this.fetch(`${this.ollamaBase()}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
      if (!response.ok) return { ok: false, code: 'UNLOAD_FAILED', message: `provider answered HTTP ${response.status}` };
      this.counters.unloads += 1;
      if (this.llm && this.llm.healthCache) this.llm.healthCache.clear();
      return { ok: true, model };
    } catch (err) {
      return { ok: false, code: 'UNLOAD_FAILED', message: err.message };
    }
  }

  async apply(profileName, { reason = null, force = false } = {}) {
    const profile = PROFILES[profileName];
    if (!profile) return { ok: false, code: 'UNKNOWN_PROFILE', message: `unknown profile ${profileName}` };
    if (profile.heavy) {
      const feasibility = this.feasibility(profile.name);
      if (feasibility.ok === false && !force) {
        this.counters.refusals += 1;
        return { ok: false, code: 'VRAM_INSUFFICIENT', message: feasibility.message, feasibility };
      }
    }
    const previous = this.profile;
    this.profile = profile.name;
    this.counters.switches += 1;
    this.history.push({ at: new Date(this.now()).toISOString(), from: previous, to: profile.name, reason });
    if (this.history.length > 50) this.history.shift();
    if (this.config && this.config.set) {
      this.config.set('ai.runtime.profile', profile.name);
      if (this.config.get('ai.providers.ollama')) this.config.set('ai.providers.ollama.keepAlive', profile.keepAlive);
    }
    const unloaded = [];
    if (profile.unloadAll) {
      const resident = await this.resident();
      for (const model of resident.models) {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.unload(model.name);
        unloaded.push({ model: model.name, ...result });
      }
    }
    return { ok: true, profile: profile.name, previous, keepAlive: profile.keepAlive, unloaded, history: this.history.slice(-3) };
  }

  async status() {
    const profile = this.activeProfile();
    const feasibility = this.feasibility(profile.name);
    const resident = await this.resident();
    return {
      profile: profile.name,
      profiles: Object.values(PROFILES).map((entry) => ({ name: entry.name, label: entry.label, mode: entry.mode, keepAlive: entry.keepAlive, numCtx: entry.numCtx, heavy: entry.heavy, description: entry.description })),
      profileDetail: profile,
      hardware: this.hardware,
      feasibility,
      resident,
      counters: { ...this.counters },
      estimates: { basis: '~0.62 GB per billion parameters at 4-bit + KV approximation', honest: 'estimates, not measurements' },
      history: this.history.slice(-5),
    };
  }
}

module.exports = { RuntimeManager, PROFILES, estimateModelGb, detectHardware, GB };
