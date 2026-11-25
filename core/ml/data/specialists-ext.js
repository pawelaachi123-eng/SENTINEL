'use strict';

/**
 * Additional authored synthetic datasets for the 7.1 specialists.
 *
 * semantic similarity  — does this passage answer this question?
 * context importance   — should this chunk survive the prompt budget?
 * failure risk         — is this planned tool call likely to fail?
 *
 * These are scenario datasets, not logs of private activity and not observed
 * production incidents. The failure labels come from an explicit operational
 * rubric below; the report calls them synthetic, because that is what they are.
 */

const fs = require('node:fs');

function fold(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
}

function tokens(text) {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean);
}

function contentTokens(text) {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'jak', 'co', 'czy', 'mam', 'jest', 'sie', 'do', 'w', 'z', 'na', 'o', 'i', 'że', 'ze', 'mi', 'my', 'what', 'how', 'why', 'when', 'which']);
  return tokens(text).filter((token) => token.length > 2 && !stop.has(token));
}

function trigrams(text) {
  const set = new Set();
  for (const token of tokens(text)) {
    const padded = `^${token}$`;
    for (let index = 0; index + 3 <= padded.length; index += 1) set.add(padded.slice(index, index + 3));
  }
  return set;
}

function cosineSets(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}

function numbersOf(text) {
  return (String(text).match(/\b\d+(?:[.,]\d+)?\b/g) || []).map((number) => number.replace(',', '.'));
}

function hasNegation(text) {
  return /\b(nie|bez|nigdy|never|not|without|no)\b/i.test(fold(text));
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'jak', 'co', 'czy', 'mam', 'jest', 'sie', 'do', 'w', 'z', 'na', 'o', 'i', 'że', 'ze', 'mi', 'my', 'what', 'how', 'why', 'when', 'which']);

function similarityFeatures(query, passage) {
  const q = new Set(tokens(query));
  const p = new Set(tokens(passage));
  const qContent = new Set([...q].filter((token) => token.length > 2 && !STOP.has(token)));
  const pContent = new Set([...p].filter((token) => token.length > 2 && !STOP.has(token)));
  let shared = 0;
  for (const token of q) if (p.has(token)) shared += 1;
  let contentShared = 0;
  for (const token of qContent) if (pContent.has(token)) contentShared += 1;
  const jaccard = q.size && p.size ? shared / (q.size + p.size - shared) : 0;
  const containment = q.size ? shared / q.size : 0;
  const aspect = qContent.size ? contentShared / qContent.size : 0;
  const tri = cosineSets(trigrams(query), trigrams(passage));
  const qn = numbersOf(query);
  const pn = new Set(numbersOf(passage));
  const numberMatch = qn.length ? qn.filter((number) => pn.has(number)).length / qn.length : 0.5;
  const negationMismatch = hasNegation(query) !== hasNegation(passage) ? 1 : 0;
  const lengthRatio = Math.min(q.size, p.size) / Math.max(1, Math.max(q.size, p.size));
  const exact = fold(query).length > 8 && fold(passage).includes(fold(query)) ? 1 : 0;
  return [jaccard, containment, aspect, tri, numberMatch, negationMismatch, lengthRatio, exact].map((value) => Number(value.toFixed(6)));
}

function similarityBaseline(features) {
  return features[0] * 0.25 + features[1] * 0.30 + features[2] * 0.30 + features[3] * 0.15 > 0.30 ? 'match' : 'no-match';
}

