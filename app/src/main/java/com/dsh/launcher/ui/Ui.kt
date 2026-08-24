package com.dsh.launcher.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * Modern UI helpers used by all programmatically-built screens.
 * Keeps colors, radii, and component styling consistent across the app.
 */
object Ui {

    /** Palette — Material 3 dark color roles */
    var BG = 0xFF0F1116.toInt()
    var SURFACE = 0xFF151922.toInt()
    var SURFACE_ALT = 0xFF141824.toInt()
    var SURFACE_INPUT = 0xFF1E2430.toInt()
    var OUTLINE = 0xFF2C3547.toInt()
    var BRAND = 0xFF6C8CFF.toInt()
    var BRAND_DEEP = 0xFF4D6BFE.toInt()
    var TEXT_PRIMARY = 0xFFE4E8F2.toInt()
    var TEXT_SECONDARY = 0xFFAAB4C6.toInt()
    var TEXT_MUTED = 0xFF7A8496.toInt()
    var SUCCESS = 0xFF7FD086.toInt()
    var WARNING = 0xFFE0B45A.toInt()
    var DANGER = 0xFFFF6B6B.toInt()

    // Material 3 surface container roles
    var SURFACE_CONTAINER_LOWEST = 0xFF0F1116.toInt()
    var SURFACE_CONTAINER_LOW = 0xFF171C27.toInt()
    var SURFACE_CONTAINER = 0xFF1A2029.toInt()
    var SURFACE_CONTAINER_HIGH = 0xFF202733.toInt()
    var SURFACE_CONTAINER_HIGHEST = 0xFF262E3C.toInt()
    var PRIMARY_CONTAINER = 0xFF23316B.toInt()
    var ON_PRIMARY_CONTAINER = 0xFFDDE4FF.toInt()
    var SECONDARY_CONTAINER = 0xFF2A3552.toInt()
    var ON_SECONDARY_CONTAINER = 0xFFDDE4FF.toInt()

    fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()

