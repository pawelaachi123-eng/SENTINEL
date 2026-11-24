'use strict';

/**
 * Multilingual intent dataset for the learning lab.
 *
 * Provenance: written for this project as synthetic, non-sensitive examples.
 * No user conversation, file or private text is included. It is intentionally
 * small and bilingual (Polish/English) and includes typos, slang and
 * diacritic-free spellings so the held-out score is not inflated by clean text.
 */

module.exports = {
  version: '1.0.0',
  provenance: 'synthetic, project-authored, non-sensitive',
  license: 'MIT (same as this repository)',
  items: [
    { intent: 'status', lang: 'pl', text: 'jaki jest stan komputera' },
    { intent: 'status', lang: 'pl', text: 'sprawdz cpu i ram' },
    { intent: 'status', lang: 'pl', text: 'ile pamieci jest wolnej' },
    { intent: 'status', lang: 'pl', text: 'pokaz temperature gpu' },
    { intent: 'status', lang: 'pl', text: 'co tam z dyskiem' },
    { intent: 'status', lang: 'pl', text: 'obciazenie procesora teraz' },
    { intent: 'status', lang: 'pl', text: 'czy komputer sie grzeje' },
    { intent: 'status', lang: 'pl', text: 'stan baterii i zasilania' },
    { intent: 'status', lang: 'en', text: 'what is the computer status' },
    { intent: 'status', lang: 'en', text: 'check cpu and ram usage' },
    { intent: 'status', lang: 'en', text: 'how much free memory is there' },
    { intent: 'status', lang: 'en', text: 'show gpu temperature and vram' },
    { intent: 'status', lang: 'en', text: 'is the cpu overheating' },
    { intent: 'status', lang: 'en', text: 'disk space please' },
    { intent: 'status', lang: 'en', text: 'system load right now' },
    { intent: 'status', lang: 'en', text: 'battery and power state' },

    { intent: 'files', lang: 'pl', text: 'znajdz plik raport w dokumentach' },
    { intent: 'files', lang: 'pl', text: 'co jest w folderze pobrane' },
    { intent: 'files', lang: 'pl', text: 'przenies plik do archiwum' },
    { intent: 'files', lang: 'pl', text: 'usun stare logi z katalogu' },
    { intent: 'files', lang: 'pl', text: 'pokaz rozmiar tego folderu' },
    { intent: 'files', lang: 'pl', text: 'skopiuj zdjecia na dysk zewnetrzny' },
    { intent: 'files', lang: 'pl', text: 'jakie pliki zmienily sie dzisiaj' },
    { intent: 'files', lang: 'pl', text: 'otworz katalog projektu' },
    { intent: 'files', lang: 'en', text: 'find the report file in documents' },
    { intent: 'files', lang: 'en', text: 'list files in the downloads folder' },
    { intent: 'files', lang: 'en', text: 'move this file to archive' },
    { intent: 'files', lang: 'en', text: 'delete old logs from the directory' },
    { intent: 'files', lang: 'en', text: 'show the size of this folder' },
    { intent: 'files', lang: 'en', text: 'copy pictures to the external drive' },
    { intent: 'files', lang: 'en', text: 'which files changed today' },
    { intent: 'files', lang: 'en', text: 'open the project directory' },

    { intent: 'memory', lang: 'pl', text: 'zapamietaj ze mam 32 gb ram' },
    { intent: 'memory', lang: 'pl', text: 'co pamietasz o moim komputerze' },
    { intent: 'memory', lang: 'pl', text: 'przypomnij moje preferencje' },
    { intent: 'memory', lang: 'pl', text: 'zapisz to na pozniej' },
    { intent: 'memory', lang: 'pl', text: 'jakie mamy ustalenia w projekcie' },
    { intent: 'memory', lang: 'pl', text: 'zapomnij stare notatki' },
    { intent: 'memory', lang: 'pl', text: 'pokaz sprzeczne informacje w pamieci' },
    { intent: 'memory', lang: 'pl', text: 'co ustalilismy ostatnio' },
    { intent: 'memory', lang: 'en', text: 'remember that i have 32 gb ram' },
    { intent: 'memory', lang: 'en', text: 'what do you remember about my pc' },
    { intent: 'memory', lang: 'en', text: 'recall my preferences' },
    { intent: 'memory', lang: 'en', text: 'save this for later' },
    { intent: 'memory', lang: 'en', text: 'what did we decide for this project' },
    { intent: 'memory', lang: 'en', text: 'forget the old notes' },
    { intent: 'memory', lang: 'en', text: 'show contradictory memories' },
    { intent: 'memory', lang: 'en', text: 'what did we agree last time' },

    { intent: 'code', lang: 'pl', text: 'napraw blad w pliku javascript' },
    { intent: 'code', lang: 'pl', text: 'znajdz funkcje ktora to liczy' },
    { intent: 'code', lang: 'pl', text: 'dodaj test jednostkowy' },
    { intent: 'code', lang: 'pl', text: 'zrefaktoruj te klase' },
    { intent: 'code', lang: 'pl', text: 'gdzie jest uzywana ta zmienna' },
    { intent: 'code', lang: 'pl', text: 'zrob przeglad kodu' },
    { intent: 'code', lang: 'pl', text: 'napisz dokumentacje do api' },
    { intent: 'code', lang: 'pl', text: 'uruchom testy i pokaz bledy' },
    { intent: 'code', lang: 'en', text: 'fix the bug in the javascript file' },
    { intent: 'code', lang: 'en', text: 'find the function that computes this' },
    { intent: 'code', lang: 'en', text: 'add a unit test for it' },
    { intent: 'code', lang: 'en', text: 'refactor this class' },
    { intent: 'code', lang: 'en', text: 'where is this variable used' },
    { intent: 'code', lang: 'en', text: 'review the code please' },
    { intent: 'code', lang: 'en', text: 'write api documentation' },
    { intent: 'code', lang: 'en', text: 'run the tests and show failures' },

    { intent: 'documents', lang: 'pl', text: 'przeczytaj pdf i streść najwazniejsze punkty' },
    { intent: 'documents', lang: 'pl', text: 'co pisze w umowie o gwarancji' },
    { intent: 'documents', lang: 'pl', text: 'porownaj dwie wersje dokumentu' },
    { intent: 'documents', lang: 'pl', text: 'wyciagnij tabele z arkusza' },
    { intent: 'documents', lang: 'pl', text: 'znajdz informacje w notatkach' },
    { intent: 'documents', lang: 'pl', text: 'streść ten raport' },
    { intent: 'documents', lang: 'pl', text: 'zrob notatke z tego dokumentu' },
    { intent: 'documents', lang: 'pl', text: 'jakie sa wnioski w tym tekscie' },
    { intent: 'documents', lang: 'en', text: 'read the pdf and summarize the key points' },
    { intent: 'documents', lang: 'en', text: 'what does the contract say about warranty' },
    { intent: 'documents', lang: 'en', text: 'compare two versions of the document' },
    { intent: 'documents', lang: 'en', text: 'extract the table from the spreadsheet' },
    { intent: 'documents', lang: 'en', text: 'find information in my notes' },
    { intent: 'documents', lang: 'en', text: 'summarize this report' },
    { intent: 'documents', lang: 'en', text: 'take notes from this document' },
    { intent: 'documents', lang: 'en', text: 'what are the conclusions in this text' },

    { intent: 'network', lang: 'pl', text: 'sprawdz czy internet dziala' },
    { intent: 'network', lang: 'pl', text: 'jaki mam adres ip' },
    { intent: 'network', lang: 'pl', text: 'ping do google' },
    { intent: 'network', lang: 'pl', text: 'dlaczego wifi nie laczy' },
    { intent: 'network', lang: 'pl', text: 'pokaz otwarte porty' },
    { intent: 'network', lang: 'pl', text: 'przetestuj predkosc lacza' },
    { intent: 'network', lang: 'pl', text: 'jaki jest serwer dns' },
    { intent: 'network', lang: 'pl', text: 'czy host odpowiada' },
    { intent: 'network', lang: 'en', text: 'check if the internet works' },
    { intent: 'network', lang: 'en', text: 'what is my ip address' },
    { intent: 'network', lang: 'en', text: 'ping google' },
    { intent: 'network', lang: 'en', text: 'why is wifi not connecting' },
    { intent: 'network', lang: 'en', text: 'show open ports' },
    { intent: 'network', lang: 'en', text: 'test the connection speed' },
    { intent: 'network', lang: 'en', text: 'what dns server am i using' },
    { intent: 'network', lang: 'en', text: 'is the host reachable' },

    { intent: 'planning', lang: 'pl', text: 'zaplanuj aktualizacje systemu' },
    { intent: 'planning', lang: 'pl', text: 'podziel to zadanie na kroki' },
    { intent: 'planning', lang: 'pl', text: 'co powinienem zrobic najpierw' },
    { intent: 'planning', lang: 'pl', text: 'ustal harmonogram na jutro' },
    { intent: 'planning', lang: 'pl', text: 'przygotuj plan wdrozenia' },
    { intent: 'planning', lang: 'pl', text: 'zrob liste zadan' },
    { intent: 'planning', lang: 'pl', text: 'jak zorganizowac te prace' },
    { intent: 'planning', lang: 'pl', text: 'zaplanuj backup i sprawdzenie' },
    { intent: 'planning', lang: 'en', text: 'plan the system update' },
    { intent: 'planning', lang: 'en', text: 'break this task into steps' },
    { intent: 'planning', lang: 'en', text: 'what should i do first' },
    { intent: 'planning', lang: 'en', text: 'make a schedule for tomorrow' },
    { intent: 'planning', lang: 'en', text: 'prepare a deployment plan' },
    { intent: 'planning', lang: 'en', text: 'create a task list' },
    { intent: 'planning', lang: 'en', text: 'how should i organize this work' },
    { intent: 'planning', lang: 'en', text: 'plan backup and verification' },

    { intent: 'security', lang: 'pl', text: 'sprawdz czy system jest bezpieczny' },
    { intent: 'security', lang: 'pl', text: 'czy sa podejrzane procesy' },
    { intent: 'security', lang: 'pl', text: 'pokaz ostatnie proby logowania' },
    { intent: 'security', lang: 'pl', text: 'zablokuj dostep do folderu' },
    { intent: 'security', lang: 'pl', text: 'sprawdz uprawnienia pliku' },
    { intent: 'security', lang: 'pl', text: 'czy ktos obcy ma dostep' },
    { intent: 'security', lang: 'pl', text: 'włącz firewall' },
    { intent: 'security', lang: 'pl', text: 'sprawdz integralnosc backupu' },
    { intent: 'security', lang: 'en', text: 'check whether the system is secure' },
    { intent: 'security', lang: 'en', text: 'are there suspicious processes' },
    { intent: 'security', lang: 'en', text: 'show recent login attempts' },
    { intent: 'security', lang: 'en', text: 'block access to the folder' },
    { intent: 'security', lang: 'en', text: 'check file permissions' },
    { intent: 'security', lang: 'en', text: 'does anyone else have access' },
    { intent: 'security', lang: 'en', text: 'enable the firewall' },
    { intent: 'security', lang: 'en', text: 'verify backup integrity' },

    { intent: 'learning', lang: 'pl', text: 'wytrenuj model rozpoznawania intencji' },
    { intent: 'learning', lang: 'pl', text: 'pokaz wyniki ostatniego treningu' },
    { intent: 'learning', lang: 'pl', text: 'wytrenuj reranker na danych' },
    { intent: 'learning', lang: 'pl', text: 'porownaj model z baseline' },
    { intent: 'learning', lang: 'pl', text: 'uruchom walidacje na zbiorze testowym' },
    { intent: 'learning', lang: 'pl', text: 'zapisz checkpoint modelu' },
    { intent: 'learning', lang: 'pl', text: 'czy nowy model jest lepszy' },
    { intent: 'learning', lang: 'pl', text: 'cofnij wdrozenie modelu' },
    { intent: 'learning', lang: 'en', text: 'train the intent classification model' },
    { intent: 'learning', lang: 'en', text: 'show the results of the last training' },
    { intent: 'learning', lang: 'en', text: 'train a reranker on the data' },
    { intent: 'learning', lang: 'en', text: 'compare the model with the baseline' },
    { intent: 'learning', lang: 'en', text: 'run the held-out evaluation' },
    { intent: 'learning', lang: 'en', text: 'save a model checkpoint' },
    { intent: 'learning', lang: 'en', text: 'is the new model better' },
    { intent: 'learning', lang: 'en', text: 'roll back the model deployment' },

    { intent: 'chat', lang: 'pl', text: 'jak sie masz' },
    { intent: 'chat', lang: 'pl', text: 'dzieki za pomoc' },
    { intent: 'chat', lang: 'pl', text: 'opowiedz cos ciekawego' },
    { intent: 'chat', lang: 'pl', text: 'kim jestes' },
    { intent: 'chat', lang: 'pl', text: 'dobranoc' },
    { intent: 'chat', lang: 'pl', text: 'jak minął dzien' },
    { intent: 'chat', lang: 'pl', text: 'co slychac' },
    { intent: 'chat', lang: 'pl', text: 'lubie twoj styl' },
    { intent: 'chat', lang: 'en', text: 'how are you' },
    { intent: 'chat', lang: 'en', text: 'thanks for the help' },
    { intent: 'chat', lang: 'en', text: 'tell me something interesting' },
    { intent: 'chat', lang: 'en', text: 'who are you' },
    { intent: 'chat', lang: 'en', text: 'good night' },
    { intent: 'chat', lang: 'en', text: 'how was your day' },
    { intent: 'chat', lang: 'en', text: 'what is up' },
    { intent: 'chat', lang: 'en', text: 'i like your style' },
  ],
};

