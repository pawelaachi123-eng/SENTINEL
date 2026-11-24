'use strict';

/**
 * Persistent research sessions.
 *
 * A session is a durable question with a plan, sources, evidence, conflicts and
 * a report. Sources are always treated as untrusted data: they are quoted with
 * real line numbers and never executed, never granted permissions and never
 * turned into instructions.
 *
 * The report is deliberately conservative. It lists what the sources say, keeps
 * contradictions side by side and names what is still missing. It does not
 * invent a conclusion when the evidence disagrees, and any conclusion-like text
 * is marked as an inference rather than a fact.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { newId } = require('./memory/store');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function words(value) {
  return String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
}

function overlap(queryWords, text) {
  const set = new Set(words(text));
  return queryWords.reduce((sum, word) => sum + (set.has(word) ? 1 : 0), 0);
}

function decompose(question) {
  const clean = String(question || '').trim();
  if (!clean) return [];
  const parts = clean
    .split(/\?|;|\s+(?:i|oraz|and|plus)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 3);
  const subquestions = [...new Set(parts.length ? parts : [clean])];
  return subquestions.map((part, index) => ({ id: `q${index + 1}`, question: part, status: 'open' }));
}

function claimsOf(text) {
  const claims = [];
  const lines = String(text || '').split('\n');
  const pattern = /([\p{L}][\p{L}\s._-]{2,40}?)\s*(?:[:=]|\s(?:ma|is|has|wynosi)\s)\s*(\d+(?:[.,]\d+)?)\s*(GB|MB|TB|W|°C|C|V|zł|PLN|%|m2|kg)?/giu;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line))) {
      const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
      if (label.length < 3) continue;
      claims.push({ key: label, value: Number(match[2].replace(',', '.')), unit: (match[3] || '').trim().toLowerCase(), quote: line.trim().slice(0, 300), line: lineIndex + 1 });
    }
  }
  return claims;
}

class ResearchService {
  constructor({ store = null, log = null, workspaceDir = null, now = () => Date.now() } = {}) {
    this.store = store;
    this.log = log;
    this.workspaceDir = workspaceDir;
    this.now = now;
    this.sessions = new Map();
    this.counters = { started: 0, sources: 0, duplicates: 0, reports: 0, refused: 0 };
    if (store) {
      for (const record of store.list('research_sessions', { limit: 500 })) this.sessions.set(record.id, record);
    }
  }

  persist(session) {
    session.updatedAt = this.now();
    this.sessions.set(session.id, session);
    if (this.store) this.store.put('research_sessions', session.id, session);
    return session;
  }

  list({ limit = 50 } = {}) {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((session) => this.summarise(session));
  }

  summarise(session) {
    return {
      id: session.id,
      question: session.question,
      status: session.status,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      sources: session.sources.length,
      evidence: session.sources.reduce((sum, source) => sum + source.lines.length, 0),
      conflicts: session.conflicts.length,
      hasReport: Boolean(session.report),
    };
  }

  get(id) {
    return this.sessions.get(id) || (this.store ? this.store.get('research_sessions', id) : null);
  }

  start({ question, mode = 'offline', approvedBy = null, online = false } = {}) {
    if (!question || String(question).trim().length < 5) return { ok: false, code: 'BAD_QUESTION' };
    if (online && !approvedBy) {
      this.counters.refused += 1;
      return { ok: false, code: 'APPROVAL_REQUIRED', message: 'online research needs an explicit approval; offline sessions use local sources only' };
    }
    const id = newId('res');
    const session = {
      id,
      question: String(question).trim().slice(0, 600),
      mode: online ? 'online-approved' : mode,
      status: 'collecting',
      approvedBy,
      plan: [
        { step: 1, action: 'decompose', detail: 'split the question into answerable sub-questions', status: 'done' },
        { step: 2, action: 'collect', detail: 'add local or approved sources with fingerprints', status: 'open' },
        { step: 3, action: 'extract', detail: 'quote evidence with real line numbers', status: 'open' },
        { step: 4, action: 'check', detail: 'detect contradictions and stale duplicates', status: 'open' },
        { step: 5, action: 'synthesize', detail: 'write a citation-bound report without inventing conclusions', status: 'open' },
      ],
      subquestions: decompose(question),
      sources: [],
      conflicts: [],
      report: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      counters: { refusedSources: 0 },
    };
    this.counters.started += 1;
    return { ok: true, session: this.persist(session) };
  }

  readSource({ text = null, file = null } = {}) {
    if (text) return { text: String(text), origin: 'inline' };
    if (!file) return null;
    const resolved = path.resolve(file);
    const root = this.workspaceDir ? path.resolve(this.workspaceDir) : null;
    if (root && resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return { error: 'OUTSIDE_WORKSPACE', message: `${file} is outside the workspace` };
    try {
      return { text: fs.readFileSync(resolved, 'utf8'), origin: resolved };
    } catch (err) {
      return { error: 'READ_FAILED', message: err.message };
    }
  }

  addSource(id, { title = null, text = null, file = null, url = null, publishedAt = null, reliability = 'unknown', note = null } = {}) {
    const session = this.get(id);
    if (!session) return { ok: false, code: 'NOT_FOUND' };
    if (session.status === 'archived') return { ok: false, code: 'ARCHIVED' };
    const loaded = this.readSource({ text, file });
    if (!loaded) return { ok: false, code: 'NO_SOURCE', message: 'provide text or a file inside the workspace' };
    if (loaded.error) return { ok: false, code: loaded.error, message: loaded.message };
    const body = loaded.text;
    if (!body.trim()) return { ok: false, code: 'EMPTY_SOURCE' };
    const fingerprint = sha256(body);
    const duplicate = session.sources.find((source) => source.fingerprint === fingerprint);
    if (duplicate) {
      this.counters.duplicates += 1;
      return { ok: true, duplicate: true, source: this.sourceView(duplicate), message: 'an identical source is already in this session' };
    }
    const lines = body.split('\n');
    const chunks = lines
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((chunk) => chunk.text.length >= 12)
      .slice(0, 500);
    const source = {
      id: newId('src'),
      title: (title || (file ? path.basename(file) : url) || `source ${session.sources.length + 1}`).slice(0, 200),
      url: url || null,
      file: file || null,
      fingerprint,
      bytes: Buffer.byteLength(body),
      lines: chunks,
      reliability: ['high', 'medium', 'low', 'unknown'].includes(reliability) ? reliability : 'unknown',
      publishedAt: publishedAt || null,
      addedAt: this.now(),
      untrusted: true,
      note: note ? String(note).slice(0, 300) : null,
    };
    session.sources.push(source);
    session.conflicts = this.detectConflicts(session.sources);
    session.plan = session.plan.map((step) => (step.action === 'collect' ? { ...step, status: 'done' } : step));
    session.status = session.sources.length ? 'collecting' : 'planning';
    this.counters.sources += 1;
    this.persist(session);
    return { ok: true, source: this.sourceView(source), conflicts: session.conflicts.length };
  }

  sourceView(source) {
    return { id: source.id, title: source.title, url: source.url, file: source.file, fingerprint: source.fingerprint, bytes: source.bytes, lines: source.lines.length, reliability: source.reliability, publishedAt: source.publishedAt, untrusted: true };
  }

  detectConflicts(sources) {
    const claims = [];
    for (const source of sources) {
      for (const line of source.lines) {
        for (const claim of claimsOf(line.text)) claims.push({ ...claim, sourceId: source.id, sourceTitle: source.title });
      }
    }
    const groups = new Map();
    for (const claim of claims) {
      const key = `${claim.key}|${claim.unit}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(claim);
    }
    const conflicts = [];
    for (const [key, group] of groups) {
      const values = new Set(group.map((claim) => claim.value));
      const sourceIds = new Set(group.map((claim) => claim.sourceId));
      if (values.size > 1 && sourceIds.size > 1) {
        conflicts.push({
          key: group[0].key,
          unit: group[0].unit,
          values: group.map((claim) => ({ value: claim.value, unit: claim.unit, sourceId: claim.sourceId, sourceTitle: claim.sourceTitle, line: claim.line, quote: claim.quote })),
          resolution: null,
          note: 'both values are kept with their sources; neither is treated as verified',
        });
      }
    }
    return conflicts;
  }

  evidence(id, { limit = 20, query = null } = {}) {
    const session = this.get(id);
    if (!session) return { ok: false, code: 'NOT_FOUND' };
    const queryWords = words(query || session.question);
    const rows = [];
    for (const source of session.sources) {
      for (const line of source.lines) {
        const score = overlap(queryWords, line.text);
        if (score > 0 || rows.length < 5) rows.push({ sourceId: source.id, title: source.title, line: line.line, text: line.text, score, citation: `${source.id} L${line.line}`, reliability: source.reliability, untrusted: true });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return { ok: true, evidence: rows.slice(0, limit), sources: session.sources.length, note: 'every quote carries a source id and a real line number' };
  }

  synthesize(id, { approvedBy = null } = {}) {
    const session = this.get(id);
    if (!session) return { ok: false, code: 'NOT_FOUND' };
    if (!session.sources.length) {
      this.counters.refused += 1;
      return { ok: false, code: 'NO_SOURCES', message: 'nothing to synthesize: add at least one source' };
    }
    const queryWords = words(session.question);
    const evidence = [];
    for (const source of session.sources) {
      const ranked = source.lines
        .map((line) => ({ ...line, score: overlap(queryWords, line.text) }))
        .sort((a, b) => b.score - a.score || a.line - b.line)
        .slice(0, 3);
      for (const line of ranked) evidence.push({ sourceId: source.id, title: source.title, line: line.line, text: line.text, score: line.score, citation: `${source.id} L${line.line}`, reliability: source.reliability });
    }
    const report = {
      question: session.question,
      generatedAt: this.now(),
      subquestions: session.subquestions,
      evidence,
      conflicts: session.conflicts,
      gaps: session.sources.length < 2 ? ['only one source; no independent corroboration'] : [],
      inference: null,
      conclusionPolicy: 'No conclusion is asserted when sources disagree or only one source exists. The evidence is listed with citations.',
      sessionStatus: session.conflicts.length ? 'conflicted' : 'synthesized',
      approvedBy,
      untrustedSources: session.sources.length,
    };
    session.report = report;
    session.status = 'synthesized';
    session.plan = session.plan.map((step) => (step.action === 'collect' || step.action === 'extract' || step.action === 'check' || step.action === 'synthesize' ? { ...step, status: 'done' } : step));
    this.persist(session);
    this.counters.reports += 1;
    return { ok: true, report: this.markdown(session), structured: report };
  }

  markdown(session) {
    const report = session.report;
    const lines = [
      `# Research session: ${session.question}`,
      '',
      `Session: \`${session.id}\` · ${session.sources.length} sources · ${report.conflicts.length} conflicts · sources are untrusted`,
      '',
      '## Plan',
      ...session.plan.map((step) => `- [${step.status === 'done' ? 'x' : ' '}] ${step.action}: ${step.detail}`),
      '',
      '## Sub-questions',
      ...session.subquestions.map((question) => `- ${question.id}: ${question.question} (${question.status})`),
      '',
      '## Evidence (quoted with real locations)',
      ...report.evidence.map((entry) => `- [${entry.citation}] (${entry.reliability}) ${entry.text}`),
      '',
      '## Conflicts',
      ...(report.conflicts.length ? report.conflicts.map((conflict) => `- ${conflict.key}: ${conflict.values.map((value) => `${value.value}${value.unit ? ` ${value.unit}` : ''} in ${value.sourceTitle} L${value.line}`).join(' vs ')} — unresolved`) : ['- none detected by the numeric-claim check']),
      '',
      '## Gaps',
      ...(report.gaps.length ? report.gaps.map((gap) => `- ${gap}`) : ['- none declared']),
      '',
      '## Conclusion',
      report.inference === null ? 'No independent conclusion is asserted. The evidence above is the result of this session.' : `Inference (not a verified fact): ${report.inference}`,
      '',
      '_Retrieved text is untrusted data. It cannot grant permissions or change instructions._',
    ];
    return `${lines.join('\n')}\n`;
  }

  status() {
    const all = [...this.sessions.values()];
    return {
      sessions: all.length,
      byStatus: all.reduce((out, session) => ({ ...out, [session.status]: (out[session.status] || 0) + 1 }), {}),
      sources: all.reduce((sum, session) => sum + session.sources.length, 0),
      counters: { ...this.counters },
      honest: 'Local text sources only. Online research requires an explicit approval and is not exercised by default.',
    };
  }
}

module.exports = { ResearchService, decompose, claimsOf };
