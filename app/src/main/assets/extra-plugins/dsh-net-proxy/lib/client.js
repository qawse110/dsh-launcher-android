// dsh-net-proxy — 浏览器 client-plugin（./client）
// 网络代理设置页：直连 dsh 同源路由 /_dsh/net-proxy，样式对齐 dsh-vision-toolkit（用 @deepseek-ai/dsh-client-ui-primitives）。
window.__ModuleLoader__.load({
	id: "dsh-net-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var Prm = require("@deepseek-ai/dsh-client-ui-primitives");
		var Button = Prm.Button;
		var Input = Prm.Input;

		var css =
			[".npx-root{}",
			".npx-header{padding:2px 0 4px}",
			".npx-kicker{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-brand-primary,#4f8cff);font-weight:600}",
			".npx-title{font-size:18px;font-weight:650;margin:2px 0 4px;color:var(--dsw-alias-label-primary)}",
			".npx-intro{font-size:12.5px;color:var(--dsw-alias-label-tertiary);margin:0 0 14px;line-height:1.6}",
			".npx-panel{display:flex;flex-direction:column;gap:14px;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-2,#1a1e26)}",
			".npx-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px}",
			".npx-panel-head h3{font-size:13px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}",
			".npx-badge{white-space:nowrap;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:500;background:var(--dsw-alias-bg-module-platform,#232733);color:var(--dsw-alias-label-secondary)}",
			".npx-badge.ok{color:var(--dsw-alias-label-success,#2ecc71)}",
			".npx-badge.warn{color:var(--dsw-alias-label-warning,#f1c40f)}",
			".npx-switch{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}",
			".npx-switch input{accent-color:var(--dsw-alias-brand-primary,#4f8cff);width:16px;height:16px;cursor:pointer}",
			".npx-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
			".npx-field{display:flex;flex-direction:column;gap:6px}",
			".npx-field:has(> textarea){grid-column:1/-1}",
			".npx-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}",
			".npx-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
			".npx-full{grid-column:1/-1}",
			".npx-alert{border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.5}",
			".npx-alert.ok{background:rgba(46,204,113,.12);color:var(--dsw-alias-label-success)}",
			".npx-alert.err{background:rgba(231,76,60,.12);color:var(--dsw-alias-label-danger,#e74c3c)}",
			".npx-save{display:flex;gap:8px;align-items:center;margin-top:4px}",
			".npx-probe{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#2a2f3a);padding-top:12px}",
			".npx-probe-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12px}",
			".npx-probe-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#12151b)}",
			".npx-probe-stat b{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}",
			".npx-probe-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary)}"].join("");

		var NS = "net-proxy";
		var zh = {
			kicker: "DSH 插件",
			nav: "网络代理",
			subtitle: "让 agent 的网络请求（web 搜索 / web_fetch / 外部 API）走本机代理。改动即时生效，无需重启。",
			status: "当前状态",
			statusOn: "代理已启用",
			statusOff: "代理已关闭（直连）",
			statusLoading: "正在读取配置…",
			statusUnavailable: "无法连接管理服务",
			enable: "启用代理",
			protocol: "协议",
			host: "代理地址",
			port: "端口",
			username: "用户名（可选）",
			password: "密码（可选）",
			noProxy: "NO_PROXY",
			noProxyHint: "逗号分隔的 host；命中则直连，不经代理。默认排除本地回环。",
			save: "保存并应用",
			saved: "已保存，已生效",
			saveFailed: "保存失败，请检查输入与连接",
			reload: "重新读取",
			http: "HTTP (CONNECT 隧道)",
			socks5: "SOCKS5",
			placeholderHost: "如 127.0.0.1",
			placeholderPort: "如 7890",
			test: "测试连接",
			testing: "测试中…",
			testOk: "代理连通正常",
			testFail: "代理不可用",
			rttProxy: "代理 TCP",
			rttTotal: "总延迟(经代理)",
			httpStatus: "目标状态",
			statMs: "ms",
		};
		var en = {
			kicker: "DSH plugin",
			nav: "Network Proxy",
			subtitle: "Route the agent's network requests (web search / web_fetch / external APIs) through a local proxy. Changes apply immediately.",
			status: "Current state",
			statusOn: "Proxy enabled",
			statusOff: "Proxy off (direct)",
			statusLoading: "Loading config…",
			statusUnavailable: "Management service unreachable",
			enable: "Enable proxy",
			protocol: "Protocol",
			host: "Proxy address",
			port: "Port",
			username: "Username (optional)",
			password: "Password (optional)",
			noProxy: "NO_PROXY",
			noProxyHint: "Comma-separated hosts; matched hosts connect directly. Loopback excluded by default.",
			save: "Save & apply",
			saved: "Saved & applied",
			saveFailed: "Save failed - check input and connection",
			reload: "Reload",
			http: "HTTP (CONNECT tunnel)",
			socks5: "SOCKS5",
			placeholderHost: "e.g. 127.0.0.1",
			placeholderPort: "e.g. 7890",
			test: "Test connection",
			testing: "Testing…",
			testOk: "Proxy reachable",
			testFail: "Proxy unavailable",
			rttProxy: "Proxy TCP",
			rttTotal: "Total (via proxy)",
			httpStatus: "Target status",
			statMs: "ms",
		};

		var API = "/_dsh/net-proxy";

		function Field(props) {
			return react_jsx_runtime.jsx("label", { className: "npx-field" + (props.full ? " npx-full" : ""), children: [
				react_jsx_runtime.jsx("span", { className: "npx-field-label", children: props.label }),
				props.children,
				props.hint ? react_jsx_runtime.jsx("small", { className: "npx-field-hint", children: props.hint }) : null,
			] });
		}

		// ── 纯展示子组件（拆分自 NetProxySection 的巨型 return）──
		function Header(props) {
			return react_jsx_runtime.jsx("header", { className: "npx-header", children: [
				react_jsx_runtime.jsx("div", { className: "npx-kicker", children: props.t("kicker") }),
				react_jsx_runtime.jsx("h2", { className: "npx-title", children: props.t("nav") }),
				react_jsx_runtime.jsx("p", { className: "npx-intro", children: props.t("subtitle") }),
			] });
		}

		function StatusBadge(props) {
			return react_jsx_runtime.jsx("div", { className: "npx-panel-head", children: [
				react_jsx_runtime.jsx("h3", { children: props.t("status") }),
				react_jsx_runtime.jsx("span", { className: "npx-badge " + props.badgeCls, children: props.badgeLabel }),
			] });
		}

		function StatusToggle(props) {
			return react_jsx_runtime.jsx("div", { className: "npx-switch", children: [
				react_jsx_runtime.jsx("input", { type: "checkbox", checked: Boolean(props.enabled), onChange: props.onChange }),
				react_jsx_runtime.jsx("span", { children: props.t("enable") }),
			] });
		}

		function ProbeResult(props) {
			var t = props.t, res = props.res;
			return react_jsx_runtime.jsx("div", { className: "npx-probe", children: [
				react_jsx_runtime.jsx("div", { className: "npx-alert " + (res.ok ? "ok" : "err"), children: res.ok ? t("testOk") : (t("testFail") + (res.error ? "：" + res.error : "")) }),
				res.ok ? react_jsx_runtime.jsx("div", { className: "npx-probe-stats", children: [
					react_jsx_runtime.jsx("div", { className: "npx-probe-stat", children: [react_jsx_runtime.jsx("span", { children: t("rttProxy") }), react_jsx_runtime.jsx("b", { children: (res.connectMs >= 0 ? res.connectMs : "—") + " " + t("statMs") })] }),
					react_jsx_runtime.jsx("div", { className: "npx-probe-stat", children: [react_jsx_runtime.jsx("span", { children: t("rttTotal") }), react_jsx_runtime.jsx("b", { children: (res.totalMs >= 0 ? res.totalMs : "—") + " " + t("statMs") })] }),
					react_jsx_runtime.jsx("div", { className: "npx-probe-stat", children: [react_jsx_runtime.jsx("span", { children: t("httpStatus") }), react_jsx_runtime.jsx("b", { children: res.httpStatus })] }),
				] }) : null,
			] });
		}

		function NetProxySection(props) {
			var t = props.t;
			var [ready, setReady] = React.useState(false);
			var [unreachable, setUnreachable] = React.useState(false);
			var [applied, setApplied] = React.useState(false);
			var [saveErr, setSaveErr] = React.useState(false);
			var [enabled, setEnabled] = React.useState(false);
			var [protocol, setProtocol] = React.useState("http");
			var [host, setHost] = React.useState("127.0.0.1");
			var [port, setPort] = React.useState("7890");
			var [username, setUsername] = React.useState("");
			var [password, setPassword] = React.useState("");
			var [noProxy, setNoProxy] = React.useState("127.0.0.1,localhost,::1");
			var [probe, setProbe] = React.useState({ running: false, res: null });

			React.useEffect(function () {
				fetch(API).then(function (r) { return r.json(); }).then(function (j) {
					if (!j || !j.ok) return;
					var v = j.value || {};
					setEnabled(Boolean(v.enabled));
					setProtocol(v.protocol || "http");
					setHost(v.host || "127.0.0.1");
					setPort(v.port != null ? String(v.port) : "7890");
					setUsername(v.username || "");
					setPassword(v.password || "");
					setNoProxy((v.noProxy || []).join(","));
					setReady(true);
				}).catch(function () { setUnreachable(true); });
			}, []);

			function save() {
				setSaveErr(false); setApplied(false);
				var portNum = /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : 7890;
				var list = noProxy.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
				var body = { enabled: Boolean(enabled), protocol: protocol, host: host.trim() || "127.0.0.1", port: portNum, username: username.trim(), password: password, noProxy: list.length ? list : ["127.0.0.1", "localhost", "::1"] };
				fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
					.then(function (r) { return r.json(); })
					.then(function (j) { if (j && j.ok) { setApplied(true); setReady(true); setUnreachable(false); } else setSaveErr(true); })
					.catch(function () { setSaveErr(true); });
			}

			function reloadNow() {
				setApplied(false); setSaveErr(false);
				fetch(API).then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok) { var v = j.value || {}; setEnabled(Boolean(v.enabled)); setProtocol(v.protocol || "http"); setHost(v.host || "127.0.0.1"); setPort(v.port != null ? String(v.port) : "7890"); setUsername(v.username || ""); setPassword(v.password || ""); setNoProxy((v.noProxy || []).join(",")); setReady(true); setUnreachable(false); }
				}).catch(function () { setUnreachable(true); });
			}

			function testNow() {
				setProbe({ running: true, res: null });
				var portNum = /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : 0;
				var p = { protocol: protocol, host: host.trim() || "127.0.0.1", port: portNum || 7890, username: username.trim(), password: password, noProxy: noProxy.split(",").map(function (s) { return s.trim(); }).filter(Boolean) };
				fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "probe", proxy: p }) })
					.then(function (r) { return r.json(); })
					.then(function (j) { setProbe({ running: false, res: j || { ok: false, error: "no response" } }); })
					.catch(function () { setProbe({ running: false, res: { ok: false, error: "network error" } }); });
			}

			var statusBadge = unreachable ? [t("statusUnavailable"), "warn"] : (!ready ? [t("statusLoading"), "warn"] : [enabled ? t("statusOn") : t("statusOff"), enabled ? "ok" : "warn"]);

			return react_jsx_runtime.jsx("div", { className: "npx-root", children: [
				react_jsx_runtime.jsx(Header, { t: t }),
				react_jsx_runtime.jsx("section", { className: "npx-panel", children: [
					react_jsx_runtime.jsx(StatusBadge, { t: t, badgeCls: statusBadge[1], badgeLabel: statusBadge[0] }),
					react_jsx_runtime.jsx(StatusToggle, { t: t, enabled: enabled, onChange: function (e) { setEnabled(e.target.checked); setApplied(false); } }),
					react_jsx_runtime.jsx("div", { className: "npx-form", children: [
						react_jsx_runtime.jsx(Field, { label: t("protocol"), children: react_jsx_runtime.jsx("select", { value: protocol, onChange: function (e) { setProtocol(e.target.value); setApplied(false); }, style: { height: 32, background: "var(--dsw-alias-bg-layer-1,#12151b)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)", borderRadius: 8, padding: "0 8px", font: "inherit" }, children: [react_jsx_runtime.jsx("option", { value: "http", children: t("http") }), react_jsx_runtime.jsx("option", { value: "socks5", children: t("socks5") })] }) }),
						react_jsx_runtime.jsx(Field, { label: t("host"), children: react_jsx_runtime.jsx(Input, { value: host, placeholder: t("placeholderHost"), onChange: function (e) { setHost(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("port"), children: react_jsx_runtime.jsx(Input, { value: port, placeholder: t("placeholderPort"), onChange: function (e) { setPort(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("username"), children: react_jsx_runtime.jsx(Input, { value: username, onChange: function (e) { setUsername(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("password"), children: react_jsx_runtime.jsx(Input, { type: "password", value: password, onChange: function (e) { setPassword(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { full: true, label: t("noProxy"), hint: t("noProxyHint"), children: react_jsx_runtime.jsx(Input, { value: noProxy, onChange: function (e) { setNoProxy(e.target.value); setApplied(false); } }) }),
					] }),
					saveErr ? react_jsx_runtime.jsx("div", { className: "npx-alert err", children: t("saveFailed") }) : null,
					applied ? react_jsx_runtime.jsx("div", { className: "npx-alert ok", children: t("saved") }) : null,
					react_jsx_runtime.jsx("div", { className: "npx-save", children: [
						react_jsx_runtime.jsx(Button, { variant: "primary", disabled: unreachable, onClick: save, children: t("save") }),
						react_jsx_runtime.jsx(Button, { variant: "outline", onClick: reloadNow, children: t("reload") }),
						react_jsx_runtime.jsx(Button, { variant: "outline", disabled: probe.running || unreachable, onClick: testNow, children: probe.running ? t("testing") : t("test") }),
					] }),
					probe.res ? react_jsx_runtime.jsx(ProbeResult, { t: t, res: probe.res }) : null,
				] }),
			] });
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
			if (typeof document !== "undefined") {
				try {
					var tagId = "dsh-net-proxy/styles.css";
					if (!document.getElementById(tagId)) {
						var st = document.createElement("style");
						st.id = tagId;
						st.setAttribute("data-plugin-css", "");
						st.textContent = css;
						(document.head || document.documentElement).appendChild(st);
					}
				} catch (e) {}
			}
			var t = ctx.locale.bind(NS);
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-proxy: section dictionaries");
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "net-proxy",
					order: 40,
					label: function () { return t("nav"); },
					locale: NS,
					inject: function () { return { t: t }; },
				}, NetProxySection);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
