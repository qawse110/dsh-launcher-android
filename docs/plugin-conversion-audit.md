# 脚本式 DSH 修改审计与插件化改造记录（v4.10）

- 目标：**尽量减少用脚本直接修改 dsh 本体**；凡可由插件实现的功能改为独立内置插件，
  走官方 `dsh plugin --profile web add` / bundle patch 通道，避免 dsh 升级被补丁破坏。
- 方法：对 `stub-dsh.mjs` 的每一处补丁，下载 **pristine `0.1.1-rc.2` npm 原包**
  逐一 grep 锚点/常量，并核对运行时缝隙（settings 服务、client-modules、
  directory-picker browse 源码、HTML 引导时序），给出「保留 / 移除 / 插件化」三向结论。
- 结论速览：12 处补丁 → **1 处插件化**（新增 `dsh-android-links`）、
  **2 处死码移除**（apiproxy 白名单、sandbox "/tmp"）、
  **1 处改按需注入**（AbortSignal shim）、8 处保留并注明不可替代原因。

---

## 一、stub-dsh.mjs 补丁逐项判定

| # | 补丁对象 | 机制 | 判定 | 证据（对 pristine 0.1.1-rc.2） |
|---|---|---|---|---|
| 1 | koffi（ESM+CJS Proxy stub） | import 期模块顶替 | **保留** | Android 无预编译产物；Cordis 插件运行于加载完成之后，无法介入 import 解析 |
| 2 | node-pty stub | 同上 | **保留** | 同上；dsh PTY 会话在 Android 由启动器 Termux 终端承担 |
| 3 | sharp 纯 JS shim（PNG 全解码） | import 期模块顶替 | **保留** | libvips 二进制缺失；消费方 `dsh-attachment-local` 的 require 链路无插件缝隙 |
| 4 | attachment-local 视觉链路 v4（syncDirectory fsync 容错 + publishCopied link→copy 回退） | 改写包内源码 | **保留** | SELinux 禁 app uid link(2)、sdcard FUSE 不支持硬链接、FUSE 目录 fsync 失败——fs 兼容层（loader 级）不覆盖 CJS `require('fs/promises')` 与 `linkSync` 盲区，只能改源；锚点在 rc.2 原包均存在 |
| 5 | apiproxy `WEB_SETTINGS_NAMESPACES += "vision"` | 正则插桩 | **移除（死码）** | rc.2 原包已无该常量（grep=0），补丁恒命中 "pattern not found, skip"；`dsh-vision` 现经 `@deepseek-ai/dsh-settings` 的 `settingsNamespace('vision')` 直接注册命名空间 |
| 6 | llm-pi-ai sendAttribution（schema default + requestHeaders 分流） | 正则插桩 | **保留** | rc.2 原包无此字段且源码注释明示 *“omission cannot suppress attribution”*——归因 UA 大小写不敏感地覆盖用户 headers，唯一抑制通道就是该补丁；`dsh-provider-headers` 设置页的「发送归因请求头」开关依赖它。待上游提供官方抑制缝隙后删除 |
| 7 | sandbox-windows-acl STARTUPINFOW/PROCESS_INFORMATION 断言禁用 | 正则替换 | **保留（防御性）** | 断言存在于 rc.2 原包 `lib/types-*.js`；koffi 已被顶替，一旦上游自动选中 windows-acl 策略即崩，禁用成本≈0 |
| 8 | index.html AbortSignal.timeout polyfill | dist/index.html 注入 | **改为按需注入** | 全量扫描 rc.2 前端 dist 与全部 @deepseek-ai 包：**无任何浏览器侧消费者**（仅 host 侧 vision/super-injector 使用，Node 原生支持）；现仅在 assets 中检测到真实引用才注入（**递归扫描含子目录 chunk**，布局变化不丢消费者；误报无害——shim 自带 `if(!AbortSignal.timeout)` 守卫），资产目录不可读时保守回退注入。必须留在引导期脚本：polyfill 需先于 `/assets/index-*.js` 与 client-modules 条目执行，client 插件由模块系统在 app bundle 内引导，时序上不可能更早 |
| 9 | @vscode/ripgrep 解析器 Android 回退 | 重写解析器 | **保留** | 无 android-arm64 平台包；import 期 `require.resolve` 抛错导致 glob/grep 工具瘫痪；优先 Termux 原生 rg 属产品语义。（备选方案：alias 出 `@vscode/ripgrep-android-arm64` 侧门面包——会丢失 Termux rg 优先级，未采纳） |
| 10 | dsh-sandbox/-local `"/tmp"`→TMPDIR | 字符串全量替换 | **移除（已被上游覆盖）** | rc.2 `writableRoots()` 已原生并入 `os.tmpdir()`（Node 读 TMPDIR，启动器恒导出应用私有 tmp）；sandbox-local 的 `--tmpfs/readWrite` 分支依赖 bubblewrap，Android 上不可达。旧补丁在 rc.2 上零替换仍追加 marker 头，属纯文件污染 |
| 11 | dsh-fs-local chmod EACCES/EPERM 容错 | 三处调用点包裹 | **保留** | FUSE（/storage/emulated）不支持 chmod，原子写 staging 会 EACCES；三处锚点 rc.2 均存在；内部实现路径无插件缝隙 |
| 12 | directory-picker-browse "SD Card" 条目 | 源码插桩 | **插件化 → 移除** | browse `list()` **原生保留符号链接项**（`dirent.isDirectory() || dirent.isSymbolicLink()`）、`directoryRow()` 对链接 stat 跟随判定可进入，home 即 `os.homedir()`——只需在 HOME 放符号链接，零改动上游 |

