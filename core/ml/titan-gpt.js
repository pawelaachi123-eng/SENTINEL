'use strict';

/**
 * TITAN GPT 2.0 — a compact decoder-only Transformer with the architectural
 * pieces the 9.0 character model did not have:
 *
 *   - byte-level BPE token input (core/ml/bpe.js)
 *   - RoPE positional encoding instead of learned position embeddings
 *   - RMSNorm and SwiGLU feed-forward blocks
 *   - grouped-query attention (fewer K/V heads than query heads)
 *   - multi-block causal attention
 *   - versioned checkpoints with optimizer and tokenizer state
 *   - batched gradient accumulation and deterministic sampling
 *
 * It remains a small experimental CPU model. Parameter counts are reported
 * exactly, training is measured, and nothing here claims frontier quality.
 * KV caching for incremental decoding is not implemented in this version; the
 * generator recomputes the prefix and reports its measured latency.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const autograd = require('./autograd');
const bpe = require('./bpe');

const FORMAT = 'sentinel-titan-gpt-v1';

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

function xavier(rows, cols, rng) {
  const limit = Math.sqrt(6 / (rows + cols));
  return autograd.leaf(rows, cols, () => (rng() * 2 - 1) * limit);
}

function validateConfig({ vocabSize, dim, heads, kvHeads, blocks, maxLen, hidden }) {
  if (!Number.isInteger(vocabSize) || vocabSize < 2) throw Object.assign(new Error('vocabSize must be at least 2'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(dim) || dim < 4) throw Object.assign(new Error('dim must be at least 4'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(heads) || heads < 1 || dim % heads !== 0) throw Object.assign(new Error('heads must divide dim'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(kvHeads) || kvHeads < 1 || heads % kvHeads !== 0) throw Object.assign(new Error('kvHeads must divide heads'), { code: 'BAD_CONFIG' });
  const headDim = dim / heads;
  if (headDim % 2 !== 0) throw Object.assign(new Error('head dimension must be even for RoPE'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(blocks) || blocks < 1) throw Object.assign(new Error('blocks must be positive'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(maxLen) || maxLen < 2) throw Object.assign(new Error('maxLen must be at least 2'), { code: 'BAD_CONFIG' });
  if (!Number.isInteger(hidden) || hidden < dim) throw Object.assign(new Error('SwiGLU hidden size must be at least dim'), { code: 'BAD_CONFIG' });
  return { headDim, kvDim: kvHeads * headDim };
}

function createModel({ vocabSize, dim = 32, heads = 4, kvHeads = 2, blocks = 2, maxLen = 16, hidden = null, seed = 42, ropeTheta = 10000 } = {}) {
  const hiddenSize = hidden === null ? dim * 2 : hidden;
  const { headDim, kvDim } = validateConfig({ vocabSize, dim, heads, kvHeads, blocks, maxLen, hidden: hiddenSize });
  const rng = mulberry32(seed);
  const parameters = {
    embedding: xavier(vocabSize, dim, rng),
    finalRms: autograd.leaf(1, dim, 1),
    head: xavier(dim, vocabSize, rng),
  };
  const order = [];
  for (let block = 0; block < blocks; block += 1) {
    const prefix = `b${block}`;
    parameters[`${prefix}Rms1`] = autograd.leaf(1, dim, 1);
    parameters[`${prefix}Wq`] = xavier(dim, dim, rng);
    parameters[`${prefix}Wk`] = xavier(dim, kvDim, rng);
    parameters[`${prefix}Wv`] = xavier(dim, kvDim, rng);
    parameters[`${prefix}Wo`] = xavier(dim, dim, rng);
    parameters[`${prefix}Rms2`] = autograd.leaf(1, dim, 1);
    parameters[`${prefix}Wgate`] = xavier(dim, hiddenSize, rng);
    parameters[`${prefix}Bgate`] = autograd.leaf(1, hiddenSize, 0);
    parameters[`${prefix}Wup`] = xavier(dim, hiddenSize, rng);
    parameters[`${prefix}Bup`] = autograd.leaf(1, hiddenSize, 0);
    parameters[`${prefix}Wdown`] = xavier(hiddenSize, dim, rng);
    parameters[`${prefix}Bdown`] = autograd.leaf(1, dim, 0);
  }
  const all = { ...parameters };
  const config = { vocabSize, dim, heads, kvHeads, blocks, maxLen, hidden: hiddenSize, headDim, kvDim, seed, ropeTheta };
  return {
    format: FORMAT,
    config,
    parameters,
    order: Object.keys(all),
    tokenizer: null,
    training: { optimizer: null, progress: { epochs: 0, samples: 0 } },
  };
}

function parameterCount(model) {
  return model.order.reduce((sum, name) => sum + model.parameters[name].data.length, 0);
}

function forward(model, ids, { keepAttention = false } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('forward needs at least one token'), { code: 'BAD_GPT' });
  if (ids.length > model.config.maxLen) throw Object.assign(new Error(`sequence of ${ids.length} exceeds maxLen ${model.config.maxLen}`), { code: 'BAD_GPT' });
  if (ids.some((id) => !Number.isInteger(id) || id < 0 || id >= model.config.vocabSize)) throw Object.assign(new Error('token id is outside the vocabulary'), { code: 'BAD_GPT' });
  const p = model.parameters;
  const { dim, heads, kvHeads, headDim, blocks } = model.config;
  const groupRatio = heads / kvHeads;
  const positions = ids.map((_, index) => index);
  let x = autograd.gather(p.embedding, ids);
  const attentions = [];
  for (let block = 0; block < blocks; block += 1) {
    const prefix = `b${block}`;
    const normed = autograd.rmsNorm(x, p[`${prefix}Rms1`]);
    const q = autograd.rope(autograd.matmul(normed, p[`${prefix}Wq`]), positions, headDim, { theta: model.config.ropeTheta });
    const k = autograd.rope(autograd.matmul(normed, p[`${prefix}Wk`]), positions, headDim, { theta: model.config.ropeTheta });
    const v = autograd.matmul(normed, p[`${prefix}Wv`]);
    const contexts = [];
    for (let head = 0; head < heads; head += 1) {
      const kvHead = Math.floor(head / groupRatio);
      const qh = autograd.sliceCols(q, head * headDim, headDim);
      const kh = autograd.sliceCols(k, kvHead * headDim, headDim);
      const vh = autograd.sliceCols(v, kvHead * headDim, headDim);
      const scores = autograd.scale(autograd.matmul(qh, autograd.transpose(kh)), 1 / Math.sqrt(headDim));
      const attention = autograd.causalRowSoftmax(scores);
      contexts.push(autograd.matmul(attention, vh));
      if (keepAttention) attentions.push({ block, head, kvHead, rows: attention.rows, cols: attention.cols, data: Array.from(attention.data) });
    }
    const context = autograd.concatCols(contexts);
    x = autograd.add(x, autograd.matmul(context, p[`${prefix}Wo`]));
    const normed2 = autograd.rmsNorm(x, p[`${prefix}Rms2`]);
    const gate = autograd.silu(autograd.addBias(autograd.matmul(normed2, p[`${prefix}Wgate`]), p[`${prefix}Bgate`]));
    const up = autograd.addBias(autograd.matmul(normed2, p[`${prefix}Wup`]), p[`${prefix}Bup`]);
    const gated = autograd.mul(gate, up);
    x = autograd.add(x, autograd.addBias(autograd.matmul(gated, p[`${prefix}Wdown`]), p[`${prefix}Bdown`]));
  }
  const logits = autograd.matmul(autograd.rmsNorm(x, p.finalRms), p.head);
  return { logits, attentions, tokens: ids.length };
}

function nextTokenLoss(model, ids, target) {
  const { logits } = forward(model, ids);
  return autograd.softmaxCrossEntropy(autograd.lastRow(logits), [target]);
}

function perplexityOf(model, samples) {
  if (!samples.length) return { perplexity: null, loss: null, tokens: 0 };
  let sum = 0;
  for (const sample of samples) sum += nextTokenLoss(model, sample.ids, sample.target).loss.data[0];
  const loss = sum / samples.length;
  return { loss, perplexity: Math.exp(loss), tokens: samples.length };
}

function prefixes(ids, { stride = 1 } = {}) {
  const samples = [];
  for (let index = 1; index < ids.length; index += stride) samples.push({ ids: ids.slice(0, index), target: ids[index] });
  return samples;
}

function shuffle(list, seed) {
  const rng = mulberry32(seed);
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/**
 * Train with optional gradient accumulation. One optimizer step consumes a
 * batch; the loss reported is the mean over the samples in that epoch.
 */
