package com.dsh.nextapp1.core

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * dsh web 浏览器信任栅栏（browser-trust fence）适配。
 *
 * ## 背景：dsh 0.1.5 引入的破坏性变更
 *
 * 0.1.1 时代 `GET /` 无凭据即返回 200，启动器直接 `loadUrl` 即可。
 * **0.1.5 起 host 侧新增 authority 绑定的浏览器会话鉴权**（实现见
 * `@deepseek-ai/dsh-client-connection` 的 `BrowserAuth`）：
 *
 * | 请求 | 0.1.1 | 0.1.5 |
 * |---|---|---|
 * | `GET /`（无凭据，即使 loopback） | 200 | **401** |
 * | `GET /api`（无凭据） | 放行 | **401** |
 * | `GET /assets/*`（静态资产） | 200 | 200（栅栏不拦静态） |
 * | `GET /?token=<启动令牌>` | — | **303** + 下发 `dsh-auth-<authority>` cookie |
 * | `GET /`（带该 cookie） | — | 200 |
 *
 * 启动令牌**每进程随机生成**（`randomBytes(32)`），只打印在 web 日志里：
 * `dsh web: http://127.0.0.1:3080/?token=...`。
 * 换取的 cookie 用**持久密钥**签名（存在 credentials 里，30 天有效），
 * 且 audience 绑定 `host:port`——故 cookie 一旦拿到，后续进程重启仍然有效，
 * 只要端口不变。
 *
 * ## 本对象负责什么
 *
 * 1. [isFenced]：判定当前 dsh 版本是否启用栅栏（探测 `/` 返回 401/403）。
 * 2. [launchTokenUrl]：从 web 日志解析带启动令牌的 URL。
 * 3. [ensureSession]：用启动令牌换 cookie 并持久化，供后续请求复用。
 * 4. [authenticatedUrl]：给 WebView 用的入口 URL。
 *
 * 兼容性：0.1.1（无栅栏）下 [isFenced] 恒 false，全部逻辑退化为「直接开根路径」，
 * 行为与升级前完全一致。
 */
internal object WebAuth {

    private const val TAG = "WebAuth"

    /** 持久化 cookie 的键（Cookie 头原始值，形如 `dsh-auth-<authority>=v1.xxx`）。 */
    private const val PREF_COOKIE = "dsh_web_auth_cookie"

    /** 启动令牌 URL 的匹配式（token 为 base64url 字符集）。
     *  host 放宽到任意回环写法，避免 dsh 换用 localhost 打印时失配。 */
    private val TOKEN_URL_RE = Regex("""http://(?:127\.0\.0\.1|localhost|\[::1\]):\d+/\?token=[A-Za-z0-9_-]+""")

    /** 读日志尾部窗口：令牌行总在启动后最后几行，64KB 足够且开销恒定。 */
    private const val TAIL_BYTES = 64 * 1024

    /**
     * 栅栏下的「未授权」判定：`/` 返回 401/403 即视为启用了浏览器信任栅栏。
     * 200..399 表示无需鉴权（0.1.1 行为或已带 cookie）。
     */
    fun isFenced(port: Int, cookie: String? = null): Boolean = when (probeRoot(port, cookie)) {
        401, 403 -> true
        else -> false
    }

    /** 探测根路径，返回 HTTP 状态码；网络异常返回 -1。 */
    private fun probeRoot(port: Int, cookie: String?): Int {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("http://127.0.0.1:$port/").openConnection() as HttpURLConnection
            conn.connectTimeout = 800
            conn.readTimeout = 800
            conn.requestMethod = "GET"
            conn.instanceFollowRedirects = false
            if (!cookie.isNullOrBlank()) conn.setRequestProperty("Cookie", cookie)
            conn.responseCode
        } catch (e: Exception) {
            -1
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /**
     * 从 web 日志尾部解析启动令牌 URL。
     *
     * 日志行形如（可能被 nohup/前后缀包裹）：
     *   `dsh web: http://127.0.0.1:3080/?token=XXXX`
     *
     * 只认**最后一次**出现的令牌：进程重启后旧令牌立即失效，取最新才能对上。
     *
     * 只读文件尾部 [TAIL_BYTES]：web.log 由 nohup 重定向持续追加、不轮转，
     * 长期运行可达数十 MB，全量 readText 会在打开 WebView 时造成明显卡顿。
     * 令牌行总在日志尾部附近（启动后最后几行），读尾部足够且开销恒定。
     */
    fun launchTokenUrl(ctx: Context, logFile: File): String? {
        val text = runCatching { readTail(logFile, TAIL_BYTES) }.getOrNull() ?: return null
        return TOKEN_URL_RE.findAll(text).lastOrNull()?.value
    }

    /** 读取文件末尾最多 maxBytes 字节；从中间截断时丢弃首个可能残缺的行。 */
    private fun readTail(file: File, maxBytes: Int): String {
        if (!file.isFile) return ""
        val len = file.length()
        if (len <= 0L) return ""
        val start = if (len > maxBytes) len - maxBytes else 0L
        val buf = ByteArray((len - start).toInt())
        java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(start)
            raf.readFully(buf)
        }
        val s = String(buf, Charsets.UTF_8)
        return if (start > 0L) s.substringAfter('\n', s) else s
    }

