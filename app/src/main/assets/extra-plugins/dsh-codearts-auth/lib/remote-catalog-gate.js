/**
 * 远端模型目录的加载闸门：并发去重 + 失败冷却。
 *
 * ## 为什么需要它（实测，2026-10-01）
 *
 * DSH 宿主的 `buildModelCatalog` 会对**每个** provider `await listModels()`，
 * 再对**每个模型** `await resolveModelInfo()`。适配器里的 `resolveModel`
 * 同样会触发目录拉取，于是「目录没拿到」这件事会被放大成
 * **一次请求 × 每个模型**：
 *
 * - 拉取失败时原实现直接 `catch {}` 返回，`remoteModels` 保持 `undefined`
 *   ⇒ 下一次 `listModels` / `resolveModel` **再拉一次**；
 * - 返回空目录时同样不落缓存 ⇒ 同上。
 *
 * 而这些拉取的超时上限是 30–60 秒量级
 * （`src/buddy.ts` `REQUEST_TIMEOUT_MS = 60_000`、
 * `src/loomy.ts` `LOOMY_REQUEST_TIMEOUT_MS = 60_000`、
 * `src/raccoon.ts` `RACCOON_REQUEST_TIMEOUT_MS = 60_000` …），
 * 未登录或离线时表现就是「首屏加载模型巨长」。
 *
 * 另有并发维度：`listModels` 与 `resolveModel` 会被 DSH **并发**调用
 * （`Promise.all`），不去重会打出多份重复请求。
 * `src/cline-adapter.ts` 早先已单独处理过这一条，本模块把它抽成共用件。
 *
 * ## 三道语义
 *
 * 1. **命中缓存**：调用方自己判 `remoteModels !== undefined` 后直接返回，
 *    不进本闸门（保持既有「成功即永久缓存」的行为）。
 * 2. **并发去重**：同一次加载的多个调用共享同一个 Promise。
 * 3. **失败/空结果冷却**：`run` 判定这次**没拿全**目录时，
 *    在 `cooldownMs` 内不再重试。
 *
 * ⚠ 冷却只影响**拉取时机**，不影响兜底目录：调用方在冷却期间照旧回落到
 * 静态表，界面不会因此少模型。
 *
 * ## `got` 与 `complete` 是两个判据（issue IKJVTF）
 *
 * 返回值的两个字段语义**不同，不能合并**：
 *
 * - **`got`**：这次拿到了**非空**目录（**残缺也算**）⇒ 调用方据此**展示**，
 *   本闸门据此**广播** `llm/adapters-updated`。
 * - **`complete`**：这次把**所有来源**都拿全了 ⇒ 调用方据此**永久缓存**，
 *   本闸门据此**清冷却**。
 *
 * 合并成一个布尔会产生两个方向的缺陷，实测都出现过：
 *
 * - 只看「非空」：`recommended-models` 成功、`/api/v1/models` 失败时，
 *   残缺目录（少了 466 条按量计费模型）被当成「已加载」**永久缓存**
 *   （`if (this.remoteModels !== undefined) return` 短路），此后连预热重试
 *   都在短路处直接返回 ⇒ 只能重启 DSH。
 * - 只看「完整」：残缺时整个目录都不展示，用户的模型列表凭空消失。
 *
 * ⇒ **显示与广播按 `got`，永久缓存与清冷却按 `complete`**。
 */
/** 失败 / 空结果后的默认冷却时长。 */
export const REMOTE_CATALOG_COOLDOWN_MS = 30_000;
/**
 * 归一化加载结果：裸布尔 → `complete = got`。
 *
 * ⚠️ **这条默认值是向后兼容的关键**：既有八个只有一个来源的适配器返回裸布尔，
 * 它们「拿到即完整」，故 `complete = got` 让行为逐字节不变 —— 不必为了新契约
 * 去改那八处的返回值（改了反而要重新论证每一处）。
 */
