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
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const ANDROID_TMP = process.env.TMPDIR || join(HOME, 'tmp');
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
  try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
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
  // dsh-attachment-local：sharp 被 stub（Android 无原生预编译库）后，图片保存/读取的
  // 解码校验必然失败（metadata.format 恒为 stub）。改成魔数嗅探兜底，并兼容 Android
  // 的目录 fsync（SELinux 禁止 open /data 上级目录）与 fs-register 的 link→rename
  // 映射（rename 成功后临时文件已不存在，unlink ENOENT 属正常）。
  const MARKER_ATT_SNIFF = 'dsh-launcher-android-attachment-sniff';
  const attLocal = findPkg('@deepseek-ai/dsh-attachment-local', 'lib/index.js');
  if (!attLocal) {
    log('attachment-local: not found, skip sniff patch');
  } else {
    let src = readFileSync(attLocal, 'utf8');
    if (src.includes(MARKER_ATT_SNIFF)) {
      log('attachment-local sniff already patched');
    } else {
      const helper = `
/** ${MARKER_ATT_SNIFF}: sharp 被 stub（Android 无原生预编译库），用魔数嗅探兜底。 */
async function sniffImageMeta(data) {
\tconst b = data instanceof Uint8Array ? data : new Uint8Array(data);
\tconst head = b.subarray(0, 16);
\tif (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return { mediaType: "image/png", width: 0, height: 0 };
\tif (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mediaType: "image/jpeg", width: 0, height: 0 };
\tif (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 && head[4] === 0x37 && (head[5] === 0x61 || head[5] === 0x39)) return { mediaType: "image/gif", width: 0, height: 0 };
\tif (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return { mediaType: "image/webp", width: 0, height: 0 };
\treturn void 0;
}
`;
      const probeNew = `async function probeImage(data) {
\ttry {
\t\t// ${MARKER_ATT_SNIFF}: sharp 被 stub 时直接退回魔数嗅探
\t\tconst sniffed = await sniffImageMeta(data);
\t\tif (sniffed !== void 0) return sniffed;
\t\treturn await imageMetadata(sharp(data, {
\t\t\tfailOn: "error",
\t\t\tlimitInputPixels: false
\t\t}));
\t} catch (error) {
\t\tif (error instanceof AttachmentError) throw error;
\t\tthrow new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
\t}
}`;
      const detectNew = `async function detectImage(data, maxPixels) {
\ttry {
\t\t// ${MARKER_ATT_SNIFF}: sharp 被 stub 时直接退回魔数嗅探
\t\tconst sniffed = await sniffImageMeta(data);
\t\tif (sniffed !== void 0) {
\t\t\tif (maxPixels !== void 0 && sniffed.width * sniffed.height > maxPixels) throw new AttachmentError("Image exceeds the configured decoded-pixel limit.", "IMAGE_TOO_MANY_PIXELS");
\t\t\treturn sniffed;
\t\t}
\t\tconst image = sharp(data, {
\t\t\tfailOn: "error",
\t\t\tlimitInputPixels: false
\t\t});
\t\tconst detected = await imageMetadata(image);
\t\tif (maxPixels !== void 0 && detected.width * detected.height > maxPixels) throw new AttachmentError("Image exceeds the configured decoded-pixel limit.", "IMAGE_TOO_MANY_PIXELS");
\t\tawait image.raw().toBuffer();
\t\treturn detected;
\t} catch (error) {
\t\tif (error instanceof AttachmentError) throw error;
\t\tthrow new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
\t}
}`;
      const syncNew = `async function syncDirectory(path) {
\t/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
\tif (process.platform === "win32") return;
\t/* ${MARKER_ATT_SNIFF}: Android SELinux 禁止 open 上级目录（如 /data、/data/user/0），fsync 尽力而为。 */
\tlet handle;
\ttry {
\t\thandle = await open(path, constants.O_RDONLY);
\t} catch (error) {
\t\tif (process.platform === "android" && error && (error.code === "EACCES" || error.code === "EPERM")) return;
\t\tthrow error;
\t}
\ttry {
\t\tawait handle.sync();
\t} catch (error) {
\t\tif (process.platform === "android") return;
\t\tthrow error;
\t} finally {
\t\tawait handle.close().catch(() => {});
\t}
}`;
      const unlinkNew = `await unlink(temporary).catch((unlinkError) => {
\t\t\t/* ${MARKER_ATT_SNIFF}: fs-register 把 link 映射为 rename，link 成功后临时文件已不存在，ENOENT 属正常。 */
\t\t\tif (process.platform === "android" && unlinkError && unlinkError.code === "ENOENT") return;
\t\t\tthrow unlinkError;
\t\t});
\t} catch (error) {`;
      const allFound =
        /async function probeImage\(data\) \{[\s\S]*?\n\}/.test(src) &&
        /async function detectImage\(data, maxPixels\) \{[\s\S]*?\n\}/.test(src) &&
        /async function syncDirectory\(path\) \{[\s\S]*?\n\}/.test(src) &&
        src.includes('await unlink(temporary);\n\t} catch (error) {');
      if (!allFound) {
        log('attachment-local sniff pattern not found, skip');
      } else {
        let out = src;
        out = out.replace(/async function probeImage\(data\) \{[\s\S]*?\n\}/, probeNew);
        out = out.replace(/async function detectImage\(data, maxPixels\) \{[\s\S]*?\n\}/, detectNew);
        out = out.replace(/async function syncDirectory\(path\) \{[\s\S]*?\n\}/, syncNew);
        out = out.replace('await unlink(temporary);\n\t} catch (error) {', unlinkNew);
        out = out.replace('/**\n* Parse a supported raster', helper + '/**\n* Parse a supported raster');
        writeFileSync(attLocal, out);
        log('attachment-local android sniff/fsync/rename patched: ' + attLocal);
      }
    }
  }
} catch (e) { log('WARN attachment-local sniff: ' + e.message); }

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

