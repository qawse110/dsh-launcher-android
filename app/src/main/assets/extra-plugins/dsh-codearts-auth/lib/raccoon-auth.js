/**
 * Raccoon Work 认证服务。
 *
 * ## 与其余 provider 的差异
 *
 * | 维度 | raccoon | 对照 |
 * |---|---|---|
 * | 登录 | 微信扫码 + 短信（本地页承载） | Loomy 同型 |
 * | 续期 | **有** `refresh_token` 轮换 | Loomy 没有（恒 false） |
 * | 凭据过期 | JWT `exp` 本地解码 | 比 Loomy 的「登录时刻 + 14 天推算」更准 |
 *
 * ## 两条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 *    早期按 `enabled` 过滤导致两个停用账号的 refresh_token 被放到失效。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `RACCOON_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 */
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { isRaccoonExpired, isRaccoonRefreshable, raccoonDisplayName, decodeJwtExpMs, } from './raccoon.js';
import { claimRaccoonLoginReward, fetchRaccoonCreditBalance, fetchRaccoonOnboardingStatus, } from './raccoon-credits.js';
import { fetchRaccoonUserInfo, refreshRaccoonCredential, } from './raccoon-oauth.js';
import { RACCOON } from './raccoon-product.js';
import { startRaccoonLoginFlow, } from './raccoon-login-page.js';
/** 默认凭据 ref 名称（与 `RaccoonProduct.defaultCredentialRef` 一致）。 */
export const RACCOON_CREDENTIAL_REF = 'RACCOON_ACCESS_TOKEN';
/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 */
export class RefreshTokenExpiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RefreshTokenExpiredError';
    }
}
/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseRaccoonCredential(value) {
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
/** 把远端模型条目归一（含展示名）。 */
function normalizeRemoteModel(entry) {
    const id = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (id.length === 0)
        return undefined;
    // 远端 visible 缺省视为可见（保守：不因字段缺失而隐藏模型）
    if (entry.visible === false)
        return undefined;
    const params = typeof entry.params === 'object' && entry.params !== null
        ? entry.params
        : {};
    const description = typeof entry.description === 'string' && entry.description.length > 0
        ? entry.description
        : id;
    const effective = typeof entry.billing_effective_multiplier === 'number'
        ? entry.billing_effective_multiplier
        : Number.NaN;
    const base = typeof entry.billing_multiplier === 'number' ? entry.billing_multiplier : Number.NaN;
    const rawStatus = typeof entry.billing_status === 'string' ? entry.billing_status : '';
    const status = rawStatus === 'discount' || rawStatus === 'limited_free'
        ? rawStatus
        : 'normal';
    const statusNote = typeof entry.billing_status_note === 'string' ? entry.billing_status_note : '';
    const meta = {
        id,
        description,
        effectiveMultiplier: effective,
        baseMultiplier: base,
        status,
        statusNote,
    };
    const readPositiveInt = (value) => {
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
    };
    const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((t) => typeof t === 'string').map((t) => t.toLowerCase())
        : [];
    return {
        id,
        name: raccoonDisplayName(meta),
        contextWindow: readPositiveInt(params.context_window ?? entry.context_window),
        maxTokens: readPositiveInt(params.max_tokens),
        supportsImage: tags.includes('vision') || tags.includes('image') || tags.includes('image-understanding'),
    };
}
/**
 * Raccoon Work 认证服务。
 *
 * 登录走**本地页承载**的扫码/短信双路径（见 `raccoon-login-page.ts`），
 * 续期走 `refresh_token` 轮换（与 Loomy 不同）。
 */
export class RaccoonAuth extends Service {
    options;
    /** 本实例所属的产品配置。 */
    product;
    /** 本实例默认读写的凭据 ref 名称。 */
    credentialRefName;
    /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
    lastRefreshError;
    constructor(ctx, options = {}) {
        const product = options.product ?? RACCOON;
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
     * 启动登录（微信扫码 + 短信双路径）。
     *
     * 起本地服务器承载弹窗页，**立即返回 `loginUrl`** —— 与其余 provider 的
     * 「两步式」契约一致（`window.open` 只在用户手势窗口内有效，
     * 不能等流程跑完再返回）。
     */
    async startLogin() {
        return startRaccoonLoginFlow({
            product: this.product,
            ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
        });
    }
    /**
     * 把登录结果落盘成凭据。
     *
     * 与 `startLogin` 分开：流程编排（本地服务器 + 轮询 + 表单）在
     * `raccoon-login-page.ts` 里，本方法只负责「补全用户信息 + 写凭据 +
     * 静默领取一次性登录奖励」。
     */
    async persistLogin(credential, flowOptions = {}) {
        const refName = flowOptions.refName ?? this.credentialRefName;
        // 尽力补全用户信息（id / 昵称 / 身份 / 手机号）：失败不影响登录。
        let enriched = credential;
        if (credential.nickname === undefined
            || credential.user_id === undefined
            || credential.phone === undefined) {
            const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl);
            enriched = {
                ...credential,
                ...info.userId !== undefined && credential.user_id === undefined ? { user_id: info.userId } : {},
                ...info.nickname !== undefined && credential.nickname === undefined ? { nickname: info.nickname } : {},
                ...info.officeIdentity !== undefined && credential.office_identity === undefined
                    ? { office_identity: info.officeIdentity } : {},
                // ⚠️ 手机号专门为**多账号消歧**而存：远端的 `name` 是自动生成的默认名
                //（实测 `RaccoonAva`），微信扫码不回传微信昵称，故多个账号会重名。
                ...info.phone !== undefined && credential.phone === undefined ? { phone: info.phone } : {},
            };
        }
        const ref = credentialRef(refName);
        await this.ctx.credentials.set(ref, JSON.stringify(enriched));
        this.lastRefreshError = undefined;
        // 尽力领取**一次性**登录奖励（3000 分）。幂等：已领过返回 granted:false。
        // 失败不影响登录成功 —— 登录已经完成了，不能因为积分接口抖动而报错。
        try {
            await claimRaccoonLoginReward(this.product, enriched, this.fetchImpl);
        }
        catch (error) {
            this.ctx.logger?.warn?.(`[raccoon] 登录后领取登录奖励失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            access: JSON.stringify(enriched),
            expires: decodeJwtExpMs(enriched.access_token) ?? 0,
            ref,
            refreshable: isRaccoonRefreshable(enriched),
        };
    }
    /** 只读登录状态。 */
    async status() {
        const credential = await this.resolveDefaultCredential();
        if (credential === undefined)
            return { configured: false, refreshable: false };
        const expiresAt = decodeJwtExpMs(credential.access_token);
        return {
            configured: true,
            source: this.credentialRefName,
            ...expiresAt === undefined ? {} : { expiresAt },
            refreshable: isRaccoonRefreshable(credential),
            ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
        };
    }
    /** 解析默认 ref 的凭据。 */
    async resolveDefaultCredential() {
        try {
            const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
            return resolved === undefined ? undefined : parseRaccoonCredential(resolved.value);
        }
        catch {
            return undefined;
        }
    }
    /**
     * 续期默认单凭据。
     *
     * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
     */
    async refresh() {
        const credential = await this.resolveDefaultCredential();
        if (credential === undefined)
            throw new RefreshTokenExpiredError('凭据未配置，请先登录');
        if (!isRaccoonRefreshable(credential)) {
            throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
        }
        try {
            const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl);
            await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next));
            this.lastRefreshError = undefined;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastRefreshError = message;
            if (message.includes('重新登录'))
                throw new RefreshTokenExpiredError(message);
            throw error;
        }
    }
    /**
     * 续期**指定 ref**（账号卡片「刷新」按钮）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
     * `RACCOON_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
     * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，
     * 被多账号操作污染会让 UI 显示错误的失效提示。
     */
    async refreshAccountCredential(refName) {
        const ref = credentialRef(refName);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved)
            throw new Error('凭据未配置');
        const credential = parseRaccoonCredential(resolved.value);
        if (!credential)
            throw new Error('凭据解析失败');
        if (!isRaccoonRefreshable(credential)) {
            throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录');
        }
        try {
            const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl);
            await this.ctx.credentials.set(ref, JSON.stringify(next));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('重新登录'))
                throw new RefreshTokenExpiredError(message);
            throw error;
        }
    }
    /**
     * 批量续期本产品的账号。
     *
     * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的
     * 自动选号，与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致
     * 两个停用账号的 refresh_token 在停用期间被放到失效（真实缺陷，见 AGENTS.md）。
     *
     * 单账号失败不影响其他账号（且**必须留日志**：曾完全静默的实现
     * 让「续期永远失败但 UI 显示可续期」无法排查）。
     */
    async refreshAll(pool) {
        const accounts = await pool.listAccounts(this.product.id);
        for (const entry of accounts) {
            // ⚠️ 判据只看 refreshable
            if (!entry.refreshable)
                continue;
            // 未过期的凭据无需续期（access_token 寿命约 3 小时，
            // 30 分钟的定时器会把已过期的都覆盖到）。
            const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
            if (!resolved)
                continue;
            const credential = parseRaccoonCredential(resolved.value);
            if (credential === undefined)
                continue;
            if (!isRaccoonExpired(credential))
                continue;
            try {
                await this.refreshAccountCredential(entry.credentialRef);
            }
            catch (error) {
                if (error instanceof RefreshTokenExpiredError) {
                    this.ctx.logger?.warn?.(`[raccoon] 账号 ${entry.id} 的 refresh_token 已失效，需重新登录`);
                }
                else {
                    this.ctx.logger?.warn?.(`[raccoon] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    /** 登出：清除默认单凭据。 */
    async logout() {
        await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
        this.lastRefreshError = undefined;
    }
    /**
     * 拉取远端模型目录。
     *
     * ⚠️ 失败时返回**空数组**：适配器据此回退兜底表。
     * 让模型目录失败不抛错，是为了不让整个 provider 在模型选择器里报错。
     */
    async fetchModels(pool) {
        const credential = await this.resolveForFetchModels(pool);
        if (credential === undefined)
            return [];
        try {
            const response = await this.fetchImpl(`${this.product.apiBase}${this.product.llmApiPrefix}/model_catalog`, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${credential.access_token}`,
                    'X-Org-Code': credential.office_identity ?? '',
                    'X-Raccoon-Language': 'zh',
                },
                signal: AbortSignal.timeout(20_000),
            });
            if (!response.ok)
                return [];
            const payload = await response.json();
            return parseRaccoonModelCatalog(payload);
        }
        catch {
            return [];
        }
    }
    /** 取一个可用凭据（先账号池，再默认 ref）。 */
    async resolveForFetchModels(pool) {
        if (pool !== undefined) {
            try {
                // ⚠️ 返回类型是 `| null`（不是 undefined）—— 判空必须用 `!= null` 或显式 null。
                const available = await pool.getAvailableAccount(this.product.id, '');
                if (available !== null && available !== undefined) {
                    const credential = available.credential;
                    if (typeof credential?.access_token === 'string')
                        return credential;
                }
            }
            catch {
                // 落到默认 ref
            }
        }
        return this.resolveDefaultCredential();
    }
    /** 查询积分余额（供 Jet Hub 账号卡片）。 */
    async fetchCreditBalance(credential) {
        return fetchRaccoonCreditBalance(this.product, credential, this.fetchImpl);
    }
    /** 领取一次性登录奖励。 */
    async claimLoginReward(credential) {
        return claimRaccoonLoginReward(this.product, credential, this.fetchImpl);
    }
    /** 查询一次性登录奖励是否已领。 */
    async fetchOnboardingStatus(credential) {
        return fetchRaccoonOnboardingStatus(this.product, credential, this.fetchImpl);
    }
    /**
     * 一次性修复**老账号**的昵称与凭据字段（启动时调用）。
     *
     * ## 为什么需要它
     *
     * 早期实现有两处不足，导致**已登录的账号不会自动更正**：
     *
     * 1. 账号昵称直接用了服务端的 `name`（实测 `RaccoonAva` —— 它是服务端
     *    **自动生成的默认名**，注册第二个账号时会重名、无法区分）；
     * 2. 凭据里**没有存 `phone`**（后来才发现 `user_info.phone` 可用于消歧）。
     *
     * 光改代码只影响**新登录**的账号，老账号的昵称/凭据仍是旧值。
     * 故这里主动补一次：读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 →
     * 用 `buildRaccoonNickname` 重算昵称并写回账号池。
     *
     * ## 语义约束
     *
     * - **幂等**：昵称已是目标形态时不写（避免每次启动都落盘）。
     * - **失败不阻塞启动**：单个账号失败只记日志，抛错由调用方 catch。
     * - **不发写请求**：只调只读的 `user_info`，不碰积分领取端点。
     * - `buildNickname` 由调用方注入（它依赖 `jet-hub-rpc` 里的纯函数，
     *   而那个模块依赖本模块 —— 注入避免循环依赖）。
     *
     * @returns 被修复的账号 id 列表（供日志）。
     */
    async repairAccountNicknames(pool, buildNickname) {
        const repaired = [];
        let entries;
        try {
            entries = await pool.listAccounts(this.product.id);
        }
        catch {
            return repaired;
        }
        for (const entry of entries) {
            try {
                const ref = credentialRef(entry.credentialRef);
                const resolved = await this.ctx.credentials.resolve(ref);
                if (!resolved)
                    continue;
                const credential = parseRaccoonCredential(resolved.value);
                if (credential === undefined)
                    continue;
                // 缺 phone（或 user_id/nickname）时补一次 user_info（只读）。
                let next = credential;
                if (credential.phone === undefined || credential.user_id === undefined) {
                    const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl);
                    const patched = {
                        ...credential,
                        ...info.phone !== undefined && credential.phone === undefined ? { phone: info.phone } : {},
                        ...info.userId !== undefined && credential.user_id === undefined ? { user_id: info.userId } : {},
                        ...info.nickname !== undefined && credential.nickname === undefined
                            ? { nickname: info.nickname } : {},
                        ...info.officeIdentity !== undefined && credential.office_identity === undefined
                            ? { office_identity: info.officeIdentity } : {},
                    };
                    const changed = JSON.stringify(patched) !== JSON.stringify(credential);
                    if (changed) {
                        await this.ctx.credentials.set(ref, JSON.stringify(patched));
                        next = patched;
                    }
                }
                const target = buildNickname(next, entry.id);
                // ⚠️ 只在**确实变化**时写账号池：否则每次启动都落盘一次
                //（`updateAccount` 是整体 replace，会触发一次文档写）。
                if (target !== entry.nickname) {
                    await pool.updateAccount(entry.id, { nickname: target });
                    repaired.push(entry.id);
                }
            }
            catch (error) {
                this.ctx.logger?.warn?.(`[raccoon] 修复账号 ${entry.id} 的昵称失败（不影响使用）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return repaired;
    }
}
/**
 * 解析 `GET /model_catalog` 响应。
 *
 * 只取 `categories[].type === 'chat'` 的那个分类（实测只有一个），
 * 过滤 `visible === false`，并用 `raccoonDisplayName` 生成含倍率的展示名。
 */
export function parseRaccoonModelCatalog(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        return [];
    const root = payload;
    if (root.code !== 0)
        return [];
    const data = typeof root.data === 'object' && root.data !== null && !Array.isArray(root.data)
        ? root.data
        : undefined;
    if (data === undefined)
        return [];
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const chat = categories.find((c) => {
        return typeof c === 'object' && c !== null && !Array.isArray(c)
            && c.type === 'chat';
    });
    if (chat === undefined)
        return [];
    const models = Array.isArray(chat.models)
        ? chat.models
        : [];
    const seen = new Set();
    const out = [];
    for (const raw of models) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            continue;
        const model = normalizeRemoteModel(raw);
        if (model === undefined || seen.has(model.id))
            continue;
        seen.add(model.id);
        out.push(model);
    }
    return out;
}
//# sourceMappingURL=raccoon-auth.js.map