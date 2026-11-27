# SENTINEL 10.0.0 — TITAN Neural Intelligence

**Measured:** 103,087 first-party lines across 326 tracked files · 715 tools in 36 categories · 123 agents · 2,136 executed checks · 15/41 tracked requirements VERIFIED.

This release is not a plan or a version bump. It adds active cognitive control, eight new deterministic reasoning solvers, a typed cognitive event stream with goal arbitration, five new differentiable operations, a trainable byte-level BPE tokenizer and a new decoder-only Transformer that was actually trained and checkpointed on CPU.

The honest limits are stated in the same places as the results:

- The natural-language assistant still uses the configured external model for demanding generation. No frontier-model quality is claimed.
- TITAN GPT 2.0 is small, trained on a synthetic corpus and has **no KV cache and no mixture-of-experts experiment** yet. It is `PARTIAL`, not complete.
- 74 tool names remain unexecuted by the audit, and 7 fixture calls still fail. They are not counted as verified.
- Hardware, live telephony and Windows UIA remain blocked in this environment.
- No binaries, firmware, packaging artifacts or model weights are committed.

---

## 1. What was actually built

### 1.1 Active metacognitive control — `core/cognition/active.js`

The 9.0 controller could only recommend `gather`, `retry`, `qualify`, `clarify` or `stop`. This release executes those transitions against the live assistant:

| Transition | Real behaviour |
|---|---|
| `gather` | Searches memory and knowledge again, adds only previously unseen evidence, then re-answers through the normal agent path. |
| `retry` | Re-runs the reasoning agent with the verifier's issues and the gathered context. |
| `qualify` | Appends one visible `Ograniczenie:` line mapping issue codes to plain-language limitations. |
| `clarify` | Replaces a guess with a specific request for the missing subject. |
| `stop` | Stops spending resources and reports the gap. |

Budgets are hard: fast = 0 corrections, balanced = 1, deep = 2, research = 3. Every transition is recorded with outcome, timestamp and confidence delta. A gather that finds no new evidence qualifies the answer instead of re-generating it; a provider failure is recorded as `evaluate-failed`, never as success. Cancellation is checked before every corrective call, and the mode's remaining hard time limit is enforced.

Integration in `core/brain.js` uses the same memory, knowledge, dispatcher, verifier, metrics and blackboard as a normal chat run. The answer exposes `metacognition.control` and top-level `metacognitiveControl`, and `run.corrected` is emitted only when a correction actually ran.

### 1.2 Advanced reasoning — `core/reasoning/advanced.js`

All previous engines are preserved. Eight new solvers are exported through `core/reasoning/engines.js`:

| Solver | What it proves or estimates |
|---|---|
| `induce` | Deterministic separate-and-conquer rules (up to two conditions), with support, confidence, coverage and uncovered positives. Always `estimated`. |
| `counterfactual` | Linear acyclic structural causal model with do() intervention, factual/counterfactual comparison and outcome decomposition. Labelled `model-implied`, never demonstrated causation. |
| `bayesNetwork` | Exact enumeration for a finite discrete Bayesian network, with CPT normalisation checks and evidence updates. `proven` relative to the supplied model. |
| `optimizeCsp` | Branch-and-bound maximisation over finite domains. Optimal only when the search space was exhausted. |
| `hierarchicalPlan` | HTN method expansion with action preconditions/effects and simulated goal verification. |
| `graphSearch` | Bounded BFS, Dijkstra and A*. Optimality is softened for an unverified non-zero A* heuristic. |
| `verifyPropositional` | Exhaustive truth table: tautology, contradiction or contingent, with counterexample. |
| `evaluateScm` | The underlying structural-equation evaluator, exported for tests and tools. |

Validation rejects cyclic SCMs, unknown interventions, non-normalised CPTs, negative edges, malformed formulas, over-budget enumeration and infeasible objectives. Eight new tools expose the solvers (`omega.induce`, `omega.counterfactual`, `omega.bayesnet`, `omega.optimize`, `omega.plan`, `omega.graph`, `omega.prove`).

