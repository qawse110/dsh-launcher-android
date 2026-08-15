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
import java.net.HttpURLConnection
import java.net.URL

/**
 * 插件管理系统：内置插件一览（third_party，预构建随 prebuilt 分发）+ 在线安装/卸载。
 * 装配动作全部由 stub-dsh.mjs 的 CLI 模式完成（--wire-only/--add/--remove），
 * 本页只负责：下载源码包、调用 stub、展示状态与日志。
 */
class PluginManagerActivity : Activity() {

    companion object {
        // 内置插件（boot 时 stub 自动装配，不可卸载）
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
        const val PRESET_DESC = "思维模式路由预设（spec/react/weak + 近距离引导，agent-presets）"
        const val REPO_DIR = "plugin-repo"
    }

    private lateinit var listBox: LinearLayout
    private lateinit var input: EditText
    private lateinit var logView: TextView
    private val logSb = StringBuilder()
    private val nodeDir: File get() = NodeRuntime.ensureExtracted(this)

    private fun dshHome() = File(filesDir, "deepseek-harness-master")
    private fun thirdParty() = File(dshHome(), "third_party")
    private fun profilePatch() = File(filesDir, ".dsh/profiles/web/cordis.patch.yml")
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
            text = "内置插件随 app 自动装配；在线安装从 GitHub 拉取源码包（需含 cordis.patch.yml + 构建产物 lib/）"
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
            text = "下载并安装"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { installFromRepo() }
        }
        val wireBtn = Button(this).apply {
            text = "重新装配"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { runStub(listOf("--wire-only"), "重新装配") }
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

        appendLog("插件管理就绪（tar 内置 ${BUNDLED.size} 个 + $PRESET_DIR 预设）")
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
        val tp = thirdParty()
        listBox.removeAllViews()
        if (!tp.exists()) {
            listBox.addView(makeCard("（dsh 源树未就绪：先回控制台跑一次「执行 dsh」）", "提示", "", "—", emptyList()))
            return
        }
        val patchText = if (profilePatch().exists()) profilePatch().readText() else ""
        // profile patch 里已有的 entry id 集合（- id: <id>）
        val patchIds = Regex("(?:^|\\n)\\s*-\\s*id:\\s*(\\S+)").findAll(patchText)
            .map { it.groupValues[1] }.toSet()
        val tpDirs = tp.listFiles { f -> f.isDirectory }?.map { it.name }?.toSet() ?: emptySet()

        for (d in BUNDLED.sorted()) {
            val builtin = tpDirs.contains(d)
            val wired = isWired(d)
            val status = if (!builtin) "未内置（构建产物缺失）"
            else if (wired) "内置 · 已装配"
            else "内置 · 待装配（需重启 flow）"
            val ver = readVersion(d)
            listBox.addView(makeCard(d, BUNDLED_DESC[d] ?: "", ver, status, emptyList()))
        }
        // 路由预设
        val presetOk = File(presetsRoot(), PRESET_DIR).exists()
        listBox.addView(makeCard(
            PRESET_DIR, PRESET_DESC, "preset",
            if (presetOk) "已安装（agent-presets）" else "待装配（需重启 flow）", emptyList()))

        // 在线安装的插件（third_party 下非内置目录）
        val online = tpDirs - BUNDLED - PRESET_DIR
        for (d in online.sorted()) {
            val info = readPlugin(d) ?: continue
            val status = if (isWired(d) || isWired(info.id)) "已装配" else "已下载 · 未装配"
            listBox.addView(makeCard(d, info.desc, info.version, status, listOf("卸载" to { uninstall(d) })))
        }
    }

    data class PluginInfo(val id: String, val name: String, val desc: String, val version: String)

    /** 装配判定：直接查 stub 建立的 node_modules 链接（真实装配事实，不依赖 patch 解析）。 */
    private fun isWired(d: String): Boolean {
        val nm = File(filesDir, "deepseek-harness-master/node_modules")
        return File(nm, d).exists() || File(nm, "@dsh-external/$d").exists()
    }

    private fun readPlugin(dir: String): PluginInfo? {
        val dirF = File(thirdParty(), dir)
        val p = File(dirF, "package.json")
        if (!p.exists()) return null
        return try {
            val j = JSONObject(p.readText())
            val name = j.optString("name", dir)
            val ver = j.optString("version", "?")
            val desc = j.optString("description", "").take(80)
            // entry id 来自插件自带装配行（- insert: 下的 id）
            val patch = File(dirF, "cordis.patch.yml")
            val id = if (patch.exists()) {
                // 与 stub-dsh.mjs pluginInfo 同款正则（实测通过）
                Regex("- insert:\\s*\\n\\s*- id:\\s*(\\S+)")
                    .find(patch.readText())?.groupValues?.get(1) ?: dir
            } else dir
            PluginInfo(id, name, desc, ver)
        } catch (t: Throwable) { PluginInfo(dir, dir, "", "?") }
    }

    private fun readVersion(dir: String): String {
        val p = File(File(thirdParty(), dir), "package.json")
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
        appendLog(">> 下载 $repo …")
        Thread {
            try {
                val branch = fetchDefaultBranch(repo)
                appendLog("   默认分支: $branch")
                val dirName = repo.substringAfter('/').replace(Regex("[^A-Za-z0-9._-]"), "_")
                val repoDir = File(filesDir, REPO_DIR).apply { mkdirs() }
                val tgz = File(repoDir, "$dirName.tar.gz")
                val url = "https://codeload.github.com/$repo/tar.gz/refs/heads/$branch"
                appendLog("   GET $url")
                download(url, tgz)
                appendLog("   已下载 ${tgz.length() / 1024}KB → 调用 stub 解压装配…")
                runStub(listOf("--add", tgz.absolutePath, dirName), "安装 $dirName")
                refreshList()
            } catch (t: Throwable) {
                appendLog("下载/安装失败: ${t.message}")
            }
        }.start()
    }

    private fun parseRepo(raw: String): String? {
        var r = raw.trim().removeSuffix("/").removeSuffix(".git")
        if (r.startsWith("https://github.com/")) r = r.removePrefix("https://github.com/")
        else if (r.startsWith("http://github.com/")) r = r.removePrefix("http://github.com/")
        if (r.startsWith("github.com/")) r = r.removePrefix("github.com/")
        val seg = r.split("/")
        if (seg.size < 2 || seg[0].isEmpty() || seg[1].isEmpty()) return null
        return "${seg[0]}/${seg[1]}"
    }

    private fun fetchDefaultBranch(repo: String): String {
        return try {
            val api = URL("https://api.github.com/repos/$repo")
            val c = api.openConnection() as HttpURLConnection
            c.setRequestProperty("User-Agent", "DshLauncher/2.0")
            c.connectTimeout = 15000
            c.readTimeout = 20000
            if (c.responseCode == 200) {
                val body = c.inputStream.bufferedReader().readText()
                JSONObject(body).optString("default_branch", "main")
            } else "main"
        } catch (t: Throwable) { "main" }
    }

    private fun download(url: String, out: File) {
        val c = URL(url).openConnection() as HttpURLConnection
        c.setRequestProperty("User-Agent", "DshLauncher/2.0")
        c.instanceFollowRedirects = true
        c.connectTimeout = 20000
        c.readTimeout = 60000
        if (c.responseCode !in 200..299) throw RuntimeException("HTTP ${c.responseCode}")
        c.inputStream.use { ins -> out.outputStream().use { ous -> ins.copyTo(ous) } }
    }

    // ── stub CLI ──────────────────────────────────────────
    private fun runStub(args: List<String>, label: String) {
        appendLog(">> $label …")
        Thread {
            try {
                val stub = File(filesDir, "stub-dsh.mjs")
                try {
                    assets.open("stub-dsh.mjs").use { ins -> stub.outputStream().use { ous -> ins.copyTo(ous) } }
                } catch (t: Throwable) { appendLog("   WARN 无法刷新 stub: ${t.message}") }
                val node = File(File(nodeDir, "bin"), "node")
                val cmd = "${node.absolutePath} ${stub.absolutePath} ${args.joinToString(" ")}"
                appendLog("   $ ${cmd.replace(stub.absolutePath, "stub-dsh.mjs")}")
                val pb = ProcessBuilder("/system/bin/sh", "-c", cmd)
                pb.redirectErrorStream(true)
                val env = pb.environment()
                env["PATH"] = "${File(nodeDir, "bin")}:/system/bin:/bin"
                env["LD_LIBRARY_PATH"] = File(nodeDir, "lib").absolutePath
                env["HOME"] = filesDir.absolutePath
                env["TMPDIR"] = File(filesDir, "tmp").absolutePath
                env["OPENSSL_CONF"] = "/dev/null"
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
                appendLog(if (code == 0) "   ✓ $label 完成（exit=0）" else "   ✗ $label 失败（exit=$code）")
                refreshList()
            } catch (t: Throwable) {
                appendLog("$label 异常: ${t.message}")
            }
        }.start()
    }

    private fun uninstall(dir: String) {
        runStub(listOf("--remove", dir), "卸载 $dir")
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