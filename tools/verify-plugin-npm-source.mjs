#!/usr/bin/env node
/**
 * verify-plugin-npm-source.mjs — 「在线升级」渠道的同源核对（**联网工具，不进 CI**）。
 *
 * 为什么需要它：
 * plugin-manifest.json 里的 `npm` 字段是插件「在线升级」的**唯一**渠道声明。
 * 写错有两种隐蔽后果：
 *   1. 包名拼错或版本不存在 → 插件管理页的「在线升级」永久查版失败，但构建与
 *      装配全部正常（静默失效）；
 *   2. 写成真实存在、但与本仓副本不同源的包 → 用户点一下「升级」，files/plugins
 *      里的副本被上游整包覆盖，**本仓对插件做过的实质修改会被无声抹掉**。
 *
 * 判据与清单的 $npmComment 一一对应，本工具把那些约束**跑一遍**：
 *   ① 包真实存在（能取到清单所声明版本的 tarball）；
 *   ② 包内 package.json 的 name 与清单 name 逐字符相等；
 *   ③ 仓库副本与该版本 tarball 的**实质内容**一致 —— 三种结论：
 *      ✓ 同源          逐文件相同（含仅 CRLF 行尾差异，按语义等同处理）
 *      ✓ 裁剪版        本地文件全部同源，只是删掉了 sourcemap / .d.ts / TS 源码 /
 *                      文档 / 论文配图 / 非 dsh 适配层 ⇒ 可在线升级，升级会用上游
 *                      完整包覆盖（体积变大、功能不变，不会丢本地改动）
 *      ✗ 本地改动      有本地新增文件，或有实质内容差异 ⇒ **禁止**声明 npm 渠道，
 *                      否则升级一次就抹掉本仓的补丁
 *   另外，缺失文件里若含**非文档类**（运行时 js 等），单独打 ⚠ 供人工确认：这类
 *   升级会凭空新增运行时文件，功能面上通常无害，但必须有人看过一眼。
 *
 * 用法：
 *   node tools/verify-plugin-npm-source.mjs              # 查全部带 npm 的条目
 *   node tools/verify-plugin-npm-source.mjs --only modsearch
 *   node tools/verify-plugin-npm-source.mjs --quiet      # 只打结论行
 * 退出码：0 = 没有「本地改动」条目；1 = 有本地改动 / 取不到 / 包名不符。
 *
 * 网络：registry 走 env.mjs 同一套 REGISTRY → REGISTRY_FALLBACK 兜底，与
 * install/plugin-upgrade.mjs 的查版路径一致（避免「能查版却比对不上」）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'app/src/main/assets');
const MANIFEST = join(ASSETS, 'plugin-manifest.json');

const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const REGISTRY_FALLBACK = process.env.NPM_REGISTRY_FALLBACK || 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 180000;

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();
const quiet = argv.includes('--quiet');

const say = (s) => { if (!quiet) console.log(s); };

/** 极简 tar 解析（与 install/plugin-upgrade.mjs 的 extractTarball 同口径，只读不写盘）。 */
function readTarball(gz) {
  const buf = gunzipSync(gz);
  const files = new Map();
  let off = 0;
  let skipped = 0;
  let longName = null;
  let paxPath = null;
  const cstr = (b, from, to) => {
    const slice = b.subarray(from, to);
    const nul = slice.indexOf(0);
    return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let name = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 500);
    const size = parseInt(cstr(h, 124, 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156]) || '0';
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x') { // pax extended header
      const txt = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(txt);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (paxPath) { name = paxPath; paxPath = null; }
    else if (longName) { name = longName; longName = null; }
    else if (prefix) name = prefix + '/' + name;
    if (type === '5') continue;                 // 目录
    if (type !== '0' && type !== '\u0000' && type !== '7') { skipped++; continue; }
    const rel = name.startsWith('package/') ? name.slice('package/'.length) : name;
    if (!rel) continue;
    if (rel.startsWith('/') || rel.split('/').includes('..')) { skipped++; continue; }
    files.set(rel, data);
  }
  return { files, skipped };
}

