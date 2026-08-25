package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** FileLog：统一目录、可读时间戳、512KB 轮转（P1 日志优化的回归保险）。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class FileLogTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @Before fun cleanup() {
        File(ctx.filesDir, "logs").deleteRecursively()
        File(ctx.filesDir, "dsh-flow.log").delete()
    }

    @Test fun `log 写入含时间戳且落在 logs 目录`() {
        FileLog.log(ctx, "t.log", "hello 世界")
        val f = File(File(ctx.filesDir, "logs"), "t.log")
        assertTrue(f.isFile)
        val line = f.readText().trim()
        assertTrue(line.startsWith("["))
        assertTrue(line.endsWith("hello 世界"))
        // 时间戳格式 MM-dd HH:mm:ss.SSS => 方括号内长度固定 18
        assertEquals(18, line.indexOf(']') - 1)
    }

    @Test fun `超过阈值触发轮转保留 old 一代`() {
        repeat(60) { FileLog.log(ctx, "rot.log", "x".repeat(10_000)) } // ~600KB > 512KB
        val cur = File(File(ctx.filesDir, "logs"), "rot.log")
        val old = File(File(ctx.filesDir, "logs"), "rot.log.old")
        assertTrue("当前文件应重新开始", cur.length() < 512L * 1024L)
        assertTrue(".old 应存在且较大", old.isFile && old.length() >= 500L * 1024L)
    }

    @Test fun `tail 读取尾部 N 行`() {
        repeat(30) { FileLog.log(ctx, "tail.log", "line-$it") }
        val lines = FileLog.tail(ctx, "tail.log", 5)
        assertEquals(listOf("line-25", "line-26", "line-27", "line-28", "line-29").size, lines.size)
        assertEquals("line-29", lines.last().substringAfterLast(' '))
    }

    @Test fun `reset 清空指定日志`() {
        FileLog.log(ctx, "r.log", "junk")
        FileLog.reset(ctx, "r.log")
        assertFalse(File(File(ctx.filesDir, "logs"), "r.log").exists())
    }
}
