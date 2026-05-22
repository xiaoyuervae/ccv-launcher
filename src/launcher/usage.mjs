// ccusage-style usage + cost reducer, 5h-quota tiers, compact-threshold
// monitoring, and Run Summary / Recent Edits / Errors aggregators.
//
// All of this reads Claude Code's NATIVE session jsonls at
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// (NOT ccv's intercepted logs — those are activity.mjs's job). The native
// jsonls carry `message.usage.{input,output,cache_creation,cache_read}_tokens`
// which is what pricing math needs.
//
// Caching strategy is stale-while-revalidate everywhere: cold misses return
// the last-known value (or a {pending:true} sentinel) plus a background
// refresh; the next caller gets fresh data without blocking the first.

import { existsSync, statSync, readFileSync, writeFileSync, createReadStream, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

import { log, jlog } from './log.mjs';
import { getCompactThreshold } from './prefs.mjs';

// ---------- ccusage-style usage / cost reducer ----------
// Reads Claude Code's native session jsonl files at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Each `assistant`-typed
// entry carries `message.usage` (input_tokens / output_tokens /
// cache_creation_input_tokens / cache_read_input_tokens) and we dedup by
// (sessionId, message.id, requestId) because a single turn is rewritten on
// resume. Pricing comes from vendor/pricing.json (USD per 1M tokens, with
// optional above_200k tier for the Sonnet 4 1M-context model).

// PLUGIN_DIR points at this module file (src/launcher/usage.mjs).
// Repo root vendor/ dir is two levels up.
const PLUGIN_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));
const PRICING_PATH = join(PLUGIN_DIR, '..', '..', 'vendor', 'pricing.json');
const MODELS_PATH = join(PLUGIN_DIR, '..', '..', 'vendor', 'models.json');
export const USAGE_CACHE_FILE = join(homedir(), '.claude', 'cc-viewer', 'launcher-cache.json');
export const USAGE_CACHE_TTL_MS = 60_000;

let _pricingCache = null;
let _modelsCache = null;

export function loadPricing() {
  if (_pricingCache) return _pricingCache;
  try {
    const raw = JSON.parse(readFileSync(PRICING_PATH, 'utf-8'));
    delete raw._meta;
    _pricingCache = raw;
  } catch (err) {
    log('loadPricing error:', err.message);
    _pricingCache = {};
  }
  return _pricingCache;
}

export function loadModels() {
  if (_modelsCache) return _modelsCache;
  try {
    _modelsCache = JSON.parse(readFileSync(MODELS_PATH, 'utf-8'));
  } catch (err) {
    log('loadModels error:', err.message);
    _modelsCache = { models: {}, fallback: { context_limit: 200000 } };
  }
  return _modelsCache;
}

// vendor/models.json lookup honoring [1m] modifier and family fallback. Used
// by the context-% reducer (T4) and exposed verbatim on contextUsage payloads
// so UI doesn't re-implement the lookup.
export function getModelInfo(modelId) {
  const data = loadModels();
  const models = data.models || {};
  const fallbackLimit = (data.fallback && data.fallback.context_limit) || 200000;
  if (!modelId || typeof modelId !== 'string') {
    return { model_id: modelId || 'unknown', display_name: 'unknown', context_limit: fallbackLimit };
  }
  let baseId = modelId;
  let appliedModifier = null;
  for (const mod of (data.context_modifiers || [])) {
    if (mod.pattern && modelId.includes(mod.pattern)) {
      baseId = modelId.replace(mod.pattern, '');
      appliedModifier = mod;
      break;
    }
  }
  let entry = models[baseId];
  if (!entry) {
    // Family fallback — same heuristics as priceForModel; keeps lookup
    // resilient when a brand-new model id appears before vendor/models.json
    // is refreshed.
    if (baseId.includes('opus-4-7')) entry = models['claude-opus-4-7'];
    else if (baseId.includes('opus-4-6')) entry = models['claude-opus-4-6'];
    else if (baseId.includes('opus-4-5')) entry = models['claude-opus-4-5'];
    else if (baseId.includes('opus-4-1')) entry = models['claude-opus-4-1'];
    else if (baseId.includes('opus')) entry = models['claude-opus-4-7'];
    else if (baseId.includes('sonnet-4-7')) entry = models['claude-sonnet-4-7'];
    else if (baseId.includes('sonnet-4-6')) entry = models['claude-sonnet-4-6'];
    else if (baseId.includes('sonnet-4-5')) entry = models['claude-sonnet-4-5'];
    else if (baseId.includes('sonnet-4')) entry = models['claude-sonnet-4-20250514'];
    else if (baseId.includes('haiku')) entry = models['claude-haiku-4-5'];
  }
  let context_limit = (entry && entry.context_limit) || fallbackLimit;
  let display_name = (entry && entry.display_name) || baseId;
  if (appliedModifier) {
    if (appliedModifier.context_limit) context_limit = appliedModifier.context_limit;
    if (appliedModifier.display_suffix) display_name += appliedModifier.display_suffix;
  }
  return { model_id: modelId, display_name, context_limit };
}

// Context-window utilization from a per-entry usage snapshot. "Used" = prompt
// size (input + cache_creation + cache_read) only; output is the response, not
// part of what consumes the context window. Mirrors ccusage's UsageStats and
// ClaudeBar's UsageSnapshot semantics.
export function computeContextUsage(lastEntry) {
  if (!lastEntry || !lastEntry.model) return null;
  const used = (+lastEntry.input || 0)
             + (+lastEntry.cache_creation || 0)
             + (+lastEntry.cache_read || 0);
  const info = getModelInfo(lastEntry.model);
  const limit = info.context_limit || 200000;
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return {
    used,
    limit,
    percent: Math.round(percent * 10) / 10,
    model: lastEntry.model,
    displayName: info.display_name,
    ts: lastEntry.ts || null,
  };
}