### 1.3 Typed cognitive events and goal arbitration — `core/cognition/events.js`

- Blackboard mutations become typed events (`blackboard.added/updated/resolved/retracted/removed`) carrying scope, entry id/type, actor, provenance, confidence and status.
- Chat runs publish `run.started`, `run.retrieved`, `run.answered`, `run.verified`, `run.corrected` and `run.cancelled`.
- Retention is bounded per scope and globally; dropped events are counted, never hidden.
- `GoalArbiter` scores ready goals by priority, deadline pressure and capped starvation, lists blocked dependencies separately, activates dependency chains in order, reports cycles and can snapshot/restore.
- Chat runs submit a scoped goal and complete or fail it when the run finishes.
- `cognitive.events` and `cognitive.goals` tools are reachable through the real registry; the HTTP cognitive state includes event statistics and recent events.

### 1.4 TITAN neural operations — `core/ml/autograd.js`

Seven differentiable operations were added with analytic backward passes and finite-difference checks:

- `sliceCols` / `concatCols` — head slicing and concatenation.
- `mul` — elementwise gating for SwiGLU.
- `silu` — SiLU activation.
- `rmsNorm` — row RMS normalisation with a learned scale.
- `rope` — rotary position embedding per head, with transposed rotation in backward.
- `sumAll` — scalar reduction used by loss and gradient tests.
- `backward(root, {accumulate:true})` — batched gradient accumulation.

### 1.5 Byte-level BPE — `core/ml/bpe.js`

- Starts with all 256 bytes, so arbitrary UTF-8 round-trips without unknown tokens.
- Learns merges deterministically with frequency and numeric tie-breaking.
- Encoding applies merges in learned order; decoding expands byte sequences.
- Versioned JSON checkpoints with SHA-256; contiguous merge-id validation.
- Verified on ASCII, Polish and emoji; frequent text compresses below byte count.

### 1.6 TITAN GPT 2.0 — `core/ml/titan-gpt.js`

A new decoder-only Transformer, not a rename of the character model:

- BPE input vocabulary.
- RoPE instead of learned position embeddings.
- RMSNorm.
- Multi-head causal attention with **grouped-query attention** (`kvHeads` < `heads`).
- SwiGLU feed-forward blocks.
- Multiple decoder blocks, configurable width/heads/blocks/context.
- Batched training through gradient accumulation and one Adam step per batch.
- Deterministic temperature/top-k sampling with stop ids.
- Versioned checkpoint containing weights, tokenizer, optimizer state, step and progress.
- Exact parameter count, measured loss/perplexity, latency and tokens/s.

**Actual measured run** (CPU, synthetic corpus, 10,992 parameters, 3 epochs, batch 4):

```
epoch 1  train loss 5.610  perplexity 273.08
epoch 3  train loss 4.107  perplexity  60.8
```

The checkpoint restored weights and optimizer step, and logits matched within `1e-9`. This is evidence that the implementation trains, not evidence of language quality.

**Not implemented:** KV caching for incremental decoding, mixture-of-experts, a real pretrained corpus, and any GPU measurement. The generator recomputes the prefix and reports that latency honestly.

---

## 2. Measured state

| Measure | 9.0 | 10.0 |
|---|---:|---:|
| First-party lines | 93,160 | **103,087** |
| Tracked files | 311 | **311** |
| Tools | 706 | **715** |
| Tool categories | 36 | **36** |
| Agents | 123 | **123** |
| Executed fixture calls | 632/639 | **641/648** |
| Unexecuted tool names | 74 | **74** |
| Executed checks (this environment) | 2,116 | **2,136** |
| Code index | 230 files / 3,256 symbols | **230 files / 3,455 symbols** |
| Requirements VERIFIED | 9/36 | **15/41** |
| Verified integration level | 25.0% | **36.6%** |

The check total is 2,136 rather than 2,184 because the UI suite is skipped when `jsdom` is not installed. It is not counted as passed. No number is copied forward from 9.0.

### Requirement status

