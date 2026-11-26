'use strict';

const crypto = require('node:crypto');

/** Deterministic JSON: same object always serialises to the same bytes, so
 *  signatures computed on one side verify on the other. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Pretty human uptime: 2d 04h 11m */
function humanUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Strip control characters that would break a line-oriented protocol. */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
}

module.exports = { stableStringify, randomHex, timingSafeEqualHex, clamp, sleep, safeJson, humanUptime, oneLine };
