/**
 * 各 provider 的**元数据与能力声明** —— 本插件里「有哪些 provider、各自有什么能力」
 * 的**唯一真相源**。
 *
 * ## ⚠️ 本文件必须零 import
 *
 * 它同时被两侧消费：
 * - **Node 宿主**（`tsc` → `lib/`）：`src/jet-hub-rpc.ts` 等读它；
 * - **浏览器客户端**（`esbuild` → `lib/client/jet-hub.js`）：
 *   `plugin-src/client/*.js` 经 `import { … } from '../../src/provider-registry.js'`
 *   直接复用它。
 *
 * 后者**已实测可行**（设计文档 §1.4）：esbuild 会把 `./x.js` 解析到同名 `x.ts`。
 * 但浏览器里没有 `node:fs` / `node:path` 等，故本文件**不得** import 任何 `node:*`。
 *
 * ## 为什么要把元数据集中到这里
 *
 * 重构前，加一个 provider 要手改 **13 处**，其中两处会**静默失效**：
 *
 * 1. **四处单测的正则断言**用 `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 从客户端
 *    `PROVIDERS` 派生 id —— `[a-z]+` **不匹配连字符**。若新 provider id 写成
 *    `kuku-ai`，守卫会**静默漏掉一个 id 而照样全绿**（本仓库原注释：
 *    「保险失效比变红更糟」）。
 * 2. **`registerJetHubRpc` 的位置参数**（当时 16 个）—— 注释自陈
 *    「历史上已因少传/插队错位复发 **6 次**」。
 *
 * 本文件消除第 1 处：四处断言改为读 `PROVIDER_REGISTRY`，不再解析源码文本。
 *
 * ## 与各 product 的 `displayName` 的关系
 *
 * 本文件的 `displayName` 当前与对应 product 的 `displayName`（如
 * `src/product.ts` 的 `CodeBuddy (腾讯)`）**取值相同**，但
 * ⚠️ **没有任何断言守着这条一致性** —— 2026-10-08 之前有，那些断言在
 * 客户端 `PROVIDERS` 改为派生后**改锁 `label`** 了（见
 * `raccoon-client-panel.spec.ts` / `zcode-wiring.spec.ts`）。
 *
 * ⚠️ 且它**当前零生产消费者**：真正被读的是各 product 自己的 `displayName`。
 * ⇒ 结构与去留由 Task 11 的收尾审计定夺（选项：删掉本字段只留 `label`，
 * 或保留并补一条「与 product 逐字一致」的断言把它变成可测量的）。
 * **在那之前，不要把本字段当作契约来依赖。**
 */
/**
 * ⚠️ 图标字面量**不写在这里**，而在 `plugin-src/client/provider-icons.js`
 *（它们是几百到几万字符的 base64 / SVG data URI）。原设计想让 registry 持有图标，
 * 但那会让**宿主侧**的 `lib/index.js` 白白背上约 40 KB 的字面量 ——
 * 而宿主从不使用图标。
 *
 * ⇒ 折中：registry 只持有 `logoClass`（两侧都要用），图标由客户端自己的
 * `PROVIDER_ICONS` 表按 id 提供，并由一条单测锁「两边 id 集合相等」。
 * 这样「新增 provider 忘记加图标」仍会**变红**，但不会把大字符串搬进宿主产物。
 */
