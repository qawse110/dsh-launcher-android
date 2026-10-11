/**
 * 「目标收下了请求却零输出」的判据与目标级冷却（Gitee issue IKJW31 的 B 方案）。
 *
 * ## 它解决什么
 *
 * A 方案（`LOOMY_CONTEXT_WINDOW_OVERRIDES`）修的是**已知的那一个**虚报窗口。
 * 但「声明的窗口比真实墙大」是**上游的通病**，不是 loomy 独有 —— 下一家虚报时
 * 症状会原样复现：宿主按虚高的窗口打包，输入越过真实墙后上游**收下请求但 0 输出**
 * 并回 `finish_reason=length`，插件映射成 `max-tokens`，而 DSH 对它
 * **不自动重试** ⇒ 整轮静默失败。
 *
 * ⇒ 本模块提供一层与「哪一家虚报」无关的**运行时兜底**：识别这个失败形态，
 * 把该目标移出候选，顺位改道去下一个 provider 重发一次。
 *
 * ## ⚠️ 判据为什么必须**同时**要求「output=0」
 *
 * `max-tokens` 有两种完全相反的语义，混为一谈会**丢内容**：
 *
 * | 形态 | 含义 | 正确处置 |
 * |---|---|---|
 * | `max-tokens` + **有输出** | 模型正常答到半截，撞的是**输出上限** | **原地续写**；换目标会丢掉已产出的正文 |
 * | `max-tokens` + **output=0** | 输入本身被上游拒了（越墙 / 请求过大） | 换目标重发是**安全**的 —— 什么都没产出，没东西可丢 |
 *
 * 这与 `aggregate-adapter.ts` 的 `dispatch` 里那条「已吐内容就不许切换」是
 * **同一个安全方向**（那条注释写着「宁可少切换，不可丢内容」，并附了
 * `BlockAssembler` 按 index 幂等的实测证据）。
 *
 * ## ⚠️ 为什么不把这类失败归成 `CONTEXT_WINDOW_EXCEEDED` 了事
 *
 * DSH 内置了「上下文超限 → 压缩后重试」的恢复链
 *（`dsh-compaction-basic` 监听 `agent/request-error`，只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 触发 `{kind:'retry'}`）。
 * 看起来更省事，但**做不到**：越墙这次的真实报文是
 * `finish_reason=length` + **零输出**，与「连接被掐断」（`consumeOpenAiSse` 的
 * `truncatedStream`，同样报 `max-tokens`）**在 chunk 层完全同形** ——
 * 而后者是网络故障，把它归成溢出会掩盖真实问题，且压缩对它毫无帮助。
 *
 * ⇒ 判据放在**输出侧**（output=0）比放在**错误码侧**可靠：不猜上游的措辞，
 * 只观察「这一轮到底产出了什么」。
 *
 * ## 与既有机制的关系（本仓库的红线：同一语义不得两套实现）
 *
 * - **候选剔除**复用聚合/auto 既有的 `UNUSABLE` 哨兵语义（`aggregate-core.ts`），
 *   不新造「不可用」概念。
 * - **冷却时长**与各家既有的限流/配额冷却同量级，但**语义不同**，故独立成表：
 *   那些记在**账号**上（`modelRateLimits`），本表记在**目标**
 *  （provider + model）上 —— 越墙换账号无用，换目标才有用。
 * - **不做持久化**：这是「本次运行内别再撞同一堵墙」的优化，重启即重新试探是
 *   正确行为（用户可能已升级插件 / 上游可能已扩容）。
 *
 * @module src/zero-output-guard.ts
 */
/** 目标级冷却时长：10 分钟。
 *
 * ⚠️ 取值理由：**必须显著小于会话的典型跨度**，否则一次误判会让一个可用渠道
 * 在整个会话里消失。10 分钟足以覆盖「三连重试撞同一堵墙」那个窗口
 *（报障实测 t14/t15/t16 在 46 秒内），又短到用户几乎无感。
 */
