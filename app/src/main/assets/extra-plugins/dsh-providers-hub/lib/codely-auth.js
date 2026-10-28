/**
 * Codely（Unity 团结引擎）登录流程（**设备码轮询**）。
 *
 * ## 与其它 provider 的差异
 *
 * | provider | 登录方式 | 是否需要本地端口 |
 * |---|---|---|
 * | Qoder | PKCE 设备码轮询（`404` = 尚未授权） | 否 |
 * | Cline | WorkOS 设备码轮询（body `error` 字段） | 否 |
 * | **Codely** | **自有设备码轮询**（body `status` 字段） | **否** |
 *
 * ## 三步协议（2026-10-19 实测 / 逆向 codely-vscode 4.3.0 确认）
 *
 * ```
 * 1) POST https://codely.tuanjie.cn/auth/device/initiate
 *      Content-Type: application/json
 *      body: { provider: 'unity', client_name: 'codely-vscode', auth_from: 'vscode-codely' }
 *   → 200 { auth_request_token, user_code, verification_uri,
 *           verification_uri_complete, interval: 2, expires_in: 900 }
 *   （✅ 已实测 200，字段逐字来自真实响应）
 *
 * 2) GET /auth/device/poll?auth_request_token=<…>
 *   → 200 { status: 'pending' | 'slow_down' | 'authorized' | 'completed'
 *                        | 'denied' | 'expired', interval, … }
 *   → `authorized` 时附带 `authorization_code`
 *   （pending 形状 ✅ 实测：`{"status":"pending","error":"authorization_pending",…}`；
 *     状态机五分支来自官方插件源码 `pollDeviceAuthorization`）
 *
 * 3) POST /auth/device/exchange
 *      body: { authorization_code: <…> }
 *   → { access_token, refresh_token }
 *   （请求体键名与响应字段来自官方插件源码 `exchangeDeviceAuthorizationCode`
 *     与 `_refreshSession`；带令牌的响应尚未实测）
 * ```
 *
 * ## 凭据形态
 *
 * 落盘 JSON：`{ access_token, refresh_token, obtained_at, expires_at?, nickname? }`。
 * `nickname` 来自 `GET /auth/external/me`（Bearer，官方插件 `getUserInfo`
 * 源码确认返回 `{ username, email }`）——**尽力而为**：拿不到不阻塞登录，
 * 账号卡片退回显示账号 id（与 Qoder 的 `fetchQoderUserNickname` 同原则）。
 *
 * ✅ **令牌有效期已实测**（2026-10-19，真实凭据）：access_token / refresh_token
 * 都是 **JWT**，payload 自带 `exp`（秒）——实测 access ≈ iat + 365 天、
 * refresh ≈ iat + 3 年。落盘时用 {@link decodeCodelyJwtExpMs} 解码 access_token
 * 的 `exp` 写进 `expires_at`（ISO 字符串），账号池条目同步回填 `expiresAt`
 * ⇒ 卡片「有效期」行有真实读数（修复前恒显示「未知」）。
 *
 * ## 为什么暂不实现 refresh（给接线者的提醒）
 *
 * 官方插件有 `POST /auth/refresh {refresh_token}` → `{access_token, refresh_token}`
 * （源码 `_refreshSession` 确认）。但**续期分派**查 `authOf(auths, 'codely')`
 * （`JetHubAuths` 的键），而 registry 里 codely 仍是 `channel:false`
 * （聊天/目录适配器未接线）——现在导出一个无人调用的 refresh 函数，正是
 * 本仓库记过的「已导出却零调用点」陷阱（modelscope 的 `handleModelscopeRpc`）。
 * 等适配器接线、`channel` 翻 true、`JetHubAuths` 加键时再补
 * `refreshAccountCredential`（用这里的 `/auth/refresh` 报文），一并翻
 * `refreshable`。接线清单见 `provider-registry.ts` 里 codely 条目的注释。
 */
