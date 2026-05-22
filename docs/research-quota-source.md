# Claude 5h Quota Source — Investigation

**Question:** ClaudeBar 顶栏显示的 5 小时配额条到底从哪儿读？我们 launcher 应该照搬还是另选数据源？

**结论先行：** ClaudeBar 实际上是双轨制 — 优先走 **Anthropic 私有 OAuth API**（`/api/oauth/usage`），失败时降级到 **`claude /usage` CLI 输出抓屏**。本机已经有第三方进程（CCometixLine / `ccline`）每 5 分钟刷新一份缓存到 `~/.claude/ccline/.api_usage_cache.json`，launcher 从那里读最便宜，不需要自己调 API、也不需要 spawn `claude`。

---

## 1. ClaudeBar 的双数据源

ClaudeBar 把"5h 配额"封装成 `UsageSnapshot` 对象，由两个 probe 之一产出。

### 1.1 `ClaudeAPIUsageProbe`（首选，直接调 Anthropic API）

文件：`Sources/Infrastructure/Claude/ClaudeAPIUsageProbe.swift`

- **Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`
- **Auth**: `Authorization: Bearer <oauth_access_token>` — token 从 macOS Keychain 读出来（`ClaudeCredentialLoader`），就是 `claude login` 写进去的那一份
- **必需 header**: `anthropic-beta: oauth-2025-04-20`
- **User-Agent**: `claude-code/<version>`（拿 npm 上的 `@anthropic-ai/claude-code` 版本号拼）
- 响应：

```json
{
  "five_hour":  { "utilization": 3.0,  "resets_at": "2026-05-22T15:00:00Z" },
  "seven_day":  { "utilization": 0.0,  "resets_at": "2026-05-29T07:00:00Z" },
  "seven_day_sonnet": { "utilization": 0.0, "resets_at": "..." },
  "seven_day_opus":   { "utilization": 0.0, "resets_at": "..." },
  "extra_usage": {
    "is_enabled": true,
    "used_credits": 5.41,
    "monthly_limit": 20.0
  }
}
```

`utilization` 是百分比 0–100（已用比例），`resets_at` 是 ISO-8601 UTC。这就是顶栏 "5h 3% used · resets 4:59pm" 的真实数据来源。

> **关键约束**：这个 endpoint 是 Anthropic Code 私有协议（`oauth-2025-04-20` beta），token scope 必须是 `user:profile`（`claude login` 走完拿到的那种）；CLI 启动时塞的 setup-token (`CLAUDE_CODE_OAUTH_TOKEN` 环境变量) 只有 `user:inference` scope，**调不通**。

### 1.2 `ClaudeUsageProbe`（CLI 抓屏，fallback）

文件：`Sources/Infrastructure/Claude/ClaudeUsageProbe.swift`

- **命令**: `claude /usage --allowed-tools ""`
- **工作目录**: `~/Library/Application Support/ClaudeBar/Probe/`（提前写过 trust）
- **环境变量**: 显式 unset `CLAUDE_CODE_OAUTH_TOKEN`，逼 CLI 用 keychain 里 oauth-2025-04-20 scope 的 token 而不是 setup-token
- **执行**: 用 SwiftTerm 起伪终端，捕捉光标定位 / 屏幕重绘后的最终文本，正则抓 `Current session 3% used · Resets 4:59pm (America/New_York)` 这种行
- **API Usage Billing 账号**：`/usage` 报错 "subscription required"，自动降级到 `claude /cost`，得到 `Total cost: $0.55`

这条路本质就是 TUI scraping，又慢又脆 — Anthropic 改一次 CLI 输出就要重写正则。

---

## 2. 本机第三方缓存（最划算的路线）

CCometixLine（statusline 模板程序，本机 `ccline` 二进制）会主动 polling 上面那个 `/api/oauth/usage`，每 5 分钟（默认）写一份缓存到：

```
~/.claude/ccline/.api_usage_cache.json
```

实测内容：

```json
{
  "five_hour_utilization": 3.0,
  "seven_day_utilization": 0.0,
  "resets_at": "2026-05-29T07:00:00.465530+00:00",
  "cached_at": "2026-05-22T10:08:35.534667+00:00"
}
```

> ⚠️ `resets_at` 是 **seven_day** 的 reset 时间，不是 5h 的。如果 launcher 想显示 5h 倒计时，要么自己调 API 拿 `five_hour.resets_at`，要么按 `cached_at` floor-to-hour + 5h 估算。

源码：`CCometixLine/src/core/segments/usage.rs:67-75, 87-96`。schema 在 `ApiUsageCache` 结构体。

---

## 3. 推荐的三层 fallback（给 launcher）

按"成本从低到高 / 准确度从高到低"排：

### Tier 1 — 读 ccline 缓存文件（首选）
- 路径：`~/.claude/ccline/.api_usage_cache.json`
- 成本：0（一次 fs.readFile + JSON.parse）
- 鲜度：依赖 ccline 是否在跑；如果用户没装 ccline，这个文件不存在；如果 ccline 运行中，缓存最多 5min 旧
- **过期判定**：`Date.now() - Date.parse(cached_at) > 5 * 60 * 1000` 视为 stale
- 适用：作为 launcher 顶栏 5h 条的默认数据源

### Tier 2 — 直接调 `/api/oauth/usage`（缓存过期或缺失时）
- 从 `~/.claude/.credentials.json`（或 keychain）读 oauth `access_token`
- HTTP GET 上面那个 endpoint，带 `anthropic-beta` header
- 成本：一次 HTTPS 请求 + 续签 token 的可能（401 时用 `refresh_token` 走 `https://console.anthropic.com/v1/oauth/token`）
- **不要直接 spawn `claude /usage`**：那是 ClaudeBar 的退路，对 launcher 来说 spawn 整个 CLI 太重 (启动 1–2 秒、要 PTY、要写 trust)
- 拿到响应后**顺便把 `~/.claude/ccline/.api_usage_cache.json` 写一份**（若文件不存在），帮其它工具复用

