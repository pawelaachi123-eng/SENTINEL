# SENTINEL 4.0.0 — delivery report

Branch: `arena/15fbea48-sentinel` (PR #1, open — not merged).
Everything in this report was executed in this checkout. Where something was
not executed, it is listed as not verified rather than described as working.

---

## 1. What 4.0 is

3.0 was a competent local assistant with a reasoning facade. 4.0 changes the
things that were actually weak:

| Area | 3.0 | 4.0 |
| --- | --- | --- |
| Understanding | deterministic brief, model used as a writer | hybrid interpreter: deterministic brief keeps authority, model pass is schema-validated, gated and degradable (`core/semantics.js`) |
| Execution | `dispatcher.runPlan` walked steps in a loop, ignoring the DAG | `Executor` runs the DAG with transitions, typed outputs, read-only concurrency, write serialisation, retries, cancellation, approvals, budgets and bounded replanning (`core/executor.js`) |
| Verification | `npm test` patches were swapped into the live tree and restored | full project copy, verifier runs there, original file byte-identical afterwards (`core/patching.js`) |
| Memory | vector recall + transcript | add deterministic structured conversation state: topics, decisions, constraints, open question, secrets skipped (`core/memory/memory.js`) |
| Knowledge | document chunks only | persistent typed graph with conflict retention and bounded multi-hop traversal (`core/graph.js`) |
| Learning | counters and candidate records | held-out evaluation with stable splits and promotion gates that reject mocks and regressions (`core/evaluation.js`) |
| Models | mode → model mapping | hardware detection, VRAM feasibility, idle/balanced/deep/gaming profiles with real unload (`core/runtime.js`) |
| Tools | 188 tools | 206 tools in 22 categories; structural audit + real executions (`scripts/audit-tools.js`) |
| External tools | none | opt-in MCP client (stdio + Streamable HTTP) with revision negotiation and approval-bound calls (`core/mcp.js`) |
| Organisation | flat roster | tiered organisation derived from real capabilities, bounded delegation (`core/org.js`) |
| Observability | cognition, patches, experience, reliability | plus runtime/hardware, graph explorer, organisation and MCP panels driven by their APIs |

The full list of 4.0 work items and their status is in `docs/PROGRESS.md`.

---

## 2. Capability inventory (measured, not planned)

- **Agents: 31**, roles: 2 orchestrator (`supervisor`, `planning`), 19 model
  specialists, 10 deterministic tool agents. No duplicate titles; the audit test
  asserts uniqueness. The requested 60–100 agents were deliberately not created:
  beyond these 31, additional agents would be renamed duplicates with no distinct
  capability, which the brief forbids.
- **Tools: 206 in 22 categories.** Permissions: 139 read, 40 write, 23 system,
  3 network, 1 privileged.
  - knowledge 17, system 34, files 19, code 14, memory 13, documents 11,
    desktop 10, git 10, network 10, ai 9, math 9, automation 6, healing 6,
    security 6, dev 5, esp32 5, tasks 5, mcp 4, voice 4, mobile 3, perf 3,
    vision 3.
  - New in 4.0: `graph.*` (7), `mcp.*` (4), `runtime.*` (3), `org.*` (2),
    `memory.summary`, `memory.summarise`.
- **Subsystems:** cognition, semantics, executor, DAG task manager, approvals,
  sandbox, memory, knowledge/RAG, graph, experience, evaluation, runtime, MCP,
  organisation, patching, self-healing, reliability, metrics/events, LLM routing,
  voice, vision, automations, HTTP API/UI, ESP32 link, Android client, firmware.
- **Model runtime profiles:** idle, balanced, deep, gaming. Deep is refused with
  `VRAM_INSUFFICIENT` when the estimate does not fit; gaming unloads resident
  models and forces heavy requests down to fast with the reason attached to the
  answer.
- **MCP:** protocol 2025-06-18 requested; 2025-03-26 and 2024-11-05 accepted when
  the server counter-proposes. The negotiated revision is reported per server.
  Supported surfaces: `tools/list`, `tools/call`, `resources/list`,
  `resources/read`, `prompts/list`. Not implemented and not claimed: sampling,
  elicitation, roots, Tasks.

---

## 3. Changed and new files

New core modules:
`core/semantics.js`, `core/executor.js`, `core/graph.js`, `core/mcp.js`,
`core/runtime.js`, `core/org.js`, `core/evaluation.js`.

New tool modules:
`core/tools/graph.tools.js`, `core/tools/mcp.tools.js`,
`core/tools/runtime.tools.js`, `core/tools/org.tools.js`.

New scripts and suites:
`scripts/eval.js`, `scripts/audit-tools.js`, `scripts/bench.js`,
`eval/cases.json`, `test/fixtures/mcp-server.js`,
`docs/tool-audit-4.0.json`, `docs/bench-4.0.json`.

Modified: `core/agent.js` (construction and status for the new subsystems),
`core/brain.js` (semantic interpretation, executor execution, graph context,
conversation state, runtime downgrade, `proposeReplan`), `core/tasks.js`
(`setState`, `insertSteps`, `skipStep`, step metadata), `core/security/approvals.js`
(non-executing `approve` for task-owned approvals), `core/context.js`
(graph + conversation sections), `core/memory/memory.js` (summaries, ordering
fix, secret pattern), `core/cognition.js` (mass-deletion risk, diacritic
folding), `core/ai/dispatcher.js` (arithmetic routing), `core/ai/agents.js`
(sqrt/percent phrasing), `core/httpd.js` (`/api/graph`, `/api/mcp`,
`/api/runtime`, `/api/org`), `core/tools/index.js`, `core/tools/memory.tools.js`,
`ui/index.html`, `ui/ai.js`, `bin/sentinel.js` (`runtime`, `graph`, `org`, `mcp`),
`INSTALL_SENTINEL_FULL.ps1`, `.github/workflows/build.yml`,
`package.json`/lock (4.0.0), `ui/app.js`, `ui/sw.js`, tests and docs.

---

## 4. Size

Method: `wc -l` over first-party JavaScript/HTML/CSS/INO/CPP/PS1, excluding
`node_modules`, models, binaries and generated assets.

| Scope | 3.0 | 4.0 |
| --- | --- | --- |
| Total first-party source | 31,631 | **45,684** |
| `core/` + `bin/` + `ui/` + `desktop/` + `firmware/src/` + `scripts/` | 29,098 | **42,685** |

The growth is concentrated in the new engines and their tests, not in padding:
`core/semantics.js` 575 lines, `core/mcp.js` 533, `core/graph.js` 446,
`core/executor.js` 414, `core/runtime.js` 296, `core/org.js` 147,
`core/evaluation.js` 158
(including the deterministic resolver it wraps). Mobile assets duplicate the UI
for offline use and account for ~7,000 of the total.

---

## 5. Research → implementation (not just citations)

| Source area | What was read | What changed in the repository |
| --- | --- | --- |
| MemGPT/Letta, durable workflows | memory hierarchy, explicit state, resumable runs | conversation summaries with source turns; task transitions persisted on every step; executor reconciliation of interrupted runs |
| GraphRAG | entity graphs, multi-hop context | typed graph, provenance on every edge, bounded expansion, conflict retention, graph context section in the prompt budget |
| LangGraph | explicit graph execution, checkpoints, interrupts | DAG executor with persisted transitions, approval parking, cancellation and additive replanning |
| MCP spec (2025-06-18) | JSON-RPC, Streamable HTTP, tools/resources/prompts, session headers | MCP client with revision negotiation, size caps, timeouts, approval-bound calls |
| OpenHands / SWE-bench practice | isolated verification, patch workflows | full-copy test isolation; staged patches unchanged otherwise |
| Agent evaluation literature (τ-bench, AgentDojo, ABC) | held-out splits, pass^k, injection, overestimation | stable-hash splits, observable outcome scoring, mock-impossible gates, regression veto, injection/secret/shutdown negative tests |
| Local inference (Ollama/llama.cpp) | keep-alive, VRAM limits, quantisation | runtime profiles, VRAM feasibility estimates (labelled), real unload, `/api/ps` resident list |
| sqlite-vec | MIT OR Apache-2.0, in-process ANN | not adopted in 4.0: the existing hashed+lexical retrieval was sufficient for the measured corpus and adding a native dependency would need packaging work on Windows. Recorded as a deliberate deferral, not a capability. |

Licence notes: LM Studio is proprietary and is never bundled. Ollama and
llama.cpp are MIT. sqlite-vec (if adopted later) is MIT OR Apache-2.0. The MCP
specification is MIT.

---

## 6. Tests — executed results

| Suite | Result | Notes |
| --- | --- | --- |
| `node test/run.js` | **23 passed** | protocol, signatures, approvals, CLI, installer helpers |
| `node test/ui.js` | **35/35** | jsdom against a real agent over HTTP, including the four new panels |
| `node test/ai.js` | **25 passed** | assistant stack over the HTTP API with mocked providers |
| `node test/deep.js` | **99 passed** | semantics, executor, patching isolation, graph, MCP, runtime, evaluation, organisation, memory summaries, plus the 3.0 checks |
| `node scripts/check.js` | **all checks passed** | syntax, assets, boot |
| `node scripts/eval.js` | **23/23** | deterministic core, providers disabled by construction |
| `node scripts/audit-tools.js` | **0 structural problems** | 206 tools checked; 14 executed successfully; 192 unexecuted |
| `node scripts/bench.js` | completed | numbers below |

New behavioural tests worth naming:

- executor: dependency order and `$stepId` injection; read-only overlap vs
  serialised writes; cancellation leaves `cancelled`; retry only when safe
  (read retried, write attempted once); approval deny/approve with single
  consumption; replan preserves completed work and marks the failed step
  superseded; unknown agent/tool rejected; budget stop; DAG persistence.
- patching: a passing and a failing isolated test both leave the original file
  byte-identical and leak no marker file.
- graph: identity folding, conflict retention, 3-hop path with provenance,
  bounded traversal, dangling-edge removal, restart persistence, idempotent
  ingestion, prompt inclusion as data.
- MCP: disabled by default, insecure URL refusal, version refusal, HTTP
  handshake/session/auth/timeout, namespaced tools with approval, stdio
  handshake/call/error/shutdown against a fixture server.
- runtime: detection caching, estimate scaling, VRAM refusal, gaming unload,
  unsupported provider.
- evaluation: split determinism, scoring kinds, mock/regression/insufficient
  rejection, real improvement passes.
- summary: decisions/constraints/topics/open question, secrets skipped,
  persistence/versioning, context section.
- organisation: every agent appears once, unique titles, bounded one-way
  delegation.

Bugs found by these tests and fixed rather than documented around:

1. Turns appended within the same millisecond sorted unpredictably, scrambling
   conversation history and summaries.
2. A non-global reference regex looped forever on “a co z procesorem?”.
3. Two-edit spelling repair stripped real inflections (“procesorem” →
   “procesor”); repaired words now keep Polish endings.
4. Bare arithmetic and sqrt/percent phrasing did not route to the mathematics
   agent, and mass deletion without a target noun was not classified high risk.
5. Secret detection missed “hasło do bazy: …”.

---

## 7. Measurements (real run, `docs/bench-4.0.json`)

Environment: Linux container, 2 vCPU (Xeon @ 2.60 GHz), 3.8 GB RAM, **no GPU**,
Node 22.22.3. No model was called — every provider was disabled before the run,
so these are deterministic-core numbers and must not be read as inference
throughput.

| Measurement | Result |
| --- | --- |
| Agent construction (boot) | 32.1 ms |
| `brain.ask` deterministic arithmetic | p50 4.33 ms, p95 34.76 ms (10 runs) |
| Semantic interpretation (fast) | p50 0.24 ms, p95 0.96 ms (60 runs) |
| Memory recall over 150 records | p50 1.16 ms, p95 6.43 ms |
| Knowledge search over 40 documents | p50 0.29 ms, p95 1.23 ms |
| Graph query (200 nodes, 2 hops) | p50 0.60 ms, p95 1.40 ms |
| Executor, 5 read-only tool steps | p50 6.12 ms, p95 9.71 ms |

Explicitly **not** measured here: tokens/s, time-to-first-token, model latency,
VRAM usage on the RTX 4060 Ti, Windows boot time. Those require the target
machine and a running provider; inventing them would violate the brief.

---

## 8. Security posture and limits

Implemented and tested:

- **Default deny and approvals.** A staged patch needs a verified result *and* a
  consumed approval; MCP tools are write-permission unless the server is
  explicitly trusted and the tool declares `readOnlyHint`; approvals are bound to
  tool + args, single-use, with expiry. Model-generated `confirm:true` is never
  authorisation.
- **Sandbox.** Paths resolve inside workspace/data/knowledge; escapes return
  `OUTSIDE_SANDBOX`. Tool args are schema-validated before execution.
- **Verification isolation.** Test verification copies the project (bounded to
  6,000 files / 96 MB, VCS and dependency trees excluded, `node_modules`
  symlinked), applies the candidate in the copy, runs with isolated
  HOME/TMPDIR/SENTINEL_HOME, and deletes the copy in `finally`. Oversized
  projects fail instead of falling back to in-place verification.
- **No privilege escalation.** Agents cannot change their own permissions; the
  organisation preview cannot execute or reassign; approvals live outside model
  control.
- **Secrets.** Memory refuses records that look like secrets (now including
  “hasło do bazy: …”); summaries skip such turns and report how many; tool
  arguments are redacted in the audit log.
- **Conflicts.** Contradictory graph properties are kept, not overwritten, and
  surfaced with a warning prefix.
- **MCP.** Off unless `ai.mcp.enabled` and the server entry are both enabled;
  https required for remote servers; responses capped at 512 KB; timeouts
  enforced; server errors returned as values.
- **External inference.** Disabled by default; nothing is sent without explicit
  configuration. No covert monitoring, no recordings without permission.

Known limits (honest list):

- Windows CI is configured (behaviour tests, evaluation, audit, packaging) but
  was **not executed in this sandbox**; the Linux suites are the executed ones.
- GPU detection and VRAM estimates were exercised against fakes; the 4060 Ti
  path is unverified until run on that machine.
- No live model evaluation was run (no provider here). `scripts/eval.js --live`
  refuses rather than pretending.
- 192 of 206 tools were not executed by the audit; they remain unverified.
- MCP was tested against a fixture server, not against third-party servers.
- SQLite vector search (sqlite-vec) was not adopted in this release.
- Android and ESP32 firmware were not modified or re-flashed in 4.0; their
  protocol tests still pass.

---

## 9. Install (Windows)

```
powershell -ExecutionPolicy Bypass -File .\INSTALL_SENTINEL_FULL.ps1
```

Options: `-InstallDir`, `-Source <checkout>`, `-Model`, `-SkipModels`,
`-SkipSpeech`, `-SkipOcr`, `-NoAutostart`, `-Uninstall`. The installer stages
atomically, keeps a backup, runs `doctor`, then runs the deterministic 4.0
evaluation on the installed copy and reports the result without hiding it.

After install:

```
sentinel status
sentinel runtime                 # active profile, hardware, resident models
sentinel runtime gaming          # unload models, refuse heavy work
sentinel org                     # tiered roster; sentinel org windows previews delegation
sentinel graph Atlas             # multi-hop relationships with provenance
sentinel mcp status              # opt-in; nothing connects until configured
```

Upgrade from 3.0: existing data, approvals, patches, memories and knowledge are
read in place; the store schema is additive. Back up `SENTINEL_HOME` first as
you would for any upgrade.

---

## 10. Remaining gaps against the 4.0 brief

- **Windows assistance and full security audit** are covered by existing tools
  and tests but not by a fresh, exhaustive Windows negative-test matrix on real
  hardware.
- **Repository-aware coding engine** has staged patches and isolated
  verification, but not yet a repository map with symbol-level impact analysis.
- **Voice/vision** are preserved and tested at the endpoint level; no 4.0 model
  benchmarks were run for them.
- **Benchmark suite** is deterministic-core only; a live-model benchmark harness
  exists (`--live` gate) but has no executed results on this machine.
- **Tool count** is 206, below the 300–500 target. The difference is not hidden:
  the brief forbids filler, and every added tool must justify a distinct
  capability. `docs/tool-audit-4.0.json` records exactly what exists.
