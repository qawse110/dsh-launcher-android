// lib/routes.js — 同源设置路由的 HTTP handler（纯函数，便于单元测试）
// GET 读 / POST 写同一份 net-proxy.json；POST { action:"probe" } 触发连通探测。
import { loadConfig, writeConfig, toCfg } from "./config.js";

/** 同源设置路由（GET 读 / POST 写 net-proxy.json）。 */
export function settingsHandler(req, res, file, reloadFn, probeFn) {
  const send = function (code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET") {
    send(200, { ok: true, value: loadConfig(file) });
    return;
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", function () {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return send(400, { ok: false, error: "invalid json" }); }
      // 连通/延迟探测（不改配置）：body = { action: "probe", proxy: {...} }
      if (payload && payload.action === "probe") {
        if (!probeFn) return send(200, { ok: false, error: "probe unavailable" });
        return Promise.resolve(probeFn(payload.proxy || {})).then(
          function (r) { send(200, r); },
          function (e) { send(200, { ok: false, error: String((e && e.message) || e) }); },
        );
      }
      try {
        const next = toCfg(payload || {});
        writeConfig(next, file);
        if (reloadFn) reloadFn();
        send(200, { ok: true, value: loadConfig(file) });
      } catch (e) {
        send(400, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  send(405, { ok: false, error: "method not allowed" });
}