function normalizeLoadResult(result) {
    if (typeof result === 'boolean')
        return { got: result, complete: result };
    return { got: result.got, complete: result.complete ?? result.got };
}
export class RemoteCatalogGate {
    inFlight;
    retryAt;
    cooldownMs;
    now;
    /**
     * 距**最近一次尝试**（不论成败）过去了多久，最小值为 0。
     *
     * ⚠️ 与 {@link retryAt} 是**两个不同的闸门**，别合并：
     * - `retryAt` 只在**失败/空结果**后置位，管「别立刻重试」；
     * - 本字段在**每次尝试后**都推进（包括成功），用来回答「上一次尝试距今
     *   多久了」—— 贴图门禁据此决定「值不值得为了重新判定能力而再拉一次」
     *   （issue IKJQ3M：能力未知时不放行图片，但要在合理间隔后重看一次目录）。
     *
     * 用**同一个 `now` 来源**取两次时间戳，才能与 {@link cooling} 保持一致，
     * 不出现「冷却判定用真实时间、这个判定用假时间」的分叉。
     */
    lastAttemptAt;
    /** 目录落地后的通知回调（见 {@link RemoteCatalogGateOptions.onLoaded}）。 */
    onLoaded;
    constructor(options = {}) {
        this.cooldownMs = options.cooldownMs ?? REMOTE_CATALOG_COOLDOWN_MS;
        this.now = options.now ?? Date.now;
        this.onLoaded = options.onLoaded;
    }
    /**
     * 距上一次尝试的毫秒数；从未尝试过时为 `undefined`。
     *
     * ⚠️ 与 {@link cooling} 共用**同一个** `now` 来源，故调用方若替换了时钟，
     * 两者必然一致 —— 不会出现「冷却判定用真实时间、这个判定用假时间」的分叉。
     *
     * ⚠️ 墙钟被回拨时差值可能为负（`cooling()` 有同样的隐患，此处取同样的口径）：
     * 负数会让「已过 10 秒」的判据误判成「还没到」，把重试永久推迟。
     * ⇒ 一律夹到 0，宁可早重试也不卡死。
     */
    sinceLastAttemptMs() {
        if (this.lastAttemptAt === undefined)
            return undefined;
        return Math.max(0, this.now() - this.lastAttemptAt);
    }
    /**
     * 是否处于「上次没拿到目录」的冷却窗口内。
     *
     * ⚠ `retryAt` 是用**墙钟**算的，系统时间被回拨时 `now() < retryAt` 会
     * 把冷却**拉长**（回拨一天就是事实上的永久卡死）。故这里只认「剩余量
     * 不超过一个冷却周期」的窗口 —— 回拨造成的超长窗口一律按已到期处理。
     */
    cooling() {
        if (this.retryAt === undefined)
            return false;
        const now = this.now();
        return now < this.retryAt && this.retryAt - now <= this.cooldownMs;
    }
    /**
     * 至多发起一次加载。
     *
     * - 冷却中：**不调用** `run`，直接返回。
     * - 已有在飞的加载：等它，不重复调用 `run`。
     * - 否则调用 `run`；结果决定冷却与广播（见下）。
     *
     * @param run 执行实际拉取，并在成功时自行落缓存。
     *   返回**裸布尔**即 `got = complete = 该值`（向后兼容，既有适配器行为不变）；
     *   返回 `{ got, complete }` 时两者分开判定 —— **显示与广播按 `got`，
     *   永久缓存与清冷却按 `complete`**（理由见文件头）。
     */
    async run(run) {
        if (this.inFlight !== undefined) {
            await this.inFlight;
            return;
        }
        if (this.cooling())
            return;
        // ⚠ **不能**写成 `this.inFlight = (async () => { … finally { this.inFlight = undefined } })()`：
        // 若 `run()` **同步抛错**，那个 IIFE 会在任何 `await` 之前整段同步跑完
        // （catch → finally 把 `inFlight` 置回 `undefined`），**然后**外层赋值又把
        // `undefined` 覆盖成一个**已 settle** 的 Promise。此后
        // `inFlight !== undefined` 永远先命中 ⇒ 该 provider 永久不再重拉，
        // 冷却到期也救不回。
        // ⇒ 先把任务落成局部量、await 之后再清，并只清「仍是自己那一个」。
        const task = (async () => {
            try {
                return normalizeLoadResult(await run());
            }
            catch {
                // 拉取自身抛错与「返回空目录」同等对待：都没拿到目录。
                return { got: false, complete: false };
            }
        })();
        this.inFlight = task;
        this.lastAttemptAt = this.now();
        try {
            const { got, complete } = await task;
            // ⚠️ 冷却按 **complete**：残缺目录也该在冷却后重试补齐（否则永远补不回来），
            // 而完全拿全时立即清冷却（无重试必要）。
            this.retryAt = complete ? undefined : this.now() + this.cooldownMs;
            // ⚠️ 通知放在 `await task` **之后**：此刻适配器才刚把目录赋给
            // `remoteModels`，客户端重读才拿得到新数据。早于它广播等于白广播。
            // 只按 **got**：残缺目录也要广播（客户端至少能显示补齐的那部分）。
            // ⚠️ 通知自身抛错**不得**反噬目录加载：目录已经落地了，因通知失败而让
            // `run()` 抛错会让调用方（`listModels` 的宿主路径）以为加载失败。
            if (got) {
                try {
                    this.onLoaded?.();
                }
                catch {
                    // 通知是尽力而为；失败只影响界面刷新时机，不影响目录本身。
                }
            }
        }
        finally {
            if (this.inFlight === task)
                this.inFlight = undefined;
        }
    }
    /** 清掉冷却窗口（例如用户显式触发刷新）。 */
    reset() {
        this.retryAt = undefined;
    }
}
//# sourceMappingURL=remote-catalog-gate.js.map