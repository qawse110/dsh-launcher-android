// dsh-net-proxy — 代理客户端聚合入口（纯 re-export）
// 实现已拆分至 lib/proxy/：
//   errors.js    结构化错误与公共工具（ProxyError/abortError/timeoutFor）
//   no-proxy.js  NO_PROXY 直连判定
//   parse.js     协议解析（createDecoder/parseStatusLine）
//   body.js      公共响应体解码 sink（makeBodyController）
//   conn.js      代理底层连接 + ByteStream 数据泵
//   http11.js    HTTP/1.1 请求（sendViaSocket）
//   http2.js     HTTP/2 请求（sendViaHttp2）
//   request.js   proxiedFetch 入口（直连判定/协议分发/重定向）
//
// 公共 API（保持与原单文件一致，向下兼容）：
//   proxiedFetch(input, init, proxy, originalFetch) — 把一次 fetch 请求走代理发出
//   ByteStream — 单数据泵
//   isNoProxy / createDecoder / parseStatusLine — 叶子工具
export { proxiedFetch } from "./proxy/request.js";
export { isNoProxy } from "./proxy/no-proxy.js";
export { createDecoder, parseStatusLine } from "./proxy/parse.js";
export { ByteStream } from "./proxy/conn.js";
