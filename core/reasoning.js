'use strict';

/**
 * Bounded reasoning.
 *
 * This is deliberately not a chain-of-thought generator. It is the small,
 * auditable part of reasoning a local assistant can actually be held to:
 *   - hypotheses are derived from observed signals, not invented at random;
 *   - every hypothesis is tied to a concrete measurement (a tool) that could
 *     refute it;
 *   - untested hypotheses are reported as untested, never as supported;
 *   - confidence is a documented function of tests, not a model's opinion;
 *   - contradictory facts are preserved with their sources.
 *
 * The language model may still narrate the result, but it cannot promote a
 * hypothesis: only a measurement can.
 */

const MAX_HYPOTHESES = 8;

const RULES = [
  {
    id: 'cpu-saturation',
    when: (signal) => signal.name === 'cpu.usage' && Number(signal.value) >= 85,
    statement: 'Obciążenie CPU jest nasycone, więc brak responsywności pochodzi od lokalnego obciążenia, a nie od sieci.',
    en: 'CPU is saturated, so the unresponsiveness is local load rather than the network.',
    test: { tool: 'system.snapshot', args: {}, capability: 'measure CPU utilisation again' },
    expect: (observed) => Number(observed && observed.cpuPercent) >= 60,
  },
  {
    id: 'memory-pressure',
    when: (signal) => signal.name === 'memory.availableRatio' && Number(signal.value) < 0.1,
    statement: 'Wolna pamięć RAM spadła poniżej 10%, co wystarcza do blokowania alokacji i wymiany.',
    en: 'Free RAM fell below 10%, enough to stall allocations and force swapping.',
    test: { tool: 'system.snapshot', args: {}, capability: 'measure memory pressure again' },
    expect: (observed) => Number(observed && observed.memory && observed.memory.percent) >= 85,
  },
  {
    id: 'disk-exhaustion',
    when: (signal) => signal.name === 'disk.freeRatio' && Number(signal.value) < 0.05,
    statement: 'Dysk systemowy ma mniej niż 5% wolnego miejsca, więc zapisy (logi, baza, aktualizacje) mogą zawieść.',
    en: 'The system disk has under 5% free space, so writes may fail.',
    test: { tool: 'disk.volumes', args: {}, capability: 'read per-volume free space' },
    expect: (observed) => (observed && Array.isArray(observed.volumes) ? observed.volumes : []).some((volume) => Number(volume.percentUsed) >= 90),
  },
  {
    id: 'network-unreachable',
    when: (signal) => signal.name === 'network.reachable' && signal.value === false,
    statement: 'Cel jest nieosiągalny z tej maszyny, więc problem jest w trasie lub DNS, a nie w aplikacji.',
    en: 'The target is unreachable from this machine, so the fault is in routing or DNS.',
    test: { tool: 'net.ping', args: { host: '127.0.0.1' }, capability: 'check the network stack locally' },
    expect: (observed) => Boolean(observed && observed.reachable),
  },
  {
    id: 'provider-down',
    when: (signal) => signal.name === 'llm.reachable' && signal.value === false,
    statement: 'Lokalny dostawca modeli nie odpowiada; odpowiedzi bez modelu to tryb deterministyczny, nie awaria mózgu.',
    en: 'The local model provider is not answering; model-free answers are the deterministic path.',
    test: { tool: 'runtime.status', args: {}, capability: 'read provider health and resident models' },
    expect: (observed) => Boolean(observed && observed.ok !== false),
  },
];


function normaliseSignals(signals) {
  if (!Array.isArray(signals)) return [];
  return signals
    .filter((signal) => signal && typeof signal.name === 'string')
    .map((signal) => ({ name: signal.name, value: signal.value, source: signal.source || 'caller', observedAt: signal.observedAt || null }));
}

class Reasoner {
  constructor({ log = null, runTool = null, maxTests = 4 } = {}) {
    this.log = log;
    this.runTool = runTool;
    this.maxTests = Math.max(1, Math.min(MAX_HYPOTHESES, maxTests));
    this.counters = { evaluations: 0, hypotheses: 0, tested: 0, supported: 0, contradicted: 0, untested: 0, refusals: 0 };
  }

  /** Builds hypotheses only from signals that actually crossed a threshold. */
  hypotheses({ question = '', signals = [] } = {}) {
    const observed = normaliseSignals(signals);
    const out = [];
    for (const rule of RULES) {
      const matched = observed.filter((signal) => {
        try {
          return rule.when(signal);
        } catch {
          return false;
        }
      });
      if (!matched.length) continue;
      this.counters.hypotheses += 1;
      out.push({
        id: rule.id,
        statement: rule.statement,
        en: rule.en,
        basedOn: matched.map((signal) => ({ name: signal.name, value: signal.value, source: signal.source })),
        test: rule.test,
        expect: rule.expect,
        status: 'untested',
        evidence: null,
      });
    }
    return { question, signals: observed, hypotheses: out.slice(0, MAX_HYPOTHESES), note: out.length ? 'Every hypothesis names a measurement that could refute it.' : 'No signal crossed a diagnostic threshold, so no hypothesis was manufactured.' };
  }