export function priceForModel(modelId) {
  const pricing = loadPricing();
  if (modelId && pricing[modelId]) return pricing[modelId];
  if (typeof modelId === 'string') {
    if (modelId.includes('opus-4-7')) return pricing['claude-opus-4-7'];
    if (modelId.includes('opus-4-6')) return pricing['claude-opus-4-6'];
    if (modelId.includes('opus-4-5')) return pricing['claude-opus-4-5'];
    if (modelId.includes('opus-4-1')) return pricing['claude-opus-4-1'];
    if (modelId.includes('opus')) return pricing['claude-opus-4-7'];
    if (modelId.includes('sonnet-4-7')) return pricing['claude-sonnet-4-7'];
    if (modelId.includes('sonnet-4-6')) return pricing['claude-sonnet-4-6'];
    if (modelId.includes('sonnet-4-5')) return pricing['claude-sonnet-4-5'];
    if (modelId.includes('sonnet-4')) return pricing['claude-sonnet-4-20250514'];
    if (modelId.includes('haiku')) return pricing['claude-haiku-4-5'];
  }
  return null;
}

export function emptyTokenBucket() { return { input: 0, output: 0, cache_creation: 0, cache_read: 0 }; }

// LiteLLM tier semantics: when a request's prompt size > 200k, the entire
// request bills at the model's above_200k rates (input_above_200k etc.). We
// compute cost per-entry so the tier is preserved; the aggregator sums dollars
// across entries.
export function computeCostForEntry(model, usage) {
  const p = priceForModel(model);
  if (!p) return 0;
  const inp = +usage.input_tokens || 0;
  const out = +usage.output_tokens || 0;
  const cw = +usage.cache_creation_input_tokens || 0;
  const cr = +usage.cache_read_input_tokens || 0;
  const promptSize = inp + cw + cr;
  const tier = (promptSize > 200000 && p.input_above_200k != null)
    ? {
        input: p.input_above_200k,
        output: p.output_above_200k != null ? p.output_above_200k : p.output,
        cache_creation: p.cache_creation_above_200k != null ? p.cache_creation_above_200k : p.cache_creation,
        cache_read: p.cache_read_above_200k != null ? p.cache_read_above_200k : p.cache_read,
      }
    : { input: p.input, output: p.output, cache_creation: p.cache_creation, cache_read: p.cache_read };
  return (inp * tier.input + out * tier.output + cw * tier.cache_creation + cr * tier.cache_read) / 1e6;
}

// Untiered fallback for already-aggregated buckets — use only when per-request
// prompt size has been lost. The real reducers compute cost per-entry above.
export function costFromUsage(byModel) {
  const byModelUSD = {};
  let total = 0;
  for (const [m, u] of Object.entries(byModel)) {
    const p = priceForModel(m);
    if (!p) { byModelUSD[m] = 0; continue; }
    const c = (u.input * p.input + u.output * p.output
              + u.cache_creation * p.cache_creation + u.cache_read * p.cache_read) / 1e6;
    byModelUSD[m] = c; total += c;
  }
  return { total, byModel: byModelUSD };
}

// In-memory reducer for already-decoded entries. Used when we already have a
// jsonl tail in hand (avoids re-streaming). Caller passes a Set for dedup
// scope (same Set across calls = global dedup).
export function usageFromEntries(entries, dedupSet) {
  const byModel = {};
  let totalUSD = 0;
  let requestCount = 0;
  let lastEntry = null;
  for (const e of entries || []) {
    if (!e || e.type !== 'assistant') continue;
    const msg = e.message;
    const u = msg && msg.usage;
    if (!u) continue;
    const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
    if (dedupSet) {
      if (dedupSet.has(key)) continue;
      dedupSet.add(key);
    }
    const model = (msg && msg.model) || 'unknown';
    const b = byModel[model] || (byModel[model] = emptyTokenBucket());
    b.input += +u.input_tokens || 0;
    b.output += +u.output_tokens || 0;
    b.cache_creation += +u.cache_creation_input_tokens || 0;
    b.cache_read += +u.cache_read_input_tokens || 0;
    totalUSD += computeCostForEntry(model, u);
    requestCount++;
    lastEntry = {
      model,
      input: +u.input_tokens || 0,
      output: +u.output_tokens || 0,
      cache_creation: +u.cache_creation_input_tokens || 0,
      cache_read: +u.cache_read_input_tokens || 0,
      ts: e.timestamp || null,
    };
  }
  return { byModel, costUSD: totalUSD, requestCount, lastEntry };
}

export async function readJsonlEntries(path, onEntry) {
  // Stream a jsonl line-by-line so we can scale to 100s-of-MB session logs
  // without materializing the whole file.
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    onEntry(obj);
  }
}

export function rangeStartMs(range) {
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === 'month') {
    const d = new Date(now); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return 0;
}

