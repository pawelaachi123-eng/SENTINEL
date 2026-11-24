# SENTINEL 6.0

**Your own assistant for your own machine — it runs on the PC, answers with measurements instead of guesses, and can still be driven from your phone over a direct encrypted channel. No account, no cloud.**

```
   phone                         your own network                       your PC
┌──────────┐   ST1 tunnel (AES-256-GCM)   ┌──────────────┐   TCP 7879   ┌──────────────┐
│  app /   │ ───────────────────────────► │  PC agent    │ ◄──────────► │    ESP32     │
│  browser │ ◄─────────────────────────── │  :7878       │   HMAC link  │   bridge     │
└────┬─────┘   ECDH P-256, pairing key    └──────┬───────┘              └──────┬───────┘
     │                                           │ policy, rate limit,          │ power +
     │        ST1 tunnel straight to the ESP32   │ audit log, SSE               │ reset relays
     └───────────────────────────────────────────┴─────────────────────────────►│
              (the ESP32 relays PC commands when it cannot run them itself)     │
```

Three situations, one app:

| Situation | Path the phone uses | What still works |
| --- | --- | --- |
| PC running, agent up | phone → agent tunnel (`:7878`) | everything: shutdown, lock, screenshot, typing, macros, live metrics |
| PC running, ESP32 paired | phone → ESP32 tunnel → agent link | everything, relayed through the ESP32 |
| PC off / agent down | phone → ESP32 tunnel | **power on**, power cycle, hard reset, PC power state |

## The assistant

SENTINEL 6.0 is a cognitive assistant that can *operate this computer*, not
just talk about it — with a real brief, bounded plans, verified answers and a
memory that admits when two facts contradict each other. Ask in the UI, on the phone, or in a terminal:

```bash
sentinel ask "jaki mam GPU i ile VRAM jest zajęte?"
sentinel ask "znajdź w dokumentach co pisze o gwarancji" --deep
sentinel doctor --fix
```

* **It measures before it speaks.** Hardware, processes, files, documents, logs
  and the ESP32 are read through 270 audited tools; every answer carries its
  tool calls, citations and a verification report.
* **It knows what its models can do.** `sentinel neural` reads architecture,
  quantisation, context length and capabilities from the provider itself, routes
  each task to a capable model, and refuses with exit code 4 when none is
  installed — no invented context windows or neuron counts.
* **It trains a small model and measures it.** `sentinel train --approve <name>`
  trains a CPU MLP on synthetic PL/EN intents, reports held-out accuracy against
  a keyword baseline, macro-F1 and confusion, writes a checksummed checkpoint
  outside the source tree, and only activates it after an explicit promotion.
* **Research keeps its receipts.** Sessions store source fingerprints and quote
  real line numbers; numeric conflicts stay unresolved rather than synthesised.
* **Reasoning is tied to measurements.** Diagnoses build hypotheses only from
  crossed thresholds and test them with real tools; untested stays untested and
  contradictory facts are kept side by side.
* **It runs on your machine.** Ollama / LM Studio / llama.cpp / any
  OpenAI-compatible endpoint you configure. No telemetry, no request leaves the
  box unless you point it somewhere.
* **It says when it does not know.** No model installed? You get the measured
  facts, labelled as such. A tool failed? The answer must mention it or
  verification flags it. STOP really stops the run.
* **Dangerous actions need a real approval.** One approval authorises one call
  with exactly the arguments you saw; replay and argument swaps are refused.
* **Memory and documents stay local** — and memory refuses secrets and text that
  looks like instructions to the assistant.
* **31 specialists, one dispatcher** — routing, planning, verification and an
  optional model audit, not a single prompt doing everything.
* **It decides before it searches.** Every question gets a brief: intent,
  strategy, risk, constraints, assumptions, completion criteria and a
  calibrated uncertainty with reasons. Vague follow-ups get a question back
  instead of a guess ([`docs/research.md`](docs/research.md)).
* **Understanding is hybrid, not hopeful** — a deterministic brief keeps
  authority; a schema-validated model pass may refine it, and a failed pass
  degrades to a labelled deterministic answer instead of a guess.
* **Plans are executed as a DAG** — typed step outputs, read-only concurrency,
  serialised writes, cancellation, approvals, budgets and one bounded replan that
  never discards completed work.
* **Knowledge is a graph** — typed relationships with provenance, bounded
  multi-hop queries and contradictory facts kept side by side.