const SEMANTIC_TOPICS = [
  {
    topic: 'backup', queries: ['jak przywrócić kopię zapasową', 'how do I restore a backup', 'co zrobić gdy backup jest uszkodzony', 'verify a backup checksum'],
    positives: ['Kopię przywracamy z zweryfikowanej migawki; najpierw sprawdź sumę kontrolną.', 'To restore, select a verified snapshot and check its checksum before writing.', 'An interrupted restore can leave a partial directory; retry from the snapshot.', 'Checksums detect a corrupt backup before the restore starts.'],
    hard: ['Backup jest tworzony w każdą niedzielę o drugiej.', 'The backup disk has two free terabytes.', 'Kopia zapasowa leży na osobnym nośniku.', 'Backups are encrypted with a long passphrase.'],
    easy: ['Temperatura GPU rośnie pod obciążeniem.', 'W czwartek o dziesiątej jest przegląd projektu.'],
  },
  {
    topic: 'gpu', queries: ['dlaczego karta graficzna się grzeje', 'GPU throttling causes', 'jaki limit mocy ustawić', 'how to lower GPU temperature'],
    positives: ['Sprawdź krzywą wentylatorów i limit mocy; throttling zaczyna się przy 83 stopniach.', 'A conservative power limit lowers temperature and fan noise.', 'Heat builds up when the case exhaust is blocked.', 'GPU temperature depends on load, airflow and the power limit.'],
    hard: ['Karta graficzna ma 8 GB VRAM.', 'The GPU driver version is 566.14.', 'Zasilacz ma moc 650 watów.', 'A new monitor supports 144 Hz.'],
    easy: ['Procedura przywracania kopii wymaga sumy kontrolnej.', 'Spotkanie przeniesiono na piętnastą.'],
  },
  {
    topic: 'calendar', queries: ['co mam w czwartek', 'kiedy jest termin audytu', 'what is due next week', 'spotkania na dziś'],
    positives: ['W czwartek o dziesiątej jest przegląd projektu alfa.', 'The audit deadline is next Tuesday at noon.', 'Dziś o piętnastej masz rozmowę z klientem.', 'The project review is scheduled for Thursday morning.'],
    hard: ['W czwartek jest wolny dzień.', 'The calendar is synced with the phone.', 'Audyt był w zeszłym miesiącu.', 'The meeting room has a projector.'],
    easy: ['Dysk SSD ma dwa wolne terabajty.', 'Funkcja zwraca sumę dwóch liczb.'],
  },
  {
    topic: 'security', queries: ['czy to podejrzane logowanie', 'failed login attempts meaning', 'czy konto jest bezpieczne', 'how to audit firewall rules'],
    positives: ['Wielokrotne nieudane logowania z różnych adresów mogą oznaczać atak.', 'Repeated failed authentication should be correlated with lockouts.', 'A firewall rule audit lists every open inbound port.', 'Unexpected admin logins are a reason to rotate credentials.'],
    hard: ['Konto ma włączone uwierzytelnianie dwuskładnikowe.', 'The firewall log is rotated every day.', 'Hasło zostało zmienione w zeszłym roku.', 'The security policy is stored in the repository.'],
    easy: ['Kawa bez cukru smakuje dobrze.', 'Model osiągnął dokładność 0.81.'],
  },
  {
    topic: 'code', queries: ['testy nie przechodzą po refaktorze', 'why does this stack trace fail', 'jak naprawić błąd w funkcji', 'find the cause of a regression'],
    positives: ['Po refaktoryzacji zmienił się kontrakt funkcji; ślad stosu wskazuje wywołanie z null.', 'A failing test often reveals a changed interface, not a flaky runner.', 'The stack trace points to the caller passing an undefined value.', 'Run the failing test in isolation and compare the changed contract.'],
    hard: ['Test suite ma dwieście przypadków.', 'The repository uses Node.js 22.', 'Funkcja została dodana w wersji 4.0.', 'The CI runner has four cores.'],
    easy: ['Temperatura CPU wynosi 60 stopni.', 'The calendar has a free slot on Friday.'],
  },
  {
    topic: 'research', queries: ['źródła o GraphRAG', 'what is GraphRAG', 'porównaj RAG i graf wiedzy', 'latest papers on retrieval augmented generation'],
    positives: ['GraphRAG łączy graf, wektory i wyszukiwanie leksykalne, dodając cytaty.', 'Graph retrieval augments lexical and vector search with explicit edges.', 'A recent survey compares graph-based and dense retrieval.', 'The paper reports citation-grounded answers from a knowledge graph.'],
    hard: ['GraphRAG jest dostępny jako biblioteka.', 'The repository has a graph visualisation page.', 'RAG papers are stored in the knowledge folder.', 'The model was trained on a small dataset.'],
    easy: ['Backup jest zaszyfrowany.', 'Dysk ma dwa wolne terabajty.'],
  },
  {
    topic: 'vpn', queries: ['tunel VPN nie działa', 'why does the tunnel disconnect', 'napraw połączenie VPN', 'check tunnel key mismatch'],
    positives: ['Tunel wymaga zgodnego klucza i otwartego portu 7879.', 'A tunnel disconnects when the endpoint key does not match.', 'Sprawdź, czy port i klucz PSK są takie same po obu stronach.', 'The handshake fails if the server clock is far in the past.'],
    hard: ['Tunel używa szyfrowania AES-256-GCM.', 'The VPN configuration file exists.', 'Port 7878 serves the UI.', 'The phone is paired with the PC.'],
    easy: ['W projekcie alfa wdrożenia są w czwartki.', 'The model reports NDCG 0.84.'],
  },
  {
    topic: 'project', queries: ['co ustaliliśmy o projekcie alfa', 'project alpha decisions', 'kiedy są wdrożenia alfa', 'open questions for project alpha'],
    positives: ['W projekcie alfa wdrożenia są w czwartki, a właścicielem jest Marta.', 'Project alpha releases on Thursday and uses a feature flag.', 'The open decision is whether to migrate the alpha database.', 'Marta owns the alpha release checklist.'],
    hard: ['Projekt alfa ma nowy terminarz.', 'The project alpha repository is private.', 'Alpha users are in the beta channel.', 'The alpha budget is not approved.'],
    easy: ['Temperatura GPU wynosi 70 stopni.', 'The backup checksum is valid.'],
  },
  {
    topic: 'finance', queries: ['ile wynosi rata kredytu', 'calculate loan payment', 'break even point', 'koszt całkowity przy 24 miesiącach'],
    positives: ['Rata zależy od oprocentowania, kwoty i liczby miesięcy.', 'Monthly payment is principal times the annuity factor.', 'Break even requires price above variable cost.', 'The total cost over 24 months includes interest and fees.'],
    hard: ['Kredyt został zaciągnięty w banku.', 'The loan application is a PDF.', 'The interest rate is shown on the website.', 'The finance team meets on Monday.'],
    easy: ['Mikrofon wymaga uprawnień.', 'The GPU has 8 GB VRAM.'],
  },
  {
    topic: 'microphone', queries: ['mikrofon nie nagrywa', 'why is the microphone silent', 'speech recognition permission', 'napraw wejście audio'],
    positives: ['Sprawdź urządzenie wejściowe i uprawnienia mikrofonu w systemie.', 'Speech recognition needs microphone permission and a non-muted input device.', 'The wrong input device is a common reason for silence.', 'Select the headset microphone and unmute it in the audio panel.'],
    hard: ['Mikrofon jest podłączony przez USB.', 'The audio driver version is 10.0.', 'The headset has a mute button.', 'Speech recognition supports Polish and English.'],
    easy: ['Backup jest na osobnym dysku.', 'The audit deadline is Tuesday.'],
  },
  {
    topic: 'windows', queries: ['why is explorer using CPU', 'disable startup app safely', 'Windows event log errors', 'jak usunąć tymczasowe pliki'],
    positives: ['Explorer may scan a network folder; check its CPU use in Task Manager.', 'Disable a startup entry from Task Manager instead of deleting registry keys.', 'Event log error 1000 usually needs the faulting module name.', 'Usuń pliki tymczasowe przez Narzędzie do czyszczenia dysku.', 'A safe startup change can be reverted from Task Manager.'],
    hard: ['Windows is installed on the C drive.', 'Explorer has a dark theme.', 'The event log is stored in a file.', 'The startup folder contains shortcuts.'],
    easy: ['The loan payment is 1200 zł.', 'The microphone is muted.'],
  },
  {
    topic: 'disk', queries: ['ile mam miejsca na dysku', 'which folder uses the most space', 'disk almost full solution', 'sprawdź zajętość SSD'],
    positives: ['Najwięcej miejsca zajmują pliki tymczasowe i stare kopie zapasowe.', 'Find the largest folders before deleting anything.', 'The system drive has 4 GB free, so updates may fail.', 'SSD occupancy is calculated from allocated blocks.'],
    hard: ['Dysk SSD ma dwa lata.', 'The disk is formatted as NTFS.', 'The backup disk is external.', 'The disk model is Samsung 990.'],
    easy: ['The stack trace shows a null value.', 'W czwartek jest przegląd projektu.'],
  },
];

