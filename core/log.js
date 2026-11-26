'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { logFile, ensureDir } = require('./paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * In-memory ring buffer + append-only file. The UI subscribes to `entry`
 * events over SSE, so a phone on the VPN sees the same activity feed.
 */
class ActivityLog extends EventEmitter {
  constructor({ max = 800, file = null } = {}) {
    super();
    this.max = max;
    this.entries = [];
    this.seq = 0;
    this.file = file === false ? null : file || logFile();
    if (this.file) {
      try {
        ensureDir(path.dirname(this.file));
      } catch {
        this.file = null;
      }
    }
  }

  write(level, source, message, meta = undefined) {
    const entry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level,
      source,
      message: String(message),
    };
    if (meta !== undefined) entry.meta = meta;
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.emit('entry', entry);
    if (this.file) {
      const line =
        `${entry.at} ${level.toUpperCase().padEnd(5)} [${source}] ${entry.message}` +
        (meta !== undefined ? ' ' + safeMeta(meta) : '') +
        '\n';
      fs.appendFile(this.file, line, () => {});
    }
    if (process.env.SENTINEL_VERBOSE) process.stdout.write(`${entry.at} ${level} ${source}: ${entry.message}\n`);
    return entry;
  }

  debug(source, message, meta) {
    return this.write('debug', source, message, meta);
  }
  info(source, message, meta) {
    return this.write('info', source, message, meta);
  }
  warn(source, message, meta) {
    return this.write('warn', source, message, meta);
  }
  error(source, message, meta) {
    return this.write('error', source, message, meta);
  }

  recent(limit = 200) {
    return this.entries.slice(-limit);
  }
}

function safeMeta(meta) {
  try {
    const text = JSON.stringify(meta);
    return text.length > 600 ? text.slice(0, 600) + '…' : text;
  } catch {
    return '[unserialisable]';
  }
}

module.exports = { ActivityLog, LEVELS };
