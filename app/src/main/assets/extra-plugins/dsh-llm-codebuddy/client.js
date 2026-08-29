window.__ModuleLoader__.load({
  id: "dsh-llm-codebuddy",
  factory: () => {
    const MARKER = "data-codebuddy-auth-switch";
    const PROVIDER_FIELD = "data-codebuddy-auth-field";
    const PROVIDER_ATTR = "data-codebuddy-provider";
    const ROUTES = {
      "codebuddy-cn": "/dsh-llm-codebuddy/auth",
      "codebuddy-intl": "/dsh-llm-codebuddy/auth-intl",
    };

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

    function apply(ctx) {
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

    return { name: "dsh-llm-codebuddy-client", inject: [], apply };
  },
});
