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
  BUILTIN_PLUGINS, installBuiltins, pruneRetiredBuiltins,
} from './install/plugins.mjs';
import {
  linkPluginDeps, linkProfileDeps,
} from './install/deps.mjs';

// ── main ─────────────────────────────────────────────
log('=== official dsh install start ===');
log('HOME=' + HOME + ' DSH_PREFIX=' + DSH_PREFIX + ' PROFILE=' + DSH_PROFILE);
try { mkdirSync(join(FILES_DIR, 'tmp'), { recursive: true }); } catch {}

const pluginsOnly = process.argv.includes('--plugins-only');

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
// 桥接启动器自管的 files/plugins（可清理旧链接）
linkPluginDeps();
// 桥接 dsh/pnpm 自管的 profile 目录（只补不删）——dsh 的 loader 以 profile 目录为
// 模块解析基准，缺这一步则 dsh 自身的条目（plugin-manager / hmr 等）解析不到，
// 表现为插件页「本部署没有可管理的 profile」。必须在 installBuiltins()（即
// dsh plugin add）之后执行：pnpm 写入 profile node_modules 会晚于我们。
linkProfileDeps();

try {
  writeFileSync(join(DSH_PREFIX, 'dsh-installed.json'), JSON.stringify({
    installedAt: new Date().toISOString(),
    profile: DSH_PROFILE,
    plugins: BUILTIN_PLUGINS,
  }, null, 2));
} catch (e) { log('WARN state file: ' + e.message); }

log('=== official dsh install done ===');
