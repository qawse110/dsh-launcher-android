import { randomUUID } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DEFAULT_IMAGE_LIMITS, parseImageDataUrl, toImageBlock, } from './images.js';
export class OpenAiGatewayError extends Error {
    status;
    type;
    code;
    constructor(message, status = 400, type = 'invalid_request_error', code = 'invalid_request') {
        super(message);
        this.status = status;
        this.type = type;
        this.code = code;
        this.name = 'OpenAiGatewayError';
    }
}
export function normalizeMaxTokens(value, provider, model) {
    if (value === undefined)
        return undefined;
    // GLM-5.2 与 DeepSeek V4 实测均会拒绝 128000，65536 可正常推理。
    if (provider === 'codearts' && (/^deepseek-v4-(flash|pro)$/.test(model) || model === 'GLM-5.2')) {
        return Math.min(value, 65536);
    }
    return value;
}
/**
 * 把 OpenAI 的 `reasoning_effort` 归一化成本模型**真正支持**的档位。
 *
 * ## 「未声明」与「不支持」必须区别对待
 *
 * 实机报障：ZCode 经网关调 `lobsterai/MiniMax-M3.1-Flash-Preview` 报
 * `provider "lobsterai" model "..." does not support reasoning effort "high"`。
 * 该模型没有 `thinkingConfig` ⇒ 适配器不声明 reasoning ⇒ `supported` 为空。
 * 初版在这里**原样透传**了 `high`，于是 DSH 侧校验拒绝，整轮请求失败。
 *
 * 正确处理是**不下发**该参数：模型没有这组档位，硬塞一个只会换来错误，
 * 而「静默按模型默认走」至少不会让用户的整轮对话失败。
 * （与本仓库「不参与模型请求、不伪造 provider 行为」的既有约定一致。）
 *
 * ⚠️ 但**声明了档位却不含用户要的那一档**时必须抛 400：模型既然声明了档位，
 * 就说明它支持思考控制；静默丢弃会让用户以为设置生效了。
 *
 * ## 返回值是**三态**，不可混用
 *
 * - `string`：归一化后的档位，下发它；
 * - `undefined`：**用户没传** `reasoning_effort`；
 * - `null`：**用户传了，但本模型不适用** → 明确不下发。
 *
 * ⚠️ `null` 与 `undefined` 必须分开：`toGenerateOptions` 以 `!== undefined`
 * 判定「调用方是否给了值」。若这里用 `undefined` 表示「不下发」，它会被当成
 * 「没给」而回退读 `body.reasoning_effort` —— 归一化的结论被原样抵消，
 * 于是报障原句又回来了。**这是本缺陷第二轮的复发形态**（首轮是原样透传，
 * 二轮是「修好了却被下游回退吃掉」）。
 */
export function normalizeReasoningEffort(requested, modelInfo, provider, model) {
    if (requested === undefined)
        return undefined;
    const value = String(requested);
    if (provider === 'codearts' && model !== undefined) {
        return value === 'none' || value === 'off' ? 'off' : 'on';
    }
    const record = modelInfo;
    const supported = new Set((record?.reasoning?.efforts ?? []).map(effort => String(effort.id)));
    // 模型未声明档位（supported 为空）：明确**不下发**，而不是原样透传。
    // modelInfo 为 undefined 也走这里 —— 那不是「没有限制」，是「不知道」。
    if (supported.size === 0)
        return null;
    if (supported.has(value))
        return value;
    if ((value === 'none' || value === 'off') && supported.has('off'))
        return 'off';
    if (value !== 'none' && value !== 'off' && supported.has('on'))
        return 'on';
    throw new OpenAiGatewayError(`reasoning effort ${JSON.stringify(value)} is not supported by the selected DSH model`, 400, 'unsupported_parameter', 'unsupported_reasoning_effort');
}
/**
 * 把 OpenAI 的 `content` 转成 DSH 的内容块数组。
 *
 * ⚠️ 图片走 `image_url` → 附件 → `ImageBlock`（见 `./images.ts`），**异步**。
 * 附件服务缺失时（`bridge` 为 undefined）必须抛错而不是静默丢图：静默丢弃会让
 * 用户以为模型看到了图，而答案其实是基于文本生成的。
 */
