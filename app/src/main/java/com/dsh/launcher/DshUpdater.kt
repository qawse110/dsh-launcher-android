package com.dsh.launcher

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * dsh 自动更新：从 GitHub Releases 检查新版本并下载预构建产物。
 *
 * 协议：
 *   - 版本源：`qawse110/dsh-launcher-android` 仓库的最新 release tag（如 v0.2.0）。
 *   - 产物：release asset `prebuilt.tgz`（dsh 源树整包，install-dsh.mjs 解压覆盖）。
 *   - 本地状态：`files/dsh-update.json`，记录已下载版本与最近检查时间。
 *   - 生效时机：下载完成写 `files/updates/prebuilt.tgz`，下一次 runDshFlow 优先
 *     使用该包解压（成功后删除），随后重启 web 进程。
 */
object DshUpdater {

    private const val UPDATE_REPO = "qawse110/dsh-launcher-android"
    private const val UPDATE_URL = "https://api.github.com/repos/$UPDATE_REPO/releases/latest"
    private const val AUTO_CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000 // 自动检查间隔 6 小时
    private const val USER_AGENT = "DshLauncher/2.0"

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
        val j = JSONObject()
        j.put("version", version)
        j.put("checkedAt", checkedAt)
        stateFile(ctx).writeText(j.toString())
    }

    /** 当前生效版本：优先本地已应用/已下载版本，否则 assets 内置版本。 */
    fun currentVersion(ctx: Context): String {
        readState(ctx).version?.let { return it }
        return try {
            ctx.assets.open("version.txt").bufferedReader().use { it.readText().trim() }
        } catch (_: Throwable) {
            "0.0.0"
        }
    }

    /** 本地是否已有待应用的更新包。 */
    fun hasPendingUpdate(ctx: Context): Boolean {
        val f = File(ctx.filesDir, "updates/prebuilt.tgz")
        return f.exists() && f.length() > 1_000_000
    }

    /** 待应用更新包（调用方确认 hasPendingUpdate 后使用）。 */
    fun pendingUpdateFile(ctx: Context): File = File(ctx.filesDir, "updates/prebuilt.tgz")

    /**
     * 检查远端是否有新版本。
     * @param force true 忽略检查间隔强制检查。
     * @return 新版本号（有更新），或 null（已是最新/无网络/失败）。
     */
    fun checkRemote(ctx: Context, force: Boolean, log: (String) -> Unit): String? {
        val state = readState(ctx)
        if (!force && state.checkedAt > 0 && System.currentTimeMillis() - state.checkedAt < AUTO_CHECK_INTERVAL_MS) {
            log("检查跳过（距上次 ${(System.currentTimeMillis() - state.checkedAt) / 1000}s < 6h）")
            return null
        }
        return try {
            val conn = URL(UPDATE_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", USER_AGENT)
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.connect()
            val code = conn.responseCode
            if (code !in 200..399) {
                log("版本检查失败 HTTP $code")
                writeState(ctx, state.version ?: currentVersion(ctx), System.currentTimeMillis())
                return null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val j = JSONObject(body)
            val tag = j.optString("tag_name").removePrefix("v").takeIf { it.isNotBlank() } ?: return null
            val cur = state.version ?: currentVersion(ctx)
            writeState(ctx, state.version ?: cur, System.currentTimeMillis())
            if (compareVersions(tag, cur) <= 0) {
                log("已是新版（本地 $cur，远端 $tag）")
                null
            } else {
                log("发现新版本 v$tag（本地 $cur）")
                tag
            }
        } catch (t: Throwable) {
            log("版本检查失败：${t.message}")
            null
        }
    }

    /**
     * 下载指定版本的 prebuilt.tgz 到 updates/ 目录。
     * @return 成功下载的文件路径，或 null。
     */
    fun download(ctx: Context, version: String, log: (String) -> Unit): File? {
        return try {
            val conn = URL(UPDATE_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", USER_AGENT)
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.connect()
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val j = JSONObject(body)
            val assets = j.optJSONArray("assets") ?: return null
            var url: String? = null
            var size = 0L
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name") == "prebuilt.tgz") {
                    url = a.optString("browser_download_url")
                    size = a.optLong("size")
                    break
                }
            }
            if (url == null) {
                log("发布中没有 prebuilt.tgz 资产")
                return null
            }
            val dir = File(ctx.filesDir, "updates").apply { mkdirs() }
            val tmp = File(dir, "prebuilt.tgz.tmp")
            var got = 0L
            val dl = URL(url).openConnection() as HttpURLConnection
            dl.connectTimeout = 20_000
            dl.readTimeout = 60_000
            dl.instanceFollowRedirects = true
            dl.setRequestProperty("User-Agent", USER_AGENT)
            dl.connect()
            if (dl.responseCode !in 200..399) {
                log("下载失败 HTTP ${dl.responseCode}")
                return null
            }
            dl.inputStream.use { input -> tmp.outputStream().use { output -> got = input.copyTo(output) } }
            dl.disconnect()
            if (size > 0 && got != size) {
                log("下载不完整（$got / $size 字节）")
                tmp.delete()
                return null
            }
            val final = File(dir, "prebuilt.tgz")
            tmp.renameTo(final)
            writeState(ctx, version, System.currentTimeMillis())
            log("下载完成 ${got / 1024 / 1024}MB（v$version）")
            final
        } catch (t: Throwable) {
            log("下载失败：${t.message}")
            null
        }
    }

    /** 语义化版本比较：a > b 返回正数。支持 x / x.y / x.y.z。 */
    fun compareVersions(a: String, b: String): Int {
        val pa = a.trim().split('.').mapNotNull { it.toIntOrNull() }
        val pb = b.trim().split('.').mapNotNull { it.toIntOrNull() }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x - y
        }
        return 0
    }
}