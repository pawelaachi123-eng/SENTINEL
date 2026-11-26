'use strict';

/**
 * A compact, trainable transformer encoder for sentence classification.
 *
 * Architecture (one block, implemented with real matrix autograd):
 *   token embeddings + positional embeddings
 *   → LayerNorm → single-head self-attention (Q,K,V, output projection)
 *   → residual → LayerNorm → position-wise ReLU feed-forward → residual
 *   → mean pooling → linear classifier
 *
 * It is a genuine network with a real forward pass, softmax cross-entropy and
 * reverse-mode gradients, but it is tiny. It is not a language model, cannot
 * generate text, and is never compared to a frontier LLM.
 */

const crypto = require('node:crypto');
const autograd = require('./autograd');

const FORMAT = 'sentinel-transformer-v1';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function buildVocab(texts, { maxVocab = 2000 } = {}) {
  const counts = new Map();
  for (const text of texts) for (const token of tokenize(text)) counts.set(token, (counts.get(token) || 0) + 1);
  const words = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxVocab).map(([word]) => word);
  return { words, index: new Map([['<pad>', 0], ['<unk>', 1], ...words.map((word, position) => [word, position + 2])]) };
}

function encode(text, vocab, maxLen = 16) {
  const tokens = tokenize(text).slice(0, maxLen);
  const ids = tokens.map((token) => vocab.index.has(token) ? vocab.index.get(token) : 1);
  const positions = ids.map((_, index) => index);
  while (ids.length < maxLen) {
    ids.push(0);
    positions.push(ids.length - 1);
  }
  return { ids, positions, length: tokens.length || 1 };
}

function parameter(rows, cols, rng, scale) {
  return autograd.leaf(rows, cols, () => normal(rng) * scale);
}

function createModel({ vocabSize, classes, dim = 24, hidden = 48, maxLen = 16, seed = 42 } = {}) {
  if (!(vocabSize >= 2) || !(classes > 1) || !(dim > 0) || !(maxLen > 0)) throw Object.assign(new Error('invalid transformer configuration'), { code: 'BAD_NETWORK' });
  const rng = mulberry32(seed);
  const xavier = (fanIn, fanOut) => Math.sqrt(2 / (fanIn + fanOut));
  const parameters = {
    embedding: parameter(vocabSize, dim, rng, 0.08),
    position: parameter(maxLen, dim, rng, 0.02),
    norm1Gamma: autograd.leaf(1, dim, 1),
    norm1Beta: autograd.leaf(1, dim, 0),
    wq: parameter(dim, dim, rng, xavier(dim, dim)),
    bq: autograd.leaf(1, dim, 0),
    wk: parameter(dim, dim, rng, xavier(dim, dim)),
    bk: autograd.leaf(1, dim, 0),
    wv: parameter(dim, dim, rng, xavier(dim, dim)),
    bv: autograd.leaf(1, dim, 0),
    wo: parameter(dim, dim, rng, xavier(dim, dim)),
    bo: autograd.leaf(1, dim, 0),
    norm2Gamma: autograd.leaf(1, dim, 1),
    norm2Beta: autograd.leaf(1, dim, 0),
    w1: parameter(dim, hidden, rng, xavier(dim, hidden)),
    b1: autograd.leaf(1, hidden, 0),
    w2: parameter(hidden, dim, rng, xavier(hidden, dim)),
    b2: autograd.leaf(1, dim, 0),
    classifier: parameter(dim, classes, rng, xavier(dim, classes)),
    classifierBias: autograd.leaf(1, classes, 0),
  };
  return { format: FORMAT, vocabSize, classes, dim, hidden, maxLen, seed, parameters, order: Object.keys(parameters) };
}

function forward(model, encoded) {
  const p = model.parameters;
  const tokens = autograd.gather(p.embedding, encoded.ids);
  const positions = autograd.gather(p.position, encoded.positions);
  let x = autograd.layerNorm(autograd.add(tokens, positions), p.norm1Gamma, p.norm1Beta);
  const q = autograd.addBias(autograd.matmul(x, p.wq), p.bq);
  const k = autograd.addBias(autograd.matmul(x, p.wk), p.bk);
  const v = autograd.addBias(autograd.matmul(x, p.wv), p.bv);
  const scores = autograd.scale(autograd.matmul(q, autograd.transpose(k)), 1 / Math.sqrt(model.dim));
  const attention = autograd.rowSoftmax(scores);
  const context = autograd.matmul(attention, v);
  const projected = autograd.addBias(autograd.matmul(context, p.wo), p.bo);
  x = autograd.add(x, projected);
  x = autograd.layerNorm(x, p.norm2Gamma, p.norm2Beta);
  const hidden = autograd.relu(autograd.addBias(autograd.matmul(x, p.w1), p.b1));
  const ff = autograd.addBias(autograd.matmul(hidden, p.w2), p.b2);
  x = autograd.add(x, ff);
  const pooled = autograd.meanRows(x);
  const logits = autograd.addBias(autograd.matmul(pooled, p.classifier), p.classifierBias);
  return { logits, attention: { rows: attention.rows, cols: attention.cols, data: attention.data } };
}

