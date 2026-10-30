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
 *   5. 同一 dir/name/id 不重复；
 *   6. 可选字段 npm（插件「在线升级」的渠道声明）格式合法且不重复。
 *      这一项**不联网**，只校验形状：写错一个字符（scope 少了 @、大小写、
 *      空格）不会让构建失败，只会让插件管理页的「在线升级」永久 404 —— 属于
 *      静默失效，所以必须在离线门禁里拦。是否真的存在于 registry 只能靠联网，
 *      不在 CI 里做（见 docs/update-check-log.md 的在线升级一节）。
 *   7. 可选字段 npmTrimmed 只能在 npm 存在时出现，且必须是 true/false。
 *      它标记「本仓副本是上游包的裁剪版」：在线升级会用上游完整包覆盖，只做加法
 *      （补回 sourcemap / .d.ts / 文档 / 非本宿主适配层），体积变大但功能不变。
 *      究竟是不是裁剪版只能联网比对，这里只管形状（见
 *      tools/verify-plugin-npm-source.mjs 的「裁剪版」判定）。
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

/**
 * npm 包名形状（在线升级渠道声明用）。
 *
 * 故意与 npm 的 validate-npm-package-name 保持同等宽度的保守子集：
 * 允许 scope、小写字母数字、- . _ ~，不允许大写、空格、前导点、超长（214 上限这里不查）。
 * 真实的 registry 存在性不在这里判断。
 */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const seenDir = new Map(), seenName = new Map(), seenId = new Map(), seenNpm = new Map();
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
    // 补丁层文件的位置与文件名都**以 package.json 的声明为准**，dsh 本身就是这么解析的
    // （app-boot：`const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch`，
    // 读的是 `dsh.bundle.patch`，文件名不参与判断）。因此这里按以下优先级解析：
    //   a. `dsh.bundle.patch` —— dsh 现代布局的主声明（billion-context 等上游即用此字段，
    //      文件名可叫 dsh.bundle.patch.yml 而非 cordis.patch.yml）；
    //   b. `exports["./cordis.patch.yml"]` —— 上游 0.6+ 把插件代码移入子目录（po06/）时
    //      随之声明的路径（`"./po06/cordis.patch.yml"`）；
    //   c. 根目录 cordis.patch.yml —— 兼容未做任何声明的旧版布局。
    // 早先这里硬编码根目录，遇到 a/b 两种布局都误报「缺少 cordis.patch.yml」。
    let patch = null;
    const declaredBundle = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    const bundleRel = typeof declaredBundle === 'string' ? declaredBundle
      : Array.isArray(declaredBundle) ? declaredBundle[0] : null;
    if (typeof bundleRel === 'string') patch = join(dirAbs, bundleRel);
    if (!patch || !existsSync(patch)) {
      const declared = pkg.exports && pkg.exports['./cordis.patch.yml'];
      const rel = typeof declared === 'string'
        ? declared
        : declared && (declared.default || declared.import || declared.require);
      if (typeof rel === 'string') patch = join(dirAbs, rel);
    }
    if (!patch || !existsSync(patch)) patch = join(dirAbs, 'cordis.patch.yml');
    if (!existsSync(patch)) fail(`${where}: 缺少补丁层文件（dsh.bundle.patch / exports["./cordis.patch.yml"] / cordis.patch.yml 均未命中）`);
    else {
      const ids = patchIds(patch);
      if (!ids.includes(row.id)) fail(`${where}: id 不一致 —— 清单=${row.id}, ${patch.split('/').pop()}=[${ids.join(', ')}]`);
    }
    // 6. npm 渠道声明（可选字段）：形状合法 + 不重复
    //    「在线升级」只认这个字段（Kotlin 与 plugin-upgrade.mjs 两侧都按它筛条目），
    //    写错就等于该插件永久没有升级入口，且不会有任何报错。所以在这里拦形状。
    let npmName = null;
    if (row.npm !== undefined) {
      if (typeof row.npm !== 'string' || !row.npm.trim()) {
        fail(`${where}: npm 字段必须是非空字符串（不用的条目请完全省略该字段）`);
      } else {
        npmName = row.npm.trim();
        if (npmName !== row.npm) fail(`${where}: npm 字段不能带首尾空格（${JSON.stringify(row.npm)}）`);
        if (!NPM_NAME_RE.test(npmName)) fail(`${where}: npm 字段不是合法的 npm 包名（${JSON.stringify(npmName)}）`);
      }
    }
    // 7. npmTrimmed 只能伴随 npm 出现，且必须是布尔值
    if (row.npmTrimmed !== undefined) {
      if (row.npm === undefined) {
        fail(`${where}: npmTrimmed 只能与 npm 一起出现（该条没有 npm 渠道，裁剪标记无意义）`);
      } else if (typeof row.npmTrimmed !== 'boolean') {
        fail(`${where}: npmTrimmed 必须是 true/false（当前 ${JSON.stringify(row.npmTrimmed)}）`);
      }
    }
    // 5. 唯一性
    for (const [map, key, label] of [[seenDir, row.dir, 'dir'], [seenName, row.name, 'name'], [seenId, row.id, 'id']]) {
      if (map.has(key)) fail(`${where}: ${label} 重复（已出现在 ${map.get(key)}）`);
      else map.set(key, where);
    }
    // npm 渠道同样必须唯一：两条清单指向同一个包，在线升级会互相覆盖对方的副本
    if (npmName) {
      if (seenNpm.has(npmName)) fail(`${where}: npm 渠道重复（${npmName} 已出现在 ${seenNpm.get(npmName)}）`);
      else seenNpm.set(npmName, where);
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
