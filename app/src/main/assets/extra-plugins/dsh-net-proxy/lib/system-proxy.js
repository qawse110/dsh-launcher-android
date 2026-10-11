// lib/system-proxy.js — 跟随系统代理：读取操作系统的系统代理设置
//
// 平台数据源：
//   Windows: 注册表 HKCU\...\Internet Settings（v2rayN / Clash 的「设置系统代理」都写这里）
//            ProxyEnable(0/1)、ProxyServer("host:port" 或 "http=..;https=..;socks=..")、
//            ProxyOverride(绕过列表)、AutoConfigURL(PAC)
//   macOS:   `scutil --proxy`（HTTPEnable/HTTPProxy/HTTPPort...）
//   Linux:   环境变量 HTTP(S)_PROXY / ALL_PROXY / NO_PROXY
//
// 设计：所有解析逻辑为纯函数（可单测）；readSystemProxy 只负责发起子进程/读环境变量。
// applyFollowSystem 把「系统状态」合并进用户配置，得到生效配置（纯函数）。
import { execFile } from "node:child_process";

const WIN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function runCmd(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout || ""));
      });
    } catch { resolve(null); }
  });
}

/** 解析 `reg query <key>` 输出里的 "名称  类型  值" 行。 */
export function parseRegValues(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:SZ|DWORD)\s+(.+)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/**
 * 解析 ProxyServer：
 *   "127.0.0.1:7890"                                    → { protocol:"http", host, port }
 *   "http=127.0.0.1:8080;https=127.0.0.1:8081;socks=1080" → 优先 http/https（单一端口场景等价），socks 单独给出时用 socks5
 */
export function parseProxyServer(v) {
  if (!v) return null;
  const s = String(v).trim();
  const splitHostPort = (hv) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(hv || "").trim());
    return m ? { host: m[1], port: Number(m[2]) } : null;
  };
  if (s.includes("=")) {
    const parts = {};
    for (const seg of s.split(";")) {
      const i = seg.indexOf("=");
      if (i > 0) parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
    }
    const hp = splitHostPort(parts.https) || splitHostPort(parts.http);
    if (hp) return { protocol: "http", ...hp };
    const so = splitHostPort(parts.socks);
    if (so) return { protocol: "socks5", ...so };
    return null;
  }
  const single = splitHostPort(s);
  return single ? { protocol: "http", ...single } : null;
}

/** 解析 ProxyOverride 为 noProxy 条目：*.foo.com→.foo.com（后缀），192.168.* 保留（前缀通配），<local> 保留。 */
export function parseBypassList(text) {
  const out = [];
  for (const part of String(text || "").split(/[;,]/)) {
    let e = part.trim();
    if (!e) continue;
    if (/^<local>$/i.test(e)) { out.push("<local>"); continue; }
    if (e === "*") { out.push("*"); continue; }
    if (e.startsWith("*")) e = e.slice(1); // "*.foo.com" → ".foo.com"
    out.push(e);
  }
  return out;
}

/** 解析 `scutil --proxy` 输出。 */
export function parseScutilOutput(text) {
  const kv = {};
  const exceptions = [];
  let inArray = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1];
    let val = m[2].trim();
    if (inArray && /^\d+$/.test(k)) { exceptions.push(val); continue; }
    inArray = false;
    if (val.startsWith("<array>")) { inArray = true; continue; } // 行形如 "ExceptionsList : <array> {"
    kv[k] = val;
  }
  const bypass = exceptions;
  if (kv.HTTPEnable === "1" || kv.HTTPSEnable === "1") {
    return {
      enabled: true, protocol: "http",
      host: kv.HTTPSProxy || kv.HTTPProxy || "",
      port: Number(kv.HTTPSPort || kv.HTTPPort || 0),
      bypass,
    };
  }
  if (kv.SOCKSEnable === "1") {
    return { enabled: true, protocol: "socks5", host: kv.SOCKSProxy || "", port: Number(kv.SOCKSPort || 0), bypass };
  }
  return { enabled: false, protocol: "http", host: "", port: 0, bypass };
}

/** 解析 Linux 环境变量形式的代理 URL（http:// / socks5://，可带凭据）。 */
export function parseUrlProxy(raw) {
  if (!raw) return null;
  const m = /^(?:(socks5h?|socks4|socks|http):\/\/)?(?:([^:@/\s]+)(?::([^@/\s]*))?@)?\[?([^\]\/\s]+?)\]?:(\d+)\/?$/i.exec(String(raw).trim());
  if (!m) return null;
  const protocol = m[1] && /socks/i.test(m[1]) ? "socks5" : "http";
  return { protocol, username: m[2] || undefined, password: m[3] || undefined, host: m[4], port: Number(m[5]) };
}

