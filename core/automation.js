'use strict';

/**
 * Automations: recurring work the user asked for, in advance.
 *
 * Two action kinds:
 *   • prompt   — ask the assistant the same question on a schedule; the answer
 *                lands in the activity feed and the phone.
 *   • command  — run one command from the existing catalogue. Policy, quiet
 *                hours and approvals still apply, exactly as if it came from
 *                the UI. An automation is not a privilege escalation.
 *
 * Triggers are deliberately boring: every N minutes, or daily at HH:MM. A cron
 * parser would add surface area for no benefit here.
 *
 * Nothing runs while the machine is asleep — a missed run is not back-filled,
 * because "your PC shut down for two days" should not mean 288 queued actions.
 */

const { newId } = require('./memory/store');

const MIN_INTERVAL_MINUTES = 5;

class AutomationEngine {
  constructor({ store, log, config, commander = null, brain = null, now = () => Date.now() }) {
    this.store = store || null;
    this.log = log;
    this.config = config;
    this.commander = commander;
    this.brain = brain;
    this.now = now;
    this.collection = 'automations';
    this.items = new Map();
    this.timers = new Map();
    this.history = [];
    this.running = false;
    this.counters = { created: 0, runs: 0, failures: 0, skipped: 0 };
    this.load();
  }

  load() {
    if (!this.store) return;
    for (const record of this.store.list(this.collection)) this.items.set(record.id, record);
  }

  persist(item) {
    item.updatedAt = this.now();
    this.items.set(item.id, item);
    if (this.store) this.store.put(this.collection, item.id, item);
    return item;
  }

  create({ name, trigger = {}, action = {}, enabled = true, createdBy = 'user' } = {}) {
    const title = String(name || '').trim();
    if (!title) throw Object.assign(new Error('an automation needs a name'), { code: 'BAD_ARGS' });
    const type = ['interval', 'daily'].includes(trigger.type) ? trigger.type : 'interval';
    const everyMinutes = Math.max(MIN_INTERVAL_MINUTES, Number(trigger.everyMinutes) || 60);
    const at = /^\d{1,2}:\d{2}$/.test(String(trigger.at || '')) ? String(trigger.at) : '08:00';
    const actionType = action.type === 'command' ? 'command' : 'prompt';
    if (actionType === 'command' && !action.command) throw Object.assign(new Error('a command automation needs a command'), { code: 'BAD_ARGS' });
    if (actionType === 'prompt' && !action.prompt) throw Object.assign(new Error('a prompt automation needs a prompt'), { code: 'BAD_ARGS' });

    const item = {
      id: newId('auto'),
      name: title,
      enabled: Boolean(enabled),
      trigger: { type, everyMinutes, at },
      action: { type: actionType, prompt: action.prompt || null, command: action.command || null, args: action.args || {} },
      createdBy,
      createdAt: this.now(),
      updatedAt: this.now(),
      lastRunAt: null,
      lastResult: null,
      runCount: 0,
      failCount: 0,
    };
    this.counters.created += 1;
    this.persist(item);
    if (this.running && item.enabled) this.schedule(item);
    if (this.log) this.log.info('automation', `created "${item.name}" (${type === 'interval' ? `every ${everyMinutes} min` : `daily at ${at}`})`);
    return item;
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.items.get(id) || null;
  }

  toggle(id, enabled) {
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error(`no automation ${id}`), { code: 'NOT_FOUND' });
    item.enabled = Boolean(enabled);
    this.persist(item);
    this.unschedule(id);
    if (item.enabled && this.running) this.schedule(item);
    if (this.log) this.log.info('automation', `${item.enabled ? 'enabled' : 'paused'} "${item.name}"`);
    return item;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return false;
    this.unschedule(id);
    this.items.delete(id);
    if (this.store) this.store.delete(this.collection, id);
    if (this.log) this.log.info('automation', `deleted "${item.name}"`);
    return true;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    for (const item of this.items.values()) if (item.enabled) this.schedule(item);
    if (this.log) this.log.info('automation', `${[...this.items.values()].filter((item) => item.enabled).length} automation(s) scheduled`);
    return this;
  }

  stop() {
    this.running = false;
    for (const id of [...this.timers.keys()]) this.unschedule(id);
  }

  schedule(item) {
    this.unschedule(item.id);
    const delay = this.nextDelay(item);
    const timer = setTimeout(async () => {
      this.timers.delete(item.id);
      await this.run(item.id, { trigger: 'schedule' });
      const fresh = this.items.get(item.id);
      if (fresh && fresh.enabled && this.running) this.schedule(fresh);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(item.id, timer);
    item.nextRunAt = this.now() + delay;
    this.persist(item);
    return delay;
  }

  unschedule(id) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  nextDelay(item) {
    if (item.trigger.type === 'interval') return Math.max(1000, item.trigger.everyMinutes * 60 * 1000);
    const [hour, minute] = item.trigger.at.split(':').map(Number);
    const now = new Date(this.now());
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  async run(id, { trigger = 'manual' } = {}) {
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error(`no automation ${id}`), { code: 'NOT_FOUND' });
    const started = this.now();
    let result;
    try {
      if (item.action.type === 'command') {
        const outcome = await this.commander.execute(item.action.command, { ...(item.action.args || {}) }, { source: 'automation' });
        result = { ok: true, kind: 'command', data: outcome.data, ms: outcome.ms };
      } else {
        if (!this.brain || !this.brain.ask) throw Object.assign(new Error('the assistant is not available'), { code: 'BRAIN_NOT_READY' });
        const answer = await this.brain.ask({ text: item.action.prompt, mode: 'fast', sessionId: `automation:${item.id}` });
        result = { ok: Boolean(answer.text), kind: 'prompt', text: String(answer.text || '').slice(0, 2000), agent: answer.agent, ms: answer.ms };
      }
    } catch (err) {
      this.counters.failures += 1;
      result = { ok: false, kind: item.action.type, code: err.code || 'FAILED', message: err.message, ms: this.now() - started };
      if (this.log) this.log.warn('automation', `"${item.name}" failed: ${err.message}`);
    }
    this.counters.runs += 1;
    item.runCount += 1;
    if (!result.ok) item.failCount += 1;
    item.lastRunAt = this.now();
    item.lastResult = result;
    this.persist(item);
    this.history.unshift({ id: item.id, name: item.name, trigger, at: item.lastRunAt, ...result });
    if (this.history.length > 60) this.history.length = 60;
    if (this.log) this.log.info('automation', `"${item.name}" ran (${result.ok ? 'ok' : 'failed'})`, { trigger });
    return { automation: item.name, trigger, ...result };
  }

  stats() {
    return {
      automations: this.items.size,
      enabled: [...this.items.values()].filter((item) => item.enabled).length,
      counters: { ...this.counters },
      recent: this.history.slice(0, 10),
    };
  }
}

module.exports = { AutomationEngine, MIN_INTERVAL_MINUTES };
