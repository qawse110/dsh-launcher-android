package com.dsh.nextapp1.core

import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * WebView 页面 → 宿主的**唯一**导出通道。
 *
 * 背景：dsh 的 Web UI 与各插件导出文件都走 new Blob(...) + a[download].click()
 * （jet hub 账号备份是最典型的一处）。WebView 对 blob: 下载既不触发下载也不报错，
 * 而 blob: URL 在原生侧不可读 —— 所以内容只能由页面侧读出、分块递交到这里。
 *
 * 职责边界（刻意划死，避免变成万能数据总线）：
 *   · 本类**只**负责「把分块拼成一个临时文件」：cacheDir/webview-downloads/<id>.part；
 *   · 落地到哪里、是否弹保存框，由 onReady 的接收方决定（WebViewActivity 走 SAF）；
 *   · 只接受**可信来源**（见 [isAllowedOrigin]）：dsh 本机页面 / 本地文件页 / 页面自己
 *     造出来的 blob:、data:。远程页面（ego 浏览器的任意站点）一律拒绝，否则任何
 *     网页都能往用户磁盘写文件。
 *
 * 线程：@JavascriptInterface 方法由 WebView 的 JavaBridge 线程调用（**不是** UI 线程），
 * 因此这里的文件 IO 不会卡界面；onReady / onError 也在该线程触发，接收方自己负责
 * 切回主线程。
 */
