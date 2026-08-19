package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.SystemClock
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
 *
 * 支持两种模式（prefs key: overlay_style）：
 * - "pill"：原状态条模式（紧凑文字悬浮窗）；
 * - "pet"：安卓桌宠模式（Codex 桌宠格式精灵动画 + 状态气泡）。
 * 长按悬浮窗可在两种模式间切换；点击打开 dsh Web，拖动调整位置。
 */
class BridgeOverlayManager(
    private val context: Context,
    requestedWindowType: Int,
    private val requiresOverlayPermission: Boolean
) {
    // TYPE_APPLICATION_OVERLAY 需要 API 26+；API 24/25 回退 TYPE_PHONE，保持与旧实现一致
    @Suppress("DEPRECATION")
    private val windowType: Int = if (
        requestedWindowType == WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY &&
        Build.VERSION.SDK_INT < 26
    ) {
        WindowManager.LayoutParams.TYPE_PHONE
    } else {
        requestedWindowType
    }
    private var windowManager: WindowManager? = null
    private var overlayView: LinearLayout? = null
    private var overlayText: TextView? = null
    private var overlayDot: View? = null
    private var overlayClose: TextView? = null
    private var overlayParams: WindowManager.LayoutParams? = null

    // 桌宠模式
    private var petView: PetOverlayView? = null
    private var petBubble: TextView? = null
    private var petClose: TextView? = null
    private var petAtlas: CodexPetAtlas? = null
    private var petLoadedId: String? = null

    private var currentStyle: String? = null
    private var lastStatus: String? = null
    private var lastText: String? = null
    private var lastEvent: String? = null

    private var dragStartX = 0
    private var dragStartY = 0
    private var dragStartTouchX = 0f
    private var dragStartTouchY = 0f
    private var dragMoved = false
    private var downAt = 0L
    private val dragSlop = dp(4)

    private fun prefs() = context.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
    private fun overlayEnabled() = prefs().getBoolean("overlay_enabled", true)
    private fun showStatus() = prefs().getBoolean("show_status", true)
    private fun showLastText() = prefs().getBoolean("show_last_text", true)
    private fun overlayStyle(): String = prefs().getString("overlay_style", "pill") ?: "pill"
    private fun petId(): String =
        prefs().getString("pet_id", CodexPetStore.DEFAULT_PET_ID) ?: CodexPetStore.DEFAULT_PET_ID
    private fun showPetBubble() = prefs().getBoolean("pet_show_bubble", true)
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
        lastStatus = status
        lastText = text
        lastEvent = event
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
        val style = overlayStyle()
        if (currentStyle != style) {
            remove()
            currentStyle = style
        }
        if (style == "pet") {
            showPet(status, text, event)
        } else {
            show(status, text, event)
        }
    }

    fun resetDismissed() {
        prefs().edit().putBoolean("overlay_dismissed", false).apply()
    }

    /** 悬浮窗是否已挂载（供诊断心跳使用）。 */
    fun hasOverlay(): Boolean = overlayView?.isAttachedToWindow == true

    // ---------------- 状态条模式 ----------------

    private fun show(status: String, text: String, event: String?) {
        if (prefs().getBoolean("overlay_dismissed", false)) return
        if (overlayView != null) {
            if (overlayView?.isAttachedToWindow == true) {
                updateText(status, text, event)
                return
            }
            resetViews()
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
            contentDescription = "dsh 状态条：点击打开 Web，拖动调整位置，长按切换桌宠"
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
        overlayParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            windowType,
            overlayFlags(),
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = prefs().getInt("overlay_x", dp(10))
            // 默认放低一些，避免覆盖应用标题区（y=80 会遮住主界面标题）
            y = prefs().getInt("overlay_y", dp(150))
        }
        try {
            overlayView?.let { windowManager?.addView(it, overlayParams) }
            updateText(status, text, event)
        } catch (e: Exception) {
            resetViews()
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

    // ---------------- 桌宠模式 ----------------

    private fun showPet(status: String, text: String, event: String?) {
        if (prefs().getBoolean("overlay_dismissed", false)) return
        val wantedId = petId()
        if (overlayView != null) {
            if (overlayView?.isAttachedToWindow == true) {
                if (petLoadedId == wantedId) {
                    updatePet(status, text, event)
                    return
                }
                // 设置页更换了桌宠：重建当前桌宠窗口
                resetViews()
            } else {
                resetViews()
            }
        }
        if (petAtlas == null || petLoadedId != wantedId) {
            petAtlas = null
            val pets = CodexPetStore.scanPets(context)
            val pet = pets.firstOrNull { it.id == wantedId }
                ?: pets.firstOrNull()
                ?: CodexPetStore.defaultPet()
            petAtlas = CodexPetStore.openAtlas(context, pet)
            petLoadedId = if (petAtlas != null) pet.id else null
            if (petAtlas == null) {
                // 用户包加载失败时回退内置默认（petLoadedId 保持默认，后续轮询可自愈）
                petAtlas = CodexPetStore.openAtlas(context, CodexPetStore.defaultPet())
                petLoadedId = if (petAtlas != null) CodexPetStore.DEFAULT_PET_ID else null
            }
        }
        val atlas = petAtlas ?: return
        windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

        val petH = dp(132)
        val petW = if (atlas.cellH > 0) (petH * atlas.cellW / atlas.cellH.toFloat()).toInt() else petH
        val pet = PetOverlayView(context, atlas)
        petView = pet
        petBubble = TextView(context).apply {
            textSize = 12f
            setTextColor(0xFFF2F5FA.toInt())
            includeFontPadding = false
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = (context.resources.displayMetrics.widthPixels * 0.6).toInt()
            setPadding(dp(10), dp(5), dp(10), dp(5))
            background = roundedDrawable(0xE0101722.toInt(), 12, 1, 0x336C8CFF.toInt())
        }
        petClose = TextView(context).apply {
            setText(" ×")
            textSize = 15f
            setTextColor(0xAAFFFFFF.toInt())
            setPadding(dp(4), 0, dp(2), 0)
            setOnClickListener {
                prefs().edit().putBoolean("overlay_dismissed", true).apply()
                remove()
            }
        }
        val bubbleRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(petBubble, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
            addView(petClose)
        }
        overlayView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            contentDescription = "dsh 桌宠：点击打开 Web，拖动移动，长按切回状态条"
            if (Build.VERSION.SDK_INT >= 21) elevation = dp(6).toFloat()
            addView(bubbleRow, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(4) })
            addView(pet, LinearLayout.LayoutParams(petW, petH))
            setOnTouchListener(overlayTouchListener)
        }
        overlayParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            windowType,
            overlayFlags(),
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val dm = context.resources.displayMetrics
            x = prefs().getInt("pet_x", dm.widthPixels - dp(150))
            y = prefs().getInt("pet_y", dm.heightPixels - dp(420))
        }
        try {
            overlayView?.let { windowManager?.addView(it, overlayParams) }
            updatePet(status, text, event)
        } catch (e: Exception) {
            resetViews()
        }
    }

    private fun updatePet(status: String, text: String, event: String?) {
        petView?.play(PetOverlayView.actionRowFor(status, event))
        petBubble?.let { bubble ->
            if (showPetBubble()) {
                bubble.text = buildPetBubbleText(status, text, event)
                bubble.visibility = View.VISIBLE
            } else {
                bubble.visibility = View.GONE
            }
        }
    }

    private fun buildPetBubbleText(status: String, text: String, event: String?): String {
        val label = statusLabel(status, event)
        val snippet = if (showLastText() && text.isNotBlank()) text.take(40) else ""
        return listOf(label, snippet).filter { it.isNotBlank() }.joinToString(" · ")
    }

    // ---------------- 公共移除/切换 ----------------

    fun remove() {
        petView?.stop()
        try {
            overlayView?.let { windowManager?.removeView(it) }
        } catch (e: Exception) {
            // already removed
        }
        resetViews()
        currentStyle = null
    }

    private fun resetViews() {
        overlayView = null
        overlayText = null
        overlayDot = null
        overlayClose = null
        overlayParams = null
        petView = null
        petBubble = null
        petClose = null
    }

    /** 长按切换状态条/桌宠模式，下次状态轮询（≤1s）生效。 */
    private fun toggleStyle() {
        val next = if (overlayStyle() == "pet") "pill" else "pet"
        prefs().edit().putString("overlay_style", next).apply()
        remove()
    }

    private fun overlayFlags(): Int =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL

    // ---------------- 样式工具 ----------------

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
                downAt = SystemClock.uptimeMillis()
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
                    if (SystemClock.uptimeMillis() - downAt >= 600L) {
                        toggleStyle()
                    } else {
                        openWeb()
                    }
                } else {
                    savePosition(p)
                }
                true
            }
            MotionEvent.ACTION_CANCEL -> true
            else -> false
        }
    }

    private fun savePosition(p: WindowManager.LayoutParams) {
        val isPet = overlayStyle() == "pet"
        prefs().edit()
            .putInt(if (isPet) "pet_x" else "overlay_x", p.x)
            .putInt(if (isPet) "pet_y" else "overlay_y", p.y)
            .apply()
    }

    private fun dp(v: Int): Int = (v * context.resources.displayMetrics.density).toInt()
}
