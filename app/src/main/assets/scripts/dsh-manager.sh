#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# dsh-manager.sh — dsh 后台服务管理（启动/停止/状态/日志）
#   用法：
#     bash dsh-manager.sh start      # 后台启动
#     bash dsh-manager.sh stop       # 停止
#     bash dsh-manager.sh status     # 查看状态
#     bash dsh-manager.sh logs       # 查看最近日志
#     bash dsh-manager.sh restart    # 重启
# 后台服务用于：开机自启 / 供安卓 App 调用。
# =============================================================================
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/dsh}"
WEB_PORT="${WEB_PORT:-3080}"
PIDFILE="$DSH_HOME/.dsh-server.pid"
LOGFILE="$DSH_HOME/.dsh-server.log"

# ---- 操作日志（终端 + 落盘，含时间戳）----
LOG_DIR_PRIVATE="$HOME/.dsh/logs"
LOG_DIR_SHARED="/sdcard/Download/DshLauncher/logs"
LOG_FILE="manager.log"
LOG_PRIVATE="$LOG_DIR_PRIVATE/$LOG_FILE"
LOG_SHARED="$LOG_DIR_SHARED/$LOG_FILE"
mkdir -p "$LOG_DIR_PRIVATE" 2>/dev/null || true
mkdir -p "$LOG_DIR_SHARED" 2>/dev/null || true
ts() { date '+%Y-%m-%d %H:%M:%S'; }

glog() {
  local line
  line="$(ts) [manager] $*"
  echo "$*"
  printf '%s\n' "$line" >>"$LOG_PRIVATE" 2>/dev/null || true
  printf '%s\n' "$line" >>"$LOG_SHARED" 2>/dev/null || true
}

if [ ! -f "$DSH_HOME/package.json" ]; then
  glog "❌ 未找到 dsh 源码：$DSH_HOME，请先运行 install-dsh.sh"
  exit 1
fi

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

cmd_status() {
  if is_running; then
    glog "🟢 dsh 运行中 (PID $(cat "$PIDFILE"))"
    glog "   Web : http://127.0.0.1:$WEB_PORT"
  else
    glog "⚪ dsh 未运行"
  fi
}

cmd_start() {
  if is_running; then glog "dsh 已在运行"; return 0; fi
  cd "$DSH_HOME"
  glog "启动 dsh 服务 (后台, PID 写入 $PIDFILE)..."
  nohup pnpm dsh web >>"$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 2
  cmd_status
}

cmd_stop() {
  if is_running; then
    glog "停止 dsh (PID $(cat "$PIDFILE"))..."
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    glog "⏹ 已停止 dsh"
  else
    glog "dsh 未在运行"
  fi
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) glog "重启 dsh"; cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    tail -n 50 "$LOGFILE" 2>/dev/null || echo "(无日志)" ;;
  *) echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
