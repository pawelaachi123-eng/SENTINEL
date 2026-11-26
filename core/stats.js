'use strict';

const os = require('node:os');

/** CPU percentage derived from cputime deltas (os.loadavg is useless on Windows). */
class Stats {
  constructor() {
    this.last = this.snapshot();
    this.lastAt = Date.now();
    this.cpu = 0;
  }

  snapshot() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      for (const t of Object.values(cpu.times)) total += t;
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  read() {
    const now = Date.now();
    const snap = this.snapshot();
    const idleDelta = snap.idle - this.last.idle;
    const totalDelta = snap.total - this.last.total;
    if (totalDelta > 0 && now - this.lastAt > 200) {
      const instant = 100 - (100 * idleDelta) / totalDelta;
      this.cpu = Math.round(this.cpu * 0.55 + Math.max(0, Math.min(100, instant)) * 0.45);
      this.last = snap;
      this.lastAt = now;
    }
    return this.cpu;
  }

  memory() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      total,
      free,
      used: total - free,
      percent: Math.round(((total - free) / total) * 100),
    };
  }
}

module.exports = { Stats };
