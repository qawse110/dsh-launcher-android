/**
 * Cline 凭据模型与协议纯函数。
 *
 * 本模块**不做任何 IO**：解析、构造、判定全部是纯函数，便于单测锁死。
 * 网络行为在 `src/cline-oauth.ts`（登录）与 `src/cline-auth.ts`（续期）。
 *
 * ## 与既有 provider 的差异（都踩过或差点踩）
 *
 * 1. **访问令牌带 `workos:` 前缀且不可剥**（见 `clineBearerValue`）；
 * 2. **续期字段是驼峰 `refreshToken` + `grantType`**，不是 OAuth 标准的
 *    `refresh_token` / `grant_type`（见 `clineRefreshBody`）；
 * 3. **注册/续期响应套一层 `{success, data}` 信封**，且字段名是
 *    `accessToken`（驼峰）而非 `access_token`（见 `parseClineTokenPayload`）。
 */
/** 从记录里读第一个非空字符串字段。 */
function readString(source, keys) {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
/**
 * 把各种时间形态归一为毫秒时间戳。
 *
 * Cline 的 `expiresAt` 实测是 **ISO 8601 字符串**
 * （源码 `toEpochMs(isoDateTime)` 直接 `Date.parse`，
 * 解析失败会抛 `Invalid expiresAt value`）。但为了对上游格式变更鲁棒，
 * 这里同时接受数字（秒 / 毫秒）。
 */
export function parseClineTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        // 10 位视为秒，13 位视为毫秒
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
/**
 * 解析注册 / 续期响应。
 *
 * 两处响应**同构**（源码 `registerWorkOSTokens` 与 `refreshClineToken` 都过
 * `toClineCredentials`）：
 *
 * ```json
 * { "success": true,
 *   "data": { "accessToken": "workos:eyJ…", "refreshToken": "tmgEeM…",
 *             "expiresAt": "2026-09-25T05:23:47.000Z", "tokenType": "Bearer",
 *             "userInfo": { "clineUserId": "usr-…", "email": "…",
 *                           "firstName": "", "lastName": "" } } }
 * ```
 *
 * ⚠️ **判据是 `success && data.accessToken`**（源码 `requireClineTokenResponse`），
 * 不是裸 `accessToken`。只看裸字段会把失败信封当成成功。
 *
 * ⚠️ 兼容裸响应（无 `data` 信封）：若上游某天直接返回
 * `{accessToken, refreshToken}`，这里仍能解析。
 */
export function parseClineTokenPayload(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { accessToken: '' };
    }
    const envelope = value;
    // 优先取 `data` 信封；没有则把顶层当载荷（兼容裸响应）。
    const inner = typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
        ? envelope.data
        : envelope;
    // ⚠️ 字段名是**驼峰** `accessToken`；同时接受下划线形态以对上游变更鲁棒。
    const accessToken = readString(inner, ['accessToken', 'access_token']) ?? '';
    const refreshToken = readString(inner, ['refreshToken', 'refresh_token']);
    const expiresAt = parseClineTimestamp(inner.expiresAt ?? inner.expires_at ?? inner.expire_time);
    const userInfo = typeof inner.userInfo === 'object' && inner.userInfo !== null && !Array.isArray(inner.userInfo)
        ? inner.userInfo
        : undefined;
    const accountId = userInfo === undefined
        ? readString(inner, ['accountId', 'account_id'])
        : readString(userInfo, ['clineUserId', 'accountId']) ?? readString(inner, ['accountId', 'account_id']);
    const email = userInfo === undefined
        ? readString(inner, ['email'])
        : readString(userInfo, ['email']) ?? readString(inner, ['email']);
    const firstName = userInfo === undefined ? undefined : readString(userInfo, ['firstName']);
    const lastName = userInfo === undefined ? undefined : readString(userInfo, ['lastName']);
    const displayName = [firstName, lastName].filter((part) => part !== undefined).join(' ').trim();
    return {
        accessToken,
        ...refreshToken === undefined ? {} : { refreshToken },
        ...expiresAt === undefined ? {} : { expiresAt },
        ...accountId === undefined ? {} : { accountId },
        ...email === undefined ? {} : { email },
        ...displayName.length === 0 ? {} : { displayName },
    };
}
/**
 * 确保访问令牌带产品前缀。
 *
 * ⚠️ **这是本 provider 最容易踩的坑**：源码 `resolveApiKey` 原样使用存储值，
 * 而 Cline 磁盘上存的就是 `workos:eyJ…`；前缀只在**解码 JWT** 时被剥掉
 * （`decodeJwtPayload(token.replace(/^workos:/, ""))`），
 * **从不出现在请求头构造里**。
 *
 * 实测（同一凭据）：
 * - `Bearer workos:eyJ…` → `/api/v1/users/me` **200**
 * - `Bearer eyJ…`（剥掉前缀）→ **401**
 *   文案 "make sure you're using the latest version of Cline" —— 与真实原因
 *   毫不相干，剥前缀会让人误判成「版本过旧」。
 *
 * 实现为**幂等补齐**而非强制加前缀：服务端确实下发带前缀的值
 * （源码 `toClineCredentials` 直接 `access = responseData.accessToken`，
 * 而官方存储值带前缀），所以正常路径下 `startsWith` 即命中；
 * 补前缀分支是为了对「上游某天改回不带前缀」这一变更保持鲁棒。
 */
