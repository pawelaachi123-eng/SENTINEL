# SENTINEL 3.0 — delivery report

Branch `arena/15fbea48-sentinel`, based on `main` at `79f47c1`. Everything in the
"verified" column was executed in this sandbox (Linux, Node 22, no GPU, no model
provider). Anything that needs Windows or a GPU is named as untested.

## 1. What changed

35 files, +5,498 / −134 lines against the 2.2.0 tag (`git diff --stat 007bbe4..HEAD`).

New: `core/cognition.js`, `core/context.js`, `core/experience.js`,
`core/events.js`, `core/metrics.js`, `core/reliability.js`, `core/patching.js`,
`core/tools/patch.tools.js`, `test/deep.js`, `docs/research.md`,
`docs/PROGRESS.md`, this report.

Rewritten: `core/tasks.js` (durable DAG engine).

Substantially extended: `core/brain.js`, `core/ai/llm.js`, `core/agent.js`,
`core/httpd.js`, `core/memory/{memory,store}.js`, `core/knowledge/index.js`,
`core/tools/{registry,memory.tools}.js`, `core/paths.js`, `bin/sentinel.js`,
`INSTALL_SENTINEL_FULL.ps1`, `ui/{index.html,ai.js,app.js,styles.css,sw.js}`,
`test/{ui,deep}.js`, `docs/{assistant,research,PROGRESS}.md`, `README.md`,
`package.json` (3.0.0), `.github/workflows/build.yml`.

Nothing in the ESP32, Android or tunnel paths changed: firmware stays 2.1.0 and
the 23 protocol tests are unchanged and passing.

## 2. Architecture

```
question
   │
   ▼
CognitiveCore.analyse ──► brief: intent, strategy + reason, complexity, risk,
   │                       constraints, goals, entities, assumptions,
   │                       completion criteria, uncertainty + reasons, budget
   │  (clarification short-circuit: vague follow-up never reaches the model)
   ▼
Knowledge.search / Memory.recall ──► evidence with citations, provenance and
   │                                  conflict flags; documents untrusted
   ▼
ContextManager.build ──► priority sections inside a token budget, history
   │                      digested, report of what was dropped/truncated
   ▼
Dispatcher ──► one specialist at a time (shared provider, 8 GB VRAM reality)
   │            ExperienceStore.recommend() biases the choice
   ▼
TaskManager (Deep/Research) ──► validated DAG, attempts + backoff, checkpoints,
   │                             pause/resume/cancel, idempotency
   ▼
Verification ──► deterministic checks + citations + tool evidence
   │              one repaired attempt in Deep, never unbounded
   ▼
Answer ──► events + metrics + experience + lastReport (UI shows the same data)
```

Cross-cutting: `EventBus` (typed, sequenced, bounded, subscriber-isolated),
`Metrics` (reservoir p50/p95, startup/idle baselines), `CircuitBreaker` + `retry`
+ `IncidentLog` + `Watchdog` (confirmation counts), approvals bound to exact
arguments and single-use, staged patches with isolated verification.

## 3. Verified features and exact evidence

| Suite | Result (this session) |
| --- | --- |
| `node test/run.js` | 23 passed |
| `node test/ui.js` | 30/30 |
| `node test/ai.js` | 25 passed |
| `node test/deep.js` | 49 passed |
| `node scripts/check.js` | syntax 71 files, 6 asset refs, boot — passed |

Deep checks include: brief classification (math/retrieval/clarify/plan/risk),
mode budgets, bounded reflection, context budget never exceeded, history digest,
event sequencing/retention/subscriber isolation, real p50/p95, breaker
open/half-open/closed, retry with backoff and refusal, incident grouping,
watchdog confirmation, experience scoring + regression gate, DAG cycle rejection,
retry/backoff, pause/resume/cancel hooks, restart reconciliation, idempotency,
partial success, memory provenance/scope/conflicts/supersede/asOf/integrity/
consolidation, FTS5 put/delete/restart/backfill + journal fallback, untrusted
document marking, rerank, coverage/staleness, code symbols, structured output
with one repair, schema failure code, provider failover with breaker, corrupt
config diagnosis, agent wiring, and the deterministic cognitive benchmark.

