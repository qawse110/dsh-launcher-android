// fs/promises link 兼容层：SELinux 禁止 app 对 /data 文件硬链接（EACCES），
// 用「独占占位 + rename」模拟。已知残余差异（review R2 记录）：
// 1) 非真硬链接：rename 后为尽量保持"源仍存在"的 POSIX 观感，会尽力把内容
//    拷回 oldPath——两侧是独立副本，此后各自修改不再同步；
// 2) CJS require('fs/promises') 与 fs.linkSync 不经本 loader，覆盖盲区；
// 3) 并发安全：newPath 用 O_EXCL 占位裁决竞争，败者按 POSIX 收到 EEXIST。
import * as orig from 'node:fs/promises';
import { rename, access, constants, open, copyFile } from 'node:fs/promises';

export * from 'node:fs/promises';

/**
 * 与原生 `node:fs/promises` 的 **default 语义对齐**（原生 default 即整个命名空间）。
 *
 * 为什么必须补（真机实测根因）：fs-loader.mjs 会把 `node:fs/promises` 与
 * `fs/promises` 的导入重定向到本文件，而 **`export *` 不转发 default**。
 * 于是「原生默认导入可用、经本 loader 后不可用」：
 *   · 原生 `import fs from 'node:fs/promises'`  → OK
 *   · 经 fs-register 后同一条语句                  → SyntaxError:
 *       "The requested module 'node:fs/promises' does not provide an export named 'default'"
 * 任何做默认导入的依赖都会直接崩在模块链接期。实测命中：
 * `which-command@0.1.0`（`@deepseek-ai/dsh-plugin-manager` 的依赖链上），
 * 导致该插件 import 失败 → entry.fiber 永不创建 → dsh 记为
 * "plugin-manager: failed to import" → pluginManager 服务缺失 →
 * host-plugin-inventory 不置 managementAvailable →
 * 插件页显示「本部署没有可管理的 profile」。整条链的**唯一源头就是这里少一个 default**。
 *
 * default 里用本模块的 `link`（覆盖原生的硬链接实现），其余转发原生命名空间，
 * 与「命名导出走本模块」的现有语义保持一致。
 */
export default { ...orig, link };

let compatLinkCount = 0;
/** 诊断钩子：兼容层触发次数（供运行时排查，无内部消费者属预期）。 */
globalThis.__compatLinkCount = () => compatLinkCount;

// 已删除（无用代码清理）：`eexist(what)` 构造 EEXIST 错误的辅助函数——
// 定义后**从未被调用**。link() 的 EEXIST 分支是直接 `throw ee`（抛原生错误对象），
// 不由这里构造，属拆分/演进遗留的空壳。

export async function link(oldPath, newPath) {
  try {
    await orig.link(oldPath, newPath);
    return;
  } catch (e) {
    if (e && e.code !== 'EACCES') throw e;
    compatLinkCount++;
    // 独占占位裁决并发：内核级保证同一 newPath 只有一方成功
    let fh;
    try {
      fh = await open(newPath, 'wx');
    } catch (ee) {
      if (ee && ee.code === 'EEXIST') throw ee;
      throw ee;
    }
    await fh.close().catch(() => {});
    await rename(oldPath, newPath);
    // 近似硬链接语义：尽力保留源文件内容（副本，非链接）
    try { await copyFile(newPath, oldPath); } catch {}
  }
}
