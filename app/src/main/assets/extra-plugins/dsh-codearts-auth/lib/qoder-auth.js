/**
 * Qoder 认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被三个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 LobsterAI 侧的实质差异只有两处：
 *
 * 1. **没有客户端版本号**。LobsterAI 的 exchange/续期/签到都要带 `version`，
 *    Qoder 不需要，故本服务没有 `resolveClientVersion`。
 * 2. **续期载荷是 `{refresh_token, machine_id}`**，`machine_id` 必须随凭据
 *    持久化并原样回传（见 `qoderRefreshBody`）。
 */
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { QODER_REQUEST_TIMEOUT_MS, QODER_REFRESH_PATH, applyQoderRefresh, isQoderExpired, isQoderRefreshable, parseQoderTokenPayload, qoderCredentialExpiresAtMs, qoderRefreshBody, } from './qoder.js';
import { QODER } from './qoder-product.js';
import { runQoderLoginFlow, startQoderLoginFlow, } from './qoder-oauth.js';
import { RefreshScheduler } from './refresh.js';
/**
 * Qoder 的默认凭据 ref。
 *
 * 等价于 `QODER.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `QODER.defaultCredentialRef`。
 */
export const QODER_CREDENTIAL_REF = 'QODER_ACCESS_TOKEN';
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与其它 provider 的同名类**刻意是各自独立的类**：
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
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
 * Qoder 认证服务：PKCE 设备码登录 + refresh_token 静默续期。
 */
