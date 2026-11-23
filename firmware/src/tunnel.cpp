#include "tunnel.h"

#include <string.h>

#include <ArduinoJson.h>
#include "st_crypto.h"

#include <string.h>

static const char *ST_INFO = "ST1|keys";
static const uint32_t ST_SESSION_TTL_MS = 15UL * 60UL * 1000UL;
static const uint32_t ST_HANDSHAKE_TTL_MS = 30UL * 1000UL;
static const size_t ST_MAX_PLAIN = 6000;

StTunnel::StTunnel()
    : pending_(false),
      pendingAt_(0),
      pendingKey_(nullptr) {
  memset(&session_, 0, sizeof(session_));
  session_.lastRecvSeq = 0;
  session_.active = false;
  pendingSid_[0] = 0;
}

void StTunnel::begin(const String &pskHex) {
  pskHex_ = pskHex;
  drop();
}

void StTunnel::drop() {
  memset(&session_, 0, sizeof(session_));
  session_.active = false;
  session_.lastRecvSeq = 0;
  if (pendingKey_) {
    delete pendingKey_;
    pendingKey_ = nullptr;
  }
  pending_ = false;
}

bool StTunnel::pskBytes(uint8_t *out, size_t *outLen) const {
  return stFromHex(pskHex_, out, 64, outLen);
}

int StTunnel::errorResponse(String &response, const char *message, int status) {
  JsonDocument doc;
  doc["error"] = message;
  doc["status"] = status;
  response = "";
  serializeJson(doc, response);
  return status;
}

int StTunnel::hello(const String &body, String &response) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return errorResponse(response, "body is not JSON", 400);

  String nc = String((const char *)(doc["nc"] | ""));
  String ecB64 = String((const char *)(doc["ec"] | ""));
  if (nc.length() != 32 || ecB64.length() < 80) return errorResponse(response, "nc/ec malformed", 400);

  uint8_t peer[ST_P256_PUB_LEN];
  size_t peerLen = 0;
  if (!stFromBase64(ecB64, peer, sizeof(peer), &peerLen) || peerLen != ST_P256_PUB_LEN || peer[0] != 0x04) {
    return errorResponse(response, "ec must be an uncompressed P-256 point", 400);
  }

  if (pendingKey_) {
    delete pendingKey_;
    pendingKey_ = nullptr;
  }
  pendingKey_ = new StEcKey();
  if (!pendingKey_->generate()) return errorResponse(response, "the ESP32 could not generate a key", 500);

  uint8_t es[ST_P256_PUB_LEN];
  if (!pendingKey_->exportPublic(es)) return errorResponse(response, "key export failed", 500);
  String esB64 = stBase64(es, sizeof(es));

  uint8_t nsBytes[16];
  stRandom(nsBytes, sizeof(nsBytes));
  String ns = stHex(nsBytes, sizeof(nsBytes));

  uint8_t sidBytes[8];
  stRandom(sidBytes, sizeof(sidBytes));
  String sid = stHex(sidBytes, sizeof(sidBytes));

  uint8_t psk[64];
  size_t pskLen = 0;
  pskBytes(psk, &pskLen);

  String transcript = String("ST1|server|") + nc + "|" + ecB64 + "|" + ns + "|" + esB64;
  uint8_t mac[ST_KEY_LEN];
  if (!stHmac(psk, pskLen, transcript.c_str(), transcript.length(), mac)) {
    return errorResponse(response, "HMAC failed", 500);
  }

  pending_ = true;
  pendingNc_ = nc;
  pendingNs_ = ns;
  pendingEcB64_ = ecB64;
  pendingEsB64_ = esB64;
  pendingAt_ = millis();
  sid.toCharArray(pendingSid_, sizeof(pendingSid_));

  JsonDocument out;
  out["v"] = 1;
  out["sid"] = sid;
  out["ns"] = ns;
  out["es"] = esB64;
  out["mac"] = stBase64(mac, sizeof(mac));
  out["ttl"] = ST_SESSION_TTL_MS;
  response = "";
  serializeJson(out, response);
  return 200;
}

bool StTunnel::deriveKeys(const uint8_t *shared, const String &nc, const String &ns) {
  uint8_t salt[32];
  size_t saltLen = 0;
  if (!stFromHex(nc + ns, salt, sizeof(salt), &saltLen) || saltLen != 32) return false;
  uint8_t okm[64];
  if (!stHkdf(shared, 32, salt, saltLen, ST_INFO, okm, sizeof(okm))) return false;
  memcpy(session_.c2s, okm, 32);
  memcpy(session_.s2c, okm + 32, 32);
  return true;
}

int StTunnel::open(const String &body, String &response) {
  if (!pending_ || !pendingKey_) return errorResponse(response, "unknown or expired handshake", 404);
  if (millis() - pendingAt_ > ST_HANDSHAKE_TTL_MS) {
    drop();
    return errorResponse(response, "handshake took too long", 410);
  }

  JsonDocument doc;
  if (deserializeJson(doc, body)) return errorResponse(response, "body is not JSON", 400);
  String sid = String((const char *)(doc["sid"] | ""));
  String supplied = String((const char *)(doc["mac"] | ""));
  if (sid != String(pendingSid_)) return errorResponse(response, "unknown or expired handshake", 404);

  uint8_t psk[64];
  size_t pskLen = 0;
  pskBytes(psk, &pskLen);

  String transcript = String("ST1|client|") + pendingNc_ + "|" + pendingEcB64_ + "|" + pendingNs_ + "|" + pendingEsB64_;
  uint8_t expected[ST_KEY_LEN];
  if (!stHmac(psk, pskLen, transcript.c_str(), transcript.length(), expected)) {
    return errorResponse(response, "HMAC failed", 500);
  }
  String expectedB64 = stBase64(expected, sizeof(expected));
  if (expectedB64 != supplied) {
    pending_ = false;
    delete pendingKey_;
    pendingKey_ = nullptr;
    return errorResponse(response, "pairing key mismatch", 403);
  }

  uint8_t peer[ST_P256_PUB_LEN];
  size_t peerLen = 0;
  if (!stFromBase64(pendingEcB64_, peer, sizeof(peer), &peerLen) || peerLen != ST_P256_PUB_LEN) {
    return errorResponse(response, "invalid client key", 400);
  }

  uint8_t shared[ST_KEY_LEN];
  if (!pendingKey_->agree(peer, shared)) return errorResponse(response, "key agreement failed", 400);
  if (!deriveKeys(shared, pendingNc_, pendingNs_)) return errorResponse(response, "key derivation failed", 500);

  session_.active = true;
  session_.sendSeq = 0;
  session_.lastRecvSeq = 0;
  session_.hasReceived = false;
  session_.openedAt = millis();
  session_.lastSeen = millis();
  sid.toCharArray(session_.sid, sizeof(session_.sid));

  pending_ = false;
  delete pendingKey_;
  pendingKey_ = nullptr;

  response = "{\"ok\":true}";
  return 200;
}

int StTunnel::message(const String &body, String &response) {
  if (!session_.active) return errorResponse(response, "session expired — pair again", 401);
  if (millis() - session_.lastSeen > ST_SESSION_TTL_MS) {
    drop();
    return errorResponse(response, "session expired — pair again", 401);
  }

  JsonDocument doc;
  if (deserializeJson(doc, body)) return errorResponse(response, "body is not JSON", 400);
  String sid = String((const char *)(doc["sid"] | ""));
  uint32_t seq = doc["seq"] | 0;
  String ctB64 = String((const char *)(doc["ct"] | ""));
  if (sid != String(session_.sid)) return errorResponse(response, "unknown session", 401);
  // seq 0 is a legitimate first frame, so "nothing yet" is tracked explicitly.
  if (session_.hasReceived && seq <= session_.lastRecvSeq) {
    return errorResponse(response, "frame rejected: replayed frame", 400);
  }

  uint8_t cipher[ST_MAX_PLAIN + ST_TAG_LEN];
  size_t cipherLen = 0;
  if (!stFromBase64(ctB64, cipher, sizeof(cipher), &cipherLen)) return errorResponse(response, "ct is not base64", 400);

  String aad = String("ST1|msg|") + sid + "|" + String(seq);
  uint8_t plain[ST_MAX_PLAIN];
  size_t plainLen = 0;
  if (!stGcmDecrypt(session_.c2s, seq, 1, aad.c_str(), aad.length(), cipher, cipherLen, plain, &plainLen)) {
    return errorResponse(response, "frame rejected: decryption failed", 400);
  }
  plain[plainLen] = 0;
  session_.lastRecvSeq = seq;
  session_.hasReceived = true;
  session_.lastSeen = millis();

  JsonDocument request;
  if (deserializeJson(request, (const char *)plain)) return errorResponse(response, "frame is not JSON", 400);

  String cmd = String((const char *)(request["cmd"] | ""));
  String reply;

  if (cmd.length() == 0) {
    if (request["poll"] | false) {
      reply = String("{\"ok\":true,\"cmd\":\"poll\",\"data\":{\"device\":\"") +
              String(session_.sid) + "\"}}";
    } else {
      reply = "{\"ok\":false,\"code\":\"BAD_REQUEST\",\"message\":\"expected {cmd,args} or {poll:true}\"}";
    }
  } else if (cmd == "esp.status" || cmd == "esp.state") {
    reply = statusFn_ ? statusFn_() : String("{\"ok\":false,\"message\":\"no status provider\"}");
  } else if (cmd == "esp.power") {
    String action = String((const char *)(request["args"]["action"] | "cycle"));
    uint32_t holdMs = request["args"]["holdMs"] | 600;
    if (action != "on" && action != "off" && action != "cycle") action = "cycle";
    if (holdMs < 100) holdMs = 100;
    if (holdMs > 5000) holdMs = 5000;
    if (powerFn_) powerFn_(action, holdMs);
    reply = String("{\"ok\":true,\"cmd\":\"esp.power\",\"data\":{\"action\":\"") + action + "\",\"holdMs\":" +
            String(holdMs) + "}}";
  } else if (cmd == "esp.reset") {
    uint32_t holdMs = request["args"]["holdMs"] | 600;
    if (powerFn_) powerFn_("reset", holdMs);
    reply = String("{\"ok\":true,\"cmd\":\"esp.reset\",\"data\":{\"holdMs\":") + String(holdMs) + "}}";
  } else if (cmd == "esp.identify") {
    reply = "{\"ok\":true,\"cmd\":\"esp.identify\",\"data\":{\"blinked\":true}}";
  } else if (relayFn_) {
    bool ok = false;
    String relayed = relayFn_(body, &ok);
    reply = ok ? relayed
               : String("{\"ok\":false,\"cmd\":\"") + cmd +
                     "\",\"code\":\"LINK_OFFLINE\",\"message\":\"The PC agent is not reachable. Power and reset still work.\"}";
  } else {
    reply = "{\"ok\":false,\"code\":\"UNKNOWN_COMMAND\",\"message\":\"This ESP32 cannot handle that command\"}";
  }

  uint32_t outSeq = session_.sendSeq++;
  String outAad = String("ST1|msg|") + sid + "|" + String(outSeq);
  uint8_t sealed[ST_MAX_PLAIN + ST_TAG_LEN];
  size_t sealedLen = 0;
  if (!stGcmEncrypt(session_.s2c, outSeq, 2, outAad.c_str(), outAad.length(),
                    (const uint8_t *)reply.c_str(), reply.length(), sealed, &sealedLen)) {
    return errorResponse(response, "encryption failed", 500);
  }

  JsonDocument out;
  out["seq"] = outSeq;
  out["ct"] = stBase64(sealed, sealedLen);
  out["sid"] = sid;
  response = "";
  serializeJson(out, response);
  return 200;
}

void StTunnel::sweep() {
  if (session_.active && millis() - session_.lastSeen > ST_SESSION_TTL_MS) drop();
  if (pending_ && millis() - pendingAt_ > ST_HANDSHAKE_TTL_MS) drop();
}
