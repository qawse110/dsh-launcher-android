import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const compatUrl = new URL('./fs-promises-compat.mjs', import.meta.url).href;

// 覆盖 node:fs/promises 与裸说明符 fs/promises 两种写法（SELinux 禁硬链接的全局性
// 不区分导入形式）。CJS require('fs/promises') 与 fs.linkSync 不经用户 loader，
// 属已知覆盖盲区（见 docs/review-findings-scripts.md）。
const COMPAT_SPECIFIERS = new Set(['node:fs/promises', 'fs/promises']);

/* Android 无 libvips，sharp 原生模块在 import 期必然抛
 * `Could not load the "sharp" module using the android-arm64 runtime`，而它在
 * cordis 插件入口的顶层被引用 → 整棵插件树 apply 失败 → dsh web 起不来。
 *
 * stub-dsh.mjs 的写盘补丁是第一道防线，但它有失效场景：.pnpm 里存在多个 sharp
 * 副本时只打得到其中一个、pnpm 重新 materialize 会覆盖补丁、store 硬链接是
 * 0444 导致写盘 EACCES、stub 被版本 marker 跳过……
 * 这里是第二道防线：解析期统一顶替，与安装顺序、副本数量、写盘权限全部无关。
 * - 全功能 shim（含 PNG 解码）由 stub-dsh.mjs 落盘到 $HOME/sharp-shim.cjs；
 * - 该文件缺失时本 loader 自行落一个「import 期不炸」的最小桩（解码能力降级，
 *   但插件树不再被一个 import 拖死）——防线 2 因此完全自持，不依赖 stub 是否运行。
 */

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const SHARP_SHIM_FILE = join(HOME, 'sharp-shim.cjs');
const DIAG_LOG = join(HOME, 'fs-loader.log');

// 诊断日志：每次 sharp 拦截 / 初始化异常都留痕。设备侧排障只看这一个文件即可
// 判断兜底是否生效、sharp 从哪个模块链路被引用。
function diag(msg) {
  try {
    appendFileSync(DIAG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* 日志失败不影响解析 */ }
}

// 最小桩：Proxy 全透传。保证 await sharp(buf).metadata() 之类的调用返回 Proxy
// 而不是在 import 期抛错；k === 'then' 必须为 undefined，避免被当 thenable 挂起。
const MINIMAL_SHIM = [
  'const p = new Proxy(function(){}, {',
  '  get: (t, k) => (k === Symbol.toPrimitive) ? () => 0 : (k === "then") ? undefined : p,',
  '  apply: () => p,',
  '  construct: () => p,',
  '});',
  'module.exports = p;',
  'module.exports.default = p;',
  'module.exports.versions = { vips: "stub" };',
  'module.exports.format = {};',
].join('\n');

let sharpShimUrl = null;
try {
  if (!existsSync(SHARP_SHIM_FILE)) {
    writeFileSync(SHARP_SHIM_FILE, MINIMAL_SHIM);
    diag('sharp-shim.cjs MISSING -> materialized minimal stub (stub-dsh.mjs did not run or write failed)');
  }
  sharpShimUrl = pathToFileURL(SHARP_SHIM_FILE).href;
  diag('loader init ok, sharp shim = ' + SHARP_SHIM_FILE);
} catch (e) {
  diag('shim init FAILED: ' + e.message);
}

// 同步实现：module.registerHooks 的钩子在主线程同步执行，module.register 的异步链
// 同样接受非 Promise 返回值，一份实现两边通用。
export function resolve(specifier, context, nextResolve) {
  if (sharpShimUrl && (specifier === 'sharp' || specifier.startsWith('@img/sharp'))) {
    diag('intercept: ' + specifier + ' <- ' + String(context.parentURL || '').slice(-100));
    return { url: sharpShimUrl, format: 'commonjs', shortCircuit: true };
  }
  if (COMPAT_SPECIFIERS.has(specifier) && context.parentURL !== compatUrl) {
    return { url: compatUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