function lossFor(model, encoded, label) {
  const { logits } = forward(model, encoded);
  const { loss, probabilities } = autograd.softmaxCrossEntropy(logits, [label]);
  return { loss, probabilities, logits };
}

function predict(model, encoded) {
  const { logits } = forward(model, encoded);
  let best = 0;
  for (let index = 1; index < logits.data.length; index += 1) if (logits.data[index] > logits.data[best]) best = index;
  let max = -Infinity;
  for (const value of logits.data) max = Math.max(max, value);
  let sum = 0;
  const probabilities = Array.from(logits.data, (value) => {
    const exp = Math.exp(value - max);
    sum += exp;
    return exp;
  }).map((value) => value / (sum || 1));
  return { label: best, probabilities };
}

function split(items, { train = 0.7, validation = 0.15, seed = 7 } = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = item.group || item.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const keys = [...groups.keys()].sort();
  const rng = mulberry32(seed);
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [keys[index], keys[swap]] = [keys[swap], keys[index]];
  }
  const trainEnd = Math.floor(keys.length * train);
  const validationEnd = trainEnd + Math.floor(keys.length * validation);
  const collect = (subset) => subset.flatMap((key) => groups.get(key));
  return {
    train: collect(keys.slice(0, trainEnd)),
    validation: collect(keys.slice(trainEnd, validationEnd)),
    test: collect(keys.slice(validationEnd)),
    groups: { train: keys.slice(0, trainEnd).length, validation: keys.slice(trainEnd, validationEnd).length, test: keys.slice(validationEnd).length },
  };
}

function metrics(truth, predicted, classes) {
  let correct = 0;
  for (let index = 0; index < truth.length; index += 1) if (truth[index] === predicted[index]) correct += 1;
  const perClass = {};
  let f1Sum = 0;
  for (let label = 0; label < classes; label += 1) {
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
    f1Sum += precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[label] = { support: tp + fn, precision: Number(precision.toFixed(3)), recall: Number(recall.toFixed(3)) };
  }
  return { cases: truth.length, correct, accuracy: truth.length ? Number((correct / truth.length).toFixed(3)) : 0, macroF1: Number((f1Sum / Math.max(1, classes)).toFixed(3)), perClass };
}

/**
 * Trains with mini-batches, Adam and early stopping on validation loss.
 * `onEpoch` receives real per-epoch numbers and is used for cancellation.
 */
function train({
  items, labels, epochs = 12, batchSize = 8, learningRate = 0.01, dim = 24, hidden = 48, maxLen = 16,
  seed = 42, patience = 4, weightDecay = 0.0001, onEpoch = null, validationFraction = 0.15,
} = {}) {
  const labelIndex = new Map(labels.map((label, index) => [label, index]));
  const prepared = items.map((item) => {
    if (!labelIndex.has(item.label)) throw Object.assign(new Error(`unknown label ${item.label}`), { code: 'BAD_DATASET' });
    return { ...item, y: labelIndex.get(item.label) };
  });
  const parts = split(prepared, { train: 0.7, validation: validationFraction, test: 0.15, seed: seed + 1 });
  const vocab = buildVocab(parts.train.map((item) => item.text));
  const model = createModel({ vocabSize: vocab.words.length + 2, classes: labels.length, dim, hidden, maxLen, seed });
  const trainData = parts.train.map((item) => ({ y: item.y, x: encode(item.text, vocab, maxLen) }));
  const validationData = parts.validation.map((item) => ({ y: item.y, x: encode(item.text, vocab, maxLen) }));
  const testData = parts.test.map((item) => ({ y: item.y, x: encode(item.text, vocab, maxLen) }));
  if (!trainData.length || !testData.length) throw Object.assign(new Error('split produced an empty train or test set'), { code: 'BAD_DATASET' });
  const parameters = model.order.map((name) => model.parameters[name]);
  const optimizer = autograd.createAdam(parameters, { learningRate, weightDecay });
  const rng = mulberry32(seed);
  const order = trainData.map((_, index) => index);
  const history = [];
  let best = { loss: Infinity, epoch: -1, params: autograd.snapshot(parameters) };
  let stalled = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const started = Date.now();
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    let total = 0;
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      autograd.zeroGrad(parameters);
      let batchLoss = 0;
      for (const index of batch) {
        const { loss } = lossFor(model, trainData[index].x, trainData[index].y);
        autograd.backward(loss);
        batchLoss += loss.data[0];
      }
      autograd.applyAdam(parameters, optimizer, batch.length);
      total += batchLoss;
    }
    const trainLoss = total / Math.max(1, trainData.length);
    let validationLoss = 0;
    let validationCorrect = 0;
    for (const item of validationData) {
      const { loss } = lossFor(model, item.x, item.y);
      validationLoss += loss.data[0];
      if (predict(model, item.x).label === item.y) validationCorrect += 1;
    }
    validationLoss /= Math.max(1, validationData.length);
    const record = {
      epoch,
      trainLoss: Number(trainLoss.toFixed(5)),
      validationLoss: Number(validationLoss.toFixed(5)),
      validationAccuracy: validationData.length ? Number((validationCorrect / validationData.length).toFixed(3)) : null,
      ms: Date.now() - started,
    };
    history.push(record);
    if (onEpoch) onEpoch(record);
    if (validationData.length && validationLoss < best.loss - 1e-5) {
      best = { loss: validationLoss, epoch, params: autograd.snapshot(parameters) };
      stalled = 0;
    } else if (validationData.length) {
      stalled += 1;
      if (patience && stalled >= patience) break;
    }
  }
  if (validationData.length) autograd.restore(parameters, best.params);
  const predictData = (data) => data.map((item) => predict(model, item.x).label);
  const testTruth = testData.map((item) => item.y);
  const testPredicted = predictData(testData);
  const trainPredicted = predictData(trainData);
  return {
    model,
    vocab,
    labels,
    parts: { train: trainData.length, validation: validationData.length, test: testData.length, groups: parts.groups },
    history,
    bestEpoch: best.epoch,
    bestValidationLoss: Number(best.loss.toFixed(5)),
    metrics: metrics(testTruth, testPredicted, labels.length),
    trainMetrics: metrics(trainData.map((item) => item.y), trainPredicted, labels.length),
    predictions: testData.map((item, index) => ({ truth: labels[item.y], predicted: labels[testPredicted[index]] })),
    testExamples: parts.test.map((item) => ({ text: item.text, label: item.label })),
  };
}

