'use strict';

/**
 * Confidence calibration for the small classifiers.
 *
 * A softmax probability is not a promise. Temperature scaling is a one-parameter
 * post-hoc model fitted on a validation split; it changes confidence without
 * changing a single predicted label. Expected Calibration Error (ECE) and the
 * Brier score are measured on held-out data before and after.
 *
 * This is deliberately small: one parameter, a deterministic grid, no external
 * library and no hidden test-set fitting. The search range is conservative
 * (0.75–2.0) because a two-topic validation split is too small to justify
 * aggressive sharpening.
 */

function logitsFromProbabilities(probabilities) {
  return Array.from(probabilities, (probability) => Math.log(Math.max(1e-12, Number(probability) || 1e-12)));
}

function softmax(logits) {
  let max = -Infinity;
  for (const value of logits) max = Math.max(max, value);
  const exps = logits.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function tempered(probabilities, temperature = 1) {
  const t = Math.max(0.05, Number(temperature) || 1);
  return softmax(logitsFromProbabilities(probabilities).map((value) => value / t));
}

function nll(rows, temperature) {
  if (!rows.length) return Infinity;
  let total = 0;
  for (const row of rows) {
    const probabilities = tempered(row.probabilities, temperature);
    total -= Math.log(Math.max(1e-12, probabilities[row.label]));
  }
  return total / rows.length;
}

function ece(confidences, correct, bins = 10) {
  if (!confidences.length) return { ece: 0, bins: [] };
  const groups = Array.from({ length: bins }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (let index = 0; index < confidences.length; index += 1) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(confidences[index] * bins)));
    groups[bin].count += 1;
    groups[bin].confidence += confidences[index];
    groups[bin].correct += correct[index] ? 1 : 0;
  }
  let value = 0;
  const report = [];
  groups.forEach((group, index) => {
    if (!group.count) return;
    const confidence = group.confidence / group.count;
    const accuracy = group.correct / group.count;
    value += (group.count / confidences.length) * Math.abs(accuracy - confidence);
    report.push({ bin: index, count: group.count, confidence: Number(confidence.toFixed(4)), accuracy: Number(accuracy.toFixed(4)) });
  });
  return { ece: Number(value.toFixed(4)), bins: report };
}

function brier(confidences, correct) {
  if (!confidences.length) return 0;
  return Number((confidences.reduce((sum, confidence, index) => sum + (confidence - (correct[index] ? 1 : 0)) ** 2, 0) / confidences.length).toFixed(4));
}

function fitTemperature(rows, { min = 0.75, max = 2, step = 0.01 } = {}) {
  if (!rows.length) return { temperature: 1, validationNll: Infinity, searched: 0 };
  let best = { temperature: 1, validationNll: Infinity };
  let searched = 0;
  for (let temperature = min; temperature <= max + 1e-9; temperature += step) {
    const value = nll(rows, temperature);
    searched += 1;
    if (value < best.validationNll - 1e-9) best = { temperature: Number(temperature.toFixed(2)), validationNll: Number(value.toFixed(6)) };
  }
  return { ...best, searched };
}

/**
 * Builds calibration rows from a network's raw probabilities. `truth` is the
 * class index, so this works with any classifier that exposes probabilities.
 */
function rowsFromPredictions(predictions) {
  return predictions.map((entry) => ({
    probabilities: Array.from(entry.probabilities),
    label: entry.label,
    confidence: Number(entry.probabilities[entry.label]),
    correct: entry.predicted === entry.label,
  }));
}

function summary(rows, temperature = 1) {
  const confidences = [];
  const correct = [];
  for (const row of rows) {
    confidences.push(tempered(row.probabilities, temperature)[row.predicted]);
    correct.push(row.predicted === row.label);
  }
  return { ...ece(confidences, correct), brier: brier(confidences, correct), cases: rows.length, temperature };
}

module.exports = { logitsFromProbabilities, softmax, tempered, nll, ece, brier, fitTemperature, rowsFromPredictions, summary };
