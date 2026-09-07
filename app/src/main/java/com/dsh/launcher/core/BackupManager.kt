package com.dsh.launcher.core

import android.content.Context
import android.os.Environment
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh 数据与启动器配置的备份 / 恢复。
 *
 * 产物：单个 zip（默认落在 /sdcard/Download/DshLauncher/backup/，无存储权限时
 * 自动回退到应用私有 filesDir/backups/），结构：
 *
 * ```
 * manifest.json          备份元信息（格式版本 / 时间 / 版本 / 各分区文件数与字节数）
 * dsh/…                  files/.dsh 目录（会话 sessions、profiles、agent-presets、
 *                        credentials.yaml、settings.yaml、storages、super-injector）
 * plugins/…              files/plugins 目录（已装配插件源码；符号链接跳过）
 * launcher/prefs/…       启动器 SharedPreferences（dsh_console/keepalive/ui/status_bridge）
 * launcher/state/…       files/state/markers.json、files/dsh-update.json
 * ```
 *
 * 关键取舍：
 * - **符号链接一律跳过，且不下钻任何 node_modules**：plugins 与 .dsh/profiles 下的
 *   node_modules 是指向 dsh-prefix（264MB）的 link 农场，
 *   跟随会把备份撑到几百 MB 且恢复时互相踩踏；这些 link 由
 *   `dsh plugin add` 装配时自动重建，不属于「不可重建的状态」。
 * - **排除大块可重建物**：node（内置运行时）、termux、dsh-prefix（npm 安装产物）、
 *   prebuilt.tgz、logs。它们都能由「一键安装」重新生成，备份只留不可重建的状态。
 * - **恢复语义 = 合并覆盖**：只覆盖包内存在的文件，不删除目标目录里的额外文件
 *   （避免把用户后来装的插件/新会话一并抹掉）。
 *
 * 所有 I/O 失败只通过 onProgress 回报并让 create/restore 返回 null/false，
 * 不向调用方抛异常（UI 线程安全）。
 */
object BackupManager {

    private const val DIR_NAME = "backup"
    private const val MANIFEST = "manifest.json"
    private const val FORMAT = 1

    /** 备份保留份数上限（超出按时间从旧到新删除）。 */
    const val KEEP_MAX = 5

    /** 目录根映射：归档内前缀 → 相对 filesDir 的真实路径。恢复时按此表回放。 */
    private val ROOTS = listOf(
        "dsh" to ".dsh",
        "plugins" to "plugins",
    )

    /**
     * 即使勾选了「插件目录」也不打包的真实依赖林：
     * - plugins 下的 node_modules：pnpm 把 dsh-prefix 里的包 link 进来，跟随等于把
     *   264MB 的 npm 安装产物整份复制进备份，且目录里绝大部分是链接而非实体文件；
     * - .dsh/profiles 下的 node_modules：同理，装配 junction 林，由 `dsh plugin add` 重建。
     */
    private val SKIP_DIR_NAMES = setOf("node_modules")

    /** 纳入备份的 SharedPreferences 命名空间（见 [AppState.Prefs]）。 */
    private val PREF_NAMESPACES = listOf(
        AppState.Prefs.CONSOLE,
        AppState.Prefs.KEEPALIVE,
        AppState.Prefs.UI,
        AppState.Prefs.BRIDGE,
    )

    /** 纳入备份的私有散文件（相对 filesDir）。 */
    private val LOOSE_FILES = listOf(
        "state/markers.json",
        "dsh-update.json",
    )

    /** 备份内容选项——与 UI 三个开关一一对应；字段可变以便 UI 直接改。 */
    data class Options(
        var dshData: Boolean = true,
        var launcherConfig: Boolean = true,
        var plugins: Boolean = true,
    ) {
        fun any(): Boolean = dshData || launcherConfig || plugins
    }

    /** 单个分区的统计。 */
    data class Stat(val files: Int = 0, val bytes: Long = 0L)

