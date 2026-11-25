#!/usr/bin/env node
'use strict';

/**
 * Reproducible measurements for the four specialist classifiers.
 *
 * Training runs on CPU in a temporary home; weights are deleted afterwards and
 * only measured metrics, dataset checksums and timing are written to
 * docs/specialists-7.0.json. Synthetic provenance and baselines are explicit.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SpecialistZoo } = require('../core/specialists');
const { removeHome } = require('./lib/cleanup');

function main() {
  const startedAll = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-specialists-bench-'));
  try {
    const zoo = new SpecialistZoo({ paths: { dataDir: () => home } });
    const models = {};
    for (const task of ['tools', 'routing', 'relevance', 'complexity']) {
      const started = Date.now();
      const trained = zoo.train(task, { approvedBy: 'benchmark' });
      if (!trained.ok) throw new Error(`${task} training failed: ${trained.code} ${trained.message}`);
      models[task] = {
        experiment: trained.experiment.id,
        dataset: trained.experiment.dataset,
        split: trained.experiment.split,
        metrics: trained.experiment.metrics,
        baseline: trained.experiment.baseline,
        delta: trained.experiment.delta,
        gate: trained.experiment.gate,
        training: { ...trained.experiment.training, measuredDurationMs: Date.now() - started },
        artifact: { bytes: trained.experiment.artifact.bytes, checksum: trained.experiment.artifact.checksum },
      };
      if (trained.experiment.gate.passed) {
        zoo.promote(task, trained.experiment.id, { approvedBy: 'benchmark' });
      }
    }
    const examples = {
      tools: zoo.recommendTool('sprawdź ile mam RAM'),
      routing: zoo.route('napraw błąd w teście'),
      relevance: zoo.memoryRelevance({ query: 'jak przywrócić backup', memory: 'procedura przywracania kopii zapasowej' }),
      complexity: zoo.complexity('zbadaj temat, zbierz źródła, porównaj i napisz raport'),
    };
    const safeExamples = Object.fromEntries(Object.entries(examples).map(([task, result]) => [task, {
      ok: result.ok,
      label: result.label,
      confidence: result.confidence,
      neural: result.neural || null,
      baseline: result.baseline ?? null,
      usedFallback: result.usedFallback ?? false,
      model: result.model || null,
    }]));
    const report = {
      version: require('../package.json').version,
      at: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      hardware: 'CPU only; no GPU was used or measured',
      totalMs: Date.now() - startedAll,
      models,
      examples: safeExamples,
      honesty: [
        'Datasets are authored synthetic examples, not private conversations or scraped data.',
        'Text models use hashed character n-gram features plus authored lexical keyword features; they are not language understanding.',
        'Held-out authored requests are never seen verbatim during fitting; generated training paraphrases come from the lexicons in core/ml/data/specialists.js.',
        'A model at or below its named baseline is not promoted.',
        'No live phone, email, GPU or language-model measurement is included in this file.',
      ],
    };
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'specialists-7.0.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote docs/specialists-7.0.json (${report.totalMs} ms)`);
    for (const [task, model] of Object.entries(models)) console.log(`  ${task.padEnd(12)} ${model.metrics.accuracy} vs ${model.baseline.accuracy} gate=${model.gate.passed}`);
  } finally {
    removeHome(home);
  }
}

try {
  main();
} catch (err) {
  console.error(`specialists-bench failed: ${err.message}`);
  process.exitCode = 1;
}
