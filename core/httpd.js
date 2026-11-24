'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqualHex } = require('./util');
const { uiDir } = require('./paths');
const { AGENT_VERSION } = require('./commands');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 256 * 1024;

/**
 * Local control surface: static UI + JSON API + Server-Sent Events.
 * SSE (not WebSocket) keeps the agent dependency-free while still being live.
 */
class HttpApi {
  constructor({ config, log, commander, link, stats, state, tunnel, brain, think, ai = null }) {
    this.config = config;
    this.log = log;
    this.commander = commander;
    this.link = link;
    this.stats = stats;
    this.state = state;
    this.tunnel = tunnel || null;
    this.brain = brain || null;
    this.think = think || (async () => (this.brain ? this.brain.list() : []));
    this.ai = ai || null;
    this.chatRuns = new Map(); // runId → AbortController
    this.server = null;
    this.clients = new Set();
    this.failures = new Map();
    this.uiRoot = uiDir();
    // Loopback auto-login is opt-in and only for local demo/preview use: it
    // redirects the bare URL to the tokenised one instead of weakening auth.
    this.autoLogin = process.env.SENTINEL_AUTO_LOGIN === '1';
  }

  start() {
    const port = this.config.get('ports.ui');
    const bind = this.config.get('bind') || '0.0.0.0';
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('error', (err) => {
      // Port already taken is the most common startup failure. It must show up
      // as a diagnosis, not as an unhandled exception that kills the agent.
      this.lastError = err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message;
      this.log.error('http', `could not start the control UI on port ${port}: ${this.lastError}`);
    });
    this.server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    this.server.listen(port, bind, () => {
      this.log.info('http', `Control UI on http://${bind}:${port}`);
    });
    this.timer = setInterval(() => this.broadcastStatus(), 2000);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.server?.close();
  }

  /* ------------------------------------------------------------- plumbing */

  cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-sentinel-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  }

  tokenFrom(req, url) {
    const header = req.headers.authorization || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    if (req.headers['x-sentinel-token']) return String(req.headers['x-sentinel-token']);
    return url.searchParams.get('t') || '';
  }

  authorised(req, url) {
    const expected = this.config.get('uiToken');
    const supplied = this.tokenFrom(req, url);
    if (supplied && timingSafeEqualHex(supplied, expected)) return true;
    const ip = req.socket.remoteAddress || 'unknown';
    const record = this.failures.get(ip) || { count: 0, until: 0 };
    if (record.until > Date.now()) return false;
    record.count += 1;
    if (record.count > 12) {
      record.until = Date.now() + 5 * 60 * 1000;
      record.count = 0;
      this.log.warn('http', `Too many bad tokens from ${ip} — locked for 5 minutes`);
    }
    this.failures.set(ip, record);
    return false;
  }

  async body(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  /* --------------------------------------------------------------- routes */

  async handle(req, res) {
    this.cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return this.json(res, 400, { ok: false, error: 'Bad URL' });
    }
    const route = url.pathname;

    try {
      // Only the three handshake/traffic endpoints are handled by the tunnel;
      // /api/tunnel/sessions stays a normal, token-protected API call.
      if (route === '/api/tunnel/hello' || route === '/api/tunnel/open' || route === '/api/tunnel/msg') {
        return await this.tunnelRoute(req, res, route);
      }

      if (route === '/api/health') {
        return this.json(res, 200, {
          ok: true,
          app: 'sentinel',
          name: this.config.get('name'),
          version: AGENT_VERSION,
          authRequired: true,
        });
      }

      if (route.startsWith('/api/')) {
        if (!this.authorised(req, url)) {
          return this.json(res, 401, { ok: false, code: 'UNAUTHORISED', message: 'Missing or invalid token' });
        }
        return await this.api(req, res, route, url);
      }

      if (this.autoLogin && route === '/' && this.isLoopback(req) && !url.searchParams.has('t')) {
        res.writeHead(302, { location: `/?t=${this.config.get('uiToken')}` });
        return res.end();
      }

      return this.serveStatic(req, res, route);
    } catch (err) {
      const status = err.status || 500;
      this.log.debug('http', `Request ${route} failed: ${err.message}`);
      return this.json(res, status, { ok: false, code: err.code || 'ERROR', message: err.message });
    }
  }

  /**
   * The tunnel replaces the bearer token with an ECDH session: the pairing key
   * proves who you are, and everything after the handshake is AES-256-GCM.
   */
  async tunnelRoute(req, res, route) {
    if (!this.tunnel) return this.json(res, 503, { error: 'tunnel disabled' });
    if (req.method !== 'POST') return this.json(res, 405, { error: 'POST only' });
    let body;
    try {
      body = await this.body(req);
    } catch (err) {
      return this.json(res, err.status || 400, { error: err.message });
    }
    const ip = req.socket.remoteAddress || 'unknown';
    const action = route.slice('/api/tunnel/'.length);

    if (action === 'hello') {
      const result = this.tunnel.hello(body, ip);
      return this.json(res, result.status, result.body);
    }
    if (action === 'open') {
      const result = this.tunnel.open(body);
      return this.json(res, result.status, result.body);
    }
    if (action === 'msg') {
      const result = await this.tunnel.message(body, ip);
      if (result.status !== 200) this.log.debug('tunnel', `frame refused: ${result.body.error}`);
      return this.json(res, result.status, result.body);
    }
    if (action === 'sessions' && req.method === 'POST') {
      // Diagnostics are still token-protected through the normal API.
      return this.json(res, 404, { error: 'unknown tunnel action' });
    }
    return this.json(res, 404, { error: `unknown tunnel action "${action}"` });
  }

  async api(req, res, route, url) {
    if (route === '/api/events' && req.method === 'GET') return this.events(req, res);

    if (route === '/api/status' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, data: await this.snapshot() });
    }

    if (route === '/api/command' && req.method === 'POST') {
      const body = await this.body(req);
      const cmd = String(body.cmd || '');
      try {
        const result = await this.commander.execute(cmd, body.args || {}, {
          source: 'ui',
          ip: req.socket.remoteAddress,
        });
        return this.json(res, 200, { ok: true, cmd, data: result.data, ms: result.ms });
      } catch (err) {
        return this.json(res, 200, { ok: false, cmd, code: err.code || 'FAILED', message: err.message, detail: err.detail });
      }
    }

    if (route === '/api/policy' && req.method === 'POST') {
      const body = await this.body(req);
      const policy = this.config.setPolicy(body.patch || body);
      this.commander.limiter.setLimit(policy.rateLimitPerMinute);
      this.log.warn('policy', `Policy updated: ${Object.keys(body.patch || body).join(', ')}`);
      this.broadcast('policy', policy);
      return this.json(res, 200, { ok: true, data: policy });
    }

    if (route === '/api/pairing' && req.method === 'GET') {
      const host = this.primaryAddress();
      return this.json(res, 200, {
        ok: true,
        data: {
          ...this.config.pairingSnippet(host),
          ui_url: `http://${host}:${this.config.get('ports.ui')}`,
          token: this.config.get('uiToken'),
          esp_status_url: `http://<esp32-ip>/status`,
          esp_power_url: `http://<esp32-ip>/power?action=on&t=${this.config.espPowerToken()}`,
        },
      });
    }

    if (route === '/api/keys' && req.method === 'POST') {
      const body = await this.body(req);
      if (body.confirm !== true) {
        return this.json(res, 200, { ok: false, code: 'CONFIRM_REQUIRED', message: 'Rotating keys disconnects every device' });
      }
      const keys = this.config.rotateKeys();
      this.log.warn('security', 'Pairing key and UI token rotated');
      return this.json(res, 200, { ok: true, data: keys });
    }

    if (route === '/api/tunnel/sessions' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, data: this.tunnel ? this.tunnel.liveSessions() : [] });
    }

    if (route === '/api/insights' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, data: this.brain ? this.brain.list() : [] });
    }

    if (route === '/api/brain/think' && req.method === 'POST') {
      // Force one pass — handy from the desktop tray menu and for tests.
      const insights = await this.think();
      return this.json(res, 200, { ok: true, data: insights });
    }

    if (route === '/api/insights/dismiss' && req.method === 'POST') {
      const body = await this.body(req);
      const dismissed = this.brain ? this.brain.dismiss(String(body.id || '')) : false;
      return this.json(res, 200, { ok: dismissed, data: this.brain ? this.brain.list() : [] });
    }


    /* ── assistant ─────────────────────────────────────────────────────── */

    if (route === '/api/chat' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, code: 'AI_NOT_READY', message: 'the AI stack is not running; see Diagnostics' });
      const body = await this.body(req);
      const text = String(body.text || '').trim();
      if (!text) return this.json(res, 200, { ok: false, code: 'EMPTY', message: 'ask me something' });
      if (text.length > 12000) return this.json(res, 200, { ok: false, code: 'TOO_LONG', message: 'that message is too long (12k characters max)' });
      const runId = String(body.runId || `ui_${Date.now().toString(36)}`);
      const controller = new AbortController();
      this.chatRuns.set(runId, controller);
      const sessionId = String(body.sessionId || 'default').slice(0, 60);
      const images = Array.isArray(body.images)
        ? body.images.slice(0, 3).map((image) => ({ mime: String(image.mime || 'image/png'), name: String(image.name || 'image'), data: String(image.data || '') })).filter((image) => image.data)
        : [];
      return this.streamChat(req, res, { runId, text, mode: body.mode || null, sessionId, images, controller });
    }

    if (route === '/api/chat/stop' && req.method === 'POST') {
      const body = await this.body(req).catch(() => ({}));
      const wanted = body.runId ? String(body.runId) : null;
      let stopped = 0;
      for (const [runId, controller] of this.chatRuns) {
        if (wanted && runId !== wanted) continue;
        controller.abort(Object.assign(new Error('stopped by the user'), { code: 'CANCELLED' }));
        this.chatRuns.delete(runId);
        stopped += 1;
      }
      if (this.ai && this.ai.llm) this.ai.llm.cancelAll('stopped by the user');
      if (this.ai && this.ai.brain) this.ai.brain.cancelAll('stopped by the user');
      this.log.warn('ai', `STOP pressed (${stopped} run(s))`);
      return this.json(res, 200, { ok: true, stopped });
    }

    if (route === '/api/chat/history' && req.method === 'GET') {
      if (!this.ai || !this.ai.memory) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const sessionId = String(url.searchParams.get('session') || 'default');
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 60);
      return this.json(res, 200, { ok: true, data: this.ai.memory.turns(sessionId, limit) });
    }


    /* ── voice ─────────────────────────────────────────────────────────── */

    if (route === '/api/voice/transcribe' && req.method === 'POST') {
      if (!this.ai || !this.ai.voice) return this.json(res, 503, { ok: false, code: 'AI_NOT_READY', message: 'voice engine is not running' });
      const body = await this.body(req);
      const audio = String(body.audio || '');
      if (!audio) return this.json(res, 200, { ok: false, code: 'EMPTY', message: 'no audio was sent' });
      if (audio.length > 24 * 1024 * 1024) return this.json(res, 200, { ok: false, code: 'TOO_LONG', message: 'audio is too large (18 MB max)' });
      const ext = String(body.format || 'webm').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'webm';
      const dir = path.join(os.tmpdir(), 'sentinel');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `stt-${Date.now().toString(36)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(audio, 'base64'));
      try {
        const result = await this.ai.voice.transcribe(file, { language: String(body.language || 'auto') });
        return this.json(res, 200, { ok: true, text: result.text, ms: result.ms });
      } catch (err) {
        return this.json(res, 200, { ok: false, code: err.code || 'STT_FAILED', message: err.message });
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }

    if (route === '/api/voice/speak' && req.method === 'POST') {
      if (!this.ai || !this.ai.voice) return this.json(res, 503, { ok: false, code: 'AI_NOT_READY', message: 'voice engine is not running' });
      const body = await this.body(req);
      const text = String(body.text || '').slice(0, 3000);
      if (!text.trim()) return this.json(res, 200, { ok: false, code: 'EMPTY', message: 'nothing to say' });
      try {
        const result = await this.ai.voice.speak(text, { voice: body.voice || null, rate: Number(body.rate) || 0 });
        const data = result.file ? fs.readFileSync(result.file).toString('base64') : null;
        return this.json(res, 200, { ok: true, mime: result.mime || 'audio/wav', audio: data, engine: result.engine });
      } catch (err) {
        return this.json(res, 200, { ok: false, code: err.code || 'TTS_FAILED', message: err.message });
      }
    }

    if (route === '/api/voice/status' && req.method === 'GET') {
      if (!this.ai || !this.ai.voice) return this.json(res, 200, { ok: false, data: { ready: false } });
      return this.json(res, 200, { ok: true, data: await this.ai.voice.status() });
    }

    if (route === '/api/ai/status' && req.method === 'GET') {
      return this.json(res, 200, { ok: Boolean(this.ai), data: this.ai ? this.ai.status() : { ready: false } });
    }

    if (route === '/api/ai/mode' && req.method === 'POST') {
      const body = await this.body(req);
      const mode = String(body.mode || '');
      if (!['fast', 'balanced', 'deep'].includes(mode)) {
        return this.json(res, 200, { ok: false, code: 'BAD_ARGS', message: 'mode must be fast, balanced or deep' });
      }
      this.config.set('ai.mode', mode);
      this.log.info('ai', `Reasoning mode → ${mode}`);
      return this.json(res, 200, { ok: true, data: { mode } });
    }

    if (route === '/api/agents' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      return this.json(res, 200, { ok: true, data: this.ai.agents.list(), stats: this.ai.agents.stats() });
    }

    if (route === '/api/tools' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const category = url.searchParams.get('category');
      const search = url.searchParams.get('q');
      let tools = this.ai.tools.list({ category: category || null });
      if (search) tools = tools.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(String(search).toLowerCase()));
      return this.json(res, 200, { ok: true, data: tools, categories: this.ai.tools.categories(), counters: this.ai.tools.stats().counters });
    }

    if (route === '/api/models' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const status = await this.ai.llm.status();
      return this.json(res, 200, { ok: true, data: status });
    }

    if (route === '/api/models/benchmark' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req).catch(() => ({}));
      try {
        const result = await this.ai.llm.benchmark({ modelClass: ['fast', 'balanced', 'deep', 'code'].includes(body.modelClass) ? body.modelClass : 'balanced' });
        return this.json(res, 200, { ok: true, data: result });
      } catch (err) {
        return this.json(res, 200, { ok: false, code: err.code || 'FAILED', message: err.message });
      }
    }

    /* ── approvals ─────────────────────────────────────────────────────── */

    if (route === '/api/approvals' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      return this.json(res, 200, { ok: true, data: this.ai.approvals.list({ includeSettled: url.searchParams.get('settled') === '1' }) });
    }

    if (route === '/api/approvals/decide' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req);
      const id = String(body.id || '');
      const entry = this.ai.approvals.get(id);
      if (!entry) return this.json(res, 200, { ok: false, code: 'NOT_FOUND', message: 'that approval expired or was already used' });
      if (body.approve !== true) {
        this.ai.approvals.deny(id, { reason: String(body.reason || 'denied in the UI') });
        this.broadcast('approvals', this.ai.approvals.list());
        return this.json(res, 200, { ok: true, approved: false, id });
      }
      const result = await this.ai.tools.execute(entry.tool, entry.args, { approvalId: id, source: 'ui', sessionId: 'ui' });
      this.broadcast('approvals', this.ai.approvals.list());
      return this.json(res, 200, { ok: result.ok, approved: true, id, result: { code: result.code || null, message: result.message || null, data: result.data || null, text: result.text ? String(result.text).slice(0, 4000) : null } });
    }

    /* ── memory & knowledge ────────────────────────────────────────────── */

    if (route === '/api/memory' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const q = url.searchParams.get('q');
      const kind = url.searchParams.get('kind');
      if (q) {
        const hits = await this.ai.memory.recall(q, { limit: 20, kinds: kind ? [kind] : null });
        return this.json(res, 200, { ok: true, data: hits.map((hit) => ({ ...hit.record, score: hit.score, vector: undefined })) });
      }
      return this.json(res, 200, { ok: true, data: this.ai.memory.list({ kind: kind || null, limit: 100 }).map((record) => ({ ...record, vector: undefined })), stats: this.ai.memory.stats() });
    }

    if (route === '/api/memory' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req);
      if (body.action === 'forget') {
        const forgotten = this.ai.memory.forget(String(body.id || ''));
        return this.json(res, 200, { ok: forgotten });
      }
      const result = await this.ai.memory.remember({
        kind: body.kind || 'long_term',
        text: String(body.text || ''),
        tags: Array.isArray(body.tags) ? body.tags : [],
        importance: Number(body.importance) || 0.6,
        source: 'ui',
      });
      return this.json(res, 200, { ok: Boolean(result.record), rejected: result.rejected || null, id: result.record ? result.record.id : null });
    }

    if (route === '/api/knowledge' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const q = url.searchParams.get('q');
      if (q) return this.json(res, 200, { ok: true, data: await this.ai.knowledge.search(q, { limit: 10 }) });
      return this.json(res, 200, { ok: true, data: this.ai.knowledge.list({ limit: 100 }), stats: this.ai.knowledge.stats() });
    }

    if (route === '/api/knowledge' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req);
      if (body.action === 'remove') {
        return this.json(res, 200, { ok: this.ai.knowledge.remove(String(body.id || '')) });
      }
      if (body.text) {
        const result = await this.ai.knowledge.indexText({ title: body.title || 'notatka z UI', text: String(body.text), tags: body.tags || [] });
        return this.json(res, 200, { ok: true, data: { docId: result.doc.id, chunks: result.chunks } });
      }
      if (!body.path) return this.json(res, 200, { ok: false, code: 'BAD_ARGS', message: 'give a path or text to index' });
      try {
        const resolved = this.ai.sandbox.resolve(String(body.path), { write: false });
        const result = await this.ai.knowledge.indexPath(resolved, { recursive: body.recursive !== false, maxFiles: Math.min(2000, Number(body.maxFiles) || 300), tags: body.tags || [] });
        return this.json(res, 200, { ok: true, data: { scanned: result.scanned, indexed: result.indexed, skipped: result.skipped, documents: result.documents.map((doc) => ({ id: doc.id, title: doc.title, chunks: doc.chunks })) } });
      } catch (err) {
        return this.json(res, 200, { ok: false, code: err.code || 'FAILED', message: err.message });
      }
    }

    /* ── tasks & automations ───────────────────────────────────────────── */

    if (route === '/api/tasks' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const status = url.searchParams.get('status');
      return this.json(res, 200, { ok: true, data: this.ai.tasks.list({ status: status || null, limit: 100 }), stats: this.ai.tasks.stats() });
    }

    if (route === '/api/tasks/cancel' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req);
      return this.json(res, 200, { ok: this.ai.tasks.cancel(String(body.id || ''), 'cancelled in the UI') });
    }

    if (route === '/api/automations' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      return this.json(res, 200, { ok: true, data: this.ai.automation.list(), stats: this.ai.automation.stats() });
    }

    if (route === '/api/automations' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      const body = await this.body(req);
      try {
        if (body.action === 'toggle') return this.json(res, 200, { ok: true, data: this.ai.automation.toggle(String(body.id || ''), Boolean(body.enabled)) });
        if (body.action === 'delete') return this.json(res, 200, { ok: this.ai.automation.remove(String(body.id || '')) });
        if (body.action === 'run') return this.json(res, 200, { ok: true, data: await this.ai.automation.run(String(body.id || ''), { trigger: 'manual' }) });
        const item = this.ai.automation.create({
          name: body.name,
          trigger: { type: body.type === 'daily' ? 'daily' : 'interval', everyMinutes: Number(body.everyMinutes) || 60, at: body.at },
          action: { type: body.actionType === 'command' ? 'command' : 'prompt', prompt: body.prompt, command: body.command },
        });
        return this.json(res, 200, { ok: true, data: item });
      } catch (err) {
        return this.json(res, 200, { ok: false, code: err.code || 'FAILED', message: err.message });
      }
    }

    /* ── diagnostics ───────────────────────────────────────────────────── */

    if (route === '/api/diagnostics' && req.method === 'GET') {
      const snapshot = await this.snapshot();
      return this.json(res, 200, { ok: true, data: { snapshot, ai: this.ai ? this.ai.status() : null } });
    }

    if (route === '/api/doctor' && req.method === 'POST') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      return this.json(res, 200, { ok: true, data: await this.ai.healing.diagnose() });
    }

    if (route === '/api/backups' && req.method === 'GET') {
      if (!this.ai) return this.json(res, 503, { ok: false, error: 'AI not ready' });
      return this.json(res, 200, { ok: true, data: this.ai.healing.listBackups() });
    }

    if (route === '/api/log' && req.method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      return this.json(res, 200, { ok: true, data: this.log.recent(limit) });
    }

    if (route === '/api/macros' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, data: this.config.get('macros', {}) });
    }

    if (route === '/api/macros' && req.method === 'POST') {
      const body = await this.body(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return this.json(res, 200, { ok: false, code: 'BAD_ARGS', message: 'Macro needs a name' });
      if (!Array.isArray(body.steps) || body.steps.length === 0) {
        return this.json(res, 200, { ok: false, code: 'BAD_ARGS', message: 'Macro needs at least one step' });
      }
      const steps = body.steps.slice(0, 24).map((step) => ({
        cmd: String(step.cmd || '').slice(0, 60),
        args: step.args && typeof step.args === 'object' ? step.args : {},
        waitMs: Math.max(0, Math.min(5000, Number(step.waitMs) || 300)),
      }));
      const macros = { ...this.config.get('macros', {}), [name]: { description: String(body.description || '').slice(0, 120), steps } };
      this.config.merge({ macros });
      this.log.info('macro', `Saved macro "${name}" with ${steps.length} steps`);
      this.broadcast('macros', macros);
      return this.json(res, 200, { ok: true, data: macros[name] });
    }

    if (route.startsWith('/api/macros/') && req.method === 'DELETE') {
      const name = decodeURIComponent(route.split('/')[3] || '');
      const macros = { ...this.config.get('macros', {}) };
      if (!macros[name]) return this.json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'No such macro' });
      delete macros[name];
      this.config.merge({ macros });
      this.log.info('macro', `Deleted macro "${name}"`);
      this.broadcast('macros', Object.keys(macros));
      return this.json(res, 200, { ok: true });
    }

    if (route === '/api/apps' && req.method === 'POST') {
      const body = await this.body(req);
      const name = String(body.name || '').trim().slice(0, 40);
      const target = String(body.path || '').trim();
      if (!name || !target) return this.json(res, 200, { ok: false, code: 'BAD_ARGS', message: 'App needs a name and a path' });
      const apps = { ...this.config.get('apps', {}), [name]: { path: target, label: String(body.label || name).slice(0, 60) } };
      this.config.merge({ apps });
      this.log.info('apps', `Allow-listed app "${name}"`);
      return this.json(res, 200, { ok: true, data: apps[name] });
    }

    if (route.startsWith('/api/apps/') && req.method === 'DELETE') {
      const name = decodeURIComponent(route.split('/')[3] || '');
      const apps = { ...this.config.get('apps', {}) };
      delete apps[name];
      this.config.merge({ apps });
      return this.json(res, 200, { ok: true });
    }

    if (route === '/api/settings' && req.method === 'POST') {
      const body = await this.body(req);
      const patch = {};
      if (body.name) patch.name = String(body.name).slice(0, 48);
      if (typeof body.allowLan === 'boolean') {
        this.log.warn('security', `LAN binding ${body.allowLan ? 'enabled' : 'disabled'} (restart required)`);
      }
      if (Object.keys(patch).length) {
        this.config.merge(patch);
        this.broadcast('settings', { name: patch.name });
      }
      return this.json(res, 200, { ok: true, data: this.config.get('name') });
    }

    return this.json(res, 404, { ok: false, code: 'NOT_FOUND', message: `No route ${route}` });
  }

  async snapshot() {
    const base = await this.commander.handlers['system.snapshot']();
    return {
      ...base,
      memory: this.stats.memory(),
      appList: this.commander.handlers['app.list'](),
    };
  }

  events(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    const hello = { at: new Date().toISOString(), clients: this.clients.size };
    res.write(`event: ready\ndata: ${JSON.stringify(hello)}\n\n`);
    for (const entry of this.log.recent(40)) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  broadcastStatus() {
    if (this.clients.size === 0) return;
    this.broadcast('status', {
      cpuPercent: this.stats.read(),
      memory: this.stats.memory(),
      esp: this.link ? this.link.status() : { connected: false },
      uptimeSec: Math.round((Date.now() - this.state.startedAt.getTime()) / 1000),
      lastCommand: this.state.lastCommand,
      counters: this.state.counters,
      at: new Date().toISOString(),
    });
  }

  /**
   * Streams one assistant turn as newline-delimited JSON: stage events, tokens,
   * then the final answer. NDJSON over fetch keeps the browser able to abort the
   * request, which is what makes STOP immediate.
   */
  async streamChat(req, res, { runId, text, mode, sessionId, images = [], controller }) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event) => {
      if (res.writableEnded) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        /* client went away */
      }
    };
    const cleanup = () => {
      this.chatRuns.delete(runId);
      if (!res.writableEnded) res.end();
    };
    // A hung client must not keep a model run alive forever.
    const idle = setTimeout(() => controller.abort(Object.assign(new Error('stream timed out'), { code: 'TIMEOUT' })), 10 * 60 * 1000);
    if (idle.unref) idle.unref();
    res.on('close', () => {
      clearTimeout(idle);
      if (!controller.signal.aborted) controller.abort(Object.assign(new Error('client disconnected'), { code: 'CANCELLED' }));
    });

    write({ type: 'start', runId, at: new Date().toISOString() });
    let answered = false;
    try {
      const answer = await this.ai.brain.ask({
        text,
        mode,
        sessionId,
        runId,
        images,
        signal: controller.signal,
        onToken: (token) => write({ type: 'token', text: token }),
        onStage: (event) => write({ type: 'stage', ...event }),
      });
      write({ type: 'final', ...answer });
      answered = true;
      if (answer.text) {
        this.ai.memory.appendTurn(sessionId, 'user', text.slice(0, 4000), { runId });
        this.ai.memory.appendTurn(sessionId, 'assistant', answer.text.slice(0, 8000), { runId, agent: answer.agent });
      }
    } catch (err) {
      write({ type: 'error', code: err.code || 'FAILED', message: err.message });
    } finally {
      clearTimeout(idle);
      if (!answered) write({ type: 'final', text: '', cancelled: controller.signal.aborted, error: true });
      cleanup();
    }
  }

  /* --------------------------------------------------------------- static */

  serveStatic(req, res, route) {
    const root = this.uiRoot;
    let target = decodeURIComponent(route === '/' ? '/index.html' : route);
    const filePath = path.normalize(path.join(root, target));
    if (!filePath.startsWith(path.normalize(root))) {
      return this.json(res, 403, { ok: false, error: 'Forbidden' });
    }
    const finish = (file, status = 200) => {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(status, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      });
      fs.createReadStream(file)
        .on('error', () => res.end())
        .pipe(res);
    };
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return finish(filePath);
    // SPA fallback
    const index = path.join(root, 'index.html');
    if (fs.existsSync(index)) return finish(index);
    return this.json(res, 404, { ok: false, error: 'UI not found' });
  }

  isLoopback(req) {
    const address = req.socket.remoteAddress || '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  primaryAddress() {
    const os = require('node:os');
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const [name, addresses] of Object.entries(nets)) {
      for (const addr of addresses || []) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const score = /^wg/i.test(name) ? 3 : /^10\./.test(addr.address) ? 2 : 1;
        candidates.push({ address: addr.address, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.address || '127.0.0.1';
  }
}

module.exports = { HttpApi };
