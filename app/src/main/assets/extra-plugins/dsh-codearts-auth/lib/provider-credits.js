/**
 * 各 provider 的**积分能力实现表** —— `ProviderRuntime.credits` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`credits.balances` 是一个 **441 行**的 `case`，里面 11 段
 * `if (req.provider === X.id)` 各自重复同一套编排（逐账号 resolve 凭据 →
 * 调用本家的余额原语 → 拼 `{accountId, nickname, balance, error}`）。
 * 那些分支里**没有一行是协议逻辑** —— 协议早已封装在各家 `fetch*Balance` 内，
 * RPC 层看到的只是「选哪个函数」（设计文档 §3.5 的边界）。
 *
 * 本文件把「选哪个函数」抽成数据；编排仍留在既有的共享骨架
 *（`collectCreditBalances` / `collectCreditsStatus`）里，**一行不重写**。
 *
 * ## ⚠️ 哪些渠道**不在这里**（形态与骨架根本不匹配，刻意保留特例）
 *
 * | 渠道 | 为什么不进表 |
 * |---|---|
 * | `opencode` | 它的「余额」是**本地派生的通道可用性**（读账号池的 `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求。 |
 * | `qoder` / `qodercn` | `fetchQoderCreditBalance` 只吃 `QoderCredential`、且 product 来自同族注册表；旧实现因此**没有**走 `collectCreditBalances` 的 `(credential, product)` 泛型。 |
 *
 * 这两段留在 `jet-hub-rpc.ts` 的 `credits.balances` 里、**先于查表短路**，
 * 并有各自的行为用例锁死（见 `credits-runtime-parity.spec.ts` 的
 * 「特例的优先级」）。强行套骨架会丢语义 —— 那是本仓库反复记录的缺陷形态。
 *
 * ## ⚠️ 为什么有些渠道用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * `fetchBalance` 的 `null` 由共享骨架统一翻译成「余额查询失败」。但有几家的
 * 失败原因**必须区分**（用户会按原因决定去重新登录、还是去充值、还是什么
 * 都不用做）：
 *
 * - `codearts`：三态 —— 「Token 计费账户」/「非积分计费账户」/「未返回积分数据」；
 * - `gemini`：「尚未授权 Google 账号」与「查询失败」是两回事；
 * - `zcode`：「企业版不下发额度数字」不是故障；
 * - `cline` / `loomy` / `raccoon`：协议原语自己带**具体**原因
 *  （含 HTTP 状态码与错误体摘要），压成笼统一句会丢掉唯一有用的线索。
 * - `accio`：三条失败路径的**用户动作完全不同**（未登录 / 一般查询失败 /
 *   响应里没有余额字段），而 `fetchAccioBalanceDetailed` 自己给得出这三句。
 *
 * 故这些渠道给 `fetchBalanceDetailed`，文案由实现自己负责。
 * **绝不允许把「查不到」写成 0**（0 是「已用光」的语义）。
 *
 * ## ⚠️ 为什么是**工厂**而不是常量表
 *
 * `loomy` / `raccoon` / `zcode` 的余额查询走**各自 auth 实例上的方法**
 *（`fetchCreditBalance` / `fetchBalanceFor`），因为那些实例可能带注入的
 * `fetchImpl`（测试替身 / 代理）。重构前 RPC 就是这么调的，这里原样保留。
 * 未传实例时回退到自由函数 + 全局 `fetch` —— 与 `index.ts` 的实际构造
 *（三者都没传 `fetchImpl`）逐字等价，故生产行为不变。
 */
import { CODEBUDDY, WORKBUDDY } from './product.js';
import { CLINE } from './cline-product.js';
import { GEMINI } from './gemini.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { LOOMY } from './loomy-product.js';
import { RACCOON } from './raccoon-product.js';
import { TRAE } from './trae-product.js';
import { fetchClineCreditBalance } from './cline-credits.js';
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js';
import { fetchGeminiCreditBalance } from './gemini-credits.js';
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } from './lobsterai-credits.js';
import { claimLoomyDailyQuota, fetchLoomyCreditBalance } from './loomy-credits.js';
import { claimMinimaxDailyCheckin, fetchMinimaxCreditBalance, fetchMinimaxSigninStatus, } from './minimax-credits.js';
import { fetchRaccoonCreditBalance } from './raccoon-credits.js';
import { fetchAccioBalanceDetailed } from './accio-credits.js';
import { fetchTraeCreditBalance, claimTraeDailyCheckin, fetchTraeCheckinStatus } from './trae-credits.js';
import { collectBuddyGrowth } from './buddy-growth.js';
import { fetchZcodeBalance } from './zcode-upstream.js';
import { claimDailyCheckin, fetchCheckinStatus, fetchCreditBalance, } from './credits.js';
/**
 * 把 ZCode 的额度桶映射成 `CreditBalance`。
 *
 * ⚠️ **逐桶映射，不是只取第一个桶**（真实缺陷）：旧实现只取
 * `result.planName`（= `buckets[0]?.showName`）拼**一个**包 —— 多桶账号的
 * 其余额度被**静默丢掉**，而 `result.remaining` / `total` 却是**全桶汇总**，
 * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
 * 实测本机账号只回一个桶，但**不能按「只有一个桶」来写** —— 那正是把缺陷
 * 固化成契约。
 *
 * ## 空桶的兜底
 *
 * 上游可能一个桶都不给。此时**不能**返回空 `packages`（前端会显示成
 * 「没有额度」而不是「查不到」），故给一个具名占位包，让 UI 至少能显示
 * 「0 / 0」并带上 `result.planName`。
 */
