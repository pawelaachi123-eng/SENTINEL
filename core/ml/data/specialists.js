'use strict';

/**
 * Authored synthetic datasets for the 7.0 specialist models.
 *
 * These are routing/selection experiments, not claims about language
 * understanding. Every item is written here, the split is deterministic and the
 * baseline for each task is explicit. The tool labels are real tool names; a
 * test checks that each one exists in the registry.
 */

const TOOL_ITEMS = [
  ['system.info', 'pokaż stan komputera', 'sprawdź ile mam RAM', 'jaki mam procesor', 'show CPU and memory', 'system status and uptime', 'ile miejsca na dysku', 'temperatura i obciążenie', 'what are my hardware specs', 'sprawdź wersję systemu', 'memory and CPU usage'],
  ['system.snapshot', 'zrób snapshot systemu', 'zapisz bieżące metryki', 'capture a system snapshot', 'zbierz próbkę obciążenia', 'zapisz stan do porównania'],
  ['fs.list', 'pokaż pliki w katalogu', 'list files in this folder', 'co jest w pobranych', 'wyświetl zawartość katalogu', 'find files by name', 'pokaż drzewo plików'],
  ['memory.remember', 'zapamiętaj że lubię kawę', 'remember my preference', 'zapisz to na później', 'przypomnij mi o tym', 'store this decision', 'notuj że projekt alfa startuje w czwartek'],
  ['memory.recall', 'co pamiętasz o projekcie', 'recall what I said about backups', 'przypomnij ustalenia', 'search my memory', 'find the decision we made', 'co ustaliliśmy wcześniej'],
  ['task.create', 'utwórz zadanie na jutro', 'create a task to review the PR', 'zaplanuj zadanie', 'dodaj to do listy zadań', 'make a reminder task', 'zapisz zadanie z terminem'],
  ['research.start', 'rozpocznij badanie o GraphRAG', 'start a research session', 'zbierz źródła o transformerach', 'research the latest RAG papers', 'zaplanuj research z cytatami'],
  ['lab.status', 'pokaż wyniki laboratorium', 'how accurate is the model', 'lab metrics and experiments', 'sprawdź aktywny model', 'show training history'],
  ['data.csv_parse', 'wczytaj ten CSV', 'parse comma separated data', 'przekształć csv na tabele', 'read a csv file into rows', 'pokaż kolumny z csv'],
  ['stats.describe', 'policz średnią i odchylenie', 'describe this numeric sample', 'calculate mean and standard deviation', 'podaj medianę i percentyle', 'jaki jest rozkład wartości'],
  ['text.slugify', 'zrób slug z tytułu', 'create a URL safe slug', 'zamień tekst na identyfikator', 'normalize this title for a URL'],
  ['repo.map', 'pokaż mapę repozytorium', 'map the repository files', 'jakie są moduły projektu', 'list source files and symbols'],
  ['security.scan', 'sprawdź bezpieczeństwo systemu', 'scan for security problems', 'czy są podejrzane procesy', 'security audit of this machine'],
  ['graph.query', 'zapytaj graf wiedzy', 'query the knowledge graph', 'znajdź powiązania w grafie', 'multi hop question over the graph'],
  ['assistant.briefing', 'zrób mi briefing na dziś', 'what is due today', 'podsumuj zadania i terminy', 'daily briefing with reminders'],
].flatMap(([label, ...phrases]) => phrases.map((text) => ({ text, label })));

