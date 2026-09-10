package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * NodeProcs：node 进程归属判定与 cmdline 解析的回归测试。
 *
 * 覆盖 P0 缺陷修复——原实现用 `ps -A | grep '[n]ode' | awk '{print $2}'` 取 PID，
 * 在 Android toybox（列序 `PID TTY TIME CMD`）上 `$2` 命中 TTY 列，解析结果恒为 `?`，
 * 终止链路全线静默失效。本测试锁定替代实现的判定语义。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class NodeProcsTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    private val binPath: String get() = NodeProcs.nodeBin(ctx)

    // ---------------- cmdline 解析 ----------------

    @Test fun `cmdline 按 NUL 切分且丢弃末项空串`() {
        val f = File(ctx.cacheDir, "cmdline-1")
        f.writeBytes("/data/user/0/x/node/bin/node\u0000--expose-internals\u0000bin.js\u0000".toByteArray())
        assertEquals(
            listOf("/data/user/0/x/node/bin/node", "--expose-internals", "bin.js"),
            NodeProcs.readArgv(f),
        )
    }

    @Test fun `cmdline 无末尾 NUL 时同样正确`() {
        val f = File(ctx.cacheDir, "cmdline-2")
        f.writeBytes("/a/node/bin/node\u0000web".toByteArray())
        assertEquals(listOf("/a/node/bin/node", "web"), NodeProcs.readArgv(f))
    }

    @Test fun `内核线程空 cmdline 视为不可读而非空 argv`() {
        val f = File(ctx.cacheDir, "cmdline-3")
        f.writeBytes(ByteArray(0))
        // null = 不参与枚举（内核线程/已退出进程），而非「属于我们」
        assertEquals(null, NodeProcs.readArgv(f))
    }

    @Test fun `cmdline 文件不存在返回 null 而不抛异常`() {
        assertEquals(null, NodeProcs.readArgv(File(ctx.cacheDir, "no-such-cmdline")))
    }

    // ---------------- 归属判定 ----------------

    @Test fun `argv0 与内置 node 绝对路径完全一致即归属本应用`() {
        assertTrue(NodeProcs.isOurNode(binPath, binPath))
    }

    // 注意：Kotlin 反引号方法名在 JVM 上仍受字节码命名约束——不能含 '/' 等字符
    // （CI 实测：`Name contains illegal characters: /.`）。路径字面量只写在注释里。
    @Test fun `argv0 为 data-data 别名路径时亦归属本应用`() {
        // /data/data ≡ /data/user/0：内核可能呈递任一形式，两侧都必须认
        val dataForm = binPath.replace("/data/user/0/", "/data/data/")
        assertTrue("binPath=$binPath dataForm=$dataForm", NodeProcs.isOurNode(dataForm, binPath))
    }

    @Test fun `裸 node 不归属——PATH 查找的 node 可能来自 termux 或其它应用`() {
        // 误杀代价远高于漏杀：宁可不动它
        assertFalse(NodeProcs.isOurNode("node", binPath))
        assertFalse(NodeProcs.isOurNode("./node", binPath))
    }

    @Test fun `其它路径的 node 不归属`() {
        assertFalse(NodeProcs.isOurNode("/usr/bin/node", binPath))
        assertFalse(NodeProcs.isOurNode("/data/data/com.termux/files/usr/bin/node", binPath))
        // 同为 node/bin/node 结尾但属其它应用：宽松后缀匹配会误伤，故必须精确
        assertFalse(NodeProcs.isOurNode("/data/user/0/com.other.app/files/node/bin/node", binPath))
        assertFalse(NodeProcs.isOurNode("/opt/other/node/bin/node", binPath))
    }

    @Test fun `dataAlias 双向互转且对无关路径原样返回`() {
        assertEquals("/data/data/p/x", NodeProcs.dataAlias("/data/user/0/p/x"))
        assertEquals("/data/user/0/p/x", NodeProcs.dataAlias("/data/data/p/x"))
        assertEquals("/opt/x", NodeProcs.dataAlias("/opt/x"))
    }

    @Test fun `空或 null 的 argv0 不归属`() {
        assertFalse(NodeProcs.isOurNode(null, binPath))
        assertFalse(NodeProcs.isOurNode("", binPath))
    }

    // ---------------- 端到端语义 ----------------

    @Test fun `本机未启动 node 时枚举为空且 killAll 幂等成功`() {
        // Robolectric 下无真实 node 进程：枚举应为空，killAll 视为已达成目的
        assertEquals(emptyList<Int>(), NodeProcs.pids(ctx))
        assertFalse(NodeProcs.anyAlive(ctx))
        assertTrue(NodeProcs.killAll(ctx))
    }

    @Test fun `nodeBin 指向 filesDir 下的 node bin`() {
        assertEquals(File(ctx.filesDir, "node/bin/node").absolutePath, binPath)
    }
}
