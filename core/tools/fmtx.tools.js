'use strict';

/** Deterministic formatting helpers; no locale database is guessed. */
const N = { type: 'number' };
const INT = { type: 'integer' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value) => ({ ok: true, value });
const fmt = (data) => String(data.value).slice(0, 300);

function roman(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3999) throw Object.assign(new Error('Roman numerals cover 1..3999'), { code: 'OUT_OF_RANGE' });
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let left = value; let out = '';
  for (const [amount, numeral] of table) while (left >= amount) { out += numeral; left -= amount; }
  return out;
}

module.exports = [
  { name: 'fmtx.bytes', title: 'Format bytes', description: 'Formats a non-negative byte count with binary units and two decimals.', category: 'text', permission: 'read', tags: ['format', 'bytes'],
    parameters: object({ bytes: { ...N, minimum: 0, maximum: 1e21 }, binary: { type: 'boolean', default: true } }), examples: [{ args: { bytes: 1536, binary: true }, expect: '1.5 KiB' }],
    async run(x) { const base = x.binary ? 1024 : 1000; const units = x.binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] : ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB']; let value = x.bytes; let index = 0; while (value >= base && index < units.length - 1) { value /= base; index += 1; } return result(`${index === 0 ? Math.round(value) : Number(value.toFixed(2))} ${units[index]}`); }, format: fmt },
  { name: 'fmtx.duration', title: 'Format duration', description: 'Formats seconds as days, hours, minutes and seconds, omitting zero leading units.', category: 'text', permission: 'read', tags: ['format', 'time'],
    parameters: object({ seconds: { ...N, minimum: 0, maximum: 1e12 } }), examples: [{ args: { seconds: 3725 }, expect: '1h 2m 5s' }],
    async run(x) { let left = Math.floor(x.seconds); const days = Math.floor(left / 86400); left %= 86400; const hours = Math.floor(left / 3600); left %= 3600; const minutes = Math.floor(left / 60); const seconds = left % 60; const parts = []; if (days) parts.push(`${days}d`); if (hours) parts.push(`${hours}h`); if (minutes) parts.push(`${minutes}m`); if (seconds || !parts.length) parts.push(`${seconds}s`); return result(parts.join(' ')); }, format: fmt },
  { name: 'fmtx.percent', title: 'Format percent', description: 'Multiplies a fraction by 100 and formats with a fixed number of decimals.', category: 'text', permission: 'read', tags: ['format', 'percent'],
    parameters: object({ fraction: { type: 'number', minimum: -1e9, maximum: 1e9 }, decimals: { ...INT, minimum: 0, maximum: 10, default: 1 } }), examples: [{ args: { fraction: 0.1234, decimals: 1 }, expect: '12.3%' }],
    async run(x) { return result(`${(x.fraction * 100).toFixed(x.decimals)}%`); }, format: fmt },
  { name: 'fmtx.ordinal_en', title: 'English ordinal', description: 'English ordinal suffix for a non-negative integer (1st, 2nd, 3rd, 11th).', category: 'text', permission: 'read', tags: ['format', 'number'],
    parameters: object({ value: { ...INT, minimum: 0, maximum: 1e12 } }), examples: [{ args: { value: 11 }, expect: '11th' }],
    async run(x) { const mod100 = x.value % 100; const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[x.value % 10] || 'th'; return result(`${x.value}${suffix}`); }, format: fmt },
  { name: 'fmtx.ordinal_pl', title: 'Polish ordinal', description: 'Polish ordinal suffix for masculine counting (1., 2., 3.…), including 11–14.', category: 'text', permission: 'read', tags: ['format', 'number', 'polish'],
    parameters: object({ value: { ...INT, minimum: 1, maximum: 1e12 } }), examples: [{ args: { value: 3 }, expect: '3.' }],
    async run(x) { const mod100 = x.value % 100; const mod10 = x.value % 10; return result(`${x.value}.`); }, format: fmt },
  { name: 'fmtx.roman', title: 'Roman numeral', description: 'Standard subtractive Roman numeral for 1..3999.', category: 'text', permission: 'read', tags: ['format', 'roman'],
    parameters: object({ value: { ...INT, minimum: 1, maximum: 3999 } }), examples: [{ args: { value: 1994 }, expect: 'MCMXCIV' }], async run(x) { return result(roman(x.value)); }, format: fmt },
  { name: 'fmtx.from_roman', title: 'Parse Roman numeral', description: 'Strict Roman numeral parser for canonical values 1..3999.', category: 'text', permission: 'read', tags: ['format', 'roman'],
    parameters: object({ text: { type: 'string', minLength: 1, maxLength: 15, pattern: '^[IVXLCDM]+$' } }), examples: [{ args: { text: 'MCMXCIV' }, expect: 1994 }],
    async run(x) { const table = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let total = 0; for (let i = 0; i < x.text.length; i += 1) { const value = table[x.text[i]]; const next = table[x.text[i + 1]] || 0; total += value < next ? -value : value; } if (roman(total) !== x.text) throw Object.assign(new Error('not a canonical Roman numeral'), { code: 'BAD_ROMAN' }); return result(total); }, format: fmt },
  { name: 'fmtx.group_digits', title: 'Group digits', description: 'Groups an integer with a chosen separator; negative signs are preserved.', category: 'text', permission: 'read', tags: ['format', 'number'],
    parameters: object({ value: INT, separator: { type: 'string', minLength: 1, maxLength: 3, default: ' ' } }), examples: [{ args: { value: 1234567, separator: ' ' }, expect: '1 234 567' }],
    async run(x) { const negative = x.value < 0; const digits = String(Math.abs(x.value)); let out = ''; for (let i = 0; i < digits.length; i += 1) { if (i && (digits.length - i) % 3 === 0) out += x.separator; out += digits[i]; } return result((negative ? '-' : '') + out); }, format: fmt },
  { name: 'fmtx.scientific', title: 'Scientific notation', description: 'Formats a finite number as mantissa×10^exponent with a fixed decimal count.', category: 'text', permission: 'read', tags: ['format', 'number'],
    parameters: object({ value: N, decimals: { ...INT, minimum: 0, maximum: 12, default: 4 } }), examples: [{ args: { value: 12345, decimals: 2 }, expect: '1.23e+4' }],
    async run(x) { return result(x.value.toExponential(x.decimals)); }, format: fmt },
  { name: 'fmtx.compact', title: 'Compact number', description: 'Short K/M/B/T representation with one decimal, used for dashboards.', category: 'text', permission: 'read', tags: ['format', 'number'],
    parameters: object({ value: N }), examples: [{ args: { value: 1530 }, expect: '1.5K' }],
    async run(x) { const abs = Math.abs(x.value); if (abs >= 1e12) return result(`${Number((x.value / 1e12).toFixed(1))}T`); if (abs >= 1e9) return result(`${Number((x.value / 1e9).toFixed(1))}B`); if (abs >= 1e6) return result(`${Number((x.value / 1e6).toFixed(1))}M`); if (abs >= 1e3) return result(`${Number((x.value / 1e3).toFixed(1))}K`); return result(String(Number(x.value.toFixed(1)))); }, format: fmt },
  { name: 'fmtx.bullet_list', title: 'Bullet list', description: 'Formats string items as a Markdown bullet list, escaping newlines inside items.', category: 'text', permission: 'read', tags: ['format', 'markdown'],
    parameters: object({ items: { type: 'array', items: { type: 'string', maxLength: 500 }, minItems: 1, maxItems: 200 } }), examples: [{ args: { items: ['a', 'b'] }, expect: '- a\n- b' }],
    async run(x) { return result(x.items.map((item) => `- ${item.replace(/\s*\n\s*/g, ' ')}`).join('\n')); }, format: fmt },
  { name: 'fmtx.table_markdown', title: 'Markdown table', description: 'Renders rows as a Markdown table with escaped pipes and a header separator.', category: 'text', permission: 'read', tags: ['format', 'markdown'],
    parameters: object({ headers: { type: 'array', items: { type: 'string', maxLength: 100 }, minItems: 1, maxItems: 30 }, rows: { type: 'array', items: { type: 'array', items: {}, minItems: 1, maxItems: 30 }, maxItems: 200 } }), examples: [{ args: { headers: ['a', 'b'], rows: [[1, 2]] }, expect: '| a | b |\n| --- | --- |\n| 1 | 2 |' }],
    async run(x) { const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' '); if (x.rows.some((row) => row.length !== x.headers.length)) throw Object.assign(new Error('every row must match the header width'), { code: 'BAD_TABLE' }); return result([`| ${x.headers.map(cell).join(' | ')} |`, `| ${x.headers.map(() => '---').join(' | ')} |`, ...x.rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')); }, format: fmt },
  { name: 'fmtx.csv_quote', title: 'Quote a CSV field', description: 'Quotes a field when it contains comma, quote or newline, doubling embedded quotes.', category: 'text', permission: 'read', tags: ['format', 'csv'],
    parameters: object({ text: { type: 'string', maxLength: 100000 } }), examples: [{ args: { text: 'a,b' }, expect: '"a,b"' }],
    async run(x) { return result(/[",\n\r]/.test(x.text) ? `"${x.text.replace(/"/g, '""')}"` : x.text); }, format: fmt },
];
