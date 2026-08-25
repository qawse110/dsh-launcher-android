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
        AssetSync.markSynced(ctx, "prebuilt", 29L)
        assertTrue(AssetSync.isSynced(ctx, "prebuilt", target, 29L))
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", target, 30L))
        assertFalse(AssetSync.isSynced(ctx, "prebuilt", File(ctx.cacheDir, "missing"), 29L))
    }
}
