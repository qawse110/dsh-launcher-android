# dsh-prompt-optimizer-mobile（上游原版，非 fork）

> **状态变更（本文件原为 fork 说明）**：本目录**已更换为上游原版**，不再叠加任何
> dsh-launcher fork 改动。原 fork 的四处改动与实测结论记录在下方「历史」一节，供追溯。

## 来源与归属

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/WestFox-AwA/dsh-prompt-optimizer> |
| 上游作者 | 啃轮胎的西狐 |
| 基线 | `v0.8.1-stable`（上游将该版本线命名为 `dsh-po06`） |
| 本副本 | 上游 `po06/lib` **原样**（仅扁平化为 `lib/`，不含 `runtime/`） |
| 许可证 | BSD-3-Clause（见 [LICENSE](./LICENSE)，上游版权声明原样保留） |

## ⚠ 行为变更：默认不启用

上游按设计**默认不启用**——装配闸门保守取 off，必须在配置里**显式** `enabled:true`
才生效。真机实测（用设备上本插件的 `resolveEnableDecision` 跑真实配置）：

    无配置        → {"enabled":false, "code":"rollout-off",
                     "note":"…设置里没有显式 enabled:true ⇒ 保守不启用"}
    显式 enabled:true  → {"enabled":true,  "code":"enabled"}

而设备上 `.dsh/po06.json` 默认**不存在**，故**开箱表现为「面板在、点了没反应」**。
需要该功能时，在 `.dsh/po06.json` 写：

    { "enabled": true, "settingsVersion": "0.6" }

（这是原版的设计取向，不是缺陷；先前 fork 曾把默认值翻转为「默认启用」，现已移除。）

## 历史：原 fork 的四处改动（已全部移除）

| # | 位置 | 内容 | 移除后的影响 |
|---|---|---|---|
| 1 | `client.js` | 移动端适配（视口感知面板尺寸、窄屏断点、安全区、触控） | **上游 v0.8.1 已自行吸收**（`clampOvSize` 上限改为 `Math.max(240, min(rg.w-16, v.w-16))`），移除无损失 |
| 2 | `rollout.js` + `assembly-gate.js` | 默认值翻转为「默认启用」 | **移除后恢复上游的默认不启用**（见上节） |
| 3 | `bash/client.js` | bash 卡片让位（吞掉 `already has an entry` 冲突） | 真机实测：0.2.0 下**该冲突已不复现**（显式启用后也无报错），移除无影响 |
| 4 | `control-api.js` + `index.js` | 为改动 2 的 `rollout: null` 做 null 容错 | 改动 2 移除后**不再需要**（上游原版的 rollout 不会是 null） |

## 与上游同步

本目录不含 upstream remote。同步方式：取上游新 tag，把 `po06/lib` 复制为 `lib/`
（扁平化，排除 Windows 专用的 `runtime/`），再同步 `README.md` 与本文件。
**不再需要重放任何本地改动**。
