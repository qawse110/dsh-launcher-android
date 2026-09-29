# 内置桥接插件审查（dsh-status-bridge / dsh-android-links）

审查对象：随 APK 分发的两份「桥接」插件副本，登记于
`app/src/main/assets/plugin-manifest.json` 的 optional 段（默认不装配）：

| 清单 title | dir | 规模 | 入口 |
|---|---|---|---|
| 状态桥接 | dsh-status-bridge | 3 文件 7,265 B | lib/index.js |
| Android 存储桥接 | dsh-android-links | 4 文件 6,644 B | lib/index.js |

方法：静态通读两份源码 + 与 Kotlin 侧消费端对账 + 在 dsh 0.1.7-rc.2 安装树上核对事件契约 +
设备侧核对运行时状态。**每条结论都给出文件行号或可复现命令依据。**

---

## 一、dsh-status-bridge（状态桥接）

### S1【严重·功能性】监听的 `assistant/chunk` 在 0.1.7-rc.2 上不存在，流式分支是死代码

位置：`lib/index.js:61-73`（`case 'assistant/chunk'`）。

依据（设备 dsh 安装树实测）：

- 宿主会话事件类型全表（`@deepseek-ai/dsh-goal/lib/typert.host.js`，45 项）里 assistant 只有
  **`assistant/attempt`** 与 **`assistant/message`**，**没有 `assistant/chunk`**。
- 全仓 grep：`assistant/chunk` 仅出现在 `dsh-session-format-v0-to-v1` 与 `v1-to-v2` 两个
  **格式迁移包**；其中 v1→v2 把它列进 `RELEASED_V0_EVENT_DISPOSITIONS` 并**显式过滤**
  （`type !== "assistant/chunk"`）——即宿主把它当**已废弃事件**处理。
- 另一候选名 `assistant/live-chunk` 确有命中（26 处），但**只出现在 `/client` 文件**
  （客户端 wire 事件），**非服务端 `session/event`**；服务端事件表里同样没有它。

后果：该 case 永不命中 ⇒ `streamBuf` 永不累积 ⇒ `state.lastText` 只在
`assistant/message`（整条组装完成后）更新一次。而 Kotlin 侧是 **1s 轮询**
（`StatusBridgeService.fetchStatus` 每轮一次）——源码注释自己写明
「1s 轮询几乎必然错过 assistant/message」，也就是说**它用来弥补该缺陷的那条实时分支
本身不存在**。README 承诺的「TTS 播报链路」中「按句增量朗读」部分不可能工作。

建议：先确认 0.1.7-rc.2 中承载流式文本的服务端事件名（需再查 `dsh-agent` / `dsh-session`
侧 emit，而不是客户端常量），再改监听；若上游已不提供服务端流式事件，则应删掉该分支并
在 README 把「按句增量朗读」降级为「每条消息完成后播报」，避免继续承诺做不到的能力。

### S2【安全】loopback 无鉴权 + `Access-Control-Allow-Origin: *`，最多外泄 2000 字 AI 输出

位置：`lib/index.js:99-107`（CORS 头）、`:16-18`（`LAST_TEXT_CAP = 2000`）、`:135`（绑 127.0.0.1）。

- `/` 与 `/status` **无任何 token/鉴权**；源码注释（`:14-15`）已自认
  「对本机任意有 INTERNET 权限的 app 可读」。
- 但 `Access-Control-Allow-Origin: *` **超出了这个前提**：它让**任意网页上下文**也能跨源读走
  `/status`。Kotlin 消费端是原生 `HttpURLConnection`，**根本不需要 CORS**，这是纯增益的放宽。
- `lastText` 上限 2000 字 ≈ 10 分钟中文语音，远超气泡（≤40 字）与 full（≤160 字）所需；
  注释称「有界防泄露」，实质上仍是一次完整正文片段的泄露面。

建议：删掉 CORS 头；改为每次启动生成随机 token 写入文件、Kotlin 读取后带 `?token=` 请求
（与 dsh web 现有 `?token=` 同思路）；把 cap 降到实际消费长度，长文朗读改为分页拉取。

### S3【生命周期】顶层 `setInterval` 起服务、且卸载不关端口

