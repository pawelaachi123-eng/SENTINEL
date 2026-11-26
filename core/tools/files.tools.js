'use strict';

/**
 * File tools. Every path arrives already resolved by the sandbox, so these
 * functions only deal with content — no path arithmetic that could escape.
 *
 * Deletes are recoverable: `fs.delete` moves to the agent's trash directory and
 * `fs.restore` puts it back. A tool that permanently removes a file the model
 * mis-identified is not a tool we ship.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { readTextFile, humanBytes, truncate, walk, globToRegExp, hashFile, diffLines, decodeText } = require('./helpers');

const fail = (message, code) => Object.assign(new Error(message), { code });

async function statEntry(full, name) {
  const stat = await fsp.lstat(full);
  return {
    name: name || path.basename(full),
    type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file',
    bytes: stat.size,
    size: humanBytes(stat.size),
    modified: stat.mtime.toISOString(),
  };
}

function trashDir(ctx) {
  return path.join(ctx.paths.dataDir(), 'trash');
}

module.exports = [
  {
    name: 'fs.list',
    title: 'List a directory',
    description: 'Files and folders with sizes and modification times. Hidden entries are marked.',
    category: 'files',
    permission: 'read',
    tags: ['file', 'directory', 'ls'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 500 },
        sort: { type: 'string', enum: ['name', 'size', 'modified'], default: 'name' },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const entries = await fsp.readdir(args.path, { withFileTypes: true });
      const rows = [];
      for (const entry of entries.slice(0, 500)) {
        try {
          rows.push(await statEntry(path.join(args.path, entry.name), entry.name));
        } catch {
          /* vanished */
        }
      }
      if (args.sort === 'size') rows.sort((a, b) => b.bytes - a.bytes);
      else if (args.sort === 'modified') rows.sort((a, b) => b.modified.localeCompare(a.modified));
      else rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return { path: args.path, count: rows.length, entries: rows.slice(0, args.limit) };
    },
    format(data) {
      return `${data.path} (${data.count} entries)\n${data.entries
        .map((entry) => `${entry.type === 'dir' ? '📁' : '📄'} ${entry.name}${entry.type === 'dir' ? '/' : `  ${entry.size}`}`)
        .join('\n')}`;
    },
  },
  {
    name: 'fs.tree',
    title: 'Directory tree',
    description: 'Nested tree of a directory, skipping build/vendor folders.',
    category: 'files',
    permission: 'read',
    tags: ['tree', 'structure'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        depth: { type: 'integer', default: 3, minimum: 1, maximum: 8 },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const lines = [];
      const visit = async (dir, prefix, depth) => {
        if (depth > args.depth || lines.length >= args.limit) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const visible = entries
          .filter((entry) => !entry.name.startsWith('.'))
          .filter((entry) => !['node_modules', 'dist', 'build', 'out', 'target', '__pycache__', '.git'].includes(entry.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of visible) {
          if (lines.length >= args.limit) return;
          lines.push(`${prefix}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`);
          if (entry.isDirectory()) await visit(path.join(dir, entry.name), `${prefix}  `, depth + 1);
        }
      };
      lines.push(`📁 ${path.basename(args.path) || args.path}`);
      await visit(args.path, '  ', 1);
      return { root: args.path, lines, count: lines.length };
    },
    format: (data) => data.lines.join('\n'),
  },
  {
    name: 'fs.stat',
    title: 'File details',
    description: 'Existence, size, timestamps, permissions and type of a path.',
    category: 'files',
    permission: 'read',
    tags: ['file', 'stat', 'exists'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      try {
        const stat = await fsp.stat(args.path);
        return {
          path: args.path,
          exists: true,
          directory: stat.isDirectory(),
          bytes: stat.size,
          size: humanBytes(stat.size),
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
          mode: `0${(stat.mode & 0o777).toString(8)}`,
        };
      } catch (err) {
        if (err.code === 'ENOENT') return { path: args.path, exists: false };
        throw fail(err.message, 'STAT_FAILED');
      }
    },
  },
  {
    name: 'fs.read',
    title: 'Read a file',
    description: 'Read a text file, auto-detecting UTF-8/UTF-16/Windows-1250. Binary files are refused with a hint.',
    category: 'files',
    permission: 'read',
    tags: ['file', 'read', 'cat'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'integer', default: 200000, minimum: 100, maximum: 2000000 },
        fromLine: { type: 'integer', default: 1, minimum: 1 },
        lines: { type: 'integer', default: 0, minimum: 0, maximum: 20000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const decoded = await readTextFile(args.path, { maxBytes: args.maxBytes });
      if (decoded.text.includes('\u0000')) throw fail('this looks like a binary file; use a specialised tool', 'BINARY_FILE');
      let text = decoded.text;
      if (args.fromLine > 1 || args.lines > 0) {
        const all = text.split(/\r?\n/);
        const start = Math.min(args.fromLine - 1, all.length);
        const end = args.lines > 0 ? start + args.lines : all.length;
        text = all.slice(start, end).join('\n');
        return { path: args.path, encoding: decoded.encoding, bytes: decoded.bytes, truncated: false, fromLine: start + 1, toLine: Math.min(end, all.length), text };
      }
      return { path: args.path, encoding: decoded.encoding, bytes: decoded.bytes, truncated: decoded.truncated, text };
    },
    format: (data) => data.text,
  },
  {
    name: 'fs.search',
    title: 'Search inside files',
    description: 'Regex search across a directory or the workspace, with a glob filter. Returns file, line number and the matching line.',
    category: 'files',
    permission: 'read',
    tags: ['grep', 'search', 'find'],
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 300 },
        path: { type: 'string', default: '.' },
        glob: { type: 'string', default: '*', maxLength: 80 },
        maxResults: { type: 'integer', default: 40, minimum: 1, maximum: 200 },
        ignoreCase: { type: 'boolean', default: true },
        maxFileBytes: { type: 'integer', default: 400000, minimum: 1000, maximum: 4000000 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      let regex;
      try {
        regex = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
      } catch (err) {
        throw fail(`invalid pattern: ${err.message}`, 'BAD_PATTERN');
      }
      const glob = globToRegExp(args.glob);
      const files = await walk(args.path, { maxFiles: 1500, maxDepth: 9 });
      const matches = [];
      let scanned = 0;
      for (const file of files) {
        if (matches.length >= args.maxResults) break;
        if (!glob.test(path.basename(file))) continue;
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        if (stat.size > args.maxFileBytes) continue;
        let buffer;
        try {
          buffer = await fsp.readFile(file);
        } catch {
          continue;
        }
        if (buffer.includes(0)) continue; // binary
        scanned += 1;
        const { text } = decodeText(buffer);
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (matches.length >= args.maxResults) break;
          if (!regex.test(lines[index])) continue;
          matches.push({ file: path.relative(args.path, file) || path.basename(file), line: index + 1, text: truncate(lines[index].trim(), 240) });
        }
      }
      return { pattern: args.pattern, path: args.path, scannedFiles: scanned, count: matches.length, matches };
    },
    format: (data) => data.matches.map((match) => `${match.file}:${match.line}: ${match.text}`).join('\n') || 'no matches',
  },
  {
    name: 'fs.write',
    title: 'Write a file',
    description: 'Create or overwrite a UTF-8 text file inside the workspace. Parent folders are created.',
    category: 'files',
    permission: 'write',
    tags: ['file', 'write', 'save'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', maxLength: 2000000 },
        overwrite: { type: 'boolean', default: true },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args) {
      if (!args.overwrite) {
        try {
          await fsp.access(args.path);
          throw fail('file already exists and overwrite is false', 'EXISTS');
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      await fsp.mkdir(path.dirname(args.path), { recursive: true });
      await fsp.writeFile(args.path, args.content, 'utf8');
      return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8'), lines: args.content.split('\n').length };
    },
  },
  {
    name: 'fs.append',
    title: 'Append to a file',
    description: 'Add text to the end of a file (creates it if missing).',
    category: 'files',
    permission: 'write',
    tags: ['file', 'append'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 500000 } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args) {
      await fsp.mkdir(path.dirname(args.path), { recursive: true });
      await fsp.appendFile(args.path, args.content, 'utf8');
      const stat = await fsp.stat(args.path);
      return { path: args.path, bytes: stat.size, appended: Buffer.byteLength(args.content, 'utf8') };
    },
  },
  {
    name: 'fs.replace',
    title: 'Replace text in a file',
    description: 'Literal find-and-replace inside one file. Returns how many replacements were made.',
    category: 'files',
    permission: 'write',
    tags: ['file', 'replace', 'edit'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string', minLength: 1, maxLength: 5000 },
        replace: { type: 'string', maxLength: 20000 },
        all: { type: 'boolean', default: false },
      },
      required: ['path', 'find'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args) {
      const decoded = await readTextFile(args.path, { maxBytes: 2000000 });
      if (!decoded.text.includes(args.find)) return { path: args.path, replacements: 0, changed: false };
      const before = decoded.text;
      const parts = before.split(args.find);
      const count = parts.length - 1;
      const after = args.all ? parts.join(args.replace == null ? '' : args.replace) : before.replace(args.find, args.replace == null ? '' : args.replace);
      await fsp.writeFile(args.path, after, 'utf8');
      return { path: args.path, replacements: args.all ? count : 1, changed: true, bytes: Buffer.byteLength(after) };
    },
  },
  {
    name: 'fs.mkdir',
    title: 'Create a folder',
    description: 'Create a directory inside the workspace, including parents; refuses paths outside the allowed roots.',
    category: 'files',
    permission: 'write',
    tags: ['directory', 'mkdir'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args) {
      await fsp.mkdir(args.path, { recursive: true });
      return { path: args.path, created: true };
    },
  },
  {
    name: 'fs.copy',
    title: 'Copy a file or folder',
    description: 'Copy a file or directory inside the workspace; both source and destination are checked against the sandbox.',
    category: 'files',
    permission: 'write',
    tags: ['copy'],
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'from', mode: 'write' }, { name: 'to', mode: 'write' }],
    async run(args) {
      await fsp.mkdir(path.dirname(args.to), { recursive: true });
      await fsp.cp(args.from, args.to, { recursive: true, force: Boolean(args.overwrite), errorOnExist: !args.overwrite });
      const stat = await fsp.stat(args.to);
      return { from: args.from, to: args.to, bytes: stat.size, directory: stat.isDirectory() };
    },
  },
  {
    name: 'fs.move',
    title: 'Move or rename',
    description: 'Move a file or folder inside the workspace.',
    category: 'files',
    permission: 'write',
    tags: ['move', 'rename'],
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'from', mode: 'write' }, { name: 'to', mode: 'write' }],
    async run(args) {
      await fsp.mkdir(path.dirname(args.to), { recursive: true });
      await fsp.rename(args.from, args.to);
      return { from: args.from, to: args.to, moved: true };
    },
  },
  {
    name: 'fs.delete',
    title: 'Delete (to trash)',
    description: 'Move a file or folder into the agent trash. Recoverable with fs.restore.',
    category: 'files',
    permission: 'write',
    tags: ['delete', 'remove', 'trash'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args, ctx) {
      const base = trashDir(ctx);
      await fsp.mkdir(base, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = `${stamp}__${path.basename(args.path)}`;
      const target = path.join(base, id);
      await fsp.rename(args.path, target).catch(async (err) => {
        if (err.code !== 'EXDEV') throw err;
        await fsp.cp(args.path, target, { recursive: true });
        await fsp.rm(args.path, { recursive: true, force: true });
      });
      return { path: args.path, trashId: id, recoverable: true };
    },
  },
  {
    name: 'fs.restore',
    title: 'Restore from trash',
    description: 'Put a deleted path back where it came from.',
    category: 'files',
    permission: 'write',
    tags: ['restore', 'undelete'],
    parameters: {
      type: 'object',
      properties: { trashId: { type: 'string' }, to: { type: 'string' } },
      required: ['trashId', 'to'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'to', mode: 'write' }],
    async run(args, ctx) {
      const source = path.join(trashDir(ctx), path.basename(args.trashId));
      try {
        await fsp.access(source);
      } catch {
        throw fail(`no trash entry named ${args.trashId}`, 'NOT_FOUND');
      }
      await fsp.mkdir(path.dirname(args.to), { recursive: true });
      await fsp.rename(source, args.to);
      return { restored: args.to };
    },
  },
  {
    name: 'fs.trash.list',
    title: 'Trash contents',
    description: 'What has been deleted recently and can still be restored.',
    category: 'files',
    permission: 'read',
    tags: ['trash'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const base = trashDir(ctx);
      try {
        const names = await fsp.readdir(base);
        const entries = [];
        for (const name of names.slice(-50)) {
          const stat = await fsp.stat(path.join(base, name)).catch(() => null);
          if (stat) entries.push({ trashId: name, size: humanBytes(stat.size), deletedAt: stat.mtime.toISOString() });
        }
        return { entries: entries.reverse() };
      } catch {
        return { entries: [] };
      }
    },
  },
  {
    name: 'fs.hash',
    title: 'File checksum',
    description: 'SHA-256 (or other) digest of a file, for verifying copies and downloads.',
    category: 'files',
    permission: 'read',
    tags: ['hash', 'sha256', 'checksum'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, algorithm: { type: 'string', enum: ['sha256', 'sha1', 'md5'], default: 'sha256' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      return { path: args.path, algorithm: args.algorithm, digest: await hashFile(args.path, args.algorithm) };
    },
  },
  {
    name: 'fs.diff',
    title: 'Diff two files',
    description: 'Line diff between two text files, or between a file and literal text.',
    category: 'files',
    permission: 'read',
    tags: ['diff', 'compare'],
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'file path' },
        b: { type: 'string', description: 'file path, or leave empty and use text' },
        text: { type: 'string', description: 'literal text to compare against file a' },
      },
      required: ['a'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'a', mode: 'read' }, { name: 'b', mode: 'read' }],
    async run(args) {
      const left = (await readTextFile(args.a, { maxBytes: 400000 })).text;
      let right;
      let label;
      if (args.b) {
        right = (await readTextFile(args.b, { maxBytes: 400000 })).text;
        label = `${path.basename(args.a)} ↔ ${path.basename(args.b)}`;
      } else if (args.text !== undefined) {
        right = args.text;
        label = `${path.basename(args.a)} ↔ text`;
      } else {
        throw fail('give b or text', 'BAD_ARGS');
      }
      const diff = diffLines(left, right, { label });
      return { ...diff, identical: diff.added === 0 && diff.removed === 0 };
    },
    format: (data) => data.text,
  },
  {
    name: 'fs.recent',
    title: 'Recently changed files',
    description: 'Files modified in the last N hours inside a directory.',
    category: 'files',
    permission: 'read',
    tags: ['recent', 'modified'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        hours: { type: 'number', default: 24, minimum: 0.1, maximum: 720 },
        limit: { type: 'integer', default: 30, minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const cutoff = Date.now() - args.hours * 3600 * 1000;
      const files = await walk(args.path, { maxFiles: 4000 });
      const rows = [];
      for (const file of files) {
        const stat = await fsp.stat(file).catch(() => null);
        if (stat && stat.mtimeMs >= cutoff) {
          rows.push({ file: path.relative(args.path, file), modified: stat.mtime.toISOString(), size: humanBytes(stat.size) });
        }
      }
      rows.sort((a, b) => b.modified.localeCompare(a.modified));
      return { path: args.path, hours: args.hours, count: rows.length, files: rows.slice(0, args.limit) };
    },
  },
  {
    name: 'fs.zip.list',
    title: 'List a ZIP archive',
    description: 'Entries inside a .zip/.docx/.xlsx without extracting, with sizes and timestamps.',
    category: 'files',
    permission: 'read',
    tags: ['zip', 'archive'],
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const entries = readZipDirectory(buffer);
      return { path: args.path, count: entries.length, entries: entries.slice(0, 300).map((entry) => ({ name: entry.name, bytes: entry.size, compressed: entry.compressed })) };
    },
  },
  {
    name: 'fs.zip.read',
    title: 'Read one file from a ZIP',
    description: 'Extract a single text entry from a ZIP archive.',
    category: 'files',
    permission: 'read',
    tags: ['zip', 'archive', 'extract'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, entry: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['path', 'entry'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const entries = readZipDirectory(buffer);
      const match = entries.find((entry) => entry.name === args.entry) || entries.find((entry) => entry.name.toLowerCase().endsWith(args.entry.toLowerCase()));
      if (!match) throw fail(`no entry ${args.entry} in ${path.basename(args.path)}`, 'NOT_FOUND');
      const data = inflateEntry(buffer, match);
      const decoded = decodeText(data);
      return { entry: match.name, bytes: data.length, encoding: decoded.encoding, text: decoded.text.slice(0, 100000) };
    },
    format: (data) => data.text,
  },
];

/* ── minimal ZIP reader (deflate + stored), used by the docs tools too ── */

function readZipDirectory(buffer) {
  const entries = [];
  let offset = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65557);
  while (offset >= minimum && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  if (offset < minimum) throw fail('not a ZIP archive (no end-of-central-directory record)', 'NOT_A_ZIP');
  const total = buffer.readUInt16LE(offset + 10);
  let pointer = buffer.readUInt32LE(offset + 16);
  for (let index = 0; index < total && pointer + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressed, size, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateEntry(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw fail('corrupt ZIP entry', 'BAD_ZIP');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch (err) {
      throw fail(`could not inflate ${entry.name}: ${err.message}`, 'BAD_ZIP');
    }
  }
  throw fail(`unsupported compression method ${entry.method} for ${entry.name}`, 'BAD_ZIP');
}

module.exports.readZipDirectory = readZipDirectory;
module.exports.inflateEntry = inflateEntry;
