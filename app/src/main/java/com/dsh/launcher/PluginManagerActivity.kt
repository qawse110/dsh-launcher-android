package com.dsh.launcher

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * 插件管理页 —— 整页重构后的信息架构：
 *
 * ┌ 头部：标题 + dsh 服务实时状态 pill + 手动刷新
 * ├ 操作进度条（任何装配/重置/重启期间可见）
 * ├ 概览卡：内置 N · 扩展 M · 异常 K；主操作（一键重置修复[异常时] / 重新装配 / 重启服务）
 * ├ 内置插件：逐个健康卡（目录存在 / package.json 可解析 / 已装配），异常可单修
 * ├ 路由预设：router-spec / router-standard 安装状态
 * ├ 在线扩展：已装配扩展卡片 + 仓库安装入口（输入框内联在本区）
 * ├ 引导卡：插件源未就绪时提供「自动安装并启动」（复用 DshFlow 全量引擎）
 * └ 日志：可折叠控制台，操作输出实时回显
 *
 * 全部操作走 busy 锁防并发；后台线程只经 refreshListSafe 触碰视图。
 */
class PluginManagerActivity : AppCompatActivity() {

    companion object {
        // 内置插件（随 APK 分发；首次 flow 已通过 dsh plugin add 装配）
        val BUNDLED = setOf(
            "dsh-mobile-nav", "dsh-super-injector",
            "dsh-net-proxy", "dsh-provider-headers", "dsh-vision",
            "dsh-oh-we-need", "dsh-status-bridge",
        )
        val BUNDLED_DESC = mapOf(
            "dsh-mobile-nav" to "移动端 UI 适配（窄屏抽屉/全宽会话）",
            "dsh-super-injector" to "超级模组注入器（dev_* 运行时工具全家桶）",
            "dsh-net-proxy" to "网络代理（web_search/web_fetch 走代理）",
            "dsh-provider-headers" to "自定义 provider 请求头（设置页配置）",
            "dsh-vision" to "视觉（view_image 工具 + VLM 后端）",
            "dsh-oh-we-need" to "oh-we-need 推理风格 Skill（按需调用，不再注入系统提示词）",
            "dsh-status-bridge" to "状态桥接（悬浮窗/通知显示 dsh 运行情况）",
        )
        const val PRESET_DIR = "router-preset"
        const val PRESET_DESC = "思维模式路由预设（router-spec / router-standard，agent-presets）"
        const val ROUTING_REPO = "yjh051108/dsh-routing-suite"
        const val OH_WE_NEED_REPO = "scp3500/oh-we-need"
        private val BASE_BUNDLES = setOf(
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@deepseek-ai/dsh-headless",
        )
    }

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var listBox: LinearLayout
    private lateinit var servicePill: TextView
    private lateinit var progress: ProgressBar
    private lateinit var input: EditText
    private lateinit var logView: TextView
    private lateinit var logBody: LinearLayout
    private lateinit var logToggle: TextView
    private val logSb = StringBuilder()

    private lateinit var resetBtn: View
    private lateinit var wireBtn: View
    private lateinit var restartBtn: View
    private lateinit var installBtn: View

    @Volatile
    private var busy = false

    /** 列表代数：异步健康检查回填前校验，避免旧结果覆盖新一轮刷新。 */
    @Volatile
    private var listGeneration = 0

    /** 内置源可用性缓存（key=apkVer:id）。tar -tzf 要解压 30MB tgz，重活只许在后台跑且须缓存。 */
    private val srcAvailCache = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

    private val nodeDir: File get() = NodeRuntime.ensureExtracted(this)

