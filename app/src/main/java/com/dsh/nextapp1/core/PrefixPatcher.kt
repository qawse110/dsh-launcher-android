package com.dsh.nextapp1.core

import java.io.File
import java.nio.file.Files

/**
 * 前缀 patcher：把官方 Termux 硬编码路径改写到搬迁后的真实位置。
 *
 * - 二进制（ELF/so）：[patchAll] 等长字节替换为短前缀 `…/t`（经符号链接等价）；
 * - 文本脚本/配置：[patchTextOfficialDirs] 替换为镜像长路径（可安全变长）。
 *
 * 架构方案 P1-3：由 [TermuxRuntime] 门面与 [BootstrapInstaller]/[PackageKit] 调用。
 *
 * ## 为什么不再做「按 mtime 增量」
 *
 * v4.9.x 曾用 `minLastModifiedMs` 基线做增量（架构方案 P2-5），结果在真机上
 * **整段失效**：apt/dpkg 解包会保留 deb 包内成员的原始 mtime，而基线取的是
 * 「安装窗口开始时刻」的墙钟时间。于是任何**包内时间戳早于安装窗口**的载荷
 * 都被判为「旧文件」跳过。真机实测：git 包 2026-10-01 08:33:26 安装，而
 * `bin/git` 的 mtime 是包内的 2026-09-30 14:48 ⇒ git 全家族（`bin/git`、
 * `libexec/git-core/git-remote-*` 等 36 个文件）从未被改写，`git --exec-path`
 * 一直指向不可访问的 `/data/data/com.termux/files/usr/libexec/git-core`，
 * 裸终端里 `git status` 直接报 `unable to access .../etc/gitconfig: Permission denied`。
 * 同一批 apt 安装的 `bin/rg`(2026-07-16)、`bin/wget`(2025-08-31) 同样漏改。
 *
 * 实测全树扫描 3830 文件 / 128MB 仅约 0.6s，增量省下的收益远小于它带来的
 * 静默漏改风险。故这里**移除 mtime 判据**，改为无条件全量扫描——正确性优先，
 * 且用 [audit] 把「是否改干净」变成可重复执行的显式检查而不是靠假设。
 */
internal object PrefixPatcher {

    /** 官方二进制硬编码的 Termux 前缀（长度 31）。 */
    const val OFFICIAL_PREFIX = "/data/data/com.termux/files/usr"

    /** 等长替换用的短前缀，通过 dataDir/t -> files/termux/usr 符号链接映射。 */
    const val SHORT_PREFIX = "/data/user/0/com.dsh.nextapp1/t"

    /** 官方 files 根路径；文本文件里出现时应改写为镜像长路径。 */
    const val OFFICIAL_FILES = "/data/data/com.termux/files"

    /** 官方 apt 缓存路径；文本文件里出现时应指到真实 var/cache/apt。 */
    const val OFFICIAL_APT_CACHE = "/data/data/com.termux/cache/apt"

    private const val TAG = "PrefixPatcher"

    /** 单次 patch 的执行结果，供调用方据实记录/断言，而不是只看日志。 */
    data class Result(
        val patched: Int,
        val scanned: Int,
    )

