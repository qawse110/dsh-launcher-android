window.__ModuleLoader__.load({
  id: "dsh-llm-codebuddy",
  factory: (require) => {
    const React = require("react");
    const MARKER = "data-codebuddy-auth-switch";
    const PROVIDER_FIELD = "data-codebuddy-auth-field";
    const PROVIDER_ATTR = "data-codebuddy-provider";
    const ROUTES = {
      "codebuddy-cn": "/dsh-llm-codebuddy/auth",
      "codebuddy-intl": "/dsh-llm-codebuddy/auth-intl",
    };
    const REGIONS = [
      { provider: "codebuddy-cn", label: "中国区" },
      { provider: "codebuddy-intl", label: "国际版" },
    ];

    function button(text) {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      Object.assign(element.style, {
        minHeight: "44px",
        padding: "0 12px",
        border: "1px solid var(--dsw-border-subtle, #d0d5dd)",
        borderRadius: "8px",
        background: "var(--dsw-surface-subtle, transparent)",
        color: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
      });
      return element;
    }

    function codeBuddyProviderOf(editor) {
      if (!editor) return undefined;
      const text = editor.textContent || "";
      for (const provider of Object.keys(ROUTES)) {
        if (text.includes(provider)) return provider;
      }
      const value = editor.parentElement?.querySelector('select[aria-label="提供方"]')?.value;
      return value in ROUTES ? value : undefined;
    }

    function applyMode(input, keyButton, tokenButton, message, status) {
      const token = status.mode === "token";
      input.disabled = token;
      input.placeholder = token ? "当前使用 CodeBuddy 账号令牌" : input.dataset.codebuddyPlaceholder || "输入 API 密钥";
      keyButton.setAttribute("aria-pressed", String(!token));
      tokenButton.setAttribute("aria-pressed", String(token));
      keyButton.style.background = !token ? "var(--dsw-accent-subtle, #eef4ff)" : "var(--dsw-surface-subtle, transparent)";
      tokenButton.style.background = token ? "var(--dsw-accent-subtle, #eef4ff)" : "var(--dsw-surface-subtle, transparent)";
      message.textContent = token ? status.authenticated ? "令牌已登录" : "令牌缺失，请重新登录" : "";
      message.style.color = token && !status.authenticated ? "var(--dsw-text-danger, #c62828)" : "var(--dsw-text-success, #2e7d32)";
    }

    async function request(route, path) {
      const response = await fetch(`${route}/${path}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        const error = new Error(body.message || `请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function mount(input, provider) {
      const field = input.parentElement;
      if (!field || field.querySelector(`[${MARKER}="${provider}"]`)) return;
      field.setAttribute(PROVIDER_FIELD, "");
      field.setAttribute(PROVIDER_ATTR, provider);
      input.dataset.codebuddyPlaceholder = input.placeholder;
      const route = ROUTES[provider];
      const controls = document.createElement("div");
      controls.setAttribute(MARKER, provider);
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "CodeBuddy 认证方式");
      Object.assign(controls.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });
      const keyButton = button("API Key");
      const tokenButton = button("令牌登录");
      const message = document.createElement("span");
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      Object.assign(message.style, { fontSize: "12px", minHeight: "18px" });
      controls.append(keyButton, tokenButton, message);
      field.append(controls);
      let current = { mode: "api-key", authenticated: false };
      const render = (status) => {
        current = { ...current, ...status };
        applyMode(input, keyButton, tokenButton, message, current);
      };

      const setBusy = (busy) => {
        keyButton.disabled = busy;
        tokenButton.disabled = busy;
        keyButton.style.cursor = busy ? "progress" : "pointer";
        tokenButton.style.cursor = busy ? "progress" : "pointer";
      };
      keyButton.addEventListener("click", async () => {
        setBusy(true);
        message.textContent = "正在切换…";
        try {
          render(await request(route, "api-key"));
          input.focus();
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "切换失败";
          message.style.color = "var(--dsw-text-danger, #c62828)";
        } finally {
          setBusy(false);
        }
      });
      tokenButton.addEventListener("click", async () => {
        setBusy(true);
        const danger = "var(--dsw-text-danger, #c62828)";
        const success = "var(--dsw-text-success, #2e7d32)";
        // 已有令牌：仅切换认证模式，无需开浏览器。
        if (current.authenticated) {
          try {
            render(await request(route, "token"));
          } catch (error) {
            message.textContent = error instanceof Error ? error.message : "切换失败";
            message.style.color = danger;
          } finally {
            tokenButton.textContent = "令牌登录";
            setBusy(false);
          }
          return;
        }
        tokenButton.textContent = "等待登录…";
        message.textContent = "正在创建登录会话…";
        message.style.color = "";
        let pollTimer;
        const finish = (ok, text) => {
          clearInterval(pollTimer);
          message.textContent = text;
          message.style.color = ok ? success : danger;
          tokenButton.textContent = "令牌登录";
          setBusy(false);
        };
        try {
          const started = await request(route, "login");
          const authUrl = started.authUrl;
          // WebUI 就运行在本机浏览器里：由浏览器端打开登录页（服务端进程拉不起浏览器）。
          let win = null;
          try { win = window.open(authUrl, "_blank", "noopener"); } catch { /* 弹窗被拦截时走链接兜底 */ }
          if (win) message.textContent = "已打开登录页，请在浏览器中完成 CodeBuddy 登录…";
          else {
            message.replaceChildren();
            const link = document.createElement("a");
            link.href = authUrl;
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = "点此打开 CodeBuddy 登录页";
            message.append(link, document.createTextNode("（或复制链接：" + authUrl + "）"));
          }
          const deadline = Date.now() + 10 * 60_000;
          pollTimer = setInterval(async () => {
            try {
              const s = await fetch(`${route}/login-status`, { cache: "no-store" }).then((r) => r.json());
              if (s.error) return finish(false, s.error);
              if (s.authenticated && !s.pending) {
                render(s);
                return finish(true, "令牌已登录");
              }
            } catch { /* 瞬时网络抖动，继续轮询 */ }
            if (Date.now() > deadline) finish(false, "等待登录超时，请重试");
          }, 2000);
        } catch (error) {
          finish(false, error instanceof Error ? error.message : "登录失败");
        }
      });
      fetch(`${route}/status`, { cache: "no-store" })
        .then((response) => response.json())
        .then(render)
        .catch(() => {
          message.textContent = "认证状态读取失败";
          message.style.color = "var(--dsw-text-danger, #c62828)";
        });
    }

    function enhance() {
      for (const input of document.querySelectorAll('input[aria-label="API 密钥"]')) {
        const editor = input.parentElement?.parentElement;
        const provider = codeBuddyProviderOf(editor);
        if (provider) mount(input, provider);
      }
    }

    // ---- 设置页「CodeBuddy 用量」板块 ----
    // 数据源：GET /dsh-llm-codebuddy/auth/usage（中国区）与 /auth-intl/usage（国际版）。
    // 与网页端 plans-usage 页面同源同接口，仅读取、不写入。

    function fmt(n) {
      if (n === null || n === undefined || Number.isNaN(n)) return "0";
      return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function usageCardStyle() {
      return {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 14px",
        borderRadius: 8,
        minWidth: 110,
        background: "var(--dsw-alias-bg-layer-1, var(--dsh-bg-secondary, rgba(128,128,128,0.08)))",
        border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,0.35)))",
      };
    }

    function UsageCard(props) {
      return React.createElement(
        "div",
        { style: usageCardStyle() },
        React.createElement(
          "span",
          { style: { fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary, var(--dsh-text, inherit))" } },
          props.value
        ),
        React.createElement(
          "span",
          { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, var(--dsh-text-secondary, #888))" } },
          props.label
        )
      );
    }

    function UsageBar(props) {
      const ratio = props.total > 0 ? Math.max(0, Math.min(1, props.remaining / props.total)) : 0;
      const percent = Math.round(ratio * 100);
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4 } },
        React.createElement(
          "div",
          { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
          React.createElement(
            "span",
            { style: { color: "var(--dsw-alias-label-primary, var(--dsh-text, inherit))" } },
            props.label
          ),
          React.createElement(
            "span",
            { style: { color: "var(--dsw-alias-label-secondary, #888)", fontVariantNumeric: "tabular-nums" } },
            `${fmt(props.remaining)} / ${fmt(props.total)} ${props.unit || "credits"}（${percent}%）`
          )
        ),
        React.createElement(
          "div",
          {
            style: {
              height: 8,
              width: "100%",
              borderRadius: 4,
              overflow: "hidden",
              background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))",
            },
          },
          React.createElement("div", {
            style: {
              height: "100%",
              width: `${percent}%`,
              background: "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a90d9))",
              opacity: 0.85,
            },
          })
        )
      );
    }

    // hy4-preview 免费档限流窗口倒计时（重置时刻 - 当前时刻）。
    function formatCountdown(targetIso, nowMs) {
      const target = new Date(targetIso).getTime();
      if (!Number.isFinite(target)) return "";
      const diff = Math.max(0, target - nowMs);
      const totalMinutes = Math.floor(diff / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const seconds = Math.floor((diff % 60000) / 1000);
      if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
      if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
      return `${seconds} 秒`;
    }

    // hy4-preview 用量/限流状态块：独立于额度查询渲染（额度接口挂了也要能看出限流）。
    function Hy4StatusBlock(props) {
      const { hy4, hy4Loading, hy4Error, now, secondary, danger, success } = props;
      const content = hy4Loading && !hy4
        ? React.createElement("div", { style: { fontSize: 12, color: secondary } }, "正在探测 hy4-preview 限流窗口…")
        : hy4Error
          ? React.createElement(
              "div",
              { style: { fontSize: 12, color: secondary } },
              `状态未知（${hy4Error}），请点「刷新」重试`
            )
          : hy4
            ? React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    padding: "10px 14px",
                    borderRadius: 8,
                    background: "var(--dsw-alias-bg-layer-1, var(--dsh-bg-secondary, rgba(128,128,128,0.08)))",
                    border: `1px solid ${hy4.limited ? danger : "var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,0.35)))"}`,
                  },
                },
                React.createElement(
                  "span",
                  { style: { fontSize: 14, fontWeight: 600, color: hy4.available ? success : danger } },
                  hy4.available ? "可用" : "限流中"
                ),
                hy4.limited && hy4.resetAt
                  ? React.createElement(
                      "span",
                      {
                        style: {
                          fontSize: 12,
                          color: secondary,
                          fontVariantNumeric: "tabular-nums",
                        },
                      },
                      `重置于 ${new Date(hy4.resetAt).toLocaleString()}（剩余 ${formatCountdown(hy4.resetAt, now)}）`
                    )
                  : hy4.limited
                    ? React.createElement(
                        "span",
                        { style: { fontSize: 12, color: secondary } },
                        "（服务端未给出重置时间）"
                      )
                    : hy4.httpStatus && hy4.httpStatus !== 200
                      ? React.createElement(
                          "span",
                          { style: { fontSize: 12, color: secondary } },
                          `探测返回 ${hy4.httpStatus}：${hy4.message || ""}`
                        )
                      : React.createElement(
                          "span",
                          { style: { fontSize: 12, color: secondary } },
                          hy4.servedAt ? `探测于 ${new Date(hy4.servedAt).toLocaleString()}` : ""
                        )
              )
            : React.createElement("div", { style: { fontSize: 12, color: secondary } }, "暂无 hy4-preview 状态");
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        React.createElement(
          "div",
          { style: { fontSize: 12, fontWeight: 600, color: secondary } },
          "hy4-preview 用量 / 限流"
        ),
        content
      );
    }

    // ---- 会话用量（本地统计）----
    // 数据源：GET /dsh-llm-codebuddy/auth/usage/sessions —— 服务端扫描本地
    // session.jsonl.zstd 聚合而来，与 CodeBuddy 计费接口独立、粒度到单次请求，
    // 覆盖所有 Provider（codebuddy-cn / codebuddy-intl / agent-route / free…）。

    function fmtTokens(n) {
      if (!Number.isFinite(n)) return "0";
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.round(n));
    }

    const SESSION_EXPAND_LIMIT = 12;

    // ---- 积分消耗明细（官方接口）----
    // 数据源：GET /dsh-llm-codebuddy/auth/usage/requests —— 网页「使用明细」同源
    // 接口（billing/meter/get-user-request-usage），逐条请求 × 模型 × 客户端 × 积分。
    // 与本地会话统计互补：这个带真实的「积分」数值，本地统计带 token 与会话归属。

    function fmtCredit(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return "0";
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function RequestUsageBlock(props) {
      const { data, loading, error, secondary } = props;
      if (loading && !data) {
        return React.createElement("div", { style: { fontSize: 12, color: secondary } }, "正在拉取积分消耗明细…");
      }
      if (error && !data) {
        return React.createElement("div", { style: { fontSize: 12, color: secondary } }, `积分明细不可用（${error}）`);
      }
      if (!data) return null;
      const models = Array.isArray(data.byModel) ? data.byModel : [];
      const days = Array.isArray(data.byDay) ? data.byDay : [];
      const clients = Array.isArray(data.byClient) ? data.byClient : [];
      const maxCredit = Math.max(0.0001, ...models.map((m) => m.credit));
      const totalCredit = models.reduce((acc, m) => acc + m.credit, 0);
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },
        React.createElement(
          "div",
          { style: { fontSize: 12, fontWeight: 600, color: secondary, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
          React.createElement("span", null, "积分消耗明细（近 30 天）"),
          React.createElement(
            "span",
            { style: { fontWeight: 400, opacity: 0.8 } },
            `合计 ${fmtCredit(totalCredit)} 积分 · 实际取到 ${data.fetched ?? 0} 条` +
            (data.windows ? `（按日分片 ${data.windows} 段）` : "") +
            (data.capped ? " · ⚠ 部分分片触顶，可能仍有遗漏" : "")
          )
        ),
        models.length === 0
          ? React.createElement("div", { style: { fontSize: 12, color: secondary } }, "该区间内没有积分消耗记录")
          : React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 6 } },
              models.map((m) =>
                React.createElement(
                  "div",
                  { key: m.model, style: { display: "flex", flexDirection: "column", gap: 2 } },
                  React.createElement(
                    "div",
                    { style: { display: "flex", justifyContent: "space-between", fontSize: 12, flexWrap: "wrap", gap: 6 } },
                    React.createElement("span", null, m.model),
                    React.createElement(
                      "span",
                      { style: { color: secondary, fontVariantNumeric: "tabular-nums" } },
                      `${fmtCredit(m.credit)} 积分 · ${m.requests} 次`
                    )
                  ),
                  React.createElement(
                    "div",
                    { style: { height: 5, borderRadius: 3, overflow: "hidden", background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))" } },
                    React.createElement("div", {
                      style: {
                        height: "100%",
                        width: `${(m.credit / maxCredit) * 100}%`,
                        background: "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a90d9))",
                        opacity: 0.8,
                      },
                    })
                  )
                )
              )
            ),
        clients.length > 1
          ? React.createElement(
              "div",
              { style: { fontSize: 12, color: secondary } },
              "客户端：" + clients.map((c) => `${c.client} ${fmtCredit(c.credit)}（${c.requests} 次）`).join(" · ")
            )
          : null,
        days.length === 0
          ? null
          : React.createElement(
              "details",
              { style: { fontSize: 12 } },
              React.createElement("summary", { style: { cursor: "pointer", color: secondary } }, `按日分布（${days.length} 天）`),
              React.createElement(
                "div",
                { style: { paddingTop: 6, display: "flex", flexDirection: "column", gap: 3, color: secondary } },
                days.slice(-14).map((d) =>
                  React.createElement("div", { key: d.day, style: { display: "flex", justifyContent: "space-between", maxWidth: 320 } },
                    React.createElement("span", null, d.day),
                    React.createElement("span", { style: { fontVariantNumeric: "tabular-nums" } }, `${fmtCredit(d.credit)} 积分 · ${d.requests} 次`)
                  )
                )
              )
            ),
        React.createElement(
          "div",
          { style: { fontSize: 11, color: secondary } },
          // 服务端单次查询 total 封顶 3000 条，宽区间会丢数据，故按日分片拉取；
          // 这里展示的是分片汇总后的真实条数。
          data.servedAt
            ? `更新于 ${new Date(data.servedAt).toLocaleString()} · 数据源：官方积分明细接口（与网页「使用明细」同源，按日分片汇总）`
            : ""
        )
      );
    }

    function SessionUsageBlock(props) {
      const { data, loading, error, secondary, danger } = props;
      const [expanded, setExpanded] = React.useState(false);
      if (loading && !data) {
        return React.createElement("div", { style: { fontSize: 12, color: secondary } }, "正在扫描本地会话…");
      }
      if (error && !data) {
        return React.createElement("div", { style: { fontSize: 12, color: secondary } }, `会话统计不可用（${error}）`);
      }
      if (!data) return null;
      const totals = data.totals ?? {};
      const models = Array.isArray(data.models) ? data.models : [];
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const maxModelOutput = Math.max(1, ...models.map((m) => m.output + m.cacheRead));
      const visibleSessions = expanded ? sessions : sessions.slice(0, SESSION_EXPAND_LIMIT);
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },
        React.createElement(
          "div",
          { style: { fontSize: 12, fontWeight: 600, color: secondary, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
          React.createElement("span", null, "会话用量（本地统计）"),
          React.createElement(
            "span",
            { style: { fontWeight: 400, opacity: 0.8 } },
            `${totals.sessions ?? 0} 个会话 · ${totals.requests ?? 0} 次请求 · 输入 ${fmtTokens(totals.input)} · 输出 ${fmtTokens(totals.output)} · 缓存读 ${fmtTokens(totals.cacheRead)}` +
            (data.truncated ? " ·（扫描超时，结果不完整）" : "")
          )
        ),
        models.length === 0
          ? React.createElement("div", { style: { fontSize: 12, color: secondary } }, "暂无模型用量记录")
          : React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 6 } },
              models.map((m) =>
                React.createElement(
                  "div",
                  { key: `${m.provider}:${m.model}`, style: { display: "flex", flexDirection: "column", gap: 2 } },
                  React.createElement(
                    "div",
                    { style: { display: "flex", justifyContent: "space-between", fontSize: 12, flexWrap: "wrap", gap: 6 } },
                    React.createElement(
                      "span",
                      { style: { color: "var(--dsw-alias-label-primary, var(--dsh-text, inherit))" } },
                      `${m.model}`,
                      React.createElement("span", { style: { color: secondary, fontSize: 11, marginLeft: 6 } }, `${m.provider} · ${m.sessions} 会话 · ${m.requests} 次`)
                    ),
                    React.createElement(
                      "span",
                      { style: { color: secondary, fontVariantNumeric: "tabular-nums" } },
                      `入 ${fmtTokens(m.input)} / 出 ${fmtTokens(m.output)} / 缓存 ${fmtTokens(m.cacheRead)}`
                    )
                  ),
                  React.createElement(
                    "div",
                    { style: { height: 5, borderRadius: 3, overflow: "hidden", background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))", display: "flex" } },
                    React.createElement("div", {
                      style: { width: `${((m.output + m.cacheRead) / maxModelOutput) * 100}%`, background: "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a90d9))", opacity: 0.75 },
                    }),
                    React.createElement("div", {
                      style: { width: `${(m.input / maxModelOutput) * 100}%`, background: "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a90d9))", opacity: 0.3 },
                    }),
                  )
                )
              )
            ),
        sessions.length === 0
          ? null
          : React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 4 } },
              visibleSessions.map((s) =>
                React.createElement(
                  "details",
                  {
                    key: s.sessionId,
                    style: { fontSize: 12, borderRadius: 6, padding: "4px 8px", background: "var(--dsw-alias-bg-layer-1, var(--dsh-bg-secondary, rgba(128,128,128,0.08)))" },
                  },
                  React.createElement(
                    "summary",
                    { style: { cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", listStylePosition: "inside" } },
                    React.createElement(
                      "span",
                      { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" } },
                      s.title
                    ),
                    React.createElement(
                      "span",
                      { style: { color: secondary, fontVariantNumeric: "tabular-nums", flexShrink: 0 } },
                      `${s.requests} 次 · 入 ${fmtTokens(s.input)} · 出 ${fmtTokens(s.output)}`
                    )
                  ),
                  React.createElement(
                    "div",
                    { style: { paddingTop: 6, display: "flex", flexDirection: "column", gap: 3, color: secondary } },
                    React.createElement("div", null, `会话 ${s.sessionId} · 创建于 ${s.createdAt ? new Date(s.createdAt).toLocaleString() : "?"} · 最近活跃 ${s.lastActivity ? new Date(s.lastActivity).toLocaleString() : "?"}`),
                    React.createElement("div", null, `目录 ${s.cwd || "?"}`),
                    React.createElement("div", null, `缓存读 ${fmtTokens(s.cacheRead)} · 缓存写 ${fmtTokens(s.cacheWrite)}`),
                    (s.models ?? []).map((m) =>
                      React.createElement("div", { key: `${m.provider}:${m.model}` }, `· ${m.provider}/${m.model}：${m.requests} 次，入 ${fmtTokens(m.input)}，出 ${fmtTokens(m.output)}，缓存 ${fmtTokens(m.cacheRead)}`)
                    )
                  )
                )
              ),
              sessions.length > SESSION_EXPAND_LIMIT
                ? React.createElement(
                    "button",
                    {
                      onClick: () => setExpanded(!expanded),
                      style: {
                        fontSize: 12, padding: "4px 12px", borderRadius: 6, cursor: "pointer",
                        border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,0.35)))",
                        background: "transparent", color: "var(--dsw-alias-label-primary, var(--dsh-text, inherit))",
                        alignSelf: "flex-start",
                      },
                    },
                    expanded ? "收起会话列表" : `展开全部 ${sessions.length} 个会话`
                  )
                : null
            ),
        React.createElement(
          "div",
          { style: { fontSize: 11, color: secondary } },
          data.scannedAt ? `扫描于 ${new Date(data.scannedAt).toLocaleString()}（${data.files ?? 0} 个会话文件，本次重扫 ${data.reparsed ?? 0}）· 数据来自本地会话日志，仅统计经过 DSH 的请求` : ""
        )
      );
    }

    function UsagePanel() {
      const [provider, setProvider] = React.useState("codebuddy-cn");
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [hy4, setHy4] = React.useState(null);
      const [hy4Loading, setHy4Loading] = React.useState(false);
      const [hy4Error, setHy4Error] = React.useState("");
      const [sessionUsage, setSessionUsage] = React.useState(null);
      const [sessionLoading, setSessionLoading] = React.useState(false);
      const [sessionError, setSessionError] = React.useState("");
      const [requestUsage, setRequestUsage] = React.useState(null);
      const [requestLoading, setRequestLoading] = React.useState(false);
      const [requestError, setRequestError] = React.useState("");
      // 明细视图（第三个 tab）要按区域取数，记住最后一次选的区域。
      const [requestsProvider, setRequestsProvider] = React.useState("codebuddy-cn");
      const requestsProviderRef = React.useRef(requestsProvider);
      requestsProviderRef.current = requestsProvider;
      const [now, setNow] = React.useState(Date.now());
      const hy4InflightRef = React.useRef(new Map());
      const sessionInflightRef = React.useRef(undefined);
      const requestInflightRef = React.useRef(undefined);
      const providerRef = React.useRef(provider);
      providerRef.current = provider;

      const load = React.useCallback((which) => {
        setLoading(true);
        setError("");
        const route = ROUTES[which];
        return fetch(`${route}/usage`, { cache: "no-store" })
          .then((response) => response.json())
          .then((body) => {
            if (!body || body.ok === false) {
              setData(null);
              setError(body?.message || "用量查询失败");
            } else {
              setData(body);
              setError("");
            }
          })
          .catch((e) => {
            setData(null);
            setError(`用量加载失败：${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => setLoading(false));
      }, []);

      const loadHy4 = React.useCallback((which) => {
        // 同一区域并发探测去重（面板挂载/StrictMode 双触发时只发一次）。
        if (hy4InflightRef.current.get(which)) return hy4InflightRef.current.get(which);
        setHy4Loading(true);
        setHy4Error("");
        const route = ROUTES[which];
        const promise = fetch(`${route}/usage/hy4`, { cache: "no-store" })
          .then((response) => response.json())
          .then((body) => {
            if (!body || body.ok === false) {
              setHy4(null);
              setHy4Error(body?.message || "hy4 用量查询失败");
            } else {
              setHy4(body);
              setHy4Error("");
            }
          })
          .catch((e) => {
            setHy4(null);
            setHy4Error(`hy4 用量加载失败：${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            setHy4Loading(false);
            hy4InflightRef.current.delete(which);
          });
        hy4InflightRef.current.set(which, promise);
        return promise;
      }, []);

      const loadSessions = React.useCallback(() => {
        // 会话统计与区域无关（本地日志），只请求一次；轮询/刷新共用。
        if (sessionInflightRef.current) return sessionInflightRef.current;
        setSessionLoading(true);
        setSessionError("");
        const promise = fetch(`${ROUTES["codebuddy-cn"]}/usage/sessions`, { cache: "no-store" })
          .then((response) => response.json())
          .then((body) => {
            if (!body || body.ok === false) {
              setSessionUsage(null);
              setSessionError(body?.message || "会话统计失败");
            } else {
              setSessionUsage(body);
              setSessionError("");
            }
          })
          .catch((e) => {
            setSessionUsage(null);
            setSessionError(`会话统计加载失败：${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            setSessionLoading(false);
            sessionInflightRef.current = undefined;
          });
        sessionInflightRef.current = promise;
        return promise;
      }, []);

      // 积分消耗明细按区域取（中国区/国际版是两套账单），切换区域时重取。
      const loadRequests = React.useCallback((which) => {
        if (requestInflightRef.current?.which === which) return requestInflightRef.current.promise;
        setRequestLoading(true);
        setRequestError("");
        const promise = fetch(`${ROUTES[which]}/usage/requests`, { cache: "no-store" })
          .then((response) => response.json())
          .then((body) => {
            if (!body || body.ok === false) {
              setRequestUsage(null);
              setRequestError(body?.message || "积分明细查询失败");
            } else {
              setRequestUsage(body);
              setRequestError("");
            }
          })
          .catch((e) => {
            setRequestUsage(null);
            setRequestError(`积分明细加载失败：${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            setRequestLoading(false);
            requestInflightRef.current = undefined;
          });
        requestInflightRef.current = { which, promise };
        return promise;
      }, []);

      const isRequestsView = provider === "requests";

      React.useEffect(() => {
        // 明细视图只取明细（且按记住的区域），额度视图才拉额度/hy4/本地统计。
        if (isRequestsView) {
          loadRequests(requestsProvider);
          return;
        }
        // 切换区域时清掉旧区域的 hy4 状态（重置时间是按区域/模型计的，不能串着显示）。
        setHy4(null);
        setHy4Error("");
        load(provider);
        loadHy4(provider);
        loadSessions();
      }, [provider, requestsProvider, isRequestsView, load, loadHy4, loadSessions, loadRequests]);

      // 限流中且带重置时间时，每秒刷新一次倒计时。
      React.useEffect(() => {
        if (!hy4?.limited || !hy4?.resetAt) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [hy4?.limited, hy4?.resetAt]);

      const VIEWS = [
        ...REGIONS.map((region) => ({ key: region.provider, label: region.label })),
        { key: "requests", label: "积分消耗明细" },
      ];
      const secondary = "var(--dsw-alias-label-secondary, #888)";
      const danger = "var(--dsw-alias-state-error-primary, #c62828)";
      const success = "var(--dsw-alias-state-success-primary, #2e7d32)";
      const packages = Array.isArray(data?.packages) ? data.packages : [];
      const activeRoute = isRequestsView
        ? ROUTES[requestsProvider] ?? ROUTES["codebuddy-cn"]
        : ROUTES[provider] ?? ROUTES["codebuddy-cn"];

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          VIEWS.map((view) => {
            const active = view.key === provider;
            const onSelect = () => {
              if (view.key !== "requests") setRequestsProvider(view.key); // 记住区域
              setProvider(view.key);
            };
            return React.createElement(
              "button",
              {
                key: view.key,
                onClick: onSelect,
                style: {
                  fontSize: 12,
                  padding: "4px 12px",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,0.35)))",
                  background: active ? "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a90d9))" : "transparent",
                  color: active ? "#fff" : "var(--dsw-alias-label-primary, var(--dsh-text, inherit))",
                },
              },
              view.label
            );
          }),
          isRequestsView
            ? React.createElement(
                "span",
                { style: { fontSize: 12, color: secondary } },
                `取数区域：${REGIONS.find((r) => r.provider === requestsProvider)?.label ?? requestsProvider}`
              )
            : null,
          React.createElement(
            "button",
            {
              onClick: () => {
                if (isRequestsView) loadRequests(requestsProviderRef.current);
                else {
                  load(providerRef.current);
                  loadHy4(providerRef.current);
                  loadSessions();
                }
              },
              disabled: loading || hy4Loading || sessionLoading || requestLoading,
              style: {
                fontSize: 12,
                padding: "4px 12px",
                borderRadius: 6,
                cursor: loading || hy4Loading ? "default" : "pointer",
                border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,0.35)))",
                background: "transparent",
                color: "var(--dsw-alias-label-primary, var(--dsh-text, inherit))",
              },
            },
            loading || hy4Loading || sessionLoading || requestLoading ? "刷新中…" : "刷新"
          ),
          isRequestsView
            ? requestError
              ? React.createElement("span", { style: { fontSize: 12, color: danger } }, requestError)
              : React.createElement(
                  "span",
                  { style: { fontSize: 12, color: secondary } },
                  requestUsage?.servedAt ? `更新于 ${new Date(requestUsage.servedAt).toLocaleString()}` : ""
                )
            : error
              ? React.createElement("span", { style: { fontSize: 12, color: danger } }, error)
              : React.createElement(
                  "span",
                  { style: { fontSize: 12, color: secondary } },
                  data?.servedAt ? `更新于 ${new Date(data.servedAt).toLocaleString()}` : ""
                )
        ),
        // 明细视图（第三个 tab）独占内容区；额度视图保留原有区块。
        isRequestsView
          ? React.createElement(RequestUsageBlock, {
              data: requestUsage,
              loading: requestLoading,
              error: requestError,
              secondary,
            })
          : React.createElement(
              React.Fragment,
              null,
              error
                ? null
                : React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      "div",
                      { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
                      React.createElement(UsageCard, { label: "剩余", value: fmt(data?.remaining) }),
                      React.createElement(UsageCard, { label: "本周期已用", value: fmt(data?.used) }),
                      React.createElement(UsageCard, { label: "总额度", value: fmt(data?.total) }),
                      React.createElement(UsageCard, {
                        label: "订阅状态",
                        value: data?.isPaidUser ? "付费版" : "免费版",
                      })
                    ),
                    React.createElement(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: 10 } },
                      packages.length === 0
                        ? React.createElement("div", { style: { fontSize: 12, color: secondary } }, "暂无资源包")
                        : packages.map((item) =>
                            React.createElement(UsageBar, {
                              key: `${provider}:${item.packageCode || item.name}:${item.cycleStart || ""}`,
                              label: item.cycleEnd ? `${item.name}（至 ${item.cycleEnd}）` : item.name,
                              remaining: item.remaining,
                              total: item.total,
                              unit: item.unit,
                            })
                          )
                    )
                  ),
              React.createElement(Hy4StatusBlock, { hy4, hy4Loading, hy4Error, now, secondary, danger, success }),
              React.createElement(SessionUsageBlock, {
                data: sessionUsage,
                loading: sessionLoading,
                error: sessionError,
                secondary,
                danger,
              })
            ),
        React.createElement(
          "div",
          { style: { fontSize: 11, color: secondary, lineHeight: 1.6 } },
          "数据与 CodeBuddy 个人中心「套餐与用量」页面同源，存在 2-3 小时延迟；本面板仅读取用量，不会进行任何领取或扣费操作。"
        )
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots !== undefined) {
        ctx.effect(
          () =>
            slots.inject("settings.section", () =>
              slots.register({
                name: "settings.section", id: "codebuddy-usage", order: 25, label: "CodeBuddy 用量"
              }, () => React.createElement(UsagePanel))
            ),
          "llm-codebuddy: usage section"
        );
      }
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = `
          [data-codebuddy-auth-field] { display: grid !important; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
          [data-codebuddy-auth-field] > span:first-child { grid-column: 1 / -1; }
          [data-codebuddy-auth-field] > input[aria-label="API 密钥"] { grid-column: 1; min-width: 0; }
          [data-codebuddy-auth-field] > [data-codebuddy-auth-switch] { grid-column: 2; }
          @media (max-width: 640px) { [data-codebuddy-auth-field] > [data-codebuddy-auth-switch] { grid-column: 1 / -1; } }
        `;
        document.head.append(style);
        const observer = new MutationObserver(enhance);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("change", enhance, true);
        enhance();
        return () => {
          style.remove();
          observer.disconnect();
          document.removeEventListener("change", enhance, true);
        };
      }, "llm-codebuddy: auth switch");
    }

    return { name: "dsh-llm-codebuddy-client", inject: ["slots"], apply };
  },
});
