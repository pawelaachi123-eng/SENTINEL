'use strict';

/**
 * Retrieval reranker: a real trained model, not a heuristic wearing a model's
 * name.
 *
 * Dataset: synthetic query/passage groups with graded relevance, split by topic
 * so test topics are unseen. Features: lexical overlap, query containment,
 * character-trigram cosine, exact phrase, length ratio and document length.
 * Model: a 3-class MLP over those features, trained with early stopping.
 * Baseline: a fixed linear combination of the same features.
 *
 * Promotion is gated on the held-out NDCG@3 being at least the baseline and is
 * only possible with an approving identity. Without a promoted model `rerank`
 * refuses with `NO_MODEL` rather than silently falling back and claiming a
 * neural result.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataset = require('./ml/data/relevance');
const mlp = require('./ml/mlp');

const FEATURES = ['lexical-jaccard', 'query-containment', 'char3-cosine', 'exact-phrase', 'length-ratio', 'doc-length'];
const GRADES = 3;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function splitByTopic(cases, { train = 0.75, validation = 0.125, seed = 11 } = {}) {
  const groups = [...new Set(cases.map((item) => item.group))].sort();
  const ranked = groups.map((group) => ({ group, key: hash(`${seed}:${group}`) })).sort((a, b) => a.key.localeCompare(b.key));
  const trainEnd = Math.floor(ranked.length * train);
  const validationEnd = trainEnd + Math.max(1, Math.floor(ranked.length * validation));
  const pick = (rows) => {
    const allowed = new Set(rows.map((row) => row.group));
    return cases.filter((item) => allowed.has(item.group));
  };
  return { train: pick(ranked.slice(0, trainEnd)), validation: pick(ranked.slice(trainEnd, validationEnd)), test: pick(ranked.slice(validationEnd)), groups: { train: trainEnd, validation: validationEnd - trainEnd, test: ranked.length - validationEnd } };
}

function ndcgAt(candidates, k = 3) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score).slice(0, k);
  const dcg = sorted.reduce((sum, candidate, index) => sum + (2 ** candidate.grade - 1) / Math.log2(index + 2), 0);
  const ideal = [...candidates].sort((a, b) => b.grade - a.grade).slice(0, k).reduce((sum, candidate, index) => sum + (2 ** candidate.grade - 1) / Math.log2(index + 2), 0);
  return ideal ? dcg / ideal : 0;
}

function meanNdcg(cases, scorer, k = 3) {
  if (!cases.length) return 0;
  const values = cases.map((item) => ndcgAt(item.candidates.map((candidate) => ({ ...candidate, score: scorer(item.query, candidate) })), k));
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function rankOfFirstRelevant(cases, scorer) {
  let reciprocal = 0;
  for (const item of cases) {
    const sorted = [...item.candidates].sort((a, b) => scorer(item.query, b) - scorer(item.query, a));
    const index = sorted.findIndex((candidate) => candidate.grade >= 1);
    if (index >= 0) reciprocal += 1 / (index + 1);
  }
  return Number((reciprocal / Math.max(1, cases.length)).toFixed(4));
}

class RerankerLab {
  constructor({ paths, store = null, log = null, now = () => Date.now(), data = null } = {}) {
    this.paths = paths;
    this.store = store;
    this.log = log;
    this.now = now;
    this.data = data || dataset.cases();
    this.cache = { model: null, active: null };
    this.memoryExperiments = new Map();
    this.counters = { trainings: 0, refused: 0, promotions: 0, predictions: 0 };
  }

  modelsDir() {
    const dir = path.join(this.paths.dataDir(), 'models');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  datasetHash() {
    return hash(JSON.stringify(this.data.map((item) => [item.id, item.group, item.query, item.candidates.map((candidate) => [candidate.doc, candidate.grade])])));
  }

  experiments({ limit = 50 } = {}) {
    const rows = this.store ? this.store.list('reranker_experiments', { limit }) : [...this.memoryExperiments.values()];
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  getExperiment(id) {
    return (this.store ? this.store.get('reranker_experiments', id) : null) || this.memoryExperiments.get(id) || null;
  }

  active() {
    return (this.store ? this.store.get('reranker_active', 'default') : null) || this.cache.active || null;
  }

  train({ approvedBy = null, epochs = 160, seed = 5, hidden = [16], learningRate = 0.03, batchSize = 16, patience = 20, l2 = 0.001 } = {}) {
    if (!approvedBy) {
      this.counters.refused += 1;
      return { ok: false, code: 'APPROVAL_REQUIRED', message: 'training needs an approving identity (approvedBy)' };
    }
    const splits = splitByTopic(this.data, { seed });
    const samples = [];
    for (const item of splits.train) for (const candidate of item.candidates) samples.push({ x: candidate.features.slice(), y: candidate.grade });
    const validation = [];
    for (const item of splits.validation) for (const candidate of item.candidates) validation.push({ x: candidate.features.slice(), y: candidate.grade });
    if (!samples.length || !splits.test.length) return { ok: false, code: 'BAD_DATASET', message: 'split produced empty train or test data' };
    const started = this.now();
    const network = mlp.createNetwork({ dim: FEATURES.length, hidden, classes: GRADES, seed });
    const training = mlp.train({ network, samples, validation, epochs, learningRate, batchSize, seed, patience, l2 });
    const scorer = (query, candidate) => {
      const probabilities = mlp.predict(network, Array.from(candidate.features)).probabilities;
      return probabilities[1] + 2 * probabilities[2];
    };
    const metrics = {
      ndcgAt3: meanNdcg(splits.test, scorer),
      mrr: rankOfFirstRelevant(splits.test, scorer),
      gradeAccuracy: Number(mlp.accuracy(network, splits.test.flatMap((item) => item.candidates.map((candidate) => ({ x: candidate.features, y: candidate.grade })))).toFixed(4)),
      testQueries: splits.test.length,
    };
    const baseline = {
      ndcgAt3: meanNdcg(splits.test, (query, candidate) => candidate.baseline),
      mrr: rankOfFirstRelevant(splits.test, (query, candidate) => candidate.baseline),
    };
    const delta = Number((metrics.ndcgAt3 - baseline.ndcgAt3).toFixed(4));
    const id = `rerank_${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}_${splits.test.map((item) => item.group).join('_').slice(0, 12)}`;
    const checkpoint = mlp.toCheckpoint(network, {
      labels: ['grade-0', 'grade-1', 'grade-2'],
      featureVersion: 'relevance-features-v1',
      metrics,
      trainedAt: new Date(this.now()).toISOString(),
      datasetHash: this.datasetHash(),
    });
    const artifactPath = path.join(this.modelsDir(), `${id}.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify({ format: 'sentinel-reranker-v1', features: FEATURES, checkpoint })}\n`, { mode: 0o600 });
    const record = {
      id,
      createdAt: this.now(),
      approvedBy,
      status: 'candidate',
      dataset: { cases: this.data.length, gradedCandidates: this.data.reduce((sum, item) => sum + item.candidates.length, 0), provenance: 'authored synthetic query/passage groups', hash: this.datasetHash() },
      split: { groups: splits.groups, queries: { train: splits.train.length, validation: splits.validation.length, test: splits.test.length } },
      hyperparameters: { hidden, learningRate, batchSize, patience, l2, seed },
      training: { bestEpoch: training.bestEpoch, bestValidationLoss: training.bestValidationLoss, epochsRun: training.epochsRun, history: training.history, durationMs: this.now() - started },
      metrics,
      baseline,
      delta,
      gate: { passed: delta >= 0 && metrics.ndcgAt3 >= baseline.ndcgAt3, rule: 'held-out NDCG@3 must be >= the lexical baseline' },
      artifact: { path: artifactPath, bytes: fs.statSync(artifactPath).size, checksum: checkpoint.checksum },
    };
    this.memoryExperiments.set(id, record);
    if (this.store) this.store.put('reranker_experiments', id, record);
    this.counters.trainings += 1;
    if (this.log) this.log.info('reranker', `trained ${id}: NDCG@3 ${metrics.ndcgAt3} vs baseline ${baseline.ndcgAt3}`);
    return { ok: true, experiment: record };
  }

  promote(id, { approvedBy = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'promotion needs an approving identity' };
    const experiment = this.getExperiment(id);
    if (!experiment) return { ok: false, code: 'NOT_FOUND', message: `no experiment ${id}` };
    if (!experiment.gate || !experiment.gate.passed) return { ok: false, code: 'GATE_FAILED', message: 'held-out NDCG did not beat the baseline; candidate cannot be promoted', gate: experiment.gate };
    const current = this.active();
    const record = { ...experiment, status: 'active', promotedBy: approvedBy, promotedAt: this.now(), previous: current ? { experimentId: current.experimentId, artifact: current.artifact, metrics: current.metrics } : null, experimentId: id };
    if (this.store) this.store.put('reranker_active', 'default', record);
    this.cache = { model: null, active: record };
    this.counters.promotions += 1;
    return { ok: true, active: record };
  }

  rollback({ approvedBy = null } = {}) {
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'rollback needs an approving identity' };
    const current = this.active();
    if (!current) return { ok: false, code: 'NO_ACTIVE_MODEL', message: 'nothing to roll back' };
    if (!current.previous) return { ok: false, code: 'NO_PREVIOUS_MODEL', message: 'there is no previous reranker to restore' };
    if (this.store) this.store.put('reranker_active', 'default', current.previous);
    this.cache = { model: null, active: current.previous };
    return { ok: true, active: current.previous };
  }

  model() {
    const active = this.active();
    if (!active) return null;
    if (this.cache.model && this.cache.active && this.cache.active.experimentId === active.experimentId) return { network: this.cache.model, active };
    const artifact = JSON.parse(fs.readFileSync(active.artifact.path, 'utf8'));
    if (artifact.format !== 'sentinel-reranker-v1') throw Object.assign(new Error('not a reranker artifact'), { code: 'BAD_CHECKPOINT' });
    const network = mlp.fromCheckpoint(artifact.checkpoint);
    this.cache = { model: network, active };
    return { network, active };
  }

  rerank({ query, candidates, limit = 10 } = {}) {
    const text = String(query || '').trim();
    if (!text) return { ok: false, code: 'BAD_QUERY', message: 'query is required' };
    if (!Array.isArray(candidates) || !candidates.length) return { ok: false, code: 'BAD_CANDIDATES', message: 'candidates must be a non-empty array' };
    const loaded = this.model();
    if (!loaded) return { ok: false, code: 'NO_MODEL', message: 'no promoted reranker; train and promote one first' };
    const scored = candidates.slice(0, 100).map((candidate, index) => {
      const doc = typeof candidate === 'string' ? candidate : String(candidate.text || candidate.doc || '');
      const values = dataset.features(text, doc);
      const probabilities = mlp.predict(loaded.network, values).probabilities;
      return { index, doc: doc.slice(0, 500), score: Number((probabilities[1] + 2 * probabilities[2]).toFixed(4)), features: values };
    });
    scored.sort((a, b) => b.score - a.score);
    this.counters.predictions += 1;
    return { ok: true, query: text, ranked: scored.slice(0, Math.max(1, Math.min(50, limit))), model: { experimentId: loaded.active.experimentId, checksum: loaded.active.artifact.checksum, ndcgAt3: loaded.active.metrics.ndcgAt3, baseline: loaded.active.baseline.ndcgAt3 } };
  }

  status() {
    const active = this.active();
    return {
      task: 'retrieval-reranking',
      features: FEATURES,
      dataset: { cases: this.data.length, candidates: this.data.reduce((sum, item) => sum + item.candidates.length, 0), provenance: 'authored synthetic query/passage groups, split by topic', hash: this.datasetHash() },
      active: active ? { experimentId: active.experimentId, metrics: active.metrics, baseline: active.baseline, promotedBy: active.promotedBy, checksum: active.artifact.checksum } : null,
      experiments: this.experiments({ limit: 10 }).map((experiment) => ({ id: experiment.id, status: experiment.status, createdAt: experiment.createdAt, ndcgAt3: experiment.metrics.ndcgAt3, baseline: experiment.baseline.ndcgAt3, delta: experiment.delta, gate: experiment.gate, approvedBy: experiment.approvedBy })),
      counters: this.counters,
      honest: 'small CPU MLP on synthetic graded-relevance data; not a cross-encoder language model',
    };
  }
}

module.exports = { RerankerLab, splitByTopic, meanNdcg, ndcgAt, rankOfFirstRelevant, FEATURES };
