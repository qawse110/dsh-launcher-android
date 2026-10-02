package com.dsh.nextapp1.ui

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
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread
import com.dsh.nextapp1.core.*
import com.dsh.nextapp1.overlay.*
import com.dsh.nextapp1.service.*
import com.dsh.nextapp1.tts.*
import com.dsh.nextapp1.ui.*
import com.dsh.nextapp1.R

/**
 * 插件管理页 —— 整页重构后的信息架构（**清单驱动**）：
 *
 * 插件集合的唯一真源是 assets/plugin-manifest.json（DshFlow 拷到 files/plugin-manifest.json）：
 *   builtin  → 随 APK 装配，源目录 files/extra-plugins/<dir>
 *   optional → 随 APK 分发但默认不装配，源目录 files/optional-plugins/<dir>，按需装配
 * 本页不再硬编码任何插件表。
 *
 * ┌ 头部：标题 + dsh 服务实时状态 pill + 手动刷新
 * ├ 操作进度条（任何装配/重置/重启期间可见）
 * ├ 概览卡：内置 N · 可选 M · 在线扩展 K · 异常 J；主操作（一键重置修复[异常时] / 重新装配 / 重启服务）
 * ├ 内置插件：清单 builtin，逐个健康卡（目录存在 / package.json 可解析 / 已装配 / 副本是否落后于源）
 * ├ 可选插件：清单 optional（源目录存在才显示该分区），已装配的可卸载、未装配的可装配
 * ├ 在线扩展：已装配扩展卡片 + 仓库安装入口（输入框内联在本区）
 * ├ 引导卡：插件源未就绪时提供「自动安装并启动」（复用 DshFlow 全量引擎）
 * └ 日志：可折叠控制台，操作输出实时回显
 *
 * 全部操作走 busy 锁防并发；后台线程只经 refreshListSafe 触碰视图。
 */
class PluginManagerActivity : AppCompatActivity() {

    companion object {
        /**
         * 插件装配清单文件名 —— **单一真源**（app/src/main/assets/plugin-manifest.json，
         * DshFlow 会把它拷到 files/plugin-manifest.json）。
         *
         * builtin = 随 APK 装配的插件；optional = 随 APK 分发但**默认不装配**的插件。
         * 本页的展示、装配源、健康检查全部从该清单派生，Kotlin 侧不再维护并行的硬编码表
         * （install-dsh.mjs 读同一份清单，装配面与展示面不可能再漂移）。
         */
        const val MANIFEST_NAME = "plugin-manifest.json"

        /**
         * 路由预设已于 v4.10.3 从内置资产下线（其源码曾随旧的内置插件压缩包分发），
         * 故不再有 PRESET 卡片。需要时走「在线扩展」里的路由套件安装（ROUTING_REPO）。
         *
         * 「清理老设备残留」原由 install-dsh.mjs 的 removePresets() 承担，**该函数已删除**：
         * 它维护的是一份写死的 `router-*` 预设名单，而 .agent-presets 只有
         * routing-suite.mjs（外部可选套件）才会创建 —— 内置装配链从不创建该目录，
         * 所以那份名单在本仓内置路径上**恒不命中**；而且它把 routing-suite 仍在使用的
         * 三个预设也列了进去，装了套件后再跑一次内置装配会误删。
         * 真正退役的 router-pro 由 routing-suite.mjs 自己按**上游发布内容比对**清理，
         * 不需要本仓另存一份名单。
         */
        const val ROUTING_REPO = "yjh051108/dsh-routing-suite"

        /** dsh 自身的 bundle（非第三方插件）：用于把「在线扩展」里的 dsh 本体排除掉。 */
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

    /** 插件源可用性缓存（key=apkVer:源目录:dir），避免刷新时重复做目录 IO。 */
    private val srcAvailCache = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

    private val nodeDir: File get() = NodeRuntime.ensureExtracted(this)

    private fun dshPrefix() = File(filesDir, "dsh-prefix")
    private fun dshCliFile() = File(dshPrefix(), "node_modules/@deepseek-ai/dsh/lib/bin.js")
    private fun pluginsDir() = File(filesDir, "plugins")

    /** 可选插件源（随 APK 分发、默认不装配）：files/optional-plugins，由 DshFlow 从 assets 同步。 */
    private fun optionalPluginsDir() = File(filesDir, "optional-plugins")
    private fun profileWebDir() = File(filesDir, ".dsh/profiles/web")
    private fun profilePkg() = File(profileWebDir(), "package.json")

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
        appendLog("插件管理就绪（清单驱动：$MANIFEST_NAME）")
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
            text = "内置插件随 app 自动装配，可选插件按需装配；在线安装走官方 dsh plugin --profile web add"
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

        // ---- 动态列表（概览/内置/可选/在线扩展/引导卡全部在此重建）----
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

        // 骨架先上屏；重活（清单解析、目录内容指纹比对等）全部移到后台——
        // 此前在主线程同步扫描曾把主线程卡过 ANR 阈值，被 ColorOS 直接杀进程（表现为闪退）
        listBox.addView(buildOverviewSkeleton())
        listBox.addView(sectionHeader("内置插件", null))
        listBox.addView(makeCard("健康检测中…", "清单 · 目录 · package.json · 装配状态 · 源可用性", "", "…", emptyList()))
        listBox.addView(sectionHeader("在线扩展", null))
        listBox.addView(buildInstallCard())

        thread(name = "plugin-health-scan") {
            val manifest = loadManifest()
            // 兼容性判定一次读入（dsh 0.2.0 起的装配契约，见 readCompatStatus 注释）
            compatStatus = readCompatStatus()
            // 可选插件源目录不存在时（旧 APK / 资产未同步）整区不显示，也不参与健康扫描
            val optionalEntries = if (optionalPluginsDir().isDirectory) manifest.optional else emptyList()
            val bundled = manifest.builtin.map { e -> Triple(e, healthOf(e), readVersion(e.dir)) }
            val optionals = optionalEntries.map { e -> Triple(e, healthOf(e), readVersion(e.dir)) }
            // 「在线扩展」= profile 里登记、但没在上方两个分区渲染出来的 bundle。
            // 用「实际渲染的条目」而非整份清单来排除：optional 源目录缺失时该分区整体不显示，
            // 此时已装配的 optional 会落到「在线扩展」里（仍可见、可卸载），绝不重复两份。
            val knownNames = (bundled.map { it.first } + optionals.map { it.first })
                .flatMap { listOf(it.dir, it.name, it.id) }
                .toSet()
            val extras = readBundles()
                .filter { name -> name !in BASE_BUNDLES && name !in knownNames }
                .mapNotNull { name -> readInstalledPlugin(name) }
            val issues = mutableListOf<Pair<String, String>>()
            if (manifest.error != null) issues.add("清单" to manifest.error)
            for ((e, h, _) in bundled) when {
                !h.dirExists -> issues.add(e.dir to "目录缺失")
                !h.healthy -> issues.add(e.dir to "副本损坏")
                !h.wired -> issues.add(e.dir to "未装配")
                // 装配了却会被运行时禁用：与"未装配"同等严重，必须进总览计数
                h.compat?.compatible == false -> issues.add(e.dir to "与 dsh 不兼容")
            }
            for ((e, h, _) in optionals) when {
                // optional「未装配」是正常态，不算异常；只有已有副本损坏、或登记了却没副本才提示
                h.dirExists && !h.healthy -> issues.add(e.dir to "可选副本损坏")
                h.wired && !h.dirExists -> issues.add(e.dir to "可选已登记但副本缺失")
            }

            val installedDsh = readInstalledDshVersion()
            runOnUiThread {
                if (isFinishing || isDestroyed || gen != listGeneration) return@runOnUiThread
                renderList(manifest, bundled, optionals, extras, issues, installedDsh)
            }
        }
    }

