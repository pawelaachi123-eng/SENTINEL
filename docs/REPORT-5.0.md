# SENTINEL 5.0.0 — NEURAL COGNITIVE SYSTEM (implemented slice)

Status: **partial, honest**. This release adds a real neural-runtime discovery
layer, evidence-bound reasoning, a gated skill library, repository intelligence
and context invariants, and fixes the Windows behaviour-test failure. Several
mandated workstreams from the 5.0 brief are **not implemented yet** and are
listed as outstanding below. Nothing in this report is a claim that the system
reaches ChatGPT/Claude/JARVIS parity.

Measured on this machine (Linux x64, Node 22.22.3, 2 vCPU, 3.8 GB, no GPU, no
model server running):

| gate | result |
| --- | --- |
| `node test/run.js` | 23/23 passed |
| `node test/ai.js` | 25/25 passed |
| `node test/ui.js` | 35/35 passed |
| `node test/deep.js` | **117/117 passed** (was 99) |
| `node scripts/check.js` | All checks passed |
| `node scripts/eval.js` | 23/23, score 1, **mode: mock** — not a model-quality measurement |
| `node scripts/audit-tools.js --no-write` | **219 tools / 22 categories / 0 structural problems / 14 of 14 executed / 205 unexecuted** |
| `sentinel neural` | 0 models (no provider running) — exit 0 |
| `sentinel neural route vision` | `NO_CAPABLE_MODEL` — **exit 4** |

## What is genuinely new

1. **Neural runtime** (`core/neural.js`, 494 lines). Discovers models from
   Ollama `/api/tags` + `/api/show` and OpenAI-compatible `/v1/models`, and
   records only what the provider reports: architecture, parameter size/count,
   quantisation, context length, embedding length, block/head/KV-head counts,
   size, explicit `capabilities`. Absent fields stay `null`; name-based guesses
   are flagged `capabilitiesInferred`. TTL cache persisted in SQLite
   (`model_registry`) survives restarts. Capability-aware routing for
   reasoning/coding/vision/embedding/rerank/classification/tools/thinking with
   `NO_CAPABLE_MODEL` refusals, external inference skipped unless enabled,
   bounded per-provider concurrency, cancellation propagation, warm-up, real
   keep-alive unload, and one bounded schema-repair attempt for structured
   output. Token counts are labelled estimates because no provider here exposes
   a tokenizer endpoint.
2. **Evidence-bound reasoning** (`core/reasoning.js`). Hypotheses are generated
   only from measured signals that crossed a threshold; each names the tool that
   could refute it. A failed measurement is `untested`, never `supported`.
   Confidence is a documented function of tests (untested halves it,
   contradiction caps it at 0.5, no support returns
   `insufficient_evidence`). Contradictory facts are preserved with both
   sources; agreement between two calls to the same model is explicitly **not**
   independent evidence.
3. **Gated skill library** (`core/skills.js`). Candidates require typed
   parameters, preconditions, scope and permissions; identical proposals are
   deduplicated by fingerprint; promotion requires a **held-out** gate result and
   a named human approval; a lower score than the validated version is rejected
   as a regression and the good version stays validated; retirement is final for
   matching and promotion.
4. **Repository intelligence** (`core/repomap.js`). Bounded map of
   JS/TS/Python/C/C++/Java/C#/PowerShell/markup with declarations, imports,
   entrypoints, nearest tests, symbol search and change impact. It is lexical and
   says so — no type inference is faked. File/size limits are reported
   (`truncated`), not hidden.
5. **Context invariants** (`core/context.js`). System rules, the user's question
   and explicit user constraints are **mandatory** and never dropped; overflow
   is reported instead of silently discarding constraints. Every build subtracts
   a configurable output reserve before admitting optional sections, and labels
   token figures as estimates.
6. **Patch verification binding** (`core/patching.js`). `verify()` now records
   SHA-256 of the verified candidate and of the baseline. `apply()` recomputes
   both and refuses with `STALE_VERIFICATION` if either changed — verification
   can no longer be replayed onto different content.
7. **Windows fix.** `npm` is `npm.cmd` on Windows and cannot be spawned without
   a shell, which broke isolated patch verification ("Behaviour tests on
   Windows"). The verifier now uses `npm.cmd` on `win32`. The eval sandbox case
   uses `C:\Windows\System32\config\SAM` on Windows via `platformInput` instead
   of the POSIX-only `/etc/passwd`. **This fix has not yet been confirmed by a
   green Windows run.**
8. **MCP.** `2025-11-25` is now an accepted negotiated version (2025-06-18
   remains the requested default for widest server support). Tasks and other
   experimental 2025-11-25 features are **not** implemented; only version
   negotiation changed.
9. **CLI.** `sentinel neural [status|discover|route <task>]` with JSON output
   and meaningful exit codes (0 ok, 4 no capable model / all providers down).
10. **Tests.** 18 new deep checks cover metadata honesty, inference labelling,
    cache/TTL/restart persistence, routing refusals, concurrency bounds,
    cancellation, schema repair, hypothesis gating, contradiction retention,
    non-independence, skill promotion/regression/retirement, repository map
    bounds/impact, context mandatory/reserve behaviour and stale-patch
    rejection.

Tool count grew from 206 to **219** across the same 22 categories: 4 neural,
2 reasoning, 4 skills, 3 repository tools.

## Explicitly NOT implemented (outstanding 5.0 requirements)

- Neural learning laboratory (LoRA/QLoRA/distillation/preference training, a
  really trained classifier/reranker, experiment versioning, contamination
  checks, approval-gated training pipeline).
- New memory types/migrations beyond the existing memory store; graph+vector
  RAG fusion and research sessions.
- Executive DAG upgrades beyond the shipped 4.0 executor (conditional
  branches, deadlines, full state machine, STOP propagation into subprocesses,
  restart-safety tests).
- Organisation growth toward 60–100 agents; measured team selection.
- Tool registry growth toward 300–500; semantic tool discovery.
- Coding intelligence beyond the map: multi-file patches, refactoring,
  hostile-fixture patch tests.
- Quantisation/offload measurements on the RTX 4060 Ti, Gaming Mode
  measurements, first-token/tokens-per-second data.
- Security negative tests per execution path, fault-injection suite, degraded
  modes.
- Multimodal STT/TTS/OCR fixtures, ESP32/Android integration verification.
- UI panels for the new subsystems, orb state bindings, scheduled workflows.
- Expanded cognitive evaluation corpus (hundreds of cases) and a Windows CI
  re-run with a green result.
- Installer changes for 5.0 (the 4.0 installer and health checks are unchanged).

## Sources used

- Ollama API (`/api/tags`, `/api/show`) and metadata keys:
  <https://github.com/ollama/ollama/blob/main/docs/api.md>
- Model Context Protocol versioning and revisions:
  <https://modelcontextprotocol.io/specification/>
- sqlite-vec (MIT OR Apache-2.0): <https://github.com/asg017/sqlite-vec>
- τ-bench, `pass^k`: <https://arxiv.org/abs/2406.12045>
- Agentic Benchmark Checklist (overestimation in agent benchmarks):
  <https://arxiv.org/abs/2507.02825>

## Limitations that must be repeated

The deterministic gate passed against the mock provider. No live model was
called, no GPU measurement was taken, the Windows job has not been re-run yet,
and 205 of 219 tools were not executed by the audit. Those are gaps, not passes.
