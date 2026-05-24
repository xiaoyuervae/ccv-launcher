// Runtime registry + child-process orchestration: instances Map, runtime
// file watcher, public/LAN URL builders, external-ccv backfill, "local CC"
// (claude CLI not under ccv) enumeration, spawn + serializeSpawn, git
// worktree create/remove, and the CLAUDE.md scanner.
//
// This module owns the entire view of "what ccvs exist and where" plus the
// life-cycle calls that mutate it (spawn / kill / watch). Consumers import:
//   * `instances` Map (singleton) for read-only iteration
//   * `setSelfBinding(port, token)` so the entry's serverStarted hook can
//     register the hub's own port/token (used by URL builders + port allocator)
//   * `_pidWorktrees` Map for the worktree cleanup endpoint
//   * the rest of the functions as needed by the HTTP route layer

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  realpathSync, statSync, unlinkSync, watch,
  openSync, readSync, closeSync, copyFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { log } from './log.mjs';
import { getCcuseProfile } from './prefs.mjs';

// ----- module-level config (env-derived) -----
const HUB_ENABLED = process.env.CCV_HUB === '1';
export const RUNTIME_DIR = join(homedir(), '.claude', 'cc-viewer', 'runtime');
// Per-port stdout/stderr capture for spawned ccv children. The /api/launcher/
// instances/<pid>/ccv-log endpoint tails these so the redesigned launcher's
// embedded terminal Logs tab can show what ccv is logging without needing a
// separate ws subscription. Files are truncated on each spawn.
export const LAUNCHER_LOG_DIR = join(homedir(), '.claude', 'cc-viewer', 'launcher-logs');
export function ccvLogPath(port) { return join(LAUNCHER_LOG_DIR, `ccv-${port}.log`); }
// Public URL template for child instances exposed via a reverse proxy.
// When unset, buildPublicUrl returns '' and the UI shows only the LAN URL.
// Placeholders: {port} {token} {host}.
const PUBLIC_TEMPLATE = process.env.CCV_PUBLIC_URL_TEMPLATE || '';
// Port range for spawning child ccv instances. The hub itself is bound to
// HUB_FIXED_PORT (default 7100) and reverse-proxied (NPM, traefik, …) to a
// fixed subdomain so the user has one stable URL to bookmark; children show up
// via its own dedicated subdomain, so children don't collide with it.
const HUB_PORT_FLOOR = parseInt(process.env.CCV_CHILD_PORT_FLOOR || '7008', 10);
const HUB_PORT_CEIL = parseInt(process.env.CCV_CHILD_PORT_CEIL || '7099', 10);
const SPAWN_TIMEOUT_MS = 15000;

export const instances = new Map();
let _selfPort = null;
let _selfToken = null;
export function setSelfBinding(port, token) { _selfPort = port; _selfToken = token; }


export function safeJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function buildPublicUrl(entry) {
  if (!PUBLIC_TEMPLATE) return '';
  return renderTemplate(PUBLIC_TEMPLATE, {
    port: entry.port ?? '',
    token: entry.token ?? '',
    host: entry.ip ?? '',
    ip: entry.ip ?? '',
  });
}

export function buildLanUrl(entry) {
  if (!entry.port) return null;
  const protocol = entry.protocol || 'http';
  const host = entry.ip || '127.0.0.1';
  return `${protocol}://${host}:${entry.port}?token=${entry.token || ''}`;
}

