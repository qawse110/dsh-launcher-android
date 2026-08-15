import { spawnSync } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync, lstatSync, readlinkSync, mkdirSync, copyFileSync, readFileSync, symlinkSync, rmSync, cpSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
const NODE = '/data/user/0/com.dsh.launcher/files/node';
const HOME = '/data/user/0/com.dsh.launcher/files';
const DSH_DIR = join(HOME, 'deepseek-harness-master');
const OUT = join(HOME, 'install_log.txt'); // 私有目录（无需存储权限）；共享目录尽力而为
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';
function log(m) { const l = `${new Date().toISOString()} ${m}`; console.log(l); try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {} try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {} }
const env = { ...process.env, LD_LIBRARY_PATH: join(NODE, 'lib'), HOME, TMPDIR: join(HOME, 'tmp'), TMP: join(HOME, 'tmp'), TEMP: join(HOME, 'tmp'), OPENSSL_CONF: '/dev/null', PATH: [join(NODE, 'bin'), '/system/bin', '/bin'].join(':') };

// ═══════════════════ 插件装配层（dsh 纯净原版，扩展全走插件） ═══════════════════
const ARGS = process.argv.slice(2);
const MODE = ARGS.includes('--wire-only') ? 'wire'
  : ARGS.includes('--add') ? 'add'
  : ARGS.includes('--remove') ? 'remove'
  : 'boot';

const THIRD_PARTY = join(DSH_DIR, 'third_party');
const PROFILES_NM = join(HOME, '.dsh/profiles/node_modules');
const PROFILE_DIR = join(HOME, '.dsh/profiles/web');
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml');
const AGENT_PRESETS_ROOT = join(HOME, '.dsh/.agent-presets');
const PLUGINS_ROOT = join(HOME, 'plugins');

// 内置插件（boot 时始终装配；在线安装的插件卸载后不再重装）
const BUNDLED = [
  { dir: 'dsh-mobile-nav' },
  { dir: 'dsh-super-injector' },
  { dir: 'dsh-net-proxy' },
  { dir: 'dsh-provider-headers' },
  { dir: 'dsh-vision' },
];
// 思维模式路由预设（agent-presets 机制，非插件行）；目录整体拷入 $DSH_HOME/.agent-presets/
const PRESET_DIRS = ['router-preset'];

/** 解析 ustar tar（无需外部工具）：文件(0/'0')、目录(5)、符号链接(2)。防御 .. 穿越。 */
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
      off += 512; continue;
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

/** 从插件自带 cordis.patch.yml 提取装配行（- insert: 第一项 id/name）。 */
function pluginInfo(pluginDir) {
  const patch = join(THIRD_PARTY, pluginDir, 'cordis.patch.yml');
  if (!existsSync(patch)) return null;
  const text = readFileSync(patch, 'utf8');
  const m = text.match(/- insert:\s*\n\s*- id:\s*(\S+)\s*\n\s*name:\s*['"]?([^'"\s]+)['"]?/);
  if (!m) return null;
  return { id: m[1], name: m[2] };
}

/** 三处链接（DSH 源树 node_modules / profiles/node_modules / 设备 plugins 索引）。 */
function linkLocations(pluginDir, name) {
  const seg = name.startsWith('@') ? name.split('/')[1] : name;
  const parents = name.startsWith('@')
    ? [join(DSH_DIR, 'node_modules', name.split('/')[0]), join(PROFILES_NM, name.split('/')[0]), PLUGINS_ROOT]
    : [join(DSH_DIR, 'node_modules'), PROFILES_NM, PLUGINS_ROOT];
  return { seg, parents };
}

/** 幂等建链接：缺失建、指向错误重建。 */
function ensureLink(parent, seg, src) {
  mkdirSync(parent, { recursive: true });
  const link = join(parent, seg);
  try {
    if (!existsSync(link)) { symlinkSync(src, link, 'dir'); return true; }
    if (realpathSync(link) !== src) {
      rmSync(link, { force: true });
      symlinkSync(src, link, 'dir');
      return true;
    }
  } catch (e) { log('WARN link ' + link + ': ' + e.message); }
  return false;
}

