'use strict';

/**
 * Document tools: PDF, DOCX, XLSX, CSV, JSON, Markdown, logs, encodings.
 *
 * The PDF and Office readers are self-contained (zlib + the ZIP reader from
 * files.tools) so that indexing a folder of documents works on a fresh machine
 * with no extra install. They are extractors, not layout engines: text comes
 * out, formatting does not. Where extraction cannot work (scanned PDF, exotic
 * CID font) the tool says so instead of returning noise.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readTextFile, decodeText, truncate } = require('./helpers');
const { readZipDirectory, inflateEntry } = require('./files.tools');
const { pdfText, docxText, xlsxRows, parseCsv, analyseLog, loadDocument, xmlToText, summariseJson } = require('../knowledge/extract');

const fail = (message, code) => Object.assign(new Error(message), { code });

module.exports = [
  {
    name: 'doc.read',
    title: 'Read a document',
    description: 'Extract text from PDF, DOCX, XLSX, TXT, MD, JSON, CSV or source files, with automatic encoding detection.',
    category: 'documents',
    permission: 'read',
    tags: ['pdf', 'docx', 'xlsx', 'text', 'document'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxChars: { type: 'integer', default: 20000, minimum: 100, maximum: 200000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const loaded = await loadDocument(args.path);
      return {
        path: args.path,
        kind: loaded.kind,
        pages: loaded.pages || null,
        encoding: loaded.encoding || null,
        note: loaded.note || null,
        characters: loaded.text.length,
        text: truncate(loaded.text, args.maxChars),
      };
    },
    format: (data) => data.text,
  },
  {
    name: 'doc.pdf.pages',
    title: 'PDF page count and text',
    description: 'How many pages a PDF has, plus the first characters of each page.',
    category: 'documents',
    permission: 'read',
    tags: ['pdf', 'pages'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, perPageChars: { type: 'integer', default: 300, minimum: 0, maximum: 5000 } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('not a PDF file', 'NOT_A_PDF');
      const { pages, text } = pdfText(buffer);
      const declared = Number((buffer.toString('latin1').match(/\/Count\s+(\d+)/) || [])[1] || 0);
      return {
        path: args.path,
        pageCount: pages.length || declared,
        extractedPages: pages.length,
        characters: text.length,
        pages: pages.slice(0, 50).map((page, index) => ({ page: index + 1, preview: truncate(page, args.perPageChars) })),
      };
    },
  },
  {
    name: 'doc.docx.outline',
    title: 'DOCX outline',
    description: 'Headings and paragraph count of a Word document.',
    category: 'documents',
    permission: 'read',
    tags: ['docx', 'word', 'outline'],
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const entries = readZipDirectory(buffer);
      const document = entries.find((entry) => entry.name === 'word/document.xml');
      if (!document) throw fail('not a DOCX file', 'NOT_A_DOCX');
      const xml = inflateEntry(buffer, document).toString('utf8');
      const headings = [...xml.matchAll(/<w:p[\s>][\s\S]*?<w:pStyle w:val="Heading(\d)"[\s\S]*?<\/w:p>/g)].map((match) => ({
        level: Number(match[1]),
        text: xmlToText(match[0]).trim(),
      }));
      return { path: args.path, headings: headings.slice(0, 100), paragraphs: (xml.match(/<w:p[ >]/g) || []).length };
    },
  },
  {
    name: 'doc.xlsx.rows',
    title: 'Read a spreadsheet',
    description: 'Rows from the first sheet of an XLSX file, or a CSV file.',
    category: 'documents',
    permission: 'read',
    tags: ['xlsx', 'excel', 'csv', 'spreadsheet'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, maxRows: { type: 'integer', default: 40, minimum: 1, maximum: 1000 } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const extension = path.extname(args.path).toLowerCase();
      if (extension === '.csv' || extension === '.tsv') {
        const parsed = parseCsv(buffer.toString('utf8'), { maxRows: args.maxRows, delimiter: extension === '.tsv' ? '\t' : null });
        return { kind: 'csv', delimiter: parsed.delimiter, rows: parsed.rows.length, columns: parsed.rows[0] ? parsed.rows[0].length : 0, data: parsed.rows };
      }
      const { rows } = xlsxRows(buffer, { maxRows: args.maxRows });
      return { kind: 'xlsx', rows: rows.length, columns: rows[0] ? rows[0].length : 0, data: rows };
    },
    format(data) {
      return `${data.kind}: ${data.rows} rows × ${data.columns} columns\n${data.data.map((row) => row.join(' | ')).join('\n')}`;
    },
  },
  {
    name: 'doc.csv.stats',
    title: 'CSV column statistics',
    description: 'Header, row count and min/max/mean for numeric columns of a CSV.',
    category: 'documents',
    permission: 'read',
    tags: ['csv', 'statistics', 'analysis'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, delimiter: { type: 'string', maxLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const info = await readTextFile(args.path, { maxBytes: 4000000 });
      const parsed = parseCsv(info.text, { delimiter: args.delimiter, maxRows: 20000 });
      const header = parsed.rows[0] || [];
      const body = parsed.rows.slice(1);
      const columns = header.map((name, index) => {
        const values = body.map((row) => row[index]).filter((value) => value !== undefined && value !== '');
        const numbers = values.map(Number).filter((value) => Number.isFinite(value));
        const numeric = values.length > 0 && numbers.length / values.length > 0.8;
        return {
          name: name || `column_${index + 1}`,
          type: numeric ? 'number' : 'text',
          filled: values.length,
          unique: new Set(values).size,
          ...(numeric
            ? {
                min: Math.min(...numbers),
                max: Math.max(...numbers),
                mean: Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(3)),
              }
            : { sample: values.slice(0, 3) }),
        };
      });
      return { path: args.path, delimiter: parsed.delimiter, rows: body.length, columns };
    },
  },
  {
    name: 'doc.json.query',
    title: 'Inspect JSON',
    description: 'Validate JSON and read a value by dot path (a.b[0].c), or summarise its structure.',
    category: 'documents',
    permission: 'read',
    tags: ['json', 'query', 'validate'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string', description: 'dot path such as config.ai.mode', maxLength: 300 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const info = await readTextFile(args.path, { maxBytes: 4000000 });
      let parsed;
      try {
        parsed = JSON.parse(info.text);
      } catch (err) {
        const line = err.message.match(/position (\d+)/);
        const offset = line ? Number(line[1]) : 0;
        const near = info.text.slice(Math.max(0, offset - 80), offset + 80);
        throw fail(`${err.message}${near ? ` near: ${near.replace(/\n/g, ' ')}` : ''}`, 'INVALID_JSON');
      }
      if (!args.query) return { valid: true, structure: summariseJson(parsed), bytes: info.bytes };
      const parts = args.query.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      let current = parsed;
      const walked = [];
      for (const part of parts) {
        if (current === null || current === undefined) {
          throw fail(`nothing at ${walked.join('.') || 'root'}`, 'NOT_FOUND');
        }
        current = current[part];
        walked.push(part);
      }
      return { valid: true, query: args.query, found: current !== undefined, value: truncate(JSON.stringify(current, null, 2), 20000) };
    },
    format: (data) => (data.query ? String(data.value) : JSON.stringify(data.structure, null, 2)),
  },
  {
    name: 'doc.log.analyze',
    title: 'Analyse a log file',
    description: 'Level counts, time range, most frequent errors and samples from a log file or pasted text.',
    category: 'documents',
    permission: 'read',
    tags: ['log', 'errors', 'diagnostics'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, text: { type: 'string', maxLength: 200000 } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      let text = args.text;
      if (!text) {
        if (!args.path) throw fail('give a path or text', 'BAD_ARGS');
        text = (await readTextFile(args.path, { maxBytes: 4000000 })).text;
      }
      return { source: args.path || 'inline', ...analyseLog(text) };
    },
    format(data) {
      return [
        `${data.lines} lines, ${data.firstTimestamp || '?'} → ${data.lastTimestamp || '?'}`,
        `levels: ${Object.entries(data.levels).map(([level, count]) => `${level}=${count}`).join(' ') || 'none detected'}`,
        ...data.topErrors.map((entry) => `  ×${entry.count} ${entry.message}`),
      ].join('\n');
    },
  },
  {
    name: 'doc.log.tail',
    title: 'Tail a log',
    description: 'Last N lines of a log file, optionally filtered by a keyword.',
    category: 'documents',
    permission: 'read',
    tags: ['log', 'tail'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        lines: { type: 'integer', default: 40, minimum: 1, maximum: 500 },
        filter: { type: 'string', maxLength: 120 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const info = await readTextFile(args.path, { maxBytes: 8000000 });
      let lines = info.text.split(/\r?\n/);
      if (args.filter) lines = lines.filter((line) => line.toLowerCase().includes(args.filter.toLowerCase()));
      return { path: args.path, totalLines: info.text.split(/\r?\n/).length, lines: lines.slice(-args.lines) };
    },
    format: (data) => data.lines.join('\n'),
  },
  {
    name: 'doc.encoding.detect',
    title: 'Detect file encoding',
    description: 'Is this file UTF-8, UTF-16 or Windows-1250? Useful before editing Polish text files.',
    category: 'documents',
    permission: 'read',
    tags: ['encoding', 'utf-8', 'windows-1250'],
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const decoded = decodeText(buffer);
      return {
        path: args.path,
        encoding: decoded.encoding,
        bytes: buffer.length,
        hasBom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
        nonAsciiBytes: buffer.filter((byte) => byte > 127).length,
        sample: truncate(decoded.text, 200),
      };
    },
  },
  {
    name: 'doc.encoding.convert',
    title: 'Convert a file to UTF-8',
    description: 'Read a Windows-1250/1252 file and rewrite it as UTF-8 (or the reverse). Requires approval.',
    category: 'documents',
    permission: 'system',
    tags: ['encoding', 'convert', 'utf-8'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        to: { type: 'string', enum: ['utf-8', 'utf-8-bom', 'windows-1250'], default: 'utf-8' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'write' }],
    async run(args) {
      const buffer = await fsp.readFile(args.path);
      const decoded = decodeText(buffer);
      let output;
      if (args.to === 'windows-1250') {
        const table = [...decoded.text].map((char) => {
          const code = char.codePointAt(0);
          return code < 128 ? code : 0x3f;
        });
        output = Buffer.from(table);
      } else {
        const body = Buffer.from(decoded.text, 'utf8');
        output = args.to === 'utf-8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
      }
      const target = args.overwrite ? args.path : `${args.path}.utf8`;
      await fsp.writeFile(target, output);
      return { source: args.path, target, from: decoded.encoding, to: args.to, bytes: output.length, charactersLost: args.to === 'windows-1250' ? 'non-Latin-1 characters become ?' : null };
    },
  },
  {
    name: 'doc.markdown.toc',
    title: 'Markdown table of contents',
    description: 'Headings of a Markdown file with line numbers, ready to paste as a TOC.',
    category: 'documents',
    permission: 'read',
    tags: ['markdown', 'toc', 'headings'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, maxLevel: { type: 'integer', default: 3, minimum: 1, maximum: 6 } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const info = await readTextFile(args.path, { maxBytes: 2000000 });
      const headings = [];
      info.text.split(/\r?\n/).forEach((line, index) => {
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match && match[1].length <= args.maxLevel) {
          const title = match[2].trim();
          const anchor = title.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-');
          headings.push({ level: match[1].length, title, line: index + 1, link: `#${anchor}` });
        }
      });
      return { path: args.path, headings };
    },
    format: (data) => data.headings.map((heading) => `${'  '.repeat(heading.level - 1)}- [${heading.title}](${heading.link})`).join('\n'),
  },
];
