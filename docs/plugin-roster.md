# 插件名单（供逐项决定去留）

> **背景**：原先「仅内置三个插件」（codearts-auth / prompt-optimizer / web-mobile）这条约束
> 已由用户本轮**主动撤回**。内置集合的构成改为**逐项决定**，本文件是决策输入，不代替决定。

「现状」两档的含义：

- **内置（builtin）**：源码在 `assets/extra-plugins/`，随 APK 装配进 web profile，装完即可用。
- **可选（optional）**：源码在 `assets/optional-plugins/`，**随 APK 分发但不默认装配**，
  需在「插件管理 → 可选插件」点「装配」才进 profile。

---

## A. 当前仓库候选（7 个 —— 这是本次的决策面）

| # | dir | 插件名 (id) | 来源 | 作用 | 现状 | 默认装配 | 体积 | 版本 |
|---|---|---|---|---|---|---|---|---|
| 1 | `dsh-web-mobile` | 移动端适配 (`dsh-web-mobile`) | 上游 mexiaosqwq/dsh-web-mobile | 竖屏/窄屏 Web 适配：抽屉导航、全宽会话、安全区、触控人体工学 | 内置 | 是 | 595 KB / 8 文件 | 3.0.3 |
| 2 | `dsh-prompt-optimizer-mobile` | 提示词优化 (`prompt-optimizer`) | 上游 WestFox-AwA/dsh-prompt-optimizer v0.8.1-stable **原版** | 发送前用独立 AI 把输入改写成命令。**本部署默认启用**（未配置即启用，仅显式 enabled:false 关闭） | 内置 | 是 | 约 960 KB | 0.8.1-stable |
| 3 | `dsh-codearts-auth` | CodeArts 多 Provider (`codearts-auth`) | 上游 gitee iJetLi/deepseek-harness-codearts | CodeArts（华为云）浏览器登录，经 `ctx.credentials` 存临时凭据；清单描述另称覆盖 Buddy/Qoder/Trae/Cline | 内置 | 是 | 2268 KB / 170 文件 | 0.1.0 |
| 4 | `dsh-status-bridge` | 状态桥接 (`dsh-status-bridge`) | **本仓自研** | dsh 运行状态 → Android 悬浮窗/通知/TTS（本地 HTTP，默认 :3190，token 鉴权，支持逐段流式） | 可选 | 否 | 14 KB / 3 文件 | 0.1.3 |
| 5 | `dsh-android-links` | Android 存储桥接 (`dsh-android-links`) | **本仓自研** | 在 dsh HOME 建 `sdcard → /storage/emulated/0` 软链，让工作区目录选择器直达 SD 卡 | 可选 | 否 | 10 KB / 4 文件 | 0.1.1 |
| 6 | `dsh-llm-codebuddy` | CodeBuddy Provider (`llm-codebuddy`) | 第三方（author: Axiaohungry） | CodeBuddy 中国区/国际版 LLM Provider（共存模式，不接管 llm-pi-ai） | 可选 | 否 | 363 KB / 20 文件 | 1.6.0 |
| 7 | `dsh-oh-we-need` | oh-we-need | **本仓自研**（`@dsh-external/`） | 把「we need to」句式做成 Skill 插件（按需调用，不注入系统提示词） | 可选 | 否 | 9 KB / 7 文件 | 0.2.0 |

## B. 删掉每个会牵连什么（决策关键）

| # | 删除的直接后果 | 连带项（删了要一起处理，否则留下断链） |
|---|---|---|
| 1 | 移动端 Web UI 不再适配窄屏 —— 这是本启动器的主要价值之一 | 无 |
| 2 | 提示词优化功能消失 | 前几轮做的移动端 UI 修复（面板溢出/触控目标/安全区）一并作废 |
| 3 | CodeArts（华为云）等 Provider 无法登录与接入 | 无（`node_modules` 与 `locale` 随之删除，约 2.2 MB） |
| 4 | **悬浮窗状态显示 / TTS 播报链路彻底失效** | Kotlin 侧 `StatusBridgeService` + `KeepAliveAccessibilityService` 两条链路依赖 :3190；若删插件，这两处也应一并评估（否则永远只报 `bridge-absent`） |
| 5 | 「添加工作区」看不到 SD 卡内容 | 旧方案（`stub-dsh.mjs` 直接改写 directory-picker-browse 源码）**已于 v4.10 移除**；删插件就必须接受能力缺失，或恢复源码补丁 |
| 6 | 无法用 CodeBuddy 作为 Provider | 与 #3 无重叠：codearts-auth 的包描述是 CodeArts 浏览器登录，不含 CodeBuddy；**但清单里 #3 的描述写了「Buddy」，两处表述不一致，建议你按实际需要判断** |
| 7 | 失去该 Skill（此前**从未接入装配链**，默认部署下等于不存在） | 无 —— 这一项删除成本最低 |

---

## E. 落地结果（用户逐项结论已执行）

