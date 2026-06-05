# iPhone 验收测试清单（QA2 + 移动加载优化）

> 切到 fork hub 后，验证 iOS Safari/Chrome 后台→前台的连接恢复 + Claude Code 状态保留 + 移动端首屏加载优化。
>
> **更新（2026-04-26 M1+M2）**：补了 SSE `Last-Event-ID` 重放 + 移动端首屏限制 50 条。原 1.A/1.B/1.C 用例**应该再也不丢消息**了；6 节加了移动加载验证。

---

## 0. 前置 / 一次性

- 电脑 Mac 上确认 hub 运行的是 fork：
  ```sh
  ps aux | grep "cli.js" | grep -v grep
  # 应该看到: /opt/homebrew/bin/node /path/to/cc-viewer/cli.js --d --no-open
  ```
- 验证 PA1 PID 锁文件：
  ```sh
  cat ~/.claude/cc-viewer/runtime/hub.pid     # 应该等于上面 ps 看到的 PID
  ```
- 实时监控 hub 健康度（另起一个终端窗口，整个测试期间挂着）：
  ```sh
  while true; do clear; date; curl -s http://127.0.0.1:7100/healthz | python3 -m json.tool; sleep 2; done
  ```
- iPhone Safari 和 iPhone Chrome 各打开一遍：`https://ccv.<your-domain>:9990/launcher`
- 应该自动登录（pairing session 已持久化），如需重新配对走一次 6 位码流程
- 想看详细前端日志：在 iPhone Chrome DevTools（或电脑 Safari 远程调试）console 里：
  ```js
  window.__CCV_TRANSPORT_DEBUG__ = true
  ```
  之后会看到 `[resilient]` 前缀的 SSE/WS 重连诊断

---

## 1. 后台 30s 恢复（核心场景）

**目的**：验证 iOS 后台杀连接 → 前台触发自动重连，不丢 Claude Code 状态。

### 1.A — 在 iPhone Safari 测 cc-viewer Console

| 步骤 | 期望 |
|---|---|
| 在 launcher 主页点 Console（绿/蓝色之一）打开某个 ccv 实例 | 进入 cc-viewer 主界面，能看到当前 Claude Code 会话 |
| 切到桌面/锁屏，等 ~60 秒 | iOS 在后台 ~30s 内会切断 SSE/WS（NSURLSession 行为） |
| 切回 Safari，看 cc-viewer 标签页 | 1-2 秒内自动恢复，能看到聊天/终端最新输出（PB1 + PB2 的 ring buffer 回放） |
| Console 里发一句新输入（如 `echo POST_RESUME`）| Claude 端能正常收到，输出实时回流 |
| 桌面 Mac 那边看 `/healthz` | `wsCount` 短暂减为 0 → 恢复为 ≥1；`orphanCount` 短暂出现非零数 → 恢复为 0 |

### 1.B — 在 iPhone Chrome 测同上

复测 1.A 全流程。Chrome 在 iOS 也走 WKWebView，行为应一致。

### 1.C — 测 launcher /ws/shell（绿色 Shell 按钮）

| 步骤 | 期望 |
|---|---|
| launcher 主页点 Shell 按钮，开一个 zsh | 看到 prompt，可以输入 |
| 输入 `echo PB3_BEFORE_BG && pwd` 看到回显 | OK |
| 切桌面 ~60s | — |
| 回到 Safari/Chrome | 终端浮层顶栏可能闪一下「reconnected」；但屏幕**已存在的输出保留**（不像之前是空白） |
| 输入 `echo PB3_AFTER_BG` | 看到 _AFTER_BG，且 prompt 仍然在原 cwd（PB3 PtySessionManager 'owned' 模式 reattach 成功） |
| 看 `/healthz` | `ptyCount` 不减、`wsCount` 短暂减为 0→恢复（说明 PTY 没死，只是 WS 重连） |

---

## 2. 长时间后台 + 5min 边界

**目的**：确认 5min PTY orphan TTL 边界行为。

### 2.A — 后台 4min（应 reattach 成功）

| 步骤 | 期望 |
|---|---|
| 起一个 Shell，`cd /tmp && echo INSIDE_TMP > /tmp/pb3_marker` | OK |
| 锁屏 4 分钟（一定要锁屏不止切桌面，触发更激进的 NSURLSession 终止）| — |
| 回到 Safari | reconnect，`pwd` 还在 `/tmp`，`ls /tmp/pb3_marker` 存在 |

### 2.B — 后台 6min（应 fresh shell + 提示）

| 步骤 | 期望 |
|---|---|
| 同样起 Shell `cd /tmp` | — |
| 锁屏 ≥6 分钟 | hub 端 5min orphan TTL 触发 → SIGTERM→SIGKILL → PTY 真死 |
| 回到 Safari | 拿一个**全新**的 zsh，`pwd` 是 home（cwd 默认），看不到刚刚的 marker |
| 客户端 banner 应明确告知是新 shell（如果有），或至少 prompt 立刻可见 | — |
| `/healthz` | `orphanCount` 在 5min 后归 0 |

