# SENTINEL 8.1 requirements graph

The authoritative machine-readable graph is [`requirements-8.1.json`](requirements-8.1.json).
`node scripts/requirements-graph.js` validates it; `test/requirements.js` runs the
same rules in CI. The ledger for the last gate run is
[`ledger-8.1.json`](ledger-8.1.json).

## Rules

- Status vocabulary is fixed: `NOT_STARTED`, `IMPLEMENTED_UNTESTED`, `PARTIAL`,
  `VERIFIED`, `BLOCKED`.
- Only `VERIFIED` counts as done. `BLOCKED` is not a pass.
- A `VERIFIED` row must name an implementation path, a test path and concrete
  evidence; both paths must exist.
- A `BLOCKED` row must state a concrete blocker.
- Version bumps, green CI and prose are not evidence of a met target.

## Current position

| Status | Count |
|---|---:|
| VERIFIED | 7 |
| PARTIAL | 22 |
| BLOCKED | 2 |
| NOT_STARTED | 3 |
| **Total tracked** | **34** |

This is 20.6% of the **tracked requirements**, not 20.6% of the 8.1 target set.
The large numeric targets are separate rows and remain open:

| Target | Measured | State |
|---|---:|---|
| 1,000,000 source lines | 82,326 | not met |
| 2,000 tools | 689 | not met |
| 100 categories | 35 | not met |
| 250 agents | 123 | not met |
| 10,000 checks | 2,056 | not met |
| 2,000 checks | 2,056 | **met** |

## Verified in 8.1

1. Baseline re-run before edits.
2. JSON-Schema union-type fix.
3. Service-bag fix that restored `patch.*`.
4. 210-case conformance matrix.
5. 2,000 functional checks.
6. Requirements graph integrity.
7. Source-only delivery policy.

## Blocked

- **M9 telephony** — verified destination numbers, provider credentials and
  explicit approval for live calls.
- **M10 Windows UIA** — no Windows desktop host.

No claim is made that blocked work works. No live provider, phone, GPU or
Windows measurement is represented as verified.
