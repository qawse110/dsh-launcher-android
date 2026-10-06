package com.dsh.nextapp1.core

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

    /**
     * 「裸环境 git 可用」冒烟检查（不依赖任何外部注入的 `GIT_*` 变量）。
     *
     * 这正是用户在终端里直接敲 git 时的状态，也是本缺陷最初的表现面：
     * - `git --exec-path` 只打印路径、**即使目录不存在也返回 0**，光看它检测不出问题；
     * - 必须再断言 `$(git --exec-path)` 真的是个目录（官方前缀 `/data/data/com.termux/...`
     *   在本环境根本不存在），并跑一条读取类命令确认不再报 gitconfig 权限错误。
     *
     * 真机实测：未修时本检查失败（`test -d` 为假），修好后三项全过。
     */
    private const val GIT_BARE_ENV_CHECK =
        "command -v git >/dev/null 2>&1 && test -d \"${'$'}(git --exec-path)\" && git config --list >/dev/null 2>&1"

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

            // 存量设备自愈（不重装、不解压）：v4.9.x 的 mtime 增量 patch 漏改了
            // apt 装的 git/rg/wget 等（deb 载荷保留包内旧时间戳被误判为「旧文件」），
            // 导致裸终端 git 直接不可用。这里在工具就绪判定之前先补一次，
            // 否则 ready() 为 true 会直接短路返回、缺口永远留着。
            if (!BootstrapInstaller.ensurePrefixPatched(context, progress)) {
                progress("WARN: 内置 Termux 路径适配仍有残留，git 等工具可能异常")
            }

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
                    // 运行时翻译脚本 shebang 的官方前缀（postinst/pip 入口依赖）
                    if (!File(usr, "lib/libtermux-exec-ld-preload.so").isFile) add("termux-exec")
                }
                // P2-5 的 mtime 增量基线已移除：apt/dpkg 解包保留 deb 包内原始 mtime，
                // 任何「包内时间戳早于安装窗口」的载荷都会被误判为旧文件而漏 patch
                // （真机实测 git/rg/wget 全中招）。全树扫描实测仅 ~0.6s/128MB，
                // 用这点开销换「不可能漏改」是划算的。见 PrefixPatcher 类注释。
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

                // 新装的包（二进制 + maintainer 脚本）仍带官方路径；全量 patch 并审计。
                progress("适配新装包路径（全量 patch + 审计）…")
                val outcome = PrefixPatcher.patchEverything(usr)
                val audit = outcome.audit
                if (audit.clean) {
                    MarkerStore.put(context, "prefix-patch-rev", BootstrapInstaller.PATCH_REVISION)
                    progress(
                        "路径适配通过审计：重写 ${outcome.binary.patched} 个二进制 / " +
                            "${outcome.text.patched} 个文本文件（扫描 ${audit.scanned} 个文件）"
                    )
                } else {
                    // 宁可显式失败也不要静默放过：残留会让裸环境工具链半死不活
                    progress(
                        "WARN: 路径适配审计未通过，仍有 ${audit.mustFix.size} 个核心前缀残留 + " +
                            "${audit.textFixNeeded.size} 个文本残留（示例：${
                                audit.mustFix.take(3).joinToString { it.path }
                            }）"
                    )
                }
                val cfgRc = runBash(context, bash, "dpkg --configure -a", env, progress, timeoutSec = 600)
                if (cfgRc != 0) {
                    progress("WARN: dpkg --configure -a 返回 $cfgRc，再试 apt-get -f install…")
                    runBash(context, bash, "apt-get install -o Acquire::Retries=3 -y -f --no-install-recommends", env, progress, timeoutSec = 1200)
                }

                val readyNow = runBash(context, bash, requiredCheck, env, progress, timeoutSec = 120) == 0 &&
                    runBash(context, bash, GIT_BARE_ENV_CHECK, env, progress, timeoutSec = 60) == 0
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
