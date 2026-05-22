# 5h Quota — Tier Decisions

Implementation record for `GET /api/launcher/quota/5h` (T5, commit `462a59d`).
Background research lives in [research-quota-source.md](./research-quota-source.md);
this doc captures the *implementation-time* decisions and the gaps a future
contributor needs to know about.

---

## Goal

Surface a single, always-shaped envelope for "how much of the rolling 5h
quota window has been consumed". Same shape regardless of which underlying
data source produced it, so the UI never has to branch on "is the API up".

```
{
  source: "ccline_cache" | "api_oauth" | "jsonl_compute" | "unavailable",
  percent: number|null,
  used: number|null,
  limit: number|null,
  reset_at: string|null,
  plan_name: "Pro"|"Max5"|"Max20"|null,
  burn_rate: number|null,
  projection_minutes: number|null,
  // tier-specific extras (cached_at, block_*, extra_usage, reason, ...)
  computedAt, fromCache, stale
}
```

Discriminator on `source`. Anything that varies per tier is `null` on tiers
that can't supply it (rather than omitted) so UI doesn't `?.` blindly.

---

## Tier 1 — `ccline_cache` (default)

**Path:** `~/.claude/ccline/.api_usage_cache.json`

**Why first:** zero cost — one `fs.readFile` + `JSON.parse`. The
[CCometixLine](https://github.com/Haleclipse/CCometixLine) statusline binary
already polls Anthropic's private `/api/oauth/usage` every 5 min and writes
this cache file. We piggyback on its work.

**What it gives:** `five_hour_utilization` (0-100%), `seven_day_utilization`,
`cached_at`. **Not** raw token counts — the cache is utilization-only, by
design. We surface `seven_day_resets_at` separately because the cache's
`resets_at` field is the seven-day reset, not the 5h one (a known footgun
called out in the upstream schema).

**Staleness:** `cached_at` older than 5 min → fall through. ccline's default
poll cadence is 5 min, so this is roughly "ccline isn't running or has
errored".

**Limitation accepted:** no raw `used`/`limit`/`burn_rate`. UI shows the
percent bar without the "X / Y tokens" subtitle when tier 1 wins.

---

## Tier 2 — `api_oauth` (fallback)

**Endpoint:** `GET https://api.anthropic.com/api/oauth/usage` with
`Authorization: Bearer <accessToken>` and `anthropic-beta: oauth-2025-04-20`.

**What we do:** read `~/.claude/.credentials.json` cleartext (when present),
extract `claudeAiOauth.accessToken`, hit the API with a 6s timeout.

**What we deliberately do NOT do:**

1. **No macOS Keychain integration.** ClaudeBar shells out to the `security`
   command to fetch the same token from the Keychain. That works for an
   interactive Mac app (the user clicks "Allow" on the Keychain prompt the
   first time), but the launcher hub runs **unattended via launchd** and
   would block forever on the first prompt. Punted.
2. **No token refresh.** `access_token` rotates roughly every 8 hours; on
   401 we'd need to POST to `https://console.anthropic.com/v1/oauth/token`
   with the `refresh_token`. This is doable but non-trivial (mutex around
   the refresh, persist the new tokens back to disk, handle 1-hour throttle
   responses ClaudeBar has documented). Skipped because tier 1 covers
   ≥95% of cases — most users have ccline running.

**Consequence:** tier 2 only fires on machines that (a) don't have ccline
*and* (b) keep credentials in cleartext on disk. That's a thin slice. For
everyone else we land in tier 3.

**If you decide to add keychain support later:** the right place is
`readClaudeOauthToken()` in `plugins/launcher.mjs`. Minimum viable:
`spawn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])`.
Cache the result for the access_token's lifetime (parse the JWT `exp`
claim, leave 60s safety margin). Add a `keychain_unavailable` telemetry
hint so we can tell the difference between "keychain prompt denied" and
"creds not present".

---

## Tier 3 — `jsonl_compute`

**Source:** every `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
modified within the last 192 h.

**Why 192 h horizon:** Maciek-roboblog's Claude-Code-Usage-Monitor uses 8
days of history to stabilize the P90 burn-rate estimate. Shorter windows
under-sample bursty users; longer windows over-sample stale habits.

### Block algorithm (ccusage-style)

1. Parse all `assistant` turns; key = `(timestamp, prompt+output+cache tokens, model)`.
2. Sort by timestamp.
3. First turn → block start floored to the hour. Block end = start + 5 h.
4. New block when next turn is past current block's end **OR** the gap
   from previous turn is > 5 h (idle break).
5. **Active block** = whichever block contains `now`.

### Plan auto-detection

Plan thresholds (from task spec, matching Maciek-roboblog's defaults):

| Plan  | 5h token cap |
|-------|--------------|
| Pro   | 19,000       |
| Max5  | 88,000       |
| Max20 | 220,000      |

We take the **max-tokens block** observed in the 192h window and bucket
the user into the smallest tier `≥ max_observed`. Above 220k → bucketed as
Max20 (and `plan_max_observed` is surfaced so UI can see the overflow).

### P90 burn rate

For each *completed* block (`block.end ≤ now` and `≥ 2 turns`), compute
`tokens / (lastTs − firstTs) / 60s` = tokens/min. P90 across the list
(or 0 if no completed blocks). `projection_minutes = (limit − used) / burn_rate`.

### Token-counting choice

Token sum = `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens` —
all four buckets summed, matching ccusage's `tokenCounts.totalTokens`.

**Known caveat:** for heavy multi-agent workloads (many parallel sub-agents
re-reading large caches), `cache_read` dominates and the active block can
exceed Max20 by orders of magnitude. `percent` is capped at 100 but raw
`used` and `limit` pass through unmodified, so UI can render "limit
exceeded" rather than a misleading "100% exactly". If we later observe
real users complaining, we can switch to `input + output + cache_creation`
(dropping `cache_read`) — the change is one line in `gatherTurnsForBlocks`.

---

## Tier 4 — `unavailable`

Reached when ccline cache is missing/stale, OAuth token is missing, and
jsonl_compute throws (very unlikely — only on filesystem errors). Returns
the standard envelope with all stats `null` and a human-readable `reason`
string. UI renders a placeholder + suggests installing ccline.

---

## Cache strategy

| Layer  | TTL   | Where                                 |
|--------|-------|---------------------------------------|
| Memory | 30 s  | `_quota5hMem` in launcher.mjs         |
| Disk   | 5 min | `~/.claude/cc-viewer/launcher-cache.json` (key `quota5h`) |

Stale-while-revalidate. Cold scan is ~2 s on heavy datasets (16k turns,
20 blocks); cache shields polls. Cold-miss only happens once per launchd
restart.

---

## Maintenance

- Plan thresholds are constants in `PLAN_THRESHOLDS`. If Anthropic adjusts
  the published caps, update there.
- `vendor/pricing.json` and `vendor/models.json` are not used by tier 3
  itself — only by the broader `/api/launcher/usage/*` endpoints — but
  share the same drift risk.
- Researcher's [research-quota-source.md](./research-quota-source.md) is
  the authoritative deep-dive. This file is the implementation-time *deltas*.
