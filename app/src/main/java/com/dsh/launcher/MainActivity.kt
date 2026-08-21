package com.dsh.launcher

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.graphics.Typeface
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
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * DeepSeek Harness 启动器主界面
 * 功能：检查服务状态 / 一键安装 / 启停 dsh 服务 / 打开 Web 界面 / 打开内置终端 / 内置 Node 运行
 */
class MainActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusValue: TextView
    private lateinit var statusDot: View
    private lateinit var progress: ProgressBar
    private lateinit var logView: TextView
    private val logSb = StringBuilder()
    private var contentRoot: LinearLayout? = null
    private var updateBanner: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        AppLog.init(this)
        AppLog.i("Main", "onCreate start, logPath=" + AppLog.logPath())
        // 支持 `am start -n com.dsh.launcher/.MainActivity --ez dsh true` 一键触发
        if (intent?.getBooleanExtra("dsh", false) == true) {
            startActivity(Intent(this, ConsoleActivity::class.java)
                .putExtra("dsh", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        setContentView(buildUi())
        requestStoragePermissions()
        syncAssetsOnApkUpdate()
        // 悬浮窗自动恢复：app 关闭后再打开，只要「悬浮窗显示」开关还开着就自动拉起
        // 状态桥接服务（服务已运行时幂等；无障碍通道由系统自动连接，无需此处处理）
        if (getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
                .getBoolean("overlay_enabled", true)
        ) {
            runCatching { StatusBridgeService.start(this) }
        }
        log("就绪。请选择操作。")
    }

    override fun onResume() {
        super.onResume()
        if (::statusValue.isInitialized) refreshStatus(silent = true)
    }

    /** 申请存储权限（Android 11+ 走“所有文件访问”，旧版走运行时授权）。 */
    private fun requestStoragePermissions() {
        if (Build.VERSION.SDK_INT >= 30) {
            if (!Environment.isExternalStorageManager()) {
                val prefs = getSharedPreferences("storage", MODE_PRIVATE)
                if (!prefs.getBoolean("all_files_prompted", false)) {
                    prefs.edit().putBoolean("all_files_prompted", true).apply()
                    log("需要授予“所有文件访问权限”才能完整访问 /sdcard…")
                    openAllFilesAccessSettings()
                } else {
                    log("尚未授予“所有文件访问权限”，可点击下方按钮前往设置")
                }
            } else {
                log("已获得“所有文件访问权限”")
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
            } catch (e2: Exception) {
                log("无法打开存储权限设置：${e2.message}")
            }
        }
    }

    // ---------------- UI ----------------
    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(20), dp(32), dp(20), dp(24))
        }
        contentRoot = root

        // ---- 布局辅助 ----
        /** 区块标题 + 卡片容器。 */
        fun addSection(title: String, block: LinearLayout.() -> Unit) {
            root.addView(Ui.sectionLabel(this, title).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(20) }
            })
            val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER, elevationDp = 1f)
            card.addView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; block() })
            root.addView(card, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }

        /** 通栏按钮（主操作/停止等）。 */
        fun LinearLayout.addWide(
            text: String, filled: Boolean, color: Int = Ui.BRAND_DEEP,
            heightDp: Int = 48, bold: Boolean = false, textSize: Float = 14f,
            onClick: () -> Unit
        ) {
            addView(Ui.button(this@MainActivity, text, onClick, filled = filled, color = color).apply {
                this.textSize = textSize
                if (bold) typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(heightDp)
                ).apply { topMargin = dp(8) }
            })
        }

        /** 两列等宽按钮行（网格布局，减少滚屏）。 */
        fun LinearLayout.addPair(
            a: String, aOn: () -> Unit,
            b: String, bOn: () -> Unit,
            color: Int = Ui.BRAND_DEEP
        ) {
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, 0)
                addView(
                    Ui.button(this@MainActivity, a, aOn, filled = false, color = color),
                    LinearLayout.LayoutParams(0, dp(46), 1f).apply { rightMargin = dp(8) }
                )
                addView(
                    Ui.button(this@MainActivity, b, bOn, filled = false, color = color),
                    LinearLayout.LayoutParams(0, dp(46), 1f)
                )
            })
        }

        // Header
        root.addView(TextView(this).apply {
            text = "⚡ DeepSeek Harness"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, 0)
        })
        root.addView(TextView(this).apply {
            text = "Agent 插件化开发框架 · 本地运行"
            textSize = 13f
            setTextColor(Ui.TEXT_MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(24))
        })

        // APP 升级提示条：APK 更新后同步了内置插件源，提示重新装配
        if (getSharedPreferences("dsh_ui", MODE_PRIVATE).getBoolean("rewire_hint", false)) {
            root.addView(buildUpdateBanner())
        }

        // Section: 运行状态（两行：标签+刷新 / 大号状态指示，不再挤一行）
        root.addView(Ui.sectionLabel(this, "运行状态").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
        })

        val statusCard = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val statusCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        // 第一行：弱化标签 + 刷新按钮
        statusCol.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = "dsh 服务"
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Ui.TEXT_SECONDARY)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Ui.button(this@MainActivity, "刷新", { refreshStatus() },
                filled = false, compact = true).apply { minWidth = dp(76); textSize = 12.5f })
        })
        // 第二行：大号状态点（带同色光晕描边）+ 状态文字 + 版本与端口提示
        statusCol.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, 0)
            statusDot = Ui.dot(this@MainActivity, 14, Ui.TEXT_MUTED)
            addView(statusDot, LinearLayout.LayoutParams(dp(14), dp(14)).apply { rightMargin = dp(10) })
            statusValue = TextView(this@MainActivity).apply {
                text = getString(R.string.status_unknown)
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Ui.TEXT_MUTED)
            }
            addView(statusValue, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(this@MainActivity).apply {
                text = "v${DshUpdater.currentVersion(this@MainActivity)} · 3080"
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
            })
        })
        statusCard.addView(statusCol)
        root.addView(statusCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })

        progress = ProgressBar(this).apply { visibility = View.GONE }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(8) })

        // Section: 核心操作（安装/更新 与 启动 拆分）
        addSection("核心操作") {
            addWide(getString(R.string.btn_install_update), true, Ui.BRAND, heightDp = 52, bold = true, textSize = 15f) {
                // 仅安装/更新：node→官方 npm 安装/更新 dsh→插件装配，不启动 web
                runCatching {
                    startActivity(Intent(this@MainActivity, ConsoleActivity::class.java).putExtra("dsh_install", true))
                }.onFailure {
                    log("✗ 无法打开控制台：${it.message}")
                }
            }
            addPair(getString(R.string.btn_start_dsh), {
                // 仅启动：跳过安装/装配，快速启动 web（未安装时提示先安装）
                startActivity(Intent(this@MainActivity, ConsoleActivity::class.java).putExtra("dsh_start", true))
            }, getString(R.string.btn_open_web), {
                startActivity(Intent(this@MainActivity, WebViewActivity::class.java))
            })
        }

        // Section: 工具（两列网格）
        addSection("工具") {
            addPair(getString(R.string.btn_open_terminal), {
                thread {
                    if (!TermuxRuntime.isReady(this@MainActivity)) {
                        log("准备内置 Termux 环境（首次约 10~60 秒）…")
                        try {
                            TermuxRuntime.ensureExtracted(this@MainActivity) { msg -> log(msg) }
                            log("Termux 环境已解压，检查/安装 Harness 工具与 Linux 常用命令…")
                        } catch (t: Throwable) {
                            log("✗ Termux 准备失败：${t.message}（回退系统 sh）")
                        }
                    }
                    TermuxRuntime.ensureHarnessTools(this@MainActivity) { msg -> log(msg) }
                    runOnUiThread {
                        startActivity(Intent(this@MainActivity, TerminalActivity::class.java))
                    }
                }
            }, getString(R.string.btn_node_check), {
                runNodeDsh()
            })
        }

        // Section: 设置与状态（两列网格）
        addSection("设置与状态") {
            addPair("存储权限", { requestStoragePermissions() },
                    "状态悬浮窗", { startActivity(Intent(this@MainActivity, OverlaySettingsActivity::class.java)) })
            addPair("插件管理", { startActivity(Intent(this@MainActivity, PluginManagerActivity::class.java)) },
                    getString(R.string.btn_stop_all), { stopDshAll() }, color = Ui.DANGER)
        }

        // Section: 日志（标题行右侧带「清空」小按钮）
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
            addView(Ui.sectionLabel(this@MainActivity, "日志"),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Ui.button(this@MainActivity, "清空", {
                logSb.clear()
                logView.text = ""
            }, filled = false, compact = true).apply { minWidth = dp(64); textSize = 12f })
        })

        // 反馈日志栏
        val logCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        logView = TextView(this).apply {
            setTextColor(Ui.TEXT_SECONDARY)
            textSize = 12f
            setPadding(dp(4), dp(2), dp(4), dp(2))
            setLineSpacing(dp(2).toFloat(), 1f)
        }
        logCard.addView(logView)
        root.addView(logCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(14) })

        // Section: 运行环境（环境状态入卡，统一层级）
        root.addView(Ui.sectionLabel(this, "运行环境").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
        })
        val envCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        val envList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun envRow(text: String, color: Int): View = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(4), 0, dp(2))
            addView(Ui.dot(this@MainActivity, 7, color), LinearLayout.LayoutParams(dp(7), dp(7)).apply { rightMargin = dp(8) })
            addView(TextView(this@MainActivity).apply {
                this.text = text
                textSize = 12.5f
                setTextColor(color)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        // 内置 Node / Termux 状态
        envList.addView(envRow(
            if (hasNodeMarker()) "内置 Node：已就绪 ✓" else "内置 Node：未解压（点上方按钮首次自动解压 ⏳）",
            if (hasNodeMarker()) Ui.SUCCESS else Ui.WARNING
        ))
        envList.addView(envRow(
            if (TermuxRuntime.isReady(this@MainActivity)) "内置 Termux：已就绪 ✓（bash + coreutils + apt，可执行 Linux 指令）"
            else "内置 Termux：未解压（首次执行命令/打开终端自动准备）",
            if (TermuxRuntime.isReady(this@MainActivity)) Ui.SUCCESS else Ui.WARNING
        ))
        envList.addView(envRow(
            if (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) "共享存储：可完整访问 /sdcard ✓"
            else "共享存储：未授予“所有文件访问权限”（点上方按钮授权）⚠",
            if (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) Ui.SUCCESS else Ui.WARNING
        ))
        envCard.addView(envList)
        root.addView(envCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })

        // 操作步骤：默认收起（长帮助文本不再占据首屏），点击标题展开/收起
        var helpExpanded = false
        val helpTitle = TextView(this).apply {
            text = "📖 操作步骤与提示 ▸"
            textSize = 12.5f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(18), 0, dp(2))
        }
        val helpBody = TextView(this).apply {
            text = "① 点“⚡ 安装 / 更新 DSH”自动完成：内置 Node 解压 → 官方 npm 安装/更新 dsh → dsh plugin 装配内置插件（首次需联网下载，之后增量更新，不会自动启动）；\n② 点“启动 DSH”启动 Web 服务，“打开 Web 界面”进入 dsh UI（http://127.0.0.1:3080）；\n③ “停止 dsh 服务”结束后台进程与保活服务。\n\n提示：\n· 全程免 Termux，内置 Node 为 aarch64 运行时；\n· 安装日志：/sdcard/Download/DshLauncher/install_log.txt。"
            textSize = 12f
            setTextColor(Ui.TEXT_MUTED)
            setPadding(0, dp(4), 0, 0)
            setLineSpacing(dp(3).toFloat(), 1f)
            visibility = View.GONE
        }
        helpTitle.setOnClickListener {
            helpExpanded = !helpExpanded
            helpBody.visibility = if (helpExpanded) View.VISIBLE else View.GONE
            helpTitle.text = if (helpExpanded) "📖 操作步骤与提示 ▾" else "📖 操作步骤与提示 ▸"
        }
        root.addView(helpTitle)
        root.addView(helpBody)

        return ScrollView(this).apply { addView(root) }
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
        val prefs = getSharedPreferences("dsh_ui", MODE_PRIVATE)
        val last = prefs.getLong("last_apk_version", 0L)
        if (current == last) return
        prefs.edit().putLong("last_apk_version", current).apply()
        log("检测到应用更新（v$current），后台同步内置插件源…")
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
                    AssetSync.markSynced(File(filesDir, ".prebuilt-ok"), current)
                }
                val extraPlugins = File(filesDir, "extra-plugins")
                if (AssetSync.copyAssetDir(this, "extra-plugins", extraPlugins, clearFirst = true)) {
                    AssetSync.markSynced(File(filesDir, ".extra-plugins-ok"), current)
                }
                val dshInstalled = File(filesDir, "plugins").exists() && File(filesDir, "dsh-prefix").exists()
                if (dshInstalled) {
                    prefs.edit().putBoolean("rewire_hint", true).apply()
                    runOnUiThread {
                        log("✓ 内置插件源已同步。建议在「插件管理」执行“重新装配内置插件”。")
                        showUpdateHint()
                    }
                } else {
                    runOnUiThread { log("✓ 内置插件源已同步（新装环境，装配由“一键安装”负责）。") }
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
                "内置插件（如 dsh-vision）需要重新装配后才会使用新代码。"
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
        getSharedPreferences("dsh_ui", MODE_PRIVATE).edit().putBoolean("rewire_hint", false).apply()
        updateBanner?.let { contentRoot?.removeView(it) }
        updateBanner = null
    }

    // ---------------- 状态检测 ----------------
    private fun refreshStatus(silent: Boolean = false) {
        progress.visibility = View.VISIBLE
        if (!silent) log("… 检测 dsh 服务状态…")
        Thread {
            val running = pingServer()
            handler.post {
                progress.visibility = View.GONE
                statusValue.text = if (running) getString(R.string.status_running)
                else getString(R.string.status_stopped)
                val color: Int = if (running) android.graphics.Color.parseColor("#2DB85B")
                else android.graphics.Color.parseColor("#CC4444")
                statusValue.setTextColor(color)
                statusDot.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    setColor(color)
                    // 同色半透明描边 = 轻量光晕，状态点更醒目
                    setStroke(dp(3), Ui.withAlpha(color, 0x38))
                }
                if (!silent) log(if (running) "dsh 服务：运行中（3080 端口）" else "dsh 服务：未运行")
            }
        }.start()
    }

    private fun pingServer(): Boolean = try {
        val conn = URL(WEB_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..399
    } catch (e: Exception) {
        false
    }

    private fun runNodeDsh() {
        if (isExtracting) {
            toast("正在解压中，请稍候…")
            return
        }
        isExtracting = true
        progress.visibility = View.VISIBLE
        AppLog.i("Node", "start ensureExtracted")
        log("▶ 正在解压内置 Node 运行时（首次约需几十秒）…")
        Thread {
            try {
                val nodeDir = NodeRuntime.ensureExtracted(this)
                val marker = File(filesDir, ".node-ok").exists()
                AppLog.i("Node", "ensureExtracted done marker=$marker dir=$nodeDir")
                handler.post {
                    progress.visibility = View.GONE
                    isExtracting = false
                    if (marker) {
                        log("✓ 内置 Node 解压完成")
                        toast("内置 Node 已就绪，正在打开控制台…")
                    }
                    log("▶ 打开控制台并验证 node 版本…")
                    val nodeEnv = NodeRuntime.nodeEnvPrefix(this)
                    startActivity(Intent(this, ConsoleActivity::class.java)
                        .putExtra("cmd", "$nodeEnv $nodeDir/bin/node --version"))
                }
            } catch (t: Throwable) {
                AppLog.e("Node", "extract failed: " + (t.message ?: t.toString()))
                android.util.Log.e("DshNode", "extract failed", t)
                handler.post {
                    progress.visibility = View.GONE
                    isExtracting = false
                    val msg = "✗ Node 运行时解压失败：${t.message}"
                    log(msg)
                    toast(msg)
                }
            }
        }.start()
    }

    /** 是否有内置 Node 解压完成标记。 */
    private fun hasNodeMarker(): Boolean = File(filesDir, ".node-ok").exists()

    /** 停止 dsh 服务：杀 node 相关进程 + 停保活服务 + 刷新状态。 */
    private fun stopDshAll() {
        log("▶ 正在停止 dsh 相关进程…")
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
                log("✓ 已停止 dsh 相关进程与服务")
                refreshStatus()
            }
        }
    }

    /** 在主界面日志栏追加一行（主线程安全），同时写入文件日志与 logcat。 */
    private fun log(msg: String) {
        AppLog.i("Main", msg)
        android.util.Log.i("DshMain", msg)
        handler.post {
            logSb.append("• ").append(msg).append("\n")
            // 保留最近 20 行
            val lines = logSb.toString().split("\n")
            if (lines.size > 20) logSb.clear().append(lines.takeLast(20).joinToString("\n")).append("\n")
            logView.text = logSb.toString()
        }
    }

    private var isExtracting = false

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    companion object {
        private const val WEB_URL = "http://127.0.0.1:3080"
    }
}
