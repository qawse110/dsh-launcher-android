# 参考项目（dsh-mobile-apk）如何适配最新 dsh —— 机制分析

> 参考仓库：`_ref-dsh-mobile-apk/`（0.13.6，引擎 0.1.1-rc.2 基座 → 0.1.2-rc.1 overlay）
> 本仓库：npm 安装 + 钉死 `0.1.1-rc.1` + `stub-dsh.mjs` 补丁
> 分析日期：2026-09-10。所有结论均给出来源文件，可按图索骥。

## 一、总览：三层补丁体系 + 一张升级登记表

参考项目对 dsh 的适配不靠「改 dsh 源码」（上游零改动，AGENTS.md §1 铁律），而是三层递进：

| 层 | 时机 | 载体 | 幂等机制 | 失败策略 |
|---|---|---|---|---|
| ① 构建期 vendor 补丁 | 打快照时 | `scripts/patches/`（registry.json + apply-patches.mjs） | 锚点 marker 幂等 | `--check` 门禁拒绝打包 |
| ② 构建期引擎树补丁 | overlay 覆盖后 | 同上，`scope: engine`（pi-drift-F1） | marker 复查 | 施加后逐条断言 marker 在场 |
| ③ 运行时补丁 | 每次引擎启动前 | `assets/patched/` 整文件覆盖 | **内容指纹**判定 | 目标包缺席跳过；hash 提取失败宁不注入 |
| ⓪ 引擎升级本体 | 打快照时 | `engine-overlay.json` 逐包覆盖登记表 | sha512 + 缓存 + 版本断言 | 任何断言失败 → `process.exit(1)` |

## 二、引擎升级机制：engine-overlay.json（0.13.3 W1）

**来源**：`scripts/snapshot-config/engine-overlay.json` + `scripts/build-snapshot-013.mjs` 0e 段（L156-260）+ 门禁 `scripts/check-engine-overlay.mjs`。

### 2.1 为什么不用 npm 重装整个引擎

> 「npm 别名包装不出完整引擎（核心包在 devDependencies，已实证）」——build-snapshot-013.mjs L159

所以方案是：**设备基座继承旧引擎树（0.1.1-rc.2 的 220 包 monorepo），构建期按登记表逐包拉新版 tgz 覆盖**。

### 2.2 登记表数据面（六类条目，各有精确语义）

| 条目 | 语义 | 关键细节 |
|---|---|---|
| `rootPackage` | 引擎别名包本体 `@deepseek-ai/dsh@0.1.2-rc.1` | **只换 lib/ 与 package.json，绝不动 node_modules 子树**（= 全引擎依赖） |
| `packages` | @deepseek-ai 域逐包覆盖（191 重发布 + 29 新增，共 220） | scoped 包落 `node_modules/<scope>/<name>` |
| `vendorTop` | 顶层新增第三方闭包（cosmokit/compression/undici 等版本闭包审计产出） | |
| `nested` | 嵌套进宿主包 node_modules 的第三方（lexical/@octokit/ACP/xterm 系） | 见 2.3 保存-还回机制 |
| `pins` | `@earendil-works/pi-ai` 精确 pin 0.85.1 | 升级必须跑 `pi-catalog-diff.mjs`（模型目录 diff 例行检查） |
| `keepUnpublished` | 未重发布包（树内保留 rc.2 原样） | 构建后断言仍在树内，防未来误删 |

### 2.3 覆盖实现的两处精细处理（L207-219）

1. **嵌套依赖保存-还回**：npm publish 不含 node_modules，直接 rm 会连带删掉安装期解析出的嵌套依赖（react/@tanstack、chokidar、pi-ai otel 三处先例）→ 覆盖前 `mv node_modules` 暂存，解压新包后还回。
2. **拉取链**：npm 镜像链（registry.npmjs.org + npmmirror）→ 元数据 dist.sha512 校验 → 缓存 `.deploy-tmp/engine-overlay/` 幂等。
3. **收尾断言**：根包 package.json 版本必须 == 登记表 `engineVersion`，不等即拒。

### 2.4 升级门禁（check-engine-overlay.mjs）

对 `snapshot.tar.xz` **单遍流式扫描**，断言：
1. 根包版本 == engineVersion；
2. 220 包逐包在场且版本**精确一致**；
3. vendorTop/pins/nested 同上；
4. keepUnpublished 包仍在树内（任意版本）;
5. `dsh-agent-presets` 内置 presets/ 非空（0.1.2-rc.1 新载体）;
6. registry 内全部 `scope=engine` 补丁的 marker 在目标文件内（登记表驱动，新增补丁自动纳入抽验）。