## 二、新增独立内置插件：`@dsh-external/dsh-android-links`

- 位置：`app/src/main/assets/extra-plugins/dsh-android-links/`（package.json +
  cordis.patch.yml + lib/index.js + README.md，随 AssetSync 整目录同步，
  install-dsh.mjs 经 `dsh plugin --profile web add` 装配）。
- 行为：启动时在 dsh HOME 创建 `sdcard -> /storage/emulated/0` 符号链接
  （可用 `DSH_ANDROID_LINKS="name=target,..."` 自定义多条）。工作区目录浏览器的
  「添加工作区」即可直达共享存储。
- 安全约定：幂等；目标缺失/非目录跳过；同名位置被非链接占用**绝不覆盖**；
  卸载不回收链接（用户可见的文件系统便利设施，避免活动会话断链）。
- 真机验证：
  - 单测 5 例（创建/幂等/占用保护/目标缺失/spec 解析）全过；
  - dev_inject 注入 → `[active] (@dsh-external/dsh-android-links)`，
    `files/sdcard` 符号链接生成且可列目录；卸载后 loader entry / registry /
    junction 全部清理。

## 三、装配通道变更（install-dsh.mjs）

- `BUILTIN_PLUGINS` / `BUILTIN_NAMES` / `BUILTIN_IDS` 追加
  `dsh-android-links` / `@dsh-external/dsh-android-links`。
- `cleanBuiltinPatch()` 因此会在下次安装流中自动清掉历史遗留的
  `- id: dsh-android-links disabled: true` 之类 patch 行，不会与 bundle 装配冲突。

## 四、其他脚本层复核（无需改动）

| 脚本 | 判定 | 说明 |
|---|---|---|
| fs-register/loader/promises-compat | 保留 | Node `--import` 会话级兼容层（SELinux 禁硬链接），先于模块图构建，非插件通道可达；不改 dsh 文件 |
| routing-suite.mjs | 保留 | 第三方聚合仓库的一次性适配安装器，走官方 plugin add / agent-presets 拷贝 |
| tpkg.sh / web-launcher.sh.tpl / profile.d 生成物 | 保留 | Termux 环境 / 进程启动层，不触碰 dsh 本体 |
| install-dsh.mjs ensureRipgrepFallback | 保留 | 以 package.json dependency 声明方式装 linux-arm64 兜底（npm 官方语义，非源码改写） |

## 五、升级守护清单（后续 dsh 版本需复查的点）

1. attachment-local v5 与 fs-local chmod 的锚点是否漂移（补丁自带 node --check 防毒化）；
2. llm-pi-ai 是否提供官方归因抑制缝隙（有则删补丁 #6）；
3. 前端 dist 是否重新引入 `AbortSignal.timeout` 消费者（按需注入自动兜底，无需动作）;
4. `writableRoots()` 是否退回丢失 `os.tmpdir()`（若有变化恢复补丁 #10 并去掉 marker 头写入）；
5. browse 是否改变符号链接语义（若不再 stat 跟随，`dsh-android-links` 需同步调整）；
6. **koffi ABI 断言所在包是否再次搬家**（见 §七：0.1.5 已从 sandbox-windows-acl 搬到
   win32-process，补丁现按包名清单遍历两包；若上游再新增宿主包，需加入 `ABI_PKGS`）。

## 六、验证记录（2026-08-25，真机 v4.9 环境 @ dsh 0.1.1-rc.2）

