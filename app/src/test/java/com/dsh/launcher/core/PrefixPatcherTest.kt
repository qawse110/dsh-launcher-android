package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** PrefixPatcher：等长字节替换正确性、增量 mtime 跳过、文本 patch 幂等（P2-5 回归保险）。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PrefixPatcherTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var usr: File

    private val oldPrefix = "aaa/data/data/com.termux/files/usr/bbb" // 31 字符前缀内嵌样本用
    private fun write(rel: String, content: String, mtimeMs: Long? = null): File {
        val f = File(usr, rel)
        f.parentFile?.mkdirs()
        f.writeText(content)
        mtimeMs?.let { f.setLastModified(it) }
        return f
    }

    @Before
    fun setup() {
        usr = File(ctx.filesDir, "patchtest/usr").apply { deleteRecursively(); mkdirs() }
    }

    @After
    fun cleanup() {
        File(ctx.filesDir, "patchtest").deleteRecursively()
    }

    @Test fun `patchAll 等长替换官方前缀且不碰其他文件`() {
        // 构造含官方 31 字符前缀的内容（OFFICIAL_PREFIX 本身即 31 长度）
        val target = write("lib/libx.so", "PREFIX=/data/data/com.termux/files/usr/bin")
        val innocent = write("lib/ok.txt", "no official prefix here")
        PrefixPatcher.patchAll(usr)
        assertEquals("PREFIX=/data/user/0/com.dsh.launcher/t/bin", target.readText())
        assertEquals("no official prefix here", innocent.readText())
    }

    /**
     * **回归：mtime 早于基线但 ctime 新（dpkg 保留归档 mtime 的真实形态）**。
     *
     * 真机 P1 缺陷（2026-09-10）：`dpkg-deb -x`/tar 会**保留包内归档 mtime**
     * （实测 git 是 7 月、wget 是去年 8 月），而基线是安装时刻（9 月）→
     * 旧实现（纯 mtime 判据）把 `bin`+`lib` 共 483 个文件**全部跳过、0 个处理**，
     * 12 个文件（git/rg/wget/file/git-lfs/scalar/libuuid.so/libexpat.so/pkgconfig）
     * 至今带着官方硬编码前缀。
     *
     * 本测试把 mtime 人为设成极旧（模拟归档 mtime），但文件 ctime 是「刚刚」
     * ——修复后必须仍被处理。
     */
    @Test fun `mtime 陈旧但刚落盘的文件仍被处理（dpkg 保留归档 mtime 的形态）`() {
        val archiveMtime = 1_000L // 模拟包内 7 月的归档时间
        val f = write("bin/frompkg.sh", "echo /data/data/com.termux/files/usr/bin/y", mtimeMs = archiveMtime)
        // 前置断言：确认这确实是「mtime 很旧」的形态
        assertEquals(archiveMtime, f.lastModified())

        // 基线 = 安装窗口开始时刻（略早于现在，文件刚落盘）
        PrefixPatcher.patchAll(usr, minTsMs = System.currentTimeMillis() - 60_000)

        assertFalse(
            "归档 mtime 陈旧但 ctime 刚落盘的文件必须被 patch —— " +
                "纯 mtime 判据在此漏掉它，正是真机 483 文件全被跳过的原因",
            f.readText().contains("/data/data/com.termux"),
        )
        assertTrue(f.readText().contains("/data/user/0/com.dsh.launcher/t/bin/y"))
    }

    @Test fun `shouldProcess 基线为零时一律处理（全量模式）`() {
        val f = write("bin/x.sh", "x", mtimeMs = 1L)
        assertTrue("基线 0 = 全量模式", PrefixPatcher.shouldProcess(f, 0L))
    }

    @Test fun `shouldProcess 对未来基线亦不放行陈旧文件（避免无条件为真）`() {
        val f = write("bin/ancient.sh", "x", mtimeMs = 1L)
        // 先验证前提：本平台 ctime 必须可用，否则会走「退化 → 一律处理」的安全网，
        // 断言失败信息将难以理解。把前提显式化，失败即自解释。
        val c = PrefixPatcher.ctimeMsForTest(f)
        assertTrue(
            "本平台 ctime 退化为 $c（不可用）——真机会走安全网（一律处理）。" +
                "若此断言失败，说明运行环境的 creationTime() 语义异常，而非被测逻辑有误",
            c >= PrefixPatcher.PLAUSIBLE_TS_FLOOR_MS,
        )
        assertFalse(
            "陈旧且与本次安装无关的文件应被跳过（否则增量化形同虚设）",
            PrefixPatcher.shouldProcess(f, System.currentTimeMillis() + 3_600_000),
        )
    }

    @Test fun `文本 patch 幂等——连续两次结果一致`() {
        val script = write("etc/profile.d/t.sh", "#!/bin/sh\nDATA=/data/data/com.termux/files/home\nCACHE=/data/data/com.termux/cache/apt\n")
        PrefixPatcher.patchTextOfficialDirs(usr)
        val once = script.readText()
        PrefixPatcher.patchTextOfficialDirs(usr)
        assertEquals(once, script.readText())
        // home 走镜像长路径（镜像根由传入的 usr 上溯三级推导）；cache 走真实 var 路径
        val mirRoot = usr.parentFile!!.parentFile!!.parentFile!!.absolutePath
        assertTrue(once.contains("$mirRoot/data/data/com.termux/files/home"))
        assertTrue(once.contains("${usr.absolutePath}/var/cache/apt"))
    }

    // ---------------- decideProcess 纯函数边界（穷举，不依赖平台时间戳语义） ----------------

    private val base = 1_800_000_000_000L // 某个「安装时刻」

    @Test fun `decideProcess 基线为零一律处理`() {
        assertTrue(PrefixPatcher.decideProcess(0L, 0L, 0L))
    }

    @Test fun `decideProcess ctime 新鲜即处理（dpkg 归档 mtime 场景）`() {
        // 归档 mtime 很旧，但 ctime 是安装时刻 → 必须处理（本轮 P1 缺陷的核心场景）
        assertTrue(
            PrefixPatcher.decideProcess(
                cTimeMs = base + 1,
                mTimeMs = PrefixPatcher.PLAUSIBLE_TS_FLOOR_MS - 1,
                minTsMs = base,
            ),
        )
    }

    @Test fun `decideProcess ctime 陈旧但 mtime 新鲜亦处理`() {
        assertTrue(
            PrefixPatcher.decideProcess(cTimeMs = base - 1, mTimeMs = base + 1, minTsMs = base),
        )
    }

    @Test fun `decideProcess 两戳皆陈旧才跳过（保证增量化不是恒真）`() {
        assertFalse(
            PrefixPatcher.decideProcess(cTimeMs = base - 1, mTimeMs = base - 1, minTsMs = base),
        )
    }

    /**
     * **安全网**：平台 ctime 退化（返 0/epoch，即该 API 在此平台不可用）时，
     * 必须放弃增量、倾向处理——因为此时唯一可用的 mtime 恰恰是被归档保留的旧值，
     * 信它就会完整重演本轮 P1 缺陷（483 文件全被跳过）。
     */
    @Test fun `decideProcess ctime 退化时放弃增量倾向处理`() {
        val staleMtime = PrefixPatcher.PLAUSIBLE_TS_FLOOR_MS - 1
        for (degenerate in listOf(0L, 1L, -1L, Long.MIN_VALUE)) {
            assertTrue(
                "ctime=$degenerate 属退化值，必须倾向处理（宁可多扫不可漏 patch）",
                PrefixPatcher.decideProcess(cTimeMs = degenerate, mTimeMs = staleMtime, minTsMs = base),
            )
        }
    }

    @Test fun `decideProcess ctime 取不到时（MAX_VALUE）倾向处理`() {
        // ctimeMs 读取失败返回 MAX_VALUE（见实现注释）
        assertTrue(
            PrefixPatcher.decideProcess(
                cTimeMs = Long.MAX_VALUE,
                mTimeMs = PrefixPatcher.PLAUSIBLE_TS_FLOOR_MS - 1,
                minTsMs = base,
            ),
        )
    }

    @Test fun `时间戳合理性下限是 2000-01-01`() {
        assertEquals(946_684_800_000L, PrefixPatcher.PLAUSIBLE_TS_FLOOR_MS)
    }
}
