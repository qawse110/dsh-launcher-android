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
 * ## ⚠️ 只覆盖**已接入临期折算**的 7 家
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
 * 它在源码里有 **4 个**消费点：`aggregate-adapter.ts` 的**三处**过滤
 *（探测过滤 / 候选过滤 / 虚拟模型过滤）加 `aggregate-expiry.ts` 的「未接入」短路；
 * 更要紧的是它被**大量不调 `apply()`** 的既有测试消费（实测：在 `tests/unit` 里
 * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）——
 * 派生版本在那些场景下**恒为空数组**，`refreshCatalog` 会把**所有虚拟模型过滤掉**、
 * 聚合 provider 的模型列表**整个变空**。
 * 两者的一致性由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
 */
import { accioExpiry, buddyExpiry, codeArtsExpiry, lobsteraiExpiry, loomyExpiry, officeaceExpiry, traeExpiry, zcodeExpiry, } from './aggregate-expiry.js';
import { CODEBUDDY, WORKBUDDY } from './product.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { TRAE } from './trae-product.js';
/**
 * buddy 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 单独抽出来是为了让下面两条一眼看出「它们只差一个 product」——
 * 若将来有人给其中一家写一份自己的判据，那正是「同族分叉」的开始。
 */
function buddyFamilyExpiry(product) {
    return { credentialExpiry: (c) => buddyExpiry(product, c) };
}
/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方（`index.ts` 与单测）各自持有一份，
 * 互不影响；表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export function createProviderExpiry() {
    return {
        // ⚠️ 两个 buddy 系产品：原语相同、product 不同（`CODEBUDDY` / `WORKBUDDY`）。
        buddy: buddyFamilyExpiry(CODEBUDDY),
        workbuddy: buddyFamilyExpiry(WORKBUDDY),
        loomy: { credentialExpiry: (c) => loomyExpiry(c) },
        codearts: { credentialExpiry: (c) => codeArtsExpiry(c) },
        zcode: { credentialExpiry: (c, context) => zcodeExpiry(c, context) },
        lobsterai: { credentialExpiry: (c) => lobsteraiExpiry(c, LOBSTERAI) },
        trae: { credentialExpiry: (c) => traeExpiry(c, TRAE) },
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
    };
}
//# sourceMappingURL=provider-expiry.js.map