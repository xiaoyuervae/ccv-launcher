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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync, unlinkSync, watch } from 'node:fs';
import { join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getWorkspaces, removeWorkspace } from '/opt/homebrew/lib/node_modules/cc-viewer/workspace-registry.js';
// PB2 module — resumable PTY sessions. Lives only in the fork today (npm
// build is older). Once P0.3 switches launchd to the fork the parent dir is
// the same; the absolute path here keeps working either way.
import { PtySessionManager } from '/Users/dayuer/Projects/cc-viewer/lib/pty-session-manager.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PREFIX = '[ccv-launcher]';
const HUB_ENABLED = process.env.CCV_HUB === '1';
const RUNTIME_DIR = join(homedir(), '.claude', 'cc-viewer', 'runtime');
const PUBLIC_TEMPLATE = process.env.CCV_PUBLIC_URL_TEMPLATE
  || 'https://ccv-{port}.xiaoyuervae.cn:9990/?token={token}';
// Children land in 7008-7099 (matches the public reverse-proxy rule
// `ccv-(7000-7099).xiaoyuervae.cn:9990`). The hub itself runs on 7100,
// outside that range, and is reached via the dedicated subdomain
// `ccv.xiaoyuervae.cn:9990` so children don't collide with it.
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
      instances.set(entry.pid, entry);
    }
    // drop any in-memory instance whose runtime file vanished
    for (const pid of [...instances.keys()]) {
      if (!seen.has(pid)) instances.delete(pid);
    }
  } catch (err) {
    log('rescanRuntime error:', err.message);
  }
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

