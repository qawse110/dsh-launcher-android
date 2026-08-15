package com.dsh.launcher

import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.io.FileOutputStream

/**
 * ZIP 解压工具（基于 commons-compress 的 ZipFile，兼容 data descriptor）。
 *
 * 用途：把预置/下载的 deepseek-harness-master.zip 解压到应用私有目录。
 * GitHub 生成的 zip 顶层是 `<repo>-<branch>/` 目录，[stripTopDir] 默认剥离。
 */
object ZipUnpack {

    /**
     * 解压 zip 到 [destDir]。返回解压的文件/目录总数。
     * 防路径穿越：跳过包含 ".." 的条目；stripTopDir 时顶层目录名不校验。
     */
    fun unpack(zipFile: File, destDir: File, stripTopDir: Boolean = true): Int {
        var count = 0
        ZipFile(zipFile).use { zip ->
            val entries = zip.entries
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                var name = e.name.replace('\\', '/')
                if (stripTopDir) {
                    val slash = name.indexOf('/')
                    if (slash < 0) continue // 顶层文件（如 LICENSE）直接跳过
                    name = name.substring(slash + 1)
                }
                if (name.isBlank()) continue
                // 防路径穿越与绝对路径
                if (name.split('/').any { it == ".." } || name.startsWith("/")) continue
                val out = File(destDir, name)
                if (e.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    zip.getInputStream(e).use { input ->
                        FileOutputStream(out).use { output -> input.copyTo(output) }
                    }
                    count++
                }
            }
        }
        return count
    }
}