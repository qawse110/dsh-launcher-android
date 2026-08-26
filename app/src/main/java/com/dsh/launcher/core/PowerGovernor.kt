package com.dsh.launcher.core

import android.content.Context
import android.os.PowerManager
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * 后台功耗/存活自适应治理器（双通道共用，主进程单例）。
 *
 * 输入：屏幕状态、dsh 任务态（idle/running/finished）、灭屏持续时长、空闲保活窗配置。
 * 输出三类决策：
 *  - 轮询间隔（intervalMs）
 *  - 是否需要 PARTIAL 唤醒锁（「灭屏 + 任务运行中」全程持有——CPU 休眠会直接打断正在
 *    生成的任务；「灭屏 + 空闲」在用户配置的保活窗内也持有，让 dsh web 在息屏后一段
 *    时间内不被系统冻结/杀死，回来即用。空闲待机超出保活窗绝不持有）；
 *  - 看门狗闹钟是否允许唤醒设备（任务运行中、空闲保活窗内或刚灭屏 5 分钟内允许，
 *    长时空闲转非唤醒，不再周期性把设备从深睡里揍醒）。
 *
 * 屏幕状态由两个轮询线程每轮调用 [setScreen] 幂等刷新，无需广播接收器；
 * 保活窗配置由轮询线程每轮从 prefs 读出后经 [setIdleKeepAliveMinutes] 喂入。
 */
object PowerGovernor {

    const val ACTIVE_MS = 1_000L            // 亮屏：实时性优先
    const val RUNNING_BG_MS = 3_000L        // 灭屏 + 任务运行：保完成提醒及时性
    const val IDLE_BG_FRESH_MS = 10_000L    // 灭屏 + 空闲 < 10 分钟（或空闲保活窗内）
    const val IDLE_BG_SETTLED_MS = 30_000L  // 灭屏 + 空闲 ≥ 10 分钟且不在保活窗内（逐步放宽）

    /** 灭屏空闲保活窗默认时长（分钟）。0=关闭（回到深度省电），<0=常驻。 */
    const val DEFAULT_IDLE_KEEPALIVE_MIN = 30

    private const val SETTLE_MS = 10 * 60_000L

    @Volatile var screenInteractive = true
        private set

    @Volatile private var screenOffAt = 0L
    @Volatile private var lastStatus: String? = null
    @Volatile private var idleKeepAliveMs: Long = DEFAULT_IDLE_KEEPALIVE_MIN * 60_000L

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

    /** 设置灭屏空闲保活窗（分钟）：0=关闭，<0=常驻。由设置页与轮询线程喂入。 */
    fun setIdleKeepAliveMinutes(minutes: Int) {
        idleKeepAliveMs = when {
            minutes < 0 -> Long.MAX_VALUE
            else -> minutes.toLong() * 60_000L
        }
    }

    /** 灭屏空闲保活窗是否生效（任务运行中不看此窗——那条路始终保活）。 */
    fun idleKeepAliveActive(): Boolean =
        !screenInteractive && !isTaskRunning() &&
            backgroundAgeMs() < idleKeepAliveMs

    /** 灭屏已持续时长（亮屏时为 0）。 */
    fun backgroundAgeMs(): Long =
        if (screenInteractive || screenOffAt <= 0L) 0L
        else System.currentTimeMillis() - screenOffAt

    /**
     * 「灭屏」需要 PARTIAL 唤醒锁的场景：
     * - 任务运行中：防 CPU 休眠打断生成（不受保活窗限制）；
     * - 空闲但仍在保活窗内：保持 dsh 进程活跃可调度，亮屏回来立即可用。
     */
    fun wantWakeLock(): Boolean =
        !screenInteractive && (isTaskRunning() || idleKeepAliveActive())

    /** 关键窗口期看门狗才允许唤醒设备：任务运行中、空闲保活窗内，或刚灭屏不久。 */
    fun wantWakeupAlarm(): Boolean =
        !screenInteractive && (isTaskRunning() || idleKeepAliveActive() || backgroundAgeMs() < 5 * 60_000L)

    fun intervalMs(): Long = when {
        screenInteractive -> ACTIVE_MS
        isTaskRunning() -> RUNNING_BG_MS
        // 保活窗内维持较快轮询（唤醒锁已持有，额外功耗可忽略）；窗外逐步放宽到 30s
        backgroundAgeMs() < SETTLE_MS || idleKeepAliveActive() -> IDLE_BG_FRESH_MS
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
