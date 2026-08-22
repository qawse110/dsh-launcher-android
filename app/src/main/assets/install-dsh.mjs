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
 *   DSH_NPM_TIMEOUT_MS / DSH_PLUGIN_TIMEOUT_MS（子进程硬超时，防网络卡死）
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, chmodSync, symlinkSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE_BIN = process.env.NODE_BIN || join(HOME, 'node/bin/node');
const NPM_BIN = process.env.NPM_BIN || join(HOME, 'node/bin/npm');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const PREBUILT = process.env.DSH_PREBUILT || '';
const DSH_APK_VER = process.env.DSH_APK_VER || '';
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(HOME, 'plugins');
const EXTRA_PLUGINS_SRC = process.env.DSH_EXTRA_PLUGINS_SRC || join(HOME, 'extra-plugins');
const TOOLS = join(HOME, '.tools');
const TERMUX = process.env.TERMUX_PREFIX || join(HOME, 'termux/usr');
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const REGISTRY_FALLBACK = process.env.NPM_REGISTRY_FALLBACK || 'https://registry.npmjs.org';
const PNPM_VERSION = '11.7.0';
// 防卡死：所有子进程都有硬超时；npm 网络层自带重试/超时，避免 TCP 半开连接无限等待
const NPM_TIMEOUT_MS = Number(process.env.DSH_NPM_TIMEOUT_MS || 15 * 60_000);
const PLUGIN_TIMEOUT_MS = Number(process.env.DSH_PLUGIN_TIMEOUT_MS || 5 * 60_000);
const NPM_NET_ARGS = [
  '--prefer-offline',
  // 非 TTY 下让 npm 逐请求输出（等价于 _logs 里的 http fetch 行），避免长阶段静默被误判卡死
  '--loglevel=http',
  '--fetch-timeout=120000',
  '--fetch-retries=5',
  '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=60000',
];
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
  'dsh-status-bridge',
];
const BUILTIN_NAMES = new Set([
  '@dsh-external/dsh-mobile-nav',
  '@dsh-external/dsh-super-injector',
  'dsh-net-proxy',
  'dsh-provider-headers',
  '@dsh-external/dsh-vision',
  '@dsh-external/dsh-oh-we-need',
  '@dsh-external/dsh-j-space-cognition',
  '@dsh-external/dsh-status-bridge',
]);
const BUILTIN_IDS = new Set([
  'dsh-mobile-nav',
  'dsh-super-injector',
  'net-proxy',
  'provider-headers',
  'dsh-vision',
  'dsh-oh-we-need',
  'dsh-j-space-cognition',
  'dsh-status-bridge',
]);
function log(m) {
  const l = `${new Date().toISOString()} [install] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

function runEx(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  log('$ ' + cmd + ' ' + args.join(' ') + ` (timeout=${Math.round(timeoutMs / 1000)}s)`);
  const { timeoutMs: _ignored, ...spawnOpts } = opts;
  // stdin 用 ignore：子进程任何交互式提示都会立刻读到 EOF 而不是永远等待
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    ...spawnOpts,
  });
  const sig = r.signal ? ' signal=' + r.signal : '';
  const err = r.error ? ' error=' + r.error.message : '';
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`exit=${r.status}${sig}${err} (${cmd}, ${secs}s)`);
  if (r.error && /timed out|timeout/i.test(String(r.error.message))) {
    log('TIMEOUT: 子进程超时被强制结束，请检查网络后重试');
  }
  return { ok: r.status === 0, status: r.status, signal: r.signal, error: r.error ? String(r.error.message) : '' };
}

function run(cmd, args, opts = {}) {
  return runEx(cmd, args, opts).ok;
}

function isOom(r) {
  return r != null && (r.status === 134 || r.signal === 'SIGABRT' || /heap out of memory/i.test(r.error || ''));
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
  const gitConfig = join(HOME, '.gitconfig');
  try {
    if (!existsSync(gitConfig)) writeFileSync(gitConfig, '');
  } catch {}
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: termuxReady
      ? join(HOME, 'node/lib') + ':' + join(TERMUX, 'lib')
      : join(HOME, 'node/lib'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    TMPDIR: join(HOME, 'tmp'),
    TMP: join(HOME, 'tmp'),
    TEMP: join(HOME, 'tmp'),
    TERM: 'xterm-256color',
    CI: '1',
    // pnpm 在非 TTY 下默认静默；append-only 是它专为管道日志设计的行式进度。
    // 通过 npm_config_* 传递，可穿透 dsh CLI 内部再起的 pnpm 子进程。
    npm_config_reporter: 'append-only',
    OPENSSL_CONF: '/dev/null',
    PATH: pathParts.join(':'),
    ...extra,
  };
  if (termuxReady) {
    env.PREFIX = TERMUX;
    env.GIT_EXEC_PATH = join(TERMUX, 'libexec/git-core');
  }
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
      '--registry', REGISTRY, '--no-audit', '--no-fund', ...NPM_NET_ARGS,
    ], { env: envBase(), timeoutMs: NPM_TIMEOUT_MS });
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
  const wrapperBody = `#!/system/bin/sh\nexec "${NODE_BIN}" "${pnpmCjs}" "$@"\n`;
  try {
    if (existsSync(wrapper) && readFileSync(wrapper, 'utf8') === wrapperBody) {
      log('pnpm wrapper up-to-date: ' + wrapper);
      return pnpmCjs;
    }
  } catch {}
  rmSync(wrapper, { recursive: true, force: true });
  writeFileSync(wrapper, wrapperBody);
  try { chmodSync(wrapper, 0o755); } catch {}
  log('pnpm wrapper: ' + wrapper);
  return pnpmCjs;
}

