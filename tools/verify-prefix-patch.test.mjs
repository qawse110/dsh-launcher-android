#!/usr/bin/env node
/**
 * tools/verify-prefix-patch.mjs 与 tools/repair-prefix-patch.mjs 的自测。
 *
 * CI 无真实 PREFIX 可审，故这里构造最小 fixture 树，锁住三件最关键的事：
 *  1. 能查出带官方 usr 前缀的文件（= 本缺陷的最小复现，含「载荷 mtime 很老」）；
 *  2. **不把镜像路径误报为残留**（`dataDir + 官方路径` 自带官方串作后缀，
 *     这是该审计最容易写错的地方）；
 *  3. 修复后审计转绿，且等长替换不改变文件长度/权限位、不二次嵌套。
 *
 * 运行：node tools/verify-prefix-patch.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, dataDirForms } from './verify-prefix-patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, 'verify-prefix-patch.mjs');
const REPAIR = path.join(HERE, 'repair-prefix-patch.mjs');

const OFFICIAL = '/data/data/com.termux/files/usr';
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

/** 造一个 usr = <tmp>/data/files/termux/usr，使 dataDir 推导与真机一致。 */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-audit-'));
  const usr = path.join(base, 'data', 'files', 'termux', 'usr');
  fs.mkdirSync(path.join(usr, 'bin'), { recursive: true });
  return { base, usr };
}

function run(script, usr, extra = []) {
  return execFileSync(process.execPath, [script, '--usr', usr, ...extra], {
    encoding: 'utf8',
  });
}

console.log('verify-prefix-patch / repair-prefix-patch');

check('查出带官方 usr 前缀的文件（缺陷最小复现：mtime 很老也一样查得出）', () => {
  const { usr } = fixture();
  const git = path.join(usr, 'bin', 'git');
  fs.writeFileSync(git, `X=${OFFICIAL}/libexec/git-core`);
  // 老 mtime 正是 apt/dpkg 解包保留包内时间戳的形态
  fs.utimesSync(git, 1, 1);

  const r = audit(usr);
  assert.deepEqual(r.mustFix, ['bin/git'], `expect bin/git, got ${JSON.stringify(r.mustFix)}`);
  assert.equal(r.textFixNeeded.length, 0);
});

check('镜像路径不被误报：dataDir + 官方路径 应判为已修好', () => {
  const { usr } = fixture();
  const dataDir = path.dirname(path.dirname(path.dirname(usr)));
  const mirror = `${dataDir}${OFFICIAL}`;
  fs.writeFileSync(path.join(usr, 'etc.conf'), `P=${mirror}/bin`);
  const r = audit(usr);
  assert.deepEqual(r.mustFix, [], `镜像路径被误报为核心前缀：${JSON.stringify(r.mustFix)}`);
  assert.deepEqual(r.textFixNeeded, [], `镜像路径被误报为文本残留：${JSON.stringify(r.textFixNeeded)}`);
});

check('修复后审计转绿，且长度与权限位不变', () => {
  const { usr } = fixture();
  const git = path.join(usr, 'bin', 'git');
  fs.writeFileSync(git, `A=${OFFICIAL}/bin`.padEnd(512, '.'));
  fs.chmodSync(git, 0o755);
  const size = fs.statSync(git).size;

  run(REPAIR, usr);

  const after = audit(usr);
  assert.equal(after.mustFix.length, 0, '修复后仍有核心前缀残留');
  assert.equal(after.textFixNeeded.length, 0, '修复后仍有文本残留');
  assert.equal(fs.statSync(git).size, size, '等长替换不应改变文件长度');
  assert.equal(fs.statSync(git).mode & 0o777, 0o755, '等长替换不应改变权限位');
  assert.ok(
    fs.readFileSync(git, 'utf8').includes('/data/user/0/com.dsh.nextapp1/t/bin'),
    '未改写成短前缀',
  );
});

check('修复幂等：连跑两次结果一致', () => {
  const { usr } = fixture();
  fs.writeFileSync(path.join(usr, 'bin', 'git'), `A=${OFFICIAL}/bin`);
  run(REPAIR, usr);
  const once = fs.readFileSync(path.join(usr, 'bin', 'git'));
  run(REPAIR, usr);
  const twice = fs.readFileSync(path.join(usr, 'bin', 'git'));
  assert.ok(once.equals(twice), '二次修复改变了内容（幂等被破坏）');
});