export function listSessionJsonlPaths() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out = [];
  let projDirs;
  try { projDirs = readdirSync(PROJECTS_DIR); } catch { return []; }
  for (const proj of projDirs) {
    const projDir = join(PROJECTS_DIR, proj);
    let st; try { st = statSync(projDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files; try { files = readdirSync(projDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      out.push(join(projDir, f));
    }
  }
  return out;
}

export async function aggregateUsage({ range = 'today', cwd: cwdFilter = '' } = {}) {
  const startMs = rangeStartMs(range);
  const paths = listSessionJsonlPaths();
  const byModel = {};
  const byModelUSD = {};
  let totalUSD = 0;
  let requestCount = 0;
  const dedup = new Set();
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { continue; }
    // mtime predates the range → file can't contain in-range turns.
    if (st.mtimeMs < startMs) continue;
    await readJsonlEntries(p, (e) => {
      if (!e || e.type !== 'assistant') return;
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (ts && ts < startMs) return;
      if (cwdFilter && e.cwd !== cwdFilter) return;
      const msg = e.message;
      const u = msg && msg.usage;
      if (!u) return;
      const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
      if (dedup.has(key)) return;
      dedup.add(key);
      const model = (msg && msg.model) || 'unknown';
      const b = byModel[model] || (byModel[model] = emptyTokenBucket());
      b.input += +u.input_tokens || 0;
      b.output += +u.output_tokens || 0;
      b.cache_creation += +u.cache_creation_input_tokens || 0;
      b.cache_read += +u.cache_read_input_tokens || 0;
      const cost = computeCostForEntry(model, u);
      byModelUSD[model] = (byModelUSD[model] || 0) + cost;
      totalUSD += cost;
      requestCount++;
    });
  }
  return { totalUSD, byModel, byModelUSD, requestCount, range, cwd: cwdFilter, computedAt: Date.now() };
}

// ---- summary cache (60s TTL, stale-while-revalidate, persisted to disk) ----
let _usageMem = null;
const _usageRefreshing = new Set();

export function loadUsageCacheFromDisk() {
  if (_usageMem) return _usageMem;
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8'));
      _usageMem = raw && raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
    } else _usageMem = {};
  } catch { _usageMem = {}; }
  return _usageMem;
}

export function saveUsageCacheToDisk() {
  try {
    const dir = dirname(USAGE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let cur = {};
    if (existsSync(USAGE_CACHE_FILE)) {
      try { cur = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8')) || {}; } catch { cur = {}; }
    }
    cur.usage = _usageMem;
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cur, null, 2));
  } catch (err) { log('saveUsageCacheToDisk error:', err.message); }
}

export function refreshUsageInBackground(key, params) {
  if (_usageRefreshing.has(key)) return;
  _usageRefreshing.add(key);
  aggregateUsage(params)
    .then((result) => {
      const mem = loadUsageCacheFromDisk();
      mem[key] = result;
      saveUsageCacheToDisk();
    })
    .catch((err) => log('aggregateUsage refresh error:', err.message))
    .finally(() => _usageRefreshing.delete(key));
}

export async function getCachedUsage(params) {
  const key = `${params.range}#${params.cwd || ''}`;
  const mem = loadUsageCacheFromDisk();
  const hit = mem[key];
  const now = Date.now();
  if (hit && now - hit.computedAt < USAGE_CACHE_TTL_MS) {
    return { ...hit, fromCache: true, stale: false };
  }
  if (hit) {
    refreshUsageInBackground(key, params);
    return { ...hit, fromCache: true, stale: true };
  }
  // Cold miss. The synchronous fallback used to await aggregateUsage(),
  // which on a heavy "month" range scans ~30 days of native jsonls and
  // can take >5s — long enough that the UI's 10s polling-with-timeout
  // would error out. Instead: kick the scan as a background refresh and
  // return a pending placeholder with computedAt=0 so UI can render a
  // "..." spinner. The next poll picks up the real result from cache.
  // Claude Code's native session jsonls are named <sessionId>.jsonl
  // (UUID), so filename-date pre-filtering doesn't apply here — mtime
  // already filters at the file level and the per-line ts < startMs skip
  // is already in place. Cold-scan cost is dominated by JSON.parse on
  // in-range files; this placeholder shields the wire from that latency.
  refreshUsageInBackground(key, params);
  return {
    totalUSD: 0,
    byModel: {},
    byModelUSD: {},
    requestCount: 0,
    range: params.range,
    cwd: params.cwd || '',
    computedAt: 0,
    fromCache: false,
    stale: true,
    pending: true,
  };
}

// ---- per-instance session reducer ----
// Cache key = jsonl path; invalidated whenever (mtime, size) changes. Native
// session jsonls grow append-only, so a same-mtime/same-size hit means
// "nothing new since last scan".
const _instanceUsageCache = new Map();

export async function readInstanceUsage(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return null;
  let st; try { st = statSync(jsonlPath); } catch { return null; }
  const cached = _instanceUsageCache.get(jsonlPath);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
  const byModel = {};
  let totalUSD = 0;
  let requestCount = 0;
  const dedup = new Set();
  let lastEntry = null;
  await readJsonlEntries(jsonlPath, (e) => {
    if (!e || e.type !== 'assistant') return;
    const msg = e.message;
    const u = msg && msg.usage;
    if (!u) return;
    const key = (e.sessionId || '') + '|' + ((msg && msg.id) || e.uuid || '') + '|' + (e.requestId || '');
    if (dedup.has(key)) return;
    dedup.add(key);
    const model = (msg && msg.model) || 'unknown';
    const b = byModel[model] || (byModel[model] = emptyTokenBucket());
    b.input += +u.input_tokens || 0;
    b.output += +u.output_tokens || 0;
    b.cache_creation += +u.cache_creation_input_tokens || 0;
    b.cache_read += +u.cache_read_input_tokens || 0;
    totalUSD += computeCostForEntry(model, u);
    requestCount++;
    lastEntry = {
      model,
      input: +u.input_tokens || 0,
      output: +u.output_tokens || 0,
      cache_creation: +u.cache_creation_input_tokens || 0,
      cache_read: +u.cache_read_input_tokens || 0,
      ts: e.timestamp || null,
    };
  });
  const totals = emptyTokenBucket();
  for (const u of Object.values(byModel)) {
    totals.input += u.input;
    totals.output += u.output;
    totals.cache_creation += u.cache_creation;
    totals.cache_read += u.cache_read;
  }
  const result = {
    mtime: st.mtimeMs, size: st.size,
    totals, byModel, costUSD: totalUSD, requestCount, lastEntry,
  };
  _instanceUsageCache.set(jsonlPath, result);
  return result;
}

