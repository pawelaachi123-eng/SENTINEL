// ============================================================================
//  SENTINEL ESP32 bridge — compile-time defaults
//  Everything here can also be set at runtime through the setup portal
//  (hold BOOT while resetting, or first boot with no Wi-Fi saved).
// ============================================================================
#pragma once

#ifndef SENTINEL_FW_VERSION
#define SENTINEL_FW_VERSION "2.1.0"
#endif

// WireGuard is used when your phone reaches the house through your own tunnel.
// The ESP32 joins the same tunnel as a peer so the agent can see it on the
// VPN address instead of a LAN address.
#ifndef SENTINEL_USE_WIREGUARD
#define SENTINEL_USE_WIREGUARD 1
#endif

// ── Pins ────────────────────────────────────────────────────────────────────
#define PIN_LED 2            // onboard LED, heartbeat
#define PIN_POWER_BTN 25     // opto/relay across the PC power button
#define PIN_RESET_BTN 26     // opto/relay across the PC reset button
#define PIN_PC_SENSE 34      // input-only pin: 3.3 V when the PC power LED is on
#define RELAY_ACTIVE_LEVEL HIGH
#define PIN_BOOT_BUTTON 0    // hold at boot for 2 s → setup portal

// ── Defaults (overridable in the portal, stored in NVS) ─────────────────────
#define DEFAULT_AGENT_PORT 7879
#define DEFAULT_HTTP_PORT 80
#define DEFAULT_RELAY_HOLD_MS 600
#define DEFAULT_SENSE_ENABLED true
#define WIFI_CONNECT_TIMEOUT_MS 20000
#define AGENT_RECONNECT_MS 4000
#define STATE_INTERVAL_MS 5000
#define PORTAL_TIMEOUT_MS (10UL * 60UL * 1000UL)

// ── Setup portal ────────────────────────────────────────────────────────────
#define PORTAL_SSID_PREFIX "SENTINEL-Setup-"
