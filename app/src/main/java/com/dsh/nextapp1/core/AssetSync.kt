package com.dsh.nextapp1.core

import android.content.Context
import android.os.Build
import java.io.File
import com.dsh.nextapp1.core.*
import com.dsh.nextapp1.overlay.*
import com.dsh.nextapp1.service.*
import com.dsh.nextapp1.tts.*
import com.dsh.nextapp1.ui.*
import com.dsh.nextapp1.R

/**
 * APK 内置资产同步统一工具。
 *
 * 背景：prebuilt.tgz（约 30MB）等资产在「一键安装 / 重新装配」路径上被反复从
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

    fun markSynced(ctx: Context, key: String, apkStamp: String) {
        MarkerStore.put(ctx, key, "apk:$apkStamp")
    }

    /** 携带目标内容指纹写入 marker（isSynced 校验用）。 */
    fun markSyncedWithFingerprint(ctx: Context, key: String, target: File, apkStamp: String) {
        MarkerStore.put(ctx, key, "apk:$apkStamp#${fingerprintOf(target)}")
    }

    /**
     * 公开的单文件指纹（长度 + 头 64KB CRC32），供「脚本内容变了就该重跑」类判据使用
     * （如 stub-dsh.mjs 补丁载荷的幂等 marker）。文件不存在返回 "absent"。
     */
    fun fileFingerprint(file: File): String =
        if (!file.isFile) "absent" else fingerprintOf(file)

    /**
     * 轻量内容指纹：文件 = 长度 + 头 64KB CRC32；目录 = 递归各文件（长度+CRC）的聚合 CRC。
     * 预算：prebuilt.tgz ~30MB 只读头 64KB；extra-plugins 目录数百个小文件全读但都是文本，
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
        context.assets.open(assetName).use { input ->
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
                    context.assets.open(childAsset).use { input ->
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