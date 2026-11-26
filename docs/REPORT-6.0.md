# SENTINEL 6.0.0 — neural supercore (tested slice)

Status: **partial and honest**. SENTINEL 6.0 adds a real CPU-trained neural
classifier with measured held-out metrics, typed memory and migrations,
persistent research sessions with line citations, 38 data/statistics/text/
encoding tools, a lab/neural/research panel backed by real APIs, CLI commands
for the lab and research, and installer health checks. It does **not** deliver
80–120 agents, 500+ verified tools, 1000+ tests, LoRA training or multimodal
work. Those remain in `docs/REQUIREMENTS-6.0.md`.

## Executed gates (this sandbox, Linux x64, Node 22.22.3, no GPU, no model)

| Gate | Result |
| --- | --- |
| `node test/run.js` | 23 passed |
| `node test/ai.js` | 25 passed |
| `node test/ui.js` | **41/41** (includes lab panel + unauthenticated/empty/no-model API negatives) |
| `node test/deep.js` | **131/131** (was 117) |
| `node scripts/check.js` | all checks passed |
| `node scripts/eval.js` | **76/76**, score 1, **mode mock** — not model quality |
| `node scripts/audit-tools.js --no-write` | **270 tools / 24 categories / 0 structural problems / 59 executed / 211 unexecuted** |
| `sentinel lab` | dataset 346 examples, 10 intents; no active model before training |
| `sentinel train --approve tester` | trained, **test accuracy 0.796 vs keyword baseline 0.755**, macro-F1 0.799, 22 epochs, 197,681-byte checkpoint, SHA-256 recorded |
| `sentinel lab classify "sprawdz ile mam ramu"` | `status` at 0.665 confidence (after explicit promotion) |
| `sentinel lab rollback --approve tester` with no previous model | refused `NO_PREVIOUS_MODEL`, exit 4 |
| `npm run bench:lab` | **0.796 test accuracy vs 0.755 baseline**, macro-F1 0.799, 22 epochs, 606 ms, checkpoint 197,681 B, artifact `docs/lab-6.0.json` |
| `node scripts/bench.js` | `docs/bench-6.0.json` (boot, retrieval, graph, executor; no model/GPU) |

Training was not run in CI; the numbers above are one local run, reproducible
with `npm run bench:lab` (artifact `docs/lab-6.0.json`) and the test suite
additionally asserts that the measured accuracy beats the baseline, that
the gradient check is within 1e-3, and that the same seed reproduces the same
weights and metrics.

## What is real and new

1. **A neural network, not metaphor** (`core/ml/mlp.js`, `core/ml/features.js`).
   Dense layers, ReLU, softmax cross-entropy, manual backpropagation, Adam with
   L2, mini-batches, early stopping and a checkpoint with SHA-256. A numeric
   gradient check is part of the tests. Features are hashed word unigrams plus
   character 4-grams, so Polish diacritics/typos still match; the file says it is
   not a tokenizer.
2. **Learning lab with measurement** (`core/lab.js`). 346 synthetic bilingual
   examples (10 intents), deduplication, deterministic stratified 70/15/15 split,
   near-duplicate curation (moved out of the held-out set, never counted as a
   pass), a keyword baseline, contamination refusal, validation-based early
   stopping, confusion matrix and per-class recall. Weights are written under
   `SENTINEL_HOME/models`; nothing enters the source tree. Promotion requires a
   named human and records the previous model for rollback. A rejected result
   stays a candidate; nothing auto-deploys.
3. **Typed memory and migration** (`core/memory/memory.js`). Added
   `conversation`, `preference`, `temporal` and `prospective` kinds; prospective
   memories require a due time and are listed by deadline; supersession history
   is auditable. Migration preview writes nothing; applying requires an
   approving identity and writes a full store backup first; text, ids and
   timestamps are preserved.
4. **Persistent research sessions** (`core/research.js`). Durable plan and
   sub-questions, source fingerprint and duplicate refusal, workspace boundary,
   quotes with real line numbers, numeric contradictions kept unresolved,
   single-source gaps declared, and a refusal (`NO_SOURCES`) instead of invented
   findings. Online research is opt-in and approved.
5. **38 deterministic tools** (`core/tools/analytics.tools.js`,
   `core/tools/text.tools.js`): CSV/JSON/table operations, descriptive
   statistics, correlation, least-squares regression, IQR outliers, z-scores,
   seeded sampling, confidence interval, two-proportion test, identifier
   extraction, secret redaction, slugify, edit distance, trigram similarity,
   chunking with offsets, keyword frequency, text statistics, ISO time
   arithmetic, base64/hex/URL/hash/UUID.
6. **Tool/data safety.** All 38 new tools are read-only (`read`); none reads files or the network. Tool audit executed all 38 (plus 21
   existing calls) successfully: **59/59**.
7. **API/UI/CLI.** The UI test now also asserts that `/api/lab` rejects a
   missing token, that `/api/lab/classify` rejects empty text, and that
   classification without a promoted model refuses with `NO_MODEL` instead of
   guessing. The first run of that test exposed a real wiring bug (the HTTP
   layer was not given the lab/neural/research services); it is fixed in
   `core/agent.js`. `/api/lab`, `/api/lab/classify`, `/api/neural`,
   `/api/research`; a “Laboratorium i badania” panel with real dataset
   provenance, experiment artifacts and research sessions; CLI
   `lab|train|research` with meaningful exit codes.
8. **Installer.** Still stage → backup → health-check → atomic deploy →
   rollback, with data preservation. It now also reads lab/neural status after
   install and never starts training; training requires `--approve`.

## Source size

First-party source lines (JS/HTML/CSS/INO/CPP/PS1, excluding dependencies,
weights, caches and generated assets): **53,465**, up from 45,684 at 5.0.
The new ML/lab/research/tool files account for 2,872 lines by themselves; the
rest is tests, wiring, UI and documentation.

## Explicit gaps

- 31 agents, not 80–120. No new personas were added just to raise the count.
- 270 tools, not 500+ verified. 211 remain unexecuted by the audit.
- 76 evaluation cases, not 1000+; no property-based or fault-injection suite.
- Training is a small MLP on synthetic intents. No LoRA/QLoRA, distillation,
  preference optimisation, reranker, GPU training or live-model evaluation.
- No multi-file patch application, parser-backed symbol engine or hostile
  fixture suite.
- No new multimodal fixtures, Android/ESP32 integration tests or orb states.
- No measured VRAM, time-to-first-token or tokens/s on the RTX 4060 Ti.
- Linux and **Windows CI are green** for commit `1720262` (Agent checks,
  Windows executables, Android APK, ESP32 firmware, publish).
- The installer was not executed in this sandbox (no PowerShell); its PS1 syntax
  is checked by `scripts/check.js` but the install flow was not run.

## Sources

- Ollama API and metadata: <https://github.com/ollama/ollama/blob/main/docs/api.md>
- MCP specification and revisions: <https://modelcontextprotocol.io/specification/>
- τ-bench `pass^k`: <https://arxiv.org/abs/2406.12045>
- Agentic Benchmark Checklist: <https://arxiv.org/abs/2507.02825>
- Adam (Kingma & Ba): <https://arxiv.org/abs/1412.6980>
- CS231n backpropagation notes (gradient checking practice):
  <https://cs231n.github.io/neural-networks-3/>
