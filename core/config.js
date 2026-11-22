'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configFile, ensureDir } = require('./paths');
const { randomHex } = require('./util');

const CONFIG_VERSION = 1;

/**
 * Defaults are intentionally conservative: the PC is only reachable with the
 * pairing key, and the risky capabilities (typing into the machine, killing
 * processes, running scripts) are OFF until the owner switches them on.
 */
function defaults() {
  return {
    version: CONFIG_VERSION,
    name: os.hostname(),
    ports: { ui: 7878, link: 7879 },
    bind: '0.0.0.0',
    psk: null,
    uiToken: null,
    policy: {
      allowShutdown: true,
      allowReboot: true,
      allowSleep: true,
      allowLock: true,
      allowLogout: true,
      allowMedia: true,
      allowVolume: true,
      allowScreenshot: true,
      allowWake: true,
      allowAppLaunch: true,
      allowAppKill: false,
      allowInput: false,
      allowScripts: false,
      allowFileList: false,
      allowEspPower: true,
      requireConfirm: true,
      rateLimitPerMinute: 40,
      quietHours: { enabled: false, from: '23:00', to: '07:00' },
    },
    // Everything the agent may launch/kill/run is named here first.
    apps: {},
    scripts: {},
    macros: {},
    esp: {
      enabled: true,
      deviceId: null,
      powerPin: 25,
      resetPin: 26,
      autoOffAfterShutdown: true,
      shutdownGraceMs: 45000,
    },
    serial: { enabled: false, port: null, baud: 115200 },
    ui: { theme: 'sentinel', reducedMotion: false },
    createdAt: new Date().toISOString(),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

class Config {
  constructor(file = configFile()) {
    this.file = file;
    this.data = defaults();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(defaults(), parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the broken file for forensics instead of silently nuking it.
        try {
          fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      this.data = defaults();
    }
    let changed = false;
    if (!this.data.psk) {
      this.data.psk = randomHex(32);
      changed = true;
    }
    if (!this.data.uiToken) {
      this.data.uiToken = randomHex(24);
      changed = true;
    }
    if (changed) this.save();
    return this.data;
  }

  save() {
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.data;
  }

  get(key, fallback) {
    const parts = String(key).split('.');
    let node = this.data;
    for (const part of parts) {
      if (!isPlainObject(node) || !(part in node)) return fallback;
      node = node[part];
    }
    return node === undefined ? fallback : node;
  }

  merge(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }

  setPolicy(patch) {
    this.data.policy = deepMerge(this.data.policy, patch || {});
    this.save();
    return this.data.policy;
  }

  rotateKeys() {
    this.data.psk = randomHex(32);
    this.data.uiToken = randomHex(24);
    this.save();
    return { psk: this.data.psk, uiToken: this.data.uiToken };
  }

  /**
   * The token the ESP32 derives for its standalone power endpoint:
   * first 16 hex chars of HMAC-SHA256(pskBytes, "sentinel-power").
   * Identical to powerToken() in firmware/src/main.cpp.
   */
  espPowerToken() {
    return crypto
      .createHmac('sha256', Buffer.from(this.data.psk, 'hex'))
      .update('sentinel-power')
      .digest('hex')
      .slice(0, 16);
  }

  /** The snippet a user pastes into the ESP32 provisioning page. */
  pairingSnippet(host) {
    const esp = this.data.esp;
    return {
      agent_host: host || `<${this.data.name}-ip>`,
      agent_port: this.data.ports.link,
      psk: this.data.psk,
      power_pin: esp.powerPin,
      reset_pin: esp.resetPin,
      device_id: esp.deviceId || 'esp32-sentinel',
      esp_power_token: this.espPowerToken(),
    };
  }

  toJSON() {
    return this.data;
  }
}

module.exports = { Config, defaults, deepMerge };