const ROUTE_ITEMS = [
  ['windows', 'napraw menedżer zadań', 'why is explorer using CPU', 'ustawienia Windows', 'disable startup app safely', 'windows event log errors', 'usuń tymczasowe pliki systemowe', 'check Windows updates'],
  ['hardware', 'karta graficzna się przegrzewa', 'ile mam RAM', 'GPU temperature and fans', 'which CPU is installed', 'dysk SSD ma problemy', 'sprawdź zasilacz i napięcia'],
  ['code', 'napraw błąd w funkcji', 'refactor this module', 'testy nie przechodzą', 'explain this stack trace', 'add a unit test', 'znajdź wyciek pamięci w kodzie'],
  ['knowledge', 'znajdź w dokumentach gwarancję', 'summarize this PDF', 'co wiemy o projekcie alfa', 'search the knowledge base', 'porównaj źródła o RAG', 'przytocz cytat z umowy'],
  ['security', 'czy to podejrzane logowanie', 'sprawdź uprawnienia i firewall', 'scan for malware indicators', 'audit failed logins', 'czy plik jest bezpieczny', 'sprawdź integralność backupu'],
  ['devices', 'połącz telefon z agentem', 'ESP32 nie odpowiada', 'sprawdź status urządzenia', 'pair a new phone', 'przekaźnik zasilania nie działa'],
  ['communication', 'przygotuj maila do zespołu', 'napisz SMS z potwierdzeniem', 'draft a message', 'zaplanuj rozmowę telefoniczną', 'podsumuj historię kontaktu'],
  ['operations', 'sprawdź obciążenie sieci', 'przeanalizuj logi serwera', 'czy usługa działa', 'network latency and packet loss', 'restart usługi po awarii', 'monitoruj dysk i procesy'],
].flatMap(([label, ...phrases]) => phrases.map((text) => ({ text, label })));

const RELEVANCE_TOPICS = [
  { topic: 'backup', queries: ['jak przywrócić backup', 'backup restore', 'odzyskać dane z kopii'], memories: ['Procedura przywracania kopii: sprawdź sumę i migawkę.', 'Backup restore needs a verified snapshot and checksum.'], distractors: ['Karta graficzna wymaga czystego przepływu powietrza.', 'Spotkanie o dziesiątej w czwartek.'] },
  { topic: 'gpu', queries: ['dlaczego GPU się grzeje', 'GPU temperature', 'obniż temperaturę karty'], memories: ['Temperatura GPU rośnie pod obciążeniem; sprawdź wentylatory i limit mocy.', 'GPU throttling depends on fan curve and power limit.'], distractors: ['Backup jest tworzony w niedzielę.', 'Notatka o projekcie alfa.'] },
  { topic: 'calendar', queries: ['co mam w czwartek', 'deadline next week', 'spotkania na dziś'], memories: ['W czwartek o dziesiątej jest przegląd projektu.', 'The audit deadline is next Tuesday.'], distractors: ['Dysk ma dwa wolne terabajty.', 'Model osiągnął dobrą dokładność.'] },
  { topic: 'security', queries: ['podejrzane logowanie', 'failed logins', 'czy konto jest bezpieczne'], memories: ['Wielokrotne nieudane logowania mogą oznaczać atak.', 'Failed authentication attempts should be correlated with lockouts.'], distractors: ['Kopia zapasowa jest na osobnym nośniku.', 'Lubię kawę bez cukru.'] },
  { topic: 'code', queries: ['testy nie przechodzą', 'failing tests', 'błąd po refaktorze'], memories: ['Po refaktoryzacji sprawdź ślad stosu i zmieniony kontrakt.', 'A failing test often reveals a changed contract.'], distractors: ['Spotkanie przeniesiono na piętnastą.', 'RAM ma 32 GB.'] },
  { topic: 'research', queries: ['źródła o GraphRAG', 'GraphRAG papers', 'porównaj RAG'], memories: ['GraphRAG łączy graf, wektory i wyszukiwanie leksykalne.', 'Graph retrieval augments lexical and vector search.'], distractors: ['Dysk SSD jest prawie pełny.', 'Przypomnienie o lekach.'] },
  { topic: 'network', queries: ['tunel VPN nie działa', 'network tunnel failure', 'napraw połączenie'], memories: ['Tunel wymaga zgodnego klucza i otwartego portu.', 'The tunnel fails when the key or endpoint does not match.'], distractors: ['Raport ma trzy sekcje.', 'Kawa i mleko.'] },
  { topic: 'memory', queries: ['co ustaliliśmy o alfa', 'project alpha decisions', 'przypomnij decyzje'], memories: ['W projekcie alfa wdrożenia są w czwartki.', 'Project alpha uses Thursday releases.'], distractors: ['GPU ma 8 GB VRAM.', 'Temperatura CPU wynosi 60 stopni.'] },
  { topic: 'finance', queries: ['ile wynosi rata kredytu', 'loan payment', 'break even'], memories: ['Rata zależy od oprocentowania i liczby miesięcy.', 'Break even requires price above variable cost.'], distractors: ['Tunel VPN używa portu 7878.', 'Testy przeszły po zmianie.'] },
  { topic: 'voice', queries: ['mikrofon nie nagrywa', 'microphone fails', 'rozpoznawanie mowy'], memories: ['Sprawdź urządzenie wejściowe i uprawnienia mikrofonu.', 'Speech recognition needs permission and a free capture device.'], distractors: ['Backup jest zaszyfrowany.', 'Projekt alfa ma nowy terminarz.'] },
];

