/**
 * Qoder 加密推理端点的**响应解包**。
 *
 * ## 为什么需要
 *
 * 加密端点 `agent_chat_generation` 的响应是 SSE，但每帧多一层信封：
 *
 * ```
 * data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
 *                               ↑ 这里才是标准 OpenAI chunk（JSON 字符串）
 * ```
 *
 * ⚠️ **内层 `body` 并未加密** —— 只有**请求**体需要 WASM 加密。
 * 因此这里只做「剥信封」，不涉及任何解密。
 *
 * 剥完后就是标准的 OpenAI SSE，可直接交给 `consumeOpenAiSse`。
 *
 * ## 错误形态
 *
 * 失败时内层 `body` 是业务错误 JSON（`[FAIL]node:... msg:...`），
 * 必须**抛出**而不是当成无内容 —— 否则会重演「静默停止」那个缺陷。
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
/** 从信封 JSON 文本里取出内层 OpenAI 帧文本；无法识别时返回 null。 */
function innerTextOf(payload) {
    let envelope;
    try {
        envelope = JSON.parse(payload);
    }
    catch {
        return null;
    }
    // 不是信封（缺 body 字段）→ 视为已经是标准帧
    if (envelope.body === undefined)
        return null;
    return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body);
}
/**
 * 把信封 SSE 转成标准 OpenAI SSE。
 *
 * 逐帧处理 `data:` 行；非 `data:` 行（如 `event:finish`）原样保留，
 * `[DONE]` 原样传递。
 */
export function unwrapQoderEnvelopePayload(payload) {
    const inner = innerTextOf(payload);
    if (inner === null)
        return null;
    return inner;
}
/**
 * 把 Qoder 信封 SSE 流转成标准 OpenAI SSE 流。
 *
 * @param response 原始响应（`body` 必须是可读流）。
 * @returns 新的 `Response`，其 body 为标准 OpenAI SSE 文本流。
 */
export function unwrapQoderEnvelopeStream(response, label) {
    const upstream = response.body;
    if (upstream === null) {
        throw new LlmError(`${label}: 响应没有 body`, 'SERVER');
    }
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    let buffer = '';
    const transform = new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                if (line === '') {
                    controller.enqueue(encoder.encode('\n'));
                    continue;
                }
                if (!line.startsWith('data:')) {
                    // 保留 event: 等行（`event: error` 对诊断有价值）
                    controller.enqueue(encoder.encode(`${line}\n`));
                    continue;
                }
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') {
                    controller.enqueue(encoder.encode('data: [DONE]\n'));
                    continue;
                }
                const inner = innerTextOf(payload);
                if (inner === null) {
                    // 不是信封 → 原样透传（容错：万一服务端某天直接回标准帧）
                    controller.enqueue(encoder.encode(`data: ${payload}\n`));
                    continue;
                }
                // 业务错误：内层是错误 JSON 而非 choices → 转成标准 error 帧，
                // 由 consumeOpenAiSse 统一抛错（保持单一错误出口）。
                if (!inner.includes('"choices"') && !inner.includes('[DONE]')) {
                    let code = '';
                    let message = inner;
                    try {
                        const parsed = JSON.parse(inner);
                        if (typeof parsed.code === 'string')
                            code = parsed.code;
                        if (typeof parsed.message === 'string')
                            message = parsed.message;
                    }
                    catch { /* 保持原文 */ }
                    const detail = code ? ` (${code})` : '';
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `${message}${detail}` } })}\n`));
                    continue;
                }
                controller.enqueue(encoder.encode(`data: ${inner}\n`));
            }
        },
        flush(controller) {
            const rest = buffer.trim();
            if (rest.length > 0) {
                const inner = rest.startsWith('data:') ? innerTextOf(rest.slice(5).trim()) : null;
                if (inner !== null)
                    controller.enqueue(encoder.encode(`data: ${inner}\n`));
            }
        },
    });
    return new Response(upstream.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}
//# sourceMappingURL=qoder-envelope.js.map