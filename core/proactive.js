'use strict';

/**
 * Opt-in proactive rules.
 *
 * Events are supplied by the caller (task completion, health watchdog, repo
 * monitor). There is no microphone, camera, keystroke or conversation listener
 * here. A rule matches typed conditions; quiet hours, cooldowns, deduplication
 * and daily limits prevent notification storms. Delivery is a callback owned by
 * the caller; without a configured channel nothing is sent and the engine says
 * so rather than pretending a notification was delivered.
 */

const crypto = require('node:crypto');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compare(actual, operator, expected) {
  switch (operator) {
    case 'eq': return JSON.stringify(actual) === JSON.stringify(expected);
    case 'neq': return JSON.stringify(actual) !== JSON.stringify(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'contains': return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    default: return false;
  }
}

class ProactiveEngine {
  constructor({ now = () => Date.now(), quietHours = null, maxPerHour = 4, maxPerDay = 12, store = null, log = null, deliver = null } = {}) {
    this.now = now;
    this.quietHours = Array.isArray(quietHours) && quietHours.length === 2 ? quietHours : null;
    this.maxPerHour = Math.max(1, Number(maxPerHour) || 4);
    this.maxPerDay = Math.max(1, Number(maxPerDay) || 12);
    this.store = store;
    this.log = log;
    this.deliver = typeof deliver === 'function' ? deliver : null;
    this.rules = new Map();
    this.history = [];
    this.seen = new Map();
    this.load();
  }

  load() {
    if (!this.store) return false;
    const state = this.store.get('proactive_state', 'current');
    if (!state) return false;
    this.rules = new Map((state.rules || []).map((rule) => [rule.id, rule]));
    this.history = Array.isArray(state.history) ? state.history.slice(-200) : [];
    this.seen = new Map(state.seen || []);
    return true;
  }

  persist() {
    if (!this.store) return;
    try {
      this.store.put('proactive_state', 'current', { rules: [...this.rules.values()], history: this.history.slice(-200), seen: [...this.seen.entries()].slice(-500) });
    } catch (err) {
      if (this.log) this.log.warn('proactive', `state save failed: ${err.message}`);
    }
  }

  quietNow(at = this.now()) {
    if (!this.quietHours) return false;
    const hour = new Date(at).getHours();
    const [start, end] = this.quietHours;
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  addRule({ name, event, conditions = [], priority = 0.5, cooldownMs = 30 * 60 * 1000, channels = ['desktop'], enabled = true, message = null } = {}) {
    if (!name || !event) return { ok: false, code: 'BAD_RULE', message: 'name and event are required' };
    if (!Array.isArray(conditions) || conditions.some((condition) => !condition || !condition.field || !['eq', 'neq', 'gte', 'lte', 'contains', 'exists'].includes(condition.op))) return { ok: false, code: 'BAD_RULE', message: 'conditions need field and a supported op' };
    const rule = {
      id: `rule_${hash({ name, event }).slice(0, 12)}`,
      name: String(name).slice(0, 200),
      event: String(event).slice(0, 100),
      conditions: conditions.map((condition) => ({ field: String(condition.field), op: condition.op, value: condition.value })),
      priority: Math.max(0, Math.min(1, Number(priority) || 0.5)),
      cooldownMs: Math.max(0, Math.min(7 * 86400000, Number(cooldownMs) || 0)),
      channels: Array.isArray(channels) ? channels.filter((channel) => ['desktop', 'sms', 'email', 'call'].includes(channel)) : ['desktop'],
      enabled: Boolean(enabled),
      message: message ? String(message).slice(0, 500) : null,
      createdAt: this.now(),
    };
    this.rules.set(rule.id, rule);
    this.persist();
    return { ok: true, rule };
  }

  removeRule(id) {
    if (!this.rules.delete(id)) return { ok: false, code: 'NOT_FOUND', message: 'no such rule' };
    this.persist();
    return { ok: true };
  }

  withinLimits(at = this.now()) {
    const hour = this.history.filter((entry) => at - entry.at < 3600000);
    const day = this.history.filter((entry) => at - entry.at < 86400000);
    return { ok: hour.length < this.maxPerHour && day.length < this.maxPerDay, lastHour: hour.length, lastDay: day.length, maxPerHour: this.maxPerHour, maxPerDay: this.maxPerDay };
  }

  evaluate(event = {}) {
    const at = this.now();
    const name = String(event.type || event.event || '');
    if (!name) return { ok: false, code: 'BAD_EVENT', message: 'event.type is required' };
    const matches = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.event !== name) continue;
      if (!rule.conditions.every((condition) => compare(event[condition.field] ?? (event.data ? event.data[condition.field] : undefined), condition.op, condition.value))) continue;
      const dedupeKey = `${rule.id}:${event.id || hash(event)}`;
      const last = this.seen.get(rule.id) || 0;
      if (at - last < rule.cooldownMs) {
        matches.push({ ruleId: rule.id, name: rule.name, suppressed: 'cooldown', cooldownRemainingMs: rule.cooldownMs - (at - last) });
        continue;
      }
      if (this.quietNow(at)) {
        matches.push({ ruleId: rule.id, name: rule.name, suppressed: 'quiet-hours' });
        continue;
      }
      const limits = this.withinLimits(at);
      if (!limits.ok) {
        matches.push({ ruleId: rule.id, name: rule.name, suppressed: 'rate-limit', limits });
        continue;
      }
      const notification = {
        id: `notif_${hash({ rule: rule.id, event: event.id || hash(event), at }).slice(0, 16)}`,
        ruleId: rule.id,
        name: rule.name,
        event: name,
        message: rule.message || `${rule.name}: ${event.title || event.summary || name}`,
        priority: rule.priority,
        channels: rule.channels,
        at,
        delivered: false,
        delivery: null,
      };
      matches.push(notification);
      this.seen.set(rule.id, at);
      this.history.push({ ...notification, delivered: false });
    }
    const candidates = matches.filter((match) => !match.suppressed);
    let delivered = 0;
    if (this.deliver) {
      for (const notification of candidates) {
        try {
          const result = this.deliver(notification);
          notification.delivery = result && result.ok === false ? { ok: false, code: result.code || 'DELIVERY_FAILED' } : { ok: true, channel: notification.channels[0] };
          notification.delivered = notification.delivery.ok;
          if (notification.delivered) delivered += 1;
        } catch (err) {
          notification.delivery = { ok: false, code: 'DELIVERY_EXCEPTION', message: err.message };
        }
      }
    } else {
      for (const notification of candidates) notification.delivery = { ok: false, code: 'NOT_CONFIGURED', message: 'no delivery channel configured' };
    }
    for (const notification of this.history) {
      const updated = candidates.find((candidate) => candidate.id === notification.id);
      if (updated) {
        notification.delivered = updated.delivered;
        notification.delivery = updated.delivery;
      }
    }
    this.persist();
    return { ok: true, event: name, matched: matches.length, candidates: candidates.length, delivered, notifications: candidates, suppressed: matches.filter((match) => match.suppressed) };
  }

  status() {
    const at = this.now();
    return {
      rules: [...this.rules.values()],
      counts: { rules: this.rules.size, enabled: [...this.rules.values()].filter((rule) => rule.enabled).length, history: this.history.length, deliveredToday: this.history.filter((entry) => entry.delivered && at - entry.at < 86400000).length },
      limits: { maxPerHour: this.maxPerHour, maxPerDay: this.maxPerDay },
      quietHours: this.quietHours,
      quietNow: this.quietNow(at),
      deliveryConfigured: Boolean(this.deliver),
      honesty: 'opt-in, event-driven, caller-supplied events only; no microphone, camera or conversation monitoring',
    };
  }
}

module.exports = { ProactiveEngine, compare };
