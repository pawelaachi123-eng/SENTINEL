'use strict';

/** Cryptographic digests and checksums over supplied text. */
const crypto = require('node:crypto');
const STR = { type: 'string', maxLength: 1000000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value) => ({ ok: true, value });
const fmt = (data) => String(data.value);

function digest(name, algorithm, example, expect) {
  return { name, title: name.split('.').pop().toUpperCase(), description: `Hex ${algorithm} digest of the UTF-8 bytes of the supplied text.`, category: 'security', permission: 'read', tags: ['hash', 'security', 'checksum'],
    parameters: object({ text: STR }), examples: [{ args: { text: example }, expect }],
    async run(a) { return result(crypto.createHash(algorithm).update(a.text, 'utf8').digest('hex')); }, format: fmt };
}

function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = [
  digest('checksumx.sha256', 'sha256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
  digest('checksumx.sha1', 'sha1', 'abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'),
  digest('checksumx.sha512', 'sha512', 'abc', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'),
  digest('checksumx.sha384', 'sha384', 'abc', 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7'),
  digest('checksumx.md5', 'md5', 'abc', '900150983cd24fb0d6963f7d28e17f72'),
  {
    name: 'checksumx.crc32', title: 'CRC32', description: 'IEEE 802.3 CRC-32 of UTF-8 bytes, returned as an unsigned integer and hex.', category: 'security', permission: 'read', tags: ['checksum', 'crc32'],
    parameters: object({ text: STR }), examples: [{ args: { text: '123456789' }, expect: { decimal: 3421780262, hex: 'cbf43926' } }],
    async run(a) { const value = crc32(a.text); return { ok: true, decimal: value, hex: value.toString(16).padStart(8, '0') }; }, format: (data) => data.hex,
  },
  {
    name: 'checksumx.hmac_sha256', title: 'HMAC-SHA256', description: 'Hex HMAC-SHA256 over UTF-8 text with a supplied key; the key is not persisted.', category: 'security', permission: 'read', tags: ['hmac', 'security'],
    parameters: object({ text: STR, key: { type: 'string', minLength: 1, maxLength: 4096 } }), examples: [{ args: { text: 'message', key: 'secret' }, expect: '8b5f48702995c1598c573db1e21866a9b825d4a794d169d7060a03605796360b' }],
    async run(a) { return result(crypto.createHmac('sha256', a.key).update(a.text, 'utf8').digest('hex')); }, format: fmt,
  },
  {
    name: 'checksumx.timing_safe_equal', title: 'Constant-time comparison', description: 'Compares two UTF-8 strings in constant time and returns a boolean; lengths are compared first, which is not secret.', category: 'security', permission: 'read', tags: ['security', 'compare'],
    parameters: object({ a: STR, b: STR }), examples: [{ args: { a: 'abc', b: 'abc' }, expect: true }],
    async run(x) { const left = Buffer.from(x.a); const right = Buffer.from(x.b); return result(left.length === right.length && crypto.timingSafeEqual(left, right)); }, format: fmt,
  },
  {
    name: 'checksumx.random_hex', title: 'Random hex token', description: 'Cryptographically random hex token of 1..256 bytes; for secrets, not a substitute for a password manager.', category: 'security', permission: 'read', tags: ['random', 'security'],
    parameters: object({ bytes: { type: 'integer', minimum: 1, maximum: 256, default: 16 } }), examples: [{ args: { bytes: 4 }, expect: { length: 8 } }],
    async run(a) { const value = crypto.randomBytes(a.bytes).toString('hex'); return { ok: true, value, length: value.length, bytes: a.bytes }; }, format: (data) => data.value,
  },
  {
    name: 'checksumx.constant_time_check_prefix', title: 'Check a token prefix safely', description: 'Checks whether a presented token has an expected prefix without early-exit comparison on the prefix bytes.', category: 'security', permission: 'read', tags: ['security', 'token'],
    parameters: object({ token: STR, prefix: { type: 'string', minLength: 1, maxLength: 4096 } }), examples: [{ args: { token: 'abc123', prefix: 'abc' }, expect: true }],
    async run(x) { const expected = Buffer.from(x.prefix); const actual = Buffer.from(x.token.slice(0, x.prefix.length)); return result(actual.length === expected.length && crypto.timingSafeEqual(actual, expected)); }, format: fmt,
  },
];
