package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.card.MaterialCardView
import com.google.android.material.switchmaterial.SwitchMaterial

/**
 * dsh 状态桥接配置页：
 * - 悬浮窗 / 声音 / 通知开关；
 * - 显示内容（状态、最近 AI 输出、紧凑/完整模式）；
 * - 启动/停止桥接服务、授予悬浮窗权限。
 */
class OverlaySettingsActivity : AppCompatActivity() {

    private lateinit var overlaySwitch: SwitchMaterial
    private lateinit var soundSwitch: SwitchMaterial
    private lateinit var notifySwitch: SwitchMaterial
    private lateinit var showStatusSwitch: SwitchMaterial
    private lateinit var showLastTextSwitch: SwitchMaterial
    private lateinit var displayModeSwitch: SwitchMaterial
    private lateinit var autoModeSwitch: SwitchMaterial
    private lateinit var hideWhenIdleSwitch: SwitchMaterial
    private lateinit var permissionHint: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    private fun prefs() = getSharedPreferences("status_bridge", Context.MODE_PRIVATE)

    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(16), dp(14), dp(16), dp(16))
        }

        root.addView(TextView(this).apply {
            text = "⛅ dsh 状态桥接"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        root.addView(TextView(this).apply {
            text = "悬浮窗显示运行情况 · 点击打开 Web · AI 结束可提示"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(2), 0, dp(8))
        })

        fun section(text: String): TextView = Ui.sectionLabel(this, text).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        }

        fun card(block: LinearLayout.() -> Unit): MaterialCardView {
            val c = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER, elevationDp = 1f)
            val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; block() }
            c.addView(list)
            root.addView(c, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            return c
        }

        // 显示内容
        root.addView(section("显示内容"))
        card {
            overlaySwitch = addSwitch(this, "悬浮窗显示", "在其它应用上层显示 dsh 运行状态", "overlay_enabled", true) { checked ->
                if (checked) StatusBridgeService.resetDismissed(this@OverlaySettingsActivity)
            }
            showStatusSwitch = addSwitch(this, "显示状态", "显示思考中 / 输出中 / 调用工具等状态", "show_status", true)
            showLastTextSwitch = addSwitch(this, "显示最近输出", "悬浮窗中附带最近 AI 文本", "show_last_text", true)
            hideWhenIdleSwitch = addSwitch(this, "空闲时隐藏", "dsh 空闲时自动隐藏悬浮窗，减少打扰", "hide_when_idle", false)
            autoModeSwitch = addSwitch(this, "智能适配内容", "内容少时紧凑显示，内容多时自动展开 3 行", "display_mode_auto", true) { checked ->
                displayModeSwitch.isEnabled = !checked
            }
            displayModeSwitch = addSwitch(this, "完整模式", "内容较多时固定显示 3 行（智能适配关闭时生效）", "display_mode_full", false)
            displayModeSwitch.isChecked = prefs().getString("display_mode", "compact") == "full"
            displayModeSwitch.isEnabled = !prefs().getBoolean("display_mode_auto", true)
            displayModeSwitch.setOnCheckedChangeListener { _, checked ->
                prefs().edit().putString("display_mode", if (checked) "full" else "compact").apply()
            }
        }

        // 提醒方式
        root.addView(section("提醒方式"))
        card {
            soundSwitch = addSwitch(this, "声音提示", "AI 输出结束后播放系统通知音", "sound_enabled", true)
            notifySwitch = addSwitch(this, "通知提示", "AI 输出结束后发送通知", "notify_enabled", true)
        }

        permissionHint = TextView(this).apply {
            textSize = 12f
            setTextColor(Ui.WARNING)
            setPadding(dp(2), dp(10), dp(2), dp(4))
        }
        root.addView(permissionHint)
        refreshPermissionHint()

        // 服务控制
        root.addView(section("服务控制"))
        card {
            val startBtn = Ui.button(this@OverlaySettingsActivity, "启动桥接服务", {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 200)
                }
                StatusBridgeService.resetDismissed(this@OverlaySettingsActivity)
                StatusBridgeService.start(this@OverlaySettingsActivity)
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(packageName)) {
                    permissionHint.text = "⚠ 建议开启“忽略电池优化”，否则后台可能被系统杀死"
                    permissionHint.setTextColor(Ui.WARNING)
                }
            }, filled = true)
            val stopBtn = Ui.button(this@OverlaySettingsActivity, "停止服务", {
                StatusBridgeService.stop(this@OverlaySettingsActivity)
            }, filled = false, color = Ui.DANGER)
            addView(startBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            addView(stopBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }

        // 权限与保活
        root.addView(section("权限与保活"))
        card {
            val permBtn = Ui.button(this@OverlaySettingsActivity, "授予悬浮窗权限", {
                openOverlaySettings()
            }, filled = false)
            val batteryBtn = Ui.button(this@OverlaySettingsActivity, "忽略电池优化（防后台杀）", {
                openBatteryOptimizationSettings()
            }, filled = false)
            val a11yBtn = Ui.button(this@OverlaySettingsActivity, "无障碍保活（可选，强烈推荐）", {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }, filled = false)
            val webBtn = Ui.button(this@OverlaySettingsActivity, "打开 dsh Web", {
                startActivity(Intent(this@OverlaySettingsActivity, WebViewActivity::class.java))
            }, filled = false)
            addView(permBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            addView(batteryBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(a11yBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(webBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }

        return ScrollView(this).apply { addView(root) }
    }

    private fun addSwitch(
        container: LinearLayout,
        title: String,
        desc: String,
        key: String,
        default: Boolean,
        onChecked: ((Boolean) -> Unit)? = null
    ): SwitchMaterial {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }
        val textWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textWrap.addView(TextView(this).apply {
            text = title
            textSize = 15f
            setTextColor(Ui.TEXT_PRIMARY)
        })
        textWrap.addView(TextView(this).apply {
            text = desc
            textSize = 11f
            setTextColor(Ui.TEXT_MUTED)
        })
        val sw = SwitchMaterial(this)
        sw.isChecked = prefs().getBoolean(key, default)
        sw.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(key, checked).apply()
            onChecked?.invoke(checked)
        }
        row.addView(textWrap, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(sw, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        container.addView(row, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        return sw
    }

    private fun refreshPermissionHint() {
        val can = Settings.canDrawOverlays(this)
        permissionHint.text = if (can) "✓ 悬浮窗权限已授予"
        else "⚠ 未授予悬浮窗权限，悬浮窗不会显示"
        permissionHint.setTextColor(if (can) Ui.SUCCESS else Ui.WARNING)
    }

    private fun openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
            }
        }
    }

    private fun openBatteryOptimizationSettings() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                ))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        } else {
            permissionHint.text = "✓ 已忽略电池优化"
            permissionHint.setTextColor(Ui.SUCCESS)
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionHint()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}