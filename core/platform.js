'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { run, launchDetached, firstAvailable, powershell } = require('./runner');

class PlatformError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/** SendKeys metacharacters must be wrapped in braces to be typed literally. */
function escapeSendKeys(text) {
  let out = '';
  for (const ch of String(text)) {
    if (ch === '\n') out += '{ENTER}';
    else if (ch === '\r') continue;
    else if (ch === '\t') out += '{TAB}';
    else if ('+^%~(){}[]'.includes(ch)) out += `{${ch}}`;
    else out += ch;
  }
  return out;
}

const SENDKEY_NAMES = {
  enter: '{ENTER}',
  return: '{ENTER}',
  esc: '{ESC}',
  escape: '{ESC}',
  tab: '{TAB}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  printscreen: '{PRTSC}',
  win: null,
};

function sendKeysFor(combo) {
  if (typeof combo !== 'string' || !combo.trim()) throw new PlatformError('BAD_ARGS', 'Key combo is empty');
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods = new Set();
  const keys = [];
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') mods.add('^');
    else if (part === 'alt') mods.add('%');
    else if (part === 'shift') mods.add('+');
    else if (part === 'win' || part === 'meta' || part === 'cmd') mods.add('WIN');
    else keys.push(part);
  }
  const key = keys[keys.length - 1] || '';
  let body;
  if (key in SENDKEY_NAMES) {
    if (SENDKEY_NAMES[key] === null) throw new PlatformError('UNSUPPORTED', '"win" cannot be combined with another key on Windows');
    body = SENDKEY_NAMES[key];
  } else if (/^f([1-9]|1[0-2])$/.test(key)) body = `{F${key.slice(1)}}`;
  else if (/^[a-z0-9]$/.test(key)) body = key;
  else body = escapeSendKeys(key);
  if (mods.has('WIN')) throw new PlatformError('UNSUPPORTED', 'The Windows key is not supported by SendKeys');
  return [...mods].join('') + body;
}