- `node --check`：stub-dsh.mjs / install-dsh.mjs / 插件 lib 全过；
- pristine tarball grep：见上表证据列；
- HTML 引导时序：`<head>` 内为 module-loader shim → client-modules/client-runtime 预载
  → `__DSH_BOOT__` → （shim 位点）→ `<script type="module" src="/assets/index-*.js">`，
  证实 client 插件无法先于 app bundle 执行；
- 设备 WebView 为 Chromium 94，当前 rc.2 页面在**无 shim** 时亦正常（无消费者），
  与「按需注入」结论一致。

## 七、dsh 0.1.5-rc.2 适配记录（2026-09-11，next 分支）

钉死版本 `0.1.1-rc.1` → `0.1.5-rc.2`（跨 4 个小版本）。在真机隔离 scratch 环境
（`$HOME/tmp/dsh-adapt/`，**不在仓库内**）用真实启动命令复现，定位到**两处
「不报错但失效」的补丁锚点漂移**——两者都不会被编译/单测门禁捕获：

### 7.1 koffi ABI 断言搬家（★boot 硬阻断）

| 项 | 0.1.1-rc.1 | 0.1.5-rc.2 |
|---|---|---|
| 断言所在包 | `dsh-sandbox-windows-acl` | **`dsh-win32-process`（新包）** |
| 旧包现状 | 含断言 | 断言已移除（同名实现保留） |
| 旧补丁表现 | 正常禁用 | `asserts disabled: 0` —— **看起来无害** |

失败模式：koffi 被 stub 后 `struct().size` 恒为 0，断言在 **import 期**抛错 →
Cordis 报 `loader entries failed to apply` → **整棵插件树失败，web 完全起不来**
（实测日志：`failed to import loader entry subprocess ... STARTUPINFOW layout mismatch`）。
**不是降级，是硬失败。**

修复：`ABI_PKGS` 包名清单遍历新旧两包，且「扫到包却 0 命中」时显式 WARN。

### 7.2 attachment-local 发布链路重构（★图片/附件必挂）

上游把单一 `await link(temporary, target)` 拆成两个调用点：

| 版本 | link 调用点 |
|---|---|
| 0.1.1-rc.2 | `publishStagedObject` 内 1 处：`link(temporary, target)` |
| 0.1.5-rc.2 | `publishImmutableAlias`：`link(source, target)`；`publishStagedObject`：`link(staged.path, target)` |

旧 v4 补丁锚定 `'await link(temporary, target);'` 字面量 → 上游重构后**该串不存在**，
补丁只打一行 `WARN link anchors unusable (call=false,def=true)` 后放弃。

必要性证据（真机实测，非推断）：

```
app-private(ext4) link FAIL EACCES
sdcard(FUSE)      link FAIL EACCES
```

**应用私有存储上 `link(2)` 同样 EACCES**（SELinux `untrusted_app_27` 域），
故这不是「sdcard 才需要」的防御性补丁，而是所有附件/图片发布的必经路径。

修复（v5）：改为**扫描式**改写——正则枚举全部 `await link(from, target)` 调用点，
按作用域推导 sha256 实参（`source`→`sha256`、`staged.path`→`staged.sha256`）。
**幂等判据同时修正**：不再只看 marker 字符串，而是
「marker 存在 **且** 已无裸 link 调用点」——旧判据在换版后会把「marker 在、
调用点未改写」这一失效状态误判为已完成而**永久短路**。

### 7.3 验证记录（真机，隔离环境）

| 项 | 结果 |
|---|---|
| 新版结构改写 | 2 处调用点全部改写，sha256 实参各自正确 |
| 旧版结构（向后兼容） | 1 处调用点正确改写 |
| 幂等 | 连续 3 次运行文件 sha256 恒定 |
| copy 回退端到端 | `link` EACCES → copy → digest 校验通过，内容一致 |
| **web 完整启动** | 真实启动命令 boot web profile → `dsh web: http://127.0.0.1:<port>/?token=…` |
| **UI 可服务** | 带 token 请求 → HTTP 200，29KB HTML 外壳 + 前端 bundle（555KB/740KB 均 200） |
| CI 门禁 | 编译 + 12 个测试类全绿（run 34613507254） |

### 7.4 开发期自身踩的坑（记录以免重犯）

v5 首版把 **helper 体内的 `await link(from, target)` 也当成待改写调用点**，
第二次运行即把 helper 改成自递归（`rewritten=1` 且文件 sha 变化暴露）。
修复：用花括号配平定位 `publishCopied` 函数体区间，扫描时排除该区间。
**教训：凡「扫描+改写」型补丁，必须显式排除自己插入的代码。**

