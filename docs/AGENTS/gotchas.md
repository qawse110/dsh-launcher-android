# gotchas.md — 关键实现细节与坑（本项目全量登记）

> 用途：每次踩坑必须登记，避免重复探路。新增条目追加到文末并递增编号；
> 修复后**保留**条目（教训与历史归档同样有价值）。
> 检索：按关键词 grep 本文件（如 `killAllNode`、`SymlinkPolicy`、`LFS`、`嵌套注释`）。
>
> 参考项目 `kelai141/dsh-mobile-apk` 的同类文档（`docs/AGENTS/gotchas.md`，53+ 条）
> 是本文件的样板；两项目同名坑号**不互通**，跨项目引用时写明「参考坑 N」。

---

## 1. `ps -A` 列序在 Android toybox 上不是 procps（P0，真机实证）

**现象**：`killAllNode` 完全失效——残留 node 占住 3080 使「重启 dsh」反复失败；
`Proc` 安装类命令超时后 npm/pnpm 孙进程被孤儿化并与下一轮安装并发写 node_modules。

**根因**：原实现取 PID 的方式假设了桌面 procps 的列序：

```sh
ps -A | grep '[n]ode' | awk '{print $2}'   # 期望 $2 = PID
```

而 Android 自带 toybox 的 `ps -A` 列序是 **`PID TTY TIME CMD`**，`$2` 命中的是
**TTY 列**。真机实证（`com.dsh.launcher`）：

```
$ ps -A | grep '[n]ode'
  6310 ?        00:01:52 /data/user/0/com.dsh.launcher/files/node/bin/node
$ ps -A | grep '[n]ode' | awk '{print $2}'
  ?                                   ← 恒为 "?"
$ ... | while read pid; do kill "$pid" 2>/dev/null; done   # 静默失败，退出码 0
```

**为何长期未被发现**：三层静默叠加——① `awk` 正常输出 `?`；② `kill "?"` 失败但
`2>/dev/null` 吞掉 stderr；③ 管道整体退出码仍是 0。日志里只有一行无害的
「node processes killed」。

**修复**：新增 `NodeProcs`——读 `/proc/<pid>/cmdline`（NUL 分隔 argv），按 **argv0
绝对路径**判定归属。不依赖任何 `ps` 输出格式、不依赖外部工具。

**顺带修掉的同族问题**：
- `nodeProcessAlive()` 原判定「`ps … | grep node` 输出是否有任何行」——任何含
  `node` 字样的无关行都让判定恒真，「进程已死 → 提前失败」分支永不触发，只能干等超时。
- `MainActivity.stopDshAll()` 走 `pkill -f 'dsh/lib/bin.js web'`：模式串出现在执行
  它的 `sh -c` **自身 cmdline** 里，真机实测 `pgrep -f 'bin.js'` 会一并吐出执行命令的
  bash PID（自杀隐患）；且参考坑 31 记录部分 ROM 上 `pkill -f` 完全不生效，原代码还用
  `; true` 吞掉失败。现统一走 `DshFlow.killAllNode`。

**约定**：**任何"列出进程/按名字杀进程"的需求一律走 `NodeProcs`**，禁止再写
`ps | grep | awk` 或 `pkill -f`。进程归属判定用 `/proc` cmdline，不用命令行模式匹配。

---

## 2. `/data/data` ≡ `/data/user/0` 的路径别名（进程归属判定必须双侧规范化）

`/data/data` 是指向 `/data/user/0` 的软链，**同一目录两种写法**。进程 `cmdline`
里出现哪种取决于内核呈递方式，故归属判定必须两种都认，否则会漏掉自己启动的进程
（表现为「明明在跑却判定无进程」→ 重复拉起 / 不清理）。

`NodeProcs.isOurNode` 只接受两种形式：与 `binPath` 完全一致，或其 `dataAlias` 等价形式。
刻意**不做**「以 `/node/bin/node` 结尾」这类宽松后缀匹配——那会把
`/opt/other/node/bin/node`、`/data/user/0/com.other.app/files/node/bin/node`
都算作自己人，误杀无关进程。此约束由 `NodeProcsTest` 逐条锁定。

**归属判定按路径段比较，不按字符串前缀**——`SymlinkPolicy.isWithin` 同理：
`/ab` 不在 `/a` 之内，但 `startsWith` 会误判为真（参考坑 1「realpath 前缀混用」同族）。

---

## 3. 错 ABI 运行时 = 装到真机「引擎启动即崩」（参考坑 18/30）

参考项目两次重大事故：debug APK 里打包了 x86_64 快照，装到 arm64 真机覆盖后引擎崩——

```
error: "/data/data/.../usr/bin/node" is for EM_X86_64 (62) instead of EM_AARCH64 (183)
```

以及「双 ABI 循环打包后 assets 停在循环最后一个 ABI」——此后直接 `assembleDebug`
的产物即错 ABI。

**本项目对应风险**：内置 node 经 **Git LFS** 分发，文件名写死
`termux-node-aarch64.tar.gz`，但**文件名不是事实**。门禁
`tools/check-asset-abi.cjs` 读归档内 `bin/node` 的 ELF 头 `e_machine` 与文件名声明
双向核对，接入 `ci.yml` 与 `build-apk.yml`。

