#!/usr/bin/env node
/**
 * stub-dsh.mjs — Android 兼容性修复（dsh 官方 npm 安装版）。
 *
 * 旧版同时负责“插件装配 + 启动 web”；新版 dsh 本体与插件都改用官方
 * npm / `dsh plugin` 安装，这里只保留 Android 特有修复。
 *
 * 原则：**只修 Node/原生模块加载期与 WebView 引导期的问题**——凡是能在
 * Cordis 插件运行时实现的功能一律下沉为独立内置插件（见
 * docs/plugin-conversion-audit.md），避免每次 dsh 升级都要重新对表补锚点。
 *
 * 现存修复：**14 个补丁区域** = 13 个顶层 try 块 + 1 个缩进块（attachment-local 视觉链路，
 * 历史原因写在 sharp 块之后、未提升缩进）。每个补丁块的注释都标注了「已针对
 * 0.1.7-rc.2 核实」的锚点状态（命中数 / 未命中原因 / 与版本无关）：
 *   1) koffi / node-pty / sharp：Android 无预编译产物，用 Proxy stub / 纯 JS
 *      shim 顶替（模块 import 期，插件通道无法介入）。**与 dsh 版本无关，锚点不适用**；
 *   2) @deepseek-ai/dsh-attachment-local 视觉链路 v5：SELinux 禁 link(2)（实测应用
 *      私有存储上同为 EACCES，非仅 sdcard）、FUSE 上 fsync 失败的运行时行为修复
 *      （fs 兼容层不覆盖 CJS 盲区，只能改源）。v5 起 link 调用点改为**扫描式**改写，
 *      不再锚定单一字面量——上游 0.1.5 把发布链路重构成 publishStagedObject /
 *      publishImmutableAlias 两点，v4 的单锚点因此静默失效（无报错、补丁不生效）。
 *      0.1.7-rc.2 实测仍为 2 个扫描命中点，**扫描式实现已兼容，无需改动**；
 *   3) @deepseek-ai/dsh-llm-pi-ai sendAttribution：dsh-provider-headers 内置
 *      插件的「关闭归因 UA」依赖该 schema 字段，上游明确注释
 *      “omission cannot suppress attribution”，在官方提供抑制缝隙前保留。
 *      0.1.7-rc.2 的 schema 声明形式已变（见补丁块注释），锚点已按实测修正；
 *   4) koffi ABI 布局断言禁用（**非防御性，是 boot 硬阻断**）：koffi 被 stub 后
 *      struct().size 恒为 0，而上游在 import 期断言 STARTUPINFOW=104 /
 *      PROCESS_INFORMATION=24 → 抛错使 Cordis 判定整棵插件树 apply 失败，web 起不来。
 *      0.1.5 把断言从 dsh-sandbox-windows-acl **搬到了新包** dsh-win32-process，
 *      故改为按包名清单遍历两包（只扫旧包会 0 命中而 boot 必崩）。
 *      0.1.7-rc.2 实测：dsh-win32-process 命中 2 处、旧包 0 处，**清单式实现已兼容**；
 *   5) WebView/旧 Chrome AbortSignal.timeout polyfill——仅当前端产物确实引用
 *      该 API 时才注入（rc.2 前端与全部内置插件 client 均无引用，自动跳过，
 *      不再无条件改写 dist/index.html；引导期早于 app bundle，插件无法替代）；
 *   6) @vscode/ripgrep 解析器 Android 回退（import 期解析，优先 Termux 原生 rg）；
 *      **与 dsh 版本无关，锚点不适用**；
 *   7) dsh-fs-local chmod 对 FUSE 的 EACCES/EPERM 容错（原子写内部路径，
 *      无插件缝隙）。0.1.7-rc.2 三处锚点全部命中，**保持不动**；
 *   8) **新增** node-addon-require-builtin 纯 JS 顶替（0.1.7 新增的 boot 级硬阻断，
 *      见对应补丁块注释）。
 *
 * 已评估、**无需补丁**（0.1.7 结构性收敛结论，逐条有实测依据）：
 *   - @deepseek-ai/dsh-atomic-write（0.1.7 新包）：只 import node:fs/promises 的
 *     lstat/mkdir/readFile/rename/rm/writeFile + node:crypto，**不调用 chmod**；
 *     权限位经 writeFile({ mode }) 在建 inode 时生效，rename 只换目录项，
 *     二者在 FUSE/SELinux 上都不需要容错（详见文件末尾「atomic-write 评估」注释）；
 *   - @deepseek-ai/dsh-settings 收窄导出面：0.1.7-rc.2 导出仍为
 *     { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets }，
 *     settingsNamespace / installSettingsSection 确实缺失，plugin-compat 补丁仍必要。
 *
 * 已移除（详见审计文档）：
 *   - apiproxy WEB_SETTINGS_NAMESPACES += vision（上游已无该常量，
 *     dsh-vision 改经 settings 服务自行注册命名空间）；
 *   - dsh-sandbox/-local "/tmp"→TMPDIR（上游 writableRoots 已原生并入
 *     os.tmpdir()，启动器导出 TMPDIR 即可）；
 *   - directory-picker-browse SD Card 条目（由内置插件
 *     @dsh-external/dsh-android-links 以 HOME 符号链接实现）。
 *
 * 环境变量：
 *   HOME / NODE_DIR / DSH_PREFIX / DSH_PROFILE
 */
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.HOME || '/data/user/0/com.dsh.nextapp1/files';
const NODE = process.env.NODE_DIR || join(HOME, 'node');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const PROFILE = process.env.DSH_PROFILE || 'web';
const NODE_MODULES = join(DSH_PREFIX, 'node_modules');
const PNPM_DIR = join(NODE_MODULES, '.pnpm');
// 内置插件（prebuilt.tgz 解出的 dsh-vision 等，以及 extra-plugins 同步来的
// dsh-status-bridge 等）安装在 files/plugins/ 下，**不在** dsh-prefix/node_modules 里。
// 历史实现只扫 node_modules，导致这些插件的源码问题完全不在修补范围内——
// 真机事故：codebuddy 修好后 dsh-vision 又炸，同类错误换了个插件。
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(HOME, 'plugins');
const pkgCache = new Map();
let pnpmEntries = null;
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

