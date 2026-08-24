package com.dsh.launcher.service

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
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

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
    @Volatile private var lastStatus: String? = null
    private var lastFinishedAt = 0L

    private var wakeLock: android.os.PowerManager.WakeLock? = null
    private var wakeHeld = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 清理 v4.6 及之前无轮转的遗留心跳日志（新日志走 files/logs/heartbeat.log）
        runCatching { File(filesDir, "status-bridge-heartbeat.log").delete() }
        startForeground(NOTIFICATION_ID, buildForegroundNotification("正在连接 dsh…"))
        overlayManager = BridgeOverlayManager(
            this,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            true
        )
        writeHeartbeat("service", "created", "created", force = true)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 每次 startForegroundService 都必须配套 startForeground：服务已存活时被再次拉起
        // （如每次打开 app 的自动恢复、watchdog 兜底），不补调会在 targetSdk≥26 下
        // 5 秒后触发 RemoteServiceException 崩溃。重复调用幂等合法。
        startForeground(NOTIFICATION_ID, buildForegroundNotification("正在连接 dsh…"))
        writeHeartbeat("service", "started", "started", force = true)
        scheduleWatchdog(this)
        if (thread == null) {
            thread = Thread({ pollLoop() }, "dsh-status-bridge")
            thread?.start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        syncWakeLock(false)
        thread?.interrupt()
        mainHandler.post { overlayManager?.remove() }
        overlayManager?.release()
        writeHeartbeat("service", "destroyed", "destroyed", force = true)
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 即使任务被划掉也尽量保持悬浮窗服务运行
        writeHeartbeat("service", "task-removed", "task-removed", force = true)
        try {
            val restart = Intent(this, StatusBridgeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(restart) else startService(restart)
        } catch (t: Exception) {
            writeHeartbeat("service", "restart-failed", t.message ?: "exception", force = true)
        }
        super.onTaskRemoved(rootIntent)
    }

    // ---------------- 轮询 ----------------

    private fun pollLoop() {
        while (running.get()) {
            // 自适应策略：屏幕/任务态喂给治理器，按档位取间隔；任务后台运行时持 PARTIAL 锁
            PowerGovernor.refreshScreenState(this)
            PowerGovernor.setTaskStatus(lastStatus)
            syncWakeLock(PowerGovernor.wantWakeLock())
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
            try { Thread.sleep(PowerGovernor.intervalMs()) } catch (e: InterruptedException) { break }
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

    private fun prefs() = getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)

    private fun overlayEnabled() = prefs().getBoolean("overlay_enabled", true) &&
        // 无障碍通道 5 秒内刷新过时间戳才视为激活：宿主被杀时 onUnbind/onDestroy 不回调，
        // 布尔标志会陈旧残留（跨重启持久化），普通通道因此永久让位 → 双通道全灭
        System.currentTimeMillis() - prefs().getLong(KeepAliveAccessibilityService.A11Y_TS_KEY, 0L) <
            KeepAliveAccessibilityService.A11Y_FRESH_MS

    /** 任务后台运行期间持有 PARTIAL 唤醒锁（防 CPU 休眠打断生成）；其余场景立即释放。 */
    private fun syncWakeLock(needed: Boolean) {
        if (needed == wakeHeld) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (needed) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "dsh:task-running").apply {
                    setReferenceCounted(false)
                    acquire()
                }
                wakeHeld = true
                AppLog.i("PowerGov", "wake lock acquired (task running, screen off)")
            } else {
                runCatching { wakeLock?.release() }
                wakeLock = null
                wakeHeld = false
            }
        } catch (t: Throwable) {
            AppLog.e("PowerGov", "wake lock sync failed: " + (t.message ?: t.toString()))
            wakeHeld = false
        }
    }

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

    private var lastNotifiedKey: String? = null

    private fun updateForeground(status: String, text: String) {
        // 内容没变就不 notify()：旧实现每秒刷一次前台通知，白白消耗系统调度与电量
        val key = status + "|" + text.take(40)
        if (key == lastNotifiedKey) return
        lastNotifiedKey = key
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildForegroundNotification(statusLabel(status)))
    }

    /** 诊断心跳：把服务存活与悬浮窗挂载状态写到 App 私有目录，便于外部定位。
     *  轮询路径 5 秒节流（60 次/分钟的 flash 写盘纯属磨损，诊断价值不变）；
     *  created/started/destroyed 等生命周期事件用 force=true 立即落盘。 */
    private var lastHeartbeatAt = 0L

    /** 心跳落盘专用单线程（review R1.5：主线程同步 I/O → 后台化；日志走 FileLog 轮转）。 */
    private val heartbeatIo = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "heartbeat-io").apply { isDaemon = true }
    }

    private fun writeHeartbeat(status: String, text: String, note: String? = null, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastHeartbeatAt < 5_000L) return
        lastHeartbeatAt = now
        // 状态快照在调用线程采集，落盘移交后台
        val overlayOk = overlayManager?.hasOverlay() == true
        val runningFlag = running.get()
        heartbeatIo.execute {
            try {
                // 原子写：先 tmp 再改名，避免 watchdog 读到半截 JSON
                val f = File(filesDir, "status-bridge-heartbeat.json")
                val tmp = File(filesDir, "status-bridge-heartbeat.json.tmp")
                tmp.writeText(
                    JSONObject()
                        .put("ts", now)
                        .put("status", status)
                        .put("text", text.take(80))
                        .put("note", note ?: "")
                        .put("overlayExists", overlayOk)
                        .put("running", runningFlag)
                        .toString()
                )
                f.delete()
                tmp.renameTo(f)

                // 追加日志改走 FileLog：可读时间戳 + 512KB 轮转（原实现无上限增长）
                FileLog.log(
                    this@StatusBridgeService, "heartbeat.log",
                    "$status | ${text.take(80)} | ${note ?: ""} | overlay=$overlayOk running=$runningFlag"
                )
            } catch (_: Exception) {
                // 诊断文件写失败不影响主流程
            }
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
            context.getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)
                .edit().putBoolean("overlay_dismissed", false).apply()
        }

        /** 自续式看门狗闹钟（30s 一次）：BridgeWatchdogReceiver 每次触发后重新排下一发。 */
        internal fun scheduleWatchdog(context: Context) {
            try {
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val pi = PendingIntent.getBroadcast(
                    context,
                    WATCHDOG_REQUEST_CODE,
                    Intent(WATCHDOG_ACTION).setPackage(context.packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                // setInexactRepeating 的 30s 周期会被系统钳到 ~15 分钟（实机验证：服务死后
                // 18 分钟仍未自愈）。改为一次性精确闹钟，由 BridgeWatchdogReceiver 自续链条。
                // 功耗关键：用非唤醒型 ELAPSED_REALTIME——灭屏待机不再每 30s 把设备从深睡
                // 揍醒（旧 WAKEUP 版是待机掉电大头）；灭屏期间悬浮窗本就不显示，
                // 待用户亮屏的瞬间积压闹钟立即触发补拉，体验无损。
                val type = if (PowerGovernor.wantWakeupAlarm()) AlarmManager.ELAPSED_REALTIME_WAKEUP
                           else AlarmManager.ELAPSED_REALTIME
                am.setExactAndAllowWhileIdle(
                    type,
                    SystemClock.elapsedRealtime() + 30_000L,
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

