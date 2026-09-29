/**
 * dsh-android-links — 把 Android 共享存储以符号链接形式暴露进 dsh HOME。
 *
 * 背景：dsh 工作区目录浏览器（@deepseek-ai/dsh-host-directory-picker-browse）
 * 的 list() 以 os.homedir() 为默认根，且原生支持目录项里的符号链接
 * （`dirent.isDirectory() || dirent.isSymbolicLink()` 都会保留，directoryRow
 * 对符号链接 stat 跟随后判定可进入）。因此在 HOME 下放一个指向
 * /storage/emulated/0 的符号链接，「添加工作区」即可直达 SD 卡，
 * 完全不需要修改 dsh 本体源码。
 *
 * 配置（环境变量，可省略）：
 *   DSH_ANDROID_LINKS  逗号分隔的 `名称=目标` 列表。缺省：
 *                      "sdcard=/storage/emulated/0"
 *                      只写名称不写目标时按 /storage/emulated/0/<名称> 解析。
 *
 * 行为约定：
 *   - 幂等：链接已存在且目标一致时不动；
 *   - 目标不存在或不是目录 → 跳过并告警；
 *   - 同名位置已被普通文件/目录占用 → 跳过（绝不覆盖用户数据）；
 *   - 链接属于用户可见的文件系统便利设施，卸载插件时不回收，
 *     避免正在浏览中的会话突然断链；但**创建/替换过哪些链接会记账**（见 INVENTORY），
 *     以便日后人工清理时有据可依（审查项 A3）。
 *
 * 审查项修复记录：
 *   A1  名称校验补上反斜杠；目标做 realpath 归一并拒绝自引用（防环）。
 *   A2  替换链接时「先删后建」若建失败，**回滚为原目标**；确实回滚不了才报 relink-lost，
 *       并在返回值里与「没动过」明确区分（旧版失败时只说 skip，用户看不出链接已丢）。
 *   A3  维护 INVENTORY（`<HOME>/dsh-android-links.json`）记录本插件创建/替换过的链接。
 */
import {
  existsSync, statSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const name = 'dsh-android-links';

const HOME = process.env.HOME || process.env.DSH_HOME || '';
const DEFAULT_SPEC = 'sdcard=/storage/emulated/0';
/** 记账文件：记录本插件创建/替换过的链接，便于人工清理（审查项 A3）。 */
export const INVENTORY = HOME ? join(HOME, 'dsh-android-links.json') : null;

function log(m) {
  console.log(`[dsh-android-links] ${m}`);
}

/** 目标归一化：存在的目标取 realpath（跟随链接，防环），失败的返回 null。 */
function normalizeTarget(target) {
  try { return realpathSync(target); } catch { return null; }
}

/**
 * 解析 DSH_ANDROID_LINKS："name=target,name2=target2"；裸 name 按 /storage/emulated/0/name 处理。
 *
 * 审查项 A1：名称只允许单层、不含分隔符（`/` **与** `\\`），否则 `join` 的归一行为
 * 会让人误以为"写了个子目录"，实际落到意料之外的位置。
 */
export function parseSpec(raw) {
  return String(raw || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const linkName = eq === -1 ? pair : pair.slice(0, eq).trim();
      const target = eq === -1 ? join('/storage/emulated/0', linkName) : pair.slice(eq + 1).trim();
      return { name: linkName, path: join(HOME, linkName), target };
    })
    .filter((l) => l.name.length > 0 && !l.name.includes('/') && !l.name.includes('\\')
      && l.name !== '.' && l.name !== '..');
}

/** 确保单个符号链接存在且指向正确；返回动作说明（用于日志/测试）。 */
export function ensureLink(link) {
  if (!link.target || !existsSync(link.target)) {
    return `skip ${link.name}: target missing (${link.target})`;
  }
  let st;
  try { st = statSync(link.target); } catch { return `skip ${link.name}: target not statable`; }
  if (!st.isDirectory()) return `skip ${link.name}: target not a directory`;

  // A1：目标 realpath 后不得等于链接自身（自引用会形成无法遍历的环）。
  const realTarget = normalizeTarget(link.target);
  if (realTarget !== null && resolve(realTarget) === resolve(link.path)) {
    return `skip ${link.name}: target is the link itself (self-reference)`;
  }

  // 先判「这个位置是什么」，再决定动不动它。刻意把三种情况分开报，避免
  // 旧版那种「删除失败」被误报成「被非链接占用」（用户会去删一个本来就不该删的东西）。
  let previous = null;
  try {
    previous = readlinkSync(link.path);
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      /* 不是符号链接：可能是普通文件/真实目录——绝不覆盖 */
      return `skip ${link.name}: path occupied by non-link entry`;
    }
    previous = null; // ENOENT：位置空闲
  }
  if (previous === link.target) return `kept ${link.name}`;
  if (previous !== null) {
    /* 符号链接已存在但指向不同：先记住原目标，替换失败时要能回滚（A2）。 */
    try {
      unlinkSync(link.path);
    } catch (e) {
      return `skip ${link.name}: cannot remove stale link (${e && e.code ? e.code : e && e.message})`;
    }
  }
  try {
    lstatSync(link.path);
    return `skip ${link.name}: path occupied by non-link entry`;
  } catch {
    /* ENOENT：位置空闲，可以创建 */
  }
  try {
    symlinkSync(link.target, link.path);
    return previous === null
      ? `linked ${link.name} -> ${link.target}`
      : `relinked ${link.name}: ${previous} -> ${link.target}`;
  } catch (e) {
    const why = e && e.code ? e.code : e && e.message ? e.message : 'error';
    // A2：替换路径下我们已经把旧链接删了；建新链接失败时尽力回滚，
    // 并在返回值里**明确区分**「没动过」与「旧的丢了」。
    if (previous !== null) {
      try {
        symlinkSync(previous, link.path);
        return `skip ${link.name}: symlink failed (${why}), original link restored`;
      } catch {
        return `LOST ${link.name}: symlink failed (${why}) and original link could NOT be restored`;
      }
    }
    return `skip ${link.name}: symlink failed (${why})`;
  }
}

/** A3：把本次实际生效的链接记账下来，供日后清理。 */
function recordInventory(links) {
  if (!INVENTORY) return;
  try {
    writeFileSync(INVENTORY, JSON.stringify({
      updatedAt: new Date().toISOString(),
      links: links.map((l) => ({ name: l.name, path: l.path, target: l.target })),
    }, null, 2) + '\n');
  } catch (e) {
    log(`cannot write inventory (${e && e.message ? e.message : e})`);
  }
}

export function apply() {
  if (!HOME) {
    log('HOME/DSH_HOME unavailable, skip');
    return;
  }
  if (!existsSync(HOME)) {
    log(`HOME missing (${HOME}), skip`);
    return;
  }
  const links = parseSpec(process.env.DSH_ANDROID_LINKS || DEFAULT_SPEC);
  for (const link of links) log(ensureLink(link));
  recordInventory(links);
}