### Tier 3 — `ccusage blocks --json --active`（推算）
- 适用场景：API 调用失败、用户没登录、只想本地推算
- ccusage 算法：扫 `~/.claude/projects/*/*.jsonl` 所有 `assistant` 类消息，按时间排序，5h 滑窗（首条 entry floor 到整点起算），匹配 `pricing.json` 算 cost
- 命令：`npx ccusage@latest blocks --active --json` 或装好的 `ccusage blocks --active --json`
- 输出（节选）：
  ```json
  {
    "blocks": [{
      "id": "2026-05-22T10:00:00.000Z",
      "startTime": "2026-05-22T10:00:00.000Z",
      "endTime":   "2026-05-22T15:00:00.000Z",
      "actualEndTime": "2026-05-22T12:34:56.789Z",
      "isActive": true,
      "tokenCounts": {"inputTokens":..., "outputTokens":..., "cacheCreationTokens":..., "cacheReadTokens":...},
      "costUSD": 1.234,
      "models": ["claude-sonnet-4-7"]
    }]
  }
  ```
- ⚠️ 这只能给出 cost 和 token 总量，**给不出真实 utilization 百分比**（你不知道用户的 plan tier 和 quota 上限）。launcher 只能展示成 "本窗口已花 $X" 而不是 "5h 已用 27%"
- 成本：scan 几百个 jsonl 文件，一般 < 500ms；可以加 `--offline` 跳过 LiteLLM 拉新 pricing

### Tier 4 — 占位"数据暂不可用"
- 上面三层都失败时，UI 显示灰色横条 + 文案 `5h 配额：登录 Claude 账号后可见`，附带 "运行 ccline 安装" 链接
- 不要 fallback 到 ccusage cost-only 表，避免误把 cost 当成 quota%

---

## 4. 给 T5（H3 backend）的接线建议

```
GET /api/launcher/usage/5h
  → 优先 fs.readFile(~/.claude/ccline/.api_usage_cache.json)
  → cached_at 过期 / 文件缺失 → 自己调 /api/oauth/usage（带 token refresh 兜底）
  → 还失败 → 跑 ccusage blocks --active --json，回 { mode: "cost_only", cost_usd, token_count }
  → 都失败 → 回 { mode: "unavailable" }
```

返回统一 envelope（让前端不用关心来源）：

```ts
type FiveHourUsage =
  | { mode: "utilization"; percent: number; resets_at: string; cached_at: string; source: "ccline_cache" | "oauth_api" }
  | { mode: "cost_only";   cost_usd: number; tokens: number; window_start: string; window_end: string; source: "ccusage" }
  | { mode: "unavailable"; reason: string };
```

**别忘了的细节：**
- token refresh：access_token 大概 8 小时过期，401 时要用 refresh_token 续；ClaudeBar 在 `ClaudeAPIUsageProbe.swift:139-149` 有现成的实现可以照抄（POST `https://console.anthropic.com/v1/oauth/token`）。
- 速率：`/api/oauth/usage` 历史上有过返回奇怪 throttle 时长的情况，ClaudeBar 注释里提到"曾观察到 1 小时 throttle"，所以失败时要 fallback，不要无限重试。
- 时区：`resets_at` 是 UTC，UI 转用户本地。ccline 缓存的 `resets_at` 字段实际是 7-day reset，要么 ignore、要么自己再调 API 拿 5h reset。

---

## 5. 参考链接

- ClaudeBar `ClaudeAPIUsageProbe.swift`: <https://github.com/tddworks/ClaudeBar/blob/main/Sources/Infrastructure/Claude/ClaudeAPIUsageProbe.swift>
- ClaudeBar `ClaudeUsageProbe.swift` (CLI 抓屏): <https://github.com/tddworks/ClaudeBar/blob/main/Sources/Infrastructure/Claude/ClaudeUsageProbe.swift>
- CCometixLine `usage.rs`: <https://github.com/Haleclipse/CCometixLine/blob/main/src/core/segments/usage.rs>
- ccusage `blocks.rs`: <https://github.com/ryoppippi/ccusage/blob/main/rust/crates/ccusage/src/blocks.rs>
- ccusage pricing fallback: <https://github.com/ryoppippi/ccusage/blob/main/rust/crates/ccusage/src/litellm-pricing-fallback.json>
