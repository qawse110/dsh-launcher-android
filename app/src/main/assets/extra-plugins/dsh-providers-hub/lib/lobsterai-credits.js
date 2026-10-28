/**
 * LobsterAI（有道龙虾）每日签到与积分余额。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）**刻意分开**：两者协议没有一处共用，
 * 硬合并只会让那个文件出现大量 `if (provider === 'lobsterai')` 分支。
 * 但**复用它的两个类型**（`ClaimOutcome` / `CheckinStatus` 风格的判别联合），
 * 让 `computeClaimSummary` 与 Jet Hub 的结果摘要 UI 一行都不用改。
 *
 * ## 协议（三步，来源 `lobsterai2api/sigin.py:51-67`）
 *
 * ```
 * 0) 版本号（必填参数）：GET {clientVersionApi} → data.value.version
 * 1) 查活动槽位  GET  /api/client-activities/slot?placement=…&clientVersion=…
 * 2) 查活动上下文 GET  /api/client-activities/{activityCode}/context?configRevision=…
 * 3) 签到        POST /api/client-activities/{activityCode}/actions/check_in
 * ```
 *
 * 认证是**纯 Bearer，无签名**（`sigin.py:32-48`）—— 与 CodeBuddy 那套
 * `X-Domain` / `X-Product` / `X-Enterprise-Id` 头族毫无关系。
 *
 * ## 幂等
 *
 * 与 CodeBuddy 靠服务端 `code:10001` 不同，LobsterAI 是**客户端幂等**：
 * 请求带 `idempotencyKey`（UUID4），且签到前先查 `context` 的
 * `state.claimedToday` 与 `actions` 是否含 `check_in`。
 * 两步预检查都要做 —— 只看 `claimedToday` 会漏掉「活动有但今天不该领」的情形。
 */
import { randomUUID } from 'node:crypto';
import { LOBSTERAI_MAX_NUMERIC_FIELD, LOBSTERAI_REQUEST_TIMEOUT_MS, parseLobsteraiEnvelope } from './lobsterai.js';
import { lobsteraiAuthHeaders } from './lobsterai.js';
/** 活动槽位查询端点。 */
export const LOBSTERAI_ACTIVITY_SLOT_PATH = '/api/client-activities/slot';
/** 活动上下文查询端点（需拼 activityCode）。 */
export const LOBSTERAI_ACTIVITY_CONTEXT_PATH = '/api/client-activities';
/** 积分余额端点。 */
export const LOBSTERAI_PROFILE_SUMMARY_PATH = '/api/user/profile-summary';
/**
 * 槽位查询的三个固定 query 参数（**照抄 `sigin.py:52-53`**）。
 *
 * 这些值是用真实客户端观察到的：`placement=desktop_sidebar` 声明「桌面端侧边栏」
 * 这一投放位，`containerApiVersion=2` 是容器协议版本，`platform=win32` 是
 * **伪装客户端形态** —— 即使本插件跑在 macOS/Linux 上也照发 win32，
 * 它与运行环境无关，改了可能拿不到活动。
 */
export const LOBSTERAI_SLOT_PLACEMENT = 'desktop_sidebar';
export const LOBSTERAI_SLOT_CONTAINER_API_VERSION = '2';
export const LOBSTERAI_SLOT_PLATFORM = 'win32';
/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析';
/**
 * 发起一次带认证的请求并解析 JSON。
 *
 * 网络失败时**保留原始错误消息**（含 timeout / socket hang up），
 * 不吞掉诊断信息 —— 这是 `credits.ts` 里已验证的做法。
 */
/**
 * 发起一次带认证的请求并解析 JSON。
 *
 * 网络失败时**保留原始错误消息**（含 timeout / socket hang up），
 * 不吞掉诊断信息 —— 这是 `credits.ts` 里已验证的做法。
 *
 * ⚠️ 与 `credits.ts` 的 `postJson` 同款：**不用 `response.json()`**。
 * 凭据失效时服务端可能返回 HTML 错误页，`json()` 抛出的
 * `Unexpected token '<' ...` 对用户毫无意义；先取文本再解析，
 * 非 JSON 时给出带状态码的可读原因。
 */
