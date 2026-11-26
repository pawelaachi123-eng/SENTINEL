# SENTINEL 7.0 — requirements ledger

Status: **partial**. This is the persistent, resumable record. A row is not
"done" because a module exists; it is done only where the stated capability is
implemented **and** exercised by a test or a measured benchmark in this
repository. Binary packaging (EXE/MSI/APK/AAB/BIN/HEX/UF2) is intentionally
**disabled** in CI for 7.0.

Measured at this revision: **342 tools / 29 categories**, **83 executed** by the
tool audit and **259 explicitly unexecuted**, **31 agents**, **153 deep checks**,
**90 deterministic evaluations**, **48 UI checks**, **25 assistant-stack
checks**, **23 behaviour tests**, **60,431 first-party source lines** (up from
53,465 at 6.0). No GPU, live Ollama model, provider account or real phone call
was available. Those are gaps, not assumptions.

| # | Requirement (7.0 brief) | Status | What exists and was executed | Not done |
| --- | --- | --- | --- | --- |
| 1 | Massive, non-filler update; read prior source/reports; preserve compatibility | partial | prior 6.0 modules and artifacts preserved; **+6,966 source lines** in real modules and tests; version 7.0.0; old database/config remains compatible | target +50,000–100,000 lines not reached |
| 2 | No binary packaging; source CI; one PowerShell installer | **done for this slice** | workflow rewritten to Linux/Windows/source-only and simulated-device source checks; `scripts/check.js` fails if `pkg`, `electron-builder`, Gradle APK, `pio run` or release upload reappears; exactly one `.ps1` installer; installer relabelled 7.0 with read-only checks | installer flow not executed here (no PowerShell); Android/ESP32 code only syntax/presence checked |
| 3 | Cognitive hypercore: typed state, goals, beliefs, evidence, hypotheses, conflicts, attention, budgets, provenance | partial | `core/cognition/hypercore.js`: typed goals/beliefs/evidence/hypotheses/constraints/rules/conflicts, deterministic softmax attention, token/tool/depth budgets, persistence, bounded deduction and abduction, Bayesian hypothesis update; 4 tests + 10 tools + CLI/API | no unified automatic wiring of every legacy module through one blackboard; no full causal/temporal solver; no learned attention |
| 4 | Real neural library and specialist networks | partial | `core/ml/autograd.js` (matrix reverse-mode AD, LayerNorm, attention primitives, AdamW-style decay, numeric gradient check); `core/ml/transformer.js` (trainable single-block encoder); trained intent MLP, compact transformer and reranker; four further gated specialists (tool selection, agent routing, memory relevance, task complexity) with held-out baselines in `docs/specialists-7.0.json`; the routing model supplies a dispatcher hint without overriding strong keyword matches | no tensor GPU backend; 4 of 10 named specialists not built; no mixture-of-experts; no LoRA/QLoRA/distillation |
| 5 | Neural learning lab: datasets, splits, dedupe, contamination, checkpoints, gates, rollback, cancellation | partial | intent lab + transformer lab + reranker lab + specialist zoo: authored synthetic datasets, group/topic splits, disclosed training-only augmentation, lexicons/lexical baselines, early stopping, SHA-256 checkpoints outside source, approval-gated promotion, held-out gates; `docs/neural-7.0.json` and `docs/specialists-7.0.json` | no experiment cancellation UI; no external ML framework/LoRA; limited dataset sizes |
| 6 | Performance: providers, routing, streaming, caches, admission, measurement | partial | 6.0 neural/runtime modules preserved; measured boot/memory/retrieval/graph/executor via `scripts/bench.js` → `docs/bench-7.0.json`; no unnecessary model calls added by new features | no measured VRAM/first-token/tokens-per-second/GPU offload; semantic cache not new; speculative decoding not implemented |
| 7 | Super memory: hybrid lexical/vector/graph, consolidation, correction, privacy | partial | 6.0 typed memory/migrations/embeddings/FTS/graph preserved; briefing consumes due reminders; hypercore conflict retention | no unified hybrid retrieval rewrite, new consolidation/export UI or 12-kind editor; the memory-relevance model exists but is not yet used by the retrieval ranking |
| 8 | GraphRAG, documents, citations, research sessions | partial | 6.0 research sessions with fingerprints, line citations, conflicts, untrusted sources preserved; reranker can order passages with measured NDCG | no new multi-hop GraphRAG pipeline, PDF/DOCX extractor, entity resolution, freshness service or online provider |
| 9 | Autonomous executive: DAG, conditions, deadlines, recovery, idempotency | partial | 4.0 durable executor and 7.0 critical-path planner preserved/tested; hypercore goals carry deadlines/budgets | no conditional-branch DAG changes, deadline scheduler, worker pool or new restart/race fault injection this slice |
| 10 | 120+ genuinely specialised agents | **missing** | existing **31** agents and organisation preserved; no personas added | 89 additional distinct specialists and measured routing quality |
| 11 | Personal assistant: briefings, reminders, projects, documents | partial | `core/briefing.js` deterministic cited briefing; CLI `brief`; tools; typed memory due list; planning/finance/notes/meeting tools | no calendar/email account integration; no daily background delivery |
| 12 | Real phone calls / SMS / notifications | partial | `core/communication.js`: provider-independent manager, consent tokens bound to channel+E.164 destination+expiry, use-once, daily/cost limits, quiet hours, AI disclosure, emergency/premium blocking, mock lifecycle, Twilio REST adapter, signed webhook + replay protection; tests | **no live call was made**; no account/SIP/TTS verification; no email adapter; no scheduled-call worker; Twilio path untested against the provider |
| 13 | Proactive intelligence | partial | `core/proactive.js`: opt-in typed rules, cooldowns, dedupe, quiet hours, per-hour/day limits, explicit suppressions, no monitoring; tests/tools/status | no OS notification bridge or scheduled evaluation loop; no escalation to SMS/call; no UI editor |
| 14 | 1000+ genuine tools, semantic discovery, quotas, MCP | partial | **342 tools / 29 categories**, 0 structural problems, 83 executed; new science/productivity/hypercore/communication/assistant packs; existing MCP preserved | 658 tools short; 259 unexecuted; semantic tool discovery/quotas not new |
| 15 | Coding superintelligence: parser-backed multi-file patches | partial | existing repo map/symbols/impact/patch verification preserved; no regression observed | no parser-backed JS/TS/Python trees, multi-file transactional patch apply, hostile fixture suite or test generation |
| 16 | Windows and gaming | partial | existing diagnostics/gaming modes preserved; Windows source CI remains | no new hardware/game benchmark correlation; no measured FPS claims |
| 17 | Multimodal, Android/ESP32 source integration | partial | voice/vision/Android/ESP32 sources preserved; simulated-device source job added | no new STT/TTS/OCR fixtures, wake word, streaming audio or device simulation tests; no APK/firmware built by design |
| 18 | Security: default deny, approvals, adversarial tests at every entry point | partial | deterministic approvals preserved; new endpoints require UI token; system tools need consumed approval; communication requires separate human consent; emergency/premium blocked; signature/replay tests; tool audit validates permissions | not every one of 342 tools has an adversarial negative test; HTTP rate-limit/CORS review incomplete |
| 19 | Self-healing and failure recovery | partial | existing watchdogs/circuit breakers/recovery journal preserved; tool audit now fails on execution errors (found and fixed a real `working_days` bug) | no new fault-injection suite for outages, disk exhaustion, corrupt config or migration rollback |
| 20 | UI: real states, STOP, streaming, panels | partial | 6.0 orb/STOP/streaming preserved; Models tab now shows lab, transformer, neural, research, hypercore, reranker, communication, briefing, proactive and specialist state; 48 UI checks incl. unauthenticated endpoint refusals | no new orb state wiring, training-curve chart, workflow canvas or communications UI actions |
| 21 | 2000+ meaningful tests, property/fault injection, benchmarks vs 6.0 | partial | **339 checks** total (23+25+48+153+90); AD gradient checks, model reproducibility, security negatives, mocked provider; measured model/latency JSON | 1,661 short; no property-based framework, fault injection, load testing or live-model comparison |
| 22 | Delivery: installer, CLI, coherent end-to-end features, report | partial | version 7.0.0; CLI `hypercore`, `reranker`, `sentiment`, `specialists`, `comm`, `brief`, `proactive`; read-only installer checks; persistent ledger + `docs/REPORT-7.0.md`; PR remains open | installer not run; no packaging; many features are library/CLI rather than full UI end-to-end |

