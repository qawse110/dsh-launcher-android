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

## 三点六、脚本层专项重构（review-r5，参考 assets/patched + applyAssetPatch 机制）

参考项目脚本层核心：补丁不是内嵌代码，而是**真实文件** `assets/patched/*.js`，
由 `EngineManager.applyAssetPatch` 覆盖到快照对应位置；幂等靠**内容指纹**
（其注释明确记录「marker 字符串不变 → 载荷更新后补丁被静默跳过」的 v1→v2 事故），
另有 hash-adaptive 重写（index.html 引用引擎 content-hash bundle 名）。

### 已落地
1. **补丁载荷外置**：`stub-dsh.mjs` 内嵌的 4 个 base64 载荷（koffi ESM/CJS、
   node-pty、sharp shim 12.7KB）抽为 `app/src/main/assets/patched/` 真实文件，
   由 `DshFlow.syncCompatAssets` 整目录同步到 `files/patched/`。
   stub 48KB → 37KB，去掉约 19KB 不可读 blob。
   **安全性证明**：迁移后用 `tools/verify-payload-extraction.cjs` 与迁移前
   base64 解码结果逐字节比对，4 个载荷全部 IDENTICAL（零行为变化）。
2. **内容比对幂等**：新增 `overlayPatch()`——覆盖式补丁按载荷与目标逐字节比对
   决定是否重写，不再依赖版本 marker；ripgrep 补丁同样改为整文件内容比对。
   `stub-applied` marker 加入**补丁集内容指纹**（stub + patched 全量 CRC32）：
   此前只看 APK/dsh 版本号，本地重建未 bump 版本或载荷更新时新补丁会被静默跳过。
3. **不落半补丁**：`dsh-fs-local chmod` 改为逐条锚点计数 + 写盘前 `node --check`：
   任一条全部失配即不写盘并告警（此前零替换也会落盘并写 marker → 后续永不重试）。
4. **死代码清理**：`SHARP_STUB` / `SHARP_STUB_ESM`（v4 改纯 JS shim 后无消费者）。
5. **CI 资产脚本门禁（新）**：`tools/check-asset-scripts.cjs` 对全部 assets 脚本
   （stub/install/routing/fs 兼容层）+ `patched/` 载荷做 `node --check`，
   并校验 stub 引用的载荷存在；接入 `ci.yml`（最快环节置顶）与 `build-apk.yml`
   （打包前卡关）。已实测验证门禁能拦住被写坏的载荷
   ——这正是载荷外置的直接收益：base64 时代这些内容对静态检查完全不可见。

### 评估后不采纳 / 后续排期
- **index.html 作为补丁载荷 + hash-adaptive**：工作区对应物是 stub 内联注入的一小段
  `AbortSignal.timeout` shim（非大 blob，且已按需注入），外置收益不足。
- **install-dsh.mjs**：已具备内容指纹（`contentFingerprint`）、子进程硬超时、
  OOM 判定、显式文件根契约，成熟度与参考项目相当，本轮无需改动。

## 三点七、进程终止链路专项重构（review-r6，真机实证 P0）

本轮与前三轮不同：**不是「借鉴参考项目的做法」，而是参考项目的坑位索引让我们去
验证自己的工作区，从而挖出一个正在生效、且完全静默的 P0 缺陷。**

### P0 实证：`killAllNode` 的 PID 解析在 Android toybox 上恒失效

原实现：

```sh
ps -A | grep '[n]ode' | awk '{print $2}' | while read pid; do kill "$pid" 2>/dev/null; done
```

`awk '{print $2}'` 的列序假设来自桌面 procps（`PID USER …`），而 Android 自带
toybox 的 `ps -A` 列序是 **`PID TTY TIME CMD`** → `$2` 命中的是 **TTY 列**。
真机实测（本项目设备）：

```
$ ps -A | grep '[n]ode'
  6310 ?        00:01:52 /data/user/0/com.dsh.launcher/files/node/bin/node
$ ps -A | grep '[n]ode' | awk '{print $2}'
  ?                                     ← 恒为 "?"
$ ps -A | grep '[n]ode' | awk '{print $2}' | while read pid; do kill "$pid" 2>/dev/null; done
                                        ← 静默失败，退出码 0
```

**为何长期未被发现**：三层静默叠加——`awk` 正常输出 `?`、`kill "?"` 失败但被
`2>/dev/null` 吞掉、管道整体退出码仍为 0。日志只留下一行无害的
「node processes killed」。

**影响面**（6 个调用点全部失效）：残留 node 占住 3080 → 「重启 dsh」反复失败；
`Proc` 安装类命令超时后 npm/pnpm 孙进程被孤儿化，继续写 node_modules 与下一轮安装并发。

### 落地修复

1. **新增 `core/NodeProcs.kt`（唯一进程入口）**：读 `/proc/<pid>/cmdline`（NUL 分隔
   argv），按 **argv0 绝对路径**判定归属。不依赖 `ps` 输出格式、不依赖任何外部工具。
   - 归属判定只认「与 binPath 完全一致」或其 `/data/data` ≡ `/data/user/0` 别名形式。
     刻意拒绝宽松后缀匹配（`endsWith("/node/bin/node")` 会把
     `/data/user/0/com.other.app/files/node/bin/node` 也算成自己人——误杀无关进程）。
   - 发信号前**复核身份**（PID 可能被回收给无关进程），复核失败视为已达成目的。
   - `killAll` 阻塞等待真实退出（SIGTERM → 5s → 存活者 SIGKILL → 3s），
     **返回是否全部退出**——原实现无返回值，调用方无法判断清理是否真的成功。
