'use strict';

/**
 * The brain: a small, honest advisory layer.
 *
 * It watches the machine (CPU, memory, ESP32 link, command failures, policy
 * windows) and turns what it sees into statements a person can act on:
 *
 *   "CPU has been above 85% for 8 minutes"
 *   "the ESP32 link dropped four times in ten minutes"
 *   "quiet hours start in 20 minutes — a shutdown now would be refused"
 *
 * Design rules, deliberately conservative:
 *
 *   1. It never runs a command by itself. It can *offer* one; a human taps it.
 *   2. Every insight says which numbers produced it, so it can be checked.
 *   3. Hysteresis and cooldowns: an insight appears once, stays while the
 *      condition holds, and does not nag after it clears.
 *   4. Nothing leaves the machine. There is no model, no service, no telemetry —
 *      just explicit rules that can be read in one sitting.
 *
 * This file is pure logic: give it snapshots and a clock and it returns
 * insights. That makes it testable without a PC, a phone or a network.
 */

const RULES = [
  {
    id: 'cpu-sustained',
    level: 'warn',
    cooldownMs: 10 * 60 * 1000,
    /** Five consecutive samples over 85% is "sustained", one spike is not. */
    test(view) {
      const hot = view.cpu.slice(-5).filter((value) => value >= 85).length;
      if (hot < 5) return null;
      const avg = Math.round(view.cpu.slice(-5).reduce((a, b) => a + b, 0) / 5);
      return {
        title: 'The CPU has been pinned for a while',
        detail: `${avg}% average over the last ${view.cpu.slice(-5).length} samples (${view.cpuModel || 'unknown CPU'}).`,
        action: { label: 'Look at the agent', cmd: 'agent.status' },
      };
    },
  },
  {
    id: 'memory-tight',
    level: 'warn',
    cooldownMs: 15 * 60 * 1000,
    test(view) {
      if (!view.memoryPercent || view.memoryPercent < 92) return null;
      return {
        title: 'Memory is nearly full',
        detail: `${view.memoryPercent}% of ${view.memoryTotalLabel} is in use. A shutdown may take longer than usual.`,
      };
    },
  },
  {
    id: 'esp-flapping',
    level: 'warn',
    cooldownMs: 10 * 60 * 1000,
    test(view) {
      if (view.espDrops < 3) return null;
      return {
        title: 'The ESP32 link keeps dropping',
        detail: `${view.espDrops} disconnects in ten minutes. Usually Wi-Fi signal or a weak USB supply.`,
        action: { label: 'Ask the ESP32 how it feels', cmd: 'esp.status' },
      };
    },
  },
  {
    id: 'esp-missing',
    level: 'info',
    cooldownMs: 60 * 60 * 1000,
    test(view) {
      if (view.espConnected || view.uptimeSec < 900) return null;
      return {
        title: 'No ESP32 has linked yet',
        detail:
          'Hard power, power cycling and reset need the ESP32. Until it links, the PC can only be controlled while it is running.',
        action: { label: 'Show the pairing details', cmd: 'agent.status' },
      };
    },
  },
  {
    id: 'failures',
    level: 'warn',
    cooldownMs: 5 * 60 * 1000,
    test(view) {
      if (view.recentFailures < 3) return null;
      return {
        title: 'Commands are failing',
        detail: `${view.recentFailures} failures in the last five minutes (last: ${view.lastFailure}). Check the activity log for the exact code.`,
      };
    },
  },
  {
    id: 'quiet-hours-soon',
    level: 'info',
    cooldownMs: 30 * 60 * 1000,
    test(view) {
      if (!view.quietHours || !view.quietHours.enabled || view.minutesToQuiet === null) return null;
      if (view.minutesToQuiet > 30 || view.minutesToQuiet < 0) return null;
      return {
        title: `Quiet hours start in ${view.minutesToQuiet} minutes`,
        detail: `Power commands will be refused between ${view.quietHours.from} and ${view.quietHours.to} unless you change the policy.`,
      };
    },
  },
  {
    id: 'shutdown-pending',
    level: 'info',
    cooldownMs: 60 * 1000,
    test(view) {
      if (!view.shutdownPending) return null;
      return {
        title: 'A shutdown is scheduled',
        detail: view.shutdownDetail || 'The machine is counting down. You can still stop it.',
        action: { label: 'Cancel the shutdown', cmd: 'system.cancel_shutdown', args: { confirm: true } },
        sticky: true,
      };
    },
  },
  {
    id: 'tunnel-key-mismatch',
    level: 'warn',
    cooldownMs: 30 * 60 * 1000,
    test(view) {
      if (view.keyMismatches < 2) return null;
      return {
        title: 'A device keeps presenting the wrong key',
        detail: `${view.keyMismatches} rejected pairing proofs. If you rotated keys, pair the phone and the ESP32 again.`,
      };
    },
  },
];

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

class Brain {
  constructor({ config, log, now = () => Date.now() } = {}) {
    this.config = config;
    this.log = log;
    this.now = now;
    this.cpu = [];
    this.drops = [];
    this.failures = [];
    this.keyMismatches = [];
    this.insights = new Map(); // id → { id, level, title, detail, action, since, lastSeen }
    this.cooldowns = new Map(); // id → timestamp when it may appear again
    this.lastEspConnected = null;
    this.lastFailure = null;
    this.shutdownPending = null;
    this.startedAt = this.now();
  }

