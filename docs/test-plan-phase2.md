# Phase 2 test plan — full smoke + regression

**Tester**: tester (orange)
**Run at**: 2026-05-22 (HEAD `99eeeac`)
**Test scope**: T11 (M1+M3 UI tabs), T12 (M2 worktree+git/PR end-to-end),
T13 (M4 CLAUDE.md scanner), Phase-1 regression, F2 follow-up verification

**Environment**:
- Killed previous test hub pid 43785 (was on HEAD 7491651).
- Started fresh: `CCV_HUB=1 CCV_START_PORT=7200 CCV_MAX_PORT=7200 ccv --d --no-open`
  → pid 45567 on HEAD `99eeeac`.
- Dashboard HTML 95070 B → **146237 B** (+51 KB Phase 2 additions).
- Prod hub 7100 (launchd, pid 99369) untouched throughout.
- Sandbox fixtures: `/tmp/demo` + `/tmp/demo-bare.git` for T12;
  `~/.claude/tester-fixture-T13.md` for T13 (cleaned up after).
- All POST writes used sandbox files; **the user's real `~/.claude/CLAUDE.md`
  was never written to** despite m2-dev's docs suggesting it.

---

## 0. Critical finding (escalated separately to lead)

### S1 / HIGH — `/api/launcher/file` symlink escape (read + write)

**T13 verification surfaced a real exploitable bug.** `isAllowedMdPath` uses
`resolvePath` (string-level path.resolve), not `realpathSync`, so a symlink
inside `~/.claude/` with an `.md` extension passes the whitelist while the
OS read/write follows the link to arbitrary user-accessible files.

**Repro (GET → read /etc/passwd)**:
```bash
ln -sf /etc/passwd /Users/dayuer/.claude/evil.md
curl 'http://127.0.0.1:7200/api/launcher/file?path=/Users/dayuer/.claude/evil.md'
# → 9344 bytes of /etc/passwd, status 200
```

**Repro (POST → overwrite arbitrary user file)**:
```bash
echo "SAFE" > /tmp/target.txt
ln -sf /tmp/target.txt /Users/dayuer/.claude/write-evil.md
curl -X POST '.../api/launcher/file' \
  -d '{"path":"/Users/dayuer/.claude/write-evil.md","content":"OWNED"}'
# → /tmp/target.txt content = "OWNED", symlink left intact, bogus .bak
#   written next to the symlink (not the real target)
```

**Code location**: `plugins/launcher.mjs` L1106-1127.

**Suggested fix** (≤5 lines):
```js
function isAllowedMdPath(absPath) {
  let resolved;
  try { resolved = realpathSync(absPath); }       // resolve symlinks
  catch { resolved = resolvePath(absPath); }      // tolerate not-yet-exists
  // ... existing whitelist checks against `resolved` ...
}
```
For writes, also add `flag: 'w'` + `O_NOFOLLOW` (`fs.openSync(path, 'wx' | constants.O_NOFOLLOW)`).

**Owner**: m2-dev (T13). **Severity**: HIGH — bundled hub on prod listens
LAN; any user-land process can plant the symlink. **Blocks Phase-2 release.**

Cleanup done; no symlinks left on disk.

---

## 1. T11 — Card tabs panel (M1+M3 UI)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1.1 | Tab strip in card template includes URLs/QR · Summary · Edits · Errors · Threshold · Memory (+ Git when `it.worktree`) | ✅ markup-✓ | L670-676 of served HTML: 6 fixed tabs + conditional Git tab |
| 1.2 | Hub cards skip tab strip (just URLs/QR details) | ✅ markup-✓ | conditional branch at L667 (`<details>` plain vs tabbed) |
| 1.3 | `tab-btn.has-error` CSS rule present | ✅ markup-✓ | L267-268 `.tab-btn.has-error { color:var(--bad) }` |
| 1.4 | `compactStatus` banner gated on `enabled && lastResult==='skipped' && reason==='no_inject_channel'` | ✅ markup-✓ | grep shows 10 hits; gating in `renderCompactBanner` logic |
| 1.5 | TAB_LABEL map covers all 7 tabs | ✅ markup-✓ | L1656 `const TAB_LABEL = { urls, summary, edits, errors, threshold, memory, git }` |
| 1.6 | Lazy-load tabs (click → first fetch) + 5s auto-refresh | ✅ markup-✓ | render code at L1675-1731 dispatches per-tab fetch on first activation; visibilityPoll wraps the cycle |
| 1.7 | Threshold form inline validation | ✅ (see [F2]) | endpoint rejects with `missing required field(s)` but expects top-level (not nested) shape — error message misleading |
| 1.8 | `GET /api/launcher/instances/<pid>/run-summary` | ✅ | pid 14819 returned 275 events + totals {prompts:73, tools:141, errors:2, hooks:200, …} |
| 1.9 | `GET /api/launcher/instances/<pid>/recent-edits` | ✅ | files=1, bash=28, totalUniqueTargets present |
| 1.10 | `GET /api/launcher/instances/<pid>/errors` | ✅ | groups=2, total=2 |
| 1.11 | Tab interaction (active state, cache, refresh) | ⚠️ [需人工验证] | logic in source; cannot drive click events without browser |

