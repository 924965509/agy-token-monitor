#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/.gemini/config/plugins/agy-token-monitor"
REPO_URL="https://github.com/924965509/agy-token-monitor.git"

echo "🚀 正在安装 Antigravity Token 速度与额度监控插件 (agy-token-monitor)..."
mkdir -p "$HOME/.gemini/config/plugins"

if [ -d "$TARGET_DIR/.git" ]; then
  echo "🔄 检测到已安装，正在拉取最新更新..."
  git -C "$TARGET_DIR" pull --ff-only
elif [ -d "$TARGET_DIR" ]; then
  echo "⚠️ 目录 $TARGET_DIR 已存在，正在备份并重新克隆..."
  mv "$TARGET_DIR" "${TARGET_DIR}.bak.$(date +%s)"
  git clone "$REPO_URL" "$TARGET_DIR"
else
  git clone "$REPO_URL" "$TARGET_DIR"
fi

chmod +x "$TARGET_DIR/sidecars/monitor/main.mjs"

echo ""
echo "✅ 安装完成！路径：$TARGET_DIR"
echo "👉 下一步："
echo "   1. 打开 Antigravity IDE"
echo "   2. 在插件 / Sidecar 管理中启用「Token 速度监控 (agy-token-monitor)」"
echo "   3. 在对话中对 AI 说：「打开 Token 速度监控」，或点击右侧边栏图标即可实时查看！"
