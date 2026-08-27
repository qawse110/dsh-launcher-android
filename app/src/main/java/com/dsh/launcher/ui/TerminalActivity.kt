package com.dsh.launcher.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import java.io.File
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

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
    private lateinit var ctrlBadge: TextView
    private var session: TerminalSession? = null
    private var currentTextSize = 16
    /** Termux 风格：按一下音量键 = Ctrl 修饰键（针对硬件键盘；软键盘用底部 CTRL 键）。
     *  下次任意字母键按下即发送 Ctrl+字母，并自动清除。 */
    private var ctrlModifier = false

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)

        terminalView = TerminalView(this, null)
        terminalView.setTerminalViewClient(this)
        terminalView.setTextSize(currentTextSize)
        terminalView.setBackgroundColor(0xFF0B0B0F.toInt())
        terminalView.isFocusableInTouchMode = true
        terminalView.contentDescription = "dsh 内置终端"

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
        // Termux 风格 Ctrl 修饰键徽章：按音量键激活后显示，发送后自动隐藏
        ctrlBadge = TextView(this).apply {
            text = "⌃ Ctrl"
            textSize = 11f
            setTextColor(Ui.BRAND)
            background = Ui.rounded(this@TerminalActivity, Ui.withAlpha(Ui.BRAND, 0x22), 6)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            visibility = View.GONE
        }
        val pasteBtn = Ui.button(this, "📋 粘贴", { pasteFromClipboard() }, filled = false, compact = true)
        val fontMinusBtn = Ui.button(this, "A−", { setFontSize(currentTextSize - 1) }, filled = false, compact = true)
        val fontPlusBtn = Ui.button(this, "A+", { setFontSize(currentTextSize + 1) }, filled = false, compact = true)
        val restartBtn = Ui.button(this, "⟳ 重启", { restartSession() }, filled = false, compact = true)
        val exitBtn = Ui.button(this, "✕ 退出", { maybeExit() }, filled = false, compact = true, color = Ui.DANGER)

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Ui.SURFACE_CONTAINER_HIGH)
            setPadding(dp(8), 0, dp(8), 0)
            addView(statusLabel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(4)
            })
            addView(ctrlBadge, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { rightMargin = dp(4) })
            addView(fontLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
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

        // ── 提示条：返回键可退出、辅助功能提示 ───────────
        root.addView(TextView(this).apply {
            text = "返回键退出 · 音量键=下一按 Ctrl（硬件键盘）· 长按选词可复制"
            textSize = 10f
            setTextColor(Ui.TEXT_MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(3), 0, dp(3))
            setBackgroundColor(Ui.SURFACE_CONTAINER_LOW)
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(20)
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
            // Termux 风格：进入终端直接弹出软键盘，避免再点一次
            runOnUiThread {
                terminalView.requestFocus()
                val ime = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                ime.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    /** 创建 shell 会话；TerminalSession 只构造，真正的 PTY 由 attach 后的 size 回调创建。 */
    private fun createSession(): TerminalSession {
        // 唯一环境：内置 Termux —— 缺失时同步准备（首次 10~60 秒）
        if (!TermuxRuntime.isBashReady(this)) {
            android.widget.Toast.makeText(this, "正在准备内置 Termux 环境（10~60 秒）…", android.widget.Toast.LENGTH_SHORT).show()
            runCatching { TermuxRuntime.ensureExtracted(this) { } }
        }
        val shell = detectShell()
        val home = detectHome()
        // 环境统一由 TermuxEnv 构造（架构方案 P0-1）
        val env = TermuxEnv.terminalSessionEnv(this)
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

    /**
     * 按键可靠处理：
     * - 返回键：TerminalView 持有焦点时会拦截按键，导致系统返回不生效
     *   （表现为「进入终端后无法返回」）。这里在 Activity 层直接接管返回键：
     *   软键盘展开时先收键盘；否则退出（有运行中的命令先弹确认）。
     * - 音量键：Termux 风格——按一下音量下/上 = 激活 Ctrl 修饰（硬件键盘用），
     *   下一个字母键按下即发送 Ctrl+字母；激活时顶栏显示 ⌃ Ctrl 徽章。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN &&
            useVolumeCtrl() &&
            (event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || event.keyCode == KeyEvent.KEYCODE_VOLUME_UP)
        ) {
            ctrlModifier = true
            updateCtrlBadge()
            // 安全网：5 秒内没按下字母键则自动取消修饰，避免误触后残留
            terminalView.postDelayed({
                if (ctrlModifier) {
                    ctrlModifier = false
                    updateCtrlBadge()
                }
            }, 5000)
            return true // 拦截：不调节音量，作为 Ctrl 修饰
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            val ime = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            if (ime.isAcceptingText) {
                ime.hideSoftInputFromWindow(currentFocus?.windowToken, 0)
                terminalView.requestFocus()
            } else {
                maybeExit()
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** 退出终端：会话里还有活动命令时先确认，避免误触返回键丢掉会话。 */
    private fun maybeExit() {
        val pid = session?.getPid()?.takeIf { it > 0 } ?: 0
        if (pid <= 0) {
            finish()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("退出终端？")
            .setMessage("终端会话中可能还有正在运行的命令，退出将终止该会话。")
            .setPositiveButton("退出", { _, _ -> finish() })
            .setNegativeButton("取消", null)
            .show()
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
    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean {
        // Termux 风格：ctrlModifier 激活后，下一个字母键按下即发送 Ctrl+字母并清除
        if (ctrlModifier) {
            ctrlModifier = false
            updateCtrlBadge()
            val c = ctrlCode(keyCode)
            if (c > 0) {
                session.write("" + c.toChar())
                return true
            }
            // 非字母键：当作取消修饰，继续默认处理
            return false
        }
        return false
    }
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
        // 参考 Termux 快捷条：ESC/TAB、方向键（历史/行内移动）、常用符号、
        // CTRL 组合键（视觉高亮）——软键盘打不出的键都放这里
        val keys = arrayOf(
            "ESC" to "\u001b", "TAB" to "\t",
            "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C",
            "|" to "|", "/" to "/", "-" to "-", "_" to "_",
            "\"" to "\"", "'" to "'", "(" to "(", ")" to ")",
            "[" to "[", "]" to "]", "{" to "{", "}" to "}", "<" to "<", ">" to ">",
            "&" to "&", "!" to "!", "^" to "^", "=" to "=", "+" to "+",
            "%" to "%", "#" to "#", "$" to "$", "~" to "~", "." to ".", "," to ",",
            ":" to ":", ";" to ";", "?" to "?", "*" to "*", "@" to "@",
            "CTRL+C" to "\u0003", "CTRL+D" to "\u0004", "CTRL+Z" to "\u001A",
            "CTRL+L" to "\u000c", "CTRL+U" to "\u0015"
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
        val isCtrl = label.startsWith("CTRL")
        return TextView(this).apply {
            text = label
            textSize = 11f
            gravity = Gravity.CENTER
            if (isCtrl) {
                // CTRL 组合键高亮：品牌色描边文字，一眼区分
                setTextColor(Ui.BRAND)
                background = Ui.rounded(this@TerminalActivity, Ui.withAlpha(Ui.BRAND, 0x1F), 8)
            } else {
                setTextColor(Ui.TEXT_PRIMARY)
                background = Ui.rounded(this@TerminalActivity, Ui.withAlpha(Ui.SURFACE_CONTAINER_HIGHEST, 0xE0), 8)
            }
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

    // ---- Termux 风格音量=Ctrl 辅助 ----

    private fun termPrefs() = getSharedPreferences(AppState.Prefs.UI, Context.MODE_PRIVATE)

    /** 音量键 → Ctrl 修饰开关（默认开；设置页/未来 UI 可关）。 */
    private fun useVolumeCtrl(): Boolean = termPrefs().getBoolean("term_volume_ctrl", true)

    /** KEYCODE_A..Z → Ctrl 控制码（1..26）；其它键返回 -1。 */
    private fun ctrlCode(keyCode: Int): Int {
        val a = KeyEvent.KEYCODE_A
        val z = KeyEvent.KEYCODE_Z
        return if (keyCode in a..z) keyCode - a + 1 else -1
    }

    private fun updateCtrlBadge() {
        ctrlBadge.visibility = if (ctrlModifier) View.VISIBLE else View.GONE
    }

    /** v4.5 唯一 shell：内置 Termux bash（createSession 已确保就绪）。 */
    private fun detectShell(): String = File(filesDir, "termux/usr/bin/bash").absolutePath

    private fun detectHome(): String {
        val builtin = File(filesDir, "termux/home")
        if (builtin.exists() || builtin.mkdirs()) return builtin.absolutePath
        return filesDir.absolutePath
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}