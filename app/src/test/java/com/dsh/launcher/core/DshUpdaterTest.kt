package com.dsh.launcher.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * DshUpdater 回归测试：semver 比较（prerelease 数字段）+ 临时更新/回滚状态机。
 * 用 Robolectric 提供真实 SharedPreferences / filesDir；
 * 用一个假的 dsh-prefix 安装目录模拟 installedVersion。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DshUpdaterTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    /** 伪造已安装的 @deepseek-ai/dsh 版本。 */
    private fun fakeInstall(version: String?) {
        val pkg = File(ctx.filesDir, "dsh-prefix/node_modules/@deepseek-ai/dsh/package.json")
        if (version == null) {
            pkg.delete()
            return
        }
        pkg.parentFile!!.mkdirs()
        pkg.writeText("""{"name":"@deepseek-ai/dsh","version":"$version"}""")
    }

    private fun console() =
        ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)

    @Before
    fun setup() {
        console().edit().clear().commit()
        File(ctx.filesDir, "dsh-prefix").deleteRecursively()
        File(ctx.filesDir, "dsh-update.json").delete()
    }

    @After
    fun cleanup() {
        console().edit().clear().commit()
        File(ctx.filesDir, "dsh-prefix").deleteRecursively()
        File(ctx.filesDir, "dsh-update.json").delete()
    }

    // ================= compareVersions =================

    @Test fun `core 版本逐段比较`() {
        assertTrue(DshUpdater.compareVersions("2.0.0", "1.9.9") > 0)
        assertTrue(DshUpdater.compareVersions("1.10.0", "1.9.0") > 0)
        assertTrue(DshUpdater.compareVersions("1.2.3", "1.2.4") < 0)
        assertEquals(0, DshUpdater.compareVersions("1.2.3", "1.2.3"))
    }

    @Test fun `prerelease 低于正式版`() {
        assertTrue(DshUpdater.compareVersions("1.0.0-rc.1", "1.0.0") < 0)
        assertTrue(DshUpdater.compareVersions("1.0.0", "1.0.0-rc.1") > 0)
    }

    @Test fun `prerelease 数字段按数值比较（rc10 gt rc6）`() {
        assertTrue(DshUpdater.compareVersions("0.1.0-rc.10", "0.1.0-rc.6") > 0)
        assertTrue(DshUpdater.compareVersions("0.1.0-rc.6", "0.1.0-rc.10") < 0)
        assertEquals(0, DshUpdater.compareVersions("0.1.0-rc.6", "0.1.0-rc.6"))
    }

    @Test fun `prerelease 字母段字典序`() {
        assertTrue(DshUpdater.compareVersions("1.0.0-beta", "1.0.0-alpha") > 0)
        assertTrue(DshUpdater.compareVersions("1.0.0-alpha", "1.0.0-beta") < 0)
    }

    @Test fun `数字标识符低于字母数字标识符（semver 第11条）`() {
        assertTrue(DshUpdater.compareVersions("1.0.0-1", "1.0.0-alpha") < 0)
    }

    @Test fun `prerelease 段数多者更高`() {
        assertTrue(DshUpdater.compareVersions("1.0.0-rc.1.1", "1.0.0-rc.1") > 0)
    }

    @Test fun `build metadata 忽略与缺段补零`() {
        assertEquals(0, DshUpdater.compareVersions("1.0.0+build.1", "1.0.0"))
        assertEquals(0, DshUpdater.compareVersions("1.2", "1.2.0"))
        assertEquals(0, DshUpdater.compareVersions("1", "1.0.0"))
    }

    @Test fun `脏输入静默按 0_0_0 处理不崩溃`() {
        assertEquals(0, DshUpdater.compareVersions("abc", "0.0.0"))
        assertTrue(DshUpdater.compareVersions("abc", "1.0.0") < 0)
    }

    // ================= currentVersion / installedVersion =================

    @Test fun `未安装时 currentVersion 为 0_0_0`() {
        assertEquals("0.0.0", DshUpdater.currentVersion(ctx))
    }

    @Test fun `已安装时读取包版本`() {
        fakeInstall("1.2.3")
        assertEquals("1.2.3", DshUpdater.currentVersion(ctx))
    }

    // ================= 临时窗口状态机 =================

    private val logs = mutableListOf<String>()
    private fun log(s: String) { logs.add(s) }

    @Test fun `recordRollbackBaseline 记录当前版本为基线`() {
        fakeInstall("1.0.0")
        val recorded = DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        assertTrue(recorded)
        assertEquals("1.0.0", DshUpdater.prevVersion(ctx))
        assertTrue(logs.any { it.contains("1.0.0") })
    }

    @Test fun `changing=false 或未安装时不记录基线`() {
        assertFalse(DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = false, ::log))
        fakeInstall("1.0.0")
        // 未安装时不记录
        File(ctx.filesDir, "dsh-prefix").deleteRecursively()
        assertFalse(DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log))
        assertNull(DshUpdater.prevVersion(ctx))
    }

    @Test fun `afterInstall 版本变化进入临时窗口`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        assertEquals("2.0.0", DshUpdater.tempVersion(ctx))
        assertTrue(DshUpdater.isTempWindow(ctx))
    }

    @Test fun `afterInstall 重装同版本撤销窗口`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        // 安装后版本没变（重装同版本）
        DshUpdater.afterInstall(ctx, ::log)
        assertNull(DshUpdater.prevVersion(ctx))
        assertFalse(DshUpdater.isTempWindow(ctx))
    }

    @Test fun `noteSuccessfulBoot 3次启动且观察期已满才自动确认`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        // 把窗口时间拨回 25h 前（观察期 24h 已满）
        console().edit().putLong("dsh_temp_at", System.currentTimeMillis() - 25L * 3600_000).commit()
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        assertTrue(DshUpdater.isTempWindow(ctx)) // 前 2 次仍保护
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx)) // 第 3 次 + 观察期已满 → 自动确认
    }

    @Test fun `noteSuccessfulBoot 3次启动但观察期未满不确认`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log) // temp_at = now
        repeat(3) { DshUpdater.noteSuccessfulBoot(ctx, ::log) }
        assertTrue(DshUpdater.isTempWindow(ctx)) // 3 次了，但窗口刚开 → 保护不撤
        // 观察期满后再启动一次即确认
        console().edit().putLong("dsh_temp_at", System.currentTimeMillis() - 25L * 3600_000).commit()
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx))
    }

    @Test fun `noteSuccessfulBoot 旧数据无 temp_at 时间戳时保守起算`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        console().edit().remove("dsh_temp_at").commit()
        repeat(3) { DshUpdater.noteSuccessfulBoot(ctx, ::log) }
        assertTrue(DshUpdater.isTempWindow(ctx)) // 时间戳缺失以本次起算，不会提前确认
        // 补上 25h 前的时间戳后确认
        console().edit().putLong("dsh_temp_at", System.currentTimeMillis() - 25L * 3600_000).commit()
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx))
    }

    @Test fun `noteSuccessfulBoot 版本与窗口不一致直接关窗`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        // 实际版本又被外部换成别的（非 temp）
        fakeInstall("9.9.9")
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx))
    }

    // ================= 自动/手动回滚 =================

    @Test fun `maybeAutoRollback 每窗口只触发一次`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)

        assertTrue(DshUpdater.maybeAutoRollback(ctx, ::log))
        assertEquals("1.0.0", console().getString("dsh_install_tag", null))
        // 第二次被 KEY_AUTO_ROLLED 守卫拦截
        assertFalse(DshUpdater.maybeAutoRollback(ctx, ::log))
        // tag 不被第二次覆盖
        assertEquals("1.0.0", console().getString("dsh_install_tag", null))
    }

    @Test fun `forceRollbackTag 无视 auto-rolled 守卫（手动回滚假回滚修复）`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)

        // 自动回滚已用掉
        assertTrue(DshUpdater.maybeAutoRollback(ctx, ::log))
        assertEquals("1.0.0", console().getString("dsh_install_tag", null))

        // 模拟安装流程消费掉 tag（runFlow 安装后 remove）
        console().edit().remove("dsh_install_tag").commit()

        // 手动回滚必须仍能置 tag（旧实现走 maybeAutoRollback 会静默失败 → 假回滚）
        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)
        assertEquals("1.0.0", console().getString("dsh_install_tag", null))
    }

    @Test fun `forceRollbackTag 清零 boots 计数`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        DshUpdater.noteSuccessfulBoot(ctx, ::log)
        DshUpdater.noteSuccessfulBoot(ctx, ::log) // boots=2

        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)
        assertEquals(0, console().getInt("dsh_temp_boots", 0))
    }

    @Test fun `auto-rolled 守卫超时后允许重新记录基线（防死锁）`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)

        // 守卫期内：不覆盖基线
        assertFalse(DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log))
        assertEquals("1.0.0", DshUpdater.prevVersion(ctx))

        // 把置位时间拨回 3 小时前（守卫期 2h）→ 守卫失效
        console().edit().putLong("dsh_auto_rolled_at", System.currentTimeMillis() - 3L * 3600_000).commit()
        // 此时装的是旧版本 2.0.0（回滚安装失败残留），新更新允许重新记录基线
        val recorded = DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        assertTrue(recorded)
        assertEquals("2.0.0", DshUpdater.prevVersion(ctx))
    }

    @Test fun `auto-rolled 时间戳缺失时视为仍在守卫期（保守兼容旧数据）`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)
        // 删掉时间戳模拟旧版本写入的数据
        console().edit().remove("dsh_auto_rolled_at").commit()
        assertFalse(DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log))
    }

    @Test fun `confirmVersion 清除全部回滚状态`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)

        DshUpdater.confirmVersion(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx))
        assertNull(DshUpdater.prevVersion(ctx))
        assertNull(DshUpdater.tempVersion(ctx))
        assertEquals(0, console().getInt("dsh_temp_boots", 0))
        assertFalse(console().getBoolean("dsh_auto_rolled", false))
        assertEquals(0L, console().getLong("dsh_auto_rolled_at", 0L))
    }

    @Test fun `回滚安装成功后 afterInstall 按 cur==prev 撤销窗口`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        DshUpdater.forceRollbackTag(ctx, "1.0.0", ::log)

        // 回滚重装成功：实际版本回到 prev
        fakeInstall("1.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        assertFalse(DshUpdater.isTempWindow(ctx))
        assertNull(DshUpdater.prevVersion(ctx))
    }

    @Test fun `recordRollbackBaseline 清理残留 temp 与 boots`() {
        // 模拟脏状态：有残留 temp/boots 但无基线
        console().edit()
            .putString("dsh_temp_version", "1.2.3")
            .putInt("dsh_temp_boots", 2)
            .commit()
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        assertEquals("1.0.0", DshUpdater.prevVersion(ctx))
        assertNull(DshUpdater.tempVersion(ctx))
        assertEquals(0, console().getInt("dsh_temp_boots", 0))
        // temp_at 也一并清理
        assertEquals(0L, console().getLong("dsh_temp_at", 0L))
    }

    // ================= 崩溃循环自动回滚（Supervisor.maybeRollbackOnCrashLoop） =================

    private fun keepalive() =
        ctx.getSharedPreferences(AppState.Prefs.KEEPALIVE, Context.MODE_PRIVATE)

    private fun bumpCrashStreak(n: Int) {
        keepalive().edit().putInt("watchdog_fail_streak", n).commit()
    }

    private fun crashStreak(): Int = keepalive().getInt("watchdog_fail_streak", 0)

    @Test fun `crashLoop 达阈值且临时窗口内触发回滚并归零计数`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        // 期望运行态置 true（crash-loop 判定前置条件）
        keepalive().edit().putBoolean("running", true).commit()
        bumpCrashStreak(5)

        assertTrue(Supervisor.maybeRollbackOnCrashLoop(ctx, ::log))
        assertEquals("1.0.0", console().getString("dsh_install_tag", null))
        assertEquals(0, crashStreak()) // 判定消费后归零
        assertTrue(DshUpdater.isTempWindow(ctx)) // 窗口保持，等回滚安装后关闭
    }

    @Test fun `crashLoop 阈值未到不触发`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        keepalive().edit().putBoolean("running", true).commit()
        bumpCrashStreak(4)

        assertFalse(Supervisor.maybeRollbackOnCrashLoop(ctx, ::log))
        assertNull(console().getString("dsh_install_tag", null))
    }

    @Test fun `crashLoop 不在临时窗口时不触发且不误清计数`() {
        // 无临时窗口：dsh 一直没更新过，web 起不来可能是别的原因
        fakeInstall("1.0.0")
        keepalive().edit().putBoolean("running", true).commit()
        bumpCrashStreak(7)

        assertFalse(Supervisor.maybeRollbackOnCrashLoop(ctx, ::log))
        assertEquals(7, crashStreak()) // 未消费
        assertNull(console().getString("dsh_install_tag", null))
    }

    @Test fun `crashLoop 用户已显式停止时不触发`() {
        fakeInstall("1.0.0")
        DshUpdater.recordRollbackBaselineIfChanging(ctx, changing = true, ::log)
        fakeInstall("2.0.0")
        DshUpdater.afterInstall(ctx, ::log)
        // running=false（用户点过「停止 dsh 服务」）
        bumpCrashStreak(6)

        assertFalse(Supervisor.maybeRollbackOnCrashLoop(ctx, ::log))
        assertNull(console().getString("dsh_install_tag", null))
    }
}
