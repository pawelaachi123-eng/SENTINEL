'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { handshakeProof } = require('./protocol');
const { safeJson, timingSafeEqualHex, oneLine } = require('./util');

const HEARTBEAT_MS = 15000;
const AUTH_TIMEOUT_MS = 8000;
const MAX_BUFFER = 64 * 1024;

/**
 * Link to the ESP32.
 *
 * The ESP32 is the device that physically sits next to the PC, so the agent
 * *accepts* the connection: the ESP32 dials in over your VPN/LAN (TCP) or over
 * USB serial. Both sides prove knowledge of the pairing key with a
 * challenge/response before any command is accepted.
 */
class EspLink extends EventEmitter {
  constructor({ config, log }) {
    super();
    this.config = config;
    this.log = log;
    this.server = null;
    this.sockets = new Map();
    this.serial = null;
    this.info = {
      connected: false,
      deviceId: null,
      transport: null,
      ip: null,
      rssi: null,
      tempC: null,
      fw: null,
      pcState: 'unknown',
      lastSeen: null,
      connectedAt: null,
      gpio: {},
    };
    this.pending = new Map();
    this.heartbeat = null;
  }

  get psk() {
    return this.config.get('psk');
  }

  start() {
    if (this.config.get('esp.enabled') === false) {
      this.log.info('link', 'ESP32 link disabled in config');
      return this;
    }
    const port = this.config.get('ports.link');
    const bind = this.config.get('bind') || '0.0.0.0';
    this.server = net.createServer((socket) => this.onSocket(socket));
    this.server.on('error', (err) => {
      this.log.error('link', `Link server error: ${err.message}`);
    });
    this.server.listen(port, bind, () => {
      this.log.info('link', `ESP32 link listening on ${bind}:${port}`);
    });

    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();

    this.openSerial().catch((err) => this.log.debug('link', `Serial bridge not started: ${err.message}`));
    return this;
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    if (this.server) this.server.close();
    if (this.serial) {
      try {
        this.serial.close();
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------------ TCP */

  onSocket(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 20000);
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const session = {
      id: crypto.randomBytes(8).toString('hex'),
      socket,
      buffer: '',
      authed: false,
      challenge: crypto.randomBytes(16).toString('hex'),
      peer,
      timer: setTimeout(() => {
        if (!session.authed) {
          this.log.warn('link', `Authentication timeout from ${peer}`);
          socket.destroy();
        }
      }, AUTH_TIMEOUT_MS),
    };
    this.sockets.set(session.id, session);
    this.log.debug('link', `Connection from ${peer}`);

    socket.on('data', (chunk) => this.onData(session, chunk));
    socket.on('error', (err) => this.log.debug('link', `Socket error from ${peer}: ${err.message}`));
    socket.on('close', () => {
      clearTimeout(session.timer);
      this.sockets.delete(session.id);
      if (session.authed) {
        this.log.warn('link', `ESP32 ${this.info.deviceId || peer} disconnected`);
        this.setDisconnected();
      }
    });

    this.sendRaw(session, { t: 'hello', v: 1, agent: this.config.get('name'), nonce: session.challenge });
  }

  onData(session, chunk) {
    session.buffer += chunk.toString('utf8');
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = '';
      session.socket.destroy();
      return;
    }
    let index;
    while ((index = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, index).trim();
      session.buffer = session.buffer.slice(index + 1);
      if (!line) continue;
      const message = safeJson(line);
      if (!message) {
        this.log.debug('link', 'Dropped non-JSON frame from device');
        continue;
      }
      this.handleMessage(session, message);
    }
  }

  sendRaw(session, obj) {
    try {
      session.socket.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.log.debug('link', `Write failed: ${err.message}`);
    }
  }

  /* --------------------------------------------------------------- Serial */

  async openSerial() {
    const cfg = this.config.get('serial');
    if (!cfg || !cfg.enabled) return;
    let SerialPort;
    try {
      // Optional: only present when the user installed the native module.
      SerialPort = require('serialport').SerialPort;
    } catch {
      this.log.info('link', 'serialport module not installed — USB serial bridge unavailable (TCP still works)');
      return;
    }
    const port = cfg.port || (await SerialPort.list()).map((p) => p.path)[0];
    if (!port) throw new Error('no serial port found');

    const sp = new SerialPort({ path: port, baudRate: cfg.baud || 115200 });
    this.serial = sp;
    const session = {
      id: 'serial',
      serial: true,
      buffer: '',
      authed: false,
      challenge: crypto.randomBytes(16).toString('hex'),
      peer: port,
      timer: setTimeout(() => {}, AUTH_TIMEOUT_MS),
      write: (text) => sp.write(text),
      destroy: () => sp.close(),
    };
    sp.on('data', (chunk) => this.onData(session, chunk));
    sp.on('error', (err) => this.log.error('link', `Serial error: ${err.message}`));
    this.sendRaw(session, { t: 'hello', v: 1, agent: this.config.get('name'), nonce: session.challenge, transport: 'serial' });
    this.log.info('link', `USB serial bridge open on ${port}`);
  }

  /* -------------------------------------------------------------- Protocol */

  handleMessage(session, msg) {
    switch (msg.t) {
      case 'auth': {
        const deviceId = oneLine(msg.deviceId || 'esp32').slice(0, 48);
        const deviceNonce = String(msg.nonce || '');
        const expected = handshakeProof(this.psk, session.challenge, deviceNonce, deviceId);
        if (!timingSafeEqualHex(expected, String(msg.sig || ''))) {
          this.log.warn('link', `Rejected device ${deviceId} from ${session.peer}: bad pairing key`);
          this.sendRaw(session, { t: 'deny', reason: 'bad-key' });
          session.socket?.destroy();
          return;
        }
        session.authed = true;
        session.deviceId = deviceId;
        clearTimeout(session.timer);
        this.sendRaw(session, { t: 'welcome', sig: handshakeProof(this.psk, deviceNonce, session.challenge, deviceId), heartbeatSec: 15 });
        this.info = {
          ...this.info,
          connected: true,
          deviceId,
          transport: session.serial ? 'usb' : 'tcp',
          ip: session.serial ? null : session.peer.split(':')[0],
          connectedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };
        this.config.merge({ esp: { deviceId } });
        this.log.info('link', `ESP32 "${deviceId}" linked over ${this.info.transport} from ${session.peer}`);
        this.emit('connected', this.status());
        return;
      }

      case 'state': {
        if (!session.authed) return;
        Object.assign(this.info, {
          rssi: Number.isFinite(msg.rssi) ? msg.rssi : this.info.rssi,
          tempC: Number.isFinite(msg.temp) ? msg.temp : this.info.tempC,
          fw: msg.fw || this.info.fw,
          pcState: msg.pc === 'on' || msg.pc === 'off' ? msg.pc : this.info.pcState,
          gpio: msg.gpio && typeof msg.gpio === 'object' ? msg.gpio : this.info.gpio,
          deviceUptime: Number.isFinite(msg.up) ? msg.up : this.info.deviceUptime,
          wg: typeof msg.wg === 'boolean' ? msg.wg : this.info.wg,
          lastSeen: new Date().toISOString(),
        });
        this.emit('state', this.status());
        return;
      }

      case 'res': {
        const pending = this.pending.get(String(msg.id));
        if (!pending) return;
        this.pending.delete(String(msg.id));
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.data || {});
        else pending.reject(Object.assign(new Error(msg.error || 'Device rejected the command'), { code: msg.code || 'DEVICE_ERROR' }));
        return;
      }

      case 'pong': {
        if (session.authed) this.info.lastSeen = new Date().toISOString();
        return;
      }

      case 'log': {
        this.log.write(msg.level === 'warn' ? 'warn' : 'info', 'esp32', oneLine(msg.msg).slice(0, 300));
        return;
      }

      case 'bye': {
        session.socket?.destroy();
        return;
      }

      default:
        this.log.debug('link', `Unknown frame type ${msg.t}`);
    }
  }

