package com.dsh.launcher

import android.accessibilityservice.AccessibilityService
import android.content.Context
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

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs().edit().putBoolean("a11y_overlay_active", true).apply()
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

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        stopPolling()
        overlayManager?.remove()
        overlayManager = null
        prefs().edit().putBoolean("a11y_overlay_active", false).apply()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        stopPolling()
        overlayManager?.remove()
        overlayManager = null
        prefs().edit().putBoolean("a11y_overlay_active", false).apply()
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("status_bridge", Context.MODE_PRIVATE)

    private fun startPolling() {
        if (polling) return
        polling = true
        pollThread = thread {
            while (polling) {
                val status = fetchStatus()
                mainHandler.post {
                    overlayManager?.update(status.first, status.second)
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

    private fun fetchStatus(): Pair<String, String> {
        return try {
            val conn = URL(STATUS_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 800
            conn.readTimeout = 800
            conn.requestMethod = "GET"
            conn.useCaches = false
            try {
                if (conn.responseCode != 200) return "idle" to ""
                val text = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                val obj = JSONObject(text)
                val status = obj.optString("status", "idle")
                val lastText = obj.optString("text", "")
                status to lastText
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            "idle" to ""
        }
    }

    companion object {
        private const val STATUS_URL = "http://127.0.0.1:3190/status"
    }
}