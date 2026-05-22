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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync, unlinkSync, watch, openSync, readSync, closeSync, createReadStream, copyFileSync } from 'node:fs';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
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

// ---- worktree (M2) ----
// pid → { path, branch, baseRef, originalCwd } for instances we spawned in a
// dedicated git worktree. Kept in-memory (volatile across hub restarts); on
// hub start we don't try to reconcile — `git worktree list` + `_pidWorktrees`
// together give us the truth at /api/launcher/worktrees time.
const _pidWorktrees = new Map();

const WORKTREE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]{1,80}$/;

function isInsideDir(child, parent) {
  // resolve both, then verify child === parent OR child starts with parent + sep.
  // Guards against name-prefix attacks like /repo-evil vs /repo.
  const c = resolvePath(child);
  const p = resolvePath(parent);
  if (c === p) return true;
  return c.startsWith(p + '/');
}

function gitInCwd(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: opts.timeout || 8000,
    maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
    input: opts.input,
    stdio: opts.input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
}

function detectBaseRef(cwd) {
  // Prefer the remote's default (origin/HEAD) so worktrees branch off the
  // "canonical" base regardless of whatever the user has checked out. Fall
  // back to HEAD when there's no origin (e.g. /tmp/demo with bare remote
  // but no remote HEAD symref set).
  try {
    const out = execFileSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch { /* no origin/HEAD — fall through */ }
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && out !== 'HEAD') return out;
  } catch { /* not a git repo */ }
  return 'HEAD';
}

