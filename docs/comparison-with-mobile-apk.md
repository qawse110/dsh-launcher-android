# dsh-launcher-android 对比 dsh-mobile-apk：分析与重构记录

> 参考项目：`kelai141/dsh-mobile-apk`（克隆于 `_ref-dsh-mobile-apk/`，v0.13.6）
> 本项目：`com.dsh.launcher` v4.10.2-fix6（versionCode 300）
> 日期：2026-09-10

## 一、两项目定位差异（为何不推倒重来）

| 维度 | 本项目（launcher） | 参考项目（mobile-apk） |
|---|---|---|
| 运行时获取 | 官方 npm 安装 `@deepseek-ai/dsh`（钉死 0.1.1-rc.1） | 内嵌 Termux 快照 xz（构建期打包，~155MB） |
| 首启动耗时 | 快（npm 增量），依赖网络 | 慢（解压 2-4 分钟），完全离线 |
| 引擎认证 | 无（rc.1 无 /api 浏览器认证） | EngineAuth（token 交换 + cookie 自铸） |
| 保活 | 普通服务 + 无障碍双通道 + PowerGovernor | 前台服务 + WatchdogV2 熔断退避 |
| 崩溃自愈 | 回滚重装（crash-loop 检测） | UndoGate 快照回撤 |
| 附加能力 | 桌宠/TTS/悬浮窗/备份/插件管理器 | ADB 通道/无障碍设备控制/在线快照更新 |

**结论**：两者是不同的工程取舍，架构路线各自成立。重构策略 = 「借鉴参考项目的防御性细节与成熟模式」，不做架构替换。

## 二、已落地的修补（本轮）

### P0-1 本地探针绕过系统代理（参考坑 33）
**问题**：4 处 `openConnection()` 未指定 `Proxy.NO_PROXY`。用户配置系统/Wi-Fi 代理后，
127.0.0.1 请求被交给代理 → 探针全挂 → watchdog 误判 dsh 死亡 → 误杀/误拉起循环。
**修复**（对齐参考 `AGENTS.md` 坑 33「壳侧所有本地引擎调用一律 Proxy.NO_PROXY」）：
- `DshFlow.kt`：新增 `localConnection()` 唯一入口（`httpResponds` 改用）
- `DshWatchdog.isUp()`
- `StatusBridgeService.fetchStatus()`
- `KeepAliveAccessibilityService.fetchStatus()`

### P0-2 启动等待增加进程存活语义（参考 0.13.0 D1）
**问题**：`waitForWebReady` 90s 硬超时即判失败 → 触发 `maybeAutoRollback` 全量重装。
低端 SoC（本项目实测设备 Sharp 803SH 仅 3.7GB 内存）冷启动可能超 90s——
「明明能启动却被回滚」。
**修复**：`waitForWebReady` 增加 `graceOnTimeout` 参数；超时但 node 进程仍存活时
进入 120s 慢启动宽限（期间持续探测，进程死亡立即判败）。仅真正的启动路径传 true；
残留进程探测路径（`waitForWebReady(ctx, 5_000)`）保持立即失败语义——否则残留存活进程
会白等 120s 才走到清理分支。

### P1-1 killAllNode 限时收尾 + SIGKILL 升级
**问题**：`p.waitFor()` 无限阻塞——僵死 node 会让「更新后重启」链路永久挂起；
且 SIGTERM 后不验证是否真退出，残留进程占 3080 导致重启失败。
**修复**：TERM → 等 5s → 存活则 KILL -9 升级（再 3s 超时兜底 destroyForcibly）。

### P1-2 appendLogTail 只读尾部
**问题**：`file.readText()` 全量载入——web.log 长到几十 MB 时低内存设备 OOM 风险
（超时诊断路径恰在内存紧张时触发）。
**修复**：`readTailLines()`——≤256KB 直接读，否则 RandomAccessFile 定位尾部，丢弃首残行。

### P1-3 WebView 渲染进程冻结自愈（参考 issue #36）
**问题**：部分 ROM（荣耀 MagicUI 6.1/Android 12 等）渲染进程 JS 主线程冻结，
页面停在「Loading plugins…」，页面内定时器也失效，无自愈。
**修复**（对齐参考 `EngineStartFlow.freezeRunnable`）：主线程每 10s
`evaluateJavascript("1")` 心跳；页面加载 45s 后 20s 无 ack = 冻结 → reload 一次
（`freezeReloaded` 单次防循环）。onPageFinished 启动 / onPause+onDestroy 停止。

### P1-4 主帧加载失败自动重试（参考 ENGINE_PAGE_RELOAD 模式）
**问题**：主帧 error 后停在错误页等手动重试；但 dsh web 可能仍在启动
（首次引导未完成/watchdog 正在拉起）。
**修复**：主帧 error → 10s/20s/30s 间隔自动 reload（最多 3 次）；
onPageStarted / 手动重试归零；onPause/onDestroy 取消。

### P2-1 fetchStatus disconnect 收敛 finally
`StatusBridgeService.fetchStatus` 的 `conn.disconnect()` 原在正常路径，
responseCode 抛异常时泄漏连接（`KeepAliveAccessibilityService` 已是 finally，对齐之）。
（随 P0-1 一并处理）

## 三、评估过但不采纳/后续跟进的参考做法

