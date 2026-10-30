package com.dsh.nextapp1.core

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 插件「在线升级」（npm 渠道）的 Kotlin 侧读写层。
 *
 * 分工：网络请求、tarball 解包、备份/回滚、降级守卫**全部**在
 * files/install/plugin-upgrade.mjs 里（Node 侧只有一份，避免 Kotlin/JS 两套判据漂移）。
 * 这里只做三件事：
 *   1. 保证脚本落到 files/install/（assets 改了但快速启动路径没同步时也能跑）；
 *   2. 读 files/plugin-upgrade.json（脚本写的检查/升级状态）给界面渲染；
 *   3. 列 files/.plugin-backup/<dir>/ 的备份，供「回滚」选版本。
 *
 * 状态文件缺失是**正常态**（首次使用前不存在），因此 readState 返回 State(exists=false)
 * 而不是抛错 —— 界面据此显示「未检查」，绝不把「没查过」渲染成「已是最新」。
 */
object PluginUpgrade {

    /** 脚本在 APK assets 里的相对路径，同时也是 files/ 下的落地相对路径。 */
    const val SCRIPT_REL = "install/plugin-upgrade.mjs"

    private const val STATE_NAME = "plugin-upgrade.json"
    private const val BACKUP_ROOT_NAME = ".plugin-backup"

    /** 与脚本里 CHECK_TTL_MS 保持一致：6 小时内复用缓存，超过视为过期。 */
    const val CHECK_TTL_MS = 6L * 60 * 60 * 1000

    /** 与 plugin-upgrade.mjs 的 status 取值严格同名字符串。 */
    const val STATUS_OUTDATED = "outdated"
    const val STATUS_LATEST = "latest"
    const val STATUS_AHEAD = "ahead"
    const val STATUS_ERROR = "error"
    const val STATUS_NO_NPM = "no-npm"

    /** 清单里的一条 npm 渠道插件在上游/本地的对比结果（脚本 items[] 的一项）。 */
    data class Item(
        val dir: String,
        val name: String,
        val title: String,
        val npm: String,
        val local: String,
        val latest: String,
        val updateAvailable: Boolean,
        val status: String,
        val error: String?,
        /**
         * 清单里标了 npmTrimmed：本仓副本是上游包的裁剪版（只删了 sourcemap / .d.ts /
         * 文档 / 非本宿主适配层）。升级会用上游完整包覆盖，只做加法 —— 功能不变，
         * 但体积会变大，界面必须提前讲清，否则用户会以为升级出了 bug。
         */
        val trimmed: Boolean = false,
    ) {
        /** 是否真有可升级版本（脚本的 updateAvailable 与 status 任一说有都算，容忍旧状态文件）。 */
        val hasUpdate: Boolean
            get() = updateAvailable || status == STATUS_OUTDATED

        /** 是否已经查过上游（latest 非空即视为有结果）。 */
        val checked: Boolean
            get() = latest.isNotBlank()
    }

    /** 一次在线升级的记录（脚本 upgraded[<dir>]）。 */
    data class Upgraded(val from: String, val to: String, val at: String, val backup: String)

    data class Summary(
        val total: Int = 0,
        val outdated: Int = 0,
        val latest: Int = 0,
        val ahead: Int = 0,
        val error: Int = 0,
        val noNpm: Int = 0,
    )

    data class State(
        val checkedAt: String = "",
        val checkedAtMs: Long = 0L,
        val ok: Boolean = true,
        val items: List<Item> = emptyList(),
        val upgraded: Map<String, Upgraded> = emptyMap(),
        val summary: Summary = Summary(),
        /** 状态文件是否存在。false 时界面必须显示「未检查」而不是任何「最新」结论。 */
        val exists: Boolean = false,
    ) {
        fun itemOf(dir: String): Item? = items.firstOrNull { it.dir == dir }

        /** 当前可升级的条目（已查过且有新版本）。 */
        val upgradable: List<Item>
            get() = items.filter { it.hasUpdate }

        /** 已在线升级过、且目标版本仍是当前版本的条目（即「还没重启」的那些）。 */
        fun upgradedTo(dir: String, localVersion: String): Upgraded? =
            upgraded[dir]?.takeIf { it.to.isNotBlank() && it.to == localVersion }
    }

    /** 备份根目录：files/.plugin-backup（每个插件一个子目录，下面按版本分层）。 */
    fun stateFile(ctx: Context): File = File(ctx.filesDir, STATE_NAME)

    fun scriptFile(ctx: Context): File = File(ctx.filesDir, SCRIPT_REL)

    fun backupRoot(ctx: Context): File = File(ctx.filesDir, BACKUP_ROOT_NAME)

    private fun str(o: JSONObject, key: String): String {
        val v = o.opt(key) ?: return ""
        if (v === JSONObject.NULL) return ""
        return v.toString().trim()
    }

    private fun bool(o: JSONObject, key: String, fallback: Boolean = false): Boolean = try {
        o.optBoolean(key, fallback)
    } catch (t: Throwable) {
        fallback
    }

