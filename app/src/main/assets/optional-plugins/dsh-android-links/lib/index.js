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
 * 旧实现是 stub-dsh.mjs 直接改写 directory-picker-browse 的 lib/index.js
 * 插入 "SD Card" 硬编码条目；本插件把该功能改为官方插件装配通道内的
 * 独立内置插件，dsh 升级不再被启动器补丁破坏。
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
 *   - 链接属于用户可见的文件系统便利设施（与 status-bridge 心跳文件同类），
 *     卸载插件时不回收，避免正在浏览中的会话突然断链。
 */
import { existsSync, statSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-android-links';

const HOME = process.env.HOME || process.env.DSH_HOME || '';
const DEFAULT_SPEC = 'sdcard=/storage/emulated/0';

function log(m) {
  console.log(`[dsh-android-links] ${m}`);
}

/** 解析 DSH_ANDROID_LINKS："name=target,name2=target2"；裸 name 按 /storage/emulated/0/name 处理。 */
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
    .filter((l) => l.name.length > 0 && !l.name.includes('/') && l.name !== '.' && l.name !== '..');
}

/** 确保单个符号链接存在且指向正确；返回动作说明（用于日志/测试）。 */
export function ensureLink(link) {
  if (!link.target || !existsSync(link.target)) {
    return `skip ${link.name}: target missing (${link.target})`;
  }
  let st;
  try { st = statSync(link.target); } catch { return `skip ${link.name}: target not statable`; }
  if (!st.isDirectory()) return `skip ${link.name}: target not a directory`;
  try {
    const cur = readlinkSync(link.path);
    if (cur === link.target) return `kept ${link.name}`;
    /* 符号链接已存在但指向不同：原子替换为最新目标 */
    unlinkSync(link.path);
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      /* 不是符号链接：可能是普通文件/真实目录——绝不覆盖 */
      return `skip ${link.name}: path occupied by non-link entry`;
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
    return `linked ${link.name} -> ${link.target}`;
  } catch (e) {
    return `skip ${link.name}: symlink failed (${e && e.code ? e.code : e && e.message ? e.message : 'error'})`;
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
  for (const link of parseSpec(process.env.DSH_ANDROID_LINKS || DEFAULT_SPEC)) {
    log(ensureLink(link));
  }
}
