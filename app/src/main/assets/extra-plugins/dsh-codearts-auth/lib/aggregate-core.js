/**
 * 聚合 provider 的**共享底座**：哨兵常量、候选排序、倍率解析。
 *
 * ## 为什么要抽出来（而不是在 auto 与新 provider 各写一份）
 *
 * 本仓库对「同一语义两套实现」有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据，产生**静默失效**——测试全绿、
 * 只在畸形响应上分叉）。跨渠道选型逻辑若写两份，必然漂移，症状是「同一个档位
 * 在两处算出不同结果」。
 *
 * ⇒ 本文件是选型口径的**唯一权威**；`auto-adapter.ts` 与
 * `aggregate-adapter.ts` 都只是它的调用方。
 *
 * ## 哨兵语义（三者严格互斥）
 *
 * | 值 | 含义 | 排序行为 |
 * |---|---|---|
 * | `NEVER` | 可用，但**无临期额度**（永久/长期积分） | **参与排序且可当选**（排最后） |
 * | `UNUSABLE` | 本次不可用（无启用账号 / 探测失败） | **剔除** |
 * | abort | 这次调用不该继续 | **立刻抛 AbortError**，绝不折算成 `UNUSABLE` |
 *
 * ⚠️ 真实缺陷（PR !69 审计实测）：初版拿 `bestExpiry` 的初值 `Infinity` 当
 * 「还没选中任何 provider」的哨兵，于是**全部条目都是 `NEVER` 时循环一次都不
 * 赋值** ⇒ 返回 `undefined` ⇒ 用户看到「没有任何已登录且可用的 provider 账号，
 * 请先登录」——而账号全都正常，只是积分都是永久的。这是「账号都在」被误报成
 * 「没登录」。⇒ 两种语义必须用**独立变量**分开。
 *
 * @module src/aggregate-core.ts
 */
/** 无到期概念（只有永久/长期积分）时的失效时刻。 */
export const NEVER = Number.POSITIVE_INFINITY;
/** 该 provider 本次不可用（无启用账号 / 探测失败）的哨兵值。 */
export const UNUSABLE = -1;
/**
 * 从「provider → 最早失效时刻」里挑出胜者（**纯函数**）。
 *
 * 规则：剔除 `UNUSABLE`；其余按失效时刻**升序**（越早越先烧）；时刻相同按传入
 * 顺序（即候选表的声明顺序）。
 *
 * ⚠️ `NEVER` 必须参与排序并能当选：它表示「可用、只是没有临期可烧」，而不是
 * 「不可用」（见模块头的真实缺陷）。
 *
 * @returns 胜出的 provider；**全部 `UNUSABLE`** 时才返回 `undefined`。
 */
export function pickSoonestProvider(entries) {
    let best;
    let bestExpiry = NEVER;
    for (const [provider, expiry] of entries) {
        if (expiry === UNUSABLE)
            continue;
        // 严格小于：并列时保留先出现的，不重排。
        if (best === undefined || expiry < bestExpiry) {
            bestExpiry = expiry;
            best = provider;
        }
    }
    return best;
}
/**
 * 从目录展示名解析倍率；带「免费」按 0；解析不出按 `Infinity`（排在任何有标注的之后）。
 *
 * ⚠️ **必须要求倍率前有分隔符**（真实缺陷，PR !69 审计实测）：初版正则
 * `/[×x]\s*(\d+(?:\.\d+)?)\s*$/i` 只要求「`x` + 数字 + 行尾」，不要求分隔符
 * ⇒ 模型名里的 `x` 被当成倍率。实测：
 *
 * | 展示名 | 初版解析 | 应为 |
 * |---|---|---|
 * | `Spark X2.5`（**无**倍率标注） | **2.5 倍** ❌ | `Infinity` |
 * | `GPT-X5` | **5 倍** ❌ | `Infinity` |
 * | `Grok x4` | **4 倍** ❌ | `Infinity` |
 * | `DeepSeek V4 Flash 0731 · x3.0` | 3.0 ✅ | 3.0 |
 *
 * `Spark X2.5` 这条路径**真实可达**：loomy 的 `splitLoomyRate` 在远端下发**不带
 * 倍率**的名称时原样返回原名（`loomy.ts:136/147`），而 `loomyDisplayName` 不追加
 * 分隔符，该原名会被 `loomy-adapter.ts:163` 直接写进目录名 ⇒ 就会把它当 2.5 倍，
 * 于是「挑最便宜」反而**挑到了最贵的**（同池里 `· x0.8` 的模型排到了它后面）。
 *
 * ✅ 修法：要求倍率前有分隔符（`·` / `×` / `·x`），并按真实形态支持促销箭头
 * `x0.17→x0.50` —— 取**促销后的**那个值，那才是实际计费倍率。
 *
 * ⚠️ 只做展示层解析：各 provider 的倍率权威来源不同（qoder 在目录 `priceFactor`、
 * buddy 在远端 config 拼进名字），逐家接字段是个大工程，而目录名是所有 provider
 * 统一展示的地方 —— 先用这一层。
 */
export function priceFactorFromName(name) {
    if (name.includes('免费'))
        return 0;
    // ⚠️ 倍率标注的**真实形态**只有两种（`formatCreditsRate`，buddy.ts:701；
    // `loomyDisplayName`，loomy.ts:157）：`… · x{n}` 与 `… ×{n}` —— 分隔符是
    // **间隔号 U+00B7** 或乘号。促销期为 `· x0.17→x0.50`，取箭头右侧（实际计费倍率）。
    const m = /·\s*[×x]?\s*(\d+(?:\.\d+)?)(?:\s*[→>]\s*[×x]?\s*(\d+(?:\.\d+)?))?\s*$/i
        .exec(name.trim());
    if (m === null)
        return Number.POSITIVE_INFINITY;
    const raw = m[2] ?? m[1];
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}
/**
 * 候选排序：**临期升序 → 同档倍率升序 → 声明顺序兜底**。
 *
 * - 第一判据「临期升序」：越早作废的先用掉（本功能的全部价值）；
 * - 第二判据「倍率升序」：同一临期档内挑便宜的（省钱）；
 * - 第三判据「声明顺序」：完全并列时保持候选表顺序（`Array.prototype.sort` 在
 *   ES2019 起是**稳定**的，故无需显式兜底字段）。
 *
 * ⚠️ **纯函数**：不改传入数组（先 `slice()`）。适配器会对同一份候选表反复排序
 * （每次请求），原地排序会让顺序随调用次数漂移。
 */
export function rankCandidates(candidates) {
    return candidates
        .filter((candidate) => candidate.expiry !== UNUSABLE)
        .slice()
        .sort((a, b) => (a.expiry !== b.expiry ? a.expiry - b.expiry : a.price - b.price));
}
//# sourceMappingURL=aggregate-core.js.map