#!/usr/bin/env node
/**
 * install-dsh.mjs — 设备端一键安装 DeepSeek Harness（dsh）。
 *
 * 由 ConsoleActivity 复制到应用私有目录后用内置 Node 执行：
 *   1) 定位 pnpm（本地安装到 $HOME/.tools，registry 国内镜像优先）
 *   2) cd DSH_DIR && pnpm install（--ignore-scripts：原生 postinstall
 *      （lefthook / node-pty spawn-helper）在 Android 上无意义，由后续 stub 兜底）
 *   3) pnpm run build:lib（tsc 编译所有 workspace 包 → lib/ 产物）
 *   4) pnpm run build:web（vite 构建前端 dist）
 *   5) 写 .dsh-env（后续启动脚本读取）
 *
 * 日志：终端 stdout + /sdcard/Download/DshLauncher/install_log.txt（追加）
 * 幂等：node_modules/.bin/dsh 或 lib 产物存在时跳过 install，仅确保 fixup。
 * 环境变量：DSH_DIR / HOME / NODE_BIN 由调用方（ConsoleActivity）设置。
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE_BIN = process.env.NODE_BIN || join(HOME, 'node/bin/node');
const NPM_BIN = process.env.NPM_BIN || join(HOME, 'node/bin/npm');
const DSH_DIR = process.env.DSH_DIR || join(HOME, 'deepseek-harness-master');
const PNPM_VERSION = '11.7.0'; // 与根 package.json 的 packageManager 一致
const TOOLS = join(HOME, '.tools');
const OUT = join(HOME, 'install_log.txt'); // 私有目录（无需存储权限）；共享目录尽力而为
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

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
function envWithNode() {
  return {
    ...process.env,
    LD_LIBRARY_PATH: join(HOME, 'node/lib'),
    TMPDIR: join(HOME, 'tmp'), TMP: join(HOME, 'tmp'), TEMP: join(HOME, 'tmp'),
    OPENSSL_CONF: '/dev/null',
    // 大仓库 tsc 全量编译在手机上默认 heap(~913MB) 会 OOM；设备 3.7GB RAM，
    // 给 1536MB。可用环境变量 DSH_NODE_MEM 覆盖。
    NODE_OPTIONS: '--max-old-space-size=' + (process.env.DSH_NODE_MEM || '1536'),
    PATH: [join(HOME, 'node/bin'), '/system/bin', '/bin'].join(':'),
  };
}

// 预构建产物（PC 端 build:lib + build:web 后打包的 ustar tar.gz，由 ConsoleActivity 从 assets 复制）
const PREBUILT = process.env.DSH_PREBUILT;

/**
 * 解析 ustar tar（无需外部工具）：文件(0/'0')、目录(5)、符号链接(2)。
 * 兼容 prefix 拆分长路径（>100 字符）。防御：跳过绝对路径与 .. 穿越。
 */
function untar(buf, dest) {
  let off = 0;
  let files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name0 = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (!name0) break;
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = (prefix ? prefix + '/' : '') + name0;
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      off += 512; continue; // 跳过危险条目
    }
    const sizeStr = h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(h[156]);
    const data = buf.subarray(off + 512, off + 512 + size);
    const p = join(dest, name);
    if (type === '5') {
      mkdirSync(p, { recursive: true });
    } else if (type === '2') {
      const target = h.subarray(157, 257).toString('utf8').replace(/\0[\s\S]*$/, '');
      mkdirSync(dirname(p), { recursive: true });
      try { symlinkSync(target, p); } catch { }
    } else if (type === '0' || type === '\0') {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
      files++;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  log(`untar: ${files} files -> ${dest}`);
}

/** 解压预构建产物（lib + web dist + vendor libs）。每次运行都解压（幂等覆盖），
 *  不能按 cli bin 存在与否早退——vendor/ 等部分可能缺失。 */
function ensurePrebuilt() {
  const cliBin = join(DSH_DIR, 'apps/cli/lib/bin.js');
  const webIdx = join(DSH_DIR, 'apps/web/dist/index.html');
  if (!PREBUILT || !existsSync(PREBUILT)) return existsSync(cliBin) && existsSync(webIdx);
  try {
    log('extracting prebuilt: ' + PREBUILT);
    untar(gunzipSync(readFileSync(PREBUILT)), DSH_DIR);
  } catch (t) {
    log('prebuilt extract failed: ' + t.message);
  }
  return existsSync(cliBin) && existsSync(webIdx) &&
    existsSync(join(DSH_DIR, 'vendor/cordis/lib/index.js'));
}

/**
 * Android 没有 /usr/bin/env，node_modules/.bin 下所有 `#!/usr/bin/env node`/
 * `#!/usr/bin/env sh` 脚本都无法被内核 exec。批量把 shebang 改写为绝对解释器
 * 路径（node → 内置 node；sh/bash → /system/bin/sh）。pnpm install 后执行一次。
 */