* **Learning needs evidence** — candidates are promoted only on a live held-out
  split, with mocks rejected and regressions vetoed.
* **The model runtime respects the GPU** — idle/balanced/deep/gaming profiles,
  VRAM feasibility checks and real unloading, so a game does not fight Ollama.
* **Verification never touches your tree** — test verification runs on a full
  copy, and the original file is byte-identical afterwards.
* **Durable plans** — tasks are a validated DAG with retries, checkpoints,
  idempotency keys, pause/resume and restart reconciliation; a task interrupted
  by a crash is never silently repeated.
* **Code changes are staged, not sprayed** — a proposal is diffed, verified in an
  isolated workspace, then needs your approval before it is written, with the old
  file kept as a backup. `patch.propose` / `verify` / `apply` / `discard`.
* **It learns, cautiously** — per-strategy success is recorded and used to route
  future work, but a change is only promoted after a regression gate with enough
  samples. Candidates are never applied automatically.
* **Self-healing** — `sentinel doctor` diagnoses config, storage, ports, models
  and the ESP32 link; repairs are proposed, backed up and approval-gated.

Full detail: [`docs/assistant.md`](docs/assistant.md).

### The new interface

Home, Chat, Agents, Tools, Tasks, Memory, Knowledge, Automations, Computer,
Devices, Models, Cognition (Poznanie), Activity, Diagnostics, Settings — plus a blue orb that reflects
the real state of the run (thinking, planning, working, verifying, error) instead
of looping an animation. Answers stream token by token, code blocks are real
code blocks, and approvals appear at the top of the screen wherever you are.

---

### What 6.0 verifies, and what it does not

`npm test` runs four suites: **23** protocol/CLI checks, **35** UI checks,
**25** assistant-stack checks and **131** deep checks (semantics, executor,
isolated verification, graph, MCP, runtime profiles, held-out evaluation,
organisation, conversation state, plus the 3.0 checks). Two gates run on top:
`node scripts/eval.js` (**76/76** deterministic cases, every provider disabled)
and `node scripts/audit-tools.js` (**270** tools, **0** structural problems,
**59** executed successfully, **211** explicitly unexecuted).

Counts, measurements and the full delivery report are in
[`docs/REPORT-6.0.md`](docs/REPORT-6.0.md), [`docs/REPORT-5.0.md`](docs/REPORT-5.0.md), [`docs/REPORT-4.0.md`](docs/REPORT-4.0.md) and
[`docs/PROGRESS.md`](docs/PROGRESS.md); research and licences in
[`docs/research.md`](docs/research.md). Windows CI is green for 6.0 at `e6edd44`; no GPU was available, no live model
evaluation was run, and 211 tools remain unexecuted. Those limits are stated
there rather than glossed over.

## Download

Built by CI on every push and on every tag:

| File | Size | What it is |
| --- | --- | --- |
| [`SENTINEL-Setup-2.1.0-x64.exe`](../../releases/download/v2.1.0/SENTINEL-Setup-2.1.0-x64.exe) | ~82 MB | Windows installer: agent + desktop console + tray, optional autostart |
| [`SENTINEL-Portable-2.1.0-x64.exe`](../../releases/download/v2.1.0/SENTINEL-Portable-2.1.0-x64.exe) | ~82 MB | same app, nothing installed |
| [`SENTINEL-Agent.exe`](../../releases/download/latest/SENTINEL-Agent.exe) | ~58 MB | headless single-file agent (run at logon / as a service) |
| [`SENTINEL-android.apk`](../../releases/download/v2.1.0/SENTINEL-android.apk) | ~3 MB | phone app (sideload; the CI build signs it) |
| [`firmware.bin`](../../releases/download/v2.1.0/firmware.bin) | ~1 MB | ESP32 bridge firmware (esptool or PlatformIO) |

Everything is listed on the [releases page](../../releases).

---

## Pair a phone (the part that used to fail)

1. **Start the agent on the PC.** The console opens on `http://127.0.0.1:7878`.
   Open **Devices → Pairing** (or run `npm run pair`) to see the address and the
   pairing key.
2. **On the phone** open the app → *Pair this phone*.
   - **Address** — what the console shows, e.g. `192.168.1.50:7878` (scheme and
     port are optional; `192.168.1.50` works and the app tries port `7878` too).
   - **Pairing key** — the 64-character key. The field shows a live character
     count and turns green only when the key is the right length.
3. **Tap Connect.** You will see the handshake happen, step by step:

```
✓ Trying PC agent                     http://192.168.1.50:7878/api/tunnel
✓ Generating a one-time key pair      P-256 · nothing leaves the phone
✓ Reaching the device
✓ Checking the device identity        session 4f1c9a2d0b7e3311
✓ Securing the channel                AES-256-GCM
✓ Verifying with a live command
✓ Connected                           18 ms round trip
```

If it cannot connect, the app says **why** — wrong key, nothing at that address,
not a SENTINEL device, timeout — and offers *Test the address*, which probes the
URL and reports what actually answered. **Connect never fails silently.**

`192.168.1.1` (the ESP32) is a one-tap chip on the same screen; the app works out
by itself whether an address is a PC agent or the ESP32.

---

## No VPN

The phone and the PC share one 32-byte pairing key and nothing else. Every time
the app connects, it:

1. generates a **fresh P-256 key pair** on the phone,
2. exchanges public keys with the device, computes the shared secret,
3. derives two AES-256-GCM keys with **HKDF-SHA256**,
4. proves knowledge of the pairing key **in both directions** (HMAC over the
   handshake transcript),
5. encrypts every request and response with a **counter**, so a replayed frame
   is refused.

That is a private channel between your own two devices — no VPN client, no
third-party relay, no port forwarding, no cloud.

What it deliberately is **not**: it does not give the phone a new IP address, it
does not route other apps' traffic, and it does not punch through your router.
It authenticates and encrypts one channel between two programs that already
share a key. If you *do* want to reach the PC from outside your Wi-Fi, a
WireGuard/tailnet layout is documented in [`docs/vpn.md`](docs/vpn.md) — it is
optional, and nothing here depends on it.

The normative description, including every frame on the wire, is
[`docs/tunnel.md`](docs/tunnel.md). The same design is implemented three times
and tested against itself:

| Where | File | Crypto |
| --- | --- | --- |
| agent (Node) | `core/tunnel.js` | `node:crypto` |
| phone (browser/WebView) | `ui/transport.js` | WebCrypto |
| ESP32 | `firmware/src/tunnel.cpp`, `st_crypto.cpp` | mbedTLS |

---

## What the interface gives you

- **Control** — a live CPU ring, memory, uptime, ESP32 state, one-tap actions and
  the full command catalogue, grouped, with the dangerous ones marked.
- **Confirmation that means something** — shutdown, restart, sleep and the
  hardware relays open a sheet that explains the consequence before it runs.
- **Policy that explains itself** — a blocked action says which switch on the PC
  is off rather than failing quietly.
- **Activity** — every command and every security-relevant line, with the round
  trip time, filterable, kept across reloads.
- **Devices** — three cards: this phone's channel, the PC agent, the ESP32.
- **Settings** — how the link is protected (mode, key fingerprint, session,
  latency), the PC's policy, and honest answers about the app.
- **Installable** — the console is a PWA with a service worker, so it can live on
  the home screen next to the APK.
- **A brain that explains itself** — the agent samples CPU, memory, the ESP32
  link, failed commands and the policy clock every 15 seconds and turns them
  into plain statements with the numbers attached ("CPU 91% for five samples",
  "the ESP32 dropped four times in ten minutes"). It suggests one command; it
  never runs anything on its own.

---

## Install (Windows)

