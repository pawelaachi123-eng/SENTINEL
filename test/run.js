#!/usr/bin/env node
'use strict';

/**
 * Behaviour tests for the parts that must never be wrong: signatures, replay
 * protection, the policy gate and config secret handling.
 *
 *   node test/run.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));

const protocol = require('../core/protocol');
const policy = require('../core/policy');
const { Config } = require('../core/config');
const { RateLimiter } = require('../core/policy');

const PSK = 'a'.repeat(64);

test('signature round-trips and verifies', () => {
  const envelope = protocol.createEnvelope(PSK, { cmd: 'system.lock', args: {} });
  const guard = new protocol.ReplayGuard();
  const result = protocol.verifyEnvelope(PSK, envelope, guard);
  assert.equal(result.ok, true, result.message);
});

test('tampered arguments are rejected', () => {
  const envelope = protocol.createEnvelope(PSK, { cmd: 'volume.up', args: { step: 6 } });
  envelope.args = { step: 60 };
  const guard = new protocol.ReplayGuard();
  const result = protocol.verifyEnvelope(PSK, envelope, guard);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_SIGNATURE');
});

test('a different key cannot sign for us', () => {
  const envelope = protocol.createEnvelope('b'.repeat(64), { cmd: 'system.ping' });
  const result = protocol.verifyEnvelope(PSK, envelope, new protocol.ReplayGuard());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_SIGNATURE');
});

test('replay is rejected, but a fresh envelope is not', () => {
  const guard = new protocol.ReplayGuard();
  const envelope = protocol.createEnvelope(PSK, { cmd: 'system.ping' });
  assert.equal(protocol.verifyEnvelope(PSK, envelope, guard).ok, true);
  assert.equal(protocol.verifyEnvelope(PSK, envelope, guard).code, 'REPLAY');
  const fresh = protocol.createEnvelope(PSK, { cmd: 'system.ping' });
  assert.equal(protocol.verifyEnvelope(PSK, fresh, guard).ok, true);
});

test('stale timestamps are refused', () => {
  const envelope = protocol.createEnvelope(PSK, { cmd: 'system.ping' });
  envelope.ts -= 600;
  envelope.sig = protocol.sign(PSK, envelope);
  const result = protocol.verifyEnvelope(PSK, envelope, new protocol.ReplayGuard());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
});

test('handshake proofs are direction-specific', () => {
  const forward = protocol.handshakeProof(PSK, 'agentNonce', 'deviceNonce', 'esp32-1');
  const reverse = protocol.handshakeProof(PSK, 'deviceNonce', 'agentNonce', 'esp32-1');
  assert.notEqual(forward, reverse);
  assert.equal(forward, protocol.handshakeProof(PSK, 'agentNonce', 'deviceNonce', 'esp32-1'));
});

test('policy blocks a capability that is switched off', () => {
  const verdict = policy.check('input.type', { allowInput: false }, { text: 'hi' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'POLICY_DENIED');
});

test('policy requires confirmation for destructive commands', () => {
  const blocked = policy.check('system.shutdown', { allowShutdown: true, requireConfirm: true }, {});
  assert.equal(blocked.code, 'CONFIRM_REQUIRED');
  const allowed = policy.check('system.shutdown', { allowShutdown: true, requireConfirm: true }, { confirm: true });
  assert.equal(allowed.ok, true);
});

test('read-only commands need no confirmation', () => {
  assert.equal(policy.check('system.info', {}).ok, true);
  assert.equal(policy.check('system.lock', { allowLock: true, requireConfirm: true }, {}).ok, true);
});

test('quiet hours block power actions but not cancel', () => {
  const now = new Date();
  now.setHours(23, 30, 0, 0);
  const quiet = { enabled: true, from: '23:00', to: '07:00' };
  assert.equal(policy.withinQuietHours(quiet, now), true);
  const blocked = policy.check('system.shutdown', { quietHours: quiet }, { confirm: true }, { now });
  assert.equal(blocked.code, 'QUIET_HOURS');
  const cancel = policy.check('system.cancel_shutdown', { quietHours: quiet }, { confirm: true }, { now });
  assert.equal(cancel.ok, true);
});

test('rate limiter throttles a burst', () => {
  const limiter = new RateLimiter(3);
  assert.equal(limiter.allow('ui').ok, true);
  assert.equal(limiter.allow('ui').ok, true);
  assert.equal(limiter.allow('ui').ok, true);
  const blocked = limiter.allow('ui');
  assert.equal(blocked.ok, false);
  assert.equal(limiter.allow('other-client').ok, true);
});

test('a fresh config generates distinct secrets and stays private', () => {
  const file = path.join(process.env.SENTINEL_HOME, 'config.json');
  const config = new Config(file);
  assert.equal(config.get('psk').length, 64);
  assert.equal(config.get('uiToken').length, 48);
  assert.notEqual(config.get('psk'), config.get('uiToken'));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `config file mode is ${mode.toString(8)}`);
  const second = new Config(file);
  assert.equal(second.get('psk'), config.get('psk'), 'secrets must persist across restarts');
});

test('the ESP32 power token is derived, not stored', () => {
  const config = new Config(path.join(process.env.SENTINEL_HOME, 'config-two.json'));
  const token = config.espPowerToken();
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(config.toJSON()).includes(token), 'power token must not be written to config');
});

test('policy updates are persisted and survive reload', () => {
  const file = path.join(process.env.SENTINEL_HOME, 'config-three.json');
  const config = new Config(file);
  config.setPolicy({ allowInput: true, rateLimitPerMinute: 12 });
  const reloaded = new Config(file);
  assert.equal(reloaded.get('policy.allowInput'), true);
  assert.equal(reloaded.get('policy.rateLimitPerMinute'), 12);
  assert.equal(reloaded.get('policy.allowScripts'), false, 'defaults must not be silently enabled');
});

test('broken config is quarantined, not deleted', () => {
  const file = path.join(process.env.SENTINEL_HOME, 'config-broken.json');
  fs.writeFileSync(file, '{ this is not json');
  const config = new Config(file);
  assert.equal(config.get('psk').length, 64);
  const backups = fs.readdirSync(process.env.SENTINEL_HOME).filter((name) => name.includes('config-broken.json.broken'));
  assert.equal(backups.length, 1, 'the damaged file should be kept for forensics');
});

/* ── the advisory brain (pure logic, so it runs without a PC) ──────────── */

