'use strict';

/**
 * Semantic interpretation, 4.0.
 *
 * The deterministic core in `cognition.js` stays the authority for anything a
 * machine must not guess: arithmetic, exact commands, permissions, budgets and
 * clarification of a truly empty request. This module adds what regexes cannot
 * do — Polish/English informal phrasing, corrections, follow-ups that only make
 * sense with conversation state, and a schema-validated model pass that is
 * *allowed to be wrong* and is merged conservatively.
 *
 * Merge rules (the important part):
 *   • deterministic COMPUTE and CLARIFY always win — a model cannot turn
 *     "ile to 2+2" into a retrieval task;
 *   • risk may only be raised by the model, never lowered;
 *   • constraints and acceptance criteria are unioned, not replaced;
 *   • budgets and modes are owned by the deterministic layer;
 *   • every model-derived field is labelled `semantic.source = 'hybrid'` and the
 *     raw interpretation is kept for audit.
 *
 * If the model is unavailable, the result is the deterministic brief plus
 * conversation resolution, with `degraded: true` — never a fabricated one.
 */

const {
  CognitiveCore,
  INTENTS,
  STRATEGIES,
  MODE_BUDGETS,
  estimateTokens,
  stripDiacritics,
} = require('./cognition');

const ALLOWED_INTENTS = new Set(Object.values(INTENTS));
const ALLOWED_STRATEGIES = new Set(Object.values(STRATEGIES));
const ALLOWED_KINDS = new Set(['information', 'planning', 'execution', 'review', 'conversation']);

/** Vocabulary used for spelling tolerance (Polish without diacritics included). */
const VOCAB = [
  'dysk', 'dysku', 'pamiec', 'pamięci', 'procesor', 'karta', 'graficzna', 'zasilacz', 'temperatura',
  'wentylator', 'system', 'windows', 'sterownik', 'sterowniki', 'aktualizacja', 'instalacja', 'folder',
  'plik', 'pliku', 'dokument', 'dokumenty', 'zdjecie', 'zdjęcie', 'ekran', 'klawiatura', 'mysz',
  'siec', 'sieć', 'internet', 'bateria', 'laptop', 'komputer', 'oprogramowanie', 'program', 'proces',
  'procesy', 'blad', 'błąd', 'log', 'logi', 'wydajnosc', 'wydajność', 'fps', 'grafika', 'monitor',
  'rozdzielczosc', 'yet', 'gpu', 'cpu', 'ram', 'vram', 'ssd', 'hdd', 'usb', 'audio', 'dzwiek',
  'dźwięk', 'mikrofon', 'kamera', 'drukarka', 'drukarke', 'drukarkę', 'gwarancja', 'gwarancji',
  'faktura', 'umowa', 'projekt', 'repozytorium', 'kod', 'funkcja', 'test', 'testy', 'bledy', 'błędy',
  'napraw', 'zainstaluj', 'odinstaluj', 'uruchom', 'otworz', 'otwórz', 'zamknij', 'usun', 'usuń',
  'skopiuj', 'przenies', 'przenieś', 'zmien', 'zmień', 'wylacz', 'wyłącz', 'wlacz', 'włącz',
  'zaplanuj', 'wyjasnij', 'wyjaśnij', 'porownaj', 'porównaj', 'sprawdz', 'sprawdź', 'znajdz', 'znajdź',
  'computer', 'memory', 'disk', 'drive', 'temperature', 'driver', 'update', 'install', 'folder',
  'file', 'document', 'screen', 'network', 'battery', 'performance', 'error', 'logs', 'project',
  'code', 'function', 'tests', 'fix', 'explain', 'compare', 'check', 'find', 'open', 'close',
];

