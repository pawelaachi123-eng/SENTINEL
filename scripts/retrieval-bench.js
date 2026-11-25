#!/usr/bin/env node
'use strict';

/** Measures the unified retriever on the authored graded retrieval set. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedRetriever, benchmarkFromRelevanceData } = require('../core/retrieval/unified');
const { cases } = require('../core/ml/data/relevance');
const { SpecialistZoo } = require('../core/specialists');
const { RerankerLab } = require('../core/reranker');
const { removeHome } = require('./lib/cleanup');

function main() {
  const started = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-retrieval-'));
  try {
    const { documents, cases: items } = benchmarkFromRelevanceData(cases());
    const plain = new UnifiedRetriever({ documents });
    const plainReport = plain.benchmark(items, { k: 3 });
    const zoo = new SpecialistZoo({ paths: { dataDir: () => home } });
    const semantic = zoo.train('semantic', { approvedBy: 'benchmark' });
    const reranker = new RerankerLab({ paths: { dataDir: () => home } });
    const rerank = reranker.train({ approvedBy: 'benchmark' });
    if (!semantic.ok || !rerank.ok) throw new Error('could not train retrieval models for measurement');
    zoo.promote('semantic', semantic.experiment.id, { approvedBy: 'benchmark' });
    reranker.promote(rerank.experiment.id, { approvedBy: 'benchmark' });
    const neural = new UnifiedRetriever({ documents, specialists: zoo, reranker });
    const neuralReport = neural.benchmark(items, { k: 3 });
    const report = {
      version: require('../package.json').version,
      at: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      corpusDocuments: documents.length,
      cases: items.length,
      modes: { ...plainReport.modes, neural: neuralReport.modes.neural },
      latency: { ...plainReport.latency, neural: neuralReport.latency.neural },
      provenance: { features: 'hashed word unigrams + char 4-grams', fusion: 'reciprocal-rank fusion (0.55 lexical, 0.35 vector, 0.10 graph)', reranker: 'promoted retrieval reranker', semantic: 'promoted semantic specialist' },
      totalMs: Date.now() - started,
      honesty: [
        'The corpus and graded judgments are authored synthetic data, not a production search log.',
        'A 64-document corpus is a smoke-scale retrieval benchmark; it is not a claim of web-scale quality.',
        'The neural mode is measured only with promoted checkpoints created in a temporary home.',
        'Failure to improve NDCG is reported as measured; no number is selected for presentation.',
      ],
    };
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'retrieval-7.1.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote docs/retrieval-7.1.json (${report.totalMs} ms)`);
    for (const [mode, value] of Object.entries(report.modes)) console.log(`  ${mode.padEnd(8)} NDCG@3 ${value.ndcgAtK} MRR ${value.mrr} recall ${value.recallAtK}`);
  } finally {
    removeHome(home);
  }
}

try {
  main();
} catch (err) {
  console.error(`retrieval-bench failed: ${err.message}`);
  process.exitCode = 1;
}
