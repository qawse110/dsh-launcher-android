package com.dsh.nextapp1.core

import android.content.Context
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.File
import java.io.InputStream
import com.dsh.nextapp1.core.*
import com.dsh.nextapp1.overlay.*
import com.dsh.nextapp1.service.*
import com.dsh.nextapp1.tts.*
import com.dsh.nextapp1.ui.*
import com.dsh.nextapp1.R

/**
 * 内置 Node 运行时：从 assets 解压 Termux Node (aarch64, bionic) 到应用私有目录。
 * 供嵌入式终端以正确 LD_LIBRARY_PATH 运行。
 *
 * 说明：
 * 1) AGP 对 .gz 后缀 asset 做 noCompress 处理，APK 中可能以 `xxx.tar` 或 `xxx.tar.gz`
 *    命名，且内容可能是明文 tar 或 gzip 流。这里对两种名称和两种格式都自适应。
 * 2) Termux 打包的 tar 内文件权限为 700（owner 可写）。Android 10+ 的 W^X 策略
 *    （写执行互斥）禁止 exec 可写文件，因此解压后需递归取消写权限、保留可读可执行。
 */
object NodeRuntime {

    private val ASSETS = arrayOf(
        "node/termux-node-aarch64.tar",   // AGP noCompress 重命名后的常见形式
        "node/termux-node-aarch64.tar.gz" // 原始打包名
    )
    private const val DIR = "node"
    private const val TAG = "NodeRuntime"

    /**
     * Termux 打包的 node 把**官方前缀编译死**在二进制里，而本环境该路径不存在。
     * 这会在两处先后爆出来（PTC 的 code run 都表现为 worker-exit）：
     *
     * 1. **动态链接期**：RUNPATH = `/data/data/com.termux/files/usr/lib` ⇒ 找不到
     *    libz.so.1/libcares.so，进程在跑任何用户代码前就退出：
     *    `CANNOT LINK EXECUTABLE ...: library "libz.so.1" not found`。
     * 2. **OpenSSL 初始化期**：libcrypto.so.3 编译进
     *    `OPENSSLDIR = /data/data/com.termux/files/usr/etc/tls` ⇒ 读不到 openssl.cnf：
     *    `OpenSSL configuration error: ... fopen(.../etc/tls/openssl.cnf, rb)` 退出码 13。
     *
     * 根因同源：`files/node` 是 `files/termux` 的**兄弟目录**，不在 [PrefixPatcher]
     * 扫描的 `termux/usr` 内，所以从未被前缀适配覆盖。DSH 主进程恰好带着
     * LD_LIBRARY_PATH / OPENSSL_CONF 掩盖了这两点，而 PTC 的 worker 会重设环境，
     * 于是暴露。
     *
     * ## 修法（两步等长替换，顺序不可颠倒）
     *
     * **步骤 1**：`…/usr/lib`（35 字符）→ `$ORIGIN/../lib`＋`':'` 补足 35。
     * - `$ORIGIN` 由 bionic 解析为「本可执行文件所在目录」，整套 node 因此自包含、
     *   可整体搬移、**不依赖 LD_LIBRARY_PATH**；
     * - 必须整棵树都改：bionic 的 `DT_RUNPATH` **不传递**（与 glibc 不同），
     *   node→libicuuc→libicudata 这条链要求每一层都能自己找到库
     *   （实测 node/lib 下 20+ 个 .so 各自也带官方 RUNPATH）；
     * - 必须用 `':'` 填充而非 NUL：NUL 会让 node 内嵌的 JSON 构建配置变成非法
     *   JSON，`-e` 直接 SyntaxError。`':'` 空段实测不会把 CWD 引入搜索路径。
     *
     * **步骤 2**：其余 `…/files/usr`（31 字符）→ 短前缀 `/data/user/0/<pkg>/t`（同为 31）。
     * 这一步修的是 RUNPATH 之外的**配置/数据路径**，最关键的是 `OPENSSLDIR`
     * （`…/usr/etc/tls` → `/data/user/0/<pkg>/t/etc/tls`，该 openssl.cnf 真实存在且可读），
     * 顺带覆盖 `usr/bin/bash`、`usr/tmp` 等。步骤 1 必须先做：否则 lib 路径会被本步
     * 改写成 `t/lib`，而 `t/lib` 缺少 libcares/libsqlite3/libicu*（node 自带的那份才全）。
     *
     * 两步都是**等长**替换（35→35、31→31），字节偏移全不变，不破坏 ELF。
     */
    private const val OFFICIAL_LIB = "/data/data/com.termux/files/usr/lib"   // 35
    private const val ORIGIN_LIB = "\$ORIGIN/../lib"                          // 15 (+20 补 ':')
    private const val OFFICIAL_USR = PrefixPatcher.OFFICIAL_PREFIX            // 31
    private const val SHORT_USR = PrefixPatcher.SHORT_PREFIX                  // 31

