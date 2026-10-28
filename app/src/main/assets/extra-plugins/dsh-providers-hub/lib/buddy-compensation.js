/**
 * CodeBuddy（腾讯云代码助手）**限时补偿积分**的状态查询与领取客户端。
 *
 * ## 端点来源（逆向 + 真实报文双证据）
 *
 * 端点取自 `www.codebuddy.cn` 的前端 bundle
 * （`assets.workbuddy.cn/web/usercenter/<hash>/assets/index-*.js`），原文：
 *
 * ```js
 * bp = async () => await cn.post("/billing/meter/compensation-status")
 * vp = async () => await cn.post("/billing/meter/claim-compensation")
 * ```
 *
 * 「套餐与积分」页上「立即领取」按钮的 `onClick` 闭包调的就是 `vp()`。
 *
 * ⚠️ 路径**没有 `/v2` 前缀**（对比 WorkBuddy 的
 * `/v2/billing/meter/daily-checkin`）—— 这是另一个产品面，别按 v2 抄。
 *
 * ## 用哪个 host（2026-10-16 三 host 实测）
 *
 * **三个 host 全部可达**（Node `fetch`，带完整产品头，均 HTTP 200 且报文一致）：
 *
 * | host | 结果 |
 * |---|---|
 * | `www.codebuddy.cn` | 200 |
 * | `www.workbuddy.cn` | 200 |
 * | `copilot.tencent.com` | 200 |
 *
 * ⚠️ **本模块仍刻意走 `webBase`**（buddy 的取值是 `www.workbuddy.cn`）：
 * ① 它正是网页端发这个请求的站（前端 bundle 就托管在 `assets.workbuddy.cn`），
 *    与「用户看到的那个按钮」逐字同源；
 * ② `endpoint`（`copilot.tencent.com`）是**推理 API 站**，虽然实测也能通，
 *    但把「用户中心类请求」打到推理站没有依据（哪天它收窄路由就会静默失效）。
 *
 * ⚠️⚠️ **一条被污染的实测教训**（记下来别再犯）：我最初在**浏览器**里用
 * `fetch` 测这三个 host，得到「只有 codebuddy.cn 可达、另两个 Failed to fetch」——
 * 那是**跨域 CORS 拦截**造成的假象，不是服务端不可达。**判定端点的可达性
 * 必须在 Node/无 CORS 环境做**；浏览器里的失败要先排除 CORS 再下结论。
 *
 * ## 真实报文（2026-10-16，账号本人的 buddy token）
 *
 * `POST /billing/meter/compensation-status`（空 body）→ HTTP 200：
 *
 * ```json
 * {"code":0,"msg":"OK","requestId":"…","data":{
 *    "claimed": false,
 *    "active": true,
 *    "credit_num": 500,
 *    "validity_period": 1,
 *    "end_time": "2026-10-22 23:59:59"}}
 * ```
 *
 * ⚠️ **鉴权是 `Authorization: Bearer <buddy access_token>`，不需要浏览器
 * cookie** —— 已用 Node `fetch`（无任何浏览器上下文）实测 200。这是本功能
 * 能脱离「网页点按钮」实现自动化的前提。
 *
 * ## 真实报文（2026-10-17，领取端点 —— **成功时没有 `data`**）
 *
 * `POST /billing/meter/claim-compensation`（空 body）→ HTTP 200：
 *
 * ```json
 * {"code":0,"msg":"OK","requestId":"…"}
 * ```
 *
 * **没有 `data` 字段。** 当时本机 5 个账号批量领取，5/5 都是这个形态：
 * 面板按「缺 `data` ⇒ shape」判成「响应格式不认识：响应缺 data 对象」，
 * 于是报「5 个账号领取失败」；而随后用同一批 token 查 status，5/5 都是
 * `claimed:true, active:true, credit_num:500` —— **积分其实早就到账了**。
 *
 * ⇒ 写操作的成败**只看 `code`**（见 `parseEnvelope` 的 `requireData`）；
 *   状态查询仍然要求 `data`，两者判据刻意不同。
 *
 * ## ⚠️ 为什么**不**接进自动签到（本模块的实现约定）
 *
 * 这是一次性的**限时**补偿（`end_time` 到期即作废），不是每日可领的能力。
 * 本仓库对「一次性 / 有代价动作」的既有铁律是**默认不自动执行**
 * （见 `buddy-growth.ts` 的 `runExotic`：盲盒/抽奖默认关闭，理由正是
 * 「避免误触一次性动作」）。
 *
 * ⇒ 本模块**只提供
 *   ① 状态查询（供面板如实展示「有 N 积分待领 / 已领取 / 活动已结束」），
 *   ② 一次显式领取（由用户在面板上点按钮触发）。
 *   **不接入 `credits.claimAll` / `auto-checkin`**，也不在任何后台链路上调用
 *   `claimCompensation`。
 *
 * ⚠️ 将来若有人想改成自动领，**先读这一节**：那会违反上面的约定，且收益只有
 * 一次（活动结束后这个端点对所有人恒返回 `active:false`）。
 *
 * @module src/buddy-compensation.ts
 */
