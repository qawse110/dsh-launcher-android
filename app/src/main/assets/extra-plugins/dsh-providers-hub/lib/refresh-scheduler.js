/**
 * 多账号**静默续期调度**的武装时机（Gitee issue IKJOZB 的真实缺陷）。
 *
 * ## 为什么不能把这段逻辑留在 `src/index.ts` 里
 *
 * 它原先就是 `apply()` 里的一段闭包，形态为：
 *
 * ```ts
 * pool.listAllAccounts().then(accounts => {
 *   if (accounts.length === 0) return          // ← 缺陷在这
 *   void refreshAllCredentials()
 *   const refreshTimer = setInterval(...)
 * })
 * ```
 *
 * 这段代码**无法单测**（要起整个插件上下文），于是 issue !IKIRTT 的回归用例
 * 只能在**源码文本**上做断言 —— 那条断言顺带把「空池就 return」这个错误形态
 * 一起固化了下来（见 `tests/unit/refresh-bootstrap-wiring.spec.ts` 的说明）。
 * 抽成本类之后，「武装时机」终于是**行为**可测的。
 *
 * ## 被修的缺陷（issue IKJOZB）
 *
 * 冷启动时账号池为空是**正常态**（新用户、刚删光账号、刚清过存储）。此时
 * 上面的 `return` 让**整个调度器不被创建**，而 `addAccount`（登录成功调用的
 * 那一步）**没有任何重新武装的路径** ⇒ 该会话内冷启动之后登录的账号
 * **永远不会被主动续期**，只剩「请求内按需续期」；凭据悄悄过期，面板却仍显示
 * 「可自动续期」。且这条 `return` 分支一句话都不记 —— 日志无痕。
 *
 * ## 修法：三条同时成立
 *
 * 1. **无条件武装**：空池也建定时器。空池是「等待首账号入库」的正常态，
 *    不是「不需要调度」；
 * 2. **入库即武装**（{@link MultiAccountRefreshScheduler.notifyAccountAdded}）：这是 issue
 *    里点名缺失的那条「重新武装的路径」；
 * 3. **空池下轮重试**：{@link MultiAccountRefreshScheduler.onTick} 里判空后仍保留定时器，
 *    所以即使通知因任何原因没送到，下一个周期也会自己恢复 —— 两条防线互补。
 *
 * ⚠️ **判据只有「池里有没有账号」**，**不看** `refreshable` / `enabled`
 * （issue !IKIRTT 的铁律）：这个调度器存在的意义之一恰恰是去修正被误标的
 * `refreshable`；「用可能被误标的字段决定要不要修正误标」是循环依赖。
 * 故本类**刻意不接收账号条目**，只接收一个 `isPoolEmpty` 布尔。
 */
/**
 * 静默续期调度器：**无条件**武装定时器，并在账号入库时补一次武装。
 *
 * 生命周期与插件一致：`start()` 一次、`stop()` 一次（由 `ctx.effect` 回收）。
 */