function semanticPairs() {
  const rows = [];
  for (const topic of SEMANTIC_TOPICS) {
    for (const query of topic.queries) {
      for (const passage of topic.positives) rows.push({ query, text: passage, label: 'match', group: topic.topic, features: similarityFeatures(query, passage) });
      for (const passage of topic.hard) rows.push({ query, text: passage, label: 'no-match', group: topic.topic, hard: true, features: similarityFeatures(query, passage) });
      for (const passage of topic.easy) rows.push({ query, text: passage, label: 'no-match', group: topic.topic, hard: false, features: similarityFeatures(query, passage) });
    }
  }
  return rows;
}

/* ── context importance ──────────────────────────────────────────────── */

function contextFeatures(query, chunk, { position = 0, recency = 0.5, prior = 0.2 } = {}) {
  const q = new Set(tokens(query));
  const c = new Set(tokens(chunk));
  let shared = 0;
  for (const token of q) if (c.has(token)) shared += 1;
  const overlap = q.size ? shared / q.size : 0;
  const qn = numbersOf(query);
  const cn = new Set(numbersOf(chunk));
  const numberMatch = qn.length ? qn.filter((number) => cn.has(number)).length / qn.length : 0;
  const constraint = /\b(musisz|nie wolno|tylko|najpierw|przed|deadline|must|only|never|before|after|without|wymaga)\b/i.test(fold(chunk)) ? 1 : 0;
  const goal = /\b(celem|zadanie|trzeba|należy|need|should|require|goal|task|deliver)\b/i.test(fold(chunk)) ? 1 : 0;
  const entity = (String(chunk).match(/\b[A-ZŁŚŻŹĆŃÓ][a-ząćęłńóśźż]{2,}|\b\d{4}-\d{2}-\d{2}\b/g) || []).length > 0 ? 1 : 0;
  const length = Math.min(1, tokens(chunk).length / 80);
  return [overlap, numberMatch, constraint, goal, entity, Number(recency), length, Math.max(0, Math.min(1, Number(position) / 12)), Number(prior)].map((value) => Number(Number(value).toFixed(6)));
}

