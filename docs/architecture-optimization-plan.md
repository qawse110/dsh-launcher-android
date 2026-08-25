# DshLauncher 架构优化方案

- 版本基准：`feat/termux-default-env` @ v4.6.0（versionCode 27）
- 代码规模：Kotlin 8790 行 / 24 文件（5 子包）+ assets 脚本层 7 个
- 方法论：全部问题条目附代码证据；每项给出验收标准与工作量；并明确"不做什么"

---

## 一、现状快照

```
┌─ ui/ ────────────────┐   ┌─ overlay/ ─────────┐   ┌─ service/ ─────────┐
│ MainActivity     862 │   │ BridgeOverlay 1268 │   │ StatusBridgeSvc 337│
│ PluginManager   1143 │   │ Pet/CodexPetStore  │   │ KeepAliveAccSvc    │
│ Console 484 Terminal │   │ StatusOverlay等    │   │ BuildKeepAliveSvc* │
│ WebView OverlaySett. │   └─────────┬──────────┘   └─────────┬──────────┘
└──────────┬───────────┘             │ 直接引用                │
           │      ┌──────────────────┴───────────────┐        │
           ▼      ▼                                  ▼        ▼
┌─ core/ ───────────────────────────────────────────────────────────┐
│ DshFlow 623（编排+执行器+启动脚本生成+端口探测+日志导出）            │
│ TermuxRuntime 741（bootstrap安装+前缀patch+apt配置+profile生成+tpkg)│
│ NodeRuntime · DshUpdater · AssetSync · PowerGovernor               │
│ AppLog · FileLog · DshWatchdog                                     │
└───────────────────────────────────────────────────────────────────┘
              ↓ 运行时资产                    ↑ 环境变量构造 × 6 处
   files/{dsh-prefix,node,termux,plugins,.tools,logs,…}
```

\* BuildKeepAliveService 定义在 ui/ConsoleActivity.kt 拆出的独立文件中。

**集中度**：Top5 文件（BridgeOverlayManager 1268 / PluginManagerActivity 1143 /
MainActivity 862 / TermuxRuntime 741 / DshFlow 623）合计 4637 行，占 53%。

---

## 二、问题清单（按优先级）

### P0 —— 正确性与安全风险

#### P0-1 子进程环境构造散落于 6 处，已发生 2 次真实事故
**证据**：`PATH/LD_*/HOME/TMPDIR` 拼接存在于 DshFlow.exec、startDshWeb 脚本、
TermuxRuntime.runBash、NodeRuntime.nodeEnvPrefix、TerminalActivity.createSession、
PluginManagerActivity.baseEnv。历史事故：① exec 的 termux 分支漏拼 `node/lib`
导致内部 node 无法启动；② LD_PRELOAD(termux-exec) 需要在 4 处分别注入，漏一处即失效。
**方案**：新建 `core/TermuxEnv`，作为唯一环境工厂：
```kotlin
object TermuxEnv {
    fun webProcessEnv(ctx): Map<String,String>   // web 启动脚本 export 集
    fun childShellEnv(ctx, extra: Map<String,String> = emptyMap()): Map<String,String>
    fun terminalSessionEnv(activity): Array<String>
}
```
所有调用点改为消费方；`grep -rn "LD_LIBRARY_PATH"` 仅允许出现在 TermuxEnv 内。
**验收**：上述 grep 收敛到单文件；三处环境逐字段 diff 一致性快照测试通过。
**工作量**：0.5 天｜风险低。

#### P0-2 签名密钥与默认密码入库
**证据**：`signing/release.keystore` 被 git 跟踪（release.yml 首跑时主动 commit 以保证
签名稳定）；`app/build.gradle.kts` 含默认密码回退 `"dshlauncher123"`。
密钥公开 ⇒ 任何人可用相同签名构造恶意"升级"包。
**方案**：`git rm --cached signing/release.keystore`；CI 完全走 `DSH_KEYSTORE_B64`
secret 通道；gradle 移除默认密码回退（缺 env 即构建失败）。
⚠️ **需产品决策**：换新密钥会使老用户无法覆盖安装（README 已注明 v4.3.4 后卸载重装的惯例，
实际影响可控）。**工作量**：0.5 天｜需决策。