function tokens(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').split(/[^a-z0-9]+/).filter(Boolean);
}

function trigrams(text) {
  const set = new Set();
  for (const token of tokens(text)) {
    const padded = `^${token}$`;
    for (let index = 0; index + 3 <= padded.length; index += 1) set.add(padded.slice(index, index + 3));
  }
  return set;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return common / Math.sqrt(a.size * b.size);
}

function relevanceFeatures(query, memory, recency = 0.5, importance = 0.5) {
  const q = new Set(tokens(query));
  const m = new Set(tokens(memory));
  let common = 0;
  for (const token of q) if (m.has(token)) common += 1;
  const jaccard = q.size && m.size ? common / (q.size + m.size - common) : 0;
  const containment = q.size ? common / q.size : 0;
  const tri = cosine(trigrams(query), trigrams(memory));
  const lengthRatio = Math.min(q.size, m.size) / Math.max(1, Math.max(q.size, m.size));
  return [jaccard, containment, tri, Number(recency), Number(importance), lengthRatio].map((value) => Number(value.toFixed(6)));
}

const relevanceItems = [];
for (const item of RELEVANCE_TOPICS) {
  item.queries.forEach((query, queryIndex) => {
    item.memories.forEach((memory, memoryIndex) => {
      relevanceItems.push({
        query,
        memory,
        recency: 0.4 + 0.1 * ((queryIndex + memoryIndex) % 6),
        importance: 0.5 + 0.1 * (memoryIndex % 4),
        label: 'relevant',
        group: item.topic,
        features: relevanceFeatures(query, memory, 0.4 + 0.1 * ((queryIndex + memoryIndex) % 6), 0.5 + 0.1 * (memoryIndex % 4)),
      });
    });
    item.distractors.forEach((memory, distractorIndex) => {
      relevanceItems.push({
        query,
        memory,
        recency: 0.3 + 0.05 * distractorIndex,
        importance: 0.5,
        label: 'irrelevant',
        group: `${item.topic}:distractor`,
        features: relevanceFeatures(query, memory, 0.3 + 0.05 * distractorIndex, 0.5),
      });
    });
  });
}

const COMPLEXITY_ITEMS = [
  ['simple', 'jaka jest godzina', 'pokaż RAM', 'ile mam CPU', 'what is my GPU', 'status dysku', 'stop', 'help', 'pokaż pogodę', 'kto to jest'],
  ['simple', 'otwórz notatnik', 'zapisz notatkę', 'policz 2 plus 2', 'list files', 'show tasks', 'przypomnij o spotkaniu'],
  ['simple', 'what is the date', 'lock the computer', 'zablokuj komputer', 'pokaż wersję', 'sprawdź baterię'],
  ['medium', 'sprawdź RAM, CPU i temperaturę i powiedz czy coś jest nie tak', 'znajdź pliki CSV i policz średnią z kolumny czas', 'porównaj dwie kopie zapasowe i wskaż różnice', 'przygotuj brief i sprawdź terminy zadań'],
  ['medium', 'przeanalizuj logi z ostatniej godziny i znajdź błędy', 'wyszukaj dokumenty o gwarancji i streść je z cytatami', 'policz korelację i opisz wynik', 'zaplanuj trzy kroki wdrożenia i sprawdź zależności'],
  ['medium', 'sprawdź stan sieci i zaproponuj dwie poprawki', 'napisz maila i pokaż go przed wysłaniem', 'zrób backup i zweryfikuj sumę kontrolną', 'przygotuj tabelę z budżetem na trzy kategorie'],
  ['complex', 'zbadaj temat GraphRAG, zbierz pięć źródeł, porównaj metody, wskaż sprzeczności i napisz raport z cytatami', 'zaplanuj i wykonaj migrację bazy, zrób kopię, sprawdź integralność i w razie błędu wycofaj zmiany', 'przeanalizuj repozytorium, znajdź przyczynę awarii testów, zaproponuj poprawkę w wielu plikach i zweryfikuj ją na kopii'],
  ['complex', 'przygotuj wieloetapowe badanie rynku, zbierz dane, policz statystyki, sprawdź źródła i przedstaw raport z ograniczeniami', 'napisz i przetestuj nowy moduł, dodaj testy, sprawdź regresje i przygotuj opis zmian', 'zbuduj plan projektu z zależnościami, terminami i ryzykami, a następnie oceń go'],
  ['complex', 'prześledź incydent bezpieczeństwa od logów przez procesy do sieci, oceń ryzyko i zaproponuj odwracalne działania', 'porównaj trzy modele na wspólnym zbiorze, zmierz opóźnienia i jakość, a wynik opisz wraz z ograniczeniami'],
];

