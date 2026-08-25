package com.dsh.launcher.core

import android.content.Context
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths

/**
 * bootstrap 安装器：从 assets 解压官方 Termux bootstrap 到应用私有目录，
 * 建立短前缀符号链接与官方路径镜像，并完成首轮前缀 patch 与配置写入。
 *
 * 架构方案 P1-3：由 [TermuxRuntime] 门面委托；本对象不对外直接使用。
 */
internal object BootstrapInstaller {

    private const val ASSET = "termux-bootstrap.zip"
    private const val MARKER_VERSION = "6"

    fun isMarked(context: Context): Boolean =
        MarkerStore.get(context, "termux") == MARKER_VERSION

    /**
     * 解压并准备 Termux 环境（同步，可能耗时 10~60 秒）。
     * [progress] 在 UI/后台线程安全时由调用方决定如何显示。
     */
    @Synchronized
    fun ensure(context: Context, progress: (String) -> Unit = {}): File {
        if (isMarked(context)) return TermuxRuntime.prefix(context)
        val usr = TermuxRuntime.prefix(context)
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
            progress("适配 Termux 官方硬编码路径（${PrefixPatcher.OFFICIAL_PREFIX} → ${PrefixPatcher.SHORT_PREFIX}）…")
            PrefixPatcher.patchAll(usr)
            PrefixPatcher.patchTextOfficialDirs(usr)
            ProfileWriter.writeAll(context, usr)

            // 可写业务目录：home / tmp / var（apt/dpkg 需要 var 可写）
            TermuxRuntime.home(context).mkdirs()
            TermuxRuntime.tmp(context).mkdirs()
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

            MarkerStore.put(context, "termux", MARKER_VERSION)
            progress("Termux 环境就绪（$usr）")
            cache.delete()
            return usr
        } catch (t: Throwable) {
            runCatching { cache.delete() }
            runCatching { usr.deleteRecursively() }
            runCatching { MarkerStore.remove(context, "termux") }
            throw t
        }
    }

    /** 调整 bin/lib/share 是否可写（v4.6 起默认保持可写，此函数保留给需要临时收紧的场景）。 */
    fun setRuntimeWritable(context: Context, writable: Boolean) {
        val usr = TermuxRuntime.prefix(context)
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
        val skippedReasons = mutableMapOf<String, Int>()
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
                if (linkFile.isDirectory && !Files.isSymbolicLink(linkFile.toPath())) {
                    // 源路径与真实目录冲突：不能删除目录，跳过（dsh/node 下的目录不动）
                    skipped++
                    continue
                }
                // 对 dangling symlink 必须用 NIO deleteIfExists（File.exists() 对断链返回 false）
                Files.deleteIfExists(linkFile.toPath())
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
            val target = TermuxRuntime.prefix(context).absolutePath
            val link = File(context.dataDir, "t")
            if (Files.isSymbolicLink(link.toPath())) {
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
            val target = File(context.filesDir, "termux").absolutePath
            mirror.parentFile?.mkdirs()
            if (Files.isSymbolicLink(mirror.toPath())) {
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

    private fun makeWritableRecursive(f: File) {
        if (Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(true, false)
            f.listFiles()?.forEach { makeWritableRecursive(it) }
        } else {
            f.setWritable(true, false)
        }
    }

    private fun setWritableRecursive(f: File, writable: Boolean) {
        if (Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(writable, false)
            f.listFiles()?.forEach { setWritableRecursive(it, writable) }
        } else {
            f.setWritable(writable, false)
        }
    }
}
