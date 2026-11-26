'use strict';

/**
 * A deliberately small, dependency-free calendaring layer.
 *
 * The goal is not to reimplement every RFC 5545 edge case. It is to import
 * real calendar text without silently losing or inventing meaning:
 *
 *   • every event keeps its UID and source, so a later correction is possible;
 *   • unresolved TZID values are labelled, never guessed;
 *   • recurring events are expanded only for DAILY/WEEKLY/MONTHLY rules with
 *     INTERVAL/COUNT/UNTIL (and BYDAY for weekly rules);
 *   • malformed events are reported per line, and valid events still import.
 *
 * Times are stored as epoch milliseconds. All-day events use midnight UTC.
 */

const crypto = require('node:crypto');

const LIMITS = { textBytes: 2 * 1024 * 1024, events: 5000, occurrences: 1000, summary: 500, description: 4000 };
const DAY = 86400000;

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescape(value) {
  return String(value)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Parses a DATE or DATE-TIME value. Floating time is explicitly reported. */
function parseDate(raw) {
  const value = String(raw || '').trim();
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return { ms, allDay: true, utc: true, floating: false };
  }
  match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])];
  const ms = match[7] ? Date.UTC(...parts) : new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime();
  if (!Number.isFinite(ms)) return null;
  return { ms, allDay: false, utc: Boolean(match[7]), floating: !match[7] };
}

function formatDate(ms, allDay = false) {
  const date = new Date(ms);
  if (allDay) return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function splitProperty(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...params] = left.split(';');
  const parsed = {};
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq > 0) parsed[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params: parsed, value };
}

function stableId(seed) {
  return `cal_${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)}`;
}

function parseRRule(value) {
  const out = { raw: String(value || '') };
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(out.FREQ)) return { ...out, supported: false };
  return {
    ...out,
    supported: true,
    interval: Math.max(1, Number(out.INTERVAL) || 1),
    count: out.COUNT ? Math.max(1, Number(out.COUNT) || 1) : null,
    until: out.UNTIL ? (parseDate(out.UNTIL) || {}).ms || null : null,
    byDay: out.BYDAY ? out.BYDAY.split(',').filter(Boolean) : [],
  };
}

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function* repeatStarts(event, rangeStart, rangeEnd) {
  const base = event.start;
  if (!event.rrule || !event.rrule.supported) {
    if (base <= rangeEnd && (event.end || base) >= rangeStart) yield base;
    return;
  }
  const rule = event.rrule;
  let emitted = 0;
  let steps = 0;
  const maxSteps = 10000;
  if (rule.FREQ === 'DAILY') {
    let cursor = base;
    while (steps < maxSteps) {
      steps += 1;
      if (rule.count && emitted >= rule.count) break;
      if (rule.until && cursor > rule.until) break;
      if (cursor > rangeEnd) break;
      if (cursor + (event.end - base) >= rangeStart) { emitted += 1; yield cursor; }
      cursor += rule.interval * DAY;
    }
    return;
  }
  if (rule.FREQ === 'WEEKLY') {
    const days = rule.byDay.length ? rule.byDay.map((day) => WEEKDAY[day]).filter((day) => day !== undefined) : [new Date(base).getUTCDay()];
    const weekStart = base - new Date(base).getUTCDay() * DAY;
    for (let week = 0; steps < maxSteps; week += rule.interval) {
      let progressed = false;
      for (const day of days.sort((a, b) => a - b)) {
        const cursor = weekStart + week * DAY + day * DAY;
        if (cursor < base) continue;
        if (rule.until && cursor > rule.until) return;
        if (cursor > rangeEnd) return;
        if (rule.count && generated >= rule.count) return;
        generated += 1;
        if (cursor + (event.end - base) >= rangeStart) { emitted += 1; yield cursor; }
        progressed = true;
        steps += 1;
        if (steps >= maxSteps) return;
      }
      if (!progressed && week * DAY > 370 * DAY) return;
    }
    return;
  }
  // MONTHLY keeps the day-of-month; months without that day are skipped,
  // which is what a user expects from "the 31st".
  const baseDate = new Date(base);
  let cursor = base;
  while (steps < maxSteps) {
    steps += 1;
    if (rule.count && generated >= rule.count) break;
    if (rule.until && cursor > rule.until) break;
    if (cursor > rangeEnd) break;
    generated += 1;
    if (cursor + (event.end - base) >= rangeStart) { emitted += 1; yield cursor; }
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + rule.interval);
    if (next.getUTCDate() !== baseDate.getUTCDate()) break;
    cursor = next.getTime();
  }
}

