package com.dsh.launcher

import android.os.Bundle
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import java.io.File
import kotlin.concurrent.thread

/**
 * 内置命令控制台（基于 Java ProcessBuilder，不依赖受限的 PTY 原生库）。
 *
 * 说明：libtermux.so 的 createSubprocess 在第三方 app 中受 Android seccomp
 * 限制，无法可靠 fork/exec shell，导致 PTY 终端黑屏。这里改用 ProcessBuilder，
 * 稳定启动 /system/bin/sh 或内置 Node，并实时回显 stdout/stderr。
 */
class ConsoleActivity : AppCompatActivity() {

    private lateinit var output: TextView
    private lateinit var input: EditText
    private lateinit var stateView: TextView
    private val sb = StringBuilder()

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        AppLog.init(this)
        setContentView(buildUi())
        appendLine("== 内置命令控制台（基于 ProcessBuilder）==")
        handleIntentExtras()
    }

    /** 处理 intent extras（onCreate 与 onNewIntent 共用，支持复用 Activity 时执行新命令）。 */
    private fun handleIntentExtras() {
        val runNode = intent?.getBooleanExtra("node", false) ?: false
        val runDsh = intent?.getBooleanExtra("dsh", false) ?: false
        val runDshInstall = intent?.getBooleanExtra("dsh_install", false) ?: false
        val runDshStart = intent?.getBooleanExtra("dsh_start", false) ?: false
        val cmd = intent?.getStringExtra("cmd")
        when {
            runDshInstall -> { appendLine(">> 触发 dsh 安装/更新（不启动 web）…"); AppLog.i("Console", "auto dsh install"); runDshFlow(installOnly = true) }
            runDshStart -> { appendLine(">> 触发 dsh 启动（不安装）…"); AppLog.i("Console", "auto dsh start"); runDshFlow(startOnly = true) }
            runDsh -> { appendLine(">> 触发 dsh 安装+启动…"); AppLog.i("Console", "auto dsh run"); runDshFlow() }
            runNode -> { appendLine(">> 触发内置 Node 解压+运行…"); AppLog.i("Console", "auto node run"); runNodeCmd() }
            !cmd.isNullOrBlank() -> {
                appendLine(">> " + cmd)
                AppLog.i("Console", "auto cmd: $cmd")
                runCommand(cmd)
            }
            else -> {
                appendLine("输入命令后回车执行，例如：")
                appendLine("  node --version")
                appendLine("  ls -la")
                appendLine("  echo hello")
            }
        }
    }

    /** 复用 Activity 时（同一进程再次 am start）接收新 intent 并执行。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntentExtras()
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }

        val headerCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        headerRow.addView(TextView(this).apply {
            text = "内置命令控制台"
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        stateView = TextView(this).apply {
            text = "状态：空闲"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
        }
        headerRow.addView(stateView)
        headerCard.addView(headerRow)

        root.addView(headerCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        output = TextView(this).apply {
            setTextColor(0xFFE0E0E0.toInt())
            textSize = 13f
            setTypeface(android.graphics.Typeface.MONOSPACE)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setLineSpacing(dp(2).toFloat(), 1f)
        }

        val scroll = ScrollView(this).apply {
            addView(output, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val outputCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_LOW, elevationDp = 0f)
        outputCard.addView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(outputCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ).apply { topMargin = dp(4) })

        input = EditText(this).apply {
            hint = "输入命令，回车执行"
            setTextColor(Ui.TEXT_PRIMARY)
            setHintTextColor(Ui.TEXT_MUTED)
            background = Ui.rounded(this@ConsoleActivity, Ui.SURFACE_INPUT, 12, Ui.OUTLINE)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            setOnEditorActionListener { _, _, _ ->
                execInput()
                true
            }
        }
        root.addView(input, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })

        fun rowOf(vararg buttons: View): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            buttons.forEachIndexed { index, button ->
                addView(button, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (index < buttons.lastIndex) rightMargin = dp(6)
                })
            }
        }

        val nodeBtn = Ui.button(this, "Node", { runNodeCmd() }, filled = false)
        val termBtn = Ui.button(this, "终端", {
            thread {
                if (!TermuxRuntime.isReady(this@ConsoleActivity)) {
                    appendLine(">> 准备内置 Termux 环境（首次约 10~60 秒）…")
                    try {
                        TermuxRuntime.ensureExtracted(this@ConsoleActivity) { msg -> appendLine(msg) }
                        appendLine(">> Termux 环境已就绪，检查 Harness 工具…")
                        TermuxRuntime.ensureHarnessTools(this@ConsoleActivity) { msg -> appendLine(msg) }
                        appendLine(">> 打开终端…")
                    } catch (t: Throwable) {
                        appendLine("✗ Termux 准备失败：${t.message}，将回退系统 sh")
                        android.util.Log.e("Console", "termux ensure failed", t)
                    }
                } else {
                    TermuxRuntime.ensureHarnessTools(this@ConsoleActivity) { msg -> appendLine(msg) }
                }
                runOnUiThread {
                    startActivity(Intent(this@ConsoleActivity, TerminalActivity::class.java))
                }
            }
        }, filled = false)
        val runBtn = Ui.button(this, "执行", { execInput() }, filled = true)
        val pluginBtn = Ui.button(this, "插件", {
            startActivity(Intent(this@ConsoleActivity, PluginManagerActivity::class.java))
        }, filled = false)
        val updateBtn = Ui.button(this, "更新", { startUpdateCheck(true) }, filled = false)
        val updateNextBtn = Ui.button(this, "更新 next", { startUpdateCheckNext(true) }, filled = false)
        val clearBtn = Ui.button(this, "清空", { sb.clear(); output.text = "" }, filled = false)
        val closeBtn = Ui.button(this, "退出", { finish() }, filled = false, color = Ui.DANGER)

        root.addView(rowOf(nodeBtn, termBtn, runBtn, pluginBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })
        root.addView(rowOf(updateBtn, updateNextBtn, clearBtn, closeBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })

        return root
    }

    private fun execInput() {
        val cmd = input.text.toString().trim()
        if (cmd.isNotEmpty()) {
            appendLine("$ $cmd")
            input.setText("")
            runCommand(cmd)
        }
    }

    /** 用内置 Node 运行时执行命令。 */
    private fun runNodeCmd() {
        appendLine(">> 正在准备内置 Node 运行时…")
        setState("正在解压/准备 Node…")
        thread {
            try {
                val nodeDir = NodeRuntime.ensureExtracted(this)
                val cmd = "${NodeRuntime.nodeEnvPrefix(this)} $nodeDir/bin/node --version"
                appendLine("$ " + cmd.replace(";", " && "))
                runCommand(cmd)
            } catch (t: Throwable) {
                appendLine("✗ Node 准备失败：${t.message}")
                setState("出错")
            }
        }
    }

    /**
     * dsh 安装/启动流程（内嵌，避免 shell↔am 传长命令）。
     * 通过 ConsoleActivity 的 intent 触发：
     *   `--ez dsh true`          安装+启动（兼容旧入口：通知/插件管理/am 快捷方式）
     *   `--ez dsh_install true`  仅安装/更新（npm + 插件装配，不启动 web）
     *   `--ez dsh_start true`    仅启动（跳安装，要求已安装）
     * 各阶段：
     *   1) 确保内置 node 解压
     *   2) 复制 assets 内 install-dsh.mjs + prebuilt.tgz（内置插件源）
     *   3) 官方 npm 安装/更新 @deepseek-ai/dsh 到 files/dsh-prefix，
     *      并用 `dsh plugin --profile web add` 装配内置插件
     *   4) 执行 stub-dsh.mjs（Android 兼容修复），启动 dsh web
     */
    private fun runDshFlow(installOnly: Boolean = false, startOnly: Boolean = false) {
        setState(if (installOnly) "安装/更新中…" else if (startOnly) "启动 dsh…" else "启动 dsh 安装…")
        appendLine(if (installOnly) ">> 安装/更新模式（完成后不启动 web）…"
                   else if (startOnly) ">> 仅启动模式（跳过安装/装配）…"
                   else ">> 安装+启动模式…")
        // 核心日志写私有目录（无需存储权限，run-as 可读）；共享目录尽力而为
        val flowLog = File(filesDir, "dsh-flow.log")
        val sharedFlowLog = File("/sdcard/Download/DshLauncher/dsh-flow.log")
        fun fl(msg: String) {
            runCatching { flowLog.appendText("${System.currentTimeMillis()} $msg\n") }
            runCatching { sharedFlowLog.appendText("${System.currentTimeMillis()} $msg\n") }
            appendLine(msg)
        }
        thread {
            try {
                startKeepAlive()
                val nodeDir = NodeRuntime.ensureExtracted(this)
                flowLog.parentFile?.mkdirs()
                runCatching { flowLog.writeText("") }
                fl("OK 1/4 node=$nodeDir")
                val dshPrefix = File(filesDir, "dsh-prefix")
                val dshCli = File(dshPrefix, "node_modules/@deepseek-ai/dsh/lib/bin.js")

                // 仅启动模式：不安装，直接快速启动（要求已安装）
                if (startOnly) {
                    if (!dshCli.exists()) {
                        fl("FAIL 尚未安装 dsh（$dshCli 不存在），请先点「安装 / 更新 DSH」")
                        setState("未安装")
                        return@thread
                    }
                    if (quickStartWeb(nodeDir, dshPrefix, ::fl)) {
                        fl("OK 启动完成 (http://127.0.0.1:3080)")
                        setState("运行中")
                        BuildKeepAliveService.updateRunning(this)
                        ensureBridge()
                    } else {
                        fl("FAIL 启动：dsh web 未就绪（见上方日志尾部）")
                        setState("启动失败")
                    }
                    return@thread
                }

                // 非安装模式且 dsh 已安装：快速启动，跳过 npm 更新/插件装配/Termux 全量准备
                if (!installOnly && dshCli.exists()) {
                    fl(">> 快速启动：已安装 dsh v${DshUpdater.currentVersion(this)}，跳过 npm/插件装配…")
                    if (quickStartWeb(nodeDir, dshPrefix, ::fl)) {
                        fl("OK 快速启动完成 (http://127.0.0.1:3080)")
                        setState("运行中")
                        BuildKeepAliveService.updateRunning(this)
                    } else {
                        fl("FAIL 快速启动：dsh web 未就绪（见上方日志尾部）")
                        setState("启动失败")
                    }
                    return@thread
                }
                fl(">> 1.5/4 准备内置 Termux（bash/coreutils + git/python）…")
                try {
                    TermuxRuntime.ensureExtracted(this) { msg -> fl(msg) }
                    TermuxRuntime.ensureHarnessTools(this) { msg -> fl(msg) }
                    fl("OK 1.5/4 termux ready (bash + git + python)")
                } catch (t: Throwable) {
                    fl("WARN 1.5/4 termux prepare failed: ${t.message}（继续 dsh 安装，dsh bash 工具可能不可用）")
                }
                fl("dsh 版本 v${DshUpdater.currentVersion(this)}")
                // 安装/更新统一交给 install-dsh.mjs 的 `npm install @deepseek-ai/dsh@latest`；
                // 主界面「安装 / 更新 DSH」即此路径（与快速启动互斥：更新后不会自动启动 web）。
                val pluginsDir = File(filesDir, "plugins")

                fl(">> 2/4 复制官方安装脚本与内置插件源…")
                val installScript = File(filesDir, "install-dsh.mjs")
                try {
                    assets.open("install-dsh.mjs").use { input ->
                        installScript.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (t: Throwable) {
                    fl("FAIL 2/4 assets copy install-dsh.mjs: ${t.message}")
                    setState("出错")
                    return@thread
                }
                val prebuilt = File(filesDir, "prebuilt.tgz")
                try {
                    assets.open("prebuilt.tgz").use { input ->
                        prebuilt.outputStream().use { output -> input.copyTo(output) }
                    }
                    fl("  内置插件源 ${prebuilt.length() / 1024 / 1024}MB")
                } catch (t: Throwable) {
                    fl("  assets 无 prebuilt.tgz：${t.message}")
                }
                val extraPluginsDir = File(filesDir, "extra-plugins")
                try {
                    copyAssetDir("extra-plugins", extraPluginsDir)
                    val count = extraPluginsDir.walkTopDown().count { it.isFile }
                    fl("  额外桥接插件源 ${count} 个文件")
                } catch (t: Throwable) {
                    fl("  WARN assets 无 extra-plugins：${t.message}")
                }

                fl(">> 3/4 官方 npm 安装/更新 dsh + dsh plugin 装配内置插件…")
                val tag = getSharedPreferences(CONSOLE_PREFS, Context.MODE_PRIVATE)
                    .getString("dsh_install_tag", "latest") ?: "latest"
                val installEnv = mapOf(
                    "HOME" to filesDir.absolutePath,
                    "NODE_BIN" to "$nodeDir/bin/node",
                    "NPM_BIN" to "$nodeDir/bin/npm",
                    "DSH_PREFIX" to dshPrefix.absolutePath,
                    "DSH_PROFILE" to "web",
                    "DSH_PREBUILT" to prebuilt.absolutePath,
                    "DSH_PLUGINS_DIR" to pluginsDir.absolutePath,
                    "DSH_EXTRA_PLUGINS_SRC" to extraPluginsDir.absolutePath,
                    "DSH_TAG" to tag
                )
                if (tag != "latest") fl("  （安装 dist-tag=$tag 预发布线）")
                val installExit = runCommandAndWait("$nodeDir/bin/node ${installScript.absolutePath}", installEnv)
                // 一次性安装 tag 已消费（无论成败），复位避免残留 next 影响下次普通安装
                getSharedPreferences(CONSOLE_PREFS, Context.MODE_PRIVATE)
                    .edit().remove("dsh_install_tag").apply()
                if (installExit != 0) {
                    fl("FAIL 3/4 install script exit=$installExit，详见 install_log.txt")
                    setState("出错")
                    return@thread
                }
                if (!File(dshPrefix, "node_modules/@deepseek-ai/dsh/lib/bin.js").exists()) {
                    fl("FAIL 3/4 官方 dsh CLI 未安装到 $dshPrefix")
                    setState("出错")
                    return@thread
                }
                fl("OK 3/4 dsh + builtin plugins installed")

                fl(">> 3.5/4 Android 兼容修复…")
                val stubScript = File(filesDir, "stub-dsh.mjs")
                try {
                    assets.open("stub-dsh.mjs").use { input ->
                        stubScript.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (t: Throwable) {
                    fl("FAIL 3.5/4 assets copy stub-dsh.mjs: ${t.message}")
                }
                // SELinux 禁止 app 对 data 文件硬链接；dsh session 首次落盘用 link()
                // 发布。通过 Node loader 把 node:fs/promises 的 link 重定向为 rename 兼容实现。
                for (name in listOf("fs-register.mjs", "fs-loader.mjs", "fs-promises-compat.mjs")) {
                    try {
                        assets.open(name).use { input ->
                            File(filesDir, name).outputStream().use { output -> input.copyTo(output) }
                        }
                    } catch (t: Throwable) {
                        fl("WARN assets copy $name: ${t.message}")
                    }
                }
                runCommandAndWait(
                    "$nodeDir/bin/node ${stubScript.absolutePath}",
                    mapOf(
                        "HOME" to filesDir.absolutePath,
                        "NODE_DIR" to nodeDir.absolutePath,
                        "DSH_PREFIX" to dshPrefix.absolutePath,
                        "DSH_PROFILE" to "web"
                    )
                )

                // 仅安装/更新模式：到此结束，不启动 web（不置 running，watchdog 不会拉起）
                if (installOnly) {
                    fl("OK 安装/更新完成（未启动 web，回主界面点「启动 DSH」即可）")
                    setState("安装完成")
                    startKeepAlive()
                    return@thread
                }

                fl(">> 4/4 校验 dsh web…")
                if (startDshWeb(nodeDir, dshPrefix)) {
                    fl("OK 4/4 dsh web started (http://127.0.0.1:3080)")
                    setState("运行中")
                    BuildKeepAliveService.updateRunning(this)
                    ensureBridge()
                } else {
                    fl("FAIL 4/4 dsh web 启动失败（见上方日志尾部）")
                    setState("出错")
                    return@thread
                }
                // 保持 keepalive 常驻：web 进程是其子进程，避免被系统回收；用户可在主界面停止。
            } catch (t: Throwable) {
                fl("FAIL: ${t.message}")
                setState("出错")
            }
        }
    }


    /** 前台服务保活，防止长时间 build 被系统回收。 */
    private fun startKeepAlive() {
        try {
            val i = Intent(this, BuildKeepAliveService::class.java)
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
            AppLog.i("Console", "keepalive started")
        } catch (t: Throwable) {
            AppLog.e("Console", "keepalive start failed: ${t.message}")
        }
    }

    /** dsh 启动成功后联动拉起状态桥接服务（悬浮窗自动出现；尊重「悬浮窗显示」开关）。 */
    private fun ensureBridge() {
        if (!getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
                .getBoolean("overlay_enabled", true)
        ) return
        runCatching { StatusBridgeService.start(this) }
            .onSuccess { AppLog.i("Console", "bridge started for overlay") }
            .onFailure { AppLog.e("Console", "bridge start failed: ${it.message}") }
    }

    /** 快速启动：同步兼容脚本（fs-register/fs-loader/fs-promises/stub）→ 执行 stub → 启动 web。 */
    private fun quickStartWeb(nodeDir: File, dshPrefix: File, fl: (String) -> Unit): Boolean {
        for (name in listOf("fs-register.mjs", "fs-loader.mjs", "fs-promises-compat.mjs", "stub-dsh.mjs")) {
            val target = File(filesDir, name)
            try {
                assets.open(name).use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                }
            } catch (t: Throwable) {
                fl("WARN copy $name: ${t.message}")
            }
        }
        val stubScript = File(filesDir, "stub-dsh.mjs")
        if (stubScript.exists()) {
            runCommandAndWait(
                "$nodeDir/bin/node ${stubScript.absolutePath}",
                mapOf(
                    "HOME" to filesDir.absolutePath,
                    "NODE_DIR" to nodeDir.absolutePath,
                    "DSH_PREFIX" to dshPrefix.absolutePath,
                    "DSH_PROFILE" to "web"
                )
            )
        } else {
            fl("WARN 未找到 stub-dsh.mjs，继续尝试启动 web")
        }
        fl(">> 启动 dsh web…")
        return startDshWeb(nodeDir, dshPrefix)
    }

    /** 后台启动 dsh web 并等待 HTTP 就绪。端口已有监听但无响应时清场重启（幂等但不再盲信）。 */
    private fun startDshWeb(nodeDir: File, dshPrefix: File): Boolean {
        val cli = File(dshPrefix, "node_modules/@deepseek-ai/dsh/lib/bin.js")
        if (!cli.exists()) {
            appendLine("✗ 未找到官方 dsh CLI（安装可能未完成）")
            setState("出错")
            return false
        }
        // 幂等：3080 已有监听 → 只有 HTTP 真正响应才算已启动；
        // 残留（端口被占但 web 不响应）视为脏状态，先清理再重启。
        if (isPortListening(3080)) {
            if (waitForWebReady(5_000)) {
                appendLine(">> dsh web 已在运行 (http://127.0.0.1:3080)")
                return true
            }
            appendLine(">> 端口 3080 被残留进程占用但 web 无响应，清理后重新启动…")
            killAllNode()
            Thread.sleep(1500)
        }
        // 生成启动脚本到共享目录，用 sh 后台执行
        File(filesDir, "tmp").mkdirs()
        val launcher = File(getExternalFilesDir(null) ?: filesDir, "dsh-web.sh")
        launcher.parentFile?.mkdirs()
        val termuxUsr = TermuxRuntime.prefix(this).absolutePath
        val termuxReady = TermuxRuntime.isBashReady(this)
        val termuxPath = if (termuxReady) "$termuxUsr/bin:$termuxUsr/bin/applets:$termuxUsr/local/bin:" else ""
        val ldLibrary = if (termuxReady) "${nodeDir.absolutePath}/lib:$termuxUsr/lib" else "${nodeDir.absolutePath}/lib"
        val nodeCmd = "${nodeDir.absolutePath}/bin/node --expose-internals --import ${filesDir.absolutePath}/fs-register.mjs ${cli.absolutePath} web"
        launcher.writeText(
            "#!/system/bin/sh\n" +
            "export LD_LIBRARY_PATH=$ldLibrary\n" +
            "export HOME=${filesDir.absolutePath}\n" +
            "export TMPDIR=${filesDir.absolutePath}/tmp\n" +
            "export OPENSSL_CONF=/dev/null\n" +
            "export TERM=xterm-256color\n" +
            (if (termuxReady) "export PREFIX=$termuxUsr\n" else "") +
            "export PATH=${nodeDir.absolutePath}/bin:${termuxPath}${File(filesDir, ".tools").absolutePath}/bin:/system/bin:/bin:/usr/bin\n" +
            "if command -v nohup >/dev/null 2>&1; then\n" +
            "  nohup $nodeCmd > ${filesDir.absolutePath}/dsh-web.log 2>&1 &\n" +
            "else\n" +
            "  $nodeCmd > ${filesDir.absolutePath}/dsh-web.log 2>&1 &\n" +
            "fi\n" +
            "echo DSH_WEB_PID=$!\n"
        )
        launcher.setExecutable(true)
        runCommandAndWait("/system/bin/sh ${launcher.absolutePath}")
        appendLine(">> dsh web 已后台启动，等待 web 就绪（http://127.0.0.1:3080）…")
        return waitForWebReady(90_000)
    }

    /** 检测本机端口是否已有监听（用于幂等启动）。 */
    private fun isPortListening(port: Int): Boolean = try {
        java.net.ServerSocket().use { s ->
            s.reuseAddress = false
            s.bind(java.net.InetSocketAddress("127.0.0.1", port))
            false
        }
    } catch (e: java.io.IOException) {
        true
    }

    /** 轮询等待 dsh web 的 HTTP 真正可访问，超时后打印 dsh-web.log 尾部。 */
    private fun waitForWebReady(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastLog = 0L
        while (System.currentTimeMillis() < deadline) {
            if (httpResponds(3080)) return true
            val now = System.currentTimeMillis()
            if (now - lastLog >= 5000) {
                lastLog = now
                appendLine("   等待 dsh web 就绪…（剩余 ${(deadline - now) / 1000}s）")
            }
            Thread.sleep(500)
        }
        appendLine("✗ dsh web 未在 ${timeoutMs / 1000} 秒内就绪，日志尾部：")
        appendLogTail(File(filesDir, "dsh-web.log"), 25)
        return false
    }

    private fun httpResponds(port: Int): Boolean = try {
        val conn = java.net.URL("http://127.0.0.1:$port/").openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 800
        conn.readTimeout = 800
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..399
    } catch (e: Exception) {
        false
    }

    private fun appendLogTail(file: java.io.File, maxLines: Int) {
        try {
            if (!file.exists()) {
                appendLine("   （无日志文件：${file.path}）")
                return
            }
            val lines = file.readText().trim().lines()
            val tail = if (lines.size > maxLines) lines.takeLast(maxLines) else lines
            for (line in tail) appendLine("   | $line")
        } catch (t: Throwable) {
            appendLine("   （读取日志失败：${t.message}）")
        }
    }

    /** 通过 ProcessBuilder 执行命令，实时回显输出。 */
    private fun runCommand(raw: String) {
        setState("运行中…")
        AppLog.i("Console", "cmd: $raw | env LD_LIBRARY_PATH=" + File(filesDir, "node/lib").absolutePath)
        thread {
            // 用户命令默认走内置 Termux bash；首次自动解压 bootstrap
            if (!TermuxRuntime.isReady(this)) {
                appendLine(">> 首次使用内置 Termux：正在解压官方 bootstrap（约 30MB，10~60 秒）…")
                try {
                    TermuxRuntime.ensureExtracted(this) { msg -> appendLine(msg) }
                    appendLine(">> Termux 环境已就绪（bash + coreutils + apt 等）")
                } catch (t: Throwable) {
                    appendLine("✗ Termux 环境准备失败（回退系统 sh）：${t.message}")
                    android.util.Log.e("Console", "termux ensure failed", t)
                    setState("出错")
                    return@thread
                }
            }
            TermuxRuntime.ensureHarnessTools(this) { msg -> appendLine(msg) }
            runCommandAndWait(raw, termux = true)
        }
    }

    /**
     * 主动检查 dsh 更新（「更新」按钮，force=true 忽略 6h 间隔）。
     * 发现新版本时杀掉 node 进程并重启 flow，由 install-dsh.mjs 执行 npm 官方更新。
     */
    private fun startUpdateCheck(force: Boolean, onLog: ((String) -> Unit)? = null) {
        val log: (String) -> Unit = onLog ?: { appendLine(it) }
        thread {
            val version = DshUpdater.checkRemote(this, force, log)
            if (version != null) {
                log("发现 dsh v$version，重启流程执行 npm 官方更新…")
                Thread.sleep(3_000)
                killAllNode()
                runOnUiThread { runDshFlow() }
            }
        }
    }

    /**
     * 更新到 next 预发布线（「更新 next」按钮）：检查 dist-tag=next，
     * 有更新则置一次性安装 tag=next 并重启安装流程（install-dsh.mjs 按 DSH_TAG 安装）。
     * 安装完成后 tag 自动复位为 latest。
     */
    private fun startUpdateCheckNext(force: Boolean, onLog: ((String) -> Unit)? = null) {
        val log: (String) -> Unit = onLog ?: { appendLine(it) }
        thread {
            val version = DshUpdater.checkRemoteNext(this, force, log)
            if (version != null) {
                log("发现 dsh 预发布 v$version（next），重启流程安装…")
                getSharedPreferences(CONSOLE_PREFS, Context.MODE_PRIVATE)
                    .edit().putString("dsh_install_tag", "next").apply()
                Thread.sleep(3_000)
                killAllNode()
                runOnUiThread { runDshFlow() }
            } else {
                log("next 线暂无更新（或已是最新预发布版）")
            }
        }
    }

    /** 杀掉全部 node 进程（web 与 flow 子进程一并结束），供更新后重启。 */
    private fun killAllNode() {
        runCatching {
            // 用 [n]ode 避免 grep 匹配到自身；不用 xargs -r，兼容 Android toybox
            val pb = ProcessBuilder(
                "/system/bin/sh", "-c",
                "ps -A | grep '[n]ode' | awk '{print \$2}' | while read pid; do kill \"\$pid\" 2>/dev/null; done"
            )
            pb.redirectErrorStream(true)
            val p = pb.start()
            p.inputStream.bufferedReader().useLines { it.forEach { line -> appendLine(line) } }
            p.waitFor()
            AppLog.i("Console", "node processes killed")
        }
    }

    /** 同步执行命令（阻塞直到结束），返回退出码；输出实时回显。 */
    private fun runCommandAndWait(raw: String, extraEnv: Map<String, String> = emptyMap(), termux: Boolean = false): Int {
        setState("运行中…")
        AppLog.i("Console", "cmd: $raw")
        val termuxReady = termux && TermuxRuntime.isBashReady(this)
        val wantsWrite = termuxReady && looksLikePackageInstall(raw)
        return try {
            val useTermux = termuxReady
            // 用户命令用内置 Termux bash；内部 flow 命令仍用系统 sh（避免自动解压拖慢 dsh）
            val shell = if (useTermux) TermuxRuntime.bashPath(this).absolutePath else "/system/bin/sh"
            if (wantsWrite) {
                appendLine(">> 检测到安装类命令：临时放开 bin/lib/share 写权限…")
                TermuxRuntime.setRuntimeWritable(this, true)
            }
            val pb = ProcessBuilder(shell, "-c", raw)
            pb.redirectErrorStream(true)
            val env = pb.environment()
            if (useTermux) {
                val usr = TermuxRuntime.prefix(this).absolutePath
                val home = TermuxRuntime.home(this).absolutePath
                val tmp = TermuxRuntime.tmp(this).absolutePath
                env["PREFIX"] = usr
                env["PATH"] = listOf(
                    "$usr/bin", "$usr/bin/applets", "$usr/local/bin",
                    File(filesDir, "node/bin").absolutePath,
                    "/system/bin", "/bin", "/usr/bin"
                ).joinToString(":")
                env["HOME"] = home
                env["TERM"] = "xterm-256color"
                env["LANG"] = "C.UTF-8"
                env["LD_LIBRARY_PATH"] = "$usr/lib"
                env["TMPDIR"] = tmp
                env.remove("LD_PRELOAD")
                env["OPENSSL_CONF"] = "/dev/null"
            } else {
                env["PATH"] = listOf(
                    File(filesDir, "node/bin").absolutePath,
                    "/system/bin", "/bin", "/usr/bin"
                ).joinToString(":")
                env["HOME"] = filesDir.absolutePath
                env["TERM"] = "xterm-256color"
                env["LD_LIBRARY_PATH"] = File(filesDir, "node/lib").absolutePath
                env["TMPDIR"] = File(filesDir, "tmp").absolutePath
                env["OPENSSL_CONF"] = "/dev/null"
            }
            extraEnv.forEach { (k, v) -> env[k] = v }

            val proc = pb.start()
            // 实时逐行回显
            proc.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    appendLine(line)
                    AppLog.i("ConsoleOut", line)
                }
            }
            val exit = proc.waitFor()
            AppLog.i("Console", "exit code: $exit")
            setState("完成（退出码 $exit）")
            appendLine("[退出码: $exit]")
            appendLine("")
            exit
        } catch (e: Exception) {
            AppLog.e("Console", "cmd failed: " + (e.message ?: e.toString()))
            setState("出错")
            appendLine("[执行失败: ${e.message}]")
            -1
        } finally {
            if (wantsWrite) {
                runCatching { TermuxRuntime.setRuntimeWritable(this, false) }
                appendLine(">> 安装命令结束，已恢复 bin/lib/share 只读（W^X 保护）")
            }
        }
    }

    /** 判断命令是否可能写入 bin/lib/share（apt/pkg/dpkg 安装类），用于临时放开 W^X。 */
    private fun looksLikePackageInstall(raw: String): Boolean {
        val lc = raw.lowercase()
        return Regex("""\b(apt|apt-get|pkg)\b[^\n;&]*\b(install|reinstall|upgrade|dist-upgrade)\b""").containsMatchIn(lc) ||
            Regex("""\bdpkg\b[^\n;&]*\b(-i|--install)\b""").containsMatchIn(lc)
    }

    private fun setState(s: String) {
        runOnUiThread { stateView.text = "状态：$s" }
    }

    private fun appendLine(line: String) {
        runOnUiThread {
            sb.append(line).append("\n")
            // 防止长时间运行输出无限增长导致 UI 卡顿/内存膨胀：只保留末尾约 120K 字符
            if (sb.length > 240_000) {
                sb.delete(0, sb.length - 120_000)
            }
            output.text = sb.toString()
            // 自动滚到底部
            (output.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun copyAssetDir(assetPath: String, dest: File) {
        val children = assets.list(assetPath) ?: return
        dest.mkdirs()
        for (name in children) {
            val childAsset = "$assetPath/$name"
            val childDest = File(dest, name)
            if (assets.list(childAsset) != null) {
                copyAssetDir(childAsset, childDest)
            } else {
                childDest.parentFile?.mkdirs()
                assets.open(childAsset).use { input ->
                    childDest.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

/** dsh 安装/构建期间的前台保活服务，防止长时间 build 被系统回收。 */
class BuildKeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val running = prefs().getBoolean(KEY_RUNNING, false)
        startForeground(
            1,
            buildNotification(
                if (running) "dsh 运行中" else "dsh 安装中",
                if (running) "dsh 正在后台运行，点击可进入管理" else "正在构建 DeepSeek Harness，请稍候…"
            )
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_UPDATE_RUNNING) {
            prefs().edit().putBoolean(KEY_RUNNING, true).apply()
            startForeground(
                1,
                buildNotification("dsh 运行中", "dsh 正在后台运行，点击可进入管理")
            )
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(1)
        }
    }

    private fun prefs() = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun buildNotification(title: String, text: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val builder: Notification.Builder =
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(
                    "dsh", "dsh 服务", NotificationManager.IMPORTANCE_LOW
                )
                nm.createNotificationChannel(ch)
                Notification.Builder(this, "dsh")
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
        return builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_UPDATE_RUNNING = "com.dsh.launcher.action.BUILD_KEEPALIVE_RUNNING"
        private const val PREFS_NAME = "dsh_keepalive"
        private const val KEY_RUNNING = "running"
        private const val CONSOLE_PREFS = "dsh_console"

        fun updateRunning(context: Context) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_RUNNING, true).apply()
            val intent = Intent(context, BuildKeepAliveService::class.java)
                .setAction(ACTION_UPDATE_RUNNING)
            runCatching {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }
        }

        fun markStopped(context: Context) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_RUNNING, false).apply()
        }
    }
}

