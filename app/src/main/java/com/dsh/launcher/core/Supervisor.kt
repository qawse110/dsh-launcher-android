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
    private const val KEY_FAIL_STREAK = "watchdog_fail_streak"
    private const val COOLDOWN_MS = 60_000L
    /** 连续拉起无效的退避上限（30 分钟）。 */
    private const val MAX_BACKOFF_MS = 30L * 60 * 1000
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
     * 失败退避：连续拉起后 web 仍不可达时冷却指数增长（60s→2m→8m→30m 封顶），
     * 避免「安装损坏 → watchdog 每分钟空拉必败进程」的耗电与日志刷屏；
     * web 恢复可达后由 [noteWebUp] 归零。
     *
     * @return 是否实际执行了拉起动作（不含是否拉起成功——脚本异步生效）
     */
    @Synchronized
    fun reviveWebIfDue(ctx: Context): Boolean {
        if (!desiredRunning(ctx)) return false
        val now = System.currentTimeMillis()
        val last = prefs(ctx).getLong(KEY_LAST_REVIVE, 0L)
        val cooldown = currentCooldown(ctx)
        if (now - last < cooldown) return false
        prefs(ctx).edit().putLong(KEY_LAST_REVIVE, now).apply() // 先占位，防并发双拉

        val script = DshFlow.webLauncherFile(ctx)
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
            // 拉起已执行但结果未知：记一次「待验证」；下次 revive 前若 isUp 则归零
            bumpFailStreak(ctx)
            AppLog.i(TAG, "revive: 已拉起 dsh web（${script.absolutePath}，streak=${failStreak(ctx)}）")
            true
        } catch (t: Throwable) {
            AppLog.i(TAG, "revive: 拉起失败 ${t.message}")
            bumpFailStreak(ctx)
            false
        }
    }

    /** 当前生效冷却：基础 60s，按连续无效拉起次数指数退避（60s→2m→8m→30m 封顶）。 */
    private fun currentCooldown(ctx: Context): Long {
        val streak = failStreak(ctx)
        if (streak <= 0) return COOLDOWN_MS
        val backoff = COOLDOWN_MS * (1L shl minOf(streak, 5))
        return minOf(backoff, MAX_BACKOFF_MS)
    }

    private fun failStreak(ctx: Context): Int = prefs(ctx).getInt(KEY_FAIL_STREAK, 0)

    private fun bumpFailStreak(ctx: Context) {
        prefs(ctx).edit().putInt(KEY_FAIL_STREAK, failStreak(ctx) + 1).apply()
    }

    /** web 探测可达后调用：归零失败计数，恢复基础 60s 冷却。 */
    fun noteWebUp(ctx: Context) {
        if (failStreak(ctx) != 0) prefs(ctx).edit().putInt(KEY_FAIL_STREAK, 0).apply()
    }

    /** 触发崩溃循环自动回滚的连续无效拉起次数阈值（UI 显示用）。 */
    val CRASH_LOOP_ROLLBACK_STREAK_PUBLIC = CRASH_LOOP_ROLLBACK_STREAK

    /** 当前连续无效拉起次数（UI 崩溃循环进度显示用，只读）。 */
    fun failStreakCount(ctx: Context): Int = failStreak(ctx)

    /** 触发崩溃循环自动回滚的连续无效拉起次数（约 32 分钟冷却累计）。 */
    private const val CRASH_LOOP_ROLLBACK_STREAK = 5

    /**
     * 崩溃循环自动回滚判定：期望运行、连续 [CRASH_LOOP_ROLLBACK_STREAK] 次
     * 拉起后 web 仍不可达——判定新版本大概率损坏（启动即崩）。临时窗口内
     * 置回滚 tag 并由调用方重跑安装流程；每窗口最多一次（KEY_AUTO_ROLLED 守卫）。
     *
     * @return true=已触发自动回滚（调用方应重跑安装流程）
     */
    fun maybeRollbackOnCrashLoop(ctx: Context, onLog: (String) -> Unit): Boolean {
        if (failStreak(ctx) < CRASH_LOOP_ROLLBACK_STREAK) return false
        if (!desiredRunning(ctx)) return false
        // 安装流程进行中不抢跑（流程自身已有安装失败→回滚的两轮逻辑）
        if (DshFlow.isBusy()) return false
        if (!DshUpdater.isTempWindow(ctx)) return false
        // 消费本次判定：无论回滚是否被守卫拦截，都归零退避重试拉起
        noteWebUp(ctx)
        return DshUpdater.maybeAutoRollback(ctx, onLog)
    }
}
