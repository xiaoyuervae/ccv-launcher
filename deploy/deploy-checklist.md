# NPM Custom http.conf 部署清单

> 本文档由 `qa-ops` 维护。每次修改 `deploy/npm-http.conf` 后，按此清单同步到 NAS。
> 不要直接在 NAS 上改文件；以仓库副本为准。

## 1. 文件落点

| 来源（仓库） | 目标（NAS） |
|---|---|
| `~/Projects/ccv-launcher/deploy/npm-http.conf` | `/vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/http.conf` |

容器内挂载路径通常为 `/data/nginx/custom/http.conf`（NPM 默认 include 该路径下所有 `*.conf`）。

## 2. 同步步骤

```bash
# 在 NAS 上执行（ssh nas）
NPM_HTTP_CONF=/vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/http.conf

# 1. 备份当前版本
cp -p "$NPM_HTTP_CONF" "$NPM_HTTP_CONF.bak.$(date +%Y%m%d-%H%M%S)"

# 2. 用仓库新版覆盖（scp 或本地 cp，按场景选一）
#    从 macAir 推送：
#    scp ~/Projects/ccv-launcher/deploy/npm-http.conf nas:$NPM_HTTP_CONF

# 3. 容器内 nginx 语法校验 + reload（不重启容器）
docker exec nginx-proxy-manager nginx -t \
  && docker exec nginx-proxy-manager nginx -s reload
```

`nginx -t` 报错则不要 reload，先恢复 `.bak`。

## 3. 验证

从外网（不在家庭 LAN）执行：

```bash
# (a) 协议版本：应返回 HTTP/2
curl -sI --http2 https://ccv.<your-domain>:9990/ | head -1

# (b) SSE/WS 关键响应头：应不包含 Content-Encoding: gzip
curl -sI https://ccv.<your-domain>:9990/ | grep -iE 'content-encoding|x-accel-buffering|transfer-encoding'

# (c) 子域名通配：替换 7XXX 为某个活跃 launcher 子端口
curl -sI --http2 https://ccv-7100.<your-domain>:9990/ | head -1
```

期望：
- (a) `HTTP/2 200` 或 `HTTP/2 4xx`（路径不存在也行，关键看协议版本是 HTTP/2）
- (b) 无 `content-encoding: gzip`；有 `transfer-encoding: chunked` 时表示流式 OK

## 4. HTTP/2 状态

当前 `listen 4443 ssl http2;` 已显式启用 HTTP/2，无需改动。
NPM UI 中对应的 Proxy Host 默认会通过 `listen 443 ssl http2;` 监听公网端口；DDNS 把外部 9990 映射到 NAS 4443，链路全程 HTTP/2。

如需在 NPM UI 侧确认（罕见场景，仅当上面 (a) 返回 HTTP/1.1 时才需要）：
1. NPM UI → Proxy Hosts → 找到 `ccv.<your-domain>` 主机
2. 编辑 → SSL tab → 确认 "HTTP/2 Support" 勾选
3. Save
4. 重跑验证步骤 (a)

## 5. 回滚

```bash
# 找到最近的 .bak
ls -lt /vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/http.conf.bak.* | head -1

# 覆盖回去
cp -p <bak-file> /vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/http.conf

# reload
docker exec nginx-proxy-manager nginx -t \
  && docker exec nginx-proxy-manager nginx -s reload
```

## 6. 本次变更要点（2026-04-25）

`npm-http.conf` 两个 server 块同步增加：

| 指令 | 作用 |
|---|---|
| `proxy_request_buffering off` | 上行也禁用缓冲，避免 WS 升级握手卡顿 |
| `gzip off` | 禁止 nginx 对 SSE 流压缩（压缩会缓存导致事件不及时） |
| `chunked_transfer_encoding on` | 显式启用分块传输，长连接流式输出兼容性更好 |
| `proxy_set_header X-Accel-Buffering no` | 防御式：上游也能据此识别为流式响应（即便服务端忘记设置） |

`proxy_buffering off` / `proxy_http_version 1.1` / `Upgrade` / `Connection` 此前已就位，未改。

## 7. 已验证（2026-04-25 16:05 UTC）

```
$ curl -sI --http2 https://ccv.<your-domain>:9990/launcher | head -1
HTTP/2 502
$ curl -sI --http2 https://ccv.<your-domain>:9990/        | head -1
HTTP/2 403
```

协议版本 = HTTP/2 ✓（无需 NPM UI 切换）。状态码与本次任务无关（路径/鉴权问题）。
