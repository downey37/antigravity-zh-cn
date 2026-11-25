#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo "       Antigravity (macOS) 官方英文原版还原工具"
echo "========================================================"
bash "$SCRIPT_DIR/scripts/run_with_runtime.sh" "scripts/restore_antigravity.js"
echo ""
echo "========================================================"
echo "还原完成！请按 Cmd + Q 彻底退出 Antigravity 后重新打开。"
echo "========================================================"
