// lib/proxy/no-proxy.js — NO_PROXY 判定（纯函数，无依赖）

/** IPv4 字面量转 32 位整数。非 IPv4 返回 null。 */
function ipv4ToInt(s) {
  const p = String(s).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * 判定 URL 是否命中 noProxy（命中则直连）。支持：
 *   - `example.com` / `.example.com`：host 精确 / 后缀
 *   - `example.com:443`：host+端口
 *   - IPv4 CIDR `10.0.0.0/8`、`128.0.0.0/8`
 *   - `*`（全部命中）
 *   - `<local>`（回环/局域网，简化：回环即命中）
 */
export function isNoProxy(rawUrl, noProxy) {
  if (!Array.isArray(noProxy) || noProxy.length === 0) return false;
  let host, port = null;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase();
    port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  } catch {
    host = String(rawUrl).toLowerCase();
  }
  const hostNoBrackets = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  for (const raw of noProxy) {
    if (!raw) continue;
    const e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    if (e === "<local>") {
      if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || hostNoBrackets.startsWith("127.")) return true;
      continue;
    }
    // host:port
    let onlyHost = e;
    if (port != null && /:\d+$/.test(e)) {
      const ci = e.lastIndexOf(":");
      const ePort = Number(e.slice(ci + 1));
      if (ePort !== port) continue; // 端口不匹配，不算命中
      onlyHost = e.slice(0, ci);
    }
    // CIDR
    if (onlyHost.includes("/")) {
      const [cidrHost, cidrStr] = onlyHost.split("/");
      const cidr = parseInt(cidrStr, 10);
      const ip = ipv4ToInt(hostNoBrackets);
      const base = ipv4ToInt(cidrHost);
      if (ip != null && base != null && Number.isInteger(cidr)) {
        if (cidr === 0) return true;
        if (cidr >= 1 && cidr <= 32) {
          const mask = cidr === 32 ? 0xffffffff : ~((1 << (32 - cidr)) - 1) >>> 0;
          if ((ip & mask) === (base & mask)) return true;
        }
      }
      continue;
    }
    if (onlyHost === "*") return true;
    if (host === onlyHost || host.endsWith("." + onlyHost)) return true;
  }
  return false;
}
