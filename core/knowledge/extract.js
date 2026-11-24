'use strict';

/**
 * Document text extraction, shared by the document tools and the knowledge
 * indexer. Self-contained: zlib plus the ZIP reader, no external binaries, so
 * indexing a folder of PDFs/DOCX/XLSX works offline on a clean machine.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { decodeText, truncate } = require('../tools/helpers');
const { readZipDirectory, inflateEntry } = require('../tools/files.tools');

const fail = (message, code) => Object.assign(new Error(message), { code });

function xmlToText(xml) {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extracts text from a PDF by inflating content streams and reading Tj/TJ. */
function pdfText(buffer) {
  const pages = [];
  const objects = [];
  const objectRegex = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = objectRegex.exec(buffer.toString('latin1')))) {
    objects.push({ index: match.index, header: match[0] });
  }
  const raw = buffer.toString('latin1');
  const streamRegex = /stream\r?\n/g;
  let streamMatch;
  while ((streamMatch = streamRegex.exec(raw))) {
    const start = streamMatch.index + streamMatch[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const headerStart = raw.lastIndexOf(' obj', start);
    const dict = raw.slice(Math.max(0, headerStart), start);
    if (!/\/FlateDecode/.test(dict) && !/\/Filter/.test(dict)) continue;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    let text = '';
    try {
      text = zlib.inflateSync(chunk).toString('latin1');
    } catch {
      try {
        text = zlib.inflateSync(chunk.subarray(0, chunk.length - 1)).toString('latin1');
      } catch {
        continue;
      }
    }
    if (!/(Tj|TJ)/.test(text)) continue;
    const collected = [];
    const tokenRegex = /\((?:[^()\\]|\\.)*\)\s*Tj|\[(?:[^\][]|\\.)*\]\s*TJ|T\*|Td|TD/g;
    let token;
    while ((token = tokenRegex.exec(text))) {
      const piece = token[0];
      if (piece.endsWith('Tj')) {
        const literal = piece.slice(piece.indexOf('(') + 1, piece.lastIndexOf(')'));
        collected.push(unescapePdf(literal));
      } else if (piece.endsWith('TJ')) {
        const inner = piece.slice(piece.indexOf('[') + 1, piece.lastIndexOf(']'));
        const parts = inner.match(/\((?:[^()\\]|\\.)*\)|-?\d+(?:\.\d+)?/g) || [];
        collected.push(
          parts
            .map((part) => (part.startsWith('(') ? unescapePdf(part.slice(1, -1)) : Number(part) < -200 ? ' ' : ''))
            .join(''),
        );
      }
      if (piece === 'T*' || piece === 'Td' || piece === 'TD') collected.push('\n');
    }
    const pageText = collected.join('').replace(/\n{3,}/g, '\n\n').trim();
    if (pageText) pages.push(pageText);
  }
  return { pages, text: pages.join('\n\n') };
}

function unescapePdf(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/** Reads the text runs of a DOCX (word/document.xml inside the zip). */
function docxText(buffer) {
  const entries = readZipDirectory(buffer);
  const document = entries.find((entry) => entry.name === 'word/document.xml');
  if (!document) throw fail('this is not a DOCX (no word/document.xml)', 'NOT_A_DOCX');
  const xml = inflateEntry(buffer, document).toString('utf8');
  const text = xmlToText(xml).replace(/\n{3,}/g, '\n\n').trim();
  return { text, paragraphs: (xml.match(/<w:p[ >]/g) || []).length };
}

/** Reads the first sheet of an XLSX into rows, using shared strings. */
function xlsxRows(buffer, { maxRows = 500 } = {}) {
  const entries = readZipDirectory(buffer);
  const shared = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  const sheet = entries.find((entry) => /^xl\/worksheets\/sheet1\.xml$/.test(entry.name)) || entries.find((entry) => /^xl\/worksheets\/.*\.xml$/.test(entry.name));
  if (!sheet) throw fail('this XLSX has no worksheets', 'NOT_AN_XLSX');
  const strings = shared
    ? [...inflateEntry(buffer, shared).toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
        match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      )
    : [];
  const xml = inflateEntry(buffer, sheet).toString('utf8');
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s+([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const type = (attributes.match(/t="([^"]+)"/) || [])[1];
      const valueMatch = cellMatch[2].match(/<v>([\s\S]*?)<\/v>/);
      const inline = cellMatch[2].match(/<is>([\s\S]*?)<\/is>/);
      let value = valueMatch ? valueMatch[1] : inline ? inline[1].replace(/<[^>]+>/g, '') : '';
      if (type === 's') value = strings[Number(value)] || '';
      cells.push(value);
    }
    if (cells.some((cell) => String(cell).trim())) rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return { rows, sharedStrings: strings.length };
}

/** CSV with quoted-field support (semicolon or comma delimited). */
function parseCsv(text, { delimiter = null, maxRows = 2000 } = {}) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const guess = delimiter || (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === guess) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= maxRows) break;
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, delimiter: guess };
}

