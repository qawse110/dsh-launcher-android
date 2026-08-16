# DshLauncher (Android)

单 APK 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Android 启动器：
内置 Node.js aarch64 运行时，通过官方 npm 包 `@deepseek-ai/dsh` 安装/更新 dsh，
并在设备本机直接启动 `dsh web`（127.0.0.1:3080），
并自带 WebView 界面——**不需要 Termux、不需要外部 Node**；联网仅用于 npm 首次安装与后续更新。

**包名**：`com.dsh.launcher`（AGP 9.0 / Kotlin / Gradle 8.x）。

## 特性

- **内置 Node 运行时**：`assets/node/…` 打进 APK，首次启动解压到应用私有目录并
  `makeUnwritable`（解除 Android W^X 执行限制）。
- **内置 Termux 工具链**：内置 bash/coreutils/apt，并在首次使用/一键安装时自动
  `pkg install git python`，把 Termux `bin`、内置 Node `bin` 与 pnpm 工具目录纳入
  DSH 进程与内置终端 PATH，`TERM=xterm-256color`，满足 Harness 对 bash/git 的前置要求。
- **一键启动**：`ConsoleActivity` 内置四步引导
  `1/4 解压 node → 2/4 复制官方安装脚本 + 内置插件源 → 3/4 npm 官方安装/更新 dsh + dsh plugin 装配内置插件 → 4/4 启动 dsh web`。
- **内置 WebView 界面**：主界面「打开 Web 界面」在应用内加载 `http://127.0.0.1:3080`
  （无需跳外部浏览器）；也可用任意浏览器访问同一地址。
- **设备端免编译适配**（`assets/stub-dsh.mjs`，每次启动自动重打，幂等）：
  - `koffi` / `node-pty` / `sharp`：Android 无预编译产物（`node-addon-*`/libvips 缺失），
    以 Proxy stub 顶替，保证模块可加载；
  - `sandbox-windows-acl`（仅 Windows 宿主）的 koffi 布局断言在执行前禁用；
  - `--expose-internals`：vendor/loader 的 internal 加载器依赖它解析 workspace 包
    （`NODE_OPTIONS` 不允许该开关，必须用命令行参数）；
  - **`AbortSignal.timeout` polyfill 注入 `dist/index.html`**：系统 WebView / Chrome ≤102
    没有该 API，缺失会导致前端 client-connection 无限重连（详见下）。
- 内置插件经官方 `dsh plugin --profile web add` 装配：`dsh-mobile-nav`、`dsh-super-injector`、
  `dsh-net-proxy`、`dsh-provider-headers`、`dsh-vision`、`dsh-oh-we-need`；`yjh051108/dsh-routing-suite`
  走特殊适配（`routing-suite.mjs`：聚合仓库 + injector/mode-boost 装配 + agent-presets 拷贝）。
- 自动初始化 `files/.dsh/profiles/web` 配置（含默认 LLM 提供方配置），
  界面内填入 DeepSeek API Key 即可使用。

## 构建

```sh
# 0) （可选）在项目根放 release.keystore，或设置 DSH_KEYSTORE_FILE
# 1) 构建（release 优先用 keystore 签名；缺省回退 debug 签名）
./gradlew assembleRelease        # 或 assembleDebug
```

密钥由 `app/build.gradle.kts` 从 `DSH_KEYSTORE_FILE`（默认根目录 `release.keystore`）
与 `DSH_KEYSTORE_PASS`（默认 `dshlauncher123`）读取。**不要把 keystore 及其密码提交进仓库**；
内置默认值仅用于本地开发。

## 安装与运行

```sh
adb install -r app/build/outputs/apk/release/app-release.apk
# 触发一键引导（幂等：重复执行会跳过已完成的步骤）
adb shell am start -n com.dsh.launcher/.ConsoleActivity --ez dsh true
# 等待控制台输出 “OK 4/4 dsh web started (http://127.0.0.1:3080)”
adb shell am start -n com.dsh.launcher/.MainActivity   # 或直接点应用图标
```