    /**
     * 扫描整个 PREFIX，把所有普通文件中的官方硬编码路径等长替换为短前缀。
     * 覆盖 ELF 二进制、动态库、shell 脚本、pkgconfig、dpkg 清单等，
     * 使 apt/dpkg/bash 等全部通过 `t` 符号链接访问真实目录。
     *
     * **全量、幂等**：不接收 mtime 基线（见类注释），可对同一目录反复调用。
     *
     * 幂等的关键：必须先排除**镜像路径** `dataDir + OFFICIAL_PREFIX`。
     * 镜像串自带 `OFFICIAL_PREFIX` 作为后缀，若不做排除，第二次运行会把
     * `…/files/data/data/com.termux/files/usr/bin/git` 改写成
     * `…/files/data/data/user/0/…/t/bin/git` 这种二次嵌套的坏路径。
     */
    fun patchAll(usr: File): Result {
        val old = OFFICIAL_PREFIX
        val new = SHORT_PREFIX
        if (old.length != new.length) {
            android.util.Log.e(TAG, "prefix patch length mismatch: ${old.length} != ${new.length}")
            return Result(0, 0)
        }
        val mirrorRoots = mirrorRootsOf(usr)
        val oldBytes = old.toByteArray(Charsets.ISO_8859_1)
        val newBytes = new.toByteArray(Charsets.ISO_8859_1)
        var patched = 0
        var scanned = 0
        val failures = ArrayList<String>()
        walkPayloadFiles(usr) { f ->
            scanned++
            try {
                val bytes = Files.readAllBytes(f.toPath())
                if (hasOccurrenceOutsideMirror(bytes, oldBytes, mirrorRoots)) {
                    writeAtomic(f, replaceOutsideMirror(bytes, oldBytes, newBytes, mirrorRoots))
                    patched++
                }
            } catch (t: Throwable) {
                // 单个文件失败不影响整体（例如权限/占用/已被删除），但必须留下痕迹：
                // 静默吞掉会让 Result.patched 偏低而无人察觉，最终表现为「莫名少改了几个」。
                failures.add("${f.name}: ${t.javaClass.simpleName} ${t.message}")
            }
        }
        if (failures.isNotEmpty()) {
            android.util.Log.w(
                TAG,
                "prefix patch had ${failures.size} failure(s): ${failures.take(5)}",
            )
        }
        android.util.Log.i(TAG, "prefix patched files=$patched scanned=$scanned failed=${failures.size}")
        return Result(patched, scanned)
    }

    /**
     * 文本脚本/配置中可能还带官方 files 根路径（如 `/data/data/com.termux/files/home`）。
     * 二进制只能等长替换，已由 [patchAll] 处理；文本文件可以安全地用镜像长路径替换，
     * 让 profile.d 等脚本通过 dataDir 下的 `data/data/com.termux/files` 符号链接落到真实目录。
     * 只处理不含 NUL 的普通文本文件，避免破坏 ELF/其他二进制。
     */
    fun patchTextOfficialDirs(usr: File): Result {
        val mirrorRoots = dataDirOf(usr)
        val dataDir = mirrorRoots.firstOrNull() ?: return Result(0, 0).also {
            android.util.Log.w(TAG, "patchTextOfficialDirs: invalid usr path: $usr")
        }
        // 注意 OFFICIAL_FILES 自带前导 "/"，必须直接拼接：写成 "$dataDir/$OFFICIAL_FILES"
        // 会产生双斜杠 `…/files//data/data/…`，既与 createOfficialMirror 建出的真实镜像
        // 路径不一致，也会让 audit 认不出这是镜像。
        val mirFiles = "$dataDir$OFFICIAL_FILES"
        val newAptCache = "${usr.absolutePath}/var/cache/apt"
        val mirrorBytes = mirrorRoots.map { it.toByteArray(Charsets.ISO_8859_1) }
        val filesBytes = OFFICIAL_FILES.toByteArray(Charsets.ISO_8859_1)
        val mirFilesBytes = mirFiles.toByteArray(Charsets.ISO_8859_1)
        val aptCacheBytes = OFFICIAL_APT_CACHE.toByteArray(Charsets.ISO_8859_1)
        val newAptCacheBytes = newAptCache.toByteArray(Charsets.ISO_8859_1)
        var patched = 0
        var scanned = 0
        val failures = ArrayList<String>()
        walkPayloadFiles(usr) { f ->
            scanned++
            try {
                val bytes = Files.readAllBytes(f.toPath())
                if (bytes.any { it == 0.toByte() }) return@walkPayloadFiles
                var out = String(bytes, Charsets.ISO_8859_1)
                // 两处替换都用同一套「镜像感知」字节替换：
                //   · OFFICIAL_FILES 会被改写为 mirFiles（而 mirFiles 自带 OFFICIAL_FILES
                //     作后缀，正是必须排除镜像的原因）；
                //   · OFFICIAL_APT_CACHE 改写为真实 var/cache/apt。
                // 旧实现用 @@DSH_MIRROR_FILES@@ 占位符来防二次替换，那引入了一个**输入敏感**的
                // 隐患：若某文件本来就含该字面量，会被当成占位符还原成镜像路径。改用
                // replaceOutsideMirror 后语义完全等价（幂等、不二次嵌套），却不再有任何
                // 魔法字符串，也就没有这类碰撞风险。
                if (out.contains(OFFICIAL_FILES)) {
                    val outBytes = out.toByteArray(Charsets.ISO_8859_1)
                    if (hasOccurrenceOutsideMirror(outBytes, filesBytes, mirrorBytes)) {
                        out = String(
                            replaceOutsideMirror(outBytes, filesBytes, mirFilesBytes, mirrorBytes),
                            Charsets.ISO_8859_1,
                        )
                    }
                }
                if (out.contains(OFFICIAL_APT_CACHE)) {
                    val outBytes = out.toByteArray(Charsets.ISO_8859_1)
                    if (hasOccurrenceOutsideMirror(outBytes, aptCacheBytes, mirrorBytes)) {
                        out = String(
                            replaceOutsideMirror(outBytes, aptCacheBytes, newAptCacheBytes, mirrorBytes),
                            Charsets.ISO_8859_1,
                        )
                    }
                }
                if (out != String(bytes, Charsets.ISO_8859_1)) {
                    writeTextFile(f, out)
                    patched++
                }
            } catch (t: Throwable) {
                // 与 patchAll 一致：单个文件失败不影响整体，但必须留痕，
                // 否则 patched 偏低却无人察觉（顾问复核时指出的不对称）。
                failures.add("${f.name}: ${t.javaClass.simpleName} ${t.message}")
            }
        }
        if (failures.isNotEmpty()) {
            android.util.Log.w(
                TAG,
                "text prefix patch had ${failures.size} failure(s): ${failures.take(5)}",
            )
        }
        android.util.Log.i(
            TAG,
            "patched $patched text files for official paths (scanned=$scanned failed=${failures.size})",
        )
        return Result(patched, scanned)
    }

