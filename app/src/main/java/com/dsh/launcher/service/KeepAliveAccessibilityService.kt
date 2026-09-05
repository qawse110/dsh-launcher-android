package com.dsh.launcher.service

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * 无障碍悬浮桥接服务：
 * - 通过 TYPE_ACCESSIBILITY_OVERLAY 绘制 dsh 状态悬浮窗；
 * - 无障碍服务由系统保活，后台被杀的几率远低于普通前台服务；
 * - 不读取、不处理任何屏幕内容，只轮询本机 dsh status HTTP 接口。
 *
 * 与普通通道（StatusBridgeService）的协调：
 * - 轮询经 [touchTs] 刷新存活时间戳（内存权威 + prefs 低频落盘），普通通道经
 *   [shouldYieldToA11y] 判断是否让位——宿主被杀时 onUnbind/onDestroy 不回调，
 *   旧布尔标志会陈旧残留（跨重启持久化），曾导致双通道互相谦让全灭；时间戳化后
 *   自动过期自愈，通道下线时经 [invalidateTs] 显式失效以保留该自愈语义；
 * - 锁屏/灭屏判断统一由 BridgeOverlayManager 用 KeyguardManager 实时查询，
 *   不再依赖本服务维护的 screen_visible 共享键（a11y 关闭时无人更新会让门禁失效）。
 */
class KeepAliveAccessibilityService : AccessibilityService() {

