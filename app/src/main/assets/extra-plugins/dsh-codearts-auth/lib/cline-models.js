/**
 * Cline 模型目录：远端拉取 + 兜底合并 + **免费判定**。
 *
 * ## 两个来源，必须都取
 *
 * | 端点 | 内容 | 认证 |
 * |---|---|---|
 * | `GET {apiBase}/api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
 * | `GET {apiBase}/api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id** | 需要 |
 *
 * ⚠️ **远端 `/models` 的 460 个 id 里根本没有 `cline-free/*`**
 * （实测 `Select-String 'cline-free/'` 零命中）。免费模型**只**由
 * `recommended-models` 下发 —— 这正是「只调 `/models` 会看不到任何免费模型」
 * 的原因，也是本模块必须同时打两个端点的理由。
 *
 * ⚠️ 内嵌兜底表**缺 `cline-free/gemini-3.8-flash`**（远端 `free` 有），
 * 反之 `/models` 有大量兜底表没有的付费模型。故正确做法是**合并**，
 * 而不是「远端失败就用兜底」的简单回退。
 *
 * ## 免费判定（不硬编码模型名）
 *
 * ```
 * isFree(id) = remoteFreeIds.has(id)        // recommended-models 的 free 数组
 *           || id.endsWith(':free')         // 内嵌目录里的 :free 条目
 *           || id.startsWith('cline-free/') // 命名约定兜底（远端未响应时）
 *           || fallbackEntry.isFree === true // 静态兜底表
 * ```
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
 * `deepseek/deepseek-v4.1-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 deepseek」之类的模糊匹配 —— 那会把付费条目误标为免费，
 * 用户按免费预期使用却被计费。
 *
 * 这一「集合动态判定、不硬编码」的做法与 CodeArts 的 benefit 集合同源
 * （见 `src/models.ts` 的 `isCodeArtsBenefitModel` 与 AGENTS.md 的对应章节）。
 */
import { clineHeaders } from './cline.js';
import { CLINE_MODELS_PATH, CLINE_RECOMMENDED_MODELS_PATH, } from './cline-product.js';
/** 单次模型目录请求超时（毫秒）。 */
export const CLINE_MODELS_TIMEOUT_MS = 20_000;
/**
 * 免费模型 id 的**后缀**约定（内嵌目录里的 21 个 `:free` 条目）。
 *
 * ⚠️ 用**后缀**而非 `includes(':free')`：`openrouter/free` 这类 id 不含冒号，
 * 而 `nvidia/…-reasoning:free` 含。后缀判定恰好覆盖两者且不会误伤
 * 形如 `foo:freebar` 的 id。
 */
const FREE_ID_SUFFIX = ':free';
/** 免费模型 id 的**前缀**约定（`cline-free/` 命名空间）。 */
const FREE_ID_PREFIX = 'cline-free/';
/**
 * 判定某 id 是否免费。
 *
 * 判定顺序无关（是并集），但保留短路以省掉集合查找。
 * `remoteFreeIds` 为远端 `free` 数组的 id 集合（**最权威**）。
 */
export function isClineFreeModel(id, remoteFreeIds = new Set(), fallback) {
    if (remoteFreeIds.has(id))
        return true;
    if (id.endsWith(FREE_ID_SUFFIX))
        return true;
    if (id.startsWith(FREE_ID_PREFIX))
        return true;
    return fallback?.isFree === true;
}
/**
 * 展示名：免费模型拼 ` · 免费`。
 *
 * ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（`dsh-client-ui-model-selection` 的 ModelSelect 里只有
 * `title: model.name` 与 `children: model.name`，**完全不读 `description`**）。
 * `description` 只在 `/model` 弹窗里用。这是被用户报障纠正过的结论
 * （「消耗倍率没有显示在切换模型列表的后面」）。
 *
 * `name` 纯属展示：DSH 的选择与持久化只用 `id`，故附加标记不会污染会话历史。
 */
export function clineDisplayName(model) {
    return model.isFree ? `${model.name} · 免费` : model.name;
}
/** 从远端 id 派生一个可读的兜底展示名（远端只给 id 时用）。 */
function nameFromId(id) {
    // 去掉 provider 命名空间前缀，让列表更易读（`deepseek/deepseek-v4.1-flash`
    // → `deepseek-v4.1-flash`）。保留原始 id 作为 id，展示名只求可读。
    const slash = id.indexOf('/');
    const tail = slash >= 0 ? id.slice(slash + 1) : id;
    return tail.replace(FREE_ID_SUFFIX, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
/** 把远端数组里的条目归一化（丢弃无 id 的垃圾项）。 */
function parseEntryList(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id.length === 0)
            continue;
        const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : undefined;
        const description = typeof record.description === 'string' && record.description.trim().length > 0
            ? record.description.trim()
            : undefined;
        out.push({ id, ...name === undefined ? {} : { name }, ...description === undefined ? {} : { description } });
    }
    return out;
}
/**
 * 解析 `recommended-models` 响应。
 *
 * ⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型
 * （`cline-pass/*`），按订阅额度计费而非免费。把它当免费会误导用户。
 */
