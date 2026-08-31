import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  CODEBUDDY_REGIONS,
  createCodeBuddyLogin,
  parseCodeBuddySession,
  refreshCodeBuddySession,
  serializeCodeBuddySession,
  sessionCacheDeadline,
  sessionNeedsRefresh,
  waitForCodeBuddyLogin,
} from "./codebuddy-auth.js";
import { fetchCodeBuddyUsage } from "./codebuddy-usage.js";

const ROUTE_BY_PROVIDER = {
  "codebuddy-cn": "/dsh-llm-codebuddy/auth",
  "codebuddy-intl": "/dsh-llm-codebuddy/auth-intl",
};

export function authenticationMode(config, provider) {
  const profile = config?.providers?.[provider];
  return profile && profile.apiKeyEnv === undefined ? "token" : "api-key";
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function localPost(req) {
  const address = req.socket.remoteAddress;
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  if (!loopback) return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] === "same-origin";
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const NS = "llm-codebuddy";

async function setMode(settings, mode, region) {
  const config = settings.get(NS);
  const exists = Object.hasOwn(config?.providers ?? {}, region.provider);
  const path = ["providers", region.provider];
  if (!exists) {
    await settings.mutate(NS, [{ op: "set", path, value: mode === "token" ? {} : { apiKeyEnv: region.apiKeyEnv } }]);
    return;
  }
  await settings.mutate(NS, [{
    op: mode === "token" ? "unset" : "set",
    path: [...path, "apiKeyEnv"],
    ...(mode === "api-key" ? { value: region.apiKeyEnv } : {}),
  }]);
}

/**
 * 用量查询用的会话解析：与 index.js 的 resolveLoginSession 语义一致
 * （读凭据 → 按需续期 → 回写），但独立实现一份，因为 web 注入点拿不到
 * LLM 侧的 state；凭据存储是共享的，所以续期结果对两侧都生效。
 */
function createUsageSessionResolver(webCtx) {
  const cache = new Map();
  return async function resolveUsageSession(region) {
    const cached = cache.get(region.provider);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const ref = credentialRef(region.sessionRef);
    const stored = await webCtx.credentials.resolve(ref);
    const value = stored?.value;
    if (!value) throw new Error("尚未保存 CodeBuddy 登录令牌");
    let session = parseCodeBuddySession(value);
    if (sessionNeedsRefresh(session)) {
      session = await refreshCodeBuddySession(session, undefined, region.authBaseUrl);
      await webCtx.credentials.set(ref, serializeCodeBuddySession(session));
    }
    const result = { ...session, expiresAt: sessionCacheDeadline(session) };
    cache.set(region.provider, result);
    return result;
  };
}

export function installCodeBuddyWeb(ctx) {
  ctx.inject(["webServer", "settings", "credentials"], (webCtx) => {
    const loginPromises = new Map();
    const registrations = [];
    const resolveUsageSession = createUsageSessionResolver(webCtx);

    for (const region of Object.values(CODEBUDDY_REGIONS)) {
      const route = ROUTE_BY_PROVIDER[region.provider];
      const sessionRef = credentialRef(region.sessionRef);
      const currentState = async () => ({
        ok: true,
        mode: authenticationMode(webCtx.settings.get(NS), region.provider),
        authenticated: (await webCtx.credentials.describe(sessionRef)).configured,
      });
      const status = async (_req, res) => {
        json(res, 200, await currentState());
      };
      const apiKey = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面切换认证方式" });
        await setMode(webCtx.settings, "api-key", region);
        json(res, 200, await currentState());
      };
      const token = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面切换认证方式" });
        const state = await currentState();
        if (!state.authenticated) return json(res, 409, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
        await setMode(webCtx.settings, "token", region);
        json(res, 200, await currentState());
      };
      const login = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面登录" });
        try {
          let entry = loginPromises.get(region.provider);
          if (entry?.settled) loginPromises.delete(region.provider);
          entry = loginPromises.get(region.provider);
          if (!entry) {
            const state = await createCodeBuddyLogin(region.authBaseUrl);
            entry = { state, authUrl: state.authUrl, settled: false, error: undefined };
            loginPromises.set(region.provider, entry);
            entry.promise = (async () => {
              const session = await waitForCodeBuddyLogin(entry.state, undefined, region.authBaseUrl);
              await webCtx.credentials.set(sessionRef, serializeCodeBuddySession(session));
              await setMode(webCtx.settings, "token", region);
            })().then(
              () => { entry.settled = true; },
              (error) => { entry.settled = true; entry.error = error instanceof Error ? error.message : "CodeBuddy 登录失败"; },
            );
          }
          // 非阻塞：立即把登录链接交还给浏览器端，由浏览器自行打开登录页。
          json(res, 200, { ok: true, mode: "token", authenticated: false, pending: true, authUrl: entry.authUrl });
        } catch (error) {
          json(res, 500, { ok: false, message: error instanceof Error ? error.message : "CodeBuddy 登录失败" });
        }
      };
      const loginStatus = async (_req, res) => {
        const entry = loginPromises.get(region.provider);
        const state = await currentState();
        if (!entry) return json(res, 200, { ...state, pending: false });
        if (entry.settled) loginPromises.delete(region.provider);
        if (entry.settled && entry.error) return json(res, 200, { ...state, pending: false, error: entry.error });
        json(res, 200, { ...state, pending: !entry.settled });
      };
      const usage = async (_req, res) => {
        try {
          const state = await currentState();
          if (!state.authenticated) {
            return json(res, 401, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
          }
          const session = await resolveUsageSession(region);
          const usage$ = await fetchCodeBuddyUsage(region, session);
          json(res, 200, { ok: true, provider: region.provider, ...usage$ });
        } catch (error) {
          json(res, 200, {
            ok: false,
            provider: region.provider,
            message: error instanceof Error ? error.message : "CodeBuddy 用量查询失败",
          });
        }
      };
      registrations.push(
        webCtx.webServer.register({ kind: "exact", path: `${route}/status`, handler: status }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/api-key`, handler: apiKey }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/token`, handler: token }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/login`, handler: login }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/login-status`, handler: loginStatus }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage`, handler: usage }),
      );
    }

    webCtx.effect(() => {
      const dispose = [...registrations];
      return () => dispose.forEach((fn) => fn());
    }, "llm-codebuddy: web login routes");
  });
}
