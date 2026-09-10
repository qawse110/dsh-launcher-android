package com.dsh.launcher.core

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.BasicFileAttributes

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
     * 文件是否应参与本次（增量）patch。
     *
     * **mtime 不能单独作判据**——真机 P1 缺陷（2026-09-10）：`dpkg-deb -x` / tar
     * 解包会**保留包内的归档 mtime**（实测 git 是 7 月、wget 是去年 8 月），
     * 而基线取的是「安装窗口开始时刻」（9 月）。于是新装文件的 mtime **全都早于基线**
     * → 全被跳过。实测 `bin`+`lib` 共 483 个文件**全部被跳过、0 个被处理**，
     * 其中 12 个（git/rg/wget/file/git-lfs/scalar/libuuid.so/libexpat.so/pkgconfig 等）
     * 至今仍带着官方硬编码前缀 `/data/data/com.termux/files/usr`——
     * 增量 patch 对它唯一的目标完全失效。
     *
     * **修复判据 = ctime OR mtime**。`ctime`（inode 状态变更时间）由内核在文件
     * **落盘那一刻**写入，归档无法伪造；实测那 12 个文件的 ctime 全部 > 基线。
     *
     * **为何取「或」而不是只用 ctime**：Android 上 `creationTime()` 的底层语义
     * （statx birthtime 或回落 st_ctime）无法在本开发环境实测（设备无 JDK/Android SDK），
     * 而「凭猜测定下一个未经验证的 API 语义」正是本项目已记录两次的失败模式
     * （见 docs/AGENTS/gotchas.md §3.1、§4）。取「或」是**可证明安全**的：
     * - 安装窗口内写入的文件 → ctime 必然刷新 → **一定被处理**（正确性保证）；
     * - 真正陈旧且无关的文件 → 两个时间戳都旧 → 才会跳过（优化仍生效）。
     * 最坏情况只是多处理一些文件，而 patch 幂等（已替换则无匹配）；
     * 代价实测：全树 3835 文件 / 144MB 约 1.1s（bin+lib 483 文件约 250ms），
     * 且只发生在安装窗口内——**调用方须在后台线程**。
     *
     * @param minTsMs 基线（<=0 表示不做增量过滤，处理全部文件）
     */
    internal fun shouldProcess(f: File, minTsMs: Long): Boolean =
        decideProcess(ctimeMs(f), f.lastModified(), minTsMs)

    /**
     * 增量判定的**纯函数**形式（便于穷举边界，不碰文件系统）。
     *
     * @param cTimeMs 文件 ctime（取不到时传 [Long.MAX_VALUE]）
     * @param mTimeMs 文件 mtime
     * @param minTsMs 基线（<=0 = 全量处理）
     */
    internal fun decideProcess(cTimeMs: Long, mTimeMs: Long, minTsMs: Long): Boolean {
        if (minTsMs <= 0L) return true
        // 平台时间戳退化（0/epoch）→ 放弃增量、倾向处理：此时唯一可用的 mtime
        // 恰恰是被归档保留的旧时间戳，信它就会重演本缺陷。代价仅一次全树扫描
        // （实测 ~1.1s，只在安装窗口内发生），而漏 patch 是已实证的真实故障。
        if (cTimeMs < PLAUSIBLE_TS_FLOOR_MS) return true
        if (cTimeMs >= minTsMs) return true
        return mTimeMs >= minTsMs
    }

    /**
     * 时间戳合理性下限（2000-01-01 UTC）。
     *
     * 用于识别「该平台不支持此时间戳」的退化返回（0 / epoch / 极小值）。
     * 文件系统只会给出真实时间或退化值，正常文件不可能早于 2000 年。
     */
    internal const val PLAUSIBLE_TS_FLOOR_MS = 946_684_800_000L

    /**
     * 取文件 ctime（epoch ms）。读取失败时返回 [Long.MAX_VALUE]（**倾向处理**）——
     * 取不到时间戳不该导致漏 patch；重复 patch 幂等，多处理无副作用。
     */
    private fun ctimeMs(f: File): Long = try {
        Files.readAttributes(f.toPath(), BasicFileAttributes::class.java)
            .creationTime().toMillis()
    } catch (_: Throwable) {
        Long.MAX_VALUE
    }

    /**
     * 供单测断言平台时间戳语义（见 `PrefixPatcherTest`）。
     *
     * 存在意义：增量判据依赖 `creationTime()`，而各平台对该 API 的底层映射不同
     * （Linux/Android 上可能是 statx btime，也可能回落 `st_ctime`）。测试若直接假定
     * 「刚写入的文件 ctime 必定新鲜」，遇到退化实现会给出令人困惑的失败。
     * 暴露此访问器让测试**先验证前提、再断言行为**，失败信息自解释。
     */
    internal fun ctimeMsForTest(f: File): Long = ctimeMs(f)

    /**
     * 扫描整个 PREFIX，把所有普通文件中的官方硬编码路径等长替换为短前缀。
     * 覆盖 ELF 二进制、动态库、shell 脚本、pkgconfig、dpkg 清单等，
     * 使 apt/dpkg/bash 等全部通过 `t` 符号链接访问真实目录。
     *
     * @param minTsMs 增量基线（见 [shouldProcess]）；0 = 全量处理
     */
    fun patchAll(usr: File, minTsMs: Long = 0L) {
        val since = if (minTsMs > 0L) " (incremental, ts>=$minTsMs)" else ""
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
            // P2-5 增量化：只处理本次安装写入的文件（ctime 判据，见 shouldProcess）
            if (!shouldProcess(f, minTsMs)) { skipped++; return@forEach }
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
     *
     * @param minTsMs 增量基线（见 [shouldProcess]）；0 = 全量处理
     */
    fun patchTextOfficialDirs(usr: File, minTsMs: Long = 0L) {
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
                if (!shouldProcess(f, minTsMs)) return@forEach
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
