package com.dsh.launcher

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RelativeLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import java.io.File
import kotlin.concurrent.thread

/**
 * 内置终端：基于 Termux terminal-view/emulator，在单 App 内提供真实 PTY shell。
 */
class TerminalActivity : AppCompatActivity(), TerminalSessionClient, TerminalViewClient {

    private lateinit var terminalView: TerminalView
    private var session: TerminalSession? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val shell = detectShell()
        val home = detectHome()
        val env = arrayOf(
            "PATH=" + listOf(
                "/data/data/com.termux/files/usr/bin",
                "/data/data/com.termux/files/usr/bin/applets",
                "/data/data/com.termux/files/usr/bin/local/bin",
                "/usr/bin", "/bin", "/system/bin"
            ).joinToString(":"),
            "HOME=$home",
            "TERM=xterm-256color",
            "TMPDIR=$home"
        )

        // 会话：createSubprocess 通过原生 libtermux.so 创建 PTY 子进程
        // 注意：TerminalSession 构造不会启动子进程，需由 updateSize() 触发的
        // initializeEmulator() 来创建 PTY。因此必须在视图完成布局后 attach。
        session = TerminalSession(shell, home, arrayOf("-l"), env, 2000, this)

        terminalView = TerminalView(this, null)
        terminalView.setTerminalViewClient(this)
        terminalView.setTextSize(16)
        // 确保 TerminalView 有自己的背景（黑底），即使 emulator 未就绪也非透明
        terminalView.setBackgroundColor(0xFF0B0B0F.toInt())

        val list = RelativeLayout(this)
        list.addView(terminalView, RelativeLayout.LayoutParams(RelativeLayout.LayoutParams.MATCH_PARENT, RelativeLayout.LayoutParams.MATCH_PARENT))

        val status = TextView(this).apply {
            text = "内置终端 · shell: $shell"
            textSize = 12f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(dp(12), dp(6), dp(12), dp(6))
        }
        val close = Button(this).apply {
            text = "退出"
            textSize = 13f
            setOnClickListener { finish() }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF20242D.toInt())
            addView(status, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(close)
        }
        list.addView(bar, RelativeLayout.LayoutParams(RelativeLayout.LayoutParams.MATCH_PARENT, dp(48)).apply { addRule(RelativeLayout.ALIGN_PARENT_TOP) })

        setContentView(list)

        // 关键修复：等待视图完成首次布局后再 attachSession，
        // 这样 updateSize() 能拿到真实宽高并触发 initializeEmulator() 创建 PTY 子进程。
        terminalView.post {
            try {
                terminalView.attachSession(session)
                // attachSession 内部已调用 updateSize()；若仍未初始化则再强制一次
                terminalView.post { terminalView.updateSize() }
                val startupCmd = intent?.getStringExtra("cmd")
                if (!startupCmd.isNullOrBlank()) {
                    thread {
                        try { Thread.sleep(1800) } catch (ignored: InterruptedException) {}
                        runOnUiThread { session?.write(startupCmd + "\n") }
                    }
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    session?.write(("内置终端启动失败: " + t.message + "\n"))
                }
            }
        }
    }

    private fun detectShell(): String {
        val candidates = arrayOf(
            "/data/data/com.termux/files/usr/bin/bash",
            "/bin/bash",
            "/system/bin/sh"
        )
        for (c in candidates) if (File(c).exists()) return c
        return "/system/bin/sh"
    }

    private fun detectHome(): String {
        if (File("/data/data/com.termux/files/home").exists()) return "/data/data/com.termux/files/home"
        return "/"
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onResume() {
        super.onResume()
    }

    override fun onPause() {
        super.onPause()
    }

    override fun onDestroy() {
        session?.finishIfRunning()
        super.onDestroy()
    }

    // ============ TerminalSessionClient ============
    override fun onTextChanged(changedSession: TerminalSession) { terminalView.onScreenUpdated() }
    override fun onTitleChanged(changedSession: TerminalSession) {}
    override fun onSessionFinished(finishedSession: TerminalSession) {}
    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("terminal", text))
    }
    override fun onPasteTextFromClipboard(session: TerminalSession) {
        val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
        if (clip != null && clip.itemCount > 0) session.write(clip.getItemAt(0).coerceToText(this).toString())
    }
    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = 0
    private fun noop() {}

    override fun logError(tag: String, message: String) { android.util.Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { android.util.Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { android.util.Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { android.util.Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { android.util.Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { android.util.Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { android.util.Log.e(tag, "stack", e) }

    // ============ TerminalViewClient ============
    override fun onScale(scale: Float): Float = scale
    override fun onSingleTapUp(e: MotionEvent) {}
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = false
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) {}
    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean = false
    override fun onLongPress(event: MotionEvent): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean = false
    override fun onEmulatorSet() {}
}
