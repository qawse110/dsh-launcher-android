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
 * 现存修复：
 *   1) koffi / node-pty / sharp：Android 无预编译产物，用 Proxy stub / 纯 JS
 *      shim 顶替（模块 import 期，插件通道无法介入）；
 *   2) @deepseek-ai/dsh-attachment-local 视觉链路 v4：SELinux 禁 link(2)、FUSE
 *      上 fsync 失败的运行时行为修复（fs 兼容层不覆盖 CJS 盲区，只能改源）；
 *   3) @deepseek-ai/dsh-llm-pi-ai sendAttribution：dsh-provider-headers 内置
 *      插件的「关闭归因 UA」依赖该 schema 字段，上游明确注释
 *      “omission cannot suppress attribution”，在官方提供抑制缝隙前保留；
 *   4) sandbox-windows-acl 的 koffi 布局断言禁用（防御性，koffi 已被顶替）；
 *   5) WebView/旧 Chrome AbortSignal.timeout polyfill——仅当前端产物确实引用
 *      该 API 时才注入（rc.2 前端与全部内置插件 client 均无引用，自动跳过，
 *      不再无条件改写 dist/index.html；引导期早于 app bundle，插件无法替代）；
 *   6) @vscode/ripgrep 解析器 Android 回退（import 期解析，优先 Termux 原生 rg）；
 *   7) dsh-fs-local chmod 对 FUSE 的 EACCES/EPERM 容错（原子写内部路径，
 *      无插件缝隙）。
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

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE = process.env.NODE_DIR || join(HOME, 'node');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const PROFILE = process.env.DSH_PROFILE || 'web';
const NODE_MODULES = join(DSH_PREFIX, 'node_modules');
const PNPM_DIR = join(NODE_MODULES, '.pnpm');
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



  /* v4 视觉链路配套（dsh-launcher-android-att-vision-v4），在 v3 基础上加两道保险：
     1) syncDirectory 改用「函数签名 + 花括号配平」定位完整函数体，不再依赖后继注释锚点，
        对任何上游结构（干净 / v2 残缺 / v3 已改）都能精确切出整个函数；
     2) 写入前先用 node --check 校验临时文件语法，校验失败则放弃写盘（防止再毒化）。
     v4 同时自愈 v2 遗留的孤儿 finally / 孤儿 publishCopied 调用。 */
  try {
    const attLocal = findPkg('@deepseek-ai/dsh-attachment-local', 'lib/index.js');
    if (!attLocal) {
      log('attachment-local: not found, skip vision patch');
    } else if (readFileSync(attLocal, 'utf8').includes('dsh-launcher-android-att-vision-v4')) {
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

      /* link 发布回退：SELinux 拒绝应用 uid 的 link(2)、sdcard FUSE 不支持硬链接。
         helper 与调用点成对落地，标记写在 helper 头部（保证与文件共存亡）。
         兼容 v2 毒化残留：调用点已被改写为 publishCopied 但定义从未插入时，
         先还原调用点，再按标准流程安装。 */
      if (!src.includes('async function publishCopied(temporary, target, sha256)')) {
        const v2Call = 'await publishCopied(temporary, target, sha256);';
        const defAnchor = '/**\n* Publish one already verified normalized image';
        const di = src.indexOf(defAnchor);
        if (src.includes(v2Call)) {
          src = src.replace(v2Call, 'await link(temporary, target);');
          log('vision patch v3: restored v2-orphaned publishCopied call');
        }
        const ci = src.indexOf('await link(temporary, target);');
        if (di === -1 || ci === -1 || ci < di) {
          /* 锚点缺失或顺序异常（上游结构变化）：宁可跳过也不误插 */
          log('WARN vision patch v3: link anchors unusable (call=' + (ci !== -1) + ',def=' + (di !== -1) + ')');
        } else {
          const helper = [
            '/** dsh-launcher-android-att-vision-v4: link 优先；SELinux/FUSE 环境回退 copy，',
            '* 复制中途失败清理半写 target 防止内容寻址路径被毒化。 */',
            'async function publishCopied(temporary, target, sha256) {',
            '\ttry {',
            '\t\tawait link(temporary, target);',
            '\t\treturn;',
            '\t} catch (linkError) {',
            '\t\tconst code = linkError instanceof Error && "code" in linkError ? linkError.code : void 0;',
            '\t\tif (code === "EEXIST") {',
            '\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
            '\t\t\treturn;',
            '\t\t}',
            '\t\tif (!(code === "EACCES" || code === "EPERM" || code === "ENOSYS" || code === "EXDEV")) throw linkError;',
            '\t\ttry { await copyFile(temporary, target); } catch (copyError) {',
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
          /* 上游未导入 copyFile，回退分支需要；锚定 fs/promises 导入语句精确追加 */
          if (!src.includes('copyFile')) {
            const impA = '} from "node:fs/promises";';
            if (src.includes(impA)) src = src.replace(impA, ', copyFile' + impA);
            else log('WARN vision patch v4: fs/promises import anchor miss');
          }
          /* 先改写调用点、后插入 helper（用字符串替换，不用索引切片，避免索引错位）：
             helper 内部同样含 await link 字面量，先插后换会把 helper 自身改写成递归调用。 */
          const patched = src.replace('await link(temporary, target);', 'await publishCopied(temporary, target, sha256);');
          if (patched === src) {
            log('WARN vision patch v4: link call rewrite miss');
          } else {
            src = patched;
            src = src.replace(defAnchor, helper + '\n' + defAnchor);
            log('vision patch v4: publishCopied installed');
          }
        }
      }

      /* 写入前语法自检：写临时文件 + node --check，失败则放弃写盘（防止再毒化）。
         ESM 文件 node --check 会校验语法；若 spawnSync 不可用则降级为括号配平检查。 */
      const tmpPath = attLocal + '.v4check.mjs';
      let syntaxOk = false;
      try {
        writeFileSync(tmpPath, src);
        const r = spawnSync(process.execPath, ['--check', tmpPath], { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) syntaxOk = true;
        else log('WARN attachment-local v4 syntax check FAILED: ' + (r.stderr || '').slice(0, 300));
      } catch (e) {
        log('WARN attachment-local v4 syntax check unavailable: ' + e.message);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
      if (syntaxOk) {
        /* 若 helper 已存在但标记是旧版本（v2/v3 遗留），升级标记保证幂等短路生效 */
        if (src.includes('att-vision-v3') || src.includes('att-vision-v2') || src.includes('att-vision-v1')) {
          src = src.replace(/att-vision-v[123]/g, 'att-vision-v4');
        }
        writeFileSync(attLocal, src);
        log('attachment-local vision patch v4 applied: ' + attLocal);
      } else {
        log('WARN attachment-local vision patch v4: syntax check failed, file NOT modified: ' + attLocal);
      }
    }
  } catch (e) { log('WARN attachment-local vision: ' + e.message); }

/* apiproxy WEB_SETTINGS_NAMESPACES += vision 补丁已移除（v4.10 审计）：
 * 上游 0.1.x 已无该常量，补丁永远命中 "pattern not found, skip" 死分支；
 * dsh-vision 现通过 @deepseek-ai/dsh-settings 的 settingsNamespace('vision')
 * 直接注册设置命名空间，无需 api 网关白名单。 */

try {
  // dsh-provider-headers: sendAttribution=false 时不再强制注入 deepseek-harness User-Agent
  const pi = findPkg('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js');
  if (pi) {
    let src = readFileSync(pi, 'utf8');
    const marker = 'sendAttribution: z.boolean().default(true)';
    if (!src.includes(marker)) {
      let out = src;
      out = out.replace(
        /sendAttribution: z\.boolean\(\)\.optional\(\),/,
        'sendAttribution: z.boolean().default(true),'
      );
      out = out.replace(
        /headers: z\.dict\(z\.string\(\)\),/,
        'headers: z.dict(z.string()),\n\tsendAttribution: z.boolean().default(true),'
      );
      out = out.replace(
        /function requestHeaders\(headers\) \{/,
        'function requestHeaders(headers, sendAttribution = true) {'
      );
      out = out.replace(
        /function requestHeaders\(headers, sendAttribution = true\) \{\n(\s*)const attribution = attributionHeaders\(\);/,
        (m, indent) => m.replace(
          'const attribution = attributionHeaders();',
          `if (sendAttribution === false) return { ...(headers ?? {}) };\n${indent}const attribution = attributionHeaders();`
        )
      );
      out = out.replace(
        /headers: requestHeaders\(profile\.headers\)/,
        'headers: requestHeaders(profile.headers, profile.sendAttribution)'
      );
      if (out !== src) {
        writeFileSync(pi, out);
        log('llm-pi-ai sendAttribution support patched: ' + pi);
      } else {
        log('llm-pi-ai sendAttribution pattern not found, skip');
      }
    } else {
      log('llm-pi-ai sendAttribution already patched');
    }
  } else {
    log('llm-pi-ai: not found, skip');
  }
} catch (e) { log('WARN llm-pi-ai sendAttribution: ' + e.message); }

try {
  const w = findPkg('@deepseek-ai/dsh-sandbox-windows-acl', 'lib') || findPkg('@deepseek-ai/dsh-sandbox-windows-acl', 'lib/index.js');
  if (w) {
    const dir = existsSync(w) && w.endsWith('.js') ? dirname(w) : w;
    if (existsSync(dir)) {
      let patched = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const p = join(dir, f);
        const src = readFileSync(p, 'utf8');
        if (!src.includes('layout mismatch')) continue;
        let out = src;
        out = out.replace(/if \(STARTUPINFOW\.size !== 104\) throw new Error\(`STARTUPINFOW layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, STARTUPINFOW assert disabled */');
        out = out.replace(/if \(PROCESS_INFORMATION\.size !== 24\) throw new Error\(`PROCESS_INFORMATION layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, PROCESS_INFORMATION assert disabled */');
        if (out !== src) { writeFileSync(p, out); patched++; }
      }
      log('sandbox-windows-acl asserts disabled: ' + patched);
    }
  } else {
    log('sandbox-windows-acl: not found, skip');
  }
} catch (e) { log('WARN sandbox-windows-acl: ' + e.message); }

try {
  // WebView / Chrome ≤102 无 AbortSignal.timeout。
  // v4.10 起**按需注入**：仅当 dist 内 app bundle 确实引用了该 API 才写
  // index.html；0.1.1-rc.2 前端与全部内置插件 client 均无引用，自动跳过，
  // 不再无条件改写上游产物。必须留在引导期脚本里：polyfill 需要先于
  // /assets/index-*.js 与模块系统条目执行，client 插件通道时序上做不到。
  const idx = findPkg('@deepseek-ai/dsh-web-frontend', 'dist/index.html');
  if (idx && existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    if (html.includes('dsh-timeout-shim')) {
      log('index.html shim already present');
    } else {
      let consumerFound = false;
      try {
        // 递归扫描 assets（含子目录 chunk，布局变化不丢失消费者检测）。
        // 误报无害：shim 自带 `if(!AbortSignal.timeout)` 守卫，已定义时不生效。
        const stack = [join(dirname(idx), 'assets')];
        while (stack.length && !consumerFound) {
          const dir = stack.pop();
          let ents;
          try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const ent of ents) {
            if (ent.isDirectory()) { stack.push(join(dir, ent.name)); continue; }
            if (!ent.name.endsWith('.js')) continue;
            if (readFileSync(join(dir, ent.name), 'utf8').includes('AbortSignal.timeout')) { consumerFound = true; break; }
          }
        }
      } catch (e) {
        /* 资产目录不可读（布局变化）：宁可保守注入，回到旧行为 */
        consumerFound = true;
        log('WARN index shim asset scan failed (' + e.message + '), inject conservatively');
      }
      if (!consumerFound) {
        log('index.html shim skipped: no AbortSignal.timeout consumer in app bundle');
      } else {
        const shim = '<script id="dsh-timeout-shim">if(!AbortSignal.timeout)AbortSignal.timeout=(ms)=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException(\'TimeoutError\',\'TimeoutError\')),ms);return c.signal;};</script>';
        html = html.replace('<head>', '<head>' + shim);
        writeFileSync(idx, html);
        log('index.html AbortSignal.timeout shim injected');
      }
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

log('=== android fixup done ===');