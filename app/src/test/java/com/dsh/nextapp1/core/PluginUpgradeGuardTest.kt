package com.dsh.nextapp1.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * 在线升级的两处 Kotlin 侧保险：
 *
 *   1) AssetSync.refreshBundledPluginCopies 的不降级守卫 —— 装新 APK 时出厂源
 *      **绝不能**把在线升级过的副本打回去（否则用户升完重装一次 APK 就白升了）。
 *   2) PluginUpgrade 的状态读取 —— 状态文件缺失必须如实反映为「未检查」，
 *      而不是被渲染成「已是最新」。
 *
 * 守卫语义与 install/plugins.mjs 的 syncExtraPlugin 严格对齐：
 * 版本不可解析时 **fail-open**（照常刷新），只有「本地明确更新」才跳过。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PluginUpgradeGuardTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    // ── 不降级守卫 ────────────────────────────────────────

    private fun plugin(dir: File, name: String, version: String?, body: String) {
        File(dir, "lib").mkdirs()
        File(dir, "lib/index.js").writeText(body)
        val json = if (version == null) "{\"name\":\"$name\"}"
        else "{\"name\":\"$name\",\"version\":\"$version\"}"
        File(dir, "package.json").writeText(json)
    }

    @Test
    fun `本地版本高于内置源时不覆盖（在线升级的副本不被出厂版本打回去）`() {
        val src = File(ctx.cacheDir, "dg-src-keep")
        val dst = File(ctx.cacheDir, "dg-dst-keep")
        src.deleteRecursively(); dst.deleteRecursively()
        // 出厂源 1.0.0；用户已在线升级到 2.0.0
        plugin(File(src, "plugK"), "plugK", "1.0.0", "ASSET-1.0.0")
        plugin(File(dst, "plugK"), "plugK", "2.0.0", "UPGRADED-2.0.0")

        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals("本地更新时必须一次都不刷", 0, n)
        assertEquals("UPGRADED-2.0.0", File(dst, "plugK/lib/index.js").readText())
        assertEquals("2.0.0", readVersion(File(dst, "plugK")))

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test
    fun `本地版本低于内置源时照常覆盖（正常的随 APK 升级）`() {
        val src = File(ctx.cacheDir, "dg-src-up")
        val dst = File(ctx.cacheDir, "dg-dst-up")
        src.deleteRecursively(); dst.deleteRecursively()
        plugin(File(src, "plugU"), "plugU", "3.1.0", "ASSET-3.1.0")
        plugin(File(dst, "plugU"), "plugU", "3.0.0", "OLD-3.0.0")

        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals(1, n)
        assertEquals("ASSET-3.1.0", File(dst, "plugU/lib/index.js").readText())
        assertEquals("3.1.0", readVersion(File(dst, "plugU")))

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test
    fun `版本不可解析时 fail-open 照常覆盖（不因缺字段把修复路径堵死）`() {
        val src = File(ctx.cacheDir, "dg-src-na")
        val dst = File(ctx.cacheDir, "dg-dst-na")
        src.deleteRecursively(); dst.deleteRecursively()
        // 两侧都没有 version —— 与既有测试夹具/旧插件产物同一形态
        plugin(File(src, "plugN"), "plugN", null, "ASSET-NEW")
        plugin(File(dst, "plugN"), "plugN", null, "LOCAL-OLD")

        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals("无法比较版本时必须按旧行为覆盖", 1, n)
        assertEquals("ASSET-NEW", File(dst, "plugN/lib/index.js").readText())

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test
    fun `同版本但内容不同时仍覆盖（副本损坏或被改的自愈路径）`() {
        val src = File(ctx.cacheDir, "dg-src-same")
        val dst = File(ctx.cacheDir, "dg-dst-same")
        src.deleteRecursively(); dst.deleteRecursively()
        plugin(File(src, "plugS"), "plugS", "1.2.3", "ASSET-CLEAN")
        plugin(File(dst, "plugS"), "plugS", "1.2.3", "LOCAL-BROKEN")

        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals("版本相同不等于内容相同，必须修", 1, n)
        assertEquals("ASSET-CLEAN", File(dst, "plugS/lib/index.js").readText())

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test
    fun `预发布段不参与比较：rc10 与 rc9 视为同核心版本（不误判为降级）`() {
        val src = File(ctx.cacheDir, "dg-src-pre")
        val dst = File(ctx.cacheDir, "dg-dst-pre")
        src.deleteRecursively(); dst.deleteRecursively()
        plugin(File(src, "plugP"), "plugP", "1.0.0-rc.9", "ASSET-RC9")
        plugin(File(dst, "plugP"), "plugP", "1.0.0-rc.10", "LOCAL-RC10")

        // parseVersionNums 取第一段数字串，pre-release 段不参与比较 → 两侧都是 1.0.0，
        // 结果为 0（既不判降级也不判升级）→ 走内容比对覆盖。这里钉住「不误判为降级」。
        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals("pre-release 段不参与比较，不得误判为本地更新", 1, n)

        src.deleteRecursively(); dst.deleteRecursively()
    }

    // ── 共享判据：本地是否比源新 ──────────────────────────
    //
    // AssetSync.isNewerThanSource 是三处消费者（refreshBundledPluginCopies 守卫、
    // 界面 isAheadOfSource、修复按钮 repairFromSource）的**唯一**判据。
    // 这几条断言钉的是它的边界：任一侧不可解析都必须返回 false（fail-open 方向）。

    @Test
    fun `isNewerThanSource 只在本地明确更新时为真`() {
        val src = File(ctx.cacheDir, "newer-src")
        val dst = File(ctx.cacheDir, "newer-dst")
        src.deleteRecursively(); dst.deleteRecursively()
        plugin(File(src, "p"), "p", "1.2.0", "S")
        plugin(File(dst, "p"), "p", "1.3.0", "D")
        assertTrue("本地 1.3.0 > 源 1.2.0", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        plugin(File(dst, "p"), "p", "1.2.0", "D")
        assertFalse("同版本不算更新", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        plugin(File(dst, "p"), "p", "1.1.9", "D")
        assertFalse("本地更旧不算更新", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test
    fun `isNewerThanSource 在版本或 package json 缺失时返回 false（fail-open）`() {
        val src = File(ctx.cacheDir, "newer-src2")
        val dst = File(ctx.cacheDir, "newer-dst2")
        src.deleteRecursively(); dst.deleteRecursively()
        plugin(File(src, "p"), "p", "1.0.0", "S")
        plugin(File(dst, "p"), "p", null, "D")
        assertFalse("缺 version → 无法比较 → 不得判为更新", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        plugin(File(dst, "p"), "p", "9.9.9", "D")
        File(src, "p/package.json").delete()
        assertFalse("源缺 package.json → 无基准", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        File(dst, "p/package.json").delete()
        assertFalse("本地缺 package.json → 无基准", AssetSync.isNewerThanSource(File(dst, "p"), File(src, "p")))

        src.deleteRecursively(); dst.deleteRecursively()
    }

    // ── 状态读取 ─────────────────────────────────────────

    @Test
    fun `状态文件缺失时如实返回未检查`() {
        PluginUpgrade.stateFile(ctx).delete()
        val st = PluginUpgrade.readState(ctx)
        assertFalse("文件不存在必须 exists=false", st.exists)
        assertTrue("没有条目就不能报可升级", st.items.isEmpty())
        assertTrue("过期判定：从未检查过必须为 true", PluginUpgrade.isStale(st))
    }

    @Test
    fun `解析状态文件：可升级条目、已升级记录与汇总`() {
        val f = PluginUpgrade.stateFile(ctx)
        f.parentFile?.mkdirs()
        f.writeText(
            """
            {
              "version": 1,
              "checkedAt": "2026-10-28T13:57:19.149Z",
              "checkedAtMs": ${System.currentTimeMillis()},
              "ok": true,
              "items": [
                {"dir":"modsearch","name":"@liustack/modsearch","title":"ModSearch","npm":"@liustack/modsearch",
                 "local":"5.10.10","latest":"5.10.11","updateAvailable":true,"status":"outdated",
                 "tarball":"https://registry.npmmirror.com/x.tgz","source":"https://registry.npmmirror.com","error":null},
                {"dir":"dsh-net-proxy","name":"dsh-net-proxy","title":"网络代理","npm":"dsh-net-proxy",
                 "local":"0.8.0","latest":"0.8.0","updateAvailable":false,"status":"latest",
                 "tarball":"","source":"","error":null}
              ],
              "upgraded": {"dsh-web-mobile":{"from":"3.2.0","to":"3.2.1","at":"2026-10-28T14:00:00.000Z","backup":"/x","npm":"dsh-web-mobile"}},
              "summary": {"total":2,"outdated":1,"latest":1,"ahead":0,"error":0,"noNpm":0}
            }
            """.trimIndent()
        )
        val st = PluginUpgrade.readState(ctx)
        assertTrue(st.exists)
        assertEquals(2, st.items.size)
        assertEquals(1, st.upgradable.size)
        assertTrue(st.itemOf("modsearch")!!.hasUpdate)
        assertFalse(st.itemOf("dsh-net-proxy")!!.hasUpdate)
        // 汇总按条目现场重算，不信任文件里的 summary（脚本中途崩过会写歪）
        assertEquals(2, st.summary.total)
        assertEquals(1, st.summary.outdated)
        // 刚检查过 → 不算过期
        assertFalse(PluginUpgrade.isStale(st))
        f.delete()
    }

    @Test
    fun `回滚后 checkedAtMs 归零会强制下次走网络`() {
        val f = PluginUpgrade.stateFile(ctx)
        f.parentFile?.mkdirs()
        f.writeText("""{"version":1,"checkedAt":"2026-10-28T13:57:19.149Z","checkedAtMs":0,"items":[],"upgraded":{}}""")
        assertTrue("checkedAtMs<=0 必须判过期", PluginUpgrade.isStale(PluginUpgrade.readState(ctx)))
        f.delete()
    }

    @Test
    fun `损坏的状态文件不得让插件页崩掉`() {
        val f = PluginUpgrade.stateFile(ctx)
        f.parentFile?.mkdirs()
        f.writeText("{ this is not json ")
        val st = PluginUpgrade.readState(ctx)
        assertFalse("解析失败一律当作没查过", st.exists)
        assertTrue(st.items.isEmpty())
        f.delete()
    }

    @Test
    fun `upgradedTo 只在目标版本仍是当前版本时才算待重启`() {
        val st = PluginUpgrade.State(
            upgraded = mapOf(
                "a" to PluginUpgrade.Upgraded("1.0.0", "1.1.0", "", ""),
                "b" to PluginUpgrade.Upgraded("1.0.0", "1.1.0", "", ""),
            )
        )
        assertNotNull(st.upgradedTo("a", "1.1.0"))
        assertNull("已经又变了的版本不能再提示待重启", st.upgradedTo("b", "1.2.0"))
        assertNull(st.upgradedTo("c", "1.1.0"))
    }

    // ── 备份枚举 ─────────────────────────────────────────

    @Test
    fun `listBackups 只认含 package json 的目录并按时间倒序`() {
        val root = File(ctx.filesDir, ".plugin-backup/bkp-plug")
        root.deleteRecursively()
        // 正常备份
        File(root, "1.0.0").mkdirs()
        File(root, "1.0.0/package.json").writeText("{\"name\":\"bkp\"}")
        // 空壳（makeBackup 中途失败留下的残留）—— 回滚过去等于把插件清空
        File(root, "1.1.0").mkdirs()
        // 时间先后
        File(root, "1.0.0").setLastModified(1_000_000L)
        File(root, "1.2.0").mkdirs()
        File(root, "1.2.0/package.json").writeText("{\"name\":\"bkp\"}")
        File(root, "1.2.0").setLastModified(2_000_000L)

        val list = PluginUpgrade.listBackups(ctx, "bkp-plug")
        assertEquals("空壳备份必须被排除", 2, list.size)
        assertEquals("1.2.0", list[0].version)
        assertEquals("1.0.0", list[1].version)

        root.deleteRecursively()
    }

    @Test
    fun `listBackups 在没有备份时返回空列表`() {
        File(ctx.filesDir, ".plugin-backup/none-here").deleteRecursively()
        assertTrue(PluginUpgrade.listBackups(ctx, "none-here").isEmpty())
    }

    private fun readVersion(dir: File): String? =
        runCatching {
            org.json.JSONObject(File(dir, "package.json").readText()).optString("version")
        }.getOrNull()
}
