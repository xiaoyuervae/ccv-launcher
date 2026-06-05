# ccv-launcher

把 [cc-viewer](https://github.com/weiesky/cc-viewer) 变成多实例控制台 + 公网可访问 launcher，零 ccv 源码改动。

- 一个固定子域 `ccv.<your-domain>:9990` 列出所有运行中 ccv 实例
- 卡片显示公网 URL + 二维码 + Open / Stop / Copy 操作
- 「Launch new」按钮选目录起新实例
- 子实例 URL 自带 token，手机扫码或浏览器收藏一次访问无需密码
- launchd 守护 hub 进程，崩溃自动重启

## 架构

```
浏览器 / 手机
  │
  │ https://ccv.<your-domain>:9990 (固定子域, 收藏即用)
  ▼
NPM (Basic Auth — 唯一入口防线)
  │
  ▼
<host>:7100 (hub: ccv 进程 + launcher.mjs 插件)
  │
  ├─ fs.watch ~/.claude/cc-viewer/runtime/<pid>.json
  ├─ POST /api/launcher/spawn → fork 新 ccv 子进程
  ├─ POST /api/launcher/kill  → SIGTERM 子进程
  └─ runtime-broadcast.mjs 在每个 ccv 进程写 runtime/<pid>.json
  
子实例 ccv-7008..7099.<your-domain>:9990 (无 NPM auth, 仅 ccv ?token=)
```

## 实现策略

**全插件方案，不 fork ccv** —— 利用 ccv 自带的 `serverStarted` / `localUrl` hook 注入：

| 插件 | 行数 | 作用 |
|---|---|---|
| `plugins/public-url.mjs` | ~50 | `localUrl` waterfall hook 把内网 URL 翻译成公网 URL |
| `plugins/runtime-broadcast.mjs` | ~115 | 每个 ccv 进程在 `serverStarted` 写 `runtime/<pid>.json`, exit 时删 |
| `plugins/launcher.mjs` | ~610 | env `CCV_HUB=1` 时激活, 挂 `/launcher` 和 `/api/launcher/*` 路由, fs.watch runtime 同步实例表 |

**hub 路由免 ccv token**：插件用 `httpServer.on('request', ...)` 拦截 launcher 路径，绕过 ccv token 校验，仅靠 NPM Basic Auth 防护（避免 token 旋转后 bookmark 失效）。

**子实例去 NPM Basic Auth**：浏览器跨子域不共享 Basic Auth 凭据，每切实例都要重输密码 → 子实例只走 ccv token，URL 自带 token 一步直进，UX 顺滑。

## 文件结构

```
ccv-launcher/
├── plugins/                       # 插件源码 (symlink 到 ~/.claude/cc-viewer/plugins/)
│   ├── public-url.mjs
│   ├── runtime-broadcast.mjs
│   └── launcher.mjs
├── deploy/
│   ├── com.user.ccv-hub.plist    # launchd agent 模板
│   └── npm-http.conf              # NPM 反代两个 server 块
├── install.sh                     # macOS 一键安装 (plugins symlink + launchd)
├── uninstall.sh                   # 撤回 launchd + symlink
└── README.md
```

## 前置条件

- macOS (launchd)
- ccv 全局安装 `npm install -g cc-viewer`
- 一个公网可达域名 + 通配符证书 (本项目用 Let's Encrypt 通配符)
- nginx-proxy-manager (jlesage 镜像) 或等价 nginx，支持 custom http.conf 注入
- DDNS (本项目用 ddns-go + DNSPod)
- 主路由能 NAT 转发外部端口到 NPM 4443

## 安装

```bash
git clone <this-repo> ~/Projects/ccv-launcher
cd ~/Projects/ccv-launcher
./install.sh
```

`install.sh` 自动：
1. symlink `plugins/*.mjs` 到 `~/.claude/cc-viewer/plugins/`
2. 安装并启动 launchd agent
3. 验证 hub 在 7100 listening

剩下的需要手动（一次性配置，跟环境强相关）：

1. **NPM** — 把 `deploy/npm-http.conf` 中的两个 server 块同步到你的 NPM custom 目录，nginx -t + reload
2. **DNS** — 通配符 CNAME `*.<your-domain>` → DDNS 维护的 A 记录主机名
3. **主路由** — 外部 9990 端口 NAT 到 NPM 监听端口 (本项目是 NAS:4443)
4. **htpasswd** — 在 NPM custom 目录生成 `ccv.htpasswd` 给 hub 子域 Basic Auth
5. **改 plist 适配你的环境** — `deploy/com.user.ccv-hub.plist` 里 `CCV_PUBLIC_URL_TEMPLATE`、`HOME`、日志路径、ccv 二进制路径

## 配置

主要环境变量（在 `deploy/com.user.ccv-hub.plist` 里）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `CCV_HUB` | `1` | 启用 launcher 模式 (其它 ccv 进程留空) |
| `CCV_START_PORT` / `CCV_MAX_PORT` | `7100` / `7100` | hub 锁死在 7100 |
| `CCV_PUBLIC_URL_TEMPLATE` | `https://ccv-{port}.<your-domain>:9990/?token={token}` | 子实例公网 URL 模板, `{port}/{token}/{host}` 占位符 |
| `CCV_CHILD_PORT_FLOOR` / `CCV_CHILD_PORT_CEIL` | `7008` / `7099` | spawn 子实例的端口范围 |

改完 `kickstart` 一次让 launchd 重载：

```bash
launchctl kickstart -k gui/$(id -u)/com.user.ccv-hub
```

## 修改流程

`~/.claude/cc-viewer/plugins/*.mjs` 是 symlink，编辑 `~/Projects/ccv-launcher/plugins/*.mjs` 即生效，但需重启 hub 让 ccv 重新 import：

```bash
launchctl kickstart -k gui/$(id -u)/com.user.ccv-hub
```

或粗暴 `kill <hub-pid>`，KeepAlive 自动拉起。子实例继续 detached 跑不受影响。

## 安全模型

- **Hub 子域** (`ccv.<your-domain>:9990`) — NPM Basic Auth 是唯一防线。密码够强即可（`openssl rand -base64 18` 起步）
- **子实例子域** (`ccv-<port>.<your-domain>:9990`) — 仅 ccv 自带 32 位 hex token (URL `?token=`) 鉴权
  - 子实例 token 公网传输走 HTTPS 加密
  - 风险面：知道具体端口子域 + 暴力破解 32 位 token (实际不可行)
- **Hub 重启子实例 token 不变** — 用户已开的浏览器 tab 不受影响
- **已知缺陷**：ccv 自身 `/ws/terminal` WebSocket 不验 token (W2)。LAN 内或公网（Basic Auth 失守时）可直接拿 macOS 终端。短期靠 NPM 单防线接受这个风险，长期可写 ws-auth plugin 补丁

## 调试

```bash
# hub 状态
launchctl list | grep ccv-hub
lsof -nP -iTCP:7100 -sTCP:LISTEN

# hub 日志
tail -f ~/Library/Logs/ccv-hub/{stdout,stderr}.log

# 实例注册表
ls ~/.claude/cc-viewer/runtime/
cat ~/.claude/cc-viewer/runtime/*.json | jq .

# 直接调 launcher API
curl http://127.0.0.1:7100/api/launcher/list | jq .
curl -X POST http://127.0.0.1:7100/api/launcher/spawn -d '{"cwd":"/tmp"}' -H 'Content-Type: application/json'

# 公网调试 (内网 hairpin NAT 不通时)
curl -sk -u <user>:<password> --resolve ccv.<your-domain>:4443:<NAS-IP> https://ccv.<your-domain>:4443/launcher
```

## 卸载

```bash
./uninstall.sh
```

撤回 launchd agent + plugin symlinks。NPM / DNS / htpasswd / 主路由 NAT 不动，自己手清。

## 致谢

- [cc-viewer](https://github.com/weiesky/cc-viewer) 提供完整的插件 hook 机制 (`localUrl` / `serverStarted` / `beforeRequest`) + 跨进程 `workspace-registry`，让"零源码改动"实现成为可能
- 设计灵感：JupyterHub launcher / Gitpod workspaces / PM2 web monitor / Pinggy QR

## License

MIT (跟随 ccv 上游)
