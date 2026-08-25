package com.dsh.launcher.overlay

import android.graphics.drawable.GradientDrawable
import android.view.WindowManager

/**
 * 悬浮窗样式工厂（架构方案 P1-6 第一刀）：状态条配色、形状 Drawable、窗口 flags。
 * 纯函数集合，无状态。
 */
object OverlayStyle {

    fun overlayFlags(): Int =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL

    fun statusBackground(status: String): Int = when (status) {
        "running" -> 0xEE182238.toInt()
        "finished" -> 0xEE1B2A24.toInt()
        "failed" -> 0xEE2A1418.toInt()
        else -> 0xDD101722.toInt()
    }

    fun statusBorder(status: String): Int = when (status) {
        "running" -> 0x446C8CFF.toInt()
        "finished" -> 0x445FD68A.toInt()
        "failed" -> 0x44FF6B6B.toInt()
        else -> 0x33283A55.toInt()
    }

    fun statusColor(status: String): Int = when (status) {
        "running" -> 0xFF6C8CFF.toInt()
        "finished" -> 0xFF5FD68A.toInt()
        "failed" -> 0xFFFF6B6B.toInt()
        else -> 0xFF7A8496.toInt()
    }

    fun circleDrawable(color: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
        }

    /** [radiusDp]/[strokeWidth] 为 dp；[density] 由调用方传入（displayMetrics.density）。 */
    fun roundedDrawable(
        color: Int,
        radiusDp: Int,
        density: Float,
        strokeWidth: Int = 0,
        strokeColor: Int = 0,
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(color)
        cornerRadius = radiusDp * density
        if (strokeWidth > 0) setStroke(strokeWidth, strokeColor)
    }
}
