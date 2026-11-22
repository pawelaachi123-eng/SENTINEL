# SENTINEL 2.0

**Control your PC from your phone, through your own VPN, with an ESP32 as the hands.**

```
  ┌──────────┐   your WireGuard / tailnet    ┌─────────────┐   TCP 7879 (HMAC)   ┌──────────────┐
  │  phone   │ ────────────────────────────► │    ESP32    │ ◄──────────────────►│  PC agent    │
  │  (APK)   │   HTTP 7878 + SSE, token      │  bridge     │                     │  (exe)       │
  └──────────┘                               │  relay/GPIO │                     └──────┬───────┘
        │                                    └──────┬──────┘                            │
        │  fallback: /power?t=…  (PC is off)         │  power + reset buttons            │ policy,
        └───────────────────────────────────────────┴──────────────────────────────────►│ rate limit,
                                                                                        │ audit log
```

Two independent paths, because the important case is *the PC is already off*:

| Situation | Path | What still works |
| --- | --- | --- |
| PC running, agent up | phone → agent API (VPN) | everything: shutdown, lock, screenshot, typing, macros |
| PC running, direct ESP32 | phone → ESP32 → agent link | power, reset, PC state |
| PC off / agent down | phone → ESP32 HTTP | **power on**, power cycle, reset |

---

## What this is

The repository started as a single-line `# SENTINEL` README. This is a full rebuild:
a PC agent, a desktop app, an Android app and ESP32 firmware that share one
protocol and one interface. **There is no `arduino.exe`, no Arduino IDE project and
no `.ino` sketch** — the firmware is a PlatformIO project with pinned dependencies
and a vendored WireGuard library, so a build is reproducible.

| Piece | Path | Output |
| --- | --- | --- |
| Agent (authority over the PC) | `core/`, `bin/` | `SENTINEL-Agent.exe` (single file) |
| Desktop console | `desktop/`, `ui/` | `SENTINEL-Setup-2.0.0-x64.exe`, `SENTINEL-Portable-2.0.0-x64.exe` |
| Android app | `mobile/` (Capacitor) | `SENTINEL-android.apk` |
| ESP32 bridge | `firmware/` (PlatformIO) | `firmware.bin` |
| Control surface | `ui/` | served by the agent, bundled in both apps |

The **same** `ui/` folder is what you see in the desktop window and on the phone.
No second implementation to drift.

---

## Install (Windows)

1. **PC** — run `SENTINEL-Setup-2.0.0-x64.exe`. It starts the agent, opens the
   console and keeps running in the tray. Tick *Start with Windows* in the tray menu
   so it is always listening.
2. **Pair the ESP32** — in the app: *Devices → Pairing*. Copy the snippet, then:
   - flash the board (`firmware.bin` from the release, or `pio run -t upload`),
   - on first boot the ESP32 opens a Wi-Fi hotspot `SENTINEL-Setup-esp32-xxxx`;
     join it, open <http://192.168.4.1>, paste the values, save. It reboots onto your
     Wi-Fi/VPN and the *Devices* page turns green.
3. **Phone** — install `SENTINEL-android.apk`. Enter the agent address from
   *Settings → Connection* (`http://<pc-ip>:7878`) plus the access token, and
   optionally the ESP32 address + power token so the phone can switch the PC on
   while the agent is stopped.

Everything else (macros, allow-listed apps, capability switches) is edited in the UI.

### Linux / macOS

```bash
node bin/sentinel-agent.js --open      # same app, no packaging needed
```

The agent looks for `xdg-open` / `open`, and uses `systemctl`, `loginctl`,
`playerctl`, `pactl`, `grim`/`scrot` where available. The UI greys out anything the
machine cannot do.

---

## What it can do

- **Power** — clean shutdown (with countdown + cancel), restart, sleep, lock, log out.
  Hard power/cycle/reset through the ESP32 relay when the OS is unresponsive.
- **Screen** — capture the screen, wake the display.
- **Media** — play/pause, next, previous, volume, mute.
- **Input** — type text into the focused window, press key combos (`ctrl+shift+esc`).
- **Apps** — launch or kill only what you allow-list, never arbitrary paths.
- **Macros** — chain commands into one tap ("Morning setup").
- **Live truth** — CPU, memory, uptime, ESP32 link quality, chip temperature,
  PC power state, and an activity log streamed as it happens.

## What it will not do (by design)

These are deliberate refusals, not missing features:

- **No open port on the internet.** The agent binds to your LAN/VPN. Exposing it is
  your job (VPN, tailnet, reverse proxy) — not a built-in hole punch.
- **No arbitrary command execution.** There is no "run this shell string" endpoint.
  Scripts and apps are named in config first. Unknown commands are rejected.
- **No keylogging and no hidden screen capture.** Screenshots are on-demand, logged,
  and visible to you; stdin/stdout of other programs is never read.
- **No keystrokes without consent.** Typing is disabled by default (`allowInput`).
- **No unauthenticated action.** UI needs a 48-character token, the ESP32 link needs
  the pairing key, and the ESP32 power endpoint needs its own derived token.
- **No telemetry, no accounts, no cloud.** Nothing leaves your network. No analytics,
  no DNS calls to us.

Every command passes a policy gate (`core/policy.js`): capability switch → confirmation
→ rate limit → audit entry. Quiet hours can block power actions overnight.

---

## Build

CI (`.github/workflows/build.yml`) produces all three deliverables:

| Job | Runner | Artifact |
| --- | --- | --- |
| `check` | ubuntu | syntax, asset and boot tests |
| `windows` | windows-latest | agent `.exe`, NSIS installer, portable `.exe` |
| `android` | ubuntu-latest | signed release `.apk` |
| `firmware` | ubuntu-latest | `firmware.bin` for ESP32 |

Locally:

```bash
npm run check                 # boot + security behaviour tests
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
- [`docs/security.md`](docs/security.md) — threat model, keys, what each secret unlocks
- [`docs/protocol.md`](docs/protocol.md) — exact frames and signatures
- [`docs/firmware.md`](docs/firmware.md) — wiring the ESP32 to the power button
- [`docs/vpn.md`](docs/vpn.md) — WireGuard/tailnet layout for phone + ESP32
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
