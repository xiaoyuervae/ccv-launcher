// Self-test for encrypt.mjs. Runs as plain `node` (no test runner).
//
// 1. Round-trip: encrypt with a fresh server ephemeral key, then decrypt
//    using the client private key. Asserts plaintext === decrypted.
// 2. RFC 8291 Appendix A known-answer test (KAT): feeds the exact inputs
//    from the spec and asserts the output matches byte-for-byte.

import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, generateKeyPairSync } from 'node:crypto';

import { encryptPayload, encryptWithMaterial, _internals } from '../encrypt.mjs';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}
function hex(buf) { return Buffer.from(buf).toString('hex'); }

function parseAes128GcmBody(body) {
  // Header: salt(16) || rs(4 BE) || idlen(1) || keyid(idlen) || ciphertext
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const keyid = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  return { salt, rs, idlen, keyid, ciphertext };
}

function decryptAes128Gcm({ body, clientPrivKey, authSecret }) {
  const { salt, keyid: serverPubRaw, ciphertext } = parseAes128GcmBody(body);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(clientPrivKey);
  const ecdhSecret = ecdh.computeSecret(serverPubRaw);
  const clientPubRaw = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPubRaw, serverPubRaw]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const dec = createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]);
  // strip 0x02 last-record delimiter
  assert.equal(out[out.length - 1], 0x02, 'expected 0x02 delimiter byte');
  return out.subarray(0, out.length - 1);
}

// ---------- Test 1: round-trip with random material ----------
{
  // Simulate a browser PushSubscription: generate a client keypair + auth.
  const clientEcdh = createECDH('prime256v1');
  clientEcdh.generateKeys();
  const clientPubRaw = clientEcdh.getPublicKey();
  const clientPrivRaw = clientEcdh.getPrivateKey();
  const authSecret = randomBytes(16);
  const payload = Buffer.from(JSON.stringify({ title: '测试', body: '一些 utf-8 内容 ' + Math.random() }), 'utf-8');
  const body = encryptPayload(payload, b64urlEncode(clientPubRaw), b64urlEncode(authSecret));
  const dec = decryptAes128Gcm({ body, clientPrivKey: clientPrivRaw, authSecret });
  assert.deepStrictEqual(dec, payload, 'round-trip plaintext mismatch');
  console.log('test 1 round-trip: ok (payload', payload.length, 'B → encrypted', body.length, 'B)');
}

// ---------- Test 2: RFC 8291 Appendix A KAT ----------
// All inputs from RFC 8291 §A.2. Plaintext: "When I grow up, I want to be a watermelon"
{
  const ua_private_b64u = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'; // ua = user agent = recipient
  const ua_public_b64u  = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const auth_secret_b64u = 'BTBZMqHH6r4Tts7J_aSIgg';
  const as_private_b64u = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'; // as = application server = sender
  const as_public_b64u  = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const salt_b64u = 'DGv6ra1nlYgDCS1FRnbzlw';
  const plaintext = Buffer.from('When I grow up, I want to be a watermelon', 'utf-8');
  // Expected: full output matches RFC 8291 §A.4 (147 bytes).
  const expected_b64u = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  const expected = b64urlDecode(expected_b64u);

  // Reconstruct the ECDH secret manually since we have both private keys.
  const ua_priv_raw = b64urlDecode(ua_private_b64u);
  const ua_pub_raw  = b64urlDecode(ua_public_b64u);
  const as_priv_raw = b64urlDecode(as_private_b64u);
  const as_pub_raw  = b64urlDecode(as_public_b64u);
  const authSecret  = b64urlDecode(auth_secret_b64u);
  const salt        = b64urlDecode(salt_b64u);

  const asEcdh = createECDH('prime256v1');
  asEcdh.setPrivateKey(as_priv_raw);
  // Confirm the curve recovers the same public point as the RFC publishes.
  assert.deepStrictEqual(asEcdh.getPublicKey(), as_pub_raw, 'as_public derived from as_private mismatch');
  const ecdhSecret = asEcdh.computeSecret(ua_pub_raw);

  const body = encryptWithMaterial({
    plaintext,
    clientPubRaw: ua_pub_raw,
    authSecret,
    serverPubRaw: as_pub_raw,
    ecdhSecret,
    salt,
  });

  assert.deepStrictEqual(body, expected, 'RFC 8291 KAT body mismatch\n  got:      ' + hex(body) + '\n  expected: ' + hex(expected));
  console.log('test 2 RFC 8291 §A KAT: ok (', body.length, 'B output matches spec)');
}

console.log('all tests passed');