用户结论：**内置** = `dsh-status-bridge`、`dsh-android-links`、`dsh-net-proxy`、
`dsh-provider-headers`、`dsh-vision`（先做 0.1.7-rc.2 适配再登记）；
**彻底删除** = 已退役项的仓库残留引用；**其余现存插件保持不动**。

> 已退役项的名录与按名单清理的分支已从仓库删除，见提交记录（原先存在一份
> `router-*` 预设名单与一份退役插件名录；前者只服务于恒不命中的分支且会误删
> routing-suite 仍在用的预设，后者不驱动任何行为）。

### 内置集合（11 个）

`dsh-web-mobile`、`dsh-prompt-optimizer-mobile`、`dsh-codearts-auth`（原有三个，未动）
＋ `dsh-status-bridge`、`dsh-android-links`（由 optional 移入 `assets/extra-plugins/`）
＋ `dsh-net-proxy`、`dsh-provider-headers`、`dsh-vision`（自 `prebuilt.tgz` 残留恢复并适配）
＋ `modsearch`（`@liustack/modsearch` v5.10.6）、`dsh-ego-browser`（v0.8.6）
＋ `billion-context-dsh`（v0.2.27）
（后三项为 npm 官方产物整包同源，见 README「本轮新增的三项」）。

> `billion-context-dsh` 加入前**不是内置插件**，而是 profile 里的普通 npm 依赖
> （`"billion-context-dsh": "^0.2.27"`）；本轮改为随 APK 内置分发（依赖规格已改写为 `link:`）。
> 它自带的 `cordis.patch.yml` 会**同时 disable 宿主的 `compaction-basic` 行**——
> 一个 realm 只能有一个 `ctx.compaction` 提供方，属插件自带行为。


### 可选集合（2 个，未动）

`dsh-llm-codebuddy`、`dsh-oh-we-need`。

### 适配记录

| 插件 | 问题 | 适配 |
|---|---|---|
| `dsh-provider-headers` | `require('@deepseek-ai/dsh-client-runtime/client')` —— 该包在 0.1.7-rc.2 **全仓 0 命中** | 改从 `@deepseek-ai/dsh-client-store` 取 `createSnapshotStore`（签名一致；宿主的 `dsh-client-ui-sidebar` 即如此） |
| `dsh-vision` | `import { settingsNamespace }` —— 该导出**已被移除** | 就地内联原实现（仅校验后原值返回） |
| `dsh-net-proxy` | 无 | 依赖仅 `node:*` / `react` / `dsh-client-ui-primitives` / `schemastery`，均存在 |

三者均通过**真机 ESM 链接测试**（`import()` 入口）：`apply` 均为 function。

> ⚠ **来源可靠性**：这三个插件的唯一本地副本是构建残留
> `app/build/intermediates/.../prebuilt.tgz`（**不在 git**，且 sha256 与 git LFS 指针不一致），
> 无法断言即当年入库版本。

## D. 不在仓库、可另行获取（1 个）

| 名称 | 来源 | 说明 |
|---|---|---|
| routing-suite | `yjh051108/dsh-routing-suite` | 第三方聚合仓库，**不能**用 `dsh plugin add github:...` 直接装配；由 `routing-suite.mjs` 走专门流程（下载源码 → 官方 plugin add → 预设拷贝）。是否需要一并决定去留由你定 |

---

## 需要你明确的两点

1. **「删除」的粒度**：
   - **(a) 彻底删** —— 从 `assets/<builtin|optional>-plugins/` 目录与 `plugin-manifest.json` 里移除，不可再装配；
   - **(b) 降级** —— 只从内置移出、降为「可选/不装配」，源码保留，用户仍可在插件管理页按需装配。
   (b) 可逆性高得多；(a) 更干净但恢复要走 git 历史。
2. **名单范围**：本文件 A 段是仓库现存 7 个候选（主决策面）。D 段（外部 1 个）
   是否也要纳入本轮决策由你定。

**我按你逐项的结论执行，不自行增删。**给到「编号 + 保留/删除/降级」即可。

---

## F. 后续一轮：内置插件同步上游最新版（版本同步，集合不变）

> A 段是**当时**的决策面（版本列已过时，保留作历史）。本节记录后续一轮
> 「把有上游的内置插件更新到最新版」的结果：**内置集合仍是 8 个**（当时），
> 只动源码与清单元数据，未增删插件、未调整 builtin/optional 归属、未升级 `targetDsh`。

| # | dir | 上游 | 旧 → 新 | 合入方式 |
|---|---|---|---|---|
| 1 | `dsh-web-mobile` | mexiaosqwq/dsh-web-mobile | 3.0.4 → **3.0.5** | 整包替换（npm 产物；本地副本此前即与上游逐字节同源，无本地改动） |
| 2 | `dsh-prompt-optimizer-mobile` | WestFox-AwA/dsh-prompt-optimizer | 0.8.1-stable → **0.8.3-stable** | 三方合并：上游 `po06/lib` 为基线，重放 3 组本地改动（见该目录 `FORK.md`） |
| 3 | `dsh-codearts-auth` | gitee iJetLi/deepseek-harness-codearts | tag 0.2.0-rc.2 → **tag 0.2.0-rc.5**（本地构建） | 源码仓库需 `pnpm build:all`；再重放移动端 UI 适配层 |
| 4 | `dsh-net-proxy` | mafeis/dsh-net-proxy | 0.2.5 → **0.8.0** | 整包替换（本地 `lib/` 自入库起从未被本地改动，仅 peer 范围曾放开，0.8.0 已自带覆盖 0.2.x 的范围） |

