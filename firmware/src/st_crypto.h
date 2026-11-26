// ============================================================================
//  SENTINEL tunnel crypto for ESP32 (mbedtls)
//
//  Mirrors core/tunnel.js exactly:
//    ECDH P-256  →  HKDF-SHA256  →  AES-256-GCM
//  See docs/tunnel.md for the normative description.
// ============================================================================
#pragma once

#include <Arduino.h>
#include <mbedtls/ecp.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>

static const size_t ST_KEY_LEN = 32;
static const size_t ST_TAG_LEN = 16;
static const size_t ST_NONCE_LEN = 12;
static const size_t ST_P256_PUB_LEN = 65;

bool stRandom(uint8_t *out, size_t len);
String stHex(const uint8_t *data, size_t len);
bool stFromHex(const String &hex, uint8_t *out, size_t maxLen, size_t *outLen);
String stBase64(const uint8_t *data, size_t len);
bool stFromBase64(const String &text, uint8_t *out, size_t maxLen, size_t *outLen);
bool stHmac(const uint8_t *key, size_t keyLen, const char *message, size_t messageLen, uint8_t out[ST_KEY_LEN]);
bool stHkdf(const uint8_t *ikm, size_t ikmLen, const uint8_t *salt, size_t saltLen,
            const char *info, uint8_t *out, size_t outLen);
bool stGcmEncrypt(const uint8_t key[ST_KEY_LEN], uint32_t seq, uint8_t direction,
                  const char *aad, size_t aadLen, const uint8_t *plain, size_t plainLen,
                  uint8_t *out, size_t *outLen);
bool stGcmDecrypt(const uint8_t key[ST_KEY_LEN], uint32_t seq, uint8_t direction,
                  const char *aad, size_t aadLen, const uint8_t *cipher, size_t cipherLen,
                  uint8_t *out, size_t *outLen);
void stNonce(uint32_t seq, uint8_t direction, uint8_t nonce[ST_NONCE_LEN]);

/** Ephemeral P-256 key pair with just enough surface for the handshake. */
class StEcKey {
 public:
  StEcKey();
  ~StEcKey();
  bool generate();
  bool exportPublic(uint8_t out[ST_P256_PUB_LEN]) const;
  bool agree(const uint8_t peerPublic[ST_P256_PUB_LEN], uint8_t sharedOut[ST_KEY_LEN]);
  void reset();

 private:
  bool ready_;
  mbedtls_ecp_group grp_;
  mbedtls_mpi d_;
  mbedtls_ecp_point q_;
};
