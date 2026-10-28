/**
 * MiniMax Code 协议常量、凭据结构与归一纯函数。
 *
 * ⚠️ **两条来源（远端解析与兜底表）共用的是「输出形状」**（`MinimaxModelEntry`），
 * **不是归一规则** —— 兜底路径由 `fallbackToEntry` 直接搬运人工填好的字面量，
 * **不调用** `normalizeMinimaxModel`。
 * ⇒ 改归一规则时**必须同步核对兜底表**，否则远端失败降级到兜底表时档位与窗口
 * 会不一致（**静默失效**，极难排查）。
 */
import { MINIMAX, } from './minimax-product.js';
/**
 * 从 JWT 解出 `exp`（毫秒）。
 *
 * ⚠️⚠️ **实测：MiniMax 的 `access_token` 不是 JWT**（复审者 2026-09-28 读本机凭据形状：
 * 前缀 `mmoat_`、**60 字符、0 个点**；`refresh_token` 前缀 `mmort_` 同样非 JWT）。
 * 故本函数对真实凭据**恒返回 `undefined`**，`minimaxCredentialExpiresAtMs` 实际
 * **永远**走 `expires_at` 回退。
 *
 * ⇒ **登录/续期时必须写入 `expires_at`**（由 `expires_in` 自算），
 * 否则过期时间彻底丢失、账号永远显示「未知」。
 *
 * 保留本函数仅为兼容上游将来改发 JWT —— **不要**据此省略 `expires_at` 的写入。
 */
