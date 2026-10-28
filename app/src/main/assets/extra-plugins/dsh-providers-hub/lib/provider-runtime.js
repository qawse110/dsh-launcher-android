/**
 * provider 的**行为能力注册表** —— 「按 provider id 找到它那套能力实现」的唯一入口。
 *
 * ## 它解决什么
 *
 * 重构前，RPC 层用 `switch (provider)` / 一长串 `else if` 分派到各家实现。
 * 实测（设计文档 §1.3）三类形态：
 *
 * | 形态 | 例子 | 分派点数 |
 * |---|---|---|
 * | **纯重复**：各分支做同一件事 | `account.refresh` 13 个 case **逐字同构** | 13 |
 * | **同构骨架 + 参数差异** | `credits.balances`（441 行）/ `credits.claimAll`（267 行） | 14 / 15 |
 * | **真协议差异** | qoder WASM 签名、codearts HMAC、trae 身份头 | 已封装在各家模块内 |
 *
 * 前两类里 RPC 层看到的**全是「选哪个函数」而不是「做什么逻辑」** ——
 * 那正是本注册表要消除的。第三类**不动**：协议实现留在各家模块内。
 *
 * ## ⚠️ 边界（别把这里做成「一套配置驱动所有 provider」）
 *
 * 抽象的是**编排**（选哪个原语、按什么顺序），**不是协议**（原语内部怎么实现）。
 * 故各家的 `*Expiry` / `fetch*Balance` / `claim*` 等原语函数**原样保留**，
 * 本文件只是把它们挂到一张可查的表上。
 *
 * ## ⚠️ 能力域全部可选，「不支持」用 `undefined` 表达
 *
 * RPC 层据此返回**既有的可读错误文案**（例如 cline 的「Cline 不支持每日签到
 * （其后端没有签到接口）」），**不得**退化成泛化的 `unsupported provider`
 * —— 后者会让排查者以为「provider 没注册」，而真相是「该产品无此能力」。
 * 这是本仓库反复记录过的缺陷形态。
 *
 * ## ⚠️ 本表与 `account.refresh` 的分派**无关**（2026-10-08 调序后修正）
 *
 * 初稿计划让 `account.refresh` 经本表分派，但 Task 9 已把 13 个 auth 实例变成
 * `registerJetHubRpc` 的**命名对象形参** `auths`，而 `account.refresh` 的 switch
 * 就在同一个闭包内 ⇒ 那里直接查 `authOf(auths, entry.provider)` 即可
 *（零全局状态、测试零改动，见 `jet-hub-rpc.ts`）。
 *
 * 本表的消费点是**拿不到 `auths` 形参**的跨模块场景（Task 5 的
 * `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）。
 *
 * ## ⚠️ 依赖方向：本文件**不得** import 上层模块
 *
 * `aggregate-expiry.ts`（Task 5 起的**真实生产消费者**）import 本文件；
 * 反过来本文件**只** import `provider-registry.ts`（纯数据）与 `account-pool.ts`
 * （**仅类型**）⇒ **无环**。这条方向是刻意维持的：
 * `aggregate-expiry.ts` 的模块头记着一条红线 —— 它若依赖聚合适配器就是
 * 「层次颠倒」（`auto-adapter.ts` 也要复用它）。本表是**底座**，故不得反向
 * 依赖任何聚合侧模块；将来要在这里加 import 时先确认这一点。
 */
/** id → runtime。用 Map 而非普通对象：id 来自外部输入，避免原型链污染。 */
const runtimes = new Map();
/**
 * 注册一个 provider 的能力实现。
 *
 * ## ⚠️ 重复注册**不抛错** —— 保留现有 + 跳过本次
 *
 * 初稿写的是「重复注册抛错」，那是**错的**（本 Task 起草时实测纠正）：
 * 本仓库已有**实测的 fiber 重启竞态事故**（见 `src/llm-register-compat.ts` 的模块头）——
 * 宿主在启动过程中重启插件 fiber 时，**新 fiber 的同步 `apply()` 与旧 fiber 的
 * 异步 `dispose()` 交错执行**，于是 `apply()` 会在上一轮尚未清理完时再次注册。
 * 那时**抛错会让整个插件加载失败**（`plugin tree failed to load`），
 * 而这恰恰是 `llm-register-compat.ts` 记录过的同型事故。
 *
 * ⇒ 采用与 `llm-register-compat.ts` **同一个**语义（`isDuplicateRegistrationError`
 * 分支）：**保留现有条目、跳过本次注册**。理由是重启场景下「已存在的那条」
 * 是**上一轮同一个插件的注册**（同一代码），路由同样指向等价实现 ⇒ 语义等价。
 *
 * ⚠️ **这不等于静默覆盖**：保留的是**先注册者**（不会被后来者替换），
 * 故「先注册者静默失效」这个初稿担心的情形**不会发生**。
 * ⚠️ 也**不是吞错误**：非重复类的失败（如 descriptor 缺字段）照常抛。
 *
 * ⚠️ **返回值必须被调用方判**：`false` 在**生产**里是 fiber 重启竞态的正常现象
 *（应记 info，不是 error）；在**测试**里它更可能是「用例写错了」——
 * 故 `tests/helpers/rpc-refresh.ts` 之类若复用本函数，应把 false 当失败抛。
 *
 * @returns `true` = 本次真的注册了；`false` = 已存在、跳过了本次
 *   （调用方据此记日志，而不是靠猜）。
 */
