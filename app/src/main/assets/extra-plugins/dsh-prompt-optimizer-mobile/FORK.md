# dsh-prompt-optimizer-mobile（上游基线 + 本地改动清单）

> **状态**：本目录以上游 `v0.9.0-stable` 为基线，保留下述**两组**本地改动：
> ① 启用闸门默认值由「默认关」翻转为「**默认开**」；
> ② 移动端 Web UI 适配（窄屏面板尺寸、控件栏防竖排、安全区、触控目标）。
> 另有 ③ 包名/注册 id 对齐（本副本沿用 `dsh-prompt-optimizer-mobile`）。

## 来源与归属

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/WestFox-AwA/dsh-wish-specializer>（原 `dsh-prompt-optimizer`，GitHub 301 改名） |
| 上游作者 | 啃轮胎的西狐 |
| 基线 | `v0.9.0-stable`（上游将该版本线命名为 `dsh-po06`） |
| 基线 tag 对象 / commit | tag `v0.9.0-stable` = 注解对象 `982a97701a7ec4322438980598187ae5562fa350` ⇒ commit `567290518379afa5634c56caabdf274c8b4bc82a` |
| 上一基线 | `v0.8.4-stable` = `7d953f60457b2c4718fa0d159b6fda6f61b2bb15`（本副本 0.8.4 同步点） |
| 取包方式 | GitHub 代理（`HTTPS_PROXY=http://127.0.0.1:7890`）下 codeload tarball 遭 TLS 中断，改用 **git 浅取 tag**（`git fetch --depth 1 origin tag v0.8.4-stable tag v0.9.0-stable`） |
| 本副本 | 上游 `po06/lib` + 下述本地改动（扁平化为 `lib/`，不含 `runtime/`） |
| 许可证 | BSD-3-Clause（见 [LICENSE](./LICENSE)，上游版权声明原样保留；与上游根 `LICENSE` 逐字节相同） |

## ⚠ 本地改动 ①：默认启用

上游按设计**默认不启用**——装配闸门保守取 off，必须在配置里显式 `enabled:true` 才生效。
本部署把它翻转为：**只有显式 `enabled:false` 才算关闭；未配置 = 启用**。

理由：内置插件清单里**只有这一个**提示词插件，不存在与旧版
`@dsh-external/dsh-prompt-optimizer` 并存的现实可能（上游那条链在本部署从未装配）；
而用户看到的是「面板在、点了却没反应」，只会当成坏了。

显式关闭的语义与上游**一致**，只是默认值相反；`DOUBLE_INTERCEPT` 守卫仍然独立把关。

### 涉及文件（4 个）

| 文件 | 改动 |
|---|---|
| `lib/rollout.js` | `decideEnabled`：`settings.enabled !== true ⇒ 关` 改为 `=== false ⇒ 关`（连带 reason/note 文本） |
| `lib/assembly-gate.js` | 三处回落值：`{enabled:false, rollout:{mode:'off'}}` → `settings:{}, rollout:null`；`parseEnableIntent` 成功分支改为「只有显式 false 才算关闭」；`pickEnableIntent` 两处文本都不存在时提前返回空 settings |
| `lib/control-api.js` | 三处 `intent.rollout.*` 改走 `normalizeRollout()`（对 `null` 安全），并新增该 import |
| `lib/index.js` | 诊断字段 `rolloutMode` 对 `null` 容错 |

后两处是**必要配套**：回落值改成 `null` 后，直接读 `.mode` / `.defaulted` 会抛
`TypeError` 让插件整个挂不上。

### 想要关闭时

在 `.dsh/po06.json` 写：

    { "enabled": false, "settingsVersion": "0.6" }

## ⚠ 本地改动 ②：移动端 UI 适配

真机视口仅 **361 CSS px**（1264 物理 / 3.5 密度），上游样式表按桌面尺度排布，会
「右侧被裁、控件栏按钮被逐字竖排并与相邻宿主控件重叠、底部被系统栏盖住」。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 注入样式的 ⑧⑨ 两段窄屏 CSS（面板尺寸视口感知、控件栏不换行不压缩、窄屏收成图标按钮、触控目标 ≥40px、安全区内边距、拖动头 `touch-action:none`）；`S.optBtn`/`S.optSummary`/`S.optPop`/`S.bar`/`S.barRow` 内联样式同步收紧；给「优化选项」标题补 `data-po06="options-label"` 标记（窄屏 CSS 的隐藏规则要选得中它） |

