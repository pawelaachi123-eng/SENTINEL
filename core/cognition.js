'use strict';

/**
 * The cognitive core.
 *
 * Before anything is retrieved or executed, the question is read properly:
 * what is being asked, about what, under which constraints, how hard it is, how
 * risky it is, what would count as done, and — the part most systems skip —
 * whether it is clear enough to answer at all.
 *
 * This module is deterministic on purpose. Intent classification, complexity and
 * risk must behave identically in tests, in CI and on a machine whose model is
 * busy; a small local model is used only where classification genuinely needs
 * semantics (see dispatcher.plan), never for the decisions that gate safety.
 *
 * The output is a "brief": a plain object that the brain, the UI timeline and the
 * verifier all read. It is data, so it can be logged, tested and shown to the
 * user instead of being hidden inside a prompt.
 */

const MODE_BUDGETS = {
  fast: { memories: 3, documents: 2, toolCalls: 4, steps: 3, reflections: 0, tokens: 4000, verification: 'basic' },
  balanced: { memories: 5, documents: 4, toolCalls: 8, steps: 6, reflections: 1, tokens: 6000, verification: 'standard' },
  deep: { memories: 8, documents: 4, toolCalls: 14, steps: 10, reflections: 2, tokens: 9000, verification: 'deep' },
  research: { memories: 12, documents: 12, toolCalls: 24, steps: 16, reflections: 3, tokens: 14000, verification: 'deep' },
};

const INTENTS = {
  FACTUAL: 'factual',
  DIAGNOSTIC: 'diagnostic',
  PROCEDURAL: 'procedural',
  ACTION: 'action',
  CODING: 'coding',
  MATH: 'math',
  RETRIEVAL: 'retrieval',
  COMPARISON: 'comparison',
  CREATIVE: 'creative',
  META: 'meta',
  SMALLTALK: 'smalltalk',
  CLARIFICATION: 'clarification',
};

const STRATEGIES = {
  DIRECT: 'direct',
  COMPUTE: 'compute',
  RETRIEVE: 'retrieve',
  TOOL: 'tool',
  PLAN: 'plan',
  CLARIFY: 'clarify',
  RESEARCH: 'research',
};

const SIGNALS = {
  math: /(\d[\d\s.,]*\s*[-+*/^%x×]\s*\d|ile\s+to|oblicz|policz|procent|pierwiastek|sqrt|log\b|średni\w*\s+z\b)/i,
  action: /\b(otwórz|uruchom|zamknij|zainstaluj|odinstaluj|usuń|skopiuj|przenieś|zmień|ustaw|wyłącz|włącz|zrestartuj|zabij|wykonaj|stwórz|zapisz|wyślij|open|launch|kill|install|remove|copy|move|set|create|run)\b/i,
  destructive: /\b(usuń|skasuj|sformatuj|wyczyść|zabij|zamknij|wyłącz|zrestartuj|restart|shutdown|delete|remove|format|wipe|kill|uninstall|odinstaluj)\b/i,
  procedural: /\b(jak|how to|krok po kroku|instrukcj|procedur|configure|skonfiguruj|napraw|fix)\b/i,
  diagnostic: /\b(dlaczego|why|nie działa|nie dziala|błąd|blad|error|problem|awari|sprawdź|sprawdz|diagnos|wydajno|performance|slow|wolno|crash)\b/i,
  coding: /\b(kod|code|funkcj|function|bug|refactor|test|class|komponent|typescript|javascript|python|regex|api|commit|diff|patch)\b/i,
  retrieval: /\b(dokument|pdf|notatk|w bazie|wiedzy|znajdź|znajdz|szukaj|search|find|gdzie jest|co pisze|cytuj|źródł|zrodl)\b/i,
  comparison: /\b(porównaj|porownaj|vs\.?|versus|lepszy|lepsze|różnic|roznic|compare|better)\b/i,
  creative: /\b(napisz|wymyśl|wymysl|stwórz tekst|opowiadanie|poemat|wygeneruj|draft|write)\b/i,
  meta: /\b(jak działasz|jak dzialasz|kim jesteś|kim jestes|co potrafisz|twoje możliwości|twoje mozliwosci|help|pomoc)\b/i,
  smalltalk: /^(cześć|czesc|hej|siema|dzień dobry|dzien dobry|witaj|thanks|dzięki|dzieki|ok|okej|hello|hi|yo)\b/i,
  multiStep: /\b(i|oraz|następnie|nastepnie|potem|później|pozniej|then|after that|a także|a takze|krok \d)\b/i,
  ambiguity: /^(a\s+)?(to|on|ona|ono|tam|ten|ta|te|jego|jej|it|that|this|and)\??$/i,
  planRequest: /\b(zaplanuj|plan\b|krok po kroku|step by step|rozplanuj|outline)\b/i,
  polish: /[ąćęłńóśźż]/i,
};