function ensureHostPkg() {
  // 必须有 package.json：没有它 npm 视为临时安装，不生成 package-lock.json，
  // 导致每次安装都重新联网解析全部依赖 manifest（弱网下极易卡住）。
  const pkgFile = join(DSH_PREFIX, 'package.json');
  if (existsSync(pkgFile)) return;
  try {
    writeFileSync(pkgFile, JSON.stringify({
      name: 'dsh-host',
      private: true,
      version: '0.0.0',
    }, null, 2) + '\n');
    log('created ' + pkgFile + ' (enables lockfile + cache-friendly installs)');
  } catch (e) {
    log('WARN create host package.json: ' + e.message);
  }
}

function ensureDsh() {
  mkdirSync(DSH_PREFIX, { recursive: true });
  ensureHostPkg();
  const tag = process.env.DSH_TAG || 'latest';
  const pkgSpec = `@deepseek-ai/dsh@${tag}`;
  const pnpmBin = join(TOOLS, 'bin', 'pnpm');
  const pnpmStoreEnv = { npm_config_store_dir: join(TOOLS, 'pnpm-store') };
  const pnpmCommon = ['--ignore-scripts', '--prefer-offline', '--reporter', 'append-only'];

  log(`install/update ${pkgSpec} ...`);
  // 引擎优先级：pnpm（内存占用远低于 npm；npm Arborist 在设备上解析 150+ 包
  // 依赖树会把 2GB 堆吃爆 OOM）→ 换官方源再试 pnpm → 最后才用 npm 兜底并调大堆。
  const attempts = [
    { label: 'pnpm/' + REGISTRY, cmd: pnpmBin, engine: 'pnpm', registry: REGISTRY, env: pnpmStoreEnv },
    { label: 'pnpm/' + REGISTRY_FALLBACK, cmd: pnpmBin, engine: 'pnpm', registry: REGISTRY_FALLBACK, env: pnpmStoreEnv },
    {
      label: 'npm/' + REGISTRY + '(heap-3g)',
      cmd: NPM_BIN,
      engine: 'npm',
      registry: REGISTRY,
      env: { NODE_OPTIONS: '--max-old-space-size=3072' },
    },
  ];
  let succeeded = false;
  for (const a of attempts) {
    if (a.engine === 'pnpm') {
      // 一次性迁移：npm 装出来的扁平 node_modules 没有 pnpm-lock，pnpm 无法增量接管；
      // 清空后由 pnpm 重建（之后走 content-addressable store，更新很快）。
      const nm = join(DSH_PREFIX, 'node_modules');
      if (existsSync(nm) && !existsSync(join(DSH_PREFIX, 'pnpm-lock.yaml'))) {
        log('pnpm: removing npm-layout node_modules before first pnpm install');
        try { rmSync(nm, { recursive: true, force: true }); } catch (e) { log('WARN clean node_modules: ' + e.message); }
      }
    }
    const args = a.engine === 'pnpm'
      ? ['add', '--dir', DSH_PREFIX, pkgSpec, '--registry', a.registry, ...pnpmCommon]
      : ['install', '--prefix', DSH_PREFIX, pkgSpec, '--registry', a.registry,
        '--no-audit', '--no-fund', '--ignore-scripts', '--force', ...NPM_NET_ARGS];
    if (a !== attempts[0]) log(`retrying with engine ${a.label} ...`);
    const r = runEx(a.cmd, args, { env: { ...envBase(), ...a.env }, timeoutMs: NPM_TIMEOUT_MS });
    if (isOom(r)) log(`OOM detected on ${a.label}, switching engine`);
    if (r.ok && dshInstalled()) {
      log('installed via ' + a.label);
      succeeded = true;
      break;
    }
    log(`attempt ${a.label} failed (ok=${r.ok}, dshInstalled=${dshInstalled()})`);
  }
  if (!succeeded || !dshInstalled()) {
    log('FATAL: official dsh install/update failed after all engines/registries');
    process.exit(1);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    const lock = existsSync(join(DSH_PREFIX, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    log(`dsh version: ${pkg.version || 'unknown'} (lockfile=${lock})`);
  } catch {}
}

/**
 * Android 兼容：@vscode/ripgrep 没有 android-arm64 平台包，导致
 * dsh-tool-fs-search 的 glob/grep 工具报
 * “glob could not start its search command (ripgrep launch failed)”。
 * 优先使用内置 Termux 已通过 `pkg install -y ripgrep` 安装的原生 rg；
 * 只有 Termux rg 不存在时才安装 @vscode/ripgrep-linux-arm64（静态二进制，可在 Android 上运行），
 * 供 stub-dsh.mjs 把 @vscode/ripgrep 解析器指向它。
 * --force 是必要的：npm 在 process.platform=android 时会按 EBADPLATFORM 拒绝 linux 包。
 */
function ensureRipgrepFallback() {
  const rgPkg = join(DSH_PREFIX, 'node_modules/@vscode/ripgrep/package.json');
  if (!existsSync(rgPkg)) {
    log('@vscode/ripgrep not installed, skip ripgrep fallback');
    return;
  }
  const termuxRg = join(HOME, 'termux/usr/bin/rg');
  if (existsSync(termuxRg)) {
    log('Termux ripgrep already installed, skip npm fallback: ' + termuxRg);
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
  // 引擎跟随 dsh 主安装：pnpm 管理的目录绝不能再用 npm 写（会破坏 .pnpm 布局）
  const pnpmManaged = existsSync(join(DSH_PREFIX, 'pnpm-lock.yaml'));
  const pnpmBin = join(TOOLS, 'bin', 'pnpm');
  const installFallback = (spec, registry) => {
    if (pnpmManaged) {
      return run(pnpmBin, ['add', '--dir', DSH_PREFIX, spec, '--registry', registry,
        '--ignore-scripts', '--prefer-offline', '--reporter', 'append-only'], {
        env: { ...envBase(), npm_config_store_dir: join(TOOLS, 'pnpm-store') },
        timeoutMs: NPM_TIMEOUT_MS,
      });
    }
    return run(NPM_BIN, ['install', '--prefix', DSH_PREFIX, spec, '--registry', registry,
      '--no-audit', '--no-fund', '--ignore-scripts', '--force', ...NPM_NET_ARGS], {
      env: { ...envBase(), NODE_OPTIONS: '--max-old-space-size=3072' },
      timeoutMs: NPM_TIMEOUT_MS,
    });
  };
  let ok = installFallback(`@vscode/ripgrep-linux-arm64@${rgVersion}`, REGISTRY);
  if (!ok || !existsSync(fallbackBin)) {
    log('exact version fallback install failed, retrying latest on fallback registry ...');
    ok = installFallback('@vscode/ripgrep-linux-arm64', REGISTRY_FALLBACK);
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
  return files;
}

function extractPlugins() {
  if (!PREBUILT || !existsSync(PREBUILT)) {
    log('DSH_PREBUILT not set or missing, skip bundled plugin extraction');
    return;
  }
  // 提取完成标记由脚本自己维护（不能由 prebuilt 拷贝侧维护）：APK 升级后
  // prebuilt 可能已覆盖为新包，但 plugins 目录还是旧包，必须在提取成功后
  // 才写标记；否则会误跳过新包的提取。
  const extractedMarker = join(HOME, '.plugins-extracted-ok');
  let markerOk = false;
  if (DSH_APK_VER && existsSync(extractedMarker)) {
    try { markerOk = readFileSync(extractedMarker, 'utf8').trim() === 'apk:' + DSH_APK_VER; } catch {}
  }
  if (markerOk && BUILTIN_PLUGINS.every((d) => existsSync(join(PLUGINS_DIR, d, 'package.json')))) {
    log('bundled plugins already extracted for apk:' + DSH_APK_VER + ', skip untar');
    return;
  }
  try {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    const raw = readFileSync(PREBUILT);
    const buf = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
    let extractedFiles = untarWithPrefix(buf, PLUGINS_DIR, 'third_party');
    // 兼容直接打包 plugins.tgz（顶层就是插件目录而非 third_party/）：
    // 如果上面没解出任何东西且包内没有 third_party 前缀，再整体解到 plugins。
    const anyBuiltin = BUILTIN_PLUGINS.some((d) => existsSync(join(PLUGINS_DIR, d, 'package.json')));
    if (!anyBuiltin) {
      log('no third_party prefix found, try extracting archive to plugins dir directly');
      extractedFiles += untarWithPrefix(buf, PLUGINS_DIR, '');
    }
    const builtinReady = BUILTIN_PLUGINS.some((d) => existsSync(join(PLUGINS_DIR, d, 'package.json')));
    if (extractedFiles > 0 && builtinReady && DSH_APK_VER) {
      try { writeFileSync(extractedMarker, 'apk:' + DSH_APK_VER + '\n'); } catch {}
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
  return run(NODE_BIN, [dshCli(), 'plugin', '--profile', DSH_PROFILE, ...args], { env: envBase(), timeoutMs: PLUGIN_TIMEOUT_MS });
}

function addLocalPlugin(dir) {
  const p = join(PLUGINS_DIR, dir);
  if (!existsSync(join(p, 'package.json'))) {
    // 新内置插件可能以源码形式随 APK 放在 extra-plugins/，首次安装时复制到 plugins 目录。
    const src = join(EXTRA_PLUGINS_SRC, dir);
    if (existsSync(join(src, 'package.json'))) {
      log(`copy extra plugin ${dir} -> plugins`);
      try {
        cpSync(src, p, { recursive: true, force: true });
      } catch (e) {
        log(`WARN copy extra plugin ${dir}: ${e.message}`);
        return false;
      }
    } else {
      log(`skip builtin plugin ${dir}: not bundled`);
      return false;
    }
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
    // 上游当前不再发布 router-pro；
    // 清理历史安装残留，避免 agent-presets 里出现已移除的预设。
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
 * 内置插件以 link: 方式装配在 files/plugins 下，包管理器不会把依赖安装到该目录。
 * 这里把 dsh-prefix 的依赖桥接（符号链接）到 plugins/node_modules，使插件代码
 * 从 files/plugins/* 加载时也能解析 @deepseek-ai/* 等运行时依赖。
 * npm 扁平布局：桥接 node_modules 顶层即可。
 * pnpm 布局：顶层只有直接依赖，传递依赖在 .pnpm 虚拟store 里——额外扫描 store，
 * 把每个唯一包名（作用域包、多版本取最高）也桥接进去，恢复扁平解析语义。
 */
function cmpVer(a, b) {
  const pa = String(a).split('-');
  const pb = String(b).split('-');
  const na = pa[0].split('.').map((n) => parseInt(n, 10) || 0);
  const nb = pb[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return d;
  }
  const ra = pa[1] || '';
  const rb = pb[1] || '';
  if (ra === rb) return 0;
  if (!ra) return 1; // 无 prerelease 更高
  if (!rb) return -1;
  return ra > rb ? 1 : -1;
}

function linkPluginDeps() {
  const src = join(DSH_PREFIX, 'node_modules');
  const dest = join(PLUGINS_DIR, 'node_modules');
  if (!existsSync(src)) {
    log('WARN dsh-prefix node_modules missing, skip plugin dep bridge');
    return;
  }
  try {
    mkdirSync(dest, { recursive: true });
    let kept = 0;
    let linked = 0;
    let removed = 0;
    let warns = 0;
    const keep = new Set();
    const ensureLink = (name, target) => {
      if (keep.has(name)) return true;
      keep.add(name);
      if (name.includes('/')) {
        const scope = name.slice(0, name.indexOf('/'));
        keep.add(scope);
        mkdirSync(join(dest, scope), { recursive: true });
      }
      const link = join(dest, ...name.split('/'));
      try { if (readlinkSync(link) === target) { kept++; return true; } } catch {}
      rmSync(link, { recursive: true, force: true });
      try {
        symlinkSync(target, link);
        linked++;
        return true;
      } catch (e) {
        warns++;
        log('WARN bridge plugin dep ' + name + ': ' + e.message);
        return false;
      }
    };
    // 1) 直接依赖（两种布局都存在）
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      ensureLink(ent.name, join(src, ent.name));
    }
    // 2) pnpm 传递依赖：扫描 .pnpm/<pkg>@<ver>_peerhash/node_modules/*
    const store = join(src, '.pnpm');
    if (existsSync(store)) {
      const best = new Map(); // name -> {dir, ver}
      for (const d of readdirSync(store)) {
        if (d.startsWith('.')) continue;
        const nm = join(store, d, 'node_modules');
        if (!existsSync(nm)) continue;
        const found = [];
        try {
          for (const c of readdirSync(nm)) {
            if (c.startsWith('.')) continue;
            if (c.startsWith('@')) {
              for (const g of readdirSync(join(nm, c))) found.push([c + '/' + g, join(nm, c, g)]);
            } else {
              found.push([c, join(nm, c)]);
            }
          }
        } catch {}
        for (const [name, dir] of found) {
          let ver = '0.0.0';
          try { ver = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ver; } catch {}
          const cur = best.get(name);
          if (!cur || cmpVer(ver, cur.ver) > 0) best.set(name, { dir, ver });
        }
      }
      let bridgedTransitive = 0;
      for (const [name, info] of best) {
        if (keep.has(name)) continue; // 直接依赖已从顶层桥接
        if (ensureLink(name, info.dir)) bridgedTransitive++;
      }
      log(`pnpm store bridge: ${best.size} unique packages, ${bridgedTransitive} transitive bridged`);
    }
    // 清理本轮未覆盖的旧链接（含历史遗留的孤立作用域目录）
    for (const ent of readdirSync(dest, { withFileTypes: true })) {
      if (!keep.has(ent.name)) {
        rmSync(join(dest, ent.name), { recursive: true, force: true });
        removed++;
      }
    }
    log(`plugin dep bridge: ${kept} kept, ${linked} linked, ${removed} stale removed, ${warns} warn -> ${dest}`);
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