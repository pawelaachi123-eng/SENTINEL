# SENTINEL 2.1

**Control your own PC from your phone over a direct encrypted channel — no VPN, no account, no cloud.**

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

---

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

---

## Install (Windows)

1. **PC** — run `SENTINEL-Setup-2.1.0-x64.exe`. It starts the agent, opens the
   console, and keeps running in the tray. Tick *Start with Windows* so it is
   always listening.
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
| `check` | ubuntu | syntax, assets, boot, crypto unit tests, 17-step UI test |
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

- [`docs/architecture.md`](docs/architecture.md) — components, data flow, why SSE
- [`docs/tunnel.md`](docs/tunnel.md) — ST1: handshake, frames, threat model
- [`docs/security.md`](docs/security.md) — threat model, keys, what each secret unlocks
- [`docs/protocol.md`](docs/protocol.md) — exact frames and signatures
- [`docs/firmware.md`](docs/firmware.md) — wiring the ESP32 to the power button
- [`docs/vpn.md`](docs/vpn.md) — optional WireGuard/tailnet layout
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — when a light stays red

## Configuration

State lives outside the install directory:

- Windows `%APPDATA%\SENTINEL\config.json`
- Linux `~/.config/sentinel/config.json`
- macOS `~/Library/Application Support/SENTINEL/config.json`

`config.json` holds the pairing key, the UI token, the policy, allow-listed apps,
scripts and macros. Keep it out of backups you share. Deleting it rotates every
secret (and unpairs every device).

## License

MIT for the project. The vendored `firmware/lib/WireGuard-ESP32` is BSD-3-Clause
(see its `LICENSE`).
