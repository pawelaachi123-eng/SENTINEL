# ST1 — the SENTINEL tunnel

ST1 is the channel the phone uses to reach the PC and the ESP32 **without a VPN**.
It is not a VPN: it does not assign addresses, it does not route other traffic,
and it does not reach across the internet by itself. It is one authenticated,
forward-secret, encrypted channel between two programs that already share a
pairing key.

Implementations (all three are exercised by the test suite):

| Side | File | Primitives |
| --- | --- | --- |
| Agent | `core/tunnel.js` | `node:crypto` |
| Phone | `ui/transport.js` | WebCrypto (`crypto.subtle`) |
| ESP32 | `firmware/src/tunnel.cpp`, `firmware/src/st_crypto.cpp` | mbedTLS |

---

## 1. What is on the wire

| Step | Method | Path (agent) | Path (ESP32) | Body |
| --- | --- | --- | --- | --- |
| hello | POST | `/api/tunnel/hello` | `/t/hello` | `{v, nc, ec}` |
| open | POST | `/api/tunnel/open` | `/t/open` | `{sid, mac}` |
| traffic | POST | `/api/tunnel/msg` | `/t/msg` | `{sid, seq, ct}` |

Only `POST` is accepted. Everything is `application/json`; the ciphertext is
base64 inside JSON so the channel survives proxies, WebViews and ESP32 parsers.

## 2. Handshake

```
client                                                device
  │  nc ← random 16 bytes                                │
  │  (ec, d) ← ECDH P-256 key pair                        │
  │                                                       │
  │ ── {v:1, nc, ec} ───────────────────────────────────► │
  │                                                       │  ns ← random 16 bytes
  │                                                       │  (es, e) ← ECDH key pair
  │                                                       │  Z = e · ec
  │                                                       │  mac_s = HMAC(psk, T_s)
  │ ◄──────────── {sid, ns, es, mac, ttl} ──────────────── │
  │                                                       │
  │  check mac_s      (proves the device has the key)     │
  │  Z = d · es                                           │
  │  mac_c = HMAC(psk, T_c)                               │
  │ ── {sid, mac_c} ─────────────────────────────────────► │
  │                                                       │  check mac_c
  │                                                       │  session live
  │ ◄──────────────────── {ok:true} ───────────────────── │
```

Transcripts, byte for byte (UTF-8, `|` separated):

```
T_s = "ST1|server|" + nc + "|" + ec + "|" + ns + "|" + es
T_c = "ST1|client|" + nc + "|" + ec + "|" + ns + "|" + es
```

`nc`, `ns` are lowercase hex (32 chars). `ec`, `es` are base64 of the
**uncompressed** P-256 point (65 bytes, first byte `0x04`). `mac` is base64 of
HMAC-SHA256 (32 bytes). `psk` is the 32-byte pairing key (64 hex characters in
the config file).

Key schedule:

```
shared = X( Z )                                  // 32 bytes, big-endian
salt   = hex(nc) || hex(ns)                      // 32 bytes
okm    = HKDF-SHA256(ikm = shared, salt, info = "ST1|keys", 64 bytes)
k_c2s  = okm[0:32]                               // client → device
k_s2c  = okm[32:64]                              // device → client
```

Separate keys per direction: a bug in one direction cannot be replayed into the
other.

## 3. Frames

```json
{ "sid": "4f1c9a2d0b7e3311", "seq": 7, "ct": "<base64>" }
```

`ct` is `AES-256-GCM(key, nonce, aad, plaintext) || tag` (16-byte tag appended).

```
nonce = uint32_be(seq) || direction || 0x00 * 7     // 12 bytes
        direction: 1 = client→device, 2 = device→client
aad   = "ST1|msg|" + sid + "|" + decimal(seq)
```

The sequence number starts at `0` per direction and increases by exactly one.
A receiver accepts a frame only when `seq` is **strictly greater** than the last
accepted one; anything else is refused before decryption, which is the replay
guard. Sequence numbers are also the nonce, so a repeated `(key, nonce)` pair
cannot happen within a session.

Request plaintext:

