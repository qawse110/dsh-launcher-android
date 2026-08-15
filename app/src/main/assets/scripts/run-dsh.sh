#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# run-dsh.sh — 前台启动 DeepSeek Harness Web UI
#   用法： bash run-dsh.sh
#   停止： 按 Ctrl+C
# 依赖： 需先执行过 install-dsh.sh
# 日志： 写入 $HOME/.dsh/logs/run.log 和 /sdcard/Download/DshLauncher/logs/run.log
# =============================================================================
set -euo pipefail

# ---- 日志记录（终端显示 + 落盘，含时间戳）----
LOG_DIR_PRIVATE="$HOME/.dsh/logs"
LOG_DIR_SHARED="/sdcard/Download/DshLauncher/logs"
LOG_FILE="run.log"
LOG_PRIVATE="$LOG_DIR_PRIVATE/$LOG_FILE"
LOG_SHARED="$LOG_DIR_SHARED/$LOG_FILE"
mkdir -p "$LOG_DIR_PRIVATE" 2>/dev/null || true
mkdir -p "$LOG_DIR_SHARED" 2>/dev/null || true
ts() { date '+%Y-%m-%d %H:%M:%S'; }

log() {
  local line
  line="$(ts) [run] $*"
  printf '%s\n' "$*"
  printf '%s\n' "$line" >>"$LOG_PRIVATE" 2>/dev/null || true
  printf '%s\n' "$line" >>"$LOG_SHARED" 2>/dev/null || true
}

# 智能定位 dsh 目录：优先当前目录下的 .git，否则用默认 $HOME/dsh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/.git" ]; then
  DSH_HOME="$SCRIPT_DIR"
else
  DSH_HOME="${DSH_HOME:-$HOME/dsh}"
fi

if [ ! -f "$DSH_HOME/package.json" ]; then
  log "❌ 未找到 dsh 源码：$DSH_HOME"
  log "   请先运行 install-dsh.sh"
  exit 1
fi

cd "$DSH_HOME"
[ -f .dsh-env ] && . ./.dsh-env
WEB_PORT="${WEB_PORT:-3080}"

# 定位运行时：DSH_NODE_DIR 优先，其次 .dsh-env 记录的 NODE_BIN，最后 PATH
NODE_RUN=""
if [ -n "${DSH_NODE_DIR:-}" ] && [ -x "$DSH_NODE_DIR/bin/node" ]; then
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}$DSH_NODE_DIR/lib"
  export TMPDIR="${TMPDIR:-$DSH_NODE_DIR/tmp}"
  export OPENSSL_CONF=/dev/null
  mkdir -p "$TMPDIR" 2>/dev/null || true
  export PATH="$DSH_NODE_DIR/bin:$PATH"
  NODE_RUN="$DSH_NODE_DIR/bin/node"
elif [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  NODE_RUN="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_RUN="$(command -v node)"
else
  log "❌ 未找到 Node 运行时。请通过 DSH_NODE_DIR 指定内置 Node 目录。"
  exit 1
fi

log "=== dsh 启动开始 ==="
log "🚀 启动 DeepSeek Harness Web UI"
log "   地址 : http://127.0.0.1:$WEB_PORT"
log "   停止 : 按 Ctrl+C"
log "   DSH_HOME: $DSH_HOME"
log "   Node   : $NODE_RUN"
log ""
exec "$NODE_RUN" ./node_modules/.bin/dsh web
