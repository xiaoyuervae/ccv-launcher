# M2 — worktree + commit/push + Open PR test plan

> ⚠ DANGER — read before running any step:
> - **NEVER** touch port **7100** — that's the prod launchd hub (`com.user.ccv-hub`).
>   Always bring up a separate test hub on port **7200**.
> - **NEVER** run any `launchctl` command (`kickstart`, `unload`, `bootout`, …)
>   against the prod hub. KeepAlive will respawn it but real children + active
>   sessions get interrupted.
> - **NEVER** write to `~/.claude/CLAUDE.md` or any file under `~/.claude/` as
>   part of this test — that's the user's real global config (Conventional
>   Commits rules, internal-network gotchas, vault paths). Loss is silent +
>   permanent. Use the `/tmp/ccv-*-fixture` directories below instead.
>
> If you need to verify behavior on the prod hub, **ask the user first.**

Backend + UI for spawning ccv instances in dedicated git worktrees, then
committing / pushing / opening PRs from the launcher dashboard's per-card Git
tab.

Owners: `m2-dev` (impl), `tester` (E2E)

## 0. Local fixtures

A throwaway repo + bare remote at `/tmp/ccv-m2-demo` and `/tmp/ccv-m2-remote`:

```sh
# init demo + bare remote
test -d /tmp/ccv-m2-demo && rm -rf /tmp/ccv-m2-demo
test -d /tmp/ccv-m2-remote && rm -rf /tmp/ccv-m2-remote
mkdir -p /tmp/ccv-m2-demo
cd /tmp/ccv-m2-demo
git init -q -b main
echo "# demo" > README.md
echo "console.log('hi')" > app.js
git add . && git -c user.email=demo@local -c user.name=demo commit -q -m init

git init -q --bare -b main /tmp/ccv-m2-remote
git remote add origin /tmp/ccv-m2-remote
git push -q origin main
git branch -u origin/main main
```

