package com.dsh.launcher.core

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

    // ---- 常用类型化读写便捷方法（按需扩展）----

    fun bool(ctx: Context, ns: String, key: String, default: Boolean = false): Boolean =
        ctx.getSharedPreferences(ns, Context.MODE_PRIVATE).getBoolean(key, default)

    fun setBool(ctx: Context, ns: String, key: String, value: Boolean) {
        ctx.getSharedPreferences(ns, Context.MODE_PRIVATE)
            .edit().putBoolean(key, value).apply()
    }
}
