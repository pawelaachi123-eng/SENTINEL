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
