/**
 * 华为云 CodeArts 积分（「每日签到得积分」活动）。
 *
 * ## 为什么与另外两个积分实现都不共用协议
 *
 * | provider    | 认证方式                    | 签到流程                          |
 * |-------------|-----------------------------|-----------------------------------|
 * | `buddy`     | Bearer + 腾讯系归属头        | 两步（状态 + 领取）                |
 * | `lobsterai` | 纯 Bearer，无签名            | 三步（slot + context + check_in）  |
 * | `codearts`  | **SDK-HMAC-SHA256 签名**     | **三步（账户类型 + 活动 + 领取+确认）** |
 *
 * 华为云这套与前两者没有一处共用，故独立成文件；但**复用 `credits.ts` 的
 * `ClaimOutcome` / `CreditBalance` / `CreditPackage` 类型**，使
 * `computeClaimSummary` 与 Jet Hub 的结果摘要 UI、`CreditBalanceRow`
 * 组件一行都不用改。
 *
 * ## 协议来源（逆向自本机安装的码道 IDE，非猜测）
 *
 * `C:\Program Files\CodeArts Agent\resources\app\out\main.js:54259`
 * 与 `out\vs\workbench\workbench.desktop.main.js:375626`（`ActivityWelfarePane`）：
 *
 * ```
 * 账户/套餐  GET  {snapEngineUrl}/snap-manager/v1/statistics/plugin
 * 活动列表   GET  {snapEngineUrl}/v1/ops/delivery?channel=IDE
 * 领取       POST {snapEngineUrl}/v1/ops/claim   { campaignId, channel: 'IDE' }
 * 领取确认   POST {snapEngineUrl}/v1/ops/confirm { campaignId }
 * ```
 *
 * `snapEngineUrl` 取自 IDE 的 `product.json`，值为
 * `https://snap-access.cn-north-4.myhuaweicloud.com` —— **与本仓库
 * `src/models.ts` 已在使用的 `SNAP_MODEL_BUILTIN_URL` 同域**。
 *
 * ## 认证：签名，不是 Cookie（关键结论）
 *
 * 官方文档给出的网页版路径（`https://codearts.huaweicloud.com/portal/...`）
 * 走的是 portal BFF，**依赖浏览器会话 Cookie**：实测不带 Cookie 时无论是否
 * 携带 AK/SK 签名，都返回 IAM 登录跳转 HTML（HTTP 200 + `text/html`）。
 * 因此插件**不能**复用那条路径 —— 它没有可用的浏览器会话。
 *
 * 而 IDE 直连的 snap-access 端点接受 **`SDK-HMAC-SHA256` 签名**
 * （IDE 的 `signer.js`：`ALGORITHM = "SDK-HMAC-SHA256"`、头 `X-Security-Token`），
 * 与 `src/sign.ts` 的实现逐字一致。故本模块走签名路径，凭据就是现有的
 * `CodeArtsCredential`（AK/SK/security_token），无需任何新登录流程。
 *
 * ## 账户类型检测（活动范围的前置条件）
 *
 * 活动文档明确「活动参与者：已经升级到**积分计费模式**的用户」。
 * `statistics/plugin` 的响应里 `package.is_credit_package === true`
 * 即表示积分账户（IDE 前端正是用它决定渲染「积分版」还是「Token 版」布局，
 * 见 `accountInfoPane.js` 的 `accountInfo.isCreditPackage`）。
 *
 * 因此领取前**必须先判账户类型**：Token 计费账户不在活动范围内，
 * 直接尝试领取只会拿到一个语义模糊的错误。
 *
 * ## 幂等
 *
 * 与 CodeBuddy 靠服务端业务码、LobsterAI 靠客户端 `idempotencyKey` 都不同：
 * 这里靠**活动列表的 `claimable` / `status`** 预检。IDE 的实现同样如此
 * （按钮在 `status` 属于已领取态时被 `disabled`）。领取后若服务端要求
 * 确认（响应 `id !== null`），再补一次 `confirm` —— 这一步是 IDE 的行为，
 * 漏掉会让积分停在「待确认」而不入账。
 */
import { signRequestHuawei } from './sign.js';
/**
 * snap-access 网关基址。
 *
 * 与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` 同域 —— 该端点已在本仓库
 * 稳定使用，故此处沿用同一 host，不另立常量来源。
 *
 * 注：IDE 的 `PackageInfoService.getFallbackUrls` 还实现了 `.com` → `.cn`
 * 的域名回退。本实现**刻意不照搬**：该回退分支无法在本机实测（`snap-access
 * .cn-north-4.myhuaweicloud.cn` 的可达性与响应形态均未验证），引入一条未验证
 * 的请求路径只会让失败原因更难定位。若将来确认 `.cn` 域名必要，再补不迟。
 */