const CONSTRAINT_RULES = [
  { id: 'no-delete', re: /\b(nie usuwaj|bez usuwania|do not delete|don't delete)\b/i, note: 'użytkownik zabronił usuwania' },
  { id: 'read-only', re: /\b(tylko (przeczytaj|odczytaj|sprawdź)|read[- ]only|bez zmian|no changes)\b/i, note: 'tylko odczyt — nie zmieniaj niczego' },
  { id: 'no-install', re: /\b(nie instaluj|bez instalowania|do not install)\b/i, note: 'bez instalowania' },
  { id: 'local-only', re: /\b(lokalnie|offline|bez internetu|no cloud|nie wysyłaj)\b/i, note: 'dane mają nie opuszczać maszyny' },
  { id: 'short', re: /\b(krótko|krotko|w dwóch zdaniach|jednym zdaniem|briefly|short)\b/i, note: 'odpowiedź ma być krótka' },
  { id: 'deadline', re: /(w ciągu|w ciagu|do \d+\s*(min|sek|godz)|within \d+)/i, note: 'limit czasu' },
];

const ENTITY_RULES = [
  { id: 'path', re: /(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:[\w.-]+\/)+[\w.-]*|~\/[\w./-]+)/g, label: 'path' },
  { id: 'url', re: /\bhttps?:\/\/[^\s"'<>]+/g, label: 'url' },
  { id: 'file', re: /\b[\w -]+\.(?:pdf|docx?|xlsx?|csv|json|md|txt|log|js|ts|py|ps1|bat|exe|zip|png|jpe?g)\b/gi, label: 'file' },
  { id: 'number', re: /\b\d+(?:[.,]\d+)?\s*(?:%|gb|mb|tb|w|hz|°c|c|v|ms|s|min|h)?\b/gi, label: 'number' },
  { id: 'app', re: /\b(steam|discord|chrome|firefox|edge|spotify|obs|notepad|vscode|vs code|excel|word|terminal|powershell)\b/gi, label: 'app' },
  { id: 'hardware', re: /\b(rtx|gtx|radeon|cpu|gpu|ram|ssd|nvme|hdd|psu|zasilacz|płyt|plyt|vram|procesor|kart[ay])\b/gi, label: 'hardware' },
  { id: 'device', re: /\b(esp32|arduino|android|telefon|phone|tablet|drukark|printer|kamera|webcam)\b/gi, label: 'device' },
];

const STOPWORDS = new Set(
  'a aby ale albo bo by co czy dla do i ich im ja jak jest jeszcze już lub ma mi mnie my na nam nas nie nich no o od on ona oni oraz po pod przy są się tak to ty w we wie więc z za ze że żeby the and for with that this what how why when where who'.split(' '),
);

function stripDiacritics(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ą/g, 'a')
    .replace(/ć/g, 'c')
    .replace(/ę/g, 'e')
    .replace(/ł/g, 'l')
    .replace(/ń/g, 'n')
    .replace(/ó/g, 'o')
    .replace(/ś/g, 's')
    .replace(/ź/g, 'z')
    .replace(/ż/g, 'z');
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.:+-]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Rough but honest token estimate: ~4 characters per token in mixed text. */
function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(value.length / 4), Math.ceil(words * 1.3));
}