export function buildZcodeBalance(result) {
    const packages = result.buckets.map((bucket) => {
        const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0;
        const total = bucket.totalUnits ?? 0;
        return {
            name: bucket.showName ?? result.planName ?? 'ZCode 免费额度',
            // ⚠ 单位是 **token**（不是 credit）—— 如实标注，
            // 避免用户以为 ZCode 有 1 亿积分。
            unit: 'token',
            remaining,
            total,
            used: Math.max(0, total - remaining),
            active: true,
            // ZCode 的额度按日刷新（`period: 'one_time'` 的活动包到点失效），
            // 故周期起止都留空，只用 `expiredTime` 给到期时刻。
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: bucket.expiresAt !== undefined
                ? new Date(bucket.expiresAt * 1000).toISOString()
                : (result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : ''),
        };
    });
    if (packages.length === 0) {
        packages.push({
            name: result.planName ?? 'ZCode 免费额度',
            unit: 'token',
            remaining: result.remaining,
            total: result.total,
            used: Math.max(0, result.total - result.remaining),
            active: true,
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: result.expiresAt !== undefined
                ? new Date(result.expiresAt * 1000).toISOString()
                : '',
        });
    }
    return {
        // 仍是**全桶汇总**，与 `packages` 逐项之和一致（`fetchZcodeBalance` 就是这么累加的）。
        total: result.remaining,
        // ZCode 不在同一响应里区分「已失效包」，故为 0。
        expiredTotal: 0,
        packages,
    };
}
/** 组装一条「有余额」的带原因结果。 */
function ok(balance) {
    return { balance };
}
/** 组装一条「查不到」的带原因结果（`error` 必须是可读原因，不是 0）。 */
function fail(error) {
    return { balance: null, error };
}
/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ **只覆盖余额查得到资源包的渠道**。`opencode` 与 `qoder` 系刻意缺席
 *（见文件头），`aggregate` 没有自己的账号与余额。
 */
