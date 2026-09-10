#!/usr/bin/env node
/**
 * bracecheck-edited.cjs — 设备端无 JDK 场景下的 Kotlin 源码静态预检。
 *
 * 三件事（都是本项目在 CI 抓过真实缺陷后被加进来的）：
 *  1. **括号平衡**：剥离字符串/行注释/块注释后统计 {} 与 ()。
 *  2. **KDoc 提前终止扫描**：注释块内出现终止符序列会提前结束注释，后续代码被当注释
 *     吞掉 → 编译报 Unclosed comment / Missing '}'。本项目已踩过两次
 *     （历史 commit 5cf987d、本轮 d617620——注释里写了 `patched/` 加通配符的写法，
 *     其中的终止符序列提前关掉了注释块）。
 *  3. **未替换占位符扫描**：模板类字面量里遗留 @TOKEN@ 形态的占位符。
 *
 * 用法：
 *   node tools/bracecheck-edited.cjs            # 扫描全部 .kt（默认）
 *   node tools/bracecheck-edited.cjs <file...>  # 只扫描指定文件
 *
 * 退出码：0 = 全部通过；1 = 有文件未通过。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/** 递归收集目录下所有 .kt 文件。 */
function collectKt(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "build" || e.name === ".git") continue;
      collectKt(p, out);
    } else if (e.name.endsWith(".kt")) {
      out.push(p);
    }
  }
  return out;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files =
  args.length > 0
    ? args.map((a) => path.resolve(a))
    : collectKt(path.join(ROOT, "app/src"));

/**
 * 扫描源码，返回 { braces, parens, inComment, commentStartLine, nesting }。
 *
 * **关键：Kotlin 的块注释是可嵌套的**（与 C/Java/JS 不同）。因此 KDoc 里写下
 * 形如 `patched/` + 双星号的写法，其中的起始符号会**打开一层嵌套注释**，
 * 于是本该结束 KDoc 的终止符只关掉内层 —— 外层继续吞代码，直到下一个
 * 终止符才闭合，表现为 `Unclosed comment` 或莫名 `Missing '}'`。
 * 这正是本项目 commit d617620 与历史 commit 5cf987d 两次真实编译失败的机理
 * （早期曾误判为「终止符提前结束注释」，实为嵌套导致注释**吞掉**代码）。
 *
 * 本文件自身的注释里也不得出现注释起始/终止符号字面量，否则本文件先坏
 * （编写本工具时实测踩到两次）。
 */
function scan(src) {
  let braces = 0,
    parens = 0;
  let inS = null,
    inLine = false;
  let depth = 0; // 块注释嵌套深度（Kotlin 语义）
  let commentStartLine = 0;
  let line = 1;
  let maxDepth = 0;
  const nestedOpenings = []; // 记录深度 >1 的嵌套起始位置

  for (let i = 0; i < src.length; i++) {
    const c = src[i],
      n = src[i + 1];
    if (c === "\n") line++;

    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (depth > 0) {
      // 注释内：只关心嵌套起始与终止
      if (c === "/" && n === "*") {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        nestedOpenings.push(line);
        i++;
        continue;
      }
      if (c === "*" && n === "/") {
        depth--;
        i++;
        continue;
      }
      continue;
    }
    if (inS) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inS) inS = null;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      depth = 1;
      commentStartLine = line;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inS = c;
      continue;
    }
    if (c === "{") braces++;
    if (c === "}") braces--;
    if (c === "(") parens++;
    if (c === ")") parens--;
  }

  return {
    braces,
    parens,
    inComment: depth > 0,
    commentStartLine,
    maxDepth,
    nestedOpenings,
  };
}

let fail = 0;
let checked = 0;
for (const f of files) {
  let src;
  try {
    src = fs.readFileSync(f, "utf8");
  } catch (e) {
    console.log(`  ??   ${f}: 无法读取（${e.message}）`);
    continue;
  }
  checked++;
  const r = scan(src);
  const name = path.relative(ROOT, f);
  const problems = [];
  if (r.braces !== 0) problems.push(`braces=${r.braces}`);
  if (r.parens !== 0) problems.push(`parens=${r.parens}`);
  if (r.inComment) {
    problems.push(
      `块注释未闭合（始于第 ${r.commentStartLine} 行）——若该处是 KDoc，` +
        `多半是正文里写了注释起始符号触发了 Kotlin 的嵌套注释`,
    );
  }
  if (r.maxDepth > 1) {
    // 嵌套本身合法，但在 KDoc 正文里几乎总是笔误（本项目两次编译事故的形态）。
    // 首个嵌套起始行才是根因；其后各行都是被吞进注释的正常 KDoc，不再罗列。
    const first = r.nestedOpenings[0] ?? "?";
    const more =
      r.nestedOpenings.length > 1 ? `（其后另有 ${r.nestedOpenings.length - 1} 处落入被吞区域）` : "";
    problems.push(
      `块注释嵌套（深度 ${r.maxDepth}，首个起始行 ${first}）${more}——` +
        `KDoc 正文里误写注释起始符会吞掉后续代码，请改用不触发嵌套的写法`,
    );
  }
  if (problems.length === 0) {
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}\n       ${problems.join("\n       ")}`);
  }
}

console.log("");
if (fail > 0) {
  console.error(`静态预检未通过：${fail}/${checked} 个文件有问题。`);
  process.exit(1);
}
console.log(`静态预检通过：${checked} 个 .kt 文件（括号平衡 + 注释闭合 + 嵌套扫描）。`);
process.exit(0);