  /** Called by the agent every few seconds with a fresh snapshot. */
  observe(snapshot, extra = {}) {
    const now = this.now();
    if (!snapshot) return this.list();

    if (typeof snapshot.cpuPercent === 'number') {
      this.cpu.push(snapshot.cpuPercent);
      if (this.cpu.length > 60) this.cpu.shift();
    }

    if (snapshot.esp) {
      const connected = snapshot.esp.connected === true || snapshot.esp.link === 'up';
      if (this.lastEspConnected === true && connected === false) this.drops.push(now);
      this.lastEspConnected = connected;
      this.prune(this.drops, now, 10 * 60 * 1000);
    }

    if (extra.commandFailed) {
      this.failures.push({ at: now, message: String(extra.commandFailed) });
      this.lastFailure = String(extra.commandFailed);
    }
    this.failures = this.failures.filter((entry) => now - entry.at < 5 * 60 * 1000);

    if (extra.keyMismatch) this.keyMismatches.push(now);
    this.prune(this.keyMismatches, now, 60 * 60 * 1000);

    if (extra.lastCommand && extra.lastCommand.cmd === 'system.shutdown' && extra.lastCommand.ok) {
      this.shutdownPending = { at: now, detail: `Scheduled ${Math.round((now - extra.lastCommand.at) / 1000)}s ago.` };
    }
    if (extra.lastCommand && ['system.cancel_shutdown', 'system.reboot'].includes(extra.lastCommand.cmd) && extra.lastCommand.ok) {
      this.shutdownPending = null;
    }
    if (this.shutdownPending && now - this.shutdownPending.at > 10 * 60 * 1000) this.shutdownPending = null;

    const memory = snapshot.memoryDetail || null;
    const policy = snapshot.policy || this.config.get('policy') || {};
    const view = {
      now,
      cpu: this.cpu,
      cpuModel: snapshot.cpuModel,
      memoryPercent: memory ? memory.percent : null,
      memoryTotalLabel: memory ? `${Math.round(memory.total / 1024 / 1024 / 1024)} GB` : 'memory',
      espConnected: snapshot.esp ? snapshot.esp.connected === true || snapshot.esp.link === 'up' : false,
      espDrops: this.drops.length,
      recentFailures: this.failures.length,
      lastFailure: this.lastFailure || 'unknown',
      keyMismatches: this.keyMismatches.length,
      quietHours: policy.quietHours || null,
      minutesToQuiet: minutesUntil(policy.quietHours, now),
      uptimeSec: snapshot.agent ? snapshot.agent.uptimeSec || 0 : 0,
      shutdownPending: this.shutdownPending,
      shutdownDetail: this.shutdownPending ? this.shutdownPending.detail : null,
    };

    const seen = new Set();
    for (const rule of RULES) {
      let result = null;
      try {
        result = rule.test(view);
      } catch (err) {
        this.log && this.log.debug('brain', `rule ${rule.id} threw: ${err.message}`);
      }
      if (!result) continue;
      seen.add(rule.id);

      const existing = this.insights.get(rule.id);
      if (existing) {
        // Still true: refresh the text, keep the original timestamp.
        existing.title = result.title;
        existing.detail = result.detail;
        existing.action = result.action || null;
        existing.lastSeen = now;
        continue;
      }
      const readyAt = this.cooldowns.get(rule.id) || 0;
      if (now < readyAt) continue;
      const insight = {
        id: rule.id,
        level: result.level || rule.level,
        title: result.title,
        detail: result.detail,
        action: result.action || null,
        sticky: Boolean(result.sticky),
        since: now,
        lastSeen: now,
      };
      this.insights.set(rule.id, insight);
      this.cooldowns.set(rule.id, now + rule.cooldownMs);
      this.log && this.log.info('brain', `insight: ${insight.title}`, { rule: rule.id });
    }

    // Conditions that have cleared disappear; a sticky one needs action first.
    for (const [id, insight] of this.insights) {
      if (seen.has(id)) continue;
      if (insight.sticky && now - insight.lastSeen < 10 * 60 * 1000) continue;
      this.insights.delete(id);
      this.log && this.log.debug('brain', `insight cleared: ${id}`);
    }

    return this.list();
  }

  /** What actually changed since the last call (used for broadcasts). */
  list() {
    return [...this.insights.values()]
      .sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || b.since - a.since)
      .map((insight) => ({ ...insight }));
  }

  signature() {
    return this.list()
      .map((insight) => `${insight.id}:${insight.title}`)
      .join('|');
  }

  dismiss(id) {
    const found = this.insights.get(id);
    if (!found) return false;
    this.insights.delete(id);
    this.cooldowns.set(id, this.now() + 30 * 60 * 1000);
    this.log && this.log.info('brain', `insight dismissed: ${id}`);
    return true;
  }

  prune(list, now, windowMs) {
    while (list.length && now - (typeof list[0] === 'number' ? list[0] : list[0].at) > windowMs) list.shift();
  }
}

/**
 * Minutes until the quiet-hours window opens, or null when it is off, already
 * open, or not scheduled today. Handles windows that cross midnight.
 */
function minutesUntil(quietHours, now = Date.now()) {
  if (!quietHours || !quietHours.enabled) return null;
  const [fromH, fromM] = String(quietHours.from || '23:00').split(':').map(Number);
  const [toH, toM] = String(quietHours.to || '07:00').split(':').map(Number);
  const date = new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  const from = (fromH || 0) * 60 + (fromM || 0);
  const to = (toH || 0) * 60 + (toM || 0);
  if (from === to) return null;
  const open = from < to ? current >= from && current < to : current >= from || current < to;
  if (open) return null;
  const delta = from >= current ? from - current : 24 * 60 - current + from;
  return delta;
}

module.exports = { Brain, RULES, minutesUntil };
