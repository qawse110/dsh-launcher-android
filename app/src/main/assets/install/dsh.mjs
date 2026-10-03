/**
 * install/dsh.mjs — **dsh 本体**的安装与更新（npm 包供给链）。
 *
 * 职责边界：本模块只关心「把 @deepseek-ai/dsh 装到 DSH_PREFIX、版本钉死、
 * 必要时装 ripgrep 兜底」。不涉及插件装配（见 plugins.mjs）与依赖桥接（见 deps.mjs）。
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync, cpSync, chmodSync, symlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  FILES_DIR, NODE_BIN, NPM_BIN, DSH_PREFIX, TOOLS, TERMUX, REGISTRY, REGISTRY_FALLBACK,
  PNPM_VERSION, NPM_TIMEOUT_MS, NPM_NET_ARGS,
  log, run, runEx, isOom, envBase, pinnedDshTag, dshCli, dshInstalled,
} from './env.mjs';

/**
 * 升级后修复**陈旧的 hoist 链接**——pnpm 升 minor 时不会重建顶层 hoist 面。
 *
 * 真机实证（0.1.7-rc.2 → 0.2.0-rc.2）：
 *   `pnpm add @deepseek-ai/dsh@0.2.0-rc.2` exit=0；`node_modules/@deepseek-ai/dsh`
 *   正确指向 0.2.0；lockfile 里每个内部包都解析成 0.2.0-rc.2 —— **但顶层 287 个
 *   hoist 链接里有 272 个仍指向 0.1.7-rc.2**（时间戳停在首次安装那天）。
 *
 * 为什么这个故障特别隐蔽：日志、版本号、lockfile 三处**都显示升级成功**，
 * 唯一不对的是文件系统里那批链接。而它足以让应用起不来——
 * dsh 本体是 0.2.0、它 require 的内部包却是 0.1.7，0.2.0 新增的服务
 * （webStartup）找不到提供方：
 *   dsh: startup failed: 1 required plugin did not activate
 *   webserver (required)  webStartup
 * 同一份目录用 0.1.7 跑却完全正常，所以现象只在升级后出现。
 *
 * 判据：拿**顶层链接的 readlink** 与 **.pnpm 里该包名的最优版本目录** 比。
 * 只要 dsh 本体已是目标版本、却有内部包链接仍指向**别的版本**，就判定 hoist 面陈旧。
 * 修法用「删 node_modules + pnpm install」全量重建：比逐条重链更不容易漏
 * （hoist 面还牵扯 peer 变体目录名），且与首次安装走同一条路径、幂等；
 * 代价是一次重装——但只在**确实检测到陈旧**时才发生，正常路径零开销。
 *
 * 失败不致命：不抛异常、只记 WARN，下一次启动会重新检测并再试。
 */
