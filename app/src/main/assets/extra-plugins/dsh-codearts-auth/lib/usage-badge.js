/**
 * 用量徽标的**宿主侧读数**：把「当前渠道还剩多少」折算成一次 RPC 就能画完的快照。
 *
 * ## 为什么需要一个新端点，而不是让客户端直接调 `credits.balances`
 *
 * 徽标挂在会话输入区，**每分钟轮询一次**（见客户端 `usage-badge.js`），而
 * `credits.balances` 是**逐账号顺序打上游**的（`collectCreditBalances` 的
 * 「顺序查询，避免并发触发风控」）。若客户端直连它：
 *
 * - 每轮轮询 × 账号数 = 上游请求数（5 个号就是每 5 分钟 5 次，多开几个会话再翻倍）；
 * - 设置页那两个按钮的读数与徽标**各拉各的**，同一时刻可能显示不同的数字。
 *
 * 本模块做的事很少，但每件都是必需的：
 * 1. **复用** `credits.balances` 的实现（由装配层注入，见 `jet-hub-rpc.ts`），
 *    不复制任何 provider 分支 —— 否则两套口径必然漂移；
 * 2. **只保留启用账号**，并给出 `disabledCount`（停用账号不该进合计）；
 * 3. 附加**订阅读数**（窗口 / 套餐，判定在 `badge-subscription.ts`）；
 * 4. 每个渠道一份 **TTL 缓存 + 在飞去重**（`TtlCache`）：
 *    成功缓存久、**全部失败缓存短** —— 后者是为了让用户修好凭据后不必干等，
 *    口径与 `buddy-balance-selector.ts` 的「成功 60s / 失败 5s」同源。
 *
 * ## ⚠️ 失败与「读数为 0」必须分开
 *
 * 本模块**不吞**任何失败：单账号失败照原样留在 `accounts[].error` 里（UI 显示
 * 原因而不是 0）；整批失败（如渠道不支持、`credits.balances` 返回 bad-request）
 * 则以 `{ ok: false }` 原样上抛给 RPC 层。把失败画成 0 会让用户以为额度被清空
 * —— 那是本仓库反复记录过的缺陷形态。
 */
import { TtlCache } from './ttl-cache.js';
import { badgePlanFor, badgePlanSelectorFor } from './badge-subscription.js';
/** 徽标读数的缓存时长（毫秒）；`DSH_JET_HUB_BADGE_TTL_MS` 可覆盖。 */
export const DSH_JET_HUB_BADGE_TTL_MS = 'DSH_JET_HUB_BADGE_TTL_MS';
/**
 * 默认缓存时长：**120 秒**。
 *
 * 取值依据：客户端 60s 轮询一次 ⇒ 每两轮只有一轮真的打上游；一次读取最坏是
 * 「账号数 × 一次 HTTP」，120s 对配额与风控都可接受，而读数的新鲜度对
 * 「现在该不该用这个模型」这个决策仍然够用（手动刷新可随时绕过）。
 */
export const BADGE_TTL_MS = 120_000;
/**
 * **全部账号都失败**时的缓存时长：15 秒。
 *
 * 与成功分开的理由：失败通常来自凭据过期 / 网络抖动，用户往往立刻去修；
 * 若沿用 120s，修好之后徽标还会继续显示「用量不可用」最长两分钟，
 * 看起来像「修复无效」。
 */
export const BADGE_FAILURE_TTL_MS = 15_000;
/**
 * 读取缓存时长。
 *
 * ⚠️ **不能写成 `Number(raw) || 默认值`**：`0` 是合法值（表示「不缓存、每次都
 * 重新读」），而 `0` 是 falsy 会被 `||` 静默换成默认值 —— 与本仓库
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` / `DSH_QODER_QUEUE_TIMEOUT_MS` 同一个坑。
 */
