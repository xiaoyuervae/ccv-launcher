// launcher.mjs
// Hub plugin for cc-viewer. Only activates when CCV_HUB=1.
// Provides:
//   - GET  /launcher              → HTML dashboard
//   - GET  /api/launcher/list     → JSON of running ccv instances
//   - POST /api/launcher/spawn    → spawn a new ccv child for a given cwd
//   - POST /api/launcher/kill     → SIGTERM a child by pid
//
// Discovers other ccv instances by watching ~/.claude/cc-viewer/runtime/*.json
// produced by runtime-broadcast.mjs. Spawns children with CCV_HUB cleared so
// they do not become hubs themselves.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync, unlinkSync, watch, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

// cc-viewer ships workspace-registry.js at the install root (≤1.6.266) or
// under server/ (≥1.6.273 refactor); pty-session-manager.js used to live
// under lib/ but is missing from current published versions. Resolve
// workspace-registry by probing both locations; load pty-session-manager
// lazily inside installShellWebSocket so a missing file just disables
// /ws/shell instead of breaking plugin load. Override roots via CCV_LIB_DIR.
const CCV_LIB_DIR = process.env.CCV_LIB_DIR
  || dirname(realpathSync(process.argv[1]));
// Scoped require so bare names like 'node-pty' / 'ws' resolve from
// cc-viewer's node_modules (the plugin's own dir has no deps installed).
const ccvRequire = createRequire(
  pathToFileURL(join(CCV_LIB_DIR, 'package.json')).href
);
function resolveCcvFile(...candidates) {
  for (const rel of candidates) {
    const abs = join(CCV_LIB_DIR, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}
const _workspaceRegistryPath = resolveCcvFile('workspace-registry.js', 'server/workspace-registry.js');
if (!_workspaceRegistryPath) {
  throw new Error(`[ccv-launcher] workspace-registry.js not found under ${CCV_LIB_DIR} (tried root and server/). Set CCV_LIB_DIR to the cc-viewer install root.`);
}
const { getWorkspaces, removeWorkspace } = await import(
  pathToFileURL(_workspaceRegistryPath).href
);
// PtySessionManager loaded lazily — see installShellWebSocket.
let PtySessionManager = null;
async function ensurePtySessionManager() {
  if (PtySessionManager) return PtySessionManager;
  const p = resolveCcvFile('lib/pty-session-manager.js', 'server/lib/pty-session-manager.js', 'pty-session-manager.js');
  if (!p) return null;
  try {
    const mod = await import(pathToFileURL(p).href);
    PtySessionManager = mod.PtySessionManager;
    return PtySessionManager;
  } catch {
    return null;
  }
}

const PREFIX = '[ccv-launcher]';
const HUB_ENABLED = process.env.CCV_HUB === '1';
const RUNTIME_DIR = join(homedir(), '.claude', 'cc-viewer', 'runtime');
// Public URL template for child instances exposed via a reverse proxy.
// When unset, buildPublicUrl returns '' and the UI shows only the LAN URL.
// Placeholders: {port} {token} {host} {ip}. Example:
//   CCV_PUBLIC_URL_TEMPLATE='https://ccv-{port}.example.com:9990/?token={token}'
const PUBLIC_TEMPLATE = process.env.CCV_PUBLIC_URL_TEMPLATE || '';
// Children land in CCV_CHILD_PORT_FLOOR..CEIL (default 7008-7099) so a
// reverse-proxy rule like `ccv-(FLOOR-CEIL).<domain>` can match them. The
// hub itself runs on 7100 (outside that range) and is typically reached
// via its own dedicated subdomain, so children don't collide with it.
const HUB_PORT_FLOOR = parseInt(process.env.CCV_CHILD_PORT_FLOOR || '7008', 10);
const HUB_PORT_CEIL = parseInt(process.env.CCV_CHILD_PORT_CEIL || '7099', 10);
const SPAWN_TIMEOUT_MS = 15000;

// ---------- pairing auth ----------
// pendingPairs: code → { code, userAgent, ip, createdAt }
const pendingPairs = new Map();
// approvedSessions: sessionToken → { createdAt, userAgent, ip }
const approvedSessions = new Map();
const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // 5 min
const SESSION_MAX_AGE = 30 * 24 * 3600;  // 30 days in seconds
const SESSIONS_FILE = join(homedir(), '.claude', 'cc-viewer', 'sessions.json');
// launcher-side prefs (aliases + ccuse profile per cwd). Lives next to the
// runtime/ dir so symlinks survive ccv reinstalls. Indexed by cwd because pid
// is volatile and projectName is normalized (loses Chinese characters).
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

function loadPrefs() {
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

function savePrefs() {
  try {
    const dir = dirname(LAUNCHER_PREFS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LAUNCHER_PREFS_FILE, JSON.stringify(_prefsCache || {}, null, 2));
  } catch (err) { log('savePrefs error:', err.message); }
}

function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  // Match ccv's own normalization rule (seqResourceLoaders.js): strip control
  // chars + bidi marks, collapse to space, trim, cap at 32 chars.
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

function getAlias(cwd) {
  if (!cwd) return '';
  return loadPrefs().aliases[cwd] || '';
}

function setAlias(cwd, raw) {
  if (!cwd) return false;
  const prefs = loadPrefs();
  const normalized = normalizeAlias(raw);
  if (normalized) prefs.aliases[cwd] = normalized;
  else delete prefs.aliases[cwd];
  savePrefs();
  return true;
}

function getCcuseProfile(cwd) {
  const prefs = loadPrefs();
  return prefs.ccuseProfiles[cwd] || prefs.defaultCcuseProfile || '';
}

function setCcuseProfile(cwd, profile) {
  const prefs = loadPrefs();
  if (profile) prefs.ccuseProfiles[cwd] = profile;
  else delete prefs.ccuseProfiles[cwd];
  savePrefs();
}

function setDefaultCcuseProfile(profile) {
  const prefs = loadPrefs();
  prefs.defaultCcuseProfile = typeof profile === 'string' ? profile : '';
  savePrefs();
}

// ---- tags (H5) ----
function normalizeTag(raw) {
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

function getTags(cwd) {
  if (!cwd) return [];
  const arr = loadPrefs().tags[cwd];
  return Array.isArray(arr) ? arr.slice() : [];
}

function setTags(cwd, arr) {
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

function addTag(cwd, t) {
  if (!cwd) return false;
  const tag = normalizeTag(t);
  if (!tag) return false;
  const cur = getTags(cwd);
  if (cur.includes(tag)) return true;
  cur.push(tag);
  setTags(cwd, cur);
  return true;
}

function removeTag(cwd, t) {
  if (!cwd) return false;
  const tag = normalizeTag(t);
  if (!tag) return false;
  const cur = getTags(cwd).filter(x => x !== tag);
  setTags(cwd, cur);
  return true;
}

function getAllTags() {
  const prefs = loadPrefs();
  const seen = new Set();
  for (const arr of Object.values(prefs.tags || {})) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) seen.add(t);
  }
  return Array.from(seen).sort();
}

// ---- compact thresholds (M1) ----
const DEFAULT_COMPACT_THRESHOLD = { auto_compact_at: 0, auto_clear_at: 0, enabled: false };

function getCompactThreshold(cwd) {
  if (!cwd) return { ...DEFAULT_COMPACT_THRESHOLD };
  const raw = loadPrefs().compactThresholds[cwd];
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COMPACT_THRESHOLD };
  return {
    auto_compact_at: Number.isFinite(raw.auto_compact_at) ? raw.auto_compact_at : 0,
    auto_clear_at: Number.isFinite(raw.auto_clear_at) ? raw.auto_clear_at : 0,
    enabled: !!raw.enabled,
  };
}

function setCompactThreshold(cwd, { auto_compact_at, auto_clear_at, enabled } = {}) {
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
function getWorktreeDefault() {
  return !!loadPrefs().worktreeDefault;
}

function setWorktreeDefault(value) {
  const prefs = loadPrefs();
  prefs.worktreeDefault = !!value;
  savePrefs();
}

// ---------- ccuse profile discovery ----------
// `ccuse` is a zsh function from the user's .zshrc that switches the active
// ANTHROPIC_* env vars (model, base_url, token) to point at different backends
// (official, idealab, deepseek, etc.). launchd-spawned hub doesn't source
// .zshrc, so we discover the profile list by running zsh interactively and
// parsing the function's "用法:" / "Usage:" line.
let _ccuseProfilesCache = null;
let _ccuseProfilesAt = 0;
const CCUSE_TTL_MS = 60_000;

async function listCcuseProfiles() {
  const now = Date.now();
  if (_ccuseProfilesCache && now - _ccuseProfilesAt < CCUSE_TTL_MS) {
    return _ccuseProfilesCache;
  }
  try {
    // zsh -i -c 'ccuse' (no arg) prints usage with profile list
    const { spawn: spawnAsync } = await import('node:child_process');
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

function loadSessions() {
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

function saveSessions() {
  try {
    const dir = join(homedir(), '.claude', 'cc-viewer');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(approvedSessions);
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) { log('saveSessions error:', err.message); }
}

function generatePairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanExpiredPairs() {
  const now = Date.now();
  for (const [code, p] of pendingPairs) {
    if (now - p.createdAt > PAIR_CODE_TTL_MS) pendingPairs.delete(code);
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function isLanIp(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.startsWith('192.168.') || v4.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(v4);
}

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

function isAuthenticated(req) {
  // LAN requests skip auth
  if (isLanIp(getClientIp(req))) return true;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.ccv_session;
  return token && approvedSessions.has(token);
}

function shortUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

// in-memory instance map: pid → runtime payload (with augmented urls / status)
const instances = new Map();
let _selfPort = null;
let _selfToken = null;

function log(...args) { console.error(PREFIX, ...args); }

// Structured JSON log: one record per line on stderr (captured by launchd's
// stderr.log). Use for events that ops/monitoring should be able to parse,
// e.g. ws-shell-spawn, ws-shell-cap-hit, healthz. `event` is required;
// additional fields are merged in.
function jlog(event, fields = {}) {
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  } catch { /* ignore stringify failures */ }
}

// Cap concurrent /ws/shell sessions per process. Each PTY holds a zsh + node
// listeners; on a public hub we want a hard ceiling so a runaway client (or
// pathological reconnect storm) can't exhaust file descriptors / RAM.
// SHELL_PTY_CAP is now a soft pre-check before the manager spawns; the
// manager itself enforces MAX_PTY_TOTAL=10 (and 3/subject) authoritatively.
// We keep this as an early-reject so a caller saturating the cap gets a
// 1013 close before allocating ws+pty bookkeeping.
const SHELL_PTY_CAP = parseInt(process.env.CCV_SHELL_PTY_CAP || '8', 10);
// Reference to the /ws/shell WebSocketServer once installed; null until then.
// Used by /healthz to report `wsCount = wss.clients.size`. Kept at module
// scope (not closed-over) so the route handler can read it without plumbing.
let _shellWss = null;
// PtySessionManager singleton (PB3). Constructed lazily inside
// installShellWebSocket so node-pty/ws resolution failures are isolated to
// /ws/shell setup, not the whole plugin.
let _ptyManager = null;

// Stable subject id for PtySessionManager. Public requests carry the HMAC
// session cookie (one per paired device → per-device sessions). LAN requests
// have no cookie; we fall back to `lan:<ip>` so two devices on the same LAN
// don't share each other's session pool.
function subjectIdFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.ccv_session) return 'sess:' + cookies.ccv_session;
  return 'lan:' + (getClientIp(req) || 'unknown');
}

function safeJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

function buildPublicUrl(entry) {
  if (!PUBLIC_TEMPLATE) return '';
  return renderTemplate(PUBLIC_TEMPLATE, {
    port: entry.port ?? '',
    token: entry.token ?? '',
    host: entry.ip ?? '',
    ip: entry.ip ?? '',
  });
}

function buildLanUrl(entry) {
  if (!entry.port) return null;
  const protocol = entry.protocol || 'http';
  const host = entry.ip || '127.0.0.1';
  return `${protocol}://${host}:${entry.port}?token=${entry.token || ''}`;
}

function loadRuntimeFile(file) {
  const filePath = join(RUNTIME_DIR, file);
  const data = safeJson(filePath);
  if (!data || typeof data !== 'object' || !data.pid) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
    return null;
  }
  if (!pidAlive(data.pid)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
    return null;
  }
  data.status = 'running';
  data.publicUrl = buildPublicUrl(data);
  data.lanUrl = buildLanUrl(data);
  return data;
}

function rescanRuntime() {
  try {
    if (!existsSync(RUNTIME_DIR)) { mkdirSync(RUNTIME_DIR, { recursive: true }); return; }
    const files = readdirSync(RUNTIME_DIR).filter(f => f.endsWith('.json'));
    const seen = new Set();
    for (const file of files) {
      const entry = loadRuntimeFile(file);
      if (!entry) continue;
      seen.add(entry.pid);
      // Self-registered runtime files always win — overwrites any prior backfill stub.
      const prev = instances.get(entry.pid);
      if (prev?.external) _externalPids.delete(entry.pid);
      instances.set(entry.pid, entry);
    }
    // drop any in-memory instance whose runtime file vanished — but keep external
    // backfill entries (they're tracked by their own liveness check).
    for (const pid of [...instances.keys()]) {
      if (seen.has(pid)) continue;
      if (_externalPids.has(pid)) continue;
      instances.delete(pid);
    }
  } catch (err) {
    log('rescanRuntime error:', err.message);
  }
}

// External ccv backfill — discovers ccv processes that started before the
// runtime-broadcast plugin was installed and never wrote runtime/<pid>.json.
// Loopback (127.0.0.1) is exempt from token validation in ccv (server.js:410),
// so we can pull /api/version-info, /api/local-url, /api/project-name from
// the unregistered ccv to reconstruct a synthetic instance entry.
const _externalPids = new Set();
let _backfillInflight = null;
let _backfillLastAt = 0;
const BACKFILL_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 600;

async function probeCcv(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const r = await fetch(`http://127.0.0.1:${port}/api/version-info`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const v = await r.json();
    // Require ccv-shaped semver to avoid false positives from other local
    // services exposing /api/version-info (seen: AliEntSafe at port 64555
    // returned {version:"1.0", result:501, ...}). ccv versions are 3-tuple.
    if (!v || typeof v.version !== 'string' || !/^\d+\.\d+\.\d+/.test(v.version)) return null;
    // Pull URL (with token) + project name in parallel
    const [urlR, nameR] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/local-url`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`http://127.0.0.1:${port}/api/project-name`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    // Both endpoints exist on ccv ≥1.6; if local-url is missing the token, this
    // is probably not a ccv we can talk to.
    if (!urlR || typeof urlR.url !== 'string' || !urlR.url.includes('token=')) return null;
    let token = '';
    let host = '127.0.0.1';
    let ip = '127.0.0.1';
    try {
      const u = new URL(urlR.url);
      token = u.searchParams.get('token') || '';
      host = u.hostname;
      ip = u.hostname;
    } catch {}
    return {
      version: v.version,
      token,
      host,
      ip,
      projectName: nameR?.projectName || '',
    };
  } catch { return null; }
}

function listListeningNodePids() {
  // `lsof -nP -iTCP -sTCP:LISTEN -c node -F pcn` returns records like
  //   p<pid>\nc<command>\nn*:<port>\n
  // -F is parseable; we only need pid + port pairs.
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-c', 'node', '-F', 'pn'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
    const result = []; // {pid, port}
    let curPid = null;
    for (const line of out.split('\n')) {
      if (!line) continue;
      const tag = line[0]; const val = line.slice(1);
      if (tag === 'p') curPid = parseInt(val, 10) || null;
      else if (tag === 'n' && curPid) {
        // n*:7008 or n[::1]:7008 or n127.0.0.1:7008
        const m = val.match(/:(\d+)$/);
        if (m) result.push({ pid: curPid, port: parseInt(m[1], 10) });
      }
    }
    return result;
  } catch { return []; }
}

function readPidCwd(pid) {
  try {
    // macOS lsof OR's selectors by default; -a forces AND so we get only cwd
    // entries for the requested pid (otherwise we get every process's cwd).
    // Force UTF-8 locale so non-ASCII path bytes aren't backslash-escaped
    // (launchd doesn't inherit LANG/LC_ALL — without this, lsof falls back to
    // POSIX/C locale and emits literal "\xNN" sequences for Chinese chars).
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1);
    }
  } catch {}
  return '';
}

function readPidStartedMs(pid) {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

async function backfillExternalCcvs(force = false) {
  const now = Date.now();
  if (!force && now - _backfillLastAt < BACKFILL_TTL_MS) return;
  if (_backfillInflight) return _backfillInflight;
  _backfillInflight = (async () => {
    try {
      const listeners = listListeningNodePids();
      // Skip pids already registered via runtime file
      const candidates = listeners.filter(({ pid }) => {
        const inst = instances.get(pid);
        return !inst || inst.external;
      });
      const seenExternal = new Set();
      // Probe in parallel, modest fan-out
      await Promise.all(candidates.map(async ({ pid, port }) => {
        const probe = await probeCcv(port);
        if (!probe) return;
        seenExternal.add(pid);
        const existing = instances.get(pid);
        // Don't overwrite a registered instance (shouldn't happen given the filter above, defensive)
        if (existing && !existing.external) return;
        const cwd = existing?.cwd || readPidCwd(pid);
        const startedMs = existing?.startedAtMs || readPidStartedMs(pid);
        const proto = 'http';
        const localUrl = `${proto}://127.0.0.1:${port}`;
        const lanUrl = probe.token ? `${proto}://${probe.ip}:${port}?token=${probe.token}` : '';
        const synthEntry = {
          pid,
          port,
          host: probe.host,
          ip: probe.ip,
          protocol: proto,
          token: probe.token,
        };
        const publicUrl = buildPublicUrl(synthEntry);
        instances.set(pid, {
          pid,
          port,
          host: probe.host,
          ip: probe.ip,
          protocol: proto,
          token: probe.token,
          cwd,
          projectName: probe.projectName,
          displayName: cwd ? basename(cwd) : (probe.projectName || ''),
          startedAt: startedMs ? new Date(startedMs).toISOString() : null,
          startedAtMs: startedMs,
          version: probe.version,
          isHub: false,
          external: true,
          localUrl,
          lanUrl,
          publicUrl,
          status: 'running',
        });
        _externalPids.add(pid);
      }));
      // Drop external entries no longer listening
      for (const pid of [..._externalPids]) {
        if (!seenExternal.has(pid)) {
          _externalPids.delete(pid);
          const inst = instances.get(pid);
          if (inst?.external) instances.delete(pid);
        }
      }
      _backfillLastAt = Date.now();
    } catch (err) {
      log('backfillExternalCcvs error:', err.message);
    } finally {
      _backfillInflight = null;
    }
  })();
  return _backfillInflight;
}


// ---- Local CC sessions (claude CLI processes not running under ccv) ----
// Scans `ps` for `claude --session-id <uuid> --resume <jsonl>` lines that are
// NOT being intercepted by ccv (no ANTHROPIC_BASE_URL=127.0.0.1 in --settings).
// These represent interactive claude sessions the user started directly in a
// terminal — invisible to the launcher today. Listing them lets the user
// "take over" by killing the bare claude and relaunching under ccv with
// --resume, so future activity gets recorded.

const _localCcCache = { at: 0, list: [] };
const LOCAL_CC_CACHE_TTL_MS = 5000;
const _firstEntryCwdCache = new Map(); // jsonlPath -> { mtime, cwd }

// Decode a Claude Code project-dir name like "-Users-dayuer-Foo-Bar" back into
// "/Users/dayuer/Foo/Bar". Lossy for non-alphanumeric chars (CJK etc are
// flattened to "-"), so we only fall back to this when reading the jsonl's
// first entry fails — the jsonl carries the real cwd verbatim.
function decodeProjectDirName(name) {
  if (!name || typeof name !== 'string') return '';
  // Leading "-" denotes the absolute path's leading "/", so just replace.
  return name.replace(/-/g, '/');
}

function readJsonlCwd(jsonlPath) {
  try {
    const st = statSync(jsonlPath);
    const cached = _firstEntryCwdCache.get(jsonlPath);
    if (cached && cached.mtime === st.mtimeMs) return cached.cwd;
    const fd = openSync(jsonlPath, 'r');
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    let cwd = '';
    // Scan early entries — the first jsonl line is often a "last-prompt"
    // metadata record without cwd; the field appears on user/attachment
    // entries a few lines in. Take the first cwd we see.
    const lines = buf.toString('utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.cwd === 'string' && obj.cwd) { cwd = obj.cwd; break; }
      } catch { /* truncated tail line — keep scanning */ }
    }
    _firstEntryCwdCache.set(jsonlPath, { mtime: st.mtimeMs, cwd });
    return cwd;
  } catch { return ''; }
}

// Read just the timestamp of the *last* jsonl entry — used as "last activity"
// signal for the local CC session. Tail a small window (4KB usually fits one
// entry's metadata) and parse the final newline-terminated JSON.
function readJsonlLastTimestamp(jsonlPath) {
  try {
    const st = statSync(jsonlPath);
    if (st.size === 0) return null;
    const fd = openSync(jsonlPath, 'r');
    const len = Math.min(st.size, 16 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const ts = obj?.timestamp || obj?.ts || obj?.time;
        if (ts) return new Date(ts).toISOString();
      } catch { /* try previous line */ }
    }
    return new Date(st.mtimeMs).toISOString();
  } catch { return null; }
}

