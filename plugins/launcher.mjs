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
import { PREFIX, log, jlog } from '../src/launcher/log.mjs';
import {
  loadPrefs, savePrefs,
  normalizeAlias, getAlias, setAlias,
  getCcuseProfile, setCcuseProfile, setDefaultCcuseProfile,
  normalizeTag, getTags, setTags, addTag, removeTag, getAllTags,
  DEFAULT_COMPACT_THRESHOLD, getCompactThreshold, setCompactThreshold,
  getWorktreeDefault, setWorktreeDefault,
  listCcuseProfiles,
} from '../src/launcher/prefs.mjs';
import {
  pendingPairs, approvedSessions, PAIR_CODE_TTL_MS, SESSION_MAX_AGE,
  loadSessions, saveSessions, generatePairCode, cleanExpiredPairs,
  parseCookies, isLanIp, getClientIp, isAuthenticated, shortUA, subjectIdFor,
} from '../src/launcher/auth.mjs';
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

// in-memory instance map: pid → runtime payload (with augmented urls / status)
const instances = new Map();
let _selfPort = null;
let _selfToken = null;

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

// Resolve any symlinks on absPath. If the leaf doesn't exist yet (legitimate
// for first-time create writes), fall back to realpath(parent) + basename so
// the parent's real location is what we whitelist-check. Returns null if
// neither the path nor its parent can be realpath'd (path is unreachable).
function safeRealpath(absPath) {
  try { return realpathSync(absPath); } catch { /* leaf may not exist */ }
  try {
    const parentReal = realpathSync(dirname(absPath));
    return join(parentReal, basename(absPath));
  } catch { return null; }
}

function isAllowedMdPath(absPath) {
  // Two-stage check: shape on the raw resolved path, then *real* path
  // (symlinks expanded) against the whitelist roots. Without the realpath
  // expansion, an attacker who can write to ~/.claude/ (a user-writable dir)
  // can plant a symlink ~/.claude/x.md → /etc/passwd and read/write any
  // user-accessible file via /api/launcher/file. Caller passes an absolute
  // path.
  const lexical = resolvePath(absPath);
  if (!lexical.endsWith('.md')) return false;
  const real = safeRealpath(lexical);
  if (!real || !real.endsWith('.md')) return false;
  // Allowed root 1: anywhere under ~/.claude (CLAUDE.md, rules/*.md, etc.)
  if (isInsideDir(real, HOME_CLAUDE_DIR)) return true;
  // Allowed roots 2 & 3: for any known instance cwd —
  //   (a) a file named CLAUDE.md anywhere on the cwd's ancestor chain
  //   (b) any .md file under cwd/.claude/ (skills, memory, etc.)
  const base = basename(real);
  const dir = dirname(real);
  for (const inst of instances.values()) {
    const cwd = inst && inst.cwd;
    if (!cwd) continue;
    if (base === 'CLAUDE.md' && isInsideDir(cwd, dir)) return true;
    const dotClaude = join(cwd, '.claude');
    if (isInsideDir(real, dotClaude)) return true;
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
// Primitives live in src/launcher/activity.mjs; getInstanceActivity below
// composes them with usage / claudemd / prefs data.
import {
  ccvProjectName, findActiveLogFileForInstance, tailJsonlEntries,
  truncate, lastUserPromptAcrossEntries, readFirstUserPrompt,
  summarizeEntry, fetchPendingAsks, deriveStatus,
} from '../src/launcher/activity.mjs';

const ACTIVITY_CACHE_TTL_MS = 1500;
const _activityCache = new Map(); // pid -> { at, signature, payload }

// ---------- ccusage + 5h quota + run summary ----------
// Module lives in src/launcher/usage.mjs; entry just imports.
import {
  loadPricing, loadModels, computeContextUsage, resolveNativeJsonl,
  readInstanceUsage, aggregateUsage, getCachedUsage, getCachedQuota5h,
  checkCompactThresholds, computeRunSummary, computeRecentEdits, computeErrors,
  classifyEntry, truncateLabel,
} from '../src/launcher/usage.mjs';

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

import { HTML_PAGE } from '../src/launcher/html-page.mjs';

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

  // Restart an instance with a different ccuse profile.
  //
  // Use case: a ccv is running on profile A (e.g. an internal API gateway),
  // user wants to switch to profile B (e.g. "official" with direct Anthropic
  // credentials) without manually killing + re-launching from the dialog.
  //
  // Semantics: SIGTERM the existing pid, wait briefly for cleanup, then
  // spawn a fresh ccv at the SAME cwd (which may already BE a worktree path)
  // with the new profile. We never wrap an existing worktree in another
  // worktree, so useWorktree is forced false on restart.
  if (url === '/api/launcher/restart' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const { pid, ccuseProfile } = JSON.parse(raw || '{}');
      const numericPid = parseInt(pid, 10);
      if (!Number.isFinite(numericPid)) throw new Error('pid required');
      if (numericPid === process.pid) throw new Error('cannot restart hub itself');
      const inst = instances.get(numericPid);
      if (!inst) throw new Error('unknown pid');
      if (inst.isHub) throw new Error('cannot restart hub');
      const cwd = inst.cwd;
      if (!cwd) throw new Error('instance has no cwd');
      const profile = typeof ccuseProfile === 'string' ? ccuseProfile.trim() : '';
      // Persist so the new spawn (and any later spawns at this cwd) pick it up.
      setCcuseProfile(cwd, profile);
      // SIGTERM old. Best-effort — if pid is already gone, just continue.
      try { process.kill(numericPid, 'SIGTERM'); } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
      instances.delete(numericPid);
      // Give the runtime watcher a moment to observe the runtime/<pid>.json
      // deletion so doSpawn's port allocator and registry view are coherent.
      await new Promise(r => setTimeout(r, 500));
      const entry = await serializeSpawn(() => doSpawn(cwd, {
        ccuseProfile: profile,
        useWorktree: false,
      }));
      sendJson(res, 200, {
        ok: true,
        instance: entry,
        oldPid: numericPid,
        ccuseProfile: profile,
      });
    } catch (err) {
      log('restart error:', err.message);
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