任何一条失败 → 拒绝打包。**「exit 0 但补丁缺席」的半成品从此不可能出厂。**

## 三、补丁框架：registry.json + apply-patches.mjs（Phase 2a 统合）

**来源**：`scripts/patches/README.md` + `registry.json`。

### 3.1 登记表驱动，双轨交叉校验

- 每个 patch：`id` / `target` / `summary` / `provenance`（哪个版本、哪个 issue 引入）/ `marker`（幂等标记）/ `soft`（可选，锚点失配仅告警）/ `scope`（vendor|engine）。
- runner 启动时与 IMPLS **一一对应交叉校验**，漂移即拒。
- 三种模式：`--check`（门禁只读验证）/ `--apply`（幂等施加+自验）/ `--list`。

### 3.2 补丁内容示例（对 dsh 本体/vendor 的最小干预）

| id | 目标 | 干预 |
|---|---|---|
| market-A | dshmarketplace index.js | pre-execute 守卫：修上游 listener 恒返 undefined 导致全工具崩溃 |
| market-B | 同上 | execPath 安全化：TERMUX__PREFIX 兜底烧写 node 绝对路径（修 linker64 回退污染） |
| pi-drift-F1 | **引擎树** llm-pi-ai | 三处致命 `invalid()` 改告警+跳过——**单条过期模型 id 永远打不死整包**（模型目录漂移降级） |

### 3.3 锚点失效处置流程（README 明文）

> `--apply` 报「锚点未命中」= 上游 minified 形态已变 → 从报错附带的上下文人工核对新形态 → 更新锚点与 marker → 重放。**禁止为了过门禁放松 check 语义。**

## 四、运行时补丁：assets/patched/（设备端，每次启动前）

**来源**：`docs/AGENTS/RUNTIME-PATCHES.md`（权威登记，逐文件 byte 数/目标/维护约定）+ `EngineManager.applyRuntimePatches()`。

### 4.1 机制要点

- **整文件覆盖，非 delta**：asset = 目标文件的完整修改版拷贝（半截文件 = 引擎启动即崩，写入前不可能知道 diff 是否完整）。
- **内容指纹判定**（而非 marker 字符串）：字节完全一致才跳过——历史教训 v1→v2：固定 marker 在目标更新后仍命中，新 asset 永不落盘。
- **hashAdaptive**（仅 web-frontend/index.html）：引擎 dist 引用 content-hash bundle 名，引擎升级 hash 变化 → patched 模板先从引擎现存 index.html 提取当前 hash 再替换旧引用（提取失败原样返回，「宁不注入不写坏」）。
- **目标包缺席即跳过**：上游裁包时不留死覆盖。

### 4.2 现存 6 补丁全为 Android sepolicy/FUSE 适配

剪贴板兜底（primitives）、link(2)→rename 回退（attachment-local / session-persistence-jsonl / fs-local 三族）、viewport+ES2022 polyfill（web-frontend）、llm-deepseek 已退役（rc.2 原生捆绑 vision-exp）。

## 五、升级引擎版本的实战约定（坑 38，模拟器实锤）

> 0.1.2-rc.1 升级时：rc.2 锁定的运行时补丁整文件覆盖 → **新引擎代码被旧版回退**（`persistence.borrowSession is not a function` → 一切会话写入全断）。

由此沉淀的硬约定（RUNTIME-PATCHES.md §3-2）：

1. **逐补丁核对上游是否已原生修复——能退役则退役**（fs-local/primitives/llm-deepseek/textzoom/onImagePicked/describeImage 六项退役先例，「能不补则不补」）；
2. 重出 asset **必须从新版本包文件改起**，不从旧 asset 迭代；
3. 升级后 grep 特征函数（如 `borrowSession`）验证新代码未被回退。

## 六、API 面变化的壳侧适配（0.1.1-rc.x → 0.1.2-rc.1）

| 上游变化 | 壳侧适配 | 来源 |
|---|---|---|
| /api 全前缀浏览器鉴权（401 栅栏，无绕行） | **EngineAuth**：P0=engine.log 解析 `?token=` → GET / 捕 303 Set-Cookie；P1=从 .credentials.yaml 自 mint HMAC cookie；token/cookie/secret 禁落日志；401 自愈（invalidate+refresh） | EngineAuth.kt |
| 探测会拿到 401 | **EngineProbe 把 200/401/303 都判 running**——「401 绝不能让 watchdog 杀掉健康引擎」；error 区分 timeout（代理/慢启）vs refused（真死） | EngineProbe.kt:46-57 |
| WS 握手也过鉴权 | MuxClient attachMux refresh-on-miss | BRIDGE-API.md |
| agent-presets 载体变化 | 门禁断言 presets/ 非空 | check-engine-overlay.mjs |
| client-ui 包结构重组 | ui-responsive 0.1.13「store-rehome」适配（client-store 内联等） | changelog |
| pi-ai 模型目录漂移 | pi-drift-F1 降级补丁 + pi-catalog-diff 例行 diff + dsh-model-capability 目录快照（gen-model-catalog.mjs 从引擎树同源生成，升级自动跟随） | registry.json / 0g 段 |