check('不把镜像路径二次嵌套改坏（幂等性最关键的一条）', () => {
  const { usr } = fixture();
  const dataDir = path.dirname(path.dirname(path.dirname(usr)));
  const mirror = `${dataDir}${OFFICIAL}`;
  const f = path.join(usr, 'bin', 'cfg');
  fs.writeFileSync(f, `P=${mirror}/bin/git`);
  run(REPAIR, usr);
  const got = fs.readFileSync(f, 'utf8');
  assert.equal(got, `P=${mirror}/bin/git`, `镜像路径被嵌套改写成：${got}`);
});

check('干净环境返回 0 且无 MUST_FIX', () => {
  const { usr } = fixture();
  fs.writeFileSync(path.join(usr, 'bin', 'ok'), 'P=/data/user/0/com.dsh.nextapp1/t/bin');
  const r = JSON.parse(run(VERIFY, usr, ['--json']));
  assert.equal(r.mustFix.length, 0);
});

check('残留环境退出码为 1（CI 门禁必须能拦住）', () => {
  const { usr } = fixture();
  fs.writeFileSync(path.join(usr, 'bin', 'git'), `A=${OFFICIAL}/bin`);
  let code = 0;
  try {
    run(VERIFY, usr, ['--quiet']);
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1, `期望退出码 1，实得 ${code}`);
});

// ---------------- K1：字节级替换的严格性（穷举差分） ----------------
// replaceOutsideMirror 跳过镜像命中时的游标推进最容易写出「丢字节/漏改后续命中」。
// 这里用独立重写的参照实现（逐字节状态机）对 3000+ 随机与边界输入做差分，
// 并断言长度守恒（等长替换的前提）。

const SHORT = '/data/user/0/com.dsh.nextapp1/t';
const DATA_DIR = '/data/user/0/com.dsh.nextapp1';

function indexOfBytes(hay, needle, from = 0) {
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

function isImmAfter(bytes, at, prefix) {
  if (!prefix || !prefix.length || at < prefix.length) return false;
  const start = at - prefix.length;
  for (let k = 0; k < prefix.length; k++) if (bytes[start + k] !== prefix[k]) return false;
  return true;
}

/** 与 PrefixPatcher.replaceOutsideMirror 等价的测试实现（mirrorRoots 为列表）。 */
function replaceOutsideMirror(input, oldB, newB, mirrorRoots) {
  if (!oldB.length) return input;
  const parts = [];
  let cursor = 0;
  let hit = indexOfBytes(input, oldB);
  while (hit >= 0) {
    if (mirrorRoots.some((p) => isImmAfter(input, hit, p))) {
      parts.push(input.subarray(cursor, hit + oldB.length));
    } else {
      parts.push(input.subarray(cursor, hit));
      parts.push(newB);
    }
    cursor = hit + oldB.length;
    hit = indexOfBytes(input, oldB, cursor);
  }
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts);
}

/** 独立参照实现：逐字节状态机，不复用上面的 indexOf。 */
function referenceReplace(input, oldB, newB, mirrorRoots) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    const matched =
      i + oldB.length <= input.length &&
      input.compare(oldB, 0, oldB.length, i, i + oldB.length) === 0;
    if (matched) {
      if (mirrorRoots.some((p) => isImmAfter(input, i, p))) out.push(...input.subarray(i, i + oldB.length));
      else out.push(...newB);
      i += oldB.length;
    } else {
      out.push(input[i]);
      i++;
    }
  }
  return Buffer.from(out);
}

