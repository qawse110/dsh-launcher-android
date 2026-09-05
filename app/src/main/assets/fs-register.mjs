import { register, registerHooks } from 'node:module';
import { resolve } from './fs-loader.mjs';

/* 两套钩子都注册，各管一段：
 *  - registerHooks（Node ≥22.15）：主线程同步钩子，同时覆盖 ESM import 与
 *    CJS require。sharp 的消费者既有 ESM 插件入口也有 CJS 插件（如
 *    @deepseek-ai/dsh-attachment-local 的 require 链路），缺它就漏一半。
 *  - register（旧版 + worker/子线程）：异步钩子跑在独立 loader 线程，
 *    会覆盖到主线程之外的线程；同步钩子只作用于注册它的那个线程。
 * 特性检测而非判断版本号：内置 node 版本由 termux 包决定，将来可能降级。
 * 两套注册都必须 try/catch：任一抛错不能阻断另一套 —— 这份文件是 --import
 * 预加载入口，顶层抛错 = 整个 web 进程起不来（比 sharp 崩溃更糟）。
 */
try {
  if (typeof registerHooks === 'function') {
    registerHooks({ resolve });
  }
} catch (e) {
  console.error('[fs-register] registerHooks failed, fallback to register():', e.message);
}
try {
  register('./fs-loader.mjs', import.meta.url);
} catch (e) {
  console.error('[fs-register] register failed:', e.message);
}