function complexityFeatures(text) {
  const value = String(text);
  const words = tokens(value).length;
  const clauses = value.split(/[,;.]|\bi\b|\band\b/).filter((part) => part.trim()).length;
  const conjunctions = (value.match(/\b(i|oraz|and|then|potem|następnie)\b/gi) || []).length;
  const toolCues = (value.match(/\b(sprawdź|policz|znajdź|porównaj|zrób|napisz|zaplanuj|wykonaj|przeanalizuj|zbierz|check|calculate|find|compare|write|plan|run|analy[sz]e|collect)\b/gi) || []).length;
  const numbers = (value.match(/\d+/g) || []).length;
  const questions = (value.match(/\?/g) || []).length;
  return [Math.min(1, words / 40), Math.min(1, clauses / 6), Math.min(1, conjunctions / 4), Math.min(1, toolCues / 5), Math.min(1, numbers / 8), Math.min(1, questions / 3)].map((entry) => Number(entry.toFixed(6)));
}

const complexityItems = COMPLEXITY_ITEMS.flatMap(([label, ...phrases]) => phrases.map((text) => ({ text, label, features: complexityFeatures(text) })));

function toolBaseline(text) {
  const folded = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
  const rules = [
    ['memory.remember', /zapamiet|remember|zapisz to|notuj/],
    ['memory.recall', /pamiet|recall|co ustalil|wczesniej/],
    ['system.info', /ram|cpu|procesor|dysk|gpu|stan komputera|hardware|memory and/],
    ['system.snapshot', /snapshot|probk|metryki/],
    ['fs.list', /plik|file|folder|katalog|directory/],
    ['task.create', /zadani|task|todo|lista/],
    ['research.start', /badani|research|zrodl|source/],
    ['lab.status', /laborator|lab|model accuracy|trening/],
    ['data.csv_parse', /csv|tabel|comma/],
    ['stats.describe', /sredni|mean|median|percentyl|odchylen/],
    ['text.slugify', /slug|url/],
    ['repo.map', /repo|module|modul|source files/],
    ['security.scan', /bezpieczen|security|podejrzan|scan|audit/],
    ['graph.query', /graf|graph|powiazan|multi hop/],
    ['assistant.briefing', /briefing|due today|termin/],
  ];
  for (const [label, pattern] of rules) if (pattern.test(folded)) return label;
  return 'system.info';
}

function routeBaseline(text) {
  const folded = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
  const rules = [
    ['security', /bezpieczen|security|podejrzan|login|firewall|malware/],
    ['code', /kod|code|funkcj|test|stack|refactor|bug|blad/],
    ['knowledge', /dokument|pdf|wiedz|knowledge|zrodl|umow|citat/],
    ['devices', /telefon|phone|esp32|urzadzeni|device|pair/],
    ['communication', /mail|sms|wiadomosc|message|rozmow|call/],
    ['hardware', /gpu|cpu|ram|dysk|karta|procesor|temperature|zasilacz/],
    ['windows', /windows|explorer|startup|event log|systemow/],
    ['operations', /siec|network|log|uslug|service|monitor|dysk|proces/],
  ];
  for (const [label, pattern] of rules) if (pattern.test(folded)) return label;
  return 'operations';
}