const PL_STOPWORDS = new Set(['się', 'jest', 'nie', 'jak', 'czy', 'dla', 'oraz', 'ale', 'tak', 'już', 'jeszcze', 'tylko', 'bardzo', 'może', 'mi', 'mię', 'mnie', 'twoje', 'jaki', 'jaka', 'jakie', 'gdzie', 'kiedy', 'dlaczego', 'proszę', 'dzieki', 'dzięki', 'ile', 'co', 'to', 'mam', 'mój', 'moj', 'moja', 'moje', 'chcę', 'chce', 'potrzebuję', 'potrzebuje', 'chcesz', 'mogę', 'moge']);
const EN_STOPWORDS = new Set(['the', 'is', 'are', 'and', 'for', 'with', 'that', 'this', 'why', 'how', 'what', 'where', 'when', 'please', 'could', 'would', 'should', 'about', 'from', 'have', 'does', 'did', 'not']);

const REFERENCE_PATTERNS = [
  { kind: 'pronoun', re: /\b(to|tamto|ten|ta|te|tego|tej|tych|on|ona|ono|jego|jej|ich|it|that|this|those|these|them|its)\b/gi },
  { kind: 'previous', re: /\b(poprzedni\w*|wcześniejsz\w*|wczesniejsz\w*|ostatni\w*|previous|last|earlier|above|mentioned)\b/gi },
  { kind: 'repeat', re: /\b(jeszcze raz|ponownie|again|same as before|to samo)\b/gi },
  { kind: 'delta', re: /^(a|i|and)\s+(co|jak|ile|gdzie|kiedy|what|how|where|when)\b/i },
];

const CORRECTION_PATTERNS = [
  { kind: 'negation-correction', re: /^\s*(nie|no)[,.]?\s+(chodzi(ło)?\s+mi\s+o|mam\s+na\s+myśli|i\s+mean|actually)\s+(.+)$/i },
  { kind: 'restatement', re: /\b(chodzi(ło)?\s+mi\s+o|mam\s+na\s+myśli|i\s+meant|rather|raczej|a\s+właściwie|a\s+wlasciwie|zamiast)\b[:\s]+(.+)$/i },
  { kind: 'cancel-previous', re: /\b(nie\s+rób\s+tego|anuluj|stop|zapomnij|never\s+mind|nevermind|forget\s+it)\b/i },
];

const ACTION_VERBS = /\b(usuń|usun|skasuj|sformatuj|wyczyść|wyczysc|zabij|zamknij|wyłącz|wylacz|zrestartuj|restart|shutdown|delete|remove|format|wipe|kill|uninstall|odinstaluj|uruchom|otwórz|otworz|open|launch|install|zainstaluj|zmień|zmien|ustaw|set)\b/i;

function fold(text) {
  return stripDiacritics(String(text || '').toLowerCase());
}

/** Optimal-string-alignment distance: a swapped pair costs one edit, not two. */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  const table = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) table[i][0] = i;
  for (let j = 0; j <= n; j += 1) table[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
      }
    }
  }
  return table[m][n];
}

const VOCAB_FOLDED = VOCAB.map((word) => ({ word, folded: fold(word) }));

