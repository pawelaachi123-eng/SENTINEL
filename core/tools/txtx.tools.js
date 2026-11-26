'use strict';

/** Deterministic text transforms and measurements. */
const STR = { type: 'string', minLength: 1, maxLength: 200000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value) => ({ ok: true, value });
const fmt = (data) => (Array.isArray(data.value) ? data.value.join(', ') : String(data.value).slice(0, 300));

function words(text) {
  return text.trim() ? text.trim().split(/\s+/u) : [];
}

function countBy(text, regex) {
  return (text.match(regex) || []).length;
}

function snake(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function titleCase(text) {
  return text.replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (word) => word[0].toLocaleUpperCase('pl-PL') + word.slice(1).toLocaleLowerCase('pl-PL'));
}

function stripHtml(text) {
  return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unescapeHtml(text) {
  const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => map[entity] || entity);
}

function toBase(text, base) {
  return Buffer.from(text, 'utf8').toString(base);
}

const tools = [
  { name: 'txtx.reverse', title: 'Reverse text', description: 'Reverses Unicode code points, not UTF-16 code units, so emoji survive intact.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'abc🙂' }, expect: '🙂cba' }],
    async run(a) { return result([...a.text].reverse().join('')); }, format: fmt },
  { name: 'txtx.reverse_words', title: 'Reverse word order', description: 'Reverses the order of whitespace-separated words while preserving each word.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'one two three' }, expect: 'three two one' }],
    async run(a) { return result(words(a.text).reverse().join(' ')); }, format: fmt },
  { name: 'txtx.is_palindrome', title: 'Palindrome test', description: 'Checks letters and digits after case folding; punctuation and spaces are ignored.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Kobyła ma mały bok' }, expect: true }],
    async run(a) { const clean = a.text.toLocaleLowerCase('pl-PL').replace(/[^\p{L}\p{N}]/gu, ''); return result(clean === [...clean].reverse().join('')); }, format: fmt },
  { name: 'txtx.count_words', title: 'Count words', description: 'Counts whitespace-delimited words; an empty or whitespace string is zero.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: { type: 'string', maxLength: 200000 } }), examples: [{ args: { text: 'Ala ma kota' }, expect: 3 }],
    async run(a) { return result(words(a.text).length); }, format: fmt },
  { name: 'txtx.count_sentences', title: 'Count sentences', description: 'Counts runs ending in ., !, ? or an ellipsis; trailing text without punctuation counts once.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Jeden. Dwa! Trzy?' }, expect: 3 }],
    async run(a) { const parts = a.text.split(/[.!?]+(?:["'”’»)]*)\s*/u).filter((part) => part.trim()); return result(parts.length); }, format: fmt },
  { name: 'txtx.count_chars', title: 'Count characters', description: 'Counts Unicode code points, optionally excluding whitespace.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: STR, excludeWhitespace: { type: 'boolean', default: false } }),
    examples: [{ args: { text: 'a b', excludeWhitespace: true }, expect: 2 }],
    async run(a) { const source = a.excludeWhitespace ? a.text.replace(/\s/gu, '') : a.text; return result([...source].length); }, format: fmt },
  { name: 'txtx.count_letters', title: 'Count letters', description: 'Counts Unicode letters, including Polish diacritics.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Zażółć 123' }, expect: 6 }],
    async run(a) { return result(countBy(a.text, /\p{L}/gu)); }, format: fmt },
  { name: 'txtx.count_digits', title: 'Count digits', description: 'Counts Unicode decimal digit code points in the supplied text.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'a1b2c3' }, expect: 3 }],
    async run(a) { return result(countBy(a.text, /\p{Nd}/gu)); }, format: fmt },
  { name: 'txtx.frequency', title: 'Character frequency', description: 'Frequency of each code point, sorted by descending count then code point.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'aab' }, expect: [['a', 2], ['b', 1]] }],
    async run(a) { const map = new Map(); for (const char of a.text) map.set(char, (map.get(char) || 0) + 1); return result([...map.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))); }, format: fmt },
  { name: 'txtx.top_words', title: 'Most frequent words', description: 'Case-folded word counts, optionally excluding a supplied stop-word list.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, stopWords: { type: 'array', items: { type: 'string' }, maxItems: 500, default: [] } }, ['text']),
    examples: [{ args: { text: 'Kot kot pies', limit: 2 }, expect: [['kot', 2], ['pies', 1]] }],
    async run(a) { const stop = new Set(a.stopWords.map((word) => word.toLocaleLowerCase('pl-PL'))); const map = new Map(); for (const word of words(a.text)) { const key = word.toLocaleLowerCase('pl-PL').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); if (!key || stop.has(key)) continue; map.set(key, (map.get(key) || 0) + 1); } return result([...map.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, a.limit)); }, format: fmt },
  { name: 'txtx.ngrams', title: 'Word n-grams', description: 'Contiguous word n-grams for n from 1 to 5.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR, n: { type: 'integer', minimum: 1, maximum: 5 } }), examples: [{ args: { text: 'a b c', n: 2 }, expect: [['a', 'b'], ['b', 'c']] }],
    async run(a) { const list = words(a.text); const out = []; for (let i = 0; i + a.n <= list.length; i += 1) out.push(list.slice(i, i + a.n)); return result(out); }, format: fmt },
  { name: 'txtx.caesar', title: 'Caesar shift', description: 'Shifts ASCII letters by an integer, preserving case; non-letters are unchanged. This is not encryption.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR, shift: { type: 'integer', minimum: -1000000, maximum: 1000000 } }), examples: [{ args: { text: 'Abc', shift: 1 }, expect: 'Bcd' }],
    async run(a) { const shift = ((a.shift % 26) + 26) % 26; return result(a.text.replace(/[a-z]/gi, (char) => { const base = char <= 'Z' ? 65 : 97; return String.fromCharCode(((char.charCodeAt(0) - base + shift) % 26) + base); })); }, format: fmt },
  { name: 'txtx.rot13', title: 'ROT13', description: 'Self-inverse ROT13 transform for ASCII letters.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Hello' }, expect: 'Uryyb' }],
    async run(a) { return result(a.text.replace(/[a-z]/gi, (char) => { const base = char <= 'Z' ? 65 : 97; return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base); })); }, format: fmt },
  { name: 'txtx.upper', title: 'Uppercase', description: 'Locale-aware uppercase conversion, preserving Polish letters.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'zażółć' }, expect: 'ZAŻÓŁĆ' }], async run(a) { return result(a.text.toLocaleUpperCase('pl-PL')); }, format: fmt },
  { name: 'txtx.lower', title: 'Lowercase', description: 'Locale-aware lowercase conversion, preserving Polish letters.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'ZAŻÓŁĆ' }, expect: 'zażółć' }], async run(a) { return result(a.text.toLocaleLowerCase('pl-PL')); }, format: fmt },
  { name: 'txtx.title_case', title: 'Title case', description: 'Capitalizes each word while lowercasing the rest, preserving Polish letters.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'ala ma kota' }, expect: 'Ala Ma Kota' }], async run(a) { return result(titleCase(a.text)); }, format: fmt },
  { name: 'txtx.sentence_case', title: 'Sentence case', description: 'Lowercases the text, then capitalizes the first letter after each sentence terminator.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'ALA MA KOTA. PIES' }, expect: 'Ala ma kota. Pies' }],
    async run(a) { const lower = a.text.toLocaleLowerCase('pl-PL'); return result(lower.replace(/(^|[.!?]\s+)(\p{L})/gu, (_, prefix, char) => prefix + char.toLocaleUpperCase('pl-PL'))); }, format: fmt },
  { name: 'txtx.snake_case', title: 'Snake case', description: 'Normalizes words and camelCase to lower_snake_case.', category: 'text', permission: 'read', tags: ['text', 'identifier'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Hello World' }, expect: 'hello_world' }], async run(a) { return result(snake(a.text)); }, format: fmt },
  { name: 'txtx.kebab_case', title: 'Kebab case', description: 'Normalizes words and camelCase into lower-kebab-case.', category: 'text', permission: 'read', tags: ['text', 'identifier'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Hello World' }, expect: 'hello-world' }], async run(a) { return result(snake(a.text).replace(/_/g, '-')); }, format: fmt },
  { name: 'txtx.camel_case', title: 'Camel case', description: 'Normalizes to lowerCamelCase; the first word stays lowercased.', category: 'text', permission: 'read', tags: ['text', 'identifier'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'hello world' }, expect: 'helloWorld' }],
    async run(a) { const parts = snake(a.text).split('_').filter(Boolean); return result(parts.map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('')); }, format: fmt },
  { name: 'txtx.pascal_case', title: 'Pascal case', description: 'Normalizes words into PascalCase, removing separators.', category: 'text', permission: 'read', tags: ['text', 'identifier'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'hello world' }, expect: 'HelloWorld' }],
    async run(a) { return result(snake(a.text).split('_').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('')); }, format: fmt },
  { name: 'txtx.initials', title: 'Initials', description: 'First letter of each word, uppercased, joined without spaces.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Jan Kowalski' }, expect: 'JK' }],
    async run(a) { return result(words(a.text).map((word) => [...word][0]).join('').toLocaleUpperCase('pl-PL')); }, format: fmt },
  { name: 'txtx.truncate', title: 'Truncate', description: 'Cuts to a maximum code-point length and appends an ellipsis only when something was removed.', category: 'text', permission: 'read', tags: ['text', 'transform'],
    parameters: object({ text: STR, maxLength: { type: 'integer', minimum: 1, maximum: 100000 }, suffix: { type: 'string', maxLength: 10, default: '…' } }),
    examples: [{ args: { text: 'abcdef', maxLength: 3, suffix: '…' }, expect: 'abc…' }],
    async run(a) { const chars = [...a.text]; return result(chars.length <= a.maxLength ? a.text : chars.slice(0, a.maxLength).join('') + a.suffix); }, format: fmt },
  { name: 'txtx.wrap', title: 'Wrap text', description: 'Wraps on whitespace near a fixed width; a single overlong word is kept intact.', category: 'text', permission: 'read', tags: ['text', 'format'],
    parameters: object({ text: STR, width: { type: 'integer', minimum: 10, maximum: 200 } }), examples: [{ args: { text: 'one two three four', width: 10 }, expect: 'one two\nthree four' }],
    async run(a) { const out = []; let line = ''; for (const word of words(a.text)) { if (line && line.length + 1 + word.length > a.width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word; } if (line) out.push(line); return result(out.join('\n')); }, format: fmt },
  { name: 'txtx.remove_diacritics', title: 'Remove diacritics', description: 'Strips combining marks after NFD normalization; unrelated code points are preserved.', category: 'text', permission: 'read', tags: ['text', 'normalize'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Zażółć gęślą jaźń' }, expect: 'Zazolc gesla jazn' }],
    async run(a) { return result(a.text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')); }, format: fmt },
  { name: 'txtx.normalize_whitespace', title: 'Normalize whitespace', description: 'Collapses runs of whitespace to one space and trims both ends.', category: 'text', permission: 'read', tags: ['text', 'normalize'],
    parameters: object({ text: STR }), examples: [{ args: { text: '  a\t\t b  ' }, expect: 'a b' }],
    async run(a) { return result(a.text.replace(/\s+/gu, ' ').trim()); }, format: fmt },
  { name: 'txtx.strip_html', title: 'Strip HTML', description: 'Removes tags, script and style blocks, then normalizes whitespace.', category: 'text', permission: 'read', tags: ['text', 'html'],
    parameters: object({ text: STR }), examples: [{ args: { text: '<p>Hello <b>world</b></p>' }, expect: 'Hello world' }],
    async run(a) { return result(stripHtml(a.text).replace(/\s+/gu, ' ').trim()); }, format: fmt },
  { name: 'txtx.escape_html', title: 'Escape HTML', description: 'Escapes the five HTML-significant characters.', category: 'text', permission: 'read', tags: ['text', 'html'],
    parameters: object({ text: { type: 'string', maxLength: 200000 } }), examples: [{ args: { text: '<a & "b">' }, expect: '&lt;a &amp; &quot;b&quot;&gt;' }],
    async run(a) { return result(escapeHtml(a.text)); }, format: fmt },
  { name: 'txtx.unescape_html', title: 'Unescape HTML', description: 'Decodes the common named entities; unknown entities are left untouched.', category: 'text', permission: 'read', tags: ['text', 'html'],
    parameters: object({ text: STR }), examples: [{ args: { text: '&lt;p&gt; &amp;' }, expect: '<p> &' }],
    async run(a) { return result(unescapeHtml(a.text)); }, format: fmt },
  { name: 'txtx.is_anagram', title: 'Anagram test', description: 'Compares letter frequencies after removing spaces, punctuation and case.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ a: STR, b: STR }), examples: [{ args: { a: 'listen', b: 'silent' }, expect: true }],
    async run(x) { const clean = (value) => [...value.toLocaleLowerCase('pl-PL').replace(/[^\p{L}\p{N}]/gu, '')].sort().join(''); return result(clean(x.a) === clean(x.b)); }, format: fmt },
  { name: 'txtx.vowel_count', title: 'Count vowels', description: 'Counts Polish and English vowels, case-insensitively; y is not treated as a vowel.', category: 'text', permission: 'read', tags: ['text', 'count'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'Ala ma kota' }, expect: 5 }], async run(a) { return result((a.text.match(/[aeiouyąęióó]/gi) || []).length); }, format: fmt },
  { name: 'txtx.longest_word', title: 'Longest word', description: 'Longest whitespace-delimited word; ties return the first one.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'a longword bb' }, expect: 'longword' }],
    async run(a) { const list = words(a.text); return result(list.reduce((best, word) => (word.length > best.length ? word : best), '')); }, format: fmt },
  { name: 'txtx.word_lengths', title: 'Word lengths', description: 'Lengths in Unicode code points for each whitespace-delimited word.', category: 'text', permission: 'read', tags: ['text', 'analysis'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'a bb ccc' }, expect: [1, 2, 3] }],
    async run(a) { return result(words(a.text).map((word) => [...word].length)); }, format: fmt },
  { name: 'txtx.mask', title: 'Mask secrets', description: 'Keeps the first and last character, replacing the middle with a fixed mask; short strings are fully masked.', category: 'text', permission: 'read', tags: ['text', 'privacy'],
    parameters: object({ text: STR, mask: { type: 'string', minLength: 1, maxLength: 5, default: '*' } }), examples: [{ args: { text: 'secret', mask: '*' }, expect: 's****t' }],
    async run(a) { const chars = [...a.text]; if (chars.length <= 2) return result(a.mask.repeat(chars.length)); return result(chars[0] + a.mask.repeat(Math.max(1, chars.length - 2)) + chars[chars.length - 1]); }, format: fmt },
  { name: 'txtx.base64_encode', title: 'Base64 encode', description: 'Encodes UTF-8 text to standard Base64 without line wrapping.', category: 'text', permission: 'read', tags: ['text', 'encoding'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'abc' }, expect: 'YWJj' }], async run(a) { return result(toBase(a.text, 'base64')); }, format: fmt },
  { name: 'txtx.base64_decode', title: 'Base64 decode', description: 'Strict standard Base64 decode to UTF-8; invalid input fails instead of producing replacement characters.', category: 'text', permission: 'read', tags: ['text', 'encoding'],
    parameters: object({ text: { type: 'string', minLength: 1, maxLength: 200000, pattern: '^[A-Za-z0-9+/]*={0,2}$' } }), examples: [{ args: { text: 'YWJj' }, expect: 'abc' }],
    async run(a) { return result(Buffer.from(a.text, 'base64').toString('utf8')); }, format: fmt },
  { name: 'txtx.hex_encode', title: 'Hex encode', description: 'Encodes UTF-8 bytes as lowercase hexadecimal text.', category: 'text', permission: 'read', tags: ['text', 'encoding'],
    parameters: object({ text: STR }), examples: [{ args: { text: 'abc' }, expect: '616263' }], async run(a) { return result(toBase(a.text, 'hex')); }, format: fmt },
  { name: 'txtx.hex_decode', title: 'Hex decode', description: 'Strict even-length hexadecimal to UTF-8; malformed input is rejected.', category: 'text', permission: 'read', tags: ['text', 'encoding'],
    parameters: object({ text: { type: 'string', minLength: 2, maxLength: 200000, pattern: '^[0-9a-fA-F]+$' } }), examples: [{ args: { text: '616263' }, expect: 'abc' }],
    async run(a) { if (a.text.length % 2) throw Object.assign(new Error('hex needs an even number of digits'), { code: 'BAD_HEX' }); return result(Buffer.from(a.text, 'hex').toString('utf8')); }, format: fmt },
];

function wrap(tool) {
  const original = tool.run;
  return { ...tool, async run(args, ctx) {
    try { return await original(args, ctx); }
    catch (error) { return { ok: false, code: error.code || 'TEXT_ERROR', message: error.message }; }
  } };
}
module.exports = tools.map(wrap);