function readPidLstart(pid) {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8', timeout: 1500 }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch { return null; }
}

function listLocalCcSessions(force = false) {
  const now = Date.now();
  if (!force && now - _localCcCache.at < LOCAL_CC_CACHE_TTL_MS) return _localCcCache.list;
  let psOut = '';
  try {
    psOut = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
  } catch (err) {
    log('listLocalCcSessions ps error:', err.message);
    return _localCcCache.list;
  }
  const out = [];
  const seen = new Set();
  for (const rawLine of psOut.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    // bg-pty-host / bg-spare are claude's own supervisor/worker processes,
    // not user-facing sessions — skip even when their command line contains
    // a passed-through --session-id after the "--" separator.
    if (/--bg-pty-host\b|--bg-spare\b/.test(line)) continue;
    if (/\bdaemon\s+run\b/.test(line)) continue;
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (!/\bclaude\b/.test(cmd) && !/\/share\/claude\//.test(cmd)) continue;
    const sidM = cmd.match(/--session-id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const resM = cmd.match(/--resume\s+(\S+)/);
    if (!sidM || !resM) continue;
    const sessionId = sidM[1];
    const jsonlPath = resM[1];
    // Skip ones already running under a ccv interceptor — the auth proxy
    // listens on 127.0.0.1:<port>, so its presence in --settings means
    // ccv is already capturing this session.
    const intercepted = /ANTHROPIC_BASE_URL[^"]*"\s*:\s*"http:\/\/127\.0\.0\.1/.test(cmd);
    if (intercepted) continue;
    // De-dupe: same session-id can appear under bg-pty-host parent + child;
    // bg-pty-host already filtered, but two foreground claudes with same id
    // (e.g. fork-session retries) would collapse here.
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    let cwd = readJsonlCwd(jsonlPath);
    if (!cwd) {
      // jsonl unreadable — fall back to lossy decode from project dir name
      const projDir = basename(dirname(jsonlPath));
      cwd = decodeProjectDirName(projDir);
    }
    out.push({
      pid,
      sessionId,
      jsonlPath,
      cwd,
      startedAt: readPidLstart(pid),
      lastEntryAt: readJsonlLastTimestamp(jsonlPath),
    });
  }
  // Newest activity first
  out.sort((a, b) => {
    const ta = a.lastEntryAt ? Date.parse(a.lastEntryAt) : 0;
    const tb = b.lastEntryAt ? Date.parse(b.lastEntryAt) : 0;
    return tb - ta;
  });
  _localCcCache.at = now;
  _localCcCache.list = out;
  return out;
}

// Spawn `ccv ...` in a new macOS Terminal.app window at cwd. Used by takeover
// so the user gets a visible interactive ccv terminal where claude resumes.
// `extraArgs` are appended after `ccv`, before --d (kept last so user can see
// permission-skip behavior is intentional).
function spawnCcvInTerminal(cwd, extraArgs = []) {
  if (!cwd || !existsSync(cwd)) throw new Error('cwd does not exist');
  // Hard reject anything that would let the args break out of single quotes.
  const safeArgs = extraArgs.map(a => {
    if (typeof a !== 'string') throw new Error('extraArgs must be strings');
    if (/[\\'"`$]|[\x00-\x1f]/.test(a)) throw new Error('extraArgs contain unsafe chars: ' + a);
    return a;
  });
  // Profile resolution mirrors doSpawn — honor per-cwd ccuse profile so the
  // resumed claude uses the same backend the user picked for this project.
  const profile = getCcuseProfile(cwd);
  const safeProfile = profile ? profile.replace(/[^a-zA-Z0-9_\-.]/g, '') : '';
  const ccvArgs = [...safeArgs, '--d'].join(' ');
  // Build the shell command. Single-quote the cwd; safeArgs already validated.
  const quotedCwd = "'" + cwd.replace(/'/g, "'\\''") + "'";
  const profilePart = safeProfile ? `ccuse ${safeProfile} && ` : '';
  const shellCmd = `cd ${quotedCwd} && ${profilePart}ccv ${ccvArgs}`;
  // AppleScript needs double-quotes escaped
  const appleEscaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal" to do script "${appleEscaped}"\nactivate application "Terminal"`;
  execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 4000 });
}

// SIGTERM, then SIGKILL after a short grace period if still alive. Used by
// takeover to evict the bare claude process before relaunching under ccv.
async function killClaudePid(pid) {
  if (!Number.isFinite(pid) || pid <= 1) throw new Error('invalid pid');
  try { process.kill(pid, 'SIGTERM'); } catch (err) {
    if (err.code === 'ESRCH') return; // already gone
    throw err;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch (err) {
      if (err.code === 'ESRCH') return;
    }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone or no perm */ }
}


function startWatcher() {
  try {
    if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
    const watcher = watch(RUNTIME_DIR, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      const filePath = join(RUNTIME_DIR, filename);
      try {
        if (existsSync(filePath)) {
          const entry = loadRuntimeFile(filename);
          if (entry) instances.set(entry.pid, entry);
        } else {
          // file removed → drop matching pid (filename is "<pid>.json")
          const pid = parseInt(basename(filename, '.json'), 10);
          if (Number.isFinite(pid)) instances.delete(pid);
        }
      } catch (err) {
        log('watcher event error:', err.message);
      }
    });
    watcher.unref?.();
  } catch (err) {
    log('startWatcher error:', err.message);
  }
}

// ---------- spawn (serialized) ----------

let _spawnQueue = Promise.resolve();
function serializeSpawn(fn) {
  const next = _spawnQueue.then(fn, fn);
  _spawnQueue = next.catch(() => { /* swallow to keep queue alive */ });
  return next;
}

function nextFreePort() {
  // collect ports already claimed by live children
  const taken = new Set([_selfPort].filter(Boolean));
  for (const entry of instances.values()) {
    if (entry && entry.port) taken.add(entry.port);
  }
  for (let p = HUB_PORT_FLOOR; p <= HUB_PORT_CEIL; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error(`No free port in [${HUB_PORT_FLOOR}, ${HUB_PORT_CEIL}]`);
}

function findRunningByCwd(cwd) {
  for (const entry of instances.values()) {
    if (entry && entry.cwd === cwd) return entry;
  }
  return null;
}

function waitForChildRuntime(pid, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const existing = instances.get(pid);
      if (existing) return resolve(existing);
      if (!pidAlive(pid)) return reject(new Error('child exited before announcing runtime'));
      if (Date.now() > deadline) return reject(new Error('timed out waiting for child runtime broadcast'));
      setTimeout(check, 200).unref?.();
    };
    check();
  });
}

async function doSpawn(targetCwd, { force = false, ccuseProfile = '' } = {}) {
  if (!targetCwd || typeof targetCwd !== 'string') throw new Error('cwd required');
  if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    throw new Error('cwd is not an existing directory');
  }
  // Normalize symlinks so e.g. "/tmp/x" and "/private/tmp/x" map to the same
  // dedup key. runtime/<pid>.json stores process.cwd() which on macOS is
  // already the resolved path, so without this dedup misses on user input
  // that traverses /tmp, /var, etc.
  try { targetCwd = realpathSync(targetCwd); } catch { /* keep original */ }
  if (!force) {
    const existing = findRunningByCwd(targetCwd);
    if (existing) return existing;
  }

  const port = nextFreePort();
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error('cannot resolve ccv CLI entry');
  // Clear CCV_HUB so the child does not also become a hub (recursion guard).
  // Pin CCV_MAX_PORT to HUB_PORT_CEIL so the child cannot drift past 7099 and
  // steal the hub's 7100 if all child ports are momentarily busy.
  const env = {
    ...process.env,
    CCV_HUB: '',
    CCV_START_PORT: String(port),
    CCV_MAX_PORT: String(HUB_PORT_CEIL),
  };
  // Inherit CCV_PUBLIC_URL_TEMPLATE so children produce matching public URLs.

  // ccuse integration: launchd-spawned hub doesn't source .zshrc, so the user's
  // `ccuse` zsh function (which exports ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL to
  // pick a backend) isn't accessible via plain `spawn`. When a profile is
  // requested for this cwd (or as the launcher default), wrap the child launch
  // in `zsh -i -c 'ccuse <profile> && exec node cli.js ...'` so .zshrc gets
  // sourced first. Falls through to direct spawn when no profile is set.
  const profile = ccuseProfile || getCcuseProfile(targetCwd);
  let child;
  if (profile) {
    // Properly quote the profile name for zsh
    const safeProfile = profile.replace(/[^a-zA-Z0-9_\-.]/g, '');
    if (safeProfile !== profile) {
      throw new Error(`ccuse profile "${profile}" contains invalid characters`);
    }
    const shellCmd = `ccuse ${safeProfile} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} --d --no-open`;
    child = spawn('/bin/zsh', ['-i', '-c', shellCmd], {
      cwd: targetCwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } else {
    child = spawn(process.execPath, [cliPath, '--d', '--no-open'], {
      cwd: targetCwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  }
  child.stdout?.on('data', () => {}); // drain
  child.stderr?.on('data', () => {}); // drain
  child.unref();

  try {
    const entry = await waitForChildRuntime(child.pid, SPAWN_TIMEOUT_MS);
    // If we wrapped via zsh, child.pid is the zsh shell, not the actual ccv
    // node process. waitForChildRuntime polls runtime/<pid>.json which is keyed
    // by the *real* ccv process pid (set inside runtime-broadcast.mjs at
    // serverStarted), so it returns the right entry — we just need to remember
    // we may not be able to SIGTERM child.pid directly later.
    return entry;
  } catch (err) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw err;
  }
}

// ---------- HTTP routes via beforeRequest hook ----------

const PAIR_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ccv launcher — pair</title>
<style>
  :root { --bg:#0d1117; --fg:#e6edf3; --mute:#7d8590; --line:#21262d; --card:#161b22; --accent:#58a6ff; --ok:#3fb950; --bad:#f85149; }
  * { box-sizing:border-box; margin:0; }
  body { font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; background:var(--bg); color:var(--fg); min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .wrap { text-align:center; max-width:360px; padding:24px; }
  h1 { font-size:18px; font-weight:600; margin-bottom:8px; }
  .sub { color:var(--mute); font-size:13px; margin-bottom:32px; }
  .code-box { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; margin-bottom:24px; }
  .code { font-size:42px; font-weight:700; letter-spacing:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); }
  .status { color:var(--mute); font-size:12px; margin-top:12px; }
  .status.ok { color:var(--ok); }
  .status.err { color:var(--bad); }
  .hint { color:var(--mute); font-size:12px; line-height:1.6; }
  .spinner { display:inline-block; width:14px; height:14px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; vertical-align:middle; margin-right:6px; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>ccv launcher</h1>
  <p class="sub">Pair this device to access the launcher</p>
  <div class="code-box">
    <div class="code" id="code">------</div>
    <div class="status" id="status"><span class="spinner"></span>Generating code…</div>
  </div>
  <p class="hint">Open the launcher on your computer (LAN) and approve this pairing code. The code expires in 5 minutes.</p>
</div>
<script>
(async () => {
  const codeEl = document.getElementById('code');
  const statusEl = document.getElementById('status');
  try {
    const res = await fetch('/api/launcher/pair-request', { method: 'POST' });
    const data = await res.json();
    if (!data.code) throw new Error('no code');
    codeEl.textContent = data.code;
    statusEl.innerHTML = '<span class="spinner"></span>Waiting for approval…';
    // poll
    const poll = async () => {
      try {
        const r = await fetch('/api/launcher/pair-status?code=' + data.code);
        const s = await r.json();
        if (s.approved && s.redirect) {
          statusEl.className = 'status ok';
          statusEl.textContent = 'Approved! Redirecting…';
          window.location.href = s.redirect;
          return;
        }
        if (s.expired) {
          statusEl.className = 'status err';
          statusEl.textContent = 'Code expired. Refresh to try again.';
          return;
        }
      } catch {}
      setTimeout(poll, 2000);
    };
    poll();
  } catch (e) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Failed: ' + e.message;
  }
})();
</script>
</body>
</html>`;

// ---------- activity probe ----------
// Each ccv writes its session log under LOG_DIR/<projectName>/<projectName>_<ts>.jsonl
// where every line is one Anthropic API request (with response or partial response).
// We tail the most recent log file for a given instance and derive a high-level
// "what is it doing" from the last few entries.
const LOG_DIR = join(homedir(), '.claude', 'cc-viewer');
const ACTIVITY_TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVITY_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const ACTIVITY_CACHE_TTL_MS = 1500;
const _activityCache = new Map(); // pid -> { at, signature, payload }

// Match ccv's projectName normalization (interceptor.js:314): replace anything
// outside [a-zA-Z0-9_\-\.] with '_'. We need this because runtime-broadcast.mjs
// records the raw basename(cwd) (e.g. "fbi报表") while ccv writes logs under the
// normalized name ("fbi__"); finding the active log file requires matching the
// dir on disk, not the raw basename.
function ccvProjectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  return basename(cwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function findActiveLogFile(projectName, afterMs) {
  if (!projectName) return null;
  const dir = join(LOG_DIR, projectName);
  if (!existsSync(dir)) return null;  let candidates;
  try {
    candidates = readdirSync(dir)
      .filter(f => /^.+_\d{8}_\d{6}\.jsonl$/.test(f))
      .map(f => {
        const fp = join(dir, f);
        try {
          const st = statSync(fp);
          return { path: fp, mtime: st.mtimeMs, size: st.size };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return null; }
  if (!candidates.length) return null;
  // Most likely the most recently modified file is the one this pid writes to.
  // afterMs (instance startedAt) is a tie-breaker but not a hard filter — log
  // file timestamps are in filename only, mtime tracks last write.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

// Parse "<projectName>_YYYYMMDD_HHMMSS.jsonl" → ms since epoch (local time).
// ccv writes filenames with the timestamp of the first request that lands in
// that file, so this is a stable proxy for "when this session started".
function parseJsonlFilenameTime(filePath) {
  const m = basename(filePath).match(/_(\d{8})_(\d{6})\.jsonl$/);
  if (!m) return 0;
  const d = m[1], t = m[2];
  const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
  // Date.parse without timezone treats as local — which matches ccv's filename.
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Pick the jsonl that represents an instance's "primary" session.
//
// Key insight: filename time = the moment ccv intercepted that session's first
// request. So a ccv's *own* session has a filename time near (>=) startedAt.
// A jsonl with filename time before startedAt means that ccv resumed an older
// session.
//
// Algorithm (greedy, latest peer first so each can claim its exact match):
//   1. Sort peers by startedAt DESC.
//   2. For each peer, among jsonls not yet taken by another peer:
//      a. Prefer the smallest fnameMs that is >= startedAt - SLACK_MS
//         (= the file ccv created at or shortly after launch).
//      b. If none qualify, fall back to the largest fnameMs < startedAt
//         (= most recent old session this ccv could have resumed).
//      c. If neither, fall back to mtime-newest among remaining candidates.
//   3. Mark picked, move on.
//
// This unifies solo and multi-peer cases — solo just runs the loop once.
const PEER_PICKER_SLACK_MS = 60_000;
function pickInstanceLogs(projectName, instances) {
  if (!projectName || !instances.length) return new Map();
  const dir = join(LOG_DIR, projectName);
  if (!existsSync(dir)) return new Map();
  let candidates;
  try {
    candidates = readdirSync(dir)
      .filter(f => /^.+_\d{8}_\d{6}\.jsonl$/.test(f))
      .map(f => {
        const fp = join(dir, f);
        try {
          const st = statSync(fp);
          return { path: fp, mtime: st.mtimeMs, size: st.size, fnameMs: parseJsonlFilenameTime(fp) };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return new Map(); }
  if (!candidates.length) return new Map();

  const sortedPeers = [...instances].sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta; // newest first
  });

  const taken = new Set();
  const result = new Map(); // pid -> candidate

  for (const peer of sortedPeers) {
    const startedAt = peer.startedAt ? new Date(peer.startedAt).getTime() : 0;
    const remaining = candidates.filter(c => !taken.has(c.path));
    if (!remaining.length) break;

    let pick = null;
    if (startedAt > 0) {
      const after = remaining.filter(c => c.fnameMs >= startedAt - PEER_PICKER_SLACK_MS);
      if (after.length) {
        after.sort((a, b) => a.fnameMs - b.fnameMs);
        pick = after[0];
      } else {
        const before = remaining.filter(c => c.fnameMs < startedAt - PEER_PICKER_SLACK_MS);
        if (before.length) {
          before.sort((a, b) => b.fnameMs - a.fnameMs);
          pick = before[0];
        }
      }
    }
    if (!pick) {
      const sorted = [...remaining].sort((a, b) => b.mtime - a.mtime);
      pick = sorted[0];
    }
    if (pick) {
      taken.add(pick.path);
      result.set(peer.pid, pick);
    }
  }

  return result;
}

function findActiveLogFileForInstance(projectName, instance, peers) {
  const peerList = (peers && peers.length) ? peers : [instance];
  const map = pickInstanceLogs(projectName, peerList);
  return map.get(instance.pid) || null;
}

function tailJsonlEntries(filePath, maxBytes = ACTIVITY_TAIL_BYTES) {
  let st;
  try { st = statSync(filePath); } catch { return { entries: [], size: 0, mtime: 0 }; }
  if (st.size === 0) return { entries: [], size: 0, mtime: st.mtimeMs };
  // Adaptive grow: ccv jsonl entries inflate with conversation history (each
  // request includes the full messages array), so a single record can be 500KB+
  // late in a session. If the first window yields zero parseable entries, try
  // doubling up to ACTIVITY_TAIL_MAX_BYTES before giving up.
  let window = Math.min(maxBytes, st.size);
  const cap = Math.min(ACTIVITY_TAIL_MAX_BYTES, st.size);
  for (;;) {
    const start = st.size - window;
    let fd;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, start);
      closeSync(fd);
      let text = buf.toString('utf-8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl > -1) text = text.slice(nl + 1);
      }
      const entries = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* truncated tail */ }
      }
      if (entries.length || window >= cap) {
        return { entries, size: st.size, mtime: st.mtimeMs };
      }
      // Nothing parseable in this window — usually means we landed mid-record.
      // Double the window and retry.
      window = Math.min(window * 2, cap);
    } catch (err) {
      try { if (fd != null) closeSync(fd); } catch {}
      return { entries: [], size: st.size, mtime: st.mtimeMs };
    }
  }
}

function truncate(s, n = 80) {
  if (s == null) return '';
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function lastUserPrompt(entry) {
  // body.messages is [{role, content: string | [{type, text, ...}]}, ...]
  // Walk back to find the last meaningful user-typed text — skipping
  // system-reminders, tool_result envelopes, slash-cmd wrappers, and the
  // compact-resume preamble (same framing rules as firstUserPrompt).
  const msgs = entry?.body?.messages;
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      const cleaned = stripUserPromptFraming(c);
      if (cleaned) return cleaned;
      continue;
    }
    if (!Array.isArray(c)) continue;
    // Iterate blocks in REVERSE so the most recent text in this user message
    // wins (e.g. user appended an interrupt/clarification after a tool_use).
    for (let j = c.length - 1; j >= 0; j--) {
      const block = c[j];
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const cleaned = stripUserPromptFraming(block.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Walk back through tail entries until we find a non-empty user prompt — the
// latest single entry may only have tool_result blocks (during agentic tool
// loops), in which case we want the prompt that kicked off this work.
function lastUserPromptAcrossEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = lastUserPrompt(entries[i]);
    if (text) return text;
  }
  return '';
}

function firstUserPrompt(entry) {
  // First non-system-reminder user message — used as the "what was this
  // conversation originally about" title on the card.
  const msgs = entry?.body?.messages;
  if (!Array.isArray(msgs)) return '';
  for (const m of msgs) {
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      const cleaned = stripUserPromptFraming(c);
      if (cleaned) return cleaned;
      continue;
    }
    if (!Array.isArray(c)) continue;
    // A user msg can have many text blocks: [system-reminder, system-reminder,
    // ..., REAL PROMPT, ...]. Check every text block in order — first one that
    // survives framing strip + skill-metadata filter wins.
    for (const block of c) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const cleaned = stripUserPromptFraming(block.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Strip CC's framing wrappers around the actual user prompt:
//   <system-reminder>...</system-reminder>           — system-injected context, not user input
//   <command-name>...</command-name>                  — slash command marker
//   <command-message>...</command-message>            — slash command body
//   <command-args>...</command-args>                  — slash command args
//   <local-command-caveat>...</local-command-caveat>  — "DO NOT respond to these messages..." wrapper
//   <local-command-stdout>...</local-command-stdout>  — slash command stdout echo
//   <session>...</session>                            — CC's session-restore wrapper around the original prompt
//   "This session is being continued..."              — compact-resume preamble (auto-generated summary)
// Returns '' if nothing meaningful is left.
function stripUserPromptFraming(text) {
  if (!text) return '';
  let t = String(text);
  // Drop full-message system-reminder blocks
  if (/^<system-reminder>/.test(t)) return '';
  // Unwrap <session>...</session> — keep inner content (the original prompt)
  const sessionMatch = t.match(/^<session>\s*([\s\S]*?)\s*<\/session>\s*$/);
  if (sessionMatch) t = sessionMatch[1];
  // Drop command framing entirely (these are slash commands, not freeform prompts)
  if (/^<command-(name|message|args)>/.test(t)) return '';
  // Drop local-command wrappers — caveat is pure boilerplate, stdout is slash-cmd echo
  if (/^<local-command-(caveat|stdout)>/.test(t)) return '';
  // Drop the compact-resume preamble. CC inserts this auto-generated summary as a
  // user-role text block when /compact runs; the real first prompt of the resumed
  // session is in a later block.
  if (/^This session is being continued from a previous conversation/.test(t)) return '';
  // Drop CC skill-activation markers — these are injected as user-role text when
  // a skill loads (e.g. "Base directory for this skill: /path/to/skill ...").
  // Not a real user prompt.
  if (/^Base directory for this skill\b/i.test(t)) return '';
  // Drop bare tool_use_result envelopes that CC reformats as user text
  if (/^<tool_use_result\b/.test(t) || /^<\/?tool_use\b/.test(t)) return '';
  return t.trim();
}

// File-level cache of first user prompt — one read per session log file. Cleared
// when file mtime changes (rare for the first line of an append-only jsonl).
const _firstPromptCache = new Map(); // filePath -> { mtime, size, text }
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024; // first jsonl line can be 100s of KB (system-reminders + skills)

function readFirstUserPrompt(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return ''; }
  if (st.size === 0) return '';
  const cached = _firstPromptCache.get(filePath);
  if (cached && cached.mtime === st.mtimeMs) return cached.text;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const len = Math.min(st.size, FIRST_LINE_MAX_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    const nl = buf.indexOf(0x0a);
    const lineBuf = nl >= 0 ? buf.slice(0, nl) : buf;
    let text = '';
    try {
      const obj = JSON.parse(lineBuf.toString('utf-8'));
      text = firstUserPrompt(obj);
    } catch { /* truncated first line — skip */ }
    _firstPromptCache.set(filePath, { mtime: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    try { if (fd != null) closeSync(fd); } catch {}
    return '';
  }
}

// Find the latest tool_use block in the response of the latest entry, and
// pair it with the latest tool_result across entries to decide if a tool is
// still running on the agent's side.
function inspectToolFlow(entries) {
  if (!entries.length) return { lastToolUse: null, hasMatchingResult: false };
  let lastToolUse = null;
  // Search entries in reverse
  for (let i = entries.length - 1; i >= 0 && !lastToolUse; i--) {
    const e = entries[i];
    const content = e?.response?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b?.type === 'tool_use') {
        lastToolUse = { id: b.id, name: b.name, input: b.input, ts: e.timestamp };
        break;
      }
    }
  }
  if (!lastToolUse) return { lastToolUse: null, hasMatchingResult: false };
  // tool_result lives in the *next* request's body.messages[*].content[*]
  let hasMatchingResult = false;
  for (const e of entries) {
    if (!e?.timestamp || e.timestamp <= lastToolUse.ts) continue;
    const msgs = e?.body?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!Array.isArray(m?.content)) continue;
      for (const block of m.content) {
        if (block?.type === 'tool_result' && block.tool_use_id === lastToolUse.id) {
          hasMatchingResult = true;
          break;
        }
      }
      if (hasMatchingResult) break;
    }
    if (hasMatchingResult) break;
  }
  return { lastToolUse, hasMatchingResult };
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name || 'tool';
  if (name === 'Bash') return `Bash: ${truncate(input.command, 60)}`;
  if (name === 'Edit' || name === 'Write') return `${name}: ${truncate(input.file_path, 60)}`;
  if (name === 'Read') return `Read: ${truncate(input.file_path, 60)}`;
  if (name === 'Grep') return `Grep: ${truncate(input.pattern, 60)}`;
  if (name === 'Glob') return `Glob: ${truncate(input.pattern, 60)}`;
  if (name === 'WebFetch') return `WebFetch: ${truncate(input.url, 60)}`;
  if (name === 'WebSearch') return `WebSearch: ${truncate(input.query, 60)}`;
  if (name === 'TodoWrite') return `TodoWrite (${(input.todos || []).length} items)`;
  if (name === 'Task' || name === 'Agent') return `Task: ${truncate(input.description || input.prompt, 60)}`;
  // generic
  const firstStr = Object.values(input).find(v => typeof v === 'string');
  return firstStr ? `${name}: ${truncate(firstStr, 60)}` : name;
}

function summarizeEntry(e) {
  // Used in drawer "recent events" list
  const ts = e?.timestamp || '';
  const userPrompt = lastUserPrompt(e);
  const respContent = e?.response?.content;
  let assistantText = '';
  let toolUse = null;
  if (Array.isArray(respContent)) {
    for (const b of respContent) {
      if (b?.type === 'text' && !assistantText) assistantText = b.text || '';
      if (b?.type === 'tool_use' && !toolUse) toolUse = b;
    }
  }
  return {
    ts,
    inProgress: !!e?.inProgress,
    durationMs: e?.duration || 0,
    userPrompt: truncate(userPrompt, 120),
    assistantText: truncate(assistantText, 120),
    toolUse: toolUse ? summarizeToolInput(toolUse.name, toolUse.input) : '',
  };
}

function ageString(ms) {
  if (ms < 0) return 'just now';
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function fetchPendingAsks(instance) {
  // Query the instance's own /api/pending-asks (in-memory state lives there).
  if (!instance?.port || !instance?.token) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const resp = await fetch(`http://127.0.0.1:${instance.port}/api/pending-asks?token=${instance.token}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    const asks = Array.isArray(data?.pendingAsks) ? data.pendingAsks : [];
    // ccv writes pending asks to a shared on-disk store (~/.claude/cc-viewer/ask-store.json),
    // so every running ccv echoes the same disk entries via /api/pending-asks. The owning
    // ccv (the one whose ask-bridge hook captured the AskUserQuestion) marks it source='memory'.
    // Filtering to source='memory' avoids showing the same waiting-for-answer badge on every
    // sibling ccv at the same cwd. Falls back to including untagged entries for older ccv
    // versions that don't set source.
    return asks.filter(a => !a.source || a.source === 'memory');
  } catch { return []; }
}

function deriveStatus({ entries, pendingAsks, fileMtime }) {
  const now = Date.now();
  if (pendingAsks.length > 0) {
    const first = pendingAsks[0];
    const qHeader = first?.questions?.[0]?.header || first?.questions?.[0]?.question || 'question';
    return {
      status: 'waiting_ask',
      label: `⏳ awaiting answer: ${truncate(qHeader, 40)}${pendingAsks.length > 1 ? ` (+${pendingAsks.length - 1})` : ''}`,
    };
  }
  if (!entries.length) {
    return { status: 'no_session', label: '⚫ no session yet' };
  }
  const latest = entries[entries.length - 1];
  const latestMs = latest?.timestamp ? new Date(latest.timestamp).getTime() : fileMtime;
  const age = now - latestMs;
  // in-flight Claude API call
  if (latest?.inProgress && age < 5 * 60_000) {
    // streaming; if we already see a tool_use in partial response, surface it
    const partialContent = latest?.response?.content;
    if (Array.isArray(partialContent)) {
      const toolUse = partialContent.find(b => b?.type === 'tool_use');
      if (toolUse) return { status: 'tool_running', label: `🛠 ${summarizeToolInput(toolUse.name, toolUse.input)}` };
    }
    return { status: 'thinking', label: '🔵 thinking…' };
  }
  // Tool launched but no result yet → agent (Claude Code) is running it
  const { lastToolUse, hasMatchingResult } = inspectToolFlow(entries);
  if (lastToolUse && !hasMatchingResult) {
    const toolAge = now - new Date(lastToolUse.ts).getTime();
    if (toolAge < 10 * 60_000) {
      return { status: 'tool_running', label: `🛠 ${summarizeToolInput(lastToolUse.name, lastToolUse.input)}` };
    }
  }
  if (age > 30 * 60_000) {
    return { status: 'idle', label: `🟢 idle ${ageString(age)}` };
  }
  return { status: 'idle', label: `🟢 idle ${ageString(age)}` };
}

async function getInstanceActivity(instance) {
  const cached = _activityCache.get(instance.pid);
  const now = Date.now();
  if (cached && now - cached.at < ACTIVITY_CACHE_TTL_MS) return cached.payload;

  const startedAtMs = instance.startedAt ? new Date(instance.startedAt).getTime() : 0;
  // Prefer ccv's normalized project name derived from cwd (matches what ccv
  // actually writes to disk); fall back to whatever the instance reported.
  const normalizedName = ccvProjectName(instance.cwd) || instance.projectName;
  // Find peers (other running ccvs) at the same cwd so we can pick distinct
  // jsonls when multiple ccvs share a project dir — otherwise both end up
  // showing the title of whichever jsonl was modified most recently.
  const peers = [...instances.values()].filter(i =>
    !i.isHub && (ccvProjectName(i.cwd) || i.projectName) === normalizedName
  );
  const logFile = findActiveLogFileForInstance(normalizedName, instance, peers);
  let entries = [];
  let fileMtime = 0;
  let logFileName = null;
  let title = '';
  if (logFile) {
    const tailed = tailJsonlEntries(logFile.path);
    entries = tailed.entries;
    fileMtime = tailed.mtime;
    logFileName = basename(logFile.path);
    title = readFirstUserPrompt(logFile.path);
  }
  // Pending asks lives in-memory inside the ccv process. Skip for hub itself
  // (avoids reentrant fetch into our own server) — hubs don't run user sessions.
  const pendingAsks = instance.isHub ? [] : await fetchPendingAsks(instance);

  const status = deriveStatus({ entries, pendingAsks, fileMtime });
  // Preview shown next to the status badge — answers "what is this session
  // currently about". Walk back across entries because the latest entry may
  // be a tool_result-only turn during an agentic loop. Even when the badge
  // shows a special state (awaiting / thinking / tool_running), the preview
  // still helps the user remember what the session was about.
  const userText = lastUserPromptAcrossEntries(entries);
  const preview = userText ? `user: ${truncate(userText, 120)}` : '';
  const recent = entries.slice(-5).map(summarizeEntry).reverse();

  const payload = {
    pid: instance.pid,
    status: status.status,
    statusLabel: status.label,
    preview,
    title,
    alias: getAlias(instance.cwd),
    ccuseProfile: getCcuseProfile(instance.cwd),
    lastEventAt: entries.length ? entries[entries.length - 1].timestamp : null,
    fileMtime,
    logFile: logFileName,
    pendingAsks: pendingAsks.map(a => ({ id: a.id, questions: a.questions, createdAt: a.createdAt })),
    recentEvents: recent,
  };
  _activityCache.set(instance.pid, { at: now, payload });
  return payload;
}
// ---------- end activity probe ----------

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ccv launcher</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<style>
  @font-face {
    font-family: 'NerdFont';
    src: url('https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.3.0/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFont-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  :root { --bg:#0d1117; --fg:#e6edf3; --mute:#7d8590; --line:#21262d; --card:#161b22; --card-hover:#1c2128; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --tag-bg:#1f2937; --term-font:'NerdFont','MesloLGS NF','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; background:var(--bg); color:var(--fg); min-height:100vh; min-height:100dvh; padding-bottom:env(safe-area-inset-bottom); }

  /* header */
  header { display:flex; align-items:center; gap:12px; padding:12px 24px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(13,17,23,.85); backdrop-filter:blur(12px); z-index:10; }
  header h1 { font-size:15px; font-weight:600; letter-spacing:-.3px; }
  header .meta { color:var(--mute); font-size:12px; }
  header .grow { flex:1; }
  header button { background:var(--accent); color:#0d1117; border:0; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:opacity .15s; }
  header button:hover { opacity:.85; }

  /* sections */
  .content { max-width:960px; margin:0 auto; padding:16px 24px 32px; }
  .section-hd { display:flex; align-items:center; gap:8px; padding:12px 0 8px; font-size:12px; font-weight:600; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; }
  .section-hd .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .section-hd .dot.green { background:var(--ok); }
  .section-hd .dot.gray  { background:var(--mute); opacity:.5; }

  /* cards */
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:8px; border-left:2px solid transparent; transition:border-color .15s, background .15s; }
  .card:hover { background:var(--card-hover); }
  .card.running { border-left-color:var(--ok); }
  .card.hub     { border-left-color:var(--accent); }
  .card.idle    { border-left-color:transparent; }

  /* groups (running side) — same-cwd instances share a header */
  .group { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; overflow:hidden; }
  .group.is-hub { border-color:rgba(88,166,255,.25); }
  .group-head { display:grid; grid-template-columns: minmax(0,1fr) auto; grid-template-areas:"id actions" "path actions"; gap:2px 12px; padding:10px 14px; background:var(--card-hover); border-bottom:1px solid var(--line); }
  .group-id { grid-area:id; display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
  .group-id .group-name { font-weight:600; font-size:14px; }
  .group-id .name-sub { font-size:11px; color:var(--mute); font-weight:400; }
  .group-id .name-sub::before { content:'· '; opacity:.5; }
  .group-id .hub-tag { font-size:10px; color:var(--accent); background:rgba(88,166,255,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .group-id .alias-edit { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:12px; padding:0 2px; line-height:1; opacity:0; transition:opacity .15s; }
  .group:hover .alias-edit { opacity:.7; }
  .group:hover .alias-edit:hover { opacity:1; color:var(--accent); }
  .group-count { font-size:10px; color:var(--mute); background:var(--tag-bg); padding:1px 8px; border-radius:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .group-path { grid-area:path; color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .group-actions { grid-area:actions; display:flex; gap:6px; align-self:center; flex-shrink:0; }
  .group-body { padding:0; }
  .instance { padding:9px 14px; border-top:1px solid var(--line); border-left:2px solid transparent; transition:background .15s; position:relative; }
  .group-body > .instance:first-child { border-top:0; }
  .instance:hover { background:var(--card-hover); }
  .instance.running { border-left-color:var(--ok); }
  .instance.hub { border-left-color:var(--accent); }
  .instance-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:5px; }
  .instance-head .tag.port { color:var(--ok); background:rgba(63,185,80,.12); font-weight:600; }
  .instance-head .ext-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .instance-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:6px; }
  .card-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .card-head .name { font-weight:600; font-size:13px; }
  .card-head .hub-tag { font-size:10px; color:var(--accent); background:rgba(88,166,255,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .card-head .ext-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .card-head .name-sub { font-size:11px; color:var(--mute); font-weight:400; margin-left:2px; }
  .card-head .name-sub::before { content:'· '; opacity:.5; }
  .card-head .alias-edit { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:12px; padding:0 4px; line-height:1; opacity:0; transition:opacity .15s; }
  .card:hover .alias-edit { opacity:1; }
  .card-head .alias-edit:hover { color:var(--accent); }
  .tag { display:inline-block; font-size:11px; color:var(--mute); background:var(--tag-bg); padding:1px 7px; border-radius:3px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card-path { color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:6px; }
  .card-title { color:var(--fg); font-size:12px; line-height:1.4; margin:2px 0 6px; padding-left:8px; border-left:2px solid var(--accent); opacity:.85; max-height:34px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .card-title:empty { display:none; }
  .card-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .card-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }

  /* activity status */
  .activity-row { display:flex; align-items:center; gap:8px; margin:4px 0 8px; font-size:11px; min-height:18px; }
  .badge { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .badge.thinking     { color:#58a6ff; background:rgba(88,166,255,.12); }
  .badge.tool_running { color:#d29922; background:rgba(210,153,34,.15); }
  .badge.waiting_ask  { color:#f85149; background:rgba(248,81,73,.15); animation:pulseAsk 1.5s ease-in-out infinite; }
  .badge.idle         { color:#3fb950; background:rgba(63,185,80,.10); }
  .badge.no_session   { color:var(--mute); background:var(--tag-bg); }
  .badge.error        { color:#f85149; background:rgba(248,81,73,.10); }
  @keyframes pulseAsk { 0%,100%{opacity:1} 50%{opacity:.55} }
  .preview { color:var(--mute); font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .activity-toggle { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:11px; padding:0 4px; user-select:none; }
  .activity-toggle:hover { color:var(--accent); }
  .activity-drawer { display:none; margin:6px 0 8px; padding:8px 10px; background:#0d1117; border:1px solid var(--line); border-radius:6px; font-size:11px; }
  .activity-drawer.open { display:block; }
  .drawer-section { margin-bottom:8px; }
  .drawer-section:last-child { margin-bottom:0; }
  .drawer-h { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .event-row { padding:4px 0; border-bottom:1px dotted var(--line); display:flex; gap:8px; align-items:flex-start; }
  .event-row:last-child { border-bottom:0; }
  .event-ts { color:var(--mute); font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; flex-shrink:0; min-width:54px; }
  .event-body { flex:1; min-width:0; }
  .event-line { color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .event-line.user { color:#a5d6ff; }
  .event-line.tool { color:#d29922; }
  .event-line.assistant { color:var(--fg); opacity:.85; }
  .event-line.flag { color:#58a6ff; font-style:italic; }
  .ask-row { padding:4px 6px; background:rgba(248,81,73,.08); border-radius:4px; margin-bottom:3px; color:#f0a4a0; }
  .ask-row:last-child { margin-bottom:0; }

  /* buttons */
  .btn { display:inline-flex; align-items:center; gap:4px; background:transparent; color:var(--fg); border:1px solid var(--line); padding:4px 10px; border-radius:5px; cursor:pointer; font-size:11px; font-family:inherit; transition:all .15s; white-space:nowrap; }
  .btn:hover { border-color:var(--accent); color:var(--accent); }
  .btn.primary { background:var(--accent); color:#0d1117; border-color:var(--accent); font-weight:600; }
  .btn.primary:hover { opacity:.85; color:#0d1117; }
  .btn.danger:hover { border-color:var(--bad); color:var(--bad); }
  .btn svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }

  /* details / QR */
  details { margin-top:6px; }
  details summary { cursor:pointer; color:var(--mute); font-size:11px; padding:2px 0; user-select:none; }
  details[open] summary { color:var(--accent); }
  .url-row { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; word-break:break-all; padding:2px 0; }
  .url-row a { color:var(--mute); text-decoration:none; }
  .url-row a:hover { color:var(--accent); }
  .qr { padding:8px; background:#fff; border-radius:6px; display:inline-block; margin-top:6px; }
  .qr canvas { display:block; }

  /* dialog */
  dialog { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:20px; max-width:500px; width:92%; }
  dialog::backdrop { background:rgba(0,0,0,.55); }
  dialog h2 { margin:0 0 12px; font-size:14px; font-weight:600; }
  dialog input { width:100%; padding:7px 10px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:5px; font-family:ui-monospace,monospace; font-size:12px; margin-bottom:8px; }
  dialog .row { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
  .tree { font-family:ui-monospace,monospace; font-size:12px; color:var(--mute); max-height:220px; overflow:auto; background:var(--bg); padding:6px; border-radius:5px; }
  .tree .row { padding:3px 6px; cursor:pointer; border-radius:3px; display:flex; gap:6px; align-items:center; }
  .tree .row:hover { background:var(--card); color:var(--fg); }
  .tree .row.dir::before { content:"📁"; font-size:12px; }
  .tree .row.up::before  { content:"↩"; }
  .err { color:var(--bad); font-size:12px; margin-top:6px; }
  .empty { color:var(--mute); text-align:center; padding:48px 20px; font-size:12px; }

  /* terminal overlay */
  #term-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:100; }
  #term-overlay.open { display:flex; flex-direction:column; }
  #term-bar { display:flex; align-items:center; gap:8px; padding:6px 14px; background:var(--card); border-bottom:1px solid var(--line); }
  #term-bar .type-tag { font-size:10px; font-weight:600; padding:2px 7px; border-radius:3px; }
  #term-bar .type-tag.shell   { color:var(--ok); background:rgba(63,185,80,.12); }
  #term-bar .type-tag.console { color:var(--accent); background:rgba(88,166,255,.12); }
  #term-bar .name { font-weight:600; font-size:12px; }
  #term-bar .path { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #term-bar .grow { flex:1; min-width:0; }
  #term-bar button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; }
  #term-bar button:hover { border-color:var(--bad); color:var(--bad); }
  #term-container { flex:1; overflow:hidden; }

  /* ccv inline overlay — embeds the ccv UI in an iframe so user can open/close
     a session without leaving the launcher tab */
  #ccv-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:100; }
  #ccv-overlay.open { display:flex; flex-direction:column; }
  #ccv-bar { display:flex; align-items:center; gap:8px; padding:6px 14px; background:var(--card); border-bottom:1px solid var(--line); }
  #ccv-bar .type-tag { font-size:10px; font-weight:600; padding:2px 7px; border-radius:3px; }
  #ccv-bar .type-tag.ccv-tag { color:var(--ok); background:rgba(63,185,80,.14); }
  #ccv-bar .name { font-weight:600; font-size:12px; }
  #ccv-bar .port { font-size:11px; color:var(--mute); font-family:ui-monospace,monospace; }
  #ccv-bar .path { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #ccv-bar .grow { flex:1; min-width:0; }
  #ccv-bar button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-family:inherit; }
  #ccv-bar button:hover { border-color:var(--accent); color:var(--accent); }
  #ccv-bar #ccv-close:hover { border-color:var(--bad); color:var(--bad); }
  #ccv-frame { flex:1; width:100%; border:0; background:#0d1117; }
  /* iframe state overlay — covers the frame area while loading or on failure.
     We can't peek inside cross-origin ccv to know when SPA finished rendering,
     so we treat iframe.onload as "good enough" + watchdog as failure signal. */
  #ccv-frame-status { display:none; position:absolute; left:0; right:0; bottom:0; top:42px; background:#0d1117; align-items:center; justify-content:center; flex-direction:column; gap:14px; color:var(--mute); font-size:13px; pointer-events:none; }
  #ccv-frame-status.show { display:flex; pointer-events:auto; }
  #ccv-frame-status .spinner { width:32px; height:32px; border:3px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:ccvSpin 0.9s linear infinite; }
  @keyframes ccvSpin { to { transform:rotate(360deg); } }
  #ccv-frame-status .err-title { color:var(--bad); font-weight:600; font-size:14px; }
  #ccv-frame-status .err-detail { font-size:11px; max-width:480px; text-align:center; line-height:1.5; }
  #ccv-frame-status .err-actions { display:flex; gap:8px; }
  #ccv-frame-status .err-actions button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-family:inherit; }
  #ccv-frame-status .err-actions button:hover { border-color:var(--accent); color:var(--accent); }

  /* local CC sessions section */
  .section-hd .dot.amber { background:var(--warn); }
  .local-cc-card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:8px; border-left:2px solid var(--warn); display:grid; grid-template-columns: minmax(0,1fr) auto; grid-template-areas:"id actions" "path actions" "meta actions"; gap:3px 12px; }
  .local-cc-card:hover { background:var(--card-hover); }
  .local-cc-id { grid-area:id; display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
  .local-cc-id .name { font-weight:600; font-size:13px; }
  .local-cc-id .session-tag { font-size:10px; color:var(--mute); background:var(--tag-bg); padding:1px 7px; border-radius:3px; font-family:ui-monospace,monospace; }
  .local-cc-id .bare-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .local-cc-path { grid-area:path; color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .local-cc-meta { grid-area:meta; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .local-cc-actions { grid-area:actions; display:flex; gap:6px; align-self:center; flex-shrink:0; }

  /* pair notification banner */
  .pair-banner { background:rgba(210,153,34,.1); border:1px solid var(--warn); border-radius:8px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pair-banner .pair-info { flex:1; min-width:200px; }
  .pair-banner .pair-code { font-family:ui-monospace,monospace; font-weight:700; font-size:15px; color:var(--warn); letter-spacing:2px; }
  .pair-banner .pair-device { color:var(--mute); font-size:11px; }
  .pair-banner .pair-actions { display:flex; gap:6px; }
  .pair-banner .pair-actions button { font-size:11px; padding:4px 12px; border-radius:5px; cursor:pointer; border:1px solid var(--line); background:transparent; color:var(--fg); }
  .pair-banner .pair-actions .approve { background:var(--ok); color:#0d1117; border-color:var(--ok); font-weight:600; }
  .pair-banner .pair-actions .reject:hover { border-color:var(--bad); color:var(--bad); }

  /* footer */
  footer { padding:10px 24px; border-top:1px solid var(--line); color:var(--mute); font-size:10px; text-align:center; opacity:.6; }
</style>
</head>
<body>
<header>
  <h1>ccv launcher</h1>
  <span class="meta" id="meta">loading…</span>
  <span class="grow"></span>
  <button id="btn-new">+ New</button>
</header>
<div id="pair-zone" style="max-width:960px;margin:0 auto;padding:12px 24px 0"></div>
<div class="content" id="list"><div class="empty">loading…</div></div>
<footer>ccv-launcher</footer>

<div id="term-overlay">
  <div id="term-bar">
    <span class="type-tag" id="term-type"></span>
    <span class="name" id="term-name"></span>
    <span class="grow"><span class="path" id="term-path"></span></span>
    <button id="term-close">Close</button>
  </div>
  <div id="term-container"></div>
</div>

<div id="ccv-overlay">
  <div id="ccv-bar">
    <span class="type-tag ccv-tag">CCV</span>
    <span class="name" id="ccv-name"></span>
    <span class="port" id="ccv-port"></span>
    <span class="grow"><span class="path" id="ccv-path"></span></span>
    <button id="ccv-newtab" title="在新标签页打开">↗</button>
    <button id="ccv-reload" title="刷新">⟳</button>
    <button id="ccv-close" title="关闭 (Esc)">Close</button>
  </div>
  <iframe id="ccv-frame" src="about:blank" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  <div id="ccv-frame-status">
    <div data-state="loading" style="display:flex; flex-direction:column; align-items:center; gap:14px;">
      <div class="spinner"></div>
      <div>Loading ccv…</div>
    </div>
    <div data-state="error" style="display:none; flex-direction:column; align-items:center; gap:10px;">
      <div class="err-title">⚠ Failed to load ccv</div>
      <div class="err-detail" id="ccv-frame-err-detail">The ccv at this port did not respond. It may have just restarted or be in the middle of starting up.</div>
      <div class="err-actions">
        <button id="ccv-frame-retry">Retry</button>
        <button id="ccv-frame-newtab">Open in new tab</button>
      </div>
    </div>
  </div>
</div>

<dialog id="dlg">
  <h2>Launch new instance</h2>
  <div style="color:var(--mute);font-size:11px;margin-bottom:4px">Directory:</div>
  <input id="cwd" placeholder="/path/to/project">
  <div class="tree" id="tree"></div>
  <div style="color:var(--mute);font-size:11px;margin:8px 0 4px">ccuse profile (claude 后端):</div>
  <select id="ccuse-select" style="width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px;font-size:12px">
    <option value="">— 不切 (用 launcher 默认) —</option>
  </select>
  <div class="err" id="err" hidden></div>
  <div class="row">
    <button class="btn" id="btn-cancel">Cancel</button>
    <button class="btn primary" id="btn-launch">Launch</button>
  </div>
</dialog>

<script>
(() => {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  // Launcher API + /api/browse-dir are served by the multiplexer below the
  // ccv token gate; only attach ?token= when present so direct LAN access
  // (no token in URL) and public access (NPM Basic Auth in front) both work.
  const withMaybeToken = (path) =>
    TOKEN ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : path;
  const api = async (path, init) => {
    const res = await fetch(withMaybeToken(path), init);
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text().catch(() => ''));
    return res.json();
  };

  const dlg = document.getElementById('dlg');
  const listEl = document.getElementById('list');
  const metaEl = document.getElementById('meta');
  const cwdInput = document.getElementById('cwd');
  const treeEl = document.getElementById('tree');
  const errEl = document.getElementById('err');

  function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtAge(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return '';
    const m = Math.floor(ms/60000); const h = Math.floor(m/60);
    if (h >= 24) return Math.floor(h/24) + 'd';
    if (h > 0) return h + 'h ' + (m%60) + 'm';
    if (m > 0) return m + 'm';
    return Math.floor(ms/1000) + 's';
  }

  function renderInstance(it) {
    const cls = it.isHub ? 'instance hub' : 'instance running';
    const name = escape(it.displayName || it.projectName || '?');
    const path = escape(it.cwd || '');
    const pub = escape(it.publicUrl || '');
    const lan = escape(it.lanUrl || '');
    const openHref = pub || lan || '#';
    let actions = ''
      + '<button class="btn primary" data-act="open" data-href="'+escape(openHref)+'" data-port="'+(it.port||'')+'" data-name="'+name+'" data-path="'+path+'">Open</button>'
      + '<button class="btn" data-act="open-newtab" data-href="'+escape(openHref)+'" data-port="'+(it.port||'')+'" title="在新标签页打开">↗</button>'
      + '<button class="btn" data-act="copy" data-text="'+(pub||lan)+'">Copy</button>';
    if (!it.isHub) {
      actions += '<button class="btn" data-act="console" data-port="'+(it.port||'')+'" data-token="'+(it.token||'')+'" data-name="'+name+'" data-path="'+path+'" data-pub="'+(it.publicUrl||'')+'" data-lan="'+(it.lanUrl||'')+'">Console</button>';
      actions += '<button class="btn danger" data-act="stop" data-pid="'+it.pid+'" data-name="'+name+'">Stop</button>';
    }
    return ''
      + '<div class="'+cls+'" data-pid="'+it.pid+'">'
      +   '<div class="instance-head">'
      +     '<span class="tag port">:'+(it.port||'?')+'</span>'
      +     '<span class="tag">pid '+it.pid+'</span>'
      +     '<span class="tag">up '+fmtAge(it.startedAt)+'</span>'
      +     (it.version ? '<span class="tag">'+escape(it.version)+'</span>' : '')
      +     (it.external ? '<span class="ext-tag" title="外部发现 — 此 ccv 在 launcher 插件加载前就已经启动，没自动注册到 runtime/，由 launcher 通过 lsof + /api/version-info 反向发现并接管">外部</span>' : '')
      +   '</div>'
      +   '<div class="card-title" data-title-for="' + it.pid + '"></div>'
      +   '<div class="activity-row" data-act-row="' + it.pid + '">'
      +     '<span class="badge no_session">⚫ probing…</span>'
      +     '<span class="preview"></span>'
      +     (it.isHub ? '' : '<button class="activity-toggle" data-act="actdrawer" data-pid="' + it.pid + '" title="show recent activity">▾</button>')
      +   '</div>'
      +   (it.isHub ? '' : '<div class="activity-drawer" data-act-drawer="' + it.pid + '"></div>')
      +   '<details><summary>URLs &middot; QR</summary>'
      +     (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>':'')
      +     (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>':'')
      +     (pub ? '<div class="qr" data-qr="'+pub+'"></div>':'')
      +   '</details>'
      +   '<div class="instance-actions">' + actions + '</div>'
      + '</div>';
  }

  function renderGroup(g) {
    const first = g.list[0];
    const path = escape(g.cwd || '');
    const projName = escape(first.displayName || first.projectName || '?');
    const aliasRaw = first.alias || '';
    const aliasEsc = aliasRaw ? escape(aliasRaw) : '';
    const showName = aliasEsc || projName;
    const subName = aliasEsc ? '<span class="name-sub" title="real project name">' + projName + '</span>' : '';
    const aliasBtn = g.hasHub ? '' : '<button class="alias-edit" data-act="alias" data-cwd="'+escape(g.cwd||'')+'" data-current="'+aliasEsc+'" title="编辑别名 (Launcher 自己的别名,跟 ccv 内置别名不同步)">✎</button>';
    const groupActions = g.hasHub ? '' :
        '<button class="btn" data-act="newhere" data-cwd="'+path+'" data-name="'+projName+'" title="Spawn another ccv at the same directory">+ New</button>'
      + '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+projName+'">Shell</button>';
    const count = g.list.length;
    const countTag = count > 1 ? '<span class="group-count">× ' + count + '</span>' : '';
    const body = g.list.map(renderInstance).join('');
    return ''
      + '<div class="group' + (g.hasHub ? ' is-hub' : '') + '">'
      +   '<div class="group-head">'
      +     '<div class="group-id">'
      +       '<span class="group-name">' + showName + '</span>'
      +       subName
      +       aliasBtn
      +       countTag
      +       (g.hasHub ? '<span class="hub-tag">HUB</span>' : '')
      +     '</div>'
      +     '<div class="group-path" title="'+path+'">'+path+'</div>'
      +     (groupActions ? '<div class="group-actions">' + groupActions + '</div>' : '')
      +   '</div>'
      +   '<div class="group-body">' + body + '</div>'
      + '</div>';
  }

  function render(items, history, localCc) {
    const total = items.length + (history || []).length + ((localCc || []).length);
    metaEl.textContent = items.length + ' running'
      + (localCc && localCc.length ? ' · ' + localCc.length + ' local' : '')
      + (history && history.length ? ' · ' + history.length + ' recent' : '');
    if (!total) {
      listEl.innerHTML = '<div class="empty">No instances yet. Click "+ New" to launch one.</div>';
      return;
    }
    // Group running instances by cwd. Same cwd → one rounded container with a
    // shared header (alias / projectName / path / cwd-level actions) and a list
    // of compact instance rows underneath. Cuts down on repeated path/name
    // chrome when you have multiple ccvs in the same project.
    const groupMap = new Map();
    for (const it of items) {
      const key = it.cwd || '';
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(it);
    }
    const groups = [];
    for (const [cwd, list] of groupMap) {
      list.sort((a,b) => (b.isHub?1:0) - (a.isHub?1:0) || (a.port||0) - (b.port||0));
      const minPort = Math.min(...list.map(x => x.port || 99999));
      const hasHub = list.some(x => x.isHub);
      groups.push({ cwd, list, minPort, hasHub });
    }
    groups.sort((a,b) => (b.hasHub?1:0) - (a.hasHub?1:0) || a.minPort - b.minPort);

    const projectsLabel = groups.length === 1 ? 'project' : 'projects';
    let html = '';
    if (items.length) {
      html += '<div class="section-hd"><span class="dot green"></span>Running (' + items.length + ' · ' + groups.length + ' ' + projectsLabel + ')</div>';
      html += groups.map(renderGroup).join('');
    }

    // Local CC sessions — bare claude processes the user started in a terminal,
    // not yet under any ccv. Offer a one-click "Takeover" that kills the bare
    // process and relaunches ccv -r <session-id> so the next prompt is recorded.
    if (localCc && localCc.length) {
      html += '<div class="section-hd" style="margin-top:16px"><span class="dot amber"></span>Local CC sessions (' + localCc.length + ') <span style="text-transform:none;font-weight:400;letter-spacing:0;color:var(--mute);margin-left:6px">— 本地裸跑的 claude,未被 ccv 接管</span></div>';
      html += localCc.map(s => {
        const cwd = s.cwd || '';
        const name = escape(cwd ? cwd.split('/').pop() || cwd : '?');
        const path = escape(cwd);
        const sidShort = (s.sessionId || '').slice(0, 8);
        const lastAgo = s.lastEntryAt ? fmtAge(s.lastEntryAt) + ' ago' : '';
        const upAge = s.startedAt ? fmtAge(s.startedAt) : '';
        return ''
          + '<div class="local-cc-card" data-pid="'+s.pid+'">'
          +   '<div class="local-cc-id">'
          +     '<span class="name">'+name+'</span>'
          +     '<span class="bare-tag" title="本地裸跑,未被 ccv 接管">未接管</span>'
          +     (sidShort ? '<span class="session-tag" title="session id '+escape(s.sessionId||'')+'">'+sidShort+'</span>' : '')
          +   '</div>'
          +   '<div class="local-cc-path" title="'+path+'">'+path+'</div>'
          +   '<div class="local-cc-meta">'
          +     '<span class="tag">pid '+s.pid+'</span>'
          +     (upAge ? '<span class="tag">up '+upAge+'</span>' : '')
          +     (lastAgo ? '<span class="tag">last msg '+lastAgo+'</span>' : '')
          +   '</div>'
          +   '<div class="local-cc-actions">'
          +     '<button class="btn primary" data-act="takeover" data-pid="'+s.pid+'" data-session="'+escape(s.sessionId||'')+'" data-cwd="'+path+'" data-name="'+name+'" title="终止本地 claude → 在新 Terminal 里启动 ccv -r 接上 session">接管 ▶</button>'
          +     '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+name+'">Shell</button>'
          +   '</div>'
          + '</div>';
      }).join('');
    }

    if (history && history.length) {
      history.sort((a,b) => new Date(b.lastUsed) - new Date(a.lastUsed));
      html += '<div class="section-hd" style="margin-top:16px"><span class="dot gray"></span>Recent (' + history.length + ')</div>';
      html += history.map(h => {
        const name = escape(h.projectName || '?');
        const path = escape(h.cwd || '');
        const ago = h.lastUsed ? fmtAge(h.lastUsed) + ' ago' : '';
        const logs = h.logCount ? h.logCount + ' logs' : '';
        return ''
          + '<div class="card idle">'
          +   '<div class="card-head"><span class="name">'+name+'</span></div>'
          +   '<div class="card-path" title="'+path+'">'+path+'</div>'
          +   '<div class="card-meta">'
          +     (ago ? '<span class="tag">' + ago + '</span>' : '')
          +     (logs ? '<span class="tag">' + logs + '</span>' : '')
          +   '</div>'
          +   '<div class="card-actions">'
          +     '<button class="btn primary" data-act="launch" data-cwd="'+path+'">Launch</button>'
          +     '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+name+'">Shell</button>'
          +     '<button class="btn danger" data-act="forget" data-wsid="'+(h.wsId||'')+'">Forget</button>'
          +   '</div>'
          + '</div>';
      }).join('');
    }
    // Preserve open details state across re-renders
    const openPids = new Set();
    listEl.querySelectorAll('details[open]').forEach(d => {
      const card = d.closest('[data-pid]');
      if (card) openPids.add(card.dataset.pid);
    });
    listEl.innerHTML = html;
    // Restore open state and render QR for previously open details
    if (openPids.size) {
      listEl.querySelectorAll('[data-pid]').forEach(card => {
        if (!openPids.has(card.dataset.pid)) return;
        const d = card.querySelector('details');
        if (!d) return;
        d.open = true;
        d.querySelectorAll('.qr[data-qr]').forEach(el => {
          if (el.dataset.qrDone) return;
          try { new QRCode(el, { text: el.dataset.qr, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); el.dataset.qrDone = '1'; } catch(e) {}
        });
      });
    }
  }

  // Render QR codes when <summary> is clicked (toggle event doesn't bubble, so use click on summary)
  listEl.addEventListener('click', (ev) => {
    const summary = ev.target.closest('summary');
    if (!summary) return;
    const details = summary.parentElement;
    // details.open is still the OLD state at click time; after click it flips.
    // So if it's currently closed, it's about to open.
    if (details.open) return; // closing
    requestAnimationFrame(() => {
      details.querySelectorAll('.qr[data-qr]').forEach(el => {
        if (el.dataset.qrDone) return;
        try { new QRCode(el, { text: el.dataset.qr, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); el.dataset.qrDone = '1'; } catch(e) {}
      });
    });
  });

  listEl.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    ev.preventDefault();
    const act = t.dataset.act;
    if (act === 'open') {
      openCcvInline(t.dataset.href, t.dataset.name || ('ccv :' + (t.dataset.port||'')), t.dataset.port || '', t.dataset.path || '');
    } else if (act === 'open-newtab') {
      // Reuse the per-instance tab on repeat clicks: a stable window name
      // (keyed by port) makes browsers focus the existing tab instead of
      // spawning a fresh one that has to reload from scratch.
      const winName = t.dataset.port ? 'ccv-' + t.dataset.port : '_blank';
      const w = window.open(t.dataset.href, winName);
      if (w) { try { w.focus(); } catch {} }
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(t.dataset.text || t.textContent); t.style.color='var(--ok)'; setTimeout(()=>t.style.color='', 800); } catch {}
    } else if (act === 'stop') {
      if (!confirm('Stop ccv "'+t.dataset.name+'" (pid '+t.dataset.pid+')?')) return;
      try { await api('/api/launcher/kill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pid: parseInt(t.dataset.pid,10) }) }); refresh(); }
      catch (e) { alert('Stop failed: ' + e.message); }
    } else if (act === 'launch') {
      try { await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: t.dataset.cwd }) }); refresh(); }
      catch (e) { alert('Launch failed: ' + e.message); }
    } else if (act === 'alias') {
      const cwd = t.dataset.cwd;
      const current = t.dataset.current || '';
      const next = window.prompt('设置别名（≤32 字符，留空清除；只在 launcher 内部生效，跟 ccv 自己的别名不同步）', current);
      if (next === null) return; // cancel
      try {
        await api('/api/launcher/prefs/alias', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, alias: next.trim() }) });
        refresh();
      } catch (e) { alert('保存别名失败: ' + e.message); }
    } else if (act === 'newhere') {
      const prev = t.textContent;
      t.disabled = true; t.textContent = 'Launching…';
      try {
        await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: t.dataset.cwd, force: true }) });
        refresh();
      } catch (e) { alert('Launch failed: ' + e.message); }
      finally { t.disabled = false; t.textContent = prev; }
    } else if (act === 'forget') {
      if (!confirm('Remove this project from history?')) return;
      try { await api('/api/launcher/forget', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wsId: t.dataset.wsid }) }); refresh(); }
      catch (e) { alert('Forget failed: ' + e.message); }
    } else if (act === 'console') {
      openConsole(t.dataset.port, t.dataset.token, t.dataset.name, t.dataset.path, t.dataset.pub, t.dataset.lan);
    } else if (act === 'openterm') {
      openShell(t.dataset.cwd, t.dataset.name || t.dataset.cwd);
    } else if (act === 'takeover') {
      const pid = parseInt(t.dataset.pid, 10);
      const sessionId = t.dataset.session;
      const cwd = t.dataset.cwd;
      const name = t.dataset.name || cwd;
      if (!confirm('接管本地 cc session?\\n\\n会做这些事:\\n  1. SIGTERM kill pid ' + pid + '（你那个 terminal 里的 claude 会退出）\\n  2. 打开新的 Terminal 窗口在 ' + name + '\\n  3. 跑 ccv -r ' + (sessionId||'').slice(0,8) + '… 接上原 session\\n\\n确定继续?')) return;
      const prev = t.textContent;
      t.disabled = true; t.textContent = '接管中…';
      try {
        await api('/api/launcher/takeover-cc-session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pid, sessionId, cwd }) });
        // Give Terminal.app + ccv a beat to register before refreshing
        setTimeout(refresh, 1500);
      } catch (e) {
        alert('接管失败: ' + e.message);
        t.disabled = false; t.textContent = prev;
      }
    }
  });

  // ---- Terminal overlay ----
  const TERM_FONT = "'NerdFont','MesloLGS NF','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace";
  let _fontReady = false;
  // Preload the NerdFont so xterm.js can measure glyphs correctly on first open
  document.fonts.load('14px NerdFont').then(() => { _fontReady = true; }).catch(() => {});

  // Mirrors cc-viewer/src/env.js + TerminalPanel.jsx:243-251 mobile detection.
  // iPadOS 13+ Safari spoofs Mac UA so we use maxTouchPoints to disambiguate;
  // smaller scrollback on iOS keeps memory pressure low (Safari kills
  // backgrounded tabs more aggressively when RAM is tight).
  const _isIPadOS = navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || _isIPadOS;
  const isPad = _isIPadOS || /iPad/i.test(navigator.userAgent);
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || _isIPadOS;

  // Shared xterm config — keeps both openConsole (ccv child WS) and openShell
  // (hub /ws/shell) terminals visually consistent and mobile-friendly.
  // iOS Safari falls back to a non-monospace font more often when given
  // exotic fontFamily lists, so on mobile we prefer the system monospace token.
  function buildTerminalConfig() {
    return {
      cursorBlink: true,
      fontSize: (isMobile && !isPad) ? 11 : 14,
      fontFamily: isMobile
        ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        : TERM_FONT,
      // iOS gets the smallest scrollback — RAM is the binding constraint there.
      scrollback: isPad ? 3000 : isIOS ? 200 : isMobile ? 500 : 3000,
      theme: { background: '#0f1115', foreground: '#e6e8ec', cursor: '#6ea8fe' },
    };
  }

  let _term = null, _termWs = null;
  const termOverlay = document.getElementById('term-overlay');
  const termContainer = document.getElementById('term-container');
  const termType = document.getElementById('term-type');
  const termName = document.getElementById('term-name');
  const termPath = document.getElementById('term-path');
  document.getElementById('term-close').addEventListener('click', closeTerminal);

  function openConsole(port, token, name, path, pubUrl, lanUrl) {
    closeTerminal();
    termType.textContent = 'Console';
    termType.className = 'type-tag console';
    termName.textContent = name || ':' + port;
    termPath.textContent = path || '';
    termOverlay.classList.add('open');

    _term = new Terminal(buildTerminalConfig());
    const fitAddon = new FitAddon.FitAddon();
    _term.loadAddon(fitAddon);
    _term.open(termContainer);
    fitAddon.fit();

    // Build WS URL: prefer same-origin relative path if port matches hub, otherwise cross-origin to child
    let wsUrl;
    const loc = window.location;
    if (pubUrl) {
      // public: wss://<public-host>/ws/terminal (host derived from pubUrl)
      try {
        const u = new URL(pubUrl);
        wsUrl = (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host + '/ws/terminal';
      } catch { /* fallback below */ }
    }
    if (!wsUrl && lanUrl) {
      try {
        const u = new URL(lanUrl);
        wsUrl = 'ws://' + u.host + '/ws/terminal';
      } catch { /* fallback below */ }
    }
    if (!wsUrl) {
      wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.hostname + ':' + port + '/ws/terminal';
    }

    _term.writeln('\\x1b[90mConnecting to ' + wsUrl + '...\\x1b[0m');
    _termWs = new WebSocket(wsUrl);
    _termWs.onopen = () => {
      _term.writeln('\\x1b[32mConnected.\\x1b[0m Press Enter to get a prompt.');
      _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
    };
    _termWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data' && msg.data) _term.write(msg.data);
        else if (msg.type === 'exit') _term.writeln('\\r\\n\\x1b[33m[process exited: ' + (msg.exitCode ?? '?') + ']\\x1b[0m');
        else if (msg.type === 'state' && !msg.running) _term.writeln('\\x1b[90m[no active process — type to spawn shell]\\x1b[0m');
      } catch { _term.write(ev.data); }
    };
    _termWs.onerror = () => _term.writeln('\\r\\n\\x1b[31mWebSocket error\\x1b[0m');
    _termWs.onclose = () => _term.writeln('\\r\\n\\x1b[90m[disconnected]\\x1b[0m');

    _term.onData((data) => {
      if (_termWs && _termWs.readyState === 1) {
        _termWs.send(JSON.stringify({ type: 'input', data }));
      }
    });
    _term.onResize(({ cols, rows }) => {
      if (_termWs && _termWs.readyState === 1) {
        _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    ro.observe(termContainer);
    termOverlay._ro = ro;
    if (!_fontReady && !isMobile) document.fonts.ready.then(() => { _fontReady = true; if (_term) { _term.options.fontFamily = TERM_FONT; fitAddon.fit(); } });
  }

  function openShell(cwd, name) {
    closeTerminal();
    termType.textContent = 'Shell';
    termType.className = 'type-tag shell';
    termName.textContent = name || cwd;
    termPath.textContent = cwd || '';
    termOverlay.classList.add('open');

    _term = new Terminal(buildTerminalConfig());
    const fitAddon = new FitAddon.FitAddon();
    _term.loadAddon(fitAddon);
    _term.open(termContainer);
    fitAddon.fit();

    // Connect to hub's own /ws/shell endpoint (same origin). If we have a
    // resumable sessionId from a previous /ws/shell connection (PB3), pass
    // it so the server replays buffered output and reattaches to the live
    // PTY instead of spawning a fresh one. sessionStorage (not localStorage)
    // because the resume is meaningful only within the same tab lifetime —
    // a new tab gets a fresh shell.
    const loc = window.location;
    const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const storedSid = (() => { try { return sessionStorage.getItem('ccvShellSessionId'); } catch { return null; } })();
    const sidParam = storedSid ? '&sessionId=' + encodeURIComponent(storedSid) : '';
    const wsUrl = wsProto + '//' + loc.host + '/ws/shell?cwd=' + encodeURIComponent(cwd) + sidParam;

    _term.writeln('\\x1b[90m$ cd ' + cwd + '\\x1b[0m');
    _termWs = new WebSocket(wsUrl);
    _termWs.onopen = () => {
      _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
    };
    _termWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello' && msg.sessionId) {
          // Server rotates sessionId on every successful (re)attach; persist
          // immediately so a quick disconnect+reconnect picks it up.
          try { sessionStorage.setItem('ccvShellSessionId', msg.sessionId); } catch {}
          if (msg.isReattach) _term.writeln('\\x1b[32m[reattached to existing shell]\\x1b[0m');
        }
        else if (msg.type === 'data' && msg.data) _term.write(msg.data);
        else if (msg.type === 'exit') {
          _term.writeln('\\r\\n\\x1b[33m[shell exited: ' + (msg.exitCode ?? '?') + ']\\x1b[0m');
          // Shell ended for real (not a network drop) — drop the stored id
          // so the next openShell starts fresh instead of trying to resume
          // a dead session.
          try { sessionStorage.removeItem('ccvShellSessionId'); } catch {}
        }
      } catch { _term.write(ev.data); }
    };
    _termWs.onerror = () => _term.writeln('\\r\\n\\x1b[31mWebSocket error\\x1b[0m');
    _termWs.onclose = () => _term.writeln('\\r\\n\\x1b[90m[disconnected]\\x1b[0m');

    _term.onData((data) => {
      if (_termWs && _termWs.readyState === 1) _termWs.send(JSON.stringify({ type: 'input', data }));
    });
    _term.onResize(({ cols, rows }) => {
      if (_termWs && _termWs.readyState === 1) _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    ro.observe(termContainer);
    termOverlay._ro = ro;
    if (!_fontReady && !isMobile) document.fonts.ready.then(() => { _fontReady = true; if (_term) { _term.options.fontFamily = TERM_FONT; fitAddon.fit(); } });
  }

  function closeTerminal() {
    termOverlay.classList.remove('open');
    if (_termWs) { try { _termWs.close(); } catch {} _termWs = null; }
    if (_term) { _term.dispose(); _term = null; }
    if (termOverlay._ro) { termOverlay._ro.disconnect(); termOverlay._ro = null; }
    termContainer.innerHTML = '';
    // Explicit close = user dismissed; don't try to resume on next open.
    // Server-side: ws.close fires markOrphan with a 5min TTL, so the PTY
    // sticks around briefly — that's fine, it'll be reaped.
    try { sessionStorage.removeItem('ccvShellSessionId'); } catch {}
  }

  // ESC closes terminal overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && termOverlay.classList.contains('open')) closeTerminal();
  });

  // ---- ccv inline overlay (iframe) ----
  // Open a ccv session inside the launcher tab via an iframe. Lets the user
  // bounce between sessions without losing the launcher state. Closing clears
  // the iframe src to free the WebSocket; reopening reloads from scratch.
  const ccvOverlay = document.getElementById('ccv-overlay');
  const ccvFrame = document.getElementById('ccv-frame');
  const ccvName = document.getElementById('ccv-name');
  const ccvPort = document.getElementById('ccv-port');
  const ccvPath = document.getElementById('ccv-path');
  const ccvFrameStatus = document.getElementById('ccv-frame-status');
  const ccvFrameStatusLoading = ccvFrameStatus.querySelector('[data-state="loading"]');
  const ccvFrameStatusError = ccvFrameStatus.querySelector('[data-state="error"]');
  const ccvFrameErrDetail = document.getElementById('ccv-frame-err-detail');
  let _ccvLastHref = '';
  let _ccvLoadWatchdog = null;
  let _ccvLoadStartedAt = 0;

  function setCcvFrameState(state, detail) {
    if (state === 'ok') {
      ccvFrameStatus.classList.remove('show');
      return;
    }
    ccvFrameStatus.classList.add('show');
    if (state === 'loading') {
      ccvFrameStatusLoading.style.display = 'flex';
      ccvFrameStatusError.style.display = 'none';
    } else { // error
      ccvFrameStatusLoading.style.display = 'none';
      ccvFrameStatusError.style.display = 'flex';
      if (detail) ccvFrameErrDetail.textContent = detail;
    }
  }

  function openCcvInline(href, name, port, path) {
    if (!href || href === '#') return;
    ccvName.textContent = name || '';
    ccvPort.textContent = port ? ':' + port : '';
    ccvPath.textContent = path || '';
    // Always force a reload, even when reopening the same href — the ccv on
    // that port may have restarted (token rotated) since we last loaded it,
    // and a stale src would silently 403 → black screen. Setting src to
    // about:blank first then to the target URL guarantees a fresh load even
    // when href === current src.
    setCcvFrameState('loading');
    _ccvLoadStartedAt = Date.now();
    ccvFrame.src = 'about:blank';
    // Wait for blank to commit before navigating to target — otherwise some
    // browsers coalesce the two navigations and the load event fires for blank.
    requestAnimationFrame(() => {
      ccvFrame.src = href;
      _ccvLastHref = href;
    });
    ccvOverlay.classList.add('open');
    // Watchdog: if ccv doesn't respond in 6s we surface a retry/new-tab UI
    // instead of leaving the user staring at black. ccv's index.html is
    // ~1.6KB + a few module chunks; on localhost this should always finish in
    // well under a second when ccv is healthy.
    if (_ccvLoadWatchdog) clearTimeout(_ccvLoadWatchdog);
    _ccvLoadWatchdog = setTimeout(() => {
      // Only surface error if we haven't seen a successful load
      if (ccvFrameStatus.classList.contains('show')) {
        setCcvFrameState('error', 'Timed out waiting for ccv to respond. The instance may have just been restarted, or the iframe was blocked.');
      }
    }, 6000);
  }
  function closeCcvInline() {
    ccvOverlay.classList.remove('open');
    if (_ccvLoadWatchdog) { clearTimeout(_ccvLoadWatchdog); _ccvLoadWatchdog = null; }
    // Free the iframe so WebSocket / streaming connections drop. Reopening
    // means a fresh load — ccv boots fast enough that this is the right
    // tradeoff vs leaking N hidden iframes.
    ccvFrame.src = 'about:blank';
    _ccvLastHref = '';
    setCcvFrameState('ok');
  }
  ccvFrame.addEventListener('load', () => {
    // load fires for both about:blank and the real navigation; only count the
    // real one (i.e., when src is not about:blank).
    const src = ccvFrame.getAttribute('src') || '';
    if (src === 'about:blank' || src === '') return;
    // Tiny grace so SPA module imports get a chance to start rendering before
    // we reveal the iframe — avoids a brief flash of pre-React DOM.
    setTimeout(() => setCcvFrameState('ok'), 120);
    if (_ccvLoadWatchdog) { clearTimeout(_ccvLoadWatchdog); _ccvLoadWatchdog = null; }
  });
  document.getElementById('ccv-close').addEventListener('click', closeCcvInline);
  document.getElementById('ccv-reload').addEventListener('click', () => {
    if (_ccvLastHref) openCcvInline(_ccvLastHref, ccvName.textContent, (ccvPort.textContent||'').replace(/^:/,''), ccvPath.textContent);
  });
  document.getElementById('ccv-frame-retry').addEventListener('click', () => {
    if (_ccvLastHref) openCcvInline(_ccvLastHref, ccvName.textContent, (ccvPort.textContent||'').replace(/^:/,''), ccvPath.textContent);
  });
  document.getElementById('ccv-frame-newtab').addEventListener('click', () => {
    if (!_ccvLastHref) return;
    const winName = ccvPort.textContent ? 'ccv-' + ccvPort.textContent.replace(/^:/,'') : '_blank';
    const w = window.open(_ccvLastHref, winName);
    if (w) { try { w.focus(); } catch {} }
    closeCcvInline();
  });
  document.getElementById('ccv-newtab').addEventListener('click', () => {
    if (!_ccvLastHref) return;
    const winName = ccvPort.textContent ? 'ccv-' + ccvPort.textContent.replace(/^:/,'') : '_blank';
    const w = window.open(_ccvLastHref, winName);
    if (w) { try { w.focus(); } catch {} }
    closeCcvInline();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ccvOverlay.classList.contains('open')) closeCcvInline();
  });

  async function refresh() {
    try {
      const data = await api('/api/launcher/list');
      render(data.instances || [], data.history || [], data.localCcSessions || []);
      refreshActivity();
    }
    catch (e) { listEl.innerHTML = '<div class="empty err">'+escape(e.message)+'</div>'; }
  }

  // ---- activity poll: per-card status badge + preview + drawer ----
  function eventLineHtml(ev) {
    const parts = [];
    const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour12:false }) : '';
    let body = '';
    if (ev.userPrompt) body += '<div class="event-line user">user · ' + escape(ev.userPrompt) + '</div>';
    if (ev.toolUse)    body += '<div class="event-line tool">🛠 ' + escape(ev.toolUse) + (ev.inProgress ? ' <span class="event-line flag">…streaming</span>' : '') + '</div>';
    if (ev.assistantText && !ev.toolUse) body += '<div class="event-line assistant">claude · ' + escape(ev.assistantText) + '</div>';
    if (!body) body = '<div class="event-line assistant">' + (ev.inProgress ? 'streaming…' : 'request') + '</div>';
    parts.push('<div class="event-row"><span class="event-ts">' + escape(ts) + '</span><div class="event-body">' + body + '</div></div>');
    return parts.join('');
  }

  function renderDrawer(act) {
    const sections = [];
    if (act.pendingAsks && act.pendingAsks.length) {
      const items = act.pendingAsks.map(a => {
        const q = (a.questions && a.questions[0]) || {};
        const label = q.header || q.question || '(question)';
        return '<div class="ask-row">⏳ ' + escape(label) + '</div>';
      }).join('');
      sections.push('<div class="drawer-section"><div class="drawer-h">pending asks (' + act.pendingAsks.length + ')</div>' + items + '</div>');
    }
    if (act.recentEvents && act.recentEvents.length) {
      const rows = act.recentEvents.map(eventLineHtml).join('');
      sections.push('<div class="drawer-section"><div class="drawer-h">recent activity</div>' + rows + '</div>');
    } else {
      sections.push('<div class="drawer-section"><div class="drawer-h">recent activity</div><div class="event-line assistant">no entries</div></div>');
    }
    if (act.logFile) {
      sections.push('<div class="drawer-section"><div class="drawer-h">log file</div><div class="event-line assistant">' + escape(act.logFile) + '</div></div>');
    }
    return sections.join('');
  }

  async function refreshActivity() {
    let data;
    try { data = await api('/api/launcher/activity'); }
    catch (e) { return; }
    const acts = data.activity || [];
    for (const act of acts) {
      const row = document.querySelector('[data-act-row="' + act.pid + '"]');
      if (!row) continue;
      const badge = row.querySelector('.badge');
      const preview = row.querySelector('.preview');
      if (badge) {
        badge.className = 'badge ' + (act.status || 'no_session');
        badge.textContent = act.statusLabel || '';
      }
      if (preview) preview.textContent = act.preview || '';
      const titleEl = document.querySelector('[data-title-for="' + act.pid + '"]');
      if (titleEl) {
        if (act.title) {
          titleEl.textContent = act.title;
          titleEl.title = act.title; // full text on hover
        } else {
          titleEl.textContent = '';
          titleEl.removeAttribute('title');
        }
      }
      const drawer = document.querySelector('[data-act-drawer="' + act.pid + '"]');
      if (drawer) {
        drawer.dataset.payload = JSON.stringify(act);
        if (drawer.classList.contains('open')) drawer.innerHTML = renderDrawer(act);
      }
    }
  }

  // Drawer toggle (delegate click)
  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act="actdrawer"]');
    if (!t) return;
    e.preventDefault();
    const pid = t.dataset.pid;
    const drawer = document.querySelector('[data-act-drawer="' + pid + '"]');
    if (!drawer) return;
    const opening = !drawer.classList.contains('open');
    drawer.classList.toggle('open', opening);
    t.textContent = opening ? '▴' : '▾';
    if (opening) {
      let payload = null;
      try { payload = drawer.dataset.payload ? JSON.parse(drawer.dataset.payload) : null; } catch {}
      if (payload) drawer.innerHTML = renderDrawer(payload);
      else drawer.innerHTML = '<div class="drawer-section"><div class="event-line assistant">loading…</div></div>';
      // Pull fresh state on open
      api('/api/launcher/instances/' + pid + '/activity').then(d => {
        drawer.dataset.payload = JSON.stringify(d);
        if (drawer.classList.contains('open')) drawer.innerHTML = renderDrawer(d);
      }).catch(() => { /* keep stale view */ });
    }
  });

  // 3s poll while page visible
  let _activityTimer = null;
  function startActivityPolling() {
    if (_activityTimer) return;
    _activityTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshActivity();
    }, 3000);
  }
  startActivityPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshActivity();
  });

  // dir browser
  let _curDir = '';
  async function loadDir(path) {
    errEl.hidden = true;
    try {
      const q = path ? '?path=' + encodeURIComponent(path) : '';
      const data = await api('/api/launcher/browse-dir' + q);
      _curDir = data.current; cwdInput.value = data.current;
      const rows = [];
      if (data.parent) rows.push('<div class="row up" data-dir="'+escape(data.parent)+'">.. ('+escape(data.parent)+')</div>');
      for (const d of (data.dirs||[])) {
        rows.push('<div class="row dir" data-dir="'+escape(d.path)+'">'+escape(d.name)+(d.hasGit?'  <span style="color:var(--accent);font-size:10px">git</span>':'')+'</div>');
      }
      treeEl.innerHTML = rows.join('') || '<div style="padding:10px">empty</div>';
    } catch (e) {
      errEl.textContent = 'Browse failed: ' + e.message; errEl.hidden = false;
    }
  }
  treeEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-dir]'); if (!t) return;
    loadDir(t.dataset.dir);
  });
  cwdInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); loadDir(cwdInput.value.trim()); }
  });
  document.getElementById('btn-new').onclick = () => { errEl.hidden = true; loadDir(_curDir || ''); loadCcuseProfiles(); dlg.showModal(); };
  document.getElementById('btn-cancel').onclick = () => dlg.close();
  document.getElementById('btn-launch').onclick = async () => {
    errEl.hidden = true;
    const cwd = cwdInput.value.trim();
    if (!cwd) { errEl.textContent='Pick a directory first'; errEl.hidden=false; return; }
    const btn = document.getElementById('btn-launch');
    const ccuseSelect = document.getElementById('ccuse-select');
    const ccuseProfile = ccuseSelect ? ccuseSelect.value : '';
    btn.disabled = true; btn.textContent = 'Launching…';
    try {
      await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, ccuseProfile }) });
      dlg.close(); refresh();
    } catch (e) { errEl.textContent = 'Launch failed: ' + e.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Launch'; }
  };

  // Populate ccuse profile dropdown on dialog open. Cached so we don't refetch
  // every dialog show — the profile list rarely changes within a session.
  let _ccuseProfilesLoaded = false;
  async function loadCcuseProfiles() {
    if (_ccuseProfilesLoaded) return;
    try {
      const data = await api('/api/launcher/prefs');
      const select = document.getElementById('ccuse-select');
      if (!select) return;
      const profiles = data.availableProfiles || [];
      const def = data.defaultCcuseProfile || '';
      // preserve current selection if any
      const cur = select.value;
      // wipe existing options except the placeholder
      while (select.options.length > 1) select.remove(1);
      for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p + (p === def ? '  (默认)' : '');
        select.appendChild(opt);
      }
      if (cur) select.value = cur;
      else if (def) select.value = def;
      _ccuseProfilesLoaded = true;
    } catch { /* graceful: dropdown stays minimal */ }
  }

  // Page Visibility-aware poller: pauses when tab is hidden (no point polling
  // a backgrounded iOS Safari tab whose connections may already be suspended)
  // and fires once immediately on visibilitychange→visible so the user sees
  // fresh data the moment they return.
  function visibilityPoll(fn, intervalMs) {
    let timer = null;
    function start() { if (timer == null) timer = setInterval(fn, intervalMs); }
    function stop() { if (timer != null) { clearInterval(timer); timer = null; } }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else { fn(); start(); }
    });
    if (!document.hidden) start();
  }

  refresh();
  // 30s polling: new/kill flows refresh immediately on user action, so
  // background polling only catches out-of-band changes (e.g. another tab
  // spawned, hub auto-restarted). Public bandwidth concern beats latency here.
  visibilityPoll(refresh, 30000);

  // ---- Pair notification polling ----
  const pairZone = document.getElementById('pair-zone');
  async function refreshPairs() {
    try {
      const data = await api('/api/launcher/pair-list');
      if (!data.pending || !data.pending.length) { pairZone.innerHTML = ''; return; }
      pairZone.innerHTML = data.pending.map(p => ''
        + '<div class="pair-banner">'
        +   '<div class="pair-info">'
        +     '<span class="pair-code">' + escape(p.code) + '</span> '
        +     '<span class="pair-device">' + escape(p.device) + ' &middot; ' + escape(p.ip) + ' &middot; ' + p.age + 's ago</span>'
        +   '</div>'
        +   '<div class="pair-actions">'
        +     '<button class="approve" data-pair-code="'+escape(p.code)+'">Approve</button>'
        +     '<button class="reject" data-pair-reject="'+escape(p.code)+'">Reject</button>'
        +   '</div>'
        + '</div>'
      ).join('');
    } catch {}
  }
  pairZone.addEventListener('click', async (ev) => {
    const approveBtn = ev.target.closest('[data-pair-code]');
    const rejectBtn = ev.target.closest('[data-pair-reject]');
    if (approveBtn) {
      try {
        await api('/api/launcher/pair-approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: approveBtn.dataset.pairCode }) });
        approveBtn.textContent = 'Approved';
        approveBtn.disabled = true;
        setTimeout(refreshPairs, 1000);
      } catch (e) { alert('Approve failed: ' + e.message); }
    } else if (rejectBtn) {
      try {
        await api('/api/launcher/pair-reject', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: rejectBtn.dataset.pairReject }) });
        refreshPairs();
      } catch {}
    }
  });
  refreshPairs();
  visibilityPoll(refreshPairs, 5000);
})();
</script>
</body>
</html>
`;

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > max) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// True when this request belongs to the launcher's own surface
// (hub-only HTML + JSON API). These bypass ccv's token auth on purpose so the
// public bookmark `https://<hub-domain>/launcher` works without the caller
// knowing the hub's per-process token.
function isLauncherPath(pathname) {
  return pathname === '/launcher' || pathname.startsWith('/launcher/') || pathname.startsWith('/api/launcher/') || pathname === '/healthz';
}