```json
{ "id": 12, "cmd": "system.lock", "args": {} }
```

Response plaintext:

```json
{ "id": 12, "ok": true, "cmd": "system.lock", "data": { ... }, "ms": 9 }
```

or, on refusal:

```json
{ "id": 12, "ok": false, "cmd": "system.shutdown", "code": "CONFIRM_REQUIRED",
  "message": "system.shutdown needs confirmation." }
```

A poll is `{ "id": 13, "poll": true }` and returns `{ "ok": true, "events": [...] }`.

## 4. Sessions

- A session lives **15 minutes** without traffic, then the keys are zeroised.
- A session is bound to the address (`ip`) that opened it. A frame from another
  address is refused with `403` and logged as a security event.
- Half-open handshakes expire after 30 seconds and at most 32 are kept.
- Eight failed pairing proofs from one address pause that address for a minute
  (`429`).

## 5. What the phone can and cannot do

The tunnel is a transport; it is not an authority. Every command still goes
through `core/policy.js` with `source: 'tunnel'`:

- capability switches (`allowShutdown`, `allowInput`, …),
- explicit `confirm: true` for destructive commands,
- quiet hours,
- the rate limiter,
- an audit entry with the caller's address.

`agent.policy.set` refuses any source other than the local console, so a paired
phone can never widen its own permissions.

## 6. ESP32 specifics

The ESP32 runs the same handshake and frame format with two differences:

1. **Local commands** — `esp.power`, `esp.reset`, `esp.status`, `esp.identify`
   are executed on the chip, so they work when the PC is off.
2. **Relay** — anything else is forwarded to the agent over the already
   authenticated `7879` link as `{"t":"rpc","id":"…","body":"<request>"}` and the
   agent's answer is encrypted back to the phone. If the PC is not linked, the
   ESP32 answers `LINK_OFFLINE` and the app switches to hardware-only mode.

The relay inherits the agent's policy, so a relayed `system.shutdown` still needs
`confirm: true` and is still audited.

## 7. Threat model

| Attacker | Result |
| --- | --- |
| Someone on the same Wi-Fi sniffing | sees JSON envelopes and base64 ciphertext only |
| Someone replaying captured frames | refused: sequence numbers are monotonic per session |
| Someone with a recording of an old session | useless: keys are derived from ephemeral keys that no longer exist |
| Someone guessing the pairing key | 2^256 space; failed proofs are rate-limited and logged |
| Someone who steals the phone | still needs the key, which the app stores in the WebView's local storage — unpair or rotate keys |
| Someone who steals the PC config | has the key; rotate it (`/api/keys`, or delete `config.json`) |
| A malicious app on the same phone | outside this model — the key is only as safe as the device |

Not covered: an attacker who controls the PC or the phone itself, and denial of
service (someone flooding `/hello` gets rate-limited, not blocked at the network
level).

## 8. Why not just use WireGuard

WireGuard answers a different question: "reach my home network from anywhere".
ST1 answers: "let *my phone* talk to *my PC and my ESP32* on the network they are
already on". It needs no extra client, no peer keys, no handshake timing issues
on a microcontroller, and it works the moment the two share a key. When you want
the wider reach, `docs/vpn.md` shows how to put WireGuard underneath — the
tunnel keeps working unchanged on top of it.

## 9. Debugging a handshake

The phone logs every attempt in *Diagnostics*. On the agent:

```bash
SENTINEL_VERBOSE=1 node bin/sentinel-agent.js
curl -s http://127.0.0.1:7878/api/tunnel/sessions?t=<uiToken>
```

Common answers:

| Answer | Meaning |
| --- | --- |
| `403 pairing key mismatch` | the key does not match the device's `psk` |
| `404 unknown tunnel action` | that address is not a SENTINEL device |
| `404 unknown or expired handshake` | the `/hello` answer was too old (retry) |
| `401 session expired — pair again` | 15 minutes of silence; the app reconnects automatically |
| `400 frame rejected: replayed frame` | a duplicate sequence number |
| `429 too many pairing attempts` | eight bad keys from one address; wait a minute |
