# ccv-launcher Web 端优化方案

> 范围：仅桌面浏览器访问 launcher 时的可见能力。手机/PWA/Push 通知/移动端 xterm UX 不在本文档范围（另起 `optimization-mobile.md`）。
> 来源：调研 12 个 CC 生态 launcher（Codeman / opcode / claudecodeui / claude-squad / recon / agent-viewer / cmux 等）+ 12 个用量监控/session 浏览工具（ccusage / ccstatusline / CCometixLine / CCHV / sniffly / Maciek-monitor / ClaudeBar 等）后筛出的可借鉴点。

## 0. 现状基线（已实现，不在清单里）

```
spawn / kill / list ccv 子进程     pair 码 6 位鉴权        外部 ccv backfill (lsof)
per-cwd alias                      per-cwd ccuse profile   bare-claude takeover
jsonl 活动探针                     pendingAsks 卡片徽章    iframe 内嵌 ccv UI
launchd KeepAlive                  xterm.js + node-pty     wildcard 子域 + QR
runtime-broadcast 注册表
```

短板（Web 端）：
- 没有 token / cost / 上下文用量的可视化
- 没有跨实例的 session 搜索 / 历史浏览 / diff
- 没有 5h 窗口剩余配额
- 没有 tag / 跨实例导航（实例多了之后 dashboard 难用）
- 没有按错误聚类 / Recent Edits 维度看 session 在干什么
- 没有 PR 工作流（看完 diff 还得回终端 `gh pr create`）

---

## 1. 高 ROI（半天到一天，建议先做）

### H1. ccusage 集成 → 成本/token 用量可视化

**做什么**
- Dashboard 顶 bar 三个数：今日 / 本周 / 本月 cost (USD)，hover 看按 model breakdown
- 实例卡片左下角加 "session $X.XX" 小标
- 每张卡片折叠面板加 "今日 input / output / cache_create / cache_read" 四个数字

**数据来源**
- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`，每行 `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`
- pricing 来自 LiteLLM `model_prices.json`（Sonnet 4.5: cache_create 3.75/M, cache_read 0.30/M, input 3/M, output 15/M）
- dedup key: `(session_id, message_id, request_id)` —— resume 后会重复写入，必须 dedup

**实现路径（任选）**
1. shell out: `bunx ccusage@latest daily --json --offline`，按 `entry.project=cwd` 过滤聚合（最简单，零依赖）
2. vendor ccusage 核心解析逻辑（~150 行 Rust → 改写 mjs），跟 launcher 已有 jsonl watcher 共用
3. sidecar agentsview（Go + SQLite，docker 起一个），SQL 查跨 cwd 跨时间段

推荐路径 1 起步，后续如果延迟难受再升级到 2。

**接入点**：`plugins/launcher.mjs` 已有 `getInstanceActivity` 解析 jsonl tail，加一个 `usageReducer(entries)` 即可。

### H2. Context window % 进度条

**做什么**：每张卡片状态行下方加 `上下文 [████░░░░] 47% / 200k`，颜色阈值 60% 黄、80% 橙、95% 红。

**数据来源**
- 读最后一条 assistant message 的 `usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- 除以模型 context_limit（200k 默认；Sonnet 4.5 1M 模式要看 model 字段）
- 模型→limit 的映射表抄 CCometixLine 的 `models.toml`（开源 TOML，直接 vendor）

**为什么单列**：这跟"累计花了多少钱"是两件事——前者是"是不是该 /compact 了"的实时信号，比累计 cost 实用得多。

**实现路径**：launcher 已经在 jsonl watcher 里 tail，加 reducer 抽 last assistant.usage 即可。无新依赖。

### H3. 5h 滑动窗口剩余配额可视化

**做什么**：顶 bar 显示
```
5h: 56k / 88k tokens (Max5) · 还有 2h 11m · 按当前速率 1h 后到 80%
```

**数据来源优先级**
1. **优先调研 ClaudeBar 的 Swift 源码**（github.com/tddworks/ClaudeBar，`ClaudeBar/Services/`）—— 它读的是 `claude` CLI 自己维护的 quota 缓存文件，是 Anthropic 服务端真实数字，比 jsonl 推算准
2. 如果 ClaudeBar 走的是子命令调用，launcher 也调同样子命令
3. 退而求其次：移植 ccusage `blocks` 算法（按 timestamp 排序，gap > 5h 切块，每块 `is_active / burn_rate / projection`） + Maciek-roboblog Claude-Code-Usage-Monitor 的 P90 burn-rate 预测（Python TUI，~30 行核心可移植）

