// ============================================================================
//  SENTINEL ESP32 bridge
//
//  The ESP32 sits next to the PC, powered from its USB port, and is the
//  hardware arm of the system:
//
//    • it joins your own WireGuard tunnel (or plain Wi-Fi) so your phone can
//      reach the house even when the PC is off
//    • it dials the SENTINEL agent on TCP 7879 and authenticates with a
//      challenge/response derived from the pairing key
//    • it listens on port 80 for a token-protected power call, which is the
//      only way to switch the PC on when the agent itself is not running
//    • it drives the power/reset buttons through opto-isolators or relays
//    • it reports link quality, chip temperature and PC state to the agent
//
//  Security posture: no command is accepted from the network without either
//  the pairing key (agent link) or the power token (HTTP). There is no shell,
//  no OTA and no arbitrary GPIO access exposed to the network.
// ============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mbedtls/md.h>
#include "config.h"

#if SENTINEL_USE_WIREGUARD
#include <WireGuard-ESP32.h>
static WireGuard wg;
#endif

// ── State ───────────────────────────────────────────────────────────────────
struct Settings {
  String ssid;
  String pass;
  String agentHost;
  String psk;
  String deviceId;
  uint16_t agentPort = DEFAULT_AGENT_PORT;
  int powerPin = PIN_POWER_BTN;
  int resetPin = PIN_RESET_BTN;
  int sensePin = PIN_PC_SENSE;
  bool senseEnabled = DEFAULT_SENSE_ENABLED;
  bool useWireGuard = false;
  String wgAddress;
  String wgPrivate;
  String wgPeerPublic;
  String wgEndpoint;
  uint16_t wgPort = 51820;
};

enum LinkState { LINK_DOWN, LINK_WAIT_HELLO, LINK_WAIT_WELCOME, LINK_UP };

static Settings cfg;
static Preferences prefs;
static WebServer http(DEFAULT_HTTP_PORT);
static WiFiClient agent;
static LinkState linkState = LINK_DOWN;
static String agentNonce;
static String deviceNonce;
static String receiveBuffer;
static uint32_t lastConnectAttempt = 0;
static uint32_t lastStateSent = 0;
static uint32_t lastLedToggle = 0;
static uint32_t bootMillis = 0;
static bool portalMode = false;
static bool ledOn = false;
static bool wifiUp = false;

// ── Small helpers ───────────────────────────────────────────────────────────
static String hexFromBytes(const uint8_t *data, size_t len) {
  static const char *digits = "0123456789abcdef";
  String out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out += digits[(data[i] >> 4) & 0x0F];
    out += digits[data[i] & 0x0F];
  }
  return out;
}

static String randomHex(size_t bytes) {
  String out;
  out.reserve(bytes * 2);
  for (size_t i = 0; i < bytes; i++) {
    char buf[3];
    snprintf(buf, sizeof(buf), "%02x", (unsigned)(esp_random() & 0xFF));
    out += buf;
  }
  return out;
}

/** Decode the hex pairing key exactly the way the agent does (Buffer.from(psk,'hex')). */
static size_t pskBytes(uint8_t *out, size_t maxLen) {
  size_t len = 0;
  for (size_t i = 0; i + 1 < cfg.psk.length() && len < maxLen; i += 2) {
    char pair[3] = {cfg.psk[i], cfg.psk[i + 1], 0};
    out[len++] = (uint8_t)strtoul(pair, nullptr, 16);
  }
  return len;
}

