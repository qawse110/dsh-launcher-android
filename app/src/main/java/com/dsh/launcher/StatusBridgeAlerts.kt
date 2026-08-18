package com.dsh.launcher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build

/**
 * dsh 输出完成提醒：声音 + 通知。
 * 普通前台服务与无障碍服务都会调用，用 SharedPreferences 时间戳做跨进程去重，
 * 避免两个服务同时轮询到 finished 时重复提醒。
 */
object StatusBridgeAlerts {

    private const val FINISH_NOTIFICATION_ID = 0x5A18
    private const val CHANNEL_ID = "dsh_status_bridge_finish"
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
        // 优先用系统默认通知音，比 ToneGenerator 更容易被听到；失败再退回蜂鸣。
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ringtone = RingtoneManager.getRingtone(context.applicationContext, uri)
            if (ringtone != null) {
                ringtone.play()
                return
            }
        } catch (_: Exception) {
            // fall through to tone generator
        }
        try {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 350)
        } catch (_: Exception) {
            // no sound permission / audio issue
        }
    }

    private fun postFinishNotification(context: Context, text: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL_ID, "dsh 输出完成", NotificationManager.IMPORTANCE_HIGH)
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
        nm.notify(FINISH_NOTIFICATION_ID, builder.build())
    }
}
