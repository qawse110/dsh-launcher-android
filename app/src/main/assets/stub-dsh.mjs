#!/usr/bin/env node
/**
 * stub-dsh.mjs — Android 兼容性修复（dsh 官方 npm 安装版）。
 *
 * 旧版同时负责“插件装配 + 启动 web”；新版 dsh 本体与插件都改用官方
 * npm / `dsh plugin` 安装，这里只保留 Android 特有修复。
 *
 * 原则：**只修 Node/原生模块加载期与 WebView 引导期的问题**——凡是能在
 * Cordis 插件运行时实现的功能一律下沉为独立内置插件（见
 * docs/plugin-conversion-audit.md），避免每次 dsh 升级都要重新对表补锚点。
 *
 * 现存修复：
 *   1) koffi / node-pty / sharp：Android 无预编译产物，用 Proxy stub / 纯 JS
 *      shim 顶替（模块 import 期，插件通道无法介入）；
 *   2) @deepseek-ai/dsh-attachment-local 视觉链路 v4：SELinux 禁 link(2)、FUSE
 *      上 fsync 失败的运行时行为修复（fs 兼容层不覆盖 CJS 盲区，只能改源）；
 *   3) @deepseek-ai/dsh-llm-pi-ai sendAttribution：dsh-provider-headers 内置
 *      插件的「关闭归因 UA」依赖该 schema 字段，上游明确注释
 *      “omission cannot suppress attribution”，在官方提供抑制缝隙前保留；
 *   4) sandbox-windows-acl 的 koffi 布局断言禁用（防御性，koffi 已被顶替）；
 *   5) WebView/旧 Chrome AbortSignal.timeout polyfill——仅当前端产物确实引用
 *      该 API 时才注入（rc.2 前端与全部内置插件 client 均无引用，自动跳过，
 *      不再无条件改写 dist/index.html；引导期早于 app bundle，插件无法替代）；
 *   6) @vscode/ripgrep 解析器 Android 回退（import 期解析，优先 Termux 原生 rg）；
 *   7) dsh-fs-local chmod 对 FUSE 的 EACCES/EPERM 容错（原子写内部路径，
 *      无插件缝隙）。
 *
 * 已移除（详见审计文档）：
 *   - apiproxy WEB_SETTINGS_NAMESPACES += vision（上游已无该常量，
 *     dsh-vision 改经 settings 服务自行注册命名空间）；
 *   - dsh-sandbox/-local "/tmp"→TMPDIR（上游 writableRoots 已原生并入
 *     os.tmpdir()，启动器导出 TMPDIR 即可）；
 *   - directory-picker-browse SD Card 条目（由内置插件
 *     @dsh-external/dsh-android-links 以 HOME 符号链接实现）。
 *
 * 环境变量：
 *   HOME / NODE_DIR / DSH_PREFIX / DSH_PROFILE
 *   DSH_PATCH_DIR（补丁载荷目录，缺省 $HOME/patched）
 *
 * ## 补丁载荷与幂等（review-r5，参考 dsh-mobile-apk 的 applyAssetPatch 机制）
 *
 * 1) **载荷外置**：koffi/node-pty/sharp 的替身与 sharp shim 从本文件内嵌 base64
 *    改为 `assets/patched/` 真实文件（由 DshFlow 同步到 `$HOME/patched/`）。
 *    内嵌 blob 既不可评审也不可被静态检查；外置后可 diff、可审，并纳入
 *    `tools/check-asset-scripts.cjs` 的 CI 语法门禁。
 * 2) **内容比对幂等**：覆盖式补丁（koffi/node-pty/sharp/ripgrep）按载荷与目标
 *    内容逐字节比对决定是否重写，不再依赖版本 marker——参考实现记录过
 *    「marker 字符串不变 → 载荷更新后补丁被静默跳过」的 v1→v2 资产更新事故。
 * 3) **不落半补丁**：改源类补丁（attachment-local / fs-local / llm-pi-ai）在写盘前
 *    做锚点计数 + `node --check` 语法自检，任一失配即不写盘并告警，
 *    避免「半补丁文件毒化 dsh 启动」（历史事故）。
 */
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.HOME || '/data/user/0/com.dsh.launcher/files';
const NODE = process.env.NODE_DIR || join(HOME, 'node');
const DSH_PREFIX = process.env.DSH_PREFIX || join(HOME, 'dsh-prefix');
const PROFILE = process.env.DSH_PROFILE || 'web';
const NODE_MODULES = join(DSH_PREFIX, 'node_modules');
const PNPM_DIR = join(NODE_MODULES, '.pnpm');
const pkgCache = new Map();
let pnpmEntries = null;
const OUT = join(HOME, 'install_log.txt');
const OUT_SHARED = '/sdcard/Download/DshLauncher/install_log.txt';

