# Code Review 记录 —— R2（全量复审 + 重构优化）

- 基准：v4.10.2-fix6（versionCode 300）
- 方法：主审人工通读全部 Kotlin 源码（约 11.7k 行 / 5 包）与关键 assets 脚本，
  并行 5 路专项复审交叉验证；脚本层 P0 在设备端用内置 Termux awk / Node 实测复现
- 结论先行：**修复 12 项**（P0 ×3、P1 ×4、P2 ×5），**重构 1 项**（执行器统一），
  误报排除若干（见文末）

> 说明：本轮在**无 Java/Gradle** 的设备环境下进行（无法本地编译），
> 所有 Kotlin 改动均为机械式、行为保持型修改；脚本层改动在设备端实测验证。
> 建议合入前跑一次 CI（assembleDebug + testDebugUnitTest 已在 CI 门禁内）。

---

## 一、P0 —— 正确性与数据安全

### P0-1 tpkg.sh 合并 dpkg status 时制造重复 `Package:` 字段 → 数据库不可解析

- **位置**：`assets/tpkg.sh:47-52`（旧版 `merge_status`）
- **证据**：awk 规则顺序错误——`!skip { print }` 排在 `$0 == p { skip = 1 }` 之前且后者没有 `next`，
  旧条目的 `Package: git` 行在 skip 置位**之前**就被打印，随后才跳过它的正文，
  于是旧条目的头粘到下一条目上，形成含两个 `Package:` 的 stanza
- **实测复现**（设备自带 awk）：

  ```
  # 旧 awk（去掉 git）：            # 新 awk：
  Package: bash                    Package: bash
  ...                              ...
  Package: git        ← 孤儿头      Package: ripgrep
  Package: ripgrep    ← 粘上       ...
  ```

  产出喂给设备 dpkg：`dpkg-query: error: duplicate value for 'Package' field`
- **为什么严重**：tpkg 是「apt 安装失败」的兜底路径。一旦 status 损坏，
  `apt`/`dpkg`/`tpkg` **全链路失效**，且 `PackageKit.ensure` 每次都退到 tpkg 继续加重损坏——
  自持化安装链路变成自毁链路。虽有 `$STATUS.dsh-bak` 备份，但无人恢复
- **修复**：① 规则重排（`$0 == p { skip = 1; next }` 置于 `!skip { print }` 之前）；
  ② 新增 `status_ok()` 校验器，**写盘前**自检合并产物，坏产物中止不落盘；
  ③ 追加前保证末尾空行分隔（dpkg 容忍多余空行，缺了新条目会粘进上一条目）；
  ④ `merge_status` 入口自愈：当前 status 已损坏时先尝试从备份恢复

### P0-2 routing-suite.mjs 引用未声明常量 → 特殊适配路径 100% 失败

- **位置**：`assets/routing-suite.mjs:85`（`DSH_PREFIX`）、`:111`（`NODE_BIN`）
- **证据**：头注释第 13 行宣称这两个是输入，但常量块（23-36 行）从未定义它们 → `ReferenceError`
- **为什么严重**：`dshPlugin(['add', injector])` 在第 227 行就崩，
  后面的 agent-preset 拷贝（232-265 行）永不执行。表现是「三份 tar 下载完成 → 报失败 →
  什么都没装上」，且**每次尝试都必然如此**。该路径由插件管理页「从 GitHub 仓库安装
  yjh051108/dsh-routing-suite」触发（`PluginManagerActivity.runRoutingSuite`）
- **修复**：补充声明（`process.env.DSH_PREFIX || join(HOME,'dsh-prefix')` 等）；
  同时修掉同函数的第二个坑：原 `run('/system/bin/sh', ['-c', 'cd <path> && bash scripts/build.sh'])`
  ——Android 的 `/system/bin/sh` 找不到 `bash`（恒定 exit 127），且路径拼进 `-c` 参数是转义事故源。
  改为以内建 Termux bash 直接解释 `scripts/build.sh`、`cwd` 承载工作目录，不再拼字符串

### P0-3 stub-dsh.mjs 归因开关补丁可能写入「半补丁」文件

