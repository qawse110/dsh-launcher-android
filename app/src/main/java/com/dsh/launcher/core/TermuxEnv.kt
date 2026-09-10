package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 子进程环境的唯一工厂（架构方案 P0-1）。
 *
 * 背景：PATH、LD_LIBRARY_PATH、HOME、TMPDIR 曾在 6 处独立拼接，并因此发生过两次真实漂移事故
 * （exec 分支漏拼 node/lib 导致 node 起不来；termux-exec 的 LD_PRELOAD 需多点注入易漏）。
 *
 * 约束（review-r4 收紧）：环境变量字面量只允许出现在本文件——
 * NodeRuntime.nodeEnvPrefix 已退役（其消费者改走本工厂注入的统一环境）。
 */
object TermuxEnv {

    /** termux-exec 的 LD_PRELOAD 注入项；未安装返回 null。 */
    fun ldPreload(ctx: Context): Pair<String, String>? =
        TermuxRuntime.ldPreloadPath(ctx)?.let { "LD_PRELOAD" to it }

    /** 内置 Node 的 lib 目录（在前，保证优先解析 node 自带 openssl/zlib）。 */
    fun nodeLibDir(ctx: Context): File = File(ctx.filesDir, "node/lib")

    /** 合并后的动态库搜索路径：node/lib → termux usr/lib 兜底。 */
    fun ldLibraryPath(ctx: Context): String {
        val usr = TermuxRuntime.prefix(ctx).absolutePath
        return listOf(nodeLibDir(ctx).absolutePath, "$usr/lib").joinToString(":")
    }

    /**
     * 标准子 shell 环境（DshFlow.exec 与 TermuxRuntime 侧共用基底）。
     *
     * @param home      覆盖 HOME（缺省 termux home；插件管理等需要 filesDir 时传入）
     * @param tmpDir    覆盖 TMPDIR（缺省 termux tmp）
     * @param extraPath 追加到 node/bin 之后、系统路径之前的目录
     */
    fun childShellEnv(
        ctx: Context,
        home: File? = null,
        tmpDir: File? = null,
        extraPath: List<String> = emptyList(),
    ): Map<String, String> {
        val usr = TermuxRuntime.prefix(ctx).absolutePath
        val path = listOf(
            "$usr/bin",
            "$usr/bin/applets",
            "$usr/local/bin",
            File(ctx.filesDir, "node/bin").absolutePath,
        ) + extraPath + listOf("/system/bin", "/bin", "/usr/bin")
        return buildMap {
            put("PREFIX", usr)
            put("PATH", path.joinToString(":"))
            put("HOME", (home ?: TermuxRuntime.home(ctx)).absolutePath)
            put("TERM", "xterm-256color")
            put("LANG", "C.UTF-8")
            put("LD_LIBRARY_PATH", ldLibraryPath(ctx))
            put("TMPDIR", (tmpDir ?: TermuxRuntime.tmp(ctx)).absolutePath)
            put("OPENSSL_CONF", "/dev/null")
            // SHELL 指向真实 bash（对齐参考实现 dsh-shell-termux 的 termuxEnv）：
            // npm/git/部分 configure 脚本会探测 SHELL；缺省时继承宿主 /bin/sh 造成歧义
            put("SHELL", TermuxRuntime.bashPath(ctx).absolutePath)
            ldPreload(ctx)?.let { (k, v) -> put(k, v) }
        }
    }

    /**
     * dsh web 进程的有序 export 集（供启动脚本模板渲染；顺序即输出顺序）。
     */
    fun webProcessExports(ctx: Context, nodeDir: File): List<Pair<String, String>> {
        val usr = TermuxRuntime.prefix(ctx).absolutePath
        return buildList {
            add("LD_LIBRARY_PATH" to "${nodeDir.absolutePath}/lib:$usr/lib")
            add("HOME" to ctx.filesDir.absolutePath)
            add("TMPDIR" to File(ctx.filesDir, "tmp").absolutePath)
            add("OPENSSL_CONF" to "/dev/null")
            add("TERM" to "xterm-256color")
            add("PREFIX" to usr)
            add("SHELL" to TermuxRuntime.bashPath(ctx).absolutePath)
            ldPreload(ctx)?.let { add(it) }
            add(
                "PATH" to listOf(
                    File(nodeDir, "bin").absolutePath,
                    "$usr/bin",
                    "$usr/bin/applets",
                    "$usr/local/bin",
                    File(ctx.filesDir, ".tools/bin").absolutePath,
                    "/system/bin", "/bin", "/usr/bin",
                ).joinToString(":")
            )
        }
    }

    /**
     * 内置终端 PTY 会话环境（TerminalSession 需要数组形态）。
     *
     * review-r4 单源化：此前与 [childShellEnv] 双套维护，PATH/OPENSSL_CONF/SHELL
     * 已实测漂移（终端侧缺 OPENSSL_CONF/SHELL、前缀路径硬编码绕过
     * [TermuxRuntime.prefix]）。现在以 childShellEnv 为唯一基底——TMPDIR=home、
     * PATH 追加 .tools/bin 保持既有终端行为，其余键与子 shell 完全一致。
     */
    fun terminalSessionEnv(ctx: Context): Array<String> {
        val home = TermuxRuntime.home(ctx).apply { mkdirs() }
        val base = childShellEnv(
            ctx,
            tmpDir = home,
            extraPath = listOf(File(ctx.filesDir, ".tools/bin").absolutePath),
        )
        return buildList {
            for ((k, v) in base) add("$k=$v")
            // 让 shell 的 cwd 与 HOME 一致，和主流终端行为保持一致
            add("PWD=${home.absolutePath}")
        }.toTypedArray()
    }
}
