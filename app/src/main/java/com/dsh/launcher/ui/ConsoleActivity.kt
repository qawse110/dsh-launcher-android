package com.dsh.launcher.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import java.io.File
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * 内置命令控制台（基于 Java ProcessBuilder，不依赖受限的 PTY 原生库）。
 *
 * 说明：libtermux.so 的 createSubprocess 在第三方 app 中受 Android seccomp
 * 限制，无法可靠 fork/exec shell，导致 PTY 终端黑屏。这里改用 ProcessBuilder，
 * 稳定启动内置 Termux bash 或内置 Node，并实时回显 stdout/stderr。
 */
class ConsoleActivity : AppCompatActivity() {

    private lateinit var output: TextView
    private lateinit var input: EditText
    private lateinit var stateView: TextView
    private lateinit var servicePill: TextView
    private val mainHandler = Handler(Looper.getMainLooper())
    private val cmdHistory = ArrayDeque<String>()
    private var histCursor = -1
    private val servicePoll = object : Runnable {
        override fun run() {
            refreshServicePill()
            mainHandler.postDelayed(this, 3_000)
        }
    }
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
        mainHandler.post(servicePoll)
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

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacks(servicePoll)
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(12), dp(10), dp(12), dp(8))
        }

        // ---- 头部：标题 + 执行状态 pill + dsh 服务 pill（3s 轮询）----
        val headerCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        headerRow.addView(TextView(this).apply {
            text = "命令控制台"
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        stateView = TextView(this).apply {
            text = "空闲"
            textSize = 11.5f
            setTextColor(Ui.TEXT_SECONDARY)
        }
        headerRow.addView(stateView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { rightMargin = dp(8) })

        servicePill = Ui.pill(this, "○ 检测中", Ui.TEXT_MUTED)
        headerRow.addView(servicePill)

        headerCard.addView(headerRow)
        root.addView(headerCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // ---- 快捷指令：一键直发，输出进下方控制台 ----
        val chips = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
        }
        val chipRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(2), dp(6), dp(2), dp(2))
        }
        fun chip(label: String, onClick: () -> Unit) {
            chipRow.addView(Ui.button(this, label, onClick, filled = false, compact = true).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(6); minWidth = dp(0) }
            })
        }
        fun stopDsh() {
            appendLine(">> 停止 dsh 相关进程…")
            thread {
                DshFlow.killAllNode(this) { l -> runOnUiThread { appendLine(l) } }
                BuildKeepAliveService.markStopped(this)
                runOnUiThread { appendLine("✓ 已停止。可用「启动 dsh」重新拉起") }
            }
        }
        chip("▶ 启动 dsh") { runDshFlow(startOnly = true) }
        chip("↻ 重启服务") {
            appendLine(">> 重启 dsh 服务…")
            thread {
                DshFlow.killAllNode(this) { l -> runOnUiThread { appendLine(l) } }
                Thread.sleep(1200)
                runOnUiThread { runDshFlow(startOnly = true) }
            }
        }
        chip("■ 停止 dsh") { stopDsh() }
        chip("● 服务状态") {
            thread {
                val up = runCatching { DshFlow.isWebUp() }.getOrDefault(false)
                runOnUiThread {
                    appendLine("dsh web：" + if (up) "运行中（http://127.0.0.1:3080）" else "未运行")
                    setState(if (up) "运行中" else "已停止")
                }
            }
        }
        chip("node -v") { runNodeCmd() }
        chips.addView(chipRow)
        root.addView(chips, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // ---- 输出区 ----
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

        // ---- 输入行：输入框(weight) + ↑历史 + 执行 ----
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        input = EditText(this).apply {
            hint = "输入命令，回车执行"
            textSize = 14f
            setTextColor(Ui.TEXT_PRIMARY)
            setHintTextColor(Ui.TEXT_MUTED)
            background = Ui.rounded(this@ConsoleActivity, Ui.SURFACE_INPUT, 12, Ui.OUTLINE)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }
        inputRow.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(6) })
        inputRow.addView(Ui.button(this, "↑", { historyPrev() }, filled = false, compact = true), LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(6) })
        inputRow.addView(Ui.button(this, "↓", { historyNext() }, filled = false, compact = true), LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(6) })
        inputRow.addView(Ui.button(this, "执行", { execInput() }, filled = true, compact = true), LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(inputRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })

        // ---- 工具行 ----
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
        val pluginBtn = Ui.button(this, "插件管理", {
            startActivity(Intent(this@ConsoleActivity, PluginManagerActivity::class.java))
        }, filled = false)
        val updateBtn = Ui.button(this, "检查更新", { startUpdateCheck(true) }, filled = false)
        val updateNextBtn = Ui.button(this, "更新 next", { startUpdateCheckNext(true) }, filled = false)
        val clearBtn = Ui.button(this, "清空", { sb.clear(); output.text = "" }, filled = false)
        val closeBtn = Ui.button(this, "退出", { finish() }, filled = false, color = Ui.DANGER)

        root.addView(rowOf(nodeBtn, termBtn, pluginBtn, updateBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })
        root.addView(rowOf(updateNextBtn, clearBtn, closeBtn), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })

        return root
    }

    private fun refreshServicePill() {
        thread {
            val up = runCatching { DshFlow.isWebUp() }.getOrDefault(false)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                servicePill.text = if (up) "● dsh 运行中" else "○ dsh 已停止"
                servicePill.setTextColor(if (up) Ui.SUCCESS else Ui.TEXT_MUTED)
                servicePill.background = Ui.rounded(this, Ui.withAlpha(if (up) Ui.SUCCESS else Ui.TEXT_MUTED, 0x1A), 8, if (up) Ui.SUCCESS else Ui.TEXT_MUTED, 1)
            }
        }
    }

    private fun historyPrev() {
        if (cmdHistory.isEmpty()) return
        histCursor = if (histCursor == -1) cmdHistory.lastIndex else (histCursor - 1).coerceAtLeast(0)
        input.setText(cmdHistory[histCursor])
        input.setSelection(input.text.length)
    }

    private fun historyNext() {
        if (histCursor == -1) return
        histCursor++
        if (histCursor >= cmdHistory.size) {
            histCursor = -1
            input.setText("")
            return
        }
        input.setText(cmdHistory[histCursor])
        input.setSelection(input.text.length)
    }

    private fun execInput() {
        val cmd = input.text.toString().trim()
        if (cmd.isNotEmpty()) {
            appendLine("$ $cmd")
            if (cmdHistory.lastOrNull() != cmd) {
                cmdHistory.addLast(cmd)
                if (cmdHistory.size > 50) cmdHistory.removeFirst()
            }
            histCursor = -1
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
    private fun runDshFlow(installOnly: Boolean = false, startOnly: Boolean = false, forceFullInstall: Boolean = false) {
        val mode = when {
            installOnly -> DshFlow.Mode.INSTALL_ONLY
            startOnly -> DshFlow.Mode.START_ONLY
            else -> DshFlow.Mode.INSTALL_AND_START
        }
        DshFlow.launch(
            this, mode,
            onLog = { line -> appendLine(line) },
            onState = { s -> setState(s) },
            forceFullInstall = forceFullInstall
        )
    }

    /** 同步执行命令（阻塞直到结束），返回退出码；输出实时回显（引擎见 [DshFlow.exec]，唯一环境为内置 Termux）。 */
    private fun runCommandAndWait(raw: String, extraEnv: Map<String, String> = emptyMap()): Int {
        setState("运行中…")
        val exit = DshFlow.exec(this, raw, extraEnv) { line -> appendLine(line) }
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
                    appendLine("✗ Termux 环境准备失败：${t.message}")
                    android.util.Log.e("Console", "termux ensure failed", t)
                    setState("出错")
                    return@thread
                }
            }
            TermuxRuntime.ensureHarnessTools(this) { msg -> appendLine(msg) }
            runCommandAndWait(raw)
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
                runOnUiThread { runDshFlow(forceFullInstall = true) }
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
                runOnUiThread { runDshFlow(forceFullInstall = true) }
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
        val display = if (line.length > 200) line.take(197) + "…" else line
        runOnUiThread {
            sb.append(display).append("\n")
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

