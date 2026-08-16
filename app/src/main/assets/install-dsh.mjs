#!/usr/bin/env node
/**
 * install-dsh.mjs — 设备端官方安装/更新 DeepSeek Harness (dsh)。
 *
 * 与旧版不同：
 *   1) dsh 本体不再克隆 deepseek-harness 源码/解压 prebuilt 源码树，
 *      而是通过 npm 官方包 `@deepseek-ai/dsh` 安装/更新到 DSH_PREFIX。
 *   2) 内置插件（third_party 下随 APK 分发的构建产物）通过官方
 *      `dsh plugin --profile web add <path>` 安装。
 *   3) 仅 yjh051108/dsh-routing-suite 需要在插件管理页走特殊适配
 *      （见 routing-suite.mjs）；本脚本只处理随 APK 内置的插件源。
 *
 * 用法：
 *   node install-dsh.mjs                # 完整安装/更新 dsh + 装配内置插件
 *   node install-dsh.mjs --plugins-only # 跳过 npm 更新，只重新装配内置插件
 *
 * 环境变量：
 *   HOME / NODE_BIN / NPM_BIN / DSH_PREFIX / DSH_PROFILE / DSH_PREBUILT
 *   DSH_PLUGINS_DIR / DSH_NODE_MEM / NPM_REGISTRY
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE_BIN = process.env.NODE_BIN || join(HOME, 'node/bin/node');
const NPM_BIN = process.env.NPM_BIN || join(HOME, 'node/bin/npm');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const PREBUILT = process.env.DSH_PREBUILT || '';
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(HOME, 'plugins');
const TOOLS = join(HOME, '.tools');
const TERMUX = process.env.TERMUX_PREFIX || join(HOME, 'termux/usr');
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const PNPM_VERSION = '11.7.0';
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';
const BUILTIN_PLUGINS = [
  'dsh-mobile-nav',
  'dsh-super-injector',
  'dsh-net-proxy',
  'dsh-provider-headers',
  'dsh-vision',
  'dsh-oh-we-need',
  'dsh-j-space-cognition',
];
const BUILTIN_NAMES = new Set([
  '@dsh-external/dsh-mobile-nav',
  '@dsh-external/dsh-super-injector',
  'dsh-net-proxy',
  'dsh-provider-headers',
  '@dsh-external/dsh-vision',
  '@dsh-external/dsh-oh-we-need',
  '@dsh-external/dsh-j-space-cognition',
]);
const BUILTIN_IDS = new Set([
  'dsh-mobile-nav',
  'dsh-super-injector',
  'net-proxy',
  'provider-headers',
  'dsh-vision',
  'dsh-oh-we-need',
  'dsh-j-space-cognition',
]);
const PRESET_DIRS = ['router-preset'];

function log(m) {
  const l = `${new Date().toISOString()} [install] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

function run(cmd, args, opts = {}) {
  log('$ ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  const sig = r.signal ? ' signal=' + r.signal : '';
  const err = r.error ? ' error=' + r.error.message : '';
  log(`exit=${r.status}${sig}${err} (${cmd})`);
  return r.status === 0;
}

function envBase(extra = {}) {
  const pnpmDirs = [
    join(TOOLS, 'bin'),
    join(TOOLS, 'lib/node_modules/.bin'),
    join(TOOLS, 'lib/node_modules/pnpm/bin'),
  ];
  const termuxReady = existsSync(join(TERMUX, 'bin/bash'));
  const termuxDirs = termuxReady
    ? [join(TERMUX, 'bin'), join(TERMUX, 'bin/applets'), join(TERMUX, 'local/bin')]
    : [];
  const pathParts = [...termuxDirs, join(HOME, 'node/bin')];
  for (const d of pnpmDirs) if (existsSync(d)) pathParts.push(d);
  pathParts.push('/system/bin', '/bin', '/usr/bin');
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: termuxReady
      ? join(HOME, 'node/lib') + ':' + join(TERMUX, 'lib')
      : join(HOME, 'node/lib'),
    TMPDIR: join(HOME, 'tmp'),
    TMP: join(HOME, 'tmp'),
    TEMP: join(HOME, 'tmp'),
    TERM: 'xterm-256color',
    OPENSSL_CONF: '/dev/null',
    PATH: pathParts.join(':'),
    ...extra,
  };
  if (termuxReady) env.PREFIX = TERMUX;
  return env;
}

function dshCli() {
  return join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
}

function dshInstalled() {
  return existsSync(dshCli());
}

function ensurePnpm() {
  mkdirSync(TOOLS, { recursive: true });
  const pnpmRoot = join(TOOLS, 'lib/node_modules/pnpm');
  const pnpmMjs = join(pnpmRoot, 'bin/pnpm.mjs');
  let pnpmCjs = join(pnpmRoot, 'bin/pnpm.cjs');

  // 旧版本把 shell wrapper 写到 TOOLS/bin/pnpm 时，会跟随 npm 生成的
  // 符号链接把 pnpm.mjs 覆盖成 shell 脚本。检测到这种破损就重装 pnpm。
  if (existsSync(pnpmMjs)) {
    const head = readFileSync(pnpmMjs, 'utf8').slice(0, 200);
    if (head.includes('exec "') || head.includes('#!/system/bin/sh') || head.includes('#!/bin/sh')) {
      log('pnpm.mjs corrupted, reinstalling pnpm@' + PNPM_VERSION + ' ...');
      rmSync(pnpmRoot, { recursive: true, force: true });
      for (const name of ['pnpm', 'pn', 'pnpx', 'pnx']) {
        rmSync(join(TOOLS, 'bin', name), { recursive: true, force: true });
      }
      pnpmCjs = join(pnpmRoot, 'bin/pnpm.cjs');
    }
  }
  if (!existsSync(pnpmCjs)) pnpmCjs = join(TOOLS, 'bin/pnpm.cjs');
  if (!existsSync(pnpmCjs)) {
    log('installing pnpm@' + PNPM_VERSION + ' ...');
    const r = run(NPM_BIN, [
      'install', '-g', `pnpm@${PNPM_VERSION}`, '--prefix', TOOLS,
      '--registry', REGISTRY, '--no-audit', '--no-fund',
    ], { env: envBase() });
    if (!r) {
      log('FATAL: pnpm install failed');
      process.exit(1);
    }
    pnpmCjs = join(pnpmRoot, 'bin/pnpm.cjs');
    if (!existsSync(pnpmCjs)) pnpmCjs = join(TOOLS, 'bin/pnpm.cjs');
  }
  // dsh plugin 通过 PATH 里的 `pnpm` 命令转发；Android 没有 /usr/bin/env，
  // 所以写一个 system sh wrapper 保证 pnpm 可执行。
  // 注意：TOOLS/bin/pnpm 可能是 npm 生成的符号链接，必须先删掉再写文件，
  // 否则 writeFileSync 会跟着符号链接覆盖真正的 pnpm.mjs。
  const wrapper = join(TOOLS, 'bin/pnpm');
  rmSync(wrapper, { recursive: true, force: true });
  writeFileSync(wrapper, `#!/system/bin/sh\nexec "${NODE_BIN}" "${pnpmCjs}" "$@"\n`);
  try { chmodSync(wrapper, 0o755); } catch {}
  log('pnpm wrapper: ' + wrapper);
  return pnpmCjs;
}

function ensureDsh() {
  mkdirSync(DSH_PREFIX, { recursive: true });
  log('install/update @deepseek-ai/dsh via npm ...');
  const ok = run(NPM_BIN, [
    'install', '--prefix', DSH_PREFIX, '@deepseek-ai/dsh@latest',
    '--registry', REGISTRY, '--no-audit', '--no-fund', '--ignore-scripts', '--force',
  ], { env: envBase() });
  if (!ok || !dshInstalled()) {
    log('FATAL: official dsh install/update failed');
    process.exit(1);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    log('dsh version: ' + (pkg.version || 'unknown'));
  } catch {}
}

/**
 * Android 兼容：@vscode/ripgrep 没有 android-arm64 平台包，导致
 * dsh-tool-fs-search 的 glob/grep 工具报
 * “glob could not start its search command (ripgrep launch failed)”。
 * 这里显式安装 @vscode/ripgrep-linux-arm64（静态二进制，可在 Android 上运行），
 * 供 stub-dsh.mjs 把 @vscode/ripgrep 解析器指向它。
 * --force 是必要的：npm 在 process.platform=android 时会按 EBADPLATFORM 拒绝 linux 包。
 */