/** 装配一个插件：三处链接 + profile patch insert 行。 */
function wirePlugin(pluginDir, info) {
  const src = join(THIRD_PARTY, pluginDir);
  const { seg, parents } = linkLocations(pluginDir, info.name);
  let linked = 0;
  for (const parent of parents) if (ensureLink(parent, seg, src)) linked++;
  ensurePatchRow(info.id, info.name, linked);
}

/** 幂等写 profile patch insert 行（BOM 剥离 + 流式括号清理 + 缺失初始化）。 */
function ensurePatchRow(id, name, linked = 0) {
  if (!existsSync(PROFILE_PATCH)) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(PROFILE_PATCH, '# Your patch layer for this dsh profile\n[]\n');
  }
  let text = readFileSync(PROFILE_PATCH, 'utf8').replace(/^\uFEFF/, '');
  // 自愈旧文件：注释行与 - insert: 粘连（历史追加 bug）→ 补换行
  text = text.replace(/(#[^\n]*?)- insert:/g, '$1\n- insert:');
  const has = text.split('\n').some((l) => {
    const t = l.trim();
    return t === 'id: ' + id || t === '- id: ' + id;
  });
  if (has) { log('已有 ' + name + (linked ? `（补链 ${linked}）` : '')); return false; }
  let t = text.trimEnd().replace(/\n?\[\]$/, '').replace(/[ \t]+$/, '');
  const sep = t.length > 0 && !t.endsWith('\n') ? '\n' : '';
  const block = "- insert:\n    - id: " + id + "\n      name: '" + name + "'\n";
  writeFileSync(PROFILE_PATCH, t + sep + block);
  log('装配 ' + name + (linked ? `（链 ${linked}）` : ''));
  return true;
}

/** 从 profile patch 移除某插件的 insert 块；空列表还原为 []。 */
function removePatchRow(id) {
  if (!existsSync(PROFILE_PATCH)) return false;
  let text = readFileSync(PROFILE_PATCH, 'utf8').replace(/^\uFEFF/, '');
  const re = new RegExp("\\n?- insert:\\s*\\n\\s*- id: " + id + "\\s*\\n\\s*name: '[^']+'[^\\n]*\\n?", 'g');
  const out = text.replace(re, '');
  if (out === text) return false;
  const final = out.trimEnd();
  const hasRow = /(^|\n)\s*- /.test(final);
  writeFileSync(PROFILE_PATCH, hasRow ? final + '\n' : final + '\n[]\n');
  return true;
}

/**
 * 扫描 workspace（packages 二级、apps、vendor、native 各层）里 name 以
 * @deepseek-ai 开头的包，在 DSH 源树根 node_modules/@deepseek-ai 全量建链接。
 * 外部插件（third_party 旁挂，非 workspace 成员）import @deepseek-ai/x 时从
 * third_party 上溯到根 node_modules 解析——pnpm 只建根依赖的顶层链接，这里补全。
 */
function ensureWorkspaceScopedLinks() {
  const root = DSH_DIR;
  const dirs = [];
  for (const g of ['packages', 'apps', 'vendor']) {
    const top = join(root, g);
    if (!existsSync(top)) continue;
    for (const d of readdirSync(top)) {
      const mid = join(top, d);
      if (!existsSync(join(mid, 'package.json'))) {
        // packages/*/* 二级（packages/core/tools 等）
        if (existsSync(mid) && statIsDir(mid)) {
          for (const d2 of readdirSync(mid)) {
            const p = join(mid, d2, 'package.json');
            if (existsSync(p)) dirs.push(p);
          }
        }
        continue;
      }
      dirs.push(join(mid, 'package.json'));
    }
  }
  const scopedRoot = join(root, 'node_modules/@deepseek-ai');
  if (!existsSync(scopedRoot)) mkdirSync(scopedRoot, { recursive: true });
  let linked = 0;
  for (const p of dirs) {
    let j;
    try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    if (typeof j.name !== 'string' || !j.name.startsWith('@deepseek-ai/')) continue;
    const pkg = j.name.slice('@deepseek-ai/'.length);
    const target = dirname(p);
    const link = join(scopedRoot, pkg);
    if (ensureLink(scopedRoot, pkg, target)) linked++;
  }
  if (linked) log(`workspace scoped links: +${linked}`);
}
function statIsDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

/** 内置插件 + 路由预设装配（boot 与 --wire-only 共用）。 */
function wireAll() {
  ensureWorkspaceScopedLinks();
  // 自愈：注释/[] 模板与 insert 块粘连的历史格式（写入前归一化）
  try {
    if (existsSync(PROFILE_PATCH)) {
      let t = readFileSync(PROFILE_PATCH, 'utf8').replace(/^\uFEFF/, '');
      const n = t.replace(/(#[^\n]*?)- insert:/g, '$1\n- insert:');
      if (n !== t) { writeFileSync(PROFILE_PATCH, n); log('patch 粘连修复'); }
    }
  } catch {}
  const report = [];
  for (const b of BUNDLED) {
    const dir = join(THIRD_PARTY, b.dir);
    if (!existsSync(dir)) { report.push(b.dir + ': 未内置'); continue; }
    const info = pluginInfo(b.dir);
    if (!info) { report.push(b.dir + ': 无装配行'); continue; }
    wirePlugin(b.dir, info);
    report.push(b.dir + ' => ' + info.name);
  }
  for (const p of PRESET_DIRS) {
    const src = join(THIRD_PARTY, p);
    if (!existsSync(src)) { report.push(p + ': 未内置'); continue; }
    try {
      mkdirSync(AGENT_PRESETS_ROOT, { recursive: true });
      cpSync(src, join(AGENT_PRESETS_ROOT, p), { recursive: true, force: true });
      report.push('preset 安装: ' + p);
    } catch (e) { report.push('preset 失败: ' + e.message); }
  }
  log('wire: ' + report.join(' | '));
}

// ── 插件管理 CLI 模式（Android 插件页调用） ─────────────────────────────
if (MODE === 'wire') {
  wireAll();
  log('=== wire done ===');
  process.exit(0);
}
if (MODE === 'add') {
  const i = ARGS.indexOf('--add');
  const tgz = ARGS[i + 1];
  const dirName = ARGS[i + 2];
  if (!tgz || !dirName || /[\\/]|\.\./.test(dirName)) { log('usage: --add <repo>.tar.gz <dirName>'); process.exit(2); }
  try {
    const target = join(THIRD_PARTY, dirName);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    untar(gunzipSync(readFileSync(tgz)), target);
    // codeload 顶层单目录（<repo>-<branch>/）剥一层
    const kids = readdirSync(target).filter((k) => !k.startsWith('.'));
    if (kids.length === 1 && existsSync(join(target, kids[0], 'package.json'))) {
      const inner = join(target, kids[0]);
      const tmp = target + '.tmp';
      rmSync(tmp, { recursive: true, force: true });
      renameSync(inner, tmp);
      for (const k of readdirSync(tmp)) renameSync(join(tmp, k), join(target, k));
      rmSync(tmp, { recursive: true, force: true });
      log('剥层: ' + kids[0] + ' -> ' + dirName);
    }
    const info = pluginInfo(dirName);
    if (!info) {
      log('插件识别失败：' + dirName + ' 无 - insert 装配行（该仓库可能未构建/非插件包）');
      process.exit(3);
    }
    wirePlugin(dirName, info);
    log('install ok: ' + info.name + ' (id=' + info.id + ')');
    log('=== add done ===');
  } catch (e) { log('add failed: ' + e.message); process.exit(4); }
  process.exit(0);
}
if (MODE === 'remove') {
  const i = ARGS.indexOf('--remove');
  const what = ARGS[i + 1];
  if (!what) { log('usage: --remove <dir|name>'); process.exit(2); }
  let hit = null;
  for (const d of readdirSync(THIRD_PARTY)) {
    if (!d.includes(what)) continue;
    const info = pluginInfo(d);
    if (info) hit = { dir: d, ...info };
  }
  if (!hit) { log('not found: ' + what); process.exit(3); }
  if (BUNDLED.some((b) => b.dir === hit.dir)) {
    log('内置插件不可卸载：' + hit.name + '（boot 时自动装配）');
    process.exit(5);
  }
  const { seg, parents } = linkLocations(hit.dir, hit.name);
  for (const parent of parents) rmSync(join(parent, seg), { recursive: true, force: true });
  const removed = removePatchRow(hit.id);
  log((removed ? '已卸载 ' : 'patch 行缺失（链接已清） ') + hit.name);
  log('=== remove done ===');
  process.exit(0);
}
const KSTUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsc2l6ZW9mOigpPT4wLGFsaWdub2Y6KCk9PjAsZnVuY3Rpb246KCk9PnAsc3RydWN0OigpPT5wLHVuaW9uOigpPT5wLGVudW06KCk9PnAsdHlwZWRlZjooKT0+cCxwb2ludGVyOigpPT5wLHJlZ2lzdGVyOigpPT5wLEtvZmZpRXJyb3I6Y2xhc3MgZXh0ZW5kcyBFcnJvcnt9fTtleHBvcnQgZGVmYXVsdCBrb2ZmaTs=';
const SHARP_STUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO21vZHVsZS5leHBvcnRzPXA7bW9kdWxlLmV4cG9ydHMuZGVmYXVsdD1wOw==';
const PSTUB = 'Y29uc3R7RXZlbnRFbWl0dGVyfT1yZXF1aXJlKCdldmVudHMnKTtjbGFzcyBGIGV4dGVuZHMgRXZlbnRFbWl0dGVye2NvbnN0cnVjdG9yKCl7c3VwZXIoKTt0aGlzLnBpZD0wO3RoaXMuZXhpdENvZGU9MH13cml0ZSgpe31raWxsKCl7fXJlc2l6ZSgpe31jbGVhcigpe31jbG9zZSgpe31vbkV4aXQoYyl7aWYoYyljKHtleGl0Q29kZTowLHNpZ25hbDp1bmRlZmluZWR9KX19bW9kdWxlLmV4cG9ydHM9e3NwYXduKCl7Y29uc3QgeD1uZXcgRigpO3Byb2Nlc3MubmV4dFRpY2soKCk9PnguZW1pdCgnZXhpdCcse2V4aXRDb2RlOjAsc2lnbmFsOnVuZGVmaW5lZH0pKTtyZXR1cm4geH0sZm9yaygpe3JldHVybiBuZXcgRigpfSxvcGVuKCl7cmV0dXJue21hc3RlcjpuZXcgRigpLHNsYXZlOm5ldyBGKCl9fX07';
/** 在 .pnpm 目录下按包名前缀递归定位真实包路径（pnpm v10 的目录哈希不固定，不能硬编码）。 */
function findPnpmPkg(pnpmDir, prefix, pkgRel) {
  if (!existsSync(pnpmDir)) return null;
  for (const d of readdirSync(pnpmDir)) {
    if (!d.startsWith(prefix)) continue;
    const p = join(pnpmDir, d, 'node_modules', pkgRel);
    if (existsSync(p)) return p;
  }
  return null;
}
// koffi / node-pty / sharp 在 Android 上无预编译二进制（arm64 prebuild 缺失），
// 用万能 Proxy 顶替可加载。新架构（rc.5+）下同样适用。
const pnpm = join(DSH_DIR, 'node_modules/.pnpm');
try {
  const k = findPnpmPkg(pnpm, 'koffi@', 'koffi/index.js');
  if (k) { writeFileSync(k, Buffer.from(KSTUB, 'base64')); log('koffi stub ok: ' + k); }
  else log('koffi: not installed, skip');
} catch (e) { log('WARN koffi: ' + e.message); }
try {
  const p = findPnpmPkg(pnpm, 'node-pty@', 'node-pty/lib/index.js');
  if (p) { writeFileSync(p, Buffer.from(PSTUB, 'base64')); log('node-pty stub ok: ' + p); }
  else log('node-pty: not installed, skip');
} catch (e) { log('WARN node-pty: ' + e.message); }
try {
  // 已安装 → 替换入口；未安装 → 沿 workspace 链接补建 stub 包（Android 无 libvips）
  let s = findPnpmPkg(pnpm, 'sharp@', 'sharp/lib/index.js');
  if (!s) {
    try {
      const link = join(DSH_DIR, 'packages/attachment/attachment-local/node_modules/sharp');
      if (lstatSync(link).isSymbolicLink()) {
        const t = join(resolve(dirname(link), readlinkSync(link)), 'index.js');
        if (!existsSync(t)) {
          mkdirSync(dirname(t), { recursive: true });
          writeFileSync(join(dirname(t), 'package.json'),
            JSON.stringify({ name: 'sharp', version: '0.0.0-dsh-stub', main: 'index.js', type: 'commonjs' }, null, 2));
        }
        s = t;
      }
    } catch (e) { log('WARN sharp link: ' + e.message); }
  }
  if (s) { writeFileSync(s, Buffer.from(SHARP_STUB, 'base64')); log('sharp stub ok: ' + s); }
  else log('sharp: not installed, skip');
} catch (e) { log('WARN sharp: ' + e.message); }
try {
  // Windows-only 宿主包在模块加载期断言 koffi 结构布局；koffi 已被 stub 替换，
  // 布局恒不匹配。这些断言只在 ABI 破坏时有用，stub 环境下无害，直接禁用。
  const w = findPnpmPkg(pnpm, '@deepseek-ai+dsh-sandbox-windows-acl@', '@deepseek-ai/dsh-sandbox-windows-acl/lib')
    || join(DSH_DIR, 'packages/sandbox/sandbox-windows-acl/lib');
  if (w) {
    let patched = 0;
    for (const f of readdirSync(w)) {
      if (!f.endsWith('.js')) continue;
      const p = join(w, f);
      const src = readFileSync(p, 'utf8');
      if (!src.includes('layout mismatch')) continue;
      let out = src;
      out = out.replace(/if \(STARTUPINFOW\.size !== 104\) throw new Error\(`STARTUPINFOW layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, STARTUPINFOW assert disabled */');
      out = out.replace(/if \(PROCESS_INFORMATION\.size !== 24\) throw new Error\(`PROCESS_INFORMATION layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, PROCESS_INFORMATION assert disabled */');
      if (out !== src) { writeFileSync(p, out); patched++; }
    }
    if (patched) log(`sandbox-windows-acl asserts disabled: ${patched} file(s)`);
    else log('sandbox-windows-acl: no assert found (already patched?)');
  } else {
    log('sandbox-windows-acl: not installed, skip');
  }
} catch (e) { log('WARN sandbox-windows-acl: ' + e.message); }
try {
  // WebView / Chrome 96 无 AbortSignal.timeout，client-connection 的 describe RPC
  // 依赖它做超时；缺它会抛 "AbortSignal.timeout is not a function" → 连接循环无限重试。
  // 在 dist/index.html 注入 polyfill，先于一切 bundle 执行（幂等，带标记）。
  const idx = join(DSH_DIR, 'apps/web/dist/index.html');
  if (existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    if (!html.includes('dsh-timeout-shim')) {
      const shim = '<script id="dsh-timeout-shim">if(!AbortSignal.timeout)AbortSignal.timeout=(ms)=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException(\'TimeoutError\',\'TimeoutError\')),ms);return c.signal;};</script>';
      html = html.replace('<head>', '<head>' + shim);
      writeFileSync(idx, html);
      log('index.html AbortSignal.timeout shim injected');
    } else log('index.html shim already present');
  } else log('dist index.html not found, skip shim');
} catch (e) { log('WARN index shim: ' + e.message); }
const PATCH = join(HOME, 'patch-koffi.yml');
try {
  // v2: 零禁用 —— stub 已让 koffi/node-pty 可加载，插件正常注册服务，避免消费者 pending。
  writeFileSync(PATCH, '# native stubs in place, no disables\n');
  log('patch ok (empty)');
} catch (e) { log('WARN patch: ' + e.message); }
// 插件装配：dsh 保持官方原版，扩展一律走插件层（内置插件 + 路由预设）。
try {
  wireAll();
} catch (e) { log('WARN wireAll: ' + e.message); }
// 启动 dsh web：优先构建产物 lib/bin.js（tsc/tsdown 构建后存在），否则用 Node 22.19+
// 原生 TS 运行 src/bin.ts。web 是 --profile web 的别名，首次运行会自动初始化 profile。
const cliBin = existsSync(join(DSH_DIR, 'apps/cli/lib/bin.js')) ? join(DSH_DIR, 'apps/cli/lib/bin.js') : join(DSH_DIR, 'apps/cli/src/bin.ts');
log('cli entry: ' + cliBin);
const web = spawnSync('/system/bin/sh', ['-c', 'cd ' + DSH_DIR + ' && nohup ' + NODE + '/bin/node --expose-internals ' + cliBin + ' web > ' + join(HOME, 'dsh-web.log') + ' 2>&1 & echo PID=$!'], { env, encoding: 'utf8', timeout: 30000 });
log('web: ' + ((web.stdout || '').trim() || 'status=' + web.status));
log('=== fixup done ===');