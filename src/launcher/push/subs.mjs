// Web Push subscription store. JSON file at ~/.claude/cc-viewer/launcher/
// push-subs.json, mode 0600. Atomic write via write-temp + rename.
//
// Single writer (the hub process). No file locking needed.

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { LAUNCHER_DATA_DIR, ensureLauncherDataDir } from '../runtime.mjs';
import { log } from '../log.mjs';

const SUBS_FILE = join(LAUNCHER_DATA_DIR, 'push-subs.json');
const SUBS_TMP = SUBS_FILE + '.tmp';

let _cache = null; // { version, subs: [...] }

function loadFromDisk() {
  ensureLauncherDataDir();
  if (!existsSync(SUBS_FILE)) {
    _cache = { version: 1, subs: [] };
    return _cache;
  }
  try {
    const raw = JSON.parse(readFileSync(SUBS_FILE, 'utf-8'));
    _cache = {
      version: raw.version || 1,
      subs: Array.isArray(raw.subs) ? raw.subs : [],
    };
  } catch (err) {
    log(`[push:sub] failed to parse ${SUBS_FILE}: ${err.message} — starting empty (old file preserved as .corrupt)`);
    try { renameSync(SUBS_FILE, SUBS_FILE + '.corrupt'); } catch {}
    _cache = { version: 1, subs: [] };
  }
  return _cache;
}

function persist() {
  if (!_cache) return;
  ensureLauncherDataDir();
  writeFileSync(SUBS_TMP, JSON.stringify(_cache, null, 2));
  try { chmodSync(SUBS_TMP, 0o600); } catch {}
  renameSync(SUBS_TMP, SUBS_FILE);
}

function getCache() {
  if (!_cache) loadFromDisk();
  return _cache;
}

// Add (or replace, by endpoint) a subscription tagged with subjectId so we
// can later filter "send only to subs that belong to subject X" — useful
// for the per-device self-test endpoint.
export function addSubscription(subjectId, sub, meta = {}) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error('addSubscription: bad subscription shape');
  }
  const c = getCache();
  const existingIdx = c.subs.findIndex(s => s.endpoint === sub.endpoint);
  const now = Date.now();
  const entry = {
    subjectId: String(subjectId || 'anon'),
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    userAgent: meta.userAgent || '',
    addedAt: existingIdx >= 0 ? (c.subs[existingIdx].addedAt || now) : now,
    updatedAt: now,
    lastOkAt: existingIdx >= 0 ? c.subs[existingIdx].lastOkAt : null,
    lastFailAt: null,
    lastFailStatus: null,
  };
  if (existingIdx >= 0) c.subs[existingIdx] = entry;
  else c.subs.push(entry);
  persist();
  log(`[push:sub] ${existingIdx >= 0 ? 'updated' : 'added'} endpoint=${shortEp(sub.endpoint)} subject=${entry.subjectId}`);
  return entry;
}

export function removeByEndpoint(endpoint, reason = '') {
  const c = getCache();
  const before = c.subs.length;
  c.subs = c.subs.filter(s => s.endpoint !== endpoint);
  if (c.subs.length !== before) {
    persist();
    log(`[push:sub] removed endpoint=${shortEp(endpoint)} reason=${reason || 'unspecified'}`);
    return true;
  }
  return false;
}

export function findByEndpoint(endpoint) {
  return getCache().subs.find(s => s.endpoint === endpoint) || null;
}

export function getAll() {
  return getCache().subs.slice();
}

export function getBySubject(subjectId) {
  return getCache().subs.filter(s => s.subjectId === String(subjectId));
}

// Record a successful send. Idempotent.
export function markOk(endpoint) {
  const c = getCache();
  const entry = c.subs.find(s => s.endpoint === endpoint);
  if (!entry) return;
  entry.lastOkAt = Date.now();
  entry.lastFailAt = null;
  entry.lastFailStatus = null;
  persist();
}

// Record a non-terminal failure (4xx that isn't 410/404, or 5xx). We keep
// the sub around for now — only 410/404 trigger hard removal.
export function markFailure(endpoint, statusCode) {
  const c = getCache();
  const entry = c.subs.find(s => s.endpoint === endpoint);
  if (!entry) return;
  entry.lastFailAt = Date.now();
  entry.lastFailStatus = statusCode;
  persist();
}

function shortEp(endpoint) {
  try { return new URL(endpoint).host + '/…'; } catch { return String(endpoint).slice(0, 40); }
}

// Test helper: blow away the on-disk file + in-memory cache. Not exported
// to the rest of the codebase, only used by tests.
export function _resetForTest() {
  try { if (existsSync(SUBS_FILE)) unlinkSync(SUBS_FILE); } catch {}
  _cache = null;
}
