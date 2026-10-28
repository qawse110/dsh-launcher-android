/**
 * TRAE「1024 程序员节每日打卡抽奖」—— 活动状态读取与参与。
 *
 * ## 契约全部来自真机取证（2026-10-20，Trae CN 客户端 + 实测）
 *
 * | 项 | 值 |
 * |---|---|
 * | 读活动 | `POST {host}/trae/api/v2/ug/activity/info`，body `{ version_code, req_source }` |
 * | **参与抽奖** | `POST {host}/trae/api/v2/ug/activity/action`，body `{ activity_id: 'checkin_1024', req_source }` |
 * | `req_source` | **数字**：IDE = `1`、Lite = `2`（客户端 `OGe(t,…)` 的 `t?2:1`）⇒ 我们恒 `1` |
 * | 活动 id | 客户端常量 `Y1 = 'checkin_1024'`（`common/checkinLottery.js`） |
 * | 重试 | 客户端对 `checkin_1024` **显式 `retry: 0`**（敏感写操作） |
 *
 * ## ⚠️⚠️ 三条实测边界（每一条都曾经让判据变错）
 *
 * 1. **`activity/info` 必须带 `req_source` + `version_code`**：空 body 只回 **6** 个
 *    通用活动，带齐后回 **8** 个 —— 多出来的正是 `checkin_1024` 与 `code_fission_202609`
 *    （账号级活动）。⇒ 缺参数会把「有资格」误判成「没有这个活动」。
 * 2. **`work_extra.grantable` / `granted` 是字符串 `"true"` / `"false"`，不是布尔**。
 *    客户端自己的 `_transformCommercialActivityInfo` 写的是 `o.grantable === true`
 *    —— 对字符串**恒假**（客户端自身缺陷）。⇒ 本实现**两种形态都接受**，
 *    否则会像客户端那样把「可领」判成「不可领」。
 * 3. **`checkin_1024` 只在活动窗口内出现**：实测窗口
 *    `2026-10-18T16:00Z → 2026-10-24T10:00Z`（北京时间 10-19 00:00 → 10-24 18:00）。
 *    ⇒ 窗口外 `activity_id` 缺失是**正常**，不得报错。
 *
 * ## 为什么「参与」是**独立导出**而不是塞进 `claimTraeDailyCheckin`
 *
 * 抽奖是**不可逆的写操作**、且每日次数有限（窗口内「每日签到领 100，再抽 88/888」）。
 * 把它嵌进签到主流程会让「只要签到成功就必然抽奖」成为**默认行为**，
 * 用户无法只签到不抽奖。⇒ 这里提供纯函数 + 独立入口，由调用方显式决定。
 * 客户端自己是在 `claimCheckinCredits` 成功后**直接 participate**（同一 Promise 链），
 * 我们**刻意不照抄**那一点：那条路一旦服务端拒绝，会把「签到成功」也拖进失败分支。
 */
import { TRAE_UG_ACTIVITY_ACTION_PATH, TRAE_UG_ACTIVITY_INFO_PATH, traeCheckinHeaders, } from './trae.js';
/**
 * CN 站 host（与签到端点同源）。
 *
 * ⚠️ 与 `trae-credits.ts` 的 `postJson` **同一字面量**：本家 CN 就一个 API 域，
 *    没有 `product.apiBaseUrl` 这种字段（不要去发明一个）。抽奖与签到同域 ⇒ 同一常量。
 */
const TRAE_CN_API_BASE = 'https://api.trae.cn';
/** 1024 打卡抽奖的活动 id（客户端常量 `Y1`）。 */
export const TRAE_CHECKIN_LOTTERY_ACTIVITY_ID = 'checkin_1024';
/**
 * `req_source` 取值：IDE = `1`、Lite/Trae Work = `2`。
 *
 * ⚠️ 它是**数字**而不是「来源字符串」（客户端 `OGe` 的 `t ? 2 : 1`）。
 *    我们按 IDE 侧行为恒发 `1`。
 */
export const TRAE_UG_REQ_SOURCE_IDE = 1;
/**
 * 把一个**可能**是布尔也可能是字符串的字段读成布尔。
 *
 * ⚠️⚠️ **这就是实测边界 ②**：真实响应里 `grantable` / `granted` 是 `"true"` / `"false"`
 *    字符串（长度 4 / 5 即它们）。客户端写 `=== true` ⇒ 对字符串恒假 ⇒ 自身缺陷。
 *    本函数同时接受：
 * - 布尔 ⇒ 原样；
 * - 字符串 ⇒ 去空白后小写，只认 `'true'` / `'false'`（其余 → `undefined`，**不臆造**）；
 * - 其他（含缺省）⇒ `undefined`。
 *
 * ⚠️ 返回 `undefined` 与 `false` **语义不同**：前者「上游没说」，后者「上游说不行」。
 *    调用方不得把 `undefined` 当成 `false`（那会把「不知道」误报成「没资格」）。
 */
