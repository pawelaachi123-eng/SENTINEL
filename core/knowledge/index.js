'use strict';

/**
 * Knowledge base and RAG.
 *
 * Documents are split into overlapping chunks, each chunk is embedded locally
 * and stored with its source and character offsets. Search is the same hybrid
 * BM25 + vector blend the memory uses, so a question phrased differently from
 * the document still finds it.
 *
 * Citation is a first-class requirement: every hit carries `source`, `chunk`
 * and a 200-character excerpt, and the assistant is instructed to cite
 * `[K#]` markers. There is no "the AI read your files and knows" without a
 * quotable line behind it.
 *
 * Re-indexing is incremental: a document whose size+mtime+hash are unchanged is
 * skipped, which makes "index this folder again" cheap.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Bm25Index, hybridSearch } = require('../memory/search');
const { HashingEmbedder, encodeVector, decodeVector, expandQuery } = require('../memory/embeddings');
const { newId } = require('../memory/store');
const { scan: scanInjection } = require('../security/injection');
const { loadDocument } = require('./extract');
const { walk, decodeText } = require('../tools/helpers');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.ini', '.cfg', '.xml', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.c', '.h', '.cpp', '.hpp', '.ino', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.ps1', '.bat', '.env.example']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
const SKIP_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.mp4', '.wav', '.zip', '.7z', '.rar', '.bin', '.pyd', '.node', '.class', '.jar', '.apk', '.woff', '.woff2', '.ttf', '.sqlite', '.db']);

function supported(file) {
  const extension = path.extname(file).toLowerCase();
  if (SKIP_EXTENSIONS.has(extension)) return false;
  return TEXT_EXTENSIONS.has(extension) || DOCUMENT_EXTENSIONS.has(extension) || extension === '';
}

/**
 * Splits text into chunks on paragraph boundaries, with overlap so a sentence
 * spanning a boundary can still be found.
 */