    @Synchronized
    fun ensureExtracted(context: Context): File {
        val dir = File(context.filesDir, DIR)
        // marker 命中还不够：bin/node 必须真实存在（文件被清理/误删后自动重解压，
        // 而不是让下游 install-dsh.mjs 以含混的 node: not found 失败）。
        if (MarkerStore.has(context, "node") && File(dir, "bin/node").isFile) {
            // 存量设备自愈：老版本解压出来的 node 仍是官方 RUNPATH（PTC 直接起不来）。
            // 幂等且极廉价（无官方串即空转），故每次都校核，而不是只靠一次性 marker。
            ensureRunpathsPatched(dir)
            return dir
        }

        dir.mkdirs()
        // 清理历史残留：旧版本/异常中断可能留下只读目录（W^X 取消写权限）
        // 导致后续覆写 EACCES。先递归恢复可写，再清空，保证全新解压。
        cleanupDir(dir)
        var opened = false
        try {
            val stream = openAsset(context)  // 已去除 gzip 头
            opened = true
            stream.use { raw -> extractTar(dir, raw) }
            // 兼容“外层 tar 包着真实 node tar”的资产：资产里只有一个 *.tar 时，
            // 把它再解包一次，得到 bin/ lib/ 等真实运行时目录。
            if (!File(dir, "bin/node").isFile) {
                val nested = dir.listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".tar") }
                if (nested != null) {
                    java.io.FileInputStream(nested).use { extractTar(dir, it) }
                    nested.delete()
                }
            }
            // 目录视为可搜索即可（无需可写）
            dir.setReadable(true, false)
            dir.setExecutable(true, false)
            // ★ 必须在 makeUnwritable 之前改 RUNPATH：等长改写需要写权限
            ensureRunpathsPatched(dir)
            // Android W^X：被 exec 的文件/目录必须对进程不可写
            makeUnwritable(dir)
            // tmp 目录需要保持可写（node 运行时 TMPDIR）
            File(dir, "tmp").apply {
                mkdirs()
                setWritable(true, false)
                setReadable(true, false)
                setExecutable(true, false)
            }
            MarkerStore.put(context, "node", "ok")
        } catch (t: Throwable) {
            runCatching { dir.deleteRecursively() }
            runCatching { MarkerStore.remove(context, "node") }
            throw t
        }
        return dir
    }

    /** 把 tar 流解压到 dir；处理目录、符号链接与 W^X 可执行位。 */
    private fun extractTar(dir: File, raw: InputStream) {
        TarArchiveInputStream(raw).use { tar ->
            var e: TarArchiveEntry? = tar.nextEntry
            while (e != null) {
                val name = e.name.removePrefix("./").removePrefix("/") // 防路径穿越
                // 显式拒绝穿越段与绝对路径（与 install-dsh.mjs untarWithPrefix 对齐）
                if (name.isEmpty() || name.contains("..") || name.startsWith("/")) {
                    e = tar.nextEntry
                    continue
                }
                val out = File(dir, name)
                if (e.isDirectory) {
                    out.mkdirs()
                } else if (e.isSymbolicLink) {
                    // Termux 包大量使用符号链接（libcrypto.so -> libcrypto.so.3）。
                    // 必须真实创建符号链接，否则会写成 0 字节空文件导致动态库加载失败。
                    out.parentFile?.mkdirs()
                    createSymlink(out, e.linkName)
                } else {
                    out.parentFile?.mkdirs()
                    val fos = java.io.FileOutputStream(out)
                    try {
                        val buf = ByteArray(64 * 1024)
                        var n: Int
                        while (tar.read(buf).also { n = it } != -1) {
                            fos.write(buf, 0, n)
                        }
                    } finally { fos.close() }
                    out.setExecutable(true)
                }
                e = tar.nextEntry
            }
        }
    }


    /**
     * 打开 asset 并返回可直接交给 TarArchiveInputStream 的流。
     * 自适应名称（.tar / .tar.gz）与格式（明文 tar / gzip）。
     */
    private fun openAsset(context: Context): InputStream {
        var lastErr: Exception? = null
        for (name in ASSETS) {
            try {
                val raw = context.assets.open(name)
                val probe = java.io.PushbackInputStream(raw, 2)
                val a = probe.read(); val b = probe.read()
                if (a >= 0) probe.unread(a)
                if (b >= 0) probe.unread(b)
                // 检测 gzip 魔数 0x1f 0x8b
                if (a == 0x1f && b == 0x8b) {
                    return GzipCompressorInputStream(probe)
                }
                return probe
            } catch (e: Exception) {
                lastErr = e
            }
        }
        throw RuntimeException("无法加载 Node 运行时 asset", lastErr)
    }

    /**
     * 把 [dir] 下所有 ELF 里的官方 lib 路径等长改写成 `$ORIGIN/../lib`。
     *
     * 幂等：改完后已无官方串，再次调用零改动（实测第二遍 patched=0、md5 不变）。
     * 失败容忍：单个文件出错只记日志，不让整套 node 解压失败。
     *
     * W^X 注意：安装后的 node 树是**只读**的（[makeUnwritable]），而等长改写必须可写。
     * 因此这里对命中的文件先临时 `setWritable(true)`，改完立即恢复 `setWritable(false)`，
     * 保证既不破坏 W^X 策略、又能在存量设备上就地自愈。
     *
     * @return 实际改写的文件数（供日志与测试断言）。
     */
    internal fun ensureRunpathsPatched(dir: File): Int {
        // 等长前提：两步替换长度必须严格相等，否则拒绝执行（宁可不动也不能写坏 ELF）
        val libPad = ":".repeat(OFFICIAL_LIB.length - ORIGIN_LIB.length)
        val originLib = ORIGIN_LIB + libPad
        if (OFFICIAL_LIB.length != originLib.length || OFFICIAL_USR.length != SHORT_USR.length) {
            android.util.Log.e(
                TAG,
                "node prefix patch length mismatch: lib ${OFFICIAL_LIB.length}->${originLib.length}, " +
                    "usr ${OFFICIAL_USR.length}->${SHORT_USR.length}",
            )
            return 0
        }
        // 步骤 1 必须先行（见上方 KDoc）：先把 …/usr/lib 改成 $ORIGIN/../lib，
        // 否则步骤 2 会把它改写成 t/lib，而 t/lib 缺少 node 自带的那几个库。
        val pass1 = replaceAll(dir, OFFICIAL_LIB, originLib)
        // 步骤 2：其余官方 usr 路径 → 短前缀（修 OPENSSLDIR / etc/tls / bin/sh / tmp 等）
        val pass2 = replaceAll(dir, OFFICIAL_USR, SHORT_USR)
        val patched = pass1 + pass2
        if (patched > 0) {
            android.util.Log.i(TAG, "node prefix patched files=$patched (lib=$pass1 usr=$pass2) under $dir")
        }
        return patched
    }

    /** 把 [dir] 下所有文件的 [old] 等长替换为 [new]（长度必须相等）；返回改写的文件数。 */
    private fun replaceAll(dir: File, old: String, new: String): Int {
        val oldB = old.toByteArray(Charsets.ISO_8859_1)
        val newB = new.toByteArray(Charsets.ISO_8859_1)
        if (oldB.size != newB.size) {
            android.util.Log.e(TAG, "refuse unequal replace: $old -> $new")
            return 0
        }
        var patched = 0
        walkFiles(dir) { f ->
            try {
                val bytes = java.nio.file.Files.readAllBytes(f.toPath())
                if (containsBytes(bytes, oldB)) {
                    if (writeReplacing(f, replaceBytes(bytes, oldB, newB))) {
                        patched++
                    } else {
                        android.util.Log.w(TAG, "write failed for ${f.name}")
                    }
                }
            } catch (t: Throwable) {
                android.util.Log.w(TAG, "prefix patch failed for ${f.name}: ${t.message}")
            }
        }
        return patched
    }

    /**
     * 就地替换 [f] 的内容，返回值表示是否成功。
     *
     * 真机上必须用 **临时文件 + rename**，不能直接原地写，原因有二：
     * 1. `bin/node` 往往正是**当前正在运行的 DSH 进程**，对正在执行的文件原地写会
     *    返回 `ETXTBSY`（实测踩到，导致 23 个文件只改掉 22 个）；
     * 2. Android W^X 下安装后的文件与目录都是只读的（`dr-xr-xr-x`），而这两者都需要
     *    临时放开写位，且必须在结束时**恢复只读**，否则后续 `exec` 会因 W^X 被拒。
     *
     * rename 在同一目录内是原子的：正在执行的进程继续用旧 inode，新进程看到新内容。
     */
    private fun writeReplacing(f: File, bytes: ByteArray): Boolean {
        val path = f.toPath()
        val dir = f.parentFile ?: return false
        val wasWritable = f.canWrite()
        val dirWasWritable = dir.canWrite()
        var tmp: File? = null
        try {
            if (!dirWasWritable) dir.setWritable(true, false)
            val perms = runCatching { java.nio.file.Files.getPosixFilePermissions(path) }.getOrNull()
            if (!wasWritable) f.setWritable(true, false)
            tmp = File.createTempFile(".${f.name}.", ".dshnew", dir)
            java.nio.file.Files.write(tmp.toPath(), bytes)
            // 保留原权限位（可执行位丢失会让 node 无法启动）
            if (perms != null) {
                runCatching { java.nio.file.Files.setPosixFilePermissions(tmp.toPath(), perms) }
            } else {
                tmp.setExecutable(f.canExecute(), false)
            }
            runCatching {
                java.nio.file.Files.move(
                    tmp.toPath(), path,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                )
            }.getOrElse {
                java.nio.file.Files.move(
                    tmp.toPath(), path,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
            }
            tmp = null
            return true
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "write failed for ${f.name}: ${t.message}")
            return false
        } finally {
            tmp?.delete()
            // 恢复 W^X：被 exec 的文件与目录必须对进程不可写
            runCatching { if (!wasWritable) f.setWritable(false, false) }
            runCatching { if (!dirWasWritable) dir.setWritable(false, false) }
        }
    }

    /** 递归遍历真实文件（跳过符号链接与可写的 tmp 目录），供 RUNPATH 改写使用。 */
    private fun walkFiles(dir: File, action: (File) -> Unit) {
        val entries = dir.listFiles() ?: return
        for (f in entries) {
            if (java.nio.file.Files.isSymbolicLink(f.toPath())) continue
            if (f.isDirectory) {
                if (f.name == "tmp") continue   // 运行时可写目录，不含 ELF
                walkFiles(f, action)
            } else if (f.isFile) {
                action(f)
            }
        }
    }

    /** 纯字节子串查找（与 PrefixPatcher 同语义，避免 String 编解码开销）。 */
    private fun containsBytes(hay: ByteArray, needle: ByteArray): Boolean =
        indexOfBytes(hay, needle, 0) >= 0

    private fun indexOfBytes(hay: ByteArray, needle: ByteArray, from: Int): Int {
        if (needle.isEmpty() || hay.size - from < needle.size) return -1
        val first = needle[0]
        val limit = hay.size - needle.size
        outer@ for (i in from.coerceAtLeast(0)..limit) {
            if (hay[i] != first) continue
            for (j in 1 until needle.size) {
                if (hay[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }

    /** 字节级全量替换（等长场景，单次线性扫描）。 */
    private fun replaceBytes(input: ByteArray, old: ByteArray, new: ByteArray): ByteArray {
        val first = indexOfBytes(input, old, 0)
        if (first < 0) return input
        val out = java.io.ByteArrayOutputStream(input.size)
        var cursor = 0
        var hit = first
        while (hit >= 0) {
            out.write(input, cursor, hit - cursor)
            out.write(new, 0, new.size)
            cursor = hit + old.size
            hit = indexOfBytes(input, old, cursor)
        }
        out.write(input, cursor, input.size - cursor)
        return out.toByteArray()
    }

    /** 递归取消写权限，满足 Android W^X：保留父目录可读可执行、文件可读可执行。 */
    private fun makeUnwritable(current: File) {
        // 跳过符号链接：只操作真实文件/目录，避免跟随链接修改到链接目标或外部文件
        if (java.nio.file.Files.isSymbolicLink(current.toPath())) return
        if (current.isDirectory) {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
            current.listFiles()?.forEach { makeUnwritable(it) }
        } else {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
        }
    }

    /** 创建符号链接；若失败（如目标相对且超界）则退化为空文件避免中断，由启动阶段兜底。 */
    private fun createSymlink(link: File, target: String) {
        try {
            if (link.exists()) link.delete()
            java.nio.file.Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target))
        } catch (t: Throwable) {
            runCatching { link.createNewFile() }
        }
    }

    /**
     * 清理历史残留：先递归恢复写权限（覆盖 W^X 造成的只读目录），再删除全部内容，
     * 使后续解压能在全新可写目录上进行，避免 EACCES。
     */
    private fun cleanupDir(dir: File) {
        if (!dir.exists()) return
        makeWritableRecursive(dir)
        dir.deleteRecursively()
        dir.mkdirs()
    }

    /** 递归恢复所有条目为可写（用于解压前清理）。 */
    private fun makeWritableRecursive(f: File) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(true, false)
            f.listFiles()?.forEach { makeWritableRecursive(it) }
        } else {
            f.setWritable(true, false)
        }
    }

    /** 返回在嵌入式终端中运行 node 的命令前缀（含 LD_LIBRARY_PATH）。 */
    fun nodeEnvPrefix(context: Context): String {
        val dir = ensureExtracted(context).absolutePath
        return "export LD_LIBRARY_PATH=$dir/lib; export HOME=$dir; export TMPDIR=$dir/tmp; " +
            "OPENSSL_CONF=/dev/null; TERM=xterm-256color "
    }
}
