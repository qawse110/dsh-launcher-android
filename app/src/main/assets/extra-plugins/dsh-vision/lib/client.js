window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-vision",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
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

// src/client/index.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);

// src/client/VisionSection.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var CSS = `
.dvs-page { display: flex; flex-direction: column; gap: 14px; max-width: 680px; padding: 2px 0 28px; }
.dvs-page select, .dvs-page input[type="text"], .dvs-page input:not([type]) {
  font: inherit; color: inherit; background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  border-radius: 8px; padding: 7px 10px; width: 100%; box-sizing: border-box;
}
.dvs-page select { background: color-mix(in srgb, currentColor 7%, transparent); }
.dvs-page select:focus, .dvs-page input:focus { outline: none; border-color: currentColor; }
/* \u539F\u751F\u4E0B\u62C9\u5F39\u5C42\u8DDF\u968F\u4E3B\u9898\uFF1AChrome \u7684 option \u5F39\u5C42\u4E0D\u4F1A\u81EA\u52A8\u7EE7\u627F :root \u7684
   color-scheme\uFF0C\u6697\u8272\u4E3B\u9898\u4E0B\u4F1A\u9000\u5316\u6210\u300C\u767D\u5E95\u767D\u5B57\u300D\u770B\u4E0D\u89C1\u3002\u7528 DSH \u7684
   data-ds-dark-theme \u6807\u8BB0\u53EA\u7ED9\u6697\u8272\u4E3B\u9898\u663E\u5F0F\u8986\u76D6\uFF0C\u4EAE\u8272\u4E3B\u9898\u5B8C\u5168\u4E0D\u53D7\u5F71\u54CD\u3002 */
