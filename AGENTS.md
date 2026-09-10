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
| `node tools/check-asset-abi.cjs` | 内置 node 归档 ELF 架构 vs 文件名声明 | ✅（LFS 未拉时 SKIP） | ✅ |
| `node tools/bracecheck-edited.cjs` | Kotlin 括号平衡 + 注释闭合 + 嵌套扫描 | ✅ | ✅ |
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
| `core/Supervisor.kt` / `DshWatchdog.kt` | 保活期望态、退避拉起、崩溃循环回滚 |
| `core/BackupManager.kt` | 备份/恢复（zip + manifest，KEEP_MAX=5） |
| `assets/stub-dsh.mjs` | dsh 启动期补丁 stub（载荷见 `assets/patched/`） |
| `assets/install-dsh.mjs` | 官方 npm 安装 dsh + 内置插件装配 |
| `tools/*.cjs` | 门禁与一次性迁移/验证工具 |

## 6. 维护约定（硬约束）

1. **进程操作**：只用 `NodeProcs` / `DshFlow.killAllNode`；禁止 `ps|grep|awk`、`pkill -f`。
2. **环境变量**：字面量只允许出现在 `TermuxEnv`；新增键须同步 `TermuxEnvTest` 单源回归。
3. **子进程**：一律走 `Proc.run`（自带超时与流消费）；直用 `ProcessBuilder` 需说明理由。
4. **补丁载荷**：`assets/patched/` 是真实文件（非 base64 内嵌），改动后跑资产脚本门禁；
   幂等靠**内容指纹**而非版本 marker（参考项目 v1→v2 静默跳过事故）。
5. **模板/兜底双源**：任何「资产 + 内联兜底」对必须在测试中锁定占位符集合一致。
6. **KDoc**：正文里不写注释起始/终止符号字面量；提目录通配写 `patched/` 而非 `patched/**`。
7. **大资产**：LFS 文件（node/prebuilt/bootstrap）变更后必须跑 ABI 门禁并确认 workflow
   仍带 `lfs: true`。