try {
  // dsh sandbox 把宿主 /tmp 当作固定可写根；Android 上 /tmp 属于 shell 用户、app 不可写，
  // 导致子进程写 /tmp 报 Permission denied。这里把沙箱的可写临时根改成应用私有 TMPDIR。
  const MARKER_SANDBOX_TMP = 'dsh-launcher-android-sandbox-tmp';
  const sandboxMain = findPkg('@deepseek-ai/dsh-sandbox', 'lib/index.js');
  if (sandboxMain) {
    let src = readFileSync(sandboxMain, 'utf8');
    if (src.includes(MARKER_SANDBOX_TMP)) {
      log('dsh-sandbox tmp path already patched');
    } else {
      src = src.split('"/tmp"').join(JSON.stringify(ANDROID_TMP));
      writeFileSync(sandboxMain, `// ${MARKER_SANDBOX_TMP}\n` + src);
      log('dsh-sandbox tmp path patched: ' + ANDROID_TMP);
    }
  } else {
    log('dsh-sandbox: not found, skip tmp patch');
  }
  const sandboxLocal = findPkg('@deepseek-ai/dsh-sandbox-local', 'lib/index.js');
  if (sandboxLocal) {
    let src = readFileSync(sandboxLocal, 'utf8');
    if (src.includes(MARKER_SANDBOX_TMP)) {
      log('dsh-sandbox-local tmp path already patched');
    } else {
      src = src.split('"/tmp"').join(JSON.stringify(ANDROID_TMP));
      writeFileSync(sandboxLocal, `// ${MARKER_SANDBOX_TMP}\n` + src);
      log('dsh-sandbox-local tmp path patched: ' + ANDROID_TMP);
    }
  } else {
    log('dsh-sandbox-local: not found, skip tmp patch');
  }
} catch (e) { log('WARN dsh-sandbox tmp: ' + e.message); }

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

try {
  // 工作区目录浏览器：Android 在默认 home 列表里增加一个 SD Card 快捷入口，
  // 让 dsh 的“添加工作区”可以直接进入 /sdcard 并选择其中的目录。
  const dp = findPkg('@deepseek-ai/dsh-host-directory-picker-browse', 'lib/index.js');
  if (dp) {
    let src = readFileSync(dp, 'utf8');
    if (src.includes('dsh-launcher-android-sdcard-shortcut')) {
      log('directory-picker-browse sdcard shortcut already patched');
    } else {
      const marker = 'dsh-launcher-android-sdcard-shortcut';
      const insertion = `\n\t\tif (process.platform === "android" && target === home) {\n\t\t\ttry {\n\t\t\t\tif ((await stat("/sdcard")).isDirectory() && !entries.some((entry) => entry.path === "/sdcard")) {\n\t\t\t\t\tentries.unshift({ name: "SD Card", path: "/sdcard", hidden: false, /* ${marker} */ });\n\t\t\t\t}\n\t\t\t} catch {}\n\t\t}`;
      const re = /(\n\t\t\tentries\.push\(row\);\n\t\t\}\n)(\t\treturn \{)/;
      const replaced = src.replace(re, `$1${insertion}\n$2`);
      if (replaced !== src) {
        writeFileSync(dp, replaced);
        log('directory-picker-browse sdcard shortcut patched: ' + dp);
      } else {
        log('directory-picker-browse sdcard shortcut pattern not found, skip');
      }
    }
  } else {
    log('directory-picker-browse: not found, skip');
  }
} catch (e) { log('WARN directory-picker-browse: ' + e.message); }

try {
  // 保持旧版占位补丁文件为空（koffi 已 stub，无需禁用行）
  const patch = join(HOME, 'patch-koffi.yml');
  writeFileSync(patch, '# native stubs in place, no disables\n');
  log('patch ok (empty)');
} catch (e) { log('WARN patch: ' + e.message); }

log('=== android fixup done ===');