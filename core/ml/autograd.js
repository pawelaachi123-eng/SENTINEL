'use strict';

/**
 * A small reverse-mode automatic differentiation engine for 2-D matrices.
 *
 * It exists because a transformer cannot be trained honestly with hand-written
 * derivatives for every composed operation. Every node stores its own data and
 * a backward function; gradients are accumulated in reverse topological order.
 * Only the operations used by the compact encoder are implemented, and each one
 * has a numeric gradient check in `test/deep.js`.
 *
 * This is not a general-purpose tensor framework: no broadcasting (except bias),
 * no GPU, no sparse tensors, no views and no external dependencies.
 */

let nextId = 1;

function zeros(length) {
  return new Float64Array(length);
}

function assertMatrix(value, name) {
  if (!value || !(value.data instanceof Float64Array) || !Number.isInteger(value.rows) || !Number.isInteger(value.cols) || value.data.length !== value.rows * value.cols) {
    throw Object.assign(new Error(`${name} must be a rows×cols Float64Array matrix`), { code: 'BAD_TENSOR' });
  }
}

class Node {
  constructor(data, rows, cols, { op = 'leaf', parents = [], backward = null } = {}) {
    this.id = nextId++;
    this.data = data;
    this.rows = rows;
    this.cols = cols;
    this.grad = zeros(data.length);
    this.op = op;
    this.parents = parents;
    this.backwardFn = backward;
  }

  get shape() {
    return [this.rows, this.cols];
  }

  at(row, column = 0) {
    return this.data[row * this.cols + column];
  }
}

function leaf(rows, cols, fill = 0) {
  const data = new Float64Array(rows * cols);
  if (typeof fill === 'function') {
    for (let index = 0; index < data.length; index += 1) data[index] = fill(index, Math.floor(index / cols), index % cols);
  } else {
    data.fill(fill);
  }
  return new Node(data, rows, cols);
}

function matrix(rows, cols) {
  return leaf(rows, cols);
}

function fromRows(rows) {
  const height = rows.length;
  const width = rows[0] ? rows[0].length : 0;
  const data = new Float64Array(height * width);
  for (let row = 0; row < height; row += 1) {
    if (rows[row].length !== width) throw Object.assign(new Error('ragged matrix'), { code: 'BAD_TENSOR' });
    for (let column = 0; column < width; column += 1) data[row * width + column] = rows[row][column];
  }
  return new Node(data, height, width);
}

function matmul(a, b) {
  assertMatrix(a, 'a');
  assertMatrix(b, 'b');
  if (a.cols !== b.rows) throw Object.assign(new Error(`matmul shape mismatch: ${a.rows}×${a.cols} × ${b.rows}×${b.cols}`), { code: 'BAD_SHAPE' });
  const out = new Float64Array(a.rows * b.cols);
  for (let row = 0; row < a.rows; row += 1) {
    for (let column = 0; column < b.cols; column += 1) {
      let sum = 0;
      for (let inner = 0; inner < a.cols; inner += 1) sum += a.data[row * a.cols + inner] * b.data[inner * b.cols + column];
      out[row * b.cols + column] = sum;
    }
  }
  const node = new Node(out, a.rows, b.cols, {
    op: 'matmul',
    parents: [a, b],
    backward: (grad) => {
      const ga = new Float64Array(a.data.length);
      const gb = new Float64Array(b.data.length);
      for (let row = 0; row < a.rows; row += 1) {
        for (let inner = 0; inner < a.cols; inner += 1) {
          let sum = 0;
          for (let column = 0; column < b.cols; column += 1) sum += grad[row * b.cols + column] * b.data[inner * b.cols + column];
          ga[row * a.cols + inner] = sum;
        }
      }
      for (let inner = 0; inner < a.cols; inner += 1) {
        for (let column = 0; column < b.cols; column += 1) {
          let sum = 0;
          for (let row = 0; row < a.rows; row += 1) sum += a.data[row * a.cols + inner] * grad[row * b.cols + column];
          gb[inner * b.cols + column] = sum;
        }
      }
      return [ga, gb];
    },
  });
  return node;
}

function add(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) throw Object.assign(new Error('add shape mismatch'), { code: 'BAD_SHAPE' });
  const out = new Float64Array(a.data.length);
  for (let index = 0; index < out.length; index += 1) out[index] = a.data[index] + b.data[index];
  return new Node(out, a.rows, a.cols, { op: 'add', parents: [a, b], backward: (grad) => [grad, grad] });
}

