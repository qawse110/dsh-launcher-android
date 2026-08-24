package com.dsh.launcher.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/** dsh 安装/构建期间的前台保活服务，防止长时间 build 被系统回收。 */
class BuildKeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val running = Supervisor.desiredRunning(this)
        startForeground(
            1,
            buildNotification(
                if (running) "dsh 运行中" else "dsh 安装中",
                if (running) "dsh 正在后台运行，点击可进入管理" else "正在构建 DeepSeek Harness，请稍候…"
            )
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_UPDATE_RUNNING) {
            Supervisor.setDesiredRunning(this, true)
            startForeground(
                1,
                buildNotification("dsh 运行中", "dsh 正在后台运行，点击可进入管理")
            )
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(1)
        }
    }


    private fun buildNotification(title: String, text: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val builder: Notification.Builder =
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(
                    "dsh", "dsh 服务", NotificationManager.IMPORTANCE_LOW
                )
                nm.createNotificationChannel(ch)
                Notification.Builder(this, "dsh")
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
        return builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_UPDATE_RUNNING = "com.dsh.launcher.action.BUILD_KEEPALIVE_RUNNING"

        /** 期望运行态唯一写入口（架构方案 P1-5，状态本体在 [com.dsh.launcher.core.Supervisor]）。 */
        fun updateRunning(context: Context) {
            Supervisor.setDesiredRunning(context, true)
            val intent = Intent(context, BuildKeepAliveService::class.java)
                .setAction(ACTION_UPDATE_RUNNING)
            runCatching {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }
        }

        fun markStopped(context: Context) {
            Supervisor.setDesiredRunning(context, false)
        }
    }
}