**注意**：未拉取 LFS（`actions/checkout` 缺 `lfs: true`）时拿到的是 133 字节指针
文件——门禁显式识别并输出 **SKIP**，不误报失败。CI 两个 workflow 都已带 `lfs: true`
（`release.yml:20` 有注释说明：缺省只拉到指针文件，`mergeAssets` 会报
`Not in GZIP format`）。

**设备侧体现**：真机 node 实测 `e_machine=0xb7 (aarch64)`，设备 ABI `arm64-v8a`——
一致即正确，这是排查该事故的第一手证据。

### 3.1 内置 node 归档是**两层**结构（门禁初版就栽在这里）

`app/src/main/assets/node/termux-node-aarch64.tar.gz` 解出来的**不是** `bin/`，
而是**单个内层** `termux-node-aarch64.tar`（112MB），真正的 `bin/node` 在内层。

```
termux-node-aarch64.tar.gz
└── termux-node-aarch64.tar      ← 唯一成员
    ├── bin/{node,npm,npx}
    └── lib/…
```

`NodeRuntime.ensureExtracted` 早有对应分支（解完外层若 `bin/node` 不在场，
就把唯一的 `*.tar` 再解一次）。**但 ABI 门禁初版漏了这一层**——只用自造的
扁平 tar 自测（`bin/node` 直接在顶层）→ 全绿；推到 CI（LFS 已拉取，拿到 37MB
真身）立刻失败：`归档内未找到 bin/node`。

**门禁在真实输入上抓出了自己的错误假设**。这是"用构造样例自测"与"在真实资产上跑"
的差距——构造样例只验证了我以为的布局。

**取内层 `bin/node` 头部的正确姿势**（不落盘，避免 112MB 落盘）：

```sh
tar -xOf outer.tar.gz inner.tar | tar -xOf - bin/node
```

**排查同类问题的入口**：`tar -tzf <归档> | head` 先看**顶层**到底是什么，
不要假设 `bin/` 在顶层。本项目 `prebuilt.tgz`、`termux-bootstrap.zip` 的形态亦各有不同。

---

## 4. Kotlin 块注释可嵌套：KDoc 正文里的注释起始符会吞掉代码

**与本文件样板（参考项目）不同**：Java/C/JS 块注释不可嵌套，Kotlin **可以**。
于是 KDoc 正文里写下形如「反引号 + `patched/` + 双星号 + 反引号」的写法时，
其中的 `/` + `*` 序列会**打开一层嵌套注释**：本该结束 KDoc 的终止符只关掉内层，
外层继续吞代码直到下一个终止符，表现为：

```
Syntax error: Missing '}'          ← 吞掉了函数体的闭合括号
Syntax error: Unclosed comment
```

**本项目两次真实编译失败**：历史 commit `5cf987d`、本轮 `d617620`
（`DshFlow.kt` 的 KDoc 里写 `patched/**`）。

**门禁**：`tools/bracecheck-edited.cjs` 按 Kotlin 语义按嵌套深度扫描，报告
未闭合与深度 >1 的位置。已用**修复前的历史版本文件**反向验证——精准报出
`braces=1`（正是 CI 报的缺失 `}`）与「深度 2，首个起始行 369」。

**教训**：写 KDoc 时不要在正文里写注释起始/终止符号字面量；需要提目录通配时
写 `patched/` 而非 `patched/**`。**该门禁自身的注释也踩了两次**（编写时实测），
可见此坑的隐蔽性。

---

## 5. 解压归档的符号链接目标必须白名单（纵深防御，参考坑 45）

Termux 运行时归档里有大量符号链接（`libcrypto.so -> libcrypto.so.3`），**必须真实
创建**——写成 0 字节空文件会让动态库加载静默失败（参考坑 22 的同族现象：
`CANNOT LINK ... library not found` 这类与根因相距甚远的报错）。

但归档是**外部输入**，链接目标可指向解压根之外。参考坑 45 的教训是双向的：

- **必须拒绝**：`../../` 逃逸、`/data/data/com.termux/...` 残留、任意系统路径；
- **必须放行**：合法的「指向本应用运行时根」绝对链接——参考项目曾有 9 个 applet
  （`vi`/`view`/`vim` 等）因严格校验只放行 `dest` 而被**静默丢弃**。

`SymlinkPolicy.classify` 的边界：相对目标以链接所在目录为基准规范化后必须仍在
**解压根**内；绝对目标必须落在**本应用数据目录**内。

**关键细节**：`appRoot` 取 `context.dataDir` 而非 `filesDir`——短前缀链接
`<dataDir>/t -> <filesDir>/termux/usr` 与官方镜像 `<dataDir>/data/data/...`
都建在**应用数据根**上。只放行 `filesDir` 会误拒指向自身运行时的合法链接
（即坑 45 的形态）。

---

## 6. 启动脚本模板是双源（`assets/web-launcher.sh.tpl` + 兜底内联常量）

