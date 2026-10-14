/**
 * 各 provider 的**一次性奖励能力实现表** —— `ProviderRuntime.onboarding` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`onboarding.status` / `onboarding.claim` 各自是一段
 * `if (req.provider === LOOMY.id) … else if (req.provider === RACCOON.id) …`，
 * 两处**各写一遍**同样的 provider 分派、同样的「凭据未配置 / 账号不存在」守卫。
 * 那些分支体里**没有一行协议逻辑**（协议早已封装在 `loomy-onboarding.ts` 与
 * `raccoon-credits.ts` 内），RPC 层看到的只是「选哪个函数」。
 *
 * ## ⚠️ 与 `credits` 域的边界（**别把两者合并**）
 *
 * | 域 | 语义 | 频率 |
 * |---|---|---|
 * | `credits` | **每日**签到（每天都有收益） | 每天 |
 * | `onboarding` | **一次性**新手任务 / 登录奖励（每号只能领一次） | 一次 |
 *
 * 两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」——
 * 那正是本仓库记录过的「一份语义两套判据」形态。
 *
 * ## ⚠️ 为什么返回类型直接用 RPC 响应的形状
 *
 * `RpcOnboardingStatusResponse` / `RpcOnboardingClaimResponse` 与 provider 数量
 * 无关（`tasks` / `earned` / `total` / `titles` / `points` 是**所有**一次性奖励的
 * 公共字段），且 `raccoon` 的「已领时 `earned` 报满分」这条语义**只有在这个形状上**
 * 才表达得出来 —— 压成 `ClaimOutcome` 会丢掉它（见 `ProviderOnboarding.claim`）。
 * 与 `ProviderBalanceDetail` 复用 `CreditsEndpointDeps` 的形状同款理由。
 */
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES, claimAllLoomyOnboardingTasks, fetchLoomyOnboardingTasks } from './loomy-onboarding.js';
import { LOOMY } from './loomy-product.js';
import { RACCOON } from './raccoon-product.js';
import { claimRaccoonLoginReward, fetchRaccoonOnboardingStatus } from './raccoon-credits.js';
/**
 * 构造「id → 一次性奖励能力」的表。
 *
 * ⚠️ 只覆盖**真有**一次性奖励的渠道（与 `PROVIDER_REGISTRY` 的
 * `credits.onboardingTasks` 声明一致）：目前是 `loomy` 与 `raccoon`。
 */
