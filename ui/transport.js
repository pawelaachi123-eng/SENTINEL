/* ============================================================================
   SENTINEL transport — what the phone uses to reach the PC and the ESP32.

   Two ways in, both direct (no VPN, no relay server, no account):

   1. TunnelLink  — our own encrypted channel (ST1).
                    ECDH P-256 → HKDF-SHA256 → AES-256-GCM, authenticated with
                    the pairing key. Works against the agent (/api/tunnel) and
                    against the ESP32 (/t). This is the default.

   2. PlainLink   — the classic same-origin API with the UI token. Only used
                    when you open the console on the machine itself.

   Everything is timed and recorded so the UI can explain exactly what failed.
   ========================================================================== */
(function () {
  'use strict';

  const PROTOCOL = 'ST1';

  /* ── small helpers ─────────────────────────────────────────────────────── */

  /**
   * WebCrypto returns buffers from its own realm, so `instanceof` is not a
   * reliable test (it fails in WebViews and in jsdom). Duck-type instead.
   */
  function toBytes(value) {
    if (!value) throw new Error('expected binary data');
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value.byteLength === 'number') return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    throw new Error('expected binary data');
  }

  function toBase64(buffer) {
    const bytes = toBytes(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(String(text).replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function hexToBytes(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 0) return new Uint8Array(0);
    if (clean.length % 2) throw new Error('the pairing key has an odd number of characters');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(toBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** A pairing key is 32 random bytes shown as 64 hex characters. */
  function normaliseKey(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('the pairing key is empty');
    const compact = raw.replace(/[\s:-]/g, '');
    if (/^[0-9a-fA-F]{64}$/.test(compact)) return compact.toLowerCase();
    if (compact.length === 64 && /^[A-Za-z0-9+/=]{64}$/.test(compact)) {
      // Somebody pasted base64 of the 32 bytes — accept it.
      const bytes = fromBase64(compact);
      if (bytes.length === 32) return bytesToHex(bytes);
    }
    throw new Error(`that does not look like a pairing key — it must be 64 hex characters (you pasted ${compact.length})`);
  }

  /**
   * Accepts what people actually type: "192.168.1.1", "192.168.1.1:7878",
   * "http://host:7878/", "host.local". Returns a bare origin + optional prefix.
   */
  function normaliseAddress(input, { prefix = '', defaultPort = null } = {}) {
    let raw = String(input || '').trim();
    if (!raw) throw new Error('enter the address of your PC or ESP32');
    raw = raw.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`"${input}" is not a valid address`);
    }
    if (!url.hostname) throw new Error(`"${input}" is missing a host name`);
    if (url.pathname && url.pathname !== '/') {
      // People paste ".../index.html?t=..." — keep only the origin.
      url = new URL(url.origin);
    }
    if (defaultPort && !url.port) url.port = String(defaultPort);
    return `${url.origin}${prefix}`;
  }

  /** Bearer-token helper for the same-origin console. */
  function withToken(url, token) {
    if (!token) return url;
    const parsed = new URL(url, location.href);
    parsed.searchParams.set('t', token);
    return parsed.toString();
  }

  class TransportError extends Error {
    constructor(message, { code = 'ERROR', hint = '', status = 0, cause = null } = {}) {
      super(message);
      this.name = 'TransportError';
      this.code = code;
      this.hint = hint;
      this.status = status;
      this.cause = cause;
    }
  }

  /** fetch with a hard timeout that reports *why* it failed. */
  async function postJson(url, body, { timeout = 9000, token = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    let response;
    try {
      response = await fetch(withToken(url, token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const aborted = err && err.name === 'AbortError';
      throw new TransportError(
        aborted ? `no answer within ${Math.round(timeout / 1000)} s` : 'the device could not be reached',
        {
          code: aborted ? 'TIMEOUT' : 'UNREACHABLE',
          status: 0,
          cause: err,
          hint: aborted
            ? 'The address answered nothing at all. Check that the phone is on the same Wi-Fi as the device and that the address is the device\'s own IP.'
            : 'Usually this means a wrong address, a different Wi-Fi network, or a device that is switched off. Tap "Test address" to see what is reachable.',
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message = (json && (json.error || json.message)) || `HTTP ${response.status} from ${url}`;
      throw new TransportError(message, {
        code: json && json.code ? json.code : `HTTP_${response.status}`,
        status: response.status,
        hint:
          response.status === 404
            ? 'The address answered, but it is not a SENTINEL device. Check the port (agent: 7878, ESP32: 80).'
            : response.status === 403
              ? 'The device refused the request: the pairing key does not match.'
              : response.status === 429
                ? 'Too many attempts. Wait a minute and try again.'
                : '',
      });
    }
    return { json, ms, status: response.status };
  }

  /* ── ST1 client ────────────────────────────────────────────────────────── */

  class TunnelLink {
    constructor({ base, key, label = 'device', token = null, timeout = 9000 }) {
      this.base = base;
      this.keyHex = normaliseKey(key);
      this.label = label;
      this.token = token;
      this.timeout = timeout;
      this.sid = null;
      this.seq = 0;
      this.ackSeq = -1;
      this.events = [];
      this.nextId = 1;
      this.connected = false;
      this.rtt = null;
      this._aes = {};
    }

    async _psk() {
      if (!this._pskKey) {
        this._pskKey = await crypto.subtle.importKey(
          'raw',
          hexToBytes(this.keyHex),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
      }
      return this._pskKey;
    }

    async _mac(text) {
      const key = await this._psk();
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
      return toBase64(signature);
    }

    async _open(hello, nc, ecB64, sharedBits) {
      const material = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
      const salt = concat(hexToBytes(nc), hexToBytes(hello.ns));
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${PROTOCOL}|keys`) },
        material,
        64 * 8,
      );
      const okm = toBytes(bits);
      const c2s = await crypto.subtle.importKey('raw', okm.subarray(0, 32), 'AES-GCM', false, ['encrypt']);
      const s2c = await crypto.subtle.importKey('raw', okm.subarray(32, 64), 'AES-GCM', false, ['decrypt']);
      this._aes = { c2s, s2c };
      return { c2s, s2c };
    }

    _nonce(seq, direction) {
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setUint32(0, seq >>> 0, false);
      nonce[4] = direction;
      return nonce;
    }

    _aad(seq) {
      return encoder.encode(`${PROTOCOL}|msg|${this.sid}|${seq}`);
    }

    /** Runs the handshake. `onStep` receives human-readable progress. */
    async connect(onStep = () => {}) {
      const steps = [];
      const note = (text, detail) => {
        steps.push({ text, detail: detail || '', at: Date.now() });
        onStep(steps);
      };

      if (!globalThis.crypto || !crypto.subtle) {
        throw new TransportError('this browser has no Web Crypto', {
          code: 'NO_CRYPTO',
          hint: 'Open the console over http://localhost or https:// — Web Crypto is only available in a secure context.',
        });
      }

      note('Generating a one-time key pair', 'P-256 · nothing leaves the phone');
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const ec = toBytes(await crypto.subtle.exportKey('raw', pair.publicKey));
      if (ec.length !== 65) throw new TransportError('the browser produced an unexpected key', { code: 'BAD_KEY' });
      const nc = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      const ecB64 = toBase64(ec);

      note('Reaching the device', this.base);
      const hello = await postJson(`${this.base}/hello`, { v: 1, nc, ec: ecB64 }, { timeout: this.timeout });
      const answer = hello.json || {};
      if (!answer.sid || !answer.mac || !answer.es) {
        throw new TransportError('the device answered, but not like a SENTINEL device', {
          code: 'NOT_SENTINEL',
          hint: 'Maybe this is a different service on the same port, or an old build. Update the agent to 2.1+ and try again.',
        });
      }

      note('Checking the device identity', `session ${answer.sid}`);
      const expected = await this._mac(`${PROTOCOL}|server|${nc}|${ecB64}|${answer.ns}|${answer.es}`);
      if (expected !== answer.mac) {
        throw new TransportError('the pairing key does not match this device', {
          code: 'KEY_MISMATCH',
          hint: 'Copy the key again from the PC console (Pairing → pairing key) or from the ESP32 setup page, then retry.',
        });
      }

      note('Securing the channel', 'AES-256-GCM');
      const peer = await crypto.subtle.importKey('raw', fromBase64(answer.es), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = toBytes(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256));
      await this._open(answer, nc, ecB64, shared);

      this.sid = answer.sid;
      const proof = await this._mac(`${PROTOCOL}|client|${nc}|${ecB64}|${answer.ns}|${answer.es}`);
      const opened = await postJson(`${this.base}/open`, { sid: answer.sid, mac: proof }, { timeout: this.timeout });
      if (!opened.json || !opened.json.ok) {
        throw new TransportError((opened.json && opened.json.error) || 'the device refused the proof', {
          code: 'REFUSED',
        });
      }

      note('Verifying with a live command');
      const ping = await this.request('system.ping', {}, { timeout: this.timeout });
      this.connected = true;
      this.rtt = ping.ms;
      // The ESP32 answers LINK_OFFLINE itself when its own link to the PC is
      // down — that is still a working channel, just hardware-only.
      this.pcReachable = ping.ok !== false;
      note(
        'Connected',
        this.pcReachable ? `${ping.ms} ms round trip` : `${ping.ms} ms · ESP32 only, PC agent not linked`,
      );
      return { sid: this.sid, steps, rtt: ping.ms, pcReachable: this.pcReachable };
    }

    request(cmd, args = {}, options = {}) {
      return this._exchange({ id: this.nextId++, cmd, args }, options.timeout);
    }

    async _exchange(payload, timeout = this.timeout) {
      if (!this.sid) throw new TransportError('not connected', { code: 'OFFLINE' });
      const seq = this.seq++;
      const aad = this._aad(seq);
      const plain = encoder.encode(JSON.stringify(payload));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: this._nonce(seq, 1), additionalData: aad, tagLength: 128 },
        this._aes.c2s,
        plain,
      );
      const started = performance.now();
      const response = await postJson(
        `${this.base}/msg`,
        { sid: this.sid, seq, ct: toBase64(cipher) },
        { timeout },
      );
      const body = response.json || {};
      if (body.error) throw new TransportError(body.error, { code: 'FRAME_REFUSED' });
      const replySeq = Number(body.seq);
      if (!Number.isInteger(replySeq) || replySeq <= this.ackSeq) {
        throw new TransportError('the device reused a message number — refusing it', { code: 'REPLAY' });
      }
      this.ackSeq = replySeq;
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this._nonce(replySeq, 2), additionalData: this._aad(replySeq), tagLength: 128 },
        this._aes.s2c,
        fromBase64(body.ct),
      );
      const reply = JSON.parse(decoder.decode(decrypted));
      this.rtt = Math.round(performance.now() - started);
      if (Array.isArray(reply.events)) this.events.push(...reply.events);
      return { ...reply, ms: this.rtt };
    }

    /** Background poll so log lines stream in even without SSE. */
    async poll() {
      if (!this.connected) return [];
      const reply = await this._exchange({ id: this.nextId++, poll: true }, 6000).catch(() => null);
      return reply ? reply.events || [] : [];
    }

    drainEvents() {
      const out = this.events;
      this.events = [];
      return out;
    }

    close() {
      this.connected = false;
      this.sid = null;
      this._aes = {};
      this._pskKey = null;
    }

    describe() {
      return { kind: 'tunnel', base: this.base, sid: this.sid, rtt: this.rtt };
    }
  }

  /** Same-origin console: token in the query string, plain JSON. */
  class PlainLink {
    constructor({ base, token, timeout = 12000 }) {
      this.base = String(base || location.origin).replace(/\/+$/, '');
      this.token = token;
      this.timeout = timeout;
      this.connected = false;
      this.rtt = null;
      this.sid = null;
      this.events = [];
    }

    async connect(onStep = () => {}) {
      const steps = [];
      const note = (text, detail) => {
        steps.push({ text, detail: detail || '', at: Date.now() });
        onStep(steps);
      };
      note('Using this computer', this.base);
      note('Checking the token');
      const info = await this.request('system.info', {}, { timeout: this.timeout });
      if (!info.ok) {
        throw new TransportError(info.message || 'the console rejected this connection', {
          code: info.code || 'REFUSED',
          hint: info.code === 'UNAUTHORIZED' ? 'Open the console with the link that includes ?t=<token>.' : '',
        });
      }
      this.connected = true;
      this.rtt = info.ms;
      note('Connected', `${info.ms} ms`);
      return { sid: null, steps, rtt: info.ms };
    }

    async request(cmd, args = {}, { timeout = this.timeout } = {}) {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response;
      try {
        response = await fetch(withToken(`${this.base}/api/command`, this.token), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd, args }),
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (err) {
        throw new TransportError('the console did not answer', {
          code: err.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE',
          hint: 'The agent may have stopped. Start SENTINEL again on the PC.',
        });
      } finally {
        clearTimeout(timer);
      }
      this.rtt = Math.round(performance.now() - started);
      if (response.status === 401 || response.status === 403) {
        throw new TransportError('the console token is wrong or expired', {
          code: 'UNAUTHORIZED',
          hint: 'Open the console from the PC start menu, or paste a fresh token.',
        });
      }
      const json = await response.json();
      return { ...json, ms: this.rtt };
    }

    async status() {
      const response = await fetch(withToken(`${this.base}/api/status`, this.token), { cache: 'no-store' });
      if (!response.ok) throw new TransportError(`status ${response.status}`, { code: `HTTP_${response.status}` });
      const json = await response.json();
      return json.data;
    }

    async poll() {
      return [];
    }

    drainEvents() {
      return [];
    }

    close() {
      this.connected = false;
    }

    describe() {
      return { kind: 'plain', base: this.base, sid: null, rtt: this.rtt };
    }
  }

  /**
   * Ask a URL what lives there, without needing the key. Used by the "Test
   * address" button so a wrong address never looks like a dead app.
   */
  async function probeAddress(rawAddress) {
    const report = { address: String(rawAddress || '').trim(), attempts: [], verdict: 'unknown', device: null };
    if (!report.address) {
      report.verdict = 'empty';
      return report;
    }
    let origin;
    try {
      origin = new URL(normaliseAddress(report.address)).origin;
    } catch (err) {
      report.verdict = 'invalid';
      report.error = err.message;
      return report;
    }
    const targets = [`${origin}/api/health`, `${origin}/status`];
    for (const target of targets) {
      const started = performance.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(target, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timer);
        const ms = Math.round(performance.now() - started);
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        report.attempts.push({ target, ms, status: response.status, body });
        if (response.ok && target.endsWith('/api/health')) {
          report.verdict = 'agent';
          report.device = 'SENTINEL agent';
          return report;
        }
        if (response.ok && body && (body.device || body.fw || body.chip)) {
          report.verdict = 'esp32';
          report.device = body.device || 'ESP32';
          return report;
        }
        if (response.status === 401 || response.status === 403) {
          report.verdict = 'locked';
          report.device = 'SENTINEL agent (needs the key)';
          return report;
        }
      } catch (err) {
        report.attempts.push({
          target,
          ms: Math.round(performance.now() - started),
          error: err.name === 'AbortError' ? 'timed out' : err.message,
        });
      }
    }
    report.verdict = 'silent';
    return report;
  }

  window.SentinelTransport = {
    PROTOCOL,
    TunnelLink,
    PlainLink,
    TransportError,
    normaliseKey,
    normaliseAddress,
    probeAddress,
    bytesToHex,
    hexToBytes,
    toBase64,
    fromBase64,
  };
})();