/**
 * 补丁载荷目录（由 DshFlow 从 APK assets/patched/ 同步到 files/patched/）。
 *
 * review-r5：载荷此前以 base64 常量内嵌在本文件里（6 处、约 13KB 不可读 blob），
 * 既不可评审也无法被静态检查。现改为独立真实文件（对齐参考实现
 * dsh-mobile-apk 的 assets/patched + applyAssetPatch 机制）：
 * 载荷可 diff、可被 CI 语法门禁扫描，改内容即改文件。
 */
const PATCH_DIR = process.env.DSH_PATCH_DIR || join(HOME, 'patched');

/** 读取补丁载荷；缺失返回 null（调用方按「跳过该补丁」处理并记日志）。 */
function readPatch(name) {
  try {
    const buf = readFileSync(join(PATCH_DIR, name));
    return buf.length > 0 ? buf : null;
  } catch (e) {
    log(`WARN patch payload missing: ${name} (${e.message})`);
    return null;
  }
}

/**
 * 覆盖式补丁：目标内容与载荷逐字节比对，相同即跳过。
 *
 * review-r5：改用**内容比对**而非固定 marker 字符串判定幂等，对齐参考实现
 * applyAssetPatch 的教训（其注释记录：marker 字符串不变导致载荷更新后补丁被
 * 静默跳过 —— v1→v2 资产更新失效事故）。内容比对天然满足「载荷变即重贴」，
 * 且无需在目标文件里留标记。
 *
 * @returns true=已写入/更新，false=内容已一致或载荷缺失
 */
function overlayPatch(patchName, targetPath, label) {
  if (!targetPath) return false;
  const payload = readPatch(patchName);
  if (!payload) return false;
  try {
    if (existsSync(targetPath)) {
      const cur = readFileSync(targetPath);
      if (cur.length === payload.length && cur.equals(payload)) {
        log(`${label}: already up-to-date (content match)`);
        return false;
      }
    }
    writeFileSync(targetPath, payload);
    log(`${label}: patch applied/updated -> ${targetPath}`);
    return true;
  } catch (e) {
    log(`WARN ${label}: ${e.message}`);
    return false;
  }
}

/** target 是否为目录（用于 koffi 的 lib/ 布局回退定位）。 */
function isDir(p) {
  try { return readdirSync(p) !== undefined && existsSync(p) && !p.endsWith('.js'); } catch { return false; }
}

function log(m) {
  const l = `${new Date().toISOString()} [stub] ${m}`;
  console.log(l);
  try { writeFileSync(OUT, l + '\n', { flag: 'a' }); } catch {}
  try { if (process.env.DSH_SHARED_LOG === '1') writeFileSync(OUT_SHARED, l + '\n', { flag: 'a' }); } catch {}
}

/**
 * 写盘前语法自检：把内容落到临时文件交给 `node --check`。
 * 补丁写坏一个上游文件会直接拖死 dsh 启动（历史事故），因此所有改写上游源码的
 * 分支都应在 writeFileSync 之前过这一关；spawnSync 不可用时保守放行
 * （假定内容可用，由后续启动暴露问题，好过误判成损坏而漏打补丁）。
 */
