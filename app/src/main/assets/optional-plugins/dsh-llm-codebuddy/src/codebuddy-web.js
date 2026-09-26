import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  CODEBUDDY_REGIONS,
  activeCodeBuddySession,
  backfillCodeBuddySessionLabels,
  codeBuddySessionAccounts,
  codeBuddySessionNeedsLabel,
  createCodeBuddyLogin,
  createCodeBuddySessionStore,
  enrichAccountWithProfile,
  parseCodeBuddySession,
  parseCodeBuddySessions,
  refreshCodeBuddySession,
  serializeCodeBuddySession,
  serializeCodeBuddySessions,
  sessionCacheDeadline,
  sessionNeedsRefresh,
  upsertCodeBuddySession,
  waitForCodeBuddyLogin,
} from "./codebuddy-auth.js";
import { fetchCodeBuddyRequestUsage, fetchCodeBuddyUsage, probeCodeBuddyHy4, probeModelRateLimit } from "./codebuddy-usage.js";
import { collectSessionUsageAsync, defaultSessionsRoot } from "./codebuddy-sessions.js";

// 限流状态探测的默认模型集：hy4 系列与 DeepSeek V4.1 Flash（免费/低价高关注度模型）。
const RATE_LIMIT_PROBE_MODELS = Object.freeze([
  "hy4-preview",
  "hy4-preview-f",
  "deepseek-v4.1-flash",
]);

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
  // accountId 可选：多账号用量查询可指定账号（缺省 = 当前 active）。
  // 解析/刷新走统一的 store 读写（兼容旧单账号 ref），缓存按「区域:账号」分键。
  return async function resolveUsageSession(region, accountId) {
    const key = `${region.provider}:${accountId ?? "active"}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const { session, expiresAt } = await resolveSession(webCtx.credentials, region, accountId);
    const result = { ...session, expiresAt };
    cache.set(key, result);
    return result;
  };
}

/** 读取 POST JSON body（登录/切换/删除端点用；坏体返回 {}）。 */
function requestBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) data = ""; // 超限即弃，防滥发
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ---- 多账号会话 store（每个区域一份）----
// 读侧兼容：本区域多账号 store → 旧单账号 ref（自动包成单条 store）。

async function readSessionStore(credentials, region) {
  for (const ref of [region.sessionsRef, region.sessionRef]) {
    try {
      const stored = await credentials?.resolve(credentialRef(ref));
      if (stored?.value) {
        const parsed = JSON.parse(stored.value);
        if (Array.isArray(parsed?.sessions)) return parseCodeBuddySessions(stored.value);
        if (parsed?.auth) {
          const legacy = parseCodeBuddySession(stored.value);
          return createCodeBuddySessionStore([legacy], undefined);
        }
      }
    } catch {
      /* 单个 ref 坏掉继续试下一个 */
    }
  }
  return createCodeBuddySessionStore();
}

async function writeSessionStore(credentials, region, store) {
  const active = activeCodeBuddySession(store);
  if (!active) {
    await credentials?.unset(credentialRef(region.sessionsRef));
    await credentials?.unset(credentialRef(region.sessionRef));
    return;
  }
  await credentials?.set(credentialRef(region.sessionsRef), serializeCodeBuddySessions(store));
  // 旧单账号 ref 继续维护为「指向 active」的兼容指针：
  // 旧版插件/CLI/用量路由读它仍能拿到当前账号。
  await credentials?.set(credentialRef(region.sessionRef), serializeCodeBuddySession(active));
}

/** 按 accountId 解析会话（无 id → active），必要时刷新并回写 store。 */
async function resolveSession(credentials, region, accountId) {
  const store = await readSessionStore(credentials, region);
  const requestedId = typeof accountId === "string" && accountId ? accountId : store.activeId;
  let session = store.sessions.find((entry) => entry.id === requestedId) ?? activeCodeBuddySession(store);
  if (!session) throw new Error("没有找到该 CodeBuddy 登录账号");
  if (sessionNeedsRefresh(session)) {
    session = await refreshCodeBuddySession(session, undefined, region.authBaseUrl);
    const nextStore = upsertCodeBuddySession({ ...store, activeId: session.id }, session);
    await writeSessionStore(credentials, region, nextStore);
    session = { ...session, ...activeCodeBuddySession(nextStore) };
  }
  return { session, expiresAt: sessionCacheDeadline(session) };
}

export function installCodeBuddyWeb(ctx) {
  ctx.inject(["webServer", "settings", "credentials"], (webCtx) => {
    const loginPromises = new Map();
    const registrations = [];
    const resolveUsageSession = createUsageSessionResolver(webCtx);

    for (const region of Object.values(CODEBUDDY_REGIONS)) {
      const route = ROUTE_BY_PROVIDER[region.provider];
      const sessionRef = credentialRef(region.sessionRef);
      // 昵称回填是「尽力而为」的后台动作，绝不阻塞 status：
      //   - 中国区没有 /v2/plugin/accounts 端点，探测会白等到超时（实测会把
      //     status 拖到 HTTP 000 无响应）；
      //   - 一旦某区域被判定为不支持（超时/404），记下来不再重试。
      // 因此 status 只做「读 + 立即返回」，回填在后台跑，下次刷新就能看到新昵称。
      let profileEndpointUnsupported = false;
      let backfillRunning = false;
      const runBackfill = (store) => {
        if (profileEndpointUnsupported || backfillRunning) return;
        if (!(store?.sessions ?? []).some((entry) => codeBuddySessionNeedsLabel(entry))) return;
        backfillRunning = true;
        backfillCodeBuddySessionLabels(store, async (entry) => {
          const auth = entry?.auth;
          if (!auth?.accessToken) return undefined;
          const enriched = await enrichAccountWithProfile(auth, entry.account, undefined, region.authBaseUrl);
          if (enriched === entry.account) profileEndpointUnsupported = true; // 端点不可用：停止后续尝试
          return enriched !== entry.account ? enriched : undefined;
        })
          .then(async (next) => {
            if (next !== store) await writeSessionStore(webCtx.credentials, region, next);
          })
          .catch(() => {})
          .finally(() => { backfillRunning = false; });
      };
      const currentState = async () => {
        const store = await readSessionStore(webCtx.credentials, region);
        runBackfill(store); // 后台，不 await
        const active = activeCodeBuddySession(store);
        return {
          ok: true,
          mode: authenticationMode(webCtx.settings.get(NS), region.provider),
          authenticated: (await webCtx.credentials.describe(sessionRef)).configured,
          // 多账号：列表 + 当前激活账号（旧版客户端会忽略这两个新字段，互不影响）
          activeAccountId: active?.id ?? null,
          accounts: codeBuddySessionAccounts(store),
        };
      };
      const status = async (_req, res) => {
        json(res, 200, await currentState());
      };
      const apiKey = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面切换认证方式" });
        await setMode(webCtx.settings, "api-key", region);
        json(res, 200, await currentState());
      };
      // 切换令牌账号：body.accountId 指定目标账号（缺省 = 保持当前 active），
      // 把它设为 store.activeId 并同步旧单账号兼容指针。
      const token = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面切换认证方式" });
        try {
          const body = await requestBody(req);
          const store = await readSessionStore(webCtx.credentials, region);
          const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : store.activeId;
          const active = store.sessions.find((entry) => entry.id === accountId);
          if (!active) return json(res, 409, { ok: false, message: "没有找到该 CodeBuddy 登录账号" });
          await writeSessionStore(webCtx.credentials, region, { ...store, activeId: active.id });
          await setMode(webCtx.settings, "token", region);
          json(res, 200, await currentState());
        } catch (error) {
          json(res, 500, { ok: false, message: error instanceof Error ? error.message : "切换令牌账号失败" });
        }
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
              // upsert：同一账号重复登录只更新令牌，不同账号则追加并自动激活。
              const store = await readSessionStore(webCtx.credentials, region);
              await writeSessionStore(webCtx.credentials, region, upsertCodeBuddySession(store, session));
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
      // 删除令牌账号：body.accountId（缺省 = 当前 active）。删的是 active 时
      // 顺位切到列表里下一个账号；列表清空则同时清掉两代 ref。
      const remove = async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, message: "Method not allowed" });
        if (!localPost(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面管理登录账号" });
        try {
          const body = await requestBody(req);
          const store = await readSessionStore(webCtx.credentials, region);
          const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : store.activeId;
          const sessions = store.sessions.filter((entry) => entry.id !== accountId);
          if (sessions.length === store.sessions.length) return json(res, 404, { ok: false, message: "没有找到该 CodeBuddy 登录账号" });
          const activeId = accountId === store.activeId ? sessions[0]?.id : store.activeId;
          await writeSessionStore(webCtx.credentials, region, { version: 1, activeId, sessions });
          json(res, 200, await currentState());
        } catch (error) {
          json(res, 500, { ok: false, message: error instanceof Error ? error.message : "删除令牌账号失败" });
        }
      };
      const usage = async (req, res) => {
        try {
          const state = await currentState();
          if (!state.authenticated) {
            return json(res, 401, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
          }
          const body = await requestBody(req);
          const session = await resolveUsageSession(region, body.accountId);
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
      // 积分消耗明细：网页「使用明细」同源接口，逐条请求 × 模型 × 客户端 × 积分，
      // 在本侧聚合成 按模型/按日/按客户端。与资源包额度互补：额度是"还剩多少"，
      // 这里是"花在哪了"。
      const usageRequests = async (req, res) => {
        try {
          const state = await currentState();
          if (!state.authenticated) {
            return json(res, 401, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
          }
          const body = await requestBody(req);
          const session = await resolveUsageSession(region, body.accountId);
          const detail = await fetchCodeBuddyRequestUsage(region, session);
          json(res, 200, { ok: true, provider: region.provider, ...detail });
        } catch (error) {
          json(res, 200, {
            ok: false,
            provider: region.provider,
            message: error instanceof Error ? error.message : "积分消耗明细查询失败",
          });
        }
      };
      // hy4-preview 免费档的「用量/限流窗口」探测：与用量查询同会话、同鉴权，
      // 在用量页加载或点「刷新」时调用（探测会发一次最小请求，见 codebuddy-usage.js）。
      const usageHy4 = async (req, res) => {
        try {
          const state = await currentState();
          if (!state.authenticated) {
            return json(res, 401, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
          }
          const body = await requestBody(req);
          const session = await resolveUsageSession(region, body.accountId);
          const status = await probeCodeBuddyHy4(region, session);
          json(res, 200, { ok: true, provider: region.provider, ...status });
        } catch (error) {
          json(res, 200, {
            ok: false,
            provider: region.provider,
            message: error instanceof Error ? error.message : "hy4-preview 用量探测失败",
          });
        }
      };
      // 多模型限流状态探测：body.models 指定要探测的模型列表（缺省 = hy4 系列
      // + DeepSeek V4.1 Flash）。逐个发一次最小请求（max_tokens:1，429 时服务端
      // 直接拒绝不计费），返回每个模型的 可用/限流/重置时间。
      const usageRateLimits = async (req, res) => {
        try {
          const state = await currentState();
          if (!state.authenticated) {
            return json(res, 401, { ok: false, message: "尚未保存 CodeBuddy 登录令牌" });
          }
          const body = await requestBody(req);
          const session = await resolveUsageSession(region, body.accountId);
          const requested = Array.isArray(body.models) ? body.models.filter((m) => typeof m === "string" && m) : [];
          const targets = requested.length > 0 ? requested : RATE_LIMIT_PROBE_MODELS;
          const results = [];
          for (const modelId of targets) {
            try {
              const status = await probeModelRateLimit(region, session, modelId);
              results.push({ ok: true, ...status });
            } catch (error) {
              results.push({
                ok: false,
                model: modelId,
                available: false,
                limited: false,
                message: error instanceof Error ? error.message : "探测失败",
              });
            }
          }
          json(res, 200, {
            ok: true,
            provider: region.provider,
            accountId: body.accountId ?? null,
            results,
            servedAt: new Date().toISOString(),
          });
        } catch (error) {
          json(res, 200, {
            ok: false,
            provider: region.provider,
            message: error instanceof Error ? error.message : "限流状态探测失败",
          });
        }
      };
      // 本地会话用量统计（模型/会话聚合）。数据源是 DSH 会话日志，与登录态无关，
      // 因此不需要鉴权检查；所有区域共用同一份数据，路由挂在两个前缀下等价。
      const usageSessions = async (_req, res) => {
        try {
          // webCtx 是注入代理，未注入的属性不可访问；会话根目录走默认解析
          //（host 进程与 DSH 主进程同一 DSH_HOME env）。
          json(res, 200, { ok: true, ...(await collectSessionUsageAsync(defaultSessionsRoot())) });
        } catch (error) {
          json(res, 200, {
            ok: false,
            message: error instanceof Error ? error.message : "会话用量统计失败",
          });
        }
      };
      registrations.push(
        webCtx.webServer.register({ kind: "exact", path: `${route}/status`, handler: status }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/api-key`, handler: apiKey }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/token`, handler: token }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/login`, handler: login }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/login-status`, handler: loginStatus }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/remove`, handler: remove }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage`, handler: usage }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage/hy4`, handler: usageHy4 }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage/rate-limits`, handler: usageRateLimits }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage/requests`, handler: usageRequests }),
        webCtx.webServer.register({ kind: "exact", path: `${route}/usage/sessions`, handler: usageSessions }),
      );
    }

    webCtx.effect(() => {
      const dispose = [...registrations];
      return () => dispose.forEach((fn) => fn());
    }, "llm-codebuddy: web login routes");
  });
}