export const CODEARTS_SNAP_ENGINE_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com';
/** 账户/套餐信息端点 —— 积分账户检测的唯一真相源。 */
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin';
/** 活动列表端点。 */
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery';
/** 领取端点。 */
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim';
/** 领取确认端点。 */
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm';
/**
 * 限时福利领取的完整 URL（幂等；成功判据 `error_code === '0000'`）。
 *
 * ⚠️ 导出供单测匹配「这一次 fetch 是领取、不是聊天」—— 三条既有用例的替身
 * fetch 是按 URL 分流计数的，不认这个地址就会把领取误计成一次 chat 请求。
 * 网关配置端点（`/api/v1/gateway/config`）已在 `src/models.ts` 实现，此处不重复。
 */
export const CODEARTS_BENEFIT_CLAIM_URL = 'https://opengw.developer.huaweicloud.com/api/v1/benefit/claim';
/** 渠道标识：声明请求来自 IDE 形态（对齐 IDE 的 `channel=IDE`）。 */
export const CODEARTS_OPS_CHANNEL = 'IDE';
/**
 * 「每日签到得积分」在活动列表里的 `type` 取值。
 *
 * IDE 的 `ActivityWelfarePane.TYPE_ORDER` 把活动分为四类，其中 `USER_LOGIN`
 * 即「每日登录领取」；`INVITE_USER` / `NEW_USER_REGISTER` / `STUDENT_CERTIFIED`
 * 是邀请、新人、学生认证，**不属于**每日签到，不能混领。
 */
export const CODEARTS_DAILY_LOGIN_TYPE = 'USER_LOGIN';
/**
 * 活动 `status` 中表示「已领取/已确认/已核销」的取值。
 *
 * 取自 IDE `ActivityWelfarePane.render`：这三种状态下领取按钮被禁用。
 * 用于把「今天已领」与「活动未开始/无资格」区分开 —— 两者对用户的含义不同。
 */
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED'];
/**
 * 「今天已领过」的服务端业务码。
 *
 * 实测（2026-10-08，永久 AK/SK 首次领取成功后再发一次 `POST /v1/ops/claim`）：
 * `HTTP 200 {"code":40001,"message":"尚未到达权益刷新时间，暂时无法领取","data":null}`。
 * 活动列表的 `claimable` 会在一段时间内保持 true，故这是重复点击的主要出口。
 */
const CODEARTS_ALREADY_CLAIMED_CODE = 40001;
/** 请求超时（毫秒）。与 `credits.ts` 的 30s 同口径。 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 所有 snap-access 请求共用的附加头（**签名后追加，不参与签名计算**）。
 *
 * ⚠️ 这两个头绝不能作为 `signRequestHuawei` 的 `extraHeaders` 传入。
 *
 * 实测（2026-09-18，真实凭据）：一旦 `Agent-Type` 进入 canonical request 与
 * SignedHeaders，服务端回
 * `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；
 * 同一个头在**签名之后**追加则请求成功（200 并返回真实数据）。
 *
 * 这与 `src/models.ts` 的 `fetchSignedGet` 一致 —— 它的参数注释明确写着
 * 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。本模块早期版本
 * 误当作签名头，导致全部 CodeArts 积分请求 401、界面显示「账户信息查询失败」。
 *
 * `Agent-Type` 本身仍是**服务端路由所需**（`/v1/model/builtin` 等端点靠它
 * 选择响应形态），只是不该被签名。
 */
const SNAP_EXTRA_HEADERS = {
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
};
/**
 * 积分 metric 名 → 展示名。
 *
 * `statistics/plugin` 的 `metrics[]` 用 `name` 区分口径，IDE 从其中四项读取
 * 积分数（`accountInfoPane.js` 的 `apply`）：
 * `usageTotalPackageCredit` 是总额，其余三项是分类明细。
 */
const CREDIT_METRIC_LABELS = {
    usageTotalPackageCredit: '总积分包',
    usageBasicPackageCredit: '基础积分包',
    usageOnDemandPackageCredit: '按需积分包',
    usageBonusPackageCredit: '赠送积分包',
};
/** 总额 metric 的名字（其余分类明细不参与总额计算，避免重复累加）。 */
const TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit';
/**
 * 基础积分包的 metric 名。
 *
 * 只有这个分类能拿到确切的到期时刻 —— 它随**套餐周期**（响应顶层的
 * `end_date`）重置。赠送包（签到/活动，逐笔「发放日 +30 天」）与按需包
 * （实时结算）都没有可用的逐包到期字段，故不套用套餐周期。
 */