export function clineBearerValue(accessToken, product) {
    const token = accessToken.trim();
    if (token.length === 0)
        return '';
    return token.startsWith(product.tokenPrefix) ? token : `${product.tokenPrefix}${token}`;
}
/** 构造凭据（把 token 载荷与产品配置合成持久化形态）。 */
export function buildClineCredential(payload, product, fallback = {}) {
    const accountId = payload.accountId ?? fallback.accountId;
    const email = payload.email ?? fallback.email;
    // 昵称优先用邮箱（唯一且稳定），其次显示名，最后账号 id。
    const nickname = email ?? (payload.displayName !== undefined && payload.displayName.length > 0
        ? payload.displayName
        : accountId);
    return {
        access_token: clineBearerValue(payload.accessToken, product),
        ...payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken },
        ...payload.expiresAt === undefined ? {} : { expire_time: payload.expiresAt },
        ...accountId === undefined ? {} : { account_id: accountId },
        ...email === undefined ? {} : { email },
        ...nickname === undefined ? {} : { nickname },
    };
}
/**
 * 把一次续期结果合并回既有凭据。
 *
 * **保留** `account_id` / `email` / `nickname`：它们不在续期响应里
 * （续期响应带 `userInfo`，但实测字段可能缺省），丢了会让账号卡片
 * 失去展示名与余额查询所需的账号 id。
 */
export function applyClineRefresh(credential, payload, product) {
    const next = {
        ...credential,
        access_token: clineBearerValue(payload.accessToken, product),
    };
    if (payload.refreshToken !== undefined)
        next.refresh_token = payload.refreshToken;
    if (payload.expiresAt !== undefined)
        next.expire_time = payload.expiresAt;
    if (payload.accountId !== undefined)
        next.account_id = payload.accountId;
    if (payload.email !== undefined)
        next.email = payload.email;
    return next;
}
/** 凭据的访问令牌过期时间（毫秒）；未知时 undefined。 */
export function clineCredentialExpiresAtMs(credential) {
    return credential.expire_time;
}
/**
 * 是否可静默续期。
 *
 * 判据是「有 refresh_token」，与过期与否无关 —— 未过期但无 refresh_token
 * 的凭据同样无法续期。
 */
export function isClineRefreshable(credential) {
    return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}
/** 访问令牌是否已过期。无过期时间时保守视为未过期（交给服务端 401 判定）。 */
export function isClineExpired(credential, nowMs = Date.now()) {
    const expiresAt = clineCredentialExpiresAtMs(credential);
    return expiresAt !== undefined && expiresAt <= nowMs;
}
/**
 * 续期请求体。
 *
 * ⚠️ **字段名是驼峰 `refreshToken` 与 `grantType`**，不是 OAuth 标准的
 * `refresh_token` / `grant_type`。源码 `refreshClineToken`：
 *
 * ```js
 * body: JSON.stringify({ refreshToken: current.refresh, grantType: "refresh_token" })
 * ```
 *
 * 两者都是**必填**；写错字段名服务端不会明确报「缺字段」，
 * 而是回一个泛化的认证失败，极难定位。
 */
export function clineRefreshBody(credential) {
    return {
        refreshToken: credential.refresh_token ?? '',
        grantType: 'refresh_token',
    };
}
/**
 * 推理与账号端点的请求头。
 *
 * ⚠️ `Authorization` 用的是**带前缀**的令牌值（见 `clineBearerValue`），
 * 且必须叠加产品的客户端标识头。
 */
export function clineHeaders(credential, product, extra = {}) {
    const bearer = clineBearerValue(credential.access_token, product);
    return {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        ...product.clientHeaders,
        ...extra,
    };
}
/**
 * 仅凭「原始令牌字符串」构造鉴权头。
 *
 * 供余额查询等**只拿到凭据 JSON 里某一字段**的场景复用；与
 * {@link clineHeaders} 同源（都经 `clineBearerValue`），避免两处漂移。
 */
export function clineAuthHeaders(accessToken, product, extra = {}) {
    return {
        Authorization: `Bearer ${clineBearerValue(accessToken, product)}`,
        Accept: 'application/json',
        ...product.clientHeaders,
        ...extra,
    };
}
//# sourceMappingURL=cline.js.map