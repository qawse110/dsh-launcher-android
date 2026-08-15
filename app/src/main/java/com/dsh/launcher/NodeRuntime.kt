package com.dsh.launcher

import android.content.Context
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.File
import java.io.InputStream

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

    @Synchronized
    fun ensureExtracted(context: Context): File {
        val dir = File(context.filesDir, DIR)
        val marker = File(context.filesDir, ".node-ok")
        if (marker.exists()) return dir

        dir.mkdirs()
        // 清理历史残留：旧版本/异常中断可能留下只读目录（W^X 取消写权限）
        // 导致后续覆写 EACCES。先递归恢复可写，再清空，保证全新解压。
        cleanupDir(dir)
        var opened = false
        try {
            val stream = openAsset(context)  // 已去除 gzip 头
            opened = true
                stream.use { raw ->
                    TarArchiveInputStream(raw).use { tar ->
                        var e: TarArchiveEntry? = tar.nextEntry
                        while (e != null) {
                            val name = e.name.removePrefix("./").removePrefix("/") // 防路径穿越
                            val out = File(dir, name)
                            if (e.isDirectory) {
                                out.mkdirs()
                            } else if (e.isSymbolicLink) {
                                // Termux 包大量使用符号链接（libcrypto.so -> libcrypto.so.3）。
                                // 必须真实创建符号链接，否则会写成 0 字节空文件导致动态库加载失败。
                                out.parentFile?.mkdirs()
                                createSymlink(out, e.linkName)
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
                }
            // 目录视为可搜索即可（无需可写）
            dir.setReadable(true, false)
            dir.setExecutable(true, false)
            // Android W^X：被 exec 的文件/目录必须对进程不可写
            makeUnwritable(dir, dir)
            // tmp 目录需要保持可写（node 运行时 TMPDIR）
            File(dir, "tmp").apply {
                mkdirs()
                setWritable(true, false)
                setReadable(true, false)
                setExecutable(true, false)
            }
            marker.writeText("ok")
        } catch (t: Throwable) {
            runCatching { dir.deleteRecursively() }
            runCatching { marker.delete() }
            throw t
        }
        return dir
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
    private fun makeUnwritable(base: File, current: File) {
        // 跳过符号链接：只操作真实文件/目录，避免跟随链接修改到链接目标或外部文件
        if (java.nio.file.Files.isSymbolicLink(current.toPath())) return
        if (current.isDirectory) {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
            current.listFiles()?.forEach { makeUnwritable(base, it) }
        } else {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
        }
    }

    /** 创建符号链接；若失败（如目标相对且超界）则退化为空文件避免中断，由启动阶段兜底。 */
    private fun createSymlink(link: File, target: String) {
        try {
            if (link.exists()) link.delete()
            java.nio.file.Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target))
        } catch (t: Throwable) {
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

    /** 返回在嵌入式终端中运行 node 的命令前缀（含 LD_LIBRARY_PATH）。 */
    fun nodeEnvPrefix(context: Context): String {
        val dir = ensureExtracted(context).absolutePath
        return "export LD_LIBRARY_PATH=$dir/lib; export HOME=$dir; export TMPDIR=$dir/tmp; " +
            "OPENSSL_CONF=/dev/null; TERM=xterm-256color "
    }
}