/** Repairs obvious typos and diacritic-free spellings; never rewrites whole sentences. */
function repairSpelling(text, { maxFixes = 6 } = {}) {
  const fixes = [];
  const words = String(text || '').split(/(\s+)/);
  const out = words.map((token) => {
    if (!token || /^\s+$/.test(token)) return token;
    const bare = token.replace(/^[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+|[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+$/g, '');
    // Short words are where fuzzy matching does the most damage ("mam" → "ram").
    // Requiring five letters and skipping stopwords keeps repairs boring.
    if (bare.length < 5 || fixes.length >= maxFixes) return token;
    const folded = fold(bare);
    const known = VOCAB_FOLDED.find((entry) => entry.folded === folded);
    if (known) {
      if (known.word !== bare && PL_STOPWORDS.has(bare.toLowerCase()) === false) {
        fixes.push({ from: bare, to: known.word, distance: 0, kind: 'diacritics' });
        return token.replace(bare, known.word);
      }
      return token;
    }
    if (PL_STOPWORDS.has(folded) || EN_STOPWORDS.has(folded)) return token;
    let best = null;
    for (const entry of VOCAB_FOLDED) {
      if (Math.abs(entry.folded.length - folded.length) > 2) continue;
      const distance = levenshtein(folded, entry.folded);
      if (distance <= 1 && (!best || distance < best.distance)) best = { ...entry, distance };
    }
    if (!best) return token;
    fixes.push({ from: bare, to: best.word, distance: best.distance });
    return token.replace(bare, best.word);
  });
  return { text: out.join(''), fixes };
}

function detectLanguage(text) {
  const value = String(text || '');
  if (!value.trim()) return 'unknown';
  const diacritics = (value.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
  const words = fold(value).split(/[^a-z]+/).filter(Boolean);
  const pl = words.filter((word) => PL_STOPWORDS.has(word)).length;
  const en = words.filter((word) => EN_STOPWORDS.has(word)).length;
  if (diacritics > 0) return 'pl';
  if (pl > en) return 'pl';
  if (en > pl) return 'en';
  // Polish has characteristic endings; use them only as a tie-breaker.
  if (/\b\w+(owania|aniem|ować|owac|ił|iła|iło|ści|ść)\b/.test(value.toLowerCase())) return 'pl';
  return 'unknown';
}

function turnsFromHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn, index) => {
      if (typeof turn === 'string') return { index, role: 'user', text: turn };
      const text = turn && (turn.text || turn.content);
      if (!text) return null;
      return { index, role: turn.role || 'user', text: String(text), id: turn.id || null, at: turn.at || null };
    })
    .filter(Boolean);
}

class SemanticInterpreter {
  constructor({ cognitive = null, llm = null, log = null, config = null, now = () => Date.now(), cacheLimit = 64 } = {}) {
    this.cognitive = cognitive || new CognitiveCore({ now, log, config });
    this.llm = llm;
    this.log = log;
    this.config = config;
    this.now = now;
    this.cacheLimit = cacheLimit;
    this.cache = new Map();
    this.counters = { interpreted: 0, modelUsed: 0, modelFailed: 0, cacheHits: 0, corrections: 0, referencesResolved: 0, clarifications: 0, spellingFixes: 0 };
  }

  enabled() {
    if (!this.llm) return false;
    const setting = this.config && this.config.get ? this.config.get('ai.semantics.enabled') : undefined;
    if (setting === false) return false;
    return true;
  }

