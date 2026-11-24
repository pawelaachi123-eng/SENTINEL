'use strict';

/**
 * Desktop control and device tools.
 *
 * Media/volume/input/apps all go through the same command catalogue the phone
 * uses, so permissions, rate limits and audit stay in one place — the assistant
 * gets no private back door into the machine.
 *
 * ESP32 and phone tools are read-mostly by design: relays, resets and
 * notifications are the only things that change state, and each is marked so
 * the approval gate applies.
 */

const { truncate } = require('./helpers');

module.exports = [
  {
    name: 'media.control',
    title: 'Media keys',
    description: 'Play/pause, next, previous or stop the current media session.',
    category: 'desktop',
    permission: 'system',
    tags: ['media', 'music', 'playback'],
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop'], default: 'play_pause' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute(`media.${args.action}`, { confirm: true }, { source: 'ai' });
      return { action: args.action, ...result.data };
    },
  },
  {
    name: 'volume.set',
    title: 'Change the volume',
    description: 'Turn the volume up or down by a number of steps, or mute it.',
    category: 'desktop',
    permission: 'system',
    tags: ['volume', 'audio', 'mute'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'mute'], default: 'up' },
        step: { type: 'integer', default: 6, minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const command = args.action === 'mute' ? 'volume.mute' : `volume.${args.action}`;
      const result = await ctx.commander.execute(command, { step: args.step, confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'input.type',
    title: 'Type text',
    description: 'Type text into the focused window. Needs approval.',
    category: 'desktop',
    permission: 'system',
    tags: ['keyboard', 'type'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('input.type', { text: args.text, confirm: true }, { source: 'ai' });
      return { typed: args.text.length, ...result.data };
    },
  },
  {
    name: 'input.key',
    title: 'Press keys',
    description: 'Press a key combination such as "ctrl+s" or "win+d". Needs approval.',
    category: 'desktop',
    permission: 'system',
    tags: ['keyboard', 'shortcut'],
    parameters: {
      type: 'object',
      properties: { combo: { type: 'string', minLength: 1, maxLength: 40 } },
      required: ['combo'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!/^[a-z0-9+\-\s]{1,40}$/i.test(args.combo)) throw Object.assign(new Error('unsupported key combination'), { code: 'BAD_ARGS' });
      const result = await ctx.commander.execute('input.key', { combo: args.combo, confirm: true }, { source: 'ai' });
      return { combo: args.combo, ...result.data };
    },
  },
  {
    name: 'app.launch',
    title: 'Launch an app',
    description: 'Start an application from the allow-list configured on the PC.',
    category: 'desktop',
    permission: 'system',
    tags: ['app', 'launch'],
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('app.launch', { name: args.name, confirm: true }, { source: 'ai' });
      return { name: args.name, ...result.data };
    },
  },
  {
    name: 'app.kill',
    title: 'Close an app',
    description: 'Close an allow-listed application.',
    category: 'desktop',
    permission: 'system',
    tags: ['app', 'close'],
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('app.kill', { name: args.name, confirm: true }, { source: 'ai' });
      return { name: args.name, ...result.data };
    },
  },
  {
    name: 'app.list',
    title: 'Allow-listed apps',
    description: 'Applications the assistant is permitted to launch.',
    category: 'desktop',
    permission: 'read',
    tags: ['app', 'list'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const apps = ctx.commander.handlers['app.list']();
      return { count: apps.length, apps };
    },
  },
  {
    name: 'macro.run',
    title: 'Run a macro',
    description: 'Execute a saved macro (a short sequence of commands). Needs approval.',
    category: 'desktop',
    permission: 'system',
    tags: ['macro', 'automation'],
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('macro.run', { name: args.name, confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'macro.list',
    title: 'List macros',
    description: 'Saved macros with their step counts.',
    category: 'desktop',
    permission: 'read',
    tags: ['macro'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return { macros: ctx.commander.handlers['macro.list']() };
    },
  },
  {
    name: 'screen.wake',
    title: 'Wake the display',
    description: 'Wake the monitor without unlocking the session.',
    category: 'desktop',
    permission: 'system',
    tags: ['screen', 'wake'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const result = await ctx.commander.execute('screen.wake', { confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'esp.status',
    title: 'ESP32 status',
    description: 'Link state, PC power reading, temperature and firmware version reported by the ESP32.',
    category: 'esp32',
    permission: 'read',
    tags: ['esp32', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const status = await ctx.commander.handlers['esp.status']();
      return {
        connected: status.connected,
        pc: status.pc,
        tempC: status.tempC,
        fw: status.fw,
        ip: status.ip || ctx.config.get('esp.host'),
        lastSeen: status.lastSeen || null,
        rssi: status.rssi ?? null,
        uptimeSec: status.uptime ?? null,
      };
    },
  },
  {
    name: 'esp.power',
    title: 'ESP32 relay',
    description: 'Switch or pulse the power relay. Needs approval — this presses the physical power button.',
    category: 'esp32',
    permission: 'system',
    tags: ['esp32', 'relay', 'power button'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'cycle'], default: 'cycle' },
        holdMs: { type: 'integer', default: 600, minimum: 100, maximum: 5000 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('esp.power', { action: args.action, holdMs: args.holdMs, confirm: true }, { source: 'ai' });
      return { action: args.action, ...result.data };
    },
  },
  {
    name: 'esp.reset',
    title: 'ESP32 reset button',
    description: 'Press the reset relay. Needs approval.',
    category: 'esp32',
    permission: 'system',
    tags: ['esp32', 'reset'],
    parameters: {
      type: 'object',
      properties: { holdMs: { type: 'integer', default: 600, minimum: 100, maximum: 5000 } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('esp.reset', { holdMs: args.holdMs, confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'esp.diagnostics',
    title: 'ESP32 diagnostics',
    description: 'Everything the link knows: session, latency, dropped frames, sensor history and last error.',
    category: 'esp32',
    permission: 'read',
    tags: ['esp32', 'diagnostics', 'link'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const link = ctx.link;
      const status = link ? link.status() : { connected: false };
      const linkStats = link && link.stats ? link.stats() : null;
      return {
        status,
        linkStats,
        encryption: link && link.cryptoInfo ? link.cryptoInfo() : null,
        host: ctx.config.get('esp.host'),
        port: ctx.config.get('esp.port'),
        note: status.connected ? null : 'ESP32 is not connected right now — check that the PC and the board are on the same network',
      };
    },
  },
  {
    name: 'mobile.sessions',
    title: 'Connected phones',
    description: 'Paired phone sessions on the encrypted tunnel, with the last time each was seen.',
    category: 'mobile',
    permission: 'read',
    tags: ['phone', 'tunnel', 'sessions'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const sessions = ctx.tunnel ? ctx.tunnel.liveSessions() : [];
      return { count: sessions.length, sessions };
    },
  },
  {
    name: 'mobile.notify',
    title: 'Notify the phone',
    description: 'Push a notification to connected phones through the tunnel (no external push service).',
    category: 'mobile',
    permission: 'system',
    tags: ['phone', 'notification'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', maxLength: 500 },
        level: { type: 'string', enum: ['info', 'warning', 'error'], default: 'info' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.tunnel) throw Object.assign(new Error('tunnel is not running'), { code: 'LINK_OFFLINE' });
      const sessions = ctx.tunnel.liveSessions();
      if (!sessions.length) throw Object.assign(new Error('no phone is connected right now'), { code: 'NO_CLIENTS' });
      ctx.tunnel.pushEvent({ event: 'notification', data: { title: args.title, body: args.body || '', level: args.level, at: new Date().toISOString() } });
      return { delivered: sessions.length, title: args.title, level: args.level };
    },
  },
  {
    name: 'mobile.pairing',
    title: 'Pairing information',
    description: 'Host, port and token the phone needs to connect, plus tunnel counters. The key itself is never printed.',
    category: 'mobile',
    permission: 'read',
    tags: ['pairing', 'qr', 'phone'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const interfaces = Object.values(require('node:os').networkInterfaces())
        .flat()
        .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address);
      return {
        port: ctx.config.get('ports.ui'),
        addresses: interfaces,
        pairedDevices: (ctx.config.get('pairedDevices') || []).map((device) => ({ name: device.name, addedAt: device.addedAt, lastSeen: device.lastSeen })),
        note: 'the pairing token is printed in the SENTINEL console and is shown once in Settings — it is deliberately not readable by tools',
        sessions: ctx.tunnel ? ctx.tunnel.liveSessions().length : 0,
      };
    },
  },
  {
    name: 'tunnel.status',
    title: 'Tunnel status',
    description: 'Encrypted tunnel counters, live sessions and recent handshake failures.',
    category: 'network',
    permission: 'read',
    tags: ['tunnel', 'security', 'sessions'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.tunnel) return { running: false };
      return {
        running: true,
        sessions: ctx.tunnel.liveSessions(),
        counters: typeof ctx.tunnel.stats === 'function' ? ctx.tunnel.stats() : null,
        note: truncate('all traffic is end-to-end encrypted with the pairing key; nothing leaves your devices', 200),
      };
    },
  },
];