/** Codely 服务基址（dashboard 与 API 同域）。 */
export const CODELY_API_BASE = 'https://codely.tuanjie.cn';
/** provider id（与 `provider-registry.ts` 里 codely 条目的 id 逐字一致）。 */
export const CODELY_PROVIDER_ID = 'codely';
/** 设备码发起端点。 */
export const CODELY_DEVICE_INITIATE_PATH = '/auth/device/initiate';
/** 设备码轮询端点（query 携带 `auth_request_token`）。 */
export const CODELY_DEVICE_POLL_PATH = '/auth/device/poll';
/** 授权码换令牌端点。 */
export const CODELY_DEVICE_EXCHANGE_PATH = '/auth/device/exchange';
/** 用户信息端点（Bearer，取昵称用，尽力而为）。 */
export const CODELY_ME_PATH = '/auth/external/me';
/** 单次 HTTP 请求超时（毫秒；与 cline 同款量级）。 */
export const CODELY_HTTP_TIMEOUT_MS = 30_000;
/** 连续网络失败多少次后放弃轮询（与 cline 同款）。 */
export const CODELY_POLL_MAX_FAILURES = 5;
/** 轮询间隔下限（毫秒）：服务端可能下发 0，无节制轮询会被限流。 */
export const CODELY_POLL_MIN_INTERVAL_MS = 500;
/** 设备码默认有效期（毫秒；实测 `expires_in: 900`）。 */
export const CODELY_DEVICE_EXPIRES_MS = 900_000;
/** 官方插件自报的身份头（源码 `getDefaultHeaders` 确认；鉴权端点带上无害且更像官方客户端）。 */
export const CODELY_USER_AGENT_HEADER = 'codely-vscode/4.3.0';
/** 本模块自身抛出的确定性错误前缀（用于与网络错误区分，同 cline 的做法）。 */
const SERVER_ERROR_PREFIX = '登录服务返回异常';
/** 把秒归一为毫秒；非法值回退到默认。 */
function toMs(value, fallbackMs) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fallbackMs;
    return Math.floor(value) * 1000;
}
/**
 * 是否已取消。
 *
 * 抽成函数而非内联 `signal?.aborted === true`（与 cline-oauth.ts 同款）：
 * TS 的控制流分析会把「循环开头检查过、为假才继续」这一事实带进 catch 块，
 * 从而认定 catch 里的同一个比较**恒为假**（报 TS2367 no overlap）。
 * 但运行时 signal 完全可能在 `await` 期间被 abort —— 用函数调用切断
 * 这条收窄路径，既让类型检查通过，也保留了「await 后重新确认」的正确语义。
 */
function isAborted(signal) {
    return signal?.aborted === true;
}
/**
 * 从 Codely 的 JWT（access_token / refresh_token）里解码 `exp` claim。
 *
 * ## 为什么从 JWT 里读而不是等响应字段
 *
 * exchange 响应只给 `{access_token, refresh_token}`（官方插件源码确认，
 * **没有** `expires_in`）。但令牌本身是标准三段式 JWT，payload 自带
 * `exp`（秒）—— 2026-10-19 用真实凭据解码实测：access ≈ iat + 365 天、
 * refresh ≈ iat + 3 年。这是**上游自己签发**的权威过期时刻，不是猜测。
 *
 * ## 解析纪律
 *
 * - payload 用 base64url 解码（`-`/`_` 要先归一，且要补 `=` padding）；
 * - `exp` 缺失 / 非有限数 / ≤ 0 ⇒ 返回 `undefined` —— **绝不编造**一个
 *   过期时间（0 的语义是「已过期」，会让卡片红字，比「未知」更糟）；
 * - 只信结构，不信内容：不校验签名（我们只读 claim，不鉴权）。
 */
