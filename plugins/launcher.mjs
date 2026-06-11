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
import { randomUUID } from 'node:crypto';

import { log, jlog } from '../src/launcher/log.mjs';
import { loadSessions, isAuthenticated, getClientIp, subjectIdFor } from '../src/launcher/auth.mjs';

// cc-viewer ships workspace-registry.js at the install root (≤1.6.266) or
// under server/ (≥1.6.273 refactor). Resolve by probing both locations.
// Shell PTY uses node-pty directly (no PtySessionManager dependency).
// Override roots via CCV_LIB_DIR.
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
// PtySessionManager no longer needed — shell uses self-contained HTTP
// transport (SSE + POST) with node-pty directly. No WebSocket.
let _shellNodePtyOk = false;
let _shellPty = null; // the node-pty module ref

const HUB_ENABLED = process.env.CCV_HUB === '1';
import {
  setSelfBinding,
  RUNTIME_DIR,
  rescanRuntime, backfillExternalCcvs, startWatcher,
} from '../src/launcher/runtime.mjs';

// Cap concurrent shell sessions. Each PTY holds a zsh + listeners; we hard-cap
// to prevent file-descriptor / RAM exhaustion from runaway clients.
const SHELL_PTY_CAP = parseInt(process.env.CCV_SHELL_PTY_CAP || '8', 10);
const SHELL_ORPHAN_TTL_MS = 5 * 60 * 1000; // 5 min before SIGTERM
const SHELL_ORPHAN_GRACE_MS = 10 * 1000;    // 10s SIGTERM→SIGKILL
const SHELL_RING_BUF_SIZE = 64 * 1024;      // 64KB replay buffer

// Self-contained PTY session map: sessionId → { pty, ringBuf, cwd, subjectId,
// orphanTimer, dataListeners, exitListeners, exited, exitCode }
const _shellSessions = new Map();

function _shellCreateSession(cwd, subjectId, ip) {
  if (!_shellPty || !_shellNodePtyOk) throw new Error('shell not available');
  if (_shellSessions.size >= SHELL_PTY_CAP) throw new Error('shell capacity reached');
  const sessionId = randomUUID();
  const shell = process.env.SHELL || '/bin/zsh';
  let safeCwd = cwd || homedir();
  try { safeCwd = realpathSync(safeCwd); } catch { /* keep as-is */ }
  if (!existsSync(safeCwd)) safeCwd = homedir();
  const proc = _shellPty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: safeCwd,
    env: { ...process.env, HOME: homedir() },
  });
  const session = {
    pty: proc,
    ringBuf: '',
    cwd: safeCwd,
    subjectId,
    orphanTimer: null,
    dataListeners: new Set(),
    exited: false,
    exitCode: null,
  };
  proc.onData((data) => {
    session.ringBuf += data;
    if (session.ringBuf.length > SHELL_RING_BUF_SIZE) {
      session.ringBuf = session.ringBuf.slice(-SHELL_RING_BUF_SIZE);
    }
    for (const fn of session.dataListeners) { try { fn(data); } catch {} }
  });
  proc.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    for (const fn of session.dataListeners) {
      try { fn(null, exitCode); } catch {}
    }
    if (session.orphanTimer) { clearTimeout(session.orphanTimer); session.orphanTimer = null; }
    _shellSessions.delete(sessionId);
  });
  _shellSessions.set(sessionId, session);
  jlog('shell-spawn', { sessionId: sessionId.slice(0,8), pid: proc.pid, cwd: safeCwd, subjectId, ip });
  return { sessionId, session, isReattach: false };
}

function _shellAttachSession(sessionId) {
  const session = _shellSessions.get(sessionId);
  if (!session) return null;
  if (session.orphanTimer) { clearTimeout(session.orphanTimer); session.orphanTimer = null; }
  return { sessionId, session, isReattach: true };
}

function _shellOrphan(sessionId) {
  const session = _shellSessions.get(sessionId);
  if (!session || session.exited) return;
  session.orphanTimer = setTimeout(() => {
    jlog('shell-orphan-sigterm', { sessionId: sessionId.slice(0,8) });
    try { session.pty.kill('SIGTERM'); } catch {}
    session.orphanTimer = setTimeout(() => {
      jlog('shell-orphan-sigkill', { sessionId: sessionId.slice(0,8) });
      try { session.pty.kill('SIGKILL'); } catch {}
      _shellSessions.delete(sessionId);
    }, SHELL_ORPHAN_GRACE_MS);
  }, SHELL_ORPHAN_TTL_MS);
}

// ---------- HTTP routes via beforeRequest hook ----------
// Dispatch + getInstanceActivity composer + PAIR_PAGE all live in
// src/launcher/http.mjs. Entry retains installRequestMultiplexer +
// installShellPty because both wire into ctx.httpServer.
import { isLauncherPath, dispatchLauncherRoute, wireEntryBindings } from '../src/launcher/http.mjs';
import { startPoller, stopPoller } from '../src/launcher/push/poller.mjs';
import { startReaper, stopReaper } from '../src/launcher/reaper.mjs';
import { preloadVapid } from '../src/launcher/push/vapid.mjs';

// Plug entry-owned refs into the dispatcher. Shell session helpers are used
// by the SSE/POST endpoints in http.mjs; workspace helpers by workspace routes.
wireEntryBindings({
  getWorkspaces,
  removeWorkspace,
  shellPtyCap: SHELL_PTY_CAP,
  shellCreateSession: _shellCreateSession,
  shellAttachSession: _shellAttachSession,
  shellOrphan: _shellOrphan,
  shellGetSession: (id) => _shellSessions.get(id),
  shellSessionCount: () => _shellSessions.size,
  shellAvailable: () => _shellNodePtyOk,
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

// ---- Shell PTY init: check node-pty availability ----
function installShellPty() {
  try {
    _shellPty = ccvRequire('node-pty');
    _shellNodePtyOk = true;
    log('shell pty ready (node-pty, HTTP transport)');
  } catch (err) {
    log('node-pty not available, shell disabled:', err.message);
  }
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
          installShellPty();
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
