/**
 * 续期失败的**结构化分类**（全仓唯一实现处）。
 *
 * ## 为什么需要它（2026-10-27 两轮审计的共同结论）
 *
 * 本仓库原先有两份**同义判据**（`autoclaw-auth.ts` 的 `refreshCredential` 与
 * `minimax-auth.ts` 的 `isTerminalRefreshError`），都是：
 *
 * ```ts
 * // ❌ 修前（两家逐字同形）
 * if (/invalid_grant|expired|revoked/i.test(message)) throw new TerminalError(...)
 * ```
 *
 * 三处实测打穿（都是**把健康账号标死**，而本仓库的 `refreshable:false` 是
 * **单向门**：`refreshAll` 与巡检都会 `continue` 跳过它 ⇒ 永不自愈）：
 *
 * | 上游报文（真实形态） | 旧判据 | 后果 |
 * |---|---|---|
 * | `HTTP 503 {"error":"token expired"}` | **终态** | 网关抖动一次 = 账号需重登 |
 * | `HTTP 429 {"error":"rate limited, key expired soon"}` | **终态** | 限流一次 = 账号需重登 |
 * | `fetch failed` ⇒ `cause: certificate has expired` | **终态** | 证书/代理抖动 = 账号需重登 |
 *
 * ⚠️ 第三条最隐蔽：本仓库自己的笔记记着「环境 HTTPS 检查代理约 50% 概率打断到
 * 本家的请求」（`docs/agent-notes/providers-loomy-raccoon-minimax.md` 的
 * `minimaxFetchWithRetry` 一节），而 `certificate has expired` 里恰含 `expired`。
 *
 * ## 判据（顺序不可颠倒）
 *
 * 1. **先排传输层**：连不上 / 证书 / 超时 / 主动取消 ⇒ 一律**非终态**（凭据没坏，
 *    网络恢复就该自动复活）。`certificate has expired` 必须在这一步被吃掉，
 *    否则第 2 步的 `expired` 词会把它判成终态 —— 这正是红队实测的击穿点。
 * 2. **再看 HTTP 状态码**：`5xx` / `429` / `408` / `401`（客户端认证问题）⇒
 *    非终态。上游对**整个网关**回 5xx 时，若每个号都被标死，一个请求就能
 *    报废整池。
 * 3. **最后只认结构化 `invalid_grant`**：OAuth 2.0 里「refresh_token 无效」的
 *    **唯一**标准码是 `invalid_grant`（RFC 6749 §5.2）。刻意**不认**
 *    `expired` / `revoked` 这两个宽词，也不从 message 里捞 —— 它们在上游的
 *    5xx 报文、限流文案、证书错误里都会出现。
 *
 * ## 方向性取舍（宁可漏判，不可误判）
 *
 * 漏判（该标死的没标死）的代价 = 每 30 分钟白撞一次上游，用户看到「积分行报错」；
 * 误判（不该标死的标死）的代价 = **账号报废、必须重新登录**，且不可自愈。
 * 两者不对称 ⇒ 一律偏向「不标死」。
 */
/** 结构化续期失败：把 HTTP 状态码与上游 OAuth 错误码带出来，供分类用。 */
export class RefreshFailureError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = 'RefreshFailureError';
    }
}
/**
 * 传输层失败的**错误码**（沿 `cause` 链读）。
 *
 * ⚠️ 读 `code` 而不是 `message`：SSR 侧的 `fetch failed` 是 undici 把**所有**
 * 传输失败压成的同一句话，真因只在 `cause` 上（与 `src/refresh.ts` 的
 * `isUnreachableNetworkError` 同一条教训）。
 */
const TRANSPORT_CODES = /UND_ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i;
/**
 * 传输层失败的**文案特征**（**防御性**，针对「没有结构化信息」的调用方）。
 *
 * ⚠️⚠️ **这份正则必须窄**（2026-10-27 第二轮审计打穿）。修前它含
 * `timeout` / `proxy` / `network` 这类**极常见的业务词**，而
 * `refreshFailureFromResponse` 会把上游的 `error_description` 拼进 message
 * ⇒ 一个真终态报文 `400 {error:'invalid_grant', error_description:'…timed out'}`
 * 会在传输层那一步被吃掉。
 *
 * ⚠️ 但**真正的修法是 `isTerminalRefreshFailure` 里「结构化 `oauthError` 优先」
 *    那一步**（见该函数的第 0 步）：只要上游给了结构化错误码，文案启发式
 *    **完全不参与**判定。所以本正则的宽窄**在有结构化信息时已不是承重件**。
 *
 * ⚠️ 实测（变异验证）：把 `timeout`/`proxy`/`network` 加回来，**全量测试仍然全绿**
 *    —— 因为结构化优先已经独立挡住了那个形态。⇒ 本条的收窄是**防御性冗余**
 *    （保护「第三方适配器只给 message、不给 details」的调用方）。
 *    **如实登记为「无牙」**，不为它编造恒真用例。
 */