`DshFlow` 渲染 web 启动脚本时对模板做四次 `replace("@TOKEN@", …)`。若资产缺失则
退回 `DEFAULT_WEB_LAUNCHER_TPL`。**两份模板是同一契约的两个源**——任一方缺令牌，
渲染**不会报错**，而是把 `@TOKEN@` 原样留在脚本里被 bash 当命令执行/当字面量，
表现为难定位的启动失败（如漏 `@EXPORTS@` → 引擎缺环境变量起不来）。

`LauncherTemplateTest` 钉死该契约：两源占位符集合必须完全一致，且与渲染逻辑消费的
四个令牌一一对应；并校验兜底模板具备 shebang / `cd @HOME@` / `nohup` / 日志重定向
等必要结构（应用默认 `cwd=/` 不可写，缺 `cd` 会导致相对路径 EACCES）。

同类约束见 `TermuxEnv`（环境变量字面量只允许出现在该文件，`TermuxEnvTest` 单源一致性回归）。

---

## 7. LFS 资产「文件名写死 ABI」+ 构建期不得漏拉

`app/src/main/assets/` 下三个大文件经 LFS 分发（`.gitattributes`）：

| 资产 | 大小 | 消费方 |
|---|---|---|
| `node/termux-node-aarch64.tar.gz` | 38.9MB | `NodeRuntime.ensureExtracted` |
| `prebuilt.tgz` | 30.7MB | `install-dsh.mjs`（内置插件提取） |
| `termux-bootstrap.zip` | 32.6MB | `BootstrapInstaller` |

**坑**：缺 `lfs: true` 时得到 133 字节指针文件。`NodeRuntime` 解压会失败并自动
删目录+重解压（失败即净），但 `mergeAssets` 阶段可能先报 `Not in GZIP format`
这类与根因相距甚远的错。**所有 workflow 的 checkout 都必须带 `lfs: true`**。

---

## 8. 环境变量字面量只允许出现在 `TermuxEnv`（单源化，已发生两次漂移事故）

PATH / LD_LIBRARY_PATH / HOME / TMPDIR 曾在 **6 处**独立拼接，导致：
① exec 分支漏拼 node/lib → node 起不来；② termux-exec 的 `LD_PRELOAD` 多点注入易漏；
③ 终端与会话环境已实测漂移（终端侧缺 `OPENSSL_CONF`/`SHELL`、前缀路径硬编码绕过
`TermuxRuntime.prefix`）。

现约束：环境字面量只在 `TermuxEnv` 出现；`NodeRuntime.nodeEnvPrefix` 已退役；
`terminalSessionEnv` 以 `childShellEnv` 为基底（`TMPDIR=home` + `PWD`），
由 `TermuxEnvTest` 逐键比对锁定。

**注意 `OPENSSL_CONF=/dev/null`**：本项目 node 自带的 openssl 需要它；参考项目
（快照内 Termux node，编译期硬编码 `/data/data/com.termux/files/usr/etc/tls/openssl.cnf`）
注入的是真实路径（其坑 5/12）。**两项目取值不同，不可照抄**。

## 9. 短前缀符号链接是官方二进制的硬前提（fail-loudly）

官方 Termux 二进制在编译期硬编码 `/data/data/com.termux/files/usr`（31 字符）。
本项目用**等长**短前缀 `/data/user/0/com.dsh.launcher/t`（31 字符）别名到真实
prefix，使 shebang 与 exec 路径可解析。

`BootstrapInstaller` 在 `PrefixPatcher.patchAll` **之前**创建该链接，并用
`isPrefixShortcutValid` 校验（`Files.isSymbolicLink` + `canonicalFile` 比对目标），
失败即抛 `IllegalStateException` 中止安装——此前仅 `Log.w` 静默继续，后续以含混的
`not found` / `EACCES` 挂掉且难以定位。

**时序关键**：patch 产出的 shebang 依赖该链接**先存在**，故创建必须前置。

### 9.1 短前缀 `t` **已经是 `usr` 的别名**——路径不能写 `t/usr/…`

`<dataDir>/t -> <filesDir>/termux/usr`（实测 `readlink` 确认）。于是 bash 的正确路径是

```
/data/user/0/com.dsh.launcher/t/bin/bash        ← 正确
/data/user/0/com.dsh.launcher/t/usr/bin/bash    ← 多了一层 usr
```

**真机实证（2026-09-10）**：`assets/web-launcher.sh.tpl` 的 shebang 写成了
`t/usr/bin/bash`，直接执行该脚本报：

```
bad interpreter: No such file or directory      # exit=126
```

**为何一直没暴露**：两条调用路径都写成 `bash <script>`（显式传解释器，
见 `DshFlow.startDshWeb` 的 `exec(ctx, "${bashPath} ${launcher}")` 与
`Supervisor.reviveWebIfDue` 的 `ProcessBuilder(bash, script)`），**shebang 从未被内核读取**。
又一个「靠巧合工作」：改成 `./dsh-web.sh` 或被别的进程以 shebang 调用就立刻失败。

