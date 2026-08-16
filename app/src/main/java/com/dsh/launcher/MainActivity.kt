package com.dsh.launcher

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * DeepSeek Harness 启动器主界面
 * 功能：检查服务状态 / 一键安装 / 启停 dsh 服务 / 打开 Web 界面 / 打开内置终端 / 内置 Node 运行
 */
class MainActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusValue: TextView
    private lateinit var progress: ProgressBar
    private lateinit var logView: TextView
    private val logSb = StringBuilder()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.i("Main", "onCreate start, logPath=" + AppLog.logPath())
        // 支持 `am start -n com.dsh.launcher/.MainActivity --ez dsh true` 一键触发
        if (intent?.getBooleanExtra("dsh", false) == true) {
            startActivity(Intent(this, ConsoleActivity::class.java)
                .putExtra("dsh", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        setContentView(buildUi())
        requestStoragePermissions()
        refreshStatus()
        log("就绪。请选择操作。")
    }

    /** 申请存储权限（targetSdk 28 在 Android 11+ 上读写 /sdcard 需要运行时授权）。 */
    private fun requestStoragePermissions() {
        if (android.os.Build.VERSION.SDK_INT < 23) return
        val needed = mutableListOf<String>()
        if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED)
            needed += android.Manifest.permission.READ_EXTERNAL_STORAGE
        if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED)
            needed += android.Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), 1001)
        }
    }

    // ---------------- UI ----------------
    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(20), dp(32), dp(20), dp(24))
        }

        // Header
        root.addView(TextView(this).apply {
            text = "⚡ DeepSeek Harness"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = "Agent 插件化开发框架 · 本地运行"
            textSize = 13f
            setTextColor(Ui.TEXT_MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, dp(20))
        })

        // Section: 运行状态
        root.addView(Ui.sectionLabel(this, "运行状态"))

        // Status card
        val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE)
        val cardRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        cardRow.addView(TextView(this).apply {
            text = getString(R.string.status_title)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        statusValue = TextView(this).apply {
            text = getString(R.string.status_unknown)
            textSize = 14f
            gravity = Gravity.END
        }
        cardRow.addView(statusValue)
        cardRow.addView(Ui.button(this, "刷新", { refreshStatus() }, filled = false, compact = true).apply {
            minWidth = dp(64)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        })
        card.addView(cardRow)
        root.addView(card, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        progress = ProgressBar(this).apply { visibility = View.GONE }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(4) })

        // Section: 快速操作
        root.addView(Ui.sectionLabel(this, "快速操作").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        })

        val actionCard = Ui.card(this, radiusDp = 16, background = Ui.SURFACE)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        actionCard.addView(actions)
        root.addView(actionCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })

        fun addButton(text: String, filled: Boolean, color: Int = Ui.BRAND_DEEP, onClick: () -> Unit) {
            actions.addView(Ui.button(this, text, onClick, filled = filled, color = color).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }
            })
        }

        addButton(getString(R.string.btn_install_one), true) {
            // 免 Termux 一键：ConsoleActivity 驱动 4 步流程（node→官方 npm 安装 dsh→插件装配→web）
            runCatching {
                startActivity(Intent(this, ConsoleActivity::class.java).putExtra("dsh", true))
            }.onFailure {
                log("✗ 无法打开控制台：${it.message}")
            }
        }
        addButton(getString(R.string.btn_open_web), false) {
            startActivity(Intent(this, WebViewActivity::class.java))
        }
        addButton(getString(R.string.btn_open_terminal), false) {
            thread {
                if (!TermuxRuntime.isReady(this@MainActivity)) {
                    log("准备内置 Termux 环境（首次约 10~60 秒）…")
                    try {
                        TermuxRuntime.ensureExtracted(this@MainActivity) { msg -> log(msg) }
                        TermuxRuntime.ensureHarnessTools(this@MainActivity) { msg -> log(msg) }
                        log("Termux 环境就绪，打开终端…")
                    } catch (t: Throwable) {
                        log("✗ Termux 准备失败：${t.message}（回退系统 sh）")
                    }
                }
                runOnUiThread {
                    startActivity(Intent(this@MainActivity, TerminalActivity::class.java))
                }
            }
        }
        addButton(getString(R.string.btn_node_check), false) {
            runNodeDsh()
        }
        addButton(getString(R.string.btn_stop_all), false, Ui.DANGER) {
            stopDshAll()
        }

        // Section: 日志
        root.addView(Ui.sectionLabel(this, "日志").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        })

        // 反馈日志栏
        val logCard = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_ALT)
        logView = TextView(this).apply {
            setTextColor(Ui.TEXT_SECONDARY)
            textSize = 12f
            setPadding(dp(4), dp(2), dp(4), dp(2))
            setLineSpacing(dp(2).toFloat(), 1f)
        }
        logCard.addView(logView)
        root.addView(logCard, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(14) })

        // Section: 运行环境
        root.addView(Ui.sectionLabel(this, "运行环境").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        })

        // 内置 Node / Termux 状态
        root.addView(TextView(this).apply {
            text = if (hasNodeMarker()) "内置 Node：已就绪 ✓"
                   else "内置 Node：未解压（点上方按钮首次自动解压 ⏳）"
            textSize = 13f
            setTextColor(if (hasNodeMarker()) Ui.SUCCESS else Ui.WARNING)
            setPadding(0, dp(12), 0, 0)
        })
        root.addView(TextView(this).apply {
            val ready = TermuxRuntime.isReady(this@MainActivity)
            text = if (ready) "内置 Termux：已就绪 ✓（bash + coreutils + apt，可执行 Linux 指令）"
                   else "内置 Termux：未解压（首次执行命令/打开终端自动准备）"
            textSize = 13f
            setTextColor(if (ready) Ui.SUCCESS else Ui.WARNING)
            setPadding(0, dp(4), 0, 0)
        })

        root.addView(TextView(this).apply {
            text = "操作步骤：\n① 点“⚡ 一键安装并启动 DSH”自动完成：内置 Node 解压 → 官方 npm 安装/更新 dsh → dsh plugin 装配内置插件 → 启动 Web（首次需联网下载，之后增量更新）；\n② “打开 Web 界面”查看 dsh UI（http://127.0.0.1:3080）；\n③ “停止 dsh 服务”结束后台进程与保活服务。\n\n提示：\n· 全程免 Termux，内置 Node 为 aarch64 运行时；\n· 安装日志：/sdcard/Download/DshLauncher/install_log.txt。"
            textSize = 12f
            setTextColor(Ui.TEXT_MUTED)
            setPadding(0, dp(18), 0, 0)
            setLineSpacing(dp(3).toFloat(), 1f)
        })

        return ScrollView(this).apply { addView(root) }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    // ---------------- Termux 调用 ----------------
    private fun runInTermux(command: String, successMsg: String) {
        AppLog.i("Main", "runInTermux: $command")
        if (!TermuxExecutor.isInstalled(this)) {
            val msg = getString(R.string.hint_termux_not_installed)
            AppLog.w("Main", msg)
            toast(msg)
            log("✗ 未检测到 Termux，无法执行：$command")
            return
        }
        log("▶ 正在执行（发送到 Termux）：$command")
        val ok = TermuxExecutor.runCommand(this, command, background = true)
        if (ok) {
            log("✓ " + successMsg)
            AppLog.i("Main", "OK: $successMsg")
            toast(successMsg)
        } else {
            val msg = "✗ 执行失败。请在 Termux 设置中允许外部应用运行命令（RUN_COMMAND）后重试。"
            AppLog.e("Main", msg)
            log(msg)
            toast(msg)
        }
    }

    // ---------------- 状态检测 ----------------
    private fun refreshStatus() {
        progress.visibility = View.VISIBLE
        log("… 检测 dsh 服务状态…")
        Thread {
            val running = pingServer()
            handler.post {
                progress.visibility = View.GONE
                statusValue.text = if (running) getString(R.string.status_running)
                else getString(R.string.status_stopped)
                val color: Int = if (running) android.graphics.Color.parseColor("#2DB85B")
                else android.graphics.Color.parseColor("#CC4444")
                statusValue.setTextColor(color)
                log(if (running) "dsh 服务：运行中（3080 端口）" else "dsh 服务：未运行")
            }
        }.start()
    }

    private fun pingServer(): Boolean = try {
        val conn = URL(WEB_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..399
    } catch (e: Exception) {
        false
    }

    private fun startTerminalWithCmd(cmd: String) {
        startActivity(Intent(this, TerminalActivity::class.java).putExtra("cmd", cmd))
    }

    private fun runNodeDsh() {
        if (isExtracting) {
            toast("正在解压中，请稍候…")
            return
        }
        isExtracting = true
        progress.visibility = View.VISIBLE
        AppLog.i("Node", "start ensureExtracted")
        log("▶ 正在解压内置 Node 运行时（首次约需几十秒）…")
        Thread {
            try {
                val nodeDir = NodeRuntime.ensureExtracted(this)
                val marker = File(filesDir, ".node-ok").exists()
                AppLog.i("Node", "ensureExtracted done marker=$marker dir=$nodeDir")
                handler.post {
                    progress.visibility = View.GONE
                    isExtracting = false
                    if (marker) {
                        log("✓ 内置 Node 解压完成")
                        toast("内置 Node 已就绪，正在打开控制台…")
                    }
                    log("▶ 打开控制台并验证 node 版本…")
                    val nodeEnv = NodeRuntime.nodeEnvPrefix(this)
                    startActivity(Intent(this, ConsoleActivity::class.java)
                        .putExtra("cmd", "$nodeEnv $nodeDir/bin/node --version"))
                }
            } catch (t: Throwable) {
                AppLog.e("Node", "extract failed: " + (t.message ?: t.toString()))
                android.util.Log.e("DshNode", "extract failed", t)
                handler.post {
                    progress.visibility = View.GONE
                    isExtracting = false
                    val msg = "✗ Node 运行时解压失败：${t.message}"
                    log(msg)
                    toast(msg)
                }
            }
        }.start()
    }

    /** 是否有内置 Node 解压完成标记。 */
    private fun hasNodeMarker(): Boolean = File(filesDir, ".node-ok").exists()

    /** 停止 dsh 服务：杀 node 相关进程 + 停保活服务 + 刷新状态。 */
    private fun stopDshAll() {
        log("▶ 正在停止 dsh 相关进程…")
        thread {
            try {
                val pb = ProcessBuilder(
                    "/system/bin/sh", "-c",
                    "pkill -f 'dsh/lib/bin.js web'; pkill -f 'bin.js web'; pkill -f 'src/bin.ts'; true"
                )
                pb.redirectErrorStream(true)
                pb.start().waitFor()
            } catch (t: Throwable) {
                android.util.Log.w("DshMain", "kill failed: ${t.message}")
            }
            runOnUiThread {
                runCatching { stopService(Intent(this@MainActivity, BuildKeepAliveService::class.java)) }
                log("✓ 已停止 dsh 相关进程与服务")
                refreshStatus()
            }
        }
    }

    /** 在主界面日志栏追加一行（主线程安全），同时写入文件日志与 logcat。 */
    private fun log(msg: String) {
        AppLog.i("Main", msg)
        android.util.Log.i("DshMain", msg)
        handler.post {
            logSb.append("• ").append(msg).append("\n")
            // 保留最近 20 行
            val lines = logSb.toString().split("\n")
            if (lines.size > 20) logSb.clear().append(lines.takeLast(20).joinToString("\n")).append("\n")
            logView.text = logSb.toString()
        }
    }

    private var isExtracting = false

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    companion object {
        private const val WEB_URL = "http://127.0.0.1:3080"
    }
}
