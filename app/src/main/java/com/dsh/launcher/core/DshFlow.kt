package com.dsh.launcher.core

import android.content.Context
import android.content.Intent
import java.io.File
import kotlin.concurrent.thread
// 显式单名导入（review-r12 收窄）：本文件只需要 service 层的这两个类型。
// 原先是 5 个包的全通配符导入，掩盖了真实依赖，也让 core 层看起来依赖 ui 层。
import com.dsh.launcher.service.BuildKeepAliveService
import com.dsh.launcher.service.StatusBridgeService

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

    /** 是否有启动/安装流程正在执行（崩溃循环回滚判定用它避免抢跑）。 */
    fun isBusy(): Boolean = busy.get()

    const val WEB_PORT = 3080

    /**
     * 重启时杀进程后的等待时长（ms）。语义是**给内核释放监听套接字的保险余量**，
     * 不是「等 node 退出」——[NodeProcs.killAll] 返回时进程已全部退出。
     * 三处调用方曾各自硬编码 1200 / 1500 / 0，现统一到此（见 [restart]）。
     */
    const val RESTART_SETTLE_MS = 1500L

    /** dsh 本体钉死版本：普通安装始终装这个精确版本（仅回滚流程经 dsh_install_tag 覆盖）。 */
    const val PINNED_DSH_TAG = "0.1.1-rc.1"

    /** 统一日志文件名（files/logs/ 下，见 [FileLog]）。 */
    const val FLOW_LOG = "flow.log"
    const val WEB_LOG = "web.log"

    /** web 启动脚本模板（assets 内，@TOKENS@ 由 [TermuxEnv] 渲染）。 */
    /** web 启动脚本模板资产名。 */
    internal const val WEB_LAUNCHER_TPL = "web-launcher.sh.tpl"

    /** stub 脚本名（安装与快速启动两条路径共用）。 */
    internal const val STUB_SCRIPT = "stub-dsh.mjs"

    /** node 的 ESM loader 注册脚本：web 启动命令经 `--import` 直接引用它。 */
    internal const val FS_REGISTER_SCRIPT = "fs-register.mjs"

    /**
     * 引导期脚本的唯一清单——**必须覆盖 web 启动命令引用到的每个 files 级脚本**。
     *
     * 真机回归（2026-09-10，review-r12）：`abae4ff` 把安装路径的三件套拷贝循环换成
     * 「只同步 patched/」的函数时**没有把这三个文件移交出去**——安装路径此后不再供给
     * `fs-register.mjs`，而 [startDshWeb] 的 node 命令仍硬引用它，于是首次安装
     * （或 watchdog 崩溃回滚的 forceFullInstall 重装）会以 `ERR_MODULE_NOT_FOUND`
     * 硬失败（node 对缺失的 `--import` 是 exit=1，不是降级）。
     * 当时全仓仅 [quickStartWeb] 与 `MainActivity.syncAssetsOnApkUpdate` 会写这三个
     * 文件，而后者因 versionCode 钉死已永久不执行。
     *
     * **结构性约束**：新增任何被启动命令引用的引导脚本，必须同时加进本清单——
     * `tools/check-boot-assets.cjs` 会从 [startDshWeb] 的命令串反解 `--import` 目标
     * 并断言它在 [BOOT_SCRIPTS] 内、且对应 asset 真实存在。清单与命令不再能各自漂移。
     */
    internal val BOOT_SCRIPTS = listOf(
        FS_REGISTER_SCRIPT,
        "fs-loader.mjs",
        "fs-promises-compat.mjs",
        STUB_SCRIPT,
    )

    /**
     * 模板资产读取失败时的兜底内联模板。
     *
     * **单源约定**：本常量与 `assets/web-launcher.sh.tpl` 是同一契约的两份拷贝——
     * 必须含完全相同的占位符集合（`@EXPORTS@`/`@HOME@`/`@NODE_CMD@`/`@LOG_FILE@`），
     * 否则资产缺失退回兜底时会静默渲染出缺配脚本（如漏 export → 引擎起不来）。
     * 由 `LauncherTemplateTest` 逐令牌比对锁定。
     */
    internal val DEFAULT_WEB_LAUNCHER_TPL = """
        #!/data/user/0/com.dsh.launcher/t/bin/bash
        @EXPORTS@
        cd "@HOME@" || exit 1
        nohup @NODE_CMD@ > "@LOG_FILE@" 2>&1 &
        echo DSH_WEB_PID=${'$'}!
        """.trimIndent()

    /** 启动脚本模板的全部占位符（顺序即替换顺序）。 */
    internal val WEB_LAUNCHER_TOKENS = listOf("@EXPORTS@", "@HOME@", "@NODE_CMD@", "@LOG_FILE@")

    /**
     * 渲染 web 启动脚本（纯函数，便于单测）。
     *
     * **为什么独立成函数**：模板渲染是纯字符串 `replace`，与模板内容强耦合。
     * 真机踩坑（2026-09-10）：模板第 3 行注释里写了「可用占位符：@EXPORTS@ …」
     * 作为说明，渲染时**注释里的占位符被一并展开**，生成了一条真实执行的杂散命令
     * （` <home> <nodeCmd> <logFile>`，bash 报 `Is a directory`，exit=126）。
     * 脚本没有 `set -e` 才侥幸继续跑到真正的 nohup，功能表现正常——
     * 典型的「靠巧合工作」，模板注释一改就可能真炸。
     */
    internal fun renderWebLauncher(
        tpl: String,
        exports: String,
        home: String,
        nodeCmd: String,
        logFile: String,
    ): String = tpl
        .replace("@EXPORTS@", exports)
        .replace("@HOME@", home)
        .replace("@NODE_CMD@", nodeCmd)
        .replace("@LOG_FILE@", logFile)

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

    /**
     * 重启 dsh web 的唯一入口（review-r12 统一）。
     *
     * ## 为什么必须集中
     *
     * 「杀 node → 等一会 → 快速启动」这套动作此前在**三处各写一份、常量还不一样**：
     *
     * | 位置 | 等待 |
     * |---|---|
     * | `ConsoleActivity` 的「重启服务」 | `Thread.sleep(1200)` |
     * | `PluginManagerActivity.restartFlow` | `Thread.sleep(1500)` |
     * | `MainActivity.confirmRollback` | 无等待 |
     *
     * 而 [killAllNode] 返回时 node **已经全部退出**（SIGTERM → 限时等待 → SIGKILL 升级，
     * 见 [NodeProcs.killAll]），所以那三个 sleep 都不是同步手段，只是来源不明的魔数。
     * 后果是同一个用户动作在不同页面有不同成功率（端口处于 TIME_WAIT 时 1200ms 更易撞
     * `address already in use`），且行为无法单点调整。
     *
     * 这里收敛为一个函数：等待时长由 [RESTART_SETTLE_MS] 单点定义，语义是**纯保险**
     * （给内核 TCP 栈释放监听套接字留余量），而非「等 node 退出」。
     *
     * @param onLog 日志回调（任意线程）
     * @param onDone 启动流程结束后回调（任意线程）
     */
    fun restart(
        context: Context,
        onLog: (String) -> Unit,
        onState: ((String) -> Unit)? = null,
        onDone: ((Boolean) -> Unit)? = null,
    ) {
        val ctx = context.applicationContext
        thread {
            onLog(">> 重启 dsh 服务（快速启动，不做安装）…")
            killAllNode(ctx, onLog)
            // 保险等待：killAllNode 已保证进程退出，这里只是给内核释放监听端口留余量
            runCatching { Thread.sleep(RESTART_SETTLE_MS) }
            // 主线程投递用 Handler(Looper.getMainLooper())（API 1 起可用）。
            // **不要用 Context.getMainExecutor()**——那是 API 28+，而本仓 minSdk = 24，
            // 在 24~27 上会 NoSuchMethodError（本仓是为对齐 Termux SELinux 域而压低
            // targetSdk 的，minSdk 24 是真实支持下限）。
            // 旧的两处调用点用的是 Activity.runOnUiThread；此处刻意不依赖 Activity
            // （DshFlow 无 UI 依赖），且 launch() 内部会立刻再起自己的后台线程。
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                launch(
                    ctx, Mode.START_ONLY,
                    onLog = onLog,
                    onState = onState,
                    onDone = onDone,
                )
            }
        }
    }

    /** 流程主体（阻塞，后台线程调用）。 */
    private fun runFlow(ctx: Context, mode: Mode, forceFullInstall: Boolean, onLog: (String) -> Unit, onState: ((String) -> Unit)?): Boolean {
        // 统一文件日志：files/logs/flow.log（可读时间戳 + 自动轮转）；
        // 共享目录改为流程结束时一次性导出，不再逐行双写 /sdcard
        FileLog.reset(ctx, FLOW_LOG)
        // 资产清理：v4.7 前散落在 files 根的旧日志（新位置见 FileLog）
        runCatching { File(ctx.filesDir, "dsh-flow.log").delete() }
        runCatching { File(ctx.filesDir, "dsh-web.log").delete() }
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
                DshUpdater.noteSuccessfulBoot(ctx, ::fl)
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
                DshUpdater.noteSuccessfulBoot(ctx, ::fl)
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
        // 安装/更新统一交给 install-dsh.mjs（按钉死精确版本安装 @deepseek-ai/dsh）；
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
        if (AssetSync.isSynced(ctx, "prebuilt", prebuilt, apkVer)) {
            fl("  内置插件源已是最新，跳过复制")
        } else if (AssetSync.copyAsset(ctx, "prebuilt.tgz", prebuilt)) {
            AssetSync.markSyncedWithFingerprint(ctx, "prebuilt", prebuilt, apkVer)
            fl("  内置插件源 ${prebuilt.length() / 1024 / 1024}MB")
        } else {
            fl("  WARN assets 无 prebuilt.tgz，继续使用已有插件源")
        }
        val extraPluginsDir = File(ctx.filesDir, "extra-plugins")
        if (AssetSync.isSynced(ctx, "extra-plugins", extraPluginsDir, apkVer)) {
            fl("  额外桥接插件源已是最新，跳过复制")
        } else {
            try {
                if (AssetSync.copyAssetDir(ctx, "extra-plugins", extraPluginsDir, clearFirst = true)) {
                    AssetSync.markSyncedWithFingerprint(ctx, "extra-plugins", extraPluginsDir, apkVer)
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

        // —— 3/4~4/4 安装 + 启动（临时更新保护：异常时自动回滚一次，最多两轮）——
        // 第一轮按钉死版本正常安装；
        // 若安装失败或 web 启动失败且处于临时更新窗口 → 自动置 tag=上一版本重装一次。
        var attempt = 0
        while (attempt < 2) {
            attempt++
            // dsh 本体版本钉死为 PINNED_DSH_TAG；dsh_install_tag 仅由回滚流程写入
            // （精确旧版本号）。旧版本遗留的 latest/next 一律按钉死版本处理。
            val tag = ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
                .getString("dsh_install_tag", null)
                ?.takeIf { it != "latest" && it != "next" }
                ?: PINNED_DSH_TAG
            // 回滚重装（tag=精确旧版本）显式跳过基线记录：此时要回到的就是基线本身，
            // 记录会把它覆盖成回滚目标——此前行为正确只是靠 afterInstall 的 cur==prev
            // 分支兜底，这里把语义显式化。
            // 注意：钉死版本也是精确版本，但它不是回滚 attempt。
            val isRollbackAttempt = tag != PINNED_DSH_TAG
            if (isRollbackAttempt) {
                fl("  回滚重装 attempt：保持原基线，不重新记录")
            } else {
                // 走到这里必然执行 npm 安装 → 版本可能变化 → 记录回滚基线。
                // （自动回滚重装中被 auto-rolled 守卫跳过；未变化时 afterInstall 会撤销）
                DshUpdater.recordRollbackBaselineIfChanging(ctx, true, ::fl)
            }

            fl(">> 3/4 官方 npm 安装/更新 dsh + dsh plugin 装配内置插件…")
            if (tag == PINNED_DSH_TAG) fl("  （dsh 版本钉死：$tag）")
            else fl("  （回滚重装目标：v$tag）")
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
            val installExit = exec(ctx, "$nodeDir/bin/node ${installScript.absolutePath}", installEnv) { fl(it) }
            // 一次性安装 tag 已消费（无论成败），复位避免残留影响下次普通安装
            ctx.getSharedPreferences(AppState.Prefs.CONSOLE, Context.MODE_PRIVATE)
                .edit().remove("dsh_install_tag").apply()
            if (installExit != 0 || !dshCli(ctx).exists()) {
                fl("FAIL 3/4 install exit=$installExit / CLI missing，详见 install_log.txt")
                if (DshUpdater.maybeAutoRollback(ctx, ::fl)) continue
                onState?.invoke("出错")
                return false
            }
            DshUpdater.afterInstall(ctx, ::fl)
            fl("OK 3/4 dsh + builtin plugins installed")

            fl(">> 3.5/4 Android 兼容修复…")
            // 引导期脚本 + 补丁载荷：与快速启动路径共用同一入口（唯一供给点，见 BOOT_SCRIPTS）。
            // 原先此处的三件套拷贝循环在 abae4ff 被误删，是 review-r12 的 P0 回归。
            if (!syncBootAssets(ctx, ::fl)) {
                fl("  WARN 引导期资产未全部同步，dsh 启动可能失败（见上方 WARN）")
            }
            val stubScript = File(ctx.filesDir, STUB_SCRIPT)
            if (stubScript.isFile) {
                // stub 标记含 dsh 版本：回滚重装后版本变化会自动重新打补丁
                runAndroidStubOnce(ctx, nodeDir, dshPrefix, stubScript, ::fl)
            } else {
                // 与 quickStartWeb 对齐：文件不在就别 spawn node（旧实现会 exec 一个不存在的
                // 路径，白等一次进程启动并留下 exit=1 的噪音日志）。补丁缺失是真实故障，
                // 但**不该**在这里 return false——dsh 本体已装好，仍应继续尝试启动 web。
                fl("WARN $STUB_SCRIPT 缺失，跳过 Android 兼容修复（部分补丁不会生效）")
            }

            // 仅安装/更新模式：到此结束，不启动 web（不置 running，watchdog 不会拉起）
            if (mode == Mode.INSTALL_ONLY) {
                fl("OK 安装/更新完成（未启动 web，可随时一键启动）")
                onState?.invoke("安装完成")
                startKeepAlive(ctx)
                return true
            }

            fl(">> 4/4 校验 dsh web…")
            if (startDshWeb(ctx, nodeDir, dshPrefix, ::fl)) {
                fl("OK 4/4 dsh web started (http://127.0.0.1:$WEB_PORT)")
                DshUpdater.noteSuccessfulBoot(ctx, ::fl)
                onState?.invoke("运行中")
                BuildKeepAliveService.updateRunning(ctx)
                ensureBridge(ctx)
                return true
            }
            fl("FAIL 4/4 dsh web 启动失败（见上方日志尾部）")
            if (DshUpdater.maybeAutoRollback(ctx, ::fl)) continue
            onState?.invoke("出错")
            return false
        }
        fl("FAIL 安装/启动连续失败且自动回滚未生效，请手动回滚或查看控制台日志")
        onState?.invoke("出错")
        return false
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
        if (!ctx.getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)
                .getBoolean("overlay_enabled", true)
        ) return
        runCatching { StatusBridgeService.start(ctx) }
            .onSuccess { AppLog.i("DshFlow", "bridge started for overlay") }
            .onFailure { AppLog.e("DshFlow", "bridge start failed: ${it.message}") }
    }

    /** 快速启动：同步引导期脚本与载荷 → 执行 stub → 启动 web。 */
    private fun quickStartWeb(ctx: Context, nodeDir: File, dshPrefix: File, fl: (String) -> Unit): Boolean {
        syncBootAssets(ctx, fl)
        val stubScript = File(ctx.filesDir, STUB_SCRIPT)
        if (stubScript.isFile) {
            runAndroidStubOnce(ctx, nodeDir, dshPrefix, stubScript, fl)
        } else {
            fl("WARN 未找到 $STUB_SCRIPT，继续尝试启动 web")
        }
        fl(">> 启动 dsh web…")
        return startDshWeb(ctx, nodeDir, dshPrefix, fl)
    }

    /**
     * 同步「引导期脚本 + 补丁载荷」到 files——**安装路径与快速启动路径共用的唯一入口**。
     *
     * 两部分都必须同步，缺任一部分都会让 stub 或 node 引导链失效：
     * - [BOOT_SCRIPTS]：web 启动命令在 files 根直接引用的脚本（见 [FS_REGISTER_SCRIPT]）；
     * - `patched/` 整目录：stub 的补丁载荷（koffi/node-pty/sharp 替身、sharp shim）。
     *   review-r5 起载荷从 stub 内嵌 base64 抽为真实文件（对齐参考实现
     *   dsh-mobile-apk 的 assets/patched + applyAssetPatch 机制）：可 diff、可评审，
     *   并纳入 CI 语法门禁。必须整目录同步——缺失载荷会让 stub 静默跳过对应补丁。
     *
     * @return 是否全部同步成功（单个失败不中断，调用方按需告警）
     */
    internal fun syncBootAssets(ctx: Context, fl: (String) -> Unit): Boolean {
        var ok = true
        for (name in BOOT_SCRIPTS) {
            try {
                ctx.assets.open(name).use { input ->
                    File(ctx.filesDir, name).outputStream().use { output -> input.copyTo(output) }
                }
            } catch (t: Throwable) {
                fl("  WARN assets copy $name: ${t.message}")
                ok = false
            }
        }
        val patchDir = File(ctx.filesDir, "patched")
        try {
            if (AssetSync.copyAssetDir(ctx, "patched", patchDir, clearFirst = true)) {
                val count = patchDir.walkTopDown().count { it.isFile }
                fl("  补丁载荷 assets/patched → files/patched（$count 个文件）")
                if (count == 0) fl("  WARN patched 目录为空，stub 将跳过依赖载荷的补丁")
            } else {
                fl("  WARN assets 无 patched 目录（stub 载荷缺失，相关补丁会跳过）")
                ok = false
            }
        } catch (t: Throwable) {
            fl("  WARN 同步 patched 载荷失败：${t.message}")
            ok = false
        }
        return ok
    }

    /**
     * Android 兼容修复（stub-dsh.mjs）按版本只跑一次：
     * marker 记录「APK 版本 + dsh 版本 + stub/载荷内容指纹」，都没变则跳过（省 2~5 秒启动时间）。
     *
     * review-r5 增加内容指纹：此前只看两个版本号，本地重建 APK 而 versionCode 未变
     * （或补丁载荷更新但 dsh 版本未变）时 marker 命中 → 新补丁被静默跳过。
     * 这与参考实现 dsh-mobile-apk 记录的「stale marker string 导致 v1→v2 资产更新失效」
     * 属同型缺陷；内容指纹保证「载荷变即重跑」。
     */
    private fun runAndroidStubOnce(ctx: Context, nodeDir: File, dshPrefix: File, stubScript: File, fl: (String) -> Unit) {
        val apkVer = AssetSync.apkVersion(ctx)
        val fp = patchSetFingerprint(ctx, stubScript)
        val expected = "apk:$apkVer|dsh:${DshUpdater.currentVersion(ctx)}|fp:$fp"
        if (MarkerStore.get(ctx, "stub-applied") == expected) {
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
                "DSH_APK_VER" to apkVer.toString(),
                "DSH_PATCH_DIR" to File(ctx.filesDir, "patched").absolutePath
            )
        ) { fl(it) }
        if (exit == 0) {
            MarkerStore.put(ctx, "stub-applied", expected)
        } else {
            fl("WARN stub-dsh 退出码 $exit（不写 marker，下次重跑）")
        }
    }

    /**
     * 补丁集内容指纹：stub 脚本 + patched/ 全部载荷的长度与全量 CRC32 聚合。
     * 任一处内容变化即指纹变化 → stub 重跑（「载荷变即重贴」，不依赖版本号）。
     */
    private fun patchSetFingerprint(ctx: Context, stubScript: File): String {
        val crc = java.util.zip.CRC32()
        fun feed(f: File) {
            try {
                crc.update(f.name.toByteArray())
                crc.update(f.length().toString().toByteArray())
                if (f.length() > 0) {
                    java.io.FileInputStream(f).use { input ->
                        val buf = ByteArray(64 * 1024)
                        var n: Int
                        while (input.read(buf).also { n = it } != -1) crc.update(buf, 0, n)
                    }
                }
            } catch (_: Throwable) {
                // 单文件不可读时忽略（内容变化会在下次启动重算）
            }
        }
        feed(stubScript)
        val patchDir = File(ctx.filesDir, "patched")
        patchDir.walkTopDown().filter { it.isFile }.sortedBy { it.name }.forEach { feed(it) }
        return java.lang.Long.toHexString(crc.value)
    }

    /** 后台启动 dsh web 并等待 HTTP 就绪。端口已有监听但无响应时清场重启（幂等但不再盲信）。 */
    private fun startDshWeb(ctx: Context, nodeDir: File, dshPrefix: File, onLog: (String) -> Unit): Boolean {
        val cli = dshCli(ctx)
        if (!cli.exists()) {
            onLog("✗ 未找到官方 dsh CLI（安装可能未完成）")
            return false
        }
        // 预检：会话存储根（files/.dsh/sessions）必须可写。
        // 真机故障：dsh 新建会话时 mkdir 报 EACCES permission denied——应用私有目录
        // 正常不可能 EACCES，多为换机/备份恢复把目录属主改乱。快速失败 + 能修则修。
        if (!ensureHomeWritable(ctx, onLog)) return false
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
        // （v4.9.1 起移除「环境代次」检测：衔接版 v4.9.0 已让全部存量进程完成迁移）
        if (isPortListening(WEB_PORT)) {
            if (waitForWebReady(ctx, 5_000, onLog)) {
                onLog(">> dsh web 已在运行 (http://127.0.0.1:$WEB_PORT)")
                return true
            }
            onLog(">> 端口 $WEB_PORT 被残留进程占用但 web 无响应，清理后重新启动…")
            killAllNode(ctx, onLog)
            // 与 [restart] 共用同一等待常量：同为「杀净后等内核释放监听套接字」
            Thread.sleep(RESTART_SETTLE_MS)
        }
        // 生成启动脚本（模板 assets/web-launcher.sh.tpl + TermuxEnv 渲染），由内置 Termux bash 后台执行
        File(ctx.filesDir, "tmp").mkdirs()
        val launcher = webLauncherFile(ctx)
        launcher.parentFile?.mkdirs()
        // 命令串里的 loader 注册脚本名取自 [FS_REGISTER_SCRIPT]（而非字面量）：
        // 供给清单 [BOOT_SCRIPTS] 与本引用从此不可能各自漂移（review-r12 的 P0 根因）。
        val register = File(ctx.filesDir, FS_REGISTER_SCRIPT)
        if (!register.isFile) {
            // fail-loudly：node 对缺失的 --import 是 exit=1 硬失败，日志却只显示
            // ERR_MODULE_NOT_FOUND（看起来像 node 环境坏了）。这里直接点明根因。
            onLog("✗ 缺少 $FS_REGISTER_SCRIPT（${register.absolutePath}）——node 的 --import 会直接失败。")
            onLog("  该文件由引导期资产同步写入（见 DshFlow.BOOT_SCRIPTS）；请重新执行安装/更新。")
            return false
        }
        val nodeCmd = "${nodeDir.absolutePath}/bin/node --expose-internals --import ${register.absolutePath} ${cli.absolutePath} web"
        val tpl = runCatching { ctx.assets.open(WEB_LAUNCHER_TPL).use { it.readBytes().toString(Charsets.UTF_8) } }
            .getOrElse {
                onLog("WARN: 启动脚本模板缺失，回退内置模板")
                DEFAULT_WEB_LAUNCHER_TPL
            }
        val rendered = renderWebLauncher(
            tpl = tpl,
            exports = TermuxEnv.webProcessExports(ctx, nodeDir)
                .joinToString("") { (k, v) -> "export $k=$v\n" },
            home = ctx.filesDir.absolutePath,
            nodeCmd = nodeCmd,
            logFile = File(FileLog.dir(ctx), WEB_LOG).absolutePath,
        )
        // 渲染后仍残留占位符 = 模板与渲染逻辑漂移（或模板注释里写了占位符字面量）。
        // 残留 token 会被 bash 当普通词执行（真机实证：模板注释里的占位符被一并展开，
        // 生成了一条 " <home> <nodeCmd> <logFile>" 的杂散命令，exit=126）。
        // 脚本没有 set -e 才侥幸继续跑——不能依赖这种巧合，此处显式告警。
        val leftover = WEB_LAUNCHER_TOKENS.filter { rendered.contains(it) }
        if (leftover.isNotEmpty()) {
            onLog("WARN: 启动脚本残留未替换占位符 ${leftover.joinToString(" ")}（模板与渲染逻辑不一致）")
        }
        launcher.writeText(rendered)
        launcher.setExecutable(true)
        // 唯一解释器：内置 Termux bash
        exec(ctx, "${TermuxRuntime.bashPath(ctx).absolutePath} ${launcher.absolutePath}") { onLog(it) }
        onLog(">> dsh web 已后台启动，等待 web 就绪（http://127.0.0.1:$WEB_PORT）…")
        return waitForWebReady(ctx, 90_000, onLog, graceOnTimeout = true)
    }

    /**
     * 预检 files/.dsh/sessions（dsh 会话存储根）可写。
     * 不存在则创建；不可写先尝试补 755 权限位（属主正常时有效）；
     * 仍失败则打印逐级属主/权限诊断并给出可读的处理建议，返回 false 中止启动。
     */
    private fun ensureHomeWritable(ctx: Context, onLog: (String) -> Unit): Boolean {
        val home = ctx.filesDir
        val chain = listOf(home, File(home, ".dsh"), File(home, ".dsh/sessions"))

        fun probe(): Boolean {
            val p = File(chain.last(), ".probe-${System.currentTimeMillis()}")
            return try {
                p.mkdirs() && p.delete()
            } catch (_: Throwable) {
                false
            }
        }

        runCatching { chain.last().mkdirs() }
        if (probe()) return true

        onLog(">> ${chain.last().absolutePath} 不可写，尝试修复权限位…")
        for (d in chain) {
            runCatching {
                d.setReadable(true, false)
                d.setWritable(true, false)
                d.setExecutable(true, false)
            }
        }
        if (probe()) {
            onLog("OK 已修复 .dsh 目录权限")
            return true
        }

        // 仍失败：逐级打印属主/权限，方便定位是哪一级坏了
        val myUid = android.os.Process.myUid()
        for (d in chain) {
            val diag = runCatching {
                val st = android.system.Os.stat(d.absolutePath)
                val mode = "%o".format(st.st_mode and 0xFFF)
                val owner = if (st.st_uid != myUid) " ←属主异常(应用uid=$myUid)" else ""
                "mode=$mode uid=${st.st_uid}$owner"
            }.getOrElse { "stat 失败: ${it.message}" }
            val rel = d.absolutePath.removePrefix(home.absolutePath).ifEmpty { "/" }
            onLog("DIAG ~$rel: $diag")
        }
        onLog("✗ 应用私有目录权限异常：dsh 无法保存会话（.dsh/sessions 不可写）。")
        onLog("  多为换机/备份恢复导致目录属主错乱，请到 系统设置 → 应用 → DeepSeek Harness → 存储 → 清除数据；无效则卸载重装。")
        return false
    }


    /**
     * dsh web 启动脚本唯一路径：优先外置私有目录（可执行），不可用时回退 filesDir。
     * Supervisor.reviveWebIfDue 与 startDshWeb 必须共用本函数——此前两处独立解析
     * （一处 null 崩溃 / 一处兜底），外置存储不可用时会崩溃或看门狗静默失效。
     */
    fun webLauncherFile(ctx: Context): File =
        File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "dsh-web.sh")

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

    /**
     * 轮询等待 dsh web 的 HTTP 真正可访问，超时后打印 web 日志尾部。
     *  前 6 秒每 150ms 探测一次（node 冷启动通常 1~3s，尽快感知就绪），之后放宽到 500ms。
     *
     * @param graceOnTimeout 超时后若 node 进程仍存活，是否进入慢启动宽限（再等 120s）。
     *   真正的「启动 dsh web」路径传 true——冷启动慢设备可能超过 90s 才就绪，此前的
     *   硬超时直接判失败会触发 maybeAutoRollback 全量重装（慢设备「明明能启动却被
     *   回滚」的根因）；「残留进程探测」路径必须传 false——残留 node 是活进程，
     *   宽限只会白等 120 秒才走到清理分支。
     */
    private fun waitForWebReady(
        ctx: Context,
        timeoutMs: Long,
        onLog: (String) -> Unit,
        graceOnTimeout: Boolean = false,
    ): Boolean {
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
        // 超时但进程还活着：不再判死（启动期容错），进入慢启动宽限
        if (graceOnTimeout && nodeProcessAlive(ctx)) {
            onLog(">> dsh web 未在 ${timeoutMs / 1000}s 内就绪，但 node 进程仍在运行——冷启动较慢，继续等待")
            val graceStart = System.currentTimeMillis()
            val graceDeadline = graceStart + 120_000L
            while (System.currentTimeMillis() < graceDeadline) {
                if (httpResponds(WEB_PORT)) {
                    val waitedTotal = (timeoutMs + (System.currentTimeMillis() - graceStart)) / 1000
                    onLog("OK dsh web 已就绪（共等待 ${waitedTotal}s，属慢启动）")
                    return true
                }
                if (!nodeProcessAlive(ctx)) break
                Thread.sleep(1_000)
            }
        }
        onLog("✗ dsh web 未就绪（进程已退出或超时），日志尾部：")
        appendLogTail(File(FileLog.dir(ctx), WEB_LOG), 25, onLog)
        return false
    }

    /**
     * 本应用 node 进程是否存活（供启动等待做「进程死亡→提前失败」判定）。
     *
     * P0 修复：原实现 `ps -A | grep '[n]ode'` 判定的是「输出是否有任何行」——
     * 任何含 "node" 字样的无关行都会让判定恒真，于是「进程已死」的提前失败分支
     * 永不触发，只能干等到超时。现委托 [NodeProcs] 按 argv0 精确归属判定。
     */
    private fun nodeProcessAlive(ctx: Context): Boolean = try {
        NodeProcs.anyAlive(ctx)
    } catch (_: Throwable) {
        // 探测本身失败时保守认为存活（不因异常误判失败）
        true
    }

    /** dsh web 端口是否响应（委托 [LocalHttp]；本机回环一律不走代理）。 */
    fun httpResponds(port: Int): Boolean = LocalHttp.responds(port)

    private fun appendLogTail(file: File, maxLines: Int, onLog: (String) -> Unit) {
        try {
            if (!file.exists()) {
                onLog("   （无日志文件：${file.path}）")
                return
            }
            // 只读尾部：web.log 可能长到几十 MB，全量 readText 在低内存设备会 OOM
            val tail = readTailLines(file, maxLines)
            for (line in tail) onLog("   | $line")
        } catch (t: Throwable) {
            onLog("   （读取日志失败：${t.message}）")
        }
    }

    /** 读文件尾部 N 行（RandomAccessFile 定位到 len-256KB 起，避免整文件载入内存）。 */
    private fun readTailLines(file: File, maxLines: Int): List<String> {
        if (file.length() <= 256 * 1024) return file.readText().trim().lines()
        java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(file.length() - 256 * 1024)
            val buf = ByteArray(256 * 1024)
            val n = raf.read(buf)
            // 丢弃首个不完整行（从中间开始读的）
            val text = String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
            return text.trim().lines().drop(1).takeLast(maxLines)
        }
    }

    /**
     * 杀掉全部本应用 node 进程（web 与 flow 子进程一并结束），供更新后重启。
     *
     * P0 修复（真机实证）：此前实现走
     * `ps -A | grep '[n]ode' | awk '{print $2}'` —— 该列序假设来自桌面 procps，
     * 而 Android toybox 的 `ps -A` 列序是 `PID TTY TIME CMD`，`$2` 命中 **TTY 列**，
     * 解析结果恒为 `?`，kill 静默失败且退出码 0（终止链路全线失效：
     * 残留 node 占住 3080 → 重启反复失败；安装超时后 npm/pnpm 孙进程被孤儿化）。
     * 现委托 [NodeProcs]：读 `/proc/<pid>/cmdline` 按可执行文件绝对路径判定归属，
     * 不依赖任何外部工具与输出列序。
     *
     * @return 是否全部已退出（此前无返回值，调用方无法判断清理是否真的成功）
     */
    fun killAllNode(ctx: Context, onLine: (String) -> Unit = {}): Boolean =
        runCatching { NodeProcs.killAll(ctx, onLine) }
            .onFailure { AppLog.e("DshFlow", "killAllNode failed: ${it.message}") }
            .getOrDefault(false)

    /**
     * 同步执行命令（阻塞直到结束），返回退出码；输出通过 onLine 实时回调。
     * 唯一执行环境为内置 Termux bash（未就绪自动准备，失败拒绝执行）；
     * 安装类命令自动放开 W^X。实现统一委托 [Proc]（P1-1 合并双执行器）。
     */
    fun exec(
        ctx: Context,
        raw: String,
        extraEnv: Map<String, String> = emptyMap(),
        onLine: (String) -> Unit = {}
    ): Int = Proc.run(
        ProcSpec(
            ctx = ctx,
            command = raw,
            envOverrides = extraEnv,
            autoUnlockWxOnInstall = true,
            onLine = onLine,
        )
    )
}