import { BUDDY_DEPLOYMENT_TYPE, HTTP_HEADER_DOMAIN, HTTP_HEADER_PRODUCT, HTTP_HEADER_PRODUCT_CODE, } from './buddy.js';
/** 补偿状态查询路径。⚠️ 无 `/v2` 前缀（见模块头）。 */
export const COMPENSATION_STATUS_PATH = '/billing/meter/compensation-status';
/** 补偿领取路径。⚠️ 无 `/v2` 前缀（见模块头）。 */
export const COMPENSATION_CLAIM_PATH = '/billing/meter/claim-compensation';
/** 单次请求超时。与 `credits.ts` 的同类请求保持一致。 */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * 取本产品打「网页站」用的 base URL。
 *
 * ⚠️ **用 `webBase`**（buddy 的取值是 `www.workbuddy.cn`），不是 `endpoint`
 * （`copilot.tencent.com`）。⚠️ 三个 host 实测**都可达**（见模块头的对照表），
 * 故这里是**取舍**而非「另两个打不通」：选 `webBase` 是因为它正是网页端发该请求的站，
 * 与用户点的那个按钮同源。别把这条读成「endpoint 不可用」。
 *
 * ⚠️ **不能直接 `String(product.webBase)`**：`String(undefined)` 得到的是
 * **字符串 `"undefined"`** 而非抛错 —— URL 会拼成
 * `undefined/billing/meter/…`，请求真的发出去，失败现象看起来像服务端问题，
 * 真因（本插件缺配置）却毫无线索。这与 `buddy-growth.ts` 的 `claimBaseOf`
 * 是同一条教训，故这里显式判空并回退。
 */
function webBaseOf(product) {
    const explicit = typeof product.webBase === 'string' ? product.webBase.trim() : '';
    if (explicit.length > 0)
        return explicit.replace(/\/+$/, '');
    const claim = typeof product.claimBase === 'string' ? product.claimBase.trim() : '';
    if (claim.length > 0)
        return claim.replace(/\/+$/, '');
    return '';
}
/**
 * 构造请求头。
 *
 * ⚠️ 与 `buddy-growth.ts` 的 `growthHeaders` **同族但刻意分开**：那边多一个
 * `X-Client-Platform: web`。本端点用最简头集实测通过（Bearer + 产品归属头），
 * 故不照抄 —— 多余的头是风险面（腾讯系有内容级风控，见 providers-buddy 笔记）。
 */
