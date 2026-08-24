package com.dsh.launcher.core

import android.content.Context
import android.content.Intent
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh 启动流程引擎（无 UI 依赖）。
 *
 * 从 ConsoleActivity 抽出，供两条入口复用同一份逻辑：
 * - 主界面自动启动流：首次启动 = 安装→启动→自动打开 WebUI；后续 = 启动→打开；
 * - 命令控制台手动触发（dsh / dsh_install / dsh_start extras）。
 *
 * 阶段（安装+启动全流程）：
 *   1) 确保内置 node 解压
 *   2) 复制 assets 内 install-dsh.mjs + prebuilt.tgz + extra-plugins（内置插件源）
 *   3) 官方 npm 安装/更新 @deepseek-ai/dsh，并用 `dsh plugin --profile web add` 装配内置插件
 *   4) 执行 stub-dsh.mjs（Android 兼容修复），后台启动 dsh web 并等待 HTTP 就绪
 *
 * 通过 onLog / onState / onDone 回调向调用方输出；busy 时幂等拒绝重复触发。
 *
 * v4.5 唯一环境：所有命令一律经内置 Termux bash 执行（完整 Linux 用户态），
 * 未就绪时自动准备、不再回退系统 sh；并为全部子进程指定可写工作目录，
 * 修复应用进程默认 cwd=/ 导致的相对路径 EACCES（「路径权限不足」的主要来源）。
 */
object DshFlow {

    enum class Mode { INSTALL_AND_START, INSTALL_ONLY, START_ONLY }

    private val busy = java.util.concurrent.atomic.AtomicBoolean(false)

    const val WEB_PORT = 3080

    /** 统一日志文件名（files/logs/ 下，见 [FileLog]）。 */
    const val FLOW_LOG = "flow.log"
    const val WEB_LOG = "web.log"

    fun dshCli(ctx: Context): File =
        File(File(ctx.filesDir, "dsh-prefix"), "node_modules/@deepseek-ai/dsh/lib/bin.js")

    /** dsh 是否已安装（官方 CLI 存在）。 */
    fun isInstalled(ctx: Context): Boolean = dshCli(ctx).exists()

    /** dsh web 是否已在运行（HTTP 真正可访问）。 */
    fun isWebUp(): Boolean = httpResponds(WEB_PORT)

    /**
     * 异步执行启动流程。同一时刻只允许一个流程（幂等）。
     * @param onLog   日志行（任意线程）
     * @param onState 阶段状态短语（任意线程，可空）
     * @param onDone  流程结束，参数=是否成功（任意线程，可空）
     */
    fun launch(
        context: Context,
        mode: Mode,
        onLog: (String) -> Unit,
        onState: ((String) -> Unit)? = null,
        onDone: ((Boolean) -> Unit)? = null,
        forceFullInstall: Boolean = false
    ) {
        val ctx = context.applicationContext
        if (!busy.compareAndSet(false, true)) {
            onLog(">> 已有启动流程在执行中，忽略本次触发")
            onDone?.invoke(false)
            return
        }
        thread {
            var ok = false
            try {
                ok = runFlow(ctx, mode, forceFullInstall, onLog, onState)
            } catch (t: Throwable) {
                AppLog.e("DshFlow", "flow failed: " + (t.message ?: t.toString()))
                onLog("FAIL: ${t.message}")
                onState?.invoke(if (mode == Mode.INSTALL_ONLY) "出错" else "启动失败")
            } finally {
                // 流程结束一次性导出流程日志到共享目录（替代旧的逐行 /sdcard 双写）
                FileLog.exportToShared(ctx, FLOW_LOG)
                busy.set(false)
                onDone?.invoke(ok)
            }
        }
    }