| Status | Count |
|---|---:|
| VERIFIED | 15 |
| PARTIAL | 21 |
| NOT_STARTED | 3 |
| BLOCKED | 2 |
| IMPLEMENTED_UNTESTED | 0 |
| **Total** | **41** |

New VERIFIED requirements: `M3-ACTIVE-CONTROL`, `M3-GOAL-ARBITER`, `M3-EVENT-SYNC`, `M4-AUTOGRAD-OPS`, `M4-BPE`; `M3-NEUROSYMBOLIC` moved from PARTIAL to VERIFIED; `M3-METACOGNITION` was upgraded to active control. `M4-TITAN-GPT` is intentionally `PARTIAL`.

### Long-term targets

| Target | Current | Gap |
|---|---:|---:|
| 1,000,000 lines | 103,087 | 896,913 |
| 2,000 tools | 715 | 1,285 |
| 100 categories | 36 | 64 |
| 300 agents | 123 | 177 |
| 10,000 checks | 2,136 | 7,864 |

The 2,000-check milestone is met. The rest are not, and this report does not call them met.

---

## 3. Verification performed

```bash
npm test
node scripts/acceptance-10.0.js
node scripts/audit-tools.js
node scripts/requirements-graph.js
node scripts/check.js
```

Results in this checkout:

- 20 suites, all exit 0.
- 13 active-metacognition checks.
- 16 cognitive-event/goal checks.
- 21 advanced-reasoning checks.
- 17 TITAN GPT/BPE/autograd checks.
- 28 assistant checks, including an end-to-end test that a real chat run writes typed events and completes a goal.
- 13 integration checks, including the new tools through the real registry.
- 6 requirements-graph checks.
- 160 deep checks and 1,510 toolpack schema/execute/expectation checks preserved.
- Tool audit: 715 tools, 0 structural problems, 641/648 fixture executions.
- Source-only policy check passes; exactly one `INSTALL_SENTINEL_FULL.ps1`.

Reproduction of the neural measurement:

```bash
node test/titan-gpt.js
```

Outputs the parameter count, gradient-check worst errors, training loss curve, checkpoint round-trip and deterministic generation. It writes only to a temporary directory.

---

## 4. Remaining blockers and resumable backlog

### Blocked in this environment

1. **Telephony** — no verified destination, credentials or human approval. Mock providers only.
2. **Windows UIA** — no Windows host. Simulated fixtures only.
3. **Live providers** — mocked in tests; no GPU/VRAM measurement.
4. **Windows installer** — syntax and source policy checked; not executed on Windows.

### Highest-value next work, in dependency order

1. **KV cache and MoE for TITAN GPT** — implement incremental decode and a compact 2-expert FFN, measure tokens/s against the recompute path, then promote `M4-TITAN-GPT` from PARTIAL.
2. **Neural specialists from real traces** — train the 10.0 route/verification/contradiction models on recorded, licensed or synthetic data with group-aware splits and calibration; compare against deterministic baselines.
3. **Production training adapters** — external Python discovery, PEFT/LoRA/QLoRA capability detection and a real adapter run where the environment allows it. Keep base weights immutable.
4. **Tool closure** — investigate the 7 failing fixtures and 74 unexecuted names with safe workspaces and mock providers. Do not auto-approve consequential operations to raise the count.
5. **Agent expansion** — add distinct typed specialists, not renamed personas, and evaluate complete collaborative tasks.
6. **GraphRAG neural retrieval** — wire the new Titan model or an external embedding provider into held-out retrieval benchmarks with NDCG/MRR/citation correctness.
7. **Desktop, voice and telephony** — provider-independent pipelines and simulations first; live verification only with explicit authorization.

### Design constraints preserved

- No fake intelligence, decorative neurons, duplicate tools, empty modules or source padding.
- Retrieved documents and model output are untrusted data.
- Agents cannot modify their own permissions or safeguards.
- Personal data is never silently used for training.
- No EXE/APK/AAB/MSI/BIN/HEX/UF2/firmware or binary packaging.
- No automatic merge into `main`.
