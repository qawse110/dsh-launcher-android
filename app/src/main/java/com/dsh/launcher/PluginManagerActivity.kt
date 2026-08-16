package com.dsh.launcher

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.File

/**
 * 插件管理系统：内置插件一览（APK 内 plugins 源）+ 在线安装/卸载。
 *
 * 装配动作全部走官方 `dsh plugin --profile web add/remove`；
 * 仅 `yjh051108/dsh-routing-suite` 走特殊适配（routing-suite.mjs：
 * 下载聚合仓库 + 三个子仓库 → 装配 injector/mode-boost → 拷贝 agent-preset）。
 */
class PluginManagerActivity : Activity() {

    companion object {
        // 内置插件（随 APK 分发；首次 flow 已通过 dsh plugin add 装配）
        val BUNDLED = setOf(
            "dsh-mobile-nav", "dsh-super-injector",
            "dsh-net-proxy", "dsh-provider-headers", "dsh-vision",
        )
        val BUNDLED_DESC = mapOf(
            "dsh-mobile-nav" to "移动端 UI 适配（窄屏抽屉/全宽会话）",
            "dsh-super-injector" to "超级模组注入器（dev_* 运行时工具全家桶）",
            "dsh-net-proxy" to "网络代理（web_search/web_fetch 走代理）",
            "dsh-provider-headers" to "自定义 provider 请求头（设置页配置）",
            "dsh-vision" to "视觉（view_image 工具 + VLM 后端）",
        )
        const val PRESET_DIR = "router-preset"
        const val PRESET_DESC = "思维模式路由预设（router-pro / router-spec / router-standard，agent-presets）"
        const val REPO_DIR = "plugin-repo"
        const val ROUTING_REPO = "yjh051108/dsh-routing-suite"
        private val BASE_BUNDLES = setOf(
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@deepseek-ai/dsh-headless",
        )
    }

    private lateinit var listBox: LinearLayout
    private lateinit var input: EditText
    private lateinit var logView: TextView
    private val logSb = StringBuilder()
    private val nodeDir: File get() = NodeRuntime.ensureExtracted(this)

    private fun dshPrefix() = File(filesDir, "dsh-prefix")
    private fun dshCliFile() = File(dshPrefix(), "node_modules/@deepseek-ai/dsh/lib/bin.js")
    private fun pluginsDir() = File(filesDir, "plugins")
    private fun profileWebDir() = File(filesDir, ".dsh/profiles/web")
    private fun profilePatch() = File(profileWebDir(), "cordis.patch.yml")
    private fun profilePkg() = File(profileWebDir(), "package.json")
    private fun presetsRoot() = File(filesDir, ".dsh/.agent-presets")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF10131A.toInt())
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }

        val title = TextView(this).apply {
            text = "插件管理"
            textSize = 20f
            setTextColor(0xFFFFFFFF.toInt())
        }
        val sub = TextView(this).apply {
            text = "内置插件随 app 自动装配；在线安装通过官方 dsh plugin --profile web add 完成"
            textSize = 11f
            setTextColor(0xFF9AA3B2.toInt())
        }

        val tip = TextView(this).apply {
            text = "可用：mexiaosqwq/dsh-web-mobile · yjh051108/dsh-routing-suite · mafeis/dsh-net-proxy\n本机已内置：dsh-mobile-nav · dsh-super-injector · dsh-net-proxy · dsh-provider-headers · dsh-vision · router-preset"
            textSize = 11f
            setTextColor(0xFF6B7686.toInt())
        }

        input = EditText(this).apply {
            hint = "GitHub 仓库，如 mexiaosqwq/dsh-web-mobile"
            textSize = 14f
            setTextColor(0xFFFFFFFF.toInt())
            setHintTextColor(0xFF556070.toInt())
            setBackgroundColor(0xFF20242D.toInt())
            setPadding(dp(10), dp(8), dp(10), dp(8))
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }

        val installBtn = Button(this).apply {
            text = "安装 / 更新"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { installFromRepo() }
        }
        val wireBtn = Button(this).apply {
            text = "重新装配"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { rewireBuiltins() }
        }
        val restartBtn = Button(this).apply {
            text = "重启 dsh"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { restartFlow() }
        }
        val backBtn = Button(this).apply {
            text = "返回"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { finish() }
        }
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(installBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(wireBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(restartBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(backBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        listBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val listScroll = ScrollView(this).apply {
            addView(listBox, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        logView = TextView(this).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(0xFFB8C2D0.toInt())
            setBackgroundColor(0xFF1A1F2A.toInt())
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        val logScroll = ScrollView(this).apply {
            addView(logView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        root.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(sub, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(tip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(btnRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(listScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(logScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(150)))
        setContentView(root)

        appendLog("插件管理就绪（内置 ${BUNDLED.size} 个 + $PRESET_DIR 预设）")
    }

    override fun onResume() {
        super.onResume()
        refreshList()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun appendLog(m: String) {
        logSb.append("${System.currentTimeMillis() % 100000}\t$m\n")
        if (logSb.length > 20000) logSb.delete(0, logSb.length / 2)
        runOnUiThread { logView.text = logSb.toString() }
    }

    // ── 列表 ──────────────────────────────────────────────
    private fun refreshList() {
        val tp = pluginsDir()
        listBox.removeAllViews()
        if (!tp.exists()) {
            listBox.addView(makeCard("（内置插件源未就绪：先回控制台跑一次「执行 dsh」）", "提示", "", "—", emptyList()))
            return
        }
        val tpDirs = tp.listFiles { f -> f.isDirectory }?.map { it.name }?.toSet() ?: emptySet()

        for (d in BUNDLED.sorted()) {
            val builtin = File(tp, d).isDirectory
            val wired = isWired(d)
            val status = if (!builtin) "未内置（构建产物缺失）"
            else if (wired) "内置 · 已装配"
            else "内置 · 待装配（需重新装配）"
            val ver = readVersion(d)
            listBox.addView(makeCard(d, BUNDLED_DESC[d] ?: "", ver, status, emptyList()))
        }

        // 路由预设（容器展平后以 router-pro/router-spec/router-standard 三个一级预设生效）
        val presetOk = listOf("router-pro", "router-spec", "router-standard").any { File(presetsRoot(), it).exists() }
        listBox.addView(makeCard(
            PRESET_DIR, PRESET_DESC, "preset",
            if (presetOk) "已安装（agent-presets）" else "待装配（需重新装配）", emptyList()))

        // 官方 dsh plugin add 装配的额外插件（从 profile package.json 的 bundles 读取）
        for (name in readBundles()) {
            if (name in BASE_BUNDLES) continue
            if (BUNDLED.any { d -> name == d || name == "@dsh-external/$d" }) continue
            val info = readInstalledPlugin(name) ?: continue
            listBox.addView(makeCard(name, info.desc, info.version, "已装配", listOf("卸载" to { uninstall(name) })))
        }
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

    private fun readPlugin(dir: String): PluginInfo? {
        val dirF = File(pluginsDir(), dir)
        val p = File(dirF, "package.json")
        if (!p.exists()) return null
        return try {
            val j = JSONObject(p.readText())
            val name = j.optString("name", dir)
            val ver = j.optString("version", "?")
            val desc = j.optString("description", "").take(80)
            val patch = File(dirF, "cordis.patch.yml")
            val id = if (patch.exists()) {
                Regex("- insert:\\s*\\n\\s*- id:\\s*(\\S+)")
                    .find(patch.readText())?.groupValues?.get(1) ?: dir
            } else dir
            PluginInfo(id, name, desc, ver)
        } catch (t: Throwable) { PluginInfo(dir, dir, "", "?") }
    }

    private fun readVersion(dir: String): String {
        val p = File(File(pluginsDir(), dir), "package.json")
        if (!p.exists()) return "?"
        return try { JSONObject(p.readText()).optString("version", "?") } catch (t: Throwable) { "?" }
    }

    private fun makeCard(name: String, desc: String, ver: String, status: String, actions: List<Pair<String, () -> Unit>>): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF1C212C.toInt())
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.setMargins(0, 0, 0, dp(6))
        card.layoutParams = lp

        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        titleRow.addView(TextView(this).apply {
            text = name
            textSize = 15f
            setTextColor(0xFFFFFFFF.toInt())
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        titleRow.addView(TextView(this).apply {
            text = "$ver · $status"
            textSize = 11f
            setTextColor(if (status.contains("已")) 0xFF7FD086.toInt() else 0xFFE0B45A.toInt())
        })
        card.addView(titleRow)

        if (desc.isNotEmpty()) {
            card.addView(TextView(this).apply {
                text = desc
                textSize = 11f
                setTextColor(0xFF8A95A6.toInt())
            })
        }
        if (actions.isNotEmpty()) {
            val actRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            for ((label, fn) in actions) {
                actRow.addView(Button(this).apply {
                    text = label
                    textSize = 12f
                    isAllCaps = false
                    setOnClickListener { fn() }
                })
            }
            card.addView(actRow)
        }
        return card
    }

    // ── 在线安装 ──────────────────────────────────────────
    private fun installFromRepo() {
        val raw = input.text.toString().trim()
        val repo = parseRepo(raw)
        if (repo == null) {
            appendLog("仓库格式无效：$raw（应形如 owner/repo 或 https://github.com/owner/repo）")
            return
        }
        if (repo == ROUTING_REPO) {
            appendLog(">> 特殊适配安装 $repo …")
            runRoutingSuite()
        } else {
            appendLog(">> 官方 dsh plugin add github:$repo …")
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
    private fun runDshPlugin(args: List<String>, label: String) {
        Thread {
            try {
                val cli = dshCliFile()
                if (!cli.exists()) {
                    appendLog("   ✗ dsh 未安装（请先回控制台执行「执行 dsh」）")
                    return@Thread
                }
                val node = File(File(nodeDir, "bin"), "node")
                val cmd = "${node.absolutePath} ${cli.absolutePath} plugin --profile web ${args.joinToString(" ")}"
                appendLog(">> $label …")
                appendLog("   $ ${cmd.replace(cli.absolutePath, "dsh")}")
                val code = runProcess(cmd, baseEnv(), label)
                appendLog(if (code == 0) "   ✓ $label 完成（exit=0）" else "   ✗ $label 失败（exit=$code）")
                refreshList()
            } catch (t: Throwable) {
                appendLog("$label 异常: ${t.message}")
            }
        }.start()
    }

    /** 重新装配内置插件：只跑 install-dsh.mjs --plugins-only，不改 dsh 本体。 */
    private fun rewireBuiltins() {
        Thread {
            try {
                appendLog(">> 重新装配内置插件…")
                val installScript = File(filesDir, "install-dsh.mjs")
                assets.open("install-dsh.mjs").use { input ->
                    installScript.outputStream().use { output -> input.copyTo(output) }
                }
                val prebuilt = File(filesDir, "prebuilt.tgz")
                try {
                    assets.open("prebuilt.tgz").use { input ->
                        prebuilt.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (t: Throwable) {
                    appendLog("   WARN 无法复制 prebuilt.tgz: ${t.message}")
                }
                val node = File(File(nodeDir, "bin"), "node")
                val cmd = "${node.absolutePath} ${installScript.absolutePath} --plugins-only"
                val env = baseEnv().apply {
                    put("DSH_PREFIX", dshPrefix().absolutePath)
                    put("DSH_PROFILE", "web")
                    put("DSH_PREBUILT", prebuilt.absolutePath)
                    put("DSH_PLUGINS_DIR", pluginsDir().absolutePath)
                }
                val code = runProcess(cmd, env, "重新装配")
                appendLog(if (code == 0) "   ✓ 重新装配完成" else "   ✗ 重新装配失败（exit=$code）")
                refreshList()
            } catch (t: Throwable) {
                appendLog("重新装配异常: ${t.message}")
            }
        }.start()
    }

    /** yjh051108/dsh-routing-suite 特殊适配：走 routing-suite.mjs。 */
    private fun runRoutingSuite() {
        Thread {
            try {
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
                refreshList()
            } catch (t: Throwable) {
                appendLog("routing-suite 异常: ${t.message}")
            }
        }.start()
    }

    /** 卸载：官方 dsh plugin --profile web remove <package>。 */
    private fun uninstall(name: String) {
        runDshPlugin(listOf("remove", name), "卸载 $name")
    }

    private fun baseEnv(): MutableMap<String, String> {
        val node = nodeDir
        val tools = File(filesDir, ".tools")
        val path = listOf(
            File(node, "bin").absolutePath,
            File(tools, "bin").absolutePath,
            File(tools, "lib/node_modules/.bin").absolutePath,
            "/system/bin", "/bin", "/usr/bin"
        ).joinToString(":")
        return mutableMapOf(
            "PATH" to path,
            "HOME" to filesDir.absolutePath,
            "LD_LIBRARY_PATH" to File(node, "lib").absolutePath,
            "TMPDIR" to File(filesDir, "tmp").absolutePath,
            "TMP" to File(filesDir, "tmp").absolutePath,
            "TEMP" to File(filesDir, "tmp").absolutePath,
            "OPENSSL_CONF" to "/dev/null"
        )
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

    private fun restartFlow() {
        appendLog(">> 重启 dsh flow（杀 node → 回控制台启动）…")
        Thread {
            runCatching {
                val pb = ProcessBuilder("/system/bin/sh", "-c",
                    "ps -A | grep node | awk '{print \$2}' | xargs -r kill")
                pb.redirectErrorStream(true)
                val p = pb.start()
                p.inputStream.bufferedReader().useLines { it.forEach { l -> appendLog("   $l") } }
                p.waitFor()
            }
            Thread.sleep(1500)
            runOnUiThread {
                startActivity(Intent(this, ConsoleActivity::class.java).putExtra("dsh", true))
                finish()
            }
        }.start()
    }
}