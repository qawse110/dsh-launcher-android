/**
 * Jet Hub 状态持久化（账号索引 + 模型黑名单）。
 *
 * ## 为什么不能再用 settings namespace
 *
 * DSH ≤0.1.6：`ctx.settings` 是 SettingsProvider，插件用
 * `settings.register(ns, schema)` 拿到 owner scope（`get()` / `replace()`），
 * 数据落在 `$DSH_HOME/settings.yaml` 的 `jet-hub:` 段。
 *
 * DSH 0.1.7-rc.1：`ctx.settings` 换成 **SettingsForms** —— **没有 `register`**。
 * 表单命名空间只能是 **profile 条目 id**，且只投影该条目 Config 中标了
 * `.volatile()` 的字段（见 `@deepseek-ai/dsh-settings` 的 `SettingsForms`）。
 * 于是早期写法 `settings.register(...)` 在 0.1.7 上恒走
 * `typeof settings.register !== 'function'` 分支，账号列表与模型黑名单
 * **退化为纯内存**（真实缺陷：Gitee issue IKI7WT ——「DSH 0.1.7 移除
 * `settings.register()` 后，账号列表与模型黑名单无法持久化」；启动日志实证
 * `[jet-hub] settings 服务不可用，账号列表仅存在于内存中`）。
 *
 * ## 现在的策略：按能力探测两条后端
 *
 * 1. `settings.register` 可用（老 DSH）→ **沿用旧契约**，行为与数据位置完全不变；
 * 2. 否则（0.1.7+）→ 插件自有 JSON 文档 `$DSH_HOME/jet-hub/state.json`，
 *    同步读 + 原子写（tmp + rename）。
 * 3. 两者都不可用（headless / 单测替身缺服务）→ 仅内存，并**显式告警**。
 *
 * ## 为什么不把状态塞进插件 Config
 *
 * 0.1.7 的 settings 表单确实能持久化「本条目 Config 的 volatile 字段」，但
 * 账号索引与**限流重置时间戳**是运行时状态：限流每命中一次就要写一次，
 * 而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader 协调 ——
 * 把易变的运行时数据混进用户手写的配置层，代价与风险都不划算。
 * 这里与 `src/models.ts` 的 `~/.cache/deveco/*.json` 是同一思路（本插件既有的
 * 文件持久化惯例）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { hasLegacyNamespaceRegistration, readService, settingsOf } from './settings-compat.js';
/** Jet Hub schema namespace（老契约的 settings 命名空间名）。 */
export const JET_HUB_NS = 'jet-hub';
/** 老契约的 schema：必须是 schemastery（`plainSchema` 会调 `toJSON()`）。 */
const jetHubSchema = Schema.object({
    accounts: Schema.array(Schema.any()).default([]),
    disabledModels: Schema.dict(Schema.any()).default({}),
    loomyPermanentLocked: Schema.boolean().default(false),
});
/**
 * 把读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 文档可能被手工编辑过、或残留老版本格式（如数组），因此逐层校验：任何一层
 * 不是对象就丢弃那一层，只保留「provider → 模型 → true」。**只把显式 `true`
 * 视为关闭**，其余值一律忽略，避免与 `disabledModelsFor` 的判定产生分歧。
 */
