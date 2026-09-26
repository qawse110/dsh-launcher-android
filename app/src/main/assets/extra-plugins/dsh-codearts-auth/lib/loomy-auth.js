/**
 * Loomy 认证服务。
 *
 * ## 与其余 7 个 provider 的**根本差异：不能续期**
 *
 * 其余 6 个都有 refresh_token 或等价的静默续期机制，`refreshAll()` 会真的
 * 换新凭据。Loomy **没有任何 refresh 端点** —— `session` 是登录时向服务端
 * 声明 `expire: 1209600`（14 天）得来的，到期只能**重新短信登录**。
 *
 * 因此：
 * - `isLoomyRefreshable()` 恒 `false`（诚实标记）；
 * - `refresh()` / `refreshAccountCredential()` 只做**有效性探测**
 *   （调一次轻量只读端点），失效时抛 `RefreshTokenExpiredError` 让 UI
 *   显示「凭证过期，请重新登录」，**不假装续期成功**；
 * - `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `loomyAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 */
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LOOMY_AUTH_ERROR_CODE, LOOMY_REQUEST_TIMEOUT_MS, credentialExpiresAtMs, isLoomyExpired, parseLoomyEnvelope, } from './loomy.js';
import { LOOMY } from './loomy-product.js';
import { LOOMY_SESSION_TTL_SECONDS, loginLoomyBySmsCode, sendLoomySmsCode } from './loomy-oauth.js';
import { startLoomyWechatLoginFlow, } from './loomy-wechat-login.js';
import { claimLoomyDailyQuota, fetchLoomyCreditBalance, fetchLoomyCreditDetail } from './loomy-credits.js';
import { claimAllLoomyOnboardingTasks, fetchLoomyOnboardingTasks, } from './loomy-onboarding.js';
/**
 * Loomy 的默认凭据 ref。
 *
 * 等价于 `LOOMY.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `LOOMY.defaultCredentialRef`。
 */
export const LOOMY_CREDENTIAL_REF = 'LOOMY_ACCESS_TOKEN';
/**
 * 凭据已被判定失效（且**无法续期**）时抛出的错误。
 *
 * ⚠️ `name` 必须恰为 `RefreshTokenExpiredError` ——
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据（这些类跨模块 identity 不同）。
 */