#### P0-3 常量多源：端口 3080 四处字面量
**证据**：`DshFlow.WEB_PORT` 存在，但 DshWatchdog.isUp()、ConsoleActivity、
WebViewActivity 各自硬编码 `http://127.0.0.1:3080`。
**方案**：统一引用 `DshFlow.WEB_PORT`（或提为 `core/RuntimeConst`）。
**工作量**：0.25 天｜零风险。

### P1 —— 结构解耦

#### P1-1 双进程执行器合并
**证据**：`DshFlow.exec()` 与 `TermuxRuntime.runBash()` 是两套同构的
ProcessBuilder 封装（流式读取线程、超时强杀、W^X 切换各有细微差异）。
**方案**：抽 `core/Proc`：`exec(spec: CmdSpec): ProcResult`，超时/解锁/env 注入/
工作目录策略全部参数化；两处调用方瘦身。配合 P0-1 一次性完成。
**验收**：删除其中一套实现；Console/exec/runBash 行为回归清单通过。
**工作量**：1 天。

#### P1-2 启动脚本模板化
**证据**：`dsh-web.sh` 由 Kotlin 字符串逐行拼接（DshFlow.startDshWeb），引号转义
靠人眼，本次迁移中已两次修改此函数且每次都需人工核对。
**方案**：移入 `assets/web-launcher.sh.tpl`，占位符 `@LD_LIBRARY_PATH@` 等由
TermuxEnv 渲染；脚本本身获得独立演进能力（可加 `set -eu`、trap 清理）。
**工作量**：0.5 天。

#### P1-3 TermuxRuntime 按职责拆分（741 行 / ≥5 类职责）
**方案**：core/ 下拆为 `BootstrapInstaller`（解压/symlink/mirror）、
`PrefixPatcher`（patchPrefixAll/TextOfficialDirs）、`PackageKit`
（ensureHarnessTools/tpkg/apt 包装器生成）、`ProfileWriter`（profile.d/apt.conf/
inputrc）；`TermuxRuntime` 保留为门面（facade）避免调用方大面积改动。
**工作量**：1.5 天｜纯移动+门面，风险低。

#### P1-4 状态与配置中心化
**证据**：prefs 命名空间 5 个（dsh_console/dsh_keepalive/dsh_ui/status_bridge/storage）
共 17 处 getSharedPreferences 字面量；marker 文件 6 种散落 filesDir 根
（.termux-ok/.harness-tools-ok/.node-ok/.prebuilt-ok/.extra-plugins-ok/.stub-applied）。
**方案**：`core/AppState`：常量键 + 类型化读写门面；marker 迁移至
`files/state/markers.json`（FileLog 风格），提供一次性旧 marker 导入。
**工作量**：1 天。

#### P1-5 保活/拉起监督归一
**证据**： revival 路径有三条——DshWatchdog（HTTP 轮询+60s 冷却）、
KeepAliveAccessibilityService、StatusBridgeService.scheduleWatchdog(Alarm)；
"期望运行"标志分散于 dsh_keepalive prefs 的 running 键，读写点 4+ 处。
**方案**：`core/Supervisor` 单点持有 desired-state 与 revive()；三路触发器退化为
事件源。**工作量**：1.5 天（含回归）。

#### P1-6 BridgeOverlayManager 拆分（1268 行，最大文件）
**方案**：状态轮询/数据装配与视图渲染分层（现 View 体系内做 Presenter 化即可，
不引入 Compose）。**工作量**：2 天。

### P2 —— 可演进性

| # | 项 | 要点 | 工作量 |
|---|---|---|---|
| P2-1 | 协程化 | 39 处 thread{}/@Volatile/AtomicBoolean → CoroutineScope+withTimeout；先只改 core/ | 2 天 |
| P2-2 | 测试地基 | **当前 app/src 下仅有 main，零测试**。新增 unit test 集；优先覆盖纯逻辑：TermuxEnv、PrefixPatcher（等长替换可纯函数化）、AssetSync、tpkg.sh（CI 里 bash 断言）、FileLog 轮转 | 2 天 |
| P2-3 | Android 兼容层收敛 | assets 下 fs-loader/fs-register/fs-promises-compat/stub-dsh 四个 monkey-patch 脚本合并为单一版本化入口（一个 `--import` + smoke 脚本），降低每次 dsh 升级的适配面 | 1.5 天 |
| P2-4 | 插件分发解耦 | prebuilt.tgz 30MB 单体：任一插件改动=整包发版。拆 per-plugin tgz 或运行时拉取（保留内置兜底，PluginManager.repairFromSource 通道可复用） | 2 天 |
| P2-5 | PrefixPatcher 增量化 | patchPrefixAll 全树扫读字节；apt/tpkg 均已产出 info/*.list，改为仅 patch 新增清单 | 0.5 天 |
| P2-6 | CI 门禁 | feat push 目前无任何检查；增加 assembleDebug + ktlint 快速流水线；release.yml 的 GITHUB_REF_NAME 命名行为文档化 | 0.5 天 |
| P2-7 | 异常治理 | 55 处 runCatching 静默吞异常；FileLog 已就位，逐步改为记录后重抛或结构化错误回调 | 持续 |

---

## 三、路线图

| 阶段 | 版本建议 | 内容 | 出口标准 |
|---|---|---|---|
| R1 正确性 | v4.7.x | P0-1/2/3 + P1-1 + P1-2 + P2-6 | 环境构造单源化；keystore 出库（待决策）；CI 门禁上线 |
| R2 解耦 | v4.8–v5.0 | P1-3/4/5/6 + P2-5 | TermuxRuntime<300 行/文件；Supervisor 单点拉起；AppState 上线 |
| R3 演进 | 按需 | P2-1/2/3/4/7 | core 协程化；关键纯逻辑测试覆盖；插件独立分发 |

## 四、明确不做（避免过度设计）

- ❌ 迁移 Jetpack Compose —— View 体系稳定，UI 改动频率不支持重写成本
- ❌ Hilt/DI 框架 —— 规模不需要，手工单例 + 门面足够
- ❌ 多进程改造 —— 单进程前台服务模型符合产品形态
- ❌ targetSdk 升级专项 —— 牵动 W^X/SELinux 假设，另立调研议题

## 五、附：本次 review 未发现的问题类型

内存泄漏模式（Activity 泄漏的 thread{} 持有均短生命周期）、SQL/序列化漏洞面、
WebView JS bridge 暴露面（未注册 JS 接口）经抽查未见明显风险点。

---

## 执行状态

| 阶段 | 状态 | 提交 |
|---|---|---|
| R1（P0-1/3、P1-1/2、P2-6） | ✅ 完成 | d33ad44 + 修复 fdc2e80 |
| R1.5 横切 review | ✅ 完成（见 review-findings-r1.md） | 594dac8 |
| R2 P1-3 TermuxRuntime 四拆 | ✅ 完成：BootstrapInstaller/PrefixPatcher/ProfileWriter/PackageKit + 门面 60 行 | 本提交 |
| R2 P1-4 状态中心化（prefs 命名空间） | ✅ 完成：AppState.Prefs 单源（markers.json 迁移延后） | 本提交 |
| R2 P1-5 Supervisor 归一 | ✅ 完成：期望态 + 冷却拉起单点；Watchdog/Receiver/BKS 接入 | 本提交 |
| R2 P1-6 BridgeOverlayManager 拆分 | ⏸ 挂起（风险最大，需独立回归窗口） | — |
| P0-2 keystore 出库 | ⏸ 待产品决策（签名影响） | — |
| R2 P1-4 收尾：markers.json 迁移 | ✅ 完成：MarkerStore 单文件原子写 + 六种旧点文件一次性导入；AssetSync 改键值 API | 本提交 |
| R2 P1-6 第一刀 | ✅ 完成：BridgePrefs(15 getter) + OverlayStyle(样式工厂) 拆出；manager 1268→1203。剩余桌宠物理/气泡/TTS 簇（~500 行强耦合）需真机回归窗口，挂起至下一回归周期 | 本提交 |
