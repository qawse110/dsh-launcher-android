/**
 * 各 provider 的**临期折算能力实现表** —— `ProviderRuntime.expiry` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`src/aggregate-expiry.ts` 的 `credentialExpiry(provider, credential)`
 * 是一个 7-case `switch`，而**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`）—— 与 `account.refresh` 的 13 个同构 case
 * 完全同型。那 7 个分支体里**没有一行协议逻辑**，只有「选哪个原语」。
 *
 * ## ⚠️ 为什么单独一个文件（而不是把表内联在 `index.ts`）
 *
 * 内联在 `index.ts` 里时，**单测无法复用**那张表：`createExpiryProbe` /
 * `AggregateAdapter` 有几十处用例直接构造（**不调 `apply()`**），它们要验证
 * 折算**值**（TTL 缓存、取全部账号、`clear()` 等）就必须让 runtime 里有真实实现。
 * 若那些用例各写一份自己的表，就出现**同一语义两套判据** —— 本仓库首条红线
 *（`buddy-growth.ts` 因两处对同一字段给出相反判据而静默失效）。
 * ⇒ 表放在这里，`src/index.ts` 与单测**共用同一份**。
 *
 * ⚠️ 与 `createProviderCredits` / `createProviderOnboarding` 同款理由
 *（那两张表也是「工厂在 src、生产与单测共用」）。
 *
 * ## ⚠️ 边界：本表只做「选哪个原语」，**不**抽象原语本身
 *
 * 各家 `*Expiry` 函数（判据不同、量纲不同）原样保留在 `aggregate-expiry.ts`，
 * 本表只是把它们挂到一张可查的表上（设计文档 §3.5.3 / §3.6）。
 * `buddy` 与 `workbuddy` **共用** `buddyExpiry`、只换 product 配置 ——
 * 与 `BuddyProduct` 驱动其余差异同款，避免同族分叉。
 *
 * ## ⚠️ 只覆盖**已接入临期折算**的渠道（刻意不在此写数字：权威是
 * `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`，抄一份必然漂移）
 *
 * 未接入的渠道（`qoder` / `qodercn` / `cline` / `raccoon` / `minimax` /
 * `gemini` / `opencode`）**刻意缺席**：它们的余额响应没有跨账号的到期口径
 *（见 `aggregate-expiry.ts` 的逐渠道判据表）。缺席的**运行时后果**是
 * `credentialExpiry` 返回 `UNUSABLE`（该候选本轮被剔除）。
 *
 * ## ⚠️⚠️ **但「哪些虚拟模型可以播报」不由本表派生**（2026-10-08 设计复审更正）
 *
 * 那由 `aggregate-expiry.ts` 的**编译期常量** `WIRED_EXPIRY_PROVIDERS` 决定。
 * 两者回答的是**两个不同的问题**：本表答「**运行时**该调哪个原语」（要到
 * `apply()` 注册时才填充），那个常量答「这个渠道**接入了**折算吗」（编译期事实：
 * 源码里有没有为它写折算原语）—— 不是同一件事，故不能互为派生源。
 *
 * ⇒ **别把那个常量改成本表的派生值**（它看起来像一份冗余的手抄清单，其实不是）。
 * 它在源码里有 **5 个**消费点：`aggregate-adapter.ts` 的**四处**过滤
 *（探测排序 / 面板候选 / 虚拟模型播报 / 选择器价格后缀）加 `aggregate-expiry.ts`
 * 的「未接入」短路（⚠️ **轮换候选**的闸门正是这处短路，不是那四处过滤）；
 * 更要紧的是它被**大量不调 `apply()`** 的既有测试消费（实测：在 `tests/unit` 里
 * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）——
 * 派生版本在那些场景下**恒为空数组**，`refreshCatalog` 会把**所有虚拟模型过滤掉**、
 * 聚合 provider 的模型列表**整个变空**。
 * 两者的一致性由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
 */
