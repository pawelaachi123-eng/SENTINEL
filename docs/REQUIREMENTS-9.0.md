# SENTINEL 9.0 requirements graph

The authoritative machine-readable graph is
[`requirements-9.0.json`](requirements-9.0.json).
`node scripts/requirements-graph.js` validates it; `test/requirements.js` runs
the same rules in CI. The last gate ledger is
[`ledger-9.0.json`](ledger-9.0.json).

## Rules

- Statuses: `NOT_STARTED`, `IMPLEMENTED_UNTESTED`, `PARTIAL`, `VERIFIED`,
  `BLOCKED`.
- Only `VERIFIED` counts as done. `BLOCKED` is not a pass.
- A VERIFIED row requires an existing implementation path, an executed test and
  concrete evidence.
- Version bumps, green CI and prose are not evidence.

## Position

| Status | Count |
|---|---:|
| VERIFIED | 9 |
| PARTIAL | 22 |
| NOT_STARTED | 3 |
| BLOCKED | 2 |
| **Tracked** | **36** |

This is 25.0% of tracked requirements, not 22.2% of the 9.0 target set.

| Target | Measured | State |
|---|---:|---|
| 1,000,000 source lines | 93,160 | not met |
| 2,000 tools | 706 | not met |
| 100 categories | 36 | not met |
| 250 agents | 123 | not met |
| 10,000 checks | 2,116 | not met |
| 2,000 checks | 2,116 | **met** |
| 1,000 tools | 706 | not met |

## Verified in 9.0

1. Baseline regression.
2. JSON-Schema union fix.
3. Tool service-bag fix.
4. Conformance matrix.
5. 2,000-check target (now 2,100).
6. Requirements graph integrity.
7. Source-only delivery.
8. **Persistent typed cognitive blackboard** with provenance, scopes, attention,
   conflicts, persistence, HTTP state and real chat integration.
9. **Metacognitive controller** integrated into chat answers and the blackboard.

## Immediate backlog

1. M3 metacognitive controller and induction/counterfactual engines.
2. Tool growth from 705 toward 1,000, starting with the 74 unexecuted names.
3. Agent growth with distinct contracts, not renamed personas.
4. M4 neural library and native GPT architecture extensions.
5. M5 routing/caching/performance measurements on the actual machine.
6. M6 GraphRAG quality benchmarks on larger held-out corpora.

Blocked work is not represented as working. No external action or live provider
was exercised in this release.
