package com.dsh.launcher

import android.content.Intent
import android.os.Bundle
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

/**
 * 插件管理系统：内置插件一览（APK 内 plugins 源）+ 在线安装/卸载。
 *
 * v4.2.3 起围绕「重置」重构：
 * - 健康检查：每个内置插件判定 目录存在/package.json 可解析/已装配 三态，
 *   异常（空壳损坏、目录缺失、待装配）在列表顶部汇总成「一键重置」卡片；
 * - 重置流程：先同步 extra-plugins 源 → 对异常副本从内置源恢复
 *   （extra-plugins 直拷；third_party 来源的从 prebuilt.tgz 解包子树）→
 *   再跑官方 `install-dsh.mjs --plugins-only` 整体装配；
 * - 单插件级「修复/恢复/装配」按钮；
 * - 全部操作走 busy 锁防并发，进度条反馈；后台线程不再直接触碰视图
 *   （旧实现在 Thread 里调 refreshList，有 CalledFromWrongThreadException 隐患）；
 * - 「重启 dsh」改为快速启动（旧实现误触发完整安装流）。
 *
 * 装配动作全部走官方 `dsh plugin --profile web add/remove`；
 * `yjh051108/dsh-routing-suite` 走特殊适配（routing-suite.mjs）；
 * `scp3500/oh-we-need` 是纯提示词仓库，已内置为 dsh-oh-we-need 插件。
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

    private lateinit var listBox: LinearLayout
    private lateinit var input: EditText
    private lateinit var logView: TextView
    private lateinit var progress: ProgressBar
    private lateinit var installBtn: View
    private lateinit var wireBtn: View
    private lateinit var restartBtn: View
    private val logSb = StringBuilder()

    @Volatile
    private var busy = false

    private val nodeDir: File get() = NodeRuntime.ensureExtracted(this)

    private fun dshPrefix() = File(filesDir, "dsh-prefix")
    private fun dshCliFile() = File(dshPrefix(), "node_modules/@deepseek-ai/dsh/lib/bin.js")
    private fun pluginsDir() = File(filesDir, "plugins")
    private fun profileWebDir() = File(filesDir, ".dsh/profiles/web")
    private fun profilePkg() = File(profileWebDir(), "package.json")
    private fun presetsRoot() = File(filesDir, ".dsh/.agent-presets")

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(16), dp(14), dp(16), dp(12))
        }

        val title = TextView(this).apply {
            text = "插件管理"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }
        val sub = TextView(this).apply {
            text = "内置插件随 app 自动装配；在线安装通过官方 dsh plugin --profile web add 完成"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(2), 0, dp(8))
        }
        val tip = TextView(this).apply {
            text = "在线仓库示例：mexiaosqwq/dsh-web-mobile · yjh051108/dsh-routing-suite · mafeis/dsh-net-proxy · scp3500/oh-we-need\n" +
                "本机内置：" + BUNDLED.sorted().joinToString(" · ") + " · " + PRESET_DIR
            textSize = 11f
            setTextColor(Ui.TEXT_MUTED)
            setLineSpacing(dp(2).toFloat(), 1f)
        }

        root.addView(title, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        root.addView(sub, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        root.addView(tip, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(4) })

        input = EditText(this).apply {
            hint = "GitHub 仓库，如 mexiaosqwq/dsh-web-mobile"
            textSize = 14f
            setTextColor(Ui.TEXT_PRIMARY)
            setHintTextColor(Ui.TEXT_MUTED)
            background = Ui.rounded(this@PluginManagerActivity, Ui.SURFACE_INPUT, 12, Ui.OUTLINE)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }
        root.addView(input, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })

        // 操作进度条：任何装配/重置/重启期间可见
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Ui.BRAND)
        }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(6)
        ).apply { topMargin = dp(8) })

        fun rowOf(vararg buttons: View): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            buttons.forEachIndexed { index, button ->
                addView(button, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (index < buttons.lastIndex) rightMargin = dp(6)
                })
            }
        }

        installBtn = Ui.button(this, "安装 / 更新", { installFromRepo() }, filled = true)
        wireBtn = Ui.button(this, "重新装配", { rewireBuiltins() }, filled = false)
        restartBtn = Ui.button(this, "重启 dsh 服务", { restartFlow() }, filled = false)
        val backBtn = Ui.button(this, "返回", { finish() }, filled = false)
        root.addView(rowOf(installBtn, wireBtn, restartBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })
        root.addView(rowOf(backBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })

        listBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val listScroll = ScrollView(this).apply {
            addView(listBox, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(listScroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ).apply { topMargin = dp(10) })

        val logCard = Ui.card(this, radiusDp = 12, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        logView = TextView(this).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(dp(2), dp(2), dp(2), dp(2))
        }
        val logScroll = ScrollView(this).apply {
            addView(logView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        logCard.addView(logScroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(logCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(150)
        ).apply { topMargin = dp(8) })

        setContentView(root)

        appendLog("插件管理就绪（内置 ${BUNDLED.size} 个 + $PRESET_DIR 预设）")
    }

    override fun onResume() {
        super.onResume()
        refreshList()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun appendLog(m: String) {
        logSb.append("${System.currentTimeMillis() % 100000}\t$m\n")
        if (logSb.length > 20000) logSb.delete(0, logSb.length / 2)
        runOnUiThread { logView.text = logSb.toString() }
    }

    /** 后台线程安全版刷新。 */
    private fun refreshListSafe() {
        runOnUiThread { refreshList() }
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
            listOf(installBtn, wireBtn, restartBtn).forEach {
                it.isEnabled = !b
                it.alpha = if (b) 0.5f else 1f
            }
        }
    }

    // ── 健康检查 ──────────────────────────────────────────

    private data class BundledHealth(val dirExists: Boolean, val healthy: Boolean, val wired: Boolean, val srcOk: Boolean)

    private fun healthOf(id: String): BundledHealth {
        val dir = File(pluginsDir(), id)
        return BundledHealth(dir.isDirectory, bundleHealthy(dir), isWired(id), bundledSourceAvailable(id))
    }

    /** 目录健康：package.json 存在、可解析、name 非空。
     *  （空壳损坏——package.json 为空/lib/index.js 变空目录——曾是 AssetSync 文件误判 bug 的产物。） */
    private fun bundleHealthy(dir: File): Boolean {
        val p = File(dir, "package.json")
        if (!p.isFile) return false
        val j = runCatching { JSONObject(p.readText()) }.getOrNull() ?: return false
        return j.optString("name").isNotBlank()
    }

    /** APK 内是否带有该插件的可用源：extra-plugins 直拷源，或 prebuilt.tgz 内的 third_party 子树。 */
    private fun bundledSourceAvailable(id: String): Boolean {
        if (File(filesDir, "extra-plugins/$id/package.json").isFile) return true
        val tgz = File(filesDir, "prebuilt.tgz")
        if (!tgz.isFile) return false
        return runCatching {
            val pb = ProcessBuilder(
                "/system/bin/sh", "-c",
                "tar -tzf '${tgz.absolutePath}' './third_party/$id/package.json' 2>/dev/null | head -n 1"
            )
            pb.redirectErrorStream(true)
            val p = pb.start()
            val line = p.inputStream.bufferedReader().readLine()
            p.waitFor()
            !line.isNullOrBlank()
        }.getOrDefault(false)
    }

    /** 从内置源恢复单个插件目录：extra-plugins 直拷；否则从 prebuilt.tgz 解包对应子树。 */
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

    // ── 列表 ──────────────────────────────────────────────
    private fun refreshList() {
        val tp = pluginsDir()
        listBox.removeAllViews()
        if (!tp.exists()) {
            listBox.addView(makeCard("（内置插件源未就绪：先在主界面完成一次自动安装）", "提示", "", "—", emptyList()))
            return
        }

        listBox.addView(Ui.sectionLabel(this, "内置与预设").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(6) }
        })

        // 先收集健康度：有异常时在区块顶部插一张汇总卡
        val issues = mutableListOf<String>()
        val bundledRows = mutableListOf<Triple<String, View, Unit>>()
        for (d in BUNDLED.sorted()) {
            val h = healthOf(d)
            val ver = readVersion(d)
            val status: String
            val actions = mutableListOf<Pair<String, () -> Unit>>()
            when {
                !h.dirExists -> {
                    status = if (h.srcOk) "缺失 · 可修复" else "未内置（构建产物缺失）"
                    if (h.srcOk) actions.add("恢复" to { repairSingle(d) })
                    issues.add("$d：目录缺失")
                }
                !h.healthy -> {
                    status = if (h.srcOk) "已损坏 · 可修复" else "已损坏（无内置源）"
                    if (h.srcOk) actions.add("修复" to { repairSingle(d) })
                    issues.add("$d：副本损坏")
                }
                !h.wired -> {
                    status = "待装配"
                    actions.add("装配" to { wireBundled(d) })
                    issues.add("$d：未装配")
                }
                else -> status = "内置 · 已装配"
            }
            bundledRows.add(Triple(d, makeCard(d, BUNDLED_DESC[d] ?: "", ver, status, actions), Unit))
        }

        if (issues.isNotEmpty()) {
            listBox.addView(buildSummaryCard(issues))
        }
        for ((_, view, _) in bundledRows) listBox.addView(view)

        // 路由预设（容器展平后以 router-spec/router-standard 两个一级预设生效）
        val presetOk = listOf("router-spec", "router-standard").any { File(presetsRoot(), it).exists() }
        if (!presetOk) issues.add("$PRESET_DIR：未安装")
        listBox.addView(makeCard(
            PRESET_DIR, PRESET_DESC, "preset",
            if (presetOk) "已安装（agent-presets）" else "待装配（需重新装配）",
            if (presetOk) emptyList() else listOf("重新装配" to { rewireBuiltins() })
        ))

        // 官方 dsh plugin add 装配的额外插件（从 profile package.json 的 bundles 读取）
        val extras = readBundles().filter { name ->
            name !in BASE_BUNDLES &&
                !BUNDLED.any { d -> name == d || name == "@dsh-external/$d" }
        }
        if (extras.isNotEmpty()) {
            listBox.addView(Ui.sectionLabel(this, "在线装配扩展").apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10); bottomMargin = dp(6) }
            })
            for (name in extras) {
                val info = readInstalledPlugin(name) ?: continue
                listBox.addView(makeCard(name, info.desc, info.version, "已装配", listOf("卸载" to { uninstall(name) })))
            }
        }
    }

    /** 异常汇总卡（红描边）：列出前几条原因 + 一键重置入口。 */
    private fun buildSummaryCard(issues: List<String>): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_HIGH, stroke = Ui.DANGER, elevationDp = 1f)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        card.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(8) }
        content.addView(TextView(this).apply {
            text = "⚠ 检测到 ${issues.size} 个插件异常"
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.DANGER)
        })
        content.addView(TextView(this).apply {
            text = issues.take(4).joinToString("\n") { "· $it" } + if (issues.size > 4) "\n· …" else ""
            textSize = 11.5f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(4), 0, 0)
            setLineSpacing(dp(2).toFloat(), 1f)
        })
        content.addView(Ui.button(this, "一键重置修复", { resetBuiltins() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        })
        card.addView(content)
        return card
    }

    data class PluginInfo(val id: String, val name: String, val desc: String, val version: String)

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
        } catch (t: Throwable) { PluginInfo(name, name, "", "?") }
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
        return try { JSONObject(p.readText()).optString("version", "?") } catch (t: Throwable) { "?" }
    }

    /** 状态 pill 颜色：显式映射，避免「已损坏」命中 contains("已") 被画成绿色。 */
    private fun statusColor(status: String): Int = when {
        status.contains("已装配") || status.contains("已安装") || status.contains("已连接") -> Ui.SUCCESS
        status.contains("损坏") || status.contains("缺失") -> Ui.DANGER
        status.contains("待") || status.contains("需") -> Ui.WARNING
        else -> Ui.TEXT_MUTED
    }

    private fun makeCard(name: String, desc: String, ver: String, status: String, actions: List<Pair<String, () -> Unit>>): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER, elevationDp = 1f)
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.setMargins(0, 0, 0, dp(6))
        card.layoutParams = lp

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        card.addView(content, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
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
        }.apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
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
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { rightMargin = dp(6) }
                })
            }
            content.addView(actRow)
        }
        return card
    }

    // ── 在线安装 ──────────────────────────────────────────
    private fun installFromRepo() {
        if (!guardBusy()) return
        val raw = input.text.toString().trim()
        val repo = parseRepo(raw)
        if (repo == null) {
            appendLog("仓库格式无效：$raw（应形如 owner/repo 或 https://github.com/owner/repo）")
            return
        }
        if (repo == ROUTING_REPO) {
            appendLog(">> 特殊适配安装 $repo …")
            runRoutingSuite()
        } else if (repo == OH_WE_NEED_REPO) {
            appendLog(">> $repo 是纯提示词仓库，已内置为 dsh-oh-we-need 插件；触发重新装配…")
            rewireBuiltins()
        } else {
            runDshPlugin(listOf("add", "github:$repo"), "安装 $repo")
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
            appendLog("   ✗ dsh 未安装（请先回主界面完成一次自动安装）")
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

    /** 单个内置插件「装配」：目录健康但未注册进 profile 时使用。 */
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

    /** 单个内置插件「修复/恢复」：清掉异常副本 → 从内置源恢复 → 注册进 profile。 */
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

    /** 重新装配内置插件：只跑 install-dsh.mjs --plugins-only，不改 dsh 本体。 */
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

    /** 同步 assets 的 extra-plugins 源到 files（AssetSync 已修复文件误判，clearFirst 自愈坏拷贝）。 */
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

    /** 确保内置 Termux 与 Harness 工具（git/rg/file 等）就绪，失败仅记录不中断插件操作。 */
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
        val termuxReady = File(termux, "bin/bash").isFile
        val termuxDirs = if (termuxReady) {
            listOf(
                File(termux, "bin").absolutePath,
                File(termux, "bin/applets").absolutePath,
                File(termux, "local/bin").absolutePath
            )
        } else emptyList()
        val path = (termuxDirs + listOf(
            File(node, "bin").absolutePath,
            File(tools, "bin").absolutePath,
            File(tools, "lib/node_modules/.bin").absolutePath,
            "/system/bin", "/bin", "/usr/bin"
        )).joinToString(":")
        val gitConfig = File(filesDir, ".gitconfig")
        if (!gitConfig.exists()) gitConfig.writeText("")
        return mutableMapOf(
            "PATH" to path,
            "HOME" to filesDir.absolutePath,
            "LD_LIBRARY_PATH" to if (termuxReady) {
                "${File(node, "lib").absolutePath}:${File(termux, "lib").absolutePath}"
            } else {
                File(node, "lib").absolutePath
            },
            "GIT_CONFIG_NOSYSTEM" to "1",
            "GIT_CONFIG_GLOBAL" to gitConfig.absolutePath,
            "TMPDIR" to File(filesDir, "tmp").absolutePath,
            "TMP" to File(filesDir, "tmp").absolutePath,
            "TEMP" to File(filesDir, "tmp").absolutePath,
            "TERM" to "xterm-256color",
            "OPENSSL_CONF" to "/dev/null"
        ).apply {
            if (termuxReady) {
                put("PREFIX", termux.absolutePath)
                put("GIT_EXEC_PATH", File(termux, "libexec/git-core").absolutePath)
            }
        }
    }

    private fun runProcess(cmd: String, env: Map<String, String>, label: String): Int {
        appendLog("   $ $cmd")
        return try {
            val pb = ProcessBuilder("/system/bin/sh", "-c", cmd)
            pb.redirectErrorStream(true)
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

    /** 重启 dsh：杀 node 后走快速启动引擎（秒级；旧实现误触发完整安装流）。 */
    private fun restartFlow() {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 重启 dsh 服务（快速启动，不做安装）…")
        Thread {
            DshFlow.killAllNode(this) { appendLog(it) }
            Thread.sleep(1500)
            runOnUiThread {
                DshFlow.launch(
                    this, DshFlow.Mode.START_ONLY,
                    onLog = { appendLog(it) },
                    onDone = { ok ->
                        setBusy(false)
                        appendLog(if (ok) "✓ dsh 已重启（http://127.0.0.1:${DshFlow.WEB_PORT}）" else "✗ 重启失败，详见上方日志")
                    }
                )
            }
        }.start()
    }
}