function splitIntoChunks(text, { target = 1000, overlap = 150, max = 1800 } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  if (!clean.trim()) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < 5000) {
    let end = Math.min(clean.length, start + target);
    if (end < clean.length) {
      const candidates = [clean.lastIndexOf('\n\n', end), clean.lastIndexOf('\n', end), clean.lastIndexOf('. ', end)];
      const best = Math.max(...candidates);
      if (best > start + target * 0.5) end = best + 1;
    }
    let slice = clean.slice(start, end);
    if (slice.length > max) slice = slice.slice(0, max);
    const trimmed = slice.trim();
    if (trimmed.length >= 40) {
      chunks.push({ text: trimmed, start, end });
    }
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

class Knowledge {
  constructor({ store, embedder, log, config, now = () => Date.now() }) {
    this.store = store;
    this.embedder = embedder || new HashingEmbedder();
    this.log = log;
    this.config = config;
    this.now = now;
    this.docCollection = 'knowledge_docs';
    this.chunkCollection = 'knowledge_chunks';
    this.docs = new Map();
    this.chunks = new Map();
    this.chunkIndex = new Bm25Index();
    this.loaded = false;
    this.counters = { indexed: 0, chunks: 0, skipped: 0, searches: 0, failed: 0, removed: 0 };
  }

  load() {
    if (this.loaded) return;
    for (const doc of this.store.list(this.docCollection)) this.docs.set(doc.id, doc);
    for (const chunk of this.store.list(this.chunkCollection)) {
      if (!this.docs.has(chunk.docId)) {
        this.store.delete(this.chunkCollection, chunk.id);
        continue;
      }
      this.chunks.set(chunk.id, chunk);
      this.chunkIndex.add(chunk.id, `${chunk.text} ${chunk.title || ''}`);
    }
    this.loaded = true;
  }

  async embed(texts) {
    if (!texts.length) return [];
    try {
      return await this.embedder.embed(texts);
    } catch (err) {
      if (this.log) this.log.warn('knowledge', `embeddings unavailable, using lexical only: ${err.message}`);
      this.embedder = new HashingEmbedder();
      return this.embedder.embed(texts);
    }
  }

  /* ── indexing ───────────────────────────────────────────────────────── */

  async indexFile(file, { tags = [], title = null } = {}) {
    this.load();
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error(`cannot read ${file}`), { code: 'NOT_A_FILE' });
    if (stat.size > 20 * 1024 * 1024) {
      this.counters.skipped += 1;
      return { skipped: true, reason: 'larger than 20 MB' };
    }
    const extension = path.extname(file).toLowerCase();
    if (!supported(file)) {
      this.counters.skipped += 1;
      return { skipped: true, reason: `${extension || 'no extension'} is not an indexable format` };
    }

    const existing = [...this.docs.values()].find((doc) => doc.path === file);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (existing && existing.signature === signature) {
      this.counters.skipped += 1;
      return { skipped: true, reason: 'unchanged', doc: existing };
    }

    let text;
    let kind = 'text';
    let encoding = null;
    try {
      if (DOCUMENT_EXTENSIONS.has(extension)) {
        const loaded = await loadDocument(file);
        text = loaded.text;
        kind = loaded.kind;
        encoding = loaded.encoding || null;
      } else {
        const decoded = decodeText(await fsp.readFile(file));
        text = decoded.text;
        encoding = decoded.encoding;
      }
    } catch (err) {
      this.counters.failed += 1;
      return { skipped: true, reason: `could not extract text: ${err.message}` };
    }
    if (!text || !text.trim()) {
      this.counters.skipped += 1;
      return { skipped: true, reason: 'no extractable text' };
    }
    const hash = hashText(text);
    if (existing && existing.hash === hash) {
      existing.signature = signature;
      this.store.put(this.docCollection, existing.id, existing);
      this.counters.skipped += 1;
      return { skipped: true, reason: 'unchanged content', doc: existing };
    }

    const docId = existing ? existing.id : newId('doc');
    if (existing) this.dropChunks(docId);

    const pieces = splitIntoChunks(text);
    const vectors = await this.embed(pieces.map((piece) => piece.text));
    const doc = {
      id: docId,
      title: title || path.basename(file),
      path: file,
      kind,
      encoding,
      bytes: stat.size,
      characters: text.length,
      chunks: pieces.length,
      tags: [...new Set(tags)].slice(0, 12),
      untrusted: true,
      trust: 'untrusted-data',
      injectionFindings: scanInjection(text).findings.length,
      signature,
      hash,
      mtime: stat.mtime.toISOString(),
      indexedAt: this.now(),
    };
    this.docs.set(docId, doc);
    this.store.put(this.docCollection, docId, doc);

    pieces.forEach((piece, index) => {
      const vector = vectors[index];
      const chunk = {
        id: `${docId}:${String(index).padStart(4, '0')}`,
        docId,
        index,
        title: doc.title,
        source: doc.path,
        kind,
        text: piece.text,
        start: piece.start,
        end: piece.end,
        dim: vector ? vector.length : 0,
        vectorName: this.embedder.name || 'unknown',
        vector: vector ? encodeVector(vector) : null,
        createdAt: this.now(),
      };
      this.chunks.set(chunk.id, chunk);
      this.chunkIndex.add(chunk.id, `${chunk.text} ${chunk.title}`);
      this.store.put(this.chunkCollection, chunk.id, chunk);
    });

    this.counters.indexed += 1;
    this.counters.chunks += pieces.length;
    if (this.log) this.log.info('knowledge', `indexed ${doc.title} (${pieces.length} chunks)`);
    return { doc, chunks: pieces.length, skipped: false };
  }

  async indexText({ title, text, source = 'pasted', tags = [] }) {
    this.load();
    const clean = String(text || '');
    if (!clean.trim()) throw Object.assign(new Error('nothing to index'), { code: 'EMPTY' });
    const docId = newId('doc');
    const pieces = splitIntoChunks(clean);
    const vectors = await this.embed(pieces.map((piece) => piece.text));
    const doc = {
      id: docId,
      title: title || `note ${new Date().toISOString().slice(0, 16)}`,
      path: null,
      source,
      kind: 'text',
      bytes: Buffer.byteLength(clean),
      characters: clean.length,
      chunks: pieces.length,
      tags: [...new Set(tags)].slice(0, 12),
      untrusted: true,
      trust: 'untrusted-data',
      injectionFindings: scanInjection(clean).findings.length,
      hash: hashText(clean),
      signature: null,
      mtime: new Date().toISOString(),
      indexedAt: this.now(),
    };
    this.docs.set(docId, doc);
    this.store.put(this.docCollection, docId, doc);
    pieces.forEach((piece, index) => {
      const vector = vectors[index];
      const chunk = {
        id: `${docId}:${String(index).padStart(4, '0')}`,
        docId,
        index,
        title: doc.title,
        source,
        kind: 'text',
        text: piece.text,
        start: piece.start,
        end: piece.end,
        dim: vector ? vector.length : 0,
        vectorName: this.embedder.name || 'unknown',
        vector: vector ? encodeVector(vector) : null,
        createdAt: this.now(),
      };
      this.chunks.set(chunk.id, chunk);
      this.chunkIndex.add(chunk.id, `${chunk.text} ${chunk.title}`);
      this.store.put(this.chunkCollection, chunk.id, chunk);
    });
    this.counters.indexed += 1;
    this.counters.chunks += pieces.length;
    return { doc, chunks: pieces.length };
  }

  async indexPath(target, { recursive = true, maxFiles = 400, tags = [], signal = null, onProgress = null } = {}) {
    this.load();
    const stat = await fsp.stat(target);
    const files = stat.isDirectory()
      ? (await walk(target, { maxFiles, maxDepth: recursive ? 12 : 1, includeHidden: false })).filter(supported)
      : [target];
    const results = [];
    for (const file of files) {
      if (signal && signal.aborted) break;
      const result = await this.indexFile(file, { tags });
      results.push({ file: path.relative(target, file) || path.basename(file), ...result });
      if (onProgress) onProgress({ done: results.length, total: files.length, file });
    }
    return {
      target,
      scanned: files.length,
      indexed: results.filter((result) => !result.skipped).length,
      skipped: results.filter((result) => result.skipped).length,
      failed: results.filter((result) => result.skipped && /could not/.test(result.reason || '')).length,
      documents: results.filter((result) => !result.skipped).map((result) => result.doc),
      details: results.filter((result) => result.skipped).slice(0, 20),
    };
  }

  /** Re-embeds everything with the current embedder (e.g. after a model change). */
  async reindex() {
    this.load();
    let updated = 0;
    for (const chunk of this.chunks.values()) {
      // eslint-disable-next-line no-await-in-loop
      const [vector] = await this.embed([chunk.text]);
      if (!vector) continue;
      chunk.vector = encodeVector(vector);
      chunk.dim = vector.length;
      chunk.vectorName = this.embedder.name || 'unknown';
      this.store.put(this.chunkCollection, chunk.id, chunk);
      updated += 1;
    }
    return { updated, embedder: this.embedder.name };
  }

  /* ── reading ────────────────────────────────────────────────────────── */

  async search(query, { limit = 6, docId = null, tags = null, minScore = 0.001 } = {}) {
    this.load();
    this.counters.searches += 1;
    const text = String(query || '').trim();
    if (!text || this.chunks.size === 0) return [];
    const candidates = [...this.chunks.values()].filter((chunk) => {
      if (docId && chunk.docId !== docId) return false;
      if (tags && tags.length) {
        const doc = this.docs.get(chunk.docId);
        if (!doc || !tags.some((tag) => (doc.tags || []).includes(tag))) return false;
      }
      return true;
    });
    if (!candidates.length) return [];

    const [queryVector] = await this.embed([expandQuery(text)]);
    const hits = hybridSearch({
      query: text,
      records: candidates.map((chunk) => ({
        id: chunk.id,
        text: `${chunk.text} ${chunk.title || ''}`,
        vector: chunk.vector ? decodeVector(chunk.vector) : null,
        dim: chunk.dim,
        vectorName: chunk.vectorName,
      })),
      index: this.chunkIndex,
      queryVector,
      vectorName: this.embedder.name,
      limit: limit * 4,
    });
    // A cheap, deterministic reranker: how much of the query's vocabulary the
    // fragment actually contains. It costs microseconds and fixes the common
    // failure where a semantically similar but useless chunk outranks the exact
    // passage the user asked about.
    const queryTerms = [...new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 2))];
    const reranked = hits
      .filter((hit) => hit.score >= minScore)
      .map((hit) => {
        const chunk = this.chunks.get(hit.record.id);
        const body = String(chunk.text).toLowerCase();
        const overlap = queryTerms.length ? queryTerms.filter((term) => body.includes(term)).length / queryTerms.length : 0;
        return { hit, chunk, overlap, finalScore: hit.score * (0.75 + 0.5 * overlap) };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    // Diversity: at most two fragments from one document, so a single long PDF
    // cannot fill the whole evidence block.
    const perDoc = new Map();
    const selected = [];
    for (const entry of reranked) {
      const used = perDoc.get(entry.chunk.docId) || 0;
      if (used >= 2) continue;
      perDoc.set(entry.chunk.docId, used + 1);
      selected.push(entry);
      if (selected.length >= limit) break;
    }
    return selected.map(({ chunk, overlap, finalScore }) => ({
      id: chunk.id,
      docId: chunk.docId,
      title: chunk.title,
      source: chunk.source,
      kind: chunk.kind,
      chunk: chunk.index + 1,
      score: Number(finalScore.toFixed(4)),
      lexicalOverlap: Number(overlap.toFixed(2)),
      untrusted: true,
      excerpt: chunk.text.length > 400 ? `${chunk.text.slice(0, 400)}…` : chunk.text,
      text: chunk.text,
      start: chunk.start,
    }));
  }

  list({ limit = 100 } = {}) {
    this.load();
    return [...this.docs.values()]
      .sort((a, b) => (b.indexedAt || 0) - (a.indexedAt || 0))
      .slice(0, limit)
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        path: doc.path,
        kind: doc.kind,
        chunks: doc.chunks,
        characters: doc.characters,
        tags: doc.tags,
        indexedAt: doc.indexedAt,
      }));
  }

  get(docId) {
    this.load();
    return this.docs.get(docId) || null;
  }

  dropChunks(docId) {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.docId !== docId) continue;
      this.chunks.delete(chunk.id);
      this.chunkIndex.remove(chunk.id);
      this.store.delete(this.chunkCollection, chunk.id);
    }
  }

  remove(docId) {
    this.load();
    if (!this.docs.has(docId)) return false;
    this.dropChunks(docId);
    this.docs.delete(docId);
    this.store.delete(this.docCollection, docId);
    this.counters.removed += 1;
    return true;
  }


  /* ── index health and code awareness ────────────────────────────────── */

  /** Documents whose file changed, disappeared, or whose extraction failed. */
  stale() {
    this.load();
    const out = [];
    for (const doc of this.docs.values()) {
      if (!doc.path) continue;
      let stat = null;
      try {
        stat = fs.statSync(doc.path);
      } catch {
        out.push({ id: doc.id, title: doc.title, path: doc.path, reason: 'file is gone' });
        continue;
      }
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (doc.signature && doc.signature !== signature) out.push({ id: doc.id, title: doc.title, path: doc.path, reason: 'file changed since indexing', indexedAt: doc.indexedAt });
    }
    return out;
  }

  /** Honest coverage report: what the index actually contains. */
  coverage() {
    this.load();
    const docs = [...this.docs.values()];
    const byKind = {};
    let chunks = 0;
    let untrusted = 0;
    let flagged = 0;
    let withoutVectors = 0;
    for (const doc of docs) {
      byKind[doc.kind || 'text'] = (byKind[doc.kind || 'text'] || 0) + 1;
      chunks += doc.chunks || 0;
      if (doc.untrusted) untrusted += 1;
      if (doc.injectionFindings) flagged += 1;
    }
    for (const chunk of this.chunks.values()) if (!chunk.vector) withoutVectors += 1;
    const stale = this.stale();
    return {
      documents: docs.length,
      chunks,
      byKind,
      untrusted,
      flagged,
      withoutVectors,
      stale: stale.length,
      staleDocs: stale.slice(0, 20),
      characters: docs.reduce((sum, doc) => sum + (doc.characters || 0), 0),
      newest: docs.length ? Math.max(...docs.map((doc) => doc.indexedAt || 0)) : null,
      oldest: docs.length ? Math.min(...docs.map((doc) => doc.indexedAt || 0)) : null,
      embedder: this.embedder.name,
    };
  }

  /** Symbol index for code: functions, classes, exports, routes, tests. */
  symbols(file) {
    const text = fs.readFileSync(file, 'utf8').slice(0, 2 * 1024 * 1024);
    const extension = path.extname(file).toLowerCase();
    const patterns = [];
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(extension)) {
      patterns.push({ kind: 'function', re: /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g });
      patterns.push({ kind: 'class', re: /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g });
      patterns.push({ kind: 'method', re: /(?:^|\n)\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g });
      patterns.push({ kind: 'const', re: /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g });
    }
    if (['.py'].includes(extension)) {
      patterns.push({ kind: 'function', re: /(?:^|\n)\s*def\s+([A-Za-z_]\w*)/g });
      patterns.push({ kind: 'class', re: /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g });
    }
    if (['.ps1', '.sh', '.bat', '.cmd'].includes(extension)) {
      patterns.push({ kind: 'function', re: /(?:^|\n)\s*(?:function\s+|)([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/g });
    }
    const found = [];
    const seen = new Set();
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(text)) && found.length < 400) {
        const name = match[1];
        const key = `${pattern.kind}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = text.slice(0, match.index).split('\n').length;
        found.push({ kind: pattern.kind, name, line });
      }
    }
    return { file, symbols: found, count: found.length };
  }

  /** FTS-like symbol search across authorised code files. */
  findSymbols(query, { files = [], limit = 40 } = {}) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return [];
    const out = [];
    for (const file of files.slice(0, 400)) {
      let result;
      try {
        result = this.symbols(file);
      } catch {
        continue;
      }
      for (const symbol of result.symbols) {
        if (!symbol.name.toLowerCase().includes(needle)) continue;
        out.push({ file, ...symbol });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  stats() {
    this.load();
    let characters = 0;
    for (const chunk of this.chunks.values()) characters += chunk.text.length;
    const kinds = {};
    for (const doc of this.docs.values()) kinds[doc.kind || 'text'] = (kinds[doc.kind || 'text'] || 0) + 1;
    return {
      documents: this.docs.size,
      chunks: this.chunks.size,
      characters,
      kinds,
      embedder: this.embedder.name || 'unknown',
      counters: { ...this.counters },
      lastIndexedAt: [...this.docs.values()].reduce((latest, doc) => Math.max(latest, doc.indexedAt || 0), 0) || null,
    };
  }
}

module.exports = { Knowledge, splitIntoChunks, supported, TEXT_EXTENSIONS, DOCUMENT_EXTENSIONS };
