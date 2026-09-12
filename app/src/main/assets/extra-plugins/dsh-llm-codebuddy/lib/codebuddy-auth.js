import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const CODEBUDDY_SESSION_REF = "CODEBUDDY_LOGIN_SESSION";
export const CODEBUDDY_INTL_SESSION_REF = "CODEBUDDY_INTL_LOGIN_SESSION";
// 多账号存储：一个区域一个 store（含 activeId 与 sessions 列表）。
// 旧的单账号 ref 保留为兼容指针（始终指向 active 账号），读侧两种格式都认。
export const CODEBUDDY_SESSIONS_REF = "CODEBUDDY_LOGIN_SESSIONS";
export const CODEBUDDY_INTL_SESSIONS_REF = "CODEBUDDY_INTL_LOGIN_SESSIONS";

// 中国区（copilot.tencent.com）与国际版（www.workbuddy.ai）共享同一套 API 结构与协议，
// 仅后端域名不同。所有区域参数统一收口在这里，供 index / web / cli 共用。
//
// 【国际版域名已切换到 workbuddy.ai】（2026-09-12 抓包 WorkBuddy 桌面版 5.5.2 实证）：
// 官方客户端全部请求（推理/目录/认证/计费）都打 www.workbuddy.ai，并携带
// x-domain: www.workbuddy.ai 头；旧域名 www.codebuddy.ai 仍可用但非官方主路径。
// 域名切换后抓包同款端点（含 billing 的 free/paid-packages 分页明细）全部 code 0。
export const CODEBUDDY_REGIONS = {
  "codebuddy-cn": {
    provider: "codebuddy-cn",
    displayName: "CodeBuddy 中国区",
    apiKeyEnv: "CODEBUDDY_API_KEY",
    sessionRef: CODEBUDDY_SESSION_REF,
    sessionsRef: CODEBUDDY_SESSIONS_REF,
    baseUrl: "https://copilot.tencent.com/v2",
    configUrl: "https://copilot.tencent.com/v3/config",
    authBaseUrl: "https://copilot.tencent.com/v2/plugin",
    // 账单/用量域名：与登录域名（copilot.tencent.com）不同的独立站点，
    // 两者都接受同一枚 accessToken；这里选个人中心所在域名。
    billingBaseUrl: "https://www.codebuddy.cn",
  },
  "codebuddy-intl": {
    provider: "codebuddy-intl",
    displayName: "CodeBuddy 国际版",
    apiKeyEnv: "CODEBUDDY_INTL_API_KEY",
    sessionRef: CODEBUDDY_INTL_SESSION_REF,
    sessionsRef: CODEBUDDY_INTL_SESSIONS_REF,
    baseUrl: "https://www.workbuddy.ai/v2",
    configUrl: "https://www.workbuddy.ai/v3/config",
    authBaseUrl: "https://www.workbuddy.ai/v2/plugin",
    billingBaseUrl: "https://www.workbuddy.ai",
  },
};

