# dsh-prompt-optimizer-mobile（dsh-launcher fork）

本目录是 **dsh-launcher-android 自己维护的 fork**，不是上游产物的原样落盘。

## 来源与归属

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/WestFox-AwA/dsh-prompt-optimizer> |
| 上游作者 | 啃轮胎的西狐 |
| fork 基线 | `v0.8.1-stable`（上游将该版本线命名为 `dsh-po06`） |
| 本 fork 版本 | `0.8.1-dshlauncher.1` |
| 许可证 | BSD-3-Clause（见 [LICENSE](./LICENSE)，上游版权声明原样保留） |

## 本 fork 相对上游的改动（全部是本仓库的意图，不是上游行为）

### 1. 移动端适配（本 fork 的主要目的）

> **v0.8.1 起上游已自行吸收本项**：上游把 `clampOvSize` 的上限改成
> `Math.max(240, Math.min(rg.w - 16, v.w - 16))`（视口感知，且比本 fork 还多考虑了
> 会话窗宽度 `rg.w`），面板不再超屏。故本次升级**不再重放本项**，直接采用上游实现。
> 本节保留为历史记录，说明该问题的来龙去脉。

**（历史）本 fork 当时的做法**：上游当时没有移动端适配，面板尺寸硬编码 `400×320`，
而本机（Sharp 803SH / Android 11 / WebView 94）视口实测仅 **361 CSS px**
⇒ 面板超屏、拖不窄、按钮点不准。
### 2. 启用默认值翻转为「默认启用」
上游按设计**默认不启用**（装配闸门保守取 off，须在配置里显式 `enabled:true`）。
本部署内置清单里只有这一个提示词插件，不存在与旧版并存的现实可能，
而用户看到的是「面板在、点了却没反应」。故本 fork 改为：
**只有显式 `enabled:false` 才算关闭；未配置 = 启用**。

涉及 `lib/rollout.js` 与 `lib/assembly-gate.js` 三处：
- `decideEnabled`：把 `settings.enabled !== true ⇒ 关` 改成 `=== false ⇒ 关`；
- `parseEnableIntent` / `pickEnableIntent`：回落值由 `{enabled:false, rollout:{mode:'off'}}`
  改为 `settings:{} / rollout:null`（「没表态」而非「显式关闭」）；
- `resolveEnableDecision`：不再因「拿不到旧插件作用域」一律拒绝。

**确定**旧插件仍在装时的 `DOUBLE_INTERCEPT` 守卫保持不变 —— 真有并存风险时依然拦住。

### 3. 客户端 bash 卡片让位
非 Windows 平台宿主自带 bash 卡片，而上游 0.7.6 的 client 仍无条件注册
`key:'bash'`，抛 `keyed slot "tool.call.toolview" already has an entry for key "bash"`。
上游只修了服务端让位，客户端漏了。本 fork 用与上游服务端**同源**的判据补齐：
`hostProvidesBashCard = !/Windows/i.test(navigator.userAgent)`。

### 4. 目录扁平化 + 产物裁剪
上游发行包为 `po06/lib/...` 且 `files` 含 `po06/runtime`（**Windows 专用 msys2 bash，
163 文件 45.8 MB**）。本 fork 扁平为 `lib/`，并**不含** `runtime/`：
该目录只被 `lib/bash/` 使用，而让位判据在非 win32 平台恒成立 ⇒ 永不被使用。

## 与上游同步

本 fork **未**保留 upstream remote（启动器仓库不引入上游历史）。同步方式：

1. 取上游新 tag，`git clone --depth 1 --branch <tag>` 到临时目录；
2. 以本目录为基准重放本节 1/3/4 三项改动（4 中的扁平化 = 把 `po06/lib` 提到 `lib/`），
   并复核 `lib/rollout.js` / `lib/assembly-gate.js` 的默认值改动是否仍落在正确位置；
3. 更新本文件与 `package.json` 的 `version`（`<上游版本>-dshlauncher.N`）；
4. 真机复验：插件挂得上、面板在 WebView 里布局与触控正常、控制台无 slot 冲突报错。

## 注意
本 fork 的判定默认值与上游**相反**，请勿直接把上游说明文档当成本 fork 的行为描述。
上游自述该版本线「尚无效果证据」；本 fork 未改变其效果层面的任何实现，只改默认开关与移动端表现。
