package com.dsh.launcher.core

import android.content.Context
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

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
    private const val TPKG_ASSET = "tpkg.sh"
    private const val MARKER = ".termux-ok"
    private const val MARKER_VERSION = "6"
    private const val TOOLS_MARKER = ".harness-tools-ok"
    private const val TOOLS_MARKER_VERSION = "4"
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

    /** termux-exec 的 LD_PRELOAD 库路径；未安装返回 null（调用方据此决定是否注入环境）。 */
    fun ldPreloadPath(context: Context): String? =
        File(prefix(context), "lib/libtermux-exec-ld-preload.so")
            .takeIf { it.isFile }?.absolutePath

    fun isBashReady(context: Context): Boolean = bashPath(context).isFile

    /** Harness 附加工具（git/rg/file/curl/less）是否已安装就绪。 */
    fun harnessToolsReady(context: Context): Boolean = runCatching {
        File(context.filesDir, TOOLS_MARKER).readText().trim() == TOOLS_MARKER_VERSION
    }.getOrDefault(false)

    /**
     * 确保内置 Termux 具备 dsh 与交互式终端所需工具：
     * git / ripgrep / file / curl / less（wget 作为可选补充）。
     * 一次 pkg 调用补齐缺失项，安装后统一 patch 官方路径并完成 dpkg 配置；
     * 网络不可用或安装失败时返回 false，不破坏已有 Termux 环境。
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
            progress("检查 Harness 工具（git / ripgrep / file / curl / less）…")
            val requiredCheck = "command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 && command -v rg >/dev/null 2>&1 && rg --version >/dev/null 2>&1 && command -v file >/dev/null 2>&1 && file --version >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && curl --version >/dev/null 2>&1 && command -v less >/dev/null 2>&1 && less --version >/dev/null 2>&1"
            if (runBash(bash, requiredCheck, env, progress, timeoutSec = 120) == 0) {
                marker.writeText(TOOLS_MARKER_VERSION)
                progress("Harness 工具已就绪（git / ripgrep / file / curl / less）")
                return true
            }
            progress("补齐 Harness 工具（git / ripgrep / file / curl / less / wget / termux-exec，单次 pkg 完成）…")
            // v4.6：默认放开 W^X 且不再恢复 —— dpkg 解包/postinst/pip 均需可写前缀；
            // 这里同时兜底升级设备上遗留的只读状态
            setRuntimeWritable(context, true)
            try {
                val missing = buildList {
                    if (!File(usr, "bin/git").isFile) add("git")
                    if (!File(usr, "bin/rg").isFile) add("ripgrep")
                    if (!File(usr, "bin/file").isFile) add("file")
                    if (!File(usr, "bin/curl").isFile) add("curl")
                    if (!File(usr, "bin/less").isFile) add("less")
                    if (!File(usr, "bin/wget").isFile) add("wget")
                    // 运行时翻译脚本 shebang 的官方前缀（postinst/pip 入口依赖）
                    if (!File(usr, "lib/libtermux-exec-ld-preload.so").isFile) add("termux-exec")
                }
                val installRc = if (missing.isNotEmpty()) {
                    runBash(bash, "pkg install -o Acquire::Retries=3 -y --no-install-recommends ${missing.joinToString(" ")}", env, progress, timeoutSec = 1200)
                } else {
                    0
                }
                if (installRc != 0) {
                    // dpkg 解包在搬迁前缀下必然失败（官方 deb 路径写死 com.termux），
                    // 自动兜底走 tpkg 手动解包（dpkg-deb -x + status 同步 + shebang 修正）
                    progress("WARN: pkg install 返回 $installRc，尝试 tpkg 手动解包兜底…")
                    writeTpkgScript(context, usr)
                    runBash(
                        bash,
                        "\"$usr/local/bin/tpkg\" install ${missing.joinToString(" ")}",
                        env, progress, timeoutSec = 1200
                    )
                }

                // 新装的包（二进制 + maintainer 脚本）仍带官方路径；先统一 patch，
                // 再让 dpkg 重新 configure，避免 postinst 走官方 shebang 失败。
                progress("适配新装包路径并完成 dpkg 配置…")
                patchPrefixAll(usr)
                patchTextOfficialDirs(usr)
                val cfgRc = runBash(bash, "dpkg --configure -a", env, progress, timeoutSec = 600)
                if (cfgRc != 0) {
                    progress("WARN: dpkg --configure -a 返回 $cfgRc，再试 apt-get -f install…")
                    runBash(bash, "apt-get install -o Acquire::Retries=3 -y -f --no-install-recommends", env, progress, timeoutSec = 1200)
                }

                val ready = runBash(bash, requiredCheck, env, progress, timeoutSec = 120) == 0
                val extra = buildList {
                    add("git")
                    add("ripgrep")
                    add("file")
                    add("curl")
                    add("less")
                    if (File(usr, "bin/wget").isFile) add("wget")
                }.joinToString(" + ")
                if (ready) {
                    marker.writeText(TOOLS_MARKER_VERSION)
                    progress("Harness 工具就绪（$extra）")
                } else {
                    progress("WARN: Harness 工具未完全就绪（$extra），保留 marker 下次重试")
                }
                return ready
            } finally {
                // v4.6：保持可写（不再恢复只读），原因见 ensureExtracted 内 W^X 注释
                setRuntimeWritable(context, true)
            }
        } catch (t: Throwable) {
            progress("WARN: ensureHarnessTools 失败: ${t.message}")
            return false
        }
    }

    /**
     * 执行 bash 命令并流式回传输出。
     * [timeoutSec] 到期后强制结束进程并返回 -124，避免网络卡死时安装流程永远挂起。
     */
    private fun runBash(
        bash: String,
        script: String,
        env: Map<String, String>,
        progress: (String) -> Unit,
        timeoutSec: Long = 900L,
    ): Int = try {
        val pb = ProcessBuilder(bash, "-c", script)
        pb.redirectErrorStream(true)
        // 可写工作目录：避免应用默认 cwd=/ 导致子命令相对路径 EACCES
        env["HOME"]?.let { h -> pb.directory(File(h).apply { mkdirs() }) }
        val e = pb.environment()
        env.forEach { (k, v) -> e[k] = v }
        e.remove("LD_PRELOAD")
        val p = pb.start()
        // 输出在独立线程消费：waitFor(timeout) 期间管道持续排空，不会因缓冲区满而卡死子进程
        val stopped = java.util.concurrent.atomic.AtomicBoolean(false)
        val reader = Thread {
            try {
                p.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (stopped.get()) break
                        progress(line)
                    }
                }
            } catch (_: Throwable) {
            }
        }
        reader.isDaemon = true
        reader.start()
        val done = p.waitFor(timeoutSec, java.util.concurrent.TimeUnit.SECONDS)
        stopped.set(true)
        if (!done) {
            progress("TIMEOUT: 命令超过 ${timeoutSec}s 未完成，强制结束")
            p.destroy()
            if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
            reader.join(2000)
            -124
        } else {
            reader.join(5000)
            p.exitValue()
        }
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

            // W^X 策略调整（v4.6）：bin/lib/share 保持可写。
            // 实测（见 docs/python-install-issue-report.md）：只读锁会阻断 dpkg 解包与
            // postinst/pip 落盘，是 apt 安装失败的根因之一；exec 安全由 targetSdk=28
            // 豁免保证。如需临时收紧可调用 [setRuntimeWritable](writable=false)。

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
            val dataDir = usr.parentFile?.parentFile?.parentFile?.absolutePath
                ?: throw IllegalStateException("invalid usr path: $usr")
            val oldFiles = "/data/data/com.termux/files"
            val mirFiles = "$dataDir/data/data/com.termux/files"
            val oldAptCache = "/data/data/com.termux/cache/apt"
            val newAptCache = "${usr.absolutePath}/var/cache/apt"
            // oldFiles 恰好是 mirFiles 的后缀，直接 replace 会二次替换导致路径损坏；
            // 用一次性 token 把已 patch 好的路径保护起来，保证幂等。
            val token = "@@DSH_MIRROR_FILES@@"
            var patched = 0
            usr.walkTopDown().forEach { f ->
                if (!f.isFile || java.nio.file.Files.isSymbolicLink(f.toPath())) return@forEach
                try {
                    val bytes = java.nio.file.Files.readAllBytes(f.toPath())
                    if (bytes.any { it == 0.toByte() }) return@forEach
                    var text = String(bytes, Charsets.ISO_8859_1)
                    var changed = false
                    if (text.contains(mirFiles)) {
                        text = text.replace(mirFiles, token).replace(oldFiles, mirFiles).replace(token, mirFiles)
                        changed = true
                    } else if (text.contains(oldFiles)) {
                        text = text.replace(oldFiles, mirFiles)
                        changed = true
                    }
                    if (text.contains(oldAptCache)) {
                        text = text.replace(oldAptCache, newAptCache)
                        changed = true
                    }
                    if (changed) {
                        java.nio.file.Files.write(f.toPath(), text.toByteArray(Charsets.ISO_8859_1))
                        patched++
                    }
                } catch (_: Throwable) {
                }
            }
            android.util.Log.i("TermuxRuntime", "patched $patched text files for official paths")
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
     * 安装 tpkg 到 $PREFIX/local/bin：搬迁前缀环境下的 deb 手动安装器
     * （dpkg-deb -x + status 同步 + shebang 修正，见 assets/tpkg.sh）。
     * 原生 apt 在 W^X 放开 + termux-exec 下已可正常工作（v4.6），
     * tpkg 仅作为 ensureHarnessTools 的安装失败兜底保留。
     */
    private fun writeTpkgScript(context: Context, usr: File) {
        try {
            val dst = File(usr, "local/bin/tpkg")
            dst.parentFile?.mkdirs()
            context.assets.open(TPKG_ASSET).use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
            dst.setExecutable(true, false)
            android.util.Log.i("TermuxRuntime", "tpkg installed")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "writeTpkgScript failed: ${t.message}")
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