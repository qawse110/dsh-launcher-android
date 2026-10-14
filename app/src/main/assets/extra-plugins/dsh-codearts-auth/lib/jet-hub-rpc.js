/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.test / account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled /
 *           captcha.demand / captcha.carrierUrl / captcha.contribute（内部载体，
 *           载体页见 src/zcode-carrier-page.ts 与 src/captcha-carrier-server.ts）/
 *           backup.export / backup.import / backup.status
 * 另有一条 GET 路由 `/api/jet-hub/captcha-carrier`：渲染内部载体的载体页
 * （⚠ 手工诊断用；guest 加载不到它，见该路由注释里的主进程取证）。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { openIncognitoWindow } from './login.js';
import { AUTO_PROVIDER as AUTO_PROVIDER_ID } from './auto-adapter.js';
import { resolveAutoBadgeRewrite } from './auto-badge.js';
import { broadcastCatalogChanged } from './catalog-broadcast.js';
import { isGatewayEnabled } from './openai-gateway/config.js';
import { collectGatewayEffortViews, collectGatewayModels, toGatewayModelIds } from './openai-gateway/models.js';
import { applyGatewayDesiredState, gatewayAddress, gatewayApiKey, isGatewayRunning, setGatewayDesiredEnabled, } from './openai-gateway/runtime.js';
import { LOOMY } from './loomy-product.js';
import { buddyExpiringWindowDays } from './buddy-balance-rank.js';
import { RACCOON } from './raccoon-product.js';
import { ZCODE } from './zcode-product.js';
import { phoneFromUserId, isUsableZcodeCredential } from './zcode.js';
import { ZCODE_LOGIN_PROVIDER } from './zcode-login.js';
import { MINIMAX } from './minimax-product.js';
import { isMinimaxRefreshable, minimaxCredentialExpiresAtMs } from './minimax.js';
import { GEMINI, geminiAccountLabel, geminiCredentialExpiresAtMs, isGeminiRefreshable } from './gemini.js';
// OfficeAce（华为 MaaS 云端直连）：面板状态探测 / 登录流程 / 余额查询所需的
// 产品配置与鉴权模块（协议逆向见 `officeace-auth.ts` 模块头）。
import { OFFICEACE, OFFICEACE_MODELS } from './officeace-product.js';
import { normalizeAccioRegion } from './accio-auth.js';
import { ACCIO } from './accio-product.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { PROVIDER_REGISTRY, descriptorOf } from './provider-registry.js';
import { createProviderCredits, creditsOf } from './provider-credits.js';
import { createProviderOnboarding, onboardingOf } from './provider-onboarding.js';
import { QODER, QODER_CN } from './qoder-product.js';
import { TRAE } from './trae-product.js';
import { CLINE } from './cline-product.js';
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs, lobsteraiDisplayNickname, } from './lobsterai.js';
import { fetchQoderUserNickname, isQoderRefreshable, qoderCredentialExpiresAtMs, withQoderNickname, } from './qoder.js';
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js';
import { isTraeRefreshable, traeCredentialExpiresAtMs, traeDisplayNickname } from './trae.js';
import { fetchClineUsageLimits } from './cline-quota.js';
import { clineUpstreamOf, readClineRequestHistory } from './cline-request-log.js';
import { deleteTokenLedgerDay, isValidTokenLedgerDayKey, readTokenLedger, readTokenLedgerDayMap, readTokenLedgerHistory, TOKEN_LEDGER_HISTORY_MAX_DAYS, } from './token-ledger.js';
import { clineCredentialExpiresAtMs, isClineRefreshable, } from './cline.js';
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js';
import { credentialExpiresAtMs } from './buddy.js';
import { claimDailyCheckin, claimUnitOf, fetchCheckinStatus, fetchCreditBalance, } from './credits.js';
import { CODEBUDDY, productById } from './product.js';
import { collectBuddyGrowth } from './buddy-growth.js';
/**
 * ⚠️ **`collectBuddyGrowth` 已搬到 `src/buddy-growth.ts`**（2026-10-08 Task 4），
 * 并在此**原样再导出**以保持既有调用点与用例的 import 路径不变。
 *
 * 搬家的理由（不是洁癖）：它是 `credits.afterClaim` 的实现，而 `afterClaim`
 * 由 `src/provider-credits.ts` 的能力表提供。留在本文件会让那张表必须 import
 * 本文件 ⇒ `provider-credits.ts ⇄ jet-hub-rpc.ts` **循环 import**（本文件已经
 * import 前者）。搬到 `buddy-growth.ts` 后依赖是单向的：
 * `jet-hub-rpc.ts` → `provider-credits.ts` → `buddy-growth.ts`。
 *
 * ⚠️ **本再导出是过渡形态**，不是接口：新代码应直接从 `buddy-growth.js` 取。
 * 它由 `tests/unit/buddy-growth.spec.ts` 的 import 覆盖（唯一的生产消费者是
 * `src/provider-credits.ts`，它**直接从 `buddy-growth.js` 取**，不经过本文件）。
 *
 * ⚠️ **2026-10-08 修正（Task 4 复审 Finding 1）**：本 import 原先还捎带了一个
 * 成长引擎的**死 import**（本文件零调用），本条注释一度把它写成「本文件与成长
 * 引擎的接缝」—— 那会让「谁调用成长引擎」这个问题在本文件里得到一个**假答案**。
 * 现已删除该名字，并改正本注释：本文件**不持有**任何成长引擎入口，成长任务的
 * 唯一生产入口是 `provider-credits.ts` 的 `afterClaim`（由 `credits.claimAll`
 * 消费）。别再回到这里找。
 */
export { collectBuddyGrowth };
/**
 * ⚠️ **`GROWTH_CAPABLE_PROVIDERS` 已删除**（2026-10-08 Task 4）。
 *
 * 它原是一张手抄的 `Set([CODEBUDDY.id])`，与客户端的能力表平行存在。现由
 * **能力表本身**回答「哪家有成长中心」：`runtime.credits?.afterClaim !== undefined`
 *（`src/provider-credits.ts` 只给 buddy 挂 `afterClaim`）—— 与 Task 1b 同一个理由：
 * 消除平行副本，让「哪家有成长中心」由能力注册表说了算。
 *
 * ⚠️ 客户端那一侧（`GROWTH_TASK_PROVIDERS`，决定是否传 `runTasks`）**仍然存在且必须存在**：
 * 它决定「按钮渲不渲染」，而服务端这里决定「受不受理」。两处的**取值来源**现在
 * 都是能力声明，不再有第三份手抄名单。
 */
/**
 * 整轮成长任务的时间预算缺省值（毫秒）。
 *
 * 上界由**账号数 × 逐账号预算**决定（后者缺省 10 分钟），账号多时线性增长。
 * 30 分钟约覆盖 3 个账号从容跑完；超出即如实停住并报出未跑的账号，而不是撞上
 * 宿主 RPC 的超时（该上界由 dsh 侧决定，本插件不可见也不可控）。
 */
const DEFAULT_ROUND_BUDGET_MS = 30 * 60 * 1000;
import { captchaDemand, putSuppliedParam, } from './captcha-supply.js';
import { ZCODE_CAPTCHA_FALLBACK } from './zcode-captcha.js';
import { buildCarrierPageHtml } from './zcode-carrier-page.js';
import { pickTestModel, resetAccount, resetAllAccounts, retestAccount, retestAllAccounts, testAccount, } from './account-probe.js';
import { exportBackup, importBackup } from './backup.js';
import { handleOpencodeRpc } from './opencode-rpc.js';
import { clearDeadModels, deadModelIdsFor } from './dead-model-store.js';
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
/**
 * ZCode 登录渠道的白名单归一。
 *
 * ## 为什么要有这道
 *
 * `account.create` 的载荷来自**客户端自报**（RPC 入口没有 schema 校验），
 * 而 `ZcodeLoginProvider` 只是个 TypeScript 联合类型 —— 运行时任何字符串都能进来。
 * 原先只写 `req.zcodeProvider ?? 'bigmodel'`：缺省兜底是对的，但**没有校验**，
 * 传入 `zhiPu` / `ZAI`（大小写不同）这类未登记值会被原样送进
 * `startZcodeLogin` → 打到一个不存在的授权端点，表现为
 * 「授权页打不开」或「轮询到超时」这类极难定位的失败。
 *
 * ## 为什么**回落**而不是报错
 *
 * 回落方向与既有的 `?? 'bigmodel'` 兜底一致：老客户端、新客户端、
 * 手改过载荷的用户都还能登录（只是用缺省渠道）。且前端只会下发下拉框里的
 * 两个值，正常路径永远走不到这条分支 —— 它是**兜底**不是**主路径**。
 * 真正非法的输入会留一条 `console.warn`（与本文件其余告警同一惯例），
 * 便于事后发现是哪个客户端在发怪值。
 *
 * @param raw 客户端自报的渠道（可能未登记）
 * @returns 可安全交给 `zcode.startLogin` 的渠道
 */
export function normalizeZcodeLoginProvider(raw) {
    if (raw === 'zai')
        return 'zai';
    if (raw !== ZCODE_LOGIN_PROVIDER) {
        // ⚠ 只在**非缺省**时记 warn：`undefined` 是绝大多数调用方的形态（老客户端不传），
        //   对它刷日志等于每建一个账号多一行噪音，会把真正的异常埋掉。
        if (raw !== undefined) {
            console.warn(`[jet-hub] 未登记的 zcode 登录渠道 ${JSON.stringify(raw)}，已回落到 ${ZCODE_LOGIN_PROVIDER}`);
        }
    }
    return ZCODE_LOGIN_PROVIDER;
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
 * ⚠️ **必须与前端 `plugin-src/client/jet-hub.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 登记条件：**余额响应里能拿到逐包的到期时间**（归一化到 `deductionEndTime`），
 * 从而分出「快到期」与「不会马上作废」两桶。判据见
 * `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` —— 它只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
 *
 * | provider | 分桶依据 |
 * |---|---|
 * | Loomy | 服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）两个命名池 |
 * | CodeBuddy / WorkBuddy | 资源包列表的 `DeductionEndTime` 距今是否满窗口天数 |
 * | TRAE（字节） | 资源包列表的**条目级** `expire_time`（秒级 Unix 时间戳） |
 * | LobsterAI（有道） | 资源包列表的 `expiresAt`（ISO 8601） |
 *
 * ⚠️ TRAE / LobsterAI **不区分「每日额度」与「永久积分」两个命名池**，但同样能按
 * 到期时间分桶 —— 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。
 * 拿不到到期时间的包归入**永久桶**（保守方向：宁可锁定时少用一个号，
 * 也不要把长期积分误当快到期烧掉，见 `splitBuddyCreditsByExpiry` 注释）。
 *
 * 仍未登记的渠道（CodeArts / Qoder / Cline / Raccoon / Minimax / ZCode / Gemini /
 * OpenCode）：余额响应里没有逐包到期时间，或根本没有资源包列表 ——
 * 分不出两桶，登记进来只会多一个无效开关。
 *
 * ## ⚠️ 2026-10-08 起从 `PROVIDER_REGISTRY` 派生
 *
 * 原先这是一份手抄 `Set`，而客户端 `supportsPermanentLock` 读的是 registry 的
 * `permanentLock` 字段 ⇒ **两处必须一致**（不一致会出现「按钮渲染出来了，
 * 点了却报 bad-request」）。现在两侧同出一个字段，不再可能漂移。
 * 上面那张「分桶依据」表已随值迁移到 registry 里各条的注释。
 *
 * ⚠️ **本常量是模块级、但这里安全**：它只读 `PROVIDER_REGISTRY`（Task 1 的
 * **静态数据**），**不读 runtime 注册表** —— 后者要到 `apply()` 才填充，
 * 模块级求值会得到空集（`WIRED_EXPIRY_PROVIDERS` 那条注释记的正是这个陷阱，
 * 但那里是**刻意**保持常量的，理由见 `aggregate-expiry.ts`）。
 * 判据是「读的是不是静态数据」，不是「是不是模块级常量」。
 */
export const PERMANENT_LOCK_PROVIDERS = new Set(PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id));
/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 *
 * ★ **按单位分开累加**（2026-10-04，真实缺陷）：`totalCredit` 这个标量会把
 * 不同量纲加在一起（ZCode 的 1 亿 token + 100 积分 = `100000100`），单位信息
 * 一旦在这一层丢掉，下游无论怎么写文案都只能标一个「积分」。故同时产出
 * `totalByUnit`，消费方一律用它（见 `RpcCreditsClaimSummary.totalByUnit`）。
 *
 * ⚠️ `totalCredit` **保留原语义**（跨单位求和），只为不破坏既有契约；
 * **不要**在展示路径上用它 —— 那正是本缺陷的成因。
 */
export function computeClaimSummary(outcomes) {
    const summary = {
        claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
        totalByUnit: { token: 0, credit: 0 },
    };
    for (const outcome of outcomes) {
        switch (outcome.kind) {
            case 'claimed':
                summary.claimed += 1;
                summary.totalCredit += outcome.credit;
                // ⚠️ 单位缺省按 `credit`（与 `ClaimOutcome.unit` 的声明一致）——
                // 只有 ZCode 显式传 `'token'`，其余 11 个渠道逐字不变。
                summary.totalByUnit[claimUnitOf(outcome.unit)] += outcome.credit;
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
    /** 仅在 deps.afterClaim 存在时非空；见该钩子的说明。 */
    const growth = [];
    // 整轮共享截止时刻。0 / 负数 / 非有限值一律视为不限时（本地排障用）。
    const rawRound = deps.roundBudgetMs === undefined
        ? DEFAULT_ROUND_BUDGET_MS
        : Number(deps.roundBudgetMs);
    const roundBudgetMs = Number.isFinite(rawRound) ? rawRound : 0;
    const roundDeadlineAt = roundBudgetMs > 0 ? Date.now() + roundBudgetMs : undefined;
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
        // 成长中心等「领取之后」的下钻：与签到共用这一趟循环，避免把凭据解析做两遍。
        // 它的异常只让该项自己失败，不影响已定稿的签到 outcome。
        if (deps.afterClaim !== undefined) {
            try {
                const resolvedForGrowth = await deps.resolve(credentialRef(entry.credentialRef));
                if (resolvedForGrowth !== undefined) {
                    const credentialForGrowth = JSON.parse(resolvedForGrowth.value);
                    const extra = await deps.afterClaim(credentialForGrowth, product, entry, outcome, roundDeadlineAt);
                    if (extra !== undefined) {
                        growth.push(extra);
                    }
                }
            }
            catch (error) {
                deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 成长任务失败: ${String(error)}`);
            }
        }
    }
    return {
        results,
        summary: computeClaimSummary(outcomes),
        ...(growth.length > 0 ? { growth } : {}),
    };
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
        let extra;
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
                    extra = detailed.extra;
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
            ...extra === undefined ? {} : { extra },
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
 * 采集网关目录（**含思考档位视图**）。
 *
 * ⚠️ 两个 RPC 分支（`gateway.getEnabled` / `gateway.setEnabled`）必须共用本函数：
 * 设置页看到的档位与 `/v1/reasoning-efforts` 返回的必须同源，各算一遍必然漂移，
 * 而漂移的症状是「照着设置页填的对不上网关实际接受的」—— 本功能存在的全部理由
 * 就是消灭这种对照错误，自己再造一个就毫无意义了。
 *
 * 档位要逐模型 `resolveModelInfo` 才拿得到（`listModels` 不带），成本是每个模型
 * 一次**读缓存**的调用（远端目录刚被 `listModels` 拉过），与 DSH 自己
 * `buildModelCatalog` 的形状一致。
 */
