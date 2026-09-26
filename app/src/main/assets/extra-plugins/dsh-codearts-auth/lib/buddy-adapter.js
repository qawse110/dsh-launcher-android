/**
 * buddy (腾讯 CodeBuddy) LlmAdapter
 *
 * 使用标准 OpenAI Chat Completions 协议 + Bearer access_token 鉴权。
 * 认证由 buddy-auth.ts 服务完成（external-link-v2 轮询式登录 + refresh_token 续期）。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 模型列表：静态默认（对齐 /v3/config craft agent models）+ 登录后的动态拉取
 */
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isRateLimited, parseRateLimitError } from './llm-adapter.js';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { HTTP_HEADER_DOMAIN, HTTP_HEADER_PRODUCT, HTTP_HEADER_PRODUCT_CODE, credentialExpiresAtMs, formatCreditsRate, } from './buddy.js';
import { CODEBUDDY, resolveUserAgent } from './product.js';
import { normalizeHarnessMessages } from './message-shape.js';
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js';
/**
 * CodeBuddy（中国版）的 chat completions 基址。
 *
 * 仅供既有导入方（如 e2e 探针）使用；适配器实例实际请求的基址是
 * `` `${this.product.endpoint}/v2` `` —— 国际版 WorkBuddy 的域名不同
 * （www.workbuddy.ai），故不能再用本常量拼接请求 URL。
 */
export const CHAT_API_BASE = 'https://copilot.tencent.com/v2';
/**
 * 是否为 DeepSeek 系模型（前缀匹配，不区分大小写）。
 *
 * 对齐 workbuddy2api-panel `thinking.go` 的 `isDeepSeekModel` 判定口径与
 * 官方客户端 `thinkingFormat:"deepseek"` 标记：deepseek 系模型「开思考」
 * 必须显式带 `thinking:{type:"enabled"}` + `reasoning_effort` 档位，缺任一
 * 上游都按不思考应答（`reasoning_content` 为空/缺失）。glm/kimi 等其他模型
 * 走各自 thinkingFormat（默认开或 `enable_thinking`），不需要此开关。
 */
function isDeepSeekModel(model) {
    return /^deepseek/i.test(model.trim());
}
/**
 * CodeBuddy 的 provider 路由名（历史常量，保留导出以兼容既有导入方）。
 *
 * 注意：适配器实例实际使用的路由名是 `product.id`（`this.product.id`），
 * 本常量只表示 CodeBuddy 那一份取值，不再代表所有产品。
 */
export const PROVIDER = 'buddy';
/** 静态默认模型（对齐 /v3/config 返回的 craft agent models；动态拉取失败时的兜底）。 */
const DEFAULT_MODELS = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
    'hy4-preview-x',
    'hy3',
    'hy3-x',
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'glm-5v-turbo',
    'kimi-k3-1',
    'kimi-k2.7',
    'kimi-k2.6',
    'minimax-m3',
];
/** 默认模型（deepseek-v4-flash，对齐 IDE 默认）。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash';
/**
 * 模型上下文窗口（对齐 Rust BuddyProvider::context_limit 的静态 fallback 表；
 * 权威来源是 /v3/config data.models[].maxInputTokens，由 fetchRemoteModels
 * 动态拉取后经 resolveRemoteContextWindow 优先采用，此表仅作远端不可用时的兜底）。
 */
const CONTEXT_WINDOWS = new Map([
    ['deepseek-v4-flash', 1_000_000],
    ['deepseek-v4-pro', 1_000_000],
    ['hy4-preview', 1_000_000],
    ['hy4-preview-x', 1_000_000],
    ['hy3', 192_000],
    ['hy3-x', 192_000],
    ['glm-5.3', 1_000_000],
    ['glm-5.3-flash', 1_000_000],
    ['glm-5.2', 1_000_000],
    ['glm-5.1', 200_000],
    ['glm-5v-turbo', 200_000],
    ['kimi-k3-1', 1_000_000],
    ['kimi-k2.7', 256_000],
    ['kimi-k2.6', 256_000],
    ['minimax-m3', 512_000],
]);
/**
 * 模型是否接受图片输入（远端 /v3/config `supportsImages` 不可用时的兜底）。
 *
 * 权威来源是远端下发的 `supportsImages`；此表只在远端未下发该字段时使用。
 * 实测（2026-09 /v3/config）craft agent 的对话模型全部 supportsImages=true，
 * 故这里列出全部对话模型，非对话模型（codewise-* 等）不在此表内。
 */
const IMAGE_MODELS = new Set([
    'deepseek-v4-flash',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-sg',
    'deepseek-v4-pro',
    'hy4-preview',
    'hy4-preview-f',
    'hy4-preview-x',
    'hy3',
    'hy3-x',
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'glm-5v-turbo',
    'kimi-k3',
    'kimi-k3-1',
    'kimi-k2.8-preview',
    'kimi-k2.7',
    'kimi-k2.6',
    'minimax-m3',
]);
/**
 * 各模型可选的思考等级（远端 `reasoning.supportedEfforts` 不可用时的兜底）。
 *
 * 只列出**可枚举**等级的模型；仅有固定默认 effort 的模型（glm-5.1/kimi-*）
 * 不在此表内，即不向用户暴露等级选择器。
 */
const REASONING_EFFORTS = new Map([
    ['deepseek-v4-flash', ['low', 'high', 'max']],
    ['deepseek-v4.1-flash', ['low', 'high', 'max']],
    ['deepseek-v4-pro', ['low', 'high', 'xhigh']],
    ['hy4-preview', ['high']],
    ['hy4-preview-x', ['high']],
    ['hy3', ['low', 'high']],
    ['hy3-x', ['low', 'high']],
    ['glm-5.3', ['low', 'high', 'max']],
    ['glm-5.3-flash', ['low', 'high', 'max']],
    ['glm-5.2', ['high', 'xhigh']],
]);
/** 思考等级 id → 展示名（对齐 DeepSeek 官方 provider 的命名）。 */
const EFFORT_NAMES = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
};
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
/**
 * 将 harness 对话消息序列化为 CodeBuddy chat-completions 的传输格式。
 *
 * 与 openai_chat/codearts 适配器一致：assistant 的 `tool-call` 块转为
 * `tool_calls`，`reasoning` 块折叠为 `reasoning_content`，user 消息中搭载的
 * 工具结果展开为独立的 `{role: 'tool'}` 消息。
 *
 * 两点 CodeBuddy 特有要求（对齐 Rust buddy.rs）：
 * - assistant 消息**始终**携带 `reasoning_content` 字段（推理模型缺失会 400）
 *   ——与 codearts 的 deepseek-v4 校验一致；
 * - 正文为空且带 tool_calls 时 `content` 必须为 `null`（对齐 openai_chat.rs）。
 */