class CognitiveCore {
  constructor({ config = null, now = () => Date.now(), log = null } = {}) {
    this.config = config;
    this.now = now;
    this.log = log;
    this.counters = { analysed: 0, clarifications: 0 };
  }

  classify(question) {
    const text = String(question || '').trim();
    const scores = [];
    const add = (intent, weight, why) => scores.push({ intent, weight, why });
    if (SIGNALS.math.test(text)) add(INTENTS.MATH, 3, 'wyrażenie lub słowo arytmetyczne');
    if (SIGNALS.coding.test(text)) add(INTENTS.CODING, 2, 'słownictwo programistyczne');
    if (SIGNALS.retrieval.test(text)) add(INTENTS.RETRIEVAL, 2.5, 'pytanie o dokumenty/notatki');
    if (SIGNALS.diagnostic.test(text)) add(INTENTS.DIAGNOSTIC, 2, 'sygnał problemu lub prośba o sprawdzenie');
    if (SIGNALS.procedural.test(text)) add(INTENTS.PROCEDURAL, 1.5, 'pytanie „jak”');
    if (SIGNALS.comparison.test(text)) add(INTENTS.COMPARISON, 2, 'porównanie');
    if (SIGNALS.action.test(text)) add(INTENTS.ACTION, 2, 'czasownik zmieniający stan');
    if (SIGNALS.meta.test(text)) add(INTENTS.META, 3, 'pytanie o samego asystenta');
    if (SIGNALS.smalltalk.test(text) && text.length < 40) add(INTENTS.SMALLTALK, 2.5, 'krótkie powitanie');
    if (SIGNALS.creative.test(text)) add(INTENTS.CREATIVE, 1.5, 'prośba o tekst');
    if (SIGNALS.planRequest.test(text)) add(INTENTS.PROCEDURAL, 1, 'prośba o plan');
    if (!scores.length) add(INTENTS.FACTUAL, 1, 'pytanie bez wyraźnego sygnału');
    scores.sort((a, b) => b.weight - a.weight);
    return { intent: scores[0].intent, confidence: Number(Math.min(0.95, 0.45 + scores[0].weight / 6).toFixed(2)), candidates: scores.slice(0, 3) };
  }

  entities(question) {
    const text = String(question || '');
    const found = [];
    for (const rule of ENTITY_RULES) {
      const matches = text.match(rule.re) || [];
      for (const match of new Set(matches.map((value) => value.trim()))) {
        if (found.length >= 24) break;
        if (found.some((entry) => entry.value.toLowerCase() === match.toLowerCase() && entry.label === rule.label)) continue;
        found.push({ label: rule.label, value: match });
      }
    }
    return found;
  }

  goals(question) {
    const text = String(question || '');
    const parts = text
      .split(/[,;]|\s+(?:i|oraz|a potem|następnie|nastepnie|potem|then)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 2);
    const goals = (parts.length ? parts : [text]).slice(0, 6).map((part, index) => ({
      id: `g${index + 1}`,
      text: part,
      kind: SIGNALS.action.test(part) ? 'action' : SIGNALS.retrieval.test(part) ? 'retrieve' : 'answer',
    }));
    return goals;
  }

  constraints(question) {
    const text = String(question || '');
    const constraints = CONSTRAINT_RULES.filter((rule) => rule.re.test(text)).map((rule) => ({ id: rule.id, note: rule.note }));
    if (SIGNALS.destructive.test(text) && !constraints.some((entry) => entry.id === 'read-only')) {
      constraints.push({ id: 'confirm-before-change', note: 'operacja zmienia stan — wymaga wyraźnej zgody' });
    }
    return constraints;
  }

