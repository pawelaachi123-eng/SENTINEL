# SENTINEL 3.0 — progress and verification log

Branch: `arena/15fbea48-sentinel`. Everything below was executed in this
repository; nothing is projected or simulated unless the row says so.

## Verified gates

Run with `npm test` (Node 22+, no network, no desktop PC required):

| Suite | Checks | What it covers |
| --- | --- | --- |
| `node test/run.js` | **23 passed** | ESP32/Android/tunnel protocol, approvals, CLI, installer helpers |
| `node test/ui.js` | **27/27** | jsdom UI: pairing, chat over HTTP, cognition panel, event log, memory, diagnostics, demo mode |
| `node test/ai.js` | **25 passed** | assistant stack over the real HTTP API with mocks |
| `node test/deep.js` | **45 passed** | cognition, context budget, events, metrics, breakers, retry, experience gates, DAG tasks, memory 3.0, knowledge, structured output, provider failover, corrupt config, cognitive benchmark |

Source size (first-party, excluding `node_modules`, generated mobile assets,
models and caches): **38,338 lines** across JS/HTML/CSS/INO/PS1;
`core/`, `bin/`, `ui/`, `desktop/`, firmware: **27,936 lines**.

Registered: **31 agents**, **182 tools** in **21 categories** (implemented =
available in this environment; `verified` counts tools that have actually
succeeded at least once on this install and starts at 0, by design).

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

### Tools
- 182 tools, 21 categories, per-tool risk/platform/availability/dry-run
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
3. **Installer** — `INSTALL_SENTINEL_FULL.ps1` CLI/reporting update and an
   end-to-end run on real Windows are pending; all installer code paths here are
   exercised only by unit tests, not by an actual Windows machine.
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