function summariseJson(value, depth = 0, name = 'root') {
  if (depth > 2) return { type: Array.isArray(value) ? 'array' : typeof value };
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sample: value.slice(0, 2).map((item) => summariseJson(item, depth + 1)) };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 30), children: Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, inner]) => [key, summariseJson(inner, depth + 1, `${name}.${key}`)])) };
  }
  return { type: typeof value, example: typeof value === 'string' ? truncate(value, 80) : value };
}

const LOG_LEVEL_REGEX = /\b(FATAL|CRITICAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE|NOTICE)\b/i;

function analyseLog(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const levels = {};
  const messages = new Map();
  const timestamps = [];
  const errors = [];
  for (const line of lines) {
    const levelMatch = line.match(LOG_LEVEL_REGEX);
    if (levelMatch) {
      const level = levelMatch[1].toUpperCase().replace('WARNING', 'WARN').replace('ERR', 'ERROR');
      levels[level] = (levels[level] || 0) + 1;
    }
    const stamp = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
    if (stamp) timestamps.push(stamp[1]);
    const normalised = line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?/g, '<ts>')
      .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
      .replace(/\b\d+\b/g, '<n>')
      .replace(/[A-Za-z]:\\[^\s:]+/g, '<path>')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (levelMatch && /FATAL|CRITICAL|ERROR|ERR/i.test(levelMatch[1])) {
      messages.set(normalised, (messages.get(normalised) || 0) + 1);
      if (errors.length < 30) errors.push(truncate(line.trim(), 240));
    }
  }
  return {
    lines: lines.length,
    levels,
    firstTimestamp: timestamps[0] || null,
    lastTimestamp: timestamps[timestamps.length - 1] || null,
    topErrors: [...messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([message, count]) => ({ message, count })),
    samples: errors,
  };
}

async function loadDocument(file, maxBytes = 8000000) {
  const buffer = await fsp.readFile(file);
  if (buffer.length > maxBytes) throw fail(`file is larger than ${(maxBytes / 1e6).toFixed(0)} MB`, 'TOO_LARGE');
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pdf') {
    const { pages, text } = pdfText(buffer);
    return { kind: 'pdf', text, pages: pages.length, note: text.trim() ? null : 'no extractable text — this PDF is probably scanned images (OCR needed)' };
  }
  if (extension === '.docx') {
    const { text, paragraphs } = docxText(buffer);
    return { kind: 'docx', text, paragraphs };
  }
  if (extension === '.xlsx') {
    const { rows } = xlsxRows(buffer);
    return { kind: 'xlsx', text: rows.map((row) => row.join('\t')).join('\n'), rows: rows.length };
  }
  if (extension === '.doc') throw fail('legacy .doc is not supported — save it as .docx', 'UNSUPPORTED_FORMAT');
  const decoded = decodeText(buffer);
  return { kind: 'text', text: decoded.text, encoding: decoded.encoding };
}


module.exports = { pdfText, docxText, xlsxRows, parseCsv, analyseLog, loadDocument, xmlToText, summariseJson };
