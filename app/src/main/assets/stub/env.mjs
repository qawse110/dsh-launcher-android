/**
 * stub/env.mjs — stub-dsh 补丁链路的**共享运行环境**：路径常量、日志、
 * 包定位工具（npm 扁平布局 / pnpm .pnpm 布局 / 嵌套布局）。
 *
 * 由 stub-dsh.mjs 拆出。这里只放**无补丁语义**的基础件：所有补丁块共用它们，
 * 但谁知道自己在修什么由各 patchers/*.mjs 负责。
 */
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOME = process.env.HOME || '/data/user/0/com.dsh.nextapp1/files';
// 已删除（无用代码清理）：NODE / PROFILE 两个常量定义了却**从无任何使用点**——
// 它们是拆分前 stub-dsh.mjs 的遗留（那一版自己起进程、自己读写 profile；
// 现在起进程与装配都归 install-dsh.mjs，stub 只改宿主包源码，两者都用不到）。
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const NODE_MODULES = join(DSH_PREFIX, 'node_modules');
const PNPM_DIR = join(NODE_MODULES, '.pnpm');
// 内置插件（全部来自 extra-plugins 同步，含 dsh-status-bridge / dsh-vision 等）
// 安装在 files/plugins/ 下，**不在** dsh-prefix/node_modules 里。
// （prebuilt.tgz 供给链已于 e3cf666 移除；dsh-vision 等三项现已随 assets 分发。）
// 历史实现只扫 node_modules，导致这些插件的源码问题完全不在修补范围内——
// 真机事故：codebuddy 修好后 dsh-vision 又炸，同类错误换了个插件。
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR || join(HOME, 'plugins');
const pkgCache = new Map();
let pnpmEntries = null;
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

function log(m) {
  const l = `${new Date().toISOString()} [stub] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { if (process.env.DSH_SHARED_LOG === '1') writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

/** 缓存 .pnpm 目录列表，避免几十次 findPkg 反复 readdirSync 同一个大目录。 */
function getPnpmEntries() {
  if (pnpmEntries !== null) return pnpmEntries;
  try {
    pnpmEntries = readdirSync(PNPM_DIR);
  } catch {
    pnpmEntries = [];
  }
  return pnpmEntries;
}

/** 在 npm 扁平布局或 pnpm .pnpm 布局下定位包内相对路径（带缓存）。 */
function findPkg(pkgName, rel) {
  const key = pkgName + '\u0000' + rel;
  if (pkgCache.has(key)) return pkgCache.get(key);
  const found = findPkgUncached(pkgName, rel);
  pkgCache.set(key, found);
  return found;
}

function findPkgUncached(pkgName, rel) {
  // pnpm v10: node_modules/.pnpm/<name>@<hash>/node_modules/<pkg>/<rel>
  if (existsSync(PNPM_DIR)) {
    const prefix = pkgName.replace('/', '+') + '@';
    for (const d of getPnpmEntries()) {
      if (!d.startsWith(prefix)) continue;
      const p = join(PNPM_DIR, d, 'node_modules', pkgName, rel);
      if (existsSync(p)) return p;
    }
  }
  // npm 扁平布局
  const flat = join(NODE_MODULES, pkgName, rel);
  if (existsSync(flat)) return flat;
  // 依赖可能被嵌套安装（如 @deepseek-ai/dsh-subprocess-local/node_modules/node-pty）
  return findNestedPkg(pkgName, rel);
}

/** 递归查找嵌套 node_modules 中的包（pnpm 之外的 npm 嵌套布局）。 */
function findNestedPkg(pkgName, rel) {
  const found = [];
  function walk(dir, depth) {
    if (depth > 8 || found.length > 0) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules') {
        const candidate = join(full, pkgName, rel);
        if (existsSync(candidate)) { found.push(candidate); return; }
      }
      walk(full, depth + 1);
    }
  }
  walk(NODE_MODULES, 0);
  return found[0] || null;
}

/**
 * 枚举 files/plugins/<dir> 下每个内置插件的入口文件。
 *
 * 为什么需要：内置插件（dsh-vision / dsh-provider-headers 等由 assets 同步，dsh-status-bridge 等
 * 来自 extra-plugins 同步）都装在 files/plugins/ 下，而 [findPkg] 只扫
 * dsh-prefix/node_modules —— 这些插件的源码补丁长期不在覆盖范围内，
 * 真机表现为「同类错误换一个插件继续炸」（codebuddy 修好后 dsh-vision 又炸）。
 *
 * @returns [{ name, file }]，name 为插件目录名，file 为主要入口（package.json 的
 *   exports/main 首选项，退化到 lib/index.js）。
 */
function eachPluginEntry() {
  const out = [];
  let dirs;
  try { dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const root = join(PLUGINS_DIR, d.name);
    let entry = null;
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const cand = pkg?.exports?.['.']?.default
        ?? (typeof pkg?.exports === 'string' ? pkg.exports : undefined)
        ?? pkg?.main
        ?? 'lib/index.js';
      entry = join(root, typeof cand === 'string' ? cand : 'lib/index.js');
    } catch {
      entry = join(root, 'lib/index.js');
    }
    if (existsSync(entry)) out.push({ name: d.name, file: entry });
  }
  return out;
}

/**
 * 枚举内置插件的 **client 端**文件（files/plugins/<dir>/lib/client.js）。
 *
 * 为什么单独处理：client 端由浏览器侧 `window.__ModuleLoader__.load({ factory: (require) => … })`
 * 加载，其 `require(spec)` 走 client-modules 的**模块表**（种子词 → 已加载 → 已注册工厂），
 * 与 Node 侧解析完全无关 —— 所以 host 端插件树能加载，UI 仍可能报
 * 「Failed to load plugins」。两边必须分别审计。
 */
function eachPluginClientFile() {
  const out = [];
  let dirs;
  try { dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const f = join(PLUGINS_DIR, d.name, 'lib', 'client.js');
    if (existsSync(f)) out.push({ name: d.name, file: f });
  }
  return out;
}

// 只导出**跨模块实际被 import 的**符号（其余是本模块内部实现细节）。
// 此前把 16 个符号全列出来，其中 11 个无人 import（NODE/PROFILE 连内部都不用），
// 空导出面会误导读者以为它们是公共 API，也让「谁在用」无从判断。
export {
  HOME,
  log, findPkg,
  eachPluginEntry, eachPluginClientFile,
};
