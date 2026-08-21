#!/usr/bin/env node
/**
 * routing-suite.mjs — yjh051108/dsh-routing-suite 特殊适配安装/更新。
 *
 * 该仓库是聚合仓库（submodule: dsh-super-injector / dsh-router-standard），
 * 不能像普通插件那样 `dsh plugin add github:...` 直接装配。
 * 这里特殊处理：
 *   1) 从 GitHub codeload 下载 routing-suite 及子仓库源码包；
 *   2) 用官方 `dsh plugin --profile web add <path>` 装配 injector；
 *   3) 把 router-standard/router-spec 等 agent-preset 拷贝到 $HOME/.dsh/.agent-presets。
 *
 * 环境变量：
 *   HOME / NODE_BIN / DSH_PREFIX / DSH_PROFILE / ROUTING_REPO / ROUTING_DIR
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE_BIN = process.env.NODE_BIN || join(HOME, 'node/bin/node');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const ROUTING_DIR = process.env.DSH_ROUTING_DIR || join(HOME, 'routing-suite');
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(HOME, 'plugins');
const TOOLS = join(HOME, '.tools');
const TERMUX = process.env.TERMUX_PREFIX || join(HOME, 'termux/usr');
const TMP = join(HOME, 'tmp');
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

const SUITE_REPO = process.env.DSH_ROUTING_REPO || 'yjh051108/dsh-routing-suite';
const SUBMODULES = [
  { name: 'injector', repo: 'yjh051108/dsh-super-injector' },
  { name: 'preset', repo: 'yjh051108/dsh-router-standard' },
];

function log(m) {
  const l = `${new Date().toISOString()} [routing-suite] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

function envBase() {
  const pnpmDirs = [join(TOOLS, 'bin'), join(TOOLS, 'lib/node_modules/.bin'), join(TOOLS, 'lib/node_modules/pnpm/bin')];
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
    TMPDIR: TMP,
    TMP: TMP,
    TEMP: TMP,
    TERM: 'xterm-256color',
    CI: '1',
    OPENSSL_CONF: '/dev/null',
    PATH: pathParts.join(':'),
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

function run(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  log('$ ' + cmd + ' ' + args.join(' ') + ` (timeout=${Math.round(timeoutMs / 1000)}s)`);
  const { timeoutMs: _ignored, ...spawnOpts } = opts;
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
  return r.status === 0;
}

function dshPlugin(args) {
  if (!existsSync(dshCli())) {
    log('dsh CLI not found: ' + dshCli());
    return false;
  }
  return run(NODE_BIN, [dshCli(), 'plugin', '--profile', DSH_PROFILE, ...args], { env: envBase(), timeoutMs: 5 * 60_000 });
}

async function download(url, dest) {
  log('GET ' + url);
  // Android 网络栈可能卡死在一个无响应的 TCP 连接上，给单次请求加超时，
  // 让 fetchRepo 的 main/master 分支重试逻辑真正生效。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout after 30s')), 30_000);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  log('downloaded ' + dest + ' (' + (buf.length / 1024).toFixed(0) + 'KB)');
}

function stripSingleTop(dir) {
  const kids = readdirSync(dir).filter((k) => !k.startsWith('.'));
  if (kids.length === 1) {
    const inner = join(dir, kids[0]);
    if (!existsSync(inner) || !statSync(inner).isDirectory()) return;
    const tmp = dir + '.tmp';
    rmSync(tmp, { recursive: true, force: true });
    renameSync(inner, tmp);
    for (const k of readdirSync(tmp)) renameSync(join(tmp, k), join(dir, k));
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      // 跳过整个条目（header + data），不能只跳 512 字节，否则会把
      // 当前条目的数据体误当成下一个 tar header 解析。
      off += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    const type = String.fromCharCode(h[156]);
    const data = buf.subarray(off + 512, off + 512 + size);
    const p = join(dest, name);
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
    off += 512 + Math.ceil(size / 512) * 512;
  }
  log('untar: ' + files + ' files -> ' + dest);
}

async function fetchRepo(repo, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const tgz = join(TMP, (repo.split('/')[1] || 'repo') + '.tar.gz');
  let ok = false;
  for (const branch of ['main', 'master']) {
    try {
      await download(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`, tgz);
      ok = true;
      break;
    } catch (e) {
      log('branch ' + branch + ' failed: ' + e.message);
    }
  }
  if (!ok) throw new Error('cannot download ' + repo);
  untar(gunzipSync(readFileSync(tgz)), dest);
  stripSingleTop(dest);
}

async function installSuite() {
  log('=== routing-suite special install ===');
  mkdirSync(ROUTING_DIR, { recursive: true });
  log('fetching ' + SUITE_REPO);
  await fetchRepo(SUITE_REPO, ROUTING_DIR);
  for (const sub of SUBMODULES) {
    const dest = join(ROUTING_DIR, sub.name);
    log('fetching submodule ' + sub.repo + ' -> ' + dest);
    await fetchRepo(sub.repo, dest);
  }

  // 1) injector：优先装配 APK 内置的已构建版本（lib/ 存在）。
  //    只有内置版本缺失时才使用刚拉取的源码，并尝试构建；内置 Termux 提供 bash，
  //    但源码仓库通常只有 src/ 没有 lib/，直接 plugin add 无法作为 bundle 加载。
  const bundledInjector = join(PLUGINS_DIR, 'dsh-super-injector');
  const sourceInjector = join(ROUTING_DIR, 'injector');
  const injector = existsSync(join(bundledInjector, 'lib/index.js'))
    ? bundledInjector
    : sourceInjector;
  if (injector === sourceInjector && !existsSync(join(injector, 'lib/index.js')) && existsSync(join(injector, 'scripts/build.sh'))) {
    log('injector lib missing, trying build...');
    run('/system/bin/sh', ['-c', 'cd ' + injector + ' && bash scripts/build.sh'], { env: envBase() });
  }
  if (existsSync(join(injector, 'package.json'))) {
    dshPlugin(['add', injector]);
  } else {
    log('injector package missing, skip');
  }

  // 2) router-standard/router-spec 等 agent-preset：拷贝/展平到 .agent-presets
  const presetRoot = join(ROUTING_DIR, 'preset');
  const presetSrc = existsSync(join(presetRoot, 'preset')) ? join(presetRoot, 'preset') : presetRoot;
  const destRoot = join(HOME, '.dsh/.agent-presets');
  mkdirSync(destRoot, { recursive: true });
  const sourceNames = new Set();
  if (existsSync(join(presetSrc, 'agent.cordis.yml'))) {
    const dest = join(destRoot, 'router-standard');
    rmSync(dest, { recursive: true, force: true });
    cpSync(presetSrc, dest, { recursive: true, force: true });
    log('preset copied: router-standard');
  } else if (existsSync(presetSrc)) {
    let copied = 0;
    for (const child of readdirSync(presetSrc, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      sourceNames.add(child.name);
      const childSrc = join(presetSrc, child.name);
      if (!existsSync(join(childSrc, 'agent.cordis.yml'))) continue;
      const dest = join(destRoot, child.name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(childSrc, dest, { recursive: true, force: true });
      copied++;
    }
    log('presets copied: ' + copied);
  }
  // 上游当前不再发布 router-pro；清理历史安装残留，避免 agent-presets 里出现已移除的预设。
  if (existsSync(presetSrc)) {
    for (const stale of ['router-pro']) {
      if (!sourceNames.has(stale)) {
        rmSync(join(destRoot, stale), { recursive: true, force: true });
        log('removed stale preset: ' + stale + ' (upstream no longer ships router-pro)');
      }
    }
  }

  log('=== routing-suite special install done ===');
}

installSuite().catch((e) => {
  log('routing-suite install failed: ' + (e.stack || e.message));
  process.exit(1);
});