另注意：**不伪造 TERMUX_VERSION、不注入无消费端的栅栏键**（本仓库 review-r4 同结论，两侧独立收敛到同一判断）。

## 七、插件化适配层：能插件绝不补丁

cordis.patch.yml 用 `-id disabled` + `insert` 官方替换缝（非覆盖式 hack）：

- `bash-sandbox` → **dsh-shell-termux**（自包含 termuxEnv：PATH/LD/HOME/PREFIX/SHELL + 栅栏键，sandboxMode 诚实上报 enforcement:partial）；
- `ui-layout` → **dsh-client-ui-responsive**（store-rehome 适配上游 client 包重组）；
- **dsh-host-web-compat** 提供 withResolvers 等 polyfill（插件通道注入，不改 index.html——本仓库 stub 的 AbortSignal polyfill 走的是改 html 路线，上游有 API 即弃）；
- vendor 插件（marketplace/undo-savepoint）随快照固化 + 构建期补丁。

## 八、对照本仓库的差距与可借鉴点

本仓库现状：官方 npm 装 `@deepseek-ai/dsh@0.1.1-rc.1`（精确 pin + 装后精确校验——对应参考的 pins 思路，已等价）+ `stub-dsh.mjs`（7 项锚点补丁）+ 8 内置插件（官方 `dsh plugin add` 通道）+ stub marker 含 apk+dsh 双版本指纹。

| # | 差距 | 参考做法 | 借鉴建议 |
|---|---|---|---|
| 1 | **stub 补丁无登记表**：7 项修复散落 637 行脚本，无 id/来源/幂等标记台账，无与实现的交叉校验 | registry.json + IMPLS 一一对应 | 建 `stub-dsh.registry.json`（或注释台账）逐项登记 id/provenance/marker |
| 2 | **锚点失配仅 WARN 不断链**：`WARN vision patch v4: link anchors unusable` 后继续跑 → 半补丁状态静默出厂 | 构建期 `--check` 拒绝打包 + marker 复查 | 至少在安装后 log 汇总「应施加 N 项 / 实际 M 项」，M<N 时 FAIL 快速失败 |
| 3 | **无升级核对清单**：本仓库 dsh 升级 = 改 PINNED_DSH_TAG 重装，stub 补丁全靠运行时锚点碰撞暴露问题 | 坑 38 三步约定 + RUNTIME-PATCHES 台账 | 补一份 docs/dsh-upgrade-checklist.md：逐 stub 项核对上游是否原生修复/锚点是否仍命中/新版本行为面变化 |
| 4 | **补丁来源不可追溯**：stub 注释只写「是什么」，不写「哪次升级、什么 issue 发现」 | provenance 字段 | 新改动强制登记来源 |
| 5 | **polyfill 应走插件通道**：参考用 host-web-compat 插件注入 polyfill，本仓库 stub 直接改 index.html（虽有「仅当引用才注入」守卫） | 插件化 | 已有守卫可接受；dsh 升级时优先评估上游 API 面再决定是否继续保留 |
| 6 | **升级到 0.1.2-rc.1 时必做**（若决定跟进）：① EngineAuth 壳侧 cookie（P0/P1 两路）；② DshFlow/看门狗探测把 401/303 视为存活；③ 逐 stub 补丁对 rc.1 新包核对抗坑 38；④ pi-ai 目录 diff | 参考 §六 全套 | 参考 EngineAuth.kt/EngineProbe.kt 可近乎直接移植 |

## 九、一句话总结

参考项目的适配哲学：**上游零改动，一切走「登记表 + 门禁 + 幂等 marker + 能退役则退役」**——用构建期强断言把「补丁漂移/半成品/升级回退」三类事故在出厂前拦死，用插件化把可插件化的适配全部移出补丁面。本仓库的 npm 安装路线天然绕开了快照 overlay 复杂度，但 stub 补丁面缺登记表/门禁/退役流程三件套，是升级 dsh 版本前最值得先补的基建。
