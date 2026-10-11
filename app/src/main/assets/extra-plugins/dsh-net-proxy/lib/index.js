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
import { settingsHandler, logHandler } from "./routes.js";
import { readSystemProxy, applyFollowSystem, describeSystem, describeSystemState } from "./system-proxy.js";
import { createHarnessProxySync } from "./harness-proxy.js";
import { createDesktopSessionSync } from "./desktop-session.js";
import { createTrafficLog } from "./traffic-log.js";
import { createRelay } from "./relay.js";

export const name = "net-proxy";
export const inject = [];

const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  followSystem: z.boolean().default(false),
  protocol: z.string().default("http"),
  host: z.string().default("127.0.0.1"),
  port: z.number().default(7890),
  username: z.string().default(""),
  password: z.string().default(""),
  noProxy: z.array(z.string()).default(["127.0.0.1", "localhost", "::1"]),
  logEnabled: z.boolean().default(true),
  logPreviewBytes: z.number().default(512),
}).default({});
export const Config = ProxySchema;

/** 设置路由允许的 Host 白名单：回环 + 本机所有网卡地址/主机名（支持从局域网访问 GUI）。 */
function localHostAllowlist() {
  const names = new Set(["127.0.0.1", "localhost", "::1"]);
  try { if (os.hostname()) names.add(os.hostname().toLowerCase()); } catch {}
  try {
    const ifs = os.networkInterfaces();
    for (const list of Object.values(ifs || {})) {
      for (const it of list || []) {
        if (it && typeof it.address === "string") names.add(it.address.toLowerCase());
      }
    }
  } catch {}
  return [...names].filter(Boolean);
}