function syntaxOk(content) {
  const tmp = join(HOME, '.stub-syntax-check.mjs');
  try {
    writeFileSync(tmp, content);
    const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return true;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
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

/* review-r5：koffi/node-pty/sharp 的替身载荷已抽到 assets/patched/ 真实文件
 * （koffi-stub.mjs|cjs、node-pty-stub.cjs、sharp-shim.cjs）。旧版把 4 个载荷
 * base64 内嵌在此处（约 13KB 不可读 blob），且 SHARP_STUB/SHARP_STUB_ESM 两个常量
 * 自 v4 视觉链路改纯 JS shim 后已无消费者（死代码），一并移除。载荷改真实文件后
 * 可 diff、可评审，并纳入 CI 语法门禁（此前 base64 内容对静态检查完全不可见）。 */

try {
  const ke = findPkg('koffi', 'index.js');
  const kc = findPkg('koffi', 'index.cjs');
  if (ke) overlayPatch('koffi-stub.mjs', ke, 'koffi ESM stub');
  if (kc) overlayPatch('koffi-stub.cjs', kc, 'koffi CJS stub');
  if (!ke && !kc) log('koffi: not found, skip');
} catch (e) { log('WARN koffi: ' + e.message); }

try {
  const p = findPkg('node-pty', 'lib/index.js');
  if (p) overlayPatch('node-pty-stub.cjs', p, 'node-pty stub');
  else log('node-pty: not found, skip');
} catch (e) { log('WARN node-pty: ' + e.message); }

try {
  /* Android 无 libvips：写入纯 JS 兼容层 _dshshim.cjs（PNG 全解码 + 头部探测），
     各入口改为重定向；替代旧 Proxy 桩（旧桩让所有图片判 INVALID_IMAGE 且
     await 永不结算）。实现与视觉链路修复配套。
     载荷 = assets/patched/sharp-shim.cjs（review-r5 由 base64 内嵌改为真实文件）。 */
  const shim = readPatch('sharp-shim.cjs');
  if (!shim) {
    log('WARN sharp shim payload missing, skip sharp patch');
  } else {
    const targets = [
      ['sharp', 'dist/index.cjs', './_dshshim.cjs'],
      ['sharp', 'dist/index.mjs', './_dshshim.cjs'],
      ['sharp', 'dist/sharp.cjs', './_dshshim.cjs'],
      ['sharp', 'dist/sharp.mjs', './_dshshim.cjs'],
      ['sharp', 'lib/index.js', '../dist/_dshshim.cjs'],
      ['sharp', 'index.js', './dist/_dshshim.cjs'],
    ];
    const writtenShims = [];
    let n = 0;
    for (const [pkg, rel, req] of targets) {
      const p = findPkg(pkg, rel);
      if (!p) continue;
      const rootDir = p.slice(0, p.length - rel.length - 1);
      const shimAbs = join(rootDir, 'dist', '_dshshim.cjs');
      if (!writtenShims.includes(shimAbs)) {
        // 内容比对幂等：shim 载荷变更时自动重写（无需版本 marker）
        let same = false;
        try {
          const cur = readFileSync(shimAbs);
          same = cur.length === shim.length && cur.equals(shim);
        } catch {}
        if (!same) writeFileSync(shimAbs, shim);
        writtenShims.push(shimAbs);
      }
      const payload = rel.endsWith('.mjs')
        ? 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);const s=require(' + JSON.stringify(req) + ');export default s;export const versions=s.versions;export const format=s.format;'
        : 'module.exports=require(' + JSON.stringify(req) + ');module.exports.default=module.exports;';
      writeFileSync(p, payload);
      log('sharp shim ok: ' + p);
      n++;
    }
    if (n === 0) log('sharp: not found, skip');
  }
} catch (e) { log('WARN sharp shim: ' + e.message); }



  /* v4 视觉链路配套（dsh-launcher-android-att-vision-v4），在 v3 基础上加两道保险：
     1) syncDirectory 改用「函数签名 + 花括号配平」定位完整函数体，不再依赖后继注释锚点，
        对任何上游结构（干净 / v2 残缺 / v3 已改）都能精确切出整个函数；
     2) 写入前先用 node --check 校验临时文件语法，校验失败则放弃写盘（防止再毒化）。
     v4 同时自愈 v2 遗留的孤儿 finally / 孤儿 publishCopied 调用。 */
  try {
    const attLocal = findPkg('@deepseek-ai/dsh-attachment-local', 'lib/index.js');
    if (!attLocal) {
      log('attachment-local: not found, skip vision patch');
    } else if (readFileSync(attLocal, 'utf8').includes('dsh-launcher-android-att-vision-v4')) {
      log('attachment-local vision patch already applied');
    } else {
      let src = readFileSync(attLocal, 'utf8');

      /* 自愈前置：若当前文件本身语法已损坏（v2/v3 毒化），先尝试用括号配平
         重建 syncDirectory 区域，再继续标准补丁；重建失败则放弃写盘并提示。 */
      const checkCurrent = (function () {
        const tmp2 = attLocal + '.v4cur.mjs';
        try {
          writeFileSync(tmp2, src);
          const r2 = spawnSync(process.execPath, ['--check', tmp2], { timeout: 15000, encoding: 'utf8' });
          return r2.status === 0;
        } catch (e) {
          return true; /* spawnSync 不可用时假定当前文件可用，走标准流程 */
        } finally {
          try { unlinkSync(tmp2); } catch {}
        }
      })();
      if (!checkCurrent) log('attachment-local v4: current file syntax broken, attempting repair');

      /* 用括号配平定位 syncDirectory 完整函数体：从函数签名起，逐字符累计 { }，
         深度归零时即函数结束。兼容体内任意注释/嵌套，不依赖后继锚点。 */
      const SYNC_START = 'async function syncDirectory(path) {';
      let si = src.indexOf(SYNC_START);
      let se = -1;
      if (si !== -1) {
        let depth = 0;
        for (let i = si; i < src.length; i++) {
          const c = src[i];
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { se = i + 1; break; } }
        }
      }
      const seg = si !== -1 && se > si ? src.slice(si, se) : '';
      if (seg && seg.length <= 4096 && seg.includes('handle')) {
        src = src.slice(0, si) + [
          'async function syncDirectory(path) {',
          '\tif (process.platform === "win32") return;',
          '\tlet handle;',
          '\ttry {',
          '\t\thandle = await open(path, constants.O_RDONLY);',
          '\t} catch (error) {',
          '\t\tif (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT" || error.code === "ENOTDIR")) return;',
          '\t\tthrow error;',
          '\t}',
          '\ttry { await handle.sync(); } catch (error) { await handle.close().catch(() => {}); if (process.platform === "android") return; throw error; }',
          '\tawait handle.close().catch(() => {});',
          '}'
        ].join('\n') + '\n' + src.slice(se);
      } else {
        log('WARN vision patch v4: syncDirectory segment not located, leave as-is');
      }

      /* 清理 v2 毒化残留：syncDirectory 之后可能残留孤立的 `} finally { ... }` 块
         （v2 正则替换半个函数留下的），它们会造成语法错误。用非贪婪正则删除
         syncDirectory 结尾 } 之后、下一个 /** 注释之前的孤儿 finally 块。 */
      const orphanRe = /\n[ \t]*finally \{[\s\S]*?\n\t\}(?=\n[ \t]*\/\* v8 ignore|\n[ \t]*\/\*\*|\n[ \t]*\/\/)/;
      const orphanMatch = orphanRe.exec(src);
      if (orphanMatch) {
        log('attachment-local v4: removing orphan finally block: ' + JSON.stringify(orphanMatch[0].slice(0, 60)));
        src = src.replace(orphanRe, '');
      }
      /* v2 毒化的另一半残留：孤儿 finally 之后的 v8-ignore-stop 注释 + 孤儿 }，
         它们会让后续函数（ensureDurableHome）的括号失衡。同样在下一个 /** 前删除。 */
      const orphanCloseRe = /\n[ \t]*\/\* v8 ignore stop \*\/\n[ \t]*\}(?=\n[ \t]*\/\*\*)/;
      const orphanClose = orphanCloseRe.exec(src);
      if (orphanClose) {
        log('attachment-local v4: removing orphan close brace: ' + JSON.stringify(orphanClose[0].slice(0, 60)));
        src = src.replace(orphanCloseRe, '');
      }

      /* link 发布回退：SELinux 拒绝应用 uid 的 link(2)、sdcard FUSE 不支持硬链接。
         helper 与调用点成对落地，标记写在 helper 头部（保证与文件共存亡）。
         兼容 v2 毒化残留：调用点已被改写为 publishCopied 但定义从未插入时，
         先还原调用点，再按标准流程安装。 */
      if (!src.includes('async function publishCopied(temporary, target, sha256)')) {
        const v2Call = 'await publishCopied(temporary, target, sha256);';
        const defAnchor = '/**\n* Publish one already verified normalized image';
        const di = src.indexOf(defAnchor);
        if (src.includes(v2Call)) {
          src = src.replace(v2Call, 'await link(temporary, target);');
          log('vision patch v3: restored v2-orphaned publishCopied call');
        }
        const ci = src.indexOf('await link(temporary, target);');
        if (di === -1 || ci === -1 || ci < di) {
          /* 锚点缺失或顺序异常（上游结构变化）：宁可跳过也不误插 */
          log('WARN vision patch v3: link anchors unusable (call=' + (ci !== -1) + ',def=' + (di !== -1) + ')');
        } else {
          const helper = [
            '/** dsh-launcher-android-att-vision-v4: link 优先；SELinux/FUSE 环境回退 copy，',
            '* 复制中途失败清理半写 target 防止内容寻址路径被毒化。 */',
            'async function publishCopied(temporary, target, sha256) {',
            '\ttry {',
            '\t\tawait link(temporary, target);',
            '\t\treturn;',
            '\t} catch (linkError) {',
            '\t\tconst code = linkError instanceof Error && "code" in linkError ? linkError.code : void 0;',
            '\t\tif (code === "EEXIST") {',
            '\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
            '\t\t\treturn;',
            '\t\t}',
            '\t\tif (!(code === "EACCES" || code === "EPERM" || code === "ENOSYS" || code === "EXDEV")) throw linkError;',
            '\t\ttry { await copyFile(temporary, target); } catch (copyError) {',
            '\t\t\tawait unlink(target).catch(() => {});',
            '\t\t\tthrow copyError;',
            '\t\t}',
            '\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) {',
            '\t\t\tawait unlink(target).catch(() => {});',
            '\t\t\tthrow new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
            '\t\t}',
            '\t}',
            '}'
          ].join('\n');
          /* 上游未导入 copyFile，回退分支需要；锚定 fs/promises 导入语句精确追加 */
          if (!src.includes('copyFile')) {
            const impA = '} from "node:fs/promises";';
            if (src.includes(impA)) src = src.replace(impA, ', copyFile' + impA);
            else log('WARN vision patch v4: fs/promises import anchor miss');
          }
          /* 先改写调用点、后插入 helper（用字符串替换，不用索引切片，避免索引错位）：
             helper 内部同样含 await link 字面量，先插后换会把 helper 自身改写成递归调用。 */
          const patched = src.replace('await link(temporary, target);', 'await publishCopied(temporary, target, sha256);');
          if (patched === src) {
            log('WARN vision patch v4: link call rewrite miss');
          } else {
            src = patched;
            src = src.replace(defAnchor, helper + '\n' + defAnchor);
            log('vision patch v4: publishCopied installed');
          }
        }
      }

      /* 写入前语法自检：写临时文件 + node --check，失败则放弃写盘（防止再毒化）。
         ESM 文件 node --check 会校验语法；若 spawnSync 不可用则降级为括号配平检查。 */
      const tmpPath = attLocal + '.v4check.mjs';
      let syntaxOk = false;
      try {
        writeFileSync(tmpPath, src);
        const r = spawnSync(process.execPath, ['--check', tmpPath], { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) syntaxOk = true;
        else log('WARN attachment-local v4 syntax check FAILED: ' + (r.stderr || '').slice(0, 300));
      } catch (e) {
        log('WARN attachment-local v4 syntax check unavailable: ' + e.message);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
      if (syntaxOk) {
        /* 若 helper 已存在但标记是旧版本（v2/v3 遗留），升级标记保证幂等短路生效 */
        if (src.includes('att-vision-v3') || src.includes('att-vision-v2') || src.includes('att-vision-v1')) {
          src = src.replace(/att-vision-v[123]/g, 'att-vision-v4');
        }
        writeFileSync(attLocal, src);
        log('attachment-local vision patch v4 applied: ' + attLocal);
      } else {
        log('WARN attachment-local vision patch v4: syntax check failed, file NOT modified: ' + attLocal);
      }
    }
  } catch (e) { log('WARN attachment-local vision: ' + e.message); }

/* apiproxy WEB_SETTINGS_NAMESPACES += vision 补丁已移除（v4.10 审计）：
 * 上游 0.1.x 已无该常量，补丁永远命中 "pattern not found, skip" 死分支；
 * dsh-vision 现通过 @deepseek-ai/dsh-settings 的 settingsNamespace('vision')
 * 直接注册设置命名空间，无需 api 网关白名单。 */

try {
  // dsh-provider-headers: sendAttribution=false 时不再强制注入 deepseek-harness User-Agent
  const pi = findPkg('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js');
  if (pi) {
    let src = readFileSync(pi, 'utf8');
    const marker = 'sendAttribution: z.boolean().default(true)';
    if (!src.includes(marker)) {
      let out = src;
      // 逐步计数：四处改动要么全中要么全不写盘。
      // 原实现只要 out !== src 就写——任一处锚点失配都会落一个半补丁文件：
      // 典型是第 3 处（函数签名）命中而第 4 处（gating 逻辑）失配，结果 schema 接受
      // sendAttribution=false 却没有实际生效代码，UI 开关静默失效（用户以为没归因了）。
      let schema = 0;
      if (/sendAttribution: z\.boolean\(\)\.optional\(\),/.test(out)) {
        out = out.replace(
          /sendAttribution: z\.boolean\(\)\.optional\(\),/,
          'sendAttribution: z.boolean().default(true),'
        );
        schema++;
      } else if (/headers: z\.dict\(z\.string\(\)\),/.test(out)) {
        out = out.replace(
          /headers: z\.dict\(z\.string\(\)\),/,
          'headers: z.dict(z.string()),\n\tsendAttribution: z.boolean().default(true),'
        );
        schema++;
      }
      let sig = 0;
      if (/function requestHeaders\(headers\) \{/.test(out)) {
        out = out.replace(
          /function requestHeaders\(headers\) \{/,
          'function requestHeaders(headers, sendAttribution = true) {'
        );
        sig++;
      }
      // 依赖上一步的产物：签名改了才谈得上插 gating
      let gate = 0;
      if (sig > 0) {
        const gateRe = /function requestHeaders\(headers, sendAttribution = true\) \{\n(\s*)const attribution = attributionHeaders\(\);/;
        if (gateRe.test(out)) {
          out = out.replace(gateRe, (m, indent) => m.replace(
            'const attribution = attributionHeaders();',
            `if (sendAttribution === false) return { ...(headers ?? {}) };\n${indent}const attribution = attributionHeaders();`
          ));
          gate++;
        }
      }
      let call = 0;
      if (/headers: requestHeaders\(profile\.headers\)/.test(out)) {
        out = out.replace(
          /headers: requestHeaders\(profile\.headers\)/,
          'headers: requestHeaders(profile.headers, profile.sendAttribution)'
        );
        call++;
      }
      const complete = schema > 0 && sig > 0 && gate > 0 && call > 0;
      if (!complete) {
        log('llm-pi-ai sendAttribution pattern not found, skip' +
          ` (schema=${schema} sig=${sig} gate=${gate} call=${call}; 未写盘)`);
      } else if (!syntaxOk(out)) {
        // 与 attachment-local 同款：写盘前语法自检，失败不落盘（防止毒化 dsh 启动）
        log('WARN llm-pi-ai sendAttribution: syntax check FAILED, skip');
      } else {
        writeFileSync(pi, out);
        log('llm-pi-ai sendAttribution support patched: ' + pi);
      }
    } else {
      log('llm-pi-ai sendAttribution already patched');
    }
  } else {
    log('llm-pi-ai: not found, skip');
  }
} catch (e) { log('WARN llm-pi-ai sendAttribution: ' + e.message); }

try {
  const w = findPkg('@deepseek-ai/dsh-sandbox-windows-acl', 'lib') || findPkg('@deepseek-ai/dsh-sandbox-windows-acl', 'lib/index.js');
  if (w) {
    const dir = existsSync(w) && w.endsWith('.js') ? dirname(w) : w;
    if (existsSync(dir)) {
      let patched = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const p = join(dir, f);
        const src = readFileSync(p, 'utf8');
        if (!src.includes('layout mismatch')) continue;
        let out = src;
        out = out.replace(/if \(STARTUPINFOW\.size !== 104\) throw new Error\(`STARTUPINFOW layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, STARTUPINFOW assert disabled */');
        out = out.replace(/if \(PROCESS_INFORMATION\.size !== 24\) throw new Error\(`PROCESS_INFORMATION layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, PROCESS_INFORMATION assert disabled */');
        if (out !== src) { writeFileSync(p, out); patched++; }
      }
      log('sandbox-windows-acl asserts disabled: ' + patched);
    }
  } else {
    log('sandbox-windows-acl: not found, skip');
  }
} catch (e) { log('WARN sandbox-windows-acl: ' + e.message); }

try {
  // WebView / Chrome ≤102 无 AbortSignal.timeout。
  // v4.10 起**按需注入**：仅当 dist 内 app bundle 确实引用了该 API 才写
  // index.html；0.1.1-rc.2 前端与全部内置插件 client 均无引用，自动跳过，
  // 不再无条件改写上游产物。必须留在引导期脚本里：polyfill 需要先于
  // /assets/index-*.js 与模块系统条目执行，client 插件通道时序上做不到。
  const idx = findPkg('@deepseek-ai/dsh-web-frontend', 'dist/index.html');
  if (idx && existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    if (html.includes('dsh-timeout-shim')) {
      log('index.html shim already present');
    } else {
      let consumerFound = false;
      try {
        // 递归扫描 assets（含子目录 chunk，布局变化不丢失消费者检测）。
        // 误报无害：shim 自带 `if(!AbortSignal.timeout)` 守卫，已定义时不生效。
        const stack = [join(dirname(idx), 'assets')];
        while (stack.length && !consumerFound) {
          const dir = stack.pop();
          let ents;
          try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const ent of ents) {
            if (ent.isDirectory()) { stack.push(join(dir, ent.name)); continue; }
            if (!ent.name.endsWith('.js')) continue;
            if (readFileSync(join(dir, ent.name), 'utf8').includes('AbortSignal.timeout')) { consumerFound = true; break; }
          }
        }
      } catch (e) {
        /* 资产目录不可读（布局变化）：宁可保守注入，回到旧行为 */
        consumerFound = true;
        log('WARN index shim asset scan failed (' + e.message + '), inject conservatively');
      }
      if (!consumerFound) {
        log('index.html shim skipped: no AbortSignal.timeout consumer in app bundle');
      } else {
        const shim = '<script id="dsh-timeout-shim">if(!AbortSignal.timeout)AbortSignal.timeout=(ms)=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException(\'TimeoutError\',\'TimeoutError\')),ms);return c.signal;};</script>';
        html = html.replace('<head>', '<head>' + shim);
        writeFileSync(idx, html);
        log('index.html AbortSignal.timeout shim injected');
      }
    }
  } else {
    log('dsh-web-frontend dist not found, skip shim');
  }
} catch (e) { log('WARN index shim: ' + e.message); }

try {
  // CodeBuddy 共存 Provider 的编辑布局：settings-models 客户端按命名空间白名单
  // 选择 Provider 编辑器布局（layoutOf：llm-deepseek→deepseek、llm-pi-ai→pi-ai，
  // 其余→unknown）。unknown 布局只渲染“高级提示”且保存按钮永久禁用，卡片无法
  // 填写/保存。dsh-llm-codebuddy 内置插件以独立命名空间 llm-codebuddy 与内置
  // llm-pi-ai 共存（互不抢占 settings 注册），必须让客户端把它按 pi-ai 布局渲染。
  // 必须留在引导期脚本里：layoutOf 是编译产物内的闭包函数，client 插件通道改不到。
  const smClient = findPkg('@deepseek-ai/dsh-client-ui-settings-models', 'lib/client.js');
  if (smClient && existsSync(smClient)) {
    let smSrc = readFileSync(smClient, 'utf8');
    if (smSrc.includes('llm-codebuddy") return "pi-ai"')) {
      log('settings-models codebuddy layout already patched');
    } else if (smSrc.includes('if (ns === "llm-pi-ai") return "pi-ai";')) {
      smSrc = smSrc.replace(
        'if (ns === "llm-pi-ai") return "pi-ai";',
        'if (ns === "llm-pi-ai") return "pi-ai";\n\t\t\tif (ns === "llm-codebuddy") return "pi-ai";'
      );
      writeFileSync(smClient, smSrc);
      log('settings-models codebuddy layout patched (llm-codebuddy -> pi-ai)');
    } else {
      log('WARN settings-models layoutOf pattern not found, skip (dsh 升级后需核对)');
    }
  } else {
    log('settings-models client not found, skip codebuddy layout patch');
  }
} catch (e) { log('WARN codebuddy layout patch: ' + e.message); }

try {
  // @vscode/ripgrep：Android 没有 @vscode/ripgrep-android-arm64 平台包，
  // 导致 dsh-tool-fs-search 的 glob/grep 报 “ripgrep launch failed”。
  // 这里把解析器改为优先使用 Termux `pkg install -y ripgrep` 安装的原生 rg，
  // 缺失时才回退到 linux-arm64 静态二进制（由 install-dsh.mjs 安装到 dsh-prefix/node_modules）。
  const rgMain = findPkg('@vscode/ripgrep', 'lib/index.js');
  if (!rgMain) {
    log('@vscode/ripgrep: not found, skip android fallback');
  } else {
    const termuxRg = existsSync(join(HOME, 'termux/usr/bin/rg')) ? join(HOME, 'termux/usr/bin/rg') : null;
    const fallbackRg = termuxRg || findPkg('@vscode/ripgrep-linux-arm64', 'bin/rg');
    if (!fallbackRg) {
      log('@vscode/ripgrep: linux-arm64 fallback not found, skip (install-dsh should install it)');
    } else {
      const src = readFileSync(rgMain, 'utf8');
      const patched = `// dsh-launcher-android-ripgrep-v2
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
const platformPkg = \`@vscode/ripgrep-\${process.platform}-\${arch}\`;
const FALLBACK_RG = ${JSON.stringify(fallbackRg)};

let resolved;
try {
  resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
  try {
    // Android 优先使用 Termux pkg 安装的原生 rg；缺失时再回退 linux-arm64 静态二进制。
    if (existsSync(FALLBACK_RG)) {
      resolved = FALLBACK_RG;
    } else {
      const fallbackPkg = \`@vscode/ripgrep-linux-\${arch}\`;
      resolved = require.resolve(\`\${fallbackPkg}/bin/\${binaryName}\`);
    }
  } catch {
    if (!resolved && existsSync(FALLBACK_RG)) resolved = FALLBACK_RG;
  }
}
if (!resolved) throw new Error(\`No ripgrep binary for \${process.platform}-\${arch}\`);

export const rgPath = resolved;
`;
      // 内容比对幂等（review-r5）：此补丁是整文件重写，直接比对生成内容即可；
      // 旧版用 'dsh-launcher-android-ripgrep-v2' marker 判定——补丁内容改进（v3）
      // 而 marker 未变时会被静默跳过（参考实现记录的同型事故）。
      if (src === patched) {
        log('@vscode/ripgrep android fallback already up-to-date (content match)');
      } else {
        writeFileSync(rgMain, patched);
        log('@vscode/ripgrep android fallback patched: ' + rgMain);
      }
    }
  }
} catch (e) { log('WARN @vscode/ripgrep: ' + e.message); }

/* dsh-sandbox / dsh-sandbox-local 的 "/tmp"→TMPDIR 补丁已移除（v4.10 审计）：
 * 上游 writableRoots() 现原生并入 os.tmpdir()（Node 会优先读 TMPDIR 环境变量，
 * 启动器 web 进程恒导出应用私有 tmp），沙箱白名单无需再改写源码；
 * sandbox-local 的 --tmpfs/readWrite 分支依赖 bubblewrap，Android 上本就不可达。
 * 旧补丁在 rc.2 上零替换仍会向上游文件追加 marker 头，属纯污染。 */

try {
  // Android 共享存储（/storage/emulated/0，FUSE）不支持 chmod；dsh-fs-local 原子写
  // 会对临时 staging 目录/文件 chmod 0700/0600，导致 EACCES。这里把 chmod 改为
  // 遇到 EACCES/EPERM 时忽略（权限位在 FUSE 上本来也无法生效）。
  // review-r5 判定增强：旧版只看 marker 是否存在就写盘，**上游结构变化导致某条锚点
  // 零替换时也会落一个「半补丁」文件并写 marker**，后续永不重试（与 llm-pi-ai 分支
  // 此前的同型缺陷一致）。现改为逐条计数 + 写盘前语法自检：任一条锚点全部失配即不写盘
  // 并告警（宁可不打补丁，也不留半补丁毒化启动）。
  const MARKER_FS_CHMOD = 'dsh-launcher-android-fs-chmod';
  const fsLocal = findPkg('@deepseek-ai/dsh-fs-local', 'lib/index.js');
  if (fsLocal) {
    let src = readFileSync(fsLocal, 'utf8');
    if (src.includes(MARKER_FS_CHMOD)) {
      log('dsh-fs-local chmod already patched');
    } else {
      const guard = (expr) => `try { ${expr}; } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; }`;
      let hits = 0;
      const a = 'await chmod(stagingDir, 448);';
      const b = 'await handle.chmod(384);';
      const c = 'if (mode !== void 0) await handle.chmod(mode);';
      if (src.includes(a)) { src = src.split(a).join(guard(a.replace(/;$/, ''))); hits++; }
      if (src.includes(b)) { src = src.split(b).join(guard(b.replace(/;$/, ''))); hits++; }
      if (src.includes(c)) {
        src = src.split(c).join(`if (mode !== void 0) { try { await handle.chmod(mode); } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; } }`);
        hits++;
      }
      if (hits === 0) {
        log('WARN dsh-fs-local chmod: no anchor matched (upstream structure changed), NOT written');
      } else if (!syntaxOk(src)) {
        log('WARN dsh-fs-local chmod: syntax check FAILED, NOT written');
      } else {
        if (hits < 3) log(`WARN dsh-fs-local chmod: partial anchors ${hits}/3 — 已写盘但需核对上游`);
        writeFileSync(fsLocal, `// ${MARKER_FS_CHMOD}\n` + src);
        log(`dsh-fs-local chmod patched (anchors ${hits}/3)`);
      }
    }
  } else {
    log('dsh-fs-local: not found, skip chmod patch');
  }
} catch (e) { log('WARN dsh-fs-local chmod: ' + e.message); }

/* directory-picker-browse "SD Card" 条目补丁已移除（v4.10 审计）：
 * 改由独立内置插件 @dsh-external/dsh-android-links 在 HOME 下创建指向
 * /storage/emulated/0 的符号链接——browse 的 list() 原生保留符号链接项、
 * directoryRow() stat 跟随判定可进入，无需改动上游任何文件。
 * 插件经官方 `dsh plugin --profile web add` 装配（install-dsh.mjs 内置清单）。 */

// v4.8.1 资产清理：移除 patch-koffi.yml 占位写入——全仓库无任何消费方，
// koffi 已由上方 Proxy stub 直接顶替，无需禁用行文件。

log('=== android fixup done ===');