**等价长度也是硬约束**：官方前缀与短前缀必须**同为 31 字符**（`patchAll` 对二进制做
等长字节替换，长度不等会直接拒绝并静默跳过全部 ELF）。已由 `LauncherTemplateTest`
的 `短前缀与官方前缀等长` + `资产模板 shebang 指向短前缀下的 bash` 两条测试钉死。

---

## 10. 增量 patch 的基线**不能用 mtime**——dpkg 会保留包内归档时间

**真机 P1（2026-09-10，本轮最严重的环境缺陷）**。

`PackageKit.ensure` 用「安装窗口开始时刻」作增量基线，原实现比对 `f.lastModified()`。
但 `dpkg-deb -x` / tar 解包会**保留包内的归档 mtime**——实测：

| 文件 | mtime | 基线（安装时刻） |
|---|---|---|
| `bin/git` | 2026-07-05 | 2026-09-06 |
| `bin/wget` | 2025-08-31 | 2026-09-06 |
| `lib/libuuid.so` | 2026-07-11 | 2026-09-06 |

**全部早于基线**。实测 `bin`+`lib` 共 **483 个文件全部被跳过、0 个被处理**，
其中 12 个（git / rg / wget / file / git-lfs / scalar / git-cvsserver / git-shell /
libuuid.so / libexpat.so.1.12.4 / pkgconfig/uuid.pc / expat.pc）至今带着官方硬编码前缀
`/data/data/com.termux/files/usr`。

**这不是潜在风险，是正在发生的可见故障**：

```
$ git config --get user.name
fatal: unable to access '/data/data/com.termux/files/usr/etc/gitconfig': Permission denied
```

`git` 二进制里还有 11 处官方前缀（`strings bin/git | grep -c` 实测）。
即「harness 工具装好了但没被适配」——工具能跑，但任何触及 etc/gitconfig、
share/git-core 等硬编码路径的操作都会以 Permission denied 失败。

**两个叠加的放大因素**：

1. **`ready()` 早退**：`PackageKit.ensure` 在 marker 命中时直接 `return true`，
   于是**存量设备永远不会重新走到 patch**——缺陷无法自愈。
2. **patch 失败静默**：`patchAll` 逐文件 `catch (_: Throwable) {}`，
   「0 个被处理」在日志里只呈现为一行 `patched files=0 skipped=483`，极易忽略。

**修复**（三层）：
- `PrefixPatcher.shouldProcess` 判据改为 **ctime OR mtime**：`ctime`（inode 状态变更时间）
  由内核在文件**落盘那刻**写入，归档无法伪造，因此「本次安装写进来」的文件必然
  被捕获；取「或」而非只用 ctime，是因为 Android 上 `creationTime()` 的底层语义
  （statx birthtime 或回落 st_ctime）**无法在本开发环境实测**——拿未经验证的 API 语义
  下判断正是本项目已记录两次的失败模式。取「或」把正确性变成可证明的：
  安装窗口内写入 → ctime 必刷新 → 一定处理；真正陈旧的文件两个戳都旧 → 才跳过。
- `PackageKit.repairStalePrefixes`：在 `ready()` 早退分支插入**一次性自愈**
  （marker `prefix-repair` 控代次），对存量安装做全量内容扫描修复。
  失败不写 marker，下次启动重试。
- 开销实测可控：全量扫描 `usr` 树（3835 文件 / 144MB）约 **1.1s**（其中 bin+lib
  483 文件约 250ms），且只在升级后首次启动跑一次；调用方均已在后台线程
  （MainActivity / ConsoleActivity 的 `thread { }` 包裹）——**不可挪到主线程**。

**验证**：把 `bin/git` 复制出来做等长替换（11 处 → 0 处）后执行，
`git init` 与 `git config` **均不再报 EACCES**；对照未 patch 副本必现
`fatal: unable to access ... Permission denied`。

**约定**：任何「哪些文件是本次操作产生的」判定，**不得依赖 mtime**——
归档解包、`cp -p`、`rsync -t`、`git checkout` 都会保留源时间戳。
用 ctime，或在内容层面判定（本项目 patch 幂等，多处理无副作用）。

---

## 11. 模板注释里写占位符字面量会被渲染器一并展开

**真机实证（2026-09-10）**。`assets/web-launcher.sh.tpl` 曾有一行说明性注释：

```
# 可用占位符：@EXPORTS@ @HOME@ @NODE_CMD@ @LOG_FILE@
```

`DshFlow` 的渲染是**纯字符串 `replace`**，不区分注释与代码——四个占位符连同
注释里那一份被全部替换，生成了一条真实执行的杂散命令：

```
 /data/user/0/com.dsh.launcher/files /data/user/0/com.dsh.launcher/files/node/bin/node \
   --expose-internals --import …/fs-register.mjs …/bin.js web /…/logs/web.log
```

bash 报 `Is a directory`（exit=126）。**脚本没有 `set -e`，失败后继续执行到真正的
`nohup`，功能表现完全正常**——所以长期没有被发现。

**修复**：注释里不写占位符字面量（改用自然语言描述）；并在 `LauncherTemplateTest`
补上**计数**判据（每个占位符必须**恰好出现一次**）。

