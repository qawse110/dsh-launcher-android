/**
 * stub/patchers/plugin-compat.mjs — **内置插件源码**的兼容改写。
 *
 * 两件事：
 *   · host 端：@deepseek-ai/dsh-settings 在 0.1.5 收窄导出面，插件若具名导入
 *     settingsNamespace 会在 ESM **链接期**抛错（try/catch 兜不住），故就地补出实现。
 *   · client 端：0.1.5 删除 @deepseek-ai/dsh-client-runtime 并把 createSnapshotStore
 *     迁到 @deepseek-ai/dsh-client-store；浏览器侧查模块表，须改写 require 说明符。
 *
 * 两者都只扫插件目录（files/plugins），不碰 dsh 本体；上游修好后自然 0 命中。
 * 注：dsh-vision 现已随 assets 分发并在源码处内联 settingsNamespace，
 * 故 host 端本补丁当前消费者主要是 dsh-llm-codebuddy。
 */
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, eachPluginEntry, eachPluginClientFile } from '../env.mjs';

/* ---------------------------------------------------------------------------
 * 内置插件源码兼容：@deepseek-ai/dsh-settings 在 0.1.5 收窄了导出面
 *
 * 0.1.1 导出 7 个符号，0.1.5 只剩 4 个（SettingsConflictError / SettingsProvider /
 * default / redactSecrets），以下两个被删除：
 *   - settingsNamespace(v)      —— 仅按 /^[a-z][a-z0-9-]*$/ 校验后原值返回
 *   - installSettingsSection(…) —— 能力下沉为 ctx.settings.installSection(…)
 *
 * **为什么必须在启动期就地改源码**：具名导入在 ESM **链接期**就抛
 * 「does not provide an export named …」，try/catch 兜不住，运行时探测也没机会执行；
 * 而这些插件装在 files/plugins/（dsh-vision 来自 prebuilt.tgz 解包），
 * 无法靠改 APK 内 assets 源修复——prebuilt.tgz 是 30MB 的 LFS 二进制。
 * 属「本机专有缺陷 + 唯一可行修复点」，与 koffi/node-pty stub 同性质。
 *
 * **已针对 0.1.7-rc.2 核实**：
 *   · @deepseek-ai/dsh-settings@0.1.7-rc.2/lib/index.js 的导出实测为
 *       export { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets }
 *     → settingsNamespace / installSettingsSection **仍然不存在**，补丁**仍有必要，保持不动**。
 *   · 内置插件收缩为三个后（dsh-web-mobile / dsh-prompt-optimizer-mobile / dsh-codearts-auth），
 *     逐一实测其对 dsh-settings 的引用：
 *       - dsh-codearts-auth：lib/ 中 25 处 'settingsNamespace' 命中，但**全部是它自带的**
 *         settings-compat.js 里的 `settingsNamespaceFor()`（本地函数，且从 **'./settings-compat.js'**
 *         导入，**不是**从 @deepseek-ai/dsh-settings 具名导入）；其 76 个 lib/*.js 中
 *         **没有任何文件 import 这两个已删除符号**（唯一的 dsh-settings 提及是
 *         jet-hub-store.js 里的一句文档注释）。
 *       - dsh-web-mobile / dsh-prompt-optimizer-mobile：**完全不引用** dsh-settings。
 *         （后者是本仓库对上游 dsh-prompt-optimizer 的 fork，基于 v0.7.6 即上游的
 *         dsh-po06；实测其 lib/*.js 对 settingsNamespace 命中 0 处。）
 *     → 上述原生三个内置插件均**不是**本补丁的消费者。
 *   · 本补丁**当时的真实消费者**是 dsh-vision（来自 prebuilt.tgz 的 third_party/）与
 *     手动装配的 dsh-llm-codebuddy，两者都写
 *       import { settingsNamespace } from '@deepseek-ai/dsh-settings';
 *
 *     **2026 变更（用户逐项决定内置集合后）**：
 *       - dsh-vision 已自 prebuilt.tgz 残留恢复进 assets/extra-plugins/ 并转为内置，
 *         其在 lib/index.js 的 settingsNamespace 具名导入**已就地内联**（源码随 APK 分发，
 *         不再需要启动期改写）。因此 **dsh-vision 不再是本补丁的消费者**。
 *       - 本补丁保留，消费者现为 dsh-llm-codebuddy（可选插件，仍靠它兜住链接期错误）。
 *       - 该内联也顺带绕开了下方「只扫入口文件」的覆盖边界问题。
 *
 * 关于扫描范围（本次核实项）：eachPluginEntry() 返回的是**每个插件目录的单一入口**
 * （package.json exports['.'].default ?? main ?? lib/index.js），**不是** lib/*.js 全量。
 * 就 0.1.7 现状而言这已足够——上述真实消费者都在**入口文件**里具名导入
 * （dsh-vision 的 import 在 lib/index.js；codebuddy 的在 lib/index.js）。
 * 但这是**已知的覆盖边界**：若将来某插件把已删除符号挪进 lib/ 子模块，补丁会漏。
 * 由于本文件是引导期补丁、且对每个插件目录全量递归扫描成本高（插件含 node_modules），
 * 这里保持入口级扫描，并在日志里以 scanned=<入口数> 显式暴露覆盖规模，
 * 一旦出现「插件加载报 does not provide an export named」即可据日志定位。
 * ------------------------------------------------------------------------- */
try {
  const MARKER = 'dsh-launcher-plugin-compat-v1';
  const MISSING = [
    ['settingsNamespace', `function settingsNamespace(value) {\n\tif (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError('settings namespace "' + value + '" must match /^[a-z][a-z0-9-]*$/');\n\treturn value;\n}`],
    ['installSettingsSection', `function installSettingsSection(ctx, ns, schema, entry, hooks) {\n\tctx.inject(['settings'], (sctx) => {\n\t\tconst settings = sctx.settings;\n\t\tif (settings === undefined || typeof settings.installSection !== 'function') throw new Error('installSettingsSection: settings service lacks installSection');\n\t\tsettings.installSection(ctx, ns, schema, entry, hooks);\n\t});\n}`],
  ];
  let patchedFiles = 0, alreadyDone = 0;
  const entries = eachPluginEntry();
  for (const { name, file: entry } of entries) {
    let src;
    try { src = readFileSync(entry, 'utf8'); } catch { continue; }
    if (src.includes(MARKER)) { alreadyDone++; continue; }
    // 只处理「从 dsh-settings 具名导入了已删除符号」的文件
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"];?/g;
    let changed = false;
    const out = src.replace(importRe, (whole, namesRaw) => {
      const names = namesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const used = names.filter((n) => MISSING.some(([sym]) => sym === n));
      if (used.length === 0) return whole;   // 引用的符号都还在 → 别碰
      changed = true;
      const helpers = used.map((n) => MISSING.find(([sym]) => sym === n)[1]).join('\n');
      const keep = names.filter((n) => !MISSING.some(([sym]) => sym === n));
      const rest = keep.length ? `import { ${keep.join(', ')} } from '@deepseek-ai/dsh-settings';\n` : '';
      return `${rest}${helpers}`;
    });
    if (!changed) continue;
    // 语法自检通过才写盘（否则会把插件改成「加载即崩」，比原缺陷更糟）
    const tmp = entry + '.compat-check.mjs';
    let ok = false;
    try {
      writeFileSync(tmp, out);
      const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
      ok = r.status === 0;
      if (!ok) log(`WARN plugin-compat: syntax check FAILED for ${name}: ${(r.stderr || '').slice(0, 200)}`);
    } catch (e) {
      log(`WARN plugin-compat: syntax check unavailable for ${name}: ${e.message}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (!ok) continue;
    try {
      writeFileSync(entry, `// ${MARKER}\n` + out);
      patchedFiles++;
      log(`plugin-compat patched: ${name}`);
    } catch (e) { log(`WARN plugin-compat write ${name}: ${e.message}`); }
  }
  log(`plugin-compat: scanned=${entries.length} patched=${patchedFiles} already=${alreadyDone}`);
} catch (e) { log('WARN plugin-compat: ' + e.message); }

/* ---------------------------------------------------------------------------
 * 内置插件 **client 端** 的模块表兼容：dsh 0.1.5 删除了 @deepseek-ai/dsh-client-runtime
 *
 * 现象（真机）：host 端插件树加载正常、web UI 已起，但页面顶部报
 *   Failed to load plugins
 *   failed to import loader entry …(dsh-provider-headers): client-modules:
 *   require("@deepseek-ai/dsh-client-runtime/client") missed the module table
 *
 * 根因：0.1.5 把 `createSnapshotStore` 从 `dsh-client-runtime/client`
 * **迁移到新包 `@deepseek-ai/dsh-client-store`**，并删除旧包。
 * 证据（逐项实测）：
 *   · 0.1.5 前端种子表（staticModules）只有 5 个 @deepseek-ai 词：
 *     cordis / dsh-client-store / dsh-client-ui-dockkit /
 *     dsh-client-ui-primitives / dsh-client-ui-slots —— **无 client-runtime**；
 *   · 0.1.5 安装树中不存在 dsh-client-runtime 包；
 *   · 新旧 createSnapshotStore **实现逐行相同**（仅缩进不同），故改指新包语义等价。
 *
 * 与 host 端不同：client 端是浏览器侧 `require(spec)` 查模块表，Node 侧解析无关，
 * 所以必须单独改写 client.js。改写的是 `require` 的**说明符字符串**，不动逻辑。
 *
 * **已针对 0.1.7-rc.2 核实（对新插件无副作用）**：
 *   · dsh-web-mobile@3.0.3/lib/client.js 的 external require 只有
 *     '@deepseek-ai/dsh-client-ui-primitives' 与 'react/jsx-runtime'，**不含 client-runtime**；
 *   · dsh-codearts-auth 的 client 是 lib/client/jet-hub.js，其 require 只有 'react'；
 *   · dsh-prompt-optimizer-mobile：不引用 client-runtime（0 处命中 `dsh-client-runtime`；它唯一的外部
 *     require 是 '@deepseek-ai/dsh-client-ui-primitives'，不在 REQUIRE_MAP 内）。
 *   → REQUIRE_MAP 对这三者**零命中**；代码里 `if (!out.includes(...)) continue` 直接跳过、
 *     **不写盘、不加 marker**，故**无副作用**（日志 scanned=N patched=0）。
 *   · 另外注意：eachPluginClientFile() 只探测 **lib/client.js** 这一固定路径，
 *     而 codearts 的 client 出口是 **lib/client/jet-hub.js**（package.json
 *     exports['./client']）——当前它本就不需要本补丁，故不影响；
 *     但这是已知覆盖边界（与 plugin-compat 同性质），日志的 scanned 计数会暴露规模。
 * ------------------------------------------------------------------------- */
try {
  const CMARKER = 'dsh-launcher-client-compat-v1';
  // 已删除 → 替代（0.1.5 模块表中存在的等价模块）
  const REQUIRE_MAP = [
    ['@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-store'],
  ];
  let patched = 0, already = 0;
  const clients = eachPluginClientFile();
  for (const { name, file } of clients) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    if (src.includes(CMARKER)) { already++; continue; }
    let changed = false;
    let out = src;
    for (const [from, to] of REQUIRE_MAP) {
      if (!out.includes(`"${from}"`) && !out.includes(`'${from}'`)) continue;
      out = out.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`'${to}'`);
      changed = true;
    }
    if (!changed) continue;
    // 语法自检（client.js 是 ESM 包装的工厂函数体，node --check 可校验）
    const tmp = file + '.client-check.mjs';
    let ok = false;
    try {
      writeFileSync(tmp, out);
      const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
      ok = r.status === 0;
      if (!ok) log(`WARN client-compat: syntax check FAILED for ${name}: ${(r.stderr || '').slice(0, 200)}`);
    } catch (e) {
      log(`WARN client-compat: syntax check unavailable for ${name}: ${e.message}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (!ok) continue;
    try {
      writeFileSync(file, `// ${CMARKER}\n` + out);
      patched++;
      log(`client-compat patched: ${name}`);
    } catch (e) { log(`WARN client-compat write ${name}: ${e.message}`); }
  }
  log(`client-compat: scanned=${clients.length} patched=${patched} already=${already}`);
} catch (e) { log('WARN client-compat: ' + e.message); }
