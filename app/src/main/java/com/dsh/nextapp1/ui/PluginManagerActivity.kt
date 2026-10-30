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
            // 在线升级状态（files/plugin-upgrade.json）与各插件的备份清单同样是文件 IO，
            // 一并放后台读；主线程只做视图构建（本页此前就是被主线程 IO 拖到 ANR 的）。
            val upgrade = PluginUpgrade.readState(this)
            val npmDirs = (manifest.builtin + manifest.optional)
                .filter { it.npm.isNotBlank() }
                .map { it.dir }
            val backups = npmDirs
                .associateWith { dir -> PluginUpgrade.listBackups(this, dir) }
                .filterValues { it.isNotEmpty() }
            runOnUiThread {
                if (isFinishing || isDestroyed || gen != listGeneration) return@runOnUiThread
                renderList(manifest, bundled, optionals, extras, issues, installedDsh, upgrade, backups)
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
        installedDsh: String?,
        upgrade: PluginUpgrade.State,
        backups: Map<String, List<PluginUpgrade.Backup>>,
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
                // ★ 副本**比源新**：几乎总是用户自己在这个插件上做过「在线升级」。
                //   不是故障，绝不给「修复」（那等于点一下就把升级打回出厂版）；
                //   只在有备份时给「回滚」，让退出升级的路径留在明面上。
                h.aheadOfSource -> {
                    status = "已在线升级 · 高于内置源"
                    val bk = backups[e.dir].orEmpty()
                    if (bk.isNotEmpty()) actions.add("回滚" to { showRollbackDialog(e, bk) })
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
                    h.aheadOfSource -> {
                        status = "已在线升级 · 高于源"
                        val bk = backups[e.dir].orEmpty()
                        if (bk.isNotEmpty()) actions.add("回滚" to { showRollbackDialog(e, bk) })
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

        // ── 插件在线升级（npm 渠道）：只列清单里声明了 npm 的条目 ──
        // 与下方「在线扩展」是两条独立通道：在线扩展指 profile 里登记但不在清单里的
        // 第三方 bundle（走 git 源更新），这里指随 APK 内置、但同时发在 npm registry
        // 上的插件（走 tarball 在线升级）。混在一起会让「从哪升级」变得不可解释。
        buildUpgradeSection(manifest, upgrade, backups)?.let { listBox.addView(it) }

        listBox.addView(sectionHeader("在线扩展", "${extras.size} 个"))
        for (info in extras) {
            // 在线扩展只挂「卸载」时，用户无法让它跟上上游（见 checkPluginUpdate 注释）。
            // 有来源记录（本页装过）才给更新入口：无记录时无从比对上游。
            val acts = mutableListOf<Pair<String, () -> Unit>>()
            if (sourceOf(info.name) != null) {
                acts.add("检查更新" to { checkPluginUpdate(info.name, apply = false) })
                acts.add("更新" to { checkPluginUpdate(info.name, apply = true) })
            }
            acts.add("卸载" to { uninstall(info.name) })
            listBox.addView(makeCard(info.name, info.desc, info.version, "已装配", acts))
        }
        listBox.addView(buildInstallCard())
    }

    /**
     * 插件在线升级分区（npm 渠道）。
     *
     * 设计要点：
     *   · 清单里没有一条声明 npm → 整个分区不出现（不摆一个永远空着的入口）；
     *   · 状态只来自 files/plugin-upgrade.json，**没查过就显示「未检查」**，
     *     绝不把「没有记录」渲染成「已是最新」（这正是同类功能最常见的骗人处）；
     *   · 升级/回滚全部交给 install/plugin-upgrade.mjs，Kotlin 侧不碰网络与 tar。
     *
     * @return 分区视图；无可升级渠道时返回 null。
     */
    private fun buildUpgradeSection(
        manifest: PluginManifest,
        upgrade: PluginUpgrade.State,
        backups: Map<String, List<PluginUpgrade.Backup>>,
    ): View? {
        val entries = (manifest.builtin + manifest.optional).filter { it.npm.isNotBlank() }
        if (entries.isEmpty()) return null

        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val outdated = entries.count { upgrade.itemOf(it.dir)?.hasUpdate == true }
        val trimmedCount = entries.count { it.npmTrimmed }
        box.addView(sectionHeader("插件在线升级", "${entries.size} 个 npm 渠道"))
        box.addView(buildUpgradeSummaryCard(entries.size, outdated, trimmedCount, upgrade))

        for (e in entries) {
            val item = upgrade.itemOf(e.dir)
            val localVer = readVersion(e.dir)
            val up = upgrade.upgradedTo(e.dir, localVer)
            // checked 只保留「真的查过上游」的条目：没查过绝不能渲染成「已是最新」
            val checked = item?.takeIf { it.checked }
            val status: String
            val verText: String
            if (up != null) {
                // 刚升级完但还没重新装配/重启：dsh 正在跑的仍是旧代码，必须显式提示
                status = "已升级 · 待重启"
                verText = "${up.from} → ${up.to}"
            } else if (checked == null) {
                status = "未检查"
                verText = localVer
            } else if (checked.hasUpdate) {
                status = "可升级"
                verText = "${checked.local.ifBlank { localVer }} → ${checked.latest}"
            } else if (checked.status == PluginUpgrade.STATUS_ERROR) {
                status = "查版失败"
                verText = localVer
            } else if (checked.status == PluginUpgrade.STATUS_AHEAD) {
                status = "领先上游"
                verText = "${checked.local} > ${checked.latest}"
            } else {
                status = "已是最新"
                verText = checked.local.ifBlank { localVer }
            }
            val err = item?.error
            val desc = buildString {
                append(e.desc)
                // 裁剪版必须逐条标注：用户看到「升级会把 8 个文件变成 209 个文件」时
                // 需要知道这是设计如此，而不是升级把插件搞坏了。
                if (e.npmTrimmed) {
                    append("\n裁剪版：本仓副本只保留运行时必需文件，升级会用上游完整包覆盖")
                    append("（功能不变，体积会变大）")
                }
                if (err != null) append("\n查询失败：$err")
            }
            val acts = mutableListOf<Pair<String, () -> Unit>>()
            if (checked != null && checked.hasUpdate) {
                acts.add("升级到 ${checked.latest}" to { confirmUpgrade(e) })
            } else {
                acts.add("在线升级" to { confirmUpgrade(e) })
            }
            val bk = backups[e.dir].orEmpty()
            if (bk.isNotEmpty()) {
                acts.add("回滚" to { showRollbackDialog(e, bk) })
            }
            box.addView(makeCard(e.title.ifBlank { e.dir }, desc, verText, status, acts))
        }
        return box
    }

    /**
     * 在线升级分区的头部小结：可升级数量 + 上次检查时间 + 「检查更新」入口。
     *
     * [trimmedCount] 是清单里标了 npmTrimmed 的条目数。这些插件的本仓副本是上游包的
     * 裁剪版（只删了 sourcemap / .d.ts / 文档 / 非本宿主适配层），升级会用上游完整包
     * 覆盖 —— 功能不变，但体积会明显变大。必须在点升级之前就把这件事说清楚。
     */
    private fun buildUpgradeSummaryCard(total: Int, outdated: Int, trimmedCount: Int, upgrade: PluginUpgrade.State): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val head = TextView(this).apply {
            text = when {
                !upgrade.exists -> "尚未检查上游版本（共 $total 个 npm 渠道）"
                outdated > 0 -> "↑ $outdated 个插件有新版本"
                upgrade.summary.error > 0 -> "检查完成，但 ${upgrade.summary.error} 个查询失败"
                else -> "✓ 全部已是最新（$total 个 npm 渠道）"
            }
            setTextColor(if (outdated > 0) Ui.WARNING else Ui.TEXT_SECONDARY)
            textSize = 13f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        col.addView(head)
        val sub = TextView(this).apply {
            text = buildString {
                if (upgrade.checkedAt.isNotBlank()) append("上次检查：${formatCheckedAt(upgrade.checkedAt)}")
                else append("上次检查：从未")
                if (PluginUpgrade.isStale(upgrade)) append("（已过期）")
                if (trimmedCount > 0) {
                    append("\n其中 $trimmedCount 个是裁剪版（本仓只保留了运行时必需文件）：升级会用上游完整包覆盖，")
                    append("功能不变但体积会变大（补回 sourcemap / .d.ts / 文档等），属预期。")
                }
                append("\n在线升级只替换 files/plugins 里的插件副本，完成后需重新装配或重启 dsh 才生效。")
            }
            setTextColor(Ui.TEXT_MUTED)
            textSize = 11f
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(6), 0, dp(8))
        }
        col.addView(sub)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Ui.button(this, "检查更新", { runUpgradeCheck(force = false) }, filled = true, compact = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(40), 1f).apply { rightMargin = dp(6) }
        })
        row.addView(Ui.button(this, "强制重查", { runUpgradeCheck(force = true) }, filled = false, compact = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(40), 1f).apply { rightMargin = dp(6) }
        })
        col.addView(row)
        card.addView(col)
        return card
    }

    /** ISO 时间串 → "MM-dd HH:mm"；解析失败原样返回（宁可难看也不吞掉信息）。 */
    private fun formatCheckedAt(iso: String): String = try {
        val t = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        val d = t.parse(iso.take(19))
        if (d == null) iso else java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US).format(d)
    } catch (t: Throwable) {
        iso
    }

    /**
     * 升级确认：明确告知「会替换副本 + 会先备份 + 需重新装配才能生效」。
     *
     * 裁剪版（清单 npmTrimmed）额外说明「升级只做加法、体积会变大」——否则用户看到
     * 插件目录从几个文件涨到上百个文件，会以为升级把插件搞坏了。
     */
    private fun confirmUpgrade(e: PluginEntry) {
        if (!guardBusy()) return
        val trimmedNote = if (e.npmTrimmed) {
            "\n· 本仓副本是上游包的裁剪版（只保留运行时必需文件）：升级会用上游完整包覆盖，" +
                "只会补回 sourcemap / .d.ts / 文档等被裁掉的文件，功能不变但体积会变大"
        } else {
            ""
        }
        AlertDialog.Builder(this)
            .setTitle("在线升级 ${e.title.ifBlank { e.dir }}")
            .setMessage(
                "将从 npm registry 下载 ${e.npm} 的最新版本，替换 files/plugins/${e.dir} 下的插件副本。\n\n" +
                    "· 替换前会自动备份到 files/.plugin-backup/${e.dir}/（可回滚）\n" +
                    "· 若上游不是更新版本则原样保留（不降级）" +
                    trimmedNote + "\n" +
                    "· 完成后需「重新装配」或重启 dsh 才会生效\n\n继续？"
            )
            .setPositiveButton("升级") { _, _ -> runUpgrade(e) }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 回滚确认：列出备份版本，默认选最新的那个（脚本侧也是这个顺序）。 */
    private fun showRollbackDialog(e: PluginEntry, backups: List<PluginUpgrade.Backup>) {
        if (!guardBusy()) return
        val labels = backups.map { b ->
            "${b.version}（${java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US).format(java.util.Date(b.mtime))}）"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("回滚 ${e.title.ifBlank { e.dir }}")
            .setItems(labels) { _, which ->
                val b = backups.getOrNull(which) ?: return@setItems
                runRollback(e, b.version)
            }
            .setNegativeButton("取消", null)
            .show()
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
        /**
         * 装配副本**比源新**（通常来自「在线升级」）。
         *
         * 与 [staleVsSource] 互斥：两者都由内容指纹/版本比较得出，但语义相反 ——
         * 一个该修（源更新），一个**不该修**（按源覆盖等于把在线升级静默回滚）。
         * 旧逻辑把后者也判成 staleVsSource，于是界面上明晃晃一个「修复」按钮，
         * 点下去就把用户刚升级的版本打回出厂版。
         */
        val aheadOfSource: Boolean = false,
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
            aheadOfSource = isAheadOfSource(e, dir),
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
     *
     * ⚠️ 本地版本**高于**源时不算「落后」（那是「在线升级」的结果，见 [isAheadOfSource]）：
     * 内容指纹必然不同，但该修的是源、不是副本 —— 判成落后会把在线升级成果说成故障。
     */
    private fun isStaleVsSource(e: PluginEntry, dir: File): Boolean {
        if (!File(dir, "package.json").isFile) return false
        val src = File(e.sourceDir, e.dir)
        if (!File(src, "package.json").isFile) return false
        if (AssetSync.isNewerThanSource(dir, src)) return false
        return runCatching { !AssetSync.dirContentEquals(src, dir) }.getOrDefault(false)
    }

    /**
     * 装配副本是否**比源新** —— 通常意味着用户在这个插件上做过「在线升级」。
     *
     * 为什么要单列：在线升级只替换 `files/plugins/<dir>`，不动 `files/extra-plugins/<dir>`，
     * 因此内容指纹与源必然不同。旧逻辑把这判成「副本落后于内置源」并给出「修复」按钮，
     * 而修复=按出厂源整目录覆盖 ⇒ 用户点一下就把刚升级的版本静默回滚了。
     * 这里必须把方向说对：文案改成「已在线升级 · 高于内置源」，且**不给修复按钮**。
     *
     * 只在两侧版本都可解析时才有结论（否则返回 false，交给内容指纹判「落后」）。
     */
    private fun isAheadOfSource(e: PluginEntry, dir: File): Boolean =
        AssetSync.isNewerThanSource(dir, File(e.sourceDir, e.dir))

    /**
     * 目录健康：package.json 存在、可解析、name 非空，**且入口文件真实存在**。
     *
     * ⚠️ 只校验 name 是不够的（真机事故）：`billion-context@0.1.198` 的副本只剩 7 个文件，
     * `package.json` 完好、`name` 非空 ⇒ 旧判据判「健康」，但它的 `exports["./client"]`
     * 指向的 `dist/agent/dsh-native-client.js` 并不存在。结果启动时 dsh-client-modules
     * 抛 `client bundles not found`，整个 client 组装失败、WebUI 起不来 ——
     * 而插件管理器里该插件显示为正常，用户毫无线索。
     *
     * 这里补一层「入口可达性」校验：把 `main` 与 `exports` 里所有字符串值（含嵌套）
     * 解析出来，逐个检查对应文件是否存在。缺任一入口即判损坏，让健康检查能报出来、
     * 并走「从内置源恢复」的修复路径。
     *
     * 只查**文件是否存在**，不解析模块内容：目的是拦住「残缺副本」，不是校验代码正确性。
     */
    private fun bundleHealthy(dir: File): Boolean {
        val p = File(dir, "package.json")
        if (!p.isFile) return false
        val j = runCatching { JSONObject(p.readText()) }.getOrNull() ?: return false
        if (j.optString("name").isBlank()) return false
        // 收集入口路径：main + exports 的全部字符串叶子
        val entries = mutableListOf<String>()
        j.optString("main").takeIf { it.isNotBlank() }?.let { entries.add(it) }
        j.opt("exports")?.let { collectExportPaths(it, entries) }
        // 相对路径才可解析；带 scheme 的（如 "node:fs"）跳过
        for (raw in entries) {
            if (raw.isBlank() || raw.contains(":")) continue
            // ⚠️ 跳过**纯类型声明**：.d.ts 只在 TypeScript 开发期需要，运行时从不加载。
            //    内置插件副本按 files 字段裁剪，通常不带 types/ 目录 —— 若把它们也算作
            //    「必须存在」，dsh-web-mobile / dsh-codearts-auth 这类正常插件会被误判损坏。
            if (raw.endsWith(".d.ts") || raw.endsWith(".d.mts") || raw.endsWith(".d.cts")) continue
            // 通配出口（如 "./locale/*.json"）无法逐个校验，跳过
            if (raw.contains("*")) continue
            val rel = raw.removePrefix("./")
            if (!File(dir, rel).isFile) return false
        }
        return true
    }

    /** 递归收集 `exports` 字段里的全部字符串叶子（exports 可嵌套多层对象/数组）。 */
    private fun collectExportPaths(node: Any?, out: MutableList<String>) {
        when (node) {
            is String -> out.add(node)
            is JSONObject -> node.keys().forEach { collectExportPaths(node.opt(it), out) }
            is JSONArray -> for (i in 0 until node.length()) collectExportPaths(node.opt(i), out)
        }
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

    /**
     * 从源目录恢复单个插件目录：按清单取源目录整目录直拷（旧 tgz 通道已下线）。
     *
     * **不降级守卫**：`files/plugins/<dir>` 可能已被「在线升级」换成比内置源更新的版本，
     * 此时按源覆盖等于把用户的在线升级**静默回滚**（备份还在，但界面上的按钮写着「修复」，
     * 行为无法解释）。判据与 [AssetSync.refreshBundledPluginCopies] 的守卫、
     * `install/plugins.mjs` 的 syncExtraPlugin 完全同源：版本不可解析 → fail-open 照常恢复；
     * 只有「本地明确更新」才拒绝。
     *
     * @param allowDowngrade 为 true 时跳过守卫强制回到出厂源。「一键重置」用它 ——
     *   重置的语义本来就是回到出厂版；升级前的副本仍留在 `files/.plugin-backup/<dir>`，
     *   需要时可在「插件在线升级」分区用「回滚」取回。
     * @return 恢复后副本健康则 true；源缺失 / 被守卫拒绝 / 复制失败则 false。
     */
    private fun repairFromSource(e: PluginEntry, allowDowngrade: Boolean = false): Boolean {
        val src = File(e.sourceDir, e.dir)
        if (!File(src, "package.json").isFile) return false
        val dst = File(pluginsDir(), e.dir)
        if (!allowDowngrade && AssetSync.isNewerThanSource(dst, src)) {
            val dstVer = AssetSync.pkgVersionOf(dst)
            appendLog("   ⚠ ${e.dir} 本地 $dstVer 高于内置源版本（已在线升级），拒绝按源覆盖")
            appendLog("     如需退回出厂版：用「插件在线升级」分区的「回滚」，或「一键重置」")
            return false
        }
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
        /**
         * 清单声明的 npm 包名（在线升级渠道）。空 = 无 online 升级来源。
         *
         * 与 [name] 可以不同：历史上改过包名（如 modsearch 的内部 name 是
         * @liustack/modsearch），registry 上真实存在的那个才是升级来源。
         * 空字符串必须保留「没有渠道」这个语义，不能回退成 [name] ——
         * `@dsh-external/<pkg>` 与只发 GitHub Release 的插件填了也查不到，只会变噪音。
         */
        val npm: String = "",
        /**
         * 清单标了 npmTrimmed：本仓副本是上游包的裁剪版（只删了 sourcemap / .d.ts /
         * 文档 / 非本宿主适配层），升级会用上游完整包覆盖 —— 只做加法，功能不变但
         * 体积会变大。UI 必须在点「升级」之前把这件事讲清，否则用户会以为出了 bug。
         */
        val npmTrimmed: Boolean = false,
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
                    npm = o.optString("npm").trim(),
                    npmTrimmed = o.optBoolean("npmTrimmed", false),
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
        // 在线升级的三态：有新版本必须醒目（WARNING），「已升级 · 待重启」也不能绿
        // （绿色等于告诉用户"这就生效了"，而实际上 dsh 跑的还是旧代码）。
        status.contains("可升级") -> Ui.WARNING
        status.contains("待重启") -> Ui.WARNING
        status.contains("查版失败") -> Ui.DANGER
        status.contains("已是最新") || status.contains("领先上游") -> Ui.TEXT_MUTED
        status.contains("已装配") || status.contains("已安装") || status.contains("已连接") -> Ui.SUCCESS
        status.contains("待") || status.contains("需") -> Ui.WARNING
        else -> Ui.TEXT_MUTED
    }

    // ── 操作：在线安装 ────────────────────────────────────

    private fun installFromRepo() {
        if (!guardBusy()) return
        val raw = input.text.toString().trim()
        val parsed = parseRepo(raw)
        if (parsed == null) {
            appendLog("仓库格式无效：$raw（应形如 owner/repo、https://github.com/owner/repo 或 https://gitee.com/owner/repo）")
            return
        }
        val (domain, repo) = parsed
        if (repo == ROUTING_REPO) {
            appendLog(">> 特殊适配安装 $repo …")
            runRoutingSuite()
            return
        }
        // spec 形态按来源域选择（见 parseRepo 注释）：GitHub 用简写，Gitee 用完整 git URL
        val spec = when (domain) {
            "gitee" -> "git+https://gitee.com/$repo.git"
            else -> "github:$repo"
        }
        pendingSource = repo to domain
        if (!guardBusy()) return
        setBusy(true)
        Thread {
            try {
                // ① 预置 allowBuilds（git 源插件的 prepare 构建需放行，见 allowGitBuild 注释）
                allowGitBuild(domain, repo)
                var code = dshPluginSync(listOf("add", spec), "安装 $repo")
                if (code != 0) {
                    // ② pnpm 会把真实包名写成占位行（仓库名 ≠ 包名）——批准它再试一次
                    if (approvePendingBuilds()) {
                        appendLog(">> 构建许可已批准，重试安装…")
                        code = dshPluginSync(listOf("add", spec), "重试安装 $repo")
                    }
                }
                if (code == 0) rememberPendingSource()
            } catch (t: Throwable) {
                appendLog("安装异常: " + t.message)
            } finally {
                runOnUiThread { setBusy(false); refreshListSafe() }
            }
        }.start()
    }

    /**
     * 解析仓库输入 → (来源域, "owner/repo")，无法识别时返回 null。
     *
     * 为什么要带上**来源域**：装配 spec 的形态随域不同 —— GitHub 支持 github:owner/repo
     * 简写，而 Gitee 不在 dsh/pnpm 的 GIT_SHORTHAND 白名单里（dsh 的 install-spec.js 里是
     * /^(?:github|gitlab|bitbucket|gist):/i），必须用完整 git URL。
     * 真机实测：gitee 裸 URL 交给 pnpm 会被当成 tarball（ERR_PNPM_TARBALL_EXTRACT: Invalid
     * checksum for TAR header），而 git+https://gitee.com/<owner>/<repo>.git 能正常装成。
     *
     * 旧实现只剥 github 前缀、装配处硬编码 github: 前缀 —— 输入 gitee 地址要么被判「格式无效」，
     * 要么被拼成 github:gitee.com/... 去装错仓库。
     */
    private fun parseRepo(raw: String): Pair<String, String>? {
        val r = raw.trim().removeSuffix("/").removeSuffix(".git")
        // 各域的可识别前缀（顺序无关，命中即按该域处理）
        val hosts = listOf(
            "github" to listOf("github:", "https://github.com/", "http://github.com/", "github.com/"),
            "gitee" to listOf("https://gitee.com/", "http://gitee.com/", "gitee.com/"),
        )
        for ((domain, prefixes) in hosts) {
            for (p in prefixes) {
                if (!r.startsWith(p)) continue
                val seg = r.removePrefix(p).split("/")
                if (seg.size >= 2 && seg[0].isNotEmpty() && seg[1].isNotEmpty()) {
                    return domain to (seg[0] + "/" + seg[1])
                }
                return null   // 前缀命中但路径不全 → 无效，不回退成裸 owner/repo
            }
        }
        // 裸 owner/repo：无域信息，按 GitHub 处理（保持既有行为）
        val seg = r.split("/")
        if (seg.size >= 2 && seg[0].isNotEmpty() && seg[1].isNotEmpty()) {
            return "github" to (seg[0] + "/" + seg[1])
        }
        return null
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
                val code = dshPluginSync(args, label)
                if (code == 0) rememberPendingSource()
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
                                // allowDowngrade = true：重置的语义就是「回到出厂版」，
                                // 与「修复」按钮不同。这个分支只会命中「缺失 / 损坏」的副本
                                // （健康的在线升级副本不进这里），而损坏副本本来就跑不起来；
                                // 升级前的副本仍在 files/.plugin-backup/<dir>，可随时回滚取回。
                                val restored = repairFromSource(e, allowDowngrade = true)
                                appendLog(if (restored) "   ✓ ${e.dir} 已从源目录恢复" else "   ✗ ${e.dir} 恢复失败")
                                if (restored && h.aheadOfSource) {
                                    appendLog("   ⚠ ${e.dir} 此前已在线升级到更高版本，本次已恢复为出厂版；如需新版请用「插件在线升级」分区的升级 / 回滚")
                                }
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
    // ── 在线扩展的来源记录与更新 ─────────────────────────


    /** 读回某个在线插件的来源（无记录返回 null）。 */
    private fun sourceOf(pkg: String): Pair<String, String>? {
        val v = prefs().getString("src_" + pkg, null) ?: return null
        val i = v.indexOf('|')
        if (i <= 0) return null
        return v.substring(0, i) to v.substring(i + 1)
    }

    /** 待落盘的来源（安装是异步的，包名要装完才拿得到）。 */
    @Volatile private var pendingSource: Pair<String, String>? = null
    /**
     * 允许 git 源插件的 prepare 构建 —— 否则 pnpm 出于供应链安全**默认阻止**，装不上。
     *
     * 为什么不能只靠自己拼 key（真机踩到）：key 里的**包名是 package.json 的 name**，不是仓库名。
     * 例如 gitee.com/iJetLi/deepseek-harness-codearts 的包名其实是 `dsh-codearts-auth`。
     * 仓库要 clone 下来才知道包名，预拼必然写错；pnpm 会把它当无效条目，另写一条占位：
     *
     *   allowBuilds:
     *     dsh-codearts-auth@git+https://…git#<sha>: set this to true or false
     *
     * 所以分两步：① 先按 repo 名尽力写一条（有些仓库确实同名，能一次过）；
     * ② 安装后由 approvePendingBuilds() 扫 pnpm 写下的占位行，用**真实包名**改成 true。
     */
    private fun allowGitBuild(domain: String, repo: String) {
        try {
            val head = remoteHead(domain, repo)
            if (head == null) {
                appendLog("   （未取到上游 HEAD，跳过 allowBuilds 预置）")
                return
            }
            val spec = when (domain) {
                "gitee" -> "git+https://gitee.com/$repo.git"
                else -> "git+https://github.com/$repo.git"
            }
            val guess = repo.substringAfter('/')
            appendAllowBuild(guess + "@" + spec + "#" + head)
            appendLog("   已预置 allowBuilds（猜测包名 " + guess + "，装后按 pnpm 写下的实际包名纠正）")
        } catch (t: Throwable) { appendLog("   WARN allowGitBuild: " + t.message) }
    }

    /**
     * 把 pnpm 写下的 `set this to true or false` 占位行改成 true。
     *
     * pnpm 在 add 时会把识别出的**真实包名**写进 allowBuilds（值留成待裁决的占位），
     * 这是唯一可靠的包名来源（仓库名 ≠ 包名）。改完重跑 add，prepare 构建即被放行。
     * @return 是否改动了占位（true 表示值得再试一次 add）
     */
    private fun approvePendingBuilds(): Boolean {
        val f = File(profileWebDir(), "pnpm-workspace.yaml")
        if (!f.isFile) return false
        return try {
            val txt = f.readText()
            val marker = "set this to true or false"
            if (!txt.contains(marker)) return false
            val out = StringBuilder()
            for (line in txt.split("\n")) {
                if (line.contains(marker) && line.contains("@git+")) {
                    out.append(line.substringBeforeLast(":")).append(": true")
                } else {
                    out.append(line)
                }
                out.append("\n")
            }
            f.writeText(out.toString())
            appendLog("   已批准 pnpm 列出的构建许可（prepare 脚本）")
            true
        } catch (t: Throwable) {
            appendLog("   WARN approvePendingBuilds: " + t.message)
            false
        }
    }

    /** 往 profile 的 pnpm-workspace.yaml 追加一条 allowBuilds（幂等、保留原有内容）。 */
    private fun appendAllowBuild(key: String) {
        val f = File(profileWebDir(), "pnpm-workspace.yaml")
        val cur = if (f.isFile) f.readText() else "packages:\n  - .\n"
        if (cur.contains(key)) return
        val line = "  '" + key + "': true"
        val out = if (Regex("^allowBuilds:", RegexOption.MULTILINE).containsMatchIn(cur)) {
            cur.trimEnd() + "\n" + line + "\n"
        } else {
            cur.trimEnd() + "\nallowBuilds:\n" + line + "\n"
        }
        f.parentFile?.mkdirs()
        f.writeText(out)
    }

    /** 安装成功后把来源按**真实包名**落盘（供检查更新按包名查）。 */
    private fun rememberPendingSource() {
        val p = pendingSource ?: return
        pendingSource = null
        val (repo, domain) = p
        val pkg = try {
            val j = JSONObject(profilePkg().readText())
            val deps = j.optJSONObject("dependencies")
            if (deps == null) null else deps.keys().asSequence().firstOrNull { k -> deps.optString(k).contains(repo) }
        } catch (t: Throwable) { null }
        if (pkg == null) {
            appendLog("   （未能识别包名，来源未记录；更新入口将不可用）")
            return
        }
        prefs().edit().putString("src_" + pkg, domain + "|" + repo).apply()
        appendLog("   已记录来源：" + pkg + " ← " + domain + "/" + repo)
    }

    private fun prefs() = getSharedPreferences("dsh_plugin_src", MODE_PRIVATE)

    /** 该插件在 lockfile 里钉住的 commit（无则 null）。 */
    private fun installedCommit(pkg: String): String? {
        return try {
            val lf = File(profileWebDir(), "pnpm-lock.yaml")
            if (!lf.isFile) return null
            val re = Regex("\\s" + Regex.escape(pkg) + ":\\s*")
            val txt = lf.readText()
            val m = re.find(txt) ?: return null
            val tail = txt.substring(m.range.last + 1).take(600)
            Regex("#([0-9a-f]{40})").find(tail)?.groupValues?.get(1)
        } catch (t: Throwable) { null }
    }

    /** 上游 HEAD commit（git ls-remote）。失败返回 null。 */
    private fun remoteHead(domain: String, repo: String): String? {
        val url = when (domain) {
            "gitee" -> "https://gitee.com/$repo.git"
            else -> "https://github.com/$repo.git"
        }
        val out = captureProcess("git ls-remote " + url + " HEAD", baseEnv()) ?: return null
        return Regex("^([0-9a-f]{40})").find(out.trim())?.groupValues?.get(1)
    }

    /** 执行命令并**捕获 stdout**（runProcess 只回 exit code，版本查询需要输出）。 */
    private fun captureProcess(cmd: String, env: Map<String, String>): String? {
        return try {
            val bash = TermuxRuntime.bashPath(this)
            if (!bash.isFile) return null
            val pb = ProcessBuilder(bash.absolutePath, "-c", cmd)
            pb.redirectErrorStream(true)
            pb.directory(File(filesDir, "tmp").apply { mkdirs() })
            val e = pb.environment()
            env.forEach { (k, v) -> e[k] = v }
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor()
            out
        } catch (t: Throwable) { appendLog("   WARN capture: ${t.message}"); null }
    }

    /**
     * 检查某个在线插件是否有上游更新，并（可选）执行更新。
     *
     * **为什么必须用「显式 commit」重装**（真机实测）：
     * pnpm 把 git spec 的解析结果钉进 lockfile，之后 `pnpm update` / `pnpm add` /
     * `--force` 在 specifier 未变时**根本不会调用 git ls-remote**（用 git 包装脚本实测确认：
     * 五种方式全部未触发），所以点「更新」会空转。
     * 唯一可靠的做法是自己 `git ls-remote` 取上游 HEAD，再以
     * `git+https://<host>/<owner>/<repo>.git#<commit>` 重新 add —— specifier 因此变化，
     * pnpm 必须重新解析（实测 specifier 与 version 都推进到新 commit）。
     */
    private fun checkPluginUpdate(pkg: String, apply: Boolean) {
        if (!guardBusy()) return
        val src = sourceOf(pkg)
        if (src == null) {
            appendLog("$pkg：无来源记录（非本页安装，无法比对上游）")
            toast("该插件没有来源记录")
            return
        }
        val (domain, repo) = src
        setBusy(true)
        Thread {
            try {
                appendLog(">> 检查 $pkg 上游（$domain/$repo）…")
                val head = remoteHead(domain, repo)
                if (head == null) {
                    appendLog("   ✗ 无法获取上游 HEAD（网络或仓库不可达）")
                    return@Thread
                }
                val cur = installedCommit(pkg)
                appendLog("   已装 commit: ${cur ?: "?"}")
                appendLog("   上游 commit: $head")
                if (cur == head) {
                    appendLog("   ✓ 已是最新")
                    return@Thread
                }
                appendLog("   ↑ 发现新版本")
                if (!apply) return@Thread
                // 以显式 commit 重装：specifier 变化 → pnpm 必须重新解析（见上方注释）
                val spec = when (domain) {
                    "gitee" -> "git+https://gitee.com/$repo.git#$head"
                    else -> "git+https://github.com/$repo.git#$head"
                }
                appendLog(">> 更新到 ${head.take(8)} …")
                val code = dshPluginSync(listOf("add", spec), "更新 $pkg")
                appendLog(if (code == 0) "   ✓ 更新完成" else "   ✗ 更新失败（exit=$code）")
            } catch (t: Throwable) {
                appendLog("检查更新异常: ${t.message}")
            } finally {
                runOnUiThread { setBusy(false); refreshListSafe() }
            }
        }.start()
    }

    private fun uninstall(name: String) {
        runDshPlugin(listOf("remove", name), "卸载 $name")
    }

    // ── 操作：插件在线升级（npm）──────────────────────────

    /**
     * 检查 plugin-upgrade.mjs 是否可运行：确保 node 与脚本都在位。
     * 返回 null 表示不可运行（原因已写日志），否则返回 (node, script)。
     */
    private fun upgradeTooling(): Pair<File, File>? {
        ensureHarnessTools()
        val node = File(File(nodeDir, "bin"), "node")
        if (!node.isFile) {
            appendLog("✗ 在线升级不可用：内置 node 缺失（$node）")
            toast("内置 node 缺失，无法在线升级")
            return null
        }
        val script = PluginUpgrade.ensureScript(this)
        if (script == null) {
            appendLog("✗ 在线升级不可用：${PluginUpgrade.SCRIPT_REL} 缺失（assets 与 files 均取不到）")
            toast("升级脚本缺失，请重新安装 APK 或点「重新装配」")
            return null
        }
        return node to script
    }

    /** 在线升级脚本的进程环境：与 rewireCore 完全同源（只需 DSH_PREFIX，其余由 env.mjs 派生）。 */
    private fun upgradeEnv(): MutableMap<String, String> = baseEnv().apply {
        put("DSH_PREFIX", dshPrefix().absolutePath)
        put("DSH_PROFILE", "web")
        put("DSH_PLUGINS_DIR", pluginsDir().absolutePath)
        put("DSH_APK_VER", AssetSync.apkVersion(this@PluginManagerActivity).toString())
    }

    /**
     * 跑 plugin-upgrade.mjs 的一个子命令。
     *
     * @param args 子命令与参数，如 ["--check"]、["--apply", dir]、["--rollback", dir, "--version", v]
     * @return 脚本退出码；-1 表示环境不满足（未执行）。
     */
    private fun runUpgradeScript(args: List<String>, label: String): Int {
        val (node, script) = upgradeTooling() ?: return -1
        // 路径与参数都不做 shell 转义：node/script 是 files 下的绝对路径，dir 来自清单
        // （check-plugin-manifest.mjs 会拦下异常 dir），version 来自备份目录名。
        // 若将来要把用户输入接进来，这里必须换成逐参数转义，不能直接拼。
        val cmd = "${node.absolutePath} ${script.absolutePath} " + args.joinToString(" ") { "$it" }
        return runProcess(cmd, upgradeEnv(), label)
    }

    /** 检查更新（后台，busy 锁）。[force] 为真时忽略 6 小时缓存直接打网络。 */
    private fun runUpgradeCheck(force: Boolean) {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 检查插件在线升级${if (force) "（强制重查）" else ""}…")
        Thread {
            try {
                val args = mutableListOf("--check")
                if (force) args.add("--force")
                val code = runUpgradeScript(args, "检查插件更新")
                // 退出码 0 才算查完；1 时脚本已经把失败原因写给每条 item，界面照常回读
                appendLog(if (code == 0) "   ✓ 检查完成（见上方逐条结果）" else "   ✗ 检查未完成（exit=$code）")
            } catch (t: Throwable) {
                appendLog("检查插件更新异常: ${t.message}")
            } finally {
                refreshListSafe()
                setBusy(false)
            }
        }.start()
    }

    /**
     * 在线升级单个插件。
     *
     * 升级成功后不停在日志里：弹窗告诉用户「已替换副本，但 dsh 还在跑旧代码」，
     * 并直接给「立即重启」——这是本功能最容易让人误判「没生效」的地方。
     */
    private fun runUpgrade(e: PluginEntry) {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 在线升级 ${e.dir}（npm: ${e.npm}）…")
        Thread {
            var code = -1
            try {
                code = runUpgradeScript(listOf("--apply", e.dir), "在线升级 ${e.dir}")
            } catch (t: Throwable) {
                appendLog("在线升级异常: ${t.message}")
            } finally {
                refreshListSafe()
                setBusy(false)
            }
            runOnUiThread { if (code == 0) showUpgradedDialog(e) }
        }.start()
    }

    /** 回滚到指定备份版本。 */
    private fun runRollback(e: PluginEntry, version: String) {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 回滚 ${e.dir} → $version …")
        Thread {
            var code = -1
            try {
                code = runUpgradeScript(listOf("--rollback", e.dir, "--version", version), "回滚 ${e.dir}")
            } catch (t: Throwable) {
                appendLog("回滚异常: ${t.message}")
            } finally {
                refreshListSafe()
                setBusy(false)
            }
            if (code == 0) {
                runOnUiThread {
                    toast("${e.dir} 已回滚到 $version，需重新装配后生效")
                }
            }
        }.start()
    }

    /** 升级成功后的收尾提示：告知「需重新装配/重启」，并把两个动作直接送达。 */
    private fun showUpgradedDialog(e: PluginEntry) {
        if (isFinishing || isDestroyed) return
        val cur = readVersion(e.dir)
        AlertDialog.Builder(this)
            .setTitle("升级完成")
            .setMessage(
                "${e.title.ifBlank { e.dir }} 的插件副本已替换（当前版本 $cur）。\n\n" +
                    "dsh 正在运行的仍是升级前的代码，需要重新装配或重启才会生效。"
            )
            .setPositiveButton("立即重启") { _, _ -> restartFlow() }
            .setNeutralButton("稍后", null)
            .setNegativeButton("重新装配") { _, _ -> rewireBuiltins() }
            .show()
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