function addBias(a, bias) {
  if (bias.rows !== 1 || bias.cols !== a.cols) throw Object.assign(new Error('bias must be 1×cols'), { code: 'BAD_SHAPE' });
  const out = new Float64Array(a.data.length);
  for (let row = 0; row < a.rows; row += 1) {
    for (let column = 0; column < a.cols; column += 1) out[row * a.cols + column] = a.data[row * a.cols + column] + bias.data[column];
  }
  return new Node(out, a.rows, a.cols, {
    op: 'addBias',
    parents: [a, bias],
    backward: (grad) => {
      const gb = new Float64Array(bias.cols);
      for (let row = 0; row < a.rows; row += 1) for (let column = 0; column < a.cols; column += 1) gb[column] += grad[row * a.cols + column];
      return [grad, gb];
    },
  });
}

function scale(a, factor) {
  const out = new Float64Array(a.data.length);
  for (let index = 0; index < out.length; index += 1) out[index] = a.data[index] * factor;
  return new Node(out, a.rows, a.cols, {
    op: 'scale',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(grad.length);
      for (let index = 0; index < grad.length; index += 1) ga[index] = grad[index] * factor;
      return [ga];
    },
  });
}

function relu(a) {
  const out = new Float64Array(a.data.length);
  for (let index = 0; index < out.length; index += 1) out[index] = a.data[index] > 0 ? a.data[index] : 0;
  return new Node(out, a.rows, a.cols, {
    op: 'relu',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(grad.length);
      for (let index = 0; index < grad.length; index += 1) ga[index] = a.data[index] > 0 ? grad[index] : 0;
      return [ga];
    },
  });
}

function transpose(a) {
  const out = new Float64Array(a.data.length);
  for (let row = 0; row < a.rows; row += 1) for (let column = 0; column < a.cols; column += 1) out[column * a.rows + row] = a.data[row * a.cols + column];
  return new Node(out, a.cols, a.rows, {
    op: 'transpose',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(grad.length);
      for (let row = 0; row < a.cols; row += 1) for (let column = 0; column < a.rows; column += 1) ga[column * a.cols + row] = grad[row * a.rows + column];
      return [ga];
    },
  });
}

function rowSoftmax(a) {
  const out = new Float64Array(a.data.length);
  for (let row = 0; row < a.rows; row += 1) {
    let max = -Infinity;
    for (let column = 0; column < a.cols; column += 1) max = Math.max(max, a.data[row * a.cols + column]);
    let sum = 0;
    for (let column = 0; column < a.cols; column += 1) {
      const value = Math.exp(a.data[row * a.cols + column] - max);
      out[row * a.cols + column] = value;
      sum += value;
    }
    for (let column = 0; column < a.cols; column += 1) out[row * a.cols + column] /= sum || 1;
  }
  return new Node(out, a.rows, a.cols, {
    op: 'rowSoftmax',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(grad.length);
      for (let row = 0; row < a.rows; row += 1) {
        let dot = 0;
        for (let column = 0; column < a.cols; column += 1) dot += grad[row * a.cols + column] * out[row * a.cols + column];
        for (let column = 0; column < a.cols; column += 1) ga[row * a.cols + column] = out[row * a.cols + column] * (grad[row * a.cols + column] - dot);
      }
      return [ga];
    },
  });
}


/** Causal (lower-triangular) row softmax for autoregressive attention. */
function causalRowSoftmax(a) {
  const out = new Float64Array(a.data.length);
  for (let row = 0; row < a.rows; row += 1) {
    let max = -Infinity;
    for (let column = 0; column <= row; column += 1) max = Math.max(max, a.data[row * a.cols + column]);
    let sum = 0;
    for (let column = 0; column <= row; column += 1) {
      const value = Math.exp(a.data[row * a.cols + column] - max);
      out[row * a.cols + column] = value;
      sum += value;
    }
    for (let column = 0; column <= row; column += 1) out[row * a.cols + column] /= sum || 1;
  }
  return new Node(out, a.rows, a.cols, {
    op: 'causalRowSoftmax',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(grad.length);
      for (let row = 0; row < a.rows; row += 1) {
        let dot = 0;
        for (let column = 0; column <= row; column += 1) dot += grad[row * a.cols + column] * out[row * a.cols + column];
        for (let column = 0; column <= row; column += 1) ga[row * a.cols + column] = out[row * a.cols + column] * (grad[row * a.cols + column] - dot);
      }
      return [ga];
    },
  });
}