    /**
     * 读取当前 Activity 主题中的 Material You 动态色（Android 12+）。
     * 调用前应已通过 DynamicColors.applyToActivityIfAvailable(activity) 应用动态主题。
     * 在低版本或读取失败时保持内置深色配色。
     */
    fun applyDynamicColors(context: Context) {
        if (Build.VERSION.SDK_INT < 31) return
        try {
            val primary = MaterialColors.getColor(context, com.google.android.material.R.attr.colorPrimary, BRAND)
            val primaryContainer = MaterialColors.getColor(context, com.google.android.material.R.attr.colorPrimaryContainer, PRIMARY_CONTAINER)
            val onPrimaryContainer = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOnPrimaryContainer, ON_PRIMARY_CONTAINER)
            val secondary = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSecondary, BRAND)
            val secondaryContainer = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSecondaryContainer, SECONDARY_CONTAINER)
            val onSecondaryContainer = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOnSecondaryContainer, ON_SECONDARY_CONTAINER)
            val surface = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurface, SURFACE)
            val onSurface = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOnSurface, TEXT_PRIMARY)
            val onSurfaceVariant = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOnSurfaceVariant, TEXT_SECONDARY)
            val surfaceVariant = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceVariant, SURFACE_INPUT)
            val outline = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOutline, OUTLINE)
            val surfaceContainerLowest = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceContainerLowest, SURFACE_CONTAINER_LOWEST)
            val surfaceContainerLow = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceContainerLow, SURFACE_CONTAINER_LOW)
            val surfaceContainer = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceContainer, SURFACE_CONTAINER)
            val surfaceContainerHigh = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceContainerHigh, SURFACE_CONTAINER_HIGH)
            val surfaceContainerHighest = MaterialColors.getColor(context, com.google.android.material.R.attr.colorSurfaceContainerHighest, SURFACE_CONTAINER_HIGHEST)

            BG = surfaceContainerLowest
            SURFACE = surface
            SURFACE_ALT = surfaceVariant
            SURFACE_INPUT = surfaceVariant
            OUTLINE = outline
            BRAND = primary
            BRAND_DEEP = primary
            TEXT_PRIMARY = onSurface
            TEXT_SECONDARY = onSurfaceVariant
            TEXT_MUTED = withAlpha(onSurfaceVariant, 0x99)
            SURFACE_CONTAINER_LOWEST = surfaceContainerLowest
            SURFACE_CONTAINER_LOW = surfaceContainerLow
            SURFACE_CONTAINER = surfaceContainer
            SURFACE_CONTAINER_HIGH = surfaceContainerHigh
            SURFACE_CONTAINER_HIGHEST = surfaceContainerHighest
            PRIMARY_CONTAINER = primaryContainer
            ON_PRIMARY_CONTAINER = onPrimaryContainer
            SECONDARY_CONTAINER = secondaryContainer
            ON_SECONDARY_CONTAINER = onSecondaryContainer
        } catch (_: Throwable) {
            // 主题资源缺失/低版本时保留默认配色
        }
    }

    /** Alpha-combine a solid color with a given alpha (0..255). */
    fun withAlpha(color: Int, alpha: Int): Int =
        (alpha shl 24) or (color and 0x00FFFFFF)

    fun rounded(
        context: Context,
        color: Int,
        radiusDp: Int,
        strokeColor: Int? = null,
        strokeWidthDp: Int = 1
    ): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(context, radiusDp).toFloat()
        if (strokeColor != null) {
            setStroke(dp(context, strokeWidthDp), strokeColor)
        }
    }

    /** Small colored status dot used in headers/cards. */
    fun dot(context: Context, sizeDp: Int, color: Int): View = View(context).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
        }
        val size = dp(context, sizeDp)
        layoutParams = LinearLayout.LayoutParams(size, size)
    }

    /** Small rounded status pill for compact labels. */
    fun pill(context: Context, text: String, color: Int): TextView = TextView(context).apply {
        this.text = text
        textSize = 11f
        setTextColor(color)
        background = rounded(context, withAlpha(color, 0x1A), 8, color, 1)
        setPadding(dp(context, 8), dp(context, 3), dp(context, 8), dp(context, 3))
    }

    /** Material 3 card with configurable elevation and surface container role. */
    fun card(
        context: Context,
        radiusDp: Int = 16,
        background: Int = SURFACE_CONTAINER_LOW,
        stroke: Int? = null,
        elevationDp: Float = 0f
    ): MaterialCardView = MaterialCardView(context).apply {
        radius = dp(context, radiusDp).toFloat()
        setCardBackgroundColor(background)
        cardElevation = elevationDp * context.resources.displayMetrics.density
        strokeWidth = if (stroke != null) dp(context, 1) else 0
        strokeColor = stroke ?: Color.TRANSPARENT
        useCompatPadding = false
        setContentPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
    }

    /**
     * Material 3 buttons:
     * filled -> primary filled button;
     * otherwise -> tonal button using primary/secondary container.
     */
    fun button(
        context: Context,
        text: String,
        onClick: () -> Unit,
        filled: Boolean = true,
        compact: Boolean = true,
        color: Int = BRAND_DEEP,
        textColor: Int = Color.WHITE
    ): MaterialButton = MaterialButton(context).apply {
        this.text = text
        this.isAllCaps = false
        textSize = 14f
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        insetTop = if (compact) 0 else dp(context, 6)
        insetBottom = if (compact) 0 else dp(context, 6)
        cornerRadius = dp(context, 12)
        if (filled) {
            backgroundTintList = ColorStateList.valueOf(color)
            setTextColor(textColor)
        } else {
            // MD3 tonal button: container color + on-container text, no border
            val container = if (color == BRAND_DEEP || color == BRAND) PRIMARY_CONTAINER else withAlpha(color, 0x1A)
            val onContainer = if (color == BRAND_DEEP || color == BRAND) ON_PRIMARY_CONTAINER else color
            backgroundTintList = ColorStateList.valueOf(container)
            setTextColor(onContainer)
            strokeWidth = 0
        }
        setOnClickListener { onClick() }
    }

    /** A small uppercase-style section label used to group cards on a screen. */
    fun sectionLabel(context: Context, text: String): TextView =
        TextView(context).apply {
            this.text = text
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(TEXT_SECONDARY)
            setPadding(dp(context, 2), dp(context, 4), dp(context, 2), dp(context, 2))
            letterSpacing = 0.06f
        }

    }