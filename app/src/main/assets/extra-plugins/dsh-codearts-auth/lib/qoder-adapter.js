/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isQoderExpired } from './qoder.js';
import { QoderEncryptedInfer } from './qoder-wasm.js';
import { unwrapQoderEnvelopeStream } from './qoder-envelope.js';
import { QODER } from './qoder-product.js';
import { collectImages, consumeOpenAiSse, errorDetail, httpErrorCode, isTransportError, serializeMessages, } from './openai-compat.js';
/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export const PROVIDER = 'qoder';
/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export function buildQoderTools(tools) {
    if (tools === undefined || tools.length === 0)
        return [];
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            ...(tool.description.length > 0 ? { description: tool.description } : {}),
            ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        },
    }));
}
/** 把 wire 消息的 content 归一化为字符串（工具调用消息的正文是空串）。 */
function qoderContentText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((block) => typeof block === 'object' && block !== null && block.type === 'text')
            .map((block) => String(block.text))
            .join('');
    }
    // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
    // 客户端 `t2c()` 的 content 恒为字符串（`udn(r, '')`）。
    return '';
}
/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export function buildQoderHistory(messages) {
    const history = [];
    for (const message of messages) {
        if (typeof message.role !== 'string')
            continue;
        const content = qoderContentText(message.content);
        const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
            ? message.tool_calls
            : undefined;
        const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
        // 三者皆空的消息没有承载意义（如只有 reasoning 的帧），跳过以免发出
        // 「空 assistant」这种会让上游困惑的条目。
        if (content.length === 0 && toolCalls === undefined && toolCallId === undefined)
            continue;
        history.push({
            role: message.role,
            content,
            ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
            ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
        });
    }
    return history;
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
    return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000;
}
/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class QoderAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
    fallbackIndex;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? QODER;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.fallbackIndex = new Map((this.product.fallbackModels ?? []).map((model) => [model.id, model]));
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
     * 按**模型**判定（兜底表的 `supportsImage`），不是按 provider 一刀切。
     * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会失败）。
     *
     * ⚠️ 兜底表是本地估计值，不是远端权威数据 —— 见 `qoder-product.ts` 的说明。
     */
    inputModalitiesFor(model) {
        return this.fallbackIndex.get(model)?.supportsImage === true ? ['text', 'image'] : ['text'];
    }
    /**
     * 模型目录。
     *
     * **不发任何网络请求**：Qoder 的模型列表端点需要 WASM 签名
     * （`qoder_auth_wasm`），本插件不实现，故恒用产品兜底表。
     * 见设计文档 §2.6 与 `qoder-product.ts` 的 `fallbackModels` 说明。
     */
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     */
    listAllModels() {
        return this.product.fallbackModels.map((model) => ({ id: model.id, name: qoderDisplayName(model) }));
    }
    async listModels(_provider) {
        // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
        // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
        // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
        // 界面上反而多出一条 provider 报错）。
        if (!await providerCatalogVisible(this.options.accountPool, this.product.id))
            return [];
        // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const source = this.product.fallbackModels;
        const listed = disabled === undefined || disabled.size === 0
            ? source
            : source.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            // 倍率拼进 `name`（**不是** `description`）：composer 的模型切换菜单
            // 只渲染 name，description 仅用于 /model 弹窗。见 qoderDisplayName。
            name: qoderDisplayName(model),
            inputModalities: this.inputModalitiesFor(model.id),
        }));
    }
    async resolveModel(provider, model, _signal) {
        const entry = this.fallbackIndex.get(model);
        const resolved = {
            provider,
            id: model,
            name: entry?.name ?? model,
            inputModalities: this.inputModalitiesFor(model),
        };
        // 上下文窗口：兜底表是**本地估计值**。未知模型不编造 context
        // （宁可让 DSH 用默认值，也不要报一个假的窗口大小）。
        if (entry !== undefined)
            resolved.context = { contextWindow: entry.contextWindow };
        return resolved;
    }
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 图片能力按**模型**判定（兜底表 supportsImage）。
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
                throw new LlmError(`qoder: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('qoder: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
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
        if (credential === undefined || isQoderExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('qoder: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // 2. 补齐 **uid**（加密推理必需）。
        //
        // ⚠️ `uid` 是后加字段，旧凭据里没有；缺它时 WASM 会产出**签名无效**的
        // 请求，服务端回 `Signature invalid (101)`（真实缺陷，用户报障）。
        // 这里调用注入的钩子补一次（实现会调 userinfo 并回写凭据）。
        credential = await this.ensureUid(credential);
        // 3. 走**加密推理**路径（客户端真实链路，认模型目录 key）。
        //
        // 目录 key（`qfmodel` 等）只有这条路能用；公开端点是另一套通用名。
        const messages = serializeMessages(options.messages, imageUrls);
        const systemText = options.system !== undefined && options.system.length > 0
            ? options.system
            : undefined;
        /** 最后一条 user 消息即本轮提问；其余作为历史。 */
        const userMessages = messages.filter((m) => m.role === 'user');
        const lastUser = userMessages.at(-1);
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
        // ⚠️ 必须走 buildQoderHistory：早期内联的「只留 content 为字符串」过滤器
        // 会丢掉 assistant 的 tool_calls（content 为 null）与 tool 的 tool_call_id，
        // 使多步工具调用彻底坏掉（模型看不到自己调用过什么）。
        const history = buildQoderHistory(messages);
        // ⚠️ 工具定义必须真的下发：加密端点的顶层 `tools`。不下发时模型只能
        // 用正文里的 XML 文本臆造工具调用 → harness 认不出 → 任务终止
        // （用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
        const tools = buildQoderTools(options.tools);
        const fallback = this.fallbackIndex.get(options.model);
        /** 用给定凭据构造一次加密请求（首次与 401 重试共用，避免两处漂移）。 */
        const buildRequest = async (c) => {
            const client = await QoderEncryptedInfer.create({
                user: {
                    uid: c.uid,
                    securityOauthToken: c.security_oauth_token ?? c.access_token,
                },
                machineId: c.machine_id,
                metadata: { ...this.product.clientMetadata },
                host: this.product.encryptedInferBase,
            });
            return client.prepareInfer({
                modelKey: options.model,
                userText,
                ...(systemText !== undefined ? { systemText } : {}),
                isReasoning: fallback?.supportsThinking ?? false,
                history,
                // 工具定义：这是模型**唯一**能学到函数 schema 的通道，
                // 缺了它模型只能用正文 XML 臆造调用（真实缺陷）。
                tools,
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
                ...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
                // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
                ...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
                ...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
                // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
                //
                // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
                // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
                // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
                // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
                // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
                //
                // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
                // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
                business: { type: 'agent' },
            });
        };
        // 3. 发送（⚠️ 头必须原样透传：Authorization 是 WASM 生成的
        //    `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid）
        let response = await this.sendEncrypted(await buildRequest(credential), options);
        if (response.status === 401 || response.status === 403) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('qoder: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            credential = await this.ensureUid(refreshed);
            response = await this.sendEncrypted(await buildRequest(credential), options);
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
        }
        // 4. 剥掉加密端点的响应信封，交给统一的 OpenAI SSE 消费器
        yield* consumeOpenAiSse(unwrapQoderEnvelopeStream(response, 'qoder'), { signal: options.signal }, {
            label: 'qoder',
            firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
            chunkTimeoutMs: resolveChunkTimeoutMs(),
        });
    }
    /**
     * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
     *
     * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
     * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
     * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
     */
    async ensureUid(credential) {
        if (credential.uid !== undefined && credential.uid.length > 0)
            return credential;
        const patched = await this.options.resolveUid?.(credential);
        if (patched?.uid !== undefined && patched.uid.length > 0)
            return patched;
        throw new LlmError('qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）', 'MISSING_CREDENTIAL');
    }
    /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
    async sendEncrypted(request, options) {
        const headers = new Headers(request.headers);
        headers.set('Accept', 'text/event-stream');
        try {
            return await this.fetchImpl(request.url, {
                method: 'POST',
                headers,
                body: request.body,
                signal: options.signal,
            });
        }
        catch (error) {
            if (options.signal?.aborted)
                throw error;
            if (isTransportError(error)) {
                throw new LlmError(`qoder: transport error: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error });
            }
            throw error;
        }
    }
}
/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export function promotionActiveNow(promotion, now) {
    const { windowStart, windowEnd } = promotion;
    if (windowStart === undefined || windowEnd === undefined)
        return promotion.active;
    const toMinutes = (hhmm) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
        if (m === null)
            return undefined;
        const h = Number(m[1]);
        const min = Number(m[2]);
        return h < 24 && min < 60 ? h * 60 + min : undefined;
    };
    const start = toMinutes(windowStart);
    const end = toMinutes(windowEnd);
    if (start === undefined || end === undefined)
        return promotion.active;
    // 取 UTC+8 的「墙上时间」（目录时区与用户一致，故无需真实时区换算）
    const utc8 = new Date(now.getTime() + 8 * 3_600_000);
    const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
    return start <= end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
}
/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
export function qoderDisplayName(model, now = new Date()) {
    const promo = model.promotion;
    const before = promo?.beforePromotionPriceFactor;
    const discount = promo?.discountFactor;
    const hasPromo = promo !== undefined && before !== undefined && discount !== undefined;
    const active = hasPromo && promotionActiveNow(promo, now);
    // 免费优先于一切（`0` 是合法倍率，不能显示成 `x0`）。
    if (model.priceFactor === 0)
        return `${model.name} · 免费`;
    if (hasPromo && active) {
        // 折扣生效中：`原价→折后价`（与 TRAE / buddy 同形态）
        const effective = Number((before * discount).toFixed(4));
        return `${model.name} · x${before}→x${effective}`;
    }
    // 窗口外用**原价**（有 promotion 时原价就是 before，而非采集到的折后价）；
    // 窗口外显示折后价会让用户按折扣价预期、实际被按原价计费。
    const price = hasPromo ? before : model.priceFactor;
    return price !== undefined ? `${model.name} · x${price}` : model.name;
}
/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与配置页展示名由产品配置驱动，得到 `qoder`。`settingsNs` 经
 * `settingsNamespaceFor()` 解析：老契约（≤0.1.6）下是 `llm-qoder`；
 * 0.1.7-rc.1 起 settings 命名空间只能是 profile 条目 id，故解析为本插件条目 id。
 */
export function registerQoderLlm(ctx, options) {
    const product = options.product ?? QODER;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new QoderAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
    // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
    return adapter;
}
//# sourceMappingURL=qoder-adapter.js.map