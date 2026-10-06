package com.dsh.nextapp1.core

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

/**
 * PrefixPatcher 回归保险。
 *
 * 重点用例是 `官方前缀文件即使 mtime 早于安装时刻也必须被改写`：v4.9.x 的 mtime 增量
 * 判据在真机上整段失效——apt/dpkg 解包保留 deb 包内原始 mtime，任何「包内时间戳早于
 * 安装窗口」的载荷都被当成旧文件跳过，git 全家 36 个文件从未改写，`git --exec-path`
 * 一直指向不存在的 `/data/data/com.termux/files/usr/libexec/git-core`，裸终端 git 不可用。
 * 本用例把「旧 mtime」固化下来，防止有人重新引入按 mtime 跳过的优化。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PrefixPatcherTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var usr: File

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
        val target = write("lib/libx.so", "PREFIX=/data/data/com.termux/files/usr/bin")
        val innocent = write("lib/ok.txt", "no official prefix here")
        val result = PrefixPatcher.patchAll(usr)
        assertEquals(1, result.patched)
        assertEquals("PREFIX=/data/user/0/com.dsh.nextapp1/t/bin", target.readText())
        assertEquals("no official prefix here", innocent.readText())
    }

    /**
     * 核心回归：**载荷 mtime 早于「安装时刻」也必须被改写**。
     *
     * 这正是 apt/dpkg 解包的真实形态（deb 保留包内 mtime，可能比安装时刻早数月甚至数年）。
     * 旧实现接收 minLastModifiedMs 基线并 `lastModified() < baseline` 跳过，本用例会失败。
     */
    @Test fun `官方前缀文件即使 mtime 远早于当前时刻也必须被改写`() {
        val ancient = write(
            "bin/git",
            "GIT_EXEC_PATH=/data/data/com.termux/files/usr/libexec/git-core",
            mtimeMs = 1_000L, // 1970 年，模拟 deb 包内自带的老时间戳
        )
        val result = PrefixPatcher.patchAll(usr)

        assertEquals(
            "GIT_EXEC_PATH=/data/user/0/com.dsh.nextapp1/t/libexec/git-core",
            ancient.readText(),
        )
        assertEquals(1, result.patched)
        assertTrue(PrefixPatcher.audit(usr).clean)
    }

    @Test fun `patchAll 幂等——连续两次结果一致且第二次不再改写`() {
        val f = write("bin/x", "P=/data/data/com.termux/files/usr/bin")

        assertEquals(1, PrefixPatcher.patchAll(usr).patched)
        val once = f.readText()
        assertEquals(0, PrefixPatcher.patchAll(usr).patched)
        assertEquals(once, f.readText())
    }

    @Test fun `文本 patch 幂等——连续两次结果一致`() {
        val script = write("etc/profile.d/t.sh", "#!/bin/sh\nDATA=/data/data/com.termux/files/home\nCACHE=/data/data/com.termux/cache/apt\n")
        PrefixPatcher.patchTextOfficialDirs(usr)
        val once = script.readText()
        assertEquals(0, PrefixPatcher.patchTextOfficialDirs(usr).patched)
        assertEquals(once, script.readText())
        val mirRoot = usr.parentFile!!.parentFile!!.parentFile!!.absolutePath
        assertTrue(once.contains("$mirRoot/data/data/com.termux/files/home"))
        assertTrue(once.contains("${usr.absolutePath}/var/cache/apt"))
    }

    /** 同一文件里既有官方 files 根、又有官方 apt cache：两者都要改（旧实现是 else-if，会漏一个）。 */
    @Test fun `文本 patch 同时改 files 根与 apt cache`() {
        val f = write("etc/a.conf", "H=/data/data/com.termux/files/home\nC=/data/data/com.termux/cache/apt\n")
        PrefixPatcher.patchTextOfficialDirs(usr)
        val t = f.readText()
        assertFalse(t.contains("/data/data/com.termux/files/home"))
        assertFalse(t.contains("/data/data/com.termux/cache/apt"))
    }

    /** 二进制里的 files/home 无法等长替换，应被归为「披露但不阻断」，不能当成门禁失败。 */
    @Test fun `audit 把二进制 home 残留与核心前缀残留分级`() {
        val binary = File(usr, "bin/tool").apply { parentFile?.mkdirs() }
        binary.writeBytes(byteArrayOf(0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0))
        binary.appendBytes("/data/data/com.termux/files/home".toByteArray())
        write("bin/old.txt", "P=/data/data/com.termux/files/usr/bin")

        val audit = PrefixPatcher.audit(usr)

        assertEquals(listOf("bin/old.txt"), audit.mustFix.map { it.path })
        assertEquals(listOf("bin/tool"), audit.binaryRemnants.map { it.path })
        assertFalse("核心前缀残留时不应判为 clean", audit.clean)

        // 修掉核心前缀后，仅剩二进制固有残留 ⇒ 应判为 clean（不阻断 harness 就绪）
        PrefixPatcher.patchAll(usr)
        val after = PrefixPatcher.audit(usr)
        assertTrue(after.mustFix.isEmpty())
        assertTrue("二进制 home 残留不应阻断门禁", after.clean)
    }

    @Test fun `patchEverything 全量 patch 后审计通过`() {
        write("bin/git", "EXEC=/data/data/com.termux/files/usr/libexec/git-core", mtimeMs = 1_000L)
        write("etc/p.sh", "HOME_DIR=/data/data/com.termux/files/home\n", mtimeMs = 2_000L)

        val outcome = PrefixPatcher.patchEverything(usr)

        assertTrue(outcome.audit.toString(), outcome.audit.clean)
        assertEquals(1, outcome.binary.patched)
        assertEquals(1, outcome.text.patched)
    }

    /** 符号链接指向的文件不应被 patch（改链接目标会污染共享文件）。 */
    @Test fun `patchAll 跳过符号链接`() {
        val real = write("share/real.txt", "P=/data/data/com.termux/files/usr/bin")
        val link = File(usr, "bin/link.txt")
        link.parentFile?.mkdirs()
        java.nio.file.Files.createSymbolicLink(link.toPath(), real.toPath())

        val result = PrefixPatcher.patchAll(usr)

        // 只 patch 真实文件一次，链接不被当作独立载荷重复改写
        assertEquals(1, result.patched)
        assertEquals("P=/data/user/0/com.dsh.nextapp1/t/bin", real.readText())
    }
}
