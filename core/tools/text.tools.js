'use strict';

/**
 * Deterministic text, time and encoding tools.
 *
 * Useful for cleaning evidence before it reaches a model: extracting identifiers,
 * redacting secrets, chunking with real offsets, measuring similarity and
 * hashing. Everything is local, bounded and makes no semantic claim beyond the
 * named algorithm.
 */

const crypto = require('node:crypto');

const STOPWORDS = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your nie sie jest sa to ze do na w z o i a ale jak co czy dla od po przez oraz tak juz tylko moze byc'.split(' '));

function fold(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
}

function words(value) {
  return fold(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function levenshtein(a, b) {
  const left = [...String(a)];
  const right = [...String(b)];
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let last = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const temp = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, last + (left[i - 1] === right[j - 1] ? 0 : 1));
      last = temp;
    }
  }
  return previous[right.length];
}

function trigrams(value) {
  const text = ` ${fold(value).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const set = new Set();
  for (let index = 0; index + 3 <= text.length; index += 1) set.add(text.slice(index, index + 3));
  return set;
}

module.exports = [
  {
    name: 'text.extract',
    title: 'Extract identifiers from text',
    description: 'Extracts emails, URLs, IPv4 addresses, numbers, dates (ISO or dd.mm.yyyy) and file paths from text with their character offsets. No guessing about meaning.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'extract', 'email', 'url', 'identifiers'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200000 },
        kinds: { type: 'array', maxItems: 6, items: { type: 'string', enum: ['email', 'url', 'ipv4', 'number', 'date', 'path'] } },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const patterns = {
        email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        url: /https?:\/\/[^\s"'<>]+/g,
        ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        number: /(?<![\w.])\d+(?:[.,]\d+)?(?![\w.])/g,
        date: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/g,
        path: /(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:[\w.-]+\/)+[\w.-]+)/g,
      };
      const kinds = args.kinds && args.kinds.length ? args.kinds : Object.keys(patterns);
      const found = [];
      for (const kind of kinds) {
        const pattern = patterns[kind];
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(args.text))) found.push({ kind, value: match[0], offset: match.index });
      }
      found.sort((a, b) => a.offset - b.offset);
      return { ok: true, found, counts: kinds.reduce((out, kind) => ({ ...out, [kind]: found.filter((entry) => entry.kind === kind).length }), {}) };
    },
    format: (data) => `${data.found.length} elementów`,
  },
  {
    name: 'text.redact',
    title: 'Redact secret-looking values',
    description: 'Replaces passwords, API keys, bearer tokens, private-key blocks, emails and long credit-card-like numbers with typed placeholders and reports what was redacted. The original text is not returned.',
    category: 'security',
    permission: 'read',
    tags: ['text', 'redact', 'secret', 'privacy', 'log'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 200000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const replacements = [
        { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
        { kind: 'api_key', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
        { kind: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
        { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
        { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
        { kind: 'password', re: /\b(password|passwd|hasło|haslo|secret|api[_-]?key|token|klucz)\b\s*[:=]\s*\S{4,}/gi },
        { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
        { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
      ];
      let text = args.text;
      const redacted = {};
      for (const { kind, re } of replacements) {
        text = text.replace(re, (match) => {
          redacted[kind] = (redacted[kind] || 0) + 1;
          if (kind === 'password') {
            const label = match.split(/[:=]/)[0];
            return `${label}=[REDACTED:${kind}]`;
          }
          return `[REDACTED:${kind}]`;
        });
      }
      return { ok: true, redacted, total: Object.values(redacted).reduce((sum, count) => sum + count, 0), text };
    },
    format: (data) => `${data.total} wartości zredagowanych`,
  },
  {
    name: 'text.slugify',
    title: 'Create a URL-safe slug',
    description: 'Normalises Polish and Latin diacritics, lowercases, replaces runs of non-alphanumerics with a single separator and trims. It does not guarantee database uniqueness.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'slug', 'url', 'normalize'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000 },
        separator: { type: 'string', minLength: 1, maxLength: 2 },
        maxLength: { type: 'number', minimum: 1, maximum: 200 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const separator = args.separator || '-';
      let slug = fold(args.text).split(/[^a-z0-9]+/).filter(Boolean).join(separator);
      const maxLength = args.maxLength || 80;
      const truncated = slug.length > maxLength;
      if (truncated) {
        slug = slug.slice(0, maxLength);
        // Never end on a separator, whatever separator the caller chose.
        while (slug.endsWith(separator) && slug.length) slug = slug.slice(0, -separator.length);
      }
      return { ok: true, slug, length: slug.length, truncated };
    },
    format: (data) => data.slug,
  },
  {
    name: 'text.levenshtein',
    title: 'Edit distance between two strings',
    description: 'Computes the Levenshtein insertion/deletion/substitution distance on Unicode code points, with the maximum length and a normalised similarity ratio.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'distance', 'levenshtein', 'typo'],
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', maxLength: 10000 },
        b: { type: 'string', maxLength: 10000 },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    async run(args) {
      const distance = levenshtein(args.a, args.b);
      const longest = Math.max([...args.a].length, [...args.b].length);
      return { ok: true, distance, length: longest, similarity: longest ? Number((1 - distance / longest).toFixed(4)) : 1 };
    },
    format: (data) => `odległość ${data.distance}`,
  },
  {
    name: 'text.similarity',
    title: 'Trigram Jaccard similarity',
    description: 'Computes Jaccard similarity over lowercased character trigrams, plus shared and total counts. Suitable for near-duplicate detection, not semantic similarity.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'similarity', 'jaccard', 'dedupe'],
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, maxLength: 100000 },
        b: { type: 'string', minLength: 1, maxLength: 100000 },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    async run(args) {
      const left = trigrams(args.a);
      const right = trigrams(args.b);
      let common = 0;
      for (const gram of left) if (right.has(gram)) common += 1;
      const union = left.size + right.size - common;
      return { ok: true, similarity: union ? Number((common / union).toFixed(4)) : 1, shared: common, left: left.size, right: right.size | 0 };
    },
    format: (data) => `Jaccard ${data.similarity}`,
  },
  {
    name: 'text.chunk',
    title: 'Chunk text with real offsets',
    description: 'Splits text into overlapping chunks of a target size while preferring paragraph and sentence boundaries. Each chunk reports its exact start/end offsets and line range.',
    category: 'documents',
    permission: 'read',
    tags: ['text', 'chunk', 'rag', 'offsets', 'documents'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        size: { type: 'number', minimum: 100, maximum: 20000 },
        overlap: { type: 'number', minimum: 0, maximum: 2000 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const size = args.size || 1200;
      const overlap = Math.min(args.overlap || 150, Math.floor(size / 2));
      const chunks = [];
      let start = 0;
      while (start < args.text.length && chunks.length < 5000) {
        let end = Math.min(args.text.length, start + size);
        if (end < args.text.length) {
          const boundary = Math.max(args.text.lastIndexOf('\n\n', end), args.text.lastIndexOf('. ', end));
          if (boundary > start + size * 0.5) end = boundary + 1;
        }
        const text = args.text.slice(start, end);
        const lineStart = args.text.slice(0, start).split('\n').length;
        const lineEnd = lineStart + text.split('\n').length - 1;
        chunks.push({ index: chunks.length, start, end, lineStart, lineEnd, chars: text.length, text });
        if (end >= args.text.length) break;
        start = Math.max(start + 1, end - overlap);
      }
      return { ok: true, chunks, count: chunks.length, truncated: chunks.length >= 5000 };
    },
    format: (data) => `${data.count} chunków`,
  },
  {
    name: 'text.keywords',
    title: 'Frequency-based keywords',
    description: 'Returns the most frequent non-stopword terms with counts and share of tokens. Stopwords cover Polish and English; this is term frequency, not TF-IDF.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'keywords', 'frequency', 'analysis'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200000 },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const tokens = words(args.text).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
      const counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      const keywords = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, args.limit || 20)
        .map(([term, count]) => ({ term, count, share: Number((count / Math.max(1, tokens.length)).toFixed(4)) }));
      return { ok: true, tokens: tokens.length, unique: counts.size, keywords };
    },
    format: (data) => `${data.keywords.length} słów kluczowych`,
  },
  {
    name: 'text.stats',
    title: 'Basic text statistics',
    description: 'Counts characters, words, sentences and paragraphs and reports average word/sentence length. It labels the result a heuristic and does not claim a readability grade.',
    category: 'code',
    permission: 'read',
    tags: ['text', 'stats', 'length', 'readability'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 500000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const chars = [...args.text].length;
      const wordsList = words(args.text);
      const sentences = args.text.split(/[.!?]+(?:\s|$)/).filter((sentence) => sentence.trim().length > 1).length;
      const paragraphs = args.text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length).length;
      return { ok: true, chars, words: wordsList.length, sentences, paragraphs, avgWordLength: wordsList.length ? Number((args.text.replace(/\s/g, '').length / wordsList.length).toFixed(2)) : 0, avgSentenceWords: sentences ? Number((wordsList.length / sentences).toFixed(2)) : 0, method: 'whitespace/punctuation heuristic, not a readability grade' };
    },
    format: (data) => `${data.words} słów, ${data.sentences} zdań`,
  },
  {
    name: 'time.parse',
    title: 'Parse a timestamp',
    description: 'Parses an ISO-8601 or unambiguous date string into epoch milliseconds and UTC parts, reporting invalid instead of silently using the current time. Local-time parsing is not attempted.',
    category: 'system',
    permission: 'read',
    tags: ['time', 'parse', 'iso', 'utc'],
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const value = args.value.trim();
      const parsed = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?$/.test(value) || /^\d{10,13}$/.test(value) ? new Date(/^\d{10}$/.test(value) ? Number(value) * 1000 : /^\d{13}$/.test(value) ? Number(value) : value) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) return { ok: false, code: 'INVALID_DATE', message: 'expected ISO-8601 or epoch seconds/milliseconds' };
      return { ok: true, input: args.value, epochMs: parsed.getTime(), iso: parsed.toISOString(), utc: { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate(), hour: parsed.getUTCHours(), minute: parsed.getUTCMinutes(), second: parsed.getUTCSeconds() } };
    },
    format: (data) => (data.ok ? data.iso : data.code),
  },
  {
    name: 'time.diff',
    title: 'Difference between two timestamps',
    description: 'Computes the absolute and signed difference between two ISO-8601 timestamps in milliseconds, seconds, minutes, hours and days. Invalid input is refused.',
    category: 'system',
    permission: 'read',
    tags: ['time', 'difference', 'duration'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 1, maxLength: 100 },
        to: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async run(args) {
      const a = new Date(args.from);
      const b = new Date(args.to);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return { ok: false, code: 'INVALID_DATE' };
      const ms = b.getTime() - a.getTime();
      return { ok: true, from: a.toISOString(), to: b.toISOString(), ms, absoluteMs: Math.abs(ms), seconds: Number((ms / 1000).toFixed(3)), minutes: Number((ms / 60000).toFixed(3)), hours: Number((ms / 3600000).toFixed(3)), days: Number((ms / 86400000).toFixed(3)) };
    },
    format: (data) => (data.ok ? `${data.days} dni` : data.code),
  },
  {
    name: 'time.add',
    title: 'Add a duration to a timestamp',
    description: 'Adds days, hours, minutes and seconds to an ISO-8601 timestamp and returns the resulting ISO string and epoch. Calendar months are not supported to avoid ambiguity.',
    category: 'system',
    permission: 'read',
    tags: ['time', 'add', 'duration', 'schedule'],
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', minLength: 1, maxLength: 100 },
        days: { type: 'number', minimum: -3650, maximum: 3650 },
        hours: { type: 'number', minimum: -100000, maximum: 100000 },
        minutes: { type: 'number', minimum: -1000000, maximum: 1000000 },
        seconds: { type: 'number', minimum: -10000000, maximum: 10000000 },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const base = new Date(args.value);
      if (Number.isNaN(base.getTime())) return { ok: false, code: 'INVALID_DATE' };
      const delta = ((args.days || 0) * 86400 + (args.hours || 0) * 3600 + (args.minutes || 0) * 60 + (args.seconds || 0)) * 1000;
      const result = new Date(base.getTime() + delta);
      return { ok: true, input: base.toISOString(), deltaMs: delta, result: result.toISOString(), epochMs: result.getTime() };
    },
    format: (data) => (data.ok ? data.result : data.code),
  },
  {
    name: 'encode.base64',
    title: 'Base64 encode or decode',
    description: 'Encodes UTF-8 text to base64 or decodes base64 back to UTF-8, rejecting invalid input. It is an encoding, not encryption, and says so.',
    category: 'code',
    permission: 'read',
    tags: ['encoding', 'base64', 'decode'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        mode: { type: 'string', enum: ['encode', 'decode'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      if ((args.mode || 'encode') === 'encode') return { ok: true, mode: 'encode', result: Buffer.from(args.text, 'utf8').toString('base64') };
      if (!/^[A-Za-z0-9+/=\s]+$/.test(args.text)) return { ok: false, code: 'BAD_BASE64' };
      return { ok: true, mode: 'decode', result: Buffer.from(args.text, 'base64').toString('utf8') };
    },
    format: (data) => (data.ok ? `${data.result.length} znaków` : data.code),
  },
  {
    name: 'encode.hex',
    title: 'Hex encode or decode',
    description: 'Converts UTF-8 text to lowercase hexadecimal bytes or decodes an even-length hex string back to UTF-8. Invalid hex is refused.',
    category: 'code',
    permission: 'read',
    tags: ['encoding', 'hex', 'bytes'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        mode: { type: 'string', enum: ['encode', 'decode'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      if ((args.mode || 'encode') === 'encode') return { ok: true, mode: 'encode', result: Buffer.from(args.text, 'utf8').toString('hex') };
      if (!/^[0-9a-fA-F]*$/.test(args.text) || args.text.length % 2 !== 0) return { ok: false, code: 'BAD_HEX' };
      return { ok: true, mode: 'decode', result: Buffer.from(args.text, 'hex').toString('utf8') };
    },
    format: (data) => (data.ok ? `${data.result.length} znaków` : data.code),
  },
  {
    name: 'encode.url',
    title: 'URL encode or decode',
    description: 'Percent-encodes text for a URL component or decodes percent escapes, refusing malformed escapes. It does not build or validate a full URL.',
    category: 'network',
    permission: 'read',
    tags: ['encoding', 'url', 'percent', 'query'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 100000 },
        mode: { type: 'string', enum: ['encode', 'decode'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      try {
        return { ok: true, mode: args.mode || 'encode', result: (args.mode || 'encode') === 'encode' ? encodeURIComponent(args.text) : decodeURIComponent(args.text) };
      } catch (err) {
        return { ok: false, code: 'BAD_ESCAPE', message: err.message };
      }
    },
    format: (data) => (data.ok ? data.result.slice(0, 200) : data.code),
  },
  {
    name: 'encode.hash',
    title: 'Cryptographic hash of text',
    description: 'Computes SHA-256, SHA-512, SHA-1 or MD5 over UTF-8 text and returns hex and base64 digests. Hashes are one-way but MD5/SHA-1 are not collision-safe.',
    category: 'security',
    permission: 'read',
    tags: ['hash', 'sha256', 'checksum', 'integrity'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        algorithm: { type: 'string', enum: ['sha256', 'sha512', 'sha1', 'md5'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const algorithm = args.algorithm || 'sha256';
      const digest = crypto.createHash(algorithm).update(args.text, 'utf8').digest();
      return { ok: true, algorithm, hex: digest.toString('hex'), base64: digest.toString('base64'), bytes: digest.length, warning: ['md5', 'sha1'].includes(algorithm) ? 'not collision-safe; use sha256 for integrity' : null };
    },
    format: (data) => `${data.algorithm}: ${data.hex.slice(0, 16)}…`,
  },
  {
    name: 'encode.uuid',
    title: 'Generate random identifiers',
    description: 'Generates cryptographically random UUID v4 identifiers (bounded to 100) or validates a UUID string. It does not persist them.',
    category: 'code',
    permission: 'read',
    tags: ['uuid', 'identifier', 'random'],
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 1, maximum: 100 },
        validate: { type: 'string', maxLength: 100 },
      },
      additionalProperties: false,
    },
    async run(args) {
      if (args.validate) {
        return { ok: true, valid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.validate), validate: args.validate };
      }
      const count = Math.max(1, Math.min(100, Math.round(args.count || 1)));
      return { ok: true, uuids: Array.from({ length: count }, () => crypto.randomUUID()) };
    },
    format: (data) => (data.uuids ? `${data.uuids.length} UUID` : String(data.valid)),
  },
];