### 与上游的关系（0.9.0 复核结论）

- 上游 v0.8.3 把注入样式重构进了 `buildUiCss()`（原先是就地 `document.createElement('style')`）。
  本副本的 ⑧⑨ 两段已**移入该数组**，与上游新增的「接管属主 + MutationObserver 自愈」逻辑共存。
- 上游 v0.9.0 的 `client.js` 在样式表与渲染段有大量改动（相对 0.8.4 共 63 个 diff hunk）。
  本次用 `git merge-file` 三方合并（current=本副本 0.8.4 文件、base=上游 v0.8.4、other=上游 v0.9.0），
  该文件出现 4 处冲突；解决原则：**注册 id / 窄屏 UI 取本地侧，上游新增的组件与样式取上游侧**。
- 上游 v0.9.0 **仍未**加入窄屏适配，故本项必须重放。

## ⚠ 本地改动 ③：包名 / 注册 id 对齐

上游在 0.8.1 把包名改成 `@dsh-external/dsh-arbiter-wf`，v0.9.0 又改成
`@dsh-external/dsh-wish-specializer`；本副本沿用 `dsh-prompt-optimizer-mobile`
（profile 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 都按这个名字登记）。

`dsh-client-modules` 的 `resolveMeta()` 用 **package.json 的 name** 当模块行 id，
两者不一致时浏览器报 `loaded without registering "dsh-prompt-optimizer-mobile"`。

### 涉及文件（4 处）

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 顶部 `id: 'dsh-prompt-optimizer-mobile'` |
| `lib/index.js` | `export const name`、`PRODUCER_KIND`、`pkgMeta` 的键、`clientPath` 诊断探针里写死的上游包名 |
| `lib/eval-llm.js` | notice 的 `source.kind` |

## 📌 归档项：issue #16（settings.js 的 bySession 判据）——**上游本就自带，无需重放**

本仓 `docs/update-check-log.md` 曾记载「`lib/settings.js` 的 `writeSettings` 带本地修复
（`gatePatch` 判据从『仅顶层键』扩到『顶层或该会话 bySession 档位键』），未回流上游，不能整包覆盖」。

**2026-10-27 复核推翻该结论**：本副本 `lib/settings.js` 与上游 `v0.8.4-stable` 的
`po06/lib/settings.js` **逐字节相同**（sha256 前缀 `23cba71ca0823d71`），即该 bySession 判据
（`sessionTurnsOn` + 注释「issue #16」「issue #27」）**本来就在上游 0.8.4 内**，并非本地补丁。
上游 v0.9.0 又把它写得更精细（改用 `Object.entries(patch.bySession).some(...)` 逐会话比对
`previous`/`merged` 的档位键变化），并新增 `delete after.framing`。

⇒ 处理：`settings.js` **直接取上游 v0.9.0 版本**，不重放任何本地改动。
（`docs/update-check-log.md` 的记述由 lead 统一更正。）

## 已移除（上游已自行修好，不再重放）

| # | 位置 | 内容 | 移除理由 |
|---|---|---|---|
| 1 | `lib/client.js` | bash 卡片让位（`mountKeyed` 的 `try/catch` + `priority:1`） | 上游 v0.8.3 已自行引入 `KEYED_PRIORITY = -10`，从根上避开「同 key 同 priority 抛错」；保留本地版反而会与上游的 `-10` 冲突。（v0.9.0 的 `lib/client.js` 仍含 `KEYED_PRIORITY` 与 `BashToolRow`，已核实） |
| 2 | `lib/bash/client.js`、`lib/bash/bash-tool-contract.mjs` | 独立的 bash 卡片模块 | 上游 v0.8.3 已把同一份组件**内联**进 `client.js` 的 `BashToolRow` IIFE，两个独立模块随之删除（全仓无引用）。**v0.9.0 复核：`po06/lib/bash/` 仍是 10 个 `.mjs`（bash-diagnostics/bash-output/index.js/pg-jobport/process-governance/runtime-integrity/runtime-layout/runtime-provision/shell-capability/workspace-semantics），并未重新引入 `client.js` 或 `bash-tool-contract.mjs`** ⇒ 本项维持移除。 |

## 与上游同步

本目录不含 upstream remote。同步方式：

