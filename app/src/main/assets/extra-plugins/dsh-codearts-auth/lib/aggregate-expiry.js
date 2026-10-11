/**
 * 「渠道余额 → 最早失效时刻」的**唯一口径**。
 *
 * ## 为什么单独一个文件（而不是并进 `aggregate-core.ts` / `aggregate-adapter.ts`）
 *
 * | 候选位置 | 为什么不行 |
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 的 `expiryOf` 要复用它 ⇒ 依赖方向变成 `auto-adapter → aggregate-adapter`（**层次颠倒**，聚合适配器是更上层的东西） |
 * | `aggregate-core.ts` | 该文件定位是**纯逻辑**（哨兵 / 排序 / 倍率解析，模块头明写、零 import），而本模块要发网络请求 ⇒ 把 IO 混进纯函数模块，且 `aggregate-core.spec.ts` 这个纯函数单测会**被迫加载网络模块** |
 * | ✅ 本文件 | 单一职责；两个适配器都依赖它，方向正确 |
 *
 * ## ⚠️ 四个 `*Expiry` 是**搬移**进来的，不是复制
 *
 * 它们原先私有在 `auto-adapter.ts` 里（`private async buddyExpiry` 等）。Task 7
 * 把 `expiryOf` 改成委托本模块的 {@link createExpiryProbe} 后，若原处再留一份，
 * 就成了**同一语义两套实现**——本仓库对此有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据而产生**静默失效**：不报错、
 * 不崩溃、单测能过，只是把「没做到」说成「做到了」）。
 * Task 3 已用同样手法处理过 `pickSoonestProvider` / `priceFactorFromName`。
 *
 * @module src/aggregate-expiry.ts
 */
