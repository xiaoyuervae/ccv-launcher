# Test baseline — pre Phase 1/2

Snapshotted at HEAD `62443c0` (T2 merged). Tester uses this as the diff base
when verifying Phase 1 / Phase 2 endpoint and UI additions.

## A. HTTP routes registered in `plugins/launcher.mjs`

Location: `dispatchLauncherRoute(req, res, parsedUrl)` (around L2840-L3284).
Anything claiming Phase 1/2 should add NEW entries below; existing entries
must keep their contract (same method, same response shape).

### Pages
| Method | Path | Line | Notes |
|---|---|---|---|
| GET | `/healthz` | 2844 | unchanged |
| GET | `/launcher/pair` | 2873 | pair entry page |
| GET | `/launcher/pair/complete` | 2907 | callback page |
| GET | `/launcher/logout` | 2966 | clear cookie |
| GET | `/launcher` | 2980 | dashboard HTML |

### Pairing
| Method | Path | Line |
|---|---|---|
| POST | `/api/launcher/pair-request` | 2879 |
| GET  | `/api/launcher/pair-status` | 2890 |
| POST | `/api/launcher/pair-approve` | 2926 |
| POST | `/api/launcher/pair-reject` | 2945 |
| GET  | `/api/launcher/pair-list` | 2957 |

### Core
| Method | Path | Line |
|---|---|---|
| GET  | `/api/launcher/list` | 2986 |
| POST | `/api/launcher/takeover-cc-session` | 3028 |
| GET  | `/api/launcher/activity` | 3063 |
| GET  | `/api/launcher/instances/{pid}/activity` | 3084 (regex match) |
| GET  | `/api/launcher/browse-dir` | 3104 |
| POST | `/api/launcher/spawn` | 3130 |
| POST | `/api/launcher/kill` | 3148 |
| POST | `/api/launcher/forget` | 3169 |

### Prefs (T2 additions present in baseline)
| Method | Path | Line |
|---|---|---|
| GET  | `/api/launcher/prefs` | 3184 |
| POST | `/api/launcher/prefs/alias` | 3195 |
| POST | `/api/launcher/prefs/ccuse-profile` | 3208 |
| POST | `/api/launcher/prefs/tags` | 3225 |
| POST | `/api/launcher/prefs/compact-threshold` | 3239 |
| POST | `/api/launcher/prefs/worktree-default` | 3256 |

### Misc
| Method | Path | Line |
|---|---|---|
| POST | `/api/launcher/open-terminal` | 3268 |

### Endpoints expected in Phase 1 (NOT YET PRESENT)
- `GET /api/launcher/usage/summary?range=today|week|month` — T3
- `GET /api/launcher/quota/5h` — T5
- (context % may piggy-back on `/list` or expose own endpoint — T4)

### Endpoints expected in Phase 2 (NOT YET PRESENT)
- Run summary timeline — T9
- Recent edits / errors aggregation — T10
- Worktree spawn + commit/push + open-PR endpoints — T12
- CLAUDE.md scanner — T13

## B. HTML element ids in dashboard (pre Phase 1/2)

Source: `HTML_PAGE` constant in launcher.mjs.

```
btn-cancel, btn-launch, btn-new
ccuse-select
ccv-bar, ccv-close, ccv-frame, ccv-frame-err-detail, ccv-frame-newtab,
ccv-frame-retry, ccv-frame-status, ccv-name, ccv-newtab, ccv-overlay,
ccv-path, ccv-port, ccv-reload
code, cwd, dlg, err
list, meta
pair-zone
status
term-bar, term-close, term-container, term-name, term-overlay,
term-path, term-type, tree
```

### Class names baseline
```
activity-drawer, activity-row, activity-toggle
alias-edit
approve, ask-row
badge no_session, bare-tag, btn (+ primary/danger), card idle,
card-actions, card-head, card-meta, card-path, card-title
code, code-box, content
dot (gray/amber/green)
drawer-h, drawer-section
empty (+ err), err, err-actions, err-detail, err-title
event-body, event-line (user/tool/assistant/flag), event-row, event-ts
ext-tag
group (.is-hub variant)
```

### NOT YET PRESENT (Phase 1 should add)
- top bar / usage bar with cost (today/week/month)
- 5h-window progress bar with plan name + remaining time
- per-card context % progress bar
- Kanban 3-column layout (`.kanban`, `.col-*`, etc.)
- single-char status icons replacing emoji `🛠 ⏳`
- tag input + autocomplete UI
- j/n keyboard navigation jumping to `waiting_ask` cards (only ESC handlers exist now)

### NOT YET PRESENT (Phase 2 should add)
- card-tabs (run summary / recent edits / errors)
- timeline dot rendering inside expand panel
- compact-threshold form control
- worktree default form control + worktree spawn flow
- "Open PR" button + status pill
- CLAUDE.md chain panel for current cwd

## C. Existing keyboard / interactivity baseline
- `Escape` closes terminal overlay (L2435) and ccv iframe overlay (L2545).
- `Enter` in cwd input triggers spawn (L2685).
- No `j` / `n` / `g` global jumps yet.

## D. Existing polling cadences
- `/api/launcher/list` driven by `refresh()` (L2551).
- `/api/launcher/activity` via `refreshActivity()` (L2595).
- Per-card expand fetches `/api/launcher/instances/{pid}/activity` on demand (L2643).
- New endpoints (`/usage/summary`, `/quota/5h`) MUST piggy-back on the same
  visibility-pause pattern (`document.hidden` gate) — verify in Phase 1 tests.

## E. Test hub recipe
```bash
# never touch prod (port 7100, launchd)
CCV_HUB=1 CCV_START_PORT=7200 CCV_MAX_PORT=7200 ccv --d --no-open
# then: open http://127.0.0.1:7200/launcher (LAN exempt, no token)
# teardown: lsof -i :7200 -sTCP:LISTEN -t | xargs -r kill
```
