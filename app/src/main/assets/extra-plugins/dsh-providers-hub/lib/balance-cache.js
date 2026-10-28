/**
 * 账号余额**读数**的共享缓存（基础设施层）。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.7
 *
 * ## ⚠️⚠️ 本模块的定位（用户 2026-10-15 的更正原话）
 *
 * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
 * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
 * 基础设施上的使用逻辑」
 *
 * ⇒ 本模块共享的是「**同一账号的余额读数**」，**不是**「谁该被读」：
 *
 * | 层 | 谁负责 |
 * |---|---|
 * | 缓存（本模块） | 同一个 `(provider, accountId)` 在 TTL 内复用同一次读数 |
 * | 取数（注入的 `fetch`） | 各渠道自己的协议（本模块**不认识**任何上游形状） |
 * | **取舍**（调用方） | 积分面板要**全部**账号（含停用）；用量徽标只要**启用**账号；聚合只要**可用**账号 |
 *
 * ⚠️ 三者不要混：把「谁该被读」塞进本模块，会让同一个账号在不同调用路径下拿到
 * **不同的缓存条目**（那正是「共享缓存」失效的形态）。
 *
 * ## 为什么用 `TtlCache`（而不是自建 Map）
 *
 * 与 `usage-badge.ts`（`:180-191` 的 `cacheFor`）**同款**：懒建实例、`ttlFor` 按结果分档。
 * 自建一份会立刻产生「两套 TTL 判据」——本仓库红线。
 *
 * ## ⚠️ `load` 是零参契约 ⇒ 用「可变槽」把条目喂进去
 *
 * `TtlCache.load` 的签名是 `() => Promise<T>`（`src/ttl-cache.ts:39`），而
 * 「这次要读哪个账号」是**运行时**才知道的。⇒ `read()` 先把条目写进 `slots`，再
 * 调 `cacheOf(key).get({ force })`；`load` 从槽里取。
 *
 * ⚠️ **这是本模块唯一需要解释的技巧**：换成「把条目闭包进 `load`」要求每个账号一个闭包，
 * 而账号是运行时才知道的（且账号会增删）⇒ 只能靠槽。
 *
 * ## 三条必须遵守的约束（规格 §5.7.4）
 *
 * 1. **取消语义**：调用方 `await read(...)` 之后必须自己 `signal?.throwIfAborted()` ——
 *    用户可见的取消行为**逐字节不变**（立刻 `AbortError`），但**本次上游填充会跑完**
 *    （读数进缓存，不浪费）。⚠️ 「abort 不得被折叠成 `UNUSABLE`」是本仓库复发过三次的
 *    铁律，本处是**新增的第四种形态**：`fetch` 抛的中止错误必须**原样上抛**，
 *    **不得**记成 `error` 读数。
 * 2. **顺序**：逐账号**串行**取数，**不得**改成 `Promise.all` —— 并发打上游会触发限流
 *    （照 `collectCreditBalances`（`src/jet-hub-rpc.ts`）的既有体例，那里有实测记载）。
 * 3. **失败是「值」不是「抛错」**：`{ error }` 读数按 `failureTtlMs` 缓存（15 秒）。
 *    若让失败抛错，`TtlCache` 的「抛错不缓存」会让失败被**无限重试**
 *    （上游限流时那是最坏结果）。
 *
 * @module src/balance-cache.ts
 */
import { TtlCache } from './ttl-cache.js';
/** 陈旧兼顶的默认上界（15 分钟）。 */
const DEFAULT_STALE_TTL_MS = 900_000;
/**
 * 刷新周期缺省值（60 秒 = 共享缓存 `ttlMs` 的一半）。
 *
 * ⚠️ **理由（别丢）**：周期恰等于 `ttlMs` 时，条目会在**刚过期的那一刻**才被刷
 * ⇒ 读路径仍会频繁撞上「陈旧且后台刚开始刷」，常新目标落空。取一半 ⇒ 任何时刻
 * 至少有半个周期的余量。
 *
 * ⚠️ **刻意不新增第三套 TTL 常量**：它与 `ttlMs` 是**同一条语义的两个尺度**
 * （缓存寿命 / 保鲜节奏），写死一份会让人以为二者可以各自独立调。
 *
 * ⚠️ **导出**是为了装配层不再写死同一个字面量（`src/index.ts` 的 `intervalMs`）——
 * 那正是「提常量」要消除的重复；装配层**必须**引用本常量而不是重打一遍 `60_000`。
 */
export const REFRESH_PERIOD_FALLBACK_MS = 60_000;
/** 默认的中止判据（**最保守**；装配层应注入共享实现，见 `BalanceCacheOptions.isAbort`）。 */
function defaultIsAbort(error) {
    return error?.name === 'AbortError';
}
/**
 * 建一个余额读数缓存。见模块头的三条约束与「可变槽」的说明。
 */
