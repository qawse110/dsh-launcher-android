// lib/routes.js  同源设置路由的 HTTP handler（纯函数，便于单元测试）
// GET 读 / POST 写同一份 net-proxy.json；POST { action:"probe" } 触发连通探测。
// 安全：GET 回传时密码打码为 "***"；POST 收到 "***" 视为「未改动」保留原值，
// 避免任何同源页面都能通过 GET 读到明文代理凭据。
//
// 跨站防护（v0.2.7）：
//   1. Host 校验：仅接受回环（或 opts.allowedHosts 白名单）Host，防 DNS rebinding；
//   2. POST 必须携带自定义头 X-DSH-Net-Proxy: 1 —— 跨站「简单请求」无法携带自定义头
//      （带上它就会触发 CORS 预检，而本路由不响应 OPTIONS，预检必失败），从而阻断
//      evil.com 页面用 text/plain 简单请求改写代理配置的 CSRF；
//   3. 带 Origin 头时要求其 host:port 与 Host 头一致，拒绝跨源写。
import { loadConfig, writeConfig, toCfg } from "./config.js";

const MASK = "***";
const MAX_POST_BODY = 64 * 1024; // POST 体积上限，防止无界累积
export const PROXY_HEADER = "x-dsh-net-proxy"; // POST 必需的自定义头（小写比较）
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** 从 Host 头取 hostname（去端口；IPv6 需带方括号）。 */
export function hostFromHeader(hostHeader) {
  if (!hostHeader) return "";
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h : h.slice(1, close);
  }
  const ci = h.lastIndexOf(":");
  // 仅一个冒号且冒号后是端口才拆分（IPv6 裸字面量有多个冒号，保持原样）
  if (ci !== -1 && h.indexOf(":") === ci && /^\d+$/.test(h.slice(ci + 1))) h = h.slice(0, ci);
  return h;
}

/** Host 头是否命中允许列表（无 Host 头视为非浏览器直连，放行）。 */
export function isAllowedHost(hostHeader, allowed) {
  const host = hostFromHeader(hostHeader);
  if (!host) return true;
  const list = Array.isArray(allowed) && allowed.length ? allowed : DEFAULT_ALLOWED_HOSTS;
  return list.map((x) => String(x).trim().toLowerCase()).includes(host);
}

/** Origin 的 host:port 是否与 Host 头一致（scheme 不敏感）。 */
export function originMatchesHost(origin, hostHeader) {
  try {
    const o = new URL(String(origin));
    const hh = String(hostHeader || "").trim().toLowerCase();
    if (!hh) return true;
    return o.host === hh || o.hostname === hostFromHeader(hh);
  } catch {
    return false;
  }
}

/** 请求日志路由：GET 读（summary + relay 状态 + 最近条目），POST { action:"clearLog" } 清空。 */
export function logHandler(req, res, trafficLog, relayStatus, allowedHosts) {
  const headers = req.headers || {};
  const send = function (code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const deny = function (code, msg) { send(code, { ok: false, error: msg }); };
  if (!isAllowedHost(headers.host, allowedHosts)) return deny(403, "forbidden host");
  if (req.method === "GET") {
    let limit = 200;
    let fullId = null;
    let fullSide = "res";
    try {
      const sp = new URL(req.url || "/", "http://x").searchParams;
      const n = Number(sp.get("limit"));
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, trafficLog.maxEntries);
      // 完整体查询：?full=<id>&side=req|res（该条目仍在缓冲且内容已保留时返回全部内容）
      const f = Number(sp.get("full"));
      if (Number.isInteger(f) && f > 0) {
        fullId = f;
        fullSide = sp.get("side") === "req" ? "req" : "res";
      }
    } catch {}
    if (fullId != null && typeof trafficLog.full === "function") {
      return send(200, { ok: true, full: { id: fullId, side: fullSide, ...trafficLog.full(fullId, fullSide) } });
    }
    send(200, {
      ok: true,
      summary: trafficLog.summary(),
      relay: typeof relayStatus === "function" ? relayStatus() : null,
      entries: trafficLog.list(limit),
    });
    return;
  }
  if (req.method === "POST") {
    if (String(headers[PROXY_HEADER] || "") !== "1") return deny(403, "missing " + PROXY_HEADER + " header");
    if (headers.origin && !originMatchesHost(headers.origin, headers.host)) return deny(403, "cross-origin request");
    let body = "";
    req.on("data", function (c) { body += c; if (body.length > 4096) { try { req.destroy(); } catch {} } });
    req.on("end", function () {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, { ok: false, error: "invalid json" }); }
      if (payload && payload.action === "clearLog") {
        trafficLog.clear();
        return send(200, { ok: true, summary: trafficLog.summary() });
      }
      send(400, { ok: false, error: "unknown action" });
    });
    return;
  }
  send(405, { ok: false, error: "method not allowed" });
}