位置：`lib/index.js:143-149`（模块顶层守卫定时器）、`:161-166`（`dispose()` 空实现）。

- 守卫定时器在**模块导入时**注册；15s 后只要 `globalThis.__dshStatusBridgeServer` 未监听就
  调 `ensureServer(0)` —— 也就是说「导入该模块」本身就具备**起 HTTP 服务**的副作用，
  与 cordis 的生命周期约定（副作用应在 `apply` 内、`dispose` 时收回）不一致。
- `dispose()` 明确「不关端口」。若在不重启进程的前提下卸载/禁用插件，3190 会继续监听
  且守卫定时器会把它**重新拉起**（`ctx.on` 随 fiber 释放，但 server 与 timer 不是）。

建议：守卫定时器移入 `apply()`；用 `ctx.on('dispose', …)` 关闭 server 并 `clearInterval`。

### S4【健壮性】两条重试路径互斥缺失，可能并发建服务

位置：`lib/index.js:130-138`（`error` 里 `attempt < 20` 各排 3s 重试）与 `:143-149`（15s 守卫）。

两条路径都会调 `ensureServer`，彼此**无互斥**；每次调用都 `createServer` 一个新对象，
只有 `listening` 的那个被 `globalThis` 持有，失败对象仅靠 GC。端口被占（dsh web 重启窗口、
或宿主已有实例）时会短时间反复建/弃 server，日志被 `console.error` 刷屏。

建议：收敛为单一重试入口 + 显式状态机（starting / listening / failed）。

### S5【正确性】`assistant/message` 分支的 `const text` 未加块作用域

位置：`lib/index.js:74-79`。属 `no-case-declarations`；当前其他 case 未引用 `text` 故未爆，
但一旦后续在别的 case 里加同名声明会撞 TDZ。建议加 `{ }`。

### S6【行为】`turn/end` 失败时用「出错：…」覆盖 `lastText`

位置：`lib/index.js:85-88`。失败前已生成的部分正文被丢弃，悬浮窗/TTS 只能看到错误摘要。
若产品期望「失败也播已生成内容」，应把错误放独立字段（如 `lastError`）而不是覆盖正文。
需产品确认，非纯技术判断。

### S7【死代码】两处

- `server` 变量（`:20` 声明、`:139` 赋值）**赋值后从未读取**——状态已由
  `globalThis.__dshStatusBridgeServer` 承担。
- `/health` 端点（`:124-125`）**无消费者**：全仓 grep `3190` 只命中 Kotlin 的
  `StatusBridgeService.kt:149` 与 `KeepAliveAccessibilityService.kt:209`，两者都只用 `/status`。

---

## 二、跨层耦合面（插件 ↔ Kotlin）

### X1【契约重复】端口 3190 硬编码在三处，无单一真源

- 插件默认值：`lib/index.js:13`（可用 `DSH_STATUS_BRIDGE_PORT` 覆盖）
- Kotlin：`StatusBridgeService.kt:149`、`KeepAliveAccessibilityService.kt:209`

风险：插件**支持**环境变量覆盖而 Kotlin **不支持** ⇒ 一旦有人设了 `DSH_STATUS_BRIDGE_PORT`，
Kotlin 侧静默连不上，且因为 `fetchStatus()` 吞掉全部异常，表现只是「dsh 不可达」，难以归因。
建议：由启动器写入单一来源（配置或环境变量），两侧同源读取。

### X2【风险】「响应不合法」被当成「dsh 不可达」，可升级为回滚重装

位置：`StatusBridgeService.kt:148-158`（`fetchStatus()` catch 全吞、空串也返回 null）、
`:135-140`（`poll-null` 分支调 `DshWatchdog.maybeRevive`）。

`maybeRevive`（`core/DshWatchdog.kt`）在 `isUp()` 为假时会走
`Supervisor.maybeRollbackOnCrashLoop`，**可能触发全量重装并拉起 dsh**。
即「桥接返回坏 JSON / 被截断的响应」有可能被放大成「回滚重装」。

