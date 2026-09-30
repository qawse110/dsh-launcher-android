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
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type Llm from '@deepseek-ai/dsh-llm';
import type AttachmentStore from '@deepseek-ai/dsh-attachment';
/** Effective (defaulted) vision configuration consumed by the runner. */
export interface VisionConfig {
    backend: 'provider' | 'custom';
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    fallbackModels: string[];
    maxTokens: number;
    timeoutMs: number;
    maxImageBytes: number;
}
/** One vision question about one image source. */
export interface VisionCall {
    source: string;
    question: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
}
export type VisionContext = CordisContext & {
    llm: Llm;
    attachments: AttachmentStore;
};
export declare const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export declare const DEFAULT_MODEL = "glm-4.6v-flash";
export declare const DEFAULT_MAX_TOKENS = 2048;
export declare const DEFAULT_TIMEOUT_MS = 60000;
export declare const DEFAULT_MAX_IMAGE_BYTES: number;
/** Zhipu's free tier gets congested (HTTP 429 code 1305); older free models still answer. */
export declare const DEFAULT_FREE_FALLBACKS: string[];
/** Fallback chain for custom mode: configured list, or the default free chain on the default Zhipu endpoint. */
export declare function fallbackModelsFor(config: VisionConfig): string[];
/**
 * Custom mode key resolution, per call (never at mount): the plugin loads
 * fine without one and the error explains exactly where to put it.
 * Local endpoints need none.
 */
export declare function resolveApiKey(config: VisionConfig): string;
/** Run one vision question through the configured backend. */
export declare function runVision(ctx: VisionContext, config: VisionConfig, call: VisionCall): Promise<string>;