export function apply(ctx, config) {
  const file = configPath();
  // 优先用 harness 注入的 logger（统一日志/级别开关），无则退回 console
  const logger = (ctx && ctx.logger && typeof ctx.logger.error === "function") ? ctx.logger : console;
  const info = typeof logger.info === "function" ? logger.info.bind(logger) : logger.error.bind(logger);
  const error = typeof logger.error === "function" ? logger.error.bind(logger) : console.error.bind(console);
  let cfg = loadConfig(file);
  let originalFetch = globalThis.fetch;
  let wrapper = null; // 本插件安装的 fetch 包装器引用（卸载时校验用）
  let wrapped = false;
  let disposed = false;
  let watchers = [];
  let sysState = null; // 最近一次读取的系统代理状态（followSystem 时使用）

  // ── 流量日志与本地中继（v0.5.0）──
  // log：经插件的所有请求（fetch 包装层 + harness 中继层）的环形内存记录（不落盘）。
  // relay：本地回环中继；harness 层（web_fetch）的代理指向它 → 流量可观测 + SOCKS5 桥接。
  // logEnabled=false 时给协议栈/中继传 null-化 begin 的包装，不再记新条目。
  const log = createTrafficLog({ previewBytes: cfg.logPreviewBytes });
  const gatedBegin = (meta) => (cfg.logEnabled === false ? null : log.begin(meta));
  const relay = createRelay({
    log: { begin: gatedBegin },
    getProxy: function () {
      const eff = effectiveCfg();
      return eff.enabled ? toProxy(eff) : null;
    },
    report: (m) => info(`[net-proxy] ${m}`),
  });
  function applyLogCfg(next) {
    log.configure({ previewBytes: next.logPreviewBytes });
  }

  // harness 代理层（issue #5）：web_fetch 在 DSH ≥ 0.1.5-rc.1 不走 globalThis.fetch，
  // 由 @deepseek-ai/dsh-http-proxy 的路由决定走向，故生效策略要同步安装一份到那里。
  // sync 是异步的，用 promise 链串行化，避免装卸载交错。
  const harness = createHarnessProxySync({ report: (m) => info(`[net-proxy] ${m}`), relay });
  let harnessQueue = Promise.resolve();
  function syncHarness() {
    const eff = effectiveCfg();
    const proxy = eff.enabled ? toProxy(eff) : null;
    harnessQueue = harnessQueue
      .then(() => harness.sync(proxy))
      .catch((e) => error("[net-proxy] harness 代理层同步异常:", e && e.message));
  }

  // 生效配置 = 用户配置 ⊕（跟随模式下的）系统代理状态。纯函数，见 system-proxy.js。
  function effectiveCfg() {
    return applyFollowSystem(cfg, sysState);
  }

  // Desktop 浏览器 guest session（issue #6，方案 D）：右侧 <webview> 的导航/XHR/WebSocket
  // 走 Electron session.setProxy——fetch 包装层与 harness 代理层覆盖不到的第 3 条通道。
  // 与 harness 同步器同约定：refreshProxy 的每次生效策略变化都调 syncDesktop()。
  const desktop = createDesktopSessionSync({ report: (m) => info(`[net-proxy] ${m}`) });
  let desktopQueue = Promise.resolve();
  function syncDesktop() {
    const eff = effectiveCfg();
    const proxy = eff.enabled ? toProxy(eff) : null;
    desktopQueue = desktopQueue
      .then(() => desktop.sync(proxy))
      .catch((e) => error("[net-proxy] desktop 会话代理同步异常:", e && e.message));
  }

  function refreshProxy() {
    if (disposed) return;
    const eff = effectiveCfg();
    if (eff.enabled) {
      if (!wrapped) {
        // 只在「未包装 → 包装」翻转时才赋值 globalThis.fetch；
        // 包装器闭包惰性调用 effectiveCfg()，跟随系统的状态变化在下次请求时自动生效。
        originalFetch = globalThis.fetch;
        wrapper = (input, init) => proxiedFetch(input, init, toProxy(effectiveCfg()), originalFetch, { begin: gatedBegin });
        globalThis.fetch = wrapper;
        wrapped = true;
        const p = toProxy(eff);
        info(`[net-proxy] 已启用代理 ${p.protocol}://${p.host}:${p.port}${cfg.followSystem ? "（跟随系统）" : ""}`);
      }
    } else if (wrapped) {
      // 仅当全局 fetch 仍是自己装的包装器时才还原，避免把后装的其他包装器一起拆掉
      if (globalThis.fetch === wrapper) {
        globalThis.fetch = originalFetch;
        info("[net-proxy] 已停用代理（直连）");
      } else {
        // 链上叠有后装包装器：无法沿链摘除自身，如实留痕（否则「停用了却还在代理」无迹可查）
        error("[net-proxy] 停用时 fetch 链上叠有后装的包装器，本插件包装器无法摘除，将继续按最后配置代理");
      }
      wrapper = null;
      wrapped = false;
    }
    syncHarness();
    syncDesktop();
  }

  function reloadFrom(f) {
    if (disposed) return;
    try {
      const next = loadConfig(f);
      const changed = JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      applyLogCfg(cfg);
      refreshProxy();
      if (changed) info(`[net-proxy] 配置已加载: ${JSON.stringify({ ...cfg, password: cfg.password ? "***" : "" })}`);
    } catch (err) {
      error("[net-proxy] 热更失败:", err && err.message);
    }
  }

  // 连通/延迟探测：用给定(或当前)配置测一次代理链路，不改配置。target 可自定义测试目标。
  // 安全：只有当探测目标与当前配置的代理是同一个（host+port+protocol）时，才回填已保存的
  // 凭据；探测任意第三方主机一律不带凭据，防止把存储的代理密码发到攻击者控制的服务器。
  function runProbe(p, target) {
    const pr = (p && typeof p === "object") ? p : {};
    const sameProxy = pr.host === cfg.host
      && Number(pr.port) === Number(cfg.port)
      && (pr.protocol || cfg.protocol) === cfg.protocol;
    const creds = sameProxy ? cfg : { username: "", password: "" };
    const proxy = toProxy({
      protocol: pr.protocol || cfg.protocol,
      host: pr.host || cfg.host,
      port: pr.port != null ? pr.port : cfg.port,
      username: pr.username != null ? pr.username : creds.username,
      password: pr.password != null ? pr.password : creds.password,
      noProxy: cfg.noProxy,
    });
    return probeProxy(proxy, target ? { target } : {});
  }

  // 同源设置路由（挂 dsh webServer，/_dsh/net-proxy 与 /_dsh/net-proxy/log）。与 dsh-vision-toolkit 一致。
  ctx.inject(["webServer"], function (webCtx) {
    webCtx.effect(function () {
      const disposers = [];
      disposers.push(webCtx.webServer.register({
        kind: "exact",
        path: "/_dsh/net-proxy/log",
        handler: function (req, res) {
          logHandler(req, res, log, () => relay.status(), localHostAllowlist());
        },
      }));
      disposers.push(webCtx.webServer.register({
        kind: "exact",
        path: "/_dsh/net-proxy",
        handler: function (req, res) {
          settingsHandler(req, res, file, function () { reloadFrom(file); }, runProbe, {
            allowedHosts: localHostAllowlist(),
            sysInfo: function () { return describeSystemState(sysState); },
            harnessInfo: function () { return harness.status(); },
            relayInfo: function () { return relay.status(); },
            desktopInfo: function () { return desktop.status(); },
          });
        },
      }));
      info("[net-proxy] 同源设置路由: /_dsh/net-proxy（+ /log 请求日志）");
      return () => { for (const d of disposers) { try { d && d(); } catch {} } };
    }, "net-proxy: web settings route");
  });

  info(`[net-proxy] 配置文件: ${file}（enabled=${cfg.enabled}）`);
  refreshProxy();

  // 监听配置变化热更。writeConfig 用 tmp+rename 原子替换，文件 inode 会换——
  // fs.watch(file) 在 rename 后失效，因此改为 watch 父目录，按文件名过滤。
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let debounce = null;
    const w = fs.watch(dir, (evt, fname) => {
      if (fname && fname !== base) return;
      if (debounce) clearTimeout(debounce);
      // debounce 不入 watchers：每次文件事件都 push 会无界增长；reloadFrom 自带 disposed 守卫，
      // 卸载后残留的一次触发是安全 no-op。
      debounce = setTimeout(() => { debounce = null; reloadFrom(file); }, 100);
      debounce.unref?.();
    });
    w.on("error", () => {});
    watchers.push(w);
  } catch {}
  if (!fs.existsSync(file)) {
    // 目录 watch 已兜底新文件出现；此 poll 仅在 watch 不可用（如目录不存在）时补充，
    // 命中后自清（文件出现即继续由目录 watch 接管，不必常驻轮询）。
    const poll = setInterval(() => {
      if (fs.existsSync(file)) { clearInterval(poll); reloadFrom(file); }
    }, 1000);
    poll.unref?.();
    watchers.push(poll);
  }

  // 跟随系统代理：每 3s 轮询一次系统代理设置（Windows 注册表 / macOS scutil / Linux env）。
  // 仅在 followSystem 开启时才真正发起读取；状态变化时更新 sysState 并 refreshProxy()，
  // 包装器闭包在下次请求时自动使用新的生效配置。
  let pollBusy = false;
  const sysPoll = setInterval(() => {
    if (disposed || pollBusy || !cfg.followSystem) return;
    pollBusy = true;
    readSystemProxy().then(
      (next) => {
        pollBusy = false;
        if (disposed) return;
        const changed = JSON.stringify(next) !== JSON.stringify(sysState);
        sysState = next;
        if (changed) {
          info(`[net-proxy] 系统代理: ${describeSystem(next)}`);
          refreshProxy();
        }
      },
      () => { pollBusy = false; }
    );
  }, 3000);
  sysPoll.unref?.();
  watchers.push(sysPoll);

  // 中继存活看护（v0.7.3）：harness 策略经中继安装后，若中继意外停止（而配置/系统代理
  // 均无变化，sync 的幂等短路不会重跑），env 会永远指向死端口、宿主所有 fetch 静默失败
  // （实例症状：插件目录 "fetch failed, tried through http://127.0.0.1:<死端口>"）。
  // 每 5s 核对一次：曾经中继安装而现在没在监听 → 强制重走 sync（relay.start 换新端口 →
  // 幂等键变化 → 重装 env）。
  const relayWatch = setInterval(() => {
    if (disposed) return;
    const hs = harness.status();
    if (hs.relayPort != null && !relay.status().listening) {
      info(`[net-proxy] 本地中继 :${hs.relayPort} 已失联，重新同步 harness 策略`);
      syncHarness();
    }
  }, 5000);
  relayWatch.unref?.();
  watchers.push(relayWatch);
  // 开启跟随时立即探测一次，不等首个 3s 周期
  if (cfg.followSystem) {
    readSystemProxy().then((next) => {
      if (disposed || !cfg.followSystem) return;
      sysState = next;
      info(`[net-proxy] 系统代理: ${describeSystem(next)}`);
      refreshProxy();
    }, () => {});
  }

  return () => {
    disposed = true;
    for (const w of watchers) {
      try { if (typeof w.close === "function") w.close(); else clearInterval(w); } catch {}
    }
    watchers = [];
    if (wrapped) {
      if (globalThis.fetch === wrapper) globalThis.fetch = originalFetch;
      else error("[net-proxy] 卸载时 fetch 链上叠有后装的包装器，本插件包装器无法摘除，将残留至进程结束");
    }
    wrapper = null;
    wrapped = false;
    // 还原 harness 层（issue #5 注意事项 5）：把 dispatcher/策略/环境变量恢复到安装前；
    // 同时关闭本地中继（其 teardown 内含 relay.stop()，这里显式再停一次兜底）
    relay.stop();
    harnessQueue = harnessQueue.then(() => harness.dispose()).catch(() => {});
    // 还原 desktop 会话层（issue #6）：全部 guest session setProxy 还原 Chromium 默认（跟随系统），
    // 并拆除 fromPartition 包装
    desktopQueue = desktopQueue.then(() => desktop.dispose()).catch(() => {});
  };
}
