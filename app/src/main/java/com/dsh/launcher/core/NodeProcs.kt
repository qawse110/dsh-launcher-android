package com.dsh.launcher.core

import android.content.Context
import java.io.File

/**
 * 本应用 node 进程的枚举与终止（P0，实测缺陷修复）。
 *
 * **修复的缺陷**：此前 [DshFlow.killAllNode] 用
 * `ps -A | grep '[n]ode' | awk '{print $2}'` 取 PID。列序假设来自桌面版
 * procps（PID USER ...），而 Android 自带 toybox 的 `ps -A` 列序是
 * `PID TTY TIME CMD`——`$2` 命中的是 **TTY 列**，实际解析结果恒为 `?`。
 * 真机实证（`com.dsh.launcher`，Android toybox）：
 * ```
 * $ ps -A | grep '[n]ode'
 *   6310 ?        00:01:52 /data/user/0/com.dsh.launcher/files/node/bin/node
 * $ ps -A | grep '[n]ode' | awk '{print $2}'
 *   ?
 * $ ... | while read pid; do kill "$pid" 2>/dev/null; done   # 静默失败，退出码 0
 * ```
 * 后果是**终止链路全线静默失效**且难以察觉：残留 node 继续占用 3080 →
 * 「重启 dsh」因端口被占反复失败；`Proc` 安装类命令超时后 npm/pnpm 孙进程
 * 被孤儿化继续写 node_modules（与下一轮安装并发）。
 *
 * **替代方案**：直接读 `/proc/<pid>/cmdline`（NUL 分隔的 argv），按**可执行文件
 * 绝对路径**判定归属——不依赖任何 `ps` 输出格式、不依赖外部工具、不误伤同机
 * 其它 node（termux 侧、其它应用）。
 */
object NodeProcs {

    private const val TAG = "NodeProcs"

    /** 终止等待时限：SIGTERM 后等待，超时升级 SIGKILL。 */
    private const val TERM_WAIT_MS = 5_000L
    private const val KILL_WAIT_MS = 3_000L

    /** 本应用内置 node 可执行文件的绝对路径。 */
    fun nodeBin(ctx: Context): String =
        File(File(ctx.filesDir, "node/bin"), "node").absolutePath

    /**
     * 枚举本应用启动的 node 进程 PID（升序）。
     *
     * 归属判定见 [isOurNode]：只认 argv[0] 指向本应用 node/bin/node 的进程，
     * 因此不会误伤 termux 包管理器或其它应用拉起的 node。
     */
    fun pids(ctx: Context): List<Int> {
        val bin = nodeBin(ctx)
        val proc = File("/proc")
        val dirs = proc.listFiles() ?: return emptyList()
        val out = ArrayList<Int>(4)
        for (d in dirs) {
            val pid = d.name.toIntOrNull() ?: continue
            if (pid <= 0) continue
            val argv = readArgv(File(d, "cmdline")) ?: continue
            if (argv.isEmpty()) continue
            if (isOurNode(argv[0], bin)) out.add(pid)
        }
        out.sort()
        return out
    }

    /** 本应用是否已有 node 在运行（供启动等待做「进程死亡→提前失败」判定）。 */
    fun anyAlive(ctx: Context): Boolean = pids(ctx).isNotEmpty()

    /**
     * 终止本应用全部 node 进程：SIGTERM → 限时等待 → 存活的升级 SIGKILL。
     *
     * 幂等：无进程时为 no-op。返回是否**全部已退出**（调用方可据此判定清理是否成功，
     * 而不是像此前那样无论如何都当成功）。
     */
    fun killAll(ctx: Context, onLine: (String) -> Unit = {}): Boolean {
        val ctxApp = ctx.applicationContext
        val before = pids(ctxApp)
        if (before.isEmpty()) {
            AppLog.i(TAG, "killAll: no node process")
            return true
        }
        onLine(">> 终止 node 进程：${before.joinToString(", ")}")
        for (pid in before) sendSignal(ctxApp, pid, 15)
        if (awaitExit(ctxApp, before, TERM_WAIT_MS)) {
            AppLog.i(TAG, "node processes killed (SIGTERM): ${before.joinToString(", ")}")
            onLine("OK node 进程已退出（SIGTERM）")
            return true
        }
        // 存活者升级 SIGKILL：残留进程会占用 3080 导致重启失败
        val left = pids(ctxApp)
        if (left.isNotEmpty()) onLine(">> SIGTERM 未退出，升级 SIGKILL：${left.joinToString(", ")}")
        for (pid in left) sendSignal(ctxApp, pid, 9)
        val ok = awaitExit(ctxApp, left, KILL_WAIT_MS)
        if (ok) {
            AppLog.i(TAG, "node processes killed (SIGKILL): ${left.joinToString(", ")}")
            onLine("OK node 进程已退出（SIGKILL）")
        } else {
            val still = pids(ctxApp)
            AppLog.i(TAG, "node processes still alive: ${still.joinToString(", ")}")
            onLine("WARN 仍有 node 进程未退出：${still.joinToString(", ")}（可能需要重启应用）")
        }
        return ok
    }