/** Selects the last row of a matrix as a 1×cols node. */
function lastRow(a) {
  if (!a.rows) throw Object.assign(new Error('cannot take the last row of an empty matrix'), { code: 'BAD_TENSOR' });
  const out = new Float64Array(a.cols);
  const offset = (a.rows - 1) * a.cols;
  for (let column = 0; column < a.cols; column += 1) out[column] = a.data[offset + column];
  return new Node(out, 1, a.cols, {
    op: 'lastRow',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(a.data.length);
      for (let column = 0; column < a.cols; column += 1) ga[offset + column] = grad[column];
      return [ga];
    },
  });
}

function layerNorm(a, gamma, beta, { epsilon = 1e-5 } = {}) {
  if (gamma.rows !== 1 || beta.rows !== 1 || gamma.cols !== a.cols || beta.cols !== a.cols) throw Object.assign(new Error('layerNorm parameters must be 1×cols'), { code: 'BAD_SHAPE' });
  const out = new Float64Array(a.data.length);
  const xhat = new Float64Array(a.data.length);
  const invStd = new Float64Array(a.rows);
  for (let row = 0; row < a.rows; row += 1) {
    let mean = 0;
    for (let column = 0; column < a.cols; column += 1) mean += a.data[row * a.cols + column];
    mean /= a.cols;
    let variance = 0;
    for (let column = 0; column < a.cols; column += 1) {
      const diff = a.data[row * a.cols + column] - mean;
      variance += diff * diff;
    }
    variance /= a.cols;
    const std = Math.sqrt(variance + epsilon);
    invStd[row] = 1 / std;
    for (let column = 0; column < a.cols; column += 1) {
      const index = row * a.cols + column;
      xhat[index] = (a.data[index] - mean) / std;
      out[index] = xhat[index] * gamma.data[column] + beta.data[column];
    }
  }
  return new Node(out, a.rows, a.cols, {
    op: 'layerNorm',
    parents: [a, gamma, beta],
    backward: (grad) => {
      const ga = new Float64Array(a.data.length);
      const dgamma = new Float64Array(a.cols);
      const dbeta = new Float64Array(a.cols);
      for (let row = 0; row < a.rows; row += 1) {
        let sumDxhat = 0;
        let sumDxhatXhat = 0;
        for (let column = 0; column < a.cols; column += 1) {
          const index = row * a.cols + column;
          const dxhat = grad[index] * gamma.data[column];
          dgamma[column] += grad[index] * xhat[index];
          dbeta[column] += grad[index];
          sumDxhat += dxhat;
          sumDxhatXhat += dxhat * xhat[index];
        }
        for (let column = 0; column < a.cols; column += 1) {
          const index = row * a.cols + column;
          const dxhat = grad[index] * gamma.data[column];
          ga[index] = (invStd[row] / a.cols) * (a.cols * dxhat - sumDxhat - xhat[index] * sumDxhatXhat);
        }
      }
      return [ga, dgamma, dbeta];
    },
  });
}

/** Mean over rows: seq×d → 1×d. */
function meanRows(a) {
  const out = new Float64Array(a.cols);
  for (let row = 0; row < a.rows; row += 1) for (let column = 0; column < a.cols; column += 1) out[column] += a.data[row * a.cols + column];
  for (let column = 0; column < a.cols; column += 1) out[column] /= Math.max(1, a.rows);
  return new Node(out, 1, a.cols, {
    op: 'meanRows',
    parents: [a],
    backward: (grad) => {
      const ga = new Float64Array(a.data.length);
      for (let row = 0; row < a.rows; row += 1) for (let column = 0; column < a.cols; column += 1) ga[row * a.cols + column] = grad[column] / Math.max(1, a.rows);
      return [ga];
    },
  });
}

/** Select rows from an embedding matrix; indices are integers in [0, rows). */
function gather(embedding, indices) {
  if (embedding.rows < 1 || !Array.isArray(indices) || !indices.length) throw Object.assign(new Error('gather needs an embedding and indices'), { code: 'BAD_TENSOR' });
  const out = new Float64Array(indices.length * embedding.cols);
  for (let row = 0; row < indices.length; row += 1) {
    const source = indices[row];
    if (!Number.isInteger(source) || source < 0 || source >= embedding.rows) throw Object.assign(new Error(`embedding index out of range: ${source}`), { code: 'BAD_INDEX' });
    for (let column = 0; column < embedding.cols; column += 1) out[row * embedding.cols + column] = embedding.data[source * embedding.cols + column];
  }
  return new Node(out, indices.length, embedding.cols, {
    op: 'gather',
    parents: [embedding],
    backward: (grad) => {
      const ge = new Float64Array(embedding.data.length);
      for (let row = 0; row < indices.length; row += 1) for (let column = 0; column < embedding.cols; column += 1) ge[indices[row] * embedding.cols + column] += grad[row * embedding.cols + column];
      return [ge];
    },
  });
}

