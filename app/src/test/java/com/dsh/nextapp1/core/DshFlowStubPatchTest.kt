package com.dsh.nextapp1.core

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * stub 补丁产物健康检查（[DshFlow.stubPatchesPresent]）。
 *
 * 覆盖真机事故 0.2.1-rc.2：`.pnpm` 里同名包有多个版本副本，补丁只打在旧版上，
 * dsh 实际加载的新版仍是原生实现 → boot 期 "No usable native binding found"。
 * 健康检查必须要求**每个副本**都带 marker，否则「标记命中 + 补丁缺失」会被
 * 误判成「已应用」而整段跳过 stub。
 */
class DshFlowStubPatchTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val marker = "dsh-launcher-android-narb-shim-v1"

    /** 造一个副本：node_modules/.pnpm/node-addon-require-builtin@<ver>/node_modules/<pkg>/lib/index.js */
    private fun narbCopy(prefix: File, version: String, body: String) {
        val lib = File(
            prefix,
            "node_modules/.pnpm/node-addon-require-builtin@$version/" +
                "node_modules/node-addon-require-builtin/lib"
        )
        lib.mkdirs()
        File(lib, "index.js").writeText(body)
    }

    @Test
    fun `no pnpm dir counts as patched`() {
        val prefix = tmp.newFolder("prefix-empty")
        assertTrue(DshFlow.stubPatchesPresent(prefix))
    }

    @Test
    fun `package absent counts as patched`() {
        val prefix = tmp.newFolder("prefix-other")
        File(prefix, "node_modules/.pnpm/koffi@3.1.1/node_modules/koffi").mkdirs()
        assertTrue(DshFlow.stubPatchesPresent(prefix))
    }

    @Test
    fun `all copies shimmed`() {
        val prefix = tmp.newFolder("prefix-ok")
        narbCopy(prefix, "0.1.6", "// $marker\nmodule.exports={};")
        narbCopy(prefix, "0.1.9", "// $marker\nmodule.exports={};")
        assertTrue(DshFlow.stubPatchesPresent(prefix))
    }

    /** 事故现场：旧版本副本已打补丁，新版本副本仍是上游原样。 */
    @Test
    fun `one unshimmed copy among many is detected`() {
        val prefix = tmp.newFolder("prefix-half")
        narbCopy(prefix, "0.1.6", "// $marker\nmodule.exports={};")
        narbCopy(prefix, "0.1.9", "\"use strict\";\nmodule.exports={};")
        assertFalse(DshFlow.stubPatchesPresent(prefix))
    }

    @Test
    fun `missing entry file is detected`() {
        val prefix = tmp.newFolder("prefix-broken")
        File(
            prefix,
            "node_modules/.pnpm/node-addon-require-builtin@0.1.9/node_modules/node-addon-require-builtin"
        ).mkdirs()
        assertFalse(DshFlow.stubPatchesPresent(prefix))
    }
}
