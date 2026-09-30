package com.dsh.nextapp1.core

import android.content.Context

/**
 * 应用状态与配置中心（架构方案 P1-4）。
 *
 * SharedPreferences 命名空间唯一清单 —— 任何 getSharedPreferences 调用必须
 * 引用 [Prefs] 常量，禁止字符串字面量。键位明细由各消费方 KDoc 维护。
 */
object AppState {

    object Prefs {
        /** 控制台：一次性安装 tag（dsh_install_tag=next）等。 */
        const val CONSOLE = "dsh_console"

        /** 保活/拉起：期望运行态 running、watchdog 冷却时间戳。 */
        const val KEEPALIVE = "dsh_keepalive"

        /** 主界面 UI 状态。 */
        const val UI = "dsh_ui"

        /** 状态桥接：悬浮窗开关、声音/通知开关、完成提醒去重等。 */
        const val BRIDGE = "status_bridge"
    }

    // 已删除（无用代码清理）：bool/setBool 两个便捷方法——定义后**从无调用点**，
    // 且与上方 KDoc 的约定相悖（那条规定「必须引用 [Prefs] 常量，禁止字符串字面量」，
    // 而它们收 `ns: String` 正好在鼓励传字面量）。各消费方都在用自己的类型化读法。
}
