'use strict';

/**
 * Metacognitive controller.
 *
 * It does not think about the content of an answer. It inspects the evidence
 * that was actually gathered, the verification result, unresolved
 * contradictions, ambiguity, tool failures, answer shape and elapsed resources,
 * then chooses one bounded action:
 *
 *   proceed  — the evidence supports answering now
 *   qualify  — answer, but say what is uncertain or failed
 *   gather   — one more retrieval step would materially help
 *   retry    — the answer failed verification and a corrected attempt is allowed
 *   clarify  — the request is missing a subject; guessing is worse than asking
 *   stop     — resources or emptiness make continuing dishonest
 *
 * The controller is deterministic and advisory. The caller remains responsible
 * for enforcing budgets and for never turning "insufficient" into a confident
 * claim.
 */

const MODE_LIMITS = {
  fast: { softMs: 6000, hardMs: 15000, minAnswerChars: 8 },
  balanced: { softMs: 20000, hardMs: 60000, minAnswerChars: 12 },
  deep: { softMs: 90000, hardMs: 180000, minAnswerChars: 30 },
  research: { softMs: 180000, hardMs: 360000, minAnswerChars: 40 },
};

class MetacognitiveController {
  constructor({ now = () => Date.now(), config = null } = {}) {
    this.now = now;
    this.config = config;
  }

  assess({
    brief = null,
    verification = null,
    text = '',
    model = null,
    citations = [],
    evidence = {},
    toolLog = [],
    conflicts = [],
    elapsedMs = 0,
    mode = 'balanced',
    retryCount = 0,
    budget = {},
  } = {}) {
    const answer = String(text || '').trim();
    const limits = MODE_LIMITS[mode] || MODE_LIMITS.balanced;
    const memories = Number(evidence.memories || 0);
    const documents = Number(evidence.documents || 0);
    const graphNodes = Number(evidence.graphNodes || 0);
    const toolCalls = Array.isArray(toolLog) ? toolLog.length : 0;
    const toolFailures = Array.isArray(toolLog) ? toolLog.filter((entry) => entry && entry.ok === false) : [];
    const unresolvedConflicts = (Array.isArray(conflicts) ? conflicts : []).filter((pair) => pair && !pair.resolved);
    const verificationOk = !verification || verification.ok !== false;
    const issues = [];
    const add = (code, severity, detail, action = null) => issues.push({ code, severity, detail, action });

    if (!answer) add('empty-answer', 'critical', 'no answer text was produced', 'stop');
    if (brief && brief.needsClarification) add('ambiguous-request', 'high', 'the request has no resolvable subject', 'clarify');
    if (unresolvedConflicts.length) add('unresolved-conflict', 'high', `${unresolvedConflicts.length} contradictory entries remain`, 'qualify');
    if (verification && verification.ok === false) add('verification-failed', 'high', (verification.issues || []).slice(0, 3).join('; ') || 'the verifier rejected the answer', retryCount < 1 && ['deep', 'research'].includes(mode) ? 'retry' : 'qualify');
    if (toolFailures.length) add('tool-failures', 'medium', `${toolFailures.length} tool call(s) failed`, 'qualify');
    if (elapsedMs > limits.hardMs) add('resource-stop', 'critical', `elapsed ${Math.round(elapsedMs / 1000)}s exceeds the ${Math.round(limits.hardMs / 1000)}s hard limit`, 'stop');
    else if (elapsedMs > limits.softMs) add('resource-overrun', 'medium', `elapsed ${Math.round(elapsedMs / 1000)}s exceeds the ${Math.round(limits.softMs / 1000)}s soft limit`, 'qualify');

    const evidenceCount = memories + documents + graphNodes;
    const retrievalIntent = brief && ['retrieval', 'factual', 'diagnostic'].includes(brief.intent);
    if (retrievalIntent && evidenceCount === 0 && !toolCalls && model) add('no-evidence', 'high', 'a retrieval-style answer used no memory, document, graph node or tool result', 'gather');
    if (retrievalIntent && model && evidenceCount > 0 && (!Array.isArray(citations) || citations.length === 0)) add('uncited-evidence', 'medium', 'retrieved evidence was not cited in the answer', 'qualify');
    if (brief && brief.uncertainty >= 0.75 && evidenceCount === 0) add('high-uncertainty', 'high', `interpretation uncertainty is ${brief.uncertainty}`, 'gather');
    if (brief && brief.complexity && Number(brief.complexity.score) >= 0.7 && answer.length < limits.minAnswerChars) add('thin-complex-answer', 'medium', 'a complex request received a very short answer', 'retry');
    if (Number(budget.tokens) > 0 && Number(budget.usedTokens) > Number(budget.tokens)) add('token-budget', 'medium', 'the context exceeded its token budget', 'qualify');

    let action = 'proceed';
    const priority = ['stop', 'clarify', 'retry', 'gather', 'qualify'];
    for (const candidate of priority) {
      if (issues.some((issue) => issue.action === candidate)) {
        action = candidate;
        break;
      }
    }
    // An exact tool answer with no model involvement is measured, not generated.
    // It still gets quality flags, but never a demand for more retrieval simply
    // because it has no prose citations.
    const exactToolAnswer = !model && toolCalls > 0 && toolFailures.length === 0 && answer.length > 0;
    if (exactToolAnswer && ['gather', 'qualify'].includes(action) && !issues.some((issue) => issue.severity === 'critical')) {
      action = 'proceed';
    }

    const base = Number(verification && verification.confidence);
    const confidence = !answer ? 0 : Math.max(0, Math.min(1, (Number.isFinite(base) ? base : 0.65)
      - issues.filter((issue) => issue.severity === 'critical').length * 0.35
      - issues.filter((issue) => issue.severity === 'high').length * 0.15
      - issues.filter((issue) => issue.severity === 'medium').length * 0.05));
    const status = !answer ? 'insufficient'
      : action === 'proceed' && confidence >= 0.6 ? 'sufficient'
        : action === 'stop' || confidenceTooLow(confidence) ? 'insufficient' : 'partial';

    return {
      action,
      status,
      confidence,
      issues,
      evidence: { memories, documents, graphNodes, toolCalls, toolFailures: toolFailures.length, citations: Array.isArray(citations) ? citations.length : 0 },
      resources: { elapsedMs, softLimitMs: limits.softMs, hardLimitMs: limits.hardMs, overSoft: elapsedMs > limits.softMs, overHard: elapsedMs > limits.hardMs },
      unresolvedConflicts: unresolvedConflicts.length,
      retryAllowed: retryCount < 1 && ['deep', 'research'].includes(mode),
      summary: issues.length ? issues.map((issue) => `${issue.code}: ${issue.detail}`).join(' | ') : 'evidence, verification and resources are sufficient for this answer',
    };
  }
}

function confidenceTooLow(confidence) {
  return confidence < 0.25;
}

module.exports = { MetacognitiveController, MODE_LIMITS };
