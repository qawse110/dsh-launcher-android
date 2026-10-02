#!/usr/bin/env node
/**
 * install-dsh.mjs — 设备端 dsh 安装/更新的**编排层**。
 *
 * 本文件只做三件事：解析参数 → 按顺序调用各职责模块 → 写状态文件。
 * 具体实现已按职责拆到 assets/install/ 下（整目录随 APK 同步）：
 *
 *   install/env.mjs      路径常量、日志、子进程封装（无业务语义的基础件）
 *   install/dsh.mjs      dsh **本体**安装/更新（npm 包供给链 + ripgrep 兜底）
 *   install/plugins.mjs  **内置插件**装配（读清单 → 同步源 → 摘退役身份 → 装配 → 清 patch）
 *   install/deps.mjs     **依赖桥接**（plugins/node_modules 与 profile/node_modules 两条）
 *
 * 拆分动机：此前本文件 1000+ 行、同时承担上述四类职责，任何一处改动都要在
 * 一个巨大的作用域里推理；现在每个模块只回答一个问题，调用顺序集中在这里可见。
 *
 * 用法：
 *   node install-dsh.mjs                # 完整安装/更新 dsh + 装配内置插件
 *   node install-dsh.mjs --plugins-only # 跳过 npm 更新，只重新装配内置插件
 *
 * 环境变量：
 *   HOME / NODE_BIN / NPM_BIN / DSH_PREFIX / DSH_PROFILE
 *   DSH_PLUGINS_DIR / DSH_NODE_MEM / NPM_REGISTRY
 *   DSH_NPM_TIMEOUT_MS / DSH_PLUGIN_TIMEOUT_MS（子进程硬超时，防网络卡死）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  HOME, FILES_DIR, DSH_PREFIX, DSH_PROFILE, log, dshInstalled,
} from './install/env.mjs';
import {
  ensurePnpm, ensureDsh, ensureRipgrepFallback,
} from './install/dsh.mjs';
import {
  BUILTIN_PLUGINS, installBuiltins, pruneRetiredBuiltins, auditBuiltinCompatibility,
} from './install/plugins.mjs';
import {
  linkPluginDeps, linkProfileDeps,
} from './install/deps.mjs';

// ── main ─────────────────────────────────────────────
log('=== official dsh install start ===');
log('HOME=' + HOME + ' DSH_PREFIX=' + DSH_PREFIX + ' PROFILE=' + DSH_PROFILE);
try { mkdirSync(join(FILES_DIR, 'tmp'), { recursive: true }); } catch {}

const pluginsOnly = process.argv.includes('--plugins-only');

// 单独重跑兼容性审计（插件管理页在「装配/修复」成功后调用）：
// UI 的那些操作直接走 `dsh plugin add`，不经过本文件的装配流程，
// 若不补这一步，files/plugin-status.json 就永远停在旧结果上——
// 界面会拿过期判定继续显示，正是要消除的那类静默不一致。
if (process.argv.includes('--audit-only')) {
  await auditBuiltinCompatibility();
  log('=== audit only done ===');
  process.exit(0);
}

ensurePnpm();
if (!pluginsOnly) {
  ensureDsh();
  ensureRipgrepFallback();
} else if (!dshInstalled()) {
  log('FATAL: --plugins-only but dsh not installed yet');
  process.exit(1);
} else {
  ensureRipgrepFallback();
}

// 退役内置插件清理：只认 extra-plugins 同步 marker 记录过的目录（不误伤手动装的插件）。
//
// ⚠ 必须排在 installBuiltins() **之前**（真机实测踩到）：installBuiltins 走的是
// `dsh plugin add`，pnpm 会先解析**整个 profile 的依赖树**。若 profile 里还留着
// 指向已删目录的旧 link:（换名场景必然如此），pnpm 直接报
//   "[WARN] Installing a dependency from a non-existent directory: …/plugins/dsh-po06"
// 并让本次安装失败 —— 表现为新插件装不上（builtin plugins assembled: 2 ok, 1 failed）。
// 先摘掉旧身份、再登记新插件，才是正确的升级顺序。
pruneRetiredBuiltins();
installBuiltins();
// dsh 0.2.0 起新增兼容性前置校验：不满足 dsh-* peer 范围的插件会被运行时**静默禁用**
// （dsh plugin add 照旧成功）。装配后立刻用 dsh 自带的同一函数核对并落盘，
// 把「静默消失」变成日志里一条醒目的 WARN + 插件管理页可见的状态。
await auditBuiltinCompatibility();
// 桥接启动器自管的 files/plugins（可清理旧链接）
linkPluginDeps();
// 桥接 dsh/pnpm 自管的 profile 目录（只补不删）：补上 profile 目录对 dsh 自身
// 包的可见性（此前从该目录解析 @deepseek-ai/dsh-plugin-manager 会 MODULE_NOT_FOUND）。
//
// ⚠ 别把它当成「插件页无可管理 profile」的修复——该缺陷的三轮假设（条目 disabled /
//   导入太慢 / profile 解析不到包）已被真机实验逐条证伪，本函数补上后症状依旧；
//   问题在**挂载层**（条目 id 前缀 include:）而非解析层。详见 deps.mjs 的长注释。
//   保留它是因为它修的是另一个**真实但独立**的解析缺口（幂等、无副作用）。
//
// 必须在 installBuiltins()（即 dsh plugin add）之后执行：pnpm 写入 profile
// node_modules 会晚于我们。
linkProfileDeps();

try {
  writeFileSync(join(DSH_PREFIX, 'dsh-installed.json'), JSON.stringify({
    installedAt: new Date().toISOString(),
    profile: DSH_PROFILE,
    plugins: BUILTIN_PLUGINS,
  }, null, 2));
} catch (e) { log('WARN state file: ' + e.message); }

log('=== official dsh install done ===');