const win = {
  async shutdown(delaySec) {
    return run('shutdown.exe', ['/s', '/t', String(delaySec), '/d', 'p:0:0', '/c', 'Shutdown requested by SENTINEL'], { timeout: 8000 });
  },
  async reboot(delaySec) {
    return run('shutdown.exe', ['/r', '/t', String(delaySec), '/d', 'p:0:0', '/c', 'Restart requested by SENTINEL'], { timeout: 8000 });
  },
  async cancelShutdown() {
    return run('shutdown.exe', ['/a'], { timeout: 8000 });
  },
  async sleep() {
    // SetSuspendState(0,1,0): suspend, do not force, do not disable wake events.
    return run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { timeout: 8000 });
  },
  async lock() {
    return run('rundll32.exe', ['user32.dll,LockWorkStation'], { timeout: 8000 });
  },
  async logout() {
    return run('shutdown.exe', ['/l'], { timeout: 8000 });
  },
  async media(action) {
    const keys = { play_pause: 179, next: 176, previous: 177, stop: 178 };
    const code = keys[action];
    if (!code) throw new PlatformError('BAD_ARGS', `Unknown media action ${action}`);
    return powershell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code});`, { timeout: 12000 });
  },
  async volume(action, step = 6) {
    if (action === 'mute') {
      return powershell('$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]173);', { timeout: 12000 });
    }
    const code = action === 'up' ? 175 : 174;
    const times = Math.max(1, Math.min(20, Math.round(step / 2)));
    const body = '1..' + times + ' | ForEach-Object { $w.SendKeys([char]' + code + ') }';
    return powershell(`$w = New-Object -ComObject WScript.Shell; ${body}`, { timeout: 15000 });
  },
  async wake() {
    return powershell(
      '$w = New-Object -ComObject WScript.Shell; $w.SendKeys("{F15}"); ' +
        'Add-Type -Namespace S -Name P -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);\'; ' +
        '[S.P]::mouse_event(0,1,0,0,0); [S.P]::mouse_event(0,0,0,0,0);',
      { timeout: 12000 },
    );
  },
  async screenshot() {
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$max = 1600
if ($bmp.Width -gt $max) {
  $h = [int]($bmp.Height * ($max / $bmp.Width))
  $small = New-Object System.Drawing.Bitmap $max, $h
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = 'HighQualityBicubic'
  $g2.DrawImage($bmp, 0, 0, $max, $h)
  $bmp.Dispose(); $bmp = $small
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())`;
    const res = await powershell(script, { timeout: 30000, maxBytes: 24 * 1024 * 1024 });
    if (!res.ok) throw new PlatformError('CAPTURE_FAILED', 'Screenshot failed', res.stderr.trim());
    const b64 = res.stdout.replace(/\s+/g, '');
    if (b64.length < 100) throw new PlatformError('CAPTURE_FAILED', 'Empty screenshot');
    return { mime: 'image/png', data: b64 };
  },
  async typeText(text) {
    const payload = escapeSendKeys(String(text).slice(0, 4000));
    const encoded = Buffer.from(payload, 'utf8').toString('base64');
    return powershell(
      `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')));`,
      { timeout: 25000 },
    );
  },
  async pressKey(combo) {
    const keys = sendKeysFor(combo);
    return powershell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${keys.replace(/'/g, "''")}')`, { timeout: 15000 });
  },
  async launchApp(entry, name) {
    const target = entry.path || entry.command;
    if (!target) throw new PlatformError('BAD_ARGS', `App "${name}" has no path configured`);
    if (!fs.existsSync(target)) throw new PlatformError('NOT_FOUND', `Path does not exist: ${target}`);
    const args = Array.isArray(entry.args) ? entry.args : [];
    const pid = launchDetached(target, args, { cwd: entry.cwd || path.dirname(target) });
    return { pid };
  },
  async killApp(entry, name) {
    const image = entry.process || path.basename(entry.path || name).replace(/\.exe$/i, '');
    const res = await run('taskkill.exe', ['/IM', image.endsWith('.exe') ? image : `${image}.exe`, '/F'], { timeout: 10000 });
    if (!res.ok && /not found/i.test(res.stderr + res.stdout)) {
      throw new PlatformError('NOT_FOUND', `No running process named ${image}`);
    }
    if (!res.ok) throw new PlatformError('KILL_FAILED', `taskkill failed`, res.stderr.trim());
    return { process: image };
  },
};

const linux = {
  async shutdown() {
    let res = await run('systemctl', ['poweroff'], { timeout: 8000 });
    if (!res.ok) res = await run('loginctl', ['poweroff'], { timeout: 8000 });
    if (!res.ok) res = await run('shutdown', ['-h', 'now'], { timeout: 8000 });
    return res;
  },
  async reboot() {
    let res = await run('systemctl', ['reboot'], { timeout: 8000 });
    if (!res.ok) res = await run('loginctl', ['reboot'], { timeout: 8000 });
    if (!res.ok) res = await run('shutdown', ['-r', 'now'], { timeout: 8000 });
    return res;
  },
  async cancelShutdown() {
    let res = await run('shutdown', ['-c'], { timeout: 8000 });
    if (!res.ok) res = await run('systemctl', ['stop', 'shutdown.target'], { timeout: 8000 });
    return res;
  },
  async sleep() {
    let res = await run('systemctl', ['suspend'], { timeout: 8000 });
    if (!res.ok) res = await run('loginctl', ['suspend'], { timeout: 8000 });
    return res;
  },
  async lock() {
    for (const [cmd, args] of [
      ['loginctl', ['lock-session']],
      ['xdg-screensaver', ['lock']],
      ['gnome-screensaver-command', ['-l']],
      ['swaylock', []],
    ]) {
      const res = await run(cmd, args, { timeout: 6000 });
      if (res.ok) return res;
    }
    throw new PlatformError('UNSUPPORTED', 'No screen locker found (tried loginctl, xdg-screensaver, gnome-screensaver, swaylock)');
  },
  async logout() {
    let res = await run('gnome-session-quit', ['--logout', '--no-prompt'], { timeout: 8000 });
    if (!res.ok) res = await run('loginctl', ['terminate-user', os.userInfo().username], { timeout: 8000 });
    return res;
  },
  async media(action) {
    const map = { play_pause: 'play-pause', next: 'next', previous: 'previous', stop: 'stop' };
    const res = await run('playerctl', [map[action] || 'play-pause'], { timeout: 8000 });
    if (!res.ok) throw new PlatformError('UNSUPPORTED', 'playerctl is not available (install playerctl)', res.stderr.trim());
    return res;
  },
  async volume(action, step = 6) {
    if (action === 'mute') {
      const res = await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'], { timeout: 8000 });
      if (res.ok) return res;
    } else {
      const amount = `${action === 'up' ? '+' : '-'}${Math.max(1, Math.min(30, step))}%`;
      const res = await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', amount], { timeout: 8000 });
      if (res.ok) return res;
    }
    const amixer = await run('amixer', ['-q', 'sset', 'Master', action === 'mute' ? 'toggle' : `${Math.max(1, step)}%${action === 'up' ? '+' : '-'}`], { timeout: 8000 });
    if (amixer.ok) return amixer;
    throw new PlatformError('UNSUPPORTED', 'No mixer found (install pulseaudio-utils or alsa-utils)');
  },
  async wake() {
    for (const [cmd, args] of [
      ['xset', ['dpms', 'force', 'on']],
      ['wlopm', ['--on', '*']],
      ['xdotool', ['mousemove', '1', '1']],
    ]) {
      const res = await run(cmd, args, { timeout: 5000 });
      if (res.ok) return res;
    }
    throw new PlatformError('UNSUPPORTED', 'Could not wake the display (install xset or wlopm)');
  },
  async screenshot() {
    const grim = await firstAvailable(['grim']);
    if (grim) {
      const res = await run(grim, ['-s', '0.8', '-t', 'png', '-'], { timeout: 20000, maxBytes: 24 * 1024 * 1024 });
      if (res.ok && res.stdout.length > 100) return { mime: 'image/png', data: Buffer.from(res.stdout, 'binary').toString('base64') };
    }
    const tools = [
      ['spectacle', ['-b', '-n', '-o', '/tmp/sentinel-shot.png']],
      ['gnome-screenshot', ['-f', '/tmp/sentinel-shot.png']],
      ['scrot', ['/tmp/sentinel-shot.png']],
      ['import', ['-window', 'root', '-resize', '1600x', '/tmp/sentinel-shot.png']],
    ];
    for (const [cmd, args] of tools) {
      const res = await run(cmd, args, { timeout: 20000 });
      if (res.ok && fs.existsSync('/tmp/sentinel-shot.png')) {
        const buf = fs.readFileSync('/tmp/sentinel-shot.png');
        fs.unlink('/tmp/sentinel-shot.png', () => {});
        if (buf.length > 100) return { mime: 'image/png', data: buf.toString('base64') };
      }
    }
    throw new PlatformError('CAPTURE_FAILED', 'No screenshot tool worked (install grim, scrot, or ImageMagick)');
  },
  async typeText(text) {
    const res = await run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', String(text).slice(0, 4000)], { timeout: 30000 });
    if (!res.ok) throw new PlatformError('UNSUPPORTED', 'xdotool is required for typing on Linux', res.stderr.trim());
    return res;
  },
  async pressKey(combo) {
    const res = await run('xdotool', ['key', '--clearmodifiers', String(combo).replace(/\+/g, '+')], { timeout: 10000 });
    if (!res.ok) throw new PlatformError('UNSUPPORTED', 'xdotool is required for key presses on Linux', res.stderr.trim());
    return res;
  },
  async launchApp(entry, name) {
    const target = entry.path || entry.command;
    if (!target) throw new PlatformError('BAD_ARGS', `App "${name}" has no path configured`);
    if (target.startsWith('/') && !fs.existsSync(target)) throw new PlatformError('NOT_FOUND', `Path does not exist: ${target}`);
    const pid = launchDetached(target, Array.isArray(entry.args) ? entry.args : []);
    return { pid };
  },
  async killApp(entry, name) {
    const image = entry.process || path.basename(entry.path || name);
    const res = await run('pkill', ['-f', image], { timeout: 8000 });
    if (!res.ok) throw new PlatformError('KILL_FAILED', `No process matched ${image}`);
    return { process: image };
  },
};

const mac = {
  async shutdown() {
    return run('osascript', ['-e', 'tell application "System Events" to shut down'], { timeout: 10000 });
  },
  async reboot() {
    return run('osascript', ['-e', 'tell application "System Events" to restart'], { timeout: 10000 });
  },
  async cancelShutdown() {
    return run('osascript', ['-e', 'tell application "System Events" to cancel shut down']);
  },
  async sleep() {
    return run('pmset', ['sleepnow'], { timeout: 8000 });
  },
  async lock() {
    return run('pmset', ['displaysleepnow'], { timeout: 8000 });
  },
  async logout() {
    return run('osascript', ['-e', 'tell application "System Events" to log out'], { timeout: 10000 });
  },
  async media(action) {
    const map = { play_pause: 'playpause', next: 'next track', previous: 'previous track', stop: 'stop' };
    const res = await run('osascript', ['-e', `tell application "Music" to ${map[action] || 'playpause'}`], { timeout: 10000 });
    if (!res.ok) throw new PlatformError('UNSUPPORTED', 'Could not reach a media player');
    return res;
  },
  async volume(action, step = 6) {
    if (action === 'mute') return run('osascript', ['-e', 'set volume output muted not (output muted of (get volume settings))']);
    const delta = (action === 'up' ? 1 : -1) * Math.max(1, Math.min(30, step));
    return run('osascript', ['-e', `set volume output volume ((output volume of (get volume settings)) + ${delta})`]);
  },
  async wake() {
    return run('caffeinate', ['-u', '-t', '2'], { timeout: 6000 });
  },
  async screenshot() {
    const file = path.join(os.tmpdir(), `sentinel-shot-${Date.now()}.png`);
    const res = await run('screencapture', ['-x', '-t', 'png', file], { timeout: 20000 });
    if (!res.ok || !fs.existsSync(file)) throw new PlatformError('CAPTURE_FAILED', 'screencapture failed', res.stderr.trim());
    const buf = fs.readFileSync(file);
    fs.unlink(file, () => {});
    return { mime: 'image/png', data: buf.toString('base64') };
  },
  async typeText(text) {
    const safe = String(text).slice(0, 4000).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return run('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`], { timeout: 30000 });
  },
  async pressKey(combo) {
    const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
    const mods = parts.slice(0, -1).map((m) => ({ ctrl: 'control down', alt: 'option down', shift: 'shift down', cmd: 'command down', win: 'command down' }[m] || ''));
    const key = parts[parts.length - 1];
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    return run('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${using}`], { timeout: 15000 });
  },
  async launchApp(entry, name) {
    const target = entry.path || entry.command || name;
    const pid = launchDetached('open', ['-a', target]);
    return { pid };
  },
  async killApp(entry, name) {
    const image = entry.process || name;
    const res = await run('pkill', ['-f', image], { timeout: 8000 });
    if (!res.ok) throw new PlatformError('KILL_FAILED', `No process matched ${image}`);
    return { process: image };
  },
};