export function encodeCwdToProjectDir(cwd) {
  // Inverse of decodeProjectDirName: Claude Code flattens "/" → "-".
  return cwd.replace(/\//g, '-');
}

// Map an instance to its native Claude Code session jsonl. External claude
// processes carry the resolved path on the instance (parsed from `ps`); for
// ccv-managed instances we fall back to the most recently-touched jsonl in
// the encoded-cwd project dir.
export function resolveNativeJsonl(instance) {
  if (!instance) return null;
  if (instance.jsonlPath && existsSync(instance.jsonlPath)) return instance.jsonlPath;
  if (!instance.cwd) return null;
  const dir = join(PROJECTS_DIR, encodeCwdToProjectDir(instance.cwd));
  if (!existsSync(dir)) return null;
  let files; try { files = readdirSync(dir); } catch { return null; }
  let best = null;
  let bestM = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(dir, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = p; }
  }
  return best;
}

// ---------- end usage / cost reducer ----------

// ---------- 5h quota window (tiered) ----------
// Tier 1: ccline cache (~/.claude/ccline/.api_usage_cache.json) — utilization
//   only, refreshed every 5 min by the ccline statusline binary.
// Tier 2: direct call to /api/oauth/usage — needs an oauth-2025-04-20-scoped
//   access_token. ClaudeBar-style keychain integration is out of scope for
//   v1; we attempt only when ~/.claude/.credentials.json exists with an
//   access_token in cleartext. Otherwise we skip to tier 3.
// Tier 3: jsonl_compute — local 5h block reducer (ccusage `blocks` algorithm,
//   gap-detected, with auto-detected plan and P90 burn rate).
// All tiers cached 30s in memory + 5min on disk (launcher-cache.json).
export const CCLINE_CACHE_FILE = join(homedir(), '.claude', 'ccline', '.api_usage_cache.json');
export const CLAUDE_CREDS_FILE = join(homedir(), '.claude', '.credentials.json');
export const QUOTA_5H_MEM_TTL_MS = 30_000;
export const QUOTA_5H_DISK_TTL_MS = 5 * 60_000;
export const PLAN_THRESHOLDS = [
  { name: 'Pro', limit: 19000 },
  { name: 'Max5', limit: 88000 },
  { name: 'Max20', limit: 220000 },
];

let _quota5hMem = null;
let _quota5hRefreshing = false;

export function readCclineCache() {
  if (!existsSync(CCLINE_CACHE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CCLINE_CACHE_FILE, 'utf-8'));
    const cachedAt = raw.cached_at ? Date.parse(raw.cached_at) : 0;
    const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
    return {
      five_hour_utilization: typeof raw.five_hour_utilization === 'number' ? raw.five_hour_utilization : null,
      seven_day_utilization: typeof raw.seven_day_utilization === 'number' ? raw.seven_day_utilization : null,
      // Note: ccline cache's `resets_at` is the *seven-day* reset, not 5h —
      // we surface it but tag it accordingly so UI doesn't render it as the
      // 5h countdown. ClaudeBar itself doesn't trust this field for 5h.
      seven_day_resets_at: raw.resets_at || null,
      cached_at: raw.cached_at || null,
      ageMs,
      stale: ageMs > 5 * 60_000,
    };
  } catch (err) {
    log('readCclineCache error:', err.message);
    return null;
  }
}

// Tier-2 token retrieval: best-effort cleartext credentials.json. macOS
// keychain access via `security` would block on user approval and isn't
// suitable for an unattended hub. Returns null when unavailable.
export function readClaudeOauthToken() {
  if (!existsSync(CLAUDE_CREDS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_CREDS_FILE, 'utf-8'));
    const t = raw && raw.claudeAiOauth && raw.claudeAiOauth.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}

export async function fetchOauthUsage() {
  const token = readClaudeOauthToken();
  if (!token) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ccv-launcher',
      },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) {
      log('fetchOauthUsage non-ok:', r.status);
      return null;
    }
    return await r.json();
  } catch (err) {
    log('fetchOauthUsage error:', err.message);
    return null;
  }
}

// 5h block algorithm (ccusage-style):
//   1. Sort assistant turns by timestamp.
//   2. Block start = first turn floored to the hour. Block end = start + 5h.
//   3. New block when the next turn is past the current block's end OR has
//      a gap > 5h from the previous turn (idle break).
//   4. Active block = block that contains "now".
export function blocksFromTurns(turns) {
  const sorted = turns.slice().sort((a, b) => a.ts - b.ts);
  const FIVE_H = 5 * 3600 * 1000;
  const blocks = [];
  let cur = null;
  let prevTs = 0;
  for (const t of sorted) {
    if (!cur) {
      const start = new Date(t.ts);
      start.setMinutes(0, 0, 0);
      cur = {
        start: start.getTime(),
        end: start.getTime() + FIVE_H,
        firstTs: t.ts,
        lastTs: t.ts,
        tokens: 0,
        turns: 0,
        models: new Set(),
      };
      blocks.push(cur);
    } else if (t.ts >= cur.end || t.ts - prevTs > FIVE_H) {
      const start = new Date(t.ts);
      start.setMinutes(0, 0, 0);
      cur = {
        start: start.getTime(),
        end: start.getTime() + FIVE_H,
        firstTs: t.ts,
        lastTs: t.ts,
        tokens: 0,
        turns: 0,
        models: new Set(),
      };
      blocks.push(cur);
    }
    cur.tokens += t.tokens;
    cur.turns += 1;
    cur.lastTs = t.ts;
    if (t.model) cur.models.add(t.model);
    prevTs = t.ts;
  }
  return blocks.map(b => ({ ...b, models: Array.from(b.models) }));
}