function relevanceBaseline(features) {
  return features[0] + features[1] + features[2] > 0.18 ? 'relevant' : 'irrelevant';
}

function complexityBaseline(features) {
  const score = features[0] * 0.35 + features[1] * 0.3 + features[2] * 0.15 + features[3] * 0.2;
  return score > 0.45 ? 'complex' : score > 0.2 ? 'medium' : 'simple';
}

module.exports = {
  tools: { task: 'tool-selection', items: TOOL_ITEMS, labels: [...new Set(TOOL_ITEMS.map((item) => item.label))].sort(), baseline: toolBaseline, keywordFeatures: toolKeywordFeatures, provenance: 'authored requests mapped to real tool names' },
  routing: { task: 'agent-routing', items: ROUTE_ITEMS, labels: [...new Set(ROUTE_ITEMS.map((item) => item.label))].sort(), baseline: routeBaseline, keywordFeatures: routeKeywordFeatures, provenance: 'authored requests mapped to eight functional domains' },
  relevance: { task: 'memory-relevance', items: relevanceItems, labels: ['irrelevant', 'relevant'], baseline: relevanceBaseline, featureNames: ['jaccard', 'query-containment', 'trigram-cosine', 'recency', 'importance', 'length-ratio'], provenance: 'authored query/memory pairs with relevance labels' },
  complexity: { task: 'task-complexity', items: complexityItems, labels: ['complex', 'medium', 'simple'], baseline: complexityBaseline, featureNames: ['length', 'clauses', 'conjunctions', 'tool-cues', 'numbers', 'questions'], provenance: 'authored request complexity labels' },
};

/**
 * Authored keyword lexicons used only to generate additional *training*
 * paraphrases. Held-out authored requests stay untouched, so a test phrase is
 * never seen verbatim during fitting. This is synthetic augmentation, not
 * scraped data, and it is disclosed in every experiment record.
 */
const TOOL_KEYWORDS = {
  'system.info': ['RAM', 'pamięć', 'CPU', 'procesor', 'GPU', 'karta graficzna', 'dysk', 'dysk SSD', 'temperatura', 'obciążenie', 'wersja systemu', 'specyfikacja komputera', 'hardware', 'uptime'],
  'system.snapshot': ['snapshot systemu', 'migawka metryk', 'próbka obciążenia', 'zapis stanu', 'system snapshot', 'capture metrics', 'baseline pomiaru'],
  'fs.list': ['pliki', 'folder', 'katalog', 'drzewo plików', 'zawartość katalogu', 'lista plików', 'files', 'directory', 'folder contents'],
  'memory.remember': ['zapamiętaj', 'zapisz na później', 'notuj', 'zapisz decyzję', 'remember this', 'store this preference', 'utrwal informację'],
  'memory.recall': ['przypomnij', 'co pamiętasz', 'co ustaliliśmy', 'wyszukaj w pamięci', 'recall memory', 'find the decision', 'wcześniejsze ustalenia'],
  'task.create': ['zadanie', 'lista zadań', 'todo', 'termin zadania', 'create task', 'reminder task', 'zaplanuj zadanie'],
  'research.start': ['badanie', 'research', 'źródła', 'zbierz materiały', 'przegląd literatury', 'research papers', 'cytat'],
  'lab.status': ['laboratorium', 'lab', 'eksperyment', 'dokładność modelu', 'training history', 'model metrics', 'trening'],
  'data.csv_parse': ['CSV', ' comma separated', 'tabela z pliku', 'kolumny', 'parse csv', 'wiersze danych', 'csv rows'],
  'stats.describe': ['średnia', 'mediana', 'odchylenie', 'percentyl', 'rozkład', 'mean', 'standard deviation', 'statystyka'],
  'text.slugify': ['slug', 'identyfikator URL', 'bezpieczny link', 'normalize title', 'url safe', 'zamień tekst'],
  'repo.map': ['repozytorium', 'mapa projektu', 'moduły', 'pliki źródłowe', 'repository map', 'source symbols', 'struktura kodu'],
  'security.scan': ['bezpieczeństwo', 'skan zagrożeń', 'podejrzany proces', 'audyt bezpieczeństwa', 'security scan', 'malware indicators', 'firewall'],
  'graph.query': ['graf wiedzy', 'powiązania', 'knowledge graph', 'graph query', 'multi hop', 'relacje w grafie'],
  'assistant.briefing': ['briefing', 'podsumowanie dnia', 'terminy na dziś', 'daily briefing', 'what is due', 'poranna odprawa'],
};