check('K1 差分：跳过镜像命中时不丢字节、不漏改后续命中（3000+ 例）', () => {
  const oldB = Buffer.from(OFFICIAL, 'latin1');
  const newB = Buffer.from(SHORT, 'latin1');
  // 覆盖两种别名写法：只有当命中点紧邻其中任一个时才视为镜像内
  const mirrors = [DATA_DIR, '/data/data/com.dsh.nextapp1'].map((s) => Buffer.from(s, 'latin1'));

  const cases = [];
  cases.push(['empty', Buffer.from('')]);
  cases.push(['only-official', oldB]);
  cases.push(['mirror+official', Buffer.concat([mirrors[0], oldB])]);
  cases.push(['alias-mirror+official', Buffer.concat([mirrors[1], oldB])]);
  cases.push(['mirror+off+off', Buffer.concat([mirrors[0], oldB, Buffer.from('/x'), oldB])]);
  cases.push(['off+mirror+off', Buffer.concat([oldB, Buffer.from('/a'), mirrors[0], oldB])]);
  cases.push(['truncated-mirror', Buffer.concat([Buffer.from(`${DATA_DIR}/dat`), oldB])]);
  cases.push(['two-mirrors', Buffer.concat([mirrors[0], oldB, mirrors[0], oldB])]);
  cases.push(['mirror+off+suffix', Buffer.concat([mirrors[0], oldB, Buffer.from('XYZ')])]);

  const alpha = [...OFFICIAL, '/', 'a', 'X'].map((c) => c.charCodeAt(0));
  for (let t = 0; t < 3000; t++) {
    const n = Math.floor(Math.random() * 80);
    const a = [];
    for (let k = 0; k < n; k++) a.push(alpha[Math.floor(Math.random() * alpha.length)]);
    cases.push([`rand${t}`, Buffer.from(a)]);
  }

  for (const [label, buf] of cases) {
    const got = replaceOutsideMirror(buf, oldB, newB, mirrors);
    const exp = referenceReplace(buf, oldB, newB, mirrors);
    assert.ok(
      got.equals(exp),
      `${label}: 与参照实现不一致\n  got=${JSON.stringify(got.toString('latin1'))}\n  exp=${JSON.stringify(exp.toString('latin1'))}`,
    );
    assert.equal(got.length, buf.length, `${label}: 等长替换却改变了长度`);
  }
});

// ---------------- K3：文本 patch 的 token 三段替换 ----------------

const OFFICIAL_FILES_ROOT = '/data/data/com.termux/files';
const OFFICIAL_APT_CACHE = '/data/data/com.termux/cache/apt';
const USR_DIR = `${DATA_DIR}/files/termux/usr`;
const TOKEN = '@@DSH_MIRROR_FILES@@';

/**
 * 与 PrefixPatcher.patchTextOfficialDirs 逐字对应（**已移除 @@DSH_MIRROR_FILES@@ 占位符**）。
 *
 * Kotlin 侧现在对 OFFICIAL_FILES 与 OFFICIAL_APT_CACHE 都统一走
 * hasOccurrenceOutsideMirror + replaceOutsideMirror：
 *   · 语义与旧的「token 三段替换」等价（幂等、不二次嵌套）；
 *   · 但不再依赖任何魔法字符串，因此不存在「输入本身含 token 被误还原」的碰撞风险。
 */
function patchText(text, mirrorRoots = dataDirForms(USR_DIR)) {
  const mirFiles = `${DATA_DIR}${OFFICIAL_FILES_ROOT}`;
  const newAptCache = `${USR_DIR}/var/cache/apt`;
  let out = text;
  const step = (needle, repl) => {
    const b = Buffer.from(out, 'latin1');
    const n = Buffer.from(needle, 'latin1');
    if (hasOccurrenceOutsideMirror(b, n, mirrorRoots)) {
      out = replaceOutsideMirror(b, n, Buffer.from(repl, 'latin1'), mirrorRoots).toString('latin1');
    }
  };
  if (out.includes(OFFICIAL_FILES_ROOT)) step(OFFICIAL_FILES_ROOT, mirFiles);
  if (out.includes(OFFICIAL_APT_CACHE)) step(OFFICIAL_APT_CACHE, newAptCache);
  return out;
}

/** 与实现侧 hasOccurrenceOutsideMirror 等价（测试用）。 */
function hasOccurrenceOutsideMirror(bytes, needle, mirrorRoots) {
  let from = 0;
  for (;;) {
    const hit = indexOfBytes(bytes, needle, from);
    if (hit < 0) return false;
    if (!mirrorRoots.some((p) => isImmAfter(bytes, hit, p))) return true;
    from = hit + 1;
  }
}

