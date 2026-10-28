/**
 * `analyzeImage` —— 让**纯文本模型**也能"看图"的工具（2026-10-21）。
 *
 * ## 为什么需要它（用户诉求）
 *
 * CodeArts 的模型分两类（`/v1/model/builtin` 的 `supports_images` 实测）：
 * `kimi-k2.6-vl` / `Qwen3-VL-235B` 能收图，而 `glm-5.3` / `GLM-5.2` /
 * `openpangu-*` / `deepseek-v4.1-flash` **收不了**（上游原文
 * `InferHub.001001020.406 The request model is not multimodal`）。
 *
 * 用户明确要求：「继续做到 codearts 的只有文本的模型可以通过这个工具识图」，
 * 且「不需要直接选择 VL 模型（IDE 也不能选择）」。
 *
 * ## 与 IDE 同构的两段式
 *
 * 本机 IDE 内核日志实测：
 *
 * ```
 * [fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
 *                          candidates: kimi-k2.6-vl, Qwen3-VL-235B   ← 11 次采样恒定
 * ```
 *
 * 即 IDE 也是「挑一个 VL 模型去服务 `analyzeImage` 工具」，主模型（文本）只读文字结果。
 * 本模块复刻这条路：主模型调工具 → 我们拿图片字节 → 发给 `kimi-k2.6-vl` → 返回文字。
 *
 * ## ⚠️⚠️ 最关键的约束：图片字节**不能**从 `options.messages` 里拿
 *
 * 纯文本模型发请求时，DSH 会在 **dispatch 之前**把图换成占位文字
 *（`dsh-llm/lib/index.js:2337` 的 `projectImagesForTextModel` →
 * `[image omitted because this model accepts text only; attachment sha256:…]`）。
 * ⇒ 适配器 `stream()` 里看到的已经是**文字**，图片字节早就不在了。
 *
 * 故本工具必须**自己去会话历史里取**：`session.deriveMessages()` 返回的是
 * **未投影**的派生历史（`dsh-session/lib/types/index.d.ts:344`），
 * `image` 块上的 `attachment` 引用完整保留，再经 `ctx.attachments.readImage()`
 * 读字节。
 *
 * ## 工具只在「当前路由是 codearts 且该模型收不了图」时才该存在
 *
 * 否则会给别家 provider 塞一个用不了的工具（它们的图片本来就直发上游）。
 * 判据见 {@link shouldOfferAnalyzeImage}。
 *
 * @module
 */
import { codeartsVisionModel } from './llm-adapter.js';
// ⚠️ 工具名与「该不该给这个路由」的判据**唯一定义在叶子模块** `codearts-vision.ts`：
//    注册期包装（`llm-register-compat.ts` 逐请求从非 codearts 路由的工具表里摘掉
//    本工具）要用同一份判据，而它不能 import 本文件/`llm-adapter.ts`（会成环）。
//    此处只做转出，既有导入路径（`from './analyze-image.js'`）保持不变。
import { ANALYZE_IMAGE_TOOL, shouldOfferAnalyzeImage, } from './codearts-vision.js';
export { ANALYZE_IMAGE_TOOL, shouldOfferAnalyzeImage };
/** 单次调用最多分析几张图（防止模型一次塞几十张把上游打爆）。 */
export const ANALYZE_IMAGE_MAX_IMAGES = 8;
/**
 * 发给 VL 模型的提示词。
 *
 * ⚠️ **必须要求「只描述看到的内容、不猜测」**：实测 VL 模型在图片被降采样或
 * 内容模糊时会**编造**细节（本仓 accio 那家记过 GLM 5.1 幻觉的同类事）。
 * 明确要求「看不清就说看不清」是唯一可靠的抑制手段。
 */
const ANALYZE_PROMPT = [
    '请详细描述这张图片的内容，包括：',
    '1. 整体画面与布局；',
    '2. 其中的文字（逐字转录，看不清的用「?」标注，不要猜测）；',
    '3. 关键对象、颜色、位置关系；',
    '4. 如果这是界面截图，说明它是什么软件/页面、有哪些可交互元素。',
    '只描述你实际看到的内容；看不清就直说看不清，不要编造。',
].join('\n');
/** `defineTool` 的替身：本插件只产出宿主能接受的字面量，不引入该包。 */
function defineToolLiteral(spec) {
    return spec;
}
/**
 * 从会话派生历史里收集**当前这一轮**的图片引用。
 *
 * ⚠️ 只取**最后一条 user 消息**里的图：用户问「这张图是什么」时，指的是他刚发的那张。
 * 取全部历史会把之前对话里的图也一起送去分析（既慢又费额度，还会让模型答错图）。
 *
 * ⚠️ **不处理 `offloaded` 块**：那是 DSH 为省 token 做的图片卸载，字节可能已不在
 * 本地。这类块直接跳过 —— 让模型收到「有几张图但我拿不到」比送一张空图更诚实。
 *
 * @param messages - `session.deriveMessages()` 的结果
 * @returns 图片引用列表（可能为空）
 */
