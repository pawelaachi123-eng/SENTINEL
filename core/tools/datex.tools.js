'use strict';

/**
 * Date arithmetic in UTC.
 *
 * Calendar-local time zones are a separate problem; these tools deliberately
 * operate on UTC instants and say so in their descriptions. Inputs accept ISO
 * strings or epoch milliseconds. Invalid dates fail instead of rolling over.
 */

const DAY = 86400000;
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const DATE = { description: 'ISO 8601 date/time or epoch milliseconds' };
const result = (value, extra = {}) => ({ ok: true, value, ...extra });
const fmt = (data) => (typeof data.value === 'string' ? data.value : JSON.stringify(data.value).slice(0, 240));

function parse(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw Object.assign(new Error(`invalid date: ${value}`), { code: 'BAD_DATE' });
  return parsed;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function startOfDay(ms) {
  return Math.floor(ms / DAY) * DAY;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(ms, months) {
  const date = new Date(ms);
  const targetMonth = date.getUTCMonth() + Math.trunc(months);
  const year = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
}

function timezone(name) {
  return { value: name, offsetMinutes: 0, note: 'not computed locally; UTC-only tool' };
}

const tools = [
  { name: 'datex.add_days', title: 'Add days', description: 'Adds a whole number of 24-hour days to a UTC instant.', category: 'time', permission: 'read', tags: ['date', 'arithmetic', 'utc'],
    parameters: object({ date: DATE, days: { type: 'integer', minimum: -1000000, maximum: 1000000 } }), examples: [{ args: { date: '2026-01-01T00:00:00Z', days: 30 }, expect: '2026-01-31T00:00:00.000Z' }],
    async run(a) { return { ok: true, value: iso(parse(a.date) + a.days * DAY), ms: parse(a.date) + a.days * DAY }; }, format: fmt },
  { name: 'datex.add_hours', title: 'Add hours', description: 'Adds hours to a UTC instant, including fractional hours.', category: 'time', permission: 'read', tags: ['date', 'arithmetic', 'utc'],
    parameters: object({ date: DATE, hours: { type: 'number', minimum: -1000000, maximum: 1000000 } }), examples: [{ args: { date: '2026-01-01T00:00:00Z', hours: 1.5 }, expect: '2026-01-01T01:30:00.000Z' }],
    async run(a) { return { ok: true, value: iso(parse(a.date) + a.hours * 3600000) }; }, format: fmt },
  { name: 'datex.add_months', title: 'Add months (clamped)', description: 'Adds calendar months in UTC, clamping 31 January + 1 month to 28/29 February.', category: 'time', permission: 'read', tags: ['date', 'arithmetic', 'calendar'],
    parameters: object({ date: DATE, months: { type: 'integer', minimum: -12000, maximum: 12000 } }), examples: [{ args: { date: '2026-01-31T12:00:00Z', months: 1 }, expect: '2026-02-28T12:00:00.000Z' }],
    async run(a) { return { ok: true, value: iso(addMonthsClamped(parse(a.date), a.months)) }; }, format: fmt },
  { name: 'datex.diff_days', title: 'Difference in days', description: 'Number of complete 24-hour days from the first instant to the second; may be negative.', category: 'time', permission: 'read', tags: ['date', 'difference'],
    parameters: object({ from: DATE, to: DATE }), examples: [{ args: { from: '2026-01-01T00:00:00Z', to: '2026-01-11T00:00:00Z' }, expect: 10 }],
    async run(a) { return result(Math.trunc((parse(a.to) - parse(a.from)) / DAY)); }, format: fmt },
  { name: 'datex.diff_ms', title: 'Difference in milliseconds', description: 'Exact millisecond difference between two UTC instants.', category: 'time', permission: 'read', tags: ['date', 'difference'],
    parameters: object({ from: DATE, to: DATE }), examples: [{ args: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:01Z' }, expect: 1000 }],
    async run(a) { return result(parse(a.to) - parse(a.from)); }, format: fmt },
  { name: 'datex.start_of_day', title: 'Start of UTC day', description: 'Midnight UTC of the day containing the instant.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-04T19:30:00Z' }, expect: '2026-03-04T00:00:00.000Z' }],
    async run(a) { return { ok: true, value: iso(startOfDay(parse(a.date))) }; }, format: fmt },
  { name: 'datex.end_of_day', title: 'End of UTC day', description: 'Instant 1 ms before the next UTC midnight.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-04T19:30:00Z' }, expect: '2026-03-04T23:59:59.999Z' }],
    async run(a) { return { ok: true, value: iso(startOfDay(parse(a.date)) + DAY - 1) }; }, format: fmt },
  { name: 'datex.start_of_week', title: 'Start of ISO week', description: 'Monday 00:00 UTC of the ISO week containing the date.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-04T19:30:00Z' }, expect: '2026-03-02T00:00:00.000Z' }],
    async run(a) { const ms = parse(a.date); const day = new Date(ms).getUTCDay(); return { ok: true, value: iso(startOfDay(ms) - ((day + 6) % 7) * DAY) }; }, format: fmt },
  { name: 'datex.start_of_month', title: 'Start of month', description: 'First day of the UTC month at 00:00:00.000.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-19T19:30:00Z' }, expect: '2026-03-01T00:00:00.000Z' }],
    async run(a) { const d = new Date(parse(a.date)); return { ok: true, value: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }; }, format: fmt },
  { name: 'datex.end_of_month', title: 'End of month', description: 'Last millisecond of the UTC calendar month.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-02-10T00:00:00Z' }, expect: '2026-02-28T23:59:59.999Z' }],
    async run(a) { const d = new Date(parse(a.date)); return { ok: true, value: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1) }; }, format: fmt },
  { name: 'datex.start_of_year', title: 'Start of year', description: 'First day of the UTC calendar year at midnight.', category: 'time', permission: 'read', tags: ['date', 'boundary'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-19T19:30:00Z' }, expect: '2026-01-01T00:00:00.000Z' }],
    async run(a) { const d = new Date(parse(a.date)); return { ok: true, value: iso(Date.UTC(d.getUTCFullYear(), 0, 1)) }; }, format: fmt },
  { name: 'datex.day_of_week', title: 'Day of week', description: 'ISO weekday number: Monday=1 through Sunday=7.', category: 'time', permission: 'read', tags: ['date', 'calendar'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-02T00:00:00Z' }, expect: 1 }],
    async run(a) { const day = new Date(parse(a.date)).getUTCDay(); return result(day === 0 ? 7 : day); }, format: fmt },
  { name: 'datex.day_of_year', title: 'Day of year', description: 'Ordinal day within the UTC year, from 1 to 365 or 366.', category: 'time', permission: 'read', tags: ['date', 'calendar'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-02-01T00:00:00Z' }, expect: 32 }],
    async run(a) { const d = new Date(parse(a.date)); return result(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1); }, format: fmt },
  { name: 'datex.iso_week', title: 'ISO week number', description: 'ISO-8601 week number and week-year, computed from the Thursday rule.', category: 'time', permission: 'read', tags: ['date', 'calendar', 'iso'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-01-01T00:00:00Z' }, expect: { week: 1, year: 2026 } }],
    async run(a) {
      const d = new Date(parse(a.date));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
      return { ok: true, week, year: d.getUTCFullYear() };
    }, format: (data) => `${data.year}-W${String(data.week).padStart(2, '0')}` },
  { name: 'datex.quarter', title: 'Calendar quarter', description: 'Calendar quarter from 1 to 4 for the UTC month.', category: 'time', permission: 'read', tags: ['date', 'calendar'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-05-01T00:00:00Z' }, expect: 2 }],
    async run(a) { return result(Math.floor(new Date(parse(a.date)).getUTCMonth() / 3) + 1); }, format: fmt },
  { name: 'datex.is_leap_year', title: 'Leap year test', description: 'Gregorian leap-year rule, including the 100/400 exceptions.', category: 'time', permission: 'read', tags: ['date', 'calendar'],
    parameters: object({ year: { type: 'integer', minimum: -9999, maximum: 9999 } }), examples: [{ args: { year: 2024 }, expect: true }],
    async run(a) { return result((a.year % 4 === 0 && a.year % 100 !== 0) || a.year % 400 === 0); }, format: fmt },
  { name: 'datex.days_in_month', title: 'Days in month', description: 'Number of days in a Gregorian month; month is 1–12.', category: 'time', permission: 'read', tags: ['date', 'calendar'],
    parameters: object({ year: { type: 'integer', minimum: -9999, maximum: 9999 }, month: { type: 'integer', minimum: 1, maximum: 12 } }),
    examples: [{ args: { year: 2024, month: 2 }, expect: 29 }],
    async run(a) { return result(daysInMonth(a.year, a.month - 1)); }, format: fmt },
  { name: 'datex.age', title: 'Age in complete years', description: 'Whole years between a birth date and a reference date, birthday-aware in UTC.', category: 'time', permission: 'read', tags: ['date', 'age'],
    parameters: object({ birth: DATE, at: DATE }), examples: [{ args: { birth: '2000-06-15T00:00:00Z', at: '2026-06-14T00:00:00Z' }, expect: 25 }],
    async run(a) {
      const birth = new Date(parse(a.birth)); const at = new Date(parse(a.at));
      let age = at.getUTCFullYear() - birth.getUTCFullYear();
      const beforeBirthday = at.getUTCMonth() < birth.getUTCMonth() || (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate());
      if (beforeBirthday) age -= 1;
      if (age < 0) throw Object.assign(new Error('reference date precedes birth date'), { code: 'BAD_RANGE' });
      return result(age);
    }, format: fmt },
  { name: 'datex.business_days_between', title: 'Business days between', description: 'Counts Monday–Friday days from the start date (inclusive) to the end date (exclusive); public holidays are not assumed.', category: 'time', permission: 'read', tags: ['date', 'business'],
    parameters: object({ from: DATE, to: DATE }), examples: [{ args: { from: '2026-03-02T00:00:00Z', to: '2026-03-07T00:00:00Z' }, expect: 5 }],
    async run(a) {
      let start = startOfDay(parse(a.from)); const end = startOfDay(parse(a.to));
      if (end < start) throw Object.assign(new Error('end precedes start'), { code: 'BAD_RANGE' });
      let count = 0;
      while (start < end) { const day = new Date(start).getUTCDay(); if (day !== 0 && day !== 6) count += 1; start += DAY; }
      return result(count);
    }, format: fmt },
  { name: 'datex.add_business_days', title: 'Add business days', description: 'Moves forward by Monday–Friday days; holidays are not invented.', category: 'time', permission: 'read', tags: ['date', 'business'],
    parameters: object({ date: DATE, days: { type: 'integer', minimum: 0, maximum: 10000 } }), examples: [{ args: { date: '2026-03-06T00:00:00Z', days: 1 }, expect: '2026-03-09T00:00:00.000Z' }],
    async run(a) { let ms = parse(a.date); let left = a.days; while (left > 0) { ms += DAY; const day = new Date(ms).getUTCDay(); if (day !== 0 && day !== 6) left -= 1; } return { ok: true, value: iso(ms) }; }, format: fmt },
  { name: 'datex.next_weekday', title: 'Next weekday', description: 'First Monday–Friday at or after the given instant, preserving the time of day.', category: 'time', permission: 'read', tags: ['date', 'business'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '2026-03-07T10:00:00Z' }, expect: '2026-03-09T10:00:00.000Z' }],
    async run(a) { let ms = parse(a.date); while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY; return { ok: true, value: iso(ms) }; }, format: fmt },
  { name: 'datex.to_unix', title: 'To Unix seconds', description: 'Whole Unix seconds since 1970-01-01T00:00:00Z, floored for negative instants.', category: 'time', permission: 'read', tags: ['date', 'unix'],
    parameters: object({ date: DATE }), examples: [{ args: { date: '1970-01-01T00:00:01Z' }, expect: 1 }],
    async run(a) { return result(Math.floor(parse(a.date) / 1000)); }, format: fmt },
  { name: 'datex.from_unix', title: 'From Unix seconds', description: 'Converts Unix seconds to an ISO UTC instant.', category: 'time', permission: 'read', tags: ['date', 'unix'],
    parameters: object({ seconds: { type: 'number', minimum: -100000000000, maximum: 100000000000 } }), examples: [{ args: { seconds: 1 }, expect: '1970-01-01T00:00:01.000Z' }],
    async run(a) { return { ok: true, value: iso(a.seconds * 1000) }; }, format: fmt },
  { name: 'datex.range_overlaps', title: 'Intervals overlap', description: 'Half-open interval overlap test; touching endpoints do not count as overlap.', category: 'time', permission: 'read', tags: ['date', 'interval'],
    parameters: object({ startA: DATE, endA: DATE, startB: DATE, endB: DATE }),
    examples: [{ args: { startA: '2026-01-01T00:00:00Z', endA: '2026-01-02T00:00:00Z', startB: '2026-01-02T00:00:00Z', endB: '2026-01-03T00:00:00Z' }, expect: false }],
    async run(a) { const sa = parse(a.startA); const ea = parse(a.endA); const sb = parse(a.startB); const eb = parse(a.endB); if (ea < sa || eb < sb) throw Object.assign(new Error('end precedes start'), { code: 'BAD_RANGE' }); return result(sa < eb && sb < ea); }, format: fmt },
  { name: 'datex.easter_sunday', title: 'Easter Sunday (Gregorian)', description: 'Anonymous Gregorian algorithm; returns an ISO date.', category: 'time', permission: 'read', tags: ['date', 'calendar', 'holiday'],
    parameters: object({ year: { type: 'integer', minimum: 1583, maximum: 4099 } }), examples: [{ args: { year: 2026 }, expect: '2026-04-05' }],
    async run(a) {
      const y = a.year; const g = y % 19; const c = Math.floor(y / 100); const h = (c - Math.floor(c / 4) - Math.floor((8 * c + 13) / 25) + 19 * g + 15) % 30;
      const i = h - Math.floor(h / 28) * (1 - Math.floor(h / 28) * Math.floor(29 / (h + 1)) * Math.floor((21 - g) / 11));
      const j = (y + Math.floor(y / 4) + i + 2 - c + Math.floor(c / 4)) % 7;
      const l = i - j; const month = 3 + Math.floor((l + 40) / 44); const day = l + 28 - 31 * Math.floor(month / 4);
      return { ok: true, value: `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }, format: fmt },
];
module.exports = tools;
