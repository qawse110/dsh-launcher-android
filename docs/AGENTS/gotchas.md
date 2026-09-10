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
