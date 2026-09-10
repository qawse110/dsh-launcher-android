package com.dsh.launcher.core

import android.content.Context
import android.os.Build
import java.io.File

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
     * **APK 是否被替换过**的判据（review-r12）。
     *
     * ## 为什么不能用 versionCode
     *
     * 本仓 `versionCode` 是**硬编码常量**（`app/build.gradle.kts` 的 `300`，注释写明
     * 「300 > 历史所有包…保证任何情况下可直接覆盖安装」），正常迭代**从不递增**。
     * 旧实现以 `versionCode` 为「APK 已升级」的判据：
     * ```
     * val last = prefs.getLong("last_apk_version", 0L)
     * if (current == last) return          // current 恒为 300，last 首次即为 300
     * ```
     * → 首次安装之后该函数**永久早退**，「APK 升级后自动同步内置资产」成了死代码。
     * 真机实证：`files/install-dsh.mjs` 比 APK 内的小 92 字节，设备上跑的是旧脚本。
     *
     * ## 判据选择
     *
     * 「APK 被替换」= 已安装 APK 文件本身变了，故直接取该文件的
     * **路径 + 长度 + mtime**。覆盖安装必然重写该文件，三者之一几乎必然变化；
     * 且这是 `stat` 级开销，不读 APK 内容。
     *
     * 注意：**每个资产的最终判据仍由 [isSynced] 的内容指纹负责**（见其 KDoc）——
     * 本函数只是「要不要跑同步」的廉价闸门，即使它误判为「没变」，
     * 资产级指纹也会在真正拷贝判定时补上；反之误判为「变了」只是多跑一次幂等同步。
     */
    fun apkInstallStamp(context: Context, versionCode: Long): String = try {
        val src = context.packageManager
            .getApplicationInfo(context.packageName, 0).sourceDir
        val f = File(src)
        "apk:$versionCode:${f.length()}:${f.lastModified()}"
    } catch (t: Throwable) {
        // 取不到 APK 元信息：返回带时间戳的一次性值 → 本次视为「已变更」，倾向同步
        AppLog.e("AssetSync", "apkInstallStamp failed: " + (t.message ?: t.toString()))
        "apk:$versionCode:unknown:${System.currentTimeMillis()}"
    }

    /** marker（MarkerStore 键）值为 "apk:<version>#<fingerprint>"，且目标文件/目录存在时视为已同步。 */
    fun isSynced(ctx: Context, key: String, target: File, apkVersion: Long): Boolean {
        if (apkVersion <= 0L || !target.exists()) return false
        val marker = MarkerStore.get(ctx, key) ?: return false
        if (!marker.startsWith("apk:$apkVersion#")) return false
        // 内容指纹：versionCode 相同（本地 debug 重建）但资产变了 → 签名不匹配 → 重新拷贝。
        // 兼容旧格式 marker（无 #）：视为未同步，本次拷贝后升级为新格式。
        val fp = fingerprintOf(target)
        return marker == "apk:$apkVersion#$fp"
    }

    /** 携带目标内容指纹写入 marker（isSynced 校验用）。 */
    fun markSyncedWithFingerprint(ctx: Context, key: String, target: File, apkVersion: Long) {
        MarkerStore.put(ctx, key, "apk:$apkVersion#${fingerprintOf(target)}")
    }

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