'use strict';

const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Config } = require('./config');
const { ActivityLog } = require('./log');
const { Commander } = require('./commands');
const { EspLink } = require('./link');
const { HttpApi } = require('./httpd');
const { Stats } = require('./stats');
const { RateLimiter } = require('./policy');
const { TunnelServer } = require('./tunnel');
const { Brain } = require('./brain');
const { uiDir, memoryDir } = require('./paths');
const pathsModule = require('./paths');
const { openStore } = require('./memory/store');
const { HashingEmbedder, ModelEmbedder } = require('./memory/embeddings');
const { Memory } = require('./memory/memory');
const { Knowledge } = require('./knowledge');
const { TaskManager } = require('./tasks');
const { AutomationEngine } = require('./automation');
const { ApprovalQueue } = require('./security/approvals');
const { Sandbox } = require('./security/sandbox');
const { buildTools } = require('./tools');
const { LlmClient } = require('./ai/llm');
const { AgentRegistry } = require('./ai/agents');
const { Dispatcher } = require('./ai/dispatcher');
const { VoiceEngine } = require('./voice');
const { VisionEngine } = require('./vision');
const { SelfHeal } = require('./selfheal');

/**
 * The agent is the only component with authority over the PC.
 * It owns three surfaces:
 *   1. HTTP/SSE control API for the phone app and the desktop window
 *   2. the ESP32 link (TCP over your VPN/LAN, or USB serial)
 *   3. the command executor with policy, rate limits and audit logging
 */
