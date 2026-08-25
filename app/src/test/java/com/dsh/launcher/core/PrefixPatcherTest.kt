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
        assertEquals("actual=${target.readText()}", "PREFIX=/data/user/0/com.dsh.launcher/t/usr/bin", target.readText())
        assertEquals("no official prefix here", innocent.readText())
    }

    @Test fun `增量模式跳过基线前的文件`() {
        val oldFile = write("bin/old.sh", "echo /data/data/com.termux/files/usr/bin/x", mtimeMs = 1_000L)
        val newFile = write("bin/new.sh", "echo /data/data/com.termux/files/usr/bin/y", mtimeMs = System.currentTimeMillis() + 10_000)

        PrefixPatcher.patchAll(usr, minLastModifiedMs = System.currentTimeMillis())

        // 基线前的旧文件被跳过，未替换；新文件已替换
        assertTrue("old=${oldFile.readText()}", oldFile.readText().contains("/data/data/com.termux"))
        assertTrue("new=${newFile.readText()}", !newFile.readText().contains("/data/data/com.termux"))
        assertTrue("new2=${newFile.readText()}", newFile.readText().contains("/data/user/0/com.dsh.launcher/t/usr/bin/y"))
    }

    @Test fun `文本 patch 幂等——连续两次结果一致`() {
        val script = write("etc/profile.d/t.sh", "#!/bin/sh\nDATA=/data/data/com.termux/files/home\nCACHE=/data/data/com.termux/cache/apt\n")
        PrefixPatcher.patchTextOfficialDirs(usr)
        val once = script.readText()
        PrefixPatcher.patchTextOfficialDirs(usr)
        assertEquals("once=$once|now=${script.readText()}", once, script.readText())
        // home 走镜像长路径；cache 走真实 var 路径
        assertTrue(once.contains("/data/user/0/com.dsh.launcher/data/data/com.termux/files/home"))
        assertTrue(once.contains("/data/user/0/com.dsh.launcher/files/termux/usr/var/cache/apt"))
    }
}
