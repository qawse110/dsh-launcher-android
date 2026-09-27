#!/usr/bin/env node
/**
 * warmup-modules.mjs — 预热 V8 字节码缓存（dsh 启动加速的**缓解**手段）。
 *
 * 定位说明（**勿把成因写错**）：本脚本最初是为「插件页报『本部署没有可管理的
 * profile』」做的启动器侧缓解，当时假设成因是「大包导入慢、启动审计抢在 fiber
 * 之前快照」。**该假设已被真机插桩实测证伪**：预热 14MB 字节码缓存后症状分毫不动。
 *
 * 插桩给出的真实成因（entry.fiber === undefined 的那一条）：
 *   id=include:plugin-manager  disabled=false  hasProfileContext=true
 *   baseUrl=file:///…/files/.dsh/profiles/web/
 * 即条目**已启用**，但它的模块解析基准是 **profile 目录**，而 profile 的
 * node_modules 里没有 dsh 自身的包（@deepseek-ai/dsh-plugin-manager 从该目录解析
 * 返回 MODULE_NOT_FOUND）→ 无法 import → fiber 永不创建 → 被记为 failed to import
 * → pluginManager 服务缺失 → host-plugin-inventory 不置 managementAvailable
 * → 插件页显示 unavailable。**与导入速度无关**，属 profile 依赖可见性问题。
 *
 * 因此本脚本**不是**该缺陷的修复，它只做一件事：把整棵插件树的字节码写进
 * NODE_COMPILE_CACHE，降低模块加载/编译开销（实测单包约 -21%）。
 *
 * 设计要点（避免硬编码、避免绕过式补丁）：
 *   · 要预热哪些模块**不硬编码**：直接取 `dsh --profile <p> --dump-config` 输出的
 *     loader 条目 name 列表，即 dsh 自己声明会加载的那批；
 *   · 预热失败**不算错**：某个模块 import 失败只记一行日志（正式启动会给出真正的
 *     诊断），本脚本只负责把能编译的先编译掉，绝不改变部署状态；
 *   · 幂等由调用方（DshFlow）用 marker 保证，本脚本自身不做状态写入。
 *
 * 环境变量：HOME / DSH_CLI / DSH_PROFILE / DSH_WARMUP_QUIET
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.HOME || '';
const CLI = process.env.DSH_CLI || '';
const PROFILE = process.env.DSH_PROFILE || 'web';
const QUIET = process.env.DSH_WARMUP_QUIET === '1';

function log(m) { if (!QUIET) console.log('[warmup] ' + m); }

if (!CLI || !existsSync(CLI)) {
  log('DSH_CLI missing, skip');
  process.exit(0);
}

// 1) 取 loader 条目名（dsh 自己声明会加载的模块）
let entryNames = [];
try {
  const r = spawnSync(process.execPath, [
    '--expose-internals',
    '--import', HOME + '/fs-register.mjs',
    CLI, '--profile', PROFILE, '--dump-config',
  ], { encoding: 'utf8', timeout: 120000, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:-\s*)?name:\s*['"]([^'"]+)['"]\s*$/);
    if (m) entryNames.push(m[1]);
  }
} catch (e) {
  log('dump-config failed: ' + e.message + ' (skip warmup)');
  process.exit(0);
}

entryNames = [...new Set(entryNames)];
log('entries from dump-config: ' + entryNames.length);
if (entryNames.length === 0) { log('no entries parsed, skip'); process.exit(0); }

// 2) 逐个 import，只为写入编译缓存；失败只记日志
//
// 解析基准：脚本自身在 HOME 根下，裸包名（@deepseek-ai/*）从那里解析不到。
// plugins/node_modules 是启动器桥接 dsh-prefix 依赖的目录（linkPluginDeps 产物），
// 从那里 createRequire 才能解析到 dsh 的全部包 —— 与运行时插件加载同源。
const req = createRequire(join(HOME, 'plugins', 'noop.cjs'));
let ok = 0, failed = 0;
const failSamples = [];
for (const name of entryNames) {
  try {
    let spec;
    try { spec = req.resolve(name); } catch { spec = name; }
    await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec);
    ok++;
  } catch (e) {
    failed++;
    if (failSamples.length < 3) failSamples.push(name + ':' + (e.code || e.message));
  }
}
log('warmed: ' + ok + ' ok, ' + failed + ' failed (failures are non-fatal)');
if (failSamples.length) log('sample failures: ' + failSamples.join(' | '));