export function sanitizeDisabledModels(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const result = {};
    for (const [provider, value] of Object.entries(raw)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const perProvider = {};
        for (const [modelId, flag] of Object.entries(value)) {
            if (flag === true)
                perProvider[modelId] = true;
        }
        // 空表不保留：不让文档里留下 `{ provider: {} }` 这类无意义噪音。
        if (Object.keys(perProvider).length > 0)
            result[provider] = perProvider;
    }
    return result;
}
/**
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 */
export function sanitizeAccounts(raw) {
    if (!Array.isArray(raw))
        return [];
    const accounts = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            continue;
        const candidate = entry;
        if (typeof candidate.id !== 'string' || candidate.id.length === 0)
            continue;
        if (typeof candidate.provider !== 'string' || candidate.provider.length === 0)
            continue;
        if (typeof candidate.credentialRef !== 'string' || candidate.credentialRef.length === 0)
            continue;
        accounts.push({
            ...candidate,
            enabled: candidate.enabled !== false,
            refreshable: candidate.refreshable !== false,
            nickname: typeof candidate.nickname === 'string' ? candidate.nickname : candidate.id,
            createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
        });
    }
    return accounts;
}
/** 老契约后端：数据仍在 settings 文档里（与 ≤0.1.6 完全一致）。 */
class SettingsStore {
    scope;
    kind = 'settings';
    constructor(scope) {
        this.scope = scope;
    }
    load() {
        const value = this.scope.get();
        if (value === undefined || value === null)
            return undefined;
        return {
            accounts: sanitizeAccounts(value.accounts),
            disabledModels: sanitizeDisabledModels(value.disabledModels),
            // 老文档没有该字段 → 缺省 false（解锁），与既有行为一致。
            loomyPermanentLocked: value.loomyPermanentLocked === true,
        };
    }
    async save(state) {
        await this.scope.replace({
            accounts: state.accounts,
            disabledModels: state.disabledModels,
            loomyPermanentLocked: state.loomyPermanentLocked === true,
        });
    }
}
/** 仅内存后端：两个持久化后端都不可用时的显式降级。 */
class MemoryStore {
    kind = 'memory';
    state;
    load() {
        return this.state;
    }
    async save(state) {
        this.state = state;
    }
}
/**
 * 旧凭据 ref → 账号条目的前缀表。
 *
 * 六个 provider 的账号凭据一律存 `{PREFIX}_ACCOUNT_{UUID_SHORT}`（本插件的既有
 * 约定），故可据 ref 名反推 provider。
 */
const PROVIDER_BY_REF_PREFIX = {
    CODEARTS: 'codearts',
    BUDDY: 'buddy',
    WORKBUDDY: 'workbuddy',
    LOBSTERAI: 'lobsterai',
    QODER: 'qoder',
    TRAE: 'trae',
};
/** 账号凭据 ref 形态：`{PREFIX}_ACCOUNT_{HEX}`。 */
const ACCOUNT_REF_RE = /^(CODEARTS|BUDDY|WORKBUDDY|LOBSTERAI|QODER|TRAE)_ACCOUNT_([0-9A-Fa-f]{6,})$/;
/**
 * 从 `.credentials.yaml` 的 `refs:` 段提取 ref 名（**只取键名，不读值**）。
 *
 * 判据用「缩进 ≥2 且以大写标识符开头」，并在回到顶格键时结束 —— 凭据文件是
 * 本插件**只能读不能依赖**的外部文档，故这里只做最小、保守的文本扫描，
 * 不引入 YAML 依赖（运行时不保证可解析，实证：`yaml`/`js-yaml` 从本包
 * 均不可解析）。
 */
