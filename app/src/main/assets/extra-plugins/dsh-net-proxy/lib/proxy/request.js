// lib/proxy/request.js — proxiedFetch 入口：直连判定、请求头组装、https/http 协议分发、重定向跟随
import net from "node:net";
import tls from "node:tls";
import { ProxyError, timeoutFor } from "./errors.js";
import { connectProxy, httpConnect, socksConnect } from "./conn.js";
import { sendViaSocket } from "./http11.js";
import { sendViaHttp2 } from "./http2.js";
import { isNoProxy } from "./no-proxy.js";

/**
 * @typedef {{protocol:string, host:string, port:number, username?:string, password?:string, noProxy?:string[], timeout?:number}} NetProxyConfig
 * 代理配置契约。`protocol`：「http」/「socks5」/「socks」；`username`/`password` 可选；`noProxy` 命中直连；`timeout`(ms) 可选，默认 60000。
 */

function directFetch(originalFetch, input, init) {
  return originalFetch(input, init);
}

async function proxiedOnce(url, init = {}, proxy, originalFetch) {
  const urlObj = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body == null ? null : (init.body instanceof ArrayBuffer ? Buffer.from(init.body) : (typeof init.body === "string" ? Buffer.from(init.body) : init.body));
  const signal = init.signal;

  if (isNoProxy(url, proxy.noProxy)) {
    return directFetch(originalFetch, url, init);
  }

  const targetHostRaw = urlObj.hostname; // IPv6 形如 [::1]
  const targetHost = targetHostRaw.startsWith("[") && targetHostRaw.endsWith("]") ? targetHostRaw.slice(1, -1) : targetHostRaw;
  const defaultPort = urlObj.protocol === "https:" ? 443 : 80;
  const targetPort = urlObj.port ? Number(urlObj.port) : defaultPort;
  // A1：Host 头默认端口省略；非默认才带 `:port`
  const hostHeader = targetPort === defaultPort ? targetHostRaw : `${targetHostRaw}:${targetPort}`;
  const isSocks = proxy.protocol === "socks5" || proxy.protocol === "socks";

  // 组装请求头：正确处理 Headers 实例（forEach 才能取到内部 slot 的值）
  const headers = {};
  {
    const src = init.headers;
    if (src != null && typeof src === "object") {
      if (typeof Headers !== "undefined" && src instanceof Headers) src.forEach((v, k) => (headers[k] = v));
      else if (Array.isArray(src)) for (const [k, v] of src) headers[k] = v;
      else Object.assign(headers, src);
    }
  }
  // 移除 hop-by-hop；A5：host 一律以计算值为准
  ["proxy-connection", "keep-alive", "connection", "upgrade", "transfer-encoding", "host", "content-length", "accept-encoding"].forEach((h) => delete headers[h]);
  // A4：尊重调用方显式 accept-encoding；未设置才默认 identity
  let declaredAE = null;
  {
    const src = init.headers;
    if (src != null && typeof src === "object") {
      if (typeof Headers !== "undefined" && src instanceof Headers) declaredAE = src.get("accept-encoding");
      else if (Array.isArray(src)) { const f = src.find((x) => String(x[0]).toLowerCase() === "accept-encoding"); declaredAE = f && f[1]; }
      else if ("accept-encoding" in src) declaredAE = src["accept-encoding"];
    }
  }
  headers["accept-encoding"] = declaredAE != null && String(declaredAE).trim() !== "" ? String(declaredAE) : "identity";

  let raw;
  try {
    if (urlObj.protocol === "https:") {
      raw = isSocks ? await socksConnect(proxy, targetHost, targetPort, signal) : await httpConnect(proxy, targetHost, targetPort, signal);
    } else if (urlObj.protocol !== "http:") {
      throw ProxyError("EPROTO", `unsupported protocol ${urlObj.protocol}`);
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw e;
  }

  if (urlObj.protocol === "https:") {
    // B3：IP 目标不发 SNI
    const isIP = net.isIP(targetHost);
    const tlsSock = tls.connect({
      socket: raw,
      servername: isIP ? undefined : targetHost,
      host: targetHost,
      port: targetPort,
      ALPNProtocols: ["h2", "http/1.1"], // C2：协商 HTTP/2
    });
    await new Promise((resolve, reject) => {
      tlsSock.once("secureConnect", () => { tlsSock.removeAllListeners("error"); resolve(); });
      tlsSock.once("error", (e) => reject(ProxyError("ETLS", `TLS to ${targetHost} failed: ${e.message}`, e)));
    });
    if (tlsSock.alpnProtocol === "h2") {
      // C2：服务器协商出 HTTP/2 → 走 HTTP/2；否则回退 HTTP/1.1
      return sendViaHttp2(tlsSock, targetHost, targetPort, hostHeader, urlObj, method, headers, body, signal);
    }
    const path = urlObj.pathname + urlObj.search;
    const h = { Host: hostHeader, Connection: "close", ...headers };
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return sendViaSocket(tlsSock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
  }

  // HTTP 目标：绝对 URL + Host；有凭据时补 Proxy-Authorization（A3）
  const sock = await connectProxy(proxy, signal);
  const absUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
  const proxyAuth = (proxy.username || proxy.password)
    ? { "Proxy-Authorization": "Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") } : {};
  const h = { Host: urlObj.host, Connection: "close", ...proxyAuth, ...headers };
  const head = `${method} ${absUrl} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return sendViaSocket(sock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
}

// 外层：跟随 30x 重定向（最多 5 跳），对齐标准 fetch。
export async function proxiedFetch(input, init = {}, proxy, originalFetch) {
  // input 兼容四种形态：string / URL 对象（无 .url，取 .href）/ Request（有 .url）/ 其他 {url}
  let url;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input === "object") {
    if (typeof input.url === "string") url = input.url;
    else if (typeof input.href === "string") url = input.href;
  }
  if (!url) throw new Error("proxiedFetch: invalid input");
  let cur = { ...(init || {}) };
  if (input && typeof input === "object" && input.url && !cur.method) cur.method = input.method || "GET";
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await proxiedOnce(url, cur, proxy, originalFetch);
      const st = resp.status;
      if (st === 301 || st === 302 || st === 303 || st === 307 || st === 308) {
        const loc = resp.headers ? resp.headers.get("location") : null;
        if (loc) {
          const next = new URL(loc, url).href;
          const curMethod = (cur.method || "GET").toUpperCase();
          const toGet = st === 303 || ((st === 301 || st === 302) && curMethod !== "HEAD");
          cur = { ...cur, method: toGet ? "GET" : curMethod };
          if (toGet) delete cur.body;
          try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch {}
          url = next;
          continue;
        }
      }
      return resp;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw e;
    }
  }
  throw ProxyError("EREDIRECT", "proxiedFetch: too many redirects");
}