| 参考做法 | 结论 |
|---|---|
| SnapshotTransaction 事务化解压 | 不采纳：本项目 npm 安装模式无大快照替换场景；`NodeRuntime.ensureExtracted` 已有失败即删+重解压。若未来引入快照更新再借鉴 |
| EngineAuth cookie 自铸 | 不适用：钉死的 dsh 0.1.1-rc.1 无 /api 浏览器认证栅栏（参考项目升到 0.1.2-rc.1 才需要）。升级引擎版本时**必须**回看此项 |
| WatchdogV2 熔断（12 次熔断+暂停） | 本项目 Supervisor 已有指数退避（60s→30min 封顶）+ crash-loop 回滚，语义等价，不重复建设 |
| WebView DOM 快速通道/无障碍设备控制 | 大特性，超出本轮范围；已在 §四 排期建议 |
| Online snapshot update（manifest+sha256+原子切换） | 同上，npm 模式下对应物是「版本钉死+回滚」，已覆盖 |

## 三点五、环境链路专项重构（review-r4，参考 dsh-shell-termux / dsh-android-linux-env）

参考项目环境实现核心：`dsh-shell-termux`（TermuxBashExecutor.termuxEnv 自包含环境：
PATH/LD_LIBRARY_PATH/HOME/PREFIX/TERMUX_VERSION/SHELL + 栅栏键）与 `dsh-android-linux-env`
（工具链探测/环境配方导出）。对照落地：

### 已落地
1. **P1 env 单源化收尾**：`NodeRuntime.nodeEnvPrefix` 退役——其在 NodeRuntime 内私拼
   5 个 env 字面量（HOME 指向 node 目录，与 childShellEnv 的 termux home 不一致），
   构成第二环境源；消费者（ConsoleActivity node 版本命令）改走 Proc→TermuxEnv 统一注入
   （LD_LIBRARY_PATH 已含 node/lib，无需前缀）。TermuxEnv 头注释约束同步收紧为
   「字面量只允许出现在本文件」。
2. **P1 SHELL 键补齐**（对齐参考 `termuxEnv()`）：`childShellEnv`/`webProcessExports`
   注入 `SHELL=<bashPath>`——npm/git/configure 脚本会探测 SHELL，缺省时继承宿主
   `/bin/sh` 造成歧义。
3. **P1 terminalSessionEnv 单源化**：原与 childShellEnv 双套维护且已实测漂移
   （终端 PATH 缺 `/bin`、无 OPENSSL_CONF、无 SHELL、硬编码 `termux/usr` 绕过
   TermuxRuntime.prefix）。改为 childShellEnv 基底 + TMPDIR=home + PWD=home，
   行为向后兼容（新增键均为增益）。
4. **P2 短前缀链接 fail-loudly**（对齐参考 assertBash 哲学）：`createPrefixShortcut`
   失败原仅 Log.w 静默继续——它是全部官方二进制 shebang/exec 的前提，缺失时后续以
   含混错误挂掉。新增 `isPrefixShortcutValid` 校验，失败即中止安装并给出修复指引；
   同时将创建时序移到 PrefixPatcher 之前（patch 产出的 shebang 依赖该链接先存在）。

### 评估后不采纳
- **TERMUX_VERSION 伪造注入**（参考固定 `0.118.3`）：伪造版本号可能误导 pkg/脚本
  的兼容性分支判断；本项目 bootstrap 与官方 Termux app 无交互，无消费方，不注入。
- **DSH_WRITE_MODE 等栅栏键**：参考项目的写面档位随其 dsh-sandbox 契约走；本项目
  dsh 0.1.1-rc.1 无对应消费端，注入为死键。升级引擎版本时可回看。
- **probe() 工具链探测面板**（linux-env）：PackageKit.requiredCheck 已覆盖等价探测，
  UI 面板属新特性，列入后续排期。

### 测试
`TermuxEnvTest` 扩展：SHELL 键断言（childShellEnv/webProcessExports）+
`terminalSessionEnv 与 childShellEnv 单源一致` 回归测试（逐键比对）。

## 四、后续重构排期建议（未落地）

1. **P2**：`BridgeOverlayManager.kt`（1287 行）按「窗口管理/状态机/交互」三块拆分——参考项目 OverlayService(712)/OverlayPanel(837)/OverlayController 分层值得照抄。
2. **P2**：`PluginManagerActivity.kt`（1135 行）UI 与逻辑分离（Repository 模式），JSON 解析散落 4 处 `readText()` 收敛到单点。
3. **P3**：引入 `UndoGate` 式快照回撤（备份 zip 机制已具备，差「自动触发+恢复+验证」闭环）。
4. **P3**：补 `SnapshotExtractor` 式 symlink 目标白名单——`NodeRuntime.createSymlink` 目前失败静默降级为空文件，可加「目标必须在 dir 内」校验（本资产自控风险低，仅为纵深防御）。

## 五、验证说明

设备端无 JDK/Android SDK，无法执行 `gradlew` 编译与单测；已做静态验证：
- 全部改动文件括号/圆括号平衡检查通过（`tools/bracecheck-edited.cjs`）
- `Proxy.NO_PROXY` 4 处调用点核对一致
- `waitForWebReady` 两处调用点语义核对（残留探测不进宽限）
- 改动均限定在既有类型/方法签名内，无新依赖，无 Manifest 变更
- 下次桌面/CI 环境 `./gradlew assembleDebug` 应作为合并门禁

## 六、改动文件清单

- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（P0-1/P0-2/P1-1/P1-2）
- `app/src/main/java/com/dsh/launcher/core/DshWatchdog.kt`（P0-1）
- `app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt`（P0-1/P2-1）
- `app/src/main/java/com/dsh/launcher/service/KeepAliveAccessibilityService.kt`（P0-1）
- `app/src/main/java/com/dsh/launcher/ui/WebViewActivity.kt`（P1-3/P1-4）
- `tools/bracecheck-edited.cjs`（验证脚本）
