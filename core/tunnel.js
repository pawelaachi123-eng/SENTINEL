'use strict';

/**
 * SENTINEL Tunnel (ST1) — our own encrypted channel.
 *
 * Purpose: the phone must be able to talk to the PC (and to the ESP32) without
 * a VPN, a router rule or a third-party service. "A tunnel only between us."
 *
 * Design (deliberately simple enough to audit and to run on a 240 MHz chip):
 *
 *   1. client  → POST /hello   { v, nc, ec }        ec = ephemeral P-256 public key
 *   2. server  →               { sid, ns, es, mac } mac = HMAC-SHA256(psk, transcript)
 *   3. client  → POST /open    { sid, mac }         mac = HMAC-SHA256(psk, transcript')
 *   4. both derive 64 bytes with HKDF-SHA256(ECDH(ec,es), salt = nc||ns)
 *             → k_c2s (client→server) and k_s2c (server→client)
 *   5. every message after that is AES-256-GCM with a monotonic sequence number,
 *      which is also the replay guard.
 *
 * Properties:
 *   - mutual authentication: both sides prove knowledge of the pairing key
 *   - forward secrecy: the ECDH keys are ephemeral and thrown away
 *   - no plaintext and no long-lived token on the wire
 *   - replay-proof: a frame is only accepted if its sequence number is new
 *   - session expires after inactivity, and keys are zeroised
 *
 * What it is not: it is not a VPN, it does not give you a new IP address, and it
 * does not route other apps' traffic. It is one authenticated, encrypted channel
 * between two programs that already share a pairing key.
 *
 * Identical logic lives in:
 *   - core/tunnel.js            (agent, Node)
 *   - firmware/src/tunnel.cpp   (ESP32, mbedtls)
 *   - ui/transport.js           (phone, WebCrypto)
 * and docs/tunnel.md is the normative description.
 */

const crypto = require('node:crypto');

const PROTOCOL = 'ST1';
const HKDF_INFO = 'ST1|keys';
const CURVE = 'prime256v1';
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGES_PER_SESSION = 100000;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(text)) throw new Error('bad base64');
  return Buffer.from(text, 'base64');
};

function hmac(pskBytes, text) {
  return crypto.createHmac('sha256', pskBytes).update(text, 'utf8').digest();
}

function deriveKeys(sharedSecret, ncHex, nsHex) {
  const salt = Buffer.concat([Buffer.from(ncHex, 'hex'), Buffer.from(nsHex, 'hex')]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(HKDF_INFO, 'utf8'), 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

function nonceFor(seq, direction) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(seq >>> 0, 0);
  nonce[4] = direction;
  return nonce;
}

function aadFor(sid, seq) {
  return Buffer.from(`${PROTOCOL}|msg|${sid}|${seq}`, 'utf8');
}

/** One direction's AES-256-GCM state machine. */
class Sealer {
  constructor(key, direction, sid) {
    this.key = key;
    this.direction = direction;
    this.sid = sid;
    this.seq = 0;
    this.lastSeen = -1;
  }

  seal(plaintext) {
    if (this.seq >= MAX_MESSAGES_PER_SESSION) throw new Error('session exhausted');
    const seq = this.seq++;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonceFor(seq, this.direction), { authTagLength: 16 });
    cipher.setAAD(aadFor(this.sid, seq));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { seq, body };
  }

  open(seq, body) {
    if (!Number.isInteger(seq) || seq < 0) throw new Error('bad sequence');
    if (seq <= this.lastSeen) throw new Error('replayed frame');
    if (body.length < 16) throw new Error('short frame');
    const tag = body.subarray(body.length - 16);
    const data = body.subarray(0, body.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonceFor(seq, this.direction), { authTagLength: 16 });
    decipher.setAAD(aadFor(this.sid, seq));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    this.lastSeen = seq;
    return plaintext;
  }
}

/** Server side of the handshake + the session it produces. */
class TunnelServer {
  constructor({ config, log, commander, pskBytes }) {
    this.config = config;
    this.log = log;
    this.commander = commander;
    this.psk = pskBytes || Buffer.from(config.get('psk'), 'hex');
    this.pending = new Map(); // sid → half-open handshake
    this.sessions = new Map(); // sid → active session
    this.failures = new Map(); // ip → {count, until}
    this.timer = setInterval(() => this.sweep(), 60000);
    this.timer.unref?.();
    this.stats = { handshakes: 0, messages: 0, rejected: 0 };
  }

  /* ── handshake ─────────────────────────────────────────────── */