export function createBalanceCache(options) {
    const failureTtlMs = options.failureTtlMs ?? 15_000;
    // ⚠️ 陈旧兼顶的**上界**必须有（见 `staleTtlMs` 的注释）：无界兼顶会让一次
    //   读数命中后永久生效，用户看到一天前的余额而 UI 只写「来自 HH:MM」。
    const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    const isAbort = options.isAbort ?? defaultIsAbort;
    const now = options.now ?? (() => Date.now());
    /** `provider\0accountId` → 该账号的缓存实例（懒建，与 `usage-badge.ts:180-191` 同款）。 */
    const perAccount = new Map();
    /**
     * 可变槽：`key` → **本次要读的那个账号条目**（`load` 是零参契约，只能这样喂进去）。
     * ⚠️ 后写覆盖先写是**无害**的：两个并发 `read()` 对同一个账号会共用同一次在飞 `load`
     *（`TtlCache.get` 的去重），而它们传的条目是同一个账号 ⇒ 内容相同。
     */
    const slots = new Map();
    /**
     * ★ `key` → **最后一次成功读数**（兼顶的权威来源，2026-10-16 审计 P2 修正）。
     *
     * ## 为什么不能用 `TtlCache` 的槽位当兼顶来源（实测复现的缺陷）
     *
     * 初版在 `readStale` 里 `peekStale()` 取旧值、失败后**回滚写入**槽位。
     * 那在**顺序**调用下能工作，但**并发**下会失效：
     *
     * ```
     * A: peekStale() → 旧值 ✓      B: peekStale() → undefined ✗
     * A: get() 失败 → 写失败读数
     * B: get() 命中那条失败读数     ⇒ B 的 previous 已经是 undefined
     * ```
     *
     * 实测（两个并发 `readStale`、上游失败）：**两个都拿不到兼顶值** ——
     * 比「只有一个拿不到」更糟，因为先到的那个也会被后到的覆盖掉。
     *
     * ⇒ 生产路径复刻显示：面板轮询与对话请求并发时，**面板显示有余额、
     *   选号器同时报「余额查询失败」** —— 正是 IKMCOO 要消灭的那个矛盾，
     *   在并发下原样复现。
     *
     * ## 为什么这张表能解决
     *
     * 它**只写成功读数**（`fresh.error === undefined` 时才 `set`），与失败无关
     * ⇒ 任何并发时序下都不会被覆盖掉。且写入时机在 `get()` **之后**，
     * 并发的两个 `get()` 共用同一次在飞 load（`TtlCache` 的去重），
     * 因此也只会写一次相同的内容。
     */
    const lastSuccess = new Map();
    const keyOf = (provider, accountId) => `${provider}\u0000${accountId}`;
    /**
     * 取**一个账号**的读数：把失败也变成读数，**只有中止例外**（见模块头约束 1）。
     */
    const fetchReading = async (provider, entry) => {
        const at = now();
        try {
            const value = await options.fetch(provider, entry);
            /**
             * ⚠️⚠️ **成功读数统一在这里记账**（2026-10-16 对抗审计 P2 修正）。
             *
             * 三条取数路径都经过本函数（`read` / `readOne` / `readStale` 的回源），
             * 在这里记一次即可**覆盖全部**入口；而 `write`（端点回写）是唯一的旁路，
             * 它自己补一次。
             *
             * ⚠️ 为什么必须独立于 `TtlCache` 的槽位：槽位会被**并发**下的另一条
             *   `get()` 覆盖成失败读数（实测两个并发 `readStale` 都拿不到兼顶值）。
             */
            lastSuccess.set(keyOf(provider, entry.id), { at, value });
            return { at, value };
        }
        catch (error) {
            // ⚠️⚠️ **中止必须原样上抛**（铁律的第四种形态）：
            //    它不是「读不到余额」，而是「这次请求被取消了」—— 记成 `error` 读数会让
            //    撤回操作看起来像上游故障，且（因为失败读数短 TTL）下一轮会**再打一次**。
            if (isAbort(error))
                throw error;
            return {
                at,
                value: undefined,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };
    const cacheOf = (key) => {
        const existing = perAccount.get(key);
        if (existing !== undefined)
            return existing;
        const created = new TtlCache({
            ttlMs: options.ttlMs,
            // ⚠️ 成功/失败两种 TTL **在这一侧按结果表达**（`TtlCache` 现成支持，见规格 §5.7.2）。
            ttlFor: (reading) => (reading.error === undefined ? options.ttlMs : failureTtlMs),
            now: options.now,
            load: async () => {
                const slot = slots.get(key);
                if (slot === undefined) {
                    // 不可达（`read()` 必然先填槽）。留着是为了让「有人绕过 read 直接 get()」
                    // 这类接线错误**立刻可见**，而不是静默打一次空请求。
                    throw new Error('balance-cache: 内部缺陷，请通过 read() 取数');
                }
                return await fetchReading(slot.provider, slot.entry);
            },
        });
        perAccount.set(key, created);
        return created;
    };
    /**
     * ★ 读路径的统一入口：命中新鲜值直返；命中陈旧值**立刻返回旧值**并标 `stale`。
     *
     * ## ⚠️ 读路径**不发任何请求**（本设计的核心不变量）
     *
     * 陈旧命中时**既不 await 也不 `void` 发起后台重取** —— 重取由**后台刷新器**
     * 负责（同文件末尾的 `createBalanceRefresher`，2026-10-18 已实现）。⇒「逐账号串行取数」这条
     * 铁律（模块头约束 2）在读路径上**天然成立**：这里一个请求都不发；**刷新器侧自己承担
     * 串行**（它才是新的请求来源）。
     *
     * ## ⚠️ 为什么曾经在这里发过后台重取，以及为什么被撤掉（实测缺陷）
     *
     * 上一版（提交 `94ae01b` 的 stale-while-revalidate）在陈旧命中时写了
     * `void cache.get().catch(() => {})`。`read` 的 `for…of` 循环里，
     * `await getServingStale(...)` 在陈旧命中时**立即 resolve**（返回旧值），
     * 但那个后台取数的 promise **仍在飞** ⇒ 循环随即进入下一个账号，
     * 于是 `a2` 的重取与 `a1` 的**重叠**。
     *
     * 实测（两个陈旧账号）：`maxInflight = 2`，
     * `order = ["start:a1", "start:a2", "end:a1", "end:a2"]`
     * （基线版本恒为 `maxInflight = 1`）⇒ 用户症状是「切 provider 面板时一次性向
     * 同一上游打出 N 个并发请求」⇒ 触发风控。
     *
     * ⇒ 守卫：`tests/unit/balance-cache.spec.ts` 的
     *   「★★ 陈旧读路径下 `read` **一次请求都不发**」。
     *
     * ## 为什么不是 `cache.get()`
     *
     * `TtlCache.get()` 在条目一过 `ttlMs` 就同步回源 ⇒ 切 provider 面板时用户必须
     * 等一次完整上游往返（loomy 单请求上限 60s，见 `src/loomy.ts:45`）。
     *
     * ## 三条必须遵守的语义
     *
     * 1. **没有旧值时照常回源**：兼顶**不得**取代真实取数能力，否则未接线的渠道
     *    会恒不可用。冷启动仍要等一次真读 —— 这是本设计**刻意接受**的（规格 §3.2）。
     * 2. **`force` 不走本函数**：强制刷新必须同步等真实取数（见 `read`/`readOne`
     *    里的早退分支）。
     * 3. **陈旧值不写回 `TtlCache` 槽位**：`readStale` 已有同款约定（`readStale`
     *    的注释）—— 让失败读数占住唯一槽位会毁掉兼顶能力。
     *
     * @param provider - 渠道 id（回源需要；**必须是显式入参** —— `BalanceCacheEntry`
     *   上**没有** `providerHint` 字段，只有 `id` 与 `credential`）
     * @param key - `provider\0accountId`
     * @param cache - 该键的缓存实例
     * @param entry - 取数所需的条目（`load` 从槽里取）
     */
    const getServingStale = async (provider, key, cache, entry) => {
        // ⚠️ **只能用 `peekStale()`，不可改成先调 `peek()`**（它会销毁兼顶来源）。
        //
        // `TtlCache.peek()` 在条目过期那一刻会**顺手丢弃**它（`src/ttl-cache.ts:129`
        // 的 `this.entry = undefined`）⇒ 若先调 `peek()`，条目已被销毁，
        // 随后的 `peekStale()` 恒为 `undefined` ⇒ 兼顶分支**永远走不到**
        // （实测：改回 brief 的 `peek()` 在前写法，两条新用例实测恒红）。
        // ⇒ 这里只用 `peekStale()` 一条判据：它对新鲜/过期**都**返回条目并带 `stale` 标记。
        const held = cache.peekStale();
        if (held !== undefined && held.stale !== true)
            return held.value;
        if (held !== undefined && held.value.value !== undefined) {
            // ⚠️⚠️ **读路径在这里不发任何请求**（不 await、也不 `void` 后台重取）：
            //    见上面「读路径不发任何请求」的实测记录 —— 在 `for…of` 里发后台重取会
            //    让相邻账号的取数**重叠**（实测 `maxInflight = 2`）⇒ 并发打上游触发风控。
            //    重取由后台刷新器负责（`createBalanceRefresher`，同文件末尾）。
            // ⚠️ 诚实登记：本条路径返回**副本**（`{ ...held.value, stale: true }`），
            //    而上面的新鲜路径返回缓存对象**本体**。这个不对称是**既有行为**，
            //    本次**不改**；记在这里是为免后人误以为它是有意设计的语义差别。
            return { ...held.value, stale: true };
        }
        // 没有可兼顶的值 ⇒ 照常回源（冷启动路径）。
        slots.set(key, { provider, entry });
        return await cache.get();
    };
    return {
        async read(provider, entries, readOptions = {}) {
            const out = new Map();
            // ⚠️ **串行**（约束 2）：`for…of` + `await`，不是 `Promise.all`。
            for (const entry of entries) {
                if (typeof entry?.id !== 'string')
                    continue;
                const key = keyOf(provider, entry.id);
                slots.set(key, { provider, entry });
                const cache = cacheOf(key);
                // ⚠️ `force` 只影响**这一次**读取（**不** `clear()` 缓存）：面板「刷新」不该
                //    顺手把徽标正在用的读数也作废 —— 两者**共享**这份缓存，正是本模块的意义。
                // ⚠️ `force` 直接走 `get()`（同步等真实取数），**不走兼顶** ——
                //    否则面板「刷新积分」会变成假按钮。
                out.set(entry.id, readOptions.force === true
                    ? await cache.get({ force: true })
                    : await getServingStale(provider, key, cache, entry));
            }
            return out;
        },
        peek(provider, accountId) {
            return perAccount.get(keyOf(provider, accountId))?.peek()?.value;
        },
        peekStale(provider, accountId) {
            const entry = perAccount.get(keyOf(provider, accountId))?.peekStale();
            // ⚠️ `stale` 标记必须**带出来**：无它时刷新器分不清「新鲜」与「过期」，
            //   而本接口的签名（`& { stale: true | false }`）承诺了它。
            return entry === undefined ? undefined : { ...entry.value, stale: entry.stale };
        },
        /**
         * ★ 后台重取**单个**账号（供刷新器调用）。
         *
         * ⚠️ 走 `force: true`：刷新器**只**在自己判完「该刷」之后才调这里，所以这里
         *   必须绕过 TTL 与兼顶，否则「已过周期但仍在 TTL 内」那档会刷成空操作。
         * ⚠️ 槽里必须带 `credential`：`fetchBalanceReading`（`src/index.ts`）在
         *   `entry.credential === undefined` 时直接抛「凭据未提供」⇒ 刷新器**必须**
         *   解析出凭据再调本方法，否则每一轮都记成失败读数。
         */
        async refreshOne(provider, accountId, entry) {
            const key = keyOf(provider, accountId);
            slots.set(key, { provider, entry: { id: accountId, ...entry } });
            await cacheOf(key).get({ force: true });
        },
        async readOne(provider, accountId, entry, readOptions = {}) {
            const key = keyOf(provider, accountId);
            // ⚠️ 槽里必须带 `id`：`fetch` 的签名吃 `BalanceCacheEntry`（各渠道的取数原语
            //    要用它做日志/二次查询），而本方法的入参只有 `credential`。
            slots.set(key, { provider, entry: { id: accountId, ...entry } });
            const cache = cacheOf(key);
            // ⚠️ **返回值的 `stale` 字段**：聚合折算侧据此判 `UNUSABLE`（Task 3）。
            //    ⚠️ `force` 不兼顶：用户点「刷新」就是要看真实结果（见 `readStale` 的同款约定）。
            return readOptions.force === true
                ? await cache.get({ force: true })
                : await getServingStale(provider, key, cache, { id: accountId, ...entry });
        },
        /**
         * ★ 兼顶读取：成功用新值，失败回落**上一次的成功值**。
         *
         * ## ⚠️ 为什么不复用 `readOne` + 外面判 `error`
         *
         * 那样做需要调用方自己再查一次「旧值还在不在」，而旧值在 `readOne` 内部
         * 已经被 `get()` 用 `write()` **覆盖成失败读数**了 ⇒ 旧值在那一刻就丢了。
         * ⇒ 兼顶必须发生在**写入失败读数之前**，这是本方法存在的全部理由。
         *
         * ## ⚠️ 为什么失败读数**仍然写进缓存**
         *
         * 缓存里此刻既有失败读数、又有（更旧的）成功读数，两者不能共存于同一个
         * `entry` —— 故 `readStale` **不**把兼顶结果写回：`TtlCache` 只有一个槽位，
         * 让失败读数占住它会**毁掉兼顶的能力**（下一轮再来时旧值已经没了）。
         * ⇒ 代价：紧接着的 `readOne` 会再打一次上游。那正是「兼顶与严格读取不可兼得」
         *   的诚实登记，不是缺陷。
         */
        async readStale(provider, accountId, entry, readOptions = {}) {
            const key = keyOf(provider, accountId);
            const cache = cacheOf(key);
            const limit = readOptions.staleTtlMs ?? staleTtlMs;
            const force = readOptions.force === true;
            slots.set(key, { provider, entry: { id: accountId, ...entry } });
            const fresh = await cache.get({ force });
            /**
             * ⚠️⚠️ **成功 ⇒ 立刻记进「最后成功值」表**（2026-10-16 审计 P2）。
             *
             * 写入时机在 `get()` **之后**且**只在成功时**：并发���个 `get()` 共用同一次
             * 在飞 load（`TtlCache` 去重）⇒ 只会写一次相同内容 ⇒ 表不会被覆盖。
             */
            if (fresh.error === undefined) {
                // ⚠️ **兼顶回滚的值不算「成功」**：它是上一轮的成功值 + 本轮的失败，
                //   若把它当新鲜成功写进表，就会**刷新兼顶上界的计时起点** ⇒ 上界永不到期。
                if (fresh.stale !== true)
                    lastSuccess.set(key, fresh);
                return { at: fresh.at, value: fresh.value, stale: false };
            }
            // ⚠️ 兼顶来源是**独立的最后成功值表**，不是 `TtlCache` 的槽位
            //   （槽位在并发下会被失败读数覆盖，实测两个并发都拿不到兼顶值 ——
            //   见上面 `lastSuccess` 的注释）。
            const previous = lastSuccess.get(key);
            // ⚠️ **没有旧值可兼顶**（含「旧值已被 `write`/`clear` 丢弃」）⇒ 如实报错。
            if (previous?.value === undefined) {
                cache.set({ at: fresh.at, value: undefined, error: fresh.error });
                return { at: fresh.at, value: undefined, error: fresh.error, stale: true };
            }
            // ⚠️ **兼顶有上界**：超龄的旧值不再使用 —— 否则一次读数命中后就永久生效。
            // ⚠️⚠️ 判据读 `previous.at`（`BalanceReading` 的字段名，**不是** `atMs`
            //    —— 那是 `TtlCache.Entry` 的字段名，两层结构不同）。我第一版写成
            //    `previous!.atMs` ⇒ `NaN >= limit` 恒假 ⇒ **上界形同虚设**，
            //    任何陈旧值都会被无限兼顶（守卫用例实测打穿）。
            // ⚠️ **`force` 下不兼顶**：用户点了面板「刷新」就是要看真实结果，
            //   「刷新后仍显示旧值」比报错更难解释。
            if (force || now() - previous.at >= limit) {
                cache.set({ at: fresh.at, value: undefined, error: fresh.error });
                return { at: fresh.at, value: undefined, error: fresh.error, stale: true };
            }
            /**
             * ⚠️ **兼顶值必须标 `stale`**（2026-10-16 审计 P1-2，实测复现）。
             *
             * 不标的后果：下次 `get()` 在 TTL 内直接命中 ⇒ 返回 `{ stale: false }` ⇒
             * 「本次查询失败」的标注凭空消失，用户误以为上游已恢复（而上游还挂着）。
             * **比报错更糟**（它看起来成功了）。
             *
             * ⚠️ 而它**不能**写进 `lastSuccess`（见上面成功分支的注释）。
             */
            return {
                at: previous.at,
                value: previous.value,
                error: fresh.error,
                stale: true,
            };
        },
        write(provider, accountId, reading) {
            // ⚠️ 失败读数**不写**：见 `BalanceCache.write` 的注释（失败是瞬时的，
            //    写进去会让折算侧把「刚失败过一次」当成当前结论）。
            if (reading.error !== undefined)
                return;
            cacheOf(keyOf(provider, accountId)).set(reading);
            // ⚠️⚠️ **同时更新「最后成功值」表**（2026-10-16 审计 P2）：
            //   `credits.balances` 端点走的是 `write` 而**不是** `readStale`
            //   （它自己取数后回写）⇒ 不更新这张表的话，**只有面板查过的账号**
            //   才可能兼顶，选号器/聚合侧的 `readStale` 会读到 `undefined`。
            lastSuccess.set(keyOf(provider, accountId), reading);
        },
        clear(provider) {
            if (provider === undefined) {
                for (const cache of perAccount.values())
                    cache.clear();
                perAccount.clear();
                slots.clear();
                // ⚠️⚠️ **兼顶表也必须清**（2026-10-16 审计 P2）：留着会让「已 clear 的账号」
                //   仍能拿到陈旧值 —— 症状是「账号删了还能显示余额」，且**零报错**。
                lastSuccess.clear();
                return;
            }
            const prefix = `${provider}\u0000`;
            for (const [key, cache] of [...perAccount.entries()]) {
                if (!key.startsWith(prefix))
                    continue;
                cache.clear();
                perAccount.delete(key);
                slots.delete(key);
                lastSuccess.delete(key);
            }
        },
    };
}
/**
 * ★ 后台刷新器：定时把**该刷的**条目重取一遍，让缓存常新。
 *
 * ## 为什么需要它（用户 2026-10-18 的原话）
 *
 * 「这个缓存不是应该一直存在并且自动在 2 分钟重新刷新，我们外面的请求是一直都缓存，
 * 和缓存每 2 分钟自己更新一次不矛盾，为什么 2 分钟后再读就过期了要重新直读呢？
 * 这个 2 分钟是 interval 不是 timeout」
 *
 * ⇒ 原实现是 **cache-aside**（读驱动）。读路径改成 stale-while-revalidate 后，
 *   陈旧命中**一个请求都不发**（提交 `a725101`：发了会与相邻账号的重取重叠，
 *   实测 `maxInflight = 2` ⇒ 触发风控）⇒ 重取这条腿**只剩本类**。
 *   本类补上「后台」那一半。
 *
 * ## 周期取值：默认 `ttlMs` 的一半
 *
 * 周期恰等于 `ttlMs` 时，条目会在**刚过期的那一刻**才被刷 ⇒ 读路径仍会频繁撞上
 * 「陈旧且后台刚开始刷」，常新目标落空。取一半 ⇒ 任何时刻至少有半个周期的余量。
 *
 * ## ⚠️ 三条判据（各对应一个真缺陷）
 *
 * | 条目状态 | 刷？ | 理由 |
 * |---|---|---|
 * | 从未读过 | ✅ | 否则它永远进不了缓存 |
 * | 成功读数，已过一个刷新周期 | ✅ | 正常保鲜 |
 * | 成功读数，仍在周期内 | ❌ | 没必要（读请求会命中，省一次上游） |
 * | 失败读数，未超 `staleTtlMs` | ❌ | 否则**每 15 秒打一次上游** |
 * | 失败读数，已超 `staleTtlMs` | ✅ | 不得永久卡在失败上 |
 *
 * ⚠️ 「失败条目跳过」是**新增判断**：失败读数走 15s 短 TTL，本意是
 * 「别把一次抖动缓存成『额度用尽』」；若每轮都重试，正好违背这条规则的原意。
 * 失败期间由 `lastSuccess` 的旧值兼顶着。
 *
 * ## ⚠️ 逐账号**串行**是本类的**承重约束**
 *
 * `a725101` 之前，串行由「读路径的 `for…of` + `await`」天然保证；删掉读路径的后台
 * 重取之后，**本类成了新的请求来源**，串行必须自己扛 ——
 * 守卫见 `tests/unit/balance-cache.spec.ts` 的「刷新**逐账号串行**」（**两个**账号，
 * 单账号时串行与并行不可区分）。
 *
 * ## 停用账号低频刷（不完全不刷）
 *
 * 停用只影响自动选号（仓库铁律「续期不得按 `enabled` 过滤」），凭据仍需保鲜 ——
 * 用户重新启用时不该拿到死凭据。但用户看不到它们，不值得每轮都打。
 * ⇒ 判据**从 `staleTtlMs` 派生，不新增常量**。
 */
export function createBalanceRefresher(cache, options) {
    const now = options.now ?? (() => Date.now());
    const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    const periodMs = options.intervalMs ?? REFRESH_PERIOD_FALLBACK_MS;
    const setIntervalImpl = options.setInterval
        ?? ((fn, ms) => setInterval(fn, ms));
    /**
     * ⚠️ 注入假定时器时**不得**用全局 `clearInterval` 去停它（句柄对不上，会静默
     * 停不掉真定时器或抛错）⇒ 分流：只有用全局工厂时才走 `clearInterval`。
     */
    const clearImpl = options.setInterval === undefined
        ? (handle) => { clearInterval(handle); }
        : () => { };
    let timer;
    /** ⚠️ **防重入闸门**必须有：一轮含真实网络请求（可达数十秒）。 */
    let running = false;
    /**
     * ★ 刷新器**诞生时刻**（`startEpoch`）：用来判定「这个账号从进程起来到现在
     *   有没有刷过」，作为「从未刷过」的兜底起点。
     *
     * ## ⚠️ 为什么不能写 `?? 0`（第一版的实测缺陷）
     *
     * `lastFlushedAt.get(key) ?? 0` ⇒ `now() - 0` 恒等于「当前时刻」，而真实时刻
     * 远大于任何 `staleTtlMs` ⇒ **判据恒真** ⇒ 首轮就把**每条**失败条目和**每条**
     * 停用账号全刷一遍（恰好违背这两条要防的事）。
     *
     * ## ⚠️ 也不能直接「没有记录就跳过」（第二版的实测缺陷）
     *
     * 那会让「从未刷过」的条目**永远**刷不到：停用账号（首轮跳过）再没有任何事件
     * 给它补上 `lastFlushedAt` ⇒ 它再也不被低频刷新 ⇒ 用户重新启用时是死凭据
     * （守卫「停用账号到点必须被刷」「超兼顶上界后必须重试」实测红）。
     *
     * ⇒ 正确语义：**「距上次刷新（或进程诞生）够不够久」**，缺省起点取 `startEpoch`。
     *   `now() - startEpoch` 随时间单调增长 ⇒ 停用账号首轮跳过、之后必到点。
     */
    const startEpoch = now();
    /** 上次刷过的时刻（`provider\0accountId` → 毫秒）；**只**用于停用账号的低频节奏。 */
    const lastFlushedAt = new Map();
    /**
     * 「距上次刷过多久」的缺省起点（无记录 ⇒ 取 `startEpoch`）。
     *
     * ⚠️ 缺省**不能**写 `0`：真实时刻远大于任何 `staleTtlMs` ⇒ 判据恒真
     * ⇒ 停用账号首轮就被刷一遍（恰好违背「低频」这条要防的事）。
     */
    const lastFlushedOr = (key) => lastFlushedAt.get(key) ?? startEpoch;
    const keyOf = (provider, accountId) => `${provider}\u0000${accountId}`;
    /** 该不该刷这一条（供 `tick` 的逐账号循环调用）。 */
    const isDue = (provider, accountId) => {
        const held = cache.peekStale(provider, accountId);
        // 从未读过 ⇒ 必须刷（否则它永远进不了缓存）
        if (held === undefined)
            return true;
        // ⚠️⚠️ 读 **`held.at`**（`BalanceReading` 自己的字段），不是 `held.value.at`
        //   —— `BalanceCache.peekStale` 返回的**就是** `BalanceReading` 本体（顶层
        //   `{ at, value, error? }`），再点一层 `.value` 得到的是**上游原样返回值**，
        //   `.at` 恒 `undefined` ⇒ `age` 恒 `NaN` ⇒ **下面两条判据全部恒假**，
        //   刷新器**一轮都不会刷**（而外面看它跑得好好的、零报错 —— 恒绿形态）。
        const age = now() - held.at;
        // 成功读数：已过一个刷新周期才刷（周期内读请求会命中，省一次上游）
        if (held.error === undefined)
            return age >= periodMs;
        // ⚠️ 失败读数：**只在**超兼顶上界时重试。否则每 failureTtlMs(15s) 打一次上游
        //    ——比现状更糟，且正好违背「短 TTL 防把抖动伪装成额度用尽」的原意。
        //
        // ⚠️⚠️ **这里只有一条腿，是有意简化过的**（第一版有两条，实测证明它们
        //    **恒等价** ⇒ 属本仓库红线「同一语义两套判据」）：
        //      · 原第一腿 `age >= staleTtlMs`：读槽位年龄；
        //      · 原第二腿 `now - lastFlushedAt >= staleTtlMs`：读「上次刷过」。
        //    刷新器写失败读数时两者**同一轮同一时刻**写入 ⇒ 数学上恒等价；
        //    读路径（`readStale`）写的失败读数则只有槽位年龄在走，而那**同样**够到上界。
        //    ⇒ 两条腿合并成「槽位年龄」这一条，语义不变、判据减半。
        return age >= staleTtlMs;
    };
    const tick = async () => {
        if (running) {
            options.warn?.('[jet-hub] 上一轮余额刷新尚未结束，跳过本轮');
            return;
        }
        running = true;
        try {
            const accounts = await options.listAccounts();
            // ⚠️ **逐账号串行**（模块头约束 2）：并发打上游会触发风控。**不得** `Promise.all`。
            for (const account of accounts) {
                if (typeof account?.id !== 'string' || typeof account?.provider !== 'string')
                    continue;
                const key = keyOf(account.provider, account.id);
                // 停用账号走低频节奏（`staleTtlMs`），启用账号每轮都可能被刷。
                // ⚠️ 缺省起点取 `startEpoch`（`?? 0` 会让判据恒真，见 `startEpoch` 的注释）：
                //    首轮跳过 ⇒ 之后时钟推进到点时它**必**被刷（重新启用时不是死凭据）。
                if (account.enabled === false
                    && now() - lastFlushedOr(key) < staleTtlMs)
                    continue;
                if (!isDue(account.provider, account.id))
                    continue;
                // ⚠️⚠️ **凭据解析必须在逐账号的 `try` 之内**（2026-10-18 复审 Important 修正）。
                //
                // ## 为什么不放外面（原实现的缺陷形态）
                //
                // 装配层的 `resolveCredential`（`src/index.ts`）第一件事就是
                // `credentialRef(account.credentialRef)`，而它对不匹配
                // `/^[A-Za-z_][A-Za-z0-9_]*$/` 的名字**同步抛 `TypeError`**；
                // `ctx.credentials.resolve` 也可能 reject。
                // ⇒ 放外面时被**外层那个兜底**接住 ⇒ **一个坏账号让这一轮剩下的账号全部不刷**，
                //   且只留一条文案为「读账号列表失败」的 warn（**与真因不符** ——
                //   账号池读得好好的，坏的是某一个账号的凭据名）。
                //
                // ## 可达性（不是假想敌）
                //
                // `sanitizeAccounts`（`src/jet-hub-store.ts`）只校验 `credentialRef` 是非空字符串、
                // **不校验命名法**；账号池又可从用户可编辑的备份导入 ⇒ 一份手改备份就能造出该条目。
                // ⇒ 症状是本仓库最怕的形态：**功能整体死掉 + 只有一条措辞错误的 warn**。
                //
                // ## 为什么 `jet-hub-rpc.ts` 的同名闭包本轮**不动**
                //
                // 那边的 `resolveCredentialForCache` 有同样的问题，但它**已经在逐账号 `try` 内**
                // （该文件 L864 的注释已写明「关键约束：凭据解析也在 try 之内」）⇒ 炸不到别的账号。
                // 本条补的是**同一个缺陷、不同的爆炸半径**，故只修刷新器这一处。
                //
                // ## 为什么 catch 里还要分 `stage`
                //
                // 凭据名解析失败与「上游取数失败」是两件完全不同的事，而这条 warn 是
                // 用户/维护者**唯一**能看到的线索 ⇒ 合并成「刷新余额失败」等于把真因埋掉。
                // ⚠️⚠️ **`stage` 必须声明在 `try` 之外**：`catch` 里读它，而声明在 `try` 体内的
                //   `let` 在异常路径上不可见 ⇒ 第一版写在 `try` 里，实测报
                //   `ReferenceError: stage is not defined` ⇒ **异常冒到外层兜底**
                //   （与本次要修的缺陷**完全同形**：整轮作废 + 措辞错误的 warn）。
                let stage = '解析凭据';
                try {
                    // ⚠️ 凭据取不到就**不打上游**：那一枪必然失败（见 `resolveCredential` 的注释）。
                    let credential;
                    if (options.resolveCredential !== undefined) {
                        credential = await options.resolveCredential(account.credentialRef);
                        if (credential === undefined)
                            continue;
                    }
                    stage = '取数';
                    await cache.refreshOne(account.provider, account.id, { credential });
                    lastFlushedAt.set(key, now());
                }
                catch (error) {
                    // ⚠️ 绝不上抛：一轮失败不得让定时器停摆（`refresh-scheduler.ts` 同款）。
                    //    abort 在此被吃掉是**刻意的**：后台刷新没有调用方可通知，
                    //    而 abort 铁律约束的是**读路径**（本模块头约束 1）。
                    const cause = error instanceof Error ? error.message : String(error);
                    if (stage === '解析凭据') {
                        options.warn?.(`[jet-hub] 解析账号 ${account.id} 的凭据失败（ref=${account.credentialRef}），`
                            + `已跳过该账号：${cause}`);
                        continue;
                    }
                    options.warn?.(`[jet-hub] 后台刷新余额失败（账号 ${account.id}，照常继续）：${cause}`);
                }
            }
        }
        catch (error) {
            // ⚠️ `listAccounts` 抛错同样不得让定时器停摆（账号池尚未落盘等）。
            options.warn?.(`[jet-hub] 后台刷新读账号列表失败（照常继续）：`
                + `${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            running = false;
        }
    };
    return {
        start() {
            // ⚠️ **幂等**：重复武装会叠加出多个 interval，刷新频率随登录/重启次数翻倍
            //（`MultiAccountRefreshScheduler.notifyAccountAdded` 的同款理由）。
            if (timer !== undefined)
                return;
            timer = setIntervalImpl(() => { void tick(); }, periodMs);
            timer.unref?.(); // 不拦进程退出（与既有定时器同款）
            options.info?.(`[jet-hub] 余额缓存后台刷新器已武装（每 ${Math.round(periodMs / 1000)} 秒一轮）`);
        },
        tick,
        stop() {
            if (timer === undefined)
                return;
            clearImpl(timer);
            timer = undefined;
        },
        isArmed: () => timer !== undefined,
    };
}
//# sourceMappingURL=balance-cache.js.map