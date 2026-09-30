/**
 * stub/patchers/native-stubs.mjs — Android 缺预编译原生产物时的**模块顶替**。
 *
 * 覆盖 koffi / node-pty / sharp / node-addon-require-builtin 四个包，
 * 外加 dsh-attachment-local 的视觉链路 v5（SELinux 禁 link(2) / FUSE fsync）。
 *
 * 共同点：都在 **import 期或 fs 底层**决定行为，Cordis 插件运行时无法介入，
 * 因此在引导期脚本里改写。koffi/node-pty/sharp 与 dsh 版本无关、无锚点；
 * attachment-local 用**扫描式**改写（不锚定单一字面量，上游重构也不会静默失效）。
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { log, findPkg } from '../env.mjs';

const KSTUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O2V4cG9ydCBkZWZhdWx0IGtvZmZpOw==';
const KCJS = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2NvbnN0IGtvZmZpPXtsb2FkOigpPT5wLGRlY29kZTooKT0+MCxlbmNvZGU6KCk9PjAsCnNpemVvZjooKT0+MCxhbGlnbm9mOigpPT4wLGZ1bmN0aW9uOigpPT5wLHN0cnVjdDooKT0+cCx1bmlvbjooKT0+cCxlbnVtOigpPT5wLHR5cGVkZWY6KCk9PnAscG9pbnRlcjooKT0+cCwKcmVnaXN0ZXI6KCk9PnAsS29mZmlFcnJvcjpjbGFzcyBleHRlbmRzIEVycm9ye319O21vZHVsZS5leHBvcnRzPWtvZmZpO21vZHVsZS5leHBvcnRzLmRlZmF1bHQ9a29mZmk7';
const PSTUB = 'Y29uc3R7RXZlbnRFbWl0dGVyfT1yZXF1aXJlKCdldmVudHMnKTtjbGFzcyBGIGV4dGVuZHMgRXZlbnRFbWl0dGVye2NvbnN0cnVjdG9yKCl7c3VwZXIoKTt0aGlzLnBpZD0wO3RoaXMuZXhpdENvZGU9MH13cml0ZSgpe31raWxsKCl7fXJlc2l6ZSgpe31jbGVhcigpe31jbG9zZSgpe31vbkV4aXQoYyl7aWYoYyljKHtleGl0Q29kZTowLHNpZ25hbDp1bmRlZmluZWR9KX19bW9kdWxlLmV4cG9ydHM9e3NwYXduKCl7Y29uc3QgeD1uZXcgRigpO3Byb2Nlc3MubmV4dFRpY2soKCk9PnguZW1pdCgnZXhpdCcse2V4aXRDb2RlOjAsc2lnbmFsOnVuZGVmaW5lZH0pKTtyZXR1cm4geH0sZm9yaygpe3JldHVybiBuZXcgRigpfSxvcGVuKCl7cmV0dXJue21hc3RlcjpuZXcgRigpLHNsYXZlOm5ldyBGKCl9fX07';
/* dsh-launcher android stub fix (2026-08-19): the old stub returned itself for
 * every property INCLUDING `then`, which made the proxy accidentally thenable:
 * `await sharp(...)` invoked p.then(resolve,reject), the apply trap swallowed
 * the callbacks, and the promise never settled — dsh-vision / any image
 * attachment path hung the session forever. Now `then/catch/finally` return
 * undefined (await resolves to the proxy), so decode paths fail fast with a
 * normal error instead of hanging. */
const SHARP_STUB = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO21vZHVsZS5leHBvcnRzPXA7bW9kdWxlLmV4cG9ydHMuZGVmYXVsdD1wOw==';
const SHARP_STUB_ESM = 'Y29uc3QgcD1uZXcgUHJveHkoZnVuY3Rpb24oKXt9LHtnZXQ6KHQsayk9PihrPT09U3ltYm9sLnRvUHJpbWl0aXZlKT8oKT0+MDooaz09PSd0aGVuJ3x8az09PSdjYXRjaCd8fGs9PT0nZmluYWxseScpP3VuZGVmaW5lZDpwLGFwcGx5OigpPT5wLGNvbnN0cnVjdDooKT0+cH0pO2V4cG9ydCBkZWZhdWx0IHA7';


/* 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。
 * koffi / node-pty 的入口是整体覆写（不依赖上游任何字面量），只要包还在就被顶替；
 * 0.1.7 安装树中两者仍在（koffi 经 dsh-win32-process、node-pty 经 subprocess 相关包）。
 * 未命中时打 'not found, skip'，可诊断。 */
try {
  const ke = findPkg('koffi', 'index.js');
  if (ke) { writeFileSync(ke, Buffer.from(KSTUB, 'base64')); log('koffi ESM stub ok: ' + ke); }
  const kc = findPkg('koffi', 'index.cjs');
  if (kc) { writeFileSync(kc, Buffer.from(KCJS, 'base64')); log('koffi CJS stub ok: ' + kc); }
  if (!ke && !kc) log('koffi: not found, skip');
} catch (e) { log('WARN koffi: ' + e.message); }

try {
  const p = findPkg('node-pty', 'lib/index.js');
  if (p) { writeFileSync(p, Buffer.from(PSTUB, 'base64')); log('node-pty stub ok: ' + p); }
  else log('node-pty: not found, skip');
} catch (e) { log('WARN node-pty: ' + e.message); }

/* 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。
 * sharp 各入口（dist/index.cjs|mjs、dist/sharp.cjs|mjs、lib/index.js、index.js）
 * 均为整体覆写；0.1.7 侧 sharp 由 dsh-attachment-local 视觉链路引用。
 * 全部 target 未命中时打 'sharp: not found, skip'，可诊断。 */
try {
  /* Android 无 libvips：写入纯 JS 兼容层 _dshshim.cjs（PNG 全解码 + 头部探测），
     各入口改为重定向；替代旧 Proxy 桩（旧桩让所有图片判 INVALID_IMAGE 且
     await 永不结算）。实现与视觉链路修复配套。 */
  const SHIM_B64 = 'J3VzZSBzdHJpY3QnOwovKgogKiBQdXJlLUpTIHNoYXJwIGNvbXBhdGliaWxpdHkgc2hpbSBmb3IgRFNIIG9uIEFuZHJvaWQgKG5vIGxpYnZpcHMgYmluYXJpZXMpLgogKiBDb3ZlcnMgdGhlIEFQSSBzdXJmYWNlIGFjdHVhbGx5IHVzZWQgYnkgQGRlZXBzZWVrLWFpL2RzaC1hdHRhY2htZW50LWxvY2FsOgogKiAgIHNoYXJwKGRhdGEsIHtmYWlsT24sIGxpbWl0SW5wdXRQaXhlbHN9KSAtPiAubWV0YWRhdGEoKSAvIC5yYXcoKS50b0J1ZmZlcigpCiAqIEZ1bGwgZGVjb2RlOiBub24taW50ZXJsYWNlZCBQTkcgKGNvbG9yIHR5cGVzIDAvMi8zLzQvNiwgYml0IGRlcHRocyAxLTE2KS4KICogSGVhZGVyLW9ubHkgbWV0YWRhdGE6IFBORyAvIEpQRUcgLyBHSUYgLyBXZWJQLgogKiBBbnl0aGluZyBub3QgaW1wbGVtZW50ZWQgdGhyb3dzIGEgY2xlYXIgZXJyb3IgaW5zdGVhZCBvZiByZXR1cm5pbmcgYSBQcm94eS4KICovCmNvbnN0IGZzID0gcmVxdWlyZSgiZnMiKTsKY29uc3QgemxpYiA9IHJlcXVpcmUoInpsaWIiKTsKCmNsYXNzIFNoaW1FcnJvciBleHRlbmRzIEVycm9yIHt9CgovKiDilIDilIAgZm9ybWF0IHNuaWZmaW5nIOKUgOKUgCAqLwpmdW5jdGlvbiBzbmlmZihidWYpIHsKICBpZiAoYnVmLmxlbmd0aCA+PSA4ICYmIGJ1ZlswXSA9PT0gMHg4OSAmJiBidWZbMV0gPT09IDB4NTAgJiYgYnVmWzJdID09PSAweDRlICYmIGJ1ZlszXSA9PT0gMHg0NykgcmV0dXJuICJwbmciOwogIGlmIChidWYubGVuZ3RoID49IDMgJiYgYnVmWzBdID09PSAweGZmICYmIGJ1ZlsxXSA9PT0gMHhkOCAmJiBidWZbMl0gPT09IDB4ZmYpIHJldHVybiAianBlZyI7CiAgaWYgKGJ1Zi5sZW5ndGggPj0gNiAmJiBidWYudG9TdHJpbmcoImxhdGluMSIsIDAsIDMpID09PSAiR0lGIikgcmV0dXJuICJnaWYiOwogIGlmIChidWYubGVuZ3RoID49IDEyICYmIGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMCwgNCkgPT09ICJSSUZGIiAmJiBidWYudG9TdHJpbmcoImxhdGluMSIsIDgsIDEyKSA9PT0gIldFQlAiKSByZXR1cm4gIndlYnAiOwogIHJldHVybiB1bmRlZmluZWQ7Cn0KCi8qIOKUgOKUgCBQTkcg4pSA4pSAICovCmZ1bmN0aW9uIHBhcnNlUG5nKGJ1ZikgewogIGlmIChidWYudG9TdHJpbmcoImxhdGluMSIsIDEsIDQpICE9PSAiUE5HIikgdGhyb3cgbmV3IFNoaW1FcnJvcigibm90IGEgUE5HIik7CiAgbGV0IHBvcyA9IDg7CiAgY29uc3QgbWV0YSA9IHsgZm9ybWF0OiAicG5nIiB9OwogIGNvbnN0IGlkYXQgPSBbXTsKICB3aGlsZSAocG9zICsgOCA8PSBidWYubGVuZ3RoKSB7CiAgICBjb25zdCBsZW4gPSBidWYucmVhZFVJbnQzMkJFKHBvcyk7CiAgICBjb25zdCB0eXBlID0gYnVmLnRvU3RyaW5nKCJsYXRpbjEiLCBwb3MgKyA0LCBwb3MgKyA4KTsKICAgIGlmICh0eXBlID09PSAiSUhEUiIpIHsKICAgICAgbWV0YS53aWR0aCA9IGJ1Zi5yZWFkVUludDMyQkUocG9zICsgOCk7CiAgICAgIG1ldGEuaGVpZ2h0ID0gYnVmLnJlYWRVSW50MzJCRShwb3MgKyAxMik7CiAgICAgIG1ldGEuZGVwdGggPSBidWZbcG9zICsgMTZdOwogICAgICBtZXRhLmNvbG9yVHlwZSA9IGJ1Zltwb3MgKyAxN107CiAgICAgIG1ldGEuaW50ZXJsYWNlZCA9IGJ1Zltwb3MgKyAyMF07CiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICJQTFRFIikgeyBtZXRhLnBsdGUgPSBCdWZmZXIuZnJvbShidWYuc3ViYXJyYXkocG9zICsgOCwgcG9zICsgOCArIGxlbikpOyB9CiAgICBlbHNlIGlmICh0eXBlID09PSAidFJOUyIpIHsgbWV0YS50cm5zID0gQnVmZmVyLmZyb20oYnVmLnN1YmFycmF5KHBvcyArIDgsIHBvcyArIDggKyBsZW4pKTsgfQogICAgZWxzZSBpZiAodHlwZSA9PT0gIklEQVQiKSB7IGlkYXQucHVzaChidWYuc3ViYXJyYXkocG9zICsgOCwgcG9zICsgOCArIGxlbikpOyB9CiAgICBlbHNlIGlmICh0eXBlID09PSAiSUVORCIpIGJyZWFrOwogICAgcG9zICs9IDEyICsgbGVuOwogIH0KICBpZiAoIW1ldGEud2lkdGggfHwgIW1ldGEuaGVpZ2h0KSB0aHJvdyBuZXcgU2hpbUVycm9yKCJQTkcgbWlzc2luZyBJSERSIGRpbWVuc2lvbnMiKTsKICByZXR1cm4geyBtZXRhLCBpZGF0IH07Cn0KCmNvbnN0IENUX0NIQU5ORUxTID0geyAwOiAxLCAyOiAzLCAzOiAxLCA0OiAyLCA2OiA0IH07Ci8qIFBORyBzcGVjIMKnMTEuMjogYWxsb3dlZCBiaXQgZGVwdGhzIHBlciBjb2xvciB0eXBlICovCmNvbnN0IENUX0RFUFRIUyA9IHsgMDogWzEsIDIsIDQsIDgsIDE2XSwgMjogWzgsIDE2XSwgMzogWzEsIDIsIDQsIDhdLCA0OiBbOCwgMTZdLCA2OiBbOCwgMTZdIH07CgpmdW5jdGlvbiBkZWNvZGVQbmdSYXcoYnVmKSB7CiAgY29uc3QgeyBtZXRhLCBpZGF0IH0gPSBwYXJzZVBuZyhidWYpOwogIGlmIChtZXRhLmludGVybGFjZWQpIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBpbnRlcmxhY2VkIFBORyBpcyBub3Qgc3VwcG9ydGVkIik7CiAgaWYgKCEobWV0YS5jb2xvclR5cGUgaW4gQ1RfQ0hBTk5FTFMpKSB0aHJvdyBuZXcgU2hpbUVycm9yKCJkc2gtc2hpbTogdW5zdXBwb3J0ZWQgUE5HIGNvbG9yIHR5cGUgIiArIG1ldGEuY29sb3JUeXBlKTsKICBjb25zdCBhbGxvd2VkID0gQ1RfREVQVEhTW21ldGEuY29sb3JUeXBlXSB8fCBbXTsKICBpZiAoYWxsb3dlZC5pbmRleE9mKG1ldGEuZGVwdGgpID09PSAtMSkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IGludmFsaWQgUE5HIGJpdCBkZXB0aCAiICsgbWV0YS5kZXB0aCArICIgZm9yIGNvbG9yIHR5cGUgIiArIG1ldGEuY29sb3JUeXBlKTsKICBjb25zdCBXID0gbWV0YS53aWR0aCwgSCA9IG1ldGEuaGVpZ2h0LCBkZXB0aCA9IG1ldGEuZGVwdGgsIGN0ID0gbWV0YS5jb2xvclR5cGU7CiAgY29uc3Qgc3JjQ2ggPSBDVF9DSEFOTkVMU1tjdF07CiAgY29uc3QgYnBwID0gTWF0aC5tYXgoMSwgKHNyY0NoICogZGVwdGgpID4+IDMpOwogIGxldCByYXc7CiAgdHJ5IHsgcmF3ID0gemxpYi5pbmZsYXRlU3luYyhCdWZmZXIuY29uY2F0KGlkYXQpKTsgfQogIGNhdGNoIChlKSB7IHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBQTkcgSURBVCBpbmZsYXRlIGZhaWxlZDogIiArIGUubWVzc2FnZSk7IH0KICBjb25zdCBzdHJpZGUgPSBNYXRoLmNlaWwoKFcgKiBzcmNDaCAqIGRlcHRoKSAvIDgpOwogIGNvbnN0IGxpbmVzID0gQnVmZmVyLmFsbG9jKEggKiBzdHJpZGUpOwogIGxldCBwID0gMDsKICBmb3IgKGxldCB5ID0gMDsgeSA8IEg7IHkrKykgewogICAgaWYgKHAgPj0gcmF3Lmxlbmd0aCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IFBORyBzY2FubGluZSBkYXRhIHRydW5jYXRlZCIpOwogICAgY29uc3QgZnQgPSByYXdbcCsrXTsKICAgIGNvbnN0IGN1ciA9IHkgKiBzdHJpZGUsIHByZXYgPSBjdXIgLSBzdHJpZGU7CiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHN0cmlkZTsgeCsrKSB7CiAgICAgIGNvbnN0IHYgPSBwICsgeCA8IHJhdy5sZW5ndGggPyByYXdbcCArIHhdIDogMDsKICAgICAgY29uc3QgYSA9IHggPj0gYnBwID8gbGluZXNbY3VyICsgeCAtIGJwcF0gOiAwOwogICAgICBjb25zdCBiID0geSA+IDAgPyBsaW5lc1twcmV2ICsgeF0gOiAwOwogICAgICBjb25zdCBjID0gKHggPj0gYnBwICYmIHkgPiAwKSA/IGxpbmVzW3ByZXYgKyB4IC0gYnBwXSA6IDA7CiAgICAgIGxldCBvOwogICAgICBpZiAoZnQgPT09IDApIG8gPSB2OwogICAgICBlbHNlIGlmIChmdCA9PT0gMSkgbyA9ICh2ICsgYSkgJiAyNTU7CiAgICAgIGVsc2UgaWYgKGZ0ID09PSAyKSBvID0gKHYgKyBiKSAmIDI1NTsKICAgICAgZWxzZSBpZiAoZnQgPT09IDMpIG8gPSAodiArICgoYSArIGIpID4+IDEpKSAmIDI1NTsgLyogUE5HIEF2ZXJhZ2UgPSBmbG9vcihsZWZ0ICsgYWJvdmUpLzIgKi8KICAgICAgZWxzZSB7CiAgICAgICAgY29uc3QgcGEgPSBNYXRoLmFicyhhIC0gYyksIHBiID0gTWF0aC5hYnMoYiAtIGMpLCBwYyA9IE1hdGguYWJzKGEgKyBiIC0gMiAqIGMpOwogICAgICAgIGNvbnN0IHByID0gcGEgPD0gcGIgJiYgcGEgPD0gcGMgPyBhIDogcGIgPD0gcGMgPyBiIDogYzsKICAgICAgICBvID0gKHYgKyBwcikgJiAyNTU7CiAgICAgIH0KICAgICAgbGluZXNbY3VyICsgeF0gPSBvOwogICAgfQogICAgcCArPSBzdHJpZGU7CiAgfQogIC8qIGV4cGFuZCB0byA4LWJpdCBSR0Igb3IgUkdCQSAqLwogIGNvbnN0IGFscGhhID0gY3QgPT09IDQgfHwgY3QgPT09IDYgfHwgKGN0ID09PSAzICYmIG1ldGEudHJucyk7CiAgY29uc3Qgb3V0Q2ggPSBhbHBoYSA/IDQgOiAzOwogIGNvbnN0IG91dCA9IEJ1ZmZlci5hbGxvYyhXICogSCAqIG91dENoKTsKICBjb25zdCByZWFkU2FtcGxlID0gKGJhc2UsIGlkeCkgPT4gewogICAgaWYgKGRlcHRoID09PSA4KSByZXR1cm4gbGluZXNbYmFzZSArIGlkeF07CiAgICBpZiAoZGVwdGggPT09IDE2KSByZXR1cm4gbGluZXNbYmFzZSArIGlkeCAqIDJdOyAvKiB0YWtlIGhpZ2ggYnl0ZSAqLwogICAgLyogc3ViLWJ5dGUgZGVwdGhzIChncmF5IDEvMi80IG9ubHkpICovCiAgICBjb25zdCBiaXRQb3MgPSBpZHggKiBkZXB0aCwgYnl0ZSA9IGxpbmVzW2Jhc2UgKyAoYml0UG9zID4+IDMpXTsKICAgIGNvbnN0IHNoaWZ0ID0gOCAtIGRlcHRoIC0gKGJpdFBvcyAmIDcpOwogICAgY29uc3QgbWFzayA9ICgxIDw8IGRlcHRoKSAtIDE7CiAgICBjb25zdCB2YWwgPSAoYnl0ZSA+PiBzaGlmdCkgJiBtYXNrOwogICAgcmV0dXJuIE1hdGgucm91bmQoKHZhbCAqIDI1NSkgLyBtYXNrKTsKICB9OwogIGZvciAobGV0IHkgPSAwOyB5IDwgSDsgeSsrKSB7CiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IFc7IHgrKykgewogICAgICBjb25zdCBiYXNlID0geSAqIHN0cmlkZSArIE1hdGguZmxvb3IoKHggKiBzcmNDaCAqIGRlcHRoKSAvIDgpOwogICAgICBjb25zdCBkaSA9ICh5ICogVyArIHgpICogb3V0Q2g7CiAgICAgIGlmIChjdCA9PT0gMCkgewogICAgICAgIC8qIHN1Yi1ieXRlIGdyYXkgcGFja3MgcGl4ZWxzIE1TQi1maXJzdCBhY3Jvc3MgdGhlIHJvdzogYml0IG9mZnNldCBtdXN0IGNvbWUgZnJvbSB4LCBub3QgZnJvbSBiYXNlIGFsb25lICovCiAgICAgICAgbGV0IGc7CiAgICAgICAgaWYgKGRlcHRoID49IDgpIGcgPSBsaW5lc1tiYXNlXTsgLyogMTYtYml0OiB0YWtlIGhpZ2ggYnl0ZSAqLwogICAgICAgIGVsc2UgewogICAgICAgICAgY29uc3QgYml0UG9zID0geCAqIGRlcHRoOwogICAgICAgICAgY29uc3QgYnl0ZSA9IGxpbmVzW3kgKiBzdHJpZGUgKyAoYml0UG9zID4+IDMpXTsKICAgICAgICAgIGNvbnN0IG1hc2sgPSAoMSA8PCBkZXB0aCkgLSAxOwogICAgICAgICAgZyA9IE1hdGgucm91bmQoKCgoYnl0ZSA+PiAoOCAtIGRlcHRoIC0gKGJpdFBvcyAmIDcpKSkgJiBtYXNrKSAqIDI1NSkgLyBtYXNrKTsKICAgICAgICB9CiAgICAgICAgb3V0W2RpXSA9IG91dFtkaSArIDFdID0gb3V0W2RpICsgMl0gPSBnOwogICAgICB9CiAgICAgIGVsc2UgaWYgKGN0ID09PSAyKSB7IG91dFtkaV0gPSByZWFkU2FtcGxlKGJhc2UsIDApOyBvdXRbZGkgKyAxXSA9IHJlYWRTYW1wbGUoYmFzZSArIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDJdID0gcmVhZFNhbXBsZShiYXNlICsgMiAqIChkZXB0aCA+PiAzKSwgMCk7IGlmIChhbHBoYSkgb3V0W2RpICsgM10gPSAyNTU7IH0KICAgICAgZWxzZSBpZiAoY3QgPT09IDQpIHsgY29uc3QgZyA9IHJlYWRTYW1wbGUoYmFzZSwgMCk7IG91dFtkaV0gPSBvdXRbZGkgKyAxXSA9IG91dFtkaSArIDJdID0gZzsgb3V0W2RpICsgM10gPSBkZXB0aCA9PT0gMTYgPyBsaW5lc1t5ICogc3RyaWRlICsgeCAqIDQgKyAyXSA6IGxpbmVzW3kgKiBzdHJpZGUgKyB4ICogMiArIDFdOyB9CiAgICAgIGVsc2UgaWYgKGN0ID09PSA2KSB7IG91dFtkaV0gPSByZWFkU2FtcGxlKGJhc2UsIDApOyBvdXRbZGkgKyAxXSA9IHJlYWRTYW1wbGUoYmFzZSArIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDJdID0gcmVhZFNhbXBsZShiYXNlICsgMiAqIChkZXB0aCA+PiAzKSwgMCk7IG91dFtkaSArIDNdID0gZGVwdGggPT09IDE2ID8gcmVhZFNhbXBsZShiYXNlICsgMyAqIChkZXB0aCA+PiAzKSwgMCkgOiByZWFkU2FtcGxlKGJhc2UgKyAzLCAwKTsgfQogICAgICBlbHNlIHsgLyogcGFsZXR0ZSAqLwogICAgICAgIGNvbnN0IGlkeCA9IGRlcHRoIDwgOCA/ICgoKSA9PiB7IGNvbnN0IGJpdFBvcyA9IHggKiBkZXB0aDsgY29uc3QgYnl0ZSA9IGxpbmVzW3kgKiBzdHJpZGUgKyAoYml0UG9zID4+IDMpXTsgcmV0dXJuIChieXRlID4+ICg4IC0gZGVwdGggLSAoYml0UG9zICYgNykpKSAmICgoMSA8PCBkZXB0aCkgLSAxKTsgfSkoKSA6IGxpbmVzW3kgKiBzdHJpZGUgKyB4XTsKICAgICAgICBjb25zdCBwbHRlID0gbWV0YS5wbHRlOwogICAgICAgIGlmICghcGx0ZSB8fCBpZHggKiAzICsgMiA+PSBwbHRlLmxlbmd0aCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IFBORyBwYWxldHRlIGluZGV4IG91dCBvZiByYW5nZSIpOwogICAgICAgIG91dFtkaV0gPSBwbHRlW2lkeCAqIDNdOyBvdXRbZGkgKyAxXSA9IHBsdGVbaWR4ICogMyArIDFdOyBvdXRbZGkgKyAyXSA9IHBsdGVbaWR4ICogMyArIDJdOwogICAgICAgIG91dFtkaSArIDNdID0gbWV0YS50cm5zICYmIGlkeCA8IG1ldGEudHJucy5sZW5ndGggPyBtZXRhLnRybnNbaWR4XSA6IDI1NTsKICAgICAgfQogICAgfQogIH0KICByZXR1cm4geyBkYXRhOiBvdXQsIHdpZHRoOiBXLCBoZWlnaHQ6IEgsIGNoYW5uZWxzOiBvdXRDaCB9Owp9CgovKiDilIDilIAgSlBFRyBoZWFkZXIg4pSA4pSAICovCmZ1bmN0aW9uIHBhcnNlSnBlZyhidWYpIHsKICBsZXQgcG9zID0gMjsKICB3aGlsZSAocG9zICsgOSA8PSBidWYubGVuZ3RoKSB7CiAgICBpZiAoYnVmW3Bvc10gIT09IDB4ZmYpIHsgcG9zKys7IGNvbnRpbnVlOyB9CiAgICBjb25zdCBtYXJrZXIgPSBidWZbcG9zICsgMV07CiAgICBpZiAobWFya2VyID09PSAweGQ4IHx8IG1hcmtlciA9PT0gMHgwMSB8fCAobWFya2VyID49IDB4ZDAgJiYgbWFya2VyIDw9IDB4ZDcpKSB7IHBvcyArPSAyOyBjb250aW51ZTsgfQogICAgY29uc3QgbGVuID0gYnVmLnJlYWRVSW50MTZCRShwb3MgKyAyKTsKICAgIGlmICgobWFya2VyID49IDB4YzAgJiYgbWFya2VyIDw9IDB4Y2YpICYmIG1hcmtlciAhPT0gMHhjNCAmJiBtYXJrZXIgIT09IDB4YzggJiYgbWFya2VyICE9PSAweGNjKSB7CiAgICAgIHJldHVybiB7IGZvcm1hdDogImpwZWciLCB3aWR0aDogYnVmLnJlYWRVSW50MTZCRShwb3MgKyA3KSwgaGVpZ2h0OiBidWYucmVhZFVJbnQxNkJFKHBvcyArIDUpLCBkZXB0aDogOCwgY2hhbm5lbHM6IGJ1Zltwb3MgKyA5XSB9OwogICAgfQogICAgcG9zICs9IDIgKyBsZW47CiAgfQogIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiBKUEVHIFNPRiBtYXJrZXIgbm90IGZvdW5kIik7Cn0KCi8qIOKUgOKUgCBXZWJQIGhlYWRlciDilIDilIAgKi8KZnVuY3Rpb24gcGFyc2VXZWJwKGJ1ZikgewogIGNvbnN0IGZvdXJjYyA9IGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMTIsIDE2KTsKICBpZiAoZm91cmNjID09PSAiVlA4WCIpIHsKICAgIHJldHVybiB7IGZvcm1hdDogIndlYnAiLCB3aWR0aDogMSArIChidWZbMjRdIHwgKGJ1ZlsyNV0gPDwgOCkgfCAoYnVmWzI2XSA8PCAxNikpLCBoZWlnaHQ6IDEgKyAoYnVmWzI3XSB8IChidWZbMjhdIDw8IDgpIHwgKGJ1ZlsyOV0gPDwgMTYpKSwgZGVwdGg6IDgsIGNoYW5uZWxzOiA0IH07CiAgfQogIGlmIChmb3VyY2MgPT09ICJWUDggIikgewogICAgcmV0dXJuIHsgZm9ybWF0OiAid2VicCIsIHdpZHRoOiBidWYucmVhZFVJbnQxNkxFKDI2KSAmIDB4M2ZmZiwgaGVpZ2h0OiBidWYucmVhZFVJbnQxNkxFKDI4KSAmIDB4M2ZmZiwgZGVwdGg6IDgsIGNoYW5uZWxzOiAzIH07CiAgfQogIGlmIChmb3VyY2MgPT09ICJWUDhMIikgewogICAgY29uc3QgYml0cyA9IGJ1Zi5yZWFkVUludDMyTEUoMjEpOwogICAgcmV0dXJuIHsgZm9ybWF0OiAid2VicCIsIHdpZHRoOiAoYml0cyAmIDB4M2ZmZikgKyAxLCBoZWlnaHQ6ICgoYml0cyA+PiAxNCkgJiAweDNmZmYpICsgMSwgZGVwdGg6IDgsIGNoYW5uZWxzOiA0IH07CiAgfQogIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiB1bnN1cHBvcnRlZCBXZWJQIGNodW5rICIgKyBKU09OLnN0cmluZ2lmeShmb3VyY2MpKTsKfQoKZnVuY3Rpb24gY29tcHV0ZU1ldGEoYnVmKSB7CiAgY29uc3QgZm10ID0gc25pZmYoYnVmKTsKICBpZiAoIWZtdCkgdGhyb3cgbmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IHVuc3VwcG9ydGVkIG9yIHVucmVjb2duaXplZCBpbWFnZSBkYXRhIik7CiAgaWYgKGZtdCA9PT0gInBuZyIpIHsKICAgIGNvbnN0IHsgbWV0YSB9ID0gcGFyc2VQbmcoYnVmKTsKICAgIGNvbnN0IHNwYWNlID0gbWV0YS5jb2xvclR5cGUgPT09IDAgfHwgbWV0YS5jb2xvclR5cGUgPT09IDQgPyAiYi13IiA6IG1ldGEuY29sb3JUeXBlID09PSAzID8gInNyZ2IiIDogInNyZ2IiOwogICAgcmV0dXJuIHsgZm9ybWF0OiAicG5nIiwgd2lkdGg6IG1ldGEud2lkdGgsIGhlaWdodDogbWV0YS5oZWlnaHQsIHNwYWNlLCBjaGFubmVsczogQ1RfQ0hBTk5FTFNbbWV0YS5jb2xvclR5cGVdIHx8IDMsIGRlcHRoOiBTdHJpbmcobWV0YS5kZXB0aCksIGNocm9tYVN1YnNhbXBsaW5nOiAiNDo0OjQiLCBpc1Byb2dyZXNzaXZlOiBmYWxzZSB9OwogIH0KICBpZiAoZm10ID09PSAianBlZyIpIHJldHVybiBPYmplY3QuYXNzaWduKHsgY2hyb21hU3Vic2FtcGxpbmc6ICI0OjI6MCIsIGlzUHJvZ3Jlc3NpdmU6IGZhbHNlIH0sIHBhcnNlSnBlZyhidWYpKTsKICBpZiAoZm10ID09PSAiZ2lmIikgcmV0dXJuIHsgZm9ybWF0OiAiZ2lmIiwgd2lkdGg6IGJ1Zi5yZWFkVUludDE2TEUoNiksIGhlaWdodDogYnVmLnJlYWRVSW50MTZMRSg4KSwgYW5pbWF0ZWQ6IGJ1Zi50b1N0cmluZygibGF0aW4xIiwgMTAsIDEzKSA9PT0gIk5FVCIsIHBhZ2VzOiAxIH07CiAgcmV0dXJuIHBhcnNlV2VicChidWYpOwp9CgovKiDilIDilIAgaW5zdGFuY2Ug4pSA4pSAICovCmNsYXNzIFNoYXJwSW5zdGFuY2UgewogIGNvbnN0cnVjdG9yKGlucHV0KSB7CiAgICB0aGlzLl9pbiA9IGlucHV0OwogICAgdGhpcy5fbW9kZSA9IG51bGw7ICAgICAgICAgIC8qIG51bGwgfCAncmF3JyAqLwogICAgdGhpcy5fcmVzaXplVG8gPSBudWxsOyAgICAgIC8qIHt3aWR0aCxoZWlnaHR9IG5lYXJlc3QtbmVpZ2hib3VyICovCiAgICBzbmlmZih0aGlzLl9pbik7ICAgICAgICAgICAgLyogZmFpbCBmYXN0IG9uIGdhcmJhZ2UgKi8KICB9CiAgbWV0YWRhdGEoKSB7CiAgICB0cnkgeyByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGNvbXB1dGVNZXRhKHRoaXMuX2luKSk7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBQcm9taXNlLnJlamVjdChlKTsgfQogIH0KICByYXcoKSB7IHRoaXMuX21vZGUgPSAicmF3IjsgcmV0dXJuIHRoaXM7IH0KICByZXNpemUod2lkdGgsIGhlaWdodCkgewogICAgdGhpcy5fcmVzaXplVG8gPSB7IHdpZHRoOiB3aWR0aCB8fCBudWxsLCBoZWlnaHQ6IGhlaWdodCB8fCBudWxsIH07CiAgICByZXR1cm4gdGhpczsKICB9CiAgcm90YXRlKCkgeyByZXR1cm4gdGhpczsgfQogIGZsYXR0ZW4oKSB7IHJldHVybiB0aGlzOyB9CiAgd2l0aE1ldGFkYXRhKCkgeyByZXR1cm4gdGhpczsgfQogIGdyZXlzY2FsZSgpIHsgcmV0dXJuIHRoaXM7IH0KICBncmF5c2NhbGUoKSB7IHJldHVybiB0aGlzOyB9CiAgcG5nKCkgeyB0aGlzLl9yZWVuY29kZSA9ICJwbmciOyByZXR1cm4gdGhpczsgfQogIGpwZWcoKSB7IHRoaXMuX3JlZW5jb2RlID0gImpwZWciOyByZXR1cm4gdGhpczsgfQogIHdlYnAoKSB7IHRoaXMuX3JlZW5jb2RlID0gIndlYnAiOyByZXR1cm4gdGhpczsgfQogIGNsb25lKCkgeyBjb25zdCBjID0gbmV3IFNoYXJwSW5zdGFuY2UodGhpcy5faW4pOyBjLl9tb2RlID0gdGhpcy5fbW9kZTsgYy5fcmVzaXplVG8gPSB0aGlzLl9yZXNpemVUbzsgYy5fcmVlbmNvZGUgPSB0aGlzLl9yZWVuY29kZTsgcmV0dXJuIGM7IH0KICB0b0J1ZmZlcihvcHRpb25zKSB7CiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiB7CiAgICAgIGlmICh0aGlzLl9yZWVuY29kZSAmJiBzbmlmZih0aGlzLl9pbikgIT09IHRoaXMuX3JlZW5jb2RlKQogICAgICAgIHRocm93IG5ldyBTaGltRXJyb3IoImRzaC1zaGltOiByZS1lbmNvZGluZyB0byAiICsgdGhpcy5fcmVlbmNvZGUgKyAiIGlzIG5vdCBzdXBwb3J0ZWQgKG5vIGxpYnZpcHMgb24gdGhpcyBwbGF0Zm9ybSkiKTsKICAgICAgaWYgKHRoaXMuX21vZGUgPT09ICJyYXciIHx8IHRoaXMuX3Jlc2l6ZVRvKSB7CiAgICAgICAgY29uc3QgZGVjb2RlZCA9IGRlY29kZVBuZ0FueSh0aGlzLl9pbik7CiAgICAgICAgbGV0IHsgZGF0YSwgd2lkdGgsIGhlaWdodCwgY2hhbm5lbHMgfSA9IGRlY29kZWQ7CiAgICAgICAgaWYgKHRoaXMuX3Jlc2l6ZVRvICYmICh0aGlzLl9yZXNpemVUby53aWR0aCB8fCB0aGlzLl9yZXNpemVUby5oZWlnaHQpKSB7CiAgICAgICAgICBjb25zdCBydCA9IHRoaXMuX3Jlc2l6ZVRvOwogICAgICAgICAgY29uc3QgdzIgPSBydC53aWR0aCB8fCBNYXRoLnJvdW5kKHdpZHRoICogKHJ0LmhlaWdodCAvIGhlaWdodCkpOwogICAgICAgICAgY29uc3QgaDIgPSBydC5oZWlnaHQgfHwgTWF0aC5yb3VuZChoZWlnaHQgKiAocnQud2lkdGggLyB3aWR0aCkpOwogICAgICAgICAgY29uc3Qgb3V0ID0gQnVmZmVyLmFsbG9jKHcyICogaDIgKiBjaGFubmVscyk7CiAgICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGgyOyB5KyspIHsKICAgICAgICAgICAgY29uc3Qgc3kgPSBNYXRoLm1pbihoZWlnaHQgLSAxLCBNYXRoLmZsb29yKCh5ICogaGVpZ2h0KSAvIGgyKSk7CiAgICAgICAgICAgIGZvciAobGV0IHggPSAwOyB4IDwgdzI7IHgrKykgewogICAgICAgICAgICAgIGNvbnN0IHN4ID0gTWF0aC5taW4od2lkdGggLSAxLCBNYXRoLmZsb29yKCh4ICogd2lkdGgpIC8gdzIpKTsKICAgICAgICAgICAgICBjb25zdCBzbyA9IChzeSAqIHdpZHRoICsgc3gpICogY2hhbm5lbHMsIGRvZmYgPSAoeSAqIHcyICsgeCkgKiBjaGFubmVsczsKICAgICAgICAgICAgICBmb3IgKGxldCBjaCA9IDA7IGNoIDwgY2hhbm5lbHM7IGNoKyspIG91dFtkb2ZmICsgY2hdID0gZGF0YVtzbyArIGNoXTsKICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgICAgZGF0YSA9IG91dDsgd2lkdGggPSB3MjsgaGVpZ2h0ID0gaDI7CiAgICAgICAgfQogICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucmVzb2x2ZVdpdGhPYmplY3QpIHJldHVybiB7IGRhdGEsIGluZm86IHsgd2lkdGgsIGhlaWdodCwgY2hhbm5lbHMgfSB9OwogICAgICAgIHJldHVybiBkYXRhOwogICAgICB9CiAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucmVzb2x2ZVdpdGhPYmplY3QpIHsKICAgICAgICBjb25zdCBtID0gY29tcHV0ZU1ldGEodGhpcy5faW4pOwogICAgICAgIHJldHVybiB7IGRhdGE6IHRoaXMuX2luLCBpbmZvOiB7IGZvcm1hdDogbS5mb3JtYXQsIHdpZHRoOiBtLndpZHRoLCBoZWlnaHQ6IG0uaGVpZ2h0IH0gfTsKICAgICAgfQogICAgICByZXR1cm4gdGhpcy5faW47CiAgICB9KTsKICB9Cn0KCmZ1bmN0aW9uIGRlY29kZVBuZ0FueShidWYpIHsKICBjb25zdCBmbXQgPSBzbmlmZihidWYpOwogIGlmIChmbXQgIT09ICJwbmciKSB0aHJvdyBuZXcgU2hpbUVycm9yKCJkc2gtc2hpbTogZnVsbCBwaXhlbCBkZWNvZGUgb25seSBzdXBwb3J0ZWQgZm9yIFBORyBvbiB0aGlzIHBsYXRmb3JtIChnb3QgIiArIChmbXQgfHwgInVua25vd24iKSArICIpIik7CiAgcmV0dXJuIGRlY29kZVBuZ1JhdyhidWYpOwp9CgovKiBjYWxsYWJsZSB3aXRoIG9yIHdpdGhvdXQgYG5ld2AgKi8KZnVuY3Rpb24gc2hhcnAoaW5wdXQsIG9wdGlvbnMpIHsKICBsZXQgYnVmID0gaW5wdXQ7CiAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gInN0cmluZyIpIGJ1ZiA9IGZzLnJlYWRGaWxlU3luYyhpbnB1dCk7CiAgZWxzZSBpZiAoaW5wdXQgaW5zdGFuY2VvZiBVaW50OEFycmF5ICYmICFCdWZmZXIuaXNCdWZmZXIoaW5wdXQpKSBidWYgPSBCdWZmZXIuZnJvbShpbnB1dCk7CiAgZWxzZSBpZiAoaW5wdXQgJiYgdHlwZW9mIGlucHV0LnBpcGUgPT09ICJmdW5jdGlvbiIpCiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFNoaW1FcnJvcigiZHNoLXNoaW06IHN0cmVhbSBpbnB1dCBpcyBub3Qgc3VwcG9ydGVkIikpOwogIHJldHVybiBuZXcgU2hhcnBJbnN0YW5jZShidWYpOwp9CnNoYXJwLnZlcnNpb25zID0geyB2aXBzOiAibm9uZSIsICJkc2gtc2hpbSI6ICIxLjAuMC1wdXJlanMiIH07CnNoYXJwLmZvcm1hdCA9IFsianBlZyIsICJwbmciLCAid2VicCIsICJnaWYiLCAic3ZnIiwgInRpZmYiLCAiYXZpZiJdLnJlZHVjZSgoYWNjLCBpZCkgPT4gewogIGFjY1tpZF0gPSB7IGlkLCBpbnB1dDogeyBidWZmZXI6IFsianBlZyIsICJwbmciLCAid2VicCIsICJnaWYiXS5pbmNsdWRlcyhpZCksIGZpbGU6IGZhbHNlLCBzdHJlYW06IGZhbHNlIH0sIG91dHB1dDogeyBidWZmZXI6IGlkID09PSAicG5nIiwgZmlsZTogZmFsc2UsIHN0cmVhbTogZmFsc2UgfSB9OwogIHJldHVybiBhY2M7Cn0sIHt9KTsKc2hhcnAuZGVmaW5pdGlvbnMgPSB7fTsKc2hhcnAudmVuZG9yID0gIiI7CnNoYXJwLmlzU2hpbSA9IHRydWU7Cgptb2R1bGUuZXhwb3J0cyA9IHNoYXJwOwptb2R1bGUuZXhwb3J0cy5kZWZhdWx0ID0gc2hhcnA7Cm1vZHVsZS5leHBvcnRzLlNoYXJwID0gU2hhcnBJbnN0YW5jZTsK';
  const targets = [
    ['sharp', 'dist/index.cjs', './_dshshim.cjs'],
    ['sharp', 'dist/index.mjs', './_dshshim.cjs'],
    ['sharp', 'dist/sharp.cjs', './_dshshim.cjs'],
    ['sharp', 'dist/sharp.mjs', './_dshshim.cjs'],
    ['sharp', 'lib/index.js', '../dist/_dshshim.cjs'],
    ['sharp', 'index.js', './dist/_dshshim.cjs'],
  ];
  const writtenShims = [];
  let n = 0;
  for (const [pkg, rel, req] of targets) {
    const p = findPkg(pkg, rel);
    if (!p) continue;
    const rootDir = p.slice(0, p.length - rel.length - 1);
    const shimAbs = join(rootDir, 'dist', '_dshshim.cjs');
    if (!writtenShims.includes(shimAbs)) {
      writeFileSync(shimAbs, Buffer.from(SHIM_B64, 'base64'));
      writtenShims.push(shimAbs);
    }
    const payload = rel.endsWith('.mjs')
      ? 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);const s=require(' + JSON.stringify(req) + ');export default s;export const versions=s.versions;export const format=s.format;'
      : 'module.exports=require(' + JSON.stringify(req) + ');module.exports.default=module.exports;';
    writeFileSync(p, payload);
    log('sharp shim ok: ' + p);
    n++;
  }
  if (n === 0) log('sharp: not found, skip');
} catch (e) { log('WARN sharp shim: ' + e.message); }

try {
  /* node-addon-require-builtin 纯 JS 顶替（**已针对 0.1.7-rc.2 核实**）
   *
   * 为什么必须新增（**boot 级硬阻断，不是降级**）：dsh 0.1.7 把 profile 模块解析
   * 重构为依赖原生插件 node-addon-require-builtin——
   *   dsh-app-boot/lib/index.js:1573 internalModules() 用它 requireBuiltin() 拿 5 个
   *   Node 内部模块（internal/modules/{esm/loader,cjs/loader,helpers,esm/utils,esm/resolve}）；
   *   调用链 internalModules ← installRuntimeInterception(:1641) ← PluginPackages 构造
   *   ← runProfile 的 **boot prepare 回调**，**早于任何插件树加载**。
   * 该插件在**模块加载期**就急切加载原生二进制：
   *   node-addon-native-custom-loader/lib/index.js:552 createEntryApi 顶层即调 loadEntry(:496)。
   * Android 没有该包的任何预编译产物：node-addon-require-builtin-android-arm64 在 registry
   * 上 404，其 optionalDependencies 只列了 darwin/linux/win32 共 7 个平台包。
   * → require 期同步抛 "No usable native binding found"，失败点在插件树挂载**之前**，
   *   日志里只有「web 未就绪」，**没有任何插件级报错**（极易误判为网络/端口问题）。
   *
   * 顶替原理：启动器本来就以 --expose-internals 启动 dsh
   *   （DshFlow.startDshWeb: node --expose-internals --import fs-register.mjs <cli> web），
   * 该开关让 require('internal/modules/…') 直接可用，与原生插件 requireBuiltin 语义等价。
   * 实测（Node 22.17 / --expose-internals）app-boot 的**完整校验谓词全部通过**：
   *   resolveSync / getOrCreateModuleJob|getModuleJobForImport / Module._resolveFilename /
   *   getCjsConditions / getDefaultConditions / defaultResolve，且
   *   「与直接 require 拿到的是同一个 Node 真实 loader 对象」。
   * 缺少 --expose-internals 时**显式抛错并说明原因**（不是静默返回空对象）——静默会让
   * app-boot 的校验抛「unsupported Node module loader」，反而掩盖真实原因。
   *
   * 覆写方式与 koffi / node-pty 同性质（整体覆写入口，非锚点插桩）；payload 为 base64
   * 常量，末尾自带 marker 注释 'dsh-launcher-android-narb-shim-v1'。 */
  const NARB_B64 =
    'Ly8gZHNoLWxhdW5jaGVyLWFuZHJvaWQtbmFyYi1zaGltLXYxCid1c2Ugc3RyaWN0JzsKLyoqCiAqIG5vZGUtYWRk' +
    'b24tcmVxdWlyZS1idWlsdGluIOKAlCBBbmRyb2lkIOe6ryBKUyDpobbmm7/lrp7njrDjgIIKICoKICog5Li65LuA' +
    '5LmI5b+F6aG75a2Y5Zyo77yaZHNoIDAuMS43IOaKiiBwcm9maWxlIOaooeWdl+ino+aekOmHjeaehOS4uuS+nei1' +
    'lui/meS4qioq5Y6f55Sf5o+S5Lu2KirigJTigJQKICogZHNoLWFwcC1ib290IOeahCBpbnRlcm5hbE1vZHVsZXMo' +
    'KSDnlKjlroPmi78gTm9kZSDlhoXpg6jmqKHlnZfvvIhpbnRlcm5hbC9tb2R1bGVzLy4uLu+8ie+8jAogKiDogIzl' +
    'roPlnKgqKuaooeWdl+WKoOi9veacnyoq77yIY3JlYXRlRW50cnlBcGkg4oaSIGxvYWRFbnRyee+8ieWwseaApeWI' +
    'h+WKoOi9veWOn+eUn+S6jOi/m+WItuOAggogKgogKiBBbmRyb2lkIOayoeacieivpeWMheeahOS7u+S9lemihOe8' +
    'luivkeS6p+eJqe+8iG5vZGUtYWRkb24tcmVxdWlyZS1idWlsdGluLWFuZHJvaWQtYXJtNjQg5ZyoCiAqIHJlZ2lz' +
    'dHJ5IOS4iiA0MDTvvIxvcHRpb25hbERlcGVuZGVuY2llcyDlj6rliJfkuoYgZGFyd2luL2xpbnV4L3dpbjMy77yJ' +
    '77yM5LqO5pivIHJlcXVpcmUKICog5pyf5ZCM5q2l5oqbICJObyB1c2FibGUgbmF0aXZlIGJpbmRpbmcgZm91bmQi' +
    '44CCCiAqCiAqIOWksei0peS9jee9ruWcqCAqKmJvb3Qg55qEIHByZXBhcmUg5Zue6LCD6YeM44CB5Lu75L2V5o+S' +
    '5Lu25qCR5Yqg6L295LmL5YmNKirvvIhkc2gvbGliL3Byb2ZpbGUtYm9vdAogKiDnmoQgcnVuUHJvZmlsZSDihpIg' +
    'UGx1Z2luUGFja2FnZXMg5p6E6YCgIOKGkiBpbnN0YWxsUnVudGltZUludGVyY2VwdGlvbiDihpIgaW50ZXJuYWxN' +
    'b2R1bGVz77yJ77yMCiAqIOWboOatpOaXpeW/l+mHjOWPquacieOAjHdlYiDmnKrlsLHnu6rjgI3vvIwqKuayoeac' +
    'ieS7u+S9leaPkuS7tue6p+aKpemUmSoq4oCU4oCU5p6B5piT6K+v5Yik5Li6572R57ucL+err+WPo+mXrumimOOA' +
    'ggogKgogKiDpobbmm7/ljp/nkIbvvJrlkK/liqjlmajmnKzmnaXlsLHku6UgLS1leHBvc2UtaW50ZXJuYWxzIOWQ' +
    'r+WKqCBkc2jvvIjop4EgRHNoRmxvdy5zdGFydERzaFdlYu+8ie+8jAogKiDor6XlvIDlhbPorqkgcmVxdWlyZSgn' +
    'aW50ZXJuYWwvbW9kdWxlcy8uLi4nKSDnm7TmjqXlj6/nlKjvvIzkuI7ljp/nlJ/mj5Lku7bnmoQgcmVxdWlyZUJ1' +
    'aWx0aW4KICog6K+t5LmJ562J5Lu344CC5a6e5rWL5pys5py6IE5vZGUgMjYg5LiLIGFwcC1ib290IOeahOWujOaV' +
    'tOagoemqjOiwk+ivjeWFqOmDqOmAmui/hwogKiDvvIhyZXNvbHZlU3luYyAvIGdldE9yQ3JlYXRlTW9kdWxlSm9i' +
    'fGdldE1vZHVsZUpvYkZvckltcG9ydCAvIE1vZHVsZS5fcmVzb2x2ZUZpbGVuYW1lIC8KICogICBnZXRDanNDb25k' +
    'aXRpb25zIC8gZ2V0RGVmYXVsdENvbmRpdGlvbnMgLyBkZWZhdWx0UmVzb2x2Ze+8ieOAggogKgogKiDms6jmhI/v' +
    'vJotLWV4cG9zZS1pbnRlcm5hbHMg57y65aSx5pe26L+Z6YeM5LyaKirmmL7lvI/mipvplJnlubbor7TmmI7ljp/l' +
    'm6AqKu+8jOiAjOS4jeaYr+mdmem7mOmZjee6p+KAlOKAlAogKiDpnZnpu5jov5Tlm57nqbrlr7nosaHkvJrorqkg' +
    'YXBwLWJvb3Qg55qE5qCh6aqM5oqb44CMdW5zdXBwb3J0ZWQgTm9kZSBtb2R1bGUgbG9hZGVy44CN77yMCiAqIOWP' +
    'jeiAjOaOqeebluecn+WunuWOn+WboOOAggogKi8KY29uc3QgeyBjcmVhdGVSZXF1aXJlIH0gPSByZXF1aXJlKCdu' +
    'b2RlOm1vZHVsZScpOwpjb25zdCByZXEgPSBjcmVhdGVSZXF1aXJlKF9fZmlsZW5hbWUpOwoKY29uc3QgSU5URVJO' +
    'QUxfTU9EVUxFUyA9IHsKICAnaW50ZXJuYWwvbW9kdWxlcy9lc20vbG9hZGVyJzogbnVsbCwKICAnaW50ZXJuYWwv' +
    'bW9kdWxlcy9janMvbG9hZGVyJzogbnVsbCwKICAnaW50ZXJuYWwvbW9kdWxlcy9oZWxwZXJzJzogbnVsbCwKICAn' +
    'aW50ZXJuYWwvbW9kdWxlcy9lc20vdXRpbHMnOiBudWxsLAogICdpbnRlcm5hbC9tb2R1bGVzL2VzbS9yZXNvbHZl' +
    'JzogbnVsbCwKfTsKY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7CgpmdW5jdGlvbiByZXF1aXJlQnVpbHRpbihtb2R1' +
    'bGVJZCkgewogIGlmIChjYWNoZS5oYXMobW9kdWxlSWQpKSByZXR1cm4gY2FjaGUuZ2V0KG1vZHVsZUlkKTsKICBs' +
    'ZXQgbW9kOwogIHRyeSB7CiAgICBtb2QgPSByZXEobW9kdWxlSWQpOwogIH0gY2F0Y2ggKGUpIHsKICAgIHRocm93' +
    'IG5ldyBFcnJvcigKICAgICAgJ25vZGUtYWRkb24tcmVxdWlyZS1idWlsdGluKHNoaW0pOiDml6Dms5XliqDovb3l' +
    'hoXpg6jmqKHlnZcgIicgKyBtb2R1bGVJZCArICci44CCJyArCiAgICAgICfmnKzpobbmm7/lrp7njrDkvp3otZYg' +
    'Tm9kZSDku6UgLS1leHBvc2UtaW50ZXJuYWxzIOWQr+WKqO+8iGRzaCDlkK/liqjlkb3ku6Tlt7LluKbor6Xlj4Lm' +
    'lbDvvInvvJsnICsKICAgICAgJ+iLpeeci+WIsOacrOadoe+8jOivtOaYjuWQr+WKqOWPguaVsOiiq+aUueWKqOOA' +
    'guWOn+Wni+mUmeivrzogJyArIChlICYmIGUubWVzc2FnZSkKICAgICk7CiAgfQogIGNhY2hlLnNldChtb2R1bGVJ' +
    'ZCwgbW9kKTsKICByZXR1cm4gbW9kOwp9CgovKiog5LiO5Y6f55Sf5o+S5Lu25ZCM5b2i55qE55m95ZCN5Y2V5Yik' +
    '5a6a77ya5Y+q5pS+6KGMIGRzaCDlrp7pmYXkvJrnlKjnmoTov5kgNSDkuKrlhoXpg6jmqKHlnZfjgIIgKi8KZnVu' +
    'Y3Rpb24gaXNBbGxvd2VkSW50ZXJuYWxJZChtb2R1bGVJZCkgewogIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhh' +
    'c093blByb3BlcnR5LmNhbGwoSU5URVJOQUxfTU9EVUxFUywgbW9kdWxlSWQpOwp9CgovKiog5Y6f55Sf5a6e546w' +
    '6L+U5ZueIGJpbmRpbmcg5YWD5L+h5oGv77yb5q2k5aSE5qCH5piO5Li6IEpTIOmhtuabv++8jOS+v+S6juiviuaW' +
    'reaXpeW/l+WMuuWIhuOAgiAqLwpmdW5jdGlvbiBnZXRCaW5kaW5nSW5mbygpIHsKICByZXR1cm4gT2JqZWN0LmZy' +
    'ZWV6ZSh7CiAgICBtb2RlOiAnanMtc2hpbScsCiAgICBiYWNrZW5kOiAnbmFwaScsCiAgICBhYmk6ICduYXBpLXY5' +
    'JywKICAgIHBsYXRmb3JtOiBwcm9jZXNzLnBsYXRmb3JtLAogICAgYXJjaDogcHJvY2Vzcy5hcmNoLAogICAgbm9k' +
    'ZTogcHJvY2Vzcy52ZXJzaW9uLAogIH0pOwp9Cgptb2R1bGUuZXhwb3J0cyA9IHsgcmVxdWlyZUJ1aWx0aW4sIGlz' +
    'QWxsb3dlZEludGVybmFsSWQsIGdldEJpbmRpbmdJbmZvIH07Cm1vZHVsZS5leHBvcnRzLmRlZmF1bHQgPSBtb2R1' +
    'bGUuZXhwb3J0czsK';
  const NARB_MARKER = 'dsh-launcher-android-narb-shim-v1';
  const narb = findPkg('node-addon-require-builtin', 'lib/index.js');
  if (!narb) {
    log('WARN node-addon-require-builtin: not found — 0.1.7 boot 将失败（该包是 app-boot 的硬依赖）');
  } else {
    const cur = readFileSync(narb, 'utf8');
    if (cur.includes(NARB_MARKER)) {
      log('node-addon-require-builtin JS shim already applied');
    } else {
      writeFileSync(narb, Buffer.from(NARB_B64, 'base64'));
      log('node-addon-require-builtin JS shim applied: ' + narb);
    }
  }
} catch (e) { log('WARN node-addon-require-builtin shim: ' + e.message); }



  /* 视觉链路配套（当前 dsh-launcher-android-att-vision-v5），在 v3/v4 基础上加三道保险：
     1) syncDirectory 改用「函数签名 + 花括号配平」定位完整函数体，不再依赖后继注释锚点，
        对任何上游结构（干净 / v2 残缺 / v3 已改）都能精确切出整个函数；
     2) 写入前先用 node --check 校验临时文件语法，校验失败则放弃写盘（防止再毒化）；
     3) link 调用点**扫描式**改写（v5 新增）——上游 0.1.5 把单点 link 拆成
        publishStagedObject / publishImmutableAlias 两点，v4 的单锚点静默失效。
     同时自愈 v2 遗留的孤儿 finally / 孤儿 publishCopied 调用。

     幂等判据（v5 修正）：**不能只看 marker 字符串**。旧实现只要文件里出现
     'att-vision-v4' 就整体短路，而上游换版时 marker 可能与「调用点未改写」
     共存（正是 0.1.5 的真实现场）→ 补丁永久失效。v5 改为
     「marker 存在 且 已无裸 link 发布调用点」才算已完成。

     **已针对 0.1.7-rc.2 核实**：dsh-attachment-local@0.1.7-rc.2/lib/index.js 中
       · 正则 /await link\(…\);/ 命中 **2 处**（publishStagedObject / publishImmutableAlias）；
       · publishStagedObject / publishImmutableAlias / async function syncDirectory(path) {
         三处签名均存在。
     → 扫描式实现已兼容，**保持不动**。
     「collectSites()==0 即已完成」这条自愈判据在命中 2 处时**不会误判**：
     只有「marker 在位 **且** 裸 link 调用点已全部改写为 publishCopied」才短路；
     若上游再改结构导致调用点消失，collectSites() 归零会让补丁**重跑**（而非静默跳过），
     此时块内会打 'no bare link call site, nothing to rewrite' 或
     'helper def anchor miss' 的显式 WARN——这正是需要的可诊断性。 */
  try {
    const attLocal = findPkg('@deepseek-ai/dsh-attachment-local', 'lib/index.js');
    /* 匹配 `await link(<from>, <target>);`：from/target 均为简单标识符或成员访问，
       不含嵌套括号，避免误伤非发布用途的 link 调用。 */
    const LINK_CALL_SRC = 'await link\\(([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*), ([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\);';
    /**
     * 定位已安装 helper `publishCopied` 的函数体区间 [start, end)。
     * **必须排除该区间**：helper 体内本身含一句 `await link(from, target);`，
     * 若把它也当成待改写调用点，第二次运行就会把 helper 改成自递归
     * （v5 开发期真实踩到：二次运行 rewritten=1 且 sha 变化）。
     * 用花括号配平求函数体，与 syncDirectory 的定位手法一致。
     */
    const helperSpan = (text) => {
      const sig = 'async function publishCopied(';
      const i = text.indexOf(sig);
      if (i === -1) return null;
      let depth = 0, seen = false;
      for (let k = i; k < text.length; k++) {
        const c = text[k];
        if (c === '{') { depth++; seen = true; }
        else if (c === '}') { depth--; if (seen && depth === 0) return { start: i, end: k + 1 }; }
      }
      return { start: i, end: text.length };
    };
    /** 收集 helper 体之外的裸 link 发布调用点。 */
    const collectSites = (text) => {
      const span = helperSpan(text);
      const re = new RegExp(LINK_CALL_SRC, 'g');
      const out = [];
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (span && mm.index >= span.start && mm.index < span.end) continue; /* helper 自身，跳过 */
        out.push({ from: mm[1], target: mm[2], text: mm[0] });
      }
      return out;
    };
    const hasMarker = (t) => t.includes('dsh-launcher-android-att-vision-v5');
    if (!attLocal) {
      log('attachment-local: not found, skip vision patch');
    } else if (hasMarker(readFileSync(attLocal, 'utf8')) && collectSites(readFileSync(attLocal, 'utf8')).length === 0) {
      log('attachment-local vision patch already applied');
    } else {
      let src = readFileSync(attLocal, 'utf8');

      /* 自愈前置：若当前文件本身语法已损坏（v2/v3 毒化），先尝试用括号配平
         重建 syncDirectory 区域，再继续标准补丁；重建失败则放弃写盘并提示。 */
      const checkCurrent = (function () {
        const tmp2 = attLocal + '.v4cur.mjs';
        try {
          writeFileSync(tmp2, src);
          const r2 = spawnSync(process.execPath, ['--check', tmp2], { timeout: 15000, encoding: 'utf8' });
          return r2.status === 0;
        } catch (e) {
          return true; /* spawnSync 不可用时假定当前文件可用，走标准流程 */
        } finally {
          try { unlinkSync(tmp2); } catch {}
        }
      })();
      if (!checkCurrent) log('attachment-local v4: current file syntax broken, attempting repair');

      /* 用括号配平定位 syncDirectory 完整函数体：从函数签名起，逐字符累计 { }，
         深度归零时即函数结束。兼容体内任意注释/嵌套，不依赖后继锚点。 */
      const SYNC_START = 'async function syncDirectory(path) {';
      let si = src.indexOf(SYNC_START);
      let se = -1;
      if (si !== -1) {
        let depth = 0;
        for (let i = si; i < src.length; i++) {
          const c = src[i];
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { se = i + 1; break; } }
        }
      }
      const seg = si !== -1 && se > si ? src.slice(si, se) : '';
      if (seg && seg.length <= 4096 && seg.includes('handle')) {
        src = src.slice(0, si) + [
          'async function syncDirectory(path) {',
          '\tif (process.platform === "win32") return;',
          '\tlet handle;',
          '\ttry {',
          '\t\thandle = await open(path, constants.O_RDONLY);',
          '\t} catch (error) {',
          '\t\tif (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT" || error.code === "ENOTDIR")) return;',
          '\t\tthrow error;',
          '\t}',
          '\ttry { await handle.sync(); } catch (error) { await handle.close().catch(() => {}); if (process.platform === "android") return; throw error; }',
          '\tawait handle.close().catch(() => {});',
          '}'
        ].join('\n') + '\n' + src.slice(se);
      } else {
        log('WARN vision patch v4: syncDirectory segment not located, leave as-is');
      }

      /* 清理 v2 毒化残留：syncDirectory 之后可能残留孤立的 `} finally { ... }` 块
         （v2 正则替换半个函数留下的），它们会造成语法错误。用非贪婪正则删除
         syncDirectory 结尾 } 之后、下一个 /** 注释之前的孤儿 finally 块。 */
      const orphanRe = /\n[ \t]*finally \{[\s\S]*?\n\t\}(?=\n[ \t]*\/\* v8 ignore|\n[ \t]*\/\*\*|\n[ \t]*\/\/)/;
      const orphanMatch = orphanRe.exec(src);
      if (orphanMatch) {
        log('attachment-local v4: removing orphan finally block: ' + JSON.stringify(orphanMatch[0].slice(0, 60)));
        src = src.replace(orphanRe, '');
      }
      /* v2 毒化的另一半残留：孤儿 finally 之后的 v8-ignore-stop 注释 + 孤儿 }，
         它们会让后续函数（ensureDurableHome）的括号失衡。同样在下一个 /** 前删除。 */
      const orphanCloseRe = /\n[ \t]*\/\* v8 ignore stop \*\/\n[ \t]*\}(?=\n[ \t]*\/\*\*)/;
      const orphanClose = orphanCloseRe.exec(src);
      if (orphanClose) {
        log('attachment-local v4: removing orphan close brace: ' + JSON.stringify(orphanClose[0].slice(0, 60)));
        src = src.replace(orphanCloseRe, '');
      }

      /* link 发布回退：SELinux 拒绝应用 uid 的 link(2)（真机实测：应用私有存储
         上同为 EACCES，不只是 sdcard FUSE），必须回退 copy。

         v5 改为**扫描式**改写，不再锚定单一调用点字面量：
         上游 0.1.5 把发布链路重构成 publishStagedObject(root,target,staged) 与
         publishImmutableAlias(root,source,target,sha256) 两个 link 调用点，
         旧的单锚点 'await link(temporary, target);' 直接消失 → v4 静默失效
         （只打一行 WARN，图片/附件链路在真机上必挂）。扫描式改写对上游后续
         再拆分/重命名同样有效，且每个调用点各自用其作用域内的实参。

         helper 语义按调用点实参推导：link(from, target) 之后上游会 unlink(from)
         （staged/source 是暂存名），故 helper 负责「copy 成功后由调用方 unlink」；
         EEXIST 去重与 digest 校验语义与上游一致。 */
      {
        const defAnchor = '/**\n* Publish one already verified normalized image';
        const di = src.indexOf(defAnchor);
        /* 用外层 collectSites（已排除 helper 自身函数体，避免自递归） */
        let sites = collectSites(src);
        /* 兼容 v2/v3 毒化残留：调用点已被改写但 helper 定义缺失时，先还原为 link 调用 */
        if (!src.includes('async function publishCopied(') && src.includes('await publishCopied(temporary, target, sha256);')) {
          src = src.replace('await publishCopied(temporary, target, sha256);', 'await link(temporary, target);');
          log('vision patch v5: restored v2-orphaned publishCopied call');
          sites = collectSites();
        }
        /* 关键：helper 已存在（v4 遗留）时**仍须改写裸调用点**——上游换版后
           helper 在位、调用点却是裸 link，正是 0.1.5 的真实失效现场。
           v4 helper 形参为 (temporary, target, sha256)，与 v5 位置语义一致，
           故同一调用形式对两者都成立。 */
        const hasHelper = src.includes('async function publishCopied(');
        if (di === -1 && !hasHelper) {
          log('WARN vision patch v5: helper def anchor miss (def=false), leave as-is');
        } else if (sites.length === 0) {
          log('vision patch v5: no bare link call site, nothing to rewrite');
        } else {
          /* 先改写全部调用点、后插入 helper：helper 内部同样含 await link 字面量，
             先插后换会把 helper 自身也改写掉（自递归）。用字符串替换避免索引错位。 */
          let rewritten = 0;
          for (const s of sites) {
            /* sha256 实参按调用点作用域推导：
               publishImmutableAlias(root, source, target, sha256) → from=source，用 sha256；
               publishStagedObject(root, target, staged)          → from=staged.path，用 staged.sha256。 */
            const sha = s.from.startsWith('staged.') ? 'staged.sha256' : 'sha256';
            const repl = 'await publishCopied(' + s.from + ', ' + s.target + ', ' + sha + ');';
            if (src.includes(s.text)) { src = src.replace(s.text, repl); rewritten++; }
          }
          if (rewritten === 0) {
            log('WARN vision patch v5: link call rewrite miss');
          } else {
            /* copyFile 回退分支需要；仅当尚未导入时追加 */
            if (!src.includes('copyFile')) {
              const impA = '} from "node:fs/promises";';
              if (src.includes(impA)) src = src.replace(impA, ', copyFile' + impA);
              else log('WARN vision patch v5: fs/promises import anchor miss');
            }
            if (!hasHelper) {
              const helper = [
                '/** dsh-launcher-android-att-vision-v5: link 优先；SELinux/FUSE 环境回退 copy，',
                '* 复制中途失败清理半写 target 防止内容寻址路径被毒化。 */',
                'async function publishCopied(from, target, sha256) {',
                '\ttry {',
                '\t\tawait link(from, target);',
                '\t\treturn;',
                '\t} catch (linkError) {',
                '\t\tconst code = linkError instanceof Error && "code" in linkError ? linkError.code : void 0;',
                '\t\tif (code === "EEXIST") {',
                '\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
                '\t\t\treturn;',
                '\t\t}',
                '\t\tif (!(code === "EACCES" || code === "EPERM" || code === "ENOSYS" || code === "EXDEV")) throw linkError;',
                '\t\ttry { await copyFile(from, target); } catch (copyError) {',
                '\t\t\tawait unlink(target).catch(() => {});',
                '\t\t\tthrow copyError;',
                '\t\t}',
                '\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) {',
                '\t\t\tawait unlink(target).catch(() => {});',
                '\t\t\tthrow new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");',
                '\t\t}',
                '\t}',
                '}'
              ].join('\n');
              if (di === -1) src = helper + '\n' + src;
              else src = src.replace(defAnchor, helper + '\n' + defAnchor);
            }
            log('vision patch v5: publishCopied installed=' + (!hasHelper) + ', link call sites rewritten=' + rewritten);
          }
        }
      }

      /* 写入前语法自检：写临时文件 + node --check，失败则放弃写盘（防止再毒化）。
         ESM 文件 node --check 会校验语法；若 spawnSync 不可用则降级为括号配平检查。 */
      const tmpPath = attLocal + '.v5check.mjs';
      let syntaxOk = false;
      try {
        writeFileSync(tmpPath, src);
        const r = spawnSync(process.execPath, ['--check', tmpPath], { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) syntaxOk = true;
        else log('WARN attachment-local v5 syntax check FAILED: ' + (r.stderr || '').slice(0, 300));
      } catch (e) {
        log('WARN attachment-local v5 syntax check unavailable: ' + e.message);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
      if (syntaxOk) {
        /* 旧版本标记（v1~v4 遗留）统一升级到 v5，保证幂等短路用的是当前判据。
           注意：仅升级 marker 字符串，调用点改写是否完成由外层判据另行校验。 */
        src = src.replace(/att-vision-v[1-4]/g, 'att-vision-v5');
        writeFileSync(attLocal, src);
        log('attachment-local vision patch v5 applied: ' + attLocal);
      } else {
        log('WARN attachment-local vision patch v5: syntax check failed, file NOT modified: ' + attLocal);
      }
    }
  } catch (e) { log('WARN attachment-local vision: ' + e.message); }
