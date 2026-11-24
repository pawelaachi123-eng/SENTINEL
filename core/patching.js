'use strict';

/**
 * Staged patches — the coding workflow, without a model holding a loaded gun.
 *
 * A change is never written straight into the user's file. It is staged:
 *
 *   propose  → the new content is kept in SENTINEL_HOME/patches/<id>/ along with
 *              the original, a unified diff and the reason for the change;
 *   verify   → the candidate file is materialised in an isolated workspace and a
 *              whitelisted verification command runs there (default: syntax
 *              check for the language). Nothing outside the workspace is touched;
 *   apply    → only after verification passed, only with a real approval, and
 *              only after a backup of the target file is written;
 *   discard  → the staged copy is deleted, the target is untouched.
 *
 * The verification command is a whitelist, not a shell string: a model cannot
 * smuggle `&& rm -rf` into it, and the process runs with a timeout and no shell.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { newId } = require('./memory/store');

const MAX_BYTES = 2 * 1024 * 1024;

/** Commands a staged patch may be verified with, per extension. */
const VERIFIERS = {
  '.js': { command: 'node', args: ['--check'] },
  '.cjs': { command: 'node', args: ['--check'] },
  '.mjs': { command: 'node', args: ['--check'] },
  '.json': { command: 'node', args: ['-e'] },
  '.py': { command: 'python', args: ['-m', 'py_compile'] },
  '.ps1': null,
  '.md': null,
  '.txt': null,
};