function fixShebangs(dir, nodeBin) {
  const binDir = join(dir, 'node_modules/.bin');
  if (!existsSync(binDir)) return 0;
  let fixed = 0;
  for (const f of readdirSync(binDir)) {
    let target;
    try {
      target = realpathSync(join(binDir, f));
      if (lstatSync(target).isDirectory()) continue;
    } catch { continue; }
    try {
      const bytes = readFileSync(target);
      const nl = bytes.indexOf(0x0a);
      if (nl < 0) continue;
      const first = bytes.subarray(0, nl).toString('utf8');
      if (!first.startsWith('#!')) continue;
      if (first.startsWith('#!/usr/bin/env')) {
        const interp = first.slice('#!/usr/bin/env'.length).trim().split(/\s+/)[0];
        const repl = interp === 'node' ? nodeBin
          : (interp === 'sh' || interp === 'bash') ? '/system/bin/sh' : null;
        if (repl) {
          writeFileSync(target, Buffer.concat([Buffer.from('#!' + repl + '\n'), bytes.subarray(nl + 1)]));
          fixed++;
        }
      } else if (first.startsWith('#!/usr/bin/node')) {
        writeFileSync(target, Buffer.concat([Buffer.from('#!' + nodeBin + '\n'), bytes.subarray(nl + 1)]));
        fixed++;
      }
    } catch { /* 跳过不可写/非脚本 */ }
  }
  log(`shebang fix: ${fixed} scripts under ${binDir}`);
  return fixed;
}

log('=== dsh install start ===');
log('DSH_DIR=' + DSH_DIR + ' NODE=' + NODE_BIN + ' pnpm=' + PNPM_VERSION);

// TMPDIR 就绪（node 构建/安装临时文件）
try { mkdirSync(join(HOME, 'tmp'), { recursive: true }); } catch {}

if (!existsSync(DSH_DIR)) { log('FATAL: ' + DSH_DIR + ' missing'); process.exit(1); }
const pkg = JSON.parse(readFileSync(join(DSH_DIR, 'package.json'), 'utf8'));
log('harness version: ' + (pkg.version || 'unknown') + ' packageManager: ' + (pkg.packageManager || '-'));

// registry：国内直连 npmmirror 最快；npmjs 作为 fallback（设备网络不通 npmmirror 时用）
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
log('registry: ' + REGISTRY);

// 1) 本地 pnpm（复用 .tools，避免每次重装）；bin 脚本 shebang 依赖 /usr/bin/env，
//    Android 没有该路径，统一用内置 node 显式执行
let pnpmBin = join(TOOLS, 'bin/pnpm.cjs');
if (!existsSync(pnpmBin)) pnpmBin = join(TOOLS, 'lib/node_modules/pnpm/bin/pnpm.cjs');
let needPnpm = !existsSync(pnpmBin);
if (needPnpm) {
  mkdirSync(TOOLS, { recursive: true });
  log('installing pnpm@' + PNPM_VERSION + ' ...');
  const r = spawnSync(NPM_BIN, ['install', '-g', `pnpm@${PNPM_VERSION}`, '--prefix', TOOLS, '--registry', REGISTRY, '--no-audit', '--no-fund'], { stdio: 'inherit', env: envWithNode() });
  if (r.status !== 0) { log('FATAL: pnpm install failed'); process.exit(1); }
}
log('pnpm: ' + pnpmBin);

// 2) pnpm install
if (!existsSync(join(DSH_DIR, 'node_modules'))) {
  // 注：pnpm 11 已不接受 --no-audit/--no-fund（报 Unknown options），因此不传
  const ok = run(NODE_BIN, [pnpmBin, 'install', '--no-frozen-lockfile', '--ignore-scripts', '--registry', REGISTRY, '--reporter', 'append-only', '--config.confirmModulesPurge=false'], { cwd: DSH_DIR, env: envWithNode() });
  if (!ok) { log('FATAL: pnpm install failed'); process.exit(1); }
  fixShebangs(DSH_DIR, NODE_BIN);
} else {
  log('node_modules exists, skip install');
}

// 3) 预构建产物（lib + web dist + vendor），每次运行都解压（幂等覆盖）。
//    设备端全量 tsc 会 OOM（3.7GB 内存跑 tsc 需 >1.5GB heap），所以正常路径不构建。
const prebuiltReady = ensurePrebuilt();
if (!existsSync(join(DSH_DIR, 'apps/cli/lib/bin.js'))) {
  if (!prebuiltReady) {
    const ok = run(NODE_BIN, [pnpmBin, 'run', 'build:lib'], { cwd: DSH_DIR, env: envWithNode() });
    if (!ok) { log('FATAL: build:lib failed'); process.exit(1); }
  }
} else {
  log('apps/cli/lib/bin.js exists, skip build:lib');
}

// 4) 前端产物（apps/web → dist，供 dsh web 服务）
if (!existsSync(join(DSH_DIR, 'apps/web/dist/index.html'))) {
  if (!prebuiltReady) {
    const ok = run(NODE_BIN, [pnpmBin, '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'], { cwd: DSH_DIR, env: envWithNode() });
    if (!ok) { log('FATAL: build:web failed'); process.exit(1); }
  }
} else {
  log('apps/web/dist exists, skip build:web');
}

// 5) 环境文件
try {
  writeFileSync(join(DSH_DIR, '.dsh-env'),
    `DSH_HOME=${DSH_DIR}\nWEB_PORT=3080\nPNPM_VERSION=${PNPM_VERSION}\nNODE_BIN=${NODE_BIN}\nINSTALL_DATE=${new Date().toISOString()}\n`);
  log('OK .dsh-env written');
} catch (e) { log('WARN .dsh-env: ' + e.message); }

log('=== dsh install done ===');