#!/usr/bin/env node
/**
 * install/plugin-upgrade.mjs —— 插件「在线升级」唯一实现（npm 渠道）。
 *
 * 为什么要有这个文件：
 * 内置/可选插件的源码是**随 APK 打包**进 assets/extra-plugins 与 assets/optional-plugins 的，
 * 装配链（install/plugins.mjs → syncExtraPlugin）只会把 APK 里的副本同步进 files/plugins，
 * 因此「上游发布了新版本」这件事在本部署里**没有任何入口** —— 用户只能等下一个 APK。
 * 本脚本补上这条通道：按清单里的 "npm" 字段直连 registry 取版、下 tarball、整目录替换
 * files/plugins/<dir>，并把结果写进 files/plugin-upgrade.json 供插件管理页读取。
 *
 * 三条设计约束（都不是可选项）：
 * 1. **只动 files/plugins/<dir>，绝不动 files/extra-plugins/<dir>。**
 *    extra-plugins 是「内置源」：APK 资产的设备侧镜像，语义是出厂版本。
 *    「一键重置」必须还能回到出厂版本，所以在线升级不能污染它。
 * 2. **升级前必须备份。** 上游发版可能引入不兼容（本仓历史上踩过 dsh peer 判定、
 *    client bundle 缺失两类），出问题时用户要能一键退回。
 * 3. **降级守卫与安装链同源。** install/plugins.mjs 的 syncExtraPlugin() 已经会拒绝
 *    「APK 源比副本旧」的回灌；本脚本反向也要成立：在线升级过的副本，不能因为
 *    APK 升级而被旧内置源盖掉（Kotlin 侧 AssetSync.refreshBundledPluginCopies 已有配套守卫）。
 *
 * 用法（Kotlin 的插件管理页是唯一调用方，也可手动执行）：
 *   node plugin-upgrade.mjs --check [--force] [--only <dir>]   查上游最新版（默认命令）
 *   node plugin-upgrade.mjs --apply <dir> [--version <v>]      升级单个插件
 *   node plugin-upgrade.mjs --rollback <dir> [--version <v>]   回退到备份
 *   node plugin-upgrade.mjs --list                             列出升级/备份状态
 * 退出码：0 = 成功（含「已是最新」）；1 = 失败（网络/校验/解包）。
 * 机器可读结果一律落 files/plugin-upgrade.json，stdout 只打人类可读日志。
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import {
  EXTRA_PLUGINS_SRC, FILES_DIR, PLUGINS_DIR, REGISTRY, REGISTRY_FALLBACK, log,
} from './env.mjs';

// ── 常量 ────────────────────────────────────────────────
const STATE_FILE = join(FILES_DIR, 'plugin-upgrade.json');
const BACKUP_ROOT = join(FILES_DIR, '.plugin-backup');
const TMP_DIR = process.env.TMPDIR || join(FILES_DIR, 'tmp');
/** 与 DshUpdater.AUTO_CHECK_INTERVAL_MS 保持一致：查版结果缓存 6 小时。 */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** 每个插件最多保留几份备份（按写入时间，旧的先删）。 */
const MAX_BACKUPS = 3;
const USER_AGENT = 'DshLauncher/4.0';
/** registry 精简元数据（corgi）：只要 dist-tags / versions[v].dist / dependencies，体积小一个量级。 */
const CORGI_ACCEPT = 'application/vnd.npm.install-v1+json';
const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

const MANIFEST_CANDIDATES = [
  // 设备上：files/extra-plugins/../plugin-manifest.json（与 install/plugins.mjs 的 loadManifest 同口径）
  join(EXTRA_PLUGINS_SRC, '..', 'plugin-manifest.json'),
  join(FILES_DIR, 'plugin-manifest.json'),
  // 仓库内直接跑（CI / 调试）：<repo>/app/src/main/assets/plugin-manifest.json
  join(dirname(new URL(import.meta.url).pathname), '..', 'plugin-manifest.json'),
];