/**
 * 读取当前系统代理状态（不抛错，失败以 supported:false 表示）。
 * 返回 { supported, mode:"manual"|"pac"|"none", enabled, protocol, host, port, bypass, pacUrl? }
 */
export async function readSystemProxy({ execFn = runCmd, env = process.env, platform = process.platform } = {}) {
  try {
    if (platform === "win32") {
      const text = await execFn("reg", ["query", WIN_KEY]);
      if (text == null) return { supported: false };
      const v = parseRegValues(text);
      if (v.autoconfigurl) return { supported: true, mode: "pac", pacUrl: v.autoconfigurl, enabled: false };
      const ps = parseProxyServer(v.proxyserver);
      const enabled = (v.proxyenable === "0x1" || v.proxyenable === "1") && !!ps;
      return {
        supported: true,
        mode: enabled ? "manual" : "none",
        enabled,
        ...(ps || { protocol: "http", host: "", port: 0 }),
        bypass: parseBypassList(v.proxyoverride || ""),
      };
    }
    if (platform === "darwin") {
      const text = await execFn("scutil", ["--proxy"]);
      if (text == null) return { supported: false };
      const parsed = parseScutilOutput(text);
      return { supported: true, mode: parsed.enabled ? "manual" : "none", ...parsed };
    }
    // linux 及其他：环境变量
    const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "";
    const parsed = parseUrlProxy(raw);
    const bypass = String(env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parsed) return { supported: true, mode: "none", enabled: false, protocol: "http", host: "", port: 0, bypass };
    return { supported: true, mode: "manual", enabled: true, protocol: parsed.protocol, host: parsed.host, port: parsed.port, bypass };
  } catch {
    return { supported: false };
  }
}

/**
 * 把系统代理状态合并进用户配置，得到「生效配置」（纯函数）。
 * 跟随语义：总开关=硬闸；系统开 → 用系统 host/port/protocol（凭据沿用手动配置）；系统关 → 回退手填地址；
 * PAC/读取失败 → 回退手动配置（followNote 说明原因）；未开启跟随 → 原样。
 */
export function applyFollowSystem(cfg, sys) {
  // 总开关 = 硬闸（最高优先级，v0.7.18 定稿）：明确关闭就是关闭，
  // 跟随模式不得把它改写回启用——否则「关了总开关却还在代理」违反直觉。
  if (!cfg || cfg.enabled === false) return { ...cfg, followNote: "" };
  if (!cfg.followSystem) return { ...cfg, followNote: "" };
  if (!sys || sys.supported === false) return { ...cfg, followNote: "unavailable" };
  if (sys.mode === "pac") return { ...cfg, followNote: "pac" };
  if (!sys.enabled) {
    // 系统代理关 + 跟随开 + 总开关开：回退到手填地址（跟随只换「地址来源」，
    // 不剥夺「用不用代理」的决定权——手填的代理进程可能仍活着可用）。
    return { ...cfg, followNote: "system-off" };
  }
  const noProxy = [...new Set([...(Array.isArray(cfg.noProxy) ? cfg.noProxy : []), ...(sys.bypass || [])])];
  return {
    ...cfg,
    enabled: true,
    protocol: sys.protocol || cfg.protocol,
    host: sys.host || cfg.host,
    port: sys.port || cfg.port,
    noProxy,
    followNote: "ok",
  };
}

/** 系统状态 → 给设置页展示的摘要（结构化，UI 负责本地化标签）。 */
export function describeSystemState(sys) {
  if (!sys || sys.supported === false) return { state: "unavailable" };
  if (sys.mode === "pac") return { state: "pac", url: sys.pacUrl };
  if (!sys.enabled) return { state: "off" };
  return { state: "ok", proxy: `${sys.protocol}://${sys.host}:${sys.port}` };
}

/** 系统状态 → 日志一行。 */
export function describeSystem(sys) {
  const d = describeSystemState(sys);
  if (d.state === "ok") return `已启用 ${d.proxy}（跟随中）`;
  if (d.state === "off") return "系统代理未开启（按手填地址转发）";
  if (d.state === "pac") return `PAC 模式（${d.url}），暂不支持跟随，沿用手动配置`;
  return "不可用，沿用手动配置";
}