export const ZERO_OUTPUT_COOLDOWN_MS = 10 * 60 * 1000;
/**
 * 「这一轮是否产出了对用户可见的内容」的**保守**判据。
 *
 * ⚠️ 只有 `usage` / `block-start` / `finish` **不算**产出：
 * - `usage` 是计量元数据；
 * - `block-start` 只声明「接下来要开一个块」而没有内容（它对 `index` 幂等且
 *   不更新 `blockType` ⇒ 本身可安全重放）；
 * - `finish` 是**终止帧**，它标记本轮结束，本身不是内容。
 *
 * ⚠️⚠️ **`finish` 必须排除**（本模块初版漏了它，被首条用例当场抓出）：
 * `noteChunk` 是**先**判可见性、**再**读 `reason`，若不排除 `finish` 则每个终止帧
 * 都会把 `sawOutput` 置真 ⇒ `isZeroOutputWallHit` **恒为 false**、整个 B 方案
 * 静默失效（一个「永远不触发」的守卫比没有守卫更糟：它看起来在工作）。
 *
 * ⚠️ **未知类型一律算产出**（保守方向：宁可漏判改道，不可把有内容的一轮当成
 * 空轮重发 —— 后者会让用户看到答案凭空消失或重复）。
 *
 * ⚠️ 本判据与 `aggregate-adapter.ts` 的 `isVisibleContent` **口径不同**（那边
 * 把 `finish` 算作可见内容，因为它决定「能否切换候选」——收到终止帧意味着本轮
 * 已产出完整结果）。两处用途不同，**不要为了「统一」而合并**：合并必然改掉某
 * 一边的语义。若将来要合并，必须先确认两边对 `finish` 的取舍谁对。
 */
export function producedVisibleOutput(chunk) {
    return chunk.type !== 'block-start' && chunk.type !== 'usage' && chunk.type !== 'finish';
}
/** 一个空的探测累加器。 */
export function emptyZeroOutputProbe() {
    return { sawMaxTokens: false, sawOutput: false, sawError: false, sawAborted: false };
}
/**
 * 把一个 chunk 累加进探测结果（**纯函数式**：返回新的累加器，不改入参）。
 *
 * ⚠️ 用返回新对象而不是原地改：调用方在 `for await` 里累积，原地改会让
 * 「这一轮结束时的快照」与后续轮次共享同一个对象 ⇒ 冷却判定读到脏值。
 */
export function noteChunk(probe, chunk) {
    const next = { ...probe };
    if (producedVisibleOutput(chunk))
        next.sawOutput = true;
    if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind === 'max-tokens')
            next.sawMaxTokens = true;
        else if (kind === 'error')
            next.sawError = true;
        else if (kind === 'aborted')
            next.sawAborted = true;
    }
    return next;
}
/**
 * 该轮是否属于「目标收下了请求却零输出」——即 B 方案要拦截并改道的失败形态。
 *
 * 四条同时成立：
 * 1. 见到 `max-tokens`（越墙时上游回 `finish_reason=length`，被映射成它）；
 * 2. **没有任何可见输出**（这是与「正常答到半截」的分水岭）；
 * 3. 没有 `error` 帧（那种情况有明确的错误码，走既有分类，别抢它的活）；
 * 4. 没有 `aborted`（用户取消 ⇒ 绝不改道，与 `isAbortLike` 的既有口径一致）。
 */
export function isZeroOutputWallHit(probe) {
    return probe.sawMaxTokens && !probe.sawOutput && !probe.sawError && !probe.sawAborted;
}
/** 拼冷却表键（**唯一**的拼法，调用方不得自行字符串拼接）。 */
export function zeroOutputKey(provider, model) {
    return `${provider}\u0000${model}`;
}
/**
 * 记录一次撞击并返回**新的**冷却表（纯函数式，不改入参）。
 *
 * ⚠️ `now` 由调用方注入（本模块不读时钟）—— 与仓库既有的 `now?: () => number`
 * 注入惯例一致，也让单测能精确控制过期边界。
 */
export function noteZeroOutputHit(cooldowns, provider, model, now, ttlMs = ZERO_OUTPUT_COOLDOWN_MS) {
    const next = new Map(cooldowns);
    next.set(zeroOutputKey(provider, model), now + ttlMs);
    return next;
}
/**
 * 该目标此刻是否在冷却中。
 *
 * ⚠️ 边界取 `>` 而不是 `>=`（与仓库既有的限流判据 `modelRateLimits[model] > Date.now()`
 * 一致）：恰好到期即视为**已解除**，避免多挡一个毫秒而与面板显示的时刻不符。
 */
export function isTargetCoolingDown(cooldowns, provider, model, now) {
    const until = cooldowns.get(zeroOutputKey(provider, model));
    return until !== undefined && until > now;
}
//# sourceMappingURL=zero-output-guard.js.map