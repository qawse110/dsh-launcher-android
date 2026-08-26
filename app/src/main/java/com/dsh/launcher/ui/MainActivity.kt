package com.dsh.launcher.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import java.io.File
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * DeepSeek Harness 启动器主界面 —— 「打开即用」的自动启动流。
 *
 * 流程（v4.2 起）：
 * - 首次启动（未安装）：自动 解压内置 Node → npm 安装 dsh → 装配内置插件 →
 *   Android 兼容修复 → 启动 dsh web → 自动进入 WebUI；
 * - 后续启动：自动快速启动 dsh web（已运行则跳过）→ 自动进入 WebUI；
 * - 安装/更新、控制台等高级操作保留为次级入口。
 *
 * 启动引擎在 [DshFlow]（与命令控制台共用同一份逻辑），本类只负责状态展示与路由。
 */
class MainActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())

    /** 启动阶段。 */
    private enum class Phase { FIRST_INSTALL, STOPPED, RUNNING, FLOWING, ERROR }

    private lateinit var phaseDot: View
    private lateinit var phaseTitle: TextView
    private lateinit var phaseSub: TextView
    private lateinit var progress: ProgressBar
    private lateinit var miniLog: TextView
    private lateinit var primaryBtn: View
    private lateinit var primaryText: TextView
    private var contentRoot: LinearLayout? = null
    private var updateBanner: View? = null

    private val logSb = StringBuilder()
    private var phase = Phase.FIRST_INSTALL

    // ---- DSH 更新检测 ----
    private lateinit var updateCard: ViewGroup
    private lateinit var updateLabel: TextView
    private lateinit var updateBtn: View
    private var flowing = false
    private var lastMode: DshFlow.Mode = DshFlow.Mode.INSTALL_AND_START

    /** 冷启动自动路由只做一次；从 WebUI 返回主界面不重复弹。 */
    private var autoRouteDone = false

    private var updateCheckCount = 0

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!flowing) refreshRunState(silent = true)
            // 每 50 轮（~150s）做一次 npm 版本检查
            updateCheckCount++
            if (updateCheckCount >= 50 && !flowing && DshFlow.isInstalled(this@MainActivity)) {
                updateCheckCount = 0
                thread {
                    val latest = runCatching { DshUpdater.checkRemote(this@MainActivity, false) { } }.getOrNull()
                    if (latest != null) {
                        runOnUiThread {
                            updateLabel.text = "🆕 发现新版本 v$latest"
                            updateLabel.setTextColor(Ui.BRAND)
                            updateBtn.visibility = View.VISIBLE
                        }
                    }
                }
            }
            handler.postDelayed(this, 3_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        AppLog.init(this)
        AppLog.i("Main", "onCreate start, logPath=" + AppLog.logPath())
        // 支持 `am start -n com.dsh.launcher/.MainActivity --ez dsh true` 一键触发（旧入口兼容）
        if (intent?.getBooleanExtra("dsh", false) == true) {
            startActivity(Intent(this, ConsoleActivity::class.java)
                .putExtra("dsh", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        setContentView(buildUi())
        requestStoragePermissions()
        maybePromptOverlayPermission()
        maybePromptBatteryOptimization()
        syncAssetsOnApkUpdate()
        // 悬浮窗自动恢复：app 关闭后再打开，只要「悬浮窗显示」开关还开着就自动拉起
        // 状态桥接服务（服务已运行时幂等；无障碍通道由系统自动连接，无需此处处理）
        if (getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)
                .getBoolean("overlay_enabled", true)
        ) {
            runCatching { StatusBridgeService.start(this) }
        }
        // 冷启动自动路由：首次=安装+启动；已装=启动；已在跑=直接进 WebUI
        autoRoute(coldStart = savedInstanceState == null)
        handler.post(pollRunnable)
    }

    override fun onDestroy() {
        super.onDestroy()
        // 清空全部待执行回调（pollRunnable + 延迟 beginFlow 等），防销毁后触达视图/流程
        handler.removeCallbacksAndMessages(null)
    }

    /** 冷启动自动流转：已在跑→直接进 WebUI；已装→自动快速启动；未装→自动完整安装。 */
    private fun autoRoute(coldStart: Boolean) {
        if (!coldStart) {
            // 旋转屏/从 WebUI 返回等重建场景：只刷新状态，不重复自动弹 WebUI
            refreshRunState()
            return
        }
        autoRouteDone = true
        thread {
            val installed = DshFlow.isInstalled(this)
            val up = installed && DshFlow.isWebUp()
            handler.post {
                if (isFinishing || isDestroyed) return@post
                when {
                    up -> { applyPhase(Phase.RUNNING); openWeb() }
                    installed -> beginFlow(DshFlow.Mode.START_ONLY)
                    else -> beginFlow(DshFlow.Mode.INSTALL_AND_START)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshEnvChips()
    }

    // ---------------- 自动启动流程 ----------------

    private fun beginFlow(mode: DshFlow.Mode) {
        if (flowing) {
            toast("启动流程进行中，请稍候…")
            return
        }
        flowing = true
        lastMode = mode
        val firstInstall = mode == DshFlow.Mode.INSTALL_AND_START && !DshFlow.isInstalled(this)
        applyPhase(Phase.FLOWING,
            title = if (firstInstall) "正在安装 DeepSeek Harness…" else "正在启动 dsh…",
            sub = if (firstInstall) "解压 Node → 下载安装 → 装配插件 → 启动，全程自动（首次需联网，约几分钟）"
                  else "正在拉起本地服务（http://127.0.0.1:${DshFlow.WEB_PORT}），就绪后自动进入 WebUI"
        )
        primaryBtn.isEnabled = false
        primaryBtn.alpha = 0.55f
        primaryText.text = if (firstInstall) "安装中…" else "启动中…"

        DshFlow.launch(
            this, mode,
            onLog = { line -> runOnUiThread { appendMiniLog(line) } },
            onState = { s ->
                runOnUiThread {
                    if (!flowing) return@runOnUiThread
                    phaseSub.text = s
                }
            },
            onDone = { ok ->
                runOnUiThread {
                    flowing = false
                    primaryBtn.isEnabled = true
                    primaryBtn.alpha = 1f
                    if (ok && mode != DshFlow.Mode.INSTALL_ONLY) {
                        applyPhase(Phase.RUNNING)
                        openWeb()
                    } else if (ok) {
                        // 仅安装模式（当前主界面不触发，防御性兜底）
                        refreshRunState()
                    } else {
                        applyPhase(Phase.ERROR)
                        toast("启动流程未完成，可点「重试」或查看控制台日志")
                    }
                }
            }
        )
    }

    private fun openWeb() {
        runCatching { startActivity(Intent(this, WebViewActivity::class.java)) }
            .onFailure { appendMiniLog("✗ 无法打开 WebUI：${it.message}") }
    }

    // ---------------- 状态渲染 ----------------

    private fun refreshRunState(silent: Boolean = false) {
        thread {
            val running = DshFlow.isWebUp()
            handler.post {
                if (flowing || isFinishing || isDestroyed) return@post
                val next = when {
                    running -> Phase.RUNNING
                    DshFlow.isInstalled(this) -> Phase.STOPPED
                    else -> Phase.FIRST_INSTALL
                }
                applyPhase(next, silent = silent)
            }
        }
    }

    private fun applyPhase(next: Phase, title: String? = null, sub: String? = null, silent: Boolean = false) {
        phase = next
        val (t, s, color) = when (next) {
            Phase.RUNNING -> Triple(
                "dsh 已就绪",
                "http://127.0.0.1:${DshFlow.WEB_PORT} · 点击下方按钮进入 WebUI",
                Ui.SUCCESS
            )
            Phase.STOPPED -> Triple(
                "一键启动",
                "dsh v${DshUpdater.currentVersion(this)} · 点下方按钮启动并自动进入 WebUI",
                Ui.TEXT_MUTED
            )
            Phase.FIRST_INSTALL -> Triple(
                "欢迎来到 DeepSeek Harness",
                "点下方按钮自动完成安装并启动（需联网，首次约几分钟）",
                Ui.BRAND
            )
            Phase.FLOWING -> Triple(
                title ?: "正在准备…",
                sub ?: "",
                Ui.BRAND_DEEP
            )
            Phase.ERROR -> Triple(
                "启动未完成",
                "可重试；详情见「控制台」日志（files/logs/ 下 flow.log / web.log）",
                Ui.DANGER
            )
        }
        phaseDot.background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.OVAL
            setColor(color)
            setStroke(dp(3), Ui.withAlpha(color, 0x38))
        }
        phaseTitle.text = t
        phaseTitle.setTextColor(if (next == Phase.ERROR) Ui.DANGER else Ui.TEXT_PRIMARY)
        phaseSub.text = s
        phaseSub.setTextColor(Ui.TEXT_SECONDARY)
        val busy = next == Phase.FLOWING
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        when (next) {
            Phase.RUNNING -> { primaryText.text = getString(R.string.btn_enter_webui); primaryBtn.isEnabled = true; primaryBtn.alpha = 1f }
            Phase.STOPPED -> { primaryText.text = getString(R.string.btn_start_auto); primaryBtn.isEnabled = true; primaryBtn.alpha = 1f }
            Phase.FIRST_INSTALL -> { primaryText.text = getString(R.string.btn_install_start); primaryBtn.isEnabled = true; primaryBtn.alpha = 1f }
            Phase.FLOWING -> Unit // 文案由 beginFlow 设置
            Phase.ERROR -> { primaryText.text = getString(R.string.btn_retry); primaryBtn.isEnabled = true; primaryBtn.alpha = 1f }
        }
        if (!silent && !busy) AppLog.i("Main", "phase=$next")
        refreshEnvChips()
    }

    // ---------------- 权限 ----------------

    /** 申请存储权限（Android 11+ 走“所有文件访问”，旧版走运行时授权）。 */
    private fun requestStoragePermissions() {
        if (Build.VERSION.SDK_INT >= 30) {
            if (!Environment.isExternalStorageManager()) {
                val prefs = getSharedPreferences("storage", MODE_PRIVATE)
                if (!prefs.getBoolean("all_files_prompted", false)) {
                    prefs.edit().putBoolean("all_files_prompted", true).apply()
                    openAllFilesAccessSettings()
                }
            }
            return
        }
        if (Build.VERSION.SDK_INT < 23) return
        val needed = mutableListOf<String>()
        if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED)
            needed += android.Manifest.permission.READ_EXTERNAL_STORAGE
        if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED)
            needed += android.Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), 1001)
        }
    }

    /** 打开 Android 11+ 的“所有文件访问”授权页。 */
    private fun openAllFilesAccessSettings() {
        try {
            startActivity(Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:$packageName")
            ))
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            } catch (_: Exception) {
            }
        }
    }

    // ---------------- UI ----------------

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(20), dp(28), dp(20), dp(20))
        }
        contentRoot = root

        /** 两列等宽小按钮行。 */
        fun addPairRow(vararg items: Pair<String, () -> Unit>): View =
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                items.forEachIndexed { i, (label, onClick) ->
                    addView(
                        Ui.button(this@MainActivity, label, onClick, filled = false),
                        LinearLayout.LayoutParams(0, dp(44), 1f).apply {
                            if (i < items.lastIndex) rightMargin = dp(8)
                        }
                    )
                }
            }

        // Header
        root.addView(TextView(this).apply {
            text = "⚡ DeepSeek Harness"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = "Agent 插件化开发框架 · 本地运行 · 打开即用"
            textSize = 12.5f
            setTextColor(Ui.TEXT_MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, dp(16))
        })

        // APP 升级提示条：APK 更新后同步了内置插件源，提示重新装配
        if (getSharedPreferences(AppState.Prefs.UI, MODE_PRIVATE).getBoolean("rewire_hint", false)) {
            root.addView(buildUpdateBanner())
        }

        // ---- 主状态卡 ----
        val card = Ui.card(this, radiusDp = 18, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            phaseDot = Ui.dot(this@MainActivity, 14, Ui.TEXT_MUTED)
            addView(phaseDot, LinearLayout.LayoutParams(dp(14), dp(14)).apply { rightMargin = dp(10) })
            phaseTitle = TextView(this@MainActivity).apply {
                textSize = 19f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Ui.TEXT_PRIMARY)
            }
            addView(phaseTitle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(this@MainActivity).apply {
                text = "v${DshUpdater.currentVersion(this@MainActivity)} · ${DshFlow.WEB_PORT}"
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
            })
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        phaseSub = TextView(this).apply {
            textSize = 13f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(8), 0, 0)
            maxLines = 4 // 安装阶段说明可能较长：放宽到 4 行，避免截断后不可读
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        col.addView(phaseSub, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Ui.BRAND)
        }
        col.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(6)
        ).apply { topMargin = dp(12) })

        // 迷你日志（最近几行，弱化显示）
        miniLog = TextView(this).apply {
            setTextColor(Ui.TEXT_MUTED)
            textSize = 10.5f
            setTypeface(Typeface.MONOSPACE)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setLineSpacing(dp(2).toFloat(), 1f)
            background = Ui.rounded(this@MainActivity, Ui.SURFACE_CONTAINER_LOW, 10)
            visibility = View.GONE
        }
        col.addView(miniLog, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })

        val btn = Ui.button(this, "", { onPrimaryClicked() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52)
            ).apply { topMargin = dp(14) }
            textSize = 15.5f
            typeface = Typeface.DEFAULT_BOLD
        }
        primaryBtn = btn
        primaryText = btn
        col.addView(btn)

        card.addView(col)
        root.addView(card, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(4) })

        // ---- DSH 版本 / 更新 ----
        updateCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        val ucCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        ucCol.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = "📦 DSH 核心"
                textSize = 13f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                setTextColor(Ui.TEXT_SECONDARY)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(this@MainActivity).apply {
                text = "v" + DshUpdater.currentVersion(this@MainActivity)
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
            })
        })
        updateLabel = TextView(this).apply {
            textSize = 12.5f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(4), 0, 0)
        }
        ucCol.addView(updateLabel)
        val checkBtn = Ui.button(this, "检查更新", { checkForUpdates(force = true) }, filled = false, compact = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(38)
            ).apply { topMargin = dp(8) }
        }
        ucCol.addView(checkBtn)
        updateBtn = Ui.button(this, "立即更新", { startUpdate() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44)
            ).apply { topMargin = dp(6) }
            visibility = View.GONE
        }
        ucCol.addView(updateBtn)
        updateCard.addView(ucCol)
        root.addView(updateCard)

        // ---- 次级操作网格 ----
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, 0)
            addView(addPairRow(
                getString(R.string.btn_open_terminal) to { startActivity(Intent(this@MainActivity, ConsoleActivity::class.java)) },
                "终端" to { openTerminal() }
            ).apply {}, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
            addView(addPairRow(
                "状态悬浮窗" to { startActivity(Intent(this@MainActivity, OverlaySettingsActivity::class.java)) },
                "插件管理" to { startActivity(Intent(this@MainActivity, PluginManagerActivity::class.java)) }
            ), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
            addView(addPairRow(
                getString(R.string.btn_stop_all) to { stopDshAll() },
                "📖 操作指南" to { toggleHelp() }
            ), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })

        // 环境状态 chips
        envChipsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, 0)
        }
        root.addView(envChipsRow)

        // 操作指南（默认收起）
        helpBody = TextView(this).apply {
            text = """
                ① 首次使用：点「安装并启动」即可——app 会自动完成内置 Node 解压、npm 官方安装 dsh、
                   内置插件装配、Android 兼容修复，然后启动本地服务并自动进入 WebUI；
                ② 之后的每次打开：自动快速启动（秒级）并直接进入 WebUI，无需任何操作；
                ③ 「控制台」可看完整安装/运行日志，「终端」提供完整 Linux 环境；
                ④ 「停止 dsh 服务」结束后台进程与保活。
                
                提示：
                · 全程免 Termux 配置，内置 aarch64 Node 运行时；
                · 安装日志：/sdcard/Download/DshLauncher/install_log.txt；
                · dsh 更新：控制台右上角「更新」。
            """.trimIndent()
            textSize = 12f
            setTextColor(Ui.TEXT_MUTED)
            setLineSpacing(dp(3).toFloat(), 1f)
            setPadding(dp(4), dp(10), dp(4), 0)
            visibility = View.GONE
        }
        root.addView(helpBody, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        return ScrollView(this).apply { addView(root) }
    }

    private lateinit var envChipsRow: LinearLayout
    private lateinit var helpBody: TextView

    /** 用户主动触发：强制查 npm 并显示结果。 */
    private fun checkForUpdates(force: Boolean) {
        if (!::updateLabel.isInitialized) return
        updateLabel.text = "正在检查更新…"
        updateLabel.setTextColor(Ui.TEXT_SECONDARY)
        thread {
            val latest = runCatching { DshUpdater.checkRemote(this@MainActivity, force) { /* 静默 */ } }.getOrNull()
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                when {
                    latest != null -> {
                        updateLabel.text = "🆕 发现新版本 v$latest"
                        updateLabel.setTextColor(Ui.BRAND)
                        updateBtn.visibility = View.VISIBLE
                    }
                    else -> {
                        updateLabel.text = "✓ 已是最新版本 v" + DshUpdater.currentVersion(this@MainActivity)
                        updateLabel.setTextColor(Ui.SUCCESS)
                        updateBtn.visibility = View.GONE
                    }
                }
            }
        }
    }

    /** 一键更新 DSH 核心 + 插件，完成后自动重启 web。 */
    private fun startUpdate() {
        if (!guardBusy("update")) return
        setBusy(true)
        appendMiniLog(">> 开始更新 DSH 核心…")
        DshFlow.launch(
            this, DshFlow.Mode.INSTALL_ONLY,
            onLog = { line -> runOnUiThread { appendMiniLog(line) } },
            onDone = { ok ->
                runOnUiThread {
                    setBusy(false)
                    if (ok) {
                        appendMiniLog("✓ 更新完成，正在重启服务…")
                        handler.postDelayed({ beginFlow(DshFlow.Mode.START_ONLY) }, 800)
                    } else {
                        toast("更新失败，详见控制台日志")
                    }
                }
            }
        )
    }

    private fun guardBusy(action: String): Boolean =
        if (flowing) { toast("请等待当前操作完成"); false } else true

    private fun setBusy(b: Boolean) {
        flowing = b
        runOnUiThread {
            progress.visibility = if (b) View.VISIBLE else View.GONE
            primaryBtn.isEnabled = !b
            primaryBtn.alpha = if (b) 0.5f else 1f
            updateBtn.isEnabled = !b
        }
    }

    private fun onPrimaryClicked() {
        when (phase) {
            Phase.FIRST_INSTALL -> beginFlow(DshFlow.Mode.INSTALL_AND_START)
            Phase.STOPPED -> beginFlow(DshFlow.Mode.START_ONLY)
            Phase.RUNNING -> openWeb()
            Phase.ERROR -> beginFlow(lastMode)
            Phase.FLOWING -> Unit
        }
    }

    private fun toggleHelp() {
        helpBody.visibility = if (helpBody.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    /** 环境状态 chips：Node/Termux/存储 + 悬浮窗双通道健康度。
     *  「悬浮窗」「无障碍」两枚芯片可点：缺权限/未连接时直达对应系统页。 */
    private fun refreshEnvChips() {
        if (!::envChipsRow.isInitialized) return
        envChipsRow.removeAllViews()

        fun chip(label: String, color: Int, onClick: (() -> Unit)? = null) {
            val pill = Ui.pill(this, label, color).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(6) }
                if (onClick != null) {
                    isClickable = true
                    setOnClickListener { onClick() }
                }
            }
            envChipsRow.addView(pill)
        }

        chip("Node ${if (hasNodeMarker()) "✓" else "…"}", if (hasNodeMarker()) Ui.SUCCESS else Ui.TEXT_MUTED)
        chip("Termux ${if (TermuxRuntime.isReady(this)) "✓" else "…"}", if (TermuxRuntime.isReady(this)) Ui.SUCCESS else Ui.TEXT_MUTED)
        chip("存储 ${if (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) "✓" else "…"}",
            if (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) Ui.SUCCESS else Ui.TEXT_MUTED)

        // ---- 悬浮窗双通道 ----
        val overlayGranted = Settings.canDrawOverlays(this)
        chip(
            if (overlayGranted) "悬浮窗 ✓" else "悬浮窗 ⚠ 授权",
            if (overlayGranted) Ui.SUCCESS else Ui.WARNING
        ) {
            if (!overlayGranted) openOverlayPermissionSettings()
        }

        val a11yEnabled = KeepAliveAccessibilityService.isEnabledInSystemSettings(this)
        val a11yFresh = a11yEnabled && KeepAliveAccessibilityService.isA11yChannelFresh(this)
        when {
            a11yFresh -> chip("无障碍 ✓", Ui.SUCCESS)
            a11yEnabled -> chip("无障碍 ⚠ 未连接", Ui.WARNING) {
                // ROM 懒绑定：开关登记着但服务没连上（悬浮窗不出现）——
                // 去无障碍设置页关一次再开即可重绑
                openAccessibilitySettings()
            }
            else -> chip("无障碍 –", Ui.TEXT_MUTED) {
                openAccessibilitySettings()
            }
        }
    }

    /** 一次性引导「显示在其它应用上层」权限：普通通道拿到它即可脱离无障碍独立自启。
     *  （部分 ROM 无障碍服务冷启时不自动重绑，需手动开关一次；双通道互为备份，
     *   本权限是让悬浮窗稳定自启的根本解。） */
    private fun maybePromptOverlayPermission() {
        if (Settings.canDrawOverlays(this)) return
        val prefs = getSharedPreferences(AppState.Prefs.UI, MODE_PRIVATE)
        if (prefs.getBoolean("overlay_perm_prompted", false)) return
        prefs.edit().putBoolean("overlay_perm_prompted", true).apply()
        appendMiniLog("首次引导：授予「显示在其它应用上层」后，悬浮窗不依赖无障碍也能自启")
        openOverlayPermissionSettings()
    }

    private fun openOverlayPermissionSettings() {
        runCatching {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)) }
        }
    }

    private fun openAccessibilitySettings() {
        runCatching { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
    }

    /** 一次性引导「忽略电池优化」：ColorOS 等会在灭屏后冻结未白名单进程，
     *  任务运行中被打断的最常见原因。已白名单则静默跳过。 */
    private fun maybePromptBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        val prefs = getSharedPreferences(AppState.Prefs.UI, MODE_PRIVATE)
        if (prefs.getBoolean("batt_opt_prompted", false)) return
        prefs.edit().putBoolean("batt_opt_prompted", true).apply()
        appendMiniLog("建议授予「忽略电池优化」，防止息屏后任务被系统打断")
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
    }

    private fun appendMiniLog(line: String) {
        if (miniLog.visibility == View.GONE && line.isNotBlank()) miniLog.visibility = View.VISIBLE
        logSb.append(line).append("\n")
        val lines = logSb.toString().split("\n")
        if (lines.size > 9) logSb.clear().append(lines.takeLast(9).joinToString("\n")).append("\n")
        miniLog.text = logSb.toString().trimEnd()
        AppLog.i("Main", line)
    }

    private fun openTerminal() {
        thread {
            if (!TermuxRuntime.isReady(this)) {
                try {
                    TermuxRuntime.ensureExtracted(this) { msg -> appendMiniLog(msg) }
                } catch (t: Throwable) {
                    appendMiniLog("✗ Termux 准备失败：${t.message}（回退系统 sh）")
                }
            }
            TermuxRuntime.ensureHarnessTools(this) { msg -> appendMiniLog(msg) }
            runOnUiThread { startActivity(Intent(this, TerminalActivity::class.java)) }
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    // ---------------- APK 升级：同步内置插件源 ----------------

    /**
     * APK 升级后自动把 assets 里的内置插件源（prebuilt.tgz 等）同步到 files，
     * 避免“更新了应用但运行时仍是旧插件”。装配本身仍需用户执行
     * 「插件管理 → 重新装配内置插件」（或控制台一键安装）。
     */
    private fun syncAssetsOnApkUpdate() {
        val current = AssetSync.apkVersion(this)
        if (current == 0L) return
        val prefs = getSharedPreferences(AppState.Prefs.UI, MODE_PRIVATE)
        val last = prefs.getLong("last_apk_version", 0L)
        if (current == last) return
        prefs.edit().putLong("last_apk_version", current).apply()
        appendMiniLog("检测到应用更新（v$current），后台同步内置插件源…")
        thread {
            try {
                for (name in listOf(
                    "install-dsh.mjs", "routing-suite.mjs",
                    "fs-register.mjs", "fs-loader.mjs", "fs-promises-compat.mjs", "stub-dsh.mjs"
                )) {
                    AssetSync.copyAsset(this, name, File(filesDir, name))
                }
                val prebuilt = File(filesDir, "prebuilt.tgz")
                if (AssetSync.copyAsset(this, "prebuilt.tgz", prebuilt)) {
                    AssetSync.markSynced(this, "prebuilt", current)
                }
                val extraPlugins = File(filesDir, "extra-plugins")
                if (AssetSync.copyAssetDir(this, "extra-plugins", extraPlugins, clearFirst = true)) {
                    AssetSync.markSynced(this, "extra-plugins", current)
                }
                val dshInstalled = File(filesDir, "plugins").exists() && File(filesDir, "dsh-prefix").exists()
                if (dshInstalled) {
                    prefs.edit().putBoolean("rewire_hint", true).apply()
                    runOnUiThread {
                        appendMiniLog("✓ 内置插件源已同步。建议在「插件管理」执行“重新装配内置插件”。")
                        showUpdateHint()
                    }
                } else {
                    runOnUiThread { appendMiniLog("✓ 内置插件源已同步（新装环境，装配由首次安装负责）。") }
                }
            } catch (t: Throwable) {
                AppLog.e("Main", "apk asset sync failed: " + (t.message ?: t.toString()))
            }
        }
    }

    /** 「应用已更新」提示条：内置插件源已同步，引导重新装配内置插件。 */
    private fun buildUpdateBanner(): View {
        updateBanner?.let { return it }
        val card = Ui.card(
            this, radiusDp = 14,
            background = Ui.SURFACE_CONTAINER_HIGH,
            stroke = Ui.WARNING, elevationDp = 1f
        )
        val inner = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        inner.addView(TextView(this).apply {
            text = "🔄 应用已更新"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        inner.addView(TextView(this).apply {
            text = "检测到 APK 升级，内置插件源（prebuilt.tgz）已同步到新版本。" +
                "内置插件需要重新装配后才会使用新代码。"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(6), 0, 0)
        })
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10), 0, 0)
        }
        row.addView(
            Ui.button(this, "重新装配", {
                startActivity(Intent(this@MainActivity, PluginManagerActivity::class.java))
            }, filled = true, compact = true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(8) }
        )
        row.addView(
            Ui.button(this, "知道了", {
                dismissUpdateBanner()
            }, filled = false, compact = true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        inner.addView(row)
        card.addView(inner)
        card.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) }
        updateBanner = card
        return card
    }

    /** 同步完成后把提示条插入顶部（若 buildUi 尚未添加）。 */
    private fun showUpdateHint() {
        if (updateBanner != null) return
        val root = contentRoot ?: return
        root.addView(buildUpdateBanner(), 2)
    }

    private fun dismissUpdateBanner() {
        getSharedPreferences(AppState.Prefs.UI, MODE_PRIVATE).edit().putBoolean("rewire_hint", false).apply()
        updateBanner?.let { contentRoot?.removeView(it) }
        updateBanner = null
    }

    /** 是否有内置 Node 解压完成标记。 */
    private fun hasNodeMarker(): Boolean = MarkerStore.has(this, "node")

    /** 停止 dsh 服务：杀 node 相关进程 + 停保活服务 + 刷新状态。 */
    private fun stopDshAll() {
        appendMiniLog("▶ 正在停止 dsh 相关进程…")
        thread {
            try {
                val pb = ProcessBuilder(
                    "/system/bin/sh", "-c",
                    "pkill -f 'dsh/lib/bin.js web'; pkill -f 'bin.js web'; pkill -f 'src/bin.ts'; true"
                )
                pb.redirectErrorStream(true)
                pb.start().waitFor()
            } catch (t: Throwable) {
                android.util.Log.w("DshMain", "kill failed: ${t.message}")
            }
            runOnUiThread {
                BuildKeepAliveService.markStopped(this@MainActivity)
                runCatching { stopService(Intent(this@MainActivity, BuildKeepAliveService::class.java)) }
                appendMiniLog("✓ 已停止 dsh 相关进程与服务")
                refreshRunState()
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
