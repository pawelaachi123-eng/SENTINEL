'use strict';

const os = require('node:os');
const path = require('node:path');
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
const { GraphRAG } = require('./knowledge/graphrag');
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
const { CognitiveCore } = require('./cognition');
const { ContextManager } = require('./context');
const { PatchManager } = require('./patching');
const { SemanticInterpreter } = require('./semantics');
const { Executor } = require('./executor');
const { KnowledgeGraph } = require('./graph');
const { McpHub } = require('./mcp');
const { RuntimeManager } = require('./runtime');
const { NeuralRuntime } = require('./neural');
const { Reasoner } = require('./reasoning');
const { SkillLibrary } = require('./skills');
const { RepoMap } = require('./repomap');
const { LearningLab } = require('./lab');
const { TrainingLab } = require('./lab/index.js');
const { ResearchService } = require('./research');
const { RerankerLab } = require('./reranker');
const { HyperCore } = require('./cognition/hypercore');
const { CommunicationManager } = require('./communication');
const { DailyBriefing } = require('./briefing');
const { CalendarStore } = require('./calendar');
const { ProactiveEngine } = require('./proactive');
const { SpecialistZoo } = require('./specialists');
const { Organisation } = require('./org');
const { ExperienceStore } = require('./experience');
const { EventBus } = require('./events');
const { Metrics } = require('./metrics');
const { IncidentLog, Watchdog } = require('./reliability');

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
    const bootStarted = Date.now();
    this.metrics = new Metrics({ log: this.log });
    this.incidents = new IncidentLog();
    try {
      this.store = openStore({ dir: memoryDir(), log: this.log });
      this.events = new EventBus({ log: this.log, store: this.store });
      this.cognitive = new CognitiveCore({ config: this.config, log: this.log });
      this.context = new ContextManager({ config: this.config, log: this.log });
      this.experience = new ExperienceStore({ store: this.store, log: this.log });
      this.patches = new PatchManager({ paths: pathsModule, sandbox: null, log: this.log, store: this.store, config: this.config });
      this.embedder = this.config.get('ai.useModelEmbeddings')
        ? new ModelEmbedder({ llm: null, model: this.config.get('ai.models.embed'), log: this.log })
        : new HashingEmbedder();
      this.memory = new Memory({ store: this.store, embedder: this.embedder, log: this.log, config: this.config });
      this.graphRag = new GraphRAG({ dataDir: pathsModule.dataDir(), log: this.log });
      this.knowledge = new Knowledge({ store: this.store, embedder: this.embedder, log: this.log, config: this.config, graph: this.graphRag });
      this.tasks = new TaskManager({ store: this.store, log: this.log });
      this.calendar = new CalendarStore({ store: this.store });
      this.approvals = new ApprovalQueue({ log: this.log });
      this.llm = new LlmClient({ config: this.config, log: this.log, metrics: this.metrics, events: this.events, experience: this.experience });
      this.runtime = new RuntimeManager({ config: this.config, llm: this.llm, log: this.log });
      this.neural = new NeuralRuntime({ config: this.config, llm: this.llm, log: this.log, store: this.store, runtime: this.runtime });
      this.semantics = new SemanticInterpreter({ cognitive: this.cognitive, llm: this.llm, log: this.log, config: this.config });
      this.sandbox = new Sandbox({ config: this.config, log: this.log, paths: pathsModule });
      if (this.patches) this.patches.sandbox = this.sandbox;
      this.voice = new VoiceEngine({ config: this.config, log: this.log, paths: pathsModule });
      this.vision = new VisionEngine({ config: this.config, log: this.log, llm: this.llm, paths: pathsModule });
      this.graph = new KnowledgeGraph({ store: this.store, log: this.log });
      this.services = {
        paths: pathsModule,
        // The tools and the brain share one instance, so a graph written by a
        // tool is immediately visible to retrieval (and vice versa).
        graph: this.graph,
        stats: this.stats,
        commander: this.commander,
        link: this.link,
        memory: this.memory,
        knowledge: this.knowledge,
        tasks: this.tasks,
        calendar: this.calendar,
        approvals: this.approvals,
        llm: this.llm,
        sandbox: this.sandbox,
        voice: this.voice,
        vision: this.vision,
        store: this.store,
      };
      this.services.graphRag = this.graphRag;
      this.tools = buildTools({ config: this.config, log: this.log, sandbox: this.sandbox, approvals: this.approvals, services: this.services });
      this.mcp = new McpHub({ config: this.config, log: this.log, registry: this.tools, store: this.store });
      this.services.mcp = this.mcp;
      this.services.runtime = this.runtime;
      this.services.neural = this.neural;
      this.services.tools = this.tools;
      // The reasoner may measure with read-only tools, never with itself.
      this.reasoning = new Reasoner({
        log: this.log,
        runTool: async (name, args) => {
          if (String(name).startsWith('reason.')) throw Object.assign(new Error('the reasoner cannot test a hypothesis with itself'), { code: 'RECURSIVE_REASONING' });
          return this.tools.execute(name, args, { source: 'reasoning' });
        },
      });
      this.services.reasoning = this.reasoning;
      this.skills = new SkillLibrary({ store: this.store, log: this.log });
      this.services.skills = this.skills;
      this.repoMap = new RepoMap({ root: pathsModule.workspaceDir(), log: this.log });
      this.services.repoMap = this.repoMap;
      this.lab = new LearningLab({ paths: pathsModule, store: this.store, log: this.log });
      this.services.lab = this.lab;
      this.trainingLab = new TrainingLab({ dataDir: path.join(pathsModule.dataDir(), 'training'), sourceRoot: path.resolve(__dirname, '..'), log: this.log });
      this.services.trainingLab = this.trainingLab;
      this.research = new ResearchService({ store: this.store, log: this.log, workspaceDir: pathsModule.workspaceDir() });
      this.services.research = this.research;
      this.reranker = new RerankerLab({ paths: pathsModule, store: this.store, log: this.log });
      this.services.reranker = this.reranker;
      this.hypercore = new HyperCore({ store: this.store, log: this.log });
      this.services.hypercore = this.hypercore;
      this.communication = new CommunicationManager({ config: this.config, store: this.store, log: this.log });
      this.services.communication = this.communication;
      this.briefing = new DailyBriefing({ memory: this.memory, tasks: this.tasks, hypercore: this.hypercore, approvals: this.approvals, calendar: this.calendar });
      this.services.briefing = this.briefing;
      this.proactive = new ProactiveEngine({ store: this.store, log: this.log });
      this.services.proactive = this.proactive;
      this.specialists = new SpecialistZoo({ paths: pathsModule, store: this.store, log: this.log });
      this.services.specialists = this.specialists;
      this.agents = new AgentRegistry();
      this.org = new Organisation({ agents: this.agents, log: this.log });
      this.services.org = this.org;
      this.dispatcher = new Dispatcher({
        agents: this.agents,
        tools: this.tools,
        llm: this.llm,
        config: this.config,
        log: this.log,
        memory: this.memory,
        knowledge: this.knowledge,
        tasks: this.tasks,
        calendar: this.calendar,
        approvals: this.approvals,
        services: this.services,
      });
      this.executor = null;
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
        cognitive: this.cognitive,
        context: this.context,
        semantics: this.semantics,
        patches: this.patches,
        executor: null,
        graph: this.graph,
        retrievalGraph: this.graphRag || null,
        reranker: this.reranker || null,
        mcp: this.mcp,
        runtime: this.runtime,
        experience: this.experience,
        events: this.events,
        metrics: this.metrics,
      });
      this.executor = new Executor({
        tasks: this.tasks,
        dispatcher: this.dispatcher,
        tools: this.tools,
        approvals: this.approvals,
        agents: this.agents,
        events: this.events,
        metrics: this.metrics,
        experience: this.experience,
        log: this.log,
        config: this.config,
        replanner: async (context) => (this.brain && this.brain.proposeReplan ? this.brain.proposeReplan(context) : { steps: [] }),
      });
      this.brain.executor = this.executor;
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
        events: this.events,
        metrics: this.metrics,
        experience: this.experience,
      });
      this.commander.brain = this.brain;
      // Reliability: a watchdog for the store and one for provider health.
      this.watchdogs = [
        new Watchdog({
          name: 'store',
          intervalMs: 120000,
          probe: () => {
            const stats = this.store.stats();
            return { ok: true, detail: `${stats.driver}, ${stats.bytes || 0} B` };
          },
          onTransition: ({ to, detail }) => {
            this.incidents.report({ subsystem: 'store', code: to ? 'RECOVERED' : 'UNHEALTHY', message: String(detail && detail.message || 'store probe failed'), severity: to ? 'info' : 'error' });
          },
        }),
        new Watchdog({
          name: 'providers',
          intervalMs: 90000,
          probe: async () => {
            const health = await this.llm.health();
            const up = Object.values(health).filter((entry) => entry.ok).length;
            return { ok: up > 0, detail: `${up} provider(s) up`, health };
          },
          onTransition: ({ to }) => {
            if (!to) this.incidents.report({ subsystem: 'llm', code: 'NO_PROVIDER', message: 'no model provider is reachable', severity: 'warn' });
            else {
              this.incidents.recover('llm', 'NO_PROVIDER');
              this.events && this.events.publish('model', { action: 'provider-recovered' }, { severity: 'info' });
            }
          },
        }),
      ];
      this.aiReady = true;
      const bootMs = Date.now() - bootStarted;
      this.metrics.recordBaseline('agent-boot', { bootMs, idleMemoryMb: Math.round(process.memoryUsage().rss / 1048576) });
      this.metrics.observe('agent.boot', bootMs);
      this.log.info('ai', `cognitive core ready: ${this.agents.agents.size} agents, ${this.tools.tools.size} tools, store ${this.store.stats().driver}, boot ${bootMs} ms`);
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
            events: this.events || null,
            metrics: this.metrics || null,
            experience: this.experience || null,
            cognitive: this.cognitive || null,
            semantics: this.semantics || null,
            context: this.context || null,
            patches: this.patches || null,
            executor: this.executor || null,
            graph: this.graph || null,
            mcp: this.mcp || null,
            runtime: this.runtime || null,
            org: this.org || null,
            lab: this.lab || null,
            neural: this.neural || null,
            research: this.research || null,
            reranker: this.reranker || null,
            hypercore: this.hypercore || null,
            communication: this.communication || null,
            briefing: this.briefing || null,
            calendar: this.calendar || null,
            proactive: this.proactive || null,
            specialists: this.specialists || null,
            incidents: this.incidents || null,
            tasks: this.tasks || null,
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
    if (this.aiReady) {
      this.automation.start();
      // Watchdogs only start with the listening agent, not for one-shot CLI calls.
      for (const watchdog of this.watchdogs || []) watchdog.start();
      // Any task that was running when the process died is already marked
      // interrupted by the TaskManager; report it where the user can see it.
      const interrupted = [...this.tasks.tasks.values()].filter((task) => task.status === 'interrupted').length;
      if (interrupted) {
        this.incidents.report({ subsystem: 'tasks', code: 'INTERRUPTED', message: `${interrupted} task(s) were interrupted by a restart`, severity: 'warn' });
        this.events.publish('task', { action: 'reconciled', interrupted }, { severity: 'warn' });
      }
      // MCP is opt-in: start() connects nothing unless ai.mcp.enabled is true.
      if (this.mcp) {
        this.mcp.start()
          .then((result) => {
            if (result && result.enabled) this.events.publish('mcp', { action: 'started', connected: result.connected, servers: result.servers ? result.servers.length : 0 });
          })
          .catch((err) => this.log.warn('mcp', `startup failed: ${err.message}`));
      }
      this.events.publish('system', { action: 'started', version: require('../package.json').version });
    }
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
      cognitive: this.cognitive ? this.cognitive.stats() : null,
      semantics: this.semantics ? this.semantics.stats() : null,
      context: this.context ? this.context.stats() : null,
      experience: this.experience ? this.experience.stats() : null,
      events: this.events ? this.events.stats() : null,
      metrics: this.metrics ? this.metrics.snapshot() : null,
      incidents: this.incidents ? this.incidents.stats() : null,
      executor: this.executor ? { ...this.executor.counters } : null,
      graph: this.graph ? this.graph.stats() : null,
      mcp: this.mcp ? this.mcp.status() : null,
      runtime: this.runtime ? { profile: this.runtime.profile, hardware: this.runtime.hardware } : null,
      org: this.org ? this.org.chart().counts : null,
      watchdogs: (this.watchdogs || []).map((watchdog) => watchdog.status()),
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
    try { if (this.trainingLab) this.trainingLab.queue.stop({ cancelRunning: true }); } catch { /* queue is optional */ }
    clearInterval(this.brainTimer);
    if (this.automation) this.automation.stop();
    for (const watchdog of this.watchdogs || []) watchdog.stop();
    if (this.tasks) this.tasks.cancelAll('agent stopping');
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
