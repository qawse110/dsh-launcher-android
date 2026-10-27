/**
 * MiniMax Code 的 OAuth **设备码 + PKCE** 登录流程。
 *
 * ## 为什么用设备码而不是本地回调
 *
 * 官方桌面端就是这么登的（asar `@mavis/oauth-core`），我们复刻它：
 * 申请设备码 → 用户在浏览器完成授权 → 我们轮询换 token。
 * **不起本地监听端口**（与 Qoder 同型，与 buddy/lobsterai 不同）。
 *
 * ## ⚠️ 最容易踩的坑：`pending` 是 **HTTP 200**
 *
 * OAuth 标准的设备码轮询用 **400 + `error=authorization_pending`** 表示「还在等」，
 * 而 MiniMax 的账号服务用 **200 + `status=pending`**。
 * 只认标准形态会**立刻抛错**，用户来不及授权。
 * 故**两种形态都必须认**（asar `oauth-client.js:70-114` 也是分开处理的）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { MINIMAX, MINIMAX_DEVICE_AUTHORIZE_PATH, MINIMAX_DEVICE_CODE_PATH, MINIMAX_OAUTH_TIMEOUT_MS, MINIMAX_TOKEN_PATH, } from './minimax-product.js';
import { decodeJwtExpMs, decodeJwtSub, } from './minimax.js';
import { refreshFailureFromResponse } from './refresh-failure.js';
/** 用户拒绝授权。 */
export class MinimaxLoginCancelledError extends Error {
    constructor(message = '用户取消了 MiniMax 授权') {
        super(message);
        this.name = 'MinimaxLoginCancelledError';
    }
}
/** 设备码过期。 */
export class MinimaxLoginExpiredError extends Error {
    constructor(message = 'MiniMax 设备码已过期，请重新登录') {
        super(message);
        this.name = 'MinimaxLoginExpiredError';
    }
}
/** 读非空字符串。 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/** 读正数。 */
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/** 构造设备码请求体（PKCE S256）。 */
export function buildMinimaxDeviceCodeBody(codeChallenge, product = MINIMAX) {
    return new URLSearchParams({
        client_id: product.clientId,
        scope: product.scope,
        audience: product.audience,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });
}
/** 构造轮询请求体。 */
export function buildMinimaxPollBody(auth, product = MINIMAX) {
    return new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.deviceCode,
        client_id: product.clientId,
        code_verifier: auth.codeVerifier,
    });
}
/** 构造续期请求体。 */
export function buildMinimaxRefreshBody(refreshToken, product = MINIMAX) {
    return new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: product.clientId,
        scope: product.scope,
        audience: product.audience,
    });
}
/** 解析设备码响应；形状不对返回 undefined。 */
export function parseMinimaxDeviceAuthorization(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        return undefined;
    const record = payload;
    const deviceCode = nonEmptyString(record.device_code);
    const userCode = nonEmptyString(record.user_code);
    const verificationUri = nonEmptyString(record.verification_uri)
        ?? nonEmptyString(record.verification_url);
    const expiresInSec = positiveNumber(record.expires_in);
    if (deviceCode === undefined || userCode === undefined
        || verificationUri === undefined || expiresInSec === undefined) {
        return undefined;
    }
    // ⚠️ interval 单位是**秒**；缺省 5 秒（照 asar 的默认值）
    const intervalSec = positiveNumber(record.interval) ?? 5;
    return {
        deviceCode,
        codeVerifier: '',
        userCode,
        verificationUri,
        verificationUriComplete: nonEmptyString(record.verification_uri_complete) ?? verificationUri,
        expiresInSec,
        intervalSec,
    };
}
/**
 * 解析令牌响应（轮询与续期共用）。
 *
 * 硬校验（照 asar `parseTokenGrant`，不满足即抛）：
 * - `access_token` 非空
 * - `refresh_token` 非空（缺失时回退上一个）
 * - `token_type.toLowerCase() === 'bearer'`
 * - `expires_in` 是正数
 * - **`scope` 必须含产品声明的 scope**（默认 `agent.default`）
 */
