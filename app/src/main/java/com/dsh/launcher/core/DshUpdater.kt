package com.dsh.launcher.core

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh 自动更新：通过 npm 官方包 `@deepseek-ai/dsh` 检查/安装/更新。
 *
 * 协议：
 *   - 版本源：npm registry 的 `@deepseek-ai/dsh` `dist-tags.latest`。
 *   - 安装/更新动作：由 ConsoleActivity 调用 install-dsh.mjs 执行
 *     `npm install --prefix files/dsh-prefix @deepseek-ai/dsh@latest`。
 *   - 本地状态：`files/dsh-update.json`，记录最近检查时间。
 */
object DshUpdater {

    private const val NPM_REGISTRY = "https://registry.npmmirror.com/@deepseek-ai/dsh"
    private const val NPM_REGISTRY_FALLBACK = "https://registry.npmjs.org/@deepseek-ai/dsh"
    private const val AUTO_CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000 // 自动检查间隔 6 小时

    data class State(val checkedAt: Long)

    private fun stateFile(ctx: Context): File = File(ctx.filesDir, "dsh-update.json")

    private fun readState(ctx: Context): State {
        return try {
            val j = JSONObject(stateFile(ctx).readText())
            State(j.optLong("checkedAt"))
        } catch (_: Throwable) {
            State(0L)
        }
    }

    private fun writeState(ctx: Context, checkedAt: Long) {
        try {
            val j = JSONObject()
            j.put("checkedAt", checkedAt)
            stateFile(ctx).writeText(j.toString())
        } catch (_: Throwable) {
        }
    }

    /** 当前生效版本：读取 npm 安装目录里的 @deepseek-ai/dsh；未安装时返回 0.0.0（待安装）。 */
    fun currentVersion(ctx: Context): String {
        installedVersion(ctx)?.let { return it }
        return "0.0.0"
    }

    /** 从 files/dsh-prefix 读取已安装的官方包版本。 */
    private fun installedVersion(ctx: Context): String? {
        return try {
            val pkg = File(ctx.filesDir, "dsh-prefix/node_modules/@deepseek-ai/dsh/package.json")
            if (!pkg.isFile) return null
            JSONObject(pkg.readText()).optString("version").takeIf { it.isNotBlank() }
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * 检查 npm registry 是否有新版本（latest 稳定线）。
     * @param force true 忽略检查间隔强制检查。
     * @return 新版本号（有更新），或 null（已是最新/无网络/失败）。
     */
    fun checkRemote(ctx: Context, force: Boolean, log: (String) -> Unit): String? =
        checkRemoteTag(ctx, "latest", force, log)

    /**
     * 检查 npm registry 是否有新版本（next 预发布线）。
     * @param force true 忽略检查间隔强制检查。
     * @return 新版本号（有更新），或 null（已是最新/无网络/失败）。
     */
    fun checkRemoteNext(ctx: Context, force: Boolean, log: (String) -> Unit): String? =
        checkRemoteTag(ctx, "next", force, log)

    private fun checkRemoteTag(ctx: Context, tag: String, force: Boolean, log: (String) -> Unit): String? {
        val state = readState(ctx)
        if (!force && state.checkedAt > 0 && System.currentTimeMillis() - state.checkedAt < AUTO_CHECK_INTERVAL_MS) {
            log("检查跳过（距上次 ${(System.currentTimeMillis() - state.checkedAt) / 1000}s < 6h）")
            return null
        }
        val cur = installedVersion(ctx) ?: run {
            log("dsh 尚未安装，跳过版本检查（首次运行直接安装）")
            return null
        }
        return try {
            val body = fetchOrNull(NPM_REGISTRY) ?: fetchOrNull(NPM_REGISTRY_FALLBACK) ?: return null
            val j = JSONObject(body)
            val remote = j.optJSONObject("dist-tags")?.optString(tag)?.takeIf { it.isNotBlank() } ?: return null
            writeState(ctx, System.currentTimeMillis())
            if (compareVersions(remote, cur) <= 0) {
                log("已是新版（本地 $cur，远端 $tag=$remote）")
                null
            } else {
                log("发现新版本 $remote（本地 $cur，dist-tag=$tag）")
                remote
            }
        } catch (t: Throwable) {
            log("版本检查失败：${t.message}")
            null
        }
    }

    private fun fetchOrNull(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "DshLauncher/4.0")
            conn.connect()
            if (conn.responseCode !in 200..399) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Throwable) {
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /** 语义化版本比较：a > b 返回正数。支持 x / x.y / x.y.z 与 prerelease（如 0.1.0-rc.6）。 */
    fun compareVersions(a: String, b: String): Int {
        val (pa, preA) = parseSemVer(a)
        val (pb, preB) = parseSemVer(b)
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x - y
        }
        if (preA == null && preB == null) return 0
        if (preA == null) return 1
        if (preB == null) return -1
        for (i in 0 until minOf(preA.size, preB.size)) {
            val x = preA[i]
            val y = preB[i]
            val xn = x.toIntOrNull()
            val yn = y.toIntOrNull()
            val cmp = when {
                xn != null && yn != null -> xn.compareTo(yn)
                xn != null -> -1
                yn != null -> 1
                else -> x.compareTo(y)
            }
            if (cmp != 0) return cmp
        }
        return preA.size.compareTo(preB.size)
    }

    private fun parseSemVer(s: String): Pair<List<Int>, List<String>?> {
        val noBuild = s.trim().substringBefore('+')
        val parts = noBuild.split('-', limit = 2)
        val core = parts[0].split('.').mapNotNull { it.toIntOrNull() }
        val pre = if (parts.size > 1 && parts[1].isNotBlank()) parts[1].split('.') else null
        return core to pre
    }

    // ================= 临时更新 / 回滚保护 =================
    // 语义：任何「版本会变化的全量安装」都被视为临时更新——保留上一版本作为回滚基线，
    // 若新版本装完/启动异常（如插件不兼容）自动回滚；新版本连续 3 次稳定启动后自动确认。
    // 状态存在 CONSOLE prefs：KEY_PREV_VERSION=回滚基线、KEY_TEMP_VERSION=当前临时版本、
    // KEY_TEMP_BOOTS=临时版本连续成功启动次数、KEY_AUTO_ROLLED=本次窗口已自动回滚过。

    private const val KEY_PREV_VERSION = "dsh_prev_version"
    private const val KEY_TEMP_VERSION = "dsh_temp_version"
    private const val KEY_TEMP_BOOTS = "dsh_temp_boots"
    private const val KEY_AUTO_ROLLED = "dsh_auto_rolled"
    /** 临时版本连续成功启动几次后自动确认（撤销回滚基线）。 */
    private const val AUTO_CONFIRM_BOOTS = 3

    private fun console(ctx: Context) =
        ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)

