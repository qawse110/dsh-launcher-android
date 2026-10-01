window.__ModuleLoader__.load({
	id: "dsh-provider-headers",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let // ── dsh-launcher 适配（dsh 0.1.7-rc.2）────────────────────────────────
// 上游此包 require 的是 "@deepseek-ai/dsh-client-runtime/client"，该包在
// 0.1.7-rc.2 里**已不存在**（全仓 0 命中）。createSnapshotStore 现由
// "@deepseek-ai/dsh-client-store" 导出，签名一致：createSnapshotStore(init, opts)。
// 佐证：宿主自带的 dsh-client-ui-sidebar/lib/client.js 正是从这个包取它。
_client_runtime_client = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/locales.js
		/** Locale bundles for the provider-headers settings section. */
		const en = {
			nav: "Request headers",
			intro: "Custom HTTP request headers sent with every request to a custom provider. Headers are stored in llm-pi-ai.providers.<route>.headers and applied by the adapter on each call.",
			loading: "Loading providers…",
			loadError: "Could not load provider headers.",
			empty: "No custom (llm-pi-ai) providers configured yet. Add one on the Models page first.",
			readOnly: "Settings are read-only in this session.",
			provider: "Provider",
			headerKey: "Header name",
			headerKeyPlaceholder: "X-Custom-Header",
			headerValue: "Value",
			headerValuePlaceholder: "header value",
			add: "Add header",
			remove: "Remove",
			save: "Save",
			saved: "Saved.",
			keysHint: "Attribution headers (User-Agent and x-deepseek-harness-*) are reserved and cannot be overridden.",
			noHeaders: "No custom request headers yet.",
			sendAttribution: "Send attribution request headers",
			sendAttributionHint: "When off, the forced User-Agent (deepseek-harness/…) is omitted and your custom User-Agent is sent.",
			error: "error"
		};
		const zh = {
			nav: "请求头",
			intro: "向自定义提供方的每次请求附带的自定义 HTTP 请求头。配置保存在 llm-pi-ai.providers.<route>.headers 中，适配器在每次调用时生效。",
			loading: "正在加载提供方…",
			loadError: "无法加载提供方请求头。",
			empty: "还没有配置自定义（llm-pi-ai）提供方。请先在「模型」页面添加。",
			readOnly: "当前会话中设置为只读。",
			provider: "提供方",
			headerKey: "请求头名称",
			headerKeyPlaceholder: "X-Custom-Header",
			headerValue: "值",
			headerValuePlaceholder: "请求头值",
			add: "添加请求头",
			remove: "删除",
			save: "保存",
			saved: "已保存。",
			keysHint: "归因请求头（User-Agent 与 x-deepseek-harness-*）为保留项，不可覆盖。",
			noHeaders: "暂无自定义请求头。",
			sendAttribution: "发送归因请求头",
			sendAttributionHint: "关闭后不再强制发送 User-Agent（deepseek-harness/…），将使用你配置的自定义 User-Agent。",
			error: "错误"
		};
		//#endregion
		//#region lib/types/store.js
		/**
		* Section store: joins the llm-pi-ai settings namespace into a list of
		* provider routes with their current headers. The host stays the single
		* fact source; every mutation writes through the wire and re-reads.
		*/
		const NS = "llm-pi-ai";
		var HeadersSectionStore = class {
			/**
			* ── dsh-launcher 修复（dsh 0.1.7-rc.2）──────────────────────────
			* 上游构造签名是 (api)，调用方传的是 `ctx.get("connection").api`。
			* 但 0.1.7-rc.2 的 connection 服务**没有 api 成员**（全仓 grep `connection.api` 0 命中），
			* 故 `this.api.settings.describe` 直接抛 TypeError → 设置页显示「无法加载提供方请求头」。
			*
			* 正确契约是 **ctx.remote.settings**（宿主自带插件一致用法）：
			*   describe()                        → { ok, value: { writable, namespaces: [{ns, value, revision}] } }
			*   mutate(ns, ops, expectedRevision) → { ok, value: { revision, … } } | { ok:false, error:{code,message} }
			* 注意返回值是**直接响应**（`response.ok/value`），不是上游代码里写的 `response.result.ok`。
			* ──────────────────────────────────────────────────────────────
			*/
			constructor(settings) {
				this.api = { settings };
				this.generation = 0;
				this.store = (0, _client_runtime_client.createSnapshotStore)({
					status: "idle",
					error: null,
					writable: false,
					revision: void 0,
					providers: []
				});
			}
			async load() {
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "loading";
					s.error = null;
				});
				let view;
				let writable;
				try {
					// 直接响应形状：{ ok, value } | { ok:false, error }（见构造器注释）
					const response = await this.api.settings.describe();
					if (!response.ok) throw new Error(response.error && response.error.message || "settings.describe failed");
					writable = response.value.writable;
					const namespaces = response.value.namespaces;
					view = Array.isArray(namespaces) ? namespaces.find((entry) => entry.ns === NS) : void 0;
				} catch (error) {
					if (generation !== this.generation) return;
					this.store.update((s) => {
						s.status = "error";
						s.error = error instanceof Error ? error.message : String(error);
					});
					return;
				}
				if (generation !== this.generation) return;
				const providers = [];
				const profileDict = view !== void 0 && view.value !== void 0 && typeof view.value === "object" && view.value !== null ? view.value.providers : void 0;
				if (typeof profileDict === "object" && profileDict !== null) {
					for (const route of Object.keys(profileDict)) {
						const profile = profileDict[route];
						if (typeof profile !== "object" || profile === null) continue;
						const headers = typeof profile.headers === "object" && profile.headers !== null ? profile.headers : {};
						providers.push({
							route,
							displayName: typeof profile.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : route,
							headers: Object.assign({}, headers),
							sendAttribution: profile.sendAttribution !== false
						});
					}
				}
				this.store.update((s) => {
					s.status = "ready";
					s.writable = !!writable;
					s.revision = view !== void 0 ? view.revision : void 0;
					s.providers = providers;
				});
			}
			/**
			* Write one provider's headers into the llm-pi-ai namespace, then refresh.
			* @param route - provider route key.
			* @param headers - plain header name -> value map.
			* @returns the mutated namespace revision, or throws on refusal.
			*/
			async save(route, headers, sendAttribution) {
				const snapshot = this.store.getSnapshot();
				const ops = [{ op: "set", path: ["providers", route, "headers"], value: headers }];
				if (sendAttribution === false) ops.push({ op: "set", path: ["providers", route, "sendAttribution"], value: false });
				else ops.push({ op: "unset", path: ["providers", route, "sendAttribution"] });
				// mutate 是**位置参数**（ns, ops, expectedRevision），不是对象参数；
				// 返回**直接响应** { ok, value } | { ok:false, error }（非上游写的 response.result）。
				const response = await this.api.settings.mutate(NS, ops, snapshot.revision);
				if (!response.ok) throw new Error(response.error && response.error.message || "settings.mutate failed");
				await this.load();
				return response.value;
			}
		};
		//#endregion
		//#region lib/types/section.jsx
		/** Row-level key/value editor for one provider. */
		function HeaderRow(props) {
			const { row, index, disabled, onChange, onRemove, t } = props;
			const inputStyle = {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				width: "100%",
				height: 32,
				font: "inherit",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: 8,
				padding: "0 10px",
				fontSize: 14,
				lineHeight: "22px"
			};
			const buttonStyle = {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				height: 32,
				color: "var(--dsw-alias-label-tertiary)",
				font: "inherit",
				cursor: "pointer",
				background: "0 0",
				borderRadius: 8,
				padding: "0 10px",
				fontSize: 12,
				lineHeight: "18px",
				whiteSpace: "nowrap"
			};
			return react_jsx_runtime.jsx("div", {
				style: { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "center" },
				children: [
					react_jsx_runtime.jsx("input", {
						type: "text",
						value: row.key,
						placeholder: t("headerKeyPlaceholder"),
						"aria-label": t("headerKey"),
						disabled,
						style: inputStyle,
						onChange: (event) => onChange(index, { ...row, key: event.target.value })
					}, "key"),
					react_jsx_runtime.jsx("input", {
						type: "text",
						value: row.value,
						placeholder: t("headerValuePlaceholder"),
						"aria-label": t("headerValue"),
						disabled,
						style: inputStyle,
						onChange: (event) => onChange(index, { ...row, value: event.target.value })
					}, "value"),
					react_jsx_runtime.jsx("button", {
						type: "button",
						disabled,
						style: buttonStyle,
						onClick: () => onRemove(index),
						children: t("remove")
					}, "remove")
				]
			});
		}
		/** One provider card: name, headers rows, save. */
		function ProviderCard(props) {
			const { provider, writable, saving, error, onSave, t } = props;
			const initialRows = () => Object.entries(provider.headers).map(([key, value]) => ({ key, value }));
			const [rows, setRows] = react.useState(initialRows);
			const [sendAttribution, setSendAttribution] = react.useState(provider.sendAttribution !== false);
			const [edited, setEdited] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const headersKey = JSON.stringify(provider.headers);
			const prevKey = react.useRef(headersKey);
			react.useEffect(() => {
				if (prevKey.current !== headersKey && !edited) setRows(initialRows());
				prevKey.current = headersKey;
			});
			const update = (index, row) => {
				setRows((previous) => previous.map((entry, i) => i === index ? row : entry));
				setEdited(true);
				setNotice(null);
			};
			const removeRow = (index) => {
				setRows((previous) => previous.filter((_, i) => i !== index));
				setEdited(true);
				setNotice(null);
			};
			const addRow = () => {
				setRows((previous) => [...previous, { key: "", value: "" }]);
				setEdited(true);
			};
			const save = async () => {
				const headers = {};
				for (const row of rows) {
					const key = String(row.key).trim();
					if (key.length === 0) continue;
					headers[key] = String(row.value);
				}
				try {
					await onSave(provider.route, headers, sendAttribution);
					setRows(Object.entries(headers).map(([key, value]) => ({ key, value })));
					setEdited(false);
					setNotice(t("saved"));
				} catch (saveError) {
					setNotice(saveError instanceof Error ? saveError.message : String(saveError));
				}
			};
			const cardStyle = {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 12,
				flexDirection: "column",
				gap: 12,
				padding: "12px 14px",
				display: "flex"
			};
			const headStyle = {
				alignItems: "center",
				gap: 10,
				display: "flex"
			};
			const nameStyle = { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 500, lineHeight: "22px" };
			const tagStyle = {
				border: "1px solid var(--dsw-alias-border-l3)",
				color: "var(--dsw-alias-label-secondary)",
				borderRadius: 4,
				flex: "none",
				padding: "1px 6px",
				fontSize: 11,
				lineHeight: "16px"
			};
			const buttonStyle = {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				height: 36,
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				cursor: "pointer",
				background: "0 0",
				borderRadius: 18,
				alignItems: "center",
				justifyContent: "center",
				gap: 4,
				padding: "0 14px",
				fontSize: 14,
				lineHeight: "22px",
				display: "inline-flex"
			};
			return react_jsx_runtime.jsx("div", {
				style: cardStyle,
				children: [
					react_jsx_runtime.jsx("div", {
						style: headStyle,
						children: [
							react_jsx_runtime.jsx("span", { style: nameStyle, children: provider.displayName }, "name"),
							react_jsx_runtime.jsx("span", { style: tagStyle, children: provider.route }, "route")
						]
					}, "head"),
					react_jsx_runtime.jsx("label", {
						style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", cursor: writable ? "pointer" : "not-allowed" },
						children: [
							react_jsx_runtime.jsx("input", {
								type: "checkbox",
								checked: sendAttribution,
								disabled: !writable || saving,
								style: { width: 16, height: 16, margin: 0, accentColor: "var(--dsw-alias-button-primary-fill)" },
								onChange: (event) => {
									setSendAttribution(event.target.checked);
									setEdited(true);
									setNotice(null);
								}
							}, "toggle"),
							t("sendAttribution")
						]
					}, "attribution"),
					rows.length === 0 ? react_jsx_runtime.jsx("p", { style: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" }, children: t("noHeaders") }, "empty") : null,
					rows.map((row, index) => react_jsx_runtime.jsx(HeaderRow, {
						row,
						index,
						disabled: !writable || saving,
						onChange: update,
						onRemove: removeRow,
						t
					}, index)),
					react_jsx_runtime.jsx("div", {
						style: { display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" },
						children: [
							notice !== null ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warn-label)", fontSize: 12, lineHeight: "18px", marginRight: "auto" }, children: notice }, "notice") : null,
							error !== null ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px", marginRight: "auto" }, children: error }, "error") : null,
							react_jsx_runtime.jsx("button", {
								type: "button",
								disabled: !writable || saving,
								style: buttonStyle,
								onClick: addRow,
								children: t("add")
							}, "add"),
							react_jsx_runtime.jsx("button", {
								type: "button",
								disabled: !writable || saving,
								style: { ...buttonStyle, background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)", border: "none" },
								onClick: save,
								children: saving ? "…" : t("save")
							}, "save")
						]
					}, "actions")
				]
			});
		}
		/** The settings section content. */
		function HeadersSection(props) {
			const { controller, useSnapshot, t } = props;
			const state = useSnapshot();
			const [savingRoute, setSavingRoute] = react.useState(null);
			const [saveError, setSaveError] = react.useState(null);
			react.useEffect(() => {
				controller.load();
			}, []);
			if (state.status === "idle" || state.status === "loading") {
				return react_jsx_runtime.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 14, lineHeight: "22px" }, children: t("loading") });
			}
			if (state.status === "error") {
				return react_jsx_runtime.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 14, lineHeight: "22px" }, children: t("loadError") });
			}
			const sectionStyle = {
				maxWidth: 720,
				color: "var(--dsw-alias-label-primary)",
				flexDirection: "column",
				gap: 12,
				display: "flex"
			};
			const titleStyle = { color: "var(--dsw-alias-label-primary)", margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" };
			const introStyle = { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 14, lineHeight: "22px" };
			const hintStyle = { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 12, lineHeight: "18px" };
			const onSave = async (route, headers, sendAttribution) => {
				setSaveError(null);
				setSavingRoute(route);
				try {
					await controller.save(route, headers, sendAttribution);
				} finally {
					setSavingRoute(null);
				}
			};
			const providerCards = state.providers.length === 0 ? react_jsx_runtime.jsx("p", { style: introStyle, children: t("empty") }, "empty") : state.providers.map((provider) => react_jsx_runtime.jsx(ProviderCard, {
				provider,
				writable: state.writable,
				saving: savingRoute === provider.route,
				error: saveError,
				onSave,
				t
			}, provider.route));
			return react_jsx_runtime.jsx("div", {
				style: sectionStyle,
				children: [
					react_jsx_runtime.jsx("h2", { style: titleStyle, children: t("nav") }, "title"),
					react_jsx_runtime.jsx("p", { style: introStyle, children: t("intro") }, "intro"),
					!state.writable ? react_jsx_runtime.jsx("p", { style: { ...hintStyle, color: "var(--dsw-alias-state-warn-label)" }, children: t("readOnly") }, "readonly") : null,
					providerCards,
					react_jsx_runtime.jsx("p", { style: hintStyle, children: t("keysHint") }, "hint")
				]
			});
		}
		//#endregion
		//#region lib/types/index.js
		/** Locale namespace key. */
		const NS_LOCALE = "providerHeaders";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			// 修复：上游声明 "connection"，但它要的其实是 settings 远程面。
			// 0.1.7-rc.2 的 connection 服务**没有 api 成员**（全仓 0 命中）；
			// 宿主自带插件一致声明 "remote.settings" 并从 ctx.remote.settings 调用。
			"remote.settings"
		];
		/**
		* Register the "请求头" settings section once the settings.section
		* declaration is on the ledger, and keep its store fresh on every pushed
		* llm-pi-ai invalidation.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS_LOCALE, { zh, en }), "provider-headers: copy dictionaries");
			// 修复：从 ctx.remote.settings 取（而非已不存在的 connection.api）。
			const settings = ctx.remote && ctx.remote.settings;
			if (settings === void 0) return;
			const controller = new HeadersSectionStore(settings);
			const useSnapshot = (selector) => react.useSyncExternalStore((callback) => controller.store.subscribe(callback), () => selector === void 0 ? controller.store.getSnapshot() : selector(controller.store.getSnapshot()));
			const t = ctx.locale.bind(NS_LOCALE);
			const injected = () => ({ controller, useSnapshot, t });
			ctx.effect(() => {
				const disposers = [
					ctx.remote.$on("settings/document-updated", (ns) => {
						if (ns !== NS) return;
						controller.load();
					}),
					ctx.on("connection/reset", () => controller.load())
				];
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "provider-headers: pushed invalidations");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "provider-headers",
				order: 30,
				label: () => t("nav"),
				locale: NS_LOCALE,
				inject: injected
			}, HeadersSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});