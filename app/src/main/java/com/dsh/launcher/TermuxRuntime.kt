package com.dsh.launcher

import android.content.Context
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * 内置 Termux 用户环境：从 APK assets 解压官方 Termux bootstrap（aarch64）到应用私有目录。
 *
 * bootstrap 顶层就是 PREFIX 内容（bin/lib/share/var），无需剥离目录；符号链接记录在
 * SYMLINKS.txt（`源→目标`），Termux 二进制使用系统 linker64，因此只要设置好
 * LD_LIBRARY_PATH=$PREFIX/lib 与 PATH=$PREFIX/bin 即可在任意私有目录运行。
 *
 * W^X 说明：本机 targetSdk=28，但仍按 NodeRuntime 的成熟实践把 bin/lib/share 设为
 * 不可写（可执行），避免厂商/系统 W^X 策略拦截；可写区域（home/tmp/var）保持可写，
 * apt/dpkg 安装时如需写 bin/lib 可调用 [setRuntimeWritable] 临时放开。
 */
object TermuxRuntime {

    private const val ASSET = "termux-bootstrap.zip"
    private const val MARKER = ".termux-ok"
    private const val DIR_NAME = "termux"

    /** APK asset 是否存在（构建时内置）。 */
    fun hasAsset(context: Context): Boolean = runCatching {
        context.assets.open(ASSET).close()
        true
    }.getOrDefault(false)

    fun isReady(context: Context): Boolean = File(context.filesDir, MARKER).exists()

    fun prefix(context: Context): File = File(context.filesDir, "$DIR_NAME/usr")

    fun home(context: Context): File = File(context.filesDir, "$DIR_NAME/home")

    fun tmp(context: Context): File = File(context.filesDir, "$DIR_NAME/tmp")

    fun bashPath(context: Context): File = File(prefix(context), "bin/bash")

    fun isBashReady(context: Context): Boolean = bashPath(context).isFile

    /** 返回在 bash 中 export 的 Termux 环境前缀。 */
    fun envPrefix(context: Context): String {
        val usr = prefix(context).absolutePath
        val home = home(context).absolutePath
        val tmp = tmp(context).absolutePath
        return "export PREFIX=$usr; export HOME=$home; export TMPDIR=$tmp; " +
            "export TERM=xterm-256color; export LANG=C.UTF-8; " +
            "export PATH=$usr/bin:$usr/bin/applets:$usr/local/bin:/system/bin:/bin; " +
            "export LD_LIBRARY_PATH=$usr/lib; unset LD_PRELOAD; "
    }

