// fs/promises link 兼容层：SELinux 禁止 app 对 /data 文件硬链接（EACCES），
// 用「独占占位 + rename」模拟。已知残余差异（review R2 记录）：
// 1) 非真硬链接：rename 后为尽量保持"源仍存在"的 POSIX 观感，会尽力把内容
//    拷回 oldPath——两侧是独立副本，此后各自修改不再同步；
// 2) CJS require('fs/promises') 与 fs.linkSync 不经本 loader，覆盖盲区；
// 3) 并发安全：newPath 用 O_EXCL 占位裁决竞争，败者按 POSIX 收到 EEXIST。
import * as orig from 'node:fs/promises';
import { rename, access, constants, open, copyFile } from 'node:fs/promises';

export * from 'node:fs/promises';

let compatLinkCount = 0;
/** 诊断钩子：兼容层触发次数（供运行时排查，无内部消费者属预期）。 */
globalThis.__compatLinkCount = () => compatLinkCount;

function eexist(what) {
  const err = new Error(`EEXIST: file already exists, link '${what}'`);
  err.code = 'EEXIST';
  return err;
}

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
