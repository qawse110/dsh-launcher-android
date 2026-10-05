# dsh-prompt-optimizer-mobile（上游基线 + 一处本地默认值改动）

> **状态**：本目录以上游 `v0.8.1-stable` 为基线，**只保留一处本地改动**——
> 启用闸门的默认值由「默认关」翻转为「**默认开**」（见下节）。
> 原 fork 的另外几处改动（移动端适配、bash 卡片让位）已移除，理由记录在「历史」一节。

## 来源与归属

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/WestFox-AwA/dsh-prompt-optimizer> |
| 上游作者 | 啃轮胎的西狐 |
| 基线 | `v0.8.1-stable`（上游将该版本线命名为 `dsh-po06`） |
| 本副本 | 上游 `po06/lib` + 下述默认值改动（扁平化为 `lib/`，不含 `runtime/`） |
| 许可证 | BSD-3-Clause（见 [LICENSE](./LICENSE)，上游版权声明原样保留） |

## ⚠ 本地改动：默认启用

上游按设计**默认不启用**——装配闸门保守取 off，必须在配置里显式 `enabled:true` 才生效。
本部署把它翻转为：**只有显式 `enabled:false` 才算关闭；未配置 = 启用**。

理由：内置插件清单里**只有这一个**提示词插件，不存在与旧版
`@dsh-external/dsh-prompt-optimizer` 并存的现实可能（上游那条链在本部署从未装配）；
而用户看到的是「面板在、点了却没反应」，只会当成坏了。

显式关闭的语义与上游**一致**，只是默认值相反；`DOUBLE_INTERCEPT` 守卫仍然独立把关。

### 涉及文件（共 4 个，8 处）

| 文件 | 改动 |
|---|---|
| `lib/rollout.js` | `decideEnabled`：`settings.enabled !== true ⇒ 关` 改为 `=== false ⇒ 关` |
| `lib/assembly-gate.js` | 三处回落值：`{enabled:false, rollout:{mode:'off'}}` → `settings:{}, rollout:null`；`parseEnableIntent` 成功分支改为「只有显式 false 才算关闭」 |
| `lib/control-api.js` | 三处 `intent.rollout.*` 改走 `normalizeRollout()`（对 `null` 安全） |
| `lib/index.js` | 诊断字段 `rolloutMode` 对 `null` 容错 |

后两处是**必要配套**：回落值改成 `null` 后，直接读 `.mode` / `.defaulted` 会抛
`TypeError` 让插件整个挂不上。

### 想要关闭时

在 `.dsh/po06.json` 写：

    { "enabled": false, "settingsVersion": "0.6" }

## 历史：原 fork 的另外几处改动（已移除）

| # | 位置 | 内容 | 移除理由 |
|---|---|---|---|
| 1 | `client.js` | 移动端适配（视口感知面板尺寸、窄屏断点、安全区、触控） | **上游 v0.8.1 已自行吸收**（`clampOvSize` 上限改为 `Math.max(240, min(rg.w-16, v.w-16))`），移除无损失 |
| 2 | `bash/client.js` | bash 卡片让位（吞掉 `already has an entry` 冲突） | 真机实测：0.2.0 下**该冲突已不复现**，移除无影响 |

## 与上游同步

本目录不含 upstream remote。同步方式：

1. 取上游新 tag，把 `po06/lib` 复制为 `lib/`（扁平化，排除 Windows 专用的 `runtime/`）；
2. **重放本文件「本地改动」一节所列的 8 处**（`rollout.js` / `assembly-gate.js` /
   `control-api.js` / `index.js`）；
3. 同步 `README.md` 与本文件；
4. 真机复验：不碰任何配置、重新装配一遍，插件应仍为启用。