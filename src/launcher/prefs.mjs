// Launcher-side prefs (aliases + ccuse profile + tags + compact thresholds +
// worktree default) per cwd. Persisted to launcher-prefs.json next to ccv's
// runtime/ dir so symlinks survive ccv reinstalls. Indexed by cwd because pid
// is volatile and ccv's normalized projectName loses non-ASCII characters.
//
// Also exports `listCcuseProfiles` which discovers the user's zsh `ccuse`
// function — launchd-spawned hub doesn't source .zshrc so we shell out to an
// interactive zsh once per 60s and parse the function's usage line.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn as spawnAsync } from 'node:child_process';

import { log } from './log.mjs';

const LAUNCHER_PREFS_FILE = join(homedir(), '.claude', 'cc-viewer', 'launcher-prefs.json');
let _prefsCache = null;

function emptyPrefs() {
  return {
    aliases: {},
    ccuseProfiles: {},
    defaultCcuseProfile: '',
    tags: {},
    compactThresholds: {},
    worktreeDefault: false,
  };
}

export function loadPrefs() {
  if (_prefsCache) return _prefsCache;
  try {
    if (existsSync(LAUNCHER_PREFS_FILE)) {
      const raw = JSON.parse(readFileSync(LAUNCHER_PREFS_FILE, 'utf-8'));
      _prefsCache = {
        aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
        ccuseProfiles: raw.ccuseProfiles && typeof raw.ccuseProfiles === 'object' ? raw.ccuseProfiles : {},
        defaultCcuseProfile: typeof raw.defaultCcuseProfile === 'string' ? raw.defaultCcuseProfile : '',
        tags: raw.tags && typeof raw.tags === 'object' ? raw.tags : {},
        compactThresholds: raw.compactThresholds && typeof raw.compactThresholds === 'object' ? raw.compactThresholds : {},
        worktreeDefault: typeof raw.worktreeDefault === 'boolean' ? raw.worktreeDefault : false,
      };
    } else {
      _prefsCache = emptyPrefs();
    }
  } catch {
    _prefsCache = emptyPrefs();
  }
  return _prefsCache;
}

export function savePrefs() {
  try {
    const dir = dirname(LAUNCHER_PREFS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LAUNCHER_PREFS_FILE, JSON.stringify(_prefsCache || {}, null, 2));
  } catch (err) { log('savePrefs error:', err.message); }
}

// ---- aliases ----
// Match ccv's own normalization rule (seqResourceLoaders.js): strip control
// chars + bidi marks, collapse to space, trim, cap at 32 chars.
export function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  let prevSpace = false;
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    const isCtrl = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
                   (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (isCtrl) {
      if (!prevSpace) { out += ' '; prevSpace = true; }
    } else {
      out += ch;
      prevSpace = false;
    }
  }
  return out.trim().slice(0, 32);
}

export function getAlias(cwd) {
  if (!cwd) return '';
  return loadPrefs().aliases[cwd] || '';
}

export function setAlias(cwd, raw) {
  if (!cwd) return false;
  const prefs = loadPrefs();
  const normalized = normalizeAlias(raw);
  if (normalized) prefs.aliases[cwd] = normalized;
  else delete prefs.aliases[cwd];
  savePrefs();
  return true;
}

// ---- ccuse profile selection ----
export function getCcuseProfile(cwd) {
  const prefs = loadPrefs();
  return prefs.ccuseProfiles[cwd] || prefs.defaultCcuseProfile || '';
}

export function setCcuseProfile(cwd, profile) {
  const prefs = loadPrefs();
  if (profile) prefs.ccuseProfiles[cwd] = profile;
  else delete prefs.ccuseProfiles[cwd];
  savePrefs();
}

export function setDefaultCcuseProfile(profile) {
  const prefs = loadPrefs();
  prefs.defaultCcuseProfile = typeof profile === 'string' ? profile : '';
  savePrefs();
}

// ---- tags (H5) ----
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return '';
  // Tags are short labels; strip control chars, trim, cap at 24 chars.
  let out = '';
  let prevSpace = false;
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    const isCtrl = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
                   (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (isCtrl) {
      if (!prevSpace) { out += ' '; prevSpace = true; }
    } else {
      out += ch;
      prevSpace = false;
    }
  }
  return out.trim().slice(0, 24);
}

export function getTags(cwd) {
  if (!cwd) return [];
  const arr = loadPrefs().tags[cwd];
  return Array.isArray(arr) ? arr.slice() : [];
}

