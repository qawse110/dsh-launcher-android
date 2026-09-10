package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * LauncherTemplate：web 启动脚本模板的双源一致性契约测试。
 *
 * `assets/web-launcher.sh.tpl` 与 [DshFlow.DEFAULT_WEB_LAUNCHER_TPL] 是同一契约的
 * 两份拷贝。渲染逻辑对模板做四次 `replace("@TOKEN@", ...)`——若某一源缺令牌，
 * 渲染**不会报错**，而是把 `@TOKEN@` 原样留在脚本里被 bash 当命令执行/当字面量，
 * 表现为难定位的启动失败（如漏 `@EXPORTS@` → 引擎缺环境变量起不来）。
 * 本测试把该契约钉死：两源的占位符集合必须完全一致，且都被渲染逻辑消费。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class LauncherTemplateTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    /** 渲染逻辑实际消费的令牌（与 DshFlow 内的 replace 调用一一对应）。 */
    private val renderedTokens = listOf("@EXPORTS@", "@HOME@", "@NODE_CMD@", "@LOG_FILE@")

    private val tokenRegex = Regex("@[A-Z_]+@")

    private fun tokensOf(text: String): Set<String> =
        tokenRegex.findAll(text).map { it.value }.toSet()

    /** 读取 APK/assets 内的模板；Robolectric 下 assets 可见（isIncludeAndroidResources=true）。 */
    private fun assetTpl(): String? = runCatching {
        ctx.assets.open(DshFlow.WEB_LAUNCHER_TPL).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrNull()

    @Test fun `资产模板含全部被渲染的令牌`() {
        val tpl = assetTpl() ?: return // 无 assets 环境（纯 JVM）时跳过
        val tokens = tokensOf(tpl)
        assertEquals(
            "assets/${DshFlow.WEB_LAUNCHER_TPL} 占位符与渲染逻辑不一致——" +
                "缺令牌会在渲染后留下未替换的 @TOKEN@ 字面量",
            renderedTokens.toSet(),
            tokens,
        )
    }

    @Test fun `兜底模板与渲染令牌完全一致`() {
        assertEquals(
            "DEFAULT_WEB_LAUNCHER_TPL 占位符与渲染逻辑不一致",
            renderedTokens.toSet(),
            tokensOf(DshFlow.DEFAULT_WEB_LAUNCHER_TPL),
        )
    }

    @Test fun `兜底模板与资产模板令牌集合等价（双源漂移保险）`() {
        val tpl = assetTpl() ?: return
        assertEquals(
            "两份模板的占位符集合漂移：资产=${tokensOf(tpl)} 兜底=${tokensOf(DshFlow.DEFAULT_WEB_LAUNCHER_TPL)}",
            tokensOf(tpl),
            tokensOf(DshFlow.DEFAULT_WEB_LAUNCHER_TPL),
        )
    }

    @Test fun `兜底模板具备启动脚本的必要结构`() {
        val tpl = DshFlow.DEFAULT_WEB_LAUNCHER_TPL
        // shebang 必须指向短前缀（官方二进制硬编码 31 字符 /data/data/com.termux/files/usr）
        assertTrue("模板缺少 shebang", tpl.startsWith("#!"))
        // HOME 未设置时 dsh 状态目录会落到不可写位置
        assertTrue("模板缺少 cd @HOME@（应用默认 cwd=/ 不可写）", tpl.contains("cd \"@HOME@\""))
        // 无 nohup/后台化则脚本会阻塞启动流程
        assertTrue("模板缺少后台化 nohup", tpl.contains("nohup"))
        // 日志必须重定向，否则输出丢失
        assertTrue("模板缺少日志重定向", tpl.contains("\"@LOG_FILE@\""))
    }
}