export function readTraeBooleanish(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true')
            return true;
        if (text === 'false')
            return false;
    }
    return undefined;
}
/** 从响应里挑出活动数组；形状不对返回 `undefined`（不抛，交由调用方决定文案）。 */
export function extractTraeCommercialActivities(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const list = body['commercial_activities'];
    if (!Array.isArray(list))
        return undefined;
    const out = [];
    for (const item of list) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
        const o = item;
        const activityId = typeof o['activity_id'] === 'string' ? o['activity_id'] : undefined;
        if (activityId === undefined || activityId.length === 0)
            continue;
        const extra = (typeof o['work_extra'] === 'object' && o['work_extra'] !== null && !Array.isArray(o['work_extra'])
            ? o['work_extra'] : {});
        const num = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        };
        out.push({
            activityId,
            activityType: num(o['activity_type']) ?? 0,
            // ⚠️ `Enabled` 首字母大写是实测形态；同时兼容小写 `enable`（与客户端同款容错）。
            enabled: readTraeBooleanish(o['Enabled']) ?? readTraeBooleanish(o['enable']) ?? false,
            ...num(o['start_time_ms']) === undefined ? {} : { startTimeMs: num(o['start_time_ms']) },
            ...num(o['end_time_ms']) === undefined ? {} : { endTimeMs: num(o['end_time_ms']) },
            ...readTraeBooleanish(extra['eligible']) === undefined
                ? {} : { eligible: readTraeBooleanish(extra['eligible']) },
            ...readTraeBooleanish(extra['grantable']) === undefined
                ? {} : { grantable: readTraeBooleanish(extra['grantable']) },
            ...readTraeBooleanish(extra['granted']) === undefined
                ? {} : { granted: readTraeBooleanish(extra['granted']) },
        });
    }
    return out;
}
/** 现在是否落在活动窗口内（缺失窗口字段 ⇒ 视为**在**窗口内，不臆造过期）。 */
export function isTraeActivityInWindow(activity, now = Date.now()) {
    if (activity.startTimeMs !== undefined && now < activity.startTimeMs)
        return false;
    if (activity.endTimeMs !== undefined && now > activity.endTimeMs)
        return false;
    return true;
}
/**
 * **纯函数**：从活动列表判断「该不该抽」。
 *
 * ⚠️ 判据只有这一份 —— 抽奖是**不可逆写操作**，判错会白烧机会，
 *    故不允许调用点各写一套 `if`。
 *
 * ⚠️ 「拿不到 `eligible` / `grantable`」一律按 **不可参与** 处理（fail-closed）：
 *    宁可少抽一次，也不要因为字段缺失去撞一个可能已用掉的机会。
 *    这与本仓库「判据缺失不得当成功」的既有取向一致。
 */
export function decideTraeLottery(activities, now = Date.now()) {
    if (activities === undefined)
        return { kind: 'unavailable', reason: '活动列表形状不认识' };
    const activity = activities.find((a) => a.activityId === TRAE_CHECKIN_LOTTERY_ACTIVITY_ID);
    if (activity === undefined) {
        // ⚠️ 窗口外活动**根本不出现** ⇒ 这是正常情况，文案要区分开（不是错误）。
        return { kind: 'unavailable', reason: '当前账号没有 1024 抽奖活动（可能不在活动期）' };
    }
    if (!activity.enabled)
        return { kind: 'unavailable', reason: '活动未启用' };
    if (!isTraeActivityInWindow(activity, now)) {
        return { kind: 'unavailable', reason: '不在活动时间窗口内' };
    }
    // ⚠️ 顺序：**先判已抽**再判资格。已抽过的日子 `grantable` 通常也变 false，
    //    若先判 grantable 会把「今天已抽」误报成「不可参与」，用户看不出自己抽过了。
    if (activity.granted === true)
        return { kind: 'already' };
    if (activity.eligible !== true)
        return { kind: 'unavailable', reason: '该账号不在活动资格名单内' };
    if (activity.grantable !== true)
        return { kind: 'unavailable', reason: '当前不可参与（可能今日名额已用）' };
    return { kind: 'participate' };
}
/** 客户端默认版本号（`product.json` 的 appVersion 缺失时的兜底，仅用于 `version_code`）。 */
const DEFAULT_VERSION_CODE = '3.5.2';
/**
 * 读活动信息（**只读 GET 语义的 POST**，不产生任何写操作）。
 *
 * ⚠️ 必须带 `req_source` + `version_code`，否则**看不到账号级活动**（实测边界 ①）。
 *
 * @returns 活动数组；失败返回 `{ error }`，**不抛**（签到流程不该被它拖垮）。
 */
