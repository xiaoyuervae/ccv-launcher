// VAPID (RFC 8292) implementation — zero deps, node:crypto only.
//
// Generates / persists a P-256 ECDSA keypair to ~/.claude/cc-viewer/launcher/
// vapid.json (PEM-encoded, mode 0600). Each push request needs a fresh-ish
// JWT signed by that key, with `aud` = origin of the recipient endpoint
// (https://web.push.apple.com, https://fcm.googleapis.com, etc.). We cache
// the JWT per-aud for 11h so a flurry of pushes to the same service doesn't
// re-sign every time.
//
// CRITICAL: `crypto.sign('sha256', input, {key, dsaEncoding:'ieee-p1363'})`
// emits the raw 64-byte (r||s) signature that JWS ES256 mandates. The
// node:crypto default is DER, which APNs rejects as BadJwtToken. This is
// the most common landmine for hand-rolled VAPID — cloudcli uses the
// `web-push` package, we have to spell it out.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { LAUNCHER_DATA_DIR, ensureLauncherDataDir } from '../runtime.mjs';
import { log } from '../log.mjs';

const VAPID_FILE = join(LAUNCHER_DATA_DIR, 'vapid.json');
// 12h is well below APNs' 24h hard cap and gives clock-skew headroom.
const JWT_TTL_SEC = 12 * 3600;
// Refresh a cached JWT once it has < 1h of life left; gives us 11h reuse.
const JWT_REFRESH_BUFFER_SEC = 3600;

let _cached = null; // { privateKey: KeyObject, publicKey: KeyObject, publicKeyB64u: string }
const _jwtCache = new Map(); // aud -> { jwt, expiresAt }

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

// JWK x/y are 32-byte big-endian P-256 coordinates. Concatenate with the
// 0x04 prefix to get the raw 65-byte uncompressed point that pushManager.
// subscribe expects as applicationServerKey.
function jwkToRawPublicPoint(jwk) {
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`vapid: unexpected jwk coord length x=${x.length} y=${y.length}`);
  }
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function loadOrGenerate() {
  if (_cached) return _cached;
  ensureLauncherDataDir();
  let stored = null;
  if (existsSync(VAPID_FILE)) {
    try {
      stored = JSON.parse(readFileSync(VAPID_FILE, 'utf-8'));
    } catch (err) {
      log(`[push:vapid] failed to parse ${VAPID_FILE}: ${err.message} — regenerating`);
      stored = null;
    }
  }
  let privateKey, publicKey;
  if (stored && stored.privateKeyPem && stored.publicKeyPem) {
    privateKey = createPrivateKey({ key: stored.privateKeyPem, format: 'pem' });
    publicKey = createPublicKey({ key: stored.publicKeyPem, format: 'pem' });
  } else {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(VAPID_FILE, JSON.stringify({ version: 1, privateKeyPem, publicKeyPem, createdAt: Date.now() }, null, 2));
    try { chmodSync(VAPID_FILE, 0o600); } catch {}
    log(`[push:vapid] generated new keypair → ${VAPID_FILE}`);
  }
  const jwk = publicKey.export({ format: 'jwk' });
  const publicKeyRaw = jwkToRawPublicPoint(jwk);
  const publicKeyB64u = b64urlEncode(publicKeyRaw);
  _cached = { privateKey, publicKey, publicKeyRaw, publicKeyB64u };
  return _cached;
}

// VAPID public key as URL-safe base64 (no padding). This is what the browser
// passes to pushManager.subscribe as applicationServerKey, and what the push
// service uses to verify the JWT. MUST stay stable for the lifetime of any
// active subscription — if vapid.json is regenerated, every existing sub
// becomes invalid (403 UnauthorizedRegistration).
export function getPublicKeyB64u() {
  return loadOrGenerate().publicKeyB64u;
}

export function getPublicKeyRaw() {
  return loadOrGenerate().publicKeyRaw;
}

// Default subject is user's gmail (real TLD, mailto:). cloudcli's vapid-keys
// notes the exact landmine: .local TLDs get 403 BadJwtToken from APNs only.
// Allow env override for future deploys without code changes.
function getSubject() {
  const fromEnv = process.env.CCV_VAPID_SUBJECT;
  if (fromEnv && (fromEnv.startsWith('mailto:') || fromEnv.startsWith('https://'))) return fromEnv;
  return 'mailto:a749333894@gmail.com';
}

// Sign a fresh VAPID JWT for the given audience origin. `audOrigin` must be
// scheme + host (+ optional non-default port), no path, no trailing slash —
// e.g. "https://web.push.apple.com". new URL(endpoint).origin gives exactly
// this. Caches per-aud for ~11h so we don't re-sign on every push.
export function signVapidJwt(audOrigin) {
  if (!/^https:\/\/[^/]+$/.test(audOrigin) && !/^https:\/\/[^/]+:\d+$/.test(audOrigin)) {
    throw new Error(`vapid: bad audience "${audOrigin}" — must be origin only (no path / trailing slash)`);
  }
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(audOrigin);
  if (cached && cached.expiresAt - now > JWT_REFRESH_BUFFER_SEC) {
    return cached.jwt;
  }
  const { privateKey } = loadOrGenerate();
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = now + JWT_TTL_SEC;
  const payload = { aud: audOrigin, exp, sub: getSubject() };
  const headerB64u = b64urlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64u = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = Buffer.from(`${headerB64u}.${payloadB64u}`, 'utf-8');
  // dsaEncoding: 'ieee-p1363' → raw r||s (64 bytes), what JWS ES256 mandates.
  // Default 'der' would emit DER ASN.1 SEQUENCE → APNs rejects as bad sig.
  const sig = cryptoSign('sha256', signingInput, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  if (sig.length !== 64) {
    throw new Error(`vapid: unexpected sig length ${sig.length} (expected 64)`);
  }
  const jwt = `${headerB64u}.${payloadB64u}.${b64urlEncode(sig)}`;
  _jwtCache.set(audOrigin, { jwt, expiresAt: exp });
  return jwt;
}

// Eagerly load/generate the keypair (e.g. on serverStarted) so the first
// /push/subscribe request doesn't pay the generation cost.
export function preloadVapid() {
  loadOrGenerate();
}
