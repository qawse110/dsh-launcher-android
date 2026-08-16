package com.dsh.launcher

import android.os.Bundle
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
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
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        setContentView(buildUi())
        appendLine("== 内置命令控制台（基于 ProcessBuilder）==")
        handleIntentExtras()
    }

    /** 处理 intent extras（onCreate 与 onNewIntent 共用，支持复用 Activity 时执行新命令）。 */
    private fun handleIntentExtras() {
        val runNode = intent?.getBooleanExtra("node", false) ?: false
        val runDsh = intent?.getBooleanExtra("dsh", false) ?: false
        val cmd = intent?.getStringExtra("cmd")
        when {
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

        val headerCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE)
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
        val outputCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_ALT)
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
                        appendLine(">> Termux 环境就绪，打开终端…")
                    } catch (t: Throwable) {
                        appendLine("✗ Termux 准备失败：${t.message}，将回退系统 sh")
                        android.util.Log.e("Console", "termux ensure failed", t)
                    }
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
        val clearBtn = Ui.button(this, "清空", { sb.clear(); output.text = "" }, filled = false)
        val closeBtn = Ui.button(this, "退出", { finish() }, filled = false, color = Ui.DANGER)

        root.addView(rowOf(nodeBtn, termBtn, runBtn, pluginBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })
        root.addView(rowOf(updateBtn, clearBtn, closeBtn), LinearLayout.LayoutParams(
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
     * dsh 一键安装+启动流程（内嵌，避免 shell↔am 传长命令）。
     * 通过 ConsoleActivity 的 intent `--ez dsh true` 触发，供自动化/按钮调用。
     * 各阶段：
     *   1) 确保内置 node 解压
     *   2) 复制 assets 内 install-dsh.mjs + prebuilt.tgz（内置插件源）
     *   3) 官方 npm 安装/更新 @deepseek-ai/dsh 到 files/dsh-prefix，
     *      并用 `dsh plugin --profile web add` 装配内置插件
     *   4) 执行 stub-dsh.mjs（Android 兼容修复），启动 dsh web
     */
    private fun runDshFlow() {
        setState("启动 dsh 安装…")
        appendLine(">> 1/4 确保内置 Node 运行时…")
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
                fl("dsh 版本 v${DshUpdater.currentVersion(this)}")
                // 安装/更新统一交给 install-dsh.mjs 的 `npm install @deepseek-ai/dsh@latest`；
                // “更新”按钮通过 startUpdateCheck(force=true) 触发重启 flow 主动检查。
                val dshPrefix = File(filesDir, "dsh-prefix")
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

                fl(">> 3/4 官方 npm 安装/更新 dsh + dsh plugin 装配内置插件…")
                val installEnv = mapOf(
                    "HOME" to filesDir.absolutePath,
                    "NODE_BIN" to "$nodeDir/bin/node",
                    "NPM_BIN" to "$nodeDir/bin/npm",
                    "DSH_PREFIX" to dshPrefix.absolutePath,
                    "DSH_PROFILE" to "web",
                    "DSH_PREBUILT" to prebuilt.absolutePath,
                    "DSH_PLUGINS_DIR" to pluginsDir.absolutePath
                )
                val installExit = runCommandAndWait("$nodeDir/bin/node ${installScript.absolutePath}", installEnv)
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

                fl(">> 4/4 校验 dsh web…")
                startDshWeb(nodeDir, dshPrefix)
                fl("OK 4/4 dsh web started (http://127.0.0.1:3080)")
                // 保持 keepalive 常驻：web 进程是其子进程，避免被系统回收；用户可在主界面停止。
                // stopKeepAlive() 不能在此调用。
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

    private fun stopKeepAlive() {
        runCatching { stopService(Intent(this, BuildKeepAliveService::class.java)) }
    }

    /** 后台启动 dsh web（nohup 使其脱离本控制台进程）。端口已监听时跳过（幂等）。 */
    private fun startDshWeb(nodeDir: File, dshPrefix: File) {
        val cli = File(dshPrefix, "node_modules/@deepseek-ai/dsh/lib/bin.js")
        if (!cli.exists()) {
            appendLine("✗ 未找到官方 dsh CLI（安装可能未完成）")
            setState("出错")
            return
        }
        // 幂等：3080 已有监听则视为已启动
        if (isPortListening(3080)) {
            appendLine(">> dsh web 已在运行 (http://127.0.0.1:3080)")
            return
        }
        // 生成启动脚本到共享目录，用 sh 后台执行
        File(filesDir, "tmp").mkdirs()
        val launcher = File(getExternalFilesDir(null) ?: filesDir, "dsh-web.sh")
        launcher.parentFile?.mkdirs()
        launcher.writeText(
            "#!/system/bin/sh\n" +
            "export LD_LIBRARY_PATH=${nodeDir.absolutePath}/lib\n" +
            "export HOME=${filesDir.absolutePath}\n" +
            "export TMPDIR=${filesDir.absolutePath}/tmp\n" +
            "export OPENSSL_CONF=/dev/null\n" +
            "export PATH=${nodeDir.absolutePath}/bin:${File(filesDir, ".tools").absolutePath}/bin:/system/bin:/bin:/usr/bin\n" +
            "nohup ${nodeDir.absolutePath}/bin/node --expose-internals --import ${filesDir.absolutePath}/fs-register.mjs ${cli.absolutePath} web > ${filesDir.absolutePath}/dsh-web.log 2>&1 &\n" +
            "echo DSH_WEB_PID=$!\n"
        )
        launcher.setExecutable(true)
        runCommand("/system/bin/sh ${launcher.absolutePath}")
        appendLine(">> dsh web 后台启动，日志：${filesDir.absolutePath}/dsh-web.log")
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

    /** 杀掉全部 node 进程（web 与 flow 子进程一并结束），供更新后重启。 */
    private fun killAllNode() {
        runCatching {
            val pb = ProcessBuilder("/system/bin/sh", "-c", "ps -A | grep node | awk '{print \$2}' | xargs -r kill")
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
                    "/data/data/com.dsh.launcher/files/node/bin",
                    "/system/bin", "/bin", "/usr/bin"
                ).joinToString(":")
                env["HOME"] = "/data/data/com.dsh.launcher/files"
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
            output.text = sb.toString()
            // 自动滚到底部
            (output.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

/** dsh 安装/构建期间的前台保活服务，防止长时间 build 被系统回收。 */
class BuildKeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
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
        @Suppress("DEPRECATION")
        val n = builder
            .setContentTitle("dsh 安装中")
            .setContentText("正在构建 DeepSeek Harness，请稍候…")
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setOngoing(true)
            .build()
        startForeground(1, n)
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(1)
        }
    }
}

