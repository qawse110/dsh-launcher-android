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
    fun showPetName(): Boolean = prefs().getBoolean("pet_show_name", true)
    fun showAmbientBubble(): Boolean = prefs().getBoolean("pet_ambient_bubble", true)

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