---

## 3. 多 client 共享（验证 cc-viewer 共享 PTY 模型未坏）

**目的**：iPhone + 电脑同时打开同一个 ccv 实例，看共享是否仍然工作。

| 步骤 | 期望 |
|---|---|
| 电脑浏览器和 iPhone Safari 都打开同一个 ccv 实例（同一个 cwd）| 两边都能看 Claude Code 当前 session |
| 在电脑端发一句 prompt | iPhone 端实时看到（SSE 推送） |
| 在 iPhone 后台 60s 后回前台 | iPhone 自动重连，看到电脑端期间发的所有内容（PB2 ring buffer 回放） |
| 电脑端连接全程不断 | 电脑端 readyState 始终 OPEN，无任何异常 |

---

## 4. 轮询节流（PA4）

**目的**：验证后台时不发轮询请求，省电省流量。

桌面端测（手机不容易看 DevTools）：
| 步骤 | 期望 |
|---|---|
| 打开 `https://ccv.<your-domain>:9990/launcher` | — |
| Chrome DevTools → Network → 勾上 Preserve log | — |
| 观察 30 秒，看到周期性的 `/api/launcher/list`（30s）和 `/api/launcher/pair-list`（5s）| OK |
| Chrome DevTools → 三点 → More tools → Application → Background services → freeze 这个 tab | — |
| 观察 30s | 0 个 fetch（因为页面被 freeze） |
| Unfreeze | 立即 fire 一次 list + pair-list（page-visibility resume hook） |

---

## 5. 多次反复后台 → 前台（无累积内存/listener 泄漏）

**目的**：5+ 次循环不会越用越卡。

| 步骤 | 期望 |
|---|---|
| 起 Console + Shell，分别在两个 tab | — |
| 后台 30s → 前台，重复 5 次以上 | 每次 reconnect 应该都 1-2s 完成；不应越来越慢 |
| 5 次后看 `/healthz` | `wsCount` 等于当前 active client 数（应该是 2），`orphanCount` 0 |
| Chrome DevTools → Performance Monitor | JS Heap 不应持续增长（PB3 已验证 5-cycle 无 listener 泄漏，桌面端类比应一致） |

---

## 6. xterm 移动端配置（视觉感受）

**目的**：移动端 scrollback 减小、字体改系统 mono，是否生效 + 体验改善。

| 检查 | 期望 |
|---|---|
| iPhone 上看 Console 字体 | 应该是 `ui-monospace`（系统 mono），不是 NerdFont 风格 |
| 长时间用，往上滚 | 滚到 ~500 行就到顶（之前 1000 行）；iPad 仍 3000；iOS 仅 200 |
| 内存压力 | iPhone safari 后台被踢回的概率应明显降低 |

---

## 6.5 移动端首屏加载 + Last-Event-ID 重连（M1+M2）

**目的**：验证 iPhone 首屏只拉 50 条历史（不是 200）+ 后台→前台不重发整段历史。

| 步骤 | 期望 |
|---|---|
| 在 iPhone Safari 打开某个 ccv 实例（**清掉 cache/localStorage 后**冷启动）| 进入聊天界面 |
| Mac 上 Charles / Wireshark / 本机 `tail -f stdout.log` 看请求；或者 chrome 远程调试 iPhone | 应该看到 `GET /events?limit=50&...`（不是 200） |
| 顶部出现「加载更多历史」按钮（`hasMoreHistory: true`）| 点一下，往前补 100 条 |
| 切桌面 60s，回前台 | 浏览器自动重连 SSE 时**应携带 `Last-Event-ID: <数字>` request header**（chrome devtools 远程调试可见） |
| 服务端响应**不应**以 `event: load_start` 开头 | 应该直接是 `id: <更大的 seq>` 数据帧（仅回放间隔期间的事件） |
| 极端情况：后台 30+ 分钟，事件量 >500 | 服务端发 `event: state_lost` → 前端做完整 reload（这是预期降级）|

**桌面端验证（更直观）**：
1. Chrome DevTools → Network → 筛选 `events` → 看 URL：iPhone UA 应该是 `?limit=50`，桌面 UA 是 `?limit=200`（保持原样）
2. 主动断 SSE：在 Network 列里右键那条 events 流 → Block request URL → Unblock → 重连
3. 看新连接的 Request Headers：应有 `Last-Event-ID: <num>`
4. 看 Response 流：第一个 chunk 应是 `id: <num+1>` 而不是 `event: load_start`

> 如果你在 iPhone 上的 console 开了 `__CCV_TRANSPORT_DEBUG__ = true`，会看到 `[resilient] resume after Xms hidden, reconnecting N instances` 日志，那就是 PB1 触发了 close+redial，紧接着的 SSE 重连会自动带 Last-Event-ID。

