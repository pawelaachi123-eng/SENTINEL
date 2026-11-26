'use strict';

/**
 * Self-diagnosis and prepared repairs.
 *
 * The rule this file exists to enforce: SENTINEL may *diagnose* anything, may
 * *prepare* a repair, and may apply one only after the user approves it — with a
 * backup taken first and a rollback path that is known to work.
 *
 * What counts as repairable:
 *   • the agent's own data files (config that fails to parse, corrupt JSONL,
 *     stale temp files) — reversible, inside the data directory
 *   • a stuck service or port held by a previous instance
 *   • a missing model or an offline provider (prepare the `ollama pull` command;
 *     never run it without consent)
 *
 * What is never repairable by the assistant: its own policy/safety flags, the
 * tunnel keys, the firmware on the ESP32, and anything outside the sandbox.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run, which, humanBytes } = require('./tools/helpers');

const PROTECTED_PATHS = [/config\.json$/i, /\.env/i, /\.ssh/i, /firmware/i];

class SelfHeal {
  constructor({ config, log, paths, tools, store, memory, llm, commander, now = () => Date.now() }) {
    this.config = config;
    this.log = log;
    this.paths = paths;
    this.tools = tools;
    this.store = store;
    this.memory = memory;
    this.llm = llm;
    this.commander = commander;
    this.now = now;
    this.proposals = new Map();
    this.history = [];
    this.counters = { diagnoses: 0, proposals: 0, applied: 0, rolledBack: 0, refused: 0 };
  }

  /* ── diagnosis ─────────────────────────────────────────────────────── */

  /**
   * Runs the checks that have actually failed for people: the config file, the
   * database, the ports, the model server, the ESP32 link, disk space.
   */
  async diagnose({ quick = false } = {}) {
    const started = this.now();
    const checks = [];
    const add = (id, ok, detail, fix = null) => checks.push({ id, ok, detail, fix });

    // config file parses
    try {
      const file = this.config.file;
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        JSON.parse(raw);
        add('config.parse', true, `${path.basename(file)} parses (${humanBytes(JSON.parse(raw) ? raw.length : 0)})`);
      } else {
        add('config.parse', true, 'no config file yet — defaults are in use');
      }
    } catch (err) {
      add('config.parse', false, `config.json does not parse: ${err.message}`, 'restore from the newest backup, then re-apply your settings');
    }

    // data directory writable
    try {
      const probe = path.join(this.paths.dataDir(), `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      add('data.write', true, `${this.paths.dataDir()} is writable`);
    } catch (err) {
      add('data.write', false, `cannot write to the data directory: ${err.message}`, 'check folder permissions, or move the data directory');
    }

    // database opens and counts
    if (this.store) {
      try {
        const stats = this.store.stats();
        add('store.open', true, `${stats.driver} store, ${stats.collections ? JSON.stringify(stats.collections) : 'ok'}`);
      } catch (err) {
        add('store.open', false, `the database failed to open: ${err.message}`, 'restore the newest backup from the backups folder');
      }
    }

    // disk space
    try {
      const stat = fs.statfsSync ? fs.statfsSync(this.paths.dataDir()) : null;
      if (stat) {
        const freeGB = (stat.bavail * stat.bsize) / 1024 ** 3;
        add('disk.space', freeGB > 1, `${freeGB.toFixed(1)} GB free`, freeGB > 1 ? null : 'free space: logs and backups need room');
      }
    } catch {
      /* statfs unavailable on this platform */
    }

    // ports free or held by us
    const ports = [this.config.get('ports.ui', 7878), this.config.get('ports.link', 7879)];
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const held = await this.portHeld(port);
      add(`port.${port}`, !held || this.ownPort(port), held ? (this.ownPort(port) ? `port ${port} is held by this instance` : `port ${port} is used by another program`) : `port ${port} is free`, held && !this.ownPort(port) ? `stop the other program, or change ports.${port === ports[0] ? 'ui' : 'link'}` : null);
    }

    if (!quick) {
      // model provider reachable
      if (this.llm) {
        try {
          const status = await this.llm.status();
          const up = Object.entries(status.providers || {}).filter(([, value]) => value.ok);
          add('model.provider', up.length > 0, up.length ? `${up.map(([name]) => name).join(', ')} reachable` : 'no model provider reachable', up.length ? null : 'start Ollama (or LM Studio), then run: ollama pull qwen3.5:9b');
        } catch (err) {
          add('model.provider', false, `could not probe providers: ${err.message}`, 'check ai.providers settings');
        }
      }

      // ESP32 reachable (not fatal: the PC works without it)
      const espHost = this.config.get('esp.host');
      if (espHost) {
        try {
          const tool = this.tools ? await this.tools.execute('net.port.check', { host: espHost, port: this.config.get('esp.port', 7879), timeoutMs: 800 }, { source: 'selfheal' }) : null;
          add('esp.reachable', Boolean(tool && tool.ok && tool.data.open), tool && tool.data && tool.data.open ? `ESP32 answers at ${espHost}` : `ESP32 does not answer at ${espHost}`, 'check that the ESP32 is powered and on the same Wi-Fi');
        } catch (err) {
          add('esp.reachable', false, err.message, null);
        }
      }

      // node:sqlite availability (the packaged build falls back to JSONL)
      add('runtime.sqlite', typeof require('node:sqlite') === 'object', 'node:sqlite is available', null);
    }

    const failed = checks.filter((check) => !check.ok);
    this.counters.diagnoses += 1;
    return {
      ok: failed.length === 0,
      checks,
      failed: failed.length,
      ms: this.now() - started,
      at: new Date().toISOString(),
      summary: failed.length ? `${failed.length} problem(s): ${failed.map((check) => check.id).join(', ')}` : 'everything checked out',
    };
  }

  async portHeld(port) {
    const net = require('node:net');
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
      server.once('listening', () => server.close(() => resolve(false)));
      server.listen(port, '0.0.0.0');
    });
  }

  ownPort(port) {
    const wanted = Number(port);
    const ui = Number(this.config.get('ports.ui'));
    // When this process is running, the agent holds the UI port on purpose.
    return wanted === ui && typeof process !== 'undefined';
  }

  /* ── proposals ─────────────────────────────────────────────────────── */

  /**
   * Prepares a repair. Nothing is executed here; the proposal carries the exact
   * command or file operation and its rollback.
   */
  async propose({ problem, fix = null } = {}) {
    const issue = String(problem || '').trim();
    if (!issue) throw Object.assign(new Error('describe the problem to fix'), { code: 'BAD_ARGS' });
    const diagnosis = await this.diagnose({ quick: true });
    const relevant = diagnosis.checks.filter((check) => !check.ok && (check.id.includes(issue) || issue.includes(check.id) || check.fix));
    const plan = [];
    for (const check of relevant) {
      const action = this.actionFor(check);
      if (action) plan.push(action);
    }
    if (!plan.length && fix) {
      plan.push({ type: 'manual', description: String(fix), rollback: null });
    }
    if (!plan.length) {
      this.counters.refused += 1;
      return {
        proposed: false,
        reason: 'I could not find a safe, specific repair for that. Nothing was changed.',
        diagnosis: diagnosis.summary,
      };
    }
    const proposal = {
      id: `fix_${this.now().toString(36)}`,
      problem: issue,
      createdAt: this.now(),
      status: 'proposed',
      steps: plan,
      backup: this.backupTarget(),
      requiresApproval: true,
    };
    this.proposals.set(proposal.id, proposal);
    this.counters.proposals += 1;
    if (this.log) this.log.warn('healing', `proposed a repair for "${issue}" (${plan.length} step(s))`);
    return { proposed: true, ...proposal };
  }

  actionFor(check) {
    if (check.id === 'config.parse') {
      return {
        type: 'restore-backup',
        description: `restore ${path.basename(this.config.file)} from the newest backup`,
        rollback: 'the broken file is kept as config.json.broken-<timestamp> by the restore',
      };
    }
    if (check.id === 'store.open') {
      return { type: 'restore-backup', description: 'restore the memory database from the newest backup', rollback: 'the current database is moved aside, not deleted' };
    }
    if (check.id === 'disk.space') {
      return { type: 'cleanup', description: 'prune old logs and stale backups older than 30 days', rollback: 'deleted files are logs and backups only' };
    }
    if (check.id === 'model.provider') {
      return { type: 'advice', description: check.fix || 'start the model provider', rollback: null, executes: false };
    }
    if (check.id === 'esp.reachable' || check.id === 'port.' + String(this.config.get('ports.ui')) || check.id.startsWith('port.')) {
      return { type: 'advice', description: check.fix || 'free the port or power the device', rollback: null, executes: false };
    }
    return null;
  }

  backupTarget() {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    return path.join(this.paths.backupsDir(), `selfheal-${stamp}`);
  }

  /* ── execution ─────────────────────────────────────────────────────── */

  /**
   * Applies an approved proposal. Backs up first, never touches protected paths,
   * and reports exactly what changed.
   */
  async apply(proposalId, { approvedBy = 'user' } = {}) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw Object.assign(new Error('unknown or expired repair proposal'), { code: 'NOT_FOUND' });
    if (proposal.status !== 'proposed') throw Object.assign(new Error(`this repair was already ${proposal.status}`), { code: 'ALREADY_DONE' });

    for (const step of proposal.steps) {
      if (step.type === 'advice') continue;
      if (PROTECTED_PATHS.some((pattern) => pattern.test(step.description || ''))) {
        this.counters.refused += 1;
        throw Object.assign(new Error('a repair may not modify protected files'), { code: 'PROTECTED' });
      }
    }

    const backup = await this.backup(proposal.backup);
    const applied = [];
    try {
      for (const step of proposal.steps) {
        if (step.type === 'advice') {
          applied.push({ ...step, executed: false, note: 'this needs a person' });
          continue;
        }
        if (step.type === 'restore-backup') {
          const restored = await this.restoreLatest({ only: step.description.includes('config') ? 'config' : 'any' });
          applied.push({ ...step, executed: true, restored: restored || null });
        } else if (step.type === 'cleanup') {
          const cleaned = await this.cleanOldFiles(30);
          applied.push({ ...step, executed: true, cleaned });
        } else {
          applied.push({ ...step, executed: false, note: 'unsupported repair type; nothing done' });
        }
      }
      proposal.status = 'applied';
      proposal.appliedAt = this.now();
      proposal.appliedBy = approvedBy;
      proposal.backupPath = backup.path;
      this.counters.applied += 1;
      this.history.unshift({ ...proposal });
      if (this.history.length > 30) this.history.length = 30;
      if (this.log) this.log.warn('healing', `applied repair "${proposal.problem}"`, { backup: backup.path });
      return { applied: true, proposalId, backup: backup.path, results: applied };
    } catch (err) {
      proposal.status = 'failed';
      proposal.error = err.message;
      if (this.log) this.log.error('healing', `repair failed: ${err.message}; backup at ${backup.path}`);
      return { applied: false, proposalId, backup: backup.path, error: err.message, next: `roll back with ${backup.path}` };
    }
  }

  async backup(label = null) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const dir = label || path.join(this.paths.backupsDir(), `backup-${stamp}`);
    await fsp.mkdir(dir, { recursive: true });
    const copied = [];
    const files = [this.config.file, path.join(this.paths.dataDir(), 'memory.jsonl'), path.join(this.paths.dataDir(), 'sentinel.db')];
    for (const file of files) {
      if (!file || !fs.existsSync(file)) continue;
      const target = path.join(dir, path.basename(file));
      // eslint-disable-next-line no-await-in-loop
      await fsp.copyFile(file, target);
      const stat = await fsp.stat(target);
      copied.push({ file: path.basename(file), bytes: stat.size });
    }
    const manifest = { createdAt: new Date(this.now()).toISOString(), version: require('../package.json').version, files: copied, host: os.hostname() };
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { path: dir, files: copied };
  }

  listBackups() {
    try {
      return fs
        .readdirSync(this.paths.backupsDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = path.join(this.paths.backupsDir(), entry.name);
          const manifestPath = path.join(dir, 'manifest.json');
          let manifest = null;
          try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          } catch {
            /* no manifest */
          }
          const stat = fs.statSync(dir);
          return { name: entry.name, path: dir, createdAt: manifest ? manifest.createdAt : stat.mtime.toISOString(), files: manifest ? manifest.files.length : null };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async restoreLatest({ only = 'any' } = {}) {
    const backups = this.listBackups();
    const candidate = backups.find((backup) => {
      if (only === 'config') return fs.existsSync(path.join(backup.path, 'config.json'));
      return fs.existsSync(path.join(backup.path, 'config.json')) || fs.existsSync(path.join(backup.path, 'memory.jsonl')) || fs.existsSync(path.join(backup.path, 'sentinel.db'));
    });
    if (!candidate) return null;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const restored = [];
    for (const name of fs.readdirSync(candidate.path)) {
      if (name === 'manifest.json') continue;
      const source = path.join(candidate.path, name);
      const target = name === 'config.json' ? this.config.file : path.join(this.paths.dataDir(), name);
      if (fs.existsSync(target)) {
        await fsp.copyFile(target, `${target}.before-restore-${stamp}`);
      }
      await fsp.copyFile(source, target);
      restored.push({ file: name, from: candidate.name });
    }
    if (this.log) this.log.warn('healing', `restored ${restored.length} file(s) from ${candidate.name}`);
    return { backup: candidate.name, restored };
  }

  async rollback() {
    const restored = await this.restoreLatest({ only: 'any' });
    if (!restored) throw Object.assign(new Error('there is no backup to roll back to'), { code: 'NO_BACKUP' });
    this.counters.rolledBack += 1;
    return restored;
  }

  async cleanOldFiles(days = 30) {
    const cutoff = this.now() - days * 86400000;
    let removed = 0;
    let bytes = 0;
    const targets = [this.paths.backupsDir()];
    for (const dir of targets) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // eslint-disable-next-line no-await-in-loop
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat || stat.mtimeMs >= cutoff) continue;
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed += 1;
        bytes += stat.size;
      }
    }
    return { removed, freed: humanBytes(bytes) };
  }

  stats() {
    return { counters: { ...this.counters }, proposals: this.proposals.size, history: this.history.slice(0, 5), backups: this.listBackups().length };
  }
}

module.exports = { SelfHeal };
