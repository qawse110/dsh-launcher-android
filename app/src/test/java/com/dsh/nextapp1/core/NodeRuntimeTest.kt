package com.dsh.nextapp1.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * NodeRuntime 的 RUNPATH 修复回归保险。
 *
 * 真机缺陷：Termux 打包的 node 把 RUNPATH 编译死成官方前缀
 * `/data/data/com.termux/files/usr/lib`，本环境该路径不存在 ⇒ 动态链接器找不到
 * libz.so.1/libcares.so，node 在启动阶段就退出，PTC 的 code run 报 worker-exit。
 * 而 `files/node` 是 `files/termux` 的兄弟目录，不在 PrefixPatcher 扫描范围内。
 *
 * 这里锁住修复的三条不变式：
 *  1. 官方 lib 串被改写成 `$ORIGIN/../lib`，且**总长度不变**（等长替换，不破坏 ELF）；
 *  2. 幂等：再跑一次零改动；
 *  3. 不改动符号链接指向的目标（避免污染共享文件）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class NodeRuntimeTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var dir: File

    private val official = "/data/data/com.termux/files/usr/lib"
    private val origin = "\$ORIGIN/../lib"

    @Before
    fun setup() {
        dir = File(ctx.filesDir, "nodetest").apply { deleteRecursively(); mkdirs() }
    }

    @After
    fun cleanup() {
        dir.deleteRecursively()
    }

    private fun bin(bytes: ByteArray, rel: String = "bin/node"): File {
        val f = File(dir, rel)
        f.parentFile?.mkdirs()
        f.writeBytes(bytes)
        return f
    }

    @Test fun `官方 RUNPATH 被等长改写为 ORIGIN 且字节总长不变`() {
        // 模拟 ELF 里的 RUNPATH：官方路径 + 终止 NUL，前后各有些其它字节
        val head = byteArrayOf(0x7f, 0x45, 0x4c, 0x46, 0, 0)
        val tail = "some-other-content".toByteArray()
        val f = bin(head + (official + "\u0000").toByteArray(Charsets.ISO_8859_1) + tail)
        val sizeBefore = f.length()

        val patched = NodeRuntime.ensureRunpathsPatched(dir)

        assertEquals(1, patched)
        assertEquals("等长替换不得改变文件长度", sizeBefore, f.length())
        val text = String(f.readBytes(), Charsets.ISO_8859_1)
        assertTrue("应写入 \$ORIGIN/../lib", text.contains(origin))
        assertTrue("不得再残留官方 lib 前缀", !text.contains(official))
    }

    @Test fun `改写幂等——第二次零改动`() {
        val f = bin(("x" + official + "\u0000y").toByteArray(Charsets.ISO_8859_1))

        assertEquals(1, NodeRuntime.ensureRunpathsPatched(dir))
        val once = f.readBytes()
        assertEquals(0, NodeRuntime.ensureRunpathsPatched(dir))
        assertTrue("第二次调用改变了内容", once.contentEquals(f.readBytes()))
    }

    @Test fun `无官方串的文件不被改动`() {
        val f = bin("nothing to patch here".toByteArray(Charsets.ISO_8859_1))
        val before = f.readBytes()

        assertEquals(0, NodeRuntime.ensureRunpathsPatched(dir))
        assertTrue(before.contentEquals(f.readBytes()))
    }

    /** node/lib 下 20+ 个 .so 也各自带官方 RUNPATH，必须一并改（bionic 的 RUNPATH 不传递）。 */
    @Test fun `lib 目录下的 so 也被处理`() {
        bin((official + "\u0000").toByteArray(Charsets.ISO_8859_1), "lib/libicuuc.so.78")
        bin((official + "\u0000").toByteArray(Charsets.ISO_8859_1), "lib/libcares.so")

        assertEquals(2, NodeRuntime.ensureRunpathsPatched(dir))
        for (rel in listOf("lib/libicuuc.so.78", "lib/libcares.so")) {
            val t = String(File(dir, rel).readBytes(), Charsets.ISO_8859_1)
            assertTrue("$rel 应已改写", t.contains(origin))
            assertTrue("$rel 不应残留官方串", !t.contains(official))
        }
    }

    /** tmp 是可写运行目录，不含 ELF，应被跳过（改动它可能干扰运行时）。 */
    @Test fun `tmp 目录被跳过`() {
        bin(("x" + official).toByteArray(Charsets.ISO_8859_1), "tmp/cache.bin")
        assertEquals(0, NodeRuntime.ensureRunpathsPatched(dir))
    }

    /** 符号链接不得被当作普通文件改（否则会写到链接目标或外部文件）。 */
    @Test fun `符号链接被跳过`() {
        val target = bin("keep me".toByteArray(Charsets.ISO_8859_1), "lib/real.txt")
        val link = File(dir, "bin/link.txt")
        link.parentFile?.mkdirs()
        java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())

        NodeRuntime.ensureRunpathsPatched(dir)

        assertEquals("keep me", target.readText())
    }

    /** 替换串必须与官方串等长，否则整个 patch 应拒绝执行（防损坏 ELF）。 */
    @Test fun `长度前提：官方串 35 与 ORIGIN 填充后 35 一致`() {
        val pad = ":".repeat(official.length - origin.length)
        assertEquals("填充后必须与官方串等长", official.length, (origin + pad).length)
        assertEquals(35, official.length)
    }

    // ---------- 步骤 2：OPENSSLDIR 等非 lib 的官方路径（PTC 报 OpenSSL configuration error） ----------

    /** libcrypto.so.3 编译进 OPENSSLDIR=…/usr/etc/tls，读不到 openssl.cnf 会让 node 退出码 13。 */
    @Test fun `OPENSSLDIR 被等长改写为短前缀`() {
        val opensslDir = "/data/data/com.termux/files/usr/etc/tls"
        val f = bin((opensslDir + "\u0000").toByteArray(Charsets.ISO_8859_1), "lib/libcrypto.so.3")
        val sizeBefore = f.length()

        NodeRuntime.ensureRunpathsPatched(dir)

        assertEquals("等长替换不得改变长度", sizeBefore, f.length())
        val text = String(f.readBytes(), Charsets.ISO_8859_1)
        assertTrue("应指向短前缀下的 etc/tls", text.contains(PrefixPatcher.SHORT_PREFIX + "/etc/tls"))
        assertTrue("不得残留官方 usr 前缀", !text.contains("/data/data/com.termux/files/usr"))
    }

    /**
     * 顺序不变式：`…/usr/lib` 必须先变成 `$ORIGIN/../lib`，再执行 usr→短前缀。
     *
     * 若顺序颠倒，lib 路径会被步骤 2 改写成 `t/lib`，而 t/lib 缺少 node 自带的
     * libcares/libsqlite3/libicu*（node/lib 那份才全）⇒ 动态链接再次失败。
     */
    @Test fun `步骤顺序：lib 先变 ORIGIN，不会被 usr 步骤改写成 t_lib`() {
        bin(("/data/data/com.termux/files/usr/lib" + "\u0000").toByteArray(Charsets.ISO_8859_1))

        NodeRuntime.ensureRunpathsPatched(dir)

        val text = String(File(dir, "bin/node").readBytes(), Charsets.ISO_8859_1)
        assertTrue("应为 \$ORIGIN/../lib", text.contains(origin))
        assertTrue(
            "不得被步骤 2 改写成短前缀 lib（那会丢库）",
            !text.contains(PrefixPatcher.SHORT_PREFIX + "/lib"),
        )
    }

    /** 一个文件同时含 lib 与 etc 两处官方路径时，两处都要改，且只算一次改写。 */
    @Test fun `同文件含 lib 与 etc 两处官方路径都被改写`() {
        val body = "RUNPATH=/data/data/com.termux/files/usr/lib" + "\u0000" +
            "OPENSSLDIR=/data/data/com.termux/files/usr/etc/tls" + "\u0000"
        val f = bin(body.toByteArray(Charsets.ISO_8859_1))

        NodeRuntime.ensureRunpathsPatched(dir)

        val text = String(f.readBytes(), Charsets.ISO_8859_1)
        assertTrue("lib 应改 ORIGIN", text.contains(origin))
        assertTrue("etc/tls 应改短前缀", text.contains(PrefixPatcher.SHORT_PREFIX + "/etc/tls"))
        assertTrue("不得残留官方前缀", !text.contains("/data/data/com.termux/files/usr"))
    }

    /** 两步都改完后，全树不应再有任何官方 usr 前缀残留（audit 口径）。 */
    @Test fun `整树无官方 usr 前缀残留`() {
        bin(("/data/data/com.termux/files/usr/lib" + "\u0000").toByteArray(Charsets.ISO_8859_1), "bin/node")
        bin(("/data/data/com.termux/files/usr/etc/tls" + "\u0000").toByteArray(Charsets.ISO_8859_1), "lib/libcrypto.so.3")
        bin(("/data/data/com.termux/files/usr/bin/sh" + "\u0000").toByteArray(Charsets.ISO_8859_1), "lib/libssl.so.3")

        NodeRuntime.ensureRunpathsPatched(dir)

        var leftovers = 0
        dir.walkTopDown().filter { it.isFile }.forEach { f ->
            if (String(f.readBytes(), Charsets.ISO_8859_1).contains("/data/data/com.termux/files/usr")) {
                leftovers++
            }
        }
        assertEquals("处理后不应再有官方 usr 前缀残留", 0, leftovers)
    }
}
