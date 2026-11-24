'use strict';

/**
 * Neural learning laboratory.
 *
 * Scope, stated honestly: this trains small CPU networks on small, reviewed,
 * synthetic datasets. It is not a LoRA trainer for a 9B model and it does not
 * pretend to be one. What it does do is real:
 *
 *   • a deterministic split with deduplication and a contamination check;
 *   • a keyword baseline that the network must beat on the held-out test set;
 *   • a genuine forward pass, softmax cross-entropy, backpropagation and Adam;
 *   • early stopping on validation loss and a saved checkpoint with checksum;
 *   • measured accuracy, macro-F1, per-class recall and a confusion matrix;
 *   • weights written outside the source tree, under SENTINEL_HOME/models;
 *   • promotion only after explicit human approval, with rollback.
 *
 * Training is never triggered by conversation content. The dataset is bundled
 * and the caller must pass an approving identity.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataset = require('./ml/data/intents');
const { FEATURE_VERSION, vectorize, tokens } = require('./ml/features');
const mlp = require('./ml/mlp');

const LABELS = [...new Set(dataset.items.map((item) => item.intent))].sort();
const near = (a, b) => {
  const grams = (text) => {
    const value = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    const set = new Set();
    for (const word of value.split(' ')) for (let index = 0; index + 4 <= word.length; index += 1) set.add(word.slice(index, index + 4));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return common / (left.size + right.size - common);
};

const KEYWORDS = {
  status: ['stan', 'cpu', 'ram', 'pamiec', 'pami', 'gpu', 'dysk', 'bater', 'status', 'memory', 'disk', 'temperature', 'load'],
  files: ['plik', 'file', 'folder', 'katalog', 'directory', 'kopiuj', 'copy', 'move', 'przenies', 'download', 'pobrane', 'log'],
  memory: ['pamietaj', 'remember', 'przypomnij', 'recall', 'forget', 'zapomnij', 'preferenc', 'ustalenia', 'agree'],
  code: ['kod', 'code', 'blad', 'bug', 'funkcj', 'function', 'test', 'refactor', 'dokumentacj', 'documentation', 'variable'],
  documents: ['pdf', 'dokument', 'document', 'umow', 'contract', 'raport', 'report', 'notat', 'notes', 'tabel', 'table', 'streszcz', 'summar'],
  network: ['internet', 'wifi', 'siec', 'network', 'ip', 'ping', 'port', 'dns', 'host', 'polacz', 'connect'],
  planning: ['plan', 'zaplanuj', 'schedule', 'krok', 'step', 'zadani', 'task', 'harmonogram', 'organize', 'first'],
  security: ['bezpiecz', 'secure', 'security', 'podejrzan', 'suspicious', 'login', 'uprawnieni', 'permission', 'firewall', 'backup'],
  learning: ['trenuj', 'train', 'model', 'baseline', 'walidacj', 'validation', 'checkpoint', 'rollback', 'wycofaj'],
  chat: ['masz', 'thanks', 'dziek', 'hello', 'hej', 'dobranoc', 'night', 'kim jestes', 'who are you', 'slychac'],
};

function baselinePredict(text) {
  const folded = tokens(text).join(' ');
  let best = { intent: 'chat', score: 0 };
  for (const [intent, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const word of words) if (folded.includes(word)) score += 1;
    if (score > best.score) best = { intent, score };
  }
  return best.intent;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function macroF1(truth, predicted, labels) {
  const scores = [];
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let index = 0; index < truth.length; index += 1) {
      const actual = truth[index] === label;
      const guess = predicted[index] === label;
      if (actual && guess) tp += 1;
      else if (!actual && guess) fp += 1;
      else if (actual && !guess) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    scores.push(precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  }
  return scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
}

function confusion(truth, predicted, labels) {
  const matrix = labels.map(() => labels.map(() => 0));
  for (let index = 0; index < truth.length; index += 1) {
    const actual = labels.indexOf(truth[index]);
    const guess = labels.indexOf(predicted[index]);
    if (actual >= 0 && guess >= 0) matrix[actual][guess] += 1;
  }
  return matrix;
}

function metricsFor(truth, predicted, labels = LABELS) {
  let correct = 0;
  for (let index = 0; index < truth.length; index += 1) if (truth[index] === predicted[index]) correct += 1;
  const perClass = {};
  for (const label of labels) {
    const total = truth.filter((value) => value === label).length;
    const hits = truth.filter((value, index) => value === label && predicted[index] === label).length;
    perClass[label] = { support: total, recall: total ? Number((hits / total).toFixed(3)) : 0, hits };
  }
  return { cases: truth.length, correct, accuracy: truth.length ? Number((correct / truth.length).toFixed(3)) : 0, macroF1: Number(macroF1(truth, predicted, labels).toFixed(3)), perClass, confusion: confusion(truth, predicted, labels) };
}

class LearningLab {
  constructor({ paths, store = null, log = null, now = () => Date.now(), data = dataset } = {}) {
    this.paths = paths;
    this.store = store;
    this.log = log;
    this.now = now;
    this.data = data;
    this.cache = { network: null, experiment: null };
    this.experimentCache = new Map();
    this.activeRecord = null;
    this.counters = { trainings: 0, refused: 0, promotions: 0, rollbacks: 0, predictions: 0 };
  }

  modelsDir() {
    const dir = path.join(this.paths.dataDir(), 'models');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  items() {
    return this.data.items.filter((item) => item && typeof item.text === 'string' && LABELS.includes(item.intent));
  }

  datasetHash() {
    return hash(JSON.stringify(this.items().map((item) => [item.text, item.intent, item.lang || null])));
  }

  /** Deterministic, stratified 70/15/15 split with deduplication. */
  split() {
    const seen = new Set();
    const unique = [];
    const duplicates = [];
    for (const item of this.items()) {
      const key = item.text.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
      if (seen.has(key)) {
        duplicates.push(item.text);
        continue;
      }
      seen.add(key);
      unique.push(item);
    }
    const byIntent = new Map();
    for (const item of unique) {
      if (!byIntent.has(item.intent)) byIntent.set(item.intent, []);
      byIntent.get(item.intent).push({ ...item, key: hash(`${item.intent}:${item.text}`) });
    }
    const train = [];
    const validation = [];
    const test = [];
    for (const [, list] of [...byIntent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.sort((a, b) => a.key.localeCompare(b.key));
      const validationCount = Math.max(1, Math.round(list.length * 0.15));
      const testCount = Math.max(1, Math.round(list.length * 0.15));
      const trainCount = Math.max(1, list.length - validationCount - testCount);
      train.push(...list.slice(0, trainCount));
      validation.push(...list.slice(trainCount, trainCount + validationCount));
      test.push(...list.slice(trainCount + validationCount));
    }
    // Curation, not leakage: if a held-out example is a near-duplicate of a
    // training example, it is moved into training and recorded. It is never
    // kept in the test set to inflate the score.
    const curated = [];
    for (const bucket of [validation, test]) {
      for (let index = bucket.length - 1; index >= 0; index -= 1) {
        const item = bucket[index];
        const twin = train.find((candidate) => near(item.text, candidate.text) > 0.9);
        if (!twin) continue;
        bucket.splice(index, 1);
        train.push(item);
        curated.push({ moved: item.text, from: bucket === test ? 'test' : 'validation', twin: twin.text });
      }
    }
    return { train, validation, test, duplicates, curated, labels: LABELS, hash: hash(JSON.stringify({ train: train.map((item) => item.key), validation: validation.map((item) => item.key), test: test.map((item) => item.key) })) };
  }

  /** Exact and near-duplicate overlap between splits is a failed dataset, not a warning. */
  contamination(splits) {
    const problems = [];
    const trainKeys = new Set(splits.train.map((item) => item.text.toLowerCase().trim()));
    for (const [name, list] of [['validation', splits.validation], ['test', splits.test]]) {
      for (const item of list) if (trainKeys.has(item.text.toLowerCase().trim())) problems.push({ type: 'exact', split: name, text: item.text });
    }
    for (const item of splits.test) {
      for (const candidate of splits.train) {
        const similarity = near(item.text, candidate.text);
        if (similarity > 0.9) problems.push({ type: 'near', split: 'test', text: item.text, train: candidate.text, similarity: Number(similarity.toFixed(3)) });
      }
    }
    return { clean: problems.length === 0, problems: problems.slice(0, 20), checked: splits.train.length + splits.test.length + splits.validation.length };
  }

  experiments({ limit = 50 } = {}) {
    const rows = this.store ? this.store.list('lab_experiments', { limit }) : [...this.experimentCache.values()];
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  getExperiment(id) {
    return (this.store ? this.store.get('lab_experiments', id) : null) || this.experimentCache.get(id) || null;
  }

  active() {
    return (this.store ? this.store.get('lab_active', 'intent') : null) || this.activeRecord || null;
  }

  baseline(splits = null) {
    const data = splits || this.split();
    const truth = data.test.map((item) => item.intent);
    const predicted = data.test.map((item) => baselinePredict(item.text));
    return metricsFor(truth, predicted);
  }

  /**
   * Trains the intent classifier. Requires an approving identity: no
   * conversation, scheduled job or tool call can start training silently.
   */
  trainIntent({ approvedBy = null, epochs = 60, seed = 7, hidden = [24, 12], learningRate = 0.004, batchSize = 16, patience = 10, l2 = 0.002 } = {}) {
    if (!approvedBy) {
      this.counters.refused += 1;
      return { ok: false, code: 'APPROVAL_REQUIRED', message: 'training needs an approving identity (approvedBy)' };
    }
    const splits = this.split();
    const contamination = this.contamination(splits);
    if (!contamination.clean) {
      this.counters.refused += 1;
      return { ok: false, code: 'CONTAMINATED', message: 'train/test overlap detected; refusing to train', contamination };
    }
    const started = this.now();
    const toSample = (item) => ({ x: Array.from(vectorize(item.text)), y: LABELS.indexOf(item.intent), text: item.text });
    const trainSamples = splits.train.map(toSample);
    const validationSamples = splits.validation.map(toSample);
    const testSamples = splits.test.map(toSample);
    const network = mlp.createNetwork({ dim: 384, hidden, classes: LABELS.length, seed });
    const training = mlp.train({ network, samples: trainSamples, validation: validationSamples, epochs, learningRate, batchSize, seed, patience, l2 });
    const predicted = testSamples.map((sample) => LABELS[mlp.predict(network, sample.x).label]);
    const truth = splits.test.map((item) => item.intent);
    const metrics = metricsFor(truth, predicted);
    const baselineMetrics = this.baseline(splits);
    const id = `lab_${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}_${splits.hash.slice(0, 8)}`;
    const checkpoint = mlp.toCheckpoint(network, {
      labels: LABELS,
      featureVersion: FEATURE_VERSION,
      metrics,
      trainedAt: new Date(this.now()).toISOString(),
      datasetHash: this.datasetHash(),
    });
    const artifactPath = path.join(this.modelsDir(), `intent-${id}.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    const artifact = { path: artifactPath, bytes: fs.statSync(artifactPath).size, checksum: checkpoint.checksum, datasetHash: checkpoint.datasetHash, featureVersion: FEATURE_VERSION, labels: LABELS };
    const delta = Number((metrics.accuracy - baselineMetrics.accuracy).toFixed(3));
    const status = metrics.accuracy >= 0.7 && delta >= 0.03 ? 'candidate' : 'rejected';
    const experiment = {
      id,
      task: 'intent-classification',
      status,
      labels: LABELS,
      dataset: { version: this.data.version, provenance: this.data.provenance, license: this.data.license, items: this.items().length, duplicates: splits.duplicates.length, hash: this.datasetHash() },
      split: { train: splits.train.length, validation: splits.validation.length, test: splits.test.length, hash: splits.hash, contamination, curated: splits.curated },
      hyperparameters: { epochs, seed, hidden, learningRate, batchSize, patience, l2, features: FEATURE_VERSION },
      metrics,
      baseline: baselineMetrics,
      delta,
      training: { epochsRun: training.epochsRun, bestEpoch: training.bestEpoch, bestValidationLoss: Number(training.bestValidationLoss.toFixed(4)), history: training.history.map((row) => ({ epoch: row.epoch, trainLoss: row.trainLoss, validationLoss: row.validationLoss, validationAccuracy: row.validationAccuracy })) },
      artifact,
      approvedBy,
      createdAt: this.now(),
      durationMs: this.now() - started,
      note: 'Candidate only. Nothing is deployed until a human promotes it; base model weights were not touched.',
    };
    this.experimentCache.set(id, experiment);
    if (this.store) this.store.put('lab_experiments', id, experiment);
    this.counters.trainings += 1;
    if (this.log) this.log.info('lab', `intent classifier ${id}: test ${metrics.accuracy}, baseline ${baselineMetrics.accuracy}, status ${status}`);
    return { ok: true, experiment };
  }

  promote(id, { approvedBy = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs a named human approval' };
    const experiment = this.getExperiment(id);
    if (!experiment) return { ok: false, code: 'NOT_FOUND' };
    if (experiment.status !== 'candidate') return { ok: false, code: 'NOT_A_CANDIDATE', message: `experiment is ${experiment.status}` };
    const previous = this.active();
    const record = { experimentId: id, artifact: experiment.artifact, metrics: experiment.metrics, baseMetrics: experiment.baseline, promotedBy: approvedBy, promotedAt: this.now(), previous: previous ? { experimentId: previous.experimentId, artifact: previous.artifact, metrics: previous.metrics, promotedBy: previous.promotedBy, promotedAt: previous.promotedAt, previous: previous.previous } : null };
    this.cache = { network: null, experiment: record };
    this.activeRecord = record;
    if (this.store) this.store.put('lab_active', 'intent', record);
    this.counters.promotions += 1;
    return { ok: true, active: record };
  }

  rollback({ approvedBy = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'rollback needs a named human approval' };
    const current = this.active();
    if (!current || !current.previous) return { ok: false, code: 'NO_PREVIOUS_MODEL' };
    this.activeRecord = current.previous;
    if (this.store) this.store.put('lab_active', 'intent', current.previous);
    this.cache = { network: null, experiment: current.previous };
    this.counters.rollbacks += 1;
    return { ok: true, active: current.previous };
  }

  classifier() {
    const active = this.active();
    if (!active) return null;
    if (this.cache.network && this.cache.experiment && this.cache.experiment.experimentId === active.experimentId) return { network: this.cache.network, active };
    const checkpoint = JSON.parse(fs.readFileSync(active.artifact.path, 'utf8'));
    const network = mlp.fromCheckpoint(checkpoint);
    this.cache = { network, experiment: active };
    return { network, active };
  }

  classify(text) {
    const loaded = this.classifier();
    if (!loaded) return { ok: false, code: 'NO_MODEL', message: 'no promoted intent model; train and promote one first' };
    const features = vectorize(text);
    const prediction = mlp.predict(loaded.network, Array.from(features));
    const probabilities = Array.from(prediction.probabilities);
    const ranking = loaded.network.labels ? [] : [];
    const labels = loaded.active.artifact.labels || LABELS;
    this.counters.predictions += 1;
    return {
      ok: true,
      text,
      intent: labels[prediction.label],
      confidence: Number(probabilities[prediction.label].toFixed(3)),
      probabilities: labels.map((label, index) => ({ label, probability: Number(probabilities[index].toFixed(3)) })).sort((a, b) => b.probability - a.probability),
      model: { experimentId: loaded.active.experimentId, checksum: loaded.active.artifact.checksum, trainedAt: loaded.active.artifact.trainedAt || null },
      note: ranking && 'probabilities are from the promoted CPU model, not a language model',
    };
  }

  status() {
    const active = this.active();
    return {
      dataset: { version: this.data.version, items: this.items().length, labels: LABELS, provenance: this.data.provenance, license: this.data.license, hash: this.datasetHash() },
      experiments: this.experiments({ limit: 20 }).map((entry) => ({ id: entry.id, status: entry.status, accuracy: entry.metrics.accuracy, baseline: entry.baseline.accuracy, delta: entry.delta, createdAt: entry.createdAt, artifact: { bytes: entry.artifact.bytes, checksum: entry.artifact.checksum }, approvedBy: entry.approvedBy })),
      active: active ? { experimentId: active.experimentId, metrics: active.metrics, promotedBy: active.promotedBy, promotedAt: active.promotedAt, checksum: active.artifact.checksum } : null,
      counters: { ...this.counters },
      honest: 'CPU-trained small MLP on synthetic bilingual data. Not LoRA, not a language model, and not deployed without approval.',
    };
  }
}

module.exports = { LearningLab, LABELS, KEYWORDS, baselinePredict, metricsFor, macroF1, near };