export class QoderAuth extends Service {
    options;
    /** 本实例所属的产品配置。 */
    product;
    /** 本实例默认读写的凭据 ref 名称（`QODER_ACCESS_TOKEN`）。 */
    credentialRefName;
    scheduler = new RefreshScheduler(() => this.refresh(), (error) => {
        if (error instanceof RefreshTokenExpiredError) {
            // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
            this.markRefreshTokenInvalid();
            return;
        }
        this.lastRefreshError = error instanceof Error ? error.message : String(error);
    });
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    refreshTokenInvalid = false;
    lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    active = true;
    constructor(ctx, options = {}) {
        const product = options.product ?? QODER;
        super(ctx, options.serviceName ?? `${product.id}Auth`);
        this.options = options;
        this.product = product;
        this.credentialRefName = this.product.defaultCredentialRef;
    }
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    get fetchImpl() {
        return this.options.fetcher ?? fetch;
    }
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false。 */
    markRefreshTokenInvalid() {
        this.refreshTokenInvalid = true;
        this.lastRefreshError = 'refresh_token 已失效，请重新登录';
    }
    /**
     * 运行完整登录流程并持久化凭据。
     *
     * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
     * （Jet Hub 的「+ 新建账号」路径）。
     */
    async login(flowOptions = {}) {
        this.active = true;
        const flow = await runQoderLoginFlow({
            product: this.product,
            ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
            ...flowOptions,
        });
        return this.persistLogin(flow, flowOptions);
    }
    /**
     * **两步式登录**：立即返回登录 URL，由调用方先打开窗口。
     *
     * 与 CodeArts 的 `CodeArtsAuth.startLogin` / LobsterAI 的同名方法同因
     * （真实缺陷）：Jet Hub 的「+ 新建账号」原先调用阻塞式 {@link login}，
     * 而浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内
     * 允许 `window.open`。等阻塞调用返回时手势早已过期，`window.open` 被
     * 弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
     * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页。
     *
     * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
     */
    async startLogin(flowOptions = {}) {
        this.active = true;
        const started = await startQoderLoginFlow({
            product: this.product,
            ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
            ...flowOptions,
        });
        const result = started.result.then((flow) => this.persistLogin(flow, flowOptions));
        // 与 startQoderLoginFlow 同理：结果可能早于调用方 await 而落定，
        // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
        result.catch(() => { });
        return { loginUrl: started.loginUrl, result, close: started.close };
    }
    /**
     * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
     *
     * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
     * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
     */
    async persistLogin(flow, flowOptions = {}) {
        const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName);
        await this.ctx.credentials.set(ref, flow.access);
        this.refreshTokenInvalid = false;
        this.lastRefreshError = undefined;
        this.scheduleRefresh();
        const credential = parseCredential(flow.access);
        // 多账号：accountId 提供时自动注册到 pool
        if (flowOptions.accountId !== undefined && flowOptions.pool !== undefined) {
            await flowOptions.pool.addAccount({
                id: flowOptions.accountId,
                provider: this.product.id,
                nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                    ? credential.nickname
                    : flowOptions.accountId,
                enabled: true,
                credentialRef: flowOptions.refName ?? this.credentialRefName,
                createdAt: Date.now(),
                expiresAt: credential ? qoderCredentialExpiresAtMs(credential) : undefined,
                refreshable: credential !== undefined && isQoderRefreshable(credential),
            });
        }
        return {
            access: flow.access,
            expires: flow.expires,
            ref,
            loginUrl: flow.loginUrl,
            refreshable: flow.refreshable,
        };
    }
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    async status() {
        const ref = credentialRef(this.credentialRefName);
        const info = await this.ctx.credentials.describe(ref);
        if (!info.configured)
            return { configured: false, refreshable: false };
        let expiresAt;
        let refreshable = false;
        const resolved = await this.ctx.credentials.resolve(ref);
        if (resolved) {
            const credential = parseCredential(resolved.value);
            if (credential) {
                expiresAt = qoderCredentialExpiresAtMs(credential);
                refreshable = isQoderRefreshable(credential) && !this.refreshTokenInvalid;
            }
        }
        return {
            configured: true,
            source: info.source,
            expiresAt,
            refreshable,
            ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
        };
    }
    /**
     * 静默续期：`refresh_token` + `machine_id` 换取新令牌。
     *
     * 终态判定：
     * - HTTP 401/403、或响应缺 token → 抛 {@link RefreshTokenExpiredError}，
     *   让调度器停止续期；
     * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
     */
    async refresh() {
        const ref = credentialRef(this.credentialRefName);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved)
            throw new Error('未配置凭据，请先登录');
        const credential = parseCredential(resolved.value);
        if (!credential)
            throw new Error('凭据解析失败');
        if (!isQoderRefreshable(credential)) {
            throw new RefreshTokenExpiredError('无 refresh_token，请重新登录');
        }
        try {
            const refreshed = await this.refreshCredential(credential);
            // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
            // 避免已登出的凭据被在途刷新复活。
            if (!this.active)
                return;
            await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
            this.refreshTokenInvalid = false;
            this.lastRefreshError = undefined;
            this.scheduleRefresh();
        }
        catch (error) {
            if (error instanceof RefreshTokenExpiredError)
                this.markRefreshTokenInvalid();
            throw error;
        }
    }
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`QODER_ACCESS_TOKEN`），
     * 而 Jet Hub 账号卡片对应的是 `QODER_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     */
    async refreshAccountCredential(refName) {
        const ref = credentialRef(refName);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved)
            throw new Error('凭据未配置');
        const credential = parseCredential(resolved.value);
        if (!credential)
            throw new Error('凭据解析失败');
        if (!isQoderRefreshable(credential)) {
            throw new RefreshTokenExpiredError('无 refresh_token，请重新登录');
        }
        const refreshed = await this.refreshCredential(credential);
        await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
    }
    /**
     * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
     *
     * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
     * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
     */
    async refreshCredential(credential) {
        let response;
        try {
            response = await this.fetchImpl(`${this.product.openApiBase}${QODER_REFRESH_PATH}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': `${this.product.userAgentPrefix}/1.0.0`,
                },
                body: JSON.stringify(qoderRefreshBody(credential)),
                signal: AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS),
            });
        }
        catch (error) {
            // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
            // 用普通 Error 让 RefreshScheduler 安排重试。
            throw new Error(`Qoder 续期网络失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new RefreshTokenExpiredError(`Qoder 续期被拒绝（HTTP ${response.status}），请重新登录`);
        }
        let parsed;
        try {
            parsed = await response.json();
        }
        catch {
            throw new Error(`Qoder 续期响应不是 JSON（HTTP ${response.status}）`);
        }
        if (!response.ok) {
            // 非 401/403 的失败（5xx、429…）属可重试，交给调度器。
            const detail = JSON.stringify(parsed).slice(0, 200);
            throw new Error(`Qoder 续期失败（HTTP ${response.status}）：${detail}`);
        }
        const payload = parseQoderTokenPayload(parsed);
        if (payload.accessToken.length === 0) {
            // 拿到 200 却没有 token：视为无法续期（需重新登录），
            // 而不是当成可重试的瞬时故障。
            throw new RefreshTokenExpiredError('续期响应缺少访问令牌，请重新登录');
        }
        return applyQoderRefresh(credential, payload);
    }
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）：停用只应影响账号池的自动
     * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
     * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
     * 单账号失败不影响其他账号（与 `BuddyAuth.refreshAll` 同语义）。
     */
    async refreshAll(pool) {
        const accounts = await pool.listAccounts(this.product.id);
        for (const entry of accounts) {
            if (!entry.refreshable)
                continue;
            try {
                const ref = credentialRef(entry.credentialRef);
                const resolved = await this.ctx.credentials.resolve(ref);
                if (!resolved) {
                    await pool.updateAccount(entry.id, { refreshable: false });
                    continue;
                }
                const credential = parseCredential(resolved.value);
                if (!credential || !isQoderRefreshable(credential)) {
                    await pool.updateAccount(entry.id, { refreshable: false });
                    continue;
                }
                const refreshed = await this.refreshCredential(credential);
                await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
                await pool.updateAccount(entry.id, {
                    expiresAt: qoderCredentialExpiresAtMs(refreshed) ?? undefined,
                    refreshable: isQoderRefreshable(refreshed),
                });
            }
            catch (error) {
                if (error instanceof RefreshTokenExpiredError) {
                    try {
                        await pool.updateAccount(entry.id, { refreshable: false });
                    }
                    catch {
                        // 忽略 updateAccount 本身的错误
                    }
                    this.ctx.logger?.warn?.(`[qoder] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`);
                }
                else {
                    // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
                    // 静默失败会让账号在 UI 上仍显示「可续期」却永远刷不动，无从排查。
                    this.ctx.logger?.warn?.(`[qoder] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
                        + `${error instanceof Error ? error.message : String(error)}`);
                }
                // 单账号失败不中断循环
            }
        }
    }
    /** 移除已存储的凭据并停止任何待处理的刷新。 */
    async logout() {
        // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
        this.active = false;
        this.scheduler.stop();
        await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
    }
    /** 停止刷新调度（不清理凭据）。 */
    stop() {
        this.active = false;
        this.scheduler.stop();
    }
    /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
    scheduleRefresh() {
        void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
            if (!resolved)
                return;
            const credential = parseCredential(resolved.value);
            if (!credential || !isQoderRefreshable(credential))
                return;
            const expiresAt = qoderCredentialExpiresAtMs(credential);
            if (expiresAt !== undefined)
                this.scheduler.arm(expiresAt);
        });
    }
    /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
    async checkExpired() {
        const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
        if (!resolved)
            return true;
        const credential = parseCredential(resolved.value);
        return credential === undefined ? true : isQoderExpired(credential);
    }
    /**
     * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
     *
     * 供 e2e 探针与 `account-probe` 使用。
     */
    async resolveStoredCredential() {
        const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
        if (!resolved)
            return undefined;
        return parseCredential(resolved.value);
    }
}
//# sourceMappingURL=qoder-auth.js.map