**Plan 阈值常量**（Maciek 已沉淀）：Pro 19k / Max5 88k / Max20 220k tokens per 5h 窗口。

**为什么必做**：5h 限额是日常被卡的真实痛点，比"今天花了多少钱"刚需太多。

### H4. 单字符状态图标 + dashboard 三列 Kanban

**做什么**
- 当前的 `🟢 idle 5m ago` / `🛠 Bash: ...` 文字 badge 改成单字符图标 + 短标签：
  ```
  ● working    ◐ waiting_ask    ○ idle    ⏳ thinking    ⚠ error
  ```
- Dashboard 主区从单列卡片网格改成三列 Kanban：
  ```
  [Working]              [Waiting]              [Idle]
  ●  card               ◐  card                ○  card
  ●  card                                       ○  card
  ```
  state 直接来自你已有的活动探针，状态变化就把卡片移列。

**为什么**：实例 5+ 之后单列网格找"哪个在等我"得扫一遍。Kanban 让"哪些 card 在 Waiting 列"一眼可见，配 H5 的 j/n 跳转就更快。

**借鉴自**：claude-tmux（图标）+ agent-viewer（Kanban 三列）。

### H5. Tagging + jump-to-waiting 快捷键

**做什么**
- 顶部加 tag 输入框 `tag:env:prod role:debug`，每实例可贴多个 tag
- tag 化筛卡片 / Kanban 列
- 全局快捷键：
  - `j` / `n` → 跳到下一个 `waiting_ask` 状态实例（卡片 scroll-into-view + flash highlight）
  - `g` → 跳到下一个 `tool_running` 时间过长（>10min）的卡片
  - `/` → 聚焦 tag 搜索框
  - `?` → 显示快捷键帮助

**数据存哪**：`~/.claude/cc-viewer/launcher-prefs.json` 已有 alias / ccuseProfile，加 `tags: { [cwd]: string[] }` 即可。

**借鉴自**：recon 的 tagging + waiting jump。

---

## 2. 中 ROI（1-3 天，看是否做"代理 PR 工作流"）

### M1. Token 阈值自动 /compact + Run Summary 时间线

**做什么**
- per-cwd 配置阈值：110k → 自动注入 `/compact`，140k → `/clear` + 重读 CLAUDE.md
- 实例卡片折叠面板加 "Run Summary" 时间线：把 jsonl 里的 auto-compact / idle↔working 切换 / tool_use_result 失败 / hook 触发标成时间线 dot，点 dot 跳到 jsonl 对应行（链接到 cc-viewer 内置的 session 页面）

**实现要点**
- 注入方式：通过 ccv 已有的 stdin 通道（如果有）或在 hub 进程做 webhook 触发 /api/launcher/inject-prompt
- 检测：launcher 已经在 watch jsonl，加 last-usage 阈值判断即可
- 时间线 UI：把现有 `recentEvents` 数组扩成时间线视图（recharts 或纯 SVG）

**借鉴自**：Codeman 的 token 阈值 auto /compact + Run Summary 时间线。

**风险**：自动 /compact 是侵入性操作，默认关闭，per-cwd 显式开启。要有 "上次自动 compact 在 X 分钟前" 提示，避免循环触发。

### M2. 每实例 worktree + 卡片 commit/push + Open PR

**做什么**
- spawn dialog 加 toggle "新建 git worktree"（默认开），分支名取 alias 或 `ccv/<short-cwd>-<port>`
- 实例卡片右侧抽屉显示 `git diff` 摘要（vs origin/HEAD），列改动文件 + LOC delta
- 卡片新增按钮 `Commit` / `Push` / `Open PR`：
  - `Commit` → 输入 message，调 git commit
  - `Push` → git push --set-upstream
  - `Open PR` → 调 `gh pr create`，title=alias，body 模板自动塞 first-user-prompt + last-assistant-summary

**为什么**：把 launcher 从"并发跑多个 ccv"升级成"并发产出多个 PR"。多个实例改同 cwd 的互踩问题也顺手解决。

