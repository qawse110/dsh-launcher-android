package com.dsh.launcher

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView

/**
 * Modern UI helpers used by all programmatically-built screens.
 * Keeps colors, radii, and component styling consistent across the app.
 */
object Ui {

    /** Palette — Material 3 dark color roles */
    const val BG = 0xFF0F1116.toInt()
    const val SURFACE = 0xFF151922.toInt()
    const val SURFACE_ALT = 0xFF141824.toInt()
    const val SURFACE_INPUT = 0xFF1E2430.toInt()
    const val OUTLINE = 0xFF2C3547.toInt()
    const val BRAND = 0xFF6C8CFF.toInt()
    const val BRAND_DEEP = 0xFF4D6BFE.toInt()
    const val TEXT_PRIMARY = 0xFFE4E8F2.toInt()
    const val TEXT_SECONDARY = 0xFFAAB4C6.toInt()
    const val TEXT_MUTED = 0xFF7A8496.toInt()
    const val SUCCESS = 0xFF7FD086.toInt()
    const val WARNING = 0xFFE0B45A.toInt()
    const val DANGER = 0xFFFF6B6B.toInt()

    // Material 3 surface container roles
    const val SURFACE_CONTAINER_LOWEST = 0xFF0F1116.toInt()
    const val SURFACE_CONTAINER_LOW = 0xFF171C27.toInt()
    const val SURFACE_CONTAINER = 0xFF1A2029.toInt()
    const val SURFACE_CONTAINER_HIGH = 0xFF202733.toInt()
    const val SURFACE_CONTAINER_HIGHEST = 0xFF262E3C.toInt()
    const val PRIMARY_CONTAINER = 0xFF23316B.toInt()
    const val ON_PRIMARY_CONTAINER = 0xFFDDE4FF.toInt()
    const val SECONDARY_CONTAINER = 0xFF2A3552.toInt()
    const val ON_SECONDARY_CONTAINER = 0xFFDDE4FF.toInt()

    fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()

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