### 7.5 浏览器信任栅栏（★壳侧必须适配，非补丁问题）

**真机现象**：装 0.1.5-rc.2 后启动报 `✗ dsh web 未在 90 秒内就绪`，
日志尾部停在 `[net-proxy] 同源设置路由`（看似"起不来"）。

**根因**：0.1.5 新增 **authority 绑定的浏览器会话鉴权**
（`@deepseek-ai/dsh-client-connection` 的 `BrowserAuth`），且**无条件启用**——
配置项只有 `cookieMaxAgeDays` / `trustedHosts`，**没有任何开关可关闭栅栏**：

| 请求 | 0.1.1 | 0.1.5 |
|---|---|---|
| `GET /` 无凭据（**含 loopback**） | 200 | **401** |
| `GET /api` 无凭据 | 放行 | **401** |
| `GET /assets/*` | 200 | 200（静态资产不拦） |
| `GET /?token=<启动令牌>` | — | **303** + 下发 `dsh-auth-<authority>` cookie |
| `GET /` 带该 cookie | — | 200 |

启动令牌**每进程随机**（`randomBytes(32)`），只打印在 web 日志里；
换取的 cookie 用**持久密钥**签名、30 天有效、audience 绑定 `host:port`
→ cookie 一旦拿到，进程重启后仍可复用（端口不变时）。

**为什么「90 秒未就绪」是误报**：实测 3093 端口 **30 秒内即返回 401**，
即服务**早已就绪、只是缺凭据**；而就绪探针只接受 `200..399` → 永远判未就绪。

**三处壳侧修复**：

1. `DshFlow.httpResponds` / `DshWatchdog.isUp`：401/403 也算「端口活着」。
   401/403 只可能由**已监听的 HTTP 服务**返回，语义上等价于就绪。
   ★ watchdog 那处尤其关键——否则每轮误判 web 挂了 → 反复 revive，
   连续失败还会被 `Supervisor` 误判为崩溃循环而**自动回滚重装上一版本**。
2. 新增 `WebAuth`：解析日志里的启动令牌 URL → 换 cookie → 持久化。
   只读日志尾部 64KB（web.log 持续追加不轮转，全量读会卡顿）；
   取**最后一次**出现的令牌（进程重启后旧令牌立即失效）。
3. `WebViewActivity.loadWebUi()`：先确保会话，再**注入 WebView 自己的 cookie jar**
   （WebView 与 `HttpURLConnection` **不共享 cookie**，只存 pref 不注入是无效的），
   然后开根路径；全失败退回带令牌 URL，且不阻断启动。

**兼容性**：0.1.1（无栅栏）下 `isFenced` 恒 false，逻辑退化为「直接开根路径」，
与升级前行为完全一致。

**验证**：对真实服务复刻完整决策链 —— 无 cookie→401 → 令牌交换→303+cookie →
带 cookie→200 → 判定可直接开根路径 ✅；单测 `WebAuthTest` 6 例。

### 7.6 内置插件 API 漂移：`dsh-settings` 导出面收窄（★插件加载失败）

**真机现象**：`✗ dsh web 未在 90 秒内就绪`，日志尾部是**插件加载失败**
（不是壳侧问题）：

```
plugins/dsh-llm-codebuddy/lib/index.js:5
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
SyntaxError: The requested module '@deepseek-ai/dsh-settings'
             does not provide an export named 'installSettingsSection'
```

Cordis 判定整棵插件树 apply 失败 → web 完全起不来。

**根因**：0.1.5 收窄了 `@deepseek-ai/dsh-settings` 的导出面（实测两版对照）：

| 版本 | 导出符号 |
|---|---|
| 0.1.1 | 7 个，含 `installSettingsSection` / `settingsNamespace` / `deepEqualJson` |
| 0.1.5 | **4 个**：`SettingsConflictError` / `SettingsProvider` / `default` / `redactSecrets` |

能力下沉为服务方法（逐行比对上游实现，**语义等价**）：

| 旧 (0.1.1) | 新 (0.1.5) |
|---|---|
| 模块级 `installSettingsSection(ctx, ns, schema, entry, hooks)`<br>内部即 `ctx.inject(["settings"], sctx => sctx.settings.register(...))` | `ctx.settings.installSection(ctx, ns, schema, entry, hooks)`<br>（官方插件 `dsh-agent-default-model` 即用此形式） |

**★ 关键手法**：**具名导入在 ESM 链接期就抛错**，`try/catch` 兜不住，运行时
探测也没机会执行——必须改成**命名空间导入**（`import * as dshSettings`），
把符号存在性判定推迟到运行时。这是本类问题的通用解法。