export function decodeJwtExpMs(token) {
    const segments = token.split('.');
    if (segments.length !== 3 || segments[1] === undefined)
        return undefined;
    try {
        const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
            // ⚠️ 乘 1000 后仍须有限：`exp` 极大时（如 1e308）会溢出成 `Infinity`，
            // 而 `Infinity` 会被下游当成「永不过期」的有效时刻 —— 宁可返回 undefined
            //（语义为「读不到过期时间」）也不要返回一个假的无限远时刻。
            ? (Number.isFinite(payload.exp * 1000) ? payload.exp * 1000 : undefined)
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 从 JWT 解出 `sub`（账号标识）。 */
export function decodeJwtSub(token) {
    const segments = token.split('.');
    if (segments.length !== 3 || segments[1] === undefined)
        return undefined;
    try {
        const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
        return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 凭据过期时间（毫秒）。
 *
 * ⚠️ **优先 `expires_at`** —— 实测 `access_token` **不是 JWT**（见 `decodeJwtExpMs`），
 * 故 JWT 路径对真实凭据恒不命中。保留 JWT 分支只为兼容上游将来改发 JWT。
 *
 * ⚠️ **单位兼容**：`expires_at` 是**秒**时按秒换算（判据 `> 1e12` 视为毫秒），
 * 与既有 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。
 * 不兼容会让秒级值被当成 1970 年 ⇒ **恒判已过期**、每次使用都触发无谓续期。
 */
export function minimaxCredentialExpiresAtMs(credential) {
    const raw = credential.expires_at;
    if (raw !== undefined) {
        // ⚠️ 只认**纯数字**串：`'1e12'` / `' 123 '` / `'123abc'` 一律视为非法并回退 JWT
        //（`Number(' 123 ')` 会静默变 123，`Number('')` 会变 0 —— 都不能放行）
        if (/^\d+$/.test(raw)) {
            const value = Number(raw);
            // > 1e12 视为毫秒，否则视为秒（既有约定）
            const parsed = value > 1_000_000_000_000 ? value : value * 1000;
            if (Number.isFinite(parsed) && parsed > 0)
                return parsed;
        }
    }
    return decodeJwtExpMs(credential.access_token);
}
/**
 * 凭据是否**已过期**（无过期信息时保守视为未过期）。
 *
 * ⚠️⚠️ **生产代码里已无消费者**（2026-10-27 审计确认）：唯一的调用点
 * （adapter 的请求前预判）已改为 {@link isMinimaxExpiringWithin}，因为
 * 「过期了才续」会让用户的请求撞在**正在死掉**的 token 上（PR 描述的原始缺陷）。
 *
 * 保留它的两个理由，且都**不是**「以后可能用到」：
 *
 * 1. **它是旧判据的对照物**：`tests/unit/minimax-renew-mechanism.spec.ts` 用
 *    「剩余 30s 时旧判据说不用续、新判据说该续」来锁住这次收紧**真的发生了** ——
 *    删掉它，那条断言就失去对照组，退化成「只测新函数」的恒真式。
 * 2. 语义纯粹、无副作用，删掉也不能证明任何东西被简化。
 *
 * ⚠️ 因此：**不要再把它接回请求路径**（那正是 2026-10-27 审计打穿的变异 W3：
 *   把 `isMinimaxExpiringWithin` 换回它，全量测试原本全绿）。
 *   现在由上面第 1 条用例守着。
 */
export function isMinimaxExpired(credential, nowMs = Date.now()) {
    const expiresAt = minimaxCredentialExpiresAtMs(credential);
    return expiresAt !== undefined && nowMs >= expiresAt;
}
/**
 * 凭据剩余有效期是否不足 `minValidityMs`（请求前预判）。
 *
 * 与 {@link isMinimaxExpired} 的差别：过期前一小段窗口也算「该续了」——
 * 让请求路径在 token **临死前**就续掉，而不是等 401 回来再补
 *（官方 `oauth-core` 的 `getAccessToken({minValidityMs})` 同一语义）。
 *
 * ⚠️ **读不到过期时间（`undefined`/NaN）视为「该续」**：与 `shouldRefreshNow`
 *（`src/expiry-sync.ts`）的 fail-open 口径一致；一次成功续期就会写上
 * `expires_at`，不会持续触发。
 *
 * ⚠️⚠️ **但 fail-open 有一个真实代价**（2026-10-27 审计）：adapter 里
 * `await this.options.refresh()` **没有 try/catch** ⇒ 对于「凭据缺 / 非法
 * `expires_at`」的账号，一旦这次续期失败，**上游请求一次都不会发**，
 * 而旧判据（`isMinimaxExpired`）会正常放行、让请求用掉最后那段时间。
 * 生产写入点（`parseMinimaxTokenGrant` / `inheritMinimaxIdentity`）都会写
 * `expires_at`，故正常路径不可达；可达面是「备份导入 / 第三方转换 / 手工编辑」。
 * ⇒ 修法在 **adapter 侧**（续期失败时降级为「用现有凭据继续发」），
 *   不放宽本函数的 fail-open（那会让「读不到死线」变成「永不预判」，
 *   等于回到旧判据）。
 */
export function isMinimaxExpiringWithin(credential, minValidityMs, nowMs = Date.now()) {
    const expiresAt = minimaxCredentialExpiresAtMs(credential);
    if (expiresAt === undefined || !Number.isFinite(expiresAt))
        return true;
    return expiresAt - nowMs <= minValidityMs;
}
/** 凭据是否可续期（必须有 refresh_token）。 */
export function isMinimaxRefreshable(credential) {
    return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}
/**
 * 传输级重试次数（**不含首次**；共发 `1 + N` 次）。
 *
 * ⚠️ 取 2 的依据：2026-10-15 本机实测，环境里的 **HTTPS 检查代理**
 *（企业 / 杀软 / Clash 的 MITM 证书）约 **50%** 概率打断到本家的请求：
 * ```
 * 签到 (signin/status): 成功 5/10 —— 失败全是
 *   fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
 * 目录 (models)       : 成功 10/10
 * ```
 * 失败独立同分布 ⇒ 3 次全败约 12.5%，已足够把用户可见的 `fetch failed` 压得很低；
 * 再加只会拖长真正的失败路径。
 *
 * ⚠️ **修复效果已实测**（同一端点、同一凭据、各 10 次）：
 * 裸 `fetch` **5/10** → 走本函数（插件真实代码路径）**10/10**。
 */
export const MINIMAX_TRANSPORT_RETRIES = 2;
/** 传输级重试的基础退避（指数：base × 2^attempt）。 */
export const MINIMAX_TRANSPORT_RETRY_BASE_MS = 400;
/**
 * 该错误是否为**传输级**（值得原样重发的瞬时故障）。
 *
 * ## ⚠️ 与 `classifyMinimaxFailure` 的分工（不要合并）
 *
 * - 本函数判「**要不要重发**」——只看**没拿到 HTTP 响应**的错误；
 * - `classifyMinimaxFailure` 判「**要不要换号 / 写冷却**」——那要看服务端的
 *   **明确答复**（状态码或报文）。
 *
 * 合并会让「4xx 也重发」（浪费且掩盖真因），或「传输错误被当成额度」（误封账号）。
 *
 * ## ⚠️ 必须沿 `cause` 链找真因
 *
 * undici 把底层错误包成一句 `TypeError: fetch failed`，**真因在 `cause` 里**
 *（本仓库 `docs/agent-notes/providers-opencode.md` 记过这一点）。
 * 只读 `error.message` 会漏掉 `SELF_SIGNED_CERT_IN_CHAIN` / `UND_ERR_SOCKET` 等。
 */
export function isMinimaxTransportError(error) {
    const seen = new Set();
    let current = error;
    for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
        if (seen.has(current))
            break;
        seen.add(current);
        if (typeof current !== 'object')
            break;
        const record = current;
        const name = typeof record.name === 'string' ? record.name : '';
        const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
        const code = typeof record.code === 'string' ? record.code : '';
        // undici 的传输类错误码族。
        if (name.startsWith('UND_ERR_') || code.startsWith('UND_ERR_'))
            return true;
        // TLS / 证书类（本机 HTTPS 检查代理的典型形态）。
        if (code.startsWith('SELF_SIGNED_CERT') || code.startsWith('CERT_')
            || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
            return true;
        // 连接类。
        if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
            || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN')
            return true;
        // undici 把上面这些都包在这一句里。
        if (message.includes('fetch failed'))
            return true;
        if (message.includes('socket hang up') || message.includes('terminated')
            || message.includes('other side closed'))
            return true;
        current = record.cause;
    }
    return false;
}
/** 退避等待（本文件内联一份，避免为一次退避引入跨模块依赖）。 */
export function minimaxRetrySleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
/**
 * 带**传输级重试**地发一次请求。
 *
 * ⚠️ **只重试传输错误，绝不重试 HTTP 状态错误**：4xx / 5xx 是服务端的明确答复
 *（401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因。
 *
 * ⚠️ **abort 绝不重试**：用户点了停止还继续发是**不可接受**的行为。
 *
 * ⚠️ 重试耗尽时抛**最后一次**的错误对象（保住 `cause` 链，真因仍可见）。
 *
 * @param fetchOnce 只负责发一次；判据与退避都在这里，调用方不用管。
 */
export async function minimaxFetchWithRetry(fetchOnce, signal, retries = MINIMAX_TRANSPORT_RETRIES) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fetchOnce();
        }
        catch (error) {
            lastError = error;
            if (signal?.aborted === true)
                throw error;
            if (!isMinimaxTransportError(error))
                throw error;
            if (attempt === retries)
                break;
            await minimaxRetrySleep(MINIMAX_TRANSPORT_RETRY_BASE_MS * 2 ** attempt);
        }
    }
    throw lastError;
}
// ===== 手动跟随重定向（保凭据）=====
/**
 * 重定向跳数上限。
 *
 * 实测本家只有一跳（`.io`/`.chat` 域 → `.minimaxi.com`），留 3 是余量；
 * 再多就说明不是「域名迁移」而是握手/登录页重定向环 —— 那种情况必须停，
 * 否则每轮多打 N 个请求。
 */
export const MINIMAX_REDIRECT_MAX_HOPS = 3;
/**
 * 允许跟随的**主机名后缀**（安全闸门）。
 *
 * ⚠️ **必须显式白名单，不能无条件跟随**：跟随 3xx 等于「把带 `Authorization`
 * 的请求发到服务端指定的任意主机」—— 若上游（或被劫持的 DNS）把
 * `Location` 指向别处，凭据就随之外泄。只放行本家自有域，其余**不跟随、
 * 原样返回 3xx**（由调用方按「非 2xx」处理，绝不静默当成成功）。
 *
 * ⚠️ 用**后缀匹配且必须以 `.` 或整名相等**，不能用 `includes` ——
 * `evil-minimax.io` 会命中 `includes('minimax.io')`。
 */
const MINIMAX_TRUSTED_HOST_SUFFIXES = [
    'minimax.io',
    'minimax.cn',
    'minimaxi.com',
    'xaminim.com',
];
/**
 * 主机名是否等于该域**或**是它的子域（**带边界**的后缀匹配）。
 *
 * ## ⚠️⚠️ 这是「后缀匹配」的**唯一实现处**，不许在别处再抄一份
 *
 * 必须有边界：`evilminimaxi.com` **不能**命中 `minimaxi.com`。
 * 初版把「前缀伪装」漏在两个地方（2026-10-17 红队审计打穿其中一处）：
 * - `isMinimaxTrustedHost` 写了边界 ✅
 * - `isMinimaxGeoRoute` 用裸 `endsWith` ❌ ⇒ `evilminimaxi.com` 被当成中国站
 *
 * ⇒ 抽成纯函数供两处共用（本仓库明列「同义判据分两处必然漂移」）。
 */
export function hasHostSuffix(hostname, suffix) {
    const host = hostname.trim().toLowerCase();
    const bare = suffix.trim().toLowerCase();
    if (host.length === 0 || bare.length === 0)
        return false;
    return host === bare || host.endsWith(`.${bare}`);
}
/**
 * 该主机名是否属于 MiniMax 自有域（跟随即信闸门的唯一判据）。
 *
 * 导出供守卫用例逐条点名（含 `evil-minimax.io` 这类仿冒）。
 */
export function isMinimaxTrustedHost(hostname) {
    return MINIMAX_TRUSTED_HOST_SUFFIXES.some((suffix) => hasHostSuffix(hostname, suffix));
}
/** 该状态码是否属于「应当跟随」的重定向（301/302/303/307/308）。 */
function isFollowableRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/**
 * 跟随重定向，并且在**每一跳重新附上自己的请求头**。
 *
 * ## ⚠️⚠️ 为什么不能依赖 `fetch` 的自动跟随（2026-10-17 真实缺陷，issue IKMEVG）
 *
 * `agent.minimax.io` 现对**所有**路径恒返 `307 → https://agent.minimaxi.com/...`
 *（两个 Akamai 边缘 IP、连打 15 次全部一致；curl 独立复核同结果）。
 * 而按 fetch 规范，**跨 origin 重定向会移除 `Authorization` 头** ——
 * 于是链路变成：
 *
 * ```
 * 带 Bearer 发 → 307 → fetch 自己跟到 minimaxi.com（Authorization 已被剥）→ 400
 * ```
 *
 * 那个 `400 {"error":"invalid signature"}` 与「**完全不发 token**」**同形**
 *（实测对照矩阵印证），所以看起来像「凭据无效 / 授权不成功」，实际是
 * **第二跳没带凭据**。
 *
 * ⚠️ 补 `x-api-key` 不解决问题：实测它虽然**不**被剥（不属于 CORS
 * non-wildcard 头），但 MiniMax 业务端点只认 `Authorization`
 *（仅 x-api-key → 同样 400 invalid signature）。
 *
 * ⇒ 唯一正解是自己跟随，并在**每一跳重新构造头**。实测效果：同一份有效
 * 凭据从 `400` 变 `200`，签到 / 积分 / 推理三个端点全部打通。
 *
 * ⚠️ **307/308 必须保留方法与 body**；301/302/303 按 fetch 规范降级成 GET
 *（本家实测只出现 307，但既然写了跟随就得两种都写对）。
 *
 * ⚠️ abort **绝不继续跟随**：用户点了停止还继续发是不可接受的行为
 *（与 `minimaxFetchWithRetry` 的既有边界同一条）。
 *
 * @param buildInit 每次跳都调用一次，返回**该跳**要用的 init（含头）。
 *   ⚠️ 传函数而不是对象，就是为了保证「重新附头」这件事在结构上做不到漏。
 */
export async function minimaxFetchFollowRedirects(url, buildInit, fetcher = fetch, signal, maxHops = MINIMAX_REDIRECT_MAX_HOPS, 
/**
 * 可选：**跟随之前**观测到「国际站被地理路由」时的回调（issue IKMEVG）。
 *
 * ⚠️ 为什么必须在跟随**之前**观测：一旦跟到中国站，`401 invalid access token`
 * 与「凭据真失效」**逐字同形**（实测），事后无法区分。故这里把「判定的时机」
 * 卡在 307 这一跳上。
 *
 * ⚠️ 回调**只做记录/埋点**，不得改变控制流 —— 跟随照常进行（用户可能设了 XFF
 * 但该 IP 上游不认，此时仍要跟随以拿到真实响应）。
 */
onGeoRoute) {
    let currentUrl = url;
    for (let hop = 0; hop <= maxHops; hop += 1) {
        const init = buildInit(currentUrl);
        // ⚠️ 必须 `redirect: 'manual'`：否则 fetch 会自己跟并剥掉 Authorization，
        //    我们又回到本函数要修的那个缺陷里。
        const response = await fetcher(currentUrl, { ...init, redirect: 'manual' });
        if (!isFollowableRedirect(response.status))
            return response;
        if (signal?.aborted === true)
            return response;
        const location = response.headers.get('location');
        if (location === null || location.length === 0)
            return response;
        // ⚠️ 在**跟随之前**判地理路由（跟随后就分不清了，见参数注释）。
        try {
            if (isMinimaxGeoRoute(new URL(currentUrl).hostname, response.status, location)) {
                onGeoRoute?.();
            }
        }
        catch { /* URL 解析失败不影响主流程 */ }
        let nextUrl;
        try {
            nextUrl = new URL(location, currentUrl);
        }
        catch {
            return response;
        }
        // ⚠️ 不跟不可信主机（见 MINIMAX_TRUSTED_HOST_SUFFIXES 的理由）。
        if (nextUrl.protocol !== 'https:' || !isMinimaxTrustedHost(nextUrl.hostname))
            return response;
        // 跳数用尽：返回最后一个 3xx，让调用方按非 2xx 报错，**绝不**假装成功。
        if (hop === maxHops)
            return response;
        // ⚠️ 丢弃上一跳的响应体（同 fetch 的既有行为，避免连接不释放）。
        await response.body?.cancel().catch(() => undefined);
        currentUrl = nextUrl.toString();
    }
    // 循环结构上不可达（hop === maxHops 时已 return）。
    throw new Error('minimax: redirect follow exhausted');
}
/**
 * 「带传输级重试 + 保凭据跟随重定向」的完整发送入口 —— **三处调用点共用这一份**。
 *
 * ⚠️ **顺序是刻意的**：重试包在**外层**。
 * - 传输错误（本机 HTTPS 检查代理约 50% 打断）在**任何**一跳都可能发生，
 *   所以重试必须罩住整条重定向链，而不是只罩第一跳；
 * - 反过来，把跟随放外层会让「重试到一半换了一台主机」这类状态泄漏到调用方。
 *
 * ⚠️ 合成一个函数（而不是让三个调用点各自组合 `WithRetry` + `FollowRedirects`）
 * 是因为本仓库反复记录的教训：**同义判据分两处必然漂移**。漏掉任一层都是
 * 静默失效（漏跟随 = 400 假象；漏重试 = 偶发 `fetch failed`）。
 */
export async function minimaxFetch(url, buildInit, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    return minimaxFetchWithRetry(() => minimaxFetchFollowRedirects(url, buildInit, fetcher, options.signal, options.maxHops, options.onGeoRoute), options.signal, options.retries);
}
/**
 * 国际站绕过分流用的头名（用户设置值 → 本头）。
 *
 * ⚠️ 抽成常量而不是调用点字面量：**设置侧与请求侧必须是同一个串**，
 * 拼错一处就是「设置保存成功但请求没带上」的静默失效。
 */
export const MINIMAX_XFF_HEADER = 'X-Forwarded-For';
/**
 * 给请求头附上用户设置的 `X-Forwarded-For`（若有）。
 *
 * ## 它绕的是什么（Gitee issue IKMEVG，2026-10-17 实测）
 *
 * `agent.minimax.io` 对**所有**路径恒返 `307 → agent.minimaxi.com`，
 * 而是否 307 **由 Akamai 按请求来源 IP 的国别判定**：
 *
 * | 来源 IP | 结果 |
 * |---|---|
 * | 美国 `8.8.8.8` / `1.1.1.1`、日本、新加坡、香港 | **留在国际站（200）** |
 * | 中国 `114.114.114.114` / `223.5.5.5` / `180.76.76.76` | **307 → 中国站** |
 * | 内网 `127.0.0.1` / `10.0.0.1` / `::1`、空值、非法串 | 视为无此头 ⇒ **307** |
 *
 * ⇒ 中国大陆出口的用户**永远**拿不到国际站数据面，与 token 有效性无关。
 * 附一个**海外** IP 到本头即可让 Akamai 判定为海外来源。
 *
 * ## ⚠️ 三条必须守的纪律
 *
 * 1. **只对国际站生效**：中国站不需要绕过（它本来就在中国），给它附这个头
 *    纯属伪造来源、徒增风险。故本函数只在 `product.id === 'minimaxintl'` 时被调用
 *    （判据在调用点，见 `minimaxHeadersFor`）。
 * 2. **`undefined` / 空串 ⇒ 一个头都不加**（行为与修复前逐字节一致）。
 * 3. **值必须是 IP 字面量**：校验在 `sanitizeMinimaxXff`（store 层）与 RPC 层
 *    双重把关；本函数**信任入参已归一**，但仍做一次 `trim()` 兜底 ——
 *    因为它是最后一个能拦住「带换行的头注入」的地方。
 */
export function withMinimaxXff(headers, xff) {
    if (typeof xff !== 'string')
        return headers;
    // ⚠️ **先按原始串查 CR/LF，再 trim**（顺序反了就漏 —— 与 `sanitizeMinimaxXff`
    //    同一条教训：`'1.2.3.4\r'` 被 trim 后变成合法值，那个 `\r` 就看不出来了）。
    if (/[\r\n]/.test(xff))
        return headers;
    const value = xff.trim();
    if (value.length === 0)
        return headers;
    headers.set(MINIMAX_XFF_HEADER, value);
    return headers;
}
/**
 * 构造业务请求头。
 *
 * ⚠️ MiniMax 的业务端点**只需 Bearer**（实测签到 / 积分 / 目录均如此），
 * 不需要 machine 头或签名（与 Qoder 的 `/sash/` 端点是**不同**情形）。
 */
export function minimaxHeaders(credential) {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${credential.access_token}`);
    headers.set('Accept', 'application/json');
    return headers;
}
/**
 * 业务请求头 + 可选的国际站 `X-Forwarded-For`。
 *
 * ⚠️ 凡是**国际站**的业务请求都必须走本函数（而不是裸 `minimaxHeaders`），
 * 否则「用户设置了 XFF 却不生效」——与 `minimaxHeaders` 并存的同义入口是
 * 本仓库明列的缺陷形态，故本文件只保留这一个带参版本供业务路径调用；
 * `minimaxHeaders` 仅作为它的无参底层（测试与 OAuth 路径仍在用）。
 */
export function minimaxHeadersFor(credential, xff, productId) {
    const headers = minimaxHeaders(credential);
    // ⚠️ **只对国际站生效**（见 `withMinimaxXff` 纪律 1）。
    if (productId !== 'minimaxintl')
        return headers;
    return withMinimaxXff(headers, xff);
}
/**
 * 推理请求的头（**Anthropic Messages** 端点）。
 *
 * ⚠️ **实测不需要 `anthropic-version` 头**（2026-09-29 真实请求：只带
 * `Authorization` + `Content-Type` + `Accept` 即 HTTP 200）。
 * 故**不照抄 Anthropic 官方文档**加那个头 —— 加未经验证的头是猜测。
 *
 * ⚠️ `Accept: text/event-stream`（不是 `application/json`）：
 * 请求体带 `stream: true`，响应是 SSE。
 */
export function minimaxInferHeaders(credential) {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${credential.access_token}`);
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'text/event-stream');
    return headers;
}
/**
 * 推理请求头 + 可选的国际站 `X-Forwarded-For`（理由见 `minimaxHeadersFor`）。
 */
