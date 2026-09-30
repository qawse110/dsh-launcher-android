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
import { defineTool } from '@deepseek-ai/dsh-tools';
// ── dsh-launcher 适配（dsh 0.1.7-rc.2）────────────────────────────────
// 上游从 '@deepseek-ai/dsh-settings' 具名导入 settingsNamespace，但该符号在
// 0.1.7-rc.2 的导出面里**已不存在**（实测导出仅
// SettingsConflictError / SettingsForms / SettingsForms as default / redactSecrets）。
// 具名导入在 ESM 链接期即抛「does not provide an export named …」，try/catch 兜不住。
//
// 该符号的原实现只是**校验后原值返回**（/^[a-z][a-z0-9-]*$/），
// 既然本插件源码现在随 APK 分发（不再是 prebuilt.tgz 黑盒），就地内联最干净：
// 不依赖启动期改写源码，也不受 stub-dsh.mjs 那个「只扫入口文件」的覆盖边界影响。
function settingsNamespace(value) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError('settings namespace "' + value + '" must match /^[a-z][a-z0-9-]*$/');
  }
  return value;
}
import z from '@deepseek-ai/schemastery';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, runVision, } from './backend.js';
export const name = 'dsh-vision';
export const inject = ['tools', 'systemPrompt', 'llm', 'attachments'];
export const Config = z.object({
    backend: z.union([z.const('provider'), z.const('custom')]).default('custom')
        .description('provider 复用 DSH 提供商配置（Settings → Models 中的密钥/端点）；custom 使用下面的自定义端点'),
    provider: z.string().default('')
        .description('provider 模式下使用的 DSH provider 路由（在 Settings → Models 里配置）'),
    model: z.string().default(DEFAULT_MODEL)
        .description('Vision model id：provider 模式下为 DSH 模型 id（需支持 image 输入）；custom 模式下为端点上的模型 id，如 glm-4.6v-flash (free) / qwen3-vl-flash / qwen3-vl:4b'),
    baseURL: z.string().default(DEFAULT_BASE_URL)
        .description('custom 模式：OpenAI 兼容端点 base URL（自动追加 /chat/completions）'),
    apiKey: z.string().role('secret').default('')
        .description('custom 模式 API key；也回退 $VISION_API_KEY / $DSH_VISION_API_KEY / $ZHIPUAI_API_KEY / $DASHSCOPE_API_KEY'),
    fallbackModels: z.array(z.string()).default([])
        .description('custom 模式：主模型 429/404/5xx 时依次尝试的模型；默认端点默认走智谱免费链'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(DEFAULT_MAX_TOKENS),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(DEFAULT_TIMEOUT_MS),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
});
const PROMPT_TEXT = `## Vision (view_image)
The chat model itself cannot see images, but the view_image tool can. Whenever an image matters — a screenshot path the user mentions, an image URL, a chart, a UI mockup — call view_image instead of guessing or refusing. Ask it a specific question (extract text, count objects, read a chart, describe the layout); it answers arbitrary questions, not just captions. Prefer one focused call per thing you need to know; ask a follow-up call rather than one vague question.`;
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
};
/** Fold the raw (defaulted) config into the effective shape the runner needs. */
export function toVisionConfig(config) {
    return {
        backend: config.backend ?? 'custom',
        provider: config.provider ?? '',
        model: config.model ?? DEFAULT_MODEL,
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        apiKey: config.apiKey ?? '',
        fallbackModels: config.fallbackModels ?? [],
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    };
}
const DEFAULT_QUESTION = 'Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.';
/** Bundled sample image used by the settings-page 测试 button when no custom source is given. */
const SAMPLE_IMAGE = fileURLToPath(new URL('../assets/demo-input.jpeg', import.meta.url));
/** One-shot host diagnostic sink (read after a rebuild + restart to confirm settings registration). */
const DIAG_LOG = `${process.env.DSH_HOME ?? '.'}/dsh-vision-diag.log`;
const diag = (message) => {
    try {
        appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // diagnostics must never break the plugin
    }
};
/**
 * Register the `vision` settings namespace directly (mirroring the canonical
 * installSettingsSection wiring) with a host diagnostic log. A loader-entry
 * plugin reaches the settings service through an optional injection exactly
 * like bundle plugins, so this also proves whether the service is visible.
 */