// ── 版本比较 ────────────────────────────────────────────
// 不复用 install/plugins.mjs 的 compareVersion：那个只比较首个数点段（够用于「不降级」判断），
// 在线升级要区分 0.9.0-stable 与 0.9.1，必须按 semver 的 prerelease 规则比。
function parseVer(v) {
  const s = String(v ?? '').trim().replace(/^[v=]/, '').split('+')[0];
  const dash = s.indexOf('-');
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : '';
  const nums = core.split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre };
}

/** semver 方向比较：a 新返回 1，a 旧返回 -1，相等 0。解析不出的段按 0 处理。 */
export function compareVersions(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < n; i += 1) {
    const x = A.nums[i] ?? 0;
    const y = B.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;   // 正式版 > 预发布版
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

// ── 清单 ────────────────────────────────────────────────
function manifestPath() {
  return MANIFEST_CANDIDATES.find((p) => existsSync(p)) || null;
}

function loadManifest() {
  const p = manifestPath();
  if (!p) return { manifest: null, path: null };
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(m.builtin) || Array.isArray(m.optional)) return { manifest: m, path: p };
  } catch (e) {
    log('plugin-upgrade: 清单解析失败 ' + String(e?.message || e));
  }
  return { manifest: null, path: p };
}

function allEntries(manifest) {
  return [...(manifest?.builtin || []), ...(manifest?.optional || [])];
}

function findEntry(manifest, dir) {
  return allEntries(manifest).find((e) => e.dir === dir || e.name === dir) || null;
}

/** 本地已装配副本的版本；没有副本时回退到内置源（表示「未装配但源在」）。 */
function localVersion(dir) {
  for (const root of [PLUGINS_DIR, EXTRA_PLUGINS_SRC]) {
    const pkg = join(root, dir, 'package.json');
    if (!existsSync(pkg)) continue;
    try {
      const v = JSON.parse(readFileSync(pkg, 'utf8')).version || '';
      if (v) return { version: v, from: root === PLUGINS_DIR ? 'plugins' : 'source' };
    } catch { /* 坏 package.json 当作没有 */ }
  }
  return { version: '', from: 'absent' };
}

// ── 状态文件 ────────────────────────────────────────────
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch { /* 首次运行 / 文件损坏都按空状态 */ }
  return { version: 1, checkedAt: null, checkedAtMs: 0, ok: true, items: [], upgraded: {} };
}

function writeState(state) {
  const out = { ...state, version: 1 };
  if (!out.upgraded || typeof out.upgraded !== 'object') out.upgraded = {};
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(out, null, 2) + '\n');
  } catch (e) {
    log('plugin-upgrade: 状态写入失败 ' + String(e?.message || e));
  }
  return out;
}

function summarize(items) {
  const s = { total: items.length, outdated: 0, latest: 0, ahead: 0, error: 0, noNpm: 0 };
  for (const it of items) {
    if (it.status === 'outdated') s.outdated += 1;
    else if (it.status === 'latest') s.latest += 1;
    else if (it.status === 'ahead') s.ahead += 1;
    else if (it.status === 'error') s.error += 1;
    else if (it.status === 'no-npm') s.noNpm += 1;
  }
  return s;
}

// ── 网络 ────────────────────────────────────────────────
let fetchImpl = typeof fetch === 'function' ? fetch : null;