class CalendarStore {
  constructor({ store = null, now = () => Date.now(), maxEvents = LIMITS.events } = {}) {
    this.store = store;
    this.now = now;
    this.maxEvents = Math.max(1, Math.min(LIMITS.events, Number(maxEvents) || LIMITS.events));
    this.events = new Map();
    this.load();
  }

  load() {
    if (!this.store || typeof this.store.list !== 'function') return;
    for (const record of this.store.list('calendar', { limit: this.maxEvents })) {
      if (record && record.id && Number.isFinite(record.start)) this.events.set(record.id, record);
    }
  }

  persist(event) {
    this.events.set(event.id, event);
    if (this.store && typeof this.store.put === 'function') this.store.put('calendar', event.id, event);
  }

  add(input = {}, { source = 'manual' } = {}) {
    const summary = String(input.summary || '').trim();
    const startMs = typeof input.start === 'string' ? Date.parse(input.start) : Number(input.start);
    if (!Number.isFinite(startMs)) return { ok: false, code: 'BAD_START', message: 'start must be epoch milliseconds or an ISO date' };
    if (!summary) return { ok: false, code: 'BAD_SUMMARY', message: 'an event needs a summary' };
    if (summary.length > LIMITS.summary) return { ok: false, code: 'BAD_SUMMARY', message: 'summary is too long' };
    const duration = Math.max(0, Number(input.durationMs) || 0);
    const end = Number.isFinite(Number(input.end)) ? Number(input.end) : startMs + duration;
    if (end < startMs) return { ok: false, code: 'BAD_END', message: 'end precedes start' };
    const uid = String(input.uid || stableId(`${summary}|${startMs}|${source}`)).slice(0, 200);
    const event = {
      id: input.id || stableId(uid),
      uid,
      summary,
      description: String(input.description || '').slice(0, LIMITS.description),
      location: String(input.location || '').slice(0, 300),
      start: startMs,
      end,
      allDay: input.allDay === true,
      rrule: input.rrule ? parseRRule(input.rrule) : null,
      timezone: input.timezone || null,
      source: String(source).slice(0, 40),
      updatedAt: this.now(),
    };
    if (this.events.size >= this.maxEvents && !this.events.has(event.id)) return { ok: false, code: 'CALENDAR_FULL', message: `calendar is limited to ${this.maxEvents} events` };
    this.persist(event);
    return { ok: true, event };
  }

