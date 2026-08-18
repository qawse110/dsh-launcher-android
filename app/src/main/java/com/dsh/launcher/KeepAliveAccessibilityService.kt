package com.dsh.launcher

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

/**
 * 极简无障碍保活服务：
 * 只让系统把本应用进程视为“用户主动开启的无障碍服务”，
 * 从而显著降低后台被厂商省电策略杀掉的概率。
 * 不读取、不处理任何屏幕内容。
 */
class KeepAliveAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 保活专用，不处理事件
    }

    override fun onInterrupt() {
        // no-op
    }
}