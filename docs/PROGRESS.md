# SENTINEL 7.0–7.1 — progress and verification log

Branch: `arena/15fbea48-sentinel`. **Source-only build: no EXE, MSI, APK, AAB,
BIN, HEX or UF2, and no packaging/publishing jobs.** The persistent ledger is
`docs/REQUIREMENTS-7.0.md`; the measured report is `docs/REPORT-7.0.md`.

## 7.0 state (this slice)

Implemented and tested: matrix reverse-mode autodiff with gradient checks; a
trainable single-block transformer and gated sentiment lab; a gated retrieval
reranker trained against a lexical baseline; a typed cognitive hypercore with
budgets, conflicts, deduction and persistence; a consent-based communication
manager with mock + Twilio adapters and signed webhooks; 48 new science,
productivity, hypercore, reranker, communication, assistant and specialist tools;
four gated specialist classifiers (tool selection, agent routing, memory
relevance, task complexity) measured against named baselines; cited daily
briefing; opt-in proactive rules; source-only CI; CLI/API/UI panels. See the
ledger for what remains — notably 120+ agents, 1,000+ tools and 2,000+ tests were
**not** reached.

| Gate | Result |
| --- | --- |
| `node test/run.js` | 23 passed |
| `node test/ai.js` | 25 passed |
| `node test/ui.js` | **48/48** |
| `node test/deep.js` | **153/153** |
| `node scripts/check.js` | all checks passed (includes source-only policy) |
| `node scripts/eval.js` | **90/90**, score 1, **mock mode** |
| `node scripts/audit-tools.js` | **342 tools / 29 categories / 0 problems / 83 executed / 259 unexecuted** |
| `npm run bench:neural` | intent 0.796 vs 0.755; transformer 1.000 vs 0.964; reranker NDCG@3 0.8443 vs 0.8273 |
| `npm run bench:specialists` | tools 0.8125 vs 0.6875; routing 1.000 vs 0.875; relevance 0.9444 vs 0.6667; complexity 0.8333 vs 0.8333 |
| source lines | **60,431** (+6,966 over 6.0) |
| Windows CI | recorded on the PR; see the commit status |

No GPU, live model, provider account or real phone call was available. No metric
here is a language-model benchmark, and no communication was actually delivered.

# Historical: SENTINEL 6.0 progress log

Branch: `arena/15fbea48-sentinel`. Everything below was executed in this
repository unless explicitly labelled otherwise. The persistent requirement
matrix is `docs/REQUIREMENTS-6.0.md`; the delivery report is
`docs/REPORT-6.0.md`.

## 6.0 status (this slice)

Implemented and tested: real CPU MLP with gradients/checkpoints; learning lab
with measured held-out metrics, approval-gated promotion and rollback; typed
memory (conversation/preference/temporal/prospective), due reminders and
preview/apply migration with backup; persistent research sessions with
line-level citations and conflicts; 38 deterministic data/statistics/text/
encoding tools; lab/neural/research API, UI panel and CLI; installer read-only
health checks. Outstanding work is listed in the matrix, not hidden.

| Gate | Result |
| --- | --- |
| `node test/run.js` | 23 passed |
| `node test/ai.js` | 25 passed |
| `node test/ui.js` | **41/41** |
| `node test/deep.js` | **131/131** |
| `node scripts/check.js` | all checks passed |
| `node scripts/eval.js` | **76/76**, score 1, **mock mode** |
| `node scripts/audit-tools.js --no-write` | **270 tools / 24 categories / 0 problems / 59 executed / 211 unexecuted** |
| `sentinel train --approve tester` | candidate, test 0.796 vs baseline 0.755, 197,681-byte checkpoint |

**Windows CI is green for 6.0** at `1720262` (behaviour tests, deterministic
evaluation and tool audit). No GPU or live model was available, and the installer was not
executed here.

# Historical: SENTINEL 5.0 progress log

Branch: `arena/15fbea48-sentinel`. Everything below was executed in this
repository; anything unexecuted is labelled as such.

## 5.0 status

