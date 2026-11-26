'use strict';

/**
 * Knowledge distillation between two small CPU networks.
 *
 * A larger teacher is trained on labelled examples, then a smaller student is
 * trained against a blend of the teacher's full probability distribution and
 * the hard label. The comparison that matters is held-out accuracy of the same
 * student architecture trained with and without distillation, on the same
 * split. No claim is made that this transfers to a 9B teacher.
 */

const autograd = require('../ml/autograd');
const lora = require('./lora');

function oneHot(label, classes) {
  return Array.from({ length: classes }, (_, index) => (index === label ? 1 : 0));
}

function blend(teacher, label, classes, temperature = 1.5, alpha = 0.7) {
  const smoothed = teacher.map((value) => Math.pow(Math.max(1e-9, value), 1 / temperature));
  const sum = smoothed.reduce((total, value) => total + value, 0) || 1;
  const soft = smoothed.map((value) => value / sum);
  const hard = oneHot(label, classes);
  return soft.map((value, index) => alpha * value + (1 - alpha) * hard[index]);
}

function trainStudent({ base, examples, epochs = 120, learningRate = 0.06, targets = null }) {
  const parameters = base.order.map((key) => base.parameters[key]);
  const optimizer = autograd.createAdam(parameters, { learningRate });
  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let lossSum = 0;
    for (const example of examples) {
      autograd.zeroGrad(parameters);
      const logits = lora.forwardBase(base, example.vector);
      let loss;
      if (targets) {
        loss = autograd.softCrossEntropy(logits, targets.get(example)).loss;
      } else {
        loss = autograd.softmaxCrossEntropy(logits, [example.label]).loss;
      }
      autograd.backward(loss);
      autograd.applyAdam(parameters, optimizer);
      lossSum += loss.data[0];
    }
    history.push({ epoch: epoch + 1, loss: Number((lossSum / examples.length).toFixed(4)) });
  }
  return { base, history, final: history[history.length - 1] };
}

function distill({ train, test, teacher = null, student = null, classes = null, epochs = 140, teacherEpochs = 160, learningRate = 0.06, teacherConfig = null, studentConfig = null, temperature = 1.5, alpha = 0.7, seed = 21 } = {}) {
  if (!Array.isArray(train) || !Array.isArray(test) || !train.length || !test.length) throw Object.assign(new Error('distillation needs non-empty train and test lists'), { code: 'BAD_ARGUMENT' });
  const numClasses = classes || Math.max(...train.map((example) => example.label)) + 1;
  const dim = teacherConfig && teacherConfig.dim || studentConfig && studentConfig.dim || train[0].vector.length;
  const teacherModel = teacher || lora.createBase({ dim, hidden: teacherConfig && teacherConfig.hidden || 32, classes: numClasses, seed });
  const teacherTraining = lora.trainBase(teacherModel, train, { epochs: teacherEpochs, learningRate: 0.05 });
  // Teacher probabilities are computed once per training example; recomputing
  // them every epoch would triple the cost without changing the targets.
  const softTargets = new Map();
  for (const example of train) {
    const probs = lora.probabilities(lora.forwardBase(teacherModel, example.vector));
    softTargets.set(example, blend(probs, example.label, numClasses, temperature, alpha));
  }
  const studentPlain = student || lora.createBase({ dim, hidden: studentConfig && studentConfig.hidden || 8, classes: numClasses, seed: seed + 1 });
  const studentDistilled = lora.createBase({ dim, hidden: studentConfig && studentConfig.hidden || 8, classes: numClasses, seed: seed + 1 });
  const plain = trainStudent({ base: studentPlain, examples: train, epochs, learningRate });
  const distilled = trainStudent({ base: studentDistilled, examples: train, epochs, learningRate, targets: softTargets });
  const predict = (model) => (vector) => lora.argmax(lora.probabilities(lora.forwardBase(model, vector)));
  const teacherEval = lora.evaluate(predict(teacherModel), test);
  const plainEval = lora.evaluate(predict(studentPlain), test);
  const distilledEval = lora.evaluate(predict(studentDistilled), test);
  return {
    ok: true,
    classes: numClasses,
    temperature,
    alpha,
    teacher: { config: teacherModel.config, training: teacherTraining.final, evaluation: teacherEval, parameters: teacherModel.order.reduce((sum, key) => sum + teacherModel.parameters[key].data.length, 0) },
    student: { config: studentPlain.config, parameters: studentPlain.order.reduce((sum, key) => sum + studentPlain.parameters[key].data.length, 0) },
    plain: { evaluation: plainEval, finalLoss: plain.final ? plain.final.loss : null },
    distilled: { evaluation: distilledEval, finalLoss: distilled.final ? distilled.final.loss : null },
    deltaAccuracy: Number((distilledEval.accuracy - plainEval.accuracy).toFixed(4)),
    history: { plain: plain.history, distilled: distilled.history },
    payload: { format: 'sentinel-distilled-v1', config: studentDistilled.config, weights: Object.fromEntries(studentDistilled.order.map((key) => [key, Array.from(studentDistilled.parameters[key].data)])), teacher: teacherModel.config, temperature, alpha, metrics: { distilled: distilledEval, plain: plainEval } },
  };
}

module.exports = { distill, trainStudent, blend, oneHot };
