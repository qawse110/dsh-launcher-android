// lib/proxy/body.js — HTTP/1.1 与 HTTP/2 共用的响应体解码 sink
// 去重：两者都以「按 content-encoding 建解码器 → dec.on(data) enqueue →
// dec.on(end) close / dec.on(error) error → dec.end() 收尾」的方式把压缩字节
// 解压进 ReadableStream controller。此模块把这段公共逻辑抽成一份。
import { createDecoder } from "./parse.js";

/**
 * 构建「解压解码器 → ReadableStream controller」的公共 sink，供 HTTP/1.1 与
 * HTTP/2 响应体复用。屏蔽 gzip/deflate/br 与无编码两种路径，统一提供：
 *
 * 返回 { dec, write, finish, close, destroy }
 *   - dec      解码流（无编码时为 null）
 *   - write(chunk) 写入一块原始字节（Promise，带 dec.drain 背压）；无编码时直接 enqueue
 *   - finish()     收尾：dec.end() 冲刷后 close controller（无解码则直接 close）
 *   - close()      关闭 controller（幂等）
 *   - destroy()    销毁解码流（错误路径清理）
 *
 * @param {ReadableStreamDefaultController} controller
 * @param {string} ce content-encoding（小写）
 * @param {object} [taps] 流量日志旁路（纯旁观，不改变流语义）：
 *   - taps.onWire(chunk)  线上原始字节（压缩后，即真实网络流量口径）
 *   - taps.onPlain(chunk) 解压后明文字节（仅用于预览采样）
 */
export function makeBodyController(controller, ce, taps) {
  const dec = createDecoder(ce);
  let decDoneResolve = null;
  const decDone = new Promise((r) => (decDoneResolve = r));
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { controller.close(); } catch {} decDoneResolve(); };
  if (dec) {
    dec.on("data", (c) => {
      if (taps && taps.onPlain) { try { taps.onPlain(c); } catch {} }
      try { controller.enqueue(new Uint8Array(c)); } catch {}
    });
    dec.on("end", close);
    dec.on("error", (e) => { try { controller.error(e); } catch {} decDoneResolve(); });
  }
  // dec 写入用 drain 背压，避免过大解压缓冲；无解码直接 enqueue。
  // 背压等待须与 close/error 竞速：dec 被 destroy 后 drain 永不触发，否则泵循环挂死。
  const write = (c) => new Promise((res) => {
    if (taps && taps.onWire) { try { taps.onWire(c); } catch {} }
    if (dec) {
      if (!dec.write(c)) {
        const done = () => { dec.removeListener("close", done); dec.removeListener("error", done); res(); };
        dec.once("close", done);
        dec.once("error", done);
        dec.once("drain", done);
      } else res();
    }
    else {
      if (taps && taps.onPlain) { try { taps.onPlain(c); } catch {} }
      try { controller.enqueue(new Uint8Array(c)); } catch {} res();
    }
  });
  const finish = () => { if (dec) { dec.end(); return decDone; } close(); return Promise.resolve(); };
  const destroy = () => { if (dec) { try { dec.destroy(); } catch {} } };
  return { dec, write, finish, close, destroy };
}