import { NEVER, UNUSABLE } from './aggregate-core.js';
import { fetchCreditBalance } from './credits.js';
import { CODEBUDDY, WORKBUDDY } from './product.js';
import { LOOMY } from './loomy-product.js';
import { fetchLoomyCreditDetail } from './loomy-credits.js';
import { fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js';
import { fetchZcodeBalance } from './zcode-upstream.js';
import { nextUtc8DayStartMs } from './model-queue.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js';
import { TRAE } from './trae-product.js';
import { fetchTraeCreditBalance } from './trae-credits.js';
/**
 * 真实临期探针：**每个渠道折算成一个「最早失效时刻」**。
 *
 * ## 逐渠道判据（口径与 `jet-hub-auto` 完全一致，故复用同一套端点）
 *
 * | provider | 判据 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 有效资源包 `deductionEndTime` 的最小值（**共享** `sharedPackageExpiry`）；**无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`** | `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` → 当日 24:00；否则 `permanent > 0 ? NEVER : UNUSABLE` | 命名池，无时间戳 |
 * | codearts | **`NEVER`（长期）** | ⚠️ **报文无任何时间字段**（实测三字段全空）⇒ 不臆造 |
 * | zcode | 各桶 `expiresAt`（秒）最小值；**有余额但无到期时间 → 当日**；余额为 0 → `UNUSABLE`；**企业版（`enterprise`）→ `NEVER`** | `zcode-upstream.ts` |
 * | 其余（qoder / qodercn / cline / raccoon / minimax / gemini / opencode） | **本插件未接入** → `UNUSABLE` | 见设计文档 §9.1 |
 *
 * ## ⚠️ 未接入的渠道必须返回 `UNUSABLE`，**不能**返回 `NEVER`
 *
 * `NEVER` 的语义是「可用、只是无临期额度」，它**参与排序且可当选**。若把一个
 * 尚未实现的渠道折算成 `NEVER`，它会以「永久积分」的身份参与轮换 —— 而我们对
 * 它的余额**一无所知**（可能早就用尽了），结果是请求被发到一个没额度的渠道。
 * ⇒ 未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，不可把未知当可用。**
 *
 * ## 为什么只探「一个代表账号」
 *
 * 渠道**内部**的换号由各适配器每次请求现做（buddy/loomy 走余额选号器，其余走
 * `getAvailableAccount` + 429 换号）。本层只回答「这个渠道现在能不能用、它的
 * 临期额度大概什么时候作废」，不替它们选账号。
 *
 * ## ⚠️ 取代表账号时必须带**真实 modelId**
 *
 * `getAvailableAccount` 对空 `modelId` 会**跳过限流过滤**（`account-pool.ts`），
 * 于是取回的是「手动序第一个启用账号」——**哪怕它此刻正在限流**。后果是多账号
 * 池里临期额度被完全忽略。故这里先取一个真实模型 id 再取号。
 *
 * ⚠️ `AbortError` **不得**折算成 `UNUSABLE`：用户取消请求时看到「请先登录」
 * 是误导（真实缺陷，PR !69 审计实测）。
 */
/**
 * **已接入临期折算**的渠道 id（`createExpiryProbe` 的 `switch` 覆盖的那几家）。
 *
 * ## ⚠️ 为什么必须导出（审计轮次二实测证伪的缺陷）
 *
 * 聚合层的目录会**广告**出所有能推导出规范名的虚拟模型 —— 包括**候选全来自
 * 未接入渠道**的那些。但那些候选一律被折算成 `UNUSABLE`（正确，见上方注释），
 * 于是用户选中它拿到的是：
 *
 * ```
 * MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
 *                      或所有渠道都无可用账号）
 * ```
 *
 * ⇒ 把「**该渠道的临期折算尚未实现**」谎报成「**你没登录 / 渠道被关**」——
 * 正是本仓库反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时
 * `listModels('aggregate')` 仍返回 `['auto','deepseek-v4-1-flash','muse-spark-1-3']`。
 *
 * ⇒ 聚合目录只播报「**至少有一个已接入候选**」的虚拟模型；`auto` 不受影响
 *（它的池跨全部渠道，任一已接入渠道有账号就能路由）。
 *
 * ⚠️ **本清单必须与下方 `switch` 的分支保持一致** —— 有专门用例锁它们相等
 *（`aggregate-expiry.spec.ts` 的「清单与 switch 一致」条），新增渠道时两处都要改。
 */
export const WIRED_EXPIRY_PROVIDERS = Object.freeze([
    'buddy',
    'workbuddy',
    'loomy',
    'codearts',
    'zcode',
    // ⚠️ 用户 2026-10-07 质疑后核实加入（此前被 `auto-adapter.ts` 一句**不成立**的
    //    理由排除：「其余 provider 没有跨账号的到期余额探测端点」）：
    //    实测这两家的 `CreditPackage` 与 buddy **同形**，都有 `deductionEndTime`。
    'lobsterai',
    'trae',
]);
/**
 * 临期折算结果的**缓存时长**（毫秒）。用户 2026-10-07 要求加缓存，TTL 由用户在
 * 60 / 90 / 120 中选定 —— **取 60**。
 *
 * ## 为什么是 60
 *
 * - 与既有的 {@link BUDDY_BALANCE_CACHE_TTL_MS}（余额选号器，`60_000`）**同值** ——
 *   两处节奏一致，不会出现「选号用 30 秒前的数据、排序用 90 秒前的」这种分叉；
 * - 临期判据的最小粒度是**天**（资源包到期以天计）⇒ 60 秒滞后在语义上无害；
 * - 最短 ⇒ 用户改完渠道侧配置后最坏等待最短。90/120 只省极少量请求
 *  （面板与排序都不是高频路径），却让「刚登录的账号不出现在排序里」的窗口更长。
 */
export const EXPIRY_CACHE_TTL_MS = 60_000;
export function createExpiryProbe(pool, firstModelIdOf, options = {}) {
    /**
     * 按渠道缓存折算结果（用户要求：排序读缓存，不每次打服务器）。
     *
     * ## ⚠️ 为什么缓存必须在**这个工厂内部**（而不是各调用方自己加）
     *
     * `auto-adapter.ts` 的 `expiryOf` **每次调用都新建一个 probe**
     *（`createExpiryProbe(pool, …)`），聚合层也用同一个工厂 ⇒ 若缓存放在调用方，
     * `auto` 与聚合会**各查一遍**，且 `auto` 那条路径每次都从零开始（等于没缓存）。
     * 放在工厂内部后，**同一装配期内的所有调用共享一份** ——
     * `src/index.ts` 里两个适配器用的是**同一个** probe 实例（见那里的装配注释）。
     *
     * ⚠️ 缓存键是**渠道 id**（不是模型）：临期额度是账号级的，与模型无关
     *（`buddyExpiry` 等只读账号的资源包）。不同渠道必须各自缓存。
     *
     * ⚠️ **中止不写缓存**（见下方 `catch`）：一次取消若留下条目，后续请求会误命中
     * 一个「上次被取消」的结果。
     */
    const cache = new Map();
    const now = () => options.now?.() ?? Date.now();
    const ttl = options.ttlMs ?? EXPIRY_CACHE_TTL_MS;
    /**
     * 写缓存并返回该值。
     *
     * ⚠️ **`UNUSABLE` 也缓存**（不是只缓存成功值）：一个渠道「现在没有可用账号」
     * 在 60 秒内不会变，不缓存会让面板与排序在每次刷新时都为它白跑一遍
     *（取号 + 目录读取）。与 `buddy-balance-selector` 的失败短 TTL 取舍**不同** ——
     * 那里失败会被判「额度用尽」（有误导性后果）故用 5 秒；这里 `UNUSABLE` 只是
     * 「本轮剔除该候选」，60 秒的滞后无害。
     *
     * ⚠️ 但**中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
     */
    /**
     * 缓存**代际**：`clear()` 递增它。
     *
     * ## ⚠️ 为什么需要（真实缺陷，对抗审计实测证伪）
     *
     * `cacheAndReturn` 在探测**结束时**写缓存。若一个探测**早在 `clear()` 之前**
     * 就已开始（正卡在某个 `await` 上），它的写回发生在 `clear()` **之后**
     * ⇒ **陈旧值活过整个 TTL** —— 用户「清缓存」的努力被一个在途请求作废。
     *
     * 实测：`clear() 期间在途探测 ⇒ -1 ｜ clear 后再探 ⇒ -1 ｜ 取号次数 = 1`
     * ⇒ 登录后清缓存，但那个「登录前开始、登录后才结束」的探测把 `-1`（不可用）
     * 又写了回去，用户仍要再等 60 秒（正是本修复要消灭的那个现象）。
     *
     * ⇒ 探测在**开始时**记下代际，写回时代际不符就**丢弃**（不写缓存）。
     */
    let generation = 0;
    /**
     * 写缓存并返回。
     *
     * ⚠️ **中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
     *
     * @param startedAt - 本次探测**开始时**的代际（`clear()` 会让它过期）
     */
    const cacheAndReturn = (forProvider, value, startedAt) => {
        // ⚠️ 代际不符 ⇒ 这是一次「跨越了 clear() 的在途探测」⇒ **丢弃**，不写缓存
        //   （否则陈旧值会活过整个 TTL，让 clear() 形同虚设）。
        if (startedAt === generation)
            cache.set(forProvider, { at: now(), value });
        return value;
    };
    return Object.assign(async (provider, signal) => {
        // ⚠️ **缓存命中也要先查 signal**：中止必须立刻以 `AbortError` 结束，
        //    不能因为「反正有缓存」就把取消吞掉（与下方短路同一口径）。
        signal?.throwIfAborted();
        const cached = cache.get(provider);
        if (cached !== undefined && now() - cached.at < ttl)
            return cached.value;
        // ⚠️ **未接入的渠道直接返回 `UNUSABLE`，不取号、不读目录**（第 3 轮审计实测）。
        //
        // 为什么要在最前面短路：本函数对**未接入**渠道最终也返回 `UNUSABLE`（走下方
        // `switch` 的 `default`），但那时**已经**做了两件无意义的事：
        //   ① `await firstModelIdOf(provider)` —— 一次渠道目录读取；
        //   ② `await pool.getAvailableAccount(...)` —— 一次账号池查询。
        // 而 `candidatesFor` 的池包含**全部**渠道的候选 ⇒ 每次 `auto` 请求都会为**每个**
        // 未接入渠道白做这两件事（实测探针：`getAvailableAccount` 被以 `cline/m1` 调用）。
        //
        // ⚠️ 两件都**不是网络请求**（`getAvailableAccount` 是纯本地内存过滤），故这属
        // **性能浪费**而非功能缺陷；但短路是零成本的，且让语义更准确 ——
        // 「未接入」与「有账号但折算不了」是两件事，不该走同一条路径。
        //
        // ⚠️ `signal` 仍要先查：中止必须**立刻**以 `AbortError` 结束（全局约束），
        //    不能因为「这个渠道反正未接入」就把中止吞掉。
        signal?.throwIfAborted();
        if (!WIRED_EXPIRY_PROVIDERS.includes(provider))
            return UNUSABLE;
        // ⚠️ 记下**本次探测开始时**的代际：若中途有 `clear()`（用户刚登录），
        //    写回时会被丢弃（否则陈旧值活过整个 TTL —— 见 `cacheAndReturn` 的长注释）。
        const startedAt = generation;
        // ⚠️ 类型是 `unknown[]`（各渠道凭据形状不同，由 `credentialExpiry` 分派时收窄）。
        let credentials;
        try {
            // ⚠️ `?? ''` 是**有意的**降级（注释随搬移丢失，Task 7 复审 M3 指出，现补回）：
            // 目录不可读 / 无可用模型时退回空串 —— 此时「有没有账号」这个判据**仍然成立**，
            // 只是**限流维度退化为不参与**（`getAvailableAccount` 对空 modelId 跳过限流
            // 过滤）。取舍方向：宁可少筛一层，也不可把整池判成不可用。
            // ⚠️ 反之**不要**在这里因为拿不到 modelId 就 return UNUSABLE —— 那会让
            // 「目录暂时读不到」被误报成「这个渠道没账号」。
            const probeModel = await firstModelIdOf(provider) ?? '';
            // ⚠️⚠️ **取全部启用账号，而不是一个代表账号**（真实缺陷，用户报障 2026-10-07）。
            //
            // 用户质疑：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
            // **只用了第一个账号吗**？」—— 他猜对了。旧实现走 `getAvailableAccount`，
            // 那个方法只返回**手动序第一个**可用账号 ⇒ 用户把「1 天到期」的号拖到后面时，
            // 它的临期额度在**排序**里被完全忽略：这个渠道明明有一个快作废的号，
            // 却被按「2000 多天后才作废」排到最后。
            //
            // ⇒ 改为取**全部**账号，逐个折算，取**最早**的那个（见下方 `earliest`）。
            //   ⚠️ 这不改变「实际发请求用哪个账号」（那仍由适配器按手动顺序选），
            //   只改变「这个渠道整体的临期额度何时作废」这个**观测**口径。
            //
            // ⚠️ **`listAvailableCredentials` 是可选方法**（结构化类型）：它不存在时回退到
            //    `getAvailableAccount`（只探一个代表账号）。回退不是为了兼容老装配 ——
            //    真实装配（`src/index.ts`）永远传完整的 `AccountPool`；回退是为了让
            //    **既有测试桩**（只实现 `getAvailableAccount`）仍然可用，尤其是
            //    `auto-adapter.spec.ts` —— 那份 spec 是**硬约束：必须零改动且全绿**
            //   （它是两处「搬移而非复制」重构的安全网）。
            //    ⚠️ 回退路径的语义是**降级**（少看几个账号），不是错误。
            credentials = typeof pool.listAvailableCredentials === 'function'
                ? (await pool.listAvailableCredentials(provider, probeModel)).map((item) => item.credential)
                : await legacySingleCredential(pool, provider, probeModel);
        }
        catch (error) {
            // ⚠️⚠️ **中止不得被吞成 `UNUSABLE`**（Global Constraints 的硬要求）。
            //
            // 为什么需要这两行：本 `try` 里有两个可能抛错的调用 —— `firstModelIdOf`
            // （装配层注入，会读渠道目录）与账号池查询。任一在**探测途中被取消**时抛出的
            // `AbortError` 若被直接折算成 `UNUSABLE`，用户取消请求后看到的是
            // 「没有任何可用候选」而不是中止（误导性报错），且与「真的没登录」无法区分。
            // 与本仓库既有口径相反：`aggregate-core.ts` 的哨兵注释
            //「abort **立刻抛 `AbortError`**，绝不折算成 `UNUSABLE`」。
            //
            // ⚠️ 两行都要，覆盖两种情形（Task 7 复审 M1/M2 订正）：
            // - `throwIfAborted()` 覆盖「signal **已被标记**」——**这是当前生产装配下
            //   实际生效的那条**；
            // - `isAbortError(error)` 覆盖「signal 未必标记、但抛出的就是 AbortError」。
            //   ⚠️ 实测（Task 7 复审 M2）：当前装配的 `firstModelIdOf` 是
            //   `ctx.llm.listModels(provider)`，而 **`LlmRuntime.listModels` 只接受
            //   provider 一个参数、没有 signal 通道**（`dsh-llm/lib/index.js:1471`）
            //   ⇒ 这一条在当前装配下不可达，是**防御性**的（装配层若改成会响应 signal
            //   的取号方式，它就生效）。
            signal?.throwIfAborted();
            if (isAbortError(error))
                throw error;
            return UNUSABLE;
        }
        // ⚠️ 一个可用账号都没有 ⇒ UNUSABLE（「这个渠道现在不能用」）。
        //    注意与「账号可用但读不到到期时间」严格区分 —— 后者由各 `*Expiry` 返回
        //    `NEVER`（可用、只是不临期），绝不能在这里一并判成不可用。
        if (credentials.length === 0)
            return cacheAndReturn(provider, UNUSABLE, startedAt);
        // ⚠️ 逐个账号折算，取**最早**的到期时刻（用户选定：探全部账号、取最早）。
        //    任一个账号折算失败不影响其余（跳过它）—— 一个坏账号不该让整个渠道被剔除。
        let earliest = NEVER;
        // ⚠️⚠️ **必须记录「是否有任何一个账号折算成功」**（真实缺陷，独立审计实测证伪）。
        //
        // 旧实现只看 `earliest` 的终值：若**所有**账号都折算失败（每个都 `continue`），
        // `earliest` 仍是初值 `NEVER` ⇒ 该渠道被判「**可用**、只是不临期」⇒ **进入排序
        // 且可当选**（`rankCandidates` 只剔除 `UNUSABLE`）。
        //
        // 而「所有账号都查不到额度」= 我们对这个渠道**一无所知** ⇒ 必须 `UNUSABLE`（剔除）。
        // 这与本模块头的铁律**直接矛盾**：「未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，
        // 不可把未知当可用。**」
        //
        // 实测场景：buddy 有两个已登录账号、上游余额接口 5xx（或 token 全过期）⇒
        // 旧实现让该渠道进入排序，请求被发到一个额度未知（可能已用尽）的渠道。
        // 且该错误值还会被缓存 60 秒。
        let anyConverted = false;
        for (const credential of credentials) {
            signal?.throwIfAborted();
            let value;
            try {
                value = await credentialExpiry(provider, credential);
            }
            catch (error) {
                // 中止仍必须逃逸（与上面的 `try` 同一口径）。
                signal?.throwIfAborted();
                if (isAbortError(error))
                    throw error;
                continue;
            }
            if (value === UNUSABLE)
                continue;
            // ⚠️ 走到这里 = 该账号**折算成功**（拿到一个真实到期时刻或 `NEVER`）。
            //    两者都算「成功」：`NEVER` 的语义是「可用、但无临期额度」（如 codearts
            //    的长期积分），它是**已知事实**，与「查不到」严格不同。
            anyConverted = true;
            if (value < earliest)
                earliest = value;
        }
        // ⚠️ 一个都没成功 ⇒ 未知 ⇒ 剔除（不是 NEVER）。
        if (!anyConverted)
            return cacheAndReturn(provider, UNUSABLE, startedAt);
        return cacheAndReturn(provider, earliest, startedAt);
    }, 
    /**
     * 清空折算缓存（**账号变化时调用**，见 `src/index.ts` 的装配）。
     *
     * ## ⚠️⚠️ 为什么必须提供它（真实缺陷，对抗审计实测证伪）
     *
     * 缓存**原先没有任何失效通道**（`account-pool` 不碰它、也没暴露清理入口）
     * ⇒ 「**刚登录**（或限流刚解禁）」的账号在**最长 60 秒内对路由不可见**。
     * 用户此时请求拿到的是：
     *   `MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
     *    或所有渠道都无可用账号）`
     * —— 正是设计文档 §9.2.1 明确要避免的误导性报错（用户明明刚登录成功）。
     *
     * ⚠️ `UNUSABLE` **也被缓存**（一个渠道「现在没账号」60 秒内不会变；不缓存会让
     * 面板与排序每次白跑一遍取号 + 目录读取），所以刚登录后的那一格**必须显式清掉**。
     */
    { clear: () => { cache.clear(); generation += 1; } });
}
/**
 * 单账号回退：`listAvailableCredentials` 不存在时只取一个代表账号。
 *
 * ⚠️ 这是**降级路径**（少看几个账号），只为让既有测试桩可用 —— 见调用点的长注释。
 * 真实装配（`AccountPool`）永远有 `listAvailableCredentials`。
 */
async function legacySingleCredential(pool, provider, probeModel) {
    const available = await pool.getAvailableAccount(provider, probeModel);
    if (available === null || available === undefined)
        return [];
    return [available.credential];
}
/**
 * 单个账号的临期折算（按渠道分派）。
 *
 * ⚠️ 从 `createExpiryProbe` 里抽出来，是为了让「探全部账号」的循环保持简单，
 * 且**判据仍然只有一处**（不复制 switch）。
 *
 * @returns 毫秒时间戳（越小越早作废）／`NEVER`（长期）／`UNUSABLE`（查不到）
 */
async function credentialExpiry(provider, credential) {
    switch (provider) {
        case 'buddy':
            return buddyExpiry(CODEBUDDY, credential);
        case 'workbuddy':
            return buddyExpiry(WORKBUDDY, credential);
        case 'loomy':
            return loomyExpiry(credential);
        case 'codearts':
            return codeArtsExpiry(credential);
        case 'zcode':
            return zcodeExpiry(credential);
        // ⚠️ 这两家的包与 buddy 同形 ⇒ 走共享折算（判据只写一份，避免同族分叉）。
        case 'lobsterai':
            return lobsteraiExpiry(credential, LOBSTERAI);
        case 'trae':
            return traeExpiry(credential, TRAE);
        default:
            return UNUSABLE;
    }
}
/**
 * 该错误是否是「调用方中止」类。
 *
 * ⚠️ **就地实现，不从 `aggregate-adapter.ts` 导入**：那会让本模块反向依赖上层的
 * 聚合适配器，正是本任务要避免的层次颠倒（见模块头）。判据与 `aggregate-adapter.ts`
 * 的 `isAbortLike` 一致，只取「错误自身携带 AbortError 标记」这一条 ——
 * `signal` 侧的情形由调用点的 `signal?.throwIfAborted()` 覆盖。
 */
function isAbortError(error) {
    if (error === null || typeof error !== 'object')
        return false;
    return error.name === 'AbortError';
}
/** buddy 系：有效资源包 `deductionEndTime` 的最小值；无有效包 → NEVER。 */
export async function buddyExpiry(product, credential) {
    return sharedPackageExpiry(() => fetchCreditBalance(credential, product));
}
/**
 * **共享的「有效资源包最早到期」折算**（buddy / workbuddy / lobsterai / trae 同形）。
 *
 * ## ⚠️ 为什么必须共享而不是各写一份（AGENTS.md 的「同族判据必须逐格同构」）
 *
 * 这四家的 `CreditPackage` **结构相同**（都有 `active` / `remaining` /
 * `deductionEndTime`），差别只在**怎么取到那个 `CreditBalance`**（各自的端点与凭据）。
 * 各写一份的话，任何一侧收窄（如「只算 `active` 且 `remaining > 0` 的包」）都会
 * 在另一侧**静默分叉** —— 本仓库已因这类分叉发生过真实事故
 *（`classifyRaccoonFailure` 与 `classifyLoomyFailure` 四格判据不一致，
 * 危险方向恒定朝一侧：多写 24h 冷却 ⇒ 整池被封一天）。
 *
 * ⇒ 判据只写在这里一份，各渠道只提供「怎么取余额」。
 *
 * ## 判据
 *
 * 取 `active === true` 且 `remaining > 0` 的包里 `deductionEndTime` 的**最小值**；
 * 一个都没有 ⇒ `NEVER`（长期：排最后但不剔除）。
 *
 * ⚠️ **无到期时间 ⇒ `NEVER`，不是 `UNUSABLE`**：包是有效的，只是不下发到期时间
 *（实测 lobsterai 的 `expiresAt` 可为空串）⇒ 剔除它会丢掉一个可用渠道。
 * 与 `codeArtsExpiry` 的「读不到就不猜」同一条原则。
 *
 * ## ⚠️⚠️ 「余额为 0」与「无有效包」必须一并剔除（真实缺陷，已修 2026-10-07）
 *
 * `earliest` 的初值是 `NEVER`，而只有 `remaining > 0` 才可能更新它 —— 若遍历完
 * 直接 `return earliest`，下面几种形态**都**返回 `NEVER`（= 可当选）：
 *
 * | 形态 | 旧返回 | 现在 |
 * |---|---|---|
 * | 有效包 `remaining > 0`、有 `deductionEndTime` | 该时刻 | 该时刻（不变） |
 * | 有效包 `remaining > 0`、**无**到期时间（永久积分） | `NEVER` | `NEVER`（**保留**：确实有额度） |
 * | **有效包但 `remaining = 0`（余额已尽）** | `NEVER` ❌ | **`UNUSABLE`** |
 * | **只有失效包 / `Accounts: []`** | `NEVER` ❌ | **`UNUSABLE`** |
 *
 * ⇒ 旧实现下，一个**余额已耗尽**的 buddy / workbuddy / lobsterai / trae 仍会被
 * auto 选中，请求随即以 `QUOTA_EXCEEDED` 失败 —— **与 PR #81 报障完全同型**，
 * 且 buddy / workbuddy 都在 `AUTO_PROVIDERS`（`auto-adapter.ts:84`）里。
 *
 * ⚠️ 本仓库对「余额为 0」早有明确判据，旧实现与它**矛盾**：
 * `buddy-balance-rank.ts` 的 `buddyBalanceTier`（:195-203）在余额全为 0 时返回
 * `BUDDY_BALANCE_TIER.none`，而 `buddyTierUsable`（:210-212）明写
 * **`none` 档不可用**。选号器判「不可用」、折算层判「可当选」= 同一语义两套判据
 *（AGENTS.md 首条红线）⇒ 现在两侧**同构**。
 *
 * ## ⚠️ 为什么「有余额但无到期时间」仍必须是 `NEVER`（别一刀切成 UNUSABLE）
 *
 * 实测 lobsterai 的 `expiresAt` 可为**空串**、buddy 的永久积分包也可能不下发
 * `DeductionEndTime`。这类包**确实有额度**（`remaining > 0`），剔除它会丢掉一个
 * 可用渠道。故判据是「**有没有任何一个 `active && remaining > 0` 的包**」，
 * 而不是「有没有带到期时间的包」。
 *
 * ⚠️ 与 `zcodeExpiry` 的收窄是**同一手法**（「已拥有的余额 > 0」才可用；
 * 否则 `UNUSABLE`），两处口径一致 —— 别再让一家修好、另一家漏掉。
 *
 * ⚠️ 与 `buddy-balance-selector.ts:313-314` 那句「解锁时所有候选余额都是 0 仍返回
 * 第一个候选，让上游去报真正的失败原因」**不矛盾**：那句讲的是 **provider 内部**
 * 的选号（用户已指定该渠道，此时换号才有意义），本函数讲的是**跨渠道选型**
 * （余额 0 就该让给别的渠道，而不是把请求发过去必然失败）。
 *
 * @param fetchBalance - 取余额的函数；返回 `null` 表示查询失败 ⇒ `UNUSABLE`。
 */
async function sharedPackageExpiry(fetchBalance) {
    let balance;
    try {
        balance = await fetchBalance();
    }
    catch {
        return UNUSABLE;
    }
    if (balance === null)
        return UNUSABLE;
    let earliest = NEVER;
    // ⚠️ 必须单独记「有没有任何可用余额」：`earliest` 的初值 `NEVER` 无法区分
    //    「一个有效包都没有」（⇒ 剔除）与「有余额但不下发到期时间」（⇒ 长期）。
    let hasAnyCredit = false;
    for (const pkg of balance.packages) {
        if (pkg.active !== true)
            continue;
        if (!(typeof pkg.remaining === 'number' && pkg.remaining > 0))
            continue;
        hasAnyCredit = true;
        const end = pkg.deductionEndTime;
        if (typeof end === 'number' && Number.isFinite(end) && end > 0 && end < earliest)
            earliest = end;
    }
    // 有余额但都没给到期时间 ⇒ 长期（排最后，不剔除）。
    if (hasAnyCredit)
        return earliest;
    // ⚠️ 一个 `remaining > 0` 的有效包都没有 ⇒ 余额已尽 ⇒ **剔除**。
    //    「只有失效包」「`Accounts: []`」也走这里 —— 那同样是「这个渠道现在没有
    //    可烧的额度」，不该被 auto 选中（旧实现把它们一并返回 `NEVER`）。
    return UNUSABLE;
}
/**
 * lobsterai：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `lobsterai-credits.ts` 从 ISO 8601 的 `expiresAt` 归一化而来）。
 *
 * ⚠️ 本渠道此前**不在** `WIRED_EXPIRY_PROVIDERS` 里，理由是
 * `auto-adapter.ts` 那句「其余 provider 没有跨账号的到期余额探测端点」——
 * **该理由对 lobsterai 不成立**（用户 2026-10-07 质疑后核实）。
 */
export async function lobsteraiExpiry(credential, product) {
    return sharedPackageExpiry(() => fetchLobsteraiCreditBalance(credential, product));
}
/**
 * trae：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `trae-credits.ts` 从条目级秒级 `expire_time` 换算而来）。
 *
 * ⚠️ 同 lobsterai：此前被那句（不成立的）理由排除在白名单外。
 */
export async function traeExpiry(credential, product) {
    return sharedPackageExpiry(() => fetchTraeCreditBalance(credential, product));
}
/** loomy：有今日赠送 → 当日 24:00；只剩永久 → NEVER。 */
export async function loomyExpiry(credential) {
    let detail;
    try {
        detail = await fetchLoomyCreditDetail(credential, LOOMY);
    }
    catch {
        return UNUSABLE;
    }
    if (detail === null)
        return UNUSABLE;
    if (detail.daily > 0)
        return nextUtc8DayStartMs();
    return detail.permanent > 0 ? NEVER : UNUSABLE;
}
/**
 * codearts：**积分账户的到期时间不可知 ⇒ 一律 `NEVER`（长期）**。
 *
 * ## ⚠️⚠️ 为什么不再算「当日 24:00」（真实缺陷，用户报障 2026-10-07）
 *
 * 用户看到聚合面板把 codearts 列为候选，问「codearts 中也没显示积分临期」。
 *
 * **实测探针**（本机两个真实账号，只读 GET `statistics/plugin`）：
 *
 * | 账号 | 类型 | `credit` |
 * |---|---|---|
 * | `A3E53911` | `isTokenPackage: true`（Token 计费） | `undefined`（无积分口径） |
 * | `82AD9D6E` | `isCreditPackage: true` | `22088.16`（**赠送**积分包） |
 *
 * 且 `packages[].cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段实测全空**
 * —— 与 `codearts-credits.ts` 的既有注释一致：「`statistics/plugin` **不下发**
 * 资源包的有效性/周期字段……如实置为有效、周期留空，**而不是臆造一个到期时间**」。
 *
 * ⇒ 旧实现（继承自 PR !69 的 `auto-adapter.ts` 折算表）写的是
 * 「有积分 ⇒ `nextUtc8DayStartMs()`（今日 24:00 作废）」—— 那**正是臆造**：
 * 接口没给过期时间，官方文档（README 引用）说的是签到积分「**自发放起 30 天内有效**」，
 * 两者都不是「今天 24:00」。
 *
 * **后果**：codearts 的失效时刻被算成「今天」⇒ 在「临期优先」排序里**永远排最前**，
 * 抢走了本该先用掉的**真正临期**额度（buddy 的资源包 / loomy 的当日赠送）。
 *
 * ⇒ 改为 `NEVER`（长期积分：排最后，但**不剔除** —— 没有临期额度时仍要用它）。
 * 与本仓库既有原则一致：**读不到就不猜**（`zcodeExpiry` 对「查不到」返回
 * `UNUSABLE` 而非 `NEVER`，也是同一条原则）。
 *
 * ⚠️ 两种「无到期信息」的情形在本函数里**合并处理**（都返回 `NEVER`）：
 * 有积分（到期未知）与无积分（Token 计费账户 / 余额为 0）。两者在排序上同为
 * 「不临期」，且**都不该被剔除** —— 账号本身是可用的。
 * 这与 `buddyExpiry` 的「无有效包 → NEVER」是同一口径。
 *
 * ⚠️ 若将来接口开始下发周期字段，应改为读真实值（`packages[].expiredTime` 等），
 * **不要**恢复成某个固定估算。
 *
 * ## ⚠️⚠️ 也**不要**因为「余额为 0」就改成 `UNUSABLE`（PR #81 审计实测，2026-10-07）
 *
 * 同一次用户报障里有人提议：把「余额 0」也算成当前不可用
 * （`credit.total > 0 ? 当日 : UNUSABLE`），理由是「额度已尽却仍被 auto 选中」。
 * **对本渠道该推理不成立**，实测三格反例。
 *
 * ⚠️ 下表第 2 列是**那个被拒的提议**会产生的后果（不是本函数现状 —— 本函数恒返回
 * `NEVER`，没有「当日」分支；「当日」是更早的旧实现，见上文 `:533-539` 的记载）：
 *
 * | 账户形态 | `credit` | 被拒提议的后果 | 本函数（现状） |
 * |---|---|---|---|
 * | 积分账户有余额 | `{ total: 22088.16 }` | 当日 24:00 ⇒ **抢走真正临期的额度** | `NEVER` |
 * | 积分账户余额 0 | `{ total: 0 }` | `UNUSABLE` | `NEVER`（账号仍可用） |
 * | **Token 计费账户** | **`undefined`** | `?? 0` ⇒ `UNUSABLE` ⇒ **可用账号被永久剔除** | `NEVER` |
 *
 * ⚠️ 第三格是**实打实的回归**：`isTokenPackage` 账户**没有积分口径**
 * （`codearts-credits.ts` 的 `CodeArtsAccountInfo.credit` 注释明写「`undefined`
 * 表示这个账户没有积分口径」，与 `{ total: 0 }` 严格区分），而这类账号**能正常
 * 推理**；且 codearts 有 benefit（免费额度）模型走 `maas_type: benefit`
 * （`isCodeArtsBenefitModel` 动态判定）——**积分余额 0 ≠ codearts 不可用**。
 *
 * ⚠️ 与 `loomyExpiry` 的 `permanent > 0 ? NEVER : UNUSABLE` **不是**同一口径：
 * 那里的 `permanent` 是 loomy **自己的永久积分余额**（0 就是真的没有额度）；
 * 这里的 `credit.total` 在 Token 账户下根本**不存在**，把它当 0 是**臆造**。
 * 「读不到就不猜」是本函数的立身之本，别用一个 `?? 0` 把它推翻。
 *
 * 真正该守的边界是**探测失败**（`!result.ok` ⇒ `UNUSABLE`，已有用例守住），
 * 而不是「探测成功但余额为 0」。
 */
export async function codeArtsExpiry(credential) {
    let result;
    try {
        result = await fetchCodeArtsAccountInfoDetailed(credential);
    }
    catch {
        return UNUSABLE;
    }
    // 查不到 / 结构异常 ⇒ UNUSABLE（剔除），与「查到了但没有到期概念」严格区分。
    if (!result.ok)
        return UNUSABLE;
    return NEVER;
}
/**
 * ⚠️⚠️ **本函数读不到 benefit（免费额度）口径** —— 但缺口**不在本函数**（已修，2026-10-07）。
 *
 * ## 缺口是什么
 *
 * codearts 有**两套完全不同的额度口径**，而上面只读了其中一套：
 *
 * | 口径 | 来源 | `codeArtsExpiry` 读得到吗 |
 * |---|---|---|
 * | 签到积分（长期） | `statistics/plugin` 的 `credit.total` | ✓ 只有它 |
 * | **benefit 免费额度** | `InferHub` 报文（每日 1000 万 tokens，**按自然日**结算） | ✗ **读不到** |
 *
 * ## ⚠️ 但它**不需要**在本函数里补（这是本注释存在的唯一理由）
 *
 * benefit 耗尽**已经被记账**：`llm-adapter.ts:1290` 命中 `InferHub.4291.200` 时调
 * `accountPool.updateModelRateLimit(currentAccountId, options.model, 次日 00:00)`，
 * 而账号池按 `entry.modelRateLimits[modelId]` 过滤候选
 *（`getAvailableAccount` / `listAvailableCredentials`）。
 *
 * ⇒ **正确的判据在选型层，不在折算层**：选型时必须按**候选自己将要派发的
 * `realId`** 去问账号池「这个模型上还有可用账号吗」。
 * `AggregateAdapter.filterByModelAvailability` 就是这一层（已实现）。
 *
 * ⚠️ **为什么必须单独做这一步**：折算取号用的模型键是**渠道目录第一个模型**
 *（`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），而聚合层派发的是
 * **候选自己的 `realId`** —— 两者常常不是同一个模型 ⇒ 那个按 modelId 的过滤
 * 对聚合路径**整体失效**（实测探针确认）。auto 路径不存在这个问题：它的
 * `firstModelOf` 返回值就是实际派发的模型。
 *
 * ## ⚠️ 不要因此照 PR #81 的 `credit.total > 0 ? 当日 : UNUSABLE` 去改
 *
 * 那个修法**方向错**（见上方长注释：会剔除 Token 计费账号与「余额 0 但可用」的账号）。
 * 本函数的 `NEVER` 是「按签到积分口径查到的信息说它可用」，与 benefit 无关 ——
 * 两件事在**不同的层**解决，别把它们混在一处。
 *
 * ⚠️ 保留本注释的原因：读到这里的人会问「benefit 读不到怎么办」，答案在
 * `filterByModelAvailability`。别在这里再补一份折算（那会变成同一语义两套判据）。
 */
/**
 * zcode：各桶 `expiresAt`（秒）最小值；有余额但上游未给到期时间 → 当日 24:00。
 *
 * ## ⚠️⚠️ 余额为 0 ⇒ `UNUSABLE`（真实缺陷，用户报障 2026-10-07）
 *
 * **用户报障原文**：auto 选中了额度已尽的 zcode，请求直接失败：
 * `zcode: 账号在模型 "GLM-5.3" 上的额度已用尽或没有可用权益。QUOTA_EXCEEDED`
 *
 * 而 auto 的价值主张恰恰是「挑有额度、且快作废的那个」—— 折算错了就挑中一个
 * **根本不能用**的渠道，比不做 auto 更糟（用户看到的是「auto 坏了」，且每次
 * 重试都撞同一个渠道）。
 *
 * 旧实现最后一行是 `if (balance.remaining > 0 || claimablePlans.length > 0)
 * return nextUtc8DayStartMs()`，**`return NEVER`** 收尾。两个分支都会让一个
 * 余额为 0 的 zcode 被选中：
 *
 * | 形态 | 旧折算 | 后果 |
 * |---|---|---|
 * | 无桶 + 有可领活动（`claimablePlans`） | 当日 24:00 | **排最前**，优先选中 |
 * | 无桶 / 桶余额为 0，无可领 | `NEVER` | 排最后，但**不被剔除**（池里只剩它时必被选中） |
 *
 * ## 判据：**「可领」不等于「已拥有」**
 *
 * `claimablePlans`（`billing/preview` 的可领活动）表示**还能领**，不表示**已经有**。
 * zcode 的每日赠送额度**要先 claim 才进 `balances` 桶**（见 `zcode-upstream.ts`
 * 的「签到为什么要补激活上报」），没领就是**当前不可用** —— 这正是 zcode
 * 「需手动签到」的形态。用户去面板签到后余额进桶，下一轮探测自然重新纳入候选。
 *
 * ⚠️ **但有余额、只是上游没给 `expires_at` 时仍按当日折算**（保留旧行为）：
 * `zcode-upstream.ts` 的 `expiresAt: num(record.expires_at)` 在字段缺失时就是
 * `undefined`，而 `remaining_units` 齐全。此时账号**确实有额度**，把它判成
 * `UNUSABLE` 会丢掉一个可用渠道 —— 与本仓库「读不到就不猜，但也不误剔除」
 * 的既有口径一致（对照 `codeArtsExpiry` 对「查不到」与「查到但无到期概念」
 * 的严格区分）。故判据是 **`balance.remaining > 0`**（有余额）而不是
 * 「有任何一个桶带有效到期时间」。
 */
export async function zcodeExpiry(credential) {
    let balance;
    try {
        balance = await fetchZcodeBalance(credential);
    }
    catch {
        return UNUSABLE;
    }
    // ⚠️ `undefined` 表示「这次查不到」，不是「没有余额」—— 折算成 `NEVER` 会让
    //    一个查不到余额的渠道以「永久积分」身份参与轮换。
    if (balance === undefined)
        return UNUSABLE;
    // ⚠️⚠️ **企业版必须判 `NEVER`（长期），绝不能落到下面的 `UNUSABLE`**
    // （真实缺陷，对抗审计实测证伪，2026-10-07 —— 我自己上一版正是这么错的）。
    //
    // 企业版（`displayMode: 'enterprise'`）返回的是 `{ enterprise: true, buckets: [],
    // remaining: 0, total: 0, claimablePlans: [] }` —— 它与「额度已用光」在**数值上
    // 完全同形**（都是 0 个桶 + `remaining: 0`），故按下面的判据会被算成 `UNUSABLE`
    // ⇒ **一个能正常推理的企业版账号被永久排除出 auto 候选**。
    //
    // ⚠️ 上游在 `zcode-upstream.ts:257-259` 已就此**明文警告**：
    //    「企业版不下发额度数字、只给外部链接 —— 此时返回 `{enterprise:true,buckets:[]}`，
    //      **不要**显示成 0（**0 是「已用光」的语义**）」
    // 本函数违反的正是这句：把「不下发额度数字」当成了「余额为 0」。
    //
    // ⇒ 判据必须**先**看 `enterprise` 标记（那是「不知道额度」的诚实标记），
    //   再谈余额。语义是「可用、但无临期额度可算」= `NEVER`（排最后但不剔除）——
    //   与 `codeArtsExpiry` 对「查到了但没有到期概念」的处理同一条原则。
    if (balance.enterprise === true)
        return NEVER;
    let earliest = NEVER;
    for (const bucket of balance.buckets) {
        const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0;
        if (!(remaining > 0))
            continue;
        const exp = bucket.expiresAt;
        if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
            const ms = exp * 1000;
            if (ms < earliest)
                earliest = ms;
        }
    }
    if (earliest !== NEVER)
        return earliest;
    // 有余额但桶里没有可用的到期时间 ⇒ 按当日额度保守估算（先烧它）。
    // ⚠️ 判据是 `remaining`（**已拥有**的余额），**不含** `claimablePlans`。
    if (balance.remaining > 0)
        return nextUtc8DayStartMs();
    // 余额为 0 ⇒ 当前不可用（剔除），**不因「有可领活动」而入选**。
    return UNUSABLE;
}
//# sourceMappingURL=aggregate-expiry.js.map