const impl = IS_WIN ? win : IS_MAC ? mac : linux;

/** Wrap a platform call and turn a non-zero exit into a useful error. */
async function call(action, ctx, fn) {
  const res = await fn();
  if (!res) return { ok: true };
  if (res.ok === false) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 400);
    const friendly =
      res.error === 'SPAWN_FAILED' || res.error === 'ENOENT'
        ? `${action} is not available on this system`
        : `${action} failed with exit code ${res.code}`;
    throw new PlatformError('COMMAND_FAILED', friendly, detail);
  }
  return { ok: true, exitCode: res.code ?? 0, detail: (res.stdout || '').trim().slice(0, 1000) || undefined };
}

/** Probe which features actually work here, so the UI can grey out the rest. */
async function capabilities() {
  const caps = {
    shutdown: true,
    reboot: true,
    sleep: IS_WIN || IS_LINUX || IS_MAC,
    lock: true,
    logout: true,
    media: true,
    volume: true,
    screenshot: true,
    wake: true,
    input: true,
    apps: true,
  };
  if (IS_LINUX) {
    caps.screenshot = Boolean(await firstAvailable(['grim', 'spectacle', 'gnome-screenshot', 'scrot', 'import']));
    caps.input = Boolean(await firstAvailable(['xdotool']));
    caps.media = Boolean(await firstAvailable(['playerctl']));
    caps.volume = Boolean(await firstAvailable(['pactl', 'amixer']));
    caps.wake = Boolean(await firstAvailable(['xset', 'wlopm', 'xdotool']));
    caps.lock = Boolean(await firstAvailable(['loginctl', 'xdg-screensaver', 'gnome-screensaver-command', 'swaylock']));
  }
  if (IS_WIN) {
    caps.input = (await firstAvailable(['powershell.exe'])) !== null;
  }
  return caps;
}

module.exports = { PlatformError, platform: impl, capabilities, IS_WIN, IS_MAC, IS_LINUX, escapeSendKeys };
