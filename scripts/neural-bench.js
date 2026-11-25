#!/usr/bin/env node
'use strict';

/**
 * Reproducible neural measurements for 7.0.
 *
 * Trains the intent MLP, the compact transformer and the retrieval reranker on
 * CPU, using temporary homes. Only measured metrics and timing are written to
 * docs/neural-7.0.json; weights stay outside the repository and are deleted.
 * Synthetic data and deterministic splits are named explicitly.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LearningLab } = require('../core/lab');
const { RerankerLab } = require('../core/reranker');
const { removeHome } = require('./lib/cleanup');

async function main() {
  const startedAll = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-neural-bench-'));
  process.env.SENTINEL_HOME = home;
  const paths = { dataDir: () => home };
  const lab = new LearningLab({ paths });
  const reranker = new RerankerLab({ paths });

  const startIntent = Date.now();
  const intent = lab.trainIntent({ approvedBy: 'benchmark', epochs: 60, seed: 7 });
  const intentMs = Date.now() - startIntent;
  if (!intent.ok) throw new Error(`intent training failed: ${intent.code}`);

  const startSentiment = Date.now();
  const sentiment = lab.trainSentiment({ approvedBy: 'benchmark', epochs: 10, seed: 7 });
  const sentimentMs = Date.now() - startSentiment;
  if (!sentiment.ok) throw new Error(`sentiment training failed: ${sentiment.code}`);

  const startReranker = Date.now();
  const rerank = reranker.train({ approvedBy: 'benchmark', seed: 5 });
  const rerankMs = Date.now() - startReranker;
  if (!rerank.ok) throw new Error(`reranker training failed: ${rerank.code}`);

  const report = {
    version: require('../package.json').version,
    at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    hardware: 'CPU only; no GPU was used or measured',
    totalMs: Date.now() - startedAll,
    models: {
      intent: {
        architecture: 'MLP 384→24→12→10, ReLU, softmax cross-entropy, Adam',
        dataset: { items: intent.experiment.dataset.items, labels: intent.experiment.labels.length, provenance: intent.experiment.dataset.provenance, split: intent.experiment.split, hash: intent.experiment.dataset.hash },
        metrics: intent.experiment.metrics,
        baseline: intent.experiment.baseline,
        delta: intent.experiment.delta,
        training: { epochsRun: intent.experiment.training.epochsRun, bestEpoch: intent.experiment.training.bestEpoch, bestValidationLoss: intent.experiment.training.bestValidationLoss },
        durationMs: intentMs,
        artifact: { bytes: intent.experiment.artifact.bytes, checksum: intent.experiment.artifact.checksum, location: 'SENTINEL_HOME/models (not committed)' },
      },
      sentiment: {
        architecture: 'single-block transformer: embeddings, self-attention, LayerNorm, ReLU FFN, mean pool; reverse-mode autograd',
        dataset: { items: sentiment.experiment.dataset.items, labels: sentiment.experiment.dataset.labels, provenance: sentiment.experiment.dataset.provenance, split: sentiment.experiment.split, hash: sentiment.experiment.dataset.hash },
        metrics: sentiment.experiment.metrics,
        baseline: sentiment.experiment.baseline,
        delta: sentiment.experiment.delta,
        gate: sentiment.experiment.gate,
        training: { epochsRun: sentiment.experiment.training.history.length, bestEpoch: sentiment.experiment.training.bestEpoch, bestValidationLoss: sentiment.experiment.training.bestValidationLoss, history: sentiment.experiment.training.history },
        durationMs: sentimentMs,
        artifact: { bytes: sentiment.experiment.artifact.bytes, checksum: sentiment.experiment.artifact.checksum, location: 'SENTINEL_HOME/models (not committed)' },
      },
      reranker: {
        architecture: '3-class MLP over six relevance features',
        dataset: rerank.experiment.dataset,
        metrics: rerank.experiment.metrics,
        baseline: rerank.experiment.baseline,
        delta: rerank.experiment.delta,
        gate: rerank.experiment.gate,
        training: { epochsRun: rerank.experiment.training.epochsRun, bestEpoch: rerank.experiment.training.bestEpoch, bestValidationLoss: rerank.experiment.training.bestValidationLoss },
        durationMs: rerankMs,
        artifact: { bytes: rerank.experiment.artifact.bytes, checksum: rerank.experiment.artifact.checksum, location: 'SENTINEL_HOME/models (not committed)' },
      },
    },
    honest: 'All metrics are measured on synthetic held-out data in this environment. They are not benchmarks of language understanding and are not comparable to frontier LLMs.',
  };
  const target = path.join(__dirname, '..', 'docs', 'neural-7.0.json');
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written: ${target}`);
  console.log(`intent: ${report.models.intent.metrics.accuracy} vs ${report.models.intent.baseline.accuracy} (${intentMs} ms)`);
  console.log(`sentiment transformer: ${report.models.sentiment.metrics.accuracy} vs ${report.models.sentiment.baseline.accuracy} (${sentimentMs} ms)`);
  console.log(`reranker NDCG@3: ${report.models.reranker.metrics.ndcgAt3} vs ${report.models.reranker.baseline.ndcgAt3} (${rerankMs} ms)`);
  console.log(`total ${report.totalMs} ms`);
  await removeHome(home);
}

main().catch(async (err) => {
  console.error(`neural benchmark failed: ${err.message}`);
  process.exitCode = 3;
});