function contextBaseline(features) {
  const score = features[0] * 0.4 + features[1] * 0.2 + features[2] * 0.25 + features[3] * 0.15 + features[4] * 0.1;
  return score >= 0.55 ? 'critical' : score >= 0.25 ? 'useful' : 'background';
}

const CONTEXT_SCENARIOS = [
  { id: 'deploy', query: 'zaplanuj wdrożenie w czwartek, nie wolno stracić danych', critical: ['Wdrożenie odbędzie się w czwartek o 10:00. Najpierw wykonaj backup i sprawdź sumę kontrolną.', 'Nie wolno uruchamiać migracji bez kopii; rollback jest obowiązkowy.'], useful: ['Zespół wdrożeniowy używa feature flag.', 'Okno wdrożenia trwa 30 minut.'], background: ['Kawa w biurze jest dostępna od 8:00.', 'Strona projektu ma niebieski nagłówek.', 'W zeszłym roku używaliśmy innego narzędzia.', 'Dokumentacja jest w folderze docs.', 'Serwer testowy ma 16 GB RAM.'] },
  { id: 'gpu', query: 'obniż temperaturę GPU bez utraty wydajności', critical: ['Ustaw limit mocy 80% i sprawdź temperaturę pod obciążeniem; nie wyłączaj zabezpieczeń.', 'Najpierw popraw przepływ powietrza, potem zmieniaj krzywą wentylatorów.'], useful: ['Undervolting może obniżyć temperaturę przy podobnych zegarach.', 'Monitoruj hot spot, nie tylko średnią.'], background: ['Karta ma 8 GB VRAM.', 'Zasilacz ma 650 W.', 'Monitor obsługuje 144 Hz.', 'System ma 32 GB RAM.', 'Sterownik ma wersję 566.'] },
  { id: 'security', query: 'zbadaj podejrzane logowanie i zabezpiecz konto', critical: ['Najpierw unieważnij sesje i zmień hasło; nie usuwaj logów.', 'Sprawdź, czy nieudane logowania pochodzą z wielu adresów.'], useful: ['Włącz uwierzytelnianie dwuskładnikowe.', 'Powiąż zdarzenie z historią logowań.'], background: ['Firewall ma domyślną politykę.', 'Audyt był w zeszłym miesiącu.', 'Konto ma awatar.', 'VPN używa portu 7879.', 'Notatka o projekcie alfa.'] },
  { id: 'backup', query: 'przywróć kopię zapasową po awarii dysku', critical: ['Przywróć z zweryfikowanej migawki i sprawdź sumę kontrolną przed zapisem.', 'Nie nadpisuj bieżących danych bez potwierdzenia.'], useful: ['Migawki są przechowywane poza komputerem.', 'Po przywróceniu uruchom test integralności.'], background: ['Backup jest tworzony w niedzielę.', 'Dysk zewNętrzny ma 2 TB.', 'Kawa jest w kuchni.', 'Testy przeszły po refaktorze.', 'Projekt ma nowy terminarz.'] },
  { id: 'code', query: 'napraw testy, które nie przechodzą po refaktorze', critical: ['Najpierw porównaj zmieniony kontrakt funkcji i ślad stosu; nie wyłączaj testu.', 'Poprawka musi przejść cały zestaw testów i nie zmieniać API.'], useful: ['Uruchom pojedynczy test w izolacji.', 'Sprawdź, czy błąd występuje na czystej kopii.'], background: ['Repozytorium ma 342 narzędzia.', 'Node.js ma wersję 22.', 'CI używa czterech rdzeni.', 'Folder docs zawiera raport.', 'Kod ma 60 tysięcy linii.'] },
  { id: 'calendar', query: 'co mam w czwartek i czy koliduje z audytem', critical: ['W czwartek o 10:00 jest przegląd projektu, a audyt jest o 9:30 — terminy kolidują.', 'Audyt ma najwyższy priorytet; przenieś przegląd.'], useful: ['Spotkanie trwa 60 minut.', 'Klient potwierdził obecność.'], background: ['Kalendarz jest zsynchronizowany.', 'Pokój ma projektor.', 'W piątek jest wolne.', 'Notatka o urlopie.', 'Kawa jest o ósmej.'] },
  { id: 'research', query: 'porównaj źródła o GraphRAG i wskaż sprzeczności', critical: ['Raport musi cytować źródła i oznaczyć sprzeczne twierdzenia.', 'Nie przedstawiaj streszczenia bez lokalizacji cytatu.'], useful: ['GraphRAG łączy graf i wektory.', 'Jedno źródło jest starsze niż drugie.'], background: ['Biblioteka ma 200 książek.', 'Folder research jest duży.', 'Internet działa.', 'Model ma 9B parametrów.', 'Kawa jest zimna.'] },
  { id: 'finance', query: 'policz ratę kredytu na 24 miesiące i koszt całkowity', critical: ['Rata musi uwzględniać oprocentowanie, prowizję i 24 miesiące; podaj założenia.', 'Nie zaokrąglaj kosztu całkowitego do złotówki bez zaznaczenia.'], useful: ['Użyj wzoru na ratę annuitetową.', 'Sprawdź, czy prowizja jest jednorazowa.'], background: ['Bank ma oddział w centrum.', 'Umowa jest PDF-em.', 'Kalkulator jest online.', 'Waluta to PLN.', 'Klient ma 30 lat.'] },
  { id: 'devices', query: 'połącz telefon z agentem i sprawdź tunel', critical: ['Telefon musi użyć tego samego klucza PSK; najpierw sprawdź port 7879.', 'Nie wyłączaj uwierzytelniania tunelu.'], useful: ['Tunel używa AES-256-GCM.', 'Pairing wymaga kodu jednorazowego.'], background: ['Telefon ma 128 GB.', 'Wi-Fi ma 5 GHz.', 'ESP32 ma przekaźnik.', 'Kabel USB jest nowy.', 'Aplikacja ma ciemny motyw.'] },
  { id: 'memory', query: 'przypomnij ustalenia o projekcie alfa', critical: ['W projekcie alfa wdrożenia są w czwartki, a właścicielem jest Marta.', 'Decyzja o migracji bazy pozostaje otwarta.'], useful: ['Ostatnia rozmowa była dwa dni temu.', 'Notatka zawiera trzy decyzje.'], background: ['Pamięć ma 150 rekordów.', 'Baza jest SQLite.', 'Embedding ma 384 wymiary.', 'Użytkownik lubi kawę.', 'System ma 32 GB RAM.'] },
  { id: 'email', query: 'napisz maila do zespołu o przesunięciu wdrożenia', critical: ['Mail musi podać nowy termin i przeprosić za zmianę; nie wysyłaj bez zatwierdzenia.', 'Odbiorcy to zespół wdrożeniowy.'], useful: ['Nowy termin to piątek 11:00.', 'Dołącz checklistę.'], background: ['Firma ma 20 pracowników.', 'Mail jest w języku polskim.', 'Podpis zawiera telefon.', 'Kawa jest w kuchni.', 'Folder wysłane ma 300 wiadomości.'] },
  { id: 'gaming', query: 'przygotuj tryb gaming bez psucia stabilności', critical: ['Nie wyłączaj zabezpieczeń systemu; zamknij tylko aplikacje z jawnymi stratami.', 'Zmierząj FPS przed i po, nie zgłaszaj wymyślonego zysku.'], useful: ['Tryb gaming zwalnia VRAM i wycisza agenta.', 'Użyj pomiaru p50/p95.'], background: ['Monitor ma 144 Hz.', 'Gra waży 80 GB.', 'Karta ma 8 GB VRAM.', 'Pada deszcz.', 'Klawiatura jest mechaniczna.'] },
  { id: 'windows', query: 'napraw explorer zużywający CPU', critical: ['Sprawdź, czy explorer skanuje folder sieciowy; nie usuwaj kluczy rejestru.', 'Zmiana autostartu musi być odwracalna.'], useful: ['Użyj menedżera zadań.', 'Sprawdź dziennik zdarzeń.'], background: ['Windows ma motyw ciemny.', 'Dysk C ma 4 GB wolnego.', 'Monitor ma 144 Hz.', 'Kawa jest w kuchni.', 'Folder pobrane jest duży.'] },
  { id: 'voice', query: 'napraw mikrofon, który nie nagrywa', critical: ['Sprawdź uprawnienia mikrofonu i właściwe urządzenie wejściowe; nie nagrywaj bez zgody.', 'Wybierz mikrofon zestawu słuchawkowego.'], useful: ['Wejście audio może być wyciszone.', 'Sterownik ma wersję 10.0.'], background: ['Zestaw ma RGB.', 'Komputer ma 32 GB RAM.', 'Kawa jest zimna.', 'Monitor ma 144 Hz.', 'System ma 60 tysięcy linii.'] },
  { id: 'disk', query: 'znajdź, co zajmuje miejsce na dysku, i zwolnij je bezpiecznie', critical: ['Nie usuwaj plików systemowych ani kopii zapasowych bez potwierdzenia.', 'Najpierw wskaż największe foldery i sprawdź, co można przenieść.'], useful: ['Pliki tymczasowe można usunąć przez narzędzie systemowe.', 'Stare migawki zajmują miejsce.'], background: ['Dysk ma 2 TB.', 'Folder pobrane jest duży.', 'Kawa jest w kuchni.', 'Monitor ma 144 Hz.', 'System ma 32 GB RAM.'] },
  { id: 'tests', query: 'dodaj testy regresji dla poprawki i sprawdź cały zestaw', critical: ['Test musi odtwarzać błąd przed poprawką i przechodzić po niej.', 'Nie oznaczaj testu jako zaliczonego, jeśli został pominięty.'], useful: ['Uruchom testy na czystej kopii.', 'Dodaj przypadek graniczny.'], background: ['Test suite ma 249 przypadków.', 'Node.js ma wersję 22.', 'CI ma cztery rdzenie.', 'Folder test ma 3 tysiące linii.', 'Kawa jest zimna.'] },
  { id: 'travel', query: 'zaplanuj podróż do Krakowa na konferencję w piątek', critical: ['Musisz być na miejscu przed 9:00; wyjazd w czwartek wieczorem.', 'Nie rezerwuj nieodwracalnego biletu bez zatwierdzenia.'], useful: ['Pociąg jedzie dwie godziny.', 'Hotel jest blisko dworca.'], background: ['Kraków ma 800 tysięcy mieszkańców.', 'Pada deszcz.', 'Kawa jest w kuchni.', 'Walizka jest czerwona.', 'Konferencja ma 300 uczestników.'] },
  { id: 'health', query: 'przypomnij o lekach i sprawdź, czy nie ma interakcji', critical: ['Nie zmieniaj dawki bez lekarza; to nie jest porada medyczna.', 'Przypomnienie ma być o 8:00 i 20:00.'], useful: ['Notatka zawiera nazwę leku.', 'Interakcje trzeba sprawdzić w oficjalnym źródle.'], background: ['Apteka jest otwarta do 21:00.', 'Kawa jest w kuchni.', 'System ma 32 GB RAM.', 'Pada deszcz.', 'Telefon ma 128 GB.'] },
];

