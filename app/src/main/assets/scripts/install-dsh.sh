#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# install-dsh.sh — 一键安装并构建 DeepSeek Harness (dsh)【免 Termux】
#
# 用法：
#   bash install-dsh.sh
#   # 或（指定内置 Node 运行时目录，App 已内置 Node 时用此路径）
#   DSH_NODE_DIR=/data/data/com.dsh.launcher/files/node bash install-dsh.sh
#
# 本脚本【免 Termux】：不再依赖 Termux 的 pkg。运行时定位顺序：
#   1) DSH_NODE_DIR 环境变量指定（App 内置 Node 解压目录，含 bin/node、bin/npm）
#   2) PATH 中的 node / npm（如在真实 Termux 中）
# 依赖命令：git。构建使用 pnpm（通过内置 npm 安装到本地 $DSH_HOME/.tools）。
#
# 该脚本会：
#   1. 定位 Node/npm 运行时
#   2. 克隆 deepseek-harness 仓库
#   3. 本地安装 pnpm，安装依赖并构建 (pnpm install && pnpm run build)
#   4. 写入版本信息
# 注意：全程保持联网；构建需要几分钟，请耐心等待。
# 日志：写入 $HOME/.dsh/logs/install.log 和 /sdcard/Download/DshLauncher/logs/install.log
# =============================================================================
set -euo pipefail

# ---- 可配置 ----
DSH_HOME="${DSH_HOME:-$HOME/dsh}"
DSH_REPO="${DSH_REPO:-https://github.com/deepseek-ai/deepseek-harness.git}"
DSH_BRANCH="${DSH_BRANCH:-master}"
PNPM_VERSION="${PNPM_VERSION:-11.7.0}"
WEB_PORT="${WEB_PORT:-3080}"

# ---- 日志记录（终端显示 + 落盘，含时间戳）----
LOG_DIR_PRIVATE="$HOME/.dsh/logs"
LOG_DIR_SHARED="/sdcard/Download/DshLauncher/logs"
LOG_FILE="install.log"
LOG_PRIVATE="$LOG_DIR_PRIVATE/$LOG_FILE"
LOG_SHARED="$LOG_DIR_SHARED/$LOG_FILE"
mkdir -p "$LOG_DIR_PRIVATE" 2>/dev/null || true
mkdir -p "$LOG_DIR_SHARED" 2>/dev/null || true

ts() { date '+%Y-%m-%d %H:%M:%S'; }

log() {
  local line
  line="$(ts) [install] $*"
  printf '\033[1;36m[install]\033[0m %s\n' "$*"
  printf '%s\n' "$line" >>"$LOG_PRIVATE" 2>/dev/null || true
  printf '%s\n' "$line" >>"$LOG_SHARED" 2>/dev/null || true
}
err() {
  local line
  line="$(ts) [install][ERROR] $*"
  printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2
  printf '%s\n' "$line" >>"$LOG_PRIVATE" 2>/dev/null || true
  printf '%s\n' "$line" >>"$LOG_SHARED" 2>/dev/null || true
}

log "=== dsh 安装开始 ==="
log "DSH_HOME=$DSH_HOME, 分支=$DSH_BRANCH, pnpm=$PNPM_VERSION, 端口=$WEB_PORT"
log "日志: $LOG_PRIVATE"

# ---- 1. 定位 Node/npm（免 Termux，不再依赖 Termux pkg）----
# 优先 DSH_NODE_DIR（App 内置 Node），其次 PATH
if [ -n "${DSH_NODE_DIR:-}" ] && [ -x "$DSH_NODE_DIR/bin/node" ]; then
  NODE_BIN="$DSH_NODE_DIR/bin/node"
  NPM_BIN="$DSH_NODE_DIR/bin/npm"
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}$DSH_NODE_DIR/lib"
  export TMPDIR="${TMPDIR:-$DSH_NODE_DIR/tmp}"
  export OPENSSL_CONF=/dev/null
  mkdir -p "$TMPDIR" 2>/dev/null || true
  export PATH="$DSH_NODE_DIR/bin:$PATH"
  log "使用内置 Node 运行时: $DSH_NODE_DIR"
elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
  log "使用 PATH 中的 Node: $NODE_BIN"
else
  err "未找到 Node 运行时。请通过 DSH_NODE_DIR 指定内置 Node 目录（如 /data/data/com.dsh.launcher/files/node）或先安装 Node.js。"
  exit 1
fi

"$NODE_BIN" --version >/dev/null 2>&1 || { err "Node 无法运行: $NODE_BIN"; exit 1; }
log "Node 版本: $("$NODE_BIN" --version)"

# ---- 2. git 检查 ----
command -v git >/dev/null 2>&1 || { err "未找到 git 命令。请安装 git 后重试。"; exit 1; }

# ---- 3. 本地安装 pnpm（免全局写权限目录）----
PNPM_DIR="$DSH_HOME/.tools"
mkdir -p "$PNPM_DIR"
if [ ! -x "$PNPM_DIR/bin/pnpm" ]; then
  log "安装 pnpm@$PNPM_VERSION 到 $PNPM_DIR ..."
  "$NPM_BIN" install -g "pnpm@$PNPM_VERSION" --prefix "$PNPM_DIR" || { err "pnpm 安装失败"; exit 1; }
fi
export PATH="$PNPM_DIR/bin:$PATH"
log "pnpm 版本: $("$PNPM_DIR/bin/pnpm" --version)"

# ---- 4. 克隆仓库 ----
if [ ! -d "$DSH_HOME/.git" ]; then
  log "克隆 deepseek-harness -> $DSH_HOME"
  mkdir -p "$DSH_HOME"
  git clone --depth 1 -b "$DSH_BRANCH" "$DSH_REPO" "$DSH_HOME"
else
  log "仓库已存在，拉取最新代码..."
  git -C "$DSH_HOME" fetch --depth 1 origin "$DSH_BRANCH"
  git -C "$DSH_HOME" reset --hard "origin/$DSH_BRANCH"
fi

cd "$DSH_HOME"

# ---- 5. 安装依赖 + 构建 ----
log "安装依赖 (pnpm install) ..."
"$PNPM_DIR/bin/pnpm" install --no-frozen-lockfile

log "构建 (pnpm run build) ..."
"$PNPM_DIR/bin/pnpm" run build

# ---- 6. 记录信息 ----
cat > "$DSH_HOME/.dsh-env" <<ENV
DSH_HOME=$DSH_HOME
WEB_PORT=$WEB_PORT
PNPM_VERSION=$PNPM_VERSION
NODE_VERSION=$("$NODE_BIN" --version)
NODE_BIN=$NODE_BIN
INSTALL_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ENV

cat > "$DSH_HOME/run-dsh.sh" <<'SCRIPT'
#!/data/data/com.termux/files/usr/bin/bash
# 启动 dsh（前台）。按 Ctrl+C 停止。免 Termux：使用内置 Node。
cd "$(dirname "$0")"
if [ -f .dsh-env ]; then . ./.dsh-env; fi
# 定位运行时：DSH_NODE_DIR 优先，其次 .dsh-env 记录的 NODE_BIN，最后 PATH
if [ -n "${DSH_NODE_DIR:-}" ] && [ -x "$DSH_NODE_DIR/bin/node" ]; then
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}$DSH_NODE_DIR/lib"
  export TMPDIR="${TMPDIR:-$DSH_NODE_DIR/tmp}"
  export OPENSSL_CONF=/dev/null
  mkdir -p "$TMPDIR" 2>/dev/null || true
  export PATH="$DSH_NODE_DIR/bin:$PATH"
  exec "$DSH_NODE_DIR/bin/node" ./node_modules/.bin/dsh web
fi
if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  exec "$NODE_BIN" ./node_modules/.bin/dsh web
fi
exec node ./node_modules/.bin/dsh web
SCRIPT
chmod +x "$DSH_HOME/run-dsh.sh"

log "✅ 安装完成！"
log "   源码目录 : $DSH_HOME"
log "   启动命令 : bash $DSH_HOME/run-dsh.sh   （或 cd $DSH_HOME && pnpm dsh web）"
log "   Web 界面 : http://127.0.0.1:$WEB_PORT"
