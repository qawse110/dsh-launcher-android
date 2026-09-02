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

    function UsagePanel() {
      const [provider, setProvider] = React.useState("codebuddy-cn");
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [hy4, setHy4] = React.useState(null);
      const [hy4Loading, setHy4Loading] = React.useState(false);
      const [hy4Error, setHy4Error] = React.useState("");
      const [now, setNow] = React.useState(Date.now());
      const hy4InflightRef = React.useRef(new Map());
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

      React.useEffect(() => {
        // 切换区域时清掉旧区域的 hy4 状态（重置时间是按区域/模型计的，不能串着显示）。
        setHy4(null);
        setHy4Error("");
        load(provider);
        loadHy4(provider);
      }, [provider, load, loadHy4]);

      // 限流中且带重置时间时，每秒刷新一次倒计时。
      React.useEffect(() => {
        if (!hy4?.limited || !hy4?.resetAt) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [hy4?.limited, hy4?.resetAt]);

      const secondary = "var(--dsw-alias-label-secondary, #888)";
      const danger = "var(--dsw-alias-state-error-primary, #c62828)";
      const success = "var(--dsw-alias-state-success-primary, #2e7d32)";
      const packages = Array.isArray(data?.packages) ? data.packages : [];

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          REGIONS.map((region) => {
            const active = region.provider === provider;
            return React.createElement(
              "button",
              {
                key: region.provider,
                onClick: () => setProvider(region.provider),
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
              region.label
            );
          }),
          React.createElement(
            "button",
            {
              onClick: () => {
                load(providerRef.current);
                loadHy4(providerRef.current);
              },
              disabled: loading || hy4Loading,
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
            loading || hy4Loading ? "刷新中…" : "刷新"
          ),
          error
            ? React.createElement("span", { style: { fontSize: 12, color: danger } }, error)
            : React.createElement(
                "span",
                { style: { fontSize: 12, color: secondary } },
                data?.servedAt ? `更新于 ${new Date(data.servedAt).toLocaleString()}` : ""
              )
        ),
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
