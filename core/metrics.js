'use strict';

/**
 * Metrics that are measured, not decorated.
 *
 * A bounded reservoir per metric (default 512 samples) keeps memory flat while
 * still giving honest p50/p95. Nothing here fabricates a number: an empty metric
 * reports `null` rather than 0, because "no data" and "zero" are different
 * answers.
 */

class Reservoir {
  constructor(capacity = 512) {
    this.capacity = Math.max(32, capacity);
    this.values = [];
    this.count = 0;
    this.sum = 0;
    this.min = null;
    this.max = null;
    this.last = null;
  }

  add(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    this.count += 1;
    this.sum += number;
    this.last = number;
    this.min = this.min === null ? number : Math.min(this.min, number);
    this.max = this.max === null ? number : Math.max(this.max, number);
    this.values.push(number);
    if (this.values.length > this.capacity) {
      // Keep a uniformly thinned sample: cheap, deterministic and unbiased
      // enough for latency percentiles.
      const keep = [];
      for (let index = 0; index < this.values.length; index += 1) {
        if (index % 2 === 0) keep.push(this.values[index]);
      }
      this.values = keep;
    }
  }

  percentile(p) {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rank];
  }

  snapshot() {
    return {
      count: this.count,
      samples: this.values.length,
      p50: this.percentile(50),
      p95: this.percentile(95),
      min: this.min,
      max: this.max,
      last: this.last,
      mean: this.count ? Number((this.sum / this.count).toFixed(2)) : null,
    };
  }
}

class Metrics {
  constructor({ now = () => Date.now(), log = null } = {}) {
    this.now = now;
    this.log = log;
    this.series = new Map();
    this.counters = {};
    this.gauges = {};
    this.startedAt = now();
    this.baseline = null;
  }

  series_(name) {
    if (!this.series.has(name)) this.series.set(name, new Reservoir());
    return this.series.get(name);
  }

  observe(name, value) {
    this.series_(name).add(value);
    return value;
  }

  /** Times an async function and records its duration even when it throws. */
  async time(name, fn) {
    const started = this.now();
    try {
      const result = await fn();
      this.observe(name, this.now() - started);
      return result;
    } catch (err) {
      this.observe(name, this.now() - started);
      this.increment(`${name}.errors`);
      throw err;
    }
  }

  increment(name, by = 1) {
    this.counters[name] = (this.counters[name] || 0) + by;
    return this.counters[name];
  }

  gauge(name, value) {
    this.gauges[name] = value;
    return value;
  }

  /** Snapshot for /api/metrics and for the performance tests. */
  snapshot() {
    const series = {};
    for (const [name, reservoir] of this.series) series[name] = reservoir.snapshot();
    return {
      uptimeMs: this.now() - this.startedAt,
      series,
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      baseline: this.baseline,
    };
  }

  /**
   * Records a labelled baseline (startup time, idle memory, first-token latency)
   * so a later optimisation can be compared with something real.
   */
  recordBaseline(label, values = {}) {
    this.baseline = { label, at: new Date(this.now()).toISOString(), ...values };
    return this.baseline;
  }

  compare(label, values = {}) {
    if (!this.baseline) return null;
    const deltas = {};
    for (const [key, value] of Object.entries(values)) {
      const before = this.baseline[key];
      if (typeof before === 'number' && typeof value === 'number' && before !== 0) {
        deltas[key] = {
          before,
          after: value,
          delta: Number((value - before).toFixed(2)),
          percent: Number((((value - before) / before) * 100).toFixed(1)),
        };
      }
    }
    return { label, comparedWith: this.baseline.label, at: new Date(this.now()).toISOString(), deltas };
  }
}

module.exports = { Metrics, Reservoir };
