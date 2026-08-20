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
  `pkg install git python ripgrep`，把 Termux `bin`、内置 Node `bin` 与 pnpm 工具目录纳入
  DSH 进程与内置终端 PATH，`TERM=xterm-256color`，满足 Harness 对 bash/git/ripgrep 的前置要求。
- **一键启动**：`ConsoleActivity` 内置四步引导
  `1/4 解压 node → 2/4 复制官方安装脚本 + 内置插件源 → 3/4 npm 官方安装/更新 dsh + dsh plugin 装配内置插件 → 4/4 启动 dsh web`。
- **内置 WebView 界面**：主界面「打开 Web 界面」在应用内加载 `http://127.0.0.1:3080`
  （无需跳外部浏览器）；也可用任意浏览器访问同一地址。
- **悬浮窗 + 安卓桌宠模式**：主界面的「状态悬浮窗」可显示 dsh 运行状态；支持两种样式
  （设置页或长按悬浮窗切换）：**状态条**（紧凑文字）与**桌宠**（动画角色跟随 dsh 状态）。
  桌宠模式**兼容 Codex 桌宠包格式**（`pet.json` + `spritesheet.webp/.png`，8x9 精灵表），
  内置默认桌宠“小豆丁”，并可导入 awesome-codex-pet / petdex 等社区桌宠包（详见下文）。
- **设备端免编译适配**（`assets/stub-dsh.mjs`，每次启动自动重打，幂等）：
  - `koffi` / `node-pty` / `sharp`：Android 无预编译产物（`node-addon-*`/libvips 缺失），
    以 Proxy stub 顶替，保证模块可加载；
  - `sandbox-windows-acl`（仅 Windows 宿主）的 koffi 布局断言在执行前禁用；
  - `--expose-internals`：vendor/loader 的 internal 加载器依赖它解析 workspace 包
    （`NODE_OPTIONS` 不允许该开关，必须用命令行参数）；
  - **`AbortSignal.timeout` polyfill 注入 `dist/index.html`**：系统 WebView / Chrome ≤102
    没有该 API，缺失会导致前端 client-connection 无限重连（详见下）。
- 内置插件经官方 `dsh plugin --profile web add` 装配：`dsh-mobile-nav`、`dsh-super-injector`、
  `dsh-net-proxy`、`dsh-provider-headers`、`dsh-vision`、`dsh-oh-we-need`（Skill 化，不再注入
  系统提示词）、`dsh-j-space-cognition`（J-Space Cognition Suite V3.6 Skill）；`yjh051108/dsh-routing-suite`
  走特殊适配（`routing-suite.mjs`：聚合仓库 + injector 装配 + agent-presets 拷贝）。
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
- Android 11+ 可在主界面点击「存储权限 / 所有文件访问」并允许，以完整读写 `/sdcard`
  （尤其当 dsh 工作区放在 `/sdcard/Download` 时）。
- 日志：应用私有目录 `files/dsh-flow.log`（引导流程）、`files/dsh-web.log`（web 进程）。
- 部分 ColorOS 设备从 `/sdcard` 安装 APK 会遇到 FUSE 上下文问题，先推送到
  `/data/local/tmp/` 再 `pm install -r` 即可。

### 桌宠模式（兼容 Codex 桌宠）

- **切换**：主界面 →「状态悬浮窗」→「悬浮窗样式」选「状态条」或「桌宠」；
  也可以**长按悬浮窗本体**快速来回切换。切换后 1 秒内自动生效（状态轮询周期）。
- **交互**：**单击**桌宠本体——挥手互动一次 + 随机台词短气泡（5 秒，会朗读）；
  **双击**——气泡展开**最近完整内容**（8 秒或状态变化后收起），**点击气泡立即收起**；
  **快速连点 ≥5 次**触发"主人别戳啦～"吐槽；无临时气泡时点击**气泡**打开 dsh Web，
  桌宠模式的**空白区域点击无反应**；**拖动松手**（设置页「拖拽抛落」开启时）有两种语义：
  **轻放**＝当前位置记为桌宠的**停靠位（家）**，原地待命不坠落；
  **用力抛出**＝抛物坠落，撞左右墙反弹、落地小弹跳后**自动走回停靠位（家）**——
  未设置过家时默认停靠**屏幕中上部侧边（约 30% 屏高处）**，避开底部键盘与导航区、
  又不会太靠上；关掉「拖拽抛落」则恢复普通拖动定位；**关闭悬浮窗**：拖动时屏幕底部
  出现垃圾桶，把悬浮窗拖到垃圾桶上**停留片刻（≥0.35 秒，垃圾桶变红放大）**再松手才
  关闭——快速甩过或路过不会误关（「悬浮窗显示」重新开启后恢复），原 × 按钮已移除；
  长按切换模式。
