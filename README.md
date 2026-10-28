# DshLauncher (Android)

单 APK 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Android 启动器：
内置 Node.js aarch64 运行时与 Termux 工具链，通过官方 npm 包 `@deepseek-ai/dsh` 安装/更新 dsh，
并在设备本机直接启动 `dsh web`（`http://127.0.0.1:3080`），自带 WebView 界面。

**不需要 Termux、不需要外部 Node**；联网仅用于 npm 首次安装与后续更新。

- 包名 `com.dsh.nextapp1` · 当前版本 **v4.10.2-fix6**（`versionCode 300`）
  —— 以 [`app/build.gradle.kts`](app/build.gradle.kts) 的 `versionCode`/`versionName` 为准
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
| **插件化适配** | 能由插件实现的功能一律下沉为独立内置插件（内置 **11** 个 + 可选 **2** 个，见下），脚本补丁降至最低 |
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
  ├─ plugin-manifest.json           → 内置插件清单【单一真源】：装配面与展示面都从它派生
  ├─ dsh-pin.json                   → dsh 钉死版本【单一真源】：Kotlin 与 JS 两侧同源
  ├─ stub-dsh.mjs                   → Android 兼容修复（仅剩加载期/引导期必需项，幂等）
  ├─ extra-plugins/…                → 内置插件源（随 APK 同步，装配进 web profile）
  ├─ optional-plugins/…             → 可选插件源（随 APK 分发，默认不装配，按需启用）
  └─ web-launcher.sh.tpl            → 可重现的 web 启动环境（TermuxEnv 单源渲染）
        │
        ▼
