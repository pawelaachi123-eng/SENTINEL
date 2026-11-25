'use strict';

/**
 * Descriptive and inferential statistics with explicit definitions.
 *
 * Population and sample variants are separate tools instead of one ambiguous
 * `variance`; the tool name tells the caller which denominator is used. Empty
 * samples fail, and every result is finite or the call fails.
 */

const NUM = { type: 'number' };
const ARR = { type: 'array', items: NUM, minItems: 1, maxItems: 100000 };
const PAIR = {
  type: 'object',
  properties: { x: { ...ARR }, y: { ...ARR } },
  required: ['x', 'y'],
  additionalProperties: false,
};
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmtNumber = (data) => (typeof data.value === 'number' ? String(Number(data.value.toPrecision(12))) : JSON.stringify(data.value).slice(0, 200));

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function quantile(values, p) {
  const list = sorted(values);
  if (list.length === 1) return list[0];
  const position = (list.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return list[lower];
  return list[lower] + (list[upper] - list[lower]) * (position - lower);
}

function variance(values, sample = false) {
  const average = mean(values);
  const denominator = values.length - (sample ? 1 : 0);
  if (denominator <= 0) throw Object.assign(new Error('sample variance needs at least two values'), { code: 'SAMPLE_TOO_SMALL' });
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / denominator;
}

function covariance(x, y, sample = false) {
  if (x.length !== y.length) throw Object.assign(new Error('x and y must have equal length'), { code: 'LENGTH_MISMATCH' });
  const denominator = x.length - (sample ? 1 : 0);
  if (denominator <= 0) throw Object.assign(new Error('sample covariance needs at least two pairs'), { code: 'SAMPLE_TOO_SMALL' });
  const mx = mean(x);
  const my = mean(y);
  return x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0) / denominator;
}

function ranks(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array(values.length);
  for (let i = 0; i < ordered.length;) {
    let j = i;
    while (j + 1 < ordered.length && ordered[j + 1].value === ordered[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[ordered[k].index] = rank;
    i = j + 1;
  }
  return out;
}

function histogram(values, bins) {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000) throw Object.assign(new Error('bins must be an integer from 1 to 1000'), { code: 'BAD_BINS' });
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const width = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, index) => ({ from: min + index * width, to: min + (index + 1) * width, count: 0 }));
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - min) / width));
    out[index].count += 1;
  }
  return out;
}

