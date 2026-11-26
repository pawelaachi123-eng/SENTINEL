'use strict';

/** Dense matrix algebra for small matrices, with explicit shape checks. */
const N = { type: 'number' };
const MATRIX = { type: 'array', items: { type: 'array', items: N, minItems: 1, maxItems: 200 }, minItems: 1, maxItems: 200 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => JSON.stringify(data.value).slice(0, 300);

function shape(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) throw Object.assign(new Error('matrix must be a non-empty array of rows'), { code: 'BAD_MATRIX' });
  const width = matrix[0].length;
  if (!width) throw Object.assign(new Error('matrix rows cannot be empty'), { code: 'BAD_MATRIX' });
  if (matrix.some((row) => !Array.isArray(row) || row.length !== width || row.some((value) => !Number.isFinite(value)))) {
    throw Object.assign(new Error('matrix must be rectangular and finite'), { code: 'BAD_MATRIX' });
  }
  return { rows: matrix.length, cols: width };
}

function multiply(a, b) {
  const sa = shape(a); const sb = shape(b);
  if (sa.cols !== sb.rows) throw Object.assign(new Error(`cannot multiply ${sa.rows}×${sa.cols} by ${sb.rows}×${sb.cols}`), { code: 'SHAPE_MISMATCH' });
  return Array.from({ length: sa.rows }, (_, i) => Array.from({ length: sb.cols }, (_, j) => a[i].reduce((sum, value, k) => sum + value * b[k][j], 0)));
}

function determinant(matrix) {
  const s = shape(matrix);
  if (s.rows !== s.cols) throw Object.assign(new Error('determinant needs a square matrix'), { code: 'NOT_SQUARE' });
  const copy = matrix.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < s.cols; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < s.rows; row += 1) if (Math.abs(copy[row][col]) > Math.abs(copy[pivot][col])) pivot = row;
    if (Math.abs(copy[pivot][col]) < 1e-14) return 0;
    if (pivot !== col) { [copy[pivot], copy[col]] = [copy[col], copy[pivot]]; det *= -1; }
    det *= copy[col][col];
    for (let row = col + 1; row < s.rows; row += 1) {
      const factor = copy[row][col] / copy[col][col];
      for (let k = col; k < s.cols; k += 1) copy[row][k] -= factor * copy[col][k];
    }
  }
  return det;
}

function inverse(matrix) {
  const s = shape(matrix);
  if (s.rows !== s.cols) throw Object.assign(new Error('inverse needs a square matrix'), { code: 'NOT_SQUARE' });
  const aug = matrix.map((row, i) => [...row, ...Array.from({ length: s.rows }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < s.cols; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < s.rows; row += 1) if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
    if (Math.abs(aug[pivot][col]) < 1e-14) throw Object.assign(new Error('matrix is singular'), { code: 'SINGULAR' });
    [aug[pivot], aug[col]] = [aug[col], aug[pivot]];
    const divisor = aug[col][col];
    for (let k = 0; k < 2 * s.cols; k += 1) aug[col][k] /= divisor;
    for (let row = 0; row < s.rows; row += 1) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let k = 0; k < 2 * s.cols; k += 1) aug[row][k] -= factor * aug[col][k];
    }
  }
  return aug.map((row) => row.slice(s.cols));
}

