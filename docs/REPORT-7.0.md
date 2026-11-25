# SENTINEL 7.0.0 — tested slice report

Status: **partial, no packaging**. This report contains only results executed in
this checkout. The persistent requirement ledger is
[`docs/REQUIREMENTS-7.0.md`](REQUIREMENTS-7.0.md).

## Headline

SENTINEL 7.0 adds a real reverse-mode autodiff library, a trainable compact
transformer, a gated retrieval reranker, four further gated specialist
classifiers, a typed cognitive hypercore, a
consent-based communication manager with a mock provider and a Twilio REST
adapter, deterministic science/productivity tool packs, an opt-in proactive
engine, a cited daily briefing, new CLI/API/UI surfaces and adversarial tests.
It does **not** reach the 50,000–100,000-line, 1,000-tool, 120-agent or
2,000-test targets. Those remain explicitly open.

## Measured source growth

| Revision | First-party source lines* |
| --- | --- |
| 6.0 (`130cf23`) | 53,465 |
| 7.0 (this working tree) | **60,431** |
| Added | **+6,966** |

\* JS/HTML/CSS/INO/CPP/H/PS1, excluding dependencies, generated assets, weights
and caches. The new neural, hypercore, communication, briefing, proactive, tool
and test modules account for most of the growth. No code was duplicated to raise
the number.

## Real neural work (CPU only)

The library in `core/ml/autograd.js` implements matrix operations, matmul,
broadcast bias, ReLU, row-softmax, LayerNorm, mean pooling, embedding gather,
softmax cross-entropy, reverse-mode backward, numeric gradient checking and
Adam with weight decay. `core/ml/transformer.js` composes it into a single-block
self-attention encoder. `test/deep.js` checks gradients on every parameter group.

`npm run bench:neural` produced `docs/neural-7.0.json` in **2,822 ms** total on
this sandbox (Linux CPU, Node 22):

| Model | Architecture | Held-out result | Baseline | Delta | Time |
| --- | --- | --- | --- | --- | --- |
| Intent | MLP 384→24→12→10 | accuracy **0.796** (49 cases) | keyword **0.755** | +0.041 | 472 ms |
| Sentiment | 1-block transformer, d=24, 140 test cases | accuracy **1.000**, macro-F1 1.000 | lexicon **0.964** | +0.036 | 2,287 ms |
| Reranker | 3-class MLP, 6 features, 6 test queries/30 candidates | NDCG@3 **0.8443**, MRR 1.0 | lexical **0.8273** | +0.017 | 45 ms |
| Tool selection | MLP 399→48→24→15, 16 held-out requests | accuracy **0.8125**, macro-F1 0.7556 | keyword **0.6875** | +0.125 | 3,474 ms |
| Agent routing | MLP 392→48→24→8, 8 held-out requests | accuracy **1.000**, macro-F1 1.000 | keyword **0.875** | +0.125 | 1,620 ms |
| Memory relevance | MLP 6→16→8→2, 18 held-out pairs | accuracy **0.9444**, macro-F1 0.9443 | threshold **0.6667** | +0.2778 | 118 ms |
| Task complexity | MLP 6→16→8→3, 6 held-out requests | accuracy **0.8333**, macro-F1 0.7778 | weighted score **0.8333** | 0.0000 | 56 ms |

Caveats that matter: datasets are authored synthetic data; test subjects/topics
are held out, but the corpus is small; the transformer is not a language model
and cannot generate text; no GPU, VRAM or tokens/s measurement was performed.
The reranker's improvement is small and only six test queries were evaluated.

### Four additional specialist classifiers

`core/specialists.js` trains four more models with the existing MLP, compares
each to a named deterministic baseline on the same held-out items, and refuses
to promote a model below its baseline:

| Task | Authored examples | Training items after disclosed augmentation | Held-out | Baseline | Gate |
| --- | --- | --- | --- | --- | --- |
| Tool selection (15 real tool names) | 79 | 719 | 16 | 0.6875 | passed |
| Agent routing (8 domains) | 47 | 421 | 8 | 0.8750 | passed |
| Memory relevance (2 labels) | 120 | 84 | 18 | 0.6667 | passed |
| Task complexity (3 labels) | 40 | 28 | 6 | 0.8333 | passed (tie) |

The augmentation is authored, not scraped: `core/ml/data/specialists.js` ships
keyword lexicons and six sentence frames per class, used **only for training**.
Held-out authored requests are never seen verbatim. Text models combine
character n-gram hashing with a 15-way/8-way lexical-keyword feature block, so
the routing result is a learned mapping over engineered lexical features, not
language understanding. The routing score is 8/8 on a very small test set; it is
not evidence of general routing quality. Tool-selection labels are checked
against the real registry by a deep test, and the audit executes
`specialists.status`.

`Dispatcher.route` now consults the routing model. When keyword scoring finds no
candidate, a confident domain can select the mapped agent (for example devices →
mobile); when a keyword candidate exists it always wins, and the model hint is
kept in the route result for audit. A promoted model is served through
`specialists.predict`, `POST /api/specialists/predict` and `sentinel
specialists`. Low-confidence tool and
routing predictions expose and may use the deterministic keyword baseline;
the response always reports the neural label, the baseline label and whether the
fallback fired. Checkpoints are checksummed and stored outside the repository;
`npm run bench:specialists` regenerates `docs/specialists-7.0.json` in a
temporary home and deletes the weights afterwards.

The intent and transformer labs save checksummed weights under
`SENTINEL_HOME/models`, never in the repository, and require a named human to
train or promote. Promotion is gated on held-out performance. Rollback no longer
pretends to succeed without a previous model.

## Cognitive hypercore

`core/cognition/hypercore.js` provides:

- typed goals, beliefs, evidence, hypotheses, constraints, rules and conflicts;
- explicit provenance and confidence, never hidden "thoughts";
- deterministic softmax attention over priority, deadline urgency, uncertainty,
  contradictions and hard constraints;
- hard constraints are retained even when the token budget is tight;
- context selection with a labelled characters/4 token **estimate** and a trace;
- token/tool/depth budgets that refuse overspend with `BUDGET_EXCEEDED`;
- bounded Horn-style deduction, abduction that proposes but does not prove, and
  Bayesian hypothesis updates with fixed, reported likelihood ratios;
- contradictions kept side by side; resolution requires an approval and preserves
  the loser as `superseded`;
- persistence through the existing store and a verified reload test.

It is not consciousness, emotion, a biological model or a full theorem prover.
See 10 tools, CLI `sentinel hypercore`, and `/api/hypercore`.

## Communications and phone calls

`core/communication.js` is provider-independent:

- consent tokens are bound to one channel, one E.164 destination and an expiry,
  and are use-once; a call/SMS additionally needs a consumed system approval;
- emergency/service numbers and premium prefixes are blocked;
- daily counts, estimated cost limits, quiet hours, retry limits and cancellation
  are enforced;
- calls prepend an AI disclosure unless it is already present;
- Twilio uses the documented Calls/Messages REST endpoints, Basic auth and a
  TwiML `<Say>`; signed status callbacks use HMAC-SHA1 plus replay rejection;
- the default is a **mock** adapter: no audio, SMS or email leaves the process.

What was executed: mock call lifecycle, consent refusal/reuse/mismatch, destination
blocking, Twilio request construction against a fake `fetch`, and webhook
signature verification. What was **not** executed: a real provider account, a
real call, SMS delivery, billing, regional availability or audio quality. Those
are not claimed. Unconfigured or disabled state returns `NOT_CONFIGURED`.

## Tools, agents and tests

- **342 tools / 29 categories**; audit: **0 structural problems**, **83 executed
  and verified**, **259 explicitly unexecuted** (`docs/tool-audit-7.0.json`).
  The audit now fails when any executed tool fails — it caught and we fixed a real
  `planning.working_days` bug.
