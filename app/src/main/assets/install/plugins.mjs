/**
 * install/plugins.mjs — **内置插件**的装配（官方 dsh plugin add 供给链）。
 *
 * 职责边界：读清单 → 同步插件源 → 摘除退役身份 → 逐个装配 → 清理 profile patch 冗余。
 * 不负责 dsh 本体安装（见 dsh.mjs），也不负责 node_modules 依赖桥接（见 deps.mjs）。
 */
import { existsSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HOME, FILES_DIR, NODE_BIN, DSH_PREFIX, DSH_PROFILE, DSH_APK_VER, PLUGINS_DIR, EXTRA_PLUGINS_SRC,
  PLUGIN_TIMEOUT_MS,
  log, run, envBase, dshCli, dshInstalled, pinnedDshTag,
} from './env.mjs';

/**
 * 内置插件清单 —— **单一真源**，来自 assets/plugin-manifest.json。
 *
 * 为什么改成读清单：此前装配清单在本文件里硬编码了三份（目录名/包名/patch id），
 * Kotlin 侧 PluginManagerActivity 又各自硬编码三份，六份表手工同步、无任何校验——
 * 改一个插件要动六处，漏一处就静默不一致（真机表现为「插件管理页显示的」与
 * 「实际装配的」对不上）。现在两侧都从同一份 JSON 派生，装配面与展示面不可能再漂移。
 *
 * builtin = 随 APK 装配的插件；optional = 随 APK 分发但**默认不装配**的插件
 * （源码保留在 assets/optional-plugins/，用户可在插件管理页按需装配）。
 */
function loadManifest() {
  const file = join(EXTRA_PLUGINS_SRC, '..', 'plugin-manifest.json');
  const fallback = join(FILES_DIR, 'plugin-manifest.json');
  for (const p of [file, fallback]) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(m.builtin) && m.builtin.length) return m;
    } catch {}
  }
  return { builtin: [], optional: [] };
}
const MANIFEST = loadManifest();
/** 装配目录名（assets/extra-plugins 与 files/plugins 下的目录名）。 */
const BUILTIN_PLUGINS = MANIFEST.builtin.map((p) => p.dir);
/** package.json 的 name：cleanBuiltinPatch 匹配 profile patch 的 name: 行。 */
const BUILTIN_NAMES = new Set(MANIFEST.builtin.map((p) => p.name));
/** cordis.patch.yml 的 insert id：cleanBuiltinPatch 匹配 patch 的 - id: 行。 */
const BUILTIN_IDS = new Set(MANIFEST.builtin.map((p) => p.id));

/* ---------------------------------------------------------------------------
 * 已移除：prebuilt.tgz 解包供给链（untarWithPrefix / contentFingerprint / extractPlugins）
 *
 * 历史：内置插件有**两条**供给链——assets/extra-plugins/（AssetManager 直拷）与
 * prebuilt.tgz 内的 third_party/（自实现 ustar 解包）。两条链各自有同步标记、
 * 各自有指纹判据，审计必须同时覆盖；真机事故正是「只审了一条」导致 dsh-vision
 * 的源码问题长期漏网（见 docs/plugin-conversion-audit.md §7.9）。
 *
 * 本次重构后，全部内置插件统一放在 assets/extra-plugins/ 下，走同一条
 * 「AssetManager 直拷 + syncExtraPlugin 整目录替换」通道，prebuilt.tgz 不再需要，
 * 故整条解包链一并删除。收益：
 *   1) 单一供给链——不再存在「审了一条漏另一条」的结构性盲区；
 *   2) 少一个 1.7MB 的 LFS 二进制与一套自实现 tar 解析器；
 *   3) 插件改动不再需要重新打包 tgz 并推 LFS 对象。
 * ------------------------------------------------------------------------- */

function dshPlugin(args) {
  if (!dshInstalled()) {
    log('dsh not installed at ' + dshCli());
    return false;
  }
  return run(NODE_BIN, [dshCli(), 'plugin', '--profile', DSH_PROFILE, ...args], { env: envBase(), timeoutMs: PLUGIN_TIMEOUT_MS });
}

function pkgVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

function profileDeps() {
  try {
    const pkg = JSON.parse(readFileSync(join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'package.json'), 'utf8'));
    return pkg.dependencies || {};
  } catch { return {}; }
}

