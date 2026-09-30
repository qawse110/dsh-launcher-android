/**
 * install/dsh.mjs — **dsh 本体**的安装与更新（npm 包供给链）。
 *
 * 职责边界：本模块只关心「把 @deepseek-ai/dsh 装到 DSH_PREFIX、版本钉死、
 * 必要时装 ripgrep 兜底」。不涉及插件装配（见 plugins.mjs）与依赖桥接（见 deps.mjs）。
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync, cpSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  FILES_DIR, NODE_BIN, NPM_BIN, DSH_PREFIX, TOOLS, TERMUX, REGISTRY, REGISTRY_FALLBACK,
  PNPM_VERSION, NPM_TIMEOUT_MS, NPM_NET_ARGS,
  log, run, runEx, isOom, envBase, pinnedDshTag, dshCli, dshInstalled,
} from './env.mjs';

function ensurePnpm() {
  mkdirSync(TOOLS, { recursive: true });
  const pnpmRoot = join(FILES_DIR, '.tools', 'lib/node_modules/pnpm');
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
        rmSync(join(FILES_DIR, '.tools', 'bin', name), { recursive: true, force: true });
      }
      pnpmCjs = join(pnpmRoot, 'bin/pnpm.cjs');
    }
  }
  if (!existsSync(pnpmCjs)) pnpmCjs = join(FILES_DIR, '.tools', 'bin/pnpm.cjs');
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
    if (!existsSync(pnpmCjs)) pnpmCjs = join(FILES_DIR, '.tools', 'bin/pnpm.cjs');
  }
  // dsh plugin 通过 PATH 里的 `pnpm` 命令转发；Android 没有 /usr/bin/env，
  // 所以写一个 system sh wrapper 保证 pnpm 可执行。
  // 注意：TOOLS/bin/pnpm 可能是 npm 生成的符号链接，必须先删掉再写文件，
  // 否则 writeFileSync 会跟着符号链接覆盖真正的 pnpm.mjs。
  const wrapper = join(FILES_DIR, '.tools', 'bin/pnpm');
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
  // dsh 本体版本钉死（DSH_TAG 环境变量可覆盖）。默认值来自 assets/dsh-pin.json ——
  // 与 DshFlow.PINNED_DSH_TAG 同源，避免两处版本号各自漂移（历史上每次升级都要
  // 手工同步两处，漏一处就静默装错版本）。
  const tag = process.env.DSH_TAG || pinnedDshTag();
  const pkgSpec = `@deepseek-ai/dsh@${tag}`;
  const pkgDir = join(DSH_PREFIX, 'node_modules/@deepseek-ai/dsh');
  const beforeVersion = (() => {
    try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
  })();
  const pnpmBin = join(FILES_DIR, '.tools', 'bin', 'pnpm');
  const pnpmStoreEnv = { npm_config_store_dir: join(FILES_DIR, '.tools', 'pnpm-store') };
  const pnpmCommon = ['--ignore-scripts', '--prefer-offline', '--reporter', 'append-only', '--loglevel', 'warn'];

  log(`install/update ${pkgSpec} ... (currently ${beforeVersion || 'absent'})`);
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
    const args = a.engine === 'pnpm'
      ? ['add', '--dir', DSH_PREFIX, pkgSpec, '--registry', a.registry, ...pnpmCommon]
      : ['install', '--prefix', DSH_PREFIX, pkgSpec, '--registry', a.registry,
        '--no-audit', '--no-fund', '--ignore-scripts', '--force', ...NPM_NET_ARGS];
    if (a !== attempts[0]) log(`retrying with engine ${a.label} ...`);
    let r = runEx(a.cmd, args, { env: { ...envBase(), ...a.env }, timeoutMs: NPM_TIMEOUT_MS });
    // P0 修复：npm 布局 → pnpm 需清空重建，但绝不在安装前预删——弱网下
    // "先删后装"一次失败就把可用安装毁成零安装。改为：pnpm 首次失败且
    // 检测到 npm 布局（无 pnpm-lock）时才清理，并就地重试一次。
    if ((!r.ok || !dshInstalled()) && a.engine === 'pnpm' && !a._migrated &&
        existsSync(join(DSH_PREFIX, 'node_modules')) &&
        !existsSync(join(DSH_PREFIX, 'pnpm-lock.yaml'))) {
      a._migrated = true;
      log('pnpm: npm-layout node_modules detected after failure, cleaning and retrying once');
      try { rmSync(join(DSH_PREFIX, 'node_modules'), { recursive: true, force: true }); }
      catch (e) { log('WARN clean node_modules: ' + e.message); }
      r = runEx(a.cmd, args, { env: { ...envBase(), ...a.env }, timeoutMs: NPM_TIMEOUT_MS });
    }
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
  // 升级有效性校验：包管理器在已有依赖满足 spec（如 ^0.1.1-rc.2 对 latest
  // 解析出 0.1.2-rc.1 视为已满足）时会 exit=0 但什么都不装。这里对照
  // dist-tag 实际解析版本；未达 tag 则 remove 后强制重装一次。
  let afterVersion = beforeVersion;
  let distTagVersion = '';
  try {
    afterVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || '';
  } catch {}
  try {
    const regBody = runCapture(NODE_BIN, [
      '-e',
      `fetch((process.env.DSH_REG_URL||'')+'/@deepseek-ai/dsh').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j['dist-tags']||{}))}).catch(()=>console.log('{}'))`,
    ], { env: { ...envBase(), DSH_REG_URL: REGISTRY }, timeoutMs: 60_000 });
    distTagVersion = String(JSON.parse(regBody || '{}')[tag] || '');
  } catch (e) {
    log('WARN dist-tag probe failed: ' + e.message);
  }
  const tagSatisfied = !distTagVersion || afterVersion === distTagVersion ||
    (typeof cmpVer === 'function' && cmpVer(afterVersion, distTagVersion) >= 0);
  if (!tagSatisfied) {
    log(`stale install detected: ${afterVersion} != dist-tag ${tag}=${distTagVersion}, force reinstall`);
    runEx(pnpmBin, ['remove', '--dir', DSH_PREFIX, '@deepseek-ai/dsh', ...pnpmCommon],
      { env: { ...envBase(), ...pnpmStoreEnv }, timeoutMs: NPM_TIMEOUT_MS });
    const fr = runEx(pnpmBin, ['add', '--dir', DSH_PREFIX, pkgSpec, '--registry', REGISTRY, ...pnpmCommon],
      { env: { ...envBase(), ...pnpmStoreEnv }, timeoutMs: NPM_TIMEOUT_MS });
    try {
      afterVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || afterVersion;
    } catch {}
    if (!fr.ok || afterVersion === beforeVersion) {
      log(`WARN forced reinstall still at ${afterVersion} (registry mirror may lag upstream)`);
    }
  }
  try {
    const lock = existsSync(join(DSH_PREFIX, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    log(`dsh version: ${afterVersion || 'unknown'} (lockfile=${lock}, dist-tag ${tag}=${distTagVersion || '?'})`);
  } catch {}
  // 钉死版本校验：DSH_TAG 为精确版本号时，装完必须精确等于该版本，
  // 否则说明镜像滞后/解析漂移——日志大声报出来，别让版本静默漂移。
  if (tag !== 'latest' && tag !== 'next' && afterVersion && afterVersion !== tag) {
    log(`WARN pinned version mismatch: installed ${afterVersion}, expected ${tag}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { timeout: opts.timeoutMs ?? 60_000, encoding: 'utf8', env: opts.env || process.env });
  if (r.error) throw r.error;
  return r.stdout || '';
}

function ensureRipgrepFallback() {
  const rgPkg = join(DSH_PREFIX, 'node_modules/@vscode/ripgrep/package.json');
  if (!existsSync(rgPkg)) {
    log('@vscode/ripgrep not installed, skip ripgrep fallback');
    return;
  }
  const termuxRg = join(FILES_DIR, 'termux/usr/bin/rg');
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
  const pnpmBin = join(FILES_DIR, '.tools', 'bin', 'pnpm');
  const installFallback = (spec, registry) => {
    if (pnpmManaged) {
      return run(pnpmBin, ['add', '--dir', DSH_PREFIX, spec, '--registry', registry,
        '--ignore-scripts', '--prefer-offline', '--reporter', 'append-only', '--loglevel', 'warn'], {
        env: { ...envBase(), npm_config_store_dir: join(FILES_DIR, '.tools', 'pnpm-store') },
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

// ensureHostPkg 被 ensureDsh 内部调用、runCapture 被 ensureRipgrepFallback 内部调用，
// 均无外部消费者，故不导出（导出面 = 真实消费面）。
export { ensurePnpm, ensureDsh, ensureRipgrepFallback };
