/**
 * OfficeAce 适配器：把 DSH 的 `LlmAdapter` 调用转发到华为 ModelArts MaaS。
 *
 * ## 与 AutoClaw 适配器的差异
 *
 * - **直连云端**（无本地网关）；凭据从本机 Redis 读（见 `officeace-auth.ts`）
 * - `listModels` 静态（`OFFICEACE_MODELS`）+ 探测门控（凭据读不到 = 隐藏分组）
 * - 响应含 `reasoning_content`，`consumeOpenAiSse` 已兼容 OpenAI 协议
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { OFFICEACE, OFFICEACE_MODELS } from './officeace-product.js';
import { basicAuthorization, fetchModelTokenRates, isExpiring, readOfficeAceCredential, refreshStoredCredential } from './officeace-auth.js';
import { consumeOpenAiSse, serializeMessages } from './openai-compat.js';
import { registerAdapterIdempotent } from './llm-register-compat.js';
import { buildDsmlSystemPrompt, needsDsmlToolMode } from './dsml.js';
/**
 * 推理/探测该用哪个 host —— **必须优先用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## ⚠️⚠️ 这是一个阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 症状：Jet Hub 里 provider 列表**有** OfficeAce、账号也在，但**对话的模型选择器里
 * 一个 OfficeAce 模型都看不到**。
 *
 * 根因：适配器原先一律打硬编码的 `OFFICEACE.defaultBaseUrl`
 *（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 * 而华为**按账号下发专属网关** `modelgw-0004.officeace.cn-southwest-2...`。
 * 同一个 Basic 凭据实测：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 模型选择器**空分组**；
 * 且 `listModels` 的空返回与「无账号」**同形**，故「目录门控」会把整个
 * provider 隐藏 —— 用户看到的就是「加了账号却没有模型」。
 *
 * ⚠️ 字段其实早就写进了凭据（`fetchModelInfo` 从云侧 `model_api_url_base` 取），
 *    只是**从没被读过** —— 属「写了不读的死字段」，我在此前审计中已登记为
 *    已知缺口并**低估了它**（判为影响有限），真机证明它是主路径。
 *
 * ⚠️ **只用于 Basic 鉴权的推理/探测路径**。V11 签名那套（`/v1/subscription`、
 *    `/v1/model-token-rates`）实测**两个 host 都存在且都要求签名**，
 *    属管理面 API，**不要**一起改。
 *
 * @returns 规范化（去尾斜杠）后的 base URL；凭据没带时回退默认域（零行为变化）。
 */
export function maasBaseUrlOf(credential) {
    const raw = typeof credential.maasBaseUrl === 'string' ? credential.maasBaseUrl.trim() : '';
    const base = raw.length > 0 ? raw : OFFICEACE.defaultBaseUrl;
    return base.replace(/\/+$/, '');
}
/**
 * 该模型是否接受图片输入（**实测表**，依据见 `OFFICEACE_MODELS` 的 `multimodal` 注）。
 *
 * `/v2/models` 不返回能力元数据，只能逐个实测 —— 未入库的 id 保守按不支持。
 */
function isMultimodalModel(model) {
    return OFFICEACE_MODELS.some((m) => m.id === model && m.multimodal === true);
}
/**
 * 收集消息中的图片附件引用（含工具结果内层，任意深度），按 attachmentId 去重。
 *
 * ⚠️ 与 trae / buddy / lobsterai 的同名助手同义。收集必须**递归**进
 * `tool-result.content`：只走一层时，深层图片会被收进 refs 却在序列化时丢失。
 */