    /** 流程主体（阻塞，后台线程调用）。 */
    private fun runFlow(ctx: Context, mode: Mode, forceFullInstall: Boolean, onLog: (String) -> Unit, onState: ((String) -> Unit)?): Boolean {
        // 统一文件日志：files/logs/flow.log（可读时间戳 + 自动轮转）；
        // 共享目录改为流程结束时一次性导出，不再逐行双写 /sdcard
        FileLog.reset(ctx, FLOW_LOG)
        fun fl(msg: String) {
            FileLog.log(ctx, FLOW_LOG, msg)
            onLog(msg)
        }

        startKeepAlive(ctx)
        onState?.invoke(
            when (mode) {
                Mode.INSTALL_ONLY -> "安装/更新中…"
                Mode.START_ONLY -> "启动 dsh…"
                Mode.INSTALL_AND_START -> "启动 dsh 安装…"
            }
        )
        fl(
            when (mode) {
                Mode.INSTALL_ONLY -> ">> 安装/更新模式（完成后不启动 web）…"
                Mode.START_ONLY -> ">> 仅启动模式（跳过安装/装配）…"
                Mode.INSTALL_AND_START -> ">> 安装+启动模式…"
            }
        )

        val nodeDir = NodeRuntime.ensureExtracted(ctx)
        val apkVer = AssetSync.apkVersion(ctx)
        fl("OK 1/4 node=$nodeDir")
        val dshPrefix = File(ctx.filesDir, "dsh-prefix")

        // 仅启动模式：不安装，直接快速启动（要求已安装）
        if (mode == Mode.START_ONLY) {
            if (!isInstalled(ctx)) {
                fl("FAIL 尚未安装 dsh（${dshCli(ctx)} 不存在），请先执行安装")
                onState?.invoke("未安装")
                return false
            }
            return if (quickStartWeb(ctx, nodeDir, dshPrefix, ::fl)) {
                fl("OK 启动完成 (http://127.0.0.1:$WEB_PORT)")
                onState?.invoke("运行中")
                BuildKeepAliveService.updateRunning(ctx)
                ensureBridge(ctx)
                true
            } else {
                fl("FAIL 启动：dsh web 未就绪（见上方日志尾部）")
                onState?.invoke("启动失败")
                false
            }
        }

        // 安装+启动模式且 dsh 已安装：快速启动，跳过 npm 更新/插件装配/Termux 全量准备
        if (mode == Mode.INSTALL_AND_START && !forceFullInstall && isInstalled(ctx)) {
            fl(">> 快速启动：已安装 dsh v${DshUpdater.currentVersion(ctx)}，跳过 npm/插件装配…")
            return if (quickStartWeb(ctx, nodeDir, dshPrefix, ::fl)) {
                fl("OK 快速启动完成 (http://127.0.0.1:$WEB_PORT)")
                onState?.invoke("运行中")
                BuildKeepAliveService.updateRunning(ctx)
                ensureBridge(ctx)
                true
            } else {
                fl("FAIL 快速启动：dsh web 未就绪（见上方日志尾部）")
                onState?.invoke("启动失败")
                false
            }
        }

        fl(">> 1.5/4 准备内置 Termux（bash/coreutils + git/rg/file）…")
        try {
            TermuxRuntime.ensureExtracted(ctx) { msg -> fl(msg) }
            TermuxRuntime.ensureHarnessTools(ctx) { msg -> fl(msg) }
            fl("OK 1.5/4 termux ready (bash + git + ripgrep + file)")
        } catch (t: Throwable) {
            fl("WARN 1.5/4 termux prepare failed: ${t.message}（继续 dsh 安装，dsh bash 工具可能不可用）")
        }
        fl("dsh 版本 v${DshUpdater.currentVersion(ctx)}")
        // 安装/更新统一交给 install-dsh.mjs 的 `npm install @deepseek-ai/dsh@latest`；
        val pluginsDir = File(ctx.filesDir, "plugins")

        fl(">> 2/4 复制官方安装脚本与内置插件源…")
        val installScript = File(ctx.filesDir, "install-dsh.mjs")
        try {
            ctx.assets.open("install-dsh.mjs").use { input ->
                installScript.outputStream().use { output -> input.copyTo(output) }
            }
        } catch (t: Throwable) {
            fl("FAIL 2/4 assets copy install-dsh.mjs: ${t.message}")
            onState?.invoke("出错")
            return false
        }
        val prebuilt = File(ctx.filesDir, "prebuilt.tgz")
        val prebuiltMarker = File(ctx.filesDir, ".prebuilt-ok")
        if (AssetSync.isSynced(prebuiltMarker, prebuilt, apkVer)) {
            fl("  内置插件源已是最新，跳过复制")
        } else if (AssetSync.copyAsset(ctx, "prebuilt.tgz", prebuilt)) {
            AssetSync.markSynced(prebuiltMarker, apkVer)
            fl("  内置插件源 ${prebuilt.length() / 1024 / 1024}MB")
        } else {
            fl("  WARN assets 无 prebuilt.tgz，继续使用已有插件源")
        }
        val extraPluginsDir = File(ctx.filesDir, "extra-plugins")
        val extraMarker = File(ctx.filesDir, ".extra-plugins-ok")
        if (AssetSync.isSynced(extraMarker, extraPluginsDir, apkVer)) {
            fl("  额外桥接插件源已是最新，跳过复制")
        } else {
            try {
                if (AssetSync.copyAssetDir(ctx, "extra-plugins", extraPluginsDir, clearFirst = true)) {
                    AssetSync.markSynced(extraMarker, apkVer)
                    val count = extraPluginsDir.walkTopDown().count { it.isFile }
                    fl("  额外桥接插件源 $count 个文件")
                    if (count == 0) fl("  WARN extra-plugins 复制后 0 个文件（assets 可能为空）")
                } else {
                    fl("  WARN assets 无 extra-plugins")
                }
            } catch (t: Throwable) {
                fl("  WARN assets 无 extra-plugins：${t.message}")
            }
        }

        fl(">> 3/4 官方 npm 安装/更新 dsh + dsh plugin 装配内置插件…")
        val tag = ctx.getSharedPreferences("dsh_console", Context.MODE_PRIVATE)
            .getString("dsh_install_tag", "latest") ?: "latest"
        val installEnv = mapOf(
            "HOME" to ctx.filesDir.absolutePath,
            "NODE_BIN" to "$nodeDir/bin/node",
            "NPM_BIN" to "$nodeDir/bin/npm",
            "DSH_PREFIX" to dshPrefix.absolutePath,
            "DSH_PROFILE" to "web",
            "DSH_PREBUILT" to prebuilt.absolutePath,
            "DSH_PLUGINS_DIR" to pluginsDir.absolutePath,
            "DSH_EXTRA_PLUGINS_SRC" to extraPluginsDir.absolutePath,
            "DSH_TAG" to tag,
            "DSH_APK_VER" to apkVer.toString()
        )
        if (tag != "latest") fl("  （安装 dist-tag=$tag 预发布线）")
        val installExit = exec(ctx, "$nodeDir/bin/node ${installScript.absolutePath}", installEnv) { fl(it) }
        // 一次性安装 tag 已消费（无论成败），复位避免残留 next 影响下次普通安装
        ctx.getSharedPreferences("dsh_console", Context.MODE_PRIVATE)
            .edit().remove("dsh_install_tag").apply()
        if (installExit != 0) {
            fl("FAIL 3/4 install script exit=$installExit，详见 install_log.txt")
            onState?.invoke("出错")
            return false
        }
        if (!dshCli(ctx).exists()) {
            fl("FAIL 3/4 官方 dsh CLI 未安装到 $dshPrefix")
            onState?.invoke("出错")
            return false
        }
        fl("OK 3/4 dsh + builtin plugins installed")

        fl(">> 3.5/4 Android 兼容修复…")
        val stubScript = File(ctx.filesDir, "stub-dsh.mjs")
        try {
            ctx.assets.open("stub-dsh.mjs").use { input ->
                stubScript.outputStream().use { output -> input.copyTo(output) }
            }
        } catch (t: Throwable) {
            fl("FAIL 3.5/4 assets copy stub-dsh.mjs: ${t.message}")
        }
        // SELinux 禁止 app 对 data 文件硬链接；dsh session 首次落盘用 link()。
        // 通过 Node loader 把 node:fs/promises 的 link 重定向为 rename 兼容实现。
        for (name in listOf("fs-register.mjs", "fs-loader.mjs", "fs-promises-compat.mjs")) {
            try {
                ctx.assets.open(name).use { input ->
                    File(ctx.filesDir, name).outputStream().use { output -> input.copyTo(output) }
                }
            } catch (t: Throwable) {
                fl("WARN assets copy $name: ${t.message}")
            }
        }
        runAndroidStubOnce(ctx, nodeDir, dshPrefix, stubScript, ::fl)

        // 仅安装/更新模式：到此结束，不启动 web（不置 running，watchdog 不会拉起）
        if (mode == Mode.INSTALL_ONLY) {
            fl("OK 安装/更新完成（未启动 web，可随时一键启动）")
            onState?.invoke("安装完成")
            startKeepAlive(ctx)
            return true
        }

        fl(">> 4/4 校验 dsh web…")
        return if (startDshWeb(ctx, nodeDir, dshPrefix, ::fl)) {
            fl("OK 4/4 dsh web started (http://127.0.0.1:$WEB_PORT)")
            onState?.invoke("运行中")
            BuildKeepAliveService.updateRunning(ctx)
            ensureBridge(ctx)
            true
        } else {
            fl("FAIL 4/4 dsh web 启动失败（见上方日志尾部）")
            onState?.invoke("出错")
            false
        }
    }