function profileBundles() {
  try {
    const pkg = JSON.parse(readFileSync(join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'package.json'), 'utf8'));
    const b = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    return Array.isArray(b) ? b : [];
  } catch { return []; }
}

function removeProfileDep(name) {
  const file = join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies[name];
    const b = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(b)) {
      const i = b.indexOf(name);
      if (i >= 0) b.splice(i, 1);
    }
    writeFileSync(file, JSON.stringify(pkg, void 0, 2) + '\n');
  } catch (e) { log('WARN removeProfileDep: ' + e.message); }
}

const EXTRA_SYNC_MARKER = join(FILES_DIR, '.extra-plugins-synced.json');
function readSyncMarker() {
  try { return JSON.parse(readFileSync(EXTRA_SYNC_MARKER, 'utf8')); } catch { return {}; }
}
/** 目录内容聚合指纹：递归每个文件取 fnv1a(相对路径+长度+头 64KB 采样) 后再聚合。
 *  覆盖「版本号没 bump 但内容变了」与同 versionCode 换包两种场景。 */
function dirFingerprint(dir) {
  let h = 0x811c9dc5;
  const update = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const walk = (d, rel) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(join(d, e.name), r); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = readFileSync(join(d, e.name));
        update(r + ':' + contentFingerprint(buf));
      } catch {}
    }
  };
  walk(dir, '');
  return h.toString(16);
}

function syncExtraPlugin(dir, dest) {
  const src = join(EXTRA_PLUGINS_SRC, dir);
  if (!existsSync(join(src, 'package.json'))) return false;
  const srcVer = pkgVersion(src);
  const sig = srcVer + '@apk:' + (DSH_APK_VER || '0') + '/' + dirFingerprint(src);
  const markers = readSyncMarker();
  if (markers[dir] === sig && existsSync(join(dest, 'package.json'))) return false;
  const dstVer = pkgVersion(dest);
  try {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, force: true });
    markers[dir] = sig;
    try { writeFileSync(EXTRA_SYNC_MARKER, JSON.stringify(markers)); } catch {}
    log(`extra plugin ${dir} synced: ${dstVer || 'absent'} -> ${srcVer} (apk ${DSH_APK_VER || '0'})`);
    return true;
  } catch (e) {
    log(`WARN sync extra plugin ${dir}: ${e.message}`);
    return false;
  }
}

function addLocalPlugin(dir) {
  const p = join(PLUGINS_DIR, dir);
  // 1) APK 内置源同步（版本变化才覆盖）
  syncExtraPlugin(dir, p);
  if (!existsSync(join(p, 'package.json'))) {
    log(`skip builtin plugin ${dir}: not bundled`);
    return false;
  }
  // 2) 幂等跳过：profile 已按 link: 登记同一路径**且已列进 bundles** → 无需再跑
  //    dsh plugin add（每次安装逐个起 CLI 很慢；profile 重置后登记消失会自动重装）。
  //
  // ⚠ 判据**必须同时看 bundles**（真机实测踩到）：dsh 只有把包名列进
  //    `dsh.profile.bundles` 才会读它的 cordis.patch.yml、把 entry 插进条目表。
  //    换名/换目录的升级场景里，dependencies 可能已经是新 link、而 bundles 里
  //    旧的包名已被 prune 掉 —— 只看 dependencies 就会「跳过 add」，
  //    结果是**登记了却永不装配**（dump-config 里 0 命中，插件静默消失）。
  const link = 'link:' + p;
  const deps = profileDeps();
  const wired = Object.entries(deps).find(([, v]) => v === link);
  if (wired) {
    const bundles = profileBundles();
    if (bundles.includes(wired[0])) {
      log(`plugin ${dir} already wired, skip add`);
      return true;
    }
    // 有依赖登记但缺 bundle 层：先摘掉旧登记，让下面的 dsh plugin add 重新写全
    log(`plugin ${dir} wired but missing from bundles, re-adding`);
    removeProfileDep(wired[0]);
  }
  log(`dsh plugin add ${dir}`);
  return dshPlugin(['add', p]);
}

