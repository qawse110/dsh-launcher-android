/** 华为云 SDK-HMAC-SHA256 请求签名 extraHeaders */
export async function sha256Hex(data) {
    const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function hmacSha256Hex(key, data) {
    const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer);
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function buildCanonicalRequest(method, uri, query, headers, payloadHash) {
    const signedHeaders = [];
    headers.forEach((_, k) => signedHeaders.push(k));
    signedHeaders.sort();
    const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`);
    return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n');
}
/** 签名一个华为请求；返回需合并到请求中的头映射。 */
export async function signRequestHuawei(ak, sk, securityToken, method, urlStr, body, extraHeaders) {
    const url = new URL(urlStr);
    let uri = url.pathname;
    if (!uri.endsWith('/'))
        uri += '/';
    const query = url.search.slice(1);
    const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const payloadHash = await sha256Hex(body);
    const headers = new Map();
    headers.set('host', url.host);
    headers.set('x-sdk-date', dateStamp);
    headers.set('x-sdk-content-sha256', payloadHash);
    headers.set('x-security-token', securityToken);
    // 额外的签名头（如 glm-5.3-flash 的 maas_type: benefit）：与 Rust 参考实现
    // sign_request_huawei 的 extra_headers 一致，参与 canonical 计算并包含在
    // SignedHeaders 中，需原样随请求发送，否则服务端验签失败。
    if (extraHeaders !== undefined) {
        for (const [key, value] of Object.entries(extraHeaders))
            headers.set(key, value);
    }
    // GET 请求（排队状态轮询）不携带请求体，因此无 content-type。
    if (method.toUpperCase() !== 'GET')
        headers.set('content-type', 'application/json');
    const signedHeaders = [];
    headers.forEach((_, k) => signedHeaders.push(k));
    signedHeaders.sort();
    const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash);
    const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
    const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
    const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign));
    headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`);
    return headers;
}
//# sourceMappingURL=sign.js.map