**借鉴自**：claude-squad 的 git worktree 隔离 + cmux 的 worktree 工作流。

**风险**：worktree 增加心智负担——用户得理解每个实例在不同分支。要在 dashboard 顶部显示当前 worktree 总数 + 一键 cleanup 按钮。

### M3. Recent Edits + Errors 双 tab

**做什么**：实例卡片折叠面板加两个 tab：
- **Recent Edits**：抽 jsonl 里的 `tool_use:{Edit,Write,MultiEdit,Bash}`，按文件分组列 `path · 改动 N 次 · 最后 5min ago`，点击文件名打开 cc-viewer 的 session 页跳到对应 turn
- **Errors**：过滤 `tool_use_result.is_error: true`，按 tool name + 错误前 80 字符聚类（"Edit: file not found 23 次"），点击展开错误 message 列表

**为什么**：Recent Edits 让你不用打开 ccv UI 就知道"这个实例改了哪些文件"；Errors 是别的工具都没有的角度，能快速发现"这个 session 一直在 retry"的迹象。

**借鉴自**：CCHV (Recent Edits) + sniffly (Errors breakdown)。

**实现**：复用现有 jsonl tail，加两个 reducer。无新依赖。

### M4. CLAUDE.md scanner panel

**做什么**：dashboard 顶部加一个 "Memory" 抽屉，聚合显示所有 cwd 下的 CLAUDE.md（项目级 + 用户级 `~/.claude/CLAUDE.md` + 父目录 inherit），可在线编辑。

**为什么**：你 launcher 跨多个 cwd，编辑 CLAUDE.md 经常要切目录。集中视图能快速对比"哪些项目还没沉淀 CLAUDE.md"、"全局规则跟项目规则有没有冲突"。

**借鉴自**：opcode (winfunc/claudia 改名) 的 CLAUDE.md scanner。

**实现**：扫每个 instance.cwd 找 CLAUDE.md（含父目录链），返回 `{path, mtime, size, preview}`，编辑通过 launcher 已有的 `/api/launcher/browse-dir` 同源端点扩展 `/api/launcher/edit-file`（限制只能编辑 `.claude/**` 和 `CLAUDE.md` 路径）。

---

## 3. 低 ROI / 锦上添花

| # | 来源 | 做什么 | 触发场景 |
|---|---|---|---|
| L1 | claudecodeui | per-cwd cron scheduler（"每天 9 点跑 `/review`"） | 自动化定时任务 |
| L2 | claudecodeui | 实例卡折叠面板 per-instance Tools toggle，写 `.claude/settings.local.json` | 临时收紧权限 |
| L3 | multi-agent-shogun | Skill 候选 panel：jsonl 找重复 tool_use pattern → 提示沉淀成 `.claude/skills/<name>` | 配合 CLAUDE.md "流程自沉淀" 规则 |
| L4 | cmux | spawn 时跑 `.ccv-launcher/setup` hook（项目级 init 脚本） | 装依赖、复制 .env、起 dev server |
| L5 | claude-code-router | 场景路由（按 prompt 长度/关键词自动切 ccuse profile） | longContext 自动用 1M model |
| L6 | ccpeek | 解析 `~/.claude/{todos,plans,commands,memories}` 加面板 | 看 CC 在所有项目的 todo / plan |
| L7 | par_cc_usage | 5h 窗口 80% 时桌面通知（Web Notification API） | 配额预警 |

---

## 4. 不建议做的

| 不做 | 原因 |
|---|---|
| claude-code-otel 整套 OTel + Prometheus + Grafana | 基础设施太重，不值得；但 metric 列表（API request count by model、tool usage histogram）值得参考，将来 launcher 自己暴露 `/metrics` 时按这套来 |
| MCP Inspector 嵌入 | 它是 per-server 调试工具不是健康总览面板；要做 MCP 健康总览得自己实现 |
| claude-flow 的 plan 树编排 | 跟 ccv 定位重叠，且 ccv-launcher 不应越俎代庖去管"怎么 prompt"，只该管"怎么跑+怎么看" |
| agentsview 单 SQLite 后端替代 ccusage | 功能与 ccusage + CCHV 重叠，除非 ccusage shell-out 延迟难受再考虑 |

---

## 5. 推荐落地顺序