class Agent extends EventEmitter {
  constructor({ configPath, logFile } = {}) {
    super();
    this.config = new Config(configPath);
    this.log = new ActivityLog({ file: logFile });
    this.stats = new Stats();
    this.state = {
      startedAt: new Date(),
      counters: { commands: 0, errors: 0, shutdowns: 0, reboots: 0 },
      lastCommand: null,
    };
    this.limiter = new RateLimiter(this.config.get('policy.rateLimitPerMinute', 40));
    this.link = new EspLink({ config: this.config, log: this.log });
    this.commander = new Commander({
      config: this.config,
      log: this.log,
      limiter: this.limiter,
      link: this.link,
      state: this.state,
      stats: this.stats,
      brain: this.brain,
    });
    /* ── AI stack ────────────────────────────────────────────────────────
     * Everything below is optional in the sense that a failure here must not
     * stop the machine-control features: if the model stack cannot start, the
     * agent still runs and `doctor` explains why.
     */
    this.aiReady = false;
    this.aiError = null;
    try {
      this.store = openStore({ dir: memoryDir(), log: this.log });
      this.embedder = this.config.get('ai.useModelEmbeddings')
        ? new ModelEmbedder({ llm: null, model: this.config.get('ai.models.embed'), log: this.log })
        : new HashingEmbedder();
      this.memory = new Memory({ store: this.store, embedder: this.embedder, log: this.log, config: this.config });
      this.knowledge = new Knowledge({ store: this.store, embedder: this.embedder, log: this.log, config: this.config });
      this.tasks = new TaskManager({ store: this.store, log: this.log });
      this.approvals = new ApprovalQueue({ log: this.log });
      this.llm = new LlmClient({ config: this.config, log: this.log });
      this.sandbox = new Sandbox({ config: this.config, log: this.log, paths: pathsModule });
      this.voice = new VoiceEngine({ config: this.config, log: this.log, paths: pathsModule });
      this.vision = new VisionEngine({ config: this.config, log: this.log, llm: this.llm, paths: pathsModule });
      this.services = {
        paths: pathsModule,
        stats: this.stats,
        commander: this.commander,
        link: this.link,
        memory: this.memory,
        knowledge: this.knowledge,
        tasks: this.tasks,
        approvals: this.approvals,
        llm: this.llm,
        sandbox: this.sandbox,
        voice: this.voice,
        vision: this.vision,
        store: this.store,
      };
      this.tools = buildTools({ config: this.config, log: this.log, sandbox: this.sandbox, approvals: this.approvals, services: this.services });
      this.agents = new AgentRegistry();
      this.dispatcher = new Dispatcher({
        agents: this.agents,
        tools: this.tools,
        llm: this.llm,
        config: this.config,
        log: this.log,
        memory: this.memory,
        knowledge: this.knowledge,
        tasks: this.tasks,
        approvals: this.approvals,
        services: this.services,
      });
      this.brain = new Brain({
        config: this.config,
        log: this.log,
        llm: this.llm,
        memory: this.memory,
        knowledge: this.knowledge,
        tools: this.tools,
        agents: this.agents,
        tasks: this.tasks,
        dispatcher: this.dispatcher,
        store: this.store,
        approvals: this.approvals,
        commander: this.commander,
        stats: this.stats,
        link: this.link,
        paths: pathsModule,
      });
      this.automation = new AutomationEngine({ store: this.store, log: this.log, config: this.config, commander: this.commander, brain: this.brain });
      this.healing = new SelfHeal({ config: this.config, log: this.log, paths: pathsModule, tools: this.tools, store: this.store, memory: this.memory, llm: this.llm, commander: this.commander });
      // The shared service bag is live: tools resolve these on every call.
      Object.assign(this.services, {
        brain: this.brain,
        agents: this.agents,
        registry: this.tools,
        dispatcher: this.dispatcher,
        automation: this.automation,
        healing: this.healing,
      });
      this.commander.brain = this.brain;
      this.aiReady = true;
      this.log.info('ai', `cognitive core ready: ${this.agents.agents.size} agents, ${this.tools.tools.size} tools, store ${this.store.stats().driver}`);
    } catch (err) {
      this.aiError = err.message;
      this.brain = this.brain || new Brain({ config: this.config, log: this.log });
      this.log.error('ai', `AI stack failed to start: ${err.message} — machine control still works, run doctor`);
    }

    // Our own encrypted channel: the phone talks to this without any VPN.
    this.tunnel = new TunnelServer({
      config: this.config,
      log: this.log,
      commander: this.commander,
      pskBytes: Buffer.from(this.config.get('psk'), 'hex'),
    });
    this.tunnel.onKeyMismatch = () => this.brain.observe(null, { keyMismatch: true });
    this.http = new HttpApi({
      config: this.config,
      log: this.log,
      commander: this.commander,
      link: this.link,
      stats: this.stats,
      state: this.state,
      tunnel: this.tunnel,
      brain: this.brain,
      think: () => this.think(),
      ai: this.aiReady
        ? {
            brain: this.brain,
            tools: this.tools,
            agents: this.agents,
            memory: this.memory,
            knowledge: this.knowledge,
            tasks: this.tasks,
            approvals: this.approvals,
            automation: this.automation,
            llm: this.llm,
            healing: this.healing,
            voice: this.voice,
            vision: this.vision,
            store: this.store,
            sandbox: this.sandbox,
            dispatcher: this.dispatcher,
            ask: (options) => this.ask(options),
            status: () => this.aiStatus(),
          }
        : null,
    });
    this.link.on('connected', (status) => {
      this.emit('esp', status);
      this.http.broadcast('esp', status);
    });
    this.link.on('state', (status) => this.http.broadcast('esp', status));
    this.link.on('disconnected', () => {
      const status = this.link.status();
      this.emit('esp', status);
      this.http.broadcast('esp', status);
    });
    this.log.on('entry', (entry) => {
      this.http.broadcast('log', entry);
      // Tunnel clients get the same feed, delivered with their next frame.
      this.tunnel.pushEvent({ event: 'log', data: entry });
    });

    this.brainSignature = '';
    this.brainTimer = setInterval(() => this.think(), 15000);
    this.brainTimer.unref?.();

    this.on('command-failed', (detail) => {
      this.brain.observe(null, { commandFailed: detail });
    });
    this.on('key-mismatch', () => {
      this.brain.observe(null, { keyMismatch: true });
    });

    /**
     * The ESP32 is dumb hardware on purpose: when it cannot handle a command
     * itself it relays the request here over its authenticated link.
     */
    this.link.rpcHandler = async (payload) => {
      let request;
      try {
        request = JSON.parse(payload);
      } catch {
        return JSON.stringify({ ok: false, code: 'BAD_REQUEST', message: 'relay payload is not JSON' });
      }
      const cmd = String(request.cmd || '');
      const args = request.args && typeof request.args === 'object' ? request.args : {};
      try {
        const result = await this.commander.execute(cmd, args, { source: 'esp32' });
        return JSON.stringify({ id: request.id ?? null, ok: true, cmd, data: result.data, ms: result.ms });
      } catch (err) {
        return JSON.stringify({
          id: request.id ?? null,
          ok: false,
          cmd,
          code: err.code || 'FAILED',
          message: err.message,
          detail: err.detail,
        });
      }
    };
    this.started = false;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.link.start();
    this.http.start();
    if (this.aiReady) this.automation.start();
    this.log.info('agent', `SENTINEL ${require('../package.json').version} on ${os.hostname()} (${process.platform})`);
    const port = this.config.get('ports.ui');
    const token = this.config.get('uiToken');
    const host = this.http.primaryAddress();
    this.loginUrl = `http://127.0.0.1:${port}/?t=${token}`;
    this.lanUrl = `http://${host}:${port}/?t=${token}`;
    this.log.info('tunnel', 'Encrypted tunnel ready on /api/tunnel (no VPN needed)');
    this.log.info('agent', `Open ${this.loginUrl}`);
    if (host !== '127.0.0.1') this.log.info('agent', `Phone/tablet: ${this.lanUrl}`);
    return this;
  }

