'use strict';

/**
 * Pairwise preference training (Bradley–Terry) on small feature vectors.
 *
 * Given (chosen, rejected) pairs, a linear scorer learns to rank the chosen
 * response above the rejected one. The loss is the real pairwise logistic loss
 * with an L2 term, optimised by Adam, and held-out pairwise accuracy is
 * measured against a zero-weight baseline. This is a preference model, not a
 * DPO fine-tune of a language model, and is labelled as such wherever it is
 * reported.
 */

const lora = require('./lora');

function zeros(length) {
  return new Float64Array(length);
}

function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

class PreferenceModel {
  constructor({ dim, weights = null, l2 = 0.0005 } = {}) {
    this.dim = dim;
    this.weights = weights ? Float64Array.from(weights) : zeros(dim);
    this.l2 = l2;
    this.adam = { m: zeros(dim), v: zeros(dim), step: 0 };
  }

  score(vector) {
    return dot(this.weights, vector);
  }

  probability(chosen, rejected) {
    return sigmoid(this.score(chosen) - this.score(rejected));
  }

  update(chosen, rejected, { learningRate = 0.05, beta1 = 0.9, beta2 = 0.999, epsilon = 1e-8 } = {}) {
    const margin = this.score(chosen) - this.score(rejected);
    const p = sigmoid(margin);
    const gradientScale = -(1 - p);
    const gradient = zeros(this.dim);
    for (let index = 0; index < this.dim; index += 1) gradient[index] = gradientScale * (chosen[index] - rejected[index]) + this.l2 * this.weights[index];
    this.adam.step += 1;
    const correction1 = 1 - Math.pow(beta1, this.adam.step);
    const correction2 = 1 - Math.pow(beta2, this.adam.step);
    for (let index = 0; index < this.dim; index += 1) {
      this.adam.m[index] = beta1 * this.adam.m[index] + (1 - beta1) * gradient[index];
      this.adam.v[index] = beta2 * this.adam.v[index] + (1 - beta2) * gradient[index] * gradient[index];
      this.weights[index] -= learningRate * (this.adam.m[index] / correction1) / (Math.sqrt(this.adam.v[index] / correction2) + epsilon);
    }
    return -Math.log(Math.max(1e-12, p));
  }

  train(pairs, { epochs = 60, learningRate = 0.05 } = {}) {
    const history = [];
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      let loss = 0;
      for (const pair of pairs) loss += this.update(pair.chosen, pair.rejected, { learningRate });
      history.push({ epoch: epoch + 1, loss: Number((loss / pairs.length).toFixed(4)) });
    }
    return history;
  }

  evaluate(pairs) {
    if (!pairs.length) return { cases: 0, correct: 0, accuracy: null, meanMargin: null };
    let correct = 0;
    let margin = 0;
    for (const pair of pairs) {
      const difference = this.score(pair.chosen) - this.score(pair.rejected);
      if (difference > 0) correct += 1;
      margin += difference;
    }
    return { cases: pairs.length, correct, accuracy: Number((correct / pairs.length).toFixed(4)), meanMargin: Number((margin / pairs.length).toFixed(4)) };
  }

  payload() {
    return { format: 'sentinel-preference-v1', dim: this.dim, weights: Array.from(this.weights), l2: this.l2 };
  }

  static fromPayload(payload) {
    if (!payload || payload.format !== 'sentinel-preference-v1' || !Array.isArray(payload.weights)) throw Object.assign(new Error('not a preference adapter'), { code: 'BAD_ADAPTER' });
    return new PreferenceModel({ dim: payload.dim, weights: payload.weights, l2: payload.l2 });
  }
}

function syntheticPairs({ dim = 8, count = 60, seed = 13, noise = 0.15, informative = 3 } = {}) {
  const rng = lora.synthetic({ dim: 1, classes: 2, perClass: 1, seed });
  const random = (() => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const pairs = [];
  for (let index = 0; index < count; index += 1) {
    const base = Array.from({ length: dim }, () => (random() - 0.5) * 0.2);
    const chosen = base.slice();
    const rejected = base.slice();
    for (let offset = 0; offset < informative; offset += 1) {
      chosen[offset] += 0.5 + (random() - 0.5) * noise;
      rejected[offset] -= 0.5 + (random() - 0.5) * noise;
    }
    pairs.push({ chosen, rejected });
  }
  return pairs;
}

function trainPreference({ pairs, test = null, dim = null, epochs = 80, learningRate = 0.05, l2 = 0.0005, seed = 31 } = {}) {
  if (!Array.isArray(pairs) || pairs.length < 2) throw Object.assign(new Error('preference training needs at least two pairs'), { code: 'BAD_ARGUMENT' });
  const dimensions = dim || pairs[0].chosen.length;
  const model = new PreferenceModel({ dim: dimensions, l2 });
  const history = model.train(pairs, { epochs, learningRate });
  const baseline = new PreferenceModel({ dim: dimensions });
  const heldOut = test || pairs;
  return {
    ok: true,
    model,
    history,
    final: history[history.length - 1],
    train: model.evaluate(pairs),
    test: model.evaluate(heldOut),
    baseline: baseline.evaluate(heldOut),
    delta: Number((model.evaluate(heldOut).accuracy - baseline.evaluate(heldOut).accuracy).toFixed(4)),
    payload: model.payload(),
  };
}

module.exports = { PreferenceModel, trainPreference, syntheticPairs };
