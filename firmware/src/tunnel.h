// ============================================================================
//  SENTINEL Tunnel server for the ESP32.
//
//  The phone pairs with an ephemeral ECDH key, proves it knows the pairing key,
//  and from then on every request is AES-256-GCM. No VPN, no token on the wire.
//  Commands the ESP32 cannot perform itself are relayed to the PC agent over the
//  already-authenticated link, so "everything through the ESP32" works.
//
//  Endpoints (mounted on the existing web server):
//     POST /t/hello   { v, nc, ec }
//     POST /t/open    { sid, mac }
//     POST /t/msg     { sid, seq, ct }
// ============================================================================
#pragma once

#include <Arduino.h>

typedef String (*StStatusFn)();
typedef void (*StPowerFn)(const String &action, uint32_t holdMs);
typedef String (*StRelayFn)(const String &body, bool *ok);

struct StTunnelSession {
  bool active;
  char sid[19];
  uint8_t c2s[32];
  uint8_t s2c[32];
  uint32_t sendSeq;
  uint32_t lastRecvSeq;
  bool hasReceived;
  uint32_t openedAt;
  uint32_t lastSeen;
};

class StTunnel {
 public:
  StTunnel();
  void begin(const String &pskHex);
  void setStatusProvider(StStatusFn fn) { statusFn_ = fn; }
  void setPowerHandler(StPowerFn fn) { powerFn_ = fn; }
  void setRelay(StRelayFn fn) { relayFn_ = fn; }

  int hello(const String &body, String &response);
  int open(const String &body, String &response);
  int message(const String &body, String &response);

  bool active() const { return session_.active; }
  void drop();
  void sweep();

 private:
  bool pskBytes(uint8_t *out, size_t *outLen) const;
  int errorResponse(String &response, const char *message, int status);
  bool deriveKeys(const uint8_t *shared, const String &nc, const String &ns);

  String pskHex_;
  StTunnelSession session_;

  bool pending_;
  char pendingSid_[19];
  String pendingNc_;
  String pendingNs_;
  String pendingEcB64_;
  String pendingEsB64_;
  uint32_t pendingAt_;
  class StEcKey *pendingKey_;

  StStatusFn statusFn_ = nullptr;
  StPowerFn powerFn_ = nullptr;
  StRelayFn relayFn_ = nullptr;
};
