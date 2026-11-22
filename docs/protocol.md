# Protocol

Two channels, one key.

## 1. Phone ⇄ agent (HTTP + SSE)

Base: `http://<pc>:7878`

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | discovery: `{ok, app, name, version}` |
| GET | `/api/status` | token | full snapshot (system, policy, ESP32, catalogue) |
| POST | `/api/command` | token | `{cmd, args}` → `{ok, data}` |
| GET | `/api/events` | `?t=` | SSE: `log`, `status`, `esp`, `policy` events |
| GET | `/api/pairing` | token | pairing block, tokens, ESP32 URLs |
| POST | `/api/policy` | token | `{patch:{allowInput:true}}` |
| POST | `/api/keys` | token + `confirm:true` | rotate pairing key and UI token |
| GET/POST | `/api/macros` | token | list / save macros |
| DELETE | `/api/macros/:name` | token | delete |
| POST | `/api/apps`, DELETE `/api/apps/:name` | token | allow-list management |
| POST | `/api/settings` | token | display name |

Auth: `Authorization: Bearer <uiToken>`, `X-Sentinel-Token`, or `?t=<uiToken>`.
Token comparison is constant time; 12 failures from one address → 5 minute lockout.

Command response is always HTTP 200 with an envelope so the UI can show a precise
reason:

```json
{"ok": false, "cmd": "system.shutdown", "code": "CONFIRM_REQUIRED",
 "message": "system.shutdown needs confirmation. Re-send with confirm: true from the UI."}
```

Error codes: `UNAUTHORISED`, `POLICY_DENIED`, `CONFIRM_REQUIRED`, `QUIET_HOURS`,
`RATE_LIMITED`, `UNKNOWN_COMMAND`, `LINK_OFFLINE`, `TIMEOUT`, `COMMAND_FAILED`,
`NOT_ALLOWED`, `UNSUPPORTED`, `BAD_ARGS`.

## 2. ESP32 ⇄ agent (TCP 7879, newline-delimited JSON)

Plain text frames, one JSON object per line, `\n` terminated, max 64 KiB buffered.

### Handshake

```
agent → device  {"t":"hello","v":1,"agent":"STUDIO-PC","nonce":"<32 hex>"}
device → agent  {"t":"auth","deviceId":"esp32-1a2b","nonce":"<32 hex>",
                 "sig":"HMAC(psk, 'sentinel-link-v1|agentNonce|deviceNonce|deviceId')"}
agent → device  {"t":"welcome","sig":"HMAC(psk, 'sentinel-link-v1|deviceNonce|agentNonce|deviceId')"}
```

Both proofs are HMAC-SHA256 with the pairing key **decoded from hex** (32 raw bytes) and
compared in constant time. 8 seconds to authenticate or the socket is dropped. A device
without the key gets `{"t":"deny","reason":"bad-key"}`.

### Steady state

```
device → agent  {"t":"state","device":"esp32-1a2b","fw":"2.0.0","pc":"on","rssi":-54,
                 "temp":42.5,"up":86400,"wg":true,"ip":"10.8.0.7",
                 "gpio":{"power":0,"reset":0,"sense":1}}      every 5 s
agent  → device {"t":"ping"}                                  every 15 s
device → agent  {"t":"pong"}
agent  → device {"t":"cmd","id":"<uuid>","cmd":"power","args":{"action":"cycle","holdMs":600}}
device → agent  {"t":"res","id":"<uuid>","ok":true,"data":{"action":"cycle","pc":"off"}}
device → agent  {"t":"log","level":"info","msg":"relay pulse"}
```

Commands over the link: `power` (`on|off|cycle`), `reset`, `status`, `identify`
(blink), `reboot`. Anything else returns `UNKNOWN_COMMAND`.

## 3. ESP32 standalone HTTP (port 80)

Used when the PC is off and the agent cannot run.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | none | tiny power page |
| GET | `/status` | none | `{device, fw, pc, rssi, temp, up, wg, ip, gpio}` |
| GET | `/power?action=on\|off\|cycle\|reset&t=<token>` | power token | relay pulse |

The power token is `hex(HMAC-SHA256(pskBytes, "sentinel-power"))[0:16]` — derived, not stored,
so the phone can be granted "press the power button" without the key that the agent trusts.

CORS is `*` on all ESP32 responses so the Android WebView can call it directly.

## 4. Signed envelopes (optional, for third-party clients)

`core/protocol.js` also implements the envelope used when a client holds the pairing key
rather than the UI token:

```json
{"v":1,"id":"<uuid>","ts":1730000000,"nonce":"<24 hex>","from":"phone",
 "cmd":"system.lock","args":{},"sig":"<hmac>"}
```

- canonical string = stable JSON of `{v,id,ts,nonce,from,cmd,args}` with sorted keys
- `sig = HMAC-SHA256(pskBytes, canonicalString)`
- `ts` must be within 120 s of the agent's clock
- `nonce` is remembered for 120 s (replay rejected with `REPLAY`)
- optional `exp` (unix seconds) shortens the life of a one-off command
