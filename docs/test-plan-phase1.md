# Phase 1 test plan — smoke + regression

**Tester**: tester (orange)
**Run at**: 2026-05-22 (HEAD `179a81c`, branch `feat/web-optim-phase1-2`)
**Test scope**: T3-T8 implementations (H1/H2/H3 backend + UI, H4 Kanban, H5 tagging+keys)
**Environment**: isolated hub on `http://127.0.0.1:7200` spawned via
`CCV_HUB=1 CCV_START_PORT=7200 CCV_MAX_PORT=7200 ccv --d --no-open`.
Prod 7100 (launchd-managed) left untouched; both hubs share `~/.claude/cc-viewer/runtime`
so the test hub sees the 4 live children + 1 prod hub (total instanceCount=6).

> **Caveat**: testing was based on **already-committed HEAD `179a81c`**.
> ui-dev's 165-line uncommitted cost-UI follow-up is **not in scope** here;
> a separate pass will follow once it lands.

> **Verification mode**: API endpoints were exercised via `curl`. UI behavior
> (j/n cycle, hover popover, Kanban auto-migrate animation, tag filter live
> update) was confirmed by reading the dashboard HTML markup + JS source
> served from `/launcher` — actual browser-driven keyboard/mouse behavior
> was not exercised by this tester (no headless-browser tool wired). Items
> verified by markup are marked **markup-✓** (wired correctly); items needing
> a human click-through are marked **[需人工验证]**.

> **Phase-1 sign-off verdict (per team-lead 2026-05-22)**: F1 (month
> cold-cache) and F2 (compact-threshold loose validation) are tracked as
> **post-Phase-1 follow-ups**, **not Phase-1 failures**. F4 is informational.
> All 8 checklist items therefore pass; UI behavior-level items below remain
> [需人工验证].

## 1. Checklist results

### 1.1 H1/H2/H3 — Top bar (cost / 5h quota / per-card context)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1.1 | `GET /api/launcher/usage/summary?range=today` returns ok | ✅ | `totalUSD=301.52`, requestCount=1844, 2 models (matches lead's expected ~$301) |
| 1.2 | `?range=week` | ✅ | `totalUSD=1341.77`, fromCache=true |
| 1.3 | `?range=month` | ✅ (see [F1] follow-up) | works (`totalUSD=3216.92`); cold-cache first hit >5s — tracked as backend follow-up, not a Phase-1 failure |
| 1.4 | `?range=invalid` returns 400 | ✅ | 400 |
| 1.5 | `GET /api/launcher/quota/5h` | ✅ | source=`ccline_cache`, percent=4, cached_at present |
| 1.6 | Top-bar cost markup present (`#stat-cost`, `#stat-cost-val`, `#stat-cost-range`, `#stat-cost-popover`, `#cp-list`, `#cp-range`) | ✅ markup-✓ | 13 hits for `stat-cost` |
| 1.7 | Top-bar quota markup (`#stat-quota`, `#stat-quota-val`, `#stat-quota-fill`, `#stat-quota-src`) | ✅ markup-✓ | 16 hits |
| 1.8 | Cost cycle today→week→month on click | ✅ markup-✓ | `COST_RANGES=['today','week','month']`, `_costRangeIdx` cycle (L1408) |
| 1.9 | Popover shows byModelUSD breakdown | ✅ markup-✓ | render at L1444 uses `data.byModelUSD`, sorted desc |
| 1.10 | Stale flag ↻ chip | ✅ markup-✓ | CSS at L37 `.stat.is-stale .stat-val::after { content:' ↻' }`; cost & quota both toggle via `classList.toggle('is-stale', !!data.stale)` |
| 1.11 | 5h source chip: ccline_cache/api_oauth → hidden; jsonl_compute → `推算`; unavailable → grey | ✅ markup-✓ | L1485 only un-hides `推算` when `q.source==='jsonl_compute'`; L1463 dims when `unavailable` |
| 1.12 | Hover tooltip burn_rate/projection/reset_at | ✅ markup-✓ | L1492-1502 builds `el.title` conditionally — nulls skipped, no "null" leakage (resolved my earlier concern) |
| 1.13 | Per-card `contextUsage` payload via `/api/launcher/instances/{pid}/activity` | ✅ | returned `{used:272499, limit:1000000, percent:27.2, model:claude-opus-4-7, displayName:"Opus 4.7"}` |
| 1.14 | Context bar thresholds: 60% warn / 80% hot / 95% bad | ✅ markup-✓ | CSS L62-64 `.ctx-fill.{warn,hot,bad}`; comment L1244 "60% warn, 80% hot, 95% bad" |
| 1.15 | Hub cards exclude context bar | ✅ markup-✓ | `renderContextRow` only called for entries with `act.contextUsage` (which `/activity` skips for `isHub:true`) |
| 1.16 | TopStats poll 10s + visibility-paused | ✅ markup-✓ | L1518 `visibilityPoll(refreshTopStats, 10000)`, helper at L1380 hooks `visibilitychange` |

