'use strict';

/**
 * Repository map and lightweight code intelligence.
 *
 * No parser is invented here. The map is built from bounded regex extraction of
 * declarations and imports across known languages, then verified by reading the
 * files. It answers three questions honestly: where is a symbol declared, what
 * would a change touch, and which tests are closest to a file. It never claims
 * type inference it does not have.
 */

const fs = require('node:fs');
const path = require('node:path');

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.venv', '__pycache__', 'coverage', '.cache']);
const LANGUAGES = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
  '.cs': 'csharp',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.html': 'html',
  '.css': 'css',
  '.md': 'markdown',
};
const SYMBOL_PATTERNS = {
  javascript: [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /(?:^|\n)\s*module\.exports\s*=/g,
  ],
  typescript: [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g,
  ],
  python: [
    /(?:^|\n)\s*def\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g,
  ],
  c: [/(?:^|\n)\s*(?:static\s+)?[A-Za-z_][\w\s*]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/g, /(?:^|\n)\s*(?:struct|enum)\s+([A-Za-z_]\w*)/g],
  cpp: [/(?:^|\n)\s*(?:class|struct)\s+([A-Za-z_]\w*)/g, /(?:^|\n)\s*[A-Za-z_][\w:<>*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/g],
  java: [/(?:^|\n)\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/g, /(?:^|\n)\s*(?:public|private|protected)\s+[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(/g],
  csharp: [/(?:^|\n)\s*(?:public|internal|private)?\s*(?:static\s+)?(?:sealed\s+)?class\s+([A-Za-z_]\w*)/g, /(?:^|\n)\s*(?:public|private|protected|internal)\s+[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(/g],
  powershell: [/(?:^|\n)\s*function\s+([A-Za-z-][\w-]*)/g, /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g],
};
const IMPORT_PATTERNS = {
  javascript: [/(?:require\(|from\s+|import\()['"]([^'"]+)['"]/g],
  typescript: [/(?:require\(|from\s+)['"]([^'"]+)['"]/g],
  python: [/(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g],
  powershell: [/(?:^|\n)\s*\.\s+['"]([^'"]+)['"]/g],
  c: [/(?:^|\n)\s*#include\s+["<]([^">]+)[">]/g],
  cpp: [/(?:^|\n)\s*#include\s+["<]([^">]+)[">]/g],
};

function isTestPath(file) {
  return /(^|[\\/])(test|tests|spec|__tests__|e2e)([\\/]|$)/i.test(file) || /\.(test|spec)\.[a-z]+$/i.test(file) || /^test-[^/]+\.py$/i.test(path.basename(file));
}

class RepoMap {
  constructor({ root, log = null, maxFiles = 5000, maxFileBytes = 1024 * 1024, now = () => Date.now() } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.log = log;
    this.maxFiles = Math.max(1, Math.min(20000, maxFiles));
    this.maxFileBytes = maxFileBytes;
    this.now = now;
    this.map = null;
    this.truncated = false;
  }

  walk(dir = this.root, depth = 0) {
    const files = [];
    if (depth > 20) return files;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= this.maxFiles) {
        this.truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
        files.push(...this.walk(full, depth + 1));
        continue;
      }
      if (!entry.isFile()) continue;
      const language = LANGUAGES[path.extname(entry.name).toLowerCase()];
      if (!language) continue;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > this.maxFileBytes) continue;
      files.push({ file: full, relative: path.relative(this.root, full).split(path.sep).join('/'), language, bytes: stat.size, mtime: stat.mtimeMs });
    }
    return files;
  }

  symbolsIn(text, language) {
    const symbols = [];
    for (const pattern of SYMBOL_PATTERNS[language] || []) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        if (!match[1]) continue;
        symbols.push({ name: match[1], line: text.slice(0, match.index).split('\n').length });
      }
    }
    const seen = new Set();
    return symbols.filter((symbol) => {
      const key = `${symbol.name}:${symbol.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  importsIn(text, language) {
    const out = new Set();
    for (const pattern of IMPORT_PATTERNS[language] || []) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const value = match[1] || match[2];
        if (value) out.add(value.replace(/^['"]|['"]$/g, ''));
      }
    }
    return [...out];
  }

  /** Builds (or rebuilds) the map. Bounded by file count and file size. */
  scan() {
    this.truncated = false;
    const started = this.now();
    const entries = [];
    for (const file of this.walk()) {
      let text = '';
      try {
        text = fs.readFileSync(file.file, 'utf8');
      } catch {
        continue;
      }
      entries.push({
        ...file,
        lines: text.split('\n').length,
        symbols: this.symbolsIn(text, file.language),
        imports: this.importsIn(text, file.language),
        tests: isTestPath(file.relative),
      });
    }
    const languages = {};
    const directories = {};
    for (const entry of entries) {
      languages[entry.language] = (languages[entry.language] || 0) + 1;
      const dir = entry.relative.includes('/') ? entry.relative.slice(0, entry.relative.lastIndexOf('/')) : '.';
      directories[dir] = (directories[dir] || 0) + 1;
    }
    this.map = {
      root: this.root,
      entries,
      languages,
      directories,
      entrypoints: entries.filter((entry) => /^(bin|src|desktop|app|index|main|server)[^/]*\//.test(entry.relative) && /(index|main|server|agent|app)\./.test(entry.relative)).slice(0, 20).map((entry) => entry.relative),
      tests: entries.filter((entry) => entry.tests).map((entry) => entry.relative),
      truncated: this.truncated,
      scannedAt: this.now(),
      ms: this.now() - started,
    };
    return this.summary();
  }

  ensure() {
    if (!this.map) this.scan();
    return this.map;
  }

  summary() {
    const map = this.ensure();
    return {
      root: map.root,
      files: map.entries.length,
      lines: map.entries.reduce((sum, entry) => sum + entry.lines, 0),
      symbols: map.entries.reduce((sum, entry) => sum + entry.symbols.length, 0),
      languages: map.languages,
      directories: Object.entries(map.directories).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([dir, files]) => ({ dir, files })),
      entrypoints: map.entrypoints,
      tests: map.tests.length,
      truncated: map.truncated,
      ms: map.ms,
      scannedAt: new Date(map.scannedAt).toISOString(),
      honest: 'Declarations and imports are extracted lexically; this is not a type-aware parser.',
    };
  }

  search(query, { limit = 20 } = {}) {
    const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_.$/-]+/u).filter(Boolean);
    if (!terms.length) return { query, matches: [] };
    const map = this.ensure();
    const matches = [];
    for (const entry of map.entries) {
      const pathScore = terms.reduce((sum, term) => sum + (entry.relative.toLowerCase().includes(term) ? 2 : 0), 0);
      for (const symbol of entry.symbols) {
        const name = symbol.name.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (name === term ? 5 : name.includes(term) ? 3 : 0), 0) + pathScore;
        if (score > 0) matches.push({ file: entry.relative, symbol: symbol.name, line: symbol.line, language: entry.language, score });
      }
      if (pathScore > 0 && !entry.symbols.length) matches.push({ file: entry.relative, symbol: null, line: null, language: entry.language, score: pathScore });
    }
    matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return { query, matches: matches.slice(0, Math.max(1, Math.min(100, limit))) };
  }

  /** Files that import the target, plus symbol references across the map. */
  impact({ file = null, symbol = null, limit = 50 } = {}) {
    const map = this.ensure();
    if (!file && !symbol) return { ok: false, code: 'NOTHING_TO_TRACE' };
    const target = file ? map.entries.find((entry) => entry.relative === file || entry.relative.endsWith(`/${file}`)) : null;
    if (file && !target) return { ok: false, code: 'NOT_FOUND', message: `${file} is not in the map` };
    const stem = target ? path.basename(target.relative, path.extname(target.relative)) : null;
    const dependents = [];
    for (const entry of map.entries) {
      if (target && entry.relative === target.relative) continue;
      const importsTarget = stem && entry.imports.some((value) => value.includes(stem) || (target && value.includes(path.basename(target.relative))));
      if (importsTarget) dependents.push({ file: entry.relative, reason: 'imports' });
    }
    const references = [];
    if (symbol) {
      const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      for (const entry of map.entries) {
        if (target && entry.relative === target.relative) continue;
        let text = '';
        try {
          text = fs.readFileSync(entry.file, 'utf8');
        } catch {
          continue;
        }
        const count = (text.match(pattern) || []).length;
        if (count) references.push({ file: entry.relative, count });
      }
    }
    return {
      ok: true,
      file: target ? target.relative : null,
      symbol,
      dependents: dependents.slice(0, limit),
      references: references.sort((a, b) => b.count - a.count).slice(0, limit),
      tests: target ? this.testsFor(target.relative).tests : [],
      note: 'Dependents are import-site matches; references are textual symbol matches.',
    };
  }

  testsFor(file, { limit = 20 } = {}) {
    const map = this.ensure();
    const target = map.entries.find((entry) => entry.relative === file || entry.relative.endsWith(`/${file}`));
    if (!target) return { file, tests: [] };
    const stem = path.basename(target.relative, path.extname(target.relative));
    const tests = map.entries
      .filter((entry) => entry.tests)
      .map((entry) => {
        let text = '';
        try {
          text = fs.readFileSync(entry.file, 'utf8');
        } catch {
          return null;
        }
        const score = (text.includes(stem) ? 3 : 0) + (entry.relative.includes(stem) ? 2 : 0) + (target.language === entry.language ? 1 : 0);
        return score > 1 ? { file: entry.relative, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return { file: target.relative, tests: tests.slice(0, limit) };
  }

  status() {
    return this.map ? { ...this.summary(), cached: true } : { root: this.root, cached: false, files: 0 };
  }
}

module.exports = { RepoMap, LANGUAGES, isTestPath };
