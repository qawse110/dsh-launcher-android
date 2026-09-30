/**
 * stub/patchers/flock.mjs — **Android flock 降级**。
 *
 * 现象：dsh 0.1.5 起每轮对话报「flock is not supported on android-arm64」。
 * 根因：dsh 0.1.5 新增 @deepseek-ai/node-addon-system 原生 addon，其 flock 在
 * Android 上不可用。本补丁就地降级，避免每轮对话失败。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { log, findPkg } from '../env.mjs';

/* ---------------------------------------------------------------------------
 * Android flock 降级（v4.10.3）
 *
 * 现象：dsh 0.1.5 起，每轮对话都报「本轮运行失败 flock is not supported on android-arm64」。
 *
 * 根因链（已逐环复现）：
 *   dsh 0.1.5 新增依赖 @deepseek-ai/node-addon-system（native addon），
 *   其 lib/flock.js 开头就判断平台：
 *       if (platform !== 'linux' && platform !== 'darwin') throw ERR_FLOCK_UNSUPPORTED_PLATFORM
 *   而 Android 上 **process.platform === 'android'**（不是 'linux'）→ 直接抛错。
 *   该 addon 官方只发布 darwin-arm64/x64、linux-x64/arm64 四个平台包，
 *   **没有 android**，所以即便绕过判断也加载不到二进制。
 *   dsh-session-persistence-jsonl 用 tryLockExclusive 获取「会话写租约」，
 *   抛错冒泡成「本轮运行失败」——对话每轮都触发，等于不可用。
 *   （0.1.1 没有这个依赖，所以旧版正常。）
 *
 * 为什么可以安全降级为「立即成功」：
 *   flock 的用途是**跨进程**互斥（同进程内另有 write claim 保证唯一写者）。
 *   Android 上 dsh web 是**单进程** node（web-launcher.sh.tpl 只起一个 node），
 *   不存在第二个进程争用同一会话文件，故跨进程锁是多余的。
 *   官方对 browser worker 就是这么做的，原话：
 *     "The browser worker stubs the native flock entry to immediate success:
 *      it is single-process, so the in-process write claim already excludes every writer."
 *   我们与 browser worker 属同类情形，沿用同一降级语义。
 *
 * 做法：在 flock.js 顶部插入 android 短路——tryLockExclusive 立即 resolve。
 * 保留原文件其余内容与导出签名，故 dsh-session-persistence-jsonl 侧
 * 走的是正常 posix lease 分支，无需改动其它包。
 *
 * **已针对 0.1.7-rc.2 核实**：
 *   · 锚点 'export async function tryLockExclusive(fd) {' 在
 *     @deepseek-ai/node-addon-system@0.1.2/lib/flock.js 中**仍然命中**（版本未变，
 *     0.1.7 安装树实测）。→ 保持不动。
 *   · findPkg 定位能力：0.1.7 的 **npm 扁平布局**下
 *     node_modules/@deepseek-ai/node-addon-system/lib/flock.js 直接命中；
 *     **pnpm 布局**下走 .pnpm/<name>@<ver>.../node_modules/<pkg>/<rel> 前缀匹配，
 *     再退到 findNestedPkg 递归（深度 ≤8）。实测 0.1.7 解包树为扁平布局，
 *     但两种布局的解析分支都在，未命中时打显式 WARN 而非静默。
 * ------------------------------------------------------------------------- */
try {
  const MARKER_FLOCK = 'dsh-launcher-android-flock-stub';
  const flockFile = findPkg('@deepseek-ai/node-addon-system', 'lib/flock.js');
  if (!flockFile) {
    log('node-addon-system/flock: not found, skip android stub');
  } else {
    let src = readFileSync(flockFile, 'utf8');
    if (src.includes(MARKER_FLOCK)) {
      log('flock android stub already applied');
    } else {
      // 只替换 tryLockExclusive 的函数体首行，其余（含 loadBinding 原逻辑）保持原样，
      // 以便将来上游支持 android 时可无损回退（有 marker，重装即重打）。
      const anchor = 'export async function tryLockExclusive(fd) {';
      if (!src.includes(anchor)) {
        log('WARN flock android stub: anchor not found (upstream changed?), skip');
      } else {
        const patchedFn =
          anchor + '\n' +
          '    // ' + MARKER_FLOCK + ': Android 单进程无需跨进程 flock（见 stub-dsh.mjs 注释）\n' +
          '    if (process.platform === \'android\') return;\n';
        src = src.replace(anchor, patchedFn);
        writeFileSync(flockFile, `// ${MARKER_FLOCK}\n` + src);
        log('flock android stub applied: ' + flockFile);
      }
    }
  }
} catch (e) { log('WARN flock android stub: ' + e.message); }
