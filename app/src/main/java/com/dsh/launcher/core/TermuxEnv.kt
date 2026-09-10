package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 子进程环境的唯一工厂（架构方案 P0-1）。
 *
 * ## 为什么必须集中
 *
 * PATH、LD_LIBRARY_PATH、HOME、TMPDIR 曾在 **6 处**独立拼接，造成两次真实漂移事故
 * （exec 分支漏拼 `node/lib` 导致 node 起不来；termux-exec 的 `LD_PRELOAD`
 * 多点注入易漏）。
 *
 * ## 本版结构（review-r10 整理）
 *
 * 三个消费方曾各写一份「几乎相同」的环境，共享 7 个键却各自维护：
 *
 * | 键 | 子 shell | web 进程 | 终端 PTY |
 * |---|---|---|---|
 * | PREFIX / LD_LIBRARY_PATH / OPENSSL_CONF / TERM / SHELL / LD_PRELOAD | 共享 | 共享 | 共享 |
 * | LANG | `C.UTF-8` | **遗漏**（真机实测 web 进程无 LANG） | `C.UTF-8` |
 * | PATH / HOME / TMPDIR | 按场景不同 | 按场景不同 | 按场景不同 |
 *
 * 现收敛为**一个内部构造器** [build]：共享键只写一次，差异全部走显式参数。
 * 三个公开函数只剩「投影成调用方需要的形状」这一件事。
 *
 * ## 约束
 *
 * 环境变量字面量只允许出现在本文件——`NodeRuntime.nodeEnvPrefix` 已退役，
 * 其消费者改走本工厂注入的统一环境。
 */
object TermuxEnv {

    /** 共享键：所有子进程环境都必须一致的取值。 */
    private const val TERM_VALUE = "xterm-256color"
    private const val LANG_VALUE = "C.UTF-8"
    private const val OPENSSL_CONF_VALUE = "/dev/null"

    /** 系统路径兜底（toybox 等）。 */
    private val SYSTEM_PATH = listOf("/system/bin", "/bin", "/usr/bin")

    /** termux-exec 的 LD_PRELOAD 注入项；未安装返回 null。 */
    fun ldPreload(ctx: Context): Pair<String, String>? =
        TermuxRuntime.ldPreloadPath(ctx)?.let { "LD_PRELOAD" to it }

    /** 内置 Node 的 lib 目录（在前，保证优先解析 node 自带 openssl/zlib）。 */
    private fun nodeLibDir(ctx: Context): File = File(ctx.filesDir, "node/lib")

    /** 全局工具目录（pnpm 等，由 install-dsh 安装）。 */
    private fun toolsBinDir(ctx: Context): File = File(ctx.filesDir, ".tools/bin")

    /** 合并后的动态库搜索路径：node/lib → termux usr/lib 兜底。 */
    private fun ldLibraryPath(ctx: Context): String = ldLibraryPath(ctx, nodeLibDir(ctx))

    /**
     * 同 [ldLibraryPath]，但 node 的 lib 目录显式给出。
     *
     * 需要这个重载是因为 [webProcessExports] 的 `nodeDir` 由调用方传入
     * （`NodeRuntime.ensureExtracted` 的返回值）——若在这里回退到
     * `filesDir/node/lib` 硬编码推导，两个来源一旦不一致就会出现
     * 「PATH 指向 A 的 node、LD 指向 B 的 lib」这种极难排查的组合。
     */
    private fun ldLibraryPath(ctx: Context, nodeLib: File): String {
        val usr = TermuxRuntime.prefix(ctx).absolutePath
        return listOf(nodeLib.absolutePath, "$usr/lib").joinToString(":")
    }