    /**
     * 可重复执行的完整前缀适配：等长 patch + 文本 patch，随后 [audit] 复核。
     * 首装、每次 harness 工具安装之后、以及存量设备自愈都走这里，避免再出现
     * 「装了包但没 patch」的静默漏洞。
     */
    fun patchEverything(usr: File): Outcome {
        val bin = patchAll(usr)
        val text = patchTextOfficialDirs(usr)
        val audit = audit(usr)
        if (!audit.clean) {
            android.util.Log.w(TAG, "prefix audit NOT clean after patch: $audit")
        }
        return Outcome(bin, text, audit)
    }

    data class Outcome(
        val binary: Result,
        val text: Result,
        val audit: AuditResult,
    )

    /**
     * 审计发现的一条残留。危险程度与可修复性不同，必须分开统计，否则会把
     * 「永远修不掉的固有残留」当成门禁失败，门禁就没人看了：
     *
     * - [MUST_FIX]：命中 `官方 usr 前缀`。它直接决定 `git --exec-path`、`.pc`、
     *   shebang 等是否可用，[patchAll] 的等长替换必然能处理，**必须为 0**。
     * - [TEXT_FIX_NEEDED]：**文本**文件里残留官方 `files` 根或官方 apt cache 路径。
     *   [patchTextOfficialDirs] 能安全改写（变长），patch 之后也应归零。
     * - [BINARY_REMNANT]：**二进制**里残留 `files` 根 / apt cache 路径，但不含
     *   `files/usr` 核心前缀（例如 bash 内嵌的 `files/home`、libapt-pkg.so 的
     *   `/data/data/com.termux/cache/apt`）。等长替换要求长度一致，这两者都没有
     *   等长对应物 ⇒ **无法用当前机制修**，且不影响裸环境（HOME 由 App 显式注入；
     *   apt cache 由 `etc/apt/apt.conf.d/00-dsh` 显式覆盖）。仅披露，不参与门禁。
     */
    enum class Severity { MUST_FIX, TEXT_FIX_NEEDED, BINARY_REMNANT }

    data class Leftover(val path: String, val severity: Severity)