export function minimaxInferHeadersFor(credential, xff, productId) {
    const headers = minimaxInferHeaders(credential);
    if (productId !== 'minimaxintl')
        return headers;
    return withMinimaxXff(headers, xff);
}
/**
 * 该 3xx 是否是**国际站被地理路由**（而不是普通域名迁移）。
 *
 * ## 为什么要单独判它（issue IKMEVG）
 *
 * 一旦跟随过 307，**「国际站账号被导到中国站」与「凭据真失效」完全同形**
 *（都是 `401 {"error":"invalid access token"}`，本机实测逐字一致）⇒ 跟随后
 * 再想区分就**不可能**了。故必须在**跟随之前**看那个 307 的 Location。
 *
 * 判据：`minimax.io` 的响应 307 到 `minimaxi.com`。这就是 Akamai 的
 * 中国 IP 分流规则（海外 IP 不 307，实测见 `withMinimaxXff` 的表）。
 *
 * @param fromHost 请求发起的主机名（`agent.minimax.io`）
 * @param status   HTTP 状态码
 * @param location `Location` 头
 */
export function isMinimaxGeoRoute(fromHost, status, location) {
    if (status !== 307 && status !== 308)
        return false;
    if (location === null || location.length === 0)
        return false;
    /**
     * ⚠️ 起点必须是**数据面主机**（`agent.` 前缀），不能只判 `endsWith('minimax.io')`：
     * `account.minimax.io` 也是那个后缀，而它的 OAuth 重定向与地理分流**无关**
     * —— 把它也算成「地理路由」会让登录失败被误报成「换个网络就好」。
     */
    const from = fromHost.trim().toLowerCase();
    if (!from.startsWith('agent.') || !from.endsWith('minimax.io'))
        return false;
    /**
     * ⚠️⚠️ **目标域必须做边界匹配**（真实缺陷，2026-10-17 红队审计打穿）。
     *
     * 初版写 `target.hostname.endsWith('minimaxi.com')` —— 于是
     * `evilminimaxi.com`、`notminimaxi.com` 都命中 ⇒ 上游一旦回一个
     * 「指向仿冒域」的 307，会被说成「你在国内被分流，换个网络就好」，
     * 把「可能被劫持」误导成「网络位置问题」。
     *
     * ⚠️ 更要紧的是**它与同文件的 `isMinimaxTrustedHost` 是两套同义判据**：
     * 那个函数正确地要求 `host === suffix || host.endsWith('.' + suffix)`。
     * ⇒ 这里**复用同一个后缀判据**（`hasHostSuffix`），不再抄第二份
     *（本仓库明列「同义判据分两处必然漂移」）。
     */
    try {
        const target = new URL(location);
        return hasHostSuffix(target.hostname, 'minimaxi.com');
    }
    catch {
        return false;
    }
}
/**
 * 地理路由的**可操作**提示文案（用户照着这一句就能自救）。
 *
 * ⚠️ 必须同时给出**三条**信息，缺一条用户就卡住：
 * ① 发生了什么（上游按出口 IP 把请求判成了中国区）；
 * ② 怎么自查（先确认自己的出口 IP 到底在哪 —— 否则用户会怀疑是插件坏了）；
 * ③ 两条出路（面板里的 XFF 设置 / 用代理改变出口 IP）。
 *
 * ⚠️⚠️ **文案不能写死"中国大陆"**（真实缺陷，2026-10-17 审计发现）：
 * 判据只是「IP 被判成中国」，而实测**内网 IP（`127.0.0.1` / `10.0.0.1` / `::1`）
 * 与无法解析的 IP 同样 307**。对本机代理/公司内网出口的用户，说「你在国内」
 * 是**事实错误**，会把他引向错误的排查方向。
 * ⇒ 措辞用「被判成中国区」，并在括号里点明「含内网或无法解析的地址」。
 *
 * @param detail 可选的**真实业务错误**原文（如 `insufficient balance`）。
 *   ⚠️⚠️ **必须透传它**（2026-10-17 自查发现的真实缺陷）：
 *   `geoRouted` 只表示「这次请求**经历过** 307」，**不表示失败原因就是地理路由**。
 *   实测反例：`307 → 402 insufficient_balance_error` 时，旧实现把文案整个换成
 *   地理路由说明 ⇒ 用户看到的全是「去填 IP / 走代理」，而**「去充值」这个唯一
 *   有效动作彻底消失**（用户会一直折腾网络，永远不知道账号没钱）。
 *   ⇒ 有业务错误原文时，**它必须出现在文案里**。
 */
