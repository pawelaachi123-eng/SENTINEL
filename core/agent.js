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
const { uiDir } = require('./paths');

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
    });
    // Our own encrypted channel: the phone talks to this without any VPN.
    this.tunnel = new TunnelServer({
      config: this.config,
      log: this.log,
      commander: this.commander,
      pskBytes: Buffer.from(this.config.get('psk'), 'hex'),
    });
    this.http = new HttpApi({
      config: this.config,
      log: this.log,
      commander: this.commander,
      link: this.link,
      stats: this.stats,
      state: this.state,
      tunnel: this.tunnel,
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

  stop() {
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
      loginUrl: this.loginUrl,
      lanUrl: this.lanUrl,
    };
  }
}

function createAgent(opts) {
  return new Agent(opts);
}

module.exports = { Agent, createAgent };
