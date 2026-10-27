/**
 * Codely（Unity 团结引擎）**积分余额**查询。
 *
 * ## 数据来源（2026-10-19 真凭据实测）
 *
 *     GET https://codely.tuanjie.cn/api/user/usage/summary
 *     Authorization: Bearer <access_token>
 *     X-User-Agent: codely-vscode/4.3.0
 *     → 200 {"remaining_points":"2400","is_exhausted":false,
 *            "details":[{"type":"gift_credit","remaining_points":"2400","exhausted":false}]}
 *
 * ⚠️⚠️ **`remaining_points` 是字符串**（`"2400"`），顶层与 `details[]` 里都是
 * —— 必须按「string | number」双形态解析（与 officeace 的 `totalPoint`
 * 同一类坑）；解析不出**不得**回落成 0（0 的语义是「已用光」）。
 *
 * ## ⚠️ details[] 是逐桶结构，必须逐桶映射（zcode 多桶教训）
 *
 * `details[]` 与 zcode 的 `buckets[]` 同型（每桶自己的 `type` / 余量 /
 * `exhausted`）。**不能只取第一桶或只看顶层汇总** —— 多桶账号（如充值积分 +
 * 赠送积分并存）的其余桶会被静默丢掉。顶层 `remaining_points` 是全桶汇总，
 * 与逐桶之和自洽时二者任取其一展示，但**包列表必须逐桶**。
 *
 * ⚠️ 探测过程留档：同域 `/api/user/info`、`/api/points/balance`、
 * `/api/points/summary` 均为 **404**（不是 SPA 假 200，可信）；
 * `usage/summary` 是唯一命中的余额端点。
 *
 * @module src/codely-credits.ts
 */
import { CODELY_API_BASE, CODELY_HTTP_TIMEOUT_MS, CODELY_USER_AGENT_HEADER } from './codely-auth.js';
/** 积分端点路径（实测 200；同域其余候选均已 404）。 */
export const CODELY_USAGE_SUMMARY_PATH = '/api/user/usage/summary';
/**
 * `details[].type` 的展示名映射。
 *
 * ⚠️ 只登记**实测见过**的桶类型；未知类型**不猜** —— 用原样 type 当名字，
 * 宁可显示 `gift_credit` 也不要写一个看似官方的中文假名（「绝不编造」红线）。
 */
const DETAIL_TYPE_LABELS = {
    gift_credit: '赠送积分',
};
/**
 * 解析「字符串优先」的积分数；不是有限非负数时返回 `undefined`（= 读不到）。
 *
 * ⚠️ 实测该字段是**字符串** `"2400"`；`Number("") === 0`、`Number("  ") === 0`
 * ⇒ 空串/纯空白必须先挡掉，否则会把「读不到」翻成「0 已用光」。
 */
function readPoints(value) {
    let n;
    if (typeof value === 'number') {
        n = value;
    }
    else if (typeof value === 'string' && value.trim().length > 0) {
        n = Number(value.trim());
    }
    else {
        return undefined;
    }
    if (!Number.isFinite(n) || n < 0)
        return undefined;
    return Math.floor(n);
}
/**
 * 拉取 Codely 积分余额（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ## 失败分类（与 modelscope 同法，压成一句「查询失败」会丢线索）
 *
 * - `401` ⇒ **令牌无效/已过期** ⇒ 重新登录（设备码流程）；
 * - `200` 但缺字段 ⇒ **上游改版** ⇒ 报「读数格式变了」，不显示 0；
 * - 网络/超时 ⇒ 查网络。
 */
