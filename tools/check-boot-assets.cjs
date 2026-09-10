#!/usr/bin/env node
/**
 * 引导期资产供给门禁（review-r12）。
 *
 * ## 为什么需要这道门禁
 *
 * 真机 P0 回归：commit `abae4ff` 把安装路径上的「三件套拷贝循环」替换成
 * `syncCompatAssets(...)`（只同步 `patched/`），**却没有把 `fs-register.mjs`
 * 等文件移交出去**。结果：
 *
 * - `DshFlow.startDshWeb` 生成的 node 命令仍硬引用 `<files>/fs-register.mjs`；
 * - 但安装路径不再供给该文件，快速启动路径当时也没调用同步函数；
 * - `MainActivity.syncAssetsOnApkUpdate` 是唯一残余供给点，而它因 `versionCode`
 *   被钉成常量（300）而**永久早退** —— 于是首次安装 / watchdog 崩溃回滚重装
 *   会以 `ERR_MODULE_NOT_FOUND` 硬失败（node 对缺失的 `--import` 是 exit=1）。
 *
 * 现有的 4 道门禁**全都看不见这个缺陷**：assets 侧文件齐全（资产脚本门禁绿）、
 * Kotlin 语法正确（括号门禁绿）、插件契约无关。缺口在于**没有任何东西比对
 * 「Kotlin 里引用的 files 级资产」与「Kotlin 里实际拷贝的资产清单」**。
 *
 * ## 本门禁做什么
 *
 * A. 从 `DshFlow.kt` 里 [BOOT_SCRIPTS] 与 `--import <name>` 引用反解出所有
 *    「web 启动命令会用到的 files 级脚本」，断言：
 *      A1. 每个被引用的脚本都在 BOOT_SCRIPTS 清单里（引用与供给不能各自漂移）；
 *      A2. 该清单也出现在同步函数的实际拷贝目标里；
 *      A3. 对应 `assets/<name>` 真实存在（否则同步必然失败）。
 * B. 断言 `startDshWeb` 的 `--import` 不是字面量漂移：命令串必须经常量拼接。
 * C. 断言 `syncBootAssets` 同时覆盖「引导脚本」与「patched/ 载荷」两部分
 *    （只做一半 = 静默跳过补丁）。
 *
 * 退出码非 0 = 门禁失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const FLOW = path.join(
  ROOT, 'app', 'src', 'main', 'java', 'com', 'dsh', 'launcher', 'core', 'DshFlow.kt'
);

const failures = [];
const notes = [];

if (!fs.existsSync(FLOW)) {
  console.error(`✗ 找不到 DshFlow.kt：${FLOW}`);
  process.exit(1);
}
const src = fs.readFileSync(FLOW, 'utf8');

/** 去掉行注释，避免注释里的示例（如 `--import`、`assets/patched`）被当成真实代码。
 *  块注释整体剥离；字符串字面量保留（我们恰恰要读命令串）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const code = stripComments(src);

// ── A. 反解 BOOT_SCRIPTS 清单 ─────────────────────────────────────────
const bootBlock = code.match(/internal\s+val\s+BOOT_SCRIPTS\s*=\s*listOf\s*\(([\s\S]*?)\)/);
if (!bootBlock) {
  failures.push('DshFlow.kt 找不到 `internal val BOOT_SCRIPTS = listOf(...)` 清单');
}
const bootEntries = [];
if (bootBlock) {
  // 逐项解析：既支持标识符（FS_REGISTER_SCRIPT），也支持内联字面量（"fs-loader.mjs"）。
  // 早期版本用裸 /[A-Za-z_]\w*/ 扫全串，会把 "fs-loader.mjs" 拆成 fs / loader / mjs
  // 三个假标识符——即门禁自身的解析 bug（教训：门禁报错先怀疑门禁）。
  for (const m of bootBlock[1].matchAll(/"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)/g)) {
    bootEntries.push(m[1] !== undefined ? { literal: m[1] } : { ident: m[2] });
  }
}
notes.push(
  `BOOT_SCRIPTS 声明 ${bootEntries.length} 项：` +
  bootEntries.map((e) => e.literal ?? e.ident).join(', ')
);

/** 把 `internal const val NAME = "value"` 解析成 名字→字符串。 */
const consts = {};
for (const m of code.matchAll(/internal\s+const\s+val\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
  consts[m[1]] = m[2];
}

/** BOOT_SCRIPTS 里每一项 → 它代表的文件名。 */
const bootFiles = new Set();
for (const entry of bootEntries) {
  if (entry.literal !== undefined) {
    bootFiles.add(entry.literal);
    continue;
  }
  const id = entry.ident;
  const literal = consts[id];
  if (literal) {
    bootFiles.add(literal);
  } else {
    // 不是「internal const val X = "..."」形式：可能是普通 val 或在别处定义
    const inline = code.match(new RegExp(`val\\s+${id}\\s*=\\s*"([^"]*)"`));
    if (inline) bootFiles.add(inline[1]);
    else failures.push(`BOOT_SCRIPTS 里的标识符 \`${id}\` 无法解析为字符串常量（请用 internal const val NAME = "..."）`);
  }
}

// ── A1/B. 反解 startDshWeb 里 `--import` 的实际引用 ────────────────────
//  形如：--import ${register.absolutePath}  —— register 由 File(ctx.filesDir, FS_REGISTER_SCRIPT) 构造
const importRefs = [];
for (const m of code.matchAll(/--import\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\.absolutePath\}/g)) {
  importRefs.push(m[1]);
}
//  形如：--import ${ctx.filesDir.absolutePath}/fs-register.mjs  —— 字面量文件名拼接（旧写法）
const literalImportRefs = [];
for (const m of code.matchAll(/--import\s+\$\{[^}]*\}\/([A-Za-z0-9_.-]+\.(?:mjs|cjs|js))/g)) {
  literalImportRefs.push(m[1]);
}

if (importRefs.length === 0 && literalImportRefs.length === 0) {
  failures.push('DshFlow.kt 中找不到任何 `--import <脚本>` 引用——命令形态已变化，请更新本门禁的解析规则');
}

// 变量 → 文件名：`val register = File(ctx.filesDir, FS_REGISTER_SCRIPT)`
for (const varName of importRefs) {
  const m = code.match(
    new RegExp(`val\\s+${varName}\\s*=\\s*File\\(\\s*ctx\\.filesDir\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`)
  );
  if (!m) {
    failures.push(
      `--import 引用了变量 \`${varName}\`，但找不到 \`val ${varName} = File(ctx.filesDir, <CONST>)\` 形式——` +
      `无法确认它指向哪个引导脚本`
    );
    continue;
  }
  const file = consts[m[1]];
  if (!file) {
    failures.push(`--import 变量的文件名常量 \`${m[1]}\` 无法解析为字符串常量`);
    continue;
  }
  if (!bootFiles.has(file)) {
    failures.push(
      `--import 引用 \`${file}\`，但它不在 BOOT_SCRIPTS 清单里——` +
      `启动命令会读取一个没有任何同步点保证存在的文件（这正是 abae4ff 引入的 P0 形态）`
    );
  } else {
    notes.push(`--import 引用 ${file}：已在 BOOT_SCRIPTS 内 ✓`);
  }
}

for (const file of literalImportRefs) {
  failures.push(
    `--import 用**字面量文件名**拼接（${file}）——应与 BOOT_SCRIPTS 共用常量，` +
    `否则清单与命令可以各自漂移（review-r12 P0 根因）。请改为 File(ctx.filesDir, FS_REGISTER_SCRIPT)`
  );
}

// ── A2. 断言同步函数确实会拷贝 BOOT_SCRIPTS 里的每一项 ────────────────
const syncFn = code.match(/internal\s+fun\s+syncBootAssets\s*\([\s\S]*?\n    \}/);
if (!syncFn) {
  failures.push('DshFlow.kt 找不到 `internal fun syncBootAssets(...)`——唯一供给点缺失');
} else {
  const body = syncFn[0];
  if (!/for\s*\(\s*\w+\s+in\s+BOOT_SCRIPTS\s*\)/.test(body)) {
    failures.push('syncBootAssets 没有遍历 BOOT_SCRIPTS——清单与实际拷贝集合可能不一致');
  }
  // 同一函数必须**真的调用** patched/ 目录拷贝（只做一半 = 静默跳过补丁）。
  // 判据落在调用形态上而非「body 里出现过 patched 字样」：注释与日志文案里都会出现
  // `patched`，裸词匹配会被自己的说明文字骗过——本门禁初版即是如此，被反向测试暴露。
  const copiesPatched = /copyAssetDir\s*\([^)]*"patched"/.test(body);
  if (!copiesPatched) {
    failures.push(
      'syncBootAssets 没有实际调用 copyAssetDir(…, "patched", …)——stub 的补丁载荷不会被同步'
    );
  } else {
    notes.push('syncBootAssets 同时覆盖 BOOT_SCRIPTS 与 patched/ 载荷 ✓');
  }
}

// ── A3. 每个引导脚本的 asset 必须真实存在 ─────────────────────────────
for (const file of bootFiles) {
  const p = path.join(ASSETS, file);
  if (!fs.existsSync(p)) {
    failures.push(`BOOT_SCRIPTS 声明了 \`${file}\`，但 assets/${file} 不存在——同步必然失败`);
  } else {
    notes.push(`assets/${file} 存在 ✓`);
  }
}

// ── A4. BOOT_SCRIPTS 的文件名必须与 assets/patched 之外的引导脚本面吻合 ──
//  反向检查：assets 根下的 *.mjs 若被 Kotlin 命令引用却没进清单，上面 A1 已覆盖；
//  这里再确认清单里没有明显写错的后缀。
for (const file of bootFiles) {
  if (!/\.(mjs|cjs|js|sh)$/.test(file)) {
    failures.push(`BOOT_SCRIPTS 里的 \`${file}\` 后缀不像可执行引导脚本`);
  }
}

// ── C. 安装路径与快速启动路径都必须调用同步函数 ──────────────────────
const callSites = [...code.matchAll(/syncBootAssets\s*\(/g)].length - 1; // 减去定义处
if (callSites < 2) {
  failures.push(
    `syncBootAssets 只有 ${callSites} 个调用点——安装路径与快速启动路径都必须调用` +
    `（旧实现两者的拷贝清单各自维护，其中一处被误删即为 P0）`
  );
} else {
  notes.push(`syncBootAssets 有 ${callSites} 个调用点（安装 + 快速启动）✓`);
}

// ── 输出 ─────────────────────────────────────────────────────────────
for (const n of notes) console.log('  · ' + n);
if (failures.length) {
  console.error(`\n引导期资产供给门禁未通过（${failures.length} 项）：\n`);
  for (const f of failures) console.error('  - ' + f + '\n');
  process.exit(1);
}
console.log('\n  引导期资产供给门禁通过（BOOT_SCRIPTS ↔ --import 引用 ↔ assets 三者一致）');