export function registerProviderRuntime(runtime) {
    const id = runtime.descriptor.id;
    if (runtimes.has(id)) {
        // ⚠️ 保留现有（先注册者），不覆盖 —— 与 llm-register-compat 的
        //    「保留现有路由并跳过本次注册」同义。
        return false;
    }
    runtimes.set(id, runtime);
    return true;
}
/** 按 id 取（未注册返回 `undefined`，由调用方决定报错措辞）。 */
export function runtimeOf(provider) {
    return runtimes.get(provider);
}
/**
 * **共享余额读数缓存**的进程级注册位（2026-10-15，规格 §5.7）。
 *
 * ## ⚠️ 为什么走全局注册表而不是给 `registerJetHubRpc` 加形参
 *
 * 那个函数的签名有**成文不变式**：只剩 **4 个形参**（`ctx, pool, auths, modelAdapters`），
 * 且 `tests/unit/zcode-wiring.spec.ts` 有一组「不占形参位的是谁」的守卫。
 * 加第 5 个可选形参正是那条注释记录的**复发 6 次**的错位形态（在它之前插入任何
 * 可选形参都会让调用点静默错位）。
 *
 * ⇒ 与本文件既有的 `runtimeOf` / 全局注册表同一取向：「拿不到形参的跨模块消费点」
 * 走注册表（`ProviderRuntime.credits` 的先例就在本文件）。
 *
 * ## 生命周期
 *
 * ⚠️ 由 `src/index.ts` 的 `apply()` 在建缓存后**立即**注册；`dispose` 时清空
 *（与 `clearProviderRuntimes` 同处调用，避免用例之间串味）。
 * ⚠️ 未注册 ⇒ 消费方（`credits.balances`）**走自己的原路径**，行为与升级前一致 ——
 * 那是刻意保留的降级路径（本仓库对「可选接线缺失」的一贯取向：不得静默改变行为）。
 */
let sharedBalanceCache;
/** 注册共享余额缓存（`src/index.ts` 的 `apply()` 调用）。 */
export function registerBalanceCache(cache) {
    sharedBalanceCache = cache;
}
/** 取共享余额缓存；未注册返回 `undefined`（调用方回退到自己的原路径）。 */
export function balanceCacheOf() {
    return sharedBalanceCache;
}
/**
 * 按 provider id 从一张 `expiry` 表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in` 或下标：`in`/下标会命中**原型链**上的键
 *（如 `constructor`），把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `onboardingOf` / `authOf` 同因（四处必须同款）。
 */
export function expiryOf(table, provider) {
    if (!Object.hasOwn(table, provider))
        return undefined;
    return table[provider];
}
/**
 * 清空注册表。
 *
 * ⚠️ 只给**单测**与热重载用。生产路径不应调用 —— 清空后所有 provider 的能力
 * 一起消失，而 `apply()` 不会重新注册（它只在启动时跑一次）。
 */
export function clearProviderRuntimes() {
    runtimes.clear();
    // ⚠️ 共享缓存注册位也要清：它挂在同一张进程级表上，留着会让**下一个用例**
    //    读到上一个用例的缓存实例（串味，且症状是「余额读数莫名命中」）。
    sharedBalanceCache = undefined;
}
/**
 * 已注册的 id 列表（诊断与单测用）。
 *
 * ⚠️ 保持**注册顺序**（`Map` 的插入序），不要排序、不要 Set 化 ——
 * 排障时「哪个 provider 先注册上」是有用信息。
 */
export function registeredRuntimeIds() {
    return [...runtimes.keys()];
}
/**
 * 派生出「**批量续期表**」：provider id → 它的 `refreshAll`（Task 10）。
 *
 * ## 为什么需要它
 *
 * `src/index.ts` 原先**手抄 13 行** provider 清单。它的失效形态极隐蔽：
 * **漏一家 ⇒ 该家凭据永不自动续期**，而症状只是「每隔一段时间就要重新登录」，
 * **日志里一个字都没有**（`src/index.ts` 的原注释记录了这一点）。
 * ⇒ 改为从本表派生：**有 `auth.refreshAll` 的才进表**。
 *
 * ## ⚠️⚠️ 必须是**函数**，不能是模块级常量
 *
 * 注册发生在 `apply()`（`registerProviderRuntime`），而模块级常量在**模块加载时**
 * 求值 ⇒ 常量版本**恒为空表** ⇒ **所有 provider 都不再自动续期**，而日志里
 * 只有 `isPoolEmpty` 的常规输出。
 *
 * ⚠️ 反例对照：`src/aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` **刻意保持
 * 模块级常量**（理由与实测计数写在该文件里：29 处探针 + 86 处适配器构造都不调
 * `apply()`），它与 runtime 的一致性由 `expiry-runtime-parity.spec.ts` 真跑
 * `apply()` 的用例锁死。⇒ 「派生表必须是函数」这条**只适用于读注册表建索引的表**
 * （本函数），不适用于纯数据清单 —— 别照搬本条去改那张常量。
 *
 * ## ⚠️ `this` 绑定
 *
 * 各家的 `refreshAll` 是**类方法**、内部用 `this.product` / `this.ctx`。
 * ⇒ 必须包一层 `.call(rt.auth, pool)`；直接传 `rt.auth.refreshAll` 引用会丢 `this`，
 * 调用即抛 `Cannot read properties of undefined`。
 * （Task 2 的 `refreshAccount` 也用包一层的方式，同因。）
 */
export function wiredRefreshTargets() {
    const out = [];
    for (const [id, rt] of runtimes) {
        const refreshAll = rt.auth?.refreshAll;
        // ⚠️ 判据是**方法存在**，不是「有 auth 域」—— 只注册了 `refreshAccount`
        //    的 provider 不该进表（它的账号无法批量续期）。
        if (refreshAll === undefined)
            continue;
        out.push([id, (pool) => refreshAll.call(rt.auth, pool)]);
    }
    return out;
}
//# sourceMappingURL=provider-runtime.js.map