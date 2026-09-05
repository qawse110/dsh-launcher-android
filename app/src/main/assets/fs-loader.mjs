import { existsSync } from 'node:fs';
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
 * shim 文件由 stub-dsh.mjs 每次执行时刷新；缺失时放行（不误伤任何环境）。
 */
const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const SHARP_SHIM_FILE = join(HOME, 'sharp-shim.cjs');
const sharpShimUrl = existsSync(SHARP_SHIM_FILE) ? pathToFileURL(SHARP_SHIM_FILE).href : null;

// 同步实现：module.registerHooks 的钩子在主线程同步执行，module.register 的异步链
// 同样接受非 Promise 返回值，一份实现两边通用。
export function resolve(specifier, context, nextResolve) {
  if (sharpShimUrl && specifier === 'sharp') {
    return { url: sharpShimUrl, format: 'commonjs', shortCircuit: true };
  }
  if (COMPAT_SPECIFIERS.has(specifier) && context.parentURL !== compatUrl) {
    return { url: compatUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
