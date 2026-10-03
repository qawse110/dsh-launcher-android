/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled /
 *           captcha.demand / captcha.carrierUrl / captcha.contribute（内部载体，
 *           载体页见 src/zcode-carrier-page.ts 与 src/captcha-carrier-server.ts）/
 *           backup.export / backup.import / backup.status
 * 另有一条 GET 路由 `/api/jet-hub/captcha-carrier`：渲染内部载体的载体页
 * （⚠ 手工诊断用；guest 加载不到它，见该路由注释里的主进程取证）。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { isGatewayEnabled } from './openai-gateway/config.js';
import { collectGatewayModelIds } from './openai-gateway/models.js';
import { applyGatewayDesiredState, gatewayAddress, gatewayApiKey, isGatewayRunning, setGatewayDesiredEnabled, } from './openai-gateway/runtime.js';
import { LOOMY } from './loomy-product.js';
import { buddyExpiringWindowDays } from './buddy-balance-rank.js';
import { RACCOON } from './raccoon-product.js';
import { ZCODE } from './zcode-product.js';
import { phoneFromUserId, isUsableZcodeCredential } from './zcode.js';
import { MINIMAX } from './minimax-product.js';
import { isMinimaxRefreshable, minimaxCredentialExpiresAtMs } from './minimax.js';
import { claimMinimaxDailyCheckin, fetchMinimaxCreditBalance, fetchMinimaxSigninStatus, } from './minimax-credits.js';
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES } from './loomy-onboarding.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { QODER, QODER_CN } from './qoder-product.js';
import { TRAE } from './trae-product.js';
import { CLINE } from './cline-product.js';
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs, lobsteraiDisplayNickname, } from './lobsterai.js';
import { fetchQoderUserNickname, isQoderRefreshable, qoderCredentialExpiresAtMs, withQoderNickname, } from './qoder.js';
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js';
import { isTraeRefreshable, traeCredentialExpiresAtMs, traeDisplayNickname } from './trae.js';
import { fetchClineCreditBalance } from './cline-credits.js';
import { fetchClineUsageLimits } from './cline-quota.js';
import { clineUpstreamOf, readClineRequestHistory } from './cline-request-log.js';
import { clineCredentialExpiresAtMs, isClineRefreshable, } from './cline.js';
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js';
import { credentialExpiresAtMs } from './buddy.js';
import { claimDailyCheckin, fetchCheckinStatus, fetchCreditBalance, } from './credits.js';
import { CODEBUDDY, WORKBUDDY, productById } from './product.js';
import { captchaDemand, putSuppliedParam, } from './captcha-supply.js';
import { ZCODE_CAPTCHA_FALLBACK } from './zcode-captcha.js';
import { buildCarrierPageHtml } from './zcode-carrier-page.js';
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance, } from './lobsterai-credits.js';
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed, } from './codearts-credits.js';
import { claimTraeDailyCheckin, fetchTraeCheckinStatus, fetchTraeCreditBalance, } from './trae-credits.js';
import { resetAccount, resetAllAccounts, retestAccount, retestAllAccounts, } from './account-probe.js';
import { exportBackup, importBackup } from './backup.js';
import { handleOpencodeRpc } from './opencode-rpc.js';
import { OPENCODE } from './opencode-product.js';
import { BADGE_PREFERENCES, createBadgePreferenceStore, } from './badge-preferences.js';
import { createUsageBadge } from './usage-badge.js';
import { createAutoCheckin, createAutoCheckinStore } from './auto-checkin.js';
/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub';
/**
 * 内部 captcha **载体页**的 GET 路径（与 GUI 同源，故 `<webview>` 能导航过来）。
 *
 * ⚠ 它挂在 `/api/` 前缀下，因而不是「随便一个静态页」：DSH 的 `/api` 路由会先过
 *   Connection 的 Host/Origin 栏与**浏览器会话认证**（`dsh-client-connection` 的
 *   `admit()` ⇒ 未认证回 401）。桌面版的 guest 与 GUI 是否同 partition、
 *   因而带得上那份会话 cookie，属 Task 5 的**实测项**，不在这里放宽。
 */
export const CAPTCHA_CARRIER_PATH = '/api/jet-hub/captcha-carrier';
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub';
/** 生成 8 字符随机短 ID（小写 hex） */
function shortId() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 解析 CodeArts 凭据 JSON；解析失败返回 undefined。 */
function parseCodeArtsCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_key_id === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 解析 LobsterAI 凭据 JSON；解析失败返回 undefined。 */
function parseLobsteraiCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 解析 Qoder 凭据 JSON；解析失败返回 undefined。 */
function parseQoderCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 解析 TRAE 凭据 JSON；解析失败返回 undefined。 */
function parseTraeCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** 解析 Cline 凭据 JSON；解析失败返回 undefined。 */
function parseClineCredential(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (1100)`。
 *
 * ## 为什么要追加手机号尾号
 *
 * 服务端的 `name` 是**自动生成的默认名**（实测本机账号为 `RaccoonAva`，
 * 即「Raccoon」+ 随机串）。实证：
 *
 * - `GET /user_info` 的 `data.name = "RaccoonAva"`；
 * - JWT payload 里同样带 `name: "RaccoonAva"`（官方客户端就是读这个：
 *   `M = () => { ... userName: t.name, id: t.sid }`）；
 * - `wechat_bindings` 只有 `[{id, bound_at}]` —— **没有微信昵称/头像**。
 *   微信扫码走 `snsapi_login`（只给 openid），要昵称需额外申请
 *   `snsapi_userinfo`，这里显然没申请。
 *
 * 所以「显示 `RaccoonAva`」本身与官方一致、**不是取错字段**；但它是默认名，
 * 注册第二个账号时服务端很可能又给一个相近的名字 → 多账号重名、无法区分。
 *
 * 修法参考 Loomy（`Loomy 2222`）：这边有真实名字可用，故**保留原名再挂尾号**，
 * 兼顾「看得出服务端原名字」与「多账号可区分」。
 *
 * 退化顺序：昵称 + 手机号尾号 → 昵称 + 用户 id → 昵称 → 账号 id。
 * ⚠️ 手机号取**后 4 位**（够区分且不完整暴露号码）。
 */
export function buildRaccoonNickname(credential, fallbackId) {
    const nickname = typeof credential.nickname === 'string' ? credential.nickname.trim() : '';
    const phone = typeof credential.phone === 'string' ? credential.phone.trim() : '';
    const userId = typeof credential.user_id === 'string' ? credential.user_id.trim() : '';
    // 消歧后缀：优先手机号尾号（更利于用户辨认是哪个号），否则用户 id
    const suffix = phone.length >= 4
        ? phone.slice(-4)
        : userId.length > 0 ? userId : '';
    if (nickname.length > 0) {
        // 已有该后缀时不重复追加（例如服务端名字里本就带手机号尾号）
        return suffix.length > 0 && !nickname.includes(suffix) ? `${nickname} (${suffix})` : nickname;
    }
    if (suffix.length > 0)
        return `Raccoon ${suffix}`;
    return fallbackId;
}
/**
 * 支持「锁定永久积分」的 provider 白名单。
 *
 * ⚠️ **必须与前端 `credits-capabilities.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 只有这三家有两个可分的积分池：
 * - Loomy：服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）；
 * - CodeBuddy / WorkBuddy：要从资源包列表按**扣费截止距今是否满 15 天**现算
 *   （判据见 `buddy-balance-rank.ts`，实测两站形状不同但都成立）。
 * 其余渠道（CodeArts / LobsterAI / Qoder / TRAE / Cline / Raccoon）的积分
 * 模型里没有「会不会作废」这一层区分，登记进来只会多一个无效开关。
 */
export const PERMANENT_LOCK_PROVIDERS = new Set([
    LOOMY.id,
    CODEBUDDY.id,
    WORKBUDDY.id,
]);
/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes) {
    const summary = {
        claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
    };
    for (const outcome of outcomes) {
        switch (outcome.kind) {
            case 'claimed':
                summary.claimed += 1;
                summary.totalCredit += outcome.credit;
                // ⚠️ 只有**覆盖今天**的领取才算「今天已处理」。`coversToday:false` 是
                // 渠道自己标的（当前是 Qoder 刷新前那一轮），见 `credits.ts` 的字段说明。
                if (outcome.coversToday !== false)
                    summary.coversToday += 1;
                break;
            case 'already-claimed':
                summary.alreadyClaimed += 1;
                if (outcome.coversToday !== false)
                    summary.coversToday += 1;
                break;
            case 'inactive':
                summary.inactive += 1;
                break;
            case 'failed':
                summary.failed += 1;
                break;
            default: {
                // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
                // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
                const exhaustive = outcome;
                void exhaustive;
                // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
                // 宁可多报一个失败，也不让结果凭空消失。
                summary.failed += 1;
                break;
            }
        }
    }
    return summary;
}
/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus(accounts, product, deps) {
    // 与 collectClaimResults 同款：显式包装默认实现把 fetcher 送进第三参，
    // 不用 `as unknown as` 掩盖签名差异（见 CreditsEndpointDeps.fetcher 的说明）。
    const fetcher = deps.fetcher ?? fetch;
    const fetchStatus = deps.fetchStatus
        ?? (async (credential, product) => fetchCheckinStatus(credential, product, fetcher));
    const results = [];
    // 顺序查询，避免并发触发风控
    for (const entry of accounts) {
        let status = null;
        try {
            const resolved = await deps.resolve(credentialRef(entry.credentialRef));
            if (resolved !== undefined) {
                const credential = JSON.parse(resolved.value);
                status = await fetchStatus(credential, product);
            }
        }
        catch (error) {
            // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
            deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`);
            status = null;
        }
        results.push({ accountId: entry.id, nickname: entry.nickname, status });
    }
    return results;
}
/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults(accounts, product, deps) {
    // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转。**
    //
    // 真实签名是 `(credential, product, fetcher)`，而本接口把 `claim` 声明为
    // `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
    // 历史写法用 `as unknown as` 把这个不匹配「压」过去 —— TypeScript 于是不再
    // 报错，但调用点传的第三个实参是 `entry`，它落进 `fetcher` 位置，运行时抛
    // **`TypeError: fetcher is not a function`**。
    // **真实缺陷**：用户一键领取 4 个 CodeBuddy 账号全部失败，报错就是这句。
    //
    // 修法：显式包装 —— 把 `deps.fetcher`（或全局 `fetch`）送进第三参，
    // `entry` 只交给真正需要它的 provider（它们在自己的分支里注入 `claim`）。
    const fetcher = deps.fetcher ?? fetch;
    const fetchStatus = deps.fetchStatus
        ?? (async (credential, product) => fetchCheckinStatus(credential, product, fetcher));
    const claim = deps.claim
        ?? (async (credential, product) => claimDailyCheckin(credential, product, fetcher));
    // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
    const precheck = deps.precheckStatus !== false;
    const results = [];
    const outcomes = [];
    for (const entry of accounts) {
        let outcome;
        try {
            const resolved = await deps.resolve(credentialRef(entry.credentialRef));
            if (resolved === undefined) {
                outcome = { kind: 'failed', code: -1, message: '凭据未配置' };
            }
            else {
                const credential = JSON.parse(resolved.value);
                if (!precheck) {
                    // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
                    outcome = await claim(credential, product, entry);
                }
                else {
                    // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
                    const status = await fetchStatus(credential, product);
                    if (status !== null && !status.active) {
                        outcome = { kind: 'inactive', message: '签到活动未开启' };
                    }
                    else if (status !== null && status.todayCheckedIn) {
                        outcome = { kind: 'already-claimed', message: '今天已签到' };
                    }
                    else {
                        // 状态查询失败（status 为 null）时仍然尝试领取：
                        // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
                        outcome = await claim(credential, product, entry);
                    }
                }
            }
        }
        catch (error) {
            deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`);
            outcome = {
                kind: 'failed', code: -1,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        outcomes.push(outcome);
        results.push({ accountId: entry.id, nickname: entry.nickname, outcome });
    }
    return { results, summary: computeClaimSummary(outcomes) };
}
/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances(accounts, product, deps) {
    // 同 collectClaimResults：显式包装，避免 `as unknown as` 掩盖签名差异。
    const fetcher = deps.fetcher ?? fetch;
    const fetchBalance = deps.fetchBalance
        ?? (async (credential, product) => fetchCreditBalance(credential, product, fetcher));
    const fetchDetailed = deps.fetchBalanceDetailed;
    const results = [];
    // 顺序查询，避免并发触发风控
    for (const entry of accounts) {
        let balance = null;
        let error;
        try {
            const resolved = await deps.resolve(credentialRef(entry.credentialRef));
            if (resolved === undefined) {
                error = '凭据未配置';
            }
            else {
                const credential = JSON.parse(resolved.value);
                if (fetchDetailed !== undefined) {
                    // 带原因的查询：实现自己决定「非积分账户」等业务状态的文案。
                    const detailed = await fetchDetailed(credential, product);
                    balance = detailed.balance;
                    error = detailed.error;
                    if (balance === null && error === undefined)
                        error = '余额查询失败';
                }
                else {
                    balance = await fetchBalance(credential, product);
                    // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
                    if (balance === null)
                        error = '余额查询失败';
                }
            }
        }
        catch (caught) {
            deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`);
            error = caught instanceof Error ? caught.message : String(caught);
            balance = null;
        }
        results.push({
            accountId: entry.id,
            nickname: entry.nickname,
            balance,
            ...error === undefined ? {} : { error },
        });
    }
    return results;
}
/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * ## ⚠️ 必须**优先属性访问** `ctx.llm`
 *
 * `src/index.ts` 里 `mountOpenAiGateway` 传的是 `ctx.llm`（属性），而本模块
 * 原先只走 `ctx.get('llm')`。在 connection 上下文里后者可能拿不到
 * `listProviders` —— 结果是**同一时刻**两个页面给出矛盾答案：
 * `/v1/models` 正常返回 36 个模型，而设置页的清单恒为 0 个。
 * 两处服务来源不一致还会让「纠错建议里给的 ID」与「网关实际接受的 ID」可能不同。
 *
 * 用 `ctx.get`（而非插件级 `inject`）作回退：Jet Hub 的账号管理是主要职责，
 * 模型开关只是附加能力；llm 服务完全缺失时账号面板仍应可用。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故它与
 * `listProviders` 都声明为可选。
 */
function llmServiceOf(ctx) {
    const direct = ctx.llm;
    if (direct !== undefined && direct !== null)
        return direct;
    return ctx.get('llm');
}
/**
 * 列出可用于枚举目录的 provider。
 *
 * ⚠️ `listProviders` 取不到时**用已注册适配器的 key 兜底** —— 那些 key 就是本
 * 插件注册的 provider 全集，比「什么都没有」有用得多。仍取不到才返回
 * `undefined`（调用方据此给出明确原因，而不是显示一个空清单让用户去猜）。
 */
function providerIdsOf(llm, modelAdapters) {
    if (llm?.listProviders !== undefined) {
        try {
            const listed = llm.listProviders();
            if (Array.isArray(listed) && listed.length > 0)
                return listed;
        }
        catch {
            // 落到下面的兜底。
        }
    }
    const keys = Object.keys(modelAdapters ?? {});
    return keys.length > 0 ? keys.map((id) => ({ id })) : undefined;
}
/**
 * 注册 Jet Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export function registerJetHubRpc(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, 
/** Qoder **中国版**实例（与 `qoder` 同协议、不同 product；RPC 分支按注册表分派）。 */
qoderCn, trae, cline, loomy, raccoon, 
/** MiniMax Code **中国版**实例（OAuth 设备码 + PKCE，与 Qoder 同型但协议不同）。 */
minimax, zcode, 
/**
 * provider → 适配器实例（可选）。
 *
 * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
 * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
 * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
 */
modelAdapters) {
    ctx.inject(['connection'], (connectionCtx) => {
        registerJetHubEndpoints(connectionCtx, pool, codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline, loomy, raccoon, minimax, zcode, modelAdapters);
    });
}
/**
 * 广播「模型目录可能已变化」。
 *
 * ⚠️ **改黑名单后必须调用**，否则「关闭后选择器里仍能看到该模型，重启后才消失」
 * （真实缺陷，用户报障）。根因在客户端而非适配器：
 * `dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把 `modelCatalog`
 * 响应存进一个 `status === 'ready'` 即**短路返回缓存**的 store，只在三个转发的
 * 宿主事件上 `refresh()`：`llm/adapters-updated` / `settings/document-updated`
 * / `credentials/reference-updated`。
 *
 * 0.1.7 起黑名单落在插件自有文档 `$DSH_HOME/jet-hub/state.json`（不再经 settings
 * 文档，见 jet-hub-store.ts），因此写开关**不会**触发上述任何一个事件 → 客户端
 * 一直复用旧目录，直到重启（`connection/reset` → `resetGeneration()`）才重拉。
 *
 * 三者中 `llm/adapters-updated` 最贴合：按契约它是**无载荷**的「目录可能变了，
 * 请重新读 listModels」通知（dsh-llm README：*consumers re-read the registries*），
 * 正是这里要表达的语义。它也在 `API_REMOTE_FORWARDED_EVENTS` 白名单里，故会真的
 * 送达浏览器。不改变拓扑，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
 * `retryPolicy`）必然通过，不会误报 INVARIANT。
 *
 * ⚠️ **通知失败不能反噬已经落盘的开关**：否则用户看到「切换失败」而实际已生效，
 * 再点一次又因幂等而看似「无效」，比不提示更难排查。故这里自行吞掉异常只记日志。
 */
