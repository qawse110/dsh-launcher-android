package com.dsh.launcher.core

import android.content.Context

/**
 * dsh web 健康 watchdog —— 触发器（架构方案 P1-5）。
 *
 * 状态桥接 / 无障碍保活两路轮询线程发现端口不通时调用 [maybeRevive]；
 * 期望运行态、冷却与实际拉起动作统一由 [Supervisor] 持有，
 * 本对象退化为纯触发源，不再自行管理状态。
 */
object DshWatchdog {

    private const val TAG_WATCHDOG = "DshWatchdog"

    /**
     * dsh web 端口是否可访问。
     *
     * 委托 [LocalHttp]：本机回环一律 `Proxy.NO_PROXY`，否则系统代理会劫持
     * 探针导致误判死亡（对齐参考实现坑 33）。
     */
    fun isUp(): Boolean = LocalHttp.responds(DshFlow.WEB_PORT)

    /**
     * 端口不通且冷却到期时经 [Supervisor] 拉起 dsh web。
     * 仅当用户期望 dsh 运行（主界面启动过、且未显式停止）时才会拉起——
     * 用户点「停止 dsh 服务」后不会复活。
     */
    fun maybeRevive(context: Context) {
        if (isUp()) {
            // web 正常：归零 revive 失败退避计数，恢复基础冷却
            Supervisor.noteWebUp(context)
            return
        }
        // 崩溃循环检测：连续多次拉起无效 + 临时窗口内 → 自动回滚重装上一版本
        if (Supervisor.maybeRollbackOnCrashLoop(context) { AppLog.i(TAG_WATCHDOG, it) }) {
            AppLog.i(TAG_WATCHDOG, "crash-loop in temp window, auto-rollback reinstall triggered")
            DshFlow.launch(
                context, DshFlow.Mode.INSTALL_AND_START,
                forceFullInstall = true,
                onLog = { AppLog.i(TAG_WATCHDOG, it) },
            )
            return
        }
        Supervisor.reviveWebIfDue(context)
    }
}
