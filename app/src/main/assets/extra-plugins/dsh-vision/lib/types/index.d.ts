/**
 * dsh-vision: eyes for a text-only model. Registers a `view_image` tool that
 * answers the model's (or the user's) question about an image, plus a
 * "Vision" settings page in the web GUI.
 *
 * Two backends, one tool:
 *   - provider: reuses the DSH provider configuration (Settings → Models):
 *     the request goes through ctx.llm → the configured provider route and
 *     model, so apiKey/baseURL/credentials/routing all inherit from the host.
 *   - custom: the original direct OpenAI-compatible endpoint call with its
 *     own baseURL/apiKey/fallback chain (default: Zhipu's FREE glm-4.6v-flash,
 *     zero-config out of the box, backward compatible).
 *
 * Config lives in the `vision` settings namespace (~/.dsh/settings.yaml),
 * editable from 设置 → Vision; the loader entry config stays as the base
 * layer for old config.yaml users.
 * @module dsh-vision
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type Llm from '@deepseek-ai/dsh-llm';
import type AttachmentStore from '@deepseek-ai/dsh-attachment';
import z from '@deepseek-ai/schemastery';
import { type VisionConfig } from './backend.js';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    llm: Llm;
    attachments: AttachmentStore;
};
export declare const name = "dsh-vision";
export declare const inject: string[];
export interface Config {
    backend?: 'provider' | 'custom';
    provider?: string;
    model?: string;
    baseURL?: string;
    apiKey?: string;
    fallbackModels?: string[];
    maxTokens?: number;
    timeoutMs?: number;
    maxImageBytes?: number;
}
export declare const Config: z<Config>;
/** Fold the raw (defaulted) config into the effective shape the runner needs. */
export declare function toVisionConfig(config: Config): VisionConfig;
export declare function apply(ctx: Context, config: Config): void;
export {};
