package com.dsh.launcher

import android.content.Context
import android.os.PowerManager

/**
 * 悬浮窗双通道共用的轮询功耗档位。
 *
 * 待机耗电重灾区（旧实现）：两条通道各自以 1s 间隔永久轮询本机 HTTP，
 * 叠加看门狗每 30s 一次的 WAKEUP 闹钟——设备永远进不了深度休眠，待机掉电飞快。
 *
 * 现按「屏幕状态 × 任务态」分档：
 * - 亮屏：1s —— 悬浮窗实时性优先；
 * - 灭屏 + 任务运行中：5s —— 保住 AI 完成提醒的及时性；
 * - 灭屏 + 空闲：20s —— 仅维持心跳/watchdog 链路（心跳 ts < 60s 判活，留足余量）。
 *
 * 全部走 loopback HTTP，不唤醒射频；配合非唤醒看门狗闹钟，灭屏后设备可正常进深睡。
 */
object PollPolicy {
    const val ACTIVE_MS = 1_000L
    const val RUNNING_BG_MS = 5_000L
    const val IDLE_BG_MS = 20_000L

    fun intervalMs(context: Context, lastStatus: String?): Long {
        val interactive = try {
            (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive ?: true
        } catch (_: Exception) {
            true
        }
        return when {
            interactive -> ACTIVE_MS
            lastStatus == "running" -> RUNNING_BG_MS
            else -> IDLE_BG_MS
        }
    }
}
