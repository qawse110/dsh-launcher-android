package com.dsh.launcher

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
        deployScripts()
        setContentView(buildUi())
        refreshStatus()
        log("就绪。请选择操作。")
    }

    // ---------------- 脚本部署 ----------------
    /**
     * 把内置的 dsh 管理脚本复制到共享目录，供 Termux 执行。
     * 目标：/storage/emulated/0/Download/DshLauncher/scripts
     * （Termux 执行 termux-setup-storage 后可读取该目录）
     */
    private fun deployScripts() {
        val names = arrayOf("install-dsh.sh", "run-dsh.sh", "dsh-manager.sh", "dsh-init.sh")
        // 优先共享目录（Termux 可读）；若无权限则回退到 app 私有区
        val sharedDir = File("/storage/emulated/0/Download/DshLauncher/scripts")
        val privDir = File(filesDir, "scripts")
        var usedDir: File? = null
        try {
            if (sharedDir.exists() || sharedDir.mkdirs()) {
                // 测试共享目录是否可写
                val probe = File(sharedDir, ".write-test")
                try {
                    probe.writeText("ok")
                    probe.delete()
                    usedDir = sharedDir
                } catch (we: Throwable) {
                    AppLog.w("Main", "共享目录不可写，回退私有区: ${we.message}")
                }
            }
        } catch (e: Throwable) {
            AppLog.w("Main", "共享目录创建失败: ${e.message}")
        }
        if (usedDir == null) {
            usedDir = privDir
            usedDir.mkdirs()
        }
        try {
            for (name in names) {
                val out = File(usedDir, name)
                assets.open("scripts/$name").use { input ->
                    out.outputStream().use { input.copyTo(it) }
                }
            }
            AppLog.i("Main", "scripts deployed to " + usedDir.absolutePath)
            android.util.Log.i("DshMain", "scripts -> ${usedDir.absolutePath}")
        } catch (e: Exception) {
            android.util.Log.w("Dsh", "脚本部署失败", e)
        }
    }

    // ---------------- UI ----------------
    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(40), dp(20), dp(24))
        }

        root.addView(TextView(this).apply {
            text = "DeepSeek Harness"
            textSize = 26f
            setTextColor(0xFF4D6BFE.toInt())
            gravity = Gravity.CENTER
        })

        root.addView(TextView(this).apply {
            text = "Agent 插件化开发框架 · 本地运行"
            textSize = 13f
            setTextColor(0xFF8A8A8A.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, dp(20))
        })

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = roundedBg(0xFFF2F4FF.toInt())
        }
        card.addView(TextView(this).apply {
            text = getString(R.string.status_title)
            textSize = 15f
            setTextColor(0xFF333333.toInt())
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        statusValue = TextView(this).apply {
            text = getString(R.string.status_unknown)
            textSize = 15f
            gravity = Gravity.END
        }
        card.addView(statusValue)
        root.addView(card)

        progress = ProgressBar(this).apply { visibility = View.GONE }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(4) })

        root.addView(actionButton(getString(R.string.btn_install)) {
            runInTermux(INSTALL_CMD, "正在 Termux 中安装 DSH，请查看终端输出")
        })
        root.addView(actionButton(getString(R.string.btn_start)) {
            runInTermux(START_CMD, "已请求启动 dsh 服务")
        })
        root.addView(actionButton(getString(R.string.btn_stop)) {
            runInTermux(STOP_CMD, "已请求停止 dsh 服务")
        })
        root.addView(actionButton(getString(R.string.btn_open_web)) {
            startActivity(Intent(this, WebViewActivity::class.java))
        })
        root.addView(actionButton(getString(R.string.btn_open_terminal)) {
            startActivity(Intent(this, ConsoleActivity::class.java))
        })
        root.addView(actionButton(getString(R.string.btn_terminal_run_dsh)) {
            startActivity(Intent(this, ConsoleActivity::class.java)
                .putExtra("cmd", "cd /sdcard/Download/DshLauncher/scripts && bash run-dsh.sh"))
        })
        root.addView(actionButton(getString(R.string.btn_node_run_dsh)) {
            runNodeDsh()
        })

        // 反馈日志栏
        logView = TextView(this).apply {
            setTextColor(0xFF444444.toInt())
            textSize = 12f
            setPadding(dp(4), dp(10), dp(4), dp(2))
        }
        root.addView(logView)

        // 内置 Node 状态
        root.addView(TextView(this).apply {
            text = if (hasNodeMarker()) "内置 Node：已就绪 ✓"
                   else "内置 Node：未解压（点上方按钮首次自动解压 ⏳）"
            textSize = 12f
            setTextColor(if (hasNodeMarker()) 0xFF2DB85B.toInt() else 0xFFCC4444.toInt())
            setPadding(0, dp(8), 0, 0)
        })

        root.addView(TextView(this).apply {
            text = "操作步骤：\n① 点“⚡ 内置 Node 运行 DSH”自动解压内置 Node 并验证；\n② 如需 dsh 完整功能，在控制台执行 npm 安装 dsh；\n③ “打开 Web 界面”查看 dsh UI。\n\n提示：\n· 内置 Node 为免 Termux 方案，首次解压约需几十秒；\n· ①安装/②启动/③停止依赖 Termux 环境。"
            textSize = 12f
            setTextColor(0xFF9A9A9A.toInt())
            setPadding(0, dp(18), 0, 0)
            setLineSpacing(dp(3).toFloat(), 1f)
        })

        return ScrollView(this).apply { addView(root) }
    }

    private fun actionButton(text: String, onClick: () -> Unit): Button =
        Button(this, null, android.R.attr.buttonBarButtonStyle).apply {
            this.text = text
            setTextSize(16f)
            isAllCaps = false
            setPadding(0, dp(2), 0, dp(2))
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(10)
            layoutParams = lp
            setOnClickListener { onClick() }
        }

    private fun roundedBg(color: Int) = android.graphics.drawable.GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(12).toFloat()
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
        private const val SCRIPTS = "/storage/emulated/0/Download/DshLauncher/scripts"
        private const val WEB_URL = "http://127.0.0.1:3080"
        private const val INSTALL_CMD = "bash $SCRIPTS/install-dsh.sh"
        private const val START_CMD = "bash $SCRIPTS/dsh-manager.sh start"
        private const val STOP_CMD = "bash $SCRIPTS/dsh-manager.sh stop"
    }
}
