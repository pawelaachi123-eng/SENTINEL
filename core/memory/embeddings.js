'use strict';

/**
 * Local embeddings.
 *
 * SENTINEL must work offline, so the default embedder is a deterministic
 * feature-hashing vectoriser: words, character n-grams and word bigrams are
 * hashed into a fixed number of buckets with signed weights, sublinear term
 * frequency, and L2 normalisation. No model download, no service, no network —
 * and it is genuinely useful for "find the thing I said yesterday about the
 * GPU", especially fused with BM25.
 *
 * When a real embedding model is configured (Ollama, LM Studio, llama.cpp), the
 * same interface is served by the model provider; records remember which
 * embedder produced their vector, because vectors from different spaces must
 * never be compared.
 */

const STOPWORDS = new Set([
  // english
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'without', 'from', 'into', 'over', 'under', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'have', 'has', 'had', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'as', 'not', 'no', 'can', 'could', 'would', 'should',
  'will', 'just', 'about', 'what', 'how', 'why', 'when', 'where', 'which', 'who', 'there', 'here', 'also',
  // polish
  'i', 'w', 'na', 'do', 'z', 'ze', 'że', 'się', 'to', 'jest', 'są', 'być', 'nie', 'tak', 'jak', 'co', 'czy',
  'ale', 'lub', 'oraz', 'dla', 'od', 'po', 'przez', 'tym', 'tego', 'ta', 'ten', 'te', 'mi', 'mnie', 'ja', 'ty',
  'on', 'ona', 'my', 'wy', 'oni', 'mi', 'już', 'jeszcze', 'bardzo', 'może', 'był', 'była', 'było', 'będzie',
]);

const DIACRITICS = /[\u0300-\u036f]/g;

/** Lowercase, fold Polish/Latin diacritics, keep alphanumerics. */
function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase();
}

function tokenize(text) {
  const folded = fold(text);
  const words = folded.split(/[^a-z0-9+#._-]+/g).filter((word) => word.length > 1 && !STOPWORDS.has(word));
  const out = [];
  for (const word of words) {
    out.push(word);
    // Identifiers and model names are hyphenated/dotted: "aes-256-gcm",
    // "qwen3.5:9b", "nomic-embed-text". Index the parts too, so a question
    // about "AES" finds them.
    if (/[-._+#]/.test(word)) {
      for (const part of word.split(/[-._+#]+/)) {
        if (part.length > 1 && !STOPWORDS.has(part)) out.push(part);
      }
    }
    const clean = word.replace(/[^a-z0-9]/g, '');
    if (clean.length >= 4) {
      for (let i = 0; i + 3 <= clean.length; i += 1) out.push(`#${clean.slice(i, i + 3)}`);
    }
  }
  for (let i = 0; i + 1 < words.length; i += 1) out.push(`_${words[i]}_${words[i + 1]}`);
  return out;
}

/**
 * Query expansion for the words people actually use. A hashed embedder cannot
 * know that "gpu" and "4060 Ti" are related, and neither can BM25 — so related
 * terms are added explicitly, in both directions. Deterministic, auditable and
 * limited to vocabulary SENTINEL genuinely deals with.
 */
const ALIAS_GROUPS = [
  ['gpu', 'graphics', 'rtx', 'gtx', 'radeon', 'nvidia', 'vram', 'karta', 'graficzna'],
  ['cpu', 'processor', 'procesor', 'ryzen', 'intel', 'core', 'i7', 'i9'],
  ['ram', 'memory', 'pamiec', 'pamięć', 'ddr4', 'ddr5'],
  ['disk', 'dysk', 'ssd', 'hdd', 'nvme', 'storage', 'dyskietka'],
  ['psu', 'zasilacz', 'power', 'supply', 'watt', 'wat'],
  ['motherboard', 'plyta', 'płyta', 'bios', 'uefi', 'chipset'],
  ['wifi', 'wi-fi', 'wireless', 'siec', 'sieć', 'network', 'lan', 'ethernet'],
  ['ip', 'adres', 'address', 'host', 'hostname'],
  ['esp32', 'esp', 'firmware', 'mikrokontroler', 'bridge', 'most'],
  ['shutdown', 'wylacz', 'wyłącz', 'poweroff', 'off', 'zamknij'],
  ['reboot', 'restart', 'uruchom', 'ponownie', 'reset'],
  ['error', 'blad', 'błąd', 'exception', 'fail', 'failure', 'awaria'],
  ['fix', 'napraw', 'repair', 'solution', 'rozwiazanie', 'rozwiązanie'],
  ['test', 'testy', 'testing', 'sprawdz', 'sprawdź', 'check'],
  ['memory', 'pamiec', 'pamięć', 'recall', 'remember', 'zapamietaj', 'zapamiętaj'],
  ['file', 'plik', 'pliki', 'folder', 'directory', 'katalog', 'path', 'sciezka', 'ścieżka'],
  ['git', 'commit', 'branch', 'repo', 'repository', 'merge', 'diff'],
  ['code', 'kod', 'source', 'zrodlo', 'źródło', 'function', 'funkcja', 'bug'],
  ['voice', 'glos', 'głos', 'speech', 'mowa', 'audio', 'microphone', 'mikrofon'],
  ['screen', 'ekran', 'display', 'monitor', 'resolution', 'rozdzielczosc'],
  ['security', 'bezpieczenstwo', 'bezpieczeństwo', 'policy', 'polityka', 'permission', 'uprawnienia'],
  ['backup', 'kopia', 'kopie', 'restore', 'przywroc', 'przywróć', 'archive'],
  ['model', 'llm', 'ollama', 'qwen', 'llama', 'inference', 'ai'],
  ['slow', 'wolno', 'performance', 'wydajnosc', 'wydajność', 'lag', 'opoznienie'],
  ['temperature', 'temperatura', 'temp', 'thermal', 'thermal throttling', 'chlodzenie'],
];

const ALIAS_MAP = (() => {
  const map = new Map();
  for (const group of ALIAS_GROUPS) {
    for (const term of group) {
      if (!map.has(term)) map.set(term, new Set());
      for (const other of group) if (other !== term) map.get(term).add(other);
    }
  }
  return map;
})();

/** Adds related vocabulary to a query so lexical and vector search both see it. */
function expandQuery(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9ąćęłńóśźż-]+/i);
  const extra = new Set();
  for (const token of tokens) {
    const aliases = ALIAS_MAP.get(token);
    if (aliases) for (const alias of aliases) extra.add(alias);
  }
  if (!extra.size) return String(text || '');
  return `${text} ${[...extra].join(' ')}`;
}

/** FNV-1a: stable across processes and platforms. */
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

class HashingEmbedder {
  constructor({ dim = 384 } = {}) {
    this.dim = dim;
    this.name = `hash-${dim}`;
    this.provider = 'local';
  }

  /**
   * @param {string[]} texts
   * @returns {Float32Array[]}
   */
  embed(texts) {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text) {
    const vector = new Float32Array(this.dim);
    const counts = new Map();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) || 0) + 1);
    for (const [token, count] of counts) {
      const weight = 1 + Math.log(count);
      const h1 = hash32(token);
      const h2 = hash32(`s:${token}`);
      const bucket = h1 % this.dim;
      const sign = h2 & 1 ? 1 : -1;
      vector[bucket] += sign * weight;
    }
    return normalise(vector);
  }
}