export function createProviderCredits(deps = {}) {
    return {
        /**
         * CodeArts（华为云）：余额搭 `statistics/plugin` 的账户类型检测回来，
         * 故必须用带原因的形态 —— 非积分账户要显示「Token 计费账户」而不是
         * 误导性的「余额查询失败」。
         *
         * ⚠️ 这三条文案是用户报障修来的，**逐字保留**。
         */
        codearts: {
            fetchBalanceDetailed: async (credential) => {
                // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
                // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
                // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
                // 无信息量的「账户信息查询失败」）。
                const result = await fetchCodeArtsAccountInfoDetailed(credential);
                if (!result.ok)
                    return fail(`账户信息查询失败：${result.message}`);
                const info = result.info;
                if (!info.isCreditPackage) {
                    return fail(info.isTokenPackage
                        ? 'Token 计费账户，无积分余额'
                        : '非积分计费账户，无积分余额');
                }
                // 积分账户但没有 credit metric：如实报「无积分数据」，
                // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
                if (info.credit === undefined)
                    return fail('未返回积分数据');
                return ok(info.credit);
            },
            /**
             * CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
             * 领取流程自带「账户类型 + 活动列表」预检（见 `claimCodeArtsDailyCheckin`），
             * 故 `precheckStatus: false` 跳过外部那次 CodeBuddy 式的状态查询 ——
             * 用 `fetchCheckinStatus` 打华为端点既发错请求又必然失败。
             */
            claim: (credential) => claimCodeArtsDailyCheckin(credential),
            precheckStatus: false,
        },
        lobsterai: {
            fetchBalance: (credential) => fetchLobsteraiCreditBalance(credential, LOBSTERAI),
            /**
             * LobsterAI 的 `clientVersion` 是签到必填参数，需**动态**解析
             *（带 TTL 缓存，通常无额外网络开销）—— 故必须惰性调用，不能在注册时
             * 固化成常量：缓存过期后拿到新版本这件事会失效。
             *
             * ⚠️ 解析器缺席时回落到产品的兜底常量（与 `lobsterai-adapter.ts` 同法）：
             * 该值一直发假值 `0.1.0` 也没被拒绝，故兜底可用。
             *
             * 领取流程内部已做 slot/context 预检 ⇒ `precheckStatus: false`
             *（外部再查一次纯属重复请求）。
             */
            claim: async (credential) => {
                const clientVersion = deps.lobsteraiClientVersion !== undefined
                    ? await deps.lobsteraiClientVersion()
                    : LOBSTERAI.fallbackClientVersion;
                return claimLobsteraiDailyCheckin(credential, LOBSTERAI, clientVersion);
            },
            precheckStatus: false,
        },
        trae: {
            fetchBalance: (credential) => fetchTraeCreditBalance(credential, TRAE),
            /**
             * ⚠️ **必须开启状态预检**（`precheckStatus: true`）。
             *
             * TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
             * `{code:0, message:"success"}`，与真正领取成功**无法区分**。
             * 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
             * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
             * 被报成「领取成功」（用户报障：**显示成功但 +0 积分**）。
             * 判据只能是状态端点的 `checked_in`。
             *
             * ⚠️ 这里用 {@link ProviderCredits.claimStatus} 而**不是** `fetchStatus`：
             * `credits.status` 对 trae **刻意仍回 `null`**（Task 3 的决定，见该字段注释）。
             */
            claimStatus: (credential) => fetchTraeCheckinStatus(credential, TRAE),
            claim: (credential, entry, call) => claimTraeDailyCheckin(credential, TRAE, fetch, 
            // ⚠️ 设备指纹代次按 `entry.id` 从**账号池**读写 —— 这是 `claim` 必须
            //    收 `entry` 的唯一理由（见 ProviderCredits.claim 的注释）。
            call.accountPool.traeCheckinDeviceGenerationFor(entry.id), (next) => call.accountPool.updateTraeCheckinDeviceGeneration(entry.id, next)),
            precheckStatus: true,
        },
        /**
         * Cline：协议原语自带**具体**原因（含 HTTP 状态码与错误体摘要），
         * 压成「余额查询失败」会丢掉唯一有用的线索。
         *
         * ⚠️ 它的 `claimUnavailableReason` 与条目一起写在下方（与 buddy 系同处），
         * 免得同一家的字段散落两处。
         */
        cline: {
            fetchBalanceDetailed: async (credential) => {
                const result = await fetchClineCreditBalance(credential, CLINE);
                // 查不到时带上具体原因，而不是笼统一句「查询失败」—— 卡片显示原因而非 0
                //（0 是「已用光」的语义，会误导用户）。
                return result.balance === null
                    ? fail(result.error ?? '积分查询失败（凭据失效或响应异常）')
                    : ok(result.balance);
            },
            claimUnavailableReason: 'Cline 不支持每日签到（其后端没有签到接口）',
        },
        /** Loomy：`/points/records`（**只读**，无副作用；`first-login` 是写端点）。 */
        loomy: {
            fetchBalanceDetailed: async (credential) => {
                // ⚠️ 判**方法存在**而不是 `deps.loomy !== undefined`：调用方常常只持有
                //   一个部分替身（单测的 `{}` 桩），用 `!== undefined` 会走进
                //   `undefined is not a function` 并被骨架吞成一条笼统错误 —— 那正是
                //   「静默降级」的形态。判方法则如实回退到自由函数。
                const viaInstance = deps.loomy?.fetchCreditBalance;
                const balance = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.loomy, credential)
                    : await fetchLoomyCreditBalance(credential, LOOMY);
                // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
                return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance);
            },
            /**
             * Loomy 的「签到」= `POST /points/first-login`（触发每日赠送额度）。
             *
             * ⚠️ 语义**不是**「+5000 积分」：`dailyBalance = dailyQuota - dailyConsumed`，
             * 消耗后不回补。文案由 `claimLoomyDailyQuota` 的 `already-claimed` 表达。
             *
             * ⚠️ **必须显式 `precheckStatus: false`，这是最容易漏的一格**：
             * 它**没有**独立的签到状态端点（幂等判据在 claim 响应体的 `alreadyProcessed`），
             * 而骨架的默认值是 true ⇒ 不传 false 时骨架会拿 **buddy 式**的
             * `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的真实上游请求**。
             *
             * ⚠️ 走的是**共享骨架**（不再自写循环）：`claimLoomyDailyQuota` 已返回
             * `ClaimOutcome`，与骨架的 `claim` 入参同型。旧 RPC 分支之所以自己写循环，
             * 只是因为当时它按「不传 product」的方式调用 —— **不是语义不兼容**。
             * 三个返回分支都**没有**设 `coversToday` ⇒ 一律 `true`（「今天已处理过」），
             * 与旧循环逐条一致（`already-claimed` 也算今天处理过）；由
             * `tests/unit/claim-runtime-parity.spec.ts` 显式锁住。
             */
            claim: async (credential) => {
                const viaInstance = deps.loomy?.claimDailyQuota;
                return typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.loomy, credential)
                    : await claimLoomyDailyQuota(credential, LOOMY);
            },
            precheckStatus: false,
        },
        /** Raccoon：`/points/v1/balance`（**只读**，无副作用）。 */
        raccoon: {
            fetchBalanceDetailed: async (credential) => {
                const viaInstance = deps.raccoon?.fetchCreditBalance;
                const balance = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.raccoon, credential)
                    : await fetchRaccoonCreditBalance(RACCOON, credential);
                // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
                // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
                return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance);
            },
            /**
             * ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放
             *（账单里的 `daily_grant`，实测注册后 1 分钟即到账）⇒ **刻意不提供 `claim`**。
             * 客户端按能力矩阵（`raccoon: { balance: true, onboardingTasks: true }`，
             * **无** `dailyCheckin`）根本不会渲染「一键领取积分」按钮。
             *
             * ⚠️ 文案**逐字保留**，含那句可操作指引「登录奖励请在『新手任务』中领取」
             * —— 用户看完才知道下一步该点哪里（压成泛化模板会丢掉它）。
             */
            claimUnavailableReason: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；'
                + '登录奖励请在「新手任务」中领取）',
        },
        /**
         * Accio（阿里）：三个**只读**端点聚合出的带原因余额。
         *
         * ⚠️ **必须用 `fetchBalanceDetailed`**（不是 `fetchBalance`）：三类失败
         * 的用户动作**完全不同** —— 未登录（去重新登录）/ 一般查询失败（查网络）/
         * 响应里没有余额字段（上游形状变了）。压成共享骨架那句笼统的
         * 「余额查询失败」会让用户按错误方向排查，而这三条文案是 Task 5 实测修来的。
         *
         * ⚠️ **刻意不提供 `claim`**：Accio **没有签到端点**（每日 200 积分由
         *    **登录**触发服务端发放），故也**不给 `claimUnavailableReason`** ——
         *    客户端按能力矩阵（`dailyCheckin: false`）根本不会渲染「一键领取积分」，
         *    与 raccoon 同形。给它一句文案反而会让面板多出一个永远点不动的入口。
         */
        accio: {
            fetchBalanceDetailed: async (credential) => await fetchAccioBalanceDetailed(credential),
        },
        /**
         * ZCode：额度单位是 **token**（不是积分）。`balance: null` 表示**查不到**
         * （不显示成 0，0 是「已用光」的语义）。
         */
        zcode: {
            fetchBalanceDetailed: async (credential) => {
                const viaInstance = deps.zcode?.fetchBalanceFor;
                const result = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.zcode, credential)
                    : await fetchZcodeBalance(credential);
                if (result === undefined)
                    return fail('额度查询失败（凭据失效或网络异常）');
                // 企业版不下发额度数字、只给外部链接 —— 如实说明，不显示 0。
                if (result.enterprise === true) {
                    return fail('企业版账号不下发额度数字，请在 ZCode 内查看');
                }
                return ok(buildZcodeBalance(result));
            },
        },
        /**
         * MiniMax：`GET /minimax-cloud/api/v1/credit/details`。
         *
         * ⚠️ 该端点是**平铺响应**（`total_count` 与 `base_resp` 同级、没有 `data` 键），
         * `fetchMinimaxCreditBalance` 内部已兼容两种形状。
         * ⚠️ 查不到时（null）由共享骨架统一补「余额查询失败」—— 卡片显示原因而非 0
         *（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
         */
        minimax: {
            fetchBalance: (credential) => fetchMinimaxCreditBalance(credential),
            // ⚠️ **有**独立的签到状态端点，与「如实返回 null」的那几家不同。
            // 判据是 `is_today && status===3`（见 `minimaxPanelToCheckinStatus`），
            // 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
            //
            // ⚠️ 它同时是**领取预检**的数据源（`precheckStatus` 缺省 true，见下）——
            //    预检与面板读数是同一个端点，故**只声明一次**（不再写 `claimStatus`：
            //    两处声明同一实现会漂移）。
            fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
            /**
             * ⚠️ **必须开启状态预检**（`precheckStatus` 缺省 true，不要传 false）。
             *
             * 理由与 TRAE 同型：`claimMinimaxDailyCheckin` 靠响应体的 `claim_result`
             * 判幂等（`1`=真领取、`2`=已领过），这在 **HTTP 层**是可靠的；但状态预检是
             * 第二道防线 —— 若某天服务端对已领账号也回 `claim_result: 1`，预检能靠
             * `todayCheckedIn` 先挡住，避免把「今天已领」报成「+积分」。
             * 反之传 false 会让已签到账号走到 claim 请求（多发一次 POST）。
             */
            claim: (credential) => claimMinimaxDailyCheckin(credential),
        },
        /**
         * Gemini：余额 = **配额窗口**（不是充值积分），两个桶的剩余比例。
         * 「未授权」与「查询失败」是两回事，故用带原因的形态。
         *
         * ⚠️ 账号规格（Pro / Free / Ultra）搭这趟车回来：`loadCodeAssist` 与配额
         * 是同一函数里**并行**发的两个端点，档位挂在 `result.tier` 上。这里翻译成
         * 面板要的 `extra.accountTier` —— `label` 是短标签（面板只放得下一个词），
         * `title` 是上游原文（hover 才看得到）。取不到时 `extra` 缺席，
         * 面板不渲染那一行（**不是错误**）。
         */
        gemini: {
            fetchBalanceDetailed: async (credential) => {
                const { balance, error, tier } = await fetchGeminiCreditBalance(credential, GEMINI);
                const extra = tier === undefined
                    ? undefined
                    : { accountTier: { label: tier.label, title: `${tier.name}（${tier.id}）` } };
                return {
                    balance,
                    ...error === undefined ? {} : { error },
                    ...extra === undefined ? {} : { extra },
                };
            },
        },
        buddy: {
            fetchBalance: (credential) => fetchCreditBalance(credential, CODEBUDDY),
            fetchStatus: (credential) => fetchCheckinStatus(credential, CODEBUDDY),
            // 预检与面板读数是同一个端点 ⇒ 只声明 `fetchStatus`（端点回落到它），
            // 不再写一份 `claimStatus`（两处声明同一实现必然漂移）。
            claim: (credential) => claimDailyCheckin(credential, CODEBUDDY),
            /**
             * ⚠️ **成长中心（22 项任务）的唯一入口** —— 只有 CodeBuddy 中国版提供。
             *
             * ⚠️ 产品配置由**本闭包捕获**（`CODEBUDDY`），不从调用侧转发：通用分支
             * 拿不到 product（它传 `undefined`），转发过去就是
             * `collectBuddyGrowth(credential, undefined, …)`，成长中心当场打坏。
             *
             * ⚠️ `workbuddy`（国际版）**刻意不提供**：contributor 在 !62 复审中实测确认
             * `www.workbuddy.ai` 后端**根本没有成长中心**（无任务列表、无 claim 端点）。
             */
            afterClaim: (credential, entry, run) => collectBuddyGrowth(credential, CODEBUDDY, entry, run.budgetMs, run.roundDeadlineAt),
        },
        workbuddy: {
            fetchBalance: (credential) => fetchCreditBalance(credential, WORKBUDDY),
            // ⚠️ 国际版**没有签到接口**，但**状态端点**与余额一样存在（两个产品通用），
            // 故这里注册 fetchStatus。真正禁止的是 `claimAll`（那由能力表与
            // `credits.claimAll` 的显式守卫成对拦住）。
            fetchStatus: (credential) => fetchCheckinStatus(credential, WORKBUDDY),
            /**
             * ⚠️ **这条守卫是载荷性的，必须有**：没有它时 `workbuddy` 会落到
             * `credits.claimAll` 的通用分支，用**国际版**凭据去发**国内版**的签到
             * 请求 —— 必然失败，而且是一次**真实的上游请求**。而「每日首次启动自动
             * 签到」（`src/auto-checkin.ts`）正是靠「调 `claimAll`、按返回的信封判
             * 跳过」来决定遍历范围的，它**不维护第二份能力名单** ⇒ 这里漏一个守卫，
             * 它就会真去发一轮必然失败的请求。
             */
            claimUnavailableReason: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
        },
    };
}
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export function creditsOf(table, provider) {
    if (!Object.hasOwn(table, provider))
        return undefined;
    return table[provider];
}
//# sourceMappingURL=provider-credits.js.map