export class RefreshTokenExpiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RefreshTokenExpiredError';
    }
}
/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value) {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Loomy 认证服务：短信验证码登录 + **有效性探测**（非续期）。
 */
export class LoomyAuth extends Service {
    options;
    /** 本实例所属的产品配置。 */
    product;
    /** 本实例默认读写的凭据 ref 名称（`LOOMY_ACCESS_TOKEN`）。 */
    credentialRefName;
    /**
     * ⚠️ **刻意不使用 `RefreshScheduler`。**
     *
     * 那个调度器的存在意义是「在凭据过期前提前触发续期」
     * （`computeFirstRefreshDelayMs` 会在过期前 1 小时触发）。Loomy **无法续期**，
     * 武装它只会得到「1 小时后触发 → 探测 → 必然抛 RefreshTokenExpiredError
     * → 调度器停止」这一串无意义动作。
     *
     * 健康检查改由 `refreshAll(pool)` 承担 —— 它由 `index.ts` 的 30 分钟
     * 定时器驱动，只探测**已过期**的账号，语义与行为都诚实。
     * 故 `scheduleRefresh()` / `stop()` 是**有意为之的空实现**。
     */
    /** 最近一次探测失败的原因（供 `status()` 暴露给 UI）。 */
    lastRefreshError;
    /** 登录会话是否仍活跃；logout()/stop() 置 false。 */
    active = true;
    constructor(ctx, options = {}) {
        const product = options.product ?? LOOMY;
        super(ctx, options.serviceName ?? `${product.id}Auth`);
        this.options = options;
        this.product = product;
        this.credentialRefName = this.product.defaultCredentialRef;
    }
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    get fetchImpl() {
        return this.options.fetcher ?? fetch;
    }
    /**
     * 下发短信验证码。
     *
     * @returns `msgid` —— 提交验证码时必须原样带回。
     */
    async sendSmsCode(phone) {
        return sendLoomySmsCode(phone, this.product, this.fetchImpl);
    }
    /**
     * 启动**微信扫码**登录（推荐路径）。
     *
     * 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
     * 立即返回 `loginUrl` —— 与其余 provider 的「两步式」契约一致
     * （`window.open` 只在用户手势窗口内有效，不能等流程跑完再返回）。
     *
     * ⚠️ 与官方 Electron 实现的关键差异：官方用 `BrowserWindow` 的
     * `will-redirect` 截获微信 code，而回调页实测 404；本实现改为
     * **长轮询**直接拿 code（见 `loomy-wechat.ts`），完全不碰回调页。
     */
    async startWechatLogin() {
        this.active = true;
        return startLoomyWechatLoginFlow({
            product: this.product,
            ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
        });
    }
    /**
     * 把微信扫码流程的结果落盘成凭据。
     *
     * 与 `loginWithSmsCode` 分开：微信流程的编排（本地服务器 + 轮询 + 绑定表单）
     * 在 `loomy-wechat-login.ts` 里，本方法只负责「写凭据 + 初始化每日额度」。
     */
    async persistWechatLogin(login, flowOptions = {}) {
        const credential = this.buildCredential(login.session, login.userid, login.phone, login.nickname);
        const refName = flowOptions.refName ?? this.credentialRefName;
        const ref = credentialRef(refName);
        await this.ctx.credentials.set(ref, JSON.stringify(credential));
        this.lastRefreshError = undefined;
        // 尽力初始化每日额度（与官方登录后行为一致；失败不影响登录）。
        try {
            await claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
        }
        catch (error) {
            this.ctx.logger?.warn?.(`[loomy] 微信登录后初始化每日额度失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            access: JSON.stringify(credential),
            expires: credentialExpiresAtMs(credential) ?? 0,
            ref,
            refreshable: false,
        };
    }
    /**
     * 用短信验证码登录并持久化凭据。
     *
     * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池。
     */
    async loginWithSmsCode(phone, code, msgid, flowOptions = {}) {
        this.active = true;
        const result = await loginLoomyBySmsCode(phone, code, msgid, this.product, this.fetchImpl);
        const credential = this.buildCredential(result.session, result.userid, phone);
        const refName = flowOptions.refName ?? this.credentialRefName;
        const ref = credentialRef(refName);
        await this.ctx.credentials.set(ref, JSON.stringify(credential));
        this.lastRefreshError = undefined;
        // 尽力调用 first-login 初始化每日额度（与官方登录后行为一致）。
        // ⚠️ 失败**不影响登录**：这只是额度初始化，登录本身已经成功。
        try {
            await claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
        }
        catch (error) {
            this.ctx.logger?.warn?.(`[loomy] 登录后初始化每日额度失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            access: JSON.stringify(credential),
            expires: credentialExpiresAtMs(credential) ?? 0,
            ref,
            // ⚠️ 恒 false：Loomy 无续期机制。
            refreshable: false,
        };
    }
    /**
     * 构造凭据对象。
     *
     * ⚠️ `expires_at` 由**本地**按 14 天推算 —— 服务端响应里不带到期时间戳，
     * 它只接受登录请求里的 `expire` 参数。
     */
    buildCredential(session, userid, phone, nickname) {
        return {
            access_token: session,
            userid,
            phone,
            ...nickname === undefined || nickname.length === 0 ? {} : { nickname },
            expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
        };
    }
    /** 解析当前单凭据（默认 ref）。 */
    async resolveDefaultCredential() {
        const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
        return resolved === undefined ? undefined : parseCredential(resolved.value);
    }
    /** 只读登录状态。 */
    async status() {
        const credential = await this.resolveDefaultCredential();
        if (credential === undefined)
            return { configured: false, refreshable: false };
        const expiresAt = credentialExpiresAtMs(credential);
        return {
            configured: true,
            source: this.credentialRefName,
            ...expiresAt === undefined ? {} : { expiresAt },
            // ⚠️ 恒 false：Loomy 无续期机制。UI 据此显示「过期需重新登录」。
            refreshable: false,
            ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
        };
    }
    /**
     * 探测凭据有效性（**不续期**）。
     *
     * ⚠️ 这是与其余 provider 语义上的关键差异：`refresh()` 在那边意味着
     * 「换一份新凭据」，在这里只能是「确认这份凭据还活着」。
     * 失效时抛 `RefreshTokenExpiredError`，让 UI 明确提示重新登录，
     * 而不是静默假装成功。
     */
    async refresh() {
        const credential = await this.resolveDefaultCredential();
        if (credential === undefined)
            throw new RefreshTokenExpiredError('凭据未配置，请先登录');
        await this.probeCredential(credential);
        this.lastRefreshError = undefined;
    }
    /**
     * 探测指定 ref 的凭据有效性（账号卡片「刷新」按钮）。
     *
     * ⚠️ 与 `refresh()` 的区别：`refresh()` 读写默认单凭据 ref，
     * 而账号卡片对应的是 `LOOMY_ACCOUNT_XXX`。用 `refresh()` 刷账号池里的
     * 账号实际刷的是另一个凭据（本插件在 Cline 上踩过同类坑）。
     *
     * ⚠️ **不触碰** `lastRefreshError`：那个状态属于单凭据路径，
     * 被多账号操作污染会让 UI 显示错误的失效提示。
     */
    async refreshAccountCredential(refName) {
        const ref = credentialRef(refName);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved)
            throw new Error('凭据未配置');
        const credential = parseCredential(resolved.value);
        if (!credential)
            throw new Error('凭据解析失败');
        await this.probeCredential(credential);
    }
    /**
     * 用一次轻量只读请求验证凭据是否仍然有效。
     *
     * 选 `GET /points/records?pageSize=1` 的理由：它是最便宜的只读端点
     * （不消耗积分、不产生任何副作用），且认证语义与其它业务端点一致。
     *
     * @throws {RefreshTokenExpiredError} 收到 `100002`（登录已失效）。
     */
    async probeCredential(credential) {
        let response;
        try {
            response = await this.fetchImpl(`${this.product.apiBase}/points/records?pageNo=1&pageSize=1&recordType=all`, {
                method: 'GET',
                headers: { Accept: 'application/json', token: credential.access_token },
                signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
            });
        }
        catch (error) {
            // 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
            throw new Error(`Loomy 凭据探测网络失败：${error instanceof Error ? error.message : String(error)}`);
        }
        let parsed;
        try {
            parsed = await response.json();
        }
        catch {
            throw new Error(`Loomy 凭据探测响应不是 JSON（HTTP ${response.status}）`);
        }
        const envelope = parseLoomyEnvelope(parsed);
        if (envelope.ok)
            return;
        if (envelope.code === LOOMY_AUTH_ERROR_CODE) {
            // ⚠️ Loomy 无法续期：这里只能明确报「需重新登录」，
            // 不能像其余 provider 那样尝试换新凭据。
            throw new RefreshTokenExpiredError(`Loomy 凭证已失效，请重新登录（${envelope.message}）`);
        }
        throw new Error(`Loomy 凭据探测失败：${envelope.message}`);
    }
    /**
     * 批量探测本产品的账号。
     *
     * ⚠️ **只探测已过期的账号**：Loomy 不可续期，对未过期的账号做探测
     * 纯属白费请求（`refreshAll` 每 30 分钟跑一次）。
     *
     * ⚠️ 按 AGENTS.md 约定，过滤**只看过期状态，不看 `enabled`** ——
     * 停用只影响账号池的自动选号，与凭据健康无关。
     *
     * 单账号失败不影响其他账号。
     */
    async refreshAll(pool) {
        const accounts = await pool.listAccounts(this.product.id);
        for (const entry of accounts) {
            const ref = credentialRef(entry.credentialRef);
            let credential;
            try {
                const resolved = await this.ctx.credentials.resolve(ref);
                if (!resolved)
                    continue;
                credential = parseCredential(resolved.value);
            }
            catch {
                continue;
            }
            if (credential === undefined)
                continue;
            // 只探测**已过期**的账号：Loomy 不可续期，未过期的账号无事可做。
            if (!isLoomyExpired(credential))
                continue;
            try {
                await this.probeCredential(credential);
            }
            catch (error) {
                if (error instanceof RefreshTokenExpiredError) {
                    this.ctx.logger?.warn?.(`[loomy] 账号 ${entry.id} 的凭证已失效（Loomy 无续期端点，需重新登录）`);
                }
                else {
                    // 非终态失败（网络抖动、5xx）也必须留日志：曾经完全静默的实现
                    // 让「续期永远失败但 UI 显示可续期」无法排查。
                    this.ctx.logger?.warn?.(`[loomy] 账号 ${entry.id} 凭证探测失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    /** 登出：清除默认单凭据。 */
    async logout() {
        this.active = false;
        await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
        this.lastRefreshError = undefined;
    }
    /**
     * **有意为之的空实现。**
     *
     * 其余 provider 用它武装 `RefreshScheduler`（过期前 1 小时自动续期）。
     * Loomy **无法续期**，武装调度器只会得到一串无意义的「探测 → 必然失败」。
     * 账号健康由 `refreshAll(pool)` 承担（`index.ts` 的 30 分钟定时器驱动）。
     *
     * 保留该方法是**契约要求**：`index.ts` 对全部 provider 统一调用
     * `scheduleRefresh()`，缺了它会以 `is not a function` 崩在启动路径上。
     */
    scheduleRefresh() {
        // 故意为空：Loomy 无续期端点。
    }
    /**
     * **有意为之的空实现。**
     *
     * 与 `scheduleRefresh()` 同理：没有调度器需要停止。
     * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
     */
    stop() {
        this.active = false;
    }
    // ── 业务能力（供 Jet Hub RPC 调用）────────────────────────────────
    /** 查询积分余额（只读，两池映射成 CreditBalance）。 */
    async fetchCreditBalance(credential) {
        return fetchLoomyCreditBalance(credential, this.product, this.fetchImpl);
    }
    /** 查询积分两池明细（只读）。 */
    async fetchCreditDetail(credential) {
        return fetchLoomyCreditDetail(credential, this.product, this.fetchImpl);
    }
    /** 一键签到：触发每日额度。 */
    async claimDailyQuota(credential) {
        return claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
    }
    /** 查询新手任务状态。 */
    async fetchOnboardingTasks(credential) {
        return fetchLoomyOnboardingTasks(credential, this.product, this.fetchImpl);
    }
    /** 领取全部新手任务（补差额）。 */
    async claimOnboardingTasks(credential) {
        return claimAllLoomyOnboardingTasks(credential, this.product, this.fetchImpl);
    }
}
//# sourceMappingURL=loomy-auth.js.map