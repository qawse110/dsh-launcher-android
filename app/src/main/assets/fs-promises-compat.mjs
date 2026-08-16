import * as orig from 'node:fs/promises';
import { rename, access, constants } from 'node:fs/promises';

export * from 'node:fs/promises';

let compatLinkCount = 0;
globalThis.__compatLinkCount = () => compatLinkCount;

export async function link(oldPath, newPath) {
  try {
    await orig.link(oldPath, newPath);
    return;
  } catch (e) {
    if (e && e.code !== 'EACCES') throw e;
    compatLinkCount++;
    try {
      await access(newPath, constants.F_OK);
      const err = new Error(`EEXIST: file already exists, link '${oldPath}' -> '${newPath}'`);
      err.code = 'EEXIST';
      throw err;
    } catch (ee) {
      if (ee && ee.code === 'EEXIST') throw ee;
      await rename(oldPath, newPath);
    }
  }
}