/**
 * Synthetic slot combinations. The hand-written examples above exercise natural
 * phrasing; these combinations give the classifier enough repeated vocabulary
 * to learn intent cues instead of memorising twenty sentences. Both are
 * synthetic and non-sensitive. Combinations are selected deterministically so
 * the dataset hash is stable across platforms.
 */
const FRAMES = {
  status: {
    pl: { verbs: ['sprawdz', 'pokaz', 'zmierz', 'podaj', 'monitoruj'], objects: ['uzycie cpu', 'wolna pamiec ram', 'temperature gpu', 'miejsce na dysku', 'obciazenie systemu', 'stan baterii'], tail: 'teraz' },
    en: { verbs: ['check', 'show', 'measure', 'report', 'monitor'], objects: ['cpu usage', 'free ram', 'gpu temperature', 'disk space', 'system load', 'battery state'], tail: 'now' },
  },
  files: {
    pl: { verbs: ['znajdz', 'pokaz', 'skopiuj', 'przenies', 'posortuj'], objects: ['pliki w folderze', 'raport w dokumentach', 'stare logi', 'zdjecia na dysku', 'katalog projektu', 'rozmiar folderu'], tail: 'bez usuwania' },
    en: { verbs: ['find', 'list', 'copy', 'move', 'sort'], objects: ['files in the folder', 'report in documents', 'old logs', 'pictures on disk', 'project directory', 'folder size'], tail: 'without deleting' },
  },
  memory: {
    pl: { verbs: ['zapamietaj', 'przypomnij', 'zapisz', 'pokaz', 'usun'], objects: ['moje preferencje', 'ustalenia projektu', 'informacje o komputerze', 'stare notatki', 'sprzeczne fakty', 'wazne decyzje'], tail: 'na pozniej' },
    en: { verbs: ['remember', 'recall', 'save', 'show', 'remove'], objects: ['my preferences', 'project decisions', 'information about my pc', 'old notes', 'conflicting facts', 'important decisions'], tail: 'for later' },
  },
  code: {
    pl: { verbs: ['napraw', 'znajdz', 'dodaj', 'zrefaktoruj', 'uruchom'], objects: ['blad w javascript', 'funkcje w pliku', 'test jednostkowy', 'klase w module', 'testy projektu', 'dokumentacje api'], tail: 'i pokaz wynik' },
    en: { verbs: ['fix', 'find', 'add', 'refactor', 'run'], objects: ['the javascript bug', 'the function in the file', 'a unit test', 'the class in the module', 'the project tests', 'the api documentation'], tail: 'and show the result' },
  },
  documents: {
    pl: { verbs: ['przeczytaj', 'streść', 'porownaj', 'wyciagnij', 'znajdz'], objects: ['pdf i kluczowe punkty', 'raport kwartalny', 'dwie wersje umowy', 'tabele z arkusza', 'informacje w notatkach', 'wnioski z dokumentu'], tail: 'z cytatami' },
    en: { verbs: ['read', 'summarize', 'compare', 'extract', 'find'], objects: ['the pdf and key points', 'the quarterly report', 'two contract versions', 'the table from the spreadsheet', 'information in my notes', 'conclusions from the document'], tail: 'with citations' },
  },
  network: {
    pl: { verbs: ['sprawdz', 'przetestuj', 'pokaz', 'zmierz', 'diagnozuj'], objects: ['polaczenie z internetem', 'adres ip', 'otwarte porty', 'serwer dns', 'opoznienie ping', 'sile wifi'], tail: 'teraz' },
    en: { verbs: ['check', 'test', 'show', 'measure', 'diagnose'], objects: ['the internet connection', 'the ip address', 'open ports', 'the dns server', 'ping latency', 'wifi strength'], tail: 'now' },
  },
  planning: {
    pl: { verbs: ['zaplanuj', 'podziel', 'ustal', 'przygotuj', 'zrob'], objects: ['aktualizacje systemu', 'zadanie na kroki', 'harmonogram pracy', 'plan wdrozenia', 'liste zadan', 'kolejnosc dzialan'], tail: 'z terminami' },
    en: { verbs: ['plan', 'break down', 'schedule', 'prepare', 'make'], objects: ['the system update', 'the task into steps', 'the work schedule', 'the deployment plan', 'a task list', 'the order of actions'], tail: 'with deadlines' },
  },
  security: {
    pl: { verbs: ['sprawdz', 'zweryfikuj', 'pokaz', 'zabezpiecz', 'włącz'], objects: ['bezpieczenstwo systemu', 'podejrzane procesy', 'proby logowania', 'uprawnienia pliku', 'integralnosc backupu', 'firewall'], tail: 'i raport' },
    en: { verbs: ['check', 'verify', 'show', 'secure', 'enable'], objects: ['system security', 'suspicious processes', 'login attempts', 'file permissions', 'backup integrity', 'the firewall'], tail: 'and report' },
  },
  learning: {
    pl: { verbs: ['wytrenuj', 'uruchom', 'porownaj', 'pokaz', 'zapisz'], objects: ['model intencji', 'walidacje na zbiorze testowym', 'model z baseline', 'wyniki treningu', 'checkpoint modelu', 'nowy model'], tail: 'z metrykami' },
    en: { verbs: ['train', 'run', 'compare', 'show', 'save'], objects: ['the intent model', 'the held-out evaluation', 'the model with baseline', 'training results', 'a model checkpoint', 'the new model'], tail: 'with metrics' },
  },
  chat: {
    pl: { verbs: ['powiedz', 'opowiedz', 'napisz', 'wyjasnij', 'komentuj'], objects: ['jak sie masz', 'cos ciekawego', 'o swoim stylu', 'co slychac', 'dzieki za pomoc', 'o swoim dniu'], tail: 'krótko' },
    en: { verbs: ['tell', 'say', 'explain', 'comment', 'share'], objects: ['how you are', 'something interesting', 'about your style', 'what is up', 'thanks for the help', 'about your day'], tail: 'briefly' },
  },
};

function generatedExamples() {
  const out = [];
  let state = 0x5eed1234;
  const next = (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
  for (const [intent, langs] of Object.entries(FRAMES)) {
    for (const lang of ['pl', 'en']) {
      const frame = langs[lang];
      const used = new Set();
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const verb = frame.verbs[next(frame.verbs.length)];
        const object = frame.objects[next(frame.objects.length)];
        const text = `${verb} ${object} ${frame.tail}`;
        if (used.has(text)) continue;
        used.add(text);
        out.push({ intent, lang, text });
        if (used.size >= 12) break;
      }
    }
  }
  return out;
}

const handWritten = module.exports.items;
module.exports.items = [...handWritten, ...generatedExamples()];
module.exports.generated = generatedExamples().length;