    /**
     * 用启动令牌换取浏览器会话 cookie 并持久化。
     *
     * 流程：`GET /?token=…` → 303 + `Set-Cookie: dsh-auth-<authority>=…`。
     * 成功返回 cookie 原始值（`name=value`），失败返回 null。
     *
     * 注意：换取的 cookie 绑定 `host:port`（authority），端口变化即失效。
     */
    fun ensureSession(ctx: Context, port: Int, tokenUrl: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(tokenUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 3_000
            conn.readTimeout = 3_000
            conn.requestMethod = "GET"
            // 手动处理 303：需要读取 Set-Cookie，不能让 JDK 自动跟随（跨请求丢 cookie）
            conn.instanceFollowRedirects = false
            val code = conn.responseCode
            if (code != 303 && code != 302) {
                AppLog.i(TAG, "token exchange unexpected status=$code")
                return null
            }
            val setCookie = conn.headerFields.entries
                .firstOrNull { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                ?.value?.firstOrNull()
            val pair = setCookie?.substringBefore(';')?.trim()
            if (pair.isNullOrBlank() || !pair.startsWith("dsh-auth-")) {
                AppLog.i(TAG, "token exchange: no usable dsh-auth cookie (got=${setCookie?.take(40)})")
                return null
            }
            saveCookie(ctx, pair)
            AppLog.i(TAG, "browser session cookie acquired (${pair.substringBefore('=')})")
            pair
        } catch (e: Exception) {
            AppLog.i(TAG, "ensureSession failed: ${e.message}")
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    fun saveCookie(ctx: Context, cookie: String) {
        runCatching {
            ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
                .edit().putString(PREF_COOKIE, cookie).apply()
        }
    }

    fun loadCookie(ctx: Context): String? = runCatching {
        ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
            .getString(PREF_COOKIE, null)
    }.getOrNull()

    /**
     * 给 WebView 用的入口 URL。
     *
     * 优先复用已持久化的 cookie：**若 cookie 仍有效**（探测 `/` 得 200/303）则直接开
     * 根路径，避免每次都往 URL 上挂一次性令牌（令牌每进程变，且被记进 WebView 历史）。
     * cookie 失效（如端口变化/凭据被清）时才退回「用日志里的启动令牌重新换一次」。
     *
     * 全部失败（例如 0.1.1 无栅栏，或栅栏启用但日志尚无令牌）时返回根路径——
     * 与升级前行为一致，不会把「打不开」变成新的失败模式。
     */
    fun entryUrl(ctx: Context, port: Int, logFile: File): String {
        val base = "http://127.0.0.1:$port/"
        // 0.1.1 或已授权：根路径即可
        val saved = loadCookie(ctx)
        if (!isFenced(port, saved)) return base
        // 栅栏启用且 cookie 无效 → 用日志里的启动令牌重新换 cookie
        val tokenUrl = launchTokenUrl(ctx, logFile)
        if (tokenUrl != null) {
            val cookie = ensureSession(ctx, port, tokenUrl)
            if (cookie != null && !isFenced(port, cookie)) return base
            // 换取后仍被拒（cookie 无效/authority 不匹配）→ 直接用带令牌 URL 兜底，
            // 让 dsh 自己完成 303 与 cookie 下发（WebView 会保存 cookie）。
            return tokenUrl
        }
        // 拿不到令牌：仍开根路径（至少能看到 401 提示），不阻断启动
        AppLog.i(TAG, "fence active but no launch token in log yet")
        return base
    }
}
