const compatUrl = new URL('./fs-promises-compat.mjs', import.meta.url).href;

// 覆盖 node:fs/promises 与裸说明符 fs/promises 两种写法（SELinux 禁硬链接的全局性
// 不区分导入形式）。CJS require('fs/promises') 与 fs.linkSync 不经用户 loader，
// 属已知覆盖盲区（见 docs/review-findings-scripts.md）。
const COMPAT_SPECIFIERS = new Set(['node:fs/promises', 'fs/promises']);

export async function resolve(specifier, context, nextResolve) {
  if (COMPAT_SPECIFIERS.has(specifier) && context.parentURL !== compatUrl) {
    return { url: compatUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