Implemented and measured (details in `docs/REPORT-5.0.md`): neural runtime
discovery/routing (`core/neural.js`), evidence-bound reasoning
(`core/reasoning.js`), gated skill library (`core/skills.js`), repository map
(`core/repomap.js`), mandatory context sections + output reserve, SHA-256 patch
verification binding, `sentinel neural` CLI, MCP `2025-11-25` negotiation, and
the Windows `npm.cmd` verifier fix.

| Gate | 5.0 result |
| --- | --- |
| `node test/run.js` | 23 passed |
| `node test/ai.js` | 25 passed |
| `node test/ui.js` | 35/35 |
| `node test/deep.js` | **117/117** (99 in 4.0) |
| `node scripts/check.js` | all checks passed |
| `node scripts/eval.js` | 23/23, score 1, **mock mode** |
| `node scripts/audit-tools.js --no-write` | **219 tools / 22 categories / 0 problems / 14 executed / 205 unexecuted** |

Not implemented yet: learning lab, new memory types/research sessions, expanded
executive DAG, organisation growth, tool growth to 300+, multi-file coding
patches, hardware measurements, security/fault-injection suites, multimodal
fixtures, new UI panels, expanded eval corpus, 5.0 installer changes, and a green
Windows CI run. **Windows CI is green** as of `d995bf7`: behaviour tests, deterministic evaluation and tool audit all passed on `windows-latest`.

# Historical: SENTINEL 4.0 progress log

Branch: `arena/15fbea48-sentinel`. Everything below was executed in this
repository. Items that could not be executed here are listed as not verified.

## 4.0 verified gates

| Suite | Checks | What it covers |
| --- | --- | --- |
| `node test/run.js` | **23 passed** | protocol, approvals, CLI, installer helpers |
| `node test/ui.js` | **35/35** | pairing, chat over HTTP, cognition, patches, runtime, graph, organisation, MCP, diagnostics |
| `node test/ai.js` | **25 passed** | assistant stack over the real HTTP API with mocks |
| `node test/deep.js` | **99 passed** | semantics, executor, isolated verification, graph, MCP, runtime, evaluation, organisation, conversation state + 3.0 checks |
| `node scripts/check.js` | all checks passed | syntax, assets, boot |
| `node scripts/eval.js` | **23/23** | deterministic core with every provider disabled |
| `node scripts/audit-tools.js` | 0 structural problems | 206 tools, 14 executed successfully, 192 unexecuted |
| `node scripts/bench.js` | completed | numbers in `docs/bench-4.0.json` |

Registered: **31 agents**, **206 tools** in **22 categories**
(139 read, 40 write, 23 system, 3 network, 1 privileged). `verified` means a
real successful execution: the audit ran **14** tools; the other 192 are
unexecuted, not "verified".

Source size: **45,684 lines** first-party (JS/HTML/CSS/INO/CPP/PS1, excluding
dependencies and generated assets); `core/`, `bin/`, `ui/`, `desktop/`,
`firmware/src/` and `scripts/` alone: **42,685**.

## 4.0 work items

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Research then implement (MemGPT, GraphRAG, LangGraph, MCP, OpenHands, eval practice, local inference) | done | `docs/research.md` §13, `docs/REPORT-4.0.md` §5 |
| 2 | Hybrid deterministic/LLM semantic engine | done | `core/semantics.js`, 9 semantics tests |
| 3 | Persistent execution engine (DAG → dispatcher) | done | `core/executor.js`, 9 executor tests, Brain plan path |
| 4 | Hierarchical multi-agent organisation | done as structure, not head-count | `core/org.js`; 31 agents in 4 tiers, bounded delegation |
| 5 | Model runtime profiles for i7-13700F / RTX 4060 Ti / 32 GB | done, GPU path unverified on hardware | `core/runtime.js`, 5 tests |
| 6 | Memory 3.0+ and structured conversation state | done | summaries in `core/memory/memory.js`, 4 tests |
| 7 | Knowledge graph + advanced RAG with multi-hop tests | done | `core/graph.js`, 3-hop provenance test |
| 8 | Experience learning with held-out evaluation and gates | done | `core/evaluation.js`, 5 tests, `scripts/eval.js` |
| 9 | Universal tool audit | done with honest limits | 206 tools, 0 structural problems, 14 executed |
| 10 | Optional MCP client | done | `core/mcp.js`, 6 tests against HTTP + stdio fixtures |
| 11 | Repository-aware coding with isolated verification | isolation done; repo map not yet | `core/patching.js`, copy-isolation tests |
| 12 | Research/evidence with citations | preserved from 3.0, graph adds provenance | no new citations engine in 4.0 |
| 13 | Windows assistance + security audit with negative tests | negative tests done; Windows matrix not run here | injection/secret/shutdown/sandbox tests |
| 14 | Reliability/recovery | existing breakers/incidents + persisted executor transitions | deep suite |
| 15 | Voice/vision/Android/ESP32 preserved | protocol tests pass, firmware untouched | `test/run.js`, `test/ai.js` |
| 16 | Functional UI/observability from real APIs | done | runtime, graph, org, MCP panels; UI 35/35 |
| 17 | Benchmark suite + Windows CI | benchmark executed; CI configured, not executed here | `scripts/bench.js`, `.github/workflows/build.yml` |
| 18 | Installer + report | done | `INSTALL_SENTINEL_FULL.ps1`, `docs/REPORT-4.0.md` |