/** 工具结果内嵌图片的载体文本（与官方 deepseek 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
function serializeMessages(messages, imageUrls) {
    const wire = [];
    // 工具结果内嵌图片（read_image 等）不能并入 `role:'tool'` 消息：OpenAI 兼容
    // 协议要求每条 tool 消息紧跟其 assistant tool_call，中间插入任何消息都会 400。
    // 故与官方 deepseek 适配器一致：挂起到其后的独立 user 消息统一发出。
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
    // ── 孤儿工具调用清理（会话续命的关键）──
    // OpenAI 兼容协议要求：带 `tool_calls` 的 assistant 消息，其**每一个**
    // tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；反之，
    // `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
    // 400 拒绝整个请求。
    //
    // 工具执行失败时（参数非法、超时、工具不存在……）harness 会把 assistant
    // 的 tool_calls 持久化进会话历史，却写不回结果消息。这条坏历史随后被
    // **每次请求原样重放**，于是后端对之后每一条用户消息都返回 400——表现为
    // "任务突然中断，此后发送任何内容都没有回复"，整个会话彻底报废。
    //
    // 适配器是最后一道防线：发出请求前把无法配对的 tool_calls 与 tool 结果
    // 一并剔除，让会话自愈。宁可丢失一轮工具上下文，也好过整条会话死亡。
    // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
    // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，下面所有
    // 按 `type === 'tool-result'` 的判据恒不命中 → 结果 id 集合为空 →
    // `resolveToolPairing` 把**全部 tool_calls 剔除**，模型看不到自己调用过什么，
    // 表现为「无工具调用即判对话结束」或「陷入循环思考」。
    const normalized = normalizeHarnessMessages(messages);
    const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
    for (const message of normalized) {
        if (message.role === 'assistant') {
            // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
            // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
            // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
            const content = stripCourseLeakFromHistoryContent(message.role, Array.isArray(message.content) ? message.content : []);
            const toolCallBlocks = content
                .filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-call')
                .filter(block => keepCallIds.has(String(block.id)));
            const toolCalls = toolCallBlocks.map((block) => ({
                id: String(block.id),
                type: 'function',
                function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
            }));
            const reasoning = content
                .filter((block) => typeof block === 'object' && block !== null && block.type === 'reasoning')
                .map((block) => String(block.text))
                .join('');
            const text = contentToText(content);
            // 挂起的工具结果图片必须在 assistant 之前发出（对齐官方适配器）：
            // 否则它们会漂到这条 assistant 之后，与产生它们的工具调用脱节。
            flushToolImages();
            wire.push({
                role: 'assistant',
                // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
                content: text.length === 0 && toolCalls.length > 0 ? null : text,
                reasoning_content: reasoning,
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        if (message.role === 'system') {
            flushToolImages();
            wire.push({ role: 'system', content: contentToText(message.content) });
            continue;
        }
        // user 角色：工具结果搭载在 harness 用户消息中；展开为独立的 role:'tool' 消息。
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResults = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-result');
        const text = contentToText(message.content);
        // 工具结果之外的常规内容（含顶层图片）。
        const regular = content.filter((block) => !(typeof block === 'object' && block !== null && block.type === 'tool-result'));
        // 含图片时 content 升级为 OpenAI 多模态 parts（CodeBuddy 唯一接受的图片
        // 形态；{type:'image'} 会以 `unsupported content type ... image` 400）。
        //
        // 注意：这里**不能**把「空 Map」也降级为 undefined。`imageUrls` 为 undefined
        // 只发生在整个请求都没有图片时；若图片存在但全部读取失败，map 是**空的**
        // 而非 undefined。降级成 undefined 会让 `[image unavailable]` 占位符也被跳过，
        // 图片静默消失；只有部分失败时（map 非空）才会出现占位符 —— 同一故障两种
        // 表现。保留空 Map 可让 `userContentParts` 统一产出占位符。
        const regularImageUrls = imageUrls;
        const parts = regularImageUrls === undefined
            ? undefined
            : userContentParts(regular, regularImageUrls);
        if (parts !== undefined) {
            flushToolImages();
            wire.push({ role: 'user', content: parts });
        }
        else if (text.length > 0 || toolResults.length === 0) {
            flushToolImages();
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            // 丢弃孤儿工具结果：没有对应 assistant tool_call 其结果同样会让后端 400。
            if (!keepResultIds.has(String(result.toolCallId)))
                continue;
            // 工具结果内嵌的图片（read_image 等）单独收集：文本继续走 `role:'tool'`，
            // 图片挂起到其后的 user 消息 —— 与原实现相比，这里补上了递归分支，
            // 否则图片会被 contentToText 静默丢弃（只留元数据文本）。
            let resultText = '(no output)';
            if (regularImageUrls !== undefined && Array.isArray(result.content)) {
                const resultParts = userContentParts(result.content, regularImageUrls);
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
/** 从错误体提取可读 detail 文本。 */
function errorDetail(body) {
    try {
        const data = JSON.parse(body);
        const error = typeof data.error === 'object' && data.error !== null
            ? data.error
            : undefined;
        const parts = [
            typeof error?.code === 'string' ? error.code : undefined,
            typeof error?.type === 'string' ? error.type : undefined,
            typeof error?.message === 'string' ? error.message : undefined,
            typeof data.message === 'string' ? data.message : undefined,
        ].filter((value) => value !== undefined);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch {
        // 非 JSON 错误体
    }
    return body;
}
/**
 * 将 HTTP 状态码映射为 harness 错误码。
 *
 * 400 需要看**响应体**才能区分「上下文超限」与「普通请求错误」：前者必须归为
 * CONTEXT_WINDOW_EXCEEDED，才能触发 DSH 的 context-overflow 自动压缩恢复
 * （dsh-compaction-basic 监听 `agent/request-error`，只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败压缩上下文并重试）；
 * 若一律标成 INVALID_REQUEST，长会话一旦越过窗口就会直接把裸错误抛给用户。
 *
 * 实测报文（国际版 WorkBuddy，deepseek-v4.1-flash）：
 * ```
 * {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum",
 *  "extError":{"code":"context_length_exceeded","type":"invalid_request_error",...},
 *  "displayMsg":{"en":"The request exceeds the model context limit. ..."}}
 * ```
 * 注意该报文的 `msg` 是「prompt is too long」措辞、`extError.code` 是
 * `context_length_exceeded`，两者都能被 `isContextWindowExceededError` 识别。
 *
 * 与 CodeArts 适配器（llm-adapter.ts 的 httpErrorCode）同一判定口径，但
 * **传入原始 body 而非 errorDetail(body)**：`errorDetail` 在能提取到
 * `error.*` / `message` 时会返回拼接后的短文本，从而丢掉 `extError`、
 * `displayMsg` 等字段——实测「仅 msg 文本」这种输入会被
 * `isContextWindowExceededError` 漏判（其正则要求出现 context/for-the-model
 * 字样），而完整 body 因含 `extError.code = context_length_exceeded` 能稳定命中。
 * 判定看完整报文、展示用归一化文本，两者职责不同。
 */
function httpErrorCode(status, body) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        // 先判上下文超限，再退回通用 INVALID_REQUEST。
        if (isContextWindowExceededError(body))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/**
 * SSE 流空闲超时。buddy（CodeBuddy）后端对 SSE 连接有空闲断连策略：模型
 * 生成超长推理或大工具调用参数时，两次 chunk 之间可能静默数十秒。原实现
 * 直接 `await reader.read()` 且没有任何超时——连接被服务端掐断后若对端
 * 既不发数据也不关连接（半开连接），read() 会**永久挂起**，generator 永不
 * 返回，harness 当前步骤既不出结果也不报错，会话永久停留在"运行中"：web
 * 端表现为进度停止、发送按钮置灰、后续"继续"指令完全无响应。
 *
 * 主动以略小于后端超时窗口的间隔检测空闲，超时则取消 reader 并抛可重试
 * 的 TIMEOUT，让 harness 重试该步骤并把控制权交还给用户。
 *
 * 分两个阶段，与 codearts 适配器保持一致：
 * - firstTokenTimeout：等待首个 chunk 的窗口（模型排队 / 长思考时较长）；
 * - chunkTimeout：收到首 chunk 后，两次 chunk 之间的最大静默（每次成功
 *   读取后重置）。
 *
 * 两者均可由环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT 路径，
 * 或线上针对特定模型调优。在每次 stream() 调用时读取，避免模块顶层常量
 * 在 import 时定型导致测试中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs() {
    return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000;
}
/** 判断是否为传输级错误。 */
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
 * 把 user 消息内容块转为 OpenAI 多模态 parts；无图片时返回 undefined，
 * 让调用方保持原有的纯字符串路径（无图请求的线上格式不变，避免破坏前缀缓存）。
 *
 * `tool-result` 分支为**递归**，与 `collectImages()` 的递归深度保持一致：
 * 二者若不对称，出现在深层工具结果里的图片会被 collectImages 收进 refs、
 * 却因这里只走一层而在序列化阶段被静默丢弃（连 `[image unavailable]`
 * 占位符都没有）。实测 harness 目前只产生一层嵌套，但既然收集侧已经是
 * 任意深度，序列化侧就必须同样递归，否则是一处埋着的静默丢图。
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
            // 递归取内层 parts：内层只要出现图片，hasImage 即为真，
            // 从而让整条消息升级为多模态形态。
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
/** 收集 user 消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
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
/** buddy (腾讯 CodeBuddy 系) 模型适配器。使用 Bearer access_token 鉴权。 */
export class BuddyAdapter extends LlmAdapter {
    options;
    /** 本适配器所属的产品配置（默认 CodeBuddy）。 */
    product;
    fetchImpl;
    /**
     * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
     * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
     */
    sessionId;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    remoteModels;
    /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
    remoteMeta = new Map();
    /** 远端下发的模型上下文窗口（/v3/config data.models[].maxInputTokens）。 */
    remoteContextWindows = new Map();
    /**
     * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
     * 远端缺失时补位；构造时一次性建立，只读。
     */
    productFallbackIndex;
    /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
    productFallbackContextWindows;
    constructor(options) {
        super();
        this.options = options;
        // 默认 CodeBuddy，保证既有行为完全不变。
        this.product = options.product ?? CODEBUDDY;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '');
        const fallback = this.product.fallbackModels ?? [];
        this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]));
        this.productFallbackContextWindows = new Map(fallback
            .filter((model) => model.contextWindow !== undefined)
            .map((model) => [model.id, model.contextWindow]));
    }
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
     * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
     * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
     * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
     * 直接回退到本适配器所属产品的 id，避免
     * `undefined.toUpperCase is not a function` 在客户端炸开。
     *
     * 展示名同样来自产品配置：CodeBuddy 为 'CodeBuddy (腾讯)'，
     * WorkBuddy 为 'WorkBuddy'。
     */
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /**
     * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
     * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
     */
    /**
     * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
     * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
     * 触发一次远端拉取，保证 /v3/config 的 maxInputTokens 能生效。
     */
    async ensureRemoteModels() {
        if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined)
            return;
        try {
            const models = await this.options.fetchRemoteModels();
            if (models.length > 0) {
                // /v3/config data.models[] 是权威来源（对齐 Rust TUI buddy_context_limits
                // 注入逻辑）：远端下发的上下文窗口优先于静态 fallback 表；
                // 能力字段（supportsImages / reasoning.supportedEfforts）同理。
                const reconciled = this.reconcileWithFallback(models);
                this.remoteModels = reconciled;
                this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]));
                this.remoteContextWindows = new Map(reconciled
                    .filter((model) => model.contextWindow !== undefined)
                    .map((model) => [model.id, model.contextWindow]));
            }
        }
        catch {
            // 远端不可用：回退静态列表
        }
    }
    /**
     * 用产品兜底表校正远端结果。
     *
     * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
     * token 拿到的集合可能是残缺甚至错的 —— 实测 WorkBuddy 国际版的 CLI token
     * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
     * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
     *
     * 有产品兜底表时以它为准：
     * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
     * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）；
     * - ⚠️ **例外：被 agent 引用的模型即使不在兜底表也保留**（见下）。
     *
     * ⚠️ **为什么需要那个例外**：两个端点下发的 id 集合**不同**，而兜底表是
     * 编译期快照、只覆盖其中一套。实测（2026-09-21）`hy4-preview-f`
     * —— 新用户限时免费变体 —— **只由 `/v3/config` 下发**，且被
     * `craft`/`ask`/`plan` 三个 agent 引用（即服务端声明「对话里可选」），
     * 但**不在兜底表**里。白名单重建会把它丢掉，于是用户看不到那个免费变体，
     * 而 IDE 里能看到（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
     *
     * 判据用 `agentReferenced`（服务端自己的「可选」信号）而非猜测 id 后缀 ——
     * 后缀规则不统一（`-f` / `-x` / `-sg` / `-ioa` 含义各异），猜错会放进
     * 不可用的模型。未标记的内部别名（如 `default`）不会被误留。
     */
    reconcileWithFallback(models) {
        const fallback = this.product.fallbackModels;
        if (fallback === undefined || fallback.length === 0)
            return [...models];
        const remoteById = new Map(models.map((model) => [model.id, model]));
        const reconciled = fallback.map((entry) => {
            const remote = remoteById.get(entry.id);
            // 远端元数据优先（更权威），缺失的字段用兜底表补齐
            return {
                id: entry.id,
                name: remote?.name ?? entry.name,
                ...entry.contextWindow !== undefined || remote?.contextWindow !== undefined
                    ? { contextWindow: remote?.contextWindow ?? entry.contextWindow }
                    : {},
                // 输出上限同样「远端优先、兜底补位」：远端不下发时兜底表给保守值，
                // 两边都没有则留 undefined（不编造，见 resolveModel 的说明）。
                ...entry.maxOutputTokens !== undefined || remote?.maxOutputTokens !== undefined
                    ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens }
                    : {},
                ...entry.supportsImages !== undefined || remote?.supportsImages !== undefined
                    ? { supportsImages: remote?.supportsImages ?? entry.supportsImages }
                    : {},
                ...entry.reasoningEfforts !== undefined || remote?.reasoningEfforts !== undefined
                    ? { reasoningEfforts: [...(remote?.reasoningEfforts ?? entry.reasoningEfforts ?? [])] }
                    : {},
                ...entry.defaultReasoningEffort !== undefined || remote?.defaultReasoningEffort !== undefined
                    ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort }
                    : {},
                // 计费倍率只可能来自远端（兜底表是编译期快照，价格会变，不写死）。
                // 注意本函数是**白名单式重建**：不在这里显式搬运的字段会被静默丢弃，
                // 新增远端字段时必须同步加一行，否则 listModels 看不到它。
                ...remote?.creditsRate !== undefined ? { creditsRate: remote.creditsRate } : {},
                ...remote?.discountedCreditsRate !== undefined
                    ? { discountedCreditsRate: remote.discountedCreditsRate }
                    : {},
            };
        });
        // ⚠️ 追加「被 agent 引用但不在兜底表」的模型（见本方法注释的例外说明）。
        //
        // 放在**末尾**：兜底表里的模型保持原有顺序与权威性，补充的变体排在后面，
        // 不打乱用户已熟悉的列表顺序。
        const known = new Set(reconciled.map((model) => model.id));
        for (const model of models) {
            if (model.agentReferenced !== true || known.has(model.id))
                continue;
            known.add(model.id);
            reconciled.push({ ...model });
        }
        return reconciled;
    }
    /**
     * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
     *
     * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
     * 实测 `glm-5.1`（2026-09）：
     * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
     * - `/v3/config` → `supportsImages: true`
     * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
     *
     * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
     * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
     * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
     *
     * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
     * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
     * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
     * 必须先有真实请求证据。
     */
    static IMAGE_CAPABILITY_OVERRIDES = new Set([
        // scoped 端点误报 false，实测能看图。
        'glm-5.1',
    ]);
    /**
     * 模型接受的输入模态：远端 supportsImages 优先，静态表兜底；
     * {@link IMAGE_CAPABILITY_OVERRIDES} 中的模型强制为支持图片。
     */
    inputModalitiesFor(model) {
        const supportsImages = BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model)
            || (this.remoteMeta.get(model)?.supportsImages
                ?? this.productFallbackMeta.get(model)?.supportsImages
                ?? IMAGE_MODELS.has(model));
        return supportsImages ? ['text', 'image'] : ['text'];
    }
    /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
    effortsFor(model) {
        return this.remoteMeta.get(model)?.reasoningEfforts
            ?? this.productFallbackMeta.get(model)?.reasoningEfforts
            ?? REASONING_EFFORTS.get(model)
            ?? [];
    }
    /**
     * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
     *
     * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
     * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
     */
    defaultEffortFor(model) {
        const declared = this.remoteMeta.get(model)?.defaultReasoningEffort
            ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort;
        return declared !== undefined && this.effortsFor(model).includes(declared) ? declared : undefined;
    }
    /**
     * 产品级兜底模型目录（`product.fallbackModels`）。
     *
     * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
     * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
     */
    get productFallbackMeta() {
        return this.productFallbackIndex;
    }
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率 + 同名消歧）。
     *
     * 设置页（Jet Hub「显示列表」）必须把**被关闭的**模型也渲染出来，否则用户
     * 无法重新打开；而 `listModels` 会按黑名单过滤掉它们，RPC 层只能凭黑名单的
     * key（裸 id）补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率随之丢失**
     * （用户报障：「关闭的就没有显示倍率」）。
     *
     * ⚠️ 同名消歧必须基于**未过滤**的全量集合：`displayNameFor(model, source)`
     * 而非 `listed`。用过滤后的集合会让「关掉其中一个同名模型」改变另一个的
     * 变体标记，名字随开关跳变。
     */
    listAllModels() {
        const source = this.remoteModels ?? this.staticFallbackModels();
        return source.map((model) => ({ id: model.id, name: displayNameFor(model, source) }));
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
        // 按本适配器的产品 id 取表，CodeBuddy 与 WorkBuddy 的开关互不影响。
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const listed = disabled === undefined || disabled.size === 0
            ? source
            : source.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            name: displayNameFor(model, listed),
            inputModalities: this.inputModalitiesFor(model.id),
        }));
    }
    /**
     * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
     *
     * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
     * token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能拿到
     * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
     */
    staticFallbackModels() {
        const productModels = this.product.fallbackModels;
        if (productModels !== undefined && productModels.length > 0) {
            return productModels.map((model) => ({ id: model.id, name: model.name }));
        }
        return DEFAULT_MODELS.map((id) => ({ id, name: id }));
    }
    async resolveModel(provider, model, _signal) {
        await this.ensureRemoteModels();
        // 三级查找：远端 maxInputTokens → 产品兜底表 → 通用静态表
        // （对齐 Rust context_limit_for_model 的两级查找，多一层产品级）。
        const contextWindow = this.remoteContextWindows.get(model)
            ?? this.productFallbackContextWindows.get(model)
            ?? CONTEXT_WINDOWS.get(model);
        const resolved = {
            provider,
            id: model,
            name: this.remoteMeta.get(model)?.name ?? this.productFallbackIndex.get(model)?.name ?? model,
            inputModalities: this.inputModalitiesFor(model),
        };
        if (contextWindow !== undefined)
            resolved.context = { contextWindow };
        // 单次输出上限：远端 maxOutputTokens（实测 deepseek-v4.1-flash = 128000）
        // 优先，产品兜底表次之。
        //
        // **为什么必须声明**：DSH 在 `resolveCallWithInfo` 里只在调用方未显式给值时
        // 用 `defaultMaxTokens` 兜底，适配器不声明就等于把这个值永久交给网关默认
        // （实测网关默认仅 32000 —— 见远端 `auto` 模型的 maxOutputTokens）。结果是
        // 大文件写入 / 长回答在 32000 处被截断成 finish_reason:'length'，UI 报
        // 「已达到输出 token 上限」。这与 codearts 适配器显式发 max_tokens 的做法
        // （llm-adapter.ts）本应一致。
        //
        // 远端与兜底表都没有该模型的值时**保持 undefined**，交给网关默认值：
        // 编造一个偏大的值会让服务端 400 拒绝（参考 codearts 131072 被拒的实测），
        // 偏小则无谓截断用户输出。
        const maxOutputTokens = positiveMaxTokens(this.remoteMeta.get(model)?.maxOutputTokens ?? this.productFallbackMeta.get(model)?.maxOutputTokens);
        if (maxOutputTokens !== undefined)
            resolved.defaultMaxTokens = maxOutputTokens;
        // 思考等级：这是"思考强度"选择器出现在模型选择里的唯一入口——composer
        // 读取 resolveModel().reasoning。无等级可选的模型不声明该字段，UI 显示
        // "当前模型未提供推理等级"。
        const efforts = this.effortsFor(model);
        if (efforts.length > 0) {
            const remoteDefault = this.remoteMeta.get(model)?.defaultReasoningEffort
                ?? this.productFallbackIndex.get(model)?.defaultReasoningEffort;
            resolved.reasoning = {
                efforts: efforts.map((id) => ({
                    id: ReasoningEffortId(id),
                    name: EFFORT_NAMES[id] ?? id,
                })),
                ...remoteDefault !== undefined && efforts.includes(remoteDefault)
                    ? { defaultEffort: ReasoningEffortId(remoteDefault) }
                    : {},
            };
        }
        return resolved;
    }
    /**
     * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
     * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
     * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 1. 获取凭据（过期则先静默续期）
        let credential = await this.options.resolveCredential();
        if (credential === undefined || isCredentialExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('buddy: no usable credential; log in first with /buddy-login', 'MISSING_CREDENTIAL');
        }
        // Track current account for rate limit switching
        let currentAccountId = '';
        if (this.options.accountPool && credential) {
            try {
                // provider 实参必须是本适配器所属产品的 id（buddy / workbuddy）：
                // AccountPool 先按 entry.provider !== provider 过滤账号，写死 'buddy'
                // 时 WorkBuddy 账号（provider='workbuddy'）永远匹配不到，限流时间
                // 无法归属账号，UI 也永不显示限流标记。
                currentAccountId = await this.options.accountPool.findAccountIdByCredential(this.product.id, credential.access_token);
                if (currentAccountId === '') {
                    // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
                    // 此时限流无法归属到具体账号，也就无法在 UI 上显示标记。
                    console.warn(`[${this.product.id}] 当前凭据未匹配到账号池条目，限流记录将被跳过`);
                }
            }
            catch (error) {
                console.warn(`[${this.product.id}] 账号匹配失败（不影响本次请求）:`, error);
            }
        }
        // 能力判定（图片 / 思考强度）必须有远端目录在手：两者都以 /v3/config
        // 下发值为权威，而该拉取是懒加载的。缺了这一步，远端显式 false 会被
        // 静态兜底表覆盖，合法的思考等级也会被误判为不支持而丢弃。
        await this.ensureRemoteModels();
        // 2. 序列化消息
        // 图片：读原始字节并以内联 data URL 发出——这是 CodeBuddy 唯一接受的
        // 图片形态（{type:'image'} 会被服务端 400 拒绝）。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!this.inputModalitiesFor(options.model).includes('image')) {
                throw new LlmError(`buddy: model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('buddy: image input requires the attachment service.', 'UNSUPPORTED_CONTENT');
            }
            imageUrls = new Map();
            for (const [id, ref] of imageRefs) {
                let image;
                try {
                    image = await this.options.readImage(ref);
                }
                catch (error) {
                    // 读取抛错必须冒泡成明确的 LlmError：早先这里会把异常吞掉，
                    // 最终表现为「图片凭空消失、模型答非所问」，排查成本极高。
                    throw new LlmError(`buddy: 读取图片附件失败（${id}）：${errorMessage(error)}`, 'UNSUPPORTED_CONTENT', { cause: error });
                }
                if (image === undefined) {
                    // 契约要求：读不到字节时报错，绝不静默丢弃整张图。
                    // 返回 undefined 的典型成因是附件服务未就绪或对象已被清理；
                    // 若此处 continue，线上请求会退化成纯文本，用户只看到模型
                    // 「看不到图」而没有任何错误提示。
                    throw new LlmError(`buddy: 图片附件读取不到内容（${id}）；附件服务可能未就绪，或该对象已不存在。`, 'UNSUPPORTED_CONTENT');
                }
                imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
            }
        }
        const messages = serializeMessages(options.messages, imageUrls);
        if (options.system !== undefined && options.system.length > 0) {
            messages.unshift({ role: 'system', content: options.system });
        }
        const tools = options.tools?.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
        // 3. 构造请求体
        const bodyObj = {
            model: options.model,
            messages,
            stream: true,
            // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
            // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
            // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
            //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
            //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
            // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
            prompt_cache_key: this.sessionId,
        };
        if (tools !== undefined && tools.length > 0)
            bodyObj.tools = tools;
        if (options.temperature !== undefined)
            bodyObj.temperature = options.temperature;
        if (options.stop !== undefined && options.stop.length > 0)
            bodyObj.stop = options.stop;
        // 单次请求输出上限。此前**完全没有**下发该字段，导致上限由网关默认值决定
        // （实测仅 32000），大文件写入会在中途被截断成 `finish_reason:'length'`，
        // UI 报「已达到输出 token 上限」，且本地无从调整。
        //
        // 取值优先级：调用方显式给的 options.maxTokens（DSH 会先注入 resolveModel
        // 声明的 defaultMaxTokens）→ 远端 maxOutputTokens → 产品兜底表。
        // 三者皆无则不发该字段，保持网关默认（不编造，理由见 resolveModel）。
        const maxTokens = positiveMaxTokens(options.maxTokens
            ?? this.remoteMeta.get(options.model)?.maxOutputTokens
            ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens);
        if (maxTokens !== undefined)
            bodyObj.max_tokens = maxTokens;
        // DeepSeek 思维链开关（逆向官方 codebuddy.js，对齐 workbuddy2api-panel
        // thinking.go）。**实测关键结论（2026-09，直连三站点对照）**：
        //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
        //   - 仅带 reasoning_effort:high → 返回思考（148~250 字符）；
        //   - 仅带 thinking:{type:'enabled'} → 仍为 0（该字段单独无效）；
        //   - 两者都带 → 返回思考。
        // 即 **reasoning_effort 是真正的开关**，thinking 字段单独不生效（保留它是
        // 为对齐官方客户端出站形态，并覆盖未来后端按它判定的情形）。
        // 三站点（workbuddy 国际/中国 UA、codebuddy）行为一致 → endpoint/UA 无关。
        const deepseek = isDeepSeekModel(options.model);
        if (deepseek) {
            bodyObj.thinking = { type: 'enabled' };
        }
        // 思考强度：composer 选中的等级透传为 `reasoning_effort`（实测
        // low/high/max 会显著改变返回的 reasoning_content 长度，服务端真实生效）。
        // 只在该模型确实支持该等级时才发，否则服务端会因非法参数 400。
        const efforts = this.effortsFor(options.model);
        if (options.reasoningEffort !== undefined && efforts.includes(options.reasoningEffort)) {
            bodyObj.reasoning_effort = options.reasoningEffort;
        }
        else if (deepseek && efforts.length > 0) {
            // composer 未选档位（历史请求可能 `adapterDefaults: undefined`）或所选
            // 档位不被支持时，必须补一个档位——否则请求体里只剩 thinking，上游仍按
            // 不思考应答（实测）。回退顺序：声明默认档 → high（对齐官方客户端
            // REASONING_SUPPLEMENTS.defaultEffort 与 thinking.go 的兜底）→ 最低支持档
            // （绝不臆造模型未声明的档位，否则服务端 400）。
            bodyObj.reasoning_effort = this.defaultEffortFor(options.model)
                ?? (efforts.includes('high') ? 'high' : efforts[0]);
        }
        const body = JSON.stringify(bodyObj);
        // 4. 发送请求（401/403 时刷新一次凭据后重试）
        let response = await this.send(credential, body, options);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
            if (credential === undefined || credential.access_token.length === 0) {
                throw new LlmError('buddy: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            response = await this.send(credential, body, options);
        }
        if (!response.ok) {
            let errorText = await response.text().catch(() => '');
            // 限流处理：把当前账号在该模型上的重置时间记录下来，然后逐个尝试
            // 其余可用账号。每个失败账号都会被记录，只有真正试完全部候选才报
            // "所有账号均受限"——避免只试一个就下结论（那会让 UI 显示的限流
            // 状态与实际判定不一致）。
            if (this.options.accountPool && isRateLimited(errorText)) {
                const tried = new Set();
                if (currentAccountId)
                    tried.add(currentAccountId);
                for (;;) {
                    const parsed = parseRateLimitError(errorText, options.model);
                    if (!parsed)
                        break;
                    // 记录当前账号在该模型上的限流重置时间（UI 据此展示限流标记）
                    if (currentAccountId) {
                        await this.options.accountPool.updateModelRateLimit(currentAccountId, parsed.modelId, parsed.resetTimeMs);
                    }
                    // 取下一个未尝试过的可用账号（同样按本产品 id 过滤，否则 WorkBuddy
                    // 永远取不到候选账号，限流后无法自动切换）。
                    //
                    // 必须把 `tried` 传给池：见 `AccountPool.getAvailableAccount` 的说明 ——
                    // 池按「重置时间最早到期」排序，刚失败的账号可能仍排第一，
                    // 不排除就会拿回同一个、命中下面的 `tried.has` 而立即 break。
                    const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried);
                    if (!next || tried.has(next.entry.id))
                        break;
                    tried.add(next.entry.id);
                    credential = next.credential;
                    currentAccountId = next.entry.id;
                    response = await this.send(credential, body, options);
                    if (response.ok) {
                        yield* this.consumeSse(response, options);
                        return;
                    }
                    errorText = await response.text().catch(() => '');
                    if (!isRateLimited(errorText)) {
                        // 新账号失败但不是限流：按原错误分类抛出，不要再吞成"均受限"
                        throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
                    }
                }
                throw new LlmError(`buddy: 模型 ${options.model} 所有账号均受限，请稍后再试`, 'QUOTA_EXCEEDED');
            }
            throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
        }
        // 5. 消费 SSE 流
        yield* this.consumeSse(response, options);
    }
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    async send(credential, body, options) {
        const headers = new Headers(attributionHeaders());
        headers.set('Authorization', `Bearer ${credential.access_token}`);
        headers.set('Accept', 'text/event-stream');
        headers.set('Content-Type', 'application/json');
        headers.set(HTTP_HEADER_DOMAIN, credential.domain ?? this.product.apiDomain);
        headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode);
        // 用量归属头族：后台「使用端」列按这组头归因，缺任一个都会显示为 `-`。
        // 注意 X-Product 是**归属名**（产品名），不是部署类型 —— 历史实现发成
        // `SaaS` 导致后台归因不到产品。
        headers.set('X-Agent-Purpose', 'conversation');
        headers.set('X-IDE-Name', this.product.attributionName);
        headers.set('X-IDE-Type', this.product.attributionName);
        headers.set('X-IDE-Version', this.product.clientVersion);
        headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName);
        // User-Agent 按模型族分档：不同模型线归属不同客户端形态，后台据此分列。
        // 必须用 set 覆盖（attributionHeaders() 注入的框架 UA 键为小写，
        // 但 Headers 键大小写不敏感，set 能正常覆盖）。
        headers.set('User-Agent', resolveUserAgent(this.product, options.model));
        try {
            return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
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
                throw new LlmError(`buddy: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
            }
            throw error;
        }
    }
    /**
     * 消费 SSE 响应并产出 StreamChunk。
     *
     * CodeBuddy 返回标准 OpenAI SSE：`delta.content` 为正文、
     * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
     * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
     * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
     */
    async *consumeSse(response, options) {
        if (!response.body)
            throw new LlmError('buddy: empty model response body', 'EMPTY_RESPONSE');
        const blocks = [];
        let nextIndex = 0;
        /**
         * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
         * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
         *
         * 本路径正是用户实际报障的那条（`workbuddy/deepseek-v4.1-flash` 报
         * 「已达到输出 token 上限」）：`reasoning_tokens` 计入 `completion_tokens`，
         * 思考陷入病态重复就把 128000 额度烧光、正文零产出。
         */
        const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let loopDetected = false;
        /**
         * **正文**死循环检测（**独立实例**）。本路径正是用户实际报障的那条
         * （`lilishop-go` 会话 / `workbuddy/hy4-preview-f`）：该模型把思考写进
         * `content` 通道，正文出现真循环（去重率 0.0412），而旧实现只在
         * reasoning 分支调 `observe` → 正文循环**完全看不见**。
         *
         * ⚠️ 必须与 `loopGuard` **分成两个实例**：判据看的是尾部 3000 字符窗口的
         * 行去重率，两条通道混进同一窗口会互相稀释，使守卫**双双失效**。
         *
         * ⚠️ 与思考守卫的**语义差异**：实测正文循环的 wire 顺序恒为
         * `text-chunks(循环) → tool-call-chunks → finish: tool-calls` —— 工具调用
         * 在循环正文**之后**到达且有效。故正文守卫**只截断文本**，
         * **绝不 `reader.cancel()`、绝不改 finish reason**，否则会把有效调用
         * 整块丢掉（比循环本身更糟）。
         */
        const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let proseLoopDetected = false;
        /**
         * `</think:hex>` 泄漏的待定正文（见 `splitThinkTaggedContent`）。
         *
         * 标签可能**跨帧**到达（`</think:612` + `4c78e>`），故不能逐帧判定，
         * 必须缓冲到收尾时一次性切分。
         */
        let proseHasThinkTag = false;
        /**
         * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
         * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
         *
         * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
         * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
         * 就不发任何 chunk。本路径正是用户实际报障的那条
         * （`workbuddy/deepseek-v4.1-flash` 偶发只输出一个空格当思考，
         * 实测 2233 次、`usage.reasoningTokens = 1`）。
         */
        const suppressor = createBlankReasoningSuppressor();
        const toolCalls = new Map();
        const toolOrder = [];
        // tool_call index → 后端签发的真实 id。缺失时回退 call_{index}，
        // 保证 Start/Delta 使用同一 id。
        const toolIds = new Map();
        let buffer = '';
        let streamEnded = false;
        let finishReason;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        // 首 token 与 chunk 间超时分阶段使用：第一次读取用 firstTokenTimeout，
        // 收到首 chunk 后切换为 chunkTimeout 并在每次成功读取后重置。没有这层
        // 保护时，半开的 SSE 连接会让 read() 永久挂起，会话卡死在"运行中"。
        let firstTokenReceived = false;
        try {
            for (;;) {
                if (streamEnded)
                    break;
                let result;
                try {
                    const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
                    const phase = firstTokenReceived ? 'chunk' : 'first-token';
                    result = await readWithIdleTimeout(reader, timeoutMs, 'buddy', options.signal, phase);
                    if (!result.done)
                        firstTokenReceived = true;
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw error;
                    if (error instanceof LlmError)
                        throw error;
                    if (isTransportError(error)) {
                        throw new LlmError(`buddy: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
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
                        throw new LlmError(`buddy: ${data.error.message ?? 'unknown error'}`, 'SERVER');
                    }
                    const choice = data.choices?.[0];
                    const delta = choice?.delta;
                    if (typeof choice?.finish_reason === 'string') {
                        finishReason = choice.finish_reason;
                    }
                    if (delta?.content) {
                        let block = blocks.find(candidate => candidate.kind === 'text');
                        if (block === undefined) {
                            block = { index: nextIndex++, kind: 'text', text: '' };
                            blocks.push(block);
                            yield { type: 'block-start', index: block.index, blockType: 'text' };
                        }
                        // 正文死循环守卫（见 `proseLoopGuard` 注释）。
                        //
                        // ⚠️ 命中后**只停止累积与发射**，绝不 `reader.cancel()`、绝不改
                        // finish reason —— 工具调用在循环正文之后到达且有效（实测）。
                        // 截断靠收尾的 `block-end` 权威覆盖落地（见文件末尾 text 段）。
                        if (proseLoopGuard !== undefined) {
                            if (proseLoopGuard.observe(delta.content))
                                proseLoopDetected = true;
                        }
                        // `</think:hex>` 泄漏探测：标签可能跨帧，故只做廉价子串判定，
                        // 真正切分放在收尾（见文件末尾 text 段）。
                        if (!proseHasThinkTag && delta.content.includes('think:'))
                            proseHasThinkTag = true;
                        if (!proseLoopDetected) {
                            block.text += delta.content;
                            yield { type: 'text-delta', index: block.index, text: delta.content };
                        }
                    }
                    if (delta?.reasoning_content) {
                        // 死循环守卫：命中后不再累积、不再发射。
                        //
                        // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
                        // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
                        // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
                        //
                        // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：它会
                        // 连带跳过本帧位于 reasoning 分支**之后**的 `usage` 与 `tool_calls`
                        // —— 「reasoning + usage 同帧」时 usage 被静默丢弃（token 记账
                        // 缺失）。故用 `if (!loopDetected)` 守卫分支体。
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
                        if (typeof call.id === 'string' && call.id.length > 0) {
                            toolIds.set(wireIndex, call.id);
                        }
                        const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
                        let block = toolCalls.get(wireIndex);
                        if (block === undefined) {
                            block = { index: nextIndex++, text: '', callId, announced: false };
                            toolCalls.set(wireIndex, block);
                        }
                        block.callId = callId;
                        // 后续参数分片会带上空的 function.name（""），它不是 undefined，
                        // 直接覆盖会把首个分片解析出的真实工具名清空，导致
                        // `unknown tool ""`。只有非空名字才允许更新。
                        if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
                            block.name = call.function.name;
                        }
                        const fragment = call.function?.arguments ?? '';
                        block.text += fragment;
                        // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` 同因同修，
                        // 见该文件内的详细说明）。只跳过收尾的 `block-end` 不够 ——
                        // `BlockAssembler` 会把没有 block-end 的 partial 也组装成
                        // `name:''`，污染会话后让 workbuddy 以 400 code 11133 拒绝每次请求。
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
                        // 后端在六处回传缓存信息，其中 cached_tokens 同时出现在
                        // prompt_tokens_details 与 completion_tokens_details 里，但后者
                        // **恒为 0**（实测）——只认 prompt_tokens_details，误取会永远读到 0。
                        const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
                            ?? data.usage.prompt_cache_hit_tokens
                            ?? 0;
                        const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
                        const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
                        yield {
                            type: 'usage',
                            usage: {
                                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                                outputTokens: data.usage.completion_tokens ?? 0,
                                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                                ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
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
            // `toolOrder` 只收「名字已可用」的块，故此处名字必然可用；不回退成
            // `?? ''` —— 那会把空名字块写进会话，正是本次修复要根除的污染路径。
            if (!hasUsableToolName(block.name))
                continue;
            blockCount += 1;
            yield {
                type: 'block-end',
                index,
                block: {
                    type: 'tool-call',
                    id: ToolCallId(block.callId ?? ''),
                    name: block.name,
                    // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
                    // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
                    // 伪造出合法外观，让 harness 报 `missing required property` 而
                    // 非重试，掩盖真正的分片丢失。
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
            // 正文死循环截断：只保留循环前的干净前缀（与思考守卫同一覆盖机制）。
            // ⚠️ **不改 finish reason**：工具调用仍要被执行。
            const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
                ? textOut.slice(0, proseLoopGuard.cutAt)
                : textOut;
            // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
            const cleaned = stripCourseLeakIfEnabled(truncated);
            // ⚠️ 归位后正文可能为空串（实测 seq=34768 形态）—— 空块会污染会话，
            // 且 DSH 的 `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，
            // 故本响应仍有产出，不会被误判为零块。
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
        // 三种"不完整"都必须报告 max-tokens 而非 tool-calls，否则 harness 会
        // 执行残缺调用、报 INVALID_ARGS，并把脏参数持久化进会话历史：
        // - 'length'：模型输出被 max_tokens 显式截断；
        // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
        // - 参数分片丢失：后端并行下发多个工具调用时偶发丢分片（实测
        //   session-23851745 turn1 step4，两个并行 `read` 都丢了 `{"file_path": "…`
        //   前缀）。此时报告 tool-calls 会让 harness 执行缺参调用，报
        //   `missing required property "file_path"`，模型收到莫名其妙的参数错误
        //   并陷入重试循环。判定为截断后 dsh 丢弃残缺调用并重试，实测一次即恢复。
        const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text));
        /**
         * 是否丢弃过**名称不可用**的 tool-call 块（见上方 tool_calls 分支）。
         *
         * 丢弃是对的（无名调用无法执行、留着会污染会话），但不能让它**静默地以
         * `stop` 结束** —— 那正是 AGENTS.md 记录的「没有任何报错就中断」：
         * 模型本意要调工具，harness 却认为它「正常答完了」。故报 max-tokens
         * （不完整、可重试）。同批若还有可用调用，则照常报 tool-calls。
         */
        const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced);
        const reason = loopDetected
            // 思考死循环：截断并报可重试。**优先级最高** —— 循环中生成的工具调用
            // 参数不可信；且若无可用调用，落到 `stop` 会让任务静默中断。
            ? { kind: 'max-tokens' }
            : finishReason === 'length'
                || finishReason === undefined && toolOrder.length > 0
                || argsTruncated
                || droppedUnnamedCalls && toolOrder.length === 0
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
/** 凭据是否已过期；无法解析过期时间时不判定过期（与 Rust is_expired 一致）。 */
function isCredentialExpired(credential) {
    const expiresAt = credentialExpiresAtMs(credential);
    return expiresAt === undefined ? false : Date.now() >= expiresAt;
}
/**
 * 生成模型选择器里显示的名字，承载**两类**信息：计费倍率与同名消歧。
 *
 * ⚠️ **必须写进 `name` 而不是 `description`**：composer 的模型切换菜单只渲染
 * `name`（见 ModelSelect 的 `children: model.name`），`description` 仅用于
 * `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」正是因为
 * 早期版本放在了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`
 * （见 `selectionOf` 返回 `model: model.id`），故在名字里附加价格不会污染会话。
 *
 * 形如 `Deepseek-V4.1-Flash · x0.03`；有促销时 `· x0.17→x0.50`（用箭头而
 * 不是「（促销 …）」，避免在窄菜单里过长）。同名撞车时再加变体标记。
 */
function displayNameFor(model, all) {
    const suffix = displaySuffix(model, all);
    return suffix.length > 0 ? `${model.name} · ${suffix}` : model.name;
}
/** 组装展示名的后缀部分：倍率 + 同名变体标记。 */
function displaySuffix(model, all) {
    const parts = [];
    // 倍率：有促销时用 `原价→促销价` 一眼看出折扣幅度。
    const rate = formatCreditsRate(model.creditsRate, model.discountedCreditsRate);
    if (rate !== undefined)
        parts.push(rate);
    // 同名消歧：只在**确实撞车**时追加，避免影响其它模型。
    const variant = variantLabelFor(model, all);
    if (variant.length > 0)
        parts.push(variant);
    return parts.join(' ');
}
/**
 * 判断该模型是否需要变体标记，需要时返回标记文本。
 *
 * 远端会给**不同 id 配同一个 name**（实测 `deepseek-v4.1-flash` /
 * `deepseek-v4.1-flash-sg` 都是 "Deepseek-V4.1-Flash"；`hy3`/`hy3-x` 都是
 * "Hy3"），而选择器按 name 展示 → 出现无法区分的重复条目。
 *
 * 用**公共前缀**切分而非硬编码 `-sg`：撞车组随服务端上新变化（本次实测三组
 * 里只有一组带 `-sg`）；也不用「取 id 最后一段」（会把 `gpt-5.6-sol` 的
 * `sol` 当变体）。公共前缀只在撞车时才计算，不影响其它模型。
 */
function variantLabelFor(model, all) {
    const group = all.filter((candidate) => candidate.name === model.name);
    if (group.length <= 1)
        return '';
    const prefix = commonPrefix(group.map((candidate) => candidate.id));
    const variant = model.id.slice(prefix.length).replace(/^-+/, '');
    return variant.toUpperCase();
}
/** 求一组字符串的公共前缀（逐字符比较）。 */
function commonPrefix(values) {
    if (values.length === 0)
        return '';
    let prefix = values[0];
    for (const value of values.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i])
            i++;
        prefix = prefix.slice(0, i);
        if (prefix.length === 0)
            break;
    }
    return prefix;
}
/**
 * 把候选输出上限规整为「可安全下发的正整数」，否则返回 undefined。
 *
 * 为什么必须过滤：DSH 的 `LlmRuntime.resolveModelInfoFor` 对适配器声明的
 * `defaultMaxTokens` 有硬校验 —— 非安全整数或 ≤0 会直接抛
 * `adapter returned invalid default maxTokens`（INVALID_MODEL_MAX_TOKENS），
 * 整轮对话起不来。远端是外部输入，`0` / 负数 / `NaN` 都可能出现，
 * 不能在适配器里假设它合法。
 */
function positiveMaxTokens(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/**
 * 在 ctx.llm 上注册 CodeBuddy 系产品的 provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动：
 * CodeBuddy 得到 `buddy`，WorkBuddy 得到 `workbuddy`。
 * `settingsNs` 经 `settingsNamespaceFor()` 解析：老契约（≤0.1.6）下是各产品的
 * `llm-<id>` 命名空间；0.1.7-rc.1 起 settings 命名空间只能是 profile 条目 id，
 * 故解析为本插件条目 id。
 */
export function registerBuddyLlm(ctx, options) {
    const product = options.product ?? CODEBUDDY;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new BuddyAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
    // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
    return adapter;
}
//# sourceMappingURL=buddy-adapter.js.map