/** 同源设置路由（GET 读 / POST 写 net-proxy.json）。 */
export function settingsHandler(req, res, file, reloadFn, probeFn, opts) {
  const allowedHosts = opts && opts.allowedHosts;
  const send = function (code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const deny = function (code, msg) { send(code, { ok: false, error: msg }); };
  const masked = function (cfg) {
    return { ...cfg, password: cfg.password ? MASK : "" };
  };
  const headers = req.headers || {};
  // 防 DNS rebinding：浏览器请求必有 Host；Host 不在白名单一律 403
  if (!isAllowedHost(headers.host, allowedHosts)) return deny(403, "forbidden host");
  if (req.method === "GET") {
    const body = { ok: true, value: masked(loadConfig(file)) };
    // 跟随系统模式的当前系统状态（供设置页展示「跟上了没」）
    if (opts && typeof opts.sysInfo === "function") body.system = opts.sysInfo();
    // harness 代理层状态（issue #5：web_fetch 的真实走向，供设置页诊断）
    if (opts && typeof opts.harnessInfo === "function") body.harness = opts.harnessInfo();
    // Desktop 浏览器 guest session 代理状态（issue #6：右侧 webview 的真实走向，供设置页诊断）
    if (opts && typeof opts.desktopInfo === "function") body.desktop = opts.desktopInfo();
    // 本地中继状态（web_fetch 流量经此入日志）
    if (opts && typeof opts.relayInfo === "function") body.relay = opts.relayInfo();
    send(200, body);
    return;
  }
  if (req.method === "POST") {
    // 防 CSRF：跨站简单请求带不了自定义头
    if (String(headers[PROXY_HEADER] || "") !== "1") return deny(403, "missing " + PROXY_HEADER + " header");
    // 防跨源：有 Origin 时必须与 Host 同源
    if (headers.origin && !originMatchesHost(headers.origin, headers.host)) return deny(403, "cross-origin request");
    let body = "";
    let overflow = false;
    req.on("data", function (c) {
      body += c;
      if (body.length > MAX_POST_BODY) {
        overflow = true;
        body = "";
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", function () {
      if (overflow) return send(413, { ok: false, error: "payload too large" });
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return send(400, { ok: false, error: "invalid json" }); }
      // 连通/延迟探测（不改配置）：body = { action: "probe", proxy: {...}, target? }
      if (payload && payload.action === "probe") {
        if (!probeFn) return send(200, { ok: false, error: "probe unavailable" });
        const errText = function (e) { return String((e && e.message) || e); };
        // 打码哨兵与写路径同规则：UI 从 GET 拿到 "***"，探测时还原为已存真实密码
        let pxy = payload.proxy || {};
        if (pxy && pxy.password === MASK) {
          pxy = { ...pxy, password: loadConfig(file).password };
        }
        return Promise.resolve(probeFn(pxy, payload.target)).then(
          function (r) { send(200, r); },
          function (e) { send(200, { ok: false, error: errText(e) }); }
        );
      }
      try {
        if (payload && payload.password === MASK) {
          payload = { ...payload, password: loadConfig(file).password }; // 打码值  保留原密码
        }
        // 以「现有配置 ⊕ 本次提交字段」合并后再校验：设置页只回传代理主字段，
        // 不回传 logEnabled/logPreviewBytes——按 defaults 合并会把用户手改值悄悄重置。
        const next = toCfg({ ...loadConfig(file), ...(payload || {}) });
        writeConfig(next, file);
        if (reloadFn) reloadFn();
        send(200, { ok: true, value: masked(loadConfig(file)) });
      } catch (e) {
        send(400, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  send(405, { ok: false, error: "method not allowed" });
}
