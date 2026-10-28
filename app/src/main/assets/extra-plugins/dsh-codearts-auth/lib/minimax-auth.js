/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { refreshAccountWithReconcile, syncAccountExpiry, } from './expiry-sync.js';
import { MINIMAX, MINIMAX_MODELS_PATH, MINIMAX_REQUEST_TIMEOUT_MS, } from './minimax-product.js';
import { fetchMinimaxUserIdentity } from './minimax-identity.js';
import { appendMinimaxJournal } from './minimax-refresh-journal.js';
import { isTerminalRefreshFailure } from './refresh-failure.js';
import { inheritMinimaxIdentity, fallbackToEntry, isMinimaxRefreshable, minimaxCredentialExpiresAtMs, describeMinimaxGeoRoute, minimaxFetch, minimaxHeadersFor, normalizeMinimaxModel, } from './minimax.js';
import { pollMinimaxDeviceToken, refreshMinimaxCredential, startMinimaxDeviceAuthorization, fetchMinimaxForcedLoginUrl, } from './minimax-oauth.js';
/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export const MINIMAX_EXPIRY_ACCESSORS = {
    expiresAtOf: (credential) => minimaxCredentialExpiresAtMs(credential),
    refreshableOf: (credential) => isMinimaxRefreshable(credential),
    identityOf: (credential) => credential.access_token,
};
/** refresh_token 已失效，需要重新登录。 */
export class MinimaxRefreshTokenExpiredError extends Error {
    constructor(message) {
        super(message);
        // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（真实缺陷，2026-09-29 修正）。
        //
        // `src/refresh.ts` 的终态判据是结构化比较：
        //   `if (error.name === 'RefreshTokenExpiredError') return true`
        //   `return /refresh[_ ]?token/i.test(error.message)`
        //
        // 早期这里写 `'MinimaxRefreshTokenExpiredError'` ⇒ 第一个分支**恒不命中**，
        // 只能靠第二个分支的**文案正则**兜底。而 `refresh()` 里
        // 「凭据未配置，请先登录」不含 `refresh_token` ⇒ 一旦走到那里，
        // `RefreshScheduler` 会把它当成**可重试**错误而**无限重试**。
        // 文案一改即静默退化，极难排查。
        //
        // 八个既有 provider 的同类类**一律**用 `'RefreshTokenExpiredError'`
        // （`cline-auth.ts`、`qoder-auth.ts`、`lobsterai-auth.ts`、
        // `loomy-auth.ts`、`raccoon-auth.ts`、`trae-auth.ts`、
        // `buddy-oauth.ts`、`oauth.ts`）—— 本 provider 不应破例。
        // 之所以能跨模块这样判，是因为判据是**字符串**而非 `instanceof`
        //（各模块的同名类是不同 identity，`instanceof` 会穿透）。
        this.name = 'RefreshTokenExpiredError';
    }
}
/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseMinimaxCredential(value) {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null
            && typeof parsed.access_token === 'string' && parsed.access_token.length > 0
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
// ===== 2026-10-24 本地试验版：续期机制重构的常量 =====
//
// 设计依据（三方源码交叉审计的结论）：
// - **官方** `MiniMax-AI/minimax-code` 的 `oauth-core` 是**纯按需刷新**
//   （`getAccessToken({minValidityMs:30_000})`），没有任何定时轮换器；
// - 本插件旧形态是 30min tick + 1h lead + TTL≈1h ⇒ **每个 tick 都对每个
//   可续期账号发起轮换（~48 次/天/账号）**，且批量顺序执行使全部账号的
//   过期时刻焊死在同一秒窗内 —— 一次系统性失败（断网/上游抖动/关机跨窗）
//   必然**全池同时阵亡**，正是「一失效就是一大片」的结构性根因。
//
// ⇒ 新形态：定时器只**对账**（reconcile-only），轮换交给
//   ① 本类 60s 专属巡检（{@link startRenewPatrol}，margin 5min + 按账号散列
//   的 0-10min 抖动 ⇒ 各账号续期时刻天然错开）；
//   ② 请求路径兜底（adapter 预判 + 401 强刷，走 `refreshAccountCredential`）。
//   轮换纪律照抄官方/dsh-minimax-connect：单飞、CAS 落盘、失败重试一次、
//   旧代际 RT 回退抢救、全量 journal。
/** 巡检提前量：距过期不足 5 分钟才发续期请求（dsh-minimax-connect 生产验证值）。 */
const MINIMAX_RENEW_MARGIN_MS = 5 * 60_000;
/** 按账号散列的额外提前量跨度（0-10min）：把各账号的续期时刻散开，错峰。 */
const MINIMAX_RENEW_JITTER_SPAN_MS = 10 * 60_000;
/** 巡检间隔（60s）：比 margin 细一档，保证窗口不会被整段跳过。 */
const MINIMAX_RENEW_PATROL_INTERVAL_MS = 60_000;
/** 非终态失败（网络抖动）后的同 RT 重试间隔。 */
const MINIMAX_RENEW_RETRY_DELAY_MS = 1_500;
/** 历史代际 refresh_token 保留条数（新→旧，**不含当前值**）。 */
const MINIMAX_PREVIOUS_REFRESH_TOKENS = 3;
/**
 * 判明「这把 RT 已死」之后的**冷却窗口**（30 分钟）。
 *
 * ⚠️ 存在的理由（2026-10-27 第二轮审计打穿）：巡检**不按 RT 是否已知失效过滤**
 * ⇒ 死号会被每 60s 重打一次，配上 `grantWithSalvage` 的最多 3 代历史
 * ⇒ 实测 **5 分钟 20 次上游请求**。而「重试一把**确定**已死的 RT」在一次性
 * 轮换语义下**不可能成功**，纯属无效流量。
 *
 * ⚠️ 取 30 分钟的理由：与全局调度器的检查粒度同量级（`REFRESH_INTERVAL_MS`），
 *    既压住无效流量，又能在用户重新登录前留出合理的重试机会。
 * ⚠️ 冷却**只在网络层跳过**（不阻止本地对账），且**凭据一变立即清除**
 *    （用户重新登录 / 面板刷新写新凭据后马上恢复，不会把人锁死）。
 */
const MINIMAX_TERMINAL_COOLDOWN_MS = 30 * 60_000;
/**
 * 按账号 id 算一个**确定性**的续期抖动（0 ≤ x < span）。
 *
 * ⚠️ 必须确定性（不能每次随机）：同一条账号的续期时刻要在**周期之间稳定**，
 * 否则「错峰」退化为「洗牌」。djb2 足够 —— 这里不需要密码学强度。
 *
 * ⚠️ **导出仅供测试**（2026-10-27 审计修）：本函数是「拆掉全池同秒过期」的
 * **唯一机制**，而修前它在 `tests/` 下**零命中** —— 把它改成 `() => 0`
 * 全量测试**一个字都不变**（实测）。导出让守卫能直接打它的取值域与确定性。
 */
export function renewJitterMs(accountId, spanMs) {
    // ⚠️ `span <= 0` ⇒ 恒 0：`% 0` 是 `NaN`，而 `NaN` 会让续期阈值变成 `NaN`
    //    ⇒ `expiresAt - now > NaN` 恒 `false` ⇒ **每轮都续**（把巡检退化成
    //    30s 一次的全量轮换）。这是「零除」在定时判据里的真实后果。
    if (!Number.isFinite(spanMs) || spanMs <= 0)
        return 0;
    let hash = 5381;
    for (let i = 0; i < accountId.length; i++) {
        hash = ((hash << 5) + hash + accountId.charCodeAt(i)) | 0;
    }
    // ⚠️ `Math.abs` 对 `-2147483648` 仍是负数（`|0` 的边界）⇒ 再 `>>> 0` 归一，
    //    否则该 id 的抖动会变成**负值**（续期阈值反而变小，错峰方向翻转）。
    //    ⚠️ 实测（2026-10-27 第二轮审计）：对 4000 个真实形态 id，本式与修前的
    //    `Math.abs(hash) % spanMs` **逐值相同（差 0 个）** ⇒ 这是一条**纯防御性
    //    冗余**，不改变任何已有取值、不会让存量账号改期。别误以为它修了真 bug。
    return (Math.abs(hash) >>> 0) % spanMs;
}
/**
 * 判一条错误是不是「refresh_token 已死」的终态。
 *
 * ⚠️⚠️ **判据已收口到共享实现 `src/refresh-failure.ts`**（2026-10-27 审计修）。
 *
 * 修前是 `return /invalid_grant|expired|revoked/i.test(message)` —— 与
 * `autoclaw-auth.ts` 逐字同形的第二份实现，且三处实测把**健康账号**判死：
 *
 * | 上游报文 | 修前 | 后果 |
 * |---|---|---|
 * | `HTTP 503 {"error":"token expired"}` | 终态 | 网关抖动一次 = 账号需重登 |
 * | `HTTP 429 {"error":"rate limited, key expired soon"}` | 终态 | 限流一次 = 账号需重登 |
 * | `fetch failed`（cause: `certificate has expired`） | 终态 | 证书/代理抖动 = 账号需重登 |
 *
 * 而池里的 `refreshable:false` 是**单向门**（`refreshAll` 与巡检都会 `continue`），
 * 一旦误标就**永不自愈** —— 用户看到的就是「要一个个点回来」。
 *
 * ⇒ 现在：先排传输层（`certificate has expired` 在这一步被吃掉），再看 HTTP
 *    状态码（5xx/429/408/401 一律非终态），最后只认结构化的 `invalid_grant`。
 *    判据的完整理由与三条实测见 `refresh-failure.ts` 的模块头。
 */
function isTerminalRefreshError(error) {
    return isTerminalRefreshFailure(error);
}
/**
 * 合并「历史代际 refresh_token」栈（**新→旧**、去重、截断到上限）。
 *
 * ## 为什么需要它（2026-10-27 审计修）
 *
 * 两个写入点要**同一口径**：
 * - `grantOnce`（每次成功续期时把用掉的旧 RT 压栈）；
 * - `renewEntryInner` 的 CAS 分支（丢弃本次结果时，把**本次新拿到的** RT 也补进去，
 *   否则那把在上游已轮换的钥匙就永久消失 —— 见该处的长注释）。
 *
 * 收成一份纯函数是为了不让「同义判据两份实现」再次发生（本仓库红线）。
 *
 * @param existing 已有的历史栈（新→旧）。
 * @param incoming 要压入的候选（按重要性从高到低；重复的自动丢弃）。
 * @returns 合并后的栈；**没有任何有效项时返回 `undefined`**（调用方据此跳过写盘）。
 */
function mergePreviousRefreshTokens(existing, ...incoming) {
    const merged = [];
    for (const token of [...incoming, ...(existing ?? [])]) {
        if (typeof token !== 'string' || token.length === 0)
            continue;
        if (merged.includes(token))
            continue;
        merged.push(token);
        if (merged.length >= MINIMAX_PREVIOUS_REFRESH_TOKENS)
            break;
    }
    return merged.length === 0 ? undefined : merged;
}
/** MiniMax Code 认证服务。 */
export class MinimaxAuth extends Service {
    options;
    /** 本实例所属的产品配置。 */
    product;
    /** 本实例默认读写的凭据 ref 名称。 */
    credentialRefName;
    lastRefreshError;
    /**
     * 每 ref **单飞**闸门：巡检 / 请求路径 / 401 强刷可能同时想续同一个账号，
     * 并发轮换同一 RT = 双方都在用一把正在被作废的钥匙（轮换式令牌的
     * 致命竞态）。同 ref 的并发调用都等同一份 Promise。
     * ⚠️ 值类型放宽为 `unknown`：`refreshAccountCredential`（lead-aware 流程）
     * 与 `renewEntry`（margin 流程）的返回形状不同，汇合方各自解读。
     */
    renewInFlight = new Map();
    /** 60s 专属巡检定时器（{@link startRenewPatrol}；重复调用幂等）。 */
    patrolTimer;
    /** 巡检防重入：一轮没跑完时跳过本轮（refreshAllCredentials 级别的教训）。 */
    patrolBusy = false;
    /**
     * 巡检是否已被显式停止（{@link stopRenewPatrol}）。
     *
     * ⚠️ 与 `patrolTimer === undefined` **不是**同一件事：定时器可以被清掉，
     * 而**在飞的那一轮**（可能正卡在某个 `await grant` 上）仍会继续往下跑。
     * 本标志让它在下一个账号之前退出，避免「已卸载的实例继续轮换一次性 RT」。
     */
    patrolStopped = false;
    /**
     * 判明「RT 已死」后的**冷却截止时刻**（key = 凭据 ref 名）。
     *
     * ⚠️ 见 {@link MINIMAX_TERMINAL_COOLDOWN_MS} 的 doc：压住「对确定已死的 RT
     * 每 60s 重打 + 试 3 代历史」的无效流量（实测 5 分钟 20 次上游请求）。
     * ⚠️ **凭据一变立即清除**（在 {@link renewEntryInner} 里比较当前 RT 与
     * 冷却时记下的那把），保证「重新登录即可立刻恢复」。
     */
    terminalCooldownUntil = new Map();
    /** 冷却时记下的那把 RT（用于「凭据一变即解除冷却」的判据）。 */
    terminalCooldownToken = new Map();
    /** journal 落盘根目录（`journalHome` 选项；undefined = 不写，见模块注释）。 */
    journalHome;
    constructor(ctx, options = {}) {
        const product = options.product ?? MINIMAX;
        super(ctx, options.serviceName ?? `${product.id}Auth`);
        this.options = options;
        this.product = product;
        this.credentialRefName = product.defaultCredentialRef;
        this.journalHome = options.journalHome;
    }
    get fetchImpl() {
        return this.options.fetchImpl ?? fetch;
    }
    /**
     * 取**某个账号**该走的 fetcher（MiniMax 国际站代理支持）。
     *
     * ⚠️⚠️ **必须按账号现取，不能在构造/循环外固化**：本类在一轮流程里可能换号
     * （目录取号走 `getAvailableAccount`、续期按 ref 逐个走），出口必须跟着换 ——
     * 固化一份会让「换了号却仍走旧账号的出口」，症状是「配了代理还是被分流」
     * 且**零报错**，属最难查的一类静默失效。
     *
     * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
     * 全局 `fetch`。未注入 `fetchFor`（中国站实例 / 旧接线）⇒ 恒走既有路径，
     * **行为逐字节不变**。
     *
     * ⚠️ 空账号 id（`''`）= 直连：`fetchFor` 的解析器按「空 id = 没配代理」处理
     * （见 `minimax-proxy.ts`）—— 拿不到账号时不该去查一个空 id。
     */
    fetcherFor(accountId) {
        if (this.options.fetchImpl !== undefined)
            return this.options.fetchImpl;
        if (this.options.fetchFor !== undefined)
            return this.options.fetchFor(accountId);
        return fetch;
    }
    /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
    async fetchDeviceAuthorization(accountId) {
        return startMinimaxDeviceAuthorization(this.fetcherFor(accountId ?? ''), this.product);
    }
    /**
     * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
     *
     * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
     * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
     *
     * @param options.accountId 本次登录**将要落在哪个账号条目上**（可选）。
     *
     * ## ⚠️⚠️ 为什么登录也必须知道账号 id（换 token 的那一步要出海）
     *
     * 设备码申请与轮询换 token 都发生在**凭据落盘之前**，此时凭据还在内存里、
     * 账号池里也**只有那条占位条目**认得这个账号 ⇒ 代理只能按 `accountId`
     * 从池里读（`minimaxIntlProxy`）。不带 ⇒ 国际站在大陆网络下**登录恒失败**，
     * 而用户**没法给一个还不存在的账号配代理**（面板的「代理」按钮按
     * `accountId` 打开）⇒ **死锁**（与 Gemini 的 IKLTZ2 审计 P2-1 同型）。
     *
     * 触发路径很常见：refresh_token 失效时面板明示的既定动作就是「删号重登」，
     * 而重登造的是**全新 id** ⇒ 旧号上的代理配置必然丢失。
     *
     * ⚠️ 不传时是空串 = 直连，与既有行为**逐字节一致**（`fetcherFor('')`）。
     */
    async startLogin(options = {}) {
        const auth = await this.fetchDeviceAuthorization(options.accountId);
        let aborted = false;
        const controller = new AbortController();
        const result = pollMinimaxDeviceToken(auth, {
            fetcher: this.fetcherFor(options.accountId ?? ''),
            ...this.options.sleep === undefined ? {} : { sleep: this.options.sleep },
            signal: controller.signal,
            product: this.product,
        });
        // 与 `cline-auth.ts` 同理：结果可能早于调用方 `await` 而落定，
        // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
        //
        // ⚠️ 本例**必然**会走到这里：`close()` → `controller.abort()` →
        // `pollMinimaxDeviceToken` 里的 `options.signal?.throwIfAborted()`
        // 会 reject（用户关掉登录弹窗就是这条路径）。缺这一句时，
        // 若调用方在 `await result` 之前就放弃，Node 会报 `unhandledRejection`。
        result.catch(() => { });
        /**
         * ⚠️⚠️ 2026-10-24：**额外**去换一条「保证需要登录」的链接。
         *
         * 用户报障：「登录链接一打开就自带旧 session 登录态」。`loginUrl` 的
         * `user_code` 不含身份、身份全在浏览器 cookie；上游不认 `prompt=*`，
         * 但它的「切换账号」按钮走 `/oauth2/device/authorize`（无 cookie ⇒
         * `401 login_required` + `login_url`）⇒ 服务端已替我们拼好「登录完回到授权页」。
         *
         * ⚠️ 它**不消耗任何凭据**（纯 GET、无 `Authorization`），可安全地在每次
         * 「新建账号」时调用 —— 本仓库有过「诊断请求烧掉 refresh_token」的事故。
         * ⚠️ 该函数**永不抛错**（失败退回本地兜底；再失败返回 undefined）。
         */
        const forcedLoginUrl = await fetchMinimaxForcedLoginUrl(auth, this.fetchImpl, this.product);
        return {
            loginUrl: auth.verificationUriComplete,
            ...forcedLoginUrl === undefined ? {} : { forcedLoginUrl },
            result,
            close: () => {
                aborted = true;
                controller.abort();
            },
        };
    }
    /**
     * 落盘凭据（登录成功后调用）。
     *
     * ⚠️ 返回 `accountId` 供调用方构造展示名。
     *
     * ## ⚠️⚠️ 2026-10-23（Gitee IKP8UA）：这里**补查一次账号身份**
     *
     * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点），
     * 登录响应体也**不含任何身份字段** ⇒ 原昵称判据（`decodeJwtSub`）恒 undefined
     * ⇒ 账号卡片恒显示插件内部 id（`minimax-6395cf64`），多账号无法分辨。
     *
     * ⇒ 落盘前查一次 `GET /v1/api/user/info`（见 `minimax-identity.ts`），
     *   把读到的 `name` 写进**凭据**（供自愈路径读）并**返回**给调用方写进账号池。
     *
     * ## 为什么收口在这里，而不是 RPC 分支
     *
     * 登录路径与**启动自愈**（`repairAccountNicknames`）都要身份 —— 若只写在 RPC
     * 那一段，自愈就得再写一份（「同一语义两套判据」）。收口在凭据落盘处，
     * 两条路径共用一份实现。
     *
     * ## 三条纪律
     *
     * 1. **查不到不影响登录**：身份是展示信息，失败一律 `undefined`
     *    （与 qoder 的 `fetchQoderUserNickname` 同原则）；
     * 2. **显式传入的 `nickname` 优先**（调用方可能有更权威的来源）；
     * 3. **国际站必须带池里的 XFF**：`agent.minimax.io` 对大陆出口恒 307 到
     *    `agent.minimaxi.com`，跨 origin 跟随会剥掉 `Authorization` ⇒ 401
     *    （真机实测：无 XFF 时国际站身份**永远**拿不到）。
     *
     * @param options.accountId 落盘到**哪个账号条目**（可选，供代理取出口）。
     *   ⚠️ 它是唯一能让「换 token 之后的身份查询」走对出口的来源 —— 此刻凭据
     *   刚落盘、按凭据反查账号 id 那条路还没建立（与 `startLogin` 同因）。
     */
    async persistLogin(credential, options) {
        // ⚠️ 与 `fetchModels` 同一份 XFF 取法（`typeof` 判一下：单测/旧接线可能传
        //    只实现部分方法的池替身，直接 `.minimaxXff()` 会抛 TypeError）。
        const pool = this.ctx.accountPool;
        const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined;
        // ⚠️ 查不到（含抛错、401、非 JSON、空 name）一律 `undefined`，不阻塞登录。
        const identity = options.nickname === undefined
            ? await fetchMinimaxUserIdentity(credential, this.fetcherFor(options.accountId ?? ''), this.product, xff)
            : undefined;
        const nickname = options.nickname ?? identity?.name;
        const payload = {
            ...credential,
            ...nickname === undefined ? {} : { nickname },
            // ⚠️ 稳定身份必须落进凭据 —— 它是「同账号去重」的**唯一**判据
            //    （`account.create` 的 minimax 分支按它查 `findAccountIdByIdentityField`）。
            //    `identity.userId` 一直拿得到（`GET /v1/api/user/info` 的 `userID`），
            //    但此前**只用来拼昵称、随后被丢弃** ⇒ 去重无从下手。
            ...identity?.userId === undefined ? {} : { user_id: identity.userId },
        };
        await this.ctx.credentials.set(credentialRef(options.refName), JSON.stringify(payload));
        this.lastRefreshError = undefined;
        return {
            ...credential.account_id === undefined ? {} : { accountId: credential.account_id },
            ...nickname === undefined ? {} : { nickname },
            ...identity?.userId === undefined ? {} : { userId: identity.userId },
        };
    }
    /** 解析默认单凭据。 */
    async resolveDefaultCredential() {
        const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
        if (!resolved)
            return undefined;
        return parseMinimaxCredential(resolved.value);
    }
    /**
     * 续期**默认单凭据**。
     *
     * ⚠️⚠️ **这是第 5 条续期路径，且必须同样继承身份**（2026-10-25 合并审计）：
     * PR !147 声称「收口在**唯一**出口 `refreshCredentialFor`」，但本方法在生产上
     * **可达**（`src/index.ts` 的 `getAvailableAccount()` 返回空时就走这里 ——
     * 而「返回空」正是去重把两张卡都停用后的形态），且它此前直接
     * `set(refreshMinimaxCredential(...))` ⇒ `nickname` / `user_id` **双双消失**
     * （实测：续期后落盘只剩令牌五件套）。后果是 IKP8UA（昵称退回内部 id）+
     * 去重失去唯一判据，**每 30 分钟一轮**，必然复现。
     *
     * ⇒ 与 `refreshCredentialFor` 共用同一个纯函数 `inheritMinimaxIdentity`。
     */
    async refresh() {
        /**
         * ⚠️⚠️ **必须走单飞闸门**（2026-10-27 第二轮审计打穿）。
         *
         * 修前本方法直接 `refreshMinimaxCredential` + `set`，与
         * `refreshAccountCredential` 并发时两路各消费一次一次性 RT（红队实测：
         * 「minimax 无池路径 & `refresh()` ⇒ 各 2 份 grant」）。
         *
         * ⚠️ key 用**默认单凭据 ref**（`credentialRefName`）：本方法是那条腿的
         * 唯一入口，与多账号路径的 `entry.credentialRef` 分属不同命名空间
         * （同一账号不会既走池又走单凭据），不会互相误共享。
         */
        const existing = this.renewInFlight.get(this.credentialRefName);
        if (existing !== undefined) {
            await existing.catch(() => undefined);
            return;
        }
        const task = (async () => {
            const credential = await this.resolveDefaultCredential();
            if (credential === undefined) {
                throw new MinimaxRefreshTokenExpiredError('凭据未配置，请先登录');
            }
            if (!isMinimaxRefreshable(credential)) {
                throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
            }
            try {
                const refreshed = await refreshMinimaxCredential(credential.refresh_token, this.fetchImpl, this.product);
                // ⚠️ 与 `refreshCredentialFor` **同一份**继承判据（同义判据分两处必然漂移）。
                const next = inheritMinimaxIdentity(refreshed, credential);
                await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next));
                this.lastRefreshError = undefined;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.lastRefreshError = message;
                throw error;
            }
        })().finally(() => { this.renewInFlight.delete(this.credentialRefName); });
        this.renewInFlight.set(this.credentialRefName, task);
        await task;
    }
    /**
     * 续期**指定 ref**（RPC `account.refresh` / adapter 401 强刷 / 积分自愈）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
     * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
     * 也把池值对账（见 `refreshAll` 的注释）。
     *
     * ⚠️⚠️ **并入单飞闸门**（`renewInFlight`，与 `renewEntry`/巡检共用同一把锁）。
     * 语义是**去重**（命中即在飞任务就等它、**不再发第二份**），不是「串行化」
     * —— 后者会让并发 N 条各烧一把一次性 RT（2026-10-27 审计打穿的 P0，
     * 详见方法体内那段注释）。
     */
    async refreshAccountCredential(refName, pool, accountId) {
        const ref = credentialRef(refName);
        if (pool === undefined) {
            // 无池：退化为「直接续期 + 落盘到同一个 ref」（单凭据路径，保持既有行为）
            const resolved = await this.ctx.credentials.resolve(ref);
            if (!resolved)
                throw new Error('凭据未配置');
            const credential = parseMinimaxCredential(resolved.value);
            if (!credential)
                throw new Error('凭据解析失败');
            if (!isMinimaxRefreshable(credential)) {
                throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
            }
            const next = await this.refreshCredentialFor(credential, accountId);
            await this.ctx.credentials.set(ref, JSON.stringify(next));
            return;
        }
        /**
         * ⚠️⚠️ **单飞：命中在飞任务就 await 并返回，绝不再发第二份 grant**。
         *
         * 修前（2026-10-27 审计打穿的 P0）：
         * ```ts
         * const existing = this.renewInFlight.get(refName)
         * if (existing !== undefined) await existing.catch(() => undefined)   // ← 等完
         * const task = (async () => { … grant … })()                          // ← 照样再发一份
         * ```
         * 即「串行化」而不是「去重」：并发 N 条 ⇒ N 份 grant，**且都用同一把 RT**。
         * 实测并发 5 次 ⇒ 5 份 grant、同时在飞峰值 4；端到端三条并发请求
         * （主回复 + 标题 + 压缩）⇒ 全部失败。
         *
         * 而 RT 是**一次性轮换**的：第 2 份起必然 `invalid_grant`，输家还会把
         * 「别人刚续成功」误读成「RT 已死」⇒ 把好账号标 `refreshable:false`
         * （单向门，永不自愈）。这正是 PR 声称要修的「要一个个点回来」。
         *
         * ⇒ 现在与 `renewEntry` **同形**：命中就等它落地、把结果视为本次结果。
         *   语义上并发的 N 条请求都「续期成功」，因为那一份 grant 就是它们要的。
         */
        const existing = this.renewInFlight.get(refName);
        if (existing !== undefined) {
            await existing.catch(() => undefined);
            return;
        }
        const task = (async () => {
            const resolved = await this.ctx.credentials.resolve(ref);
            if (!resolved)
                throw new Error('凭据未配置');
            const credential = parseMinimaxCredential(resolved.value);
            if (!credential)
                throw new Error('凭据解析失败');
            if (!isMinimaxRefreshable(credential)) {
                throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
            }
            await refreshAccountWithReconcile({
                pool,
                provider: this.product.id,
                tag: `[${this.product.id}]`,
                accountId: accountId ?? '',
                credential,
                accessors: MINIMAX_EXPIRY_ACCESSORS,
                refresh: (c) => this.refreshCredentialFor(c, accountId),
                save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
                makeTerminalError: (message) => new MinimaxRefreshTokenExpiredError(message),
                warn: (message) => this.ctx.logger?.warn?.(message),
                info: (message) => this.ctx.logger?.info?.(message),
            });
        })().finally(() => { this.renewInFlight.delete(refName); });
        this.renewInFlight.set(refName, task);
        await task;
    }
    /**
     * 批量处理：**2026-10-24 本地试验版改为只对账（reconcile-only），不发 grant**。
     *
     * ## 为什么砍掉这里的轮换（三方源码审计结论）
     *
     * 旧形态：全局 30min tick 走到这里 + `REFRESH_LEAD_MS`=1h + access TTL≈1h
     * ⇒ **每个 tick、每个可续期账号都命中刷新窗口**（~48 次轮换/天/账号），
     * 且循环顺序执行使全部账号的过期时刻焊死在同一秒窗 —— 一次系统性失败
     * 就是全池同时报废（用户实测「一失效就是一大片」）。
     *
     * 新分工：
     * - **轮换**交给 ① 60s 专属巡检（{@link startRenewPatrol}，5min margin +
     *   账号散列抖动）与 ② 请求路径兜底（adapter 预判 + 401 强刷）——
     *   官方 `oauth-core` 本就是按需制，定时批量轮换是本插件自加的；
     * - **本方法只做对账**：把凭据里的真实 `expiresAt` 镜像回池（UI 读池值），
     *   保持「凭据被别处更新过而索引没跟上」的自愈能力
     *   （`src/expiry-sync.ts` 模块头记录的缺陷反面）。
     *
     * ⚠️ 纪律保持：**不看 `enabled`**（停用只影响自动选号）；单账号失败不拖住其余。
     *
     * ⚠️⚠️ **不再按池里的 `refreshable` 过滤**（2026-10-27 审计修）。
     *
     * 修前是 `if (!entry.refreshable) continue`。而那个布尔是**每轮由凭据对账
     * 出来的镜像**，不是「曾被服务端拒绝过」的案底（`AGENTS.md`：「账号池的
     * `refreshable` 只是凭据材料的镜像」；`docs/adding-a-new-provider.md:132-135`
     * 把「不看 `refreshable`」列为**红线**，并给了事故原话：
     * 「自动续期没工作、重启也没用」）。
     *
     * 拿它当门禁 ⇒ 任何一次误标都是**单向门**：定时那轮跳过它、启动首轮也跳过它。
     * 而**写成 `refreshable:false` 的唯一来源**正是本文件（终态判定），一旦
     * 判据偶发误判（见 `refresh-failure.ts` 的三条实测），账号就再也回不来。
     *
     * ⇒ 现在**读凭据本体**判材料（`isMinimaxRefreshable(credential)`）：
     *   凭据里 `refresh_token` 为空才标 `refreshable:false`；否则照常对账。
     *   读凭据只是**本地存储访问**，不花网络也不花额度 —— 拿它当门禁「省请求」
     *   是错省，省下的是自愈能力。
     */
    async refreshAll(pool) {
        const accounts = await pool.listAccounts(this.product.id);
        for (const entry of accounts) {
            try {
                const ref = credentialRef(entry.credentialRef);
                const resolved = await this.ctx.credentials.resolve(ref);
                if (!resolved) {
                    // ⚠️ 凭据**根本读不到**时**不得**标 `refreshable:false`（2026-10-27 审计修）：
                    // 那条路径的成因是「存储暂时读不出来 / 凭据被外部删除 / 备份未导入」，
                    // 与「服务端拒绝这把 RT」是两件事。误标它同样是单向门。
                    // ⇒ 只留日志，下一轮再试。
                    this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据读不到（可能未导入），本轮只记日志、不改池标记`);
                    continue;
                }
                const credential = parseMinimaxCredential(resolved.value);
                if (!credential) {
                    this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据解析失败（形状不对），本轮只记日志、不改池标记`);
                    continue;
                }
                if (!isMinimaxRefreshable(credential)) {
                    // 这一格才是**权威**的「不可续期」：凭据里确实没有 refresh_token。
                    await pool.updateAccount(entry.id, { refreshable: false });
                    continue;
                }
                await syncAccountExpiry({
                    pool,
                    provider: this.product.id,
                    credential,
                    accessors: MINIMAX_EXPIRY_ACCESSORS,
                    accountId: entry.id,
                    current: entry,
                    tag: `[${this.product.id}]`,
                    warn: (message) => this.ctx.logger?.warn?.(message),
                });
            }
            catch (error) {
                // 只对账不会产生终态错误；这里兜的是池/凭据读取层面的意外，
                // 照旧留日志（静默失败会让「凭据一直刷不动」无痕）。
                this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 有效期对账失败：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    /**
     * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
     *
     * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
     *
     * 2026-10-24 起走 {@link grantWithSalvage}：非终态失败同 RT 重试一次、
     * 终态失败先回退历史代际 RT —— 语义对单凭据路径同样成立。
     *
     * @param accountId 该凭据属于哪个账号（可选，供代理取出口）。
     *   ⚠️ 与推理路径同因：国际站的续期端点也在 `agent.minimax.io` 上，
     *   大陆出口直连会 307 ⇒ 续期恒失败而 UI 只显示「已过期」。
     */
    async refreshCredentialFor(credential, accountId) {
        return this.grantWithSalvage(credential, accountId);
    }
    /**
     * **单次 grant**（含终态分类 + 历史代际维护）。
     *
     * - 服务端判 RT 已死（`invalid_grant|expired|revoked`）⇒ 包成终态错误抛出；
     * - 成功 ⇒ 组装新凭据：**旧 RT 压入历史栈**（新→旧、去重、截 3 条），
     *   再交给 `inheritMinimaxIdentity` **继承全部非令牌字段**（`nickname` / `user_id` /
     *   `previous_refresh_tokens`）—— 续期响应只带令牌五件套，手工透传每加一个字段就漏一个。
     */
    async grantOnce(credential, accountId) {
        if (!isMinimaxRefreshable(credential)) {
            throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
        }
        let refreshed;
        try {
            refreshed = await refreshMinimaxCredential(credential.refresh_token, this.fetcherFor(accountId ?? ''), this.product);
        }
        catch (error) {
            if (isTerminalRefreshError(error)) {
                throw new MinimaxRefreshTokenExpiredError('refresh_token 已失效，请重新登录');
            }
            throw error;
        }
        // 旧 RT 压栈（**新→旧**、去重、最多 `MINIMAX_PREVIOUS_REFRESH_TOKENS` 条）——
        // 供 `grantWithSalvage` 在终态失败时逐把回退（断链抢救）。
        // ⚠️ 这是**非令牌字段**：随下面 `inheritMinimaxIdentity` 的
        // `{ ...previous, ...refreshed }` 自然落盘，**不要**在这里手工透传。
        // ⚠️ 与 CAS 分支共用 `mergePreviousRefreshTokens`（同义判据只留一份实现）。
        const deduped = mergePreviousRefreshTokens(credential.previous_refresh_tokens, credential.refresh_token);
        if (deduped !== undefined)
            refreshed = { ...refreshed, previous_refresh_tokens: deduped };
        /**
         * ⚠️⚠️ 续期**必须继承**身份字段（2026-10-24）。
         *
         * `parseMinimaxTokenGrant` 只构造令牌五件套（`access_token` / `refresh_token` /
         * `token_type` / `expires_at` / `scope`），**不认识** `nickname` / `user_id`；
         * 而续期结果会被整体覆盖落盘 ⇒ 每续期一次丢一次：`nickname` 丢了账号卡片退回
         * 内部 id（IKP8UA 复发），`user_id` 丢了**同账号去重失去唯一判据**。
         * 60s 巡检、请求前预判、401 强刷、SELF_HEAL 都会续期 ⇒ 这个丢失**必然发生**。
         *
         * ⚠️ 收口在**唯一**的续期出口（本方法）：本文件有 4 条续期路径，在各调用点
         *    分别补必然漏一处。
         */
        return inheritMinimaxIdentity(refreshed, credential);
    }
    /**
     * grant + **两层抢救**（2026-10-24 本地试验版）。
     *
     * ## 抢救顺序（**循环内合并**，不是两层互斥）
     *
     * 1. **非终态失败**（网络断/超时/5xx）⇒ 隔 1.5s **同 RT 重试一次**：
     *    覆盖「服务端还没处理就断了」的情形；
     * 2. 重试若转**终态**，说明服务端已经轮换过（响应丢失）⇒ 必须继续落到
     *    **历史代际回退**；
     * 3. **终态** ⇒ 依次回退 **历史代际 RT**（`previous_refresh_tokens`，
     *    新→旧最多 3 把）：上游若只作废被用的那条而非整族，就能救回 ——
     *    全失败才抛终态（调用方标记需重登）。**实验特性**：上游语义未证实，
     *    全失败只是多花几次注定失败的请求，无新增风险；每次抢救结果都进 journal。
     *
     * ⚠️⚠️ **修前的层级断裂（2026-10-27 审计打穿）**：
     * 修前是 `catch { if (终态) { …历史… } else { sleep; return grantOnce() } }`
     * —— 第 1 层的重试若抛**终态**，那个异常会**直接冒出去**，历史代际**一次都不试**。
     * 实测：首轮网络错→重试终态时 RT 序列 `['DEAD_RT','DEAD_RT']`（`OLD_RT_1`
     * 从未被试）；而对照组「首轮即终态」是 `['DEAD_RT','OLD_RT_1']`（救回成功）。
     *
     * 而「响应丢失」正是本特性**最主要的**设计场景（PR 描述的根因③），
     * 也就是说抢救链在它最该生效的形态下**恰好失效**。⇒ 改成单一循环：
     * 不管终态是第几次抛出的，都过一遍历史代际。
     */
    async grantWithSalvage(credential, accountId) {
        /** 本次是否已经做过「同 RT 重试一次」（只做一次，别把网络抖动放大成 N 次）。 */
        let retried = false;
        /** 当前要试的 RT 序列：当前值在前，其后是历史代际（新→旧、去重）。 */
        const candidates = [];
        const current = credential.refresh_token;
        if (typeof current === 'string' && current.length > 0)
            candidates.push(current);
        for (const token of credential.previous_refresh_tokens ?? []) {
            if (typeof token === 'string' && token.length > 0 && !candidates.includes(token)) {
                candidates.push(token);
            }
        }
        let lastError;
        for (let index = 0; index < candidates.length; index += 1) {
            const token = candidates[index];
            const attemptCredential = index === 0
                ? credential
                : { ...credential, refresh_token: token };
            // ⚠️ 历史代际**不做**「同 RT 重试」：它们本就是抢救用的弹药，
            //    每一把只试一次，别把注定失败的请求翻倍。
            const maxAttemptsForThisToken = index === 0 ? 2 : 1;
            for (let attempt = 0; attempt < maxAttemptsForThisToken; attempt += 1) {
                try {
                    return await this.grantOnce(attemptCredential, accountId);
                }
                catch (error) {
                    lastError = error;
                    if (error instanceof MinimaxRefreshTokenExpiredError) {
                        // 这一把 RT 被服务端明确拒绝 ⇒ 换下一代（跳出内层）。
                        break;
                    }
                    // ⚠️ 非终态：只在**当前值**上重试一次（`retried` 防放大）。
                    if (index === 0 && !retried && attempt === 0) {
                        retried = true;
                        await (this.options.sleep
                            ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(MINIMAX_RENEW_RETRY_DELAY_MS);
                        continue;
                    }
                    /**
                     * ⚠️⚠️ **还有历史代际时不得直接抛**（2026-10-27 第二轮审计打穿的 P1，
                     * 两位审计员独立命中；且**新增守卫对它 37/37 全绿**）。
                     *
                     * ## 缺陷
                     *
                     * 修前这一行无条件 `throw error`。于是「首轮网络错 → 重试**仍是非终态**」
                     * 这条路径**跳过全部历史代际**。实测（call1 `fetch failed`、call2 `503`）：
                     * 试过的 RT = `["RT-CUR","RT-CUR"]`（`RT-OLD` 从未被试）并抛 503。
                     *
                     * 而「**响应丢失**」（服务端已轮换、回程丢了）正是本特性的**设计主场景**：
                     * 它的表现恰好就是「网络类失败」——服务端已经把钥匙换成新的，我们
                     * 手上这把旧的在**首次**尝试时就等于失效，重试一次（仍非终态）之后
                     * 必须去历史代际里找。§第一轮修的是「首轮网络错 → 重试**转终态**」那半，
                     * 这一行是**另一半**，两处合起来才算真的「层级合并」。
                     *
                     * ## 修法
                     *
                     * 还在第 0 代（`index === 0`）且**还有历史代际可试**时，**不要抛**，
                     * 改为 `break` 跳出内层、继续外层循环（`index = 1, 2, …`）。
                     * 只有「已经是最后一代」或「根本没有历史代际」时才抛 —— 那才是
                     * 真正的「全都打不通」。
                     */
                    if (index === 0 && candidates.length > 1)
                        break;
                    throw error;
                }
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new MinimaxRefreshTokenExpiredError('refresh_token 已失效，请重新登录');
    }
    /**
     * **按账号条目续期**（2026-10-24 本地试验版的核心入口）。
     *
     * ## 与 `refreshAccountCredential` 的分工
     *
     * | 入口 | 用途 | margin |
     * |---|---|---|
     * | 本方法 | 60s 巡检 / 请求路径兜底 | 5min + 账号抖动（`force` 时无窗口） |
     * | `refreshAccountCredential` | RPC `account.refresh` / adapter `refresh()` | 既有 1h lead（用户点了就是要刷） |
     *
     * ## 三条纪律（缺一都是事故）
     *
     * 1. **单飞**（`renewInFlight`）：巡检 / 兜底 / 强刷并发想续同一个账号时，
     *    只允许一份 grant 在天上 —— 并发轮换同一 RT 是轮换式令牌的致命竞态；
     * 2. **CAS 落盘**：grant 前后**重读凭据**，`access_token` 变了说明期间
     *    有别人写过（登录 / RPC 续期）⇒ **丢弃本次结果**（别人写的是更新的
     *    会话，覆盖回去等于把新钥匙换成旧的）；
     * 3. **全量 journal**：每次 grant 记 `{trigger, result, error, latencyMs,
     *    newExpiresAt}` —— 试验期验收全靠它。
     */
    async renewEntry(pool, entry, opts = {}) {
        const existing = this.renewInFlight.get(entry.credentialRef);
        if (existing !== undefined) {
            // 汇合：别的入口（refreshAccountCredential 的 lead-aware 流程）正在续
            // 同一个 ref ⇒ 等它落地，重读凭据交回去（对账/镜像由那次飞行完成）。
            await existing.catch(() => undefined);
            const reRead = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
            const credential = reRead === undefined ? undefined : parseMinimaxCredential(reRead.value);
            return { renewed: false, ...(credential === undefined ? {} : { credential }) };
        }
        const task = this.renewEntryInner(pool, entry, opts)
            .finally(() => { this.renewInFlight.delete(entry.credentialRef); });
        this.renewInFlight.set(entry.credentialRef, task);
        return task;
    }
    async renewEntryInner(pool, entry, opts) {
        const ref = credentialRef(entry.credentialRef);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved) {
            /**
             * ⚠️⚠️ **读不到凭据时不得标 `refreshable:false`**（2026-10-27 审计修）。
             *
             * 那一格的成因是「存储暂时读不出来 / 凭据被外部删除 / 备份还没导入」，
             * 与服务端**拒绝这把 RT** 是两件事。而 `refreshable:false` 会挡住
             * `refreshAll` 与巡检（单向门）⇒ 误标一次就再也没人重试。
             * ⇒ 只留日志；`refreshable` 保持原值，下一轮巡检再读一次。
             */
            this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据读不到（可能未导入），本轮跳过且不改池标记`);
            return { renewed: false };
        }
        const credential = parseMinimaxCredential(resolved.value);
        if (credential === undefined) {
            this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据解析失败（形状不对），本轮跳过且不改池标记`);
            return { renewed: false };
        }
        if (!isMinimaxRefreshable(credential)) {
            // 这一格才是**权威**的不可续期：凭据里确实没有 refresh_token。
            await pool.updateAccount(entry.id, { refreshable: false }).catch(() => { });
            return { renewed: false };
        }
        /**
         * ⚠️⚠️ **终态冷却**（2026-10-27 第二轮审计打穿）。
         *
         * 见 {@link MINIMAX_TERMINAL_COOLDOWN_MS} 的 doc：没有它时，一个已判死的账号
         * 会被巡检每 60s 重打一次、每次还会试最多 3 代历史 ⇒ 实测 5 分钟 20 次上游请求。
         *
         * ⚠️ **判据是「当前 RT 与冷却时那把是否相同」**：不同（用户重新登录 / 面板
         *    刷新 / 他处续期写入了新凭据）⇒ **立即清除冷却**，本次照常尝试。
         *    这一条是「不把人锁死」的保证 —— 冷却只针对**那一把已死的钥匙**。
         *
         * ⚠️ 只跳过**网络层**：下面的本地对账（`syncAccountExpiry`）不受影响，
         *    因为那一格在本早退唯一能触及的位置之前就返回了 —— 代价是
         *    「冷却期内池 `expiresAt` 不刷新」，而池值对已判死的账号本就没有意义
         *    （`refreshable:false` 已表达状态）。
         */
        const cooledToken = this.terminalCooldownToken.get(entry.credentialRef);
        if (cooledToken !== undefined && cooledToken !== credential.refresh_token) {
            // 凭据已变（别人写了新钥匙）⇒ 冷却作废，本次照常尝试。
            this.terminalCooldownToken.delete(entry.credentialRef);
            this.terminalCooldownUntil.delete(entry.credentialRef);
        }
        else {
            const until = this.terminalCooldownUntil.get(entry.credentialRef) ?? 0;
            if (Date.now() < until) {
                return { renewed: false, credential };
            }
        }
        const trigger = opts.trigger ?? 'patrol';
        const margin = opts.force === true ? Number.POSITIVE_INFINITY : (opts.marginMs ?? MINIMAX_RENEW_MARGIN_MS);
        const expiresAt = minimaxCredentialExpiresAtMs(credential);
        // ⚠️ 读不到过期时间视为「该续」（fail-open，与 shouldRefreshNow 同口径）。
        if (!opts.force && expiresAt !== undefined && Number.isFinite(expiresAt)
            && expiresAt - Date.now() > margin) {
            return { renewed: false, credential };
        }
        const started = Date.now();
        try {
            const next = await this.grantWithSalvage(credential, entry.id);
            // CAS：grant 期间凭据若被别人写过（登录 / RPC 续期），**不覆盖** ——
            // 别人写的是更新的会话，覆盖回去等于把新钥匙换成旧的。
            const reRead = await this.ctx.credentials.resolve(ref);
            const reReadCredential = reRead === undefined ? undefined : parseMinimaxCredential(reRead.value);
            if (reReadCredential !== undefined && reReadCredential.access_token !== credential.access_token) {
                /**
                 * ⚠️⚠️ **丢弃前必须把本次轮换出来的新 RT 压进历史栈**（2026-10-27 审计修）。
                 *
                 * ## 修前的净损失
                 *
                 * 修前直接 `return`：本次 grant **已在上游完成轮换**，而我们把这把新 RT
                 * 丢掉了（实测：落盘仍是 `OTHER_RT`，`MINE_NEW_RT` 永久消失且**未压栈**）。
                 * 若上游是「用一次即作废」—— 本 PR 的整个前提 —— 这把 RT 就成了
                 * **孤儿且已作废**；更糟的是它顶替了旧值，救援链的弹药反而少了一把。
                 * 也就是说「丢弃」在一次性 RT 语义下**不是零代价**，它花掉一次轮换额度
                 * 却什么也没留下。
                 *
                 * ## 修法
                 *
                 * 把 `next.refresh_token`（本次新拿到的）作为**额外一代**压进
                 * `reReadCredential.previous_refresh_tokens` 后再落盘 —— 令牌材料用
                 * **别人那份更新的**（不覆盖 `access_token`），只把「弹药」补上。
                 * 这样即使 `MINE_NEW_RT` 在上游仍有效，后续 `invalid_grant` 时能被抢救链试到。
                 *
                 * ⚠️ 只补 RT、**绝不碰** `access_token` / `expires_at`（那两份是别人的新会话）。
                 */
                const salvagedHistory = mergePreviousRefreshTokens(reReadCredential.previous_refresh_tokens, 
                // 本次新拿到的（可能就是别人那份，去重后自然只剩一条）
                next.refresh_token, 
                // 本次用掉的那把（上游可能已作废，但留作末位弹药无副作用）
                credential.refresh_token);
                if (salvagedHistory !== undefined) {
                    await this.ctx.credentials.set(ref, JSON.stringify({ ...reReadCredential, previous_refresh_tokens: salvagedHistory })).catch(() => { });
                }
                appendMinimaxJournal(this.journalHome, {
                    ts: Date.now(),
                    provider: this.product.id,
                    accountId: entry.id,
                    kind: 'superseded',
                    trigger,
                    result: 'skipped',
                });
                return { renewed: false, credential: reReadCredential, superseded: true };
            }
            await this.ctx.credentials.set(ref, JSON.stringify(next));
            await syncAccountExpiry({
                pool,
                provider: this.product.id,
                credential: next,
                accessors: MINIMAX_EXPIRY_ACCESSORS,
                accountId: entry.id,
                current: entry,
                tag: `[${this.product.id}]`,
                warn: (message) => this.ctx.logger?.warn?.(message),
            });
            this.lastRefreshError = undefined;
            appendMinimaxJournal(this.journalHome, {
                ts: Date.now(),
                provider: this.product.id,
                accountId: entry.id,
                kind: 'grant',
                trigger,
                result: 'ok',
                latencyMs: Date.now() - started,
                newExpiresAt: minimaxCredentialExpiresAtMs(next),
            });
            return { renewed: true, credential: next };
        }
        catch (error) {
            appendMinimaxJournal(this.journalHome, {
                ts: Date.now(),
                provider: this.product.id,
                accountId: entry.id,
                kind: 'grant',
                trigger,
                result: 'error',
                error: error instanceof Error ? error.message : String(error),
                latencyMs: Date.now() - started,
            });
            if (error instanceof MinimaxRefreshTokenExpiredError) {
                await pool.updateAccount(entry.id, { refreshable: false }).catch(() => { });
                /**
                 * ⚠️⚠️ **终态必须记冷却**（2026-10-27 第二轮审计打穿）。
                 *
                 * 修前只标池 + 记一条 warn。而巡检**不按 `refresh_token` 是否已知失效过滤**
                 * ⇒ 一个死号会被每 60s 重打一次，且 `grantWithSalvage` 还会试最多 3 代历史
                 * ⇒ 红队实测：**5 分钟内 20 次上游请求**（5 tick × 4，首轮另 4 次）。
                 *
                 * 而「重试一把**确定**已死的 RT」在一次性轮换语义下**不可能成功** ——
                 * 那是纯粹的无效流量（上游侧还可能计入风控/限流）。
                 *
                 * ⇒ 记一个冷却窗口（{@link MINIMAX_TERMINAL_COOLDOWN_MS}）。判据是
                 *   「错误**类型**」（`instanceof MinimaxRefreshTokenExpiredError`），
                 *   不是字符串比较 —— 与 `src/refresh.ts` 的终态判据同一条纪律。
                 *   冷却只在**网络层**跳过（见 {@link renewEntryInner} 开头的早退），
                 *   凭据一变（用户重新登录 / 面板刷新）立即清除 ⇒ 不会把人锁死。
                 */
                this.terminalCooldownUntil.set(entry.credentialRef, Date.now() + MINIMAX_TERMINAL_COOLDOWN_MS);
                this.terminalCooldownToken.set(entry.credentialRef, credential.refresh_token);
                this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）；`
                    + `${Math.round(MINIMAX_TERMINAL_COOLDOWN_MS / 60_000)} 分钟内不再重试（重新登录或手动刷新可立即恢复）`);
            }
            throw error;
        }
    }
    /**
     * **60s 专属续期巡检**（重复调用幂等；生命周期由接线层的 `ctx.effect` 回收）。
     *
     * ## 为什么不塞进全局 30min 调度器
     *
     * 30min 粒度配 5min margin 会出现「上一轮看着还够、下一轮 token 已死」的
     * 空窗；而全局调度器是十三个 provider 共用的，为 MiniMax 一家改粒度会
     * 波及全部。故 MiniMax 自带 60s 定时器，margin 内（5min + 账号抖动）才发
     * grant —— 轮换次数从 ~48 次/天/账号降到 ~24-32 次，且**各账号时刻互不相同**。
     *
     * ⚠️ **立即先跑一轮**（与 `MultiAccountRefreshScheduler.start` 同理由）：
     * 宿主重启后不该等满 60s 才开始补。
     *
     * ⚠️⚠️ **必须由 {@link stopRenewPatrol} 回收**（2026-10-27 审计打穿）：
     * 修前只有 `setInterval` + `unref`、**没有 clear 路径**，而 `unref` 只解决
     * 「不阻止进程退出」，**不解决「fiber 卸载后仍在跑」**。
     *
     * 实测：`fiber.dispose()` 之后推进 130s ⇒ 巡检 tick **照跑**（+3 次），
     * 而旧实例读的是**共享的 credentials 后端**（不是快照）⇒ 它会继续对**新池**
     * 发 grant。插件热重载/`apply()` 重入时旧实例没死 + 新实例已起 ⇒ **两个实例
     * 并发轮换同一批一次性 RT**，输家拿到 `invalid_grant` 并把好号标死。
     * 这恰好是本 PR 自己声称要修的「并发轮换」形态。
     *
     * ⇒ 接线层必须 `ctx.effect(() => () => auth.stopRenewPatrol())`（两站各一条），
     *   由 `index.ts` 负责；`lifecycle-cleanup` 那组守卫逐站点名。
     */
    startRenewPatrol(pool) {
        if (this.patrolTimer !== undefined)
            return;
        /**
         * ⚠️⚠️ **必须重置 `patrolStopped`**（2026-10-27 自审补）。
         *
         * 修前只判 `patrolTimer !== undefined`。而 `stopRenewPatrol()` 会把
         * `patrolStopped` 置 `true` —— **它是粘滞的**。于是「stop 之后再 start」
         * （同一个实例被重新启用 / 测试里先 stop 再 start）会得到一个
         * **永久空转的定时器**：tick 每次都在第一行 `return`，巡检**再也不续期**，
         * 而 `patrolTimer` 又非空 ⇒ 连幂等短路都挡住了后续的 start。
         *
         * 症状是「账号再也不自动续期，而日志里一个字都没有」—— 正是本仓库
         * 反复记录的那类静默失效。⇒ start 是「启动意图」，必须把停止标志清掉。
         *
         * ⚠️ 生产上 `src/index.ts` 每次 `apply()` 都 `new MinimaxAuth`（新实例
         * 新标志），故这一格在生产**当前不可达**；但它是一颗**哑弹**：
         * 任何把实例复用/重挂的改动（热重载、把 start 挪进 `ctx.effect`、
         * 或测试用例之间共享实例）都会踩上，且症状完全无日志。
         * 守卫：`minimax-renew-mechanism.spec.ts` 的「stop 之后重新 start 必须
         * 恢复巡检」。
         */
        this.patrolStopped = false;
        /** 本实例已停止 ⇒ tick 直接不再动作（防 dispose 后在飞的一轮继续打）。 */
        const tick = async () => {
            if (this.patrolStopped || this.patrolBusy)
                return;
            this.patrolBusy = true;
            try {
                const accounts = await pool.listAccounts(this.product.id);
                for (const entry of accounts) {
                    /**
                     * ⚠️ **每个账号之前都要再看一眼 `patrolStopped`**（2026-10-27 审计修）。
                     *
                     * tick 开头那次检查**不够**：一轮可能卡在某个 `await grant` 上几十秒，
                     * 期间 fiber 被卸载（插件热重载）⇒ 它醒来后会继续把这个账号**之后
                     * 的所有账号**都轮换一遍 —— 而那时实例已 dispose，读的却是**共享的**
                     * credentials 后端 ⇒ 会真的对上游换钥匙（一次性 RT，且与新实例
                     * 并发）⇒ 输家 `invalid_grant`，好号被标死。
                     *
                     * 实测：删掉本行 + `stopRenewPatrol` 的置位后，守卫精确变红。
                     */
                    if (this.patrolStopped)
                        return;
                    /**
                     * ⚠️⚠️ **巡检的判据是「凭据里还有没有 refresh_token」，不是池里的
                     * `refreshable`**（2026-10-27 审计修）。
                     *
                     * 修前是 `if (!entry.refreshable) continue` —— 而 `refreshable` 是
                     * **每轮由凭据对账出来的镜像**，不是「曾被服务端拒绝过」的案底。
                     * 拿它当门禁 ⇒ 任何一次误标都变成**单向门**：巡检跳过它、`refreshAll`
                     * 也跳过它 ⇒ 「自动续期没工作、重启也没用」，而凭据明明还能用。
                     *
                     * 这条在 `docs/adding-a-new-provider.md:132-135`（「不看 `refreshable`」）
                     * 与 `AGENTS.md` 的「refreshable 只是凭据材料的镜像」两处都是明文红线，
                     * 而本 PR 在巡检里**新复制了同一个门**。
                     *
                     * ⇒ 这里**不再看 `refreshable`**，直接交给 `renewEntry`：
                     *   它内部的 `renewEntryInner` 会读凭据、判 `isMinimaxRefreshable(credential)`
                     *   （凭据材料才是权威），凭据真的缺 RT 才标 `refreshable:false`。
                     *   代价只有每轮多一次**本地**存储读（不花网络、不花额度）。
                     *
                     * ⚠️ 仍然**不看 `enabled`**（停用只影响自动选号，不该让凭据烂掉）。
                     */
                    try {
                        await this.renewEntry(pool, entry, {
                            marginMs: MINIMAX_RENEW_MARGIN_MS + renewJitterMs(entry.id, MINIMAX_RENEW_JITTER_SPAN_MS),
                            trigger: 'patrol',
                        });
                    }
                    catch (error) {
                        // 终态已在 renewEntry 内记账 + 标池；这里只吞掉继续，
                        // 单账号失败不得拖住其余（与 refreshAll 同纪律）。
                        if (!(error instanceof MinimaxRefreshTokenExpiredError)) {
                            this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 巡检续期失败：`
                                + `${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                }
            }
            catch (error) {
                this.ctx.logger?.warn?.(`[${this.product.id}] 续期巡检一轮失败（下一轮重试）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                this.patrolBusy = false;
            }
        };
        void tick();
        this.patrolTimer = setInterval(() => { void tick(); }, MINIMAX_RENEW_PATROL_INTERVAL_MS);
        // ⚠️ 不持进程：宿主退出时定时器不该是「退不下去」的原因。
        this.patrolTimer.unref?.();
    }
    /**
     * 停止续期巡检（**幂等**；由接线层的 `ctx.effect` 在 fiber 卸载时调用）。
     *
     * ⚠️⚠️ 这是 2026-10-27 审计补的**唯一** clear 路径。修前整个类没有它，
     * 而 `unref()` 只保证「不阻止进程退出」，不保证「fiber 卸载后停手」——
     * 实测 dispose 后巡检仍对新池发 grant（详见 {@link startRenewPatrol} 的注释）。
     *
     * ⚠️ 同时置 `patrolStopped`：**在飞的那一轮**（可能正卡在某个 await 上）
     * 也会在下一个账号前退出，不再继续轮换。
     */
    stopRenewPatrol() {
        this.patrolStopped = true;
        if (this.patrolTimer !== undefined) {
            clearInterval(this.patrolTimer);
            this.patrolTimer = undefined;
        }
    }
    /**
     * 拉取远端模型目录（给定凭据）。
     *
     * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
     *
     * @param accountId 用**哪个账号**的出口（可选，供代理取）。
     */
    async fetchModelsWith(credential, accountId) {
        const raw = await this.fetchRawModels(credential, accountId);
        return raw ?? this.product.fallbackModels.map(fallbackToEntry);
    }
    /**
     * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
     *
     * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
     * 「拿不到时回吐什么」：
     * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
     * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
     *
     * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
     * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
     * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
     * 能可靠区分两者。
     *
     * @param accountId 用**哪个账号**的出口（可选，供代理取）。
     *   ⚠️ 目录端点也在 `agent.minimax.io` 上：大陆出口直连恒 307 ⇒ 整个
     *   provider 会从模型选择器里**消失**（issue IKMEVG 的另一症状面）。
     */
    async fetchRawModels(credential, accountId) {
        try {
            const url = new URL(`${this.product.apiHost}${MINIMAX_MODELS_PATH}`);
            url.searchParams.set('region', this.product.region);
            url.searchParams.set('buildEnv', this.product.buildEnv);
            /**
             * ⚠️ **带传输级重试 + 保凭据跟随重定向**（两个真实缺陷的修法）。
             *
             * 传输级重试（2026-10-15）：「模型连接测试失败，显示 `fetch failed`」。
             * 本机实测环境里的 HTTPS 检查代理约 **50%** 概率打断到本家的请求
             *（`fetch failed ← SELF_SIGNED_CERT_IN_CHAIN`）⇒ 一次偶发中断就整轮失败。
             *
             * 保凭据跟随 3xx（2026-10-17，issue IKMEVG）：`agent.minimax.io` 恒 307 到
             * `agent.minimaxi.com`，而 fetch 跨 origin 跟随会**剥掉 `Authorization`**
             * ⇒ 第二跳无凭据 ⇒ 目录也拿不到（连带让 provider 在模型选择器里消失）。
             *
             * ⚠️ 两者合并在 `minimaxFetch` 一处，与推理 / 签到积分路径**共用同一份**
             *（`src/minimax.ts`）—— 本文件不另写判据（同义判据分两处必然漂移）。
             * `buildInit` 每跳重建头，保证跟随后的请求仍带凭据。
             *
             * ⚠️ 国际站另需附用户设置的 `X-Forwarded-For`（绕开 Akamai 按出口 IP
             * 的地理分流）。没有它，大陆出口的用户连目录都拿不到 ⇒ provider 在模型
             * 选择器里整个消失（这是本 issue 的另一个症状面）。
             */
            // ⚠️ 用 `typeof` 判一下：单测/旧接线可能传只实现部分方法的池替身，
            //    直接 `.minimaxXff()` 会在那种替身上抛 `TypeError`（`?.` 挡不住）。
            const pool = this.ctx.accountPool;
            const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined;
            let geoRouted = false;
            const response = await minimaxFetch(url.toString(), () => ({
                headers: minimaxHeadersFor(credential, xff, this.product.id),
                signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
            }), {
                fetcher: this.fetcherFor(accountId ?? ''),
                onGeoRoute: () => { geoRouted = true; },
            });
            if (!response.ok) {
                // ⚠️ 地理路由必须留**可操作**的日志：否则用户只看到「模型列表变空」，
                //    而真因（出口 IP 被判定为中国大陆）完全不可见。
                if (geoRouted) {
                    this.ctx.logger?.warn?.(`[${this.product.id}] ${describeMinimaxGeoRoute()}`);
                }
                return undefined;
            }
            const body = await response.json().catch(() => undefined);
            const entries = parseMinimaxModelsPayload(body);
            // ⚠️ 远端成功但解析出 0 条时也回退兜底表（避免空列表让整个 provider 消失）
            if (entries.length === 0) {
                // ⚠️ **必须留日志**：否则无法区分「远端坏了」与「远端返回 0 条」，
                // 两者都静默给出兜底表，排查时只知道「模型列表不对」却找不到原因。
                // 目录是展示信息，故仍不抛错（不该让整个 provider 报错）。
                this.ctx.logger?.warn?.(`[${this.product.id}] 远端模型目录解析出 0 条，已回退兜底表`);
                return undefined;
            }
            return entries;
        }
        catch (error) {
            // ⚠️ 远端失败静默回退，但**必须留日志**（同上：否则无从排查）。
            this.ctx.logger?.warn?.(`[${this.product.id}] 远端模型目录获取失败，已回退兜底表：`
                + `${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }
    /** 拉取远端模型目录（账号池版本）。 */
    async fetchModels(pool) {
        const picked = await this.resolveModelsCredential(pool);
        if (picked === undefined)
            return this.product.fallbackModels.map(fallbackToEntry);
        return this.fetchModelsWith(picked.credential, picked.accountId);
    }
    /**
     * 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。
     *
     * ⚠️ **同时返回账号 id**（代理支持）：目录端点也在 `agent.minimax.io` 上，
     * 国际站必须走该账号的出口才拿得到。单凭据回退时 id 是空串（= 直连），
     * 与既有行为一致。
     */
    async resolveModelsCredential(pool) {
        if (pool !== undefined) {
            // ⚠ `getAvailableAccount` 返回 **`{ entry, credential }`**（两层），
            // **不是**「账号条目本身」—— 照抄既有 provider 的写法：
            // `const available = await pool.getAvailableAccount<MinimaxCredential>(id, ''); available?.credential`
            const available = await pool.getAvailableAccount(this.product.id, '');
            if (available) {
                return { credential: available.credential, accountId: available.entry.id };
            }
        }
        const credential = await this.resolveDefaultCredential();
        if (credential === undefined)
            return undefined;
        return { credential, accountId: '' };
    }
    /**
     * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
     *
     * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
     *
     * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
     * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
     * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
     * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
     * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
     *
     * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
     * 只是**不**把兜底表当结果返回。
     */
    async fetchRemoteModelsOnly(pool) {
        const picked = await this.resolveModelsCredential(pool);
        if (picked === undefined)
            return [];
        return (await this.fetchRawModels(picked.credential, picked.accountId)) ?? [];
    }
    /**
     * ★★ **启动自愈：补齐存量账号的显示名**（Gitee issue IKP8UA 修法 ③）。
     *
     * ## 为什么必须有这条
     *
     * 只改登录路径**不会自愈存量账号** —— 用户已有的账号（本机实测 7 条）
     * 昵称早已是插件内部 id 且已落盘。不给这条腿，用户要**删号重登**才看得到真名。
     *
     * ## 形态照 `gemini-auth.ts` 的同名方法（那是本仓库最规范的一份）
     *
     * | 纪律 | 理由 |
     * |---|---|
     * | 逐账号 `try/catch` | 单账号失败不得拖住其余（本方法是启动期循环，一个挂住会连累后面全部） |
     * | **只在确实变化时**写池 | `updateAccount` 是整体 replace，每次启动都写 = 平白落盘 |
     * | 失败**不告警**（只用 debug） | 老账号 token 可能早已过期，拿不到是常态，不该刷 warn |
     * | 查不到就**保持原样** | 绝不退回用池 id 重算昵称（那是本 issue 的缺陷本身） |
     *
     * ⚠️ **国际站必须带池里的 XFF**：否则恒 307 → 401（真机实测），
     *    自愈对国际站账号将**永远**失败且看起来「和国内站一样在跑」。
     *
     * @returns 被修复的账号 id（供接线层记日志/计数）。
     */
    async repairAccountNicknames(pool) {
        const repaired = [];
        let entries;
        try {
            entries = await pool.listAccounts(this.product.id);
        }
        catch {
            // ⚠️ 读不到池绝不当成「没有账号」—— 但这是启动期的尽力而为，
            //    下一次启动还会重试，故这里只静默返回（不删任何东西）。
            return repaired;
        }
        // ⚠️ 与 `fetchModels` / `persistLogin` **同一份** XFF 取法。
        const xffPool = this.ctx.accountPool;
        const xff = typeof xffPool?.minimaxXff === 'function' ? xffPool.minimaxXff() : undefined;
        for (const entry of entries) {
            try {
                const ref = credentialRef(entry.credentialRef);
                const resolved = await this.ctx.credentials.resolve(ref);
                if (!resolved)
                    continue;
                const credential = parseMinimaxCredential(resolved.value);
                if (credential === undefined)
                    continue;
                // 查一次身份（只读 GET；失败返回 undefined，不抛错）。
                // ⚠️ **走 `fetcherFor(entry.id)`**：国际站的用户信息端点也在
                //    `agent.minimax.io` 上，大陆出口直连会 307 ⇒ 401（真机实测）
                //    ⇒ 自愈对国际站账号恒失败且看起来「和国内站一样在跑」。
                const identity = await fetchMinimaxUserIdentity(credential, this.fetcherFor(entry.id), this.product, xff);
                if (identity === undefined) {
                    // 拿不到就保持原样（绝不退回用池 id 重算昵称 —— 那正是本 issue 的缺陷）。
                    this.ctx.logger?.debug?.(`[${this.product.id}] 账号 ${entry.id} 补拉账号身份失败（昵称保持原样）`);
                    continue;
                }
                // ⚠️ 只在**确实变化**时写：`updateAccount` 是整体 replace。
                if (identity.name !== entry.nickname) {
                    await pool.updateAccount(entry.id, { nickname: identity.name });
                    repaired.push(entry.id);
                }
                /**
                 * 顺带把身份写进凭据（`persistLogin` 的读取侧约定见该方法注释）。
                 *
                 * ⚠️⚠️ **必须连 `user_id` 一起补写**（2026-10-25 合并审计打穿）：
                 * 改前这里只写 `nickname`，而 `identity.userId` **就在手上**却被丢掉 ⇒
                 * 存量凭据（PR 之前登录的）永远没有 `user_id` ⇒ `account.create` 的
                 * 同账号去重**永不命中**（`findAccountIdByIdentityField` 对缺失字段是
                 * **跳过**，不是「不匹配」）⇒ 一个号仍可无限建卡、各持一份 token。
                 *
                 * 这条自愈是**唯一**能给存量账号补身份的地方：`persistLogin` 只写新账号，
                 * `inheritMinimaxIdentity` 只能继承「已有的」，救不了「从来没有的」。
                 * 本机三份 `MINIMAX_ACCOUNT_*` 凭据实测**零份**带 `user_id` ⇒ 不是边角情况。
                 */
                const needsNicknameBackfill = credential.nickname !== identity.name;
                const needsUserIdBackfill = identity.userId !== undefined
                    && credential.user_id !== identity.userId;
                if (needsNicknameBackfill || needsUserIdBackfill) {
                    /**
                     * ⚠️⚠️ **写盘前必须重读凭据（CAS）** —— 2026-10-27 审计打穿的真缺陷。
                     *
                     * ## 缺陷
                     *
                     * 本函数在 `:1105` 读一次凭据，然后 `await` 一次身份端点（实测 ~120ms），
                     * 再拿**那份旧凭据**展开整体 `set`。而 `src/index.ts` 把本函数（fire-and-forget）
                     * 与 **60s 巡检的首轮**排成了相邻两行 ⇒ 启动时两者必然并发。
                     *
                     * 实测时序（我构造的确定性复现）：
                     * ```
                     * repair.resolve → OLD            （读到旧凭据）
                     *  巡检 grant   → NEW_RT 落盘     （换了一把新钥匙）
                     * repair.set   → {...OLD, nickname}（用旧凭据展开，把 NEW_RT 覆盖回去）
                     * ```
                     * `set` 序列实测为 `['NEW_RT', 'OLD_RT']` ⇒ **刚轮换出来的新 RT 被丢掉**。
                     * 若上游是一次性轮换（本 PR 的整个前提），这把旧 RT 已在上游作废 ⇒
                     * **账号报废、只能重登**。且这条自愈在生产上**每次启动必现**（本机三份
                     * 存量凭据**零份**带 `user_id` ⇒ 必然写盘）。
                     *
                     * ## 修法
                     *
                     * grant 的成功结果里带的是**新** `access_token`；只要重读发现
                     * `access_token` 变了，就说明「别人写过更新的会话」⇒ 只在**最新那份**上
                     * 合并身份字段，绝不覆盖令牌材料。这与 `renewEntryInner` 的 CAS 同一条纪律。
                     *
                     * ⚠️ 与 `renewEntryInner` 的差别：那里「被抢先」要**丢弃整次结果**（因为
                     * 它的产出就是令牌）；本函数的产出是**身份字段**，与令牌无关 ⇒ 应当
                     * 合并到最新凭据上而不是放弃（否则 `user_id` 永远补不上，去重继续失效）。
                     */
                    const latest = await this.ctx.credentials.resolve(ref);
                    const latestCredential = latest === undefined
                        ? undefined
                        : parseMinimaxCredential(latest.value);
                    /**
                     * ⚠️⚠️ **重读失败时绝不能退回旧快照**（2026-10-27 第二轮审计打穿的 P0，
                     * 两位审计员独立命中）。
                     *
                     * 修前是 `const base = latestCredential ?? credential` —— 那一行等于
                     * 「重读失败 ⇒ 用**我们手里那份旧凭据**展开整体 `set`」，于是**恰好
                     * 又回到本段注释要修的那个缺陷**（用旧快照覆盖别人的新会话）。
                     *
                     * 实测（盘上已是 `NEW_RT`、第二次 `resolve` 失败）：
                     * 落盘 `refresh_token = OLD_RT`（`NEW_RT` 被覆盖回旧的），
                     * 而 `nickname = N` 说明确实写了盘。一次性 RT 语义下 = **账号报废**。
                     *
                     * ⇒ 现在：**读不到最新凭据就整个跳过写盘**（只留 debug 日志）。
                     *   代价是「这一次没补上 `user_id`」——下次启动自愈会再试（它是幂等的、
                     *   且 `user_id` 缺失正是它要修的），而**错误覆盖是不可逆的**。
                     *   两者不对称 ⇒ 一律偏向「不写」。
                     */
                    if (latestCredential === undefined) {
                        this.ctx.logger?.debug?.(`[${this.product.id}] 账号 ${entry.id} 的身份补写跳过：`
                            + '写盘前重读不到最新凭据（若用旧快照展开会覆盖他处刚轮换的新 token）');
                    }
                    else {
                        await this.ctx.credentials.set(ref, JSON.stringify({
                            ...latestCredential,
                            nickname: identity.name,
                            ...identity.userId === undefined ? {} : { user_id: identity.userId },
                        }));
                    }
                }
            }
            catch (error) {
                // 单账号失败不得中断其余（与 gemini 同纪律）。
                this.ctx.logger?.debug?.(`[${this.product.id}] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return repaired;
    }
}
/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export function parseMinimaxModelsPayload(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        return [];
    const providers = payload.providers;
    if (!Array.isArray(providers))
        return [];
    const minimax = providers.find((p) => typeof p === 'object' && p !== null && p.providerId === 'minimax');
    if (minimax === undefined)
        return [];
    const config = minimax.config;
    if (typeof config !== 'object' || config === null)
        return [];
    const models = config.models;
    if (typeof models !== 'object' || models === null || Array.isArray(models))
        return [];
    const out = [];
    for (const [id, raw] of Object.entries(models)) {
        // ⚠️ 把对象的 **key** 注入为 `id`（长名），条目自带的 `name` 是短名。
        // 两者都要保留 —— 合并会丢失官方展示名。
        const withId = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? { ...raw, id }
            : { id };
        const entry = normalizeMinimaxModel(withId);
        if (entry !== undefined)
            out.push(entry);
    }
    // ⚠️ 按远端 model_order 排序（若提供），否则保持对象插入序
    const order = config.model_order;
    if (Array.isArray(order)) {
        const index = new Map();
        order.forEach((id, i) => { if (typeof id === 'string')
            index.set(id, i); });
        out.sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER)
            - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }
    return out;
}
//# sourceMappingURL=minimax-auth.js.map