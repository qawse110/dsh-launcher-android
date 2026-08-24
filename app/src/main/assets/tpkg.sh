#!/usr/bin/env bash
# tpkg —— 搬迁前缀环境下的 deb 手动安装器（DshLauncher 生成，随环境刷新）
#
# 背景：Termux 官方 deb 的 data.tar 成员路径写死 ./data/data/com.termux/files/usr/…，
# 本环境 Termux 根被搬迁到应用私有目录，dpkg 解包按包内路径落盘必然 EACCES。
# tpkg 走「dpkg-deb 手动解包 + 同步 dpkg 数据库 + 修 shebang」路线（报告方案 A），
# 不执行维护脚本/触发器（Termux 主仓库包基本无副作用脚本）。
#
# 用法：
#   tpkg extract <deb>...     # 安装指定 deb 文件
#   tpkg install <包名>...    # 从 apt 缓存 var/cache/apt/archives/ 取对应 deb 安装
set -u

OLD_PREFIX="/data/data/com.termux"
PREFIX="${PREFIX:-/data/user/0/com.dsh.launcher/files/termux/usr}"
ROOT="$(dirname "$PREFIX")"
CACHE="$PREFIX/var/cache/apt/archives"
INFO="$PREFIX/var/lib/dpkg/info"
STATUS="$PREFIX/var/lib/dpkg/status"

msg() { printf '%s\n' "$*"; }
die() { msg "tpkg: ERROR: $*" >&2; exit 1; }

unlock()  { chmod -R u+w "$ROOT/usr/bin" "$ROOT/usr/lib" "$ROOT/usr/share" 2>/dev/null || true; }
restore() { chmod -R u-w "$ROOT/usr/bin" "$ROOT/usr/lib" "$ROOT/usr/share" 2>/dev/null || true; }

# 重写脚本 shebang 中残留的官方前缀（pip 等入口脚本会涉及）
fix_shebangs() { # $1 = 本包 .list 文件
  while IFS= read -r f; do
    case "$f" in *"/usr/bin/"*|*"/libexec/"*) ;; *) continue ;; esac
    [ -f "$f" ] || continue
    [ "$(head -c2 "$f" 2>/dev/null)" = "#!" ] || continue
    if grep -q "$OLD_PREFIX" "$f" 2>/dev/null; then
      sed -i "s|$OLD_PREFIX/files/usr|$PREFIX|g; s|$OLD_PREFIX/files|$ROOT|g" "$f"
      msg "  shebang fixed: ${f#"$ROOT"/}"
    fi
  done < "$1"
}

# 把 stanza 合并进 status：先删除同名旧条目（含尾空行），再追加新条目
merge_status() { # $1=pkg $2=stanza-file
  cp "$STATUS" "$STATUS.dsh-bak" 2>/dev/null || die "status 备份失败"
  awk -v p="Package: $1" '
    BEGIN { skip = 0 }
    /^$/  { if (skip) { skip = 0; next } }
    !skip { print }
    $0 == p { skip = 1 }
  ' "$STATUS" > "$STATUS.tmp" || die "status 解析失败"
  cat "$2" >> "$STATUS.tmp"
  printf '\n' >> "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

extract_one() { # $1 = deb 路径
  local deb="$1"
  [ -f "$deb" ] || { msg "  ✗ 不存在：$deb"; return 1; }
  local w; w="$(mktemp -d "$ROOT/tmp/tpkg.XXXXXX")" || { msg "  ✗ mktemp 失败"; return 1; }
  dpkg-deb -x "$deb" "$w/x" && dpkg-deb -e "$deb" "$w/ctrl" || {
    msg "  ✗ dpkg-deb 解析失败：$(basename "$deb")"; rm -rf "$w"; return 1; }
  local filesroot="$w/x/data/data/com.termux/files"
  [ -d "$filesroot" ] || { msg "  ✗ 包内无预期文件树：$(basename "$deb")"; rm -rf "$w"; return 1; }
  local pkg; pkg="$(sed -n 's/^Package: //p' "$w/ctrl/control" | head -n1)"
  [ -n "$pkg" ] || { msg "  ✗ control 缺 Package 字段"; rm -rf "$w"; return 1; }

  msg "  解包 $pkg …"
  unlock
  cp -a "$filesroot/." "$ROOT/" || { restore; rm -rf "$w"; msg "  ✗ 落盘失败"; return 1; }

  mkdir -p "$INFO"
  ( cd "$filesroot" && find . \( -type f -o -type l \) ) \
    | sed "s|^\./|$ROOT/|" | sort > "$INFO/$pkg.list"
  fix_shebangs "$INFO/$pkg.list"

  { grep -E '^(Package|Source|Version|Architecture|Essential|Origin|Bugs|Maintainer|Installed-Size|Depends|Recommends|Suggests|Conflicts|Replaces|Provides):' "$w/ctrl/control"
    printf 'Status: install ok installed\n'
  } > "$w/stanza"
  merge_status "$pkg" "$w/stanza"

  restore
  rm -rf "$w"
  msg "  ✓ $pkg 安装完成（已同步 dpkg 数据库）"
  return 0
}

cmd_extract() {
  [ $# -ge 1 ] || die "用法：tpkg extract <deb>..."
  local fail=0 d
  for d in "$@"; do extract_one "$d" || fail=1; done
  return $fail
}

cmd_install() {
  [ $# -ge 1 ] || die "用法：tpkg install <包名>..."
  local debs=() n d
  for n in "$@"; do
    d="$(ls -1 "$CACHE/${n}"_*.deb 2>/dev/null | sort -V | tail -n1)"
    [ -n "$d" ] || die "缓存中未找到 $n 的 deb（先执行：apt-get -d install $n）"
    debs+=("$d")
  done
  cmd_extract "${debs[@]}"
}

case "${1:-}" in
  extract) shift; cmd_extract "$@" ;;
  install) shift; cmd_install "$@" ;;
  *) die "用法：tpkg extract <deb>... | tpkg install <包名>..." ;;
esac
