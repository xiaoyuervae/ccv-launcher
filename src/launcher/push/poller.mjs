// Background status-transition poller. Runs in the hub process. Every 5s
// (default), iterates running instances, calls getInstanceActivity (which
// has its own 1.5s cache so the client's 3s poll usually shares results),
// diffs status against lastStatusByPid, fires Web Push on interesting
// transitions via orchestrator.notifyTransition.
//
// First scan after start (or after stopPoller+startPoller) ONLY sets the
// baseline — never fires. This is critical: a launcher restart must not
// retroactively push every running instance's current state.
//
// Per-instance failures swallow + log; one slow probe can't stall the
// whole tick, but we await sequentially to avoid stampeding when many
// instances exist.

import { instances, rescanRuntime, backfillExternalCcvs } from '../runtime.mjs';
import { getInstanceActivity } from '../http.mjs';
import { notifyTransition } from './orchestrator.mjs';
import { log, jlog } from '../log.mjs';

let _interval = null;
let _ticking = false;
let _didFirstScan = false;
const _lastStatusByPid = new Map();
const _stats = { ticks: 0, lastTickAt: 0, firedTotal: 0 };

async function tickOnce() {
  if (_ticking) return; // skip overlap if previous tick is slow
  _ticking = true;
  const startedAt = Date.now();
  try {
    rescanRuntime();
    await backfillExternalCcvs();
    const list = [...instances.values()];
    let fired = 0;
    for (const inst of list) {
      if (inst.isHub) continue;
      let act;
      try { act = await getInstanceActivity(inst); }
      catch (err) { log(`[push:poll] activity failed pid=${inst.pid}: ${err.message}`); continue; }
      const curr = act?.status || 'no_session';
      const prev = _lastStatusByPid.get(inst.pid);
      if (!_didFirstScan) {
        _lastStatusByPid.set(inst.pid, curr);
        continue;
      }
      if (prev === undefined) {
        // New instance appeared between ticks: set baseline, don't fire.
        _lastStatusByPid.set(inst.pid, curr);
        continue;
      }
      if (curr !== prev) {
        _lastStatusByPid.set(inst.pid, curr);
        try {
          const r = await notifyTransition({ pid: inst.pid, prev, curr, instance: inst, activity: act });
          if (r && r.fired) fired++;
        } catch (err) {
          log(`[push:poll] notify failed pid=${inst.pid}: ${err.message}`);
        }
      }
    }
    // Prune lastStatus entries for instances that disappeared (so a future
    // pid reuse doesn't inherit stale prev). Keep this loop after the
    // detection pass — we want the dropped pid not to count as "prev set".
    const live = new Set(list.map(i => i.pid));
    for (const pid of _lastStatusByPid.keys()) if (!live.has(pid)) _lastStatusByPid.delete(pid);
    if (!_didFirstScan) {
      _didFirstScan = true;
      jlog('push-poll-first-scan', { instances: list.length });
    }
    _stats.ticks++;
    _stats.firedTotal += fired;
    _stats.lastTickAt = Date.now();
    if (fired || _stats.ticks % 12 === 0) {
      jlog('push-poll-tick', {
        instances: list.length,
        durationMs: Date.now() - startedAt,
        fired,
        firstScan: !_didFirstScan, // always false here (set just above), kept for clarity in old logs
      });
    }
  } finally {
    _ticking = false;
  }
}

export function startPoller({ intervalMs = 5000 } = {}) {
  if (_interval) return; // already running
  _didFirstScan = false;
  _lastStatusByPid.clear();
  // Defer first tick by 1s so serverStarted finishes + runtime watcher
  // catches up before we observe anything. Otherwise the "first scan"
  // baseline is half-populated.
  setTimeout(() => { tickOnce().catch(err => log(`[push:poll] first tick err: ${err.message}`)); }, 1000);
  _interval = setInterval(() => { tickOnce().catch(err => log(`[push:poll] tick err: ${err.message}`)); }, intervalMs);
  if (typeof _interval.unref === 'function') _interval.unref();
  log(`[push:poll] started intervalMs=${intervalMs}`);
}

export function stopPoller() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _didFirstScan = false;
  _lastStatusByPid.clear();
  log('[push:poll] stopped');
}

export function getPollerStats() {
  return { ..._stats, didFirstScan: _didFirstScan, tracked: _lastStatusByPid.size, running: !!_interval };
}
