package com.dsh.launcher

import android.content.Context
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths

/**
 * 内置 Termux 用户环境：从 APK assets 解压官方 Termux bootstrap（aarch64）到应用私有目录。
 *
 * bootstrap 顶层就是 PREFIX 内容（bin/lib/share/var），无需剥离目录；符号链接记录在
 * SYMLINKS.txt（`源→目标`），Termux 二进制使用系统 linker64，因此只要设置好
 * LD_LIBRARY_PATH=$PREFIX/lib 与 PATH=$PREFIX/bin 即可在任意私有目录运行。
 *
 * W^X 说明：本机 targetSdk=28，但仍按 NodeRuntime 的成熟实践把 bin/lib/share 设为
 * 不可写（可执行），避免厂商/系统 W^X 策略拦截；可写区域（home/tmp/var）保持可写，
 * apt/dpkg 安装时如需写 bin/lib 可调用 [setRuntimeWritable] 临时放开。
 */
object TermuxRuntime {

    private const val ASSET = "termux-bootstrap.zip"
    private const val MARKER = ".termux-ok"
    private const val MARKER_VERSION = "6"
    private const val TOOLS_MARKER = ".harness-tools-ok"
    private const val TOOLS_MARKER_VERSION = "3"
    private const val DIR_NAME = "termux"

    /** 官方二进制硬编码的 Termux 前缀（长度 31）。 */
    private const val OFFICIAL_PREFIX = "/data/data/com.termux/files/usr"

    /** 等长替换用的短前缀，通过 dataDir/t -> files/termux/usr 符号链接映射。 */
    private const val SHORT_PREFIX = "/data/user/0/com.dsh.launcher/t"

    fun isReady(context: Context): Boolean = runCatching {
        File(context.filesDir, MARKER).readText().trim() == MARKER_VERSION
    }.getOrDefault(false)

    fun prefix(context: Context): File = File(context.filesDir, "$DIR_NAME/usr")

    fun home(context: Context): File = File(context.filesDir, "$DIR_NAME/home")

    fun tmp(context: Context): File = File(context.filesDir, "$DIR_NAME/tmp")

    fun bashPath(context: Context): File = File(prefix(context), "bin/bash")

    fun isBashReady(context: Context): Boolean = bashPath(context).isFile

    /** Harness 附加工具（git/python/ripgrep）是否已安装就绪。 */
    fun harnessToolsReady(context: Context): Boolean = runCatching {
        File(context.filesDir, TOOLS_MARKER).readText().trim() == TOOLS_MARKER_VERSION
    }.getOrDefault(false)

