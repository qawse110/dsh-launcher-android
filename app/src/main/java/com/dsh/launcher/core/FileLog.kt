package com.dsh.launcher.core

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 统一文件日志：全部落盘到 files/logs/<name>。
 *
 * - 可读时间戳（MM-dd HH:mm:ss.SSS），替代裸毫秒；
 * - 单文件超过 [MAX_BYTES] 自动轮转（<name>.old，保留一代），杜绝无限增长；
 * - 共享目录导出改为显式单次动作（[exportToShared]），
 *   替代旧的逐行双写 /sdcard（I/O 放大）。
 */
object FileLog {

    private const val MAX_BYTES = 512L * 1024L
    private val ts = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    /** 日志目录：files/logs/。 */
    fun dir(ctx: Context): File = File(ctx.filesDir, "logs").apply { mkdirs() }

    /** 追加一行日志（自动时间戳 + 轮转检查）；任何 I/O 失败静默吞掉，不影响主流程。 */
    @Synchronized
    fun log(ctx: Context, name: String, line: String) {
        try {
            val f = File(dir(ctx), name)
            if (f.length() > MAX_BYTES) rotate(f)
            f.appendText("[${ts.format(Date())}] $line\n")
        } catch (_: Throwable) {
        }
    }

    /** 清空指定日志（新流程开始时调用）。 */
    @Synchronized
    fun reset(ctx: Context, name: String) {
        runCatching { File(dir(ctx), name).delete() }
    }

    /** 读取日志尾部；文件不存在或读取失败返回空列表。 */
    fun tail(ctx: Context, name: String, maxLines: Int): List<String> = runCatching {
        File(dir(ctx), name).readText().trim().lines().takeLast(maxLines)
    }.getOrDefault(emptyList())

    /**
     * 流程结束时一次性导出到共享目录 Download/DshLauncher/logs/<name>，
     * 供文件管理器直接查看；best-effort，无存储权限时静默跳过。
     */
    fun exportToShared(ctx: Context, name: String) {
        runCatching {
            val src = File(dir(ctx), name)
            if (!src.isFile) return
            val dst = File("/sdcard/Download/DshLauncher/logs/$name")
            dst.parentFile?.mkdirs()
            src.copyTo(dst, overwrite = true)
        }
    }

    /** 轮转：当前文件改名 .old（覆盖上一代），下次写入重新开始。 */
    private fun rotate(f: File) {
        runCatching {
            val old = File(f.parentFile, f.name + ".old")
            old.delete()
            f.renameTo(old)
        }
    }
}