  complexity(question, intent, entities) {
    let score = 0;
    const text = String(question || '');
    if (text.length > 90) score += 1;
    if (text.length > 220) score += 1;
    if ((text.match(/\?/g) || []).length > 1) score += 1;
    if (SIGNALS.multiStep.test(text)) score += 1;
    if (SIGNALS.planRequest.test(text)) score += 2;
    if (entities.length >= 3) score += 1;
    if ([INTENTS.PROCEDURAL, INTENTS.CODING, INTENTS.DIAGNOSTIC, INTENTS.COMPARISON].includes(intent)) score += 1;
    if (SIGNALS.action.test(text) && SIGNALS.multiStep.test(text)) score += 1;
    return { score: Math.min(6, score), level: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low' };
  }

  risk(question) {
    const text = String(question || '');
    const flags = [];
    if (SIGNALS.destructive.test(text)) flags.push('destructive-verb');
    if (/\b(system32|rejestr|registry|regedit|bcdedit|diskpart|format\s+[a-z]:)/i.test(text)) flags.push('system-level');
    if (/\b(hasło|haslo|token|api[ _-]?key|klucz prywatny|password|credentials)\b/i.test(text)) flags.push('secret-mention');
    if (/\b(uprawnienia|administrator|sudo|runas|admin)\b/i.test(text)) flags.push('privilege');
    if (/\b(wyłącz|wylacz|disable)\b.*\b(defender|firewall|antivirus|sandbox)\b/i.test(text)) flags.push('security-bypass');
    const level = flags.includes('security-bypass') || flags.includes('system-level') ? 'high' : flags.length ? 'medium' : 'low';
    return { level, flags, requiresApprovalHint: level !== 'low' };
  }

  /** Chooses the first strategy whose preconditions actually hold. */
  chooseStrategy({ question, intent, complexity, risk, entities, constraints, mode }) {
    const text = String(question || '');
    const reasons = [];
    const readOnly = constraints.some((constraint) => constraint.id === 'read-only');
    if (intent === INTENTS.SMALLTALK) return { strategy: STRATEGIES.DIRECT, reason: 'powitanie' };
    if (intent === INTENTS.MATH && /\d/.test(text)) return { strategy: STRATEGIES.COMPUTE, reason: 'arytmetyka jest deterministyczna — policzę, nie zgaduję' };
    if (SIGNALS.ambiguity.test(text)) return { strategy: STRATEGIES.CLARIFY, reason: 'pytanie nie zawiera przedmiotu' };
    if (mode === 'research') return { strategy: STRATEGIES.RESEARCH, reason: 'tryb research: szeroka synteza źródeł' };
    if (complexity.level === 'high' && complexity.score >= 4) return { strategy: STRATEGIES.PLAN, reason: 'złożone zadanie z wieloma krokami' };
    if (intent === INTENTS.RETRIEVAL || (entities.some((entity) => ['file', 'path'].includes(entity.label)) && intent !== INTENTS.ACTION)) {
      return { strategy: STRATEGIES.RETRIEVE, reason: 'pytanie wskazuje na dokumenty lub ścieżki' };
    }
    if (intent === INTENTS.ACTION) {
      return { strategy: readOnly ? STRATEGIES.RETRIEVE : STRATEGIES.TOOL, reason: readOnly ? 'użytkownik prosił o brak zmian' : 'zadanie wymaga działania na maszynie' };
    }
    if (intent === INTENTS.CODING) return { strategy: STRATEGIES.PLAN, reason: 'praca z kodem wymaga planu i weryfikacji' };
    if (intent === INTENTS.DIAGNOSTIC) return { strategy: STRATEGIES.TOOL, reason: 'diagnoza musi opierać się na pomiarach' };
    if (intent === INTENTS.PROCEDURAL) return { strategy: complexity.level === 'low' ? STRATEGIES.DIRECT : STRATEGIES.PLAN, reason: 'instrukcja krok po kroku' };
    reasons.push('brak przesłanek do planu lub narzędzi');
    return { strategy: complexity.level === 'medium' ? STRATEGIES.TOOL : STRATEGIES.DIRECT, reason: reasons[0] };
  }

  assumptions({ question, mode, intent }) {
    const list = [];
    if (SIGNALS.polish.test(question) || this.config && (this.config.get('ui.language') || '').startsWith('pl')) list.push({ id: 'language', text: 'odpowiadam po polsku' });
    list.push({ id: 'platform', text: `działam lokalnie na ${process.platform === 'win32' ? 'tej maszynie z Windows' : process.platform}` });
    if (['deep', 'research'].includes(mode)) list.push({ id: 'budget', text: `tryb ${mode}: więcej kroków i weryfikacji, dłuższy czas odpowiedzi` });
    if (intent === INTENTS.DIAGNOSTIC) list.push({ id: 'evidence', text: 'diagnoza opiera się na zmierzonych danych, nie na domysłach' });
    return list;
  }

  completionCriteria({ strategy, intent }) {
    const criteria = ['odpowiedź odnosi się do pytania'];
    if (strategy === STRATEGIES.COMPUTE) criteria.push('wynik pochodzi z obliczenia, nie z modelu', 'jednostka i znak są poprawne');
    if ([STRATEGIES.RETRIEVE, STRATEGIES.RESEARCH].includes(strategy)) criteria.push('każde twierdzenie z dokumentów ma cytat [K#]');
    if ([STRATEGIES.TOOL, STRATEGIES.PLAN].includes(strategy)) criteria.push('każde użyte narzędzie zakończyło się sukcesem albo jego błąd jest opisany', 'stan maszyny po akcji jest potwierdzony');
    if (intent === INTENTS.CODING) criteria.push('zmiana jest pokazana jako diff', 'testy przeszły albo ich brak jest jawnie zaznaczony');
    criteria.push('brak sprzeczności z pamięcią i dokumentami');
    return criteria;
  }

  /**
   * Full analysis. Returns a brief that is safe to log (no model output, no
   * secrets) and cheap enough to compute on every request.
   */
  analyse({ text, mode = 'balanced', sessionId = 'default', plan = null, history = null } = {}) {
    const question = String(text || '').trim();
    const chosenMode = MODE_BUDGETS[mode] ? mode : 'balanced';
    const classification = this.classify(question);
    const entities = this.entities(question);
    const goals = this.goals(question);
    const constraints = this.constraints(question);
    const complexity = this.complexity(question, classification.intent, entities);
    const risk = this.risk(question);
    const chosen = this.chooseStrategy({ question, intent: classification.intent, complexity, risk, entities, constraints, mode: chosenMode });
    const budget = { ...MODE_BUDGETS[chosenMode] };
    if (plan && plan.length) budget.steps = Math.max(budget.steps, plan.length);
    if (risk.level === 'high') budget.reflections = Math.max(budget.reflections, 1);

    // Uncertainty is a statement about the input, not about the model's mood:
    // short pronoun-only questions, missing subjects, competing intents and
    // risky requests all make the answer less certain before work starts.
    let uncertainty = 0.08;
    const uncertaintyReasons = [];
    if (question.length < 12) {
      uncertainty += 0.12;
      uncertaintyReasons.push('bardzo krótkie pytanie');
    }
    if (!entities.length) {
      uncertainty += 0.06;
      uncertaintyReasons.push('brak nazwanych obiektów');
    }
    if (classification.candidates.length > 1 && classification.candidates[1].weight >= classification.candidates[0].weight - 0.5) {
      uncertainty += 0.1;
      uncertaintyReasons.push('intencja niejednoznaczna');
    }
    if (chosen.strategy === STRATEGIES.CLARIFY) {
      uncertainty += 0.35;
      uncertaintyReasons.push('brakuje przedmiotu pytania');
    }
    if (risk.level === 'high') {
      uncertainty += 0.05;
      uncertaintyReasons.push('wysokie ryzyko operacji');
    }
    if (history && history.length) uncertainty -= 0.03;
    uncertainty = Number(Math.max(0, Math.min(0.8, uncertainty)).toFixed(2));

    const needsClarification = chosen.strategy === STRATEGIES.CLARIFY;
    this.counters.analysed += 1;
    if (needsClarification) this.counters.clarifications += 1;

    return {
      at: new Date(this.now()).toISOString(),
      question,
      mode: chosenMode,
      sessionId,
      intent: classification.intent,
      intentConfidence: classification.confidence,
      intentCandidates: classification.candidates,
      entities,
      goals,
      constraints,
      complexity,
      risk,
      strategy: chosen.strategy,
      strategyReason: chosen.reason,
      budget,
      assumptions: this.assumptions({ question, mode: chosenMode, intent: classification.intent }),
      completionCriteria: this.completionCriteria({ strategy: chosen.strategy, intent: classification.intent }),
      uncertainty,
      uncertaintyReasons,
      needsClarification,
      estimatedTokens: estimateTokens(question),
    };
  }

  /**
   * Bounded reflection. Decides whether another attempt is worth the budget or
   * whether the honest answer is "this failed, here is why".
   */
  reflect({ brief, verification = null, toolLog = [], attempts = 1, cancelled = false } = {}) {
    if (cancelled) return { shouldRetry: false, reason: 'przebieg anulowany', action: 'stop' };
    if (!brief) return { shouldRetry: false, reason: 'brak briefu', action: 'answer' };
    const budget = brief.budget || MODE_BUDGETS.balanced;
    if (attempts > budget.reflections) return { shouldRetry: false, reason: `wyczerpany budżet refleksji (${budget.reflections})`, action: 'answer' };
    const issues = (verification && verification.issues) || [];
    const failed = (toolLog || []).filter((entry) => !entry.ok && entry.code !== 'APPROVAL_REQUIRED');
    if (!issues.length && !failed.length) return { shouldRetry: false, reason: 'weryfikacja przeszła', action: 'answer' };
    if (failed.some((entry) => ['PROTECTED', 'APPROVAL_REQUIRED', 'PERMISSION_DENIED', 'CIRCUIT_OPEN'].includes(entry.code))) {
      return { shouldRetry: false, reason: 'błąd wymaga decyzji człowieka, nie kolejnej próby', action: 'report' };
    }
    if (failed.length) {
      const retryable = failed.filter((entry) => !['NOT_FOUND', 'INVALID_ARGS', 'BAD_ARGS'].includes(entry.code));
      if (retryable.length) return { shouldRetry: true, reason: 'narzędzie zawiodło w sposób przejściowy', action: 'retry-tool', tools: retryable.map((entry) => entry.name) };
    }
    if (issues.some((issue) => /cyt|cite|citation/i.test(String(issue)))) {
      return { shouldRetry: true, reason: 'brakuje cytowań mimo znalezionych dokumentów', action: 'repair-citations' };
    }
    if (issues.some((issue) => /nie wspomina|does not mention|failed/i.test(String(issue)))) {
      return { shouldRetry: true, reason: 'odpowiedź pomija błąd narzędzia', action: 'repair-honesty' };
    }
    return { shouldRetry: false, reason: 'wykryte problemy nie są naprawialne automatycznie', action: 'answer' };
  }

  /** Task class used for experience learning and routing statistics. */
  taskClass(brief) {
    if (!brief) return 'unknown';
    return `${brief.intent}/${brief.complexity.level}/${brief.strategy}`;
  }

  stats() {
    return { ...this.counters, budgets: MODE_BUDGETS, intents: Object.values(INTENTS), strategies: Object.values(STRATEGIES) };
  }
}

module.exports = {
  CognitiveCore,
  INTENTS,
  STRATEGIES,
  MODE_BUDGETS,
  estimateTokens,
  tokens,
  stripDiacritics,
  SIGNALS,
};
