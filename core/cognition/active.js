'use strict';

/**
 * Active metacognitive control.
 *
 * The 9.0 controller could only *recommend* an action. This class executes a
 * bounded number of real corrective transitions against the running assistant:
 *
 *   gather  → retrieve more evidence (memory/knowledge), then re-answer
 *   retry   → re-run the answer with the verifier's issues in context
 *   qualify → add a visible limitation to the answer
 *   clarify → replace a guess with a specific question
 *   stop    → stop spending resources and report what is missing
 *
 * The loop is deliberately finite. A mode has a small correction budget, every
 * transition is recorded, cancellation is checked between steps and a failed
 * correction degrades to qualification rather than another attempt.
 */

const CORRECTION_BUDGET = { fast: 0, balanced: 1, deep: 2, research: 3 };
const MIN_TIME_LEFT_MS = 250;

class ActiveCognitiveController {
  constructor({ metacognitive, now = () => Date.now(), log = null, maxCorrections = null } = {}) {
    if (!metacognitive || typeof metacognitive.assess !== 'function') throw Object.assign(new Error('an active controller needs a metacognitive assessor'), { code: 'NO_ASSESSOR' });
    this.metacognitive = metacognitive;
    this.now = now;
    this.log = log;
    this.maxCorrections = maxCorrections;
  }

  budgetFor(mode) {
    const configured = this.maxCorrections === null ? null : Number(this.maxCorrections);
    if (Number.isFinite(configured) && configured >= 0) return Math.min(5, Math.floor(configured));
    return CORRECTION_BUDGET[mode] === undefined ? 1 : CORRECTION_BUDGET[mode];
  }