    /** 前台服务保活，防止长时间 build 被系统回收。 */
    fun startKeepAlive(ctx: Context) {
        try {
            val i = Intent(ctx, BuildKeepAliveService::class.java)
            if (android.os.Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            AppLog.i("DshFlow", "keepalive started")
        } catch (t: Throwable) {
            AppLog.e("DshFlow", "keepalive start failed: ${t.message}")
        }
    }

    /** dsh 启动成功后联动拉起状态桥接服务（悬浮窗自动出现；尊重「悬浮窗显示」开关）。 */
    fun ensureBridge(ctx: Context) {
        if (!ctx.getSharedPreferences("status_bridge", Context.MODE_PRIVATE)
                .getBoolean("overlay_enabled", true)
        ) return
        runCatching { StatusBridgeService.start(ctx) }
            .onSuccess { AppLog.i("DshFlow", "bridge started for overlay") }
            .onFailure { AppLog.e("DshFlow", "bridge start failed: ${it.message}") }
    }

    /** 快速启动：同步兼容脚本（fs-register/fs-loader/fs-promises/stub）→ 执行 stub → 启动 web。 */
    private fun quickStartWeb(ctx: Context, nodeDir: File, dshPrefix: File, fl: (String) -> Unit): Boolean {
        for (name in listOf("fs-register.mjs", "fs-loader.mjs", "fs-promises-compat.mjs", "stub-dsh.mjs")) {
            val target = File(ctx.filesDir, name)
            try {
                ctx.assets.open(name).use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                }
            } catch (t: Throwable) {
                fl("WARN copy $name: ${t.message}")
            }
        }
        val stubScript = File(ctx.filesDir, "stub-dsh.mjs")
        if (stubScript.exists()) {
            runAndroidStubOnce(ctx, nodeDir, dshPrefix, stubScript, fl)
        } else {
            fl("WARN 未找到 stub-dsh.mjs，继续尝试启动 web")
        }
        fl(">> 启动 dsh web…")
        return startDshWeb(ctx, nodeDir, dshPrefix, fl)
    }

