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
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * dsh-status-bridge 的 Android 桥接服务：
 * - 轮询本地 dsh-status-bridge 插件 HTTP 状态接口；
 * - 用悬浮窗显示运行情况；
 * - AI 输出结束后可触发声音提示和通知；
 * - 全部开关/显示模式由 [OverlaySettingsActivity] 配置。
 */
class StatusBridgeService : Service() {

    private val running = AtomicBoolean(true)
    private var thread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var overlayView: LinearLayout? = null
    private var overlayText: TextView? = null
    private var overlayDot: View? = null
    private var overlayClose: TextView? = null
    private var overlayParams: WindowManager.LayoutParams? = null
    private var dragStartX = 0
    private var dragStartY = 0
    private var dragStartTouchX = 0f
    private var dragStartTouchY = 0f
    private var lastStatus: String? = null
    private var lastFinishedAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildForegroundNotification("正在连接 dsh…"))
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
        mainHandler.post { removeOverlay() }
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
                    val updatedAt = json.optLong("updatedAt", 0L)
                    val prev = lastStatus
                    lastStatus = status
                    mainHandler.post {
                        updateOverlay(status, text)
                        updateForeground(status, text)
                        writeHeartbeat(status, text)
                    }
                    if (prev == "running" && status == "finished") {
                        if (updatedAt > lastFinishedAt) {
                            lastFinishedAt = updatedAt
                            mainHandler.post { onAiFinished(text) }
                        }
                    }
                } else {
                    // dsh 暂时不可达也要记录心跳，证明 Service 本身还活着
                    mainHandler.post { writeHeartbeat(lastStatus ?: "idle", "", "poll-null") }
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
    private fun soundEnabled() = prefs().getBoolean("sound_enabled", true)
    private fun notifyEnabled() = prefs().getBoolean("notify_enabled", true)
    private fun showStatus() = prefs().getBoolean("show_status", true)
    private fun showLastText() = prefs().getBoolean("show_last_text", true)
    private fun displayMode() = prefs().getString("display_mode", "compact") ?: "compact"

    // ---------------- 悬浮窗 ----------------

    private fun showOverlay(status: String, text: String) {
        if (prefs().getBoolean("overlay_dismissed", false)) return
        if (!overlayEnabled() || !Settings.canDrawOverlays(this)) return
        if (overlayView != null) {
            if (overlayView?.isAttachedToWindow == true) {
                updateOverlayText(status, text)
                return
            }
            // 窗口已被系统移除但引用还在：重置后重新 addView
            overlayView = null
            overlayText = null
            overlayDot = null
            overlayClose = null
            overlayParams = null
        }
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        overlayDot = View(this).apply {
            background = circleDrawable(statusColor(status))
        }
        overlayText = TextView(this).apply {
            textSize = 12f
            setTextColor(0xFFF2F5FA.toInt())
            includeFontPadding = false
            isSingleLine = displayMode() != "full"
            maxLines = if (displayMode() == "full") 2 else 1
            ellipsize = TextUtils.TruncateAt.END
        }
        overlayClose = TextView(this).apply {
            setText(" ×")
            textSize = 16f
            setTextColor(0xAAFFFFFF.toInt())
            setPadding(dp(6), 0, dp(2), 0)
            setOnClickListener {
                prefs().edit().putBoolean("overlay_dismissed", true).apply()
                removeOverlay()
            }
        }
        overlayView = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundedDrawable(0xDD101722.toInt(), 14, 1, 0x33283A55.toInt())
            if (Build.VERSION.SDK_INT >= 21) elevation = dp(6).toFloat()
            setPadding(dp(12), dp(8), dp(6), dp(8))
            addView(overlayDot, LinearLayout.LayoutParams(dp(8), dp(8)).apply { rightMargin = dp(6) })
            addView(overlayText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(overlayClose)
            setOnTouchListener(overlayTouchListener)
        }
        val type = if (Build.VERSION.SDK_INT >= 26)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        overlayParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(8)
            y = dp(80)
        }
        try {
            overlayView?.let { windowManager?.addView(it, overlayParams) }
            updateOverlayText(status, text)
        } catch (e: Exception) {
            overlayView = null
            overlayDot = null
            overlayClose = null
            overlayParams = null
        }
    }

    private fun updateOverlay(status: String, text: String) {
        if (!overlayEnabled() || !Settings.canDrawOverlays(this)) {
            removeOverlay()
            return
        }
        showOverlay(status, text)
    }

    private fun updateOverlayText(status: String, text: String) {
        val tv = overlayText ?: return
        overlayDot?.background = circleDrawable(statusColor(status))
        val showLast = showLastText() && text.isNotBlank()
        val lastSnippet = if (showLast) {
            if (displayMode() == "full") text.take(80) else text.take(20)
        } else ""
        val statusText = if (showStatus()) statusLabel(status) else ""
        tv.text = listOf(statusText, lastSnippet).filter { it.isNotBlank() }.joinToString(" · ")
        tv.isSingleLine = displayMode() != "full"
        tv.maxLines = if (displayMode() == "full") 2 else 1
    }

    private fun statusLabel(status: String): String = when (status) {
        "running" -> "dsh 运行中"
        "finished" -> "AI 输出完成"
        else -> "dsh 空闲"
    }

    private fun statusColor(status: String): Int = when (status) {
        "running" -> 0xFF6C8CFF.toInt()
        "finished" -> 0xFF5FD68A.toInt()
        else -> 0xFF7A8496.toInt()
    }

    private fun circleDrawable(color: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
        }

    private fun roundedDrawable(
        color: Int,
        radiusDp: Int,
        strokeWidth: Int = 0,
        strokeColor: Int = 0
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
        if (strokeWidth > 0) setStroke(strokeWidth, strokeColor)
    }

    private fun removeOverlay() {
        try {
            overlayView?.let { windowManager?.removeView(it) }
        } catch (e: Exception) {
            // already removed
        }
        overlayView = null
        overlayText = null
        overlayDot = null
        overlayClose = null
        overlayParams = null
    }

    private val overlayTouchListener = View.OnTouchListener { _, event ->
        val p = overlayParams ?: return@OnTouchListener false
        val manager = windowManager ?: return@OnTouchListener false
        val view = overlayView ?: return@OnTouchListener false
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                dragStartX = p.x
                dragStartY = p.y
                dragStartTouchX = event.rawX
                dragStartTouchY = event.rawY
                true
            }
            MotionEvent.ACTION_MOVE -> {
                p.x = dragStartX + (event.rawX - dragStartTouchX).toInt()
                p.y = dragStartY + (event.rawY - dragStartTouchY).toInt()
                try { manager.updateViewLayout(view, p) } catch (e: Exception) {}
                true
            }
            else -> false
        }
    }

    // ---------------- 完成提示 ----------------

    private fun onAiFinished(text: String) {
        if (soundEnabled()) playBeep()
        if (notifyEnabled()) postFinishNotification(text)
    }

    private fun playBeep() {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 350)
        } catch (e: Exception) {
            // no sound permission / audio issue
        }
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

    private fun postFinishNotification(text: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channelId = "dsh_status_bridge_finish"
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(channelId, "dsh 输出完成", NotificationManager.IMPORTANCE_HIGH)
            nm.createNotificationChannel(ch)
        }
        val content = if (text.isNotBlank()) "AI 输出完成：${text.take(50)}" else "AI 输出完成"
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val openIntent = PendingIntent.getActivity(
            this, 1,
            Intent(this, WebViewActivity::class.java),
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

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 诊断心跳：把服务存活与悬浮窗挂载状态写到 App 私有目录，便于外部定位。 */
    private fun writeHeartbeat(status: String, text: String, note: String? = null) {
        try {
            val f = File(filesDir, "status-bridge-heartbeat.json")
            val obj = JSONObject()
            obj.put("ts", System.currentTimeMillis())
            obj.put("status", status)
            obj.put("text", text.take(80))
            obj.put("note", note ?: "")
            obj.put("overlayExists", overlayView != null)
            obj.put("overlayAttached", overlayView?.isAttachedToWindow == true)
            obj.put("running", running.get())
            f.writeText(obj.toString())

            val log = File(filesDir, "status-bridge-heartbeat.log")
            log.appendText(
                "${System.currentTimeMillis()} | $status | ${text.take(80)} | ${note ?: ""} | " +
                    "overlayExists=${overlayView != null} attached=${overlayView?.isAttachedToWindow == true} " +
                    "running=${running.get()}\n"
            )
        } catch (e: Exception) {
            // 诊断文件写失败不影响主流程
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 0x5A17
        private const val FINISH_NOTIFICATION_ID = 0x5A18
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