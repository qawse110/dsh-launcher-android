#!/usr/bin/env node
/**
 * 一次性校验：确认从 stub-dsh.mjs 抽出的 patched/ 载荷与迁移前内嵌 base64
 * 逐字节一致（review-r5 迁移的安全性证明）。
 * 用法：node tools/verify-payload-extraction.cjs <old-stub.mjs>
 */
const fs = require('fs');
const path = require('path');

const oldPath = process.argv[2];
if (!oldPath) {
  console.error('usage: node tools/verify-payload-extraction.cjs <old-stub.mjs>');
  process.exit(2);
}
const old = fs.readFileSync(oldPath, 'utf8');
const assets = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'patched');

function grab(name) {
  const re = new RegExp('const ' + name + " = .([A-Za-z0-9+/=]{40,}).;", 'm');
  const m = old.match(re);
  if (!m) throw new Error('missing const: ' + name);
  return Buffer.from(m[1], 'base64');
}

const pairs = [
  ['KSTUB', 'koffi-stub.mjs'],
  ['KCJS', 'koffi-stub.cjs'],
  ['PSTUB', 'node-pty-stub.cjs'],
  ['SHIM_B64', 'sharp-shim.cjs'],
];
let bad = 0;
for (const [constName, file] of pairs) {
  const a = grab(constName);
  const b = fs.readFileSync(path.join(assets, file));
  const same = a.length === b.length && a.equals(b);
  if (!same) bad++;
  console.log(`${same ? 'IDENTICAL  ' : '** DIFFERS **'} ${constName} -> patched/${file} (${a.length}B vs ${b.length}B)`);
}
console.log(bad === 0 ? 'RESULT: 载荷字节级一致性校验通过' : `RESULT: ${bad} 处差异`);
process.exit(bad === 0 ? 0 : 1);