export const PROVIDER_REGISTRY = Object.freeze([
    {
        id: 'codearts',
        label: 'CodeArts (华为云)',
        displayName: 'CodeArts (华为云)',
        logoClass: 'codearts',
        credits: { balance: true, dailyCheckin: true },
        settingsNamespace: 'llm-codearts',
        channel: true,
    },
    {
        id: 'buddy',
        label: 'CodeBuddy (腾讯)',
        displayName: 'CodeBuddy (腾讯)',
        logoClass: 'buddy',
        credits: { balance: true, dailyCheckin: true },
        creditPackages: true,
        permanentLock: true,
        usesExpiryWindow: true,
        settingsNamespace: 'llm-buddy',
        channel: true,
    },
    {
        id: 'workbuddy',
        label: 'WorkBuddy (国际版)',
        displayName: 'WorkBuddy (国际版)',
        logoClass: 'workbuddy',
        // ⚠️ 国际版后端**没有**签到接口（内核里只有 `get-dosage-notify` 用量通知）。
        credits: { balance: true, dailyCheckin: false },
        creditPackages: true,
        permanentLock: true,
        usesExpiryWindow: true,
        settingsNamespace: 'llm-workbuddy',
        channel: true,
    },
    {
        id: 'lobsterai',
        label: 'LobsterAI (有道)',
        displayName: 'LobsterAI (有道)',
        logoClass: 'lobsterai',
        credits: { balance: true, dailyCheckin: true },
        creditPackages: true,
        permanentLock: true,
        usesExpiryWindow: true,
        settingsNamespace: 'llm-lobsterai',
        channel: true,
    },
    {
        id: 'qoder',
        label: 'Qoder',
        displayName: 'Qoder',
        logoClass: 'qoder',
        credits: { balance: true, dailyCheckin: true },
        creditPackages: true,
        settingsNamespace: 'llm-qoder',
        channel: true,
    },
    {
        id: 'qodercn',
        label: 'Qoder (中国版)',
        displayName: 'Qoder (中国版)',
        logoClass: 'qodercn',
        credits: { balance: true, dailyCheckin: true },
        creditPackages: true,
        settingsNamespace: 'llm-qodercn',
        channel: true,
    },
    {
        id: 'trae',
        label: 'TRAE (字节)',
        displayName: 'TRAE (字节)',
        logoClass: 'trae',
        credits: { balance: true, dailyCheckin: true },
        creditPackages: true,
        permanentLock: true,
        usesExpiryWindow: true,
        settingsNamespace: 'llm-trae',
        channel: true,
    },
    {
        id: 'cline',
        label: 'Cline',
        displayName: 'Cline',
        logoClass: 'cline',
        // ⚠️ 无签到：对整个 sidecar 二进制做字符串扫描，`checkin` / `campaign` 等
        //    均无 Cline 业务端点命中。
        // `subscriptionQuota` 是**本表唯一**具备该项的渠道（5 小时 / 周 / 月窗口）。
        credits: { balance: true, dailyCheckin: false, subscriptionQuota: true },
        settingsNamespace: 'llm-cline',
        channel: true,
    },
    {
        id: 'loomy',
        label: 'Loomy (讯飞)',
        displayName: 'Loomy (讯飞)',
        logoClass: 'loomy',
        credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
        // ⚠️ Loomy **不返回限流错误**：今日赠送额度用完后，服务端继续扣永久积分且
        //    照常返回（静默降级）⇒「重测 / 重置」对它毫无意义（重测还会白烧积分）。
        rateLimit: false,
        permanentLock: true,
        // ⚠️ 不在 usesExpiryWindow：它**没有窗口概念**，服务端直接给两个命名池。
        settingsNamespace: 'llm-loomy',
        channel: true,
    },
    {
        id: 'raccoon',
        label: 'Raccoon (商汤)',
        displayName: 'Raccoon (商汤)',
        logoClass: 'raccoon',
        // ⚠️ 不登记 `dailyCheckin`，且**这不是遗漏**：实测「每日 300 积分」是服务端
        //    按日自动发放的（账单 `biz_type: 'daily_grant'`），**没有可调用的签到端点**。
        //    登记它会让用户每次点击都必然失败。
        //    `onboardingTasks` 是 3000 分的**幂等一次性**桌面端登录奖励。
        credits: { balance: true, onboardingTasks: true },
        settingsNamespace: 'llm-raccoon',
        channel: true,
    },
    {
        id: 'minimax',
        label: 'MiniMax Code',
        displayName: 'MiniMax Code',
        logoClass: 'minimax',
        credits: { balance: true, dailyCheckin: true },
        settingsNamespace: 'llm-minimax',
        channel: true,
    },
    {
        id: 'zcode',
        label: 'ZCode (智谱)',
        displayName: 'ZCode (智谱)',
        logoClass: 'zcode',
        // ⚠️ 量纲是 **token 而非积分** —— 能力矩阵回答的是「有没有这项能力」，
        //    不是「量纲是否一致」；量纲差异在面板与 RPC 层如实标注。
        credits: { balance: true, dailyCheckin: true },
        autoCheckinExcluded: true,
        settingsNamespace: 'llm-zcode',
        channel: true,
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        displayName: 'OpenCode',
        logoClass: 'opencode',
        // ⚠️ `balance: true` 但语义**不是余额**而是「**通道可用性**」：Zen 没有公开的
        //    余额 API（15 个候选路径全 404），故徽标展示我们真正测得到的东西
        //    （每个通道当前是否可用、是否处于限额冷却），数据全来自本地、零网络请求。
        //    早期登记为 false 曾把**整个徽标挡死**（组件第一件事就是判这个布尔）。
        credits: { balance: true, dailyCheckin: false },
        // ⚠️ 无 settingsNamespace：它不在老契约的 namespace 清单里。
        channel: true,
    },
    {
        id: 'gemini',
        label: 'Gemini Code Assist',
        displayName: 'Gemini Code Assist',
        logoClass: 'gemini',
        // ⚠️ 不登记 dailyCheckin：Cloud Code 免费线是**纯配额制**，
        //    没有可调用的签到/领取端点（签到是服务端按日自动发放的）。
        credits: { balance: true, dailyCheckin: false },
        // ⚠️ 与 loomy 同值但**理由不同**：它确实会回 429、适配器也确实写
        //    `modelRateLimits`，但限流是**服务端配额窗口制** —— 本地标记清掉、
        //    重测通过，配额本身一点没恢复，下一次请求立刻又是 429。
        //    于是这组按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用。
        rateLimit: false,
        accountTest: true,
        settingsNamespace: 'llm-gemini',
        channel: true,
    },
    {
        id: 'officeace',
        label: 'OfficeAce',
        displayName: 'OfficeAce',
        logoClass: 'officeace',
        // ⚠️ **有**积分余额：数据来自云侧 `GET /v1/subscription`（V11 签名直读，
        //    与果办界面右上角同源同口径，2026-10-12 扣减实锤），**不依赖 OfficeAce 客户端**。
        //
        // ⚠️ `dailyCheckin: false` 但**该渠道确实有签到** —— 这里是**故意**不登记 true：
        //    签到走的是云侧 `POST /v1/subscription/bonus/claim`，且果办客户端的实现是
        //    「订阅页一挂载就自动领、**UI 上没有按钮**」（源码 `SubscriptionStateProvider`
        //    用「年+月+日+时」去重，每小时最多一次）。
        //    故本渠道的签到在**拉余额时自动完成**（见 `officeace-auth.ts` 的
        //    `maybeClaimBonus`）—— 登记成 true 会让面板渲染一个手动签到按钮，
        //    而它背后的 `credits.claim` RPC 对本渠道没有意义（真正的领取是自动的）。
        //    ⚠️ 语义：该字段表达「是否存在**手动**签到入口」，不是「有没有签到收益」。
        credits: { balance: true, dailyCheckin: false },
        // ⚠️ 余额响应里每个积分包都带到期时间（订阅套餐包无固定到期 = 永久桶，
        //    签到 / 活动包有明确到期）⇒ 可按 `deductionEndTime` 分「永久 / 长期 / 临期」三档。
        creditPackages: true,
        permanentLock: true,
        usesExpiryWindow: true,
        // ⚠️ `rateLimit: false` 的**真实理由**（2026-10-13 合并审计实测订正）：
        //    本适配器**根本不写** `modelRateLimits`（`officeace-adapter.ts` 里
        //    `modelRateLimits` / `updateModelRateLimit` / `markLimited` **零命中**，
        //    `provider-runtime-wiring.spec.ts` 也把它登记为空数组）⇒
        //    账号永远没有标记可清 ⇒ 两个按钮点下去**零请求、零清除**（恒惰性）。
        //    ⚠️ 此前这里写的是「它确实会回 429、适配器也写 `modelRateLimits`，
        //    但限流由华为云 MaaS 侧按账号配额管理」——**那句失实**（前半个分句是错的），
        //    真实判据与 accio 同因（「根本没有这组按钮的作用对象」），
        //    与 loomy / gemini 的「会写但清不掉」**不是同一回事**。
        rateLimit: false,
        settingsNamespace: 'llm-officeace',
        channel: true,
    },
    {
        id: 'accio',
        label: 'Accio (阿里)',
        displayName: 'Accio (阿里)',
        logoClass: 'accio',
        // ⚠️ 如实登记：Accio **没有签到端点** —— 每日 200 积分由**登录**触发服务端
        //    发放（`DAILY_REWARD`，24h 有效、不累积），没有可调用的签到 API。
        //    故 `dailyCheckin` 显式写 false（省略与 false 行为一致，但显式写让
        //    「想过这件事」在代码里可见）。
        //    ⚠️ **面板里也没有「刷新每日额度」入口**（2026-10-13 修订）：早先这里写过
        //    「面板另有一个 accio 专属入口，本质是重新登录」，那条承诺**未兑现**。
        //    重新登录**既有**账号需要宿主侧新增 RPC —— 现有的 `account.create` 每次都用
        //    `${provider}-${shortId()}` 现造账号 id 与凭据 ref（`src/jet-hub-rpc.ts`），
        //    拿它当重登录用会多出一条幽灵账号、而原账号额度一点没刷新；账号的 `region`
        //    也没下发给客户端；`login.poll` 对已登录账号第一秒就返回 `done: true`。
        //    ⇒ **该入口尚未实现**，客户端只做诚实展示（三类积分桶 + 重置倒计时 +
        //    「删除该账号后重新登录」这条手动路径），不渲染任何点不动的控件。
        credits: { balance: true, dailyCheckin: false },
        // ⚠️ `rateLimit: false` —— 这里的判据是 registry 自己的落地问法：
        //    「这个按钮点下去，能不能让用户**少**受限一次？」答否即 false。
        //    accio 两条都不满足：
        //    ① 适配器**不写** `modelRateLimits`（`provider-runtime-wiring.spec.ts`
        //       的 `WRITE_SITE_FILES` 把它登记为空，并由一条用例**验证**它确实无写点）
        //       ⇒ 账号永远没有标记可清；
        //    ② `src/index.ts` 的 `probeById` 没有它的条目（该表被守卫锁成**恰好**
        //       「会写标记的家」）⇒ 点「重测」时 `retestAccount` 走到
        //       `modelIds.length === 0` 处**提前返回**：零请求、零清除。
        //    两者叠加 ⇒ 面板级的「重测所有 / 重置所有」与卡片级的两个按钮**全部恒为
        //    惰性**。那正是本仓库记录过的报障形态（「按钮响应这么快，是不是坏了」）。
        //    ⚠️ 与 loomy / gemini **理由不同**（它们是真会限流、只是按钮管辖不到）：
        //    accio 是**根本没有这组按钮的作用对象**。
        //    ⚠️ 「省略 = true 以免老用户失去按钮」那条理由**不适用于全新 provider**：
        //    accio 没有存量用户，没有「功能回退」可言。
        //    ⇒ 将来接上请求级换号 + 冷却（届时必须同时进 `probeById` 与
        //    `WRITES_RATE_LIMIT_PROVIDERS`）时，**本行要一起改回 true**。
        rateLimit: false,
        settingsNamespace: 'llm-accio',
        channel: true,
    },
    {
        id: 'aggregate',
        label: '聚合 (跨渠道)',
        displayName: '聚合 (跨渠道)',
        logoClass: 'aggregate',
        // ⚠️ 如实登记为 false：它**没有自己的账号与余额** —— 复用各渠道的账号，
        //    积分与限流由各渠道自己管理。
        // ⚠️ 这不影响用量徽标：徽标对聚合的处理是「重定向到实际选中的渠道」，
        //    重定向发生在 `supportsCreditBalance` 门控**之前**。
        credits: { balance: false, dailyCheckin: false },
        channel: false,
    },
]);
/** 按 id 取声明；未知返回 `undefined`（调用方决定报错措辞）。 */
export function descriptorOf(id) {
    return PROVIDER_REGISTRY.find((d) => d.id === id);
}
/**
 * 派生出客户端 `CREDITS_CAPABILITIES` 的同形结构。
 *
 * ⚠️ 只拷贝**已声明**的可选字段（不用 `undefined` 占位）：既有断言用的是
 * `toEqual`，而 `toEqual` 会忽略 `undefined` 属性 —— 但显式写 `undefined`
 * 在快照/序列化场景下仍可能产生差异，保持"缺失即缺失"最安全。
 */