function train(model, texts, { epochs = 4, learningRate = 0.003, batchSize = 4, validation = null, seed = 42, stride = 1, maxSamples = 400, optimizer = null, signal = null, onEpoch = null } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const tokenizer = model.tokenizer;
  if (!tokenizer) throw Object.assign(new Error('the model has no BPE tokenizer'), { code: 'BAD_GPT' });
  if (!Number.isInteger(batchSize) || batchSize < 1) throw Object.assign(new Error('batchSize must be positive'), { code: 'BAD_GPT' });
  let samples = list.flatMap((text) => prefixes(bpe.encode(text, tokenizer), { stride }))
    .map((sample) => ({ ids: sample.ids.slice(-(model.config.maxLen - 1)), target: sample.target }))
    .filter((sample) => sample.ids.length > 0);
  if (samples.length > maxSamples) samples = shuffle(samples, seed + 7).slice(0, maxSamples);
  const validationSamples = validation == null ? [] : (Array.isArray(validation) ? validation : [validation])
    .flatMap((text) => prefixes(bpe.encode(text, tokenizer), { stride: Math.max(1, stride) }))
    .map((sample) => ({ ids: sample.ids.slice(-(model.config.maxLen - 1)), target: sample.target }))
    .filter((sample) => sample.ids.length > 0);
  const parameters = model.order.map((name) => model.parameters[name]);
  const activeOptimizer = optimizer || (model.training && model.training.optimizer) || autograd.createAdam(parameters, { learningRate });
  if (activeOptimizer.states.length !== parameters.length) throw Object.assign(new Error('optimizer state does not match the model'), { code: 'BAD_CHECKPOINT' });
  const startEpoch = Number(model.training && model.training.progress && model.training.progress.epochs) || 0;
  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    if (signal && signal.aborted) throw Object.assign(new Error('training cancelled'), { code: 'CANCELLED' });
    const ordered = shuffle(samples, seed + epoch);
    let lossSum = 0;
    let steps = 0;
    for (let start = 0; start < ordered.length; start += batchSize) {
      if (signal && signal.aborted) throw Object.assign(new Error('training cancelled'), { code: 'CANCELLED' });
      const batch = ordered.slice(start, start + batchSize);
      autograd.zeroGrad(parameters);
      for (const sample of batch) {
        const { loss } = nextTokenLoss(model, sample.ids, sample.target);
        autograd.backward(loss, { accumulate: true });
        lossSum += loss.data[0];
      }
      autograd.applyAdam(parameters, activeOptimizer, batch.length);
      steps += 1;
    }
    const record = {
      epoch: startEpoch + epoch + 1,
      trainLoss: lossSum / Math.max(1, ordered.length),
      trainPerplexity: Math.exp(lossSum / Math.max(1, ordered.length)),
      batches: steps,
      samples: ordered.length,
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
  model.training = {
    optimizer: activeOptimizer,
    progress: {
      epochs: startEpoch + epochs,
      samples: (Number(model.training && model.training.progress && model.training.progress.samples) || 0) + samples.length * epochs,
    },
  };
  return { history, optimizer: activeOptimizer, progress: model.training.progress, samples: samples.length, validationSamples: validationSamples.length };
}

function applyTemperatureTopK(row, { temperature = 0.8, topK = 0 } = {}) {
  if (!Number.isFinite(temperature) || temperature <= 0) throw Object.assign(new Error('temperature must be positive'), { code: 'BAD_SAMPLING' });
  const values = Array.from(row.data, (value) => value / temperature);
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  const keep = topK > 0 ? indexed.slice(0, Math.max(1, Math.min(topK, indexed.length))) : indexed;
  const max = keep[0].value;
  let sum = 0;
  for (const entry of keep) {
    entry.probability = Math.exp(entry.value - max);
    sum += entry.probability;
  }
  for (const entry of keep) entry.probability /= sum || 1;
  return keep;
}

function sampleToken(row, { temperature = 0.8, topK = 0, rng = Math.random } = {}) {
  const candidates = applyTemperatureTopK(row, { temperature, topK });
  const draw = rng();
  let cumulative = 0;
  for (const candidate of candidates) {
    cumulative += candidate.probability;
    if (draw <= cumulative) return candidate.index;
  }
  return candidates[candidates.length - 1].index;
}

function generate(model, prompt, { maxNewTokens = 20, temperature = 0.8, topK = 0, stopIds = [], seed = 1 } = {}) {
  if (!model.tokenizer) throw Object.assign(new Error('the model has no BPE tokenizer'), { code: 'BAD_GPT' });
  const promptIds = Array.isArray(prompt) ? prompt : bpe.encode(String(prompt), model.tokenizer);
  if (!promptIds.length) throw Object.assign(new Error('generation needs a prompt'), { code: 'BAD_GPT' });
  if (!Number.isInteger(maxNewTokens) || maxNewTokens < 0) throw Object.assign(new Error('maxNewTokens must be a non-negative integer'), { code: 'BAD_SAMPLING' });
  const rng = mulberry32(seed);
  const ids = [...promptIds];
  const started = Date.now();
  let generated = 0;
  const stops = new Set(Array.isArray(stopIds) ? stopIds : []);
  while (generated < maxNewTokens && ids.length < model.config.maxLen) {
    const { logits } = forward(model, ids);
    const next = sampleToken(autograd.lastRow(logits), { temperature, topK, rng });
    ids.push(next);
    generated += 1;
    if (stops.has(next)) break;
  }
  const ms = Math.max(1, Date.now() - started);
  return {
    ids,
    generated,
    text: bpe.decode(ids, model.tokenizer),
    newText: bpe.decode(ids.slice(promptIds.length), model.tokenizer),
    ms,
    tokensPerSecond: Number((generated / (ms / 1000)).toFixed(2)),
    stopped: ids.length < model.config.maxLen && generated >= maxNewTokens,
  };
}

function save(model, file, { progress = null } = {}) {
  if (!model.tokenizer) throw Object.assign(new Error('refusing to save a model without a tokenizer'), { code: 'BAD_GPT' });
  const activeOptimizer = model.training && model.training.optimizer;
  const payload = {
    format: FORMAT,
    version: 1,
    config: model.config,
    tokenizer: model.tokenizer,
    values: Object.fromEntries(model.order.map((name) => [name, Array.from(model.parameters[name].data)])),
    parameterCount: parameterCount(model),
    training: activeOptimizer ? {
      progress: progress || (model.training && model.training.progress) || null,
      seed: model.config.seed,
      optimizer: {
        learningRate: activeOptimizer.learningRate,
        beta1: activeOptimizer.beta1,
        beta2: activeOptimizer.beta2,
        epsilon: activeOptimizer.epsilon,
        weightDecay: activeOptimizer.weightDecay,
        step: activeOptimizer.step,
        states: activeOptimizer.states.map((state) => ({ m: Array.from(state.m), v: Array.from(state.v) })),
      },
    } : { progress: model.training ? model.training.progress : null, seed: model.config.seed, optimizer: null },
    createdAt: new Date().toISOString(),
  };
  const text = JSON.stringify(payload);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { ok: true, file, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), parameters: model.order.length, parameterCount: payload.parameterCount };
}