function checksum(model, vocab, labels) {
  return crypto.createHash('sha256').update(JSON.stringify({ format: FORMAT, dim: model.dim, hidden: model.hidden, maxLen: model.maxLen, labels, vocab: vocab.words, parameters: autograd.snapshot(model.order.map((name) => model.parameters[name])) })).digest('hex');
}

function toCheckpoint(model, { vocab, labels, metrics = null, trainedAt = null, dataset = null }) {
  const values = autograd.snapshot(model.order.map((name) => model.parameters[name]));
  return {
    format: FORMAT,
    dim: model.dim, hidden: model.hidden, maxLen: model.maxLen, classes: model.classes, seed: model.seed,
    vocab: vocab.words, labels, metrics, trainedAt, dataset,
    order: model.order,
    parameters: values,
    checksum: crypto.createHash('sha256').update(JSON.stringify({ format: FORMAT, dim: model.dim, hidden: model.hidden, maxLen: model.maxLen, labels, vocab: vocab.words, parameters: values })).digest('hex'),
  };
}

function fromCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.format !== FORMAT) throw Object.assign(new Error('not a sentinel-transformer-v1 checkpoint'), { code: 'BAD_CHECKPOINT' });
  const vocab = { words: checkpoint.vocab, index: new Map([['<pad>', 0], ['<unk>', 1], ...checkpoint.vocab.map((word, index) => [word, index + 2])]) };
  const model = createModel({ vocabSize: checkpoint.vocab.length + 2, classes: checkpoint.classes, dim: checkpoint.dim, hidden: checkpoint.hidden, maxLen: checkpoint.maxLen, seed: 1 });
  const parameters = model.order.map((name) => model.parameters[name]);
  autograd.restore(parameters, checkpoint.parameters);
  const expected = crypto.createHash('sha256').update(JSON.stringify({ format: FORMAT, dim: model.dim, hidden: model.hidden, maxLen: model.maxLen, labels: checkpoint.labels, vocab: checkpoint.vocab, parameters: checkpoint.parameters })).digest('hex');
  if (expected !== checkpoint.checksum) throw Object.assign(new Error('checkpoint checksum mismatch'), { code: 'CHECKSUM_MISMATCH' });
  return { model, vocab, labels: checkpoint.labels };
}

function gradientCheck({ dim = 6, hidden = 8, maxLen = 4, vocabSize = 12, classes = 3, seed = 3 } = {}) {
  const model = createModel({ vocabSize, classes, dim, hidden, maxLen, seed });
  const parameters = model.order.map((name) => model.parameters[name]);
  const sample = { ids: [2, 3, 4, 5], positions: [0, 1, 2, 3] };
  const build = () => lossFor(model, sample, 1).loss;
  return { ...autograd.checkGradient(build, parameters, { checks: 8 }), model, parameters };
}

module.exports = {
  FORMAT, tokenize, buildVocab, encode, createModel, forward, predict, train, split, metrics,
  toCheckpoint, fromCheckpoint, checksum, gradientCheck, mulberry32,
};