export function describeMinimaxGeoRoute(detail) {
    const base = 'MiniMax 国际站按**出口 IP 所在区域**分流：当前出口 IP 被判成中国区'
        + '（内网或无法解析的地址也会被判成中国区），请求已被重定向到中国站 —— '
        + '这不是凭据问题。'
        + '建议先确认本机出口 IP（例如浏览器打开 ifconfig.me），然后二选一：'
        + '① 在 Jet Hub 的「MiniMax Code (国际版)」面板里填写一个海外 IP'
        + '（X-Forwarded-For）；② 用代理把出口 IP 改到海外。';
    const trimmed = typeof detail === 'string' ? detail.trim() : '';
    if (trimmed.length === 0)
        return base;
    // ⚠️ 业务错误放**前面**：它才是用户当下要做的事（例如余额不足要去充值）。
    //    地理路由只是**背景解释**，排在后面。
    const clipped = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    // ⚠️ 不用「（另外，…）」包住 base：base 自己含括号，套起来会难以阅读。
    return `上游还返回了：${clipped}。另外：${base}`;
}
/** 只放行**安全正整数**。 */
function positiveInt(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** 读成非空字符串。 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/** 读成非空字符串数组（去重保序）。 */
function stringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = [];
    const seen = new Set();
    for (const item of value) {
        const text = nonEmptyString(item);
        if (text === undefined || seen.has(text))
            continue;
        seen.add(text);
        out.push(text);
    }
    return out.length > 0 ? out : undefined;
}
/**
 * 把**远端**模型条目归一。
 *
 * 规则参照 asar `official-model-config-sync.js` 的 `parseModel`：
 * - `contextWindow` 取 `context_window_options` **最大档**；无档位表则回退 `limit.context`
 * - `maxTokens` 取 `limit.output`，**只放行安全正整数**（`0`/负数/`NaN` 会让 DSH 抛
 *   `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**）
 * - `supportsImage` = `modalities.input` 含 `'image'`
 * - `effortOptions` 取 `effort_options`（去重保序）
 * - `defaultEffort` 取 `default_effort`，**必须落在 `effortOptions` 内**，否则丢弃
 *
 * ⚠️ **只实现了 snake_case 字段名**（实测远端下发即 snake_case）。asar 的
 * `parseModel` 通过 `aliasValue()` **同时**认 camelCase 别名（实测共 4 组：
 * `context_window_options` ← `contextWindowOptions` / `context_options`；
 * `context_window_option_hints` ← `contextWindowOptionHints` / `context_option_hints`；
 * `effort_options` ← `thinking.effortOptions`；
 * `default_effort` ← `thinking.defaultEffort`），
 * 并带 `≤ 2147483647`（2^31-1）上限校验（`requirePositiveInteger` 超限即抛）——
 * **这些本实现都没有做**。
 *
 * 若哪天远端改下发 camelCase，或下发超过 2^31-1 的值，本函数会**静默取不到值**
 * （窗口退化为 `0` 哨兵 / 回退 `limit.context`），届时需按 asar 补齐。
 */