2. **`nodeProcessAlive` 同源化**：原判定是「`ps | grep node` 输出是否有任何行」，
   任何含 `node` 字样的无关行都让判定恒真 → 「进程已死→提前失败」分支永不触发，
   只能干等到超时。现走 `NodeProcs.anyAlive`。
3. **`MainActivity.stopDshAll` 去掉 `pkill -f`**：模式串出现在执行它的 `sh -c`
   **自身 cmdline** 里，真机实测 `pgrep -f 'bin.js'` 会一并吐出执行命令的 bash PID
   （自杀隐患）；且参考坑 31 记录部分 ROM 上 `pkill -f` 完全不生效，原代码还用
   `; true` 吞掉失败。现统一走 `DshFlow.killAllNode`。
4. **连带修掉一个由本次修复引入的 ANR 风险**：`killAllNode` 现在**真的会阻塞**
   （最多约 8s），而 `MainActivity.confirmRollback` 的调用点在 AlertDialog 点击回调里
   = 主线程。已移到后台线程，杀净后回主线程 `beginFlow`。

### 反向验证（门禁必须见过它失败）

`NodeProcsTest` 覆盖：cmdline NUL 切分（含无末尾 NUL、空 cmdline、文件不存在）、
归属判定（精确路径 / `/data/data` 别名 / 裸 `node` / 其它应用同后缀路径 / 空 argv0）、
别名双向互转、无 node 时 `killAll` 幂等成功。

## 三点八、ABI 门禁（review-r6，对齐参考坑 18/30）

参考项目两次真机重大事故均由**错 ABI 运行时**造成：debug 包内是 x86_64 快照，
装到 arm64 真机覆盖后引擎崩——`EM_X86_64 (62) instead of EM_AARCH64 (183)`；
以及「双 ABI 循环打包后 assets 停在最后一个 ABI」。

**本项目对应风险**：内置 node 经 **Git LFS** 分发，文件名写死
`termux-node-aarch64.tar.gz`，但**文件名不是事实**，且工作区此前**无任何 ABI 校验**。

新增 `tools/check-asset-abi.cjs`：读归档内 `bin/node` 的 ELF 头 `e_machine`，
与文件名声明的 ABI 双向核对。接入 `ci.yml` 与 `build-apk.yml`。

- **未拉取 LFS 时输出 SKIP 而非失败**（133 字节指针文件被识别），避免假警报；
  CI 两 workflow 均已带 `lfs: true`。
- **双向反向验证**：构造 x86_64 内容 + aarch64 文件名的 tar → 门禁 `exit=1` 并给出
  「实际 0x3e (x86_64) ≠ 文件名声明 aarch64 (0xb7)，参考坑 18/30」；换成 aarch64 内容
  → PASS。gzip 与明文 tar 两条路径都实测通过。
- 设备侧交叉证据：真机 node `e_machine=0xb7 (aarch64)`，设备 ABI `arm64-v8a`。

#### 门禁初版在真实输入上失败（本轮最有价值的一次失败）

初版门禁用**自造的扁平 tar**（`bin/node` 直接在顶层）自测，双向全绿；推到 CI 后
**立刻失败**——因为 CI 拉到了 LFS 真身（37.1MB，本地只有 133 字节指针）：

```
FAIL app/src/main/assets/node/termux-node-aarch64.tar.gz
     归档内未找到 bin/node
```

**真因**：内置 node 归档是**两层**结构——`.tar.gz` 解出的是**单个内层 `.tar`**（112MB），
真正的 `bin/node` 在内层。`NodeRuntime.ensureExtracted` 早有对应兼容分支
（解完外层若 `bin/node` 不在场就把唯一的 `*.tar` 再解一次），但门禁初版漏了这一层。

**修复**：门禁先试扁平形态；否则走 `tar -xOf outer inner | tar -xOf - bin/node`
管道流式取内层（不落盘，避免 112MB 落盘）。已用**真实归档**重新双向验证：
真身 → `OK e_machine=0xb7 (aarch64)`；同一真身改名为 `x86_64` 声明 → `exit=1` 正确拒绝。

> **元教训（本轮第二次）**：**用构造样例自测只能验证「我以为的布局」**。这是本轮第二次
> 「验证手段本身带错误假设」——第一次是 `bracecheck` 对历史 bug 的错误归因，
> 第二次是 ABI 门禁对归档布局的错误假设。两次都是**在真实输入上才暴露**。
> 结论：门禁除构造样例的正反测试外，必须**至少在一个真实资产上跑过一次**；
> CI 正是那个「真实输入」的提供者——它在一分钟内就给出了本地长时间发现不了的结论。

## 三点九、symlink 白名单与模板双源（review-r6）

### symlink 目标白名单（新增 `core/SymlinkPolicy.kt`，对齐参考坑 45）

参考坑 45 的教训是**双向**的：既要拒绝越界目标，也不能误伤合法的绝对链接
（其严格版校验只放行 `dest`，导致暂存解压时**静默丢弃** 9 个指向自身运行时的 applet）。

`SymlinkPolicy.classify`：相对目标以链接所在目录为基准规范化后必须仍在**解压根**内；
绝对目标必须落在**本应用数据目录**内。

**关键细节**：`appRoot` 取 `context.dataDir` 而非 `filesDir`——短前缀链接
`<dataDir>/t -> <filesDir>/termux/usr` 与官方镜像 `<dataDir>/data/data/...` 都建在
应用数据根上；只放行 `filesDir` 会误拒指向自身运行时的合法链接，正是坑 45 的形态。