    /**
     * 解压并准备 Termux 环境（同步，可能耗时 10~60 秒）。
     * [progress] 在 UI/后台线程安全时由调用方决定如何显示。
     */
    @Synchronized
    fun ensureExtracted(context: Context, progress: (String) -> Unit = {}): File {
        if (isReady(context)) return prefix(context)
        val usr = prefix(context)
        progress("准备目录…")
        cleanupDir(usr)

        // assets 流不可 seek，先复制到 cache 再用 ZipFile 解压
        val cache = File(context.cacheDir, ASSET)
        try {
            context.assets.open(ASSET).use { ins ->
                cache.outputStream().use { ous -> ins.copyTo(ous) }
            }
            progress("已就绪压缩包 ${cache.length() / 1024 / 1024}MB，开始解压…")

            val symlinks = StringBuilder()
            var count = 0
            ZipFile(cache).use { zip ->
                val entries = zip.entries
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    var name = e.name.replace('\\', '/')
                    if (name.isBlank()) continue
                    if (name == "SYMLINKS.txt") {
                        symlinks.append(zip.getInputStream(e).readBytes().toString(Charsets.UTF_8))
                        continue
                    }
                    if (name.startsWith("/") || name.split('/').any { it == ".." }) continue
                    val out = File(usr, name)
                    if (e.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        zip.getInputStream(e).use { ins ->
                            out.outputStream().use { ous -> ins.copyTo(ous) }
                        }
                        if (name.startsWith("bin/") || name.startsWith("lib/")) {
                            out.setExecutable(true, false)
                        }
                    }
                    if (++count % 300 == 0) progress("解压中：$count 项…")
                }
            }
            progress("解压完成，创建符号链接…")
            applySymlinks(usr, symlinks.toString())
            patchApt(usr)

            // 可写业务目录：home / tmp / var（apt/dpkg 需要 var 可写）
            home(context).mkdirs()
            tmp(context).mkdirs()
            File(usr, "var").mkdirs()
            File(usr, "var/lib/dpkg").mkdirs()
            File(usr, "var/cache/apt").mkdirs()

            // W^X：bin/lib/share 只读可执行；var 保持可写
            makeUnwritable(File(usr, "bin"), File(usr, "bin"))
            makeUnwritable(File(usr, "lib"), File(usr, "lib"))
            makeUnwritable(File(usr, "share"), File(usr, "share"))

            File(context.filesDir, MARKER).writeText("ok")
            progress("Termux 环境就绪（$usr）")
            cache.delete()
            return usr
        } catch (t: Throwable) {
            runCatching { cache.delete() }
            runCatching { usr.deleteRecursively() }
            runCatching { File(context.filesDir, MARKER).delete() }
            throw t
        }
    }

    /**
     * 临时调整 bin/lib/share 是否可写。
     * W^X 目标下默认可执行但不可写；执行 apt/packages 安装前若工具链要求
     * 写入 bin/lib，可传 writable=true，装完再传 false 恢复。
     */
    fun setRuntimeWritable(context: Context, writable: Boolean) {
        val usr = prefix(context)
        setWritableRecursive(File(usr, "bin"), writable)
        setWritableRecursive(File(usr, "lib"), writable)
        setWritableRecursive(File(usr, "share"), writable)
    }

    // ---------------- 内部工具 ----------------

    private fun cleanupDir(dir: File) {
        if (!dir.exists()) return
        makeWritableRecursive(dir)
        dir.deleteRecursively()
        dir.mkdirs()
    }

    private fun applySymlinks(usr: File, content: String) {
        var ok = 0
        var skipped = 0
        var skippedReasons = mutableMapOf<String, Int>()
        for (line in content.lineSequence()) {
            val idx = line.indexOf('←')
            if (idx <= 0) continue
            // 官方格式：`目标 ← ./链接位置`
            // 例：libreadline.so.8 ← ./lib/libreadline.so
            //   => 创建 $PREFIX/lib/libreadline.so -> libreadline.so.8
            val targetRaw = line.substring(0, idx).trim()
            val linkRaw = line.substring(idx + 1).trim()
            val linkPath = resolvePrefixRelative(usr, linkRaw) ?: run { skipped++; continue }
            val linkFile = File(linkPath)
            linkFile.parentFile?.mkdirs()
            val target = if (targetRaw.startsWith("/data/data/com.termux/files/usr"))
                usr.absolutePath + "/" + targetRaw.removePrefix("/data/data/com.termux/files/usr").trimStart('/')
            else targetRaw
            try {
                if (linkFile.isDirectory && !java.nio.file.Files.isSymbolicLink(linkFile.toPath())) {
                    // 源路径与真实目录冲突：不能删除目录，跳过（dsh/node 下的目录不动）
                    skipped++
                    continue
                }
                // 对 dangling symlink 必须用 NIO deleteIfExists（File.exists() 对断链返回 false）
                java.nio.file.Files.deleteIfExists(linkFile.toPath())
                Files.createSymbolicLink(linkFile.toPath(), Paths.get(target))
                ok++
            } catch (t: Throwable) {
                skipped++
                val key = t.javaClass.simpleName + ": " + (t.message ?: "").take(80)
                skippedReasons[key] = (skippedReasons[key] ?: 0) + 1
            }
        }
        // 只打印少量原因，避免刷爆 logcat
        val top = skippedReasons.entries.sortedByDescending { it.value }.take(3)
        for ((reason, n) in top) android.util.Log.w("TermuxRuntime", "symlink skip x$n: $reason")
        android.util.Log.i("TermuxRuntime", "symlinks ok=$ok skipped=$skipped")
    }

    /**
     * 给 apt 生成 PREFIX 适配 wrapper：
     * 官方 apt 二进制把 `/data/data/com.termux/files/usr` 编译死，直接运行会去读其他
     * 应用的私有目录。这里把真二进制改为 apt.bin，用系统 sh 包一层，显式传入
     * 完整的 Dir/State/Cache 覆盖参数，使 apt 至少在 update/list/download 等
     * 不写 bin/lib 的操作上可用。安装包（写 bin/lib + 调 dpkg）留待后续补强。
     */
    private fun patchApt(usr: File) {
        try {
            val apt = File(usr, "bin/apt")
            val real = File(usr, "bin/apt.bin")
            if (!apt.isFile || real.exists()) return
            if (!apt.renameTo(real)) return
            val prefix = usr.absolutePath
            val script = "#!/system/bin/sh\n" +
                "export PREFIX=\"$prefix\"\n" +
                "export LD_LIBRARY_PATH=\"$prefix/lib\"\n" +
                "export PATH=\"$prefix/bin:$prefix/bin/applets:/system/bin:/bin\"\n" +
                "exec \"$prefix/bin/apt.bin\" \\\n" +
                "  -o Dir=\"$prefix\" \\\n" +
                "  -o Dir::Etc::parts=\"$prefix/etc/apt/apt.conf.d\" \\\n" +
                "  -o Dir::Etc::sourcelist=\"$prefix/etc/apt/sources.list\" \\\n" +
                "  -o Dir::Etc::sourceparts=\"$prefix/etc/apt/sources.list.d\" \\\n" +
                "  -o Dir::Etc::trustedparts=\"$prefix/etc/apt/trusted.gpg.d\" \\\n" +
                "  -o Dir::State::status=\"$prefix/var/lib/dpkg/status\" \\\n" +
                "  -o Dir::State::lists=\"$prefix/var/lib/apt/lists\" \\\n" +
                "  -o Dir::Cache::archives=\"$prefix/var/cache/apt/archives\" \\\n" +
                "  -o Dir::Cache::srcpkgcache=\"$prefix/var/cache/apt/srcpkgcache.bin\" \\\n" +
                "  -o Dir::Cache::pkgcache=\"$prefix/var/cache/apt/pkgcache.bin\" \\\n" +
                "  \"$@\"\n"
            apt.writeText(script)
            apt.setExecutable(true, false)
            android.util.Log.i("TermuxRuntime", "apt wrapper installed")
        } catch (t: Throwable) {
            android.util.Log.w("TermuxRuntime", "patchApt failed: ${t.message}")
        }
    }

    /** 把官方 `./路径` 或其它相对/绝对引用解析为 [usr] 下的绝对路径；无法解析返回 null。 */
    private fun resolvePrefixRelative(usr: File, raw: String): String? {
        var s = raw.trim()
        if (s.startsWith("./")) s = s.removePrefix("./")
        if (s.isBlank()) return null
        return when {
            s.startsWith("/data/data/com.termux/files/usr") ->
                usr.absolutePath + "/" + s.removePrefix("/data/data/com.termux/files/usr").trimStart('/')
            s.startsWith("/") -> usr.absolutePath + s
            else -> usr.absolutePath + "/" + s
        }
    }

    private fun stripPrefix(s: String): String = when {
        s.startsWith("/data/data/com.termux/files/usr/") -> s.removePrefix("/data/data/com.termux/files/usr/")
        s.startsWith("/data/data/com.termux/files/usr") -> s.removePrefix("/data/data/com.termux/files/usr").trimStart('/')
        s.startsWith("/") -> s.trimStart('/')
        else -> s
    }

    private fun makeUnwritable(base: File, current: File) {
        if (java.nio.file.Files.isSymbolicLink(current.toPath())) return
        if (current.isDirectory) {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
            current.listFiles()?.forEach { makeUnwritable(base, it) }
        } else {
            current.setReadable(true, false)
            current.setExecutable(true, false)
            current.setWritable(false, false)
        }
    }

    private fun makeWritableRecursive(f: File) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(true, false)
            f.listFiles()?.forEach { makeWritableRecursive(it) }
        } else {
            f.setWritable(true, false)
        }
    }

    private fun setWritableRecursive(f: File, writable: Boolean) {
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory) {
            f.setWritable(writable, false)
            f.listFiles()?.forEach { setWritableRecursive(it, writable) }
        } else {
            f.setWritable(writable, false)
        }
    }
}