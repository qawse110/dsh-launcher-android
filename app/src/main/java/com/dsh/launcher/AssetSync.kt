package com.dsh.launcher

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

    /** marker 内容为 "apk:<version>"，且目标文件/目录存在时视为已同步。 */
    fun isSynced(marker: File, target: File, apkVersion: Long): Boolean {
        if (apkVersion <= 0L || !target.exists()) return false
        return runCatching { marker.readText().trim() == "apk:$apkVersion" }.getOrDefault(false)
    }

    fun markSynced(marker: File, apkVersion: Long) {
        runCatching {
            marker.parentFile?.mkdirs()
            marker.writeText("apk:$apkVersion\n")
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

    private fun copyDirRecursive(context: Context, assetPath: String, dest: File) {
        val children = context.assets.list(assetPath) ?: return
        dest.mkdirs()
        for (name in children) {
            val childAsset = "$assetPath/$name"
            val childDest = File(dest, name)
            if (context.assets.list(childAsset) != null) {
                copyDirRecursive(context, childAsset, childDest)
            } else {
                childDest.parentFile?.mkdirs()
                context.assets.open(childAsset).use { input ->
                    childDest.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }
}