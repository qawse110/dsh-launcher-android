/**
 * LobsterAI（有道龙虾）LLM 适配器。
 *
 * 骨架取自 `src/buddy-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * LobsterAI 与腾讯系只在「OpenAI 兼容 + SSE」这一层相同，其余没有一处能照抄。
 *
 * ## 与 `BuddyAdapter` 的关键差异（逐条对应计划文档 §3.5-C）
 *
 * | 项 | 处理 |
 * |---|---|
 * | URL | `${product.apiBase}/api/proxy/v1/chat/completions` |
 * | 请求头 | 只设 `Authorization` / `Content-Type` / `Accept` / `User-Agent` / `X-LobsterAI-Client-*`；**不设**腾讯系归属头 |
 * | `stream` | **恒为 `true`** —— 上游只支持 SSE，`stream:false` 返回 500 |
 * | `tool_choice` | **不适用**：DSH 的 `GenerateOptions` 无该字段，且 body 由本适配器自建，天然不会出现（Go 桥接层要归一化是因为它转发客户端的原始 body） |
 * | `prompt_cache_key` | **不发** —— 那是腾讯后端的前缀缓存机制，此处未实测支持 |
 * | 思考等级 | **不照抄** buddy 的 deepseek 补档逻辑（那是针对腾讯后端实测的）；仅透传 |
 * | 图片 | **不支持**，`inputModalities` 恒为 `['text']` |
 *
 * 可以原样复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` /
 * `resolveToolPairing` / `normalizeToolArguments` / `isTruncatedArguments`）——
 * 它们处理的是 **OpenAI 协议层的通用陷阱**，与具体厂商无关。
 */
import { LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { parseRateLimitError } from './llm-adapter.js';
import { LOBSTERAI_CHAT_PATH, LOBSTERAI_MODELS_PATH, LOBSTERAI_REQUEST_TIMEOUT_MS, isLobsteraiExpired, lobsteraiChatHeaders, lobsteraiKeyfromBody, readNumberField, readStringField, } from './lobsterai.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { classifyLobsteraiError, classifyLobsteraiStreamError, recordsLobsteraiRateLimit, shouldRotateLobsteraiAccount, } from './lobsterai-errors.js';
import { normalizeHarnessMessages } from './message-shape.js';
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js';
/** 本适配器注册的 provider 路由名（历史常量，等价于 `LOBSTERAI.id`）。 */
export const PROVIDER = 'lobsterai';
/**
 * 思考档位取值 → 展示名。
 *
 * ⚠️ **展示名取自产品侧 `level`，不是 wire 值 `openclawLevel`**：远端把
 * `level: 'max'` 映射到 `openclawLevel: 'xhigh'`，产品侧（IDE）显示的正是
 * **Max**。故本表必须同时登记 `max` 与 `xhigh` 两个键 ——
 * 前者给 `level` 查（正常路径），后者给 `openclawLevel` 查（兼容回退）。
 *
 * **历史缺陷**（Issue #IKHCZF）：早期只用 `openclawLevel` 查表，最强档显示
 * 「XHigh」，与产品侧「Max」不一致，用户按 IDE 的命名找不到对应档位。
 */
const EFFORT_NAMES = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
};
/**
 * 限流重置时间的本地兜底（毫秒，1 小时）。
 *
 * 仅在**解析不出服务端声明的重置时刻**时使用（如纯文本 429）。
 * 取值与 `parseRateLimitError` 内部 JSON 路径下的 fallback 一致，
 * 避免同一场景在不同路径给出不同的冷却时长。
 */
const LOBSTERAI_RATE_LIMIT_FALLBACK_MS = 3_600_000;
/**
 * 单次请求最多换几个账号（含首次），对齐 Go 的 `MaxRotate`。
 *
 * Go 在 `server.NewHandler` 中把 `MaxRotate` 默认设为 3（`handler.go:38-40`），
 * 循环写成 `for i := 0; i < h.cfg.MaxRotate; i++`（`handler.go:190`），
 * 注释明写是**防雪崩**：账号池很大时若逐个试完，一次用户请求可能打出
 * N 个上游请求，既放大延迟也放大额度消耗。
 */
const LOBSTERAI_MAX_ROTATE = 3;
/** 产品侧思考档位名的合法取值（远端 `level` 字段）。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** wire 侧思考档位的合法取值（远端 `openclawLevel`，**无 `max`**）。 */
const OPENCLAW_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
/**
 * 解析 `thinkingConfig`；结构不符时返回 `undefined`（丢弃而非解析出半截数据）。
 *
 * 严格性对齐 IDE 的 `parseModelThinkingConfig`（`modelThinking.js`）：
 * - `options` 必须是非空数组，每项都要有合法的 `level` 与 `openclawLevel`；
 * - 两者的「是否 off」必须一致（避免 `off` 配一个非 off 的 wire 值）；
 * - 不允许重复档位；
 * - `defaultLevel` 必须存在且落在 `options` 里 —— 否则 DSH 会拿一个
 *   不存在的档位去请求，比不声明更糟。
 *
 * 只有 `off` 一档时视为无档位可选（等价于不支持配置思考），返回 `undefined`。
 */
export function parseLobsteraiThinkingConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    const rawOptions = record.options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0)
        return undefined;
    const options = [];
    const seenLevels = new Set();
    const seenWireLevels = new Set();
    for (const raw of rawOptions) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            return undefined;
        const entry = raw;
        const level = typeof entry.level === 'string' ? entry.level : '';
        const openclawLevel = typeof entry.openclawLevel === 'string' ? entry.openclawLevel : '';
        if (!THINKING_LEVELS.has(level) || !OPENCLAW_THINKING_LEVELS.has(openclawLevel))
            return undefined;
        if (seenLevels.has(level) || seenWireLevels.has(openclawLevel))
            return undefined;
        if ((level === 'off') !== (openclawLevel === 'off'))
            return undefined;
        seenLevels.add(level);
        seenWireLevels.add(openclawLevel);
        options.push({ level, openclawLevel });
    }
    if (options.length === 1 && options[0].level === 'off')
        return undefined;
    const defaultLevel = typeof record.defaultLevel === 'string' ? record.defaultLevel : '';
    if (!seenLevels.has(defaultLevel))
        return undefined;
    return { options, defaultLevel };
}
/**
 * 从响应中提取模型数组，兼容上游**两种**形状。
 *
 * 这两种形状在真实服务端上都出现过，必须都认：
 *
 * - **单层**（2026-09-17 实测的真实形态）：
 *   `{code:0, message:'success', data:[{modelId,...}]}` —— `data` 直接是数组；
 * - **双层**（`internal/upstream/client.go:254-278` 记录的形态）：
 *   `{code:0, msg:'OK', data:{data:[{modelId,...}]}}` —— 数组嵌在 `data.data`。
 *
 * **刻意不复用 {@link parseLobsteraiEnvelope}**：那个信封要求 `data` 必须是
 * 对象（用于把「凭据失效返回 `data:null`」判成失败，见其注释），而本端点的
 * 真实 `data` 恰恰是**数组**。复用它会让信封恒定返回 `ok:false`，进而使整个
 * 模型列表恒为空数组，适配器再静默回退到静态兜底表 ——
 * 症状就是「远端已上线的新模型在面板里看不到」，且不报任何错。
 *
 * `code !== 0` 或结构不符时返回空数组，由调用方回退兜底目录。
 */