const DEFAULT_AUTH_BASE_URL = CODEBUDDY_REGIONS["codebuddy-cn"].authBaseUrl;
const USER_AGENT = "workbuddy-ai/5.5.2 workbuddy-ai/5.5.2 CLI/2.137.1";
export const REQUEST_HEADERS = {
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

function normalizeAccount(account, auth) {
  // 登录接口在不同版本返回过平铺对象与多层包装，全部进候选池取值；
  // 再用 accessToken 的 JWT claims 兜底，保证新登录账号与旧数据的
  // 展示字段（昵称/手机号/邮箱）同样齐全——多账号列表靠它们区分账号。
  const sources = [
    account,
    account?.account,
    account?.user,
    account?.userInfo,
    account?.profile,
    account?.data,
  ].filter((source) => source && typeof source === "object");
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const read = (...keys) => {
    for (const key of keys) {
      for (const source of sources) {
        const value = text(source?.[key]);
        if (value) return value;
      }
    }
    return undefined;
  };
  let claims = {};
  try {
    claims = JSON.parse(Buffer.from((auth?.accessToken ?? "").split(".")[1], "base64url").toString("utf8"));
  } catch {
    claims = {};
  }
  const userId = read("userId", "uid", "user_id", "id") ?? text(claims.userId ?? claims.uid ?? claims.user_id ?? claims.sub);
  const enterpriseId = read("enterpriseId", "tenantId", "enterprise_id", "tenant_id") ?? text(claims.enterpriseId ?? claims.tenantId);
  const email = read("email", "mail", "emailAddress") ?? text(claims.email ?? claims.mail);
  const uin = read("uin", "phoneNumber", "phone", "mobile") ?? text(claims.uin ?? claims.phoneNumber ?? claims.mobile);
  const type = read("type", "accountType", "account_type");
  const displayName = read("displayName", "nickname", "name", "username", "preferred_username") ?? uin ?? email;
  return {
    ...(userId ? { userId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(email ? { email } : {}),
    ...(uin ? { uin } : {}),
    ...(type ? { type } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

// ---- 多账号会话 store ----
// 形状：{ version: 1, activeId, sessions: [{ id, label, createdAt, updatedAt, auth, account }] }
// id 稳定派生自账号（user:<userId> 优先），同一账号重复登录只更新不新增。

/** 稳定会话 id。注意哈希取完整 64 位：截短会引入碰撞风险（上游 V-001 同款问题）。 */
export function codeBuddySessionId(session) {
  const account = normalizeAccount(session?.account, session?.auth);
  if (account.userId) return `user:${account.userId}`;
  if (account.email) return `email:${account.email}`;
  if (account.enterpriseId) return `enterprise:${account.enterpriseId}`;
  const refreshToken = session?.auth?.refreshToken ?? session?.auth?.accessToken;
  if (!refreshToken) throw new Error("CodeBuddy 登录会话缺少账号标识和令牌");
  return `token:${createHash("sha256").update(refreshToken).digest("hex")}`;
}

export function codeBuddySessionLabel(session) {
  const account = normalizeAccount(session?.account, session?.auth);
  return account.displayName ?? account.email ?? account.uin ?? account.userId ?? account.enterpriseId ?? `账号 ${codeBuddySessionId(session).slice(-8)}`;
}

export function normalizeCodeBuddySessionEntry(session, now = Date.now()) {
  const normalized = {
    auth: calculateExpiresAt(session?.auth),
    account: normalizeAccount(session?.account, session?.auth),
  };
  if (!normalized.auth.accessToken || !normalized.auth.refreshToken) throw new Error("CodeBuddy 登录会话无效");
  const id = typeof session?.id === "string" && session.id.trim() ? session.id : codeBuddySessionId(normalized);
  return {
    id,
    label: typeof session?.label === "string" && session.label.trim() ? session.label : codeBuddySessionLabel(normalized),
    createdAt: Number.isFinite(session?.createdAt) ? session.createdAt : now,
    updatedAt: Number.isFinite(session?.updatedAt) ? session.updatedAt : now,
    ...normalized,
  };
}

/** 由任意输入（数组/旧单账号/坏值）构造合法 store；空列表返回 {activeId: undefined}。 */
export function createCodeBuddySessionStore(entries = [], activeId) {
  const sessions = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const normalized = normalizeCodeBuddySessionEntry(entry);
      if (!sessions.some((item) => item.id === normalized.id)) sessions.push(normalized);
    } catch {
      /* 单条损坏跳过，不拖垮整个 store */
    }
  }
  const selected = typeof activeId === "string" && sessions.some((entry) => entry.id === activeId) ? activeId : sessions[0]?.id;
  return { version: 1, activeId: selected, sessions };
}

/** upsert：同 id 更新（保留 createdAt），否则追加；新/更新的账号自动成为 active。 */
export function upsertCodeBuddySession(store, session, now = Date.now()) {
  const current = createCodeBuddySessionStore(store?.sessions ?? [], store?.activeId);
  const incoming = normalizeCodeBuddySessionEntry({ ...session, updatedAt: now }, now);
  const index = current.sessions.findIndex((entry) => entry.id === incoming.id);
  if (index >= 0) incoming.createdAt = current.sessions[index].createdAt;
  const sessions = index >= 0
    ? current.sessions.map((entry, position) => (position === index ? incoming : entry))
    : [...current.sessions, incoming];
  return { version: 1, activeId: incoming.id, sessions };
}

export function activeCodeBuddySession(store) {
  return store?.sessions?.find((entry) => entry.id === store.activeId) ?? store?.sessions?.[0];
}

export function codeBuddySessionAccounts(store) {
  return (store?.sessions ?? []).map(({ id, label, account, createdAt, updatedAt }) => ({
    id,
    label,
    accountName: label,
    userId: account?.userId ?? null,
    account,
    createdAt,
    updatedAt,
  }));
}

/**
 * 账号标签是否需要回填：label 目前是 id 派生的兜底值（UUID/哈希）而非真人可读名。
 * 用于给"登录时没拿到昵称"的历史账号做一次性补全。
 */
export function codeBuddySessionNeedsLabel(session) {
  const account = session?.account ?? {};
  const label = session?.label;
  // 1) label 缺失 → 需要
  if (typeof label !== "string" || !label) return true;
  // 2) label 还是"机器值"（id / userId / 兜底的"账号 xxxx"）→ 需要
  if (label === session?.id || label === account.userId || label.startsWith("账号 ")) return true;
  // 3) label 与"按当前 account 能算出的最佳名字"不一致 → 需要重算。
  //    这一条覆盖真实场景：账号首次入库时 account 只有 userId（label 被算成
  //    UUID），之后凭据里的 account 补上了 email/displayName，但 label 不会
  //    自动跟着变——只检查"account 有没有名字"会漏掉它，导致列表一直显示 UUID。
  const preferred = account.displayName ?? account.nickname ?? account.email ?? account.uin;
  return typeof preferred === "string" && preferred.length > 0 && preferred !== label;
}

/**
 * 本地重算标签（不发网络请求）：account 里已经有可读名字（displayName/nickname/
 * email/uin）时，直接把 label 刷成它。
 *
 * 覆盖真实场景：账号首次入库时 account 只有 userId，label 被算成 UUID；
 * 之后 account 补上了 email（凭据服务里的值更全），label 却不会自动更新。
 * 这类账号不需要联网——官方档案接口只为"account 里确实没名字"的账号服务。
 */
export function relabelCodeBuddySessions(store) {
  let next = store;
  for (const entry of store?.sessions ?? []) {
    const account = entry.account ?? {};
    const preferred = account.displayName ?? account.nickname ?? account.email ?? account.uin;
    if (typeof preferred !== "string" || !preferred || preferred === entry.label) continue;
    next = upsertCodeBuddySession(next, { ...entry, label: preferred, account });
  }
  return next;
}

/** 用官方账号档案回填 store 里所有缺昵称的账号（返回新 store；失败保持原样）。 */
export async function backfillCodeBuddySessionLabels(store, fetchProfile) {
  // 先本地重算（零成本），剩下的才是真正需要联网取档案的账号。
  const local = relabelCodeBuddySessions(store);
  const targets = (local?.sessions ?? []).filter((entry) => codeBuddySessionNeedsLabel(entry));
  if (targets.length === 0) return local;
  let next = local;
  for (const entry of targets) {
    try {
      const profile = await fetchProfile(entry);
      if (!profile) continue;
      // 关键：label 必须置空再 upsert。normalizeCodeBuddySessionEntry 见到"已有
      // label"就会原样保留，于是旧的 UUID 兜底值永远刷不掉，昵称补不进来。
      next = upsertCodeBuddySession(next, {
        ...entry,
        label: undefined,
        account: { ...entry.account, ...profile },
      });
    } catch {
      /* 单个账号补全失败不影响其它账号 */
    }
  }
  return next;
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
  // 用官方账号接口补全昵称等展示字段（/login/account 常常只回 uid）。
  const enriched = await enrichAccountWithProfile(auth, account, signal, baseUrl);
  return { auth, account: normalizeAccount(enriched, auth) };
}

/**
 * 用 /v2/plugin/accounts 的账号档案补全展示字段。
 *
 * 登录接口（/login/account）在部分区域只返回 uid，导致多账号列表只能显示
 * UUID 前缀；官方客户端用的 /v2/plugin/accounts 会给出 nickname/uin/type
 * （2026-09-12 抓包实证：{uid, nickname, uin, type, lastLogin, ...}）。
 * 拉取失败不影响登录（返回原账号，label 兜底链照旧）。
 */
export async function enrichAccountWithProfile(auth, account, signal, baseUrl = DEFAULT_AUTH_BASE_URL) {
  const userId = account?.userId ?? account?.uid;
  // 必须自带超时：本函数挂在 /status 路由上（回填历史账号昵称），而 request()
  // 自身没有超时控制；端点不响应时（中国区没有这个接口）会把整个 status 请求
  // 拖死（实测 HTTP 000、挂 20s+ 无响应）。
  const timeout = AbortSignal.timeout(8000);
  try {
    // 注意：baseUrl 已是 ".../v2/plugin"，request 会直接拼接 path，
    // 所以这里只能写 "/accounts"（写全 "/v2/plugin/accounts" 会变成双前缀 404）。
    const data = await request("/accounts", {
      headers: { ...REQUEST_HEADERS, ...enterpriseHeaders({ auth }), authorization: `Bearer ${auth.accessToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, "获取 CodeBuddy 账号档案", baseUrl);
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const match = accounts.find((entry) => entry?.uid === userId) ?? accounts.find((entry) => entry?.lastLogin === true);
    if (!match) return account;
    // 官方接口用 uid 字段；normalizeAccount 统一读 userId，这里显式桥接。
    return { ...account, ...match, userId: match.uid ?? userId, nickname: match.nickname ?? account?.nickname };
  } catch {
    return account;
  }
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
  return JSON.stringify({ auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account, session.auth) });
}

export function serializeCodeBuddySessions(store) {
  const normalized = createCodeBuddySessionStore(store?.sessions ?? [], store?.activeId);
  if (normalized.sessions.length === 0) throw new Error("CodeBuddy 登录账号列表为空");
  return JSON.stringify(normalized);
}

export function parseCodeBuddySession(value) {
  let session;
  try {
    session = JSON.parse(value);
  } catch (error) {
    throw new Error("CodeBuddy 登录凭据已损坏，请重新登录", { cause: error });
  }
  if (!session?.auth?.accessToken || !session?.auth?.refreshToken) throw new Error("CodeBuddy 登录凭据不完整，请重新登录");
  return { auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account, session.auth) };
}

/** 兼容两种格式：多账号 store；旧的单账号对象（自动包成单条 store）。 */
export function parseCodeBuddySessions(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("CodeBuddy 登录账号列表已损坏，请重新登录", { cause: error });
  }
  if (Array.isArray(parsed?.sessions)) return createCodeBuddySessionStore(parsed.sessions, parsed.activeId);
  if (parsed?.auth) {
    const session = parseCodeBuddySession(value);
    return createCodeBuddySessionStore([session], codeBuddySessionId(session));
  }
  throw new Error("CodeBuddy 登录账号列表格式无效，请重新登录");
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
