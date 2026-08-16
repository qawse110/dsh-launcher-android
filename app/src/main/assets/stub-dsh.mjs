#!/usr/bin/env node
/**
 * stub-dsh.mjs — Android 兼容性修复（dsh 官方 npm 安装版）。
 *
 * 旧版同时负责“插件装配 + 启动 web”；新版 dsh 本体与插件都改用官方
 * npm / `dsh plugin` 安装，这里只保留 Android 特有修复：
 *   1) koffi / node-pty / sharp：Android 无预编译产物，用 Proxy stub 顶替；
 *   2) sandbox-windows-acl 的 koffi 布局断言在执行前禁用；
 *   3) WebView/旧 Chrome 的 AbortSignal.timeout polyfill 注入前端 dist；
 *   4) 保持 fs link 兼容层文件（由 ConsoleActivity 负责复制）。
 *
 * 环境变量：
 *   HOME / NODE_DIR / DSH_PREFIX / DSH_PROFILE
 */
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE = process.env.NODE_DIR || join(HOME, 'node');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const PROFILE = process.env.DSH_PROFILE || 'web';
const NODE_MODULES = join(DSH_PREFIX, 'node_modules');
const PNPM_DIR = join(NODE_MODULES, '.pnpm');
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

function log(m) {
  const l = `${new Date().toISOString()} [stub] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

/** 在 npm 扁平布局或 pnpm .pnpm 布局下定位包内相对路径。 */
function findPkg(pkgName, rel) {
  // pnpm v10: node_modules/.pnpm/<name>@<hash>/node_modules/<pkg>/<rel>
  if (existsSync(PNPM_DIR)) {
    const prefix = pkgName.replace('/', '+') + '@';
    for (const d of readdirSync(PNPM_DIR)) {
      if (!d.startsWith(prefix)) continue;
      const p = join(PNPM_DIR, d, 'node_modules', pkgName, rel);
      if (existsSync(p)) return p;
    }
  }
  // npm 扁平布局
  const flat = join(NODE_MODULES, pkgName, rel);
  if (existsSync(flat)) return flat;
  return null;
}

const KSTUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O2V4cG9ydCBkZWZhdWx0IGtvZmZpOw==';
const KCJS = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O21vZHVsZS5leHBvcnRzPWtvZmZpO21vZHVsZS5leHBvcnRzLmRlZmF1bHQ9a29mZmk7';
const PSTUB = 'Y29uc3R7RXZlbnRFbWl0dGVyfT1yZXF1aXJlKCdldmVudHMnKTtjbGFzcyBGIGV4dGVuZHMgRXZlbnRFbWl0dGVye2NvbnN0cnVjdG9yKCl7c3VwZXIoKTt0aGlzLnBpZD0wO3RoaXMuZXhpdENvZGU9MH13cml0ZSgpe31raWxsKCl7fXJlc2l6ZSgpe31jbGVhcigpe31jbG9zZSgpe31vbkV4aXQoYyl7aWYoYyljKHtleGl0Q29kZTowLHNpZ25hbDp1bmRlZmluZWR9KX19bW9kdWxlLmV4cG9ydHM9e3NwYXduKCl7Y29uc3QgeD1uZXcgRigpO3Byb2Nlc3MubmV4dFRpY2soKCk9PnguZW1pdCgnZXhpdCcse2V4aXRDb2RlOjAsc2lnbmFsOnVuZGVmaW5lZH0pKTtyZXR1cm4geH0sZm9yaygpe3JldHVybiBuZXcgRigpfSxvcGVuKCl7cmV0dXJue21hc3RlcjpuZXcgRigpLHNsYXZlOm5ldyBGKCl9fX07';
const SHARP_STUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO21vZHVsZS5leHBvcnRzPXA7bW9kdWxlLmV4cG9ydHMuZGVmYXVsdD1wOw==';
const SHARP_STUB_ESM = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2V4cG9ydCBkZWZhdWx0IHA7';

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
  const sharpTargets = [
    ['sharp', 'dist/index.cjs', SHARP_STUB],
    ['sharp', 'dist/index.mjs', SHARP_STUB_ESM],
    ['sharp', 'dist/sharp.cjs', SHARP_STUB],
    ['sharp', 'dist/sharp.mjs', SHARP_STUB_ESM],
    ['sharp', 'lib/index.js', SHARP_STUB],
    ['sharp', 'index.js', SHARP_STUB],
  ];
  let sharpPatched = 0;
  for (const [pkg, rel, stub] of sharpTargets) {
    const p = findPkg(pkg, rel);
    if (p) {
      writeFileSync(p, Buffer.from(stub, 'base64'));
      log('sharp stub ok: ' + p);
      sharpPatched++;
    }
  }
  if (sharpPatched === 0) log('sharp: not found, skip');
} catch (e) { log('WARN sharp: ' + e.message); }
try {
  const ap = findPkg('@deepseek-ai/dsh-host-apiproxy', 'lib/index.js');
  if (ap) {
    let src = readFileSync(ap, 'utf8');
    const hasVision = /["']vision["']/.test(src);
    if (!hasVision) {
      const re = /(const WEB_SETTINGS_NAMESPACES\s*=\s*\[)([\s\S]*?)(\];)/;
      const replaced = src.replace(re, (m, open, body, close) => {
        if (body.includes('"vision"') || body.includes("'vision'")) return m;
        return open + body + (body.trim() ? ',' : '') + '\n\t"vision"' + close;
      });
      if (replaced !== src) {
        writeFileSync(ap, replaced);
        log('apiproxy WEB_SETTINGS_NAMESPACES += vision: ' + ap);
      } else {
        log('apiproxy WEB_SETTINGS_NAMESPACES pattern not found, skip');
      }
    } else {
      log('apiproxy vision already exposed');
    }
  } else {
    log('apiproxy: not found, skip');
  }
} catch (e) { log('WARN apiproxy: ' + e.message); }

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
  // WebView / Chrome ≤102 无 AbortSignal.timeout
  const idx = findPkg('@deepseek-ai/dsh-web-frontend', 'dist/index.html');
  if (idx && existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    if (!html.includes('dsh-timeout-shim')) {
      const shim = '<script id="dsh-timeout-shim">if(!AbortSignal.timeout)AbortSignal.timeout=(ms)=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException(\'TimeoutError\',\'TimeoutError\')),ms);return c.signal;};</script>';
      html = html.replace('<head>', '<head>' + shim);
      writeFileSync(idx, html);
      log('index.html AbortSignal.timeout shim injected');
    } else {
      log('index.html shim already present');
    }
  } else {
    log('dsh-web-frontend dist not found, skip shim');
  }
} catch (e) { log('WARN index shim: ' + e.message); }

try {
  // 保持旧版占位补丁文件为空（koffi 已 stub，无需禁用行）
  const patch = join(HOME, 'patch-koffi.yml');
  writeFileSync(patch, '# native stubs in place, no disables\n');
  log('patch ok (empty)');
} catch (e) { log('WARN patch: ' + e.message); }

log('=== android fixup done ===');