# AGENTS.md — dsh-launcher-android 开发地图（索引主文件）

> **AI 主动更新条款**：本文件是权威入口，采用「主文件索引 + `docs/AGENTS/` 详档」结构。
> 任何代码变更导致描述失真时：① 主文件对应行当轮更新；② 细节写入详情文档
> （坑 → `docs/AGENTS/gotchas.md` 追加递增编号）。**文档与源码不一致时以源码为准并当场修正。**
> 查询规范：优先 grep 详档定位，不要凭记忆猜细节。
>
> 样板来源：参考项目 `kelai141/dsh-mobile-apk` 的同名文档体系。**两项目坑号不互通**，
> 跨项目引用须写明「参考坑 N」。

---

## 1. 仓库概览

- **角色**：DeepSeek Harness（dsh）安卓壳应用（`com.dsh.launcher`，versionName 4.10.2-fix6 /
  versionCode 300）。提供 Termux 用户态、Node 运行时、引擎守护、WebView 界面、悬浮窗桌宠、
  备份恢复、插件管理器、内置终端与控制台。
- **运行时形态**：**官方 npm 安装** `@deepseek-ai/dsh`（钉死 `0.1.1-rc.1`，见
  `DshFlow.PINNED_DSH_TAG`）到 `files/dsh-prefix`；内置 Termux bootstrap 提供 bash 与用户态；
  node 由 LFS 资产解压到 `files/node`；web 监听 `127.0.0.1:3080`。
  **注意**：这与参考项目「内嵌 155MB Termux 快照」是**不同的运行时策略**，
  借鉴其防御性细节时不要照搬架构。
- **构建**：minSdk 24 / targetSdk 28 / compileSdk 35；AGP 9.0；Kotlin；Gradle 9.1.0；Java 17。
  `targetSdk=28` 用于对齐 Termux 的 SELinux 域（`untrusted_app_27`），并豁免 Android W^X
  的 exec 限制——**不要随手调高**，会破坏 node 的可执行性（见 gotchas §9）。
- **CI**：`.github/workflows/ci.yml`（编译门禁 + 单测 + 静态门禁）、`build-apk.yml`
  （manual/`main` 触发，debug/release/both）、`release.yml`（发版）。
  **所有 checkout 必须带 `lfs: true`**（见 gotchas §7）。
- **设备端限制**：本项目开发设备**无 JDK/Android SDK**，无法本地跑 gradle。
  一切编译/单测验证走 GitHub Actions；本地只做静态预检（详见 §2 门禁链）。

## 2. 门禁链（本地可跑 → CI 全量）

| 命令 | 作用 | 本地 | CI |
|---|---|---|---|
| `node tools/check-asset-scripts.cjs` | assets 脚本语法 + 补丁载荷完整性 | ✅ | ✅ |
| `node tools/check-boot-assets.cjs` | **引导期资产供给一致性**（`BOOT_SCRIPTS` ↔ `--import` 引用 ↔ assets） | ✅ | ✅ |
| `node tools/check-asset-abi.cjs` | 内置 node 归档 ELF 架构 vs 文件名声明 | ✅（LFS 未拉时 SKIP） | ✅ |
| `node tools/bracecheck-edited.cjs` | Kotlin 括号平衡 + 注释闭合 + 嵌套扫描 | ✅ | ✅ |
| `node tools/check-plugin-contract.cjs` | 插件↔壳侧事件契约 + 运行时驱动 + 插件单测 | ✅（dsh 未装时部分 SKIP） | ✅ |
| `./gradlew :app:assembleDebug` | 编译门禁 | ❌ 无 SDK | ✅ |
| `./gradlew :app:testDebugUnitTest` | 单测门禁 | ❌ 无 SDK | ✅ |

设备端跑 node 脚本时需带环境（否则 `node` 找不到库）：

```sh
export LD_LIBRARY_PATH=/data/user/0/com.dsh.launcher/files/node/lib
export OPENSSL_CONF=/dev/null
/data/user/0/com.dsh.launcher/files/node/bin/node tools/<script>.cjs
```