function createWorktree(originalCwd, { branchName } = {}) {
  if (!originalCwd || typeof originalCwd !== 'string') throw new Error('cwd required');
  if (!existsSync(originalCwd) || !statSync(originalCwd).isDirectory()) {
    throw new Error('cwd is not a directory');
  }
  try {
    const out = execFileSync('git', ['-C', originalCwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out !== 'true') throw new Error('not a git work tree');
  } catch {
    throw new Error('cwd is not a git repository');
  }

  const baseName = (basename(originalCwd) || 'wt').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'wt';
  const rnd = randomBytes(4).toString('hex');
  const dirName = (baseName + '-' + rnd).slice(0, 40);
  if (!WORKTREE_NAME_RE.test(dirName)) throw new Error('generated worktree name invalid');

  const branch = branchName ? String(branchName) : ('ccv/' + dirName);
  if (!BRANCH_NAME_RE.test(branch)) throw new Error('branch name contains invalid characters');

  const worktreeRoot = join(originalCwd, '.claude', 'worktrees');
  const worktreePath = join(worktreeRoot, dirName);
  // Defense in depth: even though path is built from validated parts,
  // re-resolve and verify it falls inside originalCwd.
  if (!isInsideDir(worktreePath, originalCwd)) {
    throw new Error('worktree path escapes cwd');
  }
  if (existsSync(worktreePath)) throw new Error('worktree path already exists');

  mkdirSync(worktreeRoot, { recursive: true });

  const baseRef = detectBaseRef(originalCwd);
  try {
    execFileSync('git', ['-C', originalCwd, 'worktree', 'add', '-b', branch, worktreePath, baseRef], {
      encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    throw new Error('git worktree add failed: ' + (stderr || err.message));
  }
  return { path: worktreePath, branch, baseRef, originalCwd };
}

function removeWorktree(originalCwd, worktreePath, { force = false } = {}) {
  if (!isInsideDir(worktreePath, originalCwd)) {
    throw new Error('worktree path not inside originalCwd');
  }
  const args = ['-C', originalCwd, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  try {
    execFileSync('git', args, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    throw new Error('git worktree remove failed: ' + (stderr || err.message));
  }
}

function worktreeForPid(pid) {
  return _pidWorktrees.get(pid) || null;
}

// ---- CLAUDE.md scanner + editor (M4) ----
// Scans the ancestor chain of a cwd for CLAUDE.md, plus ~/.claude/CLAUDE.md,
// plus any `@<ref>.md` references inside those files (typically into
// ~/.claude/rules/). Used by the per-card Memory tab.
const MD_FILE_MAX_BYTES = 256 * 1024;
const MD_PREVIEW_BYTES = 200;
const MD_BACKUP_KEEP = 5;
const HOME_CLAUDE_DIR = join(homedir(), '.claude');

function isAllowedMdPath(absPath) {
  // resolvePath instead of realpath so we work for files that don't exist
  // yet (first-time save into a new CLAUDE.md). Caller is responsible for
  // passing an absolute path.
  const resolved = resolvePath(absPath);
  if (!resolved.endsWith('.md')) return false;
  // Allowed root 1: anywhere under ~/.claude (CLAUDE.md, rules/*.md, etc.)
  if (isInsideDir(resolved, HOME_CLAUDE_DIR)) return true;
  // Allowed roots 2 & 3: for any known instance cwd —
  //   (a) a file named CLAUDE.md anywhere on the cwd's ancestor chain
  //   (b) any .md file under cwd/.claude/ (skills, memory, etc.)
  const base = basename(resolved);
  const dir = dirname(resolved);
  for (const inst of instances.values()) {
    const cwd = inst && inst.cwd;
    if (!cwd) continue;
    if (base === 'CLAUDE.md' && isInsideDir(cwd, dir)) return true;
    const dotClaude = join(cwd, '.claude');
    if (isInsideDir(resolved, dotClaude)) return true;
  }
  return false;
}

function safeReadPreview(absPath) {
  try {
    // Read up to MD_PREVIEW_BYTES to avoid slurping multi-MB files for the
    // scanner list view (full content goes through /api/launcher/file).
    const fd = openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(MD_PREVIEW_BYTES);
      const n = readSync(fd, buf, 0, MD_PREVIEW_BYTES, 0);
      return buf.slice(0, n).toString('utf-8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

function pushMdFile(out, seen, absPath, scope) {
  let real = absPath;
  try { real = realpathSync(absPath); } catch { /* keep raw */ }
  if (seen.has(real)) return;
  seen.add(real);
  try {
    const st = statSync(real);
    if (!st.isFile()) return;
    out.push({
      path: real,
      scope,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      preview: safeReadPreview(real),
    });
  } catch { /* unreadable — skip silently */ }
}

function scanClaudeMd(cwd) {
  const out = [];
  const seen = new Set();
  if (!cwd || typeof cwd !== 'string') return out;
  // 1. Walk cwd → ancestors for CLAUDE.md. The match in cwd itself is
  //    scope='project', further up is 'parent'. Stop at filesystem root.
  let dir = cwd;
  let lastDir = '';
  let isFirst = true;
  while (dir && dir !== lastDir) {
    const p = join(dir, 'CLAUDE.md');
    if (existsSync(p)) pushMdFile(out, seen, p, isFirst ? 'project' : 'parent');
    isFirst = false;
    lastDir = dir;
    dir = dirname(dir);
  }
  // 2. Global ~/.claude/CLAUDE.md (always; scope distinct from rules).
  const global = join(HOME_CLAUDE_DIR, 'CLAUDE.md');
  if (existsSync(global)) pushMdFile(out, seen, global, 'global');
  // 3. @-references inside every CLAUDE.md found so far. Matches `@~/...md`,
  //    `@/abs/...md`, and `@relative/...md`. Anything ending in `.md`.
  //    Resolves ~/ to homedir, relative to dirname(file).
  for (const file of [...out]) {
    let buf = '';
    try { buf = readFileSync(file.path, 'utf-8'); } catch { continue; }
    const refRe = /@(~?[/\w][^\s)`]*\.md)/g;
    let m;
    while ((m = refRe.exec(buf)) !== null) {
      let ref = m[1];
      if (ref.startsWith('~/')) ref = join(homedir(), ref.slice(2));
      else if (!ref.startsWith('/')) ref = resolvePath(dirname(file.path), ref);
      if (existsSync(ref)) pushMdFile(out, seen, ref, 'rule');
    }
  }
  return out;
}

function backupMdBeforeWrite(absPath) {
  // No-op when the file doesn't exist yet (first-time create). Else snapshot
  // to <path>.bak.<ISO-ts> and keep the latest MD_BACKUP_KEEP siblings.
  if (!existsSync(absPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = absPath + '.bak.' + ts;
  copyFileSync(absPath, backupPath);
  try {
    const dir = dirname(absPath);
    const base = basename(absPath);
    const prefix = base + '.bak.';
    const entries = readdirSync(dir)
      .filter(e => e.startsWith(prefix))
      .map(e => {
        try { return { name: e, mtime: statSync(join(dir, e)).mtimeMs }; }
        catch { return { name: e, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(MD_BACKUP_KEEP)) {
      try { unlinkSync(join(dir, e.name)); } catch { /* ignore */ }
    }
  } catch { /* dir read failure shouldn't fail the write */ }
  return backupPath;
}

async function doSpawn(targetCwd, { force = false, ccuseProfile = '', useWorktree = false, branchName = '' } = {}) {
  if (!targetCwd || typeof targetCwd !== 'string') throw new Error('cwd required');
  // useWorktree: create a dedicated git worktree under
  // <targetCwd>/.claude/worktrees/<auto-name>/ on a new branch, then spawn the
  // child rooted in the worktree path so its writes don't collide with other
  // ccvs running on the same repo. The original cwd stays clean.
  let wtInfo = null;
  if (useWorktree) {
    wtInfo = createWorktree(targetCwd, { branchName });
    targetCwd = wtInfo.path;
  }
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
    if (wtInfo && entry && entry.pid) {
      _pidWorktrees.set(entry.pid, wtInfo);
    }
    return entry;
  } catch (err) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
    // Spawn failed after worktree creation: leave the worktree on disk so the
    // user can inspect what went wrong. Cleanup endpoint can reap it later.
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

// ---------- ccusage-style usage / cost reducer ----------
// Reads Claude Code's native session jsonl files at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Each `assistant`-typed
// entry carries `message.usage` (input_tokens / output_tokens /
// cache_creation_input_tokens / cache_read_input_tokens) and we dedup by
// (sessionId, message.id, requestId) because a single turn is rewritten on
// resume. Pricing comes from vendor/pricing.json (USD per 1M tokens, with
// optional above_200k tier for the Sonnet 4 1M-context model).

const PLUGIN_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));
const PRICING_PATH = join(PLUGIN_DIR, '..', 'vendor', 'pricing.json');
const MODELS_PATH = join(PLUGIN_DIR, '..', 'vendor', 'models.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const USAGE_CACHE_FILE = join(homedir(), '.claude', 'cc-viewer', 'launcher-cache.json');
const USAGE_CACHE_TTL_MS = 60_000;

let _pricingCache = null;
let _modelsCache = null;

function loadPricing() {
  if (_pricingCache) return _pricingCache;
  try {
    const raw = JSON.parse(readFileSync(PRICING_PATH, 'utf-8'));
    delete raw._meta;
    _pricingCache = raw;
  } catch (err) {
    log('loadPricing error:', err.message);
    _pricingCache = {};
  }
  return _pricingCache;
}

function loadModels() {
  if (_modelsCache) return _modelsCache;
  try {
    _modelsCache = JSON.parse(readFileSync(MODELS_PATH, 'utf-8'));
  } catch (err) {
    log('loadModels error:', err.message);
    _modelsCache = { models: {}, fallback: { context_limit: 200000 } };
  }
  return _modelsCache;
}

// vendor/models.json lookup honoring [1m] modifier and family fallback. Used
// by the context-% reducer (T4) and exposed verbatim on contextUsage payloads
// so UI doesn't re-implement the lookup.
function getModelInfo(modelId) {
  const data = loadModels();
  const models = data.models || {};
  const fallbackLimit = (data.fallback && data.fallback.context_limit) || 200000;
  if (!modelId || typeof modelId !== 'string') {
    return { model_id: modelId || 'unknown', display_name: 'unknown', context_limit: fallbackLimit };
  }
  let baseId = modelId;
  let appliedModifier = null;
  for (const mod of (data.context_modifiers || [])) {
    if (mod.pattern && modelId.includes(mod.pattern)) {
      baseId = modelId.replace(mod.pattern, '');
      appliedModifier = mod;
      break;
    }
  }
  let entry = models[baseId];
  if (!entry) {
    // Family fallback — same heuristics as priceForModel; keeps lookup
    // resilient when a brand-new model id appears before vendor/models.json
    // is refreshed.
    if (baseId.includes('opus-4-7')) entry = models['claude-opus-4-7'];
    else if (baseId.includes('opus-4-6')) entry = models['claude-opus-4-6'];
    else if (baseId.includes('opus-4-5')) entry = models['claude-opus-4-5'];
    else if (baseId.includes('opus-4-1')) entry = models['claude-opus-4-1'];
    else if (baseId.includes('opus')) entry = models['claude-opus-4-7'];
    else if (baseId.includes('sonnet-4-7')) entry = models['claude-sonnet-4-7'];
    else if (baseId.includes('sonnet-4-6')) entry = models['claude-sonnet-4-6'];
    else if (baseId.includes('sonnet-4-5')) entry = models['claude-sonnet-4-5'];
    else if (baseId.includes('sonnet-4')) entry = models['claude-sonnet-4-20250514'];
    else if (baseId.includes('haiku')) entry = models['claude-haiku-4-5'];
  }
  let context_limit = (entry && entry.context_limit) || fallbackLimit;
  let display_name = (entry && entry.display_name) || baseId;
  if (appliedModifier) {
    if (appliedModifier.context_limit) context_limit = appliedModifier.context_limit;
    if (appliedModifier.display_suffix) display_name += appliedModifier.display_suffix;
  }
  return { model_id: modelId, display_name, context_limit };
}

// Context-window utilization from a per-entry usage snapshot. "Used" = prompt
// size (input + cache_creation + cache_read) only; output is the response, not
// part of what consumes the context window. Mirrors ccusage's UsageStats and
// ClaudeBar's UsageSnapshot semantics.
function computeContextUsage(lastEntry) {
  if (!lastEntry || !lastEntry.model) return null;
  const used = (+lastEntry.input || 0)
             + (+lastEntry.cache_creation || 0)
             + (+lastEntry.cache_read || 0);
  const info = getModelInfo(lastEntry.model);
  const limit = info.context_limit || 200000;
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return {
    used,
    limit,
    percent: Math.round(percent * 10) / 10,
    model: lastEntry.model,
    displayName: info.display_name,
    ts: lastEntry.ts || null,
  };
}

function priceForModel(modelId) {
  const pricing = loadPricing();
  if (modelId && pricing[modelId]) return pricing[modelId];
  if (typeof modelId === 'string') {
    if (modelId.includes('opus-4-7')) return pricing['claude-opus-4-7'];
    if (modelId.includes('opus-4-6')) return pricing['claude-opus-4-6'];
    if (modelId.includes('opus-4-5')) return pricing['claude-opus-4-5'];
    if (modelId.includes('opus-4-1')) return pricing['claude-opus-4-1'];
    if (modelId.includes('opus')) return pricing['claude-opus-4-7'];
    if (modelId.includes('sonnet-4-7')) return pricing['claude-sonnet-4-7'];
    if (modelId.includes('sonnet-4-6')) return pricing['claude-sonnet-4-6'];
    if (modelId.includes('sonnet-4-5')) return pricing['claude-sonnet-4-5'];
    if (modelId.includes('sonnet-4')) return pricing['claude-sonnet-4-20250514'];
    if (modelId.includes('haiku')) return pricing['claude-haiku-4-5'];
  }
  return null;
}

function emptyTokenBucket() { return { input: 0, output: 0, cache_creation: 0, cache_read: 0 }; }

// LiteLLM tier semantics: when a request's prompt size > 200k, the entire
// request bills at the model's above_200k rates (input_above_200k etc.). We
// compute cost per-entry so the tier is preserved; the aggregator sums dollars
// across entries.
function computeCostForEntry(model, usage) {
  const p = priceForModel(model);
  if (!p) return 0;
  const inp = +usage.input_tokens || 0;
  const out = +usage.output_tokens || 0;
  const cw = +usage.cache_creation_input_tokens || 0;
  const cr = +usage.cache_read_input_tokens || 0;
  const promptSize = inp + cw + cr;
  const tier = (promptSize > 200000 && p.input_above_200k != null)
    ? {
        input: p.input_above_200k,
        output: p.output_above_200k != null ? p.output_above_200k : p.output,
        cache_creation: p.cache_creation_above_200k != null ? p.cache_creation_above_200k : p.cache_creation,
        cache_read: p.cache_read_above_200k != null ? p.cache_read_above_200k : p.cache_read,
      }
    : { input: p.input, output: p.output, cache_creation: p.cache_creation, cache_read: p.cache_read };
  return (inp * tier.input + out * tier.output + cw * tier.cache_creation + cr * tier.cache_read) / 1e6;
}

// Untiered fallback for already-aggregated buckets — use only when per-request
// prompt size has been lost. The real reducers compute cost per-entry above.
function costFromUsage(byModel) {
  const byModelUSD = {};
  let total = 0;
  for (const [m, u] of Object.entries(byModel)) {
    const p = priceForModel(m);
    if (!p) { byModelUSD[m] = 0; continue; }
    const c = (u.input * p.input + u.output * p.output
              + u.cache_creation * p.cache_creation + u.cache_read * p.cache_read) / 1e6;
    byModelUSD[m] = c; total += c;
  }
  return { total, byModel: byModelUSD };
}

// In-memory reducer for already-decoded entries. Used when we already have a
// jsonl tail in hand (avoids re-streaming). Caller passes a Set for dedup
// scope (same Set across calls = global dedup).
function usageFromEntries(entries, dedupSet) {
  const byModel = {};
  let totalUSD = 0;
  let requestCount = 0;
  let lastEntry = null;
  for (const e of entries || []) {
    if (!e || e.type !== 'assistant') continue;
    const msg = e.message;
    const u = msg && msg.usage;
    if (!u) continue;
    const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
    if (dedupSet) {
      if (dedupSet.has(key)) continue;
      dedupSet.add(key);
    }
    const model = (msg && msg.model) || 'unknown';
    const b = byModel[model] || (byModel[model] = emptyTokenBucket());
    b.input += +u.input_tokens || 0;
    b.output += +u.output_tokens || 0;
    b.cache_creation += +u.cache_creation_input_tokens || 0;
    b.cache_read += +u.cache_read_input_tokens || 0;
    totalUSD += computeCostForEntry(model, u);
    requestCount++;
    lastEntry = {
      model,
      input: +u.input_tokens || 0,
      output: +u.output_tokens || 0,
      cache_creation: +u.cache_creation_input_tokens || 0,
      cache_read: +u.cache_read_input_tokens || 0,
      ts: e.timestamp || null,
    };
  }
  return { byModel, costUSD: totalUSD, requestCount, lastEntry };
}

async function readJsonlEntries(path, onEntry) {
  // Stream a jsonl line-by-line so we can scale to 100s-of-MB session logs
  // without materializing the whole file.
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    onEntry(obj);
  }
}

function rangeStartMs(range) {
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === 'month') {
    const d = new Date(now); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return 0;
}

function listSessionJsonlPaths() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out = [];
  let projDirs;
  try { projDirs = readdirSync(PROJECTS_DIR); } catch { return []; }
  for (const proj of projDirs) {
    const projDir = join(PROJECTS_DIR, proj);
    let st; try { st = statSync(projDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files; try { files = readdirSync(projDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      out.push(join(projDir, f));
    }
  }
  return out;
}

async function aggregateUsage({ range = 'today', cwd: cwdFilter = '' } = {}) {
  const startMs = rangeStartMs(range);
  const paths = listSessionJsonlPaths();
  const byModel = {};
  const byModelUSD = {};
  let totalUSD = 0;
  let requestCount = 0;
  const dedup = new Set();
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { continue; }
    // mtime predates the range → file can't contain in-range turns.
    if (st.mtimeMs < startMs) continue;
    await readJsonlEntries(p, (e) => {
      if (!e || e.type !== 'assistant') return;
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (ts && ts < startMs) return;
      if (cwdFilter && e.cwd !== cwdFilter) return;
      const msg = e.message;
      const u = msg && msg.usage;
      if (!u) return;
      const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
      if (dedup.has(key)) return;
      dedup.add(key);
      const model = (msg && msg.model) || 'unknown';
      const b = byModel[model] || (byModel[model] = emptyTokenBucket());
      b.input += +u.input_tokens || 0;
      b.output += +u.output_tokens || 0;
      b.cache_creation += +u.cache_creation_input_tokens || 0;
      b.cache_read += +u.cache_read_input_tokens || 0;
      const cost = computeCostForEntry(model, u);
      byModelUSD[model] = (byModelUSD[model] || 0) + cost;
      totalUSD += cost;
      requestCount++;
    });
  }
  return { totalUSD, byModel, byModelUSD, requestCount, range, cwd: cwdFilter, computedAt: Date.now() };
}

// ---- summary cache (60s TTL, stale-while-revalidate, persisted to disk) ----
let _usageMem = null;
const _usageRefreshing = new Set();

function loadUsageCacheFromDisk() {
  if (_usageMem) return _usageMem;
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8'));
      _usageMem = raw && raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
    } else _usageMem = {};
  } catch { _usageMem = {}; }
  return _usageMem;
}

function saveUsageCacheToDisk() {
  try {
    const dir = dirname(USAGE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let cur = {};
    if (existsSync(USAGE_CACHE_FILE)) {
      try { cur = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8')) || {}; } catch { cur = {}; }
    }
    cur.usage = _usageMem;
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cur, null, 2));
  } catch (err) { log('saveUsageCacheToDisk error:', err.message); }
}

function refreshUsageInBackground(key, params) {
  if (_usageRefreshing.has(key)) return;
  _usageRefreshing.add(key);
  aggregateUsage(params)
    .then((result) => {
      const mem = loadUsageCacheFromDisk();
      mem[key] = result;
      saveUsageCacheToDisk();
    })
    .catch((err) => log('aggregateUsage refresh error:', err.message))
    .finally(() => _usageRefreshing.delete(key));
}

async function getCachedUsage(params) {
  const key = `${params.range}#${params.cwd || ''}`;
  const mem = loadUsageCacheFromDisk();
  const hit = mem[key];
  const now = Date.now();
  if (hit && now - hit.computedAt < USAGE_CACHE_TTL_MS) {
    return { ...hit, fromCache: true, stale: false };
  }
  if (hit) {
    refreshUsageInBackground(key, params);
    return { ...hit, fromCache: true, stale: true };
  }
  // Cold miss. The synchronous fallback used to await aggregateUsage(),
  // which on a heavy "month" range scans ~30 days of native jsonls and
  // can take >5s — long enough that the UI's 10s polling-with-timeout
  // would error out. Instead: kick the scan as a background refresh and
  // return a pending placeholder with computedAt=0 so UI can render a
  // "..." spinner. The next poll picks up the real result from cache.
  // Claude Code's native session jsonls are named <sessionId>.jsonl
  // (UUID), so filename-date pre-filtering doesn't apply here — mtime
  // already filters at the file level and the per-line ts < startMs skip
  // is already in place. Cold-scan cost is dominated by JSON.parse on
  // in-range files; this placeholder shields the wire from that latency.
  refreshUsageInBackground(key, params);
  return {
    totalUSD: 0,
    byModel: {},
    byModelUSD: {},
    requestCount: 0,
    range: params.range,
    cwd: params.cwd || '',
    computedAt: 0,
    fromCache: false,
    stale: true,
    pending: true,
  };
}

// ---- per-instance session reducer ----
// Cache key = jsonl path; invalidated whenever (mtime, size) changes. Native
// session jsonls grow append-only, so a same-mtime/same-size hit means
// "nothing new since last scan".
const _instanceUsageCache = new Map();

async function readInstanceUsage(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return null;
  let st; try { st = statSync(jsonlPath); } catch { return null; }
  const cached = _instanceUsageCache.get(jsonlPath);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
  const byModel = {};
  let totalUSD = 0;
  let requestCount = 0;
  const dedup = new Set();
  let lastEntry = null;
  await readJsonlEntries(jsonlPath, (e) => {
    if (!e || e.type !== 'assistant') return;
    const msg = e.message;
    const u = msg && msg.usage;
    if (!u) return;
    const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
    if (dedup.has(key)) return;
    dedup.add(key);
    const model = (msg && msg.model) || 'unknown';
    const b = byModel[model] || (byModel[model] = emptyTokenBucket());
    b.input += +u.input_tokens || 0;
    b.output += +u.output_tokens || 0;
    b.cache_creation += +u.cache_creation_input_tokens || 0;
    b.cache_read += +u.cache_read_input_tokens || 0;
    totalUSD += computeCostForEntry(model, u);
    requestCount++;
    lastEntry = {
      model,
      input: +u.input_tokens || 0,
      output: +u.output_tokens || 0,
      cache_creation: +u.cache_creation_input_tokens || 0,
      cache_read: +u.cache_read_input_tokens || 0,
      ts: e.timestamp || null,
    };
  });
  const totals = emptyTokenBucket();
  for (const u of Object.values(byModel)) {
    totals.input += u.input;
    totals.output += u.output;
    totals.cache_creation += u.cache_creation;
    totals.cache_read += u.cache_read;
  }
  const result = {
    mtime: st.mtimeMs, size: st.size,
    totals, byModel, costUSD: totalUSD, requestCount, lastEntry,
  };
  _instanceUsageCache.set(jsonlPath, result);
  return result;
}

function encodeCwdToProjectDir(cwd) {
  // Inverse of decodeProjectDirName: Claude Code flattens "/" → "-".
  return cwd.replace(/\//g, '-');
}

// Map an instance to its native Claude Code session jsonl. External claude
// processes carry the resolved path on the instance (parsed from `ps`); for
// ccv-managed instances we fall back to the most recently-touched jsonl in
// the encoded-cwd project dir.
function resolveNativeJsonl(instance) {
  if (!instance) return null;
  if (instance.jsonlPath && existsSync(instance.jsonlPath)) return instance.jsonlPath;
  if (!instance.cwd) return null;
  const dir = join(PROJECTS_DIR, encodeCwdToProjectDir(instance.cwd));
  if (!existsSync(dir)) return null;
  let files; try { files = readdirSync(dir); } catch { return null; }
  let best = null;
  let bestM = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(dir, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = p; }
  }
  return best;
}

// ---------- end usage / cost reducer ----------

// ---------- 5h quota window (tiered) ----------
// Tier 1: ccline cache (~/.claude/ccline/.api_usage_cache.json) — utilization
//   only, refreshed every 5 min by the ccline statusline binary.
// Tier 2: direct call to /api/oauth/usage — needs an oauth-2025-04-20-scoped
//   access_token. ClaudeBar-style keychain integration is out of scope for
//   v1; we attempt only when ~/.claude/.credentials.json exists with an
//   access_token in cleartext. Otherwise we skip to tier 3.
// Tier 3: jsonl_compute — local 5h block reducer (ccusage `blocks` algorithm,
//   gap-detected, with auto-detected plan and P90 burn rate).
// All tiers cached 30s in memory + 5min on disk (launcher-cache.json).
const CCLINE_CACHE_FILE = join(homedir(), '.claude', 'ccline', '.api_usage_cache.json');
const CLAUDE_CREDS_FILE = join(homedir(), '.claude', '.credentials.json');
const QUOTA_5H_MEM_TTL_MS = 30_000;
const QUOTA_5H_DISK_TTL_MS = 5 * 60_000;
const PLAN_THRESHOLDS = [
  { name: 'Pro', limit: 19000 },
  { name: 'Max5', limit: 88000 },
  { name: 'Max20', limit: 220000 },
];

let _quota5hMem = null;
let _quota5hRefreshing = false;

function readCclineCache() {
  if (!existsSync(CCLINE_CACHE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CCLINE_CACHE_FILE, 'utf-8'));
    const cachedAt = raw.cached_at ? Date.parse(raw.cached_at) : 0;
    const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
    return {
      five_hour_utilization: typeof raw.five_hour_utilization === 'number' ? raw.five_hour_utilization : null,
      seven_day_utilization: typeof raw.seven_day_utilization === 'number' ? raw.seven_day_utilization : null,
      // Note: ccline cache's `resets_at` is the *seven-day* reset, not 5h —
      // we surface it but tag it accordingly so UI doesn't render it as the
      // 5h countdown. ClaudeBar itself doesn't trust this field for 5h.
      seven_day_resets_at: raw.resets_at || null,
      cached_at: raw.cached_at || null,
      ageMs,
      stale: ageMs > 5 * 60_000,
    };
  } catch (err) {
    log('readCclineCache error:', err.message);
    return null;
  }
}

// Tier-2 token retrieval: best-effort cleartext credentials.json. macOS
// keychain access via `security` would block on user approval and isn't
// suitable for an unattended hub. Returns null when unavailable.
function readClaudeOauthToken() {
  if (!existsSync(CLAUDE_CREDS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_CREDS_FILE, 'utf-8'));
    const t = raw && raw.claudeAiOauth && raw.claudeAiOauth.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}

async function fetchOauthUsage() {
  const token = readClaudeOauthToken();
  if (!token) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ccv-launcher',
      },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) {
      log('fetchOauthUsage non-ok:', r.status);
      return null;
    }
    return await r.json();
  } catch (err) {
    log('fetchOauthUsage error:', err.message);
    return null;
  }
}

// 5h block algorithm (ccusage-style):
//   1. Sort assistant turns by timestamp.
//   2. Block start = first turn floored to the hour. Block end = start + 5h.
//   3. New block when the next turn is past the current block's end OR has
//      a gap > 5h from the previous turn (idle break).
//   4. Active block = block that contains "now".
function blocksFromTurns(turns) {
  const sorted = turns.slice().sort((a, b) => a.ts - b.ts);
  const FIVE_H = 5 * 3600 * 1000;
  const blocks = [];
  let cur = null;
  let prevTs = 0;
  for (const t of sorted) {
    if (!cur) {
      const start = new Date(t.ts);
      start.setMinutes(0, 0, 0);
      cur = {
        start: start.getTime(),
        end: start.getTime() + FIVE_H,
        firstTs: t.ts,
        lastTs: t.ts,
        tokens: 0,
        turns: 0,
        models: new Set(),
      };
      blocks.push(cur);
    } else if (t.ts >= cur.end || t.ts - prevTs > FIVE_H) {
      const start = new Date(t.ts);
      start.setMinutes(0, 0, 0);
      cur = {
        start: start.getTime(),
        end: start.getTime() + FIVE_H,
        firstTs: t.ts,
        lastTs: t.ts,
        tokens: 0,
        turns: 0,
        models: new Set(),
      };
      blocks.push(cur);
    }
    cur.tokens += t.tokens;
    cur.turns += 1;
    cur.lastTs = t.ts;
    if (t.model) cur.models.add(t.model);
    prevTs = t.ts;
  }
  return blocks.map(b => ({ ...b, models: Array.from(b.models) }));
}

function detectPlan(blocks) {
  let maxBlockTokens = 0;
  for (const b of blocks) if (b.tokens > maxBlockTokens) maxBlockTokens = b.tokens;
  for (const tier of PLAN_THRESHOLDS) {
    if (maxBlockTokens <= tier.limit) return { plan_name: tier.name, limit: tier.limit, max_observed: maxBlockTokens };
  }
  // Above all known thresholds — bucket as Max20 (the highest plan).
  return { plan_name: 'Max20', limit: PLAN_THRESHOLDS[PLAN_THRESHOLDS.length - 1].limit, max_observed: maxBlockTokens };
}

function p90(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
  return sorted[idx];
}

async function gatherTurnsForBlocks(now) {
  // 192h window — matches Maciek-roboblog's burn-rate horizon.
  const horizon = now - 192 * 3600 * 1000;
  const paths = listSessionJsonlPaths();
  const turns = [];
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < horizon) continue;
    await readJsonlEntries(p, (e) => {
      if (!e || e.type !== 'assistant') return;
      const msg = e.message; const u = msg && msg.usage;
      if (!u) return;
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (!ts || ts < horizon) return;
      const tokens = (+u.input_tokens || 0)
                   + (+u.output_tokens || 0)
                   + (+u.cache_creation_input_tokens || 0)
                   + (+u.cache_read_input_tokens || 0);
      turns.push({ ts, tokens, model: msg.model || null });
    });
  }
  return turns;
}

async function computeFiveHourBlock() {
  const now = Date.now();
  const turns = await gatherTurnsForBlocks(now);
  const blocks = blocksFromTurns(turns);
  const active = blocks.find(b => now >= b.start && now < b.end);
  const plan = detectPlan(blocks);

  // P90 burn rate (tokens/min) over completed blocks within the horizon.
  const completed = blocks.filter(b => b.end <= now && b.turns >= 2);
  const rates = completed.map(b => {
    const durMin = Math.max(1, (b.lastTs - b.firstTs) / 60000);
    return b.tokens / durMin;
  });
  const burnRate = p90(rates); // tokens/min

  const used = active ? active.tokens : 0;
  const remaining = Math.max(0, plan.limit - used);
  const projection_minutes = burnRate > 0 ? Math.round(remaining / burnRate) : null;
  const reset_at = active ? new Date(active.end).toISOString() : null;
  const percent = plan.limit > 0 ? Math.min(100, (used / plan.limit) * 100) : 0;

  return {
    source: 'jsonl_compute',
    used,
    limit: plan.limit,
    percent: Math.round(percent * 10) / 10,
    reset_at,
    plan_name: plan.plan_name,
    plan_max_observed: plan.max_observed,
    burn_rate: Math.round(burnRate * 100) / 100,
    projection_minutes,
    block_start: active ? new Date(active.start).toISOString() : null,
    block_end: active ? new Date(active.end).toISOString() : null,
    block_turns: active ? active.turns : 0,
    block_models: active ? active.models : [],
    computedAt: now,
  };
}

function loadQuota5hFromDisk() {
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8'));
      return raw && raw.quota5h ? raw.quota5h : null;
    }
  } catch { /* ignore */ }
  return null;
}

function saveQuota5hToDisk(result) {
  try {
    const dir = dirname(USAGE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let cur = {};
    if (existsSync(USAGE_CACHE_FILE)) {
      try { cur = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8')) || {}; } catch { cur = {}; }
    }
    cur.quota5h = result;
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cur, null, 2));
  } catch (err) { log('saveQuota5hToDisk error:', err.message); }
}

async function buildQuota5h() {
  // Tier 1: ccline cache (utilization only, no raw token counts).
  const ccline = readCclineCache();
  if (ccline && !ccline.stale && ccline.five_hour_utilization != null) {
    return {
      source: 'ccline_cache',
      percent: ccline.five_hour_utilization,
      used: null,
      limit: null,
      reset_at: null, // ccline only carries 7-day reset; 5h reset unknown
      plan_name: null,
      burn_rate: null,
      projection_minutes: null,
      cached_at: ccline.cached_at,
      seven_day_utilization: ccline.seven_day_utilization,
      seven_day_resets_at: ccline.seven_day_resets_at,
      computedAt: Date.now(),
    };
  }

  // Tier 2: direct OAuth API. Best-effort — skipped silently when no token
  // is reachable on disk (most users keep it in keychain).
  const oauth = await fetchOauthUsage();
  if (oauth && oauth.five_hour && typeof oauth.five_hour.utilization === 'number') {
    return {
      source: 'api_oauth',
      percent: oauth.five_hour.utilization,
      used: null,
      limit: null,
      reset_at: oauth.five_hour.resets_at || null,
      plan_name: null,
      burn_rate: null,
      projection_minutes: null,
      seven_day_utilization: oauth.seven_day && oauth.seven_day.utilization,
      seven_day_resets_at: oauth.seven_day && oauth.seven_day.resets_at,
      extra_usage: oauth.extra_usage || null,
      computedAt: Date.now(),
    };
  }

  // Tier 3: local jsonl compute.
  try {
    return await computeFiveHourBlock();
  } catch (err) {
    log('computeFiveHourBlock error:', err.message);
  }

  // Tier 4: nothing worked.
  return {
    source: 'unavailable',
    percent: null,
    used: null,
    limit: null,
    reset_at: null,
    plan_name: null,
    burn_rate: null,
    projection_minutes: null,
    reason: 'no quota source reachable (ccline cache absent + no oauth token + jsonl compute failed)',
    computedAt: Date.now(),
  };
}

function refreshQuota5hInBackground() {
  if (_quota5hRefreshing) return;
  _quota5hRefreshing = true;
  buildQuota5h()
    .then((result) => {
      _quota5hMem = { ...result, fromCache: false, stale: false };
      saveQuota5hToDisk(_quota5hMem);
    })
    .catch((err) => log('quota5h refresh error:', err.message))
    .finally(() => { _quota5hRefreshing = false; });
}

async function getCachedQuota5h() {
  const now = Date.now();
  if (_quota5hMem && now - _quota5hMem.computedAt < QUOTA_5H_MEM_TTL_MS) {
    return { ..._quota5hMem, fromCache: true, stale: false };
  }
  // Memory miss — try disk for an instant response, then refresh.
  if (!_quota5hMem) {
    const disk = loadQuota5hFromDisk();
    if (disk && now - disk.computedAt < QUOTA_5H_DISK_TTL_MS) {
      _quota5hMem = disk;
      refreshQuota5hInBackground();
      return { ...disk, fromCache: true, stale: now - disk.computedAt > QUOTA_5H_MEM_TTL_MS };
    }
  } else {
    // Memory present but past mem TTL — serve stale and refresh.
    refreshQuota5hInBackground();
    return { ..._quota5hMem, fromCache: true, stale: true };
  }
  // Cold miss: build synchronously.
  const result = await buildQuota5h();
  _quota5hMem = { ...result, fromCache: false, stale: false };
  saveQuota5hToDisk(_quota5hMem);
  return _quota5hMem;
}

// ---------- end 5h quota window ----------

// ---------- compact threshold + run summary (T9) ----------
// 1) Auto-compact / auto-clear threshold: getInstanceActivity calls
//    checkCompactThresholds(instance, contextUsage) after computing
//    contextUsage. When prefs.compactThresholds[cwd] is enabled and the
//    current prompt-size crosses auto_compact_at / auto_clear_at we try to
//    inject the corresponding slash command. ccv currently has no
//    stdin/inject channel (audited the full /api/* surface — no
//    /api/inject-prompt, no /api/stream-chunk write side, no WebSocket
//    that takes user input), so injectPromptToCcv is intentionally a noop
//    that returns {ok:false, reason:'no_inject_channel'} + jlogs the skip.
//    The compactStatus payload field lets ui-dev's T11 surface a "context
//    > threshold; please run /compact manually" hint on the affected card.
// 2) Run Summary: streams the native session jsonl with a 1-based line
//    counter and extracts notable events (prompts, slash commands,
//    tool errors, hook events, sub-agent spawns, auto-compact markers).
//    Cached per jsonlPath keyed on (mtime, size) — re-read is free when
//    the file hasn't grown — with a 5s in-memory floor.
const COMPACT_COOLDOWN_MS = 5 * 60 * 1000;
const _thresholdCooldown = new Map(); // pid -> lastTriggerAt
const _compactStatusByPid = new Map(); // pid -> compactStatus payload

async function injectPromptToCcv(instance, prompt) {
  // Future: probe ccv for a stdin or WebSocket inject channel and use it
  // when available. As of cc-viewer at /Users/dayuer/.nvm/.../cc-viewer/
  // server/server.js, no such route exists — ccv is a passive jsonl
  // observer. Returning a structured "skipped" result lets callers jlog
  // the attempt and lets UI surface a manual-action hint without the
  // launcher silently doing nothing.
  return { ok: false, reason: 'no_inject_channel' };
}

function checkCompactThresholds(instance, contextUsage) {
  const pid = instance && instance.pid;
  if (!pid || !instance || !instance.cwd) return null;
  const threshold = getCompactThreshold(instance.cwd);
  const status = {
    enabled: !!threshold.enabled,
    auto_compact_at: threshold.auto_compact_at || 0,
    auto_clear_at: threshold.auto_clear_at || 0,
    lastTriggeredAt: null,
    lastResult: null,
    reason: null,
    cooldownUntil: null,
  };
  const prev = _compactStatusByPid.get(pid);
  if (prev) {
    status.lastTriggeredAt = prev.lastTriggeredAt;
    status.lastResult = prev.lastResult;
    status.reason = prev.reason;
  }
  if (!status.enabled) { _compactStatusByPid.set(pid, status); return status; }
  if (!contextUsage || typeof contextUsage.used !== 'number') {
    _compactStatusByPid.set(pid, status);
    return status;
  }
  const now = Date.now();
  const last = _thresholdCooldown.get(pid) || 0;
  if (now - last < COMPACT_COOLDOWN_MS) {
    status.cooldownUntil = last + COMPACT_COOLDOWN_MS;
    _compactStatusByPid.set(pid, status);
    return status;
  }
  // Clear takes priority over compact when both are configured and tripped.
  let action = null;
  if (status.auto_clear_at > 0 && contextUsage.used >= status.auto_clear_at) {
    action = { prompt: '/clear', kind: 'clear' };
  } else if (status.auto_compact_at > 0 && contextUsage.used >= status.auto_compact_at) {
    action = { prompt: '/compact', kind: 'compact' };
  }
  if (!action) { _compactStatusByPid.set(pid, status); return status; }
  // Fire-and-forget — we don't want a slow inject to block activity polls.
  // The noop returns synchronously today; keeping the promise shape future-
  // proofs the call site when a real inject channel lands.
  Promise.resolve(injectPromptToCcv(instance, action.prompt))
    .then((res) => {
      const ok = !!(res && res.ok);
      const newStatus = {
        ..._compactStatusByPid.get(pid) || status,
        lastTriggeredAt: now,
        lastResult: ok ? 'ok' : 'skipped',
        reason: ok ? null : (res && res.reason) || 'unknown',
        cooldownUntil: now + COMPACT_COOLDOWN_MS,
      };
      _compactStatusByPid.set(pid, newStatus);
      jlog(ok ? 'auto_compact_triggered' : 'auto_compact_skipped', {
        pid, cwd: instance.cwd, action: action.kind, used: contextUsage.used,
        threshold: action.kind === 'clear' ? status.auto_clear_at : status.auto_compact_at,
        reason: ok ? undefined : newStatus.reason,
      });
    })
    .catch((err) => {
      const newStatus = {
        ..._compactStatusByPid.get(pid) || status,
        lastTriggeredAt: now,
        lastResult: 'failed',
        reason: err && err.message || String(err),
        cooldownUntil: now + COMPACT_COOLDOWN_MS,
      };
      _compactStatusByPid.set(pid, newStatus);
      jlog('auto_compact_failed', {
        pid, cwd: instance.cwd, action: action.kind, reason: newStatus.reason,
      });
    });
  _thresholdCooldown.set(pid, now);
  status.lastTriggeredAt = now;
  status.lastResult = 'pending';
  status.cooldownUntil = now + COMPACT_COOLDOWN_MS;
  _compactStatusByPid.set(pid, status);
  return status;
}

// Stream jsonl with a 1-based line counter. The callback receives (entry, line).
async function readJsonlEntriesIndexed(path, onEntry) {
  let i = 0;
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    i++;
    if (!raw) continue;
    let obj; try { obj = JSON.parse(raw); } catch { continue; }
    onEntry(obj, i);
  }
}

function truncateLabel(s, n = 80) {
  if (typeof s !== 'string') return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

// Classify a single jsonl entry. Returns null when the entry isn't notable.
// Event types (5 from spec + 3 useful additions found in this repo's jsonl):
//   prompt           — type=user with string content (real user input)
//   slash_command    — prompt whose content starts with '/' (e.g. /compact, /clear)
//   auto_compact     — user content containing the canonical resume marker
//                      "This session is being continued from a previous conversation"
//   tool_error       — type=user, content array with any tool_result.is_error===true
//   subagent         — type=assistant, content array contains tool_use name===Task
//   hook_event       — type=attachment with attachment.type==='hook_success'
//   state_change     — *not implemented*: would require full state-machine replay
//                      across the jsonl; punted to follow-up. Not in v1.
function classifyEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const ts = e.timestamp || null;
  if (e.type === 'user') {
    const msg = e.message; const c = msg && msg.content;
    if (typeof c === 'string') {
      if (c.includes('This session is being continued from a previous conversation')) {
        return { type: 'auto_compact', label: 'session continued (auto-compact)', ts };
      }
      const trimmed = c.trim();
      if (trimmed.startsWith('/')) {
        const cmd = trimmed.split(/\s+/)[0];
        return { type: 'slash_command', label: cmd, ts };
      }
      return { type: 'prompt', label: truncateLabel(c, 80), ts };
    }
    if (Array.isArray(c)) {
      const err = c.find(b => b && b.type === 'tool_result' && b.is_error);
      if (err) {
        // Tool name isn't on the user-side tool_result block, but the
        // tool_use_id is — UI can resolve the original tool name if needed.
        const snippet = typeof err.content === 'string'
          ? err.content
          : Array.isArray(err.content)
            ? err.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ')
            : '';
        return { type: 'tool_error', label: truncateLabel(snippet || 'tool returned error', 80), ts, toolUseId: err.tool_use_id || null };
      }
    }
    return null;
  }
  if (e.type === 'assistant') {
    const msg = e.message; const blocks = msg && msg.content;
    if (!Array.isArray(blocks)) return null;
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.name === 'Task') {
        const subType = (b.input && (b.input.subagent_type || b.input.description)) || 'Task';
        return { type: 'subagent', label: truncateLabel(String(subType), 80), ts };
      }
    }
    return null;
  }
  if (e.type === 'attachment') {
    const a = e.attachment;
    if (a && a.type === 'hook_success') {
      // Real Claude Code attachments use camelCase: hookName (e.g.
      // "SessionStart:startup") and hookEvent (e.g. "SessionStart"). Prefer
      // hookName since it's specific; fall back through the snake_case
      // variants in case the schema evolves.
      const name = a.hookName || a.hook_event_name || a.hookEvent || a.hook_name || a.name || 'hook';
      return { type: 'hook_event', label: truncateLabel(String(name), 80), ts };
    }
    return null;
  }
  return null;
}

