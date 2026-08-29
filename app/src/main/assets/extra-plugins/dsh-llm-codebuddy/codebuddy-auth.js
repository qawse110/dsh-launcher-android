import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const CODEBUDDY_SESSION_REF = "CODEBUDDY_LOGIN_SESSION";
export const CODEBUDDY_INTL_SESSION_REF = "CODEBUDDY_INTL_LOGIN_SESSION";

// 中国区（copilot.tencent.com）与国际版（www.codebuddy.ai）共享同一套 API 结构与协议，
// 仅后端域名不同。所有区域参数统一收口在这里，供 index / web / cli 共用。
export const CODEBUDDY_REGIONS = {
  "codebuddy-cn": {
    provider: "codebuddy-cn",
    displayName: "CodeBuddy 中国区",
    apiKeyEnv: "CODEBUDDY_API_KEY",
    sessionRef: CODEBUDDY_SESSION_REF,
    baseUrl: "https://copilot.tencent.com/v2",
    configUrl: "https://copilot.tencent.com/v3/config",
    authBaseUrl: "https://copilot.tencent.com/v2/plugin",
  },
  "codebuddy-intl": {
    provider: "codebuddy-intl",
    displayName: "CodeBuddy 国际版",
    apiKeyEnv: "CODEBUDDY_INTL_API_KEY",
    sessionRef: CODEBUDDY_INTL_SESSION_REF,
    baseUrl: "https://www.codebuddy.ai/v2",
    configUrl: "https://www.codebuddy.ai/v3/config",
    authBaseUrl: "https://www.codebuddy.ai/v2/plugin",
  },
};

const DEFAULT_AUTH_BASE_URL = CODEBUDDY_REGIONS["codebuddy-cn"].authBaseUrl;
const USER_AGENT = "CLI/unknown CodeBuddy/2.137.1";
const REQUEST_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  "x-product": "SaaS",
};
const NO_ACCOUNT_HEADERS = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};
const NO_ID_HEADERS = {
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};

function calculateExpiresAt(auth, now = Date.now()) {
  const result = { ...auth };
  if (!result.expiresAt && Number.isFinite(result.expiresIn)) result.expiresAt = now + result.expiresIn * 1000;
  if (!result.refreshExpiresAt && Number.isFinite(result.refreshExpiresIn)) result.refreshExpiresAt = now + result.refreshExpiresIn * 1000;
  return result;
}