    /** 备份包元信息（manifest.json 的解析结果）。 */
    data class Meta(
        val format: Int,
        val createdAt: Long,
        val appVersionName: String,
        val appVersionCode: Long,
        val dshVersion: String,
        val tag: String?,
        val stats: Map<String, Stat>,
    )

    /** 列表项：备份文件 + 解析出的元信息（解析失败时 meta 为 null）。 */
    data class Item(val file: File, val meta: Meta?)

    private val tsFmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    private val readFmt = SimpleDateFormat("MM-dd HH:mm", Locale.US)

    // ---------------- 路径 ----------------

    /**
     * 备份目录：优先共享下载目录（文件管理器可见、换机可直接拷走），
     * 不可写时回退应用私有 filesDir/backups（卸载会丢，但至少本机可恢复）。
     */
    fun backupDir(ctx: Context): File {
        val cands = linkedSetOf<File>()
        runCatching {
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                ?.let { cands += File(it, "DshLauncher/$DIR_NAME") }
        }
        cands += File("/sdcard/Download/DshLauncher/$DIR_NAME")
        for (c in cands) {
            val ok = runCatching { (c.isDirectory || c.mkdirs()) && c.canWrite() }.getOrDefault(false)
            if (ok) return c
        }
        return File(ctx.filesDir, "backups").apply { mkdirs() }
    }

    /** 该目录是否为共享存储（否 = 回退到私有区，UI 需提示用户）。 */
    fun isSharedDir(ctx: Context, dir: File = backupDir(ctx)): Boolean =
        !dir.absolutePath.startsWith(ctx.filesDir.absolutePath)

    // ---------------- 备份 ----------------

    /**
     * 扫描各分区规模（不打包），用于 UI 预估。后台线程调用。
     */
    fun scan(ctx: Context, opts: Options = Options()): Map<String, Stat> {
        val out = linkedMapOf<String, Stat>()
        if (opts.dshData) out["dsh"] = countDir(File(ctx.filesDir, ".dsh"))
        if (opts.plugins) out["plugins"] = countDir(File(ctx.filesDir, "plugins"))
        if (opts.launcherConfig) {
            var n = 0
            var b = 0L
            for (ns in PREF_NAMESPACES) {
                val f = prefsFile(ctx, ns)
                if (f.isFile) { n++; b += f.length() }
            }
            for (rel in LOOSE_FILES) {
                val f = File(ctx.filesDir, rel)
                if (f.isFile) { n++; b += f.length() }
            }
            out["launcher"] = Stat(n, b)
        }
        return out
    }

