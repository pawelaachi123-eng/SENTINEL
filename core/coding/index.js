'use strict';

/**
 * Code intelligence over parser ASTs.
 *
 * The index is built from `parsers.js` ASTs, not from regular expressions over
 * raw text. It provides symbol search, references, imports, dependency and call
 * graphs, impact analysis, static bug localisation, test proposals and a
 * transactional multi-file rename.
 *
 * Honest scope: the parsers cover practical subsets of the listed languages.
 * A construct the parser does not understand fails loudly at that file; it is
 * never silently indexed as if it were understood.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse, tokenize, walk, detectLanguage, fail } = require('./parsers');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'target', 'out', 'coverage', '__pycache__', '.venv', 'venv', '.cache', '.arena', '.pytest_cache', '.ruff_cache']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isInside(root, candidate) {
  const resolved = path.resolve(candidate);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function walkFiles(root, { maxFiles = MAX_FILES, maxFileBytes = MAX_FILE_BYTES, extensions = null } = {}) {
  const files = [];
  const skipped = [];
  const visit = (directory, depth) => {
    if (files.length >= maxFiles || depth > 20) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (err) { skipped.push({ path: directory, reason: err.code || 'unreadable' }); return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skipped.push({ path: full, reason: 'symlink not followed' }); continue; }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = detectLanguage(full);
      if (!language) continue;
      if (extensions && !extensions.includes(language)) continue;
      let stat;
      try { stat = fs.lstatSync(full); } catch { skipped.push({ path: full, reason: 'stat failed' }); continue; }
      if (stat.size > maxFileBytes) { skipped.push({ path: full, reason: `larger than ${maxFileBytes} bytes` }); continue; }
      if (!isInside(root, full)) { skipped.push({ path: full, reason: 'outside root' }); continue; }
      files.push(full);
    }
  };
  visit(root, 0);
  return { files, skipped, truncated: files.length >= maxFiles };
}

class CodeIndex {
  constructor({ root, log = null, maxFiles = MAX_FILES, now = () => Date.now() } = {}) {
    if (!root) throw fail('CodeIndex needs a root', 1, 1, 'BAD_ARGUMENT');
    this.root = path.resolve(root);
    this.log = log;
    this.maxFiles = maxFiles;
    this.now = now;
    this.files = new Map();
    this.symbols = new Map();
    this.imports = new Map();
    this.calls = new Map();
    this.skipped = [];
    this.lastScan = null;
  }

  relative(file) { return path.relative(this.root, path.resolve(file)).split(path.sep).join('/'); }

  indexFile(file, { source = null } = {}) {
    const absolute = path.resolve(file);
    if (!isInside(this.root, absolute)) throw fail(`${file} is outside the index root`, 1, 1, 'OUTSIDE_ROOT');
    const language = detectLanguage(absolute);
    if (!language) throw fail(`no parser for ${file}`, 1, 1, 'UNSUPPORTED_LANGUAGE');
    let text = source;
    if (text == null) {
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_FILE_BYTES) throw fail(`${file} is too large to index`, 1, 1, 'TOO_LARGE');
      text = fs.readFileSync(absolute, 'utf8');
    }
    let ast;
    try {
      ast = parse(text, { file: absolute, language });
    } catch (err) {
      this.files.set(absolute, { file: absolute, relative: this.relative(absolute), language, error: { code: err.code, message: err.message, line: err.line, column: err.column }, indexedAt: this.now(), sha256: hash(text) });
      throw err;
    }
    const record = {
      file: absolute,
      relative: this.relative(absolute),
      language,
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
      lines: text.split('\n').length,
      symbols: [],
      references: [],
      imports: [],
      calls: [],
      ast,
      error: null,
      indexedAt: this.now(),
    };
    const definitions = [];
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration') definitions.push({ name: node.name, kind: 'function', line: node.line, endLine: node.endLine || node.line, exported: Boolean(node.exported), params: (node.params || []).map((param) => param.name) });
      if (node.type === 'ClassDeclaration') {
        definitions.push({ name: node.name, kind: 'class', line: node.line, endLine: node.endLine || node.line, exported: Boolean(node.exported), parent: node.parent || null });
        for (const method of node.methods || []) definitions.push({ name: `${node.name}.${method.name}`, kind: 'method', line: method.line, endLine: method.endLine || method.line, exported: false, owner: node.name, static: Boolean(method.static) });
      }
      if (node.type === 'VariableDeclaration') definitions.push({ name: node.name, kind: 'variable', line: node.line, endLine: node.line, exported: Boolean(node.exported), inferred: node.init ? node.init.type : null });
      if (node.type === 'ImportDeclaration') {
        for (const specifier of node.specifiers || []) definitions.push({ name: specifier, kind: 'import', line: node.line, endLine: node.line, exported: false, from: node.source });
        record.imports.push({ source: node.source, specifiers: node.specifiers || [], line: node.line, kind: node.type });
      }
      if (node.type === 'SqlStatement') {
        for (const table of node.tables || []) record.imports.push({ source: table, specifiers: [], line: node.line, kind: `sql:${node.kind}:table` });
        for (const column of node.columns || []) definitions.push({ name: column.split('.').pop(), kind: 'column', line: node.line, endLine: node.line, exported: false });
      }
      if (node.type === 'Expression') {
        for (const identifier of node.identifiers || []) record.references.push({ name: identifier.name, line: identifier.line, column: identifier.column });
        for (const match of String(node.text || '').matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) record.imports.push({ source: match[1], specifiers: [], line: node.line, kind: 'require' });
        for (const match of String(node.text || '').matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) record.imports.push({ source: match[1], specifiers: [], line: node.line, kind: 'dynamic-import' });
      }
      if (node.type === 'ArrowFunctionExpression') {
        definitions.push({ name: null, kind: 'arrow', line: node.line, endLine: node.endLine || node.line, exported: false });
      }
    });
    if (language === 'javascript' || language === 'typescript') {
      const tokens = ast.tokens || [];
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === 'identifier' && !['function', 'class', 'const', 'let', 'var', 'import'].includes(token.value)) {
          if (tokens[index + 1] && tokens[index + 1].value === '(' && !['if', 'for', 'while', 'switch', 'catch'].includes(token.value)) record.calls.push({ name: token.value, line: token.line, column: token.column });
        }
      }
    } else if (language === 'python') {
      for (const line of text.split('\n')) {
        for (const match of line.matchAll(/([A-Za-z_]\w*)\s*\(/g)) if (!['def', 'class', 'if', 'for', 'while', 'with', 'elif', 'except'].includes(match[1])) record.calls.push({ name: match[1], line: 1, column: match.index + 1 });
      }
    } else if (language !== 'sql') {
      const tokens = ast.tokens || [];
      for (let index = 0; index < tokens.length; index += 1) if (tokens[index].type === 'identifier' && tokens[index + 1] && tokens[index + 1].value === '(') record.calls.push({ name: tokens[index].value, line: tokens[index].line, column: tokens[index].column });
    }
    record.symbols = definitions;
    for (const definition of definitions) {
      if (!definition.name) continue;
      if (!this.symbols.has(definition.name)) this.symbols.set(definition.name, []);
      this.symbols.get(definition.name).push({ ...definition, file: record.relative });
    }
    this.imports.set(record.relative, record.imports);
    this.calls.set(record.relative, record.calls);
    this.files.set(absolute, record);
    return record;
  }

  scan({ files = null } = {}) {
    const started = this.now();
    this.files.clear();
    this.symbols.clear();
    this.imports.clear();
    this.calls.clear();
    const found = files ? { files: files.map((file) => path.resolve(file)), skipped: [], truncated: false } : walkFiles(this.root, { maxFiles: this.maxFiles });
    this.skipped = found.skipped;
    const errors = [];
    for (const file of found.files) {
      try { this.indexFile(file); } catch (err) { errors.push({ file: this.relative(file), code: err.code, message: err.message, line: err.line, column: err.column }); }
    }
    this.lastScan = { at: this.now(), files: this.files.size, errors: errors.length, skipped: this.skipped.length, ms: this.now() - started, truncated: found.truncated };
    if (this.log) this.log.info('coding', `indexed ${this.files.size} files (${errors.length} errors) in ${this.lastScan.ms} ms`);
    return { ...this.lastScan, errors, skipped: this.skipped.slice(0, 30) };
  }

  ensure() { if (!this.lastScan) this.scan(); return this; }

  search(query, { limit = 20 } = {}) {
    this.ensure();
    const wanted = String(query || '').toLowerCase();
    if (!wanted) return [];
    return [...this.symbols.entries()]
      .filter(([name]) => Boolean(name))
      .map(([name, definitions]) => ({ name, definitions, score: name.toLowerCase() === wanted ? 10 : name.toLowerCase().includes(wanted) ? 5 : wanted.includes(name.toLowerCase()) ? 2 : 0 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  definition(name) {
    this.ensure();
    return this.symbols.get(String(name)) || [];
  }

  references(name, { limit = 100 } = {}) {
    this.ensure();
    const wanted = String(name);
    const out = [];
    for (const record of this.files.values()) {
      if (record.error) continue;
      for (const reference of record.references) if (reference.name === wanted) out.push({ file: record.relative, line: reference.line, column: reference.column });
      for (const call of record.calls) if (call.name === wanted) out.push({ file: record.relative, line: call.line, column: call.column, kind: 'call' });
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  impact({ file = null, symbol = null, depth = 3 } = {}) {
    this.ensure();
    const start = file ? [this.relative(file)] : symbol ? this.definition(symbol).map((entry) => entry.file) : [];
    const visited = new Set(start);
    let frontier = start;
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next = [];
      for (const target of frontier) {
        const targetStem = path.basename(target).replace(/\.[^.]+$/, '');
        for (const [candidate, imports] of this.imports) {
          if (visited.has(candidate)) continue;
          if (imports.some((entry) => entry.source && path.basename(String(entry.source)).replace(/\.[^.]+$/, '') === targetStem)) {
            visited.add(candidate);
            next.push(candidate);
          }
        }
        if (symbol) for (const reference of this.references(symbol, { limit: 200 })) {
          if (!visited.has(reference.file)) { visited.add(reference.file); next.push(reference.file); }
        }
      }
      frontier = next;
    }
    return { start, files: [...visited], depth, reason: symbol ? `references to ${symbol}` : 'imports' };
  }

  callGraph() {
    this.ensure();
    const nodes = new Set();
    const edges = [];
    for (const [file, calls] of this.calls) {
      for (const call of calls) {
        nodes.add(call.name);
        if (this.symbols.has(call.name)) edges.push({ from: file, to: this.symbols.get(call.name)[0].file, symbol: call.name, line: call.line });
      }
    }
    return { nodes: [...nodes].sort(), edges };
  }

  testsFor(file, { limit = 20 } = {}) {
    this.ensure();
    const relative = this.relative(file);
    const stem = path.basename(relative, path.extname(relative));
    return [...this.files.values()]
      .filter((record) => /(^|\/)(test|tests|spec|__tests__)\//.test(record.relative) || /\.(test|spec)\./.test(record.relative))
      .filter((record) => record.relative.includes(stem))
      .slice(0, limit)
      .map((record) => ({ file: record.relative, symbols: record.symbols.map((symbol) => symbol.name).filter(Boolean).slice(0, 20) }));
  }

  /** Static rules with evidence. Not a proof of absence. */
  bugs({ file = null, limit = 100 } = {}) {
    this.ensure();
    const files = file ? [path.resolve(file)] : [...this.files.keys()];
    const findings = [];
    const add = (relative, line, rule, severity, message, evidence) => findings.push({ file: relative, line, rule, severity, message, evidence: String(evidence).trim().slice(0, 160) });
    for (const target of files) {
      const record = this.files.get(target);
      if (!record || record.error) continue;
      let text;
      try { text = fs.readFileSync(target, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const at = index + 1;
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/\beval\s*\(/.test(line)) add(record.relative, at, 'unsafe-eval', 'high', 'eval executes arbitrary input', line);
        if (/new\s+Function\s*\(/.test(line)) add(record.relative, at, 'unsafe-eval', 'high', 'the Function constructor executes a string', line);
        if (/\bchild_process\b|\.exec\s*\(|\.execSync\s*\(/.test(line) && /(`|\+|\$\{)/.test(line)) add(record.relative, at, 'command-injection', 'high', 'shell command built from interpolation', line);
        if (/\b(exec|execSync|spawn)\s*\(/.test(line) && /req\.|request\.|user|input/.test(line)) add(record.relative, at, 'command-injection', 'high', 'shell command built from request data', line);
        if (/(SELECT|INSERT|UPDATE|DELETE)[^;\n]*(\+|\$\{)/i.test(line)) add(record.relative, at, 'sql-injection', 'high', 'SQL statement built by concatenation', line);
        if (/\b(strcpy|strcat|sprintf|gets)\s*\(/.test(line) && !/(sizeof|snprintf)/.test(line)) add(record.relative, at, 'unsafe-c', 'medium', 'unbounded C string operation', line);
        if (/\b(os\.system|subprocess\.[a-z_]+\([^)]*shell\s*=\s*True|pickle\.loads)\b/.test(line)) add(record.relative, at, 'unsafe-python', 'high', 'shell execution or unsafe deserialisation', line);
        if (/\bInvoke-Expression\b|\biex\b/i.test(line)) add(record.relative, at, 'unsafe-powershell', 'high', 'PowerShell expression execution', line);
        if (/\.innerHTML\s*=/.test(line) && !/textContent/.test(line)) add(record.relative, at, 'dom-xss', 'medium', 'innerHTML assignment can inject markup', line);
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /except[^:]*:\s*pass\b/.test(line)) add(record.relative, at, 'empty-catch', 'medium', 'errors are silently swallowed', line);
        if (/[^=!<>]==[^=]/.test(line) && !/^\s*\/\//.test(trimmed)) add(record.relative, at, 'loose-equality', 'low', 'loose equality performs coercion', line);
        if (/TODO|FIXME|XXX/.test(line)) add(record.relative, at, 'todo', 'info', 'unfinished work marker', line);
        if (/(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line) && !/process\.env|os\.environ|example|placeholder/i.test(line)) add(record.relative, at, 'hardcoded-secret', 'high', 'literal credential in source', line.replace(/[:=]\s*['"][^'"]+['"]/, '= <redacted>'));
        if (/Math\.random\s*\(/.test(line) && /(token|secret|password|nonce|salt)/i.test(line)) add(record.relative, at, 'weak-randomness', 'medium', 'Math.random is not a cryptographic source', line);
        if (/\.\.\/|\.\.\\/.test(line) && /(readFile|writeFile|open|include|require)/.test(line)) add(record.relative, at, 'path-traversal', 'medium', 'path traversal sequence in a file operation', line);
      });
      if (findings.length >= limit) break;
    }
    return findings.sort((a, b) => ({ high: 0, medium: 1, low: 2, info: 3 }[a.severity] - { high: 0, medium: 1, low: 2, info: 3 }[b.severity])).slice(0, limit);
  }

  /** Deterministic test skeletons for public functions; never claims they pass. */
  proposeTests({ file = null, limit = 20 } = {}) {
    this.ensure();
    const targets = file ? [this.files.get(path.resolve(file))] : [...this.files.values()];
    const proposals = [];
    for (const record of targets) {
      if (!record || record.error) continue;
      for (const symbol of record.symbols) {
        if (!symbol.name || !['function', 'method'].includes(symbol.kind)) continue;
        if (symbol.name.includes('.')) continue;
        proposals.push({
          file: record.relative,
          symbol: symbol.name,
          params: symbol.params || [],
          suggestion: [
            `test('${symbol.name}: rejects malformed input', () => {`,
            `  assert.throws(() => ${symbol.name}(${symbol.params.map(() => 'null').join(', ') || 'null'}));`,
            '});',
            `test('${symbol.name}: returns a value for valid input', () => {`,
            `  const result = ${symbol.name}(${symbol.params.map(() => '/* valid fixture */').join(', ')});`,
            '  assert.notStrictEqual(result, undefined);',
            '});',
          ].join('\n'),
        });
        if (proposals.length >= limit) return proposals;
      }
    }
    return proposals;
  }

  stats() {
    this.ensure();
    const languages = {};
    let errorFiles = 0;
    for (const record of this.files.values()) {
      languages[record.language] = (languages[record.language] || 0) + 1;
      if (record.error) errorFiles += 1;
    }
    return {
      root: this.root,
      files: this.files.size,
      symbols: [...this.symbols.values()].reduce((sum, entries) => sum + entries.length, 0),
      uniqueSymbols: this.symbols.size,
      languages,
      errorFiles,
      imports: [...this.imports.values()].reduce((sum, entries) => sum + entries.length, 0),
      calls: [...this.calls.values()].reduce((sum, entries) => sum + entries.length, 0),
      skipped: this.skipped.length,
      lastScan: this.lastScan,
    };
  }
}

/* ── transactional refactoring ───────────────────────────────────────── */

function patchHash(patches) {
  const canonical = patches.map((patch) => ({ file: patch.file, beforeSha: patch.beforeSha, afterSha: patch.afterSha })).sort((a, b) => a.file.localeCompare(b.file));
  return hash(JSON.stringify(canonical));
}

function verifyProposals(patches) {
  const errors = [];
  for (const patch of patches) {
    if (!patch.file || patch.afterText == null) { errors.push({ file: patch.file, code: 'BAD_PATCH' }); continue; }
    try { parse(patch.afterText, { file: patch.file }); } catch (err) { errors.push({ file: patch.file, code: err.code, message: err.message, line: err.line, column: err.column }); }
  }
  return { ok: errors.length === 0, errors };
}

class RefactorEngine {
  constructor({ index, log = null, now = () => Date.now(), runner = null } = {}) {
    this.index = index;
    this.log = log;
    this.now = now;
    this.runner = runner;
  }

  /** Token-exact rename. Strings and comments are not touched by the lexer. */
  rename({ symbol, to, files = null, limit = 500 } = {}) {
    if (!/^[A-Za-z_$][\w$]*$/.test(String(symbol || ''))) throw fail('rename needs a simple identifier', 1, 1, 'BAD_SYMBOL');
    if (!/^[A-Za-z_$][\w$]*$/.test(String(to || ''))) throw fail('new name must be a simple identifier', 1, 1, 'BAD_NAME');
    if (symbol === to) throw fail('new name is identical', 1, 1, 'NO_CHANGE');
    this.index.ensure();
    const targets = files ? files.map((file) => this.index.files.get(path.resolve(file))).filter(Boolean) : [...this.index.files.values()];
    const patches = [];
    for (const record of targets) {
      if (record.error) continue;
      const text = fs.readFileSync(record.file, 'utf8');
      let tokens;
      try { tokens = tokenize(text, record.language); } catch { continue; }
      const replacements = tokens.filter((token) => token.type === 'identifier' && token.value === symbol).map((token) => ({ start: token.start, end: token.end }));
      if (!replacements.length) continue;
      let after = text;
      for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index];
        after = `${after.slice(0, replacement.start)}${to}${after.slice(replacement.end)}`;
      }
      patches.push({ file: record.relative, absolute: record.file, beforeText: text, afterText: after, beforeSha: hash(text), afterSha: hash(after), replacements: replacements.length });
      if (patches.length >= limit) break;
    }
    const verification = verifyProposals(patches.map((patch) => ({ ...patch, file: patch.absolute })));
    return { ok: verification.ok, symbol, to, patches, files: patches.length, replacements: patches.reduce((sum, patch) => sum + patch.replacements, 0), verification, approvalHash: patchHash(patches) };
  }

  /** Applies verified patches only when the approval hash matches exactly. */
  apply(patches, { approvedBy = null, approvalHash = null } = {}) {
    if (!approvedBy || !approvalHash) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'a hash-bound human approval is required' };
    if (approvalHash !== patchHash(patches)) return { ok: false, code: 'APPROVAL_MISMATCH', message: 'the approved patch set differs from the requested one' };
    for (const patch of patches) {
      const absolute = patch.absolute || path.resolve(this.index.root, patch.file);
      if (!isInside(this.index.root, absolute)) return { ok: false, code: 'OUTSIDE_ROOT', file: patch.file };
      const current = fs.readFileSync(absolute, 'utf8');
      if (hash(current) !== patch.beforeSha) return { ok: false, code: 'STALE_PATCH', file: patch.file, message: 'the file changed after the patch was prepared' };
    }
    const verification = verifyProposals(patches.map((patch) => ({ ...patch, file: patch.absolute || path.resolve(this.index.root, patch.file) })));
    if (!verification.ok) return { ok: false, code: 'VERIFICATION_FAILED', verification };
    const backups = [];
    const written = [];
    try {
      for (const patch of patches) {
        const absolute = patch.absolute || path.resolve(this.index.root, patch.file);
        const backup = `${absolute}.sentinel-bak-${this.now()}`;
        fs.copyFileSync(absolute, backup);
        backups.push({ absolute, backup });
        fs.writeFileSync(absolute, patch.afterText);
        written.push(absolute);
      }
      this.index.scan();
      return { ok: true, files: written.map((file) => this.index.relative(file)), backups: backups.map((entry) => entry.backup), approvedBy, approvalHash };
    } catch (err) {
      for (const entry of backups.reverse()) {
        try { fs.copyFileSync(entry.backup, entry.absolute); } catch { /* leave the backup for manual recovery */ }
      }
      return { ok: false, code: 'APPLY_FAILED', message: err.message, rolledBack: true };
    }
  }

  /** Copies the affected files into a temporary tree and verifies them there. */
  verifyIsolated(patches) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-refactor-'));
    const written = [];
    try {
      for (const patch of patches) {
        const absolute = patch.absolute || path.resolve(this.index.root, patch.file);
        const relative = this.index.relative(absolute);
        const destination = path.join(directory, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, patch.afterText);
        written.push({ relative, destination });
      }
      const verification = verifyProposals(written.map((entry) => ({ file: entry.destination, afterText: fs.readFileSync(entry.destination, 'utf8') })));
      return { ok: verification.ok, errors: verification.errors, files: written.map((entry) => entry.relative), isolated: true, directory };
    } finally {
      if (!process.env.SENTINEL_KEEP_REFACTOR_TEMP) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { CodeIndex, RefactorEngine, walkFiles, verifyProposals, patchHash, isInside };