async function responseBody(response, action) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${action}返回了无法解析的数据`, { cause: error });
  }
}

async function request(path, options, action, baseUrl = DEFAULT_AUTH_BASE_URL) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    if (options.signal?.aborted) throw new Error(`${action}已取消`, { cause: error });
    throw new Error(`${action}无法连接 CodeBuddy 服务`, { cause: error });
  }
  const body = await responseBody(response, action);
  if (!response.ok || body?.code !== 0) throw new Error(`${action}失败（${body?.message ?? body?.msg ?? response.status}）`);
  return body.data;
}

function enterpriseHeaders(session) {
  const enterpriseId = session.account?.enterpriseId;
  return {
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId, "X-Tenant-Id": enterpriseId } : {}),
    ...(session.auth?.domain ? { "X-Domain": session.auth.domain } : {}),
  };
}

async function poll(path, headers, action, timeoutMs, signal, baseUrl = DEFAULT_AUTH_BASE_URL) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(1000, undefined, { signal });
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, { headers: { ...REQUEST_HEADERS, ...headers }, signal });
    } catch (error) {
      if (signal?.aborted) throw new Error(`${action}已取消`, { cause: error });
      continue;
    }
    const body = await responseBody(response, action);
    if (response.ok && body?.code === 0 && body.data) return body.data;
    if (response.status === 401 || response.status === 403) throw new Error(`${action}失败（${body?.message ?? body?.msg ?? response.status}）`);
  }
  throw new Error(`${action}超时`);
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function normalizeAccount(account) {
  return {
    ...(account?.userId || account?.uid ? { userId: account.userId ?? account.uid } : {}),
    ...(account?.enterpriseId || account?.tenantId ? { enterpriseId: account.enterpriseId ?? account.tenantId } : {}),
  };
}

/** 创建一次网页登录会话：返回 {state, authUrl}。打开浏览器与轮询等待由调用方分离处理，
* WebUI 场景由浏览器端自行打开登录页（服务端进程在 Android 等环境拉不起浏览器）。 */
export async function createCodeBuddyLogin(baseUrl = DEFAULT_AUTH_BASE_URL) {
  const state = await request("/auth/state?platform=CLI", {
    method: "POST",
    headers: { ...REQUEST_HEADERS, ...NO_ACCOUNT_HEADERS },
    body: "{}",
  }, "创建 CodeBuddy 登录会话", baseUrl);
  if (!state?.state || !state?.authUrl) throw new Error("CodeBuddy 登录接口没有返回登录地址");
  return state;
}

/** 拿 createCodeBuddyLogin 返回的 state 轮询等待登录完成，返回完整会话。 */
export async function waitForCodeBuddyLogin(state, signal, baseUrl = DEFAULT_AUTH_BASE_URL) {
  const auth = calculateExpiresAt(await poll(
    `/auth/token?state=${encodeURIComponent(state.state)}`,
    NO_ACCOUNT_HEADERS,
    "等待 CodeBuddy 登录",
    10 * 60_000,
    signal,
    baseUrl,
  ));
  if (!auth.accessToken || !auth.refreshToken) throw new Error("CodeBuddy 登录接口没有返回完整令牌");
  const account = await poll(
    `/login/account?state=${encodeURIComponent(state.state)}`,
    { ...enterpriseHeaders({ auth }), authorization: `Bearer ${auth.accessToken}`, ...NO_ID_HEADERS },
    "获取 CodeBuddy 账号",
    60_000,
    signal,
    baseUrl,
  );
  return { auth, account: normalizeAccount(account) };
}

export async function loginCodeBuddy(onAuthUrl, signal, baseUrl = DEFAULT_AUTH_BASE_URL) {
  const state = await createCodeBuddyLogin(baseUrl);
  try {
    await openBrowser(state.authUrl);
    onAuthUrl?.(state.authUrl, true);
  } catch {
    onAuthUrl?.(state.authUrl, false);
  }
  return waitForCodeBuddyLogin(state, signal, baseUrl);
}

export async function refreshCodeBuddySession(session, signal, baseUrl = DEFAULT_AUTH_BASE_URL) {
  if (!session?.auth?.refreshToken) throw new Error("CodeBuddy 登录会话缺少刷新令牌，请重新登录");
  const auth = await request("/auth/token/refresh", {
    method: "POST",
    headers: {
      ...REQUEST_HEADERS,
      ...enterpriseHeaders(session),
      "X-Refresh-Token": session.auth.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
    },
    body: "{}",
    signal,
  }, "刷新 CodeBuddy 登录令牌", baseUrl);
  const fresh = calculateExpiresAt(auth);
  const merged = { ...session.auth, ...fresh, refreshToken: fresh?.refreshToken ?? session.auth.refreshToken };
  if (!merged.accessToken) throw new Error("CodeBuddy 刷新接口没有返回访问令牌");
  return { auth: merged, account: normalizeAccount(session.account) };
}

export function serializeCodeBuddySession(session) {
  if (!session?.auth?.accessToken || !session?.auth?.refreshToken) throw new Error("CodeBuddy 登录会话无效");
  return JSON.stringify({ auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account) });
}

export function parseCodeBuddySession(value) {
  let session;
  try {
    session = JSON.parse(value);
  } catch (error) {
    throw new Error("CodeBuddy 登录凭据已损坏，请重新登录", { cause: error });
  }
  if (!session?.auth?.accessToken || !session?.auth?.refreshToken) throw new Error("CodeBuddy 登录凭据不完整，请重新登录");
  return { auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account) };
}

export function sessionNeedsRefresh(session, now = Date.now()) {
  const expiresAt = Number(session?.auth?.expiresAt);
  if (Number.isFinite(expiresAt)) return expiresAt <= now + 2 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(session.auth.accessToken.split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 <= now + 2 * 60_000 : true;
  } catch {
    return true;
  }
}

export function sessionCacheDeadline(session, now = Date.now()) {
  const expiresAt = Number(session?.auth?.expiresAt);
  return Number.isFinite(expiresAt)
    ? Math.max(now, Math.min(expiresAt - 2 * 60_000, now + 30 * 60_000))
    : now + 5 * 60_000;
}