static String hmacHex(const String &message) {
  uint8_t key[64];
  size_t keyLen = pskBytes(key, sizeof(key));
  uint8_t digest[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_setup(&ctx, info, 1);
  mbedtls_md_hmac_starts(&ctx, key, keyLen);
  mbedtls_md_hmac_update(&ctx, (const unsigned char *)message.c_str(), message.length());
  mbedtls_md_hmac_finish(&ctx, digest);
  mbedtls_md_free(&ctx);
  return hexFromBytes(digest, sizeof(digest));
}

static bool constantTimeEquals(const String &a, const String &b) {
  if (a.length() != b.length()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

/** Token for the unauthenticated-HTTP power endpoint. Mirrors the agent's view. */
static String powerToken() { return hmacHex("sentinel-power").substring(0, 16); }

static void setLed(bool on) {
  ledOn = on;
  digitalWrite(PIN_LED, on ? HIGH : LOW);
}

static void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    setLed(true);
    delay(ms);
    setLed(false);
    delay(ms);
  }
}

// ── Settings persistence ────────────────────────────────────────────────────
static void defaultDeviceId() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[24];
  snprintf(buf, sizeof(buf), "esp32-%04x", (unsigned)(mac & 0xFFFF));
  cfg.deviceId = String(buf);
}

static void loadSettings() {
  prefs.begin("sentinel", false);
  cfg.ssid = prefs.getString("ssid", "");
  cfg.pass = prefs.getString("pass", "");
  cfg.agentHost = prefs.getString("host", "");
  cfg.agentPort = prefs.getUShort("port", DEFAULT_AGENT_PORT);
  cfg.psk = prefs.getString("psk", "");
  cfg.deviceId = prefs.getString("id", "");
  cfg.powerPin = prefs.getInt("ppin", PIN_POWER_BTN);
  cfg.resetPin = prefs.getInt("rpin", PIN_RESET_BTN);
  cfg.sensePin = prefs.getInt("spin", PIN_PC_SENSE);
  cfg.senseEnabled = prefs.getBool("sense", DEFAULT_SENSE_ENABLED);
  cfg.useWireGuard = prefs.getBool("wg", false);
  cfg.wgAddress = prefs.getString("wga", "");
  cfg.wgPrivate = prefs.getString("wgk", "");
  cfg.wgPeerPublic = prefs.getString("wgp", "");
  cfg.wgEndpoint = prefs.getString("wge", "");
  cfg.wgPort = prefs.getUShort("wgport", 51820);
  prefs.end();
  if (cfg.deviceId.length() == 0) defaultDeviceId();
}

static void saveSettings() {
  prefs.begin("sentinel", false);
  prefs.putString("ssid", cfg.ssid);
  prefs.putString("pass", cfg.pass);
  prefs.putString("host", cfg.agentHost);
  prefs.putUShort("port", cfg.agentPort);
  prefs.putString("psk", cfg.psk);
  prefs.putString("id", cfg.deviceId);
  prefs.putInt("ppin", cfg.powerPin);
  prefs.putInt("rpin", cfg.resetPin);
  prefs.putInt("spin", cfg.sensePin);
  prefs.putBool("sense", cfg.senseEnabled);
  prefs.putBool("wg", cfg.useWireGuard);
  prefs.putString("wga", cfg.wgAddress);
  prefs.putString("wgk", cfg.wgPrivate);
  prefs.putString("wgp", cfg.wgPeerPublic);
  prefs.putString("wge", cfg.wgEndpoint);
  prefs.putUShort("wgport", cfg.wgPort);
  prefs.end();
}

// ── Relay / power ───────────────────────────────────────────────────────────
static void relayWrite(int pin, bool active) {
  int level = active ? RELAY_ACTIVE_LEVEL : (RELAY_ACTIVE_LEVEL == HIGH ? LOW : HIGH);
  digitalWrite(pin, level);
}

static void relayPulse(int pin, uint32_t holdMs) {
  relayWrite(pin, true);
  delay(holdMs);
  relayWrite(pin, false);
}

/** PC state from the power-LED sense wire, if one is connected. */
static String pcState() {
  if (!cfg.senseEnabled || cfg.sensePin < 0) return "unknown";
  return digitalRead(cfg.sensePin) == HIGH ? "on" : "off";
}

