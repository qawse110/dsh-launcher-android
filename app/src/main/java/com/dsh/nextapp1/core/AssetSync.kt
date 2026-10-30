package com.dsh.nextapp1.core

import android.content.Context
import android.os.Build
import java.io.File
import java.io.InputStream
import org.apache.commons.compress.archivers.zip.ZipFile
import org.json.JSONObject
import com.dsh.nextapp1.core.*
import com.dsh.nextapp1.overlay.*
import com.dsh.nextapp1.service.*
import com.dsh.nextapp1.tts.*
import com.dsh.nextapp1.ui.*
import com.dsh.nextapp1.R

/**
 * APK 内置资产同步统一工具。
 *
 * 背景：extra-plugins/ 等资产在「一键安装 / 重新装配」路径上被反复从
 * assets 拷贝到 files，设备端 flash IO 较慢，冗余拷贝拖慢安装。
 *
 * 规则：assets 只随 APK 版本变化。把「当前 APK 版本已同步过」写入 marker 文件，
 * 后续触发安装/装配时先看 marker 与目标文件是否都存在，避免重复拷贝。
 */
object AssetSync {

    fun apkVersion(context: Context): Long = try {
        if (Build.VERSION.SDK_INT >= 28) {
            context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).versionCode.toLong()
        }
    } catch (t: Throwable) {
        AppLog.e("AssetSync", "getPackageInfo failed: " + (t.message ?: t.toString()))
        0L
    }

    /**
     * APK 安装戳：`<sourceDir>|<长度>|<mtime>`。
     *
     * **为什么不能用 versionCode 当「APK 是否变了」的判据**：本仓 versionCode 是硬编码
     * 常量（`versionCode = 300`），每次出包都相同 → 任何以它为判据的「升级检测」在
     * 首次安装后**永不成立**，是死代码（旧版 `syncAssetsOnApkUpdate` 的 `current == last`
     * 即因此直接 return，装了新 APK 也不同步资产 —— 真机实证：新 APK 里的插件修复
     * 到不了 devices 上的 files/）。
     *
     * 重装/覆盖安装会替换 APK 文件本身，其**长度或 mtime 必然变化**，故取二者与路径
     * 组成戳即可真实反映「本次安装的包换过了」。取不到时返回空串，调用方应视为
     * 「未知」并**按需要重新同步**（fail-open 到「做事」，而不是 fail-closed 到「跳过」）。
     */
    fun apkInstallStamp(context: Context): String = try {
        val src = File(context.applicationInfo.sourceDir)
        if (!src.isFile) "" else "${src.absolutePath}|${src.length()}|${src.lastModified()}"
    } catch (t: Throwable) {
        AppLog.e("AssetSync", "apkInstallStamp failed: " + (t.message ?: t.toString()))
        ""
    }

    /**
     * 打开 assets 条目，**带 APK 直读兜底**。
     *
     * 为什么需要兜底：release 构建时 AGP 会把 baseline-profile 的
     * `assets/dexopt/baseline.prof(.m)` 插在 APK 的 assets 列表**最前**，
     * 而 AssetManager 对 assets 做字典序二分查找——该逆序使部分条目
     * （实测为 prebuilt.tgz / termux-bootstrap.zip）用 [Context.assets.open] 读不到，
     * 抛 `FileNotFoundException(资产名)`；小文件反而正常，极具迷惑性。
     *
     * 兜底路径：直接用 commons-compress 的 [ZipFile] 打开**应用自身 APK**
     * （`applicationInfo.sourceDir`，应用进程可读），按 zip 条目名取出内容。
     * 这条路不经过 AssetManager 的索引，对任意资产通用，也不依赖排序。
     *
     * @return 可用的输入流（调用方负责 close）；两级都失败则抛出原始异常。
     */
    fun openAsset(context: Context, assetName: String): InputStream {
        var primary: Throwable? = null
        try {
            return context.assets.open(assetName)
        } catch (t: Throwable) {
            primary = t
        }
        try {
            val apk = File(context.applicationInfo.sourceDir)
            if (!apk.isFile) throw primary
            ZipFile(apk).use { zip ->
                val entry = zip.getEntry("assets/$assetName")
                    ?: zip.getEntry(assetName)
                    ?: throw primary
                // 一次性读出（此处资产均 ≤ ~35MB，流式接口由调用方 close 的约束
                // 会让 ZipFile 提前关闭底层 fd，故先物化到内存）
                return zip.getInputStream(entry).use { it.readBytes() }.inputStream()
            }
        } catch (t: Throwable) {
            AppLog.e(
                "AssetSync",
                "openAsset fallback failed for $assetName: ${t.message}（primary=${primary.message}）"
            )
            throw primary
        }
    }

    // 已删除（无用代码清理）：readAssetBytes 字节变体——注释称「供调用点复用」，
    // 但全仓无任何调用点（各消费方直接 openAsset(...).use { ... }）。

    /**
     * marker 值为 `apk:<安装戳>#<目标内容指纹>`，且目标存在时视为已同步。
     *
     * **判据必须是「安装戳」而非 versionCode**：旧实现用 `apk:<versionCode>` 当签名，
     * 而本仓 versionCode 硬编码为 300，每次出包都相同 → 装了新 APK 后签名**依旧匹配**，
     * 于是「已同步」被永久短路，新 APK 里的资产（含内置插件修复）永远到不了 files/
     * （真机实证：修好的 codebuddy 插件在设备上仍是旧文件）。详见 [apkInstallStamp]。
     *
     * 双重判据缺一不可：
     *  - 安装戳：识别「APK 换过了」（versionCode 做不到）；
     *  - 目标指纹：识别「目标被改坏/只拷了一半」以及 marker 落盘后目标被外部改动。
     * 注意目标指纹是**目标自身**的，只能发现目标侧变化；APK 侧的更新靠安装戳发现。
     */
    fun isSynced(ctx: Context, key: String, target: File, apkStamp: String): Boolean {
        if (apkStamp.isEmpty() || !target.exists()) return false
        val marker = MarkerStore.get(ctx, key) ?: return false
        if (!marker.startsWith("apk:$apkStamp#")) return false
        // 兼容旧格式 marker（无 #）与旧判据（apk:<versionCode>）：视为未同步，
        // 本次拷贝后升级为新格式。
        val fp = fingerprintOf(target)
        return marker == "apk:$apkStamp#$fp"
    }

    // 已删除（无用代码清理）：markSynced（不带指纹的旧版）——全仓无调用点。
    // 它写出的 `apk:<stamp>` 无 `#`，会被 isSynced 判为「未同步」（见上方注释的旧格式兼容），
    // 即写进去也无效；现行唯一写法是下面的 markSyncedWithFingerprint。

    /** 携带目标内容指纹写入 marker（isSynced 校验用）。 */
    fun markSyncedWithFingerprint(ctx: Context, key: String, target: File, apkStamp: String) {
        MarkerStore.put(ctx, key, "apk:$apkStamp#${fingerprintOf(target)}")
    }

    /**
     * 把内置插件源（`extraSrc` = files/extra-plugins/<dir>）刷新到**已装配的插件副本**
     * （`pluginsDir` = files/plugins/<dir>）。
     *
     * **为什么需要这一步**：profile 里登记的是 `link:.../files/plugins/<dir>`，
     * dsh 直接从该目录加载插件代码，因此**换掉目录内容即生效**，无需重跑 `dsh plugin add`。
     * 但旧升级路径只同步了 files/extra-plugins（源），没刷新 files/plugins（装配副本），
     * 而「快速启动」又会跳过插件装配 → 结果正是「装了含插件修复的新 APK，运行时仍是旧代码、
     * 报同样的错」。语义与 install-dsh.mjs 的 syncExtraPlugin 一致（整目录替换），
     * 差别是不碰 profile 登记（登记已存在，且那步需要起 CLI）。
     *
     * @param onlyExisting 只刷新「目标已存在」的插件，避免把从未装配过的插件硬塞进
     *   plugins/（装配与否仍由 dsh plugin add 决定）。
     * @return 实际刷新的插件个数。
     */
    fun refreshBundledPluginCopies(extraSrc: File, pluginsDir: File, onlyExisting: Boolean = true): Int {
        if (!extraSrc.isDirectory) return 0
        val dirs = extraSrc.listFiles()?.filter { it.isDirectory } ?: return 0
        var n = 0
        for (src in dirs) {
            if (!File(src, "package.json").isFile) continue
            val dst = File(pluginsDir, src.name)
            val dstHasPkg = File(dst, "package.json").isFile
            if (onlyExisting && !dstHasPkg) continue
            try {
                // 内容一致则跳过，避免每次启动无谓重写大量文件
                if (dstHasPkg && fingerprintOf(dst) == fingerprintOf(src)) continue
                // 不降级守卫：plugins/<dir> 可能已被「在线升级」换成比 assets 更新的上游版本，
                // 此时用出厂源整个覆盖等于把用户的在线升级静默回滚（且备份仍在，行为极难解释）。
                // 语义与 install/plugins.mjs 的 syncExtraPlugin 严格对齐：
                //   · 任一侧版本号取不到（缺 version / 自由文本）→ fail-open，照旧覆盖
                //     （既有 MarkerStoreTest 的夹具 package.json 只有 name 无 version，依赖这条）
                //   · 本地 > 源 → 跳过刷新，且**不写任何 marker**（假账会让下一次启动起静默）
                if (dstHasPkg && isNewerThanSource(dst, src)) {
                    AppLog.i(
                        "AssetSync",
                        "refresh plugin copy ${src.name} skip downgrade: " +
                            "keep ${pkgVersionOf(dst)} (> asset ${pkgVersionOf(src)})"
                    )
                    continue
                }
                dst.deleteRecursively()
                dst.parentFile?.mkdirs()
                src.copyRecursively(dst, overwrite = true)
                n++
            } catch (t: Throwable) {
                AppLog.e("AssetSync", "refresh plugin copy ${src.name} failed: ${t.message}")
            }
        }
        return n
    }

    /**
     * 读某个插件目录 package.json 里的 version。缺失 / 解析失败 / version 非字符串 → null。
     *
     * 供「不降级守卫」做版本取证，因此刻意比 PluginManagerActivity.readVersion 宽松：
     * 那里对界面显示返回 "?"，这里对 null 有语义（null = 无法比较 = fail-open）。
     * 装配侧的「修复/恢复」也用同一判据（见 repairFromSource），保证两处语义同源。
     */
    fun pkgVersionOf(dir: File): String? = try {
        val text = File(dir, "package.json").readText()
        val v = JSONObject(text).opt("version")
        if (v is String && v.isNotBlank()) v.trim() else null
    } catch (t: Throwable) {
        null
    }

    /**
     * 复刻 install/plugins.mjs 的 compareVersion（数点分段逐段数值比较）。
     *
     * 为什么不用 DshUpdater.compareVersions：那个函数永不返回 null，
     * 而这里必须区分「0 = 同版本」与「null = 无法比较」，否则缺 version 的插件会被误判成
     * 「同版本」而走另一条分支。同时它与 JS 侧同源，避免两端判据漂移。
     *
     * public 是因为装配侧的 repairFromSource 也要用同一套判据（在线升级过的新版本
     * 不得被「修复」按钮按出厂源覆盖），两处必须逐字同源。
     *
     * @return a 更新 → 1；a 更旧 → -1；同核心版本 → 0；任一侧取不到数字段 → null。
     */
    fun compareVersionNums(a: String?, b: String?): Int? {
        val x = parseVersionNums(a) ?: return null
        val y = parseVersionNums(b) ?: return null
        val n = maxOf(x.size, y.size)
        for (i in 0 until n) {
            val p = if (i < x.size) x[i] else 0
            val q = if (i < y.size) y[i] else 0
            if (p != q) return if (p > q) 1 else -1
        }
        return 0
    }

    /**
     * 本地副本是否**比源目录更新**（两侧都有 package.json、版本都可解析且 local > source）。
     *
     * 这是「在线升级」与「按源修复」之间的分界线，装配侧有三处都要用它：
     *   · [refreshBundledPluginCopies] 的不降级守卫；
     *   · PluginManagerActivity.isAheadOfSource（界面要显示「已在线升级」而不是「落后」）；
     *   · PluginManagerActivity.repairFromSource（「修复」按钮不得按出厂源覆盖升级结果）。
     * 抽在这里是为了让三处逐字同源 —— 判据一旦分叉，界面说「已是最新」而修复又降级，
     * 就是最难排查的那类问题。
     *
     * 语义与 install/plugins.mjs 的 syncExtraPlugin 一致：任一侧版本不可解析 → false。
     */
    fun isNewerThanSource(localDir: File, sourceDir: File): Boolean {
        if (!File(localDir, "package.json").isFile) return false
        if (!File(sourceDir, "package.json").isFile) return false
        val order = compareVersionNums(pkgVersionOf(localDir), pkgVersionOf(sourceDir))
        return order != null && order > 0
    }

    /** 取「首个数字点分段」，与 plugins.mjs 的 parseVersionNum 同正则同语义。 */
    private fun parseVersionNums(v: String?): List<Int>? {
        if (v.isNullOrBlank()) return null
        val m = VERSION_NUM_RE.find(v) ?: return null
        return m.groupValues[1].split('.').map { it.toIntOrNull() ?: 0 }
    }

    private val VERSION_NUM_RE = Regex("(\\d+(?:\\.\\d+)*)")

    /**
     * 公开的单文件指纹（长度 + 头 64KB CRC32），供「脚本内容变了就该重跑」类判据使用
     * （如 stub-dsh.mjs 补丁载荷的幂等 marker）。文件不存在返回 "absent"。
     */
    fun fileFingerprint(file: File): String =
        if (!file.isFile) "absent" else fingerprintOf(file)

    /**
     * 两个目录内容是否一致（同套指纹）。
     *
     * 用于识别「旧版本但结构完好」的插件副本：只校验 package.json 可解析会把它判成
     * 健康，而运行时加载的正是该副本 → 装了新 APK 却仍跑旧代码且毫无提示（真机事故）。
     * 任一目录不存在时返回 false（视为不一致），由调用方决定是否告警。
     */
    fun dirContentEquals(a: File, b: File): Boolean {
        if (!a.isDirectory || !b.isDirectory) return false
        return fingerprintOf(a) == fingerprintOf(b)
    }

    /**
     * 轻量内容指纹：文件 = 长度 + 头 64KB CRC32；目录 = 递归各文件（长度+CRC）的聚合 CRC。
     * 预算：extra-plugins 目录数百个小文件全读但都是文本，
     * 总量 MB 级，冷缓存下 ~百毫秒，仅资产拷贝判定路径调用（非每帧）。
     */
    private fun fingerprintOf(target: File): String = try {
        val crc = java.util.zip.CRC32()
        if (target.isDirectory) {
            target.walkTopDown().filter { it.isFile }.sortedBy { it.relativeTo(target).path }
                .forEach { f ->
                    val rel = f.relativeTo(target).path
                    crc.update(rel.toByteArray())
                    updateCrcWithHead(crc, f)
                }
        } else {
            updateCrcWithHead(crc, target)
        }
        java.lang.Long.toHexString(crc.value)
    } catch (t: Throwable) {
        "err"
    }

    private fun updateCrcWithHead(crc: java.util.zip.CRC32, f: File) {
        crc.update(f.length().toString().toByteArray())
        if (f.length() <= 0L) return
        java.io.FileInputStream(f).use { input ->
            val buf = ByteArray(64 * 1024)
            val n = input.read(buf)
            if (n > 0) crc.update(buf, 0, n)
        }
    }

    fun copyAsset(context: Context, assetName: String, dest: File): Boolean = try {
        openAsset(context, assetName).use { input ->
            dest.parentFile?.mkdirs()
            dest.outputStream().use { output -> input.copyTo(output) }
        }
        true
    } catch (t: Throwable) {
        AppLog.e("AssetSync", "copyAsset $assetName -> ${dest.absolutePath} failed: ${t.message}")
        false
    }

    /** 递归复制 assets 目录到 files；返回 false 表示 assetPath 不存在。 */
    fun copyAssetDir(context: Context, assetPath: String, dest: File, clearFirst: Boolean): Boolean {
        if (context.assets.list(assetPath) == null) return false
        if (clearFirst) {
            runCatching { dest.deleteRecursively() }
        }
        copyDirRecursive(context, assetPath, dest)
        return true
    }

    /**
     * 目录判定：AssetManager.list() 对「文件」返回的是空数组（非 null）！
     * 曾经用 `!= null` 判断导致所有文件被当成目录、只建空壳不拷内容，
     * dsh-status-bridge 插件因此变成空壳、悬浮窗链路整体失效。
     */
    private fun isAssetDir(context: Context, assetPath: String): Boolean =
        try {
            context.assets.list(assetPath)?.isNotEmpty() == true
        } catch (_: Throwable) {
            false
        }

    /**
     * 整目录同步并返回拷贝的文件数（目录本身不计；assets 里无该目录时返回 0）。
     *
     * 与 [copyAssetDir] 的区别：那个只回 boolean。调用方常需「拷了几个文件」来判断
     * assets 是否真的为空（空目录与不存在都会给 false，日志里无从区分）。
     */
    fun copyDirRecursiveCount(context: Context, assetPath: String, dest: File): Int {
        if (context.assets.list(assetPath) == null) return 0
        return copyDirRecursive(context, assetPath, dest)
    }

    /** 返回成功拷贝的文件数（目录本身不计）。 */
    private fun copyDirRecursive(context: Context, assetPath: String, dest: File): Int {
        val children = context.assets.list(assetPath) ?: return 0
        dest.mkdirs()
        var copied = 0
        for (name in children) {
            val childAsset = "$assetPath/$name"
            val childDest = File(dest, name)
            copied += if (isAssetDir(context, childAsset)) {
                copyDirRecursive(context, childAsset, childDest)
            } else {
                try {
                    childDest.parentFile?.mkdirs()
                    openAsset(context, childAsset).use { input ->
                        childDest.outputStream().use { output -> input.copyTo(output) }
                    }
                    1
                } catch (t: Throwable) {
                    // assets 里的空目录会走到这里（open 失败）：静默跳过
                    AppLog.i("AssetSync", "copy $childAsset failed: ${t.message}")
                    0
                }
            }
        }
        return copied
    }
}