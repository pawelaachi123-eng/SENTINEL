'use strict';

/**
 * A small multilayer perceptron with a real forward pass, real softmax
 * cross-entropy, real backpropagation and Adam.
 *
 * This is deliberately a small network, not a language model. It exists so the
 * learning lab can train a genuine classifier on CPU, measure held-out accuracy
 * and check gradients numerically. There are no fake neurons, activations or
 * losses here: every number is computed from arrays that are saved to a
 * checkpoint outside the source tree.
 */

const crypto = require('node:crypto');

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

function gaussian(rng) {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function zeros(length) {
  return new Float64Array(length);
}

function initLayer(fanIn, fanOut, rng) {
  const weights = new Float64Array(fanIn * fanOut);
  const scale = Math.sqrt(2 / fanIn);
  for (let index = 0; index < weights.length; index += 1) weights[index] = gaussian(rng) * scale;
  return { weights, bias: zeros(fanOut), fanIn, fanOut };
}

function createNetwork({ dim, hidden = [32, 16], classes, seed = 42 } = {}) {
  if (!(dim > 0) || !(classes > 1)) throw Object.assign(new Error('dim and classes must be positive'), { code: 'BAD_NETWORK' });
  const rng = mulberry32(seed);
  const sizes = [dim, ...hidden, classes];
  const layers = [];
  for (let index = 0; index < sizes.length - 1; index += 1) layers.push(initLayer(sizes[index], sizes[index + 1], rng));
  return { dim, classes, hidden, seed, layers };
}

function forward(network, input) {
  const activations = [input];
  const pre = [];
  let current = input;
  for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
    const layer = network.layers[layerIndex];
    const out = new Float64Array(layer.fanOut);
    for (let row = 0; row < layer.fanOut; row += 1) {
      let sum = layer.bias[row];
      const offset = row * layer.fanIn;
      for (let column = 0; column < layer.fanIn; column += 1) sum += layer.weights[offset + column] * current[column];
      out[row] = sum;
    }
    pre.push(out);
    const last = layerIndex === network.layers.length - 1;
    const activated = new Float64Array(out.length);
    for (let index = 0; index < out.length; index += 1) activated[index] = last ? out[index] : (out[index] > 0 ? out[index] : 0);
    activations.push(activated);
    current = activated;
  }
  return { activations, pre };
}

function softmax(logits) {
  let max = -Infinity;
  for (const value of logits) max = Math.max(max, value);
  const out = new Float64Array(logits.length);
  let sum = 0;
  for (let index = 0; index < logits.length; index += 1) {
    out[index] = Math.exp(logits[index] - max);
    sum += out[index];
  }
  for (let index = 0; index < out.length; index += 1) out[index] /= sum || 1;
  return out;
}

function predict(network, input) {
  const { activations } = forward(network, input);
  const probabilities = softmax(activations[activations.length - 1]);
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) if (probabilities[index] > probabilities[best]) best = index;
  return { label: best, probabilities };
}

function lossOf(network, input, label) {
  const probabilities = predict(network, input).probabilities;
  return -Math.log(Math.max(1e-12, probabilities[label]));
}

function zeroGradients(network) {
  return network.layers.map((layer) => ({ dWeights: zeros(layer.weights.length), dBias: zeros(layer.bias.length) }));
}

function accumulate(network, gradients, input, label) {
  const { activations, pre } = forward(network, input);
  const logits = activations[activations.length - 1];
  const probabilities = softmax(logits);
  let delta = new Float64Array(probabilities.length);
  for (let index = 0; index < probabilities.length; index += 1) delta[index] = probabilities[index];
  delta[label] -= 1;

  for (let layerIndex = network.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = network.layers[layerIndex];
    const inputActivation = activations[layerIndex];
    const grad = gradients[layerIndex];
    for (let row = 0; row < layer.fanOut; row += 1) {
      const d = delta[row];
      if (d === 0) continue;
      const offset = row * layer.fanIn;
      for (let column = 0; column < layer.fanIn; column += 1) grad.dWeights[offset + column] += d * inputActivation[column];
      grad.dBias[row] += d;
    }
    if (layerIndex > 0) {
      const previous = network.layers[layerIndex - 1];
      const nextDelta = new Float64Array(previous.fanOut);
      for (let column = 0; column < layer.fanIn; column += 1) {
        let sum = 0;
        for (let row = 0; row < layer.fanOut; row += 1) sum += layer.weights[row * layer.fanIn + column] * delta[row];
        nextDelta[column] = pre[layerIndex - 1][column] > 0 ? sum : 0;
      }
      delta = nextDelta;
    }
  }
  return probabilities;
}