function collectImages(content, refs) {
    for (const raw of content) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const block = raw;
        if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
            refs.set(block.attachment.attachmentId, block.attachment);
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content))
            collectImages(block.content, refs);
    }
}
export class OfficeAceAdapter extends LlmAdapter {
    options;
    /** 目录是否已广播过（只广播一次）。 */
    announced = false;
    /** 倍率缓存（listModels 时填充，resolveModel 复用——保持两处名字一致）。 */
    rateCache = new Map();
    constructor(options = {}) {
        super();
        this.options = options;
    }
    /**
     * 取当前可用凭据；STS 临期（10 分钟内）先静默刷新。
     *
     * ⚠️ 刷新失败（refresh_token 已消费）返回旧凭据 —— 推理可能仍可用
     *（MaaS Basic 凭据与 STS 生命周期不同步）；真正失效由 stream 的 401 报错兜底。
     */
    async resolveCredential() {
        if (this.options.credentialProvider)
            return this.options.credentialProvider();
        let credential = await readOfficeAceCredential();
        if (credential !== undefined && isExpiring(credential)) {
            credential = (await refreshStoredCredential().catch(() => undefined)) ?? credential;
        }
        return credential;
    }
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : OFFICEACE.id;
        return { id, name: OFFICEACE.displayName };
    }
    /** ⚠️ 必须同步（Jet Hub `ModelCatalogSource` 不 await，同 minimax 教训）。 */
    listAllModels() {
        return OFFICEACE_MODELS.map((m) => ({ id: m.id, name: m.name }));
    }
    /**
     * 目录：凭据可读 + `/v2/models` 可达才暴露（隐藏不可恢复的分组，
     * 与 AutoClaw 同一约定：空目录 = 隐藏，而不是报错）。
     */
    async listModels(_provider) {
        const disabled = this.options.disabledModels?.() ?? new Set();
        const credential = await this.resolveCredential();
        if (credential === undefined)
            return [];
        try {
            const probe = await this.probe(credential);
            if (!probe)
                return [];
        }
        catch {
            return [];
        }
        this.announceLater();
        // 倍率（costCoefficient）：OfficeAce 主界面显示 `0.7x` 的那个值，来自
        // `/api/subscription/model-token-rates`。取不到（未装 OfficeAce）时优雅降级
        // —— 名字后不带 x 系数，模型照常可选。
        const rates = await fetchModelTokenRates();
        this.rateCache = rates;
        return OFFICEACE_MODELS
            .filter((m) => !disabled.has(m.id))
            .map((m) => {
            const coeff = rates.get(m.id);
            return {
                provider: OFFICEACE.id,
                id: m.id,
                name: coeff !== undefined ? `${m.name} · x${coeff}` : m.name,
                // ⚠️ **图片准入闸门**（实测表见 `OFFICEACE_MODELS` 的 `multimodal` 注）：
                //    不声明 `image` 时附件在入库阶段就被拒（用户看到「当前模型不支持
                //    图片」）—— 这是对 6 个纯文本模型的**诚实**行为。
                inputModalities: isMultimodalModel(m.id) ? ['text', 'image'] : ['text'],
            };
        });
    }
    announceLater() {
        if (this.announced)
            return;
        this.announced = true;
        setTimeout(() => {
            try {
                this.options.onCatalogLoaded?.();
            }
            catch {
                // 广播失败不中断请求
            }
        }, 0);
    }
    async resolveModel(provider, model, _signal) {
        const known = OFFICEACE_MODELS.find((m) => m.id === model);
        // ⚠️ 倍率要与 listModels 同源（否则选择器显示 `GLM-5.2 · x0.7`、
        //    选中后底部胶囊却只显示 `GLM-5.2`——两处名字不一致）。缓存命中时同步取。
        const coeff = this.rateCache.get(model);
        const baseName = known?.name ?? model;
        return {
            provider,
            id: model,
            name: coeff !== undefined ? `${baseName} · x${coeff}` : baseName,
            // 与 listModels 同源：准入闸门两处都要说真话（实测表见 OFFICEACE_MODELS）。
            inputModalities: isMultimodalModel(model) ? ['text', 'image'] : ['text'],
            // ⚠️ **未知 id 不编造 `context`**：目录外的模型我们不知道它的上下文窗口，
            //    拿一个猜测值（131072）会让自动压缩按错误阈值决策 —— 如实 `undefined`
            //    比编一个数诚实（`model-catalog-parity.spec.ts` 会红并点名这种编造）。
            ...(known === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
        };
    }
    /** 探测：模型端点 200 且 JSON（凭据有效即通过）。 */
    async probe(credential) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        try {
            const f = this.options.fetchImpl ?? fetch;
            const r = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.modelsPath}`, {
                headers: { Authorization: basicAuthorization(credential) },
                signal: ctrl.signal,
            });
            const ct = r.headers.get('content-type') ?? '';
            return r.ok && ct.includes('application/json');
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    /** ⚠️ 单参数 `stream(options)`（`LlmAdapter` 基类契约）。 */
    async *stream(options) {
        const model = options.model;
        const credential = await this.resolveCredential();
        if (credential === undefined) {
            throw new Error('未找到 OfficeAce 凭据：请启动 OfficeAce 并登录华为云账号（凭据缓存于本机 Redis），'
                + '或确认 Redis 6399 与 Windows 凭据管理器条目可读');
        }
        const f = this.options.fetchImpl ?? fetch;
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort);
        // ⚠️ **max_tokens 下限保护**（2026-10-12 实测定位「渠道老是停」）：
        //    OfficeAce 全系模型带思考链，且思考 token 计入 max_tokens 预算。
        //    实测 deepseek-v4.1-flash：max_tokens=32 → reasoning_tokens=32、
        //    content 0 字、finish_reason=length；512 同样 0 字；不限 → 2s 完整回复。
        //    即：小预算会被思考链**全部烧光**，正文一个字都不剩 —— 外部表现就是
        //    「回复是空的 / 渠道停了」。故低于下限的预算直接**丢弃**（交给端点默认
        //    上限兜底），只有够大的预算才透传。下限取 4096：留足思考 + 正文余量。
        const MAX_TOKENS_FLOOR = 4096;
        const maxTokens = options.maxTokens !== undefined && options.maxTokens >= MAX_TOKENS_FLOOR
            ? options.maxTokens
            : undefined;
        // ── 图片输入（多模态）──
        // 收集 → 闸门 → 读字节 → 注入序列化结果。四步各自可失败，逐一说明：
        const imageRefs = new Map();
        for (const message of options.messages) {
            const content = Array.isArray(message.content) ? message.content : [];
            collectImages(content, imageRefs);
        }
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!isMultimodalModel(model)) {
                // ⚠️ 双保险：DSH 的准入闸门（inputModalities）已在附件阶段拦住大多数，
                //    但目录缓存过期 / 模型 id 未入库时仍可能漏到这里 —— 上游会对纯文本
                //    模型回 400 并报废整轮对话，早失败 + 文案明确更好。
                throw new Error(`OfficeAce: 模型 "${model}" 不支持图片输入。`
                    + `已实测支持：DeepSeek-V4.1-Flash、Kimi-K2.6（见 OFFICEACE_MODELS 的 multimodal 注）`);
            }
            if (this.options.readImage === undefined) {
                throw new Error('OfficeAce: 图片输入需要附件服务桥接（readImage）；'
                    + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local');
            }
            imageUrls = new Map();
            for (const [id, ref] of imageRefs) {
                const image = await this.options.readImage(ref);
                if (image === undefined)
                    continue;
                imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
            }
        }
        const wireMessages = serializeMessages(options.messages);
        // 把图片 parts 注回 user 消息：共享 `serializeMessages` 会把 content 压成
        // 纯文本（图片静默丢失 ——「发不了图片」的成因），这里按 user 消息出现顺序
        // 一一对应，把该消息内（含 tool-result 内层）的图片补成
        // `{type:'image_url'}` parts（MaaS 实测接受该形态，deepseek-v4.1-flash /
        // kimi-k2.6 均正常描述图片内容）。
        if (imageUrls !== undefined) {
            const originalUsers = options.messages.filter((m) => m.role === 'user');
            let userIdx = 0;
            for (const wire of wireMessages) {
                if (wire.role !== 'user')
                    continue;
                const original = originalUsers[userIdx++];
                if (original === undefined)
                    break;
                const inner = Array.isArray(original.content) ? original.content : [];
                const parts = [];
                const text = typeof wire.content === 'string' ? wire.content : '';
                if (text.length > 0)
                    parts.push({ type: 'text', text });
                for (const raw of inner) {
                    if (typeof raw !== 'object' || raw === null)
                        continue;
                    const block = raw;
                    if (block.type === 'image') {
                        const url = block.attachment?.attachmentId === undefined
                            ? undefined
                            : imageUrls.get(String(block.attachment.attachmentId));
                        // 解析不到字节时留占位文本，而不是静默吞掉整张图。
                        parts.push(url === undefined
                            ? { type: 'text', text: '[image unavailable]' }
                            : { type: 'image_url', image_url: { url } });
                    }
                }
                if (parts.length > 0)
                    wire.content = parts;
            }
        }
        // ── 工具定义下发 ──
        //
        // ⚠️ **这是「工具调用被当正文、模型停住不动」的真正根因**（2026-10-13）。
        //    本适配器**原本既不发 `tools` 字段、也不注入 DSML 提示**，模型在零
        //    协议指引下凭训练印象臆造出 `<｜DSML｜ calls>` —— 而解析器只认
        //    `<｜DSML｜tool_calls>`（见 dsml.ts）。标记写得再「规范」也解析不了，
        //    因为**协议名本身就是错的**。归一化修不了这个，必须先下发正确语法。
        //
        // 走 DSML 注入（而非标准 `tools` 字段）的理由与 codearts 一致：
        // 该通道同样经网关，标准 tool_calls 的参数一次性打包会触发 ~60s 空闲
        // 断连；DSML 经 `delta.content` 流式输出，全程有数据流。
        const wireTools = options.tools?.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
        let toolsPayload = wireTools;
        /**
         * 是否走 DSML 模式。**必须与 `consumeOpenAiSse` 的 `dsmlToolMode` 成对**：
         * 注入提示让模型写 DSML，消费器就必须解析 DSML —— 缺任一半，工具调用
         * 都会变成「整段标签当正文、工具永不执行」。
         *
         * ⚠️ **OfficeAce 默认关闭**（2026-10-13 三次事故后决定）。
         *
         *    DSML 的本意是绕开网关 ~60s 空闲超时（标准 `tool_calls` 要求参数
         *    一次性打包，生成期间 SSE 无数据流会被掐断）。但实测
         *    `deepseek-v4.1-flash` 经本渠道**无法稳定遵循文本协议**：
         *
         *    - 三轮迭代（注入提示 → 大小写判定 → `calls` 别名兼容）全部到位后，
         *      模型仍在同一轮里混写 `<｜DSML｜tool_calls>` 与 `<｜DSML｜ calls>`；
         *    - 更常见的是**压根不发工具调用**，只输出「我这就去查：」然后结束
         *      —— 用户视角就是「Agent 不干活」。
         *
         *    根因是 DSML 把工具协议从「框架保证的结构化字段」降级成「模型自觉
         *    遵守的文本约定」，而该模型不可靠。两害相权：**标准 `tools` 字段下
         *    工具必定可用**，超时风险留给需要它的场景自行权衡。
         *
         *    确需开启（例如实测本渠道不再触发 60s 断连）时，设环境变量
         *    `OFFICEACE_DSML=1` 后重启 dsh。
         *
         * ⚠️ **本开关同时驱动「教」与「解」两半**（注入提示 + 传给
         * `consumeOpenAiSse` 的解析开关），**不得只改一处** —— 单边存在时
         * 模型写的 DSML 无人解析，工具调用会整段当正文显示。
         */
        let dsmlMode = false;
        if (process.env.OFFICEACE_DSML === '1'
            && wireTools !== undefined && wireTools.length > 0
            && needsDsmlToolMode(model, wireTools.map((tool) => tool.function.name))) {
            dsmlMode = true;
            // 注入位置：system 之后、user 之前（实测放末尾会让思考泄漏进正文，
            // 见 dsml.ts 注释）。
            wireMessages.splice(wireMessages.findIndex((m) => m.role === 'system') + 1, 0, { role: 'system', content: buildDsmlSystemPrompt(wireTools) });
            toolsPayload = undefined;
        }
        const payload = JSON.stringify({
            model,
            messages: wireMessages,
            stream: true,
            ...toolsPayload !== undefined && toolsPayload.length > 0 ? { tools: toolsPayload } : {},
            ...maxTokens === undefined ? {} : { max_tokens: maxTokens },
            ...options.temperature === undefined ? {} : { temperature: options.temperature },
        });
        try {
            const response = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.chatPath}`, {
                method: 'POST',
                headers: {
                    Authorization: basicAuthorization(credential),
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: payload,
                signal: controller.signal,
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                // ⚠️ 401 = Basic 凭据失效。MaaS 的凭据与 STS 生命周期不同步，**STS 也快到期**
                //    是常见成因 —— 这里续期一次再重发，与 trae / gemini 同款模式。
                //    不接 `options.refresh` 时静默失败（接线层漏接的症状即此）。
                if (response.status === 401 && this.options.refresh !== undefined) {
                    await this.options.refresh().catch(() => undefined);
                    const renewed = await this.resolveCredential();
                    if (renewed !== undefined && renewed !== credential) {
                        const retry = await f(`${maasBaseUrlOf(renewed)}${OFFICEACE.chatPath}`, {
                            method: 'POST',
                            headers: {
                                Authorization: basicAuthorization(renewed),
                                'Content-Type': 'application/json',
                                Accept: 'text/event-stream',
                            },
                            body: payload,
                            signal: controller.signal,
                        });
                        if (retry.ok) {
                            yield* consumeOpenAiSse(retry, { signal: controller.signal }, {
                                label: OFFICEACE.id,
                                firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
                                chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
                                ...maxTokens === undefined ? {} : { maxTokens },
                                ...dsmlMode ? { dsmlToolMode: true } : {},
                            });
                            return;
                        }
                    }
                }
                throw new Error(`OfficeAce (华为MaaS) 返回 HTTP ${response.status}：${text.slice(0, 200)}`
                    + `（${this.diagnose(response.status)}）`);
            }
            yield* consumeOpenAiSse(response, { signal: controller.signal }, {
                label: OFFICEACE.id,
                firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
                chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
                ...maxTokens === undefined ? {} : { maxTokens },
                ...dsmlMode ? { dsmlToolMode: true } : {},
            });
        }
        finally {
            options.signal?.removeEventListener('abort', onAbort);
            controller.abort();
        }
    }
    diagnose(status) {
        if (status === 401)
            return 'Basic 凭据失效：OfficeAce 会话已过期，请重新登录 OfficeAce 客户端';
        if (status === 403)
            return '该账号未订阅此模型（ModelArts.81004）：请在 OfficeAce 或华为云控制台订阅';
        if (status === 404)
            return '模型不存在：检查模型 id 是否在目录中';
        if (status === 429)
            return '限流：稍后重试';
        if (status >= 500)
            return '华为云服务端错误：稍后重试';
        return '请确认 OfficeAce 已登录且账号有可用额度';
    }
}
/** 在 `ctx.llm` 上注册 OfficeAce provider 路由（幂等，返回**原始适配器实例**）。 */
export function registerOfficeAceLlm(ctx, options = {}) {
    const adapter = new OfficeAceAdapter(options);
    // ⚠️ **返回 `adapter` 而不是 `registerAdapterIdempotent` 的返回值**：
    //    后者的语义是「`registerAdapter` 的结果」—— 重复注册时它返回 `undefined`，
    //    非重复时返回宿主给的句柄（**不是**适配器实例）。接线层要把它放进
    //    `modelAdapters` 供 `provider.status` 调 `listAllModels()`，拿到句柄会
    //    报 `listAllModels is not a function`（实测症状，2026-10-12）。
    //    与 `registerGeminiLlm` / `registerZcodeLlm` 同款（它们也返回原始实例）。
    registerAdapterIdempotent(ctx.llm, [OFFICEACE.id], adapter, (message) => ctx.logger?.warn?.(message));
    return adapter;
}
//# sourceMappingURL=officeace-adapter.js.map