'use strict';

/**
 * Real LoRA and QLoRA on small CPU networks.
 *
 * The base network is genuinely frozen: its weights take part in the forward
 * pass and receive gradients, but only the low-rank adapters are handed to the
 * optimiser. QLoRA additionally stores the frozen base in 4-bit per-column
 * affine quantisation and dequantises it for every forward pass, so the memory
 * saving is real rather than described. This is not a 9B-parameter trainer; it
 * is the same mathematics at a size that trains and evaluates in seconds.
 */

const crypto = require('node:crypto');
const autograd = require('../ml/autograd');

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

function abortIf(signal) {
  if (signal && signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : Object.assign(new Error('training cancelled'), { code: 'CANCELLED' });
    throw reason;
  }
}

function fnv1a(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Deterministic hashed bag of words and character trigrams. */
function hashVector(text, dim = 24) {
  const vector = new Float64Array(dim);
  const value = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = value.split(/[^a-z0-9ąćęłńóśźż]+/u).filter(Boolean);
  for (const word of words) {
    const bucket = fnv1a(`w:${word}`) % dim;
    vector[bucket] += 1;
    const stem = word.length > 4 ? word.slice(0, word.length - 1) : word;
    vector[fnv1a(`s:${stem}`) % dim] += 0.5;
  }
  const padded = ` ${value} `;
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    vector[fnv1a(`g:${padded.slice(index, index + 3)}`) % dim] += 0.15;
  }
  let norm = 0;
  for (const entry of vector) norm += entry * entry;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dim; index += 1) vector[index] /= norm;
  return Array.from(vector);
}

function createBase({ dim, hidden, classes, seed = 42 }) {
  const rng = mulberry32(seed);
  const scale = (fanIn) => Math.sqrt(2 / fanIn);
  const w1 = autograd.leaf(dim, hidden, () => normal(rng) * scale(dim));
  const b1 = autograd.leaf(1, hidden, 0);
  const w2 = autograd.leaf(hidden, classes, () => normal(rng) * scale(hidden));
  const b2 = autograd.leaf(1, classes, 0);
  return { format: 'sentinel-base-mlp-v1', config: { dim, hidden, classes, seed }, parameters: { w1, b1, w2, b2 }, order: ['w1', 'b1', 'w2', 'b2'] };
}

function forwardBase(base, vector) {
  const x = autograd.fromRows([vector]);
  const hidden = autograd.relu(autograd.addBias(autograd.matmul(x, base.parameters.w1), base.parameters.b1));
  return autograd.addBias(autograd.matmul(hidden, base.parameters.w2), base.parameters.b2);
}

function probabilities(logits) {
  const max = Math.max(...logits.data);
  let sum = 0;
  const out = Array.from(logits.data, (value) => {
    const exp = Math.exp(value - max);
    sum += exp;
    return exp;
  });
  return out.map((value) => value / (sum || 1));
}

function argmax(values) {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[best]) best = index;
  return best;
}

function trainBase(base, examples, { epochs = 120, learningRate = 0.05, signal = null } = {}) {
  const parameters = base.order.map((key) => base.parameters[key]);
  const optimizer = autograd.createAdam(parameters, { learningRate });
  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    abortIf(signal);
    let lossSum = 0;
    let correct = 0;
    for (const example of examples) {
      abortIf(signal);
      autograd.zeroGrad(parameters);
      const logits = forwardBase(base, example.vector);
      const { loss, probabilities: probs } = autograd.softmaxCrossEntropy(logits, [example.label]);
      autograd.backward(loss);
      autograd.applyAdam(parameters, optimizer);
      lossSum += loss.data[0];
      if (argmax(probs) === example.label) correct += 1;
    }
    history.push({ epoch: epoch + 1, loss: Number((lossSum / examples.length).toFixed(4)), accuracy: Number((correct / examples.length).toFixed(4)) });
  }
  return { ok: true, epochs, history, final: history[history.length - 1], base };
}

