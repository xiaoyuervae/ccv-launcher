// HTTP route layer + per-instance activity composer.
//
// Owns: PAIR_PAGE template, sendJson/readBody utils, isLauncherPath +
// isPairPath gate, dispatchLauncherRoute (the giant if-chain of endpoint
// handlers), plus getInstanceActivity (composes activity primitives with
// usage / claudemd / prefs into the per-card payload, with a 1.5s cache).
//
// Lives below all the domain modules; pulls EVERYTHING from them so the
// dispatcher only needs to know "what endpoint maps to what call".

import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { log, jlog } from './log.mjs';
import { HTML_PAGE } from './html-page.mjs';
import {
  RUNTIME_DIR, instances, setSelfBinding, safeJson, pidAlive, renderTemplate, buildPublicUrl, buildLanUrl, loadRuntimeFile, rescanRuntime, BACKFILL_TTL_MS, PROBE_TIMEOUT_MS, probeCcv, listListeningNodePids, readPidCwd, readPidStartedMs, backfillExternalCcvs, LOCAL_CC_CACHE_TTL_MS, decodeProjectDirName, readJsonlCwd, readJsonlLastTimestamp, readPidLstart, listLocalCcSessions, spawnCcvInTerminal, killClaudePid, startWatcher, serializeSpawn, nextFreePort, findRunningByCwd, waitForChildRuntime, _pidWorktrees, WORKTREE_NAME_RE, BRANCH_NAME_RE, isInsideDir, gitInCwd, detectBaseRef, createWorktree, removeWorktree, worktreeForPid, MD_FILE_MAX_BYTES, MD_PREVIEW_BYTES, MD_BACKUP_KEEP, HOME_CLAUDE_DIR, safeRealpath, isAllowedMdPath, safeReadPreview, pushMdFile, scanClaudeMd, backupMdBeforeWrite, doSpawn,
} from './runtime.mjs';
import {
  USAGE_CACHE_FILE, USAGE_CACHE_TTL_MS, loadPricing, loadModels, getModelInfo, computeContextUsage, priceForModel, emptyTokenBucket, computeCostForEntry, costFromUsage, usageFromEntries, readJsonlEntries, rangeStartMs, listSessionJsonlPaths, aggregateUsage, loadUsageCacheFromDisk, saveUsageCacheToDisk, refreshUsageInBackground, getCachedUsage, readInstanceUsage, encodeCwdToProjectDir, resolveNativeJsonl, CCLINE_CACHE_FILE, CLAUDE_CREDS_FILE, QUOTA_5H_MEM_TTL_MS, QUOTA_5H_DISK_TTL_MS, PLAN_THRESHOLDS, readCclineCache, readClaudeOauthToken, fetchOauthUsage, blocksFromTurns, detectPlan, p90, gatherTurnsForBlocks, computeFiveHourBlock, loadQuota5hFromDisk, saveQuota5hToDisk, buildQuota5h, refreshQuota5hInBackground, getCachedQuota5h, COMPACT_COOLDOWN_MS, injectPromptToCcv, checkCompactThresholds, readJsonlEntriesIndexed, truncateLabel, classifyEntry, JSONL_SCAN_TTL_MS, RUN_SUMMARY_MAX_EVENTS, ERROR_SAMPLES_PER_GROUP, scanJsonlAll, computeRunSummary, computeRecentEdits, computeErrors,
} from './usage.mjs';
import {
  ccvProjectName, findActiveLogFile, parseJsonlFilenameTime, pickInstanceLogs, findActiveLogFileForInstance, tailJsonlEntries, truncate, lastUserPrompt, lastUserPromptAcrossEntries, firstUserPrompt, stripUserPromptFraming, readFirstUserPrompt, inspectToolFlow, summarizeToolInput, summarizeEntry, ageString, fetchPendingAsks, deriveStatus, findRecentAssistantTextTs, isAssistantTextEnd,
} from './activity.mjs';
import {
  loadPrefs, savePrefs, normalizeAlias, getAlias, setAlias, getCcuseProfile, setCcuseProfile, setDefaultCcuseProfile, normalizeTag, getTags, setTags, addTag, removeTag, getAllTags, DEFAULT_COMPACT_THRESHOLD, getCompactThreshold, setCompactThreshold, getWorktreeDefault, setWorktreeDefault, listCcuseProfiles,
} from './prefs.mjs';
import {
  pendingPairs, approvedSessions, PAIR_CODE_TTL_MS, SESSION_MAX_AGE, loadSessions, saveSessions, generatePairCode, cleanExpiredPairs, parseCookies, isLanIp, getClientIp, isAuthenticated, shortUA, subjectIdFor,
} from './auth.mjs';

// ----- Entry-owned bindings -----
// /healthz reports shell-session counts (_shellWss / _ptyManager / SHELL_PTY_CAP)
// owned by installShellWebSocket in the entry. The pairing/workspace endpoints
// walk ccv's own workspace registry via getWorkspaces / removeWorkspace which
// the entry dynamic-imports at boot. Entry calls wireEntryBindings() once
// after both are available to plug them in here.
let _shellWss = null;
let _ptyManager = null;
let SHELL_PTY_CAP = 8;
let getWorkspaces = () => [];
let removeWorkspace = () => false;

export function wireEntryBindings(bindings = {}) {
  if (bindings.getShellWss) _shellWssGetter = bindings.getShellWss;
  if (bindings.getPtyManager) _ptyManagerGetter = bindings.getPtyManager;
  if (typeof bindings.shellPtyCap === 'number') SHELL_PTY_CAP = bindings.shellPtyCap;
  if (bindings.getWorkspaces) getWorkspaces = bindings.getWorkspaces;
  if (bindings.removeWorkspace) removeWorkspace = bindings.removeWorkspace;
}

let _shellWssGetter = () => _shellWss;
let _ptyManagerGetter = () => _ptyManager;

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

const ACTIVITY_CACHE_TTL_MS = 1500;
const _activityCache = new Map(); // pid -> { at, signature, payload }

// ---------- ccusage + 5h quota + run summary ----------
// Module lives in src/launcher/usage.mjs; entry just imports.

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
export function isLauncherPath(pathname) {
  return pathname === '/launcher' || pathname.startsWith('/launcher/') || pathname.startsWith('/api/launcher/') || pathname === '/healthz';
}

// Paths that don't require session auth (pair flow itself + healthz for monitors)
function isPairPath(pathname) {
  return pathname === '/launcher/pair' || pathname === '/launcher/pair/complete' || pathname.startsWith('/api/launcher/pair-') || pathname === '/healthz';
}

export async function dispatchLauncherRoute(req, res, parsedUrl) {
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
    const wss = _shellWssGetter();
    const ptyMgr = _ptyManagerGetter();
    const wsCount = wss ? wss.clients.size : 0;
    const ptyCount = ptyMgr ? ptyMgr._stats().sessions : 0;
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
