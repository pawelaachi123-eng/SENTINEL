# SENTINEL 6.0 — requirements matrix

Status legend: **done** = implemented and executed here, **partial** = a tested
slice exists with named gaps, **missing** = not implemented. A count is never
presented as completion of a quota. This matrix is the persistent record of
unfinished requirements; it survives the session because it lives in the repo.

Measured baseline at the start of 6.0: 31 agents, 219 tools, **14** tools
executed by the audit, mock-only model evaluation, 117 deep checks. End of this
slice: 31 agents, **270 tools / 24 categories**, **59 executed** and 211
unexecuted by the audit, **131 deep checks**, **76 deterministic evaluation
cases**. No live model or GPU was available, and Windows CI for 6.0 has not been
run yet.

| # | Requirement | Status | Evidence | Outstanding |
| --- | --- | --- | --- | --- |
| 1 | Mission, baseline, requirements matrix, resumable milestones | done | this file; `docs/REPORT-6.0.md`; baseline reproduced | keep matrix current each session |
| 2 | Independent research and architecture audit | partial | 5.0/6.0 research notes in `docs/research.md`; source audit of memory/executor/tools | deeper dead-code/race audit; cited algorithm comparison for training |
| 3 | Genuine neural computing (real forward/backward, weights) | partial | `core/ml/mlp.js` with numeric gradient check, real softmax/backprop/Adam; checkpoint checksum; `core/ml/features.js` | no transformer/attention implementation; specialists use existing providers |
| 4 | Neural learning laboratory | partial | `core/lab.js`: 346-case synthetic PL/EN dataset, dedupe, split curation, contamination check, keyword baseline, early stopping, checkpoints under `SENTINEL_HOME/models`, measured test accuracy/macro-F1/confusion, approval-gated promotion and rollback | no LoRA/QLoRA/distillation/preference optimisation; no reranker; no GPU path; no artifact registry UI beyond status |
| 5 | Brain-inspired cognitive operating system | partial | 4.0 cognition + working/episodic memory, executor, events; 6.0 typed memory kinds and prospective due list | selective module activation/global workspace not newly implemented; no fabricated thoughts (by design) |
| 6 | Language understanding and reasoning | partial | 4.0 semantics, 5.0 evidence-bound reasoner, bounded reflection, PL/EN | no new solver/constraint engine; calibration remains heuristic |
| 7 | Neural runtime and hardware optimisation | partial | 5.0 `core/neural.js`: provider metadata, routing, queues/cancellation, unload; profiles from 4.0 | no measured VRAM/first-token/tokens-per-second on the RTX 4060 Ti; no tokenizer integration |
| 8 | Advanced memory and context | partial | typed kinds (`conversation`, `preference`, `temporal`, `prospective`), due reminders, supersession history, preview/apply migration with backup, mandatory context + output reserve, measured recall tests from 4.0 | no consolidation/forgetting redesign; no 12-kind UI editor |
| 9 | Knowledge graph, RAG and research | partial | `core/research.js`: durable plans, source fingerprints, duplicate refusal, line-level citations, numeric conflict retention, untrusted sources, refusal without sources; graph/RAG from 4.0 | no new PDF/DOCX extractors; no online adapter; no query decomposition beyond clause splitting |
| 10 | Executive workflow engine | partial | 4.0 durable DAG executor with checkpoints, approvals, retries, replans, cancellation; 6.0 did not regress it | conditional branches, deadlines, full state enum, STOP into subprocesses, new restart/race tests |
| 11 | Multi-agent organisation | missing | 4.0 has 31 agents, dispatcher, supervisor, planner | expansion to 80–120 genuinely distinct roles with typed contracts and measured selection |
| 12 | Experience, skills and adaptation | partial | 5.0 skill library with held-out gate, approval, regression veto, retirement; 4.0 experience | no new prompt/code improvement pipeline; no automated deployment |
| 13 | Tool ecosystem and MCP | partial | 270 tools/24 categories, 0 structural problems, 59 executed; 5.0 MCP negotiated version additions | 500+ genuinely tested capabilities and 1000+ registry scale; provider UI; more MCP mock tests |
| 14 | Coding and engineering intelligence | partial | 5.0 repo map/symbols/imports/impact/tests; SHA-256 patch verification binding | parser-backed symbols, multi-file patches, hostile fixture suite, transactional multi-file apply |
| 15 | Windows, reliability and self-healing | partial | 4.0 reliability/self-heal; green Windows behaviour+eval+audit CI at `d995bf7`; 5.0 Windows fixes | new fault-injection cases (outages, full disk, interrupted writes); incident correlation |
| 16 | Security and privacy invariants | partial | deterministic approvals, use-once, sandbox, secret refusal in memory, immutable patch verification, negative tests from 4.0/5.0 | negative tests for every new endpoint (lab/research/UI); UI/API authorization review |
| 17 | Multimodal, Android and ESP32 | partial | existing local voice/vision/Android/ESP32 preserved; UI/API untouched | new STT/TTS/OCR fixtures, measured Polish quality, device integration tests |
| 18 | UI and observability | partial | 5.0 panels preserved; 6.0 lab/neural/research panel with real API data, honest labels | orb states, workflow DAG, training metrics streaming, full panel coverage |
| 19 | Verification and cognitive benchmark lab | partial | 131 deep checks, 76 eval cases, 35 UI, 25 AI, 23 core; deterministic/mock separated; ML gradient and reproducibility tests | 1000+ meaningful cases, property/fault-injection/migration/security suites, live Ollama comparison |
| 20 | Installer, continuity and delivery | partial | installer still preserves data, stages/backs up/health-checks/rolls back; 6.0 adds read-only lab/neural checks and CLI commands; artifacts built by CI | 6.0-specific installer recovery tests and artifact verification; installer not executed in this sandbox |

## Hard constraints that remain in force

- No fabricated tests, metrics, neuron counts, context lengths or training
  results. Missing provider fields are `null`; token counts are estimates.
- Training requires an approving identity and writes weights outside the source
  tree. No conversation is a training set.
- Model output is never consent; approvals are single-use and revalidated.
- Retrieved text and tool output are untrusted and cannot grant privileges.
- Verification is bound to immutable candidate/baseline hashes.
- Contradictory facts are kept, not overwritten.
- No automatic merge to `main`; PR #1 stays open.
- Windows CI must be re-run for this revision before claiming it green.

## Next milestones (ordered)

1. Re-run Linux/Windows CI and fix regressions (required before any claim).
2. Add an actual reranker trained on synthetic query/document pairs and compare
   NDCG against lexical ranking on a held-out split.
3. Expand the deterministic evaluation corpus toward 1000 meaningful cases and
   add property/fault-injection suites for memory migration and research.
4. Executive DAG: conditional branches, deadlines, explicit state enum and
   restart/race tests; STOP propagation into subprocesses.
5. Tool coverage: execute at least half of the 270 tools with safe fixtures;
   grow toward 500 only with real fixtures.
6. Security negatives for `/api/lab`, `/api/research`, `/api/neural` and every
   new CLI command; verify UI cannot bypass approvals.
7. Coding intelligence: parser-backed multi-file patches with hostile fixtures.
8. Hardware measurements on the target RTX 4060 Ti, or reproducible instructions
   with no invented numbers.
