'use strict';

/**
 * Synthetic passage-relevance data for the retrieval reranker.
 *
 * Sixteen topics have authored Polish/English descriptions and paraphrases.
 * Queries deliberately use different wording from some relevant passages, so a
 * pure token-overlap baseline is not automatically perfect. Each query has one
 * strongly relevant passage, one partially relevant passage from the same topic
 * and three distractors from other topics. Groups are topics, and the split is
 * by topic: test queries are never seen during training.
 */

const TOPICS = [
  {
    id: 'backup', name: 'backup i przywracanie',
    queries: ['jak przywrócić kopię zapasową', 'backup restore procedure', 'odzyskiwanie danych z backupu'],
    docs: [
      'Procedura przywracania kopii zapasowej: zatrzymaj usługę, wskaż migawkę, sprawdź sumę kontrolną i odtwórz dane.',
      'A backup snapshot can be restored after verifying its checksum and stopping the dependent service.',
      'Harmonogram tworzenia kopii zapasowych obejmuje pełny backup w niedzielę i przyrostowy codziennie.',
      'Dane archiwalne są przechowywane na osobnym nośniku i wymagają sprawdzenia integralności.',
    ],
  },
  {
    id: 'network', name: 'sieć i tunel',
    queries: ['dlaczego tunel sieciowy nie działa', 'network tunnel connection failure', 'napraw połączenie VPN'],
    docs: [
      'Tunel VPN wymaga poprawnego klucza, otwartego portu i zgodnego adresu końcowego; sprawdź logi uzgadniania.',
      'The encrypted tunnel fails when the pre-shared key or endpoint port does not match the peer configuration.',
      'Interfejs sieciowy ma adres 192.168.1.20 i bramę domyślną w tej samej podsieci.',
      'Zapora może blokować ruch wychodzący na niestandardowym porcie.',
    ],
  },
  {
    id: 'memory', name: 'pamięć i kontekst',
    queries: ['co pamiętasz o projekcie alfa', 'recall project alpha decisions', 'przypomnij ustalenia z alfa'],
    docs: [
      'W projekcie alfa ustalono, że wdrożenia odbywają się w czwartki, a właścicielem jest zespół platformy.',
      'Project alpha decisions: Thursday releases, platform ownership and a freeze before audits.',
      'Pamięć robocza przechowuje ostatnie wiadomości i aktywne cele do chwili ich zamknięcia.',
      'Starsze wpisy są konsolidowane, jeśli mają wspólny temat i nie są sprzeczne.',
    ],
  },
  {
    id: 'gpu', name: 'karta graficzna',
    queries: ['karta graficzna się przegrzewa', 'GPU overheating under load', 'obniż temperaturę GPU'],
    docs: [
      'Temperatura karty graficznej rośnie pod obciążeniem; sprawdź przepływ powietrza, wentylatory i limit mocy.',
      'GPU thermal throttling is diagnosed by comparing core temperature, fan curve and power limit under sustained load.',
      'Sterownik graficzny został zainstalowany w wersji oznaczonej jako stabilna.',
      'Pamięć VRAM jest wykorzystywana przez model wnioskowania i bufor kontekstu.',
    ],
  },
  {
    id: 'files', name: 'pliki i katalogi',
    queries: ['znajdź pliki z rozszerzeniem csv', 'find all CSV files', 'gdzie są pliki danych'],
    docs: [
      'Aby znaleźć pliki CSV, przeszukaj katalog roboczy i filtruj wyniki po rozszerzeniu .csv.',
      'Use a recursive file listing and filter entries whose extension is csv before reading them.',
      'Katalog tymczasowy jest czyszczony przy każdym starcie i nie zawiera trwałych danych.',
      'Ścieżki poza obszarem roboczym wymagają zgody użytkownika.',
    ],
  },
  {
    id: 'security', name: 'bezpieczeństwo',
    queries: ['podejrzane logowanie do systemu', 'suspicious login events', 'sprawdź nieudane logowania'],
    docs: [
      'Nieudane logowania z wielu adresów w krótkim czasie mogą oznaczać atak; sprawdź dziennik zdarzeń i blokady konta.',
      'Repeated failed authentication attempts from different addresses should be correlated with account lockout events.',
      'Hasła są przechowywane wyłącznie w menedżerze haseł, nigdy w pamięci asystenta.',
      'Zapora systemowa ma domyślnie włączony profil publiczny.',
    ],
  },
  {
    id: 'code', name: 'kod i testy',
    queries: ['testy nie przechodzą po zmianie', 'failing tests after refactor', 'napraw błąd w funkcji'],
    docs: [
      'Po refaktoryzacji testy mogą wskazywać zmieniony kontrakt; uruchom pojedynczy przypadek i porównaj ślad stosu.',
      'A failing test after a refactor usually reveals a changed contract or a missing branch; inspect the stack trace first.',
      'Repozytorium zawiera mapę symboli i zależności między modułami.',
      'Zmiana wielu plików wymaga kopii zapasowej i weryfikacji skrótu.',
    ],
  },
  {
    id: 'calendar', name: 'kalendarz i terminy',
    queries: ['co mam zaplanowane na czwartek', 'what is due next week', 'przypomnij o spotkaniu'],
    docs: [
      'W czwartek o dziesiątej zaplanowano przegląd projektu, a o piętnastej spotkanie z zespołem platformy.',
      'Next week the audit deadline and the Thursday project review are the two scheduled commitments.',
      'Zadania cykliczne są przechowywane z regułą powtarzania i strefą czasową.',
      'Minutnik przypomnień działa nawet po restarcie aplikacji.',
    ],
  },
  {
    id: 'research', name: 'badania i źródła',
    queries: ['zbierz źródła o GraphRAG', 'research GraphRAG evidence', 'porównaj badania nad RAG'],
    docs: [
      'GraphRAG łączy wyszukiwanie leksykalne, wektory i graf wiedzy; każdy wniosek powinien mieć cytat i numer linii.',
      'Graph retrieval augments lexical and vector search with multi-hop relationships, while citations preserve provenance.',
      'Sesja badawcza przechowuje pytania, źródła i nierozwiązane sprzeczności.',
      'Źródła internetowe są oznaczane jako niezaufane i nie mogą przyznawać uprawnień.',
    ],
  },
  {
    id: 'installer', name: 'instalator',
    queries: ['instalator nie kończy pracy', 'installer rollback failed', 'bezpieczna aktualizacja aplikacji'],
    docs: [
      'Instalator najpierw tworzy kopię zapasową, potem etapuje pliki, sprawdza zdrowie i w razie błędu wycofuje zmiany.',
      'A staged installer must back up user data, verify health and roll back atomically when verification fails.',
      'Konfiguracja jest zapisywana w katalogu domowym użytkownika.',
      'Wersja jest wyświetlana w interfejsie i API zdrowia.',
    ],
  },
  {
    id: 'email', name: 'poczta i komunikacja',
    queries: ['przygotuj szkic odpowiedzi na maila', 'draft an email reply', 'wyślij wiadomość do zespołu'],
    docs: [
      'Szkic wiadomości powinien zawierać temat, zwięzłe streszczenie i prośbę o potwierdzenie terminu; wysyłka wymaga zgody.',
      'Drafting an email creates text only; sending requires an approved provider, verified recipient and explicit consent.',
      'Historia komunikacji zawiera status dostarczenia i identyfikator próby.',
      'Połączenia telefoniczne są dozwolone wyłącznie na zweryfikowany numer.',
    ],
  },
  {
    id: 'data', name: 'analiza danych',
    queries: ['policz średnią i odchylenie', 'calculate mean and standard deviation', 'znajdź wartości odstające'],
    docs: [
      'Średnia to suma podzielona przez liczność, a odchylenie standardowe mierzy rozproszenie wokół średniej.',
      'Outliers can be flagged with the interquartile range; the mean and standard deviation describe the distribution.',
      'Tabela wyników ma kolumny nazwa, czas i status.',
      'Wiersze są filtrowane przed agregacją, aby nie mieszać jednostek.',
    ],
  },
  {
    id: 'gaming', name: 'gry i wydajność',
    queries: ['gra ma niskie FPS po aktualizacji', 'low FPS after driver update', 'zoptymalizuj ustawienia gry'],
    docs: [
      'Niskie FPS po aktualizacji sterownika wymaga porównania czasów klatek, temperatury i ustawień grafiki przed zmianą.',
      'Measure frame times before and after a driver update; do not promise FPS gains without a repeatable benchmark.',
      'Ustawienia gry są zapisywane w pliku konfiguracyjnym w katalogu dokumentów.',
      'Tryb gry wstrzymuje niepotrzebne zadania w tle.',
    ],
  },
  {
    id: 'voice', name: 'głos i mowa',
    queries: ['mikrofon nie nagrywa', 'microphone capture fails', 'rozpoznawanie mowy nie działa'],
    docs: [
      'Brak nagrania z mikrofonu może wynikać z wybranego urządzenia, uprawnień systemowych lub zajętego kanału.',
      'If speech recognition receives no audio, verify the capture device, permission and sample rate before changing models.',
      'Transkrypcja jest oznaczana jako dane wrażliwe i nie jest trenowana bez zgody.',
      'Tryb push-to-talk pokazuje wyraźny wskaźnik nagrywania.',
    ],
  },
  {
    id: 'vision', name: 'obraz i OCR',
    queries: ['odczytaj tekst ze zrzutu ekranu', 'extract text from screenshot', 'rozpoznaj tabelę na obrazie'],
    docs: [
      'OCR odczytuje tekst ze zrzutu ekranu, ale wynik jest danymi niezaufanymi i wymaga sprawdzenia.',
      'Screenshot text extraction returns untrusted text; a table may require layout-aware parsing before use.',
      'Obrazy są przetwarzane lokalnie, jeśli wybrany model na to pozwala.',
      'Wynik wizji jest dołączany do odpowiedzi wraz z pewnością.',
    ],
  },
  {
    id: 'workflow', name: 'zadania i przepływy',
    queries: ['zaplanuj wieloetapowe zadanie', 'create a multi-step workflow', 'wznów przerwany proces'],
    docs: [
      'Wieloetapowy przepływ zapisuje stan każdego kroku, punkty kontrolne i identyfikator operacji, aby wznowienie nie powtórzyło efektów.',
      'A durable workflow checkpoints each step so a restart resumes completed work instead of repeating external side effects.',
      'Zadania równoległe są uruchamiane tylko wtedy, gdy nie współdzielą zasobów.',
      'Anulowanie zatrzymuje model, narzędzia i procesy potomne.',
    ],
  },
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

function overlap(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / (left.size + right.size - common);
}

function cosineSets(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return common / Math.sqrt(a.size * b.size);
}

function features(query, doc) {
  const qTokens = new Set(tokens(query));
  const dTokens = new Set(tokens(doc));
  let contained = 0;
  for (const token of qTokens) if (dTokens.has(token)) contained += 1;
  const containment = qTokens.size ? contained / qTokens.size : 0;
  const phrase = String(doc).toLowerCase().includes(String(query).toLowerCase()) ? 1 : 0;
  const lengthRatio = Math.min(qTokens.size, dTokens.size) / Math.max(1, Math.max(qTokens.size, dTokens.size));
  return [
    overlap(query, doc),
    containment,
    cosineSets(trigrams(query), trigrams(doc)),
    phrase,
    lengthRatio,
    Math.min(1, dTokens.size / 30),
  ];
}

function baselineScore(query, doc) {
  const [jaccard, containment, trigram] = features(query, doc);
  return 0.45 * jaccard + 0.35 * containment + 0.2 * trigram;
}

function cases() {
  const output = [];
  TOPICS.forEach((topic, topicIndex) => {
    topic.queries.forEach((query, queryIndex) => {
      const candidates = [
        { doc: topic.docs[queryIndex % topic.docs.length], grade: 2, role: 'primary' },
        { doc: topic.docs[(queryIndex + 1) % topic.docs.length], grade: 1, role: 'same-topic' },
      ];
      for (let offset = 1; offset <= 3; offset += 1) {
        const other = TOPICS[(topicIndex + offset * 3) % TOPICS.length];
        candidates.push({ doc: other.docs[(queryIndex + offset) % other.docs.length], grade: 0, role: 'distractor' });
      }
      const seen = new Set();
      const unique = candidates.filter((candidate) => {
        if (seen.has(candidate.doc)) return false;
        seen.add(candidate.doc);
        return true;
      });
      output.push({
        id: `${topic.id}-${queryIndex}`,
        group: topic.id,
        query,
        candidates: unique.map((candidate) => ({ ...candidate, features: features(query, candidate.doc), baseline: baselineScore(query, candidate.doc) })),
      });
    });
  });
  return output;
}

module.exports = { TOPICS, features, baselineScore, cases, tokens };