    /**
     * Android 兼容修复（stub-dsh.mjs）按版本只跑一次：
     * marker 记录「APK 版本 + dsh 版本」，两者都没变则跳过（省 2~5 秒启动时间）。
     */
    private fun runAndroidStubOnce(ctx: Context, nodeDir: File, dshPrefix: File, stubScript: File, fl: (String) -> Unit) {
        val apkVer = AssetSync.apkVersion(ctx)
        val expected = "apk:$apkVer|dsh:${DshUpdater.currentVersion(ctx)}"
        val marker = File(ctx.filesDir, ".stub-applied")
        if (marker.exists() && marker.readText().trim() == expected) {
            fl(">> Android 兼容修复已应用（$expected），跳过 stub")
            return
        }
        val exit = exec(
            ctx, "$nodeDir/bin/node ${stubScript.absolutePath}",
            mapOf(
                "HOME" to ctx.filesDir.absolutePath,
                "NODE_DIR" to nodeDir.absolutePath,
                "DSH_PREFIX" to dshPrefix.absolutePath,
                "DSH_PROFILE" to "web",
                "DSH_APK_VER" to apkVer.toString()
            )
        ) { fl(it) }
        if (exit == 0) {
            runCatching { marker.writeText(expected) }
        } else {
            fl("WARN stub-dsh 退出码 $exit（不写 marker，下次重跑）")
        }
    }