1. 取上游新 tag，把 `po06/lib` 复制为 `lib/`（扁平化，排除 Windows 专用的 `runtime/`）；
2. **重放本文件「本地改动」三节所列的改动**（`rollout.js` / `assembly-gate.js` /
   `control-api.js` / `index.js` / `client.js` / `eval-llm.js`）；
3. 同步 `README.md` / `HELP-0.6.*.md` / `eval/` 与本文件；
4. 真机复验：不碰任何配置、重新装配一遍，插件应仍为启用。

> 方法记录：用 `git merge-file -p <本副本旧文件> <旧基线> <新上游>` 重放，并逐文件记录
> exit 码与冲突数；合并结果全部 `node --check`。

## 0.9.0 升级记录（2026-10-27）

- 上游 `po06/lib`：**新增 12** 个模块（`advisor-delivery-gate.js`、`advisor-ledger.js`、
  `advisor-session.js`、`advisor-voice.js`、`ask-instruction.js`、`inference-context.js`、
  `inference-directions.js`、`inference-evidence.js`、`inference-focus.js`、
  `inference-profile.js`、`optimization-runs.js`、`wish-check.js`）；**删除 1** 个
  （`framing.js`，连带上游从 settings/control-api 里摘掉 `framing` 字段）；**内容改动 22** 个。
  文件数 72 → 83。
- 本地改动文件与上游改动的重叠：6 个本地改动文件中，上游 v0.9.0 也改了 4 个
  （`client.js` 63 hunk、`index.js` 48 hunk、`control-api.js` 12 hunk、`eval-llm.js` 3 hunk），
  未改 2 个（`rollout.js`、`assembly-gate.js`）。
- 三方合并结果：71 个 0.8.4/0.9.0 共有文件里，**68 个 exit 0 / 0 冲突**；
  3 个冲突：`client.js` 4、`index.js` 4、`eval-llm.js` 1（共 9 处）。
  冲突解决后 `node --check` **83/83 通过**。`framing.js` 按上游删除处理（不重放）。
- `package.json`：**保持本地** `name: dsh-prompt-optimizer-mobile` 与本地 `description`／`files`／
  `dsh` 段；仅 `version` 由 `0.8.4-stable` 改为 `0.9.0-stable`。
  上游相对 0.8.4 的 `peerDependencies`（`cordis >=4.0.0-rc <5`）、`peerDependenciesMeta` 均**未变**，
  上游仍**无** `dependencies`、**无** `engines`。
- `cordis.patch.yml`：**保持本地单条** `insert`（`id: prompt-optimizer` /
  `name: 'dsh-prompt-optimizer-mobile'`）。上游 v0.9.0 在该文件里新增了**第二条** `insert`
  （`preset-wish` / `name: @deepseek-ai/dsh-agent-preset`，配套 `po06/presets/wish.patch.yml`）；
  本部署的 profile 未登记该预设（全仓无引用），故**不采纳**该条，避免与自有接入方式冲突。
- 文档同步：`README.md`（0.8.4: 37164 B → 0.9.0: 39722 B）与 `HELP-0.6.md` / `HELP-0.6.en.md`
  取上游 v0.9.0 版本（上游把 HELP 用户正文改写成更短的形态：
  `HELP-0.6.md` 8304 B → 1391 B，`HELP-0.6.en.md` 8366 B → 1503 B）。
  `eval/` 由 14 个文件同步到 25 个（新增 11 个：`BENCH-*` 10 个 + `LATENCY-20261025.json`；
  `install-drill.json` / `release-check.json` / `release-suites.json` 有内容更新；
  本地无 v0.9.0 中不存在的 eval 文件 ⇒ 无需删除）。
- 上游 v0.9.0 顶层还新增 `ADVISOR.md`、`NEXT-constraint-ledger.md`、`RELEASE-CHECKLIST.md`、
  `doc/how-it-works.html`、`presets/wish.patch.yml`、`scripts/`、`test/` 等；本副本沿用既有交付范围
  （`lib` + `README` + `HELP` + `eval` + 包元数据），**未纳入**这些文件（与 0.8.4 时的取舍一致；
  `lib` 代码里不引用 `presets/` 或 `wish.patch.yml`，故不影响运行）。
- 已知的非功能性瑕疵：上游 v0.9.0 `README.md` 首页含相对链接 `../docs/OPTIMIZATION-PIPELINE.md`，
  在本 asset 目录内无法解析（0.8.4 的 README 无此链接）；仅文档链接，不影响加载。