  /** Cheap, synchronous view used when a full interpretation is unnecessary. */
  resolve({ text, history = null } = {}) {
    const question = String(text || '').trim();
    const turns = turnsFromHistory(history);
    const language = detectLanguage(question);
    const spelling = repairSpelling(question);
    const references = [];
    const seen = new Set();
    for (const pattern of REFERENCE_PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(question)) && references.length < 6) {
        const phrase = match[0];
        const key = `${pattern.kind}:${phrase.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ kind: pattern.kind, phrase, resolved: null });
      }
    }
    const corrections = [];
    for (const pattern of CORRECTION_PATTERNS) {
      const match = question.match(pattern.re);
      if (!match) continue;
      const replacement = String(match[match.length - 1] || '').trim();
      // Two patterns can describe the same correction ("nie, chodziło mi o…");
      // the user corrected once, so report it once.
      if (corrections.some((entry) => entry.replacement === replacement || entry.phrase.includes(match[0]) || match[0].includes(entry.phrase))) continue;
      corrections.push({ kind: pattern.kind, phrase: match[0], replacement });
    }

    // Which prior turn can a reference point at? The most recent user turn that
    // has a named subject. No subject means the reference is genuinely dangling.
    const lastUserTimed = turns.filter((turn) => turn.role === 'user' && turn.text.trim() && turn.text !== question);
    const lastUser = lastUserTimed.length ? lastUserTimed[lastUserTimed.length - 1] : null;
    const subjectFrom = (value) => {
      const deterministic = this.cognitive.analyse({ text: value, mode: 'fast' });
      return deterministic.entities.length ? deterministic.entities.map((entity) => entity.text || entity.value || entity.name || '').filter(Boolean) : [];
    };
    const topicEntities = lastUser ? subjectFrom(lastUser.text) : [];
    let resolvedCount = 0;
    for (const reference of references) {
      if (!lastUser) continue;
      reference.resolvedFrom = { index: lastUser.index, text: lastUser.text.slice(0, 300) };
      reference.resolved = topicEntities.length ? topicEntities.join(', ') : lastUser.text.slice(0, 120);
      reference.confidence = topicEntities.length ? 0.75 : 0.55;
      resolvedCount += 1;
    }

    const unresolved = [];
    if (references.length && !resolvedCount) unresolved.push('Nie wiem, czego dotyczy „to" — brak wcześniejszej wypowiedzi w tej rozmowie.');
    if (corrections.length && !lastUser) unresolved.push('Poprawka bez kontekstu: nie wiem, co miała zastąpić.');

    // "and what about the GPU" carries an implicit subject from the previous
    // turn. We keep the original question for the answer text, and build a
    // retrieval query that is explicitly labelled as augmented.
    const delta = references.find((reference) => reference.kind === 'delta' && reference.resolved);
    const resolvedText = delta ? `${lastUser.text.slice(0, 400)} — ${question}` : question;

    const verb = ACTION_VERBS.test(question);
    const blocking = unresolved.length > 0 && (verb || question.split(/\s+/).length <= 6);

    return {
      question,
      resolvedText,
      normalised: spelling.text,
      spellingFixes: spelling.fixes,
      language,
      references,
      corrections,
      unresolved,
      blocking,
      lastTurn: lastUser ? { index: lastUser.index, text: lastUser.text.slice(0, 400) } : null,
    };
  }

  /** Schema for the model pass. Kept small: interpretation, not an essay. */
  schema() {
    return {
      type: 'object',
      properties: {
        intents: { type: 'array', items: { type: 'string', enum: [...ALLOWED_INTENTS] } },
        strategy: { type: 'string', enum: [...ALLOWED_STRATEGIES] },
        requestKind: { type: 'string', enum: [...ALLOWED_KINDS] },
        goals: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        unresolvedQuestions: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        riskFlags: { type: 'array', items: { type: 'string' } },
        needsClarification: { type: 'boolean' },
        clarificationQuestion: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['intents', 'strategy', 'requestKind', 'confidence'],
      additionalProperties: false,
    };
  }

  validateModelOutput(data) {
    const problems = [];
    if (!data || typeof data !== 'object') return { ok: false, reason: 'not an object' };
    if (!Array.isArray(data.intents) || !data.intents.length) problems.push('intents must be a non-empty array');
    else if (data.intents.some((intent) => !ALLOWED_INTENTS.has(intent))) problems.push('unknown intent');
    if (!ALLOWED_STRATEGIES.has(data.strategy)) problems.push('unknown strategy');
    if (data.requestKind && !ALLOWED_KINDS.has(data.requestKind)) problems.push('unknown requestKind');
    for (const key of ['goals', 'entities', 'constraints', 'assumptions', 'unresolvedQuestions', 'acceptanceCriteria', 'riskFlags']) {
      if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some((entry) => typeof entry !== 'string' || entry.length > 300))) problems.push(`${key} must be an array of short strings`);
    }
    if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) problems.push('confidence must be 0..1');
    if (data.clarificationQuestion !== undefined && typeof data.clarificationQuestion !== 'string') problems.push('clarificationQuestion must be a string');
    return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true };
  }

  shouldAskModel({ brief, resolution, mode }) {
    if (!this.enabled()) return false;
    if (mode === 'fast') return false;
    // A deterministic computation or a truly empty request does not benefit
    // from an interpretation pass, and paying for one teaches nothing.
    if (brief.strategy === STRATEGIES.COMPUTE) return false;
    if (!brief.question) return false;
    const complexity = typeof brief.complexity === 'string' ? brief.complexity : (brief.complexity && brief.complexity.level);
    const signals = [
      complexity === 'high' || complexity === 'medium' || (brief.complexity && brief.complexity.score >= 3),
      brief.intentCandidates && brief.intentCandidates.length > 1 && brief.intentCandidates[1].weight >= brief.intentCandidates[0].weight - 0.5,
      brief.uncertainty >= 0.18,
      resolution.references.length > 0,
      resolution.corrections.length > 0,
      resolution.unresolved.length > 0,
      resolution.spellingFixes.length > 0,
      ['pl', 'en'].includes(resolution.language) && brief.intent === INTENTS.FACTUAL && brief.entities.length === 0,
      mode === 'deep' || mode === 'research',
    ];
    return signals.some(Boolean);
  }

  cacheKey({ text, mode, history }) {
    const last = turnsFromHistory(history).slice(-2).map((turn) => turn.text.slice(0, 120)).join('|');
    return `${mode}::${fold(text).slice(0, 240)}::${last}`;
  }

  async askModel({ brief, resolution, mode, timeoutMs = 8000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('semantic analysis timed out'), { code: 'TIMEOUT' })), timeoutMs);
    if (timer.unref) timer.unref();
    const started = this.now();
    try {
      const context = turnsFromHistory(resolution.history || []).slice(-4).map((turn) => `${turn.role}: ${turn.text.slice(0, 300)}`).join('\n');
      const messages = [
        {
          role: 'system',
          content: [
            'Jesteś deterministycznym analizatorem intencji dla lokalnego asystenta Windows.',
            'Nie odpowiadaj na pytanie użytkownika — tylko je interpretujesz.',
            'Zwróć wyłącznie JSON zgodny ze schematem. Nie wymyślaj faktów o komputerze.',
            'Pola w języku polskim mogą być po polsku; kod i nazwy po angielsku.',
            `Dozwolone strategie: ${[...ALLOWED_STRATEGIES].join(', ')}.`,
            `Dozwolone intencje: ${[...ALLOWED_INTENTS].join(', ')}.`,
            `Tryb: ${mode}. Wstępna analiza: intencja=${brief.intent}, strategia=${brief.strategy}, złożoność=${JSON.stringify(brief.complexity)}.`,
            context ? `Ostatnie wypowiedzi:\n${context}` : 'Brak wcześniejszych wypowiedzi.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: brief.question,
            normalised: resolution.normalised,
            language: resolution.language,
            references: resolution.references.map((reference) => ({ kind: reference.kind, phrase: reference.phrase, resolved: reference.resolved })),
            corrections: resolution.corrections,
            unresolved: resolution.unresolved,
            heuristicEntities: brief.entities.map((entity) => entity.text || entity.value || entity.name || ''),
          }),
        },
      ];
      const result = await this.llm.structured({
        messages,
        schema: this.schema(),
        modelClass: 'fast',
        attempts: 1,
        validate: (data) => this.validateModelOutput(data),
        signal: controller.signal,
        maxTokens: 400,
      });
      return { ok: true, data: result.data, model: result.model, provider: result.provider, ms: this.now() - started, attempts: result.attempts };
    } catch (err) {
      return { ok: false, code: err.code || 'SEMANTIC_FAILED', message: err.message, ms: this.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  merge({ brief, resolution, model, mode }) {
    const merged = { ...brief };
    merged.language = resolution.language;
    merged.normalised = resolution.normalised;
    merged.spellingFixes = resolution.spellingFixes;
    merged.references = resolution.references;
    merged.corrections = resolution.corrections;
    merged.unresolved = [...resolution.unresolved];
    merged.resolvedText = resolution.resolvedText;
    merged.blocking = resolution.blocking;
    merged.requestKind = model && model.requestKind ? model.requestKind : inferRequestKind(brief, resolution);
    merged.evidence = [];
    merged.hypotheses = [];
    merged.alternatives = [];
    merged.acceptanceCriteria = [...(brief.completionCriteria || [])];
    merged.semantic = {
      source: model ? 'hybrid' : 'deterministic',
      degraded: !model,
      model: model ? model.model : null,
      provider: model ? model.provider : null,
      confidence: model ? model.confidence : null,
      interpretation: model || null,
    };
    if (merged.needsClarification) {
      // Name what we think the user meant, so the question is answerable in one
      // line instead of "please repeat yourself".
      const resolved = (resolution.references || []).filter((reference) => reference.resolved);
      merged.clarificationQuestion = brief.clarificationQuestion
        || (resolved.length ? `Czy chodzi o: ${resolved[0].resolved}? Co dokładnie chcesz o tym wiedzieć?` : null);
    }
    if (!model) return merged;

    // Model contributes meaning; deterministic safety fields keep authority.
    const modelIntents = (model.intents || []).filter((intent) => ALLOWED_INTENTS.has(intent));
    if (modelIntents.length && brief.strategy !== STRATEGIES.COMPUTE && brief.strategy !== STRATEGIES.CLARIFY) {
      merged.intent = modelIntents[0];
      merged.intentCandidates = modelIntents.slice(0, 4).map((intent, index) => ({ intent, weight: Number((0.9 - index * 0.12).toFixed(2)) }));
    }
    if (model.strategy && ALLOWED_STRATEGIES.has(model.strategy) && ![STRATEGIES.COMPUTE, STRATEGIES.CLARIFY].includes(brief.strategy)) {
      if (model.strategy !== brief.strategy) {
        merged.strategy = model.strategy;
        merged.strategyReason = `semantycznie: ${model.strategy} (heurystyka wskazała ${brief.strategy})`;
      }
    }
    merged.goals = dedupe([...(brief.goals || []), ...(model.goals || [])]).slice(0, 8);
    merged.constraints = [...(brief.constraints || [])];
    for (const constraint of model.constraints || []) {
      const text = String(constraint).slice(0, 200);
      if (!text) continue;
      if (!merged.constraints.some((entry) => entry.text === text || entry.label === text)) merged.constraints.push({ id: `model-${merged.constraints.length + 1}`, label: text, source: 'model' });
    }
    merged.assumptions = [...(brief.assumptions || []), ...(model.assumptions || []).map((text) => ({ text, source: 'model' }))].slice(0, 8);
    merged.unresolved = dedupe([...merged.unresolved, ...(model.unresolvedQuestions || [])]).slice(0, 6);
    merged.acceptanceCriteria = dedupe([...merged.acceptanceCriteria, ...(model.acceptanceCriteria || [])]).slice(0, 6);
    if (model.entities && model.entities.length) {
      const existing = new Set((brief.entities || []).map((entity) => String(entity.text || entity.value || entity.name || '').toLowerCase()));
      for (const entity of model.entities.slice(0, 12)) {
        const text = String(entity).slice(0, 120);
        if (!text || existing.has(text.toLowerCase())) continue;
        merged.entities.push({ type: 'semantic', text, source: 'model' });
      }
    }
    if (model.riskFlags && model.riskFlags.length) {
      // Risk may only move up. A model lowering risk is ignored on purpose.
      const flags = dedupe([...(brief.risk.flags || []), ...model.riskFlags.map((flag) => `model:${String(flag).slice(0, 60)}`)]);
      const level = flags.length > 2 ? 'high' : brief.risk.level === 'high' ? 'high' : brief.risk.level === 'medium' || flags.length ? 'medium' : 'low';
      merged.risk = { ...brief.risk, level, flags, requiresApprovalHint: brief.risk.requiresApprovalHint || level === 'high' };
    }
    const modelWantsClarify = model.needsClarification === true && model.clarificationQuestion;
    const deterministicClarify = brief.strategy === STRATEGIES.CLARIFY;
    if (deterministicClarify || modelWantsClarify) {
      merged.needsClarification = true;
      const resolved = (resolution.references || []).filter((reference) => reference.resolved);
      merged.clarificationQuestion = brief.clarificationQuestion || model.clarificationQuestion
        || merged.clarificationQuestion
        || (resolved.length ? `Czy chodzi o: ${resolved[0].resolved}? Co dokładnie chcesz o tym wiedzieć?` : null);
      if (brief.strategy !== STRATEGIES.COMPUTE) merged.strategy = STRATEGIES.CLARIFY;
      merged.uncertaintyReasons = dedupe([...(brief.uncertaintyReasons || []), 'semantycznie: pytanie wymaga doprecyzowania']);
    }
    merged.hypotheses = (model.hypotheses || []).slice(0, 5).map((text) => ({ text: String(text).slice(0, 240), verified: false }));

    // Evidence quality drives uncertainty; model-reported confidence is only a
    // bounded input and never a substitute for validators.
    const modelConfidence = Math.max(0, Math.min(1, model.confidence));
    const uncertainty = 0.55 * brief.uncertainty + 0.25 * (1 - modelConfidence) + (merged.needsClarification ? 0.25 : 0) - (brief.entities.length ? 0.03 : 0);
    merged.uncertainty = Number(Math.max(0.02, Math.min(0.9, uncertainty)).toFixed(2));
    merged.uncertaintyReasons = dedupe([...(brief.uncertaintyReasons || []), `model: pewność interpretacji ${modelConfidence.toFixed(2)}`]).slice(0, 6);
    return merged;
  }

  /**
   * Full interpretation. Async because the model pass is async; the result is
   * always a superset of `CognitiveCore.analyse()` so existing callers keep
   * working unchanged.
   */
  async interpret({ text, mode = 'balanced', sessionId = 'default', history = null, plan = null } = {}) {
    const question = String(text || '').trim();
    this.counters.interpreted += 1;
    const resolution = this.resolve({ text: question, history });
    const base = this.cognitive.analyse({ text: question, mode, sessionId, history, plan });
    let model = null;
    let modelError = null;
    const asked = this.shouldAskModel({ brief: base, resolution, mode });
    resolution.history = turnsFromHistory(history);
    if (asked) {
      const key = this.cacheKey({ text: question, mode, history });
      const cached = this.cache.get(key);
      if (cached && this.now() - cached.at < 120000) {
        model = cached.value;
        this.counters.cacheHits += 1;
      } else {
        const attempt = await this.askModel({ brief: base, resolution: { ...resolution, history }, mode });
        if (attempt.ok) {
          model = attempt.data;
          this.counters.modelUsed += 1;
          this.cache.set(key, { at: this.now(), value: model });
          if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
        } else {
          this.counters.modelFailed += 1;
          modelError = { code: attempt.code, message: attempt.message, ms: attempt.ms };
          if (this.log) this.log.warn('cognition', `semantic pass unavailable: ${attempt.message}`);
        }
      }
    }
    if (resolution.corrections.length) this.counters.corrections += 1;
    if (resolution.references.some((reference) => reference.resolved)) this.counters.referencesResolved += 1;
    if (resolution.spellingFixes.length) this.counters.spellingFixes += 1;
    const merged = this.merge({ brief: base, resolution, model, mode });
    merged.semantic.modelError = modelError;
    merged.semantic.skipped = !asked;
    merged.semantic.historyUsed = resolution.history ? resolution.history.length : 0;
    if (merged.needsClarification) this.counters.clarifications += 1;
    return merged;
  }

  stats() {
    return { ...this.counters, cache: this.cache.size, enabled: this.enabled() };
  }
}

function inferRequestKind(brief, resolution) {
  if (resolution.corrections.length) return 'review';
  if (brief.strategy === STRATEGIES.PLAN || brief.strategy === STRATEGIES.RESEARCH) return 'planning';
  if (brief.strategy === STRATEGIES.TOOL) return 'execution';
  if (brief.intent === INTENTS.META || brief.intent === INTENTS.SMALLTALK) return 'conversation';
  if (brief.strategy === STRATEGIES.RETRIEVE) return 'information';
  return 'information';
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = typeof entry === 'string' ? entry : JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

module.exports = {
  SemanticInterpreter,
  repairSpelling,
  detectLanguage,
  fold,
  levenshtein,
  turnsFromHistory,
  ALLOWED_INTENTS,
  ALLOWED_STRATEGIES,
  ALLOWED_KINDS,
};
