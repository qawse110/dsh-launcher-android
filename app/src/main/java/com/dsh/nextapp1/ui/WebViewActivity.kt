package com.dsh.nextapp1.ui

import android.annotation.SuppressLint
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
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
import java.io.File
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import com.dsh.nextapp1.core.*
import com.dsh.nextapp1.overlay.*
import com.dsh.nextapp1.service.*
import com.dsh.nextapp1.tts.*
import com.dsh.nextapp1.ui.*
import com.dsh.nextapp1.R

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
                injectComposerLayoutFix()
                injectBackNavigation()
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

        // dsh 0.1.5 起根路径受 browser-trust fence 保护（无凭据 401），
        // 必须带浏览器会话（cookie）或启动令牌才能进 UI——见 WebAuth。
        loadWebUi()
    }

    /**
     * 返回键：**优先做 Web 页面后退**，历史耗尽才离开 WebUI。
     *
     * 旧实现无条件 `super.onBackPressed()`（直接回启动器主界面），理由是
     * 「dsh 是 SPA，浏览器级回退没意义」。该前提经真机实测**只对了一半**：
     *
     *   · dsh 前端确实**一次都不写 History**（主 bundle 与全部插件 client bundle 的
     *     pushState/replaceState/history.back/go 全为 0 命中），所以**开箱时**
     *     `canGoBack()` 恒为 false —— 直接改判 `canGoBack()` 会是空操作；
     *   · 但 History 栈**本身可用**（真机探针：`history.pushState` 让 history.length
     *     1→2 成功），dsh 的「页面」是设置面板/目录抽屉这类**可关闭的层**。
     *
     * 故配套由 [injectBackNavigation] 在页面侧把这些层登记进 History（层打开时
     * pushState、返回时点关闭控件），使 `canGoBack()` 对「打开了一个面板」为真。
     * 这样返回键的语义就是：**先退层，层退完再退页面，都退完才离开 WebUI**。
     */
    /** 防止连按返回时并发询问页面（询问是异步的）。 */
    private var backProbePending = false

    override fun onBackPressed() {
        // ① 真实页面导航优先（URL 变过的话 canGoBack 才为真）
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        // ② dsh 的「层」不进 WebView 历史（真机实测：pushState 只改 JS 的
        //    history.length，WebView.canGoBack() 仍为 false），所以改**问页面**：
        //    页面侧检测到可关闭层就关掉并回 '1'，否则回 '0' 由我们退出。
        if (backProbePending) return
        backProbePending = true
        webView.evaluateJavascript(
            "(function(){try{return (window.__dshBackNav && window.__dshBackNav.handleBack()) ? '1' : '0';}catch(e){return '0';}})()"
        ) { result ->
            backProbePending = false
            if (result == null || !result.contains("1")) super.onBackPressed()
        }
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

    /**
     * 在页面侧提供 `window.__dshBackNav.handleBack()`，让返回键能退掉 dsh 的
     * 「可关闭层」（设置面板 / 目录抽屉等）。
     *
     * **为什么不是 `webView.canGoBack()`**：真机实测两条都成立——
     *   ① dsh 前端**从不写 History**（主 bundle 与全部插件 client bundle 的
     *      pushState/replaceState/history.back/go 全 0 命中），栈里恒为 1 条；
     *   ② 即使我们在页面里 `history.pushState`（JS 侧 length 确实 1→2，探针实测），
     *      **`WebView.canGoBack()` 依然返回 false** —— 它只认真正的导航条目，
     *      不认同文档 pushState。
     * 所以「判 canGoBack + goBack」对 dsh 是死路，改为**Kotlin 主动问页面**：
     * [onBackPressed] 调本函数，页面有层就关掉并回 '1'，没有则回 '0' 交回 Kotlin 退出。
     *
     * **为什么认文案不认类名**：dsh 的 class 是构建期哈希，每次发版都变
     * （同 injectComposerLayoutFix 的判断）。这里按无障碍名/文本匹配，真机取证到
     * 两种形态：设置面板的「关闭」、目录抽屉的「点击关闭目录」。
     * 匹配不到就回 '0'，行为退化为旧实现（直接离开 WebUI）——本注入是增强，不是前提。
     */
    private fun injectBackNavigation() {
        val js = """
            (function(){
              if (window.__dshBackNav) return 'skip';
              // 层的关闭控件：无障碍名/文字匹配（无类名依赖，发版哈希变了也不影响）
              var CLOSE_RE = /^(关闭|点击关闭目录|返回|关闭目录|Close)$/;
              function closeControl(){
                var els = document.querySelectorAll('button,[role=button]');
                for (var i = 0; i < els.length; i++) {
                  var el = els[i];
                  var r = el.getBoundingClientRect();
                  if (r.width < 8 || r.height < 8) continue;
                  var cs = getComputedStyle(el);
                  if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                  var label = (el.getAttribute('aria-label') || el.textContent || '').trim();
                  if (CLOSE_RE.test(label)) return el;
                }
                return null;
              }
              window.__dshBackNav = {
                // 有层则关掉并返回 true；无层返回 false（由 Kotlin 决定是否退出）
                handleBack: function(){
                  var c = closeControl();
                  if (!c) return false;
                  try { c.click(); } catch (e) { return false; }
                  return true;
                },
                hasLayer: function(){ return closeControl() !== null; }
              };
              return 'ok';
            })();
        """.trimIndent()
        webView.evaluateJavascript(js) { }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /**
     * 加载 WebUI 入口。
     *
     * 0.1.1（无栅栏）→ 直接根路径，行为与升级前一致。
     * 0.1.5（browser-trust fence）→ 先确保拿到浏览器会话 cookie，**注入 WebView 自己的
     * cookie jar**（WebView 与 HttpURLConnection 不共享 cookie，只存 pref 不注入是没用的），
     * 再开根路径；cookie 拿不到时退回「带启动令牌的 URL」，让 dsh 自己完成 303 下发。
     *
     * 网络探测有超时，故整体放后台线程，回主线程再 loadUrl。
     */
    private fun loadWebUi() {
        val logFile = File(FileLog.dir(this), DshFlow.WEB_LOG)
        Thread {
            val url = runCatching { WebAuth.entryUrl(this, DshFlow.WEB_PORT, logFile) }
                .getOrDefault(TARGET_URL)
            val cookie = runCatching { WebAuth.loadCookie(this) }.getOrNull()
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (cookie.isNullOrBlank()) {
                    webView.loadUrl(url)
                } else {
                    // 注入后需 flush 才保证随首个请求发出（API 21+ 的异步回调版本）
                    CookieManager.getInstance().setCookie(url, cookie) {
                        runCatching { CookieManager.getInstance().flush() }
                        if (!isFinishing && !isDestroyed) webView.loadUrl(url)
                    }
                }
            }
        }.start()
    }

    companion object {
        private const val TARGET_URL = "http://127.0.0.1:" + com.dsh.nextapp1.core.DshFlow.WEB_PORT
    }
}