  /**
   * Execute the bounded loop.
   *
   * `handlers` are the only way this class touches the world:
   *   assess(answer, {retryCount, reason}) → assessment
   *   evaluate({reason, contextBlock, issues, previous}) → answer state or null
   *   gather({issue, assessment}) → {added, contextBlock, evidence, note}
   *   qualify(answer, assessment) → answer state
   *   clarify(answer, assessment) → answer state
   *   stop(answer, assessment) → answer state
   *
   * An answer state is `{text, verification?, toolLog?, citations?, model?, provider?, agent?, ok?}`.
   * The result never claims an action happened if its handler failed.
   */
  async run({ question = '', mode = 'balanced', signal = null, assessment, answer, handlers = {} } = {}) {
    if (!assessment || !answer) throw Object.assign(new Error('run needs an initial assessment and answer'), { code: 'NO_STATE' });
    const started = this.now();
    const budget = this.budgetFor(mode);
    const transitions = [];
    let currentAnswer = { ...answer };
    let currentAssessment = assessment;
    let corrections = 0;
    let stopped = false;
    let exhausted = false;
    let cancelled = Boolean(signal && signal.aborted);
    const initialConfidence = Number(assessment.confidence) || 0;
    let lastConfidence = initialConfidence;
    let reason = null;

    const record = (action, outcome, detail = {}) => {
      transitions.push({ action, outcome, at: this.now(), confidence: currentAssessment ? currentAssessment.confidence : null, ...detail });
      if (this.log && outcome !== 'applied') this.log.debug('metacognition', `${action} ${outcome}${detail.note ? `: ${detail.note}` : ''}`);
    };

    const timeLeft = () => {
      const elapsed = this.now() - started;
      // The assessment already carries the mode's hard limit and the elapsed
      // time of the run that produced it. A correction may only spend what is
      // left, never a fresh budget.
      const hard = currentAssessment.resources && Number(currentAssessment.resources.hardLimitMs);
      if (Number.isFinite(hard) && hard > 0) return Math.max(0, hard - (Number(currentAssessment.resources.elapsedMs) || 0) - elapsed);
      return 30000;
    };

    while (!cancelled && corrections < budget && !stopped) {
      const action = currentAssessment.action;
      if (!['gather', 'retry'].includes(action)) break;
      if (signal && signal.aborted) {
        cancelled = true;
        record(action, 'cancelled');
        break;
      }
      if (timeLeft() < MIN_TIME_LEFT_MS) {
        record(action, 'budget-exhausted', { note: 'not enough time remains for a corrective step' });
        exhausted = true;
        break;
      }
      if (action === 'retry' && currentAssessment.retryAllowed === false && !['deep', 'research'].includes(mode)) {
        // Balanced/fast runs do not spend an un-budgeted generation. The honest
        // response is to qualify the existing answer instead.
        record('retry', 'not-budgeted');
        currentAssessment = { ...currentAssessment, action: 'qualify' };
        break;
      }
      const relevantIssue = (currentAssessment.issues || []).find((issue) => issue.action === action) || (currentAssessment.issues || [])[0] || null;
      let gathered = null;
      let contextBlock = '';
      let gatheredAdded = 0;
      if (action === 'gather') {
        if (typeof handlers.gather !== 'function') {
          record('gather', 'unavailable');
          break;
        }
        try {
          gathered = await handlers.gather({ issue: relevantIssue, assessment: currentAssessment, question });
        } catch (err) {
          record('gather', 'failed', { note: err.message });
          gathered = null;
        }
        if (!gathered || !gathered.added) {
          // Re-answering without new evidence would just reproduce the same gap.
          record('gather', 'no-new-evidence', { note: gathered && gathered.note ? gathered.note : null });
          exhausted = true;
          // The honest output is the existing answer plus its limitation, not a
          // second generation with the same inputs.
          currentAssessment = { ...currentAssessment, action: 'qualify' };
          break;
        }
        contextBlock = String(gathered.contextBlock || '');
        gatheredAdded = Number(gathered.added) || 0;
      }
      if (action === 'retry' && typeof handlers.retryContext === 'function') {
        try {
          contextBlock = String((await handlers.retryContext({ issue: relevantIssue, assessment: currentAssessment })) || '');
        } catch (err) {
          record('retry', 'context-failed', { note: err.message });
        }
      }
      if (typeof handlers.evaluate !== 'function') {
        record(action, 'unavailable');
        break;
      }
      let evaluated = null;
      try {
        evaluated = await handlers.evaluate({
          reason: action,
          contextBlock,
          issues: (currentAssessment.issues || []).map((issue) => issue.code),
          previous: currentAnswer,
          gathered,
        });
      } catch (err) {
        record(action, 'evaluate-failed', { note: err.message });
        evaluated = null;
      }
      if (!evaluated || evaluated.ok === false || !String(evaluated.text || '').trim()) {
        record(action, 'no-valid-answer', { note: evaluated && evaluated.error ? String(evaluated.error) : null });
        break;
      }
      corrections += 1;
      reason = action;
      currentAnswer = { ...evaluated };
      try {
        currentAssessment = await handlers.assess(currentAnswer, { retryCount: corrections, reason: action });
      } catch (err) {
        record(action, 'assess-failed', { note: err.message });
        break;
      }
      lastConfidence = Number(currentAssessment.confidence) || 0;
      record(action, 'applied', {
        added: gatheredAdded || undefined,
        confidenceDelta: Number((lastConfidence - initialConfidence).toFixed(4)),
        remaining: currentAssessment.action,
      });
    }

    if (signal && signal.aborted) cancelled = true;
    if (cancelled) {
      return this.finish({ currentAnswer, currentAssessment, transitions, corrections, stopped: true, exhausted: false, cancelled, initialConfidence, lastConfidence, reason, started });
    }

    const finalAction = currentAssessment.action;
    if (['qualify', 'clarify', 'stop'].includes(finalAction)) {
      const handler = handlers[finalAction];
      if (typeof handler === 'function') {
        try {
          const changed = await handler(currentAnswer, currentAssessment);
          if (changed && changed.text !== undefined) {
            currentAnswer = { ...currentAnswer, ...changed };
            record(finalAction, 'applied');
          } else {
            record(finalAction, 'no-change');
          }
        } catch (err) {
          record(finalAction, 'failed', { note: err.message });
        }
      } else {
        record(finalAction, 'unavailable');
      }
      if (finalAction === 'stop') stopped = true;
    }

    return this.finish({ currentAnswer, currentAssessment, transitions, corrections, stopped, exhausted, cancelled, initialConfidence, lastConfidence, reason, started });
  }

  finish({ currentAnswer, currentAssessment, transitions, corrections, stopped, exhausted, cancelled, initialConfidence, lastConfidence, reason, started }) {
    const gain = Number((lastConfidence - initialConfidence).toFixed(4));
    return {
      answer: currentAnswer,
      assessment: currentAssessment,
      transitions,
      corrections,
      stopped,
      exhausted,
      cancelled,
      reason,
      initialConfidence,
      finalConfidence: Number(currentAssessment.confidence) || 0,
      confidenceGain: gain,
      corrected: corrections > 0 || transitions.some((entry) => ['qualify', 'clarify'].includes(entry.action) && entry.outcome === 'applied'),
      elapsedMs: this.now() - started,
      summary: transitions.length
        ? transitions.map((entry) => `${entry.action}:${entry.outcome}`).join(' → ')
        : 'no corrective transition was needed',
    };
  }
}

module.exports = { ActiveCognitiveController, CORRECTION_BUDGET };
