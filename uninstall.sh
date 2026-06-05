#!/usr/bin/env bash
# ccv-launcher uninstall — remove launchd agent + plugin symlinks
# 不动 NPM / DNS / htpasswd（那些是基础设施，自己手动清）

set -euo pipefail

CCV_PLUGIN_DIR="$HOME/.claude/cc-viewer/plugins"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_NAME="com.user.ccv-hub.plist"
target="$LAUNCH_AGENT_DIR/$PLIST_NAME"

echo "[1/2] uninstall launchd agent"
if [[ -f "$target" ]]; then
  launchctl unload "$target" 2>/dev/null || true
  rm -f "$target"
  echo "    ✓ removed $target"
else
  echo "    - $target not present"
fi

echo "[2/2] remove plugin symlinks"
for f in public-url.mjs runtime-broadcast.mjs launcher.mjs; do
  dst="$CCV_PLUGIN_DIR/$f"
  if [[ -L "$dst" ]]; then
    rm "$dst"
    echo "    ✓ removed symlink $dst"
  elif [[ -f "$dst" ]]; then
    echo "    ⚠ $dst is a regular file (not symlink)，跳过保护"
  fi
done

# 清理 runtime/ 目录里 hub 残留（子实例的不动）
runtime_dir="$HOME/.claude/cc-viewer/runtime"
if [[ -d "$runtime_dir" ]]; then
  for f in "$runtime_dir"/*.json; do
    [[ -f "$f" ]] || continue
    if grep -q '"isHub":\s*true' "$f" 2>/dev/null; then
      rm "$f"
      echo "    ✓ cleaned hub runtime $(basename $f)"
    fi
  done
fi

echo "完成。NPM/DNS/htpasswd 等基础设施需要自己手动撤。"
