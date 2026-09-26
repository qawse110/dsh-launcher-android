/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * 实测（2026-09-26）`POST {apiBase}/chat/completions` 是**标准 OpenAI 兼容
 * + 标准 SSE**：`data:` 帧 + 空 `data:` 终止帧，思考在 `delta.reasoning_content`，
 * **无加密、无信封、无格式转换**。与 qoder 同形，故消息序列化与 SSE 消费
 * 直接复用 `src/openai-compat.ts` —— 那是为这种形态抽的共享层，
 * **新增** provider 用它正是其设计意图（AGENTS.md 只禁止拿它去重构
 * buddy/lobsterai 的既有实现）。
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isLoomyChatModel, isLoomyExpired, loomyChatHeaders, loomyDisplayName, splitLoomyRate, } from './loomy.js';
import { LOOMY } from './loomy-product.js';
import { collectImages, consumeOpenAiSse, errorDetail, httpErrorCode, isTransportError, serializeMessages, } from './openai-compat.js';
/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export const PROVIDER = 'loomy';
/** 把 `capabilities.input_modalities` 读成小写字符串数组。 */
function readInputModalities(entry) {
    const capabilities = entry.capabilities;
    if (typeof capabilities !== 'object' || capabilities === null)
        return [];
    const raw = capabilities.input_modalities;
    if (!Array.isArray(raw))
        return [];
    return raw.filter((item) => typeof item === 'string').map((item) => item.toLowerCase());
}
/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export function parseLoomyRemoteModels(payload) {
    const list = Array.isArray(payload)
        ? payload
        : (typeof payload === 'object' && payload !== null
            && Array.isArray(payload.data)
            ? payload.data
            : []);
    const models = [];
    for (const item of list) {
        if (!isLoomyChatModel(item))
            continue;
        const entry = item;
        const id = String(entry.id);
        const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id;
        const contextWindow = Number(entry.context_length);
        const capabilities = typeof entry.capabilities === 'object' && entry.capabilities !== null
            ? entry.capabilities
            : {};
        models.push({
            id,
            name: loomyDisplayName(rawName),
            contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
            supportsImage: readInputModalities(entry).includes('image'),
            supportsThinking: capabilities.reasoning === true,
        });
    }
    return models;
}
/** 兜底表条目转远端形状。 */
function fallbackToRemote(model) {
    return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        // 兜底表不声明图片能力：宁可少报（用户改用文本描述），
        // 也不要报一个服务端可能不认的模态。
        supportsImage: false,
        supportsThinking: true,
    };
}
/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export class LoomyAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 兜底模型索引（id → 条目）。 */
    fallbackIndex;
    /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
    remoteModels;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? LOOMY;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]));
    }
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
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
        // ⚠️ name **不带倍率**（与 qoder/trae 一致）：价格只属于选择列表语境。
        const bareName = fallback !== undefined ? splitLoomyRate(fallback.name).name : model;
        const resolved = {
            provider,
            id: model,
            name: entry !== undefined ? splitLoomyRate(entry.name).name : bareName,
            inputModalities: this.inputModalitiesFor(entry),
        };
        const contextWindow = entry?.contextWindow ?? fallback?.contextWindow;
        // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
        if (contextWindow !== undefined && contextWindow > 0) {
            resolved.context = { contextWindow };
        }
        return resolved;
    }
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 图片能力按**模型**判定。这里**不能**放宽成「总是接受」：DSH 在
        // LlmRuntime 里按适配器播报的 `inputModalities` 决定要不要把图片投影成
        // 文本占位符，声明支持就必须真支持。
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
                throw new LlmError(`loomy: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('loomy: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
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
        // 1. 取凭据（过期则先尝试探测/刷新）
        //
        // ⚠️ **必须把模型 id 传给选号器**：Loomy 的选号要先按「该模型是否受限」
        // 过滤账号（限流按模型记），再按余额分档。传空串会让模型级限流失效。
        let credential = await this.options.resolveCredential(options.model);
        if (credential === undefined || isLoomyExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential(options.model);
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('loomy: no usable credential; log in first', 'MISSING_CREDENTIAL');
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
        /** 发送一次 chat 请求。 */
        const send = async (token) => {
            try {
                return await this.fetchImpl(`${this.product.apiBase}/chat/completions`, {
                    method: 'POST',
                    // ⚠️ chat 端点只认 Bearer（业务端点才认 token），这里两个都发。
                    headers: loomyChatHeaders(token),
                    body: buildBody(),
                    signal: options.signal,
                });
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw error;
                if (isTransportError(error)) {
                    throw new LlmError(`loomy: transport error: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error });
                }
                throw error;
            }
        };
        let response = await send(credential.access_token);
        // 401/403 时尝试刷新一次（Loomy 无 refresh 端点，故这里多半会抛错，
        // 但保留该路径以便将来上游开放续期时自动受益）。
        if (response.status === 401 || response.status === 403) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('loomy: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            response = await send(refreshed.access_token);
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
        }
        // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
        yield* consumeOpenAiSse(response, { signal: options.signal }, {
            label: 'loomy',
            firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
            chunkTimeoutMs: resolveChunkTimeoutMs(),
        });
    }
}
/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs() {
    const raw = Number(process.env.DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}
/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs() {
    const raw = Number(process.env.DSH_LOOMY_CHUNK_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}
/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerLoomyLlm(ctx, options) {
    const product = options.product ?? LOOMY;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new LoomyAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    return adapter;
}
//# sourceMappingURL=loomy-adapter.js.map