export function parseMinimaxTokenGrant(payload, previousRefreshToken, product = MINIMAX) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('MiniMax 令牌响应不是对象');
    }
    const record = payload;
    const accessToken = nonEmptyString(record.access_token);
    const refreshToken = nonEmptyString(record.refresh_token) ?? previousRefreshToken;
    const tokenType = nonEmptyString(record.token_type);
    const expiresInSec = positiveNumber(record.expires_in);
    if (accessToken === undefined)
        throw new Error('MiniMax 令牌响应缺少 access_token');
    if (refreshToken === undefined)
        throw new Error('MiniMax 令牌响应缺少 refresh_token');
    if (tokenType === undefined || tokenType.toLowerCase() !== 'bearer') {
        throw new Error('MiniMax 令牌响应的 token_type 不是 Bearer');
    }
    if (expiresInSec === undefined)
        throw new Error('MiniMax 令牌响应缺少 expires_in');
    const rawScope = record.scope;
    const scope = typeof rawScope === 'string' ? rawScope : '';
    // ⚠️ 客户端权威实现要求 scope 含 agent.default；不含即视为无效凭据
    if (!scope.split(/\s+/u).filter(Boolean).includes(product.scope)) {
        throw new Error(`MiniMax 令牌响应的 scope 不含 ${product.scope}`);
    }
    // ⚠️ **过期时间以 `expires_in` 为准，不能指望从 token 里解** ——
    // 实测 access_token **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点）。
    // 若这里改成「优先解 JWT」并在解不出时**不写** `expires_at`，
    // 过期时间会彻底丢失、账号永远显示「未知」。
    const expiresAt = Date.now() + expiresInSec * 1000;
    // JWT 路径仅作兜底兼容（上游将来改发 JWT 时用），当前恒不命中。
    const fromJwt = decodeJwtExpMs(accessToken);
    const accountId = decodeJwtSub(accessToken);
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_at: String(fromJwt ?? expiresAt),
        scope,
        ...accountId === undefined ? {} : { account_id: accountId },
    };
}
/** 生成 PKCE code_verifier / code_challenge。 */
export function createMinimaxPkce() {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    return { codeVerifier, codeChallenge };
}
/** 申请设备码。 */
export async function startMinimaxDeviceAuthorization(fetcher = fetch, product = MINIMAX) {
    const pkce = createMinimaxPkce();
    const response = await fetcher(`${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildMinimaxDeviceCodeBody(pkce.codeChallenge, product),
        signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`MiniMax 设备码申请失败（HTTP ${response.status}）`);
    }
    const parsed = parseMinimaxDeviceAuthorization(await response.json().catch(() => undefined));
    if (parsed === undefined)
        throw new Error('MiniMax 设备码响应无法解析');
    return { ...parsed, codeVerifier: pkce.codeVerifier };
}
/**
 * 轮询直到拿到令牌。
 *
 * ⚠️ **两种「还在等」的形态都要认**（见文件头注释）。
 */
export async function pollMinimaxDeviceToken(auth, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = options.now ?? Date.now;
    const product = options.product ?? MINIMAX;
    const deadline = now() + auth.expiresInSec * 1000;
    let intervalMs = auth.intervalSec * 1000;
    while (now() < deadline) {
        options.signal?.throwIfAborted();
        const response = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: buildMinimaxPollBody(auth, product),
            signal: options.signal ?? AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => undefined);
        const record = typeof body === 'object' && body !== null && !Array.isArray(body)
            ? body
            : {};
        const status = nonEmptyString(record.status);
        const error = nonEmptyString(record.error);
        // ⚠️ 形态一：HTTP 200 + status
        if (response.ok && status === 'pending') {
            await sleep(intervalMs);
            continue;
        }
        if (response.ok && status === 'slow_down') {
            intervalMs += 5000;
            await sleep(intervalMs);
            continue;
        }
        if (response.ok && (status === 'denied' || status === 'access_denied')) {
            throw new MinimaxLoginCancelledError();
        }
        if (response.ok && (status === 'expired' || status === 'expired_token')) {
            throw new MinimaxLoginExpiredError();
        }
        // ⚠️ 形态二：非 200 + error（OAuth 标准形态）
        if (error === 'authorization_pending') {
            await sleep(intervalMs);
            continue;
        }
        if (error === 'slow_down') {
            intervalMs += 5000;
            await sleep(intervalMs);
            continue;
        }
        if (response.ok)
            return parseMinimaxTokenGrant(body, undefined, product);
        throw new Error(`MiniMax 授权失败：${error ?? `HTTP ${response.status}`}`);
    }
    throw new MinimaxLoginExpiredError();
}
/**
 * 续期。
 *
 * ⚠️⚠️ **失败必须抛结构化错误**（2026-10-27 审计修）：
 * 修前是裸 `new Error('MiniMax 续期失败：' + error)` —— 状态码只在文案里，
 * 而上游的终态判据只能靠 message 正则，于是 `503` 报文里出现 `expired`
 * 就把健康账号判死（详见 `refresh-failure.ts` 模块头的三条实测）。
 * 现在用 {@link refreshFailureFromResponse} 把 `status` + OAuth `error` 带出来，
 * 判据读结构化字段而不是捞词。
 *
 * ⚠️ **传输层失败原样上抛**（不包装）：`fetch` 抛的 `TypeError('fetch failed')`
 * 真因在 `cause` 链上（`certificate has expired` 等），包装会丢 cause
 * ⇒ 判据的「先排传输层」那一步失效。`isRefreshTransportFailure` 沿 cause 链读码。
 */
export async function refreshMinimaxCredential(refreshToken, fetcher = fetch, product = MINIMAX) {
    const response = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildMinimaxRefreshBody(refreshToken, product),
        signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
        throw refreshFailureFromResponse('MiniMax 续期失败', response.status, body);
    }
    return parseMinimaxTokenGrant(body, refreshToken, product);
}
/**
 * 把上游 `/oauth2/device/authorize` 的 `login_url` **钉死**成「只允许回到本授权页」，
 * 并解析成绝对 URL。
 *
 * ## 上游给了什么（实测形态，2026-10-24）
 *
 * ```
 * GET /oauth2/device/authorize?user_code=QJNX-CZXV      # 不带 cookie
 * 401 {"error":"login_required",
 *      "login_url":"/unified-login?login_redirect=%2Foauth-authorize%3Fclient_id%3Dmcode-public%26user_code%3DQJNX-CZXV"}
 * ```
 *
 * 即上游**已经**把 `login_redirect` 拼好了。那本函数为什么还要重拼一遍？因为
 * 直接把服务端字符串塞进 `window.open` 等于**信任上游拼一个跳转目标**（开放重定向
 * 的经典面）。这里的判据是**白名单**而不是「看起来像」：
 *
 * 1. `login_url` 必须解析到**本站 origin**（否则返回 `undefined`，调用方退回原授权页）；
 * 2. 路径必须是 `/unified-login`；
 * 3. 其 `login_redirect` 必须是**本站**的 `/oauth-authorize` 且 `user_code` **等于**
 *    我们这次请求的那个 —— 三者齐备才接受；任一不满足就**自己拼**一份干净的。
 *
 * ⚠️ 最终产出的 `login_redirect` 由**本函数**重新编码（`URLSearchParams`），
 * 不拼接上游原文，避免二次编码/注入。
 *
 * @param loginUrl 上游下发的 `login_url`（可能是相对路径）。
 * @param accountHost 站点 origin（`product.accountHost`）。
 * @param expectedUserCode 本次的设备码 `user_code`（必须与回跳目标里的一致）。
 * @returns 绝对 URL；任何一项判据不过都返回 `undefined`（**不抛错**）。
 */
export function resolveMinimaxForcedLoginUrl(loginUrl, accountHost, expectedUserCode) {
    const raw = nonEmptyString(loginUrl);
    if (raw === undefined || expectedUserCode.trim().length === 0)
        return undefined;
    let site;
    try {
        site = new URL(accountHost);
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        parsed = new URL(raw, site);
    }
    catch {
        return undefined;
    }
    // ① 必须同站（`account.minimax.cn` 与 `account.minimax.io` 各自独立）。
    if (parsed.origin !== site.origin)
        return undefined;
    // ② 必须是统一登录页。
    if (parsed.pathname !== '/unified-login')
        return undefined;
    // ③ 回跳目标必须是本站 `/oauth-authorize`、且 user_code 一致。
    const redirect = parsed.searchParams.get('login_redirect');
    if (redirect === null)
        return undefined;
    let back;
    try {
        back = new URL(redirect, site);
    }
    catch {
        return undefined;
    }
    if (back.origin !== site.origin)
        return undefined;
    if (back.pathname !== '/oauth-authorize')
        return undefined;
    if (back.searchParams.get('user_code') !== expectedUserCode.trim())
        return undefined;
    // 用**我们自己的**参数重拼（上游那份只当作「判据已通过」的证据，不搬运原文）。
    const back2 = new URL('/oauth-authorize', site);
    back2.searchParams.set('user_code', expectedUserCode.trim());
    const out = new URL('/unified-login', site);
    out.searchParams.set('login_redirect', `${back2.pathname}${back2.search}`);
    return out.toString();
}
/**
 * 本地兜底拼法：不请求上游，直接合成「统一登录 → 授权页」的链接。
 *
 * ⚠️ 只在 {@link fetchMinimaxForcedLoginUrl} 失败时用。它**不依赖**上游把
 * `login_redirect` 拼对，故比「原样信任服务端字符串」更安全；代价是**少了
 * 上游那一跳的判据**（若将来 login_redirect 的语义变了，这里会静默失效）。
 * ⇒ 两条路径都在 `tests/unit/minimax-forced-login.spec.ts` 里各锁一条。
 */
export function buildMinimaxForcedLoginUrl(accountHost, userCode) {
    const code = userCode.trim();
    if (code.length === 0)
        return undefined;
    let site;
    try {
        site = new URL(accountHost);
    }
    catch {
        return undefined;
    }
    const back = new URL('/oauth-authorize', site);
    back.searchParams.set('user_code', code);
    const out = new URL('/unified-login', site);
    out.searchParams.set('login_redirect', `${back.pathname}${back.search}`);
    return out.toString();
}
/**
 * 向服务端要一次「保证需要登录」的链接（**不触碰任何凭据**）。
 *
 * 请求刻意**不带 `credentials`/cookie**（Node 侧本来也没有 cookie jar），
 * 因此服务端恒回 `401 login_required` + `login_url` —— 这正是上游「切换账号」
 * 按钮背后的那一次请求。
 *
 * ⚠️ **任何失败都返回兜底链接**（`buildMinimaxForcedLoginUrl`），绝不抛错：
 * 拿不到「强制重新登录」不该让整个登录流程失败，退回原授权页即可。
 * 兜底也失败（`accountHost` 非法 / `user_code` 空）时才返回 `undefined`。
 *
 * @param authorization 本次设备码授权（用它的 `userCode` 与站点）。
 * @param fetcher 注入的 fetch（单测用）。
 * @param product 产品配置（决定 `accountHost`）。
 */
export async function fetchMinimaxForcedLoginUrl(authorization, fetcher = fetch, product = MINIMAX) {
    const fallback = buildMinimaxForcedLoginUrl(product.accountHost, authorization.userCode);
    let url;
    try {
        const target = new URL(`${product.accountHost}${MINIMAX_DEVICE_AUTHORIZE_PATH}`);
        target.searchParams.set('user_code', authorization.userCode);
        const response = await fetcher(target.toString(), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => undefined);
        const record = typeof body === 'object' && body !== null && !Array.isArray(body)
            ? body
            : {};
        url = record.login_url;
    }
    catch {
        // 网络/超时/非 JSON：退回本地兜底（判据见该函数注释）。
        return fallback;
    }
    return resolveMinimaxForcedLoginUrl(url, product.accountHost, authorization.userCode)
        ?? fallback;
}
//# sourceMappingURL=minimax-oauth.js.map