package com.dsh.launcher

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import java.io.File
import kotlin.concurrent.thread

/**
 * 内置终端：基于 Termux terminal-view/emulator，在单 App 内提供真实 PTY shell。
 *
 * 交互优化：
 *  - 顶栏：粘贴 / 字体缩放 / 重启 shell / 退出；
 *  - 底栏：常用符号与功能键快捷条（ESC/TAB/管道/引号/括号等），解决软键盘输入痛点；
 *  - shell 结束后可一键重启，不依赖强制返回重进；
 *  - 背景、配色跟随 dsh 主题，状态栏显示 shell 与 PID。
 */
class TerminalActivity : AppCompatActivity(), TerminalSessionClient, TerminalViewClient {

    private lateinit var terminalView: TerminalView
    private lateinit var statusLabel: TextView
    private lateinit var fontLabel: TextView
    private var session: TerminalSession? = null
    private var currentTextSize = 16

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)

        terminalView = TerminalView(this, null)
        terminalView.setTerminalViewClient(this)
        terminalView.setTextSize(currentTextSize)
        terminalView.setBackgroundColor(0xFF0B0B0F.toInt())
        terminalView.isFocusableInTouchMode = true

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }

        // ── 顶栏 ────────────────────────────────────────
        statusLabel = TextView(this).apply {
            textSize = 12f
            setTextColor(Ui.TEXT_PRIMARY)
            setPadding(dp(12), dp(6), dp(6), dp(6))
        }
        fontLabel = TextView(this).apply {
            text = "${currentTextSize}sp"
            textSize = 11f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(dp(4), dp(6), dp(4), dp(6))
        }
        val pasteBtn = Ui.button(this, "粘贴", { pasteFromClipboard() }, filled = false, compact = true)
        val fontMinusBtn = Ui.button(this, "A-", { setFontSize(currentTextSize - 1) }, filled = false, compact = true)
        val fontPlusBtn = Ui.button(this, "A+", { setFontSize(currentTextSize + 1) }, filled = false, compact = true)
        val restartBtn = Ui.button(this, "重启", { restartSession() }, filled = false, compact = true)
        val exitBtn = Ui.button(this, "退出", { finish() }, filled = false, compact = true)

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Ui.SURFACE_CONTAINER_HIGH)
            addView(statusLabel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(fontLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_VERTICAL
            })
            addView(pasteBtn)
            addView(fontMinusBtn)
            addView(fontPlusBtn)
            addView(restartBtn)
            addView(exitBtn)
        }
        root.addView(topBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)))

        // ── 终端占满剩余空间 ─────────────────────────────
        root.addView(terminalView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ))

        // ── 底栏快捷条：软键盘不支持的常用键 ─────────────
        val keyStrip = buildKeyStrip()
        root.addView(keyStrip, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(40)
        ))

        setContentView(root)

        terminalView.post {
            try {
                attachNewSession()
            } catch (t: Throwable) {
                runOnUiThread {
                    session?.write(("内置终端启动失败: " + t.message + "\n"))
                    statusLabel.text = "内置终端 · 启动失败"
                }
            }
        }
    }

    /** 创建 shell 会话；TerminalSession 只构造，真正的 PTY 由 attach 后的 size 回调创建。 */
    private fun createSession(): TerminalSession {
        val shell = detectShell()
        val home = detectHome()
        val usr = File(filesDir, "termux/usr")
        val hasTermux = File(usr, "bin/bash").isFile
        val files = filesDir.absolutePath
        val nodeLib = File(files, "node/lib").absolutePath
        val toolsBin = File(files, ".tools/bin").absolutePath
        val env = arrayOf(
            "PATH=" + listOf(
                if (hasTermux) "$usr/bin" else "/data/data/com.termux/files/usr/bin",
                if (hasTermux) "$usr/bin/applets" else "/data/data/com.termux/files/usr/bin/applets",
                if (hasTermux) "$usr/local/bin" else "/data/data/com.termux/files/usr/bin/local/bin",
                "$files/node/bin",
                "$toolsBin",
                "/usr/bin", "/bin", "/system/bin"
            ).joinToString(":"),
            "HOME=$home",
            "TERM=xterm-256color",
            "TMPDIR=$home",
            if (hasTermux) "PREFIX=$usr" else "",
            if (hasTermux) "LD_LIBRARY_PATH=${nodeLib}:$usr/lib" else "LD_LIBRARY_PATH=$nodeLib",
            "LANG=C.UTF-8",
            // 让 shell 的 cwd 与 HOME 一致，和主流终端行为保持一致
            "PWD=$home"
        ).filter { it.isNotBlank() }.toTypedArray()
        return TerminalSession(shell, home, arrayOf("-l"), env, 2000, this)
    }

    private fun attachNewSession() {
        val newSession = createSession()
        session = newSession
        terminalView.attachSession(newSession)
        // attachSession 内部已调用 updateSize()；若仍未初始化则再强制一次
        terminalView.post { terminalView.updateSize() }
        updateStatusBar()
        val startupCmd = intent?.getStringExtra("cmd")
        if (!startupCmd.isNullOrBlank()) {
            thread {
                try { Thread.sleep(1800) } catch (ignored: InterruptedException) {}
                runOnUiThread { runCatching { session?.write(startupCmd + "\n") } }
            }
        }
    }

    private fun restartSession() {
        runCatching { session?.finishIfRunning() }
        try {
            attachNewSession()
        } catch (t: Throwable) {
            statusLabel.text = "内置终端 · 重启失败: ${t.message}"
        }
    }

    private fun updateStatusBar() {
        val shell = detectShell().substringAfterLast('/')
        val pid = session?.getPid()?.takeIf { it > 0 } ?: 0
        statusLabel.text = if (pid > 0) "内置终端 · $shell [pid $pid]" else "内置终端 · $shell"
    }

    override fun onDestroy() {
        runCatching { session?.finishIfRunning() }
        super.onDestroy()
    }

    // ============ TerminalSessionClient ============
    override fun onTextChanged(changedSession: TerminalSession) { terminalView.onScreenUpdated() }
    override fun onTitleChanged(changedSession: TerminalSession) {
        val title = changedSession.title
        if (!title.isNullOrBlank()) statusLabel.text = "内置终端 · $title"
    }
    override fun onSessionFinished(finishedSession: TerminalSession) {
        runOnUiThread {
            statusLabel.text = "内置终端 · shell 已退出（点「重启」继续）"
        }
    }
    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("terminal", text))
    }
    override fun onPasteTextFromClipboard(session: TerminalSession) { pasteFromClipboard() }
    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = 0

    override fun logError(tag: String, message: String) { android.util.Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { android.util.Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { android.util.Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { android.util.Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { android.util.Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { android.util.Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { android.util.Log.e(tag, "stack", e) }

    // ============ TerminalViewClient ============
    override fun onScale(scale: Float): Float = scale
    override fun onSingleTapUp(e: MotionEvent) { terminalView.requestFocus() }
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

    // ============ helpers ============

    private fun pasteFromClipboard() {
        terminalView.requestFocus()
        try {
            val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            if (clip != null && clip.itemCount > 0) {
                session?.write(clip.getItemAt(0).coerceToText(this).toString())
            }
        } catch (_: Throwable) {
        }
    }

    private fun setFontSize(size: Int) {
        currentTextSize = size.coerceIn(10, 24)
        terminalView.setTextSize(currentTextSize)
        fontLabel.text = "${currentTextSize}sp"
        terminalView.post { terminalView.updateSize() }
    }

    private fun buildKeyStrip(): HorizontalScrollView {
        val keys = arrayOf(
            "ESC" to "\u001b", "TAB" to "\t", "|" to "|", "/" to "/", "-" to "-",
            "_" to "_", "\"" to "\"", "'" to "'", "(" to "(", ")" to ")",
            "[" to "[", "]" to "]", "{" to "{", "}" to "}", "<" to "<", ">" to ">",
            "&" to "&", "!" to "!", "^" to "^", "=" to "=", "+" to "+",
            "%" to "%", "#" to "#", "$" to "$", "~" to "~", "." to ".", "," to ",",
            ":" to ":", ";" to ";", "?" to "?", "*" to "*",
            "CTRL+C" to "\u0003", "CTRL+L" to "\u000c"
        )
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(6), dp(4), dp(6), dp(4))
        }
        for ((label, ch) in keys) {
            bar.addView(keyButton(label, ch))
        }
        return HorizontalScrollView(this).apply {
            setBackgroundColor(Ui.SURFACE_CONTAINER_HIGH)
            isHorizontalScrollBarEnabled = false
            addView(bar)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40))
        }
    }

    private fun keyButton(label: String, ch: String): TextView {
        return TextView(this).apply {
            text = label
            textSize = 11f
            setTextColor(Ui.TEXT_PRIMARY)
            gravity = Gravity.CENTER
            background = Ui.rounded(this@TerminalActivity, Ui.withAlpha(Ui.SURFACE_CONTAINER_HIGHEST, 0xE0), 8)
            setPadding(dp(10), 0, dp(10), 0)
            setOnClickListener {
                terminalView.requestFocus()
                runCatching { session?.write(ch) }
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT
            ).apply { rightMargin = dp(4) }
        }
    }

    private fun detectShell(): String {
        val candidates = arrayOf(
            File(filesDir, "termux/usr/bin/bash").absolutePath,
            "/data/data/com.termux/files/usr/bin/bash",
            "/bin/bash",
            "/system/bin/sh"
        )
        for (c in candidates) if (File(c).exists()) return c
        return "/system/bin/sh"
    }

    private fun detectHome(): String {
        val builtin = File(filesDir, "termux/home")
        if (builtin.exists() || builtin.mkdirs()) return builtin.absolutePath
        if (File("/data/data/com.termux/files/home").exists()) return "/data/data/com.termux/files/home"
        return "/"
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}