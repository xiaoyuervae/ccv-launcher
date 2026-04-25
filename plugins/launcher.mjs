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

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch } from 'node:fs';
import { join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

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

// in-memory instance map: pid → runtime payload (with augmented urls / status)
const instances = new Map();
let _selfPort = null;
let _selfToken = null;

function log(...args) { console.error(PREFIX, ...args); }

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

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccv launcher</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<style>
  :root { --bg:#0f1115; --fg:#e6e8ec; --mute:#9aa3ad; --line:#1c2129; --card:#161a22; --accent:#6ea8fe; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(15,17,21,.92); backdrop-filter:blur(8px); z-index:10; }
  header h1 { font-size:16px; font-weight:600; margin:0; }
  header .meta { color:var(--mute); font-size:12px; }
  header .grow { flex:1; }
  header button { background:var(--accent); color:#0b1220; border:0; padding:8px 14px; border-radius:8px; font-weight:600; cursor:pointer; }
  main { max-width:1100px; margin:0 auto; padding:20px; display:grid; gap:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:grid; grid-template-columns:auto 1fr auto; gap:12px 16px; align-items:center; }
  .card .badge { width:8px; height:8px; border-radius:50%; }
  .card.running .badge { background:var(--ok); box-shadow:0 0 6px var(--ok); }
  .card.hub .badge { background:var(--accent); box-shadow:0 0 6px var(--accent); }
  .card .name { font-weight:600; }
  .card .path { color:var(--mute); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
  .card .url  { color:var(--mute); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; margin-top:4px; }
  .card .url a { color:var(--mute); text-decoration:none; }
  .card .url a:hover { color:var(--accent); }
  .card .stats { color:var(--mute); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; margin-top:4px; }
  .card .actions { display:flex; flex-direction:column; gap:6px; }
  .card .actions button { background:transparent; color:var(--fg); border:1px solid var(--line); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; min-width:74px; }
  .card .actions button:hover { border-color:var(--accent); color:var(--accent); }
  .card .actions button.danger:hover { border-color:var(--bad); color:var(--bad); }
  details summary { cursor:pointer; color:var(--mute); font-size:12px; padding:4px 0; user-select:none; }
  details[open] summary { color:var(--accent); }
  .qr { padding:10px; background:#fff; border-radius:8px; display:inline-block; margin-top:8px; }
  .qr canvas { display:block; }
  dialog { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:12px; padding:20px; max-width:520px; width:92%; }
  dialog::backdrop { background:rgba(0,0,0,.5); }
  dialog h2 { margin:0 0 12px; font-size:15px; }
  dialog input { width:100%; padding:8px 10px; background:#0a0d12; color:var(--fg); border:1px solid var(--line); border-radius:6px; font-family:ui-monospace,monospace; font-size:13px; margin-bottom:8px; }
  dialog .row { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
  dialog button { background:transparent; color:var(--fg); border:1px solid var(--line); padding:6px 14px; border-radius:6px; cursor:pointer; }
  dialog button.primary { background:var(--accent); color:#0b1220; border-color:var(--accent); font-weight:600; }
  .tree { font-family:ui-monospace,monospace; font-size:12px; color:var(--mute); max-height:240px; overflow:auto; background:#0a0d12; padding:8px; border-radius:6px; }
  .tree .row { padding:3px 6px; cursor:pointer; border-radius:3px; display:flex; gap:6px; align-items:center; }
  .tree .row:hover { background:#1a1f2a; color:var(--fg); }
  .tree .row.dir::before { content:"📁"; }
  .tree .row.up::before  { content:"↩"; }
  .err { color:var(--bad); font-size:12px; margin-top:6px; }
  .empty { color:var(--mute); text-align:center; padding:60px 20px; font-size:13px; }
  footer { padding:12px 20px; border-top:1px solid var(--line); color:var(--mute); font-size:11px; text-align:center; }
</style>
</head>
<body>
<header>
  <h1>ccv launcher</h1>
  <span class="meta" id="meta">loading…</span>
  <span class="grow"></span>
  <button id="btn-new">+ New instance</button>
</header>
<main id="list"><div class="empty">loading instances…</div></main>
<footer>ccv launcher · plugin: <code>launcher.mjs</code></footer>

<dialog id="dlg">
  <h2>Launch a new ccv instance</h2>
  <div style="color:var(--mute);font-size:12px">cwd:</div>
  <input id="cwd" placeholder="/path/to/project">
  <div class="tree" id="tree"></div>
  <div class="err" id="err" hidden></div>
  <div class="row">
    <button id="btn-cancel">Cancel</button>
    <button class="primary" id="btn-launch">Launch</button>
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

  function render(items) {
    metaEl.textContent = items.length + ' instance' + (items.length===1?'':'s');
    if (!items.length) {
      listEl.innerHTML = '<div class="empty">no ccv instances running. Click "+ New instance" to launch one.</div>';
      return;
    }
    items.sort((a,b) => (b.isHub?1:0) - (a.isHub?1:0) || (a.port||0) - (b.port||0));
    listEl.innerHTML = items.map(it => {
      const cls = it.isHub ? 'card hub' : 'card running';
      const name = escape(it.projectName || '?');
      const path = escape(it.cwd || '');
      const pub = escape(it.publicUrl || '');
      const lan = escape(it.lanUrl || '');
      const stopBtn = it.isHub
        ? ''
        : '<button class="danger" data-act="stop" data-pid="'+it.pid+'" data-name="'+name+'">Stop</button>';
      const openHref = pub || lan || '#';
      return ''
        + '<div class="'+cls+'" data-pid="'+it.pid+'">'
        +   '<span class="badge"></span>'
        +   '<div>'
        +     '<div class="name">'+name+(it.isHub ? ' <span style="color:var(--accent);font-size:11px">[hub]</span>':'')+'</div>'
        +     '<div class="path">'+path+'</div>'
        +     '<div class="stats"><span>:'+(it.port||'?')+'</span><span>pid '+it.pid+'</span><span>up '+fmtAge(it.startedAt)+'</span><span>'+escape(it.version||'')+'</span></div>'
        +     '<details><summary>show URLs · QR</summary>'
        +       (lan ? '<div class="url">local:&nbsp; <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>':'')
        +       (pub ? '<div class="url">public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>':'')
        +       (pub ? '<div class="qr"><canvas data-qr="'+pub+'"></canvas></div>':'')
        +     '</details>'
        +   '</div>'
        +   '<div class="actions">'
        +     '<button data-act="open" data-href="'+escape(openHref)+'">Open</button>'
        +     '<button data-act="copy" data-text="'+(pub||lan)+'">Copy URL</button>'
        +     stopBtn
        +   '</div>'
        + '</div>';
    }).join('');
    listEl.querySelectorAll('canvas[data-qr]').forEach(c => {
      try { QRCode.toCanvas(c, c.dataset.qr, { width:130, margin:1 }); } catch(e){}
    });
  }

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
    }
  });

  async function refresh() {
    try { const data = await api('/api/launcher/list'); render(data.instances || []); }
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

  refresh();
  // 30s polling: new/kill flows refresh immediately on user action, so
  // background polling only catches out-of-band changes (e.g. another tab
  // spawned, hub auto-restarted). Public bandwidth concern beats latency here.
  setInterval(refresh, 30000);
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
// caller knowing the hub's per-process token. NPM Basic Auth still gates
// inbound traffic from the public Internet.
function isLauncherPath(pathname) {
  return pathname === '/launcher' || pathname.startsWith('/api/launcher/');
}

async function dispatchLauncherRoute(req, res, parsedUrl) {
  const url = parsedUrl.pathname;
  const method = req.method;

  // CORS — mirror ccv's defaults so cross-origin tools behave consistently.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/launcher' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (url === '/api/launcher/list' && method === 'GET') {
    rescanRuntime();
    sendJson(res, 200, { instances: [...instances.values()] });
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
        startWatcher();
        if (ctx?.httpServer) {
          installRequestMultiplexer(ctx.httpServer, ctx.protocol);
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
