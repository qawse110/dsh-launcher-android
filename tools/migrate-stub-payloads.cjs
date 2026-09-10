#!/usr/bin/env node
/**
 * review-r5 一次性迁移：把 stub-dsh.mjs 里内嵌的 base64 载荷改为
 * 读取 assets/patched/ 真实文件，并把 koffi/node-pty/sharp 三处写入改为
 * 内容比对幂等（overlayPatch）。
 *
 * 用法：node tools/migrate-stub-payloads.cjs
 * 幂等：已迁移过（找不到 base64 常量块与旧写入点）则报错退出，不重复改。
 */
const fs = require('fs');
const path = require('path');

const STUB = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'stub-dsh.mjs');
let src = fs.readFileSync(STUB, 'utf8');
const before = src.length;

// —— 1) 删除 base64 常量块（KSTUB…SHARP_STUB_ESM）——
const constBlockRe = /\nconst KSTUB = '[\s\S]*?const SHARP_STUB_ESM = '[A-Za-z0-9+/=]+';\n/;
if (!constBlockRe.test(src)) {
  console.error('FAIL: base64 常量块未找到（可能已迁移）');
  process.exit(1);
}
src = src.replace(constBlockRe, `
/* review-r5：koffi/node-pty/sharp 的替身载荷已抽到 assets/patched/ 真实文件
 * （koffi-stub.mjs|cjs、node-pty-stub.cjs、sharp-shim.cjs）。旧版把 4 个载荷
 * base64 内嵌在此处（约 13KB 不可读 blob），且 SHARP_STUB/SHARP_STUB_ESM 两个常量
 * 自 v4 视觉链路改纯 JS shim 后已无消费者（死代码），一并移除。载荷改真实文件后
 * 可 diff、可评审，并纳入 CI 语法门禁（此前 base64 内容对静态检查完全不可见）。 */
`);

// —— 2) koffi 写入点 → overlayPatch ——
const koffiRe = /try \{\n  const ke = findPkg\('koffi', 'index\.js'\);[\s\S]*?\} catch \(e\) \{ log\('WARN koffi: ' \+ e\.message\); \}/;
if (!koffiRe.test(src)) { console.error('FAIL: koffi 写入点未找到'); process.exit(1); }
src = src.replace(koffiRe, `try {
  const ke = findPkg('koffi', 'index.js');
  const kc = findPkg('koffi', 'index.cjs');
  if (ke) overlayPatch('koffi-stub.mjs', ke, 'koffi ESM stub');
  if (kc) overlayPatch('koffi-stub.cjs', kc, 'koffi CJS stub');
  if (!ke && !kc) log('koffi: not found, skip');
} catch (e) { log('WARN koffi: ' + e.message); }`);

// —— 3) node-pty 写入点 → overlayPatch ——
const ptyRe = /try \{\n  const p = findPkg\('node-pty', 'lib\/index\.js'\);[\s\S]*?\} catch \(e\) \{ log\('WARN node-pty: ' \+ e\.message\); \}/;
if (!ptyRe.test(src)) { console.error('FAIL: node-pty 写入点未找到'); process.exit(1); }
src = src.replace(ptyRe, `try {
  const p = findPkg('node-pty', 'lib/index.js');
  if (p) overlayPatch('node-pty-stub.cjs', p, 'node-pty stub');
  else log('node-pty: not found, skip');
} catch (e) { log('WARN node-pty: ' + e.message); }`);

// —— 4) sharp 块：SHIM_B64 → readPatch + 内容比对 ——
const sharpRe = /try \{\n  \/\* Android 无 libvips[\s\S]*?\} catch \(e\) \{ log\('WARN sharp shim: ' \+ e\.message\); \}/;
if (!sharpRe.test(src)) { console.error('FAIL: sharp 写入块未找到'); process.exit(1); }
src = src.replace(sharpRe, `try {
  /* Android 无 libvips：写入纯 JS 兼容层 _dshshim.cjs（PNG 全解码 + 头部探测），
     各入口改为重定向；替代旧 Proxy 桩（旧桩让所有图片判 INVALID_IMAGE 且
     await 永不结算）。实现与视觉链路修复配套。
     载荷 = assets/patched/sharp-shim.cjs（review-r5 由 base64 内嵌改为真实文件）。 */
  const shim = readPatch('sharp-shim.cjs');
  if (!shim) {
    log('WARN sharp shim payload missing, skip sharp patch');
  } else {
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
        // 内容比对幂等：shim 载荷变更时自动重写（无需版本 marker）
        let same = false;
        try {
          const cur = readFileSync(shimAbs);
          same = cur.length === shim.length && cur.equals(shim);
        } catch {}
        if (!same) writeFileSync(shimAbs, shim);
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
  }
} catch (e) { log('WARN sharp shim: ' + e.message); }`);

fs.writeFileSync(STUB, src);
console.log(`migrated: ${before} -> ${src.length} bytes (removed ${before - src.length})`);