    private var overlayManager: BridgeOverlayManager? = null
    private var polling = false
    private var pollThread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var lastStatus: String? = null
    private var lastFinishedAt = 0L
    /** 灭屏保活锁（任务运行中 / 空闲保活窗内）：与普通通道各自独立持有，
     *  任一通道存活都能保住后台任务不被 CPU 休眠打断。 */
    private var wakeLock: android.os.PowerManager.WakeLock? = null
    private var wakeHeld = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        // 立即刷新时间戳：连接瞬间就让普通通道开始让位（不等第一次轮询）
        touchTs(this, force = true)
        overlayManager = BridgeOverlayManager(
            this,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            false
        )
        overlayManager?.resetDismissed()
        startPolling()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 只用于保活和悬浮窗，不处理事件
    }

    override fun onInterrupt() {
        // no-op
    }

    override fun onUnbind(intent: Intent?): Boolean {
        onChannelDown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        onChannelDown()
        super.onDestroy()
    }

    /**
     * 通道下线：必须**显式失效**时间戳（M5 的关键约束）。
     *
     * 原设计靠「时间戳自然过期」自愈——宿主被杀时 onUnbind/onDestroy 可能不回调，
     * 落盘的旧值 5s 后过期，普通通道自动接管。引入进程内内存值后，若不显式归零，
     * 内存里的新鲜时间戳永不过期 → 普通通道永久让位 → 双通道全灭（正是这套设计
     * 当初要防的故障）。故此处无论如何都要把内存值清零。
     */
    private fun onChannelDown() {
        stopPolling()
        invalidateTs()
        StatusBridgeAlerts.release() // 释放提示音句柄（M6）
        overlayManager?.remove()
        overlayManager?.release()
        overlayManager = null
    }

    private fun prefs() = getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)

    private fun startPolling() {
        if (polling) return
        polling = true
        pollThread = thread {
            while (polling) {
                // 自适应档位 + 心跳时间戳（普通通道据此判断本通道是否活着）
                PowerGovernor.refreshScreenState(this)
                PowerGovernor.setIdleKeepAliveMinutes(
                    prefs().getInt("idle_keepalive_min", PowerGovernor.DEFAULT_IDLE_KEEPALIVE_MIN)
                )
                PowerGovernor.setTaskStatus(lastStatus)
                touchTs(this)
                syncWakeLock(PowerGovernor.wantWakeLock())
                val data = fetchStatus()
                if (data == null) {
                    // dsh 进程不可达：watchdog 自动拉起（60s 冷却，双路幂等）
                    DshWatchdog.maybeRevive(this)
                    try {
                        // 功耗档位见 PowerGovernor（亮屏 1s / 灭屏+任务 3s / 灭屏空闲分档放宽）
                        Thread.sleep(PowerGovernor.intervalMs())
                    } catch (e: InterruptedException) {
                        break
                    }
                    continue
                }
                val prev = lastStatus
                lastStatus = data.status
                val finished = prev == "running" && data.status == "finished" &&
                    data.updatedAt > lastFinishedAt
                if (finished) lastFinishedAt = data.updatedAt
                mainHandler.post {
                    overlayManager?.update(data.status, data.text, data.event)
                    if (finished) StatusBridgeAlerts.onAiFinished(this, data.text)
                }
                try {
                    Thread.sleep(PowerGovernor.intervalMs())
                } catch (e: InterruptedException) {
                    break
                }
            }
        }
    }

    private fun stopPolling() {
        polling = false
        pollThread?.interrupt()
        pollThread = null
        syncWakeLock(false)
    }

    /**
     * PARTIAL 唤醒锁同步：需要时以 10 分钟超时持有并由轮询循环续期（间隔 ≤30s），
     * 误判卡死也会超时自释放；不需要时立即释放。与 StatusBridgeService 同策略。
     */
    private fun syncWakeLock(needed: Boolean) {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (needed) {
                if (wakeLock == null) {
                    wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "dsh:a11y-keepalive").apply {
                        setReferenceCounted(false)
                    }
                }
                wakeLock?.acquire(WAKELOCK_RENEW_MS)
                wakeHeld = true
            } else if (wakeHeld || wakeLock != null) {
                runCatching { wakeLock?.release() }
                wakeLock = null
                wakeHeld = false
            }
        } catch (_: Throwable) {
            wakeHeld = false
        }
    }

    private fun fetchStatus(): StatusData? {
        return try {
            val conn = URL(STATUS_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 800
            conn.readTimeout = 800
            conn.requestMethod = "GET"
            conn.useCaches = false
            try {
                if (conn.responseCode != 200) return null
                val text = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                val obj = JSONObject(text)
                StatusData(
                    status = obj.optString("status", "idle"),
                    text = obj.optString("lastText", ""),
                    event = if (obj.has("lastEvent")) obj.optString("lastEvent", null) else null,
                    updatedAt = obj.optLong("updatedAt", 0L)
                )
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            null
        }
    }

    private data class StatusData(
        val status: String,
        val text: String,
        val event: String?,
        val updatedAt: Long
    )

    companion object {
        private const val STATUS_URL = "http://127.0.0.1:3190/status"

        /** 唤醒锁单次持有超时：轮询循环每轮（≤30s）续期，超时兜底防误判后永久持锁。 */
        private const val WAKELOCK_RENEW_MS = 10 * 60_000L

        /** 无障碍通道存活时间戳的 prefs 键（值 = System.currentTimeMillis()）。 */
        const val A11Y_TS_KEY = "a11y_overlay_ts"

        /**
         * 进程内权威时间戳（M5）。
         *
         * 两个通道同进程（独立进程方案已废弃，见 AndroidManifest 注释），本可用纯内存
         * 单例；但 SharedPreferences 每秒一次 apply() 会把整个 bridge xml 重写一遍
         * （该文件还混着全部设置项），亮屏档位下是持续的 flash 写入。
         *
         * 折中：内存变量供热路径（普通通道让位判定、诊断）读取，prefs 每
         * [A11Y_TS_PERSIST_MS] 落一次盘，仅作冷启动首帧的兜底参考。
         */
        @Volatile private var a11yTs = 0L

        /** 时间戳落盘节流间隔：远大于让位窗口（5s），避免每次轮询都重写 prefs。 */
        private const val A11Y_TS_PERSIST_MS = 5_000L

        /** 以内存值为准读取存活时间戳（冷启动由 prefs 兜底）。供双通道让位判定共用。 */
        internal fun readTs(context: Context): Long {
            val mem = a11yTs
            if (mem != 0L) return mem
            return context.getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)
                .getLong(A11Y_TS_KEY, 0L)
        }

        /** 普通通道让位判定：无障碍通道 5s 内刷新过存活时间戳则普通通道让位。 */
        internal fun shouldYieldToA11y(context: Context): Boolean =
            System.currentTimeMillis() - readTs(context) < A11Y_FRESH_MS

        /**
         * 让存活时间戳立即失效（通道下线时调用）。
         * 内存值归零后 [readTs] 回落到 prefs 的旧值，由「自然过期」继续兜底，
         * 与原设计的自愈语义保持一致。
         */
        internal fun invalidateTs() {
            a11yTs = 0L
        }

        /**
         * 刷新存活时间戳（轮询线程每轮调用）。
         * 只更新内存值，落盘按 [A11Y_TS_PERSIST_MS] 节流——让位判定的精度不受影响
         * （它读的是同一份内存值），但 flash 写入从每秒一次降到每 5 秒一次。
         */
        internal fun touchTs(context: Context, force: Boolean = false) {
            val now = System.currentTimeMillis()
            a11yTs = now
            val sp = context.getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)
            // force：连接/断开这类状态跃迁立即落盘，避免冷启动首帧读到陈旧值
            if (force || now - sp.getLong(A11Y_TS_KEY, 0L) >= A11Y_TS_PERSIST_MS) {
                sp.edit().putLong(A11Y_TS_KEY, now).apply()
            }
        }

        /** 普通通道让位判定窗口。 */
        const val A11Y_FRESH_MS = 5_000L

        /**
         * 诊断用活跃窗口：轮询线程在灭屏深度休眠时会被冻结几十秒以上（非 bug），
         * 用 5s 让位窗口做「已开启但未连接」诊断会误报——用户亮屏进设置页看到黄色
         * 警告以为权限出问题了。诊断放宽到 90s，超过才算真掉线。
         */
        private const val A11Y_DIAG_FRESH_MS = 90_000L

        /** 无障碍通道近期活跃（供外部诊断；5s 窗口仅用于双通道让位判定）。 */
        fun isA11yChannelFresh(context: Context): Boolean = shouldYieldToA11y(context)

        /** 无障碍通道近期活跃（诊断口径：90s 内有心跳即视为已连接，避免把深睡冻结误报成掉线）。 */
        fun isA11yActiveForDiag(context: Context): Boolean =
            System.currentTimeMillis() - readTs(context) < A11Y_DIAG_FRESH_MS

        /**
         * 系统无障碍设置里是否登记了本服务（不代表当前已连接）。
         * 「已登记但 ts 过期」= ROM 懒绑定/绑定被杀/应用被强停后未重绑，
         * 典型表现是悬浮窗不出现、需要把无障碍关一次再开——UI 层据此显示
         * 黄色警示并提供一键修复。
         */
        fun isEnabledInSystemSettings(context: Context): Boolean = try {
            val raw = Settings.Secure.getString(
                context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
            if (raw.isNullOrBlank()) false else {
                val cls = KeepAliveAccessibilityService::class.java.name
                val short = "." + cls.substringAfterLast('.')
                raw.split(":").any { entry ->
                    val c = entry.trim()
                    c.equals(context.packageName + "/" + cls, ignoreCase = true) ||
                        c.equals(context.packageName + short, ignoreCase = true)
                }
            }
        } catch (_: Exception) {
            false
        }

        /**
         * 经 WRITE_SECURE_SETTINGS 重置无障碍服务实现「一键修复」：
         * 把本服务从 ENABLED_ACCESSIBILITY_SERVICES 摘除再写回，强制系统解绑→重绑，
         * 替代用户手动「关闭再打开」。需要用户先经 adb 授予一次该权限：
         * `adb shell pm grant com.dsh.launcher android.permission.WRITE_SECURE_SETTINGS`
         *
         * @return true=已执行重置（等系统数秒内重连）；false=无权限或写入失败
         */
        fun repairViaSecureSettings(context: Context): Boolean {
            val granted = try {
                context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
            } catch (_: Exception) {
                false
            }
            if (!granted) return false
            return try {
                val cr = context.contentResolver
                val key = Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                val cls = KeepAliveAccessibilityService::class.java.name
                val mineFull = context.packageName + "/" + cls
                val mineShort = context.packageName + "/." + cls.substringAfterLast('.')
                val current = Settings.Secure.getString(cr, key) ?: ""
                // 摘除本服务（兼容全名与 .短名两种登记形式），保留其它服务的登记
                val others = current.split(":")
                    .map { it.trim() }
                    .filter { it.isNotEmpty() && !it.equals(mineFull, true) && !it.equals(mineShort, true) }
                Settings.Secure.putString(cr, key, others.joinToString(":"))
                Thread.sleep(600) // 给 AccessibilityManagerService 一点处理摘除的时间
                val restored = (others + mineFull).joinToString(":")
                Settings.Secure.putString(cr, key, restored)
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
