#!/usr/bin/env node
/**
 * warmup-modules.mjs — 预热 V8 字节码缓存（dsh 启动加速的**缓解**手段）。
 *
 * 为什么需要：真机实测 dsh 的插件树加载是启动耗时大头，冷启动时每个模块都要
 * 重新解析+编译；而 dsh 的启动审计在插件树挂载后立刻快照，个别大包（如
 * @deepseek-ai/dsh-plugin-manager，实测单包导入 1.1~2.0s）会来不及建立 fiber，
 * 被判为 "failed to import" —— 后者会让 pluginManager 服务缺失，插件页于是报
 * 「本部署没有可管理的 profile」。本脚本先把整棵树的字节码写进 NODE_COMPILE_CACHE，
 * 让正式启动时模块加载更快（实测单包约 -21%，整棵树累积更多）。
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