**改动**（`src/` 与 `lib/` 同步，`lib/` 由 `build.mjs` 生成）：

1. 具名导入 → `import * as dshSettings`（缺符号不再炸链接期）；
2. `settingsNamespace("llm-codebuddy")` → 常量字面量（该函数同样不再导出；
   其校验规则 `/^[a-z][a-z0-9-]*$/` 极简，且新版 `register()` 内部会自行校验并抛错）；
3. 新增 `installCodeBuddySettings` 兼容层：优先走 0.1.5 服务方法，仅旧版回退
   模块级函数；**两代皆缺时显式抛错**，而非静默不注册。

**同类漂移审计**（避免只修崩溃点、漏掉别处）：内置插件中只有 codebuddy 导入
dsh API，逐个核对了 5 个包的符号——仅 `dsh-settings` 缺失，`dsh-credentials` /
`dsh-launch-environment` / `dsh-llm` / `dsh-llm-pi-ai` 全部完好。

**验证**：
- 兼容层三场景隔离测试：0.1.1 走模块级 ✓ / 0.1.5 走 `inject`+`installSection` ✓ /
  两代皆缺时显式抛错 ✓；
- 真机 scratch 装配：`dsh plugin add` 后 `--dump-config` 确认插件在树中；
  启动 web **20 秒内就绪**、零插件加载错误（修复前必崩）。

**沉淀（下次 dsh 升级必查）**：插件对 `@deepseek-ai/*` 的**每一个具名导入**
都要核对该包在新版的导出面——**导入符号消失 = 插件加载即失败 = web 起不来**，
且报错点在插件文件而非壳侧，容易被误判成"web 启动问题"。

### 7.7 装了新 APK 却仍跑旧插件：同步判据用「从不递增的量」（★五处连锁）

**真机现象**：装好含 §7.6 插件修复的**新 APK**，启动仍报**完全相同**的
`does not provide an export named 'installSettingsSection'`。
→ APK 里的插件已是修好的，设备 `files/` 下跑的仍是旧文件：**资产同步没生效**。

**根因**：本仓 `versionCode` 是**硬编码常量 300**（每次出包都相同），而以下判据
都拿它当「APK 换过了」的信号 → 首次安装后**永不成立 = 死代码**：

| # | 位置 | 旧判据 | 后果 |
|---|---|---|---|
| 1 | `AssetSync.isSynced` | marker=`apk:<versionCode>#<目标指纹>`，且指纹是**目标目录自身**的 | 自己和自己比永远相等 → 新 APK 的资产永远到不了 `files/` |
| 2 | `MainActivity.syncAssetsOnApkUpdate` | `last_apk_version == current` → `return` | 升级后同步函数**从不执行** |
| 3 | `DshFlow.runAndroidStubOnce` | marker=`apk:<ver>\|dsh:<ver>` | 「补丁脚本改了但版本号没动」被判成已应用 → **补丁永久跳过**（v5 前缀补丁正是这样打不上的） |
| 4 | `PluginManagerActivity.rewireBuiltins` | 未调 `syncExtraPluginsSource()` | 用户最常点的「重新装配」只重装**设备上的旧源**，白点 |
| 5 | 升级路径整体 | 只同步「源」`files/extra-plugins`，未刷「装配副本」`files/plugins/<id>` | profile 登记的是 `link:` 到副本目录，运行时加载副本 → 仍是旧代码 |

第 1、3 条是同一病根的两面：**用不会变的量当变更判据**（既有坑 19 的同型）。

**修复**：

1. 新增 `AssetSync.apkInstallStamp()` = `<sourceDir>|<长度>|<mtime>`：重装必变；
   取不到时返回空串 → 判据 **fail-open 到「做事」**，不 fail-closed 到「跳过」。
2. `isSynced`/`markSynced*` 改以安装戳为主判据，保留目标指纹作次判据
   （前者认「APK 换过」，后者认「目标被改坏/只拷一半」）。
3. `MainActivity` 升级门改用安装戳，并**换键名** `last_apk_stamp`
   （旧键是 Long 型 versionCode；同键换语义会让升级用户带着旧值误判）。
4. `runAndroidStubOnce` marker 加入 `stub-dsh.mjs` 的内容指纹。
5. 新增 `AssetSync.refreshBundledPluginCopies()`，升级后把源刷新到**装配副本**
   （语义同 install-dsh.mjs 的 `syncExtraPlugin`，但不碰 profile 登记）；
   `rewireBuiltins` 补上源同步。