export function creditCapabilitiesOf() {
    const out = {};
    for (const d of PROVIDER_REGISTRY) {
        // ⚠️ **每一条都要 `Object.freeze`**（2026-10-08 复审修复）：重构前
        // `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
        // `Object.freeze({…})`，改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` ——
        // 那只冻结**外层容器**（键不可增删），**内层条目仍可被改写**。
        // 同一文件另外两张派生表（`RATE_LIMIT_CAPABILITIES` /
        // `ACCOUNT_TEST_CAPABILITIES`）各自都留着 `Object.freeze({…})`，
        // 三张表必须同款 —— 本仓库的约定是「保险失效比变红更糟」：
        // 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了）。
        out[d.id] = Object.freeze({
            balance: d.credits.balance,
            // ⚠️ `dailyCheckin` 也是**可省略**字段（见 `CreditsCapability` 的注释：
            //    raccoon 刻意不登记它），故按本函数「缺失即缺失」的规则一并条件拷贝
            //    —— 这样「raccoon 没有签到端点」这件事在派生表里也是**可见的缺失**，
            //    而不是一个与 `false` 无法区分的 `undefined`。
            //    判据侧一律 `=== true`（`supportsDailyCheckin`），故行为不变。
            ...d.credits.dailyCheckin === undefined ? {} : { dailyCheckin: d.credits.dailyCheckin },
            ...d.credits.onboardingTasks === undefined ? {} : { onboardingTasks: d.credits.onboardingTasks },
            ...d.credits.subscriptionQuota === undefined ? {} : { subscriptionQuota: d.credits.subscriptionQuota },
        });
    }
    return out;
}
//# sourceMappingURL=provider-registry.js.map