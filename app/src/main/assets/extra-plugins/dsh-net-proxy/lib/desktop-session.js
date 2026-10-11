// lib/desktop-session.js — 把生效代理装进 Desktop 右侧浏览器的 Electron guest session（issue #6，方案 D）
//
// 背景：DSH Desktop 右侧浏览器由 <webview> guest 实现（@deepseek-ai/dsh-client-ui-sidebar-browser），
// 宿主为每个 workspace 用 session.fromPartition("dsh-sidebar-browser-" + uuid) 创建独立 session，
// 最终经 webContents.loadURL() 导航。Chromium session 默认 mode:"system"（跟随系统代理），
// 因此「插件配置 = 系统代理」时页面已经走对了；缺口在「插件配置 ≠ 系统代理」的场景——
// 手填地址、系统代理关闭时回退手填地址、改端口不重启等。本层对 guest session 调
// session.setProxy() 补齐这条链路（fetch 包装层、harness 代理层之外的第 3 条通道）。
//
// 成立前提：插件宿主进程可拿到 electron.session（仅 Electron 主进程内成立）。
// **实测（DSH Desktop 0.1.7-rc.2，2026-10）：插件宿主是 Electron 主进程用
// utilityProcess / ELECTRON_RUN_AS_NODE 起的子 Node 进程（跑 app.asar 内 dsh CLI），
// require("electron") 与 ESM import 都拿不到 session——本层在当前架构下常驻
// unavailable（优雅降级，如实留痕），作为「桥接就绪桩」保留：未来 DSH 若在
// Electron 主进程内加载插件宿主，本层即自动激活，无需改代码。**
// 要让侧边浏览器真正受控/可观测，需 Electron 主进程配合（issue #6 方案 A/B：
// dsh-plugin-desktop 提供代理桥接），net-proxy 单侧无法实现。
//
// 实现方式：插件启动时（guest 创建之前）包装 electron.session.fromPartition，
// 按前缀识别 sidebar guest session 并记录；每个被记录的 session 在创建时立即
// 应用当前生效策略（先于首次 loadURL，issue #6 建议实现 B 的时序要求），
// 之后每次策略变化（配置热更 / 跟随系统轮询 / 停用）对全部已记录 session 重放。
// 停用/卸载还原为 { mode: "system" }（Chromium session 的默认策略）。
//
// 已知限制（如实呈现，不静默吞掉）：
//   1. 插件激活之前已创建的 guest session（如插件热重载后的旧面板）不在覆盖内，
//      重新打开右侧浏览器即被 wrap 捕获——插件随 DSH 启动加载，正常场景先于 guest；
//   2. 代理凭据在 webview 不生效：宿主对 guest session 的 "login" 事件用空
//      callback() 拦截（取消认证），本层不与之竞争；带凭据的策略仍应用规则，
//      但状态里如实标注 credentials: "unsupported"；
//   3. "dsh-sidebar-browser-" 前缀属 Desktop 内部实现细节（自 app.asar 核实），
//      DSH 升级若改前缀，本层降级为「记录不到 session」，不影响其他两条通道。
import { createRequire } from "node:module";

const PARTITION_PREFIX = "dsh-sidebar-browser-";
const MAX_TRACKED = 64; // workspace 数量硬上限，防 map 无界增长

function looksLikeElectron(e) {
  return !!e && !!e.session && typeof e.session.fromPartition === "function";
}

/**
 * 定位 Electron API（仅主进程可用）。先经 createRequire（Electron 在主进程全局
 * patch 了 "electron" 的模块解析，任意路径都能命中），再回退 ESM dynamic import
 * （Electron ≥ 28 的 ESM 支持）。
 * @returns {Promise<{electron: object|null, via: string|null, attempts: string[]}>}
 */
export async function loadElectron() {
  const attempts = [];
  try {
    const e = createRequire(import.meta.url)("electron");
    if (looksLikeElectron(e)) return { electron: e, via: "require", attempts };
    attempts.push("require: 缺少 session.fromPartition");
  } catch (e) {
    // "Cannot find module 'electron'" 在插件宿主进程里的真实含义：不是 Electron
    // 主进程（utilityProcess / ELECTRON_RUN_AS_NODE 的子 Node 进程 / Web/CLI 运行时），
    // guest session 不可达——降级为现状，需主进程桥接才能覆盖（issue #6 方案 A/B）。
    attempts.push(`require: ${(e && e.message) || e}（插件宿主不是 Electron 主进程，session 不可达）`);
  }
  try {
    const e = await import("electron");
    const mod = e && (e.default || e);
    if (looksLikeElectron(mod)) return { electron: mod, via: "import", attempts };
    attempts.push("import: 缺少 session.fromPartition");
  } catch (e) {
    attempts.push(`import: ${(e && e.message) || e}`);
  }
  return { electron: null, via: null, attempts };
}

