'use strict';

/**
 * Deterministic text features for the small models in this repository.
 *
 * The feature space is hashed word unigrams plus character 4-grams. Character
 * n-grams are what make the classifier resilient to Polish diacritics being
 * dropped, typos and inflection; they are not a substitute for a tokenizer and
 * this file says so rather than pretending to be one.
 */

const FEATURE_VERSION = 'hashed-ngram-v1';
const DEFAULT_DIM = 384;

function fold(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

function tokens(text) {
  return fold(text).split(/[^a-z0-9ąćęłńóśźż]+/u).filter(Boolean);
}

/** FNV-1a 32-bit: stable across processes and platforms. */
function hash(value) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result >>> 0;
}

function vectorize(text, { dim = DEFAULT_DIM } = {}) {
  const vector = new Float64Array(dim);
  const words = tokens(text);
  for (const word of words) {
    const key = hash(`w:${word}`) % dim;
    vector[key] += 1;
    // Character 4-grams with boundary markers: catches typos and inflection.
    const padded = `^${word}$`;
    for (let index = 0; index + 4 <= padded.length; index += 1) {
      const gram = padded.slice(index, index + 4);
      vector[hash(`c:${gram}`) % dim] += 0.35;
    }
  }
  // L2 normalise so document length does not dominate.
  let norm = 0;
  for (let index = 0; index < dim; index += 1) norm += vector[index] * vector[index];
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dim; index += 1) vector[index] /= norm;
  return vector;
}

function cosine(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

module.exports = { FEATURE_VERSION, DEFAULT_DIM, vectorize, tokens, fold, hash, cosine };