    data class AuditResult(
        val leftovers: List<Leftover>,
        val scanned: Int,
    ) {
        private fun of(s: Severity) = leftovers.filter { it.severity == s }

        /** 会让裸环境工具链失效的残留——门禁判据，必须为空。 */
        val mustFix: List<Leftover> get() = of(Severity.MUST_FIX)

        /** 文本类残留：patch 之后必须为空。 */
        val textFixNeeded: List<Leftover> get() = of(Severity.TEXT_FIX_NEEDED)

        /** 二进制固有残留：披露但不阻断。 */
        val binaryRemnants: List<Leftover> get() = of(Severity.BINARY_REMNANT)

        /** 是否已改干净（门禁口径：MUST_FIX 与 TEXT_FIX_NEEDED 均为 0）。 */
        val clean: Boolean get() = mustFix.isEmpty() && textFixNeeded.isEmpty()

        override fun toString(): String =
            "AuditResult(clean=$clean scanned=$scanned mustFix=${mustFix.size} " +
                "text=${textFixNeeded.size} binaryRemnants=${binaryRemnants.size})"
    }

    /**
     * 独立审计：全树查找仍带官方路径的文件。**可重复执行、不修改任何文件**，
     * 且对「新装的同类包」同样成立（因为它扫的是内容而非安装时间）。
     *
     * 这是本类防止缺陷复发的核心手段：不再依赖「安装流程记得调 patch」的默契，
     * 而是每次准备/安装之后都能拿事实说话。
     */
    fun audit(usr: File): AuditResult {
        val mirrorRoots = mirrorRootsOf(usr)
        val core = OFFICIAL_PREFIX.toByteArray(Charsets.ISO_8859_1)
        val files = OFFICIAL_FILES.toByteArray(Charsets.ISO_8859_1)
        val aptCache = OFFICIAL_APT_CACHE.toByteArray(Charsets.ISO_8859_1)
        val leftovers = ArrayList<Leftover>()
        var scanned = 0
        walkPayloadFiles(usr) { f ->
            scanned++
            try {
                val bytes = Files.readAllBytes(f.toPath())
                // 关键：镜像长路径 `dataDir + /data/data/com.termux/files` **包含**官方
                // files 根这个子串。若不排除镜像内的命中，所有已正确改写为镜像的文本
                // 文件都会被误报成残留，审计将永远无法通过。
                val hasCore = hasOccurrenceOutsideMirror(bytes, core, mirrorRoots)
                val hasFiles = hasOccurrenceOutsideMirror(bytes, files, mirrorRoots)
                val hasAptCache = hasOccurrenceOutsideMirror(bytes, aptCache, mirrorRoots)
                val severity = when {
                    hasCore -> Severity.MUST_FIX
                    hasFiles || hasAptCache ->
                        if (bytes.any { it == 0.toByte() }) Severity.BINARY_REMNANT
                        else Severity.TEXT_FIX_NEEDED
                    else -> null
                }
                if (severity != null) leftovers.add(Leftover(relativize(usr, f), severity))
            } catch (_: Throwable) {
            }
        }
        val result = AuditResult(leftovers, scanned)
        android.util.Log.i(TAG, "prefix audit: $result")
        return result
    }

    // ---------------- 内部工具 ----------------

    /**
     * 遍历 PREFIX 下的普通载荷文件（递归、不跟进符号链接）。
     *
     * 与旧实现的差别：旧代码用 `usr.walkTopDown().forEach { if (!f.isFile || isSymbolicLink) return@forEach }`
     * ——`File.isFile` 对**指向文件的符号链接返回 true**，所以那个 `isSymbolicLink` 守卫实际
     * 没挡住链接；而 `walkTopDown` 又不会跟进符号链接目录。这里显式判断
     * `Files.isRegularFile(NOFOLLOW_LINKS)`，语义明确且不会重复处理链接。
     *
     * 不用 `Files.walk(...).use {}`：`java.util.stream.Stream` 不是 `AutoCloseable`，
     * `use` 依赖 stdlib-jdk7 的扩展；手写递归无此依赖，行为也更可预测。
     */
    private fun walkPayloadFiles(usr: File, action: (File) -> Unit) {
        if (!usr.isDirectory) return
        walkInto(usr, action, 0)
    }