function extractCredentialRefNames(text) {
    const names = [];
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^refs:\s*$/.test(line)) {
            inRefs = true;
            continue;
        }
        if (!inRefs)
            continue;
        if (/^\S/.test(line))
            break;
        const match = /^\s{2,}([A-Z][A-Z0-9_]*):/.exec(line);
        if (match?.[1] !== undefined)
            names.push(match[1]);
    }
    return names;
}
/** 由一个账号凭据 ref 合成账号条目（昵称缺失时退回账号 id）。 */
function accountFromCredentialRef(ref) {
    const match = ACCOUNT_REF_RE.exec(ref);
    if (match === null)
        return undefined;
    const provider = PROVIDER_BY_REF_PREFIX[match[1]];
    const suffix = match[2];
    if (provider === undefined || suffix === undefined)
        return undefined;
    const id = `${provider}-${suffix.toLowerCase()}`;
    return {
        id,
        provider,
        nickname: id,
        enabled: true,
        credentialRef: ref,
        createdAt: Date.now(),
        refreshable: true,
    };
}
/** 文件后端：`$DSH_HOME/jet-hub/state.json`（原子写）。 */
class FileStore {
    home;
    path;
    logger;
    kind = 'file';
    constructor(
    /** DSH home（状态目录与旧凭据文件都相对它定位）。 */
    home, 
    /** 状态文档绝对路径。 */
    path, logger) {
        this.home = home;
        this.path = path;
        this.logger = logger;
    }
    load() {
        try {
            if (!existsSync(this.path))
                return this.bootstrapFromCredentialRefs();
            const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
            if (typeof parsed !== 'object' || parsed === null)
                return undefined;
            const value = parsed;
            return {
                accounts: sanitizeAccounts(value.accounts),
                disabledModels: sanitizeDisabledModels(value.disabledModels),
                // 老文档没有该字段 → 缺省 false（解锁），与既有行为一致。
                loomyPermanentLocked: value.loomyPermanentLocked === true,
            };
        }
        catch (error) {
            this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，本次以空列表启动: ${String(error)}`);
            return undefined;
        }
    }
    async save(state) {
        this.write(state);
    }
    write(state) {
        mkdirSync(join(this.home, 'jet-hub'), { recursive: true });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
        renameSync(tmp, this.path);
    }
    /**
     * 首次启动的数据恢复（**仅在状态文档不存在时**执行一次）。
     *
     * 背景：0.1.7 启动时 `SettingsForms.importLegacyDocument()` 把
     * `$DSH_HOME/settings.yaml` 改名为 `settings.yaml.imported`，并按「section id
     * = profile 条目 id」逐段导入 —— `jet-hub` 不对应任何条目，该段导入失败、
     * 只留在改名后的文件里。于是老用户的账号索引成了孤儿（凭据本体仍在
     * `.credentials.yaml` 中，完好无损）。
     *
     * 这里据凭据 ref 名重建索引：能恢复「有哪些账号、属于哪个 provider、用哪个
     * credentialRef」，**恢复不了**昵称/顺序/限流时间戳（那三项只在旧 settings
     * 文档里，而本项目没有 YAML 解析依赖）。重建结果立即落盘，故只做一次。
     */
    bootstrapFromCredentialRefs() {
        const credentialsPath = join(this.home, '.credentials.yaml');
        try {
            if (!existsSync(credentialsPath))
                return undefined;
            const accounts = extractCredentialRefNames(readFileSync(credentialsPath, 'utf-8'))
                .flatMap(ref => accountFromCredentialRef(ref) ?? []);
            if (accounts.length === 0)
                return undefined;
            const state = { accounts, disabledModels: {}, loomyPermanentLocked: false };
            try {
                this.write(state);
            }
            catch (error) {
                this.logger?.warn(`[jet-hub] 恢复出的账号未能落盘（仅本次有效）: ${String(error)}`);
            }
            this.logger?.info(`[jet-hub] 已从 .credentials.yaml 恢复 ${accounts.length} 个账号`
                + '（昵称/顺序/限流标记无法恢复；旧数据仍在 settings.yaml.imported 的 jet-hub 段）');
            return state;
        }
        catch (error) {
            this.logger?.warn(`[jet-hub] 账号恢复失败（忽略）: ${String(error)}`);
            return undefined;
        }
    }
}
/**
 * 解析状态文档所在目录。
 *
 * 优先级：`DSH_JET_HUB_STATE_DIR`（单测隔离用）→ `profileContext.home`
 * → `$DSH_HOME` → `~/.dsh`。与 `dsh-home-paths` 的 `resolveDshHome` 同序。
 */
export function resolveJetHubHome(ctx) {
    const override = process.env.DSH_JET_HUB_STATE_DIR;
    if (override !== undefined && override.trim().length > 0)
        return override.trim();
    const profileHome = readService(ctx, 'profileContext')?.home;
    if (typeof profileHome === 'string' && profileHome.length > 0)
        return profileHome;
    const envHome = process.env.DSH_HOME;
    if (envHome !== undefined && envHome.trim().length > 0)
        return envHome.trim();
    return join(homedir(), '.dsh');
}
/**
 * 按能力探测创建持久化后端（见文件头）。
 *
 * 顺序刻意是「老契约优先」：在 ≤0.1.6 上必须继续把数据写在 settings 文档里，
 * 否则升级/回退版本会看到两套互不相识的数据。
 */
export function createJetHubStore(ctx) {
    const settings = settingsOf(ctx);
    if (hasLegacyNamespaceRegistration(settings) && settings !== undefined) {
        try {
            const scope = settings.register(JET_HUB_NS, jetHubSchema);
            return new SettingsStore(scope);
        }
        catch (error) {
            // 重复注册（插件热重载）等：退回文件后端，而不是降级为内存。
            ctx.logger?.warn?.(`[jet-hub] settings namespace 注册失败，改用本地状态文档: ${String(error)}`);
        }
    }
    const home = resolveJetHubHome(ctx);
    if (home === undefined) {
        ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，账号列表与模型黑名单仅存在于内存中');
        return new MemoryStore();
    }
    return new FileStore(home, join(home, 'jet-hub', 'state.json'), ctx.logger);
}
//# sourceMappingURL=jet-hub-store.js.map