    /** 读检查/升级状态。文件缺失或损坏 → 空状态（exists=false），绝不抛错。 */
    fun readState(ctx: Context): State {
        val f = stateFile(ctx)
        if (!f.isFile) return State()
        return try {
            val j = JSONObject(f.readText())

            val items = mutableListOf<Item>()
            val itemsArr = j.optJSONArray("items")
            if (itemsArr != null) {
                for (i in 0 until itemsArr.length()) {
                    val o = itemsArr.optJSONObject(i) ?: continue
                    val dir = str(o, "dir")
                    if (dir.isEmpty()) continue
                    items.add(
                        Item(
                            dir = dir,
                            name = str(o, "name").ifEmpty { dir },
                            title = str(o, "title").ifEmpty { dir },
                            npm = str(o, "npm"),
                            local = str(o, "local"),
                            latest = str(o, "latest"),
                            // 脚本写的是布尔；旧状态文件若缺字段则以 status 兜底（见 Item.hasUpdate）
                            updateAvailable = bool(o, "updateAvailable"),
                            status = str(o, "status").ifEmpty { STATUS_NO_NPM },
                            error = str(o, "error").ifBlank { null },
                            trimmed = bool(o, "trimmed"),
                        )
                    )
                }
            }

            val upgraded = mutableMapOf<String, Upgraded>()
            val upObj = j.optJSONObject("upgraded")
            if (upObj != null) {
                val keys = upObj.keys()
                while (keys.hasNext()) {
                    val dir = keys.next() ?: continue
                    val v = upObj.optJSONObject(dir) ?: continue
                    upgraded[dir] = Upgraded(
                        from = str(v, "from"),
                        to = str(v, "to"),
                        at = str(v, "at"),
                        backup = str(v, "backup"),
                    )
                }
            }

            val summary = summarize(items)
            State(
                checkedAt = str(j, "checkedAt"),
                checkedAtMs = j.optLong("checkedAtMs", 0L),
                ok = bool(j, "ok", true),
                items = items,
                upgraded = upgraded,
                summary = summary,
                exists = true,
            )
        } catch (t: Throwable) {
            AppLog.e("PluginUpgrade", "read plugin-upgrade.json failed: ${t.message}")
            State()
        }
    }

    private fun summarize(items: List<Item>): Summary = Summary(
        total = items.size,
        outdated = items.count { it.status == STATUS_OUTDATED },
        latest = items.count { it.status == STATUS_LATEST },
        ahead = items.count { it.status == STATUS_AHEAD },
        error = items.count { it.status == STATUS_ERROR },
        noNpm = items.count { it.status == STATUS_NO_NPM },
    )

    /**
     * 状态是否已过期（超过 [CHECK_TTL_MS] 或从没查过）。
     *
     * 注意 checkedAtMs 在「回滚」后会被脚本写成 0（强制下次走网络），所以 0 必须判为过期。
     */
    fun isStale(state: State, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (!state.exists || state.checkedAtMs <= 0L) return true
        val age = nowMs - state.checkedAtMs
        return age < 0 || age > CHECK_TTL_MS
    }

    /**
     * 保证 files/install/plugin-upgrade.mjs 存在且是最新版。
     *
     * 每次调用都从 assets 覆盖一次（脚本仅几十 KB，换来「APK 更新了脚本但快速启动没走
     * syncCompatScripts」这种半同步态下也不会跑到旧脚本）。拷贝失败但本地已有旧脚本时
     * 仍返回旧文件，让用户至少还能重试而不是彻底没有入口。
     */
    fun ensureScript(ctx: Context): File? {
        val dst = scriptFile(ctx)
        dst.parentFile?.mkdirs()
        val copied = try {
            AssetSync.copyAsset(ctx, SCRIPT_REL, dst)
        } catch (t: Throwable) {
            AppLog.e("PluginUpgrade", "copy plugin-upgrade.mjs failed: ${t.message}")
            false
        }
        if (copied && dst.isFile && dst.length() > 0L) return dst
        if (dst.isFile && dst.length() > 0L) {
            AppLog.i("PluginUpgrade", "plugin-upgrade.mjs 沿用本地旧副本（assets 拷贝失败）")
            return dst
        }
        return null
    }

    /** 一个可回滚的备份。 */
    data class Backup(val version: String, val dir: File, val mtime: Long)

    /**
     * 列某插件的备份，按时间倒序（与脚本 listBackups 同序）。
     *
     * 只认「里面有 package.json」的目录：脚本 makeBackup 失败时会留下空壳，
     * 那种目录回滚过去等于把插件清空，绝不能出现在候选里。
     */
    fun listBackups(ctx: Context, dir: String): List<Backup> {
        val root = File(backupRoot(ctx), dir)
        val kids = root.listFiles() ?: return emptyList()
        return kids
            .filter { it.isDirectory && File(it, "package.json").isFile }
            .map { Backup(it.name, it, it.lastModified()) }
            .sortedByDescending { it.mtime }
    }
}
