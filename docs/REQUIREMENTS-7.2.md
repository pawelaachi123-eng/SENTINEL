# SENTINEL 7.2 — requirements and measured ledger

This document is the acceptance record for the 7.2 slice. It separates the
requested targets from what this source tree actually does, and every number is
reproducible with the command printed next to it. Nothing here is a projection.

Measured 2026-11-22 (UTC), Linux x64, Node 22.22.3, CPU only (i7-13700F,
32 GB). No GPU, live provider or Windows runner was used for any number below.

## Target statement

The standing 7.2 targets were ≥103,465 first-party lines, ≥1,000 tools, ≥120
agents and ≥2,000 checks. The operator subsequently raised the line target to
**more than 1,000,000 lines of code**. That is the target recorded and measured
against here.

| Measure | 7.1 | 7.2 current | Target | State |
|---|---:|---:|---:|---|
| First-party lines (tracked text, no lock/binaries) | 65,973 | **76,429** | >1,000,000 | **not met** (7.6%) |
| Tools (structural audit) | 350 | **689** | ≥1,000 | not met |
| Tool categories | 29 | **35** | — | — |
| Tools executed against authored cases | 86 | **388 / 388 verified** | all audited | partial (301 unexecuted) |
| Agents | 31 | **123** | ≥120 | **met** |
| Agent routing accuracy | — | **82/86 (95.3%)** | — | deterministic hand-authored cases |
| Checks in the npm test chain | 351 | **1,821** | ≥2,000 | not met |
| Suites in the chain | 7 | **10** | — | all green |
| Specialists | 7 | 7 | 120 | not met (no change this slice) |
| Repository self-index | none | **215 files, 3,007 symbols, 0 parse errors** | 0 errors | **met** |

The 1,000,000-line target is not close and is not claimed. Reaching it requires
roughly 924,000 additional lines of reviewed source; padding modules, generated
duplicates or invented tests are explicitly forbidden by the operator, and
would make every other number in this ledger meaningless. The honest options
are a long sequence of real vertical slices, or a revised target. Both are the
operator's call; this slice does neither silently.

Reproduce the whole table and the suite results with:

```bash
node scripts/acceptance-7.2.js     # writes docs/ledger-7.2.json
node scripts/audit-tools.js        # 689 tools, 35 categories, 0 structural problems
```

## What is implemented in this slice

### 1. Parser-backed code intelligence (`core/coding/`)

A real lexer/parser layer, not regex symbol scraping:

- JavaScript/TypeScript: declarations, imports/exports, arrow functions,
  classes with methods, regex literals with a division heuristic, nested
  template literals and `${…}` expressions.
- Python: logical lines folded across brackets and backslash continuations,
  nested functions/methods and class bodies.
- C, C++, C#, Java: functions, methods, classes, `#include`/`using`/`import`,
  C++ raw strings, line continuations.
- PowerShell: functions, `using module`, `<# … #>` block comments, backtick
  escapes; `Invoke-Expression`/`iex` and download-and-run patterns are flagged.
- SQL: statements and table references, deliberately shallow.

`CodeIndex` scans the tree (5,000 files / 2 MiB per file, no symlinks) and
exposes `search`, `definition`, `references`, `impact`, `callGraph`,
`testsFor`, `bugs`, `proposeTests` and `stats`. `RefactorEngine` performs
token-exact rename, verifies the patches in an isolated copy, binds them to a
SHA-256 approval hash, refuses stale files and rolls back failed writes.

Measured against this repository (the parser's own source included):

```
215 files · 3,007 symbols (2,068 unique) · 723 imports · 35,244 calls
languages: javascript 182, c 23, cpp 4, java 3, powershell 2, python 1
parse errors: 0 · scan 1,030 ms · not truncated
```

### 2. Durable executive engine (`core/executive.js`)

- Worker pool with priorities, deadlines, retries, idempotency keys, per-job
  checkpoints and cancellation; state is persisted and recovered after restart.
- Workflow DAG with dependencies, step budgets, retries and replanning.
- `STOP` cancels pool jobs and workflows together with the rest of the agent.
- 15 checks in `test/executive.js`, including restart recovery, budget
  exhaustion, idempotent submission and cancellation.

### 3. Tool, API, CLI and UI integration

- 11 `coding.*` tools plus 11 `executive.*` tools; categories 29 → 35.
- `/api/coding`, `/api/coding/search`, `/api/coding/bugs`,
  `/api/coding/impact`, `/api/coding/rename`, `/api/executive`,
  `/api/executive/workflows`, `/api/executive/cancel`, `/api/training`,
  `/api/training/adapters`, `/api/training/queue`, `/api/training/train`,
  `/api/training/cancel`, `/api/graphrag`, `/api/graphrag/search`.
- `sentinel coding stats|search|bugs|impact|rename` and
  `sentinel executive status|jobs|submit|cancel|workflows`.
- Models tab cards for the executive engine and the code index.
- Rename application requires a consumed approval whose hash matches the exact
  patch set (`APPROVAL_REQUIRED` / `APPROVAL_MISMATCH` otherwise).

### 4. Fixes found while verifying

- The HTTP layer never received the AI object, so every `/api/training`,
  `/api/executive`, `/api/graphrag` and `/api/coding` route returned 503. Fixed;
  UI integration now exercises the real endpoints (48/48 checks).
- The coding parsers initially mis-read `/` in non-JS languages as a regex
  start, did not fold Python continuations and split nested template literals.
  All fixed; the repository now indexes with zero errors.
- The UI test asserted a hard-coded 31-agent roster; it now derives the count
  from the live registry.

## Verification

`node scripts/acceptance-7.2.js` runs the real suites and records exit codes:

| Suite | Result |
|---|---|
| `test/run.js` | 23 tests passed |
| `test/ui.js` | 48/48 checks |
| `test/ai.js` | 25 checks |
| `test/deep.js` | 160 checks |
| `test/properties.js` | 5 checks |
| `test/toolpacks.js` | 302 tools, 1,510 schema/execute/expectation checks |
| `test/agents.js` | 7 checks; 123 agents, routing 82/86 (95.3%) |
| `test/training.js` | 14/14 |
| `test/executive.js` | 15/15 |
| `test/coding.js` | 14/14 |

Total: **1,821 checks**, all green. `node scripts/check.js` reports "All checks
passed". The gate exits non-zero if any suite fails, the version drifts, the
tool registry fails to assemble or the repository self-scan reports a parse
error.

## Explicit non-claims

- No 1,000,000-line claim. 76,429 lines measured; the remaining gap is stated
  above and is not padded.
- No GPU, quantised-model, installer or Windows-CI verification was performed
  for this slice.
- The parsers implement practical subsets of the named grammars. They fail
  loudly with line/column and refuse to guess; they are not full language
  frontends, type checkers or compilers.
- Static bug rules are evidence-producing heuristics, not proofs of absence.
- 301 registered tools still have no authored execution case; only 388 are
  executed by `scripts/audit-tools.js`.
- The training lab models are CPU-sized analogues; no production model quality
  is claimed.
- The remote push and CI result for this slice are reported in `REPORT-7.2.md`
  only after they actually happen.

## Open work

1. Authored execution cases for the remaining 301 tools.
2. API-key lifecycle for external providers and a live-provider smoke test on a
   machine that has one configured.
3. A Windows CI job for the PowerShell-facing paths.
4. Consolidate the legacy `core/lab.js` facade with `core/lab/index.js`.
5. A real, large-scale source corpus (not filler) if the line target stays at
   one million; the current corpus grows by reviewed vertical slices only.