export function collectTurnImages(messages) {
    // 从后往前找最后一条**带图**的 user 消息。
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user')
            continue;
        const images = [];
        for (const raw of message.content) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const block = raw;
            if (block.type !== 'image')
                continue;
            if (block.offloaded === true)
                continue;
            const id = block.attachment?.attachmentId;
            const mediaType = block.attachment?.mediaType;
            if (typeof id !== 'string' || id.length === 0)
                continue;
            images.push({
                attachmentId: id,
                mediaType: typeof mediaType === 'string' && mediaType.length > 0 ? mediaType : 'image/png',
            });
        }
        // ⚠️ 一旦找到**最近一条 user 消息**就停：即便它没有图，也不该再往前翻
        //（用户这句话没带图 ⇒ 他要分析的图不存在，不该拿上一轮的去凑）。
        return images;
    }
    return [];
}
/**
 * 把图片字节拼成上游接受的 data URL。
 *
 * ⚠️ 形态必须与 `codeartsImagePart` 一致（`image_url` 对象套 url）——
 * 实测另外三种形态全部被拒（见 `llm-adapter.ts` 的 `codeartsImagePart` 注释）。
 */
export function imageDataUrl(data, mediaType) {
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
}
/**
 * 执行一次识图：收集本轮的图 → 读字节 → 交给 VL 模型 → 返回文字。
 *
 * @param exec - 工具执行上下文（取会话历史与取消信号）
 * @param deps - 识图依赖
 * @returns 给模型看的文字结果
 */
export async function runAnalyzeImage(exec, deps) {
    const session = exec.agent?.session;
    if (session?.deriveMessages === undefined) {
        throw new Error(`${ANALYZE_IMAGE_TOOL}: 无法读取会话历史（当前执行上下文没有 session）`);
    }
    const images = collectTurnImages(session.deriveMessages());
    if (images.length === 0) {
        // ⚠️ 这条文案是**给模型看的出路**：告诉它「这一轮没有图」，
        // 让它去问用户重新发图，而不是反复重试这个工具。
        return '这一轮消息里没有找到图片。请让用户把图片重新附上再试。';
    }
    if (images.length > ANALYZE_IMAGE_MAX_IMAGES) {
        throw new Error(`${ANALYZE_IMAGE_TOOL}: 本轮有 ${images.length} 张图片，超过单次上限 ${ANALYZE_IMAGE_MAX_IMAGES} 张；`
            + '请让用户分批发送。');
    }
    const urls = [];
    for (const image of images) {
        try {
            const stored = await deps.readImage(image);
            urls.push(imageDataUrl(stored.data, stored.mediaType));
        }
        catch (error) {
            // ⚠️ 单张读失败**不拖垮整次调用**：其余图片照常分析，
            // 失败的那张在结果里如实点名（与适配器 `stream()` 里读图的取向一致）。
            urls.push('');
        }
    }
    const usable = urls.filter((url) => url.length > 0);
    if (usable.length === 0) {
        return `找到了 ${images.length} 张图片，但都读不到字节（附件可能已被清理）。请让用户重新发送图片。`;
    }
    const description = await deps.describe(usable, ANALYZE_PROMPT, exec.signal);
    const missing = images.length - usable.length;
    return missing > 0
        ? `${description}\n\n（注意：本轮共 ${images.length} 张图片，其中 ${missing} 张读不到字节，未纳入分析。）`
        : description;
}
/**
 * 临时禁用开关的环境变量名。
 *
 * ⚠️ **这是应急闸，不是长期配置**（2026-10-23 应用户要求加）：
 * 设成 `1` / `true` / `yes` 时**根本不注册**该工具（而不是「注册了但请求时摘除」）。
 * 用途：① 线上出问题时能立刻把嫌疑项摘干净；② 验证「工具数是否是慢的成因」。
 * 长期形态仍以 {@link installAnalyzeImage} 的无条件注册 + 逐请求作用域摘除为准。
 */
