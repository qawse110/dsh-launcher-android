#!/usr/bin/env node
/**
 * 存量环境前缀修复器（原地、等长、幂等、只读除目标文件外不改动任何东西）。
 *
 * 背景：v4.9.x 的 mtime 增量 patch 漏改了 apt 装的 git/rg/wget 等（deb 载荷保留包内
 * 旧时间戳被误判为「旧文件」）。详见 tools/verify-prefix-patch.mjs 顶部注释。
 *
 * 本脚本对已装坏的文件做**原地等长重打补丁**（官方前缀 31 字符 → 短前缀 31 字符），
 * 因此不改动文件长度、不需要重装、不触碰用户仓库与插件数据。
 *
 * 用法：
 *   node tools/repair-prefix-patch.mjs [--usr <prefix>] [--dry-run] [--json]
 * 退出码：0 = 修复后审计通过；1 = 仍有残留或修复失败。
 *
 * 修复完成后请用 tools/verify-prefix-patch.mjs 复核。
 */
import fs from 'node:fs';
import path from 'node:path';
import { audit, dataDirForms } from './verify-prefix-patch.mjs';

const OFFICIAL_PREFIX = '/data/data/com.termux/files/usr';
const SHORT_PREFIX = '/data/user/0/com.dsh.nextapp1/t';
const DEFAULT_USR = '/data/user/0/com.dsh.nextapp1/files/termux/usr';

const B = (s) => Buffer.from(s, 'latin1');

function indexOf(hay, needle, from = 0) {
  if (!needle.length || hay.length - from < needle.length) return -1;
  const first = needle[0];
  const limit = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= limit; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function isImmediatelyAfter(bytes, at, prefix) {
  if (!prefix || !prefix.length || at < prefix.length) return false;
  const start = at - prefix.length;
  for (let k = 0; k < prefix.length; k++) if (bytes[start + k] !== prefix[k]) return false;
  return true;
}

/** 与 PrefixPatcher.replaceOutsideMirror 逐字对应：跳过镜像路径内的命中，避免二次嵌套。 */
function replaceOutsideMirror(input, old, nw, mirrorRoots) {
  if (!old.length) return input;
  const out = [];
  let cursor = 0;
  let hit = indexOf(input, old);
  while (hit >= 0) {
    if (mirrorRoots.some((p) => isImmediatelyAfter(input, hit, p))) {
      out.push(input.subarray(cursor, hit + old.length));
    } else {
      out.push(input.subarray(cursor, hit));
      out.push(nw);
    }
    cursor = hit + old.length;
    hit = indexOf(input, old, cursor);
  }
  out.push(input.subarray(cursor));
  return Buffer.concat(out);
}

function main(argv) {
  const args = argv.slice(2);
  const usrArg = args.indexOf('--usr');
  const usr = usrArg >= 0 ? args[usrArg + 1] : DEFAULT_USR;
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');

  if (!fs.existsSync(usr)) {
    console.error(`✗ 前缀不存在：${usr}`);
    return 2;
  }
  if (OFFICIAL_PREFIX.length !== SHORT_PREFIX.length) {
    console.error('✗ 等长替换前提不成立：官方前缀与短前缀长度不同。');
    return 2;
  }

  const mirrorRoots = dataDirForms(usr);
  const old = B(OFFICIAL_PREFIX);
  const nw = B(SHORT_PREFIX);

  const before = audit(usr);
  const fixed = [];
  const failed = [];

  for (const rel of before.mustFix) {
    const p = path.join(usr, rel);
    try {
      const bytes = fs.readFileSync(p);
      const out = replaceOutsideMirror(bytes, old, nw, mirrorRoots);
      if (out.length !== bytes.length) {
        failed.push({ path: rel, reason: `长度改变 ${bytes.length} -> ${out.length}` });
        continue;
      }
      if (out.equals(bytes)) continue;
      if (!dryRun) {
        // 保留原权限位（等长替换不应影响可执行位）
        const mode = fs.statSync(p).mode;
        fs.writeFileSync(p, out, { mode });
      }
      fixed.push(rel);
    } catch (e) {
      failed.push({ path: rel, reason: e.message });
    }
  }

  const after = audit(usr);
  const report = {
    usr,
    dryRun,
    scanned: after.scanned,
    repaired: fixed.length,
    repairedPaths: fixed,
    failed,
    before: { mustFix: before.mustFix.length, textFixNeeded: before.textFixNeeded.length },
    after: {
      mustFix: after.mustFix.length,
      textFixNeeded: after.textFixNeeded.length,
      binaryRemnants: after.binaryRemnants.length,
    },
    remaining: after.mustFix,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${dryRun ? '[dry-run] ' : ''}前缀修复：${usr}`);
    console.log(`  已扫描文件：${after.scanned}`);
    console.log(`  本次${dryRun ? '将' : '已'}改写：${fixed.length} 个`);
    for (const p of fixed.slice(0, 20)) console.log(`    - ${p}`);
    if (fixed.length > 20) console.log(`    … 其余 ${fixed.length - 20} 个`);
    if (failed.length) {
      console.log(`  失败：${failed.length} 个`);
      for (const f of failed.slice(0, 10)) console.log(`    ! ${f.path}: ${f.reason}`);
    }
    console.log(`  修复后 MUST_FIX：${after.mustFix.length}（修复前 ${before.mustFix.length}）`);
    console.log(`  修复后 TEXT_FIX_NEEDED：${after.textFixNeeded.length}`);
    console.log(`  BINARY_REMNANT（固有、不阻断）：${after.binaryRemnants.length}`);
  }

  if (after.mustFix.length || after.textFixNeeded.length || failed.length) {
    if (!asJson) console.error('\n✗ 修复未完成：仍存在核心前缀残留。');
    return 1;
  }
  if (!asJson) console.log('\n✓ 修复完成：核心前缀残留为 0。');
  return 0;
}

process.exit(main(process.argv));