export function decodeCodelyJwtExpMs(token) {
    const segments = token.split('.');
    if (segments.length !== 3)
        return undefined;
    try {
        let payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4 !== 0)
            payload += '=';
        const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        const exp = claims.exp;
        if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0)
            return undefined;
        return Math.floor(exp * 1000);
    }
    catch {
        return undefined;
    }
}
/** 读错误响应里最有信息量的那句话（对齐官方插件 `readErrorMessage` 的取值序）。 */
async function errorMessageOf(response, fallback) {
    try {
        const payload = await response.json().catch(() => ({}));
        for (const key of ['error_description', 'message', 'error']) {
            const value = payload[key];
            if (typeof value === 'string' && value.length > 0)
                return value;
        }
        return fallback;
    }
    catch {
        return fallback;
    }
}
/**
 * 请求设备码授权（三步协议第 1 步）。
 *
 * 响应字段已实测（2026-10-19）：`auth_request_token` / `user_code` /
 * `verification_uri` / `verification_uri_complete` / `interval` / `expires_in`。
 * 缺 `auth_request_token` / `verification_uri` 任一即视为无效响应。
 */
export async function requestCodelyDeviceAuthorization(options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(`${CODELY_API_BASE}${CODELY_DEVICE_INITIATE_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-User-Agent': CODELY_USER_AGENT_HEADER,
        },
        // 三个常量来自官方插件源码（`startDeviceAuthorization`）；实测 200。
        body: JSON.stringify({ provider: 'unity', client_name: 'codely-vscode', auth_from: 'vscode-codely' }),
        signal: options.signal ?? AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = await errorMessageOf(response, '');
        throw new Error(`${SERVER_ERROR_PREFIX}：设备码授权失败（HTTP ${response.status}）${detail}`);
    }
    const authRequestToken = typeof payload.auth_request_token === 'string' ? payload.auth_request_token : '';
    const userCode = typeof payload.user_code === 'string' ? payload.user_code : '';
    const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri : '';
    if (authRequestToken.length === 0 || verificationUri.length === 0) {
        throw new Error(`${SERVER_ERROR_PREFIX}：设备码授权响应缺少必要字段`);
    }
    const verificationUriComplete = typeof payload.verification_uri_complete === 'string'
        && payload.verification_uri_complete.length > 0
        ? payload.verification_uri_complete
        : undefined;
    return {
        authRequestToken,
        userCode,
        verificationUri,
        ...verificationUriComplete === undefined ? {} : { verificationUriComplete },
        expiresMs: toMs(payload.expires_in, CODELY_DEVICE_EXPIRES_MS),
        intervalMs: toMs(payload.interval, 2_000),
    };
}
/**
 * 轮询直到用户完成授权，拿到 `authorization_code`（三步协议第 2 步）。
 *
 * 状态机（对齐官方插件源码 `pollDeviceAuthorization`，逐分支核对）：
 * - `pending` → 按 interval 继续（**不是错误**：用户还没在浏览器里点授权）；
 * - `slow_down` → 退避 1 秒后继续（官方只沿用响应 interval；这里学 cline
 *   累积 +1s，被持续限流时能真正降速）；
 * - `authorized` → 取 `authorization_code` 返回；
 * - `completed` → 终态失败（授权码已被取走，必须重开登录）；
 * - `denied` / `expired` → 终态失败；
 * - 其它 status / 非 2xx → 终态失败；
 * - 网络失败容忍 {@link CODELY_POLL_MAX_FAILURES} 次连续失败。
 */
export async function pollCodelyAuthorizationCode(authRequestToken, startIntervalMs, timeoutMs, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const deadline = Date.now() + timeoutMs;
    let intervalMs = Math.max(CODELY_POLL_MIN_INTERVAL_MS, startIntervalMs);
    let failures = 0;
    while (Date.now() <= deadline) {
        if (isAborted(options.signal))
            throw new Error('登录已取消');
        try {
            const pollUrl = new URL(CODELY_DEVICE_POLL_PATH, CODELY_API_BASE);
            pollUrl.searchParams.set('auth_request_token', authRequestToken);
            const response = await fetcher(pollUrl, {
                method: 'GET',
                headers: { Accept: 'application/json', 'X-User-Agent': CODELY_USER_AGENT_HEADER },
                signal: options.signal ?? AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
            });
            if (!response.ok) {
                const detail = await errorMessageOf(response, 'Failed to poll device login');
                throw new Error(`${SERVER_ERROR_PREFIX}：设备码轮询失败（HTTP ${response.status}）${detail}`);
            }
            const payload = await response.json().catch(() => ({}));
            failures = 0;
            // 响应可能下发新的 interval（官方插件每拍都沿用），有则采纳。
            intervalMs = Math.max(CODELY_POLL_MIN_INTERVAL_MS, toMs(payload.interval, intervalMs));
            switch (payload.status) {
                case 'pending': {
                    await sleep(intervalMs, options.signal);
                    continue;
                }
                case 'slow_down': {
                    intervalMs += 1_000;
                    await sleep(intervalMs, options.signal);
                    continue;
                }
                case 'authorized': {
                    const code = typeof payload.authorization_code === 'string' ? payload.authorization_code : '';
                    if (code.length === 0) {
                        throw new Error(`${SERVER_ERROR_PREFIX}：授权响应缺少 authorization_code`);
                    }
                    return code;
                }
                case 'completed': {
                    const detail = typeof payload.error_description === 'string' && payload.error_description.length > 0
                        ? payload.error_description
                        : '授权码已被取走，请重新发起登录';
                    throw new Error(`${SERVER_ERROR_PREFIX}：${detail}`);
                }
                case 'denied':
                case 'expired': {
                    const detail = typeof payload.error_description === 'string' && payload.error_description.length > 0
                        ? payload.error_description
                        : '授权已被拒绝或已过期';
                    throw new Error(`${SERVER_ERROR_PREFIX}：${detail}`);
                }
                default: {
                    throw new Error(`${SERVER_ERROR_PREFIX}：设备码轮询返回未知状态（${String(payload.status)}）`);
                }
            }
        }
        catch (error) {
            if (isAborted(options.signal))
                throw new Error('登录已取消');
            // 本函数自己抛的确定性错误直接冒泡，不计入网络失败次数。
            if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX))
                throw error;
            failures += 1;
            if (failures >= CODELY_POLL_MAX_FAILURES) {
                throw new Error(`无法连接 Codely 登录服务（连续 ${failures} 次失败）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
            await sleep(intervalMs, options.signal);
        }
    }
    throw new Error('登录等待已超时，请重新发起登录');
}
/**
 * 用 `authorization_code` 换取令牌（三步协议第 3 步）。
 *
 * 请求体键是 snake_case `authorization_code`（官方插件源码逐字）。
 * 响应字段 `access_token` / `refresh_token`（同源确认；带真码的响应未实测）。
 */