  /* ------------------------------------------------------------- Outbound */

  activeSession() {
    for (const session of this.sockets.values()) if (session.authed) return session;
    return null;
  }

  send(cmd, args = {}, { timeoutMs = 8000 } = {}) {
    const session = this.activeSession();
    if (!session) {
      return Promise.reject(Object.assign(new Error('ESP32 is not connected'), { code: 'LINK_OFFLINE' }));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`ESP32 did not answer ${cmd} within ${timeoutMs}ms`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw(session, { t: 'cmd', id, cmd, args });
    });
  }

  tick() {
    const session = this.activeSession();
    if (!session) return;
    this.sendRaw(session, { t: 'ping' });
    const last = this.info.lastSeen ? new Date(this.info.lastSeen).getTime() : 0;
    if (last && Date.now() - last > HEARTBEAT_MS * 4) {
      this.log.warn('link', 'ESP32 stopped answering heartbeats — dropping link');
      session.socket?.destroy();
      this.setDisconnected();
    }
  }

  setDisconnected() {
    this.info = { ...this.info, connected: false, transport: null, ip: null, lastSeen: this.info.lastSeen };
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('ESP32 link dropped'), { code: 'LINK_OFFLINE' }));
      this.pending.delete(id);
    }
    this.emit('disconnected');
  }

  status() {
    return {
      connected: Boolean(this.info.connected),
      deviceId: this.info.deviceId,
      transport: this.info.transport,
      ip: this.info.ip,
      rssi: this.info.rssi,
      tempC: this.info.tempC,
      fw: this.info.fw,
      pcState: this.info.pcState,
      deviceUptime: this.info.deviceUptime,
      wg: this.info.wg,
      gpio: this.info.gpio,
      connectedAt: this.info.connectedAt,
      lastSeen: this.info.lastSeen,
      authTimeoutMs: AUTH_TIMEOUT_MS,
    };
  }
}

module.exports = { EspLink };