async function requestJson(url, credential, product, fetcher, init = { method: 'GET' }) {
    try {
        const response = await fetcher(url, {
            method: init.method,
            headers: lobsteraiAuthHeaders(credential, product),
            ...init.body === undefined ? {} : { body: init.body },
            signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return { ok: false, message: describeNonJsonResponse(response.status, text) };
        }
        if (typeof parsed !== 'object' || parsed === null) {
            return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE };
        }
        return { ok: true, body: parsed };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
/** 把「响应不是 JSON」整理成可读原因（与 `credits.ts` 同款）。 */
function describeNonJsonResponse(status, text) {
    if (status === 401 || status === 403) {
        return `凭据已失效（HTTP ${status}），请重新登录该账号`;
    }
    const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`;
}
/** 从 JSON 安全读取布尔值。 */
function readBool(source, key) {
    return source[key] === true;
}
/**
 * 从 JSON 读取可解析为数字的值（兼容字符串形态）；**不可解析时返回
 * `undefined`**，与「解析出来就是 0」严格区分。
 *
 * ⚠️ 本函数是**本文件内**「一个字段是不是数字」的判据源：`readNumber`（不可解析
 * 时兜底 0）与余额判据的 `parsedTotal`（不可解析即视为「没下发」）都必须经它，
 * 否则同一件事会出现两套同义判据（AGENTS.md 首条红线）——「服务端明确下发的 0」
 * 与「字段缺失」正是被这种分叉压成同一个分支的。
 *
 * ⚠️⚠️ **它不是全仓唯一判据源**（2026-10-12 审计实测订正）：`src/lobsterai.ts`
 * 的 `readNumberField` 是**同一 provider 的另一条路径**（供 `lobsterai-adapter.ts`
 * 解析远端目录），两者是**同语义判据**。该处曾缺 `Number.isFinite` 造成分叉，
 * 已同步补齐 —— **将来改这里必须同时改那里**。
 *
 * ## ⚠️⚠️ 上界（不是「有限」就够）
 *
 * `Number.isFinite` 只排除 `Infinity`/`NaN`，**不排除大到下游会溢出的值**：
 * 下游 `roundCredits(v) = Math.round(v * 100) / 100` 里 `v * 100` 在
 * `|v| > Number.MAX_VALUE / 100 ≈ 1.797e306` 时**自己就会溢出成 `Infinity`**。
 * 实测：308 位数字串（≈9.99e307）与 JSON 合法字面量 `1e308` 都能通过
 * `Number.isFinite`，却在 `roundCredits` 里变成 `Infinity`。
 * ⇒ 故这里再加一道**上界**：超过 `LOBSTERAI_MAX_NUMERIC_FIELD` 即视为不可解析
 *（积分是金额，这个上界比任何真实余额都大 9 个数量级以上，不会误伤）。
 * ⚠️ 上界常量与 `src/lobsterai.ts` 的 `readNumberField` **共用同一个**
 *（同语义判据不得分叉）。
 */
function parseNumericField(source, key) {
    const value = source[key];
    if (typeof value === 'number') {
        return Number.isFinite(value) && Math.abs(value) <= LOBSTERAI_MAX_NUMERIC_FIELD ? value : undefined;
    }
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        // ⚠️⚠️ **字符串分支同样必须过这两道守卫**：正则只保证「长得像定点数字」，
        // **不保证落在 double 范围内** —— 401 位纯数字串能通过正则，而
        // `Number(...)` 得到 `Infinity`；308 位串则「有限但下游会溢出」。
        // 数字分支与字符串分支必须**同口径**。
        const parsed = Number(value);
        if (Number.isFinite(parsed) && Math.abs(parsed) <= LOBSTERAI_MAX_NUMERIC_FIELD)
            return parsed;
    }
    return undefined;
}
/** 从 JSON 安全读取数字（兼容字符串形态）；不可解析时取 0。 */
function readNumber(source, key) {
    return parseNumericField(source, key) ?? 0;
}
/** 从 JSON 安全读取非空数组。 */
function readActions(source, key) {
    const value = source[key];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
/**
 * 查询当前活动槽位。
 *
 * 返回 `null` 表示查询失败（网络/信封/结构问题），与「无可用活动」
 * （返回 `slotState !== 'available'` 的对象）**严格区分** —— 前者是异常、
 * 后者是正常业务状态，UI 文案不同。
 */
export async function fetchLobsteraiActivitySlot(credential, product, clientVersion, fetcher = fetch) {
    const query = new URLSearchParams({
        placement: LOBSTERAI_SLOT_PLACEMENT,
        clientVersion,
        containerApiVersion: LOBSTERAI_SLOT_CONTAINER_API_VERSION,
        platform: LOBSTERAI_SLOT_PLATFORM,
    });
    const result = await requestJson(`${product.apiBase}${LOBSTERAI_ACTIVITY_SLOT_PATH}?${query.toString()}`, credential, product, fetcher);
    if (!result.ok)
        return null;
    const envelope = parseLobsteraiEnvelope(result.body);
    if (!envelope.ok)
        return null;
    const activity = typeof envelope.data.activity === 'object' && envelope.data.activity !== null
        ? envelope.data.activity
        : {};
    const activityCode = typeof activity.activityCode === 'string' ? activity.activityCode : '';
    return {
        slotState: typeof envelope.data.slotState === 'string' ? envelope.data.slotState : '',
        activityCode,
        configRevision: readNumber(activity, 'configRevision'),
    };
}
/**
 * 查询活动上下文（今天领了没、有哪些可用动作）。
 *
 * 返回 `null` 表示查询失败。
 */
export async function fetchLobsteraiActivityContext(credential, product, slot, fetcher = fetch) {
    const query = new URLSearchParams({ configRevision: String(slot.configRevision) });
    const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/context?${query.toString()}`;
    const result = await requestJson(url, credential, product, fetcher);
    if (!result.ok)
        return null;
    const envelope = parseLobsteraiEnvelope(result.body);
    if (!envelope.ok)
        return null;
    const state = typeof envelope.data.state === 'object' && envelope.data.state !== null
        ? envelope.data.state
        : {};
    return {
        claimedToday: readBool(state, 'claimedToday'),
        actions: readActions(envelope.data, 'actions'),
    };
}
/**
 * 执行每日签到领取。
 *
 * 完整三步流程，返回与 `credits.ts` 同构的 {@link ClaimOutcome}
 * 判别联合 —— 这样 `computeClaimSummary` 与 Jet Hub 的结果摘要 UI 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 槽位查询失败 → `failed`；
 * 2. `slotState !== 'available'` 或无 activityCode → `inactive`；
 * 3. 上下文查询失败 → `failed`；
 * 4. `claimedToday` → `already-claimed`；
 * 5. `actions` 不含 `check_in` → `inactive`；
 * 6. 领取请求失败 / 信封异常 → `failed`；
 * 7. 成功 → `claimed`（积分取三级回退链）。
 */
export async function claimLobsteraiDailyCheckin(credential, product, clientVersion, fetcher = fetch) {
    const slot = await fetchLobsteraiActivitySlot(credential, product, clientVersion, fetcher);
    if (slot === null) {
        return { kind: 'failed', code: -1, message: '活动槽位查询失败' };
    }
    if (slot.slotState !== 'available' || slot.activityCode.length === 0) {
        return { kind: 'inactive', message: `无可用活动（slotState=${slot.slotState}）` };
    }
    const context = await fetchLobsteraiActivityContext(credential, product, slot, fetcher);
    if (context === null) {
        return { kind: 'failed', code: -1, message: '活动上下文查询失败' };
    }
    if (context.claimedToday) {
        return { kind: 'already-claimed', message: '今天已签到' };
    }
    if (!context.actions.includes('check_in')) {
        // 活动存在但当前不可签到（未开始 / 已结束 / 无资格）。
        // 与「今天已领」区分开：前者用户无需动作，后者也只是提示。
        return { kind: 'inactive', message: '当前不可签到' };
    }
    const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/actions/check_in`;
    const result = await requestJson(url, credential, product, fetcher, {
        method: 'POST',
        body: JSON.stringify({
            configRevision: slot.configRevision,
            // 客户端幂等键（对齐 sigin.py:63 的 uuid4）：服务端据此去重。
            idempotencyKey: randomUUID(),
            payload: {},
        }),
    });
    if (!result.ok) {
        return { kind: 'failed', code: -1, message: result.message };
    }
    const envelope = parseLobsteraiEnvelope(result.body);
    if (!envelope.ok) {
        return { kind: 'failed', code: envelope.code, message: envelope.message };
    }
    // 积分字段三级回退（对齐 sigin.py:65-66）：
    // creditsGranted → rewardCredits → credits。不同活动/版本用不同字段名。
    const bodyResult = typeof envelope.data.result === 'object' && envelope.data.result !== null
        ? envelope.data.result
        : {};
    const credit = ['creditsGranted', 'rewardCredits', 'credits']
        .map((key) => bodyResult[key])
        .find((value) => typeof value === 'number' && Number.isFinite(value)) ?? 0;
    const message = typeof bodyResult.message === 'string' ? bodyResult.message : '';
    return {
        kind: 'claimed',
        credit,
        // LobsterAI 的签到响应不含连续天数概念（那是 CodeBuddy 的活动机制）。
        streakDays: 0,
        isStreakDay: false,
        ...message.length > 0 ? { delayedMessage: message } : {},
    };
}
/**
 * 查询账号积分余额。
 *
 * 端点用 `profile-summary` 而非 `quota`（`client.go:282-283` 的注释）：
 * `/api/user/quota` 只显示 `freeCreditsTotal=300`，**不含活动积分**
 * （实测某账号 profile-summary 有 5297.72，quota 只有 300）。
 *
 * 返回 `null` 表示**查不到**（网络/信封问题），与「余额为 0」严格区分 ——
 * 失败时 UI 应显示原因而不是 0。
 *
 * 结构对齐 `credits.ts` 的 {@link CreditBalance}，让 `CreditBalanceRow`
 * 组件能直接复用：`creditItems[]` → `packages[]`，`totalCreditsRemaining` → `total`。
 */
export async function fetchLobsteraiCreditBalance(credential, product, fetcher = fetch) {
    const result = await requestJson(`${product.apiBase}${LOBSTERAI_PROFILE_SUMMARY_PATH}`, credential, product, fetcher);
    if (!result.ok)
        return null;
    const envelope = parseLobsteraiEnvelope(result.body);
    if (!envelope.ok)
        return null;
    const packages = [];
    const items = envelope.data.creditItems;
    if (Array.isArray(items)) {
        for (const item of items) {
            if (typeof item !== 'object' || item === null)
                continue;
            const record = item;
            const remaining = readNumber(record, 'creditsRemaining');
            const type = typeof record.type === 'string' ? record.type : '';
            const label = typeof record.label === 'string' ? record.label : '';
            const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : '';
            // 到期时间归一化到 deductionEndTime（毫秒时间戳）：
            // LobsterAI 的 expiresAt 实测是 ISO 8601（"2026-10-23T01:21:23"），
            // Date.parse 原生支持；`replace(' ', 'T')` 兼容旧格式（空格分隔）。
            // 归一化后前端 splitCreditsByExpiry / formatPackageTooltip 统一处理，
            // 不需要按 provider 特判。
            const expMs = expiresAt.length > 0
                ? Date.parse(expiresAt.replace(' ', 'T'))
                : Number.NaN;
            packages.push({
                // ⚠️ 包名用 `label`（实测"每日登录奖励"）而不是 `type`（"campaign"）：
                // type 是机器分类码，label 才是人看的名字。label 缺失时回退 type，
                // 再回退「积分包」（老用例锁死的形态）。
                name: label.length > 0 ? label : (type.length > 0 ? type : '积分包'),
                unit: 'credit',
                remaining,
                // LobsterAI 只下发剩余量，不区分「周期总额/已用」。
                // 用 remaining 充当 total 会让「剩余/总额」显示成 1:1；
                // 这里如实置 0，UI 的 `formatPackageLine` 对 0 会显示 '?'（不误导）。
                total: 0,
                used: 0,
                // 无 Status 字段可依据：有 expiresAt 且已过期才算失效。
                active: !(expiresAt.length > 0 && Number.isFinite(Date.parse(expiresAt.replace(' ', 'T')))
                    && Date.now() >= Date.parse(expiresAt.replace(' ', 'T'))),
                cycleStartTime: '',
                cycleEndTime: '',
                expiredTime: expiresAt,
                ...(Number.isFinite(expMs) ? { deductionEndTime: expMs } : {}),
            });
        }
    }
    // 面值推断（用户期望显示 100/100，而不是 100/0）：服务端**没有**面值字段
    // （实测响应只有 creditsRemaining + expiresAt），但同组包的面值恒定 ——
    // 「每日登录奖励」每天发 100，没用过的包剩余量就等于面值。
    // 取「同组（label/type 相同）有效包的剩余量最大值」当面值：6 个没用过的包
    // max=100 → 全部显示 100/100；被用过的包（92.73）也按同组面值 100 显示
    // 92.73/100。⚠️ 只对有效包推断 —— 失效包可能当初面值不同，宁可显示 ?。
    const faceValueByGroup = new Map();
    for (const pkg of packages) {
        if (!pkg.active)
            continue;
        const key = pkg.name;
        const cur = faceValueByGroup.get(key) ?? 0;
        if (pkg.remaining > cur)
            faceValueByGroup.set(key, pkg.remaining);
    }
    for (const pkg of packages) {
        const face = faceValueByGroup.get(pkg.name);
        if (face !== undefined && face > 0) {
            pkg.total = roundCredits(face);
            if (pkg.used <= 0)
                pkg.used = roundCredits(Math.max(0, face - pkg.remaining));
        }
    }
    // 负数一律 clamp 到 0（对齐 Go `client.go:303-308` 的 clamp）：服务端在
    // 超额扣费/计量回滚等异常下可能下发负值，原样透出会让卡片显示「-12.5 积分」，
    // 既无意义又会误导用户以为欠费。
    //
    // ⚠️⚠️ **`total` 不能简单地用 `readNumber(...)` 兜底成 0**（真实缺陷，
    // 2026-10-12 审计实测）：`readNumber` 对「不可解析」与「真的是 0」都回 0，
    // 于是 `{totalCreditsRemaining: null}` / `"abc"` / 溢出成 `Infinity` 的超长串
    // 会被**伪装成余额 0** —— 与 `hasTotal` 想守的是同一件事，只是发生在
    // **有明细**的那条分支上（`hasTotal` 的 null 短路被 `packages.length > 0`
    // 绕过了）。
    //
    // ⇒ 口径：
    //   · 可解析 → 用它（照旧 clamp 负数）；
    //   · 不可解析但**有明细** → 用明细里**有效包**的剩余量合计兜底
    //     （那是服务端自己给的数据，自洽；比伪造一个 0 诚实）；
    //   · 不可解析且**无明细** → 视为「查不到」（下面的 `return null`）。
    const parsedTotal = parseNumericField(envelope.data, 'totalCreditsRemaining');
    const packagesTotal = roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? Math.max(0, pkg.remaining) : 0), 0));
    const total = parsedTotal !== undefined
        ? roundCredits(Math.max(0, parsedTotal))
        : packagesTotal;
    // 「字段在不在」是两回事（2026-10-10 彻查修正）：
    //   · `totalCreditsRemaining` **存在**（服务端形状没变）但为 0 且无明细
    //     ＝ 余额真的为空（每日登录奖励的包用完了）→ 如实返回 0，面板显示
    //     「0 积分」，**不再伪装成「查询失败」**——原实现把这种情形也压成 null，
    //     `collectCreditBalances` 的 null 兜底文案「余额查询失败」让用户误读成
    //     账号失效（实测 5/6 账号被这句误导，而调用层当天 0 错误）。
    //   · **字段缺失**＝响应形状变了 → 才视为「查不到」（原注释想防的
    //     「解析失败伪装成 0 积分」由本条守住，`data:{}` 单测继续走 null）。
    //
    // ⚠️⚠️ **判据必须是「能不能解析成数字」，不能是「键存不存在」**
    //（2026-10-12 订正）：`=== undefined` 只挡住「键缺失」，实测它会把
    // `{totalCreditsRemaining: null}` / `{...: "abc"}` / 溢出成 `Infinity` 的
    // 超长数字串**都**判成「服务端明确下发 0」⇒ 把**解析失败伪装成余额 0**
    // —— 正是上面那条注释想防的事，只是换了个入口。
    // ⚠️ 判据是 `parseNumericField`（「一个字段是不是数字」的判据源）。
    //     ⚠️ 它**不是**全仓唯一：`src/lobsterai.ts` 的 `readNumberField` 是同一
    //     provider 的另一条路径（供 `lobsterai-adapter.ts` 解析远端目录），
    //     两处**必须同口径** —— 2026-10-12 的缺陷正是「只修了一份」造成的分叉。
    if (parsedTotal === undefined && packages.length === 0)
        return null;
    // 失效包的余额同样 clamp：负值计入 expiredTotal 会让「另有 N 已失效」变成负数。
    const expiredTotal = roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : Math.max(0, pkg.remaining)), 0));
    return { total, packages, expiredTotal };
}
/**
 * 把额度规整为两位小数。
 *
 * 服务端精确值本身可能带浮点表示（如 55.67000031），多包相加会把尾数噪声
 * 显式化 —— 金额展示到分即可（与 `credits.ts:roundCredits` 同口径）。
 */
function roundCredits(value) {
    return Math.round(value * 100) / 100;
}
//# sourceMappingURL=lobsterai-credits.js.map