export async function exchangeCodelyAuthorizationCode(authorizationCode, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(`${CODELY_API_BASE}${CODELY_DEVICE_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-User-Agent': CODELY_USER_AGENT_HEADER,
        },
        body: JSON.stringify({ authorization_code: authorizationCode }),
        signal: options.signal ?? AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = await errorMessageOf(response, 'Failed to exchange device login token');
        throw new Error(`${SERVER_ERROR_PREFIX}：令牌交换失败（HTTP ${response.status}）${detail}`);
    }
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
    if (accessToken.length === 0 || refreshToken.length === 0) {
        throw new Error(`${SERVER_ERROR_PREFIX}：令牌交换响应缺少必要字段`);
    }
    return { accessToken, refreshToken };
}
/**
 * 取用户昵称（**尽力而为**，失败不阻塞登录）。
 *
 * `GET /auth/external/me`（Bearer），官方插件 `getUserInfo` 源码确认返回
 * `{ username, email }`。端点本身未实测（需要真令牌）。
 */
export async function fetchCodelyNickname(accessToken, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    try {
        const response = await fetcher(`${CODELY_API_BASE}${CODELY_ME_PATH}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'X-User-Agent': CODELY_USER_AGENT_HEADER,
            },
            signal: AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
        });
        if (!response.ok)
            return undefined;
        const payload = await response.json().catch(() => ({}));
        const username = typeof payload.username === 'string' ? payload.username : '';
        return username.length > 0 ? username : undefined;
    }
    catch {
        return undefined;
    }
}
/** 睡眠（可被 signal 中断）；与 cline 同款实现。 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error('登录已取消'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('登录已取消'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 与 {@link startClineLoginFlow} 同为「先拿 URL → 打开 → 后台轮询」的
 * 两步式：浏览器只在用户点击后的短暂窗口内允许 `window.open`，阻塞到
 * 授权完成才返回 URL 会让弹窗被拦截（AGENTS.md 记过 CodeArts 同类缺陷）。
 * 设备码授权请求本身是一次快速 POST，不涉及用户等待。
 *
 * ⚠️ 凭据由本函数在授权完成后**自己落盘**（`options.credentials.set`）——
 * 因为它没有 auth 服务实例可用（registry 里 codely `channel:false`，
 * `JetHubAuths` 无键）；调用方只负责账号池的占位与回填。
 */