`isWithin` 按**路径段**比较而非字符串前缀（`/ab` 不在 `/a` 之内，但 `startsWith` 会误判为真，
与参考坑 1「realpath 前缀混用」同族）。纯函数设计，`SymlinkPolicyTest` 穷举边界。

被拒条目**计数并落日志**——静默丢弃会让「归档损坏/被篡改」完全无感。

### 启动脚本模板双源一致性（新增 `LauncherTemplateTest`）

`DshFlow` 渲染 web 启动脚本时对模板做四次 `replace("@TOKEN@", …)`，资产缺失则退回
`DEFAULT_WEB_LAUNCHER_TPL`。**两份模板是同一契约的两个源**：任一方缺令牌，渲染
**不报错**，而是把 `@TOKEN@` 原样留在脚本里（如漏 `@EXPORTS@` → 引擎缺环境变量起不来）。
测试锁定两源占位符集合一致 + 与渲染逻辑消费的四个令牌一一对应 + 兜底模板的必要结构
（shebang / `cd @HOME@` / `nohup` / 日志重定向）。

## 三点十、Kotlin 静态预检升级（review-r6）

`tools/bracecheck-edited.cjs` 从「硬编码文件列表 + 非嵌套注释模型」升级为全量递归扫描，
并**修正了一个关于本项目历史 bug 的错误认知**：

- 此前把两次编译失败（`5cf987d`、`d617620`，`patched/**`）归因为「终止符提前结束注释」。
  实测提取修复前的文件字节后确认真因是：**Kotlin 块注释可嵌套**——KDoc 正文里的
  `/**` 序列**打开了一层嵌套注释**，本该结束 KDoc 的终止符只关掉内层，外层继续
  **吞掉后续代码**直到下一个终止符，于是报 `Missing '}'` / `Unclosed comment`。
- 门禁按 Kotlin 语义按嵌套深度扫描，报告未闭合与深度 >1 的位置。
  **反向验证**：对修复前的历史文件精准报出 `braces=1`（正是 CI 报的缺失 `}`）与
  「深度 2，首个起始行 369」。
- 误报治理：初版启发式（「注释结束后同行仍有内容」）会把合法的
  `{ /* 日志走 flow */ }` 判为违规（实测 2 处误报），已弃用该启发式改为嵌套深度判据；
  嵌套起始行只报**首个**（其后各行都是被吞进注释的正常 KDoc）。
- **本工具自身的注释也踩了这个坑两次**（编写时实测），可见隐蔽性——已写入约定。

> 元教训：**「文档记录的根因」也可能是错的**。本轮通过提取历史版本字节做对照实验，
> 纠正了前一轮自己写下的错误归因。经验证的门禁必须能对**真实的已知坏输入**报错，
> 而不是只对构造样例报错。

## 三点十一、运行环境专项核对（review-r7，读设备实况对账代码假设）

本轮方法不同以往：**不读参考项目，直接读本机实况**（`/proc`、`readlink`、`stat`、
渲染产物、真实执行），逐项与代码里的假设对账。**挖出 3 个真实缺陷，且全部无法被
CI 抓到**——静态门禁的盲区正是「代码假设 vs 设备事实」的差距。

### 缺陷 1（P1）：增量 patch 基线用 mtime，dpkg 保留归档时间 → 483 文件全部跳过

`PackageKit.ensure` 用「安装窗口开始时刻」作增量基线，比对 `f.lastModified()`。
但 `dpkg-deb -x` / tar **保留包内归档 mtime**：

| 文件 | mtime | 基线 |
|---|---|---|
| `bin/git` | 2026-07-05 | 2026-09-06 |
| `bin/wget` | 2025-08-31 | 2026-09-06 |

实测 `bin`+`lib` 共 **483 个文件全部被跳过、0 个被处理**，其中 **12 个至今带着官方
硬编码前缀** `/data/data/com.termux/files/usr`。**已在真机复现可见故障**：

```
$ git config --get user.name
fatal: unable to access '/data/data/com.termux/files/usr/etc/gitconfig': Permission denied
```

`git` 二进制内仍有 11 处官方前缀（`strings` 实测）。两个放大因素：
① `ready()` 早退使**存量设备永不自愈**；② `patchAll` 逐文件静默 catch，
日志只呈现 `patched files=0 skipped=483`，极易忽略。

**修复三层**：
1. `PrefixPatcher.shouldProcess` 判据改为 **ctime OR mtime**。ctime 由内核在落盘那刻
   写入、归档无法伪造；取「或」而非只用 ctime，是因为 Android 上 `creationTime()`
   的底层语义（statx birthtime 或回落 `st_ctime`）**无法在本环境实测**——
   拿未经验证的 API 语义下判断正是本项目已记录两次的失败模式。取「或」使正确性
   可证明：安装窗口内写入 → ctime 必刷新 → 一定处理；陈旧文件两戳都旧 → 才跳过。
2. `PackageKit.repairStalePrefixes`：在 `ready()` 早退分支插入**一次性自愈**
   （marker `prefix-repair` 控代次；失败不写 marker，下次重试）。
3. 开销实测：全量扫 `usr`（3835 文件 / 144MB）约 1.1s，仅升级后首启一次，
   且调用方均已在后台线程——注释中明确标注「不可挪到主线程」。

**验证**：复制 `bin/git` 做等长替换（11 处 → 0 处）后执行，`git init` 与 `git config`
**均不再报 EACCES**；对照未 patch 副本必现 `fatal: unable to access ... Permission denied`。

### 缺陷 2：短前缀 `t` 已是 `usr` 的别名，模板 shebang 却写成 `t/usr/bin/bash`