  /**
   * One assistant turn. Returns the full answer object; streaming is handled by
   * the HTTP layer through `onToken`/`onStage`.
   */
  async ask({ text, mode = null, sessionId = 'default', runId = null, signal = null, onToken = null, onStage = null, images = null } = {}) {
    if (!this.aiReady) {
      throw Object.assign(new Error(`the AI stack is not running: ${this.aiError || 'unknown error'}`), { code: 'AI_NOT_READY' });
    }
    const answer = await this.brain.ask({ text, mode, sessionId, runId, signal, onToken, onStage, images });
    if (this.memory) {
      this.memory.appendTurn(sessionId, 'user', String(text || '').slice(0, 4000), { runId: answer.runId });
      this.memory.appendTurn(sessionId, 'assistant', String(answer.text || '').slice(0, 8000), { runId: answer.runId, agent: answer.agent });
    }
    this.state.counters.aiAnswers = (this.state.counters.aiAnswers || 0) + 1;
    this.http.broadcast('chat', { runId: answer.runId, agent: answer.agent, text: answer.text.slice(0, 400), mode: answer.mode, ms: answer.ms });
    return answer;
  }

  /** What the Diagnostics tab and the CLI need to know about the AI stack. */
  aiStatus() {
    if (!this.aiReady) {
      return { ready: false, error: this.aiError, fallback: 'machine control, policy and tunnel are unaffected' };
    }
    return {
      ready: true,
      brain: this.brain.status(),
      dispatcher: this.dispatcher.stats(),
      agents: this.agents.stats(),
      tools: this.tools.stats().counters,
      toolCategories: this.tools.categories(),
      memory: this.memory.stats(),
      knowledge: this.knowledge.stats(),
      tasks: this.tasks.stats(),
      automations: this.automation.stats(),
      approvals: this.approvals.stats(),
      llm: this.llm.stats(),
      healing: this.healing.stats(),
      voice: this.voice.counters,
      vision: this.vision.counters,
    };
  }

  /** One pass of the advisory engine; only broadcasts when something changed. */
  async think() {
    try {
      const snapshot = await this.commander.handlers['system.snapshot']();
      const insights = this.brain.observe(snapshot, { lastCommand: this.state.lastCommand });
      const signature = this.brain.signature();
      if (signature !== this.brainSignature) {
        this.brainSignature = signature;
        this.http.broadcast('insights', insights);
        this.tunnel.pushEvent({ event: 'insights', data: insights });
      }
      return insights;
    } catch (err) {
      this.log.debug('brain', `pass failed: ${err.message}`);
      return this.brain.list();
    }
  }

  stop() {
    clearInterval(this.brainTimer);
    if (this.automation) this.automation.stop();
    if (this.llm) this.llm.cancelAll('agent stopping');
    this.tunnel.stop();
    this.http.stop();
    this.link.stop();
    this.log.info('agent', 'Stopped');
    this.started = false;
  }

  status() {
    return {
      name: this.config.get('name'),
      platform: process.platform,
      uiPort: this.config.get('ports.ui'),
      linkPort: this.config.get('ports.link'),
      esp: this.link.status(),
      policy: this.config.get('policy'),
      counters: this.state.counters,
      startedAt: this.state.startedAt,
      uiDir: uiDir(),
      tunnel: this.tunnel.liveSessions(),
      ai: this.aiReady
        ? { ready: true, agents: this.agents.agents.size, tools: this.tools.tools.size, mode: this.config.get('ai.mode') }
        : { ready: false, error: this.aiError },
      loginUrl: this.loginUrl,
      lanUrl: this.lanUrl,
    };
  }
}

function createAgent(opts) {
  return new Agent(opts);
}

module.exports = { Agent, createAgent };