export function normalizeMinimaxModel(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const record = raw;
    // ⚠️ `id` 与 `name` 是**两个不同字段**：
    // - 远端 `models` 对象的 **key** 是长名（`MiniMax-M3.1-Flash-Preview`），
    //   由 `parseMinimaxModelsPayload` 注入为 `record.id`
    // - 远端条目的 `name` 字段是**短名**（`M3.1-Flash-Preview`），官方 IDE 就显示它
    // 故两者必须分别取，不能合并。
    const id = nonEmptyString(record.id) ?? nonEmptyString(record.name);
    if (id === undefined)
        return undefined;
    const name = nonEmptyString(record.name) ?? id;
    const limit = typeof record.limit === 'object' && record.limit !== null
        ? record.limit
        : {};
    // 窗口：档位表最大档优先
    const options = Array.isArray(record.context_window_options)
        ? record.context_window_options.filter((v) => positiveInt(v) !== undefined)
        : [];
    const limitContext = positiveInt(limit.context);
    const contextWindow = options.length > 0
        ? Math.max(...options)
        : limitContext;
    const modalities = typeof record.modalities === 'object' && record.modalities !== null
        ? record.modalities
        : {};
    const inputs = Array.isArray(modalities.input)
        ? modalities.input.filter((v) => typeof v === 'string')
        : [];
    const effortOptions = stringArray(record.effort_options);
    const rawDefault = nonEmptyString(record.default_effort);
    // ⚠️ 默认档必须落在档位表内，否则不发（照 Qoder 的 resolveModel）
    const defaultEffort = rawDefault !== undefined && effortOptions?.includes(rawDefault) === true
        ? rawDefault
        : undefined;
    // ⚠️ `thinking_config.mode` 决定「能否关闭思考」（2026-09-29 新增）。
    // 实测三种值：`forced_on`（关不掉）/ `switchable`（可开关）。
    // 缺失 ⇒ 不产出该键（视为未知，**不猜**）。
    const thinkingConfig = typeof record.thinking_config === 'object' && record.thinking_config !== null
        ? record.thinking_config
        : undefined;
    const thinkingMode = thinkingConfig === undefined
        ? undefined
        : nonEmptyString(thinkingConfig.mode);
    // ⚠️ **不要用 `as MinimaxModelEntry` 断言** —— 它会掩盖「可选键未产出」
    // 这类真实的不一致（Task 1 实施者实测：加断言后 `tsc` 静默通过，
    // 去掉后报 TS2322）。`maxTokens` 已声明为可选，故此处**无需断言**。
    const maxTokens = positiveInt(limit.output);
    return {
        id,
        name,
        // 窗口未知时**不编造**：用 0 表示「不知道」，由 resolveModel 判 `> 0`
        contextWindow: contextWindow ?? 0,
        ...maxTokens === undefined ? {} : { maxTokens },
        supportsImage: inputs.includes('image'),
        ...effortOptions === undefined ? {} : { effortOptions },
        ...defaultEffort === undefined ? {} : { defaultEffort },
        ...thinkingMode === undefined ? {} : { thinkingMode },
    };
}
/**
 * 兜底表条目转归一形状。
 *
 * ⚠️ **不是「与远端走同一套规则」** —— 本函数**直接搬运字面量**，不调用
 * `normalizeMinimaxModel`：两条路径只共用**输出形状**（`MinimaxModelEntry`），
 * **不共用归一规则**。兜底表的值是**人工按实测口径填好的字面量**
 * （已符合「档位表最大档」口径），故只需搬运、无需再归一。
 *
 * ⚠️ 因此**改归一规则时必须同步核对兜底表**（例如改了窗口口径，
 * 兜底表不会跟着变）—— 回归用例里有一条一致性断言专门锁这一点。
 */