### 1.2 H4 — Kanban + single-char icons (T7)

| # | Item | Status | Evidence |
|---|---|---|---|
| 2.1 | 3-column layout `Waiting · Working · Idle` | ✅ markup-✓ | columns rendered with `data-col="waiting|working|idle"` (L627); CSS L69 `grid-template-columns: 1fr 1fr 1fr` |
| 2.2 | Per-column count badge `.col-count` | ✅ markup-✓ | CSS L79 |
| 2.3 | Single-char icon set: ⏳/●/◐/○/⚠ | ✅ markup-✓ | `STATUS_VIEW` table L540-547 covers thinking/tool_running/waiting_ask/idle/no_session/error |
| 2.4 | Hover badge → full statusLabel | ✅ markup-✓ | L1194 `badge.title = act.statusLabel` |
| 2.5 | Same-cwd group routed to highest-priority column | ✅ markup-✓ | `colForGroup` L555 walks group, returns waiting > working > idle |
| 2.6 | State auto-transitions on `refreshActivity` cycle | ✅ markup-✓ | `_statusByPid` updated each poll → next `renderKanban` re-bins; no DOM re-shuffle artefact found (clean re-render) |
| 2.7 | Empty column placeholder `—` | ✅ markup-✓ | `.col-empty` class L82, rendered by render loop |
| 2.8 | <880px collapses to single column | ✅ markup-✓ | CSS L84 `@media (max-width:880px) { .kanban { grid-template-columns: 1fr } }` |
| 2.9 | "状态切换不抖" debounce | ⚠️ [需人工验证] | The render path is full re-render every 3s; **no explicit debounce** found in source. May still feel fine if backend status is stable; flag for visual confirm under churn. |

### 1.3 H5 — Tagging + filter + keyboard shortcuts (T8)

| # | Item | Status | Evidence |
|---|---|---|---|
| 3.1 | `POST /api/launcher/prefs/tags` persists per-cwd | ✅ | tested with synthetic `/tmp/ccv-tester-synthetic` cwd: set `["tester-temp","qa"]`, GET /prefs reflected, allTags aggregated; cleaned up after |
| 3.2 | `allTags` exposed for autocomplete | ✅ | present in /prefs payload |
| 3.3 | Filter input `#tag-filter`, AND semantics | ✅ markup-✓ | `applyTagFilter` at L1531; help dialog explicitly states "AND match — all tokens must match a tag (case-insensitive substring)" |
| 3.4 | `?` key opens help dialog `#help-dlg` | ✅ markup-✓ | dialog template present; close button `#help-close` |
| 3.5 | `j` / `n` cycle through waiting_ask | ✅ markup-✓ | 4 `addEventListener('keydown')` registrations; explicit `key === 'j'` and `key === 'n'` branches; `waiting_ask` referenced 6× |
| 3.6 | `/` focuses tag filter | ✅ markup-✓ | `key === '/'` branch present |
| 3.7 | Suppression: input/textarea focus, dialog open, overlay open | ⚠️ [需人工验证] | source has guards; full edge case coverage (contenteditable, native confirm()) needs human confirm |
| 3.8 | `+ tag` button on group hover, prompt() input, ≤24 chars | ⚠️ [需人工验证] | `tag-add` class L93 with `opacity:0` (hover-revealed); prompt validation needs UI run |
| 3.9 | Chip × delete with confirm | ⚠️ [需人工验证] | `tag-chip` markup present; behavior needs human |
| 3.10 | <680px filter input shrinks | ✅ markup-✓ | responsive CSS present (not pasted here for brevity) |

### 1.4 General regression (existing endpoints untouched)