files/.dsh/profiles/web ──cordis 装配──▶ dsh web @ 127.0.0.1:3080 ◀── WebView/浏览器
```

**脚本职责边界**：

| 脚本 | 职责 | 是否改写 dsh 本体 |
|---|---|---|
| `install-dsh.mjs` | 官方 npm 安装/更新 + `dsh plugin` 装配 | 否（官方通道） |
| `stub-dsh.mjs` | 加载期/引导期修复的**驱动层**（按序 import `assets/stub/patchers/*.mjs`） | 是，仅剩 8 处必需项（带审计，见 `docs/plugin-conversion-audit.md`） |
| `assets/stub/patchers/{native-stubs,host-runtime,plugin-compat,flock}.mjs` | 各补丁实现（原生模块顶替 / 宿主运行时 / 插件兼容 / flock 降级） | 是（同上） |
| `fs-register/loader/promises-compat` | Node `--import` 会话级兼容层（SELinux 禁硬链接） | 否 |
| `routing-suite.mjs` | 第三方聚合仓库的一次性适配安装 | 否（官方 plugin add + 预设拷贝） |
| `tpkg.sh` | `apt install` 失败时的 deb 手动兜底 | 否（Termux 层） |
| `web-launcher.sh.tpl` | web 进程启动环境 | 否 |

## 内置插件

清单唯一真源是 [`app/src/main/assets/plugin-manifest.json`](app/src/main/assets/plugin-manifest.json)，
Kotlin 展示面与 `install-dsh.mjs` 装配面都从它派生；一致性由 `node tools/check-plugin-manifest.mjs` 校验（已接入 CI）。
经官方 `dsh plugin --profile web add` 以 `link:` 方式装配到 `files/.dsh/profiles/web`：

| 插件 | 来源 | 作用 |
|---|---|---|
| `dsh-web-mobile` | <https://github.com/mexiaosqwq/dsh-web-mobile> `v3.2.1` | 竖屏/窄屏 Web 适配（抽屉导航、全宽会话、安全区、触控人体工学） |
| `@dsh-external/dsh-wish-specializer` | <https://github.com/WestFox-AwA/dsh-wish-specializer> `v0.9.0-stable` **上游原版（零本地改动）** | 提示词优化（发送前用独立 AI 把输入改写成命令）。⚠ 与早先的 `dsh-prompt-optimizer-mobile` 相比是**结构性变更**：本地那套「默认启用翻转 + 窄屏 UI + 包名对齐」已**外置到 `dsh-mobile-replay`**，本包因此可与上游逐字节同步、整包替换即升级。两处需知：① 未随包上游 `runtime/`（Windows MSYS2 bash 运行时，45.8 MB / 164 文件，Android 上 `lib/index.js` 从不解析它）；② 上游 bundle 层会插入 `preset-wish`（Wish 预置 agent，其 `tool-wish-check` 指向未导出的 `./check` 子路径）——本部署在 profile 的 `cordis.patch.yml` 里 `- id: preset-wish / disabled: true` 关掉，**包本身一个字节没改** |
| `dsh-providers-hub` | npm `dsh-providers-hub@2.8.261028` **上游原版（零本地改动）**（源码仓库 <https://gitee.com/iJetLi/deepseek-harness-codearts>，即原 `dsh-codearts-auth` 改名而来） | CodeArts / Buddy / Qoder / Trae / Cline / Loomy / Raccoon / zcode / OpenCode / Gemini 等多 Provider 登录与模型接入。⚠ 与早先的本地构建 `dsh-codearts-auth` 相比：**172 行 ≤560px 窄屏扩展层已外置到 `dsh-mobile-replay`**，本包改为与 npm 上游同源（裁剪 `*.map` / `*.d.ts` 两类非运行时产物）；patch 里的 insert `id` 仍是 `codearts-auth`，那是给其它补丁做锚点的稳定标识，不随包名改 |
| `dsh-mobile-replay` | **本仓库自研** `v0.1.0` | 移动端适配层（纯前端）：把原先熔进两个 fork 的窄屏改动集中成独立插件——提示词优化面板的窄屏样式（拦截浮层宽度改 `vw`、控件栏纵向堆叠、触控目标抬高）+ CodeArts 面板的 173 行 `≤560px` 块（25 个 `.dim-jh-*` 类）+ 给「优化选项」标题补 `data-po06` 标记。选择器一律挂属性值而非包名，故两个上游包改名/升级都不影响它；⚠ 它是普通样式层叠（无 Shadow DOM），上游同等特异性规则仍应获胜 |
| `dsh-status-bridge` | **本仓库自研** `v0.1.3` | dsh 运行状态桥接到悬浮窗/通知（本地 HTTP，默认 :3190）。**与启动器 Kotlin 侧强耦合**：不装配则悬浮窗状态显示/TTS 播报链路失效（心跳 note 记为 `bridge-absent`，与「装了但掉线」区分开）。`/status` **需要 token**（每次启动轮换、写入 `files/status-bridge.json`，Kotlin 通过 `BridgeContract` 同源读取；不再回 CORS 头）；`lastText` 支持**逐段实时增长**（经 LLM 层 `llm/stream` waterfall 钩子对主请求做 tee，只取 `text-delta`，`reasoning`/`tool-call` 不外放） |
| `dsh-android-links` | **本仓库自研** `v0.1.1` | 在 dsh HOME 创建 `sdcard → /storage/emulated/0` 符号链接，让工作区目录浏览器直达 SD 卡 |
| `dsh-net-proxy` | <https://github.com/mafeis/dsh-net-proxy> `v0.8.0` | 让 agent 自身的网络请求（web_search / web_fetch / 外部 API）走已配置的 HTTP(S) 代理 |
| `dsh-provider-headers` | 自 `prebuilt.tgz` 恢复 | 在 Web 的模型设置页为自定义（llm-pi-ai）Provider 配置自定义请求头 |
| `dsh-vision` | 自 `prebuilt.tgz` 恢复 | 给纯文本模型加上 `view_image` 工具：复用宿主 Provider 配置，或接自定义 OpenAI 兼容 VLM 端点 |
| `@liustack/modsearch` | <https://github.com/liustack/modsearch> `v5.10.10`（npm 产物，整包同源） | 联网检索：把 `web_search`/`web_fetch` 的后端换成免密钥的 modsearch 引擎链（Firecrawl 免密钥、1,000 次/月），并新增 `x_search`、`read_page`。⚠ 运行时依赖 `commander`/`undici` 由**依赖桥接**供给（见下） |
| `dsh-ego-browser` | <https://github.com/Fisfzy/dsh-ego-browser> `v0.9.4`（npm 产物，整包同源） | Agent 浏览器：30+ `ego_*` 工具 + 实时观察窗，底层内置 ego-lite 运行时。⚠ **运行期需一个可达的 Chrome/Chromium 二进制**（本机未装，见下） |
| `@michengai/dsh-skills-manager` | npm `@michengai/dsh-skills-manager@1.2.20` **上游原版（零本地改动）**（源码仓库 <https://github.com/MichengAI/dsh-skills-manager>，Apache-2.0） | Skills 管理器：统一加载并安全管理本机 Agent Skills——全局（`DSH_HOME/skills`）与项目级 skill 的列表/详情/新建/导入（zip 或目录）/删除/启停，接 skills.sh、ClawHub 等在线目录，另有仓库管理与在线更新。49 文件 / 1,542,265 字节整包原样（含 `assets/`，只有 README 配图引用）。⚠ 需求里写的 `@michengai/dsh-skill-manager`（单数）在 npm 与 npmmirror 都 404，真实包名是复数 `skills` 的这一个。`engines.dsh = >=0.2.0-rc.1 <0.3.0-0` 独占兼容判定（有该字段即忽略其 11 条 peer）；运行时只依赖 `fflate`（已由依赖桥接解析到 0.8.3） |
| `billion-context` | <https://github.com/ranxianglei/billion-context> `v0.1.208`（npm 产物，按上游 `files` 字段裁剪） | 上下文压缩 ACP：给模型 `compress`/`decompress`/`search_context`/`acp_status`/`acp_cache`/`read_original_image` 六个工具，由模型自己决定何时压缩、压缩什么（而非硬性截断），另附 `/acp`、`/acp-cache` 命令。⚠ 与旧内置的 `billion-context-dsh` 是**两个不同的包**：本包为进程外 MITM 代理架构，插件本体只注册工具，实际压缩由它 spawn 的 `dist/index.js` 代理进程完成。其自带的 `dsh.bundle.patch.yml` 会 disable 宿主的 `compaction-basic` 行，并**整体替换** `llm-deepseek` 的 `retryPolicy`、向四个 preset 注入 `biliBasicCompactionPolicy` |

### 内置集合的构成

内置集合**由用户逐项决定**（原先「仅内置三个」的约束已撤回），当前为 **13 个**。
装完即可用；源码在 `assets/extra-plugins/`，唯一真源见
[`plugin-manifest.json`](app/src/main/assets/plugin-manifest.json)。

### 可选插件（随 APK 分发，**默认不装配**）

源码保留在 `assets/optional-plugins/`，可在「插件管理 → 可选插件」按需装配；不装配时相关能力静默缺席，不影响 dsh 启动：

| 插件 | 作用 |
|---|---|
| `dsh-llm-codebuddy` | `v1.6.0` | CodeBuddy 中国区/国际版 LLM Provider（独立命名空间 `llm-codebuddy`，只新增 Provider）。⚠ 本仓版本**领先**于 npm 上该包的 `latest`（1.3.10），属有意保留，不降级 |
| `@dsh-external/dsh-oh-we-need` | `v0.2.0` | 推理风格 Skill（历史遗留，此前从未接入装配链；未发布到 npm） |

> **⚠ 其中两项（`dsh-provider-headers` / `dsh-vision`）的来源需说明**：
> 它们原先只存在于 `prebuilt.tgz` 的 `third_party/`，而该供给链已在提交 `e3cf666` 移除，
> 仓库里**从未有过**它们的独立副本（`git ls-files` 0 命中）。本次是从本地构建残留
> `app/build/intermediates/.../prebuilt.tgz` 恢复源码后重新纳入的——
> **该残留不在 git 中，其 sha256 与 git LFS 记录的指针也不一致**，
> 因此无法断言这就是当年入库的那一版。恢复后已针对 dsh 0.1.7-rc.2 做过适配（见下）。
>
> `dsh-net-proxy` 已在后续一轮更新中**确认上游并整包同源**（`mafeis/dsh-net-proxy` `v0.8.0`，
> 其 `lib/` 自入库以来从未被本地改动过，唯一差异是 0.2.0 适配时放开的 peer 范围）；
> 该条不再属于「来源不明」之列。

> **专项调研结论（`dsh-vision` / `dsh-provider-headers`，均无可更新的上游）**：
> · `dsh-vision`：其上游身份可追溯但**版本落后**——候选仓库 `dsh-external/dsh-vision` 与
>   `william-jin-cmu/dsh-vision` 实为同一仓库（前者 301 重定向到后者，`git ls-remote` 返回同一 SHA），
>   该仓库**无 tag**，`main` 的包内版本为 `0.1.0`（未合并 PR 最高 `0.1.1`），而本仓副本是 `0.2.0`
>   —— 本地比上游新，**不存在可同步的新版**。按名匹配穷举 305 个 `dsh-vision` 仓库后，
>   无任何一个含本副本的双后端结构（`lib/backend.js` + `lib/client.js`）。
> · `dsh-provider-headers`：**无可识别上游**。同名 npm 包（duanyunlun `0.1.2`）与各候选仓库的
>   结构指纹均不匹配（本地用 `settings.section` 槽 + locale 命名空间 `providerHeaders` + `sendAttribution` 开关；
>   候选用 `settings.models.provider-card` 槽 + `dsh.modelHeaders`）。与本仓文档记录的「源自构建残留」一致。
> · 两项的排除均基于**按仓库名搜索 + 原始文件结构探测**；GitHub 代码搜索需鉴权（本机 401），
>   故「存在一个改了名、但文件集完全相同的仓库」这一情形**未被证明排除**。
> 结论：这两项本轮**未动**，来源风险与版本落后状态照旧成立。

> `dsh-web-mobile` 是其前身插件改名后的**后继**（同一插件的新名），旧名已退役以免双份注册，
> 本仓不再维护退役旧名的名录；插件自带的迁移说明见各插件 README。

### 针对 dsh 0.1.7-rc.2 的适配（历史记录：恢复的两项）

> **本节为历史记录**，记录 `dsh-provider-headers` / `dsh-vision` 当初为适配 0.1.7-rc.2 所做的改动；
> 当前适配目标已前进到 `0.2.0-rc.2`（见下文「dsh 版本适配」）。这两项至今仍保留该适配。

| 插件 | 上游写法 | 适配后 | 依据 |
|---|---|---|---|
| `dsh-provider-headers` | `require('@deepseek-ai/dsh-client-runtime/client').createSnapshotStore` | 改从 **`@deepseek-ai/dsh-client-store`** 取 | `dsh-client-runtime` 在 0.1.7-rc.2 全仓 **0 命中**（已不存在）；`createSnapshotStore` 现存于 `dsh-client-store`，签名一致，宿主自带的 `dsh-client-ui-sidebar/lib/client.js` 正是这么用的 |
| `dsh-vision` | `import { settingsNamespace } from '@deepseek-ai/dsh-settings'` | **就地内联**该函数 | 0.1.7-rc.2 的导出面实测仅 `{SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets}`，该符号已移除；ESM 具名导入在链接期即抛错，try/catch 兜不住。原实现只是「校验后原值返回」，源码既已随 APK 分发，内联比启动期改写干净 |

`dsh-net-proxy` 当时即无需改动（依赖仅 `node:*` / `react` / `dsh-client-ui-primitives` / `schemastery`，均存在）。

这些插件在真机上均通过 **ESM 链接测试**（`import()` 插件入口）：入口的 `apply` 均为 function。

### 本轮新增的三项（`modsearch` / `dsh-ego-browser` / `billion-context`）

三项均取自各自 **npm 官方 tarball**，**整包同源、未改任何源码字节**，
因此不需要「就地适配」那一档处置。
`billion-context` 的本地副本按**上游 `files` 字段裁剪**：只保留 `package.json`、`dsh.bundle.patch.yml`、
`README.md`、`CONFIGURATION.md`、`LICENSE`、`dist/index.js`、`dist/agent/dsh-native.js`，
删去 106.8MB sourcemaps、0.9MB 论文配图与其余 9 个客户端适配入口（pi / omp / opencode / kimi / zcode / claude 等）。
裁剪后 7.3MB；与 modsearch / ego-browser / codearts 的既有惯例一致：不带 sourcemap 分发。

**兼容性事实（读 package.json 实测，非推断）**：`@liustack/modsearch` **未声明任何
`@deepseek-ai/dsh*` peer**（只有 `commander`/`undici` 两个 dependencies），
故 0.2.0-rc.2 的 `evaluatePluginCompatibility` 对它直接返回 `undefined`（不适用）；
`dsh-ego-browser` 声明的 `dsh.engines.dsh` 为 `>=0.1.2-rc.1`，其 `peerDependencies` 全部是
`>=0.1.2-rc.1` 的下界范围且均标 `optional`，`0.2.0-rc.2` 全部满足。
用 **dsh 自带的那个判定函数**逐个核对，三者均返回 `undefined`（兼容）。

**`billion-context` 的三个特殊点**（与另外两项不同）：

1. **它替换了此前内置的 `billion-context-dsh`**（`Tyan66666/billion-context-dsh@0.2.27`）。
   换包的**唯一硬理由**是 dsh 0.2.1 的兼容性判定：`billion-context-dsh` 有 16 条 `@deepseek-ai/dsh-*`
   peer 要么钉死 `0.2.0-rc.2`、要么上界写死 `<0.2.1-0`，把 pin 升到 `0.2.1-rc.2` 后会被
   `evaluatePluginCompatibility` 判定不兼容并**静默禁用**（`dsh plugin add` 照旧成功，属静默失败）。
   `billion-context@0.1.208` 的 `peerDependencies` 为空且无 `engines.dsh`，不受该判定约束。
   旧包已归档至 `assets/optional-plugins/billion-context-dsh/` 备回滚，**不再装配**——两者都会
   disable 宿主 `compaction-basic` 并争抢同一个 `ctx.compaction`，不能并存。
2. **它是进程外 MITM 代理架构，与旧包的进程内 CompactionEngine 完全不同**。插件本体
   `dist/agent/dsh-native.js` 在 dsh 进程内做两件事：`spawn` 出代理子进程（`dist/index.js`），
   以及从 `/__bili/plugin/manifest` 动态拉取工具定义后逐条 `ctx.tools.register`。
   代理起不来时**不崩**：打一条 `proxy bootstrap failed — model traffic goes direct (uncompressed)`
   然后降级为不压缩。因此 `dist/index.js` 必须与 `dist/agent/dsh-native.js` 一起分发。
   模型侧工具面与旧包**同名同义且更多**：`compress` / `decompress` / `search_context` /
   `acp_status` / `acp_cache` / `read_original_image`（实测 `/__bili/plugin/manifest` 返回）。
3. **它的 `dsh.bundle.patch.yml` 会连带改写宿主配置**：disable `compaction-basic`（改为
   `config.auto: false`，旧包是 `disabled: true`）、向 `preset-standard` / `preset-ptc` /
   `preset-minimal` / `preset-cordis` 注入 `inject: [biliBasicCompactionPolicy]`，并**整体替换**
   `llm-deepseek` / `llm-deepseek-account` 的 `retryPolicy`（patch 是替换非合并，上游注释已说明
   它会重述全部默认 retry 码）。这是插件自带行为，非本仓改动。

> ⚠ **实测发现的部署陷阱（本轮顺带发现，值得记录）**：设备在 23:23 被**重装过一次 APK**，
> 那次重装把 `files/extra-plugins/` 覆盖成**该 APK 内置的旧版 assets**——上一轮更新过的
> 4 个插件（web-mobile / prompt-optimizer / codearts / net-proxy）在设备端被**静默回退**到旧版
> （仓库源码未受影响，仍是新版）。本次已按仓库重新同步并重跑装配，11 项全部为最新版。
> 结论：**APK 重装会以 assets 覆盖 extra-plugins**；改完插件后若发生重装，需重新同步一次。

### 插件结构变更：上游包去 fork 化 + 外置移动端适配层（2026-10-28）

目标：**两个上游包都不再需要 fork**，以后直接拿上游产物整包替换即可升级；本地那点移动端适配抽成独立插件。

| 变更 | 旧 | 新 | 合入方式 |
|---|---|---|---|
| 提示词优化 | `dsh-prompt-optimizer-mobile`（fork：改名 + 包名对齐 + 窄屏 UI 内联在 `lib/client.js`） | **`@dsh-external/dsh-wish-specializer` `0.9.0-stable`** | 上游官方 Release tgz 解包即用，**零本地改动**；只剔除 `runtime/`（Windows MSYS2 bash 运行时，45.8 MB / 164 文件，Android 永不解析） |
| 多 Provider 登录 | `dsh-codearts-auth`（本地构建：5 处包名对齐 + 172 行 ≤560px 扩展层内联） | **`dsh-providers-hub` `2.8.261028`** | npm 上游整包，**零本地改动**；只剔除 `*.map`（3.50 MB）与 `*.d.ts`（3.16 MB） |
| 移动端适配 | （熔在上两个 fork 里） | **`dsh-mobile-replay` `0.1.0`（本仓库自研）** | 新写：A 的 ⑧⑨ 两段窄屏样式 + B 的 173 行 ≤560px 块（25 个 `.dim-jh-*` 类）+ 给「优化选项」标题补 `data-po06` 标记 |

- **改名的连带影响**：`dsh-providers-hub` 的 `cordis.patch.yml` 里 insert `id` 仍是 `codearts-auth`（上游保留的稳定锚点，供其它补丁引用）；`@dsh-external/dsh-wish-specializer` 的 insert `id` 变为 `dsh-wish-specializer`。清单里三个新条目的 `upstream` 字段分别指向 GitHub（A）与 Gitee（B），M 无上游。
- **`preset-wish` 的处置**：A 的 bundle 补丁层会额外插入一条 agent preset（`id: wish`），其工具清单含 `tool-wish-check → @dsh-external/dsh-wish-specializer/check`；而 0.9.0-stable 的 `exports` 未导出该子路径（`import` 实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`，上游 main 已修、未发版）。本部署在 **profile 层** `cordis.patch.yml` 用 `- id: preset-wish / disabled: true` 关掉（bundle 层先应用、profile 层后应用 ⇒ 无需改上游一个字节）；`tool-wish-check` 不是顶层 entry，**不要**为它单写 patch 行（会报 `entry not found`）。已实测：不带 disable 行时 `--dump-config` 与 boot 仍能起来（dump 不解析子路径），disable 行是按设计选择的克制做法。
- **`dsh-mobile-replay` 的耦合方式**：`lib/index.js` 的 `apply()` 为空，纯前端；所有选择器挂 `[data-po06=…]` 属性值或 `.dim-jh-*` 类名，**不依赖两个上游包的包名**，因此上游升级不牵动它。样式以 `<style>` 追加到 `document` 末尾，与上游样式表是普通层叠关系（双方都没有 Shadow DOM）；冲突处按「上游同等特异性仍应获胜」选定 `!important` 范围。
- **机械核验**：清单门禁 `node tools/check-plugin-manifest.mjs` → `builtin=12，optional=3`；三个新目录共 90 + 251 + 7 文件（1,773,140 / 8,933,907 / 41,592 bytes），`node --check` 对三个插件全部 JS 0 失败；B 里残留的 `dsh-codearts-auth` 字样只有两处**备份文件格式常量**（`lib/client/jet-hub.js:5019` 的 `dsh-codearts-auth/backup.encrypted` 与 `:5229` 的 `BACKUP_FORMAT`），`PLUGIN_ID` 已为 `dsh-providers-hub`（`:1604`）；A 内 `dsh-prompt-optimizer-mobile` 命中 0 次；B 的 `lib/` 内已无 `max-width:560px`（该层只在 M 的 `lib/replay-b.css`）。
- **profile dump 复核**（真机、dsh `0.2.1-rc.4`）：`node --expose-internals --import fs-register.mjs bin.js --profile web --dump-config` → exit 0、1621 行、**0 条 skipping**；`dsh-wish-specializer` 与 `preset-wish`（被 profile patch 改写为 disabled）、`dsh-providers-hub`（entryKey 仍 `codearts-auth`）、`mobile-replay` 均在位。
- **本轮未验证**：真机重启后的实际渲染与交互（本轮**不重启 dsh**）；`dsh-mobile-replay` 的样式在 A/B 两个面板上的视觉效果只能由实机确认（源码与结构校验不能替代实机渲染）。

### 插件版本同步记录（上一轮 · 2026-10-27；fork 时代，已被上节取代）

> 该轮对齐上游 4 个插件时的**目录与包名如今已不存在**（`dsh-prompt-optimizer-mobile` / `dsh-codearts-auth` 已由上一节的三个插件取代）。本节按历史原样保留，用于追溯版本与构建证据；其中的路径不再是当前结构。

该轮对齐上游 4 个插件（dsh 本体 pin 保持 0.2.1-rc.2 不变），全部在仓库源码层完成并已重跑设备装配：

| 插件 | 旧 → 新 | 合入方式 |
|---|---|---|
| `dsh-prompt-optimizer-mobile` | 0.8.4-stable → **0.9.0-stable** | 上游已改名 WestFox-AwA/dsh-wish-specializer；以 git 浅取 tag 拿到 v0.9.0-stable（codeload tarball 走代理 TLS 失败）→ 全量取上游 `po06/lib` 后用 `git merge-file` 重放本地 3 组改动（6 个文件出 diff、9 处冲突逐 hunk 判读）；上游 lib 72→83 文件（+12 个 `advisor-*` / `inference-*` 模块，−`framing.js`），`node --check` 83/83 通过 |
| `dsh-codearts-auth` | 上游 master `86e3591` → **`4d5e6779`** | 上游 force-push 重写历史：`86e3591` 已不是 HEAD 祖先（两树相差 333 文件 / +88221 / −13939）；`pnpm build:all` 重建后本地 delta 收敛为 **5 处包名对齐**，另重放 172 行窄屏扩展块 |
| `dsh-ego-browser` | 0.8.6 → **0.9.4** | npm 产物整包同源替换（51 文件 / 1,389,213 bytes，`diff -rq` 对新包为空） |
| `billion-context` | 0.1.202 → **0.1.208** | npm 产物按 11 文件裁剪集替换（新增 `dist/agent/dsh-compaction-gate.js`）；`node dist/index.js --version` → 0.1.208 |

- **prompt-opt 0.9.0 重放与核验**：`diff -rq` 仓库 lib 对上游 `v090/po06/lib` 恰为 6 个本地改动文件（`client` / `index` / `control-api` / `eval-llm` / `rollout` / `assembly-gate`）且无 Only-in；`eval/`（25 文件）与 `README.md` / `HELP-0.6.md` / `HELP-0.6.en.md` 与上游逐字节相同；**反向三方合并**（current=上游 v090 / base=v084 / other=更新前本地副本）对 `rollout` / `assembly-gate` / `control-api` 输出与仓库文件逐字节相同 ⇒ `repo == 上游 ⊕ 本地 delta`。上游 0.9.0 在 `cordis.patch.yml` 里新增了第二条 insert（`preset-wish`），**未采纳**（本部署无该 preset，沿用单条本地 insert，id 仍 `prompt-optimizer`）。
- **issue #16 记录更正**：旧日志 [docs/update-check-log.md:250-254](docs/update-check-log.md#L250-L254) 写「插件 `lib/settings.js` 带本地 issue #16 补丁、升级时必须重放」——经核对**不成立**：本仓 0.8.4 的 `lib/settings.js` 与上游 v0.8.4 **逐字节相同**（sha256 `23cba71c…ac843b`），bySession 档位判据本属上游自带、并非本地补丁；0.9.0 更已自行修复并增强（逐会话 `previous` / `merged` 比对 + `delete after.framing`），故本轮直接取上游（sha256 `2a267e87…959d9b`）。该条历史记录保留原文，以此处更正为准。
- **codearts 强推后的差异收敛**：`git diff --stat HEAD -- plugin-src package.json cordis.patch.yml` = 5 文件 +7/−7（`package.json` 与 `cordis.patch.yml` 的 `name`、`plugin-src/client/jet-hub-styles.js` 的 `PLUGIN_ID`、`plugin-src/client/index.js` 的配置槽 key、`plugin-src/client/panel-entry.js` 的 `data-plugin`；`id` 仍 `codearts-auth`）；产物 `diff -rq` 对仓库 exit 0、`node --check` 244/244、定向 vitest 6 文件 157 passed / 0 failed、`tsc --noEmit` exit 0。上游 2026-10-27 新增的第 5 条内容级指纹（「DeepSeek Harness Web GUI」）随包分发。
- **ego-browser 0.9.4**：`files` 新增 `extension/`（4 个 MV3 文件，桌面扩展专用、Android 不适用）；`dsh-plugin.json` 新增 `residentExecutor` / `residentIdleMin` / `disableFrameRelay` / `tuiAutoOpenPanel` 设置项、`captureQuality` 取值改为 `low|balanced|high`，并移除未实现的 TUI Scene 声明（启动器 Kotlin 侧零引用，已 grep 确认）。
- **billion-context 0.1.208**：新增 `dist/agent/dsh-compaction-gate.js`（上游 `exports` 的 `./dsh-compaction-gate`，缺它会让 `dsh-client-modules` 报 client bundle not found 并使 WebUI 起不来）；新增运行时依赖 `mysql2 ^3.15.3` 只被 mysql 存储后端动态 `import`，本机未随包（启用该后端时会明确报错）；`dsh.bundle.patch.yml` 2256→2814 bytes。
- **兼容性复核**：用 dsh 自带的 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）在 runtimeVersion `0.2.1-rc.2` 与 `0.2.1-rc.4` 各跑一遍：11 内置 + 2 可选**全部 compatible**，仅归档的 `billion-context-dsh@0.2.27` 被判 incompatible（16 条钉死 peer，符合预期）。
- **本轮未验证项**：真机浏览器渲染/交互与 ego-browser 实机自动化只能由设备确认（本机无 Chrome/Chromium 二进制，`ego_*` 工具可加载可调用但会如实回报「未找到浏览器二进制」）；`extension/` 与 TUI 面在 Android 不适用；本轮**不重启 dsh**，插件热加载效果未验证。
### 插件版本同步记录（更早一轮 · 2026-10-21/22）

该轮（2026-10-21）对齐上游 5 个插件；dsh 本体 pin 保持 `0.2.1-rc.2`（npm `latest`/`next` 均为该版本，无更新）。同日稍晚又把 `dsh-codearts-auth` 从 tag `0.2.1-rc.2` 改装为上游 master `651dac30` 本地构建（包内 version 仍为 `0.2.1-rc.2`，内容领先 tag）；**2026-10-22 又更新到上游 master `70d1d64`，并定向恢复该压合提交移除的 `buddy` / `workbuddy` 渠道**；**同日下半天再把上游从 `70d1d64` 追到 `86e3591`**（4 个 perf/fix 提交：单渠道折算加总预算、`collectCreditsStatus` 有限并发 3 及其审计打穿的 8 处修复），同时**恢复被压合提交删掉的 probe-system 守卫**（探测请求必须带首条 system）。差异与恢复做法见下表与 [构建溯源](docs/codearts-master-build-evidence.md)。

| 插件 | 旧 → 新 | 合入方式 |
|---|---|---|
| `dsh-web-mobile` | 3.1.0 → **3.2.1** | npm 产物按本仓裁剪惯例替换（去 `assets/`、`src/`、`lib/types/`、`*.map`；8 个文件），`node --check` 通过；上游本版移除 `lib/reasoning-effort.js` |
| `dsh-prompt-optimizer-mobile` | 0.8.3-stable → **0.8.4-stable** | 上游 `v0.8.4-stable` 全量替换 `lib/`、`eval/` 与三份文档后，重放 3 组本地补丁（默认启用翻转、窄屏 UI、包名/注册 id 对齐）；`git merge-file` 对 6 个文件 0 冲突，新增 8 个 `advisor-*` 模块（详见 [FORK.md](app/src/main/assets/extra-plugins/dsh-prompt-optimizer-mobile/FORK.md)） |
| `dsh-codearts-auth` | `651dac30` → **上游 master `86e3591`**（保留 buddy/workbuddy + probe 守卫） | 在 buddy 恢复提交 `172e2a3` 上 `git merge origin/master`（merge-base `70d1d64`，无冲突；交集 3 文件）再追 4 个 perf/fix 提交（`9ba4505` 折算预算 / `9ca6c22` 有限并发 3 / `019e144` 预算断言 / `86e3591` 审计修复 8 处），合并提交 `b4c4933` + 顶层 chore `3b26420` + 测试侧修正 `167e0f4`（HEAD）；`pnpm build:all` 本地构建（226 个 js / 233 个文件 / 7.65 MiB / 8,017,482 bytes）+ **重放 172 行移动端扩展适配层**；上游 `70d1d64` 是一条**压合提交**（32 D 含 6 个 `src/buddy*.ts`、2 篇 buddy 文档、24 个 buddy 测试），没有可单独排除的 commit，故以新树为基线**定向恢复**这 8 个源文件并适配通用化改名（`buddy-balance-rank/selector.ts → balance-rank/selector.ts`），另补 `src/product.ts` 的 `BuddyProduct` 兼容别名与 `src/types.ts` 的成长 RPC 类型，并按**官方同形措辞**补回同批被删的第 4 条内容级风控指纹（DSH 身份首句；buddy 直连必需）；另恢复被上游整段跳过的 probe-system 守卫（`tests/unit/account-probe-adapter.spec.ts`，98+/12−，5 条 live：trae / lobsterai / workbuddy / buddy /「只有一条 user 消息」，断言未削）；包名仍对齐本地 `dsh-codearts-auth`（三处）；构建来源、产物哈希、15 处守卫对齐与复核命令见 [构建溯源](docs/codearts-master-build-evidence.md) |
| `@liustack/modsearch` | 5.10.6 → **5.10.10** | npm 产物整包同源替换（36 个文件，`diff -rq` 对新包为空） |
| `billion-context` | 0.1.198 → **0.1.202** | npm 产物按既有 10 文件裁剪集替换；上游本版已不再发行 sourcemap（tarball 8.9MB），保留文件与包内对应文件 `cmp` 一致 |

- **codearts 构建产物裁剪**：只复制 `lib/*.js`、`lib/qoder-auth-wasm.wasm`、`locale/`、`package.json`、`cordis.patch.yml`、`README.md`、`LICENSE`；剔除构建产物中的 225 个 `.d.ts` 与 450 个 `*.map`，保留 226 个 js、233 个文件、7.65 MiB（8,017,482 bytes；`node --check` 226/226 通过、`diff -rq dist TARGET` exit 0）。
- **codearts 适配层**：上游 master 已有基础 720px 窄屏块（`plugin-src/client/jet-hub-styles.js` 相对 tag +114 行），旧记录「上游仍未内置」已不成立；本仓 172 行扩展块重放进 `STYLES` 模板，出现 1 次，合并文件去掉该块后与干净构建产物逐字节一致（`final === clean.slice(0,93904) + block + clean.slice(93904)` 为 true，字节增量 8,604）；`registration-id-check` 通过（三处 id 一致）。**运行代码的 `dsh-providers-hub` 加载身份残留 0**；字面量共 7 处：`lib/login-failure.js:27` 的 `Symbol.for('dsh-providers-hub/loginNeedsExternalAction')` 是跨模块内部 key（上游测试 `tests/unit/login-external-action.spec.ts` 依赖该字面量，保留 1 处），另有插件自带 `README.md` 上游改名/安装示例 6 处（文档不参与加载，逐条见 [构建溯源](docs/codearts-master-build-evidence.md#6-上游改名残留)）。
- **prompt-opt 补丁重放**：`git merge-file -p`（本地 0.8.3 为 current、上游 0.8.3 为 base、上游 0.8.4 为 other）对 6 个文件全部 exit 0、0 conflicts；`node --check` 全通过；与上游 0.8.4 的 diff hunk 与旧补丁一一对应。另外把 0.8.4 新增的 `clientPath` 诊断探针里的上游包名改回 `dsh-prompt-optimizer-mobile`。
- **上游 codearts 单测（如实记录）**：上一轮 4 个相关 spec（registration-id / login-external-action / tencent-fingerprint / jet-hub-styles-ownership）→ **85 tests 全通过**（13 / 8 / 49 / 15；`tencent-fingerprint` 41→49）。本轮（追 `86e3591`）定向：`tests/unit/aggregate-expiry.spec.ts` 与 `openai-gateway-tencent-fingerprint.spec.ts` 通过；`tests/unit/jet-hub-rpc.spec.ts` **247 passed**（修回被行级合并丢掉的 `LOBSTERAI` import）；probe 守卫 spec `tests/unit/account-probe-adapter.spec.ts` **5 passed | 17 skipped**（EXIT 0；`tsc -p tsconfig.tests.json` EXIT 0）。全量 `npx vitest run tests/unit/` → **10,139 passed / 2 failed / 30 skipped（10,171）**，唯一失败仍是 `tests/unit/astudio-auth.spec.ts`（:299 / :408 的 Windows 反斜杠路径断言）——用**未经本地改动的上游 `70d1d64` 检出处**（`pristine70` worktree）复跑同样 2 条失败 ⇒ 既有平台问题、非本轮回归（上一轮 10,120 passed / 2 failed / 33 skipped；本轮 +19 passed、−3 skipped，因 `account-probe-adapter.spec.ts` 三条 `it.skip` 转 live + 2 条新增用例）。e2e **本轮未重跑**（上一轮口径 `13 passed / 226 skipped`）。命令与原始输出见 [docs/codearts-master-build-evidence.md](docs/codearts-master-build-evidence.md)。
- **本轮未发渠道请求**：buddy/CodeBuddy 只做静态构建与本地单测，未登录、未发任何模型请求；PR #130 声称的真机 400→200 因此**未复测**，本轮只证明第 4 条指纹已进入构建产物，不等同于渠道风控已放行。
- **buddy / workbuddy 渠道定向恢复**：恢复 6 个 `src/buddy*.ts` + 2 篇文档 + 24 个测试文件（15 unit / 9 e2e，含上游改名后的 `dsh-credential.ts` 断链修复），并适配新版通用化命名；src 侧接线 8 个文件（`provider-registry.ts:222/:234` 注册两渠道，`provider-credits` / `provider-expiry` / `aggregate-adapter` / `aggregate-expiry` / `auto-adapter` / `badge-subscription` 接入，`product.ts:215` 的 `BuddyProduct` 兼容别名）；宿主侧 `src/index.ts:589/:597` 注册 2 个 `BuddyAdapter`、11 个 `kind:'buddy'` 余额块，`src/jet-hub-rpc.ts:2256` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS` 含两渠道；通用接缝不做 buddy 定型（`src/credits.ts` / `src/provider-runtime.ts` 相对上游逐字未改）。⚠️ 上游同批删除的**第 4 条内容级风控指纹**（DSH 自身 system prompt 的身份首句 `You are an AI agent powered by DeepSeek Harness`，位于 `src/openai-gateway/tencent-fingerprint.ts`）也必须一并恢复：该模块 `TENCENT_PROVIDERS` 只含两渠道，漏恢复则 buddy 直连**每轮 400/11128**；本仓按上游 2026-10-21 实发验收过的**官方同形措辞**补回，并新增 8 条单测（41→49）锁住改写范围与两条网关路径。
- **追到上游 `86e3591`**：在 buddy 恢复提交 `172e2a3` 上 `git merge origin/master`（merge-base `70d1d64`，自动合并无冲突；交集仅 3 文件，`tests/unit/aggregate-expiry.spec.ts` 与上游逐字节相同），合入 4 个 perf/fix 提交 → 合并提交 `b4c4933`（双亲 `172e2a3` + `86e3591`）→ 顶层 chore `3b26420`（`dist/` 移出索引）→ 测试侧修正 `167e0f4`（HEAD）。上游语义标记全在：`EXPIRY_PROBE_BUDGET_MS = 8_000`（`src/aggregate-expiry.ts:356`）、`EXPIRY_PROBE_MIN_SLICE_MS = 1_500`（:375）、`DEFAULT_CREDITS_STATUS_CONCURRENCY = 3`（`src/jet-hub-rpc.ts:953`）、`MAX_CREDITS_STATUS_CONCURRENCY = 8`（:975 + 硬顶 :997）。机械核验：4 文件 `git merge-file` 重放与 HEAD 逐字节相同、两 src 文件 U+FFFD = 0 ⇒ 上游改动无一被覆盖，`npx tsc -p tsconfig.json --noEmit` exit 0。**行级合并不保证语义正确**：`tests/unit/jet-hub-rpc.spec.ts` 的 `LOBSTERAI` import 曾被自动合并丢掉（本仓该 spec 从 `651dac30` 恢复时符号还在 `src/product.ts`，上游 `9ca6c22` 新增并发用例用新家符号），定向跑报 `ReferenceError: LOBSTERAI is not defined`（:408），补回 import 后 247 passed。
- **probe-system 守卫恢复**（`tests/unit/account-probe-adapter.spec.ts`，98+/12−）：`describe.skip` → `describe`（现 :1060），5 条 live：trae :1070 / lobsterai :1081 / workbuddy :1095（新增）/ buddy :1105（新增）/「只有一条 user 消息」:1119；断言一条未削（`calls` 恰 1、`typeof system === 'string'` 且非空、`messages` 恰 1 且 `role === 'user'`）。失败模式已验证：临时注释 `src/account-probe.ts:304` 的 `system: PROBE_SYSTEM` ⇒ 4 failed / 1 passed（4 条全 `expected 'undefined' to be 'string'`），随后逐字节还原（`diff -q` 相同）。假桩适配 Task 8 新接缝 `src/account-probe.ts:201`；文件级 `beforeEach` 首次 `import('../../src/index.js')` 约 9.9s 超默认 hookTimeout ⇒ `}, 30_000)`（:57，只放宽墙钟预算）。`npx vitest run tests/unit/account-probe-adapter.spec.ts` = EXIT 0。
- 同步对齐 15 处「手写镜像 / 漂移」守卫（只补登记与计数，未删断言）；恢复文档里被 `repo-pii-guard` 命中的样例手机号改为等长同尾占位号 `13999991100`；`tests/unit/officeace-refresh-all.spec.ts` 两处 timeout 放宽到 30s（只放宽墙钟预算、断言未改）。逐项见 [构建溯源](docs/codearts-master-build-evidence.md)。
- **`dsh-web-mobile` 3.2.1 仍不带上游 `assets/*.png`**：沿用既有分发惯例（只带运行时 `lib/*.js`，不带 `src/`、`lib/types/`、`*.map`、README 截图）。

> ⚠ **需实机手测确认**：codearts 上游已有 720px 基础块，本仓 172 行扩展层覆盖 ≤560px；两层叠加后的视觉与交互效果**只能由真机确认**（源码与结构校验不能替代实机渲染，且扩展层是按旧版上游块重放的，未针对新版基础块重新设计）；`dsh-web-mobile` 3.2.1 与 `dsh-prompt-optimizer-mobile` 0.8.4 的窄屏布局同理。

### 弃用插件（retired）核查

「已弃用插件」在本仓有机械判据：`install/plugins.mjs` 的 `pruneRetiredBuiltins()`
把「extra-plugins 同步 marker 记录过、但已不在清单 `builtin` 中」的目录判为 retired，
装配时自动剪枝并注销其 `link:` 依赖与 `bundles` 条目。

**最近一次核查结论：不存在任何 retired 插件。** 各差集（设备 `files/plugins/`、
`assets/extra-plugins/`、`assets/optional-plugins/`、profile `dependencies`/`bundles`、
同步 marker 与清单）**全部为空**；清单 `builtin=11` = assets extra=11 = 设备 plugins=11；
装配日志中 `retired builtin pruned` 出现 **0** 次。

`optional-plugins/dsh-oh-we-need` 被本文档标为「历史遗留」，但它位于 **optional**、
从未装配、也不在 profile 中——属「分发但默认不装配」的正常状态，**不是 retired**。


**依赖桥接（`modsearch` 专有的隐性契约）**：该包的 `dsh/index.js` 以
`process.execPath` 拉起自带 CLI `dist/main.js`，而 CLI 顶层 `import { Command } from "commander"`
与 `from "undici"`。装配走的是 `link:`，pnpm **不会**为它按 `dependencies` 落盘；
它靠的是 `install/deps.mjs` 把 `dsh-prefix` 的 pnpm store 软链进
`files/plugins/node_modules` —— 实测解析到的实际版本是 **commander 15.0.0 / undici 8.11.2**
（本包声明 `^13.1.0` / `^7.29.0`，均**跨大版本**）。已在本机真跑
`modsearch doctor` 与 `modsearch search`（真实出网，Firecrawl 命中）验证这条链可用。
若将来升级 dsh 后这两个包被移出 store，`modsearch` 的工具会在调用时报
`Cannot find package 'commander'`，届时按同样方式补桥接即可。

**`dsh-ego-browser` 的运行期前提**：它需要一个可达的 Chrome/Chromium 二进制
（自动探测 PATH 与常见路径，也可在插件设置里填 `chromePath`，或用 `EGO_LINUX_CHROME`）。
**本机当前未安装任何浏览器**（`pm list packages` 无 Chrome/Brave/Edge，文件系统亦无二进制），
所以它在真机上的现状是：**插件能加载、`ego_*` 工具能注册与调用**，
但实际驱动浏览器会如实回报「未找到浏览器二进制」。
这属于**运行期外部前提**，不是装配/兼容性问题；`ego_doctor` 已把该状态列为一条
`browser binary: (none found …)` 的明确输出，不会静默失败。

## dsh 版本适配

钉死版本唯一真源是 [`app/src/main/assets/dsh-pin.json`](app/src/main/assets/dsh-pin.json)：
`DshFlow.PINNED_DSH_TAG` 与 `install-dsh.mjs` 的默认 tag 都读同一份（此前两处各自硬编码，漏同步就静默装错版本）。

当前适配目标：**`0.2.0-rc.2`**（npm `next` dist-tag）。
`stub-dsh.mjs` 内每个补丁块都标注了「已针对该版本核实的锚点状态」，失效时会打印显式 WARN 而非静默跳过。

> dsh 0.2.0 起 app-boot 新增**插件兼容性前置校验**（`evaluatePluginCompatibility` +
> `prepareProfileEntries`）：插件声明的 `@deepseek-ai/dsh*` peer 范围若不覆盖运行时版本，
> 该插件行会被**判定不兼容并在运行时禁用**——而 `dsh plugin add` 照旧成功，属静默失败。
> 故升级 `dsh-pin.json` 的 tag 时，必须回头核对每个插件副本 `package.json` 的 peer 范围，
> 并以装配后的 `files/plugin-status.json`（由 `auditBuiltinCompatibility()` 用 dsh 自带的同一函数生成）为验收依据。

0.1.7 相对上一适配版本（0.1.5-rc.2）的关键破坏性变更与处置：

| 变更 | 影响 | 处置 |
|---|---|---|
| 新增原生插件依赖 `node-addon-require-builtin`，Android 无预编译产物（registry 404） | **boot 级硬阻断**：失败点在插件树挂载之前，日志只有「web 未就绪」，无插件级报错 | 以纯 JS 顶替实现覆写该包，改用启动器本就传入的 `--expose-internals` 取 Node 内部模块 |
| `dsh-llm-pi-ai` 的 `sendAttribution` schema 声明形式变化 | 归因 UA 抑制补丁锚点漂移 | 按 0.1.7 实际代码重新锚定 |
| 新增 `@deepseek-ai/dsh-atomic-write` | 原子写走 rename/wx | 评估后按需补丁 |
| 包增删 48/6（新增 dsh-lazy-require、dsh-plugin-manager 等） | 依赖面扩大 | 逐锚点复核 |

已核实**未漂移**、继续有效的锚点：koffi ABI 断言（`dsh-win32-process`）、`attachment-local` 两点 link 调用、
`dsh-fs-local` chmod 三处字面量、`flock` 锚点、`dsh-settings` 已删除符号、`--no-open` 参数、前端静态模块种子表。

> ⚠ **`.pnpm` 同名包多副本会让「补丁已打」变成假象**（0.2.1-rc.2 真机事故）：
> 升级/回滚/修复安装都会在 `.pnpm` 下**新建目录**而不复刻旧目录，同一个包因此并存多个版本
> （实测最多的安装树里 `node-addon-require-builtin` 有 12 个副本）。补丁若只改写
> 「第一个命中」的副本，打到的是旧版；dsh 实际加载的新版仍是原生实现 → boot 期
> `No usable native binding found`，而日志里却是 `JS shim already applied`。
> 现约定：包定位统一走 `findAllPkgPaths()`（全副本覆盖），且 `DshFlow.stubPatchesPresent()`
> 会在信任 `stub-applied` marker 前**校验产物是否真的在树上**——安装树被重装时 marker 仍命中，
> 只靠 marker 会导致整段 stub 被永久跳过。

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
adb shell am start -n com.dsh.nextapp1/.ConsoleActivity --ez dsh true
# 等待控制台输出 “OK 4/4 dsh web started (http://127.0.0.1:3080)”
adb shell am start -n com.dsh.nextapp1/.MainActivity   # 或直接点应用图标
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
| WebView 白屏 / 无限 `connection lost` 重连 | 前端 API polyfill——**无条件注入 + 逐条 `if(!X)` 守卫**（新版 WebView 上逐条 no-op）。覆盖 `Promise.withResolvers` / `AbortSignal.timeout` / `any` / `throwIfAborted` / `structuredClone` / `Array.at` / `findLast` / `findLastIndex` / `toSorted` / `toReversed` / `with` / `Object.hasOwn` / `Object.groupBy` / `Map.groupBy`。曾改为按需注入，但消费者在**插件 client bundle**（`/plugins/**/client.js`）而非 app bundle，扫描恒 0 命中→跳过注入→照旧白屏，故改回；幂等判据带版本号（`SHIM_ID`） |

## 已知限制

- **系统 WebView 版本**：测试机原先为 Chromium 94，现已侧载升级到 **155.0.8059.16**（`com.google.android.webview`，arm64）。升级后实测 5 个兜底 API（`Promise.withResolvers` / `AbortSignal.any` / `AbortSignal.timeout` / `throwIfAborted` / `structuredClone`）**全部原生存在**，即上表那条 polyfill 的逐条 `if(!X)` 守卫在新内核上**确实 no-op**；控件栏的「逐字竖排」也在新内核上自愈（Chromium 94 下 flex 换行行为不同）。polyfill **保留不动**——它仍是旧 WebView 设备的兜底，且在新内核上零副作用。上游若再引入更新的 Web API，只需在 `stub-dsh.mjs` 的 polyfill 里追加一条 `if(!X)` 并**递增 `SHIM_ID`**，设备端会自动替换旧 shim，无需人工介入。
- `sharp` 为 stub：依赖图片处理的能力不可用，不影响核心会话功能。
- 设备内存有限：**不要在设备上执行 `pnpm build` / 类型检查**（会 OOM）；内置插件以源码打包进 APK，装配用官方 `dsh plugin`，不在设备端编译。
- 重新安装 APK 会终止旧 web 进程，需再次触发一键引导（幂等；已安装时走 npm 增量更新）。
- `dsh web` 只监听 loopback（本机 + adb forward 可访问）；`dsh-status-bridge` `/status` 同绑 loopback，且**要求 token**（回环在 Android 上没有 per-app 访问控制，任何有 INTERNET 权限的 app 都能直连；`/health` 是无需 token 的常量探针）。
- 状态桥接普通通道无开机自启：重启后由无障碍通道自动恢复，或打开一次 app 拉起；部分 ROM 对无障碍冷启懒绑定（关一次再开即可）。
- 悬浮窗 watchdog 为 30s 自续式精确闹钟；Doze 深度休眠下可能被合并到 ≥9 分钟一次。
- **PowerGovernor** 自适应后台：按「屏幕 × 任务态 × 后台时长」分档轮询（亮屏 1s / 灭屏任务 3s+唤醒锁 / 灭屏空闲 10~30s），看门狗仅在任务运行或刚灭屏 5 分钟内允许唤醒。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/plugin-roster.md`](docs/plugin-roster.md) | 插件名册：候选面、逐项决策、落地结果、来源可靠性核查 |
| [`docs/update-check-log.md`](docs/update-check-log.md) | 历次「检查更新」的可核证据（查询时间、dist-tag、实际版本号），append-only |
| [`docs/codearts-master-build-evidence.md`](docs/codearts-master-build-evidence.md) | `dsh-codearts-auth` 上游 master 本地构建的溯源、产物哈希、裁剪/适配层重放、**保留 buddy/workbuddy 的定向恢复**与单测/设备复验证据 |
| [`docs/codearts-master-build-evidence-20261021.md`](docs/codearts-master-build-evidence-20261021.md) | 上一轮（上游 `651dac30`）构建证据归档 |
| [`docs/plugin-conversion-audit.md`](docs/plugin-conversion-audit.md) | 脚本式 dsh 修改审计：12 处补丁逐项判定 + 升级守护清单 |
| [`docs/architecture-optimization-plan.md`](docs/architecture-optimization-plan.md) | 架构优化路线图（P0/P1/P2 + 执行状态） |
| [`docs/review-findings-scripts.md`](docs/review-findings-scripts.md) | 脚本层全量 review 记录 |
| [`docs/review-findings-r1.md`](docs/review-findings-r1.md) | overlay/service/ui 横切 review 记录 |
| [`docs/review-findings-bridge-plugins.md`](docs/review-findings-bridge-plugins.md) | 桥接类插件 review 记录 |
| [`docs/plugin-conversion-recon.md`](docs/plugin-conversion-recon.md) | directory-picker 插件化侦察（ctx.directoryPicker 服务缝） |

## 发布

预编译签名 APK 发布在 [Releases](https://github.com/qawse110/dsh-launcher-android/releases) 页。
发布流程：推 `v*` tag → GitHub Actions 构建签名 APK 并创建 Release（`release.yml`）。