export function fallbackToEntry(model) {
    return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImage: model.supportsImage,
        ...model.effortOptions === undefined ? {} : { effortOptions: model.effortOptions },
        ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
        ...model.thinkingMode === undefined ? {} : { thinkingMode: model.thinkingMode },
    };
}
/** 默认产品下的兜底条目。 */
export function minimaxFallbackEntries(product = MINIMAX) {
    return product.fallbackModels.map(fallbackToEntry);
}
/**
 * 把**不属于令牌**的身份字段从旧凭据继承到新凭据上。
 *
 * ## 为什么需要它（2026-10-24，两个真实后果）
 *
 * `parseMinimaxTokenGrant` 只认识 OAuth 令牌五件套
 *（`access_token` / `refresh_token` / `token_type` / `expires_at` / `scope`），
 * 而续期结果会被 `ctx.credentials.set` **整体覆盖**旧凭据 ⇒ 每续期一次就丢一次：
 *
 * | 字段 | 丢失后的症状 |
 * |---|---|
 * | `nickname` | 账号卡片退回内部 id `minimax-xxxx`（IKP8UA 复发） |
 * | `user_id` | **同账号去重失去唯一判据** ⇒ 同一个号可以无限建卡片、各持一份 token |
 *
 * 定时续期是 30 分钟一轮、`SELF_HEAL` 还会在积分查询前补一次 ⇒ 这个丢失
 * **必然发生**，不是边角情况。（本机实测：`MINIMAX_ACCOUNT_*` 三份凭据里
 * 只有一份带 `nickname`、**零份**带 `user_id`。）
 *
 * @param refreshed 续期响应构造出的新凭据（只有令牌字段）。
 * @param previous 续期前的旧凭据（身份字段的来源）。
 * @returns 合并后的凭据；新凭据**已有的字段一律以新凭据为准**。
 *
 * ## ⚠️⚠️ 为什么是「保留旧字段 + 新字段覆盖」而不是白名单两个字段
 *
 * 初版是白名单 `nickname` + `user_id` 两个字段 —— 那等于**每加一个非令牌字段
 * 都要记得回来改这里**，忘了就静默丢弃（2026-10-25 合并审计登记的 P3）。
 * 而本函数修的正是「静默丢字段」这一类缺陷，用同一类缺陷的形态去修它不合适。
 *
 * ⇒ 改为 `{ ...previous, ...refreshed }`：令牌五件套由 `refreshed` 覆盖，
 *   其余字段沿用旧凭据。**令牌三件套再显式兜一次**（`?? previous`）——
 *   上游若把某个令牌字段省掉（响应里显式 `undefined` 时展开会覆盖），
 *   宁可留旧的也不要把凭据写成半残（半残 = 该账号直接不可用）。
 */
export function inheritMinimaxIdentity(refreshed, previous) {
    const merged = { ...previous, ...refreshed };
    // 令牌材料绝不退化成 undefined（展开一个显式 undefined 字段会覆盖旧值）。
    merged.access_token = refreshed.access_token ?? previous.access_token;
    if ((refreshed.refresh_token ?? previous.refresh_token) !== undefined) {
        merged.refresh_token = refreshed.refresh_token ?? previous.refresh_token;
    }
    if ((refreshed.expires_at ?? previous.expires_at) !== undefined) {
        merged.expires_at = refreshed.expires_at ?? previous.expires_at;
    }
    return merged;
}
//# sourceMappingURL=minimax.js.map