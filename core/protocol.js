'use strict';

const crypto = require('node:crypto');
const { stableStringify, timingSafeEqualHex } = require('./util');

const PROTOCOL_VERSION = 1;
const DEFAULT_SKEW_SECONDS = 120;

/** Canonical string that gets signed. Every field that matters is inside. */
function canonical(env) {
  return stableStringify({
    v: env.v || PROTOCOL_VERSION,
    id: env.id,
    ts: env.ts,
    nonce: env.nonce,
    from: env.from || '',
    cmd: env.cmd || '',
    args: env.args || {},
  });
}

function sign(psk, env) {
  return crypto.createHmac('sha256', Buffer.from(psk, 'hex')).update(canonical(env)).digest('hex');
}

/** Build a signed envelope. Used by the agent, the desktop UI and the tests. */
function createEnvelope(psk, { cmd, args = {}, from = 'agent', ttl = null }) {
  const env = {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(12).toString('hex'),
    from,
    cmd,
    args,
  };
  if (ttl) env.exp = env.ts + ttl;
  env.sig = sign(psk, env);
  return env;
}

/**
 * Anti-replay window. Nonces are remembered for the length of the accepted
 * clock skew, after which an old envelope is rejected on timestamp alone.
 */
class ReplayGuard {
  constructor({ skewSeconds = DEFAULT_SKEW_SECONDS, keep = 4096 } = {}) {
    this.skew = skewSeconds * 1000;
    this.keep = keep;
    this.seen = new Map();
  }

  check(nonce, tsMillis) {
    const now = Date.now();
    for (const [key, at] of this.seen) {
      if (now - at > this.skew) this.seen.delete(key);
      else break;
    }
    if (Math.abs(now - tsMillis) > this.skew) {
      return { ok: false, code: 'STALE', message: 'Command timestamp outside allowed window (clock drift?)' };
    }
    if (this.seen.has(nonce)) {
      return { ok: false, code: 'REPLAY', message: 'Duplicate command nonce rejected' };
    }
    this.seen.set(nonce, now);
    while (this.seen.size > this.keep) this.seen.delete(this.seen.keys().next().value);
    return { ok: true };
  }
}

/**
 * Verify a signed command envelope.
 * @returns {{ok: true, env: object} | {ok: false, code: string, message: string}}
 */
function verifyEnvelope(psk, env, guard) {
  if (!env || typeof env !== 'object') return { ok: false, code: 'BAD_ENVELOPE', message: 'Malformed envelope' };
  if (env.v !== undefined && env.v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'VERSION', message: `Unsupported protocol version ${env.v}` };
  }
  if (typeof env.sig !== 'string' || typeof env.nonce !== 'string' || !Number.isFinite(env.ts) || typeof env.id !== 'string') {
    return { ok: false, code: 'BAD_ENVELOPE', message: 'Envelope is missing id/ts/nonce/sig' };
  }
  const expected = sign(psk, env);
  if (!timingSafeEqualHex(expected, env.sig)) {
    return { ok: false, code: 'BAD_SIGNATURE', message: 'Signature does not match the pairing key' };
  }
  if (guard) {
    const replay = guard.check(env.nonce, env.ts * 1000);
    if (!replay.ok) return replay;
  }
  if (env.exp && Math.floor(Date.now() / 1000) > env.exp) {
    return { ok: false, code: 'EXPIRED', message: 'Command expired' };
  }
  return { ok: true, env };
}

/** Challenge/response used when the ESP32 opens the link. */
function handshakeProof(psk, agentNonce, deviceNonce, deviceId) {
  return crypto
    .createHmac('sha256', Buffer.from(psk, 'hex'))
    .update(`sentinel-link-v1|${agentNonce}|${deviceNonce}|${deviceId || ''}`)
    .digest('hex');
}

module.exports = { PROTOCOL_VERSION, canonical, sign, createEnvelope, verifyEnvelope, ReplayGuard, handshakeProof };
