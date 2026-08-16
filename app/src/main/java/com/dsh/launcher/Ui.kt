package com.dsh.launcher

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView

/**
 * Modern UI helpers used by all programmatically-built screens.
 * Keeps colors, radii, and component styling consistent across the app.
 */
object Ui {

    /** Palette */
    const val BG = 0xFF0F1116.toInt()
    const val SURFACE = 0xFF171C27.toInt()
    const val SURFACE_ALT = 0xFF141824.toInt()
    const val SURFACE_INPUT = 0xFF1E2430.toInt()
    const val OUTLINE = 0xFF263041.toInt()
    const val BRAND = 0xFF6C8CFF.toInt()
    const val BRAND_DEEP = 0xFF4D6BFE.toInt()
    const val TEXT_PRIMARY = 0xFFE8ECF8.toInt()
    const val TEXT_SECONDARY = 0xFFAAB4C6.toInt()
    const val TEXT_MUTED = 0xFF7A8496.toInt()
    const val SUCCESS = 0xFF7FD086.toInt()
    const val WARNING = 0xFFE0B45A.toInt()
    const val DANGER = 0xFFFF6B6B.toInt()

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

    /** A flat, subtle outlined Material card used across the app. */
    fun card(
        context: Context,
        radiusDp: Int = 16,
        background: Int = SURFACE,
        stroke: Int? = OUTLINE
    ): MaterialCardView = MaterialCardView(context).apply {
        radius = dp(context, radiusDp).toFloat()
        setCardBackgroundColor(background)
        cardElevation = 0f
        strokeWidth = if (stroke != null) dp(context, 1) else 0
        strokeColor = stroke ?: Color.TRANSPARENT
        useCompatPadding = false
        setContentPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
    }

    /** A consistent Material button: filled for primary actions, tonal/outlined otherwise. */
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
            backgroundTintList = ColorStateList.valueOf(withAlpha(color, 0x1A))
            setTextColor(if (color == BRAND_DEEP) 0xFFB7C4FF.toInt() else color)
            strokeColor = ColorStateList.valueOf(withAlpha(color, 0x40))
            strokeWidth = dp(context, 1)
        }
        setOnClickListener { onClick() }
    }

    /** A compact rounded status pill. */
    fun pill(context: Context, text: String, color: Int): TextView =
        TextView(context).apply {
            this.text = text
            textSize = 12f
            setTextColor(color)
            setPadding(dp(context, 12), dp(context, 6), dp(context, 12), dp(context, 6))
            background = rounded(context, withAlpha(color, 0x22), 100)
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

    /** A simple labelled section row used on the home screen. */
    fun statusRow(context: Context, text: String, color: Int): TextView =
        TextView(context).apply {
            this.text = text
            textSize = 13f
            setTextColor(color)
            setPadding(dp(context, 2), dp(context, 8), dp(context, 2), dp(context, 2))
            setCompoundDrawablePadding(dp(context, 8))
            compoundDrawablePadding = dp(context, 8)
            gravity = Gravity.START
            typeface = Typeface.MONOSPACE
        }
}