/** Per-column 4-bit affine quantisation with a dequantised copy for forward. */
function quantize4bit(matrix) {
  const out = new Float64Array(matrix.data.length);
  const scales = new Float64Array(matrix.cols);
  const values = new Int8Array(matrix.data.length);
  for (let column = 0; column < matrix.cols; column += 1) {
    let max = 0;
    for (let row = 0; row < matrix.rows; row += 1) max = Math.max(max, Math.abs(matrix.data[row * matrix.cols + column]));
    const scale = max > 0 ? max / 7 : 1;
    scales[column] = scale;
    for (let row = 0; row < matrix.rows; row += 1) {
      const index = row * matrix.cols + column;
      values[index] = Math.max(-7, Math.min(7, Math.round(matrix.data[index] / scale)));
      out[index] = values[index] * scale;
    }
  }
  let error = 0;
  let total = 0;
  for (let index = 0; index < out.length; index += 1) {
    error += Math.abs(out[index] - matrix.data[index]);
    total += Math.abs(matrix.data[index]);
  }
  return { node: autograd.fromRows(Array.from({ length: matrix.rows }, (_, row) => Array.from(out.slice(row * matrix.cols, (row + 1) * matrix.cols)))), values, scales, relativeError: total ? Number((error / total).toFixed(4)) : 0, bits: 4 };
}

function createAdapter({ dim, hidden, classes, rank = 2, seed = 7, target = 'w2' }) {
  const rng = mulberry32(seed);
  if (target === 'w1') {
    const a = autograd.leaf(dim, rank, () => normal(rng) * 0.05);
    const b = autograd.leaf(rank, hidden, 0);
    return { format: 'sentinel-lora-v1', config: { dim, hidden, classes, rank, target }, parameters: { a, b }, order: ['a', 'b'] };
  }
  const a = autograd.leaf(hidden, rank, () => normal(rng) * 0.05);
  const b = autograd.leaf(rank, classes, 0);
  return { format: 'sentinel-lora-v1', config: { dim, hidden, classes, rank, target: 'w2' }, parameters: { a, b }, order: ['a', 'b'] };
}

function forwardLora(base, adapter, vector) {
  const x = autograd.fromRows([vector]);
  const frozen = autograd.addBias(autograd.matmul(x, base.parameters.w1), base.parameters.b1);
  if (adapter.config.target === 'w1') {
    const delta = autograd.matmul(autograd.matmul(x, adapter.parameters.a), adapter.parameters.b);
    const hidden = autograd.relu(autograd.add(frozen, delta));
    return autograd.addBias(autograd.matmul(hidden, base.parameters.w2), base.parameters.b2);
  }
  const hidden = autograd.relu(frozen);
  const baseLogits = autograd.addBias(autograd.matmul(hidden, base.parameters.w2), base.parameters.b2);
  const delta = autograd.matmul(autograd.matmul(hidden, adapter.parameters.a), adapter.parameters.b);
  return autograd.add(baseLogits, delta);
}

function evaluate(predict, examples) {
  if (!examples.length) return { cases: 0, correct: 0, accuracy: null };
  let correct = 0;
  for (const example of examples) if (predict(example.vector) === example.label) correct += 1;
  return { cases: examples.length, correct, accuracy: Number((correct / examples.length).toFixed(4)) };
}