    // ---------------- 内部 ----------------

    /**
     * 判定 argv0 是否指向本应用内置 node。
     *
     * 只接受两种形式：与 [binPath] **完全一致**，或本应用 filesDir 的
     * `/data/data/<pkg>` ↔ `/data/user/0/<pkg>` 别名等价形式（见 [dataAlias]）。
     * 刻意**不做**「以 `/node/bin/node` 结尾」这类宽松后缀匹配——那会把任意应用的
     * `.../node/bin/node` 都算作自己人，误杀无关进程。
     *
     * 也**不**接受裸 `node`：PATH 查找出的 node 可能来自 termux 或其它应用，
     * 误杀代价远高于漏杀。
     */
    internal fun isOurNode(argv0: String?, binPath: String): Boolean {
        if (argv0.isNullOrEmpty()) return false
        return argv0 == binPath || argv0 == dataAlias(binPath)
    }

    /**
     * `/data/user/0/<pkg>/...` ↔ `/data/data/<pkg>/...` 的别名互转。
     *
     * 两前缀在 Android 上指向同一目录（`/data/data` 是指向 `/data/user/0` 的软链）；
     * 进程 cmdline 里出现哪种写法取决于内核呈递方式，故两侧都要认。
     * 与参考实现坑 1「realpath 前缀混用」同源——路径比较必须双侧规范化。
     */
    internal fun dataAlias(path: String): String {
        val userScoped = "/data/user/0/"
        val dataScoped = "/data/data/"
        return when {
            path.startsWith(userScoped) -> dataScoped + path.removePrefix(userScoped)
            path.startsWith(dataScoped) -> userScoped + path.removePrefix(dataScoped)
            else -> path
        }
    }

    /**
     * 读取 `/proc/<pid>/cmdline` 并切分为 argv。
     * 失败（进程已退出、权限不足、内核线程空 cmdline）返回 null。
     */
    internal fun readArgv(cmdline: File): List<String>? = try {
        val bytes = cmdline.readBytes()
        if (bytes.isEmpty()) null
        else {
            val text = String(bytes, Charsets.UTF_8)
            // cmdline 参数以 NUL 分隔，末项后通常还有一个 NUL
            text.split('\u0000').filter { it.isNotEmpty() }
        }
    } catch (_: Throwable) {
        null
    }

    /**
     * 发送信号前**复核进程身份**：PID 可能已被回收给无关进程，
     * 直接下手会误杀。复核失败（进程已消失）视为已达成目的。
     */
    private fun sendSignal(ctx: Context, pid: Int, sig: Int) {
        val argv = readArgv(File("/proc/$pid/cmdline"))
        if (argv != null && argv.isNotEmpty() && !isOurNode(argv[0], nodeBin(ctx))) {
            AppLog.i(TAG, "skip pid $pid: no longer our node (pid reused)")
            return
        }
        runCatching { android.os.Process.sendSignal(pid, sig) }
            .onFailure { AppLog.i(TAG, "signal $sig -> $pid failed: ${it.message}") }
    }

    /** 轮询等待给定 PID 全部消失。 */
    private fun awaitExit(ctx: Context, pids: List<Int>, timeoutMs: Long): Boolean {
        if (pids.isEmpty()) return true
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val live = pids(ctx)
            if (live.isEmpty()) return true
            Thread.sleep(150)
        }
        return pids(ctx).isEmpty()
    }
}
