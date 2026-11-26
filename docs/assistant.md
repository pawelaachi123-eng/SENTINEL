# The assistant

SENTINEL is not a chat window bolted onto a control panel. The assistant and the
control surface share one audited path to the machine: a model may *ask* for a
tool, but the tool engine decides whether the call is legal, runs it with a
timeout, records it, and refuses anything the policy forbids.

```
 question
    │
    ▼
 Dispatcher ──► picks the smallest set of specialists (31 agents)
    │
    ▼
 Brain ───────► memory recall · knowledge retrieval · planning · tool calls
    │            · verification · degradation · cancellation
    ▼
 Tool engine ─► 176 tools, 17 categories, argv-only, sandboxed paths,
    │            single-use approvals, per-call timeouts, audit log
    ▼
 Answer ──────► text + citations + tool log + confidence + issues
```

Everything runs on the machine. There is no account, no telemetry, and no
request leaves the box unless you configure an external OpenAI-compatible
endpoint yourself.

## 3.0 at a glance

Every question now goes through a brief before anything else happens:
`understand → constraints → recall → routing → planning → working → verify →
answer → retain`. The brief (intent, strategy and why, risk, constraints,
assumptions, completion criteria, uncertainty with reasons, budget) is attached
to the answer and shown in the **Poznanie** screen. A vague follow-up is answered
with a clarifying question instead of a guess.

| Piece | Where | Guarantee |
| --- | --- | --- |
| Cognitive brief | `core/cognition.js` | deterministic, no model call, bounded budgets per mode |
| Context budget | `core/context.js` | never exceeds the window; reports what was dropped/truncated |
| Task DAG | `core/tasks.js` | invalid plans rejected before running; retries, checkpoints, pause/resume; interrupted ≠ retried |
| Experience | `core/experience.js` | per-strategy scoring with sample counts; changes only through a regression gate |
| Events / metrics | `core/events.js`, `core/metrics.js` | typed bus and real p50/p95; no synthetic numbers |
| Reliability | `core/reliability.js` | breakers, bounded retry, incident log, watchdogs with confirmation |
| FTS5 | `core/memory/store.js` | persistent lexical index beside the records; `fts:false` when unavailable |
| Staged patches | `core/patching.js` | propose → verify in isolation → diff → approval → write → confirm, with a backup |

## Modes

| Mode | What it does | When to use |
| --- | --- | --- |
| `fast` | One pass, 3 memories, 2 documents, no planning | quick facts, arithmetic, "what is my CPU doing" |
| `balanced` | One pass plus verification (default) | everyday questions |
| `deep` | Plan, execute steps as a task, compose, verify, optional model audit | "prepare this", "check everything and tell me what is wrong" |

`balanced` also plans when the question asks for it (`zaplanuj`, `plan`,
`krok po kroku`, `step by step`). The mode is stored in `ai.mode` and can be
changed from the UI, the API (`POST /api/ai/mode`) or the CLI (`--deep`).

## Agents and the dispatcher

31 specialists, each with a role (`orchestrator`, `llm`, `tool`), a description,
a set of trigger phrases and the tool categories it may use. The dispatcher
scores the question, picks one primary agent plus at most one cheap helper, and
remembers which combination worked (a strategy table in the store). It never
broadcasts a question to every agent: that is slow, expensive and produces
answers that contradict each other.

`GET /api/agents` returns the roster; `sentinel agents` prints it.

## Tools

`GET /api/tools` returns every tool with its description, category, permission
(`read`, `write`, `dangerous`, `system`), parameter schema, tags and timeout.

Guarantees that hold for every call:

* arguments are validated against the schema before anything runs;
* paths are resolved inside the sandbox allowlist, network targets inside the
  allowed ranges, and shell commands never receive a model-built string;
* each call has a timeout, is cancellable and is written to the audit log;
* `dangerous` tools require an approval that authorises **one** call with
  **exactly** the arguments the user saw (replay and argument-swap are refused).

## Memory

Local, persistent, and deliberately suspicious:

* secrets are never stored — keys, tokens, card numbers and `hasło to …` are
  refused and reported;
* text that looks like instructions to the assistant is refused too, because
  "remember this" is a common way to poison a future turn;
* near-duplicates are merged (cosine ≥ 0.93);
* recall blends lexical and vector search, then re-ranks by recency (21-day
  half-life), importance and access frequency;
* `memory.forget` and the UI button really delete, including the vector.

## Knowledge base

PDF, DOCX, XLSX, CSV, Markdown, source code and logs are extracted locally
(no cloud parser), split into ~1000-character chunks with 150-character overlap,
and embedded with the local embedder. Answers cite fragments as `[K1]`, `[K2]`;
verification flags an answer that retrieved documents but cites none.

```bash
sentinel index ~/Dokumenty --tags praca
sentinel ask "co w dokumentach pisze o gwarancji?"
```

## Verification and honesty

Before an answer is shown it is checked for:

* empty or uselessly short text (a short *measured* answer is fine — `6*7 = 42`
  is complete);
* tool failures the answer does not mention;
* retrieved documents that are never cited;
* numbers that contradict the tool results.

Confidence is derived from those checks, not from the model's opinion:
a deterministic tool answer starts at 0.78, a generated one at 0.55, verified
answers gain, failed tools and issues subtract, a cancelled run is 0.

