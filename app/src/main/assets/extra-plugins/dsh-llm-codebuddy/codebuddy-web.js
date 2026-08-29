import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { CODEBUDDY_REGIONS, loginCodeBuddy, serializeCodeBuddySession } from "./codebuddy-auth.js";

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

export function installCodeBuddyWeb(ctx) {
  ctx.inject(["webServer", "settings", "credentials"], (webCtx) => {
    const loginPromises = new Map();
    const registrations = [];

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
          loginPromises.set(region.provider, (async () => {
            const session = await loginCodeBuddy(undefined, undefined, region.authBaseUrl);
            await webCtx.credentials.set(sessionRef, serializeCodeBuddySession(session));
            await setMode(webCtx.settings, "token", region);
          })().finally(() => {
            loginPromises.delete(region.provider);
          }));
          await loginPromises.get(region.provider);
          json(res, 200, { ok: true, mode: "token", authenticated: true });
        } catch (error) {
          json(res, 500, { ok: false, message: error instanceof Error ? error.message : "CodeBuddy 登录失败" });
        }
      };
      registrations.push(
        webCtx.webServer.register({ kind: "exact", path: `${route}/status`, handler: status }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/api-key`, handler: apiKey }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/token`, handler: token }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/login`, handler: login }),
      );
    }

    webCtx.effect(() => {
      const dispose = [...registrations];
      return () => dispose.forEach((fn) => fn());
    }, "llm-codebuddy: web login routes");
  });
}
