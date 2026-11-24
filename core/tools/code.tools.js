'use strict';

/**
 * Code and Git tools.
 *
 * The analysis here is honest about being heuristic: symbols come from
 * language-shaped regexes, not a parser, and every result says which language
 * it understood. That is enough to answer "where is this function", "what does
 * this project depend on" and "what did the last commit change" without adding
 * a compiler toolchain to the install.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { run, readTextFile, walk, globToRegExp, truncate, humanBytes, IS_WINDOWS } = require('./helpers');

const LANGUAGES = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.ino': 'arduino',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sh': 'shell',
  '.ps1': 'powershell',
  '.sql': 'sql',
};

const SYMBOL_PATTERNS = {
  javascript: [
    { kind: 'class', regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: 'method', regex: /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
    { kind: 'export', regex: /^\s*module\.exports\s*=/ },
  ],
  python: [
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  ],
  csharp: [
    { kind: 'class', regex: /^\s*(?:public|internal|private|abstract|sealed|static|partial|\s)*class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', regex: /^\s*(?:public|internal)?\s*interface\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:public|private|protected|internal|static|async|override|virtual|\s)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*$/ },
  ],
  arduino: [
    { kind: 'function', regex: /^(?:void|int|bool|float|String|uint\d+_t|size_t|static\s+\w+)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/ },
    { kind: 'struct', regex: /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
  ],
  c: [
    { kind: 'function', regex: /^(?:static\s+)?(?:void|int|bool|float|double|char|size_t|uint\d+_t|[\w*]+)\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/ },
    { kind: 'struct', regex: /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', regex: /^type\s+([A-Za-z_]\w*)/ },
  ],
  rust: [
    { kind: 'function', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', regex: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: 'class', regex: /^\s*(?:public|private|protected)?\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:public|private|protected)\s+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
};
SYMBOL_PATTERNS.typescript = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.cpp = SYMBOL_PATTERNS.c;

function languageOf(file) {
  return LANGUAGES[path.extname(file).toLowerCase()] || null;
}

function extractSymbols(text, language) {
  const patterns = SYMBOL_PATTERNS[language] || SYMBOL_PATTERNS.javascript;
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) return;
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match && match[1] && match[1].length > 1) {
        out.push({ kind: pattern.kind, name: match[1], line: index + 1 });
        break;
      }
    }
  });
  return out;
}

function extractExports(text, language) {
  const names = new Set();
  const patterns = language === 'python'
    ? [/^__all__\s*=\s*\[([^\]]+)\]/m, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm]
    : [/module\.exports\s*=\s*\{([^}]+)\}/g, /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, /^export\s*\{([^}]+)\}/gm];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const body = match[1] || '';
      body
        .split(',')
        .map((part) => part.trim().split(/[\s:]/)[0])
        .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part))
        .forEach((name) => names.add(name));
    }
  }
  return [...names].slice(0, 100);
}

function extractImports(text, language) {
  const out = new Set();
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /^\s*(?:using|#include)\s*[<"]([^>"]+)[>"]/gm,
    /^\s*use\s+([a-zA-Z0-9_:]+)/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) out.add(match[1]);
  }
  return [...out].slice(0, 80);
}

/** Extracts a function/class body by name using brace (or indent) matching. */
function extractFunction(text, name, language) {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) =>
    new RegExp(`(?:function|def|class|func|fn|void|int|const|let|var|public|private|protected|static)[^\\n]*\\b${name}\\b`).test(line) ||
    new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`).test(line),
  );
  if (startIndex === -1) return null;
  if (language === 'python') {
    const indent = lines[startIndex].match(/^\s*/)[0].length;
    let end = startIndex + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      if (!line.trim()) continue;
      if (line.match(/^\s*/)[0].length <= indent) break;
    }
    return { startLine: startIndex + 1, endLine: end, text: lines.slice(startIndex, end).join('\n') };
  }
  let depth = 0;
  let seenBrace = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === '{') {
        depth += 1;
        seenBrace = true;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (seenBrace && depth <= 0) {
      return { startLine: startIndex + 1, endLine: index + 1, text: lines.slice(startIndex, index + 1).join('\n') };
    }
    if (!seenBrace && index > startIndex + 30) return { startLine: startIndex + 1, endLine: index + 1, text: lines.slice(startIndex, index + 1).join('\n') };
  }
  return { startLine: startIndex + 1, endLine: lines.length, text: lines.slice(startIndex).join('\n') };
}

async function git(args, { repo = '.', timeout = 20000, signal = null } = {}) {
  const result = await run('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { timeout, signal });
  return result;
}

module.exports = [
  {
    name: 'code.symbols',
    title: 'Find symbols',
    description: 'Classes, functions, methods and structs in one file or a directory (JS/TS/Python/C#/C/Arduino/Go/Rust/Java).',
    category: 'code',
    permission: 'read',
    tags: ['code', 'symbols', 'functions'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
        kind: { type: 'string', enum: ['all', 'function', 'class', 'method', 'struct', 'interface', 'type'], default: 'all' },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const stat = await fsp.stat(args.path);
      const files = stat.isDirectory() ? await walk(args.path, { maxFiles: 400 }) : [args.path];
      const symbols = [];
      for (const file of files) {
        const language = languageOf(file);
        if (!language) continue;
        const info = await readTextFile(file, { maxBytes: 300000 }).catch(() => null);
        if (!info) continue;
        for (const symbol of extractSymbols(info.text, language)) {
          if (args.kind !== 'all' && symbol.kind !== args.kind) continue;
          symbols.push({ ...symbol, file: path.relative(args.path, file) || path.basename(file), language });
          if (symbols.length >= args.limit) break;
        }
        if (symbols.length >= args.limit) break;
      }
      return { path: args.path, count: symbols.length, symbols };
    },
    format: (data) => data.symbols.map((symbol) => `${symbol.file}:${symbol.line}  ${symbol.kind} ${symbol.name}`).join('\n'),
  },
  {
    name: 'code.function',
    title: 'Read one function',
    description: 'Extract a function or class body by name, with line numbers.',
    category: 'code',
    permission: 'read',
    tags: ['code', 'function', 'read'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path' },
        name: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['path', 'name'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const language = languageOf(args.path) || 'javascript';
      const info = await readTextFile(args.path, { maxBytes: 1000000 });
      const found = extractFunction(info.text, args.name, language);
      if (!found) throw Object.assign(new Error(`${args.name} not found in ${path.basename(args.path)}`), { code: 'NOT_FOUND' });
      return { file: args.path, language, name: args.name, startLine: found.startLine, endLine: found.endLine, lines: found.endLine - found.startLine + 1, text: truncate(found.text, 20000) };
    },
    format: (data) => `// ${data.file}:${data.startLine} (${data.name}, ${data.language})\n${data.text}`,
  },
  {
    name: 'code.file.summary',
    title: 'Summarise a source file',
    description: 'Language, size, imports, exports and symbols of one file.',
    category: 'code',
    permission: 'read',
    tags: ['code', 'summary'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const language = languageOf(args.path) || 'text';
      const info = await readTextFile(args.path, { maxBytes: 2000000 });
      const lines = info.text.split(/\r?\n/);
      return {
        file: args.path,
        language,
        bytes: info.bytes,
        lines: lines.length,
        blankLines: lines.filter((line) => !line.trim()).length,
        imports: extractImports(info.text, language),
        exports: extractExports(info.text, language),
        symbols: extractSymbols(info.text, language).slice(0, 80),
        header: truncate(lines.slice(0, 20).join('\n'), 1200),
      };
    },
  },
  {
    name: 'code.project.map',
    title: 'Map a project',
    description: 'Directory layout, languages, file counts and entry points for a codebase.',
    category: 'code',
    permission: 'read',
    tags: ['project', 'structure', 'languages'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        maxFiles: { type: 'integer', default: 2000, minimum: 10, maximum: 8000 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const files = await walk(args.path, { maxFiles: args.maxFiles, maxDepth: 10 });
      const langs = {};
      const dirs = {};
      const entries = [];
      for (const file of files) {
        const relative = path.relative(args.path, file);
        const language = languageOf(file) || 'other';
        langs[language] = (langs[language] || 0) + 1;
        const top = relative.split(path.sep)[0];
        dirs[top] = (dirs[top] || 0) + 1;
        if (/^(index|main|app|server|bootstrap|program)\.(js|ts|py|cs|go|ino)$/i.test(path.basename(file))) entries.push(relative);
      }
      return {
        path: args.path,
        files: files.length,
        languages: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        topLevel: Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
        entryPoints: entries.slice(0, 20),
      };
    },
    format(data) {
      return [
        `${data.files} files in ${data.path}`,
        `languages: ${data.languages.map((l) => `${l.name} ${l.count}`).join(', ')}`,
        `top level: ${data.topLevel.map((d) => `${d.name}(${d.count})`).join(', ')}`,
        `entry points: ${data.entryPoints.join(', ') || 'none found'}`,
      ].join('\n');
    },
  },
  {
    name: 'code.stats',
    title: 'Lines of code',
    description: 'File count, total lines and per-language breakdown, excluding build folders.',
    category: 'code',
    permission: 'read',
    tags: ['loc', 'stats', 'code size'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' }, maxFiles: { type: 'integer', default: 3000, minimum: 10, maximum: 10000 } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const files = await walk(args.path, { maxFiles: args.maxFiles, maxDepth: 12 });
      const perLanguage = {};
      let totalLines = 0;
      let totalCode = 0;
      let totalBytes = 0;
      let parsed = 0;
      for (const file of files) {
        const language = languageOf(file) || 'other';
        if (language === 'other') continue;
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat || stat.size > 2_000_000) continue;
        const info = await readTextFile(file, { maxBytes: 2_000_000 }).catch(() => null);
        if (!info) continue;
        parsed += 1;
        const lines = info.text.split(/\r?\n/);
        const code = lines.filter((line) => line.trim() && !/^\s*(\/\/|#(?!include)|--|\*)/.test(line)).length;
        const entry = perLanguage[language] || { files: 0, lines: 0, code: 0, bytes: 0 };
        entry.files += 1;
        entry.lines += lines.length;
        entry.code += code;
        entry.bytes += info.bytes;
        perLanguage[language] = entry;
        totalLines += lines.length;
        totalCode += code;
        totalBytes += info.bytes;
      }
      return {
        path: args.path,
        analysedFiles: parsed,
        totalLines,
        codeLines: totalCode,
        bytes: totalBytes,
        size: humanBytes(totalBytes),
        languages: Object.entries(perLanguage).sort((a, b) => b[1].lines - a[1].lines).map(([name, value]) => ({ name, ...value })),
      };
    },
    format: (data) =>
      `${data.analysedFiles} files, ${data.totalLines} lines (${data.codeLines} code, ${data.size})\n` +
      data.languages.map((l) => `  ${l.name}: ${l.lines} lines in ${l.files} files`).join('\n'),
  },
  {
    name: 'code.todo',
    title: 'Find TODOs',
    description: 'TODO/FIXME/HACK/XXX comments with file and line.',
    category: 'code',
    permission: 'read',
    tags: ['todo', 'fixme', 'comments'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        limit: { type: 'integer', default: 60, minimum: 1, maximum: 300 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const files = await walk(args.path, { maxFiles: 2000 });
      const found = [];
      for (const file of files) {
        if (!languageOf(file) && !/\.(md|txt|ino)$/i.test(file)) continue;
        const info = await readTextFile(file, { maxBytes: 300000 }).catch(() => null);
        if (!info) continue;
        info.text.split(/\r?\n/).forEach((line, index) => {
          const match = line.match(/\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.*)/i);
          if (match && found.length < args.limit) {
            found.push({ file: path.relative(args.path, file), line: index + 1, tag: match[1].toUpperCase(), text: truncate(match[2].trim(), 200) });
          }
        });
        if (found.length >= args.limit) break;
      }
      return { count: found.length, items: found };
    },
    format: (data) => data.items.map((item) => `${item.tag} ${item.file}:${item.line} ${item.text}`).join('\n') || 'nothing pending',
  },
  {
    name: 'code.dependencies',
    title: 'Project dependencies',
    description: 'Declared dependencies from package.json, requirements.txt, pyproject.toml, .csproj, platformio.ini or pubspec.yaml.',
    category: 'code',
    permission: 'read',
    tags: ['dependencies', 'npm', 'pip', 'nuget'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const result = { manifests: [], dependencies: [], devDependencies: [] };
      const check = async (name, handler) => {
        try {
          const info = await readTextFile(path.join(args.path, name), { maxBytes: 400000 });
          handler(info.text);
          result.manifests.push(name);
        } catch {
          /* not present */
        }
      };
      await check('package.json', (text) => {
        const parsed = JSON.parse(text);
        result.dependencies.push(...Object.entries(parsed.dependencies || {}).map(([name, version]) => ({ name, version, from: 'package.json' })));
        result.devDependencies.push(...Object.entries(parsed.devDependencies || {}).map(([name, version]) => ({ name, version, from: 'package.json' })));
        if (parsed.scripts) result.scripts = parsed.scripts;
      });
      await check('requirements.txt', (text) => {
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
          .forEach((line) => {
            const [name, version] = line.split(/[=<>]=?/);
            result.dependencies.push({ name: name.trim(), version: (version || '').trim(), from: 'requirements.txt' });
          });
      });
      await check('pyproject.toml', (text) => {
        const block = (text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
        block
          .split('\n')
          .map((line) => (line.match(/["']([^"']+)["']/) || [])[1])
          .filter(Boolean)
          .forEach((spec) => {
            const [name, version] = spec.split(/[=<>!~]=?/);
            result.dependencies.push({ name: name.trim(), version: version || '', from: 'pyproject.toml' });
          });
      });
      await check('platformio.ini', (text) => {
        const lines = text.match(/lib_deps\s*=\s*([\s\S]*?)(?=\n\w+\s*=|$)/);
        if (lines) {
          lines[1]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((line) => result.dependencies.push({ name: line, version: '', from: 'platformio.ini' }));
        }
      });
      await check('pubspec.yaml', (text) => {
        const block = text.split(/^dependencies:\s*$/m)[1] || '';
        block
          .split(/^\S/m)[0]
          .split('\n')
          .map((line) => line.match(/^\s{2}([a-z0-9_]+):\s*(.*)$/))
          .filter(Boolean)
          .forEach((match) => result.dependencies.push({ name: match[1], version: match[2], from: 'pubspec.yaml' }));
      });
      if (result.manifests.length === 0) {
        return { ...result, note: `no dependency manifest found in ${args.path}` };
      }
      return { ...result, counts: { dependencies: result.dependencies.length, dev: result.devDependencies.length } };
    },
    format(data) {
      if (data.note) return data.note;
      return [
        `manifests: ${data.manifests.join(', ')}`,
        ...data.dependencies.slice(0, 60).map((dep) => `  ${dep.name} ${dep.version}`),
        data.devDependencies.length ? `dev: ${data.devDependencies.map((dep) => dep.name).join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'code.duplicates',
    title: 'Duplicate code blocks',
    description: 'Finds repeated 6-line blocks across source files (a cheap copy/paste detector).',
    category: 'code',
    permission: 'read',
    tags: ['duplication', 'refactor', 'quality'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        minLines: { type: 'integer', default: 6, minimum: 3, maximum: 20 },
        limit: { type: 'integer', default: 15, minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const files = await walk(args.path, { maxFiles: 800 });
      const seen = new Map();
      const blocks = [];
      for (const file of files) {
        if (!languageOf(file)) continue;
        const info = await readTextFile(file, { maxBytes: 400000 }).catch(() => null);
        if (!info) continue;
        const lines = info.text.split(/\r?\n/).map((line) => line.trim());
        for (let index = 0; index + args.minLines <= lines.length; index += 1) {
          const window = lines.slice(index, index + args.minLines);
          if (window.filter((line) => line.length > 3 && !/^[{}()[\];,]+$/.test(line)).length < args.minLines - 1) continue;
          const key = window.join('\n');
          if (key.replace(/[\s{}();,]/g, '').length < 60) continue;
          if (seen.has(key)) {
            const first = seen.get(key);
            if (blocks.length < args.limit * 3) blocks.push({ first, again: { file: path.relative(args.path, file), line: index + 1 }, lines: args.minLines });
          } else {
            seen.set(key, { file: path.relative(args.path, file), line: index + 1 });
          }
        }
      }
      return { scanned: files.length, duplicateBlocks: blocks.length, blocks: blocks.slice(0, args.limit) };
    },
    format(data) {
      if (!data.duplicateBlocks) return 'no duplicated blocks found';
      return `${data.duplicateBlocks} repeated blocks\n${data.blocks.map((b) => `${b.first.file}:${b.first.line} ≈ ${b.again.file}:${b.again.line} (${b.lines} lines)`).join('\n')}`;
    },
  },
  {
    name: 'git.status',
    title: 'Git status',
    description: 'Branch, staged/unstaged/untracked files and whether the tree is clean.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'status'],
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', default: '.' } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }],
    async run(args) {
      const output = await git(['status', '--porcelain=v1', '--branch'], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'not a git repository'), { code: 'GIT_ERROR' });
      const lines = output.stdout.split('\n').filter(Boolean);
      const branchLine = lines.shift() || '';
      const branch = branchLine.replace(/^##\s*/, '').split('...')[0].trim();
      const files = lines.map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));
      return {
        repo: args.repo,
        branch,
        ahead: (branchLine.match(/ahead (\d+)/) || [])[1] || null,
        behind: (branchLine.match(/behind (\d+)/) || [])[1] || null,
        clean: files.length === 0,
        files,
      };
    },
    format(data) {
      return `${data.branch}${data.clean ? ' — clean' : ` — ${data.files.length} changed`}\n${data.files.map((f) => `${f.status} ${f.file}`).join('\n')}`;
    },
  },
  {
    name: 'git.log',
    title: 'Git log',
    description: 'Recent commits with hash, author, date and subject.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'log', 'history'],
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', default: '.' },
        limit: { type: 'integer', default: 15, minimum: 1, maximum: 100 },
        path: { type: 'string', description: 'limit to a file or folder' },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }, { name: 'path', mode: 'read' }],
    async run(args) {
      const output = await git(['log', `-${args.limit}`, '--date=short', '--pretty=format:%h\t%ad\t%an\t%s', ...(args.path ? ['--', args.path] : [])], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'git log failed'), { code: 'GIT_ERROR' });
      const commits = output.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, ...subject] = line.split('\t');
          return { hash, date, author, subject: subject.join('\t') };
        });
      return { repo: args.repo, count: commits.length, commits };
    },
    format: (data) => data.commits.map((c) => `${c.hash} ${c.date} ${c.author}: ${c.subject}`).join('\n'),
  },
  {
    name: 'git.diff',
    title: 'Git diff',
    description: 'Working-tree, staged or commit-range diff with a summary of changed files.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'diff', 'changes'],
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', default: '.' },
        staged: { type: 'boolean', default: false },
        range: { type: 'string', description: 'e.g. HEAD~1..HEAD', maxLength: 120 },
        path: { type: 'string' },
        maxChars: { type: 'integer', default: 12000, minimum: 500, maximum: 60000 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }, { name: 'path', mode: 'read' }],
    async run(args) {
      const argv = ['diff', '--no-color'];
      if (args.staged) argv.push('--cached');
      if (args.range) argv.push(args.range);
      if (args.path) argv.push('--', args.path);
      const output = await git(argv, { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'git diff failed'), { code: 'GIT_ERROR' });
      const stat = await git(['diff', '--stat', ...argv.slice(1)], { repo: args.repo });
      const files = (output.stdout.match(/^diff --git a\/(.+?) b\//gm) || []).map((line) => line.replace(/^diff --git a\//, '').replace(/ b\/.*$/, ''));
      return {
        repo: args.repo,
        staged: Boolean(args.staged),
        files,
        added: (output.stdout.match(/^\+[^+]/gm) || []).length,
        removed: (output.stdout.match(/^-[^-]/gm) || []).length,
        stat: truncate(stat.stdout.trim(), 3000),
        diff: truncate(output.stdout, args.maxChars),
      };
    },
    format: (data) => `${data.stat}\n\n${data.diff}`,
  },
  {
    name: 'git.show',
    title: 'Show a commit',
    description: 'Metadata and unified patch for one git commit, for reviewing what changed without checking out the tree.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'commit'],
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', default: '.' },
        ref: { type: 'string', default: 'HEAD', maxLength: 120 },
        maxChars: { type: 'integer', default: 10000, minimum: 500, maximum: 60000 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }],
    async run(args) {
      const output = await git(['show', '--stat', '--no-color', args.ref], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || `no commit ${args.ref}`), { code: 'GIT_ERROR' });
      return { repo: args.repo, ref: args.ref, text: truncate(output.stdout, args.maxChars) };
    },
    format: (data) => data.text,
  },
  {
    name: 'git.branches',
    title: 'List branches',
    description: 'Local branches with the current one marked, plus remotes.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'branches'],
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', default: '.' }, includeRemotes: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }],
    async run(args) {
      const output = await git(['branch', '-vv', ...(args.includeRemotes ? ['-a'] : [])], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'git branch failed'), { code: 'GIT_ERROR' });
      const branches = output.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ current: line.startsWith('*'), name: line.replace(/^\*?\s*/, '').split(/\s+/)[0], detail: line.replace(/^\*?\s*\S+\s*/, '') }));
      return { branches };
    },
    format: (data) => data.branches.map((b) => `${b.current ? '*' : ' '} ${b.name}`).join('\n'),
  },
  {
    name: 'git.blame',
    title: 'Git blame',
    description: 'Who last touched each line of a file (with commit and date).',
    category: 'git',
    permission: 'read',
    tags: ['git', 'blame', 'history'],
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', default: '.' }, path: { type: 'string' }, limit: { type: 'integer', default: 60, minimum: 1, maximum: 400 } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'read' }, { name: 'path', mode: 'read' }],
    async run(args) {
      const output = await git(['blame', '--date=short', '--line-porcelain', args.path], { repo: args.repo, timeout: 30000 });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'git blame failed'), { code: 'GIT_ERROR' });
      const lines = [];
      let current = null;
      for (const line of output.stdout.split('\n')) {
        if (/^[0-9a-f]{40} /.test(line)) {
          current = { commit: line.slice(0, 8) };
        } else if (current && line.startsWith('author ')) current.author = line.slice(7);
        else if (current && line.startsWith('author-time ')) current.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
        else if (current && line.startsWith('\t')) {
          if (lines.length < args.limit) lines.push({ ...current, text: truncate(line.slice(1), 160) });
          current = null;
        }
      }
      return { path: args.path, lines };
    },
    format: (data) => data.lines.map((l) => `${l.commit} ${l.author} ${l.date} ${l.text}`).join('\n'),
  },
  {
    name: 'git.commit',
    title: 'Commit changes',
    description: 'Stage the given paths and create a commit. Requires approval.',
    category: 'git',
    permission: 'system',
    tags: ['git', 'commit'],
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', default: '.' },
        message: { type: 'string', minLength: 3, maxLength: 2000 },
        paths: { type: 'array', items: { type: 'string' }, default: [] },
        all: { type: 'boolean', default: false },
      },
      required: ['message'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'write' }],
    async run(args) {
      if (args.all) await git(['add', '-A'], { repo: args.repo });
      else if (args.paths && args.paths.length) await git(['add', '--', ...args.paths], { repo: args.repo });
      else throw Object.assign(new Error('give paths or set all:true'), { code: 'BAD_ARGS' });
      const output = await git(['commit', '-m', args.message], { repo: args.repo, timeout: 30000 });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || output.stdout.trim() || 'commit failed'), { code: 'GIT_ERROR' });
      const head = await git(['rev-parse', '--short', 'HEAD'], { repo: args.repo });
      return { committed: true, hash: head.stdout.trim(), output: truncate(output.stdout, 2000) };
    },
  },
  {
    name: 'git.branch.create',
    title: 'Create a branch',
    description: 'Create (and optionally switch to) a new branch. Requires approval.',
    category: 'git',
    permission: 'system',
    tags: ['git', 'branch'],
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', default: '.' }, name: { type: 'string', minLength: 1, maxLength: 120 }, checkout: { type: 'boolean', default: true } },
      required: ['name'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'write' }],
    async run(args) {
      if (!/^[A-Za-z0-9._/-]+$/.test(args.name) || args.name.includes('..')) {
        throw Object.assign(new Error('invalid branch name'), { code: 'BAD_ARGS' });
      }
      const output = await git([args.checkout ? 'checkout' : 'branch', '-b', args.name], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'could not create branch'), { code: 'GIT_ERROR' });
      return { branch: args.name, checkedOut: args.checkout };
    },
  },
  {
    name: 'git.remote',
    title: 'Remotes',
    description: 'Configured remotes and URLs, without touching credentials.',
    category: 'git',
    permission: 'read',
    tags: ['git', 'remote'],
    parameters: { type: 'object', properties: { repo: { type: 'string', default: '.' } }, additionalProperties: false },
    pathParams: [{ name: 'repo', mode: 'read' }],
    async run(args) {
      const output = await git(['remote', '-v'], { repo: args.repo });
      const remotes = output.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, url, kind] = line.split(/\s+/);
          return { name, url: url.replace(/\/\/[^@/]+@/, '//«credentials»@'), kind: (kind || '').replace(/[()]/g, '') };
        });
      return { remotes };
    },
    format: (data) => data.remotes.map((r) => `${r.name} ${r.url} (${r.kind})`).join('\n') || 'no remotes',
  },
  {
    name: 'git.stash',
    title: 'Stash / unstash',
    description: 'Stash current changes, list stashes, or pop the newest. Requires approval.',
    category: 'git',
    permission: 'system',
    tags: ['git', 'stash'],
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', default: '.' }, action: { type: 'string', enum: ['push', 'list', 'pop'], default: 'list' }, message: { type: 'string', maxLength: 200 } },
      required: ['action'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'repo', mode: 'write' }],
    async run(args) {
      if (args.action === 'list') {
        const output = await git(['stash', 'list'], { repo: args.repo });
        return { stashes: output.stdout.split('\n').filter(Boolean) };
      }
      const output = await git(args.action === 'push' ? ['stash', 'push', '-m', args.message || `sentinel ${new Date().toISOString()}`] : ['stash', 'pop'], { repo: args.repo });
      if (output.code !== 0) throw Object.assign(new Error(output.stderr.trim() || 'stash failed'), { code: 'GIT_ERROR' });
      return { action: args.action, output: truncate(output.stdout, 1000) };
    },
  },
];
