/**
 * Cline LLM 适配器。
 *
 * ## 与既有 provider 的差异
 *
 * Cline 的推理端点是**标准 OpenAI 兼容**的
 * （`POST {apiBase}/api/v1/chat/completions`，实测标准 SSE），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 Qoder 同做法。
 *
 * 差异只有三处：
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`**（前缀不可剥，见 `src/cline.ts`）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `delta.reasoning_content`）——
 *    已由 `consumeOpenAiSse` 同时兼容；
 * 3. **模型目录来自两个端点**（`recommended-models` 给 free 集合、
 *    `/models` 给全量 id），见 `src/cline-models.ts`。
 *
 * ## 免费标注
 *
 * 免费模型在 `name` 里拼 ` · 免费`。⚠️ **必须写进 `name` 而非 `description`**：
 * composer 的模型切换菜单只渲染 `name`（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`）。
 * 这是被用户报障纠正过的结论。
 *
 * ⚠️ 免费资格是**服务端动态下发**的（`recommended-models` 的 `free` 数组），
 * 故本适配器**不硬编码任何免费模型名** —— 与 CodeArts benefit 集合同约定。
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isClineExpired, clineHeaders } from './cline.js';
import { clineDisplayName, loadClineModels, } from './cline-models.js';
import { CLINE, CLINE_CHAT_PATH, CLINE_DEFAULT_REASONING_EFFORT, CLINE_REASONING_EFFORTS, } from './cline-product.js';
import { collectImages, consumeOpenAiSse, errorDetail, httpErrorCode, isTransportError, serializeMessages, } from './openai-compat.js';
/** 本适配器注册的 provider 路由名（等价于 `CLINE.id`）。 */
export const PROVIDER = 'cline';
/** 换号次数上限（对齐 buddy / lobsterai / trae 的 `MaxRotate = 3`）。 */
const CLINE_MAX_ROTATE = 3;
/**
 * 单次请求输出上限的安全边界。
 *
 * ⚠️ 与 TRAE 的 `clampTraeMaxTokens` 同因：上游网关对超大 `max_tokens`
 * 会直接 4xx，而 DSH 可能注入一个来自其它 provider 的大值。
 * Cline 内嵌目录里最大的 `maxTokens` 是 **943718**
 * （`muse-spark-1.3-contributor`），故上界取它 —— 不自行编造更大的值。
 */
const CLINE_MAX_OUTPUT_TOKENS = 943_718;
/** 收敛输出上限到安全区间；非法值返回 undefined（不编造）。 */
function clampClineMaxTokens(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    const integer = Math.floor(value);
    if (integer <= 0)
        return undefined;
    return Math.min(integer, CLINE_MAX_OUTPUT_TOKENS);
}
/**
 * 清洗工具参数 schema 里的 `enum`（递归）。
 *
 * ## 为什么必须清洗（实测 400，用户报障 2026-09-25）
 *
 * harness 下发的工具集里，某些参数的 `enum` 含**空字符串**成员。Gemini 系模型
 * （经 `google` / `vertex` provider）对此**严格校验**，直接拒绝整个请求：
 *
 * ```
 * GenerateContentRequest.tools[0].function_declarations[34]
 *   .parameters.properties[permission].enum[3]: cannot be empty
 * ```
 *
 * ⚠️ 该错误**只在部分 provider 上暴露**：上游一次请求会依次尝试多个 provider，
 * 实测命中 vertex 时报「maxOutputTokens 越界」、命中 google 时报上述 enum 错误。
 * 两者是**两个独立根因**，都要修，否则路由一漂移就复发。
 *
 * ⚠️ 本适配器**从不自己造 enum** —— `stream()` 原样透传
 * `options.tools[].parameters`，故脏数据来自上游 harness。但请求是我们发的，
 * 只能在我们这一侧拦住。
 *
 * ## 三条边界（都要守）
 *
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法的数值枚举整段丢掉；
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`；
 * - **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪。
 */