**★ 同时修正「标记写入时机」**：原 `syncAssetsOnApkUpdate` 在**做事之前**就写
`last_apk_version`，一次失败即永久标记为已同步。改为**全部拷贝成功后**才写
（与本项目既有约定一致：标记必须在工作成功之后写）。

**自愈性**：新戳形态含路径与 `|`，旧 marker `apk:300#...` 的前缀判据必然不匹配
→ 存量设备升级后**强制重新同步一次**，无需手动清数据。

**验证**：CI 全绿（含 8 个 `AssetSync` 用例，覆盖「旧格式 marker 必须判未同步」
「安装戳变则判未同步」「刷新副本不误建未装配插件」「幂等」）；APK 内确认
`apkInstallStamp` / `last_apk_stamp` / `fileFingerprint` / `refreshBundledPluginCopies`
四者均在 dex 中（旧包全为 0）。

**沉淀**：出包流程里任何「是否已同步/已应用」的判据，都要先问一句
**「这个量会随每次出包变化吗？」**。versionCode、手写 marker、固定字符串都不会，
用它们等于把判断写成常量 → 静默失效，且编译与单测**全绿**。正确做法是内容指纹
或安装戳（APK 路径+长度+mtime），且**标记必须在工作成功之后写**。

### 7.8 修复的最后一环：时序竞争 + 让故障可见

§7.7 修好了「判据失效导致不刷新」，但还有两件事不做就仍会失败：

**A. 时序竞争（会让 7.7 白修）**

`MainActivity.onCreate` 里两个后台线程并发：

```
syncAssetsOnApkUpdate()  → thread{A}：拷 30MB prebuilt + 刷新插件副本（数秒）
autoRoute()              → thread{B}：判 isInstalled → START_ONLY 快速启动
```

B 通常远快于 A（A 要拷 30MB），而**快速启动跳过插件装配**，直接加载
`files/plugins/<id>` 下的副本 → B 先跑完时，dsh 用的仍是**尚未刷新**的旧插件，
同样的错误再次出现。这不是理论风险：两者本就是并发发起的。

修复：加 `assetsSyncGate`（`CountDownLatch(1)`）作显式闸门——

- `syncAssetsOnApkUpdate` 的 3 条早返回分支与同步线程的 `finally` **都必 countDown**
  （失败也放行，最坏退化为「带旧资产启动」，绝不把「启动卡死」变成新失败模式）；
- `autoRoute` 的线程先 `await` 闸门，限时 30s 兜底。

语义：**先让资产落地，再决定启动什么**。

**B. 故障是静默的 → 让它可见**

`bundleHealthy` 只校验 `package.json` 能解析且 `name` 非空，因此「旧版本但结构完好」
的插件被判成**健康**，插件管理页面显示「已装配」，用户毫无提示，只在启动时以
「dsh web 未就绪」炸出来、真正错误埋在日志尾部（本事故三次复发均因此极难定位）。

修复：`AssetSync.dirContentEquals()` 比对 `files/plugins/<id>` 与
`files/extra-plugins/<id>`；`BundledHealth` 增加 `staleVsSource`，
渲染分支单列 **「已装配 · 副本落后于内置源」** 并提供「修复」动作。
源不存在时（插件来自 prebuilt.tgz 等）不告警，避免无根据的误报。

**沉淀**：
1. 任何「刷新资产 → 立刻启动」的流程，都必须用**显式闸门**而非时序运气；
   闸门必须在失败路径也放行（fail-open 到"带旧数据继续"，而非"卡死"）。
2. 健康检查若只校验「结构完整」，就识别不出「内容过期」——**结构完好 + 内容陈旧**
   是最隐蔽的故障形态，必须比对内容而非结构。

### 7.9 审计盲区补全：内置插件有**两个**来源（dsh-vision 漏网）

§7.6 我写了「同类漂移审计」，但**只审了 `assets/extra-plugins/`（3 个插件）**，
漏掉了另一条供给链 —— 真机于是「修好一个、炸下一个」：

| 来源 | 插件 | 审计 |
|---|---|---|
| `assets/extra-plugins/` | dsh-status-bridge / dsh-android-links / dsh-llm-codebuddy | ✅ 7.6 已审 |
| **`prebuilt.tgz` 内 `third_party/`** | dsh-mobile-nav / dsh-net-proxy / dsh-provider-headers / dsh-super-injector / **dsh-vision** / router-preset | ❌ **漏审** |

真机新现象（codebuddy 修好后）：报错换成
`plugins/dsh-vision/lib/index.js:20 import { settingsNamespace } from '@deepseek-ai/dsh-settings'`。

