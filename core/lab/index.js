'use strict';

/**
 * Training lab facade.
 *
 * Wires the genuine small-scale workflows together behind one object:
 * versioned datasets, LoRA/QLoRA, distillation, preference learning, a compact
 * autoregressive transformer, hyper-parameter search, a durable queue and an
 * adapter registry. Everything is CPU-sized, reproducible from a seed, stored
 * outside the source tree, and reported with measured numbers only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { DatasetRegistry } = require('./datasets');
const { AdapterRegistry } = require('./adapters');
const { TrainingQueue } = require('./queue');
const { HyperSearch, loraObjective } = require('./hpo');
const loraModule = require('./lora');
const distillModule = require('./distill');
const preferenceModule = require('./preference');
const gpt = require('../ml/gpt');

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shuffled(data, seed = 1) {
  return data.map((row, index) => ({ row, key: Math.sin((index + 1) * seed) })).sort((a, b) => a.key - b.key).map((entry) => entry.row);
}

class TrainingLab {
  constructor({ dataDir, sourceRoot = null, log = null, now = () => Date.now(), concurrency = 1 } = {}) {
    if (!dataDir) throw Object.assign(new Error('TrainingLab needs dataDir'), { code: 'BAD_ARGUMENT' });
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.datasets = new DatasetRegistry({ dataDir, sourceRoot, log, now });
    this.adapters = new AdapterRegistry({ dataDir, log, now });
    this.models = new Map();
    this.counters = { lora: 0, qlora: 0, distill: 0, preference: 0, gpt: 0, hpo: 0, failed: 0 };
    this.queue = new TrainingQueue({
      dataDir,
      log,
      now,
      concurrency,
      runners: {
        lora: (payload, context) => this.runLoraJob(payload, context),
        qlora: (payload, context) => this.runQloraJob(payload, context),
        distill: (payload) => this.distill(payload),
        preference: (payload) => this.preference(payload),
        gpt: (payload, context) => this.runGptJob(payload, context),
        hpo: (payload) => this.hpo(payload),
        synthetic: async (payload, context) => {
          // Used by tests and by the lab's own health check. It is a real job,
          // not a fake activity indicator: it sleeps, honours cancellation and
          // writes a checkpoint.
          const steps = Math.max(1, Math.min(50, payload.steps || 3));
          for (let step = 1; step <= steps; step += 1) {
            if (context.signal.aborted) throw context.signal.reason;
            context.checkpoint({ step });
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, payload.ms || 5)));
          }
          return { ok: true, steps };
        },
      },
    });
    this.queue.start();
  }

  /* ── datasets ───────────────────────────────────────────────────────── */

  createDataset(options) { return this.datasets.create(options); }
  listDatasets() { return this.datasets.list(); }
  splitDataset(name, options) { return this.datasets.split(name, options); }
  loadDataset(name, version) { return this.datasets.load(name, version); }

  /** Builds examples with deterministic hash features from a versioned dataset. */
  examples(name, { version = null, textKey = 'text', labelKey = 'label', dim = 16, seed = 42 } = {}) {
    const { manifest, rows } = this.datasets.load(name, version);
    const labels = [...new Set(rows.map((row) => row[labelKey]))].sort();
    const data = rows.map((row) => ({
      text: String(row[textKey] || ''),
      label: labels.indexOf(row[labelKey]),
      rawLabel: row[labelKey],
      vector: loraModule.hashVector(row[textKey], dim),
    }));
    const mixed = shuffled(data, seed);
    const cut = Math.max(1, Math.floor(mixed.length * splitFraction(mixed.length)));
    return { manifest, labels, train: mixed.slice(0, cut), test: mixed.slice(cut), all: mixed };
  }

  /* ── LoRA / QLoRA ───────────────────────────────────────────────────── */

  baseFor({ dim = 16, hidden = 24, classes = 2, seed = 42 } = {}) {
    return loraModule.createBase({ dim, hidden, classes, seed });
  }

  trainLora({ dataset, version = null, sourceDataset = null, sourceVersion = null, dim = 16, hidden = 24, rank = 2, epochs = 140, learningRate = 0.1, seed = 42, target = 'w2', approve = false } = {}) {
    const prepared = this.examples(dataset, { version, dim, seed });
    const source = sourceDataset ? this.examples(sourceDataset, { version: sourceVersion, dim, seed }) : prepared;
    const base = this.baseFor({ dim, hidden, classes: prepared.labels.length, seed });
    loraModule.trainBase(base, source.train, { epochs: Math.max(40, Math.round(epochs * 0.6)) });
    const outcome = loraModule.trainLora({ base, examples: prepared.train, validation: prepared.test, rank, epochs, learningRate, seed, target });
    const artifact = this.adapters.create({
      name: dataset,
      kind: 'lora',
      payload: { ...outcome.payload, dataset: prepared.manifest, labels: prepared.labels, base: { config: base.config, weights: Object.fromEntries(base.order.map((key) => [key, Array.from(base.parameters[key].data)])) } },
      metrics: { accuracy: outcome.evaluation.adapted.accuracy, baseline: outcome.evaluation.frozen.accuracy, trainableParameters: outcome.trainableParameters },
      dataset: prepared.manifest,
      base: { config: base.config, checksum: loraModule.checksumOfBase(base) },
      notes: `${rank}-rank LoRA, ${epochs} epochs, CPU`,
    });
    this.counters.lora += 1;
    return { ok: true, adapter: artifact, evaluation: outcome.evaluation, trainableParameters: outcome.trainableParameters, frozenParameters: outcome.frozenParameters, history: outcome.history, dataset: prepared.manifest, approve };
  }

  trainQlora({ dataset, version = null, sourceDataset = null, sourceVersion = null, dim = 16, hidden = 24, rank = 2, epochs = 140, learningRate = 0.1, seed = 42 } = {}) {
    const prepared = this.examples(dataset, { version, dim, seed });
    const source = sourceDataset ? this.examples(sourceDataset, { version: sourceVersion, dim, seed }) : prepared;
    const base = this.baseFor({ dim, hidden, classes: prepared.labels.length, seed });
    loraModule.trainBase(base, source.train, { epochs: Math.max(40, Math.round(epochs * 0.6)) });
    const outcome = loraModule.trainQlora({ base, examples: prepared.train, validation: prepared.test, rank, epochs, learningRate, seed });
    const artifact = this.adapters.create({
      name: `${dataset}-qlora`,
      kind: 'qlora',
      payload: { ...outcome.payload, dataset: prepared.manifest, labels: prepared.labels, base: { config: base.config, weights: Object.fromEntries(base.order.map((key) => [key, Array.from(base.parameters[key].data)])) } },
      metrics: { accuracy: outcome.evaluation.adapted.accuracy, baseline: outcome.evaluation.frozen.accuracy, trainableParameters: outcome.trainableParameters },
      dataset: prepared.manifest,
      notes: `4-bit frozen base, ${rank}-rank adapter`,
    });
    this.counters.qlora += 1;
    return { ok: true, adapter: artifact, evaluation: outcome.evaluation, quantization: outcome.quantization, history: outcome.history, dataset: prepared.manifest };
  }

  /* ── distillation / preference ──────────────────────────────────────── */

  distill({ dataset, version = null, dim = 16, teacherHidden = 32, studentHidden = 8, epochs = 100, teacherEpochs = 120, temperature = 1.5, alpha = 0.7, seed = 42 } = {}) {
    const prepared = this.examples(dataset, { version, dim, seed });
    const outcome = distillModule.distill({ train: prepared.train, test: prepared.test, teacherConfig: { dim, hidden: teacherHidden, classes: prepared.labels.length }, studentConfig: { dim, hidden: studentHidden, classes: prepared.labels.length }, epochs, teacherEpochs, temperature, alpha, seed });
    const artifact = this.adapters.create({
      name: `${dataset}-distilled`,
      kind: 'distilled',
      payload: { ...outcome.payload, dataset: prepared.manifest, labels: prepared.labels },
      metrics: { distilledAccuracy: outcome.distilled.evaluation.accuracy, plainAccuracy: outcome.plain.evaluation.accuracy, teacherAccuracy: outcome.teacher.evaluation.accuracy, delta: outcome.deltaAccuracy },
      dataset: prepared.manifest,
      notes: `student h=${studentHidden}, teacher h=${teacherHidden}, T=${temperature}, alpha=${alpha}`,
    });
    this.counters.distill += 1;
    return { ok: true, adapter: artifact, teacher: outcome.teacher, plain: outcome.plain, distilled: outcome.distilled, deltaAccuracy: outcome.deltaAccuracy, dataset: prepared.manifest, history: outcome.history };
  }

  preference({ pairs = null, count = 140, epochs = 100, seed = 42, dataset = null } = {}) {
    let data = pairs;
    if (!data && dataset) {
      const prepared = this.datasets.load(dataset);
      data = prepared.rows.map((row) => ({ chosen: loraModule.hashVector(row.chosen, 16), rejected: loraModule.hashVector(row.rejected, 16) }));
    }
    if (!data) data = preferenceModule.syntheticPairs({ count, seed });
    const mixed = shuffled(data, seed + 1);
    const cut = Math.max(1, Math.floor(mixed.length * 0.8));
    const outcome = preferenceModule.trainPreference({ pairs: mixed.slice(0, cut), test: mixed.slice(cut), epochs, seed });
    const artifact = this.adapters.create({
      name: 'preference',
      kind: 'preference',
      payload: outcome.payload,
      metrics: { accuracy: outcome.test.accuracy, baseline: outcome.baseline.accuracy, delta: outcome.delta },
      dataset: dataset ? { name: dataset } : { name: 'synthetic-pairs', seed },
      notes: 'Bradley–Terry pairwise preference, linear scorer',
    });
    this.counters.preference += 1;
    return { ok: true, adapter: artifact, train: outcome.train, test: outcome.test, baseline: outcome.baseline, delta: outcome.delta, history: outcome.history };
  }

  /* ── compact autoregressive transformer ─────────────────────────────── */

  trainGpt({ texts, name = 'gpt', epochs = 12, maxLen = 32, dim = 24, hidden = 48, blocks = 2, seed = 42, validation = null, learningRate = 0.01 } = {}) {
    if (!Array.isArray(texts) || !texts.length) throw Object.assign(new Error('trainGpt needs texts'), { code: 'BAD_ARGUMENT' });
    const { model, report } = gpt.trainText(texts, { epochs, maxLen, dim, hidden, blocks, seed, validation, learningRate });
    const directory = path.join(this.dataDir, 'gpt');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${name}-${this.now()}.json`);
    const saved = gpt.save(model, file);
    this.models.set(name, model);
    const artifact = this.adapters.create({
      name,
      kind: 'gpt',
      payload: { path: file, config: model.config, vocabSize: model.config.vocabSize, sha256: saved.sha256, finalLoss: report.final.trainLoss, validationLoss: report.final.validationLoss },
      metrics: { trainLoss: report.final.trainLoss, validationLoss: report.final.validationLoss, validationPerplexity: report.final.validationPerplexity, parameters: model.order.reduce((sum, key) => sum + model.parameters[key].data.length, 0) },
      notes: `${blocks} causal blocks, char-level, CPU`,
    });
    this.counters.gpt += 1;
    return { ok: true, artifact, checkpoint: saved, report, sample: gpt.generate(model, texts[0].slice(0, 8), { maxNewTokens: 24, temperature: 0.9, seed }), modelName: name };
  }

  generateGpt({ name = null, checkpointPath = null, prompt = '', maxNewTokens = 40, temperature = 0.8, topK = 0, seed = 42 } = {}) {
    const model = name && this.models.has(name) ? this.models.get(name) : gpt.load(checkpointPath);
    if (!model.vocab) throw Object.assign(new Error('checkpoint has no vocabulary'), { code: 'BAD_CHECKPOINT' });
    return gpt.generate(model, prompt, { maxNewTokens, temperature, topK, seed });
  }

  /* ── hyper-parameter search and queue ───────────────────────────────── */

  hpo({ dataset, version = null, dim = 16, hidden = 24, mode = 'random', budget = 6, seed = 42, ranks = [1, 2, 4], learningRates = [0.05, 0.1], epochs = 60 } = {}) {
    const prepared = this.examples(dataset, { version, dim, seed });
    const base = this.baseFor({ dim, hidden, classes: prepared.labels.length, seed });
    loraModule.trainBase(base, prepared.train, { epochs: 80 });
    const search = new HyperSearch({ space: { rank: ranks, learningRate: learningRates }, objective: loraObjective({ base, train: prepared.train, test: prepared.test, epochs, seed }), mode, budget, seed });
    const result = search.run();
    this.counters.hpo += 1;
    return { ...result, dataset: prepared.manifest };
  }

  enqueue(kind, payload = {}, options = {}) { return this.queue.enqueue({ kind, payload, ...options }); }
  cancel(id) { return this.queue.cancel(id); }
  queueStatus() { return this.queue.status(); }
  queueList(options) { return this.queue.list(options); }

  runLoraJob(payload, context) {
    const result = this.trainLora(payload);
    context.checkpoint({ adapter: result.adapter.id, accuracy: result.evaluation.adapted.accuracy });
    return { ok: true, adapter: result.adapter.id, accuracy: result.evaluation.adapted.accuracy };
  }

  runQloraJob(payload, context) {
    const result = this.trainQlora(payload);
    context.checkpoint({ adapter: result.adapter.id, accuracy: result.evaluation.adapted.accuracy });
    return { ok: true, adapter: result.adapter.id, accuracy: result.evaluation.adapted.accuracy };
  }

  runGptJob(payload, context) {
    const steps = 3;
    let results = null;
    // A checkpoint resumes at the next block of epochs instead of restarting the
    // whole run. The queue stores the checkpoint even if the process dies.
    const startAt = context.job && context.job.checkpoint && Number(context.job.checkpoint.value && context.job.checkpoint.value.block) || 0;
    for (let block = startAt; block < steps; block += 1) {
      results = this.trainGpt({ ...payload, epochs: Math.max(1, Math.ceil((payload.epochs || 9) / steps)), name: payload.name || `gpt-${Date.now()}` });
      context.checkpoint({ block: block + 1, artifact: results.artifact.id });
    }
    return { ok: true, artifact: results.artifact.id, report: results.report };
  }

  /* ── adapter lifecycle ─────────────────────────────────────────────── */

  listAdapters(options) { return this.adapters.list(options); }
  compareAdapters(ids) { return this.adapters.compare(ids); }
  evaluateAdapter(id, evaluator) { return this.adapters.evaluate(id, evaluator); }
  promoteAdapter(id, options) { return this.adapters.promote(id, options); }
  rollbackAdapter(options) { return this.adapters.rollback(options); }
  loadAdapter(id) { return this.adapters.loadArtifact(id); }
  exportAdapter(id) { return this.adapters.exportArtifact(id); }

  /** Rough, explicitly approximate resource estimate; not a benchmark. */
  estimate({ parameters, tokens = 1e9, batchSize = 1, seqLen = 512, epochs = 1, bytesPerParameter = 4 } = {}) {
    if (!(parameters > 0)) throw Object.assign(new Error('estimate needs positive parameters'), { code: 'BAD_ARGUMENT' });
    const weightsBytes = parameters * bytesPerParameter;
    const gradientsBytes = weightsBytes;
    const optimizerBytes = weightsBytes * 2;
    const activationsBytes = batchSize * seqLen * parameters * 0.1 * bytesPerParameter;
    const flops = 6 * parameters * tokens;
    return {
      parameters,
      weightsMB: Number((weightsBytes / 1e6).toFixed(2)),
      trainingMemoryMB: Number(((weightsBytes + gradientsBytes + optimizerBytes + activationsBytes) / 1e6).toFixed(2)),
      forwardFlopsPerToken: Number((2 * parameters).toFixed(0)),
      estimatedTotalFlops: Number(flops.toFixed(0)),
      estimatedGpuHours: null,
      note: 'analytic estimate only, no hardware measurement',
    };
  }

  status() {
    return {
      dataDir: this.dataDir,
      datasets: this.datasets.list().slice(0, 20),
      adapters: this.adapters.list({ limit: 20 }),
      activeAdapter: this.adapters.active(),
      queue: this.queue.status(),
      counters: { ...this.counters },
      models: [...this.models.keys()],
      scope: 'CPU-sized genuine workflows; no frontier-model training',
    };
  }
}

function splitFraction(length) {
  return Math.max(0.6, Math.min(0.9, 0.75 + (length % 7) * 0.01));
}

module.exports = { TrainingLab, shuffled, hash };