export async function fetchCodelyBalanceDetailed(credential, options = {}) {
    const accessToken = credential?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { balance: null, error: '没有可用的 Codely 访问令牌（账号可能未完成登录）' };
    }
    const fetcher = options.fetcher ?? fetch;
    let response;
    try {
        response = await fetcher(`${CODELY_API_BASE}${CODELY_USAGE_SUMMARY_PATH}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'X-User-Agent': CODELY_USER_AGENT_HEADER,
            },
            signal: AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
        });
    }
    catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError'
            ? '请求超时'
            : '网络请求失败';
        return { balance: null, error: `Codely 积分查询失败：${reason}` };
    }
    if (response.status === 401) {
        return { balance: null, error: 'Codely 访问令牌无效或已过期（HTTP 401），请删除该账号后重新「+ 新建账号」登录' };
    }
    const text = await response.text().catch(() => '');
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return {
            balance: null,
            error: `Codely 积分响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`,
        };
    }
    // ── 逐桶解析（details[] 优先；缺失时退回顶层汇总单桶）──
    const details = Array.isArray(body.details) ? body.details : [];
    const topRemaining = readPoints(body.remaining_points);
    const packages = [];
    let sumFromDetails = 0;
    let sawUnreadable = false;
    for (const detail of details) {
        if (detail === null || typeof detail !== 'object')
            continue;
        const remaining = readPoints(detail.remaining_points);
        if (remaining === undefined) {
            // ⚠️ 单桶读不到不静默丢弃（zcode 多桶教训：丢桶 = 数字对不上）；
            //    记下来，最后统一判「读数格式变了」。
            sawUnreadable = true;
            continue;
        }
        const type = typeof detail.type === 'string' && detail.type.length > 0 ? detail.type : '';
        packages.push({
            // ⚠️ 未知桶类型不猜名字：原样 type，绝不编造官方中文假名。
            name: type !== '' ? (DETAIL_TYPE_LABELS[type] ?? type) : 'Codely 积分',
            total: remaining,
            used: 0,
            remaining,
            unit: 'credit',
            active: detail.exhausted !== true,
            // 上游不下发任何时间信息（与魔搭同因），填空串 = 「不适用」，
            // 不编造到期时间。
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: '',
        });
        sumFromDetails += remaining;
    }
    if (packages.length === 0) {
        if (topRemaining !== undefined && !sawUnreadable) {
            // 没有 details（或空数组）：顶层汇总单桶兜底 —— 这是「上游只给总数」
            // 的诚实呈现，不是编造（数字来自实测字段）。
            packages.push({
                name: 'Codely 积分',
                total: topRemaining,
                used: 0,
                remaining: topRemaining,
                unit: 'credit',
                active: body.is_exhausted !== true,
                cycleStartTime: '',
                cycleEndTime: '',
                expiredTime: '',
            });
            sumFromDetails = topRemaining;
        }
        else {
            // details 有桶但全都读不到，或连顶层都没有：读数格式变了，
            // 绝不显示 0（0 = 已用光，会误导用户）。
            return { balance: null, error: 'Codely 响应里没有可读的积分数字（上游可能改版），无法显示余额' };
        }
    }
    return {
        balance: {
            // 汇总优先用顶层下发值（它是权威的全桶汇总）；缺席时退逐桶之和。
            total: topRemaining ?? sumFromDetails,
            packages,
            expiredTotal: 0,
        },
    };
}
// ────────────────────────── 每日签到（写操作） ──────────────────────────
/**
 * 签到端点（2026-10-20 真凭据实测，两步都 200）。
 *
 * 来源是**网页 dashboard 的 SPA bundle**（`/static/web/assets/index-*.js`，
 * 官方 CLI 二进制里没有签到调用 —— 它只管推理/余额）。流程与网页一致：
 *
 *     POST /api/points/check-in/init   → 状态（先查，**不发积分**）
 *     POST /api/points/check-in        → 执行（can_check_in === true 时才发）
 *
 * `init` 实测报文（签到前）：
 *
 *     { "month":"2026-10", "timezone":"Asia/Shanghai",
 *       "activity_status":"ACTIVE", "check_in_status":"READY",
 *       "check_in_count":19, "max_count":31, "can_check_in":true,
 *       "levels":[{ "level":1, "status":"COMPLETED", "reward_summary":"+300" },
 *                 …, { "level":20, "status":"CURRENT", "reward_summary":"+300" }, …] }
 *
 * 执行后 `check_in_status:"COMPLETED"`、`check_in_count` +1、`can_check_in:false`。
 */
export const CODELY_CHECKIN_INIT_PATH = '/api/points/check-in/init';
export const CODELY_CHECKIN_PATH = '/api/points/check-in';
/**
 * `activity_status` 的展示文案（来源：网页 bundle 的 `DLt` 映射，逐字取用）。
 * 未知值不猜 —— 落到通用文案并带上原值，绝不编造一个看似官方的解释。
 */
const ACTIVITY_STATUS_LABELS = {
    NOT_CONFIGURED: '本月活动暂未开放',
    PENDING: '本月活动尚未开始',
    EXPIRED: '本月活动已结束',
};
/** 从 `reward_summary`（如 `"+300"`）解析本次可领积分数；解析不出返回 `undefined`。 */
function parseRewardSummary(value) {
    if (typeof value !== 'string')
        return undefined;
    const n = Number.parseInt(value.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
/**
 * 读取一个字符串字段；不是非空字符串返回 `undefined`（不猜）。
 */
function readStatus(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** 两步 POST 的公共部分：Bearer + 官方身份头，30s 超时。 */
async function postCheckIn(path, accessToken, fetcher) {
    const response = await fetcher(`${CODELY_API_BASE}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-User-Agent': CODELY_USER_AGENT_HEADER,
        },
        body: '{}',
        signal: AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok)
        return { ok: false, status: response.status, body: undefined };
    let body;
    try {
        body = JSON.parse(await response.text());
    }
    catch {
        return { ok: false, status: response.status, body: undefined };
    }
    return { ok: true, status: response.status, body };
}
/**
 * 领取 Codely 每日签到积分（**写操作**，幂等判据在 `init` 的 `can_check_in`）。
 *
 * ## 流程（与网页 dashboard 同序，且**绝不跳过 init 直接执行**）
 *
 * 1. `init` 查状态：活动未开放（`activity_status !== 'ACTIVE'`）⇒ `inactive`；
 *    `check_in_status === 'UNAVAILABLE'` ⇒ `failed`（上游的 `error` 字段透传）；
 *    `can_check_in !== true` ⇒ `already-claimed`（含 `PROCESSING` / `CREDIT_PENDING`
 *    这两个「签到已受理、积分未到账」的过渡态 —— 此时再发执行请求只会白打）；
 * 2. `can_check_in === true` 才发 `check-in` 执行；执行后按 `check_in_status`
 *    判成败（`COMPLETED` ⇒ claimed）。
 *
 * ## credit 数额的来源（不编造）
 *
 * 上游**不在执行响应里返回「本次领到多少」**；可用的唯一数字是 `init` 报文
 * `levels[]` 里 `status === 'CURRENT'` 那级的 `reward_summary`（实测 `"+300"`）。
 * 解析不出时如实返回 `credit: 0` + `delayedMessage`（autoclaw 先例：0 不代表
 * 没领到，调用方会刷新余额）—— 绝不拿 `max_count` 或上一级的数字凑数。
 *
 * ⚠️ `streakDays` 刻意给 0：`check_in_count` 是**本月累计次数**，不是连续天数，
 * 塞进「连续 N 天」的展示槽位就是编造读数（provider-runtime 对
 * `fetchStatus` 有同款红线）。Codely 没有连续天数概念。
 */