- **位置**：`assets/stub-dsh.mjs`（旧版 llm-pi-ai 补丁块）
- **证据**：5 处链式 `replace`，只要 `out !== src` 就写盘。第 3 处（函数签名）与第 4 处
  （gating 逻辑）是链式依赖——第 4 处的正则锚定第 3 处的产物
- **为什么严重**：上游把 `const attribution = attributionHeaders();` 改名后，
  第 3 处命中而第 4 处失配 → 落盘文件里 schema 接受 `sendAttribution: false`，
  却没有实际生效代码。**UI 上的开关静默失效**（用户以为归因已关，实际仍发送），
  而标注为 `sendAttribution: z.boolean().default(true)` 的幂等标记又在文件里，
  后续运行一律判定「已打补丁」
- **修复**：改为全有或全无——四处改动逐步计数，缺任一处不写盘并打印缺失项；
  且写盘前与 attachment-local 补丁一样过 `node --check`（新增共享 `syntaxOk()`）。
  实测四种上游形态：全命中→打补丁；上游漂移→拒绝写盘（旧实现会写坏）；
  无命中→跳过；已打补丁→幂等跳过

---

## 二、P1 —— 稳定性与结构

### P1-1 主线程 IO/网络

| 位置 | 问题 | 修复 |
|---|---|---|
| `MainActivity.refreshRollbackCard`（原 608 行） | `DshFlow.isWebUp()` 在**主线程**发 HTTP 探测（800ms 超时），临时更新窗口内每 3s 一次 | 改用后台轮询缓存 `lastWebUpCache`（最多滞后一个周期） |
| `MainActivity.openTerminal` | 解压/工具准备回调在**后台线程**直接 `appendMiniLog` → 触碰 `TextView`（`CalledFromWrongThreadException` 隐患）。`ConsoleActivity` 同路径已正确包裹，此处漏了 | 回调切回主线程并加 `isFinishing/isDestroyed` 守卫 |
| `OverlaySettingsActivity.importFromTree` | 桌宠导入的目录列举 + 文件拷贝全在主线程（SAF 回调） | （建议）后台线程执行后 `runOnUiThread` 重建 |

### P1-2 桌宠图集重试风暴 + 自愈语义失效

- **位置**：`overlay/BridgeOverlayManager.kt` `showPet`
- **证据（两处叠加）**：
  1. 图集加载失败时（`atlas == null`）每轮轮询（1s）都重跑 `scanPets()` 目录扫描 +
     `openAtlas()` 位图解码——**主线程**上，耗电且周期性卡顿；
  2. 用户包解不动时回退内置默认，但 `petLoadedId` 被赋成**用户的** id
     （注释写的是「保持默认，后续轮询可自愈」）——于是 `petLoadedId == wantedId`，
     用户修好/换回自己的桌宠后**永远不会被重试**，注释承诺的自愈从未生效
- **修复**：① 以 `pet@高度` 为键的 30s 退避（换桌宠/换大小即失效，立即重试）；
  ② 回退默认时 `petLoadedId` 记默认 id、台词/名字跟随**实际展示**的桌宠
  （用户能立刻看出回退发生了，旧实现保留失败包名字，看着像自己的桌宠还在实际不是）

### P1-3 进程执行器未完全统一

- **位置**：`ui/PluginManagerActivity.kt`（`runProcess` + `bundledSourceAvailable`）
- **证据**：P1-1 已统一 `DshFlow.exec` 与 `TermuxRuntime.runBash` 到 `Proc`，
  但本页仍保留裸 `ProcessBuilder`：无超时（一次卡死的 tar/npm 把 `busy` 永久占死，
  页面所有操作再也点不动）、流未关、进程未 destroy
- **修复**：统一委托 `Proc.run`（10 分钟 / 30 秒超时）。配套两点：
  - `Proc` 新增 `killNodeOrphansOnTimeout`：超时强杀后是否连带 `killAllNode`。
    安装链（npm/pnpm）保持 true（孙进程会孤儿化并发写 node_modules）；
    **与 dsh web 共存的命令必须 false**——否则一次 tar 卡死会误杀正在运行的 web
  - `appendLog` 加 `synchronized`：`Proc` 的输出泵线程与操作线程并发调用

### P1-4 轮询循环防御性不一致

