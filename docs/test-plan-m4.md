# M4 — CLAUDE.md scanner + inline editor test plan

> ⚠ DANGER — read before running any step:
> - **NEVER** touch port **7100** — that's the prod launchd hub (`com.user.ccv-hub`).
>   Always bring up a separate test hub on port **7200** (recipe below).
> - **NEVER** run any `launchctl` command (`kickstart`, `unload`, `bootout`, …)
>   against the prod hub.
> - **NEVER** read, write, or curl-POST to `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`,
>   or anything else under the real `~/.claude/` tree — those are the user's
>   live global config (Conventional Commits rules, internal-network gotchas,
>   vault paths). The scanner WILL surface them in `scope=global` / `scope=rule`,
>   which is correct behavior — **but the tester must not edit them.** Use the
>   `/tmp/ccv-t13-fixture/CLAUDE.md` fixture below instead.
>
> If you need to verify write behavior on a real file under `~/.claude/`,
> **ask the user first.**

Backend scanner (`scanClaudeMd`) + whitelisted file read/write endpoints + per-card
Memory tab + top-bar `📖 Memory` aggregated drawer.

Owners: `m2-dev` (impl), `tester` (E2E)

## 0. Fixture

A throwaway project with its own CLAUDE.md + a nested `.claude/skills/foo/x.md`,
so the scanner picks up `scope=project` AND `scope=...md-under-.claude/` and
the tester has a SAFE target for the write-path test:

```sh
test -d /tmp/ccv-t13-fixture && rm -rf /tmp/ccv-t13-fixture
mkdir -p /tmp/ccv-t13-fixture/.claude/skills/foo
cd /tmp/ccv-t13-fixture
git init -q -b main
cat > CLAUDE.md <<'EOF'
# fixture project memory

This file is safe to edit during T14 testing.

EOF
cat > .claude/skills/foo/x.md <<'EOF'
# foo skill (fixture)
EOF
git add . && git -c user.email=demo@local -c user.name=demo commit -q -m init
```

Cleanup at the end of the test session:

```sh
rm -rf /tmp/ccv-t13-fixture
```

## 1. Pre-flight (no hub kickstart required)

`scanClaudeMd` + `isAllowedMdPath` + `backupMdBeforeWrite` were verified
in-process before the M4 commit landed:

- `scanClaudeMd('/path/to/ccv-launcher')` returned the real
  global CLAUDE.md and resolved `@~/.claude/rules/aliyun-internal.md` as
  scope=`rule`. Read-only — no writes.
- Whitelist accepts: `<fixture>/CLAUDE.md`, `<fixture>/.claude/skills/foo/x.md`,
  `~/.claude/CLAUDE.md`, `~/.claude/rules/aliyun-internal.md`. (The last two
  are READ-allowed — the tester must not WRITE them.)
- Whitelist rejects: `/tmp/ccv-t13-fixture/random.md` (no `.claude/`, not named
  CLAUDE.md), `/tmp/secret.md` (not in any allowed root), `/etc/passwd` (not
  `.md`), `<fixture>/.claude/../../escape.md` (resolves outside fixture).
- Backup rotation: 7 writes to the same target left exactly the 5 newest
  `<path>.bak.<ISO-ts>` siblings.

## 2. End-to-end with an isolated TEST hub on port 7200

Same recipe as `test-plan-m2.md` §2. The plugin is loaded via the existing
`~/.claude/cc-viewer/plugins/launcher.mjs` symlink, so the test hub picks up
the M4 changes on every fresh start without touching prod:

```sh
# Bail if 7200 already in use (NEVER kill 7100):
TEST_HUB_PID=$(lsof -nP -iTCP:7200 -sTCP:LISTEN -t || true)
[ -n "$TEST_HUB_PID" ] && kill "$TEST_HUB_PID" && sleep 1

CCV_HUB=1 \
CCV_START_PORT=7200 CCV_MAX_PORT=7200 \
CCV_CHILD_PORT_FLOOR=7008 CCV_CHILD_PORT_CEIL=7099 \
ccv --d --no-open &

sleep 2 && curl -s http://127.0.0.1:7200/healthz
```

At the end of the session:

```sh
kill $(lsof -nP -iTCP:7200 -sTCP:LISTEN -t)
```

### 2.1 Spawn at the fixture

