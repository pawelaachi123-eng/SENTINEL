# SENTINEL 3.0 — research notes and design decisions

This is the reasoning behind the 3.0 architecture: what was read, what was
measured elsewhere, what was adopted, and what was deliberately rejected. Every
number below is quoted from a source; nothing here is a benchmark of SENTINEL
itself. SENTINEL's own measurements live in `docs/PROGRESS.md` and are produced
by code in this repository.

Research window: November 2026. Links were read at that time; external numbers
may have moved since.

---

## 1. Local model serving

| Runtime | Licence | Notes that mattered |
| --- | --- | --- |
| Ollama | MIT | Native API plus an OpenAI-compatible endpoint; easy model discovery via `/api/tags`. |
| llama.cpp (`llama-server`) | MIT | Same GGUF weights as Ollama, lower-level control, `--jinja` for tool templates. |
| LM Studio | Proprietary app terms (free for home and internal work; the `lms` CLI is MIT) | OpenAI-compatible server; redistribution/SaaS use restricted, so SENTINEL never bundles it. |
| Any OpenAI-compatible server | Varies | One adapter covers vLLM, LocalAI, Jan, and hosted endpoints the user opts into. |

Licence facts: Ollama and llama.cpp are MIT; LM Studio is a proprietary
application that is free for personal and internal business use but restricts
redistribution and service-bureau use; vLLM is Apache-2.0
([runtime comparison](https://www.developersdigest.tech/local-models/runtimes),
[local LLM tool notes](https://tds.s-anand.net/2026-09/week-2/11-local-llms-1-basics/),
[LM Studio vs Ollama](https://octomind.run/blog/lm-studio-vs-ollama)).

**Decision.** One `LlmClient` with provider adapters (`ollama`, `lmstudio`,
`llamacpp`, `openai-compatible`), a shared model-class mapping
(`fast`/`balanced`/`deep`/`code`/`vision`/`embed`), per-provider circuit
breakers, capability discovery and schema-validated structured output. No model
weights are downloaded by the installer: the tool licence and the weights
licence are separate concerns and the user picks the weights.

**Rejected.** Bundling a runtime binary (size, update cadence, AV false
positives), and binding to one runtime's proprietary features.

---

## 2. Cognitive architecture

The pipeline in `core/cognition.js` and `core/brain.js` is
`understand → retrieve → plan → delegate → execute → verify → repair → answer → retain`.

Sources that shaped it:

- **MemGPT / Letta**: three memory tiers (core blocks, recall, archival) with
  self-editing through explicit memory operations. SENTINEL keeps the tiering
  and the explicit writes, but the *write policy* is deterministic and audited
  rather than a model deciding to call `memory_replace` ([Letta guide](https://aiagentmemory.org/articles/letta-ai-guide/),
  [five memory systems compared](https://medium.com/@wasowski.jarek/i-compared-5-ai-agent-memory-systems-heres-what-i-learned-0b1b0b0b0b0b)).
- **Sleep-time compute** (arXiv:2504.13171): offline consolidation produced
  roughly **5× less test-time compute** with **+13% / +18%** accuracy on the
  reported benchmarks, at about **2.5× cost per query**. SENTINEL adopted the
  idea only in its cheapest, deterministic form: same-day episodic memories are
  folded into one semantic summary by a local rule, never by an extra model
  call during a run.
- **Reflexion / bounded repair**: one corrected attempt in Deep mode, never an
  unbounded loop. `CognitiveCore.reflect()` refuses to retry permission denials
  or cancellations, and caps attempts.
- **Clarification instead of guessing**: an underspecified follow-up ("a to?")
  short-circuits before the model is called and asks a question. This is a
  product decision backed by τ-bench's finding that policy adherence over turns
  — not raw capability — is where agents fail
  ([agent evaluation survey](https://arxiv.org/html/2503.16416v2)).

**Modes.** Fast (single pass, no tools unless explicit), Balanced (one pass plus
verification), Deep (plan, execute per step, audit, one repair), Research (many
retrievals, citations mandatory, larger budget). The differences are real budget
differences in `MODE_BUDGETS`, not prompt adjectives.

---

## 3. Retrieval and context

Practical findings used:

- Anthropic's contextual-retrieval experiment: top-20 retrieval failure fell
  **5.7% → 3.7%** with contextual embeddings, **→ 2.9%** with contextual BM25,
  and **→ 1.9%** after reranking — a **67%** relative reduction. Reranking alone
  lifts NDCG@10 by **8–18 points**
  ([hybrid retrieval pattern](https://iotdigitaltwinplm.com/graphrag-hybrid-retrieval-knowledge-graph-pattern-2026/),
  [GraphRAG-lite, arXiv:2507.03226](https://arxiv.org/html/2507.03226v3)).
- Reciprocal Rank Fusion is the cheap, robust default for combining lexical and
  vector results; a cross-encoder is better but costs a model call per candidate.
- GraphRAG's extraction pass is expensive; a smaller-model variant
  (arXiv:2507.03226) reports about **94%** of the LLM-extraction quality at a
  fraction of the cost, and the useful modes (global/local/DRIFT/basic) map to
  different question shapes rather than one universal index
  ([GraphRAG hybrid pattern](https://iotdigitaltwinplm.com/graphrag-hybrid-retrieval-knowledge-graph-pattern-2026/)).

**Adopted.**

1. Hybrid BM25 + hashed-vector search with RRF (no model needed to rank).
2. A deterministic reranker in `Knowledge.search()`: lexical overlap between the
   query and the fragment, multiplied into the hybrid score
   (`0.75 + 0.5 × overlap`). It is not a neural reranker and is not described as
   one; it fixes the common "similar but useless chunk wins" failure for free.
3. Diversity cap: at most **two fragments per document**, so one long PDF cannot
   fill the evidence block (the "top-15 chunks" lesson).
4. `ContextManager` with an explicit token budget (45% of the model window,
   capped by configuration), priority-ordered sections, truncation markers and
   an auditable report (`sections`, `dropped`, `utilisation`). History is
   digested after N turns instead of replayed.
5. Every hit carries `source`, `chunk`, character offsets and an excerpt; the
   prompt requires `[K#]` citations. Documents are stored with
   `untrusted: true`, `trust: 'untrusted-data'` and an injection-finding count.

**Rejected.** Full GraphRAG (an extraction pipeline per index is too slow for a
desktop assistant on an 8 GB GPU), a learned cross-encoder (VRAM + licence +
startup cost), and re-querying with a model before every search.

---

## 4. Memory 3.0

- SQLite with FTS5 is public domain and ships with the SQLite that Node's
  `node:sqlite` exposes; FTS5 gives a persistent lexical index with `bm25()`
  ranking and `unicode61 remove_diacritics 2` tokenisation, which matters for
  Polish.
- `sqlite-vec` (MIT OR Apache-2.0) is the natural next step for native vector
  search ([sqlite-vec](https://github.com/asg017/sqlite-vec)). It is not used in
  3.0 because it ships a native extension per platform; SENTINEL instead stores
  vectors as BLOBs and ranks in-process with a hashed embedder. The tradeoff is
  honest: no download, no native build, weaker semantics than a real embedding
  model. When a local embedding model is configured (`nomic-embed-text`), recall
  uses it and the hash embedder becomes the fallback.
- Zep/Graphiti reporting **71.2%** vs Mem0's **49%** on LongMemEval is the
  clearest public signal that *graph structure and write policy* beat a plain
  vector store for assistant memory. SENTINEL did not adopt a graph database; it
  adopted the two properties that produced the gap: temporal validity and
  explicit supersession.

**Adopted.** Scopes (project isolation), confidence, provenance
(`source`, `capturedAt`, `from`), conflict detection that keeps both facts and
flags them, supersession that hides replaced records from recall while keeping
history, `asOf` temporal queries, deterministic consolidation, integrity checks,
and `integrity()`/`conflicts()` surfaces in the API and UI. Secrets are refused
at write time by the existing secret scanner.

---

## 5. Task engine

Durable plan execution is modelled on the parts of workflow engines that matter
on one desktop: a validated DAG, per-step attempts with exponential backoff,
checkpoints, idempotency keys, pause/resume/cancel, deadlines, and restart
reconciliation. A task that was `running` when the process died is marked
`interrupted` at startup and requires an explicit resume — it is never silently
re-run, because half of SENTINEL's tools change the machine.

Compensation (Saga) is *not* implemented: SENTINEL prefers staged changes and
explicit approvals over automatic rollback of arbitrary side effects. Backups
cover files; the journal covers tasks.

---

## 6. Multi-agent collaboration

- Supervisor/dispatcher with typed contracts (`run(runtime)` returning
  `{ok, text, tools, usage}`) and a single shared provider: parallel agents on
  one 8 GB GPU thrash VRAM, so SENTINEL runs one specialist at a time and
  merges with explicit provenance.
- Performance-based routing: `ExperienceStore` scores `taskClass × strategy ×
  agent set` with Laplace smoothing and only promotes a change when a
  regression gate passes with enough samples.
- Evaluation literature is used as a warning, not a promise: SWE-bench Verified
  is near saturation (~95% top score) and roughly two-thirds of the original
  instances failed human review; τ-bench's `pass^k` shows agents that succeed
  once often fail on repetition. SENTINEL therefore reports per-strategy sample
  counts and refuses to promote candidates from fewer than 8 samples.

Sources: [evaluation survey](https://arxiv.org/html/2503.16416v2),
[benchmark caveats](https://www.agenticfabriq.com/blog/evaluating-agents-benchmarks),
[ABC checklist arXiv:2507.02825](https://arxiv.org/abs/2507.02825).

---

## 7. Tools, MCP and security

- MCP is MIT-licensed, JSON-RPC 2.0 based, with dated spec revisions; the
  2025-03-26 revision replaced SSE with Streamable HTTP, and later revisions
  added structured outputs and a Tasks primitive
  ([spec repo](https://github.com/modelcontextprotocol/modelcontextprotocol),
  [MCP overview](https://aiwiki.ai/wiki/model_context_protocol)).
- AgentDojo reports utility under attack alongside benign utility, which is why
  SENTINEL treats tool output and documents as untrusted data, scans for
  injection, and never lets a tool result grant permission.

**Adopted.** Default deny for writes/system/privileged actions; approvals bound
to the exact tool name and argument hash, single-use and expiring; a tool guard
that runs before execution; path sandboxing before permission checks; a global
STOP; risk/platform/availability metadata per tool; honest counters
(`implemented`, `available`, `verified`) plus per-tool execution evidence;
dry-run delegation so a preview never counts as an action.

**Rejected.** A general-purpose shell tool, self-editing policy, and MCP servers
enabled by default. MCP integration is opt-in, permission-scoped and out of
process; a model-supplied `confirm: true` is never consent.

---

## 8. Windows troubleshooting and coding workflow

The coding loop is `inspect → plan → stage patch → test in isolation → diff →
approve → apply → verify`, with the workspace copy under
`SENTINEL_HOME/workspaces/<id>`. Evidence-based troubleshooting means each claim
about the machine is tied to a tool call and its output; when no tool produced a
value, the answer says so. The UI shows the same evidence (`tools`, `agents`,
`verification`), so the user can check the reasoning rather than trust it.

---

## 9. Reliability

Circuit breaker, bounded retry with backoff, incident log with grouping and
recovery, and watchdogs with confirmation counts (one good probe is not a
recovery). Fault-injection tests cover provider outage, corrupt configuration,
interrupted tasks and unavailable FTS5. Backups and journals exist because the
failure mode that hurts most on a personal machine is not a bad answer — it is
lost state.

---

## 10. Benchmarks: what is measured and what is not

Published agent scores are softer than they look: SWE-bench Verified's top score
is ~95% while a third of "successful" patches had the fix in the issue text and
another third passed because tests were too weak; GAIA is saturated above its own
human baseline. The ABC checklist (arXiv:2507.02825) notes that benchmark design
flaws can mis-estimate agent performance by up to **100% in relative terms**
([benchmark caveats](https://www.agenticfabriq.com/blog/evaluating-agents-benchmarks),
[ABC](https://arxiv.org/abs/2507.02825)).

SENTINEL therefore measures only what it can run:

- deterministic answer checks (arithmetic, obvious tool choice, clarification),
- p50/p95 latency per subsystem from a reservoir, tokens/s and time-to-first-token
  from real provider calls,
- startup time and idle RSS at boot, recorded as a baseline,
- task/strategy success rates with sample counts.

There is no SENTINEL "IQ" score, no invented accuracy percentage, and no
comparison to a benchmark it has not actually run.

---

## 11. Licences

| Component | Licence | Used as |
| --- | --- | --- |
| Node.js | MIT | Runtime (bundled by Electron / pkg) |
| Electron | MIT | Desktop shell (`desktop/`) |
| SQLite / FTS5 | Public domain | Store and lexical index |
| `node:sqlite` | MIT (Node) | SQLite binding, experimental flag |
| sqlite-vec | MIT OR Apache-2.0 | Not adopted in 3.0 |
| Ollama | MIT | Optional provider |
| llama.cpp | MIT | Optional provider |
| LM Studio | Proprietary, free for personal/internal use | Optional provider, never bundled |
| MCP specification | MIT | Protocol reference for optional integration |
| Tesseract | Apache-2.0 | Optional OCR |
| Piper | MIT | Optional local TTS |
| whisper.cpp | MIT | Optional local STT |

Model weights carry their own licences (Llama, Qwen, Gemma, Mistral families
differ); SENTINEL does not redistribute weights and the configuration template
names the models the user is expected to pull themselves.

---

## 12. Decisions summary

| Question | Choice | Why |
| --- | --- | --- |
| Graph database for memory? | No | Cost and complexity for a single-user desktop; supersession + provenance captures most of the benefit |
| Native vector extension? | No (3.0) | Per-platform binaries; hashed vectors are honest and dependency-free |
| Neural reranker? | No | VRAM and licence cost; lexical rerank removes a real failure cheaply |
| Multi-agent parallelism? | No | One 8 GB GPU; sequential specialists with provenance |
| Unbounded reflection? | No | Bounded to one repair in Deep, with explicit refusal on permission errors |
| MCP by default? | No | Untrusted third-party code; opt-in, scoped, out of process |
| Cloud models? | Opt-in only | Local-first is the product; external APIs are a configuration choice |
| Model-reported confidence? | No | Verification is deterministic checks plus tool evidence, not self-report |

---

## 13. 4.0 research notes and what changed as a result

| Topic | Finding that mattered | Implementation decision |
| --- | --- | --- |
| MCP revision drift | 2024-11-05 → 2025-03-26 (Streamable HTTP) → 2025-06-18 (structured output, OAuth, elicitation) → later drafts add Tasks | client requests 2025-06-18, accepts two older revisions, records the negotiated one per server, and does not claim Tasks/sampling/elicitation |
| MemGPT / Letta | memory hierarchy + explicit state beats a longer transcript | deterministic conversation summaries with source turns; secrets skipped |
| GraphRAG | multi-hop retrieval needs entities and typed relations, with provenance | graph section in the context budget; bounded paths; conflicts retained |
| LangGraph | checkpoints, interrupts, resumable execution | executor persists every transition; approval parks a step; interrupted runs reconcile on restart |
| OpenHands / SWE-bench practice | verification must be isolated and reproducible | full-copy verification; staged patch workflow unchanged |
| Agent evaluation literature | held-out splits, no self-grading, overestimation risk | stable-hash split, observable scoring, mock-impossible gates, regression veto |
| Local inference (Ollama) | keep-alive controls VRAM; 8 GB is the real constraint | runtime profiles, feasibility refusal, unload through `/api/ps` + `keep_alive: 0` |
| sqlite-vec | MIT OR Apache-2.0, useful ANN | deferred: hashed+lexical retrieval met the measured corpus; a native Windows dependency needs packaging work first |
| LM Studio | proprietary | never bundled; the `lms` CLI is MIT but the runtime is not shipped |