function contextItems() {
  const rows = [];
  const frames = ['', 'proszę o pomoc: ', 'muszę: ', 'zadanie: '];
  for (const scenario of CONTEXT_SCENARIOS) {
    const entries = [
      ...scenario.critical.map((text, index) => ({ text, label: 'critical', position: index })),
      ...scenario.useful.map((text, index) => ({ text, label: 'useful', position: scenario.critical.length + index })),
      ...scenario.background.map((text, index) => ({ text, label: 'background', position: scenario.critical.length + scenario.useful.length + index })),
    ];
    entries.forEach((entry, index) => {
      const recency = Math.max(0, 1 - index / Math.max(1, entries.length));
      for (const frame of frames) {
        const query = `${frame}${scenario.query}`;
        const features = contextFeatures(query, entry.text, { position: entry.position, recency, prior: entry.label === 'background' ? 0.1 : 0.5 });
        rows.push({ query, text: entry.text, label: entry.label, group: scenario.id, features });
      }
    });
  }
  return rows;
}

/* ── failure risk ────────────────────────────────────────────────────── */

const FAILURE_PROFILES = [
  { id: 'read-system', permission: 'read', network: false, timeoutMs: 15000, dangerous: false },
  { id: 'read-network', permission: 'network', network: true, timeoutMs: 20000, dangerous: false },
  { id: 'write-files', permission: 'write', network: false, timeoutMs: 30000, dangerous: false },
  { id: 'write-network', permission: 'write', network: true, timeoutMs: 30000, dangerous: false },
  { id: 'system-power', permission: 'system', network: false, timeoutMs: 60000, dangerous: true },
  { id: 'system-service', permission: 'system', network: true, timeoutMs: 60000, dangerous: true },
  { id: 'privileged-install', permission: 'privileged', network: true, timeoutMs: 120000, dangerous: true },
  { id: 'device-serial', permission: 'write', network: false, timeoutMs: 10000, dangerous: false },
  { id: 'research-online', permission: 'network', network: true, timeoutMs: 90000, dangerous: false },
  { id: 'patch-apply', permission: 'system', network: false, timeoutMs: 120000, dangerous: true },
];

