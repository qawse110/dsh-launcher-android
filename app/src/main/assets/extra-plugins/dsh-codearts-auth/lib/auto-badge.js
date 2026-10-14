/**
 * `usage.badge` 对 `jet-hub-auto` 的**改写判定**（纯逻辑，便于单测行为断言）。
 *
 * ## 为什么单独一个模块
 *
 * 这段判定原先内联在 `jet-hub-rpc.ts` 的 `case 'usage.badge'` 里。那个文件有
 * 4500+ 行且大量 import，单测**无法 import 它的内部函数**，于是既有测试只能对
 * 源码做**字符串/正则断言**（`expect(RPC).toMatch(/lastDecision/)`）。
 *
 * ⚠️ 我实测发现那类断言是**恒真的假用例**：把实现改成 `if (false && …)` 之后，
 * 正则**照样命中**，用例依然全绿 —— 而功能已经完全失效。这是「测试全绿但功能
 * 是死的」里最难发现的一种（本仓库 AGENTS.md 首条判据记的正是这类静默失效）。
 *
 * ⇒ 把判定搬到这里，测试可以直接 `import` 并**行为断言**：
 *   喂入不同的 `autoState`，断言返回的改写结果。这符合本仓库既有做法
 *   （`badge-model.js` / `aggregate-panel-logic.js` 都是「逻辑与渲染分离」的纯模块）。
 *
 * ## 为什么判定要分三档（真实缺陷，用户报障 2026-10-06 / 2026-10-08）
 *
 * | 情形 | 行为 | 理由 |
 * |---|---|---|
 * | 非 auto | 原样透传 | 其余 15 家的行为**逐字不变** |
 * | auto 且有真实历史 | 用 `lastDecision` | 那是**实际发出**的目标，零成本零误差 |
 * | auto 且无历史 | 回退到**预测** | 否则插件刚重启时徽标是空的，用户以为它坏了 |
 * | auto 但适配器没挂上 | 报错 | 拿 auto 去查余额必然失败，不如给出可行动文案 |
 *
 * ⚠️ 「有历史」必须**优先于**预测：预测可能因上游失败切换 / 带图改道而错，
 *    而徽标是**止损工具**（用户原话「以为在用 A，实际在烧 B，等发现时积分
 *    已经没了」）—— 显示错人比不显示更危险。
 *
 * @module src/auto-badge.ts
 */
/**
 * 判定 `usage.badge` 该把请求改写成谁。
 *
 * @param provider - 请求里的 provider（**调用方已 `trim`**）。
 * @param autoProviderId - auto 的路由 id（由调用方传 `AUTO_PROVIDER_ID`，
 *   避免本模块反向依赖 `auto-adapter.js` 而拖进一堆运行时依赖）。
 * @param autoState - auto 适配器的状态入口；未挂载时 `undefined`。
 * @returns 改写判定。
 */