  importIcs(text) {
    if (Buffer.byteLength(String(text || ''), 'utf8') > LIMITS.textBytes) return { ok: false, code: 'TOO_LARGE', message: 'calendar text exceeds 2 MB' };
    const lines = unfold(text).split('\n');
    const parsed = [];
    const errors = [];
    let current = null;
    let calendarName = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const property = splitProperty(line);
      if (!property) { errors.push({ line: index + 1, reason: 'not a property' }); continue; }
      const { name, params, value } = property;
      if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') { current = { line: index + 1, props: {} }; continue; }
      if (name === 'END' && value.toUpperCase() === 'VEVENT') {
        if (!current) { errors.push({ line: index + 1, reason: 'END:VEVENT without BEGIN' }); continue; }
        const start = parseDate(current.props.DTSTART && current.props.DTSTART.value);
        if (!start) { errors.push({ line: current.line, reason: 'missing or invalid DTSTART' }); current = null; continue; }
        const end = parseDate(current.props.DTEND && current.props.DTEND.value);
        const summary = unescape(current.props.SUMMARY ? current.props.SUMMARY.value : '');
        if (!summary) { errors.push({ line: current.line, reason: 'missing SUMMARY' }); current = null; continue; }
        parsed.push({
          uid: current.props.UID ? unescape(current.props.UID.value) : null,
          summary,
          description: current.props.DESCRIPTION ? unescape(current.props.DESCRIPTION.value) : '',
          location: current.props.LOCATION ? unescape(current.props.LOCATION.value) : '',
          start: start.ms,
          end: end ? end.ms : start.ms + (start.allDay ? DAY : 0),
          allDay: start.allDay,
          floating: start.floating,
          timezone: current.props.DTSTART && current.props.DTSTART.params.TZID ? current.props.DTSTART.params.TZID : null,
          rrule: current.props.RRULE ? current.props.RRULE.value : null,
          line: current.line,
        });
        current = null;
        continue;
      }
      if (name === 'X-WR-CALNAME' && !current) { calendarName = unescape(value); continue; }
      if (current && name !== 'BEGIN' && name !== 'END') current.props[name] = { value, params };
    }
    if (current) errors.push({ line: current.line, reason: 'VEVENT was not closed' });
    let imported = 0;
    let updated = 0;
    let unchanged = 0;
    for (const event of parsed.slice(0, this.maxEvents)) {
      const uid = event.uid || stableId(`${event.summary}|${event.start}|ics`);
      const existing = [...this.events.values()].find((entry) => entry.uid === uid) || null;
      const same = existing && existing.summary === event.summary && existing.start === event.start && existing.end === event.end && existing.description === event.description && existing.location === event.location && existing.allDay === event.allDay;
      const result = this.add({ ...event, id: existing ? existing.id : undefined, uid }, { source: 'ics' });
      if (result.ok) { if (same) unchanged += 1; else if (existing) updated += 1; else imported += 1; }
      else errors.push({ line: event.line, reason: result.message });
    }
    if (parsed.length > this.maxEvents) errors.push({ line: 0, reason: `only the first ${this.maxEvents} events were imported` });
    return { ok: errors.length === 0 || imported + updated + unchanged > 0, imported, updated, unchanged, skipped: parsed.length - imported - updated - unchanged, errors: errors.slice(0, 25), calendarName, total: this.events.size };
  }

  upcoming({ from = this.now(), to = from + 7 * DAY, limit = 50 } = {}) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const out = [];
    for (const event of this.events.values()) {
      for (const occurrence of repeatStarts(event, start, end)) {
        out.push({ ...event, start: occurrence, end: occurrence + (event.end - event.start), occurrence: occurrence !== event.start });
        if (out.length >= LIMITS.occurrences) break;
      }
      if (out.length >= LIMITS.occurrences) break;
    }
    return out.sort((a, b) => a.start - b.start).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  exportIcs({ from = this.now(), to = from + 30 * DAY, limit = 500 } = {}) {
    const events = this.upcoming({ from, to, limit });
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SENTINEL//Calendar 7.1//EN', 'CALSCALE:GREGORIAN'];
    for (const event of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${event.occurrence ? `${event.uid}-${event.start}` : event.uid}`);
      lines.push(`DTSTAMP:${formatDate(event.updatedAt || this.now())}`);
      lines.push(`DTSTART${event.allDay ? ';VALUE=DATE' : ''}:${formatDate(event.start, event.allDay)}`);
      lines.push(`DTEND${event.allDay ? ';VALUE=DATE' : ''}:${formatDate(event.end, event.allDay)}`);
      lines.push(`SUMMARY:${escapeText(event.summary)}`);
      if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
      if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
      if (event.rrule && event.rrule.raw && event.occurrence !== true) lines.push(`RRULE:${event.rrule.raw}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
  }

  remove(id) {
    const existed = this.events.delete(id);
    if (existed && this.store && typeof this.store.delete === 'function') this.store.delete('calendar', id);
    return existed;
  }

  status() {
    return {
      ok: true,
      events: this.events.size,
      upcoming24h: this.upcoming({ from: this.now(), to: this.now() + DAY, limit: 200 }).length,
      sources: [...new Set([...this.events.values()].map((event) => event.source))].sort(),
      limits: LIMITS,
    };
  }
}

module.exports = { CalendarStore, parseIcs: (text, options = {}) => {
  const calendar = new CalendarStore({ now: options.now || (() => Date.now()) });
  const result = calendar.importIcs(text);
  return { ...result, events: [...calendar.events.values()], calendar };
}, parseDate, formatDate, parseRRule, escapeText, LIMITS };
