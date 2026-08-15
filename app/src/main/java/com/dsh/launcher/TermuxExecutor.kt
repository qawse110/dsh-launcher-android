package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Termux 桥接工具。
 *
 * 说明：
 *  - 以 termux-app 作为终端与命令执行后端。
 *  - 程序化执行命令使用 Termux 官方 RUN_COMMAND 意图
 *    （需要一次性在 Termux 设置中允许本应用运行命令）。
 *  - 也提供直接打开 Termux 终端的方式作为兜底。
 */
object TermuxExecutor {

    const val TERMUX_PACKAGE = "com.termux"
    const val RUN_COMMAND_ACTION = "com.termux.RUN_COMMAND"

    /** 该应用是否已安装 */
    fun isInstalled(context: Context): Boolean = try {
        context.applicationContext.packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * 通过 Termux RUN_COMMAND 执行一条命令。
     * @return 意图是否成功发送（不代表命令执行成功）
     */
    fun runCommand(context: Context, commandLine: String, background: Boolean): Boolean {
        return try {
            val termuxPrefix = "/data/data/com.termux/files/usr/bin"
            val intent = Intent(RUN_COMMAND_ACTION).apply {
                setClassName(TERMUX_PACKAGE, "com.termux.app.RunCommandService")
                putExtra("com.termux.RUN_COMMAND_PATH", "$termuxPrefix/bash")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", commandLine))
                // 0 = 新建会话，1 = 前台现有会话；后台任务统一用 0
                putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", 0)
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", background)
                putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home/dsh")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.applicationContext.startService(intent)
            true
        } catch (e: Exception) {
            android.util.Log.e("Dsh", "runCommand failed", e)
            false
        }
    }

    /** 直接打开 Termux 终端（用户手动操作时的兜底） */
    fun openTermux(context: Context) {
        try {
            val launch = context.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)
                ?: throw PackageManager.NameNotFoundException("termux")
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launch)
        } catch (e: Exception) {
            // 未安装 Termux：跳转 F-Droid（Termux 官方渠道）
            try {
                val fdroid = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://f-droid.org/en/packages/com.termux/"))
                fdroid.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(fdroid)
            } catch (ignored: Exception) {
                // 忽略
            }
        }
    }
}