const _jsonlScanCache = new Map(); // jsonlPath -> { mtime, size, computedAt, runSummary, edits, errors }
const JSONL_SCAN_TTL_MS = 5_000;
const RUN_SUMMARY_MAX_EVENTS = 500; // cap response size
const ERROR_SAMPLES_PER_GROUP = 5;

// Single streaming pass over a session jsonl producing three projections —
// run summary, recent edits, error breakdown — so /run-summary, /recent-edits,
// and /errors all share one scan. mtime+size key with 5s in-memory floor.
async function scanJsonlAll(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return null;
  let st; try { st = statSync(jsonlPath); } catch { return null; }
  const cached = _jsonlScanCache.get(jsonlPath);
  const now = Date.now();
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size
      && now - cached.computedAt < JSONL_SCAN_TTL_MS) {
    return cached;
  }

  // Run summary state
  const events = [];
  const summaryTotals = { prompts: 0, slash_commands: 0, tools: 0, errors: 0, compacts: 0, subagents: 0, hooks: 0 };
  let toolUseCount = 0;

  // Recent edits state: per-target aggregation keyed by file path (Edit/Write/
  // MultiEdit) or command-prefix (Bash). Tracks count, lastTs, lastEditTool,
  // and a small lastDiffPreview string for the most recent occurrence.
  const editMap = new Map(); // key -> { tool, path, count, lastTs, lastDiffPreview }

  // Errors state: cluster tool_result.is_error entries by hash of
  // (tool_name, first 80 chars of message). Resolving tool_name requires
  // mapping tool_use_id → name, so we maintain a forward index from
  // assistant tool_use blocks as we stream.
  const toolUseIndex = new Map(); // tool_use_id -> tool_name
  const errorGroups = new Map();  // groupKey -> { toolName, errorPattern, count, lastTs, samples }
  let errorTotal = 0;

  await readJsonlEntriesIndexed(jsonlPath, (e, line) => {
    // --- side counter + tool_use index + edits ---
    if (e && e.type === 'assistant' && Array.isArray(e.message && e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        toolUseCount++;
        if (b.id) toolUseIndex.set(b.id, b.name || 'unknown');
        recordEdit(b, e.timestamp || null);
      }
    }
    // --- error grouping (user-side tool_result.is_error) ---
    if (e && e.type === 'user' && Array.isArray(e.message && e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_result' || !b.is_error) continue;
        recordError(b, e.timestamp || null);
      }
    }
    // --- run summary classification ---
    const cls = classifyEntry(e);
    if (!cls) return;
    events.push({ ts: cls.ts, type: cls.type, label: cls.label, jsonlLine: line, ...(cls.toolUseId ? { toolUseId: cls.toolUseId } : {}) });
    if (cls.type === 'prompt') summaryTotals.prompts++;
    else if (cls.type === 'slash_command') summaryTotals.slash_commands++;
    else if (cls.type === 'auto_compact') summaryTotals.compacts++;
    else if (cls.type === 'tool_error') summaryTotals.errors++;
    else if (cls.type === 'subagent') summaryTotals.subagents++;
    else if (cls.type === 'hook_event') summaryTotals.hooks++;
  });
  summaryTotals.tools = toolUseCount;

  function recordEdit(block, ts) {
    const tool = block.name;
    if (!tool) return;
    let key, path, preview;
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
      const p = block.input && block.input.file_path;
      if (!p) return;
      path = String(p);
      key = `${tool}::${path}`;
      if (tool === 'Edit') {
        const oldS = block.input.old_string || '';
        const newS = block.input.new_string || '';
        preview = `${truncateLabel(oldS, 40)}  →  ${truncateLabel(newS, 40)}`;
      } else if (tool === 'Write') {
        const c = block.input.content || '';
        preview = `(write ${typeof c === 'string' ? c.length : 0} chars) ${truncateLabel(c, 60)}`;
      } else {
        const edits = Array.isArray(block.input.edits) ? block.input.edits.length : 0;
        preview = `(multi-edit, ${edits} hunks)`;
      }
    } else if (tool === 'Bash') {
      const cmd = (block.input && block.input.command) || '';
      if (!cmd) return;
      // Group bash by command head (first word + first few args) so we don't
      // explode the list with one-off commands. UI can group further by
      // first token if it wants.
      const head = truncateLabel(String(cmd), 60);
      path = head;
      key = `Bash::${head}`;
      preview = truncateLabel(String(cmd), 80);
    } else {
      return;
    }
    const cur = editMap.get(key);
    const tsMs = ts ? Date.parse(ts) : 0;
    if (cur) {
      cur.count++;
      if (tsMs >= cur.lastTsMs) {
        cur.lastTsMs = tsMs;
        cur.lastTs = ts;
        cur.lastDiffPreview = preview;
      }
    } else {
      editMap.set(key, { tool, path, count: 1, lastTs: ts, lastTsMs: tsMs, lastDiffPreview: preview });
    }
  }

  function recordError(block, ts) {
    errorTotal++;
    const toolName = (block.tool_use_id && toolUseIndex.get(block.tool_use_id)) || 'unknown';
    const full = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ')
        : '';
    const pattern = truncateLabel(full || 'tool returned error', 80);
    const groupKey = `${toolName}\n${pattern}`;
    const cur = errorGroups.get(groupKey);
    const sample = { ts, fullMessage: full };
    if (cur) {
      cur.count++;
      if (!cur.lastTs || (ts && ts > cur.lastTs)) cur.lastTs = ts;
      if (cur.samples.length < ERROR_SAMPLES_PER_GROUP) cur.samples.push(sample);
    } else {
      errorGroups.set(groupKey, {
        toolName, errorPattern: pattern,
        count: 1, lastTs: ts,
        samples: [sample],
      });
    }
  }

  // Materialize projections
  const summaryEvents = events.length > RUN_SUMMARY_MAX_EVENTS
    ? events.slice(-RUN_SUMMARY_MAX_EVENTS)
    : events;

  // Edits: sort by lastTs desc; split files vs bash so UI can render two
  // sections without re-grouping.
  const editList = Array.from(editMap.values()).map(({ lastTsMs, ...rest }) => rest);
  editList.sort((a, b) => (Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0));
  const fileEdits = editList.filter(e => e.tool !== 'Bash');
  const bashEdits = editList.filter(e => e.tool === 'Bash');

  // Errors: groups sorted by count desc, then lastTs desc.
  const errorGroupList = Array.from(errorGroups.values());
  errorGroupList.sort((a, b) => b.count - a.count || ((Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0)));

  const result = {
    mtime: st.mtimeMs,
    size: st.size,
    computedAt: now,
    runSummary: {
      events: summaryEvents,
      totalEvents: events.length,
      totals: summaryTotals,
    },
    edits: {
      files: fileEdits,
      bash: bashEdits,
      totalUniqueTargets: editList.length,
    },
    errors: {
      groups: errorGroupList,
      total: errorTotal,
    },
  };
  _jsonlScanCache.set(jsonlPath, result);
  return result;
}

async function computeRunSummary(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    events: r.runSummary.events,
    totalEvents: r.runSummary.totalEvents,
    totals: r.runSummary.totals,
  };
}

async function computeRecentEdits(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    files: r.edits.files,
    bash: r.edits.bash,
    totalUniqueTargets: r.edits.totalUniqueTargets,
  };
}

async function computeErrors(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    groups: r.errors.groups,
    total: r.errors.total,
  };
}