/** 统计「不在镜像串内」的官方 files 根命中数。 */
function filesResiduesOutsideMirror(s) {
  const mirFiles = `${DATA_DIR}${OFFICIAL_FILES_ROOT}`;
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(OFFICIAL_FILES_ROOT, i)) >= 0) {
    const mirrorStart = i - (mirFiles.length - OFFICIAL_FILES_ROOT.length);
    if (!(mirrorStart >= 0 && s.startsWith(mirFiles, mirrorStart))) n++;
    i++;
  }
  return n;
}

check('K3 文本 patch 幂等，且混合「镜像串 + 裸官方串」结果正确', () => {
  const mirFiles = `${DATA_DIR}${OFFICIAL_FILES_ROOT}`;
  const newAptCache = `${USR_DIR}/var/cache/apt`;
  const cases = [
    ['bare-home', `H=${OFFICIAL_FILES_ROOT}/home`, `H=${mirFiles}/home`],
    ['bare+aptcache', `H=${OFFICIAL_FILES_ROOT}/home\nC=${OFFICIAL_APT_CACHE}`, `H=${mirFiles}/home\nC=${newAptCache}`],
    ['already-mirror', `H=${mirFiles}/home`, `H=${mirFiles}/home`],
    ['mirror+bare', `A=${mirFiles}/home\nB=${OFFICIAL_FILES_ROOT}/usr`, `A=${mirFiles}/home\nB=${mirFiles}/usr`],
    ['mirror+bare+cache', `A=${mirFiles}/home\nB=${OFFICIAL_FILES_ROOT}/x\nC=${OFFICIAL_APT_CACHE}`,
      `A=${mirFiles}/home\nB=${mirFiles}/x\nC=${newAptCache}`],
    ['many-mirrors', `${mirFiles}/a ${mirFiles}/b`, `${mirFiles}/a ${mirFiles}/b`],
    ['nested', `X=${DATA_DIR}${OFFICIAL_FILES_ROOT}${OFFICIAL_FILES_ROOT}`, `X=${DATA_DIR}${OFFICIAL_FILES_ROOT}${mirFiles}`],
    ['none', 'nothing here', 'nothing here'],
  ];
  for (const [label, input, expect] of cases) {
    const once = patchText(input);
    assert.equal(once, expect, `${label}: 结果不符\n  got=${once}\n  exp=${expect}`);
    assert.equal(patchText(once), once, `${label}: 第二次调用改变了内容（非幂等）`);
    assert.equal(filesResiduesOutsideMirror(once), 0, `${label}: 镜像外仍残留官方 files 根`);
    assert.ok(!once.includes(TOKEN), `${label}: 残留内部 token`);
  }
});

// ---------------- 别名容错：/data/data/<pkg> 与 /data/user/0/<pkg> ----------------
// 两者是同一 inode（实测 stat %d:%i 相同）但字符串不同。审计/修复必须同时认这两种
// 写法，否则当 usr 以另一种形式传入时镜像判定会失配，已改对的镜像路径会被当成残留，
// 甚至被二次嵌套改坏。

check('dataDirForms 给出 /data/user/0 与 /data/data 两种等价写法', () => {
  const userUsr = '/data/user/0/com.dsh.nextapp1/files/termux/usr';
  const dataUsr = '/data/data/com.dsh.nextapp1/files/termux/usr';
  const a = dataDirForms(userUsr).map((b) => b.toString('latin1')).sort();
  const b = dataDirForms(dataUsr).map((b) => b.toString('latin1')).sort();
  assert.deepEqual(a, ['/data/data/com.dsh.nextapp1', '/data/user/0/com.dsh.nextapp1']);
  assert.deepEqual(b, a, '两种 usr 写法应给出同一组形式上界');
});

check('别名写法下镜像路径仍不被误报（跨写法识别）', () => {
  const { usr } = fixture();
  const realDataDir = path.dirname(path.dirname(path.dirname(usr)));
  // 用 dataDirForms 的每一形式构造镜像串，都必须被判为「已修好」。
  for (const form of dataDirForms(usr).map((b) => b.toString('latin1'))) {
    const f = path.join(usr, 'bin', `cfg-${form.replace(/\W/g, '_')}`);
    fs.writeFileSync(f, `P=${form}${OFFICIAL}/bin`);
    const r = audit(usr);
    assert.deepEqual(r.mustFix, [], `镜像形式 ${form} 被误报为核心前缀：${JSON.stringify(r.mustFix)}`);
    assert.deepEqual(r.textFixNeeded, [], `镜像形式 ${form} 被误报为文本残留：${JSON.stringify(r.textFixNeeded)}`);
    fs.unlinkSync(f);
  }
  assert.ok(realDataDir, 'fixture 的 dataDir 应可推导');
});

