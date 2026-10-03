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
    if (!shouldRefreshNow(expiresAt)) {
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