export function loadRuntimeFile(file) {
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

export function rescanRuntime() {
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
export const BACKFILL_TTL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 600;

export async function probeCcv(port) {
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

export function listListeningNodePids() {
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

export function readPidCwd(pid) {
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

export function readPidStartedMs(pid) {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

export async function backfillExternalCcvs(force = false) {
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
export const LOCAL_CC_CACHE_TTL_MS = 5000;
const _firstEntryCwdCache = new Map(); // jsonlPath -> { mtime, cwd }

// Decode a Claude Code project-dir name like "-Users-dayuer-Foo-Bar" back into
// "/Users/dayuer/Foo/Bar". Lossy for non-alphanumeric chars (CJK etc are
// flattened to "-"), so we only fall back to this when reading the jsonl's
// first entry fails — the jsonl carries the real cwd verbatim.
export function decodeProjectDirName(name) {
  if (!name || typeof name !== 'string') return '';
  // Leading "-" denotes the absolute path's leading "/", so just replace.
  return name.replace(/-/g, '/');
}

export function readJsonlCwd(jsonlPath) {
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
export function readJsonlLastTimestamp(jsonlPath) {
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

export function readPidLstart(pid) {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8', timeout: 1500 }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch { return null; }
}

export function listLocalCcSessions(force = false) {
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
export function spawnCcvInTerminal(cwd, extraArgs = []) {
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
export async function killClaudePid(pid) {
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


export function startWatcher() {
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
export function serializeSpawn(fn) {
  const next = _spawnQueue.then(fn, fn);
  _spawnQueue = next.catch(() => { /* swallow to keep queue alive */ });
  return next;
}

export function nextFreePort() {
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

export function findRunningByCwd(cwd) {
  for (const entry of instances.values()) {
    if (entry && entry.cwd === cwd) return entry;
  }
  return null;
}

export function waitForChildRuntime(pid, timeoutMs) {
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
export const _pidWorktrees = new Map();

export const WORKTREE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
export const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]{1,80}$/;

export function isInsideDir(child, parent) {
  // resolve both, then verify child === parent OR child starts with parent + sep.
  // Guards against name-prefix attacks like /repo-evil vs /repo.
  const c = resolvePath(child);
  const p = resolvePath(parent);
  if (c === p) return true;
  return c.startsWith(p + '/');
}

export function gitInCwd(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: opts.timeout || 8000,
    maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
    input: opts.input,
    stdio: opts.input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
}

export function detectBaseRef(cwd) {
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

export function createWorktree(originalCwd, { branchName } = {}) {
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

export function removeWorktree(originalCwd, worktreePath, { force = false } = {}) {
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

export function worktreeForPid(pid) {
  return _pidWorktrees.get(pid) || null;
}

// ---- CLAUDE.md scanner + editor (M4) ----
// Scans the ancestor chain of a cwd for CLAUDE.md, plus ~/.claude/CLAUDE.md,
// plus any `@<ref>.md` references inside those files (typically into
// ~/.claude/rules/). Used by the per-card Memory tab.
export const MD_FILE_MAX_BYTES = 256 * 1024;
export const MD_PREVIEW_BYTES = 200;
export const MD_BACKUP_KEEP = 5;
export const HOME_CLAUDE_DIR = join(homedir(), '.claude');

// Resolve any symlinks on absPath. If the leaf doesn't exist yet (legitimate
// for first-time create writes), fall back to realpath(parent) + basename so
// the parent's real location is what we whitelist-check. Returns null if
// neither the path nor its parent can be realpath'd (path is unreachable).
export function safeRealpath(absPath) {
  try { return realpathSync(absPath); } catch { /* leaf may not exist */ }
  try {
    const parentReal = realpathSync(dirname(absPath));
    return join(parentReal, basename(absPath));
  } catch { return null; }
}

export function isAllowedMdPath(absPath) {
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

export function safeReadPreview(absPath) {
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

export function pushMdFile(out, seen, absPath, scope) {
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

export function scanClaudeMd(cwd) {
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

export function backupMdBeforeWrite(absPath) {
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

export async function doSpawn(targetCwd, { force = false, ccuseProfile = '', useWorktree = false, branchName = '' } = {}) {
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
  // Capture child stdout+stderr to a per-port log so the launcher's Logs tab
  // can tail it. Truncate on spawn ("w") to keep the file scoped to this run.
  if (!existsSync(LAUNCHER_LOG_DIR)) mkdirSync(LAUNCHER_LOG_DIR, { recursive: true });
  const logFd = openSync(ccvLogPath(port), 'w');
  const childStdio = ['ignore', logFd, logFd];
  let child;
  if (profile) {
    // Properly quote the profile name for zsh
    const safeProfile = profile.replace(/[^a-zA-Z0-9_\-.]/g, '');
    if (safeProfile !== profile) {
      closeSync(logFd);
      throw new Error(`ccuse profile "${profile}" contains invalid characters`);
    }
    const shellCmd = `ccuse ${safeProfile} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} --d --no-open`;
    child = spawn('/bin/zsh', ['-i', '-c', shellCmd], {
      cwd: targetCwd,
      detached: true,
      stdio: childStdio,
      env,
    });
  } else {
    child = spawn(process.execPath, [cliPath, '--d', '--no-open'], {
      cwd: targetCwd,
      detached: true,
      stdio: childStdio,
      env,
    });
  }
  // Node dup'd the fd into the child; close our copy so the launcher hub
  // doesn't hold an open handle to every child's log file forever.
  closeSync(logFd);
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