## 4.0 measurements (Linux sandbox, no GPU, providers disabled)

| Measurement | Value |
| --- | --- |
| Agent construction | 32.1 ms |
| Deterministic `brain.ask` | p50 4.33 ms / p95 34.76 ms |
| Semantic interpretation | p50 0.24 ms / p95 0.96 ms |
| Memory recall (150 records) | p50 1.16 ms / p95 6.43 ms |
| Knowledge search (40 docs) | p50 0.29 ms / p95 1.23 ms |
| Graph query (200 nodes, 2 hops) | p50 0.60 ms / p95 1.40 ms |
| Executor (5 steps) | p50 6.12 ms / p95 9.71 ms |

Not measured: tokens/s, time-to-first-token, VRAM on the target GPU, Windows
boot. No model was called in any 4.0 measurement.

---

# SENTINEL 3.0 — historical log (kept for comparison)

Branch: `arena/15fbea48-sentinel`. Everything below was executed in this
repository; nothing is projected or simulated unless the row says so.

## Verified gates

Run with `npm test` (Node 22+, no network, no desktop PC required):

| Suite | Checks | What it covers |
| --- | --- | --- |
| `node test/run.js` | **23 passed** | ESP32/Android/tunnel protocol, approvals, CLI, installer helpers |
| `node test/ui.js` | **30/30** | jsdom UI: pairing, chat over HTTP, cognition panel, event log, memory, diagnostics, demo mode |
| `node test/ai.js` | **25 passed** | assistant stack over the real HTTP API with mocks |
| `node test/deep.js` | **49 passed** | cognition, context budget, events, metrics, breakers, retry, experience gates, DAG tasks, memory 3.0, knowledge, structured output, provider failover, corrupt config, cognitive benchmark |

Source size (first-party, excluding `node_modules`, generated mobile assets,
models and generated mobile assets): **31,631 lines** across JS/HTML/CSS/INO/
CPP/PS1; `core/`, `bin/`, `ui/`, `desktop/` and firmware alone: **29,098**.

Registered: **31 agents**, **188 tools** in **21 categories**. `implemented`
and `available` are equal in this environment; `verified` counts tools that have
actually succeeded at least once on this install and starts at 0, by design.

## Measured on this machine (Linux sandbox, no GPU)

| Measurement | Value | How |
| --- | --- | --- |
| Deterministic arithmetic answer | 49 ms end to end | `brain.ask({text:'ile to 123*321', mode:'fast'})` |
| Cognitive benchmark (3 cases, average) | 315 ms | `test/deep.js`, includes machine-state collection |
| Boot to cognitive core ready | ~20 ms | `metrics` series `agent.boot` |
| Idle RSS after boot | ~70 MB | `process.memoryUsage().rss` |
| Startup baseline | recorded at boot | `metrics.recordBaseline('agent-boot', …)` |

These are not model latency numbers: no model provider is running in the
sandbox, so answers are produced by the deterministic paths. Model latency,
tokens/s and time-to-first-token are measured only when a provider is reachable
(`/api/models/benchmark`, `llm.latency`, `llm.tokensPerSecond`) and are never
filled in with guesses.

## Delivered in 3.0