## 2. T12 — Worktree + Git/PR end-to-end

| # | Item | Status | Evidence |
|---|---|---|---|
| 2.1 | Spawn dialog has `useWorktree` toggle pre-filled from `prefs.worktreeDefault` | ✅ markup-✓ | L5281-5286 wires `wt.checked` from prefs |
| 2.2 | Branch badge `🌿 ccv/foo-7012` in card head | ✅ markup-✓ | 3 hits for `🌿` glyph; rendered when `it.worktree` truthy |
| 2.3 | Top-bar `🌿 N worktrees` counter | ✅ markup-✓ | `btn-worktrees` markup + click handler invokes `/api/launcher/worktrees` |
| 2.4 | Git tab renders only when `it.worktree` | ✅ markup-✓ | conditional at L676 in tab template |
| 2.5 | **E2E demo**: fixture → spawn worktree → diff → commit → push → PR validate → cleanup | ✅ | full run below (§2 E2E) |
| 2.6 | Shell-injection safety on `/git-commit` | ✅ | sent `{"message":"... $(echo PWNED-MUST-NOT-RUN)"}`; commit landed with literal `$(echo PWNED-MUST-NOT-RUN)` in subject — no eval |
| 2.7 | `open-pr` requires `title` | ✅ | 400 `{"error":"title required"}` on POST without title |
| 2.8 | `open-pr` against non-GitHub remote surfaces gh stderr | ✅ | `{"error":"none of the git remotes configured ... point to a known GitHub host. To tell gh about a new GitHub host, please use \`gh auth login\`"}` |
| 2.9 | Cleanup rejects alive-instance worktrees | ✅ | rejected with `instance still alive — stop the ccv first` |
| 2.10 | Cleanup rejects dirty worktrees (no force) | ✅ | rejected with `uncommitted changes` |
| 2.11 | Cleanup with `force:true` succeeds | ✅ | `removed: ["/tmp/demo/.claude/worktrees/demo-31c8df8b"]`, dir gone, `git worktree list` no longer shows it |
| 2.12 | `paths required` (not `path`) — input schema strict | ✅ | sending `{"path":...}` returns 400 `paths required` |

### §2 E2E walkthrough — `/tmp/demo` worktree flow

```bash
# Setup
rm -rf /tmp/demo /tmp/demo-bare.git
git init --bare /tmp/demo-bare.git
git init -b main /tmp/demo
( cd /tmp/demo && echo init > a.md && \
  git -c user.email=t@t.local -c user.name=Tester add . && \
  git -c user.email=t@t.local -c user.name=Tester commit -m init && \
  git remote add origin /tmp/demo-bare.git && \
  git push origin main )

# Spawn with worktree → pid 75986, port 7008
curl -X POST '.../spawn' -d \
  '{"cwd":"/tmp/demo","useWorktree":true,"branchName":"test-t12-tester"}'
# → {ok:true, instance:{pid:75986, cwd:".../worktrees/demo-31c8df8b", ...},
#    worktree:{path:"...", branch:"test-t12-tester", baseRef:"main"}}

# Edit + diff
echo "edited" >> /tmp/demo/.claude/worktrees/demo-31c8df8b/a.md
curl '.../instances/75986/git-diff'
# → {stat:{additions:1,deletions:0,files:1}, files:[{path:"a.md", …}], hasUncommitted:true, ahead:0}

# Commit with shell-injection probe (must be preserved literally)
curl -X POST '.../instances/75986/git-commit' -d \
  '{"message":"tester change to a.md $(echo PWNED-MUST-NOT-RUN)"}'
# → {ok:true, sha:"582da27...", output:"[test-t12-tester 582da27] tester change ..."}
# git log confirms literal "$(echo PWNED-MUST-NOT-RUN)" in subject — no eval.

# Push
curl -X POST '.../instances/75986/git-push' -d '{}'
# → {ok:true, output:"branch 'test-t12-tester' set up to track 'origin/...'."}
# bare repo gained branch test-t12-tester with the commit ✓

# PR validation
curl -X POST '.../instances/75986/open-pr' -d '{"title":"t","base":"main"}'
# → {"error":"none of the git remotes ... point to a known GitHub host..."}
# expected — no gh host on /tmp bare ✓

# Cleanup gating sequence
curl -X POST '.../worktrees/cleanup' -d '{"paths":["..."]}'
# → rejected: "instance still alive — stop the ccv first"
curl -X POST '.../kill' -d '{"pid":75986}'
curl -X POST '.../worktrees/cleanup' -d '{"paths":["..."]}'
# → rejected: "uncommitted changes" (worktree still dirty from earlier edit)
curl -X POST '.../worktrees/cleanup' -d '{"paths":["..."],"force":true}'
# → removed; dir gone; git worktree list clean; /worktrees count back to 0
```