| # | Item | Status | Evidence |
|---|---|---|---|
| 4.1 | `GET /healthz` | ✅ | 200, instanceCount=6 |
| 4.2 | `GET /api/launcher/list` schema unchanged | ✅ | 17 fields per instance — same as baseline |
| 4.3 | `GET /api/launcher/activity` (bulk) | ✅ | 6 entries, keys include new `contextUsage`/`sessionUsage` (additive) |
| 4.4 | `GET /api/launcher/instances/{pid}/activity` 404 on invalid pid | ✅ | `{"error":"instance not found"}` 404 |
| 4.5 | `GET /api/launcher/browse-dir?path=…` | ✅ | returns `{current, parent, dirs:[{name, path, hasGit}]}` |
| 4.6 | Pair flow `request → status → reject` | ✅ | got code 657579 → status approved=false expired=false → reject ok=true |
| 4.7 | Prefs alias / ccuse-profile POST endpoints | ✅ markup-✓ | still wired in `dispatchLauncherRoute` (lines 3195 / 3208) |
| 4.8 | `POST /api/launcher/prefs/compact-threshold` | ✅ (see [F2] follow-up) | accepts shape but malformed payload silently drops; backend-dev follow-up |
| 4.9 | `POST /api/launcher/prefs/worktree-default` | ✅ | flipped true → false cleanly |
| 4.10 | `POST /api/launcher/open-terminal` route still mounted | ✅ markup-✓ | line 3268 |
| 4.11 | iframe overlay `#ccv-overlay` markup intact | ✅ markup-✓ | 5 hits |
| 4.12 | xterm overlay `#term-overlay` markup intact | ✅ markup-✓ | 5 hits |
| 4.13 | takeover-cc-session endpoint mounted | ✅ markup-✓ | 1 reference |
| 4.14 | spawn / kill / forget — **NOT EXERCISED** | ⏭ skipped | both hubs share the same runtime; calling kill/forget/spawn from 7200 would affect prod-visible instances. Markup + route registration verified only. |

### 1.5 Endpoint curl matrix (final)

```bash
curl -s http://127.0.0.1:7200/healthz                                          # 200
curl -s 'http://127.0.0.1:7200/api/launcher/usage/summary?range=today'         # totalUSD 301.52
curl -s 'http://127.0.0.1:7200/api/launcher/usage/summary?range=week'          # totalUSD 1341.77
curl -s 'http://127.0.0.1:7200/api/launcher/usage/summary?range=month'         # totalUSD 3216.92 (cold-hit slow)
curl -s 'http://127.0.0.1:7200/api/launcher/usage/summary?range=invalid'       # 400
curl -s http://127.0.0.1:7200/api/launcher/quota/5h                            # source=ccline_cache pct=4
curl -s http://127.0.0.1:7200/api/launcher/prefs                               # 8 top keys incl. T2 additions
curl -s http://127.0.0.1:7200/api/launcher/list                                # 6 instances
curl -s http://127.0.0.1:7200/api/launcher/activity                            # 6 entries with contextUsage/sessionUsage
curl -s http://127.0.0.1:7200/api/launcher/instances/14819/activity            # contextUsage 27.2% on Opus 4.7 1M
curl -sX POST http://127.0.0.1:7200/api/launcher/pair-request                  # {code:"<6-digit>"}
```

## 2. Findings

### F1 (follow-up, MEDIUM, owner: backend-dev) — `usage/summary?range=month` cold-cache request >5s

> **Triage**: tracked as backend follow-up after T9, **not a Phase-1 failure**
> (per team-lead 2026-05-22). Hot-cache path (80ms) is the normal user
> experience; cold-cache is the extreme case at hub-restart.

**Repro**:
1. Restart the hub (cold ccusage cache for `month` range).
2. `time curl -m 6 'http://127.0.0.1:7200/api/launcher/usage/summary?range=month'`
   → first hit times out at 5s (returns nothing).
3. Repeat: 0.08s (cache warm).

**Impact**: when a user clicks the cost block to cycle to `month` for the
first time after a hub restart, the top-bar will show stale value + `is-loading`
class for >5s, then suddenly snap. Today/week hits don't repro because they
were warmed by prior dev sessions.

**Suggested fix**: either warm `month` aggregation at hub-start (`prewarm`
all three ranges on boot), or stream a `{stale:true, fromCache:true, totalUSD:0}`
sentinel first while the heavy compute runs in background.

### F2 (follow-up, LOW, owner: backend-dev) — `POST /prefs/compact-threshold` silently drops malformed input

> **Triage**: tracked as backend follow-up alongside F1, **not a Phase-1
> failure**. T11 form construction must use the correct nested shape;
> hardening the endpoint is a defense-in-depth improvement.

