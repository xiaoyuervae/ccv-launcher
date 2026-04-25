#!/usr/bin/env bash
# ccv-launcher install — symlink plugins to ccv config dir + install launchd agent
# 不会覆盖已有 plist 的现存配置；NPM 部分必须手动同步（见 README）。

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCV_PLUGIN_DIR="$HOME/.claude/cc-viewer/plugins"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_NAME="com.dayuer.ccv-hub.plist"

echo "[1/4] 检查依赖"
command -v ccv >/dev/null || { echo "ERROR: ccv 未安装。npm install -g cc-viewer 先"; exit 1; }
command -v launchctl >/dev/null || { echo "ERROR: launchctl 不可用（这脚本仅 macOS）"; exit 1; }

echo "[2/4] symlink plugins → $CCV_PLUGIN_DIR"
mkdir -p "$CCV_PLUGIN_DIR"
for f in public-url.mjs runtime-broadcast.mjs launcher.mjs; do
  src="$PROJECT_DIR/plugins/$f"
  dst="$CCV_PLUGIN_DIR/$f"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    echo "    ✓ $f (symlink already correct)"
    continue
  fi
  rm -f "$dst"
  ln -s "$src" "$dst"
  echo "    + $f -> $src"
done

echo "[3/4] install launchd agent"
mkdir -p "$LAUNCH_AGENT_DIR"
target="$LAUNCH_AGENT_DIR/$PLIST_NAME"
if [[ -L "$target" || -f "$target" ]]; then
  launchctl unload "$target" 2>/dev/null || true
  rm -f "$target"
fi
cp "$PROJECT_DIR/deploy/$PLIST_NAME" "$target"
launchctl load "$target"
sleep 2

if launchctl list | grep -q com.dayuer.ccv-hub; then
  echo "    ✓ launchd agent loaded"
else
  echo "    ✗ launchd 加载失败，看 ~/Library/Logs/ccv-hub/stderr.log"
  exit 1
fi

echo "[4/4] 验证 hub"
sleep 2
if curl -sf -m 3 -o /dev/null "http://127.0.0.1:7100/launcher"; then
  echo "    ✓ hub 在线: http://127.0.0.1:7100/launcher"
else
  echo "    ⚠ hub 暂未响应，检查 ~/Library/Logs/ccv-hub/stderr.log"
fi

cat <<EOF

完成。下一步（手动）：
  1. NPM 配置 — 把 deploy/npm-http.conf 中的两个 server 块同步到 NAS:
       /vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/http.conf
     然后: docker exec nginx-proxy-manager nginx -t && nginx -s reload
  2. htpasswd — 在 NAS 上生成 hub 子域的 Basic Auth:
       PASS=\$(openssl rand -base64 18 | tr -d '=+/' | cut -c1-20)
       HASH=\$(docker exec nginx-proxy-manager openssl passwd -apr1 "\$PASS")
       echo "dayuer:\$HASH" | sudo tee /vol1/1000/Docker/config/nginx-proxy-manager/nginx/custom/ccv.htpasswd
  3. DNS — DNSPod 加通配符 CNAME *.xiaoyuervae.cn → nginx.xiaoyuervae.cn (一次性配)
  4. 主路由 — TCP 9990 NAT → NAS:4443 (一次性配)

打开 https://ccv.xiaoyuervae.cn:9990/launcher 验证。
EOF