### Cognition and context
- `core/cognition.js`: brief (intent, strategy, complexity, risk, constraints,
  goals, entities, assumptions, completion criteria, uncertainty with reasons,
  budget), task class, deterministic `estimateTokens`, bounded `reflect()`,
  `analyseVerification()`.
- `core/context.js`: priority-ordered token budget, per-section truncation,
  history digest, auditable report exposed in `/api/cognition` and the UI.
- Modes Fast / Balanced / Deep / Research with distinct budgets; clarification
  short-circuit; one repaired attempt in Deep.

### Tasks
- `core/tasks.js` rewritten as a durable DAG engine: `validateDag` (cycles,
  duplicates, unknown dependencies, step cap), statuses, attempts with
  exponential backoff, checkpoints, idempotency keys, deadlines, pause/resume,
  cancel with hooks, `readySteps`/`blockedSteps`, restart reconciliation to
  `interrupted`, partial-success labelling.

### Memory and knowledge
- Provenance, confidence, scopes, conflict detection (both facts kept),
  supersession, `asOf` queries, consolidation, integrity report.
- FTS5 lexical index beside the records: kept in sync on put/delete/clear,
  backfilled once for older stores, `fts:false` reported honestly on the journal
  driver, exact-identifier rescue in `recall`.
- Knowledge: untrusted-content marking with injection findings, lexical rerank,
  two-fragment-per-document diversity, `coverage()`, `stale()`, `symbols()` and
  `findSymbols()`, citations on every hit.

### Reliability
- Circuit breakers per provider and per resilience wrapper, bounded retry with
  cancellation, incident log with grouping/recovery, watchdogs with confirmation
  counts, provider-outage and corrupt-config fault-injection tests.
- Task reconciliation on start, `cancelAll` on stop, approval-scoped tool gate.

### Coding workflow
- `core/patching.js`: staged patches — `create` (diff + before/after kept under
  `SENTINEL_HOME/patches/<id>`), `verify` (whitelisted verifier in an isolated
  workspace; `node --check` by default, `npm test` optional with the original
  restored afterwards), `apply` (needs a consumed approval and a passed
  verification, writes a timestamped backup, then `confirm()` compares the file
  on disk with the verified candidate), `discard`.
- Tools `patch.propose`, `patch.verify`, `patch.diff`, `patch.apply`,
  `patch.discard`, `patch.list`; API `/api/patches`; UI panel in **Poznanie**
  with the full propose → verify → diff → approve → write → confirm path.
- Regression tests cover: proposing never writes, syntax failure cannot be
  applied, approval is required and single-use, backup content is the old file.

### Tools
- 188 tools, 21 categories, per-tool risk/platform/availability/dry-run
  metadata, execution evidence, `implemented`/`available`/`verified` counts.
- New: `memory.conflicts`, `memory.integrity`, `memory.consolidate`,
  `kb.coverage`, `kb.stale`, `kb.symbols`.

### API
`/api/eventlog`, `/api/metrics`, `/api/reliability`, `/api/experience`,
`/api/feedback`, `/api/cognition` (GET report, POST analyse),
`/api/memory/conflicts`, `/api/memory/integrity`, `/api/memory/consolidate`,
`/api/tasks/pause`, `/api/tasks/resume`. Note: `/api/events` remains the live
SSE log stream; the typed bus is `/api/eventlog` so the two cannot shadow each
other (this collision was found by an HTTP smoke test).

### UI 3.0
- New **Poznanie** section: last-run brief, strategy, risk, confidence, context
  budget with per-section usage, event timeline, experience table, reliability
  (breakers, incidents, watchdogs), feedback button.
- **Research** mode, task pause/resume, memory contradictions panel,
  Ctrl/Cmd+K and Escape shortcuts, reduced-motion honoured, real API data only.

## Remaining work (not claimed as done)

1. **MCP client** — optional, permission-scoped, out of process. Not implemented
   in 3.0; the protocol research is in `docs/research.md` §7.
2. **Multimodal pipeline** — STT/TTS/vision/OCR exist behind optional local
   binaries from 2.x, but Polish OCR/TTS quality was not re-verified in this
   session and there is no Polish speech regression test.
