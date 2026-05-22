# Phase 1 incremental test plan — cost UI follow-up + quota null fallback

**Tester**: tester (orange)
**Run at**: 2026-05-22 (HEAD `7491651`)
**Scope**: ui-dev's two follow-up commits on top of Phase 1 base
**Triggered by**: lead pivot — verify cost-UI follow-up now (before Phase 2
M1/M3 mixing), not as part of Phase 2 regression.

Commits under test:
- `f533ce9 fix(ui): show all three cost ranges on wide screen + per-card session cost`
- `7f8f513 fix(ui): show "—" for missing 5h quota fields instead of dropping them`

(Also notes: hub restart now also pulls in `7491651 feat(launcher): auto-compact
threshold + run summary timeline endpoint` which is T9 / Phase 2 — out of
scope here, will be covered by Phase 2 regression.)

## 1. Environment

- Killed previous test hub pid 25883 (was running stale code at start time).
- Restarted: `CCV_HUB=1 CCV_START_PORT=7200 CCV_MAX_PORT=7200 ccv --d --no-open`
  → fresh pid 43785, uptimeSec=4 at first probe, instanceCount=6.
- Dashboard HTML grew **90496 B → 95070 B** (+4574 B), confirming new code
  loaded into the running hub.
- Prod hub 7100 (pid 99369, launchd) untouched.

## 2. Incremental checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Cost three slots same-screen (wide) | ✅ | `cost-slot` 14 hits, `cost-multi` 5 hits. CSS L41-45 flex layout. Body `data-active-range` selector at L142-143 toggles which slot is visible on narrow. |
| 2a | Cost popover markup | ✅ | `cp-hd` 2 hits, `cp-row` 3 hits (header + per-model row template) |
| 2b | `usage/summary?range=today/week/month` schema consistent | ✅ | All three return keys `[byModel, byModelUSD, computedAt, cwd, fromCache, range, requestCount, stale, totalUSD]`. today=$333.21, week=$1352.88, month=$3228.18. All <5s on warm restart. |
| 3a | per-card session cost mini-tag markup | ✅ | L492 `<span class="tag cost" data-cost-for="<pid>" hidden>` rendered only when `!it.isHub`; L1232 selector reads activity payload |
| 3b | `sessionUsage.costUSD > 0` on a real instance | ✅ | probed pid 14819 (ccv-launcher cwd): `{costUSD: 35.08, requestCount: 177, model: claude-opus-4-7}` |
| 4 | quota tooltip null fallback `"—"` sentinel | ✅ | L1439 `fmtUSD` returns `'—'` on null/NaN; L1454 `fmtTokensK` same; L1473 slot textContent fallback; L1564-65 explicit `const dash = '—'` for quota tooltip fields |
| 5 | `<640px` breakpoint | ✅ | CSS `@media (max-width:640px)` at L123 and L131; JS `window.matchMedia('(max-width: 640px)')` at L1601 (reactive listener) |

## 3. Bonus checks (no-cost while I had the hub up)

| # | Item | Status | Evidence |
|---|---|---|---|
| B1 | `jsonl_compute` chip now `⚠` (was `推算`) with hover explanation | ✅ | L1555 `srcTag.textContent = '⚠'`; L1556 `srcTag.title = '推算（基于本地 jsonl，可能不精确）'` |
| B2 | `unavailable` text changed to `数据暂不可用` | ✅ | L1531 `valEl.textContent = '数据暂不可用'`; L1535 tooltip prepends Chinese label then English reason |
| B3 | F1 (month cold-cache) repro on fresh hub | ⚠️ did-not-repro | `month` returned in <5s on cold start this time. ccusage caches may be file-backed and survive hub restart. F1 backend follow-up still valid for true cold (e.g. `rm` of cache dir). |

## 4. Out of scope (per lead pivot)

Not re-tested:
- Kanban / single-char icons / tag filter / j/n cycle / help dialog — unchanged
  since Phase 1 PASS.
- T9 (`7491651` auto-compact threshold + run summary timeline) — Phase 2,
  will be covered in Phase 2 regression.
- Behavior-level UI items still `[需人工验证]` (popover hover swap on wide,
  click-to-cycle on narrow, instance-head cost hover tooltip text).

## 5. Sign-off

Cost-UI follow-up **PASSED** at markup + endpoint level.

- Three-slot layout wired (CSS + body data-active-range gate).
- Per-card session cost span only emitted for non-hub instances; backing
  `sessionUsage.costUSD` confirmed populated.
- Null fallback `—` sentinel uniformly applied (4 distinct call sites).
- `<640px` breakpoint present in both CSS and JS reactive listener.
- Bonus text refinements (`⚠` chip, `数据暂不可用`) landed cleanly.

Phase 2 regression can build on HEAD `7491651` knowing cost-UI is stable.

## 6. Lingering follow-ups (unchanged from phase1.md)

- F1 (month cold-cache) — backend-dev, will fold into perf commit after T9.
  Did-not-repro on this restart but the heuristic case stands.
- F2 (compact-threshold loose validation) — backend-dev, same perf commit.
- F4 (Kanban debounce) — deferred-visual, ui-dev / lead manual confirm.