```
Phase 1 (1 周)  ──  H1 (ccusage 顶 bar)               [半天]
                    H2 (context % 进度条)             [半天]
                    H3 (5h 窗口) ★ 先调研 ClaudeBar    [1 天]
                    H4 (单字符图标 + 三列 Kanban)      [1 天]
                    H5 (tagging + j/n 跳转)           [1 天]

Phase 2 (1 周)  ──  M1 (token 阈值 + Run Summary 时间线)  [2 天]
                    M3 (Recent Edits + Errors tab)         [1 天]
                    M2 (worktree + commit/push + Open PR)  [3 天]

Phase 3 (按需) ──  M4, L 系列
```

**Phase 1 完成后能看到的状态变化**：

| 维度 | Before | After |
|---|---|---|
| 成本/用量 | 看不见，只能事后查 | 顶 bar 实时今日 cost + 5h 配额 + 每卡片 session 累计 |
| 上下文管理 | 不知道何时该 /compact | 卡片进度条颜色变红即提示 |
| 多实例导航 | 单列网格扫一遍找 waiting | 三列 Kanban + j/n 一键跳 |
| 找实例 | 只能看 cwd 路径 | tag 过滤 |

**Phase 2 完成后**：launcher 从"控制台"升级成"代理 PR 工作流"——每个实例从 spawn 到产出 PR 全程不开终端。

---

## 6. 关键风险与缓解

| 风险 | 缓解 |
|---|---|
| ccusage shell-out 延迟（首次下载、cold cache） | dashboard 加载用 stale-while-revalidate：先显示 launcher 自己缓存的上次值，后台 refresh |
| 5h 窗口数据来源不稳定（ClaudeBar 调研结果未知） | 三层 fallback：CLI quota cache → ccusage blocks → "数据暂不可用"占位符，永远不让顶 bar 空 |
| 自动 /compact 触发循环 | per-cwd opt-in + 冷却时间 5min + 卡片显示"上次自动 compact 在 X 分钟前" |
| worktree 心智负担（多分支） | dashboard 顶部显示总数 + 一键 cleanup；spawn dialog 默认开 toggle 但显眼标注"会创建新分支" |
| Kanban 列频繁跳动（状态切换抖动） | 状态切换加 500ms debounce，避免 idle↔thinking 来回闪 |
| Errors tab 把无关错误也聚类（如临时网络抖动） | 错误前 80 字符聚类太粗；先按 `tool_name + error.code` 分组，再按 message hash 聚类 |

---

## 7. 接入文件清单

落地时主要改动的文件（基于现有结构）：

| 文件 | 改动方向 |
|---|---|
| `plugins/launcher.mjs` | 加 H1/H2/H3 reducer、H4 状态图标映射、H5 tag prefs、M1 阈值监控、M2 git/gh 调用、M3 jsonl 抽取 reducer、M4 CLAUDE.md scanner |
| `plugins/launcher.mjs` HTML_PAGE | UI 改 Kanban 三列、加顶 bar 用量、卡片折叠面板加 tab |
| `plugins/runtime-broadcast.mjs` | 暴露 last assistant.usage 字段（H2 直接读取） |
| `~/.claude/cc-viewer/launcher-prefs.json` | schema 扩 `tags`, `compactThreshold`, `worktreeDefault` |
| `~/.claude/cc-viewer/launcher-cache.json`（新） | ccusage / 5h 窗口结果缓存（stale-while-revalidate） |

无需新增依赖（Phase 1 全部）；Phase 2 视情况加 `simple-git` 或直接 shell out `git`/`gh`。

---

## 8. 调研来源

| 类别 | 项目（GitHub） | 借鉴点 |
|---|---|---|
| Launcher 类 | Codeman, opcode, claudecodeui, claude-squad, recon, agent-viewer, claude-tmux, cmux | M1, M2, M4, H4, H5, L1, L2, L4 |
| 用量监控 | ccusage, ccstatusline, CCometixLine, Claude-Code-Usage-Monitor, ClaudeBar | H1, H2, H3 |
| Session 浏览 | claude-code-history-viewer, sniffly, ccpeek, par_cc_usage | M3, L6, L7 |

详细 12+12 项目对照矩阵见 `optimization-research-raw.md`（如果之后想保留原始调研笔记，可单独导出）。
