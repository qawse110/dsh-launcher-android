import { REFRESH_LEAD_MS } from './refresh.js';
/** 容差：毫秒时间戳来自 JWT 的秒级 `exp`，换算后可能有 1 秒内的舍入。 */
const EXPIRY_TOLERANCE_MS = 1000;
/**
 * 本轮是否需要为该凭据发一次续期请求（lead-time 语义）。
 *
 * 与单凭据时代 `computeFirstRefreshDelayMs` 的 `expiresAt - now <= REFRESH_LEAD_MS`
 * 同一判据：**距过期不足 1 小时（或已过期、或读不到过期时间）才刷**。
 *
 * ## 为什么判据用**凭据的**过期时间而不是账号池的 `expiresAt`
 *
 * 池值正是本缺陷里可能陈旧的那份数据（按需续期不回写、老版本从未回写）。
 * 拿它当判据会让「凭据其实快过期」的账号被跳过；而凭据本体是权威值，
 * 读它只是一次本地存储访问，不花网络也不花模型额度。
 *
 * @param expiresAtMs 凭据 access_token 的过期时刻；`undefined` 一律视为需要刷。
 */
export function shouldRefreshNow(expiresAtMs, nowMs = Date.now()) {
    if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs))
        return true;
    return expiresAtMs - nowMs <= REFRESH_LEAD_MS;
}
/**
 * 本轮是否需要为该凭据发一次续期请求：**access 与 refresh 两条腿取或**。
 *
 * ⚠️ 这是 {@link shouldRefreshNow} 的**带 refresh 寿命腿**版本，只有 CodeArts
 * 走它（其余八家不提供 `refreshExpiresAtOf`，行为与旧版逐字节相同）。
 *
 * ## 为什么必须取「或」而不是「与」
 *
 * 取「与」（两条腿都满足才续）会**制造**一个新缺陷：refresh 剩 3 天、access
 * 剩 2 小时（正常态）时反而**不续**，access 一过期账号就报废 —— 而此刻 refresh
 * 明明还好好活着。取「或」的语义才是对的：**任一条腿进入告警区间就续期**，
 * 两条腿都能因此被拉满。
 *
 * ## 为什么 refresh 已过期时也要放行（而不是直接判定失败）
 *
 * `refreshExpiresAt < now` 时本函数返回 `true`，让调用方**真去发一次**请求：
 * 上游可能已经续发过（多端登录会重签 refresh），本地这一份过期不代表云端不接受。
 * 让真实报文来否决，比凭本地过期时间猜要可靠 —— 且调用方对 `invalid_grant`
 * 已有终态处理（写 `refreshable: false` 并提示重新登录）。
 *
 * ⚠️ 但**读不到**（`undefined` / NaN）时**必须当「不知」而非「已过期」**：
 * CodeArts 的 refresh 是 JWT，`exp` 明文可读，读不到只可能是旧版 ticket 凭据
 * （没有 refresh_token），那种情况由 `isCodeArtsRefreshable` 拦下；若在这里
 * fail-closed 成 `true`，会让所有读不到腿的凭据每 30 分钟被无谓刷一次。
 */
