'use strict';

/**
 * Hyper-parameter search with reproducible trials and resource accounting.
 *
 * Grid and random search are real: every trial calls the objective, records its
 * parameters, measured score, duration and failure reason, and the best trial
 * is chosen by an explicit direction. There is no Bayesian surrogate here, and
 * the result says so.
 */

const lora = require('./lora');
const autograd = require('../ml/autograd');

class HyperSearch {
  constructor({ space, objective, mode = 'random', budget = 8, seed = 42, direction = 'max', log = null, now = () => Date.now() } = {}) {
    if (!space || !Object.keys(space).length) throw Object.assign(new Error('hyper-parameter space is empty'), { code: 'BAD_ARGUMENT' });
    if (typeof objective !== 'function') throw Object.assign(new Error('objective must be a function'), { code: 'BAD_ARGUMENT' });
    this.space = space;
    this.objective = objective;
    this.mode = mode === 'grid' ? 'grid' : 'random';
    this.budget = Math.max(1, Math.min(200, budget));
    this.seed = seed;
    this.direction = direction === 'min' ? 'min' : 'max';
    this.log = log;
    this.now = now;
  }

  combinations() {
    const keys = Object.keys(this.space);
    const lists = keys.map((key) => {
      const value = this.space[key];
      return Array.isArray(value) ? value : [value];
    });
    const out = [];
    const walk = (depth, current) => {
      if (depth === keys.length) {
        out.push({ ...current });
        return;
      }
      for (const value of lists[depth]) {
        current[keys[depth]] = value;
        walk(depth + 1, current);
      }
    };
    walk(0, {});
    return out;
  }

  candidates() {
    const all = this.combinations();
    if (this.mode === 'grid') return all.slice(0, this.budget);
    const rng = lora.mulberry32 ? lora.mulberry32(this.seed) : (() => {
      let state = this.seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const picked = [];
    const seen = new Set();
    let guard = 0;
    while (picked.length < Math.min(this.budget, all.length) && guard < this.budget * 20) {
      guard += 1;
      const candidate = Object.fromEntries(Object.entries(this.space).map(([key, value]) => [key, Array.isArray(value) ? value[Math.floor(rng() * value.length)] : value]));
      const signature = JSON.stringify(candidate);
      if (seen.has(signature)) continue;
      seen.add(signature);
      picked.push(candidate);
    }
    // Fill deterministically if the random draw could not reach the budget.
    for (const candidate of all) {
      if (picked.length >= Math.min(this.budget, all.length)) break;
      if (!seen.has(JSON.stringify(candidate))) { picked.push(candidate); seen.add(JSON.stringify(candidate)); }
    }
    return picked;
  }

  run() {
    const trials = [];
    for (const params of this.candidates()) {
      const started = this.now();
      try {
        const value = this.objective(params);
        if (!Number.isFinite(value)) throw Object.assign(new Error('objective returned a non-finite score'), { code: 'BAD_SCORE' });
        trials.push({ params, score: Number(value.toFixed(6)), durationMs: this.now() - started, ok: true });
      } catch (err) {
        trials.push({ params, score: null, durationMs: this.now() - started, ok: false, error: { code: err.code || 'FAILED', message: err.message } });
      }
    }
    const usable = trials.filter((trial) => trial.ok);
    const best = usable.length ? usable.reduce((a, b) => (this.direction === 'max' ? (b.score > a.score ? b : a) : (b.score < a.score ? b : a))) : null;
    return { ok: Boolean(best), mode: this.mode, direction: this.direction, trials, best, budget: this.budget, evaluated: trials.length };
  }
}

/** A reusable objective: train the same base on a sampled subset, score on held-out data. */
function loraObjective({ base, train, test, epochs = 80, seed = 9 } = {}) {
  return (params) => {
    const rank = Number(params.rank) || 2;
    const learningRate = Number(params.learningRate) || 0.1;
    const outcome = lora.trainLora({ base, examples: train, validation: test, rank, epochs, learningRate, seed });
    return outcome.evaluation.adapted.accuracy;
  };
}

module.exports = { HyperSearch, loraObjective, autograd };