import { accioExpiry, buddyExpiry, codeArtsExpiry, lobsteraiExpiry, loomyExpiry, officeaceExpiry, traeExpiry, 
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）
modelscopeExpiry, 
// ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
autoclawExpiry, 
// ⚠️ Qoder（国际版 / 中国版共用，2026-10-20 新增）
qoderExpiry, 
// ⚠️ AStudio（讯飞 AstronStudio，2026-10-20 新增）
astudioExpiry, 
// ⚠️ MiniMax Code（中国版 / 国际版共用，2026-10-20 新增）
minimaxExpiry, zcodeExpiry, } from './aggregate-expiry.js';
// ⚠️ Qoder（国际版 / 中国版，2026-10-20 新增）：与 minimax 同款 —— 两站共用
//    同一套 `src/qoder*.ts` 实现，差异全在 `src/qoder-product.ts` 的
//    `QODER` / `QODER_CN` 常量（域名 / client_id / 模型表）。
import { QODER, QODER_CN } from './qoder-product.js';
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）
import { MODELSCOPE } from './modelscope-product.js';
// ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js';
// ⚠️ AStudio（讯飞 AstronStudio，2026-10-20 新增）
import { ASTUDIO } from './astudio-product.js';
// ⚠️ MiniMax Code（中国版 / 国际版，2026-10-20 新增）
import { MINIMAX, MINIMAX_INTL } from './minimax-product.js';
import { CODEBUDDY, WORKBUDDY } from './product.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { TRAE } from './trae-product.js';
/**
 * buddy 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 单独抽出来是为了让下面两条一眼看出「它们只差一个 product」——
 * 若将来有人给其中一家写一份自己的判据，那正是「同族分叉」的开始。
 *
 * ⚠️ `context.cachedBalance` 原样透给原语（2026-10-15，规格 §5.7）：
 * 那样「吃共享读数」这条能力**只在这一处**声明，四家自动一致
 *（各写一遍必然有一家漏掉 ⇒ 静默多发一次上游请求）。
 */