function log(m) {
  const l = `${new Date().toISOString()} [stub] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { if (process.env.DSH_SHARED_LOG === '1') writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

/** 缓存 .pnpm 目录列表，避免几十次 findPkg 反复 readdirSync 同一个大目录。 */
function getPnpmEntries() {
  if (pnpmEntries !== null) return pnpmEntries;
  try {
    pnpmEntries = readdirSync(PNPM_DIR);
  } catch {
    pnpmEntries = [];
  }
  return pnpmEntries;
}

/** 在 npm 扁平布局或 pnpm .pnpm 布局下定位包内相对路径（带缓存）。 */
function findPkg(pkgName, rel) {
  const key = pkgName + '\u0000' + rel;
  if (pkgCache.has(key)) return pkgCache.get(key);
  const found = findPkgUncached(pkgName, rel);
  pkgCache.set(key, found);
  return found;
}

function findPkgUncached(pkgName, rel) {
  // pnpm v10: node_modules/.pnpm/<name>@<hash>/node_modules/<pkg>/<rel>
  if (existsSync(PNPM_DIR)) {
    const prefix = pkgName.replace('/', '+') + '@';
    for (const d of getPnpmEntries()) {
      if (!d.startsWith(prefix)) continue;
      const p = join(PNPM_DIR, d, 'node_modules', pkgName, rel);
      if (existsSync(p)) return p;
    }
  }
  // npm 扁平布局
  const flat = join(NODE_MODULES, pkgName, rel);
  if (existsSync(flat)) return flat;
  // 依赖可能被嵌套安装（如 @deepseek-ai/dsh-subprocess-local/node_modules/node-pty）
  return findNestedPkg(pkgName, rel);
}

/** 递归查找嵌套 node_modules 中的包（pnpm 之外的 npm 嵌套布局）。 */
function findNestedPkg(pkgName, rel) {
  const found = [];
  function walk(dir, depth) {
    if (depth > 8 || found.length > 0) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules') {
        const candidate = join(full, pkgName, rel);
        if (existsSync(candidate)) { found.push(candidate); return; }
      }
      walk(full, depth + 1);
    }
  }
  walk(NODE_MODULES, 0);
  return found[0] || null;
}

/**
 * 枚举 files/plugins/<dir> 下每个内置插件的入口文件。
 *
 * 为什么需要：内置插件（dsh-vision 等来自 prebuilt.tgz 解包，dsh-status-bridge 等
 * 来自 extra-plugins 同步）都装在 files/plugins/ 下，而 [findPkg] 只扫
 * dsh-prefix/node_modules —— 这些插件的源码补丁长期不在覆盖范围内，
 * 真机表现为「同类错误换一个插件继续炸」（codebuddy 修好后 dsh-vision 又炸）。
 *
 * @returns [{ name, file }]，name 为插件目录名，file 为主要入口（package.json 的
 *   exports/main 首选项，退化到 lib/index.js）。
 */
function eachPluginEntry() {
  const out = [];
  let dirs;
  try { dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const root = join(PLUGINS_DIR, d.name);
    let entry = null;
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const cand = pkg?.exports?.['.']?.default
        ?? (typeof pkg?.exports === 'string' ? pkg.exports : undefined)
        ?? pkg?.main
        ?? 'lib/index.js';
      entry = join(root, typeof cand === 'string' ? cand : 'lib/index.js');
    } catch {
      entry = join(root, 'lib/index.js');
    }
    if (existsSync(entry)) out.push({ name: d.name, file: entry });
  }
  return out;
}

/**
 * 枚举内置插件的 **client 端**文件（files/plugins/<dir>/lib/client.js）。
 *
 * 为什么单独处理：client 端由浏览器侧 `window.__ModuleLoader__.load({ factory: (require) => … })`
 * 加载，其 `require(spec)` 走 client-modules 的**模块表**（种子词 → 已加载 → 已注册工厂），
 * 与 Node 侧解析完全无关 —— 所以 host 端插件树能加载，UI 仍可能报
 * 「Failed to load plugins」。两边必须分别审计。
 */
function eachPluginClientFile() {
  const out = [];
  let dirs;
  try { dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const f = join(PLUGINS_DIR, d.name, 'lib', 'client.js');
    if (existsSync(f)) out.push({ name: d.name, file: f });
  }
  return out;
}

const KSTUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O2V4cG9ydCBkZWZhdWx0IGtvZmZpOw==';
const KCJS = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O21vZHVsZS5leHBvcnRzPWtvZmZpO21vZHVsZS5leHBvcnRzLmRlZmF1bHQ9a29mZmk7';
const PSTUB = 'Y29uc3R7RXZlbnRFbWl0dGVyfT1yZXF1aXJlKCdldmVudHMnKTtjbGFzcyBGIGV4dGVuZHMgRXZlbnRFbWl0dGVye2NvbnN0cnVjdG9yKCl7c3VwZXIoKTt0aGlzLnBpZD0wO3RoaXMuZXhpdENvZGU9MH13cml0ZSgpe31raWxsKCl7fXJlc2l6ZSgpe31jbGVhcigpe31jbG9zZSgpe31vbkV4aXQoYyl7aWYoYyljKHtleGl0Q29kZTowLHNpZ25hbDp1bmRlZmluZWR9KX19bW9kdWxlLmV4cG9ydHM9e3NwYXduKCl7Y29uc3QgeD1uZXcgRigpO3Byb2Nlc3MubmV4dFRpY2soKCk9PnguZW1pdCgnZXhpdCcse2V4aXRDb2RlOjAsc2lnbmFsOnVuZGVmaW5lZH0pKTtyZXR1cm4geH0sZm9yaygpe3JldHVybiBuZXcgRigpfSxvcGVuKCl7cmV0dXJue21hc3RlcjpuZXcgRigpLHNsYXZlOm5ldyBGKCl9fX07';
/* dsh-launcher android stub fix (2026-08-19): the old stub returned itself for
 * every property INCLUDING `then`, which made the proxy accidentally thenable:
 * `await sharp(...)` invoked p.then(resolve,reject), the apply trap swallowed
 * the callbacks, and the promise never settled — dsh-vision / any image
 * attachment path hung the session forever. Now `then/catch/finally` return
 * undefined (await resolves to the proxy), so decode paths fail fast with a
 * normal error instead of hanging. */
const SHARP_STUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO21vZHVsZS5leHBvcnRzPXA7bW9kdWxlLmV4cG9ydHMuZGVmYXVsdD1wOw==';
const SHARP_STUB_ESM = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2V4cG9ydCBkZWZhdWx0IHA7';

/* 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。
 * koffi / node-pty 的入口是整体覆写（不依赖上游任何字面量），只要包还在就被顶替；
 * 0.1.7 安装树中两者仍在（koffi 经 dsh-win32-process、node-pty 经 subprocess 相关包）。
 * 未命中时打 'not found, skip'，可诊断。 */
try {
  const ke = findPkg('koffi', 'index.js');
  if (ke) { writeFileSync(ke, Buffer.from(KSTUB, 'base64')); log('koffi ESM stub ok: ' + ke); }
  const kc = findPkg('koffi', 'index.cjs');
  if (kc) { writeFileSync(kc, Buffer.from(KCJS, 'base64')); log('koffi CJS stub ok: ' + kc); }
  if (!ke && !kc) log('koffi: not found, skip');
} catch (e) { log('WARN koffi: ' + e.message); }

try {
  const p = findPkg('node-pty', 'lib/index.js');
  if (p) { writeFileSync(p, Buffer.from(PSTUB, 'base64')); log('node-pty stub ok: ' + p); }
  else log('node-pty: not found, skip');
} catch (e) { log('WARN node-pty: ' + e.message); }

/* 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。
 * sharp 各入口（dist/index.cjs|mjs、dist/sharp.cjs|mjs、lib/index.js、index.js）
 * 均为整体覆写；0.1.7 侧 sharp 由 dsh-attachment-local 视觉链路引用。
 * 全部 target 未命中时打 'sharp: not found, skip'，可诊断。 */
try {
  /* Android 无 libvips：写入纯 JS 兼容层 _dshshim.cjs（PNG 全解码 + 头部探测），
     各入口改为重定向；替代旧 Proxy 桩（旧桩让所有图片判 INVALID_IMAGE 且
     await 永不结算）。实现与视觉链路修复配套。 */
  const SHIM_B64 = 'J3VzZSBzdHJpY3QnOwovKgogKiBQdXJlLUpTIHNoYXJwIGNvbXBhdGliaWxpdHkgc2hpbSBmb3IgRFNIIG9uIEFuZHJvaWQgKG5vIGxpYnZpcHMgYmluYXJpZXMpLgogKiBDb3ZlcnMgdGhlIEFQSSBzdXJmYWNlIGFjdHVhbGx5IHVzZWQgYnkgQGRlZXBzZWVrLWFpL2RzaC1hdHRhY2htZW50LWxvY2FsOgogKiAgIHNoYXJwKGRhdGEsIHtmYWlsT24sIGxpbWl0SW5wdXRQaXhlbHN9KSAtPiAubWV0YWRhdGEoKSAvIC5yYXcoKS50b0J1ZmZlcigpCiAqIEZ1bGwgZGVjb2RlOiBub24taW50ZXJsYWNlZCBQTkcgKGNvbG9yIHR5cGVzIDAvMi8zLzQvNiwgYml0IGRlcHRocyAxLTE2KS4KICogSGVhZGVyLW9ubHkgbWV0YWRhdGE6IFBORyAvIEpQRUcgLyBHSUYgLyBXZWJQLgogKiBBbnl0aGluZyBub3QgaW1wbGVtZW50ZWQgdGhyb3dzIGEgY2xlYXIgZXJyb3IgaW5zdGVhZCBvZiByZXR1cm5pbmcgYSBQcm94eS4KICovCmNvbnN0IGZzID0gcmVxdWlyZSgiZnMiKTsKY29uc3QgemxpYiA9IHJlcXVpcmUoInpsaWIiKTsKCmNsYXNzIFNoaW1FcnJvciBleHRlbmRzIEVycm9yIHt9CgovKiDilIDilIAgZm9ybWF0IHNuaWZmaW5nIOKUgOKUgCAqLwpmdW5jdGlvbiBzbmlmZihidWYpIHsKICBpZiAoYnVmLmxlbmd0aCA+PSA4ICYmIGJ1ZlswXSA9PT0gMHg4OSAmJiBidWZbMV0gPT09IDB4NTAgJiYgYnVmWzJdID09PSAweDRlICYmIGJ1ZlszXSA9PT0gMHg0NykgcmV0dXJuICJwbmciOwogIGlmIChidWYubGVuZ3RoID49IDMgJiYgYnVmWzBdID09PSAweGZmICYmIGJ1ZlsxXSA9PT0gMHhkOCAmJiBidWZbMl0gPT09IDB4ZmYpIHJldHVybiAianBlZyI7CiAgaWYgKGJ1Zi5sZW5ndGggPj0gNiAmJiBidWYudG9TdHJpbmcoImxhdGluMSIsIDAsIDMpID09PSAiR0lGIikgcmV0dXJuICJnaWYiOwogIGlmIChidWYubGVuZ3RoID49IDEyICYmIGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMCwgNCkgPT09ICJSSUZGIiAmJiBidWYudG9TdHJpbmcoImxhdGluMSIsIDgsIDEyKSA9PT0gIldFQlAiKSByZXR1cm4gIndlYnAiOwogIHJldHVybiB1bmRlZmluZWQ7Cn0KCi8qIOKUgOKUgCBQTkcg4pSA4pSAICovCmZ1bmN0aW9uIHBhcnNlUG5nKGJ1ZikgewogIGlmIChidWYudG9TdHJpbmcoImxhdGluMSIsIDEsIDQpICE9PSAiUE5HIikgdGhyb3cgbmV3IFNoaW1FcnJvcigibm90IGEgUE5HIik7CiAgbGV0IHBvcyA9IDg7CiAgY29uc3QgbWV0YSA9IHsgZm9ybWF0OiAicG5nIiB9OwogIGNvbnN0IGlkYXQgPSBbXTsKICB3aGlsZSAocG9zICsgOCA8PSBidWYubGVuZ3RoKSB7CiAgICBjb25zdCBsZW4gPSBidWYucmVhZFVJbnQzMkJFKHBvcyk7CiAgICBjb25zdCB0eXBlID0gYnVmLnRvU3RyaW5nKCJsYXRpbjEiLCBwb3MgKyA0LCBwb3MgKyA4KTsKICAgIGlmICh0eXBlID09PSAiSUhEUiIpIHsKICAgICAgbWV0YS53aWR0aCA9IGJ1Zi5yZWFkVUludDMyQkUocG9zICsgOCk7CiAgICAgIG1ldGEuaGVpZ2h0ID0gYnVmLnJlYWRVSW50MzJCRShwb3MgKyAxMik7CiAgICAgIG1ldGEuZGVwdGggPSBidWZbcG9zICsgMTZdOwogICAgICBtZXRhLmNvbG9yVHlwZSA9IGJ1Zltwb3MgKyAxN107CiAgICAgIG1ldGEuaW50ZXJsYWNlZCA9IGJ1Zltwb3MgKyAyMF07CiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICJQTFRFIikgeyBtZXRhLnBsdGUgPSBCdWZmZXIuZnJvbShidWYuc3ViYXJyYXkocG9zICsgOCwgcG9zICsgOCArIGxlbikpOyB9CiAgICBlbHNlIGlmICh0eXBlID09PSAidFJOUyIpIHsgbWV0YS50cm5zID0gQnVmZmVyLmZyb20oYnVmLnN1YmFycmF5KHBvcyArIDgsIHBvcyArIDggKyBsZW4pKTsgfQogICAgZWxzZSBpZiAodHlwZSA9PT0gIklEQVQiKSB7IGlkYXQucHVzaChidWYuc3ViYXJyYXkocG9zICsgOCwgcG9zICsgOCArIGxlbikpOyB9CiAgICBlbHNlIGlmICh0eXBlID09PSAiSUVORCIpIGJyZWFrOwogICAgcG9zICs9IDEyICsgbGVuOwogIH0KICBpZiAoIW1ldGEud2lkdGggfHwgIW1ldGEuaGVpZ2h0KSB0aHJvdyBuZXcgU2hpbUVycm9yKCJQTkcgbWlzc2luZyBJSERSIGRpbWVuc2lvbnMiKTsKICByZXR1cm4geyBtZXRhLCBpZGF0IH07Cn0KCmNvbnN0IENUX0NIQU5ORUxTID0geyAwOiAxLCAyOiAzLCAzOiAxLCA0OiAyLCA2OiA0IH07Ci8qIFBORyBzcGVjIMKnMTEuMjogYWxsb3dlZCBiaXQgZGVwdGhzIHBlciBjb2xvciB0eXBlICovCmNvbnN0IENUX0RFUFRIUyA9IHsgMDogWzEsIDIsIDQsIDgsIDE2XSwgMjogWzgsIDE2XSwgMzogWzEsIDIsIDQsIDhdLCA0OiBbOCwgMTZdLCA2OiBbOCwgMTZdIH07CgpmdW5jdGlvbiBkZWNvZGVQbmdSYXcoYnVmKSB7CiAgY29uc3QgeyBtZXRhLCBpZGF0IH0gPSBwYXJzZVBuZyhidWYpOwogIGlmIChtZXRhLmludGVybGFjZWQpIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBpbnRlcmxhY2VkIFBORyBpcyBub3Qgc3VwcG9ydGVkIik7CiAgaWYgKCEobWV0YS5jb2xvclR5cGUgaW4gQ1RfQ0hBTk5FTFMpKSB0aHJvdyBuZXcgU2hpbUVycm9yKCJkc2gtc2hpbTogdW5zdXBwb3J0ZWQgUE5HIGNvbG9yIHR5cGUgIiArIG1ldGEuY29sb3JUeXBlKTsKICBjb25zdCBhbGxvd2VkID0gQ1RfREVQVEhTW21ldGEuY29sb3JUeXBlXSB8fCBbXTsKICBpZiAoYWxsb3dlZC5pbmRleE9mKG1ldGEuZGVwdGgpID09PSAtMSkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IGludmFsaWQgUE5HIGJpdCBkZXB0aCAiICsgbWV0YS5kZXB0aCArICIgZm9yIGNvbG9yIHR5cGUgIiArIG1ldGEuY29sb3JUeXBlKTsKICBjb25zdCBXID0gbWV0YS53aWR0aCwgSCA9IG1ldGEuaGVpZ2h0LCBkZXB0aCA9IG1ldGEuZGVwdGgsIGN0ID0gbWV0YS5jb2xvclR5cGU7CiAgY29uc3Qgc3JjQ2ggPSBDVF9DSEFOTkVMU1tjdF07CiAgY29uc3QgYnBwID0gTWF0aC5tYXgoMSwgKHNyY0NoICogZGVwdGgpID4+IDMpOwogIGxldCByYXc7CiAgdHJ5IHsgcmF3ID0gemxpYi5pbmZsYXRlU3luYyhCdWZmZXIuY29uY2F0KGlkYXQpKTsgfQogIGNhdGNoIChlKSB7IHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBQTkcgSURBVCBpbmZsYXRlIGZhaWxlZDogIiArIGUubWVzc2FnZSk7IH0KICBjb25zdCBzdHJpZGUgPSBNYXRoLmNlaWwoKFcgKiBzcmNDaCAqIGRlcHRoKSAvIDgpOwogIGNvbnN0IGxpbmVzID0gQnVmZmVyLmFsbG9jKEggKiBzdHJpZGUpOwogIGxldCBwID0gMDsKICBmb3IgKGxldCB5ID0gMDsgeSA8IEg7IHkrKykgewogICAgaWYgKHAgPj0gcmF3Lmxlbmd0aCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IFBORyBzY2FubGluZSBkYXRhIHRydW5jYXRlZCIpOwogICAgY29uc3QgZnQgPSByYXdbcCsrXTsKICAgIGNvbnN0IGN1ciA9IHkgKiBzdHJpZGUsIHByZXYgPSBjdXIgLSBzdHJpZGU7CiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHN0cmlkZTsgeCsrKSB7CiAgICAgIGNvbnN0IHYgPSBwICsgeCA8IHJhdy5sZW5ndGggPyByYXdbcCArIHhdIDogMDsKICAgICAgY29uc3QgYSA9IHggPj0gYnBwID8gbGluZXNbY3VyICsgeCAtIGJwcF0gOiAwOwogICAgICBjb25zdCBiID0geSA+IDAgPyBsaW5lc1twcmV2ICsgeF0gOiAwOwogICAgICBjb25zdCBjID0gKHggPj0gYnBwICYmIHkgPiAwKSA/IGxpbmVzW3ByZXYgKyB4IC0gYnBwXSA6IDA7CiAgICAgIGxldCBvOwogICAgICBpZiAoZnQgPT09IDApIG8gPSB2OwogICAgICBlbHNlIGlmIChmdCA9PT0gMSkgbyA9ICh2ICsgYSkgJiAyNTU7CiAgICAgIGVsc2UgaWYgKGZ0ID09PSAyKSBvID0gKHYgKyBiKSAmIDI1NTsKICAgICAgZWxzZSBpZiAoZnQgPT09IDMpIG8gPSAodiArICgoYSArIGIpID4+IDEpKSAmIDI1NTsgLyogUE5HIEF2ZXJhZ2UgPSBmbG9vcihsZWZ0ICsgYWJvdmUpLzIgKi8KICAgICAgZWxzZSB7CiAgICAgICAgY29uc3QgcGEgPSBNYXRoLmFicyhhIC0gYyksIHBiID0gTWF0aC5hYnMoYiAtIGMpLCBwYyA9IE1hdGguYWJzKGEgKyBiIC0gMiAqIGMpOwogICAgICAgIGNvbnN0IHByID0gcGEgPD0gcGIgJiYgcGEgPD0gcGMgPyBhIDogcGIgPD0gcGMgPyBiIDogYzsKICAgICAgICBvID0gKHYgKyBwcikgJiAyNTU7CiAgICAgIH0KICAgICAgbGluZXNbY3VyICsgeF0gPSBvOwogICAgfQogICAgcCArPSBzdHJpZGU7CiAgfQogIC8qIGV4cGFuZCB0byA4LWJpdCBSR0Igb3IgUkdCQSAqLwogIGNvbnN0IGFscGhhID0gY3QgPT09IDQgfHwgY3QgPT09IDYgfHwgKGN0ID09PSAzICYmIG1ldGEudHJucyk7CiAgY29uc3Qgb3V0Q2ggPSBhbHBoYSA/IDQgOiAzOwogIGNvbnN0IG91dCA9IEJ1ZmZlci5hbGxvYyhXICogSCAqIG91dENoKTsKICBjb25zdCByZWFkU2FtcGxlID0gKGJhc2UsIGlkeCkgPT4gewogICAgaWYgKGRlcHRoID09PSA4KSByZXR1cm4gbGluZXNbYmFzZSArIGlkeF07CiAgICBpZiAoZGVwdGggPT09IDE2KSByZXR1cm4gbGluZXNbYmFzZSArIGlkeCAqIDJdOyAvKiB0YWtlIGhpZ2ggYnl0ZSAqLwogICAgLyogc3ViLWJ5dGUgZGVwdGhzIChncmF5IDEvMi80IG9ubHkpICovCiAgICBjb25zdCBiaXRQb3MgPSBpZHggKiBkZXB0aCwgYnl0ZSA9IGxpbmVzW2Jhc2UgKyAoYml0UG9zID4+IDMpXTsKICAgIGNvbnN0IHNoaWZ0ID0gOCAtIGRlcHRoIC0gKGJpdFBvcyAmIDcpOwogICAgY29uc3QgbWFzayA9ICgxIDw8IGRlcHRoKSAtIDE7CiAgICBjb25zdCB2YWwgPSAoYnl0ZSA+PiBzaGlmdCkgJiBtYXNrOwogICAgcmV0dXJuIE1hdGgucm91bmQoKHZhbCAqIDI1NSkgLyBtYXNrKTsKICB9OwogIGZvciAobGV0IHkgPSAwOyB5IDwgSDsgeSsrKSB7CiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IFc7IHgrKykgewogICAgICBjb25zdCBiYXNlID0geSAqIHN0cmlkZSArIE1hdGguZmxvb3IoKHggKiBzcmNDaCAqIGRlcHRoKSAvIDgpOwogICAgICBjb25zdCBkaSA9ICh5ICogVyArIHgpICogb3V0Q2g7CiAgICAgIGlmIChjdCA9PT0gMCkgewogICAgICAgIC8qIHN1Yi1ieXRlIGdyYXkgcGFja3MgcGl4ZWxzIE1TQi1maXJzdCBhY3Jvc3MgdGhlIHJvdzogYml0IG9mZnNldCBtdXN0IGNvbWUgZnJvbSB4LCBub3QgZnJvbSBiYXNlIGFsb25lICovCiAgICAgICAgbGV0IGc7CiAgICAgICAgaWYgKGRlcHRoID49IDgpIGcgPSBsaW5lc1tiYXNlXTsgLyogMTYtYml0OiB0YWtlIGhpZ2ggYnl0ZSAqLwogICAgICAgIGVsc2UgewogICAgICAgICAgY29uc3QgYml0UG9zID0geCAqIGRlcHRoOwogICAgICAgICAgY29uc3QgYnl0ZSA9IGxpbmVzW3kgKiBzdHJpZGUgKyAoYml0UG9zID4+IDMpXTsKICAgICAgICAgIGNvbnN0IG1hc2sgPSAoMSA8PCBkZXB0aCkgLSAxOwogICAgICAgICAgZyA9IE1hdGgucm91bmQoKCgoYnl0ZSA+PiAoOCAtIGRlcHRoIC0gKGJpdFBvcyAmIDcpKSkgJiBtYXNrKSAqIDI1NSkgLyBtYXNrKTsKICAgICAgICB9CiAgICAgICAgb3V0W2RpXSA9IG91dFtkaSArIDFdID0gb3V0W2RpICsgMl0gPSBnOwogICAgICB9CiAgICAgIGVsc2UgaWYgKGN0ID09PSAyKSB7IG91dFtkaV0gPSByZWFkU2FtcGxlKGJhc2UsIDApOyBvdXRbZGkgKyAxXSA9IHJlYWRTYW1wbGUoYmFzZSArIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDJdID0gcmVhZFNhbXBsZShiYXNlICsgMiAqIChkZXB0aCA+PiAzKSwgMCk7IGlmIChhbHBoYSkgb3V0W2RpICsgM10gPSAyNTU7IH0KICAgICAgZWxzZSBpZiAoY3QgPT09IDQpIHsgY29uc3QgZyA9IHJlYWRTYW1wbGUoYmFzZSwgMCk7IG91dFtkaV0gPSBvdXRbZGkgKyAxXSA9IG91dFtkaSArIDJdID0gZzsgb3V0W2RpICsgM10gPSBkZXB0aCA9PT0gMTYgPyBsaW5lc1t5ICogc3RyaWRlICsgeCAqIDQgKyAyXSA6IGxpbmVzW3kgKiBzdHJpZGUgKyB4ICogMiArIDFdOyB9CiAgICAgIGVsc2UgaWYgKGN0ID09PSA2KSB7IG91dFtkaV0gPSByZWFkU2FtcGxlKGJhc2UsIDApOyBvdXRbZGkgKyAxXSA9IHJlYWRTYW1wbGUoYmFzZSArIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDJdID0gcmVhZFNhbXBsZShiYXNlICsgMiAqIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDNdID0gZGVwdGggPT09IDE2ID8gcmVhZFNhbXBsZShiYXNlICsgMyAqIChkZXB0aCA+PiAzKSwgMCkgOiByZWFkU2FtcGxlKGJhc2UgKyAzLCAwKTsgfQogICAgICBlbHNlIHsgLyogcGFsZXR0ZSAqLwogICAgICAgIGNvbnN0IGlkeCA9IGRlcHRoIDwgOCA/ICgoKSA9PiB7IGNvbnN0IGJpdFBvcyA9IHggKiBkZXB0aDsgY29uc3QgYnl0ZSA9IGxpbmVzW3kgKiBzdHJpZGUgKyAoYml0UG9zID4+IDMpXTsgcmV0dXJuIChieXRlID4+ICg4IC0gZGVwdGggLSAoYml0UG9zICYgNykpKSAmICgoMSA8PCBkZXB0aCkgLSAxKTsgfSkoKSA6IGxpbmVzW3kgKiBzdHJpZGUgKyB4XTsKICAgICAgICBjb25zdCBwbHRlID0gbWV0YS5wbHRlOwogICAgICAgIGlmICghcGx0ZSB8fCBpZHggKiAzICsgMiA+PSBwbHRlLmxlbmd0aCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IFBORyBwYWxldHRlIGluZGV4IG91dCBvZiByYW5nZSIpOwogICAgICAgIG91dFtkaV0gPSBwbHRlW2lkeCAqIDNdOyBvdXRbZGkgKyAxXSA9IHBsdGVbaWR4ICogMyArIDFdOyBvdXRbZGkgKyAyXSA9IHBsdGVbaWR4ICogMyArIDJdOwogICAgICAgIG91dFtkaSArIDNdID0gbWV0YS50cm5zICYmIGlkeCA8IG1ldGEudHJucy5sZW5ndGggPyBtZXRhLnRybnNbaWR4XSA6IDI1NTsKICAgICAgfQogICAgfQogIH0KICByZXR1cm4geyBkYXRhOiBvdXQsIHdpZHRoOiBXLCBoZWlnaHQ6IEgsIGNoYW5uZWxzOiBvdXRDaCB9Owp9CgovKiDilIDilIAgSlBFRyBoZWFkZXIg4pSA4pSAICovCmZ1bmN0aW9uIHBhcnNlSnBlZyhidWYpIHsKICBsZXQgcG9zID0gMjsKICB3aGlsZSAocG9zICsgOSA8PSBidWYubGVuZ3RoKSB7CiAgICBpZiAoYnVmW3Bvc10gIT09IDB4ZmYpIHsgcG9zKys7IGNvbnRpbnVlOyB9CiAgICBjb25zdCBtYXJrZXIgPSBidWZbcG9zICsgMV07CiAgICBpZiAobWFya2VyID09PSAweGQ4IHx8IG1hcmtlciA9PT0gMHgwMSB8fCAobWFya2VyID49IDB4ZDAgJiYgbWFya2VyIDw9IDB4ZDcpKSB7IHBvcyArPSAyOyBjb250aW51ZTsgfQogICAgY29uc3QgbGVuID0gYnVmLnJlYWRVSW50MTZCRShwb3MgKyAyKTsKICAgIGlmICgobWFya2VyID49IDB4YzAgJiYgbWFya2VyIDw9IDB4Y2YpICYmIG1hcmtlciAhPT0gMHhjNCAmJiBtYXJrZXIgIT09IDB4YzggJiYgbWFya2VyICE9PSAweGNjKSB7CiAgICAgIHJldHVybiB7IGZvcm1hdDogImpwZWciLCB3aWR0aDogYnVmLnJlYWRVSW50MTZCRShwb3MgKyA3KSwgaGVpZ2h0OiBidWYucmVhZFVJbnQxNkJFKHBvcyArIDUpLCBkZXB0aDogOCwgY2hhbm5lbHM6IGJ1Zltwb3MgKyA5XSB9OwogICAgfQogICAgcG9zICs9IDIgKyBsZW47CiAgfQogIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBKUEVHIFNPRiBtYXJrZXIgbm90IGZvdW5kIik7Cn0KCi8qIOKUgOKUgCBXZWJQIGhlYWRlciDilIDilIAgKi8KZnVuY3Rpb24gcGFyc2VXZWJwKGJ1ZikgewogIGNvbnN0IGZvdXJjYyA9IGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMTIsIDE2KTsKICBpZiAoZm91cmNjID09PSAiVlA4WCIpIHsKICAgIHJldHVybiB7IGZvcm1hdDogIndlYnAiLCB3aWR0aDogMSArIChidWZbMjRdIHwgKGJ1ZlsyNV0gPDwgOCkgfCAoYnVmWzI2XSA8PCAxNikpLCBoZWlnaHQ6IDEgKyAoYnVmWzI3XSB8IChidWZbMjhdIDw8IDgpIHwgKGJ1ZlsyOV0gPDwgMTYpKSwgZGVwdGg6IDgsIGNoYW5uZWxzOiA0IH07CiAgfQogIGlmIChmb3VyY2MgPT09ICJWUDggIikgewogICAgcmV0dXJuIHsgZm9ybWF0OiAid2VicCIsIHdpZHRoOiBidWYucmVhZFVJbnQxNkxFKDI2KSAmIDB4M2ZmZiwgaGVpZ2h0OiBidWYucmVhZFVJbnQxNkxFKDI4KSAmIDB4M2ZmZiwgZGVwdGg6IDgsIGNoYW5uZWxzOiAzIH07CiAgfQogIGlmIChmb3VyY2MgPT09ICJWUDhMIikgewogICAgY29uc3QgYml0cyA9IGJ1Zi5yZWFkVUludDMyTEUoMjEpOwogICAgcmV0dXJuIHsgZm9ybWF0OiAid2VicCIsIHdpZHRoOiAoYml0cyAmIDB4M2ZmZikgKyAxLCBoZWlnaHQ6ICgoYml0cyA+PiAxNCkgJiAweDNmZmYpICsgMSwgZGVwdGg6IDgsIGNoYW5uZWxzOiA0IH07CiAgfQogIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiB1bnN1cHBvcnRlZCBXZWJQIGNodW5rICIgKyBKU09OLnN0cmluZ2lmeShmb3VyY2MpKTsKfQoKZnVuY3Rpb24gY29tcHV0ZU1ldGEoYnVmKSB7CiAgY29uc3QgZm10ID0gc25pZmYoYnVmKTsKICBpZiAoIWZtdCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IHVuc3VwcG9ydGVkIG9yIHVucmVjb2duaXplZCBpbWFnZSBkYXRhIik7CiAgaWYgKGZtdCA9PT0gInBuZyIpIHsKICAgIGNvbnN0IHsgbWV0YSB9ID0gcGFyc2VQbmcoYnVmKTsKICAgIGNvbnN0IHNwYWNlID0gbWV0YS5jb2xvclR5cGUgPT09IDAgfHwgbWV0YS5jb2xvclR5cGUgPT09IDQgPyAiYi13IiA6IG1ldGEuY29sb3JUeXBlID09PSAzID8gInNyZ2IiIDogInNyZ2IiOwogICAgcmV0dXJuIHsgZm9ybWF0OiAicG5nIiwgd2lkdGg6IG1ldGEud2lkdGgsIGhlaWdodDogbWV0YS5oZWlnaHQsIHNwYWNlLCBjaGFubmVsczogQ1RfQ0hBTk5FTFNbbWV0YS5jb2xvclR5cGVdIHx8IDMsIGRlcHRoOiBTdHJpbmcobWV0YS5kZXB0aCksIGNocm9tYVN1YnNhbXBsaW5nOiAiNDo0OjQiLCBpc1Byb2dyZXNzaXZlOiBmYWxzZSB9OwogIH0KICBpZiAoZm10ID09PSAianBlZyIpIHJldHVybiBPYmplY3QuYXNzaWduKHsgY2hyb21hU3Vic2FtcGxpbmc6ICI0OjI6MCIsIGlzUHJvZ3Jlc3NpdmU6IGZhbHNlIH0sIHBhcnNlSnBlZyhidWYpKTsKICBpZiAoZm10ID09PSAiZ2lmIikgcmV0dXJuIHsgZm9ybWF0OiAiZ2lmIiwgd2lkdGg6IGJ1Zi5yZWFkVUludDE2TEUoNiksIGhlaWdodDogYnVmLnJlYWRVSW50MTZMRSg4KSwgYW5pbWF0ZWQ6IGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMTAsIDEzKSA9PT0gIk5FVCIsIHBhZ2VzOiAxIH07CiAgcmV0dXJuIHBhcnNlV2VicChidWYpOwp9CgovKiDilIDilIAgaW5zdGFuY2Ug4pSA4pSAICovCmNsYXNzIFNoYXJwSW5zdGFuY2UgewogIGNvbnN0cnVjdG9yKGlucHV0KSB7CiAgICB0aGlzLl9pbiA9IGlucHV0OwogICAgdGhpcy5fbW9kZSA9IG51bGw7ICAgICAgICAgIC8qIG51bGwgfCAncmF3JyAqLwogICAgdGhpcy5fcmVzaXplVG8gPSBudWxsOyAgICAgIC8qIHt3aWR0aCxoZWlnaHR9IG5lYXJlc3QtbmVpZ2hib3VyICovCiAgICBzbmlmZih0aGlzLl9pbik7ICAgICAgICAgICAgLyogZmFpbCBmYXN0IG9uIGdhcmJhZ2UgKi8KICB9CiAgbWV0YWRhdGEoKSB7CiAgICB0cnkgeyByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGNvbXB1dGVNZXRhKHRoaXMuX2luKSk7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBQcm9taXNlLnJlamVjdChlKTsgfQogIH0KICByYXcoKSB7IHRoaXMuX21vZGUgPSAicmF3IjsgcmV0dXJuIHRoaXM7IH0KICByZXNpemUod2lkdGgsIGhlaWdodCkgewogICAgdGhpcy5fcmVzaXplVG8gPSB7IHdpZHRoOiB3aWR0aCB8fCBudWxsLCBoZWlnaHQ6IGhlaWdodCB8fCBudWxsIH07CiAgICByZXR1cm4gdGhpczsKICB9CiAgcm90YXRlKCkgeyByZXR1cm4gdGhpczsgfQogIGZsYXR0ZW4oKSB7IHJldHVybiB0aGlzOyB9CiAgd2l0aE1ldGFkYXRhKCkgeyByZXR1cm4gdGhpczsgfQogIGdyZXlzY2FsZSgpIHsgcmV0dXJuIHRoaXM7IH0KICBncmF5c2NhbGUoKSB7IHJldHVybiB0aGlzOyB9CiAgcG5nKCkgeyB0aGlzLl9yZWVuY29kZSA9ICJwbmciOyByZXR1cm4gdGhpczsgfQogIGpwZWcoKSB7IHRoaXMuX3JlZW5jb2RlID0gImpwZWciOyByZXR1cm4gdGhpczsgfQogIHdlYnAoKSB7IHRoaXMuX3JlZW5jb2RlID0gIndlYnAiOyByZXR1cm4gdGhpczsgfQogIGNsb25lKCkgeyBjb25zdCBjID0gbmV3IFNoYXJwSW5zdGFuY2UodGhpcy5faW4pOyBjLl9tb2RlID0gdGhpcy5fbW9kZTsgYy5fcmVzaXplVG8gPSB0aGlzLl9yZXNpemVUbzsgYy5fcmVlbmNvZGUgPSB0aGlzLl9yZWVuY29kZTsgcmV0dXJuIGM7IH0KICB0b0J1ZmZlcihvcHRpb25zKSB7CiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiB7CiAgICAgIGlmICh0aGlzLl9yZWVuY29kZSAmJiBzbmlmZih0aGlzLl9pbikgIT09IHRoaXMuX3JlZW5jb2RlKQogICAgICAgIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiByZS1lbmNvZGluZyB0byAiICsgdGhpcy5fcmVlbmNvZGUgKyAiIGlzIG5vdCBzdXBwb3J0ZWQgKG5vIGxpYnZpcHMgb24gdGhpcyBwbGF0Zm9ybSkiKTsKICAgICAgaWYgKHRoaXMuX21vZGUgPT09ICJyYXciIHx8IHRoaXMuX3Jlc2l6ZVRvKSB7CiAgICAgICAgY29uc3QgZGVjb2RlZCA9IGRlY29kZVBuZ0FueSh0aGlzLl9pbik7CiAgICAgICAgbGV0IHsgZGF0YSwgd2lkdGgsIGhlaWdodCwgY2hhbm5lbHMgfSA9IGRlY29kZWQ7CiAgICAgICAgaWYgKHRoaXMuX3Jlc2l6ZVRvICYmICh0aGlzLl9yZXNpemVUby53aWR0aCB8fCB0aGlzLl9yZXNpemVUby5oZWlnaHQpKSB7CiAgICAgICAgICBjb25zdCBydCA9IHRoaXMuX3Jlc2l6ZVRvOwogICAgICAgICAgY29uc3QgdzIgPSBydC53aWR0aCB8fCBNYXRoLnJvdW5kKHdpZHRoICogKHJ0LmhlaWdodCAvIGhlaWdodCkpOwogICAgICAgICAgY29uc3QgaDIgPSBydC5oZWlnaHQgfHwgTWF0aC5yb3VuZChoZWlnaHQgKiAocnQud2lkdGggLyB3aWR0aCkpOwogICAgICAgICAgY29uc3Qgb3V0ID0gQnVmZmVyLmFsbG9jKHcyICogaDIgKiBjaGFubmVscyk7CiAgICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGgyOyB5KyspIHsKICAgICAgICAgICAgY29uc3Qgc3kgPSBNYXRoLm1pbihoZWlnaHQgLSAxLCBNYXRoLmZsb29yKCh5ICogaGVpZ2h0KSAvIGgyKSk7CiAgICAgICAgICAgIGZvciAobGV0IHggPSAwOyB4IDwgdzI7IHgrKykgewogICAgICAgICAgICAgIGNvbnN0IHN4ID0gTWF0aC5taW4od2lkdGggLSAxLCBNYXRoLmZsb29yKCh4ICogd2lkdGgpIC8gdzIpKTsKICAgICAgICAgICAgICBjb25zdCBzbyA9IChzeSAqIHdpZHRoICsgc3gpICogY2hhbm5lbHMsIGRvZmYgPSAoeSAqIHcyICsgeCkgKiBjaGFubmVsczsKICAgICAgICAgICAgICBmb3IgKGxldCBjaCA9IDA7IGNoIDwgY2hhbm5lbHM7IGNoKyspIG91dFtkb2ZmICsgY2hdID0gZGF0YVtzbyArIGNoXTsKICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgICAgZGF0YSA9IG91dDsgd2lkdGggPSB3MjsgaGVpZ2h0ID0gaDI7CiAgICAgICAgfQogICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucmVzb2x2ZVdpdGhPYmplY3QpIHJldHVybiB7IGRhdGEsIGluZm86IHsgd2lkdGgsIGhlaWdodCwgY2hhbm5lbHMgfSB9OwogICAgICAgIHJldHVybiBkYXRhOwogICAgICB9CiAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucmVzb2x2ZVdpdGhPYmplY3QpIHsKICAgICAgICBjb25zdCBtID0gY29tcHV0ZU1ldGEodGhpcy5faW4pOwogICAgICAgIHJldHVybiB7IGRhdGE6IHRoaXMuX2luLCBpbmZvOiB7IGZvcm1hdDogbS5mb3JtYXQsIHdpZHRoOiBtLndpZHRoLCBoZWlnaHQ6IG0uaGVpZ2h0IH0gfTsKICAgICAgfQogICAgICByZXR1cm4gdGhpcy5faW47CiAgICB9KTsKICB9Cn0KCmZ1bmN0aW9uIGRlY29kZVBuZ0FueShidWYpIHsKICBjb25zdCBmbXQgPSBzbmlmZihidWYpOwogIGlmIChmbXQgIT09ICJwbmciKSB0aHJvdyBuZXcgU2hpbUVycm9yKCJkc2gtc2hpbTogZnVsbCBwaXhlbCBkZWNvZGUgb25seSBzdXBwb3J0ZWQgZm9yIFBORyBvbiB0aGlzIHBsYXRmb3JtIChnb3QgIiArIChmbXQgfHwgInVua25vd24iKSArICIpIik7CiAgcmV0dXJuIGRlY29kZVBuZ1JhdyhidWYpOwp9CgovKiBjYWxsYWJsZSB3aXRoIG9yIHdpdGhvdXQgYG5ld2AgKi8KZnVuY3Rpb24gc2hhcnAoaW5wdXQsIG9wdGlvbnMpIHsKICBsZXQgYnVmID0gaW5wdXQ7CiAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gInN0cmluZyIpIGJ1ZiA9IGZzLnJlYWRGaWxlU3luYyhpbnB1dCk7CiAgZWxzZSBpZiAoaW5wdXQgaW5zdGFuY2VvZiBVaW50OEFycmF5ICYmICFCdWZmZXIuaXNCdWZmZXIoaW5wdXQpKSBidWYgPSBCdWZmZXIuZnJvbShpbnB1dCk7CiAgZWxzZSBpZiAoaW5wdXQgJiYgdHlwZW9mIGlucHV0LnBpcGUgPT09ICJmdW5jdGlvbiIpCiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IHN0cmVhbSBpbnB1dCBpcyBub3Qgc3VwcG9ydGVkIikpOwogIHJldHVybiBuZXcgU2hhcnBJbnN0YW5jZShidWYpOwp9CnNoYXJwLnZlcnNpb25zID0geyB2aXBzOiAibm9uZSIsICJkc2gtc2hpbSI6ICIxLjAuMC1wdXJlanMiIH07CnNoYXJwLmZvcm1hdCA9IFsianBlZyIsICJwbmciLCAid2VicCIsICJnaWYiLCAic3ZnIiwgInRpZmYiLCAiYXZpZiJdLnJlZHVjZSgoYWNjLCBpZCkgPT4gewogIGFjY1tpZF0gPSB7IGlkLCBpbnB1dDogeyBidWZmZXI6IFsianBlZyIsICJwbmciLCAid2VicCIsICJnaWYiXS5pbmNsdWRlcyhpZCksIGZpbGU6IGZhbHNlLCBzdHJlYW06IGZhbHNlIH0sIG91dHB1dDogeyBidWZmZXI6IGlkID09PSAicG5nIiwgZmlsZTogZmFsc2UsIHN0cmVhbTogZmFsc2UgfSB9OwogIHJldHVybiBhY2M7Cn0sIHt9KTsKc2hhcnAuZGVmaW5pdGlvbnMgPSB7fTsKc2hhcnAudmVuZG9yID0gIiI7CnNoYXJwLmlzU2hpbSA9IHRydWU7Cgptb2R1bGUuZXhwb3J0cyA9IHNoYXJwOwptb2R1bGUuZXhwb3J0cy5kZWZhdWx0ID0gc2hhcnA7Cm1vZHVsZS5leHBvcnRzLlNoYXJwID0gU2hhcnBJbnN0YW5jZTsK';
  const targets = [
    ['sharp', 'dist/index.cjs', './_dshshim.cjs'],
    ['sharp', 'dist/index.mjs', './_dshshim.cjs'],
    ['sharp', 'dist/sharp.cjs', './_dshshim.cjs'],
    ['sharp', 'dist/sharp.mjs', './_dshshim.cjs'],
    ['sharp', 'lib/index.js', '../dist/_dshshim.cjs'],
    ['sharp', 'index.js', './dist/_dshshim.cjs'],
  ];
  const writtenShims = [];
  let n = 0;
  for (const [pkg, rel, req] of targets) {
    const p = findPkg(pkg, rel);
    if (!p) continue;
    const rootDir = p.slice(0, p.length - rel.length - 1);
    const shimAbs = join(rootDir, 'dist', '_dshshim.cjs');
    if (!writtenShims.includes(shimAbs)) {
      writeFileSync(shimAbs, Buffer.from(SHIM_B64, 'base64'));
      writtenShims.push(shimAbs);
    }
    const payload = rel.endsWith('.mjs')
      ? 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);const s=require(' + JSON.stringify(req) + ');export default s;export const versions=s.versions;export const format=s.format;'
      : 'module.exports=require(' + JSON.stringify(req) + ');module.exports.default=module.exports;';
    writeFileSync(p, payload);
    log('sharp shim ok: ' + p);
    n++;
  }
  if (n === 0) log('sharp: not found, skip');
} catch (e) { log('WARN sharp shim: ' + e.message); }

try {
  /* node-addon-require-builtin 纯 JS 顶替（**已针对 0.1.7-rc.2 核实**）
   *
   * 为什么必须新增（**boot 级硬阻断，不是降级**）：dsh 0.1.7 把 profile 模块解析
   * 重构为依赖原生插件 node-addon-require-builtin——
   *   dsh-app-boot/lib/index.js:1573 internalModules() 用它 requireBuiltin() 拿 5 个
   *   Node 内部模块（internal/modules/{esm/loader,cjs/loader,helpers,esm/utils,esm/resolve}）；
   *   调用链 internalModules ← installRuntimeInterception(:1641) ← PluginPackages 构造
   *   ← runProfile 的 **boot prepare 回调**，**早于任何插件树加载**。
   * 该插件在**模块加载期**就急切加载原生二进制：
   *   node-addon-native-custom-loader/lib/index.js:552 createEntryApi 顶层即调 loadEntry(:496)。
   * Android 没有该包的任何预编译产物：node-addon-require-builtin-android-arm64 在 registry
   * 上 404，其 optionalDependencies 只列了 darwin/linux/win32 共 7 个平台包。
   * → require 期同步抛 "No usable native binding found"，失败点在插件树挂载**之前**，
   *   日志里只有「web 未就绪」，**没有任何插件级报错**（极易误判为网络/端口问题）。
   *
   * 顶替原理：启动器本来就以 --expose-internals 启动 dsh
   *   （DshFlow.startDshWeb: node --expose-internals --import fs-register.mjs <cli> web），
   * 该开关让 require('internal/modules/…') 直接可用，与原生插件 requireBuiltin 语义等价。
   * 实测（Node 22.17 / --expose-internals）app-boot 的**完整校验谓词全部通过**：
   *   resolveSync / getOrCreateModuleJob|getModuleJobForImport / Module._resolveFilename /
   *   getCjsConditions / getDefaultConditions / defaultResolve，且
   *   「与直接 require 拿到的是同一个 Node 真实 loader 对象」。
   * 缺少 --expose-internals 时**显式抛错并说明原因**（不是静默返回空对象）——静默会让
   * app-boot 的校验抛「unsupported Node module loader」，反而掩盖真实原因。
   *
   * 覆写方式与 koffi / node-pty 同性质（整体覆写入口，非锚点插桩）；payload 为 base64
   * 常量，末尾自带 marker 注释 'dsh-launcher-android-narb-shim-v1'。 */
  const NARB_B64 =
    'Ly8gZHNoLWxhdW5jaGVyLWFuZHJvaWQtbmFyYi1zaGltLXYxCid1c2Ugc3RyaWN0JzsKLyoqCiAqIG5vZGUtYWRk' +
    'b24tcmVxdWlyZS1idWlsdGluIOKAlCBBbmRyb2lkIOe6ryBKUyDpobbmm7/lrp7njrDjgIIKICoKICog5Li65LuA' +
    '5LmI5b+F6aG75a2Y5Zyo77yaZHNoIDAuMS43IOaKiiBwcm9maWxlIOaooeWdl+ino+aekOmHjeaehOS4uuS+nei1' +
    'lui/meS4qioq5Y6f55Sf5o+S5Lu2KirigJTigJQKICogZHNoLWFwcC1ib290IOeahCBpbnRlcm5hbE1vZHVsZXMo' +
    'KSDnlKjlroPmi78gTm9kZSDlhoXpg6jmqKHlnZfvvIhpbnRlcm5hbC9tb2R1bGVzLy4uLu+8ie+8jAogKiDogIzl' +
    'roPlnKgqKuaooeWdl+WKoOi9veacnyoq77yIY3JlYXRlRW50cnlBcGkg4oaSIGxvYWRFbnRyee+8ieWwseaApeWI' +
    'h+WKoOi9veWOn+eUn+S6jOi/m+WItuOAggogKgogKiBBbmRyb2lkIOayoeacieivpeWMheeahOS7u+S9lemihOe8' +
    'luivkeS6p+eJqe+8iG5vZGUtYWRkb24tcmVxdWlyZS1idWlsdGluLWFuZHJvaWQtYXJtNjQg5ZyoCiAqIHJlZ2lz' +
    'dHJ5IOS4iiA0MDTvvIxvcHRpb25hbERlcGVuZGVuY2llcyDlj6rliJfkuoYgZGFyd2luL2xpbnV4L3dpbjMy77yJ' +
    '77yM5LqO5pivIHJlcXVpcmUKICog5pyf5ZCM5q2l5oqbICJObyB1c2FibGUgbmF0aXZlIGJpbmRpbmcgZm91bmQi' +
    '44CCCiAqCiAqIOWksei0peS9jee9ruWcqCAqKmJvb3Qg55qEIHByZXBhcmUg5Zue6LCD6YeM44CB5Lu75L2V5o+S' +
    '5Lu25qCR5Yqg6L295LmL5YmNKirvvIhkc2gvbGliL3Byb2ZpbGUtYm9vdAogKiDnmoQgcnVuUHJvZmlsZSDihpIg' +
    'UGx1Z2luUGFja2FnZXMg5p6E6YCgIOKGkiBpbnN0YWxsUnVudGltZUludGVyY2VwdGlvbiDihpIgaW50ZXJuYWxN' +
    'b2R1bGVz77yJ77yMCiAqIOWboOatpOaXpeW/l+mHjOWPquacieOAjHdlYiDmnKrlsLHnu6rjgI3vvIwqKuayoeac' +
    'ieS7u+S9leaPkuS7tue6p+aKpemUmSoq4oCU4oCU5p6B5piT6K+v5Yik5Li6572R57ucL+err+WPo+mXrumimOOA' +
    'ggogKgogKiDpobbmm7/ljp/nkIbvvJrlkK/liqjlmajmnKzmnaXlsLHku6UgLS1leHBvc2UtaW50ZXJuYWxzIOWQ' +
    'r+WKqCBkc2jvvIjop4EgRHNoRmxvdy5zdGFydERzaFdlYu+8ie+8jAogKiDor6XlvIDlhbPorqkgcmVxdWlyZSgn' +
    'aW50ZXJuYWwvbW9kdWxlcy8uLi4nKSDnm7TmjqXlj6/nlKjvvIzkuI7ljp/nlJ/mj5Lku7bnmoQgcmVxdWlyZUJ1' +
    'aWx0aW4KICog6K+t5LmJ562J5Lu344CC5a6e5rWL5pys5py6IE5vZGUgMjYg5LiLIGFwcC1ib290IOeahOWujOaV' +
    'tOagoemqjOiwk+ivjeWFqOmDqOmAmui/hwogKiDvvIhyZXNvbHZlU3luYyAvIGdldE9yQ3JlYXRlTW9kdWxlSm9i' +
    'fGdldE1vZHVsZUpvYkZvckltcG9ydCAvIE1vZHVsZS5fcmVzb2x2ZUZpbGVuYW1lIC8KICogICBnZXRDanNDb25k' +
    'aXRpb25zIC8gZ2V0RGVmYXVsdENvbmRpdGlvbnMgLyBkZWZhdWx0UmVzb2x2Ze+8ieOAggogKgogKiDms6jmhI/v' +
    'vJotLWV4cG9zZS1pbnRlcm5hbHMg57y65aSx5pe26L+Z6YeM5LyaKirmmL7lvI/mipvplJnlubbor7TmmI7ljp/l' +
    'm6AqKu+8jOiAjOS4jeaYr+mdmem7mOmZjee6p+KAlOKAlAogKiDpnZnpu5jov5Tlm57nqbrlr7nosaHkvJrorqkg' +
    'YXBwLWJvb3Qg55qE5qCh6aqM5oqb44CMdW5zdXBwb3J0ZWQgTm9kZSBtb2R1bGUgbG9hZGVy44CN77yMCiAqIOWP' +
    'jeiAjOaOqeebluecn+WunuWOn+WboOOAggogKi8KY29uc3QgeyBjcmVhdGVSZXF1aXJlIH0gPSByZXF1aXJlKCdu' +
    'b2RlOm1vZHVsZScpOwpjb25zdCByZXEgPSBjcmVhdGVSZXF1aXJlKF9fZmlsZW5hbWUpOwoKY29uc3QgSU5URVJO' +
    'QUxfTU9EVUxFUyA9IHsKICAnaW50ZXJuYWwvbW9kdWxlcy9lc20vbG9hZGVyJzogbnVsbCwKICAnaW50ZXJuYWwv' +
    'bW9kdWxlcy9janMvbG9hZGVyJzogbnVsbCwKICAnaW50ZXJuYWwvbW9kdWxlcy9oZWxwZXJzJzogbnVsbCwKICAn' +
    'aW50ZXJuYWwvbW9kdWxlcy9lc20vdXRpbHMnOiBudWxsLAogICdpbnRlcm5hbC9tb2R1bGVzL2VzbS9yZXNvbHZl' +
    'JzogbnVsbCwKfTsKY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7CgpmdW5jdGlvbiByZXF1aXJlQnVpbHRpbihtb2R1' +
    'bGVJZCkgewogIGlmIChjYWNoZS5oYXMobW9kdWxlSWQpKSByZXR1cm4gY2FjaGUuZ2V0KG1vZHVsZUlkKTsKICBs' +
    'ZXQgbW9kOwogIHRyeSB7CiAgICBtb2QgPSByZXEobW9kdWxlSWQpOwogIH0gY2F0Y2ggKGUpIHsKICAgIHRocm93' +
    'IG5ldyBFcnJvcigKICAgICAgJ25vZGUtYWRkb24tcmVxdWlyZS1idWlsdGluKHNoaW0pOiDml6Dms5XliqDovb3l' +
    'hoXpg6jmqKHlnZcgIicgKyBtb2R1bGVJZCArICci44CCJyArCiAgICAgICfmnKzpobbmm7/lrp7njrDkvp3otZYg' +
    'Tm9kZSDku6UgLS1leHBvc2UtaW50ZXJuYWxzIOWQr+WKqO+8iGRzaCDlkK/liqjlkb3ku6Tlt7LluKbor6Xlj4Lm' +
    'lbDvvInvvJsnICsKICAgICAgJ+iLpeeci+WIsOacrOadoe+8jOivtOaYjuWQr+WKqOWPguaVsOiiq+aUueWKqOOA' +
    'guWOn+Wni+mUmeivrzogJyArIChlICYmIGUubWVzc2FnZSkKICAgICk7CiAgfQogIGNhY2hlLnNldChtb2R1bGVJ' +
    'ZCwgbW9kKTsKICByZXR1cm4gbW9kOwp9CgovKiog5LiO5Y6f55Sf5o+S5Lu25ZCM5b2i55qE55m95ZCN5Y2V5Yik' +
    '5a6a77ya5Y+q5pS+6KGMIGRzaCDlrp7pmYXkvJrnlKjnmoTov5kgNSDkuKrlhoXpg6jmqKHlnZfjgIIgKi8KZnVu' +
    'Y3Rpb24gaXNBbGxvd2VkSW50ZXJuYWxJZChtb2R1bGVJZCkgewogIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhh' +
    'c093blByb3BlcnR5LmNhbGwoSU5URVJOQUxfTU9EVUxFUywgbW9kdWxlSWQpOwp9CgovKiog5Y6f55Sf5a6e546w' +
    '6L+U5ZueIGJpbmRpbmcg5YWD5L+h5oGv77yb5q2k5aSE5qCH5piO5Li6IEpTIOmhtuabv++8jOS+v+S6juiviuaW' +
    'reaXpeW/l+WMuuWIhuOAgiAqLwpmdW5jdGlvbiBnZXRCaW5kaW5nSW5mbygpIHsKICByZXR1cm4gT2JqZWN0LmZy' +
    'ZWV6ZSh7CiAgICBtb2RlOiAnanMtc2hpbScsCiAgICBiYWNrZW5kOiAnbmFwaScsCiAgICBhYmk6ICduYXBpLXY5' +
    'JywKICAgIHBsYXRmb3JtOiBwcm9jZXNzLnBsYXRmb3JtLAogICAgYXJjaDogcHJvY2Vzcy5hcmNoLAogICAgbm9k' +
    'ZTogcHJvY2Vzcy52ZXJzaW9uLAogIH0pOwp9Cgptb2R1bGUuZXhwb3J0cyA9IHsgcmVxdWlyZUJ1aWx0aW4sIGlz' +
    'QWxsb3dlZEludGVybmFsSWQsIGdldEJpbmRpbmdJbmZvIH07Cm1vZHVsZS5leHBvcnRzLmRlZmF1bHQgPSBtb2R1' +
    'bGUuZXhwb3J0czsK';
  const NARB_MARKER = 'dsh-launcher-android-narb-shim-v1';
  const narb = findPkg('node-addon-require-builtin', 'lib/index.js');
  if (!narb) {
    log('WARN node-addon-require-builtin: not found — 0.1.7 boot 将失败（该包是 app-boot 的硬依赖）');
  } else {
    const cur = readFileSync(narb, 'utf8');
    if (cur.includes(NARB_MARKER)) {
      log('node-addon-require-builtin JS shim already applied');
    } else {
      writeFileSync(narb, Buffer.from(NARB_B64, 'base64'));
      log('node-addon-require-builtin JS shim applied: ' + narb);
    }
  }
} catch (e) { log('WARN node-addon-require-builtin shim: ' + e.message); }



  /* 视觉链路配套（当前 dsh-launcher-android-att-vision-v5），在 v3/v4 基础上加三道保险：
     1) syncDirectory 改用「函数签名 + 花括号配平」定位完整函数体，不再依赖后继注释锚点，
        对任何上游结构（干净 / v2 残缺 / v3 已改）都能精确切出整个函数；
     2) 写入前先用 node --check 校验临时文件语法，校验失败则放弃写盘（防止再毒化）；
     3) link 调用点**扫描式**改写（v5 新增）——上游 0.1.5 把单点 link 拆成
        publishStagedObject / publishImmutableAlias 两点，v4 的单锚点静默失效。
     同时自愈 v2 遗留的孤儿 finally / 孤儿 publishCopied 调用。

     幂等判据（v5 修正）：**不能只看 marker 字符串**。旧实现只要文件里出现
     'att-vision-v4' 就整体短路，而上游换版时 marker 可能与「调用点未改写」
     共存（正是 0.1.5 的真实现场）→ 补丁永久失效。v5 改为
     「marker 存在 且 已无裸 link 发布调用点」才算已完成。

     **已针对 0.1.7-rc.2 核实**：dsh-attachment-local@0.1.7-rc.2/lib/index.js 中
       · 正则 /await link\(…\);/ 命中 **2 处**（publishStagedObject / publishImmutableAlias）；
       · publishStagedObject / publishImmutableAlias / async function syncDirectory(path) {
         三处签名均存在。
     → 扫描式实现已兼容，**保持不动**。
     「collectSites()==0 即已完成」这条自愈判据在命中 2 处时**不会误判**：
     只有「marker 在位 **且** 裸 link 调用点已全部改写为 publishCopied」才短路；
     若上游再改结构导致调用点消失，collectSites() 归零会让补丁**重跑**（而非静默跳过），
     此时块内会打 'no bare link call site, nothing to rewrite' 或
     'helper def anchor miss' 的显式 WARN——这正是需要的可诊断性。 */
  try {
    const attLocal = findPkg('@deepseek-ai/dsh-attachment-local', 'lib/index.js');
    /* 匹配 `await link(<from>, <target>);`：from/target 均为简单标识符或成员访问，
       不含嵌套括号，避免误伤非发布用途的 link 调用。 */
    const LINK_CALL_SRC = 'await link\\(([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*), ([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\);';
    /**
     * 定位已安装 helper `publishCopied` 的函数体区间 [start, end)。
     * **必须排除该区间**：helper 体内本身含一句 `await link(from, target);`，
     * 若把它也当成待改写调用点，第二次运行就会把 helper 改成自递归
     * （v5 开发期真实踩到：二次运行 rewritten=1 且 sha 变化）。
     * 用花括号配平求函数体，与 syncDirectory 的定位手法一致。
     */
    const helperSpan = (text) => {
      const sig = 'async function publishCopied(';
      const i = text.indexOf(sig);
      if (i === -1) return null;
      let depth = 0, seen = false;
      for (let k = i; k < text.length; k++) {
        const c = text[k];
        if (c === '{') { depth++; seen = true; }
        else if (c === '}') { depth--; if (seen && depth === 0) return { start: i, end: k + 1 }; }
      }
      return { start: i, end: text.length };
    };
    /** 收集 helper 体之外的裸 link 发布调用点。 */
    const collectSites = (text) => {
      const span = helperSpan(text);
      const re = new RegExp(LINK_CALL_SRC, 'g');
      const out = [];
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (span && mm.index >= span.start && mm.index < span.end) continue; /* helper 自身，跳过 */
        out.push({ from: mm[1], target: mm[2], text: mm[0] });
      }
      return out;
    };
    const hasMarker = (t) => t.includes('dsh-launcher-android-att-vision-v5');
    if (!attLocal) {
      log('attachment-local: not found, skip vision patch');
    } else if (hasMarker(readFileSync(attLocal, 'utf8')) && collectSites(readFileSync(attLocal, 'utf8')).length === 0) {
      log('attachment-local vision patch already applied');
    } else {
      let src = readFileSync(attLocal, 'utf8');

      /* 自愈前置：若当前文件本身语法已损坏（v2/v3 毒化），先尝试用括号配平
         重建 syncDirectory 区域，再继续标准补丁；重建失败则放弃写盘并提示。 */
      const checkCurrent = (function () {
        const tmp2 = attLocal + '.v4cur.mjs';
        try {
          writeFileSync(tmp2, src);
          const r2 = spawnSync(process.execPath, ['--check', tmp2], { timeout: 15000, encoding: 'utf8' });
          return r2.status === 0;
        } catch (e) {
          return true; /* spawnSync 不可用时假定当前文件可用，走标准流程 */
        } finally {
          try { unlinkSync(tmp2); } catch {}
        }
      })();
      if (!checkCurrent) log('attachment-local v4: current file syntax broken, attempting repair');

      /* 用括号配平定位 syncDirectory 完整函数体：从函数签名起，逐字符累计 { }，
         深度归零时即函数结束。兼容体内任意注释/嵌套，不依赖后继锚点。 */
      const SYNC_START = 'async function syncDirectory(path) {';
      let si = src.indexOf(SYNC_START);
      let se = -1;
      if (si !== -1) {
        let depth = 0;
        for (let i = si; i < src.length; i++) {
          const c = src[i];
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { se = i + 1; break; } }
        }
      }
      const seg = si !== -1 && se > si ? src.slice(si, se) : '';
      if (seg && seg.length <= 4096 && seg.includes('handle')) {
        src = src.slice(0, si) + [
          'async function syncDirectory(path) {',
          '\tif (process.platform === "win32") return;',
          '\tlet handle;',
          '\ttry {',
          '\t\thandle = await open(path, constants.O_RDONLY);',
          '\t} catch (error) {',
          '\t\tif (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT" || error.code === "ENOTDIR")) return;',
          '\t\tthrow error;',
          '\t}',
          '\ttry { await handle.sync(); } catch (error) { await handle.close().catch(() => {}); if (process.platform === "android") return; throw error; }',
          '\tawait handle.close().catch(() => {});',
          '}'
        ].join('\n') + '\n' + src.slice(se);
      } else {
        log('WARN vision patch v4: syncDirectory segment not located, leave as-is');
      }

      /* 清理 v2 毒化残留：syncDirectory 之后可能残留孤立的 `} finally { ... }` 块
         （v2 正则替换半个函数留下的），它们会造成语法错误。用非贪婪正则删除
         syncDirectory 结尾 } 之后、下一个 /** 注释之前的孤儿 finally 块。 */
      const orphanRe = /\n[ \t]*finally \{[\s\S]*?\n\t\}(?=\n[ \t]*\/\* v8 ignore|\n[ \t]*\/\*\*|\n[ \t]*\/\/)/;
      const orphanMatch = orphanRe.exec(src);
      if (orphanMatch) {
        log('attachment-local v4: removing orphan finally block: ' + JSON.stringify(orphanMatch[0].slice(0, 60)));
        src = src.replace(orphanRe, '');
      }
      /* v2 毒化的另一半残留：孤儿 finally 之后的 v8-ignore-stop 注释 + 孤儿 }，
         它们会让后续函数（ensureDurableHome）的括号失衡。同样在下一个 /** 前删除。 */
      const orphanCloseRe = /\n[ \t]*\/\* v8 ignore stop \*\/\n[ \t]*\}(?=\n[ \t]*\/\*\*)/;
      const orphanClose = orphanCloseRe.exec(src);
      if (orphanClose) {
        log('attachment-local v4: removing orphan close brace: ' + JSON.stringify(orphanClose[0].slice(0, 60)));
        src = src.replace(orphanCloseRe, '');
      }

      /* link 发布回退：SELinux 拒绝应用 uid 的 link(2)（真机实测：应用私有存储
         上同为 EACCES，不只是 sdcard FUSE），必须回退 copy。

         v5 改为**扫描式**改写，不再锚定单一调用点字面量：
         上游 0.1.5 把发布链路重构成 publishStagedObject(root,target,staged) 与
         publishImmutableAlias(root,source,target,sha256) 两个 link 调用点，
         旧的单锚点 'await link(temporary, target);' 直接消失 → v4 静默失效
         （只打一行 WARN，图片/附件链路在真机上必挂）。扫描式改写对上游后续
         再拆分/重命名同样有效，且每个调用点各自用其作用域内的实参。

         helper 语义按调用点实参推导：link(from, target) 之后上游会 unlink(from)
         （staged/source 是暂存名），故 helper 负责「copy 成功后由调用方 unlink」；
         EEXIST 去重与 digest 校验语义与上游一致。 */
      {
        const defAnchor = '/**\n* Publish one already verified normalized image';
        const di = src.indexOf(defAnchor);
        /* 用外层 collectSites（已排除 helper 自身函数体，避免自递归） */
        let sites = collectSites(src);
        /* 兼容 v2/v3 毒化残留：调用点已被改写但 helper 定义缺失时，先还原为 link 调用 */
        if (!src.includes('async function publishCopied(') && src.includes('await publishCopied(temporary, target, sha256);')) {
          src = src.replace('await publishCopied(temporary, target, sha256);', 'await link(temporary, target);');
          log('vision patch v5: restored v2-orphaned publishCopied call');
          sites = collectSites();
        }
        /* 关键：helper 已存在（v4 遗留）时**仍须改写裸调用点**——上游换版后
           helper 在位、调用点却是裸 link，正是 0.1.5 的真实失效现场。
           v4 helper 形参为 (temporary, target, sha256)，与 v5 位置语义一致，
           故同一调用形式对两者都成立。 */
        const hasHelper = src.includes('async function publishCopied(');
        if (di === -1 && !hasHelper) {
          log('WARN vision patch v5: helper def anchor miss (def=false), leave as-is');
        } else if (sites.length === 0) {
          log('vision patch v5: no bare link call site, nothing to rewrite');
        } else {
          /* 先改写全部调用点、后插入 helper：helper 内部同样含 await link 字面量，
             先插后换会把 helper 自身也改写掉（自递归）。用字符串替换避免索引错位。 */
          let rewritten = 0;
          for (const s of sites) {
            /* sha256 实参按调用点作用域推导：
               publishImmutableAlias(root, source, target, sha256) → from=source，用 sha256；
               publishStagedObject(root, target, staged)          → from=staged.path，用 staged.sha256。 */
            const sha = s.from.startsWith('staged.') ? 'staged.sha256' : 'sha256';
            const repl = 'await publishCopied(' + s.from + ', ' + s.target + ', ' + sha + ');';
            if (src.includes(s.text)) { src = src.replace(s.text, repl); rewritten++; }
          }
          if (rewritten === 0) {
            log('WARN vision patch v5: link call rewrite miss');
          } else {
            /* copyFile 回退分支需要；仅当尚未导入时追加 */
            if (!src.includes('copyFile')) {
              const impA = '} from "node:fs/promises";';
              if (src.includes(impA)) src = src.replace(impA, ', copyFile' + impA);
              else log('WARN vision patch v5: fs/promises import anchor miss');
            }
            if (!hasHelper) {
              const helper = [
                '/** dsh-launcher-android-att-vision-v5: link 优先；SELinux/FUSE 环境回退 copy，',
                '* 复制中途失败清理半写 target 防止内容寻址路径被毒化。 */',
                'async function publishCopied(from, target, sha256) {',
                '\ttry {',
                '\t\tawait link(from, target);',
                '\t\treturn;',
                '\t} catch (linkError) {',
                '\t\tconst code = linkError instanceof Error && "code" in linkError ? linkError.code : void 0;',
                '\t\tif (code === "EEXIST") {',
                '\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
                '\t\t\treturn;',
                '\t\t}',
                '\t\tif (!(code === "EACCES" || code === "EPERM" || code === "ENOSYS" || code === "EXDEV")) throw linkError;',
                '\t\ttry { await copyFile(from, target); } catch (copyError) {',
                '\t\t\tawait unlink(target).catch(() => {});',
                '\t\t\tthrow copyError;',
                '\t\t}',
                '\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) {',
                '\t\t\tawait unlink(target).catch(() => {});',
                '\t\t\tthrow new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
                '\t\t}',
                '\t}',
                '}'
              ].join('\n');
              if (di === -1) src = helper + '\n' + src;
              else src = src.replace(defAnchor, helper + '\n' + defAnchor);
            }
            log('vision patch v5: publishCopied installed=' + (!hasHelper) + ', link call sites rewritten=' + rewritten);
          }
        }
      }

      /* 写入前语法自检：写临时文件 + node --check，失败则放弃写盘（防止再毒化）。
         ESM 文件 node --check 会校验语法；若 spawnSync 不可用则降级为括号配平检查。 */
      const tmpPath = attLocal + '.v5check.mjs';
      let syntaxOk = false;
      try {
        writeFileSync(tmpPath, src);
        const r = spawnSync(process.execPath, ['--check', tmpPath], { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) syntaxOk = true;
        else log('WARN attachment-local v5 syntax check FAILED: ' + (r.stderr || '').slice(0, 300));
      } catch (e) {
        log('WARN attachment-local v5 syntax check unavailable: ' + e.message);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
      if (syntaxOk) {
        /* 旧版本标记（v1~v4 遗留）统一升级到 v5，保证幂等短路用的是当前判据。
           注意：仅升级 marker 字符串，调用点改写是否完成由外层判据另行校验。 */
        src = src.replace(/att-vision-v[1-4]/g, 'att-vision-v5');
        writeFileSync(attLocal, src);
        log('attachment-local vision patch v5 applied: ' + attLocal);
      } else {
        log('WARN attachment-local vision patch v5: syntax check failed, file NOT modified: ' + attLocal);
      }
    }
  } catch (e) { log('WARN attachment-local vision: ' + e.message); }

/* apiproxy WEB_SETTINGS_NAMESPACES += vision 补丁已移除（v4.10 审计）：
 * 上游 0.1.x 已无该常量，补丁永远命中 "pattern not found, skip" 死分支；
 * dsh-vision 现通过 @deepseek-ai/dsh-settings 的 settingsNamespace('vision')
 * 直接注册设置命名空间，无需 api 网关白名单。 */

/* ---------------------------------------------------------------------------
 * llm-pi-ai sendAttribution 抑制缝隙（**已针对 0.1.7-rc.2 核实**）
 *
 * 为什么还需要这个补丁：dsh-provider-headers 内置插件的「发送归因请求头」
 * 开关把 `providers.<route>.sendAttribution = false` 写进 profile，期望不再注入
 * `deepseek-harness/…` User-Agent。但上游 @deepseek-ai/dsh-llm 的
 * attributionHeaders() 签名是 `(identity = APP_IDENTITY)`，注释明写
 * “omission cannot suppress attribution”；pi-ai 侧 requestHeaders() 又无条件把
 * 归因头**合并覆盖**在用户 headers 之上（按小写名去重，用户设了同名头也会被顶掉）。
 * → 该开关在 0.1.7-rc.2 上仍然无效，上游未提供抑制缝隙，只能就地插桩。
 *
 * 0.1.7-rc.2 锚点实测（dsh-llm-pi-ai/lib/index.js，113953 字节）：
 *   · `headers: z.dict(z.string()),`                  → 命中 1 处（profile schema，行 1024）
 *   · `function requestHeaders(headers) {`            → 命中 1 处（行 1733）
 *   · `headers: requestHeaders(profile.headers)`      → 命中 1 处（流式请求，行 1883）
 *   · 归因头注入**共 2 处**：上述流式请求，以及模型探测 discoverModels() 的
 *     `for (const [name, value] of Object.entries(attributionHeaders())) headers.set(...)`
 *     （行 2308）。**旧版补丁只覆盖了前者**，探测请求仍带归因头 —— 本次补齐。
 *   · 旧锚点 `sendAttribution: z.boolean().optional(),` → **0 处**：0.1.5 起就不存在，
 *     属历史死分支（每轮都白跑一次 replace），本次删除。
 *   · 结论：上游**未**原生支持抑制，补丁保留（不是「为了适配而硬打」）。
 *
 * 做法（6 个锚点，全部命中才写盘；缺任一即显式 WARN 并放弃，避免半套补丁）：
 *   1) profile schema 声明 sendAttribution（default true，与「未设置即发送」同义）；
 *   2) requestHeaders 增加第二参数，false 时直接返回用户 headers，不合并归因头；
 *   3) 流式请求调用点传入 profile.sendAttribution；
 *   4) 探测链路分流：storedDiscoveryProfile() 透出 sendAttribution，
 *      discoverModels() 据其决定是否注入归因头。
 *
 * 幂等 marker 写在文件头（`// dsh-launcher-android-pi-ai-send-attribution`），
 * 与 fs-local / plugin-compat 的 marker 写法一致。
 * ------------------------------------------------------------------------- */
try {
  const MARKER_PI = 'dsh-launcher-android-pi-ai-send-attribution';
  const pi = findPkg('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js');
  if (!pi) {
    log('llm-pi-ai: not found, skip sendAttribution patch');
  } else {
    let src = readFileSync(pi, 'utf8');
    if (src.includes(MARKER_PI)) {
      log('llm-pi-ai sendAttribution already patched');
    } else {
      let out = src;
      let hits = 0;
      /* 逐锚点替换：每个锚点单独报命中/未命中，避免「整体 replace 后 out===src」
         这种只说「pattern not found」却不知是哪一条漂移的含糊日志。 */
      const apply = (label, re, to) => {
        const before = out;
        out = out.replace(re, to);
        if (out !== before) { hits++; return true; }
        log('WARN llm-pi-ai sendAttribution: anchor MISS — ' + label);
        return false;
      };
      // 1) profile schema 声明字段
      apply('profile schema (headers: z.dict)',
        /headers: z\.dict\(z\.string\(\)\),/,
        'headers: z.dict(z.string()),\n\tsendAttribution: z.boolean().default(true),');
      // 2) requestHeaders 签名 + 函数体分流
      apply('requestHeaders signature',
        /function requestHeaders\(headers\) \{/,
        'function requestHeaders(headers, sendAttribution = true) {');
      apply('requestHeaders body guard',
        /function requestHeaders\(headers, sendAttribution = true\) \{\n(\s*)const attribution = attributionHeaders\(\);/,
        (m, indent) => m.replace(
          'const attribution = attributionHeaders();',
          `if (sendAttribution === false) return { ...(headers ?? {}) };\n${indent}const attribution = attributionHeaders();`
        ));
      // 3) 流式请求调用点
      apply('stream requestHeaders call',
        /headers: requestHeaders\(profile\.headers\)/,
        'headers: requestHeaders(profile.headers, profile.sendAttribution)');
      // 4) 模型探测链路（0.1.7 新增覆盖）
      apply('discovery attribution injection',
        /for \(const \[name, value\] of Object\.entries\(attributionHeaders\(\)\)\) headers\.set\(name, value\);/,
        'if (stored?.sendAttribution !== false) for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value);');
      apply('discovery profile passthrough',
        /return \{\n\t\t\theaders: profile\.headers,\n\t\t\tresolveApiKey: \(\) => resolveApiKey\(provider, profile\)\n\t\t\};/,
        'return {\n\t\t\theaders: profile.headers,\n\t\t\tsendAttribution: profile.sendAttribution,\n\t\t\tresolveApiKey: () => resolveApiKey(provider, profile)\n\t\t};');

      const EXPECTED = 6;
      if (hits < EXPECTED) {
        log('WARN llm-pi-ai sendAttribution: only ' + hits + '/' + EXPECTED +
            ' anchors hit — file NOT modified (上游结构又漂移了，需重新对表)');
      } else {
        // 写盘前语法自检（与 attachment-local / plugin-compat 同手法）
        const tmp = pi + '.pi-check.mjs';
        let ok = false;
        try {
          writeFileSync(tmp, out);
          const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
          ok = r.status === 0;
          if (!ok) log('WARN llm-pi-ai sendAttribution syntax check FAILED: ' + (r.stderr || '').slice(0, 200));
        } catch (e) {
          log('WARN llm-pi-ai sendAttribution syntax check unavailable: ' + e.message);
        } finally {
          try { unlinkSync(tmp); } catch {}
        }
        if (ok) {
          writeFileSync(pi, '// ' + MARKER_PI + '\n' + out);
          log('llm-pi-ai sendAttribution patched: ' + hits + '/' + EXPECTED +
              ' anchors (schema + requestHeaders + stream call + discovery x2)');
        } else {
          log('WARN llm-pi-ai sendAttribution: syntax check failed, file NOT modified');
        }
      }
    }
  }
} catch (e) { log('WARN llm-pi-ai sendAttribution: ' + e.message); }

try {
  /* koffi ABI 断言禁用：koffi 已被 stub 顶替（见上文 koffi ESM/CJS stub），
     其 struct().size 恒为 0，而上游在 import 期就断言 STARTUPINFOW=104 /
     PROCESS_INFORMATION=24 → **抛错发生在模块加载期**，Cordis 会把整棵插件树
     判为 failed to apply，web 直接起不来（不是降级，是硬失败）。

     0.1.5 把断言从 dsh-sandbox-windows-acl **搬到了新包** dsh-win32-process，
     旧包只剩同名的无断言实现。只扫旧包会命中 0 处（日志 'asserts disabled: 0'
     看起来无害），实际 boot 必崩——故改为**按包名清单遍历**，新旧两包都扫，
     并对「包在但一处未命中」发出显式 WARN（避免再次静默漂移）。

     **已针对 0.1.7-rc.2 核实**（0.1.7 安装树实测）：
       · @deepseek-ai/dsh-win32-process/lib/index.js → 'layout mismatch' 命中 **2 处**
         （行 71 STARTUPINFOW / 行 72 PROCESS_INFORMATION，文本与下方正则一致）；
       · @deepseek-ai/dsh-sandbox-windows-acl → 命中 **0 处**（该包在 0.1.7 已无断言）。
     → 按包名清单遍历两包的实现**已兼容 0.1.7，保持不动**；日志会打
       'koffi ABI asserts disabled: 2 (pkgs: …)'，若归零则显式 WARN（boot 必崩）。 */
  const ABI_PKGS = ['@deepseek-ai/dsh-sandbox-windows-acl', '@deepseek-ai/dsh-win32-process'];
  const foundPkgs = [];
  let totalPatched = 0;
  let totalAlready = 0;  // 全部包合计「已禁用」的断言条数（幂等判据用）
  for (const name of ABI_PKGS) {
    const w = findPkg(name, 'lib') || findPkg(name, 'lib/index.js');
    if (!w) continue;
    const dir = existsSync(w) && w.endsWith('.js') ? dirname(w) : w;
    if (!existsSync(dir)) continue;
    foundPkgs.push(name);
    let patched = 0;       // 本次实际禁用的**断言条数**（非文件数：0.1.7 两处断言同在一个文件）
    let sawAssert = 0;     // 文件里出现 'layout mismatch' 的处数
    let alreadyDone = 0;   // 已被本补丁禁用过的断言条数（二次运行 / 重装后重跑）
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const p = join(dir, f);
      const src = readFileSync(p, 'utf8');
      /* 已被本补丁处理过：断言文本已被替换成 marker 注释。
         必须单独计数，否则二次运行会看到 sawAssert=0 而误报「boot 必崩」。 */
      alreadyDone += (src.match(/dsh-launcher: koffi stubbed,/g) || []).length;
      if (!src.includes('layout mismatch')) continue;
      let out = src;
      out = out.replace(/if \(STARTUPINFOW\.size !== 104\) throw new Error\(`STARTUPINFOW layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, STARTUPINFOW assert disabled */');
      out = out.replace(/if \(PROCESS_INFORMATION\.size !== 24\) throw new Error\(`PROCESS_INFORMATION layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, PROCESS_INFORMATION assert disabled */');
      if (out !== src) {
        /* 断言条数 = 原文出现 'layout mismatch' 的次数（0.1.7 实测同一文件 2 处）。
           用 match 计数，避免把「文件数」误报成「断言数」。 */
        const n = (src.match(/layout mismatch/g) || []).length;
        sawAssert += n;
        patched += n;
        writeFileSync(p, out);
      } else {
        sawAssert += (src.match(/layout mismatch/g) || []).length;
      }
    }
    if (sawAssert > 0 && patched === 0) log(`WARN koffi-abi: ${name} has ${sawAssert} layout assertion(s) but none matched the disable patterns`);
    totalPatched += patched;
    totalAlready += alreadyDone;
  }
  if (foundPkgs.length === 0) {
    log('WARN koffi-abi: none of the ABI-assert packages found (koffi stub may leave boot broken)');
  } else if (totalAlready > 0) {
    /* 断言已在位（本次禁用 0 条是**正常**的幂等结果，不是漂移）。
       旧实现只判 totalPatched===0，导致二次运行恒打「boot may fail」假警报。 */
    log('koffi ABI asserts already disabled: ' + totalAlready + ' (pkgs: ' + foundPkgs.join(', ') + ')');
  } else {
    log('koffi ABI asserts disabled: ' + totalPatched + ' (pkgs: ' + foundPkgs.join(', ') + ')');
    /* 关键护栏：若扫到包、断言文本在、却一条都没禁用，说明文本又漂移了——
       此时 boot 必崩，大声报出来（这是 0.1.5 适配期真实踩到的静默失效点）。 */
    if (totalPatched === 0) log('WARN koffi-abi: no assertion disabled across ' + foundPkgs.join(', ') + ' — dsh boot may fail at plugin load');
  }
} catch (e) { log('WARN koffi-abi: ' + e.message); }

try {
  // WebView / 旧 Chrome 前端 API 补齐（**已针对 0.1.7-rc.2 核实**）。
  //
  // 真机实测（Android 11 / 系统 WebView 94）dsh 0.1.7 前端一启动即抛：
  //   Uncaught TypeError: Promise.withResolvers is not a function        （需 Chrome 119+）
  //   Uncaught (in promise) TypeError: AbortSignal.any is not a function（需 Chrome 116+）
  //   AbortSignal.timeout                                                （需 Chrome 103+）
  // → 页面停在引导骨架，UI 完全不可交互。
  //
  // v4.10 起曾把注入改成「按需」：只在 dist 内 app bundle 命中字面量时才写 index.html。
  // **该判据在 0.1.7 上失效**：消费者在**插件 client bundle**（/plugins/**/client.js）里，
  // 不在 app bundle —— 实测扫描 0 命中并跳过注入，页面照旧崩（真机 console 实拍）。
  // 故改回无条件注入，但整段由 `if(!X)` 守卫包裹：新版 WebView 上逐条 no-op，
  // 不覆盖原生实现，代价只有几行 HTML。
  //
  // 必须留在引导期脚本里：polyfill 要早于 /assets/index-*.js 与模块系统条目执行，
  // client 插件通道时序上做不到。
  const idx = findPkg('@deepseek-ai/dsh-web-frontend', 'dist/index.html');
  if (idx && existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    if (html.includes('dsh-webview-compat-shim')) {
      log('index.html shim already present');
    } else if (!html.includes('<head>')) {
      log('WARN index.html has no <head>, skip shim');
    } else {
      // payload 以 base64 内嵌：内含引号与尖括号，直接内联字符串极易转义出错
      // （与 koffi / node-pty / narb 的写法一致）；且必须分块——单行过长会被截断写坏。
      const SHIM_HTML_B64 =
        'PHNjcmlwdCBpZD0iZHNoLXdlYnZpZXctY29tcGF0LXNoaW0iPihmdW5jdGlvbigpewogIHZhciBn' +
        'PXR5cGVvZiBnbG9iYWxUaGlzIT09J3VuZGVmaW5lZCc/Z2xvYmFsVGhpczp3aW5kb3c7CiAgaWYo' +
        'IVByb21pc2Uud2l0aFJlc29sdmVycyl7UHJvbWlzZS53aXRoUmVzb2x2ZXJzPWZ1bmN0aW9uKCl7' +
        'dmFyIHJlcyxyZWo7dmFyIHA9bmV3IFByb21pc2UoZnVuY3Rpb24oYSxiKXtyZXM9YTtyZWo9Yjt9' +
        'KTtyZXR1cm57cHJvbWlzZTpwLHJlc29sdmU6cmVzLHJlamVjdDpyZWp9O307fQogIGlmKCFBYm9y' +
        'dFNpZ25hbC50aW1lb3V0KXtBYm9ydFNpZ25hbC50aW1lb3V0PWZ1bmN0aW9uKG1zKXt2YXIgYz1u' +
        'ZXcgQWJvcnRDb250cm9sbGVyKCk7c2V0VGltZW91dChmdW5jdGlvbigpe2MuYWJvcnQobmV3IERP' +
        'TUV4Y2VwdGlvbignVGltZW91dEVycm9yJywnVGltZW91dEVycm9yJykpO30sbXMpO3JldHVybiBj' +
        'LnNpZ25hbDt9O30KICBpZighQWJvcnRTaWduYWwuYW55KXtBYm9ydFNpZ25hbC5hbnk9ZnVuY3Rp' +
        'b24oc2lncyl7dmFyIGM9bmV3IEFib3J0Q29udHJvbGxlcigpO2Zvcih2YXIgaT0wO2k8c2lncy5s' +
        'ZW5ndGg7aSsrKXt2YXIgcz1zaWdzW2ldO2lmKHMuYWJvcnRlZCl7Yy5hYm9ydChzLnJlYXNvbik7' +
        'YnJlYWs7fShmdW5jdGlvbihzaWcpe3NpZy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsZnVuY3Rp' +
        'b24oKXtpZighYy5zaWduYWwuYWJvcnRlZCljLmFib3J0KHNpZy5yZWFzb24pO30se29uY2U6dHJ1' +
        'ZX0pO30pKHMpO31yZXR1cm4gYy5zaWduYWw7fTt9CiAgaWYoIUFib3J0U2lnbmFsLnByb3RvdHlw' +
        'ZS50aHJvd0lmQWJvcnRlZCl7QWJvcnRTaWduYWwucHJvdG90eXBlLnRocm93SWZBYm9ydGVkPWZ1' +
        'bmN0aW9uKCl7aWYodGhpcy5hYm9ydGVkKXRocm93IHRoaXMucmVhc29uIT09dW5kZWZpbmVkP3Ro' +
        'aXMucmVhc29uOm5ldyBET01FeGNlcHRpb24oJ1RoZSBvcGVyYXRpb24gd2FzIGFib3J0ZWQuJywn' +
        'QWJvcnRFcnJvcicpO307fQogIGlmKCFBcnJheS5wcm90b3R5cGUuYXQpe0FycmF5LnByb3RvdHlw' +
        'ZS5hdD1mdW5jdGlvbihuKXtuPU1hdGgudHJ1bmMobil8fDA7aWYobjwwKW4rPXRoaXMubGVuZ3Ro' +
        'O3JldHVybiBuPDB8fG4+PXRoaXMubGVuZ3RoP3VuZGVmaW5lZDp0aGlzW25dO307fQogIGlmKCFT' +
        'dHJpbmcucHJvdG90eXBlLmF0KXtTdHJpbmcucHJvdG90eXBlLmF0PWZ1bmN0aW9uKG4pe249TWF0' +
        'aC50cnVuYyhuKXx8MDtpZihuPDApbis9dGhpcy5sZW5ndGg7cmV0dXJuIG48MHx8bj49dGhpcy5s' +
        'ZW5ndGg/dW5kZWZpbmVkOnRoaXMuY2hhckF0KG4pO307fQogIGlmKCFBcnJheS5wcm90b3R5cGUu' +
        'ZmluZExhc3Qpe0FycmF5LnByb3RvdHlwZS5maW5kTGFzdD1mdW5jdGlvbihmLHQpe2Zvcih2YXIg' +
        'aT10aGlzLmxlbmd0aC0xO2k+PTA7aS0tKXtpZihmLmNhbGwodCx0aGlzW2ldLGksdGhpcykpcmV0' +
        'dXJuIHRoaXNbaV07fXJldHVybiB1bmRlZmluZWQ7fTt9CiAgaWYoIUFycmF5LnByb3RvdHlwZS5m' +
        'aW5kTGFzdEluZGV4KXtBcnJheS5wcm90b3R5cGUuZmluZExhc3RJbmRleD1mdW5jdGlvbihmLHQp' +
        'e2Zvcih2YXIgaT10aGlzLmxlbmd0aC0xO2k+PTA7aS0tKXtpZihmLmNhbGwodCx0aGlzW2ldLGks' +
        'dGhpcykpcmV0dXJuIGk7fXJldHVybiAtMTt9O30KICBpZighT2JqZWN0Lmhhc093bil7T2JqZWN0' +
        'Lmhhc093bj1mdW5jdGlvbihvLGspe3JldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3Bl' +
        'cnR5LmNhbGwobyxrKTt9O30KICBpZighQXJyYXkucHJvdG90eXBlLnRvU29ydGVkKXtBcnJheS5w' +
        'cm90b3R5cGUudG9Tb3J0ZWQ9ZnVuY3Rpb24oYyl7cmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGlj' +
        'ZS5jYWxsKHRoaXMpLnNvcnQoYyk7fTt9CiAgaWYoIUFycmF5LnByb3RvdHlwZS50b1JldmVyc2Vk' +
        'KXtBcnJheS5wcm90b3R5cGUudG9SZXZlcnNlZD1mdW5jdGlvbigpe3JldHVybiBBcnJheS5wcm90' +
        'b3R5cGUuc2xpY2UuY2FsbCh0aGlzKS5yZXZlcnNlKCk7fTt9CiAgaWYoIUFycmF5LnByb3RvdHlw' +
        'ZS53aXRoKXtBcnJheS5wcm90b3R5cGUud2l0aD1mdW5jdGlvbihpLHYpe3ZhciBhPUFycmF5LnBy' +
        'b3RvdHlwZS5zbGljZS5jYWxsKHRoaXMpO2k9TWF0aC50cnVuYyhpKXx8MDtpZihpPDApaSs9YS5s' +
        'ZW5ndGg7YVtpXT12O3JldHVybiBhO307fQogIGlmKHR5cGVvZiBnLnN0cnVjdHVyZWRDbG9uZT09' +
        'PSd1bmRlZmluZWQnKXsKICAgIGcuc3RydWN0dXJlZENsb25lPWZ1bmN0aW9uKHYpewogICAgICBp' +
        'Zih2PT09bnVsbHx8dHlwZW9mIHYhPT0nb2JqZWN0JylyZXR1cm4gdjsKICAgICAgaWYodHlwZW9m' +
        'IHY9PT0nZnVuY3Rpb24nfHx0eXBlb2Ygdj09PSdzeW1ib2wnKXRocm93IG5ldyBET01FeGNlcHRp' +
        'b24oJ2NvdWxkIG5vdCBiZSBjbG9uZWQnLCdEYXRhQ2xvbmVFcnJvcicpOwogICAgICBpZih2IGlu' +
        'c3RhbmNlb2YgRGF0ZSlyZXR1cm4gbmV3IERhdGUodi5nZXRUaW1lKCkpOwogICAgICBpZih2IGlu' +
        'c3RhbmNlb2YgUmVnRXhwKXJldHVybiBuZXcgUmVnRXhwKHYuc291cmNlLHYuZmxhZ3MpOwogICAg' +
        'ICBpZih2IGluc3RhbmNlb2YgTWFwKXt2YXIgbT1uZXcgTWFwKCk7di5mb3JFYWNoKGZ1bmN0aW9u' +
        'KHgsayl7bS5zZXQoZy5zdHJ1Y3R1cmVkQ2xvbmUoayksZy5zdHJ1Y3R1cmVkQ2xvbmUoeCkpO30p' +
        'O3JldHVybiBtO30KICAgICAgaWYodiBpbnN0YW5jZW9mIFNldCl7dmFyIHN0PW5ldyBTZXQoKTt2' +
        'LmZvckVhY2goZnVuY3Rpb24oeCl7c3QuYWRkKGcuc3RydWN0dXJlZENsb25lKHgpKTt9KTtyZXR1' +
        'cm4gc3Q7fQogICAgICBpZih2IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpcmV0dXJuIHYuc2xpY2Uo' +
        'MCk7CiAgICAgIGlmKEFycmF5QnVmZmVyLmlzVmlldyh2KSlyZXR1cm4gbmV3IHYuY29uc3RydWN0' +
        'b3IoZy5zdHJ1Y3R1cmVkQ2xvbmUodi5idWZmZXIpLHYuYnl0ZU9mZnNldCx2Lmxlbmd0aCk7CiAg' +
        'ICAgIGlmKEFycmF5LmlzQXJyYXkodikpcmV0dXJuIHYubWFwKGcuc3RydWN0dXJlZENsb25lKTsK' +
        'ICAgICAgdmFyIG91dD17fTtmb3IodmFyIGsgaW4gdil7aWYoT2JqZWN0LnByb3RvdHlwZS5oYXNP' +
        'd25Qcm9wZXJ0eS5jYWxsKHYsaykpb3V0W2tdPWcuc3RydWN0dXJlZENsb25lKHZba10pO31yZXR1' +
        'cm4gb3V0OwogICAgfTsKICB9CiAgaWYoIU9iamVjdC5ncm91cEJ5KXtPYmplY3QuZ3JvdXBCeT1m' +
        'dW5jdGlvbihpdGVtcyxrZXkpe3ZhciBvPU9iamVjdC5jcmVhdGUobnVsbCk7dmFyIGk9MDtmb3Io' +
        'dmFyIGl0IG9mIGl0ZW1zKXt2YXIgaz1rZXkoaXQsaSsrKTtpZighT2JqZWN0LnByb3RvdHlwZS5o' +
        'YXNPd25Qcm9wZXJ0eS5jYWxsKG8saykpb1trXT1bXTtvW2tdLnB1c2goaXQpO31yZXR1cm4gbzt9' +
        'O30KICBpZighTWFwLmdyb3VwQnkpe01hcC5ncm91cEJ5PWZ1bmN0aW9uKGl0ZW1zLGtleSl7dmFy' +
        'IG09bmV3IE1hcCgpO3ZhciBpPTA7Zm9yKHZhciBpdCBvZiBpdGVtcyl7dmFyIGs9a2V5KGl0LGkr' +
        'Kyk7dmFyIGE9bS5nZXQoayk7aWYoYSlhLnB1c2goaXQpO2Vsc2UgbS5zZXQoayxbaXRdKTt9cmV0' +
        'dXJuIG07fTt9Cn0pKCk7PC9zY3JpcHQ+' ;
      const shim = Buffer.from(SHIM_HTML_B64, 'base64').toString('utf8');
      html = html.replace('<head>', '<head>' + shim);
      writeFileSync(idx, html);
      log('index.html WebView compat shim injected (withResolvers/any/timeout)');
    }
  } else {
    log('dsh-web-frontend dist not found, skip shim');
  }
} catch (e) { log('WARN index shim: ' + e.message); }

try {
  // CodeBuddy 共存 Provider 的编辑布局：settings-models 客户端按命名空间白名单
  // 选择 Provider 编辑器布局（layoutOf：llm-deepseek→deepseek、llm-pi-ai→pi-ai，
  // 其余→unknown）。unknown 布局只渲染“高级提示”且保存按钮永久禁用，卡片无法
  // 填写/保存。dsh-llm-codebuddy 内置插件以独立命名空间 llm-codebuddy 与内置
  // llm-pi-ai 共存（互不抢占 settings 注册），必须让客户端把它按 pi-ai 布局渲染。
  // 必须留在引导期脚本里：layoutOf 是编译产物内的闭包函数，client 插件通道改不到。
  //
  // 已针对 0.1.7-rc.2 核实：锚点 'if (ns === "llm-pi-ai") return "pi-ai";' 在
  // @deepseek-ai/dsh-client-ui-settings-models@0.1.7-rc.2/lib/client.js 中**命中 1 处**
  // → 保持不动。锚点缺失时打 'WARN settings-models layoutOf pattern not found'（可诊断）。
  //
  // 消费者说明（0.1.7 改造后）：本补丁服务的是 **dsh-llm-codebuddy**。该插件本次改造后
  // **不再内置**（代码保留在 assets/optional-plugins/dsh-llm-codebuddy，默认不装配），
  // 因此当前**无内置消费者**，仅服务于用户手动装配 codebuddy 的场景。补丁保留不删。
  const smClient = findPkg('@deepseek-ai/dsh-client-ui-settings-models', 'lib/client.js');
  if (smClient && existsSync(smClient)) {
    let smSrc = readFileSync(smClient, 'utf8');
    if (smSrc.includes('llm-codebuddy") return "pi-ai"')) {
      log('settings-models codebuddy layout already patched');
    } else if (smSrc.includes('if (ns === "llm-pi-ai") return "pi-ai";')) {
      smSrc = smSrc.replace(
        'if (ns === "llm-pi-ai") return "pi-ai";',
        'if (ns === "llm-pi-ai") return "pi-ai";\n\t\t\tif (ns === "llm-codebuddy") return "pi-ai";'
      );
      writeFileSync(smClient, smSrc);
      log('settings-models codebuddy layout patched (llm-codebuddy -> pi-ai)');
    } else {
      log('WARN settings-models layoutOf pattern not found, skip (dsh 升级后需核对)');
    }
  } else {
    log('settings-models client not found, skip codebuddy layout patch');
  }
} catch (e) { log('WARN codebuddy layout patch: ' + e.message); }

try {
  // 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。@vscode/ripgrep 的解析器
  // 是整体覆写（整文件重写，含 rgPath 导出），不依赖上游字面量；0.1.7 仍由
  // dsh-tool-fs-search 消费。fallback 缺失时打 'not found, skip'（可诊断）。
  // @vscode/ripgrep：Android 没有 @vscode/ripgrep-android-arm64 平台包，
  // 导致 dsh-tool-fs-search 的 glob/grep 报 “ripgrep launch failed”。
  // 这里把解析器改为优先使用 Termux `pkg install -y ripgrep` 安装的原生 rg，
  // 缺失时才回退到 linux-arm64 静态二进制（由 install-dsh.mjs 安装到 dsh-prefix/node_modules）。
  const rgMain = findPkg('@vscode/ripgrep', 'lib/index.js');
  if (!rgMain) {
    log('@vscode/ripgrep: not found, skip android fallback');
  } else {
    const termuxRg = existsSync(join(HOME, 'termux/usr/bin/rg')) ? join(HOME, 'termux/usr/bin/rg') : null;
    const fallbackRg = termuxRg || findPkg('@vscode/ripgrep-linux-arm64', 'bin/rg');
    if (!fallbackRg) {
      log('@vscode/ripgrep: linux-arm64 fallback not found, skip (install-dsh should install it)');
    } else {
      const src = readFileSync(rgMain, 'utf8');
      if (src.includes('dsh-launcher-android-ripgrep-v2')) {
        log('@vscode/ripgrep android fallback already patched');
      } else {
        const patched = `// dsh-launcher-android-ripgrep-v2
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
const platformPkg = \`@vscode/ripgrep-\${process.platform}-\${arch}\`;
const FALLBACK_RG = ${JSON.stringify(fallbackRg)};

let resolved;
try {
  resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
  try {
    // Android 优先使用 Termux pkg 安装的原生 rg；缺失时再回退 linux-arm64 静态二进制。
    if (existsSync(FALLBACK_RG)) {
      resolved = FALLBACK_RG;
    } else {
      const fallbackPkg = \`@vscode/ripgrep-linux-\${arch}\`;
      resolved = require.resolve(\`\${fallbackPkg}/bin/\${binaryName}\`);
    }
  } catch {
    if (!resolved && existsSync(FALLBACK_RG)) resolved = FALLBACK_RG;
  }
}
if (!resolved) throw new Error(\`No ripgrep binary for \${process.platform}-\${arch}\`);

export const rgPath = resolved;
`;
        writeFileSync(rgMain, patched);
        log('@vscode/ripgrep android fallback patched: ' + rgMain);
      }
    }
  }
} catch (e) { log('WARN @vscode/ripgrep: ' + e.message); }

/* dsh-sandbox / dsh-sandbox-local 的 "/tmp"→TMPDIR 补丁已移除（v4.10 审计）：
 * 上游 writableRoots() 现原生并入 os.tmpdir()（Node 会优先读 TMPDIR 环境变量，
 * 启动器 web 进程恒导出应用私有 tmp），沙箱白名单无需再改写源码；
 * sandbox-local 的 --tmpfs/readWrite 分支依赖 bubblewrap，Android 上本就不可达。
 * 旧补丁在 rc.2 上零替换仍会向上游文件追加 marker 头，属纯污染。 */

try {
  // 已针对 0.1.7-rc.2 核实：dsh-fs-local@0.1.7-rc.2/lib/index.js 三处锚点
  // **全部命中 1 次**：
  //   'await chmod(stagingDir, 448);' / 'await handle.chmod(384);' /
  //   'if (mode !== void 0) await handle.chmod(mode);'
  // → **保持不动**。注意 0.1.7 同时新增了 @deepseek-ai/dsh-atomic-write，
  //   本补丁**不覆盖**它——该新包已在文件末尾单独评估（结论：无需补丁）。
  //
  // Android 共享存储（/storage/emulated/0，FUSE）不支持 chmod；dsh-fs-local 原子写
  // 会对临时 staging 目录/文件 chmod 0700/0600，导致 EACCES。这里把 chmod 改为
  // 遇到 EACCES/EPERM 时忽略（权限位在 FUSE 上本来也无法生效）。
  const MARKER_FS_CHMOD = 'dsh-launcher-android-fs-chmod';
  const fsLocal = findPkg('@deepseek-ai/dsh-fs-local', 'lib/index.js');
  if (fsLocal) {
    let src = readFileSync(fsLocal, 'utf8');
    if (src.includes(MARKER_FS_CHMOD)) {
      log('dsh-fs-local chmod already patched');
    } else {
      const guard = (expr) => `try { ${expr}; } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; }`;
      src = src.split('await chmod(stagingDir, 448);').join(guard('await chmod(stagingDir, 448)'));
      src = src.split('await handle.chmod(384);').join(guard('await handle.chmod(384)'));
      src = src.split('if (mode !== void 0) await handle.chmod(mode);').join(`if (mode !== void 0) { try { await handle.chmod(mode); } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; } }`);
      writeFileSync(fsLocal, `// ${MARKER_FS_CHMOD}\n` + src);
      log('dsh-fs-local chmod patched');
    }
  } else {
    log('dsh-fs-local: not found, skip chmod patch');
  }
} catch (e) { log('WARN dsh-fs-local chmod: ' + e.message); }

/* directory-picker-browse "SD Card" 条目补丁已移除（v4.10 审计）：
 * 改由独立内置插件 @dsh-external/dsh-android-links 在 HOME 下创建指向
 * /storage/emulated/0 的符号链接——browse 的 list() 原生保留符号链接项、
 * directoryRow() stat 跟随判定可进入，无需改动上游任何文件。
 * 插件经官方 `dsh plugin --profile web add` 装配（install-dsh.mjs 内置清单）。 */

// v4.8.1 资产清理：移除 patch-koffi.yml 占位写入——全仓库无任何消费方，
// koffi 已由上方 Proxy stub 直接顶替，无需禁用行文件。

/* ---------------------------------------------------------------------------
 * 内置插件源码兼容：@deepseek-ai/dsh-settings 在 0.1.5 收窄了导出面
 *
 * 0.1.1 导出 7 个符号，0.1.5 只剩 4 个（SettingsConflictError / SettingsProvider /
 * default / redactSecrets），以下两个被删除：
 *   - settingsNamespace(v)      —— 仅按 /^[a-z][a-z0-9-]*$/ 校验后原值返回
 *   - installSettingsSection(…) —— 能力下沉为 ctx.settings.installSection(…)
 *
 * **为什么必须在启动期就地改源码**：具名导入在 ESM **链接期**就抛
 * 「does not provide an export named …」，try/catch 兜不住，运行时探测也没机会执行；
 * 而这些插件装在 files/plugins/（dsh-vision 来自 prebuilt.tgz 解包），
 * 无法靠改 APK 内 assets 源修复——prebuilt.tgz 是 30MB 的 LFS 二进制。
 * 属「本机专有缺陷 + 唯一可行修复点」，与 koffi/node-pty stub 同性质。
 *
 * **已针对 0.1.7-rc.2 核实**：
 *   · @deepseek-ai/dsh-settings@0.1.7-rc.2/lib/index.js 的导出实测为
 *       export { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets }
 *     → settingsNamespace / installSettingsSection **仍然不存在**，补丁**仍有必要，保持不动**。
 *   · 内置插件收缩为三个后（dsh-web-mobile / dsh-prompt-optimizer / dsh-codearts-auth），
 *     逐一实测其对 dsh-settings 的引用：
 *       - dsh-codearts-auth：lib/ 中 25 处 'settingsNamespace' 命中，但**全部是它自带的**
 *         settings-compat.js 里的 `settingsNamespaceFor()`（本地函数，且从 **'./settings-compat.js'**
 *         导入，**不是**从 @deepseek-ai/dsh-settings 具名导入）；其 76 个 lib/*.js 中
 *         **没有任何文件 import 这两个已删除符号**（唯一的 dsh-settings 提及是
 *         jet-hub-store.js 里的一句文档注释）。
 *       - dsh-web-mobile / dsh-prompt-optimizer：**完全不引用** dsh-settings。
 *     → 0.1.7 三个内置插件当前**均非本补丁的消费者**。
 *   · 本补丁**真实的消费者**是 dsh-vision（来自 prebuilt.tgz 的 third_party/）与
 *     手动装配的 dsh-llm-codebuddy，两者都写
 *       import { settingsNamespace } from '@deepseek-ai/dsh-settings';
 *     （dsh-vision 另有 installSettingsSection 的文档提及）。
 *
 * 关于扫描范围（本次核实项）：eachPluginEntry() 返回的是**每个插件目录的单一入口**
 * （package.json exports['.'].default ?? main ?? lib/index.js），**不是** lib/*.js 全量。
 * 就 0.1.7 现状而言这已足够——上述真实消费者都在**入口文件**里具名导入
 * （dsh-vision 的 import 在 lib/index.js；codebuddy 的在 lib/index.js）。
 * 但这是**已知的覆盖边界**：若将来某插件把已删除符号挪进 lib/ 子模块，补丁会漏。
 * 由于本文件是引导期补丁、且对每个插件目录全量递归扫描成本高（插件含 node_modules），
 * 这里保持入口级扫描，并在日志里以 scanned=<入口数> 显式暴露覆盖规模，
 * 一旦出现「插件加载报 does not provide an export named」即可据日志定位。
 * ------------------------------------------------------------------------- */
try {
  const MARKER = 'dsh-launcher-plugin-compat-v1';
  const MISSING = [
    ['settingsNamespace', `function settingsNamespace(value) {\n\tif (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError('settings namespace "' + value + '" must match /^[a-z][a-z0-9-]*$/');\n\treturn value;\n}`],
    ['installSettingsSection', `function installSettingsSection(ctx, ns, schema, entry, hooks) {\n\tctx.inject(['settings'], (sctx) => {\n\t\tconst settings = sctx.settings;\n\t\tif (settings === undefined || typeof settings.installSection !== 'function') throw new Error('installSettingsSection: settings service lacks installSection');\n\t\tsettings.installSection(ctx, ns, schema, entry, hooks);\n\t});\n}`],
  ];
  let patchedFiles = 0, alreadyDone = 0;
  const entries = eachPluginEntry();
  for (const { name, file: entry } of entries) {
    let src;
    try { src = readFileSync(entry, 'utf8'); } catch { continue; }
    if (src.includes(MARKER)) { alreadyDone++; continue; }
    // 只处理「从 dsh-settings 具名导入了已删除符号」的文件
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"];?/g;
    let changed = false;
    const out = src.replace(importRe, (whole, namesRaw) => {
      const names = namesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const used = names.filter((n) => MISSING.some(([sym]) => sym === n));
      if (used.length === 0) return whole;   // 引用的符号都还在 → 别碰
      changed = true;
      const helpers = used.map((n) => MISSING.find(([sym]) => sym === n)[1]).join('\n');
      const keep = names.filter((n) => !MISSING.some(([sym]) => sym === n));
      const rest = keep.length ? `import { ${keep.join(', ')} } from '@deepseek-ai/dsh-settings';\n` : '';
      return `${rest}${helpers}`;
    });
    if (!changed) continue;
    // 语法自检通过才写盘（否则会把插件改成「加载即崩」，比原缺陷更糟）
    const tmp = entry + '.compat-check.mjs';
    let ok = false;
    try {
      writeFileSync(tmp, out);
      const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
      ok = r.status === 0;
      if (!ok) log(`WARN plugin-compat: syntax check FAILED for ${name}: ${(r.stderr || '').slice(0, 200)}`);
    } catch (e) {
      log(`WARN plugin-compat: syntax check unavailable for ${name}: ${e.message}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (!ok) continue;
    try {
      writeFileSync(entry, `// ${MARKER}\n` + out);
      patchedFiles++;
      log(`plugin-compat patched: ${name}`);
    } catch (e) { log(`WARN plugin-compat write ${name}: ${e.message}`); }
  }
  log(`plugin-compat: scanned=${entries.length} patched=${patchedFiles} already=${alreadyDone}`);
} catch (e) { log('WARN plugin-compat: ' + e.message); }

/* ---------------------------------------------------------------------------
 * 内置插件 **client 端** 的模块表兼容：dsh 0.1.5 删除了 @deepseek-ai/dsh-client-runtime
 *
 * 现象（真机）：host 端插件树加载正常、web UI 已起，但页面顶部报
 *   Failed to load plugins
 *   failed to import loader entry …(dsh-provider-headers): client-modules:
 *   require("@deepseek-ai/dsh-client-runtime/client") missed the module table
 *
 * 根因：0.1.5 把 `createSnapshotStore` 从 `dsh-client-runtime/client`
 * **迁移到新包 `@deepseek-ai/dsh-client-store`**，并删除旧包。
 * 证据（逐项实测）：
 *   · 0.1.5 前端种子表（staticModules）只有 5 个 @deepseek-ai 词：
 *     cordis / dsh-client-store / dsh-client-ui-dockkit /
 *     dsh-client-ui-primitives / dsh-client-ui-slots —— **无 client-runtime**；
 *   · 0.1.5 安装树中不存在 dsh-client-runtime 包；
 *   · 新旧 createSnapshotStore **实现逐行相同**（仅缩进不同），故改指新包语义等价。
 *
 * 与 host 端不同：client 端是浏览器侧 `require(spec)` 查模块表，Node 侧解析无关，
 * 所以必须单独改写 client.js。改写的是 `require` 的**说明符字符串**，不动逻辑。
 *
 * **已针对 0.1.7-rc.2 核实（对新插件无副作用）**：
 *   · dsh-web-mobile@3.0.3/lib/client.js 的 external require 只有
 *     '@deepseek-ai/dsh-client-ui-primitives' 与 'react/jsx-runtime'，**不含 client-runtime**；
 *   · dsh-codearts-auth 的 client 是 lib/client/jet-hub.js，其 require 只有 'react'；
 *   · dsh-prompt-optimizer：不引用 client-runtime。
 *   → REQUIRE_MAP 对这三者**零命中**；代码里 `if (!out.includes(...)) continue` 直接跳过、
 *     **不写盘、不加 marker**，故**无副作用**（日志 scanned=N patched=0）。
 *   · 另外注意：eachPluginClientFile() 只探测 **lib/client.js** 这一固定路径，
 *     而 codearts 的 client 出口是 **lib/client/jet-hub.js**（package.json
 *     exports['./client']）——当前它本就不需要本补丁，故不影响；
 *     但这是已知覆盖边界（与 plugin-compat 同性质），日志的 scanned 计数会暴露规模。
 * ------------------------------------------------------------------------- */
try {
  const CMARKER = 'dsh-launcher-client-compat-v1';
  // 已删除 → 替代（0.1.5 模块表中存在的等价模块）
  const REQUIRE_MAP = [
    ['@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-store'],
  ];
  let patched = 0, already = 0;
  const clients = eachPluginClientFile();
  for (const { name, file } of clients) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    if (src.includes(CMARKER)) { already++; continue; }
    let changed = false;
    let out = src;
    for (const [from, to] of REQUIRE_MAP) {
      if (!out.includes(`"${from}"`) && !out.includes(`'${from}'`)) continue;
      out = out.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`'${to}'`);
      changed = true;
    }
    if (!changed) continue;
    // 语法自检（client.js 是 ESM 包装的工厂函数体，node --check 可校验）
    const tmp = file + '.client-check.mjs';
    let ok = false;
    try {
      writeFileSync(tmp, out);
      const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
      ok = r.status === 0;
      if (!ok) log(`WARN client-compat: syntax check FAILED for ${name}: ${(r.stderr || '').slice(0, 200)}`);
    } catch (e) {
      log(`WARN client-compat: syntax check unavailable for ${name}: ${e.message}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (!ok) continue;
    try {
      writeFileSync(file, `// ${CMARKER}\n` + out);
      patched++;
      log(`client-compat patched: ${name}`);
    } catch (e) { log(`WARN client-compat write ${name}: ${e.message}`); }
  }
  log(`client-compat: scanned=${clients.length} patched=${patched} already=${already}`);
} catch (e) { log('WARN client-compat: ' + e.message); }

/* ---------------------------------------------------------------------------
 * Android flock 降级（v4.10.3）
 *
 * 现象：dsh 0.1.5 起，每轮对话都报「本轮运行失败 flock is not supported on android-arm64」。
 *
 * 根因链（已逐环复现）：
 *   dsh 0.1.5 新增依赖 @deepseek-ai/node-addon-system（native addon），
 *   其 lib/flock.js 开头就判断平台：
 *       if (platform !== 'linux' && platform !== 'darwin') throw ERR_FLOCK_UNSUPPORTED_PLATFORM
 *   而 Android 上 **process.platform === 'android'**（不是 'linux'）→ 直接抛错。
 *   该 addon 官方只发布 darwin-arm64/x64、linux-x64/arm64 四个平台包，
 *   **没有 android**，所以即便绕过判断也加载不到二进制。
 *   dsh-session-persistence-jsonl 用 tryLockExclusive 获取「会话写租约」，
 *   抛错冒泡成「本轮运行失败」——对话每轮都触发，等于不可用。
 *   （0.1.1 没有这个依赖，所以旧版正常。）
 *
 * 为什么可以安全降级为「立即成功」：
 *   flock 的用途是**跨进程**互斥（同进程内另有 write claim 保证唯一写者）。
 *   Android 上 dsh web 是**单进程** node（web-launcher.sh.tpl 只起一个 node），
 *   不存在第二个进程争用同一会话文件，故跨进程锁是多余的。
 *   官方对 browser worker 就是这么做的，原话：
 *     "The browser worker stubs the native flock entry to immediate success:
 *      it is single-process, so the in-process write claim already excludes every writer."
 *   我们与 browser worker 属同类情形，沿用同一降级语义。
 *
 * 做法：在 flock.js 顶部插入 android 短路——tryLockExclusive 立即 resolve。
 * 保留原文件其余内容与导出签名，故 dsh-session-persistence-jsonl 侧
 * 走的是正常 posix lease 分支，无需改动其它包。
 *
 * **已针对 0.1.7-rc.2 核实**：
 *   · 锚点 'export async function tryLockExclusive(fd) {' 在
 *     @deepseek-ai/node-addon-system@0.1.2/lib/flock.js 中**仍然命中**（版本未变，
 *     0.1.7 安装树实测）。→ 保持不动。
 *   · findPkg 定位能力：0.1.7 的 **npm 扁平布局**下
 *     node_modules/@deepseek-ai/node-addon-system/lib/flock.js 直接命中；
 *     **pnpm 布局**下走 .pnpm/<name>@<ver>.../node_modules/<pkg>/<rel> 前缀匹配，
 *     再退到 findNestedPkg 递归（深度 ≤8）。实测 0.1.7 解包树为扁平布局，
 *     但两种布局的解析分支都在，未命中时打显式 WARN 而非静默。
 * ------------------------------------------------------------------------- */
try {
  const MARKER_FLOCK = 'dsh-launcher-android-flock-stub';
  const flockFile = findPkg('@deepseek-ai/node-addon-system', 'lib/flock.js');
  if (!flockFile) {
    log('node-addon-system/flock: not found, skip android stub');
  } else {
    let src = readFileSync(flockFile, 'utf8');
    if (src.includes(MARKER_FLOCK)) {
      log('flock android stub already applied');
    } else {
      // 只替换 tryLockExclusive 的函数体首行，其余（含 loadBinding 原逻辑）保持原样，
      // 以便将来上游支持 android 时可无损回退（有 marker，重装即重打）。
      const anchor = 'export async function tryLockExclusive(fd) {';
      if (!src.includes(anchor)) {
        log('WARN flock android stub: anchor not found (upstream changed?), skip');
      } else {
        const patchedFn =
          anchor + '\n' +
          '    // ' + MARKER_FLOCK + ': Android 单进程无需跨进程 flock（见 stub-dsh.mjs 注释）\n' +
          '    if (process.platform === \'android\') return;\n';
        src = src.replace(anchor, patchedFn);
        writeFileSync(flockFile, `// ${MARKER_FLOCK}\n` + src);
        log('flock android stub applied: ' + flockFile);
      }
    }
  }
} catch (e) { log('WARN flock android stub: ' + e.message); }

/* ---------------------------------------------------------------------------
 * @deepseek-ai/dsh-atomic-write 评估结论（0.1.7 新包）—— **已评估，无需补丁**
 *
 * 背景：0.1.7 新增 @deepseek-ai/dsh-atomic-write（writeFileAtomic / withFileLock，
 * 用 rename 提交、wx 创建临时文件）。它与 dsh-fs-local **并存**，因此必须回答：
 * 该新包在 Android(SELinux/FUSE) 上是否需要与 fs-local chmod 同类的容错？
 *
 * 结论：**不需要**。逐条依据（均取自 @deepseek-ai/dsh-atomic-write@0.1.7-rc.2/lib/index.js，
 * 9095 字节，全文已逐行核对）：
 *
 *   1) **它完全不调用 chmod。** 该文件只 import
 *        node:fs/promises → { lstat, mkdir, readFile, rename, rm, writeFile }
 *        node:crypto     → { createHash, randomBytes }
 *      全文没有 chmod / fchmod / chown / futimes 的任何调用——fs-local 那三处
 *      chmod 锚点在此**根本不存在**，所以「同类 chmod 容错」没有作用对象。
 *      权限位的传递方式不同：writeFile(temp, content, { mode, flag: 'wx' })
 *      在**创建新 inode 时**就把 mode 交给内核（0o600 = 384），rename 只替换目录项、
 *      **不触碰权限位**。因此不存在「先建后 chmod」的 EACCES 窗口——
 *      这正是 fs-local 需要打补丁的原因，而 atomic-write 天然规避了它。
 *
 *   2) **rename 容错已由上游自带，且只针对 Windows。** 上游有
 *      renameAtomicTemp()：对 EACCES/EBUSY/EPERM 做 8 次指数退避重试，但入口
 *      isTransientWindowsRenameError() **首行就是** 'if (process.platform !== "win32") return false'
 *      —— Android（platform === 'android'）不会进入该重试分支，rename 失败会直接抛出。
 *      这是**正确的**：rename(2) 在 Linux/ext4 与 FUSE 上都是原子的、同目录内不返回
 *      EACCES/EPERM/EBUSY（EXDEV 只在跨文件系统时出现，而该包强制临时文件与目标同目录：
 *      临时名形如 '<filename>.<12位hex>.tmp'，由 randomBytes(6) 生成）。
 *      给 Android 加同类重试反而会掩盖真实的 EXDEV/权限错误。
 *
 *   3) **调用点都落在应用私有存储（ext4），不是 FUSE 共享存储。** 0.1.7 中该包的
 *      消费者实测为 dsh-app-boot / dsh-config-editor / dsh-credentials-local /
 *      dsh-llm-deepseek / dsh-plugin-manager / dsh 本体，写入目标分别是
 *      profile 目录（files/.dsh/…）、credentials、配置文档——全部在 HOME
 *      （应用私有 ext4）下。fs-local 的 chmod 补丁针对的是**用户可能把工作区
 *      指向 /storage/emulated/0（FUSE）** 的场景；atomic-write 写的是 dsh 自身状态，
 *      不落 FUSE。
 *
 *   4) withFileLock 用 writeFile(lockPath, pid, { mode: 384, flag: 'wx' }) 建锁，
 *      EEXIST 视为争用、EPERM 会 lstat 复核（该分支同样注明是 Windows 独占创建语义），
 *      Android 上是标准 EEXIST 路径。单进程 dsh web 下争用本就极少。
 *
 * 因此：**不新增补丁块**。若将来 atomic-write 开始调用 chmod/chown，或
 * 调用点把目标挪到 /storage/emulated/0，需按 fs-local 的 guard 写法补一个块。
 * ------------------------------------------------------------------------- */

log('=== android fixup done ===');