设备实测心跳为 `{"status":"idle","note":"poll-null",...}`（3190 未装配，属预期），
说明该分支在默认部署下**一直在走**——判据越敏感，放大风险越高。
建议：区分「连不上」与「连上但响应不合法」；坏 JSON 不应计入 revive/回滚判据。

### X3【部署事实】这两份插件默认不装配，Kotlin 链路默认处于失效态

- `install-dsh.mjs` 只用 `MANIFEST.builtin`；optional 仅由用户在插件管理页点「装配」
  （`PluginManagerActivity.wireOptional`）。
- 设备实测：`files/plugins` 下**没有** dsh-status-bridge；profile `dependencies`/`bundles` 未登记；
  `ss -ltn` **3190 未监听**；心跳文件只有 `poll-null`。

这与 README（第 94 行「不装配则悬浮窗状态显示/TTS 播报链路失效」）自洽，但意味着：
**S1 那条死代码在默认部署下连「跑错」的机会都没有**——先修 S1 再谈装配才有意义。

---

## 三、dsh-android-links（Android 存储桥接）

这份整体质量明显好于 S1：它用「browse 原生支持符号链接」这一事实替代了对 dsh 本体的
源码改写，且我在 `stub-dsh.mjs:1040-1042` 核实**旧补丁确已移除**（不是两份实现并存）。

### A1【边界】`parseSpec` 的非法名过滤不完整

位置：`lib/index.js:47-51`。当前只挡 `/`、`.`、`..`。`join(HOME, '/etc')` 在 Node 里会被
归一为 `HOME/etc`（不产生越权），所以**不构成目录穿越**；但 `name` 含反斜杠时会被当成
字面文件名（Android 上合法但诡异）。另外 `target` 未做 `realpath` 校验，指向 HOME 内目录会
形成自引用环。建议：显式拒绝 `name` 含反斜杠，并对 `target` 做环/越界检查。

### A2【失败路径】替换链接时先删后建，中间失败会「丢链接」

位置：`lib/index.js:62-72`。目标变更是「`unlinkSync` 后 `symlinkSync`」；若后者失败
（权限等），位置会留空，而返回值只说 `skip … symlink failed`，**调用方看不出「原来的链接
已被删掉」**。建议：失败时回滚（重建指向）或至少在返回值里区分「未动」与「已删未建」。

### A3【设计观察】纯副作用插件，无 dispose、无状态

`apply()` 不接收 `ctx`、不注册服务、无清理钩子；`DSH_ANDROID_LINKS` 改短后旧链接会**永久留在
HOME**（README 已声明「卸载不回收」为有意为之）。这是可接受的产品选择，但缺少任何
「列出本插件创建过哪些链接」的手段，日后想清理只能靠人工。建议：记录创建清单（哪怕只写日志）。

---

## 四、清单与文档一致性

### M1 optional 条目缺 `version` / `upstream` 字段
`plugin-manifest.json` 的 builtin 条目有 `version`（如 `0.7.6-dshlauncher.1`）与 `upstream`，
而 4 条 optional **两者都无**。界面版本靠 `PluginManagerActivity.readVersion(e.dir)` 从
package.json 现读，所以显示没问题；但**清单自身不可追溯**（无法从清单知道它对应哪个上游版本），
这与上一轮给提示词插件补 `version` 的动机相同。建议补齐。

### M2 文档与实现一致（已核实，不是问题）
`stub-dsh.mjs:1040-1042` 明确记载 directory-picker-browse 的 SD Card 源码补丁已于 v4.10
审计时移除、改由 dsh-android-links 承担 —— 与插件 README 的说法一致，无重复实现。

---

## 五、结论与优先级

| 优先级 | 项 | 理由 |
|---|---|---|
| P0 | S1 | 代码注释所依赖的核心机制不存在；承诺的功能实际做不到，且**静默** |
| P0 | X2 | 一处坏响应可能被放大为「回滚重装」，影响面远超桥接本身 |
| P1 | S2 | 无鉴权 + CORS 通配外泄正文；修复成本低 |
| P1 | S3 | 卸载不关端口 + 导入即起服务；违反插件生命周期 |
| P1 | X1 | 端口三处硬编码、覆盖能力不对称，故障表现静默 |
| P2 | S4 / S5 / S6 / S7 / A1 / A2 / A3 / M1 | 健壮性与整洁度，可随下次改动一起做 |

