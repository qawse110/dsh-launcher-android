package com.dsh.launcher.core

import android.content.Context
import android.os.Build
import java.io.File
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

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

    /** marker（MarkerStore 键）值为 "apk:<version>"，且目标文件/目录存在时视为已同步。 */
    fun isSynced(ctx: Context, key: String, target: File, apkVersion: Long): Boolean {
        if (apkVersion <= 0L || !target.exists()) return false
        return MarkerStore.get(ctx, key) == "apk:$apkVersion"
    }

    fun markSynced(ctx: Context, key: String, apkVersion: Long) {
        MarkerStore.put(ctx, key, "apk:$apkVersion")
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