function fixStaleHoistedLinks(pkgDir) {
  const nm = join(DSH_PREFIX, 'node_modules');
  const scopeDir = join(nm, '@deepseek-ai');
  const store = join(nm, '.pnpm');
  const selfVersion = (() => {
    try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
  })();
  if (!selfVersion || !existsSync(store)) return;

  if (!existsSync(scopeDir)) return;

  // 目标版本 = **已装 dsh 的版本**，不是「store 里最高版本」。
  // `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 一族是**同版本发布**的，运行时必须同版本；
  // 而 store 里常同时残留新旧两版（升级/回滚都会往里加），取「最高」在回滚场景下会
  // 反而选成新版 —— 那正是「dsh 0.1.7 + 内部包 0.2.0」这类混版的来源。
  // 其余包（cordis / schemastery / cosmokit …）各有独立版本，不归本函数管。
  const target = new Map();   // name -> 该版本的 .pnpm 目录
  for (const d of readdirSync(store)) {
    if (d.startsWith('.')) continue;
    const inner = join(store, d, 'node_modules/@deepseek-ai');
    if (!existsSync(inner)) continue;
    for (const name of readdirSync(inner)) {
      if (name !== 'dsh' && !name.startsWith('dsh-')) continue;
      if (target.has(name)) continue;
      const dir = join(inner, name);
      let ver = '';
      try { ver = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''; } catch { continue; }
      if (ver === selfVersion) target.set(name, dir);
    }
  }
  if (!target.size) return;

  // **原地重指**，不删 node_modules：只动 scope 目录里的符号链接。
  // 旧实现是「发现不一致就 rm -rf node_modules 再 pnpm install」——代价高（数百 MB 重链），
  // 且中途失败会把可用的 dsh 变成零安装。这里逐条改指向，幂等、可中断、失败不影响其它条目。
  let fixed = 0;
  const samples = [];
  for (const [name, dir] of target) {
    const link = join(scopeDir, name);
    let points = '';
    try { points = readlinkSync(link); } catch { continue; }   // 不存在/非链接 → 跳过
    if (points === dir) continue;                              // 已指向目标目录
    let at = '';
    try { at = JSON.parse(readFileSync(join(link, 'package.json'), 'utf8')).version || ''; } catch {}
    if (at === selfVersion) continue;                          // 版本已一致（peer 变体目录名不同）
    try {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(dir, link);
      fixed++;
      if (samples.length < 4) samples.push(`${name}(${at || '?'}→${selfVersion})`);
    } catch (e) {
      log('WARN relink ' + name + ': ' + e.message);
    }
  }
  if (fixed) {
    log(`stale hoisted links re-pointed to dsh ${selfVersion}: ${fixed} 个（如 ${samples.join(', ')}）`);
  }
}

/** 本模块私用的 semver 比较（与 deps.mjs 的 cmpVer 同规则，避免跨模块导出内部件）。 */
function cmpVerLocal(a, b) {
  const parse = (v) => {
    const noBuild = String(v).trim().split('+')[0];
    const dash = noBuild.indexOf('-');
    const core = (dash === -1 ? noBuild : noBuild.slice(0, dash)).split('.').map((n) => parseInt(n, 10) || 0);
    const pre = dash === -1 ? null : noBuild.slice(dash + 1).split('.');
    return { core, pre };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) { const d = (pa.core[i] || 0) - (pb.core[i] || 0); if (d) return d; }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i], y = pb.pre[i];
    const xn = /^\d+$/.test(x) ? parseInt(x, 10) : null;
    const yn = /^\d+$/.test(y) ? parseInt(y, 10) : null;
    let c;
    if (xn !== null && yn !== null) c = xn - yn;
    else if (xn !== null) c = -1;
    else if (yn !== null) c = 1;
    else c = x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return pa.pre.length - pb.pre.length;
}

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
  // ── 升级后的一致性修复：pnpm 的 hoist 链接不会随版本升级自动重建 ──
  //
  // 真机实证（0.1.7-rc.2 → 0.2.0-rc.2）：`pnpm add @deepseek-ai/dsh@0.2.0-rc.2` 报告
  // exit=0，`dsh-prefix/node_modules/@deepseek-ai/dsh` 也正确指向 0.2.0，lockfile 里
  // 全部内部包都解析为 0.2.0-rc.2 —— **但 dsh-prefix 顶层那 287 个 hoist 链接里
  // 有 272 个仍指向 0.1.7-rc.2**（时间戳停在首次安装那天）。
  //
  // 后果不是"版本号显示不对"这么轻：dsh 本体是 0.2.0、它 require 的内部包却是 0.1.7，
  // 两代混用导致 0.2.0 新增的服务（webStartup）找不到提供方，启动直接失败：
  //   dsh: startup failed: 1 required plugin did not activate
  //   webserver (required)  webStartup
  // 而同一份 node_modules 用 dsh 0.1.7 运行时完全正常——所以这个故障只在升级后出现，
  // 且从日志上完全看不出"链接没重建"这一层。
  //
  // 判据：拿**顶层链接实际指向的版本**与**真身 package.json 的版本**比。
  // 不一致即说明 hoist 面是陈旧的，删掉 node_modules 重装一次（幂等；失败不致命，
  // 下次启动会再试）。
  fixStaleHoistedLinks(pkgDir);
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
