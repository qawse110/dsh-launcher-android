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
        tokenButton.textContent = "等待浏览器登录…";
        message.textContent = "请在浏览器中完成 CodeBuddy 登录";
        try {
          const path = current.mode === "api-key" && current.authenticated ? "token" : "login";
          render(await request(route, path));
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "登录失败";
          message.style.color = "var(--dsw-text-danger, #c62828)";
        } finally {
          tokenButton.textContent = "令牌登录";
          setBusy(false);
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
