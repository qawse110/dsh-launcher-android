import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
/** CodeArts Agent 的 OAuth client_id（即其 URI scheme，来自 product.json）。 */
export const CLIENT_ID = 'codearts-agent';
/** 本地回调路径（对齐真实插件的 AUTH_REDIRECT_URL）。 */
export const REDIRECT_PATH = '/oauth/callback';
/** 华为 STS token 端点（对齐真实插件的 IAM_TOKEN_API）。 */
export const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
/** token 请求超时（与真实插件一致）。 */
export const TOKEN_TIMEOUT_MS = 60_000;
/** OAuth 授权码换取。 */
export const GRANT_AUTHORIZATION_CODE = 'authorization_code';
/** OAuth 刷新令牌换取。 */
export const GRANT_REFRESH_TOKEN = 'refresh_token';
/** 生成 PKCE 配对：verifier 随机 48 字节 base64url，challenge 为 S256。 */
export function generatePkcePair() {
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}
/** 生成 ES256（P-256）DPoP 密钥对，JWK 形式。 */
export async function generateDpopKeyPair() {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true, crv: 'P-256' });
    return {
        privateKeyJwk: (await exportJWK(privateKey)),
        publicKeyJwk: (await exportJWK(publicKey)),
    };
}
/** 用持久化的 DPoP 私钥签发 dpop+jwt JWS（htm=HTTP 方法，htu=完整 URL）。 */
export async function signDpopJws(keyPair, htm, htu) {
    const key = await importJWK(keyPair.privateKeyJwk, 'ES256', { extractable: false });
    const payload = {
        htm,
        htu,
        iat: Math.floor(Date.now() / 1000),
        jti: randomBytes(32).toString('hex'),
    };
    return new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: keyPair.publicKeyJwk })
        .sign(key);
}
/** refresh_token 已失效/被拒绝时抛出的错误；调度器据此停止续期。 */
export class RefreshTokenExpiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RefreshTokenExpiredError';
    }
}
/**
 * 从 JWT 载荷里读 `exp` / `iat`（秒级 → 毫秒）。
 *
 * ⚠️ **不解签名**：这里只用于「本地估算还剩多久」的调度判据，不作任何信任判断；
 * 真正的信任判定由服务端在续期请求时做。若解析失败一律返回 `undefined`，
 * 调用方必须按「读不到」处理（不得 fail-closed 成「已过期」）。
 *
 * ⚠️ 用 `atob` 而非 `Buffer`：本函数必须在**客户端 bundle**（`plugin-src/client`）
 * 之外也可用，而 `atob` 在 Node 22+ 与浏览器里都是全局的，不需要 import。
 */
function readJwtTime(token, claim) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return undefined;
    const payload = parts[1];
    if (payload === undefined || payload.length === 0)
        return undefined;
    try {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.length % 4 === 2 ? `${base64}==`
            : base64.length % 4 === 3 ? `${base64}=`
                : base64;
        const json = decodeURIComponent(atob(padded).split('').map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join(''));
        const value = JSON.parse(json)[claim];
        if (typeof value !== 'number' || !Number.isFinite(value))
            return undefined;
        // ⚠️ 防御：秒级时间戳乘 1000 后不应超过 1e14（远超公元 5138 年）；
        // 若拿到这种值说明载荷不是我们认的形状，按「读不到」处理。
        const ms = value * 1000;
        return Math.abs(ms) > 1e14 ? undefined : ms;
    }
    catch {
        return undefined;
    }
}
/**
 * refresh_token 的到期时刻（毫秒）；读不到返回 `undefined`。
 *
 * ## 为什么需要它（2026-10-18 实测两个账号同时报废的根因）
 *
 * 华为 STS 的 refresh_token JWT 里，`exp` **恒等于「登录时刻 + 30 天」**，
 * **续期不会延长它** —— 解开该账号全部历史凭据的 JWT 逐个核对，09-25 / 10-16×3 /
 * 10-18 五次续期签发的 refresh_token，`exp` 全都收敛到同一个值。
 * 而 access_token 寿命恒为 2 小时。
 *
 * ⇒ 最后一天出现「access 剩 2 小时、refresh 只剩约 50 分钟」的不对称，
 * 而 lead-time 判据原本**只看 access**，会在 refresh 死线之后才放行，
 * 那一轮续期必然失败，账号彻底不可用。
 *
 * 供 `expiry-sync.ts` 的 lead-time 判据补第二条腿（提前续期）使用。
 */
