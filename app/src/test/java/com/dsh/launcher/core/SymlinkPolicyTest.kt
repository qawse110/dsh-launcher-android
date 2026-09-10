package com.dsh.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SymlinkPolicy：解压期符号链接目标白名单的回归测试。
 *
 * 覆盖参考实现坑 45 的两个方向：
 * - **必须拒绝**：`../../` 逃逸、`/data/data/com.termux/...` 残留、任意系统路径；
 * - **必须放行**：合法的「指向本应用运行时根」绝对链接（坑 45 曾把这 9 个 applet
 *   静默丢弃，导致 applet 缺失）。
 *
 * 纯函数、不碰文件系统 —— 全部边界组合都可穷举。
 */
class SymlinkPolicyTest {

    private val root = "/data/user/0/com.dsh.launcher/files/node"
    private val app = "/data/user/0/com.dsh.launcher"
    private val link = "$root/lib/libcrypto.so"

    private fun decide(target: String, linkPath: String = link) =
        SymlinkPolicy.classify(linkPath, target, root, app)

    private fun assertAllow(target: String, linkPath: String = link) {
        val d = decide(target, linkPath)
        assertTrue("期望放行但被拒：$target（${(d as? SymlinkPolicy.Decision.Reject)?.reason}）", d is SymlinkPolicy.Decision.Allow)
    }

    private fun assertReject(target: String, linkPath: String = link) {
        val d = decide(target, linkPath)
        assertTrue("期望拒绝但被放行：$target", d is SymlinkPolicy.Decision.Reject)
    }

    // ---------------- 相对目标 ----------------

    @Test fun `同目录相对链接放行`() {
        assertAllow("libcrypto.so.3")
    }

    @Test fun `子目录相对链接放行`() {
        assertAllow("sub/dir/libx.so")
    }

    @Test fun `上溯但仍在校内放行`() {
        assertAllow("../lib/libz.so")
    }

    @Test fun `相对目标逃出解压根被拒`() {
        assertReject("../../../etc/passwd")
        assertReject("../../secret")
    }

    @Test fun `深层链接目录下的上溯按链接所在目录解析`() {
        // 链接在 <root>/a/b/c，../../.. 恰好回到 root → 放行
        assertAllow("../../..", "$root/a/b/c/link")
        // 再多一层即越界 → 拒绝
        assertReject("../../../..", "$root/a/b/c/link")
    }

    // ---------------- 绝对目标 ----------------

    @Test fun `指向自身运行时的绝对链接放行（坑 45 的 9 个 applet 形态）`() {
        assertAllow("$app/files/termux/usr/bin/vim")
        assertAllow("$app/files/node/bin/node")
    }

    @Test fun `短前缀绝对链接放行——它就在 dataDir 根下`() {
        // <dataDir>/t -> <filesDir>/termux/usr；appRoot 取 dataDir 才能放行
        assertAllow("$app/t/usr/lib/libx.so")
    }

    @Test fun `Termux 残留绝对链接被拒`() {
        assertReject("/data/data/com.termux/files/usr/lib/libcrypto.so")
        assertReject("/data/data/com.termux/files/usr/bin/bash")
    }

    @Test fun `其它应用与系统路径被拒`() {
        assertReject("/data/user/0/com.other.app/files/x")
        assertReject("/system/bin/sh")
        assertReject("/etc/passwd")
        assertReject("/")
    }

    @Test fun `空前缀混淆被拒——filesDir 之外的同前缀目录不算在内`() {
        // 经典前缀混淆：/data/user/0/com.dsh.launcherX 与包名同前缀但不同应用
        assertReject("/data/user/0/com.dsh.launcherX/files/evil")
    }

    @Test fun `空目标被拒`() {
        assertReject("")
    }

    // ---------------- 规范化与归属原语 ----------------

    @Test fun `normalize 折叠点段与重复分隔符`() {
        assertEquals("/a/b", SymlinkPolicy.normalize("/a/./b"))
        assertEquals("/a", SymlinkPolicy.normalize("/a/b/.."))
        assertEquals("/a/b", SymlinkPolicy.normalize("/a//b"))
        assertEquals("/", SymlinkPolicy.normalize("/.."))
        assertEquals("/", SymlinkPolicy.normalize("/a/../.."))
    }

    @Test fun `isWithin 按路径段比较而非字符串前缀`() {
        assertTrue(SymlinkPolicy.isWithin("/a/b", "/a"))
        assertTrue(SymlinkPolicy.isWithin("/a", "/a"))
        // 前缀相同但不是子路径 —— 字符串 startsWith 会误判为 true
        assertFalse(SymlinkPolicy.isWithin("/ab", "/a"))
        assertFalse(SymlinkPolicy.isWithin("/a2/b", "/a"))
        assertTrue(SymlinkPolicy.isWithin("/anything", "/"))
    }

    @Test fun `isAbsolute 判定`() {
        assertTrue(SymlinkPolicy.isAbsolute("/x"))
        assertFalse(SymlinkPolicy.isAbsolute("x"))
        assertFalse(SymlinkPolicy.isAbsolute("./x"))
    }
}