function installVisionSettings(ctx, config, holder) {
    const FIBER_DISPOSED = 4;
    const FIBER_UNLOADING = 5;
    const isUnloading = () => {
        const state = ctx.fiber?.state;
        return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
    };
    const validate = (value) => {
        if (value.backend === 'provider') {
            if ((value.provider ?? '') === '') {
                throw new Error('backend 为 provider 但未选择 provider 路由：请在设置页选择一个 DSH 提供商（在 Settings → Models 中配置）');
            }
            if ((value.model ?? '') === '') {
                throw new Error('backend 为 provider 但未设置模型 id：请选择支持 image 输入的模型');
            }
        }
    };
    let settingsNow = 'unknown';
    try {
        const settings = ctx.get('settings');
        settingsNow = settings === undefined ? 'undefined' : typeof settings;
    }
    catch (error) {
        settingsNow = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    diag(`apply: ctx.get('settings') -> ${settingsNow}`);
    ctx.inject(['settings'], (sctxArg) => {
        diag('settings inject callback RAN');
        const sctx = sctxArg;
        try {
            const scope = sctx.settings.register(settingsNamespace('vision'), Config, { base: config, validate });
            const refresh = () => {
                holder.config = toVisionConfig(scope.get());
            };
            refresh();
            diag(`settings register OK: ${JSON.stringify(holder.config)}`);
            sctx.effect(() => () => {
                if (isUnloading())
                    return;
                holder.config = toVisionConfig(config);
            });
            scope.watch(() => {
                if (isUnloading())
                    return;
                refresh();
            });
        }
        catch (error) {
            diag(`settings register FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        }
    });
}
export function apply(ctx, config) {
    // Live config holder: the settings service (installed below) replaces this
    // with the resolved value every time the user saves the Vision page.
    const holder = { config: toVisionConfig(config) };
    installVisionSettings(ctx, config, holder);
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'view_image',
        description: 'Look at an image and answer a question about it (OCR, counting, chart reading, layout, arbitrary visual questions). Accepts an absolute local file path, an http(s) URL, or a data: URL.',
        parameters: {
            source: {
                type: 'string',
                required: true,
                description: 'The image: absolute local file path, http(s) URL, or data: URL',
            },
            question: {
                type: 'string',
                description: 'What to find out about the image. Be specific. Default: a thorough general description including any visible text.',
            },
        },
        output: TEXT_OUTPUT,
        timeoutMs: holder.config.timeoutMs,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const source = typeof input.source === 'string' ? input.source : '';
            if (source === '')
                throw new Error('view_image: source is required');
            const question = typeof input.question === 'string' && input.question !== ''
                ? input.question
                : DEFAULT_QUESTION;
            return runVision(ctx, holder.config, { source, question, signal: exec.signal });
        },
    })), 'dsh-vision.tool');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-vision',
        order: 116,
        text: PROMPT_TEXT,
    }), 'dsh-vision.prompt');
    // 设置页「测试」按钮的宿主侧执行端点。webServer 在 Web 组合中存在、
    // CLI 组合中不存在：用 ctx.inject 的可选语义 — 服务永不出现时回调不运行。
    ctx.inject(['webServer'], (web) => {
        web.webServer.register({
            kind: 'exact',
            path: '/dsh-vision/test',
            handler: async (req, res) => {
                res.setHeader('content-type', 'application/json; charset=utf-8');
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end(JSON.stringify({ ok: false, error: `method ${req.method} not allowed, use POST` }));
                    return;
                }
                let body = '';
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 1_000_000) {
                        res.writeHead(413);
                        res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
                        return;
                    }
                    body += chunk;
                }
                let payload = {};
                try {
                    payload = body === '' ? {} : JSON.parse(body);
                }
                catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
                    return;
                }
                const str = (value) => typeof value === 'string' && value !== '' ? value : undefined;
                const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
                let probe;
                try {
                    probe = {
                        backend: payload.backend === 'provider' ? 'provider' : 'custom',
                        provider: str(payload.provider) ?? holder.config.provider,
                        model: str(payload.model) ?? holder.config.model,
                        baseURL: str(payload.baseURL) ?? holder.config.baseURL,
                        apiKey: str(payload.apiKey) ?? holder.config.apiKey,
                        fallbackModels: Array.isArray(payload.fallbackModels)
                            ? payload.fallbackModels.filter((m) => typeof m === 'string')
                            : holder.config.fallbackModels,
                        maxTokens: num(payload.maxTokens) ?? holder.config.maxTokens,
                        timeoutMs: num(payload.timeoutMs) ?? holder.config.timeoutMs,
                        maxImageBytes: num(payload.maxImageBytes) ?? holder.config.maxImageBytes,
                    };
                }
                catch (error) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false, error: `bad payload: ${error instanceof Error ? error.message : String(error)}` }));
                    return;
                }
                const source = str(payload.source) ?? SAMPLE_IMAGE;
                const question = str(payload.question) ?? 'What is in this image? Describe it briefly.';
                try {
                    const text = await runVision(ctx, probe, {
                        source,
                        question,
                        signal: AbortSignal.timeout(probe.timeoutMs),
                    });
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, text }));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const redacted = probe.apiKey === '' ? message : message.replaceAll(probe.apiKey, '***');
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: false, error: redacted }));
                }
            },
        });
    });
}
