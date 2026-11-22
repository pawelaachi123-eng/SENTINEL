# Security model

SENTINEL can power off a machine and type into it. It is treated as a remote
administration tool, not a toy, so every path in and out is authenticated.

## Secrets

| Secret | Where it lives | What it unlocks | Rotate with |
| --- | --- | --- | --- |
| Pairing key `psk` (32 bytes hex) | `config.json`, ESP32 NVS | ESP32 ⇄ agent link (HMAC challenge/response) | *Devices → Rotate keys* |
| Access token `uiToken` (24 bytes hex) | `config.json`, phone localStorage | HTTP API + SSE stream | *Devices → Rotate keys* |
| ESP32 power token (16 hex chars) | derived: `HMAC-SHA256(psk, "sentinel-power")[0:16]` | `GET /power` on the ESP32 | rotate the pairing key |

The power token is derived rather than stored so the phone can be given *only* the
ability to press the power button, without learning the pairing key that the agent
trusts for everything else.

## Identity proofs

- **Agent ⇄ ESP32** — the agent sends `hello` with a 16-byte nonce; the ESP32 replies
  with `HMAC(psk, "sentinel-link-v1|agentNonce|deviceNonce|deviceId")`. The agent
  checks it in constant time and answers with the mirror proof. A device that cannot
  prove the key gets `deny` and is disconnected after 8 seconds.
- **Phone ⇄ agent** — `Authorization: Bearer <uiToken>`, compared in constant time.
  Twelve failures from one address locks that address out for five minutes.
- **Signed commands** — envelopes in `core/protocol.js` carry `id, ts, nonce, cmd, args`
  and `HMAC-SHA256(psk, canonicalJSON)`. Clock skew is limited to 120 s and nonces are
  remembered for that window (replay protection). The phone uses the bearer token
  instead, because it should not hold the ESP32 key.

## Transport

The agent speaks plain HTTP inside your own network. That is a deliberate trade:
self-signed TLS on an ESP32 breaks certificate pinning across Android versions and
adds a failure mode that leaves you locked out. The compensating controls are:

1. bind to LAN/VPN only — never port-forward the agent to the internet,
2. bearer token on every API call,
3. HMAC on every ESP32 frame,
4. the UI is served read-only without a token; data requires one.

If you want TLS anyway, put the agent behind Caddy/nginx on the same host and point
the app at `https://…` — the UI accepts any origin.

## What an attacker gets

| Attacker position | Can do |
| --- | --- |
| On your Wi-Fi, no token | see that an agent exists (`/api/health`), nothing else |
| Stole the UI token | issue any *enabled* command; cannot read the pairing key |
| Stole the power token | power on/off/cycle that one PC |
| Stole the pairing key | impersonate the ESP32; can issue commands through the link |
| Has your unlocked phone | everything not locked behind the device PIN |
| Has your unlocked PC | already has the machine; can read `config.json` |

## Deliberate limits

- **No remote shell.** `script.run` executes only commands named in `config.scripts`.
- **No arbitrary path launch.** `app.launch` only accepts names from `config.apps`.
- **No file exfiltration.** `files.list` reads directory listings inside the user's home
  only, and is off by default.
- **No keylogging.** `input.type` writes into the focused window when you send it;
  nothing is captured from the keyboard.
- **No OTA on the ESP32.** Reflashing requires physical USB access.
- **No credential storage in the UI.** The phone keeps the token in `localStorage`;
  the desktop window reuses the agent's loopback URL and never exposes the token in
  a page an attacker could frame (no `X-Frame-Options` bypass: CSP blocks framing).

## Hardening checklist

- [ ] Change nothing about the LAN binding unless you have a VPN in front of it.
- [ ] Turn **off** capabilities you never use (Control → Capabilities). Typing,
      script execution and process killing are off by default — leave them off.
- [ ] Enable **Quiet hours** if the machine must never shut down overnight.
- [ ] Keep `allowAppKill` off; it is the fastest way to lose unsaved work.
- [ ] Rotate keys after lending the phone or if the ESP32 goes missing.
- [ ] Check the activity log after any unexpected action — every command is recorded
      with its source (`ui`, `macro`, `esp32`).

## Reporting

This is a personal project; there is no bug bounty. If you find a bypass, open an
issue **without** exploit details and give a week before publishing.
