#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# dsh-init.sh — 开机自启入口（配合 Termux:Boot 使用）
#
# 步骤：
#   1. 安装 Termux:Boot 插件
#   2. 把本文件放入  ~/.termux/boot/  目录：
#        mkdir -p ~/.termux/boot
#        cp dsh-init.sh ~/.termux/boot/
#        chmod +x ~/.termux/boot/dsh-init.sh
#   3. 重启手机后，dsh 会在后台自动启动
# =============================================================================
set -uo pipefail

# ---- 日志记录（终端 + 落盘，含时间戳）----
LOG_DIR_PRIVATE="$HOME/.dsh/logs"
LOG_DIR_SHARED="/sdcard/Download/DshLauncher/logs"
LOG_FILE="init.log"
LOG_PRIVATE="$LOG_DIR_PRIVATE/$LOG_FILE"
LOG_SHARED="$LOG_DIR_SHARED/$LOG_FILE"
mkdir -p "$LOG_DIR_PRIVATE" 2>/dev/null || true
mkdir -p "$LOG_DIR_SHARED" 2>/dev/null || true
ts() { date '+%Y-%m-%d %H:%M:%S'; }

dlog() {
  local line
  line="$(ts) [init] $*"
  echo "$*"
  printf '%s\n' "$line" >>"$LOG_PRIVATE" 2>/dev/null || true
  printf '%s\n' "$line" >>"$LOG_SHARED" 2>/dev/null || true
}

# 等待 Termux 环境就绪
dlog "开机自启：等待 Termux 环境就绪..."
sleep 5

DSH_MANAGER="${DSH_HOME:-$HOME/dsh}/dsh-manager.sh"
if [ ! -f "$DSH_MANAGER" ]; then
  DSH_MANAGER="$(dirname "$(readlink -f "$0")")/dsh-manager.sh"
fi

if [ -f "$DSH_MANAGER" ]; then
  dlog "使用管理器: $DSH_MANAGER"
  "$DSH_MANAGER" start
  dlog "自启完成"
else
  dlog "❌ 未找到 dsh-manager.sh"
fi