async function collectGatewayCatalog(llm, providers, onError) {
    const source = {
        listProviders: () => providers,
        listModels: (provider) => llm.listModels(provider),
    };
    const resolve = llm?.resolveModelInfo;
    if (typeof resolve === 'function') {
        source.resolveModelInfo = (provider, model) => resolve.call(llm, provider, model);
    }
    const groups = await collectGatewayModels(source, onError);
    const views = await collectGatewayEffortViews(source, groups, onError);
    return toGatewayModelIds(groups, views);
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
 * 按 provider id 取 auth 实例。
 *
 * ⚠️ **键是 provider id**（`qodercn`），不是变量名（`qoderCn`）——
 * 这是 `JetHubAuths` 的接口约定（见其注释）。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `'constructor'`），
 * 把 `entry.provider` 为怪值时误判成「有该 provider」。
 */
export function authOf(auths, provider) {
    if (!Object.hasOwn(auths, provider))
        return undefined;
    return auths[provider];
}
/**
 * ⚠️ 2026-10-08 改：各 provider 形参从**位置传参**改为**命名对象**（`auths`）。
 *
 * 原注释记录「历史上已因少传/插队错位复发 **6 次**」—— 位置参数天生有这个缺陷
 *（改签名顺序、插一个新 provider 都会静默错位，而症状是「某个 provider 在用
 * 另一个 provider 的凭据续期」）。命名对象让错位在**类型层面不可能**，
 * 且新增 provider 只加一个键。
 *
 * ## ⚠️ 积分能力表**不是形参**（2026-10-08 设计复审 C1）
 *
 * Task 3 初版曾在本函数末尾加**第 5 个形参** `credits?: Readonly<Record<string,
 * ProviderCredits>>`，现已删除。三条理由（复审报告 `.superpowers/sdd/
 * task-3-design-eval.md` §4/§6）：
 *
 * 1. **它在生产路径上不承载任何信息** —— `src/index.ts` 传进来的正是
 *    `createProviderCredits({ loomy, raccoon, zcode })`，而这三个实例就是本函数
 *    形参 `auths` 里的 `loomy` / `raccoon` / `zcode`；`registerJetHubEndpoints`
 *    自己现造的那份**逐字节等价**。删掉实参生产行为不变 ⇒ 它是**纯测试接缝**，
 *    而「形参一侧 === 生产分派」这件事**没有任何测试守着**。
 * 2. **它重开了 Task 9 刚关掉的门** —— 一个可选的**位置**形参：在它之前插入
 *    任何新的可选形参，调用点 `(…, modelAdapters, creditsTable)` 就会**静默**
 *    把表落进新形参（本仓库实测复发 6 次的位置错位形态）。`modelAdapters` 与
 *    `credits` 值类型不同，互换会被 `tsc` 抓到，但**插入**不会。
 * 3. ⇒ 改为**从 `auths` 派生**（见 `registerJetHubEndpoints` 里的 `credits`），
 *    签名回到 4 个形参。
 *
 * ⚠️ **全局注册表（`ProviderRuntime.credits`）仍然保留且必须保留** —— 那是
 * Task 5 的 `aggregate-expiry.ts` / Task 8 的 `account-probe.ts` 这类
 * **拿不到 `auths` 形参**的跨模块消费点的唯一入口，由 `src/index.ts` 的
 * `registerProviderRuntime` 挂上。它与本函数现造的表**同源同构**
 *（同一个工厂、同一批实例），只是消费方不同。
 *
 * ⚠️ 端点级「表真的驱动分派」的测试改由模块替身注入
 *（`tests/unit/credits-runtime-parity.spec.ts` 的 `vi.mock('provider-credits')`）——
 * 断言仍打在**端点响应**上，判别力与原形参方案逐条等价。
 */
export function registerJetHubRpc(ctx, pool, 
/** ⚠️ 命名对象，不是位置参数。键是 provider id（见 `JetHubAuths`）。 */
auths, 
/**
 * provider → 适配器实例（可选）。
 *
 * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
 * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
 * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
 */
modelAdapters) {
    ctx.inject(['connection'], (connectionCtx) => {
        registerJetHubEndpoints(connectionCtx, pool, auths, modelAdapters);
    });
}
/**
 * 取某 provider 的**模型 id**（两个目录来源的并集），供「关闭全部」「关闭供应商」
 * 与「测试账号选模型」共用。
 *
 * ## ⚠️⚠️ 并集是必须的，不能「优先 `listAllModels()`」（真实缺陷）
 *
 * 本仓库有两个「目录」来源，**并不总是同源**：
 *
 * | 来源 | 形态 |
 * |---|---|
 * | `modelAdapters[provider].listAllModels()` | 不套黑名单；**冷缓存下是编译期兜底表（子集）** |
 * | `llm.listModels(provider)` | **真实远端目录 − 黑名单**；异步、可能失败 |
 *
 * 原实现是「**优先** `listAllModels()`，只要它存在就短路、根本不看 `listModels()`」，
 * 而冷缓存下兜底表是**子集**（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`；
 * 实测 `cline` 冷缓存只有 **3** 条，远端有 **460** 条）⇒ 两个关闭方向都会写出
 * **只含兜底表条目**的黑名单，而端点返回「成功」：
 *
 * - `model.setAllDisabled`：用户以为整个供应商已关闭，而**几百个模型仍可选**；
 * - `provider.setEnabled`：更重 —— `provider.status` 的 `closed` 判据是
 *   `total > 0 && disabled === total`，而 `total` 也取自 `listAllModels()`
 *   ⇒ 界面**显示为已关闭**，对话框里那几百条却**仍能选中**。这正是该端点注释里
 *   列为**必须避免**的「账号全停用但模型仍可见」形态的镜像。
 *
 * 用户报障路径**恰恰是冷缓存**（脚本/设置页首次打开就点「关闭全部」）。
 * ⚠️ 既有注释其实早已立下约定「失败时**不落盘** —— 否则会写入一个不完整的
 * 黑名单，用户看到『关了一半』且无从判断原因」，但 `listAllModels()` 冷缓存返回
 * 子集时它**不算失败**，于是绕过了那条守卫。并集把那个缺口补上。
 *
 * ## ⚠️ 适配器那一半**不能丢**（即使远端成功）
 *
 * `listModels()` 会把**已被用户关闭**的模型过滤掉，而适配器目录带着它们。
 * 漏掉会让 `provider.setEnabled` 的 `ids.length === 0` 判据在「全部已关闭」时
 * 误判成「没有可关闭的模型」而拒绝操作。
 *
 * ## ⚠️ 与 `readableCatalogIds` 的分工：**目录来源只此一处**
 *
 * 两者共用本函数取目录，区别只在**失败时的动作**：写黑名单的调用方**拒绝操作**，
 * 提示层（`readableCatalogIds`）**放弃核对**。
 * ⚠️ **不要在这里或那里再各写一份目录来源逻辑** —— 本仓库踩过「一文件两套同义
 * 判据必然先腐坏一套」（IKJW33 修复时实测出内层判据在生产路径上不可达）。
 *
 * ⚠️ **远端读取带超时**（{@link CATALOG_READ_TIMEOUT_MS}）：这是写操作的前置读取，
 * 不能把用户点开关的等待无限拉长。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param modelAdapters - 设置页目录来源（并集的一半，同步、不产生网络请求）。
 * @param provider - 目标 provider。
 * @returns 见 {@link FullCatalogResult}（**部分成功**是合法结果）。
 */
async function fullCatalogIds(ctx, modelAdapters, provider) {
    // ── 来源一：适配器目录（同步；但**冷缓存下是兜底子集**）──
    // ⚠️ 它抛错**不独自决定成败**：远端那一半仍可能成功，故单独吞掉。
    const adapterIds = [];
    try {
        for (const model of modelAdapters?.[provider]?.listAllModels() ?? [])
            adapterIds.push(model.id);
    }
    catch {
        /* 适配器异常不该让整个读取失败：远端目录仍可用 */
    }
    // ── 来源二：远端真实目录（权威；冷缓存下会真发一次拉取）──
    const llm = llmServiceOf(ctx);
    if (llm === undefined) {
        // ⚠️ 远端拿不到 ⇒ 只剩兜底子集 ⇒ **不可用于写黑名单**（`complete: false`）。
        return { ids: adapterIds, complete: false, remoteError: 'llm 服务不可用' };
    }
    let remoteIds;
    try {
        remoteIds = (await withTimeout(llm.listModels(provider), CATALOG_READ_TIMEOUT_MS))
            .map((model) => model.id);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ids: adapterIds, complete: false, remoteError: `读取模型列表失败：${reason}` };
    }
    // ⚠️⚠️ **远端读到但为空 ⇒ 同样不可用于写黑名单**（`complete: false`，且**无**
    // `remoteError` —— 它不是错误）。含义是「看不到」（无账号门控），不是
    // 「该 provider 一个模型都没有」；此时适配器兜底表仍可能有内容，照它写黑名单
    // 就是同一个缺陷的另一个入口（见 `FullCatalogResult.complete` 的长注释）。
    return {
        ids: [...new Set([...adapterIds, ...remoteIds])],
        complete: remoteIds.length > 0,
    };
}
/**
 * 核对目录时的读取预算（毫秒）。
 *
 * 开关是**写操作**，不该被远端目录拉取拖住（见 `readableCatalogIds` 的注释）。
 * 取 2 秒：缓存已热时是纯内存读、立即返回；冷缓存下的正常远端拉取也在秒级内
 * 完成，超过它说明上游正卡着 —— 此时放弃核对、照常写入开关。
 * ⚠️ 不要为了「多拿到几次核对」而调大：这条预算**直接加在用户点开关的等待上**。
 */
const CATALOG_READ_TIMEOUT_MS = 2000;
/**
 * 给一个 Promise 加超时；超时即 reject（调用方按「读不到」处理）。
 *
 * ⚠️ **不取消底层请求**（`listModels` 不接受 signal）：只是不再等它。
 * 这是刻意的 —— 底层那次拉取的结果仍会填进 `ModelCatalog` 的缓存，
 * 对后续的 `model.list` 有用，取消反而浪费。
 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`catalog read timed out after ${ms}ms`)), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
}
/**
 * 核对一批 id 是否**真的在**当前模型目录里，为「静默空操作」生成 warnings。
 *
 * ## 解决的报障（Issue IKJW33，2026-10-08）
 *
 * 对**已从上游目录消失**的模型 id 调 `on`/`off`，旧实现返回「成功 1」却
 * **什么都没发生、且没有任何警告**。用户实测两例：
 * `cline/cline-free/deepseek-v4.1-flash` 与 `cline/stealth/space-bunny-alpha`
 * 在 10-05 记录「上游 model not found」后已从 cline 目录消失（490 → 489）。
 * 后果：① 脚本/AI 助手据「成功 1」误判开关已生效；② 黑名单里残留幽灵条目，
 * 模型在 GUI 已看不见、关闭记录却还挂着，导入号池时还会被一起搬走。
 *
 * ## ⚠️⚠️ 判据必须是**两个目录来源的并集**（两个方向都已被实测证伪）
 *
 * 本仓库有两个「目录」来源，**它们并不总是同源**：
 *
 * | 来源 | 谁在用 | 形态 |
 * |---|---|---|
 * | `llm.listModels(provider)` | 对话框模型选择器 | **真实远端目录 − 黑名单** |
 * | `modelAdapters[provider].listAllModels()` | **设置页**（`model.list`） | 不套黑名单；**冷缓存下是编译期兜底表** |
 *
 * 只取任一个都被实测证伪：
 *
 * - **只取 `listAllModels()`**（本修复第一版）⇒ 冷缓存下兜底表是**子集**：
 *   实测 `cline` 冷缓存只返回 **3** 条（`fallbackModels`），远端却有 **460** 条
 *   ⇒ 远端任意正常模型都被误报。而 issue 的复现路径**恰恰是冷缓存**
 *   （脚本直接调 `on`，从未先跑 `list`）。
 * - **只取 `listModels()`**（第二版）⇒ 在 `opencode` 上**反向**误报：它的
 *   `listAllModels()` **恒返回**编译期兜底表（永不读远端），而 `listModels()`
 *   在**只有匿名槽**时还会 `filter(isFree)` ⇒ 设置页看得见的付费模型在
 *   `listModels()` 里**一个都没有**。审计实测：无付费账号时关闭 13 个设置页
 *   可见的模型，**13/13 全部收到假警告**（「该模型可能已被上游下架」，
 *   而它并没有下架，只是当前匿名身份看不到）。
 *
 * ⇒ 取**并集**。方向刻意是「宁漏勿误」：`known` 越大 ⇒ `missing` 越小 ⇒
 * 误报越少。提示类信息的**误报比漏报糟得多**（用户会对整类提示脱敏），
 * 故宁可漏报（少一条提示）也不能误报（把正常模型说成已下架）。
 *
 * ## ⚠️⚠️ `listModels()` 失败**必须整体放弃核对**，不得退化成「只用兜底表」
 *
 * `listModels()` 是**唯一**能反映远端真实目录的来源（`listAllModels()` 在
 * 冷缓存与 opencode 上都可能是编译期快照）。它读不到（超时 / 抛错 / 空目录）时
 * 若仍拿 `listAllModels()` 去核对，就**退化回第一版的误报形态**。
 * ⇒ 直接返回 `undefined`（放弃核对），开关照常写入、不带任何警告。
 *
 * ⚠️ **这是刻意的取舍，不是漏写**：代价是「远端目录首次拉取就失败」时
 *（凭据过期 / 上游抖动）连兜底表也不用来核对 ⇒ issue 的原始场景
 *（脚本冷启动直调 `on`）恰好最可能命中这条**漏报**面。
 * 接受它，因为反向（拿快照当权威）会把**正常模型**说成已下架。
 *
 * ## ⚠️ 黑名单必须在**本函数内部**、于 `await` **之后**读
 *
 * 下面把黑名单里 `true` 的 id **并回** `known`：那是「在目录里、但被用户关着」，
 * 用户能重新打开它 ⇒ 不能判成「不在目录」。
 *
 * ⚠️⚠️ **这个读取刻意放在 `await listModels()` 之后**（真实缺陷，审计实测）：
 * 若由调用方在 `await` **之前**取快照传进来，则「快照」与「实际写入」之间隔着
 * 一次 `listModels`（冷缓存下最长 {@link CATALOG_READ_TIMEOUT_MS}）—— 期间
 * 另一路 RPC 的写入会让快照失真，实测出现「**实际产生了变更却报『本次没有产生
 * 任何变更』**」（与 issue 要消除的误导同型）。放在这里之后，从读黑名单到写入
 * 全是**同步代码、无 await** ⇒ 窗口归零。
 *
 * ## ⚠️ `dead` 表里的 id 算「不在目录」，但文案必须可操作
 *
 * 失效模型被 `withDeadModelPruning` 从**两个来源**同时剔除（`llm.listModels`
 * 与 `modelAdapters.listAllModels` 都是 pruned 代理），而 `model.list` 又把它们
 * 补回设置页（带 `dead:true`）供用户点「重新显示」⇒ 它们天然落在判据的
 * 「目录外」。issue 的两例正是这个形态。只说「不在目录」不够 ——
 * 必须告诉用户去点「重新显示」（`model.clearDead`），否则他无从下手。
 *
 * ## ⚠️ 放弃核对（返回 undefined）的三种情况
 *
 * 1. **`listModels()` 读失败**（超时 / 抛错）—— 理由见上，这是**关键**一条；
 * 2. **`listModels()` 返回空**：`createModelCatalog` 在「无已登录账号」时返回
 *    `[]`（门控隐藏整个 provider）⇒ 空目录意味着「看不到」而非「全部下架」；
 * 3. **`llm` 服务缺失**：拿不到远端目录，无从核对。
 *
 * ⚠️ **目录来源取自 `fullCatalogIds`，本函数不自己再取一遍** ——
 * 两处各写一份「哪个来源优先」的判据，就是本仓库踩过的
 * 「一文件两套同义判据必然先腐坏一套」（那次实测出内层判据在生产路径上**不可达**）。
 * 这里只负责把它的**失败**翻译成「放弃核对」（提示层错了不如不说），
 * 而两个关闭方向把同一个失败翻译成「拒绝操作」（写黑名单必须完整）。
 *
 * ⚠️ **必须带超时**：`listModels()` 在**冷缓存**下会真的发一次远端拉取
 *（`loadCatalog()`），于是「开关」这个原本纯本地的写操作多了一条网络依赖。
 * 开关**绝不能**被远端拖住 —— 用户点一下开关却转圈几十秒，比少一条提示糟得多。
 * 故核对是**尽力而为**：超时（{@link CATALOG_READ_TIMEOUT_MS}）即放弃核对。
 * ⚠️ GUI 路径上缓存通常已热（用户先看到模型列表才会去点开关），此时是纯内存读、
 * 无新增延迟；只有「脚本冷启动直接调开关」才可能等一次拉取。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param pool - 读黑名单（**在 await 之后**，理由见上）。
 * @param modelAdapters - 设置页目录来源（并集的一半）。
 * @param provider - 目标 provider。
 * @returns 可核对的目录 id 集合；`undefined` = **放弃核对**（三种情况见上）。
 */
async function readableCatalogIds(ctx, pool, modelAdapters, provider) {
    const catalog = await fullCatalogIds(ctx, modelAdapters, provider);
    // ⚠️⚠️ **目录不可用 ⇒ 整体放弃核对**（判 `complete`，它同时覆盖
    // 「远端读失败」与「远端读到但为空」两种形态 —— 见该字段的长注释）。
    // 不得退化成「只用 listAllModels 兜底表」：那会退回第一版的大面积误报。
    // 提示层错了不如不说。
    if (!catalog.complete)
        return undefined;
    const known = new Set(catalog.ids);
    // ⚠️ 并回「被关着」的 id —— **必须在 await 之后读**（理由见函数头）。
    // ⚠️ `fullCatalogIds` 的并集**已含**适配器目录里那些被关闭的 id，
    // 但**不含**「既不在适配器目录、也不在远端目录」的历史死键（那些只存在于
    // 黑名单里）。它们必须并回来：打开方向正是清理它们的唯一路径。
    for (const [id, disabled] of Object.entries(pool.listDisabledModels(provider))) {
        if (disabled === true)
            known.add(id);
    }
    return known;
}
/**
 * 为「静默空操作」生成 warnings（纯函数，判据与取舍见 {@link readableCatalogIds}）。
 *
 * @param known - 可核对的目录 id 集合（**已含**黑名单里的 id）；`undefined` = 放弃核对。
 * @param provider - 目标 provider（查 dead 表给可操作指引）。
 * @param ids - 本次操作的模型 id（已去重）。
 * @param disabled - 目标状态：true = 关闭，false = 打开。
 * @returns 警告文案（无警告时为空数组）。
 */
