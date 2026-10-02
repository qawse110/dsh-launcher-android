/**
 * install/env.mjs — 安装链路的**共享运行环境**：路径常量、日志、子进程封装。
 *
 * 由 install-dsh.mjs 拆出（原文件同时承担环境准备/dsh 安装/插件装配/依赖桥接四类职责）。
 * 这里只放**无业务语义**的基础件：谁需要子进程执行、谁需要日志、谁需要路径，都从这里取。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.HOME || '/data/user/0/com.dsh.nextapp1/files';
// 显式文件根：不依赖调用方是否导出 HOME（契约加固，P1）——所有状态路径由此派生
const FILES_DIR = dirname(process.env.DSH_PREFIX || join(HOME, 'dsh-prefix'));
const NODE_BIN = process.env.NODE_BIN || join(FILES_DIR, 'node/bin/node');
const NPM_BIN = process.env.NPM_BIN || join(FILES_DIR, 'node/bin/npm');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const DSH_APK_VER = process.env.DSH_APK_VER || '';
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(FILES_DIR, 'plugins');
const EXTRA_PLUGINS_SRC = process.env.DSH_EXTRA_PLUGINS_SRC || join(FILES_DIR, 'extra-plugins');
const TOOLS = join(FILES_DIR, '.tools');
const TERMUX = process.env.TERMUX_PREFIX || join(FILES_DIR, 'termux/usr');
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const REGISTRY_FALLBACK = process.env.NPM_REGISTRY_FALLBACK || 'https://registry.npmjs.org';
const PNPM_VERSION = '11.7.0';
// 防卡死：所有子进程都有硬超时；npm 网络层自带重试/超时，避免 TCP 半开连接无限等待
const NPM_TIMEOUT_MS = Number(process.env.DSH_NPM_TIMEOUT_MS || 15 * 60_000);
const PLUGIN_TIMEOUT_MS = Number(process.env.DSH_PLUGIN_TIMEOUT_MS || 5 * 60_000);
const NPM_NET_ARGS = [
  '--prefer-offline',
  // 非 TTY 下让 npm 逐请求输出（等价于 _logs 里的 http fetch 行），避免长阶段静默被误判卡死
  '--loglevel=notice',
  '--fetch-timeout=120000',
  '--fetch-retries=5',
  '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=60000',
];
const OUT = join(FILES_DIR, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';


/** dsh 钉死版本：读 assets/dsh-pin.json（与 DshFlow.PINNED_DSH_TAG 同源）。
 *  读不到时回退编译期常量，保证脚本独立可跑（离线调试/CI）。 */
const FALLBACK_DSH_TAG = '0.2.0-rc.2';

function log(m) {
  const l = `${new Date().toISOString()} [install] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { if (process.env.DSH_SHARED_LOG === '1') writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
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
    join(FILES_DIR, '.tools', 'bin'),
    join(FILES_DIR, '.tools', 'lib/node_modules/.bin'),
    join(FILES_DIR, '.tools', 'lib/node_modules/pnpm/bin'),
  ];
  const termuxReady = existsSync(join(TERMUX, 'bin/bash'));
  const termuxDirs = termuxReady
    ? [join(TERMUX, 'bin'), join(TERMUX, 'bin/applets'), join(TERMUX, 'local/bin')]
    : [];
  const pathParts = [...termuxDirs, join(FILES_DIR, 'node/bin')];
  for (const d of pnpmDirs) if (existsSync(d)) pathParts.push(d);
  pathParts.push('/system/bin', '/bin', '/usr/bin');
  const gitConfig = join(FILES_DIR, '.gitconfig');
  try {
    if (!existsSync(gitConfig)) writeFileSync(gitConfig, '');
  } catch {}
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: termuxReady
      ? join(FILES_DIR, 'node/lib') + ':' + join(TERMUX, 'lib')
      : join(FILES_DIR, 'node/lib'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    TMPDIR: join(FILES_DIR, 'tmp'),
    TMP: join(FILES_DIR, 'tmp'),
    TEMP: join(FILES_DIR, 'tmp'),
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

function pinnedDshTag() {
  try {
    const t = JSON.parse(readFileSync(join(FILES_DIR, 'dsh-pin.json'), 'utf8')).tag;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  return FALLBACK_DSH_TAG;
}

function dshCli() {
  return join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
}

function dshInstalled() {
  return existsSync(dshCli());
}

// 只导出**跨模块实际被 import 的**符号。OUT / OUT_SHARED / FALLBACK_DSH_TAG 是
// 本模块内部实现细节（分别被 log 与 pinnedDshTag 使用），此前一并列出属于空导出面。
export {
  HOME, FILES_DIR, NODE_BIN, NPM_BIN, DSH_PREFIX, DSH_PROFILE, DSH_APK_VER,
  PLUGINS_DIR, EXTRA_PLUGINS_SRC, TOOLS, TERMUX, REGISTRY, REGISTRY_FALLBACK,
  PNPM_VERSION, NPM_TIMEOUT_MS, PLUGIN_TIMEOUT_MS, NPM_NET_ARGS,
  log, runEx, run, isOom, envBase, pinnedDshTag, dshCli, dshInstalled,
};
