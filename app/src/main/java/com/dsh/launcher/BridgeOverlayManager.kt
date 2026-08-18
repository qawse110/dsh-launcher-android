package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 通用 dsh 状态悬浮窗管理器。
 * 可被普通前台服务（TYPE_APPLICATION_OVERLAY）或无障碍服务（TYPE_ACCESSIBILITY_OVERLAY）复用。
 */
class BridgeOverlayManager(
    private val context: Context,
    private val windowType: Int,
    private val requiresOverlayPermission: Boolean
) {
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
    private var dragMoved = false
    private val dragSlop = dp(4)

    private fun prefs() = context.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
    private fun overlayEnabled() = prefs().getBoolean("overlay_enabled", true)
    private fun showStatus() = prefs().getBoolean("show_status", true)
    private fun showLastText() = prefs().getBoolean("show_last_text", true)
    private fun displayMode(): String {
        return if (prefs().getBoolean("display_mode_auto", true)) {
            "auto"
        } else {
            prefs().getString("display_mode", "compact") ?: "compact"
        }
    }

    private fun useFullMode(text: String): Boolean {
        val mode = displayMode()
        return when (mode) {
            "full" -> true
            "compact" -> false
            else -> text.length > 20
        }
    }

    private fun hideWhenIdle() = prefs().getBoolean("hide_when_idle", false)

    fun update(status: String, text: String, event: String? = null) {
        if (!overlayEnabled()) {
            remove()
            return
        }
        if (hideWhenIdle() && status == "idle") {
            remove()
            return
        }
        if (requiresOverlayPermission && !Settings.canDrawOverlays(context)) {
            remove()
            return
        }
        show(status, text, event)
    }

    fun resetDismissed() {
        prefs().edit().putBoolean("overlay_dismissed", false).apply()
    }

    private fun show(status: String, text: String, event: String?) {
        if (prefs().getBoolean("overlay_dismissed", false)) return
        if (overlayView != null) {
            if (overlayView?.isAttachedToWindow == true) {
                updateText(status, text, event)
                return
            }
            overlayView = null
            overlayText = null
            overlayDot = null
            overlayClose = null
            overlayParams = null
        }
        windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        overlayDot = View(context).apply {
            background = circleDrawable(statusColor(status))
        }
        overlayText = TextView(context).apply {
            textSize = 12f
            setTextColor(0xFFF2F5FA.toInt())
            includeFontPadding = false
            isSingleLine = displayMode() != "full"
            maxLines = if (displayMode() == "full") 3 else 1
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = (context.resources.displayMetrics.widthPixels * 0.72).toInt()
        }
        overlayClose = TextView(context).apply {
            setText(" ×")
            textSize = 16f
            setTextColor(0xAAFFFFFF.toInt())
            setPadding(dp(6), 0, dp(2), 0)
            setOnClickListener {
                prefs().edit().putBoolean("overlay_dismissed", true).apply()
                remove()
            }
        }
        overlayView = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = "点击打开 dsh Web，拖动调整位置"
            background = roundedDrawable(0xDD101722.toInt(), 14, 1, 0x33283A55.toInt())
            if (Build.VERSION.SDK_INT >= 21) elevation = dp(6).toFloat()
            setPadding(dp(12), dp(8), dp(6), dp(8))
            addView(overlayDot, LinearLayout.LayoutParams(dp(8), dp(8)).apply { rightMargin = dp(6) })
            addView(overlayText, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
            addView(overlayClose)
            setOnTouchListener(overlayTouchListener)
        }
        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        overlayParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            windowType,
            flags,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = prefs().getInt("overlay_x", dp(8))
            y = prefs().getInt("overlay_y", dp(80))
        }
        try {
            overlayView?.let { windowManager?.addView(it, overlayParams) }
            updateText(status, text, event)
        } catch (e: Exception) {
            overlayView = null
            overlayDot = null
            overlayClose = null
            overlayParams = null
        }
    }

    private fun updateText(status: String, text: String, event: String?) {
        val tv = overlayText ?: return
        overlayDot?.background = circleDrawable(statusColor(status))
        overlayView?.background = roundedDrawable(
            statusBackground(status),
            14,
            1,
            statusBorder(status)
        )
        val full = useFullMode(text)
        tv.text = buildOverlayText(
            status,
            event,
            text,
            showStatus(),
            showLastText(),
            full
        )
        tv.isSingleLine = !full
        tv.maxLines = if (full) 3 else 1
    }

    fun remove() {
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

    private fun statusBackground(status: String): Int = when (status) {
        "running" -> 0xEE182238.toInt()
        "finished" -> 0xEE1B2A24.toInt()
        else -> 0xDD101722.toInt()
    }

    private fun statusBorder(status: String): Int = when (status) {
        "running" -> 0x446C8CFF.toInt()
        "finished" -> 0x445FD68A.toInt()
        else -> 0x33283A55.toInt()
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

    private fun openWeb() {
        try {
            context.startActivity(
                Intent(context, WebViewActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Exception) {
            // Activity 启动失败时静默忽略，保持悬浮窗可用
        }
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
                dragMoved = false
                true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - dragStartTouchX
                val dy = event.rawY - dragStartTouchY
                if (!dragMoved && (Math.abs(dx) > dragSlop || Math.abs(dy) > dragSlop)) {
                    dragMoved = true
                }
                if (dragMoved) {
                    p.x = dragStartX + dx.toInt()
                    p.y = dragStartY + dy.toInt()
                    try { manager.updateViewLayout(view, p) } catch (e: Exception) {}
                }
                true
            }
            MotionEvent.ACTION_UP -> {
                if (!dragMoved) {
                    openWeb()
                } else {
                    prefs().edit().putInt("overlay_x", p.x).putInt("overlay_y", p.y).apply()
                }
                true
            }
            MotionEvent.ACTION_CANCEL -> true
            else -> false
        }
    }

    private fun dp(v: Int): Int = (v * context.resources.displayMetrics.density).toInt()
}