# DshLauncher (Android)

单 APK 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Android 启动器：
内置 Node.js aarch64 运行时与 Termux 工具链，通过官方 npm 包 `@deepseek-ai/dsh` 安装/更新 dsh，
并在设备本机直接启动 `dsh web`（`http://127.0.0.1:3080`），自带 WebView 界面。

**不需要 Termux、不需要外部 Node**；联网仅用于 npm 首次安装与后续更新。

- 包名 `com.dsh.launcher` · 当前版本 **v4.10.0**（versionCode 31）
- 架构：AGP 9.0 / Kotlin / Gradle 8.x · minSdk 24 / targetSdk 28 / compileSdk 35

## 目录

- [特性概览](#特性概览)
- [架构：最小脚本干预，能力插件化](#架构最小脚本干预能力插件化)
- [内置插件](#内置插件)
- [构建](#构建)
- [安装与运行](#安装与运行)
- [桌宠模式（兼容 Codex 桌宠）](#桌宠模式兼容-codex-桌宠)
- [实机验证](#实机验证)
- [已知限制](#已知限制)
- [文档索引](#文档索引)
- [发布](#发布)

---

## 特性概览

| 领域 | 能力 |
|---|---|
| **运行时** | 内置 Node aarch64 + Termux bash/coreutils/apt；唯一执行环境 = 内置 Termux |
| **安装** | 官方 npm 安装/更新 `@deepseek-ai/dsh` + `dsh plugin` 装配内置插件（非源码克隆） |
| **启动** | 打开即自动引导（解压→安装→适配→启动 web），秒级快速启动，就绪自动进 WebUI |
| **界面** | 内嵌 WebView（Chromium）+ 任意浏览器访问同一地址 |
| **语音** | 双 TTS：系统引擎（离线）/ Edge 在线语音（微软神经音色，零依赖实现） |
| **悬浮窗** | 状态条 + 桌宠动画双样式；普通服务 + 无障碍双通道保活 |
| **插件化适配** | 能由插件实现的功能一律下沉为独立内置插件（8 个），脚本补丁降至最低 |
| **环境** | apt/dpkg 原生可用；Termux 环境自动准备（幂等） |

## 架构：最小脚本干预，能力插件化

启动器对 dsh 本体的干预遵循一条原则：

> **凡能在 Cordis 插件运行时实现的功能，一律做成独立内置插件，走官方 `dsh plugin --profile web add` / bundle patch 通道；脚本只保留 Node 模块加载期与 WebView 引导期无法被插件替代的必要修复。**

逐项审计见 [`docs/plugin-conversion-audit.md`](docs/plugin-conversion-audit.md)（对 `stub-dsh.mjs` 全部 12 处补丁给出「保留 / 移除 / 插件化」三向结论与证据）。

**流水线**（`DshFlow` 统一驱动，主界面与命令控制台共用）：

```
APK assets
  ├─ node/  termux-bootstrap.zip    → 解压、makeUnwritable（W^X）、Termux 环境准备
  ├─ install-dsh.mjs                → npm 安装/更新 @deepseek-ai/dsh + dsh plugin 装配内置插件
  ├─ stub-dsh.mjs                   → Android 兼容修复（仅剩加载期/引导期必需项，幂等）
  ├─ extra-plugins/…                → 内置插件源（随 APK 同步，装配进 web profile）
  └─ web-launcher.sh.tpl            → 可重现的 web 启动环境（TermuxEnv 单源渲染）
        │
        ▼
files/.dsh/profiles/web ──cordis 装配──▶ dsh web @ 127.0.0.1:3080 ◀── WebView/浏览器
```

**脚本职责边界**：

| 脚本 | 职责 | 是否改写 dsh 本体 |
|---|---|---|
| `install-dsh.mjs` | 官方 npm 安装/更新 + `dsh plugin` 装配 | 否（官方通道） |
| `stub-dsh.mjs` | 加载期/引导期修复（native 模块顶替、CJS 盲区、HTML shim） | 是，仅剩 8 处必需项（带审计） |
| `fs-register/loader/promises-compat` | Node `--import` 会话级兼容层（SELinux 禁硬链接） | 否 |
| `routing-suite.mjs` | 第三方聚合仓库的一次性适配安装 | 否（官方 plugin add + 预设拷贝） |
| `tpkg.sh` | `apt install` 失败时的 deb 手动兜底 | 否（Termux 层） |
| `web-launcher.sh.tpl` | web 进程启动环境 | 否 |

## 内置插件

经官方 `dsh plugin --profile web add` 装配到 `files/.dsh/profiles/web`（bundle 层），
随 dsh 升级自动保持，不被启动器补丁破坏：

| 插件 | 作用 |
|---|---|
| `dsh-mobile-nav` | Web 界面移动端导航适配 |
| `dsh-super-injector` | 运行时插件注入器（开发/热装通道） |
| `dsh-net-proxy` | 网络代理配置 |
| `dsh-provider-headers` | LLM 提供方请求头（归因 UA 开关） |
| `dsh-vision` | 视觉能力（经 settings 服务自注册命名空间） |
| `dsh-oh-we-need` | 推理风格 Skill（不再注入系统提示词） |
| `dsh-status-bridge` | dsh 运行状态桥接到悬浮窗/通知（本地 HTTP :3190） |
| `dsh-android-links` | 在 dsh HOME 创建 `sdcard → /storage/emulated/0` 符号链接，让工作区目录浏览器直达 SD 卡（**零 dsh 文件改动**，替代旧源码补丁） |

## 构建

```sh
# 在项目根放 signing/release.keystore（或设置 DSH_KEYSTORE_FILE/DSH_KEYSTORE_PASS）
./gradlew assembleRelease        # 或 assembleDebug
```

- 签名：release 优先用 `signing/release.keystore` 正式签名（**自 v4.3.4 起提交入库以保证跨版本签名稳定**，是绕过部分 ROM 对 debug 签名 app 的 exec 过滤的关键假设）；缺 keystore 时回退 debug 签名（仅本地开发）。
- 密码：`DSH_KEYSTORE_PASS`（默认 `dshlauncher123`）。
- ⚠️ 已知权衡：公开签名密钥意味着任何人都能用相同签名构造"升级"包——该风险（P0-2）与「出库换新钥」决策记录在 [`docs/architecture-optimization-plan.md`](docs/architecture-optimization-plan.md)。

## 安装与运行

```sh
adb install -r app/build/outputs/apk/release/app-release.apk
# 触发一键引导（幂等：重复执行会跳过已完成的步骤）
adb shell am start -n com.dsh.launcher/.ConsoleActivity --ez dsh true
# 等待控制台输出 “OK 4/4 dsh web started (http://127.0.0.1:3080)”
adb shell am start -n com.dsh.launcher/.MainActivity   # 或直接点应用图标
```

- 主界面按钮「打开 Web 界面」进入内嵌 WebView；填写 API Key（设置 → 添加 API Key）后即可对话。
- Android 11+ 可在主界面开启「存储权限 / 所有文件访问」，以完整读写 `/sdcard`（尤其 dsh 工作区放 `/sdcard/Download` 时）。
- 日志：应用私有目录 `files/dsh-flow.log`（引导流程）、`files/dsh-web.log`（web 进程）。
- 部分 ColorOS 设备从 `/sdcard` 安装 APK 会遇到 FUSE 上下文问题：先推到 `/data/local/tmp/` 再 `pm install -r`。
- 环境特性：唯一执行环境 = 内置 Termux（bash/coreutils/apt），首次使用自动 `pkg install git python ripgrep`；apt/dpkg 原生可用（W^X 放开 + termux-exec 集成），`apt install` 失败自动切 `tpkg` 手动兜底。

## 桌宠模式（兼容 Codex 桌宠）

- **切换**：主界面 →「状态悬浮窗」→「悬浮窗样式」选「状态条」或「桌宠」；长按悬浮窗本体可快速切换。
- **开关统一**：设置页「悬浮窗显示」为唯一总开关（普通服务 + 无障碍双通道一并控制）；锁屏/灭屏自动隐藏，解锁恢复。
- **交互**：单击 → 挥手 + 随机台词气泡（5 秒，会朗读）；双击 → 气泡展开最近完整内容；连点 ≥5 次 → 吐槽；点击气泡 → 打开 dsh Web；**触摸透传**：仅桌宠本体与气泡拦截触摸，其余区域 100% 透传。
- **拖动**：轻放 = 记停靠位（家）；用力抛出 = 抛物坠落、撞墙反弹、自动走回停靠位；未设家默认贴地；拖动到底部垃圾桶停留 ≥0.35 秒关闭悬浮窗。
- **闲时冒泡**：dsh 空闲时每 2.5~5 分钟随机台词（可关）。
- **外观**：大小（小/中/大）、气泡开关、名称开关；气泡独立悬浮窗、宽度有上限、朝停靠边自动翻转。
- **发声**：双引擎（系统 TTS / Edge 在线）；状态台词 + 气泡变化全文朗读（≥5 秒节流）。
- **动作映射**：空闲 → `idle`；思考/输出 → `review`/`waiting`；调工具 → `running`；完成 → `jumping` 庆祝；出错 → `failed`。动画行切换带 ≈2 秒稳定窗口防抖动；待机每 20~45 秒随机挥手。
- **导入社区桌宠包**：设置页「导入桌宠包」选择含 `pet.json` + `spritesheet.webp/.png`（8x9 精灵表）的文件夹，或复制到 `/sdcard/Download/DshLauncher/codex-pets/` 后刷新列表。来源：<https://codexpet.top>、<https://petdex.dev> 等。
- 内置默认桌宠“小豆丁”由 `tools/gen_default_pet.py` 生成（产物即合法 Codex 桌宠包）。

## 实机验证

已在 Sharp 803SH（Android 12 / 骁龙 6 系 / 3.7GB）实测通过：

1. 引导 4/4 全绿 → `dsh web` 监听 `127.0.0.1:3080`；
2. HTTP RPC / WebSocket 双流（events.mux / events.host）可用；
3. 内嵌 WebView（Chromium 94）完整渲染 GUI，client-connection 握手成功；
4. PC 经 `adb forward tcp:13080 tcp:3080` 访问同一实例。

关键兼容性修复（按发现顺序）：

| 问题 | 修复 |
|---|---|
| vendor/loader 无法解析 `@deepseek-ai/…` | `node --expose-internals`（命令行参数，非 NODE_OPTIONS） |
| `sharp` / `node-pty` 无 Android 预编译产物 | Proxy stub / 纯 JS shim（import 期顶替） |
| `sendAttribution:false` 不生效（归因 UA 仍被强制注入） | `llm-pi-ai` schema/header 补丁（待上游提供官方抑制缝隙） |
| `sandbox-windows-acl` 布局断言崩溃 | 正则禁用 STARTUPINFOW/PROCESS_INFORMATION 断言 |
| WebView 无限 `connection lost` 重连 | `AbortSignal.timeout` polyfill——**按需注入**：仅当 dist 内 bundle 确实引用该 API 才写 `index.html`（rc.2 前端无消费者，自动跳过） |

## 已知限制

- 系统 WebView 版本较旧（本机 Chromium 94）：上游若引入更新的 Web API，可能需要补充 polyfill（`stub-dsh.mjs` index shim 段）。
- `sharp` 为 stub：依赖图片处理的能力不可用，不影响核心会话功能。
- 设备内存有限：**不要在设备上执行 `pnpm build` / 类型检查**（会 OOM）；内置插件以源码打包进 APK，装配用官方 `dsh plugin`，不在设备端编译。
- 重新安装 APK 会终止旧 web 进程，需再次触发一键引导（幂等；已安装时走 npm 增量更新）。
- `dsh web` 只监听 loopback（本机 + adb forward 可访问）；`dsh-status-bridge` `/status` 同绑 loopback。
- 状态桥接普通通道无开机自启：重启后由无障碍通道自动恢复，或打开一次 app 拉起；部分 ROM 对无障碍冷启懒绑定（关一次再开即可）。
- 悬浮窗 watchdog 为 30s 自续式精确闹钟；Doze 深度休眠下可能被合并到 ≥9 分钟一次。
- **PowerGovernor** 自适应后台：按「屏幕 × 任务态 × 后台时长」分档轮询（亮屏 1s / 灭屏任务 3s+唤醒锁 / 灭屏空闲 10~30s），看门狗仅在任务运行或刚灭屏 5 分钟内允许唤醒。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/plugin-conversion-audit.md`](docs/plugin-conversion-audit.md) | 脚本式 dsh 修改审计：12 处补丁逐项判定 + 升级守护清单 |
| [`docs/architecture-optimization-plan.md`](docs/architecture-optimization-plan.md) | 架构优化路线图（P0/P1/P2 + 执行状态） |
| [`docs/review-findings-scripts.md`](docs/review-findings-scripts.md) | 脚本层全量 review 记录 |
| [`docs/review-findings-r1.md`](docs/review-findings-r1.md) | overlay/service/ui 横切 review 记录 |
| [`docs/plugin-conversion-recon.md`](docs/plugin-conversion-recon.md) | directory-picker 插件化侦察（ctx.directoryPicker 服务缝） |

## 发布

预编译签名 APK 发布在 [Releases](https://github.com/qawse110/dsh-launcher-android/releases) 页。
发布流程：推 `v*` tag → GitHub Actions 构建签名 APK 并创建 Release（`release.yml`）。
