package com.dsh.launcher

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
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
 */
class KeepAliveAccessibilityService : AccessibilityService() {

    private var overlayManager: BridgeOverlayManager? = null
    private var polling = false
    private var pollThread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastStatus: String? = null
    private var lastFinishedAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs().edit().putBoolean("a11y_overlay_active", true).apply()
        overlayManager = BridgeOverlayManager(
            this,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            false
        )
        overlayManager?.resetDismissed()
        registerScreenReceiver()
        startPolling()
    }

    /** 锁屏/灭屏（含息屏指纹界面）不显示悬浮窗：灭屏隐藏，解锁后恢复显示。 */
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    prefs().edit().putBoolean("screen_visible", false).apply()
                    mainHandler.post { overlayManager?.remove() }
                }
                Intent.ACTION_SCREEN_ON -> {
                    val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                    if (!km.isKeyguardLocked) {
                        prefs().edit().putBoolean("screen_visible", true).apply()
                    }
                }
                Intent.ACTION_USER_PRESENT -> {
                    prefs().edit().putBoolean("screen_visible", true).apply()
                }
            }
        }
    }

    private fun registerScreenReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        runCatching { registerReceiver(screenReceiver, filter) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 只用于保活和悬浮窗，不处理事件
    }

    override fun onInterrupt() {
        // no-op
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        stopPolling()
        overlayManager?.remove()
        overlayManager?.release()
        overlayManager = null
        runCatching { unregisterReceiver(screenReceiver) }
        prefs().edit().putBoolean("a11y_overlay_active", false).apply()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        stopPolling()
        overlayManager?.remove()
        overlayManager?.release()
        overlayManager = null
        runCatching { unregisterReceiver(screenReceiver) }
        prefs().edit().putBoolean("a11y_overlay_active", false).apply()
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("status_bridge", Context.MODE_PRIVATE)

    private fun startPolling() {
        if (polling) return
        polling = true
        pollThread = thread {
            while (polling) {
                val data = fetchStatus()
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
                    Thread.sleep(1000L)
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

    private fun fetchStatus(): StatusData {
        return try {
            val conn = URL(STATUS_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 800
            conn.readTimeout = 800
            conn.requestMethod = "GET"
            conn.useCaches = false
            try {
                if (conn.responseCode != 200) return StatusData("idle", "", null, 0L)
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
            StatusData("idle", "", null, 0L)
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
    }
}