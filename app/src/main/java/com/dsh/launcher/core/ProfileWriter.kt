package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * profile/配置生成器：向 $PREFIX 写入 apt 适配配置、shell 包装器、
 * 交互式 profile、readline 配置与 tpkg 兜底安装器。
 *
 * 架构方案 P1-3：由 [BootstrapInstaller]（首装）与 [PackageKit]（刷新）调用。
 */
internal object ProfileWriter {

    private const val TPKG_ASSET = "tpkg.sh"

    /** 首装顺序写入全部配置。 */
    fun writeAll(context: Context, usr: File) {
        writeAptConfig(context, usr)
        writeShellAptHelper(usr)
        writeTpkgScript(context, usr)
        writeLinuxProfile(usr)
        writeInputRc(usr)
        disableSecondStageFallback(usr)
    }

    /**
     * 写 apt 的 PREFIX 适配配置：
     * - Cache/State 指到真实的 var/cache/apt（避免官方 cache 路径权限问题）
     * - dpkg 安装时用 `--instdir=<dataDir>` + 官方镜像写入真实目录，
     *   `--admindir` 指到已有的 dpkg 数据库。
     */
    fun writeAptConfig(context: Context, usr: File) {
        try {
            val dataDir = context.dataDir.absolutePath
            val config = File(usr, "etc/apt/apt.conf.d/00-dsh")
            config.parentFile?.mkdirs()
            config.writeText(
                "Dir::Cache::archives \"$usr/var/cache/apt/archives\";\n" +
                    "Dir::Cache::srcpkgcache \"$usr/var/cache/apt/srcpkgcache.bin\";\n" +
                    "Dir::Cache::pkgcache \"$usr/var/cache/apt/pkgcache.bin\";\n" +
                    "DPkg::Options:: \"--instdir=$dataDir\";\n" +
                    "DPkg::Options:: \"--admindir=$dataDir/t/var/lib/dpkg\";\n"
            )
            android.util.Log.i("ProfileWriter", "apt config written")
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "writeAptConfig failed: ${t.message}")
        }
    }

    /**
     * 安装 tpkg 到 $PREFIX/local/bin：搬迁前缀环境下的 deb 手动安装器
     * （dpkg-deb -x + status 同步 + shebang 修正，见 assets/tpkg.sh）。
     * 原生 apt 在 W^X 放开 + termux-exec 下已可正常工作（v4.6），
     * tpkg 仅作为 ensureHarnessTools 的安装失败兜底保留。
     */
    fun writeTpkgScript(context: Context, usr: File) {
        try {
            val dst = File(usr, "local/bin/tpkg")
            dst.parentFile?.mkdirs()
            context.assets.open(TPKG_ASSET).use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
            dst.setExecutable(true, false)
            android.util.Log.i("ProfileWriter", "tpkg installed")
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "writeTpkgScript failed: ${t.message}")
        }
    }

    /**
     * 给交互式 login shell（TerminalActivity）写 apt/pkg 自动 W^X 切换函数：
     * 在终端里敲 `apt install` 时自动放开 bin/lib/share，命令结束恢复只读。
     * ConsoleActivity 的命令行进程不走 profile，已由应用层自动切换覆盖。
     */
    fun writeShellAptHelper(usr: File) {
        try {
            val dir = File(usr, "etc/profile.d")
            dir.mkdirs()
            val helper = File(dir, "00-dsh-apt.sh")
            helper.writeText(
                """
                # 内置 Termux：apt/pkg 安装类命令自动放开 W^X，结束后恢复
                # （v4.6 默认已放开：-w 短路避免在大目录树上空跑 chmod）
                __dsh_writable() { [ -w "${'$'}PREFIX/lib" ] || chmod -R u+w "${'$'}PREFIX/bin" "${'$'}PREFIX/lib" "${'$'}PREFIX/share" 2>/dev/null || true; }
                __dsh_restore() { chmod -R u-w "${'$'}PREFIX/bin" "${'$'}PREFIX/lib" "${'$'}PREFIX/share" 2>/dev/null || true; }
                apt() {
                  case " ${'$'}* " in
                    *" install "*|*" reinstall "*|*" upgrade "*|*" dist-upgrade "*|*" remove "*|*" purge "*)
                      __dsh_writable; command apt "${'$'}@"; local rc=${'$'}?; __dsh_restore; return ${'$'}rc;;
                    *) command apt "${'$'}@";;
                  esac
                }
                apt-get() {
                  case " ${'$'}* " in
                    *" install "*|*" reinstall "*|*" upgrade "*|*" dist-upgrade "*|*" remove "*|*" purge "*)
                      __dsh_writable; command apt-get "${'$'}@"; local rc=${'$'}?; __dsh_restore; return ${'$'}rc;;
                    *) command apt-get "${'$'}@";;
                  esac
                }
                pkg() {
                  case " ${'$'}* " in
                    *" install "*|*" reinstall "*|*" upgrade "*|*" dist-upgrade "*|*" remove "*|*" purge "*)
                      __dsh_writable; command pkg "${'$'}@"; local rc=${'$'}?; __dsh_restore; return ${'$'}rc;;
                    *) command pkg "${'$'}@";;
                  esac
                }
                """.trimIndent() + "\n"
            )
            helper.setExecutable(true, false)
            android.util.Log.i("ProfileWriter", "shell apt helper written")
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "writeShellAptHelper failed: ${t.message}")
        }
    }

    /**
     * 写入 Linux 风格的交互式 shell profile：
     * 彩色 ls / grep、ll/la 等常用别名、EDITOR/PAGER 以及 which 函数，
     * 让内置终端和传统 Linux 终端行为更接近。
     */
    fun writeLinuxProfile(usr: File) {
        try {
            val dir = File(usr, "etc/profile.d")
            dir.mkdirs()
            val profile = File(dir, "00-dsh-env.sh")
            profile.writeText(
                """
                # dsh-launcher: Linux-like interactive shell profile
                export EDITOR=nano
                export PAGER=less
                export MANPAGER=less

                # 运行时翻译脚本 shebang 的官方前缀（postinst / pip 入口脚本依赖）
                if [ -f "${'$'}PREFIX/lib/libtermux-exec-ld-preload.so" ]; then
                  export LD_PRELOAD="${'$'}PREFIX/lib/libtermux-exec-ld-preload.so"
                fi

                alias ls='ls --color=auto'
                alias ll='ls -AlhF --color=auto'
                alias la='ls -A --color=auto'
                alias l='ls -CF --color=auto'
                alias grep='grep --color=auto'
                alias egrep='egrep --color=auto'
                alias fgrep='fgrep --color=auto'
                alias df='df -h'
                alias du='du -h'

                which() { command -v "${'$'}@" 2>/dev/null || return 1; }

                case "${'$'}TERM" in
                  xterm*|screen*|tmux*)
                    PS1='\[\e]0;\u@\h: \w\a\]\[\e[01;32m\]\u@\h\[\e[00m\]:\[\e[01;34m\]\w\[\e[00m\]\$ '
                    ;;
                  *)
                    PS1='\u@\h:\w\$ '
                    ;;
                esac
                export PS1
                """.trimIndent() + "\n"
            )
            profile.setExecutable(true, false)
            android.util.Log.i("ProfileWriter", "linux shell profile written")
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "writeLinuxProfile failed: ${t.message}")
        }
    }

    /** 写 readline 配置，让 bash 在交互终端中的补全/粘贴体验更接近 Linux。 */
    fun writeInputRc(usr: File) {
        try {
            val dir = File(usr, "etc")
            dir.mkdirs()
            File(dir, "inputrc").writeText(
                """
                set enable-bracketed-paste on
                set show-all-if-ambiguous on
                set completion-ignore-case on
                set bell-style visible
                set colored-stats on
                """.trimIndent() + "\n"
            )
            android.util.Log.i("ProfileWriter", "readline inputrc written")
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "writeInputRc failed: ${t.message}")
        }
    }

    /**
     * 禁用 Termux 的 second-stage fallback：
     * 官方首次 login 会尝试执行 bootstrap second-stage，但它依赖官方绝对路径
     * `/data/data/com.termux` 且需要可写 bin，在第三方 app 私有目录会失败刷屏。
     * 我们的环境已经通过 apt/镜像适配准备好，直接移除该 fallback，避免每次
     * login 重复报错。
     */
    fun disableSecondStageFallback(usr: File) {
        try {
            val f = File(usr, "etc/profile.d/01-termux-bootstrap-second-stage-fallback.sh")
            if (f.exists() && !java.nio.file.Files.isSymbolicLink(f.toPath())) {
                f.delete()
                android.util.Log.i("ProfileWriter", "second-stage fallback disabled")
            }
        } catch (t: Throwable) {
            android.util.Log.w("ProfileWriter", "disableSecondStageFallback failed: ${t.message}")
        }
    }
}