function failureFeatures(descriptor) {
  const permissionRank = { read: 0, network: 1, write: 2, system: 3, privileged: 4 }[descriptor.permission] ?? 1;
  const args = descriptor.args && typeof descriptor.args === 'object' ? Object.keys(descriptor.args).length : 0;
  let bytes = 0;
  try { bytes = JSON.stringify(descriptor.args || {}).length; } catch { bytes = 0; }
  return [
    Number(permissionRank) / 4,
    descriptor.requiresNetwork || descriptor.network ? 1 : 0,
    Math.min(1, args / 12),
    Math.min(1, bytes / 8000),
    Math.min(1, 30000 / Math.max(1000, Number(descriptor.timeoutMs) || 30000)),
    Math.min(1, Number(descriptor.retries) / 5),
    Math.min(1, Number(descriptor.recentFailures) / 10),
    descriptor.approval ? 1 : 0,
    Math.min(1, Number(descriptor.concurrentCalls) / 10),
    Math.min(1, Number(descriptor.dependencyDepth) / 5),
    Math.min(1, Number(descriptor.queueDelayMs) / 30000),
    descriptor.payloadRisk ? 1 : 0,
  ].map((value) => Number(Number(value).toFixed(6)));
}

/**
 * The rubric is intentionally non-linear. The baseline is a linear score, so a
 * learned model can only earn its gate by capturing the interactions.
 */
