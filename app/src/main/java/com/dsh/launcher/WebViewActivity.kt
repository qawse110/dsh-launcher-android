package com.dsh.launcher

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

/**
 * 内嵌 dsh Web UI 的界面。
 * dsh 运行在 127.0.0.1:3080，通过本地明文 HTTP 访问。
 */
class WebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorView: LinearLayout

    /** codex://new?prompt=... 等 deep link 带入的指令，页面就绪后自动填入输入框。 */
    private var pendingPrompt: String? = null
    private var promptInjected = false

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
        val progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
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
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                errorView.visibility = View.GONE
                webView.visibility = View.VISIBLE
                progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progressBar.visibility = View.GONE
                maybeInjectPrompt()
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

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val TARGET_URL = "http://127.0.0.1:3080"
    }
}
