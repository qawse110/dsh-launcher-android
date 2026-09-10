#!/usr/bin/env node
/**
 * 资产脚本语法门禁（review-r5）。
 *
 * 背景：stub-dsh.mjs 的补丁载荷此前以 base64 内嵌，静态检查完全看不到内容；
 * 抽为 assets/patched/ 真实文件后，这里对所有引导期脚本做语法门禁——
 * 与参考实现 dsh-mobile-apk 的构建期门禁（elf-check / 挂载集 / 契约检查）同旨：
 * 让「写坏一个上游补丁文件拖死 dsh 启动」这类事故在 CI 就暴露，而不是到设备上。
 *
 * 覆盖：assets/*.mjs（含 stub/install/routing/fs 兼容层）、assets/patched/**（补丁载荷）、
 *       assets/*.sh（bash -n 可用时）。
 * 退出码非 0 = 门禁失败（CI 直接红）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ASSETS = path.join(__dirname, '..', 'app', 'src', 'main', 'assets');

/** 递归收集匹配后缀的文件（跳过目录与二进制资产）。 */
function collect(dir, exts, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { collect(full, exts, out); continue; }
    if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

const failures = [];
let checked = 0;

// —— JS/ESM/CJS：node --check ——
for (const f of collect(ASSETS, ['.mjs', '.cjs', '.js'])) {
  const rel = path.relative(ASSETS, f);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 30000 });
  checked++;
  if (r.status !== 0) {
    failures.push(`${rel}\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  }
}

// —— bash：bash -n（环境无 bash 时跳过，不误判） ——
const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
if (bashProbe.status === 0) {
  for (const f of collect(ASSETS, ['.sh', '.tpl'])) {
    const rel = path.relative(ASSETS, f);
    // .tpl 含 @TOKEN@ 占位符，bash -n 仍可解析（占位符在命令位置会报错，故只做粗略检查）
    if (rel.endsWith('.tpl')) continue;
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8', timeout: 30000 });
    checked++;
    if (r.status !== 0) failures.push(`${rel}\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  }
} else {
  console.log('skip: bash not available');
}

// —— 载荷存在性：stub 引用的 patched/ 载荷必须都存在 ——
const stubPath = path.join(ASSETS, 'stub-dsh.mjs');
if (fs.existsSync(stubPath)) {
  const stub = fs.readFileSync(stubPath, 'utf8');
  const refs = [
    ...stub.matchAll(/readPatch\(['"]([^'"]+)['"]\)/g),
    ...stub.matchAll(/overlayPatch\(['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  for (const name of new Set(refs)) {
    const p = path.join(ASSETS, 'patched', name);
    checked++;
    if (!fs.existsSync(p)) failures.push(`patched/${name} 被 stub 引用但文件缺失`);
  }
  console.log(`stub 引用载荷 ${new Set(refs).size} 个，均需存在于 assets/patched/`);
}

console.log(`checked ${checked} file(s)`);
if (failures.length) {
  console.error(`\nASSET SCRIPT GATE FAILED (${failures.length}):\n`);
  for (const f of failures) console.error('- ' + f + '\n');
  process.exit(1);
}
console.log('ASSET SCRIPT GATE PASSED');