1. Open `http://127.0.0.1:7200/launcher` in the browser.
2. **+ New** → directory `/tmp/ccv-t13-fixture` → Launch (no need to tick the
   worktree checkbox; M4 doesn't require a worktree).
3. Card appears in dashboard, group name = `ccv-t13-fixture`.

### 2.2 Memory tab — read path

1. Expand the card's `<details>`, click the **Memory** tab.
2. Expect 3 groups populated:
   - **项目 (1)** — `/tmp/ccv-t13-fixture/CLAUDE.md`
   - **全局 (1)** — `~/.claude/CLAUDE.md` (DO NOT edit this row)
   - **Rules (1+)** — `~/.claude/rules/aliyun-internal.md` and any other
     `@~/.claude/rules/*.md` referenced from the global CLAUDE.md (DO NOT edit)
3. Click the project CLAUDE.md row → 380px monospace textarea opens with the
   file's current contents.

curl equivalent:

```sh
PID=$(curl -s 'http://127.0.0.1:7200/api/launcher/list' | jq -r '.instances[]
  | select(.cwd=="/tmp/ccv-t13-fixture") | .pid' | head -1)
curl -s "http://127.0.0.1:7200/api/launcher/instances/$PID/claude-md" | jq '.files[] | {path, scope, size}'
curl -sG 'http://127.0.0.1:7200/api/launcher/file' --data-urlencode 'path=/tmp/ccv-t13-fixture/CLAUDE.md' | jq '{size, mtime, head: .content[0:60]}'
```

### 2.3 Memory tab — write path (FIXTURE ONLY)

In the open textarea, append a line like `edited via launcher at <date>`,
click **Save**.

Expect:
- Alert: `Saved · <N> bytes` plus `backup: /tmp/ccv-t13-fixture/CLAUDE.md.bak.<ISO-ts>`
- Memory tab auto-reloads, showing the new size + mtime
- On disk:
  ```sh
  ls /tmp/ccv-t13-fixture/CLAUDE.md*
  # → CLAUDE.md + CLAUDE.md.bak.<ts>
  cat /tmp/ccv-t13-fixture/CLAUDE.md         # has your appended line
  cat /tmp/ccv-t13-fixture/CLAUDE.md.bak.*   # original content
  ```

Repeat the save 6 more times (small edits each) to validate rotation:

```sh
ls /tmp/ccv-t13-fixture/CLAUDE.md.bak.* | wc -l
# → 5 (newest five only; older ones auto-pruned)
```

curl equivalent (still on the fixture, NEVER the real ~/.claude/CLAUDE.md):

```sh
curl -s -X POST 'http://127.0.0.1:7200/api/launcher/file' \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/ccv-t13-fixture/CLAUDE.md", "content": "# fixture\nedited via curl\n"}'
# → {"ok":true,"path":"...","size":...,"backup":"...CLAUDE.md.bak.<ts>"}
```

### 2.4 Whitelist enforcement (negative cases)

All of these must return non-2xx — confirming the whitelist actually blocks the
hazards the banner warns about:

```sh
# 1) Outside any allowed root → 403
curl -s -X POST 'http://127.0.0.1:7200/api/launcher/file' \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/secret.md", "content": "should be rejected"}'
# → 403 {"error":"path not in whitelist"}

# 2) Not a .md → 403 (even with traversal)
curl -s -X POST 'http://127.0.0.1:7200/api/launcher/file' \
  -H 'Content-Type: application/json' \
  -d '{"path": "/etc/passwd", "content": "x"}'
# → 403

# 3) Traversal: tries to escape fixture via .. — resolvePath collapses, falls
#    outside cwd ancestor chain → 403
curl -s -X POST 'http://127.0.0.1:7200/api/launcher/file' \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/ccv-t13-fixture/.claude/../../escape.md", "content": "x"}'
# → 403

# 4) Random .md inside fixture but NOT CLAUDE.md and NOT under .claude/ → 403
curl -s -X POST 'http://127.0.0.1:7200/api/launcher/file' \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/ccv-t13-fixture/random.md", "content": "x"}'
# → 403
```

### 2.5 Aggregated Memory drawer

1. Click the top-bar `📖 Memory` button (right side, next to `?`).
2. Right-side drawer opens, showing every CLAUDE.md across all running
   non-hub instances, de-duped by absolute path.
3. Rows: `<scope>  <path>  pids:<id,id,...>` — for the fixture pid, the
   project row should list `pids:<the spawned pid>`.

curl equivalent:

```sh
curl -s 'http://127.0.0.1:7200/api/launcher/claude-md/all' | jq '.files[] | {scope, path, pids}'
```

### 2.6 Cleanup

```sh
# Stop the test-fixture ccv via the card's Stop button (or kill the pid
# directly). Then:
rm -rf /tmp/ccv-t13-fixture

# Stop the test hub (NEVER touch port 7100):
kill $(lsof -nP -iTCP:7200 -sTCP:LISTEN -t)
```

## 3. What the tester must NOT do

- Do not click Save on any Memory tab row where the path begins with
  `/Users/<you>/.claude/` (i.e. scope=global or scope=rule). Read-only inspection
  is fine and useful; writes overwrite the user's real config.
- Do not curl-POST `/api/launcher/file` against any path under `~/.claude/`.
- Do not run `launchctl kickstart` / `unload` / `bootout` on
  `com.user.ccv-hub`.
- Do not change the test hub's `CCV_START_PORT` to anything other than 7200.