    /**
     * 确保内置 Termux 具备 dsh 与交互式终端所需工具：
     * git（必需）、python / ripgrep / file / curl / less（优先级次之，缺了会尽力补齐）。
     * 通过 pkg 安装；网络不可用或安装失败时返回 false，不破坏已有 Termux 环境。
     */
    @Synchronized
    fun ensureHarnessTools(context: Context, progress: (String) -> Unit = {}): Boolean {
        try {
            val usr = prefix(context)
            if (!isBashReady(context)) return false
            // 每次调用都刷新 profile/inputrc（幂等），保证交互式终端体验即时生效
            writeLinuxProfile(usr)
            writeInputRc(usr)
            if (harnessToolsReady(context)) return true
            val bash = bashPath(context).absolutePath
            val home = home(context).absolutePath
            val tmp = tmp(context).absolutePath
            val marker = File(context.filesDir, TOOLS_MARKER)
            val env = mapOf(
                "PREFIX" to usr.absolutePath,
                "HOME" to home,
                "TMPDIR" to tmp,
                "TERM" to "xterm-256color",
                "LANG" to "C.UTF-8",
                "PATH" to listOf(
                    "$usr/bin", "$usr/bin/applets", "$usr/local/bin",
                    "/system/bin", "/bin"
                ).joinToString(":"),
                "LD_LIBRARY_PATH" to "$usr/lib"
            )
            progress("检查 Harness 工具（git / python / ripgrep / file / curl / less）…")
            val check = runBash(bash, "command -v git >/dev/null 2>&1 && (command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1) && command -v rg >/dev/null 2>&1 && command -v file >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v less >/dev/null 2>&1", env, progress)
            if (check == 0) {
                marker.writeText(TOOLS_MARKER_VERSION)
                progress("Harness 工具已就绪（git + python + ripgrep + file + curl + less）")
                return true
            }
            progress("安装补全 Harness 工具（git / python / ripgrep / file / curl / less / wget）…")
            setRuntimeWritable(context, true)
            try {
                var gitOk = File(usr, "bin/git").isFile
                if (!gitOk) {
                    val gitRc = runBash(bash, "pkg install -y git", env, progress)
                    gitOk = File(usr, "bin/git").isFile
                    if (!gitOk) {
                        progress("git 安装未完成（exit=$gitRc），刷新软件源后重试一次…")
                        runBash(bash, "pkg update -y", env, progress)
                        runBash(bash, "pkg install -y git", env, progress)
                        gitOk = File(usr, "bin/git").isFile
                    }
                }
                var pythonOk = File(usr, "bin/python").isFile || File(usr, "bin/python3").isFile
                if (!pythonOk) {
                    val pyRc = runBash(bash, "pkg install -y python", env, progress)
                    pythonOk = File(usr, "bin/python").isFile || File(usr, "bin/python3").isFile
                    if (!pythonOk) progress("WARN: python 可选安装未成功（exit=$pyRc），不影响 Harness 核心")
                }
                var rgOk = File(usr, "bin/rg").isFile
                if (!rgOk) {
                    val rgRc = runBash(bash, "pkg install -y ripgrep", env, progress)
                    rgOk = File(usr, "bin/rg").isFile
                    if (!rgOk) progress("WARN: ripgrep 可选安装未成功（exit=$rgRc），将回退 @vscode/ripgrep-linux-arm64")
                }
                // Linux 命令行常用工具兜底：bootstrap 通常已带 curl/less，file/wget 可能缺失。
                progress("检查/安装 Linux 常用工具（file / curl / less / wget）…")
                var linuxCoreOk = File(usr, "bin/file").isFile && File(usr, "bin/curl").isFile && File(usr, "bin/less").isFile
                if (!linuxCoreOk) {
                    runBash(bash, "pkg install -y file curl less wget", env, progress)
                    linuxCoreOk = File(usr, "bin/file").isFile && File(usr, "bin/curl").isFile && File(usr, "bin/less").isFile
                }
                val wgetOk = File(usr, "bin/wget").isFile
                if (!wgetOk) progress("WARN: wget 可选安装未成功，使用 curl 可覆盖常用下载场景")
                if (!linuxCoreOk) progress("WARN: Linux 常用工具(file/curl/less)未完全就绪，终端体验可能略降")

                if (gitOk && linuxCoreOk) {
                    marker.writeText(TOOLS_MARKER_VERSION)
                    val ready = buildList {
                        add("git")
                        if (pythonOk) add("python")
                        if (rgOk) add("ripgrep")
                        add("file")
                        add("curl")
                        add("less")
                        if (wgetOk) add("wget")
                    }.joinToString(" + ")
                    progress("Harness 工具就绪（$ready）")
                } else {
                    progress("WARN: Harness 工具未完全就绪（git=$gitOk, linux-core=$linuxCoreOk），保留 marker 以便下次重试")
                }
                return gitOk && linuxCoreOk
            } finally {
                setRuntimeWritable(context, false)
            }
        } catch (t: Throwable) {
            progress("WARN: ensureHarnessTools 失败: ${t.message}")
            return false
        }
    }

    private fun runBash(bash: String, script: String, env: Map<String, String>, progress: (String) -> Unit): Int = try {
        val pb = ProcessBuilder(bash, "-c", script)
        pb.redirectErrorStream(true)
        val e = pb.environment()
        env.forEach { (k, v) -> e[k] = v }
        e.remove("LD_PRELOAD")
        val p = pb.start()
        p.inputStream.bufferedReader().useLines { lines ->
            lines.forEach { line -> progress(line) }
        }
        p.waitFor()
    } catch (t: Throwable) {
        progress("bash 执行失败: ${t.message}")
        -1
    }