function createAdam(network, { learningRate = 0.01, beta1 = 0.9, beta2 = 0.999, epsilon = 1e-8 } = {}) {
  const layers = network.layers.map((layer) => ({
    mWeights: zeros(layer.weights.length),
    vWeights: zeros(layer.weights.length),
    mBias: zeros(layer.bias.length),
    vBias: zeros(layer.bias.length),
  }));
  return { learningRate, beta1, beta2, epsilon, step: 0, layers };
}

function applyAdam(network, gradients, optimizer, batchSize, l2 = 0) {
  optimizer.step += 1;
  const biasCorrection1 = 1 - Math.pow(optimizer.beta1, optimizer.step);
  const biasCorrection2 = 1 - Math.pow(optimizer.beta2, optimizer.step);
  for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
    const layer = network.layers[layerIndex];
    const grad = gradients[layerIndex];
    const state = optimizer.layers[layerIndex];
    const update = (weights, dWeights, m, v) => {
      for (let index = 0; index < weights.length; index += 1) {
        const gradient = dWeights[index] / batchSize;
        m[index] = optimizer.beta1 * m[index] + (1 - optimizer.beta1) * gradient;
        v[index] = optimizer.beta2 * v[index] + (1 - optimizer.beta2) * gradient * gradient;
        const mHat = m[index] / biasCorrection1;
        const vHat = v[index] / biasCorrection2;
        const decay = weights === layer.weights ? l2 * weights[index] : 0;
        weights[index] -= (optimizer.learningRate * mHat) / (Math.sqrt(vHat) + optimizer.epsilon) + optimizer.learningRate * decay;
      }
    };
    update(layer.weights, grad.dWeights, state.mWeights, state.vWeights);
    update(layer.bias, grad.dBias, state.mBias, state.vBias);
  }
}

function accuracy(network, samples) {
  if (!samples.length) return 0;
  let correct = 0;
  for (const sample of samples) if (predict(network, sample.x).label === sample.y) correct += 1;
  return correct / samples.length;
}

/**
 * Trains with mini-batches and optional early stopping. Returns the best
 * parameter set by validation loss — not the last epoch — so a noisy final
 * epoch cannot be reported as progress.
 */
function train({ network, samples, epochs = 40, batchSize = 16, learningRate = 0.01, validation = [], seed = 1, patience = 8, l2 = 0.001 } = {}) {
  const rng = mulberry32(seed);
  const optimizer = createAdam(network, { learningRate });
  const order = samples.map((_, index) => index);
  const history = [];
  let best = { loss: Infinity, epoch: -1, params: snapshot(network) };
  let sinceImprovement = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    let total = 0;
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      const gradients = zeroGradients(network);
      let batchLoss = 0;
      for (const sampleIndex of batch) {
        const sample = samples[sampleIndex];
        batchLoss += -Math.log(Math.max(1e-12, accumulate(network, gradients, sample.x, sample.y)[sample.y]));
      }
      applyAdam(network, gradients, optimizer, batch.length, l2);
      total += batchLoss;
    }
    const trainLoss = total / Math.max(1, samples.length);
    const validationLoss = validation.length ? validation.reduce((sum, sample) => sum + lossOf(network, sample.x, sample.y), 0) / validation.length : trainLoss;
    const validationAccuracy = validation.length ? accuracy(network, validation) : null;
    history.push({ epoch, trainLoss: Number(trainLoss.toFixed(5)), validationLoss: Number(validationLoss.toFixed(5)), validationAccuracy });
    if (validationLoss < best.loss - 1e-6) {
      best = { loss: validationLoss, epoch, params: snapshot(network) };
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
      if (patience && sinceImprovement >= patience) break;
    }
  }
  restore(network, best.params);
  return { history, bestEpoch: best.epoch, bestValidationLoss: best.loss, epochsRun: history.length };
}

