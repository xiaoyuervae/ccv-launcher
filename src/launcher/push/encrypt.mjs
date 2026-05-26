// RFC 8291 (Web Push Message Encryption) implementation — zero deps.
//
// Encrypts a Web Push payload using aes128gcm content encoding (RFC 8188).
// Single-record output, plenty of headroom for the < 4 KB notifications we
// send. Reference cloudcli uses the `web-push` npm package; we recreate the
// minimum subset needed for a single-record payload, all via node:crypto.
//
// Algorithm (RFC 8291 §3.4):
//   ecdh_secret = ECDH(server_priv, client_pub_raw)
//   key_info    = "WebPush: info\0" + client_pub_raw + server_pub_raw
//   IKM         = HKDF(auth_secret, ecdh_secret, key_info, 32)
//   CEK         = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
//   NONCE       = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
//
// (HKDF is here used in the (ikm, salt, info, length) shape that
// crypto.hkdfSync exposes, equivalent to HKDF-Extract+Expand combined.)
//
// Framing (RFC 8188 §2.1):
//   header  = salt(16) || rs(4 BE u32) || idlen(1) || keyid(65)   = 86 bytes
//   body    = header || ciphertext_with_tag
// Plaintext gets a 0x02 last-record delimiter appended before AES-GCM.

import { createECDH, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv } from 'node:crypto';

const RECORD_SIZE = 4096;
const HKDF_HASH = 'sha256';
const TAG_LEN = 16;

function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

function hkdf(salt, ikm, info, length) {
  // crypto.hkdfSync returns ArrayBuffer; wrap as Buffer for ergonomic ops.
  return Buffer.from(hkdfSync(HKDF_HASH, ikm, salt, info, length));
}

// jwk → raw 65-byte uncompressed point. Mirror of vapid.mjs helper but kept
// local so encrypt has no inbound dep on vapid (lets vapid import encrypt
// later if we ever need it, no cycle).
function jwkToRawPublicPoint(jwk) {
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

// Encrypt a single-record aes128gcm payload for the given subscription
// keys. Inputs `recipientP256dhB64u` and `recipientAuthSecretB64u` come
// directly from PushSubscription.toJSON().keys. Returns the framed body
// bytes ready to POST with `Content-Encoding: aes128gcm`.
//
// Also returns serverPublicKeyRaw so callers (or tests) can echo it back
// when verifying the KAT; not used by the HTTP send path.
export function encryptPayload(plaintext, recipientP256dhB64u, recipientAuthSecretB64u) {
  if (!Buffer.isBuffer(plaintext)) plaintext = Buffer.from(plaintext);
  const clientPubRaw = b64urlDecode(recipientP256dhB64u);
  const authSecret = b64urlDecode(recipientAuthSecretB64u);
  if (clientPubRaw.length !== 65 || clientPubRaw[0] !== 0x04) {
    throw new Error(`encrypt: bad recipient p256dh length=${clientPubRaw.length}`);
  }
  if (authSecret.length !== 16) {
    throw new Error(`encrypt: bad auth secret length=${authSecret.length}`);
  }
  // Ephemeral server keypair, used once and discarded.
  const ecdh = createECDH('prime256v1');
  const serverPubRaw = ecdh.generateKeys();
  if (serverPubRaw.length !== 65) {
    throw new Error(`encrypt: server pub length=${serverPubRaw.length}`);
  }
  const ecdhSecret = ecdh.computeSecret(clientPubRaw);
  if (ecdhSecret.length !== 32) {
    throw new Error(`encrypt: ecdh secret length=${ecdhSecret.length}`);
  }
  const salt = randomBytes(16);
  return encryptWithMaterial({ plaintext, clientPubRaw, authSecret, serverPubRaw, ecdhSecret, salt });
}

// Lower-level entry point that takes pre-generated material. Lets tests
// drive RFC 8291 Appendix A's known-answer vector through the same code
// path (deterministic salt + ephemeral keypair + ecdh secret).
export function encryptWithMaterial({ plaintext, clientPubRaw, authSecret, serverPubRaw, ecdhSecret, salt }) {
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf-8'),
    clientPubRaw,
    serverPubRaw,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf-8'), 12);

  // RFC 8188 last-record delimiter. We always send a single record, so
  // always 0x02 (vs 0x01 for non-final records).
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  if (padded.length + TAG_LEN >= RECORD_SIZE) {
    // Final record MUST be strictly shorter than rs (RFC 8188 §2). Pushing
    // 4 KB+ payloads from notifications doesn't make sense anyway; refuse
    // loudly rather than silently truncate.
    throw new Error(`encrypt: payload too large (${plaintext.length} bytes) for single-record rs=${RECORD_SIZE}`);
  }

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header layout per RFC 8188 §2.1.
  const header = Buffer.alloc(86);
  salt.copy(header, 0);                          // 16
  header.writeUInt32BE(RECORD_SIZE, 16);         //  4
  header.writeUInt8(serverPubRaw.length, 20);    //  1 (idlen = 65)
  serverPubRaw.copy(header, 21);                 // 65
  return Buffer.concat([header, enc, tag]);
}

export const _internals = { hkdf, jwkToRawPublicPoint, RECORD_SIZE };