export const ANALYZE_IMAGE_DISABLE_ENV = 'DSH_DISABLE_ANALYZE_IMAGE';
/** 读该开关（`1` / `true` / `yes` 大小写不敏感 ⇒ 禁用）。 */
export function analyzeImageDisabledByEnv(env = process.env) {
    const raw = env[ANALYZE_IMAGE_DISABLE_ENV];
    if (raw === undefined)
        return false;
    const key = raw.trim().toLowerCase();
    return key === '1' || key === 'true' || key === 'yes';
}
/**
 * 把 `analyzeImage` 注册到宿主。
 *
 * ## ⚠️ 为什么用 `ctx.inject(['tools', 'attachments'])`
 *
 * 两个服务缺一不可：`tools` 用来注册，`attachments` 用来读图片字节。
 * 缺任一个都**不注册**（而不是注册一个会报错的工具）—— 本仓纪律：
 * 「装不上的能力不要露出来」。
 *
 * ## ⚠️ 工具是否出现是**逐次求值**的
 *
 * `describe` 由调用方注入，且是否挂载由 {@link shouldOfferAnalyzeImage} 决定；
 * 用户在会话里切模型时，工具列表会随 `tools` 服务重新求值 —— 故这里把
 * 「当前路由能不能用」的判据放进工具**自身的 execute** 里再判一次，
 * 避免「工具挂上了但当前模型换了」时给出一个奇怪的失败。
 *
 * @param ctx - 插件上下文
 * @param deps - 识图依赖
 * @param routeOf - 读当前会话路由（provider/model）；返回 undefined 表示不可判定
 * @param log - 可选日志（禁用时记一条，便于事后确认是「闸关着」而不是「注册失败」）
 */
export function installAnalyzeImage(ctx, deps, routeOf, log) {
    ctx.inject(['tools', 'attachments'], (scope) => {
        const tools = scope.tools;
        if (tools === undefined || typeof tools.register !== 'function')
            return;
        if (analyzeImageDisabledByEnv()) {
            // ⚠️ 必须**留一条日志**：否则「工具不见了」与「注册静默失败」两种形态同形，
            //    而后者正是本工具栽过一次的坑（`tools.register()` 中断 ⇒ 零日志）。
            log?.info?.(`[codearts-auth] ${ANALYZE_IMAGE_TOOL} 已按 ${ANALYZE_IMAGE_DISABLE_ENV} 跳过注册（临时禁用）。`);
            return;
        }
        tools.register(defineToolLiteral({
            name: ANALYZE_IMAGE_TOOL,
            description: 'Analyse image or images the user attached in this turn and return a text description '
                + '(OCR text, objects, layout, colors). Use it when the current model cannot read images '
                + 'directly and the user attached a picture.',
            // ⚠️⚠️ 这里**必须**是完整的空对象 schema `{type:'object',properties:{}}`，
            //    **不能**写 `{}`（2026-10-23 真实报障，buddy/workbuddy 每轮 400）。
            //
            //    取证链：① 落盘 `request/header` 里 280 个工具**唯一**一个 parameters
            //    不是 `{type:'object',…}` 的就是本工具；② 同会话同一份 283 工具清单，
            //    qoder/codearts/loomy 全部正常、只有 buddy/workbuddy 硬 400；③ 真机 A/B
            //    （`scripts/probe-buddy-tool-schema.mts`）：同账号同消息，`{}` → 400
            //    `invalid function call parameters`，`{type:'object',properties:{}}` → 200，
            //    两站各自复现；④ 整份 280 工具清单原样 400、只改这一个 schema 就 200。
            //
            //    上游原文把「工具定义的参数结构不合规」直接点了名：
            //    `{"code":11129,"msg":"invalid function call parameters"}`。
            //    ⚠️ 宿主校验器 `assertSupportedJsonSchema({})` **不报错** —— 「宿主接受」
            //    与「上游接受」是两件事，别再用宿主那一格当证据。
            parameters: { type: 'object', properties: {} },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        description: { type: 'string' },
                    },
                    // ⚠️⚠️ `required` 是 **object 节点**的关键字，取值是**字符串数组**；
                    //   写在 `type: 'string'` 的子节点上不合法。宿主
                    //   `dsh-tools/lib/index.js` 的 `checkSchemaNode()` 有一张
                    //   「关键字 → 允许类型」对照表（`required: ['object']`），逐节点检查后抛
                    //   `JsonSchemaError: schema.properties.description.required is not supported
                    //   on type "string"` ⇒ `tools.register()` 整个中断 ⇒ 工具不可用
                    //   （Gitee IKPZW7，2026-10-23；症状是启动日志一条 error、工具静默消失）。
                    required: ['description'],
                },
                render: (_args, value) => value.description,
            },
            isConcurrencySafe: () => false,
            async execute(_args, exec) {
                // ⚠️ 逐次再判一次路由：工具在列表里存在 ≠ 当前模型还需要它。
                //    （VL 模型自己就能看图，给它这个工具是多余的一次往返。）
                const route = routeOf(exec);
                if (!shouldOfferAnalyzeImage(route?.provider, route?.model)) {
                    throw new Error(`${ANALYZE_IMAGE_TOOL}: 当前模型（${route?.provider ?? '?'}/${route?.model ?? '?'}）`
                        + '不需要这个工具 —— 它能直接读图，或不属于 codearts。');
                }
                return { description: await runAnalyzeImage(exec, deps) };
            },
        }));
    });
}
/** 识图时使用的 VL 模型（转发，便于接线层与单测共用一处）。 */
export { codeartsVisionModel };
//# sourceMappingURL=analyze-image.js.map