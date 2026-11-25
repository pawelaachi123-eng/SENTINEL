'use strict';

/**
 * Specialist model zoo.
 *
 * Four additional real CPU models on top of the intent, sentiment and reranker
 * labs:
 *
 *   tool-selection    request → one of the real registered tool names
 *   agent-routing     request → one of eight functional domains
 *   memory-relevance  query/memory pair → relevant or irrelevant
 *   task-complexity   request → simple / medium / complex
 *
 * Every model has an authored synthetic dataset, a deterministic stratified
 * split, a named baseline evaluated on the same held-out items, measured
 * accuracy/macro-F1, a checksummed checkpoint outside the source tree, and a
 * promotion gate. A model that does not beat its baseline is not promoted.
 *
 * These are small feature models. They are not a language model and their names
 * do not imply general intelligence.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const data = require('./ml/data/specialists');
const { vectorize, FEATURE_VERSION } = require('./ml/features');
const mlp = require('./ml/mlp');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function metricsFor(truth, predicted) {
  let correct = 0;
  for (let index = 0; index < truth.length; index += 1) if (truth[index] === predicted[index]) correct += 1;
  const labels = [...new Set(truth)];
  let f1 = 0;
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let index = 0; index < truth.length; index += 1) {
      if (truth[index] === label && predicted[index] === label) tp += 1;
      else if (predicted[index] === label) fp += 1;
      else if (truth[index] === label) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    f1 += precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  }
  return { cases: truth.length, accuracy: Number((correct / Math.max(1, truth.length)).toFixed(4)), macroF1: Number((f1 / Math.max(1, labels.length)).toFixed(4)) };
}

class SpecialistZoo {
  constructor({ paths, store = null, log = null, now = () => Date.now() } = {}) {
    this.paths = paths;
    this.store = store;
    this.log = log;
    this.now = now;
    this.specs = {
      tools: { ...data.tools, kind: 'text', hidden: [48, 24], epochs: 180, learningRate: 0.01, augment: 'toolAugment' },
      routing: { ...data.routing, kind: 'text', hidden: [48, 24], epochs: 180, learningRate: 0.01, augment: 'routeAugment' },
      relevance: { ...data.relevance, kind: 'features', hidden: [16, 8], epochs: 260, learningRate: 0.01 },
      complexity: { ...data.complexity, kind: 'features', hidden: [16, 8], epochs: 260, learningRate: 0.01 },
    };
    this.cache = new Map();
    this.memoryExperiments = new Map();
    this.counters = { trainings: 0, promotions: 0, refusals: 0, predictions: 0 };
  }

  modelsDir() {
    const dir = path.join(this.paths.dataDir(), 'models');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  spec(task) {
    const spec = this.specs[task];
    if (!spec) throw Object.assign(new Error(`unknown specialist ${task}`), { code: 'UNKNOWN_SPECIALIST' });
    return spec;
  }

  datasetHash(task) {
    const spec = this.spec(task);
    return hash(JSON.stringify(spec.items.map((item) => [item.text || item.query, item.memory || null, item.label, item.features || null])));
  }

  split(spec, seed = 13) {
    const grouped = new Map();
    const source = spec.items;
    for (const item of source) {
      if (!grouped.has(item.label)) grouped.set(item.label, []);
      grouped.get(item.label).push({ ...item, key: hash(`${seed}:${item.text || item.query}:${item.memory || ''}`) });
    }
    const train = [];
    const validation = [];
    const test = [];
    for (const [, rows] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.sort((a, b) => a.key.localeCompare(b.key));
      const validationCount = Math.max(1, Math.round(rows.length * 0.15));
      const testCount = Math.max(1, Math.round(rows.length * 0.15));
      const trainCount = Math.max(1, rows.length - validationCount - testCount);
      const baseTrain = rows.slice(0, trainCount).map(({ key, ...rest }) => rest);
      train.push(...baseTrain);
      if (spec.augment && data[spec.augment]) train.push(...data[spec.augment]({ label: rows[0].label, text: '' }));
      validation.push(...rows.slice(trainCount, trainCount + validationCount).map(({ key, ...rest }) => rest));
      test.push(...rows.slice(trainCount + validationCount).map(({ key, ...rest }) => rest));
    }
    return { train, validation, test, labels: spec.labels };
  }

  encode(spec, item) {
    const base = spec.kind === 'text' ? Array.from(vectorize(item.text)) : item.features.slice();
    return spec.keywordFeatures ? [...base, ...spec.keywordFeatures(item.text)] : base;
  }

  experiments(task = null, { limit = 20 } = {}) {
    let rows;
    if (this.store) rows = this.store.list('specialist_experiments', { limit: 200 });
    else rows = [...this.memoryExperiments.values()];
    return rows.filter((entry) => !task || entry.task === task).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  active(task) {
    return (this.store ? this.store.get('specialist_active', task) : null) || this.cache.get(`active:${task}`) || null;
  }

  train(task, { approvedBy = null, epochs = null, seed = 13 } = {}) {
    if (!approvedBy) {
      this.counters.refusals += 1;
      return { ok: false, code: 'APPROVAL_REQUIRED', message: 'training needs an approving identity' };
    }
    let spec;
    try { spec = this.spec(task); } catch (err) { return { ok: false, code: err.code, message: err.message }; }
    const splits = this.split(spec, seed);
    const index = (label) => spec.labels.indexOf(label);
    const toSample = (item) => ({ x: this.encode(spec, item), y: index(item.label), text: item.text || item.query });
    const trainSamples = splits.train.map(toSample);
    const validationSamples = splits.validation.map(toSample);
    const testSamples = splits.test.map(toSample);
    if (trainSamples.length < spec.labels.length || !testSamples.length) return { ok: false, code: 'BAD_DATASET', message: 'split produced too little data' };
    const started = this.now();
    const dim = (spec.kind === 'text' ? 384 : spec.featureNames.length) + (spec.keywordFeatures ? spec.labels.length : 0);
    const network = mlp.createNetwork({ dim, hidden: spec.hidden, classes: spec.labels.length, seed });
    const training = mlp.train({ network, samples: trainSamples, validation: validationSamples, epochs: epochs || spec.epochs, batchSize: 8, learningRate: spec.learningRate, seed, patience: 40, l2: 0.002 });
    const predicted = testSamples.map((sample) => spec.labels[mlp.predict(network, sample.x).label]);
    const truth = splits.test.map((item) => item.label);
    const metrics = metricsFor(truth, predicted);
    const baselinePredicted = splits.test.map((item) => spec.kind === 'text' ? spec.baseline(item.text) : spec.baseline(item.features));
    const baseline = metricsFor(truth, baselinePredicted);
    const delta = Number((metrics.accuracy - baseline.accuracy).toFixed(4));
    const id = `${task}_${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}_${splits.test.length}`;
    const checkpoint = mlp.toCheckpoint(network, {
      labels: spec.labels,
      featureVersion: spec.kind === 'text' ? FEATURE_VERSION : `${task}-features-v1`,
      metrics,
      trainedAt: new Date(this.now()).toISOString(),
      datasetHash: this.datasetHash(task),
    });
    const artifactPath = path.join(this.modelsDir(), `specialist-${id}.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify({ format: 'sentinel-specialist-v1', task, kind: spec.kind, featureNames: spec.featureNames || null, checkpoint })}\n`, { mode: 0o600 });
    const record = {
      task, id, createdAt: this.now(), approvedBy, status: 'candidate',
      dataset: { items: spec.items.length, labels: spec.labels, provenance: spec.provenance, hash: this.datasetHash(task) },
      split: { train: splits.train.length, validation: splits.validation.length, test: splits.test.length },
      hyperparameters: { hidden: spec.hidden, epochs: epochs || spec.epochs, learningRate: spec.learningRate, seed, batchSize: 8, l2: 0.002 },
      training: { bestEpoch: training.bestEpoch, bestValidationLoss: training.bestValidationLoss, epochsRun: training.epochsRun, durationMs: this.now() - started },
      metrics, baseline, delta,
      gate: { passed: delta >= 0, rule: 'held-out accuracy must be at least the named baseline' },
      artifact: { path: artifactPath, bytes: fs.statSync(artifactPath).size, checksum: checkpoint.checksum },
    };
    this.memoryExperiments.set(id, record);
    if (this.store) this.store.put('specialist_experiments', id, record);
    this.counters.trainings += 1;
    if (this.log) this.log.info('specialists', `${task}: ${metrics.accuracy} vs ${baseline.accuracy}`);
    return { ok: true, experiment: record };
  }

  promote(task, id, { approvedBy = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs an approving identity' };
    const experiment = this.experiments(task, { limit: 200 }).find((entry) => entry.id === id);
    if (!experiment) return { ok: false, code: 'NOT_FOUND', message: `no ${task} experiment ${id}` };
    if (!experiment.gate.passed) return { ok: false, code: 'GATE_FAILED', message: 'held-out accuracy did not reach the baseline', gate: experiment.gate };
    const previous = this.active(task);
    const record = { ...experiment, status: 'active', experimentId: id, promotedBy: approvedBy, promotedAt: this.now(), previous: previous ? { experimentId: previous.experimentId, artifact: previous.artifact, metrics: previous.metrics } : null };
    this.cache.set(`active:${task}`, record);
    this.cache.delete(`model:${task}`);
    if (this.store) this.store.put('specialist_active', task, record);
    this.counters.promotions += 1;
    return { ok: true, active: record };
  }

  load(task) {
    const active = this.active(task);
    if (!active) return null;
    if (this.cache.has(`model:${task}`)) return { ...this.cache.get(`model:${task}`), active };
    const artifact = JSON.parse(fs.readFileSync(active.artifact.path, 'utf8'));
    if (artifact.format !== 'sentinel-specialist-v1' || artifact.task !== task) throw Object.assign(new Error('bad specialist artifact'), { code: 'BAD_CHECKPOINT' });
    const network = mlp.fromCheckpoint(artifact.checkpoint);
    const loaded = { network, labels: artifact.checkpoint.labels, active, kind: artifact.kind };
    this.cache.set(`model:${task}`, loaded);
    return loaded;
  }

  predict(task, input, { fallbackBelow = 0, text = null } = {}) {
    const loaded = this.load(task);
    if (!loaded) return { ok: false, code: 'NO_MODEL', message: `no promoted ${task} model; train and promote one first` };
    const spec = this.spec(task);
    const sourceText = text || (Array.isArray(input) ? null : String(input));
    const x = Array.isArray(input) ? input : this.encode(spec, { text: sourceText });
    const prediction = mlp.predict(loaded.network, x);
    const neuralLabel = loaded.labels[prediction.label];
    const confidence = Number(prediction.probabilities[prediction.label].toFixed(4));
    let baselineLabel = null;
    if (spec.kind === 'text' && sourceText !== null) baselineLabel = spec.baseline(sourceText);
    else if (spec.kind === 'features' && Array.isArray(input)) baselineLabel = spec.baseline(input);
    const usedFallback = Boolean(baselineLabel && confidence < fallbackBelow && baselineLabel !== neuralLabel);
    this.counters.predictions += 1;
    return {
      ok: true,
      task,
      label: usedFallback ? baselineLabel : neuralLabel,
      confidence,
      probabilities: loaded.labels.map((label, index) => ({ label, probability: Number(prediction.probabilities[index].toFixed(4)) })).sort((a, b) => b.probability - a.probability),
      neural: { label: neuralLabel, confidence },
      baseline: baselineLabel,
      usedFallback,
      model: { experimentId: loaded.active.experimentId, checksum: loaded.active.artifact.checksum, accuracy: loaded.active.metrics.accuracy, baseline: loaded.active.baseline.accuracy },
    };
  }

  recommendTool(text) { return this.predict('tools', text, { fallbackBelow: 0.5 }); }
  route(text) { return this.predict('routing', text, { fallbackBelow: 0.55 }); }
  complexity(text) {
    // The same six features used during training, from one implementation.
    const values = data.complexityFeatures(text);
    return this.predict('complexity', values, { text: String(text) });
  }

  memoryRelevance({ query, memory, recency = 0.5, importance = 0.5 } = {}) {
    if (!query || !memory) return { ok: false, code: 'BAD_INPUT', message: 'query and memory are required' };
    const values = data.relevanceFeatures(query, memory, recency, importance);
    return { ...this.predict('relevance', values), features: values };
  }

  status() {
    return {
      specialists: Object.keys(this.specs).map((task) => {
        const spec = this.specs[task];
        const active = this.active(task);
        return {
          task,
          labels: spec.labels,
          dataset: { items: spec.items.length, provenance: spec.provenance, hash: this.datasetHash(task) },
          active: active ? { experimentId: active.experimentId, metrics: active.metrics, baseline: active.baseline, delta: active.delta, promotedBy: active.promotedBy, checksum: active.artifact.checksum } : null,
          experiments: this.experiments(task, { limit: 5 }).map((entry) => ({ id: entry.id, status: entry.status, accuracy: entry.metrics.accuracy, baseline: entry.baseline.accuracy, gate: entry.gate, delta: entry.delta })),
        };
      }),
      counters: this.counters,
      honest: 'four small CPU feature models with authored synthetic datasets and explicit baselines; not language understanding',
    };
  }
}

module.exports = { SpecialistZoo, metricsFor };
