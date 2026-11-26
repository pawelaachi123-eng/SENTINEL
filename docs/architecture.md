# Architecture

## Components

```
core/                     the agent — the only thing with authority over the PC
├── agent.js              wiring of config + log + link + http + executor
├── config.js             secrets, policy, allow-lists (atomic writes, 0600)
├── protocol.js           HMAC envelopes, canonical JSON, replay guard
├── policy.js             capability gate, quiet hours, rate limiter
├── commands.js           command catalogue + handlers + audit
├── platform.js           per-OS implementations (win32 / linux / darwin)
├── runner.js             process spawning with timeouts, no shell interpolation
├── link.js               ESP32 transport: TCP server + optional USB serial
├── httpd.js              static UI, JSON API, SSE stream, CORS, token auth
├── log.js                ring buffer + append-only file + event emitter
├── stats.js              CPU sampling (cputime deltas, not loadavg)
└── paths.js              per-OS state directory, UI discovery

ui/                       one control surface, zero build step
├── index.html            shell, inline SVG icon sprite
├── styles.css            design system (dark instrument panel)
└── app.js                state, transport, views, palette, hold-to-confirm

desktop/                  Electron shell  → Windows .exe
mobile/                   Capacitor shell → Android .apk
firmware/                 ESP32 bridge  → firmware.bin
```

The desktop window **loads `http://127.0.0.1:<port>/?t=<token>`**, i.e. it is a
frame around the agent's own UI. The phone loads the same files from the agent. This
is why there is exactly one UI to maintain, and why a feature added once works on
both.

## The tunnel layer

`core/tunnel.js` sits between the phone and the command executor. It owns an
ephemeral ECDH handshake, per-session AES-256-GCM state and the sequence-number
replay guard, and it calls `Commander.execute()` exactly like the HTTP API does —
so policy, rate limits and the audit log apply identically no matter how a
command arrives.

```
phone ─┐                        ┌─► /api/command (token) ─┐
       ├─ ST1 ─► core/tunnel ───┤                          ├─► Commander ─► policy ─► platform
ESP32 ─┘                        └─► /api/tunnel/msg ──────┘
```

The ESP32 speaks the same protocol on `/t/*` and relays anything it cannot do
itself over the authenticated `7879` link, which keeps one code path for
commands and one place for policy.

## The advisory layer (`core/brain.js`)

The agent samples itself every 15 seconds and runs a short list of explicit
rules. Each rule either returns nothing or returns a statement with the numbers
that produced it:

```
"CPU has been pinned for a while"
  91% average over the last 5 samples (AMD Ryzen 7 5800X)
```

The rules cover sustained CPU, memory pressure, ESP32 link flapping, a device
presenting the wrong key, repeated command failures, quiet hours approaching and
a scheduled shutdown that can still be cancelled.

It is deliberately not an autonomous agent: **it never executes anything**. An
insight may carry one suggested command, and a person taps it. Insights have
cooldowns (a condition cannot nag), disappear when the condition clears, and can
be dismissed for 30 minutes.

Because the module takes snapshots and a clock as arguments, the rules are
unit-tested without a PC, a phone or a network (`test/run.js`). The same list is
attached to `system.snapshot`, so the phone gets it over the tunnel in the same
round trip that renders the rest of the screen.

## Why these choices

**SSE instead of WebSocket.** The live feed is one-directional (log lines, 2-second
telemetry). `EventSource` reconnects on its own, needs no heartbeat protocol, works in
every Android WebView, and lets the agent keep **zero runtime npm dependencies** — which
is what makes a single-file `.exe` possible and keeps the attack surface small.

**No framework in the UI.** A 3-file SPA loads instantly over a VPN link, needs no
bundler in CI, and cannot break because of a toolchain upgrade in two years.

**Policy in the agent, not the UI.** The phone and the ESP32 both call the same gate.
Hiding a button is a convenience; the refusal happens on the PC.

**Per-platform modules.** Windows, Linux and macOS differ in *how* you lock a screen, not
*what* locking means. The command layer is shared; only `platform.js` branches, and it
probes which binaries exist so the UI can grey out impossible actions.

## Request flow

```
phone tap
  → POST /api/command {cmd:"system.shutdown", args:{confirm:true}}
      → token check (constant time, 12 bad tries = 5 min lockout)
      → Commander.execute()
          → policy.check()      capability on? confirm present? quiet hours?
          → RateLimiter.allow() 40/min per source
          → handler → platform.shutdown(30)
          → ActivityLog.info()  → SSE broadcast to every open client
      → {ok:true, data:{scheduledInSec:30}}
```

ESP32 flow:

```
agent cmd frame ──► ESP32 relay pulse ──► PC power button
      ▲                    │
      └── res frame ◄──────┘   (8 s deadline, else LINK_TIMEOUT)
```

## Failure behaviour

| Failure | What happens |
| --- | --- |
| Phone loses VPN | UI shows a banner, EventSource retries every 3 s, no commands are queued |
| Agent stopped, ESP32 up | phone falls back to the ESP32 power panel (`/status`, `/power`) |
| ESP32 unplugged | the agent keeps serving the UI; relay buttons report *ESP32 is not connected* |
| Wi-Fi down on ESP32 | it keeps the last state, retries every 4 s, LED blinks slowly |
| Port 7878 taken | the desktop app detects it and explains instead of showing a blank window |
| Wrong token | 401 → UI returns to the connect screen with an explanation |
| Clock drift > 120 s | signed envelopes with a bad timestamp are rejected with `STALE` |

## Data at rest

`config.json` (mode 0600) is the single source of truth. Writes are atomic
(temp file + rename) so a power loss cannot corrupt the pairing key. Logs go to
`logs/agent.log`, rotated by size by the OS/your tooling — they contain command names
and timings, never keystrokes or screen content.