- **位置**：`service/StatusBridgeService.kt` `pollLoop`
- **证据**：`PowerGovernor` 调用与 `syncWakeLock` 在 `try` **之外**；
  而 `KeepAliveAccessibilityService.startPolling` 整轮全包裹——后者的注释明确写了
  「线程一死会让位判定失效、双窗叠加」这一真实故障模式，普通通道缺同样保护
- **修复**：整轮包裹 + 异常记日志后续跑（对齐 a11y 通道）；
  并补 `heartbeatIo.shutdown()`（服务被反复拉起时每个实例都遗留一个空闲线程）——
  注意顺序：先落 destroyed 心跳再 shutdown，否则最后一次心跳抛 `RejectedExecutionException`

---

## 三、P2 —— 一致性与清理

| # | 位置 | 问题 | 处置 |
|---|---|---|---|
| 1 | `AssetSync.markSynced` | 死代码（零调用者），且写入的是不含指纹的旧格式——`isSynced` 永远匹配不上，是给未来调用者埋的坑 | 删除（保留 `markSyncedWithFingerprint`） |
| 2 | `StatusBridgeAlerts.PREFS_NAME` | 死常量（实际用 `AppState.Prefs.BRIDGE`） | 删除 |
| 3 | `MainActivity.setBusy` | 死代码（`beginFlow` 直接管理 `flowing` + 视图） | 删除 |
| 4 | `ConsoleActivity` | 硬编码 `http://127.0.0.1:3080`（P0-3 常量收敛的漏网）+ 6 个无用 import（`BuildKeepAliveService` 拆出后的遗留） | 改用 `DshFlow.WEB_PORT`；删 import |
| 5 | `MainActivity` `confirmLine` | `${" ".repeat(0)}` 无意义残留 | 删除 |
| 6 | `WebViewActivity` | 缺 WebView 生命周期收尾（无 `destroy()`）；WebUI 全部经 127.0.0.1 提供却开着 `allowFileAccess` | 补 `onPause/onResume/onDestroy`（摘除后 destroy）；关文件/内容访问 |
| 7 | `README.md` | 内置插件数量写 9 个、仍列 `dsh-oh-we-need`（commit 201a308 已刻意移除） | 改 8 个、删该行 |

---

## 四、误报排除（审计过、确认健康）

- `NodeRuntime` 里的 `LD_LIBRARY_PATH`：是 `TermuxEnv` 头注释**明确记录**的例外
  （「node 本地前缀环境，语义不同」），非 P0-1 违规
- `Supervisor` 的裸 `ProcessBuilder`（第 64 行）：自包含的拉起脚本执行，脚本内已
  `@EXPORTS@` 自带环境，无输出泵需求——无需走 `Proc`
- `BackupManager` 的 `commit()`（第 541 行）：恢复路径要求立即落盘，是刻意为之
- `TerminalActivity` 与 `Ui.kt`：生命周期与主题色处理正确，无发现
- `EdgeTts`：generation 守卫、引用计数持有者、单飞流水线、播放器主线程约束均正确
- `PetSpeaker` / `CodexPetStore` / `BridgePrefs` / `OverlayStyle`：P1-6 前两刀产物，质量良好

---

## 五、遗留建议（本轮未动，风险/收益需权衡）

1. **P1-6 第三刀（BridgeOverlayManager 拆分）**：1247 行的剩余簇（气泡 ~230 行、
   交互/闲时 ~120 行、拖拽物理 ~350 行）强耦合于共享窗口状态
   （`overlayParams`/`overlayView`/`windowManager`/`handler`）。安全的机械切分只有
   「垃圾桶簇」（~80 行，自包含）。物理簇需在**真机回归窗口**下做——无编译验证环境
   不建议动（沿用上一轮结论）
2. **P2-3 兼容脚本合并**：`fs-register/loader/promises-compat` 三件套职责清晰、
   各自独立演进，合并收益有限；建议维持现状
3. **P2-1 协程化**：39 处 `thread{}` 迁移收益主要在可读性，风险面大于收益，维持延后
4. **测试地基**：本轮无法本地运行 JVM 单测（设备无 Java），未新增用例——
   新增的 `Proc.killNodeOrphansOnTimeout` 与 tpkg 合并逻辑建议后续补单测