    /**
     * 创建一个备份包。
     * @param tag 可选标记（如 `pre-restore` 恢复前自动快照、`manual` 手动）
     * @return 成功返回 zip 文件；无内容可备份或 I/O 失败返回 null
     */
    fun create(
        ctx: Context,
        opts: Options = Options(),
        tag: String? = "manual",
        onProgress: (String) -> Unit = {},
    ): File? {
        if (!opts.any()) {
            onProgress("✗ 未勾选任何备份内容")
            return null
        }
        val dir = backupDir(ctx)
        val suffix = if (tag.isNullOrBlank()) "" else "-$tag"
        val out = uniqueFile(dir, "dsh-backup-${tsFmt.format(Date())}$suffix.zip")
        val stats = linkedMapOf<String, Stat>()
        var empty = false
        try {
            ZipOutputStream(out.outputStream().buffered()).use { zos ->
                if (opts.dshData) {
                    stats["dsh"] = addDir(zos, File(ctx.filesDir, ".dsh"), "dsh", onProgress)
                }
                if (opts.plugins) {
                    stats["plugins"] = addDir(zos, File(ctx.filesDir, "plugins"), "plugins", onProgress)
                }
                if (opts.launcherConfig) {
                    var n = 0
                    var b = 0L
                    for (ns in PREF_NAMESPACES) {
                        val json = dumpPrefs(ctx, ns)
                        if (json.length() == 0) continue
                        val bytes = json.toString(2).toByteArray()
                        zos.putNextEntry(ZipEntry("launcher/prefs/$ns.json"))
                        zos.write(bytes)
                        zos.closeEntry()
                        n++; b += bytes.size.toLong()
                    }
                    for (rel in LOOSE_FILES) {
                        val f = File(ctx.filesDir, rel)
                        if (!f.isFile) continue
                        zos.putNextEntry(ZipEntry("launcher/state/${f.name}"))
                        f.inputStream().use { it.copyTo(zos) }
                        zos.closeEntry()
                        n++; b += f.length()
                    }
                    stats["launcher"] = Stat(n, b)
                }
                if (stats.values.sumOf { it.files } == 0) {
                    // 不写 manifest：半成品 zip 会被 readMeta 判为无效包，不会被误当备份恢复
                    empty = true
                    return@use
                }
                val manifest = JSONObject().apply {
                    put("format", FORMAT)
                    put("createdAt", System.currentTimeMillis())
                    put("appVersionName", versionName(ctx))
                    put("appVersionCode", AssetSync.apkVersion(ctx))
                    put("dshVersion", DshUpdater.currentVersion(ctx))
                    if (!tag.isNullOrBlank()) put("tag", tag)
                    put("semantics", "merge-overwrite")
                    val es = JSONObject()
                    for ((k, v) in stats) {
                        es.put(k, JSONObject().put("files", v.files).put("bytes", v.bytes))
                    }
                    put("entries", es)
                }
                zos.putNextEntry(ZipEntry(MANIFEST))
                zos.write(manifest.toString(2).toByteArray())
                zos.closeEntry()
            }
        } catch (t: Throwable) {
            AppLog.e("Backup", "create failed: " + (t.message ?: t.toString()))
            onProgress("✗ 备份失败：${t.message}")
            runCatching { out.delete() }
            return null
        }
        if (empty) {
            onProgress("✗ 没有可备份的内容（对应目录为空）")
            runCatching { out.delete() }
            return null
        }
        for ((k, v) in stats) {
            if (v.files > 0) onProgress("✓ $k：${v.files} 个文件 / ${human(v.bytes)}")
        }
        onProgress("✓ 已保存到 ${out.absolutePath}（${human(out.length())}）")
        prune(ctx, KEEP_MAX, onProgress)
        return out
    }

    // ---------------- 列表 / 删除 / 元信息 ----------------

