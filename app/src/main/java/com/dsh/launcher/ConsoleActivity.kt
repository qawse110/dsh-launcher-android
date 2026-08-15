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

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(nodeBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(runBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
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
     *   2) 用 node 下载 install-dsh.mjs 到私有目录（GitHub raw）
     *   3) node 执行 install-dsh.mjs（pnpm install + build），日志写共享目录
     *   4) 启动 dsh web（后台长驻）
     */
    private fun runDshFlow() {
        setState("启动 dsh 安装…")
        appendLine(">> 1/4 确保内置 Node 运行时…")
        val flowLog = File("/sdcard/Download/DshLauncher/dsh-flow.log")
        fun fl(msg: String) {
            runCatching {
                flowLog.appendText("${System.currentTimeMillis()} $msg\n")
            }
            appendLine(msg)
        }
        thread {
            try {
                startKeepAlive()
                val nodeDir = NodeRuntime.ensureExtracted(this)
                flowLog.parentFile?.mkdirs()
                runCatching { flowLog.writeText("") }
                fl("OK 1/4 node=$nodeDir")
                fl(">> 2/4 从 APK assets 读取 stub 脚本…")
                // 本地打包：直接读 assets/stub-dsh.mjs，不依赖网络下载
                val installScript = File(filesDir, "install-dsh.mjs")
                try {
                    assets.open("stub-dsh.mjs").use { input ->
                        installScript.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (t: Throwable) {
                    fl("FAIL 2/4 assets copy: ${t.message}")
                    setState("出错")
                    return@thread
                }
                if (!installScript.exists()) {
                    fl("FAIL 2/4 installer missing")
                    setState("出错")
                    return@thread
                }
                fl("OK 2/4 installer from assets")
                fl(">> 3/4 pnpm install + build (long)…")
                runCommand("$nodeDir/bin/node ${installScript.absolutePath}")
                fl("OK 3/4 install script finished")
                fl(">> 4/4 start dsh web…")
                startDshWeb(nodeDir)
                fl("OK 4/4 dsh web started")
                // 注意：runCommand 异步，build 可能仍在进行；keepalive 保持常驻，
                // 由 install-dsh.mjs 完成后写入标记，外部轮询 dsh-flow.log/install_log 判定。
                // stopKeepAlive() 不能在此调用，否则 build 期间失去保活会被系统回收。
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

    /** 后台启动 dsh web（nohup 使其脱离本控制台进程）。 */
    private fun startDshWeb(nodeDir: File) {
        val dshHome = File(filesDir, "deepseek-harness-master")
        if (!File(dshHome, "node_modules/.bin/dsh").exists()) {
            appendLine("✗ 未找到 dsh 可执行文件（构建可能未完成）")
            setState("出错")
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
            "nohup ${nodeDir.absolutePath}/bin/node ./node_modules/.bin/dsh web > /sdcard/Download/DshLauncher/dsh-web.log 2>&1 &\n" +
            "echo DSH_WEB_PID=$!\n"
        )
        launcher.setExecutable(true)
        runCommand("/system/bin/sh ${launcher.absolutePath}")
        appendLine(">> dsh web 后台启动，日志：/sdcard/Download/DshLauncher/dsh-web.log")
    }

    /** 通过 ProcessBuilder 执行命令，实时回显输出。 */
    private fun runCommand(raw: String) {
        setState("运行中…")
        AppLog.i("Console", "cmd: $raw | env LD_LIBRARY_PATH=" + File(filesDir, "node/lib").absolutePath)
        thread {
            try {
                // 用 /system/bin/sh -c 执行，这样支持管道/重定向/环境变量
                val pb = ProcessBuilder("/system/bin/sh", "-c", raw)
                pb.redirectErrorStream(true)
                val env = pb.environment()
                env["PATH"] = listOf(
                    "/data/data/com.dsh.launcher/files/node/bin",
                    "/system/bin", "/bin", "/usr/bin"
                ).joinToString(":")
                env["HOME"] = "/data/data/com.dsh.launcher/files"
                env["TERM"] = "xterm-256color"
                env["LD_LIBRARY_PATH"] = File(filesDir, "node/lib").absolutePath
                env["TMPDIR"] = File(filesDir, "node/tmp").absolutePath
                env["OPENSSL_CONF"] = "/dev/null"

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
                appendLine("如需继续，在下方输入命令回车；点“清空”可清理屏幕。")
            } catch (e: Exception) {
                AppLog.e("Console", "cmd failed: " + (e.message ?: e.toString()))
                setState("出错")
                appendLine("[执行失败: ${e.message}]")
            }
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

