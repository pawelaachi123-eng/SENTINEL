'use strict';

/**
 * Reliability primitives.
 *
 * The failures this exists for are the ones that actually happen on a home PC:
 * Ollama is not running, the model takes 40 seconds, SQLite was left locked, a
 * provider returns 500 three times in a row, a task was interrupted by a reboot.
 *
 *   CircuitBreaker — stop hammering a dependency that is clearly down, and probe
 *                    it again with backoff instead of on every request.
 *   retry          — bounded exponential backoff with jitter for idempotent work.
 *   IncidentLog    — what broke, when, and whether it recovered, kept bounded.
 *   Watchdog       — periodic health probe with hysteresis (no flapping).
 */

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

class CircuitBreaker {
  constructor({ name = 'dependency', failureThreshold = 3, recoveryMs = 30000, halfOpenMax = 1, now = () => Date.now() } = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, failureThreshold);
    this.recoveryMs = Math.max(1000, recoveryMs);
    this.halfOpenMax = Math.max(1, halfOpenMax);
    this.now = now;
    this.state = STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
    this.counters = { successes: 0, failures: 0, shortCircuits: 0, opens: 0, recoveries: 0 };
    this.lastError = null;
  }

  canAttempt() {
    if (this.state === STATES.CLOSED) return true;
    if (this.state === STATES.OPEN) {
      if (this.now() - this.openedAt >= this.recoveryMs) {
        this.state = STATES.HALF_OPEN;
        this.halfOpenAttempts = 0;
        return true;
      }
      this.counters.shortCircuits += 1;
      return false;
    }
    if (this.halfOpenAttempts >= this.halfOpenMax) {
      this.counters.shortCircuits += 1;
      return false;
    }
    return true;
  }

  success() {
    this.counters.successes += 1;
    this.consecutiveFailures = 0;
    if (this.state !== STATES.CLOSED) this.counters.recoveries += 1;
    this.state = STATES.CLOSED;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }

  failure(error = null) {
    this.counters.failures += 1;
    this.lastError = error ? String(error.message || error) : this.lastError;
    this.consecutiveFailures += 1;
    if (this.state === STATES.HALF_OPEN) {
      this.trip();
      return;
    }
    if (this.state === STATES.CLOSED && this.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  trip() {
    this.state = STATES.OPEN;
    this.openedAt = this.now();
    this.halfOpenAttempts = 0;
    this.counters.opens += 1;
  }

  reset() {
    this.state = STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }

  async run(fn) {
    if (!this.canAttempt()) {
      throw Object.assign(new Error(`${this.name} is temporarily unavailable (circuit open)`), { code: 'CIRCUIT_OPEN', dependency: this.name });
    }
    if (this.state === STATES.HALF_OPEN) this.halfOpenAttempts += 1;
    try {
      const result = await fn();
      this.success();
      return result;
    } catch (err) {
      this.failure(err);
      throw err;
    }
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryInMs: this.state === STATES.OPEN ? Math.max(0, this.recoveryMs - (this.now() - this.openedAt)) : 0,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }
}

/** Exponential backoff with full jitter; never retries a non-retryable code. */
async function retry(fn, { attempts = 3, baseMs = 250, maxMs = 8000, signal = null, retryable = null, onRetry = null } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const allowed = retryable ? retryable(err) : !['CANCELLED', 'INVALID_ARGS', 'BAD_ARGS', 'APPROVAL_REQUIRED', 'PROTECTED', 'PERMISSION_DENIED'].includes(err.code);
      if (!allowed || attempt === attempts) break;
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      if (onRetry) {
        try {
          onRetry({ attempt, delay, code: err.code || 'FAILED', message: err.message });
        } catch {
          /* listener errors are not retry failures */
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

class IncidentLog {
  constructor({ capacity = 200, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.now = now;
    this.items = [];
    this.open = new Map();
    this.counters = { opened: 0, recovered: 0, repeated: 0 };
  }

  /** Opens or bumps an incident keyed by subsystem+code. */
  report({ subsystem, code, message, severity = 'warn', detail = null }) {
    const key = `${subsystem}:${code}`;
    const existing = this.open.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = this.now();
      existing.message = message || existing.message;
      this.counters.repeated += 1;
      return existing;
    }
    const incident = {
      id: `inc_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      subsystem,
      code,
      message: message || code,
      severity,
      detail,
      count: 1,
      openedAt: this.now(),
      lastAt: this.now(),
      recoveredAt: null,
    };
    this.open.set(key, incident);
    this.items.unshift(incident);
    if (this.items.length > this.capacity) this.items.length = this.capacity;
    this.counters.opened += 1;
    return incident;
  }

  recover(subsystem, code = null) {
    let recovered = 0;
    for (const [key, incident] of this.open) {
      if (incident.subsystem !== subsystem) continue;
      if (code && incident.code !== code) continue;
      incident.recoveredAt = this.now();
      this.open.delete(key);
      recovered += 1;
      this.counters.recovered += 1;
    }
    return recovered;
  }

  active() {
    return [...this.open.values()];
  }

  list(limit = 50) {
    return this.items.slice(0, limit);
  }

  stats() {
    return { active: this.open.size, counters: { ...this.counters }, recent: this.items.slice(0, 5) };
  }
}

/**
 * Runs an async health probe on an interval. Changes state only after
 * `confirmations` consecutive results, which is what keeps a single slow probe
 * from flapping every dashboard light.
 */
class Watchdog {
  constructor({ name, probe, intervalMs = 30000, confirmations = 2, onTransition = null, now = () => Date.now(), timers = { setInterval, clearInterval } } = {}) {
    this.name = name;
    this.probe = probe;
    this.intervalMs = intervalMs;
    this.confirmations = Math.max(1, confirmations);
    this.onTransition = onTransition;
    this.now = now;
    this.timers = timers;
    this.timer = null;
    this.healthy = null;
    this.pending = 0;
    this.last = null;
    this.checks = 0;
    this.failures = 0;
  }

  async check() {
    this.checks += 1;
    let result;
    try {
      result = await this.probe();
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    this.failures += result.ok ? 0 : 1;
    this.last = { at: this.now(), ...result };
    const next = Boolean(result.ok);
    if (this.healthy === null) {
      this.healthy = next;
      return this.last;
    }
    if (next === this.healthy) {
      this.pending = 0;
      return this.last;
    }
    this.pending += 1;
    if (this.pending >= this.confirmations) {
      const previous = this.healthy;
      this.healthy = next;
      this.pending = 0;
      if (this.onTransition) {
        try {
          this.onTransition({ name: this.name, from: previous, to: next, detail: result });
        } catch {
          /* ignore */
        }
      }
    }
    return this.last;
  }

  start() {
    if (this.timer) return;
    this.timer = this.timers.setInterval(() => {
      this.check().catch(() => {});
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return { name: this.name, healthy: this.healthy, last: this.last, checks: this.checks, failures: this.failures, running: Boolean(this.timer) };
  }
}

module.exports = { CircuitBreaker, retry, IncidentLog, Watchdog, CIRCUIT_STATES: STATES };
