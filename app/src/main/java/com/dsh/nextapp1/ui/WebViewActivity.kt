package com.dsh.nextapp1.ui

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
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
import android.widget.Toast
import java.io.File
import java.net.URLDecoder
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

    /**
     * 根容器。**必须是成员**：onDestroy 要先把 webView 从父容器摘下来再 destroy，
     * 而局部变量在 onDestroy 里拿不到（见 onDestroy 的说明）。
     */
    private var rootView: FrameLayout? = null

    /** codex://new?prompt=... 等 deep link 带入的指令，页面就绪后自动填入输入框。 */
    private var pendingPrompt: String? = null
    private var promptInjected = false

    /**
     * 多窗口（agent 新建页）容器与子 WebView 集合。
     *
     * 为什么需要多窗口：ego-browser 每个工具的第一步都是
     * useSpace -> createTaskSpace -> Target.createTarget，而本机唯一可用的
     * Chromium 能力就是本应用自己的 System WebView（设备上没有任何
     * Chrome/Chromium 可执行文件）。实测该 WebView 的 Target.createTarget 恒返回
     * "Not supported"，但**每个 WebView 实例都会在同一进程的 devtools socket 上
     * 注册成独立的 page target** —— 所以「CDP 建页」可以等价成「window.open 一次」，
     * 由这里的 onCreateWindow 真正造出第二个 WebView。
     *
     * ⚠️ 真机实测的关键安全约束：**未**开启多窗口时，window.open(url,"_blank")
     * 不会被忽略，而是把**当前页**导航到该 url（本轮实测把用户的 dsh GUI 导航成了
     * about:blank，已恢复）。所以 setSupportMultipleWindows(true) 与 onCreateWindow
     * 必须同时成立，否则宁可不做。
     */
    /** agent 页的容器：压在 GUI **之下**（索引 0），避免遮住 dsh 界面。 */
    private var popupLayer: FrameLayout? = null

    /** 插件/用户自己开的窗口（如 codearts 登录小窗）：放在**最上层**，必须可见。 */
    private var userPopupLayer: FrameLayout? = null

    private val popups = mutableListOf<WebView>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        pendingPrompt = intent?.data?.getQueryParameter("prompt")

        webView = createWebView()

        val root = FrameLayout(this).apply {
            setBackgroundColor(Ui.BG)
        }
        rootView = root

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
                injectDownloadHelper(view)
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

            /**
             * agent 要求新建页（CDP 的 Target.createTarget 被中继改写成页面侧
             * window.open）时的落地实现：造一个真正独立的 WebView。
             *
             * 它是独立实例 ⇒ WebView 会把它注册成同一 devtools socket 上的另一个
             * page target ⇒ ego 那边就看到了「新标签页」。
             */
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                val msg = resultMsg ?: return false
                // 多窗口关闭时 window.open 会导航当前页而不是失败 ——
                // 拒绝打开，让 window.open 变成 no-op，绝不牺牲用户界面。
                // ⚠️ 这个方法名没有 get 前缀（Android 的 getter 就叫 supportMultipleWindows()），
                //    Kotlin 不会合成属性，必须带括号调用，否则编译报
                //    "Function invocation 'supportMultipleWindows()' expected"。
                if (!webView.settings.supportMultipleWindows()) return false
                return runCatching { openPopupWebView(msg) }
                    .onFailure { AppLog.e(TAG, "onCreateWindow failed: " + it.message) }
                    .getOrDefault(false)
            }

            /** 新页被 window.close() 关掉时把子 WebView 收掉（否则会漏渲染进程）。 */
            override fun onCloseWindow(window: WebView?) {
                if (window == null) return
                if (window === webView) return // 主界面不归这里管
                runCatching { destroyPopup(window) }
            }
        }

        webView.settings.apply {
            // ⚠️ 两句都不能少：真机实测「未开多窗口」时 window.open(url,"_blank")
            // 不会失败，而是把**当前页**导航到该 url（本轮实测把用户的 dsh GUI
            // 导航成了 about:blank）。让 onCreateWindow 接住它，原页才不动。
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
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

    /**
     * 释放 WebView。**这是本 Activity 唯一的清理点，缺了它就会漏渲染进程**。
     *
     * 真机实测（反复进出 WebViewActivity 5 次，dumpsys meminfo / ps）：
     *   修复前：app PSS +1,653 K，WebView 渲染进程 RSS 合计 248,772 K → 347,380 K
     *           （+98,608 K ≈ +96 MB），且 Activity 栈里已无 WebViewActivity 时
     *           两个渲染进程仍在跑（存活 1h+）。
     * 根因：webView 是 Activity 成员（L38 声明、L52 new），而整个文件此前**没有
     * onDestroy**，也没有 destroy()/removeAllViews() ⇒ Activity 销毁后 WebView
     * 仍持有渲染进程与 JS 上下文，每进出一次多留一份。
     *
     * 三步缺一不可：
     *   ① 从父容器摘下来 —— 否则 destroy() 后视图树仍持有已销毁 WebView 的引用；
     *   ② destroy() —— 真正释放渲染进程与 JS 引擎；
     *   ③ 置空引用 —— 让 Activity 与 WebView 互相不再可达（防 Activity 泄漏）。
     *
     * 注意：只 destroy 不摘父容器、或只摘父容器不 destroy，都回收不掉渲染进程。
     */
    override fun onDestroy() {
        // 导出临时文件属于本次会话：销毁时清掉，别留在 cacheDir 里占空间。
        runCatching {
            saveDialogPending?.file?.delete()
            saveDialogPending = null
            saveQueue.forEach { it.file.delete() }
            saveQueue.clear()
            saveDialogActive = false
        }
        // 先收子 WebView：多窗口的 agent 页也是活的渲染进程，不收就会漏。
        popups.toList().forEach { runCatching { destroyPopup(it) } }
        popups.clear()
        popupLayer = null
        userPopupLayer = null
        rootView?.let { root ->
            root.removeAllViews()
        }
        rootView = null
        if (::webView.isInitialized) {
            // ⚠️ 每步**单独** runCatching：整段包一个 try 的话，前面任一步抛异常都会把
            //    后面的 destroy() 一起跳过 —— 而 destroy() 才是真正释放渲染进程的那一步。
            runCatching { webView.stopLoading() }
            runCatching { webView.webChromeClient = null }
            // 换一个空 WebViewClient：避免旧 client 的闭包继续引用本 Activity
            runCatching { webView.webViewClient = object : WebViewClient() {} }
            runCatching { (webView.parent as? ViewGroup)?.removeView(webView) }
            runCatching { webView.removeAllViews() }
            runCatching { webView.destroy() }
        }
        super.onDestroy()
    }

    /**
     * 系统内存吃紧时把 WebView 的缓存/渲染缓冲还给系统。
     *
     * 背景（实测）：app 主进程 PSS 里 Graphics(EGL+GL) 占 76 MB（42%），是最大单项；
     * 该 Activity 常驻在返回栈里时，这份图形内存会一直挂着。
     * TRIM_MEMORY_UI_HIDDEN（回到后台、UI 不可见）时清缓存是 Android 官方推荐做法：
     * 此时用户看不到页面，丢掉缓存不影响观感，下次可见时 WebView 自行重建。
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN && ::webView.isInitialized) {
            runCatching {
                webView.clearCache(false)
                webView.freeMemory()
            }
        }
    }

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

    /**
     * 为 window.open 造一个真实的子 WebView，并把它交给 WebViewTransport。
     *
     * 关键点（真机约束，不是可选项）：
     *   · 必须真的 addView 到已 attach 的窗口上，否则该 WebView 不渲染、也不会注册成
     *     devtools target —— ego 那边就看不到新页。
     *   · ★ 弹层必须加在索引 0（最底层），压在 dsh GUI 的 WebView **下面**。
     *     早期版本把它铺在顶层（MATCH_PARENT + 不透明背景），后果是：ego 一开页，
     *     用户的 dsh GUI 就被整屏盖住；而关页在这台设备上又不可靠（window.close() 不回包，
     *     Target.closeTarget 也被 WebView 忽略），于是 GUI **永久**不可见，只能重启应用。
     *     真机反馈原话：「启动多窗口方案时原 dsh webUI 也不可见了」。
     *   · 放底层为什么仍可用：真机在 /json/list 里见过 visible=false 的 target 仍然
     *     注册良好、尺寸正常（1264x2640）；而中继判断「页面」时从不读 visible 字段。
     *     即 ego 要的是「target 存在 + viewport 尺寸正常」，不是「人眼看得见」。
     *     ✅ 该前提已于 2026-10-12 在真机正面验证（新 APK + 本地内容服务器探针）：
     *     被 GUI 覆盖的底层页仍能加载、执行 JS 并取回真实内容
     *     （rawHasMark=true / hasMark=true），同时 GUI 全程 visible=true、url 未变。
     *     证据见 docs/ci-evidence/raw/new-apk-verify.txt 第 3 节。
     *   · 子 WebView 自己也要有 WebChromeClient，否则它再开新页会被静默忽略。
     */
    private fun openPopupWebView(resultMsg: Message): Boolean {
        // ★ 两类窗口分两层，判据由**发起方**（中继）留下的标记决定：
        //   · agent 造的页 → popupLayer，索引 0 = GUI 之下（否则遮住 dsh 界面）；
        //   · 其它（插件/用户自己 window.open 的登录小窗）→ userPopupLayer，最上层可见。
        //   为什么不能用 isUserGesture：插件是先 await RPC 再 window.open，手势已丢
        //   （lib/client/jet-hub.js:5955 实测如此），isUserGesture 恒 false。
        val isAgent = isAgentWindowMarkerFresh()
        val layer = if (isAgent) {
            popupLayer ?: newPopupLayer().also {
                popupLayer = it
                // 索引 0 = 最底层：让 agent 页压在 GUI 下面。
                rootView?.addView(it, 0)
            }
        } else {
            userPopupLayer ?: newPopupLayer().also {
                userPopupLayer = it
                // 默认 appendChild = 最顶层：登录小窗必须看得见。
                rootView?.addView(it)
            }
        }

        val child = createWebView()
        child.settings.apply {
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
        }
        // 子页与主页面**能力等价**：导出/保存同样要能用，否则「插件设置页能导出、
        // agent 页不能」这类半残会一直复发。
        child.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                injectDownloadHelper(view)
            }
        }
        child.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                msg: Message?
            ): Boolean {
                val m = msg ?: return false
                return runCatching { openPopupWebView(m) }.getOrDefault(false)
            }

            override fun onCloseWindow(window: WebView?) {
                if (window == null) return
                runCatching { destroyPopup(window) }
            }
        }

        layer.addView(child, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        popups.add(child)

        // 兜底：真机上 onCloseWindow 依赖页面的关闭回包，而 WebView 有时不回
        // （见 gui-occlusion-defect.md）。弹层现在压在最底层、不遮挡 GUI，但子
        // WebView 是活的渲染进程，不回收会一直占内存。这里给一个硬上限：
        // 超出就销毁最旧的那个。ego 的 useSpace 复用已有页，正常不会触顶。
        while (popups.size > MAX_POPUPS) {
            val oldest = popups.firstOrNull() ?: break
            runCatching { destroyPopup(oldest) }
                .onFailure { popups.remove(oldest) }
        }

        // 必须交回一个已 attach 的 WebView，新窗口才有渲染进程与 devtools target。
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        transport.webView = child
        resultMsg.sendToTarget()
        AppLog.i(TAG, "popup WebView created (total=" + popups.size + ")")
        return true
    }

    /** 销毁一个子 WebView；三步与主界面 onDestroy 同理（摘父容器 → destroy → 置空）。 */
    private fun destroyPopup(window: WebView) {
        if (!popups.remove(window)) return
        runCatching { window.stopLoading() }
        runCatching { window.webChromeClient = null }
        runCatching { window.webViewClient = object : WebViewClient() {} }
        runCatching { (window.parent as? ViewGroup)?.removeView(window) }
        runCatching { window.removeAllViews() }
        runCatching { window.destroy() }
        // 哪一层空了就撤哪一层（两层互相独立，不能因为另一层还有页就把这层留着）。
        popupLayer?.let { l ->
            if (l.childCount == 0) {
                runCatching { rootView?.removeView(l) }
                popupLayer = null
            }
        }
        userPopupLayer?.let { l ->
            if (l.childCount == 0) {
                runCatching { rootView?.removeView(l) }
                userPopupLayer = null
            }
        }
        AppLog.i(TAG, "popup WebView destroyed (remaining=" + popups.size + ")")
    }

    /** 新建一个铺满父容器的弹层容器。 */
    private fun newPopupLayer(): FrameLayout = FrameLayout(this).apply {
        setBackgroundColor(Ui.BG)
        layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
    }

    /** 中继留下的「这次 window.open 来自 agent」标记文件（与中继同一个 state 目录）。 */
    private fun agentWindowFlagFile(): File {
        val xdg = System.getenv("XDG_STATE_HOME")
        val base = if (!xdg.isNullOrBlank()) xdg else File(filesDir, ".local/state").absolutePath
        return File(base, "ego-lite-linux/agent-window.flag")
    }

    /**
     * 该标记是否新鲜；**缺省一律按「不是 agent 窗口」**（false）。
     *
     * 读不到 / 解析不了 / 过期 都返回 false ⇒ 放到最上层可见。这个默认是刻意的：
     * 判错的代价不对称 —— 把 agent 页错放最上层只是挡一会儿界面，而把用户的登录
     * 小窗错藏到 GUI 后面，就是「点了登录没反应」（本轮 codearts 的实际故障）。
     */
    private fun isAgentWindowMarkerFresh(maxAgeMs: Long = 4_000L): Boolean = runCatching {
        val f = agentWindowFlagFile()
        if (!f.isFile) return@runCatching false
        val ts = f.readText().trim().toLongOrNull() ?: return@runCatching false
        val age = System.currentTimeMillis() - ts
        age in 0..maxAgeMs
    }.getOrDefault(false)

    // ── 下载 / 导出 ────────────────────────────────────────────────────────
    //
    // 页面侧（dsh 本体与各插件）导出文件统一是 new Blob(...) + a[download].click()。
    // WebView 对这类下载**什么都不做也不报错** —— 用户点了「导出备份」像没点一样。
    // 这里补齐整条链路：页面侧取内容（assets/webview-download.js）→ JS 桥分块 →
    // 临时文件 → SAF 保存弹窗 → 落到用户选的位置。

    /** 一次等待用户选保存位置的导出。 */
    private data class PendingSave(val file: File, val name: String, val mime: String)

    /**
     * 待保存队列。一次只弹一个系统保存面板：连点导出时若并发弹窗，用户会面对
     * 好几个同名对话框，且后一个会覆盖前一个的状态。
     */
    private val saveQueue = mutableListOf<PendingSave>()

    /** 每个 WebView 的导出凭证（跟随页面注入，随 WebView 回收）。 */
    private val pageNonces = java.util.WeakHashMap<WebView, String>()
    private var saveDialogPending: PendingSave? = null
    private var saveDialogActive = false

    /**
     * 新建一个能力等价的 WebView：主界面、onCreateWindow 造出的子页、插件弹窗全走这里。
     *
     * 为什么必须收敛成工厂：此前主页面与子页各复制一份 settings，能力只加在一处，
     * 结果就是「主页面能做的事、window.open 出来的页做不到」这类半残。凡是
     * window.open 造出来的页，都必须和主页面同一套能力。
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val wv = WebView(this)
        wv.setBackgroundColor(Ui.BG)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        // 页面 → 宿主：Blob 导出/下载的唯一落盘入口（鉴权、分块拼装都在这个类里）。
        // nonce 每个 WebView 一份：JS 接口对所有 frame 可见，跨源 iframe 读不到父页变量，
        // 因此没有 nonce 就调不动这条写盘通道。
        val nonce = WebDownloadBridge.newId()
        pageNonces[wv] = nonce
        wv.addJavascriptInterface(
            WebDownloadBridge(
                context = this,
                pageUrl = { wv.url },
                pageNonce = nonce,
                onReady = { file, name, mime -> enqueueSave(file, name, mime) },
                onError = { reason ->
                    AppLog.e(TAG, "导出失败: " + reason)
                    runOnUiThread {
                        if (!isFinishing && !isDestroyed) toast("导出失败：" + reason)
                    }
                },
            ),
            WebDownloadBridge.JS_NAME,
        )
        // 兜底通道：页面侧钩子没接住时（未注入成功、iframe 内点击、普通直链），
        // WebView 仍会把下载请求抛到这里。
        wv.setDownloadListener { url, userAgent, disposition, mimetype, _ ->
            onDownloadStart(wv, url, userAgent, disposition, mimetype)
        }
        return wv
    }

    /** 注入页面侧导出助手（脚本自带幂等守卫，重复注入是空操作）。 */
    private fun injectDownloadHelper(view: WebView?) {
        val target = view ?: webView
        val script = downloadHelperScript() ?: return
        val nonce = pageNonces[target] ?: ""
        // 凭证必须在脚本之前写入：脚本只在安装那一刻读取它。
        val payload = "window.__dshDownloadNonce=" + org.json.JSONObject.quote(nonce) + ";" + script
        runCatching { target.evaluateJavascript(payload, null) }
            .onFailure { AppLog.e(TAG, "注入导出助手失败: " + it.message) }
    }

    private fun downloadHelperScript(): String? {
        downloadScriptCache?.let { return it }
        val script = runCatching {
            assets.open(ASSET_DOWNLOAD_JS).bufferedReader().use { it.readText() }
        }.getOrElse {
            AppLog.e(TAG, "读取 " + ASSET_DOWNLOAD_JS + " 失败: " + it.message)
            null
        }
        if (script != null) downloadScriptCache = script
        return script
    }

    /**
     * 原生下载兜底。
     *
     * 关键判断：blob: / data: 的内容只有页面读得到，原生只拿到一串不可读的 URL，
     * 所以这类请求必须回头让页面侧读出来（pull）。同源 http(s) 同理走页面取回，
     * 这样能带上会话 cookie，也不会在系统下载器里留一条 127.0.0.1 的怪记录。
     * 只有真正的远端直链才交给系统下载器。
     */
    private fun onDownloadStart(
        view: WebView,
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val target = url ?: return
        val name = WebDownloadBridge.sanitizeFileName(
            fileNameFromDisposition(contentDisposition),
            mimeType,
        )
        AppLog.i(
            TAG,
            "下载请求 scheme=" + target.substringBefore(':') + " name=" + name + " mime=" + mimeType,
        )
        val localSource = target.startsWith("http://127.0.0.1") ||
            target.startsWith("http://localhost") ||
            target.startsWith("file://")
        if (target.startsWith("blob:") || target.startsWith("data:") || localSource) {
            injectDownloadHelper(view)
            val js = "window.__dshDownload && window.__dshDownload.pull(" +
                org.json.JSONObject.quote(target) + "," +
                org.json.JSONObject.quote(name) + "," +
                org.json.JSONObject.quote(mimeType ?: "") + ")"
            view.evaluateJavascript(js, null)
            return
        }
        downloadWithSystem(target, userAgent, mimeType, name)
    }

    /** 从 Content-Disposition 取文件名（含 RFC 5987 的 filename*=UTF-8''... 形式）。 */
    private fun fileNameFromDisposition(disposition: String?): String? {
        val d = disposition ?: return null
        val lowered = d.lowercase()
        val starIdx = lowered.indexOf("filename*=")
        if (starIdx >= 0) {
            var v = d.substring(starIdx + 10).trim().substringBefore(';').trim()
            val sep = v.indexOf("''")
            if (sep >= 0) v = v.substring(sep + 2)
            return runCatching { URLDecoder.decode(v, "UTF-8") }.getOrNull()
        }
        val idx = lowered.indexOf("filename=")
        if (idx < 0) return null
        var v = d.substring(idx + 9).trim().substringBefore(';').trim()
        if (v.length >= 2 && v.first() == '"' && v.last() == '"') {
            v = v.substring(1, v.length - 1)
        }
        return v.ifBlank { null }
    }

    /** 远端直链交给系统下载器：它有进度通知，也不占用本进程内存。 */
    private fun downloadWithSystem(
        url: String,
        userAgent: String?,
        mimeType: String?,
        name: String,
    ) {
        val manager = getSystemService(DOWNLOAD_SERVICE) as? DownloadManager
        if (manager == null) {
            toast("系统下载器不可用")
            return
        }
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            if (!mimeType.isNullOrBlank()) setMimeType(mimeType)
            if (!userAgent.isNullOrBlank()) addRequestHeader("User-Agent", userAgent)
            val cookie = runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()
            if (!cookie.isNullOrBlank()) addRequestHeader("Cookie", cookie)
            setTitle(name)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            // 放应用私有外部目录：无需存储权限，也不会在 Android 11+ 撞分区存储限制。
            setDestinationInExternalFilesDir(
                this@WebViewActivity,
                Environment.DIRECTORY_DOWNLOADS,
                name,
            )
        }
        runCatching { manager.enqueue(request) }
            .onSuccess { toast("已开始下载：" + name) }
            .onFailure {
                AppLog.e(TAG, "系统下载失败: " + it.message)
                toast("下载失败：" + (it.message ?: "未知错误"))
            }
    }

    // ── 保存弹窗（SAF）────────────────────────────────────────────────────

    /** 桥线程入口：先排队，再回到主线程弹系统保存面板。 */
    private fun enqueueSave(file: File, name: String, mime: String) {
        runOnUiThread {
            if (isFinishing || isDestroyed) {
                file.delete()
                return@runOnUiThread
            }
            saveQueue.add(PendingSave(file, name, mime))
            pumpSaveQueue()
        }
    }

    private fun pumpSaveQueue() {
        if (saveDialogActive) return
        val next = saveQueue.removeFirstOrNull() ?: return
        if (!next.file.isFile || next.file.length() <= 0L) {
            AppLog.e(TAG, "临时文件缺失或为空，跳过保存: " + next.name)
            next.file.delete()
            pumpSaveQueue()
            return
        }
        saveDialogActive = true
        saveDialogPending = next
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = next.mime.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, next.name)
        }
        val launched = runCatching { startActivityForResult(intent, REQ_SAVE_DOCUMENT) }.isSuccess
        if (!launched) {
            // 设备上没有文件选择器（精简 ROM）：退到应用私有下载目录，并明确告知路径，
            // 而不是让导出静默失败。
            AppLog.e(TAG, "SAF 不可用，回退到应用私有目录")
            saveDialogActive = false
            saveDialogPending = null
            fallbackSave(next)
            pumpSaveQueue()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_SAVE_DOCUMENT) {
            val save = saveDialogPending
            saveDialogPending = null
            saveDialogActive = false
            if (save == null) {
                pumpSaveQueue()
                return
            }
            val uri = if (resultCode == RESULT_OK) data?.data else null
            if (uri == null) {
                AppLog.i(TAG, "用户取消保存 name=" + save.name)
                toast("已取消保存")
                save.file.delete()
                pumpSaveQueue()
                return
            }
            copyToDestination(save, uri)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    /** 把临时文件复制到用户选的 Uri（后台线程，避免大文件卡住界面）。 */
    private fun copyToDestination(save: PendingSave, uri: Uri) {
        Thread {
            var error: String? = null
            try {
                val out = contentResolver.openOutputStream(uri, "wt")
                    ?: throw IllegalStateException("目标不可写")
                out.use { sink ->
                    save.file.inputStream().use { input -> input.copyTo(sink) }
                }
            } catch (t: Throwable) {
                error = t.message ?: t.javaClass.simpleName
            }
            val failed = error
            runOnUiThread {
                if (failed == null) {
                    AppLog.i(TAG, "已保存 name=" + save.name + " uri=" + uri)
                    toast("已保存：" + save.name)
                } else {
                    AppLog.e(TAG, "保存失败 name=" + save.name + " err=" + failed)
                    toast("保存失败：" + failed)
                }
                save.file.delete()
                pumpSaveQueue()
            }
        }.start()
    }

    /** 无 SAF 时的兜底落盘（应用私有外部目录，不需要任何权限）。 */
    private fun fallbackSave(save: PendingSave) {
        Thread {
            val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
            runCatching { if (!dir.isDirectory) dir.mkdirs() }
            val target = File(dir, save.name)
            val ok = runCatching {
                save.file.inputStream().use { input ->
                    target.outputStream().use { out -> input.copyTo(out) }
                }
            }.isSuccess
            runOnUiThread {
                if (!ok) {
                    AppLog.e(TAG, "兜底保存失败 name=" + save.name)
                    toast("保存失败：" + save.name)
                } else {
                    AppLog.i(TAG, "兜底保存到 " + target.absolutePath)
                    toast("已保存到 " + target.absolutePath)
                }
                save.file.delete()
            }
        }.start()
    }

    private fun toast(text: String) {
        runCatching { Toast.makeText(this, text, Toast.LENGTH_LONG).show() }
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
        private const val TAG = "WebViewActivity"

        /** 页面侧导出助手（assets 内，随 APK 发布；见该文件的头注释）。 */
        private const val ASSET_DOWNLOAD_JS = "webview-download.js"

        /** SAF 保存请求码。 */
        private const val REQ_SAVE_DOCUMENT = 0x0D1E

        /** 注入脚本只读一次：每次页面完成都从 assets 解压读文本没必要。 */
        @Volatile
        private var downloadScriptCache: String? = null

        /** 子 WebView 存活上限（回收兜底；正常远不会触顶）。 */
        private const val MAX_POPUPS = 4
        private const val TARGET_URL = "http://127.0.0.1:" + com.dsh.nextapp1.core.DshFlow.WEB_PORT
    }
}