export function readLobsteraiModelArray(body) {
    if (typeof body !== 'object' || body === null)
        return [];
    const record = body;
    if ((readNumberField(record, 'code') ?? -1) !== 0)
        return [];
    const data = record.data;
    if (Array.isArray(data))
        return data;
    if (typeof data === 'object' && data !== null) {
        const nested = data.data;
        if (Array.isArray(nested))
            return nested;
    }
    return [];
}
/**
 * 解析 `GET /api/models/available` 的响应。
 *
 * 取 `modelId`/`modelName` 与模型参数（见 {@link LobsteraiRemoteModel}）。
 * `provider`/`apiFormat`/`runtimeProfile` 等字段不取：前者是上游内部字段，
 * 后者是 IDE 内置 agent 内核的编排概念，对 OpenAI 兼容转发没有意义。
 *
 * 形状兼容性见 {@link readLobsteraiModelArray}。
 */
export function parseLobsteraiModels(body) {
    const raw = readLobsteraiModelArray(body);
    const models = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const id = readStringField(record, 'modelId');
        if (id.length === 0)
            continue;
        const name = readStringField(record, 'modelName');
        const model = { id, name: name.length > 0 ? name : id };
        // 可选字段：只在远端确实给出合法值时才带上（见接口注释的「不编造值」约定）。
        const contextWindow = readNumberField(record, 'contextWindow');
        if (contextWindow !== undefined && contextWindow > 0)
            model.contextWindow = contextWindow;
        const maxTokens = readNumberField(record, 'maxTokens');
        if (maxTokens !== undefined && maxTokens > 0)
            model.maxTokens = maxTokens;
        if (typeof record.supportsImage === 'boolean')
            model.supportsImage = record.supportsImage;
        if (typeof record.supportsThinking === 'boolean')
            model.supportsThinking = record.supportsThinking;
        const thinkingConfig = parseLobsteraiThinkingConfig(record.thinkingConfig);
        if (thinkingConfig !== undefined)
            model.thinkingConfig = thinkingConfig;
        if (Array.isArray(record.requestCapabilities)) {
            const capabilities = record.requestCapabilities.filter((c) => typeof c === 'string');
            if (capabilities.length > 0)
                model.requestCapabilities = capabilities;
        }
        const description = readStringField(record, 'description');
        if (description.length > 0)
            model.description = description;
        // 计费倍率：**裸数字**（实测 0.05 / 1.08 / 20）。与 buddy 系的字符串
        // `"x0.05"` 形态不同，故各自解析。只在为正数时带上（0 在业务上无意义）。
        const costMultiplier = readNumberField(record, 'costMultiplier');
        if (costMultiplier !== undefined && costMultiplier > 0)
            model.costMultiplier = costMultiplier;
        models.push(model);
    }
    return models;
}
/**
 * 构造模型列表请求的 query 串（keyfrom 身份载荷）。
 *
 * 注意**不含 `refreshToken`** —— `client.go:229-241` 只用了 `KeyfromBody()`
 * 的字段（firstKeyfrom/latestKeyfrom/version/uuid/userId）。
 * 把 refreshToken 放进 query 既是信息泄露（会进服务端访问日志），
 * 也不是该端点的预期输入。
 */
export function buildLobsteraiModelsQuery(credential, clientVersion) {
    const body = lobsteraiKeyfromBody(credential, clientVersion);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string' && value.length > 0)
            params.set(key, value);
    }
    return params.toString();
}
/** 将消息内容载荷展平为纯文本字符串。 */
function contentToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => typeof block === 'object' && block !== null && block.type === 'text')
        .map((block) => String(block.text))
        .join('');
}
/** 工具结果内嵌图片的载体文本（与 buddy / 官方 deepseek 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
/**
 * 把 harness 内容块转成 OpenAI 多模态 parts。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— 这是服务端**唯一**接受的
 * 形态（2026-09-17 实测）：`{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 `collectImages` 对称地**递归**处理 `tool-result` 内层：收集侧是任意深度，
 * 序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
 */
function userContentParts(content, imageUrls) {
    const parts = [];
    let hasImage = false;
    for (const raw of content) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const block = raw;
        if (block.type === 'text') {
            const text = String(block.text ?? '');
            if (text.length > 0)
                parts.push({ type: 'text', text });
            continue;
        }
        if (block.type === 'image') {
            hasImage = true;
            const url = block.attachment?.attachmentId === undefined
                ? undefined
                : imageUrls.get(String(block.attachment.attachmentId));
            // 解析不到字节时留占位文本，而不是静默吞掉整张图。
            parts.push(url === undefined
                ? { type: 'text', text: '[image unavailable]' }
                : { type: 'image_url', image_url: { url } });
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content)) {
            const inner = userContentParts(block.content, imageUrls);
            if (inner !== undefined) {
                hasImage = true;
                parts.push(...inner);
            }
            else {
                // 内层无图：保留其文本，避免内容丢失。
                const text = contentToText(block.content);
                if (text.length > 0)
                    parts.push({ type: 'text', text });
            }
        }
    }
    return hasImage && parts.length > 0 ? parts : undefined;
}
/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
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
/**
 * 将 harness 对话消息序列化为 OpenAI chat-completions 传输格式。
 *
 * 与 buddy 适配器的差异：这里**不强制** assistant 携带 `reasoning_content`
 * （那是腾讯后端对推理模型的要求，未在 LobsterAI 上实测），
 * 但仍保留其中的**通用协议要求**：
 * - 孤儿工具调用清理（见 `resolveToolPairing` 的说明，后端会 400）；
 * - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）。
 *
 * 图片：`imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined
 * （**含空 Map**）时把 user 消息升级为多模态 parts。空 Map 不能降级为
 * undefined —— 那会让「图片存在但字节读取失败」的 `[image unavailable]`
 * 占位符也被跳过，图片静默消失。
 */