## 3. 高频雷点 TOP（一行一条；全量见 `docs/AGENTS/gotchas.md`）

- **坑 1**：`ps -A` 在 Android toybox 上是 `PID TTY TIME CMD` 列序，`awk '{print $2}'`
  取到的是 **TTY 列**（恒为 `?`）→ 终止链路全线静默失效。**进程枚举一律走 `NodeProcs`**，
  禁止 `ps | grep | awk` 与 `pkill -f`。
- **坑 2**：`/data/data` ≡ `/data/user/0` 别名——进程归属与路径包含判定**必须双侧规范化**，
  且按**路径段**比较而非字符串前缀。
- **坑 3**：错 ABI 内置 node 装到真机 = **引擎启动即崩**（参考坑 18/30）。改 node 资产后
  必跑 ABI 门禁。
- **坑 4**：**Kotlin 块注释可嵌套**——KDoc 正文里写注释起始符会吞掉后续代码，
  报 `Missing '}'` / `Unclosed comment`（本项目两次真实事故）。
- **坑 5**：归档符号链接目标必须白名单（`SymlinkPolicy`）——既要拒绝 `../../` 逃逸，
  也要放行指向自身运行时的合法绝对链接（参考坑 45 曾静默丢弃 9 个 applet）。
- **坑 6**：启动脚本模板是双源（资产 + 兜底常量），占位符漂移会**静默**渲染出缺配脚本。
- **坑 8**：环境变量字面量只允许出现在 `TermuxEnv`（已发生两次真实漂移事故）。
- **坑 9**：短前缀链接 `/data/user/0/com.dsh.launcher/t`（31 字符，与官方
  `/data/data/com.termux/files/usr` 等长）是官方二进制的硬前提，必须在 patch 前创建。
  **`t` 本身即 `usr` 的别名**，故 bash 是 `t/bin/bash`；写成 `t/usr/bin/bash` 会
  `bad interpreter`（exit=126）。
- **坑 10**：**判定「哪些文件是本次操作产生的」不得依赖 mtime**——dpkg/tar 保留包内
  归档时间，曾致 483 文件被增量 patch 全部跳过、12 个文件永久带着官方硬编码前缀
  （`git config` 报 EACCES）。用 ctime，或在内容层面判定。
- **坑 11**：模板注释里写占位符字面量会被纯字符串渲染一并展开成真实执行的杂散命令；
  且 `Set` 比对令牌集合对「重复」天然失明，**关心出现次数必须用计数**。
- **坑 12**：「跑得通」不等于「写对了」——现有 3 个缺陷全是「靠巧合工作」形态，
  **没有一个能被 CI 捕获**，只能靠读设备实况与代码假设对账发现。
- **坑 13**：插件与壳侧的「事件名 ↔ 文案」是**跨边界契约**，无机械校验必漂移
  （实测三缺陷：高频 chunk 冲刷语义事件、aborted 误报「任务完成」、chunk 类型死分支）。
  改任一方契约面后必跑 `check-plugin-contract.cjs`；
  **定义了却不使用的契约等于没有契约**（白名单/映射表须断言使用点存在）。
- **坑 14**（★最严重）：**Android 上桌面沙箱执行器 fail-closed**——
  `dsh-sandbox-local` 的 `PLATFORM_CHAINS` **无 android** → 空链条 →
  `SandboxUnavailableError`；而 dsh-base 会话默认档位是 `workspace-write`
  → **默认档位下 bash 工具不可用**。本机因历史会话恰好都是 `danger-full-access`
  而侥幸可用（该模式不走 confine）。解法见内置插件 `dsh-shell-termux`
  （disable `bash-sandbox` + 自建 `ctx.shell` provider）。详见 gotchas §14。