const BASIC_CREDIT_METRIC = 'usageBasicPackageCredit';
/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析';
/**
 * 把非 2xx 响应整理成**带服务端原因**的说明。
 *
 * 为什么不能只写 `HTTP 401`：华为网关的错误体里带着真正的原因，例如
 * `{"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication
 * information: verify ak sk signature fail"}`。丢掉它会让「签名头位置不对」
 * 「凭据过期」「AK 无权限」这些**处置方式完全不同**的问题看起来一模一样
 * —— 本模块就因此把一次 401 显示成了笼统的「账户信息查询失败」。
 */
function describeHttpFailure(status, text) {
    let detail = '';
    try {
        const parsed = JSON.parse(text);
        const code = typeof parsed.error_code === 'string' ? parsed.error_code : '';
        const msg = typeof parsed.error_msg === 'string' ? parsed.error_msg : '';
        detail = [code, msg].filter(part => part.length > 0).join(' ');
    }
    catch {
        // 非 JSON（网关 HTML 错误页等）：截断原文，避免把整页 HTML 塞进 UI。
        detail = text.trim().slice(0, 200);
    }
    return detail.length > 0 ? `HTTP ${status}：${detail}` : `HTTP ${status}`;
}
/** 从 JSON 安全读取布尔值（兼容 `true` / `'true'` 两种形态）。 */
function readBool(source, key) {
    const value = source[key];
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return value.trim().toLowerCase() === 'true';
    return false;
}
/** 从 JSON 安全读取数字（兼容数字字符串；缺失或非法返回 0）。 */
function readNumber(source, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
/**
 * 从 JSON 安全读取数字，但**区分「缺失」与「0」**（缺失/非法返回 `undefined`）。
 *
 * 与 {@link readNumber} 的分工：那个返回 0 是刻意的（`package_credit_amount`
 * 缺失时按「额度为 0」处理，让「0 额度分类不列为资源包」的判据成立）；
 * 但 `package_credit_expiring_amount` 缺失表示**上游没给这个口径**，
 * 与「给了且为 0」是两件事 —— 前者要显示「无此信息」，后者要显示「无临期额度」。
 * 混用会让没有该字段的账户凭空多出一句「0 即将到期」。
 */
function readOptionalNumber(source, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
/** 从 JSON 安全读取字符串。 */
function readString(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : '';
}
/**
 * 读取一个**标识符类**字段并统一成字符串（兼容数字与字符串两种形态）。
 *
 * 为什么需要它：华为服务端对同一语义字段的类型并不一致 —— 实测
 * `campaignId` 下发的是**数字** `1`，而活动 `status` 下发的是字符串
 * （不可领取时甚至为 `null`）。用只接受字符串的 {@link readString} 去读
 * `campaignId` 会得到空串，领取流程据此判定「缺少 campaignId」而失败
 * （真实缺陷：用户点「一键领取积分」后看到「1 个失败」）。
 *
 * 数字转字符串用 `String(value)`：`1` → `'1'`，正是回传服务端所需的形态。
 * 对象/数组/布尔等非标量一律返回空串，避免把 `[object Object]` 当作 ID 发出去。
 */
function readIdentifier(source, key) {
    const value = source[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}
/** 取出一个非数组的对象值；不是对象时返回空对象。 */
function readRecord(source, key) {
    const value = source[key];
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
/**
 * 解包响应信封。
 *
 * **必须兼容两种形态**，因为两个端点的信封结构不同（逆向所得）：
 *
 * - `ops/*`（`ActivityWelfarePane.request`）返回 `{ code, message, data }`，
 *   且 `code !== 0` 即业务失败；
 * - `statistics/plugin`（`PackageInfoService.doFetch`）**直接返回裸对象**
 *   （`toPackageInfo(JSON.parse(body))`，没有 `data` 解包步骤）。
 *
 * 判定顺序：先看 `code`（存在且非 0 即失败），再取 `data`，没有 `data`
 * 就认为 body 本身即数据。这样两种形态都能正确解析，且不会把业务失败
 * 当成成功 —— 那会让「活动未开始」被误报成「领取成功」。
 */
function unwrapSnapEnvelope(raw) {
    const code = raw.code;
    const hasCode = typeof code === 'number';
    if (hasCode) {
        if (code !== 0) {
            const message = readString(raw, 'message') || readString(raw, 'msg');
            return { ok: false, code, message: message.length > 0 ? message : `业务码 ${code}` };
        }
        const data = raw.data;
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            return { ok: true, data: data };
        }
        return { ok: false, code, message: '响应缺少 data 字段' };
    }
    // 无 code 字段：裸对象形态（statistics/plugin）。
    return { ok: true, data: raw };
}
/**
 * 发起一次带 SDK-HMAC-SHA256 签名的 snap-access 请求。
 *
 * 网络失败与非 2xx 都返回带**原因说明**的失败，而不是笼统的 undefined ——
 * 与 `credits.ts` 同款取舍：调用方需要能如实呈现「为什么查不到」。
 */
async function signedSnapRequest(method, url, credential, body, fetcher) {
    const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
    if (!ak || !sk) {
        return { ok: false, code: -1, message: '凭据缺少 AK/SK' };
    }
    try {
        const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(body);
        // 签名**不含** SNAP_EXTRA_HEADERS：那两个头在下面签名后追加。
        // 把它们传进来会进 canonical request，服务端验签失败（见该常量注释）。
        const signed = await signRequestHuawei(ak, sk, st, method, url, payload);
        const headers = new Headers();
        // `host` 由运行时按实际连接目标生成，手工设置会被 fetch 拒绝/忽略。
        signed.forEach((value, key) => {
            if (key !== 'host')
                headers.set(key, value);
        });
        for (const [key, value] of Object.entries(SNAP_EXTRA_HEADERS))
            headers.set(key, value);
        const response = await fetcher(url, {
            method,
            headers,
            ...body === undefined ? {} : { body },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) {
            // 把服务端的错误码/原因带出来。实测 401 时响应体是
            // `{"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`，
            // 只报 `HTTP 401` 会让「签名头放错位置」这类问题极难定位。
            return { ok: false, code: response.status, message: describeHttpFailure(response.status, text) };
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE };
        }
        return unwrapSnapEnvelope(parsed);
    }
    catch (error) {
        return {
            ok: false, code: -1,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * 从 `metrics[]` 解析积分余额。
 *
 * 总额取 `usageTotalPackageCredit` 的 `package_credit_remain`，**不累加各分类**
 * —— 分类（基础/按需/赠送）是总额的构成明细，相加会重复计算。
 * 总额 metric 缺失时才回退为分类求和。
 *
 * 没有任何 credit metric 时返回 `undefined`（= 该账户没有积分口径），
 * 与 `total: 0`（有口径但余额为 0）严格区分。
 */
/**
 * 把 `YYYY-MM-DD` 形式的日期解析成毫秒时间戳（解析不出返回 `undefined`）。
 *
 * ⚠️ 服务端下发的是**纯日期**（`end_date: "2026-10-27"`），不含时刻与时区。
 * 按 ISO 8601 规范，纯日期形式 `YYYY-MM-DD` **必须**按 UTC 解释
 * （与 `YYYY-MM-DDTHH:mm:ss` 无时区时按本地时间解释不同）。
 * 这正好对应服务端的语义：套餐在 `end_date` 当天的 **00:00 UTC**
 * （= 北京时间 08:00）结束 —— 截图里显示的「2026/10/26 23:59」是
 * 按另一个时区口径取的前一秒，两者指向同一个时刻边界。
 *
 * ⚠️ 解析不出就返回 `undefined`（= 到期时间未知 ⇒ 分档归永久桶），
 * **绝不**用 `Date.now()` 之类的值兜底。
 */
function parseDateMs(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return undefined;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
function parseCreditBalance(metrics, packageEndDate) {
    if (!Array.isArray(metrics))
        return undefined;
    const packages = [];
    let totalRemain;
    let sawAnyCreditMetric = false;
    /**
     * 「即将到期」的额度（`package_credit_expiring_amount`）。
     *
     * ⚠️ **总额口径**：只在总额 metric 上取一次，不累加各分类 —— 实测
     * `usageTotalPackageCredit` 与 `usageBonusPackageCredit` **同时**带 2000
     * （2026-10-20 真实账号），累加会得到 4000，凭空翻倍。
     *
     * ⚠️ 实测校验：`总额 expiring - 赠送 expiring = 0` ⇒ 总额那个标量
     * **就是各分类之和**，故下面逐包读取不会重复计数。
     *
     * ⚠️ 缺失该键与值为 0 严格区分：缺失 = 上游没给这个口径（`undefined`），
     * 0 = 给了且当前没有即将到期的额度。
     */
    let expiringTotal;
    /**
     * 套餐周期结束时刻（`end_date` 的毫秒值；解析不出为 `undefined`）。
     *
     * ⚠️ 这个日期**只适用于「基础积分包」**（套餐自带的那 500 分）：
     * 官方计费文档写明个人体验版「到期系统会自动免费续期，不会产生任何费用」，
     * 但**基础积分包**确实随套餐周期重置（截图实测：套餐 2026-09-26 →
     * 2026-10-27，基础包 500 分同期作废）。
     *
     * ⚠️ **不能**套到赠送包/按需包上：签到积分的有效期是「发放日 +30 天」
     * （逐笔各不相同），按需包按消费实时结算。给它们套套餐周期就是编造。
     */
    const packageEndMs = packageEndDate === undefined ? undefined : parseDateMs(packageEndDate);
    for (const item of metrics) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const name = readString(record, 'name');
        const label = CREDIT_METRIC_LABELS[name];
        if (label === undefined)
            continue;
        sawAnyCreditMetric = true;
        const amount = readNumber(record, 'package_credit_amount');
        const used = readNumber(record, 'package_credit_used');
        const remain = readNumber(record, 'package_credit_remain');
        if (name === TOTAL_CREDIT_METRIC) {
            totalRemain = remain;
            // 只认总额 metric 上的那个标量（见上方注释：分类上也有同名字段）。
            const expiring = readOptionalNumber(record, 'package_credit_expiring_amount');
            if (expiring !== undefined && expiring > 0)
                expiringTotal = expiring;
            /**
             * ★ **总包不列为资源包**：它是「基础 + 按需 + 赠送」的**汇总行**，
             * 与下面三个分类是同一批积分的两种视图。
             *
             * 把它和分类一起 push 会让 `packages` 求和**翻倍**（实测 2026-10-20：
             * 总包 25500 + 基础 500 + 赠送 25000 = 51000，而 `total` 是 25500）。
             * 那不只是数字难看 —— 三档分档（永久/长期/临期）是按 `packages`
             * 逐包累加的，重复计数会让「永久桶」凭空多出一倍，锁定永久积分时
             * 就会误判「还有大量永久额度可用」而继续烧临期额度。
             *
             * `totalRemain` 已单独记下总额，`total` 不受影响。
             */
            continue;
        }
        // 额度为 0 的分类不列为资源包：列出来只会让「N 个资源包」虚高。
        if (amount <= 0 && remain <= 0)
            continue;
        /**
         * 只有**基础积分包**能拿到确切的到期时刻（= 套餐周期结束）。
         *
         * 其余分类（按需 / 赠送）如实留空 —— `undefined` 表示「到期时间未知」，
         * 分档时归入永久桶（保守方向）。绝不拿套餐周期去套它们：签到积分的
         * 有效期是逐笔「发放日 +30 天」，套错了会让用户以为明天就作废。
         */
        const deductionEndTime = name === BASIC_CREDIT_METRIC ? packageEndMs : undefined;
        /**
         * 本分类里「即将到期」的额度。
         *
         * ⚠️ 只在**没有确切到期时刻**时才需要它（赠送/按需包）：分档拿不到
         * `deductionEndTime` 就会把整包算进永久桶，那 25000 分里其实有 2000
         * 快作废 —— 只说「另有 2000 即将到期」而不调整分档，两个数字会打架
         * （用户 2026-10-20 报障：「2000+500临期不应该是2500嘛」）。
         *
         * ⚠️ 基础包已有真实时刻，**不**读本字段：两者同时生效会重复计入临期。
         */
        const expiringRaw = deductionEndTime === undefined
            ? readOptionalNumber(record, 'package_credit_expiring_amount')
            : undefined;
        // 夹在 [0, remain] 内：上游若给超（不该发生），宁可少算临期也不让
        // 「永久 + 临期」超过本包余额（那会让分档合计与 total 脱钩）。
        const expiringRemaining = expiringRaw === undefined || expiringRaw <= 0
            ? undefined
            : Math.min(expiringRaw, remain);
        packages.push({
            name: label,
            unit: 'credit',
            remaining: remain,
            total: amount,
            used,
            active: true,
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: deductionEndTime === undefined ? '' : new Date(deductionEndTime).toISOString(),
            ...deductionEndTime === undefined ? {} : { deductionEndTime },
            ...expiringRemaining === undefined ? {} : { expiringRemaining },
        });
    }
    if (!sawAnyCreditMetric)
        return undefined;
    const total = roundCredits(totalRemain ?? packages.reduce((sum, pkg) => sum + pkg.remaining, 0));
    return {
        total,
        packages,
        expiredTotal: 0,
        ...expiringTotal === undefined ? {} : { expiringTotal },
    };
}
/**
 * 查询账户/套餐信息 —— 含**积分账户检测**。
 *
 * 返回 `null` 表示查询失败（网络/签名/结构问题），与「查到了但非积分账户」
 * （返回 `isCreditPackage: false` 的对象）严格区分：前者要用户排查网络或
 * 重新登录，后者是正常的账户类型差异。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsAccountInfoDetailed}。
 */
export async function fetchCodeArtsAccountInfo(credential, fetcher = fetch) {
    const result = await fetchCodeArtsAccountInfoDetailed(credential, fetcher);
    return result.ok ? result.info : null;
}
/**
 * 查询账户/套餐信息，失败时**保留底层原因**。
 *
 * 为什么需要带原因的版本：领取流程里「账户信息查询失败」可能源于网络超时、
 * 签名错误或凭据过期，把它们统一压成一句笼统文案，会让用户与排查者都拿不到
 * 线索（本仓库在 `credits.ts` / `lobsterai-credits.ts` 都刻意保留原始错误消息）。
 */
export async function fetchCodeArtsAccountInfoDetailed(credential, fetcher = fetch) {
    const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`;
    const result = await signedSnapRequest('GET', url, credential, undefined, fetcher);
    if (!result.ok)
        return { ok: false, code: result.code, message: result.message };
    const data = result.data;
    const pkg = readRecord(data, 'package');
    const packageNameCn = readString(pkg, 'package_name_cn');
    const packageNameEn = readString(pkg, 'package_name_en');
    return {
        ok: true,
        info: {
            isCreditPackage: readBool(pkg, 'is_credit_package'),
            isTokenPackage: readBool(pkg, 'is_token_package'),
            specCode: readString(pkg, 'spec_code'),
            packageName: packageNameCn.length > 0 ? packageNameCn : packageNameEn,
            packageStatus: readString(pkg, 'status'),
            // `end_date` 是套餐周期结束日（顶层字段，与 `package` 同级）。
            // 只有基础积分包跟随它到期，见 `parseCreditBalance` 的注释。
            credit: parseCreditBalance(data.metrics, readString(data, 'end_date')),
        },
    };
}
/** 把活动列表的一项解析为 {@link CodeArtsOpsActivity}。 */
function parseActivity(item) {
    return {
        // 用 readIdentifier 而非 readString：实测 campaignId 是**数字** 1。
        campaignId: readIdentifier(item, 'campaignId'),
        type: readString(item, 'type'),
        title: readString(item, 'title'),
        claimable: readBool(item, 'claimable'),
        status: readString(item, 'status'),
        // 可领积分数：实测字段名是 `benefitAmount`（值 1000）。
        // 保留另两个候选名作兼容回退，取不到才为 0。
        amount: readNumber(item, 'benefitAmount')
            || readNumber(item, 'amount')
            || readNumber(item, 'creditAmount'),
    };
}
/**
 * 查询活动列表。
 *
 * 返回 `null` 表示查询失败；返回数组（可能为空）表示查询成功。
 * 与 `credits.ts` 的取舍一致：把「查不到」与「没有活动」分开，
 * 否则网络故障会显示成「活动未开启」，把用户引向错误的排查方向。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsOpsActivitiesDetailed}。
 */
export async function fetchCodeArtsOpsActivities(credential, fetcher = fetch) {
    const result = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher);
    return result.ok ? result.activities : null;
}
/** 查询活动列表，失败时保留底层原因。 */
export async function fetchCodeArtsOpsActivitiesDetailed(credential, fetcher = fetch) {
    const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_DELIVERY_PATH}?channel=${CODEARTS_OPS_CHANNEL}`;
    const result = await signedSnapRequest('GET', url, credential, undefined, fetcher);
    if (!result.ok)
        return { ok: false, code: result.code, message: result.message };
    const items = result.data.items;
    if (!Array.isArray(items))
        return { ok: false, code: -1, message: '响应缺少 items 字段' };
    return {
        ok: true,
        activities: items
            .filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
            .map(parseActivity),
    };
}
/** 在活动列表里找「每日签到」那一项；没有则返回 undefined。 */
export function findDailyCheckinActivity(activities) {
    return activities.find((activity) => activity.type === CODEARTS_DAILY_LOGIN_TYPE);
}
/**
 * 执行每日签到领取（完整流程）。
 *
 * 步骤与判定顺序（每一步都对应一个**对用户含义不同**的结果）：
 *
 * 1. 查账户类型 —— 查询失败 → `failed`；
 * 2. 查活动列表 —— 查询失败 → `failed`；
 * 3. **以活动列表为准**：无 `USER_LOGIN` 活动 / 不可领取时，才用账户类型给出
 *    `inactive` 的说明文案（非积分账户 → 「不在积分活动范围」，否则 → 「未找到
 *    每日签到活动」）；活动可领取 → **直接领**（不看 `isCreditPackage`）；
 * 4. 活动不可领取且状态属已领取态 → `already-claimed`；其余不可领取 → `inactive`；
 * 5. `POST /v1/ops/claim` —— 失败 → `failed`（业务码 `40001` 例外，见下）；
 * 6. 响应 `id !== null` 时补 `POST /v1/ops/confirm`（漏掉会让积分停在待确认）；
 * 7. 成功 → `claimed`。
 *
 * ⚠️ **为什么不再用 `isCreditPackage` 当门禁**（2026-10-08 实测，第三重根因）：
 * 体验版账号（`spec_code=codearts.agent.trial`、`is_credit_package=false`、
 * `is_token_package=true`）的 `statistics/plugin` 里**没有**任何积分 metric，
 * 但同一凭据下 `GET /v1/ops/delivery` 明确返回 `USER_LOGIN` 活动且
 * `claimable:true`，`POST /v1/ops/claim` 实测 **HTTP 200 并真发 1000 积分**
 * （`status:"CLAIMED"`、`totalAmount:1000`）。旧的 `!isCreditPackage ⇒ inactive`
 * 提前返回是**假阴性**：凭据修好了也永远显示「Token 计费账户，不在积分活动范围」，
 * 用户永远看不到「签到成功」。故改为「活动列表说了算」——服务端给了可领取的
 * 每日签到活动就领，账户类型只用来**修饰不可领取时的文案**。
 *
 * 注意第 4 步是主要的幂等保护：本协议没有幂等键，预检不能省。此外服务端在
 * 重复领取时回业务码 `40001`（「尚未到达权益刷新时间，暂时无法领取」，实测），
 * 该码必须如实判为 `already-claimed` 而不是 `failed` —— 否则用户重复点击会看到
 * 一个并不存在的故障。
 */
export async function claimCodeArtsDailyCheckin(credential, fetcher = fetch) {
    const infoResult = await fetchCodeArtsAccountInfoDetailed(credential, fetcher);
    if (!infoResult.ok) {
        // 透传底层 code（401/403 ⇒ 凭据过期 ⇒ 上层可自愈重试；-1 ⇒ 网络/解析故障）。
        return { kind: 'failed', code: infoResult.code, message: `账户信息查询失败：${infoResult.message}` };
    }
    const info = infoResult.info;
    const activitiesResult = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher);
    if (!activitiesResult.ok) {
        return { kind: 'failed', code: activitiesResult.code, message: `活动列表查询失败：${activitiesResult.message}` };
    }
    const activity = findDailyCheckinActivity(activitiesResult.activities);
    if (activity === undefined) {
        // 活动列表是权威：服务端没给每日签到活动 ⇒ 该账号确实不在活动范围。
        // 此时才用账户类型修饰文案（`isCreditPackage=false` 的账号给出更具体的原因）。
        return {
            kind: 'inactive',
            message: info.isCreditPackage
                ? '未找到每日签到活动'
                : info.isTokenPackage
                    ? 'Token 计费账户，不在积分活动范围'
                    : '非积分计费账户，不在积分活动范围',
        };
    }
    if (!activity.claimable) {
        return CLAIMED_STATUSES.includes(activity.status)
            ? { kind: 'already-claimed', message: '今天已领取' }
            : { kind: 'inactive', message: `当前不可领取（status=${activity.status}）` };
    }
    if (activity.campaignId.length === 0) {
        return { kind: 'failed', code: -1, message: '活动缺少 campaignId，无法领取' };
    }
    const claimResult = await signedSnapRequest('POST', `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CLAIM_PATH}`, credential, JSON.stringify({ campaignId: activity.campaignId, channel: CODEARTS_OPS_CHANNEL }), fetcher);
    if (!claimResult.ok) {
        // 服务端幂等业务码：活动列表缓存还没刷新时重复领取会回 40001
        // （实测文案「尚未到达权益刷新时间，暂时无法领取」）。这是**今天已经领过**，
        // 不是故障；判成 failed 会让用户看到一个并不存在的错误。
        if (claimResult.code === CODEARTS_ALREADY_CLAIMED_CODE) {
            return { kind: 'already-claimed', message: '今天已领取' };
        }
        return { kind: 'failed', code: claimResult.code, message: claimResult.message };
    }
    // 服务端要求确认时才补 confirm：IDE 的判据是 `benefit.id !== null`。
    // confirm 失败**不**把整体判为失败 —— 积分已进入待确认态，报 failed 会让
    // 用户以为没领到而重复点击；这里如实返回 claimed，把确认异常留在日志层。
    const benefitId = claimResult.data.id;
    if (benefitId !== null && benefitId !== undefined) {
        await signedSnapRequest('POST', `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CONFIRM_PATH}`, credential, JSON.stringify({ campaignId: activity.campaignId }), fetcher);
    }
    // 积分取多级回退：领取响应 → 活动条目。两处都没有时如实记 0，
    // 不臆造「1000」——文档里的 1000 是活动规则，不是本次发放的实测值。
    //
    // `benefitAmount` 排在首位：活动列表用的就是这个字段名（实测 1000），
    // 领取响应大概率同源；其余候选名保留作兼容。
    const claimCredit = readNumber(claimResult.data, 'benefitAmount')
        || readNumber(claimResult.data, 'credit')
        || readNumber(claimResult.data, 'credits')
        || readNumber(claimResult.data, 'creditAmount')
        || readNumber(claimResult.data, 'amount');
    return {
        kind: 'claimed',
        credit: claimCredit > 0 ? claimCredit : activity.amount,
        // CodeArts 的活动不下发连续签到天数概念（那是 CodeBuddy 的机制）。
        streakDays: 0,
        isStreakDay: false,
    };
}
/**
 * 领取限时福利（opengw `POST /api/v1/benefit/claim`，幂等；成功判据 `error_code === '0000'`）。
 *
 * ## 为什么需要它（对标实测）
 *
 * HITZY2002/codearts2api 的 README（原文核实）：「限时福利模型**必须先领取才能调用**：
 * 未领取时上游一律返回 `InferHub.4004.200 benefit not found`（实测）。领取是幂等
 * 操作，官方客户端打开模型菜单时也会调用」。它默认开启 `benefit_auto_claim`，
 * 其 `ClaimBenefit` 即本函数所复刻的报文。
 *
 * ## 与每日签到积分是两条独立协议，别混
 *
 * | 领取什么 | host | 路径 | 请求体 | 成功判据 |
 * |---|---|---|---|---|
 * | 每日签到积分 | snap-access | `/v1/ops/claim` | `{campaignId, channel}` | 信封 `code`（`40001` = 今天已领） |
 * | **限时福利额度** | **opengw** | `/api/v1/benefit/claim` | **`{}`** | **`error_code === '0000'`** |
 *
 * ⚠️ `X-Language` 必须**签名之后**追加 —— 进 canonical request 会验签失败
 * （与 {@link SNAP_EXTRA_HEADERS} 注释记录的是同一族坑，实测于 snap 路径）。
 * ⚠️ 网络/解析/非 2xx 一律归 `failed` 而不抛错：调用方（`llm-adapter.ts` 的
 * benefit 分支）只关心「领到了没有」，领不到就退回原有的去头降级。
 */
export async function claimCodeArtsBenefit(credential, fetcher = fetch, 
/**
 * ⚠️ **必须接调用方的 signal**（2026-10-27 审计修）。
 *
 * 修前本函数自带一个 30 秒的 `AbortSignal.timeout`，与 `options.signal`
 * **完全无关** ⇒ 用户按下「停止」后，这条**写请求**仍会继续跑到超时
 * （最多再等 30 秒），而适配器里其它 await（`delay(…, options.signal)`）都是可中断的。
 */
options) {
    const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
    if (!ak || !sk)
        return 'failed';
    const url = CODEARTS_BENEFIT_CLAIM_URL;
    const body = '{}';
    try {
        const signed = await signRequestHuawei(ak, sk, st, 'POST', url, new TextEncoder().encode(body));
        const headers = new Headers();
        signed.forEach((value, key) => {
            if (key !== 'host')
                headers.set(key, value);
        });
        headers.set('X-Language', 'zh-cn');
        const response = await fetcher(url, {
            method: 'POST',
            headers,
            body,
            /**
             * ⚠️ 两个信号**合并**：既保留自身的 30s 兜底超时，又能被调用方的
             * 「停止」立即打断（`AbortSignal.any` 是 Node 20+ 标准）。
             * 修前这里恒为 `AbortSignal.timeout(...)` ⇒ 用户按停止后这条**写请求**
             * 仍会跑到超时（最多再等 30 秒）。
             */
            signal: options?.signal === undefined
                ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                : AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!response.ok)
            return 'failed';
        const parsed = JSON.parse(await response.text());
        const code = typeof parsed === 'object' && parsed !== null
            ? parsed.error_code
            : undefined;
        return code === '0000' ? 'success' : 'failed';
    }
    catch {
        return 'failed';
    }
}
/**
 * 把额度规整为两位小数。
 *
 * 与 `credits.ts` / `lobsterai-credits.ts` 同口径：多包相加会把服务端的
 * 浮点尾数（如 55.67000031）显式化，金额展示到分即可。
 */
function roundCredits(value) {
    return Math.round(value * 100) / 100;
}
//# sourceMappingURL=codearts-credits.js.map