**未动**：`dsh-status-bridge`、`dsh-android-links`（本仓自研，无上游）、
`dsh-provider-headers`、`dsh-vision`（本仓无 upstream 字段，上游身份未确证，不擅自改）。

### 各条的处置要点

- **`dsh-prompt-optimizer-mobile`**：上游 0.8.3 把注入样式重构进 `buildUiCss()`，
  本副本的 ⑧⑨ 两段窄屏 CSS 已随之**移入该数组**（与上游新增的「接管属主 + MutationObserver 自愈」共存）。
  另有两处**不再重放**：bash 卡片让位（上游已自行引入 `KEYED_PRIORITY = -10`）、
  `lib/bash/client.js` 与 `bash-tool-contract.mjs`（上游已把同一组件内联进 `client.js` 并删除这两个模块）。
- **`dsh-codearts-auth`**：该仓库 tag 名与 `package.json` 的 version 不同步
  （tag `0.2.0-rc.5` 的包内写 `0.2.0-rc.3`），故清单 `version` 记包内实际值、`desc` 注明来源 tag。
  上游在 0.2.0-rc.5 中**已移除**一整套 ZCode 账号区样式（`.dim-jh-zcSection` 等，见源码注释），
  故本地适配层中对应的一小节**一并删除**（不违背上游「别把那套样式加回来」的告警）。
- **`dsh-net-proxy`**：0.8.0 新增 `relay.js` / `harness-proxy.js` / `system-proxy.js` / `traffic-log.js`
  等模块（本地 0.2.5 是裁减版），依赖面新增 `@deepseek-ai/dsh-http-proxy`、
  `dsh-client-ui-renderer`、`dsh-client-locale` —— 均已确认存在于运行时 `0.2.0-rc.2`。

### 装配验证（真机，`--plugins-only` 全链路）

    extra plugin dsh-web-mobile synced: 3.0.4 -> 3.0.5 (apk 300)
    extra plugin dsh-prompt-optimizer-mobile synced: 0.8.1-stable -> 0.8.3-stable (apk 300)
    extra plugin dsh-codearts-auth synced: 0.1.0 -> 0.2.0-rc.3 (apk 300)
    extra plugin dsh-net-proxy synced: 0.2.5 -> 0.8.0 (apk 300)
    builtin plugins assembled: 8 ok, 0 failed / 8 total
    compat audit: 8 compatible, 0 incompatible / 8 total (dsh 0.2.0-rc.2)

`files/plugin-status.json` 中 8 条均 `compatible: true`，无兼容性 WARN。
另用 `dsh --profile web --dump-config`（走真实的 `prepareProfileEntries` 前置校验）
复核：8 条插件行**均未被标 `disabled`**，stderr 0 行告警。

### 来源可靠性（更新后）

`dsh-net-proxy` 本轮已**确认上游并整包同源**，不再属于「来源不明」。

`dsh-provider-headers` / `dsh-vision` 本轮**未动**，并做了一次专项来源调研，结论如下：

| 插件 | 调研结论 | 依据 |
|---|---|---|
| `dsh-vision` | 上游身份可追溯但**版本落后于本地**，无可同步的新版 | `dsh-external/dsh-vision` 与 `william-jin-cmu/dsh-vision` 是同一仓库（301 重定向、`git ls-remote` 同 SHA）；该仓库**无 tag**，`main` 包内版本 `0.1.0`（未合并 PR 最高 `0.1.1`），本仓副本为 `0.2.0`。按名穷举 305 个 `dsh-vision` 仓库，无一含本副本的 `lib/backend.js` + `lib/client.js` 双后端结构 |
| `dsh-provider-headers` | **无可识别上游** | 同名 npm 包（duanyunlun `0.1.2`）与各候选仓库指纹均不匹配：本地用 `settings.section` 槽 + locale 命名空间 `providerHeaders` + `sendAttribution` 开关；候选用 `settings.models.provider-card` 槽 + `dsh.modelHeaders`。与本文件「源自 `prebuilt.tgz` 残留」的记载一致 |

> **证据强度如实标注**：上述排除基于**按仓库名搜索 + 原始文件结构探测**。
> GitHub 代码搜索需鉴权（本机 `api.github.com/search/code` 返回 401，无 token），
> 故「存在一个改了名、但文件集完全相同的仓库」这一情形**未被证明排除**。
> 两插件来源风险与版本落后状态照旧成立，本轮未改其任何字节。
