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
 *           backup.export / backup.import / backup.status
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LOOMY } from './loomy-product.js';
import { RACCOON } from './raccoon-product.js';
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES } from './loomy-onboarding.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { QODER } from './qoder-product.js';
import { TRAE } from './trae-product.js';
import { CLINE } from './cline-product.js';
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs } from './lobsterai.js';
import { fetchQoderUserNickname, isQoderRefreshable, qoderCredentialExpiresAtMs, withQoderNickname, } from './qoder.js';
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js';
import { isTraeRefreshable, traeCredentialExpiresAtMs } from './trae.js';
import { fetchClineCreditBalance } from './cline-credits.js';
import { clineCredentialExpiresAtMs, isClineRefreshable, } from './cline.js';
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js';
import { credentialExpiresAtMs } from './buddy.js';
import { claimDailyCheckin, fetchCheckinStatus, fetchCreditBalance, } from './credits.js';
import { CODEBUDDY, productById } from './product.js';
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance, } from './lobsterai-credits.js';
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed, } from './codearts-credits.js';
import { claimTraeDailyCheckin, fetchTraeCheckinStatus, fetchTraeCreditBalance, } from './trae-credits.js';
import { resetAccount, resetAllAccounts, retestAccount, retestAllAccounts, } from './account-probe.js';
import { exportBackup, importBackup } from './backup.js';
/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub';
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
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (6665)`。
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
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes) {
    const summary = {
        claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
    };
    for (const outcome of outcomes) {
        switch (outcome.kind) {
            case 'claimed':
                summary.claimed += 1;
                summary.totalCredit += outcome.credit;
                break;
            case 'already-claimed':
                summary.alreadyClaimed += 1;
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
 * 用 `ctx.get` 而不是 `inject`：Jet Hub 的账号管理是主要职责，模型开关只是
 * 附加能力；llm 服务缺失时账号面板仍应可用，只是「显示列表」按钮报错。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故这里把它
 * 声明为可选：缺失时退化为「用 listModels 的结果 + 黑名单补回裸 id」。
 */
function llmServiceOf(ctx) {
    return ctx.get('llm');
}
/**
 * 注册 Jet Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export function registerJetHubRpc(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, 
/**
 * provider → 适配器实例（可选）。
 *
 * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
 * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
 * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
 */
modelAdapters) {
    ctx.inject(['connection'], (connectionCtx) => {
        registerJetHubEndpoints(connectionCtx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, modelAdapters);
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
/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, modelAdapters) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = ctx.connection ?? ctx.get('connection');
    if (!connection || typeof connection.fetch?.register !== 'function') {
        ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered');
        return;
    }
    /**
     * Loomy 短信登录的中间状态（账号 id → { phone, msgid }）。
     *
     * 为什么放内存而不是凭据存储：msgid 是**一次性的中间态**（5 分钟有效），
     * 登录完成后即无意义；写进 `ctx.credentials` 会污染凭据命名空间，
     * 且它不含任何秘密（不能用于认证）。
     */
    const pendingSmsMsgid = new Map();
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
    /** 分发端点方法到对应的处理器 */
    async function handleMethod(method, payload, _signal) {
        switch (method) {
            case 'account.list': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                return { ok: true, value: { accounts } };
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
                            nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                                ? credential.nickname
                                : id,
                            expiresAt: credential !== undefined ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
                            refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`);
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
                }
                else if (provider === QODER.id) {
                    // Qoder 与 codearts / lobsterai 同款两步式，但登录机制不同：
                    // 它是**设备码轮询**（不开本地回调服务器，见 src/qoder-oauth.ts），
                    // 同样必须在用户授权前返回 loginUrl，理由见上面的 codearts 分支。
                    const started = await qoder.startLogin({ refName });
                    // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
                    // 登录成功后再回填昵称/有效期等真实字段。
                    await pool.addAccount({
                        id,
                        provider: QODER.id,
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
                        // `qoder-xxxx`（多账号无法区分）。见 `fetchQoderUserNickname` 的说明。
                        //
                        // ⚠️ **失败不阻塞登录**：昵称只是展示信息，拿不到就退回账号 id
                        //（与 `toLoginFlowResult` 对过期时间的处理同原则）。
                        let nickname = credential?.nickname;
                        if ((nickname === undefined || nickname.length === 0) && credential !== undefined) {
                            nickname = await fetchQoderUserNickname(credential, QODER);
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
                        ctx.logger.warn(`[jet-hub] background ${QODER.id} login failed for ${id}: ${String(error)}`);
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
                            nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                                ? credential.nickname
                                : id,
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
                            // 故追加**手机号尾号**消歧：`RaccoonAva (6665)`。
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
                    // 续期入口 —— 两处都是修复既有缺陷的关键：
                    //
                    // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
                    //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
                    // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
                    //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
                    //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
                    //    结果要么报错要么静默改了错的对象。
                    // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
                    // 续期入口 —— 两处都是修复既有缺陷的关键：
                    //
                    // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
                    //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
                    // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
                    //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
                    //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
                    //    结果要么报错要么静默改了错的对象。
                    switch (entry.provider) {
                        case 'codearts':
                            await codearts.refreshAccountCredential(entry.credentialRef);
                            break;
                        case 'buddy':
                            await buddy.refreshAccountCredential(entry.credentialRef);
                            break;
                        case 'workbuddy':
                            await workbuddy.refreshAccountCredential(entry.credentialRef);
                            break;
                        case LOBSTERAI.id:
                            await lobsterai.refreshAccountCredential(entry.credentialRef);
                            break;
                        case QODER.id:
                            await qoder.refreshAccountCredential(entry.credentialRef);
                            break;
                        case TRAE.id:
                            await trae.refreshAccountCredential(entry.credentialRef);
                            break;
                        case CLINE.id:
                            await cline.refreshAccountCredential(entry.credentialRef);
                            break;
                        case LOOMY.id:
                            // ⚠️ Loomy **没有 refresh 端点**：这里只能做**有效性探测**，
                            // 失效时抛「请重新登录」。见 LoomyAuth.refreshAccountCredential。
                            await loomy.refreshAccountCredential(entry.credentialRef);
                            break;
                        case RACCOON.id:
                            // raccoon **有** refresh 端点（refresh_token 轮换），这里是真续期。
                            // ⚠️ 只读写传入的 ref，不碰默认单凭据 ref。
                            await raccoon.refreshAccountCredential(entry.credentialRef);
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
                // 检查凭据是否已实际写入（占位条目没有凭据）
                const ref = credentialRef(entry.credentialRef);
                const resolved = await ctx.credentials.resolve(ref);
                if (!resolved)
                    return { ok: true, value: { done: false } };
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
             * Loomy「锁定永久积分」开关（读 / 写）。
             *
             * **用户需求**：锁定后选号只允许消耗今日赠送额度，永久积分不参与 ——
             * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
             * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
             *
             * ⚠️ 这是**全局**开关（不分账号），持久化在 `$DSH_HOME/jet-hub/state.json`
             * 的 `loomyPermanentLocked` 字段（或老契约的 settings 文档）。
             *
             * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
             */
            case 'loomy.permanentLock': {
                const req = payload;
                if (req.locked === undefined) {
                    return { ok: true, value: { locked: pool.loomyPermanentLocked() } };
                }
                if (typeof req.locked !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: 'locked 必须是布尔值' } };
                }
                await pool.setLoomyPermanentLocked(req.locked);
                // ⚠️ 与 `model.setDisabled` 同理：本次写入会改变**选号结果**
                // （进而改变哪些账号会被使用），故广播一次让界面重新读取状态。
                // 包 try/catch：通知失败不能反噬已经落盘的开关。
                try {
                    ctx.emit('llm/adapters-updated');
                }
                catch (error) {
                    ctx.logger?.warn?.(`[jet-hub] 广播 llm/adapters-updated 失败（不影响已保存的开关）: ${String(error)}`);
                }
                return { ok: true, value: { locked: pool.loomyPermanentLocked() } };
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
                if (req.provider === QODER.id) {
                    // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
                    // 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
                    // （与 LobsterAI 传 false 的理由同类）。
                    //
                    // ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
                    // HTTP 200），已在 claimQoderCampaign 内部处理。
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        claim: (credential) => claimQoderDailyCheckin(credential, QODER),
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
                    return { ok: true, value: { accounts: values } };
                }
                if (req.provider === QODER.id) {
                    // 余额来自 `GET /sash/api/v2/me/usage`（实测只需 Bearer +
                    // Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
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
                        const balance = await fetchQoderCreditBalance(credential, QODER);
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
                if (req.provider === TRAE.id) {
                    const values = await collectCreditBalances(accounts, TRAE, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        fetchBalance: (credential, product) => fetchTraeCreditBalance(credential, product),
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
                const product = productById(req.provider);
                if (product === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const values = await collectCreditBalances(accounts, product, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: { accounts: values } };
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
                    let ids;
                    const all = modelAdapters?.[req.provider]?.listAllModels();
                    if (all !== undefined) {
                        ids = all.map((model) => model.id);
                    }
                    else {
                        const llm = llmServiceOf(ctx);
                        if (llm === undefined) {
                            // 目录读不出来就**不落盘**：否则会写入一个不完整的黑名单，
                            // 用户看到「关了一半」且无从判断原因。
                            return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } };
                        }
                        try {
                            ids = (await llm.listModels(req.provider)).map((model) => model.id);
                        }
                        catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } };
                        }
                    }
                    await pool.setModelsDisabled(req.provider, ids);
                    ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的全部 ${ids.length} 个模型`);
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