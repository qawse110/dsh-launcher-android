package com.dsh.launcher.core

import android.content.Context
import java.io.File
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh web（127.0.0.1:3080）健康 watchdog：
 * 状态桥接 / 无障碍保活 两路轮询线程发现端口不通时自动拉起 dsh web，
 * 60 秒冷却防死循环。dsh 进程被系统杀掉后秒级发现、自动自愈，网络不中断。
 *
 * 生命周期与悬浮窗/无障碍通道解耦：这里只负责"拉起"，不负责"停止"，
 * 停止仍由用户在主界面显式操作。
 */
object DshWatchdog {

    private const val TAG = "DshWatchdog"
    private const val COOLDOWN_MS = 60_000L
    private const val PREFS = "dsh_keepalive"
    private const val KEY_LAST_REVIVE = "watchdog_last_revive"

    /** dsh web 端口是否可访问。 */
    fun isUp(): Boolean = try {
        val conn = java.net.URL("http://127.0.0.1:3080/").openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 800
        conn.readTimeout = 800
        conn.requestMethod = "GET"
        val ok = conn.responseCode in 200..399
        conn.disconnect()
        ok
    } catch (e: Exception) {
        false
    }

    /**
     * 端口不通且冷却到期时拉起 dsh web。
     * 幂等：多路轮询（两 service）可安全并发调用，先到者占住冷却时间戳。
     * 仅当用户期望 dsh 运行（主界面启动过、且未显式停止）时才会拉起——
     * 用户点「停止 dsh 服务」后不会复活。
     */
    fun maybeRevive(context: Context) {
        if (isUp()) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // 用户未启动过 dsh 或已显式停止：不拉起
        if (!prefs.getBoolean("running", false)) return
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_LAST_REVIVE, 0L) < COOLDOWN_MS) return
        prefs.edit().putLong(KEY_LAST_REVIVE, now).apply() // 先占位，防并发双拉

        // 复用 ConsoleActivity 生成的启动脚本（应用专属外部目录，无需存储权限）
        val script = File(context.getExternalFilesDir(null), "dsh-web.sh")
        if (!script.exists() || !script.canRead()) {
            AppLog.i(TAG, "watchdog: 启动脚本缺失（${script.absolutePath}），跳过拉起")
            return
        }
        try {
            // v4.5 唯一解释器：内置 Termux bash（与 DshFlow.startDshWeb 一致）；
            // 未就绪则跳过本次拉起，下个冷却周期重试（exec/startDshWeb 会自动准备）
            val bash = TermuxRuntime.bashPath(context)
            if (!bash.isFile) {
                AppLog.i(TAG, "watchdog: 内置 Termux 未就绪，跳过本次拉起")
                return
            }
            val p = ProcessBuilder(bash.absolutePath, script.absolutePath)
                .redirectErrorStream(true)
                .start()
            // 抛掉输出流防阻塞，让拉起动作异步完成
            Thread {
                try {
                    p.inputStream.readBytes()
                } catch (_: Exception) {
                }
            }.start()
            AppLog.i(TAG, "watchdog: 已拉起 dsh web（${script.absolutePath}）")
        } catch (t: Throwable) {
            AppLog.i(TAG, "watchdog: 拉起失败 ${t.message}")
        }
    }
}