#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

resolve_app_exe() {
  local candidates=()
  if [[ -n "${ANTIGRAVITY_EXE:-}" ]]; then
    candidates+=("$ANTIGRAVITY_EXE")
  fi
  if [[ -n "${ANTIGRAVITY_APP:-}" ]]; then
    candidates+=("${ANTIGRAVITY_APP}/Contents/MacOS/Antigravity")
  fi
  if [[ -n "${ANTIGRAVITY_DIR:-}" ]]; then
    candidates+=("${ANTIGRAVITY_DIR}/Contents/MacOS/Antigravity")
  fi
  candidates+=(
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity"
    "${HOME}/Applications/Antigravity.app/Contents/MacOS/Antigravity"
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver="$(node -v 2>/dev/null || true)"
  if [[ "$ver" =~ ^v?([0-9]+)\.([0-9]+)\. ]]; then
    local major="${BASH_REMATCH[1]}"
    local minor="${BASH_REMATCH[2]}"
    if (( major > 20 || (major == 20 && minor >= 19) )); then
      return 0
    fi
  fi
  return 1
}

if [[ ! -f "node_modules/@electron/asar/package.json" ]]; then
  if command -v npm >/dev/null 2>&1; then
    echo "[提示] 正在安装本地依赖 (npm install --omit=dev)..."
    npm install --omit=dev
  else
    echo "[错误] 缺少 node_modules/@electron/asar 依赖且未检测到 npm。" >&2
    exit 1
  fi
fi

run_js() {
  if node_is_compatible; then
    node "$@"
  else
    local app_exe
    if ! app_exe="$(resolve_app_exe)"; then
      echo "[错误] 未检测到 Node.js (>= 20.19)，也未找到 /Applications/Antigravity.app。" >&2
      exit 1
    fi
    ELECTRON_RUN_AS_NODE=1 "$app_exe" "$@"
  fi
}

echo "========================================================"
echo "       Antigravity (macOS) 官方英文原版还原工具"
echo "========================================================"
run_js "scripts/restore_antigravity.js"
echo ""
echo "========================================================"
echo "还原完成！请按 Cmd + Q 彻底退出 Antigravity 后重新打开。"
echo "========================================================"