// Paths that don't require session auth (pair flow itself + healthz for monitors)
function isPairPath(pathname) {
  return pathname === '/launcher/pair' || pathname === '/launcher/pair/complete' || pathname.startsWith('/api/launcher/pair-') || pathname === '/healthz';
}

async function dispatchLauncherRoute(req, res, parsedUrl) {
  const url = parsedUrl.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // /healthz: lightweight liveness probe for monitors (no auth required).
  // Returns ok + key counters; never blocks on disk or external state.
  // wsCount = open /ws/shell sockets; orphanCount = PTYs with no attached
  // socket (becomes meaningful once PB3 lands session resume — today a PTY
  // is always tied to a live ws so this is normally 0 except briefly during
  // close races).
  if (url === '/healthz' && method === 'GET') {
    const wsCount = _shellWss ? _shellWss.clients.size : 0;
    const ptyCount = _ptyManager ? _ptyManager._stats().sessions : 0;
    // Manager sessions whose ws went away are "orphaned" until the TTL
    // expires; on the wire this looks like ptyCount > wsCount.
    const orphanCount = Math.max(0, ptyCount - wsCount);
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      ptyCount,
      ptyCap: SHELL_PTY_CAP,
      wsCount,
      orphanCount,
      sessionCount: approvedSessions.size,
      instanceCount: instances.size,
      pendingPairs: pendingPairs.size,
    });
    return;
  }

  // Auth gate: non-pair launcher paths require session cookie (public only)
  if (!isPairPath(url) && !isAuthenticated(req)) {
    res.writeHead(302, { Location: '/launcher/pair' });
    res.end();
    return;
  }

  // ---- Pair routes ----

  if (url === '/launcher/pair' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAIR_PAGE);
    return;
  }

  if (url === '/api/launcher/pair-request' && method === 'POST') {
    cleanExpiredPairs();
    const code = generatePairCode();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    pendingPairs.set(code, { code, userAgent: ua, ip, createdAt: Date.now(), sessionToken: null });
    log('pair request from', shortUA(ua), ip, '→ code', code);
    sendJson(res, 200, { code });
    return;
  }

  if (url === '/api/launcher/pair-status' && method === 'GET') {
    const code = parsedUrl.searchParams.get('code');
    const pair = code && pendingPairs.get(code);
    if (!pair) { sendJson(res, 200, { approved: false, expired: true }); return; }
    if (Date.now() - pair.createdAt > PAIR_CODE_TTL_MS) {
      pendingPairs.delete(code);
      sendJson(res, 200, { approved: false, expired: true });
      return;
    }
    if (pair.sessionToken) {
      sendJson(res, 200, { approved: true, redirect: '/launcher/pair/complete?code=' + code });
    } else {
      sendJson(res, 200, { approved: false, expired: false });
    }
    return;
  }

  if (url === '/launcher/pair/complete' && method === 'GET') {
    const code = parsedUrl.searchParams.get('code');
    const pair = code && pendingPairs.get(code);
    if (!pair || !pair.sessionToken) {
      res.writeHead(302, { Location: '/launcher/pair' });
      res.end();
      return;
    }
    const token = pair.sessionToken;
    pendingPairs.delete(code);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      Location: '/launcher',
      'Set-Cookie': `ccv_session=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    });
    res.end();
    return;
  }

  if (url === '/api/launcher/pair-approve' && method === 'POST') {
    // Only LAN clients can approve
    if (!isLanIp(getClientIp(req))) {
      sendJson(res, 403, { error: 'approve only from LAN' });
      return;
    }
    const raw = await readBody(req);
    const { code } = JSON.parse(raw || '{}');
    const pair = code && pendingPairs.get(code);
    if (!pair) { sendJson(res, 400, { error: 'unknown or expired code' }); return; }
    const sessionToken = randomBytes(24).toString('hex');
    pair.sessionToken = sessionToken;
    approvedSessions.set(sessionToken, { createdAt: Date.now(), userAgent: pair.userAgent, ip: pair.ip });
    saveSessions();
    log('pair approved:', code, '→', shortUA(pair.userAgent), pair.ip);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url === '/api/launcher/pair-reject' && method === 'POST') {
    if (!isLanIp(getClientIp(req))) {
      sendJson(res, 403, { error: 'reject only from LAN' });
      return;
    }
    const raw = await readBody(req);
    const { code } = JSON.parse(raw || '{}');
    if (code) pendingPairs.delete(code);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url === '/api/launcher/pair-list' && method === 'GET') {
    cleanExpiredPairs();
    const list = [...pendingPairs.values()]
      .filter(p => !p.sessionToken)
      .map(p => ({ code: p.code, device: shortUA(p.userAgent), ip: p.ip, age: Math.floor((Date.now() - p.createdAt) / 1000) }));
    sendJson(res, 200, { pending: list });
    return;
  }

  if (url === '/launcher/logout' && method === 'GET') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.ccv_session) { approvedSessions.delete(cookies.ccv_session); saveSessions(); }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      Location: '/launcher/pair',
      'Set-Cookie': `ccv_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    });
    res.end();
    return;
  }

  // ---- Main launcher routes ----

  if (url === '/launcher' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (url === '/api/launcher/list' && method === 'GET') {
    rescanRuntime();
    await backfillExternalCcvs();
    const running = [...instances.values()];
    const runningCwds = new Set(running.map(i => i.cwd));
    // merge workspace-registry history: show idle projects not currently running
    let idle = [];
    try {
      const wsHistory = getWorkspaces();
      idle = wsHistory
        .filter(w => w.path && !runningCwds.has(w.path))
        .filter(w => existsSync(w.path)) // skip deleted dirs
        .map(w => ({
          wsId: w.id,
          cwd: w.path,
          projectName: w.projectName,
          lastUsed: w.lastUsed,
          logCount: w.logCount || 0,
          totalSize: w.totalSize || 0,
          status: 'idle',
        }));
    } catch (e) { log('getWorkspaces error:', e.message); }
    // Enrich each instance with launcher-side prefs (alias + ccuse profile) so
    // the frontend can render them without an extra round-trip.
    const enrichedRunning = running.map(i => ({
      ...i,
      alias: getAlias(i.cwd),
      ccuseProfile: getCcuseProfile(i.cwd),
    }));
    const enrichedIdle = idle.map(i => ({
      ...i,
      alias: getAlias(i.cwd),
    }));
    sendJson(res, 200, { instances: enrichedRunning, history: enrichedIdle, localCcSessions: listLocalCcSessions() });
    return;
  }

  // POST { pid, sessionId, cwd } — kill the bare claude pid (SIGTERM, then
  // SIGKILL after a grace period) then open a Terminal window with
  // `ccv -r <sessionId> --d` so claude resumes inside the new ccv. The user
  // gets one fresh Terminal window; the launcher then auto-discovers the new
  // ccv via runtime/ + lsof backfill on next refresh.
  if (url === '/api/launcher/takeover-cc-session' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
    const { pid, sessionId, cwd } = body || {};
    if (!Number.isFinite(pid) || pid <= 1) { sendJson(res, 400, { error: 'pid required' }); return; }
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      sendJson(res, 400, { error: 'sessionId must be a UUID' });
      return;
    }
    if (typeof cwd !== 'string' || !cwd) { sendJson(res, 400, { error: 'cwd required' }); return; }
    // Re-scan ps to confirm the targeted pid still belongs to this session.
    // Stops us from killing an unrelated process if the user lingered on a
    // stale row. force=true skips the 5s cache.
    const live = listLocalCcSessions(true).find(s => s.pid === pid && s.sessionId === sessionId);
    if (!live) { sendJson(res, 409, { error: 'session no longer active or already under ccv' }); return; }
    try {
      await killClaudePid(pid);
    } catch (err) {
      sendJson(res, 500, { error: 'kill failed: ' + err.message });
      return;
    }
    try {
      spawnCcvInTerminal(cwd, ['-r', sessionId]);
    } catch (err) {
      sendJson(res, 500, { error: 'terminal launch failed: ' + err.message });
      return;
    }
    // Invalidate cache so next /list doesn't show the dead pid for 5s.
    _localCcCache.at = 0;
    sendJson(res, 200, { ok: true, killedPid: pid, cwd, sessionId });
    return;
  }

  // Batch activity probe — what each running ccv is doing right now.
  // Cached per-pid 1.5s, ~1 fetch + 1 file tail per instance per poll.
  if (url === '/api/launcher/activity' && method === 'GET') {
    rescanRuntime();
    await backfillExternalCcvs();
    const running = [...instances.values()];
    try {
      const list = await Promise.all(running.map(async inst => {
        try {
          return await getInstanceActivity(inst);
        } catch (err) {
          return { pid: inst.pid, status: 'error', statusLabel: '⚠ ' + (err?.message || 'probe failed'), preview: '', recentEvents: [], pendingAsks: [] };
        }
      }));
      sendJson(res, 200, { activity: list });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Single-instance activity (for drawer expand)
  {
    const m = url.match(/^\/api\/launcher\/instances\/(\d+)\/activity$/);
    if (m && method === 'GET') {
      const pid = parseInt(m[1], 10);
      rescanRuntime();
      await backfillExternalCcvs();
      const inst = instances.get(pid);
      if (!inst) {
        sendJson(res, 404, { error: 'instance not found' });
        return;
      }
      try {
        const data = await getInstanceActivity(inst);
        sendJson(res, 200, data);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
  }

  if (url === '/api/launcher/browse-dir' && method === 'GET') {
    try {
      const requested = parsedUrl.searchParams.get('path') || homedir();
      const target = resolvePath(requested);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        sendJson(res, 400, { error: 'invalid directory' });
        return;
      }
      const dirs = [];
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        const fullPath = join(target, entry.name);
        let hasGit = false;
        try { hasGit = existsSync(join(fullPath, '.git')); } catch { /* ignore */ }
        dirs.push({ name: entry.name, path: fullPath, hasGit });
      }
      dirs.sort((a, b) => (a.hasGit !== b.hasGit ? (a.hasGit ? -1 : 1) : a.name.localeCompare(b.name)));
      const parent = resolvePath(target, '..');
      sendJson(res, 200, { current: target, parent: parent !== target ? parent : null, dirs });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/spawn' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { cwd, force, ccuseProfile } = JSON.parse(raw || '{}');
      // If client passes a profile, persist it as this cwd's preferred profile
      // so future spawns default to it without explicit selection.
      if (typeof ccuseProfile === 'string' && cwd) {
        setCcuseProfile(cwd, ccuseProfile);
      }
      const entry = await serializeSpawn(() => doSpawn(cwd, { force: !!force, ccuseProfile: ccuseProfile || '' }));
      sendJson(res, 200, { ok: true, instance: entry });
    } catch (err) {
      log('spawn error:', err.message);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/kill' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { pid } = JSON.parse(raw || '{}');
      const numericPid = parseInt(pid, 10);
      if (!Number.isFinite(numericPid)) throw new Error('pid required');
      if (numericPid === process.pid) throw new Error('cannot kill hub itself');
      if (!instances.has(numericPid)) throw new Error('unknown pid');
      try { process.kill(numericPid, 'SIGTERM'); } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
      // Optimistically remove; the watcher will confirm via runtime file deletion.
      instances.delete(numericPid);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      log('kill error:', err.message);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/forget' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { wsId } = JSON.parse(raw || '{}');
      if (!wsId) throw new Error('wsId required');
      const removed = removeWorkspace(wsId);
      sendJson(res, 200, { ok: removed });
    } catch (err) {
      log('forget error:', err.message);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // Launcher-side prefs (aliases + ccuse profiles + default profile + tags + thresholds + worktree)
  if (url === '/api/launcher/prefs' && method === 'GET') {
    try {
      const prefs = loadPrefs();
      const profiles = await listCcuseProfiles();
      sendJson(res, 200, { ...prefs, availableProfiles: profiles, allTags: getAllTags() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/prefs/alias' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { cwd: targetCwd, alias } = JSON.parse(raw || '{}');
      if (!targetCwd) throw new Error('cwd required');
      setAlias(targetCwd, alias || '');
      sendJson(res, 200, { ok: true, alias: getAlias(targetCwd) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/prefs/ccuse-profile' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (typeof body.default === 'string') {
        setDefaultCcuseProfile(body.default);
      }
      if (body.cwd) {
        setCcuseProfile(body.cwd, body.profile || '');
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/prefs/tags' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (!body.cwd) throw new Error('cwd required');
      if (!Array.isArray(body.tags)) throw new Error('tags must be an array');
      setTags(body.cwd, body.tags);
      sendJson(res, 200, { ok: true, tags: getTags(body.cwd), allTags: getAllTags() });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/prefs/compact-threshold' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (!body.cwd) throw new Error('cwd required');
      setCompactThreshold(body.cwd, {
        auto_compact_at: body.auto_compact_at,
        auto_clear_at: body.auto_clear_at,
        enabled: body.enabled,
      });
      sendJson(res, 200, { ok: true, threshold: getCompactThreshold(body.cwd) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/prefs/worktree-default' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      setWorktreeDefault(!!body.value);
      sendJson(res, 200, { ok: true, worktreeDefault: getWorktreeDefault() });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/open-terminal' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { cwd: targetCwd } = JSON.parse(raw || '{}');
      if (!targetCwd) throw new Error('cwd required');
      const resolved = realpathSync(targetCwd);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('not a directory');
      spawn('open', ['-a', 'Terminal', resolved], { stdio: 'ignore', detached: true }).unref();
      sendJson(res, 200, { ok: true, cwd: resolved });
    } catch (err) {
      log('open-terminal error:', err.message);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'launcher route not found' });
}

// Replace the http server's request listener with a multiplexer:
// launcher paths handled here (no ccv token check), everything else delegated
// untouched to ccv's own handler. The original listener is captured before
// removal so subsequent `request` events still hit it for non-launcher URLs.
function installRequestMultiplexer(httpServer, ccvProtocol) {
  const existing = httpServer.listeners('request');
  if (existing.length === 0) {
    log('installRequestMultiplexer: no existing request listener; skipping');
    return;
  }
  // ccv attaches exactly one listener (handleRequest from server.js). Keep it.
  const original = existing[0];
  for (const fn of existing) httpServer.removeListener('request', fn);

  httpServer.on('request', (req, res) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `${ccvProtocol || 'http'}://${req.headers.host || 'localhost'}`);
    } catch {
      return original(req, res);
    }
    if (isLauncherPath(parsedUrl.pathname)) {
      dispatchLauncherRoute(req, res, parsedUrl).catch((err) => {
        log('launcher dispatch error:', err && err.message);
        if (!res.headersSent) {
          try { sendJson(res, 500, { error: 'launcher plugin error' }); } catch { /* ignore */ }
        }
      });
      return;
    }
    return original(req, res);
  });
}

// ---- /ws/shell WebSocket: spawn independent zsh in a given cwd ----
function installShellWebSocket(httpServer) {
  let pty;
  try {
    pty = ccvRequire('node-pty');
  } catch (err) {
    log('node-pty not available, /ws/shell disabled:', err.message);
    return;
  }
  if (!PtySessionManager) {
    log('PtySessionManager not available in this cc-viewer build, /ws/shell disabled');
    return;
  }
  const { WebSocketServer } = ccvRequire('ws');
  const wss = new WebSocketServer({ noServer: true });
  _shellWss = wss;

  // Spawner the manager invokes for fresh sessions. The manager hooks
  // pty.onData itself (to feed the ring buffer), so we don't.
  _ptyManager = new PtySessionManager({
    spawner: ({ subjectId, ip }) => {
      const shell = process.env.SHELL || '/bin/zsh';
      const cwd = _pendingCwd || homedir();
      _pendingCwd = null;
      const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: { ...process.env, HOME: homedir() },
      });
      jlog('ws-shell-spawn', { pid: proc.pid, cwd, subjectId, ip });
      return proc;
    },
    onOrphanExpire: (s) => {
      jlog('ws-shell-orphan-expired', { subjectId: s.subjectId });
    },
  });

  // The spawner closure has no access to the per-connection cwd, so we
  // smuggle it through this module-local. createOrAttachSession runs the
  // spawner synchronously inside its own call, so a single var is enough as
  // long as we don't re-enter — which we don't because the upgrade handler
  // is the only caller.
  let _pendingCwd = null;

  // Intercept upgrade before ccv's own /ws/terminal handler
  const existingUpgradeListeners = httpServer.listeners('upgrade');
  httpServer.removeAllListeners('upgrade');

  httpServer.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url, 'http://localhost');
    if (parsed.pathname === '/ws/shell') {
      // Auth check for WebSocket: LAN or valid session cookie
      if (!isAuthenticated(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    // delegate to ccv's original upgrade handlers (/ws/terminal etc.)
    for (const fn of existingUpgradeListeners) fn.call(httpServer, req, socket, head);
  });

  wss.on('connection', (ws, req) => {
    const parsed = new URL(req.url, 'http://localhost');
    let cwd = parsed.searchParams.get('cwd') || homedir();
    try { cwd = realpathSync(cwd); } catch { /* keep as-is */ }
    if (!existsSync(cwd)) cwd = homedir();
    const reqSessionId = parsed.searchParams.get('sessionId') || null;
    const subjectId = subjectIdFor(req);
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';

    // Soft pre-check before allocating a manager session. The manager will
    // also reject (throw) at MAX_PTY_TOTAL=10 — we just want a friendly 1013
    // before that, and to honor the operator's CCV_SHELL_PTY_CAP override if
    // they set it lower than 10.
    const stats = _ptyManager._stats();
    if (!reqSessionId && stats.sessions >= SHELL_PTY_CAP) {
      jlog('ws-shell-cap-hit', { cap: SHELL_PTY_CAP, current: stats.sessions, ip });
      try {
        ws.send(JSON.stringify({ type: 'data', data: `\\x1b[31mShell capacity reached (${SHELL_PTY_CAP}). Try again later.\\x1b[0m\\r\\n` }));
      } catch { /* socket may already be gone */ }
      ws.close(1013, 'capacity');
      return;
    }

    // Attempt session attach/create. createOrAttachSession runs the spawner
    // synchronously when a fresh PTY is needed, so set _pendingCwd first.
    let attached = null;
    try {
      _pendingCwd = cwd;
      attached = _ptyManager.createOrAttachSession({ subjectId, ip, ua, sessionId: reqSessionId });
      _pendingCwd = null;
      // If the requested sessionId failed validation (mismatched fingerprint
      // or unknown id), fall back to a fresh session so the user isn't stuck
      // in a loop. PB1's resilient transport on the client side will store
      // the new id.
      if (!attached && reqSessionId) {
        _pendingCwd = cwd;
        attached = _ptyManager.createOrAttachSession({ subjectId, ip, ua });
        _pendingCwd = null;
      }
    } catch (err) {
      jlog('ws-shell-attach-error', { subjectId, ip, sessionId: reqSessionId, err: err.message });
      try {
        ws.send(JSON.stringify({ type: 'data', data: `\\x1b[31m${err.message}\\x1b[0m\\r\\n` }));
      } catch { /* socket may already be gone */ }
      ws.close(1013, err.message);
      return;
    }
    if (!attached) {
      // Should not happen: with reqSessionId=null the manager either returns
      // a session or throws.
      ws.close(1011, 'attach failed');
      return;
    }
    const { sessionId, pty: proc, replayBuffer, isReattach } = attached;

    // Heartbeat: detect half-open connections (e.g. iOS Safari background suspends)
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Tell the client which session this is so they can persist it for
    // reconnect. Always sent first frame so PB1's client can wire it up
    // before any data flows.
    try {
      ws.send(JSON.stringify({ type: 'hello', sessionId, isReattach }));
    } catch { /* socket may already be gone */ }
    ws.send(JSON.stringify({ type: 'state', running: true, cwd }));

    // Replay buffered output so the user sees what they missed during the
    // disconnect. UTF-8 decoding here can in theory split a multi-byte
    // codepoint at the ring buffer boundary, but xterm tolerates that and
    // the very next live chunk will resync.
    if (isReattach && replayBuffer && replayBuffer.length > 0) {
      try {
        ws.send(JSON.stringify({ type: 'data', data: replayBuffer.toString('utf8') }));
      } catch { /* socket may already be gone */ }
    }

    // Wire pty→ws for live data. The manager already feeds pty.onData into
    // the ring buffer; these are independent listeners (node-pty allows
    // multiple subscribers). Capture the disposables so we can detach them
    // on ws close — otherwise each reattach cycle would leak a closure
    // bound to the old (closed) ws on the same PTY.
    const dataDisposable = proc.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data }));
    });
    const exitDisposable = proc.onExit(({ exitCode }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
      // The PTY died on its own — drop the manager entry; nothing to resume.
      _ptyManager._sessions.delete(sessionId);
      ws.close();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && msg.data) proc.write(msg.data);
        else if (msg.type === 'resize' && msg.cols && msg.rows) proc.resize(msg.cols, msg.rows);
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => {
      try { dataDisposable?.dispose?.(); } catch {}
      try { exitDisposable?.dispose?.(); } catch {}
      // Hand the session to the manager: SIGTERM→10s→SIGKILL after the
      // 5min orphan TTL if no peer reattaches. killPty:true is mandatory
      // here — each PTY belongs to exactly one client, no sharing.
      _ptyManager.markOrphan(sessionId, { killPty: true });
    });
  });

  // Server-side heartbeat: ping every 25s, terminate sockets that miss a pong.
  // Idle TCP connections through NAT/proxies (and iOS background suspension)
  // can leave half-open sockets that never fire 'close' — this reaps them so
  // the associated PTY is killed deterministically.
  const HEARTBEAT_INTERVAL_MS = 25_000;
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* already dead */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket gone, next tick will terminate */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeatTimer));

  log('/ws/shell WebSocket endpoint ready (node-pty, heartbeat 25s)');
}

export default {
  name: 'launcher',
  hooks: {
    serverStarted: async (ctx) => {
      if (!HUB_ENABLED) return;
      try {
        _selfPort = ctx?.port ?? null;
        _selfToken = ctx?.token ?? null;
        if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
        rescanRuntime();
        backfillExternalCcvs(true).catch(err => log('initial backfill error:', err.message));
        loadSessions();
        startWatcher();
        if (ctx?.httpServer) {
          installRequestMultiplexer(ctx.httpServer, ctx.protocol);
          await ensurePtySessionManager();
          installShellWebSocket(ctx.httpServer);
        } else {
          log('serverStarted: no httpServer in ctx, launcher routes will not work');
        }
        log(`hub ready on port ${_selfPort}, watching ${RUNTIME_DIR}`);
        log(`open http://127.0.0.1:${_selfPort}/launcher (no token required on hub)`);
      } catch (err) {
        log('serverStarted error:', err.message);
      }
    },
  },
};