const { Brain, minutesUntil } = require('../core/brain');

function fakeConfig(policy = {}) {
  return { get: (key, fallback) => (key === 'policy' ? policy : fallback) };
}

function snapshot(overrides = {}) {
  return {
    cpuPercent: 10,
    cpuModel: 'test cpu',
    memoryDetail: { total: 16 * 1024 ** 3, used: 2 * 1024 ** 3, percent: 12 },
    esp: { connected: true, link: 'up' },
    policy: { quietHours: { enabled: false, from: '23:00', to: '07:00' } },
    agent: { uptimeSec: 4000 },
    ...overrides,
  };
}

test('brain: a single CPU spike is not an insight, a sustained one is', () => {
  let clock = Date.now();
  const brain = new Brain({ config: fakeConfig(), now: () => clock });
  brain.observe(snapshot({ cpuPercent: 99 }));
  assert.equal(brain.list().length, 0, 'one hot sample must not raise anything');
  for (let i = 0; i < 5; i += 1) {
    clock += 15000;
    brain.observe(snapshot({ cpuPercent: 91 }));
  }
  const found = brain.list().find((insight) => insight.id === 'cpu-sustained');
  assert.ok(found, 'sustained load should produce an insight');
  assert.match(found.detail, /91%|90%/, 'the insight must quote the numbers');
});

