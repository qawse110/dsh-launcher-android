package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.text.TextUtils
import java.util.Locale
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.random.Random

/**
 * 通用 dsh 状态悬浮窗管理器。
 * 可被普通前台服务（TYPE_APPLICATION_OVERLAY）或无障碍服务（TYPE_ACCESSIBILITY_OVERLAY）复用。
 *
 * 支持两种模式（prefs key: overlay_style）：
 * - "pill"：原状态条模式（紧凑文字悬浮窗）；
 * - "pet"：安卓桌宠模式（Codex 桌宠格式精灵动画 + 状态气泡）。
 * 长按悬浮窗可在两种模式间切换；桌宠本体点击互动、气泡点击打开 dsh Web，拖动调整位置。
 * 桌宠大小（pet_size：small/medium/large）、气泡开关（pet_show_bubble）与
 * TTS 发声（pet_tts）均由设置页配置。
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
    private var petName: String = ""
    private var petReplies: List<String> = emptyList()
    private var petBuiltHeightDp = 132
    private var petAtlasForHeightDp = 132
    private var defaultAtlas: CodexPetAtlas? = null
    private var defaultAtlasForHeightDp = 132

    private val handler = Handler(Looper.getMainLooper())
    private var downOnPet = false

    // 气泡临时内容（点击桌宠展开完整内容 / 无内容时随机台词兜底 / 问候 / 闲时冒泡）
    private var transientText: String? = null
    private var transientKey: String? = null
    private var transientRunnable: Runnable? = null

    // 互动与闲时行为（参考 codex-pet-live 的 patpat / 主动气泡模型）
    private var tapCount = 0
    private var tapWindowStart = 0L
    private var ambientRunnable: Runnable? = null
    private var greeted = false

    // 双击检测：单击随机台词 / 双击展开完整内容
    private var lastTapAt = 0L

    // 待机随机小动作：idle 时每 20~45s 随机挥手一次，打破无限循环待机的机械感
    private var idleActRunnable: Runnable? = null

    // 动画行切换稳定窗口：同一目标行连续 ≥2 次轮询（≈2s）才真正切换，
    // 避免 tool/call ↔ assistant/message 状态抖动导致桌宠频繁换动作
    private var pendingRow = -1
    private var pendingRowCount = 0
    private var lastSpokeAt = 0L

    // TTS 发声（桌宠模式）
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsReleased = false
    private var lastSpokenKey: String? = null

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

    // 拖拽抛落物理（参考 codex-pet-live 的 drop/gravity）：松手后抛物线坠落、
    // 撞墙反弹、落地小弹跳后自动走回屏幕侧边待机（抬升避开底部导航）
    private val FALL_GRAVITY = 2400f // px/s²
    private var falling = false
    private var fallVx = 0f
    private var fallVy = 0f
    private var fallBounces = 0
    private val moveSamples = ArrayDeque<FloatArray>() // [x, y, uptimeMillis]
    private val fallTicker = object : Runnable {
        override fun run() = stepFall()
    }
    private var walking = false
    private var walkTargetX = 0
    private var walkTargetY = 0
    private val walkTicker = object : Runnable {
        override fun run() = stepWalk()
    }

    private fun prefs() = context.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
    private fun overlayEnabled() = prefs().getBoolean("overlay_enabled", true)
    private fun showStatus() = prefs().getBoolean("show_status", true)
    private fun showLastText() = prefs().getBoolean("show_last_text", true)
    private fun overlayStyle(): String = prefs().getString("overlay_style", "pill") ?: "pill"
    private fun petId(): String =
        prefs().getString("pet_id", CodexPetStore.DEFAULT_PET_ID) ?: CodexPetStore.DEFAULT_PET_ID
    private fun showPetBubble() = prefs().getBoolean("pet_show_bubble", true)
    private fun petTts() = prefs().getBoolean("pet_tts", true)
    private fun showPetName() = prefs().getBoolean("pet_show_name", true)
    private fun showAmbientBubble() = prefs().getBoolean("pet_ambient_bubble", true)
    private fun petHeightDp(): Int = when (prefs().getString("pet_size", "medium")) {
        "small" -> 96
        "large" -> 176
        else -> 132
    }
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
                if (petLoadedId == wantedId && petBuiltHeightDp == petHeightDp()) {
                    updatePet(status, text, event)
                    return
                }
                // 设置页更换了桌宠或桌宠大小：重建当前桌宠窗口
                resetViews()
            } else {
                resetViews()
            }
        }
        if (petAtlas == null || petLoadedId != wantedId || petAtlasForHeightDp != petHeightDp()) {
            petAtlas = null
            val pets = CodexPetStore.scanPets(context)
            val pet = pets.firstOrNull { it.id == wantedId }
                ?: pets.firstOrNull()
                ?: CodexPetStore.defaultPet()
            petName = pet.displayName
            petReplies = pet.replies
            petAtlas = CodexPetStore.openAtlas(context, pet, petHeightDp())
            petLoadedId = if (petAtlas != null) pet.id else null
            if (petAtlas == null) {
                // 用户包加载失败时回退内置默认（petLoadedId 保持默认，后续轮询可自愈）；
                // 默认图集缓存，避免每轮重新解码
                if (defaultAtlas == null || defaultAtlasForHeightDp != petHeightDp()) {
                    defaultAtlas = CodexPetStore.openAtlas(context, CodexPetStore.defaultPet(), petHeightDp())
                    defaultAtlasForHeightDp = if (defaultAtlas != null) petHeightDp() else defaultAtlasForHeightDp
                }
                petAtlas = defaultAtlas
                petLoadedId = if (petAtlas != null) CodexPetStore.DEFAULT_PET_ID else null
                petName = CodexPetStore.defaultPet().displayName
                petReplies = CodexPetStore.defaultPet().replies
            }
            petAtlasForHeightDp = if (petAtlas != null) petHeightDp() else petAtlasForHeightDp
        }
        val atlas = petAtlas ?: return
        windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

        petBuiltHeightDp = petHeightDp()
        val petH = dp(petBuiltHeightDp)
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
            setOnClickListener { openWeb() }
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
            contentDescription = "dsh 桌宠：点击宠物互动，点气泡打开 Web，拖动移动，长按切回状态条"
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
        // 动作稳定窗口：同目标行连续 ≥2 次轮询才切换，避免状态抖动引发频繁变动作
        // （靠边走回待机中不作状态行切换，保持行走动画）
        val target = PetOverlayView.actionRowFor(status, event)
        if (!walking) {
            if (target == pendingRow) {
                pendingRowCount++
            } else {
                pendingRow = target
                pendingRowCount = 1
            }
            if (pendingRowCount >= 2) petView?.play(target)
        }
        speakForStatus(status, event)
        petBubble?.let { bubble ->
            val key = "$status|${event ?: ""}"
            if (transientText != null) {
                if (key == transientKey) return@let // 展开完整内容中且状态未变：保持不动
                cancelTransient() // 状态变化：收起，恢复常规气泡
            }
            if (showPetBubble()) {
                bubble.maxLines = 2
                bubble.ellipsize = TextUtils.TruncateAt.END
                bubble.maxWidth = (context.resources.displayMetrics.widthPixels * 0.6).toInt()
                bubble.text = buildPetBubbleText(status, text, event, petName)
                bubble.visibility = View.VISIBLE
            } else {
                bubble.visibility = View.GONE
            }
            if (!greeted) {
                greeted = true
                if (showPetBubble()) showGreeting()
            }
            if (ambientRunnable == null) scheduleAmbient()
            if (idleActRunnable == null) scheduleIdleAct()
        }
    }

    private fun buildPetBubbleText(status: String, text: String, event: String?, name: String): String {
        val namePart = if (showPetName()) name else ""
        val label = if (showStatus()) statusLabel(status, event) else ""
        val snippet = if (showLastText() && text.isNotBlank()) text.take(40) else ""
        return listOf(namePart, label, snippet).filter { it.isNotBlank() }.joinToString(" · ")
    }

    /** 点击桌宠本体（参考 codex-pet-live patpat）：
     *  快速连点 ≥5 次 → 被戳烦了跳一下 + 吐槽台词；
     *  单击 → 挥手互动 + 随机台词短气泡；
     *  双击（400ms 内第二击）→ 挥手 + 气泡展开最近完整内容。 */
    private fun showTapFeedback() {
        val now = SystemClock.uptimeMillis()
        if (now - tapWindowStart > 4000L) {
            tapCount = 1
            tapWindowStart = now
        } else {
            tapCount++
        }
        if (tapCount >= 5) {
            tapCount = 0
            lastTapAt = 0L
            petView?.play(PetOverlayView.ROW_JUMPING)
            postTransient("主人别戳啦～", 2, 0.6f, 3500L)
            speak("主人别戳啦～")
            return
        }
        petView?.play(PetOverlayView.ROW_WAVING)
        if (now - lastTapAt < 400L) {
            // 双击：展开完整内容（较长展示，8 秒或状态变化后收起）
            tapCount = 0
            lastTapAt = 0L
            val full = lastText?.takeIf { it.isNotBlank() }
            if (full != null) {
                val dm = context.resources.displayMetrics
                val overlay = overlayParams
                val avail = if (overlay != null) dm.widthPixels - overlay.x - dp(8)
                else dm.widthPixels - dp(8)
                val width = minOf((dm.widthPixels * 0.85f).toInt(), avail.coerceAtLeast(dp(120)))
                postTransient(full, 1000, width.toFloat(), 8000L)
            } else {
                val reply = randomQuip()
                postTransient(reply, 2, 0.6f, 8000L)
                speak(reply)
            }
        } else {
            // 单击：随机台词短气泡（快速、不挡视线）
            lastTapAt = now
            val quip = randomQuip()
            postTransient(quip, 2, 0.6f, 5000L)
            speak(quip)
        }
    }

    /** 统一气泡临时内容：设置文本与样式，durationMs 后或状态变化时自动收起恢复常规气泡。 */
    private fun postTransient(text: String, maxLines: Int, maxWidth: Float, durationMs: Long) {
        val bubble = petBubble ?: return
        cancelTransient()
        bubble.maxLines = maxLines
        bubble.ellipsize = if (maxLines > 2) null else TextUtils.TruncateAt.END
        bubble.maxWidth = maxWidth.toInt()
        bubble.text = text
        bubble.visibility = View.VISIBLE
        transientText = text
        transientKey = "$lastStatus|${lastEvent ?: ""}"
        val r = Runnable {
            cancelTransient()
            val s = lastStatus
            val t = lastText
            if (s != null && t != null) updatePet(s, t, lastEvent)
        }
        transientRunnable = r
        handler.postDelayed(r, durationMs)
    }

    private fun cancelTransient() {
        transientRunnable?.let { handler.removeCallbacks(it) }
        transientRunnable = null
        transientText = null
        transientKey = null
    }

    private fun randomPetPhrase(): String =
        if (petReplies.isNotEmpty()) petReplies[Random.nextInt(petReplies.size)] else "主人，我在呢～"

    /** 点击互动随机台词：优先宠物包台词，否则内置短句池。 */
    private val quipPool = listOf(
        "主人，我在呢～", "怎么啦？", "嘿嘿，戳我干嘛～", "我在认真盯任务呢！", "想我了吗～"
    )
    private fun randomQuip(): String =
        if (petReplies.isNotEmpty()) petReplies[Random.nextInt(petReplies.size)]
        else quipPool[Random.nextInt(quipPool.size)]

    /** 登场问候一次（参考 codex-pet-live 的 greeting 气泡）。 */
    private fun showGreeting() {
        val name = petName.takeIf { it.isNotBlank() }
        val phrase = if (name != null) "你好呀，我是 $name！" else "你好呀～"
        postTransient(phrase, 2, 0.6f, 4000L)
    }

    /** 闲时主动冒泡（参考 codex-pet-live 的 ambient/scheduled 气泡）：dsh 空闲时
     *  每隔 2.5~5 分钟随机说一句台词，播完恢复状态气泡。 */
    private fun scheduleAmbient() {
        ambientRunnable?.let { handler.removeCallbacks(it) }
        val delay = Random.nextLong(150_000L, 300_000L)
        val r = Runnable {
            maybeShowAmbientBubble()
            scheduleAmbient()
        }
        ambientRunnable = r
        handler.postDelayed(r, delay)
    }

    private fun maybeShowAmbientBubble() {
        if (!showAmbientBubble()) return
        if (lastStatus != "idle") return // 只在闲时冒泡
        if (transientText != null) return
        if (petBubble == null) return
        val phrase = randomPetPhrase()
        postTransient(phrase, 2, 0.6f, 5000L)
        speak(phrase)
    }

    /** 待机随机小动作（参考 codex-pet-live 的随机动作池）：idle 时随机挥手，纯动作不打扰气泡。 */
    private fun scheduleIdleAct() {
        idleActRunnable?.let { handler.removeCallbacks(it) }
        val delay = Random.nextLong(20_000L, 45_000L)
        val r = Runnable {
            maybeIdleAct()
            scheduleIdleAct()
        }
        idleActRunnable = r
        handler.postDelayed(r, delay)
    }

    private fun maybeIdleAct() {
        if (falling || walking) return
        if (lastStatus != "idle") return
        if (petView == null) return
        // 只做挥手：一次性动作自动落地，且不干扰后续「完成」跳跃庆祝
        petView?.play(PetOverlayView.ROW_WAVING)
    }

    // ---------------- 桌宠 TTS 发声 ----------------

    /** 状态转折时播报固定台词（同状态只播一次，且间隔 ≥4s 防反弹连播）。 */
    private fun speakForStatus(status: String, event: String?) {
        val key = "$status|${event ?: ""}"
        if (key == lastSpokenKey) return
        lastSpokenKey = key
        if (SystemClock.uptimeMillis() - lastSpokeAt < 4000L) return
        val phrase = when {
            status == "finished" -> "任务完成，太棒了！"
            status == "failed" -> "出错了，快打开 Web 看看吧"
            status == "running" && event == "tool/call" -> "正在调用工具，稍等一下"
            status == "running" && event == "turn/start" -> "收到新任务，开始干活！"
            else -> null
        }
        if (phrase != null) {
            lastSpokeAt = SystemClock.uptimeMillis()
            speak(phrase)
        }
    }

    /** 朗读文本（懒初始化 TTS；无中文引擎自动回退系统默认语言；失败静默）。 */
    private fun speak(text: String) {
        if (ttsReleased || !petTts() || text.isBlank()) return
        if (tts == null) {
            tts = TextToSpeech(context) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    val ok = (tts?.isLanguageAvailable(Locale.CHINA) ?: -1) >= TextToSpeech.LANG_AVAILABLE
                    tts?.setLanguage(if (ok) Locale.CHINA else Locale.getDefault())
                }
            }
        }
        if (!ttsReady) return
        try {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "dsh_pet")
        } catch (_: Exception) {
            // TTS 不可用时静默
        }
    }

    /** 释放 TTS 资源（服务销毁时调用；释放后不再重建）。 */
    fun release() {
        ttsReleased = true
        tts?.shutdown()
        tts = null
        ttsReady = false
    }

    // ---------------- 公共移除/切换 ----------------

    fun remove() {
        resetViews()
        currentStyle = null
    }

    /** 彻底拆除当前悬浮窗（含窗口移除、动画停止、临时气泡取消），引用全部置空。 */
    private fun resetViews() {
        cancelTransient()
        stopFall()
        stopWalk()
        idleActRunnable?.let { handler.removeCallbacks(it) }
        idleActRunnable = null
        ambientRunnable?.let { handler.removeCallbacks(it) }
        ambientRunnable = null
        greeted = false
        tapCount = 0
        petView?.stop()
        lastSpokenKey = null
        lastSpokeAt = 0L
        pendingRow = -1
        pendingRowCount = 0
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
                stopFall()
                stopWalk()
                moveSamples.clear()
                downOnPet = isTapOnPet(event.x, event.y)
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
                    moveSamples.addLast(
                        floatArrayOf(p.x.toFloat(), p.y.toFloat(), SystemClock.uptimeMillis().toFloat())
                    )
                    val nowMs = SystemClock.uptimeMillis()
                    while (moveSamples.size > 10 || (moveSamples.isNotEmpty() &&
                            nowMs - moveSamples.first()[2] > 250L)
                    ) {
                        moveSamples.removeFirst()
                    }
                    try { manager.updateViewLayout(view, p) } catch (e: Exception) {}
                }
                true
            }
            MotionEvent.ACTION_UP -> {
                stopFall()
                if (!dragMoved) {
                    if (SystemClock.uptimeMillis() - downAt >= 600L) {
                        toggleStyle()
                    } else if (downOnPet) {
                        showTapFeedback()
                    } else {
                        openWeb()
                    }
                } else {
                    savePosition(p)
                    if (overlayStyle() == "pet" && petFall()) startFallFromDrag(p)
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

    // ---------------- 拖拽抛落物理（参考 codex-pet-live） ----------------

    private fun petFall(): Boolean = prefs().getBoolean("pet_fall", true)

    private fun stopFall() {
        falling = false
        handler.removeCallbacks(fallTicker)
    }

    /** 松手瞬间根据最近拖动采样估算抛出速度，开始抛物线坠落。 */
    private fun startFallFromDrag(p: WindowManager.LayoutParams) {
        var vx = 0f
        var vy = 0f
        if (moveSamples.size >= 2) {
            val a = moveSamples.first()
            val b = moveSamples.last()
            val dt = (b[2] - a[2]) / 1000f
            if (dt > 0.03f && dt < 0.35f) {
                vx = (b[0] - a[0]) / dt
                vy = (b[1] - a[1]) / dt
            }
        }
        falling = true
        fallVx = vx.coerceIn(-3200f, 3200f)
        fallVy = vy.coerceIn(-3200f, 3200f)
        fallBounces = 0
        handler.removeCallbacks(fallTicker)
        handler.postDelayed(fallTicker, 16L)
    }

    /** 一帧物理：重力下落、空气阻力、撞左右墙反弹、落地小弹跳（最多 2 次）后静止。 */
    private fun stepFall() {
        if (!falling) return
        val p = overlayParams ?: return
        val manager = windowManager ?: return
        val view = overlayView ?: return
        val dm = context.resources.displayMetrics
        val dt = 0.016f
        fallVy += FALL_GRAVITY * dt
        fallVx *= 0.998f
        var nx = p.x + fallVx * dt
        var ny = p.y + fallVy * dt
        val right = (dm.widthPixels - view.width).toFloat()
        if (nx < 0f) {
            nx = 0f
            fallVx = -fallVx * 0.55f
        }
        if (nx > right) {
            nx = right
            fallVx = -fallVx * 0.55f
        }
        val floor = (dm.heightPixels - view.height).toFloat()
        if (ny >= floor) {
            ny = floor
            if (fallVy > 260f && fallBounces < 2) {
                fallVy = -fallVy * 0.38f
                fallVx *= 0.7f
                fallBounces++
                petView?.play(PetOverlayView.ROW_JUMPING)
            } else {
                falling = false
                handler.removeCallbacks(fallTicker)
                petView?.play(PetOverlayView.ROW_IDLE)
                walkToEdge(p) // 落地后自动走回侧边待机，避免一直停在底部挡操作
                return
            }
        }
        p.x = nx.toInt()
        p.y = ny.toInt()
        try { manager.updateViewLayout(view, p) } catch (e: Exception) {}
        if (falling) handler.postDelayed(fallTicker, 16L)
    }

    /** 落地后自动靠边待机：走回较近的屏幕侧边，并抬升到底部导航区之上。 */
    private fun walkToEdge(p: WindowManager.LayoutParams) {
        val view = overlayView ?: return
        val dm = context.resources.displayMetrics
        val right = dm.widthPixels - view.width
        walkTargetX = if (p.x + view.width / 2 < dm.widthPixels / 2) 0 else right
        walkTargetY = (dm.heightPixels - view.height - dp(36)).coerceAtLeast(0)
        if (walkTargetX == p.x && walkTargetY >= p.y) {
            savePosition(p)
            return
        }
        walking = true
        handler.removeCallbacks(walkTicker)
        handler.postDelayed(walkTicker, 16L)
    }

    /** 靠边行走一帧：水平固定步速走向目标边，纵向缓慢抬升，到位后停住保存位置。 */
    private fun stepWalk() {
        if (!walking) return
        val p = overlayParams ?: return
        val manager = windowManager ?: return
        val view = overlayView ?: return
        val dx = walkTargetX - p.x
        val dy = walkTargetY - p.y
        var nx = p.x.toFloat()
        when {
            dx > 4 -> {
                petView?.play(PetOverlayView.ROW_RUNNING_RIGHT)
                nx = p.x + 4f
            }
            dx < -4 -> {
                petView?.play(PetOverlayView.ROW_RUNNING_LEFT)
                nx = p.x - 4f
            }
            else -> nx = walkTargetX.toFloat()
        }
        val ny = if (Math.abs(dy) <= 2) walkTargetY.toFloat()
        else (p.y + Math.signum(dy.toFloat()) * Math.max(2f, Math.abs(dy) * 0.08f)).toFloat()
        p.x = nx.toInt()
        p.y = ny.toInt()
        try { manager.updateViewLayout(view, p) } catch (e: Exception) {}
        if (Math.abs(walkTargetX - p.x) <= 4 && Math.abs(walkTargetY - p.y) <= 2) {
            walking = false
            handler.removeCallbacks(walkTicker)
            pendingRow = -1
            petView?.play(PetOverlayView.ROW_IDLE)
            savePosition(p)
            return
        }
        handler.postDelayed(walkTicker, 16L)
    }

    private fun stopWalk() {
        walking = false
        handler.removeCallbacks(walkTicker)
    }

    /** 触点是否落在桌宠本体上（相对悬浮窗根视图坐标）。 */
    private fun isTapOnPet(x: Float, y: Float): Boolean {
        val pet = petView ?: return false
        return pet.left <= x && x <= pet.right && pet.top <= y && y <= pet.bottom
    }

    private fun dp(v: Int): Int = (v * context.resources.displayMetrics.density).toInt()
}