## Hard invariants retained

- No fabricated metric, trained model, call, delivery, GPU number or agent count.
- Training requires a named human; weights never enter the source tree.
- A model or provider failure returns a code (`NO_MODEL`, `NOT_CONFIGURED`,
  `APPROVAL_REQUIRED`, `CONSENT_REQUIRED`, …); it is never reported as success.
- Contradictions stay visible; resolution needs an approver and preserves the
  superseded belief.
- Retrieved or tool-provided content is untrusted and cannot grant permissions.
- No emergency-service or premium-rate calls; AI identity is disclosed.
- No packaging/publishing jobs; no EXE/APK/firmware.

## Next milestones, in order

1. Run Windows/Linux source CI for the committed revision and fix regressions.
2. Build a measured hybrid retrieval pipeline that uses the reranker; evaluate
   NDCG and latency on held-out topics against lexical and embedding baselines.
3. Add the four remaining named specialists (semantic similarity, context
   importance, failure prediction, confidence calibration) with baselines, and
   wire the existing routing/relevance models into live dispatch and retrieval
   with measured end-to-end quality.
4. Expand agents only with distinct contracts, tools and tests; report measured
   routing success instead of head-count.
5. Execute more of the 259 unexecuted tools with safe fixtures; grow the tool
   count only alongside real fixtures.
6. Add fault injection (provider outage, disk full, corrupt config, interrupted
   migration) and property tests; then expand the evaluation corpus.
7. Wire briefing/proactive delivery to the UI with explicit opt-in and a visible
   history; add OS notification integration.
8. Verify a live communication provider only with a user-owned test account and
   documented consent; keep CI on mock.
