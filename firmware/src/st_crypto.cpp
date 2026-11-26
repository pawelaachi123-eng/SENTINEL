#include "st_crypto.h"

#include <string.h>

#include <mbedtls/base64.h>
#include <esp_system.h>

static int stRng(void *, unsigned char *out, size_t len) {
  esp_fill_random(out, len);
  return 0;
}

bool stRandom(uint8_t *out, size_t len) {
  esp_fill_random(out, len);
  return true;
}

String stHex(const uint8_t *data, size_t len) {
  static const char *digits = "0123456789abcdef";
  String out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out += digits[(data[i] >> 4) & 0x0F];
    out += digits[data[i] & 0x0F];
  }
  return out;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool stFromHex(const String &hex, uint8_t *out, size_t maxLen, size_t *outLen) {
  if (hex.length() % 2 != 0) return false;
  size_t len = hex.length() / 2;
  if (len > maxLen) return false;
  for (size_t i = 0; i < len; i++) {
    int hi = hexNibble(hex[i * 2]);
    int lo = hexNibble(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  if (outLen) *outLen = len;
  return true;
}

String stBase64(const uint8_t *data, size_t len) {
  size_t needed = 0;
  mbedtls_base64_encode(nullptr, 0, &needed, data, len);
  if (needed == 0 || needed > 4096) return String();
  uint8_t *buffer = (uint8_t *)malloc(needed + 1);
  if (!buffer) return String();
  size_t written = 0;
  int rc = mbedtls_base64_encode(buffer, needed, &written, data, len);
  String out;
  if (rc == 0) {
    buffer[written] = 0;
    out = String((const char *)buffer);
  }
  free(buffer);
  return out;
}

bool stFromBase64(const String &text, uint8_t *out, size_t maxLen, size_t *outLen) {
  size_t written = 0;
  int rc = mbedtls_base64_decode(out, maxLen, &written, (const unsigned char *)text.c_str(), text.length());
  if (rc != 0) return false;
  if (outLen) *outLen = written;
  return true;
}

bool stHmac(const uint8_t *key, size_t keyLen, const char *message, size_t messageLen, uint8_t out[ST_KEY_LEN]) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  bool ok = false;
  if (mbedtls_md_setup(&ctx, info, 1) == 0 && mbedtls_md_hmac_starts(&ctx, key, keyLen) == 0 &&
      mbedtls_md_hmac_update(&ctx, (const unsigned char *)message, messageLen) == 0 &&
      mbedtls_md_hmac_finish(&ctx, out) == 0) {
    ok = true;
  }
  mbedtls_md_free(&ctx);
  return ok;
}

// HKDF-SHA256 (RFC 5869) built straight from HMAC: ESP-IDF ships the primitive
// but leaves MBEDTLS_HKDF_C disabled, so depending on it would break the build.
bool stHkdf(const uint8_t *ikm, size_t ikmLen, const uint8_t *salt, size_t saltLen,
            const char *info, uint8_t *out, size_t outLen) {
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!md) return false;

  uint8_t zeroSalt[32] = {0};
  const uint8_t *useSalt = salt;
  size_t useSaltLen = saltLen;
  if (!salt || saltLen == 0) {
    useSalt = zeroSalt;
    useSaltLen = sizeof(zeroSalt);
  }

  uint8_t prk[32];
  {
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    bool ok = mbedtls_md_setup(&ctx, md, 1) == 0 &&
              mbedtls_md_hmac_starts(&ctx, useSalt, useSaltLen) == 0 &&
              mbedtls_md_hmac_update(&ctx, ikm, ikmLen) == 0 &&
              mbedtls_md_hmac_finish(&ctx, prk) == 0;
    mbedtls_md_free(&ctx);
    if (!ok) return false;
  }

  const size_t infoLen = strlen(info);
  uint8_t block[32];
  size_t blockLen = 0;
  uint8_t counter = 1;
  size_t done = 0;
  while (done < outLen) {
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    bool ok = mbedtls_md_setup(&ctx, md, 1) == 0 &&
              mbedtls_md_hmac_starts(&ctx, prk, sizeof(prk)) == 0 &&
              (blockLen == 0 || mbedtls_md_hmac_update(&ctx, block, blockLen) == 0) &&
              mbedtls_md_hmac_update(&ctx, (const unsigned char *)info, infoLen) == 0 &&
              mbedtls_md_hmac_update(&ctx, &counter, 1) == 0 &&
              mbedtls_md_hmac_finish(&ctx, block) == 0;
    mbedtls_md_free(&ctx);
    if (!ok) return false;
    blockLen = sizeof(block);
    size_t take = outLen - done;
    if (take > sizeof(block)) take = sizeof(block);
    memcpy(out + done, block, take);
    done += take;
    counter++;
  }
  return true;
}

void stNonce(uint32_t seq, uint8_t direction, uint8_t nonce[ST_NONCE_LEN]) {
  nonce[0] = (uint8_t)((seq >> 24) & 0xFF);
  nonce[1] = (uint8_t)((seq >> 16) & 0xFF);
  nonce[2] = (uint8_t)((seq >> 8) & 0xFF);
  nonce[3] = (uint8_t)(seq & 0xFF);
  nonce[4] = direction;
  for (size_t i = 5; i < ST_NONCE_LEN; i++) nonce[i] = 0;
}

