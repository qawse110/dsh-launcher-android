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
    /**
     * ⚠️⚠️ **`save()` 失败 = 凭据已死，必须报终态**（真实缺陷，2026-10-27）。
     *
     * ## 为什么不能像以前那样让它当普通异常冒泡
     *
     * `refresh()` 成功意味着**服务端已经把旧的一次性 token 消耗掉并签发了新的**
     * （codearts / officeace 的 refresh_token 都是一次性的）。此时若 `save()`
     * 失败，新凭据只有一个内存引用、随调用栈一起消失 ⇒ **本地永久停留在那份
     * 已被消耗的旧 token 上**。
     *
     * 旧实现让这个异常直接冒泡，调用方（`refreshAll` 的 catch）把它当**非终态**
     * 处理：只记一条 warn、不标 `refreshable:false`、下一轮继续用同一份死 token
     * 去兑换 ⇒ 服务端如实回 `STS5.1806 the refresh token has been used`
     * ⇒ 每轮失败一次、日志被 `terminalWarned` 去重、面板照常显示「自动续期」。
     *
     * 实测（2026-10-27 两次独立事故）：
     * - 时间线：16:58 续期成功落盘 → 17:58 那轮「兑换成功但 `.credentials.yaml`
     *   **零写入**」 → 18:23 池值被标 false → 18:30 实测 STS5.1806；
     * - 上一版「判终态前重读凭据」的防护**救不了它**：磁盘上的 `refresh_token`
     *   与刚用过的那份**完全相同**（因为没写进去），条件不成立。
     *
     * ⇒ 必须抛**终态错误**，让调用方走「需重新登录」分支。
     *
     * ## ⚠️⚠️ 终态错误的**类型必须由调用方给**（PR159 首版缺陷，2026-10-28 修）
     *
     * 首版让本模块 `import { RefreshTokenExpiredError } from './oauth.js'`
     * （codearts 的类），注释声称「各家 `refreshAll` 都按
     * `instanceof RefreshTokenExpiredError` 判终态 ⇒ **九家同时受益**」。
     * **这句不成立**：每家都有**自己的**同名类（buddy 用 `buddy-oauth.ts` 的、
     * trae / qoder / cline / lobsterai 各自在 auth 文件里定义、gemini 是
     * `GeminiRefreshTokenExpiredError`、minimax 是 `MinimaxRefreshTokenExpiredError`、
     * accio 是 `AccioRefreshTokenExpiredError`），跨模块 `instanceof` **恒为 false**
     * ⇒ 另外 8 家仍落「非终态」分支，账号照样静默死 —— 正是本修复要治的病。
     *
     * 另一种写法（本模块自定义一个中立类）同样不行：它不属于任何一家的判据。
     * ⇒ 只能由调用方把自己的类**注入**进来（`makeTerminalError`）。
     *
     * ## 为什么该参数是**必填**而不是可选带默认值
     *
     * 可选 + 默认 = 「漏接线」是**静默**的（退回普通 Error ⇒ 又变回静默死号），
     * 正是本缺陷的形态。必填 ⇒ 任何新增的调用点漏传都会在 `tsc --noEmit` 变红，
     * 不依赖人记得。实测接线点：九家、共 10 处（gemini 有两处）。
     *
     * ⚠️ `save()` 抛的是**存储层**错误（权限/磁盘满/序列化），不是网络错误，
     * 且此刻服务端票据已消耗 ⇒ 重试无意义，**不属可自愈类**。
     */
    try {
        await save(refreshed);
    }
    catch (error) {
        // ⚠️ 这条 warn 在**抛终态之前**单独记一次：调用方的终态分支会把它归成
        //    「refresh_token 已失效」，而真正的原因是**落盘失败**——两者对该怎么
        //    处置的答案相同（重新登录），但排查时要能一眼分清是谁的锅。
        //    实测（2026-10-27）当时的日志只有「续期失败：<存储错误>」一条，
        //    与「服务端拒绝」同形，导致定位多花了几十分钟。
        params.warn?.(`${tag} 账号 ${accountId} 续期**已成功但落盘失败**（${provider}）：`
            + `${error instanceof Error ? error.message : String(error)}`
            + ` ⇒ refresh_token 已在服务端被消耗，本地凭据已失效，需重新登录`);
        throw params.makeTerminalError(`${tag} 账号 ${accountId} 续期成功但**新凭据落盘失败**：`
            + `${provider} 的 refresh_token 是一次性的，服务端那份已被消耗，`
            + `本地仍停留在旧 token 上，继续重试只会得到「已被使用」⇒ 必须重新登录。`
            + `落盘错误：${error instanceof Error ? error.message : String(error)}`);
    }
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