const TRANSPORT_MESSAGES = new RegExp([
    'fetch failed',
    'socket hang up',
    'getaddrinfo',
    // ⚠️ 证书类：必须保留（红队实测 `certificate has expired` 含 `expired`，
    //    它是第①步存在的理由）。但也只保留**证书专属**的词，不用宽 `network`。
    'certificate',
    'self[- ]signed',
    'unable to verify',
    'CERT_',
    'EPIPE',
    'AbortError',
    // ⚠️ `timed out` 只在与「连接/请求」同现时才可信 ⇒ 这里要求 `connect|request|socket`
    //    前缀，而不是裸 `timeout`。
    '(?:connect|request|socket|headers)\\s*(?:timed?\\s*out|timeout)',
].join('|'), 'i');
/**
 * 是否为**传输层**失败（没拿到可用响应）。
 *
 * 判据顺序：`details.transport` 显式标记 → 沿 `cause` 链读错误码 → 读文案。
 *
 * ⚠️ **`details` 必须有形状守卫**（2026-10-27 红队实测）：调用方（含第三方适配器、
 * 单测替身）可能传 `details: null` 或 `status: '400'`（字符串）——
 * 前者会让 `error.details.transport` 直接抛 `TypeError`，后者会让状态码判据
 * **静默跳过**（`'400' >= 500` 是 `false`、`=== 400` 也是 `false`）⇒
 * 终态判据被绕过。⇒ 只认**数字**状态码、只在 details 是对象时读它。
 */
export function isRefreshTransportFailure(error) {
    const details = error instanceof RefreshFailureError ? error.details : undefined;
    if (typeof details === 'object' && details !== null && details.transport === true)
        return true;
    // 沿 cause 链读结构化错误码（深度上限防病态自引用链，与 refresh.ts 同款）。
    let current = error;
    for (let i = 0; i < 8 && current !== null && current !== undefined; i += 1) {
        const code = current.code;
        if (typeof code === 'string' && TRANSPORT_CODES.test(code))
            return true;
        current = current.cause;
    }
    const message = error instanceof Error ? error.message : String(error);
    return TRANSPORT_MESSAGES.test(message);
}
/**
 * 读**结构化**状态码（只认数字；字符串/NaN 一律视为「未知」）。
 *
 * ⚠️ 抽成函数是为了**不再有第二份实现**，且让「状态码未知」与「状态码是 400」
 * 在调用点一眼可分 —— 红队实测的绕过正是「字符串状态码让所有 `===` 判据静默失配」。
 */
/**
 * ⚠️ 只认**数字**状态码。
 *
 * 实测（变异验证）：把「只认数字」这条去掉、直接 `return status`，**全量测试仍然全绿**
 * —— 因为真实上游只会回数字状态码，字符串形态只在「第三方适配器传脏值」时可构造。
 * ⇒ 这是**形状防御**（防「字符串让所有 `===`/`>=` 判据静默失配」），
 *   **如实登记为「无牙」**，不为它编造恒真用例。
 */
