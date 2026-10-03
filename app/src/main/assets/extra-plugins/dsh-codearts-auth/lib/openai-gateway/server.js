import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateApiKey } from './auth.js';
import { resolveGatewayConfig } from './config.js';
import { toGenerateOptions, OpenAiGatewayError, parseModelRoute, normalizeReasoningEffort, normalizeMaxTokens } from './messages.js';
import { collectGatewayModelIds, collectGatewayModels, toOpenAiModels } from './models.js';
import { findCaseInsensitiveSuggestion, looksLikeMissingModel } from './model-errors.js';
import { collectOpenAiCompletion, failureToOpenAiError, toOpenAiSse } from './stream.js';
const BODY_LIMIT = 16 * 1024 * 1024;
const defaultLogger = {
    info: (message) => console.info(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
};
function jsonResponse(response, status, value) {
    if (response.headersSent)
        return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
    });
    response.end(body);
}
function readJson(request, signal) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const abort = () => reject(new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted'));
        signal.addEventListener('abort', abort, { once: true });
        request.on('data', (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += data.length;
            if (size > BODY_LIMIT) {
                reject(new OpenAiGatewayError('request body is too large', 413, 'invalid_request_error', 'request_too_large'));
                request.destroy();
                return;
            }
            chunks.push(data);
        });
        request.on('error', reject);
        request.on('end', () => {
            signal.removeEventListener('abort', abort);
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error('body must be an object');
                resolve(value);
            }
            catch {
                reject(new OpenAiGatewayError('request body must be valid JSON'));
            }
        });
    });
}
function authorized(request, key) {
    const value = request.headers.authorization;
    return typeof value === 'string' && value === `Bearer ${key}`;
}
function getHome(options) {
    return options.home ?? options.env?.DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
export function createOpenAiGateway(options) {
    const env = options.env ?? process.env;
    const config = resolveGatewayConfig(env);
    // 密钥在**创建时**解析（而不是 start 时）：设置页要能在网关未运行时也能
    // 读到它，用户才能配置外部客户端。
    const apiKey = loadOrCreateApiKey(getHome(options), env);
    const key = apiKey.value;
    const logger = options.logger ?? defaultLogger;
    let server;
    let boundPort = config.port;
    const active = new Set();
    const describe = (error) => (error instanceof Error ? error.message : String(error));
    const handleModels = async (response) => {
        // 逐个 catch 的容错在 collectGatewayModels 里（设置页的 RPC 复用同一份，
        // 两处各写一遍必然漂移）。
        const groups = await collectGatewayModels(options.llm, (provider, error) => {
            logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/models 跳过：${describe(error)}`);
        });
        jsonResponse(response, 200, { object: 'list', data: toOpenAiModels(groups) });
    };
    /**
     * 解析模型元信息。失败按「模型不可解析」回 404，而不是笼统的 502 ——
     * OpenAI 客户端据此区分「换个模型名重试」与「上游故障」，前者不该被当作可重试错误。
     */
    const resolveModelInfo = async (route, signal) => {
        try {
            return await options.llm.resolveModelInfo(route.provider, route.model, signal);
        }
        catch (error) {
            // 取消导致的抛错不是「模型不存在」，不能被改写成 404。
            if (signal.aborted)
                throw new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted');
            throw new OpenAiGatewayError(`model ${route.provider}/${route.model} could not be resolved: ${describe(error)}`, 404, 'invalid_request_error', 'model_not_found');
        }
    };
    /**
     * 失败时给出「你是不是想用 X」的建议。
     *
     * ⚠️ **目录只在出错时才去查**（正常请求零额外开销），且用的是与
     * `/v1/models` 完全相同的采集器 —— 建议里给出的 ID 必须真能被网关接受，
     * 两处各查一遍必然漂移，而漂移的症状是「按提示改了还是不行」。
     */
    const makeSuggestion = (requestedId) => async (message) => {
        if (!looksLikeMissingModel(message))
            return undefined;
        const catalog = await loadModelIdsHint();
        const found = findCaseInsensitiveSuggestion(requestedId, catalog);
        return found === undefined ? undefined : `你是不是想用 ${found}`;
    };
    /**
     * 纠错建议用的模型 ID 清单。
     *
     * 惰性 + 只取一次：出错是少数情况，正常路径连这个数组都不会构造。
     * 取失败（某个 provider 未登录）时退化为空清单 —— 拿不到建议只是少一句
     * 提示，绝不能因此把真正的错误盖掉。
     */
    let hintLoaded = false;
    let modelIdsHint = [];
    const loadModelIdsHint = async () => {
        if (!hintLoaded) {
            hintLoaded = true;
            try {
                modelIdsHint = (await collectGatewayModelIds(options.llm)).map((model) => model.id);
            }
            catch {
                modelIdsHint = [];
            }
        }
        return modelIdsHint;
    };
    const handleChat = async (request, response) => {
        const controller = new AbortController();
        active.add(controller);
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', () => {
            if (!response.writableEnded)
                controller.abort();
        });
        try {
            const body = await readJson(request, controller.signal);
            const route = parseModelRoute(body.model);
            const modelInfo = await resolveModelInfo(route, controller.signal);
            const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort, modelInfo, route.provider, route.model);
            const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens;
            const maxTokens = typeof requestedMaxTokens === 'number'
                ? normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
                : undefined;
            const generate = await toGenerateOptions(body, controller.signal, reasoningEffort, maxTokens, {
                bridge: options.attachments,
                limits: options.imageLimits,
            });
            const stream = options.llm.stream(generate);
            const fullId = `${route.provider}/${route.model}`;
            if (body.stream === true) {
                response.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-transform',
                    connection: 'keep-alive',
                    'access-control-allow-origin': '*',
                });
                for await (const event of toOpenAiSse(stream, undefined, fullId, makeSuggestion(fullId))) {
                    if (controller.signal.aborted || response.destroyed)
                        break;
                    response.write(event);
                }
                if (!response.writableEnded)
                    response.end();
            }
            else {
                const result = await collectOpenAiCompletion(stream, undefined, fullId, makeSuggestion(fullId));
                jsonResponse(response, 200, result);
            }
        }
        catch (error) {
            if (!response.headersSent && !response.destroyed) {
                const converted = failureToOpenAiError(error);
                jsonResponse(response, converted.status, converted.body);
            }
        }
        finally {
            request.removeListener('aborted', abort);
            active.delete(controller);
        }
    };
    const requestHandler = (request, response) => {
        if (request.method === 'OPTIONS') {
            response.writeHead(204, {
                'access-control-allow-origin': '*',
                'access-control-allow-headers': 'Authorization, Content-Type',
                'access-control-allow-methods': 'GET, POST, OPTIONS',
            });
            response.end();
            return;
        }
        if (!authorized(request, key)) {
            jsonResponse(response, 401, { error: { message: 'Missing or invalid API key', type: 'authentication_error', code: 'invalid_api_key' } });
            return;
        }
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (path === '/v1/models' && request.method === 'GET') {
            void handleModels(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }));
            return;
        }
        if (path === '/v1/chat/completions' && request.method === 'POST') {
            if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
                jsonResponse(response, 415, { error: { message: 'Content-Type must be application/json', type: 'invalid_request_error', code: 'invalid_content_type' } });
                return;
            }
            void handleChat(request, response);
            return;
        }
        jsonResponse(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
    };
    return {
        async start() {
            if (server !== undefined)
                return;
            const current = createServer(requestHandler);
            server = current;
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    current.off('listening', onListening);
                    server = undefined;
                    reject(error);
                };
                const onListening = () => {
                    current.off('error', onError);
                    const address = current.address();
                    boundPort = typeof address === 'object' && address !== null ? address.port : config.port;
                    resolve();
                };
                current.once('error', onError);
                current.once('listening', onListening);
                current.listen(config.port, config.host);
            }).catch((error) => {
                logger.error(`[openai-gateway] 启动失败 ${config.host}:${config.port}：${error instanceof Error ? error.message : String(error)}`);
                throw error;
            });
            logger.info(`[openai-gateway] 已监听 http://${config.host}:${boundPort}/v1`);
        },
        async close() {
            for (const controller of active)
                controller.abort();
            if (server === undefined)
                return;
            const current = server;
            server = undefined;
            await new Promise((resolve) => current.close(() => resolve()));
            logger.info('[openai-gateway] 已关闭');
        },
        address() {
            return { host: config.host, port: boundPort };
        },
        apiKey,
    };
}
//# sourceMappingURL=server.js.map