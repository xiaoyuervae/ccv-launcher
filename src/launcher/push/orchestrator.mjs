// Server-side notification editor: takes a status transition, decides if
// it's worth pushing, builds the payload, fans out to every subscription
// in subs.mjs. Mirror of html-page.mjs's `detectStatusTransitions` rules.
//
// Why duplicate the map instead of importing from the client bundle? The
// client lives inside a template literal in HTML_PAGE; no clean import
// boundary. Duplicating the table is < 10 lines and keeps server logic
// readable on its own.

import { sendPush } from './send.mjs';
import { getAll as getAllSubs, getBySubject, removeByEndpoint, markOk, markFailure } from './subs.mjs';
import { log, jlog } from '../log.mjs';

// Same shape and copy as html-page.mjs's NOTIF_INTEREST. Keep titles + body
// templates literally identical so SW push and in-window Notification look
// the same — easier for the user to reason about.
const NOTIF_INTEREST = {
  waiting_ask:   { title: '需要回答', body: '%name 提了一个问题' },
  waiting_tool:  { title: '等待授权', body: '%name 的工具调用等待批准' },
  waiting_input: { title: '完成一轮', body: '%name 等待你的下一步指令' },
  error:         { title: '出错',     body: '%name 出现异常' },
};

const DEDUPE_WINDOW_MS = 20_000;
const _recentDedupKeys = new Map(); // key -> ts

function dedupCleanup() {
  const now = Date.now();
  for (const [k, ts] of _recentDedupKeys) if (now - ts > DEDUPE_WINDOW_MS) _recentDedupKeys.delete(k);
}

function isDuplicate(key) {
  dedupCleanup();
  if (_recentDedupKeys.has(key)) return true;
  _recentDedupKeys.set(key, Date.now());
  return false;
}

function instanceDisplayName(instance) {
  if (!instance) return '实例';
  return instance.alias || instance.displayName || instance.projectName
    || (instance.cwd ? String(instance.cwd).split('/').pop() : '')
    || ('PID ' + instance.pid);
}

// Build the tag the SW will pass to OS dedup. Same shape as the client's
// buildNotifTag so OS-level matching works if both fire.
function buildTag(pid, status, lastEventAt) {
  let stamp = 0;
  if (lastEventAt) {
    const t = Date.parse(lastEventAt);
    if (!Number.isNaN(t)) stamp = Math.floor(t / 1000);
  }
  return 'ccv-' + pid + '-' + status + '-' + stamp;
}

// Decide-and-fire entry point. The poller calls this exactly once per
// detected transition. activity is the same object getInstanceActivity
// returned for this tick.
export async function notifyTransition({ pid, prev, curr, instance, activity }) {
  const meta = NOTIF_INTEREST[curr];
  if (!meta) return { skipped: 'not_interesting', curr };
  // waiting_ask without a real pending ask payload is noise (status flapped
  // before pendingAsks landed). Mirror the client guard.
  if (curr === 'waiting_ask') {
    const asks = Array.isArray(activity?.pendingAsks) ? activity.pendingAsks : [];
    if (!asks.length) return { skipped: 'waiting_ask_empty', curr };
  }
  const lastEventAt = activity?.lastEventAt || null;
  const tag = buildTag(pid, curr, lastEventAt);
  // dedup at the (pid, status, second) granularity — if the same exact
  // transition somehow gets observed twice (cache TTL boundary races,
  // double-poll), don't double-fire.
  if (isDuplicate(tag)) return { skipped: 'dedup', tag };
  const name = instanceDisplayName(instance);
  const payload = {
    title: meta.title,
    body: meta.body.replace('%name', name),
    data: { tag, pid, status: curr, prev, kind: 'transition' },
  };
  const results = await fanout(payload);
  jlog('push-transition', { pid, prev, curr, fanout: results.length, ok: results.filter(r => r.ok).length });
  return { fired: true, tag, results };
}

// Fan out a payload to all stored subs. Returns per-sub result objects.
// 410/404 → remove from store immediately. 5xx → mark failure, keep sub.
export async function fanout(payload) {
  const subs = getAllSubs();
  const out = [];
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: s.keys }, payload);
      if (r.statusCode === 410 || r.statusCode === 404) {
        removeByEndpoint(s.endpoint, `fanout-${r.statusCode}`);
        out.push({ endpoint: s.endpoint, ok: false, status: r.statusCode, reason: 'gone' });
      } else if (r.statusCode >= 200 && r.statusCode < 300) {
        markOk(s.endpoint);
        out.push({ endpoint: s.endpoint, ok: true, status: r.statusCode });
      } else {
        markFailure(s.endpoint, r.statusCode);
        out.push({ endpoint: s.endpoint, ok: false, status: r.statusCode, body: r.body.slice(0, 200) });
      }
    } catch (err) {
      log(`[push:orch] fanout transport error: ${err.message}`);
      out.push({ endpoint: s.endpoint, ok: false, error: err.message });
    }
  }
  return out;
}

// Per-subject targeted send (e.g. for `/push/test` from a specific device).
// Doesn't dedup — caller explicitly wants this.
export async function sendToSubject(subjectId, payload) {
  const subs = getBySubject(subjectId);
  if (!subs.length) return { sent: 0, error: 'no subs for subject' };
  let sent = 0; const results = [];
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: s.keys }, payload, { urgency: 'normal' });
      results.push({ endpoint: s.endpoint, status: r.statusCode, body: r.body.slice(0, 200) });
      if (r.statusCode === 410 || r.statusCode === 404) removeByEndpoint(s.endpoint, `test-${r.statusCode}`);
      else if (r.statusCode < 300) sent++;
    } catch (err) {
      results.push({ endpoint: s.endpoint, error: err.message });
    }
  }
  return { sent, total: subs.length, results };
}
