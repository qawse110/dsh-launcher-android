import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { isCodeArtsBenefitModel } from './models.js';
import { normalizeHarnessMessages } from './message-shape.js';
import { signRequestHuawei } from './sign.js';
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js';
export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2';
export const PROVIDER = 'codearts';
// DeepSeek V4（CodeArts Agent 模型列表新增，UI 标注"每日 1000 万免费 Tokens"福利）：
//
// 修正（2026-09-23，对齐 deveco-code-rust fb1b4a2）：早期注释称
// 「deepseek-v4-flash-0731 后端未注册」，该结论**有误** —— 实测它返回 404 的
// 真实原因是**缺少 `maas_type: benefit` 头**；带上该头即成功。带日期后缀与
// 无后缀是后端上两个不同的模型，均有注册，不能互相替代：
//   - deepseek-v4-flash-0731 / deepseek-v4-pro-0813 → benefit 模型（需 maas_type）
//   - deepseek-v4-flash / deepseek-v4-pro（无后缀）  → 非 benefit（带该头会
//     `unsupported model`）
// gateway/config 返回的是 benefit 那组，故下方静态表保留无后缀形态
// （无后缀始终可用，不依赖 benefit 头），而 deepseek-v4.1-flash 只有 benefit 形态。
const DEFAULT_MODELS = [
    'GLM-5.2', 'GLM-5.1', 'GLM-5',
    'glm-5.3-flash',
    'openpangu-2.0-flash', 'openpangu-2.0-pro',
    'deepseek-v4-flash', 'deepseek-v4-pro',
    'deepseek-v4.1-flash',
];
/**
 * 模型上下文窗口（最大合并请求+响应 token 数）。
 * - GLM-5.2：202752（对齐 CodeArts Agent IDE 模型卡标注）。
 * - glm-5.3-flash：1048576（1M，逆向自 IDE gateway/config，对齐 deveco-code-rust 90aeb17d）。
 * - deepseek-v4-flash / deepseek-v4-pro：1048576（1M，UI 标注）。
 * - deepseek-v4.1-flash：1000000（对齐 IDE 下发的 inferhub-provider 模型配置，
 *   2026-09 kernel 日志；对齐 deveco-code-rust fb1b4a2）。
 * - 其余模型未公开上下文容量，留 undefined 让后端默认裁剪。
 */
