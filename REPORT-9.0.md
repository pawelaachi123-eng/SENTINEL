# SENTINEL 9.0.0 — Omega Intelligence, first integrated slice

**Status: PARTIAL.** 9.0 begins the Omega architecture with a working cognitive
state layer and deterministic reasoning engines, connected to real chat runs.
It does **not** meet the cumulative 1M-line, 2,000-tool, 100-category,
250-agent or 10,000-check targets. The requirements graph records **9 VERIFIED,
22 PARTIAL, 2 BLOCKED and 3 NOT_STARTED of 36 tracked requirements**.

## What is new and actually integrated

### 1. Persistent typed cognitive blackboard

`core/cognition/blackboard.js` is a new shared state layer, not a disconnected
library:

- Typed entries: question, goal, constraint, fact, belief, hypothesis, evidence,
  plan, task, decision, result, verification, error, preference, answer, artifact,
  observation.
- Provenance, owner, confidence and epistemic status are separate fields.
- Scopes are enforced (`session:`, `task:`, `workspace:`, `global`), and a chat
  cannot read another session's entries.
- Attention combines salience, confidence, age decay, access count and goal-term
  relevance. `focus()` enforces a token budget and reports how many entries were
  omitted.
- Changed keyed content creates an explicit contradiction rather than silently
  overwriting the older claim. Resolution retains the loser as `contradicted`
  with history.
- Atomic JSON persistence survives restart; a corrupt file is reported, not
  silently replaced.
- Subscribers receive mutations for event-driven synchronization.

It is wired into `Brain.ask`: the request, goal, constraints, hypotheses,
retrieved memory/document evidence, final answer, tool result and verification
are written to the session board. The attention window is added to the model
context, and the answer reports `cognitiveState` counts. `GET
/api/cognitive/state?scope=session:<id>` returns live stats, contradictions and
a bounded focus window.

### 2. Deterministic reasoning engines

`core/reasoning/engines.js` implements:

- Horn-style forward chaining with proof support, bounded iterations, fact caps
  and explicit contradictions.
- Bounded abduction that grounds assumable hypotheses from observations and
  returns multiple candidate explanations.
- Finite-domain CSP with MRV, forward checking, node budgets and honest
  "incomplete" results instead of false unsatisfiability.
- Bayesian updating with explicit priors, independent likelihoods, normalisation
  and skipped-evidence reporting.
- Directed causal path enumeration with cycle protection and depth/count bounds.
- Allen interval relations, 2-D rectangle relations and expected-utility choice.

Each result carries `proven`, `supported`, `estimated` or `unsupported`; a
heuristic score is never reported as proof.

### 3. Metacognitive controller

`core/cognition/metacognition.js` inspects the evidence actually gathered, the
verification result, unresolved contradictions, tool failures, ambiguity, answer
shape, token use and elapsed time. It chooses one bounded action: `proceed`,
`qualify`, `gather`, `retry`, `clarify` or `stop`. Deep mode may spend one retry;
balanced mode does not. Exact tool answers are not punished for lacking prose
citations. Every chat answer reports the assessment, and the decision is written
to the blackboard.

### 4. Seventeen new cognitive tools

`core/tools/omega.tools.js` exposes the blackboard, engines and metacognition
through the real registry: `blackboard.add/get/query/focus/conflicts/resolve/retract/stats`
and `omega.deduce/abduce/csp/bayes/causal/intervals/spatial/decide/metacognize`.
They are in a new `cognitive` category. The audit executes them, including a
contradiction and resolution flow.

## Measured on this checkout

| Measure | 8.1 | 9.0 |
|---|---:|---:|
| First-party lines | 84,532 | **93,160** |
| Tools | 689 | **706** |
| Categories | 35 | **36** |
| Agents | 123 | 123 |
| Checks | 2,058 | **2,116** |
| Verified fixture calls | 615/619 | **632/639** |
| Unexecuted tool names | 74 | 74 |
| Self-index | 222 files / 3,115 symbols | **230 / 3,256** |
| Requirements VERIFIED | 7/34 | **9/36** |

`node scripts/acceptance-9.0.js` exits 0 and writes `docs/ledger-9.0.json`.
All 15 suites pass. CI remains source-only.

## Honest gaps and blockers

- **1,000,000 lines**: 906,840 lines short.
- **2,000 tools / 100 categories**: 1,294 tools and 64 categories short.
- **250 agents**: 127 functional specialists short.
- **10,000 checks**: 7,884 short.
- **74 unexecuted tools**: mostly approval-gated writes, provider/device paths,
  process control, MCP and installer code.
- **Metacognition**: the controller is VERIFIED for answer sufficiency, but it
  does not yet arbitrate every module.
- **Induction and counterfactual solvers**: not first-class yet.
- **Production ML**: CPU-scale analogues only; no PyTorch/PEFT/quantization
  workflow or GPU measurement.
- **Telephony / Windows UIA**: BLOCKED on verified destinations, provider
  credentials, explicit approval and a Windows host.
- **Live providers**: mocked only; real smoke tests need separate approval.

No live-provider, GPU, phone or Windows-installation result is claimed.

## Reproduce

```bash
npm test
node scripts/requirements-graph.js
node test/blackboard.js
node test/reasoning.js
node scripts/audit-tools.js --no-write
node scripts/acceptance-9.0.js
```
