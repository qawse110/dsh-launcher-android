// @local/dsh-proxy — 服务端 bundle（Node 半边）
// 读 net-proxy.json、包装全局 fetch 走代理；设置页通过 dsh 同源 webServer
// 路由 /_dsh/net-proxy 读写同一份配置（与 dsh-vision-toolkit 的 /_dsh 方式一致）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { proxiedFetch } from "./proxy-fetch.js";
import { probeProxy } from "./probe.js";
import z from "@deepseek-ai/schemastery";
import { loadConfig, writeConfig, configPath, toCfg, toProxy } from "./config.js";
import { settingsHandler } from "./routes.js";

export const name = "net-proxy";
export const inject = [];

const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  protocol: z.string().default("http"),
  host: z.string().default("127.0.0.1"),
  port: z.number().default(7890),
  username: z.string().default(""),
  password: z.string().default(""),
  noProxy: z.array(z.string()).default(["127.0.0.1", "localhost", "::1"]),
}).default({});
export const Config = ProxySchema;

export function apply(ctx, config) {
  const file = configPath();
  let cfg = loadConfig(file);
  let originalFetch = globalThis.fetch;
  let wrapped = false;
  let disposed = false;
  let watchers = [];

  function refreshProxy() {
    if (disposed) return;
    const proxy = toProxy(cfg);
    if (cfg.enabled) {
      if (!wrapped) originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => proxiedFetch(input, init, toProxy(cfg), originalFetch);
      wrapped = true;
      console.error(`[net-proxy] 已启用代理 ${proxy.protocol}://${proxy.host}:${proxy.port}`);
    } else if (wrapped) {
      globalThis.fetch = originalFetch;
      wrapped = false;
      console.error("[net-proxy] 已停用代理（直连）");
    }
  }

  function reloadFrom(f) {
    if (disposed) return;
    try {
      const next = loadConfig(f);
      const changed = JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      refreshProxy();
      if (changed) console.error(`[net-proxy] 配置已加载: ${JSON.stringify({ ...cfg, password: cfg.password ? "***" : "" })}`);
    } catch (err) {
      console.error("[net-proxy] 热更失败:", err && err.message);
    }
  }

  // 连通/延迟探测：用给定(或当前)配置测一次代理链路，不改配置。
  function runProbe(p) {
    const pr = (p && typeof p === "object") ? p : {};
    const proxy = toProxy({
      protocol: pr.protocol || cfg.protocol,
      host: pr.host || cfg.host,
      port: pr.port != null ? pr.port : cfg.port,
      username: pr.username != null ? pr.username : cfg.username,
      password: pr.password != null ? pr.password : cfg.password,
      noProxy: cfg.noProxy,
    });
    return probeProxy(proxy);
  }

  // 同源设置路由（挂 dsh webServer，/ _dsh/net-proxy）。与 dsh-vision-toolkit 一致。
  ctx.inject(["webServer"], function (webCtx) {
    webCtx.effect(function () {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/_dsh/net-proxy",
        handler: function (req, res) { settingsHandler(req, res, file, function () { reloadFrom(file); }, runProbe); },
      });
      console.error("[net-proxy] 同源设置路由: /_dsh/net-proxy");
      return dispose;
    }, "net-proxy: web settings route");
  });

  console.error(`[net-proxy] 配置文件: ${file}（enabled=${cfg.enabled}）`);
  refreshProxy();

  // 监听 net-proxy.json 变化热更。
  try {
    if (fs.existsSync(file)) {
      const w = fs.watch(file, (evt) => { if (evt === "rename") return; reloadFrom(file); });
      w.on("error", () => {});
      watchers.push(w);
    }
  } catch {}
  if (!fs.existsSync(file)) {
    const poll = setInterval(() => {
      if (fs.existsSync(file)) {
        reloadFrom(file);
        clearInterval(poll);
        try {
          const w = fs.watch(file, () => reloadFrom(file));
          w.on("error", () => {});
          watchers.push(w);
        } catch {}
      }
    }, 1000);
    poll.unref?.();
    watchers.push(poll);
  }

  return () => {
    disposed = true;
    for (const w of watchers) {
      try { if (typeof w.close === "function") w.close(); else clearInterval(w); } catch {}
    }
    watchers = [];
    if (wrapped) globalThis.fetch = originalFetch;
  };
}