export function badgeTtlMs(env = process.env) {
    return nonNegativeMs(env[DSH_JET_HUB_BADGE_TTL_MS], BADGE_TTL_MS);
}
/** 读取失败缓存时长（口径同上）。 */
export function badgeFailureTtlMs(env = process.env) {
    return nonNegativeMs(env[DSH_JET_HUB_BADGE_TTL_MS], BADGE_FAILURE_TTL_MS);
}
/** 非负毫秒数：非法值（空 / 非数字 / 负数）回落到默认值。 */
function nonNegativeMs(raw, fallback) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return fallback;
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
/** 内部用：把 RPC 信封里的失败变成异常，好让 `TtlCache` 的「失败不缓存」生效。 */
class BadgeRpcFailure extends Error {
    detail;
    constructor(detail) {
        super(detail.message);
        this.detail = detail;
        this.name = 'BadgeRpcFailure';
    }
}
/** 创建徽标读数服务（每个插件实例一份，内部按渠道各持一个缓存）。 */
export function createUsageBadge(deps) {
    const now = deps.now ?? (() => Date.now());
    const ttlMs = deps.ttlMs ?? badgeTtlMs();
    const failureTtlMs = deps.failureTtlMs ?? badgeFailureTtlMs();
    const caches = new Map();
    /**
     * 该渠道的缓存实例。
     *
     * 懒建而不是预建 12 个：只有用户真的选中某个渠道的模型时才会有第一次读取。
     */
    function cacheFor(provider) {
        const existing = caches.get(provider);
        if (existing !== undefined)
            return existing;
        const created = new TtlCache({
            ttlMs,
            ttlFor: (snapshot) => (isAllFailed(snapshot) ? failureTtlMs : ttlMs),
            now,
            load: () => loadSnapshot(provider),
        });
        caches.set(provider, created);
        return created;
    }
    /** 读取并折算一份快照（缓存未命中时才会被调用；抛错即「失败不缓存」）。 */
    async function loadSnapshot(provider) {
        const balances = await deps.collectBalances(provider);
        if (!balances.ok)
            throw new BadgeRpcFailure(balances.error);
        // 只保留**启用**账号：判据与 `provider.status` 一致（`enabled !== false`，
        // 老文档缺该字段时语义等同启用）。停用账号既不进合计，也不该被渲染明细。
        const pool = deps.listAccounts(provider);
        const enabledIds = new Set(pool.filter((entry) => entry.enabled !== false).map((entry) => entry.id));
        const accounts = balances.value.accounts.filter((row) => enabledIds.has(row.accountId));
        const snapshot = {
            at: now(),
            accounts,
            disabledCount: pool.length - enabledIds.size,
            ...balances.value.windowDays === undefined ? {} : { windowDays: balances.value.windowDays },
        };
        const subscription = await subscriptionOf(provider, enabledIds, accounts);
        if (subscription !== undefined)
            snapshot.subscription = subscription;
        return snapshot;
    }
    /**
     * 订阅读数：先试**窗口**（Cline 的 5 小时 / 周 / 月），再试**套餐包**。
     *
     * ⚠️ 订阅查询失败**只让订阅缺席**，绝不连坐余额 —— 余额与订阅是两个独立的上游
     * 端点，把两者绑死会让「网关的额度接口挂了」显示成「这个渠道查不到余额」。
     *
     * @param accounts - **本次刚取回**的余额行（已过滤为启用账号）：套餐折算直接
     *   用它，不额外发请求，也不引入任何跨次缓存。
     */
    async function subscriptionOf(provider, enabledIds, accounts) {
        if (deps.collectQuota !== undefined) {
            try {
                const quota = await deps.collectQuota(provider);
                if (quota !== undefined) {
                    if (!quota.ok) {
                        deps.warn?.(`[jet-hub] 用量徽标：${provider} 的订阅窗口读取失败（不影响余额）：${quota.error.message}`);
                        return undefined;
                    }
                    return {
                        kind: 'windows',
                        // 与余额同一口径：只列启用账号（订阅接口自己的账号列表含停用账号）。
                        accounts: quota.value.accounts.filter((row) => enabledIds.has(row.accountId)),
                    };
                }
            }
            catch (error) {
                deps.warn?.(`[jet-hub] 用量徽标：${provider} 的订阅窗口读取抛错（不影响余额）：${String(error)}`);
                return undefined;
            }
        }
        if (badgePlanSelectorFor(provider) === undefined)
            return undefined;
        // 这里只做「折算」，判定表在 `badge-subscription.ts`：本模块不认识任何具体渠道。
        const rows = accounts.map((row) => ({
            accountId: row.accountId,
            nickname: row.nickname,
            plan: badgePlanFor(provider, row.balance),
            ...row.error === undefined ? {} : { error: row.error },
        }));
        return rows.some((row) => row.plan !== null) ? { kind: 'plan', accounts: rows } : undefined;
    }
    return {
        async read(provider, options = {}) {
            const cache = cacheFor(provider);
            const force = options.force === true;
            // 「这一轮是不是吃的缓存」必须在 `get()` **之前**问：`get()` 命中时不会
            // 更新任何时间戳，命中与否只能靠 peek 的结果判断。
            const hit = force ? undefined : cache.peek();
            let snapshot;
            try {
                snapshot = await cache.get(force ? { force: true } : {});
            }
            catch (error) {
                if (error instanceof BadgeRpcFailure)
                    return { ok: false, error: error.detail };
                throw error;
            }
            return {
                ok: true,
                value: {
                    provider,
                    generatedAt: snapshot.at,
                    cached: hit !== undefined,
                    accounts: snapshot.accounts,
                    disabledCount: snapshot.disabledCount,
                    ...snapshot.windowDays === undefined ? {} : { windowDays: snapshot.windowDays },
                    ...snapshot.subscription === undefined ? {} : { subscription: snapshot.subscription },
                    // 偏好**不进缓存**：它是用户随时可改的展示设置，缓存住会让「刚改完
                    // 没生效」看起来像 bug（快照本身可能还是两分钟前的）。
                    preference: deps.readPreference(),
                    // 同理不进缓存：后台任务的进度与「今天已跑」都要实时反映到状态灯上。
                    autoCheckin: deps.readAutoCheckin(),
                },
            };
        },
        clear() {
            for (const cache of caches.values())
                cache.clear();
            caches.clear();
        },
    };
}
/**
 * 「这一份读数是不是整批失败」。
 *
 * ⚠️ 两个边界都要顾：
 * - **没有启用账号**（`accounts` 为空）不算失败 —— 那是稳定状态（用户就是没配
 *   账号），沿用短 TTL 会让徽标每分钟都去问一次同样的答案；
 * - 只要**有一个**账号读到数，就算成功 —— 多账号下「一个号凭据过期」是常态，
 *   剩下那个号读数是有效的，不该被短 TTL 拖着反复重试。
 */
function isAllFailed(snapshot) {
    return snapshot.accounts.length > 0 && snapshot.accounts.every((row) => row.error !== undefined);
}
//# sourceMappingURL=usage-badge.js.map