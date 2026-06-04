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

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { log, jlog } from '../src/launcher/log.mjs';
import { loadSessions, isAuthenticated, getClientIp, subjectIdFor } from '../src/launcher/auth.mjs';

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
import {
  setSelfBinding,
  RUNTIME_DIR,
  rescanRuntime, backfillExternalCcvs, startWatcher,
} from '../src/launcher/runtime.mjs';

// Cap concurrent /ws/shell sessions per process. Each PTY holds a zsh + node
// listeners; on a public hub we want a hard ceiling so a runaway client (or
// pathological reconnect storm) can't exhaust file descriptors / RAM.
// SHELL_PTY_CAP is a soft pre-check before the manager spawns; the manager
// itself enforces MAX_PTY_TOTAL=10 (and 3/subject) authoritatively. We keep
// this as an early-reject so a caller saturating the cap gets a 1013 close
// before allocating ws+pty bookkeeping.
const SHELL_PTY_CAP = parseInt(process.env.CCV_SHELL_PTY_CAP || '8', 10);
// Reference to the /ws/shell WebSocketServer once installed; null until then.
// Used by /healthz to report `wsCount = wss.clients.size`. Kept at module
// scope (not closed-over) so the route handler can read it without plumbing.
let _shellWss = null;
// PtySessionManager singleton (PB3). Constructed lazily inside
// installShellWebSocket so node-pty/ws resolution failures are isolated to
// /ws/shell setup, not the whole plugin.
let _ptyManager = null;

// ---------- HTTP routes via beforeRequest hook ----------
// Dispatch + getInstanceActivity composer + PAIR_PAGE all live in
// src/launcher/http.mjs. Entry retains installRequestMultiplexer +
// installShellWebSocket because both wire into ctx.httpServer.
import { isLauncherPath, dispatchLauncherRoute, wireEntryBindings } from '../src/launcher/http.mjs';
import { startPoller, stopPoller } from '../src/launcher/push/poller.mjs';
import { startReaper, stopReaper } from '../src/launcher/reaper.mjs';
import { preloadVapid } from '../src/launcher/push/vapid.mjs';

// Plug entry-owned refs (ccv workspace registry + WS shell server) into the
// dispatcher. /healthz uses the WS counts; the workspace endpoints use the
// registry helpers. Done at module-eval time so dispatch is ready before the
// first request lands.
wireEntryBindings({
  getWorkspaces,
  removeWorkspace,
  shellPtyCap: SHELL_PTY_CAP,
  getShellWss: () => _shellWss,
  getPtyManager: () => _ptyManager,
});

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
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end('{"error":"launcher plugin error"}');
          } catch { /* socket may already be gone */ }
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
        const port = ctx?.port ?? null;
        const token = ctx?.token ?? null;
        setSelfBinding(port, token);
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
        log(`hub ready on port ${port}, watching ${RUNTIME_DIR}`);
        log(`open http://127.0.0.1:${port}/launcher (no token required on hub)`);
        // Pre-generate/load VAPID keypair so the first /push/subscribe
        // request doesn't pay the keygen latency (~30ms).
        try { preloadVapid(); } catch (err) { log('vapid preload error:', err.message); }
        // Start backend status-transition poller for Web Push delivery to
        // iOS PWA / Chrome / etc. Disabled via CCV_PUSH_POLL_MS=0 if needed.
        const pollMs = parseInt(process.env.CCV_PUSH_POLL_MS ?? '5000', 10);
        if (pollMs > 0) startPoller({ intervalMs: pollMs });
        // Auto-reap hub-spawned ccv children idle beyond CCV_IDLE_REAP_HOURS
        // (default 6h; set 0 to disable). Stops idle viewers from piling up and
        // dragging the machine down — they're resumable, so this is safe.
        const reapHours = parseFloat(process.env.CCV_IDLE_REAP_HOURS ?? '6');
        if (reapHours > 0) startReaper({ idleReapMs: reapHours * 3600_000 });
      } catch (err) {
        log('serverStarted error:', err.message);
      }
    },
    serverStopping: async () => {
      try { stopPoller(); } catch {}
      try { stopReaper(); } catch {}
    },
  },
};

// Belt-and-braces: cc-viewer's serverStopping isn't guaranteed to fire on
// every termination path (kill -9 obviously not, but also SIGTERM races).
// Stop the poller on signals too — it's idempotent.
for (const sig of ['SIGINT', 'SIGTERM']) {
  try { process.on(sig, () => { try { stopPoller(); } catch {} try { stopReaper(); } catch {} }); } catch {}
}
