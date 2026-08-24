package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 统一进程执行器（架构方案 P1-1）。
 *
 * 合并了原 DshFlow.exec 与 TermuxRuntime.runBash 两套同构的 ProcessBuilder 封装：
 * 流式输出消费、超时强杀（返回 -124）、W^X 自动放开、可写工作目录、环境注入
 * 全部在此单点实现。
 */
data class ProcSpec(
    val ctx: Context,
    /** 经 shell -c 执行的完整命令串。 */
    val command: String,
    /** shell 可执行文件；缺省内置 Termux bash（未就绪时自动准备，失败拒绝执行）。 */
    val shell: File? = null,
    /** 环境覆盖项：叠加在 [TermuxEnv.childShellEnv] 之上。 */
    val envOverrides: Map<String, String> = emptyMap(),
    /** 工作目录；缺省 termux home（应用默认 cwd=/ 不可写）。 */
    val workdir: File? = null,
    /** 超时秒数；到期强制结束并返回 -124。null = 不限时。 */
    val timeoutSec: Long? = null,
    /** 安装类命令（apt/pkg/dpkg install 形态）自动临时放开 W^X。 */
    val autoUnlockWxOnInstall: Boolean = false,
    val onLine: (String) -> Unit = {},
)

object Proc {

    private const val TAG_PROC = "Proc"
    private const val EXIT_TIMEOUT = -124

    fun run(s: ProcSpec): Int {
        AppLog.i(TAG_PROC, "cmd: ${s.command}")
        val shell = resolveShell(s)
        if (shell == null) {
            s.onLine("✗ 内置 Termux 不可用（v4.5 起仅支持 Termux 环境），命令未执行")
            return -1
        }
        val unlockWx = s.autoUnlockWxOnInstall && looksLikePackageInstall(s.command)
        if (unlockWx) {
            s.onLine(">> 检测到安装类命令：临时放开 bin/lib/share 写权限…")
            TermuxRuntime.setRuntimeWritable(s.ctx, true)
        }
        return try {
            val pb = ProcessBuilder(shell.absolutePath, "-c", s.command)
            pb.redirectErrorStream(true)
            pb.directory((s.workdir ?: TermuxRuntime.home(s.ctx)).apply { mkdirs() })
            val env = pb.environment()
            env.putAll(TermuxEnv.childShellEnv(s.ctx))
            env.putAll(s.envOverrides)
            // LD_PRELOAD 由 TermuxEnv 注入；这里不再无条件移除——
            // termux-exec 恰恰需要在 maintscript 执行期翻译 shebang
            val p = pb.start()
            // 输出在独立线程消费：waitFor(timeout) 期间管道持续排空，不会卡死子进程
            val stopped = java.util.concurrent.atomic.AtomicBoolean(false)
            val reader = Thread {
                try {
                    p.inputStream.bufferedReader().useLines { lines ->
                        for (line in lines) {
                            if (stopped.get()) break
                            s.onLine(line)
                        }
                    }
                } catch (_: Throwable) {
                }
            }.apply { isDaemon = true; start() }

            val done = s.timeoutSec?.let { p.waitFor(it, java.util.concurrent.TimeUnit.SECONDS) } ?: run {
                p.waitFor(); true
            }
            stopped.set(true)
            if (!done) {
                s.onLine("TIMEOUT: 命令超过 ${s.timeoutSec}s 未完成，强制结束")
                p.destroy()
                if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
                reader.join(2000)
                EXIT_TIMEOUT
            } else {
                reader.join(5000)
                p.exitValue().also { AppLog.i(TAG_PROC, "exit code: $it") }
            }
        } catch (e: Exception) {
            AppLog.e(TAG_PROC, "cmd failed: ${e.message ?: e.toString()}")
            s.onLine("[执行失败: ${e.message}]")
            -1
        }
    }

    /** 解析 shell：显式指定优先；否则确保内置 bash 就绪（幂等），失败返回 null。 */
    private fun resolveShell(s: ProcSpec): File? {
        s.shell?.let { return it.takeIf(File::isFile) }
        val bash = TermuxRuntime.bashPath(s.ctx)
        if (!bash.isFile) {
            s.onLine(">> 内置 Termux 未就绪，自动准备中（首次约 10~60 秒）…")
            runCatching { TermuxRuntime.ensureExtracted(s.ctx) { s.onLine(it) } }
        }
        return bash.takeIf { it.isFile }
    }

    /** 判断命令是否可能写入 bin/lib/share（apt/pkg/dpkg 安装类），用于自动放开 W^X。 */
    internal fun looksLikePackageInstall(raw: String): Boolean {
        val lc = raw.lowercase()
        return Regex("""\b(apt|apt-get|pkg)\b[^\n;&]*\b(install|reinstall|upgrade|dist-upgrade)\b""").containsMatchIn(lc) ||
            Regex("""\bdpkg\b[^\n;&]*\b(-i|--install)\b""").containsMatchIn(lc)
    }
}