class WebDownloadBridge(
    private val context: Context,
    private val pageUrl: () -> String?,
    /**
     * 本 WebView 的页面凭证：注入脚本前写入 window.__dshDownloadNonce，begin 必须带上。
     * 作用：JS 接口对**所有 frame** 都可见，远端 iframe 能直接调到这里；跨源 iframe
     * 读不到父页的 JS 变量，因此拿不到 nonce，也就无法借本桥往用户磁盘写文件。
     */
    private val pageNonce: String,
    private val onReady: (file: File, name: String, mime: String) -> Unit,
    private val onError: (reason: String) -> Unit,
) {

    /** 一次进行中的导出。 */
    private class Sink(
        val id: String,
        val file: File,
        val out: FileOutputStream,
        val name: String,
        val mime: String,
    ) {
        var bytes: Long = 0L
    }

    private val lock = Any()
    private var sink: Sink? = null

    /**
     * 开始一次导出。返回 token（空串 = 拒绝），页面凭它提交分块。
     *
     * @param name     页面给的期望文件名（可为空）
     * @param mime     页面给的 MIME（可为空）
     * @param expected 页面声明的字节数（blob.size，未知时为 0）
     */
    @JavascriptInterface
    fun begin(nonce: String?, name: String?, mime: String?, expected: Long): String {
        if (nonce == null || nonce != pageNonce) {
            // 不弹 toast：这可能是被嵌入的第三方 frame 在探路，别给它任何可见反馈。
            AppLog.e(TAG, "拒绝导出：页面凭证不符")
            return ""
        }
        val page = pageUrl()
        if (!isAllowedOrigin(page)) {
            AppLog.e(TAG, "拒绝导出：来源不可信 page=" + (page ?: "null"))
            onError("当前页面不允许保存文件")
            return ""
        }
        if (expected > MAX_BYTES) {
            AppLog.e(TAG, "拒绝导出：体积超限 expected=" + expected)
            onError("文件过大（" + humanSize(expected) + "），上限 " + humanSize(MAX_BYTES))
            return ""
        }

        val finalName = sanitizeFileName(name, mime)
        val finalMime = resolveMime(mime, finalName)
        val dir = File(context.cacheDir, DIR_NAME)

        var out: FileOutputStream? = null
        var file: File? = null
        var token = ""
        try {
            if (!dir.isDirectory && !dir.mkdirs()) throw IllegalStateException("无法创建缓存目录")
            pruneOldFiles(dir)
            token = newId()
            val f = File(dir, token + SUFFIX)
            out = FileOutputStream(f)
            file = f
        } catch (t: Throwable) {
            AppLog.e(TAG, "导出初始化失败: " + t.message)
            runCatching { out?.close() }
            runCatching { file?.delete() }
            onError("无法创建临时文件：" + (t.message ?: "未知错误"))
            return ""
        }

        val fresh = Sink(
            id = token,
            file = file!!,
            out = out!!,
            name = finalName,
            mime = finalMime,
        )
        synchronized(lock) {
            val prev = sink
            sink = fresh
            if (prev != null) closeQuietly(prev, deleteFile = true)
        }
        AppLog.i(TAG, "导出开始 name=" + finalName + " mime=" + finalMime + " declared=" + expected)
        return fresh.id
    }

    /**
     * 追加一块 base64。返回 false 表示 token 不对/已结束/解码失败 —— 页面据此中止。
     * 超限时直接中止并清理，绝不落一个被截断的文件。
     */
    @JavascriptInterface
    fun chunk(id: String?, base64: String?): Boolean {
        val target = synchronized(lock) { sink }
        if (target == null || id == null || id != target.id) return false
        if (base64 == null || base64.isEmpty()) return true
        val bytes = try {
            Base64.decode(base64, Base64.NO_WRAP)
        } catch (t: Throwable) {
            synchronized(lock) { closeQuietly(target, deleteFile = true); sink = null }
            onError("数据块解码失败")
            return false
        }
        val written = synchronized(lock) {
            if (sink !== target) return false
            if (target.bytes + bytes.size > MAX_BYTES) {
                closeQuietly(target, deleteFile = true)
                sink = null
                return false
            }
            try {
                target.out.write(bytes)
                target.bytes += bytes.size
                true
            } catch (t: IOException) {
                closeQuietly(target, deleteFile = true)
                sink = null
                onError("写入失败：" + (t.message ?: "IO 错误"))
                false
            }
        }
        return written
    }

    /** 收尾：校验总字节数与页面声明是否一致，然后交给 onReady。 */
    @JavascriptInterface
    fun finish(id: String?, total: Long): Boolean {
        val target = synchronized(lock) {
            val current = sink
            if (current == null || id == null || id != current.id) return false
            sink = null
            current
        }
        closeQuietly(target, deleteFile = false)
        if (total > 0 && total != target.bytes) {
            AppLog.e(TAG, "导出长度不符 name=" + target.name + " declared=" + total + " actual=" + target.bytes)
            target.file.delete()
            onError("文件不完整（收到 " + target.bytes + " / 声明 " + total + " 字节）")
            return false
        }
        if (target.bytes <= 0) {
            target.file.delete()
            onError("导出内容为空")
            return false
        }
        AppLog.i(TAG, "导出完成 name=" + target.name + " bytes=" + target.bytes)
        onReady(target.file, target.name, target.mime)
        return true
    }

    /** 页面主动放弃（读 blob 失败、分块被拒等）。 */
    @JavascriptInterface
    fun abort(id: String?, reason: String?) {
        val target = synchronized(lock) {
            val current = sink
            if (current == null || id == null || id != current.id) return
            sink = null
            current
        }
        closeQuietly(target, deleteFile = true)
        AppLog.e(TAG, "导出中止 name=" + target.name + " reason=" + (reason ?: "未知"))
        onError(reason ?: "导出被中止")
    }

    private fun closeQuietly(target: Sink, deleteFile: Boolean) {
        runCatching { target.out.flush() }
        runCatching { target.out.close() }
        if (deleteFile) runCatching { target.file.delete() }
    }

    companion object {
        /** 页面侧 addJavascriptInterface 用的名字，必须与 webview-download.js 一致。 */
        const val JS_NAME = "DshDownload"

        private const val TAG = "WebDownloadBridge"
        private const val DIR_NAME = "webview-downloads"
        private const val SUFFIX = ".part"
        private const val DEFAULT_NAME = "download"
        private const val MAX_NAME_CHARS = 120

        /** 单文件上限：账号备份这类 JSON 只有几十 KB，64 MB 足够且能挡住误操作。 */
        const val MAX_BYTES = 64L * 1024 * 1024

        /** 临时文件保留多久（防页面中途崩溃留下垃圾）。 */
        private const val STALE_MS = 24L * 60 * 60 * 1000

        fun newId(): String = UUID.randomUUID().toString().replace("-", "")

        /**
         * 可信来源白名单。**按 URL 显式判 origin，不按 scheme 猜**：
         *   · dsh 本体只跑在 127.0.0.1:<WEB_PORT>（也可能是 localhost/[::1] 写法）；
         *   · file:// 是本应用自己加载的本地页；
         *   · blob: / data: 只能由上面这些页面派生（WebView 只在同源 JS 上下文里暴露它们）。
         * 其余（任意 https 站点）一律拒绝 —— 那是 ego 浏览器打开的外部网页。
         */
        fun isAllowedOrigin(url: String?): Boolean {
            if (url.isNullOrBlank()) return false
            val u = url.trim()
            // blob:/data: 由页面自己产生、file:// 是本应用加载的本地页，都不含主机名。
            if (u.startsWith("blob:") || u.startsWith("data:") || u.startsWith("file://")) return true
            // 主机名必须**严格相等**地比对：startsWith("http://localhost") 会放过
            // localhost.evil.com 这类域名，等于白名单失效。
            val uri = runCatching { java.net.URI(u) }.getOrNull() ?: return false
            if (!"http".equals(uri.scheme, ignoreCase = true)) return false
            val host = uri.host?.lowercase() ?: return false
            return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
        }

        /**
         * 文件名清洗：去掉目录分隔符与控制字符，限长并保留扩展名。
         * 页面给的名字完全不可信（它可能来自导入的备份文件），必须当作不可信输入。
         */
        fun sanitizeFileName(raw: String?, mime: String?): String {
            var name = (raw ?: "").trim()
            name = name.substringAfterLast('/').substringAfterLast('\\')
            val cleaned = StringBuilder(name.length)
            for (ch in name) {
                val bad = ch == ':' || ch == '*' || ch == '?' || ch == '"' ||
                    ch == '<' || ch == '>' || ch == '|' || ch.code < 0x20 || ch.code == 0x7f
                cleaned.append(if (bad) '_' else ch)
            }
            name = cleaned.toString().trim().trim('.')
            if (name.length > MAX_NAME_CHARS) {
                val ext = name.substringAfterLast('.', "")
                name = if (ext.length in 1..12) {
                    name.dropLast(ext.length + 1).take(MAX_NAME_CHARS - ext.length - 1) + "." + ext
                } else {
                    name.take(MAX_NAME_CHARS)
                }
            }
            if (name.isEmpty() || name == "." || name == "..") name = DEFAULT_NAME
            if (!name.contains('.')) {
                val ext = extensionOf(mime)
                if (ext.isNotEmpty()) name += "." + ext
            }
            return name
        }

        /** 页面没给 MIME 时按扩展名反推，避免保存成 application/octet-stream。 */
        fun resolveMime(mime: String?, fileName: String): String {
            val m = (mime ?: "").trim()
            if (m.startsWith("application/") || m.startsWith("text/") ||
                m.startsWith("image/") || m.startsWith("audio/") ||
                m.startsWith("video/") || m == "application/json"
            ) {
                return m
            }
            val ext = fileName.substringAfterLast('.', "")
            if (ext.isEmpty()) return "application/octet-stream"
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase())
                ?: "application/octet-stream"
        }

        private fun extensionOf(mime: String?): String {
            val m = (mime ?: "").trim()
            if (m.isEmpty()) return ""
            return MimeTypeMap.getSingleton().getExtensionFromMimeType(m) ?: ""
        }

        private fun humanSize(bytes: Long): String = when {
            bytes >= 1024L * 1024L -> String.format("%.1f MB", bytes.toDouble() / (1024.0 * 1024.0))
            bytes >= 1024L -> String.format("%.1f KB", bytes.toDouble() / 1024.0)
            else -> bytes.toString() + " B"
        }

        private fun pruneOldFiles(dir: File) {
            val now = System.currentTimeMillis()
            runCatching {
                dir.listFiles()?.forEach { f ->
                    if (f.isFile && now - f.lastModified() > STALE_MS) f.delete()
                }
            }
        }
    }
}
