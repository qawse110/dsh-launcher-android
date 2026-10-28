/**
 * 把「锁定时报的一串逐账号失败原因」折叠成**用户可读的一行**。
 *
 * ## ⚠️ 为什么需要它（2026-10-25 审计 A3-1）
 *
 * 「锁定永久积分」时那句报错原本直接 `reason.errors.slice(0, 2).join('；')`。
 * 而 `errors` 是**逐账号**的原因，同一个故障会在每个账号上各产生一条
 * **逐字相同**的串。实测（3 个账号都被同一把坏代理拦住）：
 *
 * ```
 * （积分查询失败（HTTP 401）；积分查询失败（HTTP 401））
 * ```
 *
 * 第二条的信息量**恰好为零**，而它占掉了仅有的 2 个名额 ⇒ 如果池里第 3 个
 * 账号是**另一种**原因（比如 `UND_ERR_CONNECT_TIMEOUT`），它会被挤掉，
 * 用户永远看不到那条**真正不同**的线索。
 *
 * ## 处置：去重 + 同因折叠 + 再去截断
 *
 * 顺序必须是「**先去重、后截断**」——反过来的话，重复串仍会占满名额。
 * 折叠后给出账号数（`（共 3 个账号）`），因为「3 个号都被同一个原因拦住」
 * 本身就是重要信息：它指向**共性**问题（代理/网络/凭据格式），
 * 而不是「某个号坏了」。
 *
 * ## ⚠️ 不改 `errors` 本身
 *
 * `errors` 的语义是「详细变体原样给的 error」——那是本 PR 的核心不变式
 * （「不许退化成那句概括文案」），已有用例锁死。**折叠只发生在展示层**。
 *
 * @param errors 逐账号的失败原因（可能含重复、可能为空）。
 * @returns 供人读的一行；空数组时给一句诚实的兜底（不编造原因）。
 */
export function foldReasonErrors(errors) {
    if (errors.length === 0)
        return '未提供具体原因';
    /** 保序去重（`Map` 的插入序即首次出现序）。 */
    const counts = new Map();
    for (const error of errors) {
        counts.set(error, (counts.get(error) ?? 0) + 1);
    }
    return [...counts.entries()]
        // ⚠️ **先去重（`counts` 的键天然唯一）、后截断**：反了的话重复串会占满名额。
        .slice(0, 2)
        .map(([error, count]) => (count > 1 ? `${error}（共 ${count} 个账号）` : error))
        .join('；');
}
//# sourceMappingURL=locked-error-text.js.map