function load(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.format !== FORMAT) throw Object.assign(new Error(`unsupported checkpoint format: ${payload.format}`), { code: 'BAD_CHECKPOINT' });
  if (payload.version !== 1) throw Object.assign(new Error(`unsupported checkpoint version ${payload.version}`), { code: 'BAD_CHECKPOINT' });
  const model = createModel(payload.config);
  model.tokenizer = bpe.validate(payload.tokenizer);
  if (model.tokenizer.vocabSize !== model.config.vocabSize) throw Object.assign(new Error('tokenizer vocabulary does not match the model'), { code: 'BAD_CHECKPOINT' });
  for (const name of model.order) {
    const values = payload.values && payload.values[name];
    if (!Array.isArray(values) || values.length !== model.parameters[name].data.length) throw Object.assign(new Error(`checkpoint mismatch for ${name}`), { code: 'BAD_CHECKPOINT' });
    model.parameters[name].data = Float64Array.from(values);
  }
  if (payload.training && payload.training.optimizer) {
    const saved = payload.training.optimizer;
    const optimizer = autograd.createAdam(model.order.map((name) => model.parameters[name]), saved);
    optimizer.step = saved.step || 0;
    if (!Array.isArray(saved.states) || saved.states.length !== optimizer.states.length) throw Object.assign(new Error('checkpoint optimizer state is incomplete'), { code: 'BAD_CHECKPOINT' });
    saved.states.forEach((state, index) => {
      if (!Array.isArray(state.m) || !Array.isArray(state.v) || state.m.length !== optimizer.states[index].m.length) throw Object.assign(new Error('checkpoint optimizer shape mismatch'), { code: 'BAD_CHECKPOINT' });
      optimizer.states[index].m = Float64Array.from(state.m);
      optimizer.states[index].v = Float64Array.from(state.v);
    });
    model.training = { optimizer, progress: payload.training.progress || { epochs: 0, samples: 0 } };
  } else if (payload.training) {
    model.training.progress = payload.training.progress || model.training.progress;
  }
  return model;
}

/** Builds a tokenizer and an untrained model from the same corpus. */
function initText(texts, { vocabSize = 320, dim = 32, heads = 4, kvHeads = 2, blocks = 2, maxLen = 16, hidden = null, seed = 42, minFrequency = 2 } = {}) {
  const tokenizer = bpe.trainBpe(texts, { vocabSize, minFrequency });
  const model = createModel({ vocabSize: tokenizer.vocabSize, dim, heads, kvHeads, blocks, maxLen, hidden, seed });
  model.tokenizer = tokenizer;
  return { model, tokenizer };
}

module.exports = {
  FORMAT,
  createModel,
  parameterCount,
  forward,
  nextTokenLoss,
  perplexityOf,
  prefixes,
  train,
  initText,
  generate,
  sampleToken,
  save,
  load,
  applyTemperatureTopK,
};