Fixtures (`/tmp/demo`, `/tmp/demo-bare.git`) removed at end.

## 3. T13 — CLAUDE.md scanner (M4)

| # | Item | Status | Evidence |
|---|---|---|---|
| 3.1 | `GET /api/launcher/instances/<pid>/claude-md` returns scoped file list | ✅ | for pid 14819 (ccv-launcher cwd): returned `[{scope:global, path:~/.claude/CLAUDE.md}, {scope:rule, path:~/.claude/rules/aliyun-internal.md}]` |
| 3.2 | `GET /api/launcher/claude-md/all` aggregates across running instances | ✅ | 5 unique files across 4 non-hub instances |
| 3.3 | `/file` GET on whitelisted path returns content | ✅ | 200 + content for `~/.claude/CLAUDE.md` (scanner-discovered) |
| 3.4 | `/file` POST creates file + writes backup chain | ✅ | sandboxed test on `~/.claude/tester-fixture-T13.md`: first write `backup:null`, subsequent writes produce `.bak.<ISO-ts>` |
| 3.5 | `MD_BACKUP_KEEP=5` rotation enforced | ✅ | after 6 sequential writes only **5** .bak files remained; oldest pruned |
| 3.6 | `/file` POST refuses non-`.md` extension | ✅ | `~/.claude/tester-fixture.txt` → 403 `path not in whitelist` |
| 3.7 | `/file` POST refuses out-of-whitelist root | ✅ | `/tmp/evil.md` → 403 |
| 3.8 | `/file` GET refuses `/etc/passwd` | ✅ | 403 |
| 3.9 | `/file` refuses `..` traversal | ✅ | `~/.claude/../../../../etc/passwd` → 403 (and same with `.md` suffix) |
| 3.10 | **`/file` SYMLINK escape allows read+write of arbitrary user files** | ❌ **S1** | see §0 |
| 3.11 | Top-bar `📖 Memory` aggregated drawer | ✅ markup-✓ | `id="btn-mem"` L489 + drawer template L495 |
| 3.12 | Memory tab per-card grouped by scope | ✅ markup-✓ | `renderMemoryHTML` L1851 groups by `scope` |
| 3.13 | Inline editor (380px textarea + Save alert) | ✅ markup-✓ | L1119-1156 wires fetch → textarea → POST → alert showing backup path |

All fixtures, symlinks, and `~/.claude/tester-*` files cleaned up after testing.

## 4. F2 follow-up — `prefs/compact-threshold` validation (commit `88e5cfd`)

| # | Item | Status | Evidence |
|---|---|---|---|
| 4.1 | Malformed `{threshold:75}` rejected | ✅ | 400 `missing required field(s): auto_compact_at, auto_clear_at, enabled` |
| 4.2 | Partial top-level fields rejected | ✅ | sending `{auto_compact_at:75, enabled:true}` (missing `auto_clear_at`) → 400 |
| 4.3 | Correct top-level shape accepted | ✅ | `{cwd, auto_compact_at:75, auto_clear_at:85, enabled:true}` persists |
| 4.4 | **Error message misleading**: caller sending nested `{threshold:{auto_compact_at,...}}` sees same error as malformed | ⚠️ minor | both nested-and-valid and top-level-malformed return identical text. Suggest "expected top-level fields {auto_compact_at, auto_clear_at, enabled}" |