function normalise(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ── vector serialisation (SQLite/JSONL both store strings) ────────────── */

function encodeVector(vector) {
  const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  return bytes.toString('base64');
}

function decodeVector(text) {
  if (!text) return null;
  const bytes = Buffer.from(String(text), 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Wraps a model provider so memory can use real embeddings when one exists.
 * Falls back to the hashing embedder on any failure and says so in `lastError`
 * instead of pretending the vector is comparable.
 */
class ModelEmbedder {
  constructor({ llm, model, fallback, log }) {
    this.llm = llm;
    this.model = model;
    this.fallback = fallback || new HashingEmbedder();
    this.log = log;
    this.provider = 'model';
    this.name = `model-${model || 'auto'}`;
    this.dim = null;
    this.lastError = null;
    this.failures = 0;
  }

  async embed(texts) {
    if (this.failures > 2) return this.fallback.embed(texts);
    try {
      const vectors = await this.llm.embed({ input: texts, model: this.model });
      if (!vectors || !vectors.length) throw new Error('the model returned no vectors');
      this.dim = vectors[0].length;
      this.name = `model-${model || 'auto'}-${this.dim}`;
      this.lastError = null;
      return vectors.map((vector) => Float32Array.from(vector));
    } catch (err) {
      this.failures += 1;
      this.lastError = err.message;
      if (this.log) this.log.warn('memory', `model embeddings unavailable (${err.message}); using local hashing`);
      return this.fallback.embed(texts);
    }
  }

  embedOne(text) {
    return this.embed([text]).then((list) => list[0]);
  }
}

module.exports = {
  expandQuery,
  ALIAS_GROUPS,
  HashingEmbedder,
  ModelEmbedder,
  tokenize,
  fold,
  cosine,
  normalise,
  encodeVector,
  decodeVector,
  hash32,
  STOPWORDS,
};
