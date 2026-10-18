window.__ModuleLoader__.load({ id: "billion-context", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/agent/dsh-native-client.ts
var dsh_native_client_exports = {};
__export(dsh_native_client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(dsh_native_client_exports);
var import_react = require("react");
var inject = ["slots", "locale"];
var NS = "bili";
var ORIGIN_PATH = "/bili/origin";
var POLL_INTERVAL_MS = 3e3;
var POLL_MAX_ATTEMPTS = 10;
var SLOW_POLL_INTERVAL_MS = 1e4;
var PAGE_IDS = ["overview", "sessions", "config", "logs"];
var PAGE_KEYS = {
  overview: "tab_overview",
  sessions: "tab_sessions",
  config: "tab_config",
  logs: "tab_logs"
};
var EMBED_HEIGHT = "min(640px, 78vh)";
var EMBED_PROBE_PATH = "/__bili/?embed=1";
var embedVerdicts = /* @__PURE__ */ new Map();
var embedProbesInFlight = /* @__PURE__ */ new Set();
function probeEmbedRoute(origin, onVerdict) {
  if (typeof fetch !== "function") return;
  const cached = embedVerdicts.get(origin);
  if (cached !== void 0) {
    onVerdict({ origin, verdict: cached });
    return;
  }
  if (embedProbesInFlight.has(origin)) return;
  embedProbesInFlight.add(origin);
  void fetch(`${origin}${EMBED_PROBE_PATH}`).then((res) => {
    let html = false;
    try {
      const ct = typeof res.headers.get === "function" ? res.headers.get("content-type") : "";
      html = res.ok && String(ct ?? "").includes("text/html");
    } catch {
      html = false;
    }
    const verdict = html ? "ok" : "stale";
    embedVerdicts.set(origin, verdict);
    try {
      void res.body?.cancel?.().catch(() => {
      });
    } catch {
    }
    onVerdict({ origin, verdict });
  }).catch(() => {
  }).finally(() => {
    embedProbesInFlight.delete(origin);
  });
}
function detectHostTheme() {
  const g = globalThis;
  try {
    const doc = g.document;
    if (!doc || typeof g.getComputedStyle !== "function") return void 0;
    const candidates = [];
    if (doc.documentElement) candidates.push(doc.documentElement);
    if (doc.body) candidates.push(doc.body);
    try {
      for (const sel of ["main", "[role=main]", "#root", "#app"]) {
        const el = doc.body?.querySelector?.(sel);
        if (typeof el === "object" && el !== null) candidates.push(el);
      }
    } catch {
    }
    let lightVotes = 0;
    let darkVotes = 0;
    for (const c of candidates) {
      let bg;
      try {
        const v = g.getComputedStyle(c).backgroundColor;
        if (typeof v !== "string") continue;
        bg = v;
      } catch {
        continue;
      }
      const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\/\s]+([\d.]+))?\)/.exec(bg);
      if (!m) continue;
      const alpha = m[4] !== void 0 ? Number(m[4]) : 1;
      if (alpha <= 0.5) continue;
      const luma = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      if (luma <= 0.4) darkVotes += 1;
      else lightVotes += 1;
    }
    if (darkVotes !== lightVotes && (darkVotes > 0 || lightVotes > 0)) return darkVotes > lightVotes ? "dark" : "light";
  } catch {
    return void 0;
  }
  try {
    const mq = g.matchMedia?.("(prefers-color-scheme: dark)");
    if (mq) return mq.matches ? "dark" : "light";
  } catch {
  }
  return void 0;
}
var zh = {
  "nav": "bili\u8BBE\u7F6E",
  "title": "billion-context \u538B\u7F29\u4EE3\u7406",
  "open": "\u6253\u5F00 Web UI",
  "hint": "\u67E5\u770B\u538B\u7F29\u72B6\u6001\u3001\u4F1A\u8BDD\u4E0E\u4E0A\u4E0B\u6587\u7A97\u53E3\u3002",
  "degraded": "\u5F53\u524D dsh \u8FDB\u7A0B\u672A\u7ED1\u5B9A bili \u4EE3\u7406\uFF08\u672A\u7ECF bili dsh \u542F\u52A8\uFF0C\u6216\u4EE3\u7406\u5C1A\u672A\u5C31\u7EEA\uFF09\u2014\u2014\u5148\u8FD0\u884C /acp\uFF0C\u6216\u6539\u7528 bili dsh \u542F\u52A8\u3002",
  "connecting": "\u6B63\u5728\u8FDE\u63A5 bili \u4EE3\u7406\u2026",
  "stale": "\u8FD0\u884C\u4E2D\u7684 bili \u4EE3\u7406\u6BD4\u5DF2\u5B89\u88C5\u7684\u914D\u7F6E\u6587\u4EF6\u65E7\uFF1A\u672C\u9875\u9762\u5DF2\u52A0\u8F7D\u65B0\u7248\u754C\u9762\uFF0C\u4F46\u4EE3\u7406\u8FDB\u7A0B\u4ECD\u5728\u63D0\u4F9B\u65E7\u7248\u670D\u52A1\uFF0C\u65E0\u6CD5\u6253\u5F00\u5185\u5D4C\u9875\u9762\u3002\u8BF7\u5B8C\u5168\u9000\u51FA\u5E76\u91CD\u65B0\u542F\u52A8 dsh \u4EE5\u52A0\u8F7D\u65B0\u7248\u672C\uFF1B\u91CD\u542F\u524D\u53EF\u70B9\u4E0B\u65B9\u6309\u94AE\u76F4\u63A5\u6253\u5F00 Web UI\u3002",
  "tab_overview": "\u603B\u89C8",
  "tab_sessions": "\u4F1A\u8BDD",
  "tab_config": "\u914D\u7F6E",
  "tab_logs": "\u65E5\u5FD7"
};
var en = {
  "nav": "bili",
  "title": "billion-context compression proxy",
  "open": "Open Web UI",
  "hint": "Inspect compression status, sessions and context windows.",
  "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) \u2014 run /acp first, or launch through bili dsh.",
  "connecting": "Connecting to the bili proxy\u2026",
  "stale": "The running bili proxy is older than the installed profile: this page already runs the new face, but the proxy process still serves the old build and cannot open the embedded page. Fully quit and relaunch dsh to load the new version; until then, use the button below to open the Web UI directly.",
  "tab_overview": "Overview",
  "tab_sessions": "Sessions",
  "tab_config": "Config",
  "tab_logs": "Logs"
};
function readOrigin() {
  const g = globalThis;
  const snap = g.__BILI__;
  if (snap !== void 0 && snap.relay === true) return "";
  const origin = snap?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : void 0;
}
function openExternal(url) {
  const w = globalThis;
  if (typeof w.open === "function") w.open(url, "_blank", "noopener,noreferrer");
}
function relayBaseOf(res) {
  const url = typeof res.url === "string" ? res.url : "";
  if (url.endsWith(ORIGIN_PATH)) {
    const base = url.slice(0, -ORIGIN_PATH.length).replace(/\/+$/, "");
    return base.length > 0 ? base : "";
  }
  return "";
}
var winningProbeForm;
function probeForms() {
  if (winningProbeForm !== void 0) return [winningProbeForm];
  const doc = globalThis.document;
  const baseURI = typeof doc?.baseURI === "string" && doc.baseURI.length > 0 ? doc.baseURI : void 0;
  if (baseURI === void 0) return [ORIGIN_PATH];
  try {
    const fallback = new URL("bili/origin", baseURI).toString();
    return fallback === ORIGIN_PATH ? [ORIGIN_PATH] : [ORIGIN_PATH, fallback];
  } catch {
    return [ORIGIN_PATH];
  }
}
function probeOrigin(onOrigin, onTheme, onTick) {
  if (typeof fetch !== "function") return () => {
  };
  let cancelled = false;
  let settled = false;
  let timer;
  let attempts = 0;
  const poll = async () => {
    let sawOk = false;
    for (const form of probeForms()) {
      try {
        const res = await fetch(form);
        if (!res.ok) continue;
        sawOk = true;
        const data = await res.json();
        let bind;
        if (data.relay === true) bind = relayBaseOf(res);
        else if (typeof data.origin === "string" && data.origin.length > 0) bind = data.origin;
        if (bind !== void 0 && !cancelled) {
          winningProbeForm = form;
          onOrigin(bind);
          settled = true;
          if (onTick !== void 0) onTick(bind);
          break;
        }
      } catch {
      }
    }
    if (sawOk && onTheme && !cancelled) {
      const theme = detectHostTheme();
      if (theme !== void 0) onTheme(theme);
    }
    if (cancelled) return;
    attempts += 1;
    const delay = !settled && attempts < POLL_MAX_ATTEMPTS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
    if (!cancelled) timer = setTimeout(() => void poll(), delay);
  };
  void poll();
  return () => {
    cancelled = true;
    if (timer !== void 0) clearTimeout(timer);
  };
}
function apply(ctx) {
  const zhDict = zh;
  const enDict = en;
  ctx.effect(
    () => ctx.locale.register(NS, { zh: zhDict, en: enDict }),
    "bili: dictionaries"
  );
  const t = ctx.locale.bind(NS);
  const panel = (titled) => () => {
    const [origin, setOrigin] = (0, import_react.useState)(readOrigin());
    const [page, setPage] = (0, import_react.useState)("overview");
    const [theme, setTheme] = (0, import_react.useState)(detectHostTheme);
    const [embed, setEmbed] = (0, import_react.useState)(() => {
      const o = readOrigin();
      const v = o !== void 0 ? embedVerdicts.get(o) : void 0;
      return o !== void 0 && v !== void 0 ? { origin: o, verdict: v } : void 0;
    });
    (0, import_react.useEffect)(
      () => probeOrigin(
        (o) => {
          setOrigin(o);
          probeEmbedRoute(o, setEmbed);
        },
        setTheme,
        (o) => probeEmbedRoute(o, setEmbed)
      ),
      []
    );
    (0, import_react.useEffect)(() => {
      if (origin !== void 0) probeEmbedRoute(origin, setEmbed);
    }, [origin]);
    const liveEmbed = embed !== void 0 && embed.origin === origin ? embed.verdict : void 0;
    const lang = t("nav") === zhDict.nav ? "zh" : "en";
    const openWebButton = (style) => origin === void 0 ? null : (0, import_react.createElement)(
      "button",
      {
        type: "button",
        title: origin,
        onClick: () => openExternal(`${origin}/__bili/`),
        style: {
          cursor: "pointer",
          borderRadius: 8,
          border: "1px solid rgba(127,127,127,0.4)",
          background: "transparent",
          color: "inherit",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: "22px",
          padding: "7px 16px",
          whiteSpace: "nowrap",
          ...style
        }
      },
      t("open")
    );
    let middle;
    if (origin === void 0) {
      middle = (0, import_react.createElement)("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"));
    } else if (liveEmbed === "stale") {
      middle = (0, import_react.createElement)("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("stale"));
    } else if (liveEmbed === "ok") {
      middle = (0, import_react.createElement)(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
          PAGE_IDS.map(
            (id) => (0, import_react.createElement)(
              "button",
              {
                key: id,
                type: "button",
                onClick: () => setPage(id),
                style: {
                  cursor: "pointer",
                  borderRadius: 8,
                  border: id === page ? "1px solid rgba(127,127,127,0.7)" : "1px solid rgba(127,127,127,0.4)",
                  background: id === page ? "rgba(127,127,127,0.12)" : "transparent",
                  color: "inherit",
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: id === page ? 600 : 400,
                  lineHeight: "20px",
                  padding: "4px 14px"
                }
              },
              t(PAGE_KEYS[id])
            )
          ),
          // The open-in-browser action rides the TAB row — right
          // after the logs tab, pushed to the row's far end —
          // instead of sitting in the footer below the iframe.
          openWebButton({ marginLeft: "auto", fontSize: "13", lineHeight: "20px", padding: "4px 14px" })
        ),
        (0, import_react.createElement)("iframe", {
          src: `${origin}/__bili/?embed=1&lang=${lang}${theme ? `&theme=${theme}` : ""}#/${page}`,
          title: t("title"),
          style: {
            display: "block",
            width: "100%",
            height: EMBED_HEIGHT,
            border: "1px solid rgba(127,127,127,0.4)",
            borderRadius: 8,
            background: "transparent"
          }
        })
      );
    } else {
      middle = (0, import_react.createElement)("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("connecting"));
    }
    return (0, import_react.createElement)(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
      titled ? (0, import_react.createElement)("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")) : null,
      middle,
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
        (0, import_react.createElement)("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6, flex: 1, minWidth: 200 } }, t("hint")),
        // ok 状态:按钮在上方页签行(日志页签后面);degraded/stale
        // 仍留在页脚作后备入口(#2448 同一按钮)。
        liveEmbed === "ok" ? null : openWebButton()
      )
    );
  };
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register({ name: "settings.section", id: "bili", order: 100, label: () => t("nav"), locale: NS }, panel(true))
  );
  ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register({ name: "plugins.bundle.config", key: "billion-context", locale: NS }, panel(false))
  );
}

return module.exports;
}});
