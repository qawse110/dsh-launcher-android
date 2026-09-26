/**
 * Raccoon Work LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder 与 loomy；
 * raccoon 是第三个消费者。若实测发现字段形态不符，应在**本文件**内做局部适配，
 * 而不是改共享层（那会影响另外两个 provider 的既有行为）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isRaccoonExpired } from './raccoon.js';
import { RACCOON } from './raccoon-product.js';
import { collectImages, consumeOpenAiSse, errorDetail, httpErrorCode, isTransportError, serializeMessages, } from './openai-compat.js';
/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export const PROVIDER = 'raccoon';
/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** 兜底表条目转远端形状。 */
function fallbackToRemote(model) {
    return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        // 兜底表**声明**图片能力（它有该字段）；与 loomy 不同（那边兜底表没有该信息）。
        supportsImage: model.supportsImage,
    };
}
/** Raccoon Work 模型适配器。 */
export class RaccoonAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 兜底模型索引（id → 条目）。 */
    fallbackIndex;
    /** 远端模型缓存；未拉取时为 undefined。 */
    remoteModels;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? RACCOON;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]));
    }
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串，直接回退到本产品的 id。
     */
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /**
     * 完整目录（**不套黑名单**），带最终展示名。
     *
     * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
     * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
     */
    listAllModels() {
        const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote);
        return source.map((model) => ({ id: model.id, name: model.name }));
    }
    /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
    async loadModels() {
        if (this.remoteModels !== undefined)
            return this.remoteModels;
        if (this.options.fetchRemoteModels !== undefined) {
            try {
                const fetched = await this.options.fetchRemoteModels();
                if (fetched.length > 0) {
                    this.remoteModels = fetched;
                    return fetched;
                }
            }
            catch {
                // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
            }
        }
        const fallback = this.product.fallbackModels.map(fallbackToRemote);
        this.remoteModels = fallback;
        return fallback;
    }
    inputModalitiesFor(model) {
        return model?.supportsImage === true ? ['text', 'image'] : ['text'];
    }
    async listModels(_provider) {
        // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
        // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
        // failures，界面上反而多一条 provider 报错）。
        if (!await providerCatalogVisible(this.options.accountPool, this.product.id))
            return [];
        const all = await this.loadModels();
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const listed = disabled === undefined || disabled.size === 0
            ? all
            : all.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
            name: model.name,
            inputModalities: this.inputModalitiesFor(model),
        }));
    }
    async resolveModel(provider, model, _signal) {
        const all = await this.loadModels();
        const entry = all.find((item) => item.id === model);
        const fallback = this.fallbackIndex.get(model);
        // ⚠️ name **不带倍率**（与 qoder/trae/loomy 一致）：价格只属于选择列表语境。
        const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model;
        const resolved = {
            provider,
            id: model,
            name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
            inputModalities: this.inputModalitiesFor(entry),
        };
        const contextWindow = entry?.contextWindow ?? fallback?.contextWindow;
        // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
        if (contextWindow !== undefined && contextWindow > 0) {
            resolved.context = { contextWindow };
        }
        // ⚠️ 远端非法值必须过滤（见 positiveMaxTokens）：不声明就让 DSH 用默认值。
        const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens);
        if (maxTokens !== undefined)
            resolved.defaultMaxTokens = maxTokens;
        return resolved;
    }
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法。与其余适配器同款 shim。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
        // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
        // 声明支持就必须真支持。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        const all = await this.loadModels();
        const entry = all.find((item) => item.id === options.model);
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!this.inputModalitiesFor(entry).includes('image')) {
                throw new LlmError(`raccoon: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('raccoon: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
            }
            // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
            // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
            imageUrls = new Map();
            for (const [id, ref] of imageRefs) {
                const image = await this.options.readImage(ref);
                if (image === undefined)
                    continue;
                imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
            }
        }
        // 1. 取凭据（过期则先续期）
        let credential = await this.options.resolveCredential();
        if (credential === undefined || isRaccoonExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('raccoon: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        const messages = serializeMessages(options.messages, imageUrls);
        /**
         * 前置 system 消息（若有）。
         *
         * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
         * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
         */
        const wireMessages = options.system !== undefined && options.system.length > 0
            ? [{ role: 'system', content: options.system }, ...messages]
            : messages;
        /** 构造请求体。 */
        const buildBody = () => JSON.stringify({
            model: options.model,
            messages: wireMessages,
            stream: true,
            ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
            ...options.temperature !== undefined ? { temperature: options.temperature } : {},
            ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
            // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
            // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
            ...options.tools !== undefined && options.tools.length > 0
                ? {
                    tools: options.tools.map((tool) => ({
                        type: 'function',
                        function: {
                            name: tool.name,
                            ...tool.description.length > 0 ? { description: tool.description } : {},
                            ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
                        },
                    })),
                }
                : {},
        });
        const headers = () => ({
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential?.access_token ?? ''}`,
            'X-Org-Code': credential?.office_identity ?? '',
            'X-Raccoon-Language': 'zh',
            'X-Client-Platform': this.product.clientPlatform,
        });
        /** 发送一次 chat 请求。 */
        const send = async () => {
            try {
                return await this.fetchImpl(`${this.product.apiBase}${this.product.llmApiPrefix}/chat/completions`, {
                    method: 'POST',
                    headers: headers(),
                    body: buildBody(),
                    signal: options.signal,
                });
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw error;
                if (isTransportError(error)) {
                    throw new LlmError(`raccoon: transport error: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error });
                }
                throw error;
            }
        };
        let response = await send();
        // 401/403 时续期一次并重试（raccoon 有 refresh_token 轮换）。
        if (response.status === 401 || response.status === 403) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('raccoon: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            credential = refreshed;
            response = await send();
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new LlmError(`raccoon: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
        }
        // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
        yield* consumeOpenAiSse(response, { signal: options.signal }, {
            label: 'raccoon',
            firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
            chunkTimeoutMs: resolveChunkTimeoutMs(),
        });
    }
}
/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs() {
    const raw = Number(process.env.DSH_RACCOON_FIRST_TOKEN_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}
/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs() {
    const raw = Number(process.env.DSH_RACCOON_CHUNK_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}
/**
 * 在 `ctx.llm` 上注册 raccoon provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerRaccoonLlm(ctx, options) {
    const product = options.product ?? RACCOON;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new RaccoonAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    return adapter;
}
//# sourceMappingURL=raccoon-adapter.js.map