function trainAdapter(binding, base, adapter, examples, { epochs = 120, learningRate = 0.08, validation = [], patience = 25, signal = null } = {}) {
  const parameters = adapter.order.map((key) => adapter.parameters[key]);
  const optimizer = autograd.createAdam(parameters, { learningRate });
  const history = [];
  const basePredict = (vector) => argmax(probabilities(forwardBase(base, vector)).slice());
  const predict = (vector) => argmax(probabilities(forwardLora(binding, adapter, vector)));
  let best = null;
  let bestAccuracy = -1;
  let stale = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    abortIf(signal);
    let lossSum = 0;
    for (const example of examples) {
      abortIf(signal);
      autograd.zeroGrad(parameters);
      const logits = forwardLora(binding, adapter, example.vector);
      const { loss } = autograd.softmaxCrossEntropy(logits, [example.label]);
      autograd.backward(loss);
      autograd.applyAdam(parameters, optimizer);
      lossSum += loss.data[0];
    }
    const record = { epoch: epoch + 1, loss: Number((lossSum / examples.length).toFixed(4)) };
    if (validation.length) {
      const adapted = evaluate(predict, validation);
      const frozen = evaluate(basePredict, validation);
      record.validation = adapted;
      record.frozenBaseline = frozen;
      // Model selection uses validation only. The test fold is never read here.
      if (adapted.accuracy > bestAccuracy) {
        bestAccuracy = adapted.accuracy;
        best = parameters.map((parameter) => Float64Array.from(parameter.data));
        stale = 0;
      } else {
        stale += 1;
      }
    }
    history.push(record);
    if (validation.length && stale >= patience) break;
  }
  if (best) parameters.forEach((parameter, index) => { parameter.data = Float64Array.from(best[index]); });
  return {
    ok: true,
    epochs: history.length,
    history,
    final: history[history.length - 1],
    adapter,
    selectedEpoch: best ? bestAccuracy : null,
    evaluation: {
      validation: { adapted: evaluate(predict, validation), frozen: evaluate(basePredict, validation) },
      adapted: evaluate(predict, validation),
      frozen: evaluate(basePredict, validation),
    },
    predict,
  };
}

/**
 * Cooperative async variant used by the durable queue. It yields to the event
 * loop once per epoch, so an AbortSignal from a timer or another request is
 * actually observed while computation is running; the synchronous variant
 * remains for direct library use.
 */
async function trainBaseAsync(base, examples, { epochs = 120, learningRate = 0.05, signal = null } = {}) {
  const parameters = base.order.map((key) => base.parameters[key]);
  const optimizer = autograd.createAdam(parameters, { learningRate });
  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    abortIf(signal);
    let lossSum = 0;
    let correct = 0;
    for (const example of examples) {
      abortIf(signal);
      autograd.zeroGrad(parameters);
      const logits = forwardBase(base, example.vector);
      const { loss, probabilities: probs } = autograd.softmaxCrossEntropy(logits, [example.label]);
      autograd.backward(loss);
      autograd.applyAdam(parameters, optimizer);
      lossSum += loss.data[0];
      if (argmax(probs) === example.label) correct += 1;
    }
    history.push({ epoch: epoch + 1, loss: Number((lossSum / examples.length).toFixed(4)), accuracy: Number((correct / examples.length).toFixed(4)) });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { ok: true, epochs, history, final: history[history.length - 1], base };
}

async function trainAdapterAsync(binding, base, adapter, examples, { epochs = 120, learningRate = 0.08, validation = [], patience = 25, signal = null } = {}) {
  const parameters = adapter.order.map((key) => adapter.parameters[key]);
  const optimizer = autograd.createAdam(parameters, { learningRate });
  const history = [];
  const basePredict = (vector) => argmax(probabilities(forwardBase(base, vector)).slice());
  const predict = (vector) => argmax(probabilities(forwardLora(binding, adapter, vector)));
  let best = null;
  let bestAccuracy = -1;
  let stale = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    abortIf(signal);
    let lossSum = 0;
    for (const example of examples) {
      abortIf(signal);
      autograd.zeroGrad(parameters);
      const logits = forwardLora(binding, adapter, example.vector);
      const { loss } = autograd.softmaxCrossEntropy(logits, [example.label]);
      autograd.backward(loss);
      autograd.applyAdam(parameters, optimizer);
      lossSum += loss.data[0];
    }
    const record = { epoch: epoch + 1, loss: Number((lossSum / examples.length).toFixed(4)) };
    if (validation.length) {
      const adapted = evaluate(predict, validation);
      record.validation = adapted;
      record.frozenBaseline = evaluate(basePredict, validation);
      if (adapted.accuracy > bestAccuracy) {
        bestAccuracy = adapted.accuracy;
        best = parameters.map((parameter) => Float64Array.from(parameter.data));
        stale = 0;
      } else {
        stale += 1;
      }
    }
    history.push(record);
    await new Promise((resolve) => setImmediate(resolve));
    if (validation.length && stale >= patience) break;
  }
  if (best) parameters.forEach((parameter, index) => { parameter.data = Float64Array.from(best[index]); });
  return {
    ok: true,
    epochs: history.length,
    history,
    final: history[history.length - 1],
    adapter,
    selectedEpoch: best ? bestAccuracy : null,
    evaluation: {
      validation: { adapted: evaluate(predict, validation), frozen: evaluate(basePredict, validation) },
      adapted: evaluate(predict, validation),
      frozen: evaluate(basePredict, validation),
    },
    predict,
  };
}

async function trainLoraAsync({ base, examples, validation = [], test = [], rank = 2, epochs = 120, learningRate = 0.08, seed = 7, target = 'w2', signal = null } = {}) {
  if (!base) throw Object.assign(new Error('trainLora needs a base model'), { code: 'BAD_ARGUMENT' });
  if (!Array.isArray(examples) || !examples.length) throw Object.assign(new Error('trainLora needs examples'), { code: 'BAD_ARGUMENT' });
  const adapter = createAdapter({ dim: base.config.dim, hidden: base.config.hidden, classes: base.config.classes, rank, seed, target });
  const result = await trainAdapterAsync(base, base, adapter, examples, { epochs, learningRate, validation, signal });
  result.evaluation.test = { adapted: evaluate(result.predict, test), frozen: evaluate((vector) => argmax(probabilities(forwardBase(base, vector))), test) };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(adapter.parameters.a.data) + JSON.stringify(adapter.parameters.b.data)).digest('hex');
  return { ...result, kind: 'lora', rank, trainableParameters: adapter.config.target === 'w1' ? base.config.dim * rank + rank * base.config.hidden : base.config.hidden * rank + rank * base.config.classes, frozenParameters: base.order.reduce((sum, key) => sum + base.parameters[key].data.length, 0), checksum, payload: toPayload(adapter, { kind: 'lora', baseChecksum: checksumOfBase(base) }) };
}

function trainLora({ base, examples, validation = [], test = [], rank = 2, epochs = 120, learningRate = 0.08, seed = 7, target = 'w2', signal = null } = {}) {
  if (!base) throw Object.assign(new Error('trainLora needs a base model'), { code: 'BAD_ARGUMENT' });
  if (!Array.isArray(examples) || !examples.length) throw Object.assign(new Error('trainLora needs examples'), { code: 'BAD_ARGUMENT' });
  const adapter = createAdapter({ dim: base.config.dim, hidden: base.config.hidden, classes: base.config.classes, rank, seed, target });
  const result = trainAdapter(base, base, adapter, examples, { epochs, learningRate, validation, signal });
  const testPredict = result.predict;
  const testFrozen = evaluate((vector) => argmax(probabilities(forwardBase(base, vector))), test);
  result.evaluation.test = { adapted: evaluate(testPredict, test), frozen: testFrozen };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(adapter.parameters.a.data) + JSON.stringify(adapter.parameters.b.data)).digest('hex');
  return { ...result, kind: 'lora', rank, trainableParameters: adapter.config.target === 'w1' ? base.config.dim * rank + rank * base.config.hidden : base.config.hidden * rank + rank * base.config.classes, frozenParameters: base.order.reduce((sum, key) => sum + base.parameters[key].data.length, 0), checksum, payload: toPayload(adapter, { kind: 'lora', baseChecksum: checksumOfBase(base) }) };
}

function toPayload(adapter, extra = {}) {
  return {
    format: 'sentinel-lora-v1',
    ...extra,
    config: adapter.config,
    weights: { a: Array.from(adapter.parameters.a.data), b: Array.from(adapter.parameters.b.data) },
  };
}

function checksumOfBase(base) {
  const parts = base.order.map((key) => Array.from(base.parameters[key].data));
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function fromPayload(payload) {
  const adapter = createAdapter({ ...payload.config, seed: 1 });
  if (!Array.isArray(payload.weights.a) || !Array.isArray(payload.weights.b)) throw Object.assign(new Error('adapter payload has no weights'), { code: 'BAD_ADAPTER' });
  adapter.parameters.a.data = Float64Array.from(payload.weights.a);
  adapter.parameters.b.data = Float64Array.from(payload.weights.b);
  return adapter;
}

function trainQlora({ base, examples, validation = [], test = [], rank = 2, epochs = 120, learningRate = 0.08, seed = 7, target = 'w2', signal = null } = {}) {
  if (!base) throw Object.assign(new Error('trainQlora needs a base model'), { code: 'BAD_ARGUMENT' });
  const quantizedW1 = quantize4bit(base.parameters.w1);
  const quantizedW2 = quantize4bit(base.parameters.w2);
  const quantized = { format: 'sentinel-qlora-base-v1', config: base.config, parameters: { w1: quantizedW1.node, b1: base.parameters.b1, w2: quantizedW2.node, b2: base.parameters.b2 } };
  const adapter = createAdapter({ dim: base.config.dim, hidden: base.config.hidden, classes: base.config.classes, rank, seed, target });
  const result = trainAdapter(quantized, quantized, adapter, examples, { epochs, learningRate, validation, signal });
  result.evaluation.test = { adapted: evaluate(result.predict, test), frozen: evaluate((vector) => argmax(probabilities(forwardBase(quantized, vector))), test) };
  const payload = toPayload(adapter, { kind: 'qlora', baseChecksum: checksumOfBase(base), quantization: { bits: 4, w1RelativeError: quantizedW1.relativeError, w2RelativeError: quantizedW2.relativeError } });
  return {
    ...result,
    kind: 'qlora',
    rank,
    quantization: { bits: 4, w1RelativeError: quantizedW1.relativeError, w2RelativeError: quantizedW2.relativeError, frozenBytes: Math.ceil((quantizedW1.values.length + quantizedW2.values.length) * 4 / 8) },
    trainableParameters: adapter.config.target === 'w1' ? base.config.dim * rank + rank * base.config.hidden : base.config.hidden * rank + rank * base.config.classes,
    payload,
  };
}

function applyAdapter(base, adapter, vector, { quantized = false } = {}) {
  const binding = base;
  return argmax(probabilities(forwardLora(binding, adapter, vector)));
}

/** Builds deterministic synthetic examples for tests and demos. */
function synthetic({ dim = 12, classes = 4, perClass = 12, seed = 11, shift = 0 } = {}) {
  const rng = mulberry32(seed);
  const examples = [];
  for (let label = 0; label < classes; label += 1) {
    for (let index = 0; index < perClass; index += 1) {
      const vector = new Array(dim).fill(0).map(() => (rng() - 0.5) * 0.2);
      for (let offset = 0; offset < 3; offset += 1) vector[(label * 3 + offset) % dim] += 1;
      examples.push({ vector, label: (label + shift) % classes, trueLabel: label });
    }
  }
  return examples;
}

module.exports = {
  hashVector,
  createBase,
  forwardBase,
  forwardLora,
  trainBase,
  trainBaseAsync,
  trainLora,
  trainLoraAsync,
  trainQlora,
  abortIf,
  quantize4bit,
  createAdapter,
  fromPayload,
  toPayload,
  checksumOfBase,
  applyAdapter,
  evaluate,
  probabilities,
  argmax,
  synthetic,
};
