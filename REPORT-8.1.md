# SENTINEL 8.1.0 — Omega, first verified slice

**Status: PARTIAL.** This release does **not** meet the 8.1 target set. It closes
the 2,000-check requirement, fixes two real product defects, and turns tool
verification from schema inspection into execution. The machine-readable graph
in `docs/requirements-8.1.json` records **7 VERIFIED, 22 PARTIAL, 3
NOT_STARTED, 2 BLOCKED of 34 tracked requirements**. Only VERIFIED counts.

## What changed in code

| Change | Why it mattered | Evidence |
|---|---|---|
| `core/tools/schema.js` accepts `type: ['string','number']` | `calendar.add` and other union-typed tools rejected legal input with `BAD_ARGS` | `test/integration.js`: string + number accepted, boolean refused |
| `core/agent.js` exposes `patches`, `cognitive`, `context`, `semantics`, `executor`, `skills`, `reasoning` | Every `patch.*` tool returned `NO_PATCHES`; patch proposal was silently dead in the agent | `patch.propose` → id + diff through the real registry |
| `scripts/audit-tools.js` runs reversible fixtures | 159 tools had only schema checks; a green shape check is not evidence that a tool works | 615/619 fixture calls verified, 0 structural problems, exit 0 |
| `core/tools/skills.tools.js` formatter | `skill.validate` promoted the skill, then crashed reading `data.validation.score` | validated skill returned through the registry |
| `core/tools/runtime.tools.js` formatter | `runtime.free` threw on unsupported providers because `results` was absent | structured `PROVIDER_UNSUPPORTED` response |
| `test/conformance.js` | Independent inputs for arithmetic, units, dates, geometry, physics, finance, statistics and text | 210/210 |
| `test/integration.js` | Cross-subsystem reachability, not isolated unit behaviour | 12/12 |
| `docs/requirements-8.1.json` + validator | Prevents status inflation; VERIFIED rows need existing code, a test and evidence | 6/6 graph-integrity checks |

## Measured on this checkout

- **84,517 first-party lines** across 298 tracked files (target 1,000,000 — not met).
- **689 tools in 35 categories** (targets 1,000 and 2,000 — not met).
- **123 specialist agents** (target 250 — not met).
- **2,058 checks** in 13 suites, all passing (2,000 target met; 10,000 stretch target not met).
- Tool audit: **615 of 619 executing fixture calls verified**; **74 tool names remain unexecuted**.
- Self-index: **222 files / 3,113 symbols / 0 parse errors**.
- Acceptance gate `node scripts/acceptance-8.1.js` exits 0 and writes `docs/ledger-8.1.json`.

## Honest gaps

- **1M lines**: 915,483 lines short. Not reachable by aliases, generated prose or duplicates; it needs real subsystem growth.
- **Tools**: 311 to 1,000 and 1,311 to 2,000. The remaining 74 unexecuted tools are mostly provider, device, approval-gated write paths, process control, MCP and installer paths that need hardware or explicit consent.
- **Agents**: 127 short. Further specialists need non-overlapping contracts and measured quality.
- **Checks**: 7,944 short of 10,000.
- **Neural**: CPU-scale GPT and the training lab are real but are not frontier models, and no GPU benchmark was run here.
- **Windows UIA / telephony / mobile hardware**: BLOCKED — no Windows host, approved phone destinations, or physical devices in this environment. Mobile and ESP32 sources are preserved; only simulations ran.
- **Live providers**: not exercised; mocks only. Real smoke tests need separate approval.
- **Installer**: not run on Windows.
- **Cognitive core**: deterministic briefs, budgets and goals exist, but the unified typed blackboard, full neuro-symbolic solver set and metacognitive controller are PARTIAL, not complete.

## Reproduce

```bash
npm test
node scripts/requirements-graph.js
node scripts/audit-tools.js --no-write
node scripts/acceptance-8.1.js
```