module.exports = [
  { name: 'matrix.add', title: 'Matrix addition', description: 'Element-wise sum of two matrices with identical shape.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ a: MATRIX, b: MATRIX }), examples: [{ args: { a: [[1, 2], [3, 4]], b: [[5, 6], [7, 8]] }, expect: [[6, 8], [10, 12]] }],
    async run(x) { const sa = shape(x.a); const sb = shape(x.b); if (sa.rows !== sb.rows || sa.cols !== sb.cols) throw Object.assign(new Error('shape mismatch'), { code: 'SHAPE_MISMATCH' }); return result(x.a.map((row, i) => row.map((value, j) => value + x.b[i][j]))); }, format: fmt },
  { name: 'matrix.subtract', title: 'Matrix subtraction', description: 'Element-wise matrix subtraction for identical shapes.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ a: MATRIX, b: MATRIX }), examples: [{ args: { a: [[5, 6], [7, 8]], b: [[1, 2], [3, 4]] }, expect: [[4, 4], [4, 4]] }],
    async run(x) { const sa = shape(x.a); const sb = shape(x.b); if (sa.rows !== sb.rows || sa.cols !== sb.cols) throw Object.assign(new Error('shape mismatch'), { code: 'SHAPE_MISMATCH' }); return result(x.a.map((row, i) => row.map((value, j) => value - x.b[i][j]))); }, format: fmt },
  { name: 'matrix.scale', title: 'Scale a matrix', description: 'Multiplies every matrix element by a scalar factor.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX, factor: N }), examples: [{ args: { matrix: [[1, 2]], factor: 3 }, expect: [[3, 6]] }],
    async run(x) { shape(x.matrix); return result(x.matrix.map((row) => row.map((value) => value * x.factor))); }, format: fmt },
  { name: 'matrix.multiply', title: 'Matrix multiplication', description: 'Standard matrix product with inner-dimension validation.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ a: MATRIX, b: MATRIX }), examples: [{ args: { a: [[1, 2], [3, 4]], b: [[5, 6], [7, 8]] }, expect: [[19, 22], [43, 50]] }],
    async run(x) { return result(multiply(x.a, x.b)); }, format: fmt },
  { name: 'matrix.transpose', title: 'Transpose', description: 'Reflects a matrix across its main diagonal.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX }), examples: [{ args: { matrix: [[1, 2, 3], [4, 5, 6]] }, expect: [[1, 4], [2, 5], [3, 6]] }],
    async run(x) { const s = shape(x.matrix); return result(Array.from({ length: s.cols }, (_, j) => Array.from({ length: s.rows }, (_, i) => x.matrix[i][j]))); }, format: fmt },
  { name: 'matrix.trace', title: 'Trace', description: 'Sum of the main diagonal of a square matrix.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX }), examples: [{ args: { matrix: [[1, 2], [3, 4]] }, expect: 5 }],
    async run(x) { const s = shape(x.matrix); if (s.rows !== s.cols) throw Object.assign(new Error('trace needs a square matrix'), { code: 'NOT_SQUARE' }); return result(x.matrix.reduce((sum, row, i) => sum + row[i], 0)); }, format: fmt },
  { name: 'matrix.determinant', title: 'Determinant', description: 'Determinant by Gaussian elimination with partial pivoting.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX }), examples: [{ args: { matrix: [[1, 2], [3, 4]] }, expect: -2 }],
    async run(x) { return result(determinant(x.matrix)); }, format: fmt },
  { name: 'matrix.inverse', title: 'Inverse', description: 'Gauss–Jordan inverse; a singular matrix fails instead of returning garbage.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX }), examples: [{ args: { matrix: [[4, 7], [2, 6]] }, expect: [[0.6, -0.7], [-0.2, 0.4]] }],
    async run(x) { return result(inverse(x.matrix)); }, format: fmt },
  { name: 'matrix.identity', title: 'Identity matrix', description: 'Square identity matrix of a requested size from 1 to 100.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ size: { type: 'integer', minimum: 1, maximum: 100 } }), examples: [{ args: { size: 3 }, expect: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
    async run(x) { return result(Array.from({ length: x.size }, (_, i) => Array.from({ length: x.size }, (_, j) => (i === j ? 1 : 0)))); }, format: fmt },
  { name: 'matrix.rank', title: 'Matrix rank', description: 'Numerical rank via row reduction with a 1e−12 pivot tolerance.', category: 'math', permission: 'read', tags: ['matrix', 'linear-algebra'],
    parameters: object({ matrix: MATRIX }), examples: [{ args: { matrix: [[1, 2], [2, 4]] }, expect: 1 }],
    async run(x) {
      const s = shape(x.matrix); const copy = x.matrix.map((row) => [...row]); let rank = 0; let row = 0;
      for (let col = 0; col < s.cols && row < s.rows; col += 1) {
        let pivot = row;
        for (let i = row + 1; i < s.rows; i += 1) if (Math.abs(copy[i][col]) > Math.abs(copy[pivot][col])) pivot = i;
        if (Math.abs(copy[pivot][col]) < 1e-12) continue;
        [copy[pivot], copy[row]] = [copy[row], copy[pivot]];
        for (let i = row + 1; i < s.rows; i += 1) { const factor = copy[i][col] / copy[row][col]; for (let j = col; j < s.cols; j += 1) copy[i][j] -= factor * copy[row][j]; }
        rank += 1; row += 1;
      }
      return result(rank);
    }, format: fmt },
];