function catalogWarnings(known, provider, ids, disabled) {
    if (known === undefined)
        return [];
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length === 0)
        return [];
    const dead = deadModelIdsFor(provider);
    /** 失效模型的正确动作是「重新显示」，必须给出这条可操作指引。 */
    const hint = (id) => dead.has(id)
        ? '（已被判为失效，可在模型列表里点「重新显示」恢复）'
        : '（该模型可能已被上游下架）';
    return missing.map((id) => disabled
        // 关闭方向：写入生效了，但它本来也不在可选列表里，故不影响实际可选集合。
        ? `${id} 不在当前模型目录，本次关闭不影响可选列表${hint(id)}。`
        // 打开方向：黑名单里没有它（有的话已被 `readableCatalogIds` 并回 `known`）
        // ⇒ 本次既没写也没删，是纯空操作。
        : `${id} 不在当前模型目录，且黑名单里没有它 —— 本次没有产生任何变更${hint(id)}。`);
}
/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(ctx, pool, auths, modelAdapters) {
    // ⚠️ 解构一次，函数体其余部分**逐字不动** —— 这样本次改动的 diff 面最小，
    //    评审能一眼看出「只是换了个入口」。
    //
    // ⚠️ **`qodercn` 必须重命名绑定**：`JetHubAuths` 的键是 provider id
    //   （`qodercn`），而函数体内部一直用变量名 `qoderCn`。用 `qodercn: qoderCn`
    //   把 id 键绑到本地名，**函数体一个字都不用改**。
    //   ⚠️ 若写成 `qoderCn`（键=变量名）会**编译失败**（接口没有该键）——
    //   那正是我们要的：键必须是 id，否则 `authOf(auths, provider)` 查不到中国版。
    const { codearts, buddy, workbuddy, lobsterai, qoder, qodercn: qoderCn, trae, cline, loomy, raccoon, minimax, zcode, gemini, accio, } = auths;
    /**
     * 积分能力表。
     *
     * ⚠️ **从 `auths` 现造，没有第 5 个形参**（2026-10-08 设计复审 C1，见
     * `registerJetHubRpc` 的注释）：三家（loomy / raccoon / zcode）的余额查询走
     * **本次注册持有的 auth 实例**上的方法（它们可能带注入的 `fetchImpl`），
     * 其余走自由函数。这正是 `src/index.ts` 显式传参时用的**同一批实例**，
     * 故生产行为与传参时代**逐字节等价**。
     *
     * ⚠️ 结构化类型收窄在**这里**完成（不是把 `ProviderCreditsDeps` 放宽到
     * `unknown`）：`JetHubAuths` 的字段是三个具体 auth 类，它们**天然**满足
     * `ProviderCreditsDeps` 只要求的那三个方法 —— 无需 `as`，改坏签名会被 `tsc` 抓到。
     */
    const credits = createProviderCredits({
        loomy, raccoon, zcode,
        // ⚠️ **`credits.claimAll` 走的就是这张表**（Task 4 起），故 LobsterAI 的
        //    `clientVersion` 必须在这里也接上：它是签到接口的**必填** query 参数，
        //    且要**动态**解析（带 TTL 缓存）—— 漏掉它会让签到退回产品的兜底常量，
        //    而兜底值可能已过期（那正是「集中在此避免三处各自拉取」要防的）。
        //    用惰性调用（不能先 await 成常量：缓存过期后拿到新版本这件事会失效）。
        lobsteraiClientVersion: () => lobsterai.resolveClientVersion(),
    });
    /**
     * **一次性奖励**能力表（Loomy 新手任务 / raccoon 登录奖励）。
     *
     * ⚠️ 与 `credits` 同法：从 `auths` 现造、**没有第 5 个形参**（理由见
     * `registerJetHubRpc` 的注释与设计复审 C1）。两家都走**实例方法**
     *（实例可能带注入的 `fetchImpl`），与 `src/index.ts` 用的是**同一批实例**。
     *
     * ⚠️ 只有 loomy 需要传实例（raccoon 也传，因为它的领取/状态在实例上）。
     */
    const onboarding = createProviderOnboarding({
        loomy,
        raccoon,
    });
    /**
     * 传给各家 credits 实现的调用上下文。
     *
     * ⚠️ 与 Task 5/8 的 `ProviderCallContext` **同形但不同源**：本函数在
     * `registerJetHubEndpoints` 的闭包里，持有的是**本次注册的** ctx / pool，
     * 而全局注册表那条路要等 `index.ts` 装配。两者的字段含义一致
     *（凭据解析 / 日志 / 账号池），故实现侧只需一个形状。
     */
    const callContext = {
        resolveCredential: (refName) => ctx.credentials.resolve(credentialRef(refName)),
        warn: (message) => ctx.logger?.warn?.(message),
        accountPool: pool,
    };
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
     * **真正支持按需续期**的 provider 集合（有 refresh 端点的）。
     *
     * ⚠️ 这是「跳过」与「报错」的分界线，两者的区别是**本质的**：
     * - **不在**本集合里（loomy / zcode / opencode）＝ 该渠道**设计上**没有续期能力，
     *   自愈应当**静默跳过**（不发请求、不记日志）—— 它不是失败，是「无需处理」。
     * - 在集合里但查表失败/续期抛错 ＝ 真失败，必须记 warn。
     *
     * ⚠️ **不能用 `throw` 来表达「不支持」**（对抗审计实测到的真实缺陷）：
     * heal 的 catch 会把异常记成 `自愈续期失败：loomy 不支持…`
     * —— 一条**每次刷新面板都会重复**的误导性告警（loomy 的池内 `expiresAt` 是
     * 本地按 14 天推算的固定值、14 天后必然过期 ⇒ 确定可达），
     * 而它其实什么都没失败。AGENTS.md 已记「重复同一行会把有用信息埋掉」。
     *
     * - loomy / zcode：没有 refresh 端点，其 `refreshAccountCredential` 做的是
     *   **有效性探测**，拿来当续期用只会白发请求；
     * - opencode：匿名通道，无凭据可续（且它**不在** `JetHubAuths` 里）。
     *
     * ⚠️ 本集合的**成员关系**必须与 `JetHubAuths` 的键一致，**只去掉 loomy / zcode**
     * 这两家「设计上没有 refresh 端点」的（opencode 根本不在 `JetHubAuths` 里）——
     * 合并 2026-10-08 的 provider 抽象重构后用 {@link authOf} 查表，
     * 故这里只是**能力判据**（该不该尝试自愈），不是分派表本身。
     *
     * ⚠️⚠️ **这个「只去掉两家」的方向此前没有守卫**（2026-10-12 复审实测）：
     * `credits-balance-self-heal.spec.ts` 原先只锁「本集合 ⊆ `JetHubAuths` 的键」
     * （挡住假 id），**反向没有** —— 于是新 provider 进了 `JetHubAuths` 却忘了
     * 登记到这里时**全绿**，而它的过期账号**永不自愈**（issue IKKHL5 的形态：
     * 积分行报「未登录」而上游其实只需一次 refresh）。现该文件已补上反向用例
     * （逐键点名 + 显式豁免表），新增 provider 漏登记会**点名变红**。
     */
    const SELF_HEAL_REFRESHABLE_PROVIDERS = new Set([
        'codearts',
        'buddy',
        'workbuddy',
        LOBSTERAI.id,
        QODER.id,
        QODER_CN.id,
        TRAE.id,
        CLINE.id,
        RACCOON.id,
        MINIMAX.id,
        GEMINI.id,
        // ⚠️ officeace（2026-10-13 审计补）：STS 寿命**约 2 小时**，正落在
        // 「睡眠/挂起恢复后到定时器补触发那一轮之间」这个窗口内 ⇒ 漏登记的症状
        // 与 issue IKKHL5 逐字相同（卡片红「已过期」+ 积分行 HTTP 401 + 窗口内
        // 无手动自救），且**日志零字**。
        // 同款陷阱已发生过一次（accio），见 `docs/agent-notes/providers-accio.md`
        // 的「接线陷阱（新 provider 通用）」。⚠️ 它有真实 refresh 端点
        // （`officeace-auth.ts` 的 `doRefreshCredential` 打华为 STS），故不属于豁免。
        OFFICEACE.id,
        // ⚠️ accio **有** refresh 端点（`accio-auth.ts` 的 `refreshCredential`）且
        // 池内 `expiresAt` 确实会被写 ⇒ 不属 loomy / zcode 那类豁免。
        // 漏登记的后果是「凭据明明能续，面板却报未登录」（2026-10-12 复审发现）。
        ACCIO.id,
    ]);
    /**
     * 自愈的**在飞去重**表（key = 账号 id）—— 同一账号的并发自愈共享同一次续期。
     *
     * ⚠️ **必须有**（对抗审计实测证实的真实缺陷）：本端点是**用户可反复触发**的
     * （客户端 `plugin-src/client/jet-hub.js` 的 `loadCredits` 有四个调用点：
     * 面板挂载、签到成功后、领取成功后、「刷新积分」按钮，且**没有重入闸门** ——
     * 对比 `claimCredits` 的 `claimInFlightRef`；按钮的 `disabled: creditsLoading`
     * 是异步 state，连点两次即并发）。宿主还有第二条独立入口：用量徽标每 60 秒
     * 轮询 `usageBadge.read` → 同一个 `handleMethod('credits.balances')`。
     *
     * 而**续期会轮换 refresh_token**（`AGENTS.md` 记过 codearts 那次「三条续期入口
     * 并发消费同一份 refresh_token，1 个成功、其余 invalid_grant」的事故），
     * 并发自愈存在「后写的把先写的新 token 覆盖成已失效旧 token」的风险。
     *
     * ⚠️ 本表只防**进程内、本入口**的并发。跨入口（定时器 `refreshAll`、按需续期）
     * 与跨进程的互斥由各家自己兜（codearts / gemini 有 per-ref `SerialQueue`，
     * 其余几家是既有状态，非本次引入）。
     */
    const balanceHealInFlight = new Map();
    /**
     * 自愈的续期分派：**复用 `account.refresh` 同一处查表**（{@link authOf}）。
     *
     * ⚠️ 2026-10-10（issue IKKHL5 合并 master）：本函数原先自己持一张
     * `provider → auth 实例` 的 switch。合并时发现 master 的 provider 抽象重构
     *（Task 2）已把 `account.refresh` 的那张 switch 收成 `authOf(auths, provider)`
     * ——**正是本函数当初想要的「分派只能有一份」**。故这里改为直接调它，
     * 而不是留两份平行实现（留两份就是本函数注释开头警告的那个缺陷本身）。
     *
     * ⚠️ 仍然**不含 `enabled` 判据**（AGENTS.md 铁律）：停用只影响自动选号。
     */
    const refreshAccountByProvider = async (provider, credentialRefName, accountId) => {
        const auth = authOf(auths, provider);
        // ⚠️ 抛错还是跳过由**调用方**决定：自愈侧先用
        // {@link SELF_HEAL_REFRESHABLE_PROVIDERS} 过滤，故走到这里为空说明
        // 「本以为是可续期的，实际没注册」—— 那是真异常，必须留痕。
        if (auth === undefined)
            throw new Error(`Unknown provider: ${provider}`);
        await auth.refreshAccountCredential(credentialRefName, pool, accountId);
    };
    /**
     * 积分查询前的**按需自愈**（Gitee issue IKKHL5 建议 C）。
     *
     * ## 缺陷
     *
     * 系统睡眠/挂起数小时后恢复，**宿主进程全程没退出**，于是
     * `state.json` 里的 `expiresAt`（= 上次续期时刻 + 令牌寿命）落在过去，
     * 而客户端判据只有一次本地比较（`plugin-src/client/jet-hub.js` 的
     * `account.expiresAt <= Date.now()`）⇒ 卡片显示红色「已过期 · 自动续期」；
     * `credits.balances` 又只 resolve 凭据后直连上游、**全程不续期**
     * ⇒ 积分行报「账户信息查询失败：HTTP 401」。该窗口内**没有任何手动
     * 自救手段**（「重测」的 refresh 是刻意 no-op）。
     *
     * ## 为什么这一层是对症的（而不是 issue 建议的 A：墙钟跳变检测）
     *
     * 实测（`NtSuspendProcess` 真实挂起 8 秒 = 等比 4 小时）：libuv 定时器基于
     * **单调时钟**，睡眠时长 > interval 时**恢复瞬间就补触发**一轮；所以
     * 「睡几小时」并不需要墙钟检测来抢救。真正的缺口是**恢复后的第一轮要等
     * 最多一个 interval**，而短寿命 provider（minimax 1h / codearts 2h /
     * raccoon 3h）在这个窗口里必然显示「已过期」。
     *
     * 本函数让**积分查询这个用户主动发起的动作**自带续期：不必等定时器，
     * 一次刷新面板就同时消灭「已过期」显示与 401。
     */
    const healExpiredAccountBeforeBalance = async (entry, 
    /** 「现在」的注入点（只供测试；见 {@link healExpiredAccounts} 的说明）。 */
    now = Date.now) => {
        // ⚠️ 判据与客户端**逐字一致**（同一个表达式），否则会出现「面板说没过期、
        // 这里却发续期请求」或反之的无谓请求。
        //
        // ⚠️ **`typeof` 检查不是冗余**（对抗审计实测的测试盲区）：`expiresAt` 可从
        // **用户可编辑的备份文件**导入，而 `sanitizeAccounts` **不过滤**该字段。
        // 池里若是数字字符串 `'1791559805000'`：保留 `typeof` → 不续期
        // （与客户端判据一致）；删掉 `typeof` 则被 JS 强制转换判为过期 →
        // 宿主与 UI **行为分叉**。
        const expired = typeof entry.expiresAt === 'number'
            && entry.expiresAt > 0
            && entry.expiresAt <= now();
        // ⚠️ **不判 `entry.refreshable`**（issue IKKHL5 建议 C 的原文写的是
        // 「已过期且 refreshable」）：那个布尔是**凭据材料的镜像**、可能被误标，
        // 而本插件已有一条铁律——误标过一次就永不自愈（见 AGENTS.md「账号池的
        // refreshable 只是凭据材料的镜像」）。各家 `refreshAccountCredential`
        // 内部自己按凭据材料判断能否续期（缺 refresh_token 时抛「请重新登录」），
        // 由它给出真终态；这里不预判。
        if (!expired)
            return;
        // ⚠️ **设计上没有续期能力的渠道静默跳过**（不抛错、不记日志）：
        // 用异常表达「跳过」会让每次刷新面板都留下一条误导性告警（loomy 的池内
        // `expiresAt` 是本地按 14 天推算的固定值，14 天后必然过期 ⇒ 确定可达）。
        // 详见 {@link SELF_HEAL_REFRESHABLE_PROVIDERS}。
        if (!SELF_HEAL_REFRESHABLE_PROVIDERS.has(entry.provider))
            return;
        // ⚠️ **在飞去重**：同一账号的并发自愈共享同一次续期请求。
        // 积分端点与领取端点都会被用户反复触发（连点「刷新积分」/「一键领取」、
        // 徽标每 60 秒轮询走同一条 `handleMethod`），而续期**会轮换 refresh_token**，
        // 并发会让「后写的把先写的新 token 覆盖成已失效的旧 token」。
        // 详见 {@link balanceHealInFlight}。
        const existing = balanceHealInFlight.get(entry.id);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const task = (async () => {
            try {
                await refreshAccountByProvider(entry.provider, entry.credentialRef, entry.id);
            }
            catch (error) {
                // ⚠️ **绝不上抛**：续期失败不是「余额/领取失败」——凭据本来就已过期，
                // 直连上游必然 401，让整条积分行报「续期失败：…」反而比原来的
                // 「账户信息查询失败：HTTP 401」更难懂。照常往下走、由上游给出真原因。
                // ⚠️ 文案**刻意不写「余额」**：本函数已同时服务 `credits.balances`
                // 与 `credits.claimAll` 两个端点，「照常查余额」在领取路径上是错的。
                ctx.logger?.warn?.(`[jet-hub] 积分操作前的自愈续期失败（账号 ${entry.id}，照常继续）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        balanceHealInFlight.set(entry.id, task);
        try {
            // ⚠️ **必须 `await`**：本函数的存在意义就是「**先续期、再查余额**」——
            // 不 await 就等于没修（对抗审计实测：改成 `void task` 后 12 条测试全绿，
            // 说明该顺序语义原先没有任何守护；现已由
            // `credits-balance-self-heal.spec.ts` 的「顺序」用例锁住）。
            await task;
        }
        finally {
            // ⚠️ 必须在 `finally` 里删除：续期失败时也要放行下一次自愈，
            // 否则一次失败会把该账号的自愈**永久焊死**（与 `SerialQueue` 的
            // 「失败也必须放行下一个」同一条教训）。
            // ⚠️ 只删自己这一条：并发时后来者读到的是同一个 task，删掉的也应是它
            //（用值比较而不是无条件 delete，避免把「后来者刚建的新 task」误删）。
            if (balanceHealInFlight.get(entry.id) === task) {
                balanceHealInFlight.delete(entry.id);
            }
        }
    };
    /**
     * 自愈的**整轮预算**（毫秒）。
     *
     * ⚠️ **必须有**（对抗审计实测的真实缺陷）：本自愈是**逐账号顺序 await，
     * 每个账号一个真实 HTTP 续期**，而各家 `AbortSignal.timeout` 是
     * 20~60 秒（codearts / buddy / raccoon 60s，lobsterai / qoder / trae /
     * cline / minimax 30s，gemini 20s）。池里 39 个账号全过期且全部超时时，
     * 最坏 **39 × 60s ≈ 39 分钟**，而这发生在**用户点一下就等**的
     * `credits.balances` / `credits.claimAll` 入口上（徽标还会每 60 秒轮询
     * 走同一个 `handleMethod`）。
     *
     * 原有的 `DEFAULT_ROUND_BUDGET_MS`（30 分钟）**管不到这里** —— 它只在
     * `collectClaimResults` 的成长任务路径（`afterClaim`）里被消费。
     * 若不设闸门，症状会从「积分行报 HTTP 401」**恶化成「整个端点超时、
     * 余额与领取结果一起丢」** —— 比原缺陷更糟。
     *
     * ⚠️ 语义与 `collectClaimResults` 的 `roundBudgetMs` 保持一致：
     * 到点后**停止继续自愈、但不失败**（余下账号留给下一轮/定时器），
     * 因为「没来得及续期」远好于「整个端点拿不到任何结果」。
     */
    const SELF_HEAL_ROUND_BUDGET_MS = 60_000;
    /**
     * 逐账号**顺序**执行自愈（供 `credits.balances` 与 `credits.claimAll` 共用）。
     *
     * ⚠️ **必须串行、不得改 `Promise.all`**（对抗审计实测的测试盲区：改成并行后
     * 测试全绿，而「顺序执行避免并发触发风控」是本端点的既有约定，见
     * `collectCreditBalances` 的注释；并发续期还有轮换 token 的覆盖风险）。
     * 由 `credits-balance-self-heal.spec.ts` 的**双账号**顺序用例锁住
     *（单账号时串行与并行不可区分 —— 那正是它当初漏掉的原因）。
     *
     * ⚠️ **受 {@link SELF_HEAL_ROUND_BUDGET_MS} 约束**：到点即停，余下账号
     * 交给下一轮（见该常量的说明 —— 不能让自愈把端点本身拖超时）。
     * ⚠️ 预算判据在**每个账号之前**检查：已经开始的续期不打断
     *（它有自己的 20~60 秒超时兜底），故实际耗时上界是
     * `预算 + 单个续期超时`，而不是「预算 + N × 超时」。
     */
    const healExpiredAccounts = async (accounts, 
    /**
     * 「现在」的注入点。⚠️ **只供测试**注入确定时刻 ——
     * 生产不传即用 `Date.now()`。
     *
     * 存在的理由（对抗审计实测的高危点）：`<=` 边界用例原先在自己体内取
     * `const now = Date.now()`，而 heal 内部**再调一次** `Date.now()`，
     * 两者跨毫秒才检出 ⇒ 实测单文件 20 次只有 **10 次**变红（50%），
     * 全量 CI 下 **0 检出**。注入 now 后边界判定变得确定。
     */
    now = Date.now) => {
        const deadlineAt = now() + SELF_HEAL_ROUND_BUDGET_MS;
        for (const entry of accounts) {
            // ⚠️ 到点即停、**不失败**：已开始的续期不打断（见函数注释）。
            if (now() >= deadlineAt) {
                ctx.logger?.warn?.(`[jet-hub] 自愈续期已达整轮预算（${SELF_HEAL_ROUND_BUDGET_MS}ms），`
                    + `本轮停止继续续期（余下账号交给下一轮/定时器）`);
                return;
            }
            await healExpiredAccountBeforeBalance(entry, now);
        }
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
     * OfficeAce 登录的中间状态（账号 id → `{ state, codeVerifier, dpopPrivateJwk }`）。
     *
     * 华为云 OAuth 需要三件东西跨「发起登录」与「轮询取码」两次 RPC 保持：
     * - `state`：云侧签发的一次性状态（**必须**来自 `POST /v1/claw/auth/state`，
     *   自制 state 会在轮询时 404 —— 实测踩过）；
     * - `codeVerifier`：PKCE 原文（换 token 时用）；
     * - `dpopPrivateJwk`：DPoP 的 ES256 私钥（换 token 时签名，且**刷新要复用**）。
     *
     * ⚠️ 放内存而不落盘：`state` 与 `code` 都是**分钟级一次性**凭据，登录完成即无意义；
     *    落盘只会留下无用的秘密副本。真正需要持久化的凭据在 `persistLogin` 之后
     *    由 **DSH 凭据库**接管（按 `credentialRef` 索引，见 `officeace-auth.ts`）。
     *
     * ⚠️ `credentialRef` **必须跟着走**：登录完成时按它把凭据写进**这一个账号**
     *    的槽位。缺了它，新凭据就落到公共 `session.json` 覆盖了别人（2026-10-13）。
     */
    const pendingOfficeAceState = new Map();
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
     * 的异步外壳），不遍历**没有账号**的那些渠道 —— 那些调下去只会拿到空结果。
     */
    const autoCheckin = createAutoCheckin({
        store: createAutoCheckinStore(ctx),
        listProviderIds: async () => {
            const accounts = await pool.listAllAccounts();
            return [...new Set(accounts.map((entry) => entry.provider))].sort();
        },
        claim: (provider) => handleMethod('credits.claimAll', { provider }).then((result) => {
            // ⚠️ 自动签到路径**绕过**了 RPC 请求入口那处清理（它直接调 `handleMethod`）
            //    ⇒ 必须在这里也清一次，否则「启动时自动签到成功 → 用户马上用 auto」
            //    仍会撞上缓存里的 `UNUSABLE`（见 `ModelCatalogSource.clearExpiryCache`）。
            modelAdapters?.['aggregate']?.clearExpiryCache?.();
            return result;
        }),
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
     * `credits.balances` 的分派（Task 3 后是 `credits` 表查表 + opencode / qoder
     * 两个特例；此前是 12 段 `if`）是唯一口径 —— 含 codearts 的
     * 「Token 计费账户」文案、zcode 的逐桶折算等，复制一份必然漂移。
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
                // ⚠️ 领取成功后清**临期折算缓存**（见 `ModelCatalogSource.clearExpiryCache`
                //    的长注释）：zcode 的每日额度要先领取才进 `balances` 桶，而「余额为 0」
                //    现在会被折算成 `UNUSABLE` 并被缓存 60 秒 ⇒ 不清就会让用户「签到成功了，
                //    但 60 秒内 auto 仍说没有可用候选」。
                if (call.method === 'credits.claimAll') {
                    modelAdapters?.['aggregate']?.clearExpiryCache?.();
                }
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
     * 且 `sanitizeAccounts`（`src/jet-hub-store.ts`）只保留三个字段，
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
     * 新凭据由 `startLogin` 直接写入 `account_name` /
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
                // ⚠️ OfficeAce 自愈回填（2026-10-13 修正）：`expiresAt` 回填是后加的
                //    （`6fb110f`），修复前登录留下的池条目缺这个字段 ⇒ 卡片恒显示
                //    「未知」且不会自己补上。列表时若发现缺失，从凭据文件读真实
                //    有效期补上并**写回池**（一次性自愈，之后走正常的登录/续期回填）。
                //
                // ⚠️⚠️ **必须逐账号按 ref 读凭据**（2026-10-13 审计修正，原为广播缺陷）：
                //    原实现调 `readOfficeAceCredential()`（**无 ref** ⇒ 读共享的
                //    `session.json`，即「最后一次登录的那个账号」）再把同一个值写给
                //    **所有**缺 `expiresAt` 的账号 ⇒ 多账号下 A 的有效期显示成 B 的，
                //    方向还可能相反（把好账号显示成已过期）。
                //    这是 AGENTS.md「位置/键错位」防线复发的那一类（已复发 7 次）。
                if (req.provider === OFFICEACE.id && accounts.some((a) => a.expiresAt === undefined)) {
                    for (const account of accounts) {
                        if (account.expiresAt !== undefined)
                            continue;
                        // ⚠️ 逐账号 resolve：该账号自己的 `credentialRef`（**不是** ref 名）。
                        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
                            .catch(() => null);
                        if (!resolved)
                            continue;
                        let expiresAt = Number.NaN;
                        try {
                            // ⚠️ `expiresAt` 是 STS 的 ISO 8601 字符串（不是数值时间戳 ——
                            //    华为这侧没有 buddy / accio 那条秒/毫秒混淆，故无需归一化）。
                            const credential = JSON.parse(resolved.value);
                            if (typeof credential.expiresAt === 'string') {
                                expiresAt = Date.parse(credential.expiresAt);
                            }
                        }
                        catch { /* 凭据不是合法 JSON ⇒ 跳过该账号 */ }
                        // ⚠️ 解析不出来就**跳过这个账号**（绝不广播、也绝不写 NaN：
                        // `updateAccount` 落盘时 `JSON.stringify` 会整个丢弃 `undefined`，
                        // 写 NaN 则会让卡片显示「已过期」——两者都比「显示未知」更糟）。
                        if (!Number.isFinite(expiresAt) || expiresAt <= 0)
                            continue;
                        account.expiresAt = expiresAt;
                        void pool.updateAccount(account.id, { expiresAt }).catch(() => undefined);
                    }
                }
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
                     * ## ⚠ 本分支**不再读官方客户端的本机凭据**（2026-10-05 用户决策）
                     *
                     * 早先有两道「先复用本机已有账号」的短路（孤儿条目收编 + 同 `user_id`
                     * 去重返回），它们依赖解密 `~/.zcode/v2/credentials.json` ——
                     * **已整体删除**（理由见 `src/zcode.ts` 文件头）。⇒ 现在点「添加账号」
                     * **一律**新起一轮 OAuth。
                     *
                     * ⚠ 「点一次多一条」仍由**登录成功后**的去重兜住（下方
                     * `loginResult` 分支里的 `findAccountIdByIdentityField`）——
                     * 判据是插件自己拿到的 `user_id`，不再依赖本机文件。
                     */
                    const started = await zcode.startLogin({
                        refName,
                        // ⚠️ 缺省 `'bigmodel'`（既有行为不变）；`'zai'` 走 chat.z.ai 国际版。
                        // ⚠️ 必须过白名单（真实修复，Gitee issue IKJLK3 E2）：`req` 是**客户端
                        //   自报**的（RPC 载荷没有 schema 校验），原先只做 `?? 'bigmodel'` 兜底，
                        //   任何其它字符串都会被原样送进 `startZcodeLogin` → 打到一个不存在的
                        //   授权端点，表现为「授权页打不开 / 轮询到超时」这类难以定位的失败。
                        //   未登记值一律回落到缺省渠道并记日志（不报错，见下）。
                        provider: normalizeZcodeLoginProvider(req.zcodeProvider),
                    });
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
                else if (provider === GEMINI.id) {
                    /**
                     * Gemini（Cloud Code Assist）走**浏览器回调式 OAuth**（本地
                     * `createServer` 监听 `127.0.0.1` 的 `/oauth-callback`）。
                     *
                     * ⚠️ 与 zcode / codearts 同型：**必须先返回 URL 再等结果** ——
                     * `window.open` 只在用户手势窗口内有效，等授权完成才返回 URL
                     * 会让弹窗被浏览器拦截（AGENTS.md 记过 CodeArts 的同类缺陷）。
                     * `GeminiAuth.startLogin` 内部已保证「立即返回」，这里不得 `await result`。
                     *
                     * ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到
                     * 该账号；登录成功后再回填昵称与 `expiresAt`。失败则删除占位条目，
                     * 不留幽灵账号（照 MINIMAX.id 分支的已验证形态）。
                     */
                    await pool.addAccount({
                        id,
                        provider: GEMINI.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    let geminiStarted;
                    try {
                        geminiStarted = await gemini.startLogin();
                    }
                    catch (error) {
                        // 回调端口占用/网络失败：删掉占位条目，不留幽灵账号。
                        void pool.removeAccount(id).catch(() => { });
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 Gemini 登录（本地回调服务启动失败）：${reason}`);
                    }
                    geminiStarted.result.then(async (credential) => {
                        // ⚠️ 不接收 `persistLogin` 的返回值：它给的是 OIDC `sub`，只适合当稳定
                        // 标识。展示名一律走 `geminiAccountLabel`（见下）。
                        await gemini.persistLogin(credential, { refName });
                        await pool.updateAccount(id, {
                            // ⚠️ 用 `geminiAccountLabel`（邮箱优先）而非 `accountId.slice(0, 8)`：
                            // `sub` 是 21 位数字，截前 8 位得到 `Gemini 10500520` 这种**不可辨认**
                            // 的展示名（用户报障 2026-10-03）。`sub` 的价值是「稳定标识」，不是
                            // 「显示名」—— 展示要的是可辨识，邮箱正好。
                            // 取不到邮箱时该函数回退 `sub`，两者都无则退化为池 id。
                            nickname: geminiAccountLabel(credential) ?? id,
                            // ⚠️ **必须用 `geminiCredentialExpiresAtMs`**：它认 `expiry`
                            //（RFC3339）与 `expires_in`，取不到就返回 `undefined` ——
                            // 传 `undefined` 是「不知道」，不会被写成 0 而让 UI 显示「已过期」。
                            expiresAt: geminiCredentialExpiresAtMs(credential),
                            // ⚠️ Google OAuth 默认 `access_type=offline`，故 refresh_token
                            // 必定下发；这里仍按凭据本体如实判定，不写死 true。
                            refreshable: isGeminiRefreshable(credential),
                        });
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${GEMINI.id} login failed for ${id}: ${String(error)}`);
                        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
                        void pool.removeAccount(id).catch(() => { });
                    });
                    return { ok: true, value: { accountId: id, loginUrl: geminiStarted.loginUrl } };
                }
                else if (provider === OFFICEACE.id) {
                    /**
                     * OfficeAce（华为 ModelArts MaaS）走**华为云 OAuth（PKCE + DPoP）**，
                     * 全程**不依赖 OfficeAce 客户端**（协议逆向见 `officeace-auth.ts` 模块头）。
                     *
                     * ⚠️ 两步式（同 zcode / gemini）：`window.open` 只在用户手势窗口内有效，
                     * 等授权完成才返回 URL 会被浏览器拦截 —— 这里先返回 authorizeUrl，
                     * 后台轮询 `code` 再换 token（`login.poll` 里做）。
                     *
                     * ⚠️ 华为 SSO 通常**自动重定向**（无需扫码 / 无需输密码），用户开页即完成。
                     *
                     * ⚠️ `state` **必须**用云侧签发的那一个（`POST /v1/claw/auth/state`）：
                     * 自制 state 会在轮询时 404（实测踩过）。`codeVerifier` 与 `dpopPrivateJwk`
                     * 与 state 同批生成，必须一起暂存到 `pendingOfficeAceState` 供 `login.poll` 使用。
                     */
                    await pool.addAccount({
                        id,
                        provider: OFFICEACE.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: false,
                        createdAt: Date.now(),
                    });
                    let started;
                    try {
                        started = await auths.officeace.startLogin();
                    }
                    catch (error) {
                        void pool.removeAccount(id).catch(() => { });
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 OfficeAce 登录（华为云授权状态获取失败）：${reason}`);
                    }
                    pendingOfficeAceState.set(id, {
                        state: started.state,
                        codeVerifier: started._internal.codeVerifier,
                        dpopPrivateJwk: started._internal.dpopPrivateJwk,
                        // ⚠️ **必须带上 ref**：`completeLogin` 按它分文件落盘。缺省会让
                        //    新账号的凭据写进公共 `session.json`，覆盖其他账号的凭据
                        //    （多账号共存的前提，2026-10-13 改造）。
                        credentialRef: refName,
                    });
                    // ⚠️ **宿主侧直接拉起无痕窗口**（2026-10-13，用户要求）：
                    //    华为 authui 会静默复用浏览器已有会话 ⇒ 带 cookie 打开授权页
                    //    看不到登录框 ⇒ 「新建账号」永远只能建出同一个号。无痕窗口是
                    //    全新 cookie jar，天然无会话，且**不碰用户日常浏览器里的
                    //    华为云控制台会话**（对比 `authui/logout`：它的作用域是整个
                    //    域，会连带登出控制台）。实测依据见 `login.ts` 的
                    //    `openIncognitoWindow` 注释。
                    //
                    // ⚠️ 客户端**无法**自己做这件事：`window.open` 不能请求无痕模式
                    //    （那是进程级启动参数），故必须由宿主 `spawn` 浏览器可执行文件。
                    //
                    // ⚠️ 打开失败（读不到默认浏览器 / spawn 失败）时返回 `false`，
                    //    客户端据此回退到自己的 `window.open` —— 保持原行为不变，
                    //    不让「换个打开方式」变成「开不了窗口」。
                    const incognitoOpened = openIncognitoWindow(started.authorizeUrl);
                    return {
                        ok: true,
                        value: { accountId: id, loginUrl: started.authorizeUrl, incognitoOpened },
                    };
                }
                else if (provider === ACCIO.id) {
                    /**
                     * Accio（阿里）走**浏览器回调式 OAuth 2.0 + PKCE**（本地
                     * `createServer` 监听 `127.0.0.1` 的 `/api/oauth/callback`）。
                     *
                     * ⚠️ 与 codearts / lobsterai / gemini 同型：**必须先返回 URL 再等结果**
                     * —— `window.open` 只在用户手势窗口内有效，等授权完成才返回 URL 会让
                     * 弹窗被拦截（AGENTS.md 记过 CodeArts 的同类缺陷）。
                     *
                     * ## ⚠️⚠️ 本分支**刻意不调 `pool.addAccount`**（与其余十家**相反**）
                     *
                     * 既有模式是「RPC 登记占位条目、`auth.startLogin` 不碰池」（本文件
                     * 十余处；gemini 的 `startLogin()` 甚至不接收 `pool`）。而
                     * `AccioAuth.startLogin` **自己**登记占位条目（见
                     * `accio-auth.ts` 的 `startLoginFlow`：它要保证「返回 loginUrl 时占位
                     * 条目已就位」，否则前端 `login.poll` 会先看到一个不存在的账号）。
                     *
                     * ⇒ 这里再 `addAccount` 就是**同 id 的两次写入**：会被
                     * `writeAccounts` 的 dedup 兜住并打一条 warn —— 功能上无害，但那条
                     * 日志会**误导排查**（看起来像「RPC 与 auth 都登记了，谁才是对的」）。
                     * 故本分支必须把 `pool` / `accountId` **透传给 `startLogin`**，
                     * 由它登记；失败时也由它 `removePlaceholder` 清掉。
                     *
                     * ⚠️ `region` 必须过白名单（`normalizeAccioRegion`）：它来自**客户端
                     * 自报**的 RPC 载荷（无 schema 校验），且决定登录域名与凭据里的
                     * `region` —— 未登记值回落 `'cn'` 并留痕（与 zcode 的
                     * `normalizeZcodeLoginProvider` 同因，issue IKJLK3 E2）。
                     */
                    let accioStarted;
                    try {
                        accioStarted = await accio.startLogin({
                            refName,
                            region: normalizeAccioRegion(req.accioRegion),
                            pool,
                            accountId: id,
                        });
                    }
                    catch (error) {
                        // ⚠️ 占位条目由 `startLogin` 自己清理（`fail()` 里的
                        //    `removePlaceholder`），这里**不得**再 removeAccount ——
                        //    那是同 id 的第二次写入，且会与它自己的清理竞争。
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new Error(`无法启动 Accio 登录（本地回调服务启动失败）：${reason}`);
                    }
                    // ⚠️ **不接收 result 的解析值**：`AccioAuth` 的 `result` 是
                    // `Promise<void>` —— 凭据落盘、账号池回填、昵称与有效期全部在
                    // `finishLogin` 里做完（与其余家「RPC 回填」的分工相反）。
                    // 这里只挂日志与失败清理。
                    accioStarted.result.catch((error) => {
                        ctx.logger.warn(`[jet-hub] background ${ACCIO.id} login failed for ${id}: ${String(error)}`);
                    });
                    return { ok: true, value: { accountId: id, loginUrl: accioStarted.loginUrl } };
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
                    // 按 **entry.provider** 查 `auths` 命名对象分派，并调用**按凭据 ref 的**
                    // 续期入口 —— 三处都是修复既有缺陷的关键：
                    //
                    // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
                    //    `Unknown provider` —— 即 `account.refresh` 端点**对 WorkBuddy 完全不可用**；
                    // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
                    //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而要刷的是池内条目的
                    //    BUDDY_ACCOUNT_XXX —— 于是「刷这个账号」实际刷的是另一个凭据，
                    //    结果要么报错要么静默改了错的对象。
                    // 3. ⚠️ **分派必须传 `pool` + `entry.id`**（issue !IKIRTT）：
                    //    续期成功后要把新的 `expiresAt` 写回账号池，UI 才不再显示
                    //    「已过期」。早先只有 raccoon 分支传了，其余七个分支漏传，
                    //    凭据续好了、界面纹丝不动，用户没有任何自救手段。
                    //
                    // ⚠⚠ **本端点没有面板入口**（issue IKJOZA 取证）：账号卡片上并没有
                    // 「刷新」按钮（按钮是 测试/重测/重置/停用/代理/指纹/删除），
                    // 调用方是仓库外的脚本/手工 RPC。下面三处历史注释曾把它写成
                    // 「账号卡片的刷新按钮」——那是失实的，会把排障的人引到不存在的 UI。
                    //
                    // ⚠️ 2026-10-08 改（Task 2）：原先这里是一个 13 个 case 的 switch，
                    // 而**每个分支体都是同一行调用**（`auth.refreshAccountCredential(
                    // entry.credentialRef, pool, entry.id)`），只有实例名不同 —— 纯粹重复，
                    // 且历史上漏接过 `workbuddy`（它对 `account.refresh` 一直报
                    // `Unknown provider`）。分支越多，漏接概率越高。
                    //
                    // ⚠️ **查 `auths` 形参，不查全局注册表**（`provider-runtime.ts`）：
                    //    `auths` 是 Task 9 引入的命名对象，其**键就是 provider id**
                    //    （含 `qodercn`，注意不是变量名 `qoderCn`）。用形参而非全局 Map
                    //    的三个好处：① 测试仍可**直接传桩**控制分派（零全局可变状态）；
                    //    ② 不会与「真跑 apply()」的测试互相污染；③ 闭包捕获的是**本次注册
                    //    的那批实例**，语义上更紧。全局注册表留给**真正跨模块**的消费点
                    //    （Task 5 的 aggregate-expiry、Task 8 的 account-probe）。
                    const auth = authOf(auths, entry.provider);
                    if (auth === undefined) {
                        // ⚠️ 文案必须保持**可读且指明原因**，不要退化成泛化的 unsupported：
                        //    opencode 是「该产品没有续期概念」（凭据是静态 API key），
                        //    而未知 id 是「没注册」。两者都要让排查者看懂。
                        throw new Error(descriptorOf(entry.provider) === undefined
                            ? `Unknown provider: ${entry.provider}`
                            : `Provider ${entry.provider} 不支持续期（它的凭据不是可续期类型）`);
                    }
                    await auth.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                    return { ok: true, value: { success: true } };
                }
                catch (error) {
                    /**
                     * ⚠⚠ **失败必须回 `ok: false`**，不得包成 `ok:true + value.success:false`
                     * （Gitee issue IKJOZA，真实缺陷）。
                     *
                     * ## 原来的行为与代价
                     * 本分支的 catch 曾把异常包进**成功**响应
                     * （`{ok:true, value:{success:false, error}}`）。而客户端的
                     * `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`
                     * 就返回 `value` —— 于是**只判 `ok` 的调用方会把续期失败读成成功**。
                     * 实测代价：报告方一个工具首版只判 `ok`，18 个「✅」里 **17 个实为失败**，
                     * 真实原因是 `codearts 400 STS5.1806 invalid refresh token:
                     * 'the refresh token has been used'` / `minimax refresh_token 已失效` /
                     * `raccoon 登录态已过期`。
                     *
                     * ## 为什么这里不能学那四处「catch 仍回 ok:true」
                     * 本文件确有四处 catch 后仍 `ok:true`，它们**都有额外的判别字段**，
                     * 调用方不判它就会误读，本端点没有 —— 逐条对照：
                     *
                     * | 位置 | 形态 | 为何安全 |
                     * |---|---|---|
                     * | `login.poll` | `{done:false}` | 「用户尚未授权完」是正常中间态 |
                     * | `login.submitSms` | `{done:false, error}` | 验证码输错可重试，前端必判 `done` |
                     * | `credits.permanentLock` | 广播失败仍 `ok:true` | 广播失败不影响已落盘 |
                     * | `credits.claimAll` | 单号失败进 `results[]` | 「单个失败不中断整体」是设计语义 |
                     *
                     * 本分支只有 `success` 一个布尔：**失败是业务终态，不是可自愈的中间态**，
                     * 与上述四者不同类。
                     *
                     * ## 为什么 `ok:false` 不会打破仓库内任何调用方
                     * `account.refresh` **全仓库零调用方**：面板 `plugin-src/client/jet-hub.js`
                     * 的 42 处 `rpcCall(` 里没有它（账号卡片的按钮是 测试/重测/重置/停用/代理/
                     * 指纹/删除，**没有「刷新」**）；另两处 `rpcCall(变量)` 的实参经追溯只有
                     * `opencode.*` 四个方法。它从来就是给仓库外脚本/手工 RPC 用的端点。
                     * ⇒ 这是**对外部调用方的破坏性契约变更**：原先误判的调用方会从「静默错」
                     * 变成 `unwrapRpcResult` 抛错，属预期的「提前炸」。成功路径仍是
                     * `ok:true + value.success:true`，未变。
                     *
                     * ⚠⚠ **复现这条取证不要用 `git log -S "rpcCall('account.refresh'"`**：
                     * 本注释自身引用了该字面量，`-S` 会**自匹配修复提交本身**（返回 `68fb567`），
                     * 那正是 `AGENTS.md` 明令禁止的「注释与实测脱节」。在 `origin/master`
                     * （修复前）上该命令零命中，这本身是它曾有效的证据。稳定写法是只搜
                     * **不含注释**的客户端源码：
                     * `Select-String -Path plugin-src\client\*.js -Pattern "rpcCall\('account\."`
                     * （应零命中；`account.refreshable` 是另一个字段名，不是端点）。
                     *
                     * 回归用例在 `tests/unit/lobsterai-rpc-dispatch.spec.ts` 的
                     * 「issue IKJOZA」段（锁死「失败不得是 ok:true」+「失败必须带原因」）。
                     */
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
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
                if (!resolved) {
                    /**
                     * OfficeAce 的占位条目走**凭据缺失即未完成**：这里代为轮询云侧 code。
                     * 用户授权完成后云侧立即返回 `code` → 换 token → 凭据落盘 → `done`。
                     *
                     * ⚠️ `code` 是**秒级时效** —— 轮询到必须**立刻** `completeLogin`
                     *（内部一次性完成 token 交换 + modelInfo + 落盘），不能延后。
                     */
                    if (entry.provider === OFFICEACE.id) {
                        const pending = pendingOfficeAceState.get(req.accountId);
                        if (pending !== undefined) {
                            const code = await auths.officeace.pollLoginCode(pending.state).catch(() => undefined);
                            if (code !== undefined) {
                                try {
                                    const credential = await auths.officeace.completeLogin(code, pending.codeVerifier, pending.dpopPrivateJwk);
                                    // ⚠️ **落库走 DSH 凭据库（标准范式）**：与 gemini / raccoon /
                                    //    minimax 的 `persistLogin(credential, { refName })` 同款 ——
                                    //    凭据按 `credentialRef` 索引 ⇒ 每个账号一份，互不覆盖。
                                    //    这是号池多账号能成立的根（自己写 session.json 的版本
                                    //    必然串号，2026-10-13 改造）。
                                    const persisted = await auths.officeace.persistLogin(credential, {
                                        refName: pending.credentialRef ?? entry.credentialRef,
                                        credentials: ctx.credentials,
                                    });
                                    pendingOfficeAceState.delete(req.accountId);
                                    const accountId = persisted.accountId ?? credential.accountId ?? '';
                                    await pool.updateAccount(req.accountId, {
                                        nickname: accountId.length > 0
                                            ? `OfficeAce ${accountId.slice(0, 8)}`
                                            : req.accountId,
                                        refreshable: true,
                                        // ⚠️ **必须回填 expiresAt**（与 gemini / zcode 同款）：漏写时
                                        //    卡片「有效期」永远显示「未知」（真实症状 2026-10-13，
                                        //    用户重登成功后面板仍显示未知）。STS 寿命 2 小时，
                                        //    `credential.expiresAt` 是 ISO 字符串。
                                        expiresAt: new Date(credential.expiresAt).getTime(),
                                    });
                                    return { ok: true, value: { done: true, success: true } };
                                }
                                catch (error) {
                                    // code 过期 / 交换失败：授权 code 一次性，保留 state 继续轮询没有意义
                                    //（云侧不会再给新 code）—— 清中间态，用户需重新发起登录。
                                    pendingOfficeAceState.delete(req.accountId);
                                    const reason = error instanceof Error ? error.message : String(error);
                                    return { ok: true, value: { done: false, error: `登录交换失败：${reason}，请重新点击「+ 新建账号」` } };
                                }
                            }
                            // 未就绪（用户还没完成授权）：继续轮询
                            return { ok: true, value: { done: false } };
                        }
                    }
                    return { ok: true, value: { done: false } };
                }
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
             *
             * ⚠️ **2026-10-08 改（Task 4）：两段 `if (req.provider === X.id)` 收敛成查表**
             *   —— 分支体里**没有一行协议逻辑**（协议早已封装在 `loomy-onboarding.ts` 与
             *   `raccoon-credits.ts` 内）。表在 `src/provider-onboarding.ts`，
             *   各家实现逐字搬迁、**一行未改**（含 raccoon 那条「映射成 Loomy 那套任务
             *   形状的一项」的语义）。
             *
             * ⚠️ 判据从「provider 属于 {loomy, raccoon}」改为「**该家是否提供
             *   `onboarding.status`**」：那张手抄的 `!== LOOMY.id && !== RACCOON.id`
             *   与能力表是**两份可漂移的东西**（新增一家要同时改两处，漏一处就静默
             *   失效）。表由 `auths` 现造，与 `credits.*` 同法。
             */
            case 'onboarding.status': {
                const req = payload;
                const impl = onboardingOf(onboarding, req.provider);
                // ⚠️ 未登记 / 无该能力的 provider 回**可读的** bad-request（兜底契约）。
                if (impl?.status === undefined) {
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
                // ⚠️ 凭据解析在**守卫之后**、在 try 之外，与旧实现逐字一致：
                //    这里只有**一个**账号（不是批量循环），故失败应如实冒泡成端点错误，
                //    不该被吞成某个账号的 failed。
                const credential = JSON.parse(resolved.value);
                const value = await impl.status(credential, callContext);
                return { ok: true, value: value };
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
                 * ⚠️ **按到期时间分桶的 provider 必须回传当前生效的窗口天数**：窗口可被
                 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端文案若继续写死 15 就会
                 * 与真实判据不一致（用户看到「只烧 15 天内的」而实际按 31 天筛号）。
                 *
                 * ⚠️ 判据是「**是否按到期时间分桶**」，不是「是不是 buddy」：TRAE 与
                 * LobsterAI 走同一套 `splitBuddyCreditsByExpiry`，同样受该窗口影响
                 * （它们的余额面板早已用同一个窗口分「长期 / 临时」，见 `credits.balances`
                 * 分支的注释），故必须一并回传。
                 *
                 * Loomy 没有窗口概念（服务端直接给两个命名池）→ 不带该字段。
                 */
                // ⚠️ 2026-10-08 改：判据从四连 `||` 改为查 registry 的 `usesExpiryWindow`
                //   —— 判据**本身不变**（仍是「是否按到期时间分桶」，**不是**「是不是 buddy」：
                //   TRAE 与 LobsterAI 走同一套 `splitBuddyCreditsByExpiry`，同样受
                //   `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响）。改的只是**取值来源**。
                //   ⚠️ loomy 刻意不在此列：它没有窗口概念（服务端直接给两个命名池）。
                const usesExpiryWindow = descriptorOf(provider)?.usesExpiryWindow === true;
                const lockResponse = () => ({
                    provider,
                    locked: pool.permanentLocked(provider),
                    ...(usesExpiryWindow ? { windowDays: buddyExpiringWindowDays() } : {}),
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
                // ⚠️ 走**唯一**的广播实现（`src/catalog-broadcast.ts`）：它自带
                // 「失败只记日志、不反噬已落盘的开关」与两级可选链 logger（审计指出
                // 此处曾是内联实现，`ctx.logger.warn` 在 logger 缺席时会抛、仅被 catch 吞）。
                broadcastCatalogChanged(ctx);
                return { ok: true, value: lockResponse() };
            }
            /**
             * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
             *
             * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
             *（每日签到）语义完全不同，故独立端点。
             *
             * ⚠️ **2026-10-08 改（Task 4）：两段 `if (req.provider === X.id)` 收敛成查表**
             *   —— 与 `onboarding.status` 同法（见那里的注释）。表在
             *   `src/provider-onboarding.ts`，含 raccoon 那条
             *   「**已领时 `earned` 报满分、不是 0**」的实测语义（真实报障：
             *   UI 显示「✅ 1 个此前已完成 / 累计已领 0 / 3000」自相矛盾）。
             */
            case 'onboarding.claim': {
                const req = payload;
                const impl = onboardingOf(onboarding, req.provider);
                if (impl?.claim === undefined) {
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
                const credential = JSON.parse(resolved.value);
                let value;
                try {
                    value = await impl.claim(credential, callContext);
                }
                catch (error) {
                    // ⚠️ 实现侧用**上抛**表达「领取失败」（而不是返回一条
                    //    「成功但没领到」的响应）—— 这里翻译成既有的可读 bad-request
                    //    （`code: 'bad-request'` + 服务端原文）。
                    //
                    // ⚠️ **2026-10-08 更正（Task 4 复审 Finding 2）：本注释原先写「与旧实现
                    //    逐字一致」，那是错的** —— 逐字一致只对 **raccoon** 成立（它的旧分支
                    //    自己 catch 了 `outcome.kind === 'failed'` 并回 `bad-request`）；
                    //    **loomy 的旧分支没有 try/catch**，`claimOnboardingTasks` 一抛错就
                    //    冒到外层处理器，变成 `jet-hub/handler-failed`（「未知故障」，
                    //    用户看不出是领取失败）。
                    //
                    // ⇒ 现在两家**统一** `bad-request`，即 loomy 的**错误码变了**
                    //    （`jet-hub/handler-failed` → `bad-request`），这是一处 **G3 例外**
                    //    （见 Task 4 报告 §5 的 G3-4），**方向是改善**：失败原因不再被
                    //    降级成「未知故障」。用户可见影响为零 —— 客户端只渲染
                    //    `error.message`，而 message 逐字未变（仍是服务端原文）。
                    //    ⚠️ 故**不要**为了「零行为变更」把 loomy 改回上抛。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
                return { ok: true, value: value };
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
            // ── 限流标记：测试（**无条件**发一次真实请求）──
            //
            // ⚠️ 与 `account.retest` 的区别是**触发条件**，不是措辞：
            // `retestAccount` 只测那些已经有 `modelRateLimits` 标记的模型，没有标记时
            // 在 `modelIds.length === 0` 处提前返回、一次请求都不发。于是「这个账号
            // 到底还能不能用」在**没有历史 429** 时没有手动探活入口 —— 用户点「重测」
            // 看到瞬间返回，会以为按钮失灵（真实报障：「重测按钮你确认过会发请求吗，
            // 为什么响应这么快？」）。`account.test` 补齐的就是这个缺口。
            //
            // ⚠️ 它**不写任何存储**：不清标记、不写回新的重置时刻。测出「仍受限」只
            // 如实回报给用户看，不落盘 —— 落盘会把「一次手动探活」变成「改变选号
            // 状态」，那是重测的语义。
            case 'account.test': {
                const req = payload;
                const accountId = req.accountId;
                if (typeof accountId !== 'string' || accountId === '') {
                    return { ok: false, error: { code: 'bad-request', message: '缺少 accountId' } };
                }
                const entry = pool.findAccount(accountId);
                if (entry === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `账号 ${accountId} 不存在` } };
                }
                // 模型推断：显式指定 > 已有的限流标记（用户最可能想看的就是它）> 全量目录第一个。
                // ⚠️ 只有前两者都拿不到时才去读目录 —— 若无条件先读它，一个「明明有标记可测」
                // 的账号会因为目录服务暂时不可用而被拒，属于自造的失败。
                //
                // ⚠️⚠️ **本调用点对目录是「尽力而为」，与两个关闭方向刻意不同**：
                // 它只要**一个** id 就能测，故远端读失败时**不拒绝**，用拿到的（适配器兜底表
                // 或空）照常继续。⚠️ 这与 `model.setAllDisabled` 的「必须完整 ⇒ 拒绝」是
                // **两种不同的完整度要求**，不是同一条判据的两个写法（实测：若这里也拒绝，
                // 「适配器有目录 + llm 临时故障」会从「能测」退化成 bad-request）。
                //
                // 目录也读不出来时如实报错，**不**猜一个模型名发出去（猜错会得到与账号
                // 无关的 404，把「账号不可用」和「模型名不对」两件事混成一条报错）。
                let modelId = pickTestModel(entry, [], req.modelId);
                if (modelId === '') {
                    const catalog = await fullCatalogIds(ctx, modelAdapters, entry.provider);
                    modelId = pickTestModel(entry, catalog.ids, req.modelId);
                    // ⚠️ 一个 id 都挑不出来**且远端也读失败**时才报「无法确定」并带上原因；
                    // 远端成功但目录为空 ⇒ 落到下面那句「没有可测试的模型」（两件事不同：
                    // 前者是「读不到」，后者是「读到了但里面没有模型」）。
                    if (modelId === '' && catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: { code: 'bad-request', message: `无法确定要测试的模型：${catalog.remoteError}` },
                        };
                    }
                }
                if (modelId === '') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `${entry.provider} 没有可测试的模型` },
                    };
                }
                const value = await testAccount(pool, accountId, modelId);
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
            // ⚠️ **2026-10-08 改（Task 3）：7 段分支收敛成「有则真查、无则如实 null」**。
            //    原先 5 段（codearts / lobsterai / trae / cline / loomy）是**逐字同构**的
            //    「手工拼 `{accountId, nickname, status: null}`」，另 2 段（minimax /
            //    buddy 系）真查。现在判据统一为「该渠道有没有注册 `fetchStatus`」：
            //    - 未注册 ⇒ 共享分支如实回 null（与它们原先的行为**逐字等价**）；
            //    - 已注册 ⇒ 走 `collectCreditsStatus` 真查。
            //
            //    ⚠️ 那 5 家**不注册** `fetchStatus` 是**诚实**的，不是偷懒：它们确实
            //    没有与 `CheckinStatus` 同构的状态端点 —— 要么根本没有签到端点
            //    （cline），要么要走两步且字段语义不同（codearts / lobsterai），
            //    要么由 claim 流程自带幂等判据（trae / loomy）。臆造一份
            //    `{streakDays: 0, dailyCredit: 0}` 会让面板显示「连续 0 天」这种
            //    **看起来像真实读数**的假数据。
            //
            //    ⚠️ 与「不支持」的区别：本端点**支持**（返回 200 + 账号列表），
            //    只是状态本身未知。故**不是**错误（与 claimAll 的守卫不同）。
            //
            //    ⚠️⚠️ **本改造对 5 家是行为变更（如实登记，别当成等价重构）**：
            //    `qoder` / `qodercn` / `raccoon` / `zcode` / `gemini` 原先落到
            //    `productById()` 的兜底、回 `bad-request: unsupported provider`，
            //    现在回 `ok: true` + `status: null`。这是**放宽**（把「端点不支持」
            //    改成「端点支持但状态未知」），与上面那条语义一致，且**无回归风险**：
            //    - 客户端**零调用**本端点（`plugin-src/client/` 里搜不到
            //      `credits.status`），自动签到走的是 `credits.claimAll`；
            //    - 它的实际消费者是外部脚本 / 直接 RPC 调用（见
            //      `docs/implementation-notes.md`）。
            //    判据由 `credits-runtime-parity.spec.ts` 的
            //    「credits.status 对 registry 里的每个渠道都被接受」锁死；
            //    **未知** provider 仍回 bad-request（兜底契约不变）。
            case 'credits.status': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                const statusImpl = creditsOf(credits, req.provider);
                if (statusImpl?.fetchStatus === undefined) {
                    // ⚠️ 未知 provider 与「已登记但无状态端点」必须**分开**：
                    //    前者是 bad-request（兜底契约），后者是「如实 null」。
                    //    registry 是权威判据（不是另立一份 provider 名单 —— 两份必然漂移）。
                    if (descriptorOf(req.provider) === undefined) {
                        return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                    }
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({
                                accountId: entry.id,
                                nickname: entry.nickname,
                                status: null,
                            })),
                        },
                    };
                }
                // ⚠️ `collectCreditsStatus` 逐账号 try/catch —— 单账号失败**不中断整体**，
                //    这与「顺序查询避免并发风控」同属该骨架已验证的语义，**不要重写**。
                //
                // ⚠️ 第二参（product）统一传 `undefined`：它**只被透传给 `fetchStatus`**，
                //    而 `fetchStatus` 现在由 credits 表提供、自带各自的 product 配置，
                //    不再需要调用侧转发（原先 buddy 系传 `productById()`、minimax 传
                //    `undefined`，是历史形态）。
                const value = await collectCreditsStatus(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    fetchStatus: (credential) => statusImpl.fetchStatus(credential, callContext),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: { accounts: value } };
            }
            // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
            //
            // ⚠️ **2026-10-08 改（Task 4）：14 段 `if (req.provider === X.id)` 收敛成查表**
            //   —— 那些分支体里**没有一行协议逻辑**（协议早已封装在各家
            //   `claimXxxDailyCheckin` 内），RPC 层看到的只是「选哪个函数」。
            //   表在 `src/provider-credits.ts`，各家实现逐字搬迁、**一行未改**。
            //   ⚠️ 编排仍留在共享骨架 `collectClaimResults` 里，**一行不重写**
            //   （「顺序执行避免并发风控」「单账号失败不中断」「凭据解析在 try 之内」
            //    都是实测结论）。
            //
            // ⚠️ **表从 `auths` 现造，不查全局注册表**（与 `credits.balances` 同法，
            //   理由见 `registerJetHubRpc` 的注释与设计复审 C1）：本函数持有本次注册的
            //   auth 实例，查全局表会让测试无法注入桩、并重开「位置/时序错位」那扇门。
            case 'credits.claimAll': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                // ⚠⚠ **领取前也要按需自愈**（issue IKKHL5，与 `credits.balances` 同一层）。
                //
                // 用户报障的场景里，「积分行报 HTTP 401」旁边**就挂着「一键领取积分」
                // 按钮** —— 睡眠/挂起恢复后点它，撞的是**同一个** 401：凭据已过期，
                // 而领取流程同样只 resolve 凭据后直连上游、全程不续期。
                // 若只修余额查询，「用户点刷新能看到余额了、点领取却还是 401」，
                // 症状会变得自相矛盾、更难排查。
                //
                // ⚠️ 放在**端点入口**（与余额端点同因）：本 case 下有十几家 provider
                // 分支（qoder/codearts/lobsterai/trae/cline/workbuddy/raccoon/minimax/
                // zcode/gemini/buddy 系…），逐分支加必漏。
                // ⚠️ 顺序执行、失败不上抛，见 {@link healExpiredAccounts}。
                await healExpiredAccounts(accounts);
                // ⚠️ **ZCode 是唯一保留的特例**（与余额侧的 opencode / qoder 同族理由）：
                //    它的「一键领取」= 补激活上报 → preview → **逐个 plan** claim，
                //    且**每个 plan 都要重新产一个 captcha**（captcha 一次性，复用会得
                //    `3007`，这条路径每个 plan 都现产新的）—— 故**不能**复用
                //    `collectClaimResults` 那套「一个凭据一次 claim」的形状（它假设
                //    `claim()` 内部自己处理幂等），这里自己遍历账号与 plan。
                //
                //    ⚠️ ZCode **没有**独立的「今日是否已领」端点，故不走 `precheckStatus`
                //    （`claimDailyWith` **自带**激活上报与 preview 查询，重复调用只会多发
                //    一次无谓请求）。
                // ⚠️ **Qoder 同族也是保留的特例**（与 `credits.balances` 同因）：
                //    `claimQoderDailyCheckin` 只吃 `QoderCredential` + `QoderProduct`，
                //    形态与「表里的实现自带 product 配置」不匹配。它的领取流程**自带活动
                //    列表查询**（`loadCampaigns` → 逐个 claim），故 `precheckStatus: false`
                //    跳过外部那次检查 —— 否则会重复发一次 GET（与 LobsterAI 传 false 同因）。
                //
                //    ⚠️ 幂等判据是响应体的 `replayed:true`（重复领取同样返回 HTTP 200），
                //       已在 `claimQoderDailyCheckin` 内部处理。
                //
                //    ⚠️ 这两家**刻意不在** credits 表里（`credits-runtime-parity.spec.ts` 的
                //       「表里的渠道集合」与 `provider-runtime-wiring.spec.ts` 的
                //       「形态不匹配的特例」两条守卫都要求它们缺席）—— 故这里保持特例分支，
                //       而不是把它们塞进表里再放宽那两条守卫。
                if (isQoderFamily(req.provider)) {
                    const { product } = requireQoderFamily(req.provider);
                    const value = await collectClaimResults(accounts, undefined, {
                        resolve: (ref) => ctx.credentials.resolve(ref),
                        claim: (credential) => claimQoderDailyCheckin(credential, product),
                        precheckStatus: false,
                        warn: (msg) => ctx.logger?.warn?.(msg),
                    });
                    return { ok: true, value: value };
                }
                if (req.provider === ZCODE.id) {
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
                                 *
                                 * ⚠⚠ **必须原样把 `config` 透传给 `mintCaptcha`**（真实缺陷，
                                 * Gitee issue IKJNPS）。region 与 param 必须是**同一份配置**签出来的：
                                 * 阿里云验签成对校验二者，不一致即 `400 / 3007`。此前这里**自己**去
                                 * 拉一份 captcha 配置（拿到的是服务端真实 region，如 `sgp`），
                                 * 而 `claimDailyFor` 的 region 走兜底常量 `cn` ⇒ 非 cn 区账号
                                 * 「一键领取」100% 失败（用户报障：15/15 全部 captcha 校验失败）。
                                 * 现在配置由 `claimDailyWith` 解析一次并传进来，两边天然同源。
                                 */
                                accountOutcomes = await zcode.claimDailyFor(credential, async (config) => {
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
                const impl = creditsOf(credits, req.provider);
                if (impl?.claim === undefined) {
                    // ⚠️ 措辞必须**指明是"该产品无此能力"**，不能退化成「provider 没注册」
                    // —— 后者会让排查者去查注册表，而真相是产品没有这个接口。
                    //
                    // ⚠️ 文案由**表**给（`claimUnavailableReason`），不在端点里拼模板：
                    //    三条文案是实测报障修来的、各自信息量不同（raccoon 那条含可操作
                    //    指引「登录奖励请在『新手任务』中领取」），压成一句泛化模板会丢掉它。
                    //    两个真实例子（各自的历史注释都记录了这一点）：
                    //      - cline：对整个 sidecar 做字符串扫描，无任何 checkin/campaign 端点；
                    //      - workbuddy：国际版内核里只有 get-dosage-notify，没有签到接口。
                    //    ⚠️ workbuddy 这条守卫**必须有**：没有它时会落到下面的通用分支，
                    //       用**国际版**凭据去发**国内版**的签到请求 —— 必然失败，而且是一次
                    //       真实的上游请求。而「每日首次启动自动签到」正是靠「调 claimAll、
                    //       按返回的信封判跳过」来决定遍历范围的，它**不维护第二份能力名单**。
                    //
                    // ⚠️ 表里**没有专属文案**的已登记渠道（gemini / opencode / aggregate）
                    //    仍回**旧的** `unsupported provider: X` —— 那是**刻意不动**的行为
                    //    （改成「不支持每日签到」是一处需批准的 G3 例外，见 Task 4 报告）。
                    //    未登记的 id 同样落进这里（兜底契约不变）。
                    if (impl?.claimUnavailableReason !== undefined) {
                        return {
                            ok: false,
                            error: { code: 'bad-request', message: impl.claimUnavailableReason },
                        };
                    }
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` },
                    };
                }
                // ⚠️ 第二参（product）统一传 `undefined`：它只被透传给骨架的 `claim` /
                //    `fetchStatus` 入参，而这两者现在由 credits 表提供、**自带各自的
                //    product 配置**，不再需要调用侧转发（原先 buddy 系传
                //    `productById()`、其余传 `undefined`，是历史形态）。
                //
                // ⚠️ `afterClaim`（成长中心）**必须留在这趟循环里**（见
                //    `CreditsEndpointDeps.afterClaim` 的长注释）：它与签到共用同一趟
                //    逐账号循环，凭据只解析一遍。漏掉它的症状**只是**「成长中心不工作了」，
                //    日志里没有错误。
                const value = await collectClaimResults(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    // ⚠️ 骨架的 `claim` 是 `(credential, product, entry)` —— 第三参才是
                    //    `entry`（TRAE 用它取签到设备代次）。产品配置由表里的实现闭包捕获，
                    //    故这里把 `product` 丢掉。
                    claim: (credential, _product, entry) => impl.claim(credential, entry, callContext),
                    // ⚠️ 由能力表驱动，不再散落 provider 字面量。
                    ...impl.precheckStatus === undefined ? {} : { precheckStatus: impl.precheckStatus },
                    // ⚠️ 预检优先用 `claimStatus`，缺席时回落到 `fetchStatus`
                    //（buddy / minimax 的预检与面板读数是同一个端点，只声明一次）。
                    ...(impl.claimStatus ?? impl.fetchStatus) === undefined
                        ? {}
                        : {
                            fetchStatus: (credential) => (impl.claimStatus ?? impl.fetchStatus)(credential, callContext),
                        },
                    // 成长中心任务：与签到**共用这一趟逐账号循环**（见 CreditsEndpointDeps
                    // .afterClaim），故凭据只解析一遍。
                    //
                    // ⚠️ `runTasks` 缺省为 false：这条路径同时是「每日首次启动自动签到」的
                    // 执行体（见上方 createAutoCheckin 的 claim 回调），而成长一轮单账号实测
                    // 90～270s、全串行、任务间 1.5s 节流。默认开启等于每次启动自动打几十个
                    // 上游请求。只有用户手点「一键领取积分」时才传 true。
                    //
                    // ⚠️ 门控是「**该家是否提供 `afterClaim`**」—— 原先的
                    //    `GROWTH_CAPABLE_PROVIDERS` 手抄集合已删除（Task 1b 同因：
                    //    消除平行副本，让「哪家有成长中心」由能力注册表说了算）。
                    ...req.runTasks !== true || impl.afterClaim === undefined
                        ? {}
                        : {
                            afterClaim: (credential, _product, entry, _outcome, roundDeadlineAt) => impl.afterClaim(credential, entry, { budgetMs: req.budgetMs, roundDeadlineAt }, callContext),
                        },
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: value };
            }
            // 积分余额（Credits Balance）：逐账号顺序查询。
            //
            // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
            // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
            // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
            //
            // ⚠️ **2026-10-08 改（Task 3）：11 段 `if (req.provider === X.id)` 收敛成查表**
            //   —— 那些分支体里**没有一行协议逻辑**（协议早已封装在各家
            //   `fetch*Balance` 内），RPC 层看到的只是「选哪个函数」。表在
            //   `src/provider-credits.ts`，各家实现逐字搬迁、**一行未改**。
            //   ⚠️ 编排仍留在共享骨架 `collectCreditBalances` 里，**一行不重写**
            //   （「顺序查询避免并发触发风控」「单账号失败不中断」都是实测结论）。
            case 'credits.balances': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                // ⚠⚠ **先按需自愈、再查余额**（Gitee issue IKKHL5 建议 C）。
                //
                // 缺陷：系统睡眠/挂起数小时后恢复，**宿主进程全程没退出** ⇒
                // `state.json` 的 `expiresAt`（上次续期时刻 + 令牌寿命）落在过去，
                // 卡片显示红色「已过期 · 自动续期」，而本端点 resolve 凭据后
                // **直连上游、全程不续期** ⇒ 积分行报「HTTP 401」。该窗口内没有任何
                // 手动自救手段（「重测」的 refresh 是刻意 no-op）。
                //
                // 为什么要放在**端点入口**而不是每个 provider 分支里：本端点上有
                // 「特例短路（opencode / qoder）+ 查表分派」两段，且查表那段对
                // **所有**落在表里的渠道共用一行调用 —— 在入口加**一处**就覆盖全部，
                // 逐分支加必然漏（仓库在 `workbuddy` 上漏过一次：`account.refresh`
                // 端点对它一直报 `Unknown provider`）。
                //
                // ⚠️ **顺序执行**且失败不上抛（见该函数）：积分查询是逐账号顺序
                // 查询（避免并发触发风控），这里保持同一形状。
                await healExpiredAccounts(accounts);
                // ⚠️ **两个形态与骨架不匹配的特例，先于查表短路**：
                //    - `opencode`：余额是**本地派生的通道可用性**（读账号池的
                //      `modelRateLimits`），**零网络请求**。套进
                //      `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求
                //      （实测 Zen 的 15 个候选余额路径全部 404）。
                //    - `qoder` 系：`fetchQoderCreditBalance` 只吃 `QoderCredential`，
                //      且 product 来自同族注册表，**不走** `collectCreditBalances` 的
                //      `(credential, product)` 泛型。
                // 保留特例而非强行套骨架：套上去会丢语义（设计文档 §3.5 的边界 ——
                // 抽象的是「选哪个函数」，不是「函数内部怎么做」）。
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
                // ── OfficeAce（华为 ModelArts MaaS）──
                //
                // ⚠️ **不套查表分派**：它的余额不是「拿凭据调上游」的形状，而是
                //    **云侧 V11 签名直读**（`GET /v1/subscription`）——凭据是 STS 三元组
                //    且签名逻辑在 `officeace-auth.ts` 内部，没有 `fetchBalance(credential)`
                //    这个可注入点。与 opencode / qoder 同属「形态与骨架不匹配」的特例。
                //
                // 返回的 `creditGroups` 含套餐桶（`skus[].quotas`）与活动桶
                //（`bonus_skus[]`），逐桶带 `expiresAt` —— 归一化到 `deductionEndTime`
                // 后由通用判据分成「永久 / 长期 / 临期」三档（`PERMANENT_LOCK_PROVIDERS` 同款）。
                //
                // ⚠️ **必须回传 `windowDays`**：客户端 `splitCreditsByExpiry` 的
                // `normalizeWindowDays` 对 `undefined` 返回 `null` ⇒ 整个分桶行静默不渲染
                //（真实症状：胶囊只有合计、没有「永久绿 / 长期黄 / 临期红」三行）。
                if (req.provider === OFFICEACE.id) {
                    // ⚠️ 用可选链取 auth：本端点的多条单测用**空桩 auths**（`{}`）遍历
                    //    registry，缺 `officeace` 键时直接取属性会抛 TypeError ⇒ 整个 case
                    //    冒泡成 `ok:false`（真实症状：`officeace 应被接受` 变红）。
                    //    取不到就如实回「查询失败」，与网络失败同一条降级路径。
                    const fetchSummary = auths.officeace?.fetchSubscriptionSummary;
                    // ⚠️ **逐账号查询，不共享一份结果**（2026-10-13）：
                    //    原实现只查一次就拿去填所有卡片 ⇒ N 个账号显示同一个余额，
                    //    面板合计被放大 N 倍（实测两个账号显示 13000 = 6500×2）。
                    //    每个账号按自己的 `credentialRef` 查自己那份订阅。
                    const values = [];
                    for (const account of accounts) {
                        const subscription = fetchSummary === undefined
                            ? undefined
                            : await fetchSummary.call(auths.officeace, 48, account.credentialRef, undefined, ctx.credentials).catch(() => undefined);
                        if (subscription === undefined) {
                            values.push({
                                accountId: account.id,
                                nickname: account.nickname,
                                balance: null,
                                error: '积分查询失败（华为云订阅接口不可达或凭据已失效）',
                            });
                            continue;
                        }
                        values.push({
                            accountId: account.id,
                            nickname: account.nickname,
                            balance: {
                                total: subscription.totalCredits,
                                packages: subscription.creditGroups.map((group) => ({
                                    name: group.name,
                                    unit: OFFICEACE.quotaUnit,
                                    remaining: group.remaining,
                                    total: group.total,
                                    used: group.used ?? 0,
                                    active: !group.expired,
                                    cycleStartTime: '',
                                    cycleEndTime: '',
                                    expiredTime: group.expiresAt ?? '',
                                    // 分桶判据字段：订阅套餐包无固定到期（永久桶），活动/签到包有明确到期。
                                    ...(group.expiresAt !== undefined && group.expiresAt !== null
                                        ? { deductionEndTime: new Date(group.expiresAt).getTime() }
                                        : {}),
                                })),
                                expiredTotal: subscription.creditGroups.filter((g) => g.expired).length,
                            },
                        });
                    }
                    return {
                        ok: true,
                        value: {
                            accounts: values,
                            // ⚠️ **成功/失败都要回传 `windowDays`**：该字段表达的是「本渠道
                            //    按到期时间分桶」（registry 的 `usesExpiryWindow`），与本次
                            //    读数成功与否**无关**。只在成功路径带它会让「空账号池 / 查询
                            //    失败」时形状不一致 —— 守卫用例遍历 registry 时正会红
                            //（实测症状：`officeace 必须回传 windowDays`）。
                            windowDays: buddyExpiringWindowDays(),
                        },
                    };
                }
                // ── 查表分派 ──
                // ⚠️ 表由 `registerJetHubEndpoints` 从 `auths` 现造（**不是**形参，
                //    见 `registerJetHubRpc` 的注释：第 5 个位置形参已在 2026-10-08
                //    设计复审 C1 中删除）。`src/index.ts` 另有一份**同源同构**的表挂在
                //    `ProviderRuntime.credits` 上，供 Task 5/8 的跨模块消费点读 ——
                //    两条接线的消费方不同，但用的是同一个工厂、同一批 auth 实例。
                const impl = creditsOf(credits, req.provider);
                if (impl === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                // ⚠️ 包一层适配：runtime 的签名是 `(credential, call)`，
                //    `collectCreditBalances` 的入参签名是 `(credential, product)`。
                const values = await collectCreditBalances(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    ...impl.fetchBalanceDetailed === undefined
                        ? {}
                        : {
                            fetchBalanceDetailed: (credential) => impl.fetchBalanceDetailed(credential, callContext),
                        },
                    ...impl.fetchBalance === undefined
                        ? {}
                        : { fetchBalance: (credential) => impl.fetchBalance(credential, callContext) },
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                // ⚠️ 只有**按到期时间分桶**的渠道才回传窗口天数（判据是 registry 的
                //    `usesExpiryWindow`，不是「是不是 buddy」）—— 前端文案若写死 15
                //    会与真实判据不一致（用户看到「只烧 15 天内的」而实际按 31 天筛号）。
                //    ⚠️ 改成字段驱动后**行为不变**：登记的正是原先那四段硬编码的
                //    buddy 系 + TRAE + LobsterAI（loomy 刻意不在内 —— 它由服务端直接
                //    给两个命名池，没有窗口概念）。
                const usesWindow = descriptorOf(req.provider)?.usesExpiryWindow === true;
                const value = usesWindow
                    ? { accounts: values, windowDays: buddyExpiringWindowDays() }
                    : { accounts: values };
                return { ok: true, value };
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
                // ⚠️⚠️ 「已失效模型」必须**显式列出且可恢复**（2026-10-06 复审 !66 实测）。
                //
                // 背景：`withDeadModelPruning` 会把已失效模型从 `listModels` / `listAllModels`
                // 两侧剔除，于是它既不在 `all` 里、也不在 `disabledMap` 里 —— 上面的两条
                // 补回路径都救不回它。结果是**模型从设置页彻底消失，连开关都摸不着**，
                // 用户永远无法自行恢复（这正是上文 `withDeadModelPruning` 处列为必须避免的根因：
                // 「用户再也无法重新打开」）。
                //
                // ⇒ 这里把 dead 表里的 id 补回目录，并带上 `dead: true` 让客户端灰显 +
                // 提供「重新显示」入口（`model.clearDead`）。**方向必须与黑名单相反**：
                // 失效模型**永远**列出（哪怕被用户关着），否则用户没有恢复路径。
                const dead = deadModelIdsFor(req.provider);
                if (dead.size > 0) {
                    const known = new Set(catalog.map((model) => model.id));
                    for (const id of dead) {
                        if (!known.has(id))
                            catalog.push({ id, name: id });
                    }
                }
                const value = {
                    models: catalog.map((model) => ({
                        id: model.id,
                        name: model.name,
                        disabled: disabledMap[model.id] === true,
                        // ⚠️ **照实透传**：缺失即 false，**不推导**（黑名单命中也算用户主动关的，
                        // 不是失效）。客户端据它灰显并显示「重新显示」按钮。
                        dead: dead.has(model.id),
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
                // ⚠️ 目录必须在写入**之前**读：关闭一个目录内的模型后，它会被
                // `listModels()` 过滤掉，写完再读就把它误判成「不在目录」。
                // ⚠️ 黑名单**不在这里取** —— `readableCatalogIds` 会在 `await` 之后
                //    自己读（理由见其注释：提前取会与写入时刻错开、导致误报「没有变更」）。
                const known = await readableCatalogIds(ctx, pool, modelAdapters, req.provider);
                await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true);
                ctx.logger.info(`[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`);
                // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
                broadcastCatalogChanged(ctx);
                const disabledModels = pool.listDisabledModels(req.provider);
                // ⚠️⚠️ **静默空操作必须留痕**（Issue IKJW33）：对已从上游目录消失的 id
                // 开关时，旧实现返回「成功」却什么都没发生、且零警告。写入语义不变，
                // 只在响应里补 warnings 说明真相（判据与取舍见 `catalogWarnings`）。
                const warnings = catalogWarnings(known, req.provider, [req.modelId], req.disabled === true);
                if (warnings.length > 0)
                    ctx.logger.warn(`[jet-hub] ${warnings.join(' ')}`);
                const value = {
                    provider: req.provider,
                    disabledModels,
                    ...warnings.length > 0 ? { warnings } : {},
                };
                return { ok: true, value };
            }
            /**
             * 把模型从「已失效」表里移除，让它重新出现在目录中。
             *
             * ## 为什么必须有这个端点（2026-10-06 复审 !66 确认）
             *
             * 失效记录的唯一自愈路径是 TTL 过期（默认 30 天）—— 因为模型被剔除后用户
             * **选不到**，不可能靠「再成功一次」触发清除。所以**误判一次 = 该模型被
             * 藏 30 天且用户毫无办法**，这与 Jet Hub 已有的模型开关完全不对等
             * （用户能一键关，却不能一键复活）。
             *
             * ⚠️ **不动黑名单**：`disabledModels` 是用户主动选择，失效表是系统推断，
             * 两者必须分开清除 —— 否则「重新显示」会顺带打开用户特意关着的模型。
             *
             * ⚠️ `modelId` **没有默认值**：传 `""`/非字符串一律拒绝（避免字段名写错
             * 导致「静默清空全表」）。省略该字段才是「清空该 provider 全部」。
             */
            case 'model.clearDead': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                if (req.modelId !== undefined && (typeof req.modelId !== 'string' || req.modelId.length === 0)) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'modelId 必须是非空字符串，或省略以恢复全部' },
                    };
                }
                const removed = clearDeadModels(req.provider, req.modelId);
                // 必须广播：与三个开关端点同约定，否则客户端目录（`llm/adapters-updated`
                // 三个触发源之一）不复位，用户点了「重新显示」界面却不动。
                broadcastCatalogChanged(ctx);
                ctx.logger.info(`[jet-hub] 恢复 ${removed} 个失效模型：${req.provider}`
                    + `${req.modelId === undefined ? '' : `/${req.modelId}`}`);
                const value = {
                    provider: req.provider,
                    deadModels: [...deadModelIdsFor(req.provider)],
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
                // 同单条端点：目录必须在写入**之前**读（关闭方向会让 `listModels()`
                // 过滤掉这些 id）；黑名单由 `readableCatalogIds` 在 `await` 之后自取。
                const known = await readableCatalogIds(ctx, pool, modelAdapters, req.provider);
                if (req.disabled)
                    await pool.setModelsDisabled(req.provider, ids);
                else
                    await pool.clearModelsDisabled(req.provider, ids);
                ctx.logger.info(`[jet-hub] ${req.disabled ? '关闭' : '打开'} ${req.provider} 的 ${ids.length} 个模型（按分组）`);
                // 与其它开关端点一致：必须广播，否则界面一直显示旧目录。
                broadcastCatalogChanged(ctx);
                const disabledModels = pool.listDisabledModels(req.provider);
                // 与单条端点同约定：目录外的 id 必须留痕（Issue IKJW33）。
                const warnings = catalogWarnings(known, req.provider, ids, req.disabled);
                if (warnings.length > 0)
                    ctx.logger.warn(`[jet-hub] ${warnings.join(' ')}`);
                const value = {
                    provider: req.provider,
                    disabledModels,
                    ...warnings.length > 0 ? { warnings } : {},
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
                    const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider);
                    // ⚠️⚠️ **判据顺序是语义的一部分**，四条分支按「能否在目录不完整时
                    // 安全作答」从强到弱排列（下面逐条给理由，别重排）：
                    //
                    // 1. **远端读失败**（超时/抛错/无 llm 服务）⇒ 拒绝且不落盘。
                    //    瞬态故障下拿兜底子集写黑名单正是 IKJW33 修的「显示已关闭而几百个
                    //    模型仍可选」—— 这个守卫**原样保留**。
                    if (catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `没有可关闭的模型：${catalog.remoteError}`,
                            },
                        };
                    }
                    // 2. **并集为空** ⇒ 适配器目录里都没有该 provider 的模型，真没东西可关。
                    //    文案与 `provider.setEnabled` 的同名分支**逐字同构**。
                    if (catalog.ids.length === 0) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    const disabledBefore = pool.listDisabledModels(req.provider);
                    const pending = catalog.ids.filter((id) => disabledBefore[id] !== true);
                    // 3. ⚠️⚠️ **幂等短路：并集里的 id 已全部在黑名单里 ⇒ 无事可做，直接成功**
                    //    —— 此时**不需要**完整目录也能安全作答（什么都不写，就不存在
                    //    「写出不完整黑名单」的风险）。
                    //
                    //    为什么必须有这条（真实缺陷，2026-08）：`complete` 的定义是「远端读到
                    //    且**非空**」，而「**全部模型都已关闭**」时 `listModels()` 会被黑名单
                    //    过滤成 `[]`（`createModelCatalog.listModels` 的
                    //    `listed = all.filter(entry => !disabled.has(entry.id))`）⇒
                    //    `complete === false`。于是用户在**已经全关**的状态下再点一次
                    //    「关闭全部」（或在模型列表里确认一下），会得到
                    //    「该供应商没有可关闭的模型」——而它明明有 N 个、只是都已关。
                    //    ⚠️ 该形态与「无账号门控」在 `fullCatalogIds` 里**完全同形**
                    //    （都是 `remoteIds === []` 且无 `remoteError`），**无法**靠目录侧区分，
                    //    故判据只能建在「黑名单已覆盖并集」这个**结果**上。
                    //    ⚠️ 前端联动路径会命中它：停用最后一个账号时问「是否同时关闭它的
                    //    全部模型」，若模型此前已全关，用户会看到误导告警
                    //    「账号已停用，但关闭模型失败：该供应商没有可关闭的模型」。
                    if (pending.length === 0) {
                        ctx.logger.info(`[jet-hub] ${req.provider} 的全部 ${catalog.ids.length} 个模型本就已关闭，无变更`);
                    }
                    else if (!catalog.complete) {
                        // 4. **有新增项但目录不完整** ⇒ 拒绝且不落盘。
                        //    ⚠️ 必须排在幂等短路**之后**：先判它会让第 3 条那个正常形态
                        //    被误拒（即上面记的那个真实缺陷）。而判据仍用 `complete`
                        //    （不是 `ids` 是否为空）—— 冷缓存下兜底表会让并集看起来非空，
                        //    而它只是**子集**，据此写黑名单正是本 issue 的原始缺陷。
                        //    ⚠️ 文案与 `provider.setEnabled` **逐字同构**：`remoteError` 有值
                        //    = 「**读不到**」（已在第 1 条拦下）；无值 = 「**没账号**」（去登录）。
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    else {
                        await pool.setModelsDisabled(req.provider, pending);
                        ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的 ${pending.length} 个模型`);
                    }
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
             * 异步凭据解析。这里**默认全程只用同步的内存副本**，不产生网络请求：
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
             *
             * ## ⚠️⚠️ `closed` 必须只走「安全方向」，故它在必要时**会去核实一次**
             *
             * `listAllModels()` 在**冷缓存**下返回各家**编译期兜底表**（子集），
             * 而 `closed = total > 0 && disabled === total` 是**基于那个子集**算的
             * ⇒ 子集可能**误报已关闭**（真实缺陷，独立审计实测）：
             *
             * ```
             * 兜底表 [hy3]（冷缓存） + 黑名单 { hy3: true }（旧版本「关闭全部」写下的）
             * ⇒ total=1, disabled=1 ⇒ closed:true
             * 而远端还有 glm-5.2 / deepseek-v4-flash 可选 ⇒ 界面显示「已关闭」却仍能选
             * ```
             *
             * ⚠️ 危险方向**只有 `closed: true` 这一个**：报 false 是安全的（用户可点开关，
             * 点了会得到明确错误）。故这里**只在子集判据说「已关闭」时才去核实**
             *（用 `fullCatalogIds` 取并集）：
             *
             * - 核实成功 ⇒ 用并集重算 `total` / `disabled` / `closed`；
             * - 核实不了（远端读失败 / 为空）⇒ **保守报未关闭**（安全方向），
             *   与「适配器缺失」同一取舍。
             *
             * ⚠️ 这样**常见路径零网络**：绝大多数供应商是「未关闭」，子集判据
             * 直接给 false、不触发核实（冷缓存下也不触发）。只有**真的可能已关闭**
             * 的供应商才付一次目录读取；缓存已热时那次读是纯内存的。
             * ⚠️ 代价：多个「已关闭」供应商会**串行**各读一次（每次上限
             * {@link CATALOG_READ_TIMEOUT_MS}）—— 首屏最多因此多花「已关闭家数 × 2 秒」
             * 的最坏值，而实际情况是缓存已热（用户会先看到列表才会去关）。
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
                    let total = catalog?.length ?? 0;
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
                    let closed = total > 0 && disabled === total;
                    // ⚠️⚠️ 只有「即将报已关闭」才核实（危险方向，见方法头）。
                    if (closed) {
                        const full = await fullCatalogIds(ctx, modelAdapters, provider);
                        // ⚠️⚠️ **判据是「远端读成功」，不是 `complete`**：`complete` 额外要求
                        // 远端**非空**，而这里恰好有一个**正常**的空形态 ——
                        // 「全部模型都已关闭」时 `listModels()` 被黑名单过滤成 `[]`
                        //（实测：这正是本端点要正确回答的那个状态！）。
                        // 若这里用 `complete`，一关全就永远核实不了、`closed` 恒为 false
                        // ⇒ 「关闭供应商」后界面永远显示未关闭（本修复第一版踩过，
                        // 两条既有用例当场变红）。
                        // ⚠️ 而「无账号门控」（真的看不到）时远端也是 `[]`，两者**同形**；
                        // 此时并集只剩适配器兜底表，`disabled` 会按它算 —— 因为
                        // `closed` 的判据是「子集里全部命中」，若兜底表全命中就仍报已关闭。
                        // 这是可接受的：兜底表全关 + 远端看不到 ⇒ 用户确实没有可选模型。
                        if (full.remoteError === undefined) {
                            total = full.ids.length;
                            disabled = full.ids.filter((id) => disabledMap[id] === true).length;
                            closed = total > 0 && disabled === total;
                        }
                        else {
                            // 核实不了（远端读失败）⇒ 保守报未关闭（安全方向）。
                            closed = false;
                        }
                    }
                    const entries = pool.listAccountsByProvider(provider);
                    // ⚠️ 目录健康快照是**可选诊断**（issue IKKZUG 第 5 点）：
                    // 只有目录来自多个外部来源的适配器实现它（目前只有 cline）。
                    // 三条纪律：① 钩子不存在 ⇒ 字段**缺席**（不是空对象，前端按
                    // 「无信息」渲染，不得当成「一切正常」）；② 钩子抛错 ⇒ 吞掉并
                    // 缺席（诊断不得反噬主流程）；③ **不发起任何 IO**（本端点全程只用
                    // 同步内存副本，见本方法的注释）。
                    let catalogHealth;
                    try {
                        catalogHealth = modelAdapters?.[provider]?.describeCatalogHealth?.();
                    }
                    catch {
                        catalogHealth = undefined;
                    }
                    statuses[provider] = {
                        models: { total, disabled },
                        accounts: {
                            total: entries.length,
                            // 与适配器一致的判据：`enabled !== false` 视为启用
                            //（老文档可能缺该字段，缺省语义等同启用）。
                            enabled: entries.filter((entry) => entry.enabled !== false).length,
                        },
                        closed,
                        ...catalogHealth === undefined ? {} : { catalog: catalogHealth },
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
             * 关闭方向必须拿到模型目录：**远端读失败**（`remoteError` 有值）时整个
             * 操作失败，既不落盘也不广播。绝不能「关不掉模型就只停账号」—— 那会让供应商
             * 显示成已关闭而模型其实还在，用户按关闭的预期却仍能选到它。
             * 「远端读到但为空」（无账号门控，`remoteError === undefined`）**不算
             * 读失败**：此时用并集目录照常关闭（见关闭分支内的注释 —— 否则无账号
             * 供应商永远关不掉，且与 `provider.status` 的核实判据不一致）。
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
                    // ⚠️⚠️ 判据是「远端读失败」（`remoteError`），**不是** `complete`。
                    //
                    // `complete === false` 覆盖两种形态，只有一种该拒绝：
                    // 1. **远端读失败**（超时/抛错/无 llm 服务，`remoteError` 有值）⇒ 拒绝且
                    //    不落盘。瞬态故障下拿兜底子集写黑名单，正是 IKJW33 修的
                    //    「显示已关闭而几百个模型仍可选」缺陷 —— 这个守卫**原样保留**。
                    // 2. **远端读到但为空**（`remoteError === undefined`；`createModelCatalog`
                    //    对「无已登录账号」的 provider 门控返回 `[]`）⇒ 用并集照常落盘。
                    //    这与 `provider.status` 核实路径的判据一致（它判的也是
                    //    `full.remoteError === undefined` 即「读成功」；其注释已明确：
                    //    「无账号门控」时远端同形为 `[]`，兜底表全关 + 远端看不到
                    //    ⇒ 用户确实没有可选模型，可接受）。
                    //    若这里仍按 `complete` 拒绝，无账号供应商将**永远无法关闭**
                    //    （远端目录按已登录账号门控，不登录永远读到 `[]`），且与
                    //    `provider.status` 在同一文件里形成两套同义判据 —— 本仓库的
                    //    既有处置就是收敛成一套。
                    if (catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `没有可关闭的模型：${catalog.remoteError}`,
                            },
                        };
                    }
                    // 远端读到（含为空）但并集为空 ⇒ 适配器目录里都没有该 provider 的
                    // 模型，真没东西可关，拒绝且不落盘。文案与 `model.setAllDisabled`
                    // 的「目录为空」形态逐字同构。
                    if (catalog.ids.length === 0) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    // ⚠️⚠️ 计数必须报「**本次真正改变的**条数」，不是「本次写入的条数」
                    //（真实缺陷，2026-08 审计实测）：
                    // `setModelsDisabled` 是**合并**语义（`perProvider[id] = true`），传入的
                    // 并集里可能有相当一部分**早就关着**了（历史遗留的完整黑名单、
                    // 或用户此前逐条关过）。此时「写入条数」会**少报**用户看到的实际结果 ——
                    // 实测：远端 4 条 / 适配器兜底表 2 条 / 黑名单已有另 2 条 ⇒ 并集 4 条、
                    // 其中 2 条已是 `true`，写完后 4 条全关，而返回 `models: 2`，
                    // 前端 `summarizeProviderToggle` 便播报「已关闭 2 个模型」。
                    // 与 `accounts` 的口径（只算实际变更数，见 `setAccountsEnabled` 的返回）
                    // 对齐后，提示才与用户观察到的结果一致。
                    const disabledBefore = pool.listDisabledModels(req.provider);
                    const pending = catalog.ids.filter((id) => disabledBefore[id] !== true);
                    await pool.setModelsDisabled(req.provider, catalog.ids);
                    modelCount = pending.length;
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
            // ── 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序）──
            case 'provider.getOrder': {
                // 与 provider.status 同级的轻量读取：池内进程内存副本，无任何 IO。
                const value = { order: pool.providerOrder() };
                return { ok: true, value };
            }
            case 'provider.setOrder': {
                const req = payload;
                if (!Array.isArray(req?.order) || req.order.some(id => typeof id !== 'string')) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'order 必须是字符串数组' },
                    };
                }
                // ⚠️ 与 account.reorder 不同：这里**不校验**「必须恰好等于当前供应商
                // 清单」——展示侧（provider-toggle.js 的 sortOpenProvidersByOrder）对
                // 数组中不认识 / 缺失的 id 都有稳定兜底，并发下列表过期也不需要让用户
                // 重试，接受最后一次拖拽的结果即可。
                await pool.setProviderOrder(req.order);
                ctx.logger.info(`[jet-hub] 已更新供应商自定义显示顺序（${req.order.length} 项）`);
                return { ok: true, value: undefined };
            }
            // ── 聚合 provider 的设置面板（`src/aggregate-adapter.ts`）──
            //
            // ⚠️ 接线复用 `modelAdapters` 形参，**不新增形参**：`registerJetHubRpc` 是
            //    位置传参，其形参列表有成文警告「历史上已因少传/插队错位复发 6 次」，
            //    而 `aggregate` **没有 auth 服务**（无账号/无凭据/无续期）⇒ 它不该占一个
            //    `XxxAuth` 形参位（那会逼 15 个调用点补 `undefined` 占位）。
            //    聚合适配器实例本来就在 `modelAdapters[AGGREGATE_PROVIDER]` 里。
            case 'aggregate.catalog': {
                const source = modelAdapters?.['aggregate'];
                if (source?.describeCatalog === undefined) {
                    return {
                        ok: false,
                        error: { code: 'unavailable', message: '聚合 provider 未注册或未提供目录' },
                    };
                }
                // ⚠️ 只读 + 零余额查询（规格 §8.3）：describeCatalog 内部不碰 expiryProbe。
                // ⚠️ `force`（可选，默认 false）：面板的「刷新」按钮传 true 以**绕过目录 TTL
                //    缓存**（真实缺陷，对抗审计实测证伪：不传 force 时「刷新」实际是「读 60 秒
                //    缓存」，用户在渠道侧改了模型后点刷新看不到变化）。
                //    只有显式刷新才绕缓存；其余调用方（含 `listModels`）继续走缓存。
                const force = payload?.force === true;
                const models = await source.describeCatalog(force, _signal);
                const value = { models };
                return { ok: true, value };
            }
            case 'aggregate.setRejected': {
                const req = payload;
                if (typeof req?.canonicalId !== 'string' || req.canonicalId.length === 0
                    || typeof req.provider !== 'string' || req.provider.length === 0
                    || typeof req.realId !== 'string' || req.realId.length === 0) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId / provider / realId 必填' },
                    };
                }
                await pool.setAggregateRejected(req.canonicalId, req.provider, req.realId, req.rejected === true);
                ctx.logger.info(`[jet-hub] 聚合：${req.rejected === true ? '拒绝' : '恢复'} `
                    + `${req.canonicalId} 的候选 ${req.provider}/${req.realId}`);
                // ⚠️ 清选型缓存：让改动**立刻**生效（虽然缓存键含拒绝表指纹、正确性不依赖
                //    它，但清掉可立即释放内存，并让语义更直白）。
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                const value = {
                    aggregateRejections: pool.listAggregateRejections(),
                };
                return { ok: true, value };
            }
            // ⚠️ **本端点当前没有客户端调用者**（对抗审计指出）—— 但**不要删**：
            //    规格 §8.4 明确要求它（「清空（支持按模型或按渠道清）」），是**先定的契约**。
            //    面板目前只提供「逐条开关」（`aggregate.setRejected`），批量清空留作后续
            //    UI（如「全部恢复」按钮）与排障用途。判据：**规格要求 ≠ 死代码**
            //   （与 `vendorOf` 那类零调用者的自造辅助函数不同）。
            case 'aggregate.clearRejected': {
                const req = payload;
                // ⚠️ 省略字段才是「清空该维度」；传了非字符串一律拒绝（避免字段名写错导致
                //    「静默清空全表」—— 与 `model.clearDead` 的 modelId 判据同款）。
                if ((req?.canonicalId !== undefined && typeof req.canonicalId !== 'string')
                    || (req?.provider !== undefined && typeof req.provider !== 'string')) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId / provider 必须是字符串或省略' },
                    };
                }
                await pool.clearAggregateRejected(req?.canonicalId, req?.provider);
                ctx.logger.info('[jet-hub] 聚合：已清空拒绝表（按传入的维度）');
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                const value = {
                    aggregateRejections: pool.listAggregateRejections(),
                };
                return { ok: true, value };
            }
            /**
             * 聚合 provider **上次实际转发成功的渠道**（P3，供用量徽标）。
             *
             * ⚠️⚠️ **必须是纯内存读、零网络零余额查询**（规格 §6.3 的 P2）：
             * 徽标在**门控阶段**就要拿到它 —— 重定向必须发生在
             * `supportsCreditBalance` 门控**之前**（那行是既有断言逐字钉住的，不得修改），
             * 而门控阶段是**同步渲染路径**，查网络会让外层渲染抖动（渠道变一次、
             * 徽标闪一次）。
             *
             * ⚠️ 语义是**真实历史**（已发生的转发），**不是预测** —— 不用
             * `pickCurrentAutoProvider`（预测语义 + 有网络成本）。
             *
             * ⚠️ 无历史 ⇒ `{ provider: null }` ⇒ 客户端**不渲染**徽标（规格 §6.3 的 P4）。
             */
            case 'aggregate.activeProvider': {
                const source = modelAdapters?.['aggregate'];
                // ⚠️ 未注册时回 `{ provider: null }` 而**不是**报错：徽标是**可选装饰**，
                //    为它报错会让会话输入区出现无意义的错误（本仓库对「非关键路径失败」
                //    的既有取向是安静降级，见 `usage-badge.js` 的目录解析注释）。
                const canonicalId = payload?.canonicalId;
                const provider = typeof canonicalId === 'string' && canonicalId.length > 0
                    ? (source?.activeProvider?.(canonicalId) ?? null)
                    : (source?.activeProvider?.() ?? null);
                const value = { provider };
                return { ok: true, value };
            }
            /**
             * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定）。
             *
             * ⚠️⚠️ **这是唯一会做余额探测的面板端点** —— `describeCatalog` 的契约是
             * **零余额查询**（规格 §8.3，有专门用例断言），而「按临期排序」必须探测
             * 才知道顺序。⇒ 分开：面板默认零探测，用户点按钮才走这里。
             *
             * ⚠️ 未注册时回**空表**而不是报错：面板据此保持字母序并提示，
             * 不影响其余功能（与 `aggregate.activeProvider` 的安静降级同取向）。
             */
            case 'aggregate.expiryOrder': {
                const source = modelAdapters?.['aggregate'];
                const order = source?.describeExpiryOrder === undefined
                    ? {}
                    : await source.describeExpiryOrder(_signal);
                const value = { order };
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
                        return collectGatewayCatalog(llm, providers, (provider, error) => {
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
                    : await collectGatewayCatalog(llm, providers, (provider, error) => {
                        ctx.logger.warn(`[jet-hub] ${provider} 模型目录读取失败，已从网关列表跳过：${String(error)}`);
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
            // 目的：更换 DSH 版本时迁移账号凭据，以及**单独**把某个账号搬到另一台
            // 机器。备份文件是**自包含**的 JSON（账号索引 + 凭据原文 + 模型黑名单，
            // 见 src/backup.ts），与 DSH 版本无关 —— 导入时按**当前版本**的存储契约
            // 重建，天然跨版本。
            //
            // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
            // 明文载荷；明文 JSON 不经过本层持久化与日志。
            case 'backup.export': {
                const req = (payload ?? {});
                // accountIds 只作用于 accounts / credentials 两个字段；黑名单与锁定表
                // 仍是全量，故产物始终是一份可整体还原的自包含快照。
                const accountIds = Array.isArray(req.accountIds)
                    ? req.accountIds.filter((id) => typeof id === 'string' && id.length > 0)
                    : undefined;
                const result = await exportBackup(pool, ctx.credentials, { accountIds });
                const value = {
                    payload: result.payload,
                    warnings: result.warnings,
                };
                return { ok: true, value };
            }
            // 导入有两种模式：
            // - `replace`（缺省）= 整体替换（还原快照，不是合并）；
            // - `merge` = 只追加，按 id 跳过已存在的账号，不碰黑名单与锁定表。
            // 写入顺序刻意「先凭据、后账号池」：账号池写入成功后，门控
            // （hasLoggedInAccount）与黑名单立即反映新状态；若凭据写入中途失败
            // （非法 ref 等），只跳过该条、不中断整体。
            //
            // ⚠️ 模式必须显式取白名单，不能把请求里的任意字符串透传下去：未知值
            // 会被 importBackup 的 `?? 'replace'` 静默当成整体替换 —— 那时用户以为
            // 只是「加一个账号」，实际账号池被清空，属于不可逆的数据损失。
            case 'backup.import': {
                const req = payload;
                const mode = req?.mode === 'merge' ? 'merge' : 'replace';
                const result = await importBackup(ctx.credentials, pool, req.payload, { mode });
                // 导入会改变账号集合（门控依赖 hasLoggedInAccount）与模型黑名单，
                // 必须广播目录变更，否则界面仍显示旧目录。
                broadcastCatalogChanged(ctx);
                if (mode === 'merge') {
                    ctx.logger.info(`[jet-hub] 合并导入：新增 ${result.accountsImported} 个账号，跳过 ${result.accountsSkipped.length} 个已存在`);
                }
                const value = {
                    credentialsImported: result.credentialsImported,
                    accountsImported: result.accountsImported,
                    accountsSkipped: result.accountsSkipped,
                    skipped: result.skipped,
                    expiredAccounts: result.expiredAccounts,
                    missingCredentials: result.missingCredentials,
                };
                return { ok: true, value };
            }
            // 账号池统计（导入前的覆盖提示用，也供导出弹窗勾选账号）：缺 expiresAt
            // 的条目疑似 DSH 版本切换后自动恢复的产物（反推不读凭据值，故无有效期）。
            // 前端据此在确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」，
            // 并在导出时列出可勾选的账号。
            case 'backup.status': {
                const state = pool.getStateSnapshot();
                const value = {
                    accounts: state.accounts.length,
                    withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === undefined).length,
                    // 只给展示字段：凭据内容绝不进这条响应。
                    accountList: state.accounts.map((entry) => ({
                        id: entry.id,
                        provider: entry.provider,
                        nickname: entry.nickname,
                        enabled: entry.enabled,
                    })),
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
             * 已有查表分派与 `unsupported provider` 的统一文案），本分支**原样透传**，
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
                // auto 的「余额」= **临期胜者**的余额（真实缺陷，用户报障 2026-10-06）：
                // auto 自己没有账号也没有余额，徽标若按字面查会显示「用量不可用」。
                // ⇒ 把请求改写给「auto 现在真正会用的那个 provider」。
                //
                // ⚠️ 判定逻辑在 `src/auto-badge.ts` 的 `resolveAutoBadgeRewrite`（**纯函数**）——
                //    本文件 4500+ 行且大量 import，单测无法 import 它的内部逻辑，只能做
                //    源码字符串断言，而**字符串断言是恒真的假用例**（把实现改成
                //    `if (false && …)` 后正则照样命中、用例依然全绿 —— 我实测撞过）。
                //    ⇒ 搬出去后测试可以行为断言（喂不同的 autoState，断言改写结果）。
                const rewrite = await resolveAutoBadgeRewrite(provider, AUTO_PROVIDER_ID, modelAdapters?.[AUTO_PROVIDER_ID]?.autoState?.());
                if (rewrite.kind === 'error') {
                    return { ok: false, error: { code: 'bad-request', message: rewrite.message } };
                }
                const effectiveProvider = rewrite.kind === 'rewrite' ? rewrite.effectiveProvider : provider;
                const value = await usageBadge.read(effectiveProvider, req.force === true ? { force: true } : {});
                // ⚠️ 响应里的 `provider` 必须**改回请求的 provider**（即 auto）：客户端
                // 用它做「这份读数属不属于我」的对号（usage-badge.js 的
                // `value.provider !== provider` 守卫）。原样透传被改写后的 provider 会被
                // 客户端当成「别的渠道的读数」丢弃 —— 表现就是徽标一直停在初始态。
                if (value?.ok === true && value.value !== undefined && rewrite.kind === 'rewrite') {
                    return {
                        ...value,
                        value: {
                            ...value.value,
                            provider,
                            ...(rewrite.autoActual === undefined ? {} : { autoActual: rewrite.autoActual }),
                            ...(rewrite.autoExpiryAt === undefined ? {} : { autoExpiryAt: rewrite.autoExpiryAt }),
                            ...(rewrite.autoPrice === undefined ? {} : { autoPrice: rewrite.autoPrice }),
                        },
                    };
                }
                return value;
            }
            /**
             * **Token 账本**快照（「Token 用量」面板）。
             *
             * 纯内存读（`readTokenLedger`），不打上游、不做任何 I/O —— 面板可以
             * 随意刷新。数据在重启后为空是**既定行为**（第 1 期不持久化），UI 负责
             * 把「进程内存账本」这一事实讲清楚。
             *
             * ⚠️ 这里**不**做渠道/provider 过滤：账本条数上限 500，全量下发即可，
             * 过滤维度（渠道、provider、模型）都由 UI 在聚合树上展开，避免为每个
             * 维度各造一个 RPC 端点。
             */
            case 'usage.tokenLedger': {
                const req = payload;
                const snapshot = readTokenLedger(typeof req?.limit === 'number' && Number.isFinite(req.limit) && req.limit > 0
                    ? { limit: Math.trunc(req.limit) }
                    : {});
                const value = { snapshot };
                return { ok: true, value };
            }
            /**
             * **历史日聚合**（第 4 期 · 「Token 用量」弹窗的历史视图）。
             *
             * 数据源是落盘的日聚合表（`token-ledger.json`，重启保留）—— 纯内存
             * 计算（Map 树 → 数组），不打上游、不做额外 I/O。
             *
             * `sinceDays` 钳制在 `[1, TOKEN_LEDGER_HISTORY_MAX_DAYS]`；也支持 fromDay / toDay
             * 按 UTC+8 日键做闭区间查询。落盘本身只保留 90 天。
             */
            case 'usage.tokenLedgerHistory': {
                const req = payload;
                const raw = req?.sinceDays;
                const sinceDays = typeof raw === 'number' && Number.isFinite(raw)
                    ? Math.min(Math.max(Math.trunc(raw), 1), TOKEN_LEDGER_HISTORY_MAX_DAYS)
                    : undefined;
                const fromDay = isValidTokenLedgerDayKey(req?.fromDay) ? req.fromDay : undefined;
                const toDay = isValidTokenLedgerDayKey(req?.toDay) ? req.toDay : undefined;
                const result = readTokenLedgerHistory(readTokenLedgerDayMap(), { sinceDays, fromDay, toDay });
                const value = { history: result.days, totals: result.totals };
                return { ok: true, value };
            }
            /** 只删除一个 UTC+8 日期的持久化历史累计，不触碰实时明细与其他设置。 */
            case 'usage.tokenLedgerDeleteDay': {
                const req = payload;
                if (!isValidTokenLedgerDayKey(req?.day)) {
                    return { ok: false, error: { code: 'bad-request', message: 'day 必须是有效的 YYYY-MM-DD 日期' } };
                }
                if (!deleteTokenLedgerDay(req.day)) {
                    return { ok: false, error: { code: 'not-found', message: `没有可删除的 ${req.day} 历史用量` } };
                }
                const value = { day: req.day, deleted: true };
                return { ok: true, value };
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
            case 'officeace.status': {
                /**
                 * OfficeAce（华为 MaaS）凭据状态：**只读探测**，不抛错。
                 *
                 * ⚠️ STS 临期先**静默刷新**（refresh_token 30 天，一次性）—— 刷新失败
                 * 不阻塞状态展示，仍按旧凭据回 `ready: true`（推理可能仍可用：MaaS 的
                 * Basic 凭据与 STS 生命周期不同步），真正失效由 `stream` 的 401 兜底。
                 */
                let credential = await auths.officeace.readOfficeAceCredential().catch(() => undefined);
                if (credential !== undefined && auths.officeace.isExpiring(credential)) {
                    credential = (await auths.officeace.refreshStoredCredential().catch(() => undefined)) ?? credential;
                }
                const base = { quotaUnit: OFFICEACE.quotaUnit };
                if (credential === undefined) {
                    return {
                        ok: true,
                        value: { ...base, ready: false, user: undefined, models: [], expiresAt: undefined },
                    };
                }
                return {
                    ok: true,
                    value: {
                        ...base,
                        ready: true,
                        user: credential.displayName ?? (credential.accountId !== undefined && credential.accountId.length > 0
                            ? `华为云 ${credential.accountId.slice(0, 8)}`
                            : '华为云账号'),
                        models: OFFICEACE_MODELS.map((m) => ({ id: m.id, name: m.name })),
                        expiresAt: credential.expiresAt,
                    },
                };
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