3. **Installer** — `INSTALL_SENTINEL_FULL.ps1` now stages atomically, backs up,
   migrates, health-checks on a private port and installs a `sentinel.cmd`
   wrapper, but none of it has been executed on a real Windows machine; the
   syntax and structure were reviewed, not run (no PowerShell in this sandbox).
4. **Windows troubleshooting evidence** — tools exist, but none of the hardware
   specific behaviour (RTX 4060 Ti limits, WDDM, Gaming Mode) could be executed
   in this Linux sandbox; it is untested hardware, not verified.
5. **Benchmarks under a real model** — p50/p95 tokens/s and time-to-first-token
   need a GPU host with Ollama; the measurement code is in place.
6. **FTS5 on Windows** — depends on the SQLite build inside the shipped Node
   runtime; the capability flag and fallback are tested, the Windows binary is
   not.
7. **Agent count** — 31 meaningful specialists; the acceptance target of 50–100
   was not pursued by padding, per the no-artificial-counts rule.

## How to reproduce

```bash
npm install            # dev dependencies only (jsdom for the UI suite)
npm test               # 23 + 27 + 25 + 45 checks
node bin/sentinel-agent.js --open
```

`SENTINEL_HOME` must be set when testing away from the default data directory;
tests use temporary directories and never touch a real install.


## 7.1 slice — neural specialists, retrieval measurement, conditional execution, calendar

The authoritative requirement-level status is `docs/REQUIREMENTS-7.1.md`. This
section records what changed and how it was measured; it does **not** claim the
7.1 quotas were reached.

### Implemented

- **Three new specialists** (`semantic`, `context`, `failure`) trained on 1,852
  authored items with group-disjoint splits. Seven models total.
- **Calibration** (`core/ml/calibration.js`): temperature scaling with ECE and
  Brier score; calibrated confidence only, labels unchanged.
- **5-fold cross-validation** (`SpecialistZoo.crossValidate`) over all authored
  items: tools 0.8734 vs 0.7722, routing 0.8936 vs 0.8085, relevance 0.975 vs
  0.6833, complexity 0.9 vs 0.825.
- **Integration**: brain reranks memory/context with specialist predictions;
  dispatcher attaches an advisory failure prediction; routing hint can come
  from a promoted model without overriding strong keywords.
- **Seven specialist API/CLI paths** and seven tool entries; the UI card reports
  active/total models without inventing activity.
- **Unified retriever** (`core/retrieval/unified.js`): BM25 + hashed vector +
  graph proximity + RRF, optional semantic/reranker boosts, provenance and
  nDCG/MRR/recall/latency benchmark. New neural mode measured at NDCG@3 0.5040
  vs lexical 0.4683; hybrid 0.4704. Hybrid's MRR is worse than lexical, so no
  hybrid improvement is claimed.
- **Conditional executor steps** (`when` with `all/any/not` and typed operators,
  no eval). A false condition is recorded as `conditionSkipped` and does not
  block dependents. Both branches are tested.
- **Calendar** (`core/calendar.js`): RFC 5545 VEVENT import/export, UID updates,
  bounded recurrence, limits, per-event errors, honest TZID labelling; wired to
  the daily briefing, five tools, CLI, HTTP and the UI lab card.
- **Property tests** (`test/properties.js`): 5 seeded invariants, included in
  `npm test` and the Linux workflow.

### Measured state

| Measure | Value |
|---|---|
| First-party source lines | 62,366 |
| Tools / categories | 350 / 29 |
| Executed / unexecuted audit | 86 / 264 |
| Agents | 31 |
| Checks | 351 (23 + 25 + 48 + 160 + 5 + 90) |
| Specialists | 7 |

Targets (103,465 lines, 1,000 tools, 120 agents, 2,000 checks) are not met.
Filler modules, name-only agents and invented tests were not added; the gap is
recorded in the requirements ledger.

### Verification commands

```bash
node scripts/check.js
node test/run.js && node test/ai.js && node test/ui.js
node test/deep.js && node test/properties.js
node scripts/eval.js
node scripts/audit-tools.js --no-write
SENTINEL_HOME=/tmp/spec71 npm run bench:specialists
SENTINEL_HOME=/tmp/retr npm run bench:retrieval
```