function broadcastCatalogChanged(ctx) {
    try {
        ctx.emit('llm/adapters-updated');
    }
    catch (error) {
        ctx.logger.warn(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`);
    }
}
/**
 * 取某 provider 的**全量模型 id**（不套黑名单），供「关闭全部」与「关闭供应商」共用。
 *
 * 两条路径的优先级（与 `model.list` 保持一致的取舍，但**不需要展示名**：
 * 这里只要 id 来写黑名单，故不走 `model.list` 那套回填 disabled 的复杂逻辑）：
 * 1. 优先 `modelAdapters[provider].listAllModels()` —— **同步**，不触发远端拉取；
 * 2. 缺失时退化 `llm.listModels(provider)` —— 异步，且**结果已被黑名单过滤**。
 *
 * ⚠️ 第 2 条路径拿不到「已关闭」的模型（它们不在 `listModels` 返回值里），
 * 故它写出的黑名单是**不完整**的。这对「关闭全部」无影响（已关闭的本就无需再关），
 * 但意味着**不能用它判断「是否全部已关闭」** —— 状态判定必须用
 * `listAllModels()` 的全量目录（见 `provider.status`）。
 *
 * @returns `{ ids }` 成功；`{ error }` 失败原因（调用方据此拒绝且**不落盘**）。
 */
async function fullCatalogIds(ctx, modelAdapters, provider) {
    const all = modelAdapters?.[provider]?.listAllModels();
    if (all !== undefined)
        return { ids: all.map((model) => model.id) };
    const llm = llmServiceOf(ctx);
    if (llm === undefined)
        return { error: 'llm 服务不可用' };
    try {
        return { ids: (await llm.listModels(provider)).map((model) => model.id) };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { error: `读取模型列表失败：${reason}` };
    }
}
/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline, loomy, raccoon, minimax, zcode, modelAdapters) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = ctx.connection ?? ctx.get('connection');
    if (!connection || typeof connection.fetch?.register !== 'function') {
        ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered');
        return;
    }
    const qoderFamily = [
        { product: QODER, auth: qoder },
        { product: QODER_CN, auth: qoderCn },
    ];
    /** 该 provider 是否属于 Qoder 同族（国际版或中国版）。 */
    const isQoderFamily = (provider) => qoderFamily.some((member) => member.product.id === provider);
    /**
     * 取同族成员；不存在时抛错。
     *
     * ⚠️ 调用方**必须**先用 `isQoderFamily()` 判定。这里抛错而不是返回
     * `undefined`，是为了让分支内部不必写 `!` 或 `as` —— 那两类断言会在
     * 将来有人把判定改成别的条件时静默失效。
     */
    const requireQoderFamily = (provider) => {
        const member = qoderFamily.find((item) => item.product.id === provider);
        if (member === undefined)
            throw new Error(`Unknown Qoder family provider: ${provider}`);
        return member;
    };
    /**
     * Loomy 短信登录的中间状态（账号 id → { phone, msgid }）。
     *
     * 为什么放内存而不是凭据存储：msgid 是**一次性的中间态**（5 分钟有效），
     * 登录完成后即无意义；写进 `ctx.credentials` 会污染凭据命名空间，
     * 且它不含任何秘密（不能用于认证）。
     */
    const pendingSmsMsgid = new Map();
    /**
     * 用量徽标的显示偏好（`$DSH_HOME/jet-hub/ui-preferences.json`）。
     *
     * ⚠️ 与账号池**分开**的独立文档：`state.json` 是整体替换语义，同机另一条工作区
     * 里的旧版本代码整体重写它时不会带上不认识的键 —— 理由与后果见
     * `badge-preferences.ts` 的文件头。
     */
    const badgePreferences = createBadgePreferenceStore(ctx);
    /**
     * 「每日首次启动自动签到」（独立文档 `auto-checkin.json`）。
     *
     * ⚠️ **不维护第二份「哪些渠道能签到」的名单**：判据交给下面的 `claim` ——
     * `credits.claimAll` 对不支持的渠道会**不发上游请求**就返回明确错误，本执行体
     * 把它计为「跳过」。客户端的能力表（`credits-capabilities.js`）仍是唯一权威。
     *
     * ⚠️ 「有账号的渠道」由账号池派生（`pool.listAllAccounts()` 只是同步内存副本
     * 的异步外壳），不遍历 12 个渠道里没账号的那些 —— 那些调下去只会拿到空结果。
     */
    const autoCheckin = createAutoCheckin({
        store: createAutoCheckinStore(ctx),
        listProviderIds: async () => {
            const accounts = await pool.listAllAccounts();
            return [...new Set(accounts.map((entry) => entry.provider))].sort();
        },
        claim: (provider) => handleMethod('credits.claimAll', { provider }),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // 启动时排定一轮（延迟 30s；内部自己判开关与「今天是否已跑」）。
    autoCheckin.start();
    /**
     * ⚠️ `ctx.effect` 必须**可选调用**：本文件此前没用过它，而大量单测的 ctx 桩是
     * 最小化的（没有 `effect`）—— 直接调用会让 138 条无关用例报
     * `ctx.effect is not a function`（2026-10-02 实测到）。真实宿主里它一定存在，
     * 故这里的降级只影响桩环境，不影响生产环境的清理语义。
     */
    ctx.effect?.(() => () => autoCheckin.stop(), 'jet-hub: auto checkin');
    /**
     * 用量徽标读数服务（宿主侧 TTL 缓存 + 只保留启用账号 + 附加订阅读数）。
     *
     * ⚠️ **取数直接复用内部 `handleMethod`**，不另写 provider 分派：
     * `credits.balances` 的 12 条分支（含 codearts 的「Token 计费账户」文案、
     * zcode 的逐桶折算等）是唯一口径，复制一份必然漂移。
     * 第三个参数是 `AbortSignal` 且在当前实现里未被使用，故这里传 `undefined`
     *（该形参是下划线命名 = 有意未用）。
     *
     * ⚠️ 订阅窗口**只对 Cline** 存在（能力矩阵里的 `subscriptionQuota`）—— 这个
     * 「哪个渠道有窗口」的判断留在装配层，`usage-badge.ts` 因此不认识任何具体渠道。
     */
    const usageBadge = createUsageBadge({
        collectBalances: (provider) => handleMethod('credits.balances', { provider }),
        collectQuota: (provider) => provider === CLINE.id
            ? handleMethod('cline.quota', { provider })
            : undefined,
        listAccounts: (provider) => pool.listAccountsByProvider(provider),
        readPreference: () => badgePreferences.load(),
        readAutoCheckin: () => autoCheckin.state(),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    connection.fetch.register({
        path: JET_HUB_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            if (request.method !== 'POST') {
                return new Response('method not allowed', { status: 405 });
            }
            const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
            if (contentType !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let message;
            try {
                message = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request';
            const call = message.payload;
            if (message.type !== 'client-request' || typeof message.rpcId !== 'string'
                || message.method !== JET_HUB_ENDPOINT
                || !call || typeof call.method !== 'string'
                || !Object.prototype.hasOwnProperty.call(call, 'payload')) {
                return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Jet Hub management request.' } });
            }
            try {
                const result = await handleMethod(call.method, call.payload, request.signal);
                return reply(rpcId, result);
            }
            catch (error) {
                // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
                // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
                const message = error instanceof Error ? error.message : String(error);
                ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`);
                return reply(rpcId, {
                    ok: false,
                    error: { code: 'jet-hub/handler-failed', message },
                });
            }
        },
    });
    /**
     * 载体页要用的 captcha 配置：**远端优先、拉不到就兜底**。
     *
     * ⚠ 远端那次请求**不是**在 GET 处理里现加的额外开销 —— `fetchCaptchaConfig()`
     * 自带 60 秒 TTL 缓存（`src/zcode-auth.ts` 的 `captchaConfigCacheInstance`），
     * 与推理侧 `index.ts` 走的是同一份缓存实例。
     * ⚠ 拉不到（无凭据 / 网络失败 / 该形态的 zcode 实例没有这个方法）一律回落
     *   `ZCODE_CAPTCHA_FALLBACK`：载体页**必须**给得出去。回 500 的话，client 那边
     *   表现为「导航成功但没有 `window.__zcodeCaptcha`」，比配置旧一点难查得多。
     */
    async function carrierCaptchaConfig() {
        try {
            const remote = await zcode.fetchCaptchaConfig();
            return remote ?? ZCODE_CAPTCHA_FALLBACK;
        }
        catch {
            return ZCODE_CAPTCHA_FALLBACK;
        }
    }
    /**
     * 内部载体的载体页（**旧路由：已不是 guest 的入口**，见下面的取证）。
     *
     * ## ⚠⚠ 它**不可能**被 `<webview>` guest 加载（评审 C1/C2，2026-10-02 实测取证）
     * 这条路由挂在应用自己的 host 上，而桌面版主进程对 guest 有两道硬闸
     * （DSH Desktop 0.2.0-rc.2，`resources/app.asar/lib/main.js`）：
     * - `allowedNavigation(value)` = http(s) + 无账号密码 + `!isApplicationHost(url)`；
     * - `isApplicationHost(url)` = **`url.port === host.port` 且（主机相同或回环）**；
     * - `configureSession().onBeforeRequest` 对命中者直接 `callback({ cancel: true })`；
     * - guest 的 partition 是 `dsh-sidebar-browser-${randomUUID()}`（**无 `persist:`**），
     *   Host 的会话 cookie 在 `defaultSession` 里 ⇒ 即便加载到了也过不了 `/api/*` 的认证。
     *
     * ⇒ 内部载体的真正入口是**独立回环端口上的小服务**
     * （`src/captcha-carrier-server.ts`，地址由 `captcha.carrierUrl` 这条 RPC 给）。
     *
     * ## 那为什么还留着这条
     * ① 它是**手工诊断**用的：web 版下 GUI 就是 `http://127.0.0.1:<port>`，
     *   在浏览器标签里直接打开这一页可以验证「载体页本身能不能产 param」；
     * ② 表达式只有这一份（`buildCarrierPageHtml`），删路由不会让逻辑分叉；
     * ③ 保留 = 不破坏既有 `CAPTCHA_CARRIER_PATH` 契约（`tests/unit/zcode-carrier-rpc.spec.ts`）。
     * ⚠ **别再把 client 导航指回这里** —— 那正是评审 C1/C2 指出的「收益恒为 0」的成因。
     *
     * ⚠ 只读、无凭据：这条 GET 不接收任何参数，输出里不含 JWT / token；
     *   产出的 param 由 guest 自己经 `captcha.contribute` 回传，**不**经这条路由。
     */
    connection.fetch.register({
        path: CAPTCHA_CARRIER_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
            /**
             * ⚠ 真实挂载下这条**永远轮不到**：dsh 的分发器按 `methods` 集合筛过才调本 handler
             * （`@deepseek-ai/dsh-client-connection` 里 `fetchRoutes.get(pathname)` +
             * `methods.has(request.method)`）。留着它不是防御性装饰，是为了**不依赖挂载假设**：
             * 直接调 handler 的用例（本仓库的 connection 替身就是这么跑的）要能自己判 405，
             * 且将来有人把 `methods` 放宽成含 POST 时，这里不会静默把 RPC 流量当页面接走。
             */
            if (request.method !== 'GET') {
                return new Response('method not allowed', { status: 405 });
            }
            const html = buildCarrierPageHtml(await carrierCaptchaConfig());
            return new Response(html, {
                status: 200,
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    // 每次都现渲染：配置跟着远端 60 秒 TTL 变，缓存这份只会让载体页拿旧 SceneId。
                    'cache-control': 'no-store',
                },
            });
        },
    });
    /**
     * 给 `account.list` 的返回项补上**只存在于凭据里**的展示字段（账号名 / 手机号）。
     *
     * ## 为什么只能在 RPC 层补
     *
     * 账号池（`jet-hub/state.json`）的条目只有 `id`/`provider`/`nickname`/
     * `credentialRef` 等字段，**没有**账号名与手机号 —— 它们在**凭据**里
     * （`user_info.displayName` 与由 17 位 `user_id` 派生的手机号）。
     * 且 `sanitizeAccounts`（`src/jet-hub-store.ts:173-191`）只保留三个字段，
     * 写回池也会被丢掉。故每次列表时从**各账号自己的 ref** 现读。
     *
     * ## ⚠ 只对 zcode 做，且逐条独立失败
     *
     * - 只认 `zcode`：其余 11 个 provider 的凭证形状不同，通读一遍纯属浪费
     *   （`account.list` 是进面板就发的热路径）。
     * - 单条解析失败**不影响整行**：拿不到就不补字段，绝不让账号列表整体失败
     *   （列表可用性远比这两个展示字段重要）。
     *
     * ## 取值顺序：先信凭据里已存的，再现场派生
     *
     * 新凭据由 `readZcodeCredential` / `startLogin` 直接写入 `account_name` /
     * `phone`；**旧凭据**（本次改动之前登录的）没有这两个字段，故现场兜底：
     * 手机号从 `user_id` 派生、账号名回退到**不像占位串**的 `account_label`。
     */
    async function enrichAccountIdentity(accounts, provider) {
        if (provider !== ZCODE.id)
            return [...accounts];
        const out = [];
        for (const account of accounts) {
            try {
                const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                if (!resolved) {
                    out.push(account);
                    continue;
                }
                const credential = JSON.parse(resolved.value);
                const accountName = typeof credential.account_name === 'string'
                    && credential.account_name.trim().length > 0
                    ? credential.account_name.trim()
                    // 旧凭据没有 account_name：只有 `account_label` 不是占位串时才能当名字用。
                    // `id:xxxxxx` 与 `设备xxxxxxxx` 都是兜底产物，展示它们等于没展示。
                    : (typeof credential.account_label === 'string'
                        && credential.account_label.trim().length > 0
                        && !/^id:/.test(credential.account_label)
                        && !/^设备/.test(credential.account_label)
                        ? credential.account_label.trim()
                        : undefined);
                const phone = typeof credential.phone === 'string' && credential.phone.trim().length > 0
                    ? credential.phone.trim()
                    : phoneFromUserId(credential.user_id);
                out.push({
                    ...account,
                    ...(accountName !== undefined ? { accountName } : {}),
                    ...(phone !== undefined ? { phone } : {}),
                });
            }
            catch {
                // 凭据损坏/未配置：保留原条目（这些账号在卡片上会由额度那一栏报错说明）。
                out.push(account);
            }
        }
        return out;
    }
    /**
     * 把上游余额**逐桶**映射成 `CreditBalance`。
     *
     * ## 为什么必须逐桶（而不是只取首桶）
     *
     * `CreditBalance` 的形状是 `{total, packages[], expiredTotal?}` 这类**积分包**
     * 结构，而 ZCode 是「按模型分的 token 额度池」。上游一个 resource bucket
     * = 一个模型一段额度，故**一个桶一个包**。
     *
     * ⚠ 旧实现只取 `buckets[0]`（经 `result.planName`）拼**一个**包，但
     * `balance.total` 用的是 `result.remaining`（**全桶汇总**）—— 多桶账号下
     * 那个包的数字比它自己的 `totalUnits` 还大，自相矛盾，且其余模型的额度
     * 被**静默丢掉**，用户看不出「GLM-5.3 与 GLM-5.3-Flash 各剩多少」。
     *
     * ## 空桶的兜底
     *
     * 上游可能一个桶都不给（实测企业版之外仍有账号只有 0 桶）。此时**不能**返回
     * 空 `packages`（前端会显示成「没有额度」而不是「查不到」），故给一个具名占位包，
     * 让 UI 至少能显示「0 / 0」并带上 `result.planName`。
     */
    function buildZcodeBalance(result) {
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
            // 仍是**全桶汇总**，与 `packages` 逐项之和一致（`fetchZcodeBalance` 的
            // `:251-260` 就是这么累加的）。
            total: result.remaining,
            // ZCode 不在同一响应里区分「已失效包」，故为 0。
            expiredTotal: 0,
            packages,
        };
    }
    /**
     * 分发端点方法到对应的处理器。
     *
     * ⚠️ **opencode 的方法在此之前先试一次**（2026-10-02 修）。
     *
     * 背景：`opencode-rpc.ts` 曾自己调 `rpc.register('jet-hub', …)`，以为能与
     * 本文件的 handler 并存。真机报障「添加失败：unknown method:
     * opencode.addAnonymous」—— Jet Hub **只有这一条通道**（本函数的
     * `connection.fetch.register`），它的 `switch` 穷举所有方法，
     * `default` 直接回 `unknown method` 且不让路。
     *
     * ⚠️ 顺序很重要：必须放在 `switch` **之前**、且 `handleOpencodeRpc` 对不认识
     * 的方法返回 `undefined` —— 否则 opencode 的方法名永远落不到这里，
     * 反过来（switch 先匹配）又会被别的 provider 的 case 误吞。
     */
    async function handleMethod(method, payload, _signal) {
        if (method.startsWith('opencode.')) {
            const handled = await handleOpencodeRpc(ctx, pool, method, payload);
            if (handled !== undefined)
                return handled;
        }
        switch (method) {
            case 'account.list': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                return { ok: true, value: { accounts: await enrichAccountIdentity(accounts, req.provider) } };
            }
            case 'account.create': {
                const req = payload;
                const { provider } = req;
                const id = `${provider}-${shortId()}`;
                const suffix = shortId().toUpperCase();
                const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`;
                // CodeBuddy 系（buddy / workbuddy）共用两步登录流程：
                // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
                // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
                // 参数、X-Product-Code、User-Agent），全部由 product 承载。
                const product = productById(provider);
                if (product !== undefined) {
                    let state;
                    let authUrl;
                    try {
                        const authState = await fetchAuthState(undefined, undefined, product);
                        state = authState.state;
                        // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId
                        authUrl = decorateLoginUrl(authState.authUrl, product);
                    }
                    catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`);
                    }
                    const ref = credentialRef(refName);
                    // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
                    await pool.addAccount({
                        id,
                        provider: product.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    // 后台异步执行完整登录流程，使用同一个 state
                    runBuddyLoginFlow({ openBrowser: () => { }, state, product }).then(async (flow) => {
                        await ctx.credentials.set(ref, flow.access);
                        (product.id === CODEBUDDY.id ? buddy : workbuddy).scheduleRefresh();
                        const credential = parseBuddyCredential(flow.access);
                        await pool.updateAccount(id, {
                            nickname: credential?.nickname ?? id,
                            // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
                            // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
                            expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
                            refreshable: Boolean(credential?.refresh_token),
                        });
                    }).catch((err) => {
                        ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: authUrl } };
                }
                else if (provider === 'codearts') {
                    // CodeArts 也是**回调式**登录（本地回调服务器收授权码），但同样必须
                    // 走两步式：先返回 loginUrl 让前端立刻 window.open，后台再等回调。
                    //
                    // 为什么不能像早期那样 await 整个流程（真实缺陷）：浏览器只在用户
                    // 点击后的短暂窗口（transient activation，约 5 秒）内允许 window.open。
                    // 阻塞数十秒后才返回 URL，弹窗必被拦截并返回 null，前端兜底逻辑
                    // 便执行 `window.location.href = loginUrl`，把整个设置页跳走
                    // ——用户报的「主页面直接跳转过去了」正是此因。
                    const started = await codearts.startLogin({ refName });
                    // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期等真实字段。
                    await pool.addAccount({
                        id,
                        provider: 'codearts',
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (loginResult) => {
                        const credential = parseCodeArtsCredential(loginResult.access);
                        await pool.updateAccount(id, {
                            nickname: credential?.user_name !== undefined && credential.user_name.length > 0
                                ? credential.user_name
                                : id,
                            expiresAt: credential?.expires_at !== undefined
                                ? (Number.isNaN(Date.parse(credential.expires_at)) ? undefined : Date.parse(credential.expires_at))
                                : undefined,
                            refreshable: Boolean(credential?.refresh_token),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background codearts login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === LOBSTERAI.id) {
                    // LobsterAI 与 codearts 同款：回调式登录 + 两步式返回，
                    // 理由见上面的 codearts 分支（弹窗拦截导致主页面被跳转）。
                    const started = await lobsterai.startLogin({ refName });
                    await pool.addAccount({
                        id,
                        provider: LOBSTERAI.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (loginResult) => {
                        const credential = parseLobsteraiCredential(loginResult.access);
                        await pool.updateAccount(id, {
                            // ⚠️ 用 `lobsteraiDisplayNickname`：服务端把**手机号本身**当昵称
                            // 下发且只脱敏到「露末 4 位」，需归一化为末 2 位（用户要求）。
                            nickname: lobsteraiDisplayNickname(credential, id),
                            expiresAt: credential !== undefined ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
                            refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`);
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (isQoderFamily(provider)) {
                    // Qoder 同族（国际版 / 中国版）与 codearts / lobsterai 同款两步式，
                    // 但登录机制不同：它是**设备码轮询**（不开本地回调服务器，见 src/qoder-oauth.ts），
                    // 同样必须在用户授权前返回 loginUrl，理由见上面的 codearts 分支。
                    //
                    // ⚠️ 分支内一律用 `product` / `auth`，**不要**出现 `QODER` 字面量 ——
                    // 否则中国版会拿国际版的域名与 client_id 发请求。
                    const { product, auth } = requireQoderFamily(provider);
                    const started = await auth.startLogin({ refName });
                    // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期等真实字段。
                    await pool.addAccount({
                        id,
                        provider: product.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (loginResult) => {
                        const credential = parseQoderCredential(loginResult.access);
                        // ⚠️ 设备码轮询响应**不带 `user_name`**，故 `credential.nickname` 恒为空
                        // —— 必须补一次 userinfo 才能拿到真实名字，否则账号卡片只能显示
                        // `qodercn-xxxx`（多账号无法区分）。见 `fetchQoderUserNickname` 的说明。
                        //
                        // ⚠️ **失败不阻塞登录**：昵称只是展示信息，拿不到就退回账号 id
                        //（与 `toLoginFlowResult` 对过期时间的处理同原则）。
                        let nickname = credential?.nickname;
                        if ((nickname === undefined || nickname.length === 0) && credential !== undefined) {
                            nickname = await fetchQoderUserNickname(credential, product);
                            // 写回**凭据**（不只账号条目）：账号条目会随 Jet Hub 的账号操作
                            // 整体重写，而凭据里存一份才能在续期后与其它面板都稳定拿到。
                            if (nickname !== undefined && loginResult.access.length > 0) {
                                const updated = withQoderNickname(credential, nickname);
                                await ctx.credentials.set(credentialRef(refName), JSON.stringify(updated));
                            }
                        }
                        await pool.updateAccount(id, {
                            nickname: nickname !== undefined && nickname.length > 0 ? nickname : id,
                            expiresAt: credential !== undefined ? qoderCredentialExpiresAtMs(credential) : undefined,
                            refreshable: credential !== undefined && isQoderRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === TRAE.id) {
                    // TRAE 回调式登录 + 两步式返回（与 LobsterAI / codearts 同因）。
                    const started = await trae.startLogin({ refName });
                    // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期等真实字段。
                    await pool.addAccount({
                        id,
                        provider: TRAE.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (loginResult) => {
                        const credential = parseTraeCredential(loginResult.access);
                        await pool.updateAccount(id, {
                            // ⚠️ 用 `traeDisplayNickname`（手机号优先）而非直接取 `nickname`：
                            // 服务端 ScreenName 是**按 uid 自动生成的默认名**，多账号无法区分
                            // （用户报障 2026-09-27）。见该函数的说明。
                            nickname: traeDisplayNickname(credential, id),
                            expiresAt: credential !== undefined ? traeCredentialExpiresAtMs(credential) : undefined,
                            refreshable: credential !== undefined && isTraeRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${TRAE.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === CLINE.id) {
                    // Cline 是 **WorkOS 设备码轮询**登录（见 src/cline-oauth.ts）：
                    // 与 Qoder 同为「不开本地回调服务器」的轮询式，但判据形态不同 ——
                    // Qoder 看 HTTP 404，Cline 看响应体的 `error: authorization_pending`。
                    //
                    // ⚠️ 与 Qoder 的另一处差异：`startLogin` 内部要先发一次
                    // `POST {workOsBase}/user_management/authorize/device` 拿到设备码，
                    // 才能返回 loginUrl（Qoder 的 URL 是纯本地构造的）。那只是一次
                    // 快速 POST，仍远快于浏览器手势窗口，故两步式的理由与 Qoder 一致。
                    const started = await cline.startLogin({ refName });
                    // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期等真实字段。
                    await pool.addAccount({
                        id,
                        provider: CLINE.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (loginResult) => {
                        const credential = parseClineCredential(loginResult.access);
                        await pool.updateAccount(id, {
                            nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                                ? credential.nickname
                                : id,
                            expiresAt: credential !== undefined ? clineCredentialExpiresAtMs(credential) : undefined,
                            refreshable: credential !== undefined && isClineRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${CLINE.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === LOOMY.id) {
                    // Loomy 走**微信扫码**登录（与其余 provider 同为「两步式」）：
                    // 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
                    // 立即返回 `loginUrl` 让前端 `window.open`。
                    //
                    // ⚠️ **真实缺陷**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
                    // 早期实现要求 `account.create` **必须带 phone**，但表单要等它返回
                    // `loginMode:'sms'` 才渲染 —— 用户根本没机会输入手机号，直接报错，
                    // 表单永远出不来。**顺序死锁**。改用微信扫码后此矛盾消失：
                    // 手机号只在「首次扫码」时由弹窗页自己收集。
                    //
                    // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期。
                    await pool.addAccount({
                        id,
                        provider: LOOMY.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    let started;
                    try {
                        started = await loomy.startWechatLogin();
                    }
                    catch (error) {
                        // 取二维码 uuid 失败（网络/页面结构变化）：删掉占位条目，不留幽灵账号。
                        void pool.removeAccount(id).catch(() => { });
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 Loomy 微信登录（获取二维码失败）：${reason}`);
                    }
                    started.result.then(async (login) => {
                        const result = await loomy.persistWechatLogin(login, { refName });
                        const credential = JSON.parse(result.access);
                        await pool.updateAccount(id, {
                            // 用手机号尾号让多账号可区分（Loomy 无独立昵称接口；
                            // 微信昵称可能有，优先用它）。
                            nickname: login.nickname !== undefined && login.nickname.length > 0
                                ? login.nickname
                                : credential.phone.length >= 4
                                    ? `Loomy ${credential.phone.slice(-4)}`
                                    : id,
                            expiresAt: result.expires > 0 ? result.expires : undefined,
                            // ⚠️ 恒 false：Loomy 无续期端点。
                            refreshable: false,
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${LOOMY.id} wechat login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === RACCOON.id) {
                    // raccoon 走**本地页承载**的微信扫码 / 短信双路径登录（与 Loomy 同型）：
                    // `startLogin` 立即返回指向 127.0.0.1 的 `loginUrl`，后台 await 结果。
                    //
                    // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
                    //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
                    //
                    // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
                    //    登录成功后再回填昵称与 refreshable。失败则删除占位条目。
                    await pool.addAccount({
                        id,
                        provider: RACCOON.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    let raccoonStarted;
                    try {
                        raccoonStarted = await raccoon.startLogin();
                    }
                    catch (error) {
                        // 起本地服务器失败：删掉占位条目，不留幽灵账号。
                        void pool.removeAccount(id).catch(() => { });
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 Raccoon 登录（本地登录页启动失败）：${reason}`);
                    }
                    raccoonStarted.result.then(async (credential) => {
                        const result = await raccoon.persistLogin(credential, { refName });
                        const saved = JSON.parse(result.access);
                        await pool.updateAccount(id, {
                            // ⚠️ 服务端的 `name` 是**自动生成的默认名**（本机账号是
                            // `RaccoonAva`，即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
                            //（`wechat_bindings` 只有绑定 id 与时间，无昵称/头像）。
                            // 它是账号的**正式名字**（JWT payload 里也有 `name`，官方客户端
                            // 就显示它），故**保留**；但若注册第二个账号，服务端很可能又给一个
                            // 相近的默认名 → 多账号重名、无法区分。
                            //
                            // 故追加**手机号尾号**消歧：`RaccoonAva (1100)`。
                            // 与 Loomy 的 `Loomy 2222` 同策略（那边没有真实名字可用，
                            // 这边有，所以保留原名再挂尾号）。
                            nickname: buildRaccoonNickname(saved, id),
                            expiresAt: result.expires > 0 ? result.expires : undefined,
                            // ⚠️ raccoon **有** refresh 端点，与 Loomy（恒 false）不同。
                            refreshable: result.refreshable,
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${RACCOON.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: raccoonStarted.loginUrl } };
                }
                else if (provider === MINIMAX.id) {
                    // MiniMax Code（中国版）走 **OAuth 设备码 + PKCE**（与 Qoder 同型：
                    // 不起本地监听端口，`startLogin` 立即返回指向 `agent.minimax.cn` 的
                    // `verification_uri_complete`，后台轮询换 token）。
                    //
                    // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
                    //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
                    //
                    // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
                    //    登录成功后再回填昵称与 `expiresAt`。失败则删除占位条目。
                    //    写法照 `RACCOON.id` 分支（那是已验证的形态）。
                    await pool.addAccount({
                        id,
                        provider: MINIMAX.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    let minimaxStarted;
                    try {
                        minimaxStarted = await minimax.startLogin();
                    }
                    catch (error) {
                        // 设备码申请失败：删掉占位条目，不留幽灵账号。
                        void pool.removeAccount(id).catch(() => { });
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 MiniMax 登录（设备码申请失败）：${reason}`);
                    }
                    minimaxStarted.result.then(async (credential) => {
                        const result = await minimax.persistLogin(credential, { refName });
                        await pool.updateAccount(id, {
                            // ⚠️ `persistLogin` 的 `accountId` 对真实凭据**恒为 `undefined`** ——
                            // MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、
                            // 0 个点），故 `decodeJwtSub` 恒不命中、`account_id` 不会被写入。
                            // 这是**预期行为**（账号 id 由本层生成），不是缺陷：此时退化为 `id`。
                            // 一旦上游改发 JWT，这里会自动用上服务端的 account_id。
                            nickname: result.accountId === undefined ? id : `MiniMax ${result.accountId.slice(0, 8)}`,
                            // ⚠️ **必须用 `minimaxCredentialExpiresAtMs`**（优先 `expires_at`，
                            // 它由 OAuth 响应的 `expires_in` 自算）—— 不能指望从 token 解 JWT，
                            // 那样会得到 `undefined`，UI 永远显示「未知」。
                            expiresAt: minimaxCredentialExpiresAtMs(credential),
                            // ⚠️ MiniMax **有** refresh 端点（与 Loomy 恒 false 不同）。
                            refreshable: isMinimaxRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${MINIMAX.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: minimaxStarted.loginUrl } };
                }
                else if (provider === ZCODE.id) {
                    /**
                     * zcode 走**两步式**（与 codearts / qoder 等同型）：
                     * 立刻返回官方授权 URL 让前端弹窗，后台轮询等服务端回调完成。
                     *
                     * ⚠ 必须**先返回 URL 再等结果** —— `window.open` 只在用户手势
                     * 窗口内有效（`AGENTS.md` 记过 CodeArts 早期「主页面被跳转」的
                     * 缺陷就是等授权完才返回 URL 导致的）。
                     *
                     * ## 与「读官方客户端凭据」的关系
                     *
                     * 早期实现是「确认磁盘上有一份官方客户端写的凭据」，
                     * 那要求用户先装并登录官方 ZCode —— 与「装完即用」冲突。
                     * 现在改为**插件自己走 OAuth**（实测 `/oauth/cli/init` →
                     * 浏览器授权 → `/oauth/cli/poll/{flow_id}` 完全跑通，
                     * 纯 HTTP、不经 `zcode://` 回调）。
                     *
                     * 若用户**已经**装并登录了官方客户端，则不必点这个按钮 ——
                     * `refreshAll` / 首次加载时会自动把官方凭据固化进来。
                     */
                    /**
                     * ★★ **先复用本机已有账号，不要「点一次多一条」**（用户报障 ⑯）。
                     *
                     * ## 报障原文
                     *
                     * 「然后账号应该读取有效的本地账号凭证，而不是点了添加就多一个，
                     * 还没有删除账号的按钮」
                     *
                     * ## 两道复用（都**不新起** OAuth，故点下去不会多出条目）
                     *
                     * ① **孤儿条目修复**：池里有「条目在、凭据从未写入」的账号
                     *    （上一次登录被进程重启打断的产物）⇒ 把本机官方凭据补进去
                     *    并回填昵称，直接返回该条目。这同时治好了 ⑦「凭据未配置」。
                     * ② **同一账号已在池里**：本机官方凭据的 `user_id` 已属于某个条目
                     *    ⇒ 什么都不用做，如实告知「已存在」并返回它的 id —— 不建新条目、
                     *    不弹浏览器（否则用户会以为是新账号，实际会多出一条重复记录）。
                     *
                     * ⚠ 「本机有没有官方凭据」是**必要条件**：没装客户端、或没登录过时
                     * 两者都跳过，照旧走下面的 OAuth 流程（那是「装完即用」的保证）。
                     */
                    const orphanId = await zcode.adoptIntoOrphanAccount(pool).catch(() => undefined);
                    if (orphanId !== undefined) {
                        // `loginUrl` 用**空串**而不是 undefined：与 `loginMode: 'sms'` 的既有约定
                        // 一致（「没有可打开的 URL」），前端据 `reused` 分支处理。
                        return { ok: true, value: { accountId: orphanId, loginUrl: '', reused: true } };
                    }
                    const local = await zcode.localCredential();
                    if (local !== undefined && typeof local.user_id === 'string' && local.user_id.length > 0) {
                        const holder = await pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', local.user_id);
                        if (holder.length > 0) {
                            return { ok: true, value: { accountId: holder, loginUrl: '', reused: true } };
                        }
                    }
                    const started = await zcode.startLogin({ refName });
                    // 先登记占位条目（无凭据），使前端 `login.poll` 能立即看到该账号；
                    // 登录成功后再回填昵称。失败则删除占位条目。
                    await pool.addAccount({
                        id,
                        provider: ZCODE.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        // ⚠ 静态凭据（JWT 无 exp），没有 refresh 端点 —— 恒 false。
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    started.result.then(async (saved) => {
                        /**
                         * ★★ **重复账号去重**（真实缺陷，2026-10-02）。
                         *
                         * ## 为什么必须做
                         *
                         * 同一账号点两次「添加账号」会得到**两条独立条目** ——
                         * 它们各自参与选号、各自消耗额度，而 UI 上看起来像两个账号
                         * （昵称也一样，无从分辨）。此前 `user_id` 甚至**没有被存进
                         * 凭据**，连判据都没有。
                         *
                         * ## 判据必须是 `user_id`，不能用 `device_mid`
                         *
                         * `device_mid` 在插件登录路径下由我们**随机生成**
                         * （`generateDeviceMid()`，实测其值不被服务端绑定校验）——
                         * **同一账号每次重新登录都会变**。拿它判重会把同一账号
                         * 判成不同账号，反而**永远去重不掉**。
                         * `user_id` 是**服务端下发**的稳定标识，才正确。
                         *
                         * ## 时机：必须在**登录成功之后**
                         *
                         * 登录前只有占位条目（无凭据、无 `user_id`），无从判断 ——
                         * 故去重放在这个回调里，不在 `addAccount` 之前。
                         *
                         * ## ⚠ 处置：**不删条目**，而是把它标成**停用**并改名
                         *
                         * 为什么不直接 `removeAccount(id)`：前端 `login.poll` 是靠
                         * 「条目还在 + 凭据已写入」判断登录成功的。
                         * **删掉条目会让它显示成「登录失败」**，而事实恰恰相反
                         * （登录成功了，只是这个账号已存在）—— 那会误导用户去反复重试。
                         *
                         * 停止则该条目：① 仍在列表里（`login.poll` 如实报告成功）；
                         * ② `enabled: false` ⇒ **不参与自动选号**（这是去重的实际效果）；
                         * ③ 昵称写明「重复」⇒ 用户一眼能看出发生了什么、可自行删除。
                         *
                         * ⚠ 保留**原来那条**（`existingId`）继续可用，不动它：它可能
                         * 已被排序、改名或承载限流记录，删它损失更大。
                         */
                        const userId = saved.credential.user_id;
                        const label = saved.credential.account_label ?? id;
                        if (typeof userId === 'string' && userId.length > 0) {
                            const existingId = await pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', userId);
                            if (existingId.length > 0 && existingId !== id) {
                                ctx.logger.warn(`[jet-hub] zcode 该账号（user_id=${userId}）已存在于 ${existingId}，`
                                    + `新条目 ${id} 已自动停用（不参与选号）`);
                                await pool.updateAccount(id, {
                                    nickname: `ZCode ${label}（重复，已停用）`,
                                    enabled: false,
                                });
                                return;
                            }
                        }
                        await pool.updateAccount(id, { nickname: `ZCode ${label}` });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${ZCODE.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else {
                    return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } };
                }
            }
            case 'account.update': {
                const req = payload;
                await pool.updateAccount(req.accountId, req.patch);
                return { ok: true, value: undefined };
            }
            case 'account.delete': {
                const req = payload;
                await pool.removeAccount(req.accountId);
                return { ok: true, value: undefined };
            }
            // 拖拽排序：重写该 provider 账号在池中的顺序。
            // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
            case 'account.reorder': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
                    return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } };
                }
                try {
                    await pool.reorderAccounts(req.provider, req.orderedIds);
                }
                catch (error) {
                    // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
                    // 刷新重试，而不是抛成 jet-hub/handler-failed 那种「未知故障」。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
                return { ok: true, value: undefined };
            }
            case 'account.refresh': {
                const req = payload;
                try {
                    const accounts = await pool.listAllAccounts();
                    const entry = accounts.find((a) => a.id === req.accountId);
                    if (!entry)
                        throw new Error(`Account ${req.accountId} not found`);
                    // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
                    // 续期入口 —— 三处都是修复既有缺陷的关键：
                    //
                    // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
                    //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
                    // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
                    //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
                    //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
                    //    结果要么报错要么静默改了错的对象。
                    // 3. ⚠️ **每个分支都必须传 `pool` + `entry.id`**（issue !IKIRTT）：
                    //    续期成功后要把新的 `expiresAt` 写回账号池，UI 才不再显示
                    //    「已过期」。早先只有 raccoon 分支传了，其余七个「刷新」下去
                    //    凭据续好了、界面纹丝不动，用户没有任何自救手段。
                    switch (entry.provider) {
                        case 'codearts':
                            await codearts.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case 'buddy':
                            await buddy.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case 'workbuddy':
                            await workbuddy.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case LOBSTERAI.id:
                            await lobsterai.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case QODER.id:
                        case QODER_CN.id:
                            // 同协议族：按 provider 找到对应实例。
                            // ⚠️ 只刷传入的这个 ref，不碰默认单凭据 ref（历史缺陷同因）。
                            // ⚠️ **不要**图省事写 `qoder.refreshAccountCredential(...)` ——
                            // 那会让中国版账号的「刷新」去续国际版的凭据（两站 token 不通用，
                            // CN 永远续不动而国际版被无谓刷一次）。该串用由
                            // `lobsterai-rpc-dispatch.spec.ts` 的行为级用例锁死（已做反向验证）。
                            await requireQoderFamily(entry.provider).auth.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case TRAE.id:
                            await trae.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case CLINE.id:
                            await cline.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case LOOMY.id:
                            // ⚠️ Loomy **没有 refresh 端点**：这里只能做**有效性探测**，
                            // 失效时抛「请重新登录」。见 LoomyAuth.refreshAccountCredential。
                            await loomy.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case RACCOON.id:
                            // raccoon **有** refresh 端点（refresh_token 轮换），这里是真续期。
                            // ⚠️ 只读写传入的 ref，不碰默认单凭据 ref。
                            // ⚠️ **必须传 pool + entry.id**：续期后要把新的 `expiresAt` 写回
                            // 账号池，否则 UI 一直显示「已过期」（真实缺陷：JWT 已续到 15:09、
                            // 账号池仍是 12:02，相差 3.1 小时，但功能完全正常）。
                            await raccoon.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case MINIMAX.id:
                            // MiniMax **有** refresh 端点（`/oauth2/token` 的 refresh_token 授权），
                            // 这里是真续期。⚠️ 必须传 pool + entry.id —— 续期后要把新的
                            // `expiresAt` 写回账号池，否则 UI 一直显示「已过期」。
                            await minimax.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        case ZCODE.id:
                            /**
                             * zcode **没有 refresh 端点**（凭据是静态的，与 Loomy 同类）。
                             *
                             * 但这个方法仍做实事：**重读磁盘凭据并回写** —— 使用户在
                             * 官方 ZCode 客户端重新登录后，点「刷新」即可生效而无需
                             * 重启 DSH。凭据不可用时如实抛错（让用户知道要去官方客户端登录）。
                             */
                            await zcode.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                            break;
                        default:
                            throw new Error(`Unknown provider: ${entry.provider}`);
                    }
                    return { ok: true, value: { success: true } };
                }
                catch (error) {
                    return {
                        ok: true,
                        value: {
                            success: false,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
            }
            case 'login.poll': {
                const req = payload;
                const accounts = await pool.listAllAccounts();
                const entry = accounts.find((a) => a.id === req.accountId);
                if (!entry)
                    return { ok: true, value: { done: false } };
                // 检查凭据是否已实际写入（占位条目没有凭据）。
                //
                // ⚠ **不能只判「resolve 出了非空字符串」**（审查发现）：占位条目被
                //   `credentials.set` 写入过一段**残缺 JSON** 时（例如只有 `zcode_jwt`、
                //   没有 `device_mid`），`resolve` 照样返回字符串，UI 就会弹「账号已添加」
                //   而实际上该账号一发请求就 `凭据无效`。这里对 zcode 追加**形状校验**。
                const ref = credentialRef(entry.credentialRef);
                const resolved = await ctx.credentials.resolve(ref);
                if (!resolved)
                    return { ok: true, value: { done: false } };
                if (entry.provider === ZCODE.id) {
                    let parsed;
                    try {
                        parsed = JSON.parse(resolved.value);
                    }
                    catch {
                        return { ok: true, value: { done: false } };
                    }
                    if (!isUsableZcodeCredential(parsed))
                        return { ok: true, value: { done: false } };
                }
                return { ok: true, value: { done: true, success: true } };
            }
            /**
             * 下发短信验证码（**仅 Loomy，备用登录路径**）。
             *
             * ⚠️ 主路径是**微信扫码**（`account.create` 返回本地弹窗页）。
             * 本端点与 `login.submitSms` 保留为**可独立调用的备用路径** ——
             * 不依赖 `account.create` 的中间态（早期版本从内存表取手机号，
             * 改微信登录后那张表不再被填充，会退化成坏死的死代码）。
             *
             * 手机号由**本端点自己接收**，故可脱离 `account.create` 单独使用。
             */
            case 'login.sendSms': {
                const req = payload;
                if (req.provider !== LOOMY.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const phone = typeof req.phone === 'string' ? req.phone.trim() : '';
                if (!/^1[3-9]\d{9}$/.test(phone)) {
                    return { ok: false, error: { code: 'bad-request', message: '需要 11 位有效手机号（phone）' } };
                }
                const msgid = await loomy.sendSmsCode(phone);
                // 暂存在内存，供 submitSms 取用（一次性中间态，不写凭据存储）。
                pendingSmsMsgid.set(req.accountId, { phone, msgid });
                return { ok: true, value: { msgid } };
            }
            /**
             * 提交短信验证码完成登录（**仅 Loomy，备用登录路径**）。
             *
             * 成功后：写凭据 → 回填账号昵称/有效期 → 清理中间态。
             */
            case 'login.submitSms': {
                const req = payload;
                if (req.provider !== LOOMY.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const pending = pendingSmsMsgid.get(req.accountId);
                if (pending === undefined || pending.msgid.length === 0) {
                    return {
                        ok: true,
                        value: { done: false, error: '请先发送验证码' },
                    };
                }
                const account = pool.findAccount(req.accountId);
                if (account === undefined) {
                    return {
                        ok: true,
                        value: { done: false, error: '账号不存在（可能已被删除）' },
                    };
                }
                try {
                    const result = await loomy.loginWithSmsCode(pending.phone, req.code, pending.msgid, {
                        refName: account.credentialRef,
                    });
                    const credential = JSON.parse(result.access);
                    await pool.updateAccount(req.accountId, {
                        // Loomy 无昵称接口，用手机号尾号让多账号可区分（比 `loomy-xxxx` 有用）。
                        nickname: credential.phone.length >= 4
                            ? `Loomy ${credential.phone.slice(-4)}`
                            : req.accountId,
                        expiresAt: result.expires > 0 ? result.expires : undefined,
                        // ⚠️ 恒 false：Loomy 无续期端点。
                        refreshable: false,
                    });
                    pendingSmsMsgid.delete(req.accountId);
                    return { ok: true, value: { done: true } };
                }
                catch (error) {
                    // ⚠️ 登录失败**不删除占位条目**：用户可能只是验证码输错，
                    // 保留条目让他能重试（`login.sendSms` 会重新发码）。
                    return {
                        ok: true,
                        value: {
                            done: false,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
            }
            /**
             * 查询新手任务 / 一次性奖励状态（**Loomy** 的新手任务、**raccoon** 的登录奖励，只读）。
             *
             * ⚠️ 只读：**不得**在此触发任何 `complete`/`claim`（面板挂载时会调用它）。
             * ⚠️ 两个 provider 共用本端点，故判据是「属于其中之一」而非只认 Loomy。
             */
            case 'onboarding.status': {
                const req = payload;
                if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const account = pool.findAccount(req.accountId);
                if (account === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: '账号不存在' } };
                }
                const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                if (!resolved) {
                    return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } };
                }
                if (req.provider === RACCOON.id) {
                    // raccoon 只有**一项**一次性奖励（桌面端登录奖励 3000 分），
                    // 把它映射成 Loomy 那套「任务」形状的一项，复用同一个 RPC 与 UI。
                    // ⚠️ 已领状态靠**账单反查**（服务端没有单独的状态端点）。
                    const credential = JSON.parse(resolved.value);
                    const status = await raccoon.fetchOnboardingStatus(credential);
                    return {
                        ok: true,
                        value: {
                            // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
                            tasks: { desktop_login_reward: status.claimed },
                            earned: status.claimed ? status.points : 0,
                            total: status.points,
                            titles: { desktop_login_reward: '桌面端登录奖励（每号一次）' },
                            points: { desktop_login_reward: status.points },
                        },
                    };
                }
                const credential = JSON.parse(resolved.value);
                const state = await loomy.fetchOnboardingTasks(credential);
                return {
                    ok: true,
                    value: {
                        tasks: state.tasks,
                        earned: state.earned,
                        total: state.total,
                        titles: { ...LOOMY_TASK_TITLES },
                        points: { ...LOOMY_TASK_POINTS },
                    },
                };
            }
            /**
             * 「锁定永久积分」开关（读 / 写，**provider 维度**）。
             *
             * **用户需求**：锁定后选号只允许消耗**会近期作废**的积分，永久积分不参与 ——
             * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
             * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
             *
             * 三个 provider 都有这件事，但「什么算永久积分」不同（Loomy 看服务端的每日
             * 池字段；两个 buddy 看资源包扣费截止距今是否满 15 天，判据见
             * `buddy-balance-rank.ts`）。**语义相同、判据不同**，故共用一个端点与一张
             * 持久化表，而不是各加一条 case —— 平行分支越多，漏接概率越高。
             *
             * ⚠️ 开关是 **provider 级**（不分账号），持久化在
             * `$DSH_HOME/jet-hub/permanent-locks.json` 的 `locks` 表里（**不放 state.json**：
              * 那份文档同机多 profile 共享，另一条工作区的旧版本整体重写它时不会带上
              * 自己不认识的键 —— 理由见 `src/permanent-lock-store.ts` 文件头）
             * （`loomyPermanentLocked` 是同一值的兼容副本，见 `jet-hub-store.ts`）。
             *
             * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
             */
            case 'credits.permanentLock':
            /**
             * Loomy 的历史端点名 —— 与上面**同一实现**，只是 provider 固定为 loomy
             * （老客户端 bundle 仍在调它，直接删会让 Loomy 面板的按钮静默失效）。
             */
            case 'loomy.permanentLock': {
                const req = payload;
                // 老端点不认 provider 参数：即便载荷里带了也别照着执行。
                const provider = method === 'loomy.permanentLock'
                    ? LOOMY.id
                    : (typeof req.provider === 'string' ? req.provider.trim() : '');
                if (!PERMANENT_LOCK_PROVIDERS.has(provider)) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `该 provider 不支持锁定永久积分：${provider || '(空)'}` },
                    };
                }
                /**
                 * 组装响应。
                 *
                 * ⚠️ 两个 buddy 必须**回传当前生效的窗口天数**：窗口可被
                 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端文案若继续写死 15 就会
                 * 与真实判据不一致（用户看到「只烧 15 天内的」而实际按 31 天筛号）。
                 * Loomy 没有窗口概念 → 不带该字段。
                 */
                const lockResponse = () => ({
                    provider,
                    locked: pool.permanentLocked(provider),
                    ...(provider === CODEBUDDY.id || provider === WORKBUDDY.id
                        ? { windowDays: buddyExpiringWindowDays() }
                        : {}),
                });
                if (req.locked === undefined) {
                    return { ok: true, value: lockResponse() };
                }
                if (typeof req.locked !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: 'locked 必须是布尔值' } };
                }
                await pool.setPermanentLocked(provider, req.locked);
                // ⚠️ 与 `model.setDisabled` 同理：本次写入会改变**选号结果**
                // （进而改变哪些账号会被使用），故广播一次让界面重新读取状态。
                // 包 try/catch：通知失败不能反噬已经落盘的开关。
                try {
                    ctx.emit('llm/adapters-updated');
                }
                catch (error) {
                    ctx.logger?.warn?.(`[jet-hub] 广播 llm/adapters-updated 失败（不影响已保存的开关）: ${String(error)}`);
                }
                return { ok: true, value: lockResponse() };
            }
            /**
             * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
             *
             * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
             *（每日签到）语义完全不同，故独立端点。
             */
            case 'onboarding.claim': {
                const req = payload;
                // ⚠️ 两个 provider 共用本端点（Loomy 的新手任务 / raccoon 的登录奖励）。
                if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const account = pool.findAccount(req.accountId);
                if (account === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: '账号不存在' } };
                }
                const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                if (!resolved) {
                    return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } };
                }
                if (req.provider === RACCOON.id) {
                    // raccoon 的领取端点是**幂等**的：已领过返回 `granted:false`，
                    // 此时 claimed 为空数组、skipped 含该项。
                    //
                    // ⚠️ **已领时 `earned` 必须报满分，不是 0**（真实缺陷，用户报障）。
                    // `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」
                    // 无关。早期在 `already-claimed` 分支写 `earned: 0`，于是 UI 显示
                    // 「✅ 1 个此前已完成 / 累计已领 0 / 3000」—— **自相矛盾**：
                    // 既然「此前已完成」，那 3000 分显然已经拿到手了。
                    const credential = JSON.parse(resolved.value);
                    const outcome = await raccoon.claimLoginReward(credential);
                    if (outcome.kind === 'failed') {
                        return { ok: false, error: { code: 'bad-request', message: outcome.message } };
                    }
                    const claimed = outcome.kind === 'claimed'
                        ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
                        : [];
                    // 已领时的金额从**账单反查**取得（领取响应体里没有它），
                    // 与 `onboarding.status` 同一数据源 —— 否则两处会显示不同的数字
                    //（例如活动金额变化后，一处 3000、一处 3500）。
                    // 只读 GET，且仅在「点按钮时已领」这一低频路径上发生。
                    const points = outcome.kind === 'claimed'
                        ? outcome.credit
                        : (await raccoon.fetchOnboardingStatus(credential)).points;
                    return {
                        ok: true,
                        value: {
                            claimed,
                            skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
                            // 该项目累计已领 = 满分（无论本次是否新增）。
                            earned: points,
                            total: points,
                        },
                    };
                }
                const credential = JSON.parse(resolved.value);
                const result = await loomy.claimOnboardingTasks(credential);
                return {
                    ok: true,
                    value: {
                        claimed: result.claimed.map((item) => ({
                            key: item.key,
                            title: LOOMY_TASK_TITLES[item.key] ?? item.key,
                            points: item.points,
                        })),
                        skipped: result.skipped,
                        earned: result.earned,
                        total: result.total,
                    },
                };
            }
            // ── 限流标记：重测（发真实请求验证）──
            // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
            // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
            case 'account.retest': {
                const req = payload;
                const account = await retestAccount(pool, req.accountId);
                return {
                    ok: true,
                    value: { accounts: [account], clearedCount: account.cleared.length },
                };
            }
            // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
            // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
            case 'account.retestAll': {
                const req = payload;
                const value = await retestAllAccounts(pool, req.provider);
                return { ok: true, value };
            }
            // ── 限流标记：重置（不发请求，直接清除）──
            case 'account.reset': {
                const req = payload;
                const value = await resetAccount(pool, req.accountId);
                return { ok: true, value };
            }
            case 'account.resetAll': {
                const req = payload;
                const value = await resetAllAccounts(pool, req.provider);
                return { ok: true, value };
            }
            // ── 每日签到（积分领取）──
            // 查询某 provider 下全部启用账号的签到状态。
            //
            // 四个 provider 分属**三套互不相同的协议**，各自在自己的分支里处理：
            //   - CodeBuddy 系（buddy / workbuddy）：`productById()` 取 BuddyProduct，
            //     走 `collectCreditsStatus` 的默认实现；
            //   - `lobsterai`：slot → context 三步，无独立状态端点；
            //   - `codearts`：华为云 SDK-HMAC-SHA256 签名，无独立状态端点。
            //
            // ⚠️ 只有 CodeBuddy 系能经 `productById()` 解析出产品配置；后两者
            // **必须各自提前分支**，否则会落到下面的 bad-request。历史上 CodeArts
            // 就是因此恒回 `unsupported provider: codearts`（客户端在面板挂载时
            // 无条件调用 credits.balances，于是每打开一次设置页都在控制台报错并把
            // 账号卡片标成查询失败）。现在 CodeArts 已有真实实现，该 bad-request
            // 只对**未知** provider 生效。
            case 'credits.status': {
                const req = payload;
                if (req.provider === 'codearts') {
                    // CodeArts 没有独立的「签到状态」端点：可领状态要经
                    // `statistics/plugin`（账户类型）+ `/v1/ops/delivery`（活动列表）
                    // 两步才能得到，且语义与 CodeBuddy 的 CheckinStatus 不同构
                    //（无 streak_days / daily_credit 等概念）。
                    // 故与 LobsterAI 同样如实返回 null，而不是臆造一份状态对象。
                    const accounts = await pool.listAccounts(req.provider);
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
                        },
                    };
                }
                if (req.provider === LOBSTERAI.id) {
                    // LobsterAI 没有独立的「签到状态」端点：活动状态要经
                    // slot → context 两步才能得到，且语义与 CodeBuddy 的
                    // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
                    // 故这里如实返回 null，而不是臆造一份状态对象。
                    const accounts = await pool.listAccounts(req.provider);
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
                        },
                    };
                }
                if (req.provider === TRAE.id) {
                    // TRAE 有签到状态端点，但需要发起 Ug 请求获取（见 claim 内部的多步流程）。
                    // 与 LobsterAI/CodeArts 一样如实返回 null，由 claimAll 自行处理预检。
                    const accounts = await pool.listAccounts(req.provider);
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
                        },
                    };
                }
                if (req.provider === CLINE.id) {
                    // Cline **没有签到端点**（对整个 sidecar 二进制做字符串扫描，
                    // checkin / check-in / daily / campaign 均无任何 Cline 业务端点命中；
                    // 见 src/cline-credits.ts 的模块注释）。故与 WorkBuddy 国际版一致，
                    // 如实返回 null，而不是臆造一份状态对象。
                    const accounts = await pool.listAccounts(req.provider);
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
                        },
                    };
                }
                if (req.provider === LOOMY.id) {
                    // Loomy 没有独立的「签到状态」端点：每日额度由 `POST /points/first-login`
                    // 触发，其响应自带 `alreadyProcessed`。故与 LobsterAI/CodeArts 同样
                    // 如实返回 null，由 claimAll 内部处理幂等。
                    const accounts = await pool.listAccounts(req.provider);
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
                        },
                    };
                }
                if (req.provider === MINIMAX.id) {
                    // ⚠️ MiniMax **有**独立的签到状态端点（`/minimax-cloud/api/v1/signin/status`），
                    // 与 LobsterAI/TRAE/Cline 那几个「如实返回 null」的 provider 不同 ——
                    // 故走共享 helper 真查（`fetchMinimaxSigninStatus` 失败时返回 null，
                    // 由 helper 逐账号 try/catch 兜住，单账号失败不中断整体）。
                    //
                    // ⚠️ **判据是 `is_today && status===3`**（见 `minimaxPanelToCheckinStatus`），
                    // 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
                    const minimaxStatusAccounts = await pool.listAccounts(req.provider);
                    const value = await collectCreditsStatus(minimaxStatusAccounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: { accounts: value } };
                }
                const product = productById(req.provider);
                if (product === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const accounts = await pool.listAccounts(req.provider);
                const results = await collectCreditsStatus(accounts, product, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: { accounts: results } };
            }
            // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
            case 'credits.claimAll': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                if (isQoderFamily(req.provider)) {
                    const { product } = requireQoderFamily(req.provider);
                    // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
                    // 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
                    // （与 LobsterAI 传 false 的理由同类）。
                    //
                    // ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
                    // HTTP 200），已在 claimQoderCampaign 内部处理。
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        claim: (credential) => claimQoderDailyCheckin(credential, product),
                        precheckStatus: false,
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === 'codearts') {
                    // CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
                    // 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
                    // 故 precheckStatus: false 跳过外部那次 CodeBuddy 式的状态查询 ——
                    // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        claim: (credential) => claimCodeArtsDailyCheckin(credential),
                        precheckStatus: false,
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === LOBSTERAI.id) {
                    // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
                    //（带缓存，通常无额外网络开销）。
                    const clientVersion = await lobsterai.resolveClientVersion();
                    const value = await collectClaimResults(accounts, LOBSTERAI, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        claim: (credential, product) => claimLobsteraiDailyCheckin(credential, product, clientVersion),
                        // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
                        precheckStatus: false,
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === TRAE.id) {
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
                        //
                        // TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
                        // `{code:0, message:"success"}`，与真正领取成功**无法区分**。
                        // 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
                        // 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
                        // 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
                        // 判据只能是 status 端点的 `checked_in`。
                        fetchStatus: (credential) => fetchTraeCheckinStatus(credential, TRAE, fetch),
                        claim: (credential, _product, entry) => claimTraeDailyCheckin(credential, TRAE, fetch, pool.traeCheckinDeviceGenerationFor(entry.id), (next) => pool.updateTraeCheckinDeviceGeneration(entry.id, next)),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === LOOMY.id) {
                    // Loomy 的「签到」= `POST /points/first-login`（触发每日赠送额度）。
                    // ⚠️ 语义**不是**「+5000 积分」：`dailyBalance = dailyQuota - dailyConsumed`，
                    // 消耗后不回补。文案由 claimLoomyDailyQuota 的 already-claimed 表达。
                    // 领取流程自带幂等判据（`alreadyProcessed`），故不做额外预检。
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                outcome: { kind: 'failed', code: -1, message: '凭据未配置' },
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                outcome: { kind: 'failed', code: -1, message: '凭据解析失败' },
                            });
                            continue;
                        }
                        const outcome = await loomy.claimDailyQuota(credential);
                        values.push({ accountId: account.id, nickname: account.nickname, outcome });
                    }
                    return {
                        ok: true,
                        value: {
                            summary: computeClaimSummary(values.map((v) => v.outcome)),
                            results: values,
                        },
                    };
                }
                if (req.provider === CLINE.id) {
                    // Cline **没有签到端点**（见 src/cline-credits.ts 的模块注释：
                    // 对整个 sidecar 做字符串扫描，无任何 checkin/campaign 业务端点）。
                    // 客户端按能力矩阵（`credits-capabilities.js` 的
                    // `cline: { balance: true, dailyCheckin: false }`）根本不会渲染
                    // 「一键领取积分」按钮、也不会发起本调用；这里显式返回可读错误，
                    // 而不是落到下面 `productById` 的 `unsupported provider` 泛化文案
                    // —— 后者会让排查者以为是「provider 没注册」，而真相是「该产品无此能力」。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: 'Cline 不支持每日签到（其后端没有签到接口）',
                        },
                    };
                }
                if (req.provider === 'workbuddy') {
                    // WorkBuddy **国际版没有签到接口**：客户端能力矩阵登记为
                    // `workbuddy: { balance: true, dailyCheckin: false }`，故它从不渲染
                    // 「一键领取积分」按钮、也从不调用本方法 —— 也就是说这条守卫此前
                    // **缺失但没被触发**（真实缺陷，2026-10-02 补）。
                    //
                    // ⚠️ 为什么必须补：没有它时 `workbuddy` 会落到下面 `productById` 拿到的
                    // buddy 产品上，用**国际版**凭据去发国内版的签到请求 —— 必然失败，而且是
                    // 一次真实的上游请求。而「每日首次启动自动签到」（`src/auto-checkin.ts`）
                    // 正是靠「调用 `claimAll`、按返回的信封判跳过」来决定遍历范围的，它**不维护
                    // 第二份能力名单** ⇒ 这里漏一个守卫，它就会真去发一轮必然失败的请求。
                    // 两处是同源改动，别只改一半。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
                        },
                    };
                }
                if (req.provider === RACCOON.id) {
                    // raccoon **没有签到端点**：每日 300 积分由服务端按日自动发放
                    //（账单里的 `daily_grant`，实测注册后 1 分钟即到账），
                    // 客户端按能力矩阵（`raccoon: { balance: true, onboardingTasks: true }`，
                    // **无** `dailyCheckin`）根本不会渲染「一键领取积分」按钮、也不会发起本调用。
                    // 这里显式返回可读错误，而不是落到下面 `productById` 的
                    // `unsupported provider` 泛化文案 —— 后者会让排查者以为是
                    //「provider 没注册」，而真相是「该产品无此能力」。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
                        },
                    };
                }
                if (req.provider === MINIMAX.id) {
                    // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
                    //
                    // 理由与 TRAE 那条同型（见上方 TRAE 分支的详细注释）：MiniMax 的
                    // `claimMinimaxDailyCheckin` 靠响应体的 `claim_result` 判幂等
                    //（`1`=真领取、`2`=已领过），这在 **HTTP 层**是可靠的；但状态预检是
                    // 第二道防线 —— 若某天服务端对已领账号也回 `claim_result: 1`，
                    // 预检能靠 `todayCheckedIn` 先挡住，避免把「今天已领」报成「+积分」。
                    // 反之传 false 会让已签到账号走到 claim 请求（多发一次 POST）。
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
                        claim: (credential) => claimMinimaxDailyCheckin(credential),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === ZCODE.id) {
                    /**
                     * ZCode 的「一键领取」= 补激活上报 → preview → 逐个 claim。
                     *
                     * ⚠ **每个 plan 都要重新产一个 captcha**（captcha 一次性，
                     * 复用会得 `3007`，这条路径每个 plan 都现产新的）—— 故不能复用 `collectClaimResults`
                     * 那套「一个凭据一次 claim」的形状（它假设 `claim()` 内部
                     * 自己处理幂等），这里自己遍历账号与 plan。
                     *
                     * ⚠ ZCode **没有**独立的「今日是否已领」端点，故不调
                     * `precheckStatus`（`claimDailyWith` **自带**激活上报与
                     * preview 查询，重复调用只会多发一次无谓请求）。
                     */
                    const results = [];
                    const outcomes = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        let accountOutcomes;
                        if (!resolved) {
                            accountOutcomes = [{ kind: 'failed', code: -1, message: '凭据未配置' }];
                        }
                        else {
                            let credential;
                            try {
                                credential = JSON.parse(resolved.value);
                            }
                            catch {
                                credential = undefined;
                            }
                            if (credential === undefined) {
                                accountOutcomes = [{ kind: 'failed', code: -1, message: '凭据解析失败' }];
                            }
                            else {
                                /**
                                 * captcha 回调：每次都现产一个新 param。
                                 * 缺浏览器时抛错由 `claimDailyFor` 内部转成可读的
                                 * failed outcome（不让整个端点失败）。
                                 */
                                accountOutcomes = await zcode.claimDailyFor(credential, async () => {
                                    const config = await zcode.fetchCaptchaConfig().catch(() => undefined);
                                    return await zcode.mintCaptcha(config);
                                });
                            }
                        }
                        // ⚠ 一个账号可能有多条 outcome（多个 plan）——
                        // `RpcCreditsClaimAccountResult` 只装一条，故逐条展开。
                        for (const outcome of accountOutcomes) {
                            results.push({ accountId: account.id, nickname: account.nickname, outcome });
                            outcomes.push(outcome);
                        }
                    }
                    return {
                        ok: true,
                        value: { results, summary: computeClaimSummary(outcomes) },
                    };
                }
                const product = productById(req.provider);
                if (product === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const value = await collectClaimResults(accounts, product, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: value };
            }
            // 积分余额（Credits Balance）：逐账号顺序查询。
            //
            // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
            // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
            // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
            case 'credits.balances': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                if (req.provider === 'codearts') {
                    // 余额来自 `statistics/plugin`（与账户类型检测同一个响应），
                    // 故用带原因的钩子：非积分账户要显示「Token 计费账户」而不是
                    // 误导性的「余额查询失败」。
                    const values = await collectCreditBalances(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchBalanceDetailed: async (credential) => {
                            // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
                            // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
                            // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
                            // 无信息量的「账户信息查询失败」）。
                            const result = await fetchCodeArtsAccountInfoDetailed(credential);
                            if (!result.ok)
                                return { balance: null, error: `账户信息查询失败：${result.message}` };
                            const info = result.info;
                            if (!info.isCreditPackage) {
                                return {
                                    balance: null,
                                    error: info.isTokenPackage
                                        ? 'Token 计费账户，无积分余额'
                                        : '非积分计费账户，无积分余额',
                                };
                            }
                            // 积分账户但没有 credit metric：如实报「无积分数据」，
                            // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
                            if (info.credit === undefined)
                                return { balance: null, error: '未返回积分数据' };
                            return { balance: info.credit };
                        },
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === LOBSTERAI.id) {
                    const values = await collectCreditBalances(accounts, LOBSTERAI, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    // ⚠️ LobsterAI 也回传窗口天数（用户报障「账号的积分没按长期、临时方式
                    // 显示」）：它的每个资源包都带 `expiresAt`（已归一化到
                    // `deductionEndTime`），面板要按到期远近分「长期 / 临时」。
                    // 窗口语义与 buddy / TRAE 一致，共用同一个环境变量。
                    return {
                        ok: true,
                        value: {
                            accounts: values,
                            windowDays: buddyExpiringWindowDays(),
                        },
                    };
                }
                if (isQoderFamily(req.provider)) {
                    const { product } = requireQoderFamily(req.provider);
                    // 余额来自 `GET {product.openApiBase}/sash/api/v2/me/usage`（实测只需
                    // Bearer + Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
                    // `fetchQoderCreditBalance` 只吃 QoderCredential，故这里不用
                    // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据未配置',
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据解析失败',
                            });
                            continue;
                        }
                        const balance = await fetchQoderCreditBalance(credential, product);
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            balance,
                            // 查不到时带上原因，卡片显示原因而非 0（与其它 provider 同约定）。
                            ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
                        });
                    }
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === OPENCODE.id) {
                    // ⚠️⚠️ **这里不查远端余额**（设计决定，2026-10-02，与用户确认走「限额状态」路 A）。
                    //
                    // ## 为什么
                    //
                    // OpenCode Zen **没有公开的余额查询端点**：实测 `/zen/v1/` 下的
                    // `balance` / `credits` / `usage` / `billing` / `quota` / `limits` /
                    // `subscription` / `workspace` 等 15 个候选路径**全部 404**
                    // （返回官网页面 HTML，不是 API 的 JSON 404）。
                    // 它确实有额度概念（余额耗尽回 `402 Insufficient account funds`），
                    // 但那个数字只在控制台网页里看，没有 API 可查。
                    //
                    // ⇒ 徽标展示**我们真正测得到的东西**：每个通道（账号槽 / 匿名通道）
                    // 当前是否可用、是否处于限额冷却。数据全部来自**本地状态**
                    // （账号池的 `modelRateLimits` 与 `enabled`），**零网络请求**。
                    //
                    // ## 语义映射（不伪装成「余额」）
                    //
                    // `CreditBalance.total` 在此表示「**当前可用通道数**」，单位固定
                    // 「通道」；限额中的通道数放进 `expiredTotal`，面板据此显示
                    // 「另有 N 限额中」——与其它 provider 的「已失效资源包」口径一致，
                    // 徽标的 UI 逻辑不用改。
                    const values = accounts.map((account) => {
                        const now = Date.now();
                        const limits = Object.entries(account.modelRateLimits ?? {});
                        const limitedUntil = limits.reduce((max, [, resetAt]) => Math.max(max, Number(resetAt) || 0), 0);
                        // 只数**尚未到期**的限额（已过期的交给 sweepExpiredRateLimits 清理）。
                        const limitedModels = limits.filter(([, resetAt]) => Number(resetAt) > now).length;
                        const available = account.enabled && limitedUntil <= now ? 1 : 0;
                        // ⚠️ `CreditPackage` 的必填字段对 opencode 大多**无意义**
                        // （remaining/used/cycle* 都是「资源包计费周期」的概念，
                        // 而我们表达的是「通道是否可用」）。按类型要求填中性值，
                        // 徽标 UI 实际只读 `unit` / `total` / `active`（见 badge-model.js
                        // 的 creditGroupsOf），故这些字段不会出现在展示里。
                        const balance = {
                            total: available,
                            packages: [{
                                    name: limitedModels > 0 ? `${limitedModels} 个模型限额中` : '可用通道',
                                    unit: '通道',
                                    remaining: available,
                                    total: available,
                                    used: 0,
                                    active: true,
                                    cycleStartTime: '',
                                    cycleEndTime: '',
                                    expiredTime: '',
                                }],
                            expiredTotal: account.enabled && limitedUntil > now ? 1 : 0,
                        };
                        return {
                            accountId: account.id,
                            nickname: account.nickname,
                            balance,
                            ...(!account.enabled
                                ? { error: '已停用' }
                                : limitedUntil > now
                                    ? { error: `限额中，${new Date(limitedUntil).toLocaleString('zh-CN')} 恢复` }
                                    : {}),
                        };
                    });
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === TRAE.id) {
                    const values = await collectCreditBalances(accounts, TRAE, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchBalance: (credential, product) => fetchTraeCreditBalance(credential, product),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    // ⚠️ TRAE 也回传窗口天数：它的资源包现在带 `deductionEndTime`
                    // （条目级 `expire_time`，秒→毫秒），面板要按「长期 / 临时」分桶显示。
                    // 没有窗口天数前端会拒绝渲染分类行（见 credit-expiry.js 的
                    // normalizeWindowDays —— 非 buddy provider 不带该字段被视为
                    // "没有作废维度"，这是防止凭空渲染假分类行的门禁）。
                    // 窗口语义与 buddy 系一致：距到期不足 windowDays 的算「临时」。
                    return {
                        ok: true,
                        value: {
                            accounts: values,
                            windowDays: buddyExpiringWindowDays(),
                        },
                    };
                }
                if (req.provider === MINIMAX.id) {
                    // 余额来自 `GET /minimax-cloud/api/v1/credit/details`。
                    //
                    // ⚠️ **该端点是平铺响应**（`total_count` 与 `base_resp` 同级、**没有
                    // `data` 键**）—— 与签到端点不同。`fetchMinimaxCreditBalance` 内部已
                    // 用 `unwrapEnvelopeData` 兼容两种形状。
                    // ⚠️ 查不到时（null）由 helper 统一补「余额查询失败」文案，卡片显示
                    // 原因而非 0 —— 这与「余额为 0」是**两回事**，不能混为一谈
                    //（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
                    const values = await collectCreditBalances(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchBalance: (credential) => fetchMinimaxCreditBalance(credential),
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === CLINE.id) {
                    // 余额来自 `GET /api/v1/users/{accountId}/balance`（实测
                    // `{data:{userId, balance}, success:true}`）。与 Qoder 分支同因：
                    // `fetchClineCreditBalance` 只吃 ClineCredential，故不用
                    // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
                    //
                    // ⚠️ 账号 id 必须用凭据里的 `account_id`（`usr-…`），**不是** JWT 的
                    // `sub`（`user_…`）—— 传后者实测返回 `400 Invalid request format`。
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据未配置',
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据解析失败',
                            });
                            continue;
                        }
                        const result = await fetchClineCreditBalance(credential, CLINE);
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            balance: result.balance,
                            // 查不到时带上**具体原因**（含 HTTP 状态码与错误体摘要），
                            // 而不是笼统一句「查询失败」—— 卡片显示原因而非 0
                            //（0 是「已用光」的语义，会误导用户）。
                            ...result.balance === null
                                ? { error: result.error ?? '积分查询失败（凭据失效或响应异常）' }
                                : {},
                        });
                    }
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === LOOMY.id) {
                    // 余额来自 `GET /points/records`（**只读**，无副作用）。
                    // ⚠️ 刻意不用 `first-login`：那是**写**端点，在「打开面板」这种
                    // 高频路径上调用会意外触发签到。
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据未配置',
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据解析失败',
                            });
                            continue;
                        }
                        const balance = await loomy.fetchCreditBalance(credential);
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            balance,
                            // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
                            ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
                        });
                    }
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === RACCOON.id) {
                    // 余额来自 `GET /points/v1/balance`（**只读**，无副作用）。
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据未配置',
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据解析失败',
                            });
                            continue;
                        }
                        const balance = await raccoon.fetchCreditBalance(credential);
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            balance,
                            // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
                            // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
                            ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
                        });
                    }
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === ZCODE.id) {
                    /**
                     * 余额来自 `GET /zcode-plan/billing/balance`（**只读**，无副作用）。
                     *
                     * ⚠ ZCode 的额度单位是 **token**，而 Jet Hub 这个字段的语义是
                     * 「积分」。两者量纲不同 —— 但都要展示，故这里如实返回数值
                     * 并在错误文案里说明来源。`balance: null` 表示**查不到**
                     * （不显示成 0，0 是「已用光」的语义）。
                     */
                    const values = [];
                    for (const account of accounts) {
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                        if (!resolved) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据未配置',
                            });
                            continue;
                        }
                        let credential;
                        try {
                            credential = JSON.parse(resolved.value);
                        }
                        catch {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '凭据解析失败',
                            });
                            continue;
                        }
                        const result = await zcode.fetchBalanceFor(credential);
                        if (result === undefined) {
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '额度查询失败（凭据失效或网络异常）',
                            });
                            continue;
                        }
                        if (result.enterprise === true) {
                            // 企业版不下发额度数字、只给外部链接 —— 如实说明，不显示 0。
                            values.push({
                                accountId: account.id, nickname: account.nickname,
                                balance: null, error: '企业版账号不下发额度数字，请在 ZCode 内查看',
                            });
                            continue;
                        }
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            /**
                             * ⚠ `CreditBalance` 的形状是 `{total, packages[], expiredTotal?}`
                             * 这类**积分包**结构，而 ZCode 是「按日的 token 额度池」。
                             * 两者结构不同，故**逐桶**如实映射 —— 上游一个 resource bucket
                             * 就是一个包，包名用 `show_name`（实测是模型名，如
                             * `GLM-5.3-Flash`）。
                             *
                             * ## ⚠⚠ 这里曾经只映射 `buckets[0]`（真实缺陷）
                             *
                             * 旧实现只取 `result.planName`（= `buckets[0]?.showName`）拼**一个**
                             * 包 —— 多桶账号的其余额度被**静默丢掉**，UI 上看起来只有
                             * 一个模型的额度。而 `result.remaining` / `total` 却是**全桶汇总**，
                             * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
                             *
                             * 实测（本机账号）上游只回一个桶（`GLM-5.3-Flash`），
                             * 但**不能按「只有一个桶」来写** —— 那正是把缺陷固化成契约；
                             * 且用户要看的恰恰是「GLM-5.3 与 GLM-5.3-Flash 各自剩多少」，
                             * 前端需要按模型逐行渲染、缺桶的模型显示占位。
                             */
                            balance: buildZcodeBalance(result),
                        });
                    }
                    return { ok: true, value: { accounts: values } };
                }
                const product = productById(req.provider);
                if (product === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const values = await collectCreditBalances(accounts, product, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                // ⚠️ 只有 buddy 系会走到这里（`productById` 只认 CodeBuddy / WorkBuddy），
                // 而它们正是唯一需要「窗口天数」的 provider：面板要把资源包分成
                // 临时 / 永久两桶显示，窗口必须**由后端给出**（可被
                // DSH_BUDDY_EXPIRING_WINDOW_DAYS 覆盖），前端写死就会与选号判据分叉。
                return {
                    ok: true,
                    value: {
                        accounts: values,
                        windowDays: buddyExpiringWindowDays(),
                    },
                };
            }
            // ── Cline「订阅额度」：官方额度窗口 + 请求记录 ──
            //
            // 参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。
            // 两者都用 Cline 网关自己的端点（不是本地记账），故与「余额」是三份
            // 互不相同的读数：余额答「还剩多少」，额度答「各时间窗用掉百分之几」，
            // 请求记录答「每一笔花了多少」。
            //
            // ⚠️ **两个端点都只认 Cline**（额度端点路径里的 `users/me` 与请求记录的
            // `usages` 都是 Cline 网关的形状）。别的 provider 一律 `bad-request` ——
            // 这正是「不要在 UI 上吞掉错误，而是不发起这个请求」那条既有约定的
            // 服务端一半（客户端另由 `supportsSubscriptionQuota` 门控）。
            case 'cline.quota': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider !== CLINE.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${String(req.provider)}` } };
                }
                const accounts = await pool.listAccounts(req.provider);
                const values = [];
                for (const account of accounts) {
                    const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                    if (!resolved) {
                        values.push({
                            accountId: account.id, nickname: account.nickname,
                            ok: false, windows: [], error: '凭据未配置',
                        });
                        continue;
                    }
                    let credential;
                    try {
                        credential = JSON.parse(resolved.value);
                    }
                    catch {
                        values.push({
                            accountId: account.id, nickname: account.nickname,
                            ok: false, windows: [], error: '凭据解析失败',
                        });
                        continue;
                    }
                    const result = await fetchClineUsageLimits(credential, CLINE);
                    values.push({
                        accountId: account.id,
                        nickname: account.nickname,
                        ok: result.ok,
                        windows: result.windows,
                        // ⚠️ 失败时带上**具体原因**（含 HTTP 状态与网关文案），
                        // 而不是笼统一句「查询失败」—— 面板要显示原因而非 0%。
                        ...result.error === undefined ? {} : { error: result.error },
                    });
                }
                return { ok: true, value: { accounts: values } };
            }
            case 'cline.requestLog': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider !== CLINE.id) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${String(req.provider)}` } };
                }
                if (typeof req.accountId !== 'string' || req.accountId.trim().length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'accountId 不能为空' } };
                }
                // 记录是**本插件自己发出的请求流水**(进程内存,重启即丢,见
                // src/cline-request-log.ts),不是网关的 /usages —— 后者记的是该账号
                // 在官方所有渠道的消费:没有延迟/首块时间,表格字段也对不齐参考实现。
                //
                // ⚠️ `accountId` 必传(按账号过滤)——「订阅额度」面板用**同一个**
                // 翻页索引同时切额度窗口与请求记录,两个区域必须看同一个账号。
                // ⚠️ 记录可能是**失败**行(error 有值):失败的请求是排查
                // 「为什么没回复」的第一线索,与成功行同表展示、错误消息随行给出。
                return {
                    ok: true,
                    value: {
                        rows: readClineRequestHistory({ accountId: req.accountId, limit: req.limit }).map((row) => ({
                            ts: row.ts,
                            model: row.model,
                            // ⚠️ **优先用网关报的真实上游渠道**（`alibaba` 等，见
                            // `src/cline-routing.ts`）；它没报时才回落到模型命名空间
                            // （`cline-pass` / `cline-free`）—— 后者是**订阅通道**
                            // （甚至可能是厂商名），不是 serving channel，用户报障点正在于此。
                            upstream: row.upstream.length > 0 ? row.upstream : clineUpstreamOf(row.model),
                            // ⚠️ 必须透传「是否收到 usage」：表格据此把未知显示成 `—`,
                            // 而不是 0（0 会被读成「瞬间完成、没花 token」）。
                            usageReported: row.usageReported,
                            inputTokens: row.inputTokens,
                            outputTokens: row.outputTokens,
                            ...row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {},
                            ...row.reasoningTokens !== undefined ? { reasoningTokens: row.reasoningTokens } : {},
                            // 推理强度：空串也照传（展示层据「空串 ⇒ 不渲染那一行」判断，
                            // 若在这里省略字段，前端就得同时处理 undefined 与 '' 两种缺省）。
                            effort: row.effort,
                            ttftMs: row.ttftMs,
                            // ⚠️ 首个**正文**块耗时必须透传：展示层的「输出速率」拿它当分母
                            // 起点（分子是正文 token 数）。缺了它速率会虚高到物理不可能的值
                            // —— 用户报障的 `11814.8 t/s` 就是分子分母跨阶段的产物。
                            ttfcMs: row.ttfcMs,
                            totalMs: row.totalMs,
                            ...row.error !== undefined ? { error: row.error } : {},
                        })),
                    },
                };
            }
            // ── 模型列表可见性（黑名单开关）──
            //
            // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
            // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
            // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
            // 「设置在某个模型上，选择器里却找不到它」。
            case 'model.list': {
                const req = payload;
                const llm = llmServiceOf(ctx);
                if (llm === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } };
                }
                let models;
                try {
                    models = await llm.listModels(req.provider);
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } };
                }
                // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
                // 下一次 listModels 就会应用新的过滤结果。
                const disabledMap = pool.listDisabledModels(req.provider);
                // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：所有适配器
                // 的 listModels 内部都会实时 `filter(m => !disabledModelsFor(provider).has(m.id))`。
                // 若直接对这个结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
                // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
                // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
                // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
                //
                // 因此设置页的目录必须以**未过滤**的全量为准：
                // - 优先用适配器提供的 `listAllModels()`（不套黑名单，且带**最终展示名**，
                //   含倍率与同名消歧）；
                // - 它不存在时（外部/旧适配器）退化为「listModels 结果 + 黑名单补回裸 id」，
                //   此时关闭项只能显示 id（历史行为）。
                //
                // ⚠️ 展示名必须来自**不套黑名单**的全量目录而非裸 id：用户报障
                // 「关闭的就没有显示倍率，关闭的应该也显示倍率」—— 根因正是补回时只有
                // id 可用。适配器实例由 `registerJetHubRpc` 的 `modelAdapters` 传入
                // （DSH 的 `ctx.llm` 只保证 `listModels`，不透传自定义方法）。
                // 对话框模型选择器读的仍是过滤后的 `listModels`，可见性行为完全不变。
                const catalogSource = modelAdapters?.[req.provider];
                const all = catalogSource?.listAllModels();
                let catalog;
                if (all !== undefined) {
                    catalog = [...all];
                    // 全量目录里若仍有黑名单命中却缺失者，一并补上（保底，正常不会发生）。
                    const known = new Set(catalog.map((model) => model.id));
                    for (const id of Object.keys(disabledMap)) {
                        if (disabledMap[id] === true && !known.has(id))
                            catalog.push({ id, name: id });
                    }
                }
                else {
                    const listedIds = new Set(models.map((model) => model.id));
                    const filteredOut = Object.keys(disabledMap)
                        .filter((id) => disabledMap[id] === true && !listedIds.has(id));
                    catalog = [
                        ...models.map((model) => ({ id: model.id, name: model.name })),
                        // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
                        ...filteredOut.map((id) => ({ id, name: id })),
                    ];
                }
                const value = {
                    models: catalog.map((model) => ({
                        id: model.id,
                        name: model.name,
                        disabled: disabledMap[model.id] === true,
                        // ⚠️ 免费标记**照原样透传，缺失就不写**（不编造 `false`）：Jet Hub 的
                        // 模型列表按「计费/来源」分组，把「适配器没报」当成「按量计费」是
                        // 保守归组，但字段本身仍保持「未知」语义（与全仓约定一致）。
                        ...model.isFree === undefined ? {} : { isFree: model.isFree },
                    })),
                };
                return { ok: true, value };
            }
            // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
            // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
            //
            // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
            // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
            // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
            // 磁盘、界面一直显示旧目录。
            case 'model.setDisabled': {
                const req = payload;
                if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } };
                }
                await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true);
                ctx.logger.info(`[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`);
                // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
                broadcastCatalogChanged(ctx);
                const value = {
                    provider: req.provider,
                    disabledModels: pool.listDisabledModels(req.provider),
                };
                return { ok: true, value };
            }
            /**
             * 批量打开/关闭**指定的一批**模型（Jet Hub 模型列表里「按分组」的
             * 本组全开 / 本组全关）。
             *
             * ⚠️ **不能复用 `model.setAllDisabled`**：那个的范围是「该 provider 的
             * 全部模型」，且打开方向会清空整张黑名单（含用户特意关着的其它组）。
             * 分组开关只动本组的 id，故服务端需要一个「按子集清除」的路径
             * （`AccountPool.clearModelsDisabled`）。
             *
             * 与另外两个开关端点同约定：`disabled` 不做默认值猜测、只落盘一次、
             * 只广播一次（逐条调用会写 N 次文档、广播 N 次）。
             */
            case 'model.setDisabledMany': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0
                    || !Array.isArray(req.modelIds)
                    || typeof req.disabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider、modelIds（数组）与 disabled（布尔）必填' },
                    };
                }
                // 去重 + 剔除非字符串/空串：前端按组传 id，重复项或脏值只会白写一次文档。
                const ids = [...new Set(req.modelIds.filter((id) => typeof id === 'string' && id.length > 0))];
                if (ids.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'modelIds 不能为空' } };
                }
                if (req.disabled)
                    await pool.setModelsDisabled(req.provider, ids);
                else
                    await pool.clearModelsDisabled(req.provider, ids);
                ctx.logger.info(`[jet-hub] ${req.disabled ? '关闭' : '打开'} ${req.provider} 的 ${ids.length} 个模型（按分组）`);
                // 与其它开关端点一致：必须广播，否则界面一直显示旧目录。
                broadcastCatalogChanged(ctx);
                const value = {
                    provider: req.provider,
                    disabledModels: pool.listDisabledModels(req.provider),
                };
                return { ok: true, value };
            }
            /**
             * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
             * 「打开全部 / 关闭全部」）。
             *
             * 两个方向的语义**刻意不对称**（需求明确规定）：
             *
             * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
             *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
             *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
             * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
             *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
             *   才能被清掉（按目录删的话它们永远留在配置里）。
             *
             * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
             * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
             * 的黑名单。批量端点只落盘一次、只广播一次。
             */
            case 'model.setAllDisabled': {
                const req = payload;
                // ⚠️ `disabled` **不做默认值猜测**：缺失或非布尔一律拒绝。默认成 true 会
                // 让一次字段名写错的前端改动静默关闭用户全部模型；默认成 false 则反向
                // 静默打开 —— 两个方向都是灾难性且难察觉的。
                if (typeof req.provider !== 'string' || typeof req.disabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider 与 disabled（布尔）必填' },
                    };
                }
                if (req.disabled) {
                    // 关闭全部：先取全量目录，再一次性写入黑名单。
                    // 目录读取的三条分支（适配器 → llm → 失败即拒绝）与「关闭供应商」
                    // 完全一致，故共用 fullCatalogIds；⚠️ 失败时**不落盘** ——
                    // 否则会写入一个不完整的黑名单，用户看到「关了一半」且无从判断原因。
                    const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider);
                    if ('error' in catalog) {
                        return { ok: false, error: { code: 'bad-request', message: catalog.error } };
                    }
                    await pool.setModelsDisabled(req.provider, catalog.ids);
                    ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的全部 ${catalog.ids.length} 个模型`);
                }
                else {
                    // 打开全部：纯本地操作，不读目录 —— 目录故障时用户仍应能把开关全打开。
                    await pool.clearDisabledModels(req.provider);
                    ctx.logger.info(`[jet-hub] 打开 ${req.provider} 的全部模型`);
                }
                // 只广播一次：批量不等于逐条广播。
                broadcastCatalogChanged(ctx);
                const value = {
                    provider: req.provider,
                    disabledModels: pool.listDisabledModels(req.provider),
                };
                return { ok: true, value };
            }
            /**
             * 读取多个供应商的汇总状态（Jet Hub 左侧导航分组 + 一键开关据此渲染）。
             *
             * 为什么一次取全部：8 个供应商若逐个查，就是 16 次往返，且每次都要走
             * 异步凭据解析。这里**全程只用同步的内存副本**，不产生任何网络请求：
             * - 模型目录用 `modelAdapters[provider].listAllModels()`（同步；它内部
             *   在冷缓存时会**后台**补拉，但不阻塞本次返回）；
             * - 账号用 `pool.listAccountsByProvider()`（同步读内存）。
             *
             * ⚠️ **不得**改用 `pool.listAccounts()` —— 那个方法会对每个账号调
             * `credentials.describe()`（异步 IO），8 个供应商逐个解析凭据会明显
             * 拖慢设置页首屏，而我们**只需要计数**，不需要凭据状态。
             *
             * 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：
             * 保守判为「未关闭」，让用户可以尝试操作，而不是误报成已关闭。
             */
            case 'provider.status': {
                const req = payload;
                if (!Array.isArray(req.providers) || req.providers.some((id) => typeof id !== 'string')) {
                    return { ok: false, error: { code: 'bad-request', message: 'providers 必须是字符串数组' } };
                }
                const statuses = {};
                for (const provider of req.providers) {
                    // 空 id 不进结果：它不可能对应任何 provider，留着只会让前端多一个
                    // 无意义的键（前端按 PROVIDERS 取，多出来的键会被忽略，但脏数据不该产生）。
                    if (provider.length === 0)
                        continue;
                    const catalog = modelAdapters?.[provider]?.listAllModels();
                    const total = catalog?.length ?? 0;
                    // ⚠️ `listAllModels()` **不带 disabled 字段**，故必须另取黑名单再按 id 计数。
                    const disabledMap = pool.listDisabledModels(provider);
                    let disabled = 0;
                    if (catalog !== undefined) {
                        for (const model of catalog) {
                            // 与 `disabledModelsFor` 的判定对齐：只有显式 true 才算已关闭。
                            if (disabledMap[model.id] === true)
                                disabled++;
                        }
                    }
                    const entries = pool.listAccountsByProvider(provider);
                    statuses[provider] = {
                        models: { total, disabled },
                        accounts: {
                            total: entries.length,
                            // 与适配器一致的判据：`enabled !== false` 视为启用
                            //（老文档可能缺该字段，缺省语义等同启用）。
                            enabled: entries.filter((entry) => entry.enabled !== false).length,
                        },
                        closed: total > 0 && disabled === total,
                    };
                }
                const value = { statuses };
                return { ok: true, value };
            }
            /**
             * 供应商级一键开关（Jet Hub 左侧每个供应商行尾的开关）。
             *
             * ## 语义（用户已确认）
             *
             * - `enabled: false`（关闭）= **关闭它的全部模型** + **停用它的全部账号**；
             * - `enabled: true`（打开）= 清空它的模型黑名单 + 启用它的全部账号。
             *
             * ## ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号
             *
             * 「是否已关闭」的判据是**模型是否全关**（见 `provider.status` 的 `closed`）。
             * 先关模型可保证：即使随后停账号失败，状态判定依然自洽（该供应商确实已关闭），
             * 用户重试一次即可补齐账号。反过来先停账号、再关模型，中途失败会留下
             * 「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
             * 却没有任何可用账号，这正是本次要消除的落差。
             *
             * ## ⚠️ 「不关闭模型就不关闭供应商」
             *
             * 关闭方向必须拿到模型目录：读失败、或目录**为空**时**整个操作失败**，
             * 既不落盘也不广播。绝不能「关不掉模型就只停账号」—— 那会让供应商
             * 显示成已关闭而模型其实还在，用户按关闭的预期却仍能选到它。
             *
             * ## 打开方向不读目录
             *
             * 与 `model.setAllDisabled` 的「打开全部」同理：直接清空黑名单，这样
             * 「曾被关闭、后来从服务端目录下线」的历史遗留键才能被清掉；且目录故障时
             * 用户仍应能把开关全打开。
             */
            case 'provider.setEnabled': {
                const req = payload;
                // ⚠️ `enabled` 不做默认值猜测：缺失或非布尔一律拒绝。默认成 true 会静默
                // 打开用户特意关闭的供应商；默认成 false 则反向静默关闭 —— 两个方向都是
                // 灾难性且难察觉的（与 model.setAllDisabled 同约定）。
                if (typeof req.provider !== 'string' || req.provider.length === 0 || typeof req.enabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider 与非空布尔 enabled 必填' },
                    };
                }
                let modelCount = 0;
                if (req.enabled) {
                    // 打开：清空黑名单（返回被清掉的条目数，供提示）。null 表示本就无关闭项。
                    const cleared = pool.listDisabledModels(req.provider);
                    await pool.clearDisabledModels(req.provider);
                    modelCount = Object.keys(cleared).length;
                }
                else {
                    const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider);
                    if ('error' in catalog) {
                        // 目录读不出来 → 整个关闭操作失败，**不落盘、不广播**。
                        return { ok: false, error: { code: 'bad-request', message: catalog.error } };
                    }
                    if (catalog.ids.length === 0) {
                        // 「不关闭模型就不关闭供应商」的落点。
                        return {
                            ok: false,
                            error: { code: 'bad-request', message: '该供应商没有可关闭的模型，未做任何变更' },
                        };
                    }
                    await pool.setModelsDisabled(req.provider, catalog.ids);
                    modelCount = catalog.ids.length;
                }
                // 账号状态**在模型之后**处理（顺序理由见上）。返回实际变更数，
                // 已是目标状态的账号不计入，避免提示夸大成「已停用 N 个」。
                const accountCount = await pool.setAccountsEnabled(req.provider, req.enabled);
                // 两个方向都改变 listModels 的结果（关/开黑名单），**必须广播**，
                // 否则对话框的模型选择器要重启才更新（成因见 broadcastCatalogChanged）。
                broadcastCatalogChanged(ctx);
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}供应商 ${req.provider}：`
                    + `${req.enabled ? '清空' : '写入'} ${modelCount} 个模型、`
                    + `${req.enabled ? '启用' : '停用'} ${accountCount} 个账号`);
                const value = {
                    provider: req.provider,
                    enabled: req.enabled,
                    models: modelCount,
                    accounts: accountCount,
                };
                return { ok: true, value };
            }
            // ── 本机 OpenAI 网关（`src/openai-gateway/`）──
            case 'gateway.getEnabled': {
                // ⚠️ **每个字段独立降级**：这里是设置页唯一的网关状态来源，任何一个附属
                // 字段采集失败都不该让**整个面板变空白**（开关、地址、密钥全看不到），
                // 更不该把用户挡在「关掉网关」这条自救路径之外。
                // 失败一律降级为 null / []，并在 logger 里带上是哪一步失败的。
                const degrade = async (step, run, fallback) => {
                    try {
                        return await run();
                    }
                    catch (error) {
                        ctx.logger.warn(`[jet-hub] gateway.getEnabled 的「${step}」读取失败，该字段降级为默认值：${String(error)}`);
                        return fallback;
                    }
                };
                const blockedByEnv = await degrade('env 开关', () => !isGatewayEnabled(process.env), true);
                const apiKey = await degrade('API Key', () => gatewayApiKey(), null);
                const address = await degrade('监听地址', () => (blockedByEnv ? null : gatewayAddress() ?? null), null);
                const llm = llmServiceOf(ctx);
                const listed = llm?.listProviders !== undefined
                    ? (() => {
                        try {
                            const value = llm.listProviders();
                            return Array.isArray(value) && value.length > 0 ? value : undefined;
                        }
                        catch {
                            return undefined;
                        }
                    })()
                    : undefined;
                const adapters = Object.keys(modelAdapters ?? {}).map((id) => ({ id }));
                const providers = listed ?? (adapters.length > 0 ? adapters : undefined);
                // 目录来源要让**空状态能自解释**：用户看到空清单时必须能分辨「我没登录」
                // 与「宿主没给出任何可枚举的 provider」。
                const modelsSource = listed !== undefined ? 'catalog' : (adapters.length > 0 ? 'adapters' : 'none');
                const value = {
                    enabled: await degrade('开关状态', () => pool.gatewayEnabled(), true),
                    running: await degrade('运行态', () => isGatewayRunning(), false),
                    blockedByEnv,
                    // 被 env 停用时即使 `enabled` 为真也不会监听，此时**不**回显地址，
                    // 否则设置页会显示一个根本连不上的 URL。
                    address,
                    // ⚠️ 明文凭据：只用于设置页展示与复制，**不进日志**。
                    apiKey: apiKey === null
                        ? null
                        : { value: apiKey.value, fromEnv: apiKey.fromEnv, path: apiKey.path },
                    // 有些 agent（如 ZCode）不会主动扫目录，要靠用户手工填 ID，
                    // 故这里把目录一并回传，让设置页内嵌展示。
                    models: await degrade('模型目录', async () => {
                        if (providers === undefined) {
                            // ⚠️ 不能静默返回空：那会让用户以为是自己没登录，而真实原因是
                            // 宿主根本没给出任何可枚举的 provider。modelsSource 会把这件事
                            // 如实带到 UI 上。
                            ctx.logger.warn('[jet-hub] gateway.getEnabled：既取不到 llm.listProviders，也没有任何已注册适配器可作兜底，模型清单为空');
                            return [];
                        }
                        return collectGatewayModelIds({ listProviders: () => providers, listModels: (provider) => llm.listModels(provider) }, (provider, error) => {
                            ctx.logger.warn(`[jet-hub] ${provider} 模型目录读取失败，已从网关列表跳过：${String(error)}`);
                        });
                    }, []),
                    modelsSource,
                };
                return { ok: true, value };
            }
            case 'gateway.setEnabled': {
                const req = payload;
                // ⚠️ 不做默认值猜测，与 `provider.setEnabled` 同约定：
                // 默认成 true 会静默打开用户特意关闭的网关。
                if (typeof req.enabled !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 enabled 必填' } };
                }
                // 先落盘再启停：启停失败（端口冲突）不该让已写入的开关回滚成
                // 「看起来没生效」——状态与运行态分开，由 status 的 running 字段区分。
                await pool.setGatewayEnabled(req.enabled);
                setGatewayDesiredEnabled(req.enabled);
                await applyGatewayDesiredState();
                const blockedByEnv = !isGatewayEnabled(process.env);
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}本机 OpenAI 网关`
                    + `${blockedByEnv ? '（已被 DSH_OPENAI_GATEWAY_ENABLED 阻止）' : isGatewayRunning() ? '' : '（未在监听）'}`);
                // 开关切换会创建/销毁实例，密钥随之可能从「尚无」变成「已生成」。
                const key = gatewayApiKey();
                const llm = llmServiceOf(ctx);
                // 刚打开网关 ⇒ 目录可能刚从空变成有值，必须重新采集。
                // ⚠️ 同样不让目录采集拖垮整个响应：它只是回传的附加值。
                const providers = req.enabled ? providerIdsOf(llm, modelAdapters) : undefined;
                const modelsSource = !req.enabled
                    ? 'none'
                    : (llm?.listProviders !== undefined ? 'catalog' : (Object.keys(modelAdapters ?? {}).length > 0 ? 'adapters' : 'none'));
                const models = providers === undefined
                    ? []
                    : await collectGatewayModelIds({
                        listProviders: () => providers,
                        listModels: (provider) => llm.listModels(provider),
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] gateway.setEnabled 的模型目录刷新失败：${String(error)}`);
                        return [];
                    });
                const value = {
                    enabled: req.enabled,
                    running: isGatewayRunning(),
                    blockedByEnv,
                    address: blockedByEnv ? null : gatewayAddress() ?? null,
                    apiKey: key === null ? null : { value: key.value, fromEnv: key.fromEnv, path: key.path },
                    models,
                    modelsSource,
                };
                return { ok: true, value };
            }
            // ── 内部 captcha 载体（二期）──
            //
            // 这两条是**客户端驱动**的通道：DSH 的 `connection.fetch` 只有
            // `client-request` / `server-response` 两种消息（server 无法反向要求 GUI 干活），
            // 所以「server 要 param」只能被表达成一个**需求位**，由 GUI 轮询着读，
            // 产出来再 POST 回这条 contribute。语义与取舍见 `src/captcha-supply.ts` 文件头。
            //
            // ⚠ web 版：GUI 里没有 `dshDesktop.browser` ⇒ 没人读需求位、也没人贡献
            //   ⇒ 槽长期为空 ⇒ 载体链直接退回既有 chromium 路径，行为不变。
            /** client 心跳问「现在要不要产 param」——不需要时 client 一次都不产（零配额消耗）。 */
            case 'captcha.demand': {
                const value = { active: captchaDemand() };
                return { ok: true, value };
            }
            /**
             * ★ 评审 C1/C2：client 每轮问一次「载体页在哪个地址」。
             *
             * ## 为什么是 RPC 而不是 client 里的一个常量
             * 载体页**不能**挂在插件自己的 `/api/…` 上：桌面版主进程的
             * `allowedNavigation()` / `onBeforeRequest` 都会以 `isApplicationHost(url)`
             * 拒掉「**端口相同** 且 主机相同/回环」的地址（asar `lib/main.js`），
             * 而那个端口就是 Host 自己的端口 ⇒ guest 连文档都建不起来。
             * 换端口才绕得开 ⇒ 端口是 server 运行时挑的，client 只能**问**（见
             * `src/captcha-carrier-server.ts` 文件头的完整取证）。
             *
             * ## 返回 `null` 的含义
             * 服务没起（`DSH_ZCODE_INTERNAL_CARRIER=0` / 候选端口全被占）。client 拿到
             * `null` 就记一条 `no-carrier-url` 并**安静返回**：不建 guest、不导航。
             * ⚠ 这是 web 版之外的另一条「安静退出」路径，别把它当错误报。
             */
            case 'captcha.carrierUrl': {
                // ⚠ 判一下方法存不存在：这条 RPC 允许「没有内部载体能力」的宿主形态（老插件
                //   骨架 / 替身）回答，**回 null 即可**，不该把整次分派变成错误。
                const url = typeof zcode.carrierPageUrl === 'function'
                    ? await zcode.carrierPageUrl()
                    : null;
                const value = { url: url ?? null };
                return { ok: true, value };
            }
            /** client 把内部载体产的 param 放进供给槽（一次性，取走即清）。 */
            case 'captcha.contribute': {
                const req = payload;
                /**
                 * param 的「产出时刻」= **server 到达时刻 − client 报告的相对耗时**。
                 *
                 * ⚠ 不用 client 的绝对时间戳：那会把跨端时钟漂移引进时效闸（快了永不判过期、
                 *   慢了一投放就过期 ⇒ 内部载体静默永不可用，日志还看着像「client 没产」）。
                 * ⚠ 也不用纯到达时刻：那会把年龄**低估**一个 client→server 的跳数。
                 *   相对耗时是同机单向差值，比绝对时钟可靠 ⇒ 两者结合既无漂移也不低估。
                 * elapsedMs 缺失/非法时退回到达时刻（保守地偏小年龄，由 PARAM_MAX_AGE_MS 兜住）。
                 */
                const elapsed = typeof req.elapsedMs === 'number' && Number.isSafeInteger(req.elapsedMs)
                    && req.elapsedMs >= 0 && req.elapsedMs < 5 * 60_000 ? req.elapsedMs : 0;
                const interactive = req.interactive === true;
                const accepted = putSuppliedParam(typeof req.param === 'string' ? req.param : '', Date.now() - elapsed, { interactive });
                ctx.logger.info(`[jet-hub] zcode 内部载体贡献 param: accepted=${String(accepted)} elapsedMs=${String(elapsed)}`
                    + `${interactive ? ' interactive=true' : ''}`);
                /**
                 * ⚠ 交互式必须**显式告警**（评审 I2）：那是 SDK 被降级成滑块/拼图的唯一信号，
                 *   也是这台机器**设备信誉下降**的唯一预警 —— chromium 那条腿早就有同样的
                 *   `warn`（见 `ZcodeAuth.captchaPoolInstance()`），内部载体这段此前只打进
                 *   client 控制台，host 侧一个字都看不到（等于没有预警）。
                 * ⚠ 只在被**收下**时告警：被拒的那条（垃圾 param）报「交互式」是噪声。
                 */
                if (accepted && interactive) {
                    ctx.logger?.warn?.('[jet-hub] zcode 内部载体的 captcha 被降级为**交互式验证**（滑块/拼图）—— '
                        + '设备信誉可能已下降；内部载体的价值是「去掉对 chromium 的依赖」，'
                        + '不是绕过风控，请降低调用频率或稍后再试。');
                }
                const value = { accepted };
                return { ok: true, value };
            }
            // ── 账号备份（导出 / 导入）──
            //
            // 目的：更换 DSH 版本时迁移账号凭据。备份文件是**自包含**的 JSON
            // （账号索引 + 凭据原文 + 模型黑名单，见 src/backup.ts），与 DSH 版本
            // 无关 —— 导入时按**当前版本**的存储契约重建，天然跨版本。
            //
            // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
            // 明文载荷；明文 JSON 不经过本层持久化与日志。
            case 'backup.export': {
                const result = await exportBackup(pool, ctx.credentials);
                const value = {
                    payload: result.payload,
                    warnings: result.warnings,
                };
                return { ok: true, value };
            }
            // 导入 = 整体替换（还原快照，不是合并）。写入顺序刻意「先凭据、后账号池」：
            // 账号池整体替换成功后，门控（hasLoggedInAccount）与黑名单立即反映新状态；
            // 若凭据写入中途失败（非法 ref 等），只跳过该条、不中断整体。
            case 'backup.import': {
                const req = payload;
                const result = await importBackup(ctx.credentials, pool, req.payload);
                // 导入会改变账号集合（门控依赖 hasLoggedInAccount）与模型黑名单，
                // 必须广播目录变更，否则界面仍显示旧目录。
                broadcastCatalogChanged(ctx);
                const value = {
                    credentialsImported: result.credentialsImported,
                    accountsImported: result.accountsImported,
                    skipped: result.skipped,
                    expiredAccounts: result.expiredAccounts,
                    missingCredentials: result.missingCredentials,
                };
                return { ok: true, value };
            }
            // 账号池统计（导入前的覆盖提示用）：缺 expiresAt 的条目疑似 DSH 版本
            // 切换后自动恢复的产物（反推不读凭据值，故无有效期）。前端据此在
            // 确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」。
            case 'backup.status': {
                const state = pool.getStateSnapshot();
                const value = {
                    accounts: state.accounts.length,
                    withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === undefined).length,
                };
                return { ok: true, value };
            }
            /**
             * 用量徽标读数（会话输入区、模型选择器旁那枚）。
             *
             * ## 与 `credits.balances` 的关系
             *
             * 读数是**同一份**（本分支内部直接复用 `credits.balances` 的实现，见
             * `usageBadge` 的装配注释），差别只有三处：
             * 1. 只返回**启用**账号，并给出 `disabledCount`（停用账号不进合计）；
             * 2. 多带一份订阅读数（窗口 / 套餐），判定表在 `src/badge-subscription.ts`；
             * 3. 带**宿主侧 TTL 缓存**（`cached` 标出来）—— 徽标按分钟轮询，而余额是
             *    逐账号顺序打上游的（`collectCreditBalances` 的「顺序查询，避免并发
             *    触发风控」），不缓存会让上游请求数随轮询线性放大。
             *
             * ⚠️ 未知 provider 的 `bad-request` 由内层 `credits.balances` 给出（那里
             * 已有 12 条分派与 `unsupported provider` 的统一文案），本分支**原样透传**，
             * 不另立一份 provider 名单 —— 两份名单必然漂移。
             *
             * ⚠️ `force: true` = 绕过缓存（手动刷新、签到之后）。
             */
            case 'usage.badge': {
                const req = payload;
                const provider = typeof req.provider === 'string' ? req.provider.trim() : '';
                if (provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 不能为空' } };
                }
                const value = await usageBadge.read(provider, req.force === true ? { force: true } : {});
                // `read()` 返回的就是本端点的响应信封（`{ ok, value|error }`），直接透传。
                return value;
            }
            /**
             * 用量徽标的显示偏好（读 / 写，**全局一个**，不分渠道）。
             *
             * ⚠️ `preference` 省略时**只读**（徽标首次渲染与设置面板初始化都用它）；
             * 给出时必须是 `auto` / `subscription` / `credits` 之一。
             *
             * ⚠️ 非法值**拒绝**而不是静默回落：回落会让「设置没生效」看起来像
             * 「保存成功」（用户改完刷新，界面仍按旧口径显示，且没有任何提示）。
             * 磁盘脏数据的容错在 `sanitizeBadgePreference`（那条路径面对的不是用户输入）。
             */
            case 'usage.badgePreference': {
                const req = payload;
                if (req.preference === undefined) {
                    const value = { preference: badgePreferences.load() };
                    return { ok: true, value };
                }
                if (!BADGE_PREFERENCES.includes(req.preference)) {
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: `preference 必须是 ${BADGE_PREFERENCES.join(' / ')} 之一（收到：${JSON.stringify(req.preference)}）`,
                        },
                    };
                }
                await badgePreferences.save(req.preference);
                const value = { preference: badgePreferences.load() };
                return { ok: true, value };
            }
            /**
             * 「每日首次启动自动签到」开关（读 / 写，**全局一个**，不分渠道）。
             *
             * ⚠️ `enabled` 省略时**只读**；给出时必须是布尔值。非法值拒绝而不是静默
             * 回落 —— 理由与 `usage.badgePreference` 完全一致（回落会让「设置没生效」
             * 看起来像「保存成功」）。
             *
             * ⚠️ 写入 `true` 时宿主会**立刻尝试跑一轮**（今天已跑过则由执行体内部拦住）：
             * 否则用户今天打开开关要等到明天才有动作，看起来像没生效。返回值里的
             * `running` 会立刻为 `true`，界面据此显示「进行中」。
             */
            case 'usage.autoCheckin': {
                const req = payload;
                /**
                 * 关闭那行**常驻**的自动签到状态文字。
                 *
                 * ⚠️ 与 `enabled` 分开判而不是「先 dismiss 再 enabled」：两者语义独立，
                 * 一次请求只该做一件事 —— 否则 `{ dismiss: true, enabled: true }` 会
                 * 既关文字又改开关，客户端将来误传就难查。
                 */
                if (req.dismiss !== undefined) {
                    if (typeof req.dismiss !== 'boolean') {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `dismiss 必须是布尔值（收到：${JSON.stringify(req.dismiss)}）`,
                            },
                        };
                    }
                    if (req.dismiss) {
                        const value = { autoCheckin: await autoCheckin.dismiss() };
                        return { ok: true, value };
                    }
                }
                if (req.enabled === undefined) {
                    const value = { autoCheckin: autoCheckin.state() };
                    return { ok: true, value };
                }
                if (typeof req.enabled !== 'boolean') {
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: `enabled 必须是布尔值（收到：${JSON.stringify(req.enabled)}）`,
                        },
                    };
                }
                const value = { autoCheckin: await autoCheckin.setEnabled(req.enabled) };
                return { ok: true, value };
            }
            default:
                return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } };
        }
    }
}
/** 构造带 rpcId 的响应 JSON */
function reply(rpcId, result) {
    const value = typeof result === 'object' && result !== null && result.ok === false
        ? { ...result, error: { ...result.error, details: {} } }
        : result;
    return Response.json({ type: 'server-response', rpcId, result: value });
}
//# sourceMappingURL=jet-hub-rpc.js.map