**为何原测试没抓到**：原测试用 `Set<String>` 比对令牌集合，
而**注释里那份与真正那份是同一个字符串，集合比对会静默折叠重复**——集合相等照样通过。
`Set` 判据对「重复」天然失明，凡是关心出现次数的场景都必须用计数。

**衍生**：`renderedTokens` 在测试中独立写死一份，与 `DshFlow.WEB_LAUNCHER_TOKENS`
交叉校验，防止有人只改一处。

---

## 12. 本轮三缺陷的共同形态：**靠巧合工作**

三个缺陷都不是「功能坏了」，而是「当前恰好没坏」：

| 缺陷 | 为何当前表现正常 | 触发条件 |
|---|---|---|
| `t/usr/bin/bash` shebang 多一层 | 调用方都显式传 `bash <script>`，shebang 从未被读 | 改为 `./dsh-web.sh` 或被别处以 shebang 调用 |
| 注释里的占位符被展开 | 脚本无 `set -e`，杂散命令失败后继续执行 | 加 `set -e`、或杂散行恰好成功（改变用户路径布局） |
| 增量 patch 全量跳过 | 大多数工具不触碰硬编码路径 | 任何读 `etc/gitconfig` 等路径的操作（已实测复现） |

**教训**：「跑得通」不等于「写对了」。排查环境类问题时，
**主动去验证那些「假设成立但从未被检验」的前提**（路径是否真存在、时间戳语义是否如假设、
字符串替换是否区分上下文），而不是等到用户报障。
本轮的三个缺陷全部由「读设备实况 + 与代码假设对账」发现，**没有一个是 CI 能抓到的**
——这正说明静态门禁与真机核对的职责边界。


---

## 13. 插件 ↔ 壳侧的事件契约没人守：三个真实缺陷（review-r8）

内置插件 `dsh-status-bridge` 把 dsh 的 session 事件转成壳侧悬浮窗/桌宠的输入。
「事件名 ↔ 文案/行为」是**跨边界契约**，但此前**没有任何机械校验**。
逐条读插件 + 读 dsh 权威 schema + 仿真壳侧逻辑后，挖出三个真实缺陷：

### 13.1 `lastEvent` 无条件透传 → 高频 chunk 冲刷掉语义事件

插件原实现 `state.lastEvent = event.type`，而 `assistant/chunk` 是 **token 级高频**
事件（每个流式片段一次）。壳侧以 1s 轮询取 `/status`，于是流式阶段 lastEvent
恒为 `assistant/chunk`——而壳侧三个消费方（`StatusOverlay.statusLabel` /
`PetSpeaker.speakForStatus` / `PetOverlayView.actionRowFor`）**都没有该分支**，
全部落到退化 else：一轮对话中占比最大的流式阶段，文案从「思考中」退化为「dsh 运行中」。

**修复**：引入 `SEMANTIC_EVENTS` 白名单，只有语义事件才改写 `lastEvent`；
高频 chunk 仅累积 `lastText`（流式朗读照旧）。

> **归因纠错（重要）**：我最初把「PetSpeaker 的『正在调用工具』台词被吞」也归因于
> 这里，**仿真证明是错的**——真实根因在**壳侧**（见 13.4）。

### 13.2 `turn/end` 的 aborted/blocked 被当成 finished → 误报「任务完成」

权威 schema（本机 `dsh-session` 的 `TurnEndReasonMap`）里 `reason.kind` 有**六种**：
`completed | aborted | blocked | error | interrupted | max-tokens`。
插件原实现只判 `error`，其余**一律** `finished`。壳侧 `StatusBridgeService` 在
`prev == "running" && status == "finished"` 时弹「任务完成」通知 + TTS
「任务完成，太棒了！」——于是**用户主动取消任务（aborted）也会收到完成祝贺**。

**修复**：改用**显式映射表** `TURN_END_STATUS`，**只有 `completed` → finished**；
`aborted`/`blocked` → 同名独立终态；`interrupted`/`max-tokens` → `aborted`（未完成）。
壳侧 `statusLabel` 补「已取消」「已阻塞」文案。

> **参考项目自身也有此缺陷，不可盲抄**：其注释写明「assistant/message.interrupted
> （被打断不弹）」，但其代码读的是 `turn/end.outcome` —— **schema 里根本没有
> `outcome` 字段**（只有 `reason`），故 `ok: d?.outcome === 'success'` 恒为 false。
> 教训：跨项目借鉴时，**必须对着本机 schema 复核字段名**，不能只读注释。

### 13.3 `chunk.type === 'block'` 是死分支（真实取值 `block-end`）

真实 `StreamChunk` 联合类型（本机 `dsh-llm` types）为：
`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`。
插件判定的 `'block'` 不在其中 → 该分支永不命中，块式输出的文本整段漏累积。

### 13.4 壳侧 `PetSpeaker`：键记录写在节流检查之前 → 台词被永久消费

```kotlin
val key = "$status|${event ?: ""}"
if (key == lastSpokenKey) return
lastSpokenKey = key                    // ← 在节流检查**之前**
if (SystemClock.uptimeMillis() - lastSpokeAt < 4000L) return   // 被挡掉的事件已消费掉键
```