  hello(body, ip) {
    if (!this.allow(ip)) return { status: 429, body: { error: 'too many pairing attempts, wait a minute' } };
    const nc = String(body.nc || '');
    const ecB64 = String(body.ec || '');
    if (!/^[0-9a-f]{32}$/.test(nc)) return { status: 400, body: { error: 'nc must be 32 hex characters' } };
    let ec;
    try {
      ec = unb64(ecB64);
    } catch {
      return { status: 400, body: { error: 'ec is not valid base64' } };
    }
    if (ec.length !== 65 || ec[0] !== 4) return { status: 400, body: { error: 'ec must be an uncompressed P-256 point' } };

    let ecdh;
    try {
      ecdh = crypto.createECDH(CURVE);
      ecdh.generateKeys();
      ecdh.computeSecret(ec);
    } catch {
      return { status: 400, body: { error: 'invalid public key' } };
    }

    const ns = crypto.randomBytes(16).toString('hex');
    const esB64 = b64(ecdh.getPublicKey());
    const sid = crypto.randomBytes(8).toString('hex');
    const transcript = `${PROTOCOL}|server|${nc}|${ecB64}|${ns}|${esB64}`;
    const mac = b64(hmac(this.psk, transcript));

    this.pending.set(sid, { sid, nc, ecB64, ns, esB64, ecdh, createdAt: Date.now(), ip });
    // Keep the half-open table small: handshakes finish within seconds.
    if (this.pending.size > 32) {
      const oldest = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.pending.delete(oldest.sid);
    }
    return { status: 200, body: { v: 1, sid, ns, es: esB64, mac, ttl: SESSION_TTL_MS } };
  }

  open(body) {
    const sid = String(body.sid || '');
    const half = this.pending.get(sid);
    if (!half) return { status: 404, body: { error: 'unknown or expired handshake' } };
    if (Date.now() - half.createdAt > 30000) {
      this.pending.delete(sid);
      return { status: 410, body: { error: 'handshake took too long' } };
    }
    const expected = b64(hmac(this.psk, `${PROTOCOL}|client|${half.nc}|${half.ecB64}|${half.ns}|${half.esB64}`));
    if (!safeEqual(expected, String(body.mac || ''))) {
      this.pending.delete(sid);
      this.fail(half.ip);
      return { status: 403, body: { error: 'pairing key mismatch' } };
    }

    let shared;
    try {
      shared = half.ecdh.computeSecret(unb64(half.ecB64));
    } catch {
      this.pending.delete(sid);
      return { status: 400, body: { error: 'key agreement failed' } };
    }
    const keys = deriveKeys(shared, half.nc, half.ns);
    this.pending.delete(sid);
    this.sessions.set(sid, {
      sid,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      c2s: new Sealer(keys.c2s, 1, sid),
      s2c: new Sealer(keys.s2c, 2, sid),
      ip: half.ip,
      events: [],
    });
    this.stats.handshakes++;
    this.log.info('tunnel', `Encrypted session ${sid} opened for ${half.ip}`);
    return { status: 200, body: { ok: true, ttl: SESSION_TTL_MS } };
  }

  /* ── traffic ───────────────────────────────────────────────── */

  async message(body, ip) {
    const sid = String(body.sid || '');
    const session = this.sessions.get(sid);
    if (!session) return { status: 401, body: { error: 'session expired — pair again' } };
    if (session.ip !== ip) {
      // A session is bound to the address that opened it.
      this.log.warn('tunnel', `Session ${sid} used from a different address (${ip}) — rejected`);
      this.stats.rejected++;
      return { status: 403, body: { error: 'session belongs to another device' } };
    }

    let request;
    try {
      const plaintext = session.c2s.open(Number(body.seq), unb64(String(body.ct || '')));
      request = JSON.parse(plaintext.toString('utf8'));
    } catch (err) {
      this.stats.rejected++;
      this.log.warn('tunnel', `Rejected frame on ${sid}: ${err.message}`);
      return { status: 400, body: { error: `frame rejected: ${err.message}` } };
    }

    session.lastSeen = Date.now();
    this.stats.messages++;
    const events = session.events.splice(0, 64);

    let reply;
    if (request && request.cmd) {
      const cmd = String(request.cmd);
      const args = request.args && typeof request.args === 'object' ? request.args : {};
      try {
        const result = await this.commander.execute(cmd, args, { source: 'tunnel', ip });
        reply = { id: request.id ?? null, ok: true, cmd, data: result.data, ms: result.ms };
      } catch (err) {
        reply = { id: request.id ?? null, ok: false, cmd, code: err.code || 'FAILED', message: err.message, detail: err.detail };
      }
    } else if (request && request.poll) {
      reply = { id: request.id ?? null, ok: true, cmd: 'poll', data: { at: new Date().toISOString() } };
    } else {
      reply = { id: request && request.id, ok: false, code: 'BAD_REQUEST', message: 'expected {cmd,args} or {poll:true}' };
    }
    reply.events = events;

    const sealed = session.s2c.seal(Buffer.from(JSON.stringify(reply), 'utf8'));
    return { status: 200, body: { seq: sealed.seq, ct: b64(sealed.body), sid } };
  }

