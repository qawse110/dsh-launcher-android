package com.dsh.launcher

import android.content.Context
import java.io.File
import java.io.FileWriter
import java.io.PrintWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 简化文件日志工具：追加写入应用可访问的日志文件。
 *
 * 日志位置（两个都写）：
 * 1) 私有区：filesDir/dsh.log （run-as 一定可读，最可靠）
 * 2) 共享区：/sdcard/Android/data/com.dsh.launcher/files/app.log （文件管理器可见）
 *
 * 配合 UI 日志栏 + logcat，多通道排查问题。
 */
object AppLog {

    private const val TAG = "DshAppLog"
    private const val MAX_SIZE = 512 * 1024 // 超过 512KB 轮转

    @Volatile
    private var privateLog: File? = null
    @Volatile
    private var sharedLog: File? = null

    private val dateFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    /** 在 Application/Activity 首次使用时初始化。 */
    fun init(context: Context) {
        if (privateLog != null) return
        try {
            // 私有区（主通道）
            val privDir = context.filesDir
            privDir.mkdirs()
            privateLog = File(privDir, "dsh.log")

            // 共享区（辅助，可能因权限失败，不影响主通道）
            try {
                val ext = context.getExternalFilesDir(null)
                if (ext != null) {
                    ext.mkdirs()
                    sharedLog = File(ext, "app.log")
                }
            } catch (t: Throwable) {
                android.util.Log.w(TAG, "shared init failed: ${t.message}")
            }

            val path = privateLog?.absolutePath ?: ""
            android.util.Log.i(TAG, "AppLog init OK at $path")
            i(TAG, "AppLog initialized at $path")
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "init failed: ${t.message}")
        }
    }

    fun d(tag: String, msg: String) = write("D", tag, msg)
    fun i(tag: String, msg: String) = write("I", tag, msg)
    fun w(tag: String, msg: String) = write("W", tag, msg)
    fun e(tag: String, msg: String) = write("E", tag, msg)

    private fun write(level: String, tag: String, msg: String) {
        privateLog?.let { writeTo(it, "dsh.log", level, tag, msg) }
        sharedLog?.let { writeTo(it, "app.log", level, tag, msg) }
    }

    private fun writeTo(f: File, baseName: String, level: String, tag: String, msg: String) {
        try {
            // 轮转：超过上限则改名后新建
            if (f.exists() && f.length() > MAX_SIZE) {
                val bak = File(f.parentFile, "$baseName.1")
                runCatching { if (bak.exists()) bak.delete() }
                runCatching { f.renameTo(bak) }
            }
            FileWriter(f, true).use { w ->
                w.append(dateFmt.format(Date()))
                    .append(" [").append(level).append("] [").append(tag).append("] ")
                    .append(msg).append("\n")
            }
        } catch (t: Throwable) {
            // 文件写不进就退到 logcat，不让异常传播
            android.util.Log.d(tag, msg)
        }
    }

    /** 获取日志文件绝对路径（用于界面提示）。 */
    fun logPath(): String = privateLog?.absolutePath ?: sharedLog?.absolutePath ?: ""

    /** 追加一段较大的正文（如命令输出），自动缩进。 */
    fun block(tag: String, title: String, body: String) {
        i(tag, title)
        if (body.isNotBlank()) {
            for (line in body.split("\n")) {
                write("I", tag, "    | " + line)
            }
        }
    }
}