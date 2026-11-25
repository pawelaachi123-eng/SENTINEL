'use strict';

/** Safe-integer bit operations and base conversion. */
const INT = { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 };
const UINT = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => (typeof data.value === 'string' ? data.value : String(data.value));

function asUint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw Object.assign(new Error('operand must be a 32-bit unsigned integer'), { code: 'BAD_OPERAND' });
  return value >>> 0;
}

module.exports = [
  { name: 'bits.and', title: 'Bitwise AND', description: '32-bit unsigned AND of two non-negative integers.', category: 'math', permission: 'read', tags: ['bits', 'logic'],
    parameters: object({ a: UINT, b: UINT }), examples: [{ args: { a: 12, b: 10 }, expect: 8 }], async run(x) { return result((asUint32(x.a) & asUint32(x.b)) >>> 0); }, format: fmt },
  { name: 'bits.or', title: 'Bitwise OR', description: '32-bit unsigned OR of two non-negative integers.', category: 'math', permission: 'read', tags: ['bits', 'logic'],
    parameters: object({ a: UINT, b: UINT }), examples: [{ args: { a: 12, b: 10 }, expect: 14 }], async run(x) { return result((asUint32(x.a) | asUint32(x.b)) >>> 0); }, format: fmt },
  { name: 'bits.xor', title: 'Bitwise XOR', description: '32-bit unsigned XOR of two non-negative integers.', category: 'math', permission: 'read', tags: ['bits', 'logic'],
    parameters: object({ a: UINT, b: UINT }), examples: [{ args: { a: 12, b: 10 }, expect: 6 }], async run(x) { return result((asUint32(x.a) ^ asUint32(x.b)) >>> 0); }, format: fmt },
  { name: 'bits.not', title: 'Bitwise NOT (32-bit)', description: '32-bit complement, returned as an unsigned value.', category: 'math', permission: 'read', tags: ['bits', 'logic'],
    parameters: object({ a: UINT }), examples: [{ args: { a: 0 }, expect: 4294967295 }], async run(x) { return result((~asUint32(x.a)) >>> 0); }, format: fmt },
  { name: 'bits.shift_left', title: 'Left shift', description: 'Shifts a 32-bit value left by 0..31 bits, discarding overflow.', category: 'math', permission: 'read', tags: ['bits'],
    parameters: object({ value: UINT, count: { type: 'integer', minimum: 0, maximum: 31 } }), examples: [{ args: { value: 1, count: 4 }, expect: 16 }], async run(x) { return result((asUint32(x.value) << x.count) >>> 0); }, format: fmt },
  { name: 'bits.shift_right', title: 'Logical right shift', description: 'Unsigned right shift of a 32-bit value by 0..31 bits.', category: 'math', permission: 'read', tags: ['bits'],
    parameters: object({ value: UINT, count: { type: 'integer', minimum: 0, maximum: 31 } }), examples: [{ args: { value: 16, count: 2 }, expect: 4 }], async run(x) { return result((asUint32(x.value) >>> x.count) >>> 0); }, format: fmt },
  { name: 'bits.popcount', title: 'Population count', description: 'Number of set bits in a non-negative safe integer.', category: 'math', permission: 'read', tags: ['bits', 'count'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 255 }, expect: 8 }],
    async run(x) { let value = x.value; let count = 0; while (value > 0) { value &= value - 1; count += 1; } return result(count); }, format: fmt },
  { name: 'bits.parity', title: 'Bit parity', description: '0 for an even number of set bits, 1 for odd.', category: 'math', permission: 'read', tags: ['bits'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 7 }, expect: 1 }],
    async run(x) { let value = x.value; let parity = 0; while (value) { parity ^= 1; value &= value - 1; } return result(parity); }, format: fmt },
  { name: 'bits.is_power_of_two', title: 'Power-of-two test', description: 'True for 1, 2, 4, 8… and false for zero.', category: 'math', permission: 'read', tags: ['bits'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 16 }, expect: true }], async run(x) { return result(x.value > 0 && (x.value & (x.value - 1)) === 0); }, format: fmt },
  { name: 'bits.next_power_of_two', title: 'Next power of two', description: 'Smallest power of two greater than or equal to a non-negative value; zero maps to one.', category: 'math', permission: 'read', tags: ['bits'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 9 }, expect: 16 }], async run(x) { let value = 1; while (value < x.value) value *= 2; return result(value); }, format: fmt },
  { name: 'basex.to_decimal', title: 'Parse an integer in a base', description: 'Strict base 2–36 integer parsing with range validation.', category: 'math', permission: 'read', tags: ['base', 'number'],
    parameters: object({ text: { type: 'string', minLength: 1, maxLength: 64, pattern: '^-?[0-9A-Za-z]+$' }, base: { type: 'integer', minimum: 2, maximum: 36 } }), examples: [{ args: { text: 'ff', base: 16 }, expect: 255 }],
    async run(x) { const negative = x.text.startsWith('-'); const digits = negative ? x.text.slice(1) : x.text; if (!digits) throw Object.assign(new Error('missing digits'), { code: 'BAD_NUMBER' }); let value = 0; for (const char of digits.toLowerCase()) { const digit = parseInt(char, 36); if (digit >= x.base) throw Object.assign(new Error(`digit ${char} is invalid in base ${x.base}`), { code: 'BAD_NUMBER' }); value = value * x.base + digit; if (!Number.isSafeInteger(value)) throw Object.assign(new Error('value exceeds safe integer range'), { code: 'TOO_LARGE' }); } return result(negative ? -value : value); }, format: fmt },
  { name: 'basex.from_decimal', title: 'Format an integer in a base', description: 'Formats a safe integer in a chosen base from 2 to 36.', category: 'math', permission: 'read', tags: ['base', 'number'],
    parameters: object({ value: INT, base: { type: 'integer', minimum: 2, maximum: 36 } }), examples: [{ args: { value: 255, base: 16 }, expect: 'ff' }],
    async run(x) { const negative = x.value < 0; let value = Math.abs(x.value); let out = ''; const digits = '0123456789abcdefghijklmnopqrstuvwxyz'; do { out = digits[value % x.base] + out; value = Math.floor(value / x.base); } while (value > 0); return result((negative ? '-' : '') + out); }, format: fmt },
  { name: 'basex.binary_string', title: 'Binary representation', description: 'Unsigned binary representation without a 0b prefix.', category: 'math', permission: 'read', tags: ['base', 'binary'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 10 }, expect: '1010' }], async run(x) { return result(x.value.toString(2)); }, format: fmt },
  { name: 'basex.hex_string', title: 'Hexadecimal representation', description: 'Lowercase hexadecimal representation without a 0x prefix.', category: 'math', permission: 'read', tags: ['base', 'hex'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 255 }, expect: 'ff' }], async run(x) { return result(x.value.toString(16)); }, format: fmt },
  { name: 'basex.gray_code', title: 'Binary to Gray code', description: 'Converts a non-negative integer to reflected Gray code.', category: 'math', permission: 'read', tags: ['bits', 'encoding'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 6 }, expect: 5 }], async run(x) { return result(x.value ^ (x.value >>> 1)); }, format: fmt },
  { name: 'basex.from_gray', title: 'Gray code to binary', description: 'Decodes a reflected Gray code value to its integer.', category: 'math', permission: 'read', tags: ['bits', 'encoding'],
    parameters: object({ value: UINT }), examples: [{ args: { value: 5 }, expect: 6 }],
    async run(x) { let value = x.value; let shift = 1; while (value >>> shift) { value ^= value >>> shift; shift <<= 1; } return result(value); }, format: fmt },
];
