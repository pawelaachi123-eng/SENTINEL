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
    });
    this.http = new HttpApi({
      config: this.config,
      log: this.log,
      commander: this.commander,
      link: this.link,
      stats: this.stats,
      state: this.state,
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
    this.log.on('entry', (entry) => this.http.broadcast('log', entry));
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
    this.log.info('agent', `Open ${this.loginUrl}`);
    if (host !== '127.0.0.1') this.log.info('agent', `Phone/tablet: ${this.lanUrl}`);
    return this;
  }

  stop() {
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
      loginUrl: this.loginUrl,
      lanUrl: this.lanUrl,
    };
  }
}

function createAgent(opts) {
  return new Agent(opts);
}

module.exports = { Agent, createAgent };
