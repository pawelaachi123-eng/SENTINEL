'use strict';

/**
 * A compact character-level autoregressive transformer (decoder-only).
 *
 * This is a genuine language model in the architectural sense: token and
 * position embeddings, stacked causal self-attention blocks, layer norm,
 * feed-forward layers, a vocabulary head, next-token cross-entropy, Adam,
 * checkpointing and sampling. It is deliberately tiny (a few tens of
 * thousands of parameters, one to three blocks) and trained on whatever text
 * the caller supplies. It is not a frontier model, has no external knowledge,
 * and is never presented as one. Its purpose is to make neural language
 * modelling real, inspectable and testable on a CPU.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const autograd = require('./autograd');

const FORMAT = 'sentinel-gpt-v1';

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

function buildVocab(texts, { minCount = 1, maxVocab = 128 } = {}) {
  const counts = new Map();
  for (const text of texts) for (const char of String(text)) counts.set(char, (counts.get(char) || 0) + 1);
  const chars = [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, maxVocab - 1))
    .map(([char]) => char);
  // Index 0 is always the unknown token, so unseen characters are legal input.
  return { chars, index: new Map(chars.map((char, position) => [char, position + 1])) };
}

function encode(text, vocab) {
  return Array.from(String(text), (char) => vocab.index.get(char) || 0);
}

function decode(ids, vocab) {
  return ids.map((id) => (id > 0 && id <= vocab.chars.length ? vocab.chars[id - 1] : '')).join('');
}

function abortIf(signal) {
  if (signal && signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('training cancelled'), { code: 'CANCELLED' });
  }
}

function parameter(rows, cols, rng, scale) {
  return autograd.leaf(rows, cols, () => normal(rng) * scale);
}

function createModel({ vocabSize, dim = 24, hidden = 48, maxLen = 32, blocks = 2, seed = 42 } = {}) {
  if (!(vocabSize >= 2)) throw Object.assign(new Error('vocabulary must have at least two entries'), { code: 'BAD_GPT' });
  if (!(dim > 0) || !(hidden > 0) || !(maxLen > 0) || !(blocks >= 1)) throw Object.assign(new Error('invalid gpt configuration'), { code: 'BAD_GPT' });
  const rng = mulberry32(seed);
  const xavier = (fanIn, fanOut) => Math.sqrt(2 / (fanIn + fanOut));
  const parameters = {
    embedding: parameter(vocabSize, dim, rng, 0.08),
    position: parameter(maxLen, dim, rng, 0.02),
    head: parameter(dim, vocabSize, rng, xavier(dim, vocabSize)),
    normFinalGamma: autograd.leaf(1, dim, 1),
    normFinalBeta: autograd.leaf(1, dim, 0),
  };
  for (let block = 0; block < blocks; block += 1) {
    parameters[`b${block}Norm1Gamma`] = autograd.leaf(1, dim, 1);
    parameters[`b${block}Norm1Beta`] = autograd.leaf(1, dim, 0);
    parameters[`b${block}Wq`] = parameter(dim, dim, rng, xavier(dim, dim));
    parameters[`b${block}Wk`] = parameter(dim, dim, rng, xavier(dim, dim));
    parameters[`b${block}Wv`] = parameter(dim, dim, rng, xavier(dim, dim));
    parameters[`b${block}Wo`] = parameter(dim, dim, rng, xavier(dim, dim));
    parameters[`b${block}Norm2Gamma`] = autograd.leaf(1, dim, 1);
    parameters[`b${block}Norm2Beta`] = autograd.leaf(1, dim, 0);
    parameters[`b${block}W1`] = parameter(dim, hidden, rng, xavier(dim, hidden));
    parameters[`b${block}B1`] = autograd.leaf(1, hidden, 0);
    parameters[`b${block}W2`] = parameter(hidden, dim, rng, xavier(hidden, dim));
    parameters[`b${block}B2`] = autograd.leaf(1, dim, 0);
  }
  return {
    format: FORMAT,
    config: { vocabSize, dim, hidden, maxLen, blocks, seed },
    parameters,
    order: Object.keys(parameters),
  };
}

function forward(model, ids, { keepAttention = false } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('forward needs at least one token'), { code: 'BAD_GPT' });
  if (ids.length > model.config.maxLen) throw Object.assign(new Error(`sequence of ${ids.length} exceeds maxLen ${model.config.maxLen}`), { code: 'BAD_GPT' });
  const p = model.parameters;
  const positions = ids.map((_, index) => index);
  let x = autograd.add(autograd.gather(p.embedding, ids), autograd.gather(p.position, positions));
  const attentions = [];
  for (let block = 0; block < model.config.blocks; block += 1) {
    const prefix = `b${block}`;
    const normed = autograd.layerNorm(x, p[`${prefix}Norm1Gamma`], p[`${prefix}Norm1Beta`]);
    const q = autograd.matmul(normed, p[`${prefix}Wq`]);
    const k = autograd.matmul(normed, p[`${prefix}Wk`]);
    const v = autograd.matmul(normed, p[`${prefix}Wv`]);
    const scores = autograd.scale(autograd.matmul(q, autograd.transpose(k)), 1 / Math.sqrt(model.config.dim));
    const attention = autograd.causalRowSoftmax(scores);
    const context = autograd.matmul(attention, v);
    x = autograd.add(x, autograd.matmul(context, p[`${prefix}Wo`]));
    const normed2 = autograd.layerNorm(x, p[`${prefix}Norm2Gamma`], p[`${prefix}Norm2Beta`]);
    const wide = autograd.relu(autograd.addBias(autograd.matmul(normed2, p[`${prefix}W1`]), p[`${prefix}B1`]));
    x = autograd.add(x, autograd.addBias(autograd.matmul(wide, p[`${prefix}W2`]), p[`${prefix}B2`]));
    if (keepAttention) {
      attentions.push({ rows: attention.rows, cols: attention.cols, data: attention.data, causal: true });
    }
  }
  const logits = autograd.matmul(autograd.layerNorm(x, p.normFinalGamma, p.normFinalBeta), p.head);
  return { logits, attentions };
}

function nextTokenLoss(model, ids, target) {
  const { logits } = forward(model, ids);
  const { loss, probabilities } = autograd.softmaxCrossEntropy(autograd.lastRow(logits), [target]);
  return { loss, probabilities };
}

function perplexityOf(model, samples) {
  if (!samples.length) return { perplexity: null, loss: null, tokens: 0 };
  let sum = 0;
  for (const sample of samples) {
    const { loss } = nextTokenLoss(model, sample.ids, sample.target);
    sum += loss.data[0];
  }
  const loss = sum / samples.length;
  return { perplexity: Math.exp(loss), loss, tokens: samples.length };
}

function prefixes(ids, { stride = 1 } = {}) {
  const samples = [];
  for (let index = 1; index < ids.length; index += stride) samples.push({ ids: ids.slice(0, index), target: ids[index] });
  return samples;
}

function train(model, text, { epochs = 20, learningRate = 0.01, stride = 1, validation = null, seed = 42, onEpoch = null, maxSamples = 1200, optimizer = null, signal = null } = {}) {
  const vocab = model.vocab;
  if (!vocab) throw Object.assign(new Error('model has no vocabulary; call trainText instead'), { code: 'BAD_GPT' });
  const ids = encode(text, vocab);
  let samples = prefixes(ids, { stride }).map((sample) => ({ ids: sample.ids.slice(-(model.config.maxLen - 1)), target: sample.target }));
  if (samples.length > maxSamples) {
    const rng = mulberry32(seed + 1);
    samples = Array.from({ length: maxSamples }, () => samples[Math.floor(rng() * samples.length)]);
  }
  const validationSamples = validation == null ? [] : prefixes(encode(validation, vocab), { stride: Math.max(1, stride) }).map((sample) => ({ ids: sample.ids.slice(-(model.config.maxLen - 1)), target: sample.target }));
  const parameters = model.order.map((name) => model.parameters[name]);
  const activeOptimizer = optimizer || (model.training && model.training.optimizer) || autograd.createAdam(parameters, { learningRate });
  if (!Array.isArray(activeOptimizer.states) || activeOptimizer.states.length !== parameters.length) throw Object.assign(new Error('optimizer state does not match the model'), { code: 'BAD_CHECKPOINT' });
  const startEpoch = Number(model.training && model.training.progress && model.training.progress.epochs) || 0;
  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    abortIf(signal);
    let epochLoss = 0;
    for (const sample of samples) {
      abortIf(signal);
      autograd.zeroGrad(parameters);
      const { loss } = nextTokenLoss(model, sample.ids, sample.target);
      autograd.backward(loss);
      autograd.applyAdam(parameters, activeOptimizer);
      epochLoss += loss.data[0];
    }
    const record = {
      epoch: startEpoch + epoch + 1,
      trainLoss: epochLoss / Math.max(1, samples.length),
      trainPerplexity: Math.exp(epochLoss / Math.max(1, samples.length)),
      validated: validationSamples.length > 0,
      validationLoss: null,
      validationPerplexity: null,
    };
    if (validationSamples.length) {
      const measured = perplexityOf(model, validationSamples);
      record.validationLoss = measured.loss;
      record.validationPerplexity = measured.perplexity;
    }
    history.push(record);
    if (onEpoch) onEpoch(record);
  }
  return {
    ok: true,
    epochs: history.length,
    samples: samples.length,
    validationSamples: validationSamples.length,
    history,
    final: history[history.length - 1] || null,
    optimizer: activeOptimizer,
    progress: { epochs: startEpoch + history.length, learningRate },
  };
}

function applySoftmax(values) {
  let max = -Infinity;
  for (const value of values) max = Math.max(max, value);
  let sum = 0;
  const out = values.map((value) => {
    const exp = Math.exp(value - max);
    sum += exp;
    return exp;
  });
  return out.map((value) => value / (sum || 1));
}

function generate(model, prompt, { maxNewTokens = 32, temperature = 0.8, topK = 0, topP = 1, repetitionPenalty = 1, seed = 42 } = {}) {
  const vocab = model.vocab;
  if (!vocab) throw Object.assign(new Error('model has no vocabulary'), { code: 'BAD_GPT' });
  const rng = mulberry32(seed);
  let ids = encode(prompt || ' ', vocab);
  if (!ids.length) ids = [0];
  const generated = [];
  for (let step = 0; step < maxNewTokens; step += 1) {
    const context = ids.slice(-model.config.maxLen);
    const { logits } = forward(model, context);
    const last = Array.from(logits.data.slice((logits.rows - 1) * logits.cols));
    let chosen;
    if (temperature <= 0) {
      chosen = last.indexOf(Math.max(...last));
    } else {
      const recent = new Set(ids.slice(-64));
      const adjusted = last.map((value, index) => (repetitionPenalty > 1 && recent.has(index) ? value / repetitionPenalty : value));
      const scaled = adjusted.map((value) => value / temperature);
      let probabilities = applySoftmax(scaled);
      if (topK > 0 && topK < probabilities.length) {
        const threshold = [...probabilities].sort((a, b) => b - a)[topK - 1];
        probabilities = probabilities.map((value) => (value >= threshold ? value : 0));
      }
      if (topP > 0 && topP < 1) {
        const order = probabilities.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
        let cumulative = 0;
        const keep = new Set();
        for (const entry of order) {
          if (cumulative >= topP) break;
          keep.add(entry.index);
          cumulative += entry.value;
        }
        probabilities = probabilities.map((value, index) => (keep.has(index) ? value : 0));
      }
      const sum = probabilities.reduce((total, value) => total + value, 0) || 1;
      probabilities = probabilities.map((value) => value / sum);
      let draw = rng();
      chosen = probabilities.length - 1;
      for (let index = 0; index < probabilities.length; index += 1) {
        draw -= probabilities[index];
        if (draw <= 0) { chosen = index; break; }
      }
    }
    ids.push(chosen);
    generated.push(chosen);
    if (ids.length > model.config.maxLen * 4) ids = ids.slice(-model.config.maxLen);
  }
  return { text: decode(generated, vocab), ids: generated, prompt, steps: generated.length };
}

function save(model, file, { optimizer = null, progress = null } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const activeOptimizer = optimizer || (model.training && model.training.optimizer) || null;
  const payload = {
    format: FORMAT,
    config: model.config,
    vocab: model.vocab ? { chars: model.vocab.chars } : null,
    values: Object.fromEntries(model.order.map((name) => [name, Array.from(model.parameters[name].data)])),
    training: activeOptimizer ? {
      progress: progress || (model.training && model.training.progress) || null,
      optimizer: {
        learningRate: activeOptimizer.learningRate,
        beta1: activeOptimizer.beta1,
        beta2: activeOptimizer.beta2,
        epsilon: activeOptimizer.epsilon,
        weightDecay: activeOptimizer.weightDecay,
        step: activeOptimizer.step,
        states: activeOptimizer.states.map((state) => ({ m: Array.from(state.m), v: Array.from(state.v) })),
      },
    } : null,
  };
  const text = JSON.stringify(payload);
  fs.writeFileSync(file, text);
  return { ok: true, file, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), parameters: model.order.length };
}

function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  const payload = JSON.parse(text);
  if (payload.format !== FORMAT) throw Object.assign(new Error(`unsupported checkpoint format: ${payload.format}`), { code: 'BAD_CHECKPOINT' });
  const model = createModel({ ...payload.config, seed: payload.config.seed });
  if (!payload.values || typeof payload.values !== 'object') throw Object.assign(new Error('checkpoint has no parameter values'), { code: 'BAD_CHECKPOINT' });
  for (const name of model.order) {
    const values = payload.values[name];
    if (!Array.isArray(values) || values.length !== model.parameters[name].data.length) throw Object.assign(new Error(`checkpoint mismatch for ${name}`), { code: 'BAD_CHECKPOINT' });
    model.parameters[name].data = Float64Array.from(values);
  }
  if (payload.vocab && Array.isArray(payload.vocab.chars)) {
    model.vocab = { chars: payload.vocab.chars, index: new Map(payload.vocab.chars.map((char, position) => [char, position + 1])) };
  }
  if (payload.training && payload.training.optimizer) {
    const saved = payload.training.optimizer;
    const optimizer = autograd.createAdam(model.order.map((name) => model.parameters[name]), {
      learningRate: saved.learningRate,
      beta1: saved.beta1,
      beta2: saved.beta2,
      epsilon: saved.epsilon,
      weightDecay: saved.weightDecay,
    });
    optimizer.step = saved.step || 0;
    if (!Array.isArray(saved.states) || saved.states.length !== optimizer.states.length) throw Object.assign(new Error('checkpoint optimizer state is incomplete'), { code: 'BAD_CHECKPOINT' });
    saved.states.forEach((state, index) => {
      if (!Array.isArray(state.m) || !Array.isArray(state.v) || state.m.length !== optimizer.states[index].m.length) throw Object.assign(new Error('checkpoint optimizer shape mismatch'), { code: 'BAD_CHECKPOINT' });
      optimizer.states[index].m = Float64Array.from(state.m);
      optimizer.states[index].v = Float64Array.from(state.v);
    });
    model.training = { optimizer, progress: payload.training.progress || { epochs: 0 } };
  }
  return model;
}

/** Builds a vocabulary and an untrained model; used by resumable training. */
function initText(texts, { dim = 24, hidden = 48, maxLen = 32, blocks = 2, seed = 42, maxVocab = 128 } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const vocab = buildVocab(list, { maxVocab });
  const model = createModel({ vocabSize: vocab.chars.length + 1, dim, hidden, maxLen, blocks, seed });
  model.vocab = vocab;
  model.training = { optimizer: null, progress: { epochs: 0 } };
  return { model, vocab };
}

/** Builds a vocabulary, a model and trains it on supplied text in one call. */
function trainText(texts, { epochs = 20, learningRate = 0.01, validation = null, dim = 24, hidden = 48, maxLen = 32, blocks = 2, seed = 42, stride = 1, maxVocab = 128, onEpoch = null, signal = null } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const { model, vocab } = initText(list, { dim, hidden, maxLen, blocks, seed, maxVocab });
  const report = train(model, list.join('\n'), { epochs, learningRate, validation, seed, stride, onEpoch, signal });
  model.training = { optimizer: report.optimizer, progress: report.progress };
  return { model, report, vocab };
}

module.exports = {
  FORMAT,
  buildVocab,
  encode,
  decode,
  createModel,
  forward,
  nextTokenLoss,
  perplexityOf,
  prefixes,
  train,
  trainText,
  initText,
  generate,
  save,
  load,
  applySoftmax,
};