// ── JSON state ──────────────────────────────────────────────────────────────
static void writeState(JsonObject obj) {
  obj["device"] = cfg.deviceId;
  obj["fw"] = SENTINEL_FW_VERSION;
  obj["pc"] = pcState();
  obj["rssi"] = wifiUp ? WiFi.RSSI() : 0;
  obj["temp"] = temperatureRead();
  obj["up"] = (millis() - bootMillis) / 1000;
  obj["wg"] = cfg.useWireGuard &&
#if SENTINEL_USE_WIREGUARD
              wg.is_initialized();
#else
              false;
#endif
  obj["ip"] = wifiUp ? WiFi.localIP().toString() : String("0.0.0.0");
  JsonObject gpio = obj["gpio"].to<JsonObject>();
  gpio["power"] = digitalRead(cfg.powerPin);
  gpio["reset"] = digitalRead(cfg.resetPin);
  gpio["sense"] = cfg.senseEnabled ? digitalRead(cfg.sensePin) : -1;
}

static String stateJson() {
  JsonDocument doc;
  writeState(doc.to<JsonObject>());
  String out;
  serializeJson(doc, out);
  return out;
}

// ── Setup portal ────────────────────────────────────────────────────────────
static const char PORTAL_HTML[] PROGMEM = R"HTML(<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>SENTINEL setup</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#070b12;color:#e8eefb;padding:22px}
.wrap{max-width:460px;margin:0 auto}
h1{font-size:20px;letter-spacing:.2em;margin:0 0 4px}
p.sub{color:#8fa1bb;font-size:13px;margin:0 0 20px}
fieldset{border:1px solid #1e2a3d;border-radius:14px;padding:16px;margin:0 0 14px}
legend{color:#3ce0ff;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:0 6px}
label{display:block;font-size:12px;color:#8fa1bb;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #24334a;background:#0b1119;color:#e8eefb;font:inherit}
input[type=checkbox]{width:auto}
button{width:100%;padding:13px;border:0;border-radius:11px;font:inherit;font-weight:650;background:linear-gradient(135deg,#3ce0ff,#8b7bff);color:#04121a;margin-top:8px}
.hint{color:#6b7c96;font-size:11.5px;margin-top:6px}
</style></head><body><div class="wrap">
<h1>SENTINEL</h1><p class="sub">ESP32 bridge setup — values are stored in flash and never leave the device.</p>
<form method="POST" action="/save">
<fieldset><legend>Wi-Fi (2.4 GHz)</legend>
<label>SSID</label><input name="ssid" value="%SSID%" required>
<label>Password</label><input name="pass" type="password" value="%PASS%">
</fieldset>
<fieldset><legend>PC agent</legend>
<label>Agent address (LAN or VPN IP of the PC)</label><input name="host" value="%HOST%" placeholder="10.8.0.5" required>
<label>Link port</label><input name="port" type="number" value="%PORT%">
<label>Pairing key (Settings → Devices in the app)</label><input name="psk" value="%PSK%" placeholder="64 hex characters" required>
<label>Device name</label><input name="id" value="%ID%">
</fieldset>
<fieldset><legend>WireGuard (optional)</legend>
<label><input type="checkbox" name="wg" value="1" %WGCHECK%> Join my VPN</label>
<label>Tunnel address of this ESP32</label><input name="wga" value="%WGA%" placeholder="10.8.0.7">
<label>Private key (base64)</label><input name="wgk" value="%WGK%">
<label>Server public key (base64)</label><input name="wgp" value="%WGP%">
<label>Endpoint host or IP</label><input name="wge" value="%WGE%" placeholder="vpn.example.net">
<label>Endpoint port</label><input name="wgport" type="number" value="%WGPORT%">
</fieldset>
<fieldset><legend>Wiring</legend>
<label>Power button pin</label><input name="ppin" type="number" value="%PPIN%">
<label>Reset button pin</label><input name="rpin" type="number" value="%RPIN%">
<label>PC sense pin (power LED, 3.3 V)</label><input name="spin" type="number" value="%SPIN%">
<label><input type="checkbox" name="sense" value="1" %SENSECHECK%> PC state sensing enabled</label>
</fieldset>
<button type="submit">Save and reboot</button>
<p class="hint">The power token for this device is <b>%TOKEN%</b> — the phone needs it to switch the PC on while the agent is offline.</p>
</form></div></body></html>)HTML";

static String portalPage() {
  String page = FPSTR(PORTAL_HTML);
  page.replace("%SSID%", cfg.ssid);
  page.replace("%PASS%", cfg.pass);
  page.replace("%HOST%", cfg.agentHost);
  page.replace("%PORT%", String(cfg.agentPort));
  page.replace("%PSK%", cfg.psk);
  page.replace("%ID%", cfg.deviceId);
  page.replace("%WGCHECK%", cfg.useWireGuard ? "checked" : "");
  page.replace("%WGA%", cfg.wgAddress);
  page.replace("%WGK%", cfg.wgPrivate);
  page.replace("%WGP%", cfg.wgPeerPublic);
  page.replace("%WGE%", cfg.wgEndpoint);
  page.replace("%WGPORT%", String(cfg.wgPort));
  page.replace("%PPIN%", String(cfg.powerPin));
  page.replace("%RPIN%", String(cfg.resetPin));
  page.replace("%SPIN%", String(cfg.sensePin));
  page.replace("%SENSECHECK%", cfg.senseEnabled ? "checked" : "");
  page.replace("%TOKEN%", powerToken());
  return page;
}

static void startPortal() {
  portalMode = true;
  WiFi.mode(WIFI_AP);
  String ssid = String(PORTAL_SSID_PREFIX) + cfg.deviceId;
  WiFi.softAP(ssid.c_str());
  Serial.printf("[portal] join \"%s\" then open http://%s/\n", ssid.c_str(), WiFi.softAPIP().toString().c_str());
  blink(6, 90);
}

// ── Wi-Fi / WireGuard ───────────────────────────────────────────────────────
static bool connectWifi() {
  if (cfg.ssid.length() == 0) return false;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(cfg.deviceId.c_str());
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
  }
  wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiUp) {
    Serial.printf("[wifi] %s → %s\n", cfg.ssid.c_str(), WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[wifi] connection failed");
  }
  return wifiUp;
}

static void startWireGuard() {
#if SENTINEL_USE_WIREGUARD
  if (!cfg.useWireGuard) return;
  if (cfg.wgAddress.length() == 0 || cfg.wgPrivate.length() == 0 || cfg.wgPeerPublic.length() == 0 ||
      cfg.wgEndpoint.length() == 0) {
    Serial.println("[wg] incomplete configuration, staying on plain Wi-Fi");
    return;
  }
  IPAddress local;
  if (!local.fromString(cfg.wgAddress)) {
    Serial.println("[wg] invalid tunnel address");
    return;
  }
  // WireGuard needs a sane clock for its handshake timestamps.
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  bool ok = wg.begin(local, cfg.wgPrivate.c_str(), cfg.wgEndpoint.c_str(), cfg.wgPeerPublic.c_str(), cfg.wgPort);
  Serial.printf("[wg] tunnel %s\n", ok ? "up" : "failed");
#else
  if (cfg.useWireGuard) Serial.println("[wg] firmware built without WireGuard support");
#endif
}

// ── Agent link ──────────────────────────────────────────────────────────────
static void sendLine(const String &line) {
  if (!agent.connected()) return;
  agent.print(line);
  agent.print('\n');
}

static void sendAuth() {
  String proof = hmacHex(String("sentinel-link-v1|") + agentNonce + "|" + deviceNonce + "|" + cfg.deviceId);
  JsonDocument doc;
  doc["t"] = "auth";
  doc["deviceId"] = cfg.deviceId;
  doc["nonce"] = deviceNonce;
  doc["sig"] = proof;
  String out;
  serializeJson(doc, out);
  sendLine(out);
}

static void sendState() {
  JsonDocument doc;
  doc["t"] = "state";
  JsonObject obj = doc.to<JsonObject>();
  writeState(obj);
  // writeState writes device/fw/... at the top level, which is what the agent reads.
  String out;
  serializeJson(doc, out);
  sendLine(out);
  lastStateSent = millis();
}

static void doPower(const String &action, uint32_t holdMs) {
  if (action == "reset") {
    relayPulse(cfg.resetPin, holdMs);
    return;
  }
  if (action == "cycle") {
    relayPulse(cfg.powerPin, holdMs);
    if (pcState() == "on") {
      delay(4000);
      relayPulse(cfg.powerPin, holdMs);
    }
    return;
  }
  relayPulse(cfg.powerPin, holdMs);
}

static void handleCommand(JsonObjectConst doc) {
  String id = doc["id"] | "";
  String cmd = doc["cmd"] | "";
  uint32_t holdMs = doc["args"]["holdMs"] | DEFAULT_RELAY_HOLD_MS;
  if (holdMs < 100) holdMs = 100;
  if (holdMs > 5000) holdMs = 5000;
  String action = doc["args"]["action"] | "cycle";

  JsonDocument res;
  res["t"] = "res";
  res["id"] = id;
  res["ok"] = true;
  JsonObject data = res["data"].to<JsonObject>();

  if (cmd == "power") {
    data["action"] = action;
    data["holdMs"] = holdMs;
    doPower(action, holdMs);
    data["pc"] = pcState();
    setLed(true);
    delay(60);
    setLed(false);
  } else if (cmd == "reset") {
    doPower("reset", holdMs);
    data["action"] = "reset";
    data["holdMs"] = holdMs;
    data["pc"] = pcState();
  } else if (cmd == "status") {
    writeState(data);
  } else if (cmd == "identify") {
    blink(4, 120);
    data["blinked"] = true;
  } else if (cmd == "reboot") {
    data["rebooting"] = true;
    String out;
    serializeJson(res, out);
    sendLine(out);
    delay(150);
    ESP.restart();
  } else {
    res["ok"] = false;
    res["error"] = "unknown command";
    res["code"] = "UNKNOWN_COMMAND";
  }

  String out;
  serializeJson(res, out);
  sendLine(out);
  Serial.printf("[cmd] %s → %s\n", cmd.c_str(), out.c_str());
}

static void processLine(const String &line) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    Serial.printf("[link] bad frame: %s\n", err.c_str());
    return;
  }
  String type = doc["t"] | "";

  if (type == "hello") {
    agentNonce = String((const char *)(doc["nonce"] | ""));
    deviceNonce = randomHex(16);
    linkState = LINK_WAIT_WELCOME;
    sendAuth();
    return;
  }

  if (type == "welcome") {
    String expected = hmacHex(String("sentinel-link-v1|") + deviceNonce + "|" + agentNonce + "|" + cfg.deviceId);
    String supplied = String((const char *)(doc["sig"] | ""));
    if (constantTimeEquals(expected, supplied)) {
      linkState = LINK_UP;
      Serial.println("[link] authenticated");
      blink(2, 70);
      sendState();
    } else {
      Serial.println("[link] agent proof mismatch — check the pairing key");
      agent.stop();
      linkState = LINK_DOWN;
    }
    return;
  }

  if (type == "ping") {
    sendLine("{\"t\":\"pong\"}");
    return;
  }

  if (type == "cmd") {
    if (linkState != LINK_UP) return;
    handleCommand(doc.as<JsonObjectConst>());
    return;
  }

  if (type == "deny") {
    Serial.println("[link] denied by agent");
    agent.stop();
    linkState = LINK_DOWN;
  }
}

static void linkLoop() {
  if (!agent.connected()) {
    if (linkState != LINK_DOWN) {
      linkState = LINK_DOWN;
      receiveBuffer = "";
      Serial.println("[link] disconnected");
    }
    if (wifiUp && cfg.agentHost.length() && millis() - lastConnectAttempt > AGENT_RECONNECT_MS) {
      lastConnectAttempt = millis();
      Serial.printf("[link] connecting to %s:%u\n", cfg.agentHost.c_str(), cfg.agentPort);
      if (agent.connect(cfg.agentHost.c_str(), cfg.agentPort, 4000)) {
        agent.setNoDelay(true);
        linkState = LINK_WAIT_HELLO;
        receiveBuffer = "";
      }
    }
    return;
  }

  while (agent.available()) {
    char c = (char)agent.read();
    if (c == '\n') {
      String line = receiveBuffer;
      receiveBuffer = "";
      line.trim();
      if (line.length()) processLine(line);
    } else if (c != '\r') {
      if (receiveBuffer.length() < 2048) receiveBuffer += c;
      else receiveBuffer = "";
    }
  }

  if (linkState == LINK_UP && millis() - lastStateSent > STATE_INTERVAL_MS) sendState();
}

// ── HTTP (power endpoint) ───────────────────────────────────────────────────
static void corsHeaders() {
  http.sendHeader("Access-Control-Allow-Origin", "*");
  http.sendHeader("Access-Control-Allow-Headers", "content-type");
  http.sendHeader("Cache-Control", "no-store");
}

static void handleStatus() {
  corsHeaders();
  http.send(200, "application/json", stateJson());
}

static void handlePower() {
  corsHeaders();
  String token = http.arg("t");
  if (!constantTimeEquals(token, powerToken())) {
    http.send(401, "application/json", "{\"ok\":false,\"error\":\"bad token\"}");
    return;
  }
  String action = http.arg("action");
  if (action.length() == 0) action = "cycle";
  uint32_t holdMs = DEFAULT_RELAY_HOLD_MS;
  if (http.hasArg("hold")) holdMs = (uint32_t)http.arg("hold").toInt();
  if (holdMs < 100) holdMs = 100;
  if (holdMs > 5000) holdMs = 5000;

  Serial.printf("[http] power %s (hold %u ms)\n", action.c_str(), holdMs);
  doPower(action, holdMs);
  String body = "{\"ok\":true,\"action\":\"" + action + "\",\"pc\":\"" + pcState() + "\"}";
  http.send(200, "application/json", body);
}

static void handleRoot() {
  corsHeaders();
  String html = F("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                  "<title>SENTINEL</title><style>body{margin:0;font:15px -apple-system,Segoe UI,sans-serif;background:#070b12;"
                  "color:#e8eefb;padding:24px}h1{letter-spacing:.22em;font-size:18px}p{color:#8fa1bb;font-size:13px}"
                  "button{display:block;width:100%;margin:10px 0;padding:13px;border:0;border-radius:11px;font:inherit;"
                  "font-weight:650;background:#182131;color:#e8eefb}button.main{background:linear-gradient(135deg,#3ce0ff,#8b7bff);"
                  "color:#04121a}pre{font-size:11px;color:#6b7c96;white-space:pre-wrap;word-break:break-all}</style>"
                  "<h1>SENTINEL</h1><p>ESP32 bridge — power control works even when the PC is off.</p>"
                  "<button class=main onclick=\"p('on')\">Power on</button>"
                  "<button onclick=\"p('off')\">Power off</button>"
                  "<button onclick=\"p('cycle')\">Power cycle</button>"
                  "<button onclick=\"p('reset')\">Reset button</button>"
                  "<pre id=o></pre><script>async function p(a){let t=localStorage.sentinelToken||prompt('Power token');"
                  "if(!t)return;localStorage.sentinelToken=t;let r=await fetch('/power?action='+a+'&t='+encodeURIComponent(t));"
                  "document.getElementById('o').textContent=await r.text();}"
                  "fetch('/status').then(r=>r.json()).then(s=>{document.getElementById('o').textContent=JSON.stringify(s,null,2)})</script>");
  http.send(200, "text/html", html);
}

// ── Setup ───────────────────────────────────────────────────────────────────
static void setupHttp() {
  http.on("/", HTTP_GET, handleRoot);
  http.on("/status", HTTP_GET, handleStatus);
  http.on("/power", HTTP_GET, handlePower);
  http.on("/save", HTTP_POST, []() {
    cfg.ssid = http.arg("ssid");
    cfg.pass = http.arg("pass");
    cfg.agentHost = http.arg("host");
    if (http.arg("port").length()) cfg.agentPort = (uint16_t)http.arg("port").toInt();
    cfg.psk = http.arg("psk");
    if (http.arg("id").length()) cfg.deviceId = http.arg("id");
    cfg.useWireGuard = http.hasArg("wg");
    cfg.wgAddress = http.arg("wga");
    cfg.wgPrivate = http.arg("wgk");
    cfg.wgPeerPublic = http.arg("wgp");
    cfg.wgEndpoint = http.arg("wge");
    if (http.arg("wgport").length()) cfg.wgPort = (uint16_t)http.arg("wgport").toInt();
    if (http.arg("ppin").length()) cfg.powerPin = http.arg("ppin").toInt();
    if (http.arg("rpin").length()) cfg.resetPin = http.arg("rpin").toInt();
    if (http.arg("spin").length()) cfg.sensePin = http.arg("spin").toInt();
    cfg.senseEnabled = http.hasArg("sense");
    saveSettings();
    http.send(200, "text/html", "<meta charset=utf-8><body style='background:#070b12;color:#e8eefb;font-family:sans-serif;padding:30px'>Saved. Rebooting…</body>");
    delay(600);
    ESP.restart();
  });
  http.onNotFound([]() {
    corsHeaders();
    http.send(404, "application/json", "{\"ok\":false,\"error\":\"not found\"}");
  });
  http.begin();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  bootMillis = millis();

  pinMode(PIN_LED, OUTPUT);
  setLed(false);

  loadSettings();
  pinMode(cfg.powerPin, OUTPUT);
  pinMode(cfg.resetPin, OUTPUT);
  relayWrite(cfg.powerPin, false);
  relayWrite(cfg.resetPin, false);
  if (cfg.senseEnabled && cfg.sensePin >= 0) pinMode(cfg.sensePin, INPUT);

  Serial.println();
  Serial.printf("SENTINEL ESP32 bridge %s — device %s\n", SENTINEL_FW_VERSION, cfg.deviceId.c_str());
  Serial.printf("Power token: %s\n", powerToken().c_str());

  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);
  bool forcePortal = digitalRead(PIN_BOOT_BUTTON) == LOW;
  if (forcePortal) {
    Serial.println("[boot] BOOT held — starting setup portal");
    startPortal();
    setupHttp();
    return;
  }

  if (!connectWifi()) {
    Serial.println("[boot] no Wi-Fi — starting setup portal");
    startPortal();
    setupHttp();
    return;
  }

  startWireGuard();
  if (MDNS.begin(cfg.deviceId.c_str())) {
    MDNS.addService("http", "tcp", DEFAULT_HTTP_PORT);
    Serial.printf("[mdns] http://%s.local/\n", cfg.deviceId.c_str());
  }
  setupHttp();
  blink(3, 60);
}

void loop() {
  if (portalMode) {
    http.handleClient();
    if (millis() - bootMillis > PORTAL_TIMEOUT_MS) ESP.restart();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    wifiUp = false;
    if (millis() - lastConnectAttempt > 10000) {
      lastConnectAttempt = millis();
      connectWifi();
    }
  } else {
    wifiUp = true;
  }

  http.handleClient();
  linkLoop();

  // Heartbeat LED: steady when linked, slow blink when searching.
  uint32_t interval = linkState == LINK_UP ? 3000 : 700;
  if (millis() - lastLedToggle > interval) {
    lastLedToggle = millis();
    setLed(!ledOn);
  }
}