---

## 六、修复落地记录（本轮逐条修完）

上面那份审查当时**没有改动任何代码**；本节记录逐条修复的结果与判据。

| 项 | 修法 | 判据 / 落点 |
|---|---|---|
| S1 | 删掉 `assistant/chunk` 分支；只按 `assistant/message` 更新 `lastText`；文件头与 README 同步降级「按句增量朗读」 | 证据：`dsh-session/lib/types/known-event-types.js` 权威事件表 56 项，含 chunk 者为 **0**，assistant 仅 `attempt`/`message` |
| S2 | 每次启动生成随机 token 写入 `<HOME>/status-bridge.json`(0600)；`/status` 无 token 回 401；**移除 CORS 头**；`LAST_TEXT_CAP` 2000→600 | 无鉴权请求不再能读到状态；原生消费端本不需要 CORS |
| S3 | 守卫定时器从**模块顶层**移入 `apply()`；返回 dispose 钩子关端口 + `clearInterval` | 卸载后不再监听 3190、不再被守卫拉起 |
| S4 | 加在途标记 `inFlight` 合并「error 重试」与「守卫」两条路径 | 不再并发 createServer |
| S5 | `case 'assistant/message'` 加块作用域 | 消除 `no-case-declarations` 与潜在 TDZ |
| S6 | 失败时**保留** `lastText`，错误改存独立字段 `lastError` | 失败前已生成的正文不再被丢弃（原「需产品确认」按「信息不丢失」方向落定） |
| S7 | 删除未使用的 `server` 变量；`/health` 改为**有明确用途**的运维探针并在文件头与 README 写明 | 无残留死代码 |
| X1 | 新增 `core/BridgeContract.kt` 作为端口+token **单一真源**；两个 Service 均从它读取，删除各自的硬编码 URL | 全仓 `3190` 只剩「默认值常量 + 注释」 |
| X2 | 新增 `FetchResult(Ok/Unreachable/Bad)`；只有 `Unreachable` 才进 `maybeRevive`，401/空/坏 JSON 只记 `poll-bad:*` | 坏响应不再可能被放大成回滚重装 |
| X3 | 契约文件不存在（=插件未装配）时心跳记 `bridge-absent` 并**跳过 revive**，与「装了但掉线」区分 | 默认失效不再静默；默认装配策略**未改**（用户未授权改开箱行为） |
| A1 | `parseSpec` 增加反斜杠拒绝；目标 realpath 后拒绝自引用 | 不再有路径归一的意外与自环 |
| A2 | 替换链接失败时**回滚为原目标**；回滚不成才返回 `LOST`，与「没动过」区分 | 失败不再静默丢链接 |
| A3 | 新增 `<HOME>/dsh-android-links.json` 记账本次创建/替换的链接 | 日后清理有据可依 |
| M1 | 4 条 optional 条目补 `version`；本地自研的两份桥接**不编造 upstream**，用段注释说明 | 清单可追溯 |

顺带修掉一个**会让本轮目标无法达成**的流水线缺陷（`.github/workflows/build-apk.yml`）：

- 旧版 `push` 只监听 `main`（本仓开发分支是 `next`）；且 push 事件下 `inputs.variant` 为空
  ⇒ 回落到 `release`，而 debug 产物的上传条件却是 `event_name == 'push'`，
  `if-no-files-found: ignore` 把「传了个不存在的文件」静默吞掉 ——
  即「推送后由 Actions 产出 debug 包」**实际上永远不会发生**。
- 现改为：先由 `Resolve variant` 步骤算出 variant 与两个布尔量，构建与上传都以它为唯一依据；
  `next` 分支 push 走 debug、`main` 保持 release；两个上传步骤都改成 `if-no-files-found: error`，
  不再允许「要产物却悄悄没有」。

**仍未处理（如实标注）**：S1 的降级是「承认拿不到流式」，不是「把流式做出来」。
若日后要在 Android 侧实现按句增量朗读，需要另找数据通道（客户端 wire 事件或 LLM 流直连），
不属于本次修复范围。
