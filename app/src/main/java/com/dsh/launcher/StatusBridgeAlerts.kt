package com.dsh.launcher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build

/**
 * dsh 输出完成提醒：提示音 + 通知，两者完全独立。
 * - 提示音由应用自身 ToneGenerator 发声，不依赖通知音；
 * - 通知通道静音，只负责在通知栏展示完成信息。
 * 普通前台服务与无障碍服务都会调用，用 SharedPreferences 时间戳做跨进程去重，
 * 避免两个服务同时轮询到 finished 时重复提醒。
 */
object StatusBridgeAlerts {

    private const val FINISH_NOTIFICATION_ID = 0x5A18
    private const val CHANNEL_ID = "dsh_status_bridge_finish_silent"
    private const val PREFS_NAME = "status_bridge"
    private const val LAST_ALERT_AT = "last_finish_alert_at"
    private const val DEDUPE_MS = 2000L

    fun onAiFinished(context: Context, text: String) {
        val now = System.currentTimeMillis()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (now - prefs.getLong(LAST_ALERT_AT, 0L) < DEDUPE_MS) return
        prefs.edit().putLong(LAST_ALERT_AT, now).commit()

        if (prefs.getBoolean("sound_enabled", true)) {
            playFinishSound(context)
        }
        if (prefs.getBoolean("notify_enabled", true)) {
            postFinishNotification(context, text)
        }
    }

    private fun playFinishSound(context: Context) {
        // 应用自身发声：使用 ToneGenerator 播放提示音，不再依赖系统通知音/通知渠道。
        try {
            val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 500)
        } catch (_: Exception) {
            // 音频服务不可用时静默失败，不影响通知
        }
    }

    private fun postFinishNotification(context: Context, text: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL_ID, "dsh 输出完成（静默）", NotificationManager.IMPORTANCE_DEFAULT)
            ch.setSound(null, null)
            ch.enableVibration(false)
            nm.createNotificationChannel(ch)
        }
        val content = if (text.isNotBlank()) "AI 输出完成：${text.take(50)}" else "AI 输出完成"
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        val openIntent = PendingIntent.getActivity(
            context,
            1,
            Intent(context, WebViewActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        builder
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("dsh AI 完成")
            .setContentText(content)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setSound(null)
            .setVibrate(null)
        nm.notify(FINISH_NOTIFICATION_ID, builder.build())
    }
}