If no model is reachable, the assistant says so and answers with the evidence it
could measure. It never pretends to have thought.

## Stop

STOP is not cosmetic. It aborts the HTTP stream, the model request and the brain
run, marks the task cancelled and reports `cancelled: true` with confidence 0.
Automations paused by the user stay paused.

## Self-healing

`healing.diagnose` checks config parsing, data writability, the store, disk
space, ports, model providers, the ESP32 link and the SQLite runtime.
Repairs are proposals, not actions: each one is approval-gated, single-use,
backed up first, and never touches protected paths (`config.json`, `.env`,
`.ssh`, `firmware`). Every restore keeps the replaced file as
`<name>.before-restore-<timestamp>`.

```bash
sentinel doctor          # read-only, exit 3 when something is broken
sentinel doctor --fix    # shows the plan, asks, then applies it
```

## Voice and vision

* **STT** — whisper.cpp (`whisper-cli` / `whisper` / `main`) with a `ggml-*.bin`
  model in `<data>/models/whisper`; push-to-talk in the UI, `sentinel voice
  transcribe <file>` in the terminal.
* **TTS** — Windows SAPI, or `espeak-ng`/`piper` elsewhere; `--speak` and
  `sentinel voice speak "…"`.
* **Vision** — send an image to the configured vision model, or OCR it locally
  with tesseract (`pol+eng` by default). Screenshots are captured through the
  normal command path, so they are audited like any other action.

Missing engines produce a code (`STT_NOT_INSTALLED`, `OCR_NOT_INSTALLED`,
`TTS_FAILED`, `NO_VISION`), never a silent empty answer.

## HTTP API

All routes require the UI token (`?t=` or `x-sentinel-token`).

| Route | Purpose |
| --- | --- |
| `POST /api/chat` | NDJSON stream: `start`, `stage`, `token`, `final`, `error` |
| `POST /api/chat/stop` | abort a run (optionally by `runId`) |
| `GET /api/chat/history` | stored turns for a session |
| `GET /api/ai/status`, `POST /api/ai/mode` | stack status, reasoning mode |
| `GET /api/agents`, `GET /api/tools` | roster and tool catalogue |
| `GET /api/models`, `POST /api/models/benchmark` | providers, installed models, speed |
| `GET /api/approvals`, `POST /api/approvals/decide` | pending approvals |
| `GET|POST /api/memory`, `GET|POST /api/knowledge` | memory and documents |
| `GET /api/tasks`, `POST /api/tasks/cancel` | tasks and steps |
| `GET|POST /api/automations` | schedules |
| `POST /api/diagnostics`, `POST /api/doctor`, `GET /api/backups` | health |
| `POST /api/voice/transcribe`, `POST /api/voice/speak` | speech |
| `GET /api/eventlog` | typed event bus (`/api/events` is the SSE log stream) |
| `GET /api/metrics`, `GET /api/reliability` | measured series, breakers, incidents, watchdogs |
| `GET /api/experience`, `POST /api/feedback` | strategy leaderboard, user rating |
| `GET|POST /api/cognition` | last run report, ad-hoc brief |
| `GET /api/memory/conflicts`, `GET /api/memory/integrity`, `POST /api/memory/consolidate` | memory quality |
| `POST /api/tasks/pause`, `POST /api/tasks/resume` | task lifecycle |

The chat stream ends with exactly one `final` frame — including when the client
disconnects, the user presses STOP, or no model is installed.

## Command line

```bash
sentinel ask "jaki mam GPU?"          # streamed answer, exit 2 when empty
sentinel ask "..." --deep --speak --json
sentinel chat                         # interactive
sentinel doctor --fix
sentinel memory list | search <q> | add <text> | forget <id>
sentinel index ~/Dokumenty
sentinel models --benchmark
sentinel agents | tools <query> | tasks | automations | approvals
sentinel voice transcribe nagranie.wav --lang pl
sentinel status --json
sentinel benchmark                    # measured latency, RSS, tool/agent counts
sentinel test [--all]                 # deterministic suites (run + deep; --all adds UI/API)
sentinel backup [list|<label>]        # config, memory, database
sentinel rollback [--config]          # newest backup, previous files kept
sentinel update [--check]             # compare with the latest release (never auto-applies)
sentinel migrate                      # store migration + integrity + knowledge coverage
```

Exit codes: `0` ok, `1` error, `2` unusable command, `3` unhealthy, `4` repair
failed, `5` not found, `6` no model / no engine.

## Models

Provider order is `ollama → lmstudio → llamacpp → external → any registered`.
Model classes (`fast`, `balanced`, `deep`, `code`, `vision`, `embed`) are mapped
in config; `sentinel models` shows which are actually installed. Failure codes:
`MODEL_MISSING`, `HTTP_ERROR`, `TIMEOUT`, `CANCELLED`, `NO_PROVIDER`,
`ALL_FAILED`, `NO_EMBEDDINGS`, `AI_DISABLED`.

A 4B model is enough for routing and short answers; use 7–9B for composing and
14B+ for code. Embeddings can be a small dedicated model — never compare vectors
across embedders, which is why each record stores its `vectorName` and `dim`.