Worktree files are auto-placed under `<cwd>/.claude/worktrees/<auto-name>/`.
Add `.claude/worktrees/` to the parent repo's `.gitignore` to keep the working
tree clean (the launcher does NOT modify the parent repo's `.gitignore`).

## 1. Pre-flight (no hub kickstart required)

The pure helper logic (worktree create / git-diff parsing / commit /
push / cleanup gating) was validated in-process via
`/tmp/t12-smoke.mjs` (deleted after run). All six steps PASSED:

- `createWorktree('/tmp/ccv-m2-demo')` returns `{ path, branch=ccv/<auto>, baseRef='main' }`
- Worktree appears in `git -C /tmp/ccv-m2-demo worktree list`
- diff endpoint extracts `numstat -z` rows + appends `??` untracked files
- commit message containing backticks / quotes / `$shell` flows through stdin
  (`git commit -F -`) without shell injection
- push to local bare remote via `--set-upstream origin <branch>:<branch>` works
- cleanup refuses when `dirty=true`; allows when clean + ahead=0

## 2. End-to-end with an isolated TEST hub on port 7200

The user's prod hub at port 7100 (`com.user.ccv-hub`) MUST stay running and
MUST NOT be kickstart-ed. Bring up a separate test hub on port 7200 from the
same `plugins/launcher.mjs` source (via the existing
`~/.claude/cc-viewer/plugins/launcher.mjs` symlink):

```sh
# 0. Make sure 7200 is free; bail loud if something else owns it.
lsof -nP -iTCP:7200 -sTCP:LISTEN || echo "port 7200 free, ok"
# If anything is on 7200 from a previous run, find + kill it (NEVER 7100):
TEST_HUB_PID=$(lsof -nP -iTCP:7200 -sTCP:LISTEN -t || true)
[ -n "$TEST_HUB_PID" ] && kill "$TEST_HUB_PID" && sleep 1

# 1. Start the test hub bound to 7200 only. NOT under launchctl —
#    it dies cleanly with ^C / kill, never restarts itself, never
#    interferes with the prod hub.
CCV_HUB=1 \
CCV_START_PORT=7200 CCV_MAX_PORT=7200 \
CCV_CHILD_PORT_FLOOR=7008 CCV_CHILD_PORT_CEIL=7099 \
ccv --d --no-open &

# 2. Verify it's up
sleep 2 && curl -s http://127.0.0.1:7200/healthz
```

When you're done with the test session, kill the test hub:

```sh
kill $(lsof -nP -iTCP:7200 -sTCP:LISTEN -t)
```

### 2.1 Spawn with worktree (UI)

1. Open `http://127.0.0.1:7200/launcher` in a browser.
2. Click **+ New**, select `/tmp/ccv-m2-demo`, tick `新建 git worktree`, click **Launch**.
3. Card appears in dashboard with branch chip `🌿 ccv/ccv-m2-demo-<hex>` in the head row.
4. Top bar shows `🌿 1` counter.

Expected runtime:

```
ls /tmp/ccv-m2-demo/.claude/worktrees/
# → ccv-m2-demo-<hex>/

git -C /tmp/ccv-m2-demo worktree list
# → main + the new worktree on branch ccv/ccv-m2-demo-<hex>
```

### 2.2 Edit a file (in the child ccv's terminal or directly on disk)

```sh
echo "// new line by m2 test" >> /tmp/ccv-m2-demo/.claude/worktrees/ccv-m2-demo-*/app.js
```

### 2.3 Inspect via Git tab (UI)

1. Expand the card's `<details>`, click the **Git** tab.
2. Header shows `🌿 ccv/...` `+1 -0 in 1 file` `· in sync with origin`.
3. File list shows `app.js  +1 -0`.

curl equivalent (substitute the pid from `/api/launcher/list`):

```sh
curl -s http://127.0.0.1:7200/api/launcher/instances/<pid>/git-diff | jq
```

### 2.4 Commit

1. Click **Commit**, type `feat: add a line via launcher`, OK.
2. Alert shows `Committed <8-char-sha>`.
3. Git tab reloads showing `working tree clean · 1 commit ready to push`.

curl equivalent:

```sh
curl -s -X POST http://127.0.0.1:7200/api/launcher/instances/<pid>/git-commit \
  -H 'Content-Type: application/json' \
  -d '{"message": "feat: add a line via launcher"}'
# → { "ok": true, "sha": "<full-sha>", "output": "[ccv/... <short>] feat: ..." }
```

### 2.5 Push

1. Click **Push**, accept confirm.
2. Alert shows `Pushed: branch 'ccv/...' set up to track 'origin/...'`.
3. Git tab refreshes: ahead=0.

Verify on the bare remote:

```sh
git -C /tmp/ccv-m2-remote branch --list
# → ccv/ccv-m2-demo-<hex> + main
```

curl equivalent:

```sh
curl -s -X POST http://127.0.0.1:7200/api/launcher/instances/<pid>/git-push \
  -H 'Content-Type: application/json' -d '{"force": false}'
```

### 2.6 Open PR (no real GitHub remote on /tmp demo)

1. Click **Open PR**.
2. Title/body prompts open in sequence.
3. Backend tries `gh pr create`; gh will fail with "no GitHub remote
   configured" because /tmp/ccv-m2-remote is a local bare repo.
4. UI shows `Open PR failed: ...`. **This is expected for the /tmp fixture.**

To smoke the success path you need a real GitHub remote. From a different repo
checked out from `git@github.com:<you>/<repo>.git`, repeat steps 2.1–2.6;
clicking **Open PR** should produce a `https://github.com/...` URL alert and
auto-open it in a new tab. Backend pre-checks `gh auth status`; if not logged
in, the UI alert reads `Open PR failed: 需要 gh auth login (gh CLI 未登录)`.

### 2.7 Cleanup

1. Stop the worktree-spawned ccv (Stop button on the card).
2. Top bar `🌿` count stays 1 (worktree on disk, no live pid).
3. Click `🌿 1`, dialog lists the orphan worktree as `orphan` (or `dirty` if uncommitted).
4. Tick checkbox, click **Clean selected**.
5. Alert: `removed 1 worktree(s)`.
6. Top bar `🌿` disappears (count = 0).

Force path: leave a file uncommitted in the worktree, attempt cleanup without
force → alert lists `rejected: <path> — uncommitted changes`. Tick **force**
checkbox and retry → confirms destructive intent, then removes.

curl equivalents:

```sh
curl -s http://127.0.0.1:7200/api/launcher/worktrees | jq
curl -s -X POST http://127.0.0.1:7200/api/launcher/worktrees/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"paths": ["/tmp/ccv-m2-demo/.claude/worktrees/ccv-m2-demo-<hex>"], "force": false}'
```

## 3. Security checks (manual)

- Try `useWorktree=true` on a non-git directory → API 400 `cwd is not a git repository`.
- Inspect the `git worktree add` invocation via `ps -axww | grep worktree`
  during a spawn — branch + path appear as separate argv slots, never inside
  a shell command line. Same for commit / push / gh.
- Try the cleanup endpoint with a path NOT in `_pidWorktrees` →
  `rejected: ... not a launcher-tracked worktree`. The endpoint never runs
  `git worktree remove` against arbitrary user input.
- Branch name regex `^[a-zA-Z0-9_./-]{1,80}$` rejects `; rm -rf /`, backticks,
  shell metas, even though they could never reach a shell anyway.

## 4. Known limitations / follow-ups

- Hub restart drops `_pidWorktrees` (in-memory only). Orphan worktrees stay on
  disk and are still visible in `git -C <cwd> worktree list`, but the launcher
  dashboard's `🌿 N` counter resets to 0 because we don't reconcile on boot.
  Acceptable for M2; reconciliation is a future enhancement.
- Untracked file LOC count uses `wc -l`; binary files report 0 lines. Good
  enough for the diff stat header.
- `gh pr create` runs synchronously with a 30s timeout. Slow networks may time
  out; we surface the gh stderr verbatim in the alert.