被 4s 节流挡掉的语义事件会**永久消费掉自己的键**，此后每轮轮询都被去重直接
`return`，台词再也不播。仿真实测（复刻壳侧轮询逻辑）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 快轮次（turn/start@0 → 完成@2s） | 只播「收到新任务」，「任务完成」**永久丢失** | 节流窗一过即补播 |
| 慢工具（tool/call 持续 >4s） | 永不播「调用工具」 | 正常播报 |
| 工具执行中（isSpeakingActive） | 记键后 return → 播完也不补 | 不记键，播完后补播 |

**该缺陷对每一轮 4 秒内结束的对话都生效**，属高频路径。
**修复**：键记录下沉到各分支内（未播报 = 未处理）。

### 13.5 新增门禁：`tools/check-plugin-contract.cjs`（7 项检查）

| # | 检查 | 抓什么 |
|---|---|---|
| A | 插件脚本 `node --check` | 语法（assets 门禁只管 assets/，不管 extra-plugins/） |
| B | 语义事件白名单 ↔ 壳侧 statusLabel 分支 | 契约漂移（两边事件名对不上） |
| C | 插件产出 status ↔ 壳侧终态文案 | 新增终态漏文案（显示成「dsh 空闲」） |
| D | `chunk.type` 必须存在于真实 StreamChunk 联合 | 死分支 |
| E | `TURN_END_STATUS` 必须覆盖 schema 全部 kind | schema 新增终态漏配 → 误报完成 |
| F | **运行时驱动**状态机（全 kind + 未知事件） | 静态看不见的作用域/引用错误 |
| G | 插件自带 `node:test` 单测 | 状态机语义写错 |

**F 项为何必须有**（我亲身踩到）：把 turn/end 重构成映射表时，编辑操作意外删掉了
`const kind = ...` 声明，留下 `TURN_END_STATUS[kind]` 引用未定义变量。
**静态检查（A~E）全部通过**，但真机执行 `turn/end` 直接抛
`ReferenceError: kind is not defined`——而该异常会被 `apply()` 的 try/catch 吞掉，
表现只是「状态永远停在 running」。**只有真跑一遍才能发现。**

**反向验证（门禁必须见过它失败）**：
- 静态缺陷 7/7 拦下（含我真实犯过的两个：白名单定义未使用、映射表定义未使用）；
- 运行时缺陷 3/3 拦下（含上面那个 ReferenceError）；
- 单测缺陷 3/3 拦下；三者恢复原状后均通过。

**元教训**：初版门禁只校验「契约元素**存在**且覆盖 schema」，于是把
`SEMANTIC_EVENTS.has(type)` 改回无条件透传、把映射表换成 if/else 兜底——
**门禁全绿、两个真实缺陷双双漏检**。**定义了却不使用的契约等于没有契约**，
必须断言使用点（`SEMANTIC_EVENTS.has(`、`TURN_END_STATUS[`）真实存在。

### 13.6 顺带：新增 `test/` 单测（对齐参考项目约定）

参考项目每个插件都有 `test/*.test.mjs`（`node:test` + `assert/strict`，零依赖），
本项目此前**一个插件单测都没有**。已为 `dsh-status-bridge` 补 17 个用例，
覆盖上述三个缺陷 + 工具配对 + 健壮性（未知事件/畸形事件/lastText 有界）。

---

## 14. ★ Android 上桌面沙箱执行器 fail-closed：默认档位下 bash 工具不可用（review-r9）

**本轮最严重发现**——由「读参考项目 dsh-shell-termux」引出，实读源码 + 本机 schema 实证。

### 机制（全部源码实证）

dsh-base 默认装配的 bash 执行器是 `@deepseek-ai/dsh-bash-sandbox`：

```js
// dsh-bash-sandbox：非 danger-full-access 时把命令交给沙箱包装
if (mode === "danger-full-access") return { ...await super.run(spec), sandbox:{mode,denied:false} };
const confined = this.confine(spec.command, {...policy, mode});     // ← 这里
// confine() 实现：
confine(command, policy) { return this.ctx.sandbox.confine(["bash","-c",command], policy); }
```

而 sandbox provider（`dsh-sandbox-local`）的平台链条是：

```js
const PLATFORM_CHAINS = { linux:["bwrap","landlock"], darwin:["seatbelt"], win32:["windows-acl"] };
// chainVerdict(): const chain = PLATFORM_CHAINS[platform] ?? []   ← android 落到 []
//                 if (first === undefined) return "unavailable"
// selectRunner(): if (this.selectedRunner === "unavailable") throw new SandboxUnavailableError(mode)
```

本机 `process.platform === 'android'` → **链条为空** → `chainVerdict()` 返回 `"unavailable"`
→ `selectRunner()` 抛 `SandboxUnavailableError`。

而 dsh-base 的**会话默认档位是 `workspace-write`**
（`mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`）——
即：**默认档位下 Android 的 bash 工具会被沙箱 fail-closed 拒绝执行**。

### 为什么一直没暴露

