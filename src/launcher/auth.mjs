// Pairing-code + HMAC-session auth for public hub access.
//
// Two paths bypass auth:
//  1. LAN requests (private IPv4 ranges + loopback) — local devices on the
//     same network as the hub are trusted, no cookie required.
//  2. Public requests must present `ccv_session` cookie matching an entry in
//     `approvedSessions`. Approval flow: user types 6-digit pair code in the
//     hub UI → handler moves the pending entry to approved + sets cookie.
//
// Sessions persist to ~/.claude/cc-viewer/sessions.json so the user's paired
// devices survive hub restarts. Pair codes are 5-min TTL, in-memory only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { log } from './log.mjs';

// pendingPairs: code → { code, userAgent, ip, createdAt }
export const pendingPairs = new Map();
// approvedSessions: sessionToken → { createdAt, userAgent, ip }
export const approvedSessions = new Map();

export const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // 5 min
export const SESSION_MAX_AGE = 30 * 24 * 3600;  // 30 days in seconds

const SESSIONS_FILE = join(homedir(), '.claude', 'cc-viewer', 'sessions.json');

export function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [token, info] of Object.entries(data)) {
      if (now - info.createdAt < SESSION_MAX_AGE * 1000) {
        approvedSessions.set(token, info);
      }
    }
    log(`loaded ${approvedSessions.size} sessions from disk`);
  } catch { /* file doesn't exist yet */ }
}

export function saveSessions() {
  try {
    const dir = join(homedir(), '.claude', 'cc-viewer');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(approvedSessions);
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) { log('saveSessions error:', err.message); }
}

export function generatePairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function cleanExpiredPairs() {
  const now = Date.now();
  for (const [code, p] of pendingPairs) {
    if (now - p.createdAt > PAIR_CODE_TTL_MS) pendingPairs.delete(code);
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

export function isLanIp(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.startsWith('192.168.') || v4.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(v4);
}

export function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

export function isAuthenticated(req) {
  // LAN requests skip auth
  if (isLanIp(getClientIp(req))) return true;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.ccv_session;
  return token && approvedSessions.has(token);
}

export function shortUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

// Stable subject id for PtySessionManager. Public requests carry the HMAC
// session cookie (one per paired device → per-device sessions). LAN requests
// have no cookie; we fall back to `lan:<ip>` so two devices on the same LAN
// don't share each other's session pool.
export function subjectIdFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.ccv_session) return 'sess:' + cookies.ccv_session;
  return 'lan:' + (getClientIp(req) || 'unknown');
}