export async function resolveAutoBadgeRewrite(provider, autoProviderId, autoState) {
    // 非 auto：原样透传（其余 15 家的行为**逐字不变**）。
    if (provider !== autoProviderId)
        return { kind: 'passthrough' };
    // auto 但适配器没挂上：拿它去查余额必然失败，给出可行动文案。
    if (autoState === undefined) {
        return { kind: 'error', message: 'auto：选型不可用（适配器未挂载）' };
    }
    const decided = autoState.lastDecision;
    if (decided !== undefined && decided !== null) {
        // 真实历史优先 —— 那是**实际发出**的目标（含带图改道）。
        return {
            kind: 'rewrite',
            effectiveProvider: decided.provider,
            autoActual: {
                provider: decided.provider,
                model: decided.model,
                viaImageFallback: decided.viaImageFallback,
            },
            // ⚠️ `Infinity`（只有长期积分）会被 JSON 序列化成 `null`，客户端按
            //    `typeof === 'number'` 判空 ⇒ 只有有限且非哨兵的时刻才回传。
            ...usableExpiry(decided.expiryAt),
            ...finitePrice(autoState.priceOf(decided.provider, decided.model)),
        };
    }
    // 还没发过任何请求 ⇒ 回退到**预测**（此时确实没有真实目标可读）。
    // ⚠️ 必须有这条回退：否则插件刚重启时徽标是空的，用户会以为它坏了
    //    （正是 2026-10-08 报障的形态）。
    const picked = await autoState.selectProvider();
    if (picked === undefined) {
        return {
            kind: 'error',
            message: 'auto：当前没有任何可用账号（请在 Jet Hub 登录至少一个 provider）',
        };
    }
    return {
        kind: 'rewrite',
        effectiveProvider: picked.provider,
        autoActual: { provider: picked.provider, model: picked.model, viaImageFallback: false },
        // ⚠️ 预测路径的失效时刻来自 `selectProvider` 顺带写入的 `lastWinnerExpiryAt`
        //（零额外请求，见 `auto-adapter.ts` 的 `selectProvider`）。
        // ⚠️ 该字段在适配器侧必须是**活值（getter）**：消费方是「先 selectProvider、
        //    再读它」，值快照会恒读到 `undefined`（真实缺陷，复审实测）。
        ...usableExpiry(autoState.lastWinnerExpiryAt),
        // 预测路径同样能拿到倍率：`selectProvider` 内部就是经 `firstModelOf` 取模型的，
        // 那一轮目录循环已把倍率记进表里。
        ...finitePrice(autoState.priceOf(picked.provider, picked.model)),
    };
}
/**
 * `aggregate-core.ts` 的 `UNUSABLE` 哨兵值 —— **此处刻意重复字面量**。
 *
 * ⚠️ 本模块刻意**零 import**（它被宿主 RPC 层与单测直接使用，注释见模块头：
 * 不反向依赖 `auto-adapter.js` 以免拖进一堆运行时依赖）。故这里复刻 `-1`，
 * 一致性由 `tests/unit/auto-badge-rpc.spec.ts` **与 `aggregate-core` 对拍**锁死
 * —— 那条用例会直接 `import { UNUSABLE }` 并断言本常量与它相等，改一侧即红。
 */
export const UNUSABLE_EXPIRY = -1;
/**
 * 只有**有限且非 `UNUSABLE`** 的时刻才放进响应（与 {@link finitePrice} 对称）。
 *
 * ⚠️ `UNUSABLE = -1`（`aggregate-core.ts` 的哨兵，表示「该渠道当前不可用」）
 * 既非 `undefined` 也非 `Infinity`，且 `Number.isFinite(-1) === true`
 * ⇒ 只判 `Number.isFinite` 会让它**穿过宿主与客户端两道守卫**，最终被
 * `expiryCountdownText` 渲染成 `1/1 07:59过期`（1970 年派生的荒谬时间）。
 * 复审实测（PR !84）：
 *
 * ```
 * expiryCountdownText(-1, now)    -> "1/1 07:59过期"
 * autoBadgeName({ expiryAt: -1 }) -> "自动 → buddy GLM-5.3-Flash · 1/1 07:59过期"
 * ```
 *
 * ⚠️ 收口放在**本模块**（而不是客户端再加一道判断）：这里是「能不能回传给客户端」
 * 的唯一出口，两处拼装（真实历史 / 预测回退）都经过它 —— 放客户端会变成
 * 「同一语义两套实现」（本仓库红线）。
 *
 * ⚠️ 判据用 `!== UNUSABLE_EXPIRY` 而非 `> 0`：到期时刻是**绝对毫秒时间戳**，
 * 理论上可能是任何正整数；`> 0` 会顺带挡掉它，但写成哨兵比较更精确地表达意图。
 */
function usableExpiry(at) {
    return typeof at === 'number' && Number.isFinite(at) && at !== UNUSABLE_EXPIRY ? { autoExpiryAt: at } : {};
}
/**
 * 只有**有限**倍率才放进响应。
 *
 * ⚠️ `Infinity` 是「无标注」的哨兵（`priceFactorFromName` 的返回值），直接回传
 * 会让客户端拼出 `xInfinity`（`aggregate-panel-logic.js` 记录过同一个坑）。
 * ⚠️ `0` 是**合法值**（显示「免费」），故判据必须是 `Number.isFinite` 而不是 truthy
 *（`0` 是 falsy，用 `if (price)` 会把「免费」静默吞掉 —— 本仓库在
 * `buddySaturationDelayMs` 上踩过同型的 `|| 默认值` 坑）。
 */
function finitePrice(price) {
    return typeof price === 'number' && Number.isFinite(price) ? { autoPrice: price } : {};
}
//# sourceMappingURL=auto-badge.js.map