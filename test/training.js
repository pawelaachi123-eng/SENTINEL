'use strict';

/**
 * Training lab, compact language model and GraphRAG checks.
 *
 * These are execution tests, not descriptions: every metric asserted here was
 * produced by the code in this run. They use temporary directories, fixed seeds
 * and no network. Nothing in this file claims GPU or frontier-model training.
 */

process.env.SENTINEL_HOME = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sentinel-training-'));

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const autograd = require('../core/ml/autograd');
const gpt = require('../core/ml/gpt');
const { TrainingLab } = require('../core/lab/index.js');
const { TrainingQueue } = require('../core/lab/queue');
const { DatasetRegistry } = require('../core/lab/datasets');
const { GraphRAG } = require('../core/knowledge/graphrag');
const { Knowledge } = require('../core/knowledge');
const { openStore } = require('../core/memory/store');

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const words = ['alpha', 'beta', 'gamma', 'delta'];
function rowsFor(shift, count = 120) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const group = index % 4;
    rows.push({ text: `${words[group]} sample number ${index} distinct token ${words[group]}`, label: words[(group + shift) % 4] });
  }
  return rows;
}

(async () => {
  const root = path.join(process.env.SENTINEL_HOME, 'training');
  fs.mkdirSync(root, { recursive: true });
  const lab = new TrainingLab({ dataDir: root, concurrency: 1 });

  /* ── datasets ───────────────────────────────────────────────────────── */

  await test('datasets are content-addressed, immutable and reproducible', () => {
    const first = lab.createDataset({ name: 'source', rows: rowsFor(0), schema: { text: 'string', label: 'string' } });
    const second = lab.createDataset({ name: 'source', rows: rowsFor(0).slice(0, 40) });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(first.rows, 120);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    const a = lab.splitDataset('source', { version: 1, seed: 9 });
    const b = lab.splitDataset('source', { version: 1, seed: 9 });
    assert.deepEqual(a.train[0], b.train[0]);
    assert.equal(a.train.length + a.validation.length + a.test.length, 120);
    return `v${first.version} ${first.sha256.slice(0, 12)}`;
  });

  await test('dataset corruption and personal-data approval are refused', () => {
    assert.throws(() => lab.createDataset({ name: 'private', rows: rowsFor(1), personalData: true }), /approving identity/);
    const approved = lab.createDataset({ name: 'private', rows: rowsFor(1), personalData: true, approvedBy: 'tester' });
    assert.equal(approved.personalData, true);
    assert.equal(approved.approvedBy, 'tester');
    const manifest = lab.datasets.get('source', 1);
    fs.appendFileSync(manifest.file, '{"text":"tampered","label":"alpha"}\n');
    assert.throws(() => lab.datasets.load('source', 1), /corrupt/);
    return 'hash mismatch rejected';
  });

  await test('datasets inside the source tree are refused', () => {
    assert.throws(() => new DatasetRegistry({ dataDir: path.join(process.cwd(), 'data-test'), sourceRoot: process.cwd() }), /outside the source tree/);
    return 'source-tree guard active';
  });

  /* ── LoRA / QLoRA ───────────────────────────────────────────────────── */

  await test('LoRA adapts a frozen base and reports both accuracies', () => {
    lX: {
      try { lab.createDataset({ name: 'target', rows: rowsFor(1), schema: { text: 'string', label: 'string' } }); } catch (err) { if (!/duplicate/i.test(err.message)) throw err; }
    }
    const result = lab.trainLora({ dataset: 'target', sourceDataset: 'source', dim: 24, hidden: 24, rank: 2, epochs: 140, seed: 3 });
    assert.equal(result.evaluation.adapted.cases, result.evaluation.frozen.cases);
    assert.ok(result.evaluation.adapted.accuracy >= result.evaluation.frozen.accuracy, 'adapter was worse than the frozen base');
    assert.ok(result.evaluation.adapted.accuracy >= 0.8, `adapter accuracy ${result.evaluation.adapted.accuracy}`);
    assert.ok(result.trainableParameters < result.frozenParameters);
    assert.match(result.adapter.sha256, /^[0-9a-f]{64}$/);
    return `${result.evaluation.adapted.accuracy} vs ${result.evaluation.frozen.accuracy}, ${result.trainableParameters} trainable`;
  });

  await test('QLoRA stores a 4-bit frozen base and still adapts', () => {
    const result = lab.trainQlora({ dataset: 'target', sourceDataset: 'source', dim: 24, hidden: 24, rank: 2, epochs: 140, seed: 3 });
    assert.equal(result.quantization.bits, 4);
    assert.ok(result.quantization.w1RelativeError > 0);
    assert.ok(result.quantization.frozenBytes > 0);
    assert.ok(result.evaluation.adapted.accuracy >= result.evaluation.frozen.accuracy);
    return `4-bit error ${result.quantization.w1RelativeError}, accuracy ${result.evaluation.adapted.accuracy}`;
  });

  await test('distillation and preference training produce measured metrics', () => {
    const distilled = lab.distill({ dataset: 'source', dim: 24, teacherHidden: 24, studentHidden: 8, epochs: 60, teacherEpochs: 80, seed: 4 });
    assert.ok(distilled.teacher.evaluation.accuracy >= 0.5);
    assert.equal(distilled.plain.evaluation.cases, distilled.distilled.evaluation.cases);
    const preference = lab.preference({ count: 60, epochs: 60, seed: 4 });
    assert.ok(preference.test.accuracy >= preference.baseline.accuracy);
    return `teacher ${distilled.teacher.evaluation.accuracy}, student ${distilled.distilled.evaluation.accuracy}; preference ${preference.test.accuracy}`;
  });

  await test('hyper-parameter search records every trial', () => {
    const search = lab.hpo({ dataset: 'source', budget: 4, epochs: 25, hidden: 12, seed: 5 });
    assert.equal(search.evaluated, 4);
    assert.ok(search.best && Number.isFinite(search.best.score));
    assert.equal(search.trials.length, 4);
    return `${JSON.stringify(search.best.params)} → ${search.best.score}`;
  });

  /* ── adapters ───────────────────────────────────────────────────────── */

  await test('adapter registry compares, gates promotion and rolls back', () => {
    const adapters = lab.listAdapters({ limit: 20 });
    assert.ok(adapters.length >= 3);
    const lora = adapters.find((entry) => entry.kind === 'lora');
    const qlora = adapters.find((entry) => entry.kind === 'qlora');
    const comparison = lab.compareAdapters([lora.id, qlora.id]);
    assert.ok(comparison.ok);
    assert.ok(comparison.best);
    const refused = lab.promoteAdapter(lora.id, {});
    assert.equal(refused.code, 'APPROVAL_REQUIRED');
    const promoted = lab.promoteAdapter(lora.id, { approvedBy: 'tester' });
    assert.equal(promoted.ok, true);
    assert.equal(lab.adapters.active().id, lora.id);
    const rolled = lab.rollbackAdapter({ approvedBy: 'tester' });
    assert.ok(rolled.ok || rolled.code === 'NO_PREVIOUS');
    const loaded = lab.loadAdapter(lora.id);
    assert.ok(loaded.payload.weights);
    return `best ${comparison.best.slice(0, 18)}`;
  });

  /* ── queue ──────────────────────────────────────────────────────────── */

  await test('queue retries, honours cancellation and survives a restart', async () => {
    const directory = path.join(process.env.SENTINEL_HOME, 'queue');
    fs.rmSync(directory, { recursive: true, force: true });
    let attempts = 0;
    const queue = new TrainingQueue({
      dataDir: directory,
      concurrency: 1,
      retryBaseMs: 5,
      runners: {
        flaky: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('first attempt fails'), { code: 'FLAKY' });
          return { ok: true };
        },
        long: async (payload, { signal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 2000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
        }),
      },
    });
    queue.start();
    const flaky = queue.enqueue({ kind: 'flaky', maxRetries: 1 });
    const finished = await queue.wait(flaky.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(attempts, 2);
    const long = queue.enqueue({ kind: 'long' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(queue.cancel(long.id).ok, true);
    const cancelled = await queue.wait(long.id);
    assert.equal(cancelled.status, 'cancelled');
    const dead = new TrainingQueue({ dataDir: directory, runners: { flaky: async () => ({ ok: true }) } });
    assert.equal(dead.list({ limit: 10 }).length, 2);
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'training-queue.json'), 'utf8'));
    snapshot.jobs[0].status = 'running';
    fs.writeFileSync(path.join(directory, 'training-queue.json'), JSON.stringify(snapshot));
    const recovered = new TrainingQueue({ dataDir: directory, runners: { flaky: async () => ({ ok: true }) } });
    const recoveredJob = recovered.list({ limit: 10 }).find((job) => job.recovered);
    assert.ok(recoveredJob, 'a previously running job was not marked recovered');
    await queue.stop({ cancelRunning: true });
    return 'retry + cancel + restart recovery';
  });

  /* ── compact transformer ────────────────────────────────────────────── */

  await test('the compact transformer learns and its attention is causal', () => {
    const corpus = 'the quick brown fox jumps over the lazy dog. the quick brown fox runs away. ';
    const { model, report } = gpt.trainText(corpus.repeat(4), { epochs: 6, maxLen: 24, dim: 16, hidden: 32, seed: 7, maxVocab: 40 });
    assert.ok(report.final.trainLoss < report.history[0].trainLoss, `loss did not fall: ${report.history[0].trainLoss} → ${report.final.trainLoss}`);
    const forward = gpt.forward(model, gpt.encode('the quick brown', model.vocab), { keepAttention: true });
    const attention = forward.attentions[0];
    for (let row = 0; row < attention.rows; row += 1) {
      for (let column = row + 1; column < attention.cols; column += 1) assert.equal(attention.data[row * attention.cols + column], 0, 'attention leaks into the future');
      let sum = 0;
      for (let column = 0; column <= row; column += 1) sum += attention.data[row * attention.cols + column];
      assert.ok(Math.abs(sum - 1) < 1e-6, 'attention row does not sum to one');
    }
    const sample = gpt.generate(model, 'the ', { maxNewTokens: 16, temperature: 0.9, seed: 2 });
    assert.equal(sample.text.length, 16);
    const file = path.join(root, 'gpt-check.json');
    const saved = gpt.save(model, file);
    const restored = gpt.load(file);
    assert.equal(saved.bytes > 0, true);
    assert.equal(gpt.generate(restored, 'the ', { maxNewTokens: 6, temperature: 0, seed: 1 }).text, gpt.generate(model, 'the ', { maxNewTokens: 6, temperature: 0, seed: 1 }).text);
    return `loss ${report.history[0].trainLoss.toFixed(3)} → ${report.final.trainLoss.toFixed(3)}, ${saved.bytes} B`;
  });

  await test('new autograd ops pass numeric gradient checks', () => {
    const scores = autograd.fromRows([[0.5, -0.2, 0.1], [0.3, 0.8, -0.4]]);
    const check = autograd.checkGradient(() => {
      const attention = autograd.causalRowSoftmax(scores);
      const last = autograd.lastRow(attention);
      return autograd.softCrossEntropy(last, [0.2, 0.3, 0.5]).loss;
    }, [scores], { checks: 6 });
    assert.equal(check.ok, true, `worst numeric gradient difference ${check.worst}`);
    assert.ok(check.checked >= 3);
    return `worst gradient difference ${check.worst.toExponential(2)} across ${check.checked} entries`;
  });

  /* ── GraphRAG ───────────────────────────────────────────────────────── */

  await test('GraphRAG extracts entities, resolves aliases and walks multiple hops', () => {
    const graph = new GraphRAG({ dataDir: path.join(process.env.SENTINEL_HOME, 'graph'), now: () => 1 });
    graph.ingest({ docId: 'doc-a', chunkId: 'doc-a:0000', text: 'Acme uses PostgreSQL. PostgreSQL depends on Linux. Anna Kowalska works at Acme. Acme owns Projekt Atlas.' });
    graph.ingest({ docId: 'doc-b', chunkId: 'doc-b:0000', text: 'ACME owns Linux.' });
    const stats = graph.stats();
    assert.ok(stats.entities >= 5);
    assert.ok(stats.edges >= 4);
    const expansion = graph.expand('PostgreSQL', { hops: 2, limit: 10 });
    assert.ok(expansion.results.some((row) => row.documentId === 'doc-a'));
    const aliases = graph.listEntities({ query: 'acme' });
    assert.equal(aliases.length, 1, 'case-folded alias created a duplicate entity');
    assert.ok(aliases[0].aliases.includes('ACME') || aliases[0].name === 'ACME');
    const citation = graph.validateCitation({ chunkId: 'doc-a:0000', terms: ['Acme', 'Linux'] });
    assert.equal(citation.ok, true);
    assert.ok(citation.coverage >= 0.5);
    const contradictions = graph.contradictions();
    assert.ok(Array.isArray(contradictions));
    return `${stats.entities} entities, ${stats.edges} relations, ${stats.merges} merges`;
  });

  await test('GraphRAG persists, exports and imports without duplicating edges', () => {
    const directory = path.join(process.env.SENTINEL_HOME, 'graph-persist');
    const first = new GraphRAG({ dataDir: directory });
    first.ingest({ docId: 'd', chunkId: 'd:0000', text: 'Sentinel uses Node. Node depends on Linux.' });
    first.persist();
    const second = new GraphRAG({ dataDir: directory });
    assert.deepEqual(second.stats().edges, first.stats().edges);
    const exported = second.exportGraph();
    const third = new GraphRAG({});
    third.importGraph(exported);
    const before = third.stats().edges;
    third.importGraph(exported);
    assert.equal(third.stats().edges, before);
    return `${before} edges round-trip`;
  });

  await test('knowledge search is graph-boosted and validates citations', async () => {
    const home = path.join(process.env.SENTINEL_HOME, 'knowledge-home');
    fs.mkdirSync(home, { recursive: true });
    const store = openStore({ dir: home, log: null });
    const graph = new GraphRAG({ dataDir: home });
    const knowledge = new Knowledge({ store, graph, log: null });
    const indexed = await knowledge.indexText({ title: 'Acme systems', text: 'Acme uses PostgreSQL for billing. PostgreSQL depends on Linux servers.' });
    assert.equal(indexed.chunks, 1);
    const hits = await knowledge.search('What does Acme use?', { limit: 2 });
    assert.equal(hits.length, 1);
    assert.ok(hits[0].graphBoost >= 0, 'graph boost is missing from the result');
    const valid = knowledge.validateCitations([{ chunkId: hits[0].id, terms: ['Acme', 'PostgreSQL'] }]);
    assert.equal(valid[0].ok, true);
    const invalid = knowledge.validateCitations([{ chunkId: 'missing:0000' }]);
    assert.equal(invalid[0].ok, false);
    store.close();
    return `chunk ${hits[0].id.slice(0, 14)}`;
  });

  /* ── summary ────────────────────────────────────────────────────────── */

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} training checks passed.`);
  if (failed.length) process.exitCode = 1;
})();
