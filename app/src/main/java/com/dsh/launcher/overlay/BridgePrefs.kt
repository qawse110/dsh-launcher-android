package com.dsh.launcher.overlay

import android.content.Context
import com.dsh.launcher.core.AppState

/**
 * 状态桥接悬浮窗的偏好读取门面（架构方案 P1-6 第一刀）。
 * 仅做键名与默认值收敛，不含业务逻辑；overlayEnabled 因依赖 windowType
 * 与无障碍时间戳，保留在 BridgeOverlayManager。
 */
class BridgePrefs(private val context: Context) {

    private fun prefs() = context.getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)

    fun showStatus(): Boolean = prefs().getBoolean("show_status", true)
    fun showLastText(): Boolean = prefs().getBoolean("show_last_text", true)
    fun overlayStyle(): String = prefs().getString("overlay_style", "pill") ?: "pill"
    fun petId(): String =
        prefs().getString("pet_id", CodexPetStore.DEFAULT_PET_ID) ?: CodexPetStore.DEFAULT_PET_ID
    fun showPetBubble(): Boolean = prefs().getBoolean("pet_show_bubble", true)
    fun petTts(): Boolean = prefs().getBoolean("pet_tts", true)
    fun ttsEngine(): String = prefs().getString("tts_engine", "system") ?: "system"
    fun ttsEdgeVoice(): String = prefs().getString("tts_edge_voice", "zh-CN-XiaoxiaoNeural") ?: "zh-CN-XiaoxiaoNeural"
    fun showPetName(): Boolean = prefs().getBoolean("pet_show_name", true)
    fun showAmbientBubble(): Boolean = prefs().getBoolean("pet_ambient_bubble", true)

    /**
     * 任务完成后「已完成」气泡的停留时长（毫秒）；<=0 表示不自动收起，
     * 一直显示到状态变化为止。
     */
    fun petCompletionHoldMs(): Long = prefs().getLong("pet_completion_hold_ms", 30_000L)

    fun petHeightDp(): Int = when (prefs().getString("pet_size", "medium")) {
        "small" -> 88
        "large" -> 160
        else -> 120
    }

    fun displayMode(): String {
        return if (prefs().getBoolean("display_mode_auto", true)) {
            "auto"
        } else {
            prefs().getString("display_mode", "compact") ?: "compact"
        }
    }

    fun useFullMode(text: String): Boolean = when (displayMode()) {
        "full" -> true
        "compact" -> false
        else -> text.length > 20
    }

    fun hideWhenIdle(): Boolean = prefs().getBoolean("hide_when_idle", false)
}