test('brain: an insight clears when the condition goes away, and does not nag', () => {
  let clock = Date.now();
  const brain = new Brain({ config: fakeConfig(), now: () => clock });
  brain.observe(snapshot({ memoryDetail: { total: 16 * 1024 ** 3, used: 15 * 1024 ** 3, percent: 96 } }));
  assert.equal(brain.list().filter((i) => i.id === 'memory-tight').length, 1);
  brain.observe(snapshot());
  assert.equal(brain.list().filter((i) => i.id === 'memory-tight').length, 0, 'must clear');
  clock += 60000;
  brain.observe(snapshot({ memoryDetail: { total: 16 * 1024 ** 3, used: 15 * 1024 ** 3, percent: 96 } }));
  assert.equal(brain.list().filter((i) => i.id === 'memory-tight').length, 0, 'cooldown must suppress the repeat');
});

test('brain: ESP32 flapping is counted, and dismissing silences it', () => {
  let clock = Date.now();
  const brain = new Brain({ config: fakeConfig(), now: () => clock });
  for (let i = 0; i < 4; i += 1) {
    brain.observe(snapshot({ esp: { connected: false } }));
    clock += 20000;
    brain.observe(snapshot({ esp: { connected: true, link: 'up' } }));
    clock += 20000;
  }
  const flapping = brain.list().find((insight) => insight.id === 'esp-flapping');
  assert.ok(flapping, 'three or more drops should be noticed');
  assert.equal(brain.dismiss('esp-flapping'), true);
  assert.equal(brain.list().some((insight) => insight.id === 'esp-flapping'), false);
});

test('brain: a pending shutdown offers a cancel action', () => {
  const clock = Date.now();
  const brain = new Brain({ config: fakeConfig(), now: () => clock });
  brain.observe(snapshot(), { lastCommand: { cmd: 'system.shutdown', ok: true, at: clock } });
  const pending = brain.list().find((insight) => insight.id === 'shutdown-pending');
  assert.ok(pending, 'a scheduled shutdown should be surfaced');
  assert.equal(pending.action.cmd, 'system.cancel_shutdown');
});

test('brain: quiet-hours helper handles windows that cross midnight', () => {
  const at = (hour, minute) => new Date(2026, 0, 1, hour, minute).getTime();
  const quiet = { enabled: true, from: '23:00', to: '07:00' };
  assert.equal(minutesUntil(quiet, at(22, 30)), 30, '30 minutes before midnight');
  assert.equal(minutesUntil(quiet, at(2, 0)), null, 'already inside the window');
  assert.equal(minutesUntil({ enabled: false }, at(22, 30)), null);
});

/* ── integration: the encrypted tunnel and the ESP32 relay ─────────────── */