function ensureRipgrepFallback() {
  const rgPkg = join(DSH_PREFIX, 'node_modules/@vscode/ripgrep/package.json');
  if (!existsSync(rgPkg)) {
    log('@vscode/ripgrep not installed, skip ripgrep fallback');
    return;
  }
  let rgVersion = '1.18.0';
  try {
    rgVersion = JSON.parse(readFileSync(rgPkg, 'utf8')).version || rgVersion;
  } catch {}
  const fallbackDir = join(DSH_PREFIX, 'node_modules/@vscode/ripgrep-linux-arm64');
  const fallbackBin = join(fallbackDir, 'bin/rg');
  if (existsSync(fallbackBin)) {
    // 防止旧安装里 fallback 是 extraneous 包、下次 npm install 被 prune 掉。
    try {
      const pkgFile = join(DSH_PREFIX, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies['@vscode/ripgrep-linux-arm64'] = pkg.dependencies['@vscode/ripgrep-linux-arm64'] || '^' + rgVersion;
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    } catch (e) {
      log('WARN declare ripgrep fallback: ' + e.message);
    }
    log('ripgrep linux-arm64 fallback already present: ' + fallbackBin);
    return;
  }
  log('installing ripgrep linux-arm64 fallback @' + rgVersion + ' ...');
  let ok = run(NPM_BIN, [
    'install', '--prefix', DSH_PREFIX, `@vscode/ripgrep-linux-arm64@${rgVersion}`,
    '--registry', REGISTRY, '--no-audit', '--no-fund', '--ignore-scripts', '--force',
  ], { env: envBase() });
  if (!ok || !existsSync(fallbackBin)) {
    log('exact version fallback install failed, retrying latest ...');
    ok = run(NPM_BIN, [
      'install', '--prefix', DSH_PREFIX, '@vscode/ripgrep-linux-arm64',
      '--registry', REGISTRY, '--no-audit', '--no-fund', '--ignore-scripts', '--force',
    ], { env: envBase() });
  }
  if (!ok || !existsSync(fallbackBin)) {
    log('WARN: ripgrep linux-arm64 fallback install failed (glob/grep may fail on Android)');
  } else {
    log('ripgrep linux-arm64 fallback ready: ' + fallbackBin);
  }
}

/** 解析 ustar tar（无需外部工具）：文件/目录/符号链接；只提取指定前缀。 */
function untarWithPrefix(buf, dest, prefix) {
  let off = 0;
  let files = 0;
  const strip = prefix.replace(/\/+$/, '') + '/';
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name0 = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (!name0) break;
    const prefix0 = h.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    const rawName = (prefix0 ? prefix0 + '/' : '') + name0;
    const name = rawName.replace(/^\.\//, '');
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      off += 512 + Math.ceil(parseInt(h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) / 512) * 512;
      continue;
    }
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(h[156]);
    const data = buf.subarray(off + 512, off + 512 + size);
    // 只处理匹配前缀的条目；third_party 顶层目录本身也跳过
    const matched = !prefix
      ? (name !== '.' && name !== '')
      : (name === strip.slice(0, -1) || name.startsWith(strip));
    if (matched) {
      const rel = !prefix
        ? name
        : (name.startsWith(strip) ? name.slice(strip.length) : '');
      if (rel) {
        const p = join(dest, rel);
        if (type === '5') {
          mkdirSync(p, { recursive: true });
        } else if (type === '2') {
          const target = h.subarray(157, 257).toString('utf8').replace(/\0[\s\S]*$/, '');
          mkdirSync(dirname(p), { recursive: true });
          try { symlinkSync(target, p); } catch {}
        } else if (type === '0' || type === '\0') {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, data);
          files++;
        }
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  log(`untar: ${files} files (prefix=${strip}) -> ${dest}`);
}

function extractPlugins() {
  if (!PREBUILT || !existsSync(PREBUILT)) {
    log('DSH_PREBUILT not set or missing, skip bundled plugin extraction');
    return;
  }
  try {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    const raw = readFileSync(PREBUILT);
    const buf = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
    untarWithPrefix(buf, PLUGINS_DIR, 'third_party');
    // 兼容直接打包 plugins.tgz（顶层就是插件目录而非 third_party/）：
    // 如果上面没解出任何东西且包内没有 third_party 前缀，再整体解到 plugins。
    const anyBuiltin = BUILTIN_PLUGINS.some((d) => existsSync(join(PLUGINS_DIR, d, 'package.json')));
    if (!anyBuiltin) {
      log('no third_party prefix found, try extracting archive to plugins dir directly');
      untarWithPrefix(buf, PLUGINS_DIR, '');
    }
  } catch (t) {
    log('WARN extract plugins failed: ' + t.message);
  }
}

function dshPlugin(args) {
  if (!dshInstalled()) {
    log('dsh not installed at ' + dshCli());
    return false;
  }
  return run(NODE_BIN, [dshCli(), 'plugin', '--profile', DSH_PROFILE, ...args], { env: envBase() });
}

function addLocalPlugin(dir) {
  const p = join(PLUGINS_DIR, dir);
  if (!existsSync(join(p, 'package.json'))) {
    log(`skip builtin plugin ${dir}: not bundled`);
    return false;
  }
  log(`dsh plugin add ${dir}`);
  return dshPlugin(['add', p]);
}

/** 路由预设不是 pnpm bundle，需整体拷贝/展平到 .agent-presets（特殊适配）。 */
function copyPresets() {
  const srcRoot = join(PLUGINS_DIR, 'router-preset');
  if (!existsSync(srcRoot)) {
    log('router-preset not bundled, skip preset copy');
    return;
  }
  const destRoot = join(HOME, '.dsh/.agent-presets');
  mkdirSync(destRoot, { recursive: true });
  try {
    const sourceNames = new Set();
    if (existsSync(join(srcRoot, 'agent.cordis.yml'))) {
      const dest = join(destRoot, 'router-preset');
      rmSync(dest, { recursive: true, force: true });
      cpSync(srcRoot, dest, { recursive: true, force: true });
      log('preset installed: router-preset');
    } else {
      let copied = 0;
      for (const child of readdirSync(srcRoot, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        sourceNames.add(child.name);
        const childSrc = join(srcRoot, child.name);
        if (!existsSync(join(childSrc, 'agent.cordis.yml'))) continue;
        const dest = join(destRoot, child.name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(childSrc, dest, { recursive: true, force: true });
        copied++;
      }
      const legacy = join(destRoot, 'router-preset');
      if (existsSync(legacy) && !existsSync(join(legacy, 'agent.cordis.yml'))) {
        rmSync(legacy, { recursive: true, force: true });
      }
      log('preset install: router-preset (' + copied + ' subpresets)');
    }
    // 上游曾短暂合入 router-pro（v0.3.0）后又回退到 v0.2.0；
    // 清理历史安装残留，避免 agent-presets 里出现上游已移除的预设。
    for (const stale of ['router-pro']) {
      if (!sourceNames.has(stale)) {
        rmSync(join(destRoot, stale), { recursive: true, force: true });
        log('removed stale preset: ' + stale + ' (upstream reverted to v0.2.0)');
      }
    }
  } catch (e) {
    log('WARN preset copy failed: ' + e.message);
  }
}

function installBuiltins() {
  for (const d of BUILTIN_PLUGINS) addLocalPlugin(d);
  copyPresets();
  cleanBuiltinPatch();
}

/**
 * 内置插件以 link: 方式装配在 files/plugins 下，pnpm 不会把它们的
 * peerDependencies 安装到该目录。这里把 dsh-prefix/node_modules 的所有包
 * 桥接（符号链接）到 plugins/node_modules，使插件代码从 files/plugins/*
 * 加载时也能解析 @deepseek-ai/* 等运行时依赖。
 */
function linkPluginDeps() {
  const src = join(DSH_PREFIX, 'node_modules');
  const dest = join(PLUGINS_DIR, 'node_modules');
  if (!existsSync(src)) {
    log('WARN dsh-prefix node_modules missing, skip plugin dep bridge');
    return;
  }
  try {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    let linked = 0;
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      const target = join(src, ent.name);
      const link = join(dest, ent.name);
      try {
        symlinkSync(target, link);
        linked++;
      } catch (e) {
        log('WARN link plugin dep ' + ent.name + ': ' + e.message);
      }
    }
    log(`plugin dep bridge: ${linked} packages -> ${dest}`);
  } catch (e) {
    log('WARN linkPluginDeps: ' + e.message);
  }
}

/** 清理旧版遗留的 profile patch 内置插件 insert，避免与 dsh.profile.bundles 重复装配。 */
function cleanBuiltinPatch() {
  const patch = join(HOME, '.dsh/profiles', DSH_PROFILE, 'cordis.patch.yml');
  if (!existsSync(patch)) return;
  try {
    const lines = readFileSync(patch, 'utf8').split(/\r?\n/);
    const out = [];
    let block = null;
    let keep = true;
    const flush = () => {
      if (block && keep) out.push(...block);
      block = null;
      keep = true;
    };
    for (const line of lines) {
      if (/^\s*- insert:\s*$/.test(line)) {
        flush();
        block = [line];
        keep = true;
      } else if (block) {
        const idMatch = line.match(/^\s*- id:\s*(\S+)\s*$/);
        const nameMatch = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/);
        if (idMatch && BUILTIN_IDS.has(idMatch[1])) keep = false;
        if (nameMatch && BUILTIN_NAMES.has(nameMatch[1].trim())) keep = false;
        block.push(line);
      } else {
        out.push(line);
      }
    }
    flush();
    const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const body = cleaned.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '').join('');
    if (!body.includes('[]') && !body.includes('- insert:')) {
      writeFileSync(patch, (cleaned ? cleaned + '\n' : '') + '[]\n');
    } else {
      writeFileSync(patch, cleaned + '\n');
    }
    log('builtin patch entries cleaned (profile patch dedupe)');
  } catch (e) {
    log('WARN cleanBuiltinPatch: ' + e.message);
  }
}

// ── main ─────────────────────────────────────────────
log('=== official dsh install start ===');
log('HOME=' + HOME + ' DSH_PREFIX=' + DSH_PREFIX + ' PROFILE=' + DSH_PROFILE);
try { mkdirSync(join(HOME, 'tmp'), { recursive: true }); } catch {}

const pluginsOnly = process.argv.includes('--plugins-only');

ensurePnpm();
if (!pluginsOnly) {
  ensureDsh();
  ensureRipgrepFallback();
} else if (!dshInstalled()) {
  log('FATAL: --plugins-only but dsh not installed yet');
  process.exit(1);
} else {
  ensureRipgrepFallback();
}

extractPlugins();
installBuiltins();
linkPluginDeps();

try {
  writeFileSync(join(DSH_PREFIX, 'dsh-installed.json'), JSON.stringify({
    installedAt: new Date().toISOString(),
    profile: DSH_PROFILE,
    plugins: BUILTIN_PLUGINS,
  }, null, 2));
} catch (e) { log('WARN state file: ' + e.message); }

log('=== official dsh install done ===');