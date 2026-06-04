// Idle-instance reaper. Runs in the hub process on a slow timer (default 5min).
// Auto-terminates ccv children the hub itself spawned once their session has
// been idle (or never started) beyond CCV_IDLE_REAP_HOURS.
//
// Why: every `+New`/spawn leaks a ~40MB node process + a held port + per-tick
// activity probes in the push poller. Nothing reaped them, so they accumulated
// until the machine was overloaded (the symptom that motivated this: 10 stale
// children, each polled every 5s, pinning load while the user only used one).
//
// Safety rails (all must pass before a child is killed):
//   * we spawned it — proven by the per-port launcher-logs/ccv-<port>.log that
//     doSpawn writes for every child. This survives hub restarts (an orphaned
//     child keeps its port + logfile), unlike a parent-pid check, which breaks
//     the moment the spawning hub cycles and the child reparents to launchd.
//     A ccv the user started by hand in a terminal has no such logfile.
//   * never the hub itself, external backfilled entries, or worktree-backed
//     children (those may hold uncommitted work on disk).
//   * only 'idle' (measured by lastEventAt age) and 'no_session' (measured by
//     process age) are reapable. Any active/awaiting state — thinking,
//     tool_running, waiting_tool, waiting_input, waiting_ask — is left alone so
//     a session that is merely waiting on the user is never killed.
//
// Reaping is reversible from the user's view: the child is just a viewer; the
// underlying Claude session jsonl persists and can be re-opened/resumed.

import { existsSync } from 'node:fs';
import { instances, rescanRuntime, killClaudePid, worktreeForPid, ccvLogPath } from './runtime.mjs';
import { getInstanceActivity } from './http.mjs';
import { log, jlog } from './log.mjs';

let _interval = null;
let _ticking = false;
const _stats = { ticks: 0, reaped: 0, lastTickAt: 0 };

const REAPABLE = new Set(['idle', 'no_session']);

async function tickOnce(idleReapMs) {
  if (_ticking) return; // skip overlap if a previous (slow) tick is still going
  _ticking = true;
  try {
    rescanRuntime();
    const now = Date.now();
    // Snapshot: killClaudePid mutates the live Map via the runtime watcher.
    for (const inst of [...instances.values()]) {
      if (inst.isHub || inst.external) continue;
      if (worktreeForPid(inst.pid)) continue;
      if (!inst.port || !existsSync(ccvLogPath(inst.port))) continue; // only ccvs we spawned
      let act;
      try { act = await getInstanceActivity(inst); }
      catch (err) { log(`[reaper] activity failed pid=${inst.pid}: ${err.message}`); continue; }
      const status = act?.status || 'no_session';
      if (!REAPABLE.has(status)) continue;
      let idleMs;
      if (status === 'idle') {
        const last = act.lastEventAt ? Date.parse(act.lastEventAt) : 0;
        idleMs = last ? now - last : Infinity; // idle with no parseable event ts → stale
      } else { // no_session: how long has this viewer sat with no session at all
        const started = inst.startedAt ? Date.parse(inst.startedAt) : (inst.startedAtMs || 0);
        if (!started) continue; // unknown start time → don't risk reaping
        idleMs = now - started;
      }
      if (idleMs < idleReapMs) continue;
      jlog('idle-reap', { pid: inst.pid, cwd: inst.cwd, status, idleMs: Math.round(idleMs) });
      log(`[reaper] reaping pid=${inst.pid} status=${status} idle=${Math.round(idleMs / 60000)}min cwd=${inst.cwd}`);
      try { await killClaudePid(inst.pid); _stats.reaped++; }
      catch (err) { log(`[reaper] kill failed pid=${inst.pid}: ${err.message}`); }
    }
    _stats.ticks++;
    _stats.lastTickAt = Date.now();
  } finally {
    _ticking = false;
  }
}

export function startReaper({ idleReapMs, intervalMs = 5 * 60_000 } = {}) {
  if (_interval) return; // already running
  if (!idleReapMs || idleReapMs <= 0) { log('[reaper] disabled (idleReapMs<=0)'); return; }
  _interval = setInterval(() => {
    tickOnce(idleReapMs).catch(err => log(`[reaper] tick err: ${err.message}`));
  }, intervalMs);
  if (typeof _interval.unref === 'function') _interval.unref();
  log(`[reaper] started idleReapMs=${idleReapMs} intervalMs=${intervalMs}`);
}

export function stopReaper() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export function getReaperStats() { return { ..._stats, running: !!_interval }; }