本机所有历史会话档位**恰好都是 `danger-full-access`**（实测 10 个会话全部如此）。
该模式下 `run()` 直接 `return super.run(spec)`，**不走 confine** → 侥幸可用。

**触发条件**：用户把档位切回默认的 workspace-write、或新会话未显式升档 → bash 工具即不可用。
这与坑 12 的「靠巧合工作」是同一形态，但后果更重（工具整体不可用）。

### 参考项目的解法（本轮借鉴对象）

参考项目 `kelai141/dsh-shell-termux` 的**整个存在理由**就是这个实证。
其设计文档原文：

> | `PLATFORM_CHAINS = { linux:[bwrap,landlock], darwin:[seatbelt], win32:[windows-acl] }`——**无 android** | dsh-sandbox-local 源码 |
> | "A platform with no chain fails closed at `confine()`" | 同上 |
> | **结论：安卓上 bash 工具实际执行会被沙箱拒绝**（M0 只验证了服务启动，未验证工具执行） | 推理 |
>
> 即：**"碰巧能启动" ≠ "工具可用"**。

解法 = **`bash-sandbox` 条目 `disabled` + 插入自己的 `ctx.shell` provider**，
并**诚实声明**沙箱语义（`enforcement: 'partial'`，真实边界是 SELinux 应用域 + 审批流）。

### 本项目落地

新增内置插件 `app/src/main/assets/extra-plugins/dsh-shell-termux/`：

- `lib/index.js`：`TermuxBashExecutor extends LocalBashExecutor`（复用全部预算/生命周期语义），
  只做两件增量——① `resolve()` 显式注入 Termux 环境；② `sandboxMode` 返回 `undefined`
  诚实声明「不做路径级沙箱」。
- `cordis.patch.yml`：`- id: bash-sandbox / disabled: !!js process.platform === 'android'`
  + insert 本插件（同样限定 android，桌面保留真实沙箱）。
- `test/shell-termux.test.mjs`：21 个用例（含我自己引入过的 PATH 继承回归）。

### 显式环境注入的独立价值（实测）

即使绕开沙箱问题，环境注入本身也修掉一个真实缺口——
dsh 默认执行器 spawn 的是**裸 `"bash"`**，靠继承进程环境解析；而子进程环境
= `scrubbedParentEnv()` ⊕ spawn env，即**完全依赖 web 进程的 PATH/LD_LIBRARY_PATH 恰好正确**：

```
# 无显式 Termux 环境时：
$ git --version
CANNOT LINK EXECUTABLE "git": library "libpcre2-8.so" not found
# 注入后：
$ git --version
git version 2.55.0
```

端到端验证（真实 ctx 装载）：**删除进程的 `PATH`/`PREFIX`/`LD_LIBRARY_PATH` 后
`git --version` 仍正常**——证明注入是自包含的，不再依赖环境碰巧正确。

### 顺带修为

`bash` 可执行性检查：工作区原先只判 `File.isFile`；实测「文件存在但权限 644」时
判真、执行 `Permission denied` 后以含混错误挂掉。插件改用 `accessSync(X_OK)`
并给出修复指引（对齐参考实现的 `assertBash`）。

### 装配契约门禁

本插件以 `ctx.shell` **唯一 provider** 身份替换默认执行器，装配写错有两种致命后果：
① 没 disable `bash-sandbox` → 争抢单例服务；② disable 了但 insert 未生效 →
**无任何 provider**，bash 整体不可用（比原缺陷更糟）。故
`tools/check-plugin-contract.cjs` 新增 §H：核对 disable/insert 成对出现、均限定
`process.platform`、三坐标齐备、`inject` 声明、继承上游执行器。

**反向验证 3/4 → 修好 → 4/4**：初版用裸短语 `extends LocalBashExecutor` 做锚点，
**注释里提到该短语即算命中**，故「真实继承被改掉」时漏检；改为锚定类声明
`export class \w+ extends LocalBashExecutor\b` 后正确拦下。
（又一次印证：**门禁必须见过真实坏输入**，而不是只看构造样例。）

---

## 15. 纯 JVM 单测里 `org.json` 被桩掉 → NPE（review-r10 CI 实测）

`app/build.gradle.kts` 设了 `unitTests.isReturnDefaultValues = true`——未 shadow 的
android 类方法返回默认值。`org.json.JSONObject` 因此在**纯 JVM 测试**下：

```kotlin
val o = JSONObject("""{"a":1}""")   // 桩实现：内部 map 未初始化
o.optString("a", "x")               // → NullPointerException
```

CI 实测：7 个用例全部 NPE 在同一行（`JSONObject(...)`）。

