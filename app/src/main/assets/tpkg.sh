#!/usr/bin/env bash
# tpkg —— 搬迁前缀环境下的 deb 手动安装器（DshLauncher 生成，随环境刷新）
#
# 背景：Termux 官方 deb 的 data.tar 成员路径写死官方的 files/usr 前缀，
# 本环境 Termux 根被搬迁到应用私有目录，dpkg 解包按包内路径落盘必然 EACCES。
# tpkg 走「dpkg-deb 手动解包 + 同步 dpkg 数据库 + 修 shebang」路线（报告方案 A），
# 不执行维护脚本/触发器（Termux 主仓库包基本无副作用脚本）。
#
# ★ 本文件**不得出现完整的官方绝对路径字面量**（官方 data/data/com.termux 下的
#   files 与 cache 路径）：
#   PrefixPatcher.patchAll / patchTextOfficialDirs 会扫描整棵 PREFIX 并改写它们，
#   一旦本文件自带这样的字面量，就会被 patcher 改坏——例如 patch_prefix 里的 grep
#   模式会被替换成短前缀，导致它永远匹配不到真正的官方前缀而静默失效。
#   因此所有官方路径一律由 $OLD_PREFIX 拼出来（$OLD_PREFIX 只到 com.termux 为止，
#   不含 "/files"，故不会被任一 patcher 命中）。
#
# ★ 本文件对 patcher 必须**幂等不变**：在修好 git 之后新装/新写出的 tpkg 也应
#   保持同一内容。tools/verify-prefix-patch.mjs 会把它纳入审计。
#
# 用法：
#   tpkg extract <deb>...     # 安装指定 deb 文件
#   tpkg install <包名>...    # 从 apt 缓存 var/cache/apt/archives/ 取对应 deb 安装
set -u

OLD_PREFIX="/data/data/com.termux"
PREFIX="${PREFIX:-/data/user/0/com.dsh.nextapp1/files/termux/usr}"
ROOT="$(dirname "$PREFIX")"
# 等长短前缀（必须与 Java 侧 PrefixPatcher.SHORT_PREFIX 一致）：官方前缀 31 字符，
# 短前缀同样 31 字符，故可在 ELF 内原地替换而不改变任何字节偏移。
SHORT_PREFIX="${SHORT_PREFIX:-/data/user/0/com.dsh.nextapp1/t}"
# 由 $OLD_PREFIX 拼出官方子路径，避免本文件出现裸字面量（见顶部说明）。
# OLD_USR_ERE 是 sed 用的正则形式（转义点号），同样不含裸字面量。
OLD_USR="$OLD_PREFIX/files/usr"
OLD_USR_ERE="$OLD_PREFIX/files/usr"
OLD_USR_ERE="${OLD_USR_ERE//./\\.}"
DEB_FILES="$OLD_PREFIX/files"
CACHE="$PREFIX/var/cache/apt/archives"
INFO="$PREFIX/var/lib/dpkg/info"
STATUS="$PREFIX/var/lib/dpkg/status"

msg() { printf '%s\n' "$*"; }
die() { msg "tpkg: ERROR: $*" >&2; exit 1; }

unlock()  { chmod -R u+w "$ROOT/usr/bin" "$ROOT/usr/lib" "$ROOT/usr/share" 2>/dev/null || true; }
restore() { chmod -R u-w "$ROOT/usr/bin" "$ROOT/usr/lib" "$ROOT/usr/share" 2>/dev/null || true; }

# 把单个文件里残留的官方前缀就地改写为短前缀（等长替换，二进制安全）。
# 这是与 Java 侧 PrefixPatcher 等价的 shell 版兜底：即使 App 侧的全量 patch 因任何
# 原因没跑到，经 tpkg 落盘的包也不会带着不可访问的官方前缀留在盘上。
# GNU sed -i 保留原权限位与文件长度：实测对 git 二进制（3613096 字节）替换 11 处后
# 长度不变、权限位 755 不变、`git --exec-path` 正确指向短前缀。
patch_prefix() { # $1 = 文件
  local f="$1"
  [ -f "$f" ] || return 0
  [ -L "$f" ] && return 0
  grep -qaF "$OLD_USR" "$f" 2>/dev/null || return 0
  if sed -i "s|$OLD_USR_ERE|$SHORT_PREFIX|g" "$f" 2>/dev/null; then
    msg "  prefix fixed: ${f#"$ROOT"/}"
  else
    msg "  WARN: 前缀改写失败：$f"
  fi
  return 0
}

# 对本包 .list 里的全部文件跑前缀改写
patch_list_prefixes() { # $1 = 本包 .list 文件
  local f
  while IFS= read -r f; do patch_prefix "$f"; done < "$1"
}

# 重写脚本 shebang 中残留的官方前缀（pip 等入口脚本会涉及）。
# 全部经变量拼接，本文件不含官方 files 路径的字面量。
fix_shebangs() { # $1 = 本包 .list 文件
  while IFS= read -r f; do
    case "$f" in *"/usr/bin/"*|*"/libexec/"*) ;; *) continue ;; esac
    [ -f "$f" ] || continue
    [ "$(head -c2 "$f" 2>/dev/null)" = "#!" ] || continue
    if grep -q "$OLD_PREFIX" "$f" 2>/dev/null; then
      sed -i "s|$OLD_USR|$PREFIX|g; s|$DEB_FILES|$ROOT|g" "$f"
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
  # 由 $DEB_FILES 拼出包内文件树根，避免本文件出现裸字面量（会被 patcher 改坏）
  local filesroot="$w/x$DEB_FILES"
  [ -d "$filesroot" ] || { msg "  ✗ 包内无预期文件树：$(basename "$deb")"; rm -rf "$w"; return 1; }
  local pkg; pkg="$(sed -n 's/^Package: //p' "$w/ctrl/control" | head -n1)"
  [ -n "$pkg" ] || { msg "  ✗ control 缺 Package 字段"; rm -rf "$w"; return 1; }

  msg "  解包 $pkg …"
  unlock
  cp -a "$filesroot/." "$ROOT/" || { restore; rm -rf "$w"; msg "  ✗ 落盘失败"; return 1; }

  mkdir -p "$INFO"
  ( cd "$filesroot" && find . \( -type f -o -type l \) ) \
    | sed "s|^\./|$ROOT/|" | sort > "$INFO/$pkg.list"
  # 顺序很重要：fix_shebangs 会改变文件长度，等长前缀替换必须在其之后（或只针对
  # ELF/非 shebang 文件）。patch_list_prefixes 只做等长替换，二者互不干扰。
  fix_shebangs "$INFO/$pkg.list"
  patch_list_prefixes "$INFO/$pkg.list"

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
