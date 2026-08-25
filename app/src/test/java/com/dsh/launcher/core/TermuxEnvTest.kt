package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** TermuxEnv：web 进程 export 集与子 shell 环境的契约测试（P0-1 单源化的回归保险）。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TermuxEnvTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val nodeDir get() = File(ctx.filesDir, "node")

    @Before fun setup() {
        File(ctx.filesDir, "termux/usr/bin").apply { deleteRecursively(); mkdirs() }
        File(ctx.filesDir, "state").deleteRecursively()
        MarkerStore.resetForTest()
    }

    @Test fun `childShellEnv 包含全部必需键且 LD 顺序正确`() {
        val env = TermuxEnv.childShellEnv(ctx)
        val usr = File(ctx.filesDir, "termux/usr").absolutePath
        assertEquals(usr, env["PREFIX"])
        assertTrue(env.getValue("HOME").startsWith(ctx.filesDir.absolutePath))
        val path = env.getValue("PATH").split(":")
        assertEquals("$usr/bin", path.first())
        assertTrue(path.contains(File(ctx.filesDir, "node/bin").absolutePath))
        val ld = env.getValue("LD_LIBRARY_PATH").split(":")
        assertEquals(File(ctx.filesDir, "node/lib").absolutePath, ld.first())
        assertEquals("$usr/lib", ld[1])
        assertEquals(TermuxRuntime.tmp(ctx).absolutePath, env["TMPDIR"])
        assertEquals("/dev/null", env["OPENSSL_CONF"])
    }

    @Test fun `webProcessExports 的 PATH 以 node bin 开头且含 tools 目录`() {
        val exports = TermuxEnv.webProcessExports(ctx, nodeDir).toMap()
        val path = exports.getValue("PATH").split(":")
        assertEquals(File(nodeDir, "bin").absolutePath, path.first())
        assertTrue(path.contains(File(ctx.filesDir, ".tools/bin").absolutePath))
        assertTrue(exports.containsKey("PREFIX"))
        // 未装 termux-exec 时不应出现 LD_PRELOAD 键
        assertFalse(exports.containsKey("LD_PRELOAD"))
    }

    @Test fun `安装 termux-exec 后 LD_PRELOAD 注入子 shell 环境`() {
        File(ctx.filesDir, "termux/usr/lib/libtermux-exec-ld-preload.so").writeText("fake")
        MarkerStore.resetForTest()
        val env = TermuxEnv.childShellEnv(ctx)
        assertEquals(
            File(ctx.filesDir, "termux/usr/lib/libtermux-exec-ld-preload.so").absolutePath,
            env["LD_PRELOAD"]
        )
    }
}