export function sanitizeClineToolParameters(value) {
    if (Array.isArray(value))
        return value.map(sanitizeClineToolParameters);
    if (value === null || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (key === 'enum' && Array.isArray(raw)) {
            const cleaned = raw.filter((item) => !(typeof item === 'string' && item.trim().length === 0));
            if (cleaned.length > 0)
                out[key] = cleaned;
            continue;
        }
        out[key] = sanitizeClineToolParameters(raw);
    }
    return out;
}
/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs() {
    return Number.parseInt(process.env.DSH_CLINE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_CLINE_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000;
}
/**
 * Cline 模型适配器。
 *
 * 使用 `Bearer workos:<jwt>` 鉴权，仅支持 SSE（与官方客户端一致）。
 */
export class ClineAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 远端模型目录缓存（首次成功后填充）。 */
    remoteModels;
    /** 正在进行中的目录加载（避免并发重复请求）。 */
    loading;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? CLINE;
        this.fetchImpl = options.fetchImpl ?? fetch;
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
    /**
     * 模型接受的输入模态。
     *
     * 按**模型**判定（内嵌目录的 `capabilities` 含 `images`），不是按 provider
     * 一刀切。未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会失败）。
     */
    inputModalitiesFor(model) {
        const entry = this.remoteModels?.find((candidate) => candidate.id === model);
        return entry?.supportsImage === true ? ['text', 'image'] : ['text'];
    }
    /**
     * 懒加载远端模型目录。
     *
     * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
     * 此时同样触发远端拉取。
     *
     * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
     * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
     */
    async ensureRemoteModels() {
        if (this.remoteModels !== undefined)
            return;
        if (this.loading !== undefined) {
            await this.loading;
            return;
        }
        this.loading = (async () => {
            try {
                const credential = await this.options.resolveCredential();
                const load = this.options.loadModels ?? ((opts) => loadClineModels(this.product, {
                    ...opts.credential === undefined ? {} : { credential: opts.credential },
                    fetcher: this.fetchImpl,
                }));
                const { models, warnings } = await load({
                    ...credential === undefined ? {} : { credential },
                });
                if (models.length > 0)
                    this.remoteModels = models;
                // 目录部分失败时留下日志：静默降级会让用户看到「少了模型」却无从排查
                // （两个端点独立容错，故这里只记 warning 不抛错）。
                for (const warning of warnings) {
                    // eslint-disable-next-line no-console
                    console.warn(`[cline] 模型目录来源失败：${warning}`);
                }
            }
            catch (error) {
                // 拉取失败保持未定义，后续 listModels/resolveModel 仍回退静态兜底表。
                // eslint-disable-next-line no-console
                console.warn(`[cline] 模型目录拉取失败：${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                this.loading = undefined;
            }
        })();
        await this.loading;
    }
    /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
    fallbackCatalog() {
        return this.product.fallbackModels.map((model) => ({
            id: model.id,
            name: model.name,
            isFree: model.isFree === true,
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            ...model.supportsImage === undefined ? {} : { supportsImage: model.supportsImage },
            ...model.description === undefined ? {} : { description: model.description },
        }));
    }
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     *
     * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
     * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
     * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
     * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
     * 故实际使用中不会读到空目录。
     */
    listAllModels() {
        const source = this.remoteModels ?? this.fallbackCatalog();
        if (this.remoteModels === undefined)
            void this.ensureRemoteModels();
        return source.map((model) => ({ id: model.id, name: clineDisplayName(model) }));
    }
    async listModels(_provider) {
        // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
        // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
        // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
        // 界面上反而多出一条 provider 报错）。
        //
        // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
        // 不必拉。
        if (!await providerCatalogVisible(this.options.accountPool, this.product.id))
            return [];
        // 必须 await：冷缓存时目录尚未落地就返回，模型选择器会短暂显示错误的
        // 模型集合（Jet Hub 的模型开关也据此渲染）。
        await this.ensureRemoteModels();
        const source = this.remoteModels ?? this.fallbackCatalog();
        // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
        // 只影响此处对外播报的模型目录，不改变 resolveModel/stream 的路由能力
        // ——与 DSH 对 listModels 的约定一致（目录是建议性的，缺省不构成拒绝）。
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const listed = disabled === undefined || disabled.size === 0
            ? source
            : source.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            // 免费标记拼进 `name`（**不是** `description`）：composer 的模型切换菜单
            // 只渲染 name，description 仅用于 /model 弹窗。
            name: clineDisplayName(model),
            ...model.description === undefined ? {} : { description: model.description },
            inputModalities: this.inputModalitiesFor(model.id),
        }));
    }
    async resolveModel(provider, model, _signal) {
        await this.ensureRemoteModels();
        const source = this.remoteModels ?? this.fallbackCatalog();
        const entry = source.find((candidate) => candidate.id === model);
        const resolved = {
            provider,
            id: model,
            // ⚠️ `resolveModel` 的 `name` **不带**免费标记（与 Qoder/TRAE 一致）：
            // 标记只属于「选择列表」语境；会话记录里带上它会污染历史展示。
            name: entry?.name ?? model,
            inputModalities: this.inputModalitiesFor(model),
        };
        // 上下文窗口：远端/兜底表已知时才声明（未知时不编造，让 DSH 用默认值）。
        if (entry?.contextWindow !== undefined)
            resolved.context = { contextWindow: entry.contextWindow };
        // 单次输出上限：必须声明为 `defaultMaxTokens`，否则 DSH 只在调用方显式
        // 给值时才下发 `max_tokens`，上限永久退回网关默认值
        //（这正是 buddy 那条「回答在 32000 token 处被截断」的根因）。
        const maxTokens = clampClineMaxTokens(entry?.maxTokens);
        if (maxTokens !== undefined)
            resolved.defaultMaxTokens = maxTokens;
        // 思考档位：对**所有**模型统一声明（远端不下发档位，见产品配置注释）。
        // 这是 composer 里「思考强度」选择器的唯一入口 —— 不声明则 UI 显示
        // 「当前模型未提供推理等级」。
        resolved.reasoning = {
            efforts: CLINE_REASONING_EFFORTS.map((effort) => ({
                id: ReasoningEffortId(effort.id),
                name: effort.name,
            })),
            defaultEffort: ReasoningEffortId(CLINE_DEFAULT_REASONING_EFFORT),
        };
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
        // 图片能力按**模型**判定（内嵌目录 capabilities）。
        //
        // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
        // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!this.inputModalitiesFor(options.model).includes('image')) {
                throw new LlmError(`cline: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('cline: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
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
        // 1. 获取凭据（过期则先静默续期）
        let credential = await this.options.resolveCredential();
        if (credential === undefined || isClineExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('cline: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // 2. 构造 OpenAI 请求体（复用共享序列化，含 0.1.7 消息形状归一化）
        const messages = serializeMessages(options.messages, imageUrls);
        const bodyObj = {
            model: options.model,
            messages: options.system !== undefined && options.system.length > 0
                ? [{ role: 'system', content: options.system }, ...messages]
                : messages,
            stream: true,
        };
        if (options.tools !== undefined && options.tools.length > 0) {
            bodyObj.tools = options.tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    // ⚠️ parameters 必须清洗后再下发：harness 的工具 schema 里可能带
                    // 空串 `enum` 成员，Gemini 系会直接 400（见 sanitizeClineToolParameters）。
                    parameters: sanitizeClineToolParameters(tool.parameters),
                },
            }));
        }
        if (options.temperature !== undefined)
            bodyObj.temperature = options.temperature;
        const maxTokens = clampClineMaxTokens(options.maxTokens);
        if (maxTokens !== undefined)
            bodyObj.max_tokens = maxTokens;
        if (options.stop !== undefined && options.stop.length > 0)
            bodyObj.stop = options.stop;
        // 推理强度：DSH 注入的 `reasoningEffort` 原样透传给上游的 `reasoning_effort`。
        //
        // ⚠️ **这里绝不能加白名单校验**。档位表（`CLINE_REASONING_EFFORTS`）是客户端
        // 内嵌目录的快照，会随 Cline 版本变化；校验等于把上游新增的档位静默丢弃。
        // 且上游对**完全不认识**的档位也只是静默忽略 —— 实测
        // `reasoning_effort: 'banana'` 返回 HTTP 200、思考量为 0，**不报错**，
        // 故白名单既无必要也无收益。
        if (options.reasoningEffort !== undefined) {
            bodyObj.reasoning_effort = options.reasoningEffort;
        }
        const body = JSON.stringify(bodyObj);
        // 3. 发送请求（401/403 时刷新一次凭据后重试）
        //
        // ⚠️ **403 必须先排除「地域限制」**：它与凭据无关，续期在这里永远无用，
        // 且最终会被归成 AUTH（UI 显示「API 密钥无效」），真实原因彻底丢失。
        // 命中时直接抛出带真实原因的错误（见 isClineRegionForbidden）。
        let currentAccountId = '';
        let response = await this.send(credential, body, options);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            const forbiddenText = await response.text().catch(() => '');
            if (isClineRegionForbidden(response.status, forbiddenText)) {
                throw new LlmError(`cline: ${errorDetail(forbiddenText)}`, 'PERMISSION_DENIED', { status: response.status });
            }
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('cline: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            credential = refreshed;
            response = await this.send(credential, body, options);
        }
        // 4. 非 2xx：限流时换号重试，其余如实报错。
        //
        // ⚠️ 与 buddy / lobsterai 一致：只有**限流**才换号。Cline 的账号额度是
        // 账户级余额（`/balance`），余额耗尽属于 `hard-credit` 语义，
        // 也值得换号 —— 两者都用状态码 429 / 402 + 文案判定。
        if (!response.ok) {
            let errorText = await response.text().catch(() => '');
            const shouldRotate = isClineRotatableFailure(response.status, errorText);
            if (this.options.accountPool !== undefined && shouldRotate) {
                const tried = new Set();
                if (currentAccountId.length > 0)
                    tried.add(currentAccountId);
                const maxRotate = CLINE_MAX_ROTATE - 1;
                for (let round = 0; round < maxRotate; round++) {
                    if (currentAccountId.length > 0 && recordsClineRateLimit(response.status, errorText)) {
                        await this.options.accountPool.updateModelRateLimit(currentAccountId, options.model, Date.now() + CLINE_RATE_LIMIT_FALLBACK_MS);
                    }
                    const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried);
                    if (next === null || next === undefined || tried.has(next.entry.id))
                        break;
                    tried.add(next.entry.id);
                    credential = next.credential;
                    currentAccountId = next.entry.id;
                    response = await this.send(credential, body, options);
                    if (response.ok) {
                        yield* this.consume(response, options);
                        return;
                    }
                    errorText = await response.text().catch(() => '');
                    if (!isClineRotatableFailure(response.status, errorText))
                        break;
                }
                throw new LlmError(`cline: 模型 ${options.model} 的所有账号均不可用（限流或额度耗尽），请稍后再试`, 'QUOTA_EXCEEDED');
            }
            throw new LlmError(`cline: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
        }
        // 5. 消费 SSE 流
        yield* this.consume(response, options);
    }
    /** 消费 OpenAI 兼容 SSE（共享实现）。 */
    consume(response, options) {
        return consumeOpenAiSse(response, { ...options.signal === undefined ? {} : { signal: options.signal } }, {
            label: 'cline',
            firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
            chunkTimeoutMs: resolveChunkTimeoutMs(),
        });
    }
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    async send(credential, body, options) {
        try {
            return await this.fetchImpl(`${this.product.apiBase}${CLINE_CHAT_PATH}`, {
                method: 'POST',
                // ⚠️ 头里的 Authorization 必须是**带 workos: 前缀**的值
                //（见 src/cline.ts 的 clineBearerValue 注释）。
                headers: {
                    ...clineHeaders(credential, this.product),
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body,
                signal: options.signal,
            });
        }
        catch (error) {
            if (options.signal?.aborted === true)
                throw error;
            if (isTransportError(error)) {
                throw new LlmError(`cline: transport error: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error });
            }
            throw error;
        }
    }
}
/** 限流标记的兜底时长（1 小时；与 buddy / lobsterai 同口径）。 */
const CLINE_RATE_LIMIT_FALLBACK_MS = 3_600_000;
/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy 系一致：429（频率限制）与 402（额度耗尽）。
 * 其余错误（400 请求格式错、5xx 服务端故障）换号也无用 ——
 * 5xx 是所有账号共用的服务端问题，400 是请求本身的问题。
 */
