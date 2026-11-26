'use strict';

const { spawn } = require('node:child_process');

/**
 * Run a program and capture its output with a hard timeout.
 * Nothing here goes through a shell unless the caller explicitly asks for it,
 * so user-supplied strings can never be interpreted as shell syntax.
 */
function run(file, args = [], { timeout = 15000, input = null, env = null, maxBytes = 512 * 1024, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    const errChunks = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: env || process.env,
      });
    } catch (err) {
      return finish({ ok: false, code: -1, stdout: '', stderr: String(err.message), error: 'SPAWN_FAILED' });
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        code: -1,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        error: 'TIMEOUT',
      });
    }, Math.max(500, timeout));

    child.stdout.on('data', (buf) => {
      size += buf.length;
      if (size <= maxBytes) chunks.push(buf);
    });
    child.stderr.on('data', (buf) => {
      if (errChunks.length < 400) errChunks.push(buf);
    });
    child.on('error', (err) => {
      finish({ ok: false, code: -1, stdout: '', stderr: String(err.message), error: err.code || 'SPAWN_FAILED' });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').slice(0, 8000),
      });
    });

    if (input != null) {
      try {
        child.stdin.end(input);
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
  });
}

/** Start a program without waiting for it, fully detached from the agent. */
function launchDetached(file, args = [], { cwd = undefined, env = null } = {}) {
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd,
    env: env || process.env,
  });
  child.unref();
  return child.pid;
}

/** Is this executable on PATH? */
const whichCache = new Map();
async function which(bin, { timeout = 4000 } = {}) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  const probe =
    process.platform === 'win32'
      ? run('where.exe', [bin], { timeout })
      : run('sh', ['-c', 'command -v "$1"', 'sh', bin], { timeout });
  const found = (await probe).ok;
  const full = found ? (await probe).stdout.split(/\r?\n/)[0].trim() : null;
  const result = found ? { found: true, path: full } : { found: false, path: null };
  whichCache.set(bin, result);
  return result;
}

/** First executable from a list that exists on this machine. */
async function firstAvailable(bins) {
  for (const bin of bins) {
    const res = await which(bin);
    if (res.found) return res.path;
  }
  return null;
}

/** Run a PowerShell snippet (Windows only). */
async function powershell(script, opts = {}) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: opts.timeout || 20000, ...opts },
  );
}

module.exports = { run, launchDetached, which, firstAvailable, powershell };
