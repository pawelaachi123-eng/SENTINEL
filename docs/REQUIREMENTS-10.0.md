# SENTINEL 10.0.0 — Requirements Ledger

Machine-readable source: `docs/requirements-10.0.json`.
Measured state: **103,087 lines**, **715 tools / 36 categories**, **123 agents**, **2,136 executed checks**.
Latest run: `docs/ledger-10.0.json`.

## Status vocabulary

`NOT_STARTED` · `IMPLEMENTED_UNTESTED` · `PARTIAL` · `VERIFIED` · `BLOCKED`.

Only **VERIFIED** counts as complete. **BLOCKED is not a pass.** Structural registration alone never counts as capability.

## Summary

| Status | Count |
|---|---:|
| VERIFIED | 15 |
| PARTIAL | 21 |
| NOT_STARTED | 3 |
| BLOCKED | 2 |
| IMPLEMENTED_UNTESTED | 0 |
| **Total** | **41** |

## Requirements

| ID | Milestone | Status | Requirement | Evidence / blocker |
|---|---|---|---|---|
| `M1-BASELINE` | M1 | VERIFIED | Re-run the full 8.0 baseline before changing code | 23/23 training checks; audit-tools --no-write reported 530/530 executed before 8.1 edits |
| `M1-DEFECT-SCHEMA` | M1 | VERIFIED | Fix JSON-Schema type unions in the tool validator | string or number accepted, boolean refused; calendar.add accepts an ISO string through the registry |
| `M1-DEFECT-SERVICES` | M1 | VERIFIED | Expose patches, cognitive, context, semantics, executor, skills and reasoning to tools | patch.propose now returns a patch id and a readable diff; 51 services exposed; every declared tool dependency satisfied |
| `M2-AUDIT-EXECUTION` | M2 | PARTIAL | Execute reversible tool fixtures instead of only validating shape | 632 of 639 fixture calls verified; 74 tool names still unexecuted; coded data.ok:false payloads are failures, not verification — blocker: provider, device, training, process-control, MCP and installer tools need external hardware or credentials; some tools are intentionally destructive or require approvals |
| `M2-CONFORMANCE` | M2 | VERIFIED | Cross-check numeric, unit, date, geometry, physics, finance, statistics and text tools on independent inputs | 210 of 210 conformance checks pass |
| `M2-CHECKS-2000` | M2 | VERIFIED | Pass 2,000 distinct functional checks | 2,116 checks across 16 suites |
| `M2-REQUIREMENTS-GRAPH` | M2 | VERIFIED | Machine-readable requirements graph with honest status vocabulary | graph integrity validated; VERIFIED rows require existing implementation and test paths; 8 of 36 tracked requirements verified; large targets remain open |
| `M2-TOOLS-1000` | M7 | PARTIAL | Reach 1,000 genuine tools | 706 tools in 36 categories — blocker: 311 further tools need real distinct behaviour, not aliases |
| `M2-TOOLS-2000` | M7 | NOT_STARTED | Reach 2,000 genuine tools across 100+ categories | 706 measured — blocker: depends on tools-1000 |
| `M3-BLACKBOARD` | M3 | VERIFIED | Typed cognitive blackboard with provenance, scopes, attention, persistence and chat integration | 18 blackboard semantics checks; a chat run writes question/goal/evidence/answer/verification entries scoped to its session |
| `M3-NEUROSYMBOLIC` | M3 | VERIFIED | Deductive, abductive, inductive, counterfactual, causal, temporal, spatial, probabilistic, CSP, optimisation, planning and decision engines | 21 base engine checks; 21 advanced engine checks |
| `M4-NEURAL` | M4 | PARTIAL | Neural library with tensors, autograd, optimisers and finite-difference gradient checks | CPU-scale GPT, checkpoints, sampling controls and gradient checks exist; no production PyTorch/PEFT/quantization workflow — blocker: no GPU measurement in this environment |
| `M4-SPECIALISTS` | M4 | NOT_STARTED | Specialist models with dataset, split, baseline, metric and deployment gate |  — blocker: needs approved datasets and GPU training |
| `M5-ROUTER` | M5 | PARTIAL | Provider-independent router with verified capabilities, health, failover and offline mode | provider registry and routing data exist; live-provider failover is mock-verified only — blocker: real provider smoke tests need separate approval |
| `M5-PERF` | M5 | PARTIAL | Admission control, caching, token budgets and measured p50/p95/p99 latency | cache and perf tools exist; no measured latency table on this hardware — blocker: no live model benchmark in CI |
| `M5-PROFILES` | M5 | PARTIAL | Fast, Balanced, Deep, Research, Offline and Gaming profiles with behavioural differences | Fast/Balanced/Deep/Research budgets differ; Offline and Gaming profiles are not complete |
| `M6-GRAPHRAG` | M6 | PARTIAL | Hybrid lexical, vector, graph and rerank retrieval with citations | graph ingest/query/traversal works on fixtures; production embedding index and learned reranker are not complete — blocker: embedding model quality not benchmarked |
| `M6-RESEARCH` | M6 | PARTIAL | Research superengine with decomposition, source discovery, evidence and grounded reports | local document research works; live web source discovery is not enabled in CI — blocker: network policy; citation correctness benchmark missing |
| `M7-EXECUTIVE` | M7 | PARTIAL | Durable executive with pause/resume/restart recovery, idempotency and global STOP | resumable queue, journal and STOP path tested; full restart reconciliation not benchmarked |
| `M7-AGENTS-250` | M7 | PARTIAL | Reach 250 real specialist agents with typed contracts | 123 agents — blocker: 127 further specialists must have non-overlapping contracts |
| `M7-MCP` | M7 | PARTIAL | MCP client/server plus versioned plugin SDK with fixture providers | fixture-level transport exists; no external MCP server conformance run — blocker: external MCP fixtures not installed |
| `M8-PRODUCTIVITY` | M8 | PARTIAL | Timezone-safe recurring calendar, tasks, projects and PL/EN briefings | calendar and task flows execute; recurring timezone matrix is incomplete |
| `M8-PROACTIVE` | M8 | PARTIAL | Opt-in proactive event engine with a rule editor | rules can be created and evaluated; no rule editor UI |
| `M9-TELEPHONY` | M9 | BLOCKED | Real bidirectional telephone conversations with VAD, barge-in and signed webhooks | simulator scaffolding only — blocker: verified destination numbers; telephony provider credentials; explicit approval for live calls |
| `M10-CODING` | M10 | PARTIAL | Incremental code index, call graphs, multi-file patches and hash-bound approvals | index, patches and rollback tested; multi-file transaction UI incomplete |
| `M10-WINDOWS-UIA` | M10 | BLOCKED | Windows UI Automation desktop assistance |  — blocker: no Windows desktop in this environment |
| `M10-MOBILE` | M10 | PARTIAL | Android/ESP32 pairing and local mobile web UI | sources preserved; only simulated devices — blocker: no physical Android or ESP32 hardware |
| `M11-UI` | M11 | PARTIAL | JARVIS UI with orb bound to real states and all workspaces | local HTTP UI and state endpoints exist; not all eleven workspaces are complete |
| `M11-SECURITY` | M11 | PARTIAL | Default-deny capabilities, single-use bound approvals and no self-permission changes | approval binding and sandbox denial are tested; whole-entry-point audit is ongoing |
| `M11-RELIABILITY` | M11 | PARTIAL | Self-healing limited to reversible internal operations | diagnosis and backup restore tested; no fault-injection campaign |
| `M12-ACCEPTANCE` | M12 | PARTIAL | One acceptance gate with fault injection, observability and an installer | acceptance gate exists; installer has not been run on Windows — blocker: no Windows host |
| `M12-SOURCE-ONLY` | M12 | VERIFIED | Source-only repository with exactly one PowerShell installer and no binary artifacts | CI packs no binaries; one installer present |
| `M12-LINES` | M12 | NOT_STARTED | One million meaningful first-party source lines | 78,446 measured in 8.0.0 — blocker: cannot be reached honestly by filler; requires real subsystem growth |
| `M12-TESTS-10000` | M12 | PARTIAL | Ten thousand meaningful checks | 2,116 measured — blocker: 7,944 further behavioural assertions required |
| `M3-METACOGNITION` | M3 | VERIFIED | Active metacognitive controller that executes bounded gather/retry/qualify/clarify/stop transitions | 16 assessor checks; 13 active-controller checks |
| `M3-EVENT-SYNC` | M3 | VERIFIED | Event-driven cognitive state synchronization across modules | blackboard mutations become typed, scoped events with provenance; run started/retrieved/answered/verified/corrected/cancelled events are published by real chat runs |
| `M3-ACTIVE-CONTROL` | M3 | VERIFIED | Bounded execution of metacognitive corrective actions against the live assistant | 13 active checks; gather/retry/qualify/clarify/stop execute through real handlers |
| `M3-GOAL-ARBITER` | M3 | VERIFIED | Competing-goal arbitration with deadlines, starvation and dependency-aware activation | goal scoring, ready ranking and blocked listing; dependency chains activate in order and cycles are reported |
| `M4-AUTOGRAD-OPS` | M4 | VERIFIED | Extended differentiable operations: slicing, concatenation, elementwise gating, SiLU, RMSNorm and RoPE | finite-difference gradient checks for slice, concat, mul, SiLU, RMSNorm and RoPE; batched gradient accumulation via backward({accumulate}) |
| `M4-BPE` | M4 | VERIFIED | Trainable byte-level BPE tokenizer with Unicode round-trip and checkpoints | ASCII, Polish and emoji round-trip exactly; frequent text compresses below byte count |
| `M4-TITAN-GPT` | M4 | PARTIAL | TITAN GPT 2.0: BPE, RoPE, RMSNorm, SwiGLU, grouped-query attention and versioned checkpoints | 10,992-parameter CPU model trained: loss 5.610 -> 4.107 over 3 epochs on a synthetic corpus; GQA forward, causal attention, finite logits and exact parameter count — blocker: KV caching for incremental decoding is not implemented; mixture-of-experts experiment is not implemented; the corpus is tiny and synthetic; no language-quality claim is made |

