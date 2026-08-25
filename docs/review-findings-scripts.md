# 脚本层全量 Review 记录（install-dsh / stub-dsh / fs 三件套 / routing-suite / tpkg / tpl / py）

- 基准：v4.8.0；审查方式：两个并行代理 + stub-dsh 因体量改人工分段 + 本人交叉契约复查
- 修复 11 处（含 1 P0），记录遗留差异 4 项

## install-dsh.mjs（代理 A）

| 级别 | 发现 | 处置 |
|---|---|---|
| **P0** | 升级"先删后装"：pnpm 首试前无条件删 node_modules，弱网一次失败即把可用安装毁成零安装 | ✅ 改为「失败后检测 npm 布局才清理并就地重试一次」 |
| P1 | 全部状态路径派生自契约未承诺的 HOME | ✅ 新增 `FILES_DIR=dirname(DSH_PREFIX)`，13 处状态路径改由其派生 |
| P1 | 日志洪流灌 UI（npm `--loglevel=http`） | ✅ npm 降为 notice；pnpm 补 `--loglevel warn`（保留 append-only 进度行） |
| P1 | 插件装配失败被吞、恒 exit 0 | ✅ routing-suite 同款聚合：失败置 exitCode=1 |
| P1 | 解压只覆盖不删除，APK 升级新旧混跑；symlink EEXIST 空 catch | ⏸ 记录（涉及目录级原子替换设计，随 R2-P2-4 插件分发解耦一并做） |
| P2 | ripgrep 包版本错配 spec、chmodSync 静默失败、cordis.patch 按锚切块脆弱、无并发锁、/sdcard 双写 | ✅ 双写已门控（`DSH_SHARED_LOG=1` 才写）；其余记录 |

## fs 三件套 + routing-suite.mjs（代理 B 重试）

| 级别 | 发现 | 处置 |
|---|---|---|
| P1 | download() 的 body 读取在 clearTimeout 之后——卡死场景保护失效 | ✅ arrayBuffer 移入 try 内 |
| P1 | dshPlugin 返回值丢弃 → injector 装配失败仍报成功 | ✅ 失败置 process.exitCode=1 |
| P1 | loader 仅匹配 `node:fs/promises`，裸 `fs/promises` 绕过兼容层 | ✅ Set 双匹配（CJS/linkSync 盲区记录为已知限制） |
| P1 | link→rename 语义缺口：源消失 / 并发覆盖失真 | ✅ O_EXCL 占位裁决并发（败者 EEXIST）+ rename 后尽力拷回源内容；残余差异写入文件头注释 |
| P2 | tar symlink 目标未校验（tar slip 变体）、解压炸弹无上限、HOME 兜底多用户错位 | ✅ 已加绝对路径/../拒绝；其余记录 |
| P2 | gen_default_pet.py 先写盘后校验、assert 被 -O 剥离、range(8) 硬编码 | ✅ validate_atlas() 先校验后写盘 + raise + range(COLS) |

## stub-dsh.mjs（本人分段审，代理两次资源耗尽）

- 结论：**质量高**。全部补丁带内容幂等标记；写盘前 `node --check` 语法校验（防毒化）；锚点失配优雅降级 skip；逐块 try/catch 隔离。
- ✅ `/sdcard` 日志双写与 install-dsh 同款门控。
- 记录：`patch-koffi.yml` 占位每跑必写（有意保留的旧版兼容）；base64 桩导出面靠生成时保证，运行期不校验。

## 交叉契约验证

- cwd 迁移（filesDir→termux home）：三组脚本全部使用绝对路径或 import.meta.url 推导，**无回归**
- LD_PRELOAD 注入：install-dsh 经 `{...process.env}` 透传保留；pnpm wrapper 用 `#!/system/bin/sh` 不依赖翻译；NPM_BIN shebang 依赖 termux-exec——链路自洽
- 本地校验：6 个 mjs `node --check` 全过；py_compile 过

---

## 逐脚本符合度审查（对照 v4.8.0 当前需要）

