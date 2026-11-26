# SENTINEL 7.1 — implementation report (current state)

**Status: incomplete.** This report describes the 7.1 work that exists and was
measured in this branch. The 7.1 requirement ledger
([`REQUIREMENTS-7.1.md`](REQUIREMENTS-7.1.md)) is the authoritative list of what
is done and what remains. It is not a completion certificate.

## What changed

### 1. Seven learned specialists instead of four
The 7.0 slice had tools, routing, relevance and complexity classifiers. 7.1 adds:

- **semantic similarity** — query/passage relatedness;
- **context importance** — whether a chunk deserves prompt budget;
- **failure prediction** — risk of a tool/permission combination failing.

The new data is authored, not scraped from user conversations:
`core/ml/data/specialists-ext.js` contains 484 semantic, 648 context (18
scenario groups × 4 frames) and 720 failure examples. Splits are group-disjoint,
so a test scenario family never appears in training.

All seven models are calibrated with temperature scaling (`core/ml/calibration.js`).
Calibration affects confidence and ECE/Brier, never the predicted label.

### 2. Measured specialist quality

Single held-out split (synthetic test fold), from
`docs/specialists-7.1.json`:

| Task | Model | Baseline |
|---|---:|---:|
| tools | 0.8125 | 0.6875 |
| routing | 1.0000 | 0.8750 |
| relevance | 0.9444 | 0.6667 |
| complexity | 0.8333 | 0.8333 |
| semantic | 0.7625 | 0.6750 |
| context | 1.0000 | 0.5556 |
| failure | 0.7153 | 0.6667 |

Five-fold group-disjoint cross-validation over all authored items:

`tools 0.8734 vs 0.7722 (79 cases) · routing 0.8936 vs 0.8085 (47) ·
relevance 0.9750 vs 0.6833 (120) · complexity 0.9000 vs 0.8250 (40)`

Calibration: semantic ECE 0.0901 → 0.0543 (T=0.75); context 0 → 0 (T=0.75);
failure 0.1941 → 0.1634 (T=1.3).

These are synthetic authored judgments on CPU. They are not a production
accuracy claim and no live model was used.

### 3. Integration, not an isolated notebook
- `brain.js` reranks memory/context with promoted specialist scores and keeps the
  deterministic ranking when no model is promoted.
- `dispatcher.js` attaches an advisory failure prediction; it never blocks a
  request on the classifier.
- A promoted routing model can supply the routing hint, but explicit strong
  keywords still win.
- HTTP `/api/specialists/predict` supports `semantic`, `context` and `failure`.
- CLI supports `specialists similarity|context|failure`.
- UI reports active/total specialist models from real state.

### 4. Unified retrieval — measured, not advertised
`core/retrieval/unified.js` combines BM25, hashed-vector cosine and graph-group
proximity with reciprocal-rank fusion and optional semantic/reranker boosts.
`benchmark()` returns nDCG@k, MRR, recall@k, p50 and p95.

On the authored 64-document, 48-query graded set at k=3:

| Mode | nDCG@3 | MRR | recall@3 |
|---|---:|---:|---:|
| lexical | 0.4683 | 0.5538 | 0.3438 |
| vector | 0.4407 | 0.5434 | 0.3125 |
| hybrid | 0.4704 | 0.5451 | 0.3646 |
| neural (promoted checkpoints) | **0.5040** | **0.6049** | 0.3542 |

Neural retrieval improves NDCG and MRR on this set. Hybrid alone does not: its
MRR is worse than lexical, and the query “jak przywrócić backup” still ranks a
schedule document first. That is recorded as an unresolved quality issue, not
smoothed over with a different metric.

### 5. Conditional execution
Executor steps may carry `when` conditions over typed results (`all`, `any`,
`not`, `exists`, `eq`, `neq`, `truthy`, `falsy`, `contains`, `gte`, `lte`).
There is no `eval`. A false condition marks the step `conditionSkipped` and lets
its dependents run, so a branch can be skipped without deadlocking the DAG.
Both branches are covered in `test/deep.js`.

### 6. Calendar and assistant slice
`core/calendar.js` imports and exports RFC 5545 VEVENT text without third-party
dependencies:

- UID-based updates, deterministic IDs for events without a UID;
- bounded DAILY/WEEKLY/MONTHLY recurrence with INTERVAL, COUNT, UNTIL and BYDAY;
- 2 MB text, 5,000-event and 1,000-occurrence limits;
- per-event error reporting instead of silent drops;
- unresolved `TZID` values are labelled, never guessed;
- all-day and floating times are distinguished.

It is wired into the daily briefing, five tools, CLI (`sentinel calendar …`),
HTTP (`/api/calendar`, `/api/calendar/event`, `/api/calendar/import`) and a real
UI lab card. It does not invite attendees or send anything over the network.

### 7. Property tests
`test/properties.js` checks five seeded invariants over random inputs:
calendar ordering/uniqueness, recurrence COUNT, ICS export/import round-trip,
retrieval score bounds/uniqueness and percentile monotonicity. It runs in
`npm test` and Linux CI. This is property-based testing, not 1,661 new checks.

## Verification

| Command | Result |
|---|---|
| `node scripts/check.js` | all checks passed |
| `node test/run.js` | 23 |
| `node test/ai.js` | 25 |
| `node test/ui.js` | 48/48 |
| `node test/deep.js` | 160 |
| `node test/properties.js` | 5 |
| `node scripts/eval.js` | 90/90, score 1.0 (deterministic mock) |
| `node scripts/audit-tools.js --no-write` | 350 tools, 29 categories, 86 executed, 264 unexecuted, 0 structural problems |
| specialist bench | 62 s, seven models, gates passed |
| retrieval bench | 0.7 s, four modes measured |

First-party source lines: **62,366** (60,431 in 7.0), **+1,935**.

## Honest non-claims

- No GPU, CUDA, RTX 4060 Ti, live Ollama or live model quality measurement.
- No real phone call, SIP registration, microphone recording or delivered message.
- No Windows CI, installer run, packaging or binary artifact.
- No LoRA/QLoRA/distillation/HPO implementation.
- No 120 agents, 1,000 tools, 2,000 checks or 103,465 lines.
- No claim that the hybrid retriever is production quality.
- No claim that a classifier is a generative language model.

## Why the quotas are not met

The remaining gap cannot be closed honestly by adding empty modules, duplicate
tool wrappers, agents with no implementation or tests that assert nothing. The
user explicitly prohibited filler and fabricated metrics. This slice therefore
adds a real, tested vertical slice and records the shortfall instead of hiding
it. The next work must start from the dependency-ordered list in
[`REQUIREMENTS-7.1.md`](REQUIREMENTS-7.1.md).
