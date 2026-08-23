package com.dsh.launcher

import android.content.Context
import android.os.PowerManager

/**
 * 后台功耗/存活自适应治理器（双通道共用，主进程单例）。
 *
 * 输入：屏幕状态、dsh 任务态（idle/running/finished）、灭屏持续时长。
 * 输出三类决策：
 *  - 轮询间隔（intervalMs）
 *  - 是否需要 PARTIAL 唤醒锁（仅「灭屏 + 任务运行中」——此时 CPU 休眠会直接
 *    拖慢/打断正在生成的任务，代价换体验是值的；空闲待机绝不持有）；
 *  - 看门狗闹钟是否允许唤醒设备（任务运行中或刚灭屏 5 分钟内允许，
 *    长时空闲转非唤醒，不再周期性把设备从深睡里揍醒）。
 *
 * 屏幕状态由两个轮询线程每轮调用 [setScreen] 幂等刷新，无需广播接收器。
 */
object PowerGovernor {

    const val ACTIVE_MS = 1_000L            // 亮屏：实时性优先
    const val RUNNING_BG_MS = 3_000L        // 灭屏 + 任务运行：保完成提醒及时性
    const val IDLE_BG_FRESH_MS = 10_000L    // 灭屏 + 空闲 < 10 分钟
    const val IDLE_BG_SETTLED_MS = 30_000L  // 灭屏 + 空闲 ≥ 10 分钟（逐步放宽）

    private const val SETTLE_MS = 10 * 60_000L

    @Volatile var screenInteractive = true
        private set

    @Volatile private var screenOffAt = 0L
    @Volatile private var lastStatus: String? = null

    /** 每轮轮询刷新；内部去重，幂等。 */
    fun setScreen(interactive: Boolean) {
        if (interactive == screenInteractive) return
        screenInteractive = interactive
        screenOffAt = if (!interactive) System.currentTimeMillis() else 0L
    }

    fun setTaskStatus(status: String?) {
        lastStatus = status
    }

    fun isTaskRunning(): Boolean = lastStatus == "running"

    /** 灭屏已持续时长（亮屏时为 0）。 */
    fun backgroundAgeMs(): Long =
        if (screenInteractive || screenOffAt <= 0L) 0L
        else System.currentTimeMillis() - screenOffAt

    /** 「灭屏 + 任务运行中」→ 需要 PARTIAL 唤醒锁保住任务。 */
    fun wantWakeLock(): Boolean = !screenInteractive && isTaskRunning()

    /** 关键窗口期看门狗才允许唤醒设备：任务运行中，或刚灭屏不久。 */
    fun wantWakeupAlarm(): Boolean =
        !screenInteractive && (isTaskRunning() || backgroundAgeMs() < 5 * 60_000L)

    fun intervalMs(): Long = when {
        screenInteractive -> ACTIVE_MS
        isTaskRunning() -> RUNNING_BG_MS
        backgroundAgeMs() < SETTLE_MS -> IDLE_BG_FRESH_MS
        else -> IDLE_BG_SETTLED_MS
    }

    /** 便捷读取交互状态（轮询线程每轮调用）。 */
    fun refreshScreenState(context: Context) {
        val interactive = try {
            (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive ?: true
        } catch (_: Exception) {
            true
        }
        setScreen(interactive)
    }
}