| 脚本 | 程序当前需要 | 符合度 | 处置 |
|---|---|---|---|
| install-dsh.mjs | npm 渠道安装/升级 dsh + 装配 7 内置插件；弱网鲁棒 | ✅（本轮 P0/P1 已修） | 保留 |
| stub-dsh.mjs | 上游无 android 产物模块的免编译适配 + WebView polyfill | ✅ 全补丁幂等带校验 | 保留；删除 patch-koffi.yml 死写入 |
| fs-register/loader/promises-compat | SELinux 禁硬链接的会话落盘兼容 | ✅ loader 补齐裸说明符；并发语义修正 | 保留 |
| routing-suite.mjs | 用户手动安装 yjh051108/dsh-routing-suite 时的特殊适配（按需触发，非主流程） | ⚠️→✅ 文件根三级推导修复多用户/手动运行错位；超时/退出码/slip 防护已修 | 保留 |
| tpkg.sh | pkg 安装失败时的 deb 手动兜底 | ✅ 与原生 apt 主链路互补，职责清晰 | 保留 |
| web-launcher.sh.tpl | 可重现的 web 启动环境 | ✅ 模板化后由 TermuxEnv 单源渲染 | 保留 |
| tools/gen_default_pet.py | 重新生成默认桌宠资产的开发工具 | ✅ 校验前置已修 | 保留 |
| （生成物）00-dsh-env.sh | 交互终端 Linux 化体验 + termux-exec 预载 | ✅ | 保留 |
| （生成物）00-dsh-apt.sh | W^X 包装器——v4.6 默认可写后近乎空转 | ◑ 保留作未来收紧保险（-w 短路无开销） | 保留 |
| （生成物）apt.conf 00-dsh | instdir+镜像+admindir：dpkg 原生可用的基石 | ✅ 关键路径 | 保留 |

**退役候选**：无。所有脚本均有现行消费方。
**已知限制（文档化，不改）**：fs 兼容层不覆盖 CJS/linkSync；tpkg 不执行维护脚本；routing-suite 解压无体积上限（来源为固定 HTTPS 仓库）。

## 附：fresh 安装真机验证（debug @ v4.8.0）

✅ 六键 markers.json 自动生成；logs/{flow,web,heartbeat}.log 就位；web cwd=filesDir；
✅ 原生 apt 全链路（update+install rc=0，libcrypt ii）；termux-exec 随 PackageKit 自动安装。
⚠️ 发现并修复：tpkg 未落盘（writeAll 单点静默失败，logcat 已轮转无法溯源）——
   PackageKit.ensure 幂等刷新段补入 writeTpkgScript，此后每次 harness 准备强制补齐。
ℹ️ `.plugins-extracted-ok` 为 install-dsh.mjs 内部幂等标记（提取成功语义必须由脚本侧
   维护，注释已说明），保持脚本侧自管、不并入 MarkerStore。

## 附2：stub 补丁 → 插件迁移映射表（方向：尽量减少脚本对 dsh 的修改）

参考：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
（插件=导出 apply(ctx) 的 cordis 模块；项目内样例：extra-plugins/dsh-status-bridge）

| stub 补丁 | 插件化可行性 | 依据 / 所需确认点 | 落点 |
|---|---|---|---|
| directory-picker SD Card 快捷入口 | 高（待确认） | 目录浏览 entries 组合点是否经服务暴露 | 已建 extra-plugins/dsh-android-compat 骨架，迁移代码写其 apply |
| host-apiproxy openPath 委托宿主 App | 中（待确认） | open 动作路由/事件覆写点 | 同上 |
| dsh-sandbox 可写根→TMPDIR | 中（待确认） | sandbox 是否读 ctx.config | 同上 |
| dsh-fs-local chmod FUSE 容错 | 低 | 函数体级包裹，无钩子 | 保留 stub |
| koffi/node-pty/sharp 模块桩 | 低 | 依赖装载前介入，晚于插件加载 | 保留 stub |
| @vscode/ripgrep resolver | 低-中 | 若 fs-search 支持 rg 路径配置则转配置 | 评估后定 |
| attachment-local 视觉补丁 | 低 | 函数体级源码改写 | 保留 stub |

已落地：
- extra-plugins/dsh-android-compat（package.json + cordis.patch.yml + lib/index.js 骨架）
  接入 install-dsh BUILTIN_PLUGINS/BUILTIN_NAMES 与 extra-plugins 直拷通道；
  真机验证路径 = 重装 debug 后 `dsh plugin --profile web list` 应含 dsh-android-compat。
