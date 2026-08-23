package com.dsh.launcher

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

/**
 * 无障碍悬浮桥接服务：
 * - 通过 TYPE_ACCESSIBILITY_OVERLAY 绘制 dsh 状态悬浮窗；
 * - 无障碍服务由系统保活，后台被杀的几率远低于普通前台服务；
 * - 不读取、不处理任何屏幕内容，只轮询本机 dsh status HTTP 接口。
 *
 * 与普通通道（StatusBridgeService）的协调：
 * - 每次轮询刷新 prefs 的 [A11Y_TS_KEY] 时间戳，普通通道仅在时间窗口内刷新过才让位——
 *   宿主被杀时 onUnbind/onDestroy 不回调，旧布尔标志会陈旧残留（跨重启持久化），
 *   曾导致双通道互相谦让全灭；
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

    override fun onServiceConnected() {
        super.onServiceConnected()
        // 立即刷新时间戳：连接瞬间就让普通通道开始让位（不等第一次轮询）
        prefs().edit().putLong(A11Y_TS_KEY, System.currentTimeMillis()).apply()
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
        stopPolling()
        overlayManager?.remove()
        overlayManager?.release()
        overlayManager = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        stopPolling()
        overlayManager?.remove()
        overlayManager?.release()
        overlayManager = null
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("status_bridge", Context.MODE_PRIVATE)

    private fun startPolling() {
        if (polling) return
        polling = true
        pollThread = thread {
            while (polling) {
                // 自适应档位 + 心跳时间戳（普通通道据此判断本通道是否活着）
                PowerGovernor.refreshScreenState(this)
                PowerGovernor.setTaskStatus(lastStatus)
                prefs().edit().putLong(A11Y_TS_KEY, System.currentTimeMillis()).apply()
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

        /** 无障碍通道存活时间戳的 prefs 键（值 = System.currentTimeMillis()）。 */
        const val A11Y_TS_KEY = "a11y_overlay_ts"

        /** 普通通道让位判定窗口。 */
        const val A11Y_FRESH_MS = 5_000L

        /** 无障碍通道近期活跃（供外部诊断）。 */
        fun isA11yChannelFresh(context: Context): Boolean =
            System.currentTimeMillis() - context.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
                .getLong(A11Y_TS_KEY, 0L) < A11Y_FRESH_MS

        /**
         * 系统无障碍设置里是否登记了本服务（不代表当前已连接）。
         * 「已登记但 ts 过期」= ROM 懒绑定/绑定被杀，典型表现是悬浮窗不出现、
         * 需要用户把无障碍关一次再开——UI 层据此显示黄色警示并引导去重连。
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
    }
}