**约定**：**凡碰 android 类的单测一律带 Robolectric runner**：

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
```

Robolectric 的 android-all 提供真实实现，解析语义才等于线上语义。本仓 8 个测试类
都遵守此约定；例外只有纯函数逻辑（`SymlinkPolicyTest`、不碰 android 类）。
`BackupManagerTest` 是反证：它经 `BackupManager.create()` 走到 `JSONObject` 且通过。

**识别信号**：单测报 `NullPointerException` 且堆栈指向 android 类（`org.json.*`、
`android.util.*`）的**内部**，而不是被测代码——先查 runner 注解，不要先怀疑逻辑。

---

## 16. 结构整理经验：先量「行为是否真的相同」，再动手

review-r10 把三处重复实现收敛到单点（环境构造 / 本地 HTTP / 状态解析）。
可复用的做法：

1. **先对账，不改码**：把重复方的**输出逐字节对照**（本轮把三套 PATH 用脚本
   打印出来逐项比对），确认哪些差异是刻意的、哪些是漂移。
2. **刻意差异必须显式化**：`webProcessExports` 的 PATH 顺序与 `childShellEnv` 不同
   （web 需 `node/bin` 优先，否则 `node`/`npm` 可能解析到别处）——整理后这类差异
   变成构造器的显式参数 + 注释，而不是「两份代码各自碰巧一样」。
3. **漂移当缺陷修**：对账中发现 `webProcessExports` **缺 `LANG`**
   （真机 `/proc/<pid>/environ` 实测无 LANG，而 childShellEnv 设了 `C.UTF-8`），
   属真实缺失而非风格差异。
4. **顺手修同源错配**：web 的 `LD_LIBRARY_PATH` 硬编码推导 `filesDir/node/lib`，
   而 PATH 用调用方传入的 `nodeDir`——两个来源。统一为同一个 `nodeDir` 派生后，
   不可能再出现「PATH 指向 A 的 node、LD 指向 B 的 lib」。
5. **审计公开面**：整理后确认 `nodeLibDir`/`ldLibraryPath` 已无外部消费者 →
   转 private；`nodeBinDir` 无消费者 → 直接删。公开 API 收敛为「三个消费方函数」。

**新增的结构不变量要写成测试**：本轮加了「三处环境对共享键取值一致」——
新增消费方漏键会立刻失败（`LANG` 那种漂移不可能再发生）。

---

## 17. ★ `cordis.patch.yml` 里 `!!js` 用**裸反引号**开头 → dsh 启动即崩（review-r11 实测）

**本轮最严重的自身缺陷**——由「无风险验证」逐层实测挖出。它不是「表达式没生效」，
而是 **dsh 整个起不来**。

### 症状与定位过程

用 `dsh --patch <file> --dump-config` 验证 `dsh-shell-termux` 的 patch 时：

```
Error: dsh: failed to parse overlay .../cordis.patch.yml:
  YAMLException: cannot resolve a node with !<tag:yaml.org,2002:js> explicit tag (35:24)
```

**注意错误指向第 35 行**（`bashPath`），而第 33 行的 `!!js` 是同文件、同 schema
却成功了 —— 差异只有一个：**反引号**。

### 根因（最小对照实验，js-yaml 4.3.2 + dsh-app-boot 同款 schema）

| 写法 | 结果 |
|---|---|
| `!!js process.platform !== 'android'` | ✓ 正常 |
| `` !!js `${X}/bin/bash` `` （**裸反引号开头**） | ✗ **`cannot resolve a node with …js`** |
| `!!js "\`${X}/bin/bash\`"`（引号包裹） | ✓ 正常 |
| `` bashPath: `${X}/bin/bash` ``（无反引号包裹也无 `!!js`） | ✗ `bad indentation of a mapping entry` |

**YAML 规范里 `` ` `` 是保留指示符**，不能作裸标量的首字符。js-yaml 因此无法
把它识别为普通字符串，`!!js` 的 scalar 解析随之失败。

**为何后果特别严重**：`dsh-app-boot` 的 `parsePatchList` / `loadOptionalPatches`
用 `yaml.load(content, { schema: entryListSchema })` 且**解析失败即 `throw`**
（`failed to parse overlay/config …`）——patch 层在 boot 早期读取，
**解析失败 = boot 失败 = dsh 起不来**。

### 修复与约定

改用**字符串拼接**，彻底绕开「模板串 + 引号」两层嵌套：

```yaml
bashPath: !!js (process.env.PREFIX ?? '') + '/bin/bash'   # ✓
# 不要写： !!js `${process.env.PREFIX ?? ''}/bin/bash`     # ✗ 裸反引号
```

### 门禁

`tools/check-plugin-contract.cjs` §H ⑦：扫描 `cordis.patch.yml` 中
`/!!js\s+`/` 形态即失败，并给出可复制的正确写法。
**反向验证**：把修复版改回裸反引号 → 门禁拦下并精确指向行号；恢复后通过。

### 教训（验证方法论）

这个缺陷**所有静态门禁都抓不到**，也不是代码逻辑问题——它只存在于
**「YAML 解析器 × YAML 规范 × dsh 的解析入口」三者交叉处**。
能抓到它只有一个原因：**用 dsh 自己提供的解析入口（`--patch` + `--dump-config`）
真跑了一遍**，而不是「我读代码觉得应该没问题」。

**推广**：凡是要往 `cordis.patch.yml` / profile 配置里写「平台条件或环境变量表达式」，
一律先用 `dsh --patch <file> --dump-config` 验证能被 dsh 接受——
这是**唯一权威**的判定方式，且完全无风险（只解析、不启动引擎）。