**Repro**:
```bash
curl -sX POST http://127.0.0.1:7200/api/launcher/prefs/compact-threshold \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"/tmp/x","threshold":75}'
# → {"ok":true, "threshold":{"auto_compact_at":0,"auto_clear_at":0,"enabled":false}}
# but GET /prefs shows compactThresholds:{} — not persisted
```

The endpoint expects a nested object `{auto_compact_at, auto_clear_at, enabled}`,
not a single number. It returns 200 + an empty default rather than 400 when
the shape is wrong. Phase 2's compact-threshold form (T11) must construct the
correct shape — otherwise the form will silently no-op.

**Suggested fix**: 400 on missing `auto_compact_at`/`auto_clear_at` fields.

### F3 (INFO) — schema corrections vs baseline
- `usage/summary` field is `totalUSD` (number), `byModelUSD` (map). My baseline
  doc said `totalCost` — that was my guess. UI is correctly aligned.
- `quota/5h` exposes `source` enum (ccline_cache/api_oauth/jsonl_compute/unavailable),
  plus `fromCache`/`stale` flags. `plan_name`/`burn_rate`/`projection_minutes`/`reset_at`
  legitimately null under `ccline_cache` (no fix needed — UI tooltip conditionally
  hides; see §1.1 row 1.12).
- `browse-dir` schema is `{current, parent, dirs:[{name, path, hasGit}]}` (not
  `entries`).

### F4 (INFO) — Kanban "状态切换不抖" — no explicit debounce in code, [需人工验证]

`renderKanban` is invoked from `refresh()` (every 30s) and from `refreshActivity()`
(every 3s on visible tab). Each call does a full DOM swap. There's no
between-poll smoothing — if status flips e.g. `tool_running` → `idle` → `tool_running`
in <3s, the card will animate-migrate twice. In practice the 3s sampling
window will already coalesce these, but worth a visual confirm pass under
real workload churn.

## 3. New IDs introduced by Phase 1 (diff vs baseline)

```
+ btn-help              (T8 help button)
+ cp-list               (cost popover model list)
+ cp-range              (cost popover range label)
+ help-close            (close help dialog)
+ help-dlg              (help dialog)
+ stat-cost             (top-bar cost block)
+ stat-cost-popover     (cost popover container)
+ stat-cost-range       (cost current-range label)
+ stat-cost-val         (cost USD text)
+ stat-quota            (top-bar quota block)
+ stat-quota-fill       (quota progress fill)
+ stat-quota-src        (quota source chip e.g. 推算)
+ stat-quota-val        (quota percent text)
+ tag-filter            (filter input)
+ topbar-stats          (top-bar wrapper)
- code                  (PAIR_PAGE only — never in dashboard)
- status                (was unused in dashboard — appears in PAIR_PAGE)
```

(Baseline showed `id="code"` and `id="status"` which actually live in
PAIR_PAGE, not the dashboard HTML. Correction noted.)

New classes (sample): `kanban`, `kanban-col`, `kanban-hd`, `kanban-body`,
`col-icon`, `col-count`, `col-empty`, `stat`, `stat-val`, `stat-label`,
`quota-fill`, `src-tag`, `context-row`, `ctx-bar`, `ctx-fill` (+ warn/hot/bad),
`tag-chip`, `tag-add`, `kb-table`, `kb-row-hd`, `cp-row`, `cp-model`, `cp-val`,
`cp-total`, `cp-empty`.

## 4. Test environment teardown

```bash
# kill test hub
lsof -nP -iTCP:7200 -sTCP:LISTEN | awk 'NR>1{print $2}' | xargs -r kill
# prod 7100 untouched
```

## 5. Sign-off

**Phase 1 PASSED** (per team-lead triage 2026-05-22):
- All 8 user-visible checklist items pass at markup/API level.
- F1 (month cold-cache) + F2 (compact-threshold validation) are **post-Phase-1
  backend follow-ups** — backend-dev will pick them up alongside T9. They do
  not block Phase 2.
- F3 (schema corrections) → fed back into `docs/test-baseline-endpoints.md`.
- F4 (Kanban debounce) is [需人工验证] — ui-dev will visually confirm under
  real workload churn.
- 6 items remain [需人工验证] (Kanban migration smoothness, j/n keyboard
  suppression edge cases, tag prompt/chip-delete dialogs, etc.) — to be
  covered by human click-through pass.
- No regression in existing routes / overlays / pair flow.
- ui-dev's 165-line uncommitted cost-UI follow-up will get a re-pass once
  committed.

Routing handled by team-lead (no separate per-finding pings from tester).