  /** Queue a log/status event for every live session (delivered on next poll). */
  pushEvent(event) {
    for (const session of this.sessions.values()) {
      session.events.push(event);
      if (session.events.length > 120) session.events.splice(0, session.events.length - 120);
    }
  }

  liveSessions() {
    return [...this.sessions.values()].map((s) => ({ sid: s.sid, ip: s.ip, since: s.createdAt, lastSeen: s.lastSeen }));
  }

  closeAll(reason = 'closed') {
    for (const session of this.sessions.values()) {
      session.c2s.key.fill(0);
      session.s2c.key.fill(0);
    }
    this.sessions.clear();
    this.pending.clear();
    if (reason) this.log.info('tunnel', `All encrypted sessions dropped (${reason})`);
  }

  sweep() {
    const now = Date.now();
    for (const [sid, session] of this.sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) {
        session.c2s.key.fill(0);
        session.s2c.key.fill(0);
        this.sessions.delete(sid);
        this.log.debug('tunnel', `Session ${sid} expired`);
      }
    }
    for (const [sid, half] of this.pending) {
      if (now - half.createdAt > 60000) this.pending.delete(sid);
    }
  }

  allow(ip) {
    const now = Date.now();
    const record = this.failures.get(ip) || { count: 0, until: 0 };
    if (record.until > now) return false;
    this.failures.set(ip, record);
    return true;
  }

  fail(ip) {
    const record = this.failures.get(ip) || { count: 0, until: 0 };
    record.count += 1;
    if (record.count > 8) {
      record.until = Date.now() + 60000;
      record.count = 0;
      this.log.warn('tunnel', `Too many failed pairings from ${ip} — paused for a minute`);
    }
    this.failures.set(ip, record);
  }

  stop() {
    clearInterval(this.timer);
    this.closeAll('shutdown');
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Client used by tests, the emulator and any Node-side consumer.
 * Mirrors ui/transport.js so the JS in the phone is validated by these tests.
 */
class TunnelClient {
  constructor({ baseUrl, pskHex, fetchImpl = globalThis.fetch }) {
    this.base = String(baseUrl).replace(/\/+$/, '');
    this.psk = Buffer.from(pskHex, 'hex');
    this.fetch = fetchImpl;
    this.sid = null;
    this.sendSeq = 0;
    this.recvSeq = -1;
    this.ack = -1;
    this.keys = null;
    this.events = [];
    this.nextId = 1;
  }

  async connect() {
    const ecdh = crypto.createECDH(CURVE);
    ecdh.generateKeys();
    const nc = crypto.randomBytes(16).toString('hex');
    const ecB64 = b64(ecdh.getPublicKey());
    const hello = await this.post('/hello', { v: 1, nc, ec: ecB64 });
    if (!hello.mac || !hello.sid) throw new Error(hello.error || 'handshake refused');

    const expected = b64(hmac(this.psk, `${PROTOCOL}|server|${nc}|${ecB64}|${hello.ns}|${hello.es}`));
    if (!safeEqual(expected, hello.mac)) throw new Error('the device does not share your pairing key');

    let shared;
    try {
      shared = ecdh.computeSecret(unb64(hello.es));
    } catch {
      throw new Error('device sent an invalid key');
    }
    const keys = deriveKeys(shared, nc, hello.ns);
    const macC = b64(hmac(this.psk, `${PROTOCOL}|client|${nc}|${ecB64}|${hello.ns}|${hello.es}`));
    const opened = await this.post('/open', { sid: hello.sid, mac: macC });
    if (opened.error || !opened.ok) throw new Error(opened.error || 'the device refused the pairing proof');

    this.sid = hello.sid;
    this.c2s = new Sealer(keys.c2s, 1, this.sid);
    this.s2c = new Sealer(keys.s2c, 2, this.sid);
    return { sid: this.sid, serverPublic: hello.es };
  }

  async send(request) {
    if (!this.sid) throw new Error('not connected');
    const sealed = this.c2s.seal(Buffer.from(JSON.stringify(request), 'utf8'));
    const response = await this.post('/msg', { sid: this.sid, seq: sealed.seq, ct: b64(sealed.body) });
    if (response.error) throw new Error(response.error);
    const plaintext = this.s2c.open(Number(response.seq), unb64(response.ct));
    const reply = JSON.parse(plaintext.toString('utf8'));
    if (Array.isArray(reply.events)) this.events.push(...reply.events);
    return reply;
  }

  command(cmd, args = {}) {
    return this.send({ id: this.nextId++, cmd, args });
  }

  poll() {
    return this.send({ id: this.nextId++, poll: true });
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  async post(path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`device answered HTTP ${res.status} with something that is not JSON`);
    }
    if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
    return json;
  }
}

module.exports = {
  PROTOCOL,
  SESSION_TTL_MS,
  TunnelServer,
  TunnelClient,
  Sealer,
  deriveKeys,
  hmac,
  nonceFor,
  aadFor,
  b64,
  unb64,
};