test('tunnel: handshake, encrypted command, replay refused', async () => {
  const net = require('node:net');
  const { createAgent } = require('../core/agent');
  const { TunnelClient } = require('../core/tunnel');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-tunnel-'));
  const agent = createAgent({ configPath: path.join(home, 'config.json') });
  agent.config.merge({ ports: { ui: 0, link: 0 } });
  agent.start();
  await new Promise((r) => setTimeout(r, 300));
  const port = agent.http.server.address().port;
  const psk = agent.config.get('psk');

  try {
    const client = new TunnelClient({ baseUrl: `http://127.0.0.1:${port}/api/tunnel`, pskHex: psk });
    const opened = await client.connect();
    assert.match(opened.sid, /^[0-9a-f]{16}$/, 'session id looks wrong');

    const info = await client.command('system.info');
    assert.equal(info.ok, true, info.message);
    assert.ok(info.data.hostname, 'system.info came back empty');

    const denied = await client.command('system.shutdown', {});
    assert.equal(denied.code, 'CONFIRM_REQUIRED', 'policy must still apply inside the tunnel');

    const poll = await client.poll();
    assert.equal(poll.ok, true);

    // A frame that was already used must not be accepted a second time.
    const sealed = client.c2s.seal(Buffer.from(JSON.stringify({ id: 99, poll: true })));
    const first = await fetch(`http://127.0.0.1:${port}/api/tunnel/msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: client.sid, seq: sealed.seq, ct: sealed.body.toString('base64') }),
    }).then((r) => r.json());
    assert.ok(first.ct, 'first use of a frame should succeed');
    const replay = await fetch(`http://127.0.0.1:${port}/api/tunnel/msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: client.sid, seq: sealed.seq, ct: sealed.body.toString('base64') }),
    }).then((r) => r.json());
    assert.ok(replay.error, 'replayed frame was accepted');

    // Plain text must never work.
    const plain = await fetch(`http://127.0.0.1:${port}/api/tunnel/msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: client.sid, seq: 500, ct: Buffer.from('{"cmd":"system.info"}').toString('base64') }),
    }).then((r) => r.json());
    assert.ok(plain.error, 'unencrypted payload was accepted');
  } finally {
    agent.stop();
  }
});

test('tunnel: a wrong pairing key cannot open a session', async () => {
  const { createAgent } = require('../core/agent');
  const { TunnelClient } = require('../core/tunnel');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-wrongkey-'));
  const agent = createAgent({ configPath: path.join(home, 'config.json') });
  agent.config.merge({ ports: { ui: 0, link: 0 } });
  agent.start();
  await new Promise((r) => setTimeout(r, 300));
  const port = agent.http.server.address().port;
  try {
    const client = new TunnelClient({ baseUrl: `http://127.0.0.1:${port}/api/tunnel`, pskHex: 'b'.repeat(64) });
    let message = null;
    try {
      await client.connect();
    } catch (err) {
      message = err.message;
    }
    assert.ok(message, 'a wrong key must not connect');
    assert.match(message, /pairing key|share/i);
  } finally {
    agent.stop();
  }
});

test('relay: an ESP32 can forward commands over its authenticated link', async () => {
  const net = require('node:net');
  const { createAgent } = require('../core/agent');
  const { handshakeProof } = require('../core/protocol');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-relay-'));
  const agent = createAgent({ configPath: path.join(home, 'config.json') });
  agent.config.merge({ ports: { ui: 0, link: 0 } });
  agent.start();
  await new Promise((r) => setTimeout(r, 300));
  const linkPort = agent.http.server.address().port + 1;
  // The agent picked an ephemeral link port; read it back from the listener.
  const actualLinkPort = agent.link.server.address().port;
  const psk = agent.config.get('psk');

  const socket = net.connect(actualLinkPort, '127.0.0.1');
  const frames = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const waitFor = async (type, timeout = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      // Consume the frame so a second wait sees the *next* reply.
      const index = frames.findIndex((frame) => frame.t === type);
      if (index >= 0) return frames.splice(index, 1)[0];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${type} frame from the agent (got ${frames.map((f) => f.t).join(', ')})`);
  };

  try {
    const hello = await waitFor('hello');
    const deviceId = 'esp32-test';
    const deviceNonce = 'a'.repeat(32);
    socket.write(JSON.stringify({
      t: 'auth',
      deviceId,
      nonce: deviceNonce,
      sig: handshakeProof(psk, hello.nonce, deviceNonce, deviceId),
    }) + '\n');
    await waitFor('welcome');
    socket.write(JSON.stringify({ t: 'rpc', id: 'r1', body: JSON.stringify({ cmd: 'system.info' }) }) + '\n');
    const replyFrame = await waitFor('rpc_res');
    assert.equal(replyFrame.ok, true, 'relay refused the command');
    const reply = JSON.parse(replyFrame.body);
    assert.ok(reply.data.hostname, 'relayed system.info came back empty');

    socket.write(JSON.stringify({ t: 'rpc', id: 'r2', body: JSON.stringify({ cmd: 'system.shutdown' }) }) + '\n');
    const denied = JSON.parse((await waitFor('rpc_res')).body);
    assert.equal(denied.code, 'CONFIRM_REQUIRED', 'policy must apply to relayed commands');
  } finally {
    socket.destroy();
    agent.stop();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} tests passed.` : `\n${failed} of ${tests.length} tests failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