`readlink` 实测 `<dataDir>/t -> <filesDir>/termux/usr`，故正确路径是 `t/bin/bash`。
模板多写了一层 `/usr`，直接执行报 `bad interpreter: No such file or directory`（exit=126）。

**为何一直没暴露**：两条调用路径都写成 `bash <script>`（显式传解释器），
shebang 从未被内核读取。改成 `./dsh-web.sh` 就会立刻失败。

**修复**：shebang 改为 `t/bin/bash`；`LauncherTemplateTest` 新增
`资产模板 shebang 指向短前缀下的 bash`、`兜底模板 shebang 同样…`、
`短前缀与官方前缀等长`（等长是二进制等长替换的硬前提）。

### 缺陷 3：模板注释里的占位符字面量被渲染器一并展开

模板曾有一行 `# 可用占位符：@EXPORTS@ @HOME@ @NODE_CMD@ @LOG_FILE@`。
渲染是纯字符串 `replace`，**不区分注释与代码** → 生成一条真实执行的杂散命令
（` <home> <nodeCmd> <logFile>`，bash 报 `Is a directory`，exit=126）。
脚本无 `set -e` 才继续跑到真正的 `nohup`，功能表现完全正常。

**修复**：注释改为自然语言；测试补**计数**判据（每个占位符**恰好出现一次**）。

**为何原测试没抓到**：原测试用 `Set<String>` 比对令牌集合，而**注释里那份与真正那份
是同一字符串，集合比对会静默折叠重复**——集合相等照样通过。
**`Set` 对「重复」天然失明，凡关心出现次数必须用计数。**

### 本轮方法论

三个缺陷的共同形态是「**靠巧合工作**」——不是功能坏了，而是当前恰好没坏：

| 缺陷 | 为何当前正常 | 触发条件 |
|---|---|---|
| shebang 多一层 | 调用方都显式传 `bash <script>` | 改为 `./dsh-web.sh` |
| 注释占位符被展开 | 脚本无 `set -e`，杂散命令失败后继续 | 加 `set -e`，或杂散行恰好成功 |
| 增量 patch 全跳过 | 多数工具不碰硬编码路径 | 任何读 `etc/gitconfig` 的操作（已复现） |

**教训**：「跑得通」不等于「写对了」。排查环境问题应**主动验证那些「假设成立但从未被
检验」的前提**（路径是否真存在、时间戳语义是否如假设、替换是否区分上下文），
而不是等用户报障。这 3 个缺陷**没有一个是 CI 能抓到的**——正说明静态门禁与真机核对
各有职责边界，二者不可互替。

## 三点十二、内置插件专项对比与优化（review-r8）

### 两项目插件形态对照

| 维度 | 本项目 `extra-plugins/` | 参考项目 `plugins/` + `vendor/` |
|---|---|---|
| 数量 | 3（status-bridge / android-links / llm-codebuddy） | 5 plugins + 3 vendor |
| 源码形态 | 纯 JS（`lib/*.js` 直接入库） | TypeScript 源码 + `tsc` 构建 |
| 客户端面 | 仅 codebuddy 有 `dsh.client` | 多数有 `src/client/*.tsx` |
| **插件单测** | **0 个**（本轮前） | **每个插件都有** `test/*.test.mjs` |
| 事件桥方向 | HTTP `/status` + 壳侧轮询 | ndjson 文件 + 壳侧 `FileObserver` |

**结论**：形态差异属工程取舍，不改架构；但**「插件单测」这一项参考项目明显更成熟**，
已本轮补齐。事件桥方向（HTTP 轮询 vs ndjson tail）不采纳——本项目的
`PowerGovernor` 已实现按屏幕/任务态自适应 1s~30s 轮询，改造成本与收益不成正比。

### 挖出的三个插件缺陷（详见 `docs/AGENTS/gotchas.md` §13）

1. **`lastEvent` 无条件透传** → 高频 `assistant/chunk` 冲刷语义事件，壳侧文案降级为
   「dsh 运行中」。修复：`SEMANTIC_EVENTS` 白名单。
2. **`turn/end` 非 error 一律 finished** → 用户取消任务也弹「任务完成」通知 + TTS。
   修复：`TURN_END_STATUS` 显式映射，**只有 completed → finished**（schema 有六种 kind）。
3. **`chunk.type === 'block'` 死分支**（真实取值 `block-end`）→ 块式输出文本漏累积。

另发现**壳侧**缺陷：`PetSpeaker` 把 `lastSpokenKey` 写在 4s 节流检查**之前**，
被节流的事件永久消费掉键 → **每轮 4 秒内结束的对话都丢失「任务完成」台词**。

### 参考项目自身也有缺陷（不可盲抄）

其 `turn/end` 处理读 `d?.outcome === 'success'`，而**本机 schema 里没有 `outcome`
字段**（只有 `reason: { kind }`）→ `ok` 恒为 false。其注释写明的「被打断不弹」
意图正确，但实现读错了字段名。**跨项目借鉴必须对本机 schema 复核字段名。**

### 新增门禁 `tools/check-plugin-contract.cjs`（7 项）

语法 / 事件白名单↔壳侧分支 / 状态集合↔终态文案 / chunk 类型真实性 /
turn/end kind 覆盖 schema / **运行时驱动状态机** / 插件单测。

**反向验证**：静态 7/7、运行时 3/3、单测 3/3 全部拦下，恢复后通过。
其中「运行时驱动」是**被我自己犯的错逼出来的**——把 turn/end 重构成映射表时误删
`const kind` 声明，`A~E` 静态检查**全部通过**，真机执行却抛
`ReferenceError: kind is not defined`（且被 apply 的 try/catch 吞掉，表现只是
状态永远停在 running）。**静态检查看不见作用域错误，必须真跑一遍。**