export function detectPlan(blocks) {
  let maxBlockTokens = 0;
  for (const b of blocks) if (b.tokens > maxBlockTokens) maxBlockTokens = b.tokens;
  for (const tier of PLAN_THRESHOLDS) {
    if (maxBlockTokens <= tier.limit) return { plan_name: tier.name, limit: tier.limit, max_observed: maxBlockTokens };
  }
  // Above all known thresholds — bucket as Max20 (the highest plan).
  return { plan_name: 'Max20', limit: PLAN_THRESHOLDS[PLAN_THRESHOLDS.length - 1].limit, max_observed: maxBlockTokens };
}

export function p90(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
  return sorted[idx];
}

export async function gatherTurnsForBlocks(now) {
  // 192h window — matches Maciek-roboblog's burn-rate horizon.
  const horizon = now - 192 * 3600 * 1000;
  const paths = listSessionJsonlPaths();
  const turns = [];
  for (const p of paths) {
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < horizon) continue;
    await readJsonlEntries(p, (e) => {
      if (!e || e.type !== 'assistant') return;
      const msg = e.message; const u = msg && msg.usage;
      if (!u) return;
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (!ts || ts < horizon) return;
      const tokens = (+u.input_tokens || 0)
                   + (+u.output_tokens || 0)
                   + (+u.cache_creation_input_tokens || 0)
                   + (+u.cache_read_input_tokens || 0);
      turns.push({ ts, tokens, model: msg.model || null });
    });
  }
  return turns;
}

export async function computeFiveHourBlock() {
  const now = Date.now();
  const turns = await gatherTurnsForBlocks(now);
  const blocks = blocksFromTurns(turns);
  const active = blocks.find(b => now >= b.start && now < b.end);
  const plan = detectPlan(blocks);

  // P90 burn rate (tokens/min) over completed blocks within the horizon.
  const completed = blocks.filter(b => b.end <= now && b.turns >= 2);
  const rates = completed.map(b => {
    const durMin = Math.max(1, (b.lastTs - b.firstTs) / 60000);
    return b.tokens / durMin;
  });
  const burnRate = p90(rates); // tokens/min

  const used = active ? active.tokens : 0;
  const remaining = Math.max(0, plan.limit - used);
  const projection_minutes = burnRate > 0 ? Math.round(remaining / burnRate) : null;
  const reset_at = active ? new Date(active.end).toISOString() : null;
  const percent = plan.limit > 0 ? Math.min(100, (used / plan.limit) * 100) : 0;

  return {
    source: 'jsonl_compute',
    used,
    limit: plan.limit,
    percent: Math.round(percent * 10) / 10,
    reset_at,
    plan_name: plan.plan_name,
    plan_max_observed: plan.max_observed,
    burn_rate: Math.round(burnRate * 100) / 100,
    projection_minutes,
    block_start: active ? new Date(active.start).toISOString() : null,
    block_end: active ? new Date(active.end).toISOString() : null,
    block_turns: active ? active.turns : 0,
    block_models: active ? active.models : [],
    computedAt: now,
  };
}

export function loadQuota5hFromDisk() {
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8'));
      return raw && raw.quota5h ? raw.quota5h : null;
    }
  } catch { /* ignore */ }
  return null;
}

export function saveQuota5hToDisk(result) {
  try {
    const dir = dirname(USAGE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let cur = {};
    if (existsSync(USAGE_CACHE_FILE)) {
      try { cur = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8')) || {}; } catch { cur = {}; }
    }
    cur.quota5h = result;
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cur, null, 2));
  } catch (err) { log('saveQuota5hToDisk error:', err.message); }
}

export async function buildQuota5h() {
  // Tier 1: ccline cache (utilization only, no raw token counts).
  const ccline = readCclineCache();
  if (ccline && !ccline.stale && ccline.five_hour_utilization != null) {
    return {
      source: 'ccline_cache',
      percent: ccline.five_hour_utilization,
      used: null,
      limit: null,
      reset_at: null, // ccline only carries 7-day reset; 5h reset unknown
      plan_name: null,
      burn_rate: null,
      projection_minutes: null,
      cached_at: ccline.cached_at,
      seven_day_utilization: ccline.seven_day_utilization,
      seven_day_resets_at: ccline.seven_day_resets_at,
      computedAt: Date.now(),
    };
  }

  // Tier 2: direct OAuth API. Best-effort — skipped silently when no token
  // is reachable on disk (most users keep it in keychain).
  const oauth = await fetchOauthUsage();
  if (oauth && oauth.five_hour && typeof oauth.five_hour.utilization === 'number') {
    return {
      source: 'api_oauth',
      percent: oauth.five_hour.utilization,
      used: null,
      limit: null,
      reset_at: oauth.five_hour.resets_at || null,
      plan_name: null,
      burn_rate: null,
      projection_minutes: null,
      seven_day_utilization: oauth.seven_day && oauth.seven_day.utilization,
      seven_day_resets_at: oauth.seven_day && oauth.seven_day.resets_at,
      extra_usage: oauth.extra_usage || null,
      computedAt: Date.now(),
    };
  }

  // Tier 3: local jsonl compute.
  try {
    return await computeFiveHourBlock();
  } catch (err) {
    log('computeFiveHourBlock error:', err.message);
  }

  // Tier 4: nothing worked.
  return {
    source: 'unavailable',
    percent: null,
    used: null,
    limit: null,
    reset_at: null,
    plan_name: null,
    burn_rate: null,
    projection_minutes: null,
    reason: 'no quota source reachable (ccline cache absent + no oauth token + jsonl compute failed)',
    computedAt: Date.now(),
  };
}

export function refreshQuota5hInBackground() {
  if (_quota5hRefreshing) return;
  _quota5hRefreshing = true;
  buildQuota5h()
    .then((result) => {
      _quota5hMem = { ...result, fromCache: false, stale: false };
      saveQuota5hToDisk(_quota5hMem);
    })
    .catch((err) => log('quota5h refresh error:', err.message))
    .finally(() => { _quota5hRefreshing = false; });
}