1. **PC** — either run `SENTINEL-Setup-4.0.0-x64.exe` (agent + tray + console),
   or take the whole thing in one go:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\INSTALL_SENTINEL_FULL.ps1
   ```

   The full script installs Node 22, the agent, Ollama plus the configured
   models, whisper.cpp with a model, Tesseract and autostart, then runs
   `sentinel doctor` and prints the truth about what worked. Anything optional
   that fails becomes a warning, not a broken install (`-SkipModels`,
   `-SkipSpeech`, `-SkipOcr`, `-NoAutostart` to opt out).
2. **ESP32** — flash `firmware.bin` (or `pio run -t upload`). On first boot it
   opens `SENTINEL-Setup-esp32-xxxx`; join it, open <http://192.168.4.1>, paste
   the agent address and the pairing key, save. It reboots onto your Wi-Fi as
   `192.168.1.1` unless your network hands out something else.
3. **Phone** — install `SENTINEL-android.apk`, then pair as described above.

Both devices must be on the same Wi-Fi. A phone on mobile data cannot reach
either of them.

### Linux / macOS

```bash
node bin/sentinel-agent.js --open      # same app, no packaging needed
```

The agent looks for `xdg-open` / `open`, and uses `systemctl`, `loginctl`,
`playerctl`, `pactl`, `grim`/`scrot` where available. The UI greys out anything
the machine cannot do.

---

## What it can do

- **Power** — clean shutdown (countdown + cancel), restart, sleep, lock, log out.
  Hard power/cycle/reset through the ESP32 relay when the OS is unresponsive.
- **Screen** — capture the screen, wake the display.
- **Media** — play/pause, next, previous, volume, mute.
- **Input** — type text into the focused window, press key combos (`ctrl+shift+esc`).
- **Apps** — launch or kill only what you allow-list, never arbitrary paths.
- **Macros** — chain commands into one tap ("Morning setup").
- **Live truth** — CPU, memory, uptime, ESP32 link quality, chip temperature,
  PC power state, and an activity log as it happens.
- **An assistant** — natural language in, measured answers out, with tools for
  hardware, processes, files, code, documents, Windows settings, Git, tasks,
  automations, speech, OCR and self-repair. See
  [`docs/assistant.md`](docs/assistant.md).

## What it will not do (by design)

These are deliberate refusals, not missing features:

- **No open port on the internet.** The agent binds to your LAN. Reaching it from
  outside is your choice (WireGuard, tailnet), never a built-in hole punch.
- **No arbitrary command execution.** There is no "run this shell string"
  endpoint. Scripts and apps are named in config first; unknown commands are
  rejected.
- **No keylogging and no hidden screen capture.** Screenshots are on-demand,
  logged, and visible to you.
- **No keystrokes without consent.** Typing is disabled by default (`allowInput`).
- **No unauthenticated action.** The tunnel needs the pairing key, the console
  needs its token, and the ESP32 power endpoint needs its own derived token.
- **No telemetry, no accounts, no cloud.** Nothing leaves your network.

Every command passes a policy gate (`core/policy.js`): capability switch →
confirmation → quiet hours → rate limit → audit entry.

---

## Build

CI (`.github/workflows/build.yml`) produces all deliverables:

| Job | Runner | Artifact |
| --- | --- | --- |
| `check` | ubuntu | syntax, assets, boot, crypto unit tests, UI test |
| `windows` | windows-latest | agent `.exe`, NSIS installer, portable `.exe` |
| `android` | ubuntu-latest | signed release `.apk` |
| `firmware` | ubuntu-latest | `firmware.bin` for ESP32 |

Locally:

```bash
npm install                   # dev dependencies (jsdom is used by the UI test)
npm test                      # 18 core assertions + 17 UI checks
npm run check                 # syntax, assets, boot, reference check
npm run agent                 # run the agent from source
npm run build:exe             # needs windows or wine for cross-packaging
npm run build:desktop         # electron-builder
npm run mobile:sync && (cd mobile/android && ./gradlew assembleRelease)
cd firmware && pio run -e esp32dev
```

Icons are generated from code: `python3 scripts/make-icons.py` (Pillow).

---

## Documentation

- [`docs/assistant.md`](docs/assistant.md) — the assistant: modes, agents, tools, memory, API, CLI
- [`docs/architecture.md`](docs/architecture.md) — components, data flow, why SSE
- [`docs/tunnel.md`](docs/tunnel.md) — ST1: handshake, frames, threat model
- [`docs/security.md`](docs/security.md) — threat model, keys, what each secret unlocks
- [`docs/protocol.md`](docs/protocol.md) — exact frames and signatures
- [`docs/firmware.md`](docs/firmware.md) — wiring the ESP32 to the power button
- [`docs/vpn.md`](docs/vpn.md) — optional WireGuard/tailnet layout
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — when a light stays red

## Configuration

State lives outside the install directory:

- Windows `%APPDATA%\SENTINEL\config.json` (or `%APPDATA%\sentinel-data\` when
  installed by `INSTALL_SENTINEL_FULL.ps1`)
- Linux `~/.config/sentinel/config.json`
- macOS `~/Library/Application Support/SENTINEL/config.json`

`config.json` holds the pairing key, the UI token, the policy, allow-listed apps,
scripts, macros and the assistant settings (`ai.providers`, `ai.models`,
`ai.mode`, `ai.voice`). Keep it out of backups you share. Deleting it rotates every
secret (and unpairs every device).

## License

MIT for the project. The vendored `firmware/lib/WireGuard-ESP32` is BSD-3-Clause
(see its `LICENSE`).