**补全审计**（提取 prebuilt.tgz 全部 14186 个文件）后，对 6 个包逐个核对符号：

```
OK       @deepseek-ai/dsh-credentials        all present
OK       @deepseek-ai/dsh-launch-environment all present
OK       @deepseek-ai/dsh-llm                all present（含 BlockAssembler 等）
OK       @deepseek-ai/dsh-llm-pi-ai          all present
OK       @deepseek-ai/dsh-tools              all present
MISSING  @deepseek-ai/dsh-settings           settingsNamespace, installSettingsSection
```

**为什么修在启动期而非改源**：

1. 具名导入在 ESM **链接期**抛错 → `try/catch` 兜不住、运行时探测无机会执行；
2. `dsh-vision` 来自 `prebuilt.tgz`（30MB **LFS 二进制**），改 assets 源不可行；
3. `stub-dsh.mjs` 已有同类先例（koffi / node-pty / sharp 都是就地顶替）。

**改动**（`stub-dsh.mjs`）：

- 新增 `PLUGINS_DIR`（`DSH_PLUGINS_DIR` 可覆盖，默认 `HOME/plugins`）——
  历史实现只扫 `dsh-prefix/node_modules`，**内置插件目录完全不在覆盖范围**，
  这正是「同类错误换个插件继续炸」的结构性原因；
- `eachPluginEntry()` 枚举 `files/plugins/<dir>` 入口；
- 通用垫片：把「从 dsh-settings 具名导入**已删除**符号」的语句换成等价内联实现
  （`settingsNamespace` 纯校验；`installSettingsSection` 转调 0.1.5 的
  `ctx.settings.installSection`），**只动确实引用了缺失符号的文件**；
- 写盘前 `node --check` 自检，失败即放弃（避免把插件改成"加载即崩"，比原缺陷更糟）；
- marker `dsh-launcher-plugin-compat-v1` 幂等，重复运行不改文件。

**验证（真机 scratch，仓库外）**：

- 真实 `dsh-vision` 源：改写正确、调用点完好、**干净插件未被误改**、二次运行幂等；
- **对照实验**（决定性）：未修补版启动 → `exit=1` 且报错与真机日志**逐字一致**
  （`dsh-vision` + `settingsNamespace`）；修补版 → **30s 就绪、零错误**；
- 两条垫片路径同验：`dsh-vision`（单符号）+ 修复前的旧 `codebuddy`
  （`installSettingsSection` + `settingsNamespace` 双符号），同时装载启动成功。

**沉淀（本次最重要的教训）**：
**审计必须覆盖「所有供给链」，而不是「我改过的那一条」。** 内置资产在本仓有两条
独立来源（`extra-plugins/` 与 `prebuilt.tgz`），只审其一必然漏网；且漏网后表现为
「修好一个、炸下一个」，极易被误判成"修复无效"。查「哪些插件会被加载」的正确依据是
`BUILTIN_PLUGINS` 清单 + 两条来源的**并集**，不是某个目录的列表。

### 7.10 client 端模块表：0.1.5 **删除**了 dsh-client-runtime（第三类漂移）

**真机现象**（host 端已通、web UI 已起之后，页面顶部报）：

```
Failed to load plugins
failed to import loader entry …(dsh-provider-headers): client-modules:
require("@deepseek-ai/dsh-client-runtime/client") missed the module table
```

**这是第三类漂移**，与前两类都不同：

| # | 类别 | 表现 | 章节 |
|---|---|---|---|
| 1 | 符号缺失（包还在） | 具名导入链接期抛错 | §7.6 |
| 2 | 供给链漏审 | 同类错误换插件继续炸 | §7.9 |
| 3 | **整包被删除、能力迁移** | host 正常，**只在浏览器端炸** | 本节 |

**根因**（逐项实测，证据链闭合）：

- 0.1.5 把 `createSnapshotStore` 从 `dsh-client-runtime/client` **迁移到新包
  `@deepseek-ai/dsh-client-store`**，并删除旧包；
- 0.1.5 前端**种子表**（`staticModules`）只有 5 个 `@deepseek-ai` 词：
  `cordis` / `dsh-client-store` / `dsh-client-ui-dockkit` /
  `dsh-client-ui-primitives` / `dsh-client-ui-slots` —— **实测 client-runtime 出现 0 次**；
- 0.1.5 安装树中不存在 `dsh-client-runtime`；`dsh-web-app` 的 client 依赖也不含它；
- 新旧 `createSnapshotStore` **实现逐行相同**（仅缩进不同）→ 改指新包语义等价。

