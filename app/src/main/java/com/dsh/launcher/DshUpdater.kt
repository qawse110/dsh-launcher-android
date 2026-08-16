package com.dsh.launcher

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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

    data class State(val version: String?, val checkedAt: Long)

    private fun stateFile(ctx: Context): File = File(ctx.filesDir, "dsh-update.json")

    private fun readState(ctx: Context): State {
        return try {
            val j = JSONObject(stateFile(ctx).readText())
            State(j.optString("version").takeIf { it.isNotBlank() }, j.optLong("checkedAt"))
        } catch (_: Throwable) {
            State(null, 0L)
        }
    }

    private fun writeState(ctx: Context, version: String, checkedAt: Long) {
        try {
            val j = JSONObject()
            j.put("version", version)
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
     * 检查 npm registry 是否有新版本。
     * @param force true 忽略检查间隔强制检查。
     * @return 新版本号（有更新），或 null（已是最新/无网络/失败）。
     */
    fun checkRemote(ctx: Context, force: Boolean, log: (String) -> Unit): String? {
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
            val latest = j.optJSONObject("dist-tags")?.optString("latest")?.takeIf { it.isNotBlank() } ?: return null
            writeState(ctx, cur, System.currentTimeMillis())
            if (compareVersions(latest, cur) <= 0) {
                log("已是新版（本地 $cur，远端 $latest）")
                null
            } else {
                log("发现新版本 $latest（本地 $cur）")
                latest
            }
        } catch (t: Throwable) {
            log("版本检查失败：${t.message}")
            null
        }
    }

    private fun fetchOrNull(url: String): String? {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "DshLauncher/4.0")
            conn.connect()
            if (conn.responseCode !in 200..399) return null
            conn.inputStream.bufferedReader().use { it.readText() }.also { conn.disconnect() }
        } catch (_: Throwable) {
            null
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
}