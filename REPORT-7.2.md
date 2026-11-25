# SENTINEL 7.2 — report

## Outcome

7.2 adds two real subsystems to SENTINEL and wires them through tools, HTTP,
CLI and UI: a durable executive engine and parser-backed code intelligence. The
full suite is green and the repository now indexes itself with zero parser
errors.

The requested **>1,000,000 lines** target was not reached. The measured tree is
**76,429 first-party lines**, an increase of 10,456 over 7.1 under the same
counting rule. I did not add filler, generated duplicates or empty modules to
move the number; that would violate the standing instruction to report measured
results only. The gap (923,571 lines) is recorded in
`docs/REQUIREMENTS-7.2.md` and `docs/ledger-7.2.json`.

## What changed

### Code intelligence

- `core/coding/parsers.js` — lexer and parsers for JavaScript/TypeScript,
  Python, C, C++, C#, Java, PowerShell and SQL. Handles regex-vs-division,
  nested template literals, C++ raw strings, PowerShell block comments and
  backtick escapes, Python bracket/backslash line folding, and line
  continuations. Tokenizer errors carry line, column and nearby source text.
- `core/coding/index.js` — `CodeIndex` and `RefactorEngine`. Scan, symbol
  search, definitions, references, import-based impact analysis, call graph,
  test discovery, static bug rules with evidence, test proposals, and
  hash-bound transactional multi-file rename with isolated verification,
  stale-file rejection and rollback.
- `core/tools/coding.tools.js` — 11 tools; apply requires a consumed approval
  bound to the patch hash.

### Executive engine

- `core/executive.js` — persistent worker pool and workflow DAG: priorities,
  deadlines, budgets, retries with backoff, idempotency keys, checkpoints,
  cancellation, restart recovery and replanning.
- `core/tools/executive.tools.js` — 11 tools.
- `STOP` now cancels executive work along with the brain and provider calls.

### Integration

- `/api/coding/*`, `/api/executive/*`, `/api/training/*` and `/api/graphrag/*`
  routes are live. The cause of the previous 503s was that `HttpApi` was
  constructed without the AI object; `core/agent.js` now passes the subsystem
  objects.
- `sentinel coding …` and `sentinel executive …` CLI commands.
- Models tab cards report real pool/workflow state and index statistics.
- `SENTINEL_CODE_ROOT` lets an operator point code intelligence at a checkout
  without changing the sandbox workspace.

## Measured results

| Measure | 7.1 | 7.2 |
|---|---:|---:|
| First-party lines | 65,973 | **76,429** |
| Tools / categories | 350 / 29 | **689 / 35** |
| Executed tools | 86 | **388 / 388 verified** |
| Agents | 31 | **123** (routing 82/86, 95.3%) |
| Checks | 351 | **1,821** |
| Code index | none | **215 files, 3,007 symbols, 0 errors** |
| Repository scan time | — | **1,030 ms** |

Ten suites, all green:

```
run 23 · ui 48/48 · ai 25 · deep 160 · properties 5 · toolpacks 1510
agents 7 · training 14/14 · executive 15/15 · coding 14/14
```

`node scripts/acceptance-7.2.js` reproduces this and writes
`docs/ledger-7.2.json`; it fails the gate on any suite failure, version drift,
registry failure or self-scan parse error. `node scripts/check.js` passes.

## Defects found and fixed during acceptance

1. **Every new API route returned 503.** `HttpApi` received no `ai` object, so
   `/api/training`, `/api/executive`, `/api/graphrag` and `/api/coding` all
   short-circuited. This was caught by the UI integration test, not by unit
   tests.
2. **Regex heuristic broke non-JS parsing.** A `/` in PowerShell and C sources
   was treated as a regex delimiter, producing `unterminated regular
   expression`. Regex scanning is now restricted to JS/TS.
3. **Python continuations and nested templates split logical lines.** Fixed by
   bracket-depth folding and recursive `${…}` skipping.
4. **Stale UI assertion.** The organisation panel test hard-coded 31 agents and
   failed against the real 123-agent roster; it now derives the expected count.

## Verification boundary

Verified on this machine, CPU only:

- all ten suites through the real code paths, including a jsdom UI session
  against a live in-process HTTP server;
- repository self-index and CLI commands against the checkout;
- API endpoints with a real pairing token, exercised in-process.

Not verified:

- GPU training, quantised inference or any live external model provider;
- Windows CI, installers or signed binaries;
- a one-million-line codebase, because one does not exist here;
- 301 registered tools without authored execution cases;
- full grammar conformance for any language.

## Repository state

Branch `arena/15fbea48-sentinel`, PR #1 remains open and unmerged. The 7.2
slice is committed in two commits: the executive/coding subsystems and this
acceptance record. Push and CI status are reported in the session, not assumed
here.