Coding workflow: 4 additional tests (propose never writes, failed syntax cannot
apply, approval required and non-replayable, backup content is the old file),
plus a UI test that renders a real staged diff.

Measured on this machine: arithmetic answer 49 ms end-to-end; 3-case benchmark
average 315 ms (the machine-state case dominates); boot to cognitive core ~20 ms;
idle RSS ~70 MB. These are deterministic-path numbers; model latency, tokens/s
and time-to-first-token require a GPU host and are not claimed.

HTTP smoke test (real agent, token auth): `/api/eventlog`, `/api/metrics`,
`/api/reliability`, `/api/experience`, `/api/memory/conflicts`,
`/api/memory/integrity`, `/api/diagnostics` all 200. `/api/events` was found to
be the existing SSE stream; the typed bus was renamed `/api/eventlog` because two
handlers cannot share one route.

## 4. Agents and tools: working vs registered

- **31 agents** (2 orchestrators, 19 model-driven specialists, 10 tool
  specialists) — all registered and routable. "Working" is proven only for those
  exercised by the suites (math, machine state, memory/knowledge, conversation,
  dispatcher/supervisor/verifier); the rest are registered, described and
  routable but not individually exercised end-to-end.
- **188 tools in 21 categories** — `implemented` = `available` = 188 here;
  `verified` = 0 at first boot and increases only when a tool actually succeeds.
  No tool was added to inflate a count that the tests do not cover: each new tool
  (`memory.conflicts`, `memory.integrity`, `memory.consolidate`, `kb.coverage`,
  `kb.stale`, `kb.symbols`, six `patch.*`) has a test or a UI path.
- The 50–100 specialist target was **not** met by padding; 31 was kept.

## 5. Security limits (unchanged and tightened)

- Default deny; writes/system/privileged need approval; approvals are bound to
  the exact tool and argument set, single-use, expiring; replay refused (tested
  for `patch.apply`).
- A model-supplied `confirm: true` is not consent: only a consumed approval sets
  `ctx.approvalId`.
- No unrestricted shell tool, no policy self-editing, no automatic privilege
  escalation, global STOP, path sandbox before permission checks.
- Tool output and documents are untrusted data; injection findings are counted
  and shown; MCP is not enabled by default (not implemented in 3.0).
- No telemetry; external model APIs are opt-in configuration.

## 6. Installer

`INSTALL_SENTINEL_FULL.ps1` now targets `%USERPROFILE%\Desktop\SENTINEL`,
stages into `SENTINEL.staging-<stamp>`, verifies the staged tree, moves the
existing install to `SENTINEL.backup-<stamp>`, activates, rolls back on failure,
runs `sentinel migrate`, health-checks on a private port with its own process
(stopped afterwards), installs `sentinel.cmd`, and adds it to the user PATH.
CLI: `doctor`, `chat`, `ask`, `models`, `agents`, `tools`, `memory`, `tasks`,
`status`, `benchmark`, `test`, `backup`, `update`, `rollback`, `migrate`,
`serve`, `automations`, `voice`, `index`, `approvals`.

**Not verified:** the script was reviewed for syntax and structure but never
executed — this sandbox has no PowerShell and no Windows. Treat the first real
run as a test.

## 7. Next priorities

1. Run the installer on real Windows and fix what breaks.
2. MCP client, opt-in, out of process, permission-scoped.
3. Real-model benchmarks on the RTX 4060 Ti host (tokens/s, first token, Deep
   mode latency) and a Polish speech/OCR regression.
4. Project-isolation UX for memory scopes and a conflict-resolution workflow.
5. Scheduled-workflow approvals and history in the UI (automation exists; the
   approval surface for unattended runs does not).