    /** 备份列表（按时间倒序：文件名里的时间戳即创建时间，新包在后）。 */
    fun list(ctx: Context): List<Item> {
        val dir = backupDir(ctx)
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".zip") } ?: return emptyList()
        return files.sortedByDescending { it.lastModified() }.map { Item(it, readMeta(it)) }
    }

    /** 读取备份包元信息；非 zip / 无 manifest 时返回 null。 */
    fun readMeta(zip: File): Meta? = runCatching {
        ZipFile(zip).use { zf ->
            val e = zf.getEntry(MANIFEST) ?: return null
            val o = JSONObject(zf.getInputStream(e).readBytes().toString(Charsets.UTF_8))
            val stats = linkedMapOf<String, Stat>()
            val es = o.optJSONObject("entries")
            if (es != null) {
                for (k in es.keys()) {
                    val s = es.getJSONObject(k)
                    stats[k] = Stat(s.optInt("files"), s.optLong("bytes"))
                }
            }
            Meta(
                format = o.optInt("format", 0),
                createdAt = o.optLong("createdAt", zip.lastModified()),
                appVersionName = o.optString("appVersionName", "?"),
                appVersionCode = o.optLong("appVersionCode", 0L),
                dshVersion = o.optString("dshVersion", "?"),
                tag = o.optString("tag").takeIf { it.isNotBlank() },
                stats = stats,
            )
        }
    }.onFailure {
        AppLog.e("Backup", "readMeta failed for ${zip.name}: " + (it.message ?: it.toString()))
    }.getOrNull()

    fun delete(item: Item): Boolean = runCatching { item.file.delete() }.getOrDefault(false)

    /** 保留最近 [keep] 份，其余删除。 */
    fun prune(ctx: Context, keep: Int = KEEP_MAX, onProgress: (String) -> Unit = {}) {
        val all = list(ctx)
        if (all.size <= keep) return
        for (old in all.drop(keep)) {
            if (delete(old)) onProgress("· 已清理旧备份 ${old.file.name}")
        }
    }

    // ---------------- 恢复 ----------------

    /**
     * 从备份包恢复（合并覆盖）。
     *
     * 调用方（[com.dsh.launcher.ui.BackupActivity]）负责先停 dsh 服务——
     * 在 web 运行期间覆写 .dsh/sessions 会让运行中的进程持有已失效状态。
     *
     * @return 是否成功（部分失败仍会继续，最后按是否有失败分区判定）
     */
    fun restore(ctx: Context, zip: File, onProgress: (String) -> Unit = {}): Boolean {
        if (!zip.isFile) {
            onProgress("✗ 备份文件不存在：${zip.absolutePath}")
            return false
        }
        val meta = readMeta(zip)
        if (meta == null) {
            onProgress("✗ 不是有效的备份包（缺少 manifest.json）：${zip.name}")
            return false
        }
        if (meta.format > FORMAT) {
            onProgress("✗ 备份包格式 v${meta.format} 高于当前支持的 v$FORMAT，请先升级应用")
            return false
        }
        onProgress(">> 恢复自 ${zip.name}（App v${meta.appVersionName} / dsh v${meta.dshVersion}）")
        var failed = false
        try {
            ZipFile(zip).use { zf ->
                val all = mutableListOf<ZipEntry>()
                val en = zf.entries()
                while (en.hasMoreElements()) all += en.nextElement()
                for ((archiveRoot, relPath) in ROOTS) {
                    val entries = all.filter { !it.isDirectory && it.name.startsWith("$archiveRoot/") }
                    if (entries.isEmpty()) continue
                    val target = File(ctx.filesDir, relPath)
                    var n = 0
                    for (e in entries) {
                        val rel = e.name.removePrefix("$archiveRoot/")
                        if (rel.isBlank() || !isSafeRel(rel)) continue
                        val dst = File(target, rel)
                        // 目标当前是符号链接（装配 junction）时先摘掉，避免写穿到 dsh-prefix
                        if (isSymlink(dst) && !dst.delete()) {
                            onProgress("  ! 跳过（无法摘除链接）：${dst.name}")
                            continue
                        }
                        if (dst.parentFile?.isDirectory != true) dst.parentFile?.mkdirs()
                        // 先写 .tmp 再 rename：写入中断时不会留下被截断的半截文件
                        val tmp = File(dst.parentFile, dst.name + ".dsh-restore-tmp")
                        runCatching {
                            zf.getInputStream(e).use { it.copyTo(tmp.outputStream()) }
                            dst.delete()
                            if (!tmp.renameTo(dst)) throw java.io.IOException("rename failed")
                            n++
                        }.onFailure {
                            onProgress("  ! 写入失败 $rel：${it.message}")
                            runCatching { tmp.delete() }
                            failed = true
                        }
                    }
                    onProgress("✓ $relPath 已恢复 $n 个文件（合并覆盖）")
                }
                // 启动器配置：prefs + 散文件
                val prefEntries = all.filter {
                    !it.isDirectory && it.name.startsWith("launcher/prefs/") && it.name.endsWith(".json")
                }
                var keys = 0
                for (e in prefEntries) {
                    val ns = e.name.substringAfterLast('/').removeSuffix(".json")
                    val json = runCatching {
                        JSONObject(zf.getInputStream(e).readBytes().toString(Charsets.UTF_8))
                    }.getOrNull() ?: continue
                    keys += applyPrefs(ctx, ns, json, onProgress)
                }
                if (prefEntries.isNotEmpty()) onProgress("✓ 启动器配置已恢复（$keys 个键，同名覆盖）")

                val stateEntries = all.filter { !it.isDirectory && it.name.startsWith("launcher/state/") }
                for (e in stateEntries) {
                    val name = e.name.substringAfterLast('/')
                    val dst = when (name) {
                        "markers.json" -> File(File(ctx.filesDir, "state"), name)
                        else -> File(ctx.filesDir, name)
                    }
                    runCatching {
                        dst.parentFile?.mkdirs()
                        zf.getInputStream(e).use { it.copyTo(dst.outputStream()) }
                        // markers.json 由 MarkerStore 进程内缓存持有：清缓存标记，
                        // 下次访问重新从盘加载，否则恢复的 marker 会被旧缓存覆盖
                        if (name == "markers.json") MarkerStore.invalidate()
                        onProgress("✓ 已恢复 ${dst.name}")
                    }.onFailure {
                        onProgress("  ! 写入失败 $name：${it.message}")
                        failed = true
                    }
                }
            }
        } catch (t: Throwable) {
            AppLog.e("Backup", "restore failed: " + (t.message ?: t.toString()))
            onProgress("✗ 恢复失败：${t.message}")
            return false
        }
        if (failed) onProgress("⚠ 恢复完成，但有部分文件写入失败（见上方 ! 行）")
        else onProgress("✓ 恢复完成。建议重启 dsh 让配置生效。")
        return !failed
    }

    // ---------------- 内部 ----------------

    private fun addDir(
        zos: ZipOutputStream,
        src: File,
        archiveRoot: String,
        onSkip: (String) -> Unit = {},
    ): Stat {
        if (!src.exists()) return Stat()
        var n = 0
        var b = 0L
        var skipped = 0
        src.walkTopDown()
            .onEnter { dir -> !isSymlink(dir) && dir.name !in SKIP_DIR_NAMES } // 不下钻依赖林/符号链接目录
            .forEach { f ->
                if (isSymlink(f) || !f.isFile) return@forEach
                val rel = f.relativeTo(src).path
                runCatching {
                    zos.putNextEntry(ZipEntry("$archiveRoot/$rel"))
                    f.inputStream().use { it.copyTo(zos) }
                    zos.closeEntry()
                    n++
                    b += f.length()
                }.onFailure {
                    AppLog.e("Backup", "skip $rel: " + (it.message ?: it.toString()))
                    skipped++
                    // 单个文件读不动（权限/坏块）不该拖垮整包：跳过并在最后如实告知
                    if (skipped <= 5) onSkip("  ! 跳过 $archiveRoot/$rel：${it.message}")
                }
            }
        if (skipped > 5) onSkip("  ! 另有 ${skipped - 5} 个文件跳过（详见日志）")
        return Stat(n, b)
    }

    private fun countDir(src: File): Stat {
        if (!src.exists()) return Stat()
        var n = 0
        var b = 0L
        runCatching {
            src.walkTopDown()
                .onEnter { dir -> !isSymlink(dir) && dir.name !in SKIP_DIR_NAMES }
                .forEach { f ->
                    if (isSymlink(f) || !f.isFile) return@forEach
                    n++
                    b += f.length()
                }
        }
        return Stat(n, b)
    }

    /** 同名文件已存在时追加序号（同一秒内多次备份不会互相覆盖）。 */
    private fun uniqueFile(dir: File, name: String): File {
        val base = name.removeSuffix(".zip")
        var f = File(dir, name)
        var i = 1
        while (f.exists() && i < 100) {
            f = File(dir, "$base-$i.zip")
            i++
        }
        return f
    }

    /**
     * 符号链接判定（API 24 起无 java.nio.file.Files）。
     *
     * 用「自身 fully-resolved 路径」对比「父目录 resolved 路径 + 文件名」：
     * 二者只在【叶子本身是链接】时才不等；父目录即使位于链接路径下
     * （部分 ROM 的 /data/user/0 → /data/data）也不会把普通文件误判为链接。
     * 若文件尚不存在（恢复前探活），canonicalPath 只会解析父目录 → 判为非链接。
     */
    private fun isSymlink(f: File): Boolean = runCatching {
        val parent = f.parentFile ?: return@runCatching false
        f.canonicalPath != File(parent.canonicalPath, f.name).path
    }.getOrDefault(false)

    /**
     * 归档内相对路径白名单校验（zip-slip / 绝对路径防护）。
     * 备份包可能被手工改过或来自他人，恢复前必须确认落点仍在目标目录内。
     */
    private fun isSafeRel(rel: String): Boolean {
        if (rel.startsWith("/") || rel.contains("\\")) return false
        return rel.split('/').none { it == ".." }
    }

    private fun dumpPrefs(ctx: Context, ns: String): JSONObject {
        val all = runCatching { ctx.getSharedPreferences(ns, Context.MODE_PRIVATE).all }
            .getOrDefault(emptyMap())
        val out = JSONObject()
        for ((k, v) in all) {
            val e = JSONObject()
            when (v) {
                is Boolean -> e.put("t", "b").put("v", v)
                is Int -> e.put("t", "i").put("v", v)
                is Long -> e.put("t", "l").put("v", v)
                is Float -> e.put("t", "f").put("v", v.toDouble())
                is String -> e.put("t", "s").put("v", v)
                is Set<*> -> e.put("t", "S").put("v", org.json.JSONArray(v.map { it.toString() }))
                else -> null
            } ?: continue
            out.put(k, e)
        }
        return out
    }

    /** 把备份的键值写回 SharedPreferences（同步 commit，恢复后立即可见）。返回键数。 */
    private fun applyPrefs(
        ctx: Context,
        ns: String,
        json: JSONObject,
        onProgress: (String) -> Unit,
    ): Int {
        val ed = ctx.getSharedPreferences(ns, Context.MODE_PRIVATE).edit()
        var n = 0
        for (k in json.keys()) {
            val e = json.optJSONObject(k) ?: continue
            try {
                when (e.optString("t")) {
                    "b" -> ed.putBoolean(k, e.getBoolean("v"))
                    "i" -> ed.putInt(k, e.getInt("v"))
                    "l" -> ed.putLong(k, e.getLong("v"))
                    "f" -> ed.putFloat(k, e.getDouble("v").toFloat())
                    "s" -> ed.putString(k, e.getString("v"))
                    "S" -> {
                        val arr = e.getJSONArray("v")
                        val set = LinkedHashSet<String>()
                        for (i in 0 until arr.length()) set += arr.optString(i)
                        ed.putStringSet(k, set)
                    }
                    else -> continue
                }
                n++
            } catch (t: Throwable) {
                onProgress("  ! 配置项 $ns/$k 恢复失败：${t.message}")
            }
        }
        return if (runCatching { ed.commit() }.getOrDefault(false)) n else 0
    }

    private fun prefsFile(ctx: Context, ns: String): File {
        // SharedPreferences 实际落盘位置（实现细节，仅用于体积预估；不可靠时按 0 计）
        val base = ctx.applicationInfo.dataDir
        return File("$base/shared_prefs/$ns.xml")
    }

    private fun versionName(ctx: Context): String = runCatching {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"
    }.getOrDefault("?")

    /** 字节数人类可读化。 */
    fun human(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val kb = bytes / 1024.0
        if (kb < 1024) return "%.1f KB".format(kb)
        val mb = kb / 1024.0
        return if (mb < 1024) "%.1f MB".format(mb) else "%.2f GB".format(mb / 1024.0)
    }

    /** 时间戳人类可读化（MM-dd HH:mm）。 */
    fun humanTime(ms: Long): String = runCatching { readFmt.format(Date(ms)) }.getOrDefault("?")
}
