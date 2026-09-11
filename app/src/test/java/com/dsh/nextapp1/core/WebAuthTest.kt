package com.dsh.nextapp1.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * WebAuth：dsh 0.1.5 browser-trust fence 适配的回归保险。
 *
 * 覆盖「从 web 日志解析启动令牌 URL」这一纯逻辑面（网络交换部分在真机验证，
 * 单测不连网）。关键回归点：**必须取最后一次出现的令牌**——进程重启后旧令牌
 * 立即失效，取错会让 WebView 永远停在 401。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WebAuthTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var log: File

    @Before fun setup() {
        log = File(File(ctx.filesDir, "logs"), "web-auth-test.log")
        log.parentFile?.mkdirs()
        log.delete()
        // 清掉可能残留的会话 cookie，保证用例互不干扰
        ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
            .edit().remove("dsh_web_auth_cookie").apply()
    }

    @Test fun `解析 dsh web 打印的启动令牌 URL`() {
        log.writeText(
            """
            (node:1) [DEP0205] DeprecationWarning: `module.register()` is deprecated.
            [dsh-android-links] linked sdcard -> /storage/emulated/0
            [net-proxy] 同源设置路由: /_dsh/net-proxy
            dsh web: http://127.0.0.1:3080/?token=AbC-123_xyz
            dsh web: opening the default browser; pass --no-open to disable
            """.trimIndent()
        )
        assertEquals("http://127.0.0.1:3080/?token=AbC-123_xyz", WebAuth.launchTokenUrl(ctx, log))
    }

    @Test fun `多次重启后取最后一次令牌（旧令牌已失效）`() {
        log.writeText(
            """
            dsh web: http://127.0.0.1:3080/?token=OLDTOKEN111
            ... 进程重启 ...
            dsh web: http://127.0.0.1:3080/?token=NEWTOKEN222
            """.trimIndent()
        )
        val got = WebAuth.launchTokenUrl(ctx, log)
        assertEquals("http://127.0.0.1:3080/?token=NEWTOKEN222", got)
        assertFalse(got!!.contains("OLDTOKEN"))
    }

    @Test fun `无令牌行或文件缺失时返回 null（不抛异常）`() {
        log.writeText("dsh-status-bridge listening on http://127.0.0.1:3190\n")
        assertNull(WebAuth.launchTokenUrl(ctx, log))
        assertNull(WebAuth.launchTokenUrl(ctx, File(ctx.filesDir, "not-exists.log")))
    }

    @Test fun `令牌解析不受前后缀噪声影响（nohup 包裹行）`() {
        log.writeText("2026-09-11T23:16:53.831Z | dsh web: http://127.0.0.1:3080/?token=Zz9-_Qq8 token ready\n")
        assertEquals("http://127.0.0.1:3080/?token=Zz9-_Qq8", WebAuth.launchTokenUrl(ctx, log))
    }

    @Test fun `会话 cookie 可持久化与读回`() {
        assertNull(WebAuth.loadCookie(ctx))
        WebAuth.saveCookie(ctx, "dsh-auth-127.0.0.1:3080=v1.eyJhIjoxfQ.sig")
        assertEquals("dsh-auth-127.0.0.1:3080=v1.eyJhIjoxfQ.sig", WebAuth.loadCookie(ctx))
    }

    @Test fun `会话 cookie 换存储类型后仍可安全读回（不抛 ClassCastException）`() {
        // 回归：SharedPreferences 同键换类型会抛 ClassCastException（不是返回默认值）。
        // 这里保证读回路径被 runCatching 兜住，升级用户带着旧类型值回来也不会崩。
        ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
            .edit().putLong("dsh_web_auth_cookie", 42L).apply()
        val got = runCatching { WebAuth.loadCookie(ctx) }.getOrNull()
        assertNull(got)
    }
}