async function partsFromContent(content, bridge, limits) {
    if (typeof content === 'string')
        return [{ type: 'text', text: content }];
    if (content === null || content === undefined)
        return [];
    if (!Array.isArray(content)) {
        throw new OpenAiGatewayError('message.content must be a string or an array of content parts');
    }
    const blocks = [];
    const used = { count: 0, bytes: 0 };
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            throw new OpenAiGatewayError('message.content contains an invalid part');
        }
        const item = part;
        if (item.type === 'text' && typeof item.text === 'string') {
            blocks.push({ type: 'text', text: item.text });
            continue;
        }
        if (item.type === 'image_url') {
            if (bridge === undefined) {
                throw new OpenAiGatewayError('当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。', 400, 'unsupported_content', 'unsupported_content');
            }
            try {
                blocks.push(await toImageBlock(item.image_url?.url, bridge, limits, used));
            }
            catch (error) {
                // 转成 OpenAI 风格错误，让客户端能识别是「内容问题」而非服务端故障。
                throw new OpenAiGatewayError(error instanceof Error ? error.message : String(error), 400, 'unsupported_content', 'unsupported_content');
            }
            used.count += 1;
            // 字节数按解析后的实际值累计，用于整条消息的总量限制。
            const parsed = parseImageDataUrl(item.image_url?.url);
            used.bytes += parsed?.data.length ?? 0;
            continue;
        }
        throw new OpenAiGatewayError('message.content contains an unsupported part');
    }
    return blocks;
}
/** 提取纯文本（仅用于需要字符串的场景；带图的 content 走 partsFromContent）。 */
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (content === null || content === undefined)
        return '';
    if (!Array.isArray(content)) {
        throw new OpenAiGatewayError('message.content must be a string or an array of text parts');
    }
    return content.map((part) => {
        if (!part || typeof part !== 'object') {
            throw new OpenAiGatewayError('message.content contains an invalid part');
        }
        const item = part;
        if (item.type === 'text' && typeof item.text === 'string')
            return item.text;
        // ⚠️ 这里**不再**因为 image_url 抛错：图片由 partsFromContent 异步处理。
        // 但纯文本路径（如 tool 消息）遇到图片仍然要拒绝 —— 它拿不到附件桥接。
        if (item.type === 'image_url') {
            throw new OpenAiGatewayError('tool 消息的内容不能包含图片', 400, 'unsupported_content', 'unsupported_content');
        }
        throw new OpenAiGatewayError('message.content contains an unsupported part');
    }).join('');
}
function newMessage(role, content, source) {
    return { id: randomUUID(), role, content, source };
}
function convertToolCalls(raw) {
    if (!Array.isArray(raw))
        throw new OpenAiGatewayError('assistant.tool_calls must be an array');
    return raw.map((value) => {
        if (!value || typeof value !== 'object')
            throw new OpenAiGatewayError('tool call must be an object');
        const call = value;
        const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
        const name = typeof call.function?.name === 'string' && call.function.name.length > 0
            ? call.function.name
            : undefined;
        const args = typeof call.function?.arguments === 'string' ? call.function.arguments : undefined;
        if (!id || !name || args === undefined)
            throw new OpenAiGatewayError('assistant.tool_calls contains an invalid function call');
        return { type: 'tool-call', id: id, name, arguments: args };
    });
}
/**
 * 单条 OpenAI 消息 → DSH `Message`。
 *
 * ⚠️ **异步**：`user` 消息的 content 可能是多模态数组，图片要经附件服务落盘
 * （`saveImage` 是异步的），故这里整体异步化，由 {@link toGenerateOptions} 串行 await。
 */
