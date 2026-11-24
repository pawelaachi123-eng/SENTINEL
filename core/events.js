'use strict';

/**
 * Typed internal event bus.
 *
 * Every event carries an id, a monotonic sequence number, a timestamp, a schema
 * version, a topic and an optional correlation id (a run, a task, an approval).
 * The UI renders from these events; nothing on screen is invented locally.
 *
 * Design choices:
 *   • synchronous delivery to subscribers, each isolated so one bad listener
 *     cannot break a run;
 *   • a bounded ring buffer (default 500) so a long-running agent cannot leak;
 *   • an optional store so the last events survive a restart and the timeline is
 *     not empty after an update.
 */

const SCHEMA_VERSION = 1;

const TOPICS = {
  RUN: 'run',
  STAGE: 'stage',
  TOOL: 'tool',
  APPROVAL: 'approval',
  TASK: 'task',
  MEMORY: 'memory',
  KNOWLEDGE: 'knowledge',
  MODEL: 'model',
  DEVICE: 'device',
  DIAGNOSTIC: 'diagnostic',
  SYSTEM: 'system',
  UI: 'ui',
};

class EventBus {
  constructor({ log = null, store = null, capacity = 500, now = () => Date.now() } = {}) {
    this.log = log;
    this.store = store;
    this.capacity = Math.max(50, capacity);
    this.now = now;
    this.seq = 0;
    this.buffer = [];
    this.subscribers = new Set();
    this.counters = { published: 0, dropped: 0, failed: 0 };
    this.load();
  }

  load() {
    if (!this.store) return;
    try {
      const saved = this.store.getMeta ? this.store.getMeta('events') : null;
      if (Array.isArray(saved)) {
        this.buffer = saved.slice(-this.capacity);
        this.seq = this.buffer.reduce((max, event) => Math.max(max, event.seq || 0), 0);
      }
    } catch {
      /* a damaged event log is not worth failing a boot over */
    }
  }

  persistDebounced() {
    if (!this.store || !this.store.setMeta) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.store.setMeta('events', this.buffer.slice(-this.capacity));
      } catch {
        /* ignore */
      }
    }, 500);
    if (this.persistTimer.unref) this.persistTimer.unref();
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * @param {string} topic one of TOPICS
   * @param {object} payload free-form, but must be JSON-safe
   * @param {{correlationId?: string, severity?: 'info'|'warn'|'error'}} meta
   */
  publish(topic, payload = {}, meta = {}) {
    const event = {
      id: `evt_${this.now().toString(36)}_${(this.seq + 1).toString(36)}`,
      seq: ++this.seq,
      topic: String(topic || 'system'),
      schema: SCHEMA_VERSION,
      at: new Date(this.now()).toISOString(),
      ts: this.now(),
      severity: meta.severity || 'info',
      correlationId: meta.correlationId || payload.runId || payload.taskId || null,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.counters.dropped += 1;
    }
    this.counters.published += 1;
    this.persistDebounced();
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch (err) {
        this.counters.failed += 1;
        if (this.log) this.log.debug('events', `subscriber threw: ${err.message}`);
      }
    }
    return event;
  }

  /** Convenience wrappers so call sites read as what happened, not as plumbing. */
  run(correlationId, payload) {
    return this.publish(TOPICS.RUN, { ...payload }, { correlationId });
  }

  stage(correlationId, stage, detail = {}) {
    return this.publish(TOPICS.STAGE, { stage, ...detail }, { correlationId });
  }

  tool(correlationId, name, outcome = {}) {
    return this.publish(TOPICS.TOOL, { name, ...outcome }, { correlationId, severity: outcome.ok === false ? 'warn' : 'info' });
  }

  task(correlationId, action, detail = {}) {
    return this.publish(TOPICS.TASK, { action, ...detail }, { correlationId });
  }

  model(correlationId, action, detail = {}) {
    return this.publish(TOPICS.MODEL, { action, ...detail }, { correlationId, severity: detail.ok === false ? 'warn' : 'info' });
  }

  recent({ limit = 100, topic = null, correlationId = null, sinceSeq = 0 } = {}) {
    const wanted = Math.max(1, Math.min(Number(limit) || 100, this.capacity));
    let events = this.buffer;
    if (topic) events = events.filter((event) => event.topic === topic);
    if (correlationId) events = events.filter((event) => event.correlationId === correlationId);
    if (sinceSeq) events = events.filter((event) => event.seq > sinceSeq);
    return events.slice(-wanted);
  }

  stats() {
    return {
      published: this.counters.published,
      dropped: this.counters.dropped,
      failed: this.counters.failed,
      buffered: this.buffer.length,
      capacity: this.capacity,
      subscribers: this.subscribers.size,
      lastSeq: this.seq,
      topics: [...new Set(this.buffer.map((event) => event.topic))],
    };
  }

  clear() {
    this.buffer = [];
    this.persistDebounced();
  }
}

module.exports = { EventBus, TOPICS, EVENTS_SCHEMA_VERSION: SCHEMA_VERSION };