/** Row-wise softmax with cross-entropy. Returns the scalar loss node and probabilities. */
function softmaxCrossEntropy(logits, labels) {
  if (!Array.isArray(labels) || labels.length !== logits.rows) throw Object.assign(new Error('labels must match logits rows'), { code: 'BAD_SHAPE' });
  const probabilities = new Float64Array(logits.data.length);
  let loss = 0;
  for (let row = 0; row < logits.rows; row += 1) {
    let max = -Infinity;
    for (let column = 0; column < logits.cols; column += 1) max = Math.max(max, logits.data[row * logits.cols + column]);
    let sum = 0;
    for (let column = 0; column < logits.cols; column += 1) {
      const value = Math.exp(logits.data[row * logits.cols + column] - max);
      probabilities[row * logits.cols + column] = value;
      sum += value;
    }
    for (let column = 0; column < logits.cols; column += 1) probabilities[row * logits.cols + column] /= sum || 1;
    loss -= Math.log(Math.max(1e-12, probabilities[row * logits.cols + labels[row]]));
  }
  loss /= Math.max(1, logits.rows);
  const node = new Node(Float64Array.from([loss]), 1, 1, {
    op: 'softmaxCrossEntropy',
    parents: [logits],
    backward: (grad) => {
      const gl = new Float64Array(logits.data.length);
      for (let row = 0; row < logits.rows; row += 1) {
        for (let column = 0; column < logits.cols; column += 1) gl[row * logits.cols + column] = (probabilities[row * logits.cols + column] - (column === labels[row] ? 1 : 0)) * (grad[0] / Math.max(1, logits.rows));
      }
      return [gl];
    },
  });
  return { loss: node, probabilities };
}


/** Cross-entropy against a full target distribution (knowledge distillation). */
function softCrossEntropy(logits, targets) {
  if (!Array.isArray(targets) || targets.length !== logits.cols || logits.rows !== 1) throw Object.assign(new Error('targets must match logits columns for a single row'), { code: 'BAD_SHAPE' });
  let max = -Infinity;
  for (const value of logits.data) max = Math.max(max, value);
  let sum = 0;
  const probabilities = new Float64Array(logits.cols);
  for (let column = 0; column < logits.cols; column += 1) {
    probabilities[column] = Math.exp(logits.data[column] - max);
    sum += probabilities[column];
  }
  for (let column = 0; column < logits.cols; column += 1) probabilities[column] /= sum || 1;
  let loss = 0;
  for (let column = 0; column < logits.cols; column += 1) loss -= targets[column] * Math.log(Math.max(1e-12, probabilities[column]));
  const node = new Node(Float64Array.from([loss]), 1, 1, {
    op: 'softCrossEntropy',
    parents: [logits],
    backward: (grad) => {
      const gl = new Float64Array(logits.cols);
      for (let column = 0; column < logits.cols; column += 1) gl[column] = (probabilities[column] - targets[column]) * grad[0];
      return [gl];
    },
  });
  return { loss: node, probabilities };
}

function backward(root) {
  if (root.grad.length !== root.data.length) throw Object.assign(new Error('bad root gradient'), { code: 'BAD_GRAD' });
  const order = [];
  const seen = new Set();
  const visit = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const parent of node.parents) visit(parent);
    order.push(node);
  };
  visit(root);
  for (const node of order) node.grad.fill(0);
  root.grad.fill(1);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    if (!node.backwardFn || !node.parents.length) continue;
    const grads = node.backwardFn(node.grad);
    if (!Array.isArray(grads) || grads.length !== node.parents.length) throw Object.assign(new Error(`backward failed at ${node.op}`), { code: 'BAD_GRAD' });
    node.parents.forEach((parent, parentIndex) => {
      const incoming = grads[parentIndex];
      if (!incoming || incoming.length !== parent.data.length) throw Object.assign(new Error(`gradient shape mismatch at ${node.op}`), { code: 'BAD_GRAD' });
      for (let offset = 0; offset < incoming.length; offset += 1) parent.grad[offset] += incoming[offset];
    });
  }
  return order.length;
}