async function httpGetBuffer(url, accept, timeoutMs) {
  // node >= 18 有全局 fetch；老运行时按需加载 node:https，保证脚本在任何设备 node 上都能跑。
  if (!fetchImpl) {
    const https = await import('node:https');
    fetchImpl = (u, init) => new Promise((resolve, reject) => {
      const req = https.get(u, { headers: init?.headers || {} }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchImpl(new URL(res.headers.location, u).toString(), init));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          arrayBuffer: async () => Buffer.concat(chunks),
          json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { accept, 'user-agent': USER_AGENT },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function registryIndexOf(name) {
  // scoped 包在 registry 路径里保留 @ 与 /（编码成 %2F 会 404）
  return name.startsWith('@') ? name : encodeURIComponent(name);
}

/** 取包元数据：主镜像 → 官方源依次尝试，返回 { packument, source }。 */
async function fetchPackument(name) {
  const idx = registryIndexOf(name);
  const tries = [
    { base: REGISTRY, url: REGISTRY + '/' + idx },
    { base: REGISTRY_FALLBACK, url: REGISTRY_FALLBACK + '/' + idx },
  ];
  let lastErr = null;
  for (const t of tries) {
    try {
      const buf = await httpGetBuffer(t.url, CORGI_ACCEPT, FETCH_TIMEOUT_MS);
      const packument = JSON.parse(buf.toString('utf8'));
      if (!packument || !packument['dist-tags']) throw new Error('无 dist-tags');
      return { packument, source: t.base };
    } catch (e) {
      lastErr = e;
      log('   查版失败 ' + t.base + '：' + String(e?.message || e));
    }
  }
  throw lastErr || new Error('registry 不可达');
}

function tarballFallbackUrl(base, name, version) {
  const file = (name.startsWith('@') ? name.split('/')[1] : name) + '-' + version + '.tgz';
  return base + '/' + registryIndexOf(name) + '/-/' + file;
}

// ── tar 解包（不依赖系统 tar：CI 与设备都没有保证） ──────
function cstr(buf, off, len) {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.toString('utf8', off, end);
}

function octal(buf, off, len) {
  const s = cstr(buf, off, len).trim();
  if (!s) return 0;
  // base-256（GNU tar 大字段）：首字节最高位为 1
  if (buf[off] & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i += 1) v = v * 256 + buf[i];
    return v;
  }
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** 解析 pax 扩展头（typeflag x/g），返回覆盖下一个条目的字段。 */
function parsePax(body) {
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(body.toString('utf8', i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = body.toString('utf8', sp + 1, i + len - 1); // 去掉行尾 \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * 把 tar.gz 解到 destDir。只接受普通文件与目录；符号链接/硬链接/设备文件一律跳过
 * （npm 包产物里不该出现，出现了也不该在 Android 上被解出来）。
 */
export function extractTarball(gzBuf, destDir) {
  const tar = gunzipSync(gzBuf);
  let off = 0;
  let longName = null;
  let pax = null;
  let files = 0;
  let skipped = 0;
  const written = [];
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    // 全零块 = 归档结束
    let allZero = true;
    for (let i = 0; i < 512; i += 1) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;

    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    const bodyStart = off + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) break; // 截断归档，停下（已写出的文件保留）
    const body = tar.subarray(bodyStart, bodyEnd);
    off = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'x') { pax = parsePax(body); continue; }
    if (type === 'g') continue; // 全局 pax 头，npm 产物不用
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'K') continue; // long linkname，链接本就不收

    let name = longName || cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (!longName && prefix) name = prefix + '/' + name;
    if (pax?.path) name = pax.path;
    longName = null;
    pax = null;

    // npm tarball 的顶层目录固定是 package/
    name = name.replace(/^\.\//, '').replace(/^package\//, '');
    if (!name || name === 'package') continue;

    const parts = name.split('/');
    if (parts.some((p) => p === '..' || p === '')) { skipped += 1; continue; }
    if (name.startsWith('/')) { skipped += 1; continue; }

    const target = join(destDir, name);
    if (type === '5') { // 目录
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') { skipped += 1; continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    files += 1;
    if (written.length < 200) written.push(name);
  }
  return { files, skipped, written };
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let list;
    try { list = readdirSync(d); } catch { return; }
    for (const name of list) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

// ── 备份 ────────────────────────────────────────────────
function backupDirOf(dir, version) {
  return join(BACKUP_ROOT, dir, version || 'unknown');
}

function pruneBackups(dir) {
  const root = join(BACKUP_ROOT, dir);
  if (!existsSync(root)) return;
  let list;
  try { list = readdirSync(root); } catch { return; }
  const ranked = list
    .map((v) => {
      const p = join(root, v);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch { /* 忽略 */ }
      return { v, p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const item of ranked.slice(MAX_BACKUPS)) {
    try { rmSync(item.p, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function listBackups(dir) {
  const root = join(BACKUP_ROOT, dir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((v) => {
        let mtime = 0;
        try { mtime = statSync(join(root, v)).mtimeMs; } catch { /* 忽略 */ }
        return { version: v, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function makeBackup(dir) {
  const src = join(PLUGINS_DIR, dir);
  if (!existsSync(src)) return null;
  const ver = localVersion(dir).version || 'unknown';
  const dst = backupDirOf(dir, ver);
  try {
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dirname(dst), { recursive: true });
    // 用复制而不是 rename：Android 上 files/ 与 tmp/ 可能不同挂载点，rename 会 EXDEV
    cpSync(src, dst, { recursive: true, dereference: false, force: true });
    pruneBackups(dir);
    return { version: ver, path: dst };
  } catch (e) {
    log('   备份失败 ' + dir + '：' + String(e?.message || e));
    return null;
  }
}

/** 递归复制目录（不跟随符号链接：上游包里的软链在 Android 上没有意义，也不该被解出来）。 */
function copyTree(src, dst, opts = {}) {
  let st;
  try { st = statSync(src); } catch { return; }
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name), opts);
    return;
  }
  writeFileSync(dst, readFileSync(src));
}

// ── 检查 ────────────────────────────────────────────────
async function checkOne(entry, opts, prevState) {
  const dir = entry.dir;
  const local = localVersion(dir);
  const base = {
    dir,
    name: entry.name || dir,
    title: entry.title || '',
    npm: entry.npm || '',
    local: local.version,
    latest: '',
    updateAvailable: false,
    status: 'no-npm',
    tarball: '',
    source: '',
    error: null,
    // 清单标了 npmTrimmed：本仓副本是上游包的裁剪版（只删了 sourcemap/.d.ts/
    // 文档/非本宿主适配层，本地文件与上游逐字节同源）。升级会用上游完整包覆盖，
    // 只做加法 —— 功能不变，但体积会变大。UI 要据此给出提示，别让用户以为
    // 「为什么升级后包大了一圈」是 bug。
    trimmed: entry.npmTrimmed === true,
  };
  if (!entry.npm) return base;

  const cached = (prevState.items || []).find((it) => it.dir === dir);
  const cacheFresh = !opts.force
    && cached && prevState.checkedAtMs
    && (Date.now() - prevState.checkedAtMs) < CHECK_TTL_MS
    && cached.latest;
  if (cacheFresh) {
    return { ...base, latest: cached.latest, tarball: cached.tarball || '', source: cached.source || '',
      updateAvailable: compareVersions(cached.latest, local.version) > 0,
      status: statusOf(cached.latest, local.version), cached: true };
  }

  try {
    const { packument, source } = await fetchPackument(entry.npm);
    const latest = packument['dist-tags']?.latest || '';
    if (!latest) throw new Error('无 latest 标签');
    const tarball = packument.versions?.[latest]?.dist?.tarball
      || tarballFallbackUrl(source, entry.npm, latest);
    return { ...base, latest, tarball, source,
      updateAvailable: compareVersions(latest, local.version) > 0,
      status: statusOf(latest, local.version) };
  } catch (e) {
    return { ...base, status: 'error', error: String(e?.message || e) };
  }
}

function statusOf(latest, local) {
  if (!local) return 'outdated';           // 本地没有副本：可安装
  const c = compareVersions(latest, local);
  if (c > 0) return 'outdated';
  if (c === 0) return 'latest';
  return 'ahead';                          // 本地比上游新（本仓定制版/预发布版），不自动降级
}

async function cmdCheck(opts) {
  const { manifest, path } = loadManifest();
  if (!manifest) {
    log('plugin-upgrade: 找不到 plugin-manifest.json（候选路径均不存在）');
    return 1;
  }
  const prev = readState();
  let entries = allEntries(manifest);
  if (opts.only) {
    entries = entries.filter((e) => e.dir === opts.only || e.name === opts.only);
    if (!entries.length) {
      log('plugin-upgrade: 清单里没有 ' + opts.only);
      return 1;
    }
  }
  entries = entries.filter((e) => e.npm);

  log('>> 检查上游版本（' + entries.length + ' 个 npm 渠道插件，清单 ' + basename(path) + '）');
  const items = [];
  for (const e of entries) {
    const it = await checkOne(e, opts, prev);
    items.push(it);
    if (it.status === 'outdated') log('   ↑ ' + it.dir + '  ' + (it.local || '(未装)') + ' → ' + it.latest);
    else if (it.status === 'latest') log('   ✓ ' + it.dir + '  ' + it.local + ' 已是最新');
    else if (it.status === 'ahead') log('   • ' + it.dir + '  ' + it.local + ' 领先上游 ' + it.latest + '（不降级）');
    else if (it.status === 'error') log('   ✗ ' + it.dir + '  查版失败：' + it.error);
  }

  // 只保留本次查过的条目 + 上一次里本次没查的条目（--only 时不丢全量状态）
  const keep = (prev.items || []).filter((it) => !items.some((n) => n.dir === it.dir));
  const merged = [...items, ...keep];
  const state = writeState({
    ...prev,
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    ok: items.every((it) => it.status !== 'error'),
    manifest: path,
    registry: REGISTRY,
    summary: summarize(merged),
    items: merged,
  });
  log('   状态已写入 ' + STATE_FILE + '（可升级 ' + state.summary.outdated + ' 个）');
  return 0;
}

// ── 升级 ────────────────────────────────────────────────
async function cmdApply(dirArg, opts) {
  const { manifest } = loadManifest();
  if (!manifest) { log('plugin-upgrade: 找不到 plugin-manifest.json'); return 1; }
  const entry = findEntry(manifest, dirArg);
  if (!entry) { log('plugin-upgrade: 清单里没有 ' + dirArg); return 1; }
  if (!entry.npm) { log('plugin-upgrade: ' + entry.dir + ' 未声明 npm 渠道（无 online 升级来源）'); return 1; }

  const dir = entry.dir;
  const local = localVersion(dir);
  log('>> 在线升级 ' + dir + '（' + entry.npm + '）');
  log('   当前版本 ' + (local.version || '(未安装)') + '（来源 ' + local.from + '）');
  if (entry.npmTrimmed === true) {
    log('   • 本仓副本是上游包的裁剪版（清单 npmTrimmed）：升级将用上游完整包覆盖，只会补回被裁掉的');
    log('     sourcemap/.d.ts/文档/非本宿主适配层等文件，功能不变但体积会变大。');
  }

  let packument;
  let source;
  try {
    ({ packument, source } = await fetchPackument(entry.npm));
  } catch (e) {
    log('   ✗ 无法获取上游元数据：' + String(e?.message || e));
    return 1;
  }
  const target = opts.version || packument['dist-tags']?.latest || '';
  if (!target) { log('   ✗ 上游无 latest 标签'); return 1; }
  if (!packument.versions?.[target]) { log('   ✗ 上游没有版本 ' + target); return 1; }

  if (!opts.force && local.version && compareVersions(target, local.version) <= 0) {
    log('   ✓ 已是最新（本地 ' + local.version + '，上游 ' + target + '），无需升级');
    // 记一笔「检查过」，让 UI 立刻显示正确状态
    await recordItem(manifest, dir, target, source);
    return 0;
  }

  const tb = packument.versions[target].dist?.tarball
    || tarballFallbackUrl(source, entry.npm, target);
  log('   下载 ' + tb);
  let gz;
  try {
    gz = await httpGetBuffer(tb, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS);
  } catch (e) {
    log('   ✗ 下载失败：' + String(e?.message || e));
    return 1;
  }
  log('   已下载 ' + gz.length + ' 字节，解包 …');

  mkdirSync(TMP_DIR, { recursive: true });
  const stage = join(TMP_DIR, 'plugin-upgrade-' + randomUUID());
  const pkgDir = join(stage, 'pkg');
  mkdirSync(pkgDir, { recursive: true });
  let stats;
  try {
    stats = extractTarball(gz, pkgDir);
  } catch (e) {
    log('   ✗ 解包失败：' + String(e?.message || e));
    safeRm(stage);
    return 1;
  }
  log('   解出 ' + stats.files + ' 个文件' + (stats.skipped ? '（跳过 ' + stats.skipped + ' 个非普通文件）' : ''));

  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    log('   ✗ 包内没有 package.json，拒绝替换');
    safeRm(stage);
    return 1;
  }
  let pkgJson;
  try { pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')); } catch { pkgJson = null; }
  if (!pkgJson || !pkgJson.name) {
    log('   ✗ package.json 不可解析或缺少 name，拒绝替换');
    safeRm(stage);
    return 1;
  }
  if (pkgJson.name !== entry.name) {
    log('   ✗ 包名不符：上游 ' + pkgJson.name + ' ≠ 清单 ' + entry.name + '，拒绝替换');
    safeRm(stage);
    return 1;
  }
  if (String(pkgJson.version) !== String(target)) {
    log('   ⚠ 包内版本 ' + pkgJson.version + ' 与请求版本 ' + target + ' 不一致（按上游为准）');
  }

  const backup = makeBackup(dir);
  if (backup) log('   已备份 ' + (backup.version) + ' → ' + backup.path);
  else log('   • 无现有副本，跳过备份');

  const dst = join(PLUGINS_DIR, dir);
  try {
    safeRm(dst);
    mkdirSync(dirname(dst), { recursive: true });
    copyTree(pkgDir, dst);
  } catch (e) {
    log('   ✗ 替换失败：' + String(e?.message || e));
    if (backup) {
      log('   尝试回滚 …');
      try { safeRm(dst); copyTree(backup.path, dst); log('   ✓ 已回滚到 ' + backup.version); }
      catch (e2) { log('   ✗ 回滚也失败：' + String(e2?.message || e2)); }
    }
    safeRm(stage);
    return 1;
  }
  safeRm(stage);

  const installed = localVersion(dir).version;
  log('   ✓ 已替换 files/plugins/' + dir + '（' + installed + '，' + countFiles(dst) + ' 个文件）');

  // 依赖桥接：上游新版可能引入新依赖。装不上不阻断升级（本仓本来就靠 dsh-prefix 的
  // .pnpm store 桥接），但必须把缺失项如实打出来，否则运行时才炸。
  await relinkDeps();

  const prev = readState();
  const upgraded = { ...(prev.upgraded || {}) };
  upgraded[dir] = {
    from: local.version || '',
    to: installed || target,
    at: new Date().toISOString(),
    atMs: Date.now(),
    backup: backup ? backup.path : '',
    npm: entry.npm,
  };
  writeState({
    ...prev,
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    upgraded,
    items: mergeItem(prev.items || [], {
      dir, name: entry.name, title: entry.title || '', npm: entry.npm,
      local: installed || target, latest: target, updateAvailable: false,
      status: 'latest', tarball: tb, source, error: null,
      trimmed: entry.npmTrimmed === true,
    }),
    summary: summarize(mergeItem(prev.items || [], {
      dir, name: entry.name, title: entry.title || '', npm: entry.npm,
      local: installed || target, latest: target, updateAvailable: false,
      status: 'latest', tarball: tb, source, error: null,
      trimmed: entry.npmTrimmed === true,
    })),
  });
  log('   ⚠ 副本已替换，需重新装配后 dsh 才会使用新代码（插件管理页「重新装配」）');
  return 0;
}

async function relinkDeps() {
  try {
    const deps = await import('./deps.mjs');
    if (typeof deps.linkPluginDeps === 'function') {
      deps.linkPluginDeps();
      log('   依赖桥接已刷新');
    }
  } catch (e) {
    log('   WARN 依赖桥接刷新失败（不阻断升级）：' + String(e?.message || e));
  }
}

function mergeItem(items, item) {
  const out = items.filter((it) => it.dir !== item.dir);
  out.push(item);
  return out;
}

async function recordItem(manifest, dir, latest, source) {
  const prev = readState();
  const entry = findEntry(manifest, dir);
  const local = localVersion(dir).version;
  const item = {
    dir, name: entry?.name || dir, title: entry?.title || '', npm: entry?.npm || '',
    local, latest, updateAvailable: compareVersions(latest, local) > 0,
    status: statusOf(latest, local), tarball: '', source, error: null,
    trimmed: entry?.npmTrimmed === true,
  };
  const items = mergeItem(prev.items || [], item);
  writeState({ ...prev, items, summary: summarize(items) });
}

// ── 回滚 ────────────────────────────────────────────────
async function cmdRollback(dirArg, opts) {
  const backups = listBackups(dirArg);
  if (!backups.length) {
    log('plugin-upgrade: ' + dirArg + ' 没有可用备份（' + join(BACKUP_ROOT, dirArg) + '）');
    return 1;
  }
  const pick = opts.version
    ? backups.find((b) => b.version === opts.version)
    : backups[0];
  if (!pick) {
    log('plugin-upgrade: 备份里没有版本 ' + opts.version + '（现有：' + backups.map((b) => b.version).join(', ') + '）');
    return 1;
  }
  const src = backupDirOf(dirArg, pick.version);
  const dst = join(PLUGINS_DIR, dirArg);
  log('>> 回滚 ' + dirArg + ' → ' + pick.version);
  try {
    safeRm(dst);
    copyTree(src, dst);
  } catch (e) {
    log('   ✗ 回滚失败：' + String(e?.message || e));
    return 1;
  }
  const prev = readState();
  const upgraded = { ...(prev.upgraded || {}) };
  delete upgraded[dirArg];
  writeState({ ...prev, upgraded, checkedAtMs: 0 }); // 置 0：下次查版强制走网络
  log('   ✓ 已回滚到 ' + pick.version + '（' + countFiles(dst) + ' 个文件），需重新装配');
  return 0;
}

// ── 列表 ────────────────────────────────────────────────
function cmdList() {
  const state = readState();
  const { manifest } = loadManifest();
  const entries = manifest ? allEntries(manifest).filter((e) => e.npm) : [];
  log('>> 插件在线升级状态（' + STATE_FILE + '）');
  if (state.checkedAt) log('   上次检查 ' + state.checkedAt + (state.ok ? '' : '（含失败项）'));
  for (const e of entries) {
    const it = (state.items || []).find((x) => x.dir === e.dir);
    const up = (state.upgraded || {})[e.dir];
    const bs = listBackups(e.dir).map((b) => b.version).join(',');
    const flag = up ? '已在线升级 ' + (up.from || '?') + '→' + (up.to || '?')
      : (e.npmTrimmed === true ? '内置源版本（裁剪版，升级会补全上游文件）' : '内置源版本');
    log('   ' + e.dir.padEnd(22) + ' local=' + (it?.local || localVersion(e.dir).version || '?').padEnd(14)
      + ' latest=' + (it?.latest || '?').padEnd(14) + flag + (bs ? '  backups=' + bs : ''));
  }
  return 0;
}

// ── 工具 ────────────────────────────────────────────────
function safeRm(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ── CLI ─────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { cmd: 'check', only: '', version: '', force: false, help: false, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.cmd = 'check';
    else if (a === '--apply') opts.cmd = 'apply';
    else if (a === '--rollback') opts.cmd = 'rollback';
    else if (a === '--list') opts.cmd = 'list';
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--only') opts.only = argv[++i] || '';
    else if (a === '--version') opts.version = argv[++i] || '';
    else if (!a.startsWith('-')) opts.positionals.push(a);
  }
  if ((opts.cmd === 'apply' || opts.cmd === 'rollback') && !opts.positionals.length && !opts.only) {
    opts.help = true;
  }
  return opts;
}

const HELP = [
  '用法: node plugin-upgrade.mjs <命令> [选项]',
  '  --check                查上游最新版（默认命令；结果写 files/plugin-upgrade.json）',
  '  --apply <dir>          把插件升级到上游最新版（或 --version 指定版本）',
  '  --rollback <dir>       回滚到升级前的备份',
  '  --list                 列出各插件本地/上游版本与备份',
  '选项:',
  '  --only <dir>           只处理单个插件（配合 --check）',
  '  --version <v>          指定目标版本（apply/rollback）',
  '  --force                忽略 6 小时缓存；apply 时允许同版本重装',
].join('\n');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  const dirArg = opts.positionals[0] || opts.only || '';
  switch (opts.cmd) {
    case 'apply': return await cmdApply(dirArg, opts);
    case 'rollback': return await cmdRollback(dirArg, opts);
    case 'list': return cmdList();
    default: return await cmdCheck(opts);
  }
}

// 直接执行时才跑 main；被 import（单测）时不跑。
const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    const argv1 = process.argv[1] ? (process.argv[1].startsWith('/') ? process.argv[1] : join(process.cwd(), process.argv[1])) : '';
    return self === argv1 || self.endsWith(argv1.split('/').pop() || '___');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    log('plugin-upgrade 异常：' + String(e?.stack || e));
    process.exit(1);
  });
}