async function doSpawn(targetCwd) {
  if (!targetCwd || typeof targetCwd !== 'string') throw new Error('cwd required');
  if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    throw new Error('cwd is not an existing directory');
  }
  // Normalize symlinks so e.g. "/tmp/x" and "/private/tmp/x" map to the same
  // dedup key. runtime/<pid>.json stores process.cwd() which on macOS is
  // already the resolved path, so without this dedup misses on user input
  // that traverses /tmp, /var, etc.
  try { targetCwd = realpathSync(targetCwd); } catch { /* keep original */ }
  const existing = findRunningByCwd(targetCwd);
  if (existing) return existing;

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
  const child = spawn(process.execPath, [cliPath, '--d', '--no-open'], {
    cwd: targetCwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  child.stdout?.on('data', () => {}); // drain
  child.stderr?.on('data', () => {}); // drain
  child.unref();

  try {
    const entry = await waitForChildRuntime(child.pid, SPAWN_TIMEOUT_MS);
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
  .card-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .card-head .name { font-weight:600; font-size:13px; }
  .card-head .hub-tag { font-size:10px; color:var(--accent); background:rgba(88,166,255,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .tag { display:inline-block; font-size:11px; color:var(--mute); background:var(--tag-bg); padding:1px 7px; border-radius:3px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card-path { color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:6px; }
  .card-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .card-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }

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

<dialog id="dlg">
  <h2>Launch new instance</h2>
  <div style="color:var(--mute);font-size:11px;margin-bottom:4px">Directory:</div>
  <input id="cwd" placeholder="/path/to/project">
  <div class="tree" id="tree"></div>
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

  function render(items, history) {
    const total = items.length + (history || []).length;
    metaEl.textContent = items.length + ' running' + (history && history.length ? ' · ' + history.length + ' recent' : '');
    if (!total) {
      listEl.innerHTML = '<div class="empty">No instances yet. Click "+ New" to launch one.</div>';
      return;
    }
    items.sort((a,b) => (b.isHub?1:0) - (a.isHub?1:0) || (a.port||0) - (b.port||0));
    let html = '<div class="section-hd"><span class="dot green"></span>Running (' + items.length + ')</div>';
    html += items.map(it => {
      const cls = it.isHub ? 'card hub' : 'card running';
      const name = escape(it.projectName || '?');
      const path = escape(it.cwd || '');
      const pub = escape(it.publicUrl || '');
      const lan = escape(it.lanUrl || '');
      const openHref = pub || lan || '#';
      let actions = ''
        + '<button class="btn primary" data-act="open" data-href="'+escape(openHref)+'">Open</button>'
        + '<button class="btn" data-act="copy" data-text="'+(pub||lan)+'">Copy URL</button>';
      if (!it.isHub) {
        actions += '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+name+'">Shell</button>';
        actions += '<button class="btn" data-act="console" data-port="'+(it.port||'')+'" data-token="'+(it.token||'')+'" data-name="'+name+'" data-path="'+path+'" data-pub="'+(it.publicUrl||'')+'" data-lan="'+(it.lanUrl||'')+'">Console</button>';
        actions += '<button class="btn danger" data-act="stop" data-pid="'+it.pid+'" data-name="'+name+'">Stop</button>';
      }
      return ''
        + '<div class="'+cls+'" data-pid="'+it.pid+'">'
        +   '<div class="card-head">'
        +     '<span class="name">'+name+'</span>'
        +     (it.isHub ? '<span class="hub-tag">HUB</span>' : '')
        +   '</div>'
        +   '<div class="card-path" title="'+path+'">'+path+'</div>'
        +   '<div class="card-meta">'
        +     '<span class="tag">:' + (it.port||'?') + '</span>'
        +     '<span class="tag">pid ' + it.pid + '</span>'
        +     '<span class="tag">up ' + fmtAge(it.startedAt) + '</span>'
        +     (it.version ? '<span class="tag">' + escape(it.version) + '</span>' : '')
        +   '</div>'
        +   '<details><summary>URLs &middot; QR</summary>'
        +     (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>':'')
        +     (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>':'')
        +     (pub ? '<div class="qr" data-qr="'+pub+'"></div>':'')
        +   '</details>'
        +   '<div class="card-actions">' + actions + '</div>'
        + '</div>';
    }).join('');

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
      window.open(t.dataset.href, '_blank');
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(t.dataset.text || t.textContent); t.style.color='var(--ok)'; setTimeout(()=>t.style.color='', 800); } catch {}
    } else if (act === 'stop') {
      if (!confirm('Stop ccv "'+t.dataset.name+'" (pid '+t.dataset.pid+')?')) return;
      try { await api('/api/launcher/kill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pid: parseInt(t.dataset.pid,10) }) }); refresh(); }
      catch (e) { alert('Stop failed: ' + e.message); }
    } else if (act === 'launch') {
      try { await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: t.dataset.cwd }) }); refresh(); }
      catch (e) { alert('Launch failed: ' + e.message); }
    } else if (act === 'forget') {
      if (!confirm('Remove this project from history?')) return;
      try { await api('/api/launcher/forget', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wsId: t.dataset.wsid }) }); refresh(); }
      catch (e) { alert('Forget failed: ' + e.message); }
    } else if (act === 'console') {
      openConsole(t.dataset.port, t.dataset.token, t.dataset.name, t.dataset.path, t.dataset.pub, t.dataset.lan);
    } else if (act === 'openterm') {
      openShell(t.dataset.cwd, t.dataset.name || t.dataset.cwd);
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
      // public: wss://ccv-<port>.xiaoyuervae.cn:9990/ws/terminal
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

  async function refresh() {
    try {
      const data = await api('/api/launcher/list');
      render(data.instances || [], data.history || []);
    }
    catch (e) { listEl.innerHTML = '<div class="empty err">'+escape(e.message)+'</div>'; }
  }

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
  document.getElementById('btn-new').onclick = () => { errEl.hidden = true; loadDir(_curDir || ''); dlg.showModal(); };
  document.getElementById('btn-cancel').onclick = () => dlg.close();
  document.getElementById('btn-launch').onclick = async () => {
    errEl.hidden = true;
    const cwd = cwdInput.value.trim();
    if (!cwd) { errEl.textContent='Pick a directory first'; errEl.hidden=false; return; }
    const btn = document.getElementById('btn-launch');
    btn.disabled = true; btn.textContent = 'Launching…';
    try {
      await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd }) });
      dlg.close(); refresh();
    } catch (e) { errEl.textContent = 'Launch failed: ' + e.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Launch'; }
  };

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
// public bookmark `https://ccv.xiaoyuervae.cn:9990/launcher` works without the
// caller knowing the hub's per-process token.
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
    sendJson(res, 200, { instances: running, history: idle });
    return;
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
      const { cwd } = JSON.parse(raw || '{}');
      const entry = await serializeSpawn(() => doSpawn(cwd));
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
    pty = require('/opt/homebrew/lib/node_modules/cc-viewer/node_modules/node-pty');
  } catch (err) {
    log('node-pty not available, /ws/shell disabled:', err.message);
    return;
  }
  const { WebSocketServer } = require('/opt/homebrew/lib/node_modules/cc-viewer/node_modules/ws');
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
        loadSessions();
        startWatcher();
        if (ctx?.httpServer) {
          installRequestMultiplexer(ctx.httpServer, ctx.protocol);
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
