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
| 2 | `dsh-prompt-optimizer-mobile` | 提示词优化 (`prompt-optimizer`) | 上游 WestFox-AwA/dsh-prompt-optimizer v0.8.1-stable **原版** | 发送前用独立 AI 把输入改写成命令。⚠ 上游**默认不启用**（需显式配置） | 内置 | 是 | 约 960 KB | 0.8.1-stable |
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

### 内置集合（8 个）

`dsh-web-mobile`、`dsh-prompt-optimizer-mobile`、`dsh-codearts-auth`（原有三个，未动）
＋ `dsh-status-bridge`、`dsh-android-links`（由 optional 移入 `assets/extra-plugins/`）
＋ `dsh-net-proxy`、`dsh-provider-headers`、`dsh-vision`（自 `prebuilt.tgz` 残留恢复并适配）。

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