- 主界面按钮「打开 Web 界面」进入内嵌 WebView；填写 API Key（设置 → 添加 API Key）后即可对话。
- 日志：应用私有目录 `files/dsh-flow.log`（引导流程）、`files/dsh-web.log`（web 进程）。
- 部分 ColorOS 设备从 `/sdcard` 安装 APK 会遇到 FUSE 上下文问题，先推送到
  `/data/local/tmp/` 再 `pm install -r` 即可。

## 实机验证（Sharp 803SH）

以下链路已在 Sharp 803SH（Android 12 / 骁龙 6 系 / 3.7GB 内存）实测通过：

1. 安装 → 引导 4/4 全绿 → `dsh web` 监听 `127.0.0.1:3080`；
2. `describe`（HTTP RPC）、`/api/events.mux`、`/api/events.host`（WebSocket 双流）全部可用；
3. 应用内 WebView（Chromium 94）完整渲染 dsh GUI：侧边栏、会话、命令、设置；
   client-connection 握手成功（连上后无重连告警），首屏出现「添加 API Key」配置卡；
4. PC 侧可经 `adb forward tcp:13080 tcp:3080` 直接访问同一实例。

### 关键兼容性修复（按发现顺序）

| 问题 | 修复 |
| --- | --- |
| vendor/loader 无法解析 `@deepseek-ai/…` 包 | `node --expose-internals <cli> web`（命令行参数，而非 NODE_OPTIONS） |
| `sharp` 加载失败（无 android-arm64 运行时） | Proxy stub（已装/未装两条路径都覆盖） |
| `node-pty` 被嵌套安装在 `@deepseek-ai/dsh-subprocess-local/node_modules` 下，Android 无 `pty.node` 预编译产物，导致 dsh plugin tree 加载失败、web 无法启动 | `stub-dsh.mjs` 递归查找嵌套 `node_modules` 并打 Proxy stub |
| `dsh-provider-headers` 的 `sendAttribution: false` 不生效（`@deepseek-ai/dsh-llm-pi-ai` 仍强制注入 `deepseek-harness` User-Agent） | `stub-dsh.mjs` 给 `llm-pi-ai` schema/header 逻辑打补丁，关闭归因后改用自定义 User-Agent |
| `sandbox-windows-acl` 加载期布局断言崩溃 | 正则禁用 `STARTUPINFOW` / `PROCESS_INFORMATION` 断言 |
| **WebView 无限 `connection lost` 重连** | **`AbortSignal.timeout` polyfill**：WebView/Chrome ≤102 无此 API，`host.describe` 前置超时调用直接抛错，`loop()` 每次 attempt 立即失败 → 无限重试；在 `dist/index.html` 注入 shim 后握手全部成功 |

## 已知限制

- 系统 WebView 版本较旧（本机 Chromium 94）：除 `AbortSignal.timeout` 外若上游引入更新的
  Web API，可能需要补充 polyfill（位置：`stub-dsh.mjs` 的 index shim 段）。
- `sharp` 为 stub 实现：`attachment-local` 等依赖图片处理的能力不可用，不影响核心会话功能。
- 设备内存有限，**不要在设备上执行 `pnpm build` / 类型检查**（tsc 全量构建会 OOM）；
  内置插件源码打包在 `assets/prebuilt.tgz`（提取到 `files/plugins`），引导阶段使用官方
  `dsh plugin` 装配，不进行设备端源码编译。
- 重新安装 APK 会终止旧 web 进程，安装后需再次触发一键引导（幂等；dsh 已安装时
  `install-dsh.mjs` 会走 npm 增量更新，通常更快）。
- `dsh web` 只监听 loopback，仅本机（及 adb forward 的 PC）可访问。

## 发布

预编译签名 APK 发布在 [Releases](https://github.com/qawse110/dsh-launcher-android/releases) 页。