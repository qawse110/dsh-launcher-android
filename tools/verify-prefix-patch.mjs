#!/usr/bin/env node
/**
 * 内置 Termux 前缀适配审计器（可重复执行、只读、零依赖）。
 *
 * 为什么需要它：v4.9.x 用「文件 mtime > 安装窗口」当增量 patch 的判据，而 apt/dpkg
 * 解包保留 deb 包内原始 mtime，导致任何「包内时间戳早于安装窗口」的载荷被静默跳过。
 * 真机上 `bin/git`（包内 2026-09-30）装于 2026-10-01，从未被改写 ⇒ `git --exec-path`
 * 指向不存在的 `/data/data/com.termux/files/usr/libexec/git-core`，裸终端 git 不可用。
 *
 * 本脚本把这套判据固化成一个可随时重跑的检查：**扫内容而不是扫时间**，
 * 因此对「新装的同类包」同样成立。Java 侧 PrefixPatcher 的算法与此处逐字对应
 * （见 app/src/main/java/com/dsh/nextapp1/core/PrefixPatcher.kt），
 * app/src/test/.../PrefixPatcherTest.kt 与 tools/verify-prefix-patch.test.mjs 共同锁住语义。
 *
 * 用法：
 *   node tools/verify-prefix-patch.mjs [--usr <prefix>] [--json] [--quiet]
 * 退出码：0 = 无 MUST_FIX（裸环境可信）；1 = 存在核心前缀残留（正是本缺陷的形态）。
 */
import fs from 'node:fs';
import path from 'node:path';

const OFFICIAL_PREFIX = '/data/data/com.termux/files/usr';
const OFFICIAL_FILES = '/data/data/com.termux/files';
const OFFICIAL_APT_CACHE = '/data/data/com.termux/cache/apt';
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

/** bytes 的 at 位置之前是否紧邻 prefix（识别 `dataDir + 官方路径` 镜像串）。 */
function isImmediatelyAfter(bytes, at, prefix) {
  if (!prefix || !prefix.length || at < prefix.length) return false;
  const start = at - prefix.length;
  for (let k = 0; k < prefix.length; k++) if (bytes[start + k] !== prefix[k]) return false;
  return true;
}

/**
 * dataDir 的所有等价写法。
 * `/data/data/<pkg>` 与 `/data/user/0/<pkg>` 是同一 inode（实测 stat %d:%i 相同），
 * 但字符串不同；只认一种会导致镜像判定失配，把已改对的镜像路径误报为残留。
 */
export function dataDirForms(usr) {
  const dataDir = path.dirname(path.dirname(path.dirname(usr)));
  const forms = new Set([dataDir]);
  const userPrefix = '/data/user/0/';
  const dataPrefix = '/data/data/';
  if (dataDir.startsWith(userPrefix)) forms.add(dataPrefix + dataDir.slice(userPrefix.length));
  else if (dataDir.startsWith(dataPrefix)) forms.add(userPrefix + dataDir.slice(dataPrefix.length));
  return [...forms].map(B);
}

function isImmediatelyAfterAny(bytes, at, prefixes) {
  for (const p of prefixes) if (isImmediatelyAfter(bytes, at, p)) return true;
  return false;
}

/**
 * 是否存在落在镜像路径之外的命中。
 * 镜像路径 `dataDir + 官方路径` 自带官方串作为后缀，不排除会把已改对的文件误报成残留。
 */
function hasOccurrenceOutsideMirror(bytes, needle, mirrorRoots) {
  let from = 0;
  for (;;) {
    const hit = indexOf(bytes, needle, from);
    if (hit < 0) return false;
    if (!isImmediatelyAfterAny(bytes, hit, mirrorRoots)) return true;
    from = hit + 1;
  }
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // 与 Java 侧一致：只审真普通文件
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function audit(usr) {
  const mirrorRoots = dataDirForms(usr);
  const core = B(OFFICIAL_PREFIX);
  const files = B(OFFICIAL_FILES);
  const aptCache = B(OFFICIAL_APT_CACHE);

  const mustFix = [];
  const textFixNeeded = [];
  const binaryRemnants = [];
  const all = walkFiles(usr);

  for (const p of all) {
    let bytes;
    try {
      bytes = fs.readFileSync(p);
    } catch {
      continue;
    }
    const rel = path.relative(usr, p);
    const hasCore = hasOccurrenceOutsideMirror(bytes, core, mirrorRoots);
    const hasFiles = hasOccurrenceOutsideMirror(bytes, files, mirrorRoots);
    const hasApt = hasOccurrenceOutsideMirror(bytes, aptCache, mirrorRoots);
    if (hasCore) mustFix.push(rel);
    else if (hasFiles || hasApt) {
      (bytes.includes(0) ? binaryRemnants : textFixNeeded).push(rel);
    }
  }
  return { usr, scanned: all.length, mustFix, textFixNeeded, binaryRemnants };
}

function main(argv) {
  const args = argv.slice(2);
  const usrArg = args.indexOf('--usr');
  const usr = usrArg >= 0 ? args[usrArg + 1] : DEFAULT_USR;
  const quiet = args.includes('--quiet');

  if (!fs.existsSync(usr)) {
    console.error(`✗ 前缀不存在：${usr}`);
    console.error('  提示：用 --usr <path> 指定实际 PREFIX。');
    return 2;
  }
  const r = audit(usr);
  const asJson = args.includes('--json');
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!quiet) {
    console.log(`审计前缀：${r.usr}`);
    console.log(`  已扫描文件：${r.scanned}`);
    console.log(`  MUST_FIX（核心前缀残留，会导致 git/裸环境故障）：${r.mustFix.length}`);
    for (const p of r.mustFix.slice(0, 20)) console.log(`    - ${p}`);
    if (r.mustFix.length > 20) console.log(`    … 其余 ${r.mustFix.length - 20} 个`);
    console.log(`  TEXT_FIX_NEEDED（文本类残留，patch 后应为 0）：${r.textFixNeeded.length}`);
    console.log(`  BINARY_REMNANT（二进制固有残留，不可等长替换，不阻断）：${r.binaryRemnants.length}`);
  }
  const bad = r.mustFix.length || r.textFixNeeded.length;
  if (bad && !asJson && !quiet) {
    console.error('\n✗ 前缀适配不完整：裸环境工具链存在缺口。');
  }
  if (!bad && !asJson && !quiet) {
    console.log('\n✓ 前缀适配通过：MUST_FIX 与 TEXT_FIX_NEEDED 均为 0。');
  }
  return bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
