package com.dsh.launcher.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.dsh.launcher.core.Supervisor

/**
 * 组件自恢复接收器：开机完成 / 应用更新后自动接回保活链。
 *
 * 背景：应用进程被系统杀死后，无障碍通道由系统直接重绑可自愈；
 * 但普通通道（StatusBridgeService）与看门狗闹钟链没有任何触发源——
 * 用户不主动打开 app 就一直是死状态（悬浮窗消失、dsh 挂了也没人拉）。
 * 本接收器在 BOOT_COMPLETED / MY_PACKAGE_REPLACED 时把服务拉回来。
 *
 * 注意：被「强制停止」的应用收不到任何广播（组件进入 stopped 态），
 * 该场景只能靠用户下次打开应用时自愈（MainActivity 启动即拉服务，
 * 且打开应用会让系统重新绑定已登记的无障碍服务）。
 */
class CoreRestoreReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return
        // 用户显式停止过 dsh（「停止服务」）则不自动恢复
        if (!Supervisor.desiredRunning(context)) return
        try {
            StatusBridgeService.start(context)
        } catch (_: Exception) {
            // 开机早期偶发启动失败：watchdog 链建立不起来时，用户打开应用仍会兜底
        }
    }
}