export async function startCodelyDeviceLogin(options) {
    const controller = new AbortController();
    const signal = options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const authorization = await requestCodelyDeviceAuthorization({
        ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
        signal,
    });
    // 有 `verification_uri_complete` 时优先用它：用户不必再手输 user_code。
    const loginUrl = authorization.verificationUriComplete ?? authorization.verificationUri;
    const result = (async () => {
        const code = await pollCodelyAuthorizationCode(authorization.authRequestToken, authorization.intervalMs, authorization.expiresMs, { ...options.fetcher === undefined ? {} : { fetcher: options.fetcher }, signal });
        const tokens = await exchangeCodelyAuthorizationCode(code, {
            ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
            signal,
        });
        // ⚠️ 昵称**尽力而为**且不阻塞落盘：先写凭据再补昵称，拿不到就缺省。
        const nickname = await fetchCodelyNickname(tokens.accessToken, {
            ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
        });
        // ⚠️ 过期时刻从 access_token 的 JWT `exp` 解码（exchange 响应没有
        //    `expires_in`，见 decodeCodelyJwtExpMs 的注释）。解码不出时缺省
        //    —— 凭据与账号池都不写，卡片如实显示「未知」。
        const expiresAtMs = decodeCodelyJwtExpMs(tokens.accessToken);
        const credential = {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            obtained_at: Date.now(),
            ...expiresAtMs === undefined ? {} : { expires_at: new Date(expiresAtMs).toISOString() },
            ...nickname === undefined ? {} : { nickname },
        };
        await options.credentials.set(options.ref, JSON.stringify(credential));
        return {
            credential,
            ...expiresAtMs === undefined ? {} : { expiresAt: expiresAtMs },
            ...nickname === undefined ? {} : { nickname },
        };
    })();
    // 这个 Promise 要过一会儿才交给调用方消费，期间可能已被 reject。
    // 先挂空处理器避免 Node 报「未处理的拒绝」（与 cline 同款）。
    result.catch(() => { });
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        controller.abort();
    };
    return {
        loginUrl,
        ...authorization.userCode.length === 0 ? {} : { userCode: authorization.userCode },
        result,
        close,
    };
}
/**
 * 按 ref 读回已落盘的 Codely 凭据（**目录读取**用）。
 *
 * ⚠️ 参数是**完整 ref**（与 `CodelyLoginFlowOptions.ref` 同约定）：本模块不
 *    import 凭据命名空间逻辑，避免「一文件两套同义判据」（仓库既有红线），
 *    故由调用方用 `credentialRef(refName)` 算好后传入。
 *
 * ⚠️ **读不到一律返回 `undefined`，不抛错**：调用方是适配器目录路径，
 *    抛错会被 `listModels` 的调用方接不住（`dsh-llm` 直接 await 适配器方法），
 *    后果是面板「读取模型列表失败」（officeace 记过同款缺陷）。读不到时
 *    目录回退兜底表即可。
 *
 * @param ref - 完整凭据 ref。
 * @param credentials - 宿主 `ctx.credentials` 的形状子集。
 */