export function isClineRotatableFailure(status, body) {
    if (status === 429 || status === 402)
        return true;
    const lower = body.toLowerCase();
    return CLINE_CREDIT_MARKERS.some((marker) => lower.includes(marker));
}
/**
 * 额度/限流文案标记。
 *
 * 中英双通道：Cline 是国际产品，但用户账号可能是中文界面，
 * 且网关在不同层可能给出不同文案。
 */
export const CLINE_CREDIT_MARKERS = [
    'insufficient', 'quota', 'rate limit', 'too many requests', 'balance',
    'credit', 'payment required', 'exceeded',
    '积分不足', '额度不足', '余额不足', '频率限制', '超出限制',
];
/**
 * 该失败是否应**记为模型的限流标记**（让 UI 亮出「限额重置」徽章）。
 *
 * 只覆盖真正表达「这个模型/账号此刻不可用」的状态码：429 与 402。
 * 文案命中的 4xx（如 400 + 含 "credit" 的措辞）**不记徽章** ——
 * 徽章的含义必须是「受限」，而不是「这个账号出过错」
 * （与 `recordsLobsteraiRateLimit` 同约定）。
 */
export function recordsClineRateLimit(status, _body) {
    return status === 429 || status === 402;
}
/**
 * 该失败是否是**与凭据无关的访问限制**（地域封锁 / 模型未开通）。
 *
 * ## 为什么必须单独识别（真实缺陷，用户报障 2026-09-25）
 *
 * Cline 对「该地区不可用」的模型返回 **403**，而 401/403 在本适配器里原本一律
 * 被当作「凭据过期」：触发续期 → 重试 → 仍 403 → 最终 `httpErrorCode(403)`
 * 归成 `AUTH` → DSH 渲染成「**API 密钥无效**」。
 *
 * 实测 `cline-free/muse-spark-1.3-contributor`：
 *
 * ```
 * 403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
 *       is not available in your region","success":false}
 * ```
 *
 * 后果有两个：① 真实原因（地域限制）被完全掩盖，用户以为要去重新登录；
 * ② 每次请求都白跑一次续期（续期还会成功，所以不会提前报错，纯属浪费）。
 *
 * ⚠️ **不能按状态码一刀切**：同一批 403 里既有真的凭据问题，也有地域限制，
 * 只能靠**响应体文案**区分。认三种表述（上游措辞可能微调，故取特征词）：
 * `not available in your region` / `access forbidden` / `region not supported`。
 *
 * ⚠️ 命中时**跳过续期**，并让错误文案带出真实原因 —— 续期在这里永远无用，
 * 反而拖慢失败反馈。
 */
export function isClineRegionForbidden(status, body) {
    if (status !== 403)
        return false;
    const lower = body.toLowerCase();
    return CLINE_REGION_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker));
}
/** 地域/访问限制文案标记（小写比对）。 */
const CLINE_REGION_FORBIDDEN_MARKERS = [
    'not available in your region',
    'access forbidden',
    'region not supported',
    'not available in your country',
];
/**
 * 在 `ctx.llm` 上注册 Cline provider 路由与适配器。
 *
 * 路由名与配置页展示名由产品配置驱动，得到 `cline`。`settingsNs` 经
 * `settingsNamespaceFor()` 解析：老契约（≤0.1.6）下是 `llm-cline`；
 * 0.1.7-rc.1 起 settings 命名空间只能是 profile 条目 id，故解析为本插件条目 id。
 */
export function registerClineLlm(ctx, options) {
    const product = options.product ?? CLINE;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new ClineAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
    // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
    return adapter;
}
//# sourceMappingURL=cline-adapter.js.map