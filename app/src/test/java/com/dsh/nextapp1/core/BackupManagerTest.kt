package com.dsh.nextapp1.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.zip.ZipFile

/** BackupManager：打包 → 列表 → 恢复（合并覆盖语义）往返回归。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BackupManagerTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @Before fun clean() {
        File(ctx.filesDir, ".dsh").deleteRecursively()
        File(ctx.filesDir, "plugins").deleteRecursively()
        File(ctx.filesDir, "backups").deleteRecursively()
        File(ctx.filesDir, "state").deleteRecursively()
        // Robolectric 下共享下载目录常可写，备份可能落在 filesDir 外：整个备份目录统一清空
        runCatching {
            BackupManager.backupDir(ctx).listFiles()?.forEach { it.deleteRecursively() }
        }
        for (ns in listOf(
            AppState.Prefs.CONSOLE, AppState.Prefs.KEEPALIVE,
            AppState.Prefs.UI, AppState.Prefs.BRIDGE,
        )) {
            ctx.getSharedPreferences(ns, Context.MODE_PRIVATE).edit().clear().commit()
        }
        MarkerStore.invalidate()
    }

    /** 造一份最小可备份现场：.dsh 两个文件 + plugins 一个文件 + 一个 UI 配置项。 */
    private fun seed(seedText: String) {
        File(ctx.filesDir, ".dsh/sessions").mkdirs()
        File(ctx.filesDir, ".dsh/settings.yaml").writeText(seedText)
        File(ctx.filesDir, ".dsh/sessions/s1.json").writeText("""{"t":"$seedText"}""")
        File(ctx.filesDir, "plugins/dsh-demo").mkdirs()
        File(ctx.filesDir, "plugins/dsh-demo/package.json").writeText("""{"name":"dsh-demo"}""")
        ctx.getSharedPreferences(AppState.Prefs.UI, Context.MODE_PRIVATE)
            .edit().putString("marker", seedText).putInt("n", 7).commit()
    }

    @Test fun `create 打包勾选内容且产出 manifest`() {
        seed("v1")
        val zip = BackupManager.create(ctx, BackupManager.Options(), tag = "test")
        assertNotNull("备份应产出文件", zip)
        val names = mutableListOf<String>()
        ZipFile(zip!!).use { zf ->
            val en = zf.entries()
            while (en.hasMoreElements()) names += en.nextElement().name
        }
        assertTrue(names.contains("manifest.json"))
        assertTrue(names.contains("dsh/settings.yaml"))
        assertTrue(names.contains("dsh/sessions/s1.json"))
        assertTrue(names.contains("plugins/dsh-demo/package.json"))
        assertTrue(names.any { it.startsWith("launcher/prefs/") })

        val meta = BackupManager.readMeta(zip)
        assertNotNull("manifest 应可解析", meta)
        assertTrue("manifest 应带 createdAt", meta!!.createdAt > 0)
        assertEquals("dsh 分区 2 个文件", 2, meta.stats["dsh"]?.files)
        assertEquals("plugins 分区 1 个文件", 1, meta.stats["plugins"]?.files)
        assertTrue("launcher 分区应有 prefs", (meta.stats["launcher"]?.files ?: 0) >= 1)
    }

    @Test fun `create 不勾选的内容不入库`() {
        seed("v1")
        val zip = BackupManager.create(
            ctx,
            BackupManager.Options(dshData = true, launcherConfig = false, plugins = false),
            tag = "t"
        )
        assertNotNull(zip)
        val names = mutableListOf<String>()
        ZipFile(zip!!).use { zf ->
            val en = zf.entries()
            while (en.hasMoreElements()) names += en.nextElement().name
        }
        assertTrue(names.any { it.startsWith("dsh/") })
        assertFalse(names.any { it.startsWith("plugins/") })
        assertFalse(names.any { it.startsWith("launcher/") })
    }

    @Test fun `restore 合并覆盖且不删除额外文件`() {
        seed("v1")
        val zip = BackupManager.create(ctx, BackupManager.Options(), tag = "t")!!

        // 现状改写 + 增加一个备份包里没有的文件
        File(ctx.filesDir, ".dsh/settings.yaml").writeText("v2")
        File(ctx.filesDir, ".dsh/sessions/extra.json").writeText("keep-me")
        ctx.getSharedPreferences(AppState.Prefs.UI, Context.MODE_PRIVATE)
            .edit().putString("marker", "v2").commit()

        val ok = BackupManager.restore(ctx, zip) { }
        assertTrue("恢复应成功", ok)

        assertEquals("v1", File(ctx.filesDir, ".dsh/settings.yaml").readText())
        assertEquals("""{"t":"v1"}""", File(ctx.filesDir, ".dsh/sessions/s1.json").readText())
        // 合并语义：包里没有的文件必须保留
        assertEquals("keep-me", File(ctx.filesDir, ".dsh/sessions/extra.json").readText())
        // prefs 覆盖
        assertEquals("v1", ctx.getSharedPreferences(AppState.Prefs.UI, Context.MODE_PRIVATE)
            .getString("marker", null))
        assertEquals(7, ctx.getSharedPreferences(AppState.Prefs.UI, Context.MODE_PRIVATE).getInt("n", 0))
    }

    @Test fun `restore 拒绝非备份包`() {
        val junk = File(ctx.filesDir, "junk.zip")
        java.util.zip.ZipOutputStream(junk.outputStream()).use { zos ->
            zos.putNextEntry(java.util.zip.ZipEntry("hello.txt"))
            zos.write("hi".toByteArray())
            zos.closeEntry()
        }
        val ok = BackupManager.restore(ctx, junk) { }
        assertFalse("缺 manifest 应拒绝", ok)
    }

    @Test fun `list 按时间倒序且可删除`() {
        seed("v1")
        val a = BackupManager.create(ctx, BackupManager.Options(), tag = "a")!!
        Thread.sleep(1_100) // 文件名时间戳到秒，避免同名互相覆盖
        val b = BackupManager.create(ctx, BackupManager.Options(), tag = "b")!!
        val items = BackupManager.list(ctx)
        assertTrue("应有 2 份", items.size >= 2)
        assertEquals("最新的排最前", b.name, items.first().file.name)
        assertTrue(BackupManager.delete(items.first { it.file.name == a.name }))
        assertFalse(BackupManager.list(ctx).any { it.file.name == a.name })
    }

    @Test fun `scan 统计与备份结果一致`() {
        seed("v1")
        val scan = BackupManager.scan(ctx, BackupManager.Options())
        val dsh = scan["dsh"] ?: error("缺 dsh 统计")
        assertTrue("dsh 应有 2 个文件", dsh.files == 2)
        assertTrue(dsh.bytes > 0)
        assertTrue((scan["plugins"]?.files ?: 0) == 1)
    }

    @Test fun `空内容时 create 返回 null`() {
        // 无任何种子数据
        assertNull(BackupManager.create(ctx, BackupManager.Options(), tag = "empty"))
        assertNull(BackupManager.create(ctx, BackupManager.Options(false, false, false), tag = "none"))
    }

    @Test fun `human 与 humanTime 可读化`() {
        assertEquals("512 B", BackupManager.human(512))
        assertTrue(BackupManager.human(2 * 1024 * 1024).endsWith("MB"))
        assertTrue(BackupManager.human(3L * 1024 * 1024 * 1024).endsWith("GB"))
        assertFalse(BackupManager.humanTime(System.currentTimeMillis()).isBlank())
    }
}