- **问候与闲时冒泡**：桌宠登场时问候一次；dsh 空闲时每隔 2.5~5 分钟随机说一句台词
  （设置页「闲时主动冒泡」可关，说时会朗读）——参考 [codex-pet-live](https://github.com/VectorPeak/codex-pet-live)
  的 patpat / ambient 气泡模型。
- **外观**：设置页可调桌宠大小（小/中/大）、气泡开关与**桌宠名称开关**（气泡中是否显示
  名字）；气泡**宽度有上限**（状态气泡 ≤45% 屏宽/230dp，展开 ≤55% 屏宽），超长文本
  自动换行截断；气泡**朝向随停靠边自动翻转**——贴左边缘时气泡靠左、贴右边缘时靠右
  （朝屏幕内侧，不贴屏幕边），气泡变宽不影响桌宠本体位置；精灵表按单元格像素
  全分辨率解码（兼容 v1/v2 规格，内置默认包及常见社区包均清晰显示）。
- **发声（TTS）**：设置页「桌宠发声」开关（默认开）。除固定状态台词（任务完成/出错/
  新任务/调工具）与互动台词外，**气泡内容发生变化时也会朗读全文**（≥5 秒节流防连读，
  与固定短台词互不重复）。使用系统 TTS 引擎：优先中文，无中文引擎自动回退系统默认语言，
  无引擎时静默不报错。
- **动作稳定**：动画行切换带 ≈2 秒稳定窗口——同一动作持续两个轮询周期才真正切换，
  避免 `tool/call ↔ assistant/message` 状态抖动导致桌宠频繁换动作；帧时长遵循 Codex
  规范。**循环策略**：常驻状态行（idle/跑动/等待/思考/失败）在状态持续期间循环；
  一次性表演行（跳跃庆祝）播完一轮即**落地回 idle** 继续呼吸，同一动作不重播
  （完成状态会一直保持到下一任务开始，若不落地桌宠会永远跳个不停）。
  待机时每 **20~45 秒随机挥手一次**，打破无限循环待机的机械感（纯动作、不打扰气泡）。
- **动作映射**：dsh 空闲 → `idle` 呼吸；思考/输出 → `review` 思考（`tool/call` 时
  `running` 跑动，`assistant/message` 时 `waiting`）；输出完成 → `jumping` 庆祝；
  出错 → `failed`。
- **导入 Codex 桌宠包**：一个桌宠包 = 文件夹内的 `pet.json`（`id`/`displayName`/
  `description`/`author`/`version`/`replies` 可选，`spritesheetPath`）+ `spritesheet.webp`
  或 `.png`（8 列 x 9 行，单元格 192x208，兼容 v2 的 8x11 表）。两种方式：
  1. 设置页「桌宠」→「导入桌宠包」，用系统文件选择器选中包含 `pet.json` 的文件夹；
  2. 直接把桌宠包文件夹复制到 `/sdcard/Download/DshLauncher/codex-pets/` 下
     （或应用私有目录 `files/codex-pets/`），再在设置页「刷新列表」。
  列表会显示每只宠物的作者/版本信息；`pet.json` 中 `replies`（或 `interactions[].replies`）
  会被用作点击互动台词。
- 社区桌宠包来源：<https://codexpet.top>（awesome-codex-pet）、<https://petdex.dev> 等。
- 内置默认桌宠资源由 `tools/gen_default_pet.py` 生成（Pillow），产物为
  `app/src/main/assets/codex-pets/default/`（本身就是合法 Codex 桌宠包）。

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