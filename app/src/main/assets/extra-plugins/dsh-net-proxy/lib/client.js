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
			".npx-probe-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".npx-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2f3a);margin-bottom:14px}",
			".npx-tab{appearance:none;border:none;background:none;cursor:pointer;font:inherit;font-size:13px;padding:8px 14px;color:var(--dsw-alias-label-tertiary);border-bottom:2px solid transparent;margin-bottom:-1px}",
			".npx-tab.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#4f8cff)}",
			".npx-log-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;font-size:12px}",
			".npx-log-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#12151b)}",
			".npx-log-stat b{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}",
			".npx-log-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".npx-log-head{display:flex;align-items:center;justify-content:space-between;gap:10px}",
			".npx-log-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
			".npx-log-list{display:flex;flex-direction:column;gap:4px}",
			".npx-log-more{display:flex;justify-content:center;padding:2px 0 4px}",
			// ── 日志列表（v0.7.9）：配色全部回归宿主主题变量，结构只留层次 ──
			".npx-log-item{position:relative;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:9px;padding:7px 12px 7px 14px;background:var(--dsw-alias-bg-layer-1,#12151b);cursor:pointer;transition:border-color .14s,background .14s;overflow:hidden}",
			".npx-log-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--edge,var(--dsw-alias-border-l2,#3a4354));transition:width .14s}",
			".npx-log-item:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-bg-layer-2,#161a23)}",
			".npx-log-item:hover::before{width:5px}",
			".npx-log-item.sel{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-bg-layer-2,#161a23)}",
			".npx-log-item.ok{--edge:var(--dsw-alias-label-success,#2ecc71)}.npx-log-item.err{--edge:var(--dsw-alias-label-danger,#e74c3c)}.npx-log-item.live{--edge:var(--dsw-alias-label-tertiary,#8b93a3)}",
			".npx-log-line{display:flex;gap:9px;align-items:center;font-size:12px;flex-wrap:nowrap;min-width:0}",
			".npx-log-m{flex:none;font-size:10.5px;font-weight:700;letter-spacing:.5px;color:var(--dsw-alias-label-secondary,#9fb0c8);background:var(--dsw-alias-bg-layer-2,#1a1e26);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:5px;padding:1px 7px;white-space:nowrap}",
			".npx-log-u{color:var(--dsw-alias-label-primary,#e2eaf5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;font-size:12.5px}",
			".npx-log-b{color:var(--dsw-alias-label-tertiary,#7d8aa0);white-space:nowrap;font-size:11px;font-variant-numeric:tabular-nums}",
			".npx-log-s{flex:none;min-width:34px;text-align:right;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}",
			".npx-log-s.ok{color:var(--dsw-alias-label-success,#2ecc71)}.npx-log-s.err{color:var(--dsw-alias-label-danger,#e74c3c)}",
			// 一次点击的轻量展开：关键元信息一行，不用弹窗
			".npx-log-quick{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:7px 2px 2px;margin-top:6px;border-top:1px dashed var(--dsw-alias-border-l2,#2a2f3a);font-size:11px;color:var(--dsw-alias-label-tertiary,#93a2ba)}",
			".npx-log-quick b{color:var(--dsw-alias-label-primary,#c4d1e4);font-weight:600}",
			".npx-log-detail-btn{margin-left:auto;appearance:none;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);background:transparent;color:var(--dsw-alias-brand-primary,#4f8cff);border-radius:7px;padding:3px 12px;font-size:11px;cursor:pointer;transition:background .14s,border-color .14s;white-space:nowrap;font:inherit;font-size:11px}",
			".npx-log-detail-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-bg-layer-2,#1a1e26)}",
			".npx-log-e{color:var(--dsw-alias-label-danger,#e74c3c);font-size:11px;margin-top:4px;word-break:break-all}",
			// ── 日志详情弹窗（v0.7.9）：配色回归主题变量，结构只留层次 ──
			".npx-modal-mask{position:fixed;inset:0;background:rgba(8,10,14,.62);backdrop-filter:blur(3px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;animation:npxFadeIn .16s ease}",
			"@keyframes npxFadeIn{from{opacity:0}to{opacity:1}}",
			"@keyframes npxSlideUp{from{transform:translateY(12px) scale(.985);opacity:.5}to{transform:translateY(0) scale(1);opacity:1}}",
			".npx-modal{position:relative;width:min(880px,96vw);max-height:88vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,#39414f);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#141821);box-shadow:0 18px 60px rgba(0,0,0,.5);animation:npxSlideUp .2s cubic-bezier(.22,1,.36,1);overflow:hidden}",
			".npx-modal-head{display:flex;align-items:center;gap:12px;padding:14px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2f3a);flex:none}",
			".npx-modal-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eef7);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,'Cascadia Code',Consolas,monospace}",
			".npx-modal-close{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);background:transparent;color:var(--dsw-alias-label-secondary,#93a2ba);border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:13px;line-height:1;transition:all .14s}",
			".npx-modal-close:hover{border-color:var(--dsw-alias-label-danger,#e74c3c);color:var(--dsw-alias-label-danger,#e74c3c)}",
			".npx-modal-meta{display:flex;gap:7px;flex-wrap:wrap;padding:12px 20px 0;flex:none}",
			".npx-modal-meta .npx-chip{font-size:11px;padding:3px 10px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);color:var(--dsw-alias-label-secondary,#aab6c9);background:var(--dsw-alias-bg-layer-2,#1a1e26);white-space:nowrap;font-variant-numeric:tabular-nums}",
			".npx-modal-meta .npx-chip.ok{color:var(--dsw-alias-label-success,#2ecc71);border-color:var(--dsw-alias-label-success,#2ecc71);font-weight:600}",
			".npx-modal-meta .npx-chip.err{color:var(--dsw-alias-label-danger,#e74c3c);border-color:var(--dsw-alias-label-danger,#e74c3c);font-weight:600}",
			".npx-modal-body{flex:1;overflow-y:auto;padding:14px 20px 20px;display:flex;flex-direction:column;gap:16px;min-height:0}",
			".npx-modal-body::-webkit-scrollbar{width:8px}.npx-modal-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1,#39414f);border-radius:4px}",
			".npx-modal-sec-h{display:flex;align-items:center;gap:9px;font-size:11.5px;font-weight:700;letter-spacing:.6px;margin:2px 0 7px;text-transform:uppercase}",
			".npx-modal-sec-h::before{content:'';width:3px;height:13px;border-radius:2px}",
			".npx-modal-sec-h::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-l2,#2a2f3a)}",
			".npx-modal-sec-h.req{color:var(--dsw-alias-brand-primary,#4f8cff)}.npx-modal-sec-h.req::before{background:var(--dsw-alias-brand-primary,#4f8cff)}",
			".npx-modal-sec-h.res{color:var(--dsw-alias-label-success,#2ecc71)}.npx-modal-sec-h.res::before{background:var(--dsw-alias-label-success,#2ecc71)}",
			".npx-json-pre{margin:8px 0 0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#1a1e26);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,#dbe2ee);white-space:pre-wrap;word-break:break-all}",
			".npx-log-filter{display:flex;gap:8px;align-items:center}",
			".npx-log-filter input{flex:1;height:30px;background:var(--dsw-alias-bg-layer-1,#12151b);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:8px;padding:0 10px;font:inherit;font-size:12px}",
			".npx-log-filter input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}",
			".npx-bodywrap{display:flex;flex-direction:column;gap:6px;min-width:0}",
			".npx-json{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-primary,#dbe2ee);padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1a1e26);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);user-select:text}",
			".npx-json .jkey{color:var(--dsw-alias-brand-primary,#4f8cff);font-weight:600}",
			".npx-json .jstr{color:var(--dsw-alias-label-success,#2ecc71)}",
			".npx-json .jstr-long{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}",
			".npx-json .jnum{color:var(--dsw-alias-label-warning,#f1c40f)}",
			".npx-json .jbool,.npx-json .jnull{color:var(--dsw-alias-label-secondary,#aab2c0);font-weight:600}",
			".npx-json .jdim{color:var(--dsw-alias-label-tertiary,#8b93a3)}",
			".npx-json .jbracket{color:var(--dsw-alias-label-tertiary,#8b93a3)}",
			".npx-json-row{display:flex;align-items:flex-start;min-width:0}",
			".npx-json-row:hover{background:rgba(255,255,255,.03);border-radius:4px}",
			".npx-json-indent{flex:none;display:inline-block;white-space:pre}",
			".npx-json-key{flex:none;padding-right:2px;white-space:nowrap}",
			".npx-json-key .jcollapse{display:inline-block;width:14px;text-align:center;cursor:pointer;user-select:none}",
			".npx-json-key .jcollapse:hover{color:var(--dsw-alias-label-primary)}",
			".npx-json-val{min-width:0;flex:1 1 auto;word-break:break-all}",
			".npx-json-val .jstr-long{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}",
			".npx-json-val .jstr-long:hover{color:var(--dsw-alias-label-primary)}",
			".npx-json-kids{margin-left:2px}",
			".npx-json .jcollapse{font-size:10px}",
			".npx-log-empty{padding:24px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".npx-chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
			".npx-chart-card{position:relative;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:12px;padding:11px 12px 10px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1,#141821) 0%,var(--dsw-alias-bg-layer-2,#1a1e26) 100%);min-width:0;overflow:hidden;transition:border-color .18s,box-shadow .18s}",
			".npx-chart-card:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);box-shadow:0 0 0 1px rgba(79,140,255,.25),0 6px 18px rgba(0,0,0,.25)}",
			".npx-chart-card::before{content:'';position:absolute;inset:0 0 auto 0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.14),transparent);pointer-events:none}",
			".npx-chart-card.wide{grid-column:1/-1}",
			".npx-chart-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 10px}",
			".npx-chart-title::before{content:'';width:3px;height:12px;border-radius:2px;background:linear-gradient(180deg,var(--dsw-alias-brand-primary,#4f8cff),rgba(79,140,255,.25))}",
			".npx-chart-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:400;margin-left:auto;font-variant-numeric:tabular-nums}",
			".npx-svg{width:100%;height:auto;display:block}",
			".npx-svg rect.bar{transition:filter .15s}",
			".npx-svg rect.bar:hover{filter:brightness(1.3)}",
			".npx-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}",
			".npx-stat{position:relative;display:flex;flex-direction:column;gap:2px;padding:10px 12px 9px;border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:12px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1,#141821) 0%,var(--dsw-alias-bg-layer-2,#1a1e26) 100%);overflow:hidden}",
			".npx-stat::after{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--sc,#4f8cff);opacity:.9}",
			".npx-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}",
			".npx-stat-value{font-size:18px;font-weight:650;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;line-height:1.15}",
			".npx-stat-value.err{color:var(--dsw-alias-label-danger,#e74c3c)}",
			".npx-stat-value.ok{color:var(--dsw-alias-label-success,#2ecc71)}",
			".npx-hbar-row{display:grid;grid-template-columns:minmax(90px,160px) 1fr auto;gap:10px;align-items:center;font-size:11.5px;padding:3px 6px;border-radius:7px;transition:background .15s}",
			".npx-hbar-row:hover{background:rgba(255,255,255,.04)}",
			".npx-hbar-name{color:var(--dsw-alias-label-primary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}",
			".npx-hbar-track{height:9px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#1a1e26);box-shadow:inset 0 1px 3px rgba(0,0,0,.45);overflow:hidden;display:block}",
			".npx-hbar-fill{height:100%;border-radius:5px;display:block;position:relative;transition:width .5s cubic-bezier(.22,1,.36,1)}",
			".npx-hbar-fill::after{content:'';position:absolute;inset:0 0 auto 0;height:45%;border-radius:5px 5px 40% 40%;background:linear-gradient(180deg,rgba(255,255,255,.35),transparent);pointer-events:none}",
			".npx-hbar-val{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}",
			".npx-stack{display:flex;gap:2px;height:18px;border-radius:6px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.45)}",
			".npx-stack-seg{height:100%;min-width:3px;position:relative;transition:filter .15s}",
			".npx-stack-seg:hover{filter:brightness(1.3)}",
			".npx-stack-seg::after{content:'';position:absolute;inset:0 0 auto 0;height:46%;background:linear-gradient(180deg,rgba(255,255,255,.28),transparent)}",
			".npx-legend{display:flex;flex-wrap:wrap;gap:5px 16px;margin-top:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".npx-legend .npx-dot{box-shadow:0 0 6px currentColor}",
			".npx-dot{display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:5px}",
			".npx-chart-empty{border:1px dashed var(--dsw-alias-border-l2,#2a2f3a);border-radius:10px;padding:22px;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}"].join("");

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
			follow: "跟随系统代理",
			followHintShort: "开启后自动跟随系统代理的端口变化（3 秒内生效）；系统关闭时按下方手填地址转发。",
			sysOk: "系统代理已启用",
			sysOff: "系统代理未开启，按下方手填地址转发",
			sysPac: "系统为 PAC 模式，暂不支持跟随（沿用手动配置）",
			sysUnavailable: "无法读取系统代理设置（沿用手动配置）",
			followManualNote: "下方地址/端口仅作兜底，跟随中不会自动改变。",
			followEffective: "（跟随系统）：",
			followInactive: "（跟随系统）：",
			harnessUnverified: "web_fetch 未经代理（harness 层路由自检未通过）",
			harnessSocks: "web_fetch 未经代理（SOCKS5 不适用 harness 层，改用 HTTP 协议可覆盖）",
			harnessUnavailable: "web_fetch 未经代理（harness 代理层不可用）",
			harnessError: "web_fetch 未经代理（安装失败）",
			protocol: "协议",
			host: "代理地址",
			port: "端口",
			username: "用户名（可选）",
			password: "密码（可选）",
			noProxy: "NO_PROXY",
			noProxyHint: "逗号分隔的 host；命中则直连，不经代理。默认排除本地回环。",
			save: "保存（地址/端口等输入项）",
			saved: "已保存，已生效",
			saveFailed: "保存失败，请检查输入与连接",
			switchFailed: "开关应用失败，已还原",
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
			tabProxy: "代理设置",
			tabLog: "请求日志",
			logTitle: "请求日志",
			logHint: "内存记录，永不落盘；记录经本插件代理的所有请求（agent fetch 与 web_fetch 的 CONNECT 隧道）。TLS 隧道内容加密，仅记录目标与流量字节数。最多保留 500 条。",
			logTotal: "总请求",
			logUp: "上行流量",
			logDown: "下行流量",
			logErrors: "错误",
			logClear: "清空日志",
			logMore: "显示更早日志",
			logFilterPh: "过滤：输入 URL / 主机 / 方法关键词",
			logFilterNone: "没有匹配的记录",
			logSideReq: "请求",
			logSideRes: "响应",
			logDetailTitle: "日志详情",
			logDetailClose: "关闭",
			logDetailBtn: "详情",
			hostShort: "主机",
			channelShort: "通道",
			msShort: "耗时",
			logFullReq: "查看全部请求内容",
			logFullRes: "查看全部响应内容",
			logFullLoading: "加载中…",
			logFullTooLarge: "内容超过 256KB，未保留完整内容",
			logFullBinary: "二进制内容，未保留",
			logFullEvicted: "完整内容已因总池上限被挤出",
			logFullGone: "该条日志已被淘汰，完整内容不再可用",
			logFullNone: "未保留完整内容",
			logEmpty: "暂无记录。启用代理后，经插件转发的请求会出现在这里。",
			logRelay: "本地中继",
			logRelayOff: "未运行（停用时无 web_fetch 记录）",
			tabCharts: "流量图表",
			chartTitle: "流量图表",
			chartHint: "基于内存日志实时聚合，每 5 秒刷新；仅统计环形缓冲内的记录（最多 500 条），清空日志后图表归零。",
			chartEmpty: "暂无数据。启用代理后，经过插件的请求会在这里生成图表。",
			chartTimeline: "请求时间线",
			chartBucket: "每桶",
			chartStatus: "状态分布",
			chartLatency: "耗时分布",
			chartChannel: "通道分布",
			chartTopHosts: "目标主机 TOP 10",
			chartLatencySub: "仅统计已完成请求",
			ch2: "2xx 成功",
			ch3: "3xx 重定向",
			ch4: "4xx 客户端错误",
			ch5: "5xx 服务端错误",
			chErr: "连接错误",
			chLive: "进行中",
			chOther: "无状态",
			chFetch: "agent fetch",
			chTunnel: "CONNECT 隧道",
			chPlain: "relay 明文 HTTP",
			chartAvg: "平均",
			chartP50: "中位",
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
			follow: "Follow system proxy",
			followHintShort: "Automatically follows the system proxy's port changes (within 3s); when off, forwards via the manual address below.",
			sysOk: "System proxy is on",
			sysOff: "System proxy is off, forwarding via the manual address below",
			sysPac: "System uses PAC; following unavailable (manual config kept)",
			sysUnavailable: "Cannot read system proxy settings (manual config kept)",
			followManualNote: "Address/port below are fallback only and won't change while following.",
			followEffective: "(following system): ",
			followInactive: "(following system): ",
			harnessUnverified: "web_fetch is not proxied (harness route self-check failed)",
			harnessSocks: "web_fetch is not proxied (SOCKS5 unsupported by the harness layer; switch to HTTP to cover it)",
			harnessUnavailable: "web_fetch is not proxied (harness proxy layer unavailable)",
			harnessError: "web_fetch is not proxied (install failed)",
			protocol: "Protocol",
			host: "Proxy address",
			port: "Port",
			username: "Username (optional)",
			password: "Password (optional)",
			noProxy: "NO_PROXY",
			noProxyHint: "Comma-separated hosts; matched hosts connect directly. Loopback excluded by default.",
			save: "Save (address/port fields)",
			saved: "Saved & applied",
			saveFailed: "Save failed - check input and connection",
			switchFailed: "Failed to apply switch, reverted",
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
			tabProxy: "Proxy",
			tabLog: "Request log",
			logTitle: "Request log",
			logHint: "In-memory only, never written to disk. Records every request through this plugin (agent fetch and web_fetch CONNECT tunnels). TLS tunnel contents are encrypted; only the target and byte counts are recorded. Last 500 entries kept.",
			logTotal: "Requests",
			logUp: "Sent",
			logDown: "Received",
			logErrors: "Errors",
			logClear: "Clear log",
			logMore: "Show older entries",
			logFilterPh: "Filter by URL / host / method",
			logFilterNone: "No matching entries",
			logSideReq: "Request",
			logSideRes: "Response",
			logDetailTitle: "Log detail",
			logDetailClose: "Close",
			logDetailBtn: "Detail",
			hostShort: "Host",
			channelShort: "Channel",
			msShort: "Time",
			logFullReq: "View full request body",
			logFullRes: "View full response body",
			logFullLoading: "Loading…",
			logFullTooLarge: "Body exceeds 256KB; full content not kept",
			logFullBinary: "Binary content; not kept",
			logFullEvicted: "Full content evicted by the pool limit",
			logFullGone: "Entry evicted; full content no longer available",
			logFullNone: "Full content not kept",
			logEmpty: "No entries yet. Requests forwarded through the plugin appear here once the proxy is enabled.",
			logRelay: "Local relay",
			logRelayOff: "not running (no web_fetch entries while off)",
			tabCharts: "Charts",
			chartTitle: "Traffic charts",
			chartHint: "Aggregated live from the in-memory log, refreshed every 5s; covers the ring buffer only (last 500 entries) and resets when the log is cleared.",
			chartEmpty: "No data yet. Charts appear once requests go through the proxy.",
			chartTimeline: "Request timeline",
			chartBucket: "per bucket",
			chartStatus: "Status distribution",
			chartLatency: "Latency distribution",
			chartChannel: "Channels",
			chartTopHosts: "Top 10 hosts",
			chartLatencySub: "finished requests only",
			ch2: "2xx OK",
			ch3: "3xx redirect",
			ch4: "4xx client error",
			ch5: "5xx server error",
			chErr: "Connection error",
			chLive: "In flight",
			chOther: "No status",
			chFetch: "agent fetch",
			chTunnel: "CONNECT tunnel",
			chPlain: "relay plain HTTP",
			chartAvg: "avg",
			chartP50: "p50",
		};

		var API = "/_dsh/net-proxy";
		var LOG_API = "/_dsh/net-proxy/log";

		function fmtBytes(n) {
			n = Number(n) || 0;
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
			if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
			return (n / 1073741824).toFixed(2) + " GB";
		}

		function fmtTime(ts) {
			try {
				var d = new Date(ts);
				var p = function (x) { return (x < 10 ? "0" : "") + x; };
				return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
			} catch (e) { return ""; }
		}

		function fmtBucketMs(ms) {
			if (ms < 60000) return Math.round(ms / 1000) + "s";
			return Math.round(ms / 60000) + "min";
		}

		// ── 图表聚合（纯函数，exports.charts 供单测；输入为 /log 的 entries，新在前）──
		var charts = {};

		/** 时间线分桶：最近 n 个桶覆盖 [最早记录, now]，错误请求（error 或状态≥400）单独计数。 */
		charts.timeline = function (entries, now, n) {
			n = n || 30;
			var nowTs = Number(now) || Date.now();
			var minTs = Infinity;
			var maxTs = 0;
			for (var i = 0; i < entries.length; i++) {
				var ts = Number(entries[i] && entries[i].ts);
				if (!Number.isFinite(ts)) continue;
				if (ts < minTs) minTs = ts;
				if (ts > maxTs) maxTs = ts;
			}
			if (!Number.isFinite(minTs)) return { bucketMs: 60000, start: nowTs - 60000, buckets: [] };
			var right = Math.max(maxTs, nowTs);
			var span = Math.max(right - minTs, n * 1000);
			var bucketMs = Math.max(1000, Math.ceil(span / n / 1000) * 1000);
			var start = Math.floor(minTs / bucketMs) * bucketMs;
			var nb = Math.max(1, Math.ceil((right + 1 - start) / bucketMs));
			var buckets = [];
			for (i = 0; i < nb; i++) buckets.push({ start: start + i * bucketMs, total: 0, errors: 0 });
			for (i = 0; i < entries.length; i++) {
				var e = entries[i];
				var t0 = Number(e && e.ts);
				if (!Number.isFinite(t0)) continue;
				var bi = Math.floor((t0 - start) / bucketMs);
				if (bi < 0 || bi >= nb) continue;
				buckets[bi].total += 1;
				if (e.error || (e.status != null && Number(e.status) >= 400)) buckets[bi].errors += 1;
			}
			return { bucketMs: bucketMs, start: start, buckets: buckets };
		};

		/** 目标主机聚合：按请求数降序取前 n，附带上下行字节与错误数。 */
		charts.topHosts = function (entries, n) {
			var map = {};
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i] || {};
				var h = e.host || "unknown";
				if (!map[h]) map[h] = { host: h, count: 0, upBytes: 0, downBytes: 0, errors: 0 };
				var m = map[h];
				m.count += 1;
				m.upBytes += Number(e.upBytes) || 0;
				m.downBytes += Number(e.downBytes) || 0;
				if (e.error || (e.status != null && Number(e.status) >= 400)) m.errors += 1;
			}
			var arr = Object.keys(map).map(function (k) { return map[k]; });
			arr.sort(function (a, b) { return b.count - a.count || b.downBytes - a.downBytes; });
			return arr.slice(0, n || 8);
		};

		/** 状态分布：2xx/3xx/4xx/5xx/连接错误/进行中/无状态，互不重叠。 */
		charts.statusDist = function (entries) {
			var d = { s2: 0, s3: 0, s4: 0, s5: 0, err: 0, live: 0, other: 0, total: 0 };
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i] || {};
				if (e.live) { d.live += 1; d.total += 1; continue; }
				if (e.error) { d.err += 1; d.total += 1; continue; }
				var s = Number(e.status);
				if (!Number.isFinite(s) || s <= 0) { d.other += 1; d.total += 1; continue; }
				if (s < 300) d.s2 += 1;
				else if (s < 400) d.s3 += 1;
				else if (s < 500) d.s4 += 1;
				else d.s5 += 1;
				d.total += 1;
			}
			return d;
		};

		/** 耗时分布：[0,100) [100,300) [300,1000) [1000,3000) [3000,∞) 五桶 + 平均/中位（毫秒）。 */
		charts.latency = function (entries) {
			var edges = [100, 300, 1000, 3000];
			var counts = [0, 0, 0, 0, 0];
			var mss = [];
			for (var i = 0; i < entries.length; i++) {
				var raw = entries[i] && entries[i].ms;
				if (raw == null) continue; // Number(null) === 0，须先排除再转数字
				var ms = Number(raw);
				if (!Number.isFinite(ms) || ms < 0) continue;
				mss.push(ms);
				var b = 0;
				while (b < edges.length && ms >= edges[b]) b += 1;
				counts[b] += 1;
			}
			mss.sort(function (a, b2) { return a - b2; });
			var sum = 0;
			for (i = 0; i < mss.length; i++) sum += mss[i];
			return {
				counts: counts,
				total: mss.length,
				avgMs: mss.length ? Math.round(sum / mss.length) : null,
				p50Ms: mss.length ? Math.round(mss[Math.floor(mss.length / 2)]) : null,
			};
		};

		/** 通道分布：fetch（agent fetch 包装层）/ tunnel（CONNECT 隧道）/ plain（relay 明文 http）。 */
		charts.channels = function (entries) {
			var order = ["fetch", "tunnel", "plain"];
			var d = { fetch: 0, tunnel: 0, plain: 0 };
			var up = { fetch: 0, tunnel: 0, plain: 0 };
			var down = { fetch: 0, tunnel: 0, plain: 0 };
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i] || {};
				var k = e.kind === "relay-tunnel" ? "tunnel" : e.kind === "relay-http" ? "plain" : "fetch";
				d[k] += 1;
				up[k] += Number(e.upBytes) || 0;
				down[k] += Number(e.downBytes) || 0;
			}
			return order.map(function (k) { return { key: k, count: d[k], upBytes: up[k], downBytes: down[k] }; });
		};

		function LogStat(props) {
			return react_jsx_runtime.jsx("div", { className: "npx-log-stat", children: [
				react_jsx_runtime.jsx("b", { children: props.value }),
				react_jsx_runtime.jsx("span", { children: props.label }),
			] });
		}

		/** 图表页统计卡：左缘彩色竖条 + 大号数字。 */
		function StatCard(props) {
			return react_jsx_runtime.jsxs("div", { className: "npx-stat", style: { "--sc": props.color }, children: [
				react_jsx_runtime.jsx("span", { className: "npx-stat-label", children: props.label }),
				react_jsx_runtime.jsx("b", { className: "npx-stat-value" + (props.cls ? " " + props.cls : ""), children: props.value }),
			] });
		}

		/** JSON 标量着色（React 元素，天然免 XSS）。长字符串（URL/长文本）单行省略号，点击展开。 */
		function JsonScalar(props) {
			// Hook 必须无条件调用：条件分支里调 useState 会让长字符串跨越 120 阈值时
			// Hook 数量变化 → 渲染抛错 → 整个设置页白屏。
			var clipState = React.useState(false);
			var clip = clipState[0], setClip = clipState[1];
			var v = props.value;
			if (v === null || v === undefined) return react_jsx_runtime.jsx("span", { className: "jnull", children: "null" });
			var ty = typeof v;
			if (ty === "string") {
				var s = JSON.stringify(v);
				if (s.length > 120) {
					return clip
						? react_jsx_runtime.jsx("span", { className: "jstr", style: { wordBreak: "break-all" }, onClick: function () { setClip(false); }, children: s })
						: react_jsx_runtime.jsx("span", { className: "jstr jstr-long", title: s, onClick: function () { setClip(true); }, children: s });
				}
				return react_jsx_runtime.jsx("span", { className: "jstr", children: s });
			}
			if (ty === "number") return react_jsx_runtime.jsx("span", { className: "jnum", children: String(v) });
			if (ty === "boolean") return react_jsx_runtime.jsx("span", { className: "jbool", children: String(v) });
			return react_jsx_runtime.jsx("span", { className: "jdim", children: String(v) });
		}

		/**
		 * JSON 折叠树 v2（行式布局）：每行 [缩进][折叠钮+键:][值]，键列左对齐，
		 * 逗号挂行尾；默认展开前 3 层；长字符串点击展开全文。React 元素递归，无 innerHTML。
		 */
		function JsonView(props) {
			var v = props.value;
			var depth = props.depth || 0;
			var openState = React.useState(depth < 3);
			var open = openState[0], setOpen = openState[1];
			if (v === null || v === undefined || typeof v !== "object") return react_jsx_runtime.jsx(JsonScalar, { value: v });
			var isArr = Array.isArray(v);
			var keys = isArr ? v.map(function (_, i) { return i; }) : Object.keys(v);
			var bOpen = isArr ? "[" : "{", bClose = isArr ? "]" : "}";
			if (!keys.length) return react_jsx_runtime.jsx("span", { className: "jdim", children: isArr ? "[]" : "{}" });
			var collapse = function (e) { e.stopPropagation(); setOpen(!open); };
			var kids = function () {
				return react_jsx_runtime.jsx("div", { className: "npx-json-kids", children: keys.map(function (k) {
					return react_jsx_runtime.jsxs("div", { className: "npx-json-row", children: [
						react_jsx_runtime.jsx("span", { className: "npx-json-indent", style: { width: depth * 14 + 16 }, children: "" }),
						isArr ? null : react_jsx_runtime.jsxs("span", { className: "npx-json-key", children: [
							react_jsx_runtime.jsx("span", { className: "jkey", children: JSON.stringify(k) }),
							react_jsx_runtime.jsx("span", { className: "jdim", children: ": " }),
						] }),
						react_jsx_runtime.jsxs("span", { className: "npx-json-val", children: [
							react_jsx_runtime.jsx(JsonView, { value: v[k], depth: depth + 1 }),
							react_jsx_runtime.jsx("span", { className: "jdim", children: "," }),
						] }),
					] }, isArr ? k : k + "#" + depth);
				}) });
			};
			if (!open) {
				return react_jsx_runtime.jsxs("span", { style: { whiteSpace: "nowrap" }, children: [
					react_jsx_runtime.jsxs("span", { className: "jcollapse jdim", onClick: collapse, children: ["▸", bOpen] }),
					react_jsx_runtime.jsx("span", { className: "jdim", onClick: collapse, children: keys.length + (isArr ? " 项" : " 键") + "…" + bClose }),
				] });
			}
			return react_jsx_runtime.jsxs("div", { style: { minWidth: 0 }, children: [
				react_jsx_runtime.jsxs("div", { className: "npx-json-row", children: [
					react_jsx_runtime.jsx("span", { className: "npx-json-indent", style: { width: depth * 14 + 2 }, children: "" }),
					react_jsx_runtime.jsx("span", { className: "jcollapse jbracket", onClick: collapse, children: "▾" }),
					react_jsx_runtime.jsx("span", { className: "jbracket", children: bOpen }),
				] }),
				kids(),
				react_jsx_runtime.jsxs("div", { className: "npx-json-row", children: [
					react_jsx_runtime.jsx("span", { className: "npx-json-indent", style: { width: depth * 14 + 2 }, children: "" }),
					react_jsx_runtime.jsx("span", { className: "jbracket", children: bClose }),
				] }),
			] });
		}

		/** 单侧请求/响应体：预览（JSON 可解析则树渲染）+「查看全部内容」（拉完整内容池）。 */
		function BodyView(props) {
			var t = props.t, id = props.id, side = props.side;
			var text = props.text;
			var [full, setFull] = React.useState(null); // null=未加载；{state, body}
			var [loading, setLoading] = React.useState(false);
			var loadFull = function () {
				setLoading(true);
				fetch(LOG_API + "?full=" + id + "&side=" + side).then(function (r) { return r.json(); }).then(function (j) {
					setFull(j && j.ok && j.full ? j.full : { state: "gone" });
					setLoading(false);
				}).catch(function () { setFull({ state: "gone" }); setLoading(false); });
			};
			var show = full && full.body != null ? full.body : text;
			var parsed;
			try { parsed = JSON.parse(show); } catch (e) { parsed = undefined; }
			var stateHint = null;
			if (full && full.state !== "ok") {
				var map = { "too-large": t("logFullTooLarge"), "binary": t("logFullBinary"), "evicted": t("logFullEvicted"), "gone": t("logFullGone"), "none": t("logFullNone") };
				stateHint = map[full.state] || t("logFullNone");
			}
			return react_jsx_runtime.jsxs("div", { className: "npx-bodywrap", children: [
				!full && props.fullState === "ok" ? react_jsx_runtime.jsx(Button, { variant: "outline", disabled: loading, onClick: loadFull, children: loading ? t("logFullLoading") : (side === "req" ? t("logFullReq") : t("logFullRes")) }) : null,
				stateHint ? react_jsx_runtime.jsx("div", { className: "npx-log-hint", children: stateHint }) : null,
				parsed !== undefined && parsed !== null && typeof parsed === "object"
					? react_jsx_runtime.jsx("div", { className: "npx-json", children: react_jsx_runtime.jsx(JsonView, { value: parsed, depth: 0 }) })
					: react_jsx_runtime.jsx("pre", { className: "npx-json-pre", children: show }),
			] });
		}

		/** 日志详情弹窗：居中卡片 + 遮罩（点击遮罩/Esc 关闭）；请求/响应分节，详情区内部滚动。 */
		function LogDetailModal(props) {
			var it = props.it;
			var t = props.t;
			var close = function () { props.onClose(); };
			React.useEffect(function () {
				var onKey = function (e) { if (e.key === "Escape") close(); };
				document.addEventListener("keydown", onKey);
				return function () { document.removeEventListener("keydown", onKey); };
			}, []);
			var stCls = it.error ? "err" : (it.status >= 400 ? "err" : "ok");
			var statusText = it.error ? ("ERR " + String(it.error).slice(0, 80)) : String(it.status || "—");
			var kindText = it.kind === "relay-tunnel" ? "CONNECT" : (it.kind || "—");
			return react_jsx_runtime.jsx("div", { className: "npx-modal-mask", onClick: close, children:
				react_jsx_runtime.jsxs("div", { className: "npx-modal", onClick: function (e) { e.stopPropagation(); }, children: [
					react_jsx_runtime.jsx("div", { className: "npx-modal-head", children: [
						react_jsx_runtime.jsx("span", { className: "npx-modal-title", title: it.url, children: (it.method || "—") + "  " + it.url }),
						react_jsx_runtime.jsx("button", { className: "npx-modal-close", onClick: close, title: t("logDetailClose"), children: "✕" }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-modal-meta", children: [
						react_jsx_runtime.jsx("span", { className: "npx-chip " + stCls, children: statusText }),
						react_jsx_runtime.jsx("span", { className: "npx-chip", children: kindText }),
						it.ms != null ? react_jsx_runtime.jsx("span", { className: "npx-chip", children: it.ms + " ms" }) : null,
						react_jsx_runtime.jsx("span", { className: "npx-chip", children: "↑" + fmtBytes(it.upBytes) + " ↓" + fmtBytes(it.downBytes) }),
						react_jsx_runtime.jsx("span", { className: "npx-chip", children: new Date(it.ts).toLocaleTimeString() }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-modal-body", children: [
						it.reqPreview || it.reqFullState === "ok" ? react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("div", { className: "npx-modal-sec-h req", children: t("logSideReq") }),
							react_jsx_runtime.jsx(BodyView, { t: t, id: it.id, side: "req", text: it.reqPreview || "", fullState: it.reqFullState }),
						] }) : null,
						it.resPreview || it.resFullState === "ok" ? react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("div", { className: "npx-modal-sec-h res", children: t("logSideRes") }),
							react_jsx_runtime.jsx(BodyView, { t: t, id: it.id, side: "res", text: it.resPreview || "", fullState: it.resFullState }),
						] }) : null,
						!it.reqPreview && !it.resPreview && it.reqFullState !== "ok" && it.resFullState !== "ok"
							? react_jsx_runtime.jsx("div", { className: "npx-log-empty", children: it.error ? String(it.error) : t("logFullNone") }) : null,
					] }),
				] }),
			});
		}

		/**
		 * 日志列表条目（v0.7.8 交互）：一次点击 = 行内轻量展开（主机/通道/耗时/错误摘要 +
		 * 「详情」按钮）；二次点「详情」= 弹窗。行内展开不打断浏览列表的视线。
		 */
		function LogItem(props) {
			var it = props.it;
			var stCls = it.error ? "err" : (it.status >= 400 ? "err" : (it.live ? "live" : "ok"));
			var statusText = it.error ? ("ERR") : (it.status || "—");
			var bytes = "↑" + fmtBytes(it.upBytes) + " ↓" + fmtBytes(it.downBytes);
			var open = props.open === it.id;
			return react_jsx_runtime.jsxs("div", { className: "npx-log-item " + stCls + (open ? " sel" : ""), onClick: function () { props.onToggle(it.id, it); }, children: [
				react_jsx_runtime.jsxs("div", { className: "npx-log-line", children: [
					react_jsx_runtime.jsx("span", { className: "npx-log-m", children: it.method || "—" }),
					react_jsx_runtime.jsx("span", { className: "npx-log-u", title: it.url, children: it.url }),
					react_jsx_runtime.jsx("span", { className: "npx-log-b", children: fmtTime(it.ts) }),
					react_jsx_runtime.jsx("span", { className: "npx-log-s " + stCls, children: statusText }),
					react_jsx_runtime.jsx("span", { className: "npx-log-b", children: bytes }),
				] }),
				open ? react_jsx_runtime.jsxs("div", { className: "npx-log-quick", onClick: function (e) { e.stopPropagation(); }, children: [
					react_jsx_runtime.jsxs("span", { children: [props.t("hostShort"), " ", react_jsx_runtime.jsx("b", { children: it.host || "—" })] }),
					react_jsx_runtime.jsxs("span", { children: [props.t("channelShort"), " ", react_jsx_runtime.jsx("b", { children: it.kind === "relay-tunnel" ? "CONNECT" : (it.kind || "—") })] }),
					it.ms != null ? react_jsx_runtime.jsxs("span", { children: [props.t("msShort"), " ", react_jsx_runtime.jsx("b", { children: it.ms + " ms" })] }) : null,
					it.error ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-danger,#e74c3c)" }, children: String(it.error).slice(0, 90) }) : null,
					react_jsx_runtime.jsx("button", { className: "npx-log-detail-btn", onClick: function (e) { e.stopPropagation(); props.onDetail(it.id, it); }, children: props.t("logDetailBtn") }),
				] }) : null,
			] });
		}

		function LogPanel(props) {
			var t = props.t;
			var [data, setData] = React.useState(null);
			var [err, setErr] = React.useState(false);
			var [openRow, setOpenRow] = React.useState(null); // 一次点击：行内轻量展开（可再点收起）
			var [detail, setDetail] = React.useState(null);   // 二次点「详情」：弹窗（快照兜底防闪没）
			var detailRef = React.useRef(null);
			// 列表不内滚（避免与宿主页面滚动叠加成双滚动条）：先取 80 条，按需加载全部
			var [limit, setLimit] = React.useState(80);
			var [filter, setFilter] = React.useState("");
			var toggleRow = function (id, it) { setOpenRow(openRow === id ? null : id); };
			var openDetail = function (id, it) { detailRef.current = it || null; setDetail(id); };
			var closeDetail = function () { detailRef.current = null; setDetail(null); };

			var load = function () {
				fetch(LOG_API + "?limit=" + limit).then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok) { setData(j); setErr(false); }
				}).catch(function () { setErr(true); });
			};
			React.useEffect(function () {
				load();
				var iv = setInterval(load, 3000);
				return function () { clearInterval(iv); };
			}, [limit]);

			function clearLog() {
				fetch(LOG_API, { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Net-Proxy": "1" }, body: JSON.stringify({ action: "clearLog" }) })
					.then(function (r) { return r.json(); })
					.then(function () { load(); })
					.catch(function () {});
			}

			if (err && !data) return react_jsx_runtime.jsx("section", { className: "npx-panel", children: react_jsx_runtime.jsx("div", { className: "npx-alert err", children: t("statusUnavailable") }) });
			var s = (data && data.summary) || { total: 0, upBytes: 0, downBytes: 0, errors: 0 };
			var entries = (data && data.entries) || [];
			var relay = data && data.relay;
			// 地址过滤：客户端侧过滤（URL/主机/方法子串，大小写不敏感），不增加服务端开销
			var kw = filter.trim().toLowerCase();
			var shown = kw ? entries.filter(function (it) {
				return (it.url && it.url.toLowerCase().indexOf(kw) !== -1)
					|| (it.host && it.host.toLowerCase().indexOf(kw) !== -1)
					|| (it.method && it.method.toLowerCase().indexOf(kw) !== -1);
			}) : entries;
			// 弹窗条目：优先用最新数据（内容随轮询刷新），被淘汰时回落到打开时的快照
			var cur = detail != null ? (entries.filter(function (x) { return x.id === detail; })[0] || detailRef.current) : null;
			return react_jsx_runtime.jsx("section", { className: "npx-panel", children: [
				react_jsx_runtime.jsx("div", { className: "npx-log-head", children: [
					react_jsx_runtime.jsx("h3", { children: t("logTitle") }),
					react_jsx_runtime.jsx("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
						relay && relay.listening && relay.port ? react_jsx_runtime.jsx("span", { className: "npx-badge", children: t("logRelay") + " :" + relay.port }) : react_jsx_runtime.jsx("span", { className: "npx-badge warn", children: t("logRelayOff") }),
						react_jsx_runtime.jsx(Button, { variant: "outline", onClick: clearLog, children: t("logClear") }),
					] }),
				] }),
				react_jsx_runtime.jsx("div", { className: "npx-log-hint", children: t("logHint") }),
				react_jsx_runtime.jsx("div", { className: "npx-log-stats", children: [
					react_jsx_runtime.jsx(LogStat, { value: s.total, label: t("logTotal") }),
					react_jsx_runtime.jsx(LogStat, { value: fmtBytes(s.upBytes), label: t("logUp") }),
					react_jsx_runtime.jsx(LogStat, { value: fmtBytes(s.downBytes), label: t("logDown") }),
					react_jsx_runtime.jsx(LogStat, { value: s.errors, label: t("logErrors") }),
				] }),
				entries.length ? react_jsx_runtime.jsxs("div", { children: [
					react_jsx_runtime.jsx("div", { className: "npx-log-filter", children: react_jsx_runtime.jsx("input", { value: filter, placeholder: t("logFilterPh"), onChange: function (e) { setFilter(e.target.value); } }) }),
					shown.length ? react_jsx_runtime.jsx("div", { className: "npx-log-list", children: shown.map(function (it) {
						return react_jsx_runtime.jsx(LogItem, { t: t, it: it, open: openRow, onToggle: toggleRow, onDetail: openDetail }, it.id);
					}) }) : react_jsx_runtime.jsx("div", { className: "npx-log-empty", children: t("logFilterNone") }),
					!kw && entries.length >= limit && limit < 500 ? react_jsx_runtime.jsx("div", { className: "npx-log-more", children: react_jsx_runtime.jsx(Button, { variant: "outline", onClick: function () { setLimit(500); }, children: t("logMore") }) }) : null,
				] }) : react_jsx_runtime.jsx("div", { className: "npx-log-empty", children: t("logEmpty") }),
				// 详情弹窗：仅由「详情」按钮触发；条目被轮询淘汰时回落快照，不闪没
				detail != null && cur ? react_jsx_runtime.jsx(LogDetailModal, { t: t, it: cur, onClose: closeDetail }) : null,
			] });
		}

		// ── 图表组件：全部自绘 SVG / HTML，不依赖任何图表库 ──

		var AX_COLOR = "var(--dsw-alias-label-tertiary,#8b93a3)";

		/** 请求时间线：渐变面积图 + 顶线 + 水平网格，错误请求在该桶顶线处标红点；透明热区提供悬浮提示。 */
		function TimelineChart(props) {
			var d = props.data;
			var W = 560, H = 132, padL = 10, padR = 10, padT = 12, padB = 16;
			var iw = W - padL - padR, ih = H - padT - padB;
			var nb = d.buckets.length;
			var max = 1;
			for (var i = 0; i < nb; i++) if (d.buckets[i].total > max) max = d.buckets[i].total;
			var step = nb > 1 ? iw / (nb - 1) : 0;
			var xAt = function (i) { return padL + i * step; };
			var yAt = function (v) { return padT + ih - (v / max) * ih; };
			var line = "";
			for (i = 0; i < nb; i++) {
				line += (i ? " L" : "M") + xAt(i).toFixed(1) + " " + yAt(d.buckets[i].total).toFixed(1);
			}
			var area = line + " L" + (padL + iw).toFixed(1) + " " + (padT + ih) + " L" + padL + " " + (padT + ih) + " Z";
			var grid = [];
			for (i = 1; i <= 3; i++) {
				var gy = padT + (ih * i) / 4;
				grid.push(react_jsx_runtime.jsx("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: "var(--dsw-alias-border-l2,#2a2f3a)", strokeDasharray: "3 4", strokeWidth: 1 }));
			}
			var dots = [];
			var hot = [];
			for (i = 0; i < nb; i++) {
				var b = d.buckets[i];
				if (b.errors) dots.push(react_jsx_runtime.jsx("circle", { cx: xAt(i), cy: yAt(b.total), r: 2.6, fill: "var(--dsw-alias-label-danger,#e74c3c)", stroke: "var(--dsw-alias-bg-layer-1,#141821)", strokeWidth: 1 }));
				hot.push(react_jsx_runtime.jsx("rect", { x: xAt(i) - step / 2, y: padT, width: Math.max(step, 6), height: ih, fill: "transparent", children: react_jsx_runtime.jsx("title", { children: fmtTime(b.start) + " · " + b.total + (b.errors ? " / ✕" + b.errors : "") }) }));
			}
			var axis = [
				react_jsx_runtime.jsx("text", { x: padL, y: H - 4, fontSize: 9, fill: AX_COLOR, children: fmtTime(d.start) }),
				react_jsx_runtime.jsx("text", { x: padL + iw, y: H - 4, fontSize: 9, textAnchor: "end", fill: AX_COLOR, children: fmtTime(d.start + (nb - 1) * d.bucketMs) }),
				react_jsx_runtime.jsx("text", { x: padL + iw, y: padT - 3, fontSize: 9, textAnchor: "end", fill: AX_COLOR, children: "max " + max }),
			];
			return react_jsx_runtime.jsxs("svg", { className: "npx-svg", viewBox: "0 0 " + W + " " + H, role: "img", children: [
				react_jsx_runtime.jsxs("defs", { children: [
					react_jsx_runtime.jsxs("linearGradient", { id: "npxg-area", x1: 0, y1: 0, x2: 0, y2: 1, children: [
						react_jsx_runtime.jsx("stop", { offset: "0%", stopColor: "var(--dsw-alias-brand-primary,#4f8cff)", stopOpacity: 0.42 }),
						react_jsx_runtime.jsx("stop", { offset: "100%", stopColor: "var(--dsw-alias-brand-primary,#4f8cff)", stopOpacity: 0 }),
					] }),
					react_jsx_runtime.jsxs("linearGradient", { id: "npxg-bar", x1: 0, y1: 0, x2: 0, y2: 1, children: [
						react_jsx_runtime.jsx("stop", { offset: "0%", stopColor: "#8fb8ff" }),
						react_jsx_runtime.jsx("stop", { offset: "100%", stopColor: "var(--dsw-alias-brand-primary,#4f8cff)" }),
					] }),
				] }),
				grid,
				react_jsx_runtime.jsx("path", { d: area, fill: "url(#npxg-area)" }),
				react_jsx_runtime.jsx("path", { d: line, fill: "none", stroke: "var(--dsw-alias-brand-primary,#4f8cff)", strokeWidth: 1.6, strokeLinejoin: "round", strokeLinecap: "round" }),
				react_jsx_runtime.jsx("line", { x1: padL, y1: padT + ih, x2: padL + iw, y2: padT + ih, stroke: "var(--dsw-alias-border-l2,#2a2f3a)", strokeWidth: 1 }),
				dots,
				axis,
				hot,
			] });
		}

		/** 耗时分布直方图：渐变圆角柱 + 顶部数值 + 悬浮热区。 */
		function LatencyChart(props) {
			var d = props.d;
			var labels = ["≤0.1s", "0.1-0.3s", "0.3-1s", "1-3s", ">3s"];
			var W = 560, H = 132, padL = 10, padR = 10, padT = 12, padB = 16;
			var iw = W - padL - padR, ih = H - padT - padB;
			var max = 1;
			for (var i = 0; i < d.counts.length; i++) if (d.counts[i] > max) max = d.counts[i];
			var bw = iw / d.counts.length;
			var bars = [], axis = [];
			for (i = 0; i < d.counts.length; i++) {
				var h = d.counts[i] ? Math.max(3, (d.counts[i] / max) * ih) : 0;
				var x = padL + i * bw + bw * 0.2;
				var w = Math.max(2, bw * 0.6);
				bars.push(react_jsx_runtime.jsxs("g", { children: [
					h ? react_jsx_runtime.jsx("rect", { className: "bar", x: x, y: padT + ih - h, width: w, height: h, rx: 3, fill: "url(#npxg-bar)" }) : null,
					h ? react_jsx_runtime.jsx("text", { x: x + w / 2, y: padT + ih - h - 4, fontSize: 9.5, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary,#aab2c0)", children: d.counts[i] }) : null,
					react_jsx_runtime.jsx("text", { x: padL + i * bw + bw / 2, y: H - 4, fontSize: 9, textAnchor: "middle", fill: AX_COLOR, children: labels[i] }),
					react_jsx_runtime.jsx("rect", { x: padL + i * bw, y: padT, width: bw, height: ih, fill: "transparent", children: react_jsx_runtime.jsx("title", { children: labels[i] + " · " + d.counts[i] }) }),
				] }));
			}
			return react_jsx_runtime.jsxs("svg", { className: "npx-svg", viewBox: "0 0 " + W + " " + H, role: "img", children: [
				react_jsx_runtime.jsx("line", { x1: padL, y1: padT + ih, x2: padL + iw, y2: padT + ih, stroke: "var(--dsw-alias-border-l2,#2a2f3a)", strokeWidth: 1 }),
				bars,
			] });
		}

		/** 状态分布：光泽堆叠条（段按占比弹性分配）+ 带百分比的图例。 */
		function StatusChart(props) {
			var d = props.d, t = props.t;
			var segs = [
				{ label: t("ch2"), color: "var(--dsw-alias-label-success,#2ecc71)", n: d.s2 },
				{ label: t("ch3"), color: "var(--dsw-alias-brand-primary,#4f8cff)", n: d.s3 },
				{ label: t("ch4"), color: "var(--dsw-alias-label-warning,#f1c40f)", n: d.s4 },
				{ label: t("ch5"), color: "#e67e22", n: d.s5 },
				{ label: t("chErr"), color: "var(--dsw-alias-label-danger,#e74c3c)", n: d.err },
				{ label: t("chLive"), color: "var(--dsw-alias-label-tertiary,#8b93a3)", n: d.live },
				{ label: t("chOther"), color: "#6b7280", n: d.other },
			].filter(function (s) { return s.n > 0; });
			var total = d.total || 1;
			return react_jsx_runtime.jsxs("div", { children: [
				react_jsx_runtime.jsx("div", { className: "npx-stack", children: segs.map(function (s) {
					return react_jsx_runtime.jsx("div", { className: "npx-stack-seg", style: { flex: s.n, background: s.color }, title: s.label + " " + s.n + " (" + Math.round((s.n / total) * 100) + "%)" });
				}) }),
				react_jsx_runtime.jsx("div", { className: "npx-legend", children: segs.map(function (s) {
					return react_jsx_runtime.jsx("span", { children: [
						react_jsx_runtime.jsx("span", { className: "npx-dot", style: { background: s.color, color: s.color } }),
						s.label + " " + s.n + " · " + Math.round((s.n / total) * 100) + "%",
					] });
				}) }),
			] });
		}

		/** 通道分布：渐变横条（fetch / CONNECT 隧道 / relay 明文），右侧条数与下行字节。 */
		function ChannelChart(props) {
			var rows = props.rows, t = props.t;
			var names = { fetch: t("chFetch"), tunnel: t("chTunnel"), plain: t("chPlain") };
			var grads = {
				fetch: "linear-gradient(90deg,var(--dsw-alias-brand-primary,#4f8cff),rgba(79,140,255,.45))",
				tunnel: "linear-gradient(90deg,#8e44ad,rgba(195,122,240,.5))",
				plain: "linear-gradient(90deg,#148f77,rgba(72,229,194,.5))",
			};
			var max = 1;
			for (var i = 0; i < rows.length; i++) if (rows[i].count > max) max = rows[i].count;
			return react_jsx_runtime.jsx("div", { children: rows.map(function (r) {
				return react_jsx_runtime.jsxs("div", { className: "npx-hbar-row", children: [
					react_jsx_runtime.jsx("span", { className: "npx-hbar-name", children: names[r.key] || r.key }),
					react_jsx_runtime.jsx("span", { className: "npx-hbar-track", children: r.count ? react_jsx_runtime.jsx("span", { className: "npx-hbar-fill", style: { width: Math.max(4, (r.count / max) * 100) + "%", background: grads[r.key] } }) : null }),
					react_jsx_runtime.jsx("span", { className: "npx-hbar-val", children: r.count + " · ↓" + fmtBytes(r.downBytes) }),
				] });
			}) });
		}

		/** 目标主机 TOP：渐变横条按占比，有错误记录的主机条为红色系。 */
		function TopHostsChart(props) {
			var rows = props.rows;
			var max = rows.length ? Math.max(rows[0].count, 1) : 1;
			var gradOk = "linear-gradient(90deg,var(--dsw-alias-brand-primary,#4f8cff),rgba(77,208,225,.55))";
			var gradErr = "linear-gradient(90deg,var(--dsw-alias-label-danger,#e74c3c),rgba(255,138,101,.55))";
			return react_jsx_runtime.jsx("div", { children: rows.map(function (r) {
				return react_jsx_runtime.jsxs("div", { className: "npx-hbar-row", children: [
					react_jsx_runtime.jsx("span", { className: "npx-hbar-name", title: r.host, children: r.host }),
					react_jsx_runtime.jsx("span", { className: "npx-hbar-track", children: react_jsx_runtime.jsx("span", { className: "npx-hbar-fill", style: { width: Math.max(4, (r.count / max) * 100) + "%", background: r.errors ? gradErr : gradOk }, title: r.host + " · " + r.count + (r.errors ? " / ✕" + r.errors : "") }) }),
					react_jsx_runtime.jsx("span", { className: "npx-hbar-val", children: r.count + " · ↓" + fmtBytes(r.downBytes) }),
				] });
			}) });
		}

		function ChartPanel(props) {
			var t = props.t;
			var [data, setData] = React.useState(null);
			var [err, setErr] = React.useState(false);

			var load = function () {
				fetch(LOG_API + "?limit=500").then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok) { setData(j); setErr(false); }
				}).catch(function () { setErr(true); });
			};
			React.useEffect(function () {
				load();
				var iv = setInterval(load, 5000);
				return function () { clearInterval(iv); };
			}, []);

			if (err && !data) return react_jsx_runtime.jsx("section", { className: "npx-panel", children: react_jsx_runtime.jsx("div", { className: "npx-alert err", children: t("statusUnavailable") }) });
			var entries = (data && data.entries) || [];
			var s = (data && data.summary) || { total: 0, upBytes: 0, downBytes: 0, errors: 0 };
			var tl = charts.timeline(entries);
			var hosts = charts.topHosts(entries, 10);
			var st = charts.statusDist(entries);
			var lat = charts.latency(entries);
			var ch = charts.channels(entries);
			var latencySub = lat.total
				? t("chartAvg") + " " + lat.avgMs + "ms · " + t("chartP50") + " " + lat.p50Ms + "ms"
				: t("chartLatencySub");
			return react_jsx_runtime.jsx("section", { className: "npx-panel", children: [
				react_jsx_runtime.jsx("div", { className: "npx-log-head", children: react_jsx_runtime.jsx("h3", { children: t("chartTitle") }) }),
				react_jsx_runtime.jsx("div", { className: "npx-log-hint", children: t("chartHint") }),
				react_jsx_runtime.jsx("div", { className: "npx-stat-grid", children: [
					react_jsx_runtime.jsx(StatCard, { color: "var(--dsw-alias-brand-primary,#4f8cff)", label: t("logTotal"), value: s.total }),
					react_jsx_runtime.jsx(StatCard, { color: "#22d3ee", label: t("logUp"), value: fmtBytes(s.upBytes) }),
					react_jsx_runtime.jsx(StatCard, { color: "var(--dsw-alias-label-success,#2ecc71)", label: t("logDown"), value: fmtBytes(s.downBytes) }),
					react_jsx_runtime.jsx(StatCard, { color: "var(--dsw-alias-label-danger,#e74c3c)", label: t("logErrors"), value: s.errors, cls: s.errors ? "err" : "" }),
				] }),
				entries.length ? react_jsx_runtime.jsx("div", { className: "npx-chart-grid", children: [
					react_jsx_runtime.jsxs("div", { className: "npx-chart-card wide", children: [
						react_jsx_runtime.jsxs("h3", { className: "npx-chart-title", children: [t("chartTimeline"), react_jsx_runtime.jsx("span", { className: "npx-chart-sub", children: t("chartBucket") + " " + fmtBucketMs(tl.bucketMs) })] }),
						react_jsx_runtime.jsx(TimelineChart, { data: tl }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-chart-card", children: [
						react_jsx_runtime.jsx("h3", { className: "npx-chart-title", children: t("chartStatus") }),
						react_jsx_runtime.jsx(StatusChart, { d: st, t: t }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-chart-card", children: [
						react_jsx_runtime.jsxs("h3", { className: "npx-chart-title", children: [t("chartLatency"), react_jsx_runtime.jsx("span", { className: "npx-chart-sub", children: latencySub })] }),
						react_jsx_runtime.jsx(LatencyChart, { d: lat }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-chart-card", children: [
						react_jsx_runtime.jsx("h3", { className: "npx-chart-title", children: t("chartChannel") }),
						react_jsx_runtime.jsx(ChannelChart, { rows: ch, t: t }),
					] }),
					react_jsx_runtime.jsxs("div", { className: "npx-chart-card", children: [
						react_jsx_runtime.jsx("h3", { className: "npx-chart-title", children: t("chartTopHosts") }),
						hosts.length ? react_jsx_runtime.jsx(TopHostsChart, { rows: hosts }) : react_jsx_runtime.jsx("div", { className: "npx-chart-empty", children: t("chartEmpty") }),
					] }),
				] }) : react_jsx_runtime.jsx("div", { className: "npx-log-empty", children: t("chartEmpty") }),
			] });
		}

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
			var [tab, setTab] = React.useState("proxy");
			var [ready, setReady] = React.useState(false);
			var [unreachable, setUnreachable] = React.useState(false);
			var [applied, setApplied] = React.useState(false);
			var [saveErr, setSaveErr] = React.useState(false);
			var [enabled, setEnabled] = React.useState(false);
			var [followSystem, setFollowSystem] = React.useState(false);
			var [sysInfo, setSysInfo] = React.useState(null);
			var [harnessInfo, setHarnessInfo] = React.useState(null);
			var [protocol, setProtocol] = React.useState("http");
			var [host, setHost] = React.useState("127.0.0.1");
			var [port, setPort] = React.useState("7890");
			var [username, setUsername] = React.useState("");
			var [password, setPassword] = React.useState("");
			var [noProxy, setNoProxy] = React.useState("127.0.0.1,localhost,::1");
			var [probe, setProbe] = React.useState({ running: false, res: null });
			var [switchErr, setSwitchErr] = React.useState(false);
			// 已加载的服务端配置快照：判断用户是否改了手动代理字段（改了则自动关跟随）
			var loaded = React.useRef({ protocol: "http", host: "127.0.0.1", port: "7890" });

			var applyValue = function (v) {
				setEnabled(Boolean(v.enabled));
				setFollowSystem(Boolean(v.followSystem));
				setProtocol(v.protocol || "http");
				setHost(v.host || "127.0.0.1");
				setPort(v.port != null ? String(v.port) : "7890");
				setUsername(v.username || "");
				setPassword(v.password || "");
				setNoProxy((v.noProxy || []).join(","));
				loaded.current = { protocol: v.protocol || "http", host: v.host || "127.0.0.1", port: v.port != null ? String(v.port) : "7890" };
			};

			React.useEffect(function () {
				fetch(API).then(function (r) { return r.json(); }).then(function (j) {
					if (!j || !j.ok) return;
					applyValue(j.value || {});
					if (j.system) setSysInfo(j.system);
					if (j.harness) setHarnessInfo(j.harness);
					setReady(true);
				}).catch(function () { setUnreachable(true); });
			}, []);

			function refreshStatus() {
				fetch(API).then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok) { if (j.system) setSysInfo(j.system); if (j.harness) setHarnessInfo(j.harness); setReady(true); setUnreachable(false); }
				}).catch(function () {});
			}
			// 跟随模式下定时刷新系统代理状态（与服务端 3s 轮询同步），让状态行保持实时
			React.useEffect(function () {
				if (!followSystem) return;
				refreshStatus();
				var iv = setInterval(refreshStatus, 5000);
				return function () { clearInterval(iv); };
			}, [followSystem]);

			function save() {
				setSaveErr(false); setApplied(false);
				var portNum = /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : 7890;
				var list = noProxy.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
				// UX 约定：跟随时用户改了 host/port/protocol 并保存 → 自动关闭跟随，
				// 避免手动值被 3s 轮询覆盖回去、用户以为插件坏了。
				var touched = loaded.current.protocol !== protocol || loaded.current.host !== host.trim() || loaded.current.port !== String(portNum);
				var follow = Boolean(followSystem) && !touched;
				var body = { enabled: Boolean(enabled), followSystem: follow, protocol: protocol, host: host.trim() || "127.0.0.1", port: portNum, username: username.trim(), password: password, noProxy: list.length ? list : ["127.0.0.1", "localhost", "::1"] };
				fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Net-Proxy": "1" }, body: JSON.stringify(body) })
					.then(function (r) { return r.json(); })
					.then(function (j) { if (j && j.ok) { setApplied(true); setReady(true); setUnreachable(false); if (touched && followSystem) setFollowSystem(false); refreshStatus(); } else setSaveErr(true); })
					.catch(function () { setSaveErr(true); });
			}

			// 开关即时生效：勾选「启用代理」「跟随系统」立即保存应用（v0.7.16 用户定稿），
			// 输入框内容仍走「保存」按钮。以服务端已存配置为基线，只翻转目标开关，
			// 不掺入输入框里未保存的半成品值。失败时把开关翻回去并提示。
			function applySwitch(nextEnabled, nextFollow) {
				var body = { enabled: Boolean(nextEnabled), followSystem: Boolean(nextFollow) };
				fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Net-Proxy": "1" }, body: JSON.stringify(body) })
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (j && j.ok) {
							// 以服务端回传值为准重绘（含口令打码），页面输入框不动
							applyValue(j.value || {});
							setReady(true); setUnreachable(false); setSaveErr(false); setSwitchErr(false);
							refreshStatus();
						} else { setSwitchErr(true); setEnabled(nextEnabled ? enabled : !enabled); setFollowSystem(nextFollow ? followSystem : !followSystem); }
					})
					.catch(function () { setSwitchErr(true); setEnabled(nextEnabled ? enabled : !enabled); setFollowSystem(nextFollow ? followSystem : !followSystem); });
			}

			function reloadNow() {
				setApplied(false); setSaveErr(false);
				fetch(API).then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok) { applyValue(j.value || {}); if (j.system) setSysInfo(j.system); if (j.harness) setHarnessInfo(j.harness); setReady(true); setUnreachable(false); }
				}).catch(function () { setUnreachable(true); });
			}

			function testNow() {
				setProbe({ running: true, res: null });
				var portNum = /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : 0;
				var p = { protocol: protocol, host: host.trim() || "127.0.0.1", port: portNum || 7890, username: username.trim(), password: password, noProxy: noProxy.split(",").map(function (s) { return s.trim(); }).filter(Boolean) };
				fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Net-Proxy": "1" }, body: JSON.stringify({ action: "probe", proxy: p }) })
					.then(function (r) { return r.json(); })
					.then(function (j) { setProbe({ running: false, res: j || { ok: false, error: "no response" } }); })
					.catch(function () { setProbe({ running: false, res: { ok: false, error: "network error" } }); });
			}

			// 跟随模式下徽标反映系统代理的实际状态（sysInfo 由服务端轮询提供）
			var followStateText = null;
			if (followSystem && sysInfo) {
				// 跟随开启时只保留一处状态信息（横幅或单行提示），不重复展示
				if (sysInfo.state === "ok") followStateText = null; // 由下方绿色横幅展示
				else if (sysInfo.state === "off") followStateText = t("sysOff");
				else if (sysInfo.state === "pac") followStateText = t("sysPac");
				else followStateText = t("sysUnavailable");
			}
			// 跟随中且系统代理可用 → 手动表单降级为"兜底"，明确标注实际生效值
			var following = Boolean(followSystem && sysInfo && sysInfo.state === "ok");
			// 徽章只反映总开关（enabled）：用户明确关了就是关，不被跟随模式改写——
			// 「系统代理开着但总开关关了」= 插件不转发，徽章必须如实显示关闭。
			var on = Boolean(enabled);
			var statusBadge = unreachable ? [t("statusUnavailable"), "warn"] : (!ready ? [t("statusLoading"), "warn"] : [on ? t("statusOn") : t("statusOff"), on ? "ok" : "warn"]);
			// 跟随横幅：文字格式统一「（跟随系统）： 地址」（地址=真实读取的系统代理），
			// 生效与否只用红/绿横幅色表达，不加状态词。
			var followBannerText = t("followEffective") + " " + (sysInfo ? sysInfo.proxy : "");

			// harness 代理层（web_fetch 真实走向）：一切正常时不出行；仅异常时给一行警告
			var harnessLine = null;
			if (harnessInfo && harnessInfo.mode) {
				if (harnessInfo.mode === "installed") harnessLine = harnessInfo.verified === false ? t("harnessUnverified") : null;
				else if (harnessInfo.mode === "unsupported-socks") harnessLine = t("harnessSocks");
				else if (harnessInfo.mode === "unavailable") harnessLine = t("harnessUnavailable");
				else if (harnessInfo.mode === "error") harnessLine = t("harnessError") + (harnessInfo.error ? "：" + harnessInfo.error : "");
			}

			return react_jsx_runtime.jsx("div", { className: "npx-root", children: [
				react_jsx_runtime.jsx(Header, { t: t }),
				react_jsx_runtime.jsx("div", { className: "npx-tabs", children: [
					react_jsx_runtime.jsx("button", { className: "npx-tab" + (tab === "proxy" ? " on" : ""), onClick: function () { setTab("proxy"); }, children: t("tabProxy") }),
					react_jsx_runtime.jsx("button", { className: "npx-tab" + (tab === "log" ? " on" : ""), onClick: function () { setTab("log"); }, children: t("tabLog") }),
					react_jsx_runtime.jsx("button", { className: "npx-tab" + (tab === "charts" ? " on" : ""), onClick: function () { setTab("charts"); }, children: t("tabCharts") }),
				] }),
				tab === "log" ? react_jsx_runtime.jsx(LogPanel, { t: t }) : tab === "charts" ? react_jsx_runtime.jsx(ChartPanel, { t: t }) : react_jsx_runtime.jsx("section", { className: "npx-panel", children: [
					react_jsx_runtime.jsx(StatusBadge, { t: t, badgeCls: statusBadge[1], badgeLabel: statusBadge[0] }),
					// 开关即时生效（v0.7.16）：勾选立即保存应用；输入框仍走「保存」按钮
					react_jsx_runtime.jsx(StatusToggle, { t: t, enabled: enabled, onChange: function (e) { applySwitch(e.target.checked, followSystem); } }),
					react_jsx_runtime.jsx("div", { className: "npx-switch", children: [
						react_jsx_runtime.jsx("input", { type: "checkbox", checked: Boolean(followSystem), onChange: function (e) { applySwitch(enabled, e.target.checked); } }),
						react_jsx_runtime.jsx("span", { children: t("follow") }),
					] }),
					followSystem ? react_jsx_runtime.jsx("div", { className: "npx-field-hint", children: [
						react_jsx_runtime.jsx("div", { children: t("followHintShort") }),
						followStateText ? react_jsx_runtime.jsx("div", { style: { marginTop: 4 }, children: followStateText }) : null,
						following ? react_jsx_runtime.jsx("div", { style: { marginTop: 4 }, children: t("followManualNote") }) : null,
					] }) : null,
					// 红/绿横幅 + 统一文字「（跟随系统）： 地址」：绿=生效红=未生效，状态只看颜色。
					following ? react_jsx_runtime.jsx("div", { className: on ? "npx-alert ok" : "npx-alert err", style: { fontWeight: 600 }, children: followBannerText }) : null,
					harnessLine ? react_jsx_runtime.jsx("div", { className: "npx-field-hint", style: { color: "var(--dsw-alias-label-warning,#f1c40f)" }, children: harnessLine }) : null,
					react_jsx_runtime.jsx("div", { className: "npx-form", children: [
						react_jsx_runtime.jsx(Field, { label: t("protocol"), children: react_jsx_runtime.jsx("select", { value: protocol, onChange: function (e) { setProtocol(e.target.value); setApplied(false); }, style: { height: 32, background: "var(--dsw-alias-bg-layer-1,#12151b)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)", borderRadius: 8, padding: "0 8px", font: "inherit" }, children: [react_jsx_runtime.jsx("option", { value: "http", children: t("http") }), react_jsx_runtime.jsx("option", { value: "socks5", children: t("socks5") })] }) }),
						react_jsx_runtime.jsx(Field, { label: t("host"), children: react_jsx_runtime.jsx(Input, { value: host, placeholder: t("placeholderHost"), onChange: function (e) { setHost(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("port"), children: react_jsx_runtime.jsx(Input, { value: port, placeholder: t("placeholderPort"), onChange: function (e) { setPort(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("username"), children: react_jsx_runtime.jsx(Input, { value: username, onChange: function (e) { setUsername(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { label: t("password"), children: react_jsx_runtime.jsx(Input, { type: "password", value: password, onChange: function (e) { setPassword(e.target.value); setApplied(false); } }) }),
						react_jsx_runtime.jsx(Field, { full: true, label: t("noProxy"), hint: t("noProxyHint"), children: react_jsx_runtime.jsx(Input, { value: noProxy, onChange: function (e) { setNoProxy(e.target.value); setApplied(false); } }) }),
					] }),
					saveErr ? react_jsx_runtime.jsx("div", { className: "npx-alert err", children: t("saveFailed") }) : null,
					switchErr ? react_jsx_runtime.jsx("div", { className: "npx-alert err", children: t("switchFailed") }) : null,
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
		exports.charts = charts; // 纯函数聚合，供单测（tests/chart-agg.test.mjs）
		return module.exports;
	},
});
