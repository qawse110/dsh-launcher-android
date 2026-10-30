/**
 * tools/plugin-upgrade.test.mjs —— app/src/main/assets/install/plugin-upgrade.mjs 的纯函数门禁。
 *
 * 为什么必须单独测这两块：
 * 1. compareVersions：在线升级的**全部判断**（是否可升 / 是否降级 / 是否已最新）都过这个函数。
 *    本仓已经因为版本串非规范 semver（0.9.0-stable、2.8.261028）踩过坑，这里按 semver 语义钉死。
 * 2. extractTarball：从网络下载的 tgz 直接解到设备上的插件目录，是唯一一条「外部字节落盘」的路径。
 *    它必须拒绝 ../ 路径穿越、绝对路径与符号链接——npm 包正常不该出现这些，出现了就是攻击/坏包。
 *
 * 不依赖任何第三方库：tar 头在测试里手工拼（node 没有内置 tar 写入器），gzip 用 node:zlib。
 * 运行：node tools/plugin-upgrade.test.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const TARGET = new URL('../app/src/main/assets/install/plugin-upgrade.mjs', import.meta.url).pathname;
const { compareVersions, extractTarball } = await import(TARGET);

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass += 1; return; }
  failures.push(name + (detail ? '  ← ' + detail : ''));
}
function eq(actual, expected, name) {
  ok(actual === expected, name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

// ── compareVersions ─────────────────────────────────────
// 签名：a 新返回 1，a 旧返回 -1，相等 0
const CMP = [
  ['5.10.11', '5.10.10', 1, '补丁号进位'],
  ['5.10.9', '5.10.10', -1, '按数值而非字典序比段（10 > 9）'],
  ['5.9.99', '5.10.0', -1, '次版本优先于补丁'],
  ['0.9.6', '0.9.4', 1, 'ego-browser 升级方向'],
  ['3.2.1', '3.2.1', 0, '完全相等'],
  ['2.8.261028', '2.8.261027', 1, '大数值日期式版本'],
  ['0.9.0-stable', '0.9.0', -1, '预发布版 < 同号正式版'],
  ['0.9.0-stable', '0.9.0-alpha', 1, 'alpha < stable（字典序）'],
  ['1.0.0-rc.2', '1.0.0-rc.1', 1, 'rc 序号'],
  ['1.0.0-rc.10', '1.0.0-rc.9', -1, 'rc.10 与 rc.9 按字符串比（semver 的已知宽松点，钉死现状）'],
  ['v1.2.3', '1.2.3', 0, '容忍前导 v'],
  ['1.2.3+build5', '1.2.3', 0, '忽略 build 元数据'],
  ['1.3.10', '1.6.0', -1, 'codebuddy 本仓领先上游的场景'],
  ['1.2', '1.2.0', 0, '缺段按 0 补'],
];
for (const [a, b, want, why] of CMP) {
  eq(compareVersions(a, b), want, 'compareVersions(' + a + ', ' + b + ') = ' + want + ' [' + why + ']');
  eq(compareVersions(b, a), -want, 'compareVersions 反向对称 (' + b + ', ' + a + ')');
}

// ── tar 构造器 ──────────────────────────────────────────
function tarHeader({ name, size, type = '0', mode = 0o644 }) {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'utf8');
  h.write('0000000\0', 108, 'utf8');          // uid
  h.write('0000000\0', 116, 'utf8');          // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'utf8');
  h.write('        ', 148, 'utf8');           // 校验和占位（8 空格）
  h.write(type, 156, 'utf8');
  h.write('ustar\0' + '00', 257, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  return h;
}
function tarEntry(name, content, type = '0') {
  const body = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([tarHeader({ name, size: body.length, type }), padded]);
}
function tarPax(name, target) {
  const rec = 'path=' + target + '\n';
  const len = String(Buffer.byteLength(rec) + String(Buffer.byteLength(rec)).length + 1).length
    + Buffer.byteLength(rec) + 1;
  // pax 记录格式：<总长度> <key>=<value>\n，长度含自身
  let record = rec;
  let total = Buffer.byteLength(record) + 1;
  while (String(total).length + Buffer.byteLength(record) + 1 !== total) {
    total = String(total).length + Buffer.byteLength(record) + 1;
  }
  record = String(total) + ' ' + rec;
  const body = Buffer.from(record, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([tarHeader({ name, size: body.length, type: 'x' }), padded]);
}
const END = Buffer.alloc(1024, 0);

function buildTgz(chunks) {
  return gzipSync(Buffer.concat([...chunks, END]));
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'plugin-upgrade-test-'));
}

const readAll = (dir) => {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else out[rel] = readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
};

// ── extractTarball：正常包 ──────────────────────────────
{
  const dir = freshDir();
  try {
    const tgz = buildTgz([
      tarEntry('package/', '', '5'),
      tarEntry('package/package.json', '{"name":"dsh-ego-browser","version":"0.9.6"}'),
      tarEntry('package/lib/', '', '5'),
      tarEntry('package/lib/index.js', 'export const x = 1;'),
    ]);
    const r = extractTarball(tgz, dir);
    const files = readAll(dir);
    eq(r.files, 2, '正常包：解出 2 个文件');
    eq(files['package.json'], '{"name":"dsh-ego-browser","version":"0.9.6"}', '正常包：顶层 package/ 已剥离');
    eq(files['lib/index.js'], 'export const x = 1;', '正常包：子目录结构保留');
    ok(!existsSync(join(dir, 'package')), '正常包：不残留 package/ 外壳目录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── extractTarball：pax 长路径 ─────────────────────────
{
  const dir = freshDir();
  try {
    const longPath = 'package/lib/' + 'a'.repeat(120) + '/deep.js';
    const tgz = buildTgz([
      tarPax('PaxHeader/entry', longPath),
      tarEntry('package/lib/truncated-name.js', 'deep-content'),
    ]);
    extractTarball(tgz, dir);
    const files = readAll(dir);
    ok(files['lib/' + 'a'.repeat(120) + '/deep.js'] === 'deep-content', 'pax 长路径：按 path 记录解出');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── extractTarball：拒绝路径穿越 ───────────────────────
{
  const dir = freshDir();
  try {
    const tgz = buildTgz([
      tarEntry('package/ok.txt', 'ok'),
      tarEntry('package/../../evil.txt', 'pwned'),
      tarEntry('/absolute.txt', 'pwned'),
    ]);
    const r = extractTarball(tgz, dir);
    const files = readAll(dir);
    eq(Object.keys(files).length, 1, '路径穿越：只解出合法文件');
    ok(files['ok.txt'] === 'ok', '路径穿越：合法文件内容正确');
    ok(r.skipped >= 2, '路径穿越：非法条目被计入 skipped（实际 ' + r.skipped + '）');
    ok(!existsSync(join(dir, '..', 'evil.txt')), '路径穿越：没有写到上级目录');
    ok(!existsSync('/absolute.txt'), '路径穿越：没有写到绝对路径');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── extractTarball：跳过符号链接与硬链接 ───────────────
{
  const dir = freshDir();
  try {
    const tgz = buildTgz([
      tarEntry('package/real.js', 'real'),
      tarEntry('package/link.js', '/etc/passwd', '2'),   // 符号链接
      tarEntry('package/hard.js', 'package/real.js', '1'), // 硬链接
      tarEntry('package/pipe', '', '6'),                  // FIFO
    ]);
    const r = extractTarball(tgz, dir);
    const files = readAll(dir);
    eq(Object.keys(files).join(','), 'real.js', '链接/FIFO：只解出普通文件');
    eq(r.skipped, 3, '链接/FIFO：三个非普通条目被跳过');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── extractTarball：坏包不崩 ───────────────────────────
{
  const dir = freshDir();
  try {
    // 头部声明的 size 大于实际内容 ⇒ 截断归档
    const header = tarHeader({ name: 'package/big.js', size: 4096 });
    const tgz = gzipSync(Buffer.concat([header, Buffer.from('short', 'utf8')]));
    const r = extractTarball(tgz, dir);
    eq(r.files, 0, '截断归档：不写出半截文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 结果 ────────────────────────────────────────────────
if (failures.length) {
  console.error('✗ plugin-upgrade 单测失败 ' + failures.length + ' 项（通过 ' + pass + '）');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('✓ plugin-upgrade 单测通过：' + pass + ' 项断言（compareVersions + extractTarball）');