  /**
   * Tests hypotheses with real tools. `run` defaults to the injected tool
   * runner. A failed measurement is untested, not support.
   */
  async evaluate({ question = '', signals = [], hypotheses = null, run = null } = {}) {
    this.counters.evaluations += 1;
    const runner = run || this.runTool;
    const built = hypotheses || this.hypotheses({ question, signals }).hypotheses;
    const results = [];
    for (const hypothesis of built.slice(0, this.maxTests)) {
      const expectation = hypothesis.expect || (() => null);
      let observation = null;
      let error = null;
      if (typeof runner !== 'function') error = 'no tool runner is available';
      else {
        try {
          // eslint-disable-next-line no-await-in-loop
          observation = await runner(hypothesis.test.tool, hypothesis.test.args || {});
        } catch (err) {
          error = err.message;
        }
      }
      const record = { id: hypothesis.id, statement: hypothesis.statement, test: hypothesis.test };
      if (error || observation === null || observation === undefined) {
        this.counters.untested += 1;
        results.push({ ...record, status: 'untested', evidence: observation || null, error });
        continue;
      }
      this.counters.tested += 1;
      let matched = false;
      try {
        matched = Boolean(expectation(observation));
      } catch (err) {
        results.push({ ...record, status: 'untested', evidence: observation, error: `expectation failed: ${err.message}` });
        this.counters.untested += 1;
        continue;
      }
      if (matched) this.counters.supported += 1;
      else this.counters.contradicted += 1;
      results.push({ ...record, status: matched ? 'supported' : 'contradicted', evidence: observation, error: null });
    }
    const supported = results.filter((entry) => entry.status === 'supported');
    const contradicted = results.filter((entry) => entry.status === 'contradicted');
    const untested = results.filter((entry) => entry.status === 'untested');
    // Documented, deliberately conservative: untested hypotheses halve the
    // confidence and a single contradiction caps it below certainty.
    let confidence = supported.length / Math.max(1, results.length);
    if (!results.length) confidence = 0;
    if (contradicted.length) confidence = Math.min(confidence, 0.5);
    if (untested.length) confidence *= 0.5;
    if (!supported.length) {
      this.counters.refusals += 1;
      return {
        question,
        results,
        conclusion: null,
        confidence: 0,
        verdict: 'insufficient_evidence',
        need: untested.map((entry) => entry.test.capability || entry.test.tool),
        contradicted: contradicted.map((entry) => entry.id),
        note: 'No hypothesis was supported by a measurement. The assistant must say so instead of choosing a story.',
      };
    }
    return {
      question,
      results,
      conclusion: supported[0].statement,
      supported: supported.map((entry) => entry.id),
      contradicted: contradicted.map((entry) => entry.id),
      untested: untested.map((entry) => entry.id),
      need: untested.map((entry) => entry.test.capability || entry.test.tool),
      confidence: Number(confidence.toFixed(2)),
      verdict: contradicted.length ? 'best_supported_with_conflicts' : untested.length ? 'supported_partially_tested' : 'supported',
    };
  }

  /**
   * Keeps contradictory facts side by side. Resolution is a human decision;
   * silently overwriting the older value is how assistants gaslight users.
   */
  contradictions(facts = []) {
    const groups = new Map();
    for (const fact of Array.isArray(facts) ? facts : []) {
      if (!fact || fact.key === undefined) continue;
      const key = String(fact.key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ key, value: fact.value, source: fact.source || 'unknown', trusted: fact.trusted !== false, at: fact.at || null });
    }
    const conflicts = [];
    for (const [key, entries] of groups) {
      const values = new Set(entries.map((entry) => JSON.stringify(entry.value)));
      if (values.size > 1) conflicts.push({ key, values: entries, resolution: null, note: 'both values retained; neither is treated as verified' });
    }
    return { conflicts, checked: groups.size, conflicted: conflicts.length };
  }

  /**
   * Agreement between outputs is evidence only when the outputs are
   * independent. Two calls to the same model are one source.
   */
  agreement(outputs = []) {
    const entries = (Array.isArray(outputs) ? outputs : []).filter((entry) => entry && typeof entry.text === 'string');
    const sources = new Set(entries.map((entry) => `${entry.provider || 'unknown'}:${entry.model || 'unknown'}`));
    const texts = new Set(entries.map((entry) => entry.text.trim().toLowerCase()));
    const independent = sources.size > 1 && texts.size === 1;
    return {
      independent,
      sources: [...sources],
      identical: texts.size === 1 && entries.length > 1,
      note: independent
        ? 'Distinct provider/model pairs produced identical text. Treated as weak corroboration, not proof.'
        : sources.size <= 1
          ? 'All outputs came from the same model source; repetition is not independent evidence.'
          : 'Outputs disagree or come from different tasks, so there is no agreement to report.',
    };
  }

  status() {
    return { ...this.counters, rules: RULES.length, maxHypotheses: MAX_HYPOTHESES, maxTests: this.maxTests };
  }
}

module.exports = { Reasoner, RULES, normaliseSignals };