export function shouldRefreshNowWithRefreshExpiry(params) {
    const nowMs = params.nowMs ?? Date.now();
    // 主腿：access 进入 lead 窗口（含已过期 / 读不到）。
    if (shouldRefreshNow(params.expiresAtMs, nowMs))
        return true;
    // refresh 这条腿：读不到就**放弃这条腿**（fail-open 到「按 access 判」）。
    const r = params.refreshExpiresAtMs;
    if (r === undefined || !Number.isFinite(r))
        return false;
    // 已过期 → 放行（让真实请求去否决，见上方注释）。
    if (r <= nowMs)
        return true;
    // 剩余不足一个 lead 周期 → 提前续，别等到 access 的窗口才发现来不及。
    return r - nowMs <= REFRESH_LEAD_MS;
}
/**
 * 把凭据的过期信息同步回账号池（UI 读的就是这里）。
 *
 * 三条从 raccoon 既有实现继承下来的硬规矩，改动时必须保持：
 *
 * 1. **失败只记日志、绝不上抛**：调用点是「凭据已经续期成功」之后，
 *    此时因为写索引失败而报错，会让用户以为续期失败、甚至触发无谓的重新登录。
 *    索引是展示层数据，不该反噬凭据本身。
 * 2. **优先用调用方给的 `accountId`**：`refreshAll` 手里本来就有 entry，
 *    无需反查；只有在缺失时才退化为按凭据身份遍历账号池比对。
 * 3. **现值一致时不写盘**：账号列表是整体落盘的，否则定时器每 30 分钟
 *    会把 39 条记录全量重写一遍，白耗 I/O。
 *
 * ⚠️ `expiresAt` 取不到时**不覆盖**池内旧值：`updateAccount` 做的是
 * `{ ...entry, ...patch }`，把字段写成 `undefined` 后落盘会被 `JSON.stringify`
 * 整个丢弃，UI 于是显示「未知」—— 保留旧信息比抹掉它更有价值。
 */
export async function syncAccountExpiry(params) {
    const { pool, provider, credential, accessors, accountId, current, tag } = params;
    if (pool === undefined)
        return;
    try {
        let id = accountId;
        if (id === undefined || id.length === 0) {
            id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential));
        }
        if (id === undefined || id.length === 0)
            return;
        const expiresAt = accessors.expiresAtOf(credential);
        const refreshable = accessors.refreshableOf?.(credential);
        if (expiresAt === undefined && refreshable === undefined)
            return;
        const expiryChanged = expiresAt !== undefined
            && (current?.expiresAt === undefined
                || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS);
        const refreshableChanged = refreshable !== undefined
            && (current === undefined || current.refreshable !== refreshable);
        if (!expiryChanged && !refreshableChanged)
            return;
        await pool.updateAccount(id, {
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(refreshable === undefined ? {} : { refreshable }),
        });
    }
    catch (error) {
        params.warn?.(`${tag} 凭据处理成功但回写账号池的有效期失败（不影响使用）：`
            + `${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * `refreshAll` 的单账号编排：需要刷就刷、不需要就把池值对账。
 *
 * 「不需要续期」的分支**不是**一句 `continue` 就完事 —— 存量账号的凭据早已在
 * 别处（IDE / 上一轮定时续期）续好了，只有池里还是旧值；若跳过时对账缺失，
 * UI 会**永远**显示「已过期」，正是本 issue 里最难自愈的那一半。
 *
 * @returns 是否真的发了一次续期请求（供调用方计数/日志）。
 */
export async function refreshAccountWithReconcile(params) {
    const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params;
    const expiresAt = accessors.expiresAtOf(credential);
    if (!shouldRefreshNowWithRefreshExpiry({
        expiresAtMs: expiresAt,
        refreshExpiresAtMs: accessors.refreshExpiresAtOf?.(credential),
    })) {
        // 凭据仍在有效期内：只把池值对账，不发请求。
        await syncAccountExpiry({
            pool,
            provider,
            credential,
            accessors,
            accountId,
            current,
            tag,
            warn: params.warn,
        });
        return false;
    }
    const refreshed = await refresh(credential);
    // ⚠️ 续期响应缺访问令牌时**绝不能**把 `undefined` 落盘：那会把一份好凭据
    // 覆盖成 `"undefined"` 字符串，账号直接报废（只能重新登录）。
    if (refreshed === undefined) {
        throw new Error(`${tag} 续期响应缺少访问令牌，凭据未更新`);
    }
    await save(refreshed);
    await syncAccountExpiry({
        pool,
        provider,
        credential: refreshed,
        accessors,
        accountId,
        current,
        tag,
        warn: params.warn,
    });
    params.info?.(`${tag} 账号 ${accountId} 已续期`);
    return true;
}
//# sourceMappingURL=expiry-sync.js.map