const ROUTE_KEYWORDS = {
  windows: ['Windows', 'menedżer zadań', 'explorer', 'rejestr', 'aktualizacje Windows', 'event log', 'punkt przywracania', 'autostart'],
  hardware: ['RAM', 'CPU', 'GPU', 'karta graficzna', 'dysk SSD', 'zasilacz', 'temperatura', 'wentylator', 'napięcie'],
  code: ['kod', 'funkcja', 'test', 'refaktor', 'stack trace', 'repozytorium', 'błąd kompilacji', 'moduł'],
  knowledge: ['dokument', 'PDF', 'umowa', 'gwarancja', 'baza wiedzy', 'cytat', 'źródła', 'notatki'],
  security: ['logowanie', 'uprawnienia', 'firewall', 'malware', 'audyt', 'integralność', 'podejrzany', 'szyfrowanie'],
  devices: ['telefon', 'ESP32', 'urządzenie', 'przekaźnik', 'Bluetooth', 'pairing', 'czujnik', 'firmware'],
  communication: ['mail', 'email', 'SMS', 'wiadomość', 'rozmowa', 'call', 'kontakt', 'powiadomienie'],
  operations: ['serwer', 'usługa', 'sieć', 'logi', 'opóźnienie', 'dysk', 'procesy', 'monitoring'],
};

function toolAugment(item) {
  const keywords = TOOL_KEYWORDS[item.label] || [];
  const templates = ['sprawdź {kw}', 'pokaż {kw}', 'potrzebuję {kw}', 'check {kw}', 'show {kw}', 'proszę o {kw}'];
  return templates.flatMap((template) => keywords.map((keyword) => ({ text: template.replace('{kw}', keyword), label: item.label, generated: true })));
}

function routeAugment(item) {
  const keywords = ROUTE_KEYWORDS[item.label] || [];
  const templates = ['pomóż z {kw}', 'problem z {kw}', 'sprawdź {kw}', 'help with {kw}', 'diagnose {kw}', 'co zrobić z {kw}'];
  return templates.flatMap((template) => keywords.map((keyword) => ({ text: template.replace('{kw}', keyword), label: item.label, generated: true })));
}

module.exports.toolAugment = toolAugment;
module.exports.routeAugment = routeAugment;
module.exports.TOOL_KEYWORDS = TOOL_KEYWORDS;
module.exports.ROUTE_KEYWORDS = ROUTE_KEYWORDS;

function fold(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
}

function stem(token) {
  const folded = fold(token);
  return folded.length > 4 && /[aiyoue]$/.test(folded) ? folded.slice(0, -1) : folded;
}

function keywordHit(text, keyword) {
  const haystack = fold(text).replace(/[^a-z0-9]+/g, ' ');
  const needles = fold(keyword).split(/[^a-z0-9]+/).filter(Boolean);
  if (!needles.length) return 0;
  const words = new Set(haystack.split(' ').flatMap((word) => [word, stem(word)]));
  const hit = needles.every((needle) => words.has(needle) || words.has(stem(needle)) || haystack.includes(needle));
  return hit ? 1 : 0;
}

function toolKeywordFeatures(text) {
  const labels = [...new Set(TOOL_ITEMS.map((item) => item.label))].sort();
  return labels.map((label) => (TOOL_KEYWORDS[label] || []).reduce((best, keyword) => Math.max(best, keywordHit(text, keyword)), 0));
}

function routeKeywordFeatures(text) {
  const labels = [...new Set(ROUTE_ITEMS.map((item) => item.label))].sort();
  return labels.map((label) => (ROUTE_KEYWORDS[label] || []).reduce((best, keyword) => Math.max(best, keywordHit(text, keyword)), 0));
}

module.exports.relevanceFeatures = relevanceFeatures;
module.exports.complexityFeatures = complexityFeatures;
module.exports.toolKeywordFeatures = toolKeywordFeatures;
module.exports.routeKeywordFeatures = routeKeywordFeatures;
module.exports.fold = fold;