body[data-ds-dark-theme] .dvs-page select { color-scheme: dark; }
body[data-ds-dark-theme] .dvs-page select option {
  background-color: var(--dsw-alias-bg-overlay, #1f2937);
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.dvs-mode { display: flex; flex-direction: column; gap: 4px; flex: 1;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 10px; padding: 11px 12px; cursor: pointer; }
.dvs-mode[data-active="true"] { border-color: currentColor; }
.dvs-mode-title { font-size: 14px; font-weight: 600; }
.dvs-mode-desc { font-size: 12px; opacity: .62; line-height: 1.5; }
.dvs-row { display: flex; flex-direction: column; gap: 5px; }
.dvs-label { font-size: 12px; opacity: .75; }
.dvs-hint { font-size: 12px; opacity: .55; line-height: 1.5; }
.dvs-warn { font-size: 12px; opacity: .8; line-height: 1.5; color: color-mix(in srgb, currentColor 70%, #b45309); }
.dvs-err { font-size: 12px; opacity: .8; color: #dc2626; }
.dvs-ok { font-size: 12px; opacity: .8; color: #16a34a; }
.dvs-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dvs-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dvs-status { font-size: 13px; opacity: .85; }
.dvs-result { white-space: pre-wrap; font-size: 13px; line-height: 1.55; border-radius: 8px;
  padding: 10px 12px; max-height: 240px; overflow: auto;
  background: color-mix(in srgb, currentColor 6%, transparent); }
`;
var sampleQuestion = "What is shown in this image? Reply briefly with the key details and any visible text.";
var num = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
var str = (value, fallback) => typeof value === "string" ? value : fallback;
function VisionSection(props) {
  const api = props.api;
  const subscribe = props.subscribe;
  const [draft, setDraft] = (0, import_react.useState)({
    backend: "custom",
    provider: "",
    model: "",
    baseURL: "",
    apiKey: "",
    fallbackText: "",
    maxTokens: "2048",
    timeoutMs: "60000",
    maxImageBytes: String(10 * 1024 * 1024),
    testSource: ""
  });
  const [stored, setStored] = (0, import_react.useState)();
  const [namespaceMissing, setNamespaceMissing] = (0, import_react.useState)(false);
  const [writable, setWritable] = (0, import_react.useState)(true);
  const [providers, setProviders] = (0, import_react.useState)([]);
  const [groups, setGroups] = (0, import_react.useState)([]);
  const [loading, setLoading] = (0, import_react.useState)(true);
  const [loadError, setLoadError] = (0, import_react.useState)();
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [status, setStatus] = (0, import_react.useState)();
  const [testState, setTestState] = (0, import_react.useState)({ busy: false });
  const patch = (part) => setDraft((previous) => ({ ...previous, ...part }));
  const load = async () => {
    if (api === void 0) return;
    setLoadError(void 0);
    try {
      const [described, providerList, modelList] = await Promise.all([
        api.settings.describe({}),
        api.llm.providers({}),
        api.llm.models({})
      ]);
      if (!described.result.ok) throw new Error(described.result.error.message);
      setWritable(described.result.value.writable);
      const ns = described.result.value.namespaces.find((view) => view.ns === "vision");
      setNamespaceMissing(ns === void 0);
      if (ns !== void 0) {
        const value = ns.value;
        setStored({ value, revision: ns.revision, secrets: ns.secrets });
        setDraft({
          backend: str(value.backend, "custom") === "provider" ? "provider" : "custom",
          provider: str(value.provider, ""),
          model: str(value.model, ""),
          baseURL: str(value.baseURL, ""),
          apiKey: "",
          fallbackText: Array.isArray(value.fallbackModels) ? value.fallbackModels.join(", ") : "",
          maxTokens: String(num(value.maxTokens, 2048)),
          timeoutMs: String(num(value.timeoutMs, 6e4)),
          maxImageBytes: String(num(value.maxImageBytes, 10 * 1024 * 1024)),
          testSource: ""
        });
      }
      if (providerList.result.ok) setProviders(providerList.result.value.providers);
      if (modelList.result.ok) setGroups(modelList.result.value.groups);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    void load();
    const dispose = subscribe?.(() => {
      void load();
    });
    return dispose;
  }, []);
  const keyConfigured = (path) => stored?.secrets?.some((secret) => secret.path.length === 1 && secret.path[0] === path && secret.set) ?? false;
  const providerOption = (view) => view.active ? view.displayName : `${view.displayName}\uFF08\u672A\u6FC0\u6D3B \u2014\u2014 \u53BB \u8BBE\u7F6E \u2192 Models \u914D\u7F6E\u540E\u53EF\u7528\uFF09`;
  const modelsOf = (groupId) => {
    const group = groups.find((g) => g.id === groupId);
    return group?.models ?? [];
  };
  const save = async () => {
    if (api === void 0 || busy) return;
    if (stored === void 0) {
      setStatus({ kind: "error", text: "\u5F53\u524D\u672A\u89C1 vision \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\uFF08\u5BBF\u4E3B\u63D2\u4EF6\u672A\u6CE8\u518C\uFF09\u3002\u8BF7\u91CD\u542F dsh web \u670D\u52A1\u540E\u5237\u65B0\u672C\u9875\u518D\u8BD5\u3002" });
      return;
    }
    if (!writable) return;
    setBusy(true);
    setStatus(void 0);
    try {
      const value = stored.value;
      const ops = [];
      const setIf = (key, next) => {
        if (JSON.stringify(value[key]) !== JSON.stringify(next)) ops.push({ op: "set", path: [key], value: next });
      };
      setIf("backend", draft.backend);
      setIf("provider", draft.provider);
      setIf("model", draft.model);
      setIf("baseURL", draft.baseURL);
      if (draft.apiKey !== "") ops.push({ op: "set", path: ["apiKey"], value: draft.apiKey });
      const fallbacks = draft.fallbackText.split(",").map((part) => part.trim()).filter((part) => part !== "");
      setIf("fallbackModels", fallbacks);
      setIf("maxTokens", Number(draft.maxTokens) || 2048);
      setIf("timeoutMs", Number(draft.timeoutMs) || 6e4);
      setIf("maxImageBytes", Number(draft.maxImageBytes) || 10 * 1024 * 1024);
      if (ops.length === 0) {
        setStatus({ kind: "info", text: "\u6CA1\u6709\u9700\u8981\u4FDD\u5B58\u7684\u6539\u52A8\u3002" });
        return;
      }
      const response = await api.settings.mutate({ ns: "vision", ops, expectedRevision: stored.revision });
      if (!response.result.ok) {
        if (response.result.error.code === "settings-conflict") {
          setStatus({ kind: "error", text: "\u8BBE\u7F6E\u5DF2\u88AB\u5176\u4ED6\u9875\u9762\u4FEE\u6539\uFF0C\u5DF2\u91CD\u65B0\u52A0\u8F7D\u5F53\u524D\u503C\uFF0C\u8BF7\u518D\u6B21\u4FDD\u5B58\u3002" });
          await load();
        } else {
          setStatus({ kind: "error", text: `\u4FDD\u5B58\u5931\u8D25\uFF1A${response.result.error.message}` });
        }
        return;
      }
      setStored({
        value: response.result.value.value,
        revision: response.result.value.revision,
        secrets: response.result.value.secrets
      });
      patch({ apiKey: "" });
      setStatus({ kind: "ok", text: "\u5DF2\u4FDD\u5B58\u3002view_image \u5DE5\u5177\u5373\u65F6\u751F\u6548\uFF08\u65E0\u9700\u91CD\u542F\uFF09\u3002" });
    } catch (error) {
      setStatus({ kind: "error", text: `\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };
  const clearKey = async () => {
    if (api === void 0 || busy) return;
    if (stored === void 0) {
      setStatus({ kind: "error", text: "\u5F53\u524D\u672A\u89C1 vision \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\uFF08\u5BBF\u4E3B\u63D2\u4EF6\u672A\u6CE8\u518C\uFF09\u3002\u8BF7\u91CD\u542F dsh web \u670D\u52A1\u540E\u5237\u65B0\u672C\u9875\u518D\u8BD5\u3002" });
      return;
    }
    if (!writable) return;
    setBusy(true);
    try {
      const response = await api.settings.mutate({ ns: "vision", ops: [{ op: "unset", path: ["apiKey"] }], expectedRevision: stored.revision });
      if (!response.result.ok) {
        setStatus({ kind: "error", text: `\u6E05\u9664\u5931\u8D25\uFF1A${response.result.error.message}` });
        return;
      }
      setStored({ value: response.result.value.value, revision: response.result.value.revision, secrets: response.result.value.secrets });
      setStatus({ kind: "ok", text: "\u5DF2\u6E05\u9664 apiKey\u3002" });
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    if (api === void 0 || testState.busy) return;
    setTestState({ busy: true });
    setStatus(void 0);
    try {
      const fallbacks = draft.fallbackText.split(",").map((part) => part.trim()).filter((part) => part !== "");
      const response = await fetch("/dsh-vision/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          backend: draft.backend,
          provider: draft.provider,
          model: draft.model,
          baseURL: draft.baseURL,
          apiKey: draft.apiKey,
          fallbackModels: fallbacks,
          maxTokens: Number(draft.maxTokens) || 2048,
          timeoutMs: Number(draft.timeoutMs) || 6e4,
          maxImageBytes: Number(draft.maxImageBytes) || 10 * 1024 * 1024,
          source: draft.testSource === "" ? void 0 : draft.testSource,
          question: sampleQuestion
        })
      });
      const payload = await response.json();
      if (payload.ok) {
        setTestState({ busy: false, text: payload.text ?? "", error: void 0 });
      } else {
        setTestState({ busy: false, text: void 0, error: payload.error ?? "\u8BF7\u6C42\u5931\u8D25" });
      }
    } catch (error) {
      setTestState({ busy: false, text: void 0, error: `\u8BF7\u6C42\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` });
    }
  };
  if (loading) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dvs-hint", children: "\u52A0\u8F7D\u4E2D\u2026" });
  if (loadError !== void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-page", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dvs-err", children: [
        "\u65E0\u6CD5\u52A0\u8F7D\u8BBE\u7F6E\uFF1A",
        loadError
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dvs-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => {
        setLoading(true);
        void load();
      }, children: "\u91CD\u8BD5" }) })
    ] });
  }
  const backend = draft.backend;
  const selectedProvider = providers.find((view) => view.provider === draft.provider);
  const selectedModels = modelsOf(draft.provider);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: CSS }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dvs-row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dvs-hint", children: [
      "\u4E3A ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "view_image" }),
      " \u5DE5\u5177\u9009\u62E9\u540E\u7AEF\u3002\u300C\u590D\u5236 DSH \u63D0\u4F9B\u5546\u300D\u76F4\u63A5\u4F7F\u7528 \u8BBE\u7F6E \u2192 Models \u4E2D\u5DF2\u914D\u7F6E\u7684\u63D0\u4F9B\u5546\uFF08\u5BC6\u94A5\u3001\u7AEF\u70B9\u3001\u8DEF\u7531\u90FD\u7531 DSH \u7BA1\u7406\uFF0C\u6A21\u578B\u9700\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF09\uFF1B\u300C\u81EA\u5B9A\u4E49\u7AEF\u70B9\u300D\u4F7F\u7528\u4E0B\u65B9\u72EC\u7ACB\u914D\u7F6E\uFF08\u9ED8\u8BA4\u667A\u8C31\u514D\u8D39 glm-4.6v-flash\uFF0C\u96F6\u914D\u7F6E\u5F00\u7BB1\u5373\u7528\uFF09\u3002"
    ] }) }),
    namespaceMissing && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dvs-warn", style: { color: "#dc2626" }, children: [
      "\u26A0 \u672A\u68C0\u6D4B\u5230 ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "vision" }),
      " \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4 \u2014\u2014 \u5BBF\u4E3B\u4FA7\u672A\u63D0\u4F9B\uFF08\u63D2\u4EF6\u672A\u6CE8\u518C\uFF0C\u6216 DSH \u5185\u6838\u672A\u628A\u5B83\u52A0\u5165\u66B4\u9732\u767D\u540D\u5355\uFF09\u3002\u4FDD\u5B58\u4E0D\u4F1A\u751F\u6548\u3002\u8BF7\u91CD\u542F ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "dsh web" }),
      " \u670D\u52A1\u540E\u5237\u65B0\u672C\u9875\uFF1B\u82E5\u4ECD\u51FA\u73B0\u672C\u63D0\u793A\uFF0C\u8BF4\u660E\u8FD8\u9700\u628A ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "vision" }),
      " \u52A0\u5165 apiproxy \u7684 WEB_SETTINGS_NAMESPACES\u3002"
    ] }),
    !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dvs-warn", children: "\u5F53\u524D\u4F1A\u8BDD\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u6539\u52A8\uFF08\u4ECD\u53EF\u8FD0\u884C\u6D4B\u8BD5\uFF09\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-modes", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "div",
        {
          className: "dvs-mode",
          "data-active": backend === "provider",
          onClick: () => patch({ backend: "provider" }),
          role: "button",
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") patch({ backend: "provider" });
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-mode-title", children: "\u590D\u7528 DSH \u63D0\u4F9B\u5546\uFF08\u63A8\u8350\uFF09" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-mode-desc", children: "\u4F7F\u7528 \u8BBE\u7F6E \u2192 Models \u4E2D\u7684\u63D0\u4F9B\u5546\u8DEF\u7531 + \u6A21\u578B id\u3002apiKey\u3001baseURL\u3001\u8DEF\u7531\u3001\u91CD\u8BD5\u5168\u90E8\u7EE7\u627F DSH \u73B0\u6709\u914D\u7F6E\u3002" })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "div",
        {
          className: "dvs-mode",
          "data-active": backend === "custom",
          onClick: () => patch({ backend: "custom" }),
          role: "button",
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") patch({ backend: "custom" });
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-mode-title", children: "\u81EA\u5B9A\u4E49 OpenAI \u517C\u5BB9\u7AEF\u70B9" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-mode-desc", children: "\u72EC\u7ACB\u7684 baseURL / apiKey / \u6A21\u578B / \u56DE\u9000\u94FE\u3002\u9ED8\u8BA4\u667A\u8C31\u514D\u8D39 glm-4.6v-flash\u3002" })
          ]
        }
      )
    ] }),
    backend === "provider" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-grid2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "Provider\uFF08DSH \u63D0\u4F9B\u5546\u8DEF\u7531\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: draft.provider, onChange: (event) => patch({ provider: event.target.value }), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u2014 \u9009\u62E9\u4E00\u4E2A\u63D0\u4F9B\u5546 \u2014" }),
            providers.map((view) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: view.provider, children: providerOption(view) }, view.provider))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "\u6A21\u578B id\uFF08\u9700\u652F\u6301 image \u8F93\u5165\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              list: "dvs-model-options",
              type: "text",
              value: draft.model,
              placeholder: "\u4F8B\u5982 glm-4.6v / qwen3-vl-flash / gpt-4o",
              onChange: (event) => patch({ model: event.target.value })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", { id: "dvs-model-options", children: selectedModels.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: model.id }, model.id)) }),
          selectedModels.length === 0 && draft.provider !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-hint", children: "\u8BE5\u63D0\u4F9B\u5546\u672A\u8FD4\u56DE\u6A21\u578B\u76EE\u5F55\uFF08\u53EF\u80FD\u5728 Models \u8BBE\u7F6E\u4E2D\u672A\u5B8C\u6210\uFF0C\u6216\u76EE\u5F55\u4E0D\u53EF\u7528\uFF09\u2014\u2014 \u53EF\u76F4\u63A5\u8F93\u5165\u6A21\u578B id\u3002" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dvs-warn", children: [
        "\u26A0 provider \u6A21\u5F0F\u4E0B\u8BF7\u786E\u8BA4\u6240\u9009\u6A21\u578B\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF1A\u81EA\u5B9A\u4E49\uFF08llm-pi-ai\uFF09\u63D0\u4F9B\u5546\u9700\u5728 \u8BBE\u7F6E \u2192 Models \u7684\u6A21\u578B\u58F0\u660E\u4E2D\u5E26 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "input: [text, image]" }),
        "\uFF1B\u5B98\u65B9\u6E20\u9053\u6A21\u578B\uFF08\u5982 deepseek/vision \u7C7B\uFF09\u81EA\u5E26\u58F0\u660E\u3002\u6A21\u578B\u4E0D\u652F\u6301\u56FE\u7247\u65F6\u4F1A\u76F4\u63A5\u62A5\u9519\u3002"
      ] })
    ] }),
    backend === "custom" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "Base URL\uFF08\u81EA\u52A8\u8FFD\u52A0 /chat/completions\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "text",
            value: draft.baseURL,
            placeholder: "https://open.bigmodel.cn/api/paas/v4",
            onChange: (event) => patch({ baseURL: event.target.value })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-grid2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dvs-label", children: [
            "API key",
            keyConfigured("apiKey") ? "\uFF08\u5DF2\u914D\u7F6E\uFF0C\u7559\u7A7A\u4FDD\u6301\u4E0D\u53D8\uFF09" : ""
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "password",
                value: draft.apiKey,
                placeholder: keyConfigured("apiKey") ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "sk-\u2026",
                onChange: (event) => patch({ apiKey: event.target.value })
              }
            ),
            keyConfigured("apiKey") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => void clearKey(), children: "\u6E05\u9664" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-hint", children: "\u7559\u7A7A\u65F6\u56DE\u9000 $VISION_API_KEY / $ZHIPUAI_API_KEY / $DASHSCOPE_API_KEY\u3002" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "\u6A21\u578B id" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "text",
              value: draft.model,
              placeholder: "glm-4.6v-flash",
              onChange: (event) => patch({ model: event.target.value })
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "\u56DE\u9000\u6A21\u578B\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u4E3B\u6A21\u578B 429/404/5xx \u65F6\u4F9D\u6B21\u5C1D\u8BD5\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "text",
            value: draft.fallbackText,
            placeholder: "\u9ED8\u8BA4\u7AEF\u70B9\u7559\u7A7A = glm-4.1v-thinking-flash, glm-4v-flash",
            onChange: (event) => patch({ fallbackText: event.target.value })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-grid2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "maxTokens" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "number", min: 1, max: 32768, value: draft.maxTokens, onChange: (event) => patch({ maxTokens: event.target.value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "timeoutMs" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "number", min: 1e3, max: 3e5, value: draft.timeoutMs, onChange: (event) => patch({ timeoutMs: event.target.value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "maxImageBytes" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "number", min: 1, value: draft.maxImageBytes, onChange: (event) => patch({ maxImageBytes: event.target.value }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dvs-label", children: "\u6D4B\u8BD5\u56FE\u7247\uFF08\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u6837\u4F8B\u56FE assets/demo-input.jpeg\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "text",
          value: draft.testSource,
          placeholder: "C:\\path\\to\\image.png \u6216 https://\u2026 \u6216 data:\u2026",
          onChange: (event) => patch({ testSource: event.target.value })
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dvs-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "md", disabled: !writable || namespaceMissing || busy, onClick: () => void save(), children: "\u4FDD\u5B58\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "md", disabled: testState.busy, onClick: () => void runTest(), children: testState.busy ? "\u6D4B\u8BD5\u4E2D\u2026" : "\u6D4B\u8BD5\u8FDE\u63A5" }),
      status !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: status.kind === "ok" ? "dvs-ok" : status.kind === "error" ? "dvs-err" : "dvs-status", children: status.text })
    ] }),
    testState.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "dvs-result", style: { color: "#dc2626" }, children: testState.error }),
    testState.text !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "dvs-result", children: testState.text })
  ] });
}

// src/client/index.tsx
var name = "dsh-vision";
var inject = ["slots", "locale", "connection", "remote"];
function apply(ctx) {
  ctx.slots.inject("settings.section", () => {
    const connection = ctx.get("connection");
    const injected = {
      api: connection.api,
      loopback: connection.isLoopback,
      subscribe: (listener) => {
        const disposers = [
          ctx.remote.$on("settings/document-updated", (ns) => {
            if (ns === "vision") listener();
          }),
          ctx.remote.$on("llm/adapters-updated", () => listener())
        ];
        return () => {
          for (const dispose of disposers) dispose();
        };
      }
    };
    return ctx.slots.register({
      name: "settings.section",
      id: "dsh-vision",
      order: 20,
      label: () => "Vision",
      inject: () => injected
    }, VisionSection);
  });
}

		return module.exports;
	}
});