// ---------- end compact threshold + run summary ----------

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

  // sessionUsage: per-instance tokens + USD from Claude Code's native session
  // jsonl. Hubs don't run user sessions so we skip them. Failures are silent —
  // the launcher should still render even when usage data is unavailable.
  let sessionUsage = null;
  let contextUsage = null;
  let compactStatus = null;
  if (!instance.isHub) {
    try {
      const np = resolveNativeJsonl(instance);
      if (np) {
        const u = await readInstanceUsage(np);
        if (u) {
          sessionUsage = {
            input: u.totals.input,
            output: u.totals.output,
            cache_creation: u.totals.cache_creation,
            cache_read: u.totals.cache_read,
            costUSD: u.costUSD,
            requestCount: u.requestCount,
            byModel: u.byModel,
            lastEntry: u.lastEntry,
            jsonlPath: np,
          };
          contextUsage = computeContextUsage(u.lastEntry);
          compactStatus = checkCompactThresholds(instance, contextUsage);
        }
      }
    } catch (err) { log('sessionUsage error:', err.message); }
  }

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
    sessionUsage,
    contextUsage,
    compactStatus,
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

  /* topbar stats (T6: cost + 5h quota) */
  .topbar-stats { display:flex; align-items:center; gap:10px; font-size:11px; }
  .stat { display:flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); white-space:nowrap; user-select:none; transition:border-color .15s, opacity .15s; }
  .stat .stat-icon { font-size:12px; opacity:.85; }
  .stat .stat-label { color:var(--mute); }
  .stat .stat-val { color:var(--fg); font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .stat.is-stale .stat-val::after { content:' ↻'; color:var(--accent); font-size:9px; opacity:.7; }
  .stat.is-loading { opacity:.55; }
  .stat-cost { position:relative; }
  .stat-cost:hover { border-color:var(--accent); }
  .cost-multi { display:flex; align-items:baseline; gap:10px; }
  .cost-slot { display:flex; align-items:baseline; gap:4px; cursor:default; transition:opacity .15s; }
  .cost-slot:hover { opacity:.78; }
  .cost-slot .cost-label { color:var(--mute); font-size:10px; text-transform:lowercase; }
  .cost-slot .cost-val   { color:var(--fg); font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .stat-cost .cost-popover { display:none; position:absolute; top:calc(100% + 6px); right:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; box-shadow:0 4px 16px rgba(0,0,0,.4); z-index:11; min-width:220px; }
  .stat-cost:hover .cost-popover { display:block; }
  .cost-popover .cp-hd { color:var(--mute); font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding-bottom:4px; border-bottom:1px solid var(--line); margin-bottom:5px; }
  .cost-popover .cp-row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:11px; }
  .cost-popover .cp-model { color:var(--mute); font-family:ui-monospace,monospace; max-width:160px; overflow:hidden; text-overflow:ellipsis; }
  .cost-popover .cp-val { color:var(--fg); font-weight:600; font-family:ui-monospace,monospace; }
  .cost-popover .cp-total { border-top:1px solid var(--line); margin-top:5px; padding-top:6px; }
  .cost-popover .cp-empty { color:var(--mute); font-size:11px; padding:2px 0; }
  .stat-quota .quota-bar { width:54px; height:4px; background:var(--line); border-radius:2px; overflow:hidden; }
  .stat-quota .quota-fill { height:100%; background:var(--ok); transition:width .3s, background .3s; }
  .stat-quota .quota-fill.warn { background:var(--warn); }
  .stat-quota .quota-fill.bad  { background:var(--bad); }
  .stat-quota .src-tag { font-size:11px; padding:1px 5px; border-radius:3px; font-weight:600; letter-spacing:.2px; }
  .stat-quota .src-tag.computed { color:var(--warn); background:rgba(210,153,34,.14); }
  .stat-quota.unavailable { opacity:.55; }
  /* per-instance session cost mini-tag (T6 spec follow-up) */
  .instance-head .tag.cost { color:var(--mute); background:rgba(125,133,144,.12); font-weight:500; }
  .instance-head .tag.cost[hidden] { display:none; }

  /* per-card context bar (T6: H2) */
  .context-row { display:flex; align-items:center; gap:8px; margin:0 0 8px; font-size:10px; color:var(--mute); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .context-row[hidden] { display:none; }
  .context-row .ctx-bar { flex:0 0 auto; width:120px; height:4px; background:var(--line); border-radius:2px; overflow:hidden; }
  .context-row .ctx-fill { height:100%; background:var(--ok); transition:width .3s, background .3s; }
  .context-row .ctx-fill.warn { background:var(--warn); }
  .context-row .ctx-fill.hot  { background:#f0883e; }
  .context-row .ctx-fill.bad  { background:var(--bad); }
  .context-row .ctx-pct { font-weight:600; color:var(--fg); }
  .context-row .ctx-model { opacity:.7; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* kanban (T7: 3 columns Waiting / Working / Idle) */
  .kanban { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; align-items:start; }
  .kanban-col { border:1px solid var(--line); border-radius:10px; min-height:80px; overflow:hidden; }
  .kanban-col[data-col="waiting"] { border-color:rgba(248,81,73,.28); background:rgba(248,81,73,.04); }
  .kanban-col[data-col="working"] { border-color:rgba(210,153,34,.25); background:rgba(210,153,34,.04); }
  .kanban-col[data-col="idle"]    { border-color:var(--line); }
  .kanban-hd { padding:8px 12px; font-size:11px; color:var(--mute); font-weight:600; text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:6px; background:rgba(13,17,23,.4); }
  .kanban-hd .col-icon { font-size:13px; line-height:1; }
  .kanban-col[data-col="waiting"] .kanban-hd .col-icon { color:var(--bad); }
  .kanban-col[data-col="working"] .kanban-hd .col-icon { color:var(--warn); }
  .kanban-col[data-col="idle"]    .kanban-hd .col-icon { color:var(--mute); }
  .kanban-hd .col-count { margin-left:auto; font-size:10px; background:var(--card); padding:1px 7px; border-radius:10px; font-family:ui-monospace,monospace; color:var(--fg); }
  .kanban-body { padding:8px; display:flex; flex-direction:column; gap:8px; }
  .kanban-body > .group { margin-bottom:0; } /* override default 10px, gap handles spacing */
  .col-empty { padding:14px 8px; text-align:center; color:var(--mute); font-size:11px; opacity:.55; }
  @media (max-width:880px) {
    .kanban { grid-template-columns: 1fr; gap:10px; }
  }

  /* tag chips + filter (T8: H5) */
  .group-tags { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; margin-left:4px; }
  .tag-chip { font-size:10px; color:var(--accent); background:rgba(88,166,255,.10); padding:1px 7px; border-radius:10px; cursor:pointer; user-select:none; transition:background .15s, color .15s; }
  .tag-chip::after { content:' ×'; opacity:.4; transition:opacity .15s; }
  .tag-chip:hover { background:rgba(248,81,73,.15); color:var(--bad); }
  .tag-chip:hover::after { opacity:1; }
  .tag-add { font-size:10px; color:var(--mute); background:transparent; border:1px dashed var(--line); padding:0 6px; height:18px; line-height:16px; border-radius:10px; cursor:pointer; font-family:inherit; transition:color .15s, border-color .15s, opacity .15s; opacity:0; }
  .group:hover .tag-add { opacity:1; }
  .tag-add:hover { color:var(--accent); border-color:var(--accent); }
  #tag-filter { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 9px; font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; min-width:160px; transition:border-color .15s; }
  #tag-filter:focus { outline:0; border-color:var(--accent); }
  #tag-filter::placeholder { color:var(--mute); }
  #btn-help { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; }
  #btn-help:hover { color:var(--accent); border-color:var(--accent); }
  #btn-wt { background:transparent; color:#8ddc94; border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; font-family:ui-monospace,monospace; }
  #btn-wt:hover { border-color:#8ddc94; }
  #wt-list .wt-row { display:flex; gap:8px; align-items:center; padding:6px 4px; border-bottom:1px dotted var(--line); }
  #wt-list .wt-row:last-child { border-bottom:0; }
  #wt-list .wt-branch { color:#a5d6ff; font-weight:600; min-width:160px; }
  #wt-list .wt-path { color:var(--mute); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #wt-list .wt-status { font-size:10px; color:var(--mute); }
  #wt-list .wt-status.alive { color:var(--ok); }
  #wt-list .wt-status.dirty { color:var(--warn); }
  .group[data-filter-hidden] { display:none; }
  /* j/n flash highlight */
  @keyframes jumpFlash {
    0%, 100% { background:transparent; }
    20%, 60% { background:rgba(88,166,255,.18); }
  }
  .instance.flash { animation:jumpFlash 1.2s ease-out; }
  /* help dialog */
  #help-dlg { max-width:420px; }
  #help-dlg h2 { margin:0 0 12px; font-size:14px; }
  #help-dlg .kb-table { width:100%; border-collapse:collapse; font-size:12px; }
  #help-dlg .kb-table td { padding:5px 0; vertical-align:top; }
  #help-dlg .kb-table td:first-child { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); white-space:nowrap; padding-right:14px; min-width:90px; }
  #help-dlg .kb-row-hd td { color:var(--mute); font-size:10px; text-transform:uppercase; padding:10px 0 2px; border-bottom:1px solid var(--line); }
  @media (max-width:640px) {
    #tag-filter { min-width:0; flex:1 1 auto; max-width:140px; font-size:10px; padding:4px 7px; }
    #btn-help { padding:4px 8px; }
  }

  /* mobile narrow: shrink stats, hide labels, recenter popover.
     Cost block collapses to one slot + tap-cycle controlled by
     body[data-active-range="..."]; default is 'today'. */
  @media (max-width:640px) {
    .topbar-stats { gap:6px; font-size:10px; }
    .stat { padding:3px 7px; gap:4px; }
    .stat .stat-label { display:none; }
    .stat-cost .cost-popover { right:auto; left:50%; transform:translateX(-50%); min-width:200px; }
    .stat-quota .quota-bar { width:36px; }
    .context-row .ctx-bar { width:80px; }
    .context-row .ctx-model { max-width:90px; }
    /* show only the active cost slot; tap to cycle */
    .cost-multi { cursor:pointer; gap:0; }
    .cost-slot { display:none; }
    body[data-active-range="today"] .cost-slot[data-range="today"],
    body[data-active-range="week"]  .cost-slot[data-range="week"],
    body[data-active-range="month"] .cost-slot[data-range="month"],
    body:not([data-active-range]) .cost-slot[data-range="today"] { display:flex; }
  }

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

  /* card tabs panel (T11: M1 Run Summary + M3 Recent Edits + Errors) */
  .card-tabs { margin-top:6px; }
  .tab-strip { display:flex; gap:0; border-bottom:1px solid var(--line); margin-bottom:6px; flex-wrap:wrap; }
  .tab-btn { background:transparent; color:var(--mute); border:0; padding:5px 12px; font-size:11px; font-family:inherit; cursor:pointer; border-bottom:2px solid transparent; transition:color .15s, border-color .15s; }
  .tab-btn:hover { color:var(--fg); }
  .tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-btn .tab-count { display:inline-block; margin-left:4px; font-size:10px; opacity:.75; }
  .tab-btn.has-error { color:var(--bad); }
  .tab-btn.has-error.active { border-bottom-color:var(--bad); color:var(--bad); }
  .tab-panel { padding:6px 4px; max-height:280px; overflow-y:auto; font-size:11px; }
  .tab-panel[hidden] { display:none; }
  .tab-empty { color:var(--mute); padding:10px 8px; text-align:center; font-style:italic; opacity:.7; }
  .tab-loading { color:var(--mute); padding:10px 8px; text-align:center; opacity:.8; }
  .tab-error { color:var(--bad); padding:10px 8px; font-family:ui-monospace,monospace; font-size:10px; }
  /* Run Summary timeline */
  .run-totals { display:flex; flex-wrap:wrap; gap:6px; padding:0 0 8px; border-bottom:1px dotted var(--line); margin-bottom:8px; font-size:10px; color:var(--mute); }
  .run-totals .rt-chip { background:var(--card); padding:1px 8px; border-radius:10px; font-family:ui-monospace,monospace; }
  .run-totals .rt-chip.err { color:var(--bad); background:rgba(248,81,73,.10); }
  .run-event-row { display:flex; gap:8px; align-items:baseline; padding:3px 0; border-bottom:1px dotted var(--line); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; }
  .run-event-row:last-child { border-bottom:0; }
  .run-event-row .re-ts { color:var(--mute); min-width:60px; flex-shrink:0; }
  .run-event-row .re-icon { width:14px; text-align:center; flex-shrink:0; }
  .run-event-row.t-prompt          .re-icon { color:#a5d6ff; }
  .run-event-row.t-slash_command   .re-icon { color:var(--accent); }
  .run-event-row.t-auto_compact    .re-icon { color:var(--warn); }
  .run-event-row.t-tool_error      .re-icon { color:var(--bad); }
  .run-event-row.t-subagent        .re-icon { color:#bc8cff; }
  .run-event-row.t-hook_event      .re-icon { color:var(--mute); }
  .run-event-row .re-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .run-event-row.t-tool_error .re-label { color:#f0a4a0; }
  /* Recent Edits */
  .edits-section { margin-bottom:10px; }
  .edits-section:last-child { margin-bottom:0; }
  .edits-section .es-hd { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:5px; }
  .edit-row { padding:5px 0; border-bottom:1px dotted var(--line); }
  .edit-row:last-child { border-bottom:0; }
  .edit-row .er-line1 { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; }
  .edit-row .er-tool { color:var(--mute); min-width:60px; flex-shrink:0; }
  .edit-row .er-path { color:var(--fg); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .edit-row .er-meta { color:var(--mute); flex-shrink:0; font-size:10px; }
  .edit-row .er-preview { color:var(--mute); font-family:ui-monospace,monospace; font-size:10px; padding:3px 0 0 68px; opacity:.85; white-space:pre-wrap; word-break:break-all; max-height:64px; overflow:hidden; }
  .edit-row .er-preview:empty { display:none; }
  /* Errors clustering */
  .err-group { padding:6px 0; border-bottom:1px dotted var(--line); }
  .err-group:last-child { border-bottom:0; }
  .err-group .eg-hd { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; cursor:pointer; user-select:none; }
  .err-group .eg-tool { color:var(--bad); font-weight:600; min-width:60px; flex-shrink:0; }
  .err-group .eg-pattern { flex:1; min-width:0; color:#f0a4a0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .err-group .eg-count { color:var(--mute); flex-shrink:0; }
  /* Git tab */
  .git-summary { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; padding:4px 0 8px; border-bottom:1px dotted var(--line); margin-bottom:6px; font-family:ui-monospace,monospace; font-size:11px; }
  .git-summary .g-branch { color:#a5d6ff; font-weight:600; }
  .git-summary .g-stat-add { color:var(--ok); }
  .git-summary .g-stat-del { color:var(--bad); }
  .git-summary .g-stat-files { color:var(--mute); }
  .git-summary .g-ahead { color:var(--warn); }
  .git-summary .g-ahead.g-muted { color:var(--mute); }
  .git-files { max-height:160px; overflow-y:auto; margin-bottom:8px; }
  .g-file { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; padding:2px 0; border-bottom:1px dotted var(--line); }
  .g-file:last-child { border-bottom:0; }
  .g-file .g-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .g-file.g-untracked .g-path { color:#8ddc94; }
  .g-file .g-tag-new { font-size:9px; color:var(--ok); background:rgba(63,185,80,.10); padding:0 5px; border-radius:8px; margin-left:4px; }
  .g-file .g-loc { color:var(--mute); flex-shrink:0; }
  .git-actions { display:flex; gap:6px; flex-wrap:wrap; padding-top:4px; border-top:1px dotted var(--line); }
  .git-actions .btn[disabled] { opacity:.4; cursor:not-allowed; }
  .instance-head .wt-tag { font-size:10px; color:#8ddc94; background:rgba(63,185,80,.10); padding:1px 6px; border-radius:3px; font-family:ui-monospace,monospace; }
  /* Memory tab */
  .mem-group { margin-bottom:10px; }
  .mem-group:last-child { margin-bottom:0; }
  .mg-hd { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .mem-row { padding:0; border-bottom:1px dotted var(--line); }
  .mem-row:last-child { border-bottom:0; }
  .mem-row .mr-hd { display:flex; gap:8px; align-items:baseline; padding:5px 4px; cursor:pointer; font-family:ui-monospace,monospace; font-size:10px; }
  .mem-row .mr-hd:hover { background:rgba(88,166,255,.06); }
  .mem-row .mr-path { color:#a5d6ff; font-weight:600; min-width:90px; }
  .mem-row .mr-dir { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--mute); direction:rtl; text-align:left; }
  .mem-row .mr-meta { color:var(--mute); flex-shrink:0; }
  .mem-row .mr-body { padding:6px 4px; }
  .mem-row .mr-body textarea { width:100%; height:380px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.5; resize:vertical; box-sizing:border-box; }
  .mem-row .mr-body textarea:focus { outline:0; border-color:var(--accent); }
  .mem-row .mr-actions { display:flex; gap:6px; margin-top:6px; }
  .mem-row .mr-info { font-size:10px; color:var(--mute); padding-top:4px; }
  /* global Memory drawer */
  #mem-drawer { display:none; position:fixed; right:16px; top:54px; width:400px; max-width:90vw; max-height:70vh; overflow-y:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px; z-index:30; box-shadow:0 6px 24px rgba(0,0,0,.4); }
  #mem-drawer.open { display:block; }
  #mem-drawer .md-hd { display:flex; justify-content:space-between; align-items:center; padding-bottom:6px; border-bottom:1px solid var(--line); margin-bottom:8px; }
  #mem-drawer .md-title { font-size:12px; font-weight:600; }
  #mem-drawer .md-close { background:transparent; color:var(--mute); border:0; font-size:18px; cursor:pointer; }
  #mem-drawer .md-row { display:flex; gap:6px; padding:4px 0; border-bottom:1px dotted var(--line); font-family:ui-monospace,monospace; font-size:10px; }
  #mem-drawer .md-row:last-child { border-bottom:0; }
  #mem-drawer .md-scope { color:#a5d6ff; min-width:54px; font-weight:600; }
  #mem-drawer .md-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  #mem-drawer .md-pids { color:var(--mute); }
  #btn-mem { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; }
  #btn-mem:hover { color:var(--accent); border-color:var(--accent); }
  .err-group .eg-samples { display:none; padding:4px 0 0 0; }
  .err-group.open .eg-samples { display:block; }
  .err-sample { font-family:ui-monospace,monospace; font-size:10px; color:var(--mute); padding:3px 0; white-space:pre-wrap; word-break:break-all; border-left:2px solid var(--line); padding-left:8px; margin:4px 0; }
  .err-sample .es-ts { color:#7d8590; font-size:9px; opacity:.7; display:block; margin-bottom:2px; }
  /* compactStatus card-level alert (no_inject_channel manual /compact hint) */
  .compact-alert { margin:0 0 8px; padding:6px 10px; background:rgba(248,81,73,.08); border:1px solid rgba(248,81,73,.35); border-left-width:3px; border-radius:6px; font-size:11px; color:#f0a4a0; line-height:1.4; display:flex; align-items:flex-start; gap:8px; }
  .compact-alert[hidden] { display:none; }
  .compact-alert .ca-icon { flex-shrink:0; color:var(--bad); font-weight:600; }
  .compact-alert .ca-cmd { font-family:ui-monospace,monospace; font-weight:600; color:#ffaba3; padding:1px 6px; background:rgba(248,81,73,.18); border-radius:3px; }
  /* Compact Threshold form */
  .th-form { display:flex; flex-direction:column; gap:8px; padding:4px 2px; font-size:11px; }
  .th-form .th-row { display:flex; align-items:center; gap:8px; }
  .th-form .th-row.col { flex-direction:column; align-items:flex-start; gap:3px; }
  .th-form input[type=number] { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:5px; padding:4px 7px; font-family:ui-monospace,monospace; font-size:11px; width:110px; }
  .th-form input[type=number]:focus { outline:0; border-color:var(--accent); }
  .th-form input[type=checkbox] { accent-color:var(--accent); }
  .th-form label { color:var(--fg); font-size:11px; cursor:pointer; }
  .th-form .th-help { color:var(--mute); font-size:10px; margin-left:6px; }
  .th-form .th-meta { padding:6px 8px; background:var(--bg); border:1px solid var(--line); border-radius:5px; font-size:10px; color:var(--mute); display:flex; flex-direction:column; gap:3px; font-family:ui-monospace,monospace; }
  .th-form .th-meta .th-warn { color:#f0a4a0; }
  .th-form .th-err { color:var(--bad); font-size:10px; flex:1; }
  .th-form .th-err[hidden] { display:none; }

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
  <div class="topbar-stats" id="topbar-stats">
    <div class="stat stat-cost is-loading" id="stat-cost" title="cost summary (hover a number for breakdown; tap to cycle on narrow screens)">
      <span class="stat-icon">$</span>
      <div class="cost-multi" id="cost-multi">
        <span class="cost-slot" data-range="today"><span class="cost-label">today</span><span class="cost-val">—</span></span>
        <span class="cost-slot" data-range="week"><span class="cost-label">week</span><span class="cost-val">—</span></span>
        <span class="cost-slot" data-range="month"><span class="cost-label">month</span><span class="cost-val">—</span></span>
      </div>
      <div class="cost-popover" id="stat-cost-popover">
        <div class="cp-hd">By model · <span id="cp-range">today</span></div>
        <div id="cp-list"><div class="cp-empty">loading…</div></div>
      </div>
    </div>
    <div class="stat stat-quota is-loading" id="stat-quota" title="5h sliding window">
      <span class="stat-icon">⏱</span>
      <span class="stat-label">5h</span>
      <span class="stat-val" id="stat-quota-val">—</span>
      <div class="quota-bar"><div class="quota-fill" id="stat-quota-fill" style="width:0"></div></div>
      <span class="src-tag" id="stat-quota-src" hidden></span>
    </div>
  </div>
  <span class="grow"></span>
  <input type="text" id="tag-filter" placeholder="filter tags (/)" autocomplete="off" spellcheck="false">
  <button id="btn-wt" title="git worktrees (click to manage)" hidden>🌿 <span id="btn-wt-count">0</span></button>
  <button id="btn-mem" title="CLAUDE.md across all running instances (aggregated)">📖 Memory</button>
  <button id="btn-help" title="Keyboard shortcuts (?)">?</button>
  <button id="btn-new">+ New</button>
</header>
<div id="mem-drawer">
  <div class="md-hd">
    <span class="md-title">Memory (aggregated)</span>
    <button class="md-close" id="mem-drawer-close" title="close">×</button>
  </div>
  <div id="mem-drawer-body" style="font-size:11px;color:var(--mute)">loading…</div>
</div>
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
  <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--fg);cursor:pointer">
    <input type="checkbox" id="use-worktree">
    <span>新建 git worktree (隔离分支，避免多实例同 cwd 互踩)</span>
  </label>
  <div class="err" id="err" hidden></div>
  <div class="row">
    <button class="btn" id="btn-cancel">Cancel</button>
    <button class="btn primary" id="btn-launch">Launch</button>
  </div>
</dialog>

<dialog id="wt-dlg" style="max-width:760px;width:90%">
  <h2>Worktrees</h2>
  <div id="wt-list" style="max-height:50vh;overflow-y:auto;border:1px solid var(--line);border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11px">loading…</div>
  <div class="row" style="margin-top:10px;justify-content:space-between">
    <div style="display:flex;gap:8px;align-items:center">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute);cursor:pointer">
        <input type="checkbox" id="wt-force"> force (clobber uncommitted / unpushed)
      </label>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn" id="wt-close">Close</button>
      <button class="btn danger" id="wt-cleanup">Clean selected</button>
    </div>
  </div>
</dialog>

<dialog id="help-dlg">
  <h2>Keyboard shortcuts</h2>
  <table class="kb-table">
    <tr class="kb-row-hd"><td colspan="2">Navigation</td></tr>
    <tr><td>j  /  n</td><td>jump to next <strong>waiting_ask</strong> instance</td></tr>
    <tr><td>/</td><td>focus tag filter</td></tr>
    <tr><td>?</td><td>show this help</td></tr>
    <tr><td>Esc</td><td>close dialog / overlay</td></tr>
    <tr class="kb-row-hd"><td colspan="2">Filter syntax</td></tr>
    <tr><td>tok1 tok2</td><td>AND match — all tokens must match a tag (case-insensitive substring)</td></tr>
  </table>
  <div class="row" style="margin-top:14px">
    <button class="btn" id="help-close">Close</button>
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
      +     (it.worktree ? '<span class="wt-tag" title="git worktree: ' + escape(it.worktree.path || '') + ' (base ' + escape(it.worktree.baseRef || '') + ')">🌿 ' + escape(it.worktree.branch || '') + '</span>' : '')
      +     (it.isHub ? '' : '<span class="tag cost" data-cost-for="' + it.pid + '" hidden></span>')
      +   '</div>'
      +   '<div class="card-title" data-title-for="' + it.pid + '"></div>'
      +   '<div class="activity-row" data-act-row="' + it.pid + '">'
      +     '<span class="badge no_session">⚫ probing…</span>'
      +     '<span class="preview"></span>'
      +     (it.isHub ? '' : '<button class="activity-toggle" data-act="actdrawer" data-pid="' + it.pid + '" title="show recent activity">▾</button>')
      +   '</div>'
      +   (it.isHub ? '' : '<div class="context-row" data-ctx-for="' + it.pid + '" hidden></div>')
      +   (it.isHub ? '' : '<div class="compact-alert" data-compact-for="' + it.pid + '" hidden></div>')
      +   (it.isHub ? '' : '<div class="activity-drawer" data-act-drawer="' + it.pid + '"></div>')
      +   (it.isHub
            ? '<details><summary>URLs &middot; QR</summary>'
              + (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>' : '')
              + (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>' : '')
              + (pub ? '<div class="qr" data-qr="'+pub+'"></div>' : '')
              + '</details>'
            : '<details><summary>Details &middot; URLs &middot; Summary &middot; Edits &middot; Errors &middot; Memory' + (it.worktree ? ' &middot; Git' : '') + '</summary>'
              + '<div class="card-tabs" data-tabs-for="' + it.pid + '">'
              +   '<div class="tab-strip" role="tablist">'
              +     '<button class="tab-btn active" data-tab-btn="urls"    data-pid="' + it.pid + '">URLs &middot; QR</button>'
              +     '<button class="tab-btn"        data-tab-btn="summary" data-pid="' + it.pid + '">Summary</button>'
              +     '<button class="tab-btn"        data-tab-btn="edits"   data-pid="' + it.pid + '">Edits</button>'
              +     '<button class="tab-btn"        data-tab-btn="errors"  data-pid="' + it.pid + '">Errors</button>'
              +     '<button class="tab-btn"        data-tab-btn="threshold" data-pid="' + it.pid + '" data-cwd="' + escape(it.cwd || '') + '">Threshold</button>'
              +     '<button class="tab-btn"        data-tab-btn="memory"  data-pid="' + it.pid + '">Memory</button>'
              +     (it.worktree ? '<button class="tab-btn" data-tab-btn="git" data-pid="' + it.pid + '">Git</button>' : '')
              +   '</div>'
              +   '<div class="tab-panel" data-tab-panel="urls" data-pid="' + it.pid + '">'
              +     (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>' : '')
              +     (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>' : '')
              +     (pub ? '<div class="qr" data-qr="'+pub+'"></div>' : '')
              +     (!lan && !pub ? '<div class="tab-empty">no URLs</div>' : '')
              +   '</div>'
              +   '<div class="tab-panel" data-tab-panel="summary" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="edits"   data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="errors"  data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="threshold" data-pid="' + it.pid + '" data-cwd="' + escape(it.cwd || '') + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="memory" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   (it.worktree ? '<div class="tab-panel" data-tab-panel="git" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>' : '')
              + '</div>'
              + '</details>')
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
    // Tag chips (T8): editable per-cwd labels, skipped for the hub group
    // (cwd-less, can't be tagged meaningfully). Each chip click removes the
    // tag; "+ tag" button (visible on group hover) prompts for a new one.
    const tagsHtml = (() => {
      if (g.hasHub) return '';
      const cwd = g.cwd || '';
      const cwdEsc = escape(cwd);
      const tags = (_tagsByCwd[cwd] || []).slice().sort();
      const chips = tags.map(t =>
        '<span class="tag-chip" data-act="tag-rm" data-cwd="' + cwdEsc + '" data-tag="' + escape(t) + '" title="点击删除标签">' + escape(t) + '</span>'
      ).join('');
      return '<span class="group-tags">' + chips + '<button class="tag-add" data-act="tag-add" data-cwd="' + cwdEsc + '" title="add tag">+</button></span>';
    })();
    const body = g.list.map(renderInstance).join('');
    return ''
      + '<div class="group' + (g.hasHub ? ' is-hub' : '') + '" data-group-cwd="' + escape(g.cwd || '') + '">'
      +   '<div class="group-head">'
      +     '<div class="group-id">'
      +       '<span class="group-name">' + showName + '</span>'
      +       subName
      +       aliasBtn
      +       countTag
      +       (g.hasHub ? '<span class="hub-tag">HUB</span>' : '')
      +       tagsHtml
      +     '</div>'
      +     '<div class="group-path" title="'+path+'">'+path+'</div>'
      +     (groupActions ? '<div class="group-actions">' + groupActions + '</div>' : '')
      +   '</div>'
      +   '<div class="group-body">' + body + '</div>'
      + '</div>';
  }

  // ---- T7: status iconography + Kanban column mapping ----
  // backend deriveStatus returns one of these enum values; UI is the canonical
  // place to map them to single-char icons + short labels (the longer
  // statusLabel from backend stays available as a tooltip via title=).
  const STATUS_VIEW = {
    thinking:     { icon: '⏳', short: 'thinking' },
    tool_running: { icon: '●',  short: 'working'  },
    waiting_ask:  { icon: '◐',  short: 'waiting'  },
    idle:         { icon: '○',  short: 'idle'     },
    no_session:   { icon: '○',  short: 'no log'   },
    error:        { icon: '⚠',  short: 'error'    },
  };
  function colForStatus(s) {
    if (s === 'waiting_ask') return 'waiting';
    if (s === 'thinking' || s === 'tool_running') return 'working';
    return 'idle'; // idle / no_session / error
  }
  // Pick the most-attention column among instances in a group. waiting > working > idle.
  function colForGroup(g) {
    let best = 'idle';
    for (const it of g.list) {
      const s = _statusByPid.get(it.pid) || 'no_session';
      const col = colForStatus(s);
      if (col === 'waiting') return 'waiting';
      if (col === 'working') best = 'working';
    }
    return best;
  }
  const _statusByPid = new Map();
  let _lastListData = { items: [], history: [], localCc: [] };
  let _lastColByCwd = new Map();
  // T8: tag state — populated by loadPrefs() on initial load and after every
  // tag mutation. Render reads these to paint chips; applyTagFilter() uses
  // them to decide which groups to hide.
  let _tagsByCwd = {};
  let _allTags = [];
  let _filterText = '';
  let _jumpIdx = -1;

  function render(items, history, localCc) {
    _lastListData = { items, history: history || [], localCc: localCc || [] };
    const total = items.length + (history || []).length + ((localCc || []).length);
    metaEl.textContent = items.length + ' running'
      + (localCc && localCc.length ? ' · ' + localCc.length + ' local' : '')
      + (history && history.length ? ' · ' + history.length + ' recent' : '');
    if (!total) {
      listEl.innerHTML = '<div class="empty">No instances yet. Click "+ New" to launch one.</div>';
      _lastColByCwd = new Map();
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

    // Bin groups into Kanban columns. Same cwd group is kept together (per
    // team-lead constraint) and goes to the column matching its highest-
    // priority instance status (waiting > working > idle).
    const cols = { waiting: [], working: [], idle: [] };
    const newColByCwd = new Map();
    for (const g of groups) {
      const col = colForGroup(g);
      cols[col].push(g);
      newColByCwd.set(g.cwd, col);
    }
    _lastColByCwd = newColByCwd;
    const colMeta = [
      { id: 'waiting', icon: '◐', label: 'Waiting' },
      { id: 'working', icon: '●', label: 'Working' },
      { id: 'idle',    icon: '○', label: 'Idle' },
    ];

    let html = '';
    if (items.length) {
      html += '<div class="kanban">';
      for (const cm of colMeta) {
        const colGroups = cols[cm.id];
        html += '<div class="kanban-col" data-col="' + cm.id + '">';
        html +=   '<div class="kanban-hd"><span class="col-icon">' + cm.icon + '</span> ' + cm.label + ' <span class="col-count">' + colGroups.length + '</span></div>';
        html +=   '<div class="kanban-body" data-col-body="' + cm.id + '">';
        if (!colGroups.length) {
          html += '<div class="col-empty">—</div>';
        } else {
          html += colGroups.map(renderGroup).join('');
        }
        html +=   '</div>';
        html += '</div>';
      }
      html += '</div>';
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
    // Re-apply current tag filter against the new DOM (T8)
    applyTagFilter();
    // Re-apply per-pid tab state + re-render cached tab content (T11)
    rehydrateTabs();
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
    } else if (act === 'tag-add') {
      const cwd = t.dataset.cwd || '';
      if (!cwd) return;
      const existing = (_tagsByCwd[cwd] || []).slice();
      const hint = _allTags.length ? ' (常用: ' + _allTags.slice(0, 8).join(', ') + ')' : '';
      const next = window.prompt('添加标签 (≤24 字符，可用 key:value 形式如 env:prod)' + hint, '');
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed) return;
      if (existing.includes(trimmed)) return;
      try {
        const data = await api('/api/launcher/prefs/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, tags: existing.concat(trimmed) }) });
        _tagsByCwd[cwd] = data.tags || [];
        if (Array.isArray(data.allTags)) _allTags = data.allTags;
        if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
      } catch (e) { alert('添加标签失败: ' + e.message); }
    } else if (act === 'tag-rm') {
      const cwd = t.dataset.cwd || '';
      const tag = t.dataset.tag || '';
      if (!cwd || !tag) return;
      const existing = (_tagsByCwd[cwd] || []).filter(x => x !== tag);
      try {
        const data = await api('/api/launcher/prefs/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, tags: existing }) });
        _tagsByCwd[cwd] = data.tags || [];
        if (Array.isArray(data.allTags)) _allTags = data.allTags;
        if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
      } catch (e) { alert('删除标签失败: ' + e.message); }
    }
  });

  // ---- M2: Git tab actions (commit / push / open PR) ----
  // Three buttons inside the Git tab — each opens a tiny inline dialog (no
  // <dialog> markup; prompt() / textarea modal is enough for now). Refresh
  // the tab after each successful op so the file list / ahead counter update.
  function reloadGitTab(pid) {
    const st = _tabState.get(pid); if (st) st.cache.git = null;
    loadTabData(pid, 'git');
  }
  async function gitCommitFlow(pid) {
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    const aliasOrName = (container && container.closest('.group')) ? (container.closest('.group').querySelector('.group-name')?.textContent || '') : '';
    const template = aliasOrName ? aliasOrName + ': ' : '';
    const message = window.prompt('Commit message (worktree branch):', template);
    if (message == null) return;
    if (!message.trim()) { alert('Commit message required'); return; }
    try {
      const r = await api('/api/launcher/instances/' + pid + '/git-commit', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ message }),
      });
      if (r.nothingToCommit) { alert('Nothing to commit (working tree clean)'); }
      else { alert('Committed ' + (r.sha || '').slice(0,8)); }
      reloadGitTab(pid);
    } catch (e) { alert('Commit failed: ' + e.message); }
  }
  async function gitPushFlow(pid) {
    if (!confirm('Push worktree branch to origin (--force-with-lease only when retrying)?')) return;
    try {
      const r = await api('/api/launcher/instances/' + pid + '/git-push', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ force: false }),
      });
      alert('Pushed:\n' + (r.output || '').slice(0, 1200));
      reloadGitTab(pid);
    } catch (e) {
      if (/non-fast-forward|rejected/i.test(e.message) && confirm('Push rejected (non-fast-forward). Retry with --force-with-lease?')) {
        try {
          const r2 = await api('/api/launcher/instances/' + pid + '/git-push', {
            method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ force: true }),
          });
          alert('Force-pushed:\n' + (r2.output || '').slice(0, 1200));
          reloadGitTab(pid);
        } catch (e2) { alert('Force push failed: ' + e2.message); }
      } else {
        alert('Push failed: ' + e.message);
      }
    }
  }
  async function gitOpenPrFlow(pid) {
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    const aliasOrName = (container && container.closest('.group')) ? (container.closest('.group').querySelector('.group-name')?.textContent || '') : '';
    const title = window.prompt('PR title:', aliasOrName ? aliasOrName + ': ' : '');
    if (title == null || !title.trim()) return;
    const body = window.prompt('PR body (markdown ok; empty = blank):', '') || '';
    const base = window.prompt('Base branch (blank = auto-detect):', '') || '';
    try {
      const r = await api('/api/launcher/instances/' + pid + '/open-pr', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title: title.trim(), body, base: base.trim() }),
      });
      if (r.ok === false && r.error) { alert('Open PR failed: ' + r.error); return; }
      if (r.url) { alert('PR created:\n' + r.url); try { window.open(r.url, '_blank', 'noopener'); } catch {} }
      else { alert('PR created (no URL returned)'); }
    } catch (e) { alert('Open PR failed: ' + e.message); }
  }
  listEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act !== 'git-commit' && act !== 'git-push' && act !== 'git-pr') return;
    ev.preventDefault();
    const pid = parseInt(t.dataset.pid, 10);
    if (!Number.isFinite(pid)) return;
    if (act === 'git-commit') gitCommitFlow(pid);
    else if (act === 'git-push') gitPushFlow(pid);
    else if (act === 'git-pr') gitOpenPrFlow(pid);
  });

  // ---- M4: Memory tab — open + edit + save CLAUDE.md / rules ----
  async function memOpenRow(memRow) {
    const body = memRow.querySelector('.mr-body');
    if (!body) return;
    if (!body.hidden) {
      // toggle close
      body.hidden = true; body.innerHTML = '';
      return;
    }
    body.hidden = false;
    body.innerHTML = '<div class="tab-loading">loading…</div>';
    const path = memRow.dataset.memPath;
    try {
      const r = await api('/api/launcher/file?path=' + encodeURIComponent(path));
      body.innerHTML = ''
        + '<textarea spellcheck="false" data-mem-edit></textarea>'
        + '<div class="mr-actions">'
        +   '<button class="btn primary" data-act="mem-save">Save</button>'
        +   '<button class="btn" data-act="mem-cancel">Cancel</button>'
        +   '<span class="mr-info">' + (r.size || 0) + ' bytes · backup auto-kept (latest 5)</span>'
        + '</div>';
      body.querySelector('textarea').value = r.content || '';
    } catch (e) {
      body.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    }
  }
  async function memSaveRow(memRow) {
    const path = memRow.dataset.memPath;
    const ta = memRow.querySelector('textarea[data-mem-edit]');
    if (!ta) return;
    try {
      const r = await api('/api/launcher/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: ta.value }),
      });
      alert('Saved · ' + (r.size || 0) + ' bytes' + (r.backup ? '\nbackup: ' + r.backup : ''));
      // Refresh the Memory tab so size/mtime update
      const container = memRow.closest('[data-tabs-for]');
      if (container) {
        const pid = Number(container.dataset.tabsFor);
        const st = _tabState.get(pid);
        if (st) st.cache.memory = null;
        loadTabData(pid, 'memory');
      }
    } catch (e) { alert('Save failed: ' + e.message); }
  }
  listEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act !== 'mem-open' && act !== 'mem-save' && act !== 'mem-cancel') return;
    ev.preventDefault();
    const memRow = t.closest('.mem-row');
    if (!memRow) return;
    if (act === 'mem-open') memOpenRow(memRow);
    else if (act === 'mem-save') memSaveRow(memRow);
    else if (act === 'mem-cancel') { const b = memRow.querySelector('.mr-body'); if (b) { b.hidden = true; b.innerHTML = ''; } }
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
    let colsDirty = false;
    for (const act of acts) {
      const row = document.querySelector('[data-act-row="' + act.pid + '"]');
      if (!row) continue;
      const badge = row.querySelector('.badge');
      const preview = row.querySelector('.preview');
      if (badge) {
        const view = STATUS_VIEW[act.status] || { icon: '⚫', short: act.status || 'unknown' };
        badge.className = 'badge ' + (act.status || 'no_session');
        badge.textContent = view.icon + ' ' + view.short;
        // Backend's verbose statusLabel (e.g. "🛠 Bash: ls -la /tmp/foo") is the
        // hover tooltip — single-char icon stays compact, full label still
        // available without leaving the dashboard.
        if (act.statusLabel) badge.title = act.statusLabel;
        else badge.removeAttribute('title');
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
      const ctxRow = document.querySelector('[data-ctx-for="' + act.pid + '"]');
      if (ctxRow) renderContextRow(ctxRow, act.contextUsage);
      // T6 follow-up: per-instance session cost mini-tag in instance-head
      const costTag = document.querySelector('[data-cost-for="' + act.pid + '"]');
      if (costTag) {
        const costUSD = act.sessionUsage && act.sessionUsage.costUSD;
        if (costUSD != null && costUSD > 0) {
          costTag.hidden = false;
          costTag.textContent = fmtUSD(Number(costUSD));
          const req = act.sessionUsage.requestCount;
          costTag.title = 'session cost' + (req ? ' · ' + req + ' req' : '');
        } else {
          costTag.hidden = true;
          costTag.textContent = '';
          costTag.removeAttribute('title');
        }
      }
      // T11: compactStatus card-level banner. Surface only when the threshold
      // has tripped but backend couldn't auto-inject /compact (ccv has no
      // inject channel), so the user knows to run /compact manually.
      if (act.compactStatus) _compactStatusByPid.set(act.pid, act.compactStatus);
      const compactEl = document.querySelector('[data-compact-for="' + act.pid + '"]');
      if (compactEl) renderCompactAlert(compactEl, act.compactStatus);
      const drawer = document.querySelector('[data-act-drawer="' + act.pid + '"]');
      if (drawer) {
        drawer.dataset.payload = JSON.stringify(act);
        if (drawer.classList.contains('open')) drawer.innerHTML = renderDrawer(act);
      }
      // Track per-pid status; if any group's column needs to change, we
      // re-render once at the end of this tick rather than mutating DOM
      // (preserves details-open state via render()'s existing logic).
      if (act.pid != null) {
        const prev = _statusByPid.get(act.pid);
        if (prev !== act.status) {
          _statusByPid.set(act.pid, act.status);
          colsDirty = true;
        }
      }
    }
    if (colsDirty && _lastListData.items.length) {
      // Recompute column for each cwd; only re-render if assignments differ
      // from what we already painted.
      const cwds = new Map();
      for (const it of _lastListData.items) {
        const key = it.cwd || '';
        if (!cwds.has(key)) cwds.set(key, []);
        cwds.get(key).push(it);
      }
      let needRender = false;
      for (const [cwd, list] of cwds) {
        if (colForGroup({ list }) !== _lastColByCwd.get(cwd)) { needRender = true; break; }
      }
      if (needRender) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
    }
  }

  // ---- T6: per-card context bar (H2) ----
  // Color thresholds match optimization-web.md: 60% warn, 80% hot, 95% bad.
  function ctxClass(pct) {
    if (pct >= 95) return 'bad';
    if (pct >= 80) return 'hot';
    if (pct >= 60) return 'warn';
    return '';
  }
  function renderContextRow(row, ctx) {
    if (!ctx || !ctx.limit) {
      row.hidden = true;
      row.innerHTML = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(ctx.percent) || 0));
    const used = Number(ctx.used || 0);
    const limit = Number(ctx.limit || 0);
    const usedK = used >= 1000 ? (used/1000).toFixed(1) + 'k' : String(used);
    const limitK = limit >= 1000 ? Math.round(limit/1000) + 'k' : String(limit);
    const cls = ctxClass(pct);
    const display = ctx.displayName || ctx.model || '';
    row.hidden = false;
    row.innerHTML =
        '<span class="ctx-model" title="' + escape(display) + '">' + escape(display) + '</span>'
      + '<span class="ctx-bar"><span class="ctx-fill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></span></span>'
      + '<span class="ctx-pct">' + pct.toFixed(0) + '%</span>'
      + '<span>' + usedK + ' / ' + limitK + '</span>';
  }

  // ---- T11: card tabs panel (M1 Run Summary + M3 Recent Edits + Errors) ----
  // Per-pid tab state survives render() re-runs so the active tab + cached
  // payloads aren't lost when refreshActivity triggers a Kanban repaint.
  const _tabState = new Map();
  const _compactStatusByPid = new Map();
  function getTabState(pid) {
    if (!_tabState.has(pid)) _tabState.set(pid, { activeTab: 'urls', cache: {}, fetching: {} });
    return _tabState.get(pid);
  }

  function fmtAbsTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ''; }
  }

  const TAB_LABEL = { urls: 'URLs · QR', summary: 'Summary', edits: 'Edits', errors: 'Errors', threshold: 'Threshold', memory: 'Memory', git: 'Git' };
  const TAB_ENDPOINT = {
    summary: pid => '/api/launcher/instances/' + pid + '/run-summary',
    edits:   pid => '/api/launcher/instances/' + pid + '/recent-edits',
    errors:  pid => '/api/launcher/instances/' + pid + '/errors',
    git:     pid => '/api/launcher/instances/' + pid + '/git-diff',
    memory:  pid => '/api/launcher/instances/' + pid + '/claude-md',
    // 'threshold' has no fetch endpoint — it's a per-cwd form driven by
    // compactStatus from the activity payload and by POSTing to
    // /api/launcher/prefs/compact-threshold on Save.
  };

  function setActiveTab(pid, tab) {
    const st = getTabState(pid);
    st.activeTab = tab;
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    if (!container) return;
    container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabBtn === tab));
    container.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tabPanel !== tab);
    // Threshold tab is a form rendered from cached activity data; render on
    // each activation but don't auto-refresh (avoid overwriting user input).
    if (tab === 'threshold') {
      renderThresholdPanel(pid);
      return;
    }
    // Lazy-load other non-URLs tabs on first activation; subsequent
    // activations show cached content immediately.
    if (tab !== 'urls') {
      const panel = container.querySelector('[data-tab-panel="' + tab + '"]');
      if (st.cache[tab]) {
        if (panel) renderTabPanel(pid, tab, panel, st.cache[tab]);
      } else {
        loadTabData(pid, tab);
      }
    }
  }

  async function loadTabData(pid, tab) {
    const st = getTabState(pid);
    if (st.fetching[tab]) return;
    if (!TAB_ENDPOINT[tab]) return;
    st.fetching[tab] = true;
    const panel = document.querySelector('[data-tab-panel="' + tab + '"][data-pid="' + pid + '"]');
    if (panel && !st.cache[tab]) panel.innerHTML = '<div class="tab-loading">loading…</div>';
    try {
      const data = await api(TAB_ENDPOINT[tab](pid));
      st.cache[tab] = data;
      const stillActive = getTabState(pid).activeTab === tab;
      if (panel && stillActive) renderTabPanel(pid, tab, panel, data);
      updateTabBadges(pid, tab, data);
    } catch (e) {
      if (panel && !st.cache[tab]) panel.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    } finally {
      st.fetching[tab] = false;
    }
  }

  function updateTabBadges(pid, tab, data) {
    const btn = document.querySelector('[data-tabs-for="' + pid + '"] [data-tab-btn="' + tab + '"]');
    if (!btn) return;
    let n = 0;
    if (tab === 'summary') n = data.totalEvents != null ? data.totalEvents : (data.events ? data.events.length : 0);
    else if (tab === 'edits') n = data.totalUniqueTargets != null ? data.totalUniqueTargets : ((data.files || []).length + (data.bash || []).length);
    else if (tab === 'errors') n = data.total != null ? data.total : (data.groups ? data.groups.length : 0);
    else if (tab === 'git') n = (data.files || []).length;
    else if (tab === 'memory') n = (data.files || []).length;
    btn.innerHTML = escape(TAB_LABEL[tab]) + (n ? ' <span class="tab-count">' + n + '</span>' : '');
    if (tab === 'errors') btn.classList.toggle('has-error', n > 0);
  }

  function renderTabPanel(pid, tab, panel, data) {
    if (tab === 'summary')     panel.innerHTML = renderRunSummaryHTML(data);
    else if (tab === 'edits')  panel.innerHTML = renderRecentEditsHTML(data);
    else if (tab === 'errors') panel.innerHTML = renderErrorsHTML(data);
    else if (tab === 'git')    panel.innerHTML = renderGitHTML(pid, data);
    else if (tab === 'memory') panel.innerHTML = renderMemoryHTML(pid, data);
  }

  const EVENT_ICON = {
    prompt:        '✎',
    slash_command: '/',
    auto_compact:  '⇣',
    tool_error:    '⚠',
    subagent:      '⌬',
    hook_event:    '⚙',
  };

  function renderRunSummaryHTML(d) {
    const t = d.totals || {};
    const totalsHtml = ''
      + '<div class="run-totals">'
      +   '<span class="rt-chip">' + (t.prompts || 0) + ' prompts</span>'
      +   '<span class="rt-chip">' + (t.tools || 0) + ' tools</span>'
      +   (t.slash_commands ? '<span class="rt-chip">' + t.slash_commands + ' /cmds</span>' : '')
      +   (t.compacts ? '<span class="rt-chip">' + t.compacts + ' compact</span>' : '')
      +   (t.subagents ? '<span class="rt-chip">' + t.subagents + ' subagent</span>' : '')
      +   (t.errors ? '<span class="rt-chip err">' + t.errors + ' errors</span>' : '')
      +   (t.hooks ? '<span class="rt-chip">' + t.hooks + ' hooks</span>' : '')
      + '</div>';
    const events = (d.events || []).slice().reverse(); // newest first
    if (!events.length) return totalsHtml + '<div class="tab-empty">no events yet</div>';
    const rows = events.map(ev => {
      const icon = EVENT_ICON[ev.type] || '·';
      const lineHint = ev.jsonlLine ? 'jsonl line ' + ev.jsonlLine : '';
      return '<div class="run-event-row t-' + escape(ev.type || '') + '"' + (lineHint ? ' title="' + lineHint + '"' : '') + '>'
        + '<span class="re-ts">' + escape(fmtAbsTime(ev.ts)) + '</span>'
        + '<span class="re-icon">' + escape(icon) + '</span>'
        + '<span class="re-label">' + escape(ev.label || ev.type || '') + '</span>'
        + '</div>';
    }).join('');
    return totalsHtml + rows;
  }

  function renderRecentEditsHTML(d) {
    const files = d.files || [];
    const bash = d.bash || [];
    if (!files.length && !bash.length) return '<div class="tab-empty">no recent edits or commands</div>';
    const renderItem = (it, defaultTool) => ''
      + '<div class="edit-row">'
      +   '<div class="er-line1">'
      +     '<span class="er-tool">' + escape(it.tool || defaultTool || '') + '</span>'
      +     '<span class="er-path" title="' + escape(it.path || '') + '">' + escape(it.path || '') + '</span>'
      +     '<span class="er-meta">×' + (it.count || 0) + (it.lastTs ? ' · ' + fmtAge(it.lastTs) + ' ago' : '') + '</span>'
      +   '</div>'
      +   (it.lastDiffPreview ? '<div class="er-preview">' + escape(it.lastDiffPreview) + '</div>' : '')
      + '</div>';
    let html = '';
    if (files.length) {
      html += '<div class="edits-section"><div class="es-hd">Files (' + files.length + ')</div>';
      html += files.map(f => renderItem(f, 'Edit')).join('');
      html += '</div>';
    }
    if (bash.length) {
      html += '<div class="edits-section"><div class="es-hd">Bash (' + bash.length + ')</div>';
      html += bash.map(b => renderItem(b, 'Bash')).join('');
      html += '</div>';
    }
    return html;
  }

  function renderErrorsHTML(d) {
    const groups = d.groups || [];
    if (!groups.length) return '<div class="tab-empty">no errors</div>';
    return groups.map((g, i) => {
      const samples = (g.samples || []).map(s => ''
        + '<div class="err-sample">'
        +   (s.ts ? '<span class="es-ts">' + escape(fmtAbsTime(s.ts)) + '</span>' : '')
        +   escape(s.fullMessage || '')
        + '</div>'
      ).join('');
      return ''
        + '<div class="err-group" data-err-group="' + i + '">'
        +   '<div class="eg-hd" title="click to toggle samples">'
        +     '<span class="eg-tool">' + escape(g.toolName || '?') + '</span>'
        +     '<span class="eg-pattern">' + escape(g.errorPattern || '') + '</span>'
        +     '<span class="eg-count">×' + (g.count || 0) + (g.lastTs ? ' · ' + fmtAge(g.lastTs) + ' ago' : '') + '</span>'
        +   '</div>'
        +   '<div class="eg-samples">' + samples + '</div>'
        + '</div>';
    }).join('');
  }

  function renderGitHTML(pid, d) {
    const stat = d.stat || { additions: 0, deletions: 0, files: 0 };
    const wt = d.worktree || {};
    const files = d.files || [];
    const ahead = d.ahead || 0;
    const head = ''
      + '<div class="git-summary">'
      +   '<span class="g-branch" title="base: ' + escape(wt.baseRef || '') + '">🌿 ' + escape(wt.branch || '?') + '</span>'
      +   '<span class="g-stat-add">+' + stat.additions + '</span>'
      +   '<span class="g-stat-del">-' + stat.deletions + '</span>'
      +   '<span class="g-stat-files">in ' + stat.files + ' file' + (stat.files === 1 ? '' : 's') + '</span>'
      +   (ahead ? '<span class="g-ahead">· ' + ahead + ' ahead of origin</span>' : '<span class="g-ahead g-muted">· in sync with origin</span>')
      + '</div>';
    const fileRows = files.length
      ? '<div class="git-files">' + files.map(f => ''
          + '<div class="g-file' + (f.untracked ? ' g-untracked' : '') + '">'
          +   '<span class="g-path" title="' + escape(f.path || '') + '">' + escape(f.path || '') + (f.untracked ? ' <span class="g-tag-new">new</span>' : '') + '</span>'
          +   '<span class="g-loc">+' + (f.additions || 0) + ' -' + (f.deletions || 0) + '</span>'
          + '</div>'
        ).join('') + '</div>'
      : '<div class="tab-empty">working tree clean' + (ahead ? ' · ' + ahead + ' commit' + (ahead === 1 ? '' : 's') + ' ready to push' : '') + '</div>';
    const actions = ''
      + '<div class="git-actions">'
      +   '<button class="btn primary" data-act="git-commit" data-pid="' + pid + '"' + (files.length ? '' : ' disabled') + '>Commit</button>'
      +   '<button class="btn" data-act="git-push" data-pid="' + pid + '"' + (ahead || files.length ? '' : ' disabled title="nothing to push"') + '>Push</button>'
      +   '<button class="btn" data-act="git-pr" data-pid="' + pid + '">Open PR</button>'
      + '</div>';
    return head + fileRows + actions;
  }

  // Memory tab: groups CLAUDE.md scan results by scope, each row expandable
  // into an inline editor. Loaded lazily from /api/launcher/instances/:pid/claude-md.
  const SCOPE_LABEL = { project: '本项目', parent: '父目录链', global: '全局', rule: 'Rules' };
  function renderMemoryHTML(pid, d) {
    const files = (d && d.files) || [];
    if (!files.length) return '<div class="tab-empty">no CLAUDE.md found on this cwd / global</div>';
    const groups = { project: [], parent: [], global: [], rule: [] };
    for (const f of files) (groups[f.scope] || (groups[f.scope] = [])).push(f);
    let html = '';
    for (const scope of ['project', 'parent', 'global', 'rule']) {
      const arr = groups[scope] || [];
      if (!arr.length) continue;
      html += '<div class="mem-group">';
      html += '<div class="mg-hd">' + escape(SCOPE_LABEL[scope] || scope) + ' (' + arr.length + ')</div>';
      for (const f of arr) {
        const sizeKB = (f.size / 1024).toFixed(1);
        const ago = f.mtime ? fmtAge(f.mtime) + ' ago' : '';
        html += ''
          + '<div class="mem-row" data-mem-path="' + escape(f.path) + '">'
          +   '<div class="mr-hd" data-act="mem-open">'
          +     '<span class="mr-path" title="' + escape(f.path) + '">' + escape(f.path.replace(/^.*\//, '')) + '</span>'
          +     '<span class="mr-dir" title="' + escape(f.path) + '">' + escape(dirnameJs(f.path)) + '</span>'
          +     '<span class="mr-meta">' + sizeKB + ' KB · ' + escape(ago) + '</span>'
          +   '</div>'
          +   '<div class="mr-body" hidden></div>'
          + '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  // dirname() shim — no node:path in browser. Splits to last "/".
  function dirnameJs(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function renderCompactAlert(el, status) {
    if (!status || !status.enabled) { el.hidden = true; el.innerHTML = ''; return; }
    // Only surface the manual-/compact nudge when the threshold tripped AND
    // backend couldn't auto-inject. Other states stay silent.
    if (status.lastResult === 'skipped' && status.reason === 'no_inject_channel') {
      const ago = status.lastTriggeredAt ? ' (' + fmtAge(status.lastTriggeredAt) + ' ago)' : '';
      const threshold = status.auto_compact_at ? fmtTokensK(status.auto_compact_at) : '?';
      el.hidden = false;
      el.innerHTML = ''
        + '<span class="ca-icon">⚠</span>'
        + '<div>context window 超过阈值 <span class="ca-cmd">' + escape(threshold) + ' tok</span>，'
        +   'ccv 暂无 inject 通道无法自动注入。请在该 session 内手动运行 <span class="ca-cmd">/compact</span>'
        +   escape(ago) + '。</div>';
      return;
    }
    el.hidden = true;
    el.innerHTML = '';
  }

  // ---- T11 follow-up: Compact Threshold form (per-cwd config) ----
  // Reads compactStatus from _compactStatusByPid (populated by refreshActivity)
  // and POSTs to /api/launcher/prefs/compact-threshold on Save. Doesn't poll —
  // user input would get clobbered. Form re-renders on each tab activation +
  // after a successful save.
  const DEFAULT_AUTO_COMPACT = 110000;
  const DEFAULT_AUTO_CLEAR = 140000;
  function renderThresholdPanel(pid) {
    const panel = document.querySelector('[data-tab-panel="threshold"][data-pid="' + pid + '"]');
    if (!panel) return;
    const cwd = panel.dataset.cwd || '';
    const cs = _compactStatusByPid.get(Number(pid)) || _compactStatusByPid.get(pid) || {};
    panel.innerHTML = renderThresholdHTML(pid, cwd, cs);
  }
  function renderThresholdHTML(pid, cwd, cs) {
    const enabled = !!cs.enabled;
    const ac = cs.auto_compact_at || DEFAULT_AUTO_COMPACT;
    const cle = cs.auto_clear_at || DEFAULT_AUTO_CLEAR;
    const ago = cs.lastTriggeredAt ? fmtAge(cs.lastTriggeredAt) + ' ago' : 'never';
    const cooldownRemainSec = cs.cooldownUntil && cs.cooldownUntil > Date.now()
      ? Math.ceil((cs.cooldownUntil - Date.now()) / 1000) : 0;
    const noInject = cs.lastResult === 'skipped' && cs.reason === 'no_inject_channel';
    const meta = ''
      + '<div class="th-meta">'
      +   '<div>last trigger: ' + escape(ago) + (cs.lastResult ? ' · result: ' + escape(cs.lastResult) : '') + '</div>'
      +   (cooldownRemainSec > 0 ? '<div>cooling down: ' + cooldownRemainSec + 's</div>' : '')
      +   (noInject ? '<div class="th-warn">⚠ ccv 暂无 inject 通道；context 超阈值时仍需手动 /compact</div>' : '')
      + '</div>';
    return ''
      + '<div class="th-form" data-pid="' + pid + '" data-cwd="' + escape(cwd) + '">'
      +   '<label class="th-row">'
      +     '<input type="checkbox" data-th-field="enabled"' + (enabled ? ' checked' : '') + '>'
      +     '<span>enable auto-threshold monitoring</span>'
      +   '</label>'
      +   '<label class="th-row col">'
      +     '<span>auto_compact_at <span class="th-help">(tokens — trigger /compact when context exceeds)</span></span>'
      +     '<input type="number" data-th-field="auto_compact_at" min="1" step="1000" value="' + ac + '">'
      +   '</label>'
      +   '<label class="th-row col">'
      +     '<span>auto_clear_at <span class="th-help">(tokens — trigger /clear when context exceeds; must be > auto_compact_at)</span></span>'
      +     '<input type="number" data-th-field="auto_clear_at" min="1" step="1000" value="' + cle + '">'
      +   '</label>'
      +   meta
      +   '<div class="th-row" style="justify-content:flex-end">'
      +     '<span class="th-err" data-th-err hidden></span>'
      +     '<button class="btn primary" data-th-save data-pid="' + pid + '">Save</button>'
      +   '</div>'
      + '</div>';
  }
  async function handleSaveThreshold(pid) {
    const form = document.querySelector('.th-form[data-pid="' + pid + '"]');
    if (!form) return;
    const cwd = form.dataset.cwd || '';
    const enabledEl = form.querySelector('[data-th-field="enabled"]');
    const acEl  = form.querySelector('[data-th-field="auto_compact_at"]');
    const cleEl = form.querySelector('[data-th-field="auto_clear_at"]');
    const errEl = form.querySelector('[data-th-err]');
    const showErr = (msg) => { if (errEl) { errEl.hidden = false; errEl.textContent = msg; } };
    const hideErr = () => { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } };
    // Frontend completeness check — backend was observed silently accepting
    // partial bodies in an earlier tester run; this guards against that and
    // gives the user immediate feedback either way.
    if (!cwd) { showErr('cwd missing on form'); return; }
    const enabled = !!(enabledEl && enabledEl.checked);
    const ac = acEl ? parseInt(acEl.value, 10) : NaN;
    const cle = cleEl ? parseInt(cleEl.value, 10) : NaN;
    if (!Number.isFinite(ac) || ac <= 0) { showErr('auto_compact_at must be a positive integer'); return; }
    if (!Number.isFinite(cle) || cle <= 0) { showErr('auto_clear_at must be a positive integer'); return; }
    if (cle <= ac) { showErr('auto_clear_at must be greater than auto_compact_at'); return; }
    hideErr();
    const saveBtn = form.querySelector('[data-th-save]');
    const prevLabel = saveBtn ? saveBtn.textContent : 'Save';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      const data = await api('/api/launcher/prefs/compact-threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, enabled, auto_compact_at: ac, auto_clear_at: cle }),
      });
      // Merge the response into the cached status so the form (and any later
      // tab re-render) reflects the saved values immediately, without waiting
      // for the next activity tick to push them.
      const prev = _compactStatusByPid.get(Number(pid)) || {};
      const merged = Object.assign({}, prev, data && data.threshold ? data.threshold : { enabled, auto_compact_at: ac, auto_clear_at: cle });
      _compactStatusByPid.set(Number(pid), merged);
      renderThresholdPanel(pid);
      // The re-render swaps out the save button; re-query and show a brief
      // success cue on the new instance.
      const newBtn = document.querySelector('.th-form[data-pid="' + pid + '"] [data-th-save]');
      if (newBtn) {
        newBtn.disabled = true;
        newBtn.textContent = 'Saved ✓';
        setTimeout(() => { newBtn.disabled = false; newBtn.textContent = 'Save'; }, 1400);
      }
    } catch (e) {
      showErr('save failed: ' + e.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevLabel; }
    }
  }

  // Re-apply persisted tab state after a full re-render (called from render()
  // after innerHTML write + details-open restoration).
  function rehydrateTabs() {
    listEl.querySelectorAll('[data-tabs-for]').forEach(container => {
      const pid = Number(container.dataset.tabsFor);
      const st = _tabState.get(pid);
      if (!st) return;
      if (st.activeTab && st.activeTab !== 'urls') {
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabBtn === st.activeTab));
        container.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tabPanel !== st.activeTab);
      }
      for (const t of ['summary', 'edits', 'errors', 'git', 'memory']) {
        if (!st.cache[t]) continue;
        const panel = container.querySelector('[data-tab-panel="' + t + '"]');
        if (panel) renderTabPanel(pid, t, panel, st.cache[t]);
        updateTabBadges(pid, t, st.cache[t]);
      }
      // Threshold panel: no cache, but if it's the active tab we need to
      // re-render the form (the new DOM defaults to the empty placeholder).
      if (st.activeTab === 'threshold') renderThresholdPanel(pid);
    });
  }

  // Tab click + err-group expand + Threshold Save delegation (separate from
  // the action-data delegate so it doesn't slow that path with extra
  // closest() walks).
  listEl.addEventListener('click', (ev) => {
    const tabBtn = ev.target.closest('[data-tab-btn]');
    if (tabBtn) {
      ev.preventDefault();
      const pid = Number(tabBtn.dataset.pid);
      setActiveTab(pid, tabBtn.dataset.tabBtn);
      return;
    }
    const saveBtn = ev.target.closest('[data-th-save]');
    if (saveBtn) {
      ev.preventDefault();
      handleSaveThreshold(saveBtn.dataset.pid);
      return;
    }
    const errHd = ev.target.closest('.err-group .eg-hd');
    if (errHd) {
      ev.preventDefault();
      errHd.parentElement.classList.toggle('open');
    }
  });

  // Auto-refresh active non-URLs tab while its details is open. 5s matches
  // the backend per-instance scan cache, so polling is cheap.
  function refreshOpenTabs() {
    listEl.querySelectorAll('details[open]').forEach(d => {
      const container = d.querySelector('[data-tabs-for]');
      if (!container) return;
      const pid = Number(container.dataset.tabsFor);
      const st = _tabState.get(pid);
      if (!st || st.activeTab === 'urls') return;
      loadTabData(pid, st.activeTab);
    });
  }
  visibilityPoll(refreshOpenTabs, 5000);

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
  document.getElementById('btn-new').onclick = () => {
    errEl.hidden = true;
    loadDir(_curDir || '');
    loadCcuseProfiles();
    // Pre-fill useWorktree from prefs.worktreeDefault so power users who
    // always want a fresh branch get one without an extra click. Falls back
    // to unchecked on prefs load error.
    const wt = document.getElementById('use-worktree');
    if (wt) {
      api('/api/launcher/prefs').then(p => { wt.checked = !!p.worktreeDefault; }).catch(() => { wt.checked = false; });
    }
    dlg.showModal();
  };
  document.getElementById('btn-cancel').onclick = () => dlg.close();
  document.getElementById('btn-launch').onclick = async () => {
    errEl.hidden = true;
    const cwd = cwdInput.value.trim();
    if (!cwd) { errEl.textContent='Pick a directory first'; errEl.hidden=false; return; }
    const btn = document.getElementById('btn-launch');
    const ccuseSelect = document.getElementById('ccuse-select');
    const ccuseProfile = ccuseSelect ? ccuseSelect.value : '';
    const wtEl = document.getElementById('use-worktree');
    const useWorktree = !!(wtEl && wtEl.checked);
    btn.disabled = true; btn.textContent = useWorktree ? 'Creating worktree…' : 'Launching…';
    try {
      await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, ccuseProfile, useWorktree }) });
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

  // ---- T6: top bar stats (H1 cost + H3 5h quota) ----
  const COST_RANGES = ['today', 'week', 'month'];
  const _byRange = { today: null, week: null, month: null };
  let _activeRange = 'today';
  function fmtUSD(n) {
    if (n == null || isNaN(n)) return '—';
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1)    return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }
  function fmtMinutes(min) {
    if (min == null || min <= 0) return '';
    const total = Math.round(min);
    const h = Math.floor(total/60), m = total % 60;
    if (h >= 24) return Math.floor(h/24) + 'd';
    if (h > 0)   return h + 'h' + (m ? ' ' + m + 'm' : '');
    return m + 'm';
  }
  function fmtTokensK(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }

  function paintCostBlock() {
    const stat = document.getElementById('stat-cost');
    if (!stat) return;
    let anyData = false;
    let anyStale = false;
    for (const r of COST_RANGES) {
      const slot = stat.querySelector('.cost-slot[data-range="' + r + '"] .cost-val');
      if (!slot) continue;
      const data = _byRange[r];
      if (!data) {
        slot.textContent = '—';
        continue;
      }
      // pending=true → backend cold-miss; aggregation in flight. Show "…"
      // instead of a misleading $0 — the next 10s poll picks up the real
      // result once the background scan completes.
      if (data.pending) {
        slot.textContent = '…';
        continue;
      }
      anyData = true;
      slot.textContent = fmtUSD(Number(data.totalUSD || 0));
      if (data.stale) anyStale = true;
    }
    stat.classList.toggle('is-loading', !anyData);
    stat.classList.toggle('is-stale', anyStale);
  }

  function showBreakdown(range) {
    const data = _byRange[range];
    const list = document.getElementById('cp-list');
    document.getElementById('cp-range').textContent = range;
    if (!list) return;
    if (!data) {
      list.innerHTML = '<div class="cp-empty">loading…</div>';
      return;
    }
    if (data.pending) {
      list.innerHTML = '<div class="cp-empty">scanning ' + escape(range) + ' (first load can take a few seconds)…</div>';
      return;
    }
    const breakdown = data.byModelUSD || {};
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      list.innerHTML = '<div class="cp-empty">No usage in this range yet.</div>';
      return;
    }
    const rows = entries.map(([m, v]) =>
      '<div class="cp-row"><span class="cp-model" title="' + escape(m) + '">' + escape(m) + '</span><span class="cp-val">' + fmtUSD(v) + '</span></div>'
    ).join('');
    const total = Number(data.totalUSD || 0);
    const totalRow = '<div class="cp-row cp-total"><span class="cp-model">Total · ' + (data.requestCount || 0) + ' req</span><span class="cp-val">' + fmtUSD(total) + '</span></div>';
    list.innerHTML = rows + totalRow;
  }

  // Fetch all three ranges in parallel; backend caches each for 60s so polling
  // every 10s is cheap. Failures on individual ranges leave that slot showing
  // its previous value (or "—" on first miss).
  async function refreshUsage() {
    const results = await Promise.allSettled(
      COST_RANGES.map(r => api('/api/launcher/usage/summary?range=' + r))
    );
    COST_RANGES.forEach((r, i) => {
      if (results[i].status === 'fulfilled') _byRange[r] = results[i].value;
    });
    paintCostBlock();
    showBreakdown(_activeRange);
  }

  async function refreshQuota() {
    const el = document.getElementById('stat-quota');
    if (!el) return;
    const valEl = document.getElementById('stat-quota-val');
    const fillEl = document.getElementById('stat-quota-fill');
    const srcTag = document.getElementById('stat-quota-src');
    try {
      const q = await api('/api/launcher/quota/5h');
      el.classList.remove('is-loading');
      el.classList.toggle('is-stale', !!q.stale);
      el.classList.remove('unavailable');

      if (q.source === 'unavailable') {
        el.classList.add('unavailable');
        valEl.textContent = '数据暂不可用';
        fillEl.style.width = '0%';
        fillEl.className = 'quota-fill';
        srcTag.hidden = true;
        el.title = '5h quota 数据暂不可用\\n' + (q.reason || 'install ccline or wait for usage data');
        return;
      }

      // Color thresholds (T6 spec): <50 green, 50-79 yellow, ≥80 red.
      const pct = Math.max(0, Math.min(100, Number(q.percent || 0)));
      fillEl.style.width = pct.toFixed(1) + '%';
      fillEl.className = 'quota-fill' + (pct >= 80 ? ' bad' : pct >= 50 ? ' warn' : '');

      let valText;
      if (q.used != null && q.limit != null) {
        valText = pct.toFixed(0) + '%  ' + fmtTokensK(q.used) + '/' + fmtTokensK(q.limit);
      } else {
        valText = pct.toFixed(0) + '%';
      }
      valEl.textContent = valText;

      if (q.source === 'jsonl_compute') {
        srcTag.hidden = false;
        srcTag.className = 'src-tag computed';
        srcTag.textContent = '⚠';
        srcTag.title = '推算（基于本地 jsonl，可能不精确）';
      } else {
        srcTag.hidden = true;
        srcTag.removeAttribute('title');
      }

      // Always render the full field set so the user sees the schema; missing
      // values (common for ccline_cache, which omits plan/burn/projection)
      // fall back to "—" instead of being silently skipped.
      const dash = '—';
      const tip = ['source: ' + (q.source || dash)];
      tip.push('plan: ' + (q.plan_name || dash));
      tip.push('burn: ' + (q.burn_rate ? Math.round(q.burn_rate) + ' tok/min' : dash));
      tip.push('to limit: ' + (q.projection_minutes ? fmtMinutes(q.projection_minutes) : dash));
      if (q.reset_at) {
        const remain = (new Date(q.reset_at).getTime() - Date.now()) / 60000;
        tip.push('reset in: ' + (remain > 0 ? fmtMinutes(remain) : dash));
      } else {
        tip.push('reset in: ' + dash);
      }
      el.title = tip.join('\\n');
    } catch {
      el.classList.add('is-loading');
    }
  }

  function refreshTopStats() { refreshUsage(); refreshQuota(); }

  // Hover any slot → preview that range's breakdown in the popover. On
  // mouseleave, fall back to the active range (matters on narrow screens
  // where only one slot is visible).
  const costMultiEl = document.getElementById('cost-multi');
  const statCostEl = document.getElementById('stat-cost');
  if (costMultiEl) {
    costMultiEl.addEventListener('mouseover', (e) => {
      const slot = e.target.closest('.cost-slot');
      if (!slot) return;
      showBreakdown(slot.dataset.range);
    });
  }
  if (statCostEl) {
    statCostEl.addEventListener('mouseleave', () => showBreakdown(_activeRange));
  }
  // Narrow-screen tap-cycle: when only one slot is visible, tapping the
  // multi-row advances _activeRange. body[data-active-range] drives the CSS.
  const NARROW_MQ = window.matchMedia('(max-width: 640px)');
  function setActiveRange(r) {
    _activeRange = r;
    document.body.dataset.activeRange = r;
    showBreakdown(r);
  }
  setActiveRange('today');
  if (costMultiEl) {
    costMultiEl.addEventListener('click', () => {
      if (!NARROW_MQ.matches) return; // wide screens: clicks are no-op
      const idx = COST_RANGES.indexOf(_activeRange);
      setActiveRange(COST_RANGES[(idx + 1) % COST_RANGES.length]);
    });
  }

  refreshTopStats();
  visibilityPoll(refreshTopStats, 10000);

  // ---- T8: tags + filter + keyboard shortcuts ----
  async function loadPrefs() {
    try {
      const data = await api('/api/launcher/prefs');
      _tagsByCwd = (data && data.tags) || {};
      _allTags = Array.isArray(data && data.allTags) ? data.allTags : [];
      // Repaint groups so tag chips reflect the loaded state.
      if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
    } catch { /* graceful: tags stay empty */ }
  }

  function applyTagFilter() {
    const tokens = _filterText.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    const groups = listEl.querySelectorAll('.group[data-group-cwd]');
    groups.forEach(g => {
      const cwd = g.dataset.groupCwd || '';
      const tags = (_tagsByCwd[cwd] || []).map(t => t.toLowerCase());
      const matches = tokens.length === 0 || tokens.every(tok => tags.some(t => t.includes(tok)));
      if (matches) g.removeAttribute('data-filter-hidden');
      else g.setAttribute('data-filter-hidden', '');
    });
    // Recount visible groups per Kanban column
    document.querySelectorAll('.kanban-col').forEach(col => {
      const body = col.querySelector('.kanban-body');
      if (!body) return;
      const visible = body.querySelectorAll('.group:not([data-filter-hidden])').length;
      const countEl = col.querySelector('.col-count');
      if (countEl) countEl.textContent = visible;
    });
  }

  const tagFilterEl = document.getElementById('tag-filter');
  if (tagFilterEl) {
    tagFilterEl.addEventListener('input', () => {
      _filterText = tagFilterEl.value || '';
      applyTagFilter();
    });
  }

  // j/n: scroll the next waiting_ask instance into view, briefly flash it.
  // Cycles through all visible (filter-respecting) waiting cards.
  function jumpToNextWaiting() {
    const candidates = [...listEl.querySelectorAll('.instance[data-pid]')].filter(el => {
      // skip filter-hidden groups (offsetParent === null when display:none)
      if (el.offsetParent === null) return false;
      const pid = Number(el.dataset.pid);
      return _statusByPid.get(pid) === 'waiting_ask';
    });
    if (!candidates.length) return false;
    _jumpIdx = (_jumpIdx + 1) % candidates.length;
    const target = candidates[_jumpIdx];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    // force reflow so the animation restarts on repeat presses
    void target.offsetWidth;
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
    return true;
  }

  const helpDlg = document.getElementById('help-dlg');
  document.getElementById('btn-help').addEventListener('click', () => helpDlg.showModal());
  document.getElementById('help-close').addEventListener('click', () => helpDlg.close());

  // ---- M2: worktrees top-bar counter + cleanup dialog ----
  const wtBtn = document.getElementById('btn-wt');
  const wtCountEl = document.getElementById('btn-wt-count');
  const wtDlg = document.getElementById('wt-dlg');
  const wtListEl = document.getElementById('wt-list');
  async function refreshWorktreeCounter() {
    try {
      const data = await api('/api/launcher/worktrees');
      const n = (data.worktrees || []).length;
      if (wtCountEl) wtCountEl.textContent = String(n);
      if (wtBtn) wtBtn.hidden = n === 0;
    } catch { /* ignore — keep last known count */ }
  }
  async function openWorktreeDlg() {
    if (!wtDlg) return;
    wtListEl.innerHTML = '<div class="tab-empty">loading…</div>';
    wtDlg.showModal();
    try {
      const data = await api('/api/launcher/worktrees');
      const list = data.worktrees || [];
      if (!list.length) { wtListEl.innerHTML = '<div class="tab-empty">no worktrees</div>'; return; }
      wtListEl.innerHTML = list.map((w, i) => {
        const statusCls = w.alive ? 'alive' : (w.hasUncommitted || w.ahead ? 'dirty' : '');
        const statusTxt = w.alive ? 'alive (pid ' + w.pid + ')' : (w.exists ? 'orphan' : 'missing');
        const dirty = w.hasUncommitted ? '✎' : '';
        const ahead = w.ahead ? ' +' + w.ahead : '';
        return ''
          + '<label class="wt-row">'
          +   '<input type="checkbox" data-wt-path="' + escape(w.path) + '"' + (w.alive ? ' disabled title="stop the instance first"' : '') + '>'
          +   '<span class="wt-branch">' + escape(w.branch || '?') + '</span>'
          +   '<span class="wt-path" title="' + escape(w.path) + '">' + escape(w.path) + '</span>'
          +   '<span class="wt-status ' + statusCls + '">' + escape(statusTxt + ' ' + dirty + ahead) + '</span>'
          + '</label>';
      }).join('');
    } catch (e) {
      wtListEl.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    }
  }
  if (wtBtn) wtBtn.addEventListener('click', openWorktreeDlg);
  if (wtDlg) {
    document.getElementById('wt-close').addEventListener('click', () => wtDlg.close());
    document.getElementById('wt-cleanup').addEventListener('click', async () => {
      const boxes = wtListEl.querySelectorAll('input[type=checkbox][data-wt-path]:checked');
      const paths = Array.from(boxes).map(b => b.dataset.wtPath);
      if (!paths.length) { alert('select at least one worktree'); return; }
      const force = !!document.getElementById('wt-force').checked;
      if (force && !confirm('Force delete ' + paths.length + ' worktree(s)? Uncommitted / unpushed work will be lost.')) return;
      try {
        const r = await api('/api/launcher/worktrees/cleanup', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ paths, force }),
        });
        const msg = ['removed ' + (r.removed || []).length + ' worktree(s)'];
        if ((r.rejected || []).length) msg.push('rejected:\n' + r.rejected.map(x => '  ' + x.path + ' — ' + x.reason).join('\n'));
        if (r.needsConfirm) msg.push('\ntip: check "force" to override the safety gate');
        alert(msg.join('\n'));
        await openWorktreeDlg();
        refreshWorktreeCounter();
        refresh();
      } catch (e) { alert('Cleanup failed: ' + e.message); }
    });
  }
  visibilityPoll(refreshWorktreeCounter, 10000);
  refreshWorktreeCounter();

  // ---- M4: global Memory drawer (aggregated CLAUDE.md across all instances) ----
  const memDrawer = document.getElementById('mem-drawer');
  const memDrawerBody = document.getElementById('mem-drawer-body');
  const memBtn = document.getElementById('btn-mem');
  document.getElementById('mem-drawer-close').addEventListener('click', () => memDrawer.classList.remove('open'));
  if (memBtn) memBtn.addEventListener('click', async () => {
    if (memDrawer.classList.contains('open')) { memDrawer.classList.remove('open'); return; }
    memDrawer.classList.add('open');
    memDrawerBody.textContent = 'loading…';
    try {
      const data = await api('/api/launcher/claude-md/all');
      const files = data.files || [];
      if (!files.length) { memDrawerBody.textContent = 'no CLAUDE.md across running instances'; return; }
      const grouped = { project: [], parent: [], global: [], rule: [] };
      for (const f of files) (grouped[f.scope] || (grouped[f.scope] = [])).push(f);
      let html = '';
      for (const scope of ['project', 'parent', 'global', 'rule']) {
        for (const f of grouped[scope] || []) {
          const pids = (f.pids || []).slice(0, 3).join(',') + ((f.pids || []).length > 3 ? '+' : '');
          html += '<div class="md-row">'
            + '<span class="md-scope">' + escape(scope) + '</span>'
            + '<span class="md-path" title="' + escape(f.path) + '">' + escape(f.path) + '</span>'
            + '<span class="md-pids">pids:' + escape(pids) + '</span>'
            + '</div>';
        }
      }
      memDrawerBody.innerHTML = html || '<div>(empty)</div>';
    } catch (e) {
      memDrawerBody.textContent = 'failed: ' + e.message;
    }
  });
  // Close drawer on outside click. ignore clicks on the toggle itself.
  document.addEventListener('click', (ev) => {
    if (!memDrawer.classList.contains('open')) return;
    if (memDrawer.contains(ev.target)) return;
    if (memBtn && memBtn.contains(ev.target)) return;
    memDrawer.classList.remove('open');
  });

  // Single global keydown listener — bails out when typing or when a
  // modal/overlay owns the keyboard. Other ESC handlers (term-overlay /
  // ccv-overlay) stay independent so they keep working when this one no-ops.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && helpDlg.open) {
      helpDlg.close();
      ev.preventDefault();
      return;
    }
    const tag = (ev.target && ev.target.tagName || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea' || (ev.target && ev.target.isContentEditable);
    if (isTyping) return;
    if (dlg.open || helpDlg.open) return;
    if (termOverlay.classList.contains('open') || ccvOverlay.classList.contains('open')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.key === 'j' || ev.key === 'n') {
      ev.preventDefault();
      jumpToNextWaiting();
    } else if (ev.key === '/') {
      ev.preventDefault();
      if (tagFilterEl) { tagFilterEl.focus(); tagFilterEl.select(); }
    } else if (ev.key === '?') {
      ev.preventDefault();
      helpDlg.showModal();
    }
  });

  loadPrefs();
  // tags only change via user mutation in this UI; no polling needed.

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
    // the frontend can render them without an extra round-trip. Also surface
    // the worktree info (path / branch / baseRef / originalCwd) when this pid
    // was spawned via useWorktree=true so the UI can show the Git tab + branch
    // chip without an extra round-trip.
    const enrichedRunning = running.map(i => ({
      ...i,
      alias: getAlias(i.cwd),
      ccuseProfile: getCcuseProfile(i.cwd),
      worktree: worktreeForPid(i.pid),
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
      const { cwd, force, ccuseProfile, useWorktree, branchName } = JSON.parse(raw || '{}');
      // If client passes a profile, persist it as this cwd's preferred profile
      // so future spawns default to it without explicit selection.
      if (typeof ccuseProfile === 'string' && cwd) {
        setCcuseProfile(cwd, ccuseProfile);
      }
      const entry = await serializeSpawn(() => doSpawn(cwd, {
        force: !!force,
        ccuseProfile: ccuseProfile || '',
        useWorktree: !!useWorktree,
        branchName: typeof branchName === 'string' ? branchName : '',
      }));
      sendJson(res, 200, { ok: true, instance: entry, worktree: entry && entry.pid ? worktreeForPid(entry.pid) : null });
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
      if (!body.cwd || typeof body.cwd !== 'string') {
        throw new Error('cwd required');
      }
      // Strict shape: reject bodies missing any of the three schema fields
      // so a typo like `{cwd, threshold: 75}` no longer silently coerces to
      // disabled/zeroed and gets pruned. UI sends a full snapshot anyway.
      const hasAc = Object.prototype.hasOwnProperty.call(body, 'auto_compact_at');
      const hasCl = Object.prototype.hasOwnProperty.call(body, 'auto_clear_at');
      const hasEn = Object.prototype.hasOwnProperty.call(body, 'enabled');
      if (!hasAc || !hasCl || !hasEn) {
        const missing = [
          !hasAc && 'auto_compact_at',
          !hasCl && 'auto_clear_at',
          !hasEn && 'enabled',
        ].filter(Boolean);
        throw new Error('missing required field(s): ' + missing.join(', '));
      }
      const ac = Number(body.auto_compact_at);
      const cl = Number(body.auto_clear_at);
      if (!Number.isFinite(ac) || ac < 0) throw new Error('auto_compact_at must be a non-negative number');
      if (!Number.isFinite(cl) || cl < 0) throw new Error('auto_clear_at must be a non-negative number');
      if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      setCompactThreshold(body.cwd, {
        auto_compact_at: ac,
        auto_clear_at: cl,
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

  // ---- M2 commit 3: worktree dashboard + cleanup ----
  // /worktrees enumerates every tracked worktree (live pid OR orphaned by
  // child exit), augmented with per-worktree porcelain + ahead so the UI can
  // gate cleanup on a clean tree. /worktrees/cleanup removes them via
  // `git worktree remove`; refuses dirty trees unless `force:true`.
  if (url === '/api/launcher/worktrees' && method === 'GET') {
    try {
      const livePids = new Set(instances.keys());
      const out = [];
      for (const [pid, wt] of _pidWorktrees) {
        const alive = livePids.has(pid);
        let hasUncommitted = false;
        let ahead = 0;
        let exists = existsSync(wt.path);
        if (exists) {
          try {
            const status = gitInCwd(wt.path, ['status', '--porcelain=v1', '-z']);
            hasUncommitted = status.length > 0;
          } catch { /* worktree path gone or not a git wt */ exists = false; }
          try {
            const a = gitInCwd(wt.path, ['rev-list', '--count', '@{u}..HEAD']).trim();
            ahead = parseInt(a, 10) || 0;
          } catch { /* no upstream */ }
        }
        out.push({
          pid: alive ? pid : null,
          alive,
          exists,
          path: wt.path,
          branch: wt.branch,
          baseRef: wt.baseRef,
          originalCwd: wt.originalCwd,
          hasUncommitted,
          ahead,
        });
      }
      sendJson(res, 200, { worktrees: out, count: out.length });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/worktrees/cleanup' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const force = !!body.force;
      if (!paths.length) { sendJson(res, 400, { error: 'paths required' }); return; }
      const removed = [];
      const rejected = [];
      for (const p of paths) {
        if (typeof p !== 'string' || !p) {
          rejected.push({ path: String(p), reason: 'invalid path' });
          continue;
        }
        // Only allow paths we tracked. Defense against arbitrary
        // `git worktree remove` on the user's own worktrees.
        let wt = null;
        let trackedPid = null;
        for (const [pid, info] of _pidWorktrees) {
          if (info.path === p) { wt = info; trackedPid = pid; break; }
        }
        if (!wt) { rejected.push({ path: p, reason: 'not a launcher-tracked worktree' }); continue; }
        if (instances.has(trackedPid)) {
          rejected.push({ path: p, reason: 'instance still alive — stop the ccv first' });
          continue;
        }
        if (!force) {
          let dirty = false;
          let ahead = 0;
          try {
            const status = gitInCwd(wt.path, ['status', '--porcelain=v1', '-z']);
            dirty = status.length > 0;
          } catch { /* path gone — treat as removable */ }
          try {
            const a = gitInCwd(wt.path, ['rev-list', '--count', '@{u}..HEAD']).trim();
            ahead = parseInt(a, 10) || 0;
          } catch { /* no upstream */ }
          if (dirty || ahead > 0) {
            rejected.push({ path: p, reason: (dirty ? 'uncommitted changes' : '') + (dirty && ahead ? ' + ' : '') + (ahead ? ahead + ' commits ahead of origin' : '') });
            continue;
          }
        }
        try {
          if (existsSync(wt.path)) removeWorktree(wt.originalCwd, wt.path, { force });
          _pidWorktrees.delete(trackedPid);
          removed.push(p);
        } catch (err) {
          rejected.push({ path: p, reason: err.message });
        }
      }
      sendJson(res, 200, { ok: true, removed, rejected, needsConfirm: rejected.length > 0 && !force });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ---- M4: CLAUDE.md scanner + inline editor ----
  // Per-pid scan walks the instance cwd's ancestor chain + ~/.claude/CLAUDE.md
  // + any @-referenced .md files. Read/write endpoints share a single
  // whitelist (isAllowedMdPath) that bounds writes to CLAUDE.md on the cwd
  // ancestor chain, .md files under cwd/.claude/, or anywhere under ~/.claude.
  const claudeMdM = url.match(/^\/api\/launcher\/instances\/(\d+)\/claude-md$/);
  if (claudeMdM && method === 'GET') {
    try {
      const pid = parseInt(claudeMdM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      sendJson(res, 200, { pid, cwd: inst.cwd, files: scanClaudeMd(inst.cwd) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Aggregated view across every running non-hub instance. UI top-bar uses
  // this to render the global Memory drawer (de-duped by absolute path).
  if (url === '/api/launcher/claude-md/all' && method === 'GET') {
    try {
      const merged = new Map(); // realpath → entry (+ list of pids it surfaced for)
      for (const inst of instances.values()) {
        if (!inst || !inst.cwd || inst.isHub) continue;
        for (const f of scanClaudeMd(inst.cwd)) {
          if (!merged.has(f.path)) merged.set(f.path, { ...f, pids: [] });
          merged.get(f.path).pids.push(inst.pid);
        }
      }
      sendJson(res, 200, { files: Array.from(merged.values()) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.startsWith('/api/launcher/file') && method === 'GET') {
    try {
      const raw = parsedUrl.searchParams.get('path') || '';
      if (!raw) { sendJson(res, 400, { error: 'path required' }); return; }
      const abs = resolvePath(raw);
      if (!isAllowedMdPath(abs)) { sendJson(res, 403, { error: 'path not in whitelist' }); return; }
      if (!existsSync(abs)) { sendJson(res, 404, { error: 'file not found' }); return; }
      const st = statSync(abs);
      if (!st.isFile()) { sendJson(res, 400, { error: 'not a regular file' }); return; }
      if (st.size > MD_FILE_MAX_BYTES) { sendJson(res, 413, { error: 'file too large (>' + MD_FILE_MAX_BYTES + ' bytes)' }); return; }
      const content = readFileSync(abs, 'utf-8');
      sendJson(res, 200, { path: abs, size: st.size, mtime: Math.floor(st.mtimeMs), content });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === '/api/launcher/file' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      const raw = typeof body.path === 'string' ? body.path : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!raw) { sendJson(res, 400, { error: 'path required' }); return; }
      if (content.length > MD_FILE_MAX_BYTES) { sendJson(res, 413, { error: 'content too large (>' + MD_FILE_MAX_BYTES + ' bytes)' }); return; }
      const abs = resolvePath(raw);
      if (!isAllowedMdPath(abs)) { sendJson(res, 403, { error: 'path not in whitelist' }); return; }
      const dir = dirname(abs);
      if (!existsSync(dir)) { sendJson(res, 400, { error: 'parent directory does not exist' }); return; }
      const backup = backupMdBeforeWrite(abs);
      writeFileSync(abs, content, 'utf-8');
      const st = statSync(abs);
      sendJson(res, 200, { ok: true, path: abs, size: st.size, mtime: Math.floor(st.mtimeMs), backup });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Usage / cost summary across all native session jsonls. Cached 60s in
  // memory + persisted to launcher-cache.json (stale-while-revalidate so a
  // poll never blocks on a cold disk scan).
  if (url === '/api/launcher/usage/summary' && method === 'GET') {
    try {
      const range = (parsedUrl.searchParams.get('range') || 'today').toLowerCase();
      if (!['today', 'week', 'month'].includes(range)) {
        throw new Error('range must be today|week|month');
      }
      const cwdParam = parsedUrl.searchParams.get('cwd') || '';
      const result = await getCachedUsage({ range, cwd: cwdParam });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // Per-instance session totals (cumulative across the current jsonl).
  // mtime/size-keyed cache → re-reading is cheap when the file hasn't grown.
  const instUsageM = url.match(/^\/api\/launcher\/usage\/instance\/(\d+)$/);
  if (instUsageM && method === 'GET') {
    try {
      const pid = parseInt(instUsageM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const jp = resolveNativeJsonl(inst);
      if (!jp) {
        sendJson(res, 200, {
          pid,
          jsonlPath: null,
          sessionId: inst.sessionId || null,
          sessionUSD: 0,
          byModel: {},
          totals: emptyTokenBucket(),
          requestCount: 0,
          lastEntry: null,
        });
        return;
      }
      const u = await readInstanceUsage(jp);
      sendJson(res, 200, {
        pid,
        jsonlPath: jp,
        sessionId: inst.sessionId || null,
        sessionUSD: u ? u.costUSD : 0,
        byModel: u ? u.byModel : {},
        totals: u ? u.totals : emptyTokenBucket(),
        requestCount: u ? u.requestCount : 0,
        lastEntry: u ? u.lastEntry : null,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 5h quota window: tiered (ccline_cache → api_oauth → jsonl_compute →
  // unavailable). 30s in-memory + 5min disk cache, stale-while-revalidate
  // so a poll never blocks on a cold scan.
  if (url === '/api/launcher/quota/5h' && method === 'GET') {
    try {
      const result = await getCachedQuota5h();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Per-instance run summary: timeline of notable events extracted from the
  // native session jsonl (prompts, slash commands, tool errors, sub-agent
  // spawns, hook events, auto-compact markers). 5s per-file cache keyed on
  // mtime+size — re-read is free when the jsonl hasn't grown.
  const runSummaryM = url.match(/^\/api\/launcher\/instances\/(\d+)\/run-summary$/);
  if (runSummaryM && method === 'GET') {
    try {
      const pid = parseInt(runSummaryM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const jp = resolveNativeJsonl(inst);
      if (!jp) {
        sendJson(res, 200, { pid, jsonlPath: null, events: [], totalEvents: 0, totals: { prompts: 0, slash_commands: 0, tools: 0, errors: 0, compacts: 0, subagents: 0, hooks: 0 }, computedAt: Date.now() });
        return;
      }
      const r = await computeRunSummary(jp);
      sendJson(res, 200, {
        pid,
        jsonlPath: jp,
        events: r ? r.events : [],
        totalEvents: r ? r.totalEvents : 0,
        totals: r ? r.totals : { prompts: 0, slash_commands: 0, tools: 0, errors: 0, compacts: 0, subagents: 0, hooks: 0 },
        computedAt: r ? r.computedAt : Date.now(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Per-instance recent edits: Edit/Write/MultiEdit aggregated by file_path,
  // Bash aggregated by command head. Shares the run-summary's single-pass
  // scan cache (5s TTL, mtime+size keyed).
  const recentEditsM = url.match(/^\/api\/launcher\/instances\/(\d+)\/recent-edits$/);
  if (recentEditsM && method === 'GET') {
    try {
      const pid = parseInt(recentEditsM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const jp = resolveNativeJsonl(inst);
      if (!jp) {
        sendJson(res, 200, { pid, jsonlPath: null, files: [], bash: [], totalUniqueTargets: 0, computedAt: Date.now() });
        return;
      }
      const r = await computeRecentEdits(jp);
      sendJson(res, 200, {
        pid,
        jsonlPath: jp,
        files: r ? r.files : [],
        bash: r ? r.bash : [],
        totalUniqueTargets: r ? r.totalUniqueTargets : 0,
        computedAt: r ? r.computedAt : Date.now(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Per-instance error breakdown: tool_result.is_error entries clustered by
  // (toolName, first-80-chars). Shares the single-pass scan cache.
  const errorsM = url.match(/^\/api\/launcher\/instances\/(\d+)\/errors$/);
  if (errorsM && method === 'GET') {
    try {
      const pid = parseInt(errorsM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const jp = resolveNativeJsonl(inst);
      if (!jp) {
        sendJson(res, 200, { pid, jsonlPath: null, groups: [], total: 0, computedAt: Date.now() });
        return;
      }
      const r = await computeErrors(jp);
      sendJson(res, 200, {
        pid,
        jsonlPath: jp,
        groups: r ? r.groups : [],
        total: r ? r.total : 0,
        computedAt: r ? r.computedAt : Date.now(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ---- M2: git operations on a worktree-spawned instance ----
  // All four endpoints below resolve `pid → instance.cwd` from our in-memory
  // `instances` Map, then refuse if that pid has no entry in `_pidWorktrees`
  // (i.e. it wasn't spawned via useWorktree=true). This keeps git mutations
  // confined to the dedicated worktree branch — we never run commit/push
  // against the user's main checkout.
  const gitDiffM = url.match(/^\/api\/launcher\/instances\/(\d+)\/git-diff$/);
  if (gitDiffM && method === 'GET') {
    try {
      const pid = parseInt(gitDiffM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const wt = worktreeForPid(pid);
      if (!wt) { sendJson(res, 400, { error: 'instance not spawned in a worktree' }); return; }
      // numstat: "<added>\t<deleted>\t<path>" per line. Includes both staged
      // (HEAD vs index) and unstaged (index vs working) by diffing HEAD vs
      // working tree directly. For untracked files git diff is silent, so we
      // surface them via `git status --porcelain` and synthesize a row with
      // +<line_count> -0 (best-effort line count from cat).
      let files = [];
      try {
        const out = gitInCwd(wt.path, ['diff', 'HEAD', '--numstat', '--no-color', '-z']);
        // -z mode: each record is `<added>\t<deleted>\t<path>\0`. For renames
        // the format is `<added>\t<deleted>\t\0<from>\0<to>\0` which we don't
        // try to parse in detail; render as `to` only.
        const parts = out.split('\0').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          const rec = parts[i];
          const tab1 = rec.indexOf('\t');
          const tab2 = rec.indexOf('\t', tab1 + 1);
          if (tab1 < 0 || tab2 < 0) continue;
          const added = rec.slice(0, tab1);
          const deleted = rec.slice(tab1 + 1, tab2);
          let path = rec.slice(tab2 + 1);
          if (!path) {
            // rename: next two tokens are <from> and <to>; take <to>
            path = parts[i + 2] || '';
            i += 2;
          }
          if (!path) continue;
          files.push({
            path,
            additions: added === '-' ? null : parseInt(added, 10) || 0,
            deletions: deleted === '-' ? null : parseInt(deleted, 10) || 0,
          });
        }
      } catch (err) { /* empty diff → out=='' so files stays [] */ }
      let untracked = [];
      try {
        const out = gitInCwd(wt.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
        const parts = out.split('\0').filter(Boolean);
        for (const rec of parts) {
          if (rec.length < 3) continue;
          const code = rec.slice(0, 2);
          const path = rec.slice(3);
          if (code === '??') untracked.push(path);
        }
      } catch { /* ignore */ }
      for (const path of untracked) {
        if (files.some(f => f.path === path)) continue;
        // count lines of new file (cheap; capped via maxBuffer).
        let lines = 0;
        try {
          const buf = execFileSync('/usr/bin/wc', ['-l', join(wt.path, path)], { encoding: 'utf-8', timeout: 4000 });
          lines = parseInt(buf.trim().split(/\s+/)[0], 10) || 0;
        } catch { /* binary or missing → 0 */ }
        files.push({ path, additions: lines, deletions: 0, untracked: true });
      }
      // ahead count vs upstream (origin/<branch>). If no upstream, ahead=0.
      let ahead = 0;
      try {
        const out = gitInCwd(wt.path, ['rev-list', '--count', '@{u}..HEAD']).trim();
        ahead = parseInt(out, 10) || 0;
      } catch { /* no upstream — first push not yet done */ }
      const totalAdd = files.reduce((s, f) => s + (f.additions || 0), 0);
      const totalDel = files.reduce((s, f) => s + (f.deletions || 0), 0);
      sendJson(res, 200, {
        pid,
        worktree: wt,
        stat: { additions: totalAdd, deletions: totalDel, files: files.length },
        files,
        hasUncommitted: files.length > 0,
        ahead,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const gitCommitM = url.match(/^\/api\/launcher\/instances\/(\d+)\/git-commit$/);
  if (gitCommitM && method === 'POST') {
    try {
      const pid = parseInt(gitCommitM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const wt = worktreeForPid(pid);
      if (!wt) { sendJson(res, 400, { error: 'instance not spawned in a worktree' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const message = typeof body.message === 'string' ? body.message : '';
      if (!message.trim()) { sendJson(res, 400, { error: 'message required' }); return; }
      // commit message passed via stdin (`-F -`) so newlines + quotes never
      // hit a shell. Limit length to keep stdin write bounded.
      if (message.length > 8192) { sendJson(res, 400, { error: 'message too long (>8KB)' }); return; }
      gitInCwd(wt.path, ['add', '-A']);
      let commitOut = '';
      try {
        commitOut = gitInCwd(wt.path, ['commit', '-F', '-', '--allow-empty-message'], { input: message });
      } catch (err) {
        const stderr = (err.stderr || '').toString().trim();
        const stdout = (err.stdout || '').toString().trim();
        // "nothing to commit" is exit code 1 from git but not really an error;
        // surface to caller so UI can show "no changes" instead of red toast.
        if (/nothing to commit/i.test(stdout + stderr)) {
          sendJson(res, 200, { ok: false, nothingToCommit: true });
          return;
        }
        throw new Error(stderr || stdout || err.message);
      }
      const head = gitInCwd(wt.path, ['rev-parse', 'HEAD']).trim();
      sendJson(res, 200, { ok: true, sha: head, output: commitOut.trim().slice(0, 2000) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const gitPushM = url.match(/^\/api\/launcher\/instances\/(\d+)\/git-push$/);
  if (gitPushM && method === 'POST') {
    try {
      const pid = parseInt(gitPushM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const wt = worktreeForPid(pid);
      if (!wt) { sendJson(res, 400, { error: 'instance not spawned in a worktree' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const force = !!body.force;
      // Push only the worktree's own branch to origin. Always
      // --force-with-lease (never plain --force) so we refuse to clobber
      // remote work the local doesn't know about.
      const args = ['push', '--set-upstream', 'origin', wt.branch + ':' + wt.branch];
      if (force) args.push('--force-with-lease');
      let out = '';
      try {
        out = gitInCwd(wt.path, args, { timeout: 30000 });
      } catch (err) {
        const stderr = (err.stderr || '').toString().trim();
        throw new Error(stderr || err.message);
      }
      sendJson(res, 200, { ok: true, output: out.trim().slice(0, 4000) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const openPrM = url.match(/^\/api\/launcher\/instances\/(\d+)\/open-pr$/);
  if (openPrM && method === 'POST') {
    try {
      const pid = parseInt(openPrM[1], 10);
      const inst = instances.get(pid);
      if (!inst) { sendJson(res, 404, { error: 'instance not found' }); return; }
      const wt = worktreeForPid(pid);
      if (!wt) { sendJson(res, 400, { error: 'instance not spawned in a worktree' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const prBody = typeof body.body === 'string' ? body.body : '';
      const base = typeof body.base === 'string' && body.base.trim() ? body.base.trim() : (wt.baseRef || 'main').replace(/^origin\//, '');
      if (!title) { sendJson(res, 400, { error: 'title required' }); return; }
      if (title.length > 256) { sendJson(res, 400, { error: 'title too long' }); return; }
      if (prBody.length > 64 * 1024) { sendJson(res, 400, { error: 'body too long (>64KB)' }); return; }
      if (!BRANCH_NAME_RE.test(base)) { sendJson(res, 400, { error: 'base branch name invalid' }); return; }
      // Verify gh is installed + authenticated before attempting the create —
      // gh's own error messages on missing auth are verbose; we want a clean
      // signal the UI can render as "需要 gh auth login".
      try {
        execFileSync('gh', ['auth', 'status'], { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: '需要 gh auth login (gh CLI 未登录)' });
        return;
      }
      // Pass body via stdin (--body-file -) so newlines/backticks/quotes
      // can't leak into a shell. gh prints the PR URL on stdout on success.
      let out = '';
      try {
        out = execFileSync('gh', ['pr', 'create', '--title', title, '--body-file', '-', '--base', base, '--head', wt.branch], {
          cwd: wt.path,
          encoding: 'utf-8',
          timeout: 30000,
          input: prBody,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        const stderr = (err.stderr || '').toString().trim();
        const stdout = (err.stdout || '').toString().trim();
        throw new Error(stderr || stdout || err.message);
      }
      const urlLine = out.split('\n').map(s => s.trim()).find(s => /^https?:\/\//.test(s)) || out.trim();
      sendJson(res, 200, { ok: true, url: urlLine });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
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
