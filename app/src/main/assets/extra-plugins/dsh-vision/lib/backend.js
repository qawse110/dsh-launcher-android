/**
 * Shared vision backend. Two modes, one runner:
 *
 *   provider — reuses the DSH provider configuration (Settings → Models):
 *     the call goes through `ctx.llm` (dsh-llm) with the DSH-configured
 *     provider route + model, so apiKey, baseURL, routing, retry, and
 *     credentials all inherit from the host. The image is handed to the
 *     model through `ctx.attachments` as a saved attachment.
 *   custom — the original direct OpenAI-compatible endpoint call (./vlm.ts),
 *     fully self-contained (own baseURL/apiKey/fallback chain).
 * @module dsh-vision/backend
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { visionChat, resolveImageData } from './vlm.js';
export const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const DEFAULT_MODEL = 'glm-4.6v-flash';
export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Zhipu's free tier gets congested (HTTP 429 code 1305); older free models still answer. */
export const DEFAULT_FREE_FALLBACKS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];
/** Errors worth trying the next model for: rate limit, missing model, server trouble. */
const RETRIABLE = /returned (?:429|404|5\d\d)/;
const isLocal = (baseURL) => /^https?:\/\/(localhost|127\.0\.0\.1|(\[::1\]))(:|\/|$)/.test(baseURL);
/** Fallback chain for custom mode: configured list, or the default free chain on the default Zhipu endpoint. */
export function fallbackModelsFor(config) {
    if (config.fallbackModels.length > 0)
        return config.fallbackModels;
    if (config.baseURL === DEFAULT_BASE_URL && config.model === DEFAULT_MODEL)
        return DEFAULT_FREE_FALLBACKS;
    return [];
}
/**
 * Custom mode key resolution, per call (never at mount): the plugin loads
 * fine without one and the error explains exactly where to put it.
 * Local endpoints need none.
 */
export function resolveApiKey(config) {
    const key = config.apiKey !== '' ? config.apiKey
        : process.env.VISION_API_KEY ?? process.env.DSH_VISION_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (key === '' && !isLocal(config.baseURL)) {
        throw new Error('view_image: no API key. Set the dsh-vision apiKey config (Settings → Vision), or set VISION_API_KEY (in ~/.dsh/.env or exported; also honored: ZHIPUAI_API_KEY, DASHSCOPE_API_KEY). The default model glm-4.6v-flash is FREE — create a key in 1 minute at https://open.bigmodel.cn. Offline alternative: baseURL http://localhost:11434/v1 + an Ollama vision model, no key needed.');
    }
    return key;
}
async function customVision(config, call) {
    const apiKey = resolveApiKey(config);
    let lastError;
    for (const model of [config.model, ...fallbackModelsFor(config)]) {
        try {
            return await visionChat({
                baseURL: config.baseURL,
                apiKey,
                model,
                maxTokens: config.maxTokens,
                timeoutMs: config.timeoutMs,
                maxImageBytes: config.maxImageBytes,
                source: call.source,
                question: call.question,
                signal: call.signal,
                fetch: call.fetch,
            });
        }
        catch (error) {
            lastError = error;
            if (!(error instanceof Error) || !RETRIABLE.test(error.message))
                throw error;
        }
    }
    throw lastError;
}
/** Media types the provider (attachment) path supports; others must use the custom backend. */
const PROVIDER_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
async function providerVision(ctx, config, call) {
    if (config.provider === '') {
        throw new Error(`view_image: backend is "provider" but no provider route is set. Pick one in Settings → Vision (it uses the DSH provider credentials/config from Settings → Models).`);
    }
    if (config.model === '') {
        throw new Error(`view_image: backend is "provider" but no model is set. Pick a vision-capable model in Settings → Vision.`);
    }
    const { data, mediaType } = await resolveImageData(call.source, config.maxImageBytes, call.fetch);
    if (!PROVIDER_MEDIA_TYPES.has(mediaType)) {
        throw new Error(`view_image: the DSH provider backend accepts png/jpeg/webp/gif only (got ${mediaType}). For bmp/tif/heic use the custom backend (Settings → Vision → 自定义端点).`);
    }
    const attachment = await ctx.attachments.saveImage({ data, mediaType: mediaType, name: 'view_image' });
    const prepared = await ctx.llm.prepareCall({
        provider: config.provider,
        model: config.model,
        maxTokens: config.maxTokens,
    }, call.signal);
    const message = createUserMessage({
        content: [
            { type: 'image', attachment },
            { type: 'text', text: call.question },
        ],
        source: { kind: 'user' },
    });
    const assembler = new BlockAssembler();
    try {
        for await (const chunk of prepared.stream({
            provider: config.provider,
            model: config.model,
            maxTokens: config.maxTokens,
            messages: [message],
            signal: call.signal,
        })) {
            assembler.push(chunk);
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`view_image: provider call failed: ${reason}`);
    }
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(`view_image: provider call failed: ${finish.failure.message}`);
    }
    const text = assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
    if (text === '') {
        throw new Error(`view_image: provider returned no text (finish: ${finish.kind}). The model may not accept images, or the answer was empty — check the model's input modalities (Settings → Models) and try again.`);
    }
    return text;
}
/** Run one vision question through the configured backend. */
export async function runVision(ctx, config, call) {
    if (config.backend === 'provider')
        return providerVision(ctx, config, call);
    return customVision(config, call);
}