F1 (month cold-cache) — verified closed per perf commit `0ca48a5`:
`?range=today/week/month` all return in <80ms, payload now includes
`pending` field (null when result available, true when computing). Top bar
should render `…` placeholder on `pending:true`.

## 5. Phase 1 regression sanity

| # | Item | Status |
|---|---|---|
| 5.1 | `usage/summary` today/week/month all hot | ✅ |
| 5.2 | `quota/5h` ccline_cache source, no null leak in tooltip | ✅ (Phase 1 incremental) |
| 5.3 | `activity` bulk endpoint returns contextUsage on non-hub instances | ✅ 2/6 entries with ctx (others lack recent jsonl events — expected) |
| 5.4 | Top-bar 3-slot cost layout markup | ✅ (Phase 1 incremental) |
| 5.5 | Kanban 3-column data-col attribute | ✅ (Phase 1) |
| 5.6 | Tag filter / j/n / help dialog | ✅ markup-✓ (Phase 1; not re-driven) |
| 5.7 | Pair flow request → status → reject | ✅ (Phase 1) — re-verifying would create noise in pending pairs |
| 5.8 | iframe/term overlay markup intact | ✅ markup-✓ |
| 5.9 | spawn ✓ kill ✓ (exercised live during T12 E2E) | ✅ |

## 6. Endpoint matrix (Phase 2)

```bash
curl    .../api/launcher/instances/<pid>/run-summary    # T11 source
curl    .../api/launcher/instances/<pid>/recent-edits   # T11 source
curl    .../api/launcher/instances/<pid>/errors         # T11 source
curl    .../api/launcher/instances/<pid>/claude-md      # T13 scanner
curl    .../api/launcher/instances/<pid>/git-diff       # T12 (gated on worktree)
curl -X POST .../api/launcher/instances/<pid>/git-commit
curl -X POST .../api/launcher/instances/<pid>/git-push
curl -X POST .../api/launcher/instances/<pid>/open-pr   # NOT git-pr (UI uses act='git-pr' but endpoint is /open-pr)
curl    .../api/launcher/worktrees
curl -X POST .../api/launcher/worktrees/cleanup         # body: {paths:[...], force?:bool}
curl    .../api/launcher/claude-md/all
curl    .../api/launcher/file?path=...                  # ⚠ symlink escape — see §0
curl -X POST .../api/launcher/file                      # ⚠ symlink escape — see §0
```

## 7. Sign-off

**Phase 2 functionality is RIGHT THERE — but blocked on one HIGH security
finding (§0)**:

- ❌ **S1 / HIGH (BLOCKING)** — `/api/launcher/file` symlink escape (T13).
  Must be fixed before any release. ~5-line patch in `isAllowedMdPath` +
  `O_NOFOLLOW` on write.
- ✅ T11 — all backend endpoints + markup correct. Tab interaction lazy-load
  + auto-refresh remains `[需人工验证]` (no browser).
- ✅ T12 — full E2E walked: spawn worktree → edit → diff → commit (with
  shell-injection probe) → push → PR-validate → cleanup gating with force
  override. All passed.
- ✅ T13 backend — scanner endpoints, backup rotation, 403 boundary on
  /etc/passwd, traversal, non-.md, non-whitelisted root — all enforced.
  **EXCEPT** the symlink escape in §0.
- ✅ F2 (Phase 1 follow-up) — endpoint now rejects malformed input;
  error message could be clearer about expected shape.
- ✅ F1 (Phase 1 follow-up) — closed by `0ca48a5` perf commit.
- ✅ Phase 1 regression — sanity passed; spawn/kill exercised live during T12.

**Recommendation**: hold Phase 2 release until S1 is patched. Once
m2-dev ships the fix, I can re-verify the symlink scenario in ~2 minutes.

### Lingering [需人工验证] items (lead to assign)
- T11 tab click → lazy fetch → cache → switch-back smoothness
- T11 auto-refresh visibility-pause behavior under tab hidden/visible
- T11 Threshold form inline-error rendering (server side validated; UI
  presentation needs visual)
- T12 spawn dialog `useWorktree` checkbox pre-filled from prefs
- T13 inline editor 380px textarea + Save alert wording
- T13 top-bar 📖 Memory drawer visual
- F2 error-message UX (the misleading text question)
