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
 *   - IPv6 字面量 `::1` / `[::1]` / `[::1]:443`（URL.hostname 自带方括号，须对齐比较）
 */
export function isNoProxy(rawUrl, noProxy) {
  if (!Array.isArray(noProxy) || noProxy.length === 0) return false;
  let host, port = null;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase(); // 注意：IPv6 形如 "[::1]"（带方括号）
    port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  } catch {
    host = String(rawUrl).toLowerCase();
  }
  const hostNoBrackets = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  for (const raw of noProxy) {
    if (!raw) continue;
    let e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    if (e === "<local>") {
      if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || hostNoBrackets.startsWith("127.")) return true;
      continue;
    }
    // 拆出条目里的 host 与可选端口。IPv6 字面量含多个冒号，不能按 "host:port" 简单切分：
    //   "::1" → host "::1"；"[::1]:443" → host "::1" port 443；"example.com:443" → host+port。
    let onlyHost = e;
    let ePort = null;
    if (e.startsWith("[")) {
      const close = e.indexOf("]");
      if (close !== -1) {
        onlyHost = e.slice(1, close);
        const rest = e.slice(close + 1);
        if (rest.startsWith(":")) ePort = Number(rest.slice(1));
      }
    } else if ((e.match(/:/g) || []).length === 1 && /:\d+$/.test(e)) {
      const ci = e.lastIndexOf(":");
      ePort = Number(e.slice(ci + 1));
      onlyHost = e.slice(0, ci);
    } else {
      onlyHost = e;
    }
    // 前导点形式 ".example.com"：等价于 "example.com"（匹配本域 + 全部子域）。
    // 此前不剥点，endsWith(".."+"example.com") 永不命中，条目被静默忽略。
    if (onlyHost.startsWith(".")) onlyHost = onlyHost.slice(1);
    if (ePort != null) {
      if (port != null && ePort !== port) continue; // 端口不匹配，不算命中
      if (port == null) continue;
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
    // ".*" 前缀通配（Windows ProxyOverride 风格）与 "*.foo.com" 形式（等价 "foo.com" 后缀匹配）
    if (onlyHost.startsWith("*")) onlyHost = onlyHost.slice(1);
    if (onlyHost.startsWith(".")) onlyHost = onlyHost.slice(1); // 前导点剥离在上面 "*" 之后才发生，这里补一次
    if (onlyHost.endsWith(".*")) {
      const prefix = onlyHost.slice(0, -1); // 保留尾点："192.168."
      if (host.startsWith(prefix) || hostNoBrackets.startsWith(prefix)) return true;
      continue;
    }
    // 精确/后缀：host 与去括号形式都参与比较（"[::1]" 与 "::1" 等价）
    if (host === onlyHost || hostNoBrackets === onlyHost) return true;
    if (host.endsWith("." + onlyHost) || hostNoBrackets.endsWith("." + onlyHost)) return true;
  }
  return false;
}
