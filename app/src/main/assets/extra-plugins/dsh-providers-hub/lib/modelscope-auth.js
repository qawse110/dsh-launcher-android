/**
 * ModelScope（魔搭）认证服务。
 *
 * ## 与其余 provider 的**根本差异：没有登录流程，也不能续期**
 *
 * 魔搭的凭据是用户在**控制台手工生成的 API Key**（形态 `ms-…`），
 * 既没有 OAuth 授权页，也没有 refresh 端点：
 *
 * - 因此**不实现** `login()` / `startLogin()` —— 本 provider 的入口是
 *   Jet Hub 面板上的**粘贴 Key 弹窗**（与 opencode 同型，是本插件第二家
 *   「不跳浏览器」的登录方式）。`account.create` 分支直接走
 *   `modelscope.addAccount`，**不经过**「弹窗 + 登录轮询」那条路径；
 * - `refresh()` / `refreshAccountCredential()` / `refreshAll()` 只做
 *   **有效性对账**（重读凭据 + 回写 `expiresAt`），**不假装续期成功** ——
 *   与 Loomy 同类（那边也没有 refresh 端点），但**理由更根本**：魔搭的 Key
 *   默认长期有效，压根没有「快过期」这回事。
 *
 * ## ⚠️ `refreshAll()` 只按「凭据是否已过期」过滤，**不看 `enabled`**
 *
 * AGENTS.md 的铁律：停用只影响「账号池的自动选号」，与「凭据是否需要保持
 * 新鲜」无关。本 provider 的凭据是静态材料，这条影响其实为零（没有网络请求
 * 可发），但**接口形态必须与其余 provider 一致** —— 否则将来若魔搭推出
 * refresh 端点，这里会成为一个新的单向门。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `modelscopeAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module src/modelscope-auth.ts
 */
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { isModelscopeExpired, modelscopeCredentialExpiresAtMs, modelscopeIdentityOf, } from './modelscope.js';
import { MODELSCOPE } from './modelscope-product.js';
import { syncAccountExpiry } from './expiry-sync.js';
/**
 * 魔搭凭据 → 账号池有效期的提取器。
 *
 * ⚠️ **刻意不提供 `refreshableOf`**：`isModelscopeRefreshable` **恒为 `false`**
 * （上游没有任何 refresh 端点，这是**诚实标记**而非凭据状态）。若让共享实现
 * 据此回写池里的 `refreshable`，会把「账号落池时明确写 false」这件事变成
 * 「每轮对账都写一次」—— 语义上没错，但会让整个账号列表每 30 分钟落盘一次
 * （`syncAccountExpiry` 的「变了才写盘」短路失效）。魔搭这里只需要同步
 * `expiresAt`，与 Loomy 同处理。
 */
