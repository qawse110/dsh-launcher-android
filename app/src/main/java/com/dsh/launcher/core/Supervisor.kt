package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 保活/拉起监督器（架构方案 P1-5）。
 *
 * 单点持有「期望运行态」与 web 拉起动作：
 * - 期望态写入/读取统一走 [desiredRunning]/[setDesiredRunning]
 *   （此前分散在 BuildKeepAliveService / MainActivity / DshWatchdog 三处）；
 * - 拉起统一走 [reviveWebIfDue]（冷却内建），watchdog 与 alarm 触发器退化为事件源。
 */
object Supervisor {

    private const val KEY_RUNNING = "running"
    private const val KEY_LAST_REVIVE = "watchdog_last_revive"
    private const val COOLDOWN_MS = 60_000L
    private const val TAG = "Supervisor"

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(AppState.Prefs.KEEPALIVE, Context.MODE_PRIVATE)

    /** 用户是否期望 dsh web 处于运行状态（启动过且未显式停止）。 */
    fun desiredRunning(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_RUNNING, false)

    /** 更新期望运行态（停止 dsh 服务时置 false，成功拉起后置 true）。 */
    fun setDesiredRunning(ctx: Context, running: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_RUNNING, running).apply()
    }

    /**
     * 若期望运行且冷却到期，用复用的 dsh-web.sh 拉起 web。
     * 幂等：多路触发可安全并发调用，先到者占住冷却时间戳。
     *
     * @return 是否实际执行了拉起动作（不含是否拉起成功——脚本异步生效）
     */
    @Synchronized
    fun reviveWebIfDue(ctx: Context): Boolean {
        if (!desiredRunning(ctx)) return false
        val now = System.currentTimeMillis()
        val last = prefs(ctx).getLong(KEY_LAST_REVIVE, 0L)
        if (now - last < COOLDOWN_MS) return false
        prefs(ctx).edit().putLong(KEY_LAST_REVIVE, now).apply() // 先占位，防并发双拉

        val script = File(ctx.getExternalFilesDir(null), "dsh-web.sh")
        if (!script.exists() || !script.canRead()) {
            AppLog.i(TAG, "revive: 启动脚本缺失（${script.absolutePath}），跳过")
            return false
        }
        val bash = TermuxRuntime.bashPath(ctx)
        if (!bash.isFile) {
            AppLog.i(TAG, "revive: 内置 Termux 未就绪，跳过本次拉起")
            return false
        }
        return try {
            val p = ProcessBuilder(bash.absolutePath, script.absolutePath)
                .redirectErrorStream(true)
                .start()
            // 抛掉输出流防阻塞，让拉起动作异步完成
            Thread { try { p.inputStream.readBytes() } catch (_: Exception) {} }.start()
            AppLog.i(TAG, "revive: 已拉起 dsh web（${script.absolutePath}）")
            true
        } catch (t: Throwable) {
            AppLog.i(TAG, "revive: 拉起失败 ${t.message}")
            false
        }
    }
}