async function convertMessage(raw, provider, model, bridge, limits) {
    if (!raw || typeof raw !== 'object')
        throw new OpenAiGatewayError('messages entries must be objects');
    const value = raw;
    const role = value.role;
    if (role === 'system') {
        return newMessage('system', [{ type: 'text', text: textFromContent(value.content) }], {
            kind: 'plugin', plugin: 'dsh-openai-gateway',
        });
    }
    if (role === 'user') {
        // ⚠️ user 消息走 parts：图片在这里被真正接收（其它角色不接受图片）。
        return newMessage('user', await partsFromContent(value.content, bridge, limits), { kind: 'user' });
    }
    if (role === 'assistant') {
        const text = textFromContent(value.content);
        const content = text.length > 0 ? [{ type: 'text', text }] : [];
        if (value.tool_calls !== undefined)
            content.push(...convertToolCalls(value.tool_calls));
        return newMessage('assistant', content, { kind: 'model', provider, model });
    }
    if (role === 'tool') {
        if (typeof value.tool_call_id !== 'string' || value.tool_call_id.length === 0) {
            throw new OpenAiGatewayError('tool messages require tool_call_id');
        }
        return newMessage('user', [{
                type: 'tool-result',
                toolCallId: value.tool_call_id,
                content: [{ type: 'text', text: textFromContent(value.content) }],
            }], { kind: 'tool', callId: value.tool_call_id });
    }
    throw new OpenAiGatewayError(`unsupported message role: ${String(role)}`);
}
function convertTools(raw) {
    if (raw === undefined)
        return undefined;
    if (!Array.isArray(raw))
        throw new OpenAiGatewayError('tools must be an array');
    return raw.map((value) => {
        if (!value || typeof value !== 'object')
            throw new OpenAiGatewayError('tool must be an object');
        const tool = value;
        if (tool.type !== 'function' || typeof tool.function?.name !== 'string') {
            throw new OpenAiGatewayError('only function tools are supported');
        }
        const parameters = tool.function.parameters;
        if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) {
            throw new OpenAiGatewayError('tool function.parameters must be a JSON object');
        }
        return {
            name: tool.function.name,
            description: typeof tool.function.description === 'string' ? tool.function.description : '',
            parameters: (parameters ?? {}),
        };
    });
}
export function parseModelRoute(value) {
    if (typeof value !== 'string')
        throw new OpenAiGatewayError('model must be a string');
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) {
        throw new OpenAiGatewayError('model must use provider/model format');
    }
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
function tokenValue(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new OpenAiGatewayError(`${name} must be a positive integer`);
    }
    return value;
}
/**
 * @param reasoningEffortOverride 网关归一化后的档位。**三态**：
 * - `string`：用它；
 * - `null`：**明确不下发**（模型未声明思考档位，硬塞只会让 DSH 侧报
 *   `UNSUPPORTED_REASONING_EFFORT`）；
 * - `undefined`：调用方没给 → 回退读 `body.reasoning_effort`（直连调用的老行为）。
 * @param images 图片入站依赖。`bridge` 为 undefined 时收到图片会明确报错而非
 *   静默丢图；`limits` 缺省用附件服务的实测默认值。
 *
 * ⚠️ **本函数是异步的**（图片要经附件服务落盘）。若外部有同步调用方需注意。
 */
export async function toGenerateOptions(body, signal, reasoningEffortOverride, maxTokensOverride, images = {}) {
    const { provider, model } = parseModelRoute(body.model);
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new OpenAiGatewayError('messages must be a non-empty array');
    }
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
        throw new OpenAiGatewayError('only tool_choice auto and none are supported');
    }
    const maxTokens = maxTokensOverride ?? (body.max_completion_tokens !== undefined
        ? tokenValue(body.max_completion_tokens, 'max_completion_tokens')
        : tokenValue(body.max_tokens, 'max_tokens'));
    const stop = body.stop === undefined
        ? undefined
        : typeof body.stop === 'string' ? [body.stop]
            : Array.isArray(body.stop) && body.stop.every(item => typeof item === 'string') ? body.stop
                : (() => { throw new OpenAiGatewayError('stop must be a string or string array'); })();
    const temperature = body.temperature === undefined ? undefined
        : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
            : (() => { throw new OpenAiGatewayError('temperature must be a finite number'); })();
    const tools = convertTools(body.tools);
    if (body.tool_choice === 'none' && tools !== undefined && tools.length > 0) {
        throw new OpenAiGatewayError('tool_choice none with tools cannot be represented by DSH', 400, 'unsupported_parameter', 'unsupported_parameter');
    }
    // ⚠️ 这里用 `!== undefined` 而**不是** `??`：三态必须区分开。
    // - `undefined`：调用方没给（未传）→ 回退到 body 里的值（直连调用的老行为）；
    // - `null`：调用方**明确决定不下发**（模型未声明思考档位）→ 必须原样保留，
    //   否则 `??` 会把它当成「没给」而从 body 捞回原值，让归一化的结论被抵消 ——
    //   实测正是这样：归一化返回 undefined 后，body 里的 'high' 又被塞回请求，
    //   DSH 侧继续抛 UNSUPPORTED_REASONING_EFFORT。
    const reasoningEffort = reasoningEffortOverride !== undefined
        ? reasoningEffortOverride
        : (body.reasoning_effort === undefined ? undefined : String(body.reasoning_effort));
    const limits = images.limits ?? DEFAULT_IMAGE_LIMITS;
    // ⚠️ **串行**而非 Promise.all：多张图会并发打附件服务，串行既让限额累计
    // 判定准确（`used` 是逐张累加的），也避免一次性压垮附件服务的并发额度。
    const messages = [];
    for (const message of body.messages) {
        messages.push(await convertMessage(message, provider, model, images.bridge, limits));
    }
    return {
        provider,
        model,
        messages,
        ...tools === undefined ? {} : { tools },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...temperature === undefined ? {} : { temperature },
        ...stop === undefined ? {} : { stop },
        // ⚠️ 判据是 `== null`（同时排除 undefined 与 null）：`null` = 明确不下发，
        // 两者都不能写进请求。写成 `=== undefined` 会把 null 塞进
        // `ReasoningEffortId(null)`，等于又发了一个非法档位。
        ...reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
        signal,
    };
}
//# sourceMappingURL=messages.js.map