    private fun dshPrefix() = File(filesDir, "dsh-prefix")
    private fun dshCliFile() = File(dshPrefix(), "node_modules/@deepseek-ai/dsh/lib/bin.js")
    private fun pluginsDir() = File(filesDir, "plugins")
    private fun profileWebDir() = File(filesDir, ".dsh/profiles/web")
    private fun profilePkg() = File(profileWebDir(), "package.json")
    private fun presetsRoot() = File(filesDir, ".dsh/.agent-presets")

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!busy) refreshServiceState()
            handler.postDelayed(this, 3_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        setContentView(buildUi())
        appendLog("插件管理就绪（内置 ${BUNDLED.size} 个 + $PRESET_DIR 预设）")
        refreshList()
        handler.post(pollRunnable)
    }

    override fun onResume() {
        super.onResume()
        refreshServiceState()
        refreshList()
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(pollRunnable)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    // ── UI 构建 ───────────────────────────────────────────

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(16), dp(14), dp(16), dp(12))
        }

        // ---- 头部：标题 + 服务状态 + 刷新 ----
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = "插件管理"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        servicePill = Ui.pill(this, "○ dsh 检测中", Ui.TEXT_MUTED)
        header.addView(servicePill, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { rightMargin = dp(8) })
        header.addView(Ui.button(this, "刷新", { onManualRefresh() }, filled = false, compact = true).apply {
            minWidth = dp(64); textSize = 12.5f
        })
        root.addView(header, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        root.addView(TextView(this).apply {
            text = "内置插件随 app 自动装配；在线安装走官方 dsh plugin --profile web add"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(2), 0, 0)
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // ---- 操作进度条 ----
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Ui.BRAND)
        }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(6)
        ).apply { topMargin = dp(8) })

        // ---- 动态列表（概览/内置/预设/在线扩展/引导卡全部在此重建）----
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val listScroll = ScrollView(this).apply { addView(listBox) }
        root.addView(listScroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ).apply { topMargin = dp(8) })

        // ---- 可折叠日志 ----
        root.addView(buildLogCard(), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })

        return root
    }

    /** 日志卡：标题行点击折叠/展开；内容固定高度滚动。 */
    private fun buildLogCard(): View {
        val card = Ui.card(this, radiusDp = 12, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            isClickable = true
            setPadding(dp(4), dp(2), dp(4), dp(2))
        }
        head.addView(TextView(this).apply {
            text = "日志"
            textSize = 12f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_SECONDARY)
            letterSpacing = 0.06f
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        logToggle = TextView(this).apply {
            text = "▾ 收起"
            textSize = 11.5f
            setTextColor(Ui.BRAND)
        }
        head.addView(logToggle)
        col.addView(head)

        logBody = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        logView = TextView(this).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(dp(2), dp(2), dp(2), dp(2))
        }
        val logScroll = ScrollView(this).apply {
            addView(logView, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }
        logBody.addView(logScroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(140)
        ).apply { topMargin = dp(4) })
        col.addView(logBody)

        head.setOnClickListener {
            val expanded = logBody.visibility == View.VISIBLE
            logBody.visibility = if (expanded) View.GONE else View.VISIBLE
            logToggle.text = if (expanded) "▸ 展开" else "▾ 收起"
            if (!expanded) logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
        }

        card.addView(col)
        return card
    }

    // ── 状态与列表渲染 ────────────────────────────────────

    private fun refreshServiceState() {
        thread {
            val up = runCatching { DshFlow.isWebUp() }.getOrDefault(false)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                servicePill.text = if (up) "● dsh 运行中" else "○ dsh 已停止"
                servicePill.setTextColor(if (up) Ui.SUCCESS else Ui.TEXT_MUTED)
                servicePill.background = Ui.rounded(
                    this, Ui.withAlpha(if (up) Ui.SUCCESS else Ui.TEXT_MUTED, 0x1A), 8,
                    if (up) Ui.SUCCESS else Ui.TEXT_MUTED, 1
                )
            }
        }
    }

    private fun onManualRefresh() {
        if (busy) {
            toast("操作进行中，请稍候…")
            return
        }
        refreshServiceState()
        refreshList()
        toast("已刷新")
    }

    private fun refreshList() {
        val gen = ++listGeneration
        listBox.removeAllViews()

        // 未就绪 → 引导卡
        if (!pluginsDir().exists()) {
            listBox.addView(buildBootstrapCard())
            return
        }

        // 骨架先上屏；重活（30MB prebuilt.tgz 的 tar 探测等）全部移到后台——
        // 此前在主线程同步扫描曾把主线程卡过 ANR 阈值，被 ColorOS 直接杀进程（表现为闪退）
        listBox.addView(buildOverviewSkeleton())
        listBox.addView(sectionHeader("内置插件", null))
        listBox.addView(makeCard("健康检测中…", "目录 · package.json · 装配状态 · 内置源可用性", "", "…", emptyList()))
        listBox.addView(sectionHeader("路由预设", null))
        listBox.addView(sectionHeader("在线扩展", null))
        listBox.addView(buildInstallCard())

        thread(name = "plugin-health-scan") {
            val bundled = BUNDLED.sorted().map { id -> Triple(id, healthOf(id), readVersion(id)) }
            val presetOk = listOf("router-spec", "router-standard").any { File(presetsRoot(), it).exists() }
            val extras = readBundles()
                .filter { name -> name !in BASE_BUNDLES && BUNDLED.none { d -> name == d || name == "@dsh-external/$d" } }
                .mapNotNull { name -> readInstalledPlugin(name) }
            val issues = mutableListOf<Pair<String, String>>()
            for ((id, h, _) in bundled) when {
                !h.dirExists -> issues.add(id to "目录缺失")
                !h.healthy -> issues.add(id to "副本损坏")
                !h.wired -> issues.add(id to "未装配")
            }
            if (!presetOk) issues.add(PRESET_DIR to "未安装")

            runOnUiThread {
                if (isFinishing || isDestroyed || gen != listGeneration) return@runOnUiThread
                renderList(bundled, presetOk, extras, issues)
            }
        }
    }

    /** 数据就绪后的完整渲染（主线程，纯视图构建无 IO）。 */
    private fun renderList(
        bundled: List<Triple<String, BundledHealth, String>>,
        presetOk: Boolean,
        extras: List<PluginInfo>,
        issues: List<Pair<String, String>>
    ) {
        listBox.removeAllViews()
        listBox.addView(buildOverviewCard(bundled.size, extras.size, issues))

        listBox.addView(sectionHeader("内置插件", "${bundled.size} 个"))
        for ((id, h, ver) in bundled) {
            val status: String
            val actions = mutableListOf<Pair<String, () -> Unit>>()
            when {
                !h.dirExists -> {
                    status = if (h.srcOk) "缺失 · 可修复" else "未内置（构建产物缺失）"
                    if (h.srcOk) actions.add("恢复" to { repairSingle(id) })
                }
                !h.healthy -> {
                    status = if (h.srcOk) "已损坏 · 可修复" else "已损坏（无内置源）"
                    if (h.srcOk) actions.add("修复" to { repairSingle(id) })
                }
                !h.wired -> {
                    status = "待装配"
                    actions.add("装配" to { wireBundled(id) })
                }
                else -> status = "已装配"
            }
            listBox.addView(makeCard(id, BUNDLED_DESC[id] ?: "", ver, status, actions))
        }

        listBox.addView(sectionHeader("路由预设", null))
        listBox.addView(makeCard(
            PRESET_DIR, PRESET_DESC, "preset",
            if (presetOk) "已安装（agent-presets）" else "待装配",
            if (presetOk) emptyList() else listOf("重新装配" to { rewireBuiltins() })
        ))

        listBox.addView(sectionHeader("在线扩展", "${extras.size} 个"))
        for (info in extras) {
            listBox.addView(makeCard(info.name, info.desc, info.version, "已装配", listOf("卸载" to { uninstall(info.name) })))
        }
        listBox.addView(buildInstallCard())
    }

    /** 健康检测期间的概览占位。 */
    private fun buildOverviewSkeleton(): View {
        val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            text = "正在扫描插件健康状态…"
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_SECONDARY)
        })
        col.addView(TextView(this).apply {
            text = "目录 · package.json · 装配状态 · 内置源可用性"
            textSize = 11.5f
            setTextColor(Ui.TEXT_MUTED)
            setPadding(0, dp(4), 0, 0)
        })
        card.addView(col)
        return card
    }

    private fun sectionHeader(title: String, count: String?): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14); bottomMargin = dp(6) }
            addView(Ui.sectionLabel(this@PluginManagerActivity, title),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (count != null) addView(TextView(this@PluginManagerActivity).apply {
                text = count
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
            })
        }

    /** 概览卡：数量总览 + 异常明细 + 主操作行。 */
    private fun buildOverviewCard(bundledCount: Int, extraCount: Int, issues: List<Pair<String, String>>): View {
        val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val countsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        fun countBlock(num: Int, label: String, color: Int) {
            countsRow.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = android.view.Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(TextView(this@PluginManagerActivity).apply {
                    text = num.toString()
                    textSize = 20f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    setTextColor(color)
                    gravity = android.view.Gravity.CENTER
                })
                addView(TextView(this@PluginManagerActivity).apply {
                    text = label
                    textSize = 11f
                    setTextColor(Ui.TEXT_MUTED)
                    gravity = android.view.Gravity.CENTER
                })
            })
        }
        countBlock(bundledCount, "内置", Ui.TEXT_PRIMARY)
        countBlock(extraCount, "在线扩展", Ui.TEXT_PRIMARY)
        countBlock(issues.size, "异常", if (issues.isEmpty()) Ui.SUCCESS else Ui.DANGER)
        col.addView(countsRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        if (issues.isNotEmpty()) {
            col.addView(TextView(this).apply {
                text = issues.take(3).joinToString("\n") { "· ${it.first}：${it.second}" } +
                    if (issues.size > 3) "\n· …共 ${issues.size} 项" else ""
                textSize = 11.5f
                setTextColor(Ui.WARNING)
                setPadding(0, dp(6), 0, 0)
                setLineSpacing(dp(2).toFloat(), 1f)
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(10), 0, 0)
        }
        if (issues.isNotEmpty()) {
            resetBtn = Ui.button(this, "⚡ 一键重置修复", { resetBuiltins() }, filled = true)
            wireBtn = Ui.button(this, "重新装配", { rewireBuiltins() }, filled = false)
        } else {
            resetBtn = Ui.button(this, "重新装配", { rewireBuiltins() }, filled = false)
            wireBtn = Ui.button(this, "⚡ 重新装配", { rewireBuiltins() }, filled = true)
        }
        restartBtn = Ui.button(this, "重启服务", { restartFlow() }, filled = false)
        btnRow.addView(resetBtn, LinearLayout.LayoutParams(0, dp(44), 1f).apply { rightMargin = dp(6) })
        btnRow.addView(wireBtn, LinearLayout.LayoutParams(0, dp(44), 1f).apply { rightMargin = dp(6) })
        btnRow.addView(restartBtn, LinearLayout.LayoutParams(0, dp(44), 1f))
        col.addView(btnRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        card.addView(col)
        return card
    }

    /** 未就绪引导卡：一键走完整自动安装引擎。 */
    private fun buildBootstrapCard(): View {
        val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER_HIGH, stroke = Ui.WARNING, elevationDp = 1f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            text = "插件源尚未就绪"
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        col.addView(TextView(this).apply {
            text = "首次使用请先完成自动安装：解压内置 Node → npm 安装 dsh → 装配内置插件 → 启动服务。\n全程需联网，约几分钟。"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(6), 0, dp(10))
        })
        col.addView(Ui.button(this, "自动安装并启动", { bootstrapNow() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        })
        card.addView(col)
        return card
    }

    private fun bootstrapNow() {
        if (!guardBusy()) return
        setBusy(true)
        DshFlow.launch(
            this, DshFlow.Mode.INSTALL_AND_START,
            onLog = { line -> runOnUiThread { appendLog(line) } },
            onDone = { ok ->
                runOnUiThread {
                    setBusy(false)
                    toast(if (ok) "安装并启动完成" else "流程未完成，见日志")
                    refreshList()
                }
            }
        )
    }

    // ── 卡片工厂 ──────────────────────────────────────────

    private fun makeCard(name: String, desc: String, ver: String, status: String, actions: List<Pair<String, () -> Unit>>): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER, elevationDp = 1f)
        card.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(6) }

        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        card.addView(content, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        titleRow.addView(TextView(this).apply {
            text = name
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        titleRow.addView(TextView(this).apply {
            text = ver
            textSize = 11f
            setTextColor(Ui.TEXT_MUTED)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { rightMargin = dp(6) }
        })
        titleRow.addView(Ui.pill(this, status, statusColor(status)))
        content.addView(titleRow)

        if (desc.isNotEmpty()) {
            content.addView(TextView(this).apply {
                text = desc
                textSize = 12f
                setTextColor(Ui.TEXT_SECONDARY)
                setPadding(0, dp(4), 0, 0)
                setLineSpacing(dp(1).toFloat(), 1f)
            })
        }
        if (actions.isNotEmpty()) {
            val actRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(8), 0, 0)
            }
            for ((label, fn) in actions) {
                actRow.addView(Ui.button(this, label, { fn() }, filled = false, compact = true).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { rightMargin = dp(6) }
                })
            }
            content.addView(actRow)
        }
        return card
    }

    /** 在线安装入口卡：仓库输入 + 安装按钮（内联在「在线扩展」区尾部）。 */
    private fun buildInstallCard(): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            text = "从 GitHub 仓库安装"
            textSize = 13f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_SECONDARY)
        })
        input = EditText(this).apply {
            hint = "owner/repo 或 https://github.com/owner/repo"
            textSize = 13f
            setTextColor(Ui.TEXT_PRIMARY)
            setHintTextColor(Ui.TEXT_MUTED)
            background = Ui.rounded(this@PluginManagerActivity, Ui.SURFACE_INPUT, 10, Ui.OUTLINE)
            setPadding(dp(12), dp(9), dp(12), dp(9))
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        col.addView(input)
        installBtn = Ui.button(this, "安装 / 更新", { installFromRepo() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        col.addView(installBtn)
        col.addView(TextView(this).apply {
            text = "特殊适配：$ROUTING_REPO（聚合装配）· $OH_WE_NEED_REPO（内置提示词插件）"
            textSize = 10.5f
            setTextColor(Ui.TEXT_MUTED)
            setPadding(0, dp(6), 0, 0)
        })
        card.addView(col)
        return card
    }

    // ── busy 锁 ───────────────────────────────────────────

    private fun guardBusy(): Boolean =
        if (busy) {
            toast("操作进行中，请稍候…")
            false
        } else true

    private fun setBusy(b: Boolean) {
        busy = b
        runOnUiThread {
            progress.visibility = if (b) View.VISIBLE else View.GONE
            // 引导卡路径（插件源未就绪）不会创建主操作按钮：逐个判 isInitialized 防崩
            val btns = mutableListOf<View>()
            if (::resetBtn.isInitialized) btns.add(resetBtn)
            if (::wireBtn.isInitialized) btns.add(wireBtn)
            if (::restartBtn.isInitialized) btns.add(restartBtn)
            if (::installBtn.isInitialized) btns.add(installBtn)
            btns.forEach {
                it.isEnabled = !b
                it.alpha = if (b) 0.5f else 1f
            }
        }
    }

    private fun appendLog(m: String) {
        logSb.append("${System.currentTimeMillis() % 100000}\t$m\n")
        if (logSb.length > 20000) logSb.delete(0, logSb.length / 2)
        runOnUiThread { logView.text = logSb.toString() }
    }

    /** 后台线程安全版列表刷新。 */
    private fun refreshListSafe() {
        runOnUiThread { refreshList() }
    }

    // ── 健康检查 ──────────────────────────────────────────

    private data class BundledHealth(val dirExists: Boolean, val healthy: Boolean, val wired: Boolean, val srcOk: Boolean)

    /** 只许在后台线程调用（srcOk 的 tar 探测是重活，结果按 apkVer:id 缓存）。 */
    private fun healthOf(id: String): BundledHealth {
        val dir = File(pluginsDir(), id)
        val key = AssetSync.apkVersion(this).toString() + ":" + id
        val srcOk = srcAvailCache[key] ?: bundledSourceAvailable(id).also { srcAvailCache[key] = it }
        return BundledHealth(dir.isDirectory, bundleHealthy(dir), isWired(id), srcOk)
    }

    /** 目录健康：package.json 存在、可解析、name 非空（空壳损坏判定）。 */
    private fun bundleHealthy(dir: File): Boolean {
        val p = File(dir, "package.json")
        if (!p.isFile) return false
        val j = runCatching { JSONObject(p.readText()) }.getOrNull() ?: return false
        return j.optString("name").isNotBlank()
    }

    /** APK 内是否带有该插件的可用源：extra-plugins 直拷源，或 prebuilt.tgz 内 third_party 子树。 */
    private fun bundledSourceAvailable(id: String): Boolean {
        if (File(filesDir, "extra-plugins/$id/package.json").isFile) return true
        val tgz = File(filesDir, "prebuilt.tgz")
        if (!tgz.isFile) return false
        return runCatching {
            // v4.5 唯一 shell：内置 Termux bash
            val bash = TermuxRuntime.bashPath(this)
            if (!bash.isFile) return false
            val pb = ProcessBuilder(
                bash.absolutePath, "-c",
                "tar -tzf '${tgz.absolutePath}' './third_party/$id/package.json' 2>/dev/null | head -n 1"
            )
            pb.redirectErrorStream(true)
            val p = pb.start()
            val line = p.inputStream.bufferedReader().readLine()
            p.waitFor()
            !line.isNullOrBlank()
        }.getOrDefault(false)
    }

    /** 从内置源恢复单个插件目录：extra-plugins 直拷；否则 prebuilt.tgz 解包子树。 */
    private fun repairFromSource(id: String): Boolean {
        val dst = File(pluginsDir(), id)
        dst.deleteRecursively()
        val extraSrc = File(filesDir, "extra-plugins/$id")
        if (File(extraSrc, "package.json").isFile) {
            return runCatching {
                extraSrc.copyRecursively(dst, overwrite = true)
                bundleHealthy(dst)
            }.getOrDefault(false)
        }
        val tgz = File(filesDir, "prebuilt.tgz")
        if (!tgz.isFile) return false
        val tmp = File(filesDir, "tmp/repair-$id")
        tmp.deleteRecursively()
        tmp.mkdirs()
        val cmd = "tar -xzf '${tgz.absolutePath}' -C '${tmp.absolutePath}' './third_party/$id'"
        if (runProcess(cmd, baseEnv(), "解包 $id") != 0) return false
        val src = File(tmp, "third_party/$id")
        val ok = File(src, "package.json").isFile &&
            runCatching {
                src.copyRecursively(dst, overwrite = true)
                bundleHealthy(dst)
            }.getOrDefault(false)
        tmp.deleteRecursively()
        return ok
    }

    // ── 数据读取 ──────────────────────────────────────────

    private fun readBundles(): List<String> {
        return try {
            val j = JSONObject(profilePkg().readText())
            val arr = j.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles") ?: return emptyList()
            (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
        } catch (t: Throwable) {
            emptyList()
        }
    }

    /** 装配判定：官方 dsh plugin add 后会在 profile node_modules 出现对应包。 */
    private fun isWired(d: String): Boolean {
        val nm = profileNm()
        if (File(nm, d).exists()) return true
        if (File(nm, "@dsh-external/$d").exists()) return true
        return readBundles().any { it == d || it == "@dsh-external/$d" }
    }

    private fun profileNm() = File(profileWebDir(), "node_modules")

    data class PluginInfo(val id: String, val name: String, val desc: String, val version: String)

    private fun readInstalledPlugin(name: String): PluginInfo? {
        val dir = resolvePackageDir(name) ?: return null
        val p = File(dir, "package.json")
        if (!p.exists()) return null
        return try {
            val j = JSONObject(p.readText())
            PluginInfo(
                name,
                j.optString("name", name),
                j.optString("description", "").take(80),
                j.optString("version", "?")
            )
        } catch (t: Throwable) {
            PluginInfo(name, name, "", "?")
        }
    }

    private fun resolvePackageDir(name: String): File? {
        if (File(profileNm(), name).isDirectory) return File(profileNm(), name)
        if (name.contains('/')) {
            val scoped = File(profileNm(), name.substringBefore('/') + "/" + name.substringAfter('/'))
            if (scoped.isDirectory) return scoped
        }
        return null
    }

    private fun readVersion(dir: String): String {
        val p = File(File(pluginsDir(), dir), "package.json")
        if (!p.exists()) return "?"
        return try {
            JSONObject(p.readText()).optString("version", "?")
        } catch (t: Throwable) {
            "?"
        }
    }

    /** 状态 pill 颜色显式映射（「已损坏」不得命中 contains(已) 变绿）。 */
    private fun statusColor(status: String): Int = when {
        status.contains("已装配") || status.contains("已安装") || status.contains("已连接") -> Ui.SUCCESS
        status.contains("损坏") || status.contains("缺失") -> Ui.DANGER
        status.contains("待") || status.contains("需") -> Ui.WARNING
        else -> Ui.TEXT_MUTED
    }

    // ── 操作：在线安装 ────────────────────────────────────

    private fun installFromRepo() {
        if (!guardBusy()) return
        val raw = input.text.toString().trim()
        val repo = parseRepo(raw)
        if (repo == null) {
            appendLog("仓库格式无效：$raw（应形如 owner/repo 或 https://github.com/owner/repo）")
            return
        }
        when (repo) {
            ROUTING_REPO -> {
                appendLog(">> 特殊适配安装 $repo …")
                runRoutingSuite()
            }
            OH_WE_NEED_REPO -> {
                appendLog(">> $repo 是纯提示词仓库，已内置为 dsh-oh-we-need 插件；触发重新装配…")
                rewireBuiltins()
            }
            else -> runDshPlugin(listOf("add", "github:$repo"), "安装 $repo")
        }
    }

    private fun parseRepo(raw: String): String? {
        var r = raw.trim().removeSuffix("/").removeSuffix(".git")
        if (r.startsWith("github:")) r = r.removePrefix("github:")
        if (r.startsWith("https://github.com/")) r = r.removePrefix("https://github.com/")
        else if (r.startsWith("http://github.com/")) r = r.removePrefix("http://github.com/")
        if (r.startsWith("github.com/")) r = r.removePrefix("github.com/")
        val seg = r.split("/")
        if (seg.size < 2 || seg[0].isEmpty() || seg[1].isEmpty()) return null
        return "${seg[0]}/${seg[1]}"
    }

    // ── dsh plugin CLI ─────────────────────────────────────

    /** 同步执行 dsh plugin 子命令（阻塞；调用方负责线程与 busy）。 */
    private fun dshPluginSync(args: List<String>, label: String): Int {
        ensureHarnessTools()
        val cli = dshCliFile()
        if (!cli.exists()) {
            appendLog("   ✗ dsh 未安装（请先完成一次自动安装）")
            return -1
        }
        val node = File(File(nodeDir, "bin"), "node")
        val cmd = "${node.absolutePath} ${cli.absolutePath} plugin --profile web ${args.joinToString(" ")}"
        appendLog(">> $label …")
        appendLog("   $ ${cmd.replace(cli.absolutePath, "dsh")}")
        val code = runProcess(cmd, baseEnv(), label)
        appendLog(if (code == 0) "   ✓ $label 完成（exit=0）" else "   ✗ $label 失败（exit=$code）")
        return code
    }

    /** 异步包装（卸载/在线安装等独立操作）。 */
    private fun runDshPlugin(args: List<String>, label: String) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                dshPluginSync(args, label)
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("$label 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /** 单个内置插件「装配」：目录健康但未注册进 profile。 */
    private fun wireBundled(id: String) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                val path = File(pluginsDir(), id).absolutePath
                dshPluginSync(listOf("add", path), "装配 $id")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("装配 $id 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /** 单个内置插件「修复/恢复」：清异常副本 → 从内置源恢复 → 注册进 profile。 */
    private fun repairSingle(id: String) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                ensureHarnessTools()
                syncExtraPluginsSource()
                appendLog(">> 修复 $id …")
                if (!repairFromSource(id)) {
                    appendLog("   ✗ $id 恢复失败（无可用内置源或解包失败）")
                    return@Thread
                }
                val path = File(pluginsDir(), id).absolutePath
                dshPluginSync(listOf("add", path), "装配 $id")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("修复 $id 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /** 重新装配内置插件：--plugins-only，不改 dsh 本体。 */
    private fun rewireBuiltins() {
        if (!guardBusy()) return
        AlertDialog.Builder(this)
            .setTitle("重新装配内置插件")
            .setMessage("跳过 npm 更新，仅重新装配全部内置插件与路由预设（--plugins-only）。继续？")
            .setPositiveButton("执行") { _, _ ->
                setBusy(true)
                Thread {
                    try {
                        ensureHarnessTools()
                        val code = rewireCore("重新装配")
                        if (code == 0) appendLog("   ✓ 重新装配完成")
                        refreshListSafe()
                    } catch (t: Throwable) {
                        appendLog("重新装配异常: ${t.message}")
                    } finally {
                        setBusy(false)
                    }
                }.start()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 一键重置：同步源 → 修复异常副本 → 整体重新装配。 */
    private fun resetBuiltins() {
        if (!guardBusy()) return
        AlertDialog.Builder(this)
            .setTitle("一键重置内置插件")
            .setMessage("将清理损坏/缺失的插件副本并从 APK 内置源恢复，然后整体重新装配。\n不动 dsh 本体与已安装的在线扩展。继续？")
            .setPositiveButton("重置") { _, _ ->
                setBusy(true)
                Thread {
                    try {
                        ensureHarnessTools()
                        syncExtraPluginsSource()
                        for (id in BUNDLED.sorted()) {
                            val h = healthOf(id)
                            val needsRepair = (!h.dirExists || !h.healthy) && h.srcOk
                            if (needsRepair) {
                                appendLog(">> 恢复 $id …")
                                appendLog(if (repairFromSource(id)) "   ✓ $id 已从内置源恢复" else "   ✗ $id 恢复失败")
                            } else if (h.dirExists && !h.healthy) {
                                appendLog("   ⚠ $id 损坏且无内置源可恢复，跳过")
                            }
                        }
                        val code = rewireCore("重置装配")
                        appendLog(if (code == 0) "✓ 一键重置完成" else "✗ 重置装配失败（exit=$code），可再试或查看日志")
                    } catch (t: Throwable) {
                        appendLog("重置异常: ${t.message}")
                    } finally {
                        setBusy(false)
                        refreshListSafe()
                    }
                }.start()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 同步 assets 的 extra-plugins 源到 files（clearFirst 自愈坏拷贝）。 */
    private fun syncExtraPluginsSource() {
        val apkVer = AssetSync.apkVersion(this)
        val dest = File(filesDir, "extra-plugins")
        val marker = File(filesDir, ".extra-plugins-ok")
        if (AssetSync.isSynced(marker, dest, apkVer)) return
        try {
            if (AssetSync.copyAssetDir(this, "extra-plugins", dest, clearFirst = true)) {
                AssetSync.markSynced(marker, apkVer)
                appendLog("   extra-plugins 源已同步（${dest.walkTopDown().count { it.isFile }} 个文件）")
            }
        } catch (t: Throwable) {
            appendLog("   WARN extra-plugins 同步失败：${t.message}")
        }
    }

    /** --plugins-only 核心（供「重新装配」与「一键重置」复用）。 */
    private fun rewireCore(label: String): Int {
        val apkVer = AssetSync.apkVersion(this)
        val installScript = File(filesDir, "install-dsh.mjs")
        if (!AssetSync.copyAsset(this, "install-dsh.mjs", installScript) && !installScript.exists()) {
            appendLog("   ✗ $label 失败：install-dsh.mjs 缺失")
            return -1
        }
        val prebuilt = File(filesDir, "prebuilt.tgz")
        val prebuiltMarker = File(filesDir, ".prebuilt-ok")
        if (AssetSync.isSynced(prebuiltMarker, prebuilt, apkVer)) {
            appendLog("   内置插件源已是最新，跳过复制")
        } else if (AssetSync.copyAsset(this, "prebuilt.tgz", prebuilt)) {
            AssetSync.markSynced(prebuiltMarker, apkVer)
            appendLog("   内置插件源 ${prebuilt.length() / 1024 / 1024}MB")
        } else {
            appendLog("   WARN 无法复制 prebuilt.tgz，继续使用已有源")
        }
        val node = File(File(nodeDir, "bin"), "node")
        val cmd = "${node.absolutePath} ${installScript.absolutePath} --plugins-only"
        val env = baseEnv().apply {
            put("DSH_PREFIX", dshPrefix().absolutePath)
            put("DSH_PROFILE", "web")
            put("DSH_PREBUILT", prebuilt.absolutePath)
            put("DSH_PLUGINS_DIR", pluginsDir().absolutePath)
            put("DSH_APK_VER", apkVer.toString())
        }
        return runProcess(cmd, env, label)
    }

    /** yjh051108/dsh-routing-suite 特殊适配：走 routing-suite.mjs。 */
    private fun runRoutingSuite() {
        setBusy(true)
        Thread {
            try {
                ensureHarnessTools()
                appendLog(">> 特殊适配安装/更新 dsh-routing-suite…")
                val script = File(filesDir, "routing-suite.mjs")
                assets.open("routing-suite.mjs").use { input ->
                    script.outputStream().use { output -> input.copyTo(output) }
                }
                val node = File(File(nodeDir, "bin"), "node")
                val cmd = "${node.absolutePath} ${script.absolutePath}"
                val env = baseEnv().apply {
                    put("DSH_PREFIX", dshPrefix().absolutePath)
                    put("DSH_PROFILE", "web")
                    put("DSH_ROUTING_REPO", ROUTING_REPO)
                    put("DSH_ROUTING_DIR", File(filesDir, "routing-suite").absolutePath)
                }
                val code = runProcess(cmd, env, "routing-suite 特殊安装")
                appendLog(if (code == 0) "   ✓ routing-suite 安装/更新完成" else "   ✗ routing-suite 安装/更新失败（exit=$code）")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("routing-suite 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /** 卸载：官方 dsh plugin --profile web remove <package>。 */
    private fun uninstall(name: String) {
        runDshPlugin(listOf("remove", name), "卸载 $name")
    }

    /** 确保内置 Termux 与 Harness 工具就绪，失败仅记录不中断插件操作。 */
    private fun ensureHarnessTools() {
        try {
            if (!TermuxRuntime.isReady(this)) {
                appendLog(">> 准备内置 Termux 环境…")
                TermuxRuntime.ensureExtracted(this) { appendLog(it) }
            }
            TermuxRuntime.ensureHarnessTools(this) { appendLog(it) }
        } catch (t: Throwable) {
            appendLog("WARN ensureHarnessTools: ${t.message}")
        }
    }

    private fun baseEnv(): MutableMap<String, String> {
        val node = nodeDir
        val tools = File(filesDir, ".tools")
        val termux = File(filesDir, "termux/usr")
        // v4.5 唯一环境：内置 Termux（不再按 termuxReady 分叉）
        val path = listOf(
            File(termux, "bin").absolutePath,
            File(termux, "bin/applets").absolutePath,
            File(termux, "local/bin").absolutePath,
            File(node, "bin").absolutePath,
            File(tools, "bin").absolutePath,
            File(tools, "lib/node_modules/.bin").absolutePath,
            "/system/bin"
        ).joinToString(":")
        val gitConfig = File(filesDir, ".gitconfig")
        if (!gitConfig.exists()) gitConfig.writeText("")
        return mutableMapOf(
            "PATH" to path,
            "HOME" to filesDir.absolutePath,
            "LD_LIBRARY_PATH" to "${File(node, "lib").absolutePath}:${File(termux, "lib").absolutePath}",
            "PREFIX" to termux.absolutePath,
            "GIT_EXEC_PATH" to File(termux, "libexec/git-core").absolutePath,
            "GIT_CONFIG_NOSYSTEM" to "1",
            "GIT_CONFIG_GLOBAL" to gitConfig.absolutePath,
            "TMPDIR" to File(filesDir, "tmp").absolutePath,
            "TMP" to File(filesDir, "tmp").absolutePath,
            "TEMP" to File(filesDir, "tmp").absolutePath,
            "TERM" to "xterm-256color",
            "OPENSSL_CONF" to "/dev/null"
        )
    }

    private fun runProcess(cmd: String, env: Map<String, String>, label: String): Int {
        appendLog("   $ $cmd")
        return try {
            // v4.5 唯一 shell：内置 Termux bash
            val bash = TermuxRuntime.bashPath(this)
            if (!bash.isFile) {
                appendLog("   ✗ 内置 Termux 未就绪，命令未执行")
                return -1
            }
            val pb = ProcessBuilder(bash.absolutePath, "-c", cmd)
            pb.redirectErrorStream(true)
            // 可写工作目录：插件健康检查/重置命令的相对路径操作不受 cwd=/ 影响
            pb.directory(File(filesDir, "tmp").apply { mkdirs() })
            val e = pb.environment()
            env.forEach { (k, v) -> e[k] = v }
            val p = pb.start()
            val sb = StringBuilder()
            p.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    sb.append(line).append('\n')
                    if (sb.length > 4000) { appendLog(sb.toString()); sb.setLength(0) }
                }
            }
            val code = p.waitFor()
            if (sb.isNotEmpty()) appendLog(sb.toString())
            appendLog("   exit=$code ($label)")
            code
        } catch (t: Throwable) {
            appendLog("   $label 执行异常: ${t.message}")
            -1
        }
    }

    /** 重启 dsh：杀 node 后快速启动（秒级）。 */
    private fun restartFlow() {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 重启 dsh 服务（快速启动，不做安装）…")
        thread {
            DshFlow.killAllNode(this) { appendLog(it) }
            Thread.sleep(1500)
            runOnUiThread {
                DshFlow.launch(
                    this, DshFlow.Mode.START_ONLY,
                    onLog = { appendLog(it) },
                    onDone = { ok ->
                        setBusy(false)
                        refreshServiceState()
                        appendLog(if (ok) "✓ dsh 已重启（http://127.0.0.1:${DshFlow.WEB_PORT}）" else "✗ 重启失败，详见上方日志")
                    }
                )
            }
        }
    }
}
