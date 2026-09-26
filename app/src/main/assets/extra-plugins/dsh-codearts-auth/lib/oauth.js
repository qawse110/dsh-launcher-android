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
        // 终态判定：invalid_grant 或后端错误码明确为 refresh_token 失效/DPoP 非法时，
        // 都视为 refresh_token 已失效（停止调度、refreshable:false、提示重新登录），
        // 避免 error_code 为 InvalidDPoPHeader 时每 10 分钟无限重试。
        const errorCode = String(data?.error_code ?? '');
        if (data?.error === 'invalid_grant'
            || errorCode.includes('ExpiredRefreshToken')
            || errorCode.includes('InvalidDPoPHeader')) {
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