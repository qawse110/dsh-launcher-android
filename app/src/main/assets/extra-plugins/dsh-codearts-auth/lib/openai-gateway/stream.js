import { randomUUID } from 'node:crypto';
import { OpenAiGatewayError } from './messages.js';
import { normalizeUpstreamFailure } from './model-errors.js';
/** 把「你可能是想用 X」拼到错误消息后面。 */
async function withSuggestion(message, suggest) {
    if (suggest === undefined)
        return message;
    try {
        const hint = await suggest(message);
        return typeof hint === 'string' && hint.length > 0 ? `${message}（${hint}）` : message;
    }
    catch {
        // 建议只是锦上添花，取目录失败绝不能盖掉真正的错误消息。
        return message;
    }
}
function finishReason(reason) {
    switch (reason.kind) {
        case 'stop': return 'stop';
        case 'tool-calls': return 'tool_calls';
        case 'max-tokens': return 'length';
        case 'aborted': return 'error';
        case 'error': return 'error';
    }
}
function usageJson(usage) {
    return {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
        ...usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens },
        ...usage.cacheReadTokens === undefined ? {} : { prompt_cache_hit_tokens: usage.cacheReadTokens },
    };
}
function line(value) {
    return `data: ${JSON.stringify(value)}\n\n`;
}
function baseChunk(id, model, delta, finish) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    };
}
function failureMessage(reason) {
    return reason.failure.message || `DSH model request ${reason.kind}`;
}
function consumeChunk(state, chunk) {
    switch (chunk.type) {
        case 'text-delta':
            state.content += chunk.text;
            return { delta: { content: chunk.text } };
        case 'reasoning-delta':
            state.reasoning += chunk.text;
            return { delta: { reasoning_content: chunk.text } };
        case 'tool-call-delta': {
            let tool = state.tools.get(chunk.index);
            if (!tool) {
                tool = { id: String(chunk.id), arguments: '' };
                state.tools.set(chunk.index, tool);
            }
            tool.id = String(chunk.id || tool.id);
            if (chunk.name !== undefined)
                tool.name = chunk.name;
            tool.arguments += chunk.argumentsDelta;
            return {
                delta: {
                    tool_calls: [{
                            index: chunk.index,
                            id: tool.id,
                            type: 'function',
                            function: {
                                ...tool.name === undefined ? {} : { name: tool.name },
                                arguments: chunk.argumentsDelta,
                            },
                        }],
                },
            };
        }
        case 'usage':
            state.usage = chunk.usage;
            return undefined;
        case 'finish':
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                return { error: { message: failureMessage(chunk.reason), type: 'server_error', code: chunk.reason.failure.code } };
            }
            state.finishReason = finishReason(chunk.reason);
            return { delta: {}, finish_reason: state.finishReason };
        case 'block-start':
        case 'block-end':
            return undefined;
    }
}
export async function* toOpenAiSse(chunks, requestId = `chatcmpl-${randomUUID()}`, model, suggest) {
    const state = { content: '', reasoning: '', tools: new Map() };
    try {
        for await (const chunk of chunks) {
            const event = consumeChunk(state, chunk);
            if (event === undefined)
                continue;
            if ('error' in event) {
                const error = event.error;
                const message = typeof error.message === 'string' ? error.message : 'upstream error';
                // 上游「模型不存在」以 502 离开网关时会被客户端当成可重试故障重试，
                // 但它是确定性失败 —— 翻成 404 让客户端提示用户改配置。
                const normalized = normalizeUpstreamFailure({
                    status: 502,
                    type: typeof error.type === 'string' ? error.type : 'server_error',
                    code: typeof error.code === 'string' ? error.code : 'upstream_error',
                    message,
                });
                yield line({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    model,
                    choices: [],
                    error: {
                        message: await withSuggestion(message, suggest),
                        type: normalized.type,
                        code: normalized.code,
                        // 流已发出 200，状态码改不了；把该有的 404 放进 status 字段供客户端读。
                        status: normalized.status,
                    },
                });
                yield 'data: [DONE]\n\n';
                return;
            }
            if ('finish_reason' in event) {
                yield line({ ...baseChunk(requestId, model, event.delta, event.finish_reason) });
            }
            else {
                yield line(baseChunk(requestId, model, event.delta));
            }
        }
        if (state.finishReason === undefined) {
            yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: { message: 'upstream stream ended before finish', type: 'server_error', code: 'incomplete_stream' } });
            yield 'data: [DONE]\n\n';
            return;
        }
        if (state.usage !== undefined) {
            yield line({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageJson(state.usage) });
        }
        yield 'data: [DONE]\n\n';
    }
    catch (error) {
        const converted = failureToOpenAiError(error);
        yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: converted.body.error });
        yield 'data: [DONE]\n\n';
    }
}
export async function collectOpenAiCompletion(chunks, requestId = `chatcmpl-${randomUUID()}`, model, suggest) {
    const state = { content: '', reasoning: '', tools: new Map() };
    try {
        for await (const chunk of chunks) {
            const event = consumeChunk(state, chunk);
            if (event?.error) {
                throw new OpenAiGatewayError(String(event.error.message), 502, 'server_error', String(event.error.code ?? 'upstream_error'));
            }
        }
        if (state.finishReason === undefined) {
            throw new OpenAiGatewayError('upstream stream ended before finish', 502, 'server_error', 'incomplete_stream');
        }
    }
    catch (error) {
        const converted = failureToOpenAiError(error);
        const message = String(converted.body.error.message);
        // 同 toOpenAiSse：把上游「模型不存在」翻成 404，避免客户端把它当可重试故障。
        const normalized = normalizeUpstreamFailure({
            status: converted.status,
            type: String(converted.body.error.type),
            code: String(converted.body.error.code ?? 'upstream_error'),
            message,
        });
        throw new OpenAiGatewayError(await withSuggestion(message, suggest), normalized.status, normalized.type, normalized.code);
    }
    const toolCalls = [...state.tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => ({
        id: tool.id,
        type: 'function',
        function: { name: tool.name ?? '', arguments: tool.arguments },
    }));
    const message = {
        role: 'assistant',
        content: state.content || null,
        ...state.reasoning.length === 0 ? {} : { reasoning_content: state.reasoning },
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
    };
    return {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: state.finishReason }],
        ...state.usage === undefined ? {} : { usage: usageJson(state.usage) },
    };
}
export function failureToOpenAiError(error) {
    if (error instanceof OpenAiGatewayError) {
        return { status: error.status, body: { error: { message: error.message, type: error.type, code: error.code } } };
    }
    const value = error;
    const status = typeof value?.status === 'number' && value.status >= 400 && value.status <= 599 ? value.status : 502;
    return {
        status,
        body: { error: {
                message: typeof value?.message === 'string' ? value.message : 'DSH model request failed',
                type: 'server_error',
                code: typeof value?.code === 'string' ? value.code : 'upstream_error',
            } },
    };
}
//# sourceMappingURL=stream.js.map