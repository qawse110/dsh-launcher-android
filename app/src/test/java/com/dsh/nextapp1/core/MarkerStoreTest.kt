package com.dsh.nextapp1.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** MarkerStore：键值读写、持久化重载、旧点文件一次性导入（P1-4 收尾的回归保险）。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MarkerStoreTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @Before fun reset() = MarkerStore.resetForTest()
    @After fun cleanup() {
        File(ctx.filesDir, "state").deleteRecursively()
        // 旧点文件若被测试重建也一并清掉
        listOf(".termux-ok", ".node-ok", ".prebuilt-ok", ".extra-plugins-ok", ".harness-tools-ok", ".stub-applied")
            .forEach { File(ctx.filesDir, it).delete() }
        MarkerStore.resetForTest()
    }

    @Test fun `put get remove 基本语义`() {
        MarkerStore.put(ctx, "k1", "v1")
        assertEquals("v1", MarkerStore.get(ctx, "k1"))
        assertTrue(MarkerStore.has(ctx, "k1"))
        MarkerStore.remove(ctx, "k1")
        assertFalse(MarkerStore.has(ctx, "k1"))
        assertNull(MarkerStore.get(ctx, "k1"))
    }

    @Test fun `put 后重新加载能从盘恢复（持久化）`() {
        MarkerStore.put(ctx, "termux", "6")
        MarkerStore.resetForTest() // 模拟进程重启：仅清缓存，不删盘
        assertEquals("6", MarkerStore.get(ctx, "termux"))
    }

    @Test fun `remove 后重载不复活`() {
        MarkerStore.put(ctx, "node", "ok")
        MarkerStore.remove(ctx, "node")
        MarkerStore.resetForTest()
        assertNull(MarkerStore.get(ctx, "node"))
    }


    @Test fun `已有 json 时直接加载，不读取历史点文件`() {
        MarkerStore.put(ctx, "existing", "1") // 触发 json 创建
        File(ctx.filesDir, ".termux-ok").writeText("9")
        MarkerStore.resetForTest()
        assertNull(MarkerStore.get(ctx, "termux")) // 不导入
        assertTrue(File(ctx.filesDir, ".termux-ok").exists()) // 原文件保留不动
    }

    // ---- AssetSync：判据为「安装戳」字符串 ----
    // 注意：判据**不能**用 versionCode——本仓 versionCode 硬编码为常量 300，
    // 用它当"APK 换过了"的信号会让同步永久短路（真机事故根因）。

    private val stampA = "/data/app/base.apk|12345|1700000000000"
    private val stampB = "/data/app/base.apk|23456|1700000009999" // 重装后长度/mtime 变化

    @Test fun `AssetSync 键值接口与安装戳判定`() {
        val target = File(ctx.cacheDir, "asset.bin").apply { writeText("x") }
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, stampA)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, stampA))
        // 安装戳变了（重装了 APK）→ 必须重新同步
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, stampB))
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", File(ctx.cacheDir, "missing"), stampA))
        // 空戳（取不到 APK 信息）视为未同步，fail-open 到"做事"而非"跳过"
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, ""))
    }

    @Test fun `AssetSync 内容指纹：安装戳相同但内容变化时判定未同步`() {
        val target = File(ctx.cacheDir, "asset-fp.bin").apply { writeText("v1") }
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, stampA)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, stampA))
        // 同安装戳，内容变化（本地 debug 重建场景）→ 必须重新拷贝
        target.writeText("v2 with different content and length")
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, stampA))
        // 重新标记后恢复同步态
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, stampA)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, stampA))
    }

    @Test fun `AssetSync 旧格式 marker（versionCode 判据，无指纹）视为未同步`() {
        val target = File(ctx.cacheDir, "asset-legacy.bin").apply { writeText("x") }
        // 模拟旧版本写入的 marker：apk:<versionCode>（无 # 指纹）
        MarkerStore.put(ctx, "extra-plugins", "apk:29")
        assertFalse(AssetSync.isSynced(ctx, "extra-plugins", target, stampA))
        // 也模拟旧格式带指纹的：apk:29#<fp> —— 前缀与安装戳不同，同样视为未同步
        MarkerStore.put(ctx, "extra-plugins", "apk:29#deadbeef")
        assertFalse(AssetSync.isSynced(ctx, "extra-plugins", target, stampA))
        AssetSync.markSyncedWithFingerprint(ctx, "extra-plugins", target, stampA)
        assertTrue(AssetSync.isSynced(ctx, "extra-plugins", target, stampA))
    }

    @Test fun `AssetSync 目录指纹：目录内容变化时判定未同步`() {
        val dir = File(ctx.cacheDir, "asset-fp-dir")
        dir.deleteRecursively()
        dir.mkdirs()
        File(dir, "a.txt").writeText("aaa")
        File(dir, "sub/b.txt").apply { parentFile!!.mkdirs() }.writeText("bbb")
        AssetSync.markSyncedWithFingerprint(ctx, "extra-plugins", dir, stampA)
        assertTrue(AssetSync.isSynced(ctx, "extra-plugins", dir, stampA))
        // 增加一个文件 → 指纹变化
        File(dir, "sub/c.txt").writeText("ccc")
        assertFalse(AssetSync.isSynced(ctx, "extra-plugins", dir, stampA))
        dir.deleteRecursively()
    }

    @Test fun `AssetSync fileFingerprint：内容变则指纹变，缺失为 absent`() {
        val f = File(ctx.cacheDir, "stub-probe.mjs").apply { writeText("v5 patch") }
        val fp1 = AssetSync.fileFingerprint(f)
        assertTrue(fp1.isNotEmpty() && fp1 != "absent")
        f.writeText("v6 patch with different content")
        assertNotEquals(fp1, AssetSync.fileFingerprint(f))
        assertEquals("absent", AssetSync.fileFingerprint(File(ctx.cacheDir, "nope.mjs")))
    }

    @Test fun `apkInstallStamp 反映 APK 文件本身且非空`() {
        // Robolectric 下 applicationInfo.sourceDir 指向测试用的 apk/目录；
        // 这里只断言「能取到一个非空、且包含来源路径的戳」，避免依赖具体打包形态。
        val stamp = AssetSync.apkInstallStamp(ctx)
        assertFalse("安装戳不应为空否则判据 fail-closed 成永久跳过", stamp.isEmpty())
        assertTrue(stamp.contains("|"))
    }

    @Test fun `refreshBundledPluginCopies 刷新装配副本且不误建未装配插件`() {
        val src = File(ctx.cacheDir, "rbp-src")
        val dst = File(ctx.cacheDir, "rbp-dst")
        src.deleteRecursively(); dst.deleteRecursively()

        // 源有两个插件；目标只有 A 已装配
        File(src, "plugA/lib/index.js").apply { parentFile!!.mkdirs() }.writeText("NEW-A")
        File(src, "plugA/package.json").writeText("{\"name\":\"plugA\"}")
        File(src, "plugB/lib/index.js").apply { parentFile!!.mkdirs() }.writeText("NEW-B")
        File(src, "plugB/package.json").writeText("{\"name\":\"plugB\"}")
        File(dst, "plugA/lib/index.js").apply { parentFile!!.mkdirs() }.writeText("OLD-A")
        File(dst, "plugA/package.json").writeText("{\"name\":\"plugA\"}")

        val n = AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true)
        assertEquals("只应刷新已装配的 plugA", 1, n)
        assertEquals("NEW-A", File(dst, "plugA/lib/index.js").readText())
        assertFalse("plugB 从未装配过，不应被硬塞进 plugins/", File(dst, "plugB").exists())

        // 幂等：内容一致时不再重复刷新
        assertEquals(0, AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = true))

        // onlyExisting=false 时允许补齐未装配的
        assertEquals(1, AssetSync.refreshBundledPluginCopies(src, dst, onlyExisting = false))
        assertTrue(File(dst, "plugB/lib/index.js").isFile)

        src.deleteRecursively(); dst.deleteRecursively()
    }

    @Test fun `refreshBundledPluginCopies 源缺失时安全返回 0`() {
        assertEquals(
            0,
            AssetSync.refreshBundledPluginCopies(
                File(ctx.cacheDir, "rbp-none"), File(ctx.cacheDir, "rbp-dst2"), true
            )
        )
    }

    @Test fun `dirContentEquals 识别副本落后于内置源`() {
        val src = File(ctx.cacheDir, "dce-src")
        val dst = File(ctx.cacheDir, "dce-dst")
        src.deleteRecursively(); dst.deleteRecursively()
        File(src, "a.js").apply { parentFile!!.mkdirs() }.writeText("NEW")
        File(dst, "a.js").apply { parentFile!!.mkdirs() }.writeText("OLD")
        // 内容不同 → 判定落后（这正是「装了新 APK 但副本是旧的」形态）
        assertFalse(AssetSync.dirContentEquals(src, dst))
        // 同步后一致
        dst.deleteRecursively(); src.copyRecursively(dst)
        assertTrue(AssetSync.dirContentEquals(src, dst))
        // 目录缺失一律视为不一致（不做无根据的判定）
        assertFalse(AssetSync.dirContentEquals(src, File(ctx.cacheDir, "dce-none")))
        src.deleteRecursively(); dst.deleteRecursively()
    }
}
