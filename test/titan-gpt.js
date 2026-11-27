#!/usr/bin/env node
'use strict';

/**
 * TITAN GPT 2.0 and the new autograd operations.
 *
 * These are numerical tests: finite-difference gradients for each new op, a
 * real training run whose loss must fall, a checkpoint whose logits must match
 * bit-for-bit, and a tokenizer that must round-trip Unicode.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autograd = require('../core/ml/autograd');
const bpe = require('../core/ml/bpe');
const titan = require('../core/ml/titan-gpt');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-titan-'));
const corpus = [
  'the quick brown fox jumps over the lazy dog. '.repeat(30),
  'zażółć gęślą jaźń. Programowanie jest procesem. '.repeat(12),
];

check('BPE round-trips ASCII, Polish and emoji', () => {
  const tokenizer = bpe.trainBpe(corpus, { vocabSize: 320, minFrequency: 2 });
  for (const text of ['the quick fox', 'zażółć gęślą jaźń', '🙂 unicode ✓']) {
    const ids = bpe.encode(text, tokenizer);
    assert.ok(ids.length > 0);
    assert.equal(bpe.decode(ids, tokenizer), text);
  }
  assert.equal(tokenizer.vocabSize, 256 + tokenizer.merges.length);
  return `${tokenizer.vocabSize} tokens`;
});

check('BPE compresses frequent text below its byte count', () => {
  const tokenizer = bpe.trainBpe(corpus, { vocabSize: 320, minFrequency: 2 });
  const sample = 'the quick brown fox';
  assert.ok(bpe.encode(sample, tokenizer).length < Buffer.byteLength(sample));
  return `${bpe.encode(sample, tokenizer).length} tokens vs ${Buffer.byteLength(sample)} bytes`;
});

check('BPE checkpoints survive save and load', () => {
  const tokenizer = bpe.trainBpe(corpus, { vocabSize: 300, minFrequency: 2 });
  const file = path.join(tmp, 'tokenizer.json');
  const saved = bpe.save(tokenizer, file);
  assert.equal(saved.ok, true);
  const loaded = bpe.load(file);
  assert.deepEqual(bpe.encode('quick brown', loaded), bpe.encode('quick brown', tokenizer));
});

check('BPE rejects an impossible vocabulary size', () => {
  assert.throws(() => bpe.trainBpe(['abc'], { vocabSize: 10 }), (err) => err.code === 'BAD_VOCAB');
});

check('slice and concat are inverse operations', () => {
  const matrix = autograd.fromRows([[1, 2, 3, 4], [5, 6, 7, 8]]);
  const joined = autograd.concatCols([autograd.sliceCols(matrix, 0, 2), autograd.sliceCols(matrix, 2, 2)]);
  assert.deepEqual(Array.from(joined.data), Array.from(matrix.data));
  assert.deepEqual(joined.shape, [2, 4]);
});

const params = autograd.matrix(2, 4);
params.data.set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
const gamma = autograd.leaf(1, 4, 1);
const scalar = (node) => {
  const squared = autograd.mul(node, node);
  const total = autograd.sumAll(squared);
  return autograd.mul(total, total);
};

check('RMSNorm has a finite-difference-correct gradient', () => {
  const result = autograd.checkGradient(() => scalar(autograd.rmsNorm(params, gamma)), [params, gamma], { checks: 6 });
  assert.equal(result.ok, true, `worst difference ${result.worst}`);
  return `worst ${result.worst.toExponential(2)}`;
});

check('RoPE has a finite-difference-correct gradient', () => {
  const result = autograd.checkGradient(() => scalar(autograd.rope(params, [0, 1], 2)), [params], { checks: 6 });
  assert.equal(result.ok, true, `worst difference ${result.worst}`);
  return `worst ${result.worst.toExponential(2)}`;
});

check('SwiGLU components have finite-difference-correct gradients', () => {
  const result = autograd.checkGradient(() => scalar(autograd.silu(params)), [params], { checks: 6 });
  assert.equal(result.ok, true, `worst difference ${result.worst}`);
  return `worst ${result.worst.toExponential(2)}`;
});

check('RMSNorm changes the row RMS to the learned scale', () => {
  const matrix = autograd.fromRows([[3, 4]]);
  const scale = autograd.leaf(1, 2, 1);
  const normalized = autograd.rmsNorm(matrix, scale, 1e-12);
  const rms = Math.sqrt((normalized.data[0] ** 2 + normalized.data[1] ** 2) / 2);
  assert.ok(Math.abs(rms - 1) < 1e-6);
});

check('grouped-query attention validates head groups', () => {
  assert.throws(() => titan.createModel({ vocabSize: 20, dim: 16, heads: 4, kvHeads: 3, blocks: 1, maxLen: 8 }), (err) => err.code === 'BAD_CONFIG');
  assert.throws(() => titan.createModel({ vocabSize: 20, dim: 16, heads: 3, kvHeads: 1, blocks: 1, maxLen: 8 }), (err) => err.code === 'BAD_CONFIG');
});

const { model, tokenizer } = titan.initText(corpus, {
  vocabSize: 280,
  dim: 16,
  heads: 2,
  kvHeads: 1,
  blocks: 1,
  maxLen: 12,
  hidden: 24,
  seed: 7,
});

check('the model has the exact parameter count it reports', () => {
  const counted = titan.parameterCount(model);
  const summed = model.order.reduce((sum, name) => sum + model.parameters[name].data.length, 0);
  assert.equal(counted, summed);
  assert.ok(counted > 1000);
  return `${counted} parameters`;
});

check('forward returns one finite logit row per token', () => {
  const ids = bpe.encode('the quick', tokenizer).slice(0, 6);
  const result = titan.forward(model, ids);
  assert.equal(result.logits.rows, ids.length);
  assert.equal(result.logits.cols, model.config.vocabSize);
  assert.ok(Array.from(result.logits.data).every(Number.isFinite));
});

check('causal attention cannot see future tokens', () => {
  const ids = bpe.encode('the quick', tokenizer).slice(0, 4);
  const result = titan.forward(model, ids, { keepAttention: true });
  const attention = result.attentions[0];
  assert.equal(attention.rows, ids.length);
  assert.equal(attention.data[1], 0, 'the first row attended to a future token');
  assert.ok(attention.data[0] > 0);
});

check('training reduces measured loss on held-in data', () => {
  const report = titan.train(model, corpus, { epochs: 3, batchSize: 4, maxSamples: 36, learningRate: 0.006, seed: 11 });
  assert.equal(report.history.length, 3);
  assert.ok(report.history[2].trainLoss < report.history[0].trainLoss, `loss ${report.history[0].trainLoss} -> ${report.history[2].trainLoss}`);
  assert.ok(report.history.every((row) => Number.isFinite(row.trainPerplexity)));
  return `${report.history[0].trainLoss.toFixed(3)} → ${report.history[2].trainLoss.toFixed(3)}`;
});

check('a checkpoint restores weights, optimizer and tokenizer', () => {
  const file = path.join(tmp, 'titan.json');
  const saved = titan.save(model, file);
  assert.equal(saved.ok, true);
  const loaded = titan.load(file);
  assert.equal(loaded.tokenizer.vocabSize, model.tokenizer.vocabSize);
  assert.equal(loaded.training.optimizer.step, model.training.optimizer.step);
  const ids = bpe.encode('the quick', tokenizer).slice(0, 5);
  const before = titan.forward(model, ids).logits.data;
  const after = titan.forward(loaded, ids).logits.data;
  for (let index = 0; index < before.length; index += 1) assert.ok(Math.abs(before[index] - after[index]) < 1e-9);
  return `${saved.bytes} bytes`;
});

check('generation is deterministic for a fixed seed and bounded by maxNewTokens', () => {
  const first = titan.generate(model, 'the quick', { maxNewTokens: 4, seed: 5 });
  const second = titan.generate(model, 'the quick', { maxNewTokens: 4, seed: 5 });
  assert.deepEqual(first.ids, second.ids);
  assert.equal(first.generated, 4);
  assert.ok(first.tokensPerSecond > 0);
  return `${first.newText.replace(/\n/g, ' ')} @ ${first.tokensPerSecond} tok/s`;
});

check('an invalid checkpoint is refused', () => {
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'other', version: 1 }));
  assert.throws(() => titan.load(file), (err) => err.code === 'BAD_CHECKPOINT');
});

console.log(`\n${passed} of ${passed + failures.length} TITAN GPT checks passed.`);
if (failures.length) process.exitCode = 1;
