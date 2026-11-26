'use strict';

/**
 * Policy gate. Every command declares the policy flag it needs; the gate
 * answers yes/no and explains itself, so the UI can show *why* something is
 * blocked instead of silently failing.
 */

const POLICY_FOR_COMMAND = {
  'system.shutdown': 'allowShutdown',
  'system.reboot': 'allowReboot',
  'system.sleep': 'allowSleep',
  'system.lock': 'allowLock',
  'system.logout': 'allowLogout',
  'system.cancel_shutdown': 'allowShutdown',
  'media.play_pause': 'allowMedia',
  'media.next': 'allowMedia',
  'media.previous': 'allowMedia',
  'media.stop': 'allowMedia',
  'volume.up': 'allowVolume',
  'volume.down': 'allowVolume',
  'volume.mute': 'allowVolume',
  'screen.screenshot': 'allowScreenshot',
  'screen.wake': 'allowWake',
  'input.type': 'allowInput',
  'input.key': 'allowInput',
  'app.launch': 'allowAppLaunch',
  'app.kill': 'allowAppKill',
  'files.list': 'allowFileList',
  'script.run': 'allowScripts',
  'esp.power': 'allowEspPower',
  'esp.reset': 'allowEspPower',
};

/** Commands that change machine state and must carry an explicit confirm. */
const DESTRUCTIVE = new Set([
  'system.shutdown',
  'system.reboot',
  'system.logout',
  'system.sleep',
  'system.cancel_shutdown',
  'app.kill',
  'script.run',
  'esp.power',
  'esp.reset',
]);

/** Always allowed once authenticated: read-only information. */
const SAFE = new Set([
  'system.info',
  'system.ping',
  'agent.status',
  'agent.policy.get',
  'esp.status',
  'files.list',
  'screen.screenshot',
  'macro.list',
]);

function withinQuietHours(quietHours, now = new Date()) {
  if (!quietHours || !quietHours.enabled) return false;
  const [fh, fm] = String(quietHours.from || '23:00').split(':').map(Number);
  const [th, tm] = String(quietHours.to || '07:00').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = (fh || 0) * 60 + (fm || 0);
  const to = (th || 0) * 60 + (tm || 0);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/**
 * @param {string} cmd
 * @param {object} policy
 * @param {{confirm?:boolean}} args
 * @param {{source?:string, now?:Date}} ctx
 */
function check(cmd, policy = {}, args = {}, ctx = {}) {
  const flag = POLICY_FOR_COMMAND[cmd];
  if (flag && policy[flag] === false) {
    return {
      ok: false,
      code: 'POLICY_DENIED',
      message: `${cmd} is disabled by policy (${flag}). Enable it in Control → Capabilities.`,
    };
  }
  if (DESTRUCTIVE.has(cmd) && policy.requireConfirm !== false && args && args.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      message: `${cmd} needs confirmation. Re-send with confirm: true from the UI.`,
    };
  }
  if (policy.quietHours && withinQuietHours(policy.quietHours, ctx.now)) {
    const hard = cmd.startsWith('esp.') || cmd.startsWith('system.');
    if (hard && cmd !== 'system.info' && cmd !== 'system.cancel_shutdown') {
      return {
        ok: false,
        code: 'QUIET_HOURS',
        message: `Quiet hours are active (${policy.quietHours.from}–${policy.quietHours.to}). Unlock in Settings or use an emergency macro.`,
      };
    }
  }
  return { ok: true };
}

/** Sliding-window rate limiter, keyed by caller. */
class RateLimiter {
  constructor(perMinute = 40) {
    this.perMinute = perMinute;
    this.hits = new Map();
  }

  setLimit(perMinute) {
    this.perMinute = perMinute;
  }

  allow(key = 'default', cost = 1) {
    const now = Date.now();
    const windowStart = now - 60000;
    const list = (this.hits.get(key) || []).filter((t) => t > windowStart);
    if (list.length + cost > this.perMinute) {
      this.hits.set(key, list);
      return { ok: false, retryAfterMs: 60000 - (now - list[0]) };
    }
    for (let i = 0; i < cost; i++) list.push(now);
    this.hits.set(key, list);
    return { ok: true, remaining: this.perMinute - list.length };
  }
}

module.exports = { POLICY_FOR_COMMAND, DESTRUCTIVE, SAFE, check, RateLimiter, withinQuietHours };
