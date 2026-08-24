package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 内置 Termux 用户环境 —— 门面（facade）。
 *
 * 实际职责已按架构方案 P1-3 拆分：
 * - [BootstrapInstaller]：bootstrap 解压、短前缀/镜像符号链接、marker
 * - [PrefixPatcher]：官方硬编码路径的字节级/文本级 patch
 * - [ProfileWriter]：apt 配置、profile.d、inputrc、tpkg 生成
 * - [PackageKit]：harness 工具安装（pkg 优先 + tpkg 兜底）
 *
 * 本对象仅保留路径访问与对外 API 委托，调用方无需感知拆分。
 */
object TermuxRuntime {

    private const val DIR_NAME = "termux"

    fun isReady(context: Context): Boolean = BootstrapInstaller.isMarked(context)

    fun prefix(context: Context): File = File(context.filesDir, "$DIR_NAME/usr")

    fun home(context: Context): File = File(context.filesDir, "$DIR_NAME/home")

    fun tmp(context: Context): File = File(context.filesDir, "$DIR_NAME/tmp")

    fun bashPath(context: Context): File = File(prefix(context), "bin/bash")

    /** termux-exec 的 LD_PRELOAD 库路径；未安装返回 null（调用方据此决定是否注入环境）。 */
    fun ldPreloadPath(context: Context): String? =
        File(prefix(context), "lib/libtermux-exec-ld-preload.so")
            .takeIf { it.isFile }?.absolutePath

    fun isBashReady(context: Context): Boolean = bashPath(context).isFile

    /** Harness 附加工具（git/rg/file/curl/less）是否已安装就绪。 */
    fun harnessToolsReady(context: Context): Boolean = PackageKit.ready(context)

    /**
     * 解压并准备 Termux 环境（同步，可能耗时 10~60 秒）。
     * [progress] 在 UI/后台线程安全时由调用方决定如何显示。
     */
    @Synchronized
    fun ensureExtracted(context: Context, progress: (String) -> Unit = {}): File =
        BootstrapInstaller.ensure(context, progress)

    /** Harness 工具齐备性保障（pkg 优先 + tpkg 兜底），详见 [PackageKit]。 */
    @Synchronized
    fun ensureHarnessTools(context: Context, progress: (String) -> Unit = {}): Boolean =
        PackageKit.ensure(context, progress)

    /**
     * 调整 bin/lib/share 是否可写。v4.6 起默认保持可写；
     * 仅在需要临时收紧的场景显式传 writable=false 后自行恢复。
     */
    fun setRuntimeWritable(context: Context, writable: Boolean) =
        BootstrapInstaller.setRuntimeWritable(context, writable)
}
