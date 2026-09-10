package com.dsh.launcher.core

import android.content.Context
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.File
import java.io.InputStream
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * 内置 Node 运行时：从 assets 解压 Termux Node (aarch64, bionic) 到应用私有目录。
 * 供嵌入式终端以正确 LD_LIBRARY_PATH 运行。
 *
 * 说明：
 * 1) AGP 对 .gz 后缀 asset 做 noCompress 处理，APK 中可能以 `xxx.tar` 或 `xxx.tar.gz`
 *    命名，且内容可能是明文 tar 或 gzip 流。这里对两种名称和两种格式都自适应。
 * 2) Termux 打包的 tar 内文件权限为 700（owner 可写）。Android 10+ 的 W^X 策略
 *    （写执行互斥）禁止 exec 可写文件，因此解压后需递归取消写权限、保留可读可执行。
 */
object NodeRuntime {

    private val ASSETS = arrayOf(
        "node/termux-node-aarch64.tar",   // AGP noCompress 重命名后的常见形式
        "node/termux-node-aarch64.tar.gz" // 原始打包名
    )
    private const val DIR = "node"
    private const val TAG_NODE = "NodeRuntime"

    @Synchronized
    fun ensureExtracted(context: Context): File {
        val dir = File(context.filesDir, DIR)
        // marker 命中还不够：bin/node 必须真实存在（文件被清理/误删后自动重解压，
        // 而不是让下游 install-dsh.mjs 以含混的 node: not found 失败）。
        if (MarkerStore.has(context, "node") && File(dir, "bin/node").isFile) return dir

        dir.mkdirs()
        // 清理历史残留：旧版本/异常中断可能留下只读目录（W^X 取消写权限）
        // 导致后续覆写 EACCES。先递归恢复可写，再清空，保证全新解压。
        cleanupDir(dir)
        var opened = false
        // 白名单基准取 **dataDir** 而非 filesDir：短前缀链接
        // `<dataDir>/t -> <filesDir>/termux/usr` 与官方镜像 `<dataDir>/data/data/...`
        // 都建在应用数据根上。若只放行 filesDir，指向自身运行时的合法绝对链接会被
        // 误拒——这正是参考实现坑 45 记录的事故形态（9 个 applet 被静默丢弃）。
        val appRoot = context.dataDir
        try {
            val stream = openAsset(context)  // 已去除 gzip 头
            opened = true
            stream.use { raw -> extractTar(dir, raw, appRoot) }
            // 兼容“外层 tar 包着真实 node tar”的资产：资产里只有一个 *.tar 时，
            // 把它再解包一次，得到 bin/ lib/ 等真实运行时目录。
            if (!File(dir, "bin/node").isFile) {
                val nested = dir.listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".tar") }
                if (nested != null) {
                    java.io.FileInputStream(nested).use { extractTar(dir, it, appRoot) }
                    nested.delete()
                }
            }
            // 目录视为可搜索即可（无需可写）
            dir.setReadable(true, false)
            dir.setExecutable(true, false)
            // Android W^X：被 exec 的文件/目录必须对进程不可写
            makeUnwritable(dir)
            // tmp 目录需要保持可写（node 运行时 TMPDIR）
            File(dir, "tmp").apply {
                mkdirs()
                setWritable(true, false)
                setReadable(true, false)
                setExecutable(true, false)
            }
            MarkerStore.put(context, "node", "ok")
        } catch (t: Throwable) {
            runCatching { dir.deleteRecursively() }
            runCatching { MarkerStore.remove(context, "node") }
            throw t
        }
        return dir
    }

    /**
     * 把 tar 流解压到 dir；处理目录、符号链接与 W^X 可执行位。
     *
     * @param appRoot 本应用数据目录——符号链接的**绝对**目标必须落在其内才放行
     *   （见 [SymlinkPolicy]；对齐参考实现坑 45 的白名单语义）。
     */
    private fun extractTar(dir: File, raw: InputStream, appRoot: File) {
        var rejected = 0
        TarArchiveInputStream(raw).use { tar ->
            var e: TarArchiveEntry? = tar.nextEntry
            while (e != null) {
                val name = e.name.removePrefix("./").removePrefix("/") // 防路径穿越
                // 显式拒绝穿越段与绝对路径（与 install-dsh.mjs untarWithPrefix 对齐）
                if (name.isEmpty() || name.contains("..") || name.startsWith("/")) {
                    e = tar.nextEntry
                    continue
                }
                val out = File(dir, name)
                if (e.isDirectory) {
                    out.mkdirs()
                } else if (e.isSymbolicLink) {
                    // Termux 包大量使用符号链接（libcrypto.so -> libcrypto.so.3）。
                    // 必须真实创建符号链接，否则会写成 0 字节空文件导致动态库加载失败。
                    // 目标白名单：既拒绝逃逸（../../、/data/data/com.termux/...），
                    // 也放行合法的「指向本应用运行时根」绝对链接（坑 45 的 9 个 applet）。
                    when (val d = SymlinkPolicy.classify(
                        linkPath = out.absolutePath,
                        target = e.linkName ?: "",
                        extractRoot = dir.absolutePath,
                        appRoot = appRoot.absolutePath,
                    )) {
                        is SymlinkPolicy.Decision.Allow -> {
                            out.parentFile?.mkdirs()
                            createSymlink(out, e.linkName!!)
                        }
                        is SymlinkPolicy.Decision.Reject -> {
                            rejected++
                            AppLog.i(TAG_NODE, "symlink rejected: $name -> ${e.linkName}（${d.reason}）")
                        }
                    }
                } else {
                    out.parentFile?.mkdirs()
                    val fos = java.io.FileOutputStream(out)
                    try {
                        val buf = ByteArray(64 * 1024)
                        var n: Int
                        while (tar.read(buf).also { n = it } != -1) {
                            fos.write(buf, 0, n)
                        }
                    } finally { fos.close() }
                    out.setExecutable(true)
                }
                e = tar.nextEntry
            }
        }
        // 拒绝计数上报：这是**外部输入被拦截**的信号，静默会掩盖归档损坏或被篡改
        if (rejected > 0) {
            AppLog.i(TAG_NODE, "symlink policy rejected $rejected entries（越界目标，可能是归档损坏）")
        }
    }


    /**
     * 打开 asset 并返回可直接交给 TarArchiveInputStream 的流。
     * 自适应名称（.tar / .tar.gz）与格式（明文 tar / gzip）。
     */
    private fun openAsset(context: Context): InputStream {
        var lastErr: Exception? = null
        for (name in ASSETS) {
            try {
                val raw = context.assets.open(name)
                val probe = java.io.PushbackInputStream(raw, 2)
                val a = probe.read(); val b = probe.read()
                if (a >= 0) probe.unread(a)
                if (b >= 0) probe.unread(b)
                // 检测 gzip 魔数 0x1f 0x8b
                if (a == 0x1f && b == 0x8b) {
                    return GzipCompressorInputStream(probe)
                }
                return probe
            } catch (e: Exception) {
                lastErr = e
            }
        }
        throw RuntimeException("无法加载 Node 运行时 asset", lastErr)
    }

    /** 递归取消写权限，满足 Android W^X：保留父目录可读可执行、文件可读可执行。 */
    private fun makeUnwritable(current: File) {
        // 跳过符号链接：只操作真实文件/目录，避免跟随链接修改到链接目标或外部文件
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

    /**
     * 创建符号链接。
     *
     * 调用方须先经 [SymlinkPolicy] 放行（目标越界不得走到这里）。创建本身仍可能失败
     * （FUSE/ROM 限制），此时退化为空文件以免中断整体解压——但**必须留日志**：
     * 空文件替换动态库链接会导致后续 `CANNOT LINK ... library not found` 这类
     * 与根因相距甚远的报错（参考实现坑 22 的同族现象）。
     */
    private fun createSymlink(link: File, target: String) {
        try {
            if (link.exists()) link.delete()
            java.nio.file.Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target))
        } catch (t: Throwable) {
            AppLog.i(TAG_NODE, "createSymbolicLink failed (${link.name} -> $target): ${t.message}；退化为空文件")
            runCatching { link.createNewFile() }
        }
    }

    /**
     * 清理历史残留：先递归恢复写权限（覆盖 W^X 造成的只读目录），再删除全部内容，
     * 使后续解压能在全新可写目录上进行，避免 EACCES。
     */
    private fun cleanupDir(dir: File) {
        if (!dir.exists()) return
        makeWritableRecursive(dir)
        dir.deleteRecursively()
        dir.mkdirs()
    }

    /** 递归恢复所有条目为可写（用于解压前清理）。 */
    private fun makeWritableRecursive(f: File) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(true, false)
            f.listFiles()?.forEach { makeWritableRecursive(it) }
        } else {
            f.setWritable(true, false)
        }
    }

    /**
     * [nodeEnvPrefix 已退役]（review-r4）。
     * 此前在本文件私拼 5 个环境变量字面量（LD_LIBRARY_PATH/HOME/TMPDIR/OPENSSL_CONF/TERM），
     * 与 TermuxEnv.childShellEnv 构成双套环境源——HOME 两处不一致（node 目录 vs termux home），
     * 命令串内 export 会覆盖 Proc 注入的统一环境。现唯一环境源 = TermuxEnv（经 Proc 注入）：
     * LD_LIBRARY_PATH 已含 node/lib，node 可直接执行，无需前缀。
     */
}
