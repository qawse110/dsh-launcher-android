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