export async function getCachedQuota5h() {
  const now = Date.now();
  if (_quota5hMem && now - _quota5hMem.computedAt < QUOTA_5H_MEM_TTL_MS) {
    return { ..._quota5hMem, fromCache: true, stale: false };
  }
  // Memory miss — try disk for an instant response, then refresh.
  if (!_quota5hMem) {
    const disk = loadQuota5hFromDisk();
    if (disk && now - disk.computedAt < QUOTA_5H_DISK_TTL_MS) {
      _quota5hMem = disk;
      refreshQuota5hInBackground();
      return { ...disk, fromCache: true, stale: now - disk.computedAt > QUOTA_5H_MEM_TTL_MS };
    }
  } else {
    // Memory present but past mem TTL — serve stale and refresh.
    refreshQuota5hInBackground();
    return { ..._quota5hMem, fromCache: true, stale: true };
  }
  // Cold miss: build synchronously.
  const result = await buildQuota5h();
  _quota5hMem = { ...result, fromCache: false, stale: false };
  saveQuota5hToDisk(_quota5hMem);
  return _quota5hMem;
}

// ---------- end 5h quota window ----------

// ---------- compact threshold + run summary (T9) ----------
// 1) Auto-compact / auto-clear threshold: getInstanceActivity calls
//    checkCompactThresholds(instance, contextUsage) after computing
//    contextUsage. When prefs.compactThresholds[cwd] is enabled and the
//    current prompt-size crosses auto_compact_at / auto_clear_at we try to
//    inject the corresponding slash command. ccv currently has no
//    stdin/inject channel (audited the full /api/* surface — no
//    /api/inject-prompt, no /api/stream-chunk write side, no WebSocket
//    that takes user input), so injectPromptToCcv is intentionally a noop
//    that returns {ok:false, reason:'no_inject_channel'} + jlogs the skip.
//    The compactStatus payload field lets ui-dev's T11 surface a "context
//    > threshold; please run /compact manually" hint on the affected card.
// 2) Run Summary: streams the native session jsonl with a 1-based line
//    counter and extracts notable events (prompts, slash commands,
//    tool errors, hook events, sub-agent spawns, auto-compact markers).
//    Cached per jsonlPath keyed on (mtime, size) — re-read is free when
//    the file hasn't grown — with a 5s in-memory floor.
export const COMPACT_COOLDOWN_MS = 5 * 60 * 1000;
const _thresholdCooldown = new Map(); // pid -> lastTriggerAt
const _compactStatusByPid = new Map(); // pid -> compactStatus payload

export async function injectPromptToCcv(instance, prompt) {
  // Future: probe ccv for a stdin or WebSocket inject channel and use it
  // when available. As of cc-viewer at /Users/dayuer/.nvm/.../cc-viewer/
  // server/server.js, no such route exists — ccv is a passive jsonl
  // observer. Returning a structured "skipped" result lets callers jlog
  // the attempt and lets UI surface a manual-action hint without the
  // launcher silently doing nothing.
  return { ok: false, reason: 'no_inject_channel' };
}

export function checkCompactThresholds(instance, contextUsage) {
  const pid = instance && instance.pid;
  if (!pid || !instance || !instance.cwd) return null;
  const threshold = getCompactThreshold(instance.cwd);
  const status = {
    enabled: !!threshold.enabled,
    auto_compact_at: threshold.auto_compact_at || 0,
    auto_clear_at: threshold.auto_clear_at || 0,
    lastTriggeredAt: null,
    lastResult: null,
    reason: null,
    cooldownUntil: null,
  };
  const prev = _compactStatusByPid.get(pid);
  if (prev) {
    status.lastTriggeredAt = prev.lastTriggeredAt;
    status.lastResult = prev.lastResult;
    status.reason = prev.reason;
  }
  if (!status.enabled) { _compactStatusByPid.set(pid, status); return status; }
  if (!contextUsage || typeof contextUsage.used !== 'number') {
    _compactStatusByPid.set(pid, status);
    return status;
  }
  const now = Date.now();
  const last = _thresholdCooldown.get(pid) || 0;
  if (now - last < COMPACT_COOLDOWN_MS) {
    status.cooldownUntil = last + COMPACT_COOLDOWN_MS;
    _compactStatusByPid.set(pid, status);
    return status;
  }
  // Clear takes priority over compact when both are configured and tripped.
  let action = null;
  if (status.auto_clear_at > 0 && contextUsage.used >= status.auto_clear_at) {
    action = { prompt: '/clear', kind: 'clear' };
  } else if (status.auto_compact_at > 0 && contextUsage.used >= status.auto_compact_at) {
    action = { prompt: '/compact', kind: 'compact' };
  }
  if (!action) { _compactStatusByPid.set(pid, status); return status; }
  // Fire-and-forget — we don't want a slow inject to block activity polls.
  // The noop returns synchronously today; keeping the promise shape future-
  // proofs the call site when a real inject channel lands.
  Promise.resolve(injectPromptToCcv(instance, action.prompt))
    .then((res) => {
      const ok = !!(res && res.ok);
      const newStatus = {
        ..._compactStatusByPid.get(pid) || status,
        lastTriggeredAt: now,
        lastResult: ok ? 'ok' : 'skipped',
        reason: ok ? null : (res && res.reason) || 'unknown',
        cooldownUntil: now + COMPACT_COOLDOWN_MS,
      };
      _compactStatusByPid.set(pid, newStatus);
      jlog(ok ? 'auto_compact_triggered' : 'auto_compact_skipped', {
        pid, cwd: instance.cwd, action: action.kind, used: contextUsage.used,
        threshold: action.kind === 'clear' ? status.auto_clear_at : status.auto_compact_at,
        reason: ok ? undefined : newStatus.reason,
      });
    })
    .catch((err) => {
      const newStatus = {
        ..._compactStatusByPid.get(pid) || status,
        lastTriggeredAt: now,
        lastResult: 'failed',
        reason: err && err.message || String(err),
        cooldownUntil: now + COMPACT_COOLDOWN_MS,
      };
      _compactStatusByPid.set(pid, newStatus);
      jlog('auto_compact_failed', {
        pid, cwd: instance.cwd, action: action.kind, reason: newStatus.reason,
      });
    });
  _thresholdCooldown.set(pid, now);
  status.lastTriggeredAt = now;
  status.lastResult = 'pending';
  status.cooldownUntil = now + COMPACT_COOLDOWN_MS;
  _compactStatusByPid.set(pid, status);
  return status;
}