async function httpGet(url, accept, timeoutMs) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { headers: { accept }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return Buffer.from(await res.arrayBuffer());
  }
  const mod = await import('node:https');
  return await new Promise((ok, ng) => {
    const req = mod.get(url, { headers: { accept } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpGet(res.headers.location, accept, timeoutMs).then(ok, ng);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); ng(new Error('HTTP ' + res.statusCode + ' ' + url)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok(Buffer.concat(chunks)));
      res.on('error', ng);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout ' + url)); });
    req.on('error', ng);
  });
}

/** scoped 包的 registry 路径：只编码裸包名，不编码 @ 与 /（与 npmmirror 实际路径一致）。 */
function registryUrl(base, name) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    const scope = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    return base.replace(/\/+$/, '') + '/' + scope + '/' + encodeURIComponent(rest);
  }
  return base.replace(/\/+$/, '') + '/' + encodeURIComponent(name);
}

async function fetchPackument(name) {
  const errs = [];
  for (const base of [REGISTRY, REGISTRY_FALLBACK]) {
    if (!base) continue;
    try {
      const buf = await httpGet(registryUrl(base, name), 'application/vnd.npm.install-v1+json', FETCH_TIMEOUT_MS);
      return { base, json: JSON.parse(buf.toString('utf8')) };
    } catch (e) { errs.push(base + ': ' + e.message); }
  }
  throw new Error(errs.join(' | ') || 'no registry');
}

/**
 * 每个文件算两枚 sha256：原样（raw）与 CRLF 归一后（nl）。
 * 二进制文件（含 NUL）不算 nl —— 换行归一化对它们无意义。
 * 这样能区分「真的改了代码」与「只是 checkout 的换行差异」（本仓 dsh-net-proxy
 * 的 22 个文件就是后者，曾被误判为本地改动）。
 */
function hashPair(buf) {
  const raw = createHash('sha256').update(buf).digest('hex');
  const nl = buf.indexOf(0) === -1
    ? createHash('sha256').update(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex')
    : null;
  return { raw, nl, size: buf.length };
}

/** 'same' | 'eol'（仅换行差异）| 'diff'。 */
function sameContent(a, b) {
  if (a.raw === b.raw) return 'same';
  if (a.nl && b.nl && a.nl === b.nl) return 'eol';
  return 'diff';
}

/** 仓库内某个插件目录的文件表：rel → hashPair。 */
function localTree(dir) {
  const map = new Map();
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(join(d, e.name), r); continue; }
      if (!e.isFile()) continue;
      map.set(r, hashPair(readFileSync(join(d, e.name))));
    }
  };
  walk(dir, '');
  return map;
}

/**
 * 缺失文件的可裁剪分类。返回类别名，返回 null 表示「非文档类」——升级会把它们
 * 补回来，需人工确认后才好在清单里标 npmTrimmed。
 */