const MODELSCOPE_EXPIRY_ACCESSORS = {
    expiresAtOf: modelscopeCredentialExpiresAtMs,
    identityOf: modelscopeIdentityOf,
};
/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
export function parseModelscopeCredential(value) {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object'
            && parsed !== null
            && typeof parsed.access_token === 'string'
            && parsed.access_token.length > 0
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * ModelScope 认证服务：**凭据保管与有效期对账**（无登录、无续期）。
 */
export class ModelscopeAuth extends Service {
    /** 本实例所属的产品配置。 */
    product;
    /** 本实例默认读写的凭据 ref 名称（`MODELSCOPE_ACCESS_TOKEN`）。 */
    credentialRefName;
    constructor(ctx, options = {}) {
        const product = options.product ?? MODELSCOPE;
        super(ctx, options.serviceName ?? `${product.id}Auth`);
        this.product = product;
        this.credentialRefName = product.defaultCredentialRef;
    }
    /**
     * 面板状态：只看**池里有没有该 provider 的凭据**（与其余 provider 的门控
     * 判据完全一致）。
     *
     * ⚠️ 与 AGENTS.md 的「十个 provider 门控判据完全一致：都只看账号池」同款 ——
     * 本 provider 也**不**为单凭据 ref 开例外（那里早期有过 `extraCredentialRefs`，
     * 已整体删除）。
     */
    async status(pool) {
        // 未传池（headless / 单测）时退化为读默认 ref：与其余 auth 的兼容路径同构。
        if (pool === undefined) {
            const resolved = await this.ctx.credentials
                .resolve(credentialRef(this.credentialRefName))
                .catch(() => undefined);
            if (resolved === undefined)
                return { configured: false, refreshable: false };
            const credential = parseModelscopeCredential(resolved.value);
            if (credential === undefined)
                return { configured: false, refreshable: false };
            const expiresAt = modelscopeCredentialExpiresAtMs(credential);
            return {
                configured: true,
                source: 'api-key',
                refreshable: false,
                ...expiresAt === undefined ? {} : { expiresAt },
            };
        }
        const entries = pool.listAccountsByProvider(this.product.id);
        for (const entry of entries) {
            const credential = await this.readCredential(entry.credentialRef);
            if (credential === undefined)
                continue;
            const expiresAt = modelscopeCredentialExpiresAtMs(credential);
            return {
                configured: true,
                source: 'api-key',
                refreshable: false,
                ...expiresAt === undefined ? {} : { expiresAt },
            };
        }
        return { configured: false, refreshable: false };
    }
    /**
     * 单凭据路径的「续期」。
     *
     * ⚠️ **这里不发出任何网络请求，也不写凭据** —— 魔搭没有 refresh 端点。
     * 它只做一次**有效性对账**：凭据不可读时抛可读错误（引导用户在面板重新粘贴），
     * 可读时静默通过。**绝不返回「续期成功」的假象**（与 Loomy 的
     * `RefreshTokenExpiredError` 同口径）。
     */
    async refresh() {
        const resolved = await this.ctx.credentials
            .resolve(credentialRef(this.credentialRefName))
            .catch(() => undefined);
        if (resolved === undefined || parseModelscopeCredential(resolved.value) === undefined) {
            throw new Error(`ModelScope：凭据 ${this.credentialRefName} 不可用。`
                + '魔搭的 API Key 没有续期端点，请在 Jet Hub 的 ModelScope 面板重新粘贴一个 Key。');
        }
    }
    /**
     * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
     *
     * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
     * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口
     * （issue !IKIRTT）。魔搭这边通常没有 `expires_at` 可写，但**接口不能少**
     * —— `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条
     * 不变式，缺参数能编译、类型全绿，但会静默丢回写。
     *
     * @param refName  账号的凭据 ref（**不是**默认单凭据 ref）。
     * @param pool     账号池；提供时才回写 `expiresAt`。
     * @param accountId 账号 id；提供时免去按凭据身份反查。
     */
    async refreshAccountCredential(refName, pool, accountId) {
        const credential = await this.readCredential(refName);
        if (credential === undefined) {
            throw new Error(`ModelScope：凭据 ${refName} 不可用或不是合法的 API Key 凭据。`
                + '请在 Jet Hub 的 ModelScope 面板重新粘贴一个 Key。');
        }
        await syncAccountExpiry({
            pool,
            provider: this.product.id,
            credential,
            accessors: MODELSCOPE_EXPIRY_ACCESSORS,
            ...accountId === undefined ? {} : { accountId },
            tag: '[modelscope]',
        });
    }
    /**
     * 批量对账（启动首轮 + 每 30 分钟的定时器）。
     *
     * ## ⚠️ 三条必须同时满足（见 AGENTS.md 的「续期三件事缺一不可」）
     *
     * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜。魔搭这里没有网络
     *    请求，但判据必须写对 —— 否则将来加 refresh 端点即成单向门；
     * 2. **不过滤 `refreshable`**：那个布尔只是**凭据材料的镜像**，拿它当门禁会把
     *    一次瞬时失败固化成永久状态（AGENTS.md 的「账号池的 `refreshable` 只是
     *    凭据材料的镜像」一节）。魔搭的凭据恒 `refreshable:false`，用它会变成
     *    **一条都进不来**；
     * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**：池值正是可能陈旧的那份
     *    数据（`syncAccountExpiry` 的 lead-time 注释）。
     *
     * 本 provider 的「跳过」分支**只跳过对账之外的动作**，且每轮仍会调用
     * `syncAccountExpiry` —— 存量账号的池值即便早已陈旧（例如上一版插件从未
     * 回写过），也会在第一次运行后被自动更正。
     */
    async refreshAll(pool) {
        if (pool === undefined)
            return;
        const entries = pool.listAccountsByProvider(this.product.id);
        for (const entry of entries) {
            // ⚠️ 刻意**不判** entry.enabled、**不判** entry.refreshable（见上）。
            const credential = await this.readCredential(entry.credentialRef);
            if (credential === undefined) {
                // 凭据读不出来：如实记一条，但**不中断**其余账号（一个坏条目不该
                // 让整池停止对账）。
                this.ctx.logger?.warn?.(`[modelscope] 账号 ${entry.id} 的凭据 ${entry.credentialRef} 不可用，跳过对账`);
                continue;
            }
            await syncAccountExpiry({
                pool,
                provider: this.product.id,
                credential,
                accessors: MODELSCOPE_EXPIRY_ACCESSORS,
                accountId: entry.id,
                current: {
                    ...entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt },
                    refreshable: entry.refreshable,
                },
                tag: '[modelscope]',
                warn: (message) => this.ctx.logger?.warn?.(message),
            });
        }
    }
    /** 凭据是否被判定为已失效（供门控与面板用）。 */
    async checkExpired(pool) {
        const status = await this.status(pool);
        if (!status.configured)
            return true;
        if (status.expiresAt === undefined)
            return false;
        return isModelscopeExpired({ access_token: '', expires_at: String(status.expiresAt) });
    }
    /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 undefined）。 */
    async readCredential(refName) {
        const resolved = await this.ctx.credentials
            .resolve(credentialRef(refName))
            .catch(() => undefined);
        if (resolved === undefined)
            return undefined;
        return parseModelscopeCredential(resolved.value);
    }
}
/** 默认凭据 ref（等价于 `MODELSCOPE.defaultCredentialRef`）。 */
export const MODELSCOPE_CREDENTIAL_REF = credentialRef(MODELSCOPE.defaultCredentialRef);
//# sourceMappingURL=modelscope-auth.js.map