// Stream jsonl with a 1-based line counter. The callback receives (entry, line).
export async function readJsonlEntriesIndexed(path, onEntry) {
  let i = 0;
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    i++;
    if (!raw) continue;
    let obj; try { obj = JSON.parse(raw); } catch { continue; }
    onEntry(obj, i);
  }
}

export function truncateLabel(s, n = 80) {
  if (typeof s !== 'string') return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

// Classify a single jsonl entry. Returns null when the entry isn't notable.
// Event types (5 from spec + 3 useful additions found in this repo's jsonl):
//   prompt           — type=user with string content (real user input)
//   slash_command    — prompt whose content starts with '/' (e.g. /compact, /clear)
//   auto_compact     — user content containing the canonical resume marker
//                      "This session is being continued from a previous conversation"
//   tool_error       — type=user, content array with any tool_result.is_error===true
//   subagent         — type=assistant, content array contains tool_use name===Task
//   hook_event       — type=attachment with attachment.type==='hook_success'
//   state_change     — *not implemented*: would require full state-machine replay
//                      across the jsonl; punted to follow-up. Not in v1.
export function classifyEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const ts = e.timestamp || null;
  if (e.type === 'user') {
    const msg = e.message; const c = msg && msg.content;
    if (typeof c === 'string') {
      if (c.includes('This session is being continued from a previous conversation')) {
        return { type: 'auto_compact', label: 'session continued (auto-compact)', ts };
      }
      const trimmed = c.trim();
      if (trimmed.startsWith('/')) {
        const cmd = trimmed.split(/\s+/)[0];
        return { type: 'slash_command', label: cmd, ts };
      }
      return { type: 'prompt', label: truncateLabel(c, 80), ts };
    }
    if (Array.isArray(c)) {
      const err = c.find(b => b && b.type === 'tool_result' && b.is_error);
      if (err) {
        // Tool name isn't on the user-side tool_result block, but the
        // tool_use_id is — UI can resolve the original tool name if needed.
        const snippet = typeof err.content === 'string'
          ? err.content
          : Array.isArray(err.content)
            ? err.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ')
            : '';
        return { type: 'tool_error', label: truncateLabel(snippet || 'tool returned error', 80), ts, toolUseId: err.tool_use_id || null };
      }
    }
    return null;
  }
  if (e.type === 'assistant') {
    const msg = e.message; const blocks = msg && msg.content;
    if (!Array.isArray(blocks)) return null;
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.name === 'Task') {
        const subType = (b.input && (b.input.subagent_type || b.input.description)) || 'Task';
        return { type: 'subagent', label: truncateLabel(String(subType), 80), ts };
      }
    }
    return null;
  }
  if (e.type === 'attachment') {
    const a = e.attachment;
    if (a && a.type === 'hook_success') {
      // Real Claude Code attachments use camelCase: hookName (e.g.
      // "SessionStart:startup") and hookEvent (e.g. "SessionStart"). Prefer
      // hookName since it's specific; fall back through the snake_case
      // variants in case the schema evolves.
      const name = a.hookName || a.hook_event_name || a.hookEvent || a.hook_name || a.name || 'hook';
      return { type: 'hook_event', label: truncateLabel(String(name), 80), ts };
    }
    return null;
  }
  return null;
}

const _jsonlScanCache = new Map(); // jsonlPath -> { mtime, size, computedAt, runSummary, edits, errors }
export const JSONL_SCAN_TTL_MS = 5_000;
export const RUN_SUMMARY_MAX_EVENTS = 500; // cap response size
export const ERROR_SAMPLES_PER_GROUP = 5;