// ---------------- apt cache 镜像形态的口径一致性 ----------------
// audit 把 `dataDir + OFFICIAL_APT_CACHE` 判为镜像内命中（不报残留）；
// patchTextOfficialDirs 必须同样排除它，否则会出现「audit 说不该改、patch 却改了」
// 的口径分裂，把已改对的镜像路径二次嵌套成坏路径。

check('apt cache 镜像形态：audit 不报残留', () => {
  const { usr } = fixture();
  const dataDir = path.dirname(path.dirname(path.dirname(usr)));
  const mirroredApt = `${dataDir}${OFFICIAL_APT_CACHE}`;
  const f = path.join(usr, 'etc', 'apt.conf');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `C=${mirroredApt}\n`);
  const r = audit(usr);
  assert.deepEqual(r.mustFix, [], `apt 镜像被误报为核心前缀：${JSON.stringify(r.mustFix)}`);
  assert.deepEqual(r.textFixNeeded, [], `apt 镜像被误报为文本残留：${JSON.stringify(r.textFixNeeded)}`);
});

check('apt cache 镜像形态：patchText 不二次改写（与 audit 口径一致）', () => {
  const { usr } = fixture();
  const dataDir = path.dirname(path.dirname(path.dirname(usr)));
  const mirroredApt = `${dataDir}${OFFICIAL_APT_CACHE}`;
  const f = path.join(usr, 'etc', 'apt.conf');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `C=${mirroredApt}\n`);
  // 镜像根是 fixture 的 dataDir，必须显式传入（不能用默认的真机 USR_DIR 形式）
  const out = patchText(`C=${mirroredApt}\n`, dataDirForms(usr));
  assert.equal(
    out, `C=${mirroredApt}\n`,
    'apt cache 镜像形态被二次改写成：' + out,
  );
});

// ---------------- 边界输入：已移除的占位符与「仅二进制残留」 ----------------

check('占位符已彻底移除：含 @@DSH_MIRROR_FILES@@ 的字面输入不被特殊对待', () => {
  // 这是移除 token 的直接动因：旧实现在「文件本身含该字面量」时会把它当成占位符
  // 还原成镜像路径，凭空造出路径。现在它只是普通文本，随官方串一同按规则改写。
  const mirFiles = `${DATA_DIR}${OFFICIAL_FILES_ROOT}`;
  const src = `K=@@DSH_MIRROR_FILES@@\nH=${OFFICIAL_FILES_ROOT}/home`;
  const out = patchText(src);
  assert.equal(
    out, `K=@@DSH_MIRROR_FILES@@\nH=${mirFiles}/home`,
    `含 token 的输入被错误改写：${out}`,
  );
  assert.equal(patchText(out), out, '二次调用改变了内容（非幂等）');
});

check('仅二进制 files/home 残留 → audit 判 clean（不阻门禁）', () => {
  const { usr } = fixture();
  const bin = path.join(usr, 'bin', 'tool');
  // 含 NUL 的二进制，仅带 files/home（无 files/usr 核心前缀）
  fs.writeFileSync(bin, Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]),
    Buffer.from(`${OFFICIAL_FILES_ROOT}/home`, 'latin1'),
  ]));
  const r = audit(usr);
  assert.equal(r.mustFix.length, 0, '不应把 files/home 判为 MUST_FIX');
  assert.deepEqual(r.binaryRemnants, ['bin/tool'], `应归入 binaryRemnants，实得 ${JSON.stringify(r)}`);
  assert.equal(r.textFixNeeded.length, 0);
  // clean 只要求 mustFix 与 textFixNeeded 为空
  assert.ok(r.mustFix.length === 0 && r.textFixNeeded.length === 0, '仅二进制残留应判 clean');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