---

## 6.6 刘海屏 / 安全区 / PWA standalone / CodeMirror 懒加载（P0+P1.7+P1.8）

**目的**：验证 viewport-fit=cover + env(safe-area-inset-*) + 100dvh 真的按预期工作；CodeMirror 懒加载不再首屏拖慢；iOS PWA standalone meta 生效。

| 步骤 | 期望 |
|---|---|
| iPhone Safari 横屏打开 launcher 主页 | 顶部 / 底部内容都贴着安全区，**不被 Dynamic Island 或 home indicator 遮住** |
| 同上但竖屏滚动一下，让 Safari URL 栏收起 | 整页**不跳**；底部按钮一直可点（之前 100vh 会闪一下/被压住一截）|
| 进入某个 ccv 实例的 cc-viewer 主界面，调出键盘输入消息 | 输入栏紧贴键盘上方，发送按钮不被键盘吃掉，键盘收起后回原位无错位 |
| Safari 分享 → 「添加到主屏幕」→ 输入名 ccv → 添加 | 主屏图标位置出现 `ccv` 入口（图标暂时是 favicon fallback，180×180 待补） |
| 从主屏图标启动 | **没有 Safari 地址栏**（standalone 模式），状态栏是半透明黑 |
| Chrome DevTools 远程调试 iPhone Safari，进 cc-viewer 但**只看 chat 不点文件** | Network 中**没有** `vendor-codemirror-*.js` 请求；首屏 JS 总下载量较以前少 ~395KB gzip |
| 在 cc-viewer 里点开一个文件（触发 FileContentView） | 此时才看到 `vendor-codemirror-*.js` 加载，编辑器正常显示 + 高亮 + 滚动 |
| 启用 iOS 设置 → 辅助功能 → 动态效果 → 减弱动态效果 | "加载更多历史" 按钮的转圈不再转（仅显示静态边框）；流式发送 spinner 也不转（PB1+本次） |

**桌面验证 fallback**：
1. Chrome DevTools → Network → 进首页：确认 `dist/index.html` 中 `<link rel="modulepreload">` **不含** `vendor-codemirror-*.js`
2. `curl -s https://ccv.<your-domain>:9990/ | grep -c "vendor-codemirror"` → 应为 0
3. 进入 chat → grep network 没有 vendor-codemirror；点开文件 → grep network 出现 vendor-codemirror 一次

> 已知 TODO：图标资产（`apple-touch-icon.png` 180×180 + `manifest.webmanifest` + icon-192/-512）尚未生成。本机没装 imagemagick 也没有 SVG 源图，留给后续补；当前 PWA 只是 standalone + status-bar 配色生效，主屏图标走 favicon fallback。

---

## 7. 验收门槛

**全部通过即合格**：

- [ ] 1.A / 1.B / 1.C 三个 60s 后台→前台测试，三处都自动恢复且无数据丢失
- [ ] 2.A 4min 后台 reattach 成功，2.B 6min 后台 fresh shell 符合预期
- [ ] 3 多 client 共享不坏（cc-viewer 共享 PTY 模型保留）
- [ ] 4 轮询在隐藏时为 0 请求，可见时立即恢复
- [ ] 5 多轮循环不累积内存/连接
- [ ] 6 移动端字体/scrollback 生效
- [ ] 6.5 iPhone 首屏 SSE URL 带 `?limit=50`，重连带 `Last-Event-ID`，无 `load_start` 重发
- [ ] 6.6 安全区不被 home indicator 遮、URL 栏收起不跳、standalone 启动无地址栏；cc-viewer 首屏 Network 无 `vendor-codemirror-*.js`，开文件后才加载

**任一不过 → DM team-lead，注明：iPhone 型号、iOS 版本、Safari/Chrome 版本、`/healthz` 输出、DevTools console 中所有 `[resilient]` 行**。

---

## 8. 回滚

如果发现严重问题，回滚到 npm 版 cc-viewer：

```sh
launchctl bootout gui/$(id -u)/com.user.ccv-hub
# 改回 plist：
#   ProgramArguments[1]: /path/to/cc-viewer/cli.js → /opt/homebrew/bin/ccv
#   WorkingDirectory:    /path/to/cc-viewer       → /Users/<youruser>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.ccv-hub.plist
```

注意：fork 的 launcher plugin 修改是 symlink，不会随 hub 回滚自动失效；如果想完全回到 PA-PB-PC 之前的状态，需要 `git checkout` 到 ccv-launcher repo 的旧 commit。完整回滚到本次工作之前：

```sh
cd ~/Projects/ccv-launcher
git checkout 2b7919c  # PA3 之前的最后一个 commit
launchctl kickstart -k gui/$(id -u)/com.user.ccv-hub
```

> 不建议这么做 —— 这会丢掉 pairing auth 持久化、xterm 移动端配置、健康端点等等。先从子集回滚（比如只回滚 PB3）再说。
