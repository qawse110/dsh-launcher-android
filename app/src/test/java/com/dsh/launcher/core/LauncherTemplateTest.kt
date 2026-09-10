package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

    /**
     * 渲染逻辑实际消费的令牌（在测试里**独立写死**作为第二来源交叉校验：
     * 若有人改了 `DshFlow.WEB_LAUNCHER_TOKENS` 却漏改渲染逻辑，此处会失败）。
     */
    private val renderedTokens = listOf("@EXPORTS@", "@HOME@", "@NODE_CMD@", "@LOG_FILE@")

    @Test fun `生产令牌常量与本测试独立清单一致`() {
        assertEquals(
            "DshFlow.WEB_LAUNCHER_TOKENS 与本测试的独立契约清单漂移",
            renderedTokens,
            DshFlow.WEB_LAUNCHER_TOKENS,
        )
    }

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

    // ---------------- 出现次数（Set 比对抓不到重复，是真机缺陷的盲区） ----------------

    /**
     * **每个占位符在模板中必须恰好出现一次**。
     *
     * 此前测试用 `Set<String>` 比对令牌集合，**重复出现会被静默折叠**——于是漏掉了
     * 真机缺陷：模板注释里写着「可用占位符：@EXPORTS@ …」作为说明，渲染是纯 `replace`，
     * **注释里的占位符被一并展开**，生成一条真实执行的杂散命令（exit=126）。
     * 集合相等照样通过，因为注释里那份和真正那份是同一个字符串。
     *
     * 计数才是正确的判据：模板里每个 token 只能有一处（即它的真实位置）。
     */
    @Test fun `资产模板每个占位符恰好出现一次`() {
        val tpl = assetTpl() ?: return
        for (t in DshFlow.WEB_LAUNCHER_TOKENS) {
            assertEquals(
                "assets/${DshFlow.WEB_LAUNCHER_TPL} 中 $t 出现次数应为 1——" +
                    "多于 1 说明注释/文档里也写了占位符字面量，渲染会把它一起展开成杂散命令",
                1,
                tpl.split(t).size - 1,
            )
        }
    }

    @Test fun `兜底模板每个占位符恰好出现一次`() {
        for (t in DshFlow.WEB_LAUNCHER_TOKENS) {
            assertEquals(
                "DEFAULT_WEB_LAUNCHER_TPL 中 $t 出现次数应为 1",
                1,
                DshFlow.DEFAULT_WEB_LAUNCHER_TPL.split(t).size - 1,
            )
        }
    }

    // ---------------- 渲染结果（端到端） ----------------

    private fun renderAsset(): String? {
        val tpl = assetTpl() ?: return null
        return DshFlow.renderWebLauncher(
            tpl = tpl,
            exports = "export A=1\nexport B=2\n",
            home = "/HOME",
            nodeCmd = "NODE_CMD",
            logFile = "/LOG",
        )
    }

    @Test fun `渲染后不残留任何占位符`() {
        val out = renderAsset() ?: return
        val leftover = tokensOf(out)
        assertTrue("渲染后仍残留占位符 $leftover", leftover.isEmpty())
    }

    /**
     * 端到端护栏：渲染出的脚本里，除预期的 export / cd / nohup / echo 外**不得有条目
     * 以非命令字符开头的杂散行**。这是上面那个真机缺陷的直接形态——注释被展开后，
     * 生成的行形如 ` /home NODE_CMD /LOG`（前导空格 + 绝对路径），会被 bash 当命令执行。
     */
    @Test fun `渲染结果没有杂散可执行行`() {
        val out = renderAsset() ?: return
        val stray = out.lines().filter { line ->
            val t = line.trim()
            t.isNotEmpty() &&
                !t.startsWith("#") &&
                !t.startsWith("export ") &&
                !t.startsWith("cd ") &&
                !t.startsWith("nohup ") &&
                !t.startsWith("echo ") &&
                !t.startsWith("#!/")
        }
        assertTrue(
            "渲染脚本出现非预期命令行（疑似模板注释里的占位符被展开）：$stray",
            stray.isEmpty(),
        )
    }

    @Test fun `渲染结果保留 shebang 且导出集落在 cd 之前`() {
        val out = renderAsset() ?: return
        assertTrue("渲染后 shebang 丢失", out.startsWith("#!/"))
        val cdIdx = out.indexOf("cd \"/HOME\"")
        val expIdx = out.indexOf("export A=1")
        assertTrue("导出集未被注入", expIdx >= 0)
        // cd 必须在 nohup 之前；导出集在 cd 之前
        assertTrue("导出集应位于 cd 之前", expIdx < cdIdx)
        assertTrue("cd 应位于 nohup 之前", cdIdx < out.indexOf("nohup"))
    }

    // ---------------- shebang 必须指向真实存在的 bash（prefix 语义） ----------------

    /**
     * **短前缀 `t` 已经是 `usr` 的别名**（`<dataDir>/t -> <filesDir>/termux/usr`），
     * 因此 bash 的正确路径是 `…/t/bin/bash`，**不是** `…/t/usr/bin/bash`。
     *
     * 真机实证（2026-09-10）：模板 shebang 多写了一层 `/usr`，直接执行得到
     * `bad interpreter: No such file or directory`（exit=126）。当时没暴露是因为
     * 两条调用路径都写成 `bash <script>`（显式传解释器），shebang 从未被内核读取——
     * 又一个「靠巧合工作」：换一种执行方式（`./dsh-web.sh`，或被别处以 shebang 调用）
     * 就会立刻失败。
     *
     * 本测试把 prefix 语义钉死：shebang 必须是 `<SHORT_PREFIX>/bin/bash`。
     */
    @Test fun `资产模板 shebang 指向短前缀下的 bash 且不含多余 usr`() {
        val tpl = assetTpl() ?: return
        val shebang = tpl.lineSequence().firstOrNull { it.startsWith("#!") }
        assertNotNull("模板缺少 shebang", shebang)
        assertEquals(
            "shebang 必须是 ${PrefixPatcher.SHORT_PREFIX}/bin/bash（t 即 usr 的别名）",
            "#!${PrefixPatcher.SHORT_PREFIX}/bin/bash",
            shebang,
        )
        assertFalse(
            "shebang 不得写成 t/usr/bin/bash——t 已等价于 usr，多一层会 bad interpreter",
            shebang!!.contains("/t/usr/"),
        )
    }

    @Test fun `兜底模板 shebang 同样指向短前缀下的 bash`() {
        val shebang = DshFlow.DEFAULT_WEB_LAUNCHER_TPL.lineSequence()
            .firstOrNull { it.startsWith("#!") }
        assertEquals(
            "兜底模板 shebang 必须是 ${PrefixPatcher.SHORT_PREFIX}/bin/bash",
            "#!${PrefixPatcher.SHORT_PREFIX}/bin/bash",
            shebang,
        )
    }

    /**
     * 短前缀必须与官方前缀**等长**——[PrefixPatcher] 对二进制做等长字节替换，
     * 长度不等会直接拒绝打补丁（对全部 ELF 静默失效）。
     */
    @Test fun `短前缀与官方前缀等长`() {
        assertEquals(
            "前缀等长是二进制等长替换的前提",
            PrefixPatcher.OFFICIAL_PREFIX.length,
            PrefixPatcher.SHORT_PREFIX.length,
        )
    }
}
