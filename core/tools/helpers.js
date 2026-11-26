'use strict';

/**
 * Shared plumbing for tools: process execution without a shell, text decoding
 * that understands Windows encodings, directory walking with limits, hashing.
 *
 * There is no `shell: true` anywhere in this file. Tools pass argv arrays, so a
 * model that smuggles `; rm -rf /` into an argument gets it as a literal
 * argument, not as a command.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';

class ExecError extends Error {
  constructor(message, { code = 'EXEC_FAILED', stdout = '', stderr = '', exitCode = null } = {}) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Runs a binary with an argv array. No shell, no string interpolation.
 * @returns {Promise<{stdout: string, stderr: string, code: number, ms: number}>}
 */
function run(command, args = [], { timeout = 15000, signal = null, cwd = null, env = null, input = null, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args.map(String), {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ExecError(`could not start ${command}: ${err.message}`, { code: 'SPAWN_FAILED' }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;
    let truncated = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(reject, new ExecError(`${command} did not finish within ${timeout} ms`, { code: 'TIMEOUT', stdout, stderr }));
    }, Math.max(1000, Math.min(timeout, 600000)));
    if (timer.unref) timer.unref();

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(reject, new ExecError(`${command} was cancelled`, { code: 'CANCELLED' }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
      else truncated = true;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      const code = err.code === 'ENOENT' ? 'NOT_INSTALLED' : 'SPAWN_FAILED';
      finish(reject, new ExecError(`${command} is not available (${err.message})`, { code }));
    });
    child.on('close', (code) => {
      if (truncated) stderr += '\n[output truncated]';
      finish(resolve, { stdout, stderr, code, ms: Date.now() - started });
    });

    if (input != null) {
      try {
        child.stdin.end(String(input));
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

/** Runs a PowerShell script through stdin (no quoting games, no -Command parsing). */
async function powershell(script, options = {}) {
  if (!IS_WINDOWS) throw new ExecError('PowerShell tools only run on Windows', { code: 'UNSUPPORTED_PLATFORM' });
  return run(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { ...options, input: `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}` },
  );
}

/** PowerShell → JSON helper: returns parsed objects, or [] when empty. */
async function powershellJson(script, options = {}) {
  const result = await powershell(`(${script}) | ConvertTo-Json -Depth 6`, options);
  const text = result.stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Linux-only helper with an honest error on other platforms. */
async function linux(command, args, options = {}) {
  if (IS_WINDOWS) throw new ExecError(`${command} is not available on Windows`, { code: 'UNSUPPORTED_PLATFORM' });
  return run(command, args, options);
}

const whichCache = new Map();

/** Is this binary on PATH? (Cached: shells are started often.) */
async function which(binary) {
  if (whichCache.has(binary)) return whichCache.get(binary);
  const finder = IS_WINDOWS ? 'where' : 'which';
  try {
    const result = await run(finder, [binary], { timeout: 4000 });
    const found = result.code === 0 && Boolean(result.stdout.trim());
    whichCache.set(binary, found);
    return found;
  } catch {
    whichCache.set(binary, false);
    return false;
  }
}

/** Decodes bytes as UTF-8, falling back to Windows-1250 when that is what it is. */
function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(String(buffer || ''), 'utf8');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  const utf8 = buffer.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0) return { text: utf8, encoding: 'utf-8' };
  // Windows-1250 is the common case for Polish text files made by older tools.
  for (const candidate of ['windows-1250', 'windows-1252', 'iso-8859-2']) {
    try {
      const text = new TextDecoder(candidate, { fatal: false }).decode(buffer);
      if (!text.includes('\uFFFD')) return { text, encoding: candidate };
    } catch {
      /* decoder unavailable */
    }
  }
  return { text: utf8.replace(/\uFFFD/g, '?'), encoding: 'utf-8-lossy' };
}

async function readTextFile(target, { maxBytes = 200000 } = {}) {
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new ExecError('that path is not a file', { code: 'NOT_A_FILE' });
  const size = Math.min(stat.size, maxBytes);
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const decoded = decodeText(buffer.subarray(0, bytesRead));
    return {
      text: decoded.text,
      encoding: decoded.encoding,
      bytes: stat.size,
      truncated: stat.size > size,
      mtime: stat.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function truncate(text, limit = 4000) {
  const value = String(text == null ? '' : text);
  return value.length > limit ? `${value.slice(0, limit)}\n… [${value.length - limit} more characters]` : value;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'bin', 'obj', '.gradle', '.pio', 'coverage']);

/**
 * Walks a directory breadth-first with hard limits, so "index my whole disk"
 * cannot happen by accident.
 */
async function walk(root, { maxFiles = 2000, maxDepth = 8, includeHidden = false, followSymlinks = false } = {}) {
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && out.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (!includeHidden && entry.name.startsWith('.')) {
        if (!['.github', '.gitignore', '.env.example'].includes(entry.name)) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (depth + 1 > maxDepth) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(full);
      } else if (entry.isSymbolicLink() && followSymlinks) {
        try {
          const stat = await fsp.stat(full);
          if (stat.isFile()) out.push(full);
        } catch {
          /* broken link */
        }
      }
    }
  }
  return out;
}

async function hashFile(target, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Minimal glob → RegExp for `*.log`, `**\/*.ts`, `src/**`. */
function globToRegExp(glob) {
  const escaped = String(glob || '*')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** Line diff (LCS) small enough for tool output; returns unified-ish text. */
function diffLines(before, after, { context = 2, label = 'diff' } = {}) {
  const a = String(before || '').split(/\r?\n/);
  const b = String(after || '').split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) throw new ExecError('the inputs are too large to diff', { code: 'TOO_LARGE' });
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'remove', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'remove', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });

  const lines = [`--- ${label}`, `+++ ${label}`];
  let lastKept = -1000;
  let added = 0;
  let removed = 0;
  ops.forEach((op, index) => {
    if (op.type !== 'same') {
      if (op.type === 'add') added += 1;
      else removed += 1;
    }
    if (op.type === 'same' && index - lastKept > context * 2) return;
    if (op.type !== 'same') lastKept = index;
    lines.push(`${op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}${op.text}`);
  });
  return { text: lines.join('\n'), added, removed, unchanged: ops.filter((op) => op.type === 'same').length };
}

module.exports = {
  IS_WINDOWS,
  ExecError,
  run,
  powershell,
  powershellJson,
  linux,
  which,
  decodeText,
  readTextFile,
  humanBytes,
  truncate,
  walk,
  hashFile,
  globToRegExp,
  safeJson,
  diffLines,
  IGNORED_DIRS,
};
