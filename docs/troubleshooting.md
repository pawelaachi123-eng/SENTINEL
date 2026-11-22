# Troubleshooting

## The app cannot reach the agent

1. Is the agent running? `http://127.0.0.1:7878/api/health` on the PC itself.
2. Is the port right? Default `7878`. Check with `netstat -ano | findstr 7878`.
3. Are you on the same VPN? Ping the PC's VPN address from the phone.
4. Does the token still match? Rotating keys invalidates every stored token — reconnect
   with the new one from *Devices → Pairing*.

The UI shows *PC is offline* instead of an error when the ESP32 answers: that means the
phone can reach the bridge but the agent is stopped. Use **Power on**, then retry.

## "Port already in use" when opening the desktop app

A headless `SENTINEL-Agent.exe` (or a second copy of the app) already owns 7878. Either
close it, or just use the browser at `http://127.0.0.1:7878/`. The desktop app refuses to
start a second listener on purpose — two agents would both answer and log.

## The desktop window is blank or refuses to open

The agent is independent of the window. Open <http://127.0.0.1:7878/> in any browser on
that PC — you will get the same interface. If the window stays blank but the browser
works, the Electron shell failed to attach (usually a GPU driver issue); quit it from the
tray and use the browser, or run `SENTINEL-Agent.exe` and open the UI yourself.

## ESP32 never turns green

| Symptom | Likely cause |
| --- | --- |
| LED blinks fast forever | cannot join Wi-Fi; wrong SSID/password or a 5 GHz-only network |
| Connects, then drops every ~4 s | pairing key mismatch; re-paste it from *Devices → Pairing* |
| Agent log says `bad pairing key` | the key in the portal is for a different agent/config |
| `connecting to 10.8.0.5…` loops | the PC's firewall blocks inbound 7879 (allow private networks) |
| Works on LAN, not over VPN | the ESP32 is not a peer in the tunnel (see `docs/vpn.md`) |

Windows Firewall, once:

```powershell
New-NetFirewallRule -DisplayName "SENTINEL agent" -Direction Inbound `
  -Protocol TCP -LocalPort 7878,7879 -Action Allow -Profile Private
```

## Relay does nothing

- Measure across the two wires with a multimeter: you should see the opto conduct for
  ~600 ms. If not, check pin numbers in the portal and that the ESP32 is not in setup mode.
- Some boards cannot source enough current through the 3.3 V pin for a relay coil; use an
  opto-isolator or a transistor.
- The PC ignores a very short press: raise *hold* in the app (600 → 1000 ms) or use
  `curl 'http://<esp>/power?action=on&hold=1200&t=<token>'`.

## "PC sense" shows `—`

Sensing is disabled in the portal or the divider is not wired. Without it, *power cycle*
only pulses once (it cannot tell whether the machine was on).

## Screenshot is black

- Windows: a locked or sleeping session cannot be captured; unlock first.
- Linux Wayland: install `grim`; X11: `scrot` or ImageMagick `import`.
- macOS: grant *Screen Recording* to the app in System Settings → Privacy.

## Typing does nothing

Check *Control → Capabilities → Keyboard input*. On Windows the window that receives the
keystrokes must be focused (the agent does not raise windows). On Linux `xdotool` is
required; on Wayland most compositors refuse synthetic input by design.

## Media keys or volume do nothing

Linux needs `playerctl` and `pactl` (`pulseaudio-utils`) or `amixer`. The UI greys out
what it could not find at startup.

## Commands are refused with `QUIET_HOURS`

Quiet hours are on and it is inside the window. `Cancel shutdown` and `system.info` stay
allowed on purpose; toggle quiet hours in *Settings → Safety*.

## "Rate limited"

40 commands per minute per client by default (Settings → Safety). Macros count per step.

## The APK will not install

Android refuses an APK signed by a different key than the installed copy. Uninstall the
old SENTINEL first, then install the new `SENTINEL-android.apk`. Also allow
"Install unknown apps" for your browser/file manager.

## Rotating keys locked me out of everything

Expected: the pairing key and the UI token both change. Open the app on the PC, copy the
new token from *Devices → Pairing*, re-pair the ESP32 in its portal, reconnect the phone.
If you have lost the desktop app too, read `config.json` from
`%APPDATA%\SENTINEL\config.json` (`uiToken`) and open `http://127.0.0.1:7878/?t=<token>`.

## Start over

Quit SENTINEL, delete the state folder (`%APPDATA%\SENTINEL`, `~/.config/sentinel` or
`~/Library/Application Support/SENTINEL`), start it again. New keys are generated; every
device must be paired again.