    /** 回滚基线版本（更新前的可用版本）；null = 无临时窗口。 */
    fun prevVersion(ctx: Context): String? = console(ctx).getString(KEY_PREV_VERSION, null)

    /** 当前是否处于临时更新窗口（更新已装、尚未确认/未自动确认）。 */
    fun isTempWindow(ctx: Context): Boolean = prevVersion(ctx) != null

    /** 当前临时版本号（null 表示不在临时窗口）。 */
    fun tempVersion(ctx: Context): String? = console(ctx).getString(KEY_TEMP_VERSION, null)

    /**
     * 全量安装/更新前调用：把当前已装版本记为回滚基线（仅当本次会改变版本且
     * 非回滚重装途中时）。首次安装（未装过）不记录。返回是否记录了基线。
     */
    fun recordRollbackBaselineIfChanging(ctx: Context, changing: Boolean, onLog: (String) -> Unit): Boolean {
        if (!changing) return false
        // 自动回滚触发的重装：保持原始基线，不被回滚目标覆盖
        if (console(ctx).getBoolean(KEY_AUTO_ROLLED, false)) return false
        val cur = installedVersion(ctx) ?: return false
        console(ctx).edit()
            .putString(KEY_PREV_VERSION, cur)
            .remove(KEY_TEMP_VERSION)
            .remove(KEY_TEMP_BOOTS)
            .apply()
        onLog("临时更新保护开启：可回滚到 v$cur")
        return true
    }

    /**
     * 安装脚本成功后调用：比较实际安装版本与基线——
     * 版本确实变化 → 进入临时窗口；未变化（重装同版本）→ 撤销基线。
     */
    fun afterInstall(ctx: Context, onLog: (String) -> Unit) {
        val prev = console(ctx).getString(KEY_PREV_VERSION, null) ?: return
        val cur = installedVersion(ctx)
        if (cur == null) return
        if (cur == prev) {
            onLog("安装后版本未变化，撤销临时更新保护")
            clearTemp(ctx)
            return
        }
        console(ctx).edit().putString(KEY_TEMP_VERSION, cur).apply()
        onLog("已临时更新到 v$cur（回滚保护中，可回滚到 v$prev）")
    }

    /**
     * web 成功启动后调用：临时版本连续稳定启动 [AUTO_CONFIRM_BOOTS] 次即自动确认
     * （撤销回滚基线），避免一直挂着「回滚」提示。
     */
    fun noteSuccessfulBoot(ctx: Context, onLog: (String) -> Unit) {
        if (!isTempWindow(ctx)) return
        val cur = installedVersion(ctx)
        val temp = console(ctx).getString(KEY_TEMP_VERSION, null)
        if (temp == null || cur != temp) {
            clearTemp(ctx) // 版本与临时窗口不一致：直接结束窗口
            return
        }
        val n = console(ctx).getInt(KEY_TEMP_BOOTS, 0) + 1
        console(ctx).edit().putInt(KEY_TEMP_BOOTS, n).apply()
        if (n >= AUTO_CONFIRM_BOOTS) {
            onLog("临时版本 v$cur 连续 ${n} 次稳定启动，自动确认此版本")
            clearTemp(ctx)
        }
    }

    /**
     * 尝试自动回滚：仅当临时窗口激活且本窗口尚未回滚过时生效——
     * 置一次性安装 tag=上一版本并标记已回滚，随后安装流程会重装旧版本。
     * @return true=已触发自动回滚（调用方应重跑安装流程）
     */
    fun maybeAutoRollback(ctx: Context, onLog: (String) -> Unit): Boolean {
        val prev = prevVersion(ctx) ?: return false
        if (console(ctx).getBoolean(KEY_AUTO_ROLLED, false)) return false
        console(ctx).edit().putBoolean(KEY_AUTO_ROLLED, true).apply()
        // install-dsh.mjs 支持精确版本号：@deepseek-ai/dsh@<prev> 直接重装旧版
        console(ctx).edit().putString("dsh_install_tag", prev).apply()
        onLog("检测到更新后异常，自动回滚到 v$prev …")
        return true
    }

    /** 用户「确认此版本」或回滚完成后调用：清除临时窗口与回滚基线。 */
    fun confirmVersion(ctx: Context, onLog: (String) -> Unit = {}) {
        val prev = prevVersion(ctx)
        if (prev != null) onLog("已确认当前版本，回滚基线 v$prev 已清除")
        clearTemp(ctx)
    }

    private fun clearTemp(ctx: Context) {
        console(ctx).edit()
            .remove(KEY_PREV_VERSION)
            .remove(KEY_TEMP_VERSION)
            .remove(KEY_TEMP_BOOTS)
            .remove(KEY_AUTO_ROLLED)
            .apply()
    }
}