    private fun walkInto(dir: File, action: (File) -> Unit, depth: Int) {
        // 防御性深度上限：正常 Termux 前缀远达不到，仅避免异常目录结构导致栈溢出
        if (depth > 64) return
        val entries = dir.listFiles() ?: return
        for (f in entries) {
            // 不跟进符号链接（目录链接如 lib/terminfo -> ../share/terminfo 会被跳过）
            if (isSymlink(f)) continue
            if (f.isDirectory) {
                walkInto(f, action, depth + 1)
            } else if (f.isFile) {
                action(f)
            }
        }
    }

    private fun isSymlink(f: File): Boolean = try {
        Files.isSymbolicLink(f.toPath())
    } catch (_: Throwable) {
        false
    }

    private fun writeTextFile(f: File, text: String) {
        writeAtomic(f, text.toByteArray(Charsets.ISO_8859_1))
    }

    /**
     * 原子写：先写同目录临时文件、复制权限位、再 rename 覆盖。
     *
     * 为什么不用 `Files.write(path, bytes)` 原地写：它先截断再写，中途中断（进程被杀/
     * 掉电）会留下半截文件。被改写的是 `bin/git` 这类 ELF 可执行文件，截断即损坏。
     * 同目录 rename 是原子的，读者要么看到旧内容、要么看到新内容。
     *
     * 权限位是这里最危险的点：`createTempFile` 默认 0600，若权限复制失败就会**丢掉
     * 可执行位**，等于把 git 改废。更糟的是 audit 只查内容不查权限位，门禁仍会报绿。
     * 故这里把「可执行位没保住」当成硬错误抛出，由调用方的日志/审计暴露出来，
     * 绝不静默交付一个不可执行的 git。
     */
    private fun writeAtomic(f: File, bytes: ByteArray) {
        val path = f.toPath()
        val wasExecutable = f.canExecute()
        var tmp: File? = null
        try {
            tmp = File.createTempFile("${f.name}.dshpatch", ".tmp", f.parentFile)
            Files.write(tmp.toPath(), bytes)
            var permsCopied = false
            try {
                Files.setPosixFilePermissions(tmp.toPath(), Files.getPosixFilePermissions(path))
                permsCopied = true
            } catch (_: Throwable) {
                // 非 POSIX 文件系统（或权限查询失败）：下面按可执行位兜底
            }
            if (!permsCopied && wasExecutable && !tmp.setExecutable(true, false)) {
                // 兜底也失败：宁可整体失败让调用方感知，也不能静默交出丢失 X 位的可执行文件
                throw java.io.IOException("cannot preserve executable bit for ${f.absolutePath}")
            }
            try {
                Files.move(
                    tmp.toPath(), path,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                )
            } catch (_: Throwable) {
                // 某些文件系统不支持 ATOMIC_MOVE，退化为普通覆盖（仍优于原地截断写）
                Files.move(tmp.toPath(), path, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
            tmp = null
        } finally {
            tmp?.delete()
        }
    }

    /**
     * PREFIX 上溯三级得到的 dataDir：`usr = dataDir/files/termux/usr`。
     * 镜像路径（`createOfficialMirror`）建在 dataDir 下，故判定镜像需要它。
     *
     * 返回**所有等价的路径写法**：`/data/data/<pkg>` 与 `/data/user/0/<pkg>` 在本机是同一
     * inode（实测 `stat %d:%i` 相同），但字符串不同。若只认其中一种，而 PREFIX 恰好由另一种
     * 写法传入，镜像判定就会失配 ⇒ 已改对的镜像路径会被二次改写、嵌套成坏路径。
     * 故同时给出两种形式，任一对上即视为镜像内命中。
     */
    private fun dataDirOf(usr: File): List<String> {
        val dataDir = usr.parentFile?.parentFile?.parentFile?.absolutePath ?: return emptyList()
        val forms = linkedSetOf(dataDir)
        val userPrefix = "/data/user/0/"
        val dataPrefix = "/data/data/"
        when {
            dataDir.startsWith(userPrefix) -> forms.add(dataPrefix + dataDir.removePrefix(userPrefix))
            dataDir.startsWith(dataPrefix) -> forms.add(userPrefix + dataDir.removePrefix(dataPrefix))
        }
        return forms.toList()
    }

    /** 把 dataDir 的若干等价写法转成字节数组，供镜像判定使用。 */
    private fun mirrorRootsOf(usr: File): List<ByteArray> =
        dataDirOf(usr).map { it.toByteArray(Charsets.ISO_8859_1) }

    /**
     * 字节级替换，但**跳过落在镜像路径内的命中**。
     *
     * 镜像路径 = `dataDir + OFFICIAL_PREFIX`（如 `…/files/data/data/com.termux/files/usr`）。
     * 对它的命中属于「已经正确改写过的目标」，再次替换会嵌套成坏路径。
     */
    private fun replaceOutsideMirror(
        input: ByteArray,
        old: ByteArray,
        new: ByteArray,
        mirrorRoots: List<ByteArray>,
    ): ByteArray {
        if (old.isEmpty()) return input
        val out = java.io.ByteArrayOutputStream(input.size)
        var cursor = 0
        var hit = indexOf(input, old)
        while (hit >= 0) {
            if (isImmediatelyAfterAny(input, hit, mirrorRoots)) {
                // 镜像内命中：原样保留。注意游标不前进到命中末尾，只跳过这一处。
                out.write(input, cursor, hit + old.size - cursor)
                cursor = hit + old.size
            } else {
                out.write(input, cursor, hit - cursor)
                out.write(new, 0, new.size)
                cursor = hit + old.size
            }
            hit = indexOf(input, old, cursor)
        }
        out.write(input, cursor, input.size - cursor)
        return out.toByteArray()
    }

    /**
     * 是否存在**不属于镜像路径**的 [needle] 命中。
     *
     * [patchTextOfficialDirs] 把官方 files 根改写成 `dataDir + OFFICIAL_FILES`
     * （形如 `…/files/data/data/com.termux/files`）。镜像串自带 `OFFICIAL_FILES`
     * 作为后缀，因此直接 contains/indexOf 会把「已经改对的文件」重新判成残留——
     * 这是本审计最容易踩的坑，必须显式排除。
     *
     * 镜像形态固定为 `dataDir + OFFICIAL_FILES`，所以判定条件是精确的：
     * 命中点前方**紧邻**某个等价的 dataDir 写法即为镜像内命中。
     */
    private fun hasOccurrenceOutsideMirror(
        bytes: ByteArray,
        needle: ByteArray,
        mirrorRoots: List<ByteArray>,
    ): Boolean {
        var from = 0
        while (true) {
            val hit = indexOf(bytes, needle, from)
            if (hit < 0) return false
            if (!isImmediatelyAfterAny(bytes, hit, mirrorRoots)) return true
            from = hit + 1
        }
    }

    /** [bytes] 的 [at] 位置之前是否紧邻 [prefixes] 中任一（用于识别 `dataDir + 官方路径` 镜像串）。 */
    private fun isImmediatelyAfterAny(bytes: ByteArray, at: Int, prefixes: List<ByteArray>): Boolean {
        for (p in prefixes) {
            if (isImmediatelyAfter(bytes, at, p)) return true
        }
        return false
    }

    /** [bytes] 的 [at] 位置之前是否紧邻 [prefix]。 */
    private fun isImmediatelyAfter(bytes: ByteArray, at: Int, prefix: ByteArray?): Boolean {
        if (prefix == null || prefix.isEmpty() || at < prefix.size) return false
        val start = at - prefix.size
        for (k in prefix.indices) {
            if (bytes[start + k] != prefix[k]) return false
        }
        return true
    }

    private fun relativize(usr: File, f: File): String {
        val base = usr.absolutePath
        val p = f.absolutePath
        return if (p.startsWith("$base/")) p.substring(base.length + 1) else p
    }

    /** 纯字节 indexOf（Latin-1 无损，避免 String 解码开销与 BOM 干扰）。 */
    private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int = 0): Int {
        if (needle.isEmpty() || haystack.size - from < needle.size) return -1
        val first = needle[0]
        val limit = haystack.size - needle.size
        outer@ for (i in from.coerceAtLeast(0)..limit) {
            if (haystack[i] != first) continue
            for (j in 1 until needle.size) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }
}