const CONTEXT_WINDOWS = new Map([
    ['GLM-5.2', 202752],
    ['glm-5.3-flash', 1_048_576],
    ['deepseek-v4-flash', 1048576],
    ['deepseek-v4-pro', 1048576],
    ['deepseek-v4.1-flash', 1_000_000],
]);
/**
 * 将消息内容载荷展平为纯文本字符串。Harness 消息
 * 以 OpenAI 风格的块数组形式携带内容（`[{type:'text',...}]`，且
 * 助手历史可能包含 `{type:'reasoning',...}` 块）；CodeArts
 * 端点会拒绝非 `text` 块类型并返回空流，因此只保留
 * `text` 块并拼接。
 */
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
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；`reasoning`
 * 块折叠为 `reasoning_content` 字段（deepseek-v4 等推理模型的后端
 * 校验要求 assistant 消息必须携带该字段，缺失会报 "Missing
 * `reasoning_content` field"）；工具结果（搭载在 harness 用户消息中）
 * 展开为独立的 `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 其余非文本块（图片）被丢弃，与端点接受的格式一致。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export function serializeMessages(messages) {
    const normalized = normalizeHarnessMessages(messages);
    const wire = [];
    // 剔除无法配对的工具调用/结果（详见 resolveToolPairing）：孤儿 tool_calls
    // 会让后端对之后每一条消息都返回 400，整个会话永久报废。
    const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
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
            wire.push({
                role: 'assistant',
                content: contentToText(content),
                // 后端（deepseek-v4-flash/pro）校验要求 assistant 消息必须包含
                // reasoning_content 字段：历史里的推理块在上一轮被持久化，回传时
                // 若缺失该字段会直接 400（"Missing `reasoning_content` field"）。
                // 始终携带该字段（无推理时为空串），确保字段存在。
                reasoning_content: reasoning,
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        if (message.role === 'system') {
            wire.push({ role: 'system', content: contentToText(message.content) });
            continue;
        }
        // user 角色：工具结果搭载在 harness 用户消息中；将每个展开为
        // 独立的 role:'tool' 传输消息，与 deepseek 适配器的行为一致。
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResults = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-result');
        // 纯文本 user 消息（字符串 content）需原样传递：contentToText 处理
        // 字符串时直接返回，但这里不能用 `content`（非数组时为 []）——否则
        // 字符串 user 消息会被序列化成空串，模型看不到任务指令。
        const text = contentToText(message.content);
        if (text.length > 0 || toolResults.length === 0)
            wire.push({ role: 'user', content: text });
        for (const result of toolResults) {
            // 丢弃孤儿工具结果：没有对应 tool_call 其结果同样会让后端 400。
            if (!keepResultIds.has(String(result.toolCallId)))
                continue;
            wire.push({
                role: 'tool',
                tool_call_id: String(result.toolCallId),
                content: contentToText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
/**
 * 判断模型是否为 deepseek-v4 系列（flash/pro）。
 *
 * deepseek-v4 对标准 OpenAI 格式的 `tool_calls.arguments` 采用一次性打包
 * 生成：模型在生成超大工具参数（如 2000 行 write content）期间 SSE 流
 * 长时间无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），
 * 且后端不会对任何请求头发送心跳保活（实测 2026-08-22：无论是否携带
 * app-id/plugin-name/x-ot-* 等 IDE 头、是否带 `accept: text/event-stream`、
 * `tool_stream`、调整 `max_tokens`，SSE 流均无 `:` 注释行，60s 静默必断）。
 *
 * 但 deepseek-v4 原生支持 DSML 工具调用格式：工具调用直接写入
 * `delta.content`（形如 `<｜DSML｜tool_calls>...`），走与 reasoning 相同的
 * 流式通道。实测（2026-08-22 e2e 探测）：1000 行 write content 的 DSML
 * 流全程最大静默仅 204ms，146s 完整结束；标准 tool_calls 模式 100 行也
 * 会在 17.7s 静默后一次性到达、300 行即 60s 断连。因此对 deepseek-v4
 * 模型将工具 schema 注入 system 消息、请求体不发送 `tools` 字段，让模型
 * 以 DSML 流式输出工具调用，从根上规避网关空闲断连。
 */
function isDeepseekV4Model(model) {
    return /^deepseek-v4-(flash|pro)$/.test(model);
}
/**
 * 工具名匹配大参数写文件类工具（content/arguments 可能达到数万 token）。
 * 仅用于对非 deepseek-v4 模型的 DSML 模式降级判定（当前全量模式不再使用此列表）。
 */
const DSML_LARGE_PARAM_TOOLS = ['write', 'file_write', 'apply_patch'];
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * deepseek-v4 模型始终走 DSML 模式（不论工具列表中包含什么工具），原因：
 * - 标准 `tool_calls` 模式要求参数一次性打包生成，SSE 流在生成参数期间长时间
 *   无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），且后端不对
 *   任何请求头发送心跳保活；
 * - 除 write/file_write/apply_patch 外，`subagent` 的 `prompt` 参数也可能很长
 *   （包含详细任务描述与上下文），同样面临网关断连风险；
 * - DSML 模式使工具调用通过 `delta.content` 流式输出（全程有数据流），从根上
 *   规避网关空闲断连，实测 1000 行 write content 的 DSML 流全程最大静默仅
 *   204ms，146s 完整结束；
 * - 模型行为统一，避免不同步骤间标准/DSML 模式切换引入的不一致。
 *
 * 非 deepseek-v4 模型（如 openpangu / GLM-5.2 等）使用华为标准 IAM AK/SK 鉴权，
 * 不走 CodeArts Agent APIG 网关，无 60s 空闲断连问题，继续保持标准 tool_calls。
 */
function needsDsmlToolMode(model, _toolNames) {
    return isDeepseekV4Model(model);
}
/**
 * 构造让 deepseek-v4 以原生 DSML 格式调用工具的 system 提示。
 *
 * 适配器不把 `tools` 字段发给后端（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，
 * 并明确要求模型使用 `<｜DSML｜tool_calls>` 语法。`parseDsmlToolCalls`
 * 会把模型输出的 DSML 块解析为结构化 tool-call，harness 无需感知差异。
 */
function buildDsmlSystemPrompt(tools) {
    const toolJson = JSON.stringify(tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    })), null, 2);
    return [
        '以下是你可用的工具及其 JSON Schema。当需要调用工具完成任务时，',
        '必须使用原生 DSML 工具调用语法输出，格式如下：',
        '<｜DSML｜tool_calls><｜DSML｜invoke name="工具名"><｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
        '',
        '规则：',
        '- 工具名必须是下面列表中的 name。',
        '- 每个参数用一个 <｜DSML｜parameter> 标签包裹，参数值放在标签之间。',
        '- 字符串参数加 string="true" 属性；对象/数组/数字/布尔参数不要加该属性。',
        '- 一次可以输出多个 <｜DSML｜invoke> 调用（工具可以并行）。',
        '- 文件内容请一次性完整写入单个 write 调用的 content 参数，不要拆分或省略。',
        '',
        '工具列表（JSON Schema）：',
        toolJson,
    ].join('\n');
}
/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export const QUEUE_STATUS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status';
/** 在 CodeArts 队列中等待时的轮询间隔。 */
const QUEUE_RETRY_DELAY_MS = 10_000;
/** 轮询上限：180 × 10 秒 = 30 分钟，与 deveco-code 参考实现一致。 */
const QUEUE_MAX_ATTEMPTS = 180;
/**
 * SSE 流空闲超时。CodeArts 后端 / APIG 网关对 SSE 连接有 ~60 秒无数据即
 * 断开的策略：当模型生成超长推理或大工具调用参数时，两次 chunk 之间可能
 * 静默数十秒，连接被服务端掐断后 Node undici 的 reader.read() 抛
 * `TypeError: terminated`。该错误非 HarnessError，被 normalizeLlmFailure
 * 归类为 UNKNOWN（不可重试），harness 直接失败。
 * 主动以略小于网关超时的窗口检测空闲：超时则取消 reader 并抛可重试的
 * TIMEOUT，让 harness 重试该步骤（历史已持久化，重试会带相同上下文）。
 *
 * SSE 流超时配置（对齐 CodeArts Agent IDE agentkernelServer 逆向实证：
 * `firstTokenTimeout = 300000` / `chunkTimeout = 600000`）。
 *
 * 历史背景：原实现用单一 `SSE_IDLE_TIMEOUT_MS = 55_000`（55s），对齐
 * APIG 网关 ~60s 空闲断连。但 deepseek-v4-flash 生成大文件 write 工具
 * 调用的 content 参数时，会先输出 file_path 参数然后长时间静默（模型
 * 在内部做长文本生成但不在 SSE 上 flush），实测三次均在 ~55s 处被掐断、
 * 重试后又重复相同模式——55s 对这类"思考型长生成"太短。
 *
 * IDE 的方案是拆成两个超时：
 * - firstTokenTimeout=300s：等第一个 token 的窗口，到点才报错
 * - chunkTimeout=600s：每收到一个 chunk 就重置；两次 chunk 之间超过 10 分钟才报错
 *
 * 两者均可通过环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT
 * 路径，或在线上针对特定模型调优。环境变量在每次 stream() 调用时读取，
 * 避免模块顶层常量在 import 时定型、测试运行中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs() {
    return Number.parseInt(process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 300_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 600_000;
}
/**
 * 判断一个错误是否为 SSE 传输级故障（连接被对端掐断 / socket 重置 /
 * undici 内部 socket 错误），而非业务错误。这类错误可安全重试整个
 * chat 请求，因此映射为可重试的 TRANSPORT code，而非 UNKNOWN。
 */
function isTransportError(error) {
    if (!(error instanceof Error))
        return false;
    const message = error.message.toLowerCase();
    // undici / Node 流在连接被对端关闭时抛 "terminated"
    if (message.includes('terminated'))
        return true;
    // undici socket 错误（UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT 等）
    if (error.name.startsWith('UND_ERR_'))
        return true;
    // fetch 网络层失败
    if (message.includes('fetch failed'))
        return true;
    // TCP 重置 / 对端中断
    if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up'))
        return true;
    return false;
}
/**
 * SSE 流内可重试的排队/限流错误信号。CodeArts 后端有时以 HTTP 200 +
 * SSE 内嵌错误的形式返回排队/限流（如 `InferHub.ModelArts.81111.429`
 * TPM 超限），而不是 4xx——适配器把这种响应当成排队处理：延迟后
 * 重新发起整个 chat 请求，与 TM.00001041 行为一致。
 */
class SseQueueRetryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SseQueueRetryError';
        this.code = code;
    }
}
/** 判断 HTTP 错误体是否表示 CodeArts 并发排队限流。 */
function isQueueError(status, body) {
    return status === 400
        && (body.includes('TM.00001041')
            || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body)
            || /high\s+demand|too\s+many\s+requests/i.test(body));
}
/**
 * 判断 HTTP 错误是否表示凭据已失效、可通过 refresh_token 续期后重试。
 * CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
 * `APIG.0602`（"Invalid token"），HTTP 状态通常是 401，但也观察到 403。
 * 本适配器在入口已按 expires_at 预判过期，但 SecurityToken 可能被后端
 * 提前吊销、或本地时钟与签发端有偏差——此时首次请求会命中本错误。
 * 策略：触发一次静默 refresh，用新 AK/SK/SecurityToken 重试一次；仍失败
 * 才抛 AUTH，避免把可自愈的瞬时鉴权失败暴露给用户。
 */
function isAuthError(status, body) {
    if (status === 401 || status === 403)
        return true;
    return body.includes('APIG.0602') || /invalid\s+token|token\s+expired|token\s+is\s+invalid/i.test(body);
}
/**
 * 判断 SSE 流内返回的 error_code 是否属于可重试的排队/限流错误。
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 */
function isSseQueueErrorCode(code) {
    return code === 'TM.00001041'
        || /81111|TPM|429|rate.?limit|too many requests|排队|限流/i.test(code);
}
/** 从错误体提取可分类的 detail 文本（OpenAI 风格 error 或 CodeArts error_code/error_msg）。 */
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
            typeof data.error_code === 'string' ? data.error_code : undefined,
            typeof data.error_msg === 'string' ? data.error_msg : undefined,
            typeof data.message === 'string' ? data.message : undefined,
        ].filter((value) => value !== undefined);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch {
        // 非 JSON 错误体：直接用原文分类。
    }
    return body;
}
/**
 * 将 CodeArts 错误响应归一化为 harness 错误码，与 deepseek 适配器的
 * httpErrorCode 词汇一致：400 且命中上下文超限措辞时归为
 * CONTEXT_WINDOW_EXCEEDED（触发 dsh compaction 自动压缩上下文），
 * 而不是不可重试的 HTTP_400，避免长会话在接近窗口上限时直接中断。
 */
function httpErrorCode(status, body) {
    if (status === 401 || status === 403)
        return 'AUTH';
    const detail = errorDetail(body);
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/** 可中止的休眠；当信号中止时立即 resolve。 */
function delay(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** 安全读取 Error.message，避免访问器抛异常。 */
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
 * 在空闲超时内读取一个流块（实现见 {@link readWithIdleTimeout}）。
 * 此处用 codearts 标签包一层，保持错误消息前缀与历史行为一致。
 */
function readCodeArtsChunk(reader, timeoutMs, signal, phase = 'chunk') {
    return readWithIdleTimeout(reader, timeoutMs, 'codearts', signal, phase);
}
/**
 * DSML 工具调用格式提取器。
 *
 * 某些模型（如 deepseek-v4）在未通过 `tools` 字段告知工具模式、或工具
 * 模式与模型训练格式不匹配时，会把工具调用以原生 DSML XML 风格直接写入
 * `delta.content`，形如：
 *   `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">
 *    <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
 *    </｜DSML｜invoke></｜DSML｜tool_calls>`
 * 适配器若原样作为 text-delta 输出，原始 token 会泄漏到 web UI（表现为
 * "dump 出奇怪的一段内容后终止"）。本提取器以流式状态机从 content 增量
 * 中识别完整 DSML 块并解析为结构化 tool-call；非 DSML 文本原样放行，
 * 保持流式输出不阻塞。
 *
 * 同时支持 DeepSeek-V4 Thinking 模式：模型在工具调用前会把推理过程包裹
 * 在 `<thought>...</thought>` 标记中写入 `delta.content`。本提取器把
 * `<thought>` 内容作为 reasoning 增量流式输出（与 `delta.reasoning_content`
 * 行为一致，显示在 web 的 Think 区域而非正文），避免推理文本泄漏到用户
 * 可见区域。参考 DSML 官方介绍：
 * https://blog.csdn.net/gitblog_00855/article/details/152146045
 *
 * 设计要点：
 * - 增量友好：content 可能跨多个 SSE chunk 分片到达，提取器维护内部
 *   缓冲区与多模式状态机（normal / in-thought / in-dsml），仅对已完成
 *   的 DSML 块产出 tool-call；reasoning 增量流式输出；未完成部分保留
 *   到下次 feed；非 DSML/thought 文本立即 flush，避免延迟。
 * - 容错：若缓冲区包含开标签前缀但长时间未闭合，且后续内容不像该标签
 *   （例如只是普通文本里碰巧出现该前缀），在 flush 时把残留作为纯文本
 *   输出，避免吞掉用户可见内容。
 * - 边界：DSML 标签使用全角 `｜`（U+FF5C）而非半角 `|`，与模型实际
 *   输出一致。`<thought>` 为半角普通 XML 标签，与 DSML 官方文档一致。
 */
const DSML_TOOL_CALLS_OPEN = '<｜DSML｜tool_calls>';
const DSML_TOOL_CALLS_CLOSE = '</｜DSML｜tool_calls>';
const DSML_INVOKE_OPEN_PREFIX = '<｜DSML｜invoke';
const DSML_INVOKE_CLOSE = '</｜DSML｜invoke>';
const DSML_PARAM_OPEN_PREFIX = '<｜DSML｜parameter';
const DSML_PARAM_CLOSE = '</｜DSML｜parameter>';
const THOUGHT_OPEN = '<thought>';
const THOUGHT_CLOSE = '</thought>';
/** 解析单个 DSML invoke 块为 { name, arguments }。 */
/**
 * 对标记 string="true" 的参数值做宽松解析：若值恰好是 number/boolean
 * /null 字面量（如 "1304"、"true"、"null"），返回原始类型；若值是合法
 * JSON 数组或对象（如 todo_write 的 todos 被写成 `[{"content":...}]`），
 * 还原为原始类型；否则保持字符串。用于纠正模型对数字/数组/对象参数误标
 * string 的 DSML 输出（如 read 的 offset 被写成 offset="1304"、
 * todo_write 的 todos 被写成 string="true" 的 JSON 数组字符串），使工具
 * schema 校验通过。
 */
function tryParseScalar(value) {
    if (value === '')
        return '';
    const trimmed = value.trim();
    if (trimmed === '')
        return value;
    if (trimmed === 'null')
        return null;
    if (trimmed === 'true')
        return true;
    if (trimmed === 'false')
        return false;
    // 带引号的 JSON 字符串字面量：deepseek-v4-pro 常把数字/布尔参数值用
    // JSON 字符串编码（如 "840"），即便标记了 string="true" 也只输出引号
    // 包裹的字面量。先 JSON.parse 解码去掉外层引号，再递归尝试标量转换：
    // "840" → 840(number)、"true" → true(boolean)、"hello" → "hello"(string)。
    // 仅当整体是合法 JSON 字符串字面量（"..." 配对）时才解码，避免误伤
    // 含引号的普通文本（如路径中的引号片段）。flash 模型输出纯数字字面量
    // 不带引号，不会进入此分支；pro 模型带引号才命中，故 pro 出错多。
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            const decoded = JSON.parse(trimmed);
            if (typeof decoded === 'string')
                return tryParseScalar(decoded);
            return decoded;
        }
        catch { /* 非合法 JSON 字符串字面量，按原样处理 */ }
    }
    // 整数 / 浮点数 / 负数：仅当整体匹配数字语法时才转换，避免误伤路径
    // 中的数字片段（如 "v1.2" 不含；"123abc" 不含）。
    if (/^-?\d+$/.test(trimmed))
        return Number(trimmed);
    if (/^-?\d+\.\d+$/.test(trimmed))
        return Number(trimmed);
    // 数组 / 对象：模型常对数组/对象参数（如 todo_write 的 todos）误标
    // string="true"，把 JSON 编码的数组/对象当作字符串输出。若值是合法
    // JSON 数组或对象，还原为原始类型，使工具 schema 校验通过。仅对
    // `[` / `{` 开头尝试 JSON.parse，避免误伤普通字符串（路径、正文等
    // 极少以这两个字符开头且整段恰为合法 JSON）。
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            return JSON.parse(trimmed);
        }
        catch { /* 非合法 JSON，保持字符串 */ }
    }
    return value;
}
function parseDsmlInvoke(block) {
    // 提取 name="..." 属性
    const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block);
    if (nameMatch === null)
        return undefined;
    const name = nameMatch[1];
    // 提取所有 parameter 子节点，按出现顺序拼装 arguments JSON
    const params = {};
    let cursor = 0;
    for (;;) {
        const openStart = block.indexOf(DSML_PARAM_OPEN_PREFIX, cursor);
        if (openStart === -1)
            break;
        const openEnd = block.indexOf('>', openStart);
        if (openEnd === -1)
            break;
        const openTag = block.slice(openStart, openEnd + 1);
        const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag);
        if (paramNameMatch === null) {
            cursor = openEnd + 1;
            continue;
        }
        const paramName = paramNameMatch[1];
        const closeStart = block.indexOf(DSML_PARAM_CLOSE, openEnd + 1);
        if (closeStart === -1)
            break;
        const value = block.slice(openEnd + 1, closeStart);
        // string="true" 属性标记字符串类型。但模型经常对数字参数（如 read 的
        // offset/limit、write 的 offset）误标 string="true"，把 "1304" 当作字符串
        // 输出，工具 schema 校验报 `"offset" must be a number`。因此即使标记了
        // string，也尝试 JSON 解析：若是 number/boolean/null 字面量则按原始类型
        // 使用，其余（路径、正文等）保持字符串。
        const isString = /string\s*=\s*"true"/.test(openTag);
        if (isString) {
            const parsed = tryParseScalar(value);
            params[paramName] = parsed;
        }
        else {
            // 非 string 参数理论上应是 number/array/object/boolean。但
            // deepseek-v4-pro 有时把数字参数值用 JSON 字符串引号包裹（如 "840"）
            // 且不加 string="true"：JSON.parse('"840"') 得到字符串 "840"，
            // schema 校验仍报 "offset" must be a number。对 JSON.parse 得到的
            // 字符串结果再走一次 tryParseScalar，把数字字面量还原为 number。
            try {
                const parsed = JSON.parse(value);
                params[paramName] = typeof parsed === 'string' ? tryParseScalar(parsed) : parsed;
            }
            catch {
                params[paramName] = value;
            }
        }
        cursor = closeStart + DSML_PARAM_CLOSE.length;
    }
    return { name, arguments: JSON.stringify(params) };
}
/**
 * 从一段已闭合的 DSML tool_calls 块中解析所有 invoke，返回结构化
 * tool-call 列表。返回 undefined 表示解析失败（调用方应回退为纯文本）。
 */
function parseDsmlToolCalls(block) {
    // block 形如 `<｜DSML｜tool_calls>...invokes...</｜DSML｜tool_calls>`
    let inner = block;
    if (inner.startsWith(DSML_TOOL_CALLS_OPEN))
        inner = inner.slice(DSML_TOOL_CALLS_OPEN.length);
    if (inner.endsWith(DSML_TOOL_CALLS_CLOSE))
        inner = inner.slice(0, inner.length - DSML_TOOL_CALLS_CLOSE.length);
    const calls = [];
    let cursor = 0;
    for (;;) {
        const openStart = inner.indexOf(DSML_INVOKE_OPEN_PREFIX, cursor);
        if (openStart === -1)
            break;
        const openEnd = inner.indexOf('>', openStart);
        if (openEnd === -1)
            break;
        const closeStart = inner.indexOf(DSML_INVOKE_CLOSE, openEnd + 1);
        if (closeStart === -1)
            break;
        const invokeBlock = inner.slice(openStart, closeStart + DSML_INVOKE_CLOSE.length);
        const parsed = parseDsmlInvoke(invokeBlock);
        if (parsed === undefined)
            return undefined;
        calls.push(parsed);
        cursor = closeStart + DSML_INVOKE_CLOSE.length;
    }
    return calls;
}
/**
 * 计算缓冲区末尾与任一开标签的最长公共前缀长度。用于流式提取器决定
 * 保留多少缓冲区等待下次 feed：若末尾是某开标签的不完整前缀（例如
 * `<tho` 跨 chunk 到达），保留该前缀；否则全部放行，避免短文本被
 * 过度缓冲延迟输出。
 */
function longestOpenPrefixTail(buffer, prefixes) {
    let keepLen = 0;
    const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map(p => p.length)));
    for (let i = 1; i <= maxCheck; i++) {
        const tail = buffer.slice(buffer.length - i);
        if (prefixes.some(p => p.startsWith(tail)))
            keepLen = i;
    }
    return keepLen;
}
/**
 * 流式 DSML 提取器。feed() 接收 content delta，返回一个结果对象：
 * - `text`：应作为 text-delta 输出的纯文本（可能为空串）
 * - `reasoning`：应作为 reasoning-delta 输出的推理增量（可能为空串）
 * - `toolCalls`：已完整解析的 DSML tool-call 列表（可能为空数组）
 * flush() 在流结束时调用，把残留缓冲区作为纯文本返回。
 *
 * 状态机三态：
 * - normal：寻找 `<thought>` 或 `<｜DSML｜tool_calls>` 开标签
 * - in-thought：寻找 `</thought>` 闭标签，期间内容作为 reasoning 流式输出
 * - in-dsml：寻找 `</｜DSML｜tool_calls>` 闭标签，完整后解析为 tool-call
 */
class DsmlContentExtractor {
    buffer = '';
    state = 'normal';
    feed(chunk) {
        let text = '';
        let reasoning = '';
        const toolCalls = [];
        this.buffer += chunk;
        for (;;) {
            if (this.state === 'normal') {
                // 寻找最早出现的开标签（thought 或 DSML tool_calls）
                const thoughtIdx = this.buffer.indexOf(THOUGHT_OPEN);
                const dsmlIdx = this.buffer.indexOf(DSML_TOOL_CALLS_OPEN);
                let openIdx = -1;
                let nextState = 'in-thought';
                if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
                    openIdx = thoughtIdx;
                    nextState = 'in-thought';
                }
                else if (dsmlIdx !== -1) {
                    openIdx = dsmlIdx;
                    nextState = 'in-dsml';
                }
                if (openIdx === -1) {
                    // 没有完整开标签：但缓冲区末尾可能是任一开标签的不完整前缀
                    const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_OPEN, DSML_TOOL_CALLS_OPEN]);
                    if (keepLen === 0) {
                        text += this.buffer;
                        this.buffer = '';
                    }
                    else if (this.buffer.length > keepLen) {
                        text += this.buffer.slice(0, this.buffer.length - keepLen);
                        this.buffer = this.buffer.slice(this.buffer.length - keepLen);
                    }
                    break;
                }
                // 放行开标签之前的纯文本
                if (openIdx > 0)
                    text += this.buffer.slice(0, openIdx);
                this.buffer = this.buffer.slice(openIdx);
                // 跳过开标签本身
                const openLen = nextState === 'in-thought' ? THOUGHT_OPEN.length : DSML_TOOL_CALLS_OPEN.length;
                this.buffer = this.buffer.slice(openLen);
                this.state = nextState;
                continue;
            }
            if (this.state === 'in-thought') {
                // 寻找 </thought> 闭标签，期间内容作为 reasoning 流式输出
                const closeIdx = this.buffer.indexOf(THOUGHT_CLOSE);
                if (closeIdx === -1) {
                    // 闭标签未到达：放行除可能的不完整闭标签前缀外的内容
                    const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_CLOSE]);
                    if (keepLen === 0) {
                        reasoning += this.buffer;
                        this.buffer = '';
                    }
                    else if (this.buffer.length > keepLen) {
                        reasoning += this.buffer.slice(0, this.buffer.length - keepLen);
                        this.buffer = this.buffer.slice(this.buffer.length - keepLen);
                    }
                    break;
                }
                // 放行闭标签之前的推理
                if (closeIdx > 0)
                    reasoning += this.buffer.slice(0, closeIdx);
                this.buffer = this.buffer.slice(closeIdx + THOUGHT_CLOSE.length);
                this.state = 'normal';
                continue;
            }
            // state === 'in-dsml'：寻找闭标签，完整块才解析
            const closeIdx = this.buffer.indexOf(DSML_TOOL_CALLS_CLOSE);
            if (closeIdx === -1) {
                // 闭标签未到达，等待更多数据
                break;
            }
            const block = this.buffer.slice(0, closeIdx + DSML_TOOL_CALLS_CLOSE.length);
            const parsed = parseDsmlToolCalls(block);
            if (parsed === undefined) {
                // 解析失败：把整个块作为纯文本放行，避免吞内容
                text += block;
            }
            else {
                toolCalls.push(...parsed);
            }
            this.buffer = this.buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length);
            this.state = 'normal';
            continue;
        }
        return { text, reasoning, toolCalls };
    }
    flush() {
        // 流结束：残留缓冲根据状态决定输出通道
        const remaining = this.buffer;
        this.buffer = '';
        if (this.state === 'in-thought') {
            // 不完整的 thought 块：作为 reasoning 放行（避免泄漏到正文）
            this.state = 'normal';
            return { text: '', reasoning: remaining };
        }
        if (this.state === 'in-dsml') {
            // 不完整的 DSML 块：开标签已在进入 in-dsml 状态时被消耗，需加回
            // 才能保持用户可见内容的完整性（避免 dump 出缺少开标签的残片）。
            this.state = 'normal';
            return { text: DSML_TOOL_CALLS_OPEN + remaining, reasoning: '' };
        }
        // normal 拘留：作为纯文本放行
        this.state = 'normal';
        return { text: remaining, reasoning: '' };
    }
}
/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export class CodeArtsAdapter extends LlmAdapter {
    options;
    fetchImpl;
    chatId;
    sessionId;
    constructor(options) {
        super();
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, '');
        this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '');
    }
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
     * 入参异常时回退到 PROVIDER 常量，避免客户端抛
     * `undefined.toUpperCase is not a function`。
     */
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER;
        return { id, name: 'CodeArts Agent' };
    }
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    remoteModels;
    /**
     * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
     * （如直接进入会话），此时同样触发远端拉取。
     */
    async ensureRemoteModels() {
        if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined)
            return;
        try {
            const models = await this.options.fetchRemoteModels();
            if (models.length > 0)
                this.remoteModels = models;
        }
        catch {
            // 拉取失败保持未定义，后续 listModels/resolveModel 仍回退静态列表
        }
    }
    /**
     * 完整模型目录（**不应用用户黑名单**）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
     * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
     */
    listAllModels() {
        const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }));
        // 与 listModels 保持同一套「可见性」过滤（VL 多模态不参与），
        // 唯一区别是不套用户黑名单。
        return source
            .filter((m) => !/-VL-/i.test(m.id) && !/-VL$/i.test(m.id))
            .map((m) => ({ id: m.id, name: m.name }));
    }
    async listModels(_provider) {
        // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
        // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
        // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
        // 界面上反而多出一条 provider 报错）。
        //
        // ⚠️ **CodeArts 不再有单凭据例外**：早期它额外把固定 ref
        // `CODEARTS_ACCESS_TOKEN` 计入判据（单凭据模式），该模式已随
        // `credentialRef` 回退解析一并移除 —— 六个 provider 现在判据完全一致，
        // 都只看账号池。
        //
        // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
        // 不必拉。
        if (!await providerCatalogVisible(this.options.accountPool, PROVIDER))
            return [];
        // 必须 await：ensureRemoteModels 是异步的，早期实现用 `void` 丢弃 Promise，
        // 冷缓存时远端目录尚未落地就走静态兜底表，模型选择器会短暂显示错误的
        // 模型集合（Jet Hub 的模型开关也据此渲染，会造成"关掉的模型又冒出来"）。
        await this.ensureRemoteModels();
        const visible = this.listAllModels();
        // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
        // 只影响此处对外播报的模型目录，不改变 resolveModel/stream 的路由能力
        // ——与 DSH 对 listModels 的约定一致（目录是建议性的，缺省不构成拒绝）。
        const disabled = this.options.accountPool?.disabledModelsFor(PROVIDER);
        const listed = disabled === undefined || disabled.size === 0
            ? visible
            : visible.filter((m) => !disabled.has(m.id));
        return listed.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] }));
    }
    async resolveModel(provider, model, _signal) {
        await this.ensureRemoteModels();
        const remoteModel = this.remoteModels?.find((m) => m.id === model);
        const name = remoteModel?.name ?? model;
        const contextWindow = CONTEXT_WINDOWS.get(model);
        const resolved = { provider, id: model, name };
        if (contextWindow !== undefined)
            resolved.context = { contextWindow };
        return resolved;
    }
    async prepareCall(provider, model, signal) {
        return {
            model: { ...await this.resolveModel(provider, model, signal), inputModalities: ['text'] },
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        let credential = await this.options.resolveCredential();
        if (credential === undefined || Date.parse(credential.expires_at) <= Date.now()) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
            throw new LlmError('codearts: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // Track current account id for rate limit tracking
        let currentAccountId = '';
        if (this.options.accountPool && credential?.access_key_id) {
            try {
                currentAccountId = await this.options.accountPool.findAccountIdByCredential('codearts', credential.access_key_id);
            }
            catch (error) {
                console.warn('[codearts] 账号匹配失败（不影响本次请求）:', error);
            }
        }
        const messages = serializeMessages(options.messages);
        // harness 的 GenerateOptions.system 是独立的系统提示（如标题生成的
        // systemPrompt、agent 的 persona）。后端 chat/completions 只接受
        // messages 数组里的 system 角色，必须显式插入——否则模型看不到
        // system 指令，只见到 user prompt 本身（实测 2026-08-22：session
        // 标题变成了 "We need to generate a session title..." 的 prompt 回显）。
        if (options.system !== undefined && options.system.length > 0) {
            messages.unshift({ role: 'system', content: options.system });
        }
        // 将 harness 工具模式以 OpenAI function 格式告知模型，
        // 与 deepseek 适配器序列化 GenerateOptions.tools 的方式一致。
        const tools = options.tools?.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
        // deepseek-v4 大文件写入修复（详见 isDeepseekV4Model 注释）：标准
        // tool_calls 参数一次性打包生成，SSE 静默 >60s 被网关掐断。仅当工具
        // 列表含大参数写文件类工具（write/file_write/apply_patch）时切换到
        // DSML：不发送 tools 字段、把 schema 注入 system 提示，让模型以
        // DSML 流式输出工具调用，全程有数据流、不触发网关空闲断连。read/
        // bash 等小参数工具保持标准 tool_calls，避免 DSML 带来的额外开销。
        let wireTools = tools;
        if (wireTools !== undefined && needsDsmlToolMode(options.model, wireTools.map(tool => tool.function.name))) {
            // DSML 工具说明置于 system 之后、user 之前：与 CodeArts Agent IDE
            // 实际请求体一致（IDE 把工具说明作为 system 消息放在最前）。实证
            // （2026-08-22）：DSML 提示 push 到 messages 末尾时，deepseek-v4
            // 倾向把思考写入 content（正文）而非 reasoning_content；unshift 到
            // user 之前后模型恢复走 reasoning 通道，思考不再泄漏到正文。
            messages.splice(messages.findIndex(m => m.role === 'system') + 1, 0, { role: 'system', content: buildDsmlSystemPrompt(wireTools) });
            wireTools = undefined;
        }
        const body = JSON.stringify({
            model: options.model,
            messages,
            stream: true,
            // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回 cached_tokens，
            // 缺少该字段时缓存命中恒为 0（实测 2026-08-24）。
            prompt_cache_key: this.sessionId,
            // include/reasoning_summary 对齐 Rust 端 CodeArtsExtraFields，
            // 让服务端返回加密 reasoning 内容与摘要。
            include: ['reasoning.encrypted_content'],
            reasoning_summary: 'auto',
            // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
            // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
            // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
            // （error decoding response body）。deepseek-v4 的 DSML 路径不受此
            // 影响，保留该字段与 IDE 对齐。
            tool_stream: true,
            // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
            // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
            // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
            // 工具校验报 `invalid arguments: "arguments" must be an object`。
            // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝；
            // 显式传入的 options.maxTokens 优先，未设置时默认 65536。
            max_tokens: options.maxTokens ?? 65536,
            ...wireTools !== undefined && wireTools.length > 0 ? { tools: wireTools } : {},
        });
        const url = `${CHAT_API_BASE}/chat/completions`;
        // CodeArts 按账户限制并发：当会话上限
        // 达到时请求以 TM.00001041 失败（或 SSE 流内返回
        // InferHub.ModelArts.81111.429 等排队/限流错误）。对齐参考实现
        // （deveco-code-rust runner.rs）：排队时不等待状态端点
        // working，而是每 QUEUE_RETRY_DELAY_MS 直接重试 chat 请求，
        // 上限 QUEUE_MAX_ATTEMPTS 次（180 × 10s = 30 分钟）。
        let response;
        let queueAttempts = 0;
        // 鉴权失败（APIG.0602 / 401 / 403）后已刷新过凭据：避免死循环，
        // 同一次 stream() 调用最多 refresh 一次。
        let authRefreshed = false;
        // 因限流已尝试过的账号 id：保证每个账号只试一次，试完才判定"全部受限"。
        const rateLimitTried = new Set();
        if (currentAccountId)
            rateLimitTried.add(currentAccountId);
        // benefit（免费额度）模型判定在重试循环外先算好：它要读 benefit 集合缓存
        // （`~/.cache/deveco/codearts_benefit_models.json`），不宜每轮重试都做 IO。
        // 集合来自 gateway/config 的模型清单 ∪ 静态兜底（见 isCodeArtsBenefitModel），
        // 使后端新增 benefit 模型时无需改代码即可自动识别。
        const isBenefitModel = isCodeArtsBenefitModel(options.model);
        for (;;) {
            // benefit（免费额度）模型（glm-5.3-flash、deepseek-v4.1-flash 等）后端要求
            // maas_type: benefit 头参与 SDK-HMAC-SHA256 签名，否则返回
            // InferHub.002002009.404 "model is not registered"。
            //
            // 判定必须是**动态**的：早期只硬编码 glm-5.3-flash 一个模型，导致
            // deepseek-v4.1-flash 等其它 benefit 模型调用失败（用户报障：
            // 发消息后报 Insufficient Balance / QUOTA —— 缺该头时后端按非 benefit
            // 通道处理该模型）。实证见 CODEARTS_BENEFIT_FALLBACK 注释。
            const extraSignedHeaders = isBenefitModel ? { maas_type: 'benefit' } : undefined;
            const signed = await signRequestHuawei(credential.access_key_id, credential.secret_access_key, credential.security_token, 'POST', url, new TextEncoder().encode(body), extraSignedHeaders);
            const headers = new Headers(attributionHeaders());
            // 签名 map 中的额外头（如 maas_type）必须随请求发送——它们已参与
            // canonical 计算、包含在 SignedHeaders 列表中，缺失会导致服务端验签失败。
            signed.forEach((value, key) => { if (key !== 'content-type')
                headers.set(key, value); });
            headers.set('Content-Type', 'application/json');
            headers.set('Chat-Id', this.chatId);
            headers.set('Session-Id', this.sessionId);
            headers.set('lang', 'en');
            response = await this.fetchImpl(url, {
                method: 'POST',
                headers,
                body,
                signal: options.signal,
            });
            if (response.ok) {
                // 200：消费 SSE 流。CodeArts 有时以 HTTP 200 + SSE 内嵌
                // error_code/error_msg 返回排队/限流（如 InferHub.ModelArts.81111.429
                // TPM 超限），而非 4xx——consumeSse 检测到可重试排队错误时抛
                // SseQueueRetryError，落入下方排队重试逻辑，与 TM.00001041 一致。
                try {
                    yield* this.consumeSse(response, options);
                    break;
                }
                catch (error) {
                    if (!(error instanceof SseQueueRetryError))
                        throw error;
                    // 落入下方排队重试
                }
            }
            else {
                const errorText = await response.text().catch(() => '');
                // 鉴权失败（SecurityToken 过期/被吊销/APIG.0602）：刷新一次凭据后
                // 重试整个 chat 请求。入口的 expires_at 预判无法覆盖后端提前吊销
                // 或时钟偏差场景，这里做兜底，避免把可自愈的鉴权失败抛给用户。
                if (isAuthError(response.status, errorText) && !authRefreshed) {
                    authRefreshed = true;
                    await this.options.refresh();
                    credential = await this.options.resolveCredential();
                    if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
                        throw new LlmError('codearts: credential missing after refresh; log in again', 'MISSING_CREDENTIAL');
                    }
                    continue;
                }
                // 限流处理：记录当前账号在该模型上的重置时间，然后切换账号重试
                // （外层 for(;;) 会在拿到新凭据后重新签名发请求）。用 tried 集合
                // 保证每个账号只尝试一次，试完才判定"全部受限"——避免只试一个
                // 就下结论，导致 UI 限流状态与实际判定不一致。
                if (this.options.accountPool && isRateLimited(errorText)) {
                    const parsed = parseRateLimitError(errorText, options.model);
                    if (parsed) {
                        if (currentAccountId) {
                            await this.options.accountPool.updateModelRateLimit(currentAccountId, parsed.modelId, parsed.resetTimeMs);
                        }
                        const next = await this.options.accountPool.getAvailableAccount('codearts', options.model);
                        if (next && !rateLimitTried.has(next.entry.id)) {
                            rateLimitTried.add(next.entry.id);
                            credential = next.credential;
                            currentAccountId = next.entry.id;
                            authRefreshed = false; // Reset auth refresh flag for new credential
                            continue; // Retry request with new credential
                        }
                        throw new LlmError(`codearts: 模型 ${options.model} 所有账号均受限，请稍后再试`, 'QUOTA_EXCEEDED');
                    }
                }
                if (!isQueueError(response.status, errorText)) {
                    // 非 TM.00001041 错误也未必没排队：openpangu 等模型的并发限流
                    // 错误码/HTTP 状态可能与 GLM 不同，但仍会进入后端队列。先探测
                    // 排队状态端点——只有端点确认会话在排队（waiting/queue_full）时
                    // 才进入排队流程；端点不可达或未排队（working）则按原错误分类
                    // 立即抛出，避免把真错误（如 401/400）拖成 30 分钟超时。
                    const probe = await this.queryQueueStatus(credential, options.model, options.signal);
                    if (probe === undefined || probe.status === 'working') {
                        // 与 deepseek 适配器的 httpErrorCode 词汇保持一致；
                        // 400 + 上下文超限措辞归为 CONTEXT_WINDOW_EXCEEDED（触发 compaction）。
                        const code = httpErrorCode(response.status, errorText);
                        throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status });
                    }
                    // probe.status 为 'waiting' 或 'queue_full' → 落入下方排队流程。
                }
            }
            // TM.00001041 / 状态端点确认排队 / SSE 内排队错误：对齐参考实现
            // 直接重试 chat 请求，每 QUEUE_RETRY_DELAY_MS（10s）一次，上限
            // QUEUE_MAX_ATTEMPTS（180）次，不等待状态端点 working。排队期间
            // 不产出任何内容块（StreamChunk 协议没有独立的瞬态状态通道，
            // 任何 reasoning/text 块都会被 BlockAssembler 组装进 assistant
            // 消息并持久化到会话历史，reasoning 块还会显示在 web 的 Think
            // 区域，且 visible 回退可能把推理文本作为正文回传给模型），因此
            // 保持静默，web 显示 harness 自身的"运行中"状态。每次重试前查询
            // 状态端点：终态（error/queue_full）立即抛错，其余情况
            // （waiting/working/端点不可达）等待后直接重试 chat。
            queueAttempts += 1;
            if (queueAttempts > QUEUE_MAX_ATTEMPTS) {
                throw new LlmError('codearts: queue wait timed out after 30 minutes', 'QUEUE');
            }
            if (options.signal?.aborted)
                throw new LlmError('codearts: request aborted while waiting in queue', 'QUEUE');
            const status = await this.queryQueueStatus(credential, options.model, options.signal);
            if (status?.status === 'error' || status?.status === 'queue_full') {
                throw new LlmError(`codearts: ${status.message || `queue status: ${status.status}`}`, 'QUEUE');
            }
            await delay(QUEUE_RETRY_DELAY_MS, options.signal);
            // 直接重试 chat 请求（外层 for(;;) 循环）
        }
    }
    /**
     * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
     *
     * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
     * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
     * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
     * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
     * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
     * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
     * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
     */
    async *consumeSse(response, options) {
        if (!response.body)
            throw new LlmError('codearts: empty model response body', 'EMPTY_RESPONSE');
        // 块组装状态：文本 / 推理 / 工具调用各自拥有唯一
        // 索引，与 harness StreamChunk→ContentBlock 契约一致。
        const blocks = [];
        let nextIndex = 0;
        const toolCalls = new Map();
        const toolOrder = [];
        let buffer = '';
        let streamEnded = false;
        let finishReason;
        /**
         * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
         * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
         *
         * 本适配器有**两处** reasoning 出口，两处都必须喂入同一判据（漏一处
         * 就等于漏一条路径）：① `emitDsmlFeed` 的 `reasoning` 聚合参数；
         * ② `delta.reasoning_content` → `dsmlReasoningExtractor` → `thinking`。
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
         *
         * ⚠️ **本适配器刻意不做 `</think:hex>` 归位**（与其余四个适配器不同）：
         * 实测那 28 处标签**全部出自 `workbuddy`**（`hy4-preview-f` 25 处、
         * `workbuddy/deepseek-v4.1-flash` 3 处），codearts 一条都没有。
         * 更关键的是，本适配器的正文出口带 **`visible` 回退**（正文为空且无工具
         * 调用时用推理文本回填可见区）—— 若在此处把正文归位成空串，回退会立刻
         * 把整段思考**复制回正文**，等于归位失效并放大问题。故此处只加守卫。
         */
        const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let proseLoopDetected = false;
        /**
         * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
         * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
         *
         * ⚠️ **本适配器的两个 reasoning 出口必须共用这一个实例**：
         * ① `emitDsmlFeed` 的 `reasoning` 参数、② `delta.reasoning_content` →
         * `thinking`。两处都用 `blocks.find(kind === 'reasoning')` 找**同一个**
         * reasoning 块 —— 若各持一个 helper，第二处就会从空态重新开始累积
         * （明明已有非空白内容却被判为「至今仍空白」），`text()` 也随之错乱。
         *
         * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
         * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
         * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
         */
        const suppressor = createBlankReasoningSuppressor();
        // DSML 提取器：从 delta.content 中识别模型以原生 DSML XML 风格
        // 写入的工具调用（deepseek-v4 等模型在工具模式不匹配时会直接
        // 输出 `<｜DSML｜tool_calls>...`），解析为结构化 tool-call，
        // 避免原始 token 泄漏到 web UI。
        // content 与 reasoning_content 两个通道使用各自独立的 DSML 提取器。
        // 早期实现共用单个提取器，但 deepseek-v4 有时在 content 通道输出
        // <thought> 开标签（提取器进入 in-thought 状态）后，把后续推理与
        // DSML 工具调用写到 reasoning_content 通道——共用提取器会把
        // reasoning_content 的 DSML 块当作 thought 内容吞掉，不解析为
        // tool-call，最终残留 DSML 标签经 visible 回退泄漏到正文（实测
        // session-067dcf78 turn1 step13 / turn2 step3）。独立提取器让各
        // 通道状态机互不污染。
        const dsmlContentExtractor = new DsmlContentExtractor();
        const dsmlReasoningExtractor = new DsmlContentExtractor();
        // 分流 DSML 提取结果：正文文本进入 text 块、thought 进入 reasoning
        // 块、解析出的工具调用进入 tool-call 块。
        async function* emitDsmlFeed(text, reasoning, dsmlCalls) {
            if (text.length > 0) {
                let block = blocks.find(candidate => candidate.kind === 'text');
                if (block === undefined) {
                    block = { index: nextIndex++, kind: 'text', text: '' };
                    blocks.push(block);
                    yield { type: 'block-start', index: block.index, blockType: 'text' };
                }
                // 正文死循环守卫（见 `proseLoopGuard` 注释）。命中后只停止累积与发射，
                // 绝不 `reader.cancel()`、绝不改 finish reason。
                if (proseLoopGuard !== undefined) {
                    if (proseLoopGuard.observe(text))
                        proseLoopDetected = true;
                }
                if (!proseLoopDetected) {
                    block.text += text;
                    yield { type: 'text-delta', index: block.index, text };
                }
            }
            if (reasoning.length > 0) {
                // 死循环守卫：命中后不再累积、不再发射。
                //
                // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
                // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
                // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
                // 若在此处直接 `break`，本 chunk 剩余的行会被整块跳过。
                // ⚠️ 也**不能用 `continue`**（Task 2 审查发现并已实测复现）：它会
                // 连带跳过**同一帧内**位于本分支之后的处理（`usage` 记账、DSML
                // tool-call 解析），导致 token 统计静默丢失。故用 `if (!loopDetected)`
                // 守卫分支体。
                if (loopGuard !== undefined) {
                    if (loopGuard.observe(reasoning))
                        loopDetected = true;
                }
                if (!loopDetected) {
                    // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
                    // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
                    const emit = suppressor.feed(reasoning);
                    if (emit !== undefined) {
                        let block = blocks.find(candidate => candidate.kind === 'reasoning');
                        if (block === undefined) {
                            block = { index: nextIndex++, kind: 'reasoning', text: '' };
                            blocks.push(block);
                            yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
                        }
                        // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本，
                        // 用 `+=` 会双写。本适配器两个出口共用同一 helper，故回写值恒为
                        // 两处共同累积的完整文本。
                        block.text = suppressor.text();
                        yield { type: 'reasoning-delta', index: block.index, text: emit };
                    }
                }
            }
            for (const call of dsmlCalls) {
                // 与 delta 路径同一条判据：名字不可用的调用**一个 chunk 都不产出**
                // （否则 `BlockAssembler` 会组装出 `name:''` 的块并污染会话，
                // 让下游端点以 400 code 11133 拒绝之后每一次请求）。
                if (!hasUsableToolName(call.name))
                    continue;
                const wireIndex = toolCalls.size;
                // DSML 语法没有 provider 签发的 call id，必须生成唯一 id：
                // harness 的 tool/call ↔ tool/result 配对与 web UI 的工具行
                // 渲染都用 callId 作为 key（见 client-runtime 匹配器
                // `tool/call -> id: String(callId)`），空 id 会让同一响应的
                // 多个工具调用（或历史重放）配对冲突，UI 只能回退为泛化的
                // "Tool call" 行而丢失 read/write 专属控件。
                const block = {
                    index: nextIndex++,
                    text: call.arguments,
                    name: call.name,
                    callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
                    announced: true,
                };
                toolCalls.set(wireIndex, block);
                toolOrder.push(block.index);
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                yield {
                    type: 'tool-call-delta',
                    index: block.index,
                    id: block.callId,
                    name: block.name,
                    argumentsDelta: call.arguments,
                };
            }
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        // 首 token 与 chunk 间超时分阶段使用（对齐 CodeArts Agent IDE）：
        // 第一次读取用 firstTokenTimeout（5min），收到首 chunk 后切换为
        // chunkTimeout（10min），并在每次成功读取后重置。deepseek-v4-flash
        // 生成大文件 write 的 content 参数时，首 token 后可能长时间静默，
        // 需要远大于网关 60s 的窗口才不会误判可重试 TIMEOUT 而反复重试。
        let firstTokenReceived = false;
        try {
            for (;;) {
                if (streamEnded)
                    break;
                // CodeArts 网关对 SSE 有 ~60s 空闲超时：模型生成长推理 / 大工具
                // 参数时两次 chunk 间可能静默数十秒，连接被对端掐断后 reader.read()
                // 抛 `TypeError: terminated`（非 HarnessError → UNKNOWN 不可重试 →
                // harness 直接失败）。以略小于网关超时的窗口主动检测空闲：超时则
                // 取消 reader 并抛可重试 TIMEOUT；同时把传输级错误映射为可重试
                // TRANSPORT，让 harness 重试该步骤而非直接失败。
                let done;
                let value;
                try {
                    const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
                    const phase = firstTokenReceived ? 'chunk' : 'first-token';
                    const result = await readCodeArtsChunk(reader, timeoutMs, options.signal, phase);
                    done = result.done;
                    value = result.value;
                    if (!done)
                        firstTokenReceived = true;
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw error;
                    if (error instanceof LlmError)
                        throw error;
                    if (isTransportError(error)) {
                        throw new LlmError(`codearts: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
                    }
                    throw error;
                }
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
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
                    // SSE 内嵌错误检测：CodeArts 以 HTTP 200 + error_code/error_msg
                    // 返回排队/限流（如 InferHub.ModelArts.81111.429 TPM 超限）。
                    if (typeof data.error_code === 'string' && data.error_code.length > 0) {
                        const message = typeof data.error_msg === 'string' && data.error_msg.length > 0
                            ? data.error_msg
                            : data.error_code;
                        if (isSseQueueErrorCode(data.error_code)) {
                            throw new SseQueueRetryError(data.error_code, message);
                        }
                        throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 });
                    }
                    const choice = data.choices?.[0];
                    const delta = choice?.delta;
                    if (typeof choice?.finish_reason === 'string') {
                        finishReason = choice.finish_reason;
                    }
                    if (delta?.content) {
                        // 通过 DSML 提取器：纯文本作为 text-delta 放行，
                        // <thought> 内容作为 reasoning-delta 放行（显示在 Think 区域），
                        // DSML 块解析为结构化 tool-call（与 delta.tool_calls 路径
                        // 合并到同一 toolCalls/toolOrder 状态）。
                        const { text, reasoning, toolCalls: dsmlCalls } = dsmlContentExtractor.feed(delta.content);
                        yield* emitDsmlFeed(text, reasoning, dsmlCalls);
                    }
                    if (delta?.reasoning_content) {
                        // 模型放在 reasoning_content 通道的内容就是思考，必须进入
                        // reasoning 块（Think 区域），绝不能作为正文输出。实测
                        // （2026-08-22）：deepseek-v4-flash 的 reasoning_content 通常
                        // 没有 <thought> 标签，提取器会把整段当作 `text` 返回——若把
                        // `text` 发给正文块，思考就泄漏到正文（TUI 显示 The user wants
                        // me to... 跑到正文）。因此这里把 `text + reasoning` 合并后
                        // 全部作为 reasoning 输出，仅 DSML 工具调用块单独解析执行。
                        const { text, reasoning, toolCalls: reasoningDsmlCalls } = dsmlReasoningExtractor.feed(delta.reasoning_content);
                        const thinking = text + reasoning;
                        if (thinking.length > 0) {
                            // 死循环守卫：与上面 `emitDsmlFeed` 的 `reasoning` 分支同一判据，
                            // 两条出口都要接（漏一处就等于漏一条路径）。
                            //
                            // ⚠️ 守卫必须**同时包住** `block.text += thinking` 与 `yield`
                            // 两行 —— 只拦 yield 的话，累积文本仍含循环内容，收尾的截断
                            // 就失效了。这里**只跳过发射**：止损（`reader.cancel()` + `break`）
                            // 在本 chunk 行循环处理完之后执行（见下方 ★ 止损块），故同帧的
                            // usage 记账不受影响；**也不能用 `continue`**（会连带跳过本帧
                            // 之后的 usage 记账）。
                            if (loopGuard !== undefined) {
                                if (loopGuard.observe(thinking))
                                    loopDetected = true;
                            }
                            if (!loopDetected) {
                                // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发。
                                // ⚠️ 与出口①共用**同一个** `suppressor`：两处落在同一个
                                // `blocks.find(kind === 'reasoning')` 块上，各自累积会错乱
                                // （出口②会误判「整块迄今仍空白」而丢弃本已有内容的块）。
                                const emit = suppressor.feed(thinking);
                                if (emit !== undefined) {
                                    let block = blocks.find(candidate => candidate.kind === 'reasoning');
                                    if (block === undefined) {
                                        block = { index: nextIndex++, kind: 'reasoning', text: '' };
                                        blocks.push(block);
                                        yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
                                    }
                                    // ⚠️ **整块回写**（赋值，不是 `+=`）。
                                    block.text = suppressor.text();
                                    yield { type: 'reasoning-delta', index: block.index, text: emit };
                                }
                            }
                        }
                        for (const call of reasoningDsmlCalls) {
                            // 同 delta 路径：名字不可用者一个 chunk 都不产出（见上）。
                            if (!hasUsableToolName(call.name))
                                continue;
                            const wireIndex = toolCalls.size;
                            const block = {
                                index: nextIndex++,
                                text: call.arguments,
                                name: call.name,
                                callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
                                announced: true,
                            };
                            toolCalls.set(wireIndex, block);
                            toolOrder.push(block.index);
                            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                            yield {
                                type: 'tool-call-delta',
                                index: block.index,
                                id: block.callId,
                                name: block.name,
                                argumentsDelta: call.arguments,
                            };
                        }
                    }
                    for (const call of delta?.tool_calls ?? []) {
                        const wireIndex = call.index ?? 0;
                        let block = toolCalls.get(wireIndex);
                        if (block === undefined) {
                            block = { index: nextIndex++, text: '', announced: false };
                            toolCalls.set(wireIndex, block);
                        }
                        if (call.id !== undefined)
                            block.callId = call.id;
                        // 后续参数分片会带上空的 function.name（""），它不是 undefined，
                        // 直接覆盖会把首个分片解析出的真实工具名清空，导致
                        // `unknown tool ""`。只有非空名字才允许更新。
                        if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
                            block.name = call.function.name;
                        }
                        const fragment = call.function?.arguments ?? '';
                        block.text += fragment;
                        // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` / `buddy-adapter.ts`
                        // 同因同修）。只跳过收尾的 `block-end` 不够 —— `BlockAssembler`
                        // 会把没有 block-end 的 partial 也组装成 `name:''`，污染会话后让
                        // 腾讯系端点以 400 code 11133 拒绝之后每一次请求。
                        if (!block.announced) {
                            if (!hasUsableToolName(block.name))
                                continue;
                            block.announced = true;
                            toolOrder.push(block.index);
                            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                            yield {
                                type: 'tool-call-delta',
                                index: block.index,
                                id: ToolCallId(block.callId ?? ''),
                                name: block.name,
                                argumentsDelta: block.text,
                            };
                            continue;
                        }
                        yield {
                            type: 'tool-call-delta',
                            index: block.index,
                            id: ToolCallId(block.callId ?? ''),
                            ...block.name !== undefined ? { name: block.name } : {},
                            argumentsDelta: fragment,
                        };
                    }
                    if (data.usage) {
                        const promptTokens = data.usage.prompt_tokens ?? 0;
                        const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
                            ?? data.usage.prompt_cache_hit_tokens
                            ?? 0;
                        const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
                        const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
                        yield {
                            type: 'usage',
                            usage: {
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
        // 流结束：分别 flush content 与 reasoning_content 两个独立 DSML 提取器。
        // 若模型输出了不完整的 DSML 块（被 max_tokens 截断或模型异常终止），
        // 残留内容作为纯文本放行，避免吞掉用户可见内容；不完整的 <thought>
        // 块作为 reasoning 放行，避免推理泄漏到正文；同时让 finish_reason='length'
        // 路径生效，触发 harness max-tokens 续写而非执行不完整工具调用。
        // 复用 emitDsmlFeed 把残留 text/reasoning 路由到对应块。
        {
            const f = dsmlContentExtractor.flush();
            if (f.text.length > 0 || f.reasoning.length > 0)
                yield* emitDsmlFeed(f.text, f.reasoning, []);
        }
        {
            const f = dsmlReasoningExtractor.flush();
            if (f.text.length > 0 || f.reasoning.length > 0)
                yield* emitDsmlFeed(f.text, f.reasoning, []);
        }
        // 按创建顺序关闭每个块。GLM 端点偶尔把整个回答作为 reasoning_content
        // 发出且 content 为空：此时正文区为空，回退用推理文本填充可见区。
        // 但若推理中解析出了 DSML 工具调用（deepseek-v4 的 reasoning_content
        // 内嵌工具块），正文由工具调用承担，不再把推理复制为可见文本。
        const textBlock = blocks.find(block => block.kind === 'text');
        const reasoningBlock = blocks.find(block => block.kind === 'reasoning');
        // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
        // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
        // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
        //
        // ⚠️ 行首 `course` / `课` 泄漏清洗（`stripCourseLeak`）**在此处一次性完成**：
        // `reasoningText` 同时供 `reasoningHasDsml` 判定、`visible` 回退与
        // reasoning `block-end` 使用，故在此清洗可覆盖全部三处出口，
        // 不会出现「正文干净而 Think 区仍脏」或反之的不一致。
        const reasoningText = stripCourseLeakIfEnabled(loopDetected && loopGuard?.cutAt !== undefined
            // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
            // `reasoningBlock.text` —— 两个出口共用同一 helper，以它为准才能保证
            // 累积口径一致；`reasoningBlock` 仅用于取块 `index`。
            ? suppressor.text().slice(0, loopGuard.cutAt)
            : suppressor.text());
        // visible 回退：正文为空且无工具调用时，用推理文本填充可见区（GLM 端点
        // 偶尔把整个回答作为 reasoning_content 输出）。但若推理含 DSML 标签
        // （deepseek-v4 在推理中引用 DSML 语法讨论实现方案，非完整工具调用块），
        // 不能复制为正文——DSML 标签泄漏到正文会被模型当用户输入，导致任务
        // 终止或循环（实测 session-a69fa289 turn2 step26：推理仅含 DSML 闭合
        // 标签片段，visible 回退复制到正文后任务终止）。此时正文留空，推理仍
        // 在 Think 区域可见。
        //
        // ⚠️ 回退必须用**截断后**的 `reasoningText`，不能用 `reasoningBlock.text`：
        // 命中死循环时正文恰好为空且无工具调用，用原文会把病态循环全文复制进
        // 正文块并持久化，下次重放又要重新吃一遍（正是本守卫要根除的问题）。
        const reasoningHasDsml = reasoningText.includes('｜DSML｜');
        // ⚠️ 正文出口也必须清洗 —— 不能只清 reasoning。
        //
        // 本适配器的 `visible` 有**两条来源**：正文块，或（正文为空且无工具调用时的）
        // reasoning 回退。初版只对 reasoning 侧调了 `stripCourseLeakIfEnabled`，
        // 正文侧直接取 `textBlock.text` 原值 —— 于是「正文块里带行首泄漏」这一路径
        // 完全没被覆盖，`block-end` 发出去的仍是脏文本（同型缺陷见
        // `buddy-adapter.ts` / `lobsterai-adapter.ts` / `trae-adapter.ts` 的
        // text 出口，那几处均已清洗）。
        //
        // 清洗放在**取值处**而非 `block-end` 处：`visible` 同时供 text `block-end`
        // 与下方回退判定使用，在此清洗可保证两条出口一致（不会出现「正文块干净、
        // 回退脏」或反之）。`reasoningText` 已是清洗后的值，故回退分支无需再清。
        // 正文死循环截断：只保留循环前的干净前缀。
        // ⚠️ **不改 finish reason**：工具调用仍要被执行。
        //
        // ⚠️ 截断必须在 `visible` 回退**之前**应用：否则「正文命中循环 → 截断后为空
        // → 回退又把推理文本复制进正文」会把病态循环原样搬到可见区。
        const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
            ? (textBlock?.text ?? '').slice(0, proseLoopGuard.cutAt)
            : undefined;
        const visible = truncatedText !== undefined
            ? stripCourseLeakIfEnabled(truncatedText)
            : textBlock !== undefined && textBlock.text !== ''
                ? stripCourseLeakIfEnabled(textBlock.text)
                : reasoningBlock !== undefined && toolOrder.length === 0 && !reasoningHasDsml ? reasoningText : '';
        /**
         * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
         *
         * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
         * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
         * 或被 `cutAt` / `course` 清洗成空串的块。用 `blocks.length` 会把
         * 「零块响应」误判成「有块」，于是静默结束的缺陷原样保留。
         *
         * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
         * 本适配器有**两个**容易算错的地方：
         *
         * 1. **正文块的条件含 `visible` 回退**：判据是
         *    `textBlock !== undefined || visible !== ''`（不是只看 `textBlock`）。
         *    `visible` 在「正文为空且无工具调用」时用推理文本填充 —— 此时
         *    `textBlock` 可能是 `undefined`（正文一个 delta 都没收到），
         *    但块**确实会发出**。只数 `textBlock` 会漏掉它、把一个非空响应
         *    误判成零块。
         * 2. **reasoning 块是双层条件**：外层 `trim() !== ''`、内层
         *    `reasoningText !== ''`。只有两层都过才真的发 `block-end`。
         */
        let blockCount = 0;
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
                    // 同上：空分片补 {}，残缺参数保持原样交由截断判定处理。
                    arguments: isTruncatedArguments(block.text)
                        ? block.text
                        : normalizeToolArguments(block.text),
                },
            };
        }
        // ⚠️ 计数条件必须与上面的**发射**条件逐字一致（含 `|| visible !== ''`）：
        // `visible` 回退会用推理文本回填正文，只数 `textBlock` 会把「有正文」误判成
        // 零块、进而错报 EMPTY_RESPONSE。
        //
        // 就当前实现而言，`|| visible !== ''` 这一半在**计数**上是冗余的防御
        // （`visible !== ''` 蕴含 reasoning 那块也非空，下一段的计数必命中，
        // 故块数不会因此为 0）—— 已用变异测试证实。但在**发射**上它是必需的
        // （去掉它会让 `llm-adapter.spec.ts` 的 visible 回退用例失败）。
        if (textBlock !== undefined || visible !== '') {
            blockCount += 1;
            yield { type: 'block-end', index: textBlock?.index ?? nextIndex, block: { type: 'text', text: visible } };
        }
        // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
        // 文本改用上面的 `reasoningText`（源自 `suppressor.text()`，已应用 cutAt
        // 截断与 course 清洗），保证与 `visible` 回退、`reasoningHasDsml` 同一口径。
        if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
            if (reasoningText !== '') {
                blockCount += 1;
                yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningText } };
            }
        }
        // finish_reason 映射顺序很关键：'length'（输出被 max_tokens 截断）必须优先于
        // 工具调用检查。若先看 toolOrder.length > 0，截断的工具调用会被报告为
        // 'tool-calls'，harness 将执行其不完整的 JSON 参数（报 INVALID_ARGS），并
        // 把截断参数持久化进会话历史——web 加载历史时 presenter 解析也会失败
        // （"Unterminated string in JSON"）。报告 max-tokens 后，dsh 会丢弃不完整的
        // 工具调用并触发 max-tokens 续写（分批生成），避免脏数据与错误执行。
        //
        // 另：丢弃了无名 tool-call 且没有留下任何可用调用时，同样报 max-tokens 而
        // 非 stop —— 否则模型本意调工具、harness 却认为「正常答完了」，
        // 又是一次无报错中断（与 `openai-compat.ts` 同因同修）。
        const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced);
        const reason = loopDetected
            // 思考死循环：截断并报可重试。**优先级最高**（高于 tool_calls）——
            // 循环中生成的工具调用参数不可信；且若无可用调用，落到 `stop` 会让
            // 任务静默中断。
            ? { kind: 'max-tokens' }
            : finishReason === 'length'
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
    /**
     * 查询某个会话的 CodeArts 并发队列状态。该端点
     * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
     * @param credential - 用于签名请求的 AK/SK/SecurityToken。
     * @param model - 模型 id，作为 `model` 查询参数回传。
     * @param signal - 状态请求的取消信号。
     * @returns 解析后的排队状态，或当端点不可达
     *   或返回无法识别的载荷时返回 `undefined`。
     */
    async queryQueueStatus(credential, model, signal) {
        const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`;
        const signed = await signRequestHuawei(credential.access_key_id, credential.secret_access_key, credential.security_token, 'GET', url, new Uint8Array());
        const headers = new Headers();
        signed.forEach((value, key) => { if (key !== 'content-type')
            headers.set(key, value); });
        headers.set('x-snap-traceid', crypto.randomUUID());
        headers.set('Agent-Type', 'INFERHUB_AGENT');
        headers.set('X-Language', 'en');
        let response;
        try {
            response = await this.fetchImpl(url, { method: 'GET', headers, signal });
        }
        catch {
            return undefined;
        }
        if (response.status !== 200)
            return undefined;
        let body;
        try {
            body = await response.json();
        }
        catch {
            return undefined;
        }
        const status = body.status;
        if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full')
            return undefined;
        return {
            status,
            queuePosition: Number(body.queue_position ?? -1),
            message: typeof body.message === 'string' ? body.message : '',
        };
    }
}
/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export function registerCodeArtsLlm(ctx, options) {
    ctx.llm.registerConfigurableProviders([
        {
            provider: PROVIDER,
            displayName: 'CodeArts Agent',
            // 0.1.7 起 settings 命名空间只能是 profile 条目 id（见 settingsNamespaceFor）。
            settingsNs: settingsNamespaceFor(ctx, 'llm-codearts'),
            settingsPath: [],
        },
    ]);
    const adapter = new CodeArtsAdapter(options);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
    // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
    return adapter;
}
/**
 * CodeBuddy 系（buddy / workbuddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004;
/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本、以及 CodeArts（华为云）的中文错误都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（用户报障，仅国际版暴露）：此处早期只有
 * 中文词（频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版 WorkBuddy
 * （www.workbuddy.ai）返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，直接抛出
 * 原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST 而非
 * QUOTA_EXCEEDED。国内版返回中文文案，所以该缺陷只在国际版复现。
 *
 * `too many requests` 是标准 OpenAI 429 措辞，一并纳入。
 */
const RATE_LIMIT_PATTERN = /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i;
/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性；这里只认 JSON 顶层的 `code` 字段。
 * 兼容 `"6004"`（字符串）与 `6004`（数字）两种编码。
 */
function hasRateLimitBusinessCode(body) {
    try {
        const data = JSON.parse(body);
        const code = data.code;
        return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE);
    }
    catch {
        // 非 JSON：交给文案兜底
        return false;
    }
}
/** 判断错误文本是否为频率限制错误 */
export function isRateLimited(body) {
    return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body);
}
/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（workbuddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, ..."
 *
 * 早期只列了中文句式，导致国际版即使判定为限流也只能走「1 小时后重试」的
 * 兜底，丢掉服务端给出的真实重置时刻（UI 限流徽章因此显示错误时间）。
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i;
/** 从限流错误中提取重置时间 */
export function parseRateLimitError(body, currentModel) {
    try {
        const data = JSON.parse(body);
        const msg = typeof data.msg === 'string' ? data.msg : '';
        const resetMatch = RESET_TIME_PATTERN.exec(msg);
        if (resetMatch) {
            // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
            const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`);
            if (!Number.isNaN(resetMs)) {
                return { modelId: currentModel, resetTimeMs: resetMs };
            }
        }
        // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
        if (isRateLimited(body)) {
            // fallback: 1小时后重试
            return { modelId: currentModel, resetTimeMs: Date.now() + 3_600_000 };
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=llm-adapter.js.map