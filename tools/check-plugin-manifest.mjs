#!/usr/bin/env node
/**
 * check-plugin-manifest.mjs — 内置插件清单一致性门禁（CI 用，零依赖）。
 *
 * 为什么需要它：本次重构前，内置插件清单在 **六个地方**各自硬编码
 * （install-dsh.mjs 的 BUILTIN_PLUGINS/BUILTIN_NAMES/BUILTIN_IDS 三张表 +
 * PluginManagerActivity.kt 的 BUNDLED/BUNDLED_DESC 两张表 + README），
 * 两侧没有任何自动校验。真机事故：插件管理页显示的与实际装配的对不上，
 * 且「审了一条供给链漏了另一条」长期无人发现（见 docs/plugin-conversion-audit.md §7.9）。
 *
 * 现在清单唯一真源是 app/src/main/assets/plugin-manifest.json，本脚本校验
 * 「清单 ↔ 资产目录 ↔ package.json ↔ cordis.patch.yml」四者严格对齐。
 *
 * 校验项：
 *   1. builtin/optional 条目的 dir 在对应资产目录下存在，且含 package.json；
 *   2. 条目的 name 与 package.json 的 name 一致；
 *   3. 条目的 id 与 cordis.patch.yml 里 insert 行的 id 一致；
 *   4. extra-plugins/ 下没有「未登记」的多余目录（防止加了插件忘登记）；
 *   5. 同一 dir/name/id 不重复。
 *
 * 用法：node tools/check-plugin-manifest.mjs
 * 退出码：0 = 通过，1 = 有不一致（打印全部问题）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'app/src/main/assets');
const MANIFEST = join(ASSETS, 'plugin-manifest.json');
const problems = [];
const fail = (m) => problems.push(m);

if (!existsSync(MANIFEST)) {
  console.error('FATAL: 缺少 ' + MANIFEST);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** 解析 cordis.patch.yml 里的 insert id（不引入 YAML 依赖，按行匹配即可）。 */
function patchIds(file) {
  const ids = [];
  let inInsert = false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s*insert:\s*$/.test(line)) { inInsert = true; continue; }
    // 先匹配 id 行、再判「新条目」："- id: x" 本身也以 "- " 开头，
    // 顺序反了会把每个 id 行自己重置掉（实测踩过）。
    const m = line.match(/^-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (m) { if (inInsert) ids.push(m[1]); continue; }
    if (/^-\s/.test(line)) { inInsert = false; }
  }
  return ids;
}

const seenDir = new Map(), seenName = new Map(), seenId = new Map();
for (const section of ['builtin', 'optional']) {
  const rows = manifest[section];
  if (!Array.isArray(rows)) { fail(`清单缺少 ${section} 数组`); continue; }
  const assetDir = section === 'builtin' ? 'extra-plugins' : 'optional-plugins';
  for (const row of rows) {
    const where = `${section}/${row.dir || '(无 dir)'}`;
    for (const field of ['dir', 'name', 'id']) {
      if (!row[field] || typeof row[field] !== 'string') fail(`${where}: 缺少字段 ${field}`);
    }
    if (!row.dir) continue;
    // 1. 目录 + package.json
    const dirAbs = join(ASSETS, assetDir, row.dir);
    if (!existsSync(dirAbs)) { fail(`${where}: 资产目录不存在 (${assetDir}/${row.dir})`); continue; }
    const pkgFile = join(dirAbs, 'package.json');
    if (!existsSync(pkgFile)) { fail(`${where}: 缺少 package.json`); continue; }
    // 2. name 对齐
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); }
    catch (e) { fail(`${where}: package.json 解析失败: ${e.message}`); continue; }
    if (pkg.name !== row.name) fail(`${where}: name 不一致 —— 清单=${row.name}, package.json=${pkg.name}`);
    // 3. id 对齐
    const patch = join(dirAbs, 'cordis.patch.yml');
    if (!existsSync(patch)) fail(`${where}: 缺少 cordis.patch.yml`);
    else {
      const ids = patchIds(patch);
      if (!ids.includes(row.id)) fail(`${where}: id 不一致 —— 清单=${row.id}, cordis.patch.yml=[${ids.join(', ')}]`);
    }
    // 5. 唯一性
    for (const [map, key, label] of [[seenDir, row.dir, 'dir'], [seenName, row.name, 'name'], [seenId, row.id, 'id']]) {
      if (map.has(key)) fail(`${where}: ${label} 重复（已出现在 ${map.get(key)}）`);
      else map.set(key, where);
    }
  }
  // 4. 反向检查：资产目录里没有未登记的插件
  const dirRoot = join(ASSETS, assetDir);
  if (existsSync(dirRoot)) {
    const registered = new Set(rows.map((r) => r.dir));
    for (const ent of readdirSync(dirRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (!registered.has(ent.name)) fail(`${assetDir}/${ent.name}: 目录存在但未登记进清单 ${section}`);
    }
  }
}

if (problems.length) {
  console.error('✗ 插件清单一致性校验失败（' + problems.length + ' 项）：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✓ 插件清单一致性校验通过：builtin=' + manifest.builtin.length +
  '，optional=' + manifest.optional.length);