- **31 agents** — unchanged. No renamed personas were added.
- **249 suite checks**: 23 behaviour + 25 assistant + 48 UI + 153 deep.
- **90 deterministic evaluations**, score 1, **mock mode**. That is not model
  quality.
- Total checks: **339** across suites and evaluation. The brief asked for 2,000.
- UI checks include unauthenticated `/api/lab`, `/api/hypercore`,
  `/api/communication`, `/api/lab/sentiment` refusals and a panel fed by real APIs.

## Performance measurements (not GPU claims)

`docs/bench-7.0.json` recorded (sandbox): memory p50 0.94 ms / p95 5.19 ms,
retrieval 0.30/0.66 ms, graph 0.54/0.95 ms, executor 5.67/8.45 ms. Training
figures are in `docs/neural-7.0.json`. No VRAM, first-token latency, tokens/s,
quantisation or offload measurement is available because no model/GPU was
reachable.

## Source-only delivery

`.github/workflows/build.yml` was replaced with Linux source checks, Windows
source checks and a simulated device/mobile source job. It does **not** build an
EXE, MSI, APK, AAB, BIN, HEX or UF2 and does not publish releases.
`scripts/check.js` enforces the absence of `pkg`, `electron-builder`,
`assembleRelease`, `pio run` and release uploads, and requires exactly one
PowerShell installer. Android, desktop and ESP32 sources were preserved.
The single `INSTALL_SENTINEL_FULL.ps1` still stages, backs up, health-checks and
rolls back; it now performs only read-only 7.0 status checks and never trains or
calls. It was not executed here.

## CLI additions

```
sentinel hypercore [status|goals|conflicts|focus]
sentinel reranker [status|train|promote <id>|rerank <q> <candidates...>]
sentinel sentiment [status|train|promote <id>|classify <text>]
sentinel comm [status|consent <dest>|grant <token>|call <dest> <text>|sms ...]
sentinel brief
sentinel proactive [status]
```

All mutating/training commands require `--approve <name>`; `comm call/sms`
additionally require `--consent <token>` that a model cannot mint.

## Explicit gaps

1. **Agents: 31, not 120+.** No new personas were fabricated.
2. **Tools: 342, not 1,000+; 259 unexecuted.**
3. **Tests/evals: 339, not 2,000+.** No property-based or fault-injection suite.
4. **Source: +6,966 lines, not +50,000–100,000.**
5. **Specialists:** intent, sentiment, reranker, tool selection, agent routing,
   memory relevance and task complexity are real and measured. Semantic
   similarity, context importance, failure prediction and confidence calibration
   are not built. The four new models have 6–18 held-out items each; the routing
   result is 8/8 and is not a general routing claim.
6. **LoRA/QLoRA/distillation/preference training: none.**
7. **No live model/GPU/provider measurements; no real call, SMS or email.**
8. **No multi-file parser-backed patch engine, GraphRAG pipeline, scheduler or UI
   communication actions.**
9. **Installer not executed.** Windows/Linux source CI is green for this slice;
   the installer itself has not been run on a Windows machine.
10. **No binary artifacts by design.** Android/ESP32 source exists but was not
    compiled or tested on hardware.

## Reference specifications

Implementation follows established algorithms and public API shapes; no new
research result is claimed:

- reverse-mode differentiation and attention: <https://arxiv.org/abs/1508.07909>,
  <https://arxiv.org/abs/1706.03762>
- Adam / decoupled weight decay: <https://arxiv.org/abs/1412.6980>,
  <https://arxiv.org/abs/1711.05101>
- Twilio programmable voice/messaging API: <https://www.twilio.com/docs/voice/api/call-resource>,
  <https://www.twilio.com/docs/messaging/api/message-resource>
- ISO-8601 week dates: <https://www.iso.org/iso-8601-date-and-time-format.html>
- NDCG and graded relevance: <https://doi.org/10.1145/582415.582418>