const TRIM_RULES = [
  [/\.map$/, 'sourcemap'],
  [/\.d\.(?:ts|mts|cts)$/, '类型声明'],
  [/\.(?:ts|tsx|mts|cts)$/, 'TS 源码'],
  [/^(?:src|test|tests|__tests__|bench|benchmark|example|examples)\//, '源码/测试/示例'],
  [/^(?:docs?|paper|website)\//, '文档/论文/站点'],
  [/^(?:README|CHANGELOG|HISTORY|CONTRIBUTING|CONFIGURATION|LICEN[CS]E|NOTICE|AUTHORS)/i, '文档'],
  [/\.(?:md|markdown|rst|txt)$/i, '文档'],
  [/\.(?:png|jpe?g|gif|webp|svg|ico|pdf|mp4)$/i, '图片/媒体'],
  [/^hermes-plugin\//, '非 dsh 适配层'],
  // 多宿主 CLI 的「其它 agent 车道」入口。以 billion-context 为例：它的 package.json
  // exports["."] 指向 dist/agent/dsh-native.js（dsh 车道），而 dist/kimi、dist/zcode、
  // dist/claude-*、dist/mcp.js、dist/agent/{dsh-acp,omp,omp-native,opencode,opencode-native,pi,pi-native}.js
  // 只被 `bili plugin install <其它宿主>` 写进别人的配置，dsh 车道一个都不 require
  //（已在 dist/agent/*.js 里 grep 确认：只有字符串 "mcp_call"/"mcp_list_tools"，无 require）。
  [/^dist\/(?:kimi|zcode)\//, '非 dsh 适配层'],
  [/^dist\/(?:claude-mcp-entry|claude-native-bootstrap|mcp)\.js$/, '非 dsh 适配层'],
  [/^dist\/agent\/(?:dsh-acp|omp|omp-native|opencode|opencode-native|pi|pi-native)\.js$/, '非 dsh 适配层'],
];
const trimLabel = (rel) => {
  for (const [re, label] of TRIM_RULES) if (re.test(rel)) return label;
  return null;
};

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const rows = [];
for (const section of ['builtin', 'optional']) {
  const assetDir = section === 'builtin' ? 'extra-plugins' : 'optional-plugins';
  for (const row of manifest[section] || []) {
    if (!row.npm) continue;
    if (only && row.dir !== only && row.npm !== only) continue;
    rows.push({ section, assetDir, row });
  }
}
if (!rows.length) {
  console.log('没有带 npm 渠道的清单条目' + (only ? '（--only ' + only + '）' : ''));
  process.exit(0);
}

const fmt = (n) => {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};
const show = (lines, label, arr, max = 8) => {
  if (!arr.length) return;
  lines.push('    ' + label + ': ' + arr.slice(0, max).join(', ') + (arr.length > max ? ' …（另 ' + (arr.length - max) + ' 个）' : ''));
};

let bad = 0;
let trimmed = 0;
let warn = 0;
let same = 0;
const out = [];
for (const { assetDir, row } of rows) {
  const localDir = join(ASSETS, assetDir, row.dir);
  const head = row.dir + ' (' + row.npm + '@' + row.version + ')';
  try {
    if (!existsSync(localDir)) throw new Error('仓库副本不存在: ' + relative(ROOT, localDir));
    const { base, json } = await fetchPackument(row.npm);
    const ver = json.versions && json.versions[row.version];
    if (!ver) {
      throw new Error('registry 上不存在该版本（清单声明 ' + row.version + '，可用: ' +
        Object.keys(json.versions || {}).slice(-5).join(',') + '）');
    }
    if (ver.name && ver.name !== row.name) {
      throw new Error('包名不符 —— 清单 name=' + row.name + '，registry name=' + ver.name);
    }
    const tb = ver.dist && ver.dist.tarball;
    if (!tb) throw new Error('registry 未给出 tarball');
    const gz = await httpGet(tb, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS);
    const { files, skipped } = readTarball(gz);
    const local = localTree(localDir);

    const remoteHashes = new Map();
    for (const [rel, buf] of files) remoteHashes.set(rel, hashPair(buf));

    const missing = [...remoteHashes.keys()].filter((k) => !local.has(k));
    const extra = [...local.keys()].filter((k) => !remoteHashes.has(k));
    const diffReal = [];
    const diffEol = [];
    for (const [rel, lh] of local) {
      const rh = remoteHashes.get(rel);
      if (!rh) continue;
      const kind = sameContent(lh, rh);
      if (kind === 'diff') diffReal.push(rel);
      else if (kind === 'eol') diffEol.push(rel);
    }
    const missingBytes = missing.reduce((n, k) => n + remoteHashes.get(k).size, 0);

    if (extra.length || diffReal.length) {
      bad++;
      out.push('✗ ' + head + ' —— 本仓有实质改动，**禁止声明 npm 渠道**');
      out.push('    registry ' + base + ' / tarball ' + gz.length + ' B / ' + files.size + ' 文件' +
        (skipped ? '（跳过 ' + skipped + ' 个非普通文件）' : ''));
      out.push('    仓库 ' + local.size + ' 文件；差异：本地新增 ' + extra.length +
        ' / 实质不同 ' + diffReal.length + ' / 仅换行差异 ' + diffEol.length + ' / 上游多出 ' + missing.length);
      show(out, '本地新增（升级会删除）', extra);
      show(out, '实质内容不同（升级会覆盖）', diffReal);
      out.push('    ⇒ 在线升级会把上游整包覆盖上来，抹掉上述改动。要么删掉该条目的 npm 字段，要么先把改动合并回上游。');
      continue;
    }

    const groups = new Map();
    const unknown = [];
    for (const rel of missing) {
      const label = trimLabel(rel);
      if (label) groups.set(label, (groups.get(label) || 0) + 1);
      else unknown.push(rel);
    }
    const groupText = [...groups.entries()].map(([k, v]) => k + ' ' + v).join('、');

    if (!missing.length && !diffEol.length) {
      same++;
      out.push('✓ ' + head + ' 与上游逐文件同源（' + local.size + ' 文件）');
      say('   ' + head + ' ← ' + base + ' / ' + gz.length + ' B / ' + local.size + ' 文件一致');
      continue;
    }

    if (!unknown.length) {
      trimmed++;
      out.push('✓ ' + head + ' 裁剪版，可在线升级');
      out.push('    本仓 ' + local.size + ' / 上游 ' + files.size + ' 文件；升级会补全 ' + missing.length +
        ' 个文件（+' + fmt(missingBytes) + '，' + (groupText || '无') + '）' +
        (diffEol.length ? '；本仓 ' + diffEol.length + ' 个文件仅 CRLF 行尾差异，语义等同' : ''));
      out.push('    ⇒ 本地文件全部同源，升级只做加法，不会丢本地改动。清单里请标 "npmTrimmed": true。');
      say('   ' + head + ' ← ' + base + ' / 裁剪版（补全 ' + missing.length + ' 文件 / +' + fmt(missingBytes) + '）');
      continue;
    }

    warn++;
    out.push('⚠ ' + head + ' 裁剪版，但缺失里有非文档类文件，升级会新增运行时文件');
    out.push('    本仓 ' + local.size + ' / 上游 ' + files.size + ' 文件；缺失 ' + missing.length +
      ' 个（+' + fmt(missingBytes) + '）' + (groupText ? '；可裁剪类：' + groupText : ''));
    show(out, '需人工确认（非文档类）', unknown, 10);
    out.push('    ⇒ 若确认这些文件不在 dsh 运行时路径上（如其它 agent 宿主的适配层），可保留 npm 渠道并标 "npmTrimmed": true。');
    say('   ' + head + ' ← ' + base + ' / 裁剪版，需确认 ' + unknown.length + ' 个非文档类缺失');
  } catch (e) {
    bad++;
    out.push('✗ ' + head);
    out.push('    ' + (e && e.message ? e.message : String(e)));
  }
}

say('');
console.log('== 插件 npm 渠道同源核对（' + rows.length + ' 条）==');
for (const l of out) console.log(l);
console.log('');
console.log('汇总：同源 ' + same + ' / 裁剪版 ' + trimmed + ' / 裁剪但需确认 ' + warn + ' / 本地改动 ' + bad);
console.log(bad === 0
  ? '✓ 没有发现「本地改动」条目，' + rows.length + ' 条 npm 渠道均可在线升级'
  : '✗ ' + bad + ' 条 npm 渠道存在本地改动，升级会丢改动（见上）');
process.exit(bad === 0 ? 0 : 1);