**★ 为什么 host 端正常而 UI 炸**：client 端走浏览器侧
`require(spec)` → `client-modules` 的**模块表**（种子词 → 已加载 → 已注册工厂），
与 Node 侧解析**完全无关**。所以「host 插件树加载成功」**不代表**「UI 能加载插件」，
**两边必须分别审计**。

**改动**（`stub-dsh.mjs`）：

- 新增 `eachPluginClientFile()`：枚举 `files/plugins/<dir>/lib/client.js`；
- `client-compat` 块：把 `require` 的**说明符字符串**从已删除包改为等价新包
  （`REQUIRE_MAP`，只动说明符、不动逻辑）；写盘前 `node --check` 自检；
  marker `dsh-launcher-client-compat-v1` 幂等。

**审计**（全部内置插件 client 端 `require` 清点，避免"修一个炸一个"）：

```
dsh-mobile-nav       : dsh-client-ui-primitives   ✅ 0.1.5 种子表存在
dsh-net-proxy        : dsh-client-ui-primitives   ✅
dsh-vision           : dsh-client-ui-primitives   ✅
dsh-provider-headers : dsh-client-runtime/client  ❌ 已删除 → 唯一需修
```

另确认 `client.js` 是唯一 client 入口：`dsh-super-injector/lib/index.js` 虽含
`__ModuleLoader__` 字样，但那只是**构建期生成的 banner 字符串**，不是 client 入口。

**验证（真机 scratch，仓库外）**：

- 真实 `client.js`：`require` 正确改写、语法通过、对照插件未被误改、二次运行幂等；
- 端到端模拟模块表解析：修复前 `require` **未命中**（复现真机报错文案），
  修复后**命中种子表**；并确认新包第 178 行确实
  `export { createSnapshotStore, defineStore, notifySubscribers, shallowEqual }`；
- 用 **APK 内**的 stub 实测真实 `client.js` → 改写为 `dsh-client-store` 且语法通过。

**沉淀（三类漂移的检查清单，下次 dsh 升级按此逐条过）**：

1. **符号**：插件每个具名导入的符号在新版是否仍导出（§7.6）；
2. **供给链**：`BUILTIN_PLUGINS` 的**两条来源并集**都要审（§7.9）；
3. **整包/模块表**：host 端与 **client 端分别**审 `require`/`import` 的**包是否还存在**
   —— 包被删且能力迁移时，Node 侧与浏览器侧表现完全不同，且**报错位置互不覆盖**。

### 7.11 打包：必须走 release.yml（build-apk.yml 的 debug 签名每次都变）

**发现**：核对历次交付的 APK 签名时发现，**同一个 workflow 的每次运行产生不同签名**：

| APK | 签名块 | 公钥 sha256（前 32 位） |
|---|---|---|
| 第一次 debug | `7109871a, 42726577` | `b2af23de8dfdb39326dffec4669087a9` |
| 第二次 debug | 同上 | `2a79373d59910234278f587f1d3da116` |
| 第三次 debug | 同上 | `16f7c8c9fa3048fe7aab268945c0b263` |

**根因**：`build-apk.yml` **没有任何 keystore 处理步骤**（`assembleDebug` 用 CI 每次
自动生成的临时 debug keystore）→ 每次运行的签名身份都不同 →
**这些包之间无法覆盖安装**，用户必须先卸载（丢失 dsh 全部数据与已装插件）。

`release.yml` 则不同：它先把 `DSH_KEYSTORE_B64` 密钥解码或使用**已入库的
`signing/release.keystore`**（`git add -f` 强制入库，正是为保证签名稳定），
再 `assembleRelease` → 签名身份跨运行恒定。

**实测对照**（本次 release 与上一个正式版）：

| APK | 签名块 | 公钥 sha256 |
|---|---|---|
| 正式版 v4.10.2-fix6 | `7109871a, 504b4453, 42726577` | `4ae87902636d13d372d81ff83e14d89d` |
| 本次 next release | 同上 | `4ae87902636d13d372d81ff83e14d89d` |

→ **完全一致，可直接覆盖安装**（无需卸载、不丢数据）。

**沉淀**：
1. 交付给用户的包必须走 **release.yml**；`build-apk.yml` 只适合内部验证编译能否通过
   （它的 debug 签名每次都变，交付即"必须卸载重装"）。
2. 判断「能否覆盖安装」的依据是**签名公钥**，不是版本号或包名——
   两个包同包名同 versionCode 但签名不同，安装器仍会拒绝。
3. `signing/release.keystore` 是**签名稳定性的唯一凭据**，丢失即永久失去对已发布版本的
   升级能力（用户只能卸载重装）。切勿清理或重新生成。