function serializeMessages(messages, imageUrls) {
    const wire = [];
    // OpenAI 兼容协议要求 tool_call 与 tool 结果严格配对：缺任一侧后端都会
    // 以 400 拒绝整个请求，而这条坏历史会被每次请求原样重放 ——
    // 表现为「会话突然报废，此后所有消息都无回复」。发出前剔除可让会话自愈。
    // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
    // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，结果 id
    // 集合恒为空 → `resolveToolPairing` 把**全部 tool_calls 剔除**，模型看不到
    // 自己调用过什么，表现为「无工具调用即判对话结束」或「陷入循环思考」。
    const normalized = normalizeHarnessMessages(messages);
    const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
    // 工具结果内嵌图片（`read_image` 等）不能并入 `role:'tool'` 消息：该角色的
    // content 只能是字符串，且必须紧跟其 assistant tool_call，中间插消息会 400。
    // 故挂起到其后的独立 user 消息统一发出（与 buddy 适配器同款处理）。
    let pendingToolImages = [];
    const flushToolImages = () => {
        if (pendingToolImages.length === 0)
            return;
        wire.push({
            role: 'user',
            content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
        });
        pendingToolImages = [];
    };
    for (const message of normalized) {
        if (message.role === 'assistant') {
            // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
            // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
            // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
            const content = stripCourseLeakFromHistoryContent(message.role, Array.isArray(message.content) ? message.content : []);
            const toolCalls = content
                .filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-call')
                .filter(block => keepCallIds.has(String(block.id)))
                .map((block) => ({
                id: String(block.id),
                type: 'function',
                function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
            }));
            const reasoning = content
                .filter((block) => typeof block === 'object' && block !== null && block.type === 'reasoning')
                .map((block) => String(block.text))
                .join('');
            const text = contentToText(content);
            // 挂起的工具结果图片必须在 assistant 之前发出，否则会漂到这条
            // assistant 之后，与产生它们的工具调用脱节。
            flushToolImages();
            wire.push({
                role: 'assistant',
                // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
                content: text.length === 0 && toolCalls.length > 0 ? null : text,
                ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        if (message.role === 'system') {
            flushToolImages();
            wire.push({ role: 'system', content: contentToText(message.content) });
            continue;
        }
        // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResults = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-result');
        const text = contentToText(message.content);
        // 工具结果之外的常规内容（含顶层图片）。
        const regular = content.filter((block) => !(typeof block === 'object' && block !== null && block.type === 'tool-result'));
        const parts = imageUrls === undefined ? undefined : userContentParts(regular, imageUrls);
        if (parts !== undefined) {
            flushToolImages();
            wire.push({ role: 'user', content: parts });
        }
        else if (text.length > 0 || toolResults.length === 0) {
            flushToolImages();
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            // 丢弃孤儿工具结果：没有对应 assistant tool_call 的结果同样会让后端 400。
            if (!keepResultIds.has(String(result.toolCallId)))
                continue;
            // 内嵌图片挂起到其后的 user 消息；文本留在 tool 消息里。
            let resultText = '(no output)';
            if (imageUrls !== undefined && Array.isArray(result.content)) {
                const resultParts = userContentParts(result.content, imageUrls);
                if (resultParts !== undefined) {
                    pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'));
                    const joined = resultParts
                        .filter((part) => part.type === 'text')
                        .map((part) => String(part.text))
                        .join('');
                    if (joined.length > 0)
                        resultText = joined;
                }
                else {
                    resultText = contentToText(result.content) || '(no output)';
                }
            }
            else {
                resultText = contentToText(result.content) || '(no output)';
            }
            wire.push({
                role: 'tool',
                tool_call_id: String(result.toolCallId),
                content: resultText,
            });
        }
    }
    flushToolImages();
    return wire;
}
/** 安全读取 Error.message。 */
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    try {
        return String(error);
    }
    catch {
        return 'unknown error';
    }
}
/**
 * 上游把错误放进 **SSE 流内帧**（HTTP 200 + `{error:{message}}`）时抛出的错误。
 *
 * ⚠️ **必须是可识别的独立类型**：换号循环要据此区分「这个账号此刻失败了，
 * 换个号可以重试」与「传输中断 / 用户取消 / 已产出内容后的错误 —— 换号重放
 * 会污染输出」。仅凭 message 文本无法可靠区分。
 *
 * 携带 {@link kind}（已分类）与 {@link detail}（原始 message，用于诊断），
 * 使流内错误与 HTTP 非 2xx 在换号循环里**共享同一套处理**。
 */
class LobsteraiStreamError extends LlmError {
    kind;
    detail;
    constructor(message, kind, detail, options) {
        super(message, kind === 'hard-credit' ? 'QUOTA_EXCEEDED' : 'SERVER', options);
        this.kind = kind;
        this.detail = detail;
    }
}
/**
 * 构造换号循环终止时的最终错误。
 *
 * 三种情形共用（避免三处文案与错误码各自漂移）：
 * 1. **无账号池 / 策略不轮转**：如实报错；
 * 2. **候选耗尽**（池里没有下一个账号，或已达 `MaxRotate` 上限）：
 *    报「所有账号均不可用」并带上**最后一次**的真实原因；
 * 3. **流内错误**：原文是业务 message（如「免费额度已用完，请升级套餐」），
 *    直接呈现，不再套 `errorDetail` 的 JSON 解析（那会原样返回文本，无害但冗余）。
 *
 * ⚠️ 错误码按**最后一次**失败的 kind/status 决定（成组同源）：早期实现把
 * `kind` 留在循环外只算一次，导致「A=402(积分不足) → B=503」时错误码变成
 * SERVER，用户完全看不到真实原因（见 `lobsterai-review-findings.md` S3）。
 */
function buildLobsteraiFailure(input) {
    const { kind, status, text, model, fromStream, exhausted } = input;
    const detail = fromStream ? text : errorDetail(text);
    // 额度耗尽是最主要的失败模式，必须用可读文案明确告知（而非泛泛的 HTTP 错误）。
    if (kind === 'hard-credit') {
        const prefix = exhausted
            ? `lobsterai: 模型 ${model} 所有账号均不可用`
            : 'lobsterai: 积分不足';
        return new LlmError(`${prefix}（${detail}）`, 'QUOTA_EXCEEDED', { status });
    }
    if (exhausted) {
        return new LlmError(`lobsterai: 模型 ${model} 所有账号均不可用（${detail}）`, fromStream ? 'SERVER' : httpErrorCode(status), { status });
    }
    return new LlmError(`lobsterai: ${detail}`, fromStream ? 'SERVER' : httpErrorCode(status), { status });
}
/** 从错误体提取可读 detail 文本。 */
function errorDetail(body) {
    try {
        const data = JSON.parse(body);
        const parts = [
            typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
            typeof data.message === 'string' ? data.message : undefined,
            typeof data.msg === 'string' ? data.msg : undefined,
        ].filter((value) => value !== undefined);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch {
        // 非 JSON 错误体
    }
    return body;
}
/** 将 HTTP 状态码映射为 harness 错误码。 */
function httpErrorCode(status) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400)
        return 'INVALID_REQUEST';
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/**
 * 判断是否为传输级错误（可重试的 TRANSPORT）。
 *
 * 与 buddy 适配器同源：半开连接与 TCP 重置都会以这些特征出现。
 */
function isTransportError(error) {
    if (!(error instanceof Error))
        return false;
    const message = error.message.toLowerCase();
    if (message.includes('terminated'))
        return true;
    if (error.name.startsWith('UND_ERR_'))
        return true;
    if (message.includes('fetch failed'))
        return true;
    if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up'))
        return true;
    return false;
}
/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量覆盖
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取** ——
 * 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs() {
    return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000;
}
/** LobsterAI 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class LobsteraiAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    remoteModels;
    /** 远端下发的模型元数据（id → 条目），listModels/resolveModel 共用。 */
    remoteMeta = new Map();
    /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
    fallbackIndex;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? LOBSTERAI;
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
     * 懒加载远端模型目录（仅拉取一次）。
     *
     * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels`
     * 被调用（如直接从历史会话进入），此时同样需要触发一次拉取。
     */
    async ensureRemoteModels() {
        if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined)
            return;
        try {
            const models = await this.options.fetchRemoteModels();
            if (models.length > 0) {
                this.remoteModels = models;
                this.remoteMeta = new Map(models.map((model) => [model.id, model]));
            }
        }
        catch {
            // 远端不可用：回退兜底目录（由 staticFallbackModels 提供）。
        }
    }
    /**
     * 模型接受的输入模态。
     *
     * 远端 `supportsImage` 是权威来源（实测 26 个模型里 19 个为 true）。
     * 远端未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会以 400 失败）。
     */
    inputModalitiesFor(model) {
        return this.remoteMeta.get(model)?.supportsImage === true ? ['text', 'image'] : ['text'];
    }
    /**
     * 模型的上下文窗口：远端权威值优先，兜底表估值次之。
     *
     * 兜底表统一写 131072，而实测远端多数模型返回 1000000 —— 采信估值会让
     * DSH 在远未用满窗口时就触发上下文压缩。
     */
    contextWindowFor(model) {
        return this.remoteMeta.get(model)?.contextWindow ?? this.fallbackIndex.get(model)?.contextWindow;
    }
    /**
     * 模型可选的思考档位。
     *
     * ## `id` 与 `name` 的来源**不同**（这是本方法最容易搞错的地方）
     *
     * - **`id` = `openclawLevel`（wire 值）**：DSH 会把选中的 id 原样写进请求体的
     *   `reasoning_effort`，故必须是服务端认的取值。⚠️ wire 侧**没有 `max`** ——
     *   实测直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），
     *   发 `'xhigh'` 才真正触发最高档。
     * - **`name` = `level`（产品侧档位名）**：纯展示。远端把 `level: 'max'` 映射到
     *   `openclawLevel: 'xhigh'`，用户在产品侧看到的就是 **Max**。
     *
     * ⚠️ **历史缺陷**（用户报障 / Issue #IKHCZF）：早期用 `openclawLevel` 同时查
     * 展示名表，于是最强档显示成 **XHigh**，与产品侧命名 **Max** 不一致 ——
     * 用户按 IDE 里的「Max」找，界面上却只有「XHigh」。
     * 根因是把「wire 值」与「展示名」当成同一个概念。
     *
     * 无 `thinkingConfig` 的模型不声明 `reasoning`，UI 显示「当前模型未提供推理等级」，
     * 而不是给一个发了也没用的档位。
     */
    reasoningFor(model) {
        const config = this.remoteMeta.get(model)?.thinkingConfig;
        if (config === undefined)
            return undefined;
        // defaultEffort 必须落在 efforts 内：DSH 会拿它直接发请求，
        // 给一个不存在的档位比不给更糟。远端数据不一致时退化为不声明默认值。
        // `defaultLevel` 引用的是**产品侧 level**，故先按 level 找到那一档，再取它的 wire 值。
        const defaultWire = config.options.find((option) => option.level === config.defaultLevel)?.openclawLevel;
        return {
            efforts: config.options.map((option) => ({
                id: ReasoningEffortId(option.openclawLevel),
                // 展示名优先用**产品侧 `level`**（含 `max`），再回退到按 wire 值查表。
                // 回退分支只为兼容「上游只给 wire 值」的异常形态，正常不会走到。
                name: EFFORT_NAMES[option.level] ?? EFFORT_NAMES[option.openclawLevel] ?? option.level,
            })),
            ...defaultWire !== undefined
                ? { defaultEffort: ReasoningEffortId(defaultWire) }
                : {},
        };
    }
    /**
     * 静态兜底模型目录。
     *
     * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：
     * LobsterAI 的远端接口是**权威的**（产品兜底表本身就是从它实测抄来的），
     * 远端可用时应完全采信，兜底只在远端整体失败时顶替。
     *
     * ⚠️ 兜底表**不含 `costMultiplier`**：它是编译期快照，而价格会变；
     * 远端整体失败时拿不到权威倍率，此时**不显示**倍率（不猜）。
     */
    staticFallbackModels() {
        return this.product.fallbackModels.map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
        }));
    }
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     */
    listAllModels() {
        const source = this.remoteModels ?? this.staticFallbackModels();
        return source.map((model) => ({ id: model.id, name: displayNameFor(model) }));
    }
    async listModels(_provider) {
        // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
        // 不必拉。返回空数组 → DSH 的 `buildModelCatalog` 把整个 provider 分组隐藏。
        // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`）。
        if (!await providerCatalogVisible(this.options.accountPool, this.product.id))
            return [];
        await this.ensureRemoteModels();
        const source = this.remoteModels ?? this.staticFallbackModels();
        // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const listed = disabled === undefined || disabled.size === 0
            ? source
            : source.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            // 倍率写进 name（**不是** description）：composer 的模型切换菜单只渲染
            // `name`，description 仅用于 /model 弹窗。见 displayNameFor 的说明。
            name: displayNameFor(model),
            ...model.description !== undefined ? { description: model.description } : {},
            // 远端 supportsImage 权威；未声明时保守报 text（见 inputModalitiesFor）。
            inputModalities: this.inputModalitiesFor(model.id),
        }));
    }
    async resolveModel(provider, model, _signal) {
        await this.ensureRemoteModels();
        const remoteName = this.remoteMeta.get(model)?.name;
        const resolved = {
            provider,
            id: model,
            name: remoteName ?? this.fallbackIndex.get(model)?.name ?? model,
            inputModalities: this.inputModalitiesFor(model),
        };
        // 上下文窗口：远端权威值优先，兜底表估值次之（见 contextWindowFor）。
        const contextWindow = this.contextWindowFor(model);
        if (contextWindow !== undefined)
            resolved.context = { contextWindow };
        // 单次输出上限：仅当远端声明时才带（不编造默认值）。
        const maxTokens = this.remoteMeta.get(model)?.maxTokens;
        if (maxTokens !== undefined)
            resolved.defaultMaxTokens = maxTokens;
        // 思考档位：远端 thinkingConfig 权威（见 reasoningFor 的 wire 值说明）。
        const reasoning = this.reasoningFor(model);
        if (reasoning !== undefined)
            resolved.reasoning = reasoning;
        return resolved;
    }
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` 同款 shim。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    /** 解析客户端版本号（未注入时用兜底值）。 */
    async clientVersion() {
        if (this.options.resolveClientVersion === undefined)
            return this.product.fallbackClientVersion;
        try {
            return await this.options.resolveClientVersion();
        }
        catch {
            return this.product.fallbackClientVersion;
        }
    }
    async *stream(options) {
        // 远端模型元数据必须在**图片能力判定之前**就位（见下方 inputModalitiesFor）：
        // 它决定该模型是否接受图片，而元数据只能从远端目录拿到。
        await this.ensureRemoteModels();
        // 图片能力按**模型**判定（远端 `supportsImage`），不是按 provider 一刀切：
        // 实测 26 个模型里 19 个支持图片，7 个纯文本。对不支持的模型明确报错
        // 而不是静默丢弃（静默丢弃会让用户以为模型看到了图片）。
        //
        // 注意这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
        // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!this.inputModalitiesFor(options.model).includes('image')) {
                throw new LlmError(`lobsterai: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('lobsterai: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
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
        if (credential === undefined || isLobsteraiExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('lobsterai: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // 2. 记录当前账号（限流时可切换）
        let currentAccountId = '';
        if (this.options.accountPool) {
            try {
                currentAccountId = await this.options.accountPool.findAccountIdByCredential(this.product.id, credential.access_token);
                if (currentAccountId === '') {
                    // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
                    // 此时限流无法归属到具体账号，UI 上也显示不出标记。
                    console.warn('[lobsterai] 当前凭据未匹配到账号池条目，限流记录将被跳过');
                }
            }
            catch (error) {
                console.warn('[lobsterai] 账号匹配失败（不影响本次请求）:', error);
            }
        }
        // 3. 构造请求体
        const messages = serializeMessages(options.messages, imageUrls);
        if (options.system !== undefined && options.system.length > 0) {
            messages.unshift({ role: 'system', content: options.system });
        }
        const tools = options.tools?.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        const bodyObj = {
            model: options.model,
            messages,
            // **恒为 true**：上游只支持 SSE，stream:false 会返回 500
            // （`client.go:168-195` prepareChatBody 强制改写）。
            stream: true,
        };
        if (tools !== undefined && tools.length > 0)
            bodyObj.tools = tools;
        // 关于 `tool_choice`：Go 桥接层要把它归一化（`""` / `"none"` / `null`
        // 一律删除，见 `client.go:176-189` 的 `prepareChatBody`），那是因为它
        // **转发任意 OpenAI SDK 客户端发来的原始 body**，无法预知里面写了什么。
        //
        // 本适配器是自己构造 body：DSH 的 `GenerateOptions` 根本没有 `toolChoice`
        // 字段（见 dsh-llm 的 types.d.ts），所以 `tool_choice` 天然不会出现 ——
        // 目标状态（字段缺席）已经达成，无需再写一段无效的归一化代码。
        if (options.temperature !== undefined)
            bodyObj.temperature = options.temperature;
        if (options.maxTokens !== undefined)
            bodyObj.max_tokens = options.maxTokens;
        if (options.stop !== undefined && options.stop.length > 0)
            bodyObj.stop = options.stop;
        // 思考等级：仅在调用方显式传入时透传，不主动补档
        // （buddy 那套「deepseek 系必须补档否则不思考」是针对腾讯后端的实测，
        // 未在 LobsterAI 上验证，照搬会造成非法参数 400）。
        if (options.reasoningEffort !== undefined) {
            bodyObj.reasoning_effort = options.reasoningEffort;
        }
        // **不发 prompt_cache_key**：那是腾讯后端的前缀缓存机制，此处未实测支持。
        const body = JSON.stringify(bodyObj);
        // 4. 发送请求（401/403 时刷新一次凭据后重试）
        let response = await this.send(credential, body, options);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('lobsterai: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            credential = refreshed;
            response = await this.send(credential, body, options);
        }
        // 5. 统一的重试循环：**HTTP 非 2xx 与流内错误帧都参与换号**。
        //
        // ⚠️ 这是用户报障「一个账号用完出错但没有切换」的**根因**。
        // 额度耗尽是以 **HTTP 200 + SSE 流内错误帧** 表达的（Web 上那句
        // 「lobsterai: 免费额度已用完，请升级套餐」正是 `consumeSse` 里
        // `data.error.message` 的产物），而早期实现把整个换号循环放在
        // `if (!response.ok)` **之内** —— 流内错误在消费阶段才抛出，
        // 根本走不到换号逻辑，于是池里还有可用账号也不会被尝试。
        //
        // 现在两种失败模式共用同一个循环与同一套成组状态（status / kind / text
        // 必须同源），换号、记徽章、上限与错误构造都只有一份实现。
        const tried = new Set();
        if (currentAccountId)
            tried.add(currentAccountId);
        // 当前这次失败的**成组**状态（三者必须同源，见下方说明）。
        let lastStatus = response.status;
        let lastKind = 'none';
        let lastText = '';
        /** 本次失败是否来自流内错误帧（决定错误文案与错误码的映射）。 */
        let lastFromStream = false;
        for (let attempt = 0;; attempt++) {
            if (response.ok) {
                // 消费流。**只有在尚未产出任何内容时才允许换号** —— 见下方 catch 的说明。
                let emitted = false;
                try {
                    for await (const chunk of this.consumeSse(response, options)) {
                        emitted = true;
                        yield chunk;
                    }
                    return;
                }
                catch (error) {
                    // 传输/超时错误：如实抛出，由 harness 决定是否重试整个回合（不在这里换号）。
                    if (!(error instanceof LobsteraiStreamError))
                        throw error;
                    // ⚠️ **已产出内容后绝不能换号**（真实缺陷，2026-09-23 修复）。
                    //
                    // 换号会重放一次请求，而新的 `consumeSse` 是**全新的生成器** ——
                    // 它的 `nextIndex` 从 0 重新开始，于是会**再发一次
                    // `block-start(index=0)`**。DSH 对重复块索引是**硬失败**：
                    //
                    //   `dsh-llm/lib/invariant.js`:
                    //     case "block-start":
                    //       if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`)
                    //
                    // 也就是说：已产出内容后换号不仅会把两个账号的正文拼在一起，
                    // 还会把「额度耗尽」这个可读错误升级成 harness 的 invariant 崩溃 ——
                    // 比不换号更糟（用户看到一个与真实原因无关的内部错误）。
                    //
                    // 此时如实抛出即可：harness 会重试整个回合，而在那次请求里
                    // 本账号的失败通常发生在**首帧**（尚未产出内容），可干净换号。
                    if (emitted)
                        throw error;
                    // 流内业务错误（如额度耗尽）且**尚未产出任何内容**：换号重试。
                    // 这正是用户报障「一个账号用完出错但没有切换」的修复点 ——
                    // 额度耗尽的错误帧是流里的**第一帧**，此前却因为整段换号逻辑
                    // 位于 `if (!response.ok)` 之内而完全走不到。
                    lastFromStream = true;
                    lastStatus = response.status;
                    lastKind = error.kind;
                    lastText = error.detail;
                }
            }
            else {
                lastFromStream = false;
                lastText = await response.text().catch(() => '');
                lastStatus = response.status;
                lastKind = classifyLobsteraiError(lastStatus, lastText);
            }
            // 用**本轮**的 kind 判断是否该记徽章：只有 Go 里真正 `Cooldown(...)`
            // 的三类才记（见 `recordsLobsteraiRateLimit` 的说明），且必须记在
            // **真正失败的那个账号**上 —— currentAccountId 在下面会被推进到下一个账号。
            if (currentAccountId && recordsLobsteraiRateLimit(lastKind)) {
                // 两层取值：优先 `parseRateLimitError` 从错误体里抠出**服务端声明的**
                // 重置时刻；抠不到则用本地兜底。两者都要能落地 ——
                // 若在抠不到时直接跳过记录，UI 上就不会出现任何限流标记，
                // 「重测/重置」按钮也就无从操作。
                const parsed = parseRateLimitError(lastText, options.model);
                await this.options.accountPool.updateModelRateLimit(currentAccountId, parsed?.modelId ?? options.model, 
                // `parseRateLimitError` 内部要求错误体是 JSON（它 `JSON.parse` 取 msg），
                // 而部分上游/网关会用**纯文本** 429。此时它返回 null，这里用
                // 「1 小时后」兜底 —— 与它自己 JSON 路径下的 fallback 同一口径，
                // 也与本插件「标记只是快照、可主动重测」的语义一致。
                parsed?.resetTimeMs ?? Date.now() + LOBSTERAI_RATE_LIMIT_FALLBACK_MS);
            }
            // 无账号池（或策略判定不该轮转）：如实报错，不做换号。
            if (!this.options.accountPool || !shouldRotateLobsteraiAccount(lastKind)) {
                throw buildLobsteraiFailure({
                    kind: lastKind, status: lastStatus, text: lastText,
                    model: options.model, fromStream: lastFromStream, exhausted: false,
                });
            }
            // 换号次数上限，对齐 Go 的 `MaxRotate`（`handler.go:190` 的
            // `for i := 0; i < h.cfg.MaxRotate; i++`，默认值 3 见
            // `server.NewHandler`）。防雪崩：账号池很大时若逐个试完，
            // 一次用户请求会打出 N 个上游请求，放大延迟与额度消耗。
            //
            // ⚠️ **减 1**：Go 的循环计数**包含首个账号**（它每次迭代都
            // `PickExcluding` 取一个号），而本适配器在进入这个循环**之前**
            // 已经用首个凭据发过一次请求了。若这里不减，总请求数会变成
            // 1 + MaxRotate = 4，比 Go 多一次。
            if (attempt >= LOBSTERAI_MAX_ROTATE - 1) {
                throw buildLobsteraiFailure({
                    kind: lastKind, status: lastStatus, text: lastText,
                    model: options.model, fromStream: lastFromStream, exhausted: true,
                });
            }
            // 必须把 `tried` 传给池：失败类别为 5xx / 请求错误时**不写限流标记**
            // （它们不是限流，不该留徽章），刚失败的账号仍是池里排序第一，
            // 不排除就会拿回同一个账号、命中下面的 `tried.has` 而**立即 break**
            // —— 换号形同虚设。对齐 Go 的 `PickExcluding(tried)`（`pool.go:131`）。
            const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried);
            if (!next || tried.has(next.entry.id)) {
                throw buildLobsteraiFailure({
                    kind: lastKind, status: lastStatus, text: lastText,
                    model: options.model, fromStream: lastFromStream, exhausted: true,
                });
            }
            tried.add(next.entry.id);
            credential = next.credential;
            currentAccountId = next.entry.id;
            response = await this.send(credential, body, options);
        }
    }
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    async send(credential, body, options) {
        const clientVersion = await this.clientVersion();
        const headers = new Headers(lobsteraiChatHeaders(credential, this.product, clientVersion));
        try {
            return await this.fetchImpl(`${this.product.apiBase}${LOBSTERAI_CHAT_PATH}`, {
                method: 'POST',
                headers,
                body,
                signal: options.signal,
            });
        }
        catch (error) {
            if (options.signal?.aborted)
                throw error;
            if (isTransportError(error)) {
                throw new LlmError(`lobsterai: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
            }
            throw error;
        }
    }
    /**
     * 消费 SSE 响应并产出 `StreamChunk`。
     *
     * 上游返回标准 OpenAI SSE。移植了 Go 侧 `Aggregate` 的三处兼容处理：
     * 1. **容忍 `data:` 后无空格**（`sse.go:37-39` 注释写明「龙虾上游实测无空格」）——
     *    这里靠 `line.slice(5).trim()` 天然兼容两种形态；
     * 2. `reasoning_content` 单独成块（`sse.go:74-76`）；
     * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
     *
     * 额外保留 buddy 适配器里两条实测得出的防坑规则（与厂商无关，属协议层）：
     * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，
     *   直接覆盖会清空已解析出的工具名 → `unknown tool ""`；
     * - **`finish_reason` 映射顺序**：`length` / 中途断流 / 参数残缺一律归为
     *   `max-tokens`，否则 harness 会执行残缺 JSON 参数并污染会话历史。
     */
    async *consumeSse(response, options) {
        if (!response.body)
            throw new LlmError('lobsterai: empty model response body', 'EMPTY_RESPONSE');
        const blocks = [];
        let nextIndex = 0;
        /**
         * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
         * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
         *
         * 与 buddy 同因：`reasoning_tokens` **计入** `completion_tokens`，思考陷入
         * 病态重复就把输出额度烧光、正文零产出，而 `finish` 若是 `stop`，UI 上
         * 完全看不出错误。
         */
        const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let loopDetected = false;
        /**
         * **正文**死循环检测（**独立实例**，见 `createReasoningLoopDetector`）。
         *
         * 真实缺陷（用户报障，2026-09-25）：唯一活动 session 出现**正文**循环，
         * 而旧实现只在 reasoning 分支调 `observe` → 正文循环完全看不见。
         *
         * ⚠️ 两个实例不可合并：判据看尾部 3000 字符窗口的行去重率，两条通道
         * 混进同一窗口会互相稀释，使守卫双双失效。
         *
         * ⚠️ 语义差异：实测正文循环的工具调用在循环正文**之后**到达且有效，
         * 故正文守卫**只截断文本**，绝不 `reader.cancel()`、绝不改 finish reason。
         */
        const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let proseLoopDetected = false;
        /** `</think:hex>` 泄漏探测（跨帧，收尾再切分）。 */
        let proseHasThinkTag = false;
        /**
         * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
         * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
         *
         * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
         * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
         * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
         */
        const suppressor = createBlankReasoningSuppressor();
        const toolCalls = new Map();
        const toolOrder = [];
        const toolIds = new Map();
        let buffer = '';
        let streamEnded = false;
        let finishReason;
        /**
         * 是否已通过 `delta.content` 收到过正文。
         *
         * 用途与 Go 的 `gotAnyContent`（`sse.go:72,98`）一致：一旦为 true，
         * 就不再采纳 `message.content` 这条兼容回退路径，避免两种下发形态
         * 同时出现时把内容重复拼接。
         */
        let gotAnyContent = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let firstTokenReceived = false;
        try {
            for (;;) {
                if (streamEnded)
                    break;
                let result;
                try {
                    const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
                    const phase = firstTokenReceived ? 'chunk' : 'first-token';
                    result = await readWithIdleTimeout(reader, timeoutMs, 'lobsterai', options.signal, phase);
                    if (!result.done)
                        firstTokenReceived = true;
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw error;
                    if (error instanceof LlmError)
                        throw error;
                    if (isTransportError(error)) {
                        throw new LlmError(`lobsterai: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
                    }
                    throw error;
                }
                if (result.done)
                    break;
                buffer += decoder.decode(result.value, { stream: true });
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith('data:'))
                        continue;
                    // 兼容 "data: {...}" 与 "data:{...}"（上游实测无空格）。
                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') {
                        streamEnded = true;
                        break;
                    }
                    let data;
                    try {
                        data = JSON.parse(payload);
                    }
                    catch {
                        continue;
                    }
                    if (data.error !== undefined) {
                        // ⚠️ 必须抛**可分类的** `LobsteraiStreamError`：额度耗尽正是以
                        // 这个形态下发的（HTTP 200 + `{error:{message:'免费额度已用完，请升级套餐'}}`），
                        // 而早期这里抛的是裸 `LlmError`（固定 SERVER），换号循环
                        // 既看不到它、也无法判断该不该换号 —— 用户报障
                        // 「一个账号用完出错但没有切换」的直接原因。
                        const detail = data.error.message ?? 'unknown error';
                        throw new LobsteraiStreamError(`lobsterai: ${detail}`, classifyLobsteraiStreamError(detail), detail);
                    }
                    const choice = data.choices?.[0];
                    const delta = choice?.delta;
                    if (typeof choice?.finish_reason === 'string') {
                        finishReason = choice.finish_reason;
                    }
                    // `message.content` 只是**兼容回退**：有的上游把完整消息放在 message
                    // 而非 delta 里（对齐 `sse.go:97-102`）。它与 delta 是**互斥**的两种
                    // 下发形态，不能同时采纳 —— 一旦某个 chunk 既有 delta.content 又有
                    // message.content，无守卫的 `??` 会把两段都拼进去。
                    //
                    // Go 用 `&& !gotAnyContent`（`sse.go:98`，标志位在 `sse.go:72`
                    // 每次写入 delta.content 时置 true）表达「只要已经收到过正文，
                    // 就再也不采纳 message 形态」。这里照搬该语义。
                    // 注意 `typeof === 'string'` 而非 `!== undefined`：真实线上形态里
                    // 一个模型要么走 content、要么走 reasoning_content，**另一侧恒为
                    // `null`**（实测 335 帧中 content=null 有 227 帧）。只判 undefined
                    // 会让 `.length` 在 null 上崩溃，表现为「每轮对话第一帧就报
                    // Cannot read properties of null」。
                    const deltaContent = delta?.content;
                    const textDelta = typeof deltaContent === 'string' && deltaContent.length > 0
                        ? deltaContent
                        : (!gotAnyContent && typeof choice?.message?.content === 'string' ? choice.message.content : undefined);
                    if (textDelta !== undefined && textDelta.length > 0) {
                        if (typeof deltaContent === 'string' && deltaContent.length > 0)
                            gotAnyContent = true;
                        let block = blocks.find(candidate => candidate.kind === 'text');
                        if (block === undefined) {
                            block = { index: nextIndex++, kind: 'text', text: '' };
                            blocks.push(block);
                            yield { type: 'block-start', index: block.index, blockType: 'text' };
                        }
                        // 正文死循环守卫（见 `proseLoopGuard` 注释）。与思考守卫的差异：
                        // 命中后**只停止累积与发射**，绝不 `reader.cancel()`、绝不改
                        // finish reason —— 工具调用在循环正文之后到达且有效。
                        if (proseLoopGuard !== undefined) {
                            if (proseLoopGuard.observe(textDelta))
                                proseLoopDetected = true;
                        }
                        // `</think:hex>` 泄漏探测（跨帧，故只做子串判定，收尾再切分）。
                        if (!proseHasThinkTag && textDelta.includes('think:'))
                            proseHasThinkTag = true;
                        if (!proseLoopDetected) {
                            block.text += textDelta;
                            yield { type: 'text-delta', index: block.index, text: textDelta };
                        }
                    }
                    // 同样必须用 `typeof === 'string'`：`reasoning_content` 也会显式返回
                    // null（实测 335 帧中 107 帧为 null）。
                    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                        // 死循环守卫：命中后不再累积、不再发射。
                        //
                        // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
                        // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
                        // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
                        //
                        // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：它会
                        // 连带跳过本帧位于 reasoning 分支**之后**的 `usage`，导致 token
                        // 记账静默丢失。故用 `if (!loopDetected)` 守卫分支体。
                        if (loopGuard !== undefined) {
                            if (loopGuard.observe(delta.reasoning_content))
                                loopDetected = true;
                        }
                        if (!loopDetected) {
                            // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
                            // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
                            const emit = suppressor.feed(delta.reasoning_content);
                            if (emit !== undefined) {
                                let block = blocks.find(candidate => candidate.kind === 'reasoning');
                                if (block === undefined) {
                                    block = { index: nextIndex++, kind: 'reasoning', text: '' };
                                    blocks.push(block);
                                    yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
                                }
                                // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本。
                                block.text = suppressor.text();
                                yield { type: 'reasoning-delta', index: block.index, text: emit };
                            }
                        }
                    }
                    for (const call of delta?.tool_calls ?? []) {
                        const wireIndex = call.index ?? 0;
                        if (typeof call.id === 'string' && call.id.length > 0)
                            toolIds.set(wireIndex, call.id);
                        const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
                        let block = toolCalls.get(wireIndex);
                        if (block === undefined) {
                            block = { index: nextIndex++, text: '', callId, announced: false };
                            toolCalls.set(wireIndex, block);
                        }
                        block.callId = callId;
                        // 只允许非空名字覆盖：后续分片带空串 "" 会清空首个分片解析出的工具名，
                        // 表现为 `unknown tool ""`。
                        if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
                            block.name = call.function.name;
                        }
                        const fragment = call.function?.arguments ?? '';
                        block.text += fragment;
                        // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` /
                        // `buddy-adapter.ts` 同因同修）。只跳过收尾的 `block-end` 不够 ——
                        // `BlockAssembler` 会把没有 block-end 的 partial 也组装成
                        // `name:''`，污染会话后让腾讯系端点以 400 code 11133 拒绝之后每一次请求。
                        if (!block.announced) {
                            if (!hasUsableToolName(block.name))
                                continue;
                            block.announced = true;
                            toolOrder.push(block.index);
                            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                            yield {
                                type: 'tool-call-delta',
                                index: block.index,
                                id: ToolCallId(callId),
                                name: block.name,
                                argumentsDelta: block.text,
                            };
                            continue;
                        }
                        yield {
                            type: 'tool-call-delta',
                            index: block.index,
                            id: ToolCallId(callId),
                            ...block.name !== undefined ? { name: block.name } : {},
                            argumentsDelta: fragment,
                        };
                    }
                    if (data.usage) {
                        const promptTokens = data.usage.prompt_tokens ?? 0;
                        // 缓存命中字段有多处来源，取首个有值的（与 buddy 侧同口径）。
                        const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
                            ?? data.usage.prompt_cache_hit_tokens
                            ?? 0;
                        const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
                        yield {
                            type: 'usage',
                            usage: {
                                // inputTokens 只计**未命中缓存**的部分，命中部分单列
                                // cacheReadTokens，否则缓存命中率显示会偏大。
                                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                                outputTokens: data.usage.completion_tokens ?? 0,
                                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                                ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
                            },
                        };
                    }
                }
                // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
                // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
                // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
                //
                // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
                // 的 `usage` / `[DONE]` 因此仍会被处理，但命中后**立即**退出，不再读下一块。
                //
                // ⚠️ 只 cancel **reader**，绝不 abort `options.signal`：后者是调用方信号，
                // abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`
                // （DSH 在 `max-tokens` 时**不自动重试**，由用户/上层决定是否继续）。
                // ⚠️ `.catch(() => {})` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把
                // 「正常止损」变成一次失败。
                if (loopDetected) {
                    await reader.cancel().catch(() => { });
                    break;
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        /**
         * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
         *
         * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
         * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
         * 或被清洗成空串的块。用 `blocks.length` 会把「零块响应」误判成「有块」，
         * 于是静默结束的缺陷原样保留。
         *
         * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
         */
        let blockCount = 0;
        // 按创建顺序关闭每个块
        const textBlock = blocks.find(block => block.kind === 'text');
        for (const index of toolOrder) {
            const block = [...toolCalls.values()].find(candidate => candidate.index === index);
            blockCount += 1;
            yield {
                type: 'block-end',
                index,
                block: {
                    type: 'tool-call',
                    id: ToolCallId(block.callId ?? ''),
                    name: block.name,
                    // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
                    // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
                    // 合法外观，让 harness 报 missing required property 而非重试。
                    arguments: isTruncatedArguments(block.text)
                        ? block.text
                        : normalizeToolArguments(block.text),
                },
            };
        }
        if (textBlock !== undefined) {
            // ── `</think:hex>` 泄漏归位（见 `splitThinkTaggedContent`）──
            // 标签**前**的内心独白 → reasoning 块；标签**后**的真正文 → 本 text 块。
            // 无标签时**逐字节不变**。
            let textOut = textBlock.text;
            if (proseHasThinkTag) {
                const split = splitThinkTaggedContent(textBlock.text);
                if (split !== undefined) {
                    // ⚠️ **必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为
                    // reasoning 块的权威，只改 `blocks` 条目不生效。
                    if (split.reasoning !== '') {
                        const existing = blocks.find(candidate => candidate.kind === 'reasoning');
                        if (existing === undefined) {
                            blocks.push({ index: nextIndex++, kind: 'reasoning', text: split.reasoning });
                        }
                        else {
                            existing.text += split.reasoning;
                        }
                        suppressor.feed(split.reasoning);
                    }
                    textOut = split.text;
                }
            }
            // 正文死循环截断：只保留循环前的干净前缀。
            // ⚠️ **不改 finish reason**：工具调用仍要被执行。
            const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
                ? textOut.slice(0, proseLoopGuard.cutAt)
                : textOut;
            // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
            const cleaned = stripCourseLeakIfEnabled(truncated);
            // ⚠️ 归位后正文可能为空串 —— 空块会污染会话，且 DSH 的
            // `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，故仍有产出。
            if (cleaned !== '') {
                blockCount += 1;
                yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: cleaned } };
            }
        }
        const reasoningBlock = blocks.find(block => block.kind === 'reasoning');
        // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
        if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
            // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
            // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
            // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
            //
            // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
            // `reasoningBlock.text` —— 两者累积口径若不一致，以 helper 为准才能
            // 保证落块内容与 wire 一致。
            const suppressedReasoning = suppressor.text();
            const reasoningText = loopDetected && loopGuard?.cutAt !== undefined
                ? suppressedReasoning.slice(0, loopGuard.cutAt)
                : suppressedReasoning;
            // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
            const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText);
            if (cleanedReasoning !== '') {
                blockCount += 1;
                yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: cleanedReasoning } };
            }
        }
        // 三种「不完整」都必须报告 max-tokens 而非 tool-calls：
        // - 'length'：被 max_tokens 显式截断；
        // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
        // - 参数无法解析：分片丢失（并行工具调用时偶发）。
        // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，
        // 模型收到莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试，
        // 实测一次即恢复。
        //
        // 另：丢弃了无名 tool-call 且没有留下任何可用调用时，同样报 max-tokens
        // 而非 stop（否则模型本意调工具、harness 却认为「正常答完了」）。
        const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text));
        const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced);
        const reason = loopDetected
            // 思考死循环：截断并报可重试。**优先级最高** —— 循环中生成的工具调用
            // 参数不可信；且若无可用调用，落到 `stop` 会让任务静默中断。
            ? { kind: 'max-tokens' }
            : finishReason === 'length'
                || (finishReason === undefined && toolOrder.length > 0)
                || argsTruncated
                || (droppedUnnamedCalls && toolOrder.length === 0)
                ? { kind: 'max-tokens' }
                : finishReason === 'tool_calls' || toolOrder.length > 0
                    ? { kind: 'tool-calls' }
                    : { kind: 'stop' };
        // 零内容块响应（例如本次只收到过那个被压制的空白 reasoning）否则会以
        // `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令禁止的静默结束。
        // ⚠️ 传入的是**上面已算好的** `reason`（含 loopDetected / length /
        // 无名 tool-call 等全部既存判据）；helper 只在 `kind === 'stop'` 时改写。
        yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) };
    }
}
/**
 * 生成模型选择器里显示的名字：`模型名 · x0.05`。
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。用户报障
 * 「消耗倍率没有显示在切换模型列表的后面」正是因为早期版本放在了
 * `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`
 * （`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话。
 *
 * 形态差异：本 provider 的 `costMultiplier` 是**裸数字**（`0.05`），
 * 展示时补 `x` 前缀（buddy 系远端给的字符串本身已带 `x`）。
 */
