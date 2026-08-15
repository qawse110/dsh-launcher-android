import { spawnSync } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const NODE = '/data/user/0/com.dsh.launcher/files/node';
const HOME = '/data/user/0/com.dsh.launcher/files';
const DSH_DIR = join(HOME, 'deepseek-harness-master');
const OUT = '/sdcard/Download/DshLauncher/install_log.txt';
function log(m) { const l = `${new Date().toISOString()} ${m}`; console.log(l); try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {} }
const env = { ...process.env, LD_LIBRARY_PATH: join(NODE, 'lib'), HOME, TMPDIR: join(HOME, 'tmp'), TMP: join(HOME, 'tmp'), TEMP: join(HOME, 'tmp'), OPENSSL_CONF: '/dev/null', PATH: [join(NODE, 'bin'), '/system/bin', '/bin'].join(':') };
const KSTUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsc2l6ZW9mOigpPT4wLGFsaWdub2Y6KCk9PjAsb2Zmc2V0b2Y6KCk9PjAsZnVuY3Rpb246KCk9PnAsc3RydWN0OigpPT5wLHVuaW9uOigpPT5wLGVudW06KCk9PnAsdHlwZWRlZjooKT0+cCxwb2ludGVyOigpPT5wLHJlZ2lzdGVyOigpPT5wLEtvZmZpRXJyb3I6Y2xhc3MgZXh0ZW5kcyBFcnJvcnt9fTtleHBvcnQgZGVmYXVsdCBrb2ZmaTs=';
const SHARP_STUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO21vZHVsZS5leHBvcnRzPXA7bW9kdWxlLmV4cG9ydHMuZGVmYXVsdD1wOw==';
const PSTUB = 'Y29uc3R7RXZlbnRFbWl0dGVyfT1yZXF1aXJlKCdldmVudHMnKTtjbGFzcyBGIGV4dGVuZHMgRXZlbnRFbWl0dGVye2NvbnN0cnVjdG9yKCl7c3VwZXIoKTt0aGlzLnBpZD0wO3RoaXMuZXhpdENvZGU9MH13cml0ZSgpe31raWxsKCl7fXJlc2l6ZSgpe31jbGVhcigpe31jbG9zZSgpe31vbkV4aXQoYyl7aWYoYyljKHtleGl0Q29kZTowLHNpZ25hbDp1bmRlZmluZWR9KX19bW9kdWxlLmV4cG9ydHM9e3NwYXduKCl7Y29uc3QgeD1uZXcgRigpO3Byb2Nlc3MubmV4dFRpY2soKCk9PnguZW1pdCgnZXhpdCcse2V4aXRDb2RlOjAsc2lnbmFsOnVuZGVmaW5lZH0pKTtyZXR1cm4geH0sZm9yaygpe3JldHVybiBuZXcgRigpfSxvcGVuKCl7cmV0dXJue21hc3RlcjpuZXcgRigpLHNsYXZlOm5ldyBGKCl9fX07';
try {
  writeFileSync(join(DSH_DIR, 'node_modules/.pnpm/koffi@3.1.1/node_modules/koffi/index.js'), Buffer.from(KSTUB, 'base64'));
  writeFileSync(join(DSH_DIR, 'node_modules/.pnpm/node-pty@1.1.0_patch_hash=7a0c04f1f49d798a9ffe2f7f414c01064a44ca2489772d0c3e1235ab336755e6/node_modules/node-pty/lib/index.js'), Buffer.from(PSTUB, 'base64'));
  log('stubs ok');
} catch (e) { log('WARN stub: ' + e.message); }
// sharp stub：无 android-arm64 运行时，用万能 Proxy 顶替
try {
  const base = join(DSH_DIR, 'node_modules/.pnpm');
  for (const d of readdirSync(base)) {
    if (d.startsWith('sharp@')) {
      const sp = join(base, d, 'node_modules/sharp/lib/index.js');
      if (existsSync(sp)) { writeFileSync(sp, Buffer.from(SHARP_STUB, 'base64')); log('sharp stub ok: ' + d); }
    }
  }
} catch (e) { log('WARN sharp: ' + e.message); }
const PATCH = join(HOME, 'patch-koffi.yml');
try {
  // v2: 零禁用 —— stub 已让 koffi/node-pty 可加载，插件正常注册服务，避免消费者 pending。
  writeFileSync(PATCH, '# native stubs in place, no disables\n');
  log('patch ok (empty)');
} catch (e) { log('WARN patch: ' + e.message); }
const web = spawnSync('/system/bin/sh', ['-c', 'cd ' + DSH_DIR + ' && nohup ' + NODE + '/bin/node apps/cli/lib/bin.js web > /sdcard/Download/DshLauncher/dsh-web.log 2>&1 & echo PID=$!'], { env, encoding: 'utf8', timeout: 30000 });
log('web: ' + ((web.stdout || '').trim() || 'status=' + web.status));
log('=== fixup done ===');