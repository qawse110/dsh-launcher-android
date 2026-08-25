package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * Harness 包管理套件：确保内置 Termux 具备 dsh 与终端所需工具
 * （git / ripgrep / file / curl / less / wget / termux-exec）。
 *
 * 安装链路：原生 pkg 优先（W^X 放开 + termux-exec + instdir/镜像已就绪），
 * 失败自动兜底 [ProfileWriter.writeTpkgScript] 的 tpkg 手动解包。
 *
 * 架构方案 P1-3：由 [TermuxRuntime] 门面委托。
 */
internal object PackageKit {

    private const val TOOLS_MARKER_VERSION = "4"

    /** Harness 附加工具是否已安装就绪。 */
    fun ready(context: Context): Boolean =
        MarkerStore.get(context, "harness-tools") == TOOLS_MARKER_VERSION

    /**
     * 确保工具齐备；一次 pkg 调用补齐缺失项，失败走 tpkg 兜底；
     * 网络不可用或安装失败时返回 false，不破坏已有 Termux 环境。
     */
    @Synchronized
    fun ensure(context: Context, progress: (String) -> Unit = {}): Boolean {
        try {
            val usr = TermuxRuntime.prefix(context)
            if (!TermuxRuntime.isBashReady(context)) return false
            // 每次调用都刷新 profile/inputrc/tpkg（幂等），保证交互式终端体验即时生效
            // （tpkg 刷新兜底：真机 fresh 安装出现过 local/bin 单点缺失，此处保证补齐）
            ProfileWriter.writeLinuxProfile(usr)
            ProfileWriter.writeInputRc(usr)
            ProfileWriter.writeTpkgScript(context, usr)
            if (ready(context)) return true
            val bash = TermuxRuntime.bashPath(context).absolutePath
            // 环境基底统一由 Proc → TermuxEnv 提供，此处不再本地拼接（P0-1/P1-1）
            val env = emptyMap<String, String>()
            progress("检查 Harness 工具（git / ripgrep / file / curl / less）…")
            val requiredCheck = "command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 && command -v rg >/dev/null 2>&1 && rg --version >/dev/null 2>&1 && command -v file >/dev/null 2>&1 && file --version >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && curl --version >/dev/null 2>&1 && command -v less >/dev/null 2>&1 && less --version >/dev/null 2>&1"
            if (runBash(context, bash, requiredCheck, env, progress, timeoutSec = 120) == 0) {
                MarkerStore.put(context, "harness-tools", TOOLS_MARKER_VERSION)
                progress("Harness 工具已就绪（git / ripgrep / file / curl / less）")
                return true
            }
            progress("补齐 Harness 工具（git / ripgrep / file / curl / less / wget / termux-exec，单次 pkg 完成）…")
            // v4.6：默认放开 W^X 且不再恢复 —— dpkg 解包/postinst/pip 均需可写前缀；
            // 这里同时兜底升级设备上遗留的只读状态
            BootstrapInstaller.setRuntimeWritable(context, true)
            try {
                val missing = buildList {
                    if (!File(usr, "bin/git").isFile) add("git")
                    if (!File(usr, "bin/rg").isFile) add("ripgrep")
                    if (!File(usr, "bin/file").isFile) add("file")
                    if (!File(usr, "bin/curl").isFile) add("curl")
                    if (!File(usr, "bin/less").isFile) add("less")
                    if (!File(usr, "bin/wget").isFile) add("wget")
                    if (!File(usr, "bin/termux-open").isFile) add("termux-tools")
                    // 运行时翻译脚本 shebang 的官方前缀（postinst/pip 入口依赖）
                    if (!File(usr, "lib/libtermux-exec-ld-preload.so").isFile) add("termux-exec")
                }
                // P2-5 增量 patch 基线：安装窗口开始时间。之后所有新落盘文件
                // （pkg/tpkg/apt-get -f）mtime 必然 >= 该值，patch 只扫这些文件
                val patchBaseline = System.currentTimeMillis()
                val installRc = if (missing.isNotEmpty()) {
                    runBash(context, bash, "pkg install -o Acquire::Retries=3 -y --no-install-recommends ${missing.joinToString(" ")}", env, progress, timeoutSec = 1200)
                } else {
                    0
                }
                if (installRc != 0) {
                    // dpkg 解包在搬迁前缀下可能失败（官方 deb 路径写死 com.termux），
                    // 自动兜底走 tpkg 手动解包（dpkg-deb -x + status 同步 + shebang 修正）
                    progress("WARN: pkg install 返回 $installRc，尝试 tpkg 手动解包兜底…")
                    ProfileWriter.writeTpkgScript(context, usr)
                    runBash(
                        context, bash,
                        "\"$usr/local/bin/tpkg\" install ${missing.joinToString(" ")}",
                        env, progress, timeoutSec = 1200
                    )
                }

                // 新装的包（二进制 + maintainer 脚本）仍带官方路径；统一增量 patch
                // （只扫基线之后的新文件），再让 dpkg 重新 configure。
                progress("适配新装包路径并完成 dpkg 配置（增量 patch）…")
                PrefixPatcher.patchAll(usr, patchBaseline)
                PrefixPatcher.patchTextOfficialDirs(usr, patchBaseline)
                MarkerStore.put(context, "prefix-patch-ts", System.currentTimeMillis().toString())
                val cfgRc = runBash(context, bash, "dpkg --configure -a", env, progress, timeoutSec = 600)
                if (cfgRc != 0) {
                    progress("WARN: dpkg --configure -a 返回 $cfgRc，再试 apt-get -f install…")
                    runBash(context, bash, "apt-get install -o Acquire::Retries=3 -y -f --no-install-recommends", env, progress, timeoutSec = 1200)
                }

                val readyNow = runBash(context, bash, requiredCheck, env, progress, timeoutSec = 120) == 0
                val extra = buildList {
                    add("git"); add("ripgrep"); add("file"); add("curl"); add("less")
                    if (File(usr, "bin/wget").isFile) add("wget")
                }.joinToString(" + ")
                if (readyNow) {
                    MarkerStore.put(context, "harness-tools", TOOLS_MARKER_VERSION)
                    progress("Harness 工具就绪（$extra）")
                } else {
                    progress("WARN: Harness 工具未完全就绪（$extra），保留 marker 下次重试")
                }
                return readyNow
            } finally {
                // v4.6：保持可写（不再恢复只读），原因见 BootstrapInstaller 内 W^X 注释
                BootstrapInstaller.setRuntimeWritable(context, true)
            }
        } catch (t: Throwable) {
            progress("WARN: ensureHarnessTools 失败: ${t.message}")
            return false
        }
    }

    /**
     * 执行 bash 命令并流式回传输出（委托统一执行器 [Proc]）。
     * [timeoutSec] 到期后强制结束进程并返回 -124。
     */
    private fun runBash(
        context: Context,
        bash: String,
        script: String,
        env: Map<String, String>,
        progress: (String) -> Unit,
        timeoutSec: Long = 900L,
    ): Int = Proc.run(
        ProcSpec(
            ctx = context,
            command = script,
            shell = File(bash),
            envOverrides = env,
            workdir = env["HOME"]?.let(::File),
            timeoutSec = timeoutSec,
            onLine = progress,
        )
    )
}