export function createProviderOnboarding(deps = {}) {
    return {
        /**
         * Loomy 新手任务（8 项，合计 10000 分，**一次性**）。
         *
         * ⚠️ 优先走**实例方法**（实例可能带注入的 `fetchImpl`）。
         * ⚠️ 判**方法存在**而不是 `deps.loomy !== undefined`：调用方常常只持有
         *    一个部分替身（单测的 `{}` 桩），用 `!== undefined` 会走进
         *    `undefined is not a function` 并被吞成一条笼统错误 —— 那正是
         *    「静默降级」的形态。判方法则如实回退到自由函数。
         */
        loomy: {
            status: async (credential) => {
                const loomyCredential = credential;
                const viaInstance = deps.loomy?.fetchOnboardingTasks;
                const state = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.loomy, loomyCredential)
                    : await fetchLoomyOnboardingTasks(loomyCredential, LOOMY);
                return {
                    tasks: state.tasks,
                    earned: state.earned,
                    total: state.total,
                    // ⚠️ 标题与分值表来自**共享常量**（`loomy-onboarding.ts`），
                    //    不在这里另抄一份：抄一份就会与 claim 侧漂移。
                    titles: { ...LOOMY_TASK_TITLES },
                    points: { ...LOOMY_TASK_POINTS },
                };
            },
            claim: async (credential) => {
                const loomyCredential = credential;
                const viaInstance = deps.loomy?.claimOnboardingTasks;
                const result = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.loomy, loomyCredential)
                    : await claimAllLoomyOnboardingTasks(loomyCredential, LOOMY);
                return {
                    claimed: result.claimed.map((item) => ({
                        key: item.key,
                        // ⚠️ 标题缺失时回落 key（**不是**空串）：前端按 key 渲染清单，
                        //    空标题会渲染出一个看不见的条目。
                        title: LOOMY_TASK_TITLES[item.key] ?? item.key,
                        points: item.points,
                    })),
                    skipped: result.skipped,
                    earned: result.earned,
                    total: result.total,
                };
            },
        },
        /**
         * Raccoon 桌面端登录奖励（3000 分，**幂等一次性**）。
         *
         * ⚠️ raccoon 只有**一项**一次性奖励，把它映射成 Loomy 那套「任务」形状的一项，
         * 复用同一个 RPC 与 UI（`desktop_login_reward` 是**契约键**，前端按它取值）。
         *
         * ⚠️ 已领状态靠**账单反查**（服务端没有单独的状态端点）。
         */
        raccoon: {
            status: async (credential) => {
                const raccoonCredential = credential;
                const viaInstance = deps.raccoon?.fetchOnboardingStatus;
                const status = typeof viaInstance === 'function'
                    ? await viaInstance.call(deps.raccoon, raccoonCredential)
                    : await fetchRaccoonOnboardingStatus(RACCOON, raccoonCredential);
                return {
                    // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
                    tasks: { desktop_login_reward: status.claimed },
                    earned: status.claimed ? status.points : 0,
                    total: status.points,
                    titles: { desktop_login_reward: '桌面端登录奖励（每号一次）' },
                    points: { desktop_login_reward: status.points },
                };
            },
            /**
             * ## ⚠️ **已领时 `earned` 必须报满分，不是 0**（真实缺陷，用户报障）
             *
             * `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」无关。
             * 早期在 `already-claimed` 分支写 `earned: 0`，于是 UI 显示
             * 「✅ 1 个此前已完成 / 累计已领 **0** / 3000」—— **自相矛盾**：
             * 既然「此前已完成」，那 3000 分显然已经拿到手了。
             *
             * ⚠️ 且已领时的金额必须从**账单反查**取得（领取响应体里没有它），
             * 与 `status` 同一数据源 —— 否则两处会显示不同的数字
             *（例如活动金额变化后，一处 3000、一处 3500）。
             * 只读 GET，且仅在「点按钮时已领」这一低频路径上发生。
             */
            claim: async (credential) => {
                const raccoonCredential = credential;
                // raccoon 的领取端点是**幂等**的：已领过返回 `granted:false`，
                // 此时 claimed 为空数组、skipped 含该项。
                const viaClaim = deps.raccoon?.claimLoginReward;
                const outcome = typeof viaClaim === 'function'
                    ? await viaClaim.call(deps.raccoon, raccoonCredential)
                    : await claimRaccoonLoginReward(RACCOON, raccoonCredential);
                if (outcome.kind === 'failed') {
                    // ⚠️ 失败必须上抛给端点转成 `ok:false`，**不能**在这里包成一条
                    //    「成功但没领到」的响应（那会让用户以为领过了）。
                    throw new Error(outcome.message);
                }
                const claimed = outcome.kind === 'claimed'
                    ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
                    : [];
                const points = outcome.kind === 'claimed'
                    ? outcome.credit
                    : (typeof deps.raccoon?.fetchOnboardingStatus === 'function'
                        ? await deps.raccoon.fetchOnboardingStatus.call(deps.raccoon, raccoonCredential)
                        : await fetchRaccoonOnboardingStatus(RACCOON, raccoonCredential)).points;
                return {
                    claimed,
                    skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
                    // 该项目累计已领 = 满分（无论本次是否新增）。
                    earned: points,
                    total: points,
                };
            },
        },
    };
}
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `authOf` 同因。
 */
export function onboardingOf(table, provider) {
    if (!Object.hasOwn(table, provider))
        return undefined;
    return table[provider];
}
//# sourceMappingURL=provider-onboarding.js.map