// Single streaming pass over a session jsonl producing three projections —
// run summary, recent edits, error breakdown — so /run-summary, /recent-edits,
// and /errors all share one scan. mtime+size key with 5s in-memory floor.
export async function scanJsonlAll(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return null;
  let st; try { st = statSync(jsonlPath); } catch { return null; }
  const cached = _jsonlScanCache.get(jsonlPath);
  const now = Date.now();
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size
      && now - cached.computedAt < JSONL_SCAN_TTL_MS) {
    return cached;
  }

  // Run summary state
  const events = [];
  const summaryTotals = { prompts: 0, slash_commands: 0, tools: 0, errors: 0, compacts: 0, subagents: 0, hooks: 0 };
  let toolUseCount = 0;

  // Recent edits state: per-target aggregation keyed by file path (Edit/Write/
  // MultiEdit) or command-prefix (Bash). Tracks count, lastTs, lastEditTool,
  // and a small lastDiffPreview string for the most recent occurrence.
  const editMap = new Map(); // key -> { tool, path, count, lastTs, lastDiffPreview }

  // Errors state: cluster tool_result.is_error entries by hash of
  // (tool_name, first 80 chars of message). Resolving tool_name requires
  // mapping tool_use_id → name, so we maintain a forward index from
  // assistant tool_use blocks as we stream.
  const toolUseIndex = new Map(); // tool_use_id -> tool_name
  const errorGroups = new Map();  // groupKey -> { toolName, errorPattern, count, lastTs, samples }
  let errorTotal = 0;

  await readJsonlEntriesIndexed(jsonlPath, (e, line) => {
    // --- side counter + tool_use index + edits ---
    if (e && e.type === 'assistant' && Array.isArray(e.message && e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        toolUseCount++;
        if (b.id) toolUseIndex.set(b.id, b.name || 'unknown');
        recordEdit(b, e.timestamp || null);
      }
    }
    // --- error grouping (user-side tool_result.is_error) ---
    if (e && e.type === 'user' && Array.isArray(e.message && e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_result' || !b.is_error) continue;
        recordError(b, e.timestamp || null);
      }
    }
    // --- run summary classification ---
    const cls = classifyEntry(e);
    if (!cls) return;
    events.push({ ts: cls.ts, type: cls.type, label: cls.label, jsonlLine: line, ...(cls.toolUseId ? { toolUseId: cls.toolUseId } : {}) });
    if (cls.type === 'prompt') summaryTotals.prompts++;
    else if (cls.type === 'slash_command') summaryTotals.slash_commands++;
    else if (cls.type === 'auto_compact') summaryTotals.compacts++;
    else if (cls.type === 'tool_error') summaryTotals.errors++;
    else if (cls.type === 'subagent') summaryTotals.subagents++;
    else if (cls.type === 'hook_event') summaryTotals.hooks++;
  });
  summaryTotals.tools = toolUseCount;

  function recordEdit(block, ts) {
    const tool = block.name;
    if (!tool) return;
    let key, path, preview;
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
      const p = block.input && block.input.file_path;
      if (!p) return;
      path = String(p);
      key = `${tool}::${path}`;
      if (tool === 'Edit') {
        const oldS = block.input.old_string || '';
        const newS = block.input.new_string || '';
        preview = `${truncateLabel(oldS, 40)}  →  ${truncateLabel(newS, 40)}`;
      } else if (tool === 'Write') {
        const c = block.input.content || '';
        preview = `(write ${typeof c === 'string' ? c.length : 0} chars) ${truncateLabel(c, 60)}`;
      } else {
        const edits = Array.isArray(block.input.edits) ? block.input.edits.length : 0;
        preview = `(multi-edit, ${edits} hunks)`;
      }
    } else if (tool === 'Bash') {
      const cmd = (block.input && block.input.command) || '';
      if (!cmd) return;
      // Group bash by command head (first word + first few args) so we don't
      // explode the list with one-off commands. UI can group further by
      // first token if it wants.
      const head = truncateLabel(String(cmd), 60);
      path = head;
      key = `Bash::${head}`;
      preview = truncateLabel(String(cmd), 80);
    } else {
      return;
    }
    const cur = editMap.get(key);
    const tsMs = ts ? Date.parse(ts) : 0;
    if (cur) {
      cur.count++;
      if (tsMs >= cur.lastTsMs) {
        cur.lastTsMs = tsMs;
        cur.lastTs = ts;
        cur.lastDiffPreview = preview;
      }
    } else {
      editMap.set(key, { tool, path, count: 1, lastTs: ts, lastTsMs: tsMs, lastDiffPreview: preview });
    }
  }

  function recordError(block, ts) {
    errorTotal++;
    const toolName = (block.tool_use_id && toolUseIndex.get(block.tool_use_id)) || 'unknown';
    const full = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ')
        : '';
    const pattern = truncateLabel(full || 'tool returned error', 80);
    const groupKey = `${toolName}\n${pattern}`;
    const cur = errorGroups.get(groupKey);
    const sample = { ts, fullMessage: full };
    if (cur) {
      cur.count++;
      if (!cur.lastTs || (ts && ts > cur.lastTs)) cur.lastTs = ts;
      if (cur.samples.length < ERROR_SAMPLES_PER_GROUP) cur.samples.push(sample);
    } else {
      errorGroups.set(groupKey, {
        toolName, errorPattern: pattern,
        count: 1, lastTs: ts,
        samples: [sample],
      });
    }
  }

  // Materialize projections
  const summaryEvents = events.length > RUN_SUMMARY_MAX_EVENTS
    ? events.slice(-RUN_SUMMARY_MAX_EVENTS)
    : events;

  // Edits: sort by lastTs desc; split files vs bash so UI can render two
  // sections without re-grouping.
  const editList = Array.from(editMap.values()).map(({ lastTsMs, ...rest }) => rest);
  editList.sort((a, b) => (Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0));
  const fileEdits = editList.filter(e => e.tool !== 'Bash');
  const bashEdits = editList.filter(e => e.tool === 'Bash');

  // Errors: groups sorted by count desc, then lastTs desc.
  const errorGroupList = Array.from(errorGroups.values());
  errorGroupList.sort((a, b) => b.count - a.count || ((Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0)));

  const result = {
    mtime: st.mtimeMs,
    size: st.size,
    computedAt: now,
    runSummary: {
      events: summaryEvents,
      totalEvents: events.length,
      totals: summaryTotals,
    },
    edits: {
      files: fileEdits,
      bash: bashEdits,
      totalUniqueTargets: editList.length,
    },
    errors: {
      groups: errorGroupList,
      total: errorTotal,
    },
  };
  _jsonlScanCache.set(jsonlPath, result);
  return result;
}

export async function computeRunSummary(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    events: r.runSummary.events,
    totalEvents: r.runSummary.totalEvents,
    totals: r.runSummary.totals,
  };
}

export async function computeRecentEdits(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    files: r.edits.files,
    bash: r.edits.bash,
    totalUniqueTargets: r.edits.totalUniqueTargets,
  };
}

export async function computeErrors(jsonlPath) {
  const r = await scanJsonlAll(jsonlPath);
  if (!r) return null;
  return {
    mtime: r.mtime, size: r.size, computedAt: r.computedAt,
    groups: r.errors.groups,
    total: r.errors.total,
  };
}

// ---------- end compact threshold + run summary ----------