const AUTO_VERIFY_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const NAMED_VERIFIERS = {
  syntax: null, // chosen from the extension
  // On Windows npm is a .cmd shim; spawnSync without a shell cannot execute it.
  test: { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test', '--silent'] },
  none: null,
};

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function diffLines(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  // LCS on lines. Files are bounded to 2 MB and diffs are only for display, so
  // this stays comfortably fast without pulling in a diff library.
  const n = a.length;
  const m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      lines.push(`-${a[i]}`);
      removed += 1;
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`);
    removed += 1;
    i += 1;
  }
  while (j < m) {
    lines.push(`+${b[j]}`);
    added += 1;
    j += 1;
  }
  return { lines, added, removed };
}

function verifierFor(file, name) {
  if (name && name !== 'syntax') {
    if (!Object.prototype.hasOwnProperty.call(NAMED_VERIFIERS, name)) throw Object.assign(new Error(`unknown verifier ${name}`), { code: 'BAD_VERIFIER' });
    return NAMED_VERIFIERS[name];
  }
  const extension = path.extname(file).toLowerCase();
  if (AUTO_VERIFY_EXTENSIONS.has(extension)) return VERIFIERS[extension];
  if (extension === '.json') return { command: 'node', args: ['-e', 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))'] };
  return null;
}

class PatchManager {
  constructor({ paths, sandbox, log = null, now = () => Date.now(), store = null, config = null, runner = null }) {
    this.paths = paths;
    this.sandbox = sandbox;
    this.log = log;
    this.now = now;
    this.store = store;
    this.config = config;
    this.runner = runner || ((command, args, options) => spawnSync(command, args, { ...options, shell: false, encoding: 'utf8', timeout: options.timeoutMs || 60000 }));
    this.collection = 'patch_sessions';
    this.sessions = new Map();
    this.load();
  }

  root() {
    const root = this.paths.patchesDir ? this.paths.patchesDir() : path.join(this.paths.dataDir(), 'patches');
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  load() {
    if (!this.store) return;
    for (const doc of this.store.list(this.collection)) this.sessions.set(doc.id, doc);
  }

  persist(session) {
    this.sessions.set(session.id, session);
    if (this.store) this.store.put(this.collection, session.id, session);
    return session;
  }

  /** Paths are resolved through the same sandbox the tools use. */
  resolve(file) {
    if (this.sandbox && typeof this.sandbox.resolve === 'function') return this.sandbox.resolve(file, { write: true });
    return path.resolve(file);
  }

  stagedDir(id) {
    return path.join(this.root(), id);
  }

  create({ file, newText, description = null, verify = 'syntax', requestedBy = 'user' }) {
    if (!file) throw Object.assign(new Error('a patch needs a file'), { code: 'BAD_ARGS' });
    if (typeof newText !== 'string') throw Object.assign(new Error('a patch needs newText'), { code: 'BAD_ARGS' });
    if (Buffer.byteLength(newText) > MAX_BYTES) throw Object.assign(new Error('the patch is larger than 2 MB'), { code: 'TOO_LARGE' });
    const target = this.resolve(file);
    let before = '';
    let existed = false;
    try {
      const stat = fs.statSync(target);
      if (stat.size > MAX_BYTES) throw Object.assign(new Error('the target file is larger than 2 MB'), { code: 'TOO_LARGE' });
      before = fs.readFileSync(target, 'utf8');
      existed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (before === newText) throw Object.assign(new Error('the patch changes nothing'), { code: 'NO_CHANGE' });
    const diff = diffLines(before, newText);
    const id = newId('patch');
    const dir = this.stagedDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'before'), before, 'utf8');
    fs.writeFileSync(path.join(dir, 'after'), newText, 'utf8');
    fs.writeFileSync(path.join(dir, 'change.diff'), diff.lines.join('\n'), 'utf8');
    const session = {
      id,
      file: target,
      relative: path.relative(process.cwd(), target),
      existed,
      description: description ? String(description).slice(0, 2000) : null,
      requestedBy,
      verify,
      verifier: verifierFor(target, verify) ? `${(verifierFor(target, verify) || {}).command} ${((verifierFor(target, verify) || {}).args || []).join(' ')}` : 'none',
      added: diff.added,
      removed: diff.removed,
      status: 'staged',
      createdAt: this.now(),
      verification: null,
      appliedAt: null,
      backup: null,
    };
    return this.persist(session);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error(`no patch ${id}`), { code: 'NOT_FOUND' });
    return session;
  }

  diff(id) {
    const session = this.get(id);
    return fs.readFileSync(path.join(this.stagedDir(session.id), 'change.diff'), 'utf8');
  }

  list({ limit = 50, status = null } = {}) {
    return [...this.sessions.values()]
      .filter((session) => (status ? session.status === status : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  /**
   * Copies the project into `destination` and places the staged candidate at
   * the same relative path. Excludes VCS data, build output and dependency
   * trees (node_modules is symlinked so the copy reuses installed packages
   * without duplicating or writing to them). Bounded: a project that does not
   * fit is refused, never verified in place.
   */
  isolateProject(session, destination, { maxFiles = 6000, maxBytes = 96 * 1024 * 1024 } = {}) {
    const EXCLUDE = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.venv', '__pycache__', '.cache', '.arena', '.DS_Store']);
    let root = path.dirname(session.file);
    for (let up = 0; up < 8; up += 1) {
      if (fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, '.git'))) break;
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    const relative = path.relative(root, session.file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, code: 'ISOLATION_UNAVAILABLE', message: 'the patch target is outside any project root' };
    }
    const stats = { files: 0, bytes: 0 };
    const copyDir = (from, to, depth) => {
      if (depth > 12) return;
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (EXCLUDE.has(entry.name)) continue;
        if (entry.name.endsWith('.sentinel-backup') || entry.name.includes('.sentinel-backup-')) continue;
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const link = fs.readlinkSync(source);
            fs.symlinkSync(link, target);
          } catch {
            /* an unreadable link is skipped, not fatal */
          }
          continue;
        }
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          copyDir(source, target, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const size = fs.statSync(source).size;
        stats.files += 1;
        stats.bytes += size;
        if (stats.files > maxFiles || stats.bytes > maxBytes) throw Object.assign(new Error(`project is larger than the isolation limit (${stats.files} files, ${stats.bytes} bytes)`), { code: 'ISOLATION_TOO_LARGE' });
        fs.copyFileSync(source, target);
      }
    };
    try {
      copyDir(root, destination, 0);
    } catch (err) {
      fs.rmSync(destination, { recursive: true, force: true });
      return { ok: false, code: err.code || 'ISOLATION_FAILED', message: err.message };
    }
    const modules = path.join(root, 'node_modules');
    if (fs.existsSync(modules)) {
      try {
        fs.symlinkSync(modules, path.join(destination, 'node_modules'), 'dir');
      } catch {
        /* package resolution will explain itself if this fails */
      }
    }
    // The candidate goes in after the copy so it always wins.
    const targetFile = path.join(destination, relative);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(path.join(this.stagedDir(session.id), 'after'), targetFile);
    for (const dir of ['home', 'tmp', 'sentinel-home']) fs.mkdirSync(path.join(destination, dir), { recursive: true });
    return { ok: true, root: destination, mode: 'copy', files: stats.files, bytes: stats.bytes, projectRoot: root, relative, excluded: [...EXCLUDE] };
  }

  /** Runs the whitelisted verifier in an isolated copy of the candidate file. */
  verify(id) {
    const session = this.get(id);
    if (session.status === 'applied') throw Object.assign(new Error('this patch is already applied'), { code: 'ALREADY_APPLIED' });
    const verifier = verifierFor(session.file, session.verify);
    if (!verifier) {
      session.verification = { ok: true, skipped: true, reason: 'no verifier for this file type', at: this.now(), ms: 0 };
      session.status = 'verified';
      this.persist(session);
      return session.verification;
    }
    const started = this.now();
    // Bind verification to immutable content: the candidate the tests ran and
    // the baseline that was on disk. A later edit to either invalidates it.
    const candidateText = fs.readFileSync(path.join(this.stagedDir(session.id), 'after'), 'utf8');
    session.hashes = {
      candidate: sha256(candidateText),
      baseline: fs.existsSync(session.file) ? sha256(fs.readFileSync(session.file, 'utf8')) : null,
      at: this.now(),
    };
    const workspace = path.join(this.stagedDir(session.id), 'workspace');
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const candidateName = path.basename(session.file);
    let isolation = { mode: 'file', root: workspace, files: 1, bytes: 0 };
    let cwd = workspace;
    let args;
    if (session.verify === 'test') {
      // 4.0: tests run against a full copy of the project. The user's workspace
      // is opened read-only: not even a temporary swap of the candidate file.
      // If the copy cannot be made inside the limits, verification fails
      // honestly instead of silently falling back to the live tree.
      const isolated = this.isolateProject(session, workspace);
      if (!isolated.ok) {
        session.verification = { ok: false, code: isolated.code, message: isolated.message, ms: this.now() - started, at: this.now(), isolated: true };
        session.status = 'failed';
        this.persist(session);
        return session.verification;
      }
      isolation = isolated;
      cwd = isolated.root;
      args = verifier.args;
    } else {
      const candidate = path.join(workspace, candidateName);
      fs.copyFileSync(path.join(this.stagedDir(session.id), 'after'), candidate);
      isolation.bytes = fs.statSync(candidate).size;
      args = [...verifier.args, candidateName];
    }
    let result;
    try {
      result = this.runner(verifier.command, args, {
        cwd,
        timeoutMs: Number((this.config && this.config.get && this.config.get('ai.limits.toolTimeoutMs')) || 120000),
        env: {
          PATH: process.env.PATH,
          NO_COLOR: '1',
          CI: '1',
          SENTINEL_TEST_SANDBOX: '1',
          ...(session.verify === 'test' ? { HOME: path.join(workspace, 'home'), TMPDIR: path.join(workspace, 'tmp'), SENTINEL_HOME: path.join(workspace, 'sentinel-home') } : {}),
        },
      });
    } finally {
      if (session.verify === 'test') fs.rmSync(workspace, { recursive: true, force: true });
    }
    const ms = this.now() - started;
    if (result.error) {
      session.verification = { ok: false, code: 'VERIFIER_FAILED', message: result.error.message, ms, at: this.now() };
      session.status = 'failed';
      this.persist(session);
      return session.verification;
    }
    const ok = result.status === 0;
    session.verification = {
      ok,
      code: ok ? null : 'VERIFICATION_FAILED',
      output: String(`${result.stdout || ''}${result.stderr || ''}`).slice(0, 4000),
      ms,
      at: this.now(),
      command: `${verifier.command} ${verifier.args.join(' ')}`,
      isolated: true,
      isolation: { mode: isolation.mode, files: isolation.files, bytes: isolation.bytes, excluded: isolation.excluded || [] },
    };
    session.status = ok ? 'verified' : 'failed';
    this.persist(session);
    return session.verification;
  }

  /** Applies a verified patch. Refuses unverified patches and keeps a backup. */
  apply(id, { approved = false, approvedBy = null } = {}) {
    const session = this.get(id);
    if (session.status === 'applied') throw Object.assign(new Error('this patch is already applied'), { code: 'ALREADY_APPLIED' });
    if (!approved) throw Object.assign(new Error('a staged patch needs an approval before it is written'), { code: 'APPROVAL_REQUIRED' });
    if (!session.verification || !session.verification.ok) throw Object.assign(new Error('the patch has not passed verification'), { code: 'UNVERIFIED' });
    const target = session.file;
    const staged = fs.readFileSync(path.join(this.stagedDir(session.id), 'after'), 'utf8');
    if (session.hashes) {
      if (sha256(staged) !== session.hashes.candidate) throw Object.assign(new Error('the verified candidate changed on disk; verify it again'), { code: 'STALE_VERIFICATION', hash: 'candidate' });
      const current = fs.existsSync(target) ? sha256(fs.readFileSync(target, 'utf8')) : null;
      if (current !== session.hashes.baseline) throw Object.assign(new Error('the target file changed after verification; the patch was not applied'), { code: 'STALE_VERIFICATION', hash: 'baseline' });
    }
    let backup = null;
    if (fs.existsSync(target)) {
      backup = `${target}.sentinel-backup-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, backup);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    const content = fs.readFileSync(path.join(this.stagedDir(session.id), 'after'), 'utf8');
    fs.writeFileSync(target, content, 'utf8');
    session.status = 'applied';
    session.appliedAt = this.now();
    session.approvedBy = approvedBy;
    session.backup = backup;
    this.persist(session);
    if (this.log) this.log.info('patch', `applied ${session.id} to ${target}${backup ? ` (backup ${backup})` : ''}`);
    return { ok: true, id: session.id, file: target, backup, bytes: Buffer.byteLength(content) };
  }

  /** Post-apply check: the file on disk must equal the verified candidate. */
  confirm(id) {
    const session = this.get(id);
    if (session.status !== 'applied') return { ok: false, code: 'NOT_APPLIED' };
    const expected = fs.readFileSync(path.join(this.stagedDir(session.id), 'after'), 'utf8');
    const actual = fs.readFileSync(session.file, 'utf8');
    return { ok: expected === actual, file: session.file, bytes: Buffer.byteLength(actual) };
  }

  discard(id) {
    const session = this.get(id);
    if (session.status === 'applied') throw Object.assign(new Error('an applied patch is history; revert it with its backup'), { code: 'ALREADY_APPLIED' });
    fs.rmSync(this.stagedDir(id), { recursive: true, force: true });
    session.status = 'discarded';
    session.discardedAt = this.now();
    this.persist(session);
    return { ok: true, id };
  }

  stats() {
    const sessions = [...this.sessions.values()];
    const byStatus = {};
    for (const session of sessions) byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    return { total: sessions.length, byStatus, root: this.root() };
  }
}

module.exports = { PatchManager, diffLines, verifierFor, VERIFIERS };
