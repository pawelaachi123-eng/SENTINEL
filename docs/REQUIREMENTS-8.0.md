# SENTINEL 8.0 — requirements, fixes and measured state

This is the acceptance record for the 8.0 work performed on this checkout. It
records what was built, what was measured, and what was **not** built. The 8.0
brief is much larger than one reviewable slice; treating it as complete would be
a false claim, so the gaps are listed explicitly.

Measured 2026-11-22 (UTC), Linux x64, Node 22.22.3, CPU only.

## Targets from the brief

| Measure | 7.2 | 8.0 current | Target | State |
|---|---:|---:|---:|---|
| First-party lines (tracked text, no lock/binaries) | 76,429 | **78,446** | >1,000,000 | **not met** (7.8%) |
| Tools | 689 | 689 | 2,000 | not met |
| Tool categories | 35 | 35 | 80+ | not met |
| Tools executed in the audit | 388 | **530 / 530 attempted** | all feasible | partial: **159 unexecuted** |
| Agents | 123 | 123 | 250+ | not met |
| Checks in the suite | 1,821 | **1,830** | 10,000+ | not met |
| Repository self-index | 215 files, 3,007 symbols, 0 errors | **217 files, 3,044 symbols, 0 errors** | 0 errors | met |

Reproduce with `node scripts/acceptance-8.0.js` (writes
`docs/ledger-8.0.json`) and `node scripts/audit-tools.js` (writes
`docs/tool-audit-8.0.json`). The acceptance gate fails on a suite failure,
version drift, registry failure, self-scan parse error or audit failure.

## Fixes completed in this slice

### Training lab correctness

- **Leakage removed.** `DatasetRegistry.split()` is now group-aware: rows with
  the same normalised text are assigned to exactly one fold, so duplicates
  cannot train on one side and grade on the other. `TrainingLab.examples()`
  returns three disjoint folds — `train`, `validation`, `test` — and verifies
  zero group overlap.
- **Untouched final test.** LoRA and QLoRA select the best adapter epoch on
  validation only, with early stopping; the test fold is read once, after
  selection. Hyper-parameter search now optimises on validation and reports
  `selectionSplit: "validation"` plus the untouched test size.
- **Label validation.** Source and target datasets must share the same label
  mapping; a mismatch throws `LABEL_MISMATCH` instead of silently training on
  shifted indices.
- **Real cancellation.** Queue-facing LoRA training is cooperative-async: it
  yields once per epoch, so an AbortSignal is observed *during* computation.
  Measured: a 5,000-epoch job cancelled in 15–25 ms. The queue no longer marks
  a job cancelled while the CPU keeps training.
- **True GPT continuation.** Checkpoints now store weights, vocabulary, Adam
  moments, optimizer step, learning rate and epoch counter. `runGptJob` resumes
  from the saved epoch instead of retraining the whole run; the runner yields
  between epochs and cancels mid-run. Re-running a completed checkpoint does
  not retrain it.
- **Path confinement.** `generateGpt` only reads checkpoints inside the lab
  data directory; `/etc/passwd` and `../escape.json` raise `OUTSIDE_DATA_DIR`.
- **One lab facade.** `core/lab.js` is now a compatibility shim over
  `core/lab/index.js`, which exports both `TrainingLab` and `LearningLab`; the
  legacy implementation moved to `core/lab/classic.js`. The agent imports both
  from one place.

### Sampling and model quality

- GPT sampling now supports top-p (nucleus) and a repetition penalty in
  addition to temperature and top-k, with deterministic seeds.
- Checkpoint resume is exercised by tests that assert the optimizer step and
  epoch counter continue rather than reset.

### Tool audit

`scripts/audit-tools.js` now creates a safe fixture workspace (JS, JSON, CSV,
Markdown, log, text, nested directory) and executes 530 real read-only tool
calls, up from 388. The remaining **159** tools are writes, destructive
operations, external communications, network dependencies, training jobs that
would take minutes, or platform-specific actions that cannot be safely
exercised in CI. They remain labelled unexecuted, not "verified".

New training checks (23 total) cover group-aware splits, label mismatch,
mid-computation cancellation, GPT optimizer/epoch resume, checkpoint no-op
resume, queue cancellation of a real LoRA job, path traversal and the legacy
shim.

## Not implemented in this slice

The following 8.0 requirements are **not** done. No claim is made otherwise:

- 1,000,000 source lines, 2,000 tools, 80 categories, 250 agents, 10,000 checks.
- A unified HyperCore cognitive state spanning perception, attention, working
  memory, goals, hypotheses and verification; neuro-symbolic deduction,
  induction, abduction, causal/temporal/spatial/probabilistic reasoning.
- Multidimensional tensor library expansion, attention variants (GQA, RoPE,
  RMSNorm, SwiGLU, MoE), KV caching, BPE tokenizer and transformer scaling.
- Production PyTorch/PEFT/Transformers training, quantization backends,
  external environment discovery, adapter inference in the assistant.
- Capability-based multi-model router and bounded model collaboration.
- Performance engine profiles, GPU queues, speculative decoding, cache layers
  and hardware benchmarks.
- Memory 3.0 hierarchy and production vector indexes; research engine document
  formats/OCR; Autonomous Executive 2.0 hierarchical goals.
- 250 functional agents; semantic tool discovery and typed composition.
- Real bidirectional telephone conversations, provider webhooks, cost ceilings.
- Windows UI Automation/desktop assistance; multimodal voice/vision pipelines.
- Installer migration/rollback testing on Windows.

These are recorded as blockers for the next resumable milestones, not as
partial successes.

## Verification boundary

Verified: all ten suites through real code paths (including jsdom UI and an
in-process HTTP server), the repository self-index with zero parse errors, 530
tool executions in a temporary fixture workspace, and the training-lab checks
listed above. Linux only in this run.

Not verified: GPU or frontier-model training, live providers, real telephone
calls, Windows UI Automation, Windows installer behaviour, or any measurement
above the shipped CPU-scale models. The lab models remain small CPU analogues.