function installBuiltins() {
  let ok = 0, fail = 0;
  for (const d of BUILTIN_PLUGINS) {
    if (addLocalPlugin(d)) ok++; else fail++;
  }
  log(`builtin plugins assembled: ${ok} ok, ${fail} failed / ${BUILTIN_PLUGINS.length} total`);
  cleanBuiltinPatch();
}

/* ---------------------------------------------------------------------------
 * 兼容性审计 —— dsh 0.2.0 起新增的**装配契约**，必须显式核对
 *
 * 0.2.0 的 app-boot 多了一道前置校验（compatibility-preflight）：
 *   evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)
 * 它把插件 package.json 里**每个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer
 * 范围拿去比对运行时版本（预发布版参与范围比较），任一不满足即判该插件不兼容；
 * 随后 prepareProfileEntries「只对不兼容冲突禁用行」——**该插件行会被静默标 disabled**，
 * `dsh plugin add` 照旧成功，但插件在运行时根本不激活。
 *
 * 这对启动器是**静默失败**：装配日志一切正常、插件却不见了。更糟的是它极易在
 * 「只把 dsh-pin.json 的 tag 调大、忘了同步插件 peer 范围」时发生——那正是升级时的
 * 典型疏忽。故这里在装配后立刻用 **dsh 自带的那个函数**核对一遍：
 *   · 判定逻辑与运行时**完全同源**（不自己重写 semver，避免判定漂移）；
 *   · 结果写 files/plugin-status.json，供插件管理页展示；
 *   · 不兼容时打醒目 WARN，把「静默消失」变成「一眼可见」。
 *
 * 刻意**不自动**调用 `dsh plugin allow-version` 豁免：dsh 对此的告警是
 * 「可能弄坏应用或损坏数据」，那是需要人知晓的风险决定，不该由安装脚本代按。
 * ------------------------------------------------------------------------- */

/** 载入 dsh 自带的兼容性判定；旧版 dsh（无此导出）返回 null，审计自动跳过。 */
async function loadCompatEvaluator() {
  const entry = join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  if (!existsSync(entry)) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    return typeof mod.evaluatePluginCompatibility === 'function' ? mod.evaluatePluginCompatibility : null;
  } catch (e) {
    log('WARN compat evaluator load failed: ' + e.message);
    return null;
  }
}

/** 审计内置插件对**钉死版 dsh** 的兼容性，并落盘状态供 UI 读取。 */
async function auditBuiltinCompatibility() {
  const evaluate = await loadCompatEvaluator();
  if (!evaluate) {
    log('compat audit: skipped (该 dsh 版本无 evaluatePluginCompatibility，属 0.2.0 之前的契约)');
    return;
  }
  const runtime = pinnedDshTag();
  const report = { dsh: runtime, checkedAt: new Date().toISOString(), plugins: [] };
  let bad = 0;
  for (const d of BUILTIN_PLUGINS) {
    const pj = join(PLUGINS_DIR, d, 'package.json');
    let manifest;
    try { manifest = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
    let issue;
    try {
      issue = evaluate(manifest, void 0, runtime);
    } catch (e) {
      issue = { peers: { '(evaluate threw)': e.message } };
    }
    const compatible = issue === void 0;
    if (!compatible) bad++;
    report.plugins.push({
      dir: d,
      name: manifest.name,
      version: manifest.version,
      compatible,
      peers: compatible ? void 0 : issue.peers,
    });
    if (!compatible) {
      log(`WARN plugin ${d} 对 dsh ${runtime} **不兼容** → dsh 会在运行时禁用该行；`
        + `不满足的 peer: ${JSON.stringify(issue.peers)}；`
        + `修法：同步该插件 package.json 的 dsh-* peer 范围，或（需人工确认风险）`
        + `dsh plugin --profile ${DSH_PROFILE} allow-version <name>@<version> --dsh-version ${runtime} --accept-risk`);
    }
  }
  log(`compat audit: ${report.plugins.length - bad} compatible, ${bad} incompatible / ${report.plugins.length} total (dsh ${runtime})`);
  try {
    writeFileSync(join(FILES_DIR, 'plugin-status.json'), JSON.stringify(report, void 0, 2) + '\n');
  } catch (e) { log('WARN plugin-status write: ' + e.message); }
}

function pruneRetiredBuiltins() {
  const profilePkgFile = join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'package.json');
  if (!existsSync(profilePkgFile)) return;
  const markers = readSyncMarker();
  const keep = new Set(BUILTIN_PLUGINS);
  const retiredDirs = Object.keys(markers).filter((d) => !keep.has(d));
  if (!retiredDirs.length) return;
  try {
    const pkg = JSON.parse(readFileSync(profilePkgFile, 'utf8'));
    const deps = pkg.dependencies || {};
    const profile = (pkg.dsh && pkg.dsh.profile) || {};
    const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
    const linkPrefix = 'link:' + join(FILES_DIR, 'plugins') + '/';
    let pruned = 0;
    for (const dir of retiredDirs) {
      // 1) 目录本身
      const dirAbs = join(FILES_DIR, 'plugins', dir);
      const existed = existsSync(dirAbs);
      rmSync(dirAbs, { recursive: true, force: true });
      // 2) profile 里指向该目录的 link: 依赖 + 对应的 bundles 包名
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string' || !spec.startsWith(linkPrefix)) continue;
        if (spec.slice(linkPrefix.length).replace(/\/+$/, '') !== dir) continue;
        delete deps[name];
        const i = bundles.indexOf(name);
        if (i >= 0) bundles.splice(i, 1);
        rmSync(join(FILES_DIR, 'plugins/node_modules', ...name.split('/')), { recursive: true, force: true });
        pruned++;
      }
      delete markers[dir];
      if (existed) log(`retired builtin pruned: ${dir}`);
    }
    pkg.dependencies = deps;
    if (pkg.dsh && pkg.dsh.profile) pkg.dsh.profile.bundles = bundles;
    writeFileSync(profilePkgFile, JSON.stringify(pkg, void 0, 2) + '\n');
    writeFileSync(EXTRA_SYNC_MARKER, JSON.stringify(markers));
    if (pruned) log(`retired builtin deps unregistered: ${pruned}`);
  } catch (e) {
    log('WARN pruneRetiredBuiltins: ' + e.message);
  }
}