function displayNameFor(model) {
    if (model.costMultiplier === undefined)
        return model.name;
    return `${model.name} · x${model.costMultiplier}`;
}
/**
 * 在 `ctx.llm` 上注册 LobsterAI provider 路由与适配器。
 *
 * 路由名与配置页展示名由产品配置驱动，得到 `lobsterai`。`settingsNs` 经
 * `settingsNamespaceFor()` 解析：老契约（≤0.1.6）下是 `llm-lobsterai`；
 * 0.1.7-rc.1 起 settings 命名空间只能是 profile 条目 id，故解析为本插件条目 id。
 */
export function registerLobsteraiLlm(ctx, options) {
    const product = options.product ?? LOBSTERAI;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new LobsteraiAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
    // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
    return adapter;
}
/** 构造远端模型列表请求的完整 URL（供 auth 服务与测试复用）。 */
export function buildLobsteraiModelsUrl(product, credential, clientVersion) {
    const query = buildLobsteraiModelsQuery(credential, clientVersion);
    const base = `${product.apiBase}${LOBSTERAI_MODELS_PATH}`;
    return query.length > 0 ? `${base}?${query}` : base;
}
/** 模型列表请求超时（与其它控制面请求一致）。 */
export const LOBSTERAI_MODELS_TIMEOUT_MS = LOBSTERAI_REQUEST_TIMEOUT_MS;
//# sourceMappingURL=lobsterai-adapter.js.map