export function parseClineRecommendedModels(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { free: [], recommended: [], clinePass: [] };
    }
    const record = value;
    return {
        free: parseEntryList(record.free),
        recommended: parseEntryList(record.recommended),
        clinePass: parseEntryList(record.clinePass),
    };
}
/** 解析 `/api/v1/models` 响应，取出 id 列表。 */
export function parseClineRemoteModelIds(value) {
    if (typeof value !== 'object' || value === null)
        return [];
    const data = value.data;
    if (!Array.isArray(data))
        return [];
    const ids = [];
    for (const item of data) {
        if (typeof item !== 'object' || item === null)
            continue;
        const id = item.id;
        if (typeof id === 'string' && id.trim().length > 0)
            ids.push(id.trim());
    }
    return ids;
}
/**
 * 合并三个来源为最终目录。
 *
 * 顺序（决定列表展示顺序）：
 * 1. **免费模型在前**（用户最关心；且远端 `free` 数组本身就有序）；
 * 2. 兜底表里其余条目（保持表内顺序，提供元数据）；
 * 3. 远端 `/models` 的其余 id（**放最后**，它们只有裸 id、无元数据，
 *    且数量达 460 个 —— 放前面会把免费模型挤到看不见）。
 *
 * 元数据优先级：兜底表（有 `contextWindow` / `maxTokens` / `capabilities`）
 * > 远端 `free`/`recommended` 的 `description`/`name` > 由 id 派生的名字。
 */
export function mergeClineModels(product, remote) {
    const fallbackIndex = new Map(product.fallbackModels.map((model) => [model.id, model]));
    const remoteFreeIds = new Set(remote.freeIds);
    const entryIndex = new Map(remote.entries.map((entry) => [entry.id, entry]));
    const seen = new Set();
    const out = [];
    /** 由 id + 各处元数据构造条目。 */
    const build = (id) => {
        const fallback = fallbackIndex.get(id);
        const entry = entryIndex.get(id);
        const name = fallback?.name ?? entry?.name ?? nameFromId(id);
        const description = entry?.description ?? fallback?.description;
        return {
            id,
            name,
            isFree: isClineFreeModel(id, remoteFreeIds, fallback),
            ...fallback?.contextWindow === undefined ? {} : { contextWindow: fallback.contextWindow },
            ...fallback?.maxTokens === undefined ? {} : { maxTokens: fallback.maxTokens },
            ...fallback?.supportsImage === undefined ? {} : { supportsImage: fallback.supportsImage },
            ...description === undefined ? {} : { description },
        };
    };
    const push = (id) => {
        if (seen.has(id))
            return;
        seen.add(id);
        out.push(build(id));
    };
    // 1) 远端 `free` 数组（最权威的免费集合，且顺序有意义）。
    for (const id of remote.freeIds)
        push(id);
    // 2) 兜底表（含内嵌目录补充的 gemini-3.8-flash，离线时也可见）。
    for (const model of product.fallbackModels)
        push(model.id);
    // 3) `recommended` / `clinePass` 里出现但上面没覆盖的（保持可发现性）。
    for (const entry of remote.entries)
        push(entry.id);
    // 4) 远端 `/models` 的其余 id（数量大，放最后）。
    for (const id of remote.remoteIds)
        push(id);
    return out;
}
/**
 * 拉取远端模型数据。
 *
 * **两个端点独立容错**：`recommended-models` 失败不应让 `/models` 的结果作废
 * （反之亦然）。任一端点挂掉时只记 warning，由 `mergeClineModels` 用兜底表
 * 补齐 —— 这样「目录服务抖动」不会让用户的模型列表整个消失。
 *
 * `recommended-models` **不需要认证**（实测匿名 200），故它可以在凭据缺失时
 * 单独调用（供只读探针与首启场景使用）。
 */
export async function fetchClineRemoteModels(product, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const warnings = [];
    const recommendedPromise = (async () => {
        try {
            const response = await fetcher(`${product.apiBase}${CLINE_RECOMMENDED_MODELS_PATH}`, {
                method: 'GET',
                headers: { Accept: 'application/json', ...product.clientHeaders },
                signal: options.signal ?? AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
            });
            if (!response.ok) {
                warnings.push(`recommended-models HTTP ${response.status}`);
                return { free: [], recommended: [], clinePass: [] };
            }
            return parseClineRecommendedModels(await response.json());
        }
        catch (error) {
            warnings.push(`recommended-models ${error instanceof Error ? error.message : String(error)}`);
            return { free: [], recommended: [], clinePass: [] };
        }
    })();
    const modelsPromise = (async () => {
        // 无凭据时不发 `/models`：它需要认证，匿名调用必然 401，
        // 只会白白产生一条 warning。
        if (options.credential === undefined)
            return [];
        try {
            const response = await fetcher(`${product.apiBase}${CLINE_MODELS_PATH}`, {
                method: 'GET',
                headers: clineHeaders(options.credential, product),
                signal: options.signal ?? AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
            });
            if (!response.ok) {
                warnings.push(`models HTTP ${response.status}`);
                return [];
            }
            return parseClineRemoteModelIds(await response.json());
        }
        catch (error) {
            warnings.push(`models ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    })();
    const [recommended, remoteIds] = await Promise.all([recommendedPromise, modelsPromise]);
    return {
        freeIds: recommended.free.map((entry) => entry.id),
        remoteIds,
        // `recommended` 与 `clinePass` 都进 entries：前者让推荐模型拿到
        // description，后者保证订阅制模型也能在列表里被发现（它们不是免费，
        // 但用户可能在 Cline 里已订阅）。
        entries: [...recommended.free, ...recommended.recommended, ...recommended.clinePass],
        warnings,
    };
}
/**
 * 完整目录：远端 + 兜底合并。
 *
 * 供适配器的 `listAllModels()`（设置页）与 `listModels()`（选择器）共用，
 * 保证两处看到同一份数据。
 */
export async function loadClineModels(product, options = {}) {
    const remote = await fetchClineRemoteModels(product, options);
    return { models: mergeClineModels(product, remote), warnings: remote.warnings };
}
//# sourceMappingURL=cline-models.js.map