export async function fetchTraeLotteryActivities(credential, product, options = {}, userId) {
    const fetcher = options.fetcher ?? fetch;
    const uid = userId ?? credential.uid;
    try {
        const response = await fetcher(
        // ⚠️ host 与签到端点**同一 API 面**（见 `trae.ts` 的端点表）。
        `${TRAE_CN_API_BASE}${TRAE_UG_ACTIVITY_INFO_PATH}`, {
            method: 'POST',
            headers: traeCheckinHeaders(credential, product, uid),
            body: JSON.stringify({
                version_code: options.versionCode ?? DEFAULT_VERSION_CODE,
                req_source: TRAE_UG_REQ_SOURCE_IDE,
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        const text = await response.text();
        if (!response.ok)
            return { error: `活动信息请求失败（HTTP ${response.status}）` };
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return { error: '活动信息响应不是 JSON' };
        }
        const activities = extractTraeCommercialActivities(body);
        if (activities === undefined)
            return { error: '活动信息响应形状不认识' };
        return { activities };
    }
    catch (error) {
        return { error: `活动信息请求异常：${error instanceof Error ? error.message : String(error)}` };
    }
}
/**
 * **参与 1024 打卡抽奖**（写操作；每日一次，**不可逆**）。
 *
 * ## ⚠️⚠️ 与签到**刻意解耦**
 *
 * 客户端是在 `claimCheckinCredits` 成功后**同一 Promise 链里直接 participate**。
 * 我们**不照抄**那一点：抽奖失败会把「签到成功」也拖进失败分支（本仓库对
 * 「登录成功却因记账失败被报成失败」已有两轮事故史）。⇒ 本函数**独立入口**，
 * 由调用方显式调用，失败只回报自己。
 *
 * ## ⚠️ 三道前置闸门（任一不过 ⇒ `skipped`，**一个请求都不发**）
 *
 * 1. **先读活动状态**并跑 {@link decideTraeLottery}（`participate` 才继续）；
 * 2. **不重试**（客户端对 `checkin_1024` 显式 `retry: 0`）；
 * 3. 只发 `activity_id` + `req_source`，与客户端 body 逐字段一致
 *    （客户端还带了 `assertCheckinLotteryRequest` 的本地校验，我们没有那个上下文 ⇒ 不伪造）。
 *
 * ⚠️ **把「判定结果」与「服务端结果」分成两层**：跳过的原因与服务端拒绝的原因
 *    文案不同，混在一起用户无法判断「是我没资格」还是「抽奖失败了」。
 */
export async function participateTraeLottery(credential, product, options = {}, userId, now = Date.now()) {
    const uid = userId ?? credential.uid;
    const fetcher = options.fetcher ?? fetch;
    // 闸门 ①：**先读状态**。读不到就不发写请求（宁可少抽一次，也不盲写）。
    const info = await fetchTraeLotteryActivities(credential, product, options, uid);
    if (info.error !== undefined) {
        return { kind: 'skipped', reason: `活动状态读取失败：${info.error}` };
    }
    const decision = decideTraeLottery(info.activities, now);
    if (decision.kind !== 'participate') {
        return { kind: 'skipped', reason: decision.reason ?? decision.kind };
    }
    // 闸门 ②：**不重试**。写操作重试可能白烧当天机会（客户端同为 `retry: 0`）。
    try {
        const response = await fetcher(`${TRAE_CN_API_BASE}${TRAE_UG_ACTIVITY_ACTION_PATH}`, {
            method: 'POST',
            headers: traeCheckinHeaders(credential, product, uid),
            body: JSON.stringify({
                activity_id: TRAE_CHECKIN_LOTTERY_ACTIVITY_ID,
                req_source: TRAE_UG_REQ_SOURCE_IDE,
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        const text = await response.text();
        if (!response.ok) {
            return { kind: 'failed', code: response.status, message: `抽奖请求失败（HTTP ${response.status}）` };
        }
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return { kind: 'failed', message: '抽奖响应不是 JSON' };
        }
        const record = (typeof body === 'object' && body !== null && !Array.isArray(body)
            ? body : {});
        const rawCode = record['code'];
        const code = typeof rawCode === 'number' ? rawCode : Number(rawCode);
        const message = typeof record['message'] === 'string' && record['message'].length > 0
            ? record['message']
            : undefined;
        if (Number.isFinite(code) && code !== 0) {
            // ⚠️ 服务端文案**如实透传**：它可能写着「今日已参与」「不在活动期」等唯一线索。
            return {
                kind: 'failed',
                code,
                ...message === undefined ? {} : { message },
            };
        }
        const credits = readLotteryCredits(record);
        // ★ **奖品如实转述**（真机实测：抽到的可能是券，没有 `credits` 字段）。
        //    只用 `readLotteryCredits` 会让「抽到券」退化成「所得未知」，把已知信息白丢。
        const prizeText = describeTraeLotteryPrize(readTraeLotteryPrize(record));
        return {
            kind: 'ok',
            ...Number.isFinite(code) ? { code } : {},
            ...message === undefined ? {} : { message },
            ...credits === undefined ? {} : { credits },
            ...prizeText === undefined ? {} : { prizeText },
        };
    }
    catch (error) {
        return {
            kind: 'failed',
            message: `抽奖请求异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 从抽奖响应里读「本次获得多少积分」。
 *
 * ⚠️ **读不到就返回 `undefined`，绝不臆造 0** —— 本仓库已因「领取成功 +0 积分」
 *    报障三次（`trae-credits.ts:283`、`zcode-auth.ts:2053`、`provider-credits.ts:310`），
 *    根因都是「拿不到实际所得却照样报一个数字」。`0` 会被读成「没抽到」，
 *    与「不知道」是两件事。
 */
export function readLotteryCredits(record) {
    // 服务端可能把结果放在顶层，也可能在 `data` 里（两种都实测过同族形态）。
    const candidates = [record, record['data']];
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null)
            continue;
        const o = candidate;
        for (const key of ['credits', 'granted_credits', 'reward_credits', 'prize_credits']) {
            const raw = o[key];
            const n = typeof raw === 'number' ? raw : Number(raw);
            if (Number.isFinite(n) && n > 0)
                return n;
        }
    }
    return undefined;
}
/**
 * 抽奖**奖品**的如实描述（2026-10-20 真机实测补）。
 *
 * ## 为什么必须有它（实测打穿了我第一版）
 *
 * 真机抽到的响应是：
 * ```json
 * {"work_extra":{"coupon_face_amount_fen":1000,"eligible":true,"grantable":false,
 *                "granted":true,"prize_text":"AI Build 专属抵扣券","prize_type":2}}
 * ```
 * ⇒ **奖品是券，根本没有 `credits` 字段**。而第一版只用 {@link readLotteryCredits}
 *   读积分 ⇒ 抽到券时返回 `undefined` ⇒ 提示退化成「所得以 IDE 面板为准」，
 *   把 `prize_text`（"AI Build 专属抵扣券"）与 `coupon_face_amount_fen`（1000 分 = 10 元）
 *   这两条**已知的**真实信息**白丢了**。
 *
 * ⚠️ 判据：**只如实转述上游给的字段**，不猜、不换算成"多少积分"。
 *    券与积分是**不同单位**（本仓库红线：跨单位不得求和/不得混算）。
 *
 * @returns 可读描述；上游没给任何奖品字段 ⇒ `undefined`（不臆造"没抽到"）。
 */
export function readTraeLotteryPrize(record) {
    const candidates = [record, record['work_extra'], record['data'], record['data']?.['work_extra']];
    let text;
    let type;
    let couponFaceAmountFen;
    let credits;
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            continue;
        const o = candidate;
        if (text === undefined && typeof o['prize_text'] === 'string' && o['prize_text'].length > 0) {
            text = o['prize_text'];
        }
        if (type === undefined) {
            const n = Number(o['prize_type']);
            if (Number.isFinite(n))
                type = n;
        }
        if (couponFaceAmountFen === undefined) {
            const n = Number(o['coupon_face_amount_fen']);
            if (Number.isFinite(n) && n > 0)
                couponFaceAmountFen = n;
        }
        if (credits === undefined) {
            const n = readLotteryCredits(o);
            if (n !== undefined)
                credits = n;
        }
    }
    if (text === undefined && type === undefined && couponFaceAmountFen === undefined && credits === undefined) {
        return undefined;
    }
    return {
        ...text === undefined ? {} : { text },
        ...type === undefined ? {} : { type },
        ...couponFaceAmountFen === undefined ? {} : { couponFaceAmountFen },
        ...credits === undefined ? {} : { credits },
    };
}
/** 把 {@link readTraeLotteryPrize} 的结论转成**一句如实的中文提示**。 */
export function describeTraeLotteryPrize(prize) {
    if (prize === undefined)
        return undefined;
    const parts = [];
    if (prize.text !== undefined)
        parts.push(prize.text);
    if (prize.credits !== undefined)
        parts.push(`${prize.credits} 积分`);
    if (prize.couponFaceAmountFen !== undefined) {
        // ⚠️ 单位换算只在**展示**处做（上游给的是分）；换不成整数也照实显示分。
        const yuan = prize.couponFaceAmountFen / 100;
        parts.push(Number.isInteger(yuan) ? `${yuan} 元` : `${prize.couponFaceAmountFen} 分`);
    }
    return parts.length === 0 ? undefined : parts.join(' · ');
}
//# sourceMappingURL=trae-lottery.js.map