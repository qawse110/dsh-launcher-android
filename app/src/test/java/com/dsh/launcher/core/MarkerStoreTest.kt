package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
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

    @Test fun `AssetSync 键值接口与 apk 版本判定`() {
        val target = File(ctx.cacheDir, "asset.bin").apply { writeText("x") }
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, 29L)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, 29L))
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, 30L))
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", File(ctx.cacheDir, "missing"), 29L))
    }

    @Test fun `AssetSync 内容指纹：versionCode 相同但内容变化时判定未同步`() {
        val target = File(ctx.cacheDir, "asset-fp.bin").apply { writeText("v1") }
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, 29L)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, 29L))
        // 同 versionCode，内容变化（本地 debug 重建场景）→ 必须重新拷贝
        target.writeText("v2 with different content and length")
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, 29L))
        // 重新标记后恢复同步态
        AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", target, 29L)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, 29L))
    }

    @Test fun `AssetSync 旧格式 marker（无指纹）视为未同步并可通过重新标记升级`() {
        val target = File(ctx.cacheDir, "asset-legacy.bin").apply { writeText("x") }
        // 模拟旧版本写入的 marker
        MarkerStore.put(ctx, "extra-plugins", "apk:29")
        assertFalse(AssetSync.isSynced(ctx, "extra-plugins", target, 29L))
        AssetSync.markSyncedWithFingerprint(ctx, "extra-plugins", target, 29L)
        assertTrue(AssetSync.isSynced(ctx, "extra-plugins", target, 29L))
    }

    @Test fun `AssetSync 目录指纹：目录内容变化时判定未同步`() {
        val dir = File(ctx.cacheDir, "asset-fp-dir")
        dir.deleteRecursively()
        dir.mkdirs()
        File(dir, "a.txt").writeText("aaa")
        File(dir, "sub/b.txt").apply { parentFile!!.mkdirs() }.writeText("bbb")
        AssetSync.markSyncedWithFingerprint(ctx, "extra-plugins", dir, 29L)
        assertTrue(AssetSync.isSynced(ctx, "extra-plugins", dir, 29L))
        // 增加一个文件 → 指纹变化
        File(dir, "sub/c.txt").writeText("ccc")
        assertFalse(AssetSync.isSynced(ctx, "extra-plugins", dir, 29L))
        dir.deleteRecursively()
    }
}