- **坑 15**：纯 JVM 单测里 `org.json` 等 android 类**被桩掉**（`isReturnDefaultValues
  = true`）→ `JSONObject` 构造后任何 `optXxx` 抛 NPE。**碰 android 类的单测一律带
  `@RunWith(RobolectricTestRunner::class)`**（本仓 8 个测试类的既有约定）。
  识别信号：NPE 堆栈指向 android 类**内部**而非被测代码。详见 gotchas §15。
- **坑 16**（★致命）：`cordis.patch.yml` 里 `!!js` 表达式**不得以裸反引号开头**——
  YAML 里 `` ` `` 是保留指示符，js-yaml 报 `cannot resolve a node with …js`，
  而 dsh 的 patch 解析**失败即抛** → **dsh 启动即崩**（不是"表达式没生效"）。
  用字符串拼接：`!!js (process.env.X ?? '') + '/bin/y'`。
  **改任何 patch 后立即用 `dsh --patch <file> --dump-config` 验证**（只解析不启动，
  零风险，且是唯一权威判定）。详见 gotchas §17。
- **坑 18**（★致命）：**删掉「供给点」没有门禁守着**——`abae4ff` 把安装路径的
  三件套拷贝循环换成只同步 `patched/` 的函数，`fs-register.mjs` 从此无供给点，
  而 `startDshWeb` 的命令仍硬引用它 → 首次安装 `ERR_MODULE_NOT_FOUND` 硬失败
  （**不是降级**；node 对缺失的 `--import` 是 exit=1）。
  四道门禁全绿（assets 齐全 + 语法正确）。现由 `BOOT_SCRIPTS` 单源清单
  + `tools/check-boot-assets.cjs`（从命令串反解 `--import` 目标）守着。
  **重构删除任何「清单/拷贝/注册」逻辑时，必须问：它的消费者还拿得到东西吗？** 详见 gotchas §18。
- **坑 19**（★致命）：**用从不递增的量当变更判据 = 死代码**。
  `syncAssetsOnApkUpdate` 以 `versionCode` 判断「APK 是否升级」，
  而本仓 `versionCode` 是硬编码常量 300 → 首次安装后该函数**永不执行**
  （真机实证：设备上 `install-dsh.mjs` 比 APK 内旧 92 字节）。
  判据改用 `AssetSync.apkInstallStamp()`（APK 路径+长度+mtime），
  且**标记必须在工作成功之后才写**。详见 gotchas §19。
- **坑 20**：**破坏性门禁验证必须在仓库外做**。本轮我曾在仓库内把 LFS 资产改成
  垃圾内容，`cp` 到 `/tmp` 备份因目录不可写而静默失败 → 无备份即覆盖；
  恢复需 `git cat-file blob HEAD:<path>`（设备上 `git-lfs` 无法执行，
  `git checkout` 会 smudge 失败）。**不要给子代理下达宽泛的"可运行工具"授权**。详见 gotchas §20。

## 4. 详档路由表

| 要查什么 | 文档 |
|---|---|
| 坑 N 详情 / 新坑登记 | `docs/AGENTS/gotchas.md` |
| 与参考项目的差距分析与重构记录 | `docs/comparison-with-mobile-apk.md` |
| 参考项目适配 dsh 的机制分析 | `docs/how-reference-adapts-dsh.md` |
| 架构优化方案 | `docs/architecture-optimization-plan.md` |
| 历次评审发现 | `docs/review-findings-r1.md`、`-r2.md`、`-scripts.md` |
| 插件转换审计/勘察 | `docs/plugin-conversion-audit.md`、`plugin-conversion-recon.md` |

## 5. 核心模块速查（`app/src/main/java/com/dsh/launcher/`）

| 模块 | 职责 |
|---|---|
| `core/DshFlow.kt` | 启动/安装主流程、web 就绪等待、日志尾部读取、进程终止入口 |
| `core/NodeProcs.kt` | **本应用 node 进程的枚举与终止（唯一入口）** |
| `core/TermuxEnv.kt` | **子进程环境的唯一工厂**（所有 env 字面量只在此处） |
| `core/TermuxRuntime.kt` | Termux 路径解析（prefix/home/tmp/bash）与就绪判定 |
| `core/NodeRuntime.kt` | 内置 node 解压 + W^X 权限收敛 + 符号链接白名单 |
| `core/SymlinkPolicy.kt` | 解压期符号链接目标白名单（纯函数，可单测） |
| `core/BootstrapInstaller.kt` | Termux bootstrap 解压、短前缀链接、官方镜像 |
| `core/Proc.kt` | 统一子进程执行器（超时、流式输出、W^X 自动放开） |
| `core/LocalHttp.kt` | **本机回环 HTTP 唯一入口**（一律 `Proxy.NO_PROXY`；`disconnect` 进 finally） |
| `core/BridgeStatus.kt` | `/status` 插件契约共享模型（壳侧唯一解析点） |
| `core/Supervisor.kt` / `DshWatchdog.kt` | 保活期望态、退避拉起、崩溃循环回滚 |
| `core/BackupManager.kt` | 备份/恢复（zip + manifest，KEEP_MAX=5） |
| `assets/stub-dsh.mjs` | dsh 启动期补丁 stub（载荷见 `assets/patched/`） |
| `assets/install-dsh.mjs` | 官方 npm 安装 dsh + 内置插件装配 |
| `assets/extra-plugins/dsh-shell-termux/` | **Android 原生 bash 执行器**（替换会在 Android fail-closed 的桌面沙箱执行器；见坑 14） |
| `tools/*.cjs` | 门禁与一次性迁移/验证工具 |

## 6. 维护约定（硬约束）

1. **进程操作**：只用 `NodeProcs` / `DshFlow.killAllNode`；禁止 `ps|grep|awk`、`pkill -f`。
2. **环境变量**：字面量只允许出现在 `TermuxEnv`；三个环境函数共用内部 `build()`，
   新增键须落在**共享键**段（而非某个函数内），并同步 `TermuxEnvTest` 的
   「三处环境对共享键取值一致」回归。见坑 8。
3. **子进程**：一律走 `Proc.run`（自带超时与流消费）；直用 `ProcessBuilder` 需说明理由。
4. **本机回环 HTTP**：一律走 `LocalHttp`（`NO_PROXY` + `disconnect` 进 finally），
   禁止再写裸 `openConnection`；插件 `/status` 一律经 `BridgeStatus.parse` 解析。
5. **单测碰 android 类须带 Robolectric**：`org.json` / `android.util.*` 在纯 JVM 下被桩掉
   会抛 NPE。见坑 15。
6. **结构整理先对账再动手**：合并重复实现前把各方输出**逐字节对照**，区分「刻意差异」
   （整理后须成为显式参数 + 注释）与「漂移」（按缺陷修）。见 gotchas §16。
7. **补丁载荷**：`assets/patched/` 是真实文件（非 base64 内嵌），改动后跑资产脚本门禁；
   幂等靠**内容指纹**而非版本 marker（参考项目 v1→v2 静默跳过事故）。
8. **模板/兜底双源**：任何「资产 + 内联兜底」对必须在测试中锁定占位符集合一致。
9. **KDoc**：正文里不写注释起始/终止符号字面量；提目录通配写 `patched/` 而非 `patched/**`。
10. **大资产**：LFS 文件（node/prebuilt/bootstrap）变更后必须跑 ABI 门禁并确认 workflow
   仍带 `lfs: true`。
11. **时间戳判据**：判断「文件是否本次操作产生」**禁止用 mtime**（dpkg/tar/`cp -p`/
   `rsync -t`/`git checkout` 都保留源时间戳）；用 ctime，或在内容层面判定
   （patch 幂等，多处理无副作用）。见坑 10。
12. **模板占位符**：注释与文档里**不得出现占位符字面量**（纯字符串替换会一并展开）；
   渲染类测试用**计数**判据而非 `Set` 比对（`Set` 对重复天然失明）。见坑 11。
13. **前缀路径**：短前缀 `t` 即 `usr` 的别名，路径写 `t/bin/...`；新增任何硬编码
   `/data/user/0/com.dsh.launcher/t…` 前先用 `readlink` 确认语义。见坑 9。
14. **长耗时 IO 不进主线程**：`ensureHarnessTools` 等含全树扫描的函数（实测 ~1s）
    调用方必须包裹 `thread { }`。
15. **环境类改动须读设备实况**：路径存在性、时间戳语义、符号链接指向等前提，
    必须用 `readlink`/`stat`/`strings` 在真机核对后再改——坑 12 的 3 个缺陷
    无一能被 CI 捕获。
16. **插件契约面**：改 `extra-plugins/*/lib` 的事件名/状态值，或改壳侧
    `StatusOverlay.statusLabel` / `PetSpeaker` / `PetOverlayView` 的对应分支，
    **必须同步另一方**并跑 `check-plugin-contract.cjs`。插件须导出 `__testing` 面
    （门禁靠它做运行时驱动），新增状态机分支须补 `test/*.test.mjs`。见坑 13。
17. **跨项目借鉴须复核字段名**：参考项目的注释可能与其实现在细节上不一致
    （如它读 `turn/end.outcome`，而本机 schema 只有 `reason`）。借鉴前对着
    **本机 dsh 的 `types.d.ts`** 核一遍字段名与联合类型取值。
18. **执行世界坐标靠显式注入**：不要让子进程依赖「进程环境恰好正确」——
    dsh 默认执行器 spawn 裸 `"bash"`，子进程环境 = `scrubbedParentEnv()` ⊕ spawn env，
    缺 `LD_LIBRARY_PATH` 时 Termux 二进制直接 `CANNOT LINK`（实测）。
    改 `dsh-shell-termux` 的 `buildTermuxEnv` 时**必须保留继承段兜底**
    （否则注入的 PATH 会覆盖父 PATH、丢掉引擎自带 `node/bin`）。见坑 14。
19. **改 `ctx.shell` 装配面须跑装配门禁**：`dsh-shell-termux` 以唯一 provider 身份
    替换默认执行器，写错的后果是「bash 整体不可用」（比原缺陷更糟）。
    任何 disable/insert/坐标/继承改动后跑 `check-plugin-contract.cjs` 的 §H。
20. **改任何 `cordis.patch.yml` 后用 dsh 自己验证**：
    `dsh --patch <file> --dump-config`（只解析、不启动引擎，零风险）。
    这是判定 patch 能否被接受的**唯一权威**方式——`!!js` 反引号那类陷阱
    所有静态检查都看不见，而 dsh 的 patch 解析**失败即抛**（= 启动失败）。见坑 16。
21. **引导期资产只允许一个供给点**：`files/` 根下的引导脚本（`fs-register.mjs` /
    `fs-loader.mjs` / `fs-promises-compat.mjs` / `stub-dsh.mjs`）**只经
    `DshFlow.syncBootAssets()` 供给**，清单是 `DshFlow.BOOT_SCRIPTS`。
    新增任何「被启动命令引用的脚本」必须同时加进该清单，
    且 `startDshWeb` 的命令串**不得手写字面量文件名**（用常量拼接）。
    改完跑 `check-boot-assets.cjs`。见坑 18。
22. **变更判据不得用从不递增的量**：`versionCode`（硬编码 300）、手写 marker、
    固定字符串都不是「资产已更新」的信号。判据用**内容指纹**
    （`AssetSync.fingerprintOf`）或 `apkInstallStamp()`；且**标记必须在工作成功之后写**，
    否则一次失败即永久失去重试。见坑 19。
23. **破坏性验证只在仓库外副本做**：绝不在仓库内覆盖/删除受版本控制的文件做测试；
    脚本里的 `cp`/`mv` 必须检查退出码。**给子代理的授权要写明「只读」或「仅副本内」**，
    事后对账 `git status`。见坑 20。