    /** 数据就绪后的完整渲染（主线程，纯视图构建无 IO）。 */
    private fun renderList(
        manifest: PluginManifest,
        bundled: List<Triple<PluginEntry, BundledHealth, String>>,
        optionals: List<Triple<PluginEntry, BundledHealth, String>>,
        extras: List<PluginInfo>,
        issues: List<Pair<String, String>>,
        installedDsh: String?
    ) {
        listBox.removeAllViews()
        listBox.addView(buildOverviewCard(bundled.size, optionals.size, extras.size, issues, manifest.targetDsh, installedDsh))

        listBox.addView(sectionHeader("内置插件", "${bundled.size} 个"))
        // 清单不可用时不静默空列表：显式告警卡（原因已由 loadManifest 写入日志）
        if (manifest.error != null) listBox.addView(buildManifestWarnCard(manifest.error))
        for ((e, h, ver) in bundled) {
            val status: String
            val actions = mutableListOf<Pair<String, () -> Unit>>()
            when {
                !h.dirExists -> {
                    status = if (h.srcOk) "缺失 · 可修复" else "未内置（构建产物缺失）"
                    if (h.srcOk) actions.add("恢复" to { repairSingle(e) })
                }
                !h.healthy -> {
                    status = if (h.srcOk) "已损坏 · 可修复" else "已损坏（无内置源）"
                    if (h.srcOk) actions.add("修复" to { repairSingle(e) })
                }
                !h.wired -> {
                    status = "待装配"
                    actions.add("装配" to { wireBundled(e) })
                }
                // ★ 「结构完好但内容落后」单列：旧逻辑落到 else 显示"已装配"，
                //   而运行时加载的正是这份旧副本 → 装了新 APK 仍跑旧代码却毫无提示
                //   （真机事故：只在启动时以「web 未就绪」炸出来，极难定位）。
                h.staleVsSource -> {
                    status = "已装配 · 副本落后于内置源"
                    if (h.srcOk) actions.add("修复" to { repairSingle(e) })
                }
                // ★ 兼容性门禁（dsh 0.2.0 起）：装配成功、结构完好，但 peer 范围不覆盖
                //   运行时版本 → dsh 在加载时把该行标 disabled，插件**静默不生效**。
                //   旧逻辑落进 else 显示"已装配"，用户完全看不出它其实没跑起来。
                h.compat?.compatible == false -> {
                    status = "已装配 · 与 dsh 不兼容（运行时禁用）"
                }
                // ★ 用户主动禁用：依赖还在、只是不在 bundles 里。旧逻辑会显示"已装配"
                //   并给不出任何操作，用户再也点不回来 —— 这里必须单列并给「启用」。
                !h.bundled -> {
                    status = "已装配 · 已禁用"
                    actions.add("启用" to { setBundled(e, true, "启用 ${e.dir}") })
                }
                else -> {
                    status = "已装配"
                    actions.add("禁用" to { setBundled(e, false, "禁用 ${e.dir}") })
                }
            }
            listBox.addView(makeCard(e.title.ifBlank { e.dir }, e.desc, ver, status, actions))
        }

        // ── 可选插件：随 APK 分发、默认不装配；源目录存在才显示该分区 ──
        if (optionals.isNotEmpty()) {
            listBox.addView(sectionHeader("可选插件", "${optionals.size} 个"))
            for ((e, h, ver) in optionals) {
                val status: String
                val actions = mutableListOf<Pair<String, () -> Unit>>()
                when {
                    !h.dirExists && !h.wired -> {
                        status = if (h.srcOk) "未装配" else "未装配（源缺失）"
                        if (h.srcOk) actions.add("装配" to { wireOptional(e) })
                    }
                    !h.dirExists -> {
                        status = if (h.srcOk) "已登记 · 副本缺失" else "已登记 · 副本缺失（无源）"
                        if (h.srcOk) actions.add("恢复" to { repairSingle(e) })
                    }
                    !h.healthy -> {
                        status = if (h.srcOk) "副本损坏 · 可修复" else "副本损坏（无源）"
                        if (h.srcOk) actions.add("修复" to { repairSingle(e) })
                    }
                    !h.wired -> {
                        status = "副本已就绪 · 待装配"
                        actions.add("装配" to { wireBundled(e) })
                    }
                    h.staleVsSource -> {
                        status = "已装配 · 副本落后于源"
                        if (h.srcOk) actions.add("修复" to { repairSingle(e) })
                    }
                    else -> {
                        status = "已装配"
                        actions.add("卸载" to { uninstall(e.name) })
                    }
                }
                listBox.addView(makeCard(e.title.ifBlank { e.dir }, e.desc, ver, status, actions))
            }
        }

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
            text = "清单 · 目录 · package.json · 装配状态 · 源可用性"
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

    /** 概览卡：数量总览 + dsh 版本对齐状态 + 异常明细 + 主操作行。 */
    private fun buildOverviewCard(
        builtinCount: Int,
        optionalCount: Int,
        extraCount: Int,
        issues: List<Pair<String, String>>,
        targetDsh: String?,
        installedDsh: String?,
    ): View {
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
        countBlock(builtinCount, "内置", Ui.TEXT_PRIMARY)
        countBlock(optionalCount, "可选", Ui.TEXT_PRIMARY)
        countBlock(extraCount, "在线扩展", Ui.TEXT_PRIMARY)
        countBlock(issues.size, "异常", if (issues.isEmpty()) Ui.SUCCESS else Ui.DANGER)
        col.addView(countsRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // dsh 版本对齐：清单声明的 targetDsh 是插件副本的适配基准。
        // 装着的 dsh 与它不一致时，插件的 peer 判定很可能是拿旧范围对新运行时
        // ——那正是兼容性门禁最容易踩空的地方，所以在总览里直接摆出来。
        if (targetDsh != null || installedDsh != null) {
            val aligned = targetDsh != null && installedDsh != null && targetDsh == installedDsh
            col.addView(TextView(this).apply {
                text = buildString {
                    append("dsh：已装 ").append(installedDsh ?: "未知")
                    append(" · 清单目标 ").append(targetDsh ?: "未声明")
                    if (targetDsh != null && installedDsh != null && !aligned) append("（不一致）")
                }
                textSize = 11.5f
                setTextColor(if (aligned || targetDsh == null || installedDsh == null) Ui.TEXT_MUTED else Ui.WARNING)
                setPadding(0, dp(6), 0, 0)
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }

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
        fun addBtn(b: View, hasRightMargin: Boolean) {
            btnRow.addView(b, LinearLayout.LayoutParams(0, dp(44), 1f).apply {
                if (hasRightMargin) rightMargin = dp(6)
            })
        }
        if (issues.isNotEmpty()) {
            // 异常态三钮：一键重置修复（主） / 重新装配 / 重启服务
            resetBtn = Ui.button(this, "⚡ 一键重置修复", { resetBuiltins() }, filled = true)
            wireBtn = Ui.button(this, "重新装配", { rewireBuiltins() }, filled = false)
            restartBtn = Ui.button(this, "重启服务", { restartFlow() }, filled = false)
            addBtn(resetBtn, true)
            addBtn(wireBtn, true)
            addBtn(restartBtn, false)
        } else {
            // 正常态两钮：旧实现把 resetBtn 又赋成了重复的「重新装配」且无条件加入行内，
            // 导致页面上出现两个功能相同的「重新装配」；此处不再创建 resetBtn
            // （setBusy 已按 isInitialized 逐个判空，lateinit 未初始化安全）
            wireBtn = Ui.button(this, "⚡ 重新装配", { rewireBuiltins() }, filled = true)
            restartBtn = Ui.button(this, "重启服务", { restartFlow() }, filled = false)
            addBtn(wireBtn, true)
            addBtn(restartBtn, false)
        }
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
            text = "特殊适配：$ROUTING_REPO（聚合装配）"
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

    private data class BundledHealth(
        val dirExists: Boolean,
        val healthy: Boolean,
        val wired: Boolean,
        val srcOk: Boolean,
        /** 装配副本落后于内置源（装了新 APK 但副本未刷新）。 */
        val staleVsSource: Boolean = false,
        /** 对钉死版 dsh 的兼容性判定；无数据（未审计过）时为 null。 */
        val compat: CompatInfo? = null,
        /**
         * 是否登记在 profile 的 bundles 里（= dsh 启动时会加载它）。
         *
         * 放在这里由后台线程算，而**不是**在 renderList 里现读：本页曾因主线程同步
         * 扫描被系统判 ANR 杀进程（见 refreshList 的注释），读 profile 是大 JSON 解析，
         * 不能上主线程。
         */
        val bundled: Boolean = false,
    )

    /** 兼容性判定表（dir → 判定），由 [refreshList] 在后台线程读一次后填入。 */
    private var compatStatus: Map<String, CompatInfo> = emptyMap()

    /** 只许在后台线程调用（目录内容指纹比对是重活，结果按 apkVer:源目录:dir 缓存）。 */
    private fun healthOf(e: PluginEntry): BundledHealth {
        val dir = File(pluginsDir(), e.dir)
        val key = AssetSync.apkVersion(this).toString() + ":" + e.sourceDir.name + ":" + e.dir
        val srcOk = srcAvailCache[key] ?: bundledSourceAvailable(e).also { srcAvailCache[key] = it }
        return BundledHealth(
            dir.isDirectory,
            bundleHealthy(dir),
            isWired(e),
            srcOk,
            staleVsSource = isStaleVsSource(e, dir),
            compat = compatStatus[e.dir],
            bundled = isBundled(e),
        )
    }

    /**
     * 装配副本是否**落后于**源（内置取 extra-plugins，可选取 optional-plugins）。
     *
     * 为什么要有这个判定：原 [bundleHealthy] 只校验 package.json 有 name，
     * 因此「旧版本但结构完好」的插件会被判成**健康**——真机事故正是如此：
     * 装了含修复的新 APK，`files/plugins/<dir>` 仍是旧代码，健康检查显示正常、
     * 用户毫无提示，只在启动时以「web 未就绪」炸出来。
     * 这里用与资产同步同一套内容指纹直接比对，暴露「源已更新、副本未刷新」。
     *
     * 源不存在（清单条目对应的源目录缺失）时返回 false，不做无根据的告警。
     */
    private fun isStaleVsSource(e: PluginEntry, dir: File): Boolean {
        if (!File(dir, "package.json").isFile) return false
        val src = File(e.sourceDir, e.dir)
        if (!File(src, "package.json").isFile) return false
        return runCatching { !AssetSync.dirContentEquals(src, dir) }.getOrDefault(false)
    }

    /** 目录健康：package.json 存在、可解析、name 非空（空壳损坏判定）。 */
    private fun bundleHealthy(dir: File): Boolean {
        val p = File(dir, "package.json")
        if (!p.isFile) return false
        val j = runCatching { JSONObject(p.readText()) }.getOrNull() ?: return false
        return j.optString("name").isNotBlank()
    }

    /**
     * APK 内是否带有该插件的可用源。
     *
     * 供给链只有一条：清单条目按归属取源目录 —— builtin → files/extra-plugins/<dir>，
     * optional → files/optional-plugins/<dir>（均由 AssetSync 从 APK assets 整目录拷出）。
     * 旧的压缩包 tar 探测分支已随资产删除一并下线。
     */
    private fun bundledSourceAvailable(e: PluginEntry): Boolean =
        File(File(e.sourceDir, e.dir), "package.json").isFile

    /** 从内置源恢复单个插件目录：按清单取源目录整目录直拷（旧 tgz 通道已下线）。 */
    private fun repairFromSource(e: PluginEntry): Boolean {
        val src = File(e.sourceDir, e.dir)
        if (!File(src, "package.json").isFile) return false
        val dst = File(pluginsDir(), e.dir)
        dst.deleteRecursively()
        return runCatching {
            src.copyRecursively(dst, overwrite = true)
            bundleHealthy(dst)
        }.getOrDefault(false)
    }

    // ── 插件清单（单一真源）────────────────────────────────

    /** 清单条目：dir=目录名，name=package.json 的 name，id=cordis.patch.yml 的 insert id。 */
    private data class PluginEntry(
        val dir: String,
        val name: String,
        val id: String,
        val title: String,
        val desc: String,
        /** 该条目对应的源目录：builtin → files/extra-plugins，optional → files/optional-plugins。 */
        val sourceDir: File,
    )

    /**
     * 清单解析结果。[error] 非空表示清单不可用（缺失/解析失败/builtin 为空）：
     * 此时列表必须**显式**显示告警卡并写日志，绝不静默显示空列表。
     */
    private data class PluginManifest(
        val builtin: List<PluginEntry> = emptyList(),
        val optional: List<PluginEntry> = emptyList(),
        val error: String? = null,
        /** 清单声明的目标 dsh 版本（$targetDsh）：插件副本就是针对它适配的。 */
        val targetDsh: String? = null,
    )

    /**
     * 读取装配清单 —— 单一真源 assets/plugin-manifest.json。
     *
     * 读取顺序：files/plugin-manifest.json（DshFlow 启动/安装时已从 APK 拷出）
     * → APK assets 直读（AssetSync.openAsset 带 zip 兜底，绕开 release 包 assets 索引异常）。
     * 解析失败不静默：返回 [PluginManifest.error] 并写日志，由 UI 渲染告警卡。
     */
    private fun loadManifest(): PluginManifest {
        val text = readManifestText()
        if (text == null) {
            val msg = "$MANIFEST_NAME 不可读（files/ 与 APK assets 均取不到）"
            appendLog("WARN 插件清单缺失：$msg")
            return PluginManifest(error = msg)
        }
        return try {
            val j = JSONObject(text)
            val builtin = parseManifestList(j.optJSONArray("builtin"), File(filesDir, "extra-plugins"))
            val optional = parseManifestList(j.optJSONArray("optional"), optionalPluginsDir())
            val target = j.optString("targetDsh").takeIf { it.isNotBlank() }
            if (builtin.isEmpty()) {
                val msg = "$MANIFEST_NAME 的 builtin 列表为空"
                appendLog("WARN 插件清单异常：$msg")
                PluginManifest(builtin, optional, msg, target)
            } else {
                PluginManifest(builtin, optional, null, target)
            }
        } catch (t: Throwable) {
            val msg = "$MANIFEST_NAME 解析失败：${t.message}"
            appendLog("WARN 插件清单解析失败：$msg")
            PluginManifest(error = msg)
        }
    }

    private fun readManifestText(): String? {
        val f = File(filesDir, MANIFEST_NAME)
        try {
            if (f.isFile && f.length() > 0L) return f.readText()
        } catch (t: Throwable) {
            appendLog("WARN 读取 ${f.absolutePath} 失败：${t.message}")
        }
        return try {
            AssetSync.openAsset(this, MANIFEST_NAME).use { String(it.readBytes(), Charsets.UTF_8) }
        } catch (t: Throwable) {
            appendLog("WARN 读取 assets/$MANIFEST_NAME 失败：${t.message}")
            null
        }
    }

    /** 解析清单数组；条目缺 dir 时跳过并记日志（不静默丢弃）。 */
    private fun parseManifestList(arr: JSONArray?, sourceDir: File): List<PluginEntry> {
        if (arr == null) return emptyList()
        val out = ArrayList<PluginEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val dir = o.optString("dir").trim()
            if (dir.isEmpty()) {
                appendLog("WARN 清单第 $i 项缺少 dir，已跳过")
                continue
            }
            out.add(
                PluginEntry(
                    dir = dir,
                    name = o.optString("name").trim().ifEmpty { dir },
                    id = o.optString("id").trim().ifEmpty { dir },
                    title = o.optString("title").trim().ifEmpty { dir },
                    desc = o.optString("desc").trim(),
                    sourceDir = sourceDir,
                )
            )
        }
        return out
    }

    /**
     * 兜底：确保 files/plugin-manifest.json 存在（install-dsh.mjs 也从这里读清单）。
     * 正常路径由 DshFlow 拷贝；此处仅防「清单没到位 → 静默装配 0 个插件」的故障。
     */
    private fun ensureManifestFile() {
        val dest = File(filesDir, MANIFEST_NAME)
        if (dest.isFile && dest.length() > 0L) return
        if (AssetSync.copyAsset(this, MANIFEST_NAME, dest)) {
            appendLog("   清单已从 APK assets 补齐：$MANIFEST_NAME")
        } else {
            appendLog("   WARN 无法获取 $MANIFEST_NAME，install-dsh.mjs 将装配 0 个插件")
        }
    }

    /** 清单不可用时的显式告警卡（绝不静默显示空列表）。 */
    private fun buildManifestWarnCard(reason: String): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER, stroke = Ui.WARNING, elevationDp = 0f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            text = "插件清单不可用"
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.WARNING)
        })
        col.addView(TextView(this).apply {
            text = "$MANIFEST_NAME 读取/解析失败：$reason\n请点「刷新」重试；若持续失败，用「自动安装并启动」重建 files/ 资产。"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(4), 0, 0)
        })
        card.addView(col)
        return card
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