export class MultiAccountRefreshScheduler {
    options;
    /** 当前定时器；`undefined` 表示未武装。 */
    timer;
    /**
     * 一轮是否正在跑。
     *
     * ⚠️ 必须防重入：`refreshAllCredentials()` 会真的发网络请求（可达数十秒），
     * 而 `notifyAccountAdded()` 可能在此期间被一次登录触发。没有这道闸门时，
     * 一轮还没跑完就叠上第二轮，同一批账号会被并发续期两次 —— 而各家续期都会
     * **轮换 refresh_token**，并发续期存在「后写的把先写的新 token 覆盖成已失效
     * 的旧 token」的风险。宁可晚一轮，也不并发。
     */
    running = false;
    constructor(options) {
        this.options = options;
    }
    /**
     * 武装调度器：**立即跑一轮**，然后每 `intervalMs` 一轮。
     *
     * ⚠️「立即先跑一轮」是 issue !IKIRTT 的主缺陷修法，必须保留：短寿命 provider
     * （cline 1 小时、codearts 约 2 小时、raccoon 3 小时）的凭据在宿主关闭期间
     * 早就到期了，只挂 `setInterval` 会让它们重启后**最长 30 分钟**一直显示
     * 「已过期」、积分行一直 401。
     *
     * 重复 `start()` 是安全的（幂等），但**不会**因此跑出两个定时器。
     */
    async start() {
        if (this.timer !== undefined)
            return;
        // ⚠️ **先武装、再跑首轮**：反过来的话，首轮内部 `await` 期间若有人调用
        // `notifyAccountAdded()`，会因为「还没武装」而再起一个定时器，导致叠加。
        this.timer = setInterval(() => void this.onTick(), this.options.intervalMs);
        // 不拦住进程退出（与仓库既有的 `refreshTimer.unref?.()` 一致）。
        const unrefable = this.timer;
        unrefable.unref?.();
        this.options.info?.('[jet-hub] 多账号续期调度器已武装（每 30 分钟一轮）');
        await this.onTick({ initial: true });
    }
    /** 停表。可再次 `start()` 重新武装。 */
    stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /** 是否已武装（供接线断言与日志使用）。 */
    isArmed() {
        return this.timer !== undefined;
    }
    /**
     * 账号入库通知（登录成功、导入、恢复备份等）。
     *
     * ⚠️ 这是 issue IKJOZB 点名缺失的那条「重新武装的路径」：冷启动空池时
     * 定时器其实已经武装了（见 {@link start}），所以这里通常**什么都不做**；
     * 它的价值在于「定时器因任何原因不在跑」时把调度救回来 —— 例如启动阶段的
     * 存储异常、或未来有人改动了 `stop()` 的时机。
     *
     * ⚠️ 已武装时**必须直接返回**：重复武装会叠加出多个 interval，让所有账号的
     * 续期频率随登录次数翻倍。
     */
    notifyAccountAdded() {
        if (this.timer !== undefined)
            return;
        this.options.info?.('[jet-hub] 检测到账号入库而续期调度器未武装，正在补武装');
        // 不 await：调用方（`AccountPool.addAccount`）不该为「补一次调度」付出延迟，
        // 而 start() 内部的首轮本身是 fire-and-forget 语义（错误已内部消化）。
        void this.start();
    }
    /**
     * 一轮：判空 → 续期 → 记录。
     *
     * ⚠️ **空池时绝不 `stop()` / `clearInterval`**：那是 issue IKJOZB 的原始形态
     * （把「暂时没有账号」当成「不需要调度」）。空池只影响日志措辞。
     *
     * 参数只为可读性存在（首轮与后续轮同一实现，避免两处漂移）。
     */
    async onTick(context) {
        if (this.running) {
            this.options.warn?.('[jet-hub] 上一轮续期尚未结束，跳过本轮');
            return;
        }
        this.running = true;
        try {
            const empty = await this.probeEmpty();
            if (empty) {
                // ⚠️ 这里**必须留痕**：issue IKJOZB 的一半伤害来自「日志无痕」——
                // 用户看到「可自动续期」却永远不续，且没有任何线索。
                // 措辞要能让人区分「正常等待」与「调度坏了」。
                this.options.info?.(context?.initial === true
                    ? '[jet-hub] 账号池为空：续期调度器已武装并等待首个账号入库（后续每 30 分钟复查）'
                    : '[jet-hub] 账号池仍为空，本轮无可续期账号（调度器保持武装）');
            }
            await this.options.refresh();
        }
        catch (error) {
            this.options.warn?.(`[jet-hub] 一轮续期失败（调度器保持武装，下轮重试）：`
                + `${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.running = false;
        }
    }
    /**
     * 探测空池；**异常一律当「非空」**。
     *
     * ⚠️ 不能把异常当空池：那会让一次存储抖动走进「空池等待」的日志措辞里，
     * 掩盖真正的问题。也不能据此停止续期 —— `refreshAll` 内部自己会读池，
     * 读不到时逐账号失败并各自留日志，比在这里静默跳过更可诊断。
     */
    async probeEmpty() {
        try {
            return await this.options.isPoolEmpty();
        }
        catch (error) {
            this.options.warn?.(`[jet-hub] 读取账号池失败（本轮照常续期）：`
                + `${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
}
//# sourceMappingURL=refresh-scheduler.js.map