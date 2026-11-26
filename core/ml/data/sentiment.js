'use strict';

/**
 * Synthetic sentiment corpus for the compact transformer experiment.
 *
 * Sentences are generated from authored Polish/English word banks and templates
 * by a deterministic schedule. Nothing is scraped and no user text is used.
 * Splitting is by subject (`group`), so the held-out subjects are genuinely
 * unseen while sentiment words remain shared — this measures generalisation,
 * not memorisation of a subject name.
 */

const SUBJECTS = [
  'nowy SENTINEL', 'ostatnia aktualizacja', 'aplikacja bankowa', 'sklep internetowy',
  'klient z Gdańska', 'projekt alfa', 'serwer produkcyjny', 'kopia zapasowa',
  'the new laptop', 'the last update', 'the support portal', 'the build pipeline',
  'the office printer', 'the mobile app', 'the database migration', 'the release candidate',
  'zespół wsparcia', 'interfejs użytkownika', 'paczka z aktualizacją', 'harmonogram projektu',
  'the backup restore', 'the network tunnel', 'the desktop client', 'the deployment script',
];

const POSITIVE_ADJECTIVES = ['szybki', 'stabilny', 'niezawodny', 'czytelny', 'wygodny', 'uprzejmy', 'pomocny', 'świetny', 'solidny', 'efektywny', 'fast', 'stable', 'reliable', 'clear', 'convenient', 'helpful', 'excellent', 'solid', 'efficient', 'pleasant'];
const NEGATIVE_ADJECTIVES = ['wolny', 'niestabilny', 'awaryjny', 'nieczytelny', 'niewygodny', 'opryskliwy', 'bezużyteczny', 'okropny', 'zawodny', 'nieefektywny', 'slow', 'unstable', 'unreliable', 'confusing', 'inconvenient', 'rude', 'useless', 'awful', 'broken', 'inefficient'];
const POSITIVE_VERBS = ['działa bez problemu', 'oszczędza czas', 'przechodzi testy', 'spełnia oczekiwania', 'zaskakuje na plus', 'works without problems', 'saves time', 'passes the tests', 'meets expectations', 'exceeds expectations'];
const NEGATIVE_VERBS = ['ciągle się psuje', 'marnuje czas', 'wysypuje się', 'nie spełnia oczekiwań', 'blokuje pracę', 'keeps breaking', 'wastes time', 'crashes', 'fails expectations', 'blocks work'];
const NEUTRAL_FACTS = [
  'ma trzy sekcje i tabelę', 'został opublikowany w czwartek', 'zajmuje dwieście kilobajtów', 'opisuje cztery etapy', 'ma domyślne ustawienia', 'zawiera pięć wpisów', 'jest przypisany do projektu', 'ma parametr temperatury',
  'has three sections and a table', 'was published on Thursday', 'is two hundred kilobytes', 'describes four stages', 'uses default settings', 'contains five entries', 'is assigned to the project', 'has a temperature parameter',
];

const prefixes = ['', 'Moim zdaniem ', 'Szczerze mówiąc, ', 'Ogólnie ', 'I think ', 'Honestly, ', 'Overall '];
const items = [];

SUBJECTS.forEach((subject, subjectIndex) => {
  const group = `subject:${subject}`;
  for (let index = 0; index < 10; index += 1) {
    const adjective = POSITIVE_ADJECTIVES[(subjectIndex + index) % POSITIVE_ADJECTIVES.length];
    const verb = POSITIVE_VERBS[(subjectIndex + index) % POSITIVE_VERBS.length];
    const prefix = prefixes[(subjectIndex + index) % prefixes.length];
    items.push({ text: `${prefix}${subject} jest ${adjective} i ${verb}`.replace('  ', ' '), label: 'positive', group });
  }
  for (let index = 0; index < 10; index += 1) {
    const adjective = NEGATIVE_ADJECTIVES[(subjectIndex + index) % NEGATIVE_ADJECTIVES.length];
    const verb = NEGATIVE_VERBS[(subjectIndex + index) % NEGATIVE_VERBS.length];
    const prefix = prefixes[(subjectIndex + index + 2) % prefixes.length];
    items.push({ text: `${prefix}${subject} jest ${adjective} i ${verb}`.replace('  ', ' '), label: 'negative', group });
  }
  for (let index = 0; index < 8; index += 1) {
    const fact = NEUTRAL_FACTS[(subjectIndex + index) % NEUTRAL_FACTS.length];
    const prefix = prefixes[(subjectIndex + index + 4) % prefixes.length];
    items.push({ text: `${prefix}${subject} ${fact}`.replace('  ', ' '), label: 'neutral', group });
  }
});

const LEXICON = {
  positive: ['dobr', 'szybk', 'zadowolon', 'najlepsz', 'stabiln', 'niezawodn', 'czyteln', 'wygodn', 'uprzejm', 'pomocn', 'świetn', 'solidn', 'efektywn', 'bez problemu', 'oszczędza', 'spełnia oczekiwania', 'zaskakuje', 'happy', 'excellent', 'reliable', 'fast', 'clear', 'convenient', 'helpful', 'recommend', 'smooth', 'stable', 'efficient', 'pleasant', 'meets expectations', 'exceeds', 'works'],
  negative: ['wolno', 'niestabiln', 'awaryjn', 'nieczyteln', 'niewygodn', 'opryskliw', 'bezużyteczn', 'okropn', 'zawodn', 'nieefektywn', 'psuje', 'marnuje', 'wysypuje', 'nie spełnia', 'blokuje', 'disappointed', 'terrible', 'wasted', 'confusing', 'failed', 'rude', 'useless', 'worst', 'frustrating', 'unstable', 'broken', 'crashes', 'fails', 'blocks', 'slow', 'unreliable'],
};

function baseline(text) {
  const folded = String(text).toLowerCase();
  let positive = 0;
  let negative = 0;
  for (const word of LEXICON.positive) if (folded.includes(word)) positive += 1;
  for (const word of LEXICON.negative) if (folded.includes(word)) negative += 1;
  if (positive > negative) return 'positive';
  if (negative > positive) return 'negative';
  return 'neutral';
}

module.exports = { items, labels: ['negative', 'neutral', 'positive'], baseline, source: 'authored synthetic bilingual templates, split by subject; no user data' };
