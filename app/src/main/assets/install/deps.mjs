/**
 * install/deps.mjs — **依赖桥接**：把 dsh-prefix 的依赖以符号链接暴露给
 * 两类消费者。
 *
 *   · linkPluginDeps   → files/plugins/node_modules（启动器自管的插件目录，可清理旧链接）
 *   · linkProfileDeps  → .dsh/profiles/<p>/node_modules（dsh/pnpm 自管，**只补不删**）
 *
 * 职责边界：本模块只做「让模块解析得到」，不安装任何东西、不装配插件。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FILES_DIR, DSH_PREFIX, DSH_PROFILE, PLUGINS_DIR, log } from './env.mjs';

/**
 * 内置插件以 link: 方式装配在 files/plugins 下，包管理器不会把依赖安装到该目录。
 * 这里把 dsh-prefix 的依赖桥接（符号链接）到 plugins/node_modules，使插件代码
 * 从 files/plugins/* 加载时也能解析 @deepseek-ai/* 等运行时依赖。
 * npm 扁平布局：桥接 node_modules 顶层即可。
 * pnpm 布局：顶层只有直接依赖，传递依赖在 .pnpm 虚拟store 里——额外扫描 store，
 * 把每个唯一包名（作用域包、多版本取最高）也桥接进去，恢复扁平解析语义。
 */
function cmpVer(a, b) {
  // 语义化版本比较，与 Kotlin 侧 DshUpdater.compareVersions 保持一致：
  // ① core 逐段数字比较；② prerelease 低于正式版；③ prerelease 逐段比较，
  //    纯数字段按数值比（"rc.10" > "rc.6"），非数字段按字典序，数字段 < 非数字段；
  // ④ prerelease 段数多者更高（1.0.0-rc.1.1 > 1.0.0-rc.1）。
  const parse = (v) => {
    const noBuild = String(v).trim().split('+')[0];
    const dash = noBuild.indexOf('-');
    const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash);
    const preStr = dash === -1 ? '' : noBuild.slice(dash + 1);
    const core = coreStr.split('.').map((n) => parseInt(n, 10) || 0);
    const pre = preStr ? preStr.split('.') : null;
    return { core, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (d) return d;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    const xn = /^\d+$/.test(x) ? parseInt(x, 10) : null;
    const yn = /^\d+$/.test(y) ? parseInt(y, 10) : null;
    let cmp;
    if (xn !== null && yn !== null) cmp = xn - yn;
    else if (xn !== null) cmp = -1; // 数字段 < 非数字段（semver 规则）
    else if (yn !== null) cmp = 1;
    else cmp = x < y ? -1 : x > y ? 1 : 0;
    if (cmp) return cmp;
  }
  return pa.pre.length - pb.pre.length;
}

function linkPluginDeps() {
  const src = join(DSH_PREFIX, 'node_modules');
  const dest = join(PLUGINS_DIR, 'node_modules');
  if (!existsSync(src)) {
    log('WARN dsh-prefix node_modules missing, skip plugin dep bridge');
    return;
  }
  try {
    mkdirSync(dest, { recursive: true });
    let kept = 0;
    let linked = 0;
    let removed = 0;
    let warns = 0;
    const keep = new Set();
    /**
     * 把 dest/<name> 指向 target。
     *
     * ⚠ **不许把已经指向 src 的条目再改成「指向 src」以外的任何形态**：
     * dest 里的 scope 目录（如 @deepseek-ai）在历史布局中**本身就是指向 src 同名目录的
     * 符号链接**（见下方 bridgeScope 注释）。对这样的条目执行 rm + symlink 会把它
     * 从「指向 src 目录」改成「指向 src 下某个具体包」，从而**改写了 dsh-prefix 自己的
     * node_modules 布局**——真机事故：升级到 0.2.0-rc.2 后，pnpm 已把
     * dsh-prefix/node_modules/@deepseek-ai/dsh 指向 0.2.0，本函数却因遍历 src 顶层
     * 时把 @deepseek-ai 当普通条目重链，最终让 dsh 链接**回退到 .pnpm 里的旧版本
     * 0.1.7-rc.2**（导致装完仍报旧版本、临时更新保护误判「版本未变化」）。
     * 判据：目标已存在且 readlink 相等 → 直接复用，绝不 rm。
     */
    const ensureLink = (name, target) => {
      if (keep.has(name)) return true;
      keep.add(name);
      const link = join(dest, ...name.split('/'));
      try { if (readlinkSync(link) === target) { kept++; return true; } } catch {}
      if (name.includes('/')) {
        const scope = name.slice(0, name.indexOf('/'));
        keep.add(scope);
        mkdirSync(join(dest, scope), { recursive: true });
      }
      rmSync(link, { recursive: true, force: true });
      try {
        symlinkSync(target, link);
        linked++;
        return true;
      } catch (e) {
        warns++;
        log('WARN bridge plugin dep ' + name + ': ' + e.message);
        return false;
      }
    };
    /**
     * 桥接一个顶级条目。
     *
     * 若 dest/<name> 已是指向 **src/<name> 自身**的符号链接（旧布局留下的 scope 软链），
     * 那么 names 下的每个包都已经能透过它解析到，**不需要也不允许**再逐项重链——
     * 逐项重链会把该 scope 软链变成具体包的软链，等于改写 dsh-prefix 的布局。
     * 这正是本函数曾经把 dsh 链接打回旧版本的机制。
     */
    const isScopeSharedWithSrc = (name) => {
      if (!name.startsWith('@')) return false;
      try { return readlinkSync(join(dest, name)) === join(src, name); } catch { return false; }
    };
    // 1) 直接依赖（两种布局都存在）
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      // scope 已与 src 共享 → 内容天然可见，保持原样（勿重写）
      if (isScopeSharedWithSrc(ent.name)) {
        keep.add(ent.name);
        for (const g of readdirSync(join(src, ent.name))) keep.add(ent.name + '/' + g);
        kept++;
        continue;
      }
      ensureLink(ent.name, join(src, ent.name));
    }
    // 1b) scope 内部条目：src 里已有（如 @deepseek-ai/dsh）但 dest 侧缺链接的补上。
    //     仅对**未与 src 共享**的 scope 逐项处理；共享 scope 由上面整体跳过。
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || !ent.name.startsWith('@')) continue;
      if (isScopeSharedWithSrc(ent.name)) continue;
      try {
        for (const g of readdirSync(join(src, ent.name))) {
          ensureLink(ent.name + '/' + g, join(src, ent.name, g));
        }
      } catch {}
    }
    // 2) pnpm 传递依赖：扫描 .pnpm/<pkg>@<ver>_peerhash/node_modules/*
    const store = join(src, '.pnpm');
    if (existsSync(store)) {
      const best = new Map(); // name -> {dir, ver}
      for (const d of readdirSync(store)) {
        if (d.startsWith('.')) continue;
        const nm = join(store, d, 'node_modules');
        if (!existsSync(nm)) continue;
        const found = [];
        try {
          for (const c of readdirSync(nm)) {
            if (c.startsWith('.')) continue;
            if (c.startsWith('@')) {
              for (const g of readdirSync(join(nm, c))) found.push([c + '/' + g, join(nm, c, g)]);
            } else {
              found.push([c, join(nm, c)]);
            }
          }
        } catch {}
        for (const [name, dir] of found) {
          let ver = '0.0.0';
          try { ver = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ver; } catch {}
          const cur = best.get(name);
          if (!cur || cmpVer(ver, cur.ver) > 0) best.set(name, { dir, ver });
        }
      }
      let bridgedTransitive = 0;
      for (const [name, info] of best) {
        if (keep.has(name)) continue; // 直接依赖已从顶层桥接
        if (ensureLink(name, info.dir)) bridgedTransitive++;
      }
      log(`pnpm store bridge: ${best.size} unique packages, ${bridgedTransitive} transitive bridged`);
    }
    // 清理本轮未覆盖的旧链接（含历史遗留的孤立作用域目录）
    for (const ent of readdirSync(dest, { withFileTypes: true })) {
      if (!keep.has(ent.name)) {
        rmSync(join(dest, ent.name), { recursive: true, force: true });
        removed++;
      }
    }
    log(`plugin dep bridge: ${kept} kept, ${linked} linked, ${removed} stale removed, ${warns} warn -> ${dest}`);
  } catch (e) {
    log('WARN linkPluginDeps: ' + e.message);
  }
}


/**
 * 把 dsh 自身的包桥接进 **profile 目录**的 node_modules。
 *
 * 作用：补上 profile 目录对 dsh 自身包的可见性（此前从该目录解析
 * @deepseek-ai/dsh-plugin-manager 返回 MODULE_NOT_FOUND）。
 *
 * ⚠ **它不是「插件页无可管理 profile」的修复，勿据此误判**。
 * 该缺陷的三轮假设已全部被真机实验证伪，记录在此以免后来者重走：
 *
 *   1) 「条目被 disabled 跳过」——插桩实测 disabled=false、profileContext 在位；
 *   2) 「导入太慢、启动审计抢在 fiber 之前快照」——预热 14MB 字节码缓存、
 *      单包导入 -21% 后症状分毫不动；
 *   3) 「profile 目录解析不到该包」——本函数补上后，从 profile 目录
 *      **ESM 导入成功**（ESM_OK），症状依旧不变。
 *
 * 另外插桩 install-scope 收集发现：被静默丢弃的依赖只有 3 个可选包
 * （bufferutil / utf-8-validate / @modelcontextprotocol/sdk），
 * **@deepseek-ai/dsh-plugin-manager 并未被丢弃** —— 即 dsh 的 runtime resolution
 * 表里本来就有它。故「resolution 表缺包」同样不成立。
 *
 * 结论：模块可解析、可导入、在解析表内、条目已启用，**fiber 仍不创建**。
 * 剩下的方向是条目 id 前缀 `include:` —— 它由 cordis-plugin-include 的 profile
 * include 层生成，问题发生在**挂载层而非解析层**，需插桩该层才能定性。
 *
 * 保留本函数的原因：它修的是一个**真实但独立**的解析缺口（规范化、幂等、无副作用）；
 * 若只需最小改动面，可单独回滚本函数而不影响其他功能。
 *
 * 与 [linkPluginDeps] 的关键区别：**只补不删**。
 *   · 那个函数服务于启动器自管的 files/plugins，可以清掉未覆盖的旧链接；
 *   · 本函数写的是 **dsh/pnpm 自管的 profile 目录**，里面既有 dsh 自己生成的链接，
 *     也有启动器的 link: 插件 —— 任何删除都会破坏 dsh 的装配状态。
 *     故这里只补缺失项：目标已存在就跳过，绝不覆盖、绝不清理。
 */
function linkProfileDeps() {
  const src = join(DSH_PREFIX, 'node_modules');
  const dest = join(FILES_DIR, '.dsh/profiles', DSH_PROFILE, 'node_modules');
  if (!existsSync(src)) {
    log('WARN profile dep bridge: dsh-prefix node_modules missing, skip');
    return;
  }
  if (!existsSync(join(FILES_DIR, '.dsh/profiles', DSH_PROFILE))) {
    log('WARN profile dep bridge: profile dir missing, skip');
    return;
  }
  try {
    mkdirSync(dest, { recursive: true });
    let linked = 0;
    let present = 0;
    let warns = 0;
    const ensureLink = (name, target) => {
      const link = join(dest, ...name.split('/'));
      // 已存在（dsh 自己生成的链接 / 启动器的 link: 插件）→ 一律不动
      if (existsSync(link) || (() => { try { readlinkSync(link); return true; } catch { return false; } })()) {
        present++;
        return;
      }
      if (name.includes('/')) mkdirSync(join(dest, name.slice(0, name.indexOf('/'))), { recursive: true });
      try {
        symlinkSync(target, link);
        linked++;
      } catch (e) {
        warns++;
        if (warns <= 3) log('WARN profile dep bridge ' + name + ': ' + e.message);
      }
    };
    // 1) dsh-prefix 顶层直接依赖
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      ensureLink(ent.name, join(src, ent.name));
    }
    // 2) pnpm 传递依赖：与 linkPluginDeps 同款「扫描 .pnpm 取最高版本」策略
    const store = join(src, '.pnpm');
    if (existsSync(store)) {
      const best = new Map();
      for (const d of readdirSync(store)) {
        if (d.startsWith('.')) continue;
        const nm = join(store, d, 'node_modules');
        if (!existsSync(nm)) continue;
        const found = [];
        try {
          for (const c of readdirSync(nm)) {
            if (c.startsWith('.')) continue;
            if (c.startsWith('@')) {
              for (const g of readdirSync(join(nm, c))) found.push([c + '/' + g, join(nm, c, g)]);
            } else {
              found.push([c, join(nm, c)]);
            }
          }
        } catch {}
        for (const [name, dir] of found) {
          let ver = '0.0.0';
          try { ver = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ver; } catch {}
          const cur = best.get(name);
          if (!cur || cmpVer(ver, cur.ver) > 0) best.set(name, { dir, ver });
        }
      }
      for (const [name, info] of best) ensureLink(name, info.dir);
    }
    log(`profile dep bridge: ${linked} linked, ${present} already present, ${warns} warn -> ${dest}`);
  } catch (e) {
    log('WARN linkProfileDeps: ' + e.message);
  }
}

// cmpVer 被 linkPluginDeps 内部调用，无外部消费者，故不导出。
export { linkPluginDeps, linkProfileDeps };