export function setTags(cwd, arr) {
  if (!cwd) return false;
  const prefs = loadPrefs();
  const normalized = Array.isArray(arr)
    ? Array.from(new Set(arr.map(normalizeTag).filter(Boolean)))
    : [];
  if (normalized.length) prefs.tags[cwd] = normalized;
  else delete prefs.tags[cwd];
  savePrefs();
  return true;
}

export function addTag(cwd, t) {
  if (!cwd) return false;
  const tag = normalizeTag(t);
  if (!tag) return false;
  const cur = getTags(cwd);
  if (cur.includes(tag)) return true;
  cur.push(tag);
  setTags(cwd, cur);
  return true;
}

export function removeTag(cwd, t) {
  if (!cwd) return false;
  const tag = normalizeTag(t);
  if (!tag) return false;
  const cur = getTags(cwd).filter(x => x !== tag);
  setTags(cwd, cur);
  return true;
}

export function getAllTags() {
  const prefs = loadPrefs();
  const seen = new Set();
  for (const arr of Object.values(prefs.tags || {})) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) seen.add(t);
  }
  return Array.from(seen).sort();
}

// ---- compact thresholds (M1) ----
export const DEFAULT_COMPACT_THRESHOLD = { auto_compact_at: 0, auto_clear_at: 0, enabled: false };

export function getCompactThreshold(cwd) {
  if (!cwd) return { ...DEFAULT_COMPACT_THRESHOLD };
  const raw = loadPrefs().compactThresholds[cwd];
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COMPACT_THRESHOLD };
  return {
    auto_compact_at: Number.isFinite(raw.auto_compact_at) ? raw.auto_compact_at : 0,
    auto_clear_at: Number.isFinite(raw.auto_clear_at) ? raw.auto_clear_at : 0,
    enabled: !!raw.enabled,
  };
}

export function setCompactThreshold(cwd, { auto_compact_at, auto_clear_at, enabled } = {}) {
  if (!cwd) return false;
  const prefs = loadPrefs();
  const ac = Number(auto_compact_at);
  const cl = Number(auto_clear_at);
  const next = {
    auto_compact_at: Number.isFinite(ac) && ac > 0 ? Math.floor(ac) : 0,
    auto_clear_at: Number.isFinite(cl) && cl > 0 ? Math.floor(cl) : 0,
    enabled: !!enabled,
  };
  // If everything is default, drop the entry to keep prefs file lean.
  if (!next.enabled && !next.auto_compact_at && !next.auto_clear_at) {
    delete prefs.compactThresholds[cwd];
  } else {
    prefs.compactThresholds[cwd] = next;
  }
  savePrefs();
  return true;
}

// ---- worktree default (M2) ----
export function getWorktreeDefault() {
  return !!loadPrefs().worktreeDefault;
}

export function setWorktreeDefault(value) {
  const prefs = loadPrefs();
  prefs.worktreeDefault = !!value;
  savePrefs();
}

// ---- ccuse profile discovery ----
// `ccuse` is a zsh function from the user's .zshrc that switches the active
// ANTHROPIC_* env vars (model, base_url, token) to point at different backends
// (official, idealab, deepseek, etc.). launchd-spawned hub doesn't source
// .zshrc, so we discover the profile list by running zsh interactively and
// parsing the function's "用法:" / "Usage:" line.
let _ccuseProfilesCache = null;
let _ccuseProfilesAt = 0;
const CCUSE_TTL_MS = 60_000;

export async function listCcuseProfiles() {
  const now = Date.now();
  if (_ccuseProfilesCache && now - _ccuseProfilesAt < CCUSE_TTL_MS) {
    return _ccuseProfilesCache;
  }
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawnAsync('/bin/zsh', ['-i', '-c', 'ccuse 2>&1; true'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', d => stdout += d.toString('utf-8'));
      p.stderr.on('data', d => stderr += d.toString('utf-8'));
      p.on('close', () => resolve(stdout + stderr));
      p.on('error', reject);
    });
    // Look for the usage line: 用法: ccuse {a|b|c|...}  or  Usage: ccuse {a|b|c}
    const m = out.match(/ccuse\s*\{([^}]+)\}/);
    if (m) {
      const list = m[1].split('|').map(s => s.trim()).filter(Boolean);
      _ccuseProfilesCache = list;
      _ccuseProfilesAt = now;
      return list;
    }
    _ccuseProfilesCache = [];
    _ccuseProfilesAt = now;
    return [];
  } catch (err) {
    log('listCcuseProfiles error:', err.message);
    return _ccuseProfilesCache || [];
  }
}
