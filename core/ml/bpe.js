'use strict';

/**
 * Byte-level byte-pair encoding.
 *
 * The vocabulary starts with all 256 byte values, so any UTF-8 text can be
 * encoded without an unknown token. Training learns merges from the supplied
 * corpus; encoding applies those merges in learned order and decoding walks the
 * byte expansion. This is a real tokenizer, not a word splitter with a renamed
 * vocabulary.
 *
 * A merge is `{a, b, id, bytes}` where `id >= 256`. `bytes` is the UTF-8 byte
 * sequence that the merged token expands to.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 'sentinel-bpe-v1';
const BASE = 256;

function toBytes(text) {
  return [...Buffer.from(String(text), 'utf8')];
}

function mergeSequence(ids, a, b, id) {
  const out = [];
  for (let index = 0; index < ids.length; index += 1) {
    if (index + 1 < ids.length && ids[index] === a && ids[index + 1] === b) {
      out.push(id);
      index += 1;
    } else {
      out.push(ids[index]);
    }
  }
  return out;
}

/** Count adjacent pairs across a bounded corpus. */
function pairCounts(sequences) {
  const counts = new Map();
  for (const ids of sequences) {
    for (let index = 0; index < ids.length - 1; index += 1) {
      const key = `${ids[index]},${ids[index + 1]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Learn BPE merges. Deterministic tie-breaking is by pair frequency, then by
 * the numeric pair, so the same corpus and settings always produce the same
 * vocabulary.
 */
function trainBpe(texts, { vocabSize = 512, minFrequency = 2, maxTrainingBytes = 200000 } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) throw Object.assign(new Error('BPE training needs text'), { code: 'NO_TEXT' });
  if (!Number.isInteger(vocabSize) || vocabSize < BASE + 1 || vocabSize > 65536) throw Object.assign(new Error('vocabSize must be between 257 and 65536'), { code: 'BAD_VOCAB' });
  if (!Number.isInteger(minFrequency) || minFrequency < 1) throw Object.assign(new Error('minFrequency must be positive'), { code: 'BAD_VOCAB' });
  const sequences = [];
  let consumed = 0;
  for (const text of list) {
    const bytes = toBytes(text);
    if (!bytes.length) continue;
    const remaining = Math.max(0, maxTrainingBytes - consumed);
    if (!remaining) break;
    const slice = bytes.slice(0, remaining);
    consumed += slice.length;
    sequences.push(slice);
  }
  if (!sequences.length) throw Object.assign(new Error('BPE training text is empty'), { code: 'NO_TEXT' });
  const merges = [];
  const expansions = new Map();
  for (let byte = 0; byte < BASE; byte += 1) expansions.set(byte, [byte]);
  while (BASE + merges.length < vocabSize) {
    const counts = pairCounts(sequences);
    let best = null;
    for (const [key, count] of counts) {
      if (count < minFrequency) continue;
      const [a, b] = key.split(',').map(Number);
      if (!best || count > best.count || (count === best.count && (a < best.a || (a === best.a && b < best.b)))) best = { a, b, count };
    }
    if (!best) break;
    const id = BASE + merges.length;
    const bytes = [...expansions.get(best.a), ...expansions.get(best.b)];
    merges.push({ a: best.a, b: best.b, id, count: best.count, bytes });
    expansions.set(id, bytes);
    for (let index = 0; index < sequences.length; index += 1) {
      sequences[index] = mergeSequence(sequences[index], best.a, best.b, id);
    }
  }
  return {
    format: FORMAT,
    base: BASE,
    merges,
    vocabSize: BASE + merges.length,
    trainedBytes: consumed,
    sampleCount: sequences.length,
    minFrequency,
    status: 'trained',
  };
}

function validate(tokenizer) {
  if (!tokenizer || tokenizer.format !== FORMAT) throw Object.assign(new Error('unsupported BPE tokenizer format'), { code: 'BAD_TOKENIZER' });
  if (!Array.isArray(tokenizer.merges)) throw Object.assign(new Error('tokenizer has no merge table'), { code: 'BAD_TOKENIZER' });
  let expected = BASE;
  for (const merge of tokenizer.merges) {
    if (merge.id !== expected) throw Object.assign(new Error('tokenizer merge ids are not contiguous'), { code: 'BAD_TOKENIZER' });
    if (!Number.isInteger(merge.a) || !Number.isInteger(merge.b)) throw Object.assign(new Error('tokenizer merge is malformed'), { code: 'BAD_TOKENIZER' });
    expected += 1;
  }
  if (tokenizer.vocabSize !== expected) throw Object.assign(new Error('tokenizer vocabSize does not match its merges'), { code: 'BAD_TOKENIZER' });
  return tokenizer;
}

function encode(text, tokenizer) {
  validate(tokenizer);
  let ids = toBytes(text);
  for (const merge of tokenizer.merges) ids = mergeSequence(ids, merge.a, merge.b, merge.id);
  return ids;
}

function decode(ids, tokenizer) {
  validate(tokenizer);
  if (!Array.isArray(ids)) throw Object.assign(new Error('decode expects token ids'), { code: 'BAD_IDS' });
  const expansions = new Map();
  for (let byte = 0; byte < BASE; byte += 1) expansions.set(byte, [byte]);
  for (const merge of tokenizer.merges) {
    if (!Array.isArray(merge.bytes) || merge.bytes.length < 2) throw Object.assign(new Error(`merge ${merge.id} has no byte expansion`), { code: 'BAD_TOKENIZER' });
    expansions.set(merge.id, merge.bytes);
  }
  const bytes = [];
  for (const id of ids) {
    if (!expansions.has(id)) throw Object.assign(new Error(`unknown token id ${id}`), { code: 'UNKNOWN_TOKEN' });
    bytes.push(...expansions.get(id));
  }
  return Buffer.from(bytes).toString('utf8');
}

function tokenCount(text, tokenizer) {
  return encode(text, tokenizer).length;
}

function save(tokenizer, file) {
  validate(tokenizer);
  const text = JSON.stringify(tokenizer);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { ok: true, file, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), vocabSize: tokenizer.vocabSize };
}

function load(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validate(payload);
}

module.exports = { FORMAT, BASE, trainBpe, encode, decode, tokenCount, save, load, validate };