## What 10.0 newly verified

- `M3-METACOGNITION` — now executes bounded corrective actions instead of only advising.
- `M3-ACTIVE-CONTROL` — real gather/retry/qualify/clarify/stop paths wired into chat.
- `M3-NEUROSYMBOLIC` — induction, counterfactual SCM, exact Bayes nets, constrained optimisation, HTN planning, graph search and truth-table proof added.
- `M3-EVENT-SYNC` — typed bounded events from blackboard and real run lifecycle.
- `M3-GOAL-ARBITER` — deadline/starvation scoring and dependency-aware activation.
- `M4-AUTOGRAD-OPS` — slice/concat/mul/SiLU/RMSNorm/RoPE with finite-difference checks.
- `M4-BPE` — trainable byte-level tokenizer with Unicode round-trip and checkpoints.

## What remains partial or blocked

- **TITAN GPT 2.0** is trained and checkpointed, but KV caching, mixture-of-experts, large-corpus training and quality evaluation are missing.
- **Neural specialists** still use the pre-10.0 models; the new specialist roster was not trained in this slice.
- **Production training** still lacks a verified PyTorch/PEFT environment in this sandbox.
- **Tools** are 715/1,000; 74 names remain unexecuted and 7 fixture calls fail.
- **Agents** remain 123/300; no distinct-agent expansion was done in this slice.
- **Telephony** and **Windows UIA** remain blocked by credentials/host availability.
- **1M lines**, **2,000 tools**, **100 categories** and **10,000 checks** are not met.

## Target gaps

| Target | Current | Gap |
|---|---:|---:|
| 1,000,000 lines | 103,087 | 896,913 |
| 2,000 tools | 715 | 1285 |
| 100 categories | 36 | 64 |
| 300 agents | 123 | 177 |
| 10,000 checks | 2,136 | 7,864 |

## Reproduction

```bash
npm test
node scripts/acceptance-10.0.js
node scripts/audit-tools.js
node scripts/requirements-graph.js
node scripts/check.js
```
