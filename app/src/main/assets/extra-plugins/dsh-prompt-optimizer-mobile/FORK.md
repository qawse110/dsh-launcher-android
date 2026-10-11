# dsh-prompt-optimizer-mobile（上游基线 + 本地改动清单）

> **状态**：本目录以上游 `v0.8.3-stable` 为基线，保留下述**两组**本地改动：
> ① 启用闸门默认值由「默认关」翻转为「**默认开**」；
> ② 移动端 Web UI 适配（窄屏面板尺寸、控件栏防竖排、安全区、触控目标）。
> 另有 ③ 包名/注册 id 对齐（本副本沿用 `dsh-prompt-optimizer-mobile`）。

## 来源与归属

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/WestFox-AwA/dsh-prompt-optimizer> |
| 上游作者 | 啃轮胎的西狐 |
| 基线 | `v0.8.3-stable`（上游将该版本线命名为 `dsh-po06`） |
| 本副本 | 上游 `po06/lib` + 下述本地改动（扁平化为 `lib/`，不含 `runtime/`） |
| 许可证 | BSD-3-Clause（见 [LICENSE](./LICENSE)，上游版权声明原样保留） |

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
| `lib/rollout.js` | `decideEnabled`：`settings.enabled !== true ⇒ 关` 改为 `=== false ⇒ 关` |
| `lib/assembly-gate.js` | 三处回落值：`{enabled:false, rollout:{mode:'off'}}` → `settings:{}, rollout:null`；`parseEnableIntent` 成功分支改为「只有显式 false 才算关闭」；两处文本都不存在时提前返回空 settings |
| `lib/control-api.js` | 三处 `intent.rollout.*` 改走 `normalizeRollout()`（对 `null` 安全） |
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

### 与上游的关系（0.8.3 复核结论）

- 上游 v0.8.3 把注入样式重构进了 `buildUiCss()`（原先是就地 `document.createElement('style')`）。
  本副本的 ⑧⑨ 两段已**移入该数组**，与上游新增的「接管属主 + MutationObserver 自愈」逻辑共存。
- 上游 v0.8.3 **仍未**加入窄屏适配，故本项必须重放。

## ⚠ 本地改动 ③：包名 / 注册 id 对齐

上游把包名改成了 `@dsh-external/dsh-arbiter-wf`，本副本沿用 `dsh-prompt-optimizer-mobile`
（profile 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 都按这个名字登记）。

`dsh-client-modules` 的 `resolveMeta()` 用 **package.json 的 name** 当模块行 id，
两者不一致时浏览器报 `loaded without registering "dsh-prompt-optimizer-mobile"`。

### 涉及文件（3 处）

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 顶部 `id: 'dsh-prompt-optimizer-mobile'` |
| `lib/index.js` | `export const name`、`PRODUCER_KIND`、`pkgMeta` 的键 |
| `lib/eval-llm.js` | notice 的 `source.kind` |

## 已移除（上游已自行修好，不再重放）

| # | 位置 | 内容 | 移除理由 |
|---|---|---|---|
| 1 | `lib/client.js` | bash 卡片让位（`mountKeyed` 的 `try/catch` + `priority:1`） | 上游 v0.8.3 已自行引入 `KEYED_PRIORITY = -10`，从根上避开「同 key 同 priority 抛错」；保留本地版反而会与上游的 `-10` 冲突 |
| 2 | `lib/bash/client.js`、`lib/bash/bash-tool-contract.mjs` | 独立的 bash 卡片模块 | 上游 v0.8.3 已把同一份组件**内联**进 `client.js` 的 `BashToolRow` IIFE，两个独立模块随之删除（全仓无引用） |

## 与上游同步

本目录不含 upstream remote。同步方式：

1. 取上游新 tag，把 `po06/lib` 复制为 `lib/`（扁平化，排除 Windows 专用的 `runtime/`）；
2. **重放本文件「本地改动」三节所列的改动**（`rollout.js` / `assembly-gate.js` /
   `control-api.js` / `index.js` / `client.js` / `eval-llm.js`）；
3. 同步 `README.md` / `HELP-0.6.*.md` / `eval/` 与本文件；
4. 真机复验：不碰任何配置、重新装配一遍，插件应仍为启用。