function buddyFamilyExpiry(product) {
    return {
        credentialExpiry: (c, context) => buddyExpiry(product, c, context?.cachedBalance === undefined
            ? undefined
            : () => context.cachedBalance(context.accountId)),
    };
}
/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方（`index.ts` 与单测）各自持有一份，
 * 互不影响；表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export function createProviderExpiry(deps = {}) {
    return {
        // ⚠️ 两个 buddy 系产品：原语相同、product 不同（`CODEBUDDY` / `WORKBUDDY`）。
        buddy: buddyFamilyExpiry(CODEBUDDY),
        workbuddy: buddyFamilyExpiry(WORKBUDDY),
        loomy: { credentialExpiry: (c) => loomyExpiry(c) },
        codearts: { credentialExpiry: (c) => codeArtsExpiry(c) },
        zcode: { credentialExpiry: (c, context) => zcodeExpiry(c, context) },
        lobsterai: {
            credentialExpiry: (c, context) => lobsteraiExpiry(c, LOBSTERAI, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        trae: {
            credentialExpiry: (c, context) => traeExpiry(c, TRAE, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        // ⚠️ accio：与 loomy **同形**（命名池、无逐包时间戳）⇒ 单独一条原语。
        //    加它时必须**同时**进 `WIRED_EXPIRY_PROVIDERS`（`expiry-runtime-parity.spec.ts`
        //    真跑 `apply()` 锁这两者一致；只改一处会红）。
        accio: { credentialExpiry: (c) => accioExpiry(c) },
        // ⚠️ officeace：与 **buddy 系同形**（订阅的每个积分桶都带 `expiresAt`）。
        //    ⚠️ **必须传 `context.credentialRef`**：它的余额入口只有拿到 ref 才走
        //    云侧直读，否则回落到果办客户端的全局单 cookie ⇒ 多账号折算成同一份
        //    余额（串号），而聚合候选排序是每账号粒度 ⇒ 会选错人。
        //    同 accio：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改。
        officeace: {
            credentialExpiry: (c, context) => officeaceExpiry(c, context?.credentialRef),
        },
        // ⚠️ **本 fork 独有**（魔搭，2026-10-17，用户明确要求加入聚合轮换）：
        //    属「有余额但不下发到期时间」那一类 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
        //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae 同款 —— 聚合每轮折算会对
        //    同一账号反复提问，没有共享读数就会白发大量重复请求。
        //    同 accio / officeace：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改，
        //    由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致。
        modelscope: {
            credentialExpiry: (c, context) => modelscopeExpiry(c, MODELSCOPE, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        // ⚠️ **AutoClaw**（智谱，2026-10-17 审计 P0 修复）：与 modelscope **同格**
        //    （钱包余额不下发到期时间 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`）。
        //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
        //    这是该陷阱的第 4 次复发，漏任何一处的症状都是**静默**的
        //    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
        //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
        //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
        autoclaw: {
            credentialExpiry: (c, context) => autoclawExpiry(c, AUTOCLAW, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        /**
         * **AutoClaw 国际版**（`autoclawintl`，2026-10-20）。
         *
         * ⚠️⚠️ **product 必须传 `AUTOCLAW_INTL`**：`autoclawExpiry` 内部拿它调
         *    `fetchAutoclawBalanceDetailed(cred, { product })` ⇒ 传国内版会用
         *    **国内基址**查国际账号的余额 ⇒ `410000 未登录` ⇒ 折算恒 `UNUSABLE`
         *    ⇒ 国际账号在聚合轮换列表里**静默不可见**。
         *    这是「同一实现两个实例」最容易踩的一处（与 `provider-credits.ts` 同型）。
         *
         * ⚠️ 批次**实测带** `deductionEndTime`（国际站 3000 → 10/21、10000 → 10/27），
         *    与 buddy 系同形 ⇒ 走 `sharedPackageExpiry` 正确的按到期折算，不是恒 NEVER。
         */
        autoclawintl: {
            credentialExpiry: (c, context) => autoclawExpiry(c, AUTOCLAW_INTL, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        // ⚠️ **AStudio**（讯飞 AstronStudio，2026-10-20）：与 **buddy 系同形**
        //    （三池各带 `*NextExpireTime` ⇒ 逐包真实到期时刻，`astudioExpiry` 走
        //    `sharedPackageExpiry` 取最早那包）。
        //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
        //    这是该陷阱的第 **5** 次复发（cline → accio → officeace → autoclaw → astudio），
        //    漏任何一处的症状都是**静默**的（用户在聚合轮换列表里看不到该渠道，
        //    零报错零日志）。
        //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
        //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
        astudio: {
            credentialExpiry: (c, context) => astudioExpiry(c, ASTUDIO, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
        /**
         * ⚠️ **Qoder**（国际版 / 中国版，2026-10-20）：与 **buddy 系同形**
         *    （`CreditPackage` 都带 `deductionEndTime`）⇒ 原语直接复用
         *    `sharedPackageExpiry`；两站共用同一个原语（只换 product），
         *    单独抽 `qoderFamilyExpiry` 是为了让「它们只差一个 product」一眼可见。
         *
         *    ⚠️⚠️ **与上面所有条目的关键差别：本家是「接入了，但上游不给逐包时刻」。**
         *    实测（2026-10-20，两个真实 qodercn 账号）：`userQuota` 的顶层
         *    `expiresAt = 253402214400000` 是**永久哨兵**（`9999-12-31T00:00:00Z`），
         *    `addOnQuota` **只给聚合标量、零日期字段**，
         *    `dedicatedResourcePackages`（唯一带真实逐包到期的字段）本机为 `undefined`
         *    ⇒ `qoder-credits.ts` 对哨兵**不写** `deductionEndTime`
         *    ⇒ 折算得 `NEVER`（长期）= 三档里「永久（未知到期）」那一桶。
         *    ⚠️ **无 `dedicatedResourcePackages` 时临期桶恒为 0**，这是如实限制
         *    （绝不为了凑出一档而编造日期）。
         *    ⚠️ 国际版 `openapi.qoder.sh` 本机**网络不可达** ⇒ 取不到时
         *    `fetchQoderCreditBalance` 返回 `null` ⇒ `UNUSABLE`（剔除），保守。
         *
         *    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
         *    这是该陷阱的第 **7** 次复发（cline → accio → officeace → autoclaw
         *    → astudio → minimax → qoder），漏任何一处的症状都是**静默**的
         *    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
         *    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope / astudio /
         *    minimax 同款 —— 聚合每轮折算会对同一账号反复提问，没有共享读数就会
         *    白发大量重复请求。
         *    ⚠️ **两站各占一项**：`credentialExpiry` 的分派按 provider id，漏
         *    `qodercn` 会让中国版单独恒 `UNUSABLE`（与 minimaxintl 同因）。
         */
        qoder: qoderFamilyExpiry(QODER, deps),
        qodercn: qoderFamilyExpiry(QODER_CN, deps),
        // ⚠️ **MiniMax Code**（中国版 / 国际版，2026-10-20）：两家共用同一个原语
        //    （只换 product），与 buddy / workbuddy 同款 —— 单独抽 `minimaxFamilyExpiry`
        //    是为了让「它们只差一个 product」一眼可见（同族各写一份判据 = 分叉的开始）。
        //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
        //    这是该陷阱的第 **6** 次复发（cline → accio → officeace → autoclaw
        //    → astudio → minimax），漏任何一处的症状都是**静默**的
        //    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
        //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope / astudio 同款
        //    —— 聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
        minimax: minimaxFamilyExpiry(MINIMAX, deps),
        minimaxintl: minimaxFamilyExpiry(MINIMAX_INTL, deps),
    };
}
/**
 * Qoder 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 与 {@link buddyFamilyExpiry} 逐字同形：本家没有 XFF / 地理分流需求
 *    （两站各自有独立域名且互不 307），故**不**像 minimax 那样多一个透传参数。
 *
 * ⚠️ `context.cachedBalance` **在每次折算时现读**（不是建表时固化）：
 *    与 `createProviderCredits` 的同名字段同一纪律。
 */
function qoderFamilyExpiry(product, deps) {
    return {
        credentialExpiry: (c, context) => qoderExpiry(c, product, context?.cachedBalance === undefined
            ? undefined
            : () => context.cachedBalance(context.accountId), 
        // ⚠️ **按 `accountId` 现取**（与 `minimaxIntl` 同款）：账号可能随时改代理。
        //    `context.accountId` 缺失时传空串 —— 与解析器的契约一致
        //    （空 id 会去查「登录预置」那条，查不到则直连）。
        deps.qoderFetchFor === undefined
            ? undefined
            : deps.qoderFetchFor(context?.accountId ?? '')),
    };
}
/**
 * MiniMax 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 与 {@link buddyFamilyExpiry} 的关键差别：本家还要透传 `deps.minimaxXff`。
 *    国际站按出口 IP 做地理分流（`agent.minimax.io` 307 到中国站，而中国站
 *    不认国际站 token ⇒ `401 invalid access token`，与「凭据真失效」逐字同形，
 *    issue IKMEVG）⇒ 不带 xff 时国际站账号的折算**恒失败**，该渠道在聚合轮换里
 *    被静默剔除（面板却还能正常刷新 —— 两条链路各走各的 xff 取值）。
 *
 * ⚠️ `deps.minimaxXff` **在每次折算时现读**（不是建表时固化成一个字符串）：
 *    用户随时可能在设置里改 XFF，固化会让改动不生效（与 `createProviderCredits`
 *    的同名字段同一纪律）。
 */
function minimaxFamilyExpiry(product, deps) {
    return {
        credentialExpiry: (c, context) => minimaxExpiry(c, product, context?.cachedBalance === undefined
            ? undefined
            : () => context.cachedBalance(context.accountId), deps.minimaxXff?.(), 
        /**
         * ⚠️ **按账号取出口**（PR !145 审计 P0 修法）。
         *
         * 判据：只有国际站需要（中国站直连才是最优 —— 给它挂代理反而让流量绕境外
         * 一圈，且可能被引到国际站）；且必须拿到账号 id 才取，否则退回全局 `fetch`
         *（不知道是谁就不该猜一个账号去用它的出口）。
         *
         * ⚠️ 这与 `createProviderCredits` 的 `minimaxIntlFetcher` 是**同一份判据的
         * 两处消费**（两条链路各自有 deps 类型，无法共享函数体）——
         * 一致性由 `expiry-runtime-parity.spec.ts` 的真跑 `apply()` 锁住。
         */
        product.id === 'minimaxintl'
            && deps.minimaxIntlFetchFor !== undefined
            && context?.accountId !== undefined
            && context.accountId !== ''
            ? deps.minimaxIntlFetchFor(context.accountId)
            : undefined),
    };
}
//# sourceMappingURL=provider-expiry.js.map