package com.dsh.launcher

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * dsh-status-bridge 的 Android 桥接服务：
 * - 轮询本地 dsh-status-bridge 插件 HTTP 状态接口；
 * - 用悬浮窗显示运行情况（状态条 / 桌宠两种模式，见 [BridgeOverlayManager]）；
 * - AI 输出结束后可触发声音提示和通知；
 * - 全部开关/显示模式由 [OverlaySettingsActivity] 配置。
 */
class StatusBridgeService : Service() {

    private val running = AtomicBoolean(true)
    private var thread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var overlayManager: BridgeOverlayManager? = null
    private var lastStatus: String? = null
    private var lastFinishedAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildForegroundNotification("正在连接 dsh…"))
        overlayManager = BridgeOverlayManager(
            this,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            true
        )
        writeHeartbeat("service", "created", "created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        writeHeartbeat("service", "started", "started")
        scheduleWatchdog(this)
        if (thread == null) {
            thread = Thread({ pollLoop() }, "dsh-status-bridge")
            thread?.start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        thread?.interrupt()
        mainHandler.post { overlayManager?.remove() }
        overlayManager?.release()
        writeHeartbeat("service", "destroyed", "destroyed")
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 即使任务被划掉也尽量保持悬浮窗服务运行
        writeHeartbeat("service", "task-removed", "task-removed")
        try {
            val restart = Intent(this, StatusBridgeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(restart) else startService(restart)
        } catch (t: Exception) {
            writeHeartbeat("service", "restart-failed", t.message ?: "exception")
        }
        super.onTaskRemoved(rootIntent)
    }

    // ---------------- 轮询 ----------------

    private fun pollLoop() {
        while (running.get()) {
            try {
                val json = fetchStatus()
                if (json != null) {
                    val status = json.optString("status", "idle")
                    val text = json.optString("lastText", "")
                    val event = if (json.has("lastEvent")) json.optString("lastEvent", null) else null
                    val updatedAt = json.optLong("updatedAt", 0L)
                    val prev = lastStatus
                    lastStatus = status
                    mainHandler.post {
                        updateOverlay(status, text, event)
                        updateForeground(status, text)
                        writeHeartbeat(status, text)
                    }
                    if (prev == "running" && status == "finished") {
                        if (updatedAt > lastFinishedAt) {
                            lastFinishedAt = updatedAt
                            mainHandler.post { StatusBridgeAlerts.onAiFinished(this, text) }
                        }
                    }
                } else {
                    // dsh 暂时不可达也要记录心跳，证明 Service 本身还活着；
                    // 同时 watchdog 自动拉起 dsh web（60s 冷却，双路幂等）
                    mainHandler.post { writeHeartbeat(lastStatus ?: "idle", "", "poll-null") }
                    DshWatchdog.maybeRevive(this)
                }
            } catch (t: Throwable) {
                // ignore transient polling errors
            }
            try { Thread.sleep(1000L) } catch (e: InterruptedException) { break }
        }
    }

    private fun fetchStatus(): JSONObject? = try {
        val conn = URL("http://127.0.0.1:3190/status").openConnection() as HttpURLConnection
        conn.connectTimeout = 800
        conn.readTimeout = 800
        conn.requestMethod = "GET"
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        if (text.isBlank()) null else JSONObject(text)
    } catch (e: Exception) {
        null
    }

    // ---------------- 配置读取 ----------------

    private fun prefs() = getSharedPreferences("status_bridge", Context.MODE_PRIVATE)

    private fun overlayEnabled() = prefs().getBoolean("overlay_enabled", true) &&
        !prefs().getBoolean("a11y_overlay_active", false)

    // ---------------- 悬浮窗 ----------------

    private fun updateOverlay(status: String, text: String, event: String?) {
        if (!overlayEnabled() || !Settings.canDrawOverlays(this)) {
            overlayManager?.remove()
            return
        }
        overlayManager?.update(status, text, event)
    }

    // ---------------- 通知 ----------------

    private fun buildForegroundNotification(content: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channelId = "dsh_status_bridge"
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(channelId, "dsh 运行状态", NotificationManager.IMPORTANCE_LOW)
            nm.createNotificationChannel(ch)
        }
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, OverlaySettingsActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("dsh 状态桥接")
            .setContentText(content)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateForeground(status: String, text: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildForegroundNotification(statusLabel(status)))
    }

    /** 诊断心跳：把服务存活与悬浮窗挂载状态写到 App 私有目录，便于外部定位。 */
    private fun writeHeartbeat(status: String, text: String, note: String? = null) {
        try {
            val f = File(filesDir, "status-bridge-heartbeat.json")
            val obj = JSONObject()
            obj.put("ts", System.currentTimeMillis())
            obj.put("status", status)
            obj.put("text", text.take(80))
            obj.put("note", note ?: "")
            obj.put("overlayExists", overlayManager?.hasOverlay() == true)
            obj.put("running", running.get())
            f.writeText(obj.toString())

            val log = File(filesDir, "status-bridge-heartbeat.log")
            log.appendText(
                "${System.currentTimeMillis()} | $status | ${text.take(80)} | ${note ?: ""} | " +
                    "overlayExists=${overlayManager?.hasOverlay() == true} " +
                    "running=${running.get()}\n"
            )
        } catch (e: Exception) {
            // 诊断文件写失败不影响主流程
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 0x5A17
        private const val WATCHDOG_REQUEST_CODE = 0x5A19
        const val WATCHDOG_ACTION = "com.dsh.launcher.action.BRIDGE_WATCHDOG"

        fun start(context: Context) {
            val intent = Intent(context, StatusBridgeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            scheduleWatchdog(context)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StatusBridgeService::class.java))
            cancelWatchdog(context)
        }

        /** 清除“点 × 已关闭”状态，下次轮询会重新显示悬浮窗。 */
        fun resetDismissed(context: Context) {
            context.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
                .edit().putBoolean("overlay_dismissed", false).apply()
        }

        private fun scheduleWatchdog(context: Context) {
            try {
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val pi = PendingIntent.getBroadcast(
                    context,
                    WATCHDOG_REQUEST_CODE,
                    Intent(WATCHDOG_ACTION).setPackage(context.packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                am.setInexactRepeating(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 30_000L,
                    30_000L,
                    pi
                )
            } catch (e: Exception) {
                // watchdog 只是兜底，失败不影响主服务
            }
        }

        private fun cancelWatchdog(context: Context) {
            try {
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val pi = PendingIntent.getBroadcast(
                    context,
                    WATCHDOG_REQUEST_CODE,
                    Intent(WATCHDOG_ACTION).setPackage(context.packageName),
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                if (pi != null) {
                    am.cancel(pi)
                    pi.cancel()
                }
            } catch (e: Exception) {
                // ignore
            }
        }
    }
}

/** 看门狗：桥接服务被系统销毁后，定时检查心跳文件并尝试重新拉起服务。 */
class BridgeWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != StatusBridgeService.WATCHDOG_ACTION) return
        val alive = try {
            val f = File(context.filesDir, "status-bridge-heartbeat.json")
            val obj = JSONObject(f.readText())
            val running = obj.optBoolean("running", false)
            val ts = obj.optLong("ts", 0L)
            running && System.currentTimeMillis() - ts < 60_000L
        } catch (e: Exception) {
            false
        }
        if (!alive) {
            StatusBridgeService.start(context)
        }
    }
}