/** Numeric check of d(loss)/d(parameter) on selected entries. */
function checkGradient(build, parameters, { epsilon = 1e-4, checks = 6 } = {}) {
  const first = build();
  const root = first instanceof Node ? first : first.loss;
  backward(root);
  const entries = [];
  for (let parameterIndex = 0; parameterIndex < parameters.length && entries.length < checks; parameterIndex += 1) {
    const parameter = parameters[parameterIndex];
    const count = Math.min(3, parameter.data.length);
    for (let offset = 0; offset < count && entries.length < checks; offset += 1) entries.push({ parameterIndex, offset });
  }
  const results = [];
  for (const entry of entries) {
    const parameter = parameters[entry.parameterIndex];
    const original = parameter.data[entry.offset];
    const analytic = parameter.grad[entry.offset];
    parameter.data[entry.offset] = original + epsilon;
    const plusBuilt = build();
    const plus = (plusBuilt instanceof Node ? plusBuilt : plusBuilt.loss).data[0];
    parameter.data[entry.offset] = original - epsilon;
    const minusBuilt = build();
    const minus = (minusBuilt instanceof Node ? minusBuilt : minusBuilt.loss).data[0];
    parameter.data[entry.offset] = original;
    const numeric = (plus - minus) / (2 * epsilon);
    results.push({ parameter: entry.parameterIndex, offset: entry.offset, numeric, analytic, difference: Math.abs(numeric - analytic) });
  }
  const worst = results.reduce((max, entry) => Math.max(max, entry.difference), 0);
  return { ok: worst < 2e-3, worst, checked: results.length, results };
}

function createAdam(parameters, { learningRate = 0.01, beta1 = 0.9, beta2 = 0.999, epsilon = 1e-8, weightDecay = 0 } = {}) {
  return {
    learningRate, beta1, beta2, epsilon, weightDecay, step: 0,
    parameters,
    states: parameters.map((parameter) => ({ m: new Float64Array(parameter.data.length), v: new Float64Array(parameter.data.length) })),
  };
}

function applyAdam(parameters, optimizer, divisor = 1) {
  optimizer.step += 1;
  const correction1 = 1 - Math.pow(optimizer.beta1, optimizer.step);
  const correction2 = 1 - Math.pow(optimizer.beta2, optimizer.step);
  parameters.forEach((parameter, parameterIndex) => {
    const state = optimizer.states[parameterIndex];
    for (let index = 0; index < parameter.data.length; index += 1) {
      const gradient = parameter.grad[index] / divisor;
      state.m[index] = optimizer.beta1 * state.m[index] + (1 - optimizer.beta1) * gradient;
      state.v[index] = optimizer.beta2 * state.v[index] + (1 - optimizer.beta2) * gradient * gradient;
      const mHat = state.m[index] / correction1;
      const vHat = state.v[index] / correction2;
      parameter.data[index] -= (optimizer.learningRate * mHat) / (Math.sqrt(vHat) + optimizer.epsilon);
      if (optimizer.weightDecay) parameter.data[index] -= optimizer.learningRate * optimizer.weightDecay * parameter.data[index];
    }
  });
}

function zeroGrad(parameters) {
  for (const parameter of parameters) parameter.grad.fill(0);
}

function snapshot(parameters) {
  return parameters.map((parameter) => Array.from(parameter.data));
}

function restore(parameters, snapshotValues) {
  if (!Array.isArray(snapshotValues) || snapshotValues.length !== parameters.length) throw Object.assign(new Error('checkpoint does not match parameters'), { code: 'BAD_CHECKPOINT' });
  parameters.forEach((parameter, index) => {
    if (!Array.isArray(snapshotValues[index]) || snapshotValues[index].length !== parameter.data.length) throw Object.assign(new Error('checkpoint shape mismatch'), { code: 'BAD_CHECKPOINT' });
    parameter.data = Float64Array.from(snapshotValues[index]);
  });
}

module.exports = {
  Node,
  leaf,
  matrix,
  fromRows,
  matmul,
  add,
  addBias,
  scale,
  relu,
  transpose,
  rowSoftmax,
  causalRowSoftmax,
  lastRow,
  layerNorm,
  meanRows,
  gather,
  softmaxCrossEntropy,
  softCrossEntropy,
  backward,
  checkGradient,
  createAdam,
  applyAdam,
  zeroGrad,
  snapshot,
  restore,
};