function failureLabel(features) {
  const [permission, network, args, bytes, timeoutPressure, retries, recentFailures, approval, concurrent, depth, queue, payload] = features;
  let score = permission * 0.16 + network * 0.10 + args * 0.10 + bytes * 0.06 + timeoutPressure * 0.08 + retries * 0.08 + recentFailures * 0.16 + concurrent * 0.08 + depth * 0.05 + queue * 0.05 + payload * 0.10;
  if (network && !approval) score += 0.14;
  if (recentFailures > 0.4 && retries > 0.4) score += 0.18;
  if (permission >= 0.75 && bytes > 0.5) score += 0.12;
  if (concurrent > 0.5 && timeoutPressure > 0.6) score += 0.10;
  return score >= 0.72 ? 'high' : score >= 0.42 ? 'elevated' : 'low';
}

function failureBaseline(features) {
  const score = features[0] * 0.2 + features[1] * 0.12 + features[2] * 0.10 + features[3] * 0.08 + features[4] * 0.08 + features[5] * 0.08 + features[6] * 0.16 + features[7] * -0.06 + features[8] * 0.08 + features[9] * 0.04 + features[10] * 0.04 + features[11] * 0.10;
  return score >= 0.55 ? 'high' : score >= 0.3 ? 'elevated' : 'low';
}