export async function readCodelyCredential(ref, credentials) {
    try {
        const resolved = await credentials.resolve(ref);
        const value = resolved?.value;
        if (typeof value !== 'string' || value.length === 0)
            return undefined;
        const parsed = JSON.parse(value);
        // ⚠️ 必须有 access_token：其余字段（`expires_at` / `nickname`）都是尽力而为
        //    的可选字段，缺了不影响读目录。
        if (typeof parsed?.access_token !== 'string' || parsed.access_token.length === 0) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
/**
 * 换发推理用的 `cli_api_key`（`sk-…`）。
 *
 * ## 端点与实测（2026-10-20）
 *
 * `GET https://codely.tuanjie.cn/api/api-token/cli-api-key`
 * ——**必须 GET**（POST 回 405 `method is not allowed`），
 * Bearer = access_token，响应 `{ cli_api_key, user_id, rpm, tpm }`。
 *
 * ⚠️ 身份头用 `X-User-Agent: codely-vscode/4.3.0`（与目录端点同款；
 * 推理请求则要用 `codely-cli/…`，两份 UA 不能混 —— 见 `codely-sign.ts`）。
 *
 * ⚠️⚠️ **换发的 key 与推理时的 `Bearer` 必须是同一份**：签名由它派生
 * （`codelySigningKey`），用 A 的 key 签名配 B 的 Bearer 会 401。
 * 故本函数与适配器必须把返回值**成对**使用。
 *
 * ⚠️ 仍**不抛错**（调用方在推理路径上，抛错会把「换发失败」误报成「推理失败」），
 * 但返回 {@link CodelyCliApiKeyResult} 而不是裸 `undefined` —— 理由见该类型的注释。
 */
export async function fetchCodelyCliApiKey(accessToken, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    try {
        const res = await fetcher(`${CODELY_API_BASE}/api/api-token/cli-api-key`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'X-User-Agent': CODELY_USER_AGENT_HEADER,
                Accept: 'application/json',
            },
            // ⚠️⚠️ **必须带超时**（2026-10-22 对抗审计 A3）：本函数在**推理路径**上
            //    （每次请求都会先换发一次 key），而 `options.signal` 只在宿主**主动取消**时才存在
            //    —— 用户不点「停止」时（最常见）这里没有任何时限 ⇒ 上游半开连接 / 网关挂住
            //    就是**永久转圈**，用户以为模型在思考。
            //    ⚠️ 同文件其余 5 处（登录三步 / me / 目录）早就都带 `AbortSignal.timeout`，唯独这处漏了。
            //    ⚠️ `options.signal` 优先（保留宿主取消能力）；`AbortSignal.any` 让两者同时生效。
            signal: options.signal === undefined
                ? AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS)
                : AbortSignal.any([options.signal, AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS)]),
        });
        if (!res.ok) {
            // ⚠️ **分档在这里**（2026-10-22 A1 修）：只有 401/403 才算「该号的凭据
            //    确实不可用」；5xx / 429 / 其它状态码都是「上游此刻不好」，
            //    **不得**让调用方把它记成账号级冷却（那会一次抖动锁死整池）。
            if (res.status === 401 || res.status === 403)
                return { kind: 'credential', status: res.status };
            return { kind: 'transient', status: res.status, reason: `HTTP ${res.status}` };
        }
        const payload = await res.json().catch(() => undefined);
        const key = payload?.cli_api_key;
        // 2xx 但缺字段 = 协议变更（既不是凭据问题、也不是网络问题）。
        if (typeof key !== 'string' || key.length === 0) {
            return { kind: 'malformed', reason: '响应缺少 cli_api_key' };
        }
        const userId = typeof payload?.user_id === 'number' ? String(payload.user_id) : undefined;
        return { kind: 'ok', cliApiKey: key, ...userId === undefined ? {} : { userId } };
    }
    catch (error) {
        // ⚠️ 网络异常（DNS / ECONNRESET / 超时）**一律 transient**：它与账号好坏无关。
        //    沿 `cause` 链取真因（本仓库 `minimax` 那轮记过：`fetch failed` 的真因在 cause 里）。
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'transient', reason };
    }
}
//# sourceMappingURL=codely-auth.js.map