    /** 后台启动 dsh web 并等待 HTTP 就绪。端口已有监听但无响应时清场重启（幂等但不再盲信）。 */
    private fun startDshWeb(ctx: Context, nodeDir: File, dshPrefix: File, onLog: (String) -> Unit): Boolean {
        val cli = dshCli(ctx)
        if (!cli.exists()) {
            onLog("✗ 未找到官方 dsh CLI（安装可能未完成）")
            return false
        }
        // v4.5 唯一环境：内置 Termux —— 未就绪时先准备（已就绪零开销），失败即中止
        if (!TermuxRuntime.isBashReady(ctx)) {
            onLog(">> 内置 Termux 未就绪，自动准备中（首次约 10~60 秒）…")
            try {
                TermuxRuntime.ensureExtracted(ctx) { onLog(it) }
            } catch (t: Throwable) {
                onLog("✗ 内置 Termux 准备失败（v4.5 起不再回退系统 sh）：${t.message}")
                return false
            }
        }
        // 幂等：3080 已有监听 → 只有 HTTP 真正响应才算已启动；
        // 残留（端口被占但 web 不响应）视为脏状态，先清理再重启。
        // v4.4.1 起额外校验「环境代次」：nohup 拉起的 web 是孤儿进程，可跨 APK
        // 更新存活。旧脚本（v4.4 前）不带 cd，其进程 cwd=/ 且永远不会自愈，
        // 直接复用会让新环境永不生效 —— 检测到旧代进程则清理后按新脚本重启。
        if (isPortListening(WEB_PORT)) {
            val reused = waitForWebReady(ctx, 5_000, onLog)
            if (reused && isCurrentGenWebProcess(ctx)) {
                onLog(">> dsh web 已在运行 (http://127.0.0.1:$WEB_PORT)")
                return true
            }
            onLog(
                if (reused) ">> 检测到旧环境代的 web 进程（cwd≠HOME），清理后迁移重启…"
                else ">> 端口 $WEB_PORT 被残留进程占用但 web 无响应，清理后重新启动…"
            )
            killAllNode(ctx, onLog)
            Thread.sleep(1500)
        }
        // 生成启动脚本，由内置 Termux bash 后台执行
        File(ctx.filesDir, "tmp").mkdirs()
        val launcher = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "dsh-web.sh")
        launcher.parentFile?.mkdirs()
        val termuxUsr = TermuxRuntime.prefix(ctx).absolutePath
        val termuxPath = "$termuxUsr/bin:$termuxUsr/bin/applets:$termuxUsr/local/bin:"
        val ldLibrary = "${nodeDir.absolutePath}/lib:$termuxUsr/lib"
        val nodeCmd = "${nodeDir.absolutePath}/bin/node --expose-internals --import ${ctx.filesDir.absolutePath}/fs-register.mjs ${cli.absolutePath} web"
        launcher.writeText(
            // shebang 仅作文档用途：脚本实际由内置 Termux bash 显式解释执行
            "#!/data/user/0/com.dsh.launcher/t/usr/bin/bash\n" +
            "export LD_LIBRARY_PATH=$ldLibrary\n" +
            "export HOME=${ctx.filesDir.absolutePath}\n" +
            "export TMPDIR=${ctx.filesDir.absolutePath}/tmp\n" +
            "export OPENSSL_CONF=/dev/null\n" +
            "export TERM=xterm-256color\n" +
            "export PREFIX=$termuxUsr\n" +
            // termux-exec：运行时翻译脚本 shebang 官方前缀（存在才注入）
            (TermuxRuntime.ldPreloadPath(ctx)?.let { "export LD_PRELOAD=$it\n" } ?: "") +
            "export PATH=${nodeDir.absolutePath}/bin:${termuxPath}${File(ctx.filesDir, ".tools").absolutePath}/bin:/system/bin:/bin:/usr/bin\n" +
            // 应用进程默认 cwd=/（不可写）：web 进程及其 bash 子命令的相对路径操作会
            // EACCES，显式 cd 到可写 HOME（dsh 状态目录 files/.dsh 也在这里）
            "cd \"${ctx.filesDir.absolutePath}\" || exit 1\n" +
            // Termux bash 必带 nohup，直接后台化
            "nohup $nodeCmd > ${FileLog.dir(ctx).absolutePath}/$WEB_LOG 2>&1 &\n" +
            "echo DSH_WEB_PID=$!\n"
        )
        launcher.setExecutable(true)
        // v4.5：唯一解释器为内置 Termux bash
        exec(ctx, "${TermuxRuntime.bashPath(ctx).absolutePath} ${launcher.absolutePath}") { onLog(it) }
        onLog(">> dsh web 已后台启动，等待 web 就绪（http://127.0.0.1:$WEB_PORT）…")
        return waitForWebReady(ctx, 90_000, onLog)
    }

    /**
     * 3080 端口上的 node web 进程是否由当前代启动脚本拉起。
     * 判据：进程 cmdline 匹配 dsh CLI 的 `…bin.js web`（或开发态 bin.ts），且
     * cwd == HOME(filesDir)——新脚本显式 cd；v4.4 前的旧进程继承应用默认 cwd=/。
     * 探测失败保守返回 true（视为当前代），避免误杀正常进程。
     */
    private fun isCurrentGenWebProcess(ctx: Context): Boolean = try {
        val home = ctx.filesDir.absolutePath
        var found = false
        var current = false
        File("/proc").listFiles { f -> f.name.toIntOrNull() != null }?.forEach { p ->
            if (found) return@forEach
            val args = runCatching {
                File(p, "cmdline").readBytes().toString(Charsets.UTF_8).split('\u0000').filter { it.isNotBlank() }
            }.getOrDefault(emptyList())
            val isDshWeb = args.isNotEmpty() &&
                args.any { it.endsWith("@deepseek-ai/dsh/lib/bin.js") || it.endsWith("/bin.ts") } &&
                args.last() == "web"
            if (isDshWeb) {
                found = true
                val cwd = runCatching {
                    java.nio.file.Files.readSymbolicLink(java.nio.file.Paths.get(p.absolutePath, "cwd")).toString()
                }.getOrDefault("")
                current = cwd == home
            }
        }
        !found || current
    } catch (t: Throwable) {
        true
    }

    /** 检测本机端口是否已有监听（用于幂等启动）。 */
    fun isPortListening(port: Int): Boolean = try {
        java.net.ServerSocket().use { s ->
            s.reuseAddress = false
            s.bind(java.net.InetSocketAddress("127.0.0.1", port))
            false
        }
    } catch (e: java.io.IOException) {
        true
    }

    /** 轮询等待 dsh web 的 HTTP 真正可访问，超时后打印 web 日志尾部。
     *  前 6 秒每 150ms 探测一次（node 冷启动通常 1~3s，尽快感知就绪），之后放宽到 500ms。 */
    private fun waitForWebReady(ctx: Context, timeoutMs: Long, onLog: (String) -> Unit): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastLog = 0L
        while (System.currentTimeMillis() < deadline) {
            if (httpResponds(WEB_PORT)) return true
            val now = System.currentTimeMillis()
            if (now - lastLog >= 5000) {
                lastLog = now
                onLog("   等待 dsh web 就绪…（剩余 ${(deadline - now) / 1000}s）")
            }
            val elapsed = timeoutMs - (deadline - now)
            Thread.sleep(if (elapsed < 6_000) 150 else 500)
        }
        onLog("✗ dsh web 未在 ${timeoutMs / 1000} 秒内就绪，日志尾部：")
        appendLogTail(File(FileLog.dir(ctx), WEB_LOG), 25, onLog)
        return false
    }

    fun httpResponds(port: Int): Boolean = try {
        val conn = URL("http://127.0.0.1:$port/").openConnection() as HttpURLConnection
        conn.connectTimeout = 800
        conn.readTimeout = 800
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..399
    } catch (e: Exception) {
        false
    }

    private fun appendLogTail(file: File, maxLines: Int, onLog: (String) -> Unit) {
        try {
            if (!file.exists()) {
                onLog("   （无日志文件：${file.path}）")
                return
            }
            val lines = file.readText().trim().lines()
            val tail = if (lines.size > maxLines) lines.takeLast(maxLines) else lines
            for (line in tail) onLog("   | $line")
        } catch (t: Throwable) {
            onLog("   （读取日志失败：${t.message}）")
        }
    }

    /** 杀掉全部 node 进程（web 与 flow 子进程一并结束），供更新后重启。 */
    fun killAllNode(ctx: Context, onLine: (String) -> Unit = {}) {
        runCatching {
            // 用 [n]ode 避免 grep 匹配到自身；不用 xargs -r，兼容 Android toybox
            val pb = ProcessBuilder(
                "/system/bin/sh", "-c",
                "ps -A | grep '[n]ode' | awk '{print \$2}' | while read pid; do kill \"\$pid\" 2>/dev/null; done"
            )
            pb.redirectErrorStream(true)
            val p = pb.start()
            p.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    onLine(line)
                    AppLog.i("DshFlow", line)
                }
            }
            p.waitFor()
            AppLog.i("DshFlow", "node processes killed")
        }
    }

    /**
     * 同步执行命令（阻塞直到结束），返回退出码；输出通过 onLine 实时回调。
     * v4.5 起唯一执行环境为内置 Termux bash：bash 未就绪时自动准备
     * （幂等，已就绪零开销），准备失败直接报错、不再回退系统 sh。
     * 安装类命令临时放开 W^X。
     */
    fun exec(
        ctx: Context,
        raw: String,
        extraEnv: Map<String, String> = emptyMap(),
        onLine: (String) -> Unit = {}
    ): Int {
        AppLog.i("DshFlow", "cmd: $raw")
        val bash = TermuxRuntime.bashPath(ctx)
        if (!bash.isFile) {
            onLine(">> 内置 Termux 未就绪，自动准备中（首次约 10~60 秒）…")
            runCatching { TermuxRuntime.ensureExtracted(ctx) { onLine(it) } }
        }
        if (!bash.isFile) {
            AppLog.e("DshFlow", "termux unavailable, reject cmd")
            onLine("✗ 内置 Termux 不可用（v4.5 起仅支持 Termux 环境），命令未执行")
            return -1
        }
        val wantsWrite = looksLikePackageInstall(raw)
        return try {
            if (wantsWrite) {
                onLine(">> 检测到安装类命令：临时放开 bin/lib/share 写权限…")
                TermuxRuntime.setRuntimeWritable(ctx, true)
            }
            val pb = ProcessBuilder(bash.absolutePath, "-c", raw)
            pb.redirectErrorStream(true)
            // 可写工作目录：应用进程默认 cwd=/ 不可写，相对路径读写会 EACCES
            pb.directory(TermuxRuntime.home(ctx).apply { mkdirs() })
            val env = pb.environment()
            val usr = TermuxRuntime.prefix(ctx).absolutePath
            env["PREFIX"] = usr
            env["PATH"] = listOf(
                "$usr/bin", "$usr/bin/applets", "$usr/local/bin",
                File(ctx.filesDir, "node/bin").absolutePath,
                "/system/bin", "/bin", "/usr/bin"
            ).joinToString(":")
            env["HOME"] = TermuxRuntime.home(ctx).absolutePath
            env["TERM"] = "xterm-256color"
            env["LANG"] = "C.UTF-8"
            // 内置 node 也可能经此执行：LD_LIBRARY_PATH 必须含 node/lib（在前，
            // 保证 node 优先解析自带的 openssl/zlib），termux usr/lib 兜底
            env["LD_LIBRARY_PATH"] = listOf(
                File(ctx.filesDir, "node/lib").absolutePath,
                "$usr/lib"
            ).joinToString(":")
            env["TMPDIR"] = TermuxRuntime.tmp(ctx).absolutePath
            // termux-exec：运行时翻译脚本 shebang 官方前缀（postinst / pip 入口依赖）
            TermuxRuntime.ldPreloadPath(ctx)?.let { env["LD_PRELOAD"] = it }
            env["OPENSSL_CONF"] = "/dev/null"
            extraEnv.forEach { (k, v) -> env[k] = v }

            val proc = pb.start()
            // 实时逐行回调
            proc.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    onLine(line)
                    AppLog.i("DshFlowOut", line)
                }
            }
            val exit = proc.waitFor()
            AppLog.i("DshFlow", "exit code: $exit")
            exit
        } catch (e: Exception) {
            AppLog.e("DshFlow", "cmd failed: " + (e.message ?: e.toString()))
            onLine("[执行失败: ${e.message}]")
            -1
        } finally {
            if (wantsWrite) {
                runCatching { TermuxRuntime.setRuntimeWritable(ctx, false) }
                onLine(">> 安装命令结束，已恢复 bin/lib/share 只读（W^X 保护）")
            }
        }
    }

    /** 判断命令是否可能写入 bin/lib/share（apt/pkg/dpkg 安装类），用于临时放开 W^X。 */
    private fun looksLikePackageInstall(raw: String): Boolean {
        val lc = raw.lowercase()
        return Regex("""\b(apt|apt-get|pkg)\b[^\n;&]*\b(install|reinstall|upgrade|dist-upgrade)\b""").containsMatchIn(lc) ||
            Regex("""\bdpkg\b[^\n;&]*\b(-i|--install)\b""").containsMatchIn(lc)
    }
}
