import { spawnSync } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync, lstatSync, readlinkSync, mkdirSync, copyFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
const NODE = '/data/user/0/com.dsh.launcher/files/node';
const HOME = '/data/user/0/com.dsh.launcher/files';
const DSH_DIR = join(HOME, 'deepseek-harness-master');
const OUT = join(HOME, 'install_log.txt'); // 私有目录（无需存储权限）；共享目录尽力而为
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';
function log(m) { const l = `${new Date().toISOString()} ${m}`; console.log(l); try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {} try { writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {} }
const env = { ...process.env, LD_LIBRARY_PATH: join(NODE, 'lib'), HOME, TMPDIR: join(HOME, 'tmp'), TMP: join(HOME, 'tmp'), TEMP: join(HOME, 'tmp'), OPENSSL_CONF: '/dev/null', PATH: [join(NODE, 'bin'), '/system/bin', '/bin'].join(':') };
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
// 插件装配：dsh 保持官方原版，扩展一律走插件层。
// dsh-mobile-nav（移动端适配，third_party 旁挂）→ 设备 plugins 链接 +
// profiles/node_modules 链接（裸名解析）+ web profile 的 cordis.patch.yml 行。
// 全部幂等：已装配时跳过。
try {
  const pluginSrc = join(DSH_DIR, 'third_party/dsh-mobile-nav');
  if (existsSync(pluginSrc)) {
    const pluginLink = join(HOME, 'plugins/dsh-mobile-nav');
    mkdirSync(join(HOME, 'plugins'), { recursive: true });
    try { if (!existsSync(pluginLink)) symlinkSync(pluginSrc, pluginLink, 'dir'); } catch (e) { log('WARN plugin link: ' + e.message); }
    // 裸名导入的实际解析路径：include 模块沿父目录上溯到 DSH_DIR/node_modules
    // （v0.2.0 验证过的生效机制）。profiles/node_modules 链接对 profile 内包生效，也一并维护。
    const installNm = join(DSH_DIR, 'node_modules/@dsh-external');
    mkdirSync(installNm, { recursive: true });
    const installLink = join(installNm, 'dsh-mobile-nav');
    try { if (!existsSync(installLink)) symlinkSync(pluginSrc, installLink, 'dir'); } catch (e) { log('WARN install nm link: ' + e.message); }
    const profilesNm = join(HOME, '.dsh/profiles/node_modules');
    const nmScope = join(profilesNm, '@dsh-external');
    mkdirSync(nmScope, { recursive: true });
    const nmLink = join(nmScope, 'dsh-mobile-nav');
    try { if (!existsSync(nmLink)) symlinkSync(pluginLink, nmLink, 'dir'); } catch (e) { log('WARN profiles/nm link: ' + e.message); }
    const profilePatch = join(HOME, '.dsh/profiles/web/cordis.patch.yml');
    if (existsSync(profilePatch)) {
      let text = readFileSync(profilePatch, 'utf8');
      // BOM 会让部分 YAML 加载器把首行当键名/报错；装配入口统一剥掉并重写。
      const stripped = text.replace(/^\uFEFF/, '');
      // 旧格式（顶层 - id: …，无 insert 包装）不会插入行（target 不存在被跳过），
      // 检测到就剥掉重写。正确格式与 bundle 层一致：- insert: 块。
      const OLD_ROW = /\n?- id: dsh-mobile-nav\n\s+name: '[^']*'\n?/;
      const INSERT_ROW = "- insert:\n    - id: dsh-mobile-nav\n      name: '@dsh-external/dsh-mobile-nav'\n";
      const hasInsert = stripped.includes('- insert:\n    - id: dsh-mobile-nav');
      if (!hasInsert) {
        let clean = stripped.replace(OLD_ROW, '').trimEnd();
        // 剥掉流式数组括号（[] 或残留的坏 ]），把 insert 块追加到末尾。
        const base = clean.endsWith(']') ? clean.slice(0, -1).trimEnd() : clean;
        const arr = base.endsWith('[') ? base.slice(0, -1) : base;
        writeFileSync(profilePatch, arr.trimEnd() + '\n' + INSERT_ROW);
        log('plugin wiring ok: dsh-mobile-nav insert into web profile patch');
      } else if (stripped !== text) {
        writeFileSync(profilePatch, stripped);
        log('plugin patch BOM stripped');
      } else {
        log('plugin already wired');
      }
    } else {
      log('WARN profile patch missing, skip wiring');
    }
  } else {
    log('plugin source missing, skip wiring');
  }
} catch (e) { log('WARN plugin wiring: ' + e.message); }
// 启动 dsh web：优先构建产物 lib/bin.js（tsc/tsdown 构建后存在），否则用 Node 22.19+
// 原生 TS 运行 src/bin.ts。web 是 --profile web 的别名，首次运行会自动初始化 profile。
const cliBin = existsSync(join(DSH_DIR, 'apps/cli/lib/bin.js')) ? join(DSH_DIR, 'apps/cli/lib/bin.js') : join(DSH_DIR, 'apps/cli/src/bin.ts');
log('cli entry: ' + cliBin);
const web = spawnSync('/system/bin/sh', ['-c', 'cd ' + DSH_DIR + ' && nohup ' + NODE + '/bin/node --expose-internals ' + cliBin + ' web > ' + join(HOME, 'dsh-web.log') + ' 2>&1 & echo PID=$!'], { env, encoding: 'utf8', timeout: 30000 });
log('web: ' + ((web.stdout || '').trim() || 'status=' + web.status));
log('=== fixup done ===');