    /**
     * 解压并准备 Termux 环境（同步，可能耗时 10~60 秒）。
     * [progress] 在 UI/后台线程安全时由调用方决定如何显示。
     */
    @Synchronized
    fun ensureExtracted(context: Context, progress: (String) -> Unit = {}): File {
        if (isReady(context)) return prefix(context)
        val usr = prefix(context)
        progress("准备目录…")
        cleanupDir(usr)

        // assets 流不可 seek，先复制到 cache 再用 ZipFile 解压
        val cache = File(context.cacheDir, ASSET)
        try {
            context.assets.open(ASSET).use { ins ->
                cache.outputStream().use { ous -> ins.copyTo(ous) }
            }
            progress("已就绪压缩包 ${cache.length() / 1024 / 1024}MB，开始解压…")

            val symlinks = StringBuilder()
            var count = 0
            ZipFile(cache).use { zip ->
                val entries = zip.entries
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    var name = e.name.replace('\\', '/')
                    if (name.isBlank()) continue
                    if (name == "SYMLINKS.txt") {
                        symlinks.append(zip.getInputStream(e).readBytes().toString(Charsets.UTF_8))
                        continue
                    }
                    if (name.startsWith("/") || name.split('/').any { it == ".." }) continue
                    val out = File(usr, name)
                    if (e.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        zip.getInputStream(e).use { ins ->
                            out.outputStream().use { ous -> ins.copyTo(ous) }
                        }
                        if (name.startsWith("bin/") || name.startsWith("lib/")) {
                            out.setExecutable(true, false)
                        }
                    }
                    if (++count % 300 == 0) progress("解压中：$count 项…")
                }
            }
            progress("解压完成，创建符号链接…")
            applySymlinks(usr, symlinks.toString())
            createPrefixShortcut(context)
            createOfficialMirror(context)
            progress("适配 Termux 官方硬编码路径（${OFFICIAL_PREFIX} → ${SHORT_PREFIX}）…")
            patchPrefixAll(usr)
            patchTextOfficialDirs(usr)
            writeAptConfig(context, usr)
            writeShellAptHelper(usr)
            writeLinuxProfile(usr)
            writeInputRc(usr)
            disableSecondStageFallback(usr)

            // 可写业务目录：home / tmp / var（apt/dpkg 需要 var 可写）
            home(context).mkdirs()
            tmp(context).mkdirs()
            File(usr, "var").mkdirs()
            File(usr, "var/lib/dpkg").mkdirs()
            File(usr, "var/lib/apt/lists/partial").mkdirs()
            File(usr, "var/cache/apt").mkdirs()
            File(usr, "var/cache/apt/archives/partial").mkdirs()
            File(usr, "var/log/apt").mkdirs()

            // W^X：bin/lib/share 只读可执行；var 保持可写
            makeUnwritable(File(usr, "bin"))
            makeUnwritable(File(usr, "lib"))
            makeUnwritable(File(usr, "share"))

            File(context.filesDir, MARKER).writeText(MARKER_VERSION)
            progress("Termux 环境就绪（$usr）")
            cache.delete()
            return usr
        } catch (t: Throwable) {
            runCatching { cache.delete() }
            runCatching { usr.deleteRecursively() }
            runCatching { File(context.filesDir, MARKER).delete() }
            throw t
        }
    }

    /**
     * 临时调整 bin/lib/share 是否可写。
     * W^X 目标下默认可执行但不可写；执行 apt/packages 安装前若工具链要求
     * 写入 bin/lib，可传 writable=true，装完再传 false 恢复。
     */
    fun setRuntimeWritable(context: Context, writable: Boolean) {
        val usr = prefix(context)
        setWritableRecursive(File(usr, "bin"), writable)
        setWritableRecursive(File(usr, "lib"), writable)
        setWritableRecursive(File(usr, "share"), writable)
    }

    // ---------------- 内部工具 ----------------

    private fun cleanupDir(dir: File) {
        if (!dir.exists()) return
        makeWritableRecursive(dir)
        dir.deleteRecursively()
        dir.mkdirs()
    }

    private fun applySymlinks(usr: File, content: String) {
        var ok = 0
        var skipped = 0
        var skippedReasons = mutableMapOf<String, Int>()
        for (line in content.lineSequence()) {
            val idx = line.indexOf('←')
            if (idx <= 0) continue
            // 官方格式：`目标 ← ./链接位置`
            // 例：libreadline.so.8 ← ./lib/libreadline.so
            //   => 创建 $PREFIX/lib/libreadline.so -> libreadline.so.8
            val targetRaw = line.substring(0, idx).trim()
            val linkRaw = line.substring(idx + 1).trim()
            val linkPath = resolvePrefixRelative(usr, linkRaw) ?: run { skipped++; continue }
            val linkFile = File(linkPath)
            linkFile.parentFile?.mkdirs()
            val target = if (targetRaw.startsWith("/data/data/com.termux/files/usr"))
                usr.absolutePath + "/" + targetRaw.removePrefix("/data/data/com.termux/files/usr").trimStart('/')
            else targetRaw
            try {
                if (linkFile.isDirectory && !java.nio.file.Files.isSymbolicLink(linkFile.toPath())) {
                    // 源路径与真实目录冲突：不能删除目录，跳过（dsh/node 下的目录不动）
                    skipped++
                    continue
                }
                // 对 dangling symlink 必须用 NIO deleteIfExists（File.exists() 对断链返回 false）
                java.nio.file.Files.deleteIfExists(linkFile.toPath())
                Files.createSymbolicLink(linkFile.toPath(), Paths.get(target))
                ok++
            } catch (t: Throwable) {
                skipped++
                val key = t.javaClass.simpleName + ": " + (t.message ?: "").take(80)
                skippedReasons[key] = (skippedReasons[key] ?: 0) + 1
            }
        }
        // 只打印少量原因，避免刷爆 logcat
        val top = skippedReasons.entries.sortedByDescending { it.value }.take(3)
        for ((reason, n) in top) android.util.Log.w("TermuxRuntime", "symlink skip x$n: $reason")
        android.util.Log.i("TermuxRuntime", "symlinks ok=$ok skipped=$skipped")
    }

    /**
     * 在 dataDir 根创建短前缀符号链接 `t`：
     * 官方二进制把 `/data/data/com.termux/files/usr`（31 字符）编译死，
     * 无法原地替换成更长的真实 prefix；这里用等长的短路径
     * `/data/user/0/com.dsh.launcher/t`（31 字符）映射到真实目录，
     * 使所有 ELF/脚本里的硬编码路径无需改变长度即可 patch。
     */
    private fun createPrefixShortcut(context: Context) {
        try {
            val target = prefix(context).absolutePath
            val link = File(context.dataDir, "t")
            if (java.nio.file.Files.isSymbolicLink(link.toPath())) {
                val dest = link.canonicalFile.absolutePath
                if (dest == target) return
                link.delete()
            } else if (link.exists()) {
                if (link.isFile) {
                    link.delete()
                } else {
                    android.util.Log.w("TermuxRuntime", "shortcut path exists as dir: ${link.absolutePath}")
                    return
                }
            }
            if (!link.exists()) {
                Files.createSymbolicLink(link.toPath(), Paths.get(target))
                android.util.Log.i("TermuxRuntime", "shortcut created: ${link.absolutePath} -> $target")
            }
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "createPrefixShortcut failed: ${t.message}")
        }
    }

    /**
     * 创建官方文件系统镜像 `data/data/com.termux/files -> files/termux`。
     * dpkg 安装包时使用 `--instdir=<dataDir>`，包内绝对路径
     * `/data/data/com.termux/files/usr/...` 会落到 dataDir 下这个镜像，
     * 经符号链接写入真实 Termux 目录。
     */
    private fun createOfficialMirror(context: Context) {
        try {
            val mirror = File(context.dataDir, "data/data/com.termux/files")
            val target = File(context.filesDir, DIR_NAME).absolutePath
            mirror.parentFile?.mkdirs()
            if (java.nio.file.Files.isSymbolicLink(mirror.toPath())) {
                val dest = mirror.canonicalFile.absolutePath
                if (dest == target) return
                mirror.delete()
            } else if (mirror.exists()) {
                if (mirror.isFile) {
                    mirror.delete()
                } else {
                    android.util.Log.w("TermuxRuntime", "mirror exists as dir: ${mirror.absolutePath}")
                    return
                }
            }
            if (!mirror.exists()) {
                Files.createSymbolicLink(mirror.toPath(), Paths.get(target))
                android.util.Log.i("TermuxRuntime", "mirror created: $mirror -> $target")
            }
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "createOfficialMirror failed: ${t.message}")
        }
    }

    /**
     * 文本脚本/配置中可能还带官方 files 根路径（如 `/data/data/com.termux/files/home`）。
     * 二进制只能等长替换，已由 patchPrefixAll 处理；文本文件可以安全地用镜像长路径替换，
     * 让 profile.d 等脚本通过 dataDir 下的 `data/data/com.termux/files` 符号链接落到真实目录。
     * 只处理不含 NUL 的普通文本文件，避免破坏 ELF/其他二进制。
     */
    private fun patchTextOfficialDirs(usr: File) {
        try {
            val old = "/data/data/com.termux/files"
            val mirror = "/data/user/0/com.dsh.launcher/data/data/com.termux/files"
            var patched = 0
            usr.walkTopDown().forEach { f ->
                if (!f.isFile || java.nio.file.Files.isSymbolicLink(f.toPath())) return@forEach
                try {
                    val bytes = java.nio.file.Files.readAllBytes(f.toPath())
                    if (bytes.any { it == 0.toByte() }) return@forEach
                    val text = String(bytes, Charsets.ISO_8859_1)
                    if (text.contains(old)) {
                        val fixed = text.replace(old, mirror)
                        java.nio.file.Files.write(f.toPath(), fixed.toByteArray(Charsets.ISO_8859_1))
                        patched++
                    }
                } catch (_: Throwable) {
                }
            }
            android.util.Log.i("TermuxRuntime", "patched $patched text files for official files path")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "patchTextOfficialDirs failed: ${t.message}")
        }
    }

    /**
     * 写 apt 的 PREFIX 适配配置：
     * - Cache/State 指到真实的 var/cache/apt（避免官方 cache 路径权限问题）
     * - dpkg 安装时用 `--instdir=<dataDir>` + 上面的官方镜像写入真实目录，
     *   `--admindir` 指到已有的 dpkg 数据库。
     */
    private fun writeAptConfig(context: Context, usr: File) {
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
            android.util.Log.i("TermuxRuntime", "apt config written")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "writeAptConfig failed: ${t.message}")
        }
    }

    /**
     * 给交互式 login shell（TerminalActivity）写 apt/pkg 自动 W^X 切换函数：
     * 在终端里敲 `apt install` 时自动放开 bin/lib/share，命令结束恢复只读。
     * ConsoleActivity 的命令行进程不走 profile，已由应用层自动切换覆盖。
     */
    private fun writeShellAptHelper(usr: File) {
        try {
            val dir = File(usr, "etc/profile.d")
            dir.mkdirs()
            val helper = File(dir, "00-dsh-apt.sh")
            helper.writeText(
                """
                # 内置 Termux：apt/pkg 安装类命令自动放开 W^X，结束后恢复
                __dsh_writable() { chmod -R u+w "${'$'}PREFIX/bin" "${'$'}PREFIX/lib" "${'$'}PREFIX/share" 2>/dev/null || true; }
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
            android.util.Log.i("TermuxRuntime", "shell apt helper written")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "writeShellAptHelper failed: ${t.message}")
        }
    }

    /**
     * 写入 Linux 风格的交互式 shell profile：
     * 彩色 ls / grep、ll/la 等常用别名、EDITOR/PAGER 以及 which 函数，
     * 让内置终端和传统 Linux 终端行为更接近。
     */
    private fun writeLinuxProfile(usr: File) {
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
            android.util.Log.i("TermuxRuntime", "linux shell profile written")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "writeLinuxProfile failed: ${t.message}")
        }
    }

    /** 写 readline 配置，让 bash 在交互终端中的补全/粘贴体验更接近 Linux。 */
    private fun writeInputRc(usr: File) {
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
            android.util.Log.i("TermuxRuntime", "readline inputrc written")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "writeInputRc failed: ${t.message}")
        }
    }

    /**
     * 禁用 Termux 的 second-stage fallback：
     * 官方首次 login 会尝试执行 bootstrap second-stage，但它依赖官方绝对路径
     * `/data/data/com.termux` 且需要可写 bin，在第三方 app 私有目录会失败刷屏。
     * 我们的环境已经通过 apt/镜像适配准备好，直接移除该 fallback，避免每次
     * login 重复报错。
     */
    private fun disableSecondStageFallback(usr: File) {
        try {
            val f = File(usr, "etc/profile.d/01-termux-bootstrap-second-stage-fallback.sh")
            if (f.exists() && !java.nio.file.Files.isSymbolicLink(f.toPath())) {
                f.delete()
                android.util.Log.i("TermuxRuntime", "second-stage fallback disabled")
            }
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "disableSecondStageFallback failed: ${t.message}")
        }
    }

    /**
     * 扫描整个 PREFIX，把所有普通文件中的官方硬编码路径等长替换为短前缀。
     * 覆盖 ELF 二进制、动态库、shell 脚本、pkgconfig、dpkg 清单等，
     * 使 apt/dpkg/bash 等全部通过 `t` 符号链接访问真实目录。
     */
    private fun patchPrefixAll(usr: File) {
        val old = OFFICIAL_PREFIX
        val new = SHORT_PREFIX
        if (old.length != new.length) {
            android.util.Log.e("TermuxRuntime", "prefix patch length mismatch: ${old.length} != ${new.length}")
            return
        }
        var patched = 0
        usr.walkTopDown().forEach { f ->
            if (!f.isFile || java.nio.file.Files.isSymbolicLink(f.toPath())) return@forEach
            try {
                val bytes = java.nio.file.Files.readAllBytes(f.toPath())
                // Latin-1 保证字节级无损，且 old/new 同长，替换后所有其它字节不变
                val text = String(bytes, Charsets.ISO_8859_1)
                if (text.contains(old)) {
                    java.nio.file.Files.write(f.toPath(), text.replace(old, new).toByteArray(Charsets.ISO_8859_1))
                    patched++
                }
            } catch (t: Throwable) {
                // 单个文件失败不影响整体（例如权限/占用）
            }
        }
        android.util.Log.i("TermuxRuntime", "prefix patched files=$patched")
    }

    /** 把官方 `./路径` 或其它相对/绝对引用解析为 [usr] 下的绝对路径；无法解析返回 null。 */
    private fun resolvePrefixRelative(usr: File, raw: String): String? {
        var s = raw.trim()
        if (s.startsWith("./")) s = s.removePrefix("./")
        if (s.isBlank()) return null
        return when {
            s.startsWith("/data/data/com.termux/files/usr") ->
                usr.absolutePath + "/" + s.removePrefix("/data/data/com.termux/files/usr").trimStart('/')
            s.startsWith("/") -> usr.absolutePath + s
            else -> usr.absolutePath + "/" + s
        }
    }

    private fun makeUnwritable(current: File) {
        if (java.nio.file.Files.isSymbolicLink(current.toPath())) return
        if (current.isDirectory) {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
            current.listFiles()?.forEach { makeUnwritable(it) }
        } else {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
        }
    }

    private fun makeWritableRecursive(f: File) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(true, false)
            f.listFiles()?.forEach { makeWritableRecursive(it) }
        } else {
            f.setWritable(true, false)
        }
    }

    private fun setWritableRecursive(f: File, writable: Boolean) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(writable, false)
            f.listFiles()?.forEach { setWritableRecursive(it, writable) }
        } else {
            f.setWritable(writable, false)
        }
    }
}