    /**
     * 唯一的环境构造器：先放**共享键**，再按参数放**场景键**。
     *
     * 返回 `LinkedHashMap` 保证迭代顺序稳定——[webProcessExports] 把顺序直接渲染成
     * 启动脚本的 `export` 行序，顺序变化会让生成脚本产生无意义的 diff。
     *
     * @param home    HOME 取值
     * @param tmpDir  TMPDIR 取值
     * @param nodeDir 内置 node 的父目录（`<nodeDir>/bin`、`<nodeDir>/lib`）；
     *   null 表示不参与 PATH/LD_LIBRARY_PATH
     * @param extraPath 追加进 PATH 的目录（插在系统路径之前）
     * @param nodePathFirst true = `<nodeDir>/bin` 排在 `usr/bin` **之前**
     *   （web 进程：必须保证 `node`/`npm` 解析到内置版本，而不受 usr/bin 影响）；
     *   false = 排在之后（子 shell：Termux 工具优先，node 只作补充）
     */
    private fun build(
        ctx: Context,
        home: File,
        tmpDir: File,
        nodeDir: File?,
        extraPath: List<String> = emptyList(),
        nodePathFirst: Boolean = false,
    ): Map<String, String> {
        val usr = TermuxRuntime.prefix(ctx).absolutePath
        val nodeBin = nodeDir?.let { File(it, "bin").absolutePath }
        val termuxPath = listOf("$usr/bin", "$usr/bin/applets", "$usr/local/bin")

        val path = buildList {
            if (nodePathFirst && nodeBin != null) add(nodeBin)
            addAll(termuxPath)
            if (!nodePathFirst && nodeBin != null) add(nodeBin)
            addAll(extraPath)
            addAll(SYSTEM_PATH)
        }

        return linkedMapOf(
            // ---- 共享键（三处消费方取值必须一致）----
            "PREFIX" to usr,
            // LD 的 node/lib 与 PATH 的 node/bin 取自**同一个 nodeDir**，
            // 避免出现「PATH 指向 A 的 node、LD 指向 B 的 lib」这种组合
            "LD_LIBRARY_PATH" to (nodeDir?.let { ldLibraryPath(ctx, File(it, "lib")) } ?: ldLibraryPath(ctx)),
            "OPENSSL_CONF" to OPENSSL_CONF_VALUE,
            "TERM" to TERM_VALUE,
            // LANG 曾只在 childShellEnv 设置 → 真机实测 web 进程缺 LANG，
            // 影响工具的中文/UTF-8 输出判定。共享键化后不再可能漏。
            "LANG" to LANG_VALUE,
            // SHELL 指向真实 bash（对齐参考实现 dsh-shell-termux 的 termuxEnv）：
            // npm/git/部分 configure 脚本会探测 SHELL；缺省时继承宿主 /bin/sh 造成歧义
            "SHELL" to TermuxRuntime.bashPath(ctx).absolutePath,
            // ---- 场景键 ----
            "PATH" to path.joinToString(":"),
            "HOME" to home.absolutePath,
            "TMPDIR" to tmpDir.absolutePath,
        ).apply {
            ldPreload(ctx)?.let { (k, v) -> put(k, v) }
        }
    }

    /**
     * 标准子 shell 环境（[Proc] 与终端侧共用基底）。
     *
     * @param home      覆盖 HOME（缺省 termux home；插件管理等需要 filesDir 时传入）
     * @param tmpDir    覆盖 TMPDIR（缺省 termux tmp）
     * @param extraPath 追加到系统路径之前的目录
     */
    fun childShellEnv(
        ctx: Context,
        home: File? = null,
        tmpDir: File? = null,
        extraPath: List<String> = emptyList(),
    ): Map<String, String> = build(
        ctx = ctx,
        home = home ?: TermuxRuntime.home(ctx),
        tmpDir = tmpDir ?: TermuxRuntime.tmp(ctx),
        nodeDir = File(ctx.filesDir, "node"),
        extraPath = extraPath,
    )

    /**
     * dsh web 进程的有序 export 集（供启动脚本模板渲染；顺序即输出顺序）。
     *
     * 与 [childShellEnv] 的差异是**刻意的**，且已在本函数内显式表达：
     * - `HOME`/`TMPDIR` 指向 `filesDir`（dsh 的 `.dsh` 状态目录在那里）
     * - `node/bin` 在最前（保证 `node`/`npm` 解析到内置版本）
     * - `.tools/bin` 在 PATH 内（web 进程要用 pnpm 等工具）
     */
    fun webProcessExports(ctx: Context, nodeDir: File): List<Pair<String, String>> =
        build(
            ctx = ctx,
            home = ctx.filesDir,
            tmpDir = File(ctx.filesDir, "tmp"),
            nodeDir = nodeDir,
            extraPath = listOf(toolsBinDir(ctx).absolutePath),
            nodePathFirst = true,
        ).toList()

    /**
     * 内置终端 PTY 会话环境（TerminalSession 需要数组形态）。
     *
     * review-r4 单源化：此前与 [childShellEnv] 双套维护，PATH/OPENSSL_CONF/SHELL
     * 已实测漂移（终端侧缺 OPENSSL_CONF/SHELL、前缀路径硬编码绕过
     * [TermuxRuntime.prefix]）。现在以 `childShellEnv` 为唯一基底——`TMPDIR=home`、
     * PATH 追加 `.tools/bin` 保持既有终端行为，其余键与之完全一致。
     */
    fun terminalSessionEnv(ctx: Context): Array<String> {
        val home = TermuxRuntime.home(ctx).apply { mkdirs() }
        val base = childShellEnv(
            ctx,
            tmpDir = home,
            extraPath = listOf(toolsBinDir(ctx).absolutePath),
        )
        return buildList {
            for ((k, v) in base) add("$k=$v")
            // 让 shell 的 cwd 与 HOME 一致，和主流终端行为保持一致
            add("PWD=${home.absolutePath}")
        }.toTypedArray()
    }
}
