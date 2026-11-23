# ESP32 bridge: wiring, flashing, provisioning

The ESP32 is the only part of SENTINEL that touches hardware. It is also the part
that can still work when the PC is off — which is the whole point.

## Parts

| Part | Note |
| --- | --- |
| ESP32 DevKit (or S3/C3 — change the board line) | powered from the PC's USB port so it is always on with the PC's PSU |
| 2 × opto-isolator (PC817) or 2 × relay module | power button, reset button |
| 1 × 10 kΩ + 2 × 4.7 kΩ resistors | divider for the power-LED sense wire (12 V → 3.3 V) |
| Dupont wires | you will cut nothing: the opto sits *across* the front-panel header |

> **Use opto-isolators, not bare relays, for the buttons.** The power-switch line
> carries the PSU's standby rail; isolating it protects both the ESP32 and the board.
> A relay module is fine for a bench test, not for the final install.

## Wiring

```
PC front-panel header            ESP32
─────────────────────            ─────────────────────────────
POWER+  ──► PC817 pin 1          GPIO25 ──► 220Ω ──► PC817 pin 2 (+ 10kΩ to GND)
POWER-  ──► PC817 pin 4          GPIO GND ◄── PC817 pin 3
RESET+  ──► PC817 pin 1          GPIO26 ──► 220Ω ──► PC817 pin 2 (+ 10kΩ to GND)
RESET-  ──► PC817 pin 4          GPIO GND ◄── PC817 pin 3
PWR LED 12V ──► 10kΩ ──► GPIO34 ──► 4.7kΩ ──► GND     (sense: PC is on)
GND ────────────────────────────  GND
5V  ────────────────────────────  VIN/5V (from a USB header or the PC's 5V rail)
```

Pin defaults live in `firmware/src/config.h` and can be changed in the setup portal:

| Setting | Default | Meaning |
| --- | --- | --- |
| `PIN_POWER_BTN` | 25 | pulse = short press of the power button |
| `PIN_RESET_BTN` | 26 | pulse = short press of reset |
| `PIN_PC_SENSE` | 34 | HIGH when the PC's power LED is lit (input-only pin) |
| `PIN_LED` | 2 | onboard LED: fast blink = searching, steady-ish = linked |

If you do not wire the sense line, set sensing off in the portal; the UI then shows
*PC sense: —* instead of guessing.

## Flash

```bash
cd firmware
pio run -e esp32dev            # build
pio run -e esp32dev -t upload  # flash over USB
pio device monitor -b 115200   # logs, including the power token
```

`esp32dev-nowg` builds without WireGuard (smaller, plain Wi-Fi only).
`esp32s3` targets the S3 devkit.

## Provision

**First boot, or hold BOOT while resetting** → the board opens a Wi-Fi hotspot
`SENTINEL-Setup-esp32-xxxx`:

1. join it on your phone,
2. open <http://192.168.4.1>,
3. paste the values from the agent: *Devices → Pairing* (agent IP, port 7879, pairing key),
4. optionally fill the WireGuard section so the board joins your tunnel,
5. save. It reboots onto your network, links to the agent, and the *Devices* page
   turns **linked**.

### Pairing over the setup network

The ESP32 also answers the encrypted tunnel while it is in setup mode, so a phone
can pair with it at `192.168.4.1` before any Wi-Fi is configured — and then pair
with the PC once it joins your network. The endpoints are the same `/t/hello`,
`/t/open`, `/t/msg` described in [`tunnel.md`](tunnel.md).

The portal stays open for 10 minutes in setup mode only; there is no always-on
configuration endpoint. Re-entering it always requires physical access (BOOT button).

## What the firmware refuses to do

- No OTA updates — reflashing needs USB.
- No arbitrary GPIO control from the network.
- No command is executed over the link until the challenge/response succeeds.
- The HTTP power endpoint exists, but only for `power`/`reset`, and only with the
  derived power token.
- No cloud, no telemetry, no MQTT broker, no hard-coded credentials.

## Behaviour details

- **Power cycle**: pulse, wait 4 s, pulse again — only if the sense line says the PC is
  on; otherwise a single pulse (that is the "power on" case).
- **Latency**: the agent's link deadline is 8 s, which covers a 5 s cycle.
- **Reconnect**: Wi-Fi is retried every 10 s, the agent link every 4 s, forever.
- **Watchdog**: the Arduino loop task is fed by the core; a hung TCP write cannot block
  the relays because pulses are bounded (100–5000 ms).