export function refreshTokenExpiresAt(credential) {
    const token = credential.refresh_token;
    if (typeof token !== 'string' || token.length === 0)
        return undefined;
    return readJwtTime(token, 'exp');
}
/** 导出给单测：直接解一个 JWT 的 `exp`/`iat`（毫秒）。 */
export const __readJwtTimeForTest = readJwtTime;
/** 向 STS token 端点发起一次带 DPoP 的 token 请求。 */
export async function requestToken(body, keyPair, fetcher = fetch) {
    const dpop = await signDpopJws(keyPair, 'POST', STS_TOKEN_ENDPOINT);
    let response;
    try {
        response = await fetcher(STS_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                DPoP: dpop,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body).toString(),
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
    }
    catch (error) {
        throw new Error(`CodeArts token request network error: ${String(error)}`);
    }
    let data = null;
    try {
        data = (await response.json());
    }
    catch {
        data = null;
    }
    if (!response.ok || !data?.credentials) {
        const message = `CodeArts token request failed: ${response.status}${data ? ` ${JSON.stringify(data)}` : ''}`;
        // 终态判定：**只认 refresh_token 自己失效的那两种信号**。
        //
        // ⚠️ `InvalidDPoPHeader` 已从这里**移除**（真实缺陷：CodeArts 账号被永久标成
        // 「不可续期」、重启也不自愈）。它说的是「这次 DPoP proof 没通过校验」
        // —— 时钟偏差让 `iat` 落在窗口外、proof 被判定重放、网关抖动，全都是
        // **一次请求层面**的拒绝，跟「refresh_token 还能不能用」无关。
        // 把它当终态的代价是把账号材料完好（refresh_token 还有十几天寿命、
        // code_verifier 与 DPoP 私钥都在）的账号一步标死，用户只能重新登录；
        // 而把它当普通失败的代价只是 10 分钟后再试一次一个 HTTP 请求。
        // 两相对比，这里选择后者。
        const errorCode = String(data?.error_code ?? '');
        if (data?.error === 'invalid_grant'
            || errorCode.includes('ExpiredRefreshToken')) {
            throw new RefreshTokenExpiredError(message);
        }
        throw new Error(message);
    }
    return data;
}
/** 授权码换取（登录回调收到 code 后调用）。 */
export async function exchangeAuthorizationCode(code, codeVerifier, port, keyPair, fetcher = fetch) {
    return requestToken({
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: GRANT_AUTHORIZATION_CODE,
        redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
    }, keyPair, fetcher);
}
/** 刷新令牌换取（静默续期）。 */
export async function exchangeRefreshToken(refreshToken, codeVerifier, keyPair, fetcher = fetch) {
    return requestToken({
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
        grant_type: GRANT_REFRESH_TOKEN,
        refresh_token: refreshToken,
    }, keyPair, fetcher);
}
/** 将 token 响应组装为持久化凭据 JSON（含刷新所需字段）。 */
export function credentialFromTokenResponse(token, pkce, keyPair) {
    const credentials = token.credentials ?? {};
    return {
        access_key_id: credentials.access_key_id ?? '',
        secret_access_key: credentials.secret_access_key ?? '',
        security_token: credentials.security_token ?? '',
        expires_at: credentials.expiration ?? '',
        refresh_token: token.refresh_token,
        code_verifier: pkce.codeVerifier,
        dpop_private_key_jwk: keyPair.privateKeyJwk,
    };
}
/** 从持久化的私钥 JWK 恢复 DPoP 密钥对（公钥可从私钥 JWK 的 x/y 字段重建）。 */
export function keyPairFromStoredJwk(jwk) {
    return {
        privateKeyJwk: jwk,
        publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    };
}
//# sourceMappingURL=oauth.js.map