**元教训**：初版门禁只校验「契约元素**存在**且覆盖 schema」，于是把
`SEMANTIC_EVENTS.has(type)` 改回无条件透传、映射表换成 if/else 兜底——**门禁全绿、
两个真实缺陷双双漏检**。**定义了却不使用的契约等于没有契约**，须断言使用点存在。

### 新增插件单测（对齐参考项目约定）

`app/src/main/assets/extra-plugins/dsh-status-bridge/test/status-bridge.test.mjs`，
17 个用例，`node:test` + `assert/strict` 零依赖。覆盖三个缺陷 + 工具配对 + 健壮性。

## 三点十三、bash 执行世界专项（review-r9，借鉴 dsh-shell-termux）

参考项目单独维护了一个插件 `dsh-shell-termux`（其 [GitHub 仓库](https://github.com/kelai141/dsh-shell-termux)，
258 行 TS）。本轮**读其设计文档 + 实读两侧源码 + 在本机实证**，挖出本项目一个
**比前两轮更严重的缺陷**。

### ★ 桌面沙箱执行器在 Android 上 fail-closed，默认档位下 bash 工具不可用

**机制**（全部源码实证，详见 `docs/AGENTS/gotchas.md` §14）：

| 环节 | 事实 |
|---|---|
| dsh-base 默认执行器 | `@deepseek-ai/dsh-bash-sandbox` |
| 非 danger-full-access 时的行为 | `this.ctx.sandbox.confine(["bash","-c",cmd], policy)` |
| sandbox provider 平台链条 | `PLATFORM_CHAINS = { linux, darwin, win32 }` —— **无 android** |
| `chainVerdict()` | `PLATFORM_CHAINS[platform] ?? []` → 空 → `"unavailable"` |
| `selectRunner()` | `unavailable` → **抛 `SandboxUnavailableError`** |
| dsh-base 会话默认档位 | `DSH_PERMISSION_MODE ?? 'workspace-write'` |

即：**默认档位下 Android 的 bash 工具会被沙箱 fail-closed 拒绝**。

**为何一直没暴露**：本机全部历史会话档位**恰好都是 `danger-full-access`**
（实测 10/10），该模式下 `run()` 直接 `return super.run(spec)`、**不走 confine**。
一旦用户切回默认档位，bash 工具即不可用。

### 参考项目的解法与本项目落地

参考项目该插件的**整个存在理由**正是这个实证，其设计文档原文：

> **结论：安卓上 bash 工具实际执行会被沙箱拒绝**（M0 只验证了服务启动，未验证工具执行）
> 即：**"碰巧能启动" ≠ "工具可用"**。

解法 = `bash-sandbox` 条目 `disabled` + 插入自建 `ctx.shell` provider，
并**诚实声明**沙箱语义（`enforcement: 'partial'`；真实边界是 SELinux 应用域 + 审批流，
不做假沙箱）。

本项目落地（`app/src/main/assets/extra-plugins/dsh-shell-termux/`）：

- `lib/index.js` — `TermuxBashExecutor extends LocalBashExecutor`（复用上游全部预算与
  生命周期语义），只加两处增量：① `resolve()` 显式注入 Termux 环境；
  ② `sandboxMode` 返回 `undefined`（上游契约允许：不支持沙箱时返回 undefined），
  不谎报某个档位已被路径级执行。
- `cordis.patch.yml` — 条件化 disable/insert，**双平台都限定 `process.platform`**
  （桌面保留真实沙箱，不因本项目而丢约束）。
- `test/shell-termux.test.mjs` — 21 用例。

### 显式环境注入的独立价值（实测）

即使绕开沙箱问题，环境注入本身也修掉一个真实缺口：dsh 默认执行器 spawn 的是
**裸 `"bash"`**，靠继承进程环境解析；而子进程环境 = `scrubbedParentEnv()` ⊕ spawn env，
**完全依赖 web 进程的 PATH/LD_LIBRARY_PATH 恰好正确**：

```
$ git --version
CANNOT LINK EXECUTABLE "git": library "libpcre2-8.so" not found   # 无注入
git version 2.55.0                                                # 注入后
```

端到端验证（真实 cordis ctx 装载本插件）：**删除进程的 `PATH`/`PREFIX`/`LD_LIBRARY_PATH`
后 `git --version` 仍正常** —— 注入是自包含的。

### 与参考实现的取舍（不盲抄）

| 参考做法 | 本项目决定 |
|---|---|
| 注入 `TERMUX_VERSION`（固定 `0.118.3`） | **不注入**：工作区与官方 Termux app 无交互、无消费方；伪造版本可能误导 pkg 兼容分支 |
| 注入 `DSH_WRITE_MODE`/`DSH_WORKSPACE`/`DSH_SHARED_DIRS` 并禁 request.env 覆盖 | **不注入**：本机 dsh 的写面闸门由 `dsh-sandbox-policy` 按会话档位事件裁决；实测 `grep -rl DSH_WRITE_MODE` 全树零命中 → 注入即死键 |
| TypeScript + tsc 构建 | 纯 JS（工作区 assets 无构建链），直接 import 上游 ESM 类 |
| `probe()` 报 bash 版本 | 保留结构化 probe，但不 spawn 取版本（避免装载期额外进程） |

### 装配契约门禁（§H）

本插件以 `ctx.shell` **唯一 provider** 身份替换默认执行器，装配写错的后果比原缺陷更糟：
① 未 disable `bash-sandbox` → 争抢单例；② disable 但 insert 未生效 → **无 provider，
bash 整体不可用**。故门禁核对：disable/insert 成对、均限定平台、三坐标齐备、
`inject` 声明、继承上游执行器。

**反向验证 3/4 → 修好 → 4/4**：初版用裸短语 `extends LocalBashExecutor` 做锚点，
**注释里提到该短语即算命中** → 「真实继承被改掉」时漏检；改锚定类声明后正确拦下。

## 三点十四、结构整理（review-r10，行为零变化）

目标不是「换个写法」，而是**消除已经产生真实漂移的重复**。三处重复各自收敛到单点：

### 1. `TermuxEnv`：三个环境构造器 → 一个内部构造器

`childShellEnv` / `webProcessExports` / `terminalSessionEnv` 此前各写一份「几乎相同」
的环境，共享 7 个键却各自维护，**已实测漂移**：

| 键 | 子 shell | web 进程 | 终端 PTY |
|---|---|---|---|
| PREFIX / LD_LIBRARY_PATH / OPENSSL_CONF / TERM / SHELL / LD_PRELOAD | 共享 | 共享 | 共享 |
| `LANG` | `C.UTF-8` | **遗漏** | `C.UTF-8` |

**真机实测**：web 进程 `/proc/<pid>/environ` **无 `LANG`**——影响工具的中文/UTF-8
输出判定。这属真实缺失，不是风格差异。

收敛后：共享键只写一次；差异（`HOME`/`TMPDIR`/PATH 顺序/`nodeDir`）全部走**显式参数
+ 注释说明为何不同**。顺带修掉一个同源错配——web 的 `LD_LIBRARY_PATH` 此前硬编码推导
`filesDir/node/lib`，而 PATH 用调用方传入的 `nodeDir`；现在同一个 `nodeDir` 派生，
不可能再出现「PATH 指向 A 的 node、LD 指向 B 的 lib」。

**行为保持验证**：三种场景的 PATH 输出与旧实现**逐字节一致**（脚本对照，非目测）。
公开面审计后从 5 个降到 3 个（`nodeLibDir`/`ldLibraryPath` 转 private，
`nodeBinDir` 无消费者直接删）。

### 2. `LocalHttp`：4 处重复探测 → 单一入口

`DshFlow.httpResponds` / `DshWatchdog.isUp` / `StatusBridgeService.fetchStatus` /
`KeepAliveAccessibilityService.fetchStatus` 此前各自实现「建连→设超时→GET→判码→断开」，
连超时值与 `disconnect` 位置都已出现细微差异。收敛为 `responds`/`getText`/`getJson`，
两条硬约束写进类型文档（必须 `NO_PROXY`、`disconnect` 必进 `finally`）。
`DshFlow.localConnection` 随之成为死代码并删除（连带 2 个 unused import）。

### 3. `BridgeStatus`：2 处手写 JSON 解析 → 共享模型

插件 `/status` 是跨进程契约，此前壳侧两处各自解析，字段名与默认值散落在四处字面量
（插件加 `toolName` 时两处都要手改）。收敛为 `BridgeStatus.parse`，
并修正一个真实陷阱：`JSONObject.optString(key, null)` 在**键存在但值为 JSON null** 时
返回**字面量 `"null"`**——下游会把 `"null"` 当真实事件名。

### 测试把新不变量钉死

- 「三处环境对共享键取值一致」→ 新增消费方漏键立刻失败（`LANG` 那种漂移不可能再发生）
- 「web 的 LD 与 PATH 同源」「export 顺序稳定」「各 PATH 顺序符合设计」
- `BridgeStatus` 解析契约（JSON null / 空串 / 未知状态 / 类型不匹配）
- `LocalHttp` 失败降级语义

### 本轮 CI 抓到的自身缺陷

1. **静态预检抓到我的 `/` 反引号方法名**（review-r8 加的那条规则）——门禁对作者同样生效。
2. **`BridgeStatusTest` 缺 Robolectric runner**：`isReturnDefaultValues = true` 下
   `org.json` 被桩掉，7 个用例全 NPE。本仓既有 8 个测试类都带 runner，本测试是
   **首个直接用 `org.json` 的测试**而漏了该约定（`BackupManagerTest` 是反证：它经
   `create()` 走到 `JSONObject` 且通过）。已记入 gotchas §15。

> 方法沉淀（gotchas §16）：整理前**先对账不改码**——把重复方的输出逐字节对照，
> 区分「刻意差异」与「漂移」；刻意差异整理后必须变成显式参数+注释，
> 而不是继续依赖「两份代码各自碰巧一样」。

## 四、后续重构排期建议（未落地）

1. **P2**：`BridgeOverlayManager.kt`（1287 行）按「窗口管理/状态机/交互」三块拆分——参考项目 OverlayService(712)/OverlayPanel(837)/OverlayController 分层值得照抄。
2. **P2**：`PluginManagerActivity.kt`（1135 行）UI 与逻辑分离（Repository 模式），JSON 解析散落 4 处 `readText()` 收敛到单点。
3. **P2**：**急救 CLI（参考 undo-emergency.mjs）**——与引擎平级、dsh 完全起不来时仍可执行的
   脚本级恢复通道（list/restore/safe-mode/boot-state）。工作区已有 BackupManager 的 zip
   备份/恢复，缺的是「不经 dsh、不经 Android UI 也能跑」的那一层。
4. **P3**：引入 `UndoGate` 式快照回撤（备份 zip 机制已具备，差「自动触发+恢复+验证」闭环）。
5. ~~**P3**：补 symlink 目标白名单~~ → **review-r6 已落地**（`core/SymlinkPolicy.kt` + 接入解压 + 测试）。
6. **P3**：`BackupManager.restore` 的 `isSafeRel` 已挡路径穿越，但可加「恢复前校验归档内
   符号链接目标」与「恢复失败可回退」——当前 restore 是合并覆盖、无事务（参考项目
   SnapshotTransaction 的关注点，npm 模式下对应物是备份 zip 的回滚）。

## 五、验证说明

设备端无 JDK/Android SDK，无法本地执行 `gradlew` 编译与单测；验证通过三级门禁完成：
- **本地静态**：`tools/bracecheck-edited.cjs`（全量 .kt 括号平衡 + Kotlin 嵌套注释扫描）、
  `tools/check-asset-abi.cjs`（ELF 架构）、载荷字节级一致性比对
  （`tools/verify-payload-extraction.cjs`）
- **资产脚本门禁**：`tools/check-asset-scripts.cjs`（本地 + CI 双跑，含故意写坏载荷的
  反向验证）
- **CI 端**：`ci.yml` 编译门禁 + 单测门禁在 GitHub Actions 上真实执行；
  `build-apk.yml` 产出 debug APK

**本轮新增门禁**：ABI 门禁、Kotlin 静态预检接入 CI（均在 gradle 之前，最先卡关）。

> 注：本文件记录的四轮改动（P0/P1 防御性修补 → 环境链路单源化 → 脚本层载荷外置 →
> 进程终止链路/ABI/符号链接）全部经 CI 验证。过程中门禁抓到本模型引入的多个缺陷：
> `progressBar` 局部变量作用域、单源一致性测试基准漏参、KDoc 内 `patched/**` 触发嵌套注释、
> 本轮 `NodeProcs` 初版宽松后缀匹配（会被自己的单测抓出，会让
> `/data/user/0/com.other.app/files/node/bin/node` 误判为自己人）、
> `killAllNode` 变阻塞后在主线程回调里的 ANR 风险——均由门禁/自测拦截后修复，
> 佐证「编译/单测/静态门禁」在设备端无 JDK 场景下的不可替代性。

## 六、改动文件清单

### review-r3（防御性修补）
- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（P0-1/P0-2/P1-1/P1-2）
- `app/src/main/java/com/dsh/launcher/core/DshWatchdog.kt`（P0-1）
- `app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt`（P0-1/P2-1）
- `app/src/main/java/com/dsh/launcher/service/KeepAliveAccessibilityService.kt`（P0-1）
- `app/src/main/java/com/dsh/launcher/ui/WebViewActivity.kt`（P1-3/P1-4）

### review-r4（环境链路单源化）
- `app/src/main/java/com/dsh/launcher/core/TermuxEnv.kt`（SHELL 键、terminalSessionEnv 单源化）
- `app/src/main/java/com/dsh/launcher/core/NodeRuntime.kt`（nodeEnvPrefix 退役）
- `app/src/main/java/com/dsh/launcher/core/BootstrapInstaller.kt`（短前缀 fail-loudly）
- `app/src/main/java/com/dsh/launcher/ui/ConsoleActivity.kt`（改走统一环境）
- `app/src/test/java/com/dsh/launcher/core/TermuxEnvTest.kt`（单源一致性回归）

### review-r5（脚本层）
- `app/src/main/assets/stub-dsh.mjs`（载荷外置 + 内容比对幂等 + 锚点计数）
- `app/src/main/assets/patched/{koffi-stub.mjs,koffi-stub.cjs,node-pty-stub.cjs,sharp-shim.cjs}`（新）
- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（syncCompatAssets、补丁集指纹）
- `.github/workflows/ci.yml`、`.github/workflows/build-apk.yml`（资产脚本门禁）
- `tools/check-asset-scripts.cjs`、`tools/migrate-stub-payloads.cjs`、
  `tools/verify-payload-extraction.cjs`、`tools/bracecheck-edited.cjs`

### review-r6（进程终止链路 / ABI / 符号链接 / 静态预检）
- `app/src/main/java/com/dsh/launcher/core/NodeProcs.kt`（**新增**，进程枚举与终止唯一入口）
- `app/src/main/java/com/dsh/launcher/core/SymlinkPolicy.kt`（**新增**，解压期链接目标白名单）
- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（killAllNode 委托 NodeProcs 并返回 Boolean、
  nodeProcessAlive 同源化、killAllNode 调用点注释）
- `app/src/main/java/com/dsh/launcher/core/NodeRuntime.kt`（接入 SymlinkPolicy、appRoot=dataDir、
  链接创建失败落日志）
- `app/src/main/java/com/dsh/launcher/ui/MainActivity.kt`（stopDshAll 去 pkill -f、
  confirmRollback 移出主线程避免 ANR）
- `app/src/test/java/com/dsh/launcher/core/{NodeProcsTest,SymlinkPolicyTest,LauncherTemplateTest}.kt`（**新增**）
- `tools/check-asset-abi.cjs`（**新增**，ELF 架构门禁）、`tools/bracecheck-edited.cjs`（重写：
  全量递归 + Kotlin 嵌套注释语义）
- `.github/workflows/ci.yml`（ABI 门禁 + Kotlin 静态预检）、`.github/workflows/build-apk.yml`（ABI 门禁）
- `AGENTS.md`（**新增**，开发地图索引主文件）、`docs/AGENTS/gotchas.md`（**新增**，9 条坑登记）

### review-r7（运行环境专项核对：读设备实况对账代码假设）
- `app/src/main/java/com/dsh/launcher/core/PrefixPatcher.kt`（**shouldProcess 判据
  mtime → ctime OR mtime**，缺陷 1 核心修复；参数改名 minTsMs）
- `app/src/main/java/com/dsh/launcher/core/PackageKit.kt`（**新增 repairStalePrefixes
  存量自愈通道** + `prefix-repair` marker；基线注释修正）
- `app/src/main/assets/web-launcher.sh.tpl`（shebang 去多余 `/usr`；注释不再含占位符字面量）
- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（兜底模板 shebang 同步修正、
  抽出纯函数 `renderWebLauncher`、新增 `WEB_LAUNCHER_TOKENS`、渲染后残留占位符告警）
- `app/src/main/java/com/dsh/launcher/core/SymlinkPolicy.kt`（注释纠正 `t` 即 `usr` 别名）
- `app/src/test/java/com/dsh/launcher/core/LauncherTemplateTest.kt`（**计数判据**替换
  Set 判据、shebang 断言、前缀等长断言、渲染端到端无杂散行）
- `app/src/test/java/com/dsh/launcher/core/PrefixPatcherTest.kt`（**归档 mtime 陈旧但
  ctime 新**回归 + shouldProcess 边界）

### review-r8（内置插件对比与优化）
- `app/src/main/assets/extra-plugins/dsh-status-bridge/lib/index.js`（**SEMANTIC_EVENTS
  语义白名单**、**TURN_END_STATUS 显式映射**、工具活动字段 toolName/toolArgs/lastTool、
  chunk 死分支 `block`→`block-end`、`__testing` 导出面；版本 0.1.1→0.1.2）
- `app/src/main/assets/extra-plugins/dsh-status-bridge/test/status-bridge.test.mjs`（**新增**，
  17 个 `node:test` 用例——本项目首个插件单测，对齐参考项目约定）
- `app/src/main/java/com/dsh/launcher/overlay/StatusOverlay.kt`（`toolName` 参数、
  `aborted`/`blocked` 终态文案、`tool/result` 文案）
- `app/src/main/java/com/dsh/launcher/overlay/PetSpeaker.kt`（**键记录下沉到各分支**，
  修复被节流事件永久消费键导致台词丢失）
- `app/src/main/java/com/dsh/launcher/overlay/PetOverlayView.kt`（aborted/blocked → ROW_WAITING）
- `app/src/main/java/com/dsh/launcher/overlay/BridgeOverlayManager.kt`（`lastToolName` 字段贯通）
- `app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt`（解析 `toolName` 并透传）
- `app/src/main/java/com/dsh/launcher/service/KeepAliveAccessibilityService.kt`（同上，a11y 通道）
- `tools/check-plugin-contract.cjs`（**新增**，7 项契约门禁：语法/事件白名单/状态集合/
  chunk 类型/turn-end 覆盖/运行时驱动/插件单测）
- `.github/workflows/ci.yml`（接入插件契约门禁）


### review-r9（bash 执行世界专项：借鉴 dsh-shell-termux）
- `app/src/main/assets/extra-plugins/dsh-shell-termux/`（**新增内置插件**）
  - `lib/index.js`（`TermuxBashExecutor extends LocalBashExecutor`：显式环境注入 +
    `sandboxMode=undefined` 诚实声明 + `checkBashExecutable` X_OK fail-loudly +
    `probeWorld` 结构化探测）
  - `cordis.patch.yml`（条件化 `bash-sandbox: disabled` + insert 本插件，双平台限定）
  - `package.json`（peerDeps 范围声明，不硬编码版本）
  - `test/shell-termux.test.mjs`（**新增**，21 用例）
- `app/src/main/assets/install-dsh.mjs`（BUILTIN_PLUGINS / BUILTIN_NAMES / BUILTIN_IDS 三处登记）
- `app/src/main/java/com/dsh/launcher/ui/PluginManagerActivity.kt`（BUNDLED + BUNDLED_DESC 登记）
- `tools/check-plugin-contract.cjs`（**新增 §H 装配契约检查**：disable/insert 成对、
  平台限定、三坐标齐备、inject 声明、继承锚定类声明）
- `docs/AGENTS/gotchas.md`（新增 §14）、`docs/comparison-with-mobile-apk.md`（本节）
### review-r10（结构整理：消除已漂移的重复）
- `app/src/main/java/com/dsh/launcher/core/TermuxEnv.kt`（**三个构造器收敛为一个内部
  `build()`**；共享键单点产出；差异显式参数化；公开面 5 → 3）
- `app/src/main/java/com/dsh/launcher/core/LocalHttp.kt`（**新增**，4 处重复探测的单一入口）
- `app/src/main/java/com/dsh/launcher/core/BridgeStatus.kt`（**新增**，`/status` 契约共享模型
  + `optNullableString` 修正 JSON-null 陷阱）
- `app/src/main/java/com/dsh/launcher/core/DshFlow.kt`（`httpResponds` 委托；删死代码
  `localConnection` 与 2 个 unused import）
- `app/src/main/java/com/dsh/launcher/core/DshWatchdog.kt`（`isUp` 委托，减 20 行）
- `app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt`（`fetchStatus` 委托；
  `STATUS_URL` 提为共享常量；配置读取改用共享模型）
- `app/src/main/java/com/dsh/launcher/service/KeepAliveAccessibilityService.kt`（同上；
  删除本地 `StatusData` 内部类与 4 个 unused import）
- `app/src/test/java/com/dsh/launcher/core/TermuxEnvTest.kt`（+5 用例：共享键三处一致等）
- `app/src/test/java/com/dsh/launcher/core/LocalHttpTest.kt`（**新增**，BridgeStatus 解析契约
  + LocalHttp 降级语义，含 Robolectric runner）
- `docs/AGENTS/gotchas.md`（新增 §15 `org.json` 桩陷阱、§16 结构整理方法）
