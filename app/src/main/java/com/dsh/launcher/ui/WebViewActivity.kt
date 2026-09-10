package com.dsh.launcher.ui

import android.annotation.SuppressLint
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import com.dsh.launcher.core.*
import com.dsh.launcher.R

/**
 * 内嵌 dsh Web UI 的界面。
 * dsh 运行在 127.0.0.1:3080，通过本地明文 HTTP 访问。
 */
class WebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorView: LinearLayout
    /** 顶部加载进度条（提为字段：autoRetryRunnable 亦需操作它）。 */
    private lateinit var progressBar: ProgressBar

    /** codex://new?prompt=... 等 deep link 带入的指令，页面就绪后自动填入输入框。 */
    private var pendingPrompt: String? = null
    private var promptInjected = false

    // —— WebView 渲染进程冻结看门狗（借鉴 dsh-mobile-apk issue #36 修复）——
    // 部分国产 ROM（荣耀 MagicUI 6.1/Android 12 等）渲染进程 JS 主线程会冻结：
    // 页面停在「Loading plugins…」且无诊断层，页面内定时器也跑不动。
    // 主线程周期 evaluateJavascript("1") 心跳：回调不再返回 = 渲染进程失活 →
    // Toast 提示 + 自动 reload 一次（单次自愈，避免 reload 循环）。
    private val freezeHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var jsAckAt = 0L
    private var pageLoadedAt = 0L
    private var pingOutstanding = false
    private var freezeReloaded = false
    private val freezeRunnable = object : Runnable {
        override fun run() {
            if (!this@WebViewActivity::webView.isInitialized || isFinishing ||
                webView.visibility != View.VISIBLE
            ) return
            val now = System.currentTimeMillis()
            if (pageLoadedAt > 0 && now - pageLoadedAt > 45_000 && now - jsAckAt > 20_000) {
                if (!freezeReloaded) {
                    freezeReloaded = true
                    try { webView.reload() } catch (_: Throwable) {}
                }
                jsAckAt = now
                pingOutstanding = false
            } else if (!pingOutstanding) {
                pingOutstanding = true
                try {
                    webView.evaluateJavascript("1") { _ ->
                        jsAckAt = System.currentTimeMillis()
                        pingOutstanding = false
                    }
                } catch (_: Throwable) {
                    pingOutstanding = false
                }
            }
            freezeHandler.postDelayed(this, 10_000)
        }
    }

    private fun startFreezeWatchdog() {
        if (isFinishing || !this@WebViewActivity::webView.isInitialized) return
        val now = System.currentTimeMillis()
        pageLoadedAt = now
        jsAckAt = now
        pingOutstanding = false
        freezeHandler.removeCallbacks(freezeRunnable)
        freezeHandler.postDelayed(freezeRunnable, 10_000)
    }

    private fun stopFreezeWatchdog() {
        freezeHandler.removeCallbacks(freezeRunnable)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        pendingPrompt = intent?.data?.getQueryParameter("prompt")

        webView = WebView(this)
        webView.setBackgroundColor(Ui.BG)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Ui.BG)
        }

        // 加载进度条
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = ColorStateList.valueOf(Ui.BRAND)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                dp(3),
                Gravity.TOP
            )
        }
        root.addView(progressBar)

        root.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // 离线/启动失败兜底页
        errorView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Ui.BG)
            setPadding(dp(28), dp(28), dp(28), dp(28))
            visibility = View.GONE
        }
        errorView.addView(TextView(this).apply {
            text = "🔌 无法连接 dsh 服务"
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
            gravity = Gravity.CENTER
        })
        errorView.addView(TextView(this).apply {
            text = "请确认 dsh 已启动，或返回主界面重新执行一键启动"
            textSize = 13f
            setTextColor(Ui.TEXT_SECONDARY)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(20))
        })
        errorView.addView(Ui.button(this, "重试", {
            autoRetryCount = 0
            autoRetryHandler.removeCallbacks(autoRetryRunnable)
            errorView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            webView.reload()
        }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        })
        errorView.addView(Ui.button(this, "返回主界面", {
            finish()
        }, filled = false).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        })
        root.addView(errorView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        setContentView(root)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // WebUI 全部经 http://127.0.0.1 提供（含附件图片），无 file:// 消费方；
            // 关闭文件访问收敛攻击面（页面本就受同源模型约束，行为不变）
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                autoRetryCount = 0
                autoRetryHandler.removeCallbacks(autoRetryRunnable)
                errorView.visibility = View.GONE
                webView.visibility = View.VISIBLE
                progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progressBar.visibility = View.GONE
                maybeInjectPrompt()
                injectComposerLayoutFix()
                startFreezeWatchdog()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                progressBar.visibility = View.GONE
                if (request?.isForMainFrame == true) {
                    webView.visibility = View.GONE
                    errorView.visibility = View.VISIBLE
                    scheduleAutoRetry()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
            }
        }

        webView.loadUrl(TARGET_URL)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        freezeHandler.removeCallbacks(freezeRunnable)
        autoRetryHandler.removeCallbacks(autoRetryRunnable)
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        stopFreezeWatchdog()
        autoRetryHandler.removeCallbacks(autoRetryRunnable)
        // 标准 WebView 收尾：先从视图树摘除再 destroy，否则窗口仍持有它导致泄漏
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // —— 主帧加载失败自动重试（借鉴参考实现 30s 间隔重试 + 最多 2 次退避）——
    // dsh web 可能仍在启动（首次引导未完成/看门狗正在拉起）：停留在错误页不代表
    // 引擎死了。主帧 error 时按 10s/20s/30s 间隔自动重载，成功（onPageStarted）
    // 即取消；用户手动点「重试」同样归零。
    private val autoRetryHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var autoRetryCount = 0
    private val autoRetryRunnable = object : Runnable {
        override fun run() {
            if (isFinishing || isDestroyed) return
            if (autoRetryCount >= 3) return
            autoRetryCount++
            errorView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            progressBar.visibility = View.VISIBLE
            try { webView.reload() } catch (_: Throwable) {}
        }
    }

    private fun scheduleAutoRetry() {
        if (isFinishing) return
        if (autoRetryCount >= 3) return
        autoRetryHandler.removeCallbacks(autoRetryRunnable)
        autoRetryHandler.postDelayed(autoRetryRunnable, 10_000L * (autoRetryCount + 1))
    }

    override fun onBackPressed() {
        // dsh WebUI 是 SPA：内部路由会向 WebView history 压入大量记录，
        // goBack 后视觉上往往没有变化，用户连按返回像"卡住无法退出"。
        // WebUI 有自己的导航（侧栏/抽屉），浏览器级回退没有意义——直接退出。
        super.onBackPressed()
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        // singleTask 复用实例：再次点 codex:// 链接时更新待注入指令
        intent?.data?.getQueryParameter("prompt")?.let {
            pendingPrompt = it
            promptInjected = false
            maybeInjectPrompt()
        }
    }

    /** 页面就绪后把 deep link 的 prompt 填入 WebUI 输入框（SPA 渲染延迟 1.2s 再试）。 */
    private fun maybeInjectPrompt() {
        val prompt = pendingPrompt?.takeIf { it.isNotBlank() } ?: return
        if (promptInjected) return
        webView.postDelayed({
            if (promptInjected || isFinishing) return@postDelayed
            promptInjected = true
            injectPrompt(prompt)
        }, 1_200L)
    }

    private fun injectPrompt(prompt: String) {
        val json = org.json.JSONObject.quote(prompt)
        val js = """
            (function(){
              var p = $json;
              var ta = document.querySelector('textarea');
              if (ta) {
                var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(ta, p);
                ta.dispatchEvent(new Event('input', {bubbles: true}));
                ta.focus();
                return 'ok';
              }
              var ce = document.querySelector('[contenteditable="true"]');
              if (ce) {
                ce.focus();
                document.execCommand('insertText', false, p);
                return 'ok';
              }
              return 'miss';
            })();
        """.trimIndent()
        webView.evaluateJavascript(js) { result ->
            if (result?.contains("ok") == true) {
                android.widget.Toast.makeText(this, "已填入指令，确认后发送即可", android.widget.Toast.LENGTH_SHORT).show()
            } else {
                // 兜底：找不到输入框就复制到剪贴板，用户手动粘贴
                val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("prompt", prompt))
                android.widget.Toast.makeText(this, "指令已复制，请在输入框粘贴", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * WebUI 输入框下方控件行的布局修复（上游 dsh 的样式问题，本地注入规避）：
     * 模型名 / 思考强度过长时模型座位变宽，把这一行挤到换行（该行是
     * flex-wrap:wrap + space-between），左侧控件因此被顶到上一行。
     * 上游 CSS 中「思考强度」是 flex:none（永不压缩），只有模型名在省略，
     * 所以光省略模型名压不掉整行宽度。
     *
     * 不依赖构建哈希类名（每次发版都会变）：改用结构特征定位——
     * button[aria-haspopup="menu"] 且有 >=2 个直接子 span（模型名 + 思考强度）。
     * 注入后由 MutationObserver + resize 自维持，SPA 重渲染后自动重贴。
     */
    private fun injectComposerLayoutFix() {
        val js = """
            (function(){
              if (window.__dshComposerFix) return 'skip';
              window.__dshComposerFix = true;

              function findModelTrigger(){
                var btns = document.querySelectorAll('button[aria-haspopup="menu"]');
                var fallback = null;
                for (var i = 0; i < btns.length; i++) {
                  var b = btns[i];
                  var spans = b.querySelectorAll(':scope > span');
                  if (spans.length < 2) continue;      // 模型名 + 思考强度
                  var title = b.getAttribute('title') || '';
                  if (title !== '') return b;           // 模型触发器带 title=模型名
                  if (!fallback) fallback = b;
                }
                return fallback;
              }
              function findWrapRow(t){
                var row = t.parentElement;
                while (row && row !== document.body) {
                  var cs = getComputedStyle(row);
                  if (cs.display === 'flex' && cs.flexWrap === 'wrap') return row;
                  row = row.parentElement;
                }
                return null;
              }
              function fix(){
                var t = findModelTrigger();
                if (!t) return false;
                var row = findWrapRow(t);
                // 去重键带上文案：切换模型/思考强度后文案变化也能重新评估
                var cap = 'min(190px,36cqw)';
                var key = cap + '|' + (t.textContent || '');
                if (t.__dshCap === key && (!row || row.style.flexWrap === 'nowrap')) return true;
                t.__dshCap = key;

                if (row) {
                  row.style.flexWrap = 'nowrap';
                  for (var r = 0; r < row.children.length; r++) {
                    var c = row.children[r];
                    if (c.style) { c.style.minWidth = '0'; c.style.flexShrink = '1'; }
                  }
                }
                t.style.maxWidth = cap;
                t.style.minWidth = '0';
                t.style.flexShrink = '1';
                var spans = t.querySelectorAll(':scope > span');
                for (var i = 0; i < spans.length; i++) {
                  var s = spans[i];
                  s.style.minWidth = '0';
                  s.style.overflow = 'hidden';
                  s.style.textOverflow = 'ellipsis';
                  s.style.whiteSpace = 'nowrap';
                  if (i > 0) s.style.flex = '0 1 auto';
                }
                if (spans.length > 1) {
                  spans[1].style.display = '';
                  if (t.scrollWidth > t.clientWidth + 2) spans[1].style.display = 'none';
                }
                return true;
              }
              var timer = null;
              function schedule(){
                if (timer) clearTimeout(timer);
                timer = setTimeout(fix, 60);
              }
              fix();
              setTimeout(fix, 800);
              new MutationObserver(schedule).observe(document.body, {childList:true, subtree:true});
              window.addEventListener('resize', schedule);
              return 'ok';
            })();
        """.trimIndent()
        webView.evaluateJavascript(js) { }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val TARGET_URL = "http://127.0.0.1:" + com.dsh.launcher.core.DshFlow.WEB_PORT
    }
}