function snapshot(network) {
  return network.layers.map((layer) => ({ weights: Array.from(layer.weights), bias: Array.from(layer.bias) }));
}

function restore(network, params) {
  if (!Array.isArray(params) || params.length !== network.layers.length) throw Object.assign(new Error('checkpoint shape does not match the network'), { code: 'BAD_CHECKPOINT' });
  network.layers.forEach((layer, index) => {
    layer.weights = Float64Array.from(params[index].weights);
    layer.bias = Float64Array.from(params[index].bias);
  });
}

/** Numeric gradient check on a handful of parameters. */
function gradientCheck(network, sample, { epsilon = 1e-4, checks = 6 } = {}) {
  const gradients = zeroGradients(network);
  accumulate(network, gradients, sample.x, sample.y);
  const targets = [];
  for (let layerIndex = 0; layerIndex < network.layers.length && targets.length < checks; layerIndex += 1) {
    const layer = network.layers[layerIndex];
    for (let index = 0; index < Math.min(layer.weights.length, 3); index += 1) {
      if (targets.length < checks) targets.push({ layer: layerIndex, index, bias: false });
    }
    for (let index = 0; index < Math.min(layer.bias.length, 2); index += 1) {
      if (targets.length < checks) targets.push({ layer: layerIndex, index, bias: true });
    }
  }
  const results = [];
  for (const target of targets) {
    const layer = network.layers[target.layer];
    const parameters = target.bias ? layer.bias : layer.weights;
    const original = parameters[target.index];
    parameters[target.index] = original + epsilon;
    const plus = lossOf(network, sample.x, sample.y);
    parameters[target.index] = original - epsilon;
    const minus = lossOf(network, sample.x, sample.y);
    parameters[target.index] = original;
    const numeric = (plus - minus) / (2 * epsilon);
    const analytic = target.bias ? gradients[target.layer].dBias[target.index] : gradients[target.layer].dWeights[target.index];
    results.push({ layer: target.layer, index: target.index, bias: target.bias, numeric, analytic, difference: Math.abs(numeric - analytic) });
  }
  const worst = results.reduce((max, entry) => Math.max(max, entry.difference), 0);
  return { ok: worst < 1e-3, worst, checked: results.length, results };
}

function checksum(network, labels) {
  return crypto.createHash('sha256').update(JSON.stringify({ dim: network.dim, hidden: network.hidden, classes: network.classes, labels, parameters: snapshot(network) })).digest('hex');
}

function toCheckpoint(network, { labels, featureVersion, metrics = null, trainedAt = null, datasetHash = null }) {
  return {
    format: 'sentinel-mlp-v1',
    dim: network.dim,
    hidden: network.hidden,
    classes: network.classes,
    labels,
    featureVersion,
    metrics,
    trainedAt,
    datasetHash,
    parameters: snapshot(network),
    checksum: checksum(network, labels),
  };
}

function fromCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.format !== 'sentinel-mlp-v1') throw Object.assign(new Error('not a sentinel-mlp-v1 checkpoint'), { code: 'BAD_CHECKPOINT' });
  const network = createNetwork({ dim: checkpoint.dim, hidden: checkpoint.hidden, classes: checkpoint.classes, seed: 1 });
  restore(network, checkpoint.parameters);
  const expected = checksum(network, checkpoint.labels);
  if (expected !== checkpoint.checksum) throw Object.assign(new Error('checkpoint checksum mismatch'), { code: 'CHECKSUM_MISMATCH' });
  return network;
}

module.exports = {
  createNetwork,
  forward,
  predict,
  softmax,
  lossOf,
  train,
  accuracy,
  gradientCheck,
  snapshot,
  restore,
  toCheckpoint,
  fromCheckpoint,
  checksum,
  mulberry32,
};
