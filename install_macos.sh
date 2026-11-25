#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo "       Antigravity (macOS) 简体中文汉化一键安装工具"
echo "========================================================"
bash "$SCRIPT_DIR/scripts/run_with_runtime.sh" "scripts/patch_antigravity.js"
bash "$SCRIPT_DIR/scripts/run_with_runtime.sh" "scripts/verify_engine.js" --smoke
echo ""
echo "========================================================"
echo "安装并校验完成！请按 Cmd + Q 彻底退出 Antigravity 后重新打开。"
echo "========================================================"
