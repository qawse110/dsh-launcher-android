// lib/proxy/errors.js — 结构化错误与公共工具（纯函数，无依赖）

/** 带机器可读 code 的错误。 */
export function ProxyError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/** 对齐 fetch 的取消错误。 */
export function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

/** 超时（ms）：proxy.timeout 可用则用之，否则默认 60000。 */
export function timeoutFor(proxy) {
  const t = Number(proxy && proxy.timeout);
  return Number.isFinite(t) && t > 0 ? t : 60000;
}
