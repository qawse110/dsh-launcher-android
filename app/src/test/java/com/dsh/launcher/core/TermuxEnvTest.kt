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
        // SHELL 指向真实 bash（对齐参考实现 termuxEnv：npm/git 等工具探测 SHELL）
        assertEquals("$usr/bin/bash", env["SHELL"])
    }

    @Test fun `webProcessExports 的 PATH 以 node bin 开头且含 tools 目录`() {
        val exports = TermuxEnv.webProcessExports(ctx, nodeDir).toMap()
        val path = exports.getValue("PATH").split(":")
        assertEquals(File(nodeDir, "bin").absolutePath, path.first())
        assertTrue(path.contains(File(ctx.filesDir, ".tools/bin").absolutePath))
        assertTrue(exports.containsKey("PREFIX"))
        // SHELL 指向真实 bash
        assertEquals(File(ctx.filesDir, "termux/usr/bin/bash").absolutePath, exports["SHELL"])
        // 未装 termux-exec 时不应出现 LD_PRELOAD 键
        assertFalse(exports.containsKey("LD_PRELOAD"))
    }

    @Test fun `安装 termux-exec 后 LD_PRELOAD 注入子 shell 环境`() {
        val lib = File(ctx.filesDir, "termux/usr/lib").apply { mkdirs() }
        File(lib, "libtermux-exec-ld-preload.so").writeText("fake")
        MarkerStore.resetForTest()
        val env = TermuxEnv.childShellEnv(ctx)
        assertEquals(
            File(ctx.filesDir, "termux/usr/lib/libtermux-exec-ld-preload.so").absolutePath,
            env["LD_PRELOAD"]
        )
    }

    @Test fun `terminalSessionEnv 与 childShellEnv 单源一致（review-r4）`() {
        val termuxBin = File(ctx.filesDir, "termux/usr/bin").apply { mkdirs() }
        File(termuxBin, "bash").writeText("#!/bin/sh\nfake")
        MarkerStore.resetForTest()
        val term = TermuxEnv.terminalSessionEnv(ctx).associate {
            val i = it.indexOf('=')
            it.substring(0, i) to it.substring(i + 1)
        }
        // 基底 = terminalSessionEnv 同参数的 childShellEnv（TMPDIR=home + .tools/bin extraPath）
        val base = TermuxEnv.childShellEnv(
            ctx,
            tmpDir = TermuxRuntime.home(ctx),
            extraPath = listOf(File(ctx.filesDir, ".tools/bin").absolutePath),
        )
        // 终端环境 = childShellEnv 基底 + PWD；逐键核对无漂移
        assertEquals(base["PATH"], term["PATH"])
        assertEquals(base["HOME"], term["HOME"])
        assertEquals(base["PREFIX"], term["PREFIX"])
        assertEquals(base["LD_LIBRARY_PATH"], term["LD_LIBRARY_PATH"])
        assertEquals(base["OPENSSL_CONF"], term["OPENSSL_CONF"])
        assertEquals(base["SHELL"], term["SHELL"])
        assertEquals(TermuxRuntime.home(ctx).absolutePath, term["TMPDIR"])
        assertEquals(TermuxRuntime.home(ctx).absolutePath, term["PWD"])
    }

    // ---------------- 共享键一致性（review-r10 结构整理） ----------------

    /**
     * 三个环境生产者必须对**共享键**给出一致取值。
     *
     * 背景：此前三者各自维护环境，已实测漂移——`webProcessExports` **缺 `LANG`**
     * （真机 `/proc/<web-pid>/environ` 实测无 LANG，而 childShellEnv 设了 `C.UTF-8`），
     * 影响工具的中文/UTF-8 输出判定。结构整理后共享键由单一构造函数产出，
     * 本测试把该不变量钉死：新增消费方漏键会立刻失败。
     */
    @Test fun `三处环境对共享键取值一致`() {
        val nodeDir = File(ctx.filesDir, "node").apply { mkdirs() }
        File(File(ctx.filesDir, "termux/usr/bin"), "bash").writeText("#!/bin/sh\nfake")
        MarkerStore.resetForTest()

        val shell = TermuxEnv.childShellEnv(ctx)
        val web = TermuxEnv.webProcessExports(ctx, nodeDir).toMap()
        val term = TermuxEnv.terminalSessionEnv(ctx).associate {
            val i = it.indexOf('=')
            it.substring(0, i) to it.substring(i + 1)
        }

        // 共享键：三处必须同值（LANG 正是此前漂移的那个）
        for (key in listOf("PREFIX", "LD_LIBRARY_PATH", "OPENSSL_CONF", "TERM", "LANG", "SHELL")) {
            val values = listOfNotNull(shell[key], web[key], term[key]).distinct()
            assertEquals("共享键 $key 在三处环境间漂移：$values", 1, values.size)
        }
    }

    @Test fun `webProcessExports 现在包含 LANG（修复真机实测的缺失）`() {
        val nodeDir = File(ctx.filesDir, "node").apply { mkdirs() }
        val web = TermuxEnv.webProcessExports(ctx, nodeDir).toMap()
        assertEquals("C.UTF-8", web["LANG"])
    }

    @Test fun `webProcessExports 的 LD_LIBRARY_PATH 用传入的 nodeDir（与 PATH 同源）`() {
        // 传一个非默认路径的 nodeDir：PATH 与 LD 都必须跟随它，
        // 否则会出现「PATH 指向 A 的 node、LD 指向 B 的 lib」的错配
        val custom = File(ctx.filesDir, "custom-node").apply { mkdirs() }
        val web = TermuxEnv.webProcessExports(ctx, custom).toMap()

        assertTrue(
            "PATH 应以传入 nodeDir 的 bin 开头，实际 ${web["PATH"]}",
            web.getValue("PATH").startsWith(File(custom, "bin").absolutePath),
        )
        assertTrue(
            "LD_LIBRARY_PATH 应含传入 nodeDir 的 lib，实际 ${web["LD_LIBRARY_PATH"]}",
            web.getValue("LD_LIBRARY_PATH").startsWith(File(custom, "lib").absolutePath),
        )
    }

    @Test fun `webProcessExports 的 export 顺序稳定（渲染成脚本行序）`() {
        val nodeDir = File(ctx.filesDir, "node").apply { mkdirs() }
        // 同一输入连续两次必须同序 —— 顺序抖动会让生成的 dsh-web.sh 产生无意义 diff
        assertEquals(
            TermuxEnv.webProcessExports(ctx, nodeDir).map { it.first },
            TermuxEnv.webProcessExports(ctx, nodeDir).map { it.first },
        )
    }

    @Test fun `三处环境的 PATH 顺序各自符合设计（web 的 node 优先）`() {
        val nodeDir = File(ctx.filesDir, "node").apply { mkdirs() }
        val usr = File(ctx.filesDir, "termux/usr").absolutePath
        val nodeBin = File(nodeDir, "bin").absolutePath

        val webPath = TermuxEnv.webProcessExports(ctx, nodeDir).toMap().getValue("PATH").split(":")
        assertEquals("web 进程必须让 node/bin 最先（保证 node/npm 解析到内置版本）", nodeBin, webPath.first())

        val shellPath = TermuxEnv.childShellEnv(ctx).getValue("PATH").split(":")
        assertEquals("子 shell 让 Termux 工具优先", "$usr/bin", shellPath.first())
        assertTrue("子 shell 的 node/bin 仍须在 PATH 内", shellPath.contains(nodeBin))
    }
}