function cleanBuiltinPatch() {
  const patch = join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'cordis.patch.yml');
  if (!existsSync(patch)) return;
  try {
    const lines = readFileSync(patch, 'utf8').split(/\r?\n/);
    const out = [];
    let block = null;
    let keep = true;
    const flush = () => {
      if (block && keep) out.push(...block);
      block = null;
      keep = true;
    };
    for (const line of lines) {
      if (/^\s*- insert:\s*$/.test(line)) {
        flush();
        block = [line];
        keep = true;
      } else if (block) {
        const idMatch = line.match(/^\s*- id:\s*(\S+)\s*$/);
        const nameMatch = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/);
        if (idMatch && BUILTIN_IDS.has(idMatch[1])) keep = false;
        if (nameMatch && BUILTIN_NAMES.has(nameMatch[1].trim())) keep = false;
        block.push(line);
      } else {
        out.push(line);
      }
    }
    flush();
    const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // 语义：把内置插件的 insert 块摘掉后，**只在文件已无任何条目时**补 `[]`，
    // 否则原样写回。
    //
    // 曾经的判据是「正文里不含 `[]` 且不含 `- insert:` 就追加 `[]`」，这会把
    // **已有其它条目**的 profile patch 拼成「一个数组 + 一个 []」的两个 YAML 文档，
    // dsh 启动时直接解析失败（真机实测报 YAMLException: end of the stream or a
    // document separator is expected）。判据改为只看「清理后是否为空」。
    const hasEntry = cleaned.split('\n').some((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('#');
    });
    writeFileSync(patch, hasEntry ? cleaned + '\n' : '[]\n');
    log('builtin patch entries cleaned (profile patch dedupe)');
  } catch (e) {
    log('WARN cleanBuiltinPatch: ' + e.message);
  }
}

// 只导出编排层真正调用的四个。其余（loadManifest / dshPlugin / cleanBuiltinPatch /
// syncExtraPlugin / profileDeps / profileBundles / removeProfileDep / MANIFEST /
// BUILTIN_NAMES / BUILTIN_IDS / loadCompatEvaluator）都是本模块内部实现细节。
export {
  BUILTIN_PLUGINS,
  installBuiltins, pruneRetiredBuiltins,
  auditBuiltinCompatibility,
};