export async function claimCodelyDailyCheckIn(credential, options = {}) {
    const accessToken = credential?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { kind: 'failed', code: -1, message: '没有可用的 Codely 访问令牌（账号可能未完成登录）' };
    }
    const fetcher = options.fetcher ?? fetch;
    // ── 第 1 步：init 查状态（不发积分）──
    let state;
    try {
        const init = await postCheckIn(CODELY_CHECKIN_INIT_PATH, accessToken, fetcher);
        if (!init.ok || init.body === undefined) {
            return {
                kind: 'failed',
                code: -1,
                message: `Codely 签到状态查询失败（HTTP ${init.status}）：响应不是 JSON 或端点改版`,
            };
        }
        state = init.body;
    }
    catch (error) {
        return {
            kind: 'failed',
            code: -1,
            message: `Codely 签到网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const activityStatus = readStatus(state.activity_status);
    if (activityStatus !== undefined && activityStatus !== 'ACTIVE') {
        return {
            kind: 'inactive',
            message: ACTIVITY_STATUS_LABELS[activityStatus] ?? `签到活动状态异常（${activityStatus}）`,
        };
    }
    // ⚠️ `UNAVAILABLE` 是上游明确说的「签到暂不可用」，带 `error` 原文 —— 透传，
    //    压成「签到失败」会丢掉唯一有用的线索。
    if (state.check_in_status === 'UNAVAILABLE') {
        const reason = readStatus(state.error) ?? '签到暂不可用';
        return { kind: 'failed', code: -1, message: `Codely 签到暂不可用：${reason}` };
    }
    if (state.can_check_in !== true) {
        const count = typeof state.check_in_count === 'number' ? state.check_in_count : undefined;
        return {
            kind: 'already-claimed',
            message: count === undefined
                ? '今天已签到'
                : `今天已签到（本月已累计 ${count}/${typeof state.max_count === 'number' ? state.max_count : '?'} 次）`,
        };
    }
    // ── 本次可领数额：init 报文里 CURRENT 级的 reward_summary ──
    const levels = Array.isArray(state.levels) ? state.levels : [];
    const current = levels.find((level) => level !== null && typeof level === 'object' && level.status === 'CURRENT');
    const reward = current === undefined ? undefined : parseRewardSummary(current.reward_summary);
    // ── 第 2 步：执行签到 ──
    try {
        const done = await postCheckIn(CODELY_CHECKIN_PATH, accessToken, fetcher);
        if (!done.ok || done.body === undefined) {
            return {
                kind: 'failed',
                code: -1,
                message: `Codely 签到执行失败（HTTP ${done.status}）：响应不是 JSON 或端点改版`,
            };
        }
        const finalStatus = readStatus(done.body.check_in_status);
        if (finalStatus !== 'COMPLETED') {
            // ⚠️ PROCESSING / CREDIT_PENDING 等「已受理未到账」的态如实归入
            //    already-claimed（今天这条已处理），不报成功也不报失败。
            const count = typeof done.body.check_in_count === 'number' ? done.body.check_in_count : undefined;
            return {
                kind: 'already-claimed',
                message: count === undefined
                    ? `签到已受理（状态 ${finalStatus ?? '未知'}），奖励到账前请勿重复操作`
                    : `签到已受理（本月已累计 ${count} 次），奖励到账前请勿重复操作`,
            };
        }
        const count = typeof done.body.check_in_count === 'number' ? done.body.check_in_count : undefined;
        return {
            kind: 'claimed',
            credit: reward ?? 0,
            streakDays: 0,
            isStreakDay: false,
            // ⚠️ credit 为 0 = 「上游没给出可解析的数额」，不是「没领到」（autoclaw 同款取舍）。
            ...(reward === undefined
                ? { delayedMessage: '签到成功（上游未返回本次积分数额，请查看刷新后的余额）' }
                : {}),
        };
    }
    catch (error) {
        return {
            kind: 'failed',
            code: -1,
            message: `Codely 签到网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
//# sourceMappingURL=codely-credits.js.map