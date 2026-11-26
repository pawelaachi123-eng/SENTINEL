'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { platform, capabilities, PlatformError } = require('./platform');
const { run } = require('./runner');
const policy = require('./policy');
const { clamp, humanUptime } = require('./util');

const AGENT_VERSION = require('../package.json').version;

class CmdError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, clamp(ms, 0, 2500)));

class Commander {
  constructor({ config, log, limiter, link, state, stats, brain }) {
    this.config = config;
    this.log = log;
    this.limiter = limiter;
    this.link = link;
    this.state = state;
    this.stats = stats || null;
    this.brain = brain || null;
    this.capsCache = null;
    this.capsAt = 0;
    this.handlers = this.buildHandlers();
  }

  async caps() {
    if (!this.capsCache || Date.now() - this.capsAt > 60000) {
      this.capsCache = await capabilities();
      this.capsAt = Date.now();
    }
    return this.capsCache;
  }

  /** The catalogue the UI renders. Keeps names/arguments in one place. */
  catalogue() {
    return [
      { group: 'Power', cmd: 'system.shutdown', label: 'Shut down', args: { delay: { type: 'number', default: 30, min: 0, max: 3600, unit: 's' } } },
      { group: 'Power', cmd: 'system.reboot', label: 'Restart', args: { delay: { type: 'number', default: 10, min: 0, max: 3600, unit: 's' } } },
      { group: 'Power', cmd: 'system.cancel_shutdown', label: 'Cancel shutdown' },
      { group: 'Power', cmd: 'system.sleep', label: 'Sleep' },
      { group: 'Power', cmd: 'esp.power', label: 'Hard power (relay)', args: { action: { type: 'enum', values: ['on', 'off', 'cycle'], default: 'cycle' }, holdMs: { type: 'number', default: 600, min: 100, max: 5000 } } },
      { group: 'Power', cmd: 'esp.reset', label: 'Hard reset (relay)', args: { holdMs: { type: 'number', default: 600, min: 100, max: 5000 } } },
      { group: 'Session', cmd: 'system.lock', label: 'Lock screen' },
      { group: 'Session', cmd: 'system.logout', label: 'Log out' },
      { group: 'Session', cmd: 'screen.wake', label: 'Wake display' },
      { group: 'Session', cmd: 'screen.screenshot', label: 'Screenshot' },
      { group: 'Media', cmd: 'media.play_pause', label: 'Play / pause' },
      { group: 'Media', cmd: 'media.next', label: 'Next track' },
      { group: 'Media', cmd: 'media.previous', label: 'Previous track' },
      { group: 'Media', cmd: 'media.stop', label: 'Stop' },
      { group: 'Media', cmd: 'volume.up', label: 'Volume up', args: { step: { type: 'number', default: 6, min: 1, max: 30 } } },
      { group: 'Media', cmd: 'volume.down', label: 'Volume down', args: { step: { type: 'number', default: 6, min: 1, max: 30 } } },
      { group: 'Media', cmd: 'volume.mute', label: 'Mute' },
      { group: 'Input', cmd: 'input.type', label: 'Type text', args: { text: { type: 'string', maxLength: 4000 } } },
      { group: 'Input', cmd: 'input.key', label: 'Press keys', args: { combo: { type: 'string', example: 'ctrl+shift+esc' } } },
      { group: 'Apps', cmd: 'app.launch', label: 'Launch app', args: { name: { type: 'string' } } },
      { group: 'Apps', cmd: 'app.kill', label: 'Kill app', args: { name: { type: 'string' } } },
      { group: 'Apps', cmd: 'app.list', label: 'List allowed apps' },
      { group: 'Automation', cmd: 'script.run', label: 'Run script', args: { name: { type: 'string' } } },
      { group: 'Automation', cmd: 'macro.run', label: 'Run macro', args: { name: { type: 'string' } } },
      { group: 'Automation', cmd: 'files.list', label: 'List files', args: { path: { type: 'string', default: '~' } } },
      { group: 'System', cmd: 'system.snapshot', label: 'Everything at once' },
      { group: 'System', cmd: 'brain.insights', label: 'What the brain noticed' },
      { group: 'System', cmd: 'system.info', label: 'System info' },
      { group: 'System', cmd: 'agent.status', label: 'Agent status' },
      { group: 'System', cmd: 'esp.status', label: 'ESP32 status' },
    ];
  }

  buildHandlers() {
    const S = (fn) => () => fn();
    return {
      'system.ping': S(() => ({ pong: true, at: new Date().toISOString() })),

      'system.info': async () => {
        const cpus = os.cpus();
        return {
          name: this.config.get('name'),
          hostname: os.hostname(),
          platform: process.platform,
          platformLabel: { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform] || process.platform,
          release: os.release(),
          arch: process.arch,
          cpuModel: (cpus[0] && cpus[0].model) || 'unknown',
          cpuCount: cpus.length,
          memory: os.totalmem(),
          uptime: Math.round(os.uptime()),
          uptimeLabel: humanUptime(os.uptime()),
          user: safeUser(),
          agentVersion: AGENT_VERSION,
          node: process.version,
          capabilities: await this.caps(),
          policy: this.config.get('policy'),
        };
      },

      'agent.status': () => ({
        name: this.config.get('name'),
        version: AGENT_VERSION,
        startedAt: this.state.startedAt,
        uptimeSec: Math.round((Date.now() - this.state.startedAt.getTime()) / 1000),
        linkPort: this.config.get('ports.link'),
        uiPort: this.config.get('ports.ui'),
        esp: this.link ? this.link.status() : { connected: false },
        policy: this.config.get('policy'),
        lastCommand: this.state.lastCommand || null,
        counters: this.state.counters,
      }),

      /**
       * One call that returns everything the phone renders. Without it the app
       * would need three round trips (and tunnel clients cannot use /api/status).
       */
      'system.snapshot': async () => {
        const info = await this.handlers['system.info']();
        return {
          ...info,
          cpuPercent: this.stats ? this.stats.read() : 0,
          memoryDetail: this.stats ? this.stats.memory() : null,
          esp: this.link ? this.link.status() : { connected: false },
          agent: {
            version: AGENT_VERSION,
            startedAt: this.state.startedAt,
            uptimeSec: Math.round((Date.now() - this.state.startedAt.getTime()) / 1000),
            counters: this.state.counters,
            lastCommand: this.state.lastCommand,
            ports: { ui: this.config.get('ports.ui'), link: this.config.get('ports.link') },
          },
          apps: Object.keys(this.config.get('apps', {})),
          macros: Object.keys(this.config.get('macros', {})),
          catalogue: this.catalogue(),
          insights: this.brain ? this.brain.list() : [],
          serverTime: new Date().toISOString(),
        };
      },

      'brain.insights': () => (this.brain ? this.brain.list() : []),

      'brain.dismiss': (args) => {
        const id = String((args && args.id) || '');
        if (!id) throw new CmdError('BAD_ARGS', 'id is required');
        return { dismissed: this.brain ? this.brain.dismiss(id) : false, insights: this.brain ? this.brain.list() : [] };
      },

      'agent.policy.get': () => this.config.get('policy'),

      'agent.policy.set': (args, ctx) => {
        if (ctx.source !== 'ui') throw new CmdError('FORBIDDEN', 'Policy can only be changed from the local console');
        const patch = args && typeof args.patch === 'object' ? args.patch : null;
        if (!patch) throw new CmdError('BAD_ARGS', 'patch object required');
        const next = this.config.setPolicy(patch);
        this.limiter.setLimit(next.rateLimitPerMinute);
        this.log.warn('policy', `Policy updated: ${Object.keys(patch).join(', ')}`);
        return next;
      },

      'system.shutdown': async (args) => {
        const delay = clamp(args.delay ?? 30, 0, 3600);
        const res = await platform.shutdown(delay);
        this.state.counters.shutdowns++;
        this.log.warn('power', `Shutdown scheduled in ${delay}s`);
        return { scheduledInSec: delay, ...res };
      },

      'system.reboot': async (args) => {
        const delay = clamp(args.delay ?? 10, 0, 3600);
        const res = await platform.reboot(delay);
        this.state.counters.reboots++;
        this.log.warn('power', `Restart scheduled in ${delay}s`);
        return { scheduledInSec: delay, ...res };
      },

      'system.cancel_shutdown': async () => {
        const res = await platform.cancelShutdown();
        this.log.info('power', 'Pending shutdown cancelled');
        return res;
      },

      'system.sleep': async () => {
        const res = await platform.sleep();
        this.log.info('power', 'Sleep requested');
        return res;
      },

      'system.lock': async () => {
        const res = await platform.lock();
        this.log.info('session', 'Screen locked');
        return res;
      },

      'system.logout': async () => {
        const res = await platform.logout();
        this.log.warn('session', 'Log out requested');
        return res;
      },

      'screen.screenshot': async () => {
        const shot = await platform.screenshot();
        this.log.info('screen', 'Screenshot captured', { bytes: Math.round((shot.data.length * 3) / 4) });
        return shot;
      },

      'screen.wake': async () => {
        const res = await platform.wake();
        this.log.info('screen', 'Display woken');
        return res;
      },

      'media.play_pause': async () => ({ ...(await platform.media('play_pause')) }),
      'media.next': async () => ({ ...(await platform.media('next')) }),
      'media.previous': async () => ({ ...(await platform.media('previous')) }),
      'media.stop': async () => ({ ...(await platform.media('stop')) }),

      'volume.up': async (args) => ({ ...(await platform.volume('up', clamp(args.step ?? 6, 1, 30))) }),
      'volume.down': async (args) => ({ ...(await platform.volume('down', clamp(args.step ?? 6, 1, 30))) }),
      'volume.mute': async () => ({ ...(await platform.volume('mute')) }),

      'input.type': async (args) => {
        const text = String(args.text ?? '');
        if (!text) throw new CmdError('BAD_ARGS', 'Nothing to type');
        if (text.length > 4000) throw new CmdError('BAD_ARGS', 'Text is longer than 4000 characters');
        const res = await platform.typeText(text);
        this.log.info('input', `Typed ${text.length} characters`);
        return res;
      },

      'input.key': async (args) => {
        const combo = String(args.combo ?? '').trim();
        if (!combo) throw new CmdError('BAD_ARGS', 'Key combo is empty');
        if (!/^[a-z0-9+\-\s]{1,40}$/i.test(combo)) throw new CmdError('BAD_ARGS', 'Unsupported key combo');
        const res = await platform.pressKey(combo);
        this.log.info('input', `Pressed ${combo}`);
        return res;
      },

      'app.list': () => Object.entries(this.config.get('apps', {})).map(([name, entry]) => ({
        name,
        path: entry.path || entry.command || null,
        label: entry.label || name,
      })),

      'app.launch': async (args) => {
        const name = String(args.name ?? '');
        const entry = this.config.get(`apps.${name}`);
        if (!entry) throw new CmdError('NOT_ALLOWED', `"${name}" is not in the allow-list (Settings → Apps)`);
        const res = await platform.launchApp(entry, name);
        this.log.info('apps', `Launched ${name}`, { pid: res.pid });
        return res;
      },

      'app.kill': async (args) => {
        const name = String(args.name ?? '');
        const entry = this.config.get(`apps.${name}`);
        if (!entry) throw new CmdError('NOT_ALLOWED', `"${name}" is not in the allow-list (Settings → Apps)`);
        const res = await platform.killApp(entry, name);
        this.log.warn('apps', `Killed ${name}`);
        return res;
      },

      'files.list': async (args) => {
        const home = os.homedir();
        const requested = String(args.path ?? '~');
        const resolved = path.resolve(requested.startsWith('~') ? path.join(home, requested.slice(1)) : requested);
        const relative = path.relative(home, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new CmdError('NOT_ALLOWED', 'Only folders inside your home directory can be listed');
        }
        const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
        const items = [];
        for (const entry of entries.slice(0, 200)) {
          const full = path.join(resolved, entry.name);
          let size = 0;
          let mtime = null;
          try {
            const st = await fs.promises.stat(full);
            size = st.size;
            mtime = st.mtime.toISOString();
          } catch {
            /* ignore */
          }
          items.push({ name: entry.name, dir: entry.isDirectory(), size, mtime });
        }
        return { path: resolved, items };
      },

      'script.run': async (args) => {
        const name = String(args.name ?? '');
        const entry = this.config.get(`scripts.${name}`);
        if (!entry) throw new CmdError('NOT_ALLOWED', `Script "${name}" is not configured`);
        const file = Array.isArray(entry) ? entry[0] : entry.command;
        const argv = Array.isArray(entry) ? entry.slice(1) : entry.args || [];
        const timeout = (entry && entry.timeoutMs) || 20000;
        const res = await run(file, argv, { timeout });
        this.log.info('script', `Ran ${name} (exit ${res.code})`);
        return { exitCode: res.code, stdout: res.stdout.slice(0, 8000), stderr: res.stderr.slice(0, 4000) };
      },

      'macro.run': async (args, ctx) => {
        const name = String(args.name ?? '');
        const macro = this.config.get(`macros.${name}`);
        if (!macro || !Array.isArray(macro.steps) || macro.steps.length === 0) {
          throw new CmdError('NOT_FOUND', `Macro "${name}" does not exist or has no steps`);
        }
        const results = [];
        for (const step of macro.steps.slice(0, 24)) {
          try {
            const out = await this.execute(step.cmd, { ...(step.args || {}), confirm: true }, { source: 'macro' });
            results.push({ step: step.cmd, ok: true, data: summarise(out) });
          } catch (err) {
            results.push({ step: step.cmd, ok: false, error: err.message });
            if (macro.stopOnError !== false) break;
          }
          await sleepMs(step.waitMs ?? 300);
        }
        this.log.info('macro', `Ran macro "${name}" (${results.filter((r) => r.ok).length}/${results.length} ok)`);
        return { macro: name, results };
      },

      'macro.list': () => Object.entries(this.config.get('macros', {})).map(([name, m]) => ({
        name,
        steps: (m.steps || []).length,
        description: m.description || '',
      })),

      'esp.status': async () => {
        if (!this.link) throw new CmdError('LINK_OFFLINE', 'ESP32 link is not running');
        return this.link.status();
      },

      'esp.power': async (args) => {
        if (!this.link) throw new CmdError('LINK_OFFLINE', 'ESP32 link is not running');
        const action = ['on', 'off', 'cycle'].includes(args.action) ? args.action : 'cycle';
        const holdMs = clamp(args.holdMs ?? 600, 100, 5000);
        const result = await this.link.send('power', { action, holdMs });
        this.log.warn('esp', `Relay ${action} (hold ${holdMs}ms)`);
        return result;
      },

      'esp.reset': async (args) => {
        if (!this.link) throw new CmdError('LINK_OFFLINE', 'ESP32 link is not running');
        const holdMs = clamp(args.holdMs ?? 600, 100, 5000);
        const result = await this.link.send('reset', { holdMs });
        this.log.warn('esp', `Reset relay pressed (hold ${holdMs}ms)`);
        return result;
      },
    };
  }

  async execute(cmd, args = {}, ctx = {}) {
    const started = Date.now();
    const handler = this.handlers[cmd];
    if (!handler) throw new CmdError('UNKNOWN_COMMAND', `Unknown command "${cmd}"`);

    const verdict = policy.check(cmd, this.config.get('policy'), args, ctx);
    if (!verdict.ok) throw new CmdError(verdict.code, verdict.message);

    const gate = this.limiter.allow(ctx.source || 'default');
    if (!gate.ok) {
      throw new CmdError('RATE_LIMITED', `Too many commands, retry in ${Math.ceil(gate.retryAfterMs / 1000)}s`);
    }

    try {
      const data = await handler(args || {}, ctx);
      const ms = Date.now() - started;
      this.state.lastCommand = { cmd, at: new Date().toISOString(), ms, source: ctx.source || 'ui' };
      this.state.counters.commands++;
      this.log.info('command', `${cmd} → ok (${ms}ms)`, { source: ctx.source || 'ui' });
      return { ok: true, cmd, data, ms };
    } catch (err) {
      const ms = Date.now() - started;
      const code = err.code || (err instanceof PlatformError ? err.code : 'FAILED');
      this.state.counters.errors++;
      this.log.error('command', `${cmd} → ${code}: ${err.message}`, err.detail ? { detail: String(err.detail).slice(0, 300) } : undefined);
      // Platform failures (missing tool, blocked policy, offline device) are
      // what the advisory layer watches for; refusals are not failures.
      if (!['POLICY_DENIED', 'CONFIRM_REQUIRED', 'QUIET_HOURS', 'RATE_LIMITED'].includes(code) && this.brain) {
        this.brain.observe(null, { commandFailed: `${cmd} → ${code}` });
      }
      const wrapped = new CmdError(code, err.message || 'Command failed', err.detail);
      wrapped.ms = ms;
      throw wrapped;
    }
  }
}

function summarise(result) {
  if (!result || !result.data) return null;
  const data = { ...result.data };
  if (typeof data.data === 'string' && data.data.length > 256) data.data = `<${data.data.length} bytes>`;
  return data;
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

module.exports = { Commander, CmdError, AGENT_VERSION };
