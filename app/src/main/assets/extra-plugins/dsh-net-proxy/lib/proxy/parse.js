// lib/proxy/parse.js — 协议解析小工具（纯函数，依赖 node:zlib）

import zlib from "node:zlib";

/** 根据 content-encoding 创建解压流；不支持/无编码时返回 null。 */
export function createDecoder(ce) {
  if (ce === "gzip") return zlib.createGunzip();
  if (ce === "deflate") return zlib.createInflate();
  if (ce === "br") return zlib.createBrotliDecompress();
  return null;
}

/** 解析 HTTP 状态行，返回 status。 */
export function parseStatusLine(line) {
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line || "");
  return m ? Number(m[1]) : 0;
}
