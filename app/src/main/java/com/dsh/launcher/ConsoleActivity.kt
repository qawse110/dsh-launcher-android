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
import android.widget.Button
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
            setBackgroundColor(0xFF0B0B0F.toInt())
        }

        output = TextView(this).apply {
            setTextColor(0xFFE0E0E0.toInt())
            textSize = 13f
            setTypeface(android.graphics.Typeface.MONOSPACE)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setLineSpacing(dp(2).toFloat(), 1f)
        }

        val scroll = ScrollView(this).apply {
            addView(output, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        stateView = TextView(this).apply {
            text = "状态：空闲"
            textSize = 12f
            setTextColor(0xFF9A9A9A.toInt())
            setPadding(dp(12), dp(8), dp(12), dp(4))
        }

        input = EditText(this).apply {
            hint = "输入命令，回车执行"
            setTextColor(0xFFFFFFFF.toInt())
            setHintTextColor(0xFF888888.toInt())
            setBackgroundColor(0xFF20242D.toInt())
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnEditorActionListener { _, _, _ ->
                execInput()
                true
            }
        }

        val runBtn = Button(this).apply {
            text = "执行"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { execInput() }
        }
        val nodeBtn = Button(this).apply {
            text = "Node"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { runNodeCmd() }
        }
        val updateBtn = Button(this).apply {
            text = "更新"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { startUpdateCheck(true) }
        }
        val pluginBtn = Button(this).apply {
            text = "插件"
            textSize = 14f
            isAllCaps = false
            setOnClickListener {
                startActivity(Intent(this@ConsoleActivity, PluginManagerActivity::class.java))
            }
        }
        val clearBtn = Button(this).apply {
            text = "清空"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { sb.clear(); output.text = "" }
        }
        val closeBtn = Button(this).apply {
            text = "退出"
            textSize = 14f
            isAllCaps = false
            setOnClickListener { finish() }
        }

        val termBtn = Button(this).apply {
            text = "终端"
            textSize = 14f
            isAllCaps = false
            setOnClickListener {
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
            }
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(nodeBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(termBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(runBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(pluginBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(updateBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(clearBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(closeBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        root.addView(stateView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
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
     * 各阶段用短命令经 runCommand 逐段执行：
     *   1) 确保内置 node 解压
     *   2) 确保 harness 源码：优先 /sdcard/Download/DshLauncher/deepseek-harness-master.zip
     *      （adb push 预置），否则从网络下载（多源 fallback），解压到私有目录
     *   3) node 执行 assets 内置 install-dsh.mjs（pnpm install + build:lib + build:web），
     *      完成后执行 stub-dsh.mjs（原生模块 stub + 启动 web），日志写共享目录
     *   4) 校验 web 进程/端口，启动 dsh web
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
                fl("dsh 版本 v${DshUpdater.currentVersion(this)}" +
                    if (DshUpdater.hasPendingUpdate(this)) "（已下载更新，本次应用）" else "")

                // 自动更新检查：无待应用更新且到检查周期时，后台检查/下载；
                // 下载完成后重启流程（新包在下次启动时优先解压）。
                if (!DshUpdater.hasPendingUpdate(this)) {
                    startUpdateCheck(false) { msg -> fl(msg) }
                }

                val dshHome = File(filesDir, "deepseek-harness-master")
                if (!File(dshHome, "package.json").exists()) {
                    fl(">> 2/4 获取 harness 源码…")
                    if (!ensureHarnessSource(dshHome) { fl(it) }) {
                        fl("FAIL 2/4 harness source not ready")
                        setState("出错")
                        return@thread
                    }
                } else {
                    fl("OK 2/4 harness source exists: $dshHome")
                }

                fl(">> 3/4 pnpm install + build (long, 5-30 分钟)…")
                val installScript = File(filesDir, "install-dsh.mjs")
                try {
                    assets.open("install-dsh.mjs").use { input ->
                        installScript.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (t: Throwable) {
                    fl("FAIL 3/4 assets copy install-dsh.mjs: ${t.message}")
                    setState("出错")
                    return@thread
                }
                // 同步等待安装完成（install-dsh.mjs 内部 pnpm install + build）
                // 待应用更新包优先；否则回退 assets 内置包
                val prebuilt = if (DshUpdater.hasPendingUpdate(this)) {
                    fl("  使用自动更新包（${DshUpdater.pendingUpdateFile(this).length() / 1024 / 1024}MB）")
                    DshUpdater.pendingUpdateFile(this)
                } else {
                    val apk = File(filesDir, "prebuilt.tgz")
                    try {
                        assets.open("prebuilt.tgz").use { input ->
                            apk.outputStream().use { output -> input.copyTo(output) }
                        }
                        fl("  prebuilt ${apk.length() / 1024 / 1024}MB")
                    } catch (t: Throwable) {
                        fl("  assets 无 prebuilt.tgz：${t.message}（将退化为设备端构建）")
                    }
                    apk
                }
                val installEnv = mapOf("DSH_PREBUILT" to prebuilt.absolutePath)
                val installExit = runCommandAndWait("$nodeDir/bin/node ${installScript.absolutePath}", installEnv)
                if (installExit != 0) {
                    fl("FAIL 3/4 install script exit=$installExit，详见 install_log.txt")
                } else if (!File(dshHome, "apps/cli/lib/bin.js").exists() &&
                    !File(dshHome, "apps/web/dist").exists()) {
                    fl("WARN 3/4 build 产物缺失（install 成功但产物不在预期路径）")
                } else {
                    fl("OK 3/4 install+build finished")
                    // 更新包已成功解压应用——删除 pending，避免下次重复解压
                    if (DshUpdater.hasPendingUpdate(this)) {
                        DshUpdater.pendingUpdateFile(this).delete()
                        fl("自动更新已应用，删除待应用包")
                    }
                }

                fl(">> 3.5/4 stub fixup + 首次启动 web…")
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
                runCommandAndWait("$nodeDir/bin/node ${stubScript.absolutePath}")

                fl(">> 4/4 校验 dsh web…")
                // stub 已用 nohup 启动 web，这里再补一次直启（幂等：端口占用时跳过）
                startDshWeb(nodeDir)
                fl("OK 4/4 dsh web started (http://127.0.0.1:3080)")
                // 保持 keepalive 常驻：web 进程是其子进程，避免被系统回收；用户可在主界面停止。
                // stopKeepAlive() 不能在此调用。
            } catch (t: Throwable) {
                fl("FAIL: ${t.message}")
                setState("出错")
            }
        }
    }

    /**
     * 确保 harness 源码就绪，优先级：
     *  1) APK assets 内置 zip（零权限零网络，推荐）
     *  2) /sdcard/Download/DshLauncher/deepseek-harness-master.zip（adb push 预置）
     *  3) 网络下载（多源 fallback：GitHub 直连 → ghproxy 加速）
     * 下载/解压后校验 package.json。
     */
    private fun ensureHarnessSource(dshHome: File, fl: (String) -> Unit): Boolean {
        val zipCandidates = mutableListOf<File>()
        // 1) assets 内置（优先，零权限零网络）
        fl("  检查 APK assets 内置源码包…")
        try {
            val out = File(filesDir, "harness-source.zip")
            assets.open("harness/deepseek-harness-master.zip").use { input ->
                out.outputStream().use { output -> input.copyTo(output) }
            }
            if (out.length() > 100_000) {
                zipCandidates.add(out)
                fl("  内置源码包 ${out.length() / 1024 / 1024}MB")
            } else {
                fl("  内置源码包异常（${out.length()} 字节）")
            }
        } catch (t: Throwable) {
            fl("  assets 无内置源码包：${t.message}")
        }
        // 2) /sdcard 预置（需要存储权限）
        val sdcardZips = listOf(
            File("/sdcard/Download/DshLauncher/deepseek-harness-master.zip"),
            File("/sdcard/Download/DshLauncher/dsh-src.zip"),
            File(getExternalFilesDir(null), "deepseek-harness-master.zip")
        )
        zipCandidates += sdcardZips.filter { it.exists() && it.length() > 100_000 }
        var zipFile: File? = zipCandidates.firstOrNull()
        if (zipFile != null) {
            fl("  使用源码包：${zipFile.absolutePath} (${zipFile.length() / 1024 / 1024}MB)")
        } else {
            fl("  未找到本地源码包，尝试网络下载…")
            val urls = arrayOf(
                "https://github.com/deepseek-ai/deepseek-harness/archive/refs/heads/master.zip",
                "https://ghproxy.com/https://github.com/deepseek-ai/deepseek-harness/archive/refs/heads/master.zip",
                "https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness/archive/refs/heads/master.zip"
            )
            var ok = false
            for (u in urls) {
                fl("  下载 $u")
                try {
                    val tmp = File(filesDir, "harness-download.zip")
                    val conn = java.net.URL(u).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 20_000
                    conn.readTimeout = 60_000
                    conn.instanceFollowRedirects = true
                    conn.setRequestProperty("User-Agent", "DshLauncher/4.0")
                    conn.connect()
                    val code = conn.responseCode
                    fl("  HTTP $code, size=${conn.contentLengthLong}")
                    if (code in 200..399 && conn.contentLengthLong > 100_000) {
                        conn.inputStream.use { input ->
                            tmp.outputStream().use { output -> input.copyTo(output) }
                        }
                        zipFile = tmp
                        ok = true
                        break
                    }
                    conn.disconnect()
                } catch (t: Throwable) {
                    fl("  下载失败：${t.message}")
                }
            }
            if (!ok) {
                fl("  网络下载失败。可把源码包打进 APK assets（harness/ 目录）或 adb push 到 /sdcard/Download/DshLauncher/")
                return false
            }
        }
        try {
            // 先复制到私有目录再解压：/sdcard (FUSE) 上的文件随机访问可能受限
            val localZip = File(filesDir, "harness-source.zip")
            if (zipFile!!.absolutePath != localZip.absolutePath) {
                zipFile.inputStream().use { input ->
                    localZip.outputStream().use { output -> input.copyTo(output) }
                }
                fl("  已复制到私有目录：${localZip.absolutePath}")
                zipFile = localZip
            }
            // 解压到临时目录，避免半成品污染
            val tmp = File(filesDir, ".harness-tmp")
            tmp.deleteRecursively()
            tmp.mkdirs()
            val n = ZipUnpack.unpack(zipFile, tmp)
            fl("  解压 $n 个文件")
            if (!File(tmp, "package.json").exists()) {
                fl("  解压结果缺少 package.json（zip 结构异常）")
                return false
            }
            // 移动临时目录 → 目标目录
            dshHome.deleteRecursively()
            if (!tmp.renameTo(dshHome)) {
                fl("  移动目录失败，改用复制")
                tmp.copyRecursively(dshHome)
                tmp.deleteRecursively()
            }
            return File(dshHome, "package.json").exists()
        } catch (t: Throwable) {
            fl("  解压失败：${t.message}")
            AppLog.e("Console", "unpack failed", t)
            android.util.Log.e("DshConsole", "unpack failed", t)
            return false
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
    private fun startDshWeb(nodeDir: File) {
        val dshHome = File(filesDir, "deepseek-harness-master")
        val cliEntry = when {
            File(dshHome, "apps/cli/lib/bin.js").exists() -> "apps/cli/lib/bin.js"
            else -> "apps/cli/src/bin.ts" // Node 22.19+ 原生 TS
        }
        if (!File(dshHome, "package.json").exists()) {
            appendLine("✗ 未找到 dsh 源码（构建可能未完成）")
            setState("出错")
            return
        }
        // 幂等：3080 已有监听则视为已启动
        if (isPortListening(3080)) {
            appendLine(">> dsh web 已在运行 (http://127.0.0.1:3080)")
            return
        }
        // 生成启动脚本到共享目录，用 sh 后台执行
        val launcher = File(getExternalFilesDir(null) ?: filesDir, "dsh-web.sh")
        launcher.parentFile?.mkdirs()
        launcher.writeText(
            "#!/system/bin/sh\n" +
            "export LD_LIBRARY_PATH=${nodeDir.absolutePath}/lib\n" +
            "export HOME=${filesDir.absolutePath}\n" +
            "export TMPDIR=${nodeDir.absolutePath}/tmp\n" +
            "export OPENSSL_CONF=/dev/null\n" +
            "export PATH=${nodeDir.absolutePath}/bin:/system/bin:/bin\n" +
            "cd $dshHome\n" +
            "nohup ${nodeDir.absolutePath}/bin/node --expose-internals --import ${filesDir.absolutePath}/fs-register.mjs ./$cliEntry web > ${filesDir.absolutePath}/dsh-web.log 2>&1 &\n" +
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
     * 检查并下载 dsh 更新。force=true 时忽略检查间隔（「更新」按钮）。
     * 发现新版本并下载完成后：杀掉 node 进程并重启 flow，
     * 下一次 runDshFlow 会优先解压新包（pending 存在时不再检查，避免循环）。
     */
    private fun startUpdateCheck(force: Boolean, onLog: ((String) -> Unit)? = null) {
        val log: (String) -> Unit = onLog ?: { appendLine(it) }
        thread {
            val version = DshUpdater.checkRemote(this, force, log)
            if (version != null) {
                val file = DshUpdater.download(this, version, log)
                if (file != null) {
                    log("dsh v$version 更新包就绪（${file.length() / 1024 / 1024}MB），重启流程应用…")
                    Thread.sleep(3_000)
                    killAllNode()
                    runOnUiThread { runDshFlow() }
                }
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
        return try {
            val useTermux = termux && TermuxRuntime.isBashReady(this)
            // 用户命令用内置 Termux bash；内部 flow 命令仍用系统 sh（避免自动解压拖慢 dsh）
            val shell = if (useTermux) TermuxRuntime.bashPath(this).absolutePath else "/system/bin/sh"
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
                env["TMPDIR"] = File(filesDir, "node/tmp").absolutePath
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
        }
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