const tools = [
  {
    name: 'statx.mean', title: 'Arithmetic mean', description: 'Sum divided by count for a non-empty sample.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'descriptive', 'pure'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4] }, expect: 2.5 }],
    async run(args) { return result(mean(args.values)); }, format: fmtNumber,
  },
  {
    name: 'statx.median', title: 'Median', description: 'Middle value, interpolating between the two middle values for an even count.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'descriptive', 'robust'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [4, 1, 3, 2] }, expect: 2.5 }],
    async run(args) { return result(quantile(args.values, 0.5)); }, format: fmtNumber,
  },
  {
    name: 'statx.mode', title: 'Mode', description: 'Most frequent value; ties are returned in ascending order rather than choosing arbitrarily.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'descriptive'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 2, 3, 3] }, expect: [2, 3] }],
    async run(args) {
      const counts = new Map();
      for (const value of args.values) counts.set(value, (counts.get(value) || 0) + 1);
      const max = Math.max(...counts.values());
      return result([...counts.entries()].filter(([, count]) => count === max).map(([value]) => value).sort((a, b) => a - b));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.range', title: 'Range', description: 'Difference between the maximum and minimum values.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'descriptive'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [3, 9, 1] }, expect: 8 }],
    async run(args) { return result(Math.max(...args.values) - Math.min(...args.values)); }, format: fmtNumber,
  },
  {
    name: 'statx.variance_population', title: 'Population variance', description: 'Mean squared deviation with denominator n, for the complete population.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'variance'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4] }, expect: 1.25 }],
    async run(args) { return result(variance(args.values, false)); }, format: fmtNumber,
  },
  {
    name: 'statx.variance_sample', title: 'Sample variance', description: 'Unbiased sample variance with denominator n−1; requires at least two values.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'variance'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4] }, expect: 1.6666666666666667 }],
    async run(args) { return result(variance(args.values, true)); }, format: fmtNumber,
  },
  {
    name: 'statx.stddev_population', title: 'Population standard deviation', description: 'Square root of the population variance, using denominator n.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'variance'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4] }, expect: Math.sqrt(1.25) }],
    async run(args) { return result(Math.sqrt(variance(args.values, false))); }, format: fmtNumber,
  },
  {
    name: 'statx.stddev_sample', title: 'Sample standard deviation', description: 'Square root of unbiased sample variance.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'variance'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4] }, expect: Math.sqrt(5 / 3) }],
    async run(args) { return result(Math.sqrt(variance(args.values, true))); }, format: fmtNumber,
  },
  {
    name: 'statx.quantile', title: 'Quantile', description: 'Linear-interpolated quantile for p in [0, 1].',
    category: 'statistics', permission: 'read', tags: ['statistics', 'quantile'],
    parameters: object({ values: ARR, p: { ...NUM, minimum: 0, maximum: 1 } }), examples: [{ args: { values: [1, 2, 3, 4], p: 0.25 }, expect: 1.75 }],
    async run(args) { return result(quantile(args.values, args.p)); }, format: fmtNumber,
  },
  {
    name: 'statx.iqr', title: 'Interquartile range', description: 'Q3 minus Q1, a robust measure of spread.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'quantile', 'robust'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4, 5] }, expect: 2 }],
    async run(args) { return result(quantile(args.values, 0.75) - quantile(args.values, 0.25)); }, format: fmtNumber,
  },
  {
    name: 'statx.skewness', title: 'Skewness', description: 'Fisher–Pearson sample skewness; requires non-zero sample variance.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'shape'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4, 10] }, expect: 1.697056274847714 }],
    async run(args) {
      const n = args.values.length;
      if (n < 3) throw Object.assign(new Error('skewness needs at least three values'), { code: 'SAMPLE_TOO_SMALL' });
      const average = mean(args.values);
      const sd = Math.sqrt(variance(args.values, true));
      if (sd === 0) throw Object.assign(new Error('skewness is undefined for zero variance'), { code: 'ZERO_VARIANCE' });
      const m3 = args.values.reduce((sum, value) => sum + ((value - average) / sd) ** 3, 0);
      return result((n / ((n - 1) * (n - 2))) * m3);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.kurtosis_excess', title: 'Excess kurtosis', description: 'Unbiased Fisher excess kurtosis; a normal sample tends toward zero.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'shape'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3, 4, 5, 6] }, expect: -1.2 }],
    async run(args) {
      const n = args.values.length;
      if (n < 4) throw Object.assign(new Error('kurtosis needs at least four values'), { code: 'SAMPLE_TOO_SMALL' });
      const average = mean(args.values);
      const sd = Math.sqrt(variance(args.values, true));
      if (sd === 0) throw Object.assign(new Error('kurtosis is undefined for zero variance'), { code: 'ZERO_VARIANCE' });
      const m4 = args.values.reduce((sum, value) => sum + ((value - average) / sd) ** 4, 0);
      return result(((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * m4 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.zscore', title: 'Z-score', description: 'How many sample standard deviations a value lies from the mean.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'standardize'],
    parameters: object({ values: ARR, value: NUM }), examples: [{ args: { values: [1, 2, 3], value: 3 }, expect: 1 }],
    async run(args) { const sd = Math.sqrt(variance(args.values, true)); if (sd === 0) throw Object.assign(new Error('zero variance'), { code: 'ZERO_VARIANCE' }); return result((args.value - mean(args.values)) / sd); }, format: fmtNumber,
  },
  {
    name: 'statx.zscores', title: 'All z-scores', description: 'Sample-standardized copy of the input array.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'standardize'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3] }, expect: [-1, 0, 1] }],
    async run(args) { const average = mean(args.values); const sd = Math.sqrt(variance(args.values, true)); if (sd === 0) throw Object.assign(new Error('zero variance'), { code: 'ZERO_VARIANCE' }); return result(args.values.map((value) => (value - average) / sd)); }, format: fmtNumber,
  },
  {
    name: 'statx.covariance_population', title: 'Population covariance', description: 'Mean product deviation for two equal-length arrays.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'covariance'],
    parameters: PAIR, examples: [{ args: { x: [1, 2, 3], y: [2, 4, 6] }, expect: 1.3333333333333333 }],
    async run(args) { return result(covariance(args.x, args.y, false)); }, format: fmtNumber,
  },
  {
    name: 'statx.covariance_sample', title: 'Sample covariance', description: 'Unbiased covariance with denominator n−1.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'covariance'],
    parameters: PAIR, examples: [{ args: { x: [1, 2, 3], y: [2, 4, 6] }, expect: 2 }],
    async run(args) { return result(covariance(args.x, args.y, true)); }, format: fmtNumber,
  },
  {
    name: 'statx.correlation_pearson', title: 'Pearson correlation', description: 'Pearson product-moment correlation; zero variance is rejected.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'correlation'],
    parameters: PAIR, examples: [{ args: { x: [1, 2, 3], y: [2, 4, 6] }, expect: 1 }],
    async run(args) {
      const sx = Math.sqrt(variance(args.x, true));
      const sy = Math.sqrt(variance(args.y, true));
      if (sx === 0 || sy === 0) throw Object.assign(new Error('correlation needs non-zero variance'), { code: 'ZERO_VARIANCE' });
      return result(covariance(args.x, args.y, true) / (sx * sy));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.correlation_spearman', title: 'Spearman rank correlation', description: 'Pearson correlation of average ranks, robust to monotone rescaling.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'correlation', 'robust'],
    parameters: PAIR, examples: [{ args: { x: [1, 2, 3], y: [3, 2, 1] }, expect: -1 }],
    async run(args) {
      if (args.x.length !== args.y.length) throw Object.assign(new Error('length mismatch'), { code: 'LENGTH_MISMATCH' });
      const rx = ranks(args.x);
      const ry = ranks(args.y);
      const sx = Math.sqrt(variance(rx, true));
      const sy = Math.sqrt(variance(ry, true));
      if (sx === 0 || sy === 0) throw Object.assign(new Error('constant ranking'), { code: 'ZERO_VARIANCE' });
      return result(covariance(rx, ry, true) / (sx * sy));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.linear_fit', title: 'Ordinary least-squares fit', description: 'Slope and intercept of y = slope*x + intercept, plus R².',
    category: 'statistics', permission: 'read', tags: ['statistics', 'regression'],
    parameters: PAIR, examples: [{ args: { x: [1, 2, 3], y: [2, 4, 6] }, expect: { slope: 2, intercept: 0, r2: 1 } }],
    async run(args) {
      if (args.x.length !== args.y.length || args.x.length < 2) throw Object.assign(new Error('need at least two equal-length pairs'), { code: 'BAD_SAMPLE' });
      const mx = mean(args.x);
      const my = mean(args.y);
      const sxx = args.x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
      if (sxx === 0) throw Object.assign(new Error('x has zero variance'), { code: 'ZERO_VARIANCE' });
      const sxy = args.x.reduce((sum, value, index) => sum + (value - mx) * (args.y[index] - my), 0);
      const slope = sxy / sxx;
      const intercept = my - slope * mx;
      const fitted = args.x.map((value) => slope * value + intercept);
      const ssRes = args.y.reduce((sum, value, index) => sum + (value - fitted[index]) ** 2, 0);
      const ssTot = args.y.reduce((sum, value) => sum + (value - my) ** 2, 0);
      const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
      return { ok: true, slope, intercept, r2 };
    },
    format: (data) => `y = ${Number(data.slope.toPrecision(8))}x + ${Number(data.intercept.toPrecision(8))} (R² ${Number(data.r2.toPrecision(6))})`,
  },
  {
    name: 'statx.predict_linear', title: 'Predict from a linear fit', description: 'Applies a supplied slope and intercept to x; does not refit.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'regression'],
    parameters: object({ slope: NUM, intercept: NUM, x: NUM }), examples: [{ args: { slope: 2, intercept: 1, x: 5 }, expect: 11 }],
    async run(args) { return result(args.slope * args.x + args.intercept); }, format: fmtNumber,
  },
  {
    name: 'statx.histogram', title: 'Histogram', description: 'Equal-width bins between the observed minimum and maximum, with exact counts.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'distribution'],
    parameters: object({ values: ARR, bins: { type: 'integer', minimum: 1, maximum: 1000 } }),
    examples: [{ args: { values: [1, 2, 3, 4], bins: 2 }, expect: [{ from: 1, to: 2.5, count: 2 }, { from: 2.5, to: 4, count: 2 }] }],
    async run(args) { return result(histogram(args.values, args.bins)); }, format: fmtNumber,
  },
  {
    name: 'statx.moving_average', title: 'Moving average', description: 'Trailing mean over a fixed window; the first window−1 positions are omitted, not padded.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'time-series'],
    parameters: object({ values: ARR, window: { type: 'integer', minimum: 1, maximum: 10000 } }),
    examples: [{ args: { values: [1, 2, 3, 4], window: 2 }, expect: [1.5, 2.5, 3.5] }],
    async run(args) {
      if (args.window > args.values.length) throw Object.assign(new Error('window exceeds sample size'), { code: 'BAD_W INDOW' });
      const out = [];
      for (let i = args.window - 1; i < args.values.length; i += 1) out.push(mean(args.values.slice(i - args.window + 1, i + 1)));
      return result(out);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.exponential_moving_average', title: 'Exponential moving average', description: 'EMA seeded with the first value, using 2/(window+1) as smoothing.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'time-series'],
    parameters: object({ values: ARR, window: { type: 'integer', minimum: 1, maximum: 10000 } }),
    examples: [{ args: { values: [1, 2, 3], window: 2 }, expect: [1, 1.6666666666666667, 2.5555555555555554] }],
    async run(args) {
      const alpha = 2 / (args.window + 1);
      const out = [args.values[0]];
      for (let i = 1; i < args.values.length; i += 1) out.push(alpha * args.values[i] + (1 - alpha) * out[i - 1]);
      return result(out);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.cumulative_sum', title: 'Cumulative sum', description: 'Running total of an array, preserving length.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'series'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3] }, expect: [1, 3, 6] }],
    async run(args) { let total = 0; return result(args.values.map((value) => { total += value; return total; })); }, format: fmtNumber,
  },
  {
    name: 'statx.differences', title: 'Successive differences', description: 'First differences of a series; output length is one less than input.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'series'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 4, 9, 16] }, expect: [3, 5, 7] }],
    async run(args) { const out = []; for (let i = 1; i < args.values.length; i += 1) out.push(args.values[i] - args.values[i - 1]); return result(out); }, format: fmtNumber,
  },
  {
    name: 'statx.geometric_mean', title: 'Geometric mean', description: 'nth root of the product; requires strictly positive values.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'mean'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 4, 16] }, expect: 4 }],
    async run(args) { if (args.values.some((value) => value <= 0)) throw Object.assign(new Error('geometric mean needs positive values'), { code: 'DOMAIN' }); return result(Math.exp(mean(args.values.map(Math.log)))); }, format: fmtNumber,
  },
  {
    name: 'statx.harmonic_mean', title: 'Harmonic mean', description: 'n divided by the sum of reciprocals; requires non-zero values.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'mean'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 4] }, expect: 1.7142857142857142 }],
    async run(args) { if (args.values.some((value) => value === 0)) throw Object.assign(new Error('harmonic mean needs non-zero values'), { code: 'DOMAIN' }); return result(args.values.length / args.values.reduce((sum, value) => sum + 1 / value, 0)); }, format: fmtNumber,
  },
  {
    name: 'statx.weighted_mean', title: 'Weighted mean', description: 'Weighted average with equal lengths and a positive total weight.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'mean'],
    parameters: object({ values: ARR, weights: ARR }), examples: [{ args: { values: [2, 4], weights: [1, 3] }, expect: 3.5 }],
    async run(args) {
      if (args.values.length !== args.weights.length) throw Object.assign(new Error('length mismatch'), { code: 'LENGTH_MISMATCH' });
      const total = args.weights.reduce((sum, value) => sum + value, 0);
      if (total <= 0) throw Object.assign(new Error('weights must sum to a positive value'), { code: 'BAD_WEIGHTS' });
      return result(args.values.reduce((sum, value, index) => sum + value * args.weights[index], 0) / total);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.trimmed_mean', title: 'Trimmed mean', description: 'Mean after discarding an equal fraction from both tails; the fraction must leave at least one value.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'mean', 'robust'],
    parameters: object({ values: ARR, fraction: { ...NUM, minimum: 0, maximum: 0.49 } }),
    examples: [{ args: { values: [1, 2, 3, 100], fraction: 0.25 }, expect: 2.5 }],
    async run(args) {
      const list = sorted(args.values);
      const cut = Math.floor(list.length * args.fraction);
      const kept = list.slice(cut, list.length - cut);
      if (!kept.length) throw Object.assign(new Error('trim removes every value'), { code: 'BAD_FRACTION' });
      return result(mean(kept));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.outlier_indices', title: 'Outlier indices', description: 'Indices outside the 1.5×IQR fences, computed from sample quartiles.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'outlier', 'robust'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [10, 10, 10, 10, 100] }, expect: [4] }],
    async run(args) {
      const q1 = quantile(args.values, 0.25);
      const q3 = quantile(args.values, 0.75);
      const iqr = q3 - q1;
      const low = q1 - 1.5 * iqr;
      const high = q3 + 1.5 * iqr;
      return result(args.values.map((value, index) => (value < low || value > high ? index : -1)).filter((index) => index >= 0));
    },
    format: fmtNumber,
  },
  {
    name: 'statx.entropy_shannon', title: 'Shannon entropy', description: 'Entropy in bits of the empirical distribution of the values.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'information'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 1, 2, 2] }, expect: 1 }],
    async run(args) {
      const counts = new Map();
      for (const value of args.values) counts.set(value, (counts.get(value) || 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) { const p = count / args.values.length; entropy -= p * Math.log2(p); }
      return result(entropy);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.gini', title: 'Gini coefficient', description: 'Inequality measure for non-negative values; 0 is perfect equality.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'inequality'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 1, 1] }, expect: 0 }],
    async run(args) {
      if (args.values.some((value) => value < 0)) throw Object.assign(new Error('Gini needs non-negative values'), { code: 'DOMAIN' });
      const total = args.values.reduce((sum, value) => sum + value, 0);
      if (total === 0) throw Object.assign(new Error('Gini is undefined for an all-zero sample'), { code: 'ZERO_TOTAL' });
      const list = sorted(args.values);
      let weighted = 0;
      for (let i = 0; i < list.length; i += 1) weighted += (i + 1) * list[i];
      return result((2 * weighted) / (list.length * total) - (list.length + 1) / list.length);
    },
    format: fmtNumber,
  },
  {
    name: 'statx.coefficient_of_variation', title: 'Coefficient of variation', description: 'Sample standard deviation divided by the absolute mean; rejects a zero mean.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'dispersion'],
    parameters: object({ values: ARR }), examples: [{ args: { values: [1, 2, 3] }, expect: 0.5 }],
    async run(args) { const average = mean(args.values); if (average === 0) throw Object.assign(new Error('mean is zero'), { code: 'ZERO_MEAN' }); return result(Math.sqrt(variance(args.values, true)) / Math.abs(average)); }, format: fmtNumber,
  },
  {
    name: 'statx.mean_confidence_interval', title: 'Confidence interval for a mean', description: 'Normal-approximation interval for the sample mean; labelled as an approximation, not an exact t interval.',
    category: 'statistics', permission: 'read', tags: ['statistics', 'inference'],
    parameters: object({ values: ARR, confidence: { ...NUM, minimum: 0.01, maximum: 0.999 } }),
    examples: [{ args: { values: [1, 2, 3], confidence: 0.95 }, expect: { mean: 2, low: 0.8684142657, high: 3.1315857343 } }],
    async run(args) {
      const average = mean(args.values);
      const se = Math.sqrt(variance(args.values, true) / args.values.length);
      const z = { 0.8: 1.2815515655, 0.9: 1.644853627, 0.95: 1.959963985, 0.99: 2.575829304 }[args.confidence] || 1.959963985;
      return { ok: true, mean: average, low: average - z * se, high: average + z * se, method: 'normal approximation' };
    },
    format: (data) => `[${Number(data.low.toFixed(3))}, ${Number(data.high.toFixed(3))}] around ${Number(data.mean.toFixed(3))}`,
  },
];

function wrap(tool) {
  const original = tool.run;
  return {
    ...tool,
    async run(args, ctx) {
      try {
        const data = await original(args, ctx);
        const fail = (value) => typeof value === 'number' && !Number.isFinite(value);
        if (data && fail(data.value)) throw Object.assign(new Error('non-finite result'), { code: 'NON_FINITE' });
        return data;
      } catch (error) {
        return { ok: false, code: error.code || 'STATS_ERROR', message: error.message };
      }
    },
  };
}

module.exports = tools.map(wrap);
