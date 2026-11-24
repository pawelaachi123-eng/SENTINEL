'use strict';

/**
 * Approval queue for operations that change the machine.
 *
 * The model can *ask* to do something privileged; it can never grant itself the
 * permission. A request sits here with the exact tool and arguments, the user
 * sees it in the UI (or the CLI), and only then does it run — once.
 *
 * Rules encoded here:
 *   • every request expires (5 minutes) instead of lingering
 *   • approving executes the *stored* call, not whatever the model says now
 *   • one approval authorises exactly one call
 *   • denials are recorded, so repeated attempts are visible
 */

const crypto = require('node:crypto');

const TTL_MS = 5 * 60 * 1000;

class ApprovalQueue {
  constructor({ log, store = null, now = () => Date.now() } = {}) {
    this.log = log;
    this.store = store;
    this.now = now;
    this.pending = new Map();
    this.history = [];
    this.waiters = new Map();
    this.counters = { requested: 0, approved: 0, denied: 0, expired: 0 };
  }

  request({ tool, args, permission, reason, requestedBy = 'assistant', runId = null }) {
    const id = `apr_${crypto.randomBytes(6).toString('hex')}`;
    const entry = {
      id,
      tool,
      args,
      permission,
      reason: reason || `${tool} changes something on this machine`,
      requestedBy,
      runId,
      status: 'pending',
      createdAt: this.now(),
      expiresAt: this.now() + TTL_MS,
    };
    this.pending.set(id, entry);
    this.counters.requested += 1;
    if (this.log) this.log.warn('approval', `awaiting approval: ${tool}`, { id, permission });
    return entry;
  }

  get(id) {
    return this.pending.get(id) || null;
  }

  list({ includeSettled = false } = {}) {
    this.sweep();
    const items = includeSettled ? [...this.pending.values(), ...this.history.slice(-50)] : [...this.pending.values()];
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  sweep() {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt > now) continue;
      entry.status = 'expired';
      this.pending.delete(id);
      this.history.push(entry);
      this.counters.expired += 1;
      this.notify(id, entry);
    }
  }

  /** Resolves a waiting caller exactly once. */
  wait(id, timeoutMs = 60000) {
    const entry = this.pending.get(id);
    if (!entry) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, Math.min(timeoutMs, TTL_MS));
      if (timer.unref) timer.unref();
      this.waiters.set(id, (settled) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(settled);
      });
    });
  }

  notify(id, entry) {
    const waiter = this.waiters.get(id);
    if (waiter) waiter(entry);
  }

  /**
   * Marks a pending approval as granted by a human without executing it.
   * Used by the task executor, which owns the execution and then consumes the
   * approval itself. Consent stays a human action; `consume` still burns it.
   */
  approve(id, { by = 'user' } = {}) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'unknown, expired or already used approval' };
    entry.approvedByUser = true;
    entry.status = 'approved';
    entry.decidedAt = this.now();
    entry.decidedBy = by;
    this.notify(id, entry);
    return { ok: true, entry };
  }

  deny(id, { by = 'user', reason = '' } = {}) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, code: 'NOT_FOUND' };
    entry.status = 'denied';
    entry.decidedAt = this.now();
    entry.decidedBy = by;
    entry.deniedReason = reason;
    this.pending.delete(id);
    this.history.push(entry);
    this.counters.denied += 1;
    if (this.log) this.log.warn('approval', `denied: ${entry.tool}`, { id, reason });
    this.notify(id, entry);
    return { ok: true, entry };
  }

  /**
   * Atomically validates and burns an approval. A granted approval authorises
   * exactly one execution of exactly the call the user saw.
   */
  consume(id, { tool, args }) {
    const entry = this.pending.get(id);
    if (!entry) {
      return { ok: false, code: 'APPROVAL_NOT_FOUND', message: 'unknown, expired or already used approval' };
    }
    if (entry.tool !== tool) {
      return { ok: false, code: 'APPROVAL_MISMATCH', message: 'this approval was for a different tool' };
    }
    if (!sameArgs(entry.args, args)) {
      return { ok: false, code: 'APPROVAL_MISMATCH', message: 'the approved arguments differ from this request' };
    }
    entry.status = 'approved';
    entry.decidedAt = this.now();
    entry.decidedBy = 'user';
    this.pending.delete(id);
    this.history.push(entry);
    this.counters.approved += 1;
    if (this.log) this.log.info('approval', `approved and used: ${entry.tool}`, { id });
    this.notify(id, entry);
    return { ok: true, entry };
  }

  stats() {
    this.sweep();
    return { pending: this.pending.size, counters: { ...this.counters }, ttlMs: TTL_MS };
  }
}

function sameArgs(a, b) {
  try {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  } catch {
    return false;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

module.exports = { ApprovalQueue, TTL_MS };