function compensationHeaders(credential, product) {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${credential.access_token}`);
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    headers.set(HTTP_HEADER_DOMAIN, product.apiDomain || credential.domain || '');
    headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE);
    headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode);
    if (credential.user_id !== undefined && credential.user_id.length > 0) {
        headers.set('X-User-Id', credential.user_id);
    }
    if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
        headers.set('X-Enterprise-Id', credential.enterprise_id);
        headers.set('X-Tenant-Id', credential.enterprise_id);
    }
    headers.set('User-Agent', product.userAgent);
    return headers;
}
/** 把「响应不是 JSON」整理成可读原因（凭据过期时网关会回 HTML 错误页）。 */
function describeNonJsonResponse(status, text) {
    const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    return snippet.length > 0
        ? `响应不是 JSON（HTTP ${status}）：${snippet}`
        : `响应不是 JSON（HTTP ${status}，空响应体）`;
}
/** 从 JSON 安全读取布尔值（缺字段/类型不符一律按 `false`，不抛）。 */
function readBool(source, key) {
    return source[key] === true;
}
/** 从 JSON 安全读取数字（字符串数字也接受；读不到返回 `undefined`）。 */
function readNum(source, key) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string' && raw.trim().length > 0) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
/** 从 JSON 安全读取字符串（非字符串返回 `undefined`）。 */
function readStr(source, key) {
    const raw = source[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
/**
 * 解析上游响应信封（`{code, msg, data}`）。
 *
 * ⚠️ **判据分三层，不合并**：① 不是对象 / 缺 `data` ⇒ `shape`；
 * ② `code` 非 0 ⇒ `upstream`（带上游 `msg` 原文，那是排障的唯一线索）；
 * ③ 通过 ⇒ 交给各自的字段映射。
 *
 * ## ⚠️ `requireData: false` 是给**写操作**（领取）的，别对状态查询用
 *
 * 上游的领取端点成功时**只回 `{code:0,msg:"OK",requestId}`，压根没有 `data` 字段**
 * （2026-10-17 本机 5 个账号实测：5/5 领取成功、余额已到账，却被这里判成
 * 「响应缺 data 对象」⇒ 面板报「响应格式不认识」，用户看到「5 个领取失败」）。
 *
 * ⇒ 写操作的成败**只由 `code` 决定**；缺 `data` 不等于失败。
 * 但**仍然要求 `code === 0`**：没有业务码的响应无法与「网关回了个 JSON 错误体」
 * 区分，宁可继续报 `shape`，也不要把未知形态当成功（一次性写操作尤其不能猜）。
 *
 * 状态查询必须保留 `requireData`（默认 true）：它的返回值就是 `data` 里的字段，
 * 缺 `data` 说明接口形态变了，必须让用户看见。
 */
function parseEnvelope(text, status, options = {}) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, failure: { kind: 'network', message: describeNonJsonResponse(status, text) } };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, failure: { kind: 'shape', message: '响应顶层不是对象' } };
    }
    const env = parsed;
    const code = readNum(env, 'code');
    if (code !== undefined && code !== 0) {
        return {
            ok: false,
            failure: {
                kind: 'upstream',
                code,
                message: readStr(env, 'msg') ?? readStr(env, 'message') ?? `业务码 ${code}`,
            },
        };
    }
    const data = env['data'];
    if (typeof data !== 'object' || data === null) {
        // 写操作：`code === 0` 即成功，缺 `data` 是**上游成功信封的常态**（见上）。
        if (options.requireData === false && code === 0)
            return { ok: true, data: {} };
        return { ok: false, failure: { kind: 'shape', message: describeMissingData(env, code) } };
    }
    return { ok: true, data: data };
}
/**
 * 缺 `data` 时的可读原因。
 *
 * ⚠️ 旧文案只有「响应缺 data 对象」六个字，排障时**无法判断**是接口换形态、
 * 还是响应里其实带了 `code/msg` 却没被展示。这里把信封自身的线索一并带出来
 * （**不含凭据**：响应体里没有 token）。
 */
function describeMissingData(env, code) {
    const parts = [`code=${code === undefined ? '缺失' : String(code)}`];
    const msg = readStr(env, 'msg') ?? readStr(env, 'message');
    if (msg !== undefined)
        parts.push(`msg=${msg}`);
    const requestId = readStr(env, 'requestId') ?? readStr(env, 'request_id');
    if (requestId !== undefined)
        parts.push(`requestId=${requestId}`);
    parts.push(`顶层字段=[${Object.keys(env).join(',')}]`);
    return `响应缺 data 对象（${parts.join('，')}）`;
}
/**
 * 查询**本账号**的补偿状态。
 *
 * 只读，无副作用 —— 面板挂载/刷新时调用。
 *
 * ⚠️ `credit_num` 缺失时按 **0** 处理（而不是判失败）：那样面板显示
 * 「无可领取积分」而非报错，与上游「活动在但额度为 0」的真实含义一致。
 */
export async function fetchCompensationStatus(credential, product, fetcher = fetch) {
    const base = webBaseOf(product);
    if (base.length === 0) {
        return { ok: false, failure: { kind: 'network', message: '产品缺少 webBase/claimBase 配置，无法拼接补偿端点' } };
    }
    try {
        const response = await fetcher(`${base}${COMPENSATION_STATUS_PATH}`, {
            method: 'POST',
            headers: compensationHeaders(credential, product),
            body: '{}',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        const env = parseEnvelope(text, response.status);
        if (!env.ok)
            return { ok: false, failure: env.failure };
        return {
            ok: true,
            status: {
                claimed: readBool(env.data, 'claimed'),
                active: readBool(env.data, 'active'),
                creditNum: readNum(env.data, 'credit_num') ?? 0,
                validityPeriod: readNum(env.data, 'validity_period'),
                endTime: readStr(env.data, 'end_time'),
            },
        };
    }
    catch (error) {
        return { ok: false, failure: { kind: 'network', message: error instanceof Error ? error.message : String(error) } };
    }
}
/**
 * 领取本账号的补偿积分（**写操作，只能成功一次**）。
 *
 * ⚠️ **只应由用户在面板上显式点击触发**，不得接进自动签到 / 定时器
 * （理由见模块头）。调用方应在点击后**重新查询状态**刷新展示。
 *
 * ⚠️ **不做重试**：这是一次性写操作，超时后服务端可能已经成功。盲目重试会有两种
 * 坏结果：① 若上游幂等则白打一次请求；② 若上游返回「已领取」的业务码，调用方
 * 会把「其实成功了」误报成失败。故这里**最多发一次**，失败就把上游原文交给用户。
 *
 * ⚠️⚠️ **成功响应没有 `data`**（2026-10-17 实测，见 `parseEnvelope` 的说明）：
 * 上游回的是 `{"code":0,"msg":"OK","requestId":"…"}`。这里必须传
 * `requireData: false`，否则「已领到 500 分」会被判成「响应格式不认识」
 * ——本机 5 个账号 5/5 命中过这个假失败。
 */
export async function claimCompensation(credential, product, fetcher = fetch) {
    const base = webBaseOf(product);
    if (base.length === 0) {
        return { ok: false, failure: { kind: 'network', message: '产品缺少 webBase/claimBase 配置，无法拼接补偿端点' } };
    }
    try {
        const response = await fetcher(`${base}${COMPENSATION_CLAIM_PATH}`, {
            method: 'POST',
            headers: compensationHeaders(credential, product),
            body: '{}',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        const env = parseEnvelope(text, response.status, { requireData: false });
        if (!env.ok)
            return { ok: false, failure: env.failure };
        return { ok: true };
    }
    catch (error) {
        return { ok: false, failure: { kind: 'network', message: error instanceof Error ? error.message : String(error) } };
    }
}
/** 把失败原因整理成给用户看的一句话（**保留上游原文**，那是排障唯一线索）。 */
export function describeCompensationFailure(failure) {
    switch (failure.kind) {
        case 'network':
            return `请求失败：${failure.message}`;
        case 'upstream':
            return `上游拒绝（业务码 ${failure.code}）：${failure.message}`;
        case 'shape':
            return `响应格式不认识：${failure.message}`;
    }
}
//# sourceMappingURL=buddy-compensation.js.map