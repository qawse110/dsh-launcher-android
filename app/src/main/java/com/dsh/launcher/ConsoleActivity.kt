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

    companion object {
        /** 控制台自身 prefs：一次性安装 tag（dsh_install_tag=next）等。 */
        private const val CONSOLE_PREFS = "dsh_console"
    }

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
     * dsh 安装/启动流程：具体步骤统一在 [DshFlow] 引擎中（主界面自动启动与
     * 控制台手动触发共用同一份逻辑）。通过 intent extras 触发：
     *   `--ez dsh true`          安装+启动（兼容旧入口：通知/插件管理/am 快捷方式）
     *   `--ez dsh_install true`  仅安装/更新（npm + 插件装配，不启动 web）
     *   `--ez dsh_start true`    仅启动（跳安装，要求已安装）
     */
    private fun runDshFlow(installOnly: Boolean = false, startOnly: Boolean = false) {
        val mode = when {
            installOnly -> DshFlow.Mode.INSTALL_ONLY
            startOnly -> DshFlow.Mode.START_ONLY
            else -> DshFlow.Mode.INSTALL_AND_START
        }
        DshFlow.launch(
            this, mode,
            onLog = { line -> appendLine(line) },
            onState = { s -> setState(s) }
        )
    }

    /** 同步执行命令（阻塞直到结束），返回退出码；输出实时回显（引擎见 [DshFlow.exec]）。 */
    private fun runCommandAndWait(raw: String, extraEnv: Map<String, String> = emptyMap(), termux: Boolean = false): Int {
        setState("运行中…")
        val exit = DshFlow.exec(this, raw, extraEnv, termux) { line -> appendLine(line) }
        AppLog.i("Console", "exit code: $exit")
        setState("完成（退出码 $exit）")
        appendLine("[退出码: $exit]")
        appendLine("")
        return exit
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
                DshFlow.killAllNode(this@ConsoleActivity) { appendLine(it) }
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
                DshFlow.killAllNode(this@ConsoleActivity) { appendLine(it) }
                runOnUiThread { runDshFlow() }
            } else {
                log("next 线暂无更新（或已是最新预发布版）")
            }
        }
    }



    private fun setState(s: String) {
        runOnUiThread {
            stateView.text = "状态：$s"
            // 状态 pill：按语义着色（出错红 / 运行绿 / 进行中蓝 / 其它灰）
            val color = when {
                s.contains("出错") || s.contains("失败") -> Ui.DANGER
                s.contains("运行中") || s.contains("完成") -> Ui.SUCCESS
                s.contains("安装") || s.contains("启动") || s.contains("更新") -> Ui.BRAND
                else -> Ui.TEXT_SECONDARY
            }
            stateView.setTextColor(color)
            stateView.background = Ui.rounded(this, Ui.withAlpha(color, 0x1A), 10, color, 1)
            stateView.setPadding(dp(8), dp(3), dp(8), dp(3))
        }
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