function failureItems() {
  const rows = [];
  for (const profile of FAILURE_PROFILES) {
    for (let index = 0; index < 72; index += 1) {
      const descriptor = {
        permission: profile.permission,
        requiresNetwork: profile.network,
        timeoutMs: profile.timeoutMs,
        args: Object.fromEntries(Array.from({ length: (index % 9) + 1 }, (_, key) => [`arg${key}`, 'x'.repeat((index * 13 + key * 7) % 120)])),
        retries: index % 6,
        recentFailures: (index * 3) % 9,
        approval: index % 4 !== 0,
        concurrentCalls: (index * 2) % 9,
        dependencyDepth: index % 5,
        queueDelayMs: (index * 1700) % 25000,
        payloadRisk: index % 11 === 0,
      };
      const features = failureFeatures(descriptor);
      rows.push({ ...descriptor, features, label: failureLabel(features), group: profile.id });
    }
  }
  return rows;
}

function labelCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.label] = (counts[row.label] || 0) + 1;
  return counts;
}

const semanticItems = semanticPairs();
const contextItemsList = contextItems();
const failureItemsList = failureItems();

module.exports = {
  semantic: {
    task: 'semantic-similarity', items: semanticItems, labels: ['match', 'no-match'], baseline: similarityBaseline,
    featureNames: ['jaccard', 'query-containment', 'aspect-overlap', 'trigram-cosine', 'number-match', 'negation-mismatch', 'length-ratio', 'exact-phrase'],
    splitBy: 'group', provenance: 'authored bilingual query/passage pairs with hard same-topic negatives',
    counts: labelCounts(semanticItems), similarityFeatures,
  },
  context: {
    task: 'context-importance', items: contextItemsList, labels: ['background', 'critical', 'useful'], baseline: contextBaseline,
    featureNames: ['query-overlap', 'number-match', 'constraint-cue', 'goal-cue', 'entity-cue', 'recency', 'length', 'position', 'prior'],
    splitBy: 'group', provenance: 'authored scenarios with critical, useful and background chunks',
    counts: labelCounts(contextItemsList), contextFeatures,
  },
  failure: {
    task: 'failure-prediction', items: failureItemsList, labels: ['elevated', 'high', 'low'], baseline: failureBaseline,
    featureNames: ['permission', 'network', 'arg-count', 'arg-bytes', 'timeout-pressure', 'retries', 'recent-failures', 'approval', 'concurrency', 'dependency-depth', 'queue-delay', 'payload-risk'],
    splitBy: 'group', provenance: 'synthetic operational scenarios labelled by the documented rubric, not observed incidents',
    counts: labelCounts(failureItemsList), failureFeatures,
  },
};

module.exports.similarityFeatures = similarityFeatures;
module.exports.contextFeatures = contextFeatures;
module.exports.failureFeatures = failureFeatures;
module.exports.labelCounts = labelCounts;