/** host 含冒号（IPv6 字面量）时加方括号（与 harness-proxy.js 同规则）。 */
function bracketHost(host) {
  const h = String(host || "");
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

/**
 * 生效代理 → Chromium setProxy 配置（issue #6 协议映射）。
 * http/https-CONNECT → "http=host:port;https=host:port"（同时覆盖 HTTP 与 HTTPS 请求）；
 * socks5 → "socks5://host:port"（Chromium 原生支持，无 harness 层的 http-only 限制）；
 * noProxy → proxyBypassRules（Chromium 隐式绕过回环地址，条目保留双保险；<local> 原生可识别）。
 * @param proxy - toProxy 形状；enabled=false/缺省返回 null（调用方还原 mode:"system"）。
 */
export function buildChromiumProxy(proxy) {
  if (!proxy) return null;
  const protocol = String(proxy.protocol || "").toLowerCase();
  const host = String(proxy.host || "").trim();
  const port = Number(proxy.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hp = `${bracketHost(host)}:${port}`;
  const rules = protocol === "socks5" || protocol === "socks"
    ? `socks5://${hp}`
    : `http=${hp};https=${hp}`;
  const bypass = (Array.isArray(proxy.noProxy) ? proxy.noProxy : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(",");
  const credentials = proxy.username || proxy.password ? "unsupported" : "none";
  return { proxyRules: rules, proxyBypassRules: bypass, credentials };
}

/**
 * 创建 Desktop 浏览器 session 同步器。与 harness 同步器同约定：
 * 所有状态变化（启用/停用/热更/跟随切换）都调 sync(effProxy|null)，内部负责
 * 安装包装、幂等、还原。sync/dispose 异步串行化由调用方 promise 链保证。
 *
 * @param opts.report 诊断回调（安装/降级/每条 setProxy 错误）。
 * @param opts.loadModule 模块解析注入点（测试用）。
 */
export function createDesktopSessionSync({ report = () => {}, loadModule = loadElectron } = {}) {
  let loaded = null;      // { electron, via }（负结果不缓存，允许下次重试）
  let unwrapFn = null;    // 还原 fromPartition 包装的 disposer
  let tracked = new Map(); // partition → { session, appliedKey }
  let lastKey = null;     // 当前已应用的策略键（幂等）
  let currentProxy = null; // 最近一次 sync 的入参（新 guest 创建时立即应用）
  let st = { mode: "off", via: null, sessions: 0, proxy: null, credentials: "none", error: null };

  function setStatus(patch) {
    st = { ...st, ...patch, sessions: tracked.size };
  }

  /** 对单个 session 应用当前策略（新 guest 创建路径与全量重放路径共用）。 */
  function applyToSession(entry, key, cfg, viaChromium) {
    const { session, partition } = entry;
    let p;
    try {
      p = viaChromium(cfg);
    } catch (e) {
      report(`desktop 会话 ${shortPartition(partition)} 规则构造失败: ${(e && e.message) || e}`);
      return false;
    }
    if (!p) return false;
    try {
      // setProxy 返回 Promise；不 await（逐条 fire-and-forget），错误在 catch 里留痕
      Promise.resolve(session.setProxy({ proxyRules: p.proxyRules, proxyBypassRules: p.proxyBypassRules })).catch(
        (e) => report(`desktop 会话 ${shortPartition(partition)} setProxy 失败: ${(e && e.message) || e}`)
      );
      entry.appliedKey = key;
      return true;
    } catch (e) {
      report(`desktop 会话 ${shortPartition(partition)} setProxy 异常: ${(e && e.message) || e}`);
      return false;
    }
  }

  function shortPartition(p) {
    return String(p || "").replace(PARTITION_PREFIX, "sidebar:") || "(unknown)";
  }

  /**
   * 安装 fromPartition 包装（幂等）。识别 sidebar 前缀 → 记录 session 并立即
   * 应用当前策略（先于首次 loadURL）。非 sidebar 的 partition（平台视图
   * persist:dsh-platform-*、policy-auth 等）不碰，避免方案 C 的全局副作用。
   */
  function install(electron) {
    if (unwrapFn) return; // 已包装
    const ses = electron.session;
    const original = ses.fromPartition;
    const wrapped = function (partition, opts) {
      const session = original.call(ses, partition, opts);
      try {
        if (typeof partition === "string" && partition.startsWith(PARTITION_PREFIX) && session && typeof session.setProxy === "function") {
          let entry = tracked.get(partition);
          if (!entry) {
            entry = { session, partition, appliedKey: null };
            tracked.set(partition, entry);
            // 上限熔断：极端情况下（guest 反复重建）丢弃最早记录，保 map 有界
            if (tracked.size > MAX_TRACKED) {
              const first = tracked.keys().next().value;
              tracked.delete(first);
            }
          } else {
            entry.session = session; // 同 partition 再次 fromPartition（guest 重建）拿最新对象
          }
          // guest 创建时立即应用：issue #6 时序要求（首次 loadURL 之前）
          if (currentProxy && entry.appliedKey !== lastKey) {
            applyToSession(entry, lastKey, currentProxy, buildChromiumProxy);
          }
        }
      } catch {}
      return session;
    };
    try {
      ses.fromPartition = wrapped;
      unwrapFn = () => {
        try {
          if (ses.fromPartition === wrapped) ses.fromPartition = original;
        } catch {}
      };
    } catch (e) {
      report(`desktop 会话层包装失败: ${(e && e.message) || e}`);
    }
  }

  /** 停用/卸载路径：全部已记录 session 还原为 Chromium 默认策略（跟随系统）。 */
  function restoreAll(reason) {
    for (const [, entry] of tracked) {
      try {
        Promise.resolve(entry.session.setProxy({ mode: "system" })).catch(() => {});
      } catch {}
    }
    if (tracked.size && reason) report(`${reason}：${tracked.size} 个 desktop 会话已还原默认策略`);
  }

  /**
   * @param proxy - 生效代理（toProxy 形状）；null/禁用 → 还原默认并停跟踪。
   */
  async function sync(proxy) {
    const masked = proxy ? `${proxy.protocol}://${bracketHost(proxy.host)}:${proxy.port}` : null;
    if (!proxy) {
      restoreAll("代理停用");
      tracked = new Map();
      currentProxy = null;
      lastKey = null;
      setStatus({ mode: "off", via: loaded && loaded.via, proxy: null, credentials: "none", error: null });
      return;
    }
    currentProxy = proxy;
    const chromium = buildChromiumProxy(proxy);
    if (!chromium) {
      restoreAll("代理配置无效");
      setStatus({ mode: "unsupported", via: loaded && loaded.via, proxy: masked, credentials: "none", error: "代理地址/端口无效" });
      return;
    }
    const key = `${chromium.proxyRules}|${chromium.proxyBypassRules}`;
    lastKey = key;
    if (!loaded || !loaded.electron) loaded = await loadModule();
    if (!loaded || !loaded.electron) {
      setStatus({
        mode: "unavailable",
        via: null,
        proxy: masked,
        credentials: chromium.credentials,
        error: String((loaded && loaded.attempts && loaded.attempts.join("; ")) || "无法加载 electron.session").slice(0, 400),
      });
      return; // 降级：fetch 包装层与 harness 层不受影响
    }
    install(loaded.electron);
    let ok = 0;
    for (const [, entry] of tracked) {
      if (applyToSession(entry, key, proxy, buildChromiumProxy)) ok++;
    }
    // 幂等：策略未变且所有 session 已应用时不再刷日志
    if (st.mode === "installed" && st.proxy === masked && st.lastKey === key && ok === tracked.size) {
      setStatus({ mode: "installed" });
      return;
    }
    setStatus({
      mode: "installed",
      via: loaded.via,
      proxy: masked,
      credentials: chromium.credentials,
      error: null,
      lastKey: key,
    });
    if (ok > 0) {
      report(
        `desktop 会话代理已应用: ${masked}（${ok}/${tracked.size} 个 guest${chromium.credentials === "unsupported" ? "，凭据在 webview 不生效（宿主拦截认证事件）" : ""}）`
      );
    } else if (tracked.size === 0) {
      report("desktop 会话代理已就绪（尚无右侧浏览器 guest，打开面板即生效）");
    }
  }

  /** 插件卸载：还原全部 session 默认策略并拆除包装。 */
  function dispose() {
    return (async () => {
      restoreAll("插件卸载");
      tracked = new Map();
      currentProxy = null;
      lastKey = null;
      if (unwrapFn) {
        unwrapFn();
        unwrapFn = null;
      }
      setStatus({ mode: "off", via: null, proxy: null, credentials: "none", error: null });
    })();
  }

  return {
    sync,
    dispose,
    status: () => ({ ...st, sessions: tracked.size }),
    /** 测试注入点：手动登记一个 guest session（模拟宿主 fromPartition 调用）。 */
    _trackForTest(session, partition) {
      const entry = { session, partition: partition || PARTITION_PREFIX + "test", appliedKey: null };
      tracked.set(entry.partition, entry);
      return entry;
    },
  };
}
