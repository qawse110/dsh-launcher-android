package com.dsh.launcher.core

import java.io.File
import java.nio.file.Files

/**
 * 前缀 patcher：把官方 Termux 硬编码路径改写到搬迁后的真实位置。
 *
 * - 二进制（ELF/so）：[patchAll] 等长字节替换为短前缀 `…/t`（经符号链接等价）；
 * - 文本脚本/配置：[patchTextOfficialDirs] 替换为镜像长路径（可安全变长）。
 *
 * 架构方案 P1-3：由 [TermuxRuntime] 门面与 [BootstrapInstaller]/[PackageKit] 调用。
 */
internal object PrefixPatcher {

    /** 官方二进制硬编码的 Termux 前缀（长度 31）。 */
    const val OFFICIAL_PREFIX = "/data/data/com.termux/files/usr"

    /** 等长替换用的短前缀，通过 dataDir/t -> files/termux/usr 符号链接映射。 */
    const val SHORT_PREFIX = "/data/user/0/com.dsh.launcher/t"

    /**
     * 扫描整个 PREFIX，把所有普通文件中的官方硬编码路径等长替换为短前缀。
     * 覆盖 ELF 二进制、动态库、shell 脚本、pkgconfig、dpkg 清单等，
     * 使 apt/dpkg/bash 等全部通过 `t` 符号链接访问真实目录。
     */
    fun patchAll(usr: File, minLastModifiedMs: Long = 0L) {
        val since = if (minLastModifiedMs > 0L) " (incremental, mtime>=$minLastModifiedMs)" else ""
        val old = OFFICIAL_PREFIX
        val new = SHORT_PREFIX
        if (old.length != new.length) {
            android.util.Log.e("PrefixPatcher", "prefix patch length mismatch: ${old.length} != ${new.length}")
            return
        }
        var patched = 0
        var skipped = 0
        usr.walkTopDown().forEach { f ->
            if (!f.isFile || Files.isSymbolicLink(f.toPath())) return@forEach
            // P2-5 增量化：只处理基线时间之后新增/变动的文件，避免安装大包后全树逐字节重扫
            if (minLastModifiedMs > 0L && f.lastModified() < minLastModifiedMs) { skipped++; return@forEach }
            try {
                val bytes = Files.readAllBytes(f.toPath())
                // Latin-1 保证字节级无损，且 old/new 同长，替换后所有其它字节不变
                val text = String(bytes, Charsets.ISO_8859_1)
                if (text.contains(old)) {
                    Files.write(f.toPath(), text.replace(old, new).toByteArray(Charsets.ISO_8859_1))
                    patched++
                }
            } catch (_: Throwable) {
                // 单个文件失败不影响整体（例如权限/占用）
            }
        }
        android.util.Log.i("PrefixPatcher", "prefix patched files=$patched skipped=$skipped$since")
    }

    /**
     * 文本脚本/配置中可能还带官方 files 根路径（如 `/data/data/com.termux/files/home`）。
     * 二进制只能等长替换，已由 [patchAll] 处理；文本文件可以安全地用镜像长路径替换，
     * 让 profile.d 等脚本通过 dataDir 下的 `data/data/com.termux/files` 符号链接落到真实目录。
     * 只处理不含 NUL 的普通文本文件，避免破坏 ELF/其他二进制。
     */
    fun patchTextOfficialDirs(usr: File, minLastModifiedMs: Long = 0L) {
        try {
            val dataDir = usr.parentFile?.parentFile?.parentFile?.absolutePath
                ?: throw IllegalStateException("invalid usr path: $usr")
            val oldFiles = "/data/data/com.termux/files"
            val mirFiles = "$dataDir/data/data/com.termux/files"
            val oldAptCache = "/data/data/com.termux/cache/apt"
            val newAptCache = "${usr.absolutePath}/var/cache/apt"
            // oldFiles 恰好是 mirFiles 的后缀，直接 replace 会二次替换导致路径损坏；
            // 用一次性 token 把已 patch 好的路径保护起来，保证幂等。
            val token = "@@DSH_MIRROR_FILES@@"
            var patched = 0
            usr.walkTopDown().forEach { f ->
                if (!f.isFile || Files.isSymbolicLink(f.toPath())) return@forEach
                if (minLastModifiedMs > 0L && f.lastModified() < minLastModifiedMs) return@forEach
                try {
                    val bytes = Files.readAllBytes(f.toPath())
                    if (bytes.any { it == 0.toByte() }) return@forEach
                    var text = String(bytes, Charsets.ISO_8859_1)
                    var changed = false
                    if (text.contains(mirFiles)) {
                        text = text.replace(mirFiles, token).replace(oldFiles, mirFiles).replace(token, mirFiles)
                        changed = true
                    } else if (text.contains(oldFiles)) {
                        text = text.replace(oldFiles, mirFiles)
                        changed = true
                    }
                    if (text.contains(oldAptCache)) {
                        text = text.replace(oldAptCache, newAptCache)
                        changed = true
                    }
                    if (changed) {
                        Files.write(f.toPath(), text.toByteArray(Charsets.ISO_8859_1))
                        patched++
                    }
                } catch (_: Throwable) {
                }
            }
            android.util.Log.i("PrefixPatcher", "patched $patched text files for official paths")
        } catch (t: Throwable) {
            android.util.Log.w("PrefixPatcher", "patchTextOfficialDirs failed: ${t.message}")
        }
    }
}