bool stGcmEncrypt(const uint8_t key[ST_KEY_LEN], uint32_t seq, uint8_t direction,
                  const char *aad, size_t aadLen, const uint8_t *plain, size_t plainLen,
                  uint8_t *out, size_t *outLen) {
  mbedtls_gcm_context ctx;
  mbedtls_gcm_init(&ctx);
  uint8_t nonce[ST_NONCE_LEN];
  stNonce(seq, direction, nonce);
  bool ok = false;
  if (mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 256) == 0) {
    if (mbedtls_gcm_crypt_and_tag(&ctx, MBEDTLS_GCM_ENCRYPT, plainLen, nonce, ST_NONCE_LEN,
                                  (const unsigned char *)aad, aadLen, plain, out,
                                  ST_TAG_LEN, out + plainLen) == 0) {
      *outLen = plainLen + ST_TAG_LEN;
      ok = true;
    }
  }
  mbedtls_gcm_free(&ctx);
  return ok;
}

bool stGcmDecrypt(const uint8_t key[ST_KEY_LEN], uint32_t seq, uint8_t direction,
                  const char *aad, size_t aadLen, const uint8_t *cipher, size_t cipherLen,
                  uint8_t *out, size_t *outLen) {
  if (cipherLen < ST_TAG_LEN) return false;
  size_t bodyLen = cipherLen - ST_TAG_LEN;
  const uint8_t *tag = cipher + bodyLen;
  mbedtls_gcm_context ctx;
  mbedtls_gcm_init(&ctx);
  uint8_t nonce[ST_NONCE_LEN];
  stNonce(seq, direction, nonce);
  bool ok = false;
  if (mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 256) == 0) {
    if (mbedtls_gcm_auth_decrypt(&ctx, bodyLen, nonce, ST_NONCE_LEN,
                                 (const unsigned char *)aad, aadLen, tag, ST_TAG_LEN,
                                 cipher, out) == 0) {
      *outLen = bodyLen;
      ok = true;
    }
  }
  mbedtls_gcm_free(&ctx);
  return ok;
}

/* ── ephemeral P-256 ─────────────────────────────────────────────────────── */

StEcKey::StEcKey() : ready_(false) {
  mbedtls_ecp_group_init(&grp_);
  mbedtls_mpi_init(&d_);
  mbedtls_ecp_point_init(&q_);
}

StEcKey::~StEcKey() { reset(); }

void StEcKey::reset() {
  mbedtls_mpi_free(&d_);
  mbedtls_ecp_point_free(&q_);
  mbedtls_ecp_group_free(&grp_);
  // Re-initialise so the object stays usable after reset().
  mbedtls_mpi_init(&d_);
  mbedtls_ecp_point_init(&q_);
  mbedtls_ecp_group_init(&grp_);
  ready_ = false;
}

bool StEcKey::generate() {
  reset();
  if (mbedtls_ecp_group_load(&grp_, MBEDTLS_ECP_DP_SECP256R1) != 0) return false;
  if (mbedtls_ecp_gen_keypair(&grp_, &d_, &q_, stRng, nullptr) != 0) return false;
  ready_ = true;
  return true;
}

bool StEcKey::exportPublic(uint8_t out[ST_P256_PUB_LEN]) const {
  if (!ready_) return false;
  size_t written = 0;
  if (mbedtls_ecp_point_write_binary(&grp_, &q_, MBEDTLS_ECP_PF_UNCOMPRESSED, &written, out, ST_P256_PUB_LEN) != 0) {
    return false;
  }
  return written == ST_P256_PUB_LEN;
}

bool StEcKey::agree(const uint8_t peerPublic[ST_P256_PUB_LEN], uint8_t sharedOut[ST_KEY_LEN]) {
  if (!ready_ || peerPublic[0] != 0x04) return false;
  mbedtls_ecp_point peer;
  mbedtls_ecp_point_init(&peer);
  // mbedtls_ecp_mul() returns a point; the shared secret is its X coordinate,
  // which is exactly what node:crypto and WebCrypto hand back too.
  mbedtls_ecp_point sharedPoint;
  mbedtls_ecp_point_init(&sharedPoint);
  bool ok = false;
  if (mbedtls_ecp_point_read_binary(&grp_, &peer, peerPublic, ST_P256_PUB_LEN) == 0 &&
      mbedtls_ecp_check_pubkey(&grp_, &peer) == 0 &&
      mbedtls_ecp_mul(&grp_, &sharedPoint, &d_, &peer, stRng, nullptr) == 0 &&
      mbedtls_mpi_write_binary(&sharedPoint.X, sharedOut, ST_KEY_LEN) == 0) {
    ok = true;
  }
  mbedtls_ecp_point_free(&sharedPoint);
  mbedtls_ecp_point_free(&peer);
  return ok;
}