function statusOf(error) {
    if (!(error instanceof RefreshFailureError))
        return undefined;
    const details = error.details;
    if (typeof details !== 'object' || details === null)
        return undefined;
    const status = details.status;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
/**
 * 是否为**终态**（refresh_token 已死，只能重新登录）。
 *
 * ⚠️ 判据顺序**不可颠倒**（见模块头）。任何一步「不确定」都返回 `false`。
 *
 * ## 第二轮审计修的两处漏判（两位审计员独立命中）
 *
 * ① **结构化信息必须优先于文案启发式**：修前第①步（传输层文案）**先**跑，
 *    于是 `400 {error:'invalid_grant', error_description:'…timed out'}` 被判传输层
 *    ⇒ 真死号永不标死。⇒ 现在只要**结构化 `oauthError` 命中词表**就**立即**判终态
 *    （见下面的早退），传输层文案只用于「没有结构化信息」的那条腿。
 * ② **状态码闸门不能是白名单** `=== 400 || === 200`：上游用别的 4xx 表达
 *    「这把 RT 被拒」时（AutoClaw 业务码信封实测走 `200`，但第三方 403 也见过）
 *    会被整格跳过。⇒ 现在改成**黑名单**（只排除已知的「非终态」状态码），
 *    其余 4xx 一律允许词表参与判定。
 */
export function isTerminalRefreshFailure(error, terminalOAuthErrors = DEFAULT_TERMINAL_OAUTH_ERRORS) {
    const details = error instanceof RefreshFailureError ? error.details : undefined;
    const normalizedDetails = typeof details === 'object' && details !== null ? details : undefined;
    const status = statusOf(error);
    /**
     * ⚠️⚠️ **显式 `transport: true` 是最高优先级**（自审发现：它与「结构化 `oauthError`
     * 优先」那条会打架）。
     *
     * 那个字段是调用点**主动声明**「我没拿到可用响应」（例如 `miniMaxFetchWithRetry`
     * 重试耗尽后包出来的错误）。调用点比任何启发式都清楚发生了什么 ⇒
     * 即使它同时带了 `oauthError` 文本，也必须先按传输层处理。
     */
    if (normalizedDetails?.transport === true)
        return false;
    /**
     * ⚠️⚠️ **第 0 步：结构化 `oauthError` 命中词表 ⇒ 直接终态**（顺序是承重件）。
     *
     * 这是修 ① 的关键：上游**同时**给了结构化错误码与一段含触发词的描述时，
     * 必须信结构化字段。`matchesAny` 是精确词匹配，误判面远小于文案启发式。
     */
    const oauthError = normalizedDetails?.oauthError;
    if (typeof oauthError === 'string' && oauthError.trim().length > 0) {
        /**
         * ⚠️ 状态码是 `5xx` / `429` / `408` / `401` / **`403`** 时按「非终态」处理。
         *
         * ⚠️⚠️ **`403` 是 2026-10-27 自审补齐的一格**：此前这里只排了 `401`，
         * 而 `isDefinitiveRefreshRejection` 却把 `403` 排除了 ⇒ **两处口径分叉**
         * （`403 Invalid token` 在终态判据里是 true、在「确定性拒绝」里是 false）。
         *
         * 取「不判终态」的理由：`403` 的语义是「禁止访问」，真实世界里更常见于
         * **WAF / 风控 / 地域封锁 / 代理拒绝**（本仓库有实测：国际站按出口 IP 分流时
         * 会回与凭据失效**逐字同形**的拒绝）—— 都不说明**这一把** refresh_token 死了。
         * 判错的代价是「账号报废、必须重登」，漏判只是「每 30 分钟白撞一次」
         * ⇒ 偏向不标死。
         */
        const statusIsAmbiguous = status !== undefined
            && (status >= 500 || status === 429 || status === 408 || status === 401 || status === 403);
        if (!statusIsAmbiguous)
            return matchesAny(oauthError, terminalOAuthErrors);
    }
    // ① 传输层永远不是终态（含 `certificate has expired`）。
    if (isRefreshTransportFailure(error))
        return false;
    // ② HTTP 状态码黑名单：5xx / 429 / 408 / 401 / 403 一律非终态。
    //    网关抖动、限流、超时、客户端认证问题、WAF/风控拒绝都不说明**这把**
    //    refresh_token 死了。
    //    ⚠️ 刻意是**黑名单**而不是白名单（见 doc：白名单会让别的 4xx 整格跳过）。
    if (status !== undefined
        && (status >= 500 || status === 429 || status === 408 || status === 401 || status === 403)) {
        return false;
    }
    // ③ 无结构化 oauthError ⇒ 才退回文案启发式（只认**精确**词表内的词）。
    //    ⚠️ 刻意不含 `expired` / `revoked`：它们在 5xx 报文、限流文案、证书错误里
    //    都会出现，是本模块存在的原因。
    const message = error instanceof Error ? error.message : String(error);
    // 文案里带 5xx / 429 的一律不判死（有些实现把状态码写进 message）。
    if (/\b5\d\d\b/.test(message) || /\b429\b/.test(message))
        return false;
    return matchesAny(message, terminalOAuthErrors);
}
/** RFC 6749 §5.2 的「refresh_token 无效」唯一标准码。 */
const DEFAULT_TERMINAL_OAUTH_ERRORS = ['invalid_grant'];
/**
 * 是否为**上游明确给出的结构化拒绝**（与「该家什么词算终态」无关）。
 *
 * 只表达一件事：上游**带结构化 `error`/`msg` 字段、且状态码属于「确定性拒绝」**
 * （非 5xx / 429 / 408 / 401）—— 这种错误比「网关抖了一下」可信得多。
 *
 * ## 用途：端点循环里**别让瞬时错误掩盖确定性错误**
 *
 * `refreshAutoclawToken` / `refreshMinimaxCredential` 会**依次试多个端点**。
 * 修前它们无条件 `lastError = err`（后者覆盖前者）。实测：
 * 端点1 回 `400 invalid_grant`（真终态）、端点2 回 `503`（瞬时）⇒
 * 最终抛出去的是 **503** ⇒ 上层判据看不到那次确定性拒绝 ⇒ 真死号不标死、
 * 退化成每轮重试。
 *
 * ⇒ 循环里用本函数做「保留优先级」：确定性拒绝**不被**瞬时错误覆盖。
 */
export function isDefinitiveRefreshRejection(error) {
    if (!(error instanceof RefreshFailureError))
        return false;
    const details = error.details;
    if (typeof details !== 'object' || details === null)
        return false;
    const oauthError = details.oauthError;
    if (typeof oauthError !== 'string' || oauthError.trim().length === 0)
        return false;
    const status = typeof details.status === 'number' && Number.isFinite(details.status)
        ? details.status
        : undefined;
    // 无状态码（如第三方只给 error 字段）也接受：结构化错误本身就有信息量。
    if (status === undefined)
        return true;
    return status < 500 && status !== 429 && status !== 408 && status !== 401 && status !== 403;
}
/** 精确词匹配（大小写无关、要求词边界，避免 `invalid_grant_x` 之类误命中）。 */
function matchesAny(text, words) {
    return words.some((word) => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(text);
    });
}
/**
 * 从上游响应构造**结构化**续期失败。
 *
 * 两家 OAuth 端点（MiniMax `/oauth2/token`、AutoClaw `/userapi/v1/refresh`）
 * 都用它，避免各写一份「状态码 + error 字段」的提取。
 *
 * ⚠️⚠️ **两把键都要读**（2026-10-27 第二轮审计打穿）：AutoClaw 的刷新端点有两种
 * 错误载体 —— OAuth 标准形态 `{error:'invalid_grant'}` 与**业务码信封**
 * `{code, msg:'Invalid token'}`。修前只按调用点传入的单一键读，于是
 * `HTTP 400 {code:401,msg:'Invalid token'}` 的结构化字段是 `undefined`
 * ⇒ 终态判据拿不到信息、语境丢失。⇒ 现在**先读显式键、再读另一把**。
 *
 * @param label 日志前缀（如 `'MiniMax 续期失败'`），进 message 以保住原有可读性。
 * @param status HTTP 状态码。
 * @param body   已解析的响应体（可能不是对象）。
 * @param oauthErrorKey 该家**优先**读的键（MiniMax 用 `error`、AutoClaw 用 `msg`）。
 */
export function refreshFailureFromResponse(label, status, body, oauthErrorKey = 'error') {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body
        : {};
    /** 先读该家声明的键，读不到再读另一把（两家的载体互有交叉）。 */
    const altKey = oauthErrorKey === 'error' ? 'msg' : 'error';
    const readKey = (key) => {
        const raw = record[key];
        return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
    };
    const oauthError = readKey(oauthErrorKey) ?? readKey(altKey);
    const rawMessage = record.error_description ?? record.message;
    const described = typeof rawMessage === 'string' && rawMessage.trim().length > 0
        ? rawMessage.trim()
        : undefined;
    const message = `${label}：HTTP ${status}`
        + `${oauthError === undefined ? '' : ` ${oauthError}`}`
        + `${described === undefined ? '' : `（${described}）`}`;
    return new RefreshFailureError(message, {
        status,
        ...oauthError === undefined ? {} : { oauthError },
    });
}
//# sourceMappingURL=refresh-failure.js.map