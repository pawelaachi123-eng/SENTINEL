#!/usr/bin/env node
'use strict';

/**
 * Reproducible learning-lab measurement.
 *
 * Trains one small intent classifier with a fixed seed, on CPU, and writes the
 * measured metrics to docs/lab-6.0.json. Weights are written to a temporary
 * SENTINEL_HOME and removed; only the report is kept. No model, network or GPU
 * is involved.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LearningLab } = require('../core/lab');
const { removeHome } = require('./lib/cleanup');

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lab-bench-'));
  process.env.SENTINEL_HOME = home;
  const paths = { dataDir: () => home };
  const lab = new LearningLab({ paths });
  const started = Date.now();
  const result = lab.trainIntent({ approvedBy: 'benchmark', epochs: 60, seed: 7 });
  if (!result.ok) {
    console.error(`lab benchmark failed: ${result.code} ${result.message || ''}`);
    await removeHome(home);
    process.exitCode = 3;
    return;
  }
  const experiment = result.experiment;
  const report = {
    version: require('../package.json').version,
    at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    task: 'intent-classification',
    dataset: { items: experiment.dataset.items, labels: experiment.labels.length, provenance: experiment.dataset.provenance, hash: experiment.dataset.hash },
    split: experiment.split,
    hyperparameters: experiment.hyperparameters,
    training: { epochsRun: experiment.training.epochsRun, bestEpoch: experiment.training.bestEpoch, bestValidationLoss: experiment.training.bestValidationLoss, history: experiment.training.history },
    metrics: experiment.metrics,
    baseline: experiment.baseline,
    delta: experiment.delta,
    artifact: { bytes: experiment.artifact.bytes, checksum: experiment.artifact.checksum, location: 'SENTINEL_HOME/models (not in the repository)' },
    durationMs: Date.now() - started,
    status: experiment.status,
    honest: 'CPU-trained small MLP on synthetic data; not LoRA and not a language model. Weights are not committed.',
  };
  const target = path.join(__dirname, '..', 'docs', 'lab-6.0.json');
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written: ${target}`);
  console.log(`test accuracy ${report.metrics.accuracy} vs baseline ${report.baseline.accuracy}; macro-F1 ${report.metrics.macroF1}; ${report.training.epochsRun} epochs; ${report.artifact.bytes} B checkpoint; ${report.durationMs} ms total`);
  await removeHome(home);
}

main().catch(async (err) => {
  console.error(`lab benchmark failed: ${err.message}`);
  process.exitCode = 3;
});