    /**
     * 该插件是否**在 profile 的 bundles 里**（= dsh 启动时会加载它）。
     *
     * 与 [isWired] 的区别很重要：isWired 看「依赖 **或** bundles 命中」，而禁用只摘 bundles，
     * 依赖（link: 登记）仍在 —— 所以禁用后 isWired 依旧为真。要区分「已装配但被禁用」，
     * 必须单独看 bundles。
     */
    private fun isBundled(e: PluginEntry): Boolean = bundleNameOf(e) != null

    /** 该插件在 bundles 里登记的名字（找不到返回 null）。 */
    private fun bundleNameOf(e: PluginEntry): String? {
        val bundles = readBundles()
        val names = listOf(e.name, e.dir, "@dsh-external/${e.name}", "@dsh-external/${e.dir}").distinct()
        return names.firstOrNull { n -> bundles.any { it == n } }
    }

    /**
     * 启用 / 禁用插件 —— 只增删 profile 的 `dsh.profile.bundles` 条目。
     *
     * 为什么这个机制是对的：dsh 只装配列进 bundles 的包（读它的 cordis.patch.yml 往条目表插行）。
     * 把包名从 bundles 摘掉即可让该插件**不加载**，而 `dependencies` 里的 link: 登记保留 ——
     * node_modules 解析链不受影响、别的插件引用它也不会断，且**完全可逆**（加回去即恢复）。
     * 这比 `dsh plugin remove` 温和得多：后者删依赖，恢复要重走一遍 pnpm 解析。
     *
     * 生效需重启 dsh web（bundles 是启动期读取的），故完成后提示用户。
     */
    private fun setBundled(e: PluginEntry, enabled: Boolean, label: String) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                val file = profilePkg()
                val pkg = JSONObject(file.readText())
                val profile = pkg.optJSONObject("dsh")?.optJSONObject("profile")
                if (profile == null) {
                    appendLog("   ✗ $label 失败：profile 里没有 dsh.profile")
                    return@Thread
                }
                val current = readBundles()
                val hit = bundleNameOf(e)
                if (enabled && hit == null) {
                    // 用清单里的规范包名（dsh 按 package.json 的 name 匹配，不是目录名）
                    val add = e.name.ifBlank { e.dir }
                    profile.put("bundles", JSONArray(current + add))
                    appendLog("   ${label}：已启用（bundles += $add）")
                } else if (!enabled && hit != null) {
                    profile.put("bundles", JSONArray(current.filter { it != hit }))
                    appendLog("   ${label}：已禁用（bundles -= $hit）")
                } else {
                    appendLog("   $label：无需变更（当前${if (hit != null) "已启用" else "未启用"}）")
                    return@Thread
                }
                // 关键：把「用户意图」写进 files/.extra-plugins-disabled.json。
                // 只改 bundles 是**不够**的 —— 装配链（install/plugins.mjs 的 addLocalPlugin）
                // 看到「有 link: 依赖但不在 bundles」会当作换名/换目录留下的半吊子登记，
                // 摘掉登记再重新 add，把这次禁用直接撤销。两份数据的分工：
                //   · profile 的 bundles = 结果（dsh 实际加载什么）
                //   · 本文件 = 意图（用户想让它启用还是禁用），装配时以意图为准
                // 格式必须与 plugins.mjs 的 readDisabled() 一致：{"disabled":[...]}，
                // 元素是**清单里的目录名**（e.dir，与 BUILTIN_PLUGINS 同口径）。
                writeDisabledIntent(e.dir, enabled)
                // 原子写：先写临时文件再替换，避免中途失败留下半个 JSON
                val tmp = File(file.parentFile, file.name + ".tmp")
                tmp.writeText(pkg.toString(2) + "\n")
                if (!tmp.renameTo(file)) {
                    tmp.copyTo(file, overwrite = true)
                    tmp.delete()
                }
                appendLog("   ✓ $label 完成")
                // bundles 是 dsh **启动期**读取的 —— 不重启则界面上的状态已变、
                // 运行时却还是旧的。所以这里主动引导重启（而不是只写一句日志了事），
                // 否则用户会以为「点了没用」。
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle(if (enabled) "已启用" else "已禁用")
                        .setMessage("需要重启 dsh 服务才会生效。现在重启？（进行中的会话会中断）")
                        .setPositiveButton("立即重启") { _, _ -> restartFlow() }
                        .setNegativeButton("稍后", null)
                        .show()
                }
            } catch (t: Throwable) {
                appendLog("   ✗ $label 异常：${t.message}")
            } finally {
                runOnUiThread { setBusy(false); refreshListSafe() }
            }
        }.start()
    }

    /** 与 install/plugins.mjs 的 DISABLED_MARKER 同名同级（files/ 下）。 */
    private fun disabledMarkerFile() = File(filesDir, ".extra-plugins-disabled.json")

    /**
     * 记录/撤销「用户禁用」的意图 —— 格式必须与 install/plugins.mjs 的 readDisabled() 一致。
     *
     * 为什么必须有这份文件：装配链把「有 link: 依赖但不在 bundles」一律当作换名/换目录
     * 留下的半吊子登记，会摘掉登记重新 add —— 那会把用户刚做的禁用撤销。两份数据分工：
     *   · profile 的 bundles = **结果**（dsh 实际加载什么）
     *   · 本文件 = **意图**（用户想让它启用还是禁用），装配时以意图为准
     * 元素是**清单里的目录名**（e.dir），与 BUILTIN_PLUGINS 同口径。
     */
    private fun writeDisabledIntent(dir: String, enabled: Boolean) {
        try {
            val f = disabledMarkerFile()
            val set = runCatching {
                val arr = JSONObject(f.readText()).optJSONArray("disabled")
                (0 until (arr?.length() ?: 0)).mapNotNull { arr?.optString(it)?.takeIf(String::isNotBlank) }
                    .toMutableSet()
            }.getOrElse { mutableSetOf() }
            if (enabled) set.remove(dir) else set.add(dir)
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(JSONObject().put("disabled", JSONArray(set.toList().sorted())).toString(2) + "\n")
            if (!tmp.renameTo(f)) { tmp.copyTo(f, overwrite = true); tmp.delete() }
            appendLog("   · 禁用意图已记录：${if (enabled) "移除" else "加入"} $dir（共 ${set.size} 个被禁用）")
        } catch (t: Throwable) {
            appendLog("   WARN 禁用意图记录失败：${t.message}")
        }
    }

    /** 装配判定：官方 dsh plugin add 后会在 profile node_modules / bundles 里出现对应包。 */
    private fun isWired(e: PluginEntry): Boolean {
        val nm = profileNm()
        val names = listOf(e.name, e.dir, "@dsh-external/${e.name}", "@dsh-external/${e.dir}").distinct()
        if (names.any { File(nm, it).exists() }) return true
        val bundles = readBundles()
        return names.any { n -> bundles.any { it == n } }
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

    /** 单个内置插件对钉死版 dsh 的兼容性判定。[peers] 为不满足的 peer 明细（可空）。 */
    private data class CompatInfo(val compatible: Boolean, val peers: String?)

    /**
     * 读取每个内置插件对**钉死版 dsh** 的兼容性判定，来自安装脚本写的 files/plugin-status.json。
     *
     * 为什么要有这一层：dsh 0.2.0 起 app-boot 新增兼容性前置校验（compatibility-preflight），
     * 插件任一 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 范围不覆盖运行时版本时，
     * 该插件行会被**静默禁用**——`dsh plugin add` 照旧成功、目录健康检查也全绿，
     * 用户在插件页看不到任何异常，只在真正需要该插件时才发现它没生效。
     * install/plugins.mjs 在装配后调用 **dsh 自带的同一判定函数**核对并落盘，
     * 这里读回来展示，把静默失败变成可见状态。
     *
     * 文件不存在（旧 APK / 尚未跑过安装）时返回空表，UI 因此不渲染兼容性行——
     * 不把「没有数据」渲染成「不兼容」。
     */
    private fun readCompatStatus(): Map<String, CompatInfo> {
        val f = File(filesDir, "plugin-status.json")
        if (!f.isFile) return emptyMap()
        return try {
            val arr = JSONObject(f.readText()).optJSONArray("plugins") ?: return emptyMap()
            val out = mutableMapOf<String, CompatInfo>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val dir = o.optString("dir").takeIf { it.isNotBlank() } ?: continue
                out[dir] = CompatInfo(o.optBoolean("compatible", true), o.optJSONObject("peers")?.toString())
            }
            out
        } catch (t: Throwable) {
            appendLog("WARN plugin-status.json 解析失败：${t.message}")
            emptyMap()
        }
    }

    /** 设备上实际安装的 dsh 版本（对比清单声明的 targetDsh，不一致即提示升级未落实）。 */
    private fun readInstalledDshVersion(): String? {
        val p = File(dshPrefix(), "node_modules/@deepseek-ai/dsh/package.json")
        if (!p.isFile) return null
        return runCatching {
            JSONObject(p.readText()).optString("version").takeIf { it.isNotBlank() }
        }.getOrNull()
    }

    /** 状态 pill 颜色显式映射（「已损坏」不得命中 contains(已) 变绿）。 */
    private fun statusColor(status: String): Int = when {
        status.contains("损坏") || status.contains("缺失") -> Ui.DANGER
        // ⚠ 以下两条必须排在「已装配」之前：它们的文案都以「已装配 ·」开头，
        // 落到「已装配」那条会被染成绿色的"一切正常"——正是要避免的误导。
        status.contains("不兼容") -> Ui.DANGER
        // 用户主动禁用是**正常状态**（不是错误），用中性灰而非红色。
        status.contains("已禁用") -> Ui.TEXT_MUTED
        status.contains("落后") -> Ui.WARNING
        status.contains("已装配") || status.contains("已安装") || status.contains("已连接") -> Ui.SUCCESS
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
        // profile 变了 → 兼容性判定可能随之变化，刷新一次（见 refreshCompatStatus 注释）。
        if (code == 0) refreshCompatStatus()
        return code
    }

    /**
     * 重跑兼容性审计，刷新 files/plugin-status.json（dsh 0.2.0 起的装配契约）。
     *
     * 为什么需要：本页的单插件操作（装配/修复/卸载/在线安装）走 [dshPluginSync] 直连
     * `dsh plugin add`，**不经过** install-dsh.mjs 的完整流程，因此那份状态文件不会自己更新——
     * 不补这一步，界面就会拿**过期判定**继续显示，正是要消除的那类静默不一致。
     * 「重新装配」「一键重置」走的是 rewireCore（--plugins-only），那条路径已含审计。
     *
     * 审计本身只读清单 + 调用 dsh 自带的兼容性判定，开销很小；失败不影响主操作结果。
     */
    private fun refreshCompatStatus() {
        val script = File(filesDir, "install-dsh.mjs")
        val node = File(File(nodeDir, "bin"), "node")
        if (!script.exists() || !node.exists()) return
        val env = baseEnv().apply {
            put("DSH_PREFIX", dshPrefix().absolutePath)
            put("DSH_PROFILE", "web")
            put("DSH_PLUGINS_DIR", pluginsDir().absolutePath)
            put("DSH_APK_VER", AssetSync.apkVersion(this@PluginManagerActivity).toString())
        }
        runProcess("${node.absolutePath} ${script.absolutePath} --audit-only", env, "兼容性审计")
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

    /** 单个插件「装配」：files/plugins/<dir> 副本健康但未注册进 profile。 */
    private fun wireBundled(e: PluginEntry) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                val path = File(pluginsDir(), e.dir).absolutePath
                dshPluginSync(listOf("add", path), "装配 ${e.dir}")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("装配 ${e.dir} 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /**
     * 可选插件「装配」：先把 optional-plugins 源整目录补到 files/plugins/<dir>，
     * 再走与内置插件完全相同的 `dsh plugin add <path>` 注册路径。
     * optional 默认不装配，只有用户显式点「装配」才会进入 profile。
     */
    private fun wireOptional(e: PluginEntry) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                ensureHarnessTools()
                appendLog(">> 装配可选插件 ${e.dir} …")
                if (!File(File(pluginsDir(), e.dir), "package.json").isFile) {
                    if (!repairFromSource(e)) {
                        appendLog("   ✗ ${e.dir} 无可选源或复制失败，装配中止")
                        return@Thread
                    }
                    appendLog("   ✓ ${e.dir} 已从 optional-plugins 源复制到 plugins/")
                }
                val path = File(pluginsDir(), e.dir).absolutePath
                dshPluginSync(listOf("add", path), "装配 ${e.dir}")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("装配可选插件 ${e.dir} 异常: ${t.message}")
            } finally {
                setBusy(false)
            }
        }.start()
    }

    /** 单个插件「修复/恢复」：清异常副本 → 按清单从源目录恢复 → 注册进 profile。 */
    private fun repairSingle(e: PluginEntry) {
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                ensureHarnessTools()
                syncExtraPluginsSource()
                appendLog(">> 修复 ${e.dir} …")
                if (!repairFromSource(e)) {
                    appendLog("   ✗ ${e.dir} 恢复失败（源目录缺失或复制失败）")
                    return@Thread
                }
                val path = File(pluginsDir(), e.dir).absolutePath
                dshPluginSync(listOf("add", path), "装配 ${e.dir}")
                refreshListSafe()
            } catch (t: Throwable) {
                appendLog("修复 ${e.dir} 异常: ${t.message}")
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
            .setMessage("跳过 npm 更新，仅重新装配全部内置插件（清单 builtin，--plugins-only）。继续？")
            .setPositiveButton("执行") { _, _ ->
                setBusy(true)
                Thread {
                    try {
                        ensureHarnessTools()
                        // 必须先同步 extra-plugins 源再装配：否则「重新装配」只是把
                        // 设备上**旧**的源再装一遍，APK 里的插件修复到不了位。
                        // （此前只有「修复单个」与「一键重置」同步，本入口漏了。）
                        syncExtraPluginsSource()
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
                        val manifest = loadManifest()
                        // builtin 缺失/损坏都修；optional 只修「已有副本但损坏」的，
                        // 绝不因为一次重置就把默认不装配的可选插件塞进 profile
                        val targets = manifest.builtin.map { it to true } + manifest.optional.map { it to false }
                        for ((e, isBuiltin) in targets) {
                            val h = healthOf(e)
                            val repairable = h.srcOk && (isBuiltin || h.dirExists)
                            if ((!h.dirExists || !h.healthy) && repairable) {
                                appendLog(">> 恢复 ${e.dir} …")
                                appendLog(if (repairFromSource(e)) "   ✓ ${e.dir} 已从源目录恢复" else "   ✗ ${e.dir} 恢复失败")
                            } else if (h.dirExists && !h.healthy) {
                                appendLog("   ⚠ ${e.dir} 损坏且无源可恢复，跳过")
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
        val stamp = AssetSync.apkInstallStamp(this)
        val dest = File(filesDir, "extra-plugins")
        if (AssetSync.isSynced(this, "extra-plugins", dest, stamp)) return
        try {
            if (AssetSync.copyAssetDir(this, "extra-plugins", dest, clearFirst = true)) {
                AssetSync.markSyncedWithFingerprint(this, "extra-plugins", dest, stamp)
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
        // 内置插件源只有一条供给链：assets/extra-plugins → files/extra-plugins →
        // install-dsh.mjs 的 syncExtraPlugin() 整目录替换到 files/plugins。
        // 旧的压缩包 tgz 通道已随资产删除一并下线，这里不再复制任何 tgz。
        ensureManifestFile()
        val node = File(File(nodeDir, "bin"), "node")
        val cmd = "${node.absolutePath} ${installScript.absolutePath} --plugins-only"
        val env = baseEnv().apply {
            put("DSH_PREFIX", dshPrefix().absolutePath)
            put("DSH_PROFILE", "web")
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
        val tools = File(filesDir, ".tools")
        val termux = File(filesDir, "termux/usr")
        // 基底环境统一来自 TermuxEnv（架构方案 P0-1）：HOME 用 filesDir（gitconfig 所在）、
        // TMPDIR 用 files/tmp、PATH 在 node/bin 后插入 pnpm 工具目录
        val env = TermuxEnv.childShellEnv(
            this,
            home = filesDir,
            tmpDir = File(filesDir, "tmp"),
            extraPath = listOf(
                File(tools, "bin").absolutePath,
                File(tools, "lib/node_modules/.bin").absolutePath,
            ),
        ).toMutableMap()
        val gitConfig = File(filesDir, ".gitconfig")
        if (!gitConfig.exists()) gitConfig.writeText("")
        env["GIT_EXEC_PATH"] = File(termux, "libexec/git-core").absolutePath
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = gitConfig.absolutePath
        env["TMP"] = env.getValue("TMPDIR")
        env["TEMP"] = env.getValue("TMPDIR")
        return env
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
