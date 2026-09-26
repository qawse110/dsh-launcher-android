/**
 * TRAE（字节跳动 TRAE IDE）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts` / `src/buddy-adapter.ts`，但**载荷转换与 SSE 解析全部重写**。
 *
 * ## 与现有适配器的关键差异
 *
 * | 项 | TRAE | Buddy / LobsterAI |
 * |---|---|---|
 * | 请求体 | OpenAI → SOLO 转换（function/config_name/tools 归一化） | 透传 OpenAI 格式 |
 * | SSE 格式 | SOLO 自定义事件（output/token_usage/done/error）→ 转 OpenAI | 标准 OpenAI SSE |
 * | 请求头 | `Cloud-IDE-JWT <token>` + X-* 系列 | Bearer / X-LobsterAI-Client-* |
 * | 图片 | 不支持 | Buddy / LobsterAI 支持 |
 * | prompt_cache_key | 不发 | Buddy 发（腾讯前缀缓存） |
 *
 * 复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` / `resolveToolPairing` /
 * `normalizeToolArguments` / `isTruncatedArguments`）——它们处理的是 OpenAI 协议层的通用陷阱。
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { settingsNamespaceFor } from './settings-compat.js';
import { TRAE_MAX_CONTEXT_TOKENS, clampTraeMaxTokens, isTraeExpired, parseTraeSSELine, isTraeModelCallable, traeMaxModeFields, traeSOLOHeaders, transformToSOLOBody, } from './trae.js';
import { TRAE } from './trae-product.js';
import { classifyTraeError, recordsTraeRateLimit, shouldRotateTraeAccount } from './trae-errors.js';
import { normalizeHarnessMessages } from './message-shape.js';
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js';
/** 本适配器注册的 provider 路由名。 */
export const PROVIDER = 'trae';
/**
 * 推理档位 wire 值 → 展示名。
 *
 * ⚠️ 与 LobsterAI 不同，TRAE 的 `reasoning_effort_config.options` 是**单值**
 * （`light` / `high` / `extra_high` …），该字符串既是产品侧档位名、也是发给
 * 上游的取值，故本表**只用于展示**，不做 wire 映射。
 * 未登记的取值回退原样显示，避免远端新增档位时显示空白。
 */
const TRAE_EFFORT_NAMES = {
    light: 'Light',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    extra_high: 'Extra High',
    xhigh: 'XHigh',
    max: 'Max',
};
/**
 * 推理档位强度序（数值越大越强）。
 *
 * ⚠️ **只用于挑「默认档」，不参与 wire 取值** —— wire 值就是远端
 * `reasoning_effort_config.options` 里的字符串本身，本表改了也不会影响下发。
 *
 * 覆盖 TRAE 实测出现过的全部档位；上游若新增档位，走
 * {@link strongestTraeEffort} 的第 3 条退化规则（取数组末项）。
 */
const TRAE_EFFORT_RANK = {
    off: 0,
    none: 0,
    minimal: 1,
    light: 2,
    low: 3,
    medium: 4,
    high: 5,
    extra_high: 6,
    xhigh: 7,
    max: 8,
};
/**
 * 从 `options` 里挑**最强**的一档作默认值。
 *
 * 三条规则逐级退化：
 * 1. 显式含 `max` → 用它（最直观的「最高档」语义，也覆盖 LobsterAI 那套
 *    `level: max → openclawLevel: xhigh` 的习惯）；
 * 2. 否则取**已登记强度序**里排名最高的；
 * 3. 若全都未登记（上游新增了档位）→ 取数组**最后一项**（远端按强度升序给出）。
 *
 * 之所以不直接用「数组最后一项」：远端不保证升序，而规则 2 对已知档位是确定的。
 */
function strongestTraeEffort(options) {
    if (options.length === 0)
        return undefined;
    if (options.includes('max'))
        return 'max';
    let best;
    let bestRank = -1;
    for (const option of options) {
        const rank = Object.prototype.hasOwnProperty.call(TRAE_EFFORT_RANK, option)
            ? TRAE_EFFORT_RANK[option]
            : undefined;
        if (rank !== undefined && rank > bestRank) {
            best = option;
            bestRank = rank;
        }
    }
    return best ?? options[options.length - 1];
}
/**
 * 挑默认思考档：**上游 `default_level` 优先**，缺失或非法才退到 `fallback`。
 *
 * ## 为什么是「采信上游」而不是自己定规则
 *
 * 早期实现一律取最强档（用户当时的要求），但那会让每次请求都顶格思考 ——
 * 思考 token **计入 `completion_tokens`**，与正文共享额度，于是正文更早撞
 * `max_tokens`、首字更慢。改为采信上游后，实测（2026-09-26，`solo_agent` 可见集）：
 *
 * | 模型 | options | 上游 `default_level` | 旧默认 | 新默认 |
 * |---|---|---|---|---|
 * | `deepseek-v4.1-flash` | light,high,extra_high | `high` | extra_high | **high** |
 * | `glm-5.2` | high,extra_high | `high` | extra_high | **high** |
 * | `qwen3.8-max` | light,high,extra_high | `high` | extra_high | **high** |
 * | `Doubao-Seed-2.1-Pro` | light,high | `high` | high | high |
 * | `glm-5.3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
 * | `kimi-k3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
 *
 * ⚠️ 注意后两行：上游**自己**在 `glm-5.3` / `kimi-k3` 上选了最高档。故不能改成
 * 「固定取次高档」——那会把这两个上游认可的最高档无谓降下来。
 *
 * ⚠️ `default_level` 是**外部输入**，必须校验它真的在 `options` 里：DSH 会拿
 * `defaultEffort` 直接发请求，给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`
 * （见 `dsh-llm` 的 `resolveCallWithInfo`）。实测上游确实会下发
 * `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到 `fallback`，
 * **不能**照抄。
 *
 * @param config 远端档位配置（`options` / `defaultLevel`）。
 * @param fallback `default_level` 不可用时的兜底档（通常是最强档）。
 */
function defaultTraeEffort(config, fallback) {
    const declared = config.defaultLevel;
    if (declared !== undefined && declared.length > 0 && config.options.includes(declared)) {
        return declared;
    }
    return fallback;
}
/** SSE 空闲超时（分两阶段，环境变量可覆盖）。 */
function resolveFirstTokenTimeoutMs() {
    return Number.parseInt(process.env.DSH_TRAE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000;
}
function resolveChunkTimeoutMs() {
    return Number.parseInt(process.env.DSH_TRAE_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000;
}
/** 限流重置时间的本地兜底（毫秒，1 小时）。 */
const TRAE_RATE_LIMIT_FALLBACK_MS = 3_600_000;
/** 单次请求最多换几个账号（含首次），防雪崩。 */
const TRAE_MAX_ROTATE = 3;
/**
 * 机器指纹轮换间隔（每 N 次请求换一代，仅在显式启用时生效）。
 *
 * 对齐 `Trae2api-cn/src/trae_client.py:220` 的 `max_uses = 3 + rand(0,2)`：
 * 即每 3~5 次请求换一次。这里取固定 4 次，避免引入随机性导致测试不可复现。
 */
const TRAE_MACHINE_ID_ROTATE_EVERY = 4;
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
/** 工具结果内嵌图片的载体文本（与 buddy / lobsterai 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
/**
 * 把 harness 内容块转成 OpenAI 多模态 parts（含图片）。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— **实测（2026-09-21）
 * 这是 SOLO 上游唯一接受的形态**：`transformToSOLOBody` 对数组 content 原样
 * 透传，而这种 parts 形状直发即可被模型读到（纯红图答「红色」、纯蓝图答
 * 「蓝色」，不带图则答「无法确定」）。故无需任何额外的协议转换。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 `collectImages` **对称地递归**处理 `tool-result` 内层：收集侧是任意深度，
 * 序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
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
/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
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
/**
 * 将 harness 的 **DSH 原生消息块**序列化为 OpenAI 传输格式。
 *
 * ## ⚠️ 为什么必须有这一步（真实缺陷）
 *
 * DSH 交给适配器的 `GenerateOptions.messages` 用的是**原生块结构**：
 * `content: [{type:'tool-call',...}]`、`[{type:'tool-result',...}]`、
 * `[{type:'reasoning',...}]`。它**不是** OpenAI 的 wire 格式。
 *
 * 早期实现把 `options.messages` **原样**塞进 `transformToSOLOBody`，而后者只做
 * 「字符串 content → `[{type:'text'}]`」这一类改写，**不认识** DSH 的块类型。
 * 实测证据（把 DSH 原生形状喂给 `transformToSOLOBody`）：
 *
 * ```json
 * { "role": "assistant",
 *   "content": [ { "type": "reasoning", "text": "…" },
 *                { "type": "tool-call", "id": "call_1", "name": "read", "…" } ] }
 * ```
 *
 * 后果是**每一轮多步对话都坏掉**，且症状极隐蔽：
 *
 * 1. **工具调用对模型不可见**：`tool-call` 块不是 SOLO 认识的字段，
 *    上游只当它是未知 content 片段 —— 模型看不到自己刚才调用过什么；
 * 2. **工具结果丢失**：`tool-result` 块同样不被识别，模型**永远看不到
 *    工具返回值**，于是反复请求同一个工具，或凭空编造结果；
 * 3. `reasoning` 块被当作正文喂回，污染上下文。
 *
 * 三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` /
 * `lobsterai-adapter.ts`）**都有**这一步 `serializeMessages`，只有 TRAE
 * 漏了 —— 本文件顶部甚至 already `import` 了 `resolveToolPairing` 却从未使用，
 * 说明当初就是打算写、但没接上。
 *
 * 序列化后的形状与 Go 端（`payload.go:PrepareBody`）的输入**完全一致**：
 * assistant 带 `tool_calls`（`function` 形态），工具结果展开为独立
 * `{role:'tool', tool_call_id}` 消息。随后 `transformToSOLOBody` 再按 SOLO
 * 规则把 `function` → `function_call`（与 Go 端同一条流水线）。
 *
 * ## 图片（`imageUrls`）
 *
 * `imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined（**含空 Map**）
 * 时把带图的 user 消息升级为多模态 parts（`{type:'image_url',...}`）。
 * 空 Map **不能**降级为 undefined —— 那会让「图片存在但字节读取失败」的
 * `[image unavailable]` 占位符也被跳过，图片静默消失。
 */
function serializeTraeMessages(messages, imageUrls) {
    const wire = [];
    // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
    // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，下面的
    // `type === 'tool-result'` 判据恒不命中 → 工具结果被当成普通 user 消息下发、
    // `tool_call_id` 关联丢失，且 `resolveToolPairing` 会剔除全部 tool_calls。
    const normalized = normalizeHarnessMessages(messages);
    // 剔除无法配对的工具调用/结果：SOLO 上游同样要求 tool_calls 与 tool 结果
    // 严格配对，孤儿条目会让整条会话被拒（与三个兄弟适配器同款防线）。
    const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
    // 工具结果内嵌图片（`read_image` 等）不能并入 `role:'tool'` 消息：该角色的
    // content 只能是字符串，且必须紧跟其 assistant tool_call，中间插消息会 400。
    // 故挂起到其后的独立 user 消息统一发出（与 buddy / lobsterai 同款处理）。
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
                function: {
                    name: String(block.name),
                    arguments: normalizeToolArguments(String(block.arguments)),
                },
            }));
            const text = contentToText(content);
            // 正文为空且有工具调用时 content 必须为 null（对齐 Go 端：纯 tool_calls
            // 的 assistant 不回写空 content）。
            wire.push({
                role: 'assistant',
                content: text.length === 0 && toolCalls.length > 0 ? null : text,
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        if (message.role === 'system') {
            wire.push({ role: 'system', content: contentToText(message.content) });
            continue;
        }
        // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResults = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-result');
        const text = contentToText(message.content);
        // 图片：仅当本请求带图（imageUrls 非 undefined）时升级为多模态 parts。
        const parts = imageUrls === undefined ? undefined : userContentParts(content, imageUrls);
        if (parts !== undefined) {
            // 有图：正文与图片合并为一条多模态 user 消息（parts 里已含文本块）。
            flushToolImages();
            wire.push({ role: 'user', content: parts });
        }
        else if (text.length > 0 || toolResults.length === 0) {
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            // 丢弃孤儿工具结果：没有对应 tool_call 同样会被上游拒绝。
            if (!keepResultIds.has(String(result.toolCallId)))
                continue;
            const innerParts = imageUrls === undefined
                ? undefined
                : (Array.isArray(result.content) ? userContentParts(result.content, imageUrls) : undefined);
            if (innerParts !== undefined) {
                // 工具结果内嵌图片：该消息的 content 只能是字符串，图片挂到后续独立
                // user 消息里（不能就地展开，否则违反 role:'tool' 的协议约束）。
                pendingToolImages.push(...innerParts.filter((part) => part.type === 'image_url'));
            }
            wire.push({
                role: 'tool',
                tool_call_id: String(result.toolCallId),
                content: contentToText(result.content) || (innerParts !== undefined ? TOOL_RESULT_IMAGE_TEXT : '(no output)'),
            });
        }
        flushToolImages();
    }
    return wire;
}
/** 从错误体提取可读 detail 文本。 */
function errorDetail(body) {
    try {
        const data = JSON.parse(body);
        const parts = [
            typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
            typeof data.message === 'string' ? data.message : undefined,
            typeof data.msg === 'string' ? data.msg : undefined,
        ].filter((value) => value !== undefined);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch { /* 非 JSON 错误体 */ }
    return body;
}
/** HTTP 状态码映射。 */
function httpErrorCode(status) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400)
        return 'INVALID_REQUEST';
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/**
 * 组合 SOLO **流内** `event:error` 的文案。
 *
 * `code=4001` 的上游原文是 *"We're sorry, the param is invalid. Please try with a
 * valid param."* —— 实测（2026-09-19，遍历 45 个远端模型）该码**只**由
 * **不可调用的模型**触发：5 个 `display_config.is_custom_model === true` 的条目
 * 全部报 4001，而同批次的其余模型全部正常。也就是说它与「提示词/参数格式有误」
 * 毫无关系，原文会把排查方向**完全带偏**（去查 message 结构、tools 序列化…）。
 *
 * ⚠️ **那 5 个条目的名单已过期**（复测 2026-09-20）：其中 3 个下架、2 个转为
 * `is_custom_model: false`（已可调用），全目录 custom 条目数为 0。故这里**不列
 * 具体模型名** —— 把某一刻的快照写成判据，会让后人误删合法模型。
 *
 * 故对 4001 追加一句指向真实成因的可操作提示。其余错误码保持原样，
 * 不做无依据的解释。
 */
function traeStreamErrorMessage(code, message, model) {
    const base = `trae: ${message} (code=${code})`;
    if (code !== 4001)
        return base;
    return `${base} —— 模型「${model}」不被上游接受：它通常是「仅可见但不可调用」的`
        + '自定义模型（需先在 TRAE IDE 内自行配置供应商），请改用模型列表中的其它模型';
}
/** 传输级错误判定。 */
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
 * 组装模型选择器里展示的名字：`模型名 · 倍率`。
 *
 * ## 为什么倍率必须拼进 `name`
 *
 * composer 的模型切换菜单**只渲染 `name`**（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`），
 * `description` **完全不读**。用户报障「消耗倍率没有显示在切换模型列表的后面」
 * 正是因为早期版本放进了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`，故附加价格不会
 * 污染会话历史。`resolveModel` 的 `name` **不带**倍率（价格只属于选择列表语境，
 * 与 Qoder 的处理一致）。
 *
 * 形态：
 * - 常态 `Qwen3.8-Flash · x0.08`
 * - 活动期 `Doubao-Seed-2.1-Pro · x0.80→x0.08`（箭头比「（促销 …）」短，适合窄菜单）
 * - 无倍率信息时只显示模型名（**不编造** `x1`）
 */
export function traeDisplayName(model) {
    const rate = model.creditsRate;
    if (rate === undefined)
        return model.name;
    // `0` 是**合法**倍率（免费），必须与「没有倍率」区分开。
    const current = rate === 0 ? '免费' : `x${rate}`;
    // 活动折扣：只在解析层已判定「当前生效」时才有 originalCreditsRate。
    const original = model.originalCreditsRate;
    if (original !== undefined && original > rate) {
        return `${model.name} · x${original}→${current}`;
    }
    return `${model.name} · ${current}`;
}
/**
 * TRAE 模型适配器。
 */
export class TraeAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    /** 动态模型缓存。 */
    remoteModels;
    /** 远端模型元数据索引。 */
    remoteMeta = new Map();
    /** 产品级兜底模型索引。 */
    fallbackIndex;
    /**
     * 已发起的 chat 请求计数（仅在启用机器指纹轮换时使用，见
     * {@link TraeAdapter.machineIdGeneration}）。
     */
    sendCount = 0;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? TRAE;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.fallbackIndex = new Map((this.product.fallbackModels ?? []).map((model) => [model.id, model]));
    }
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /** 懒加载远端模型目录（仅拉取一次）。 */
    async ensureRemoteModels() {
        if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined)
            return;
        try {
            const models = await this.options.fetchRemoteModels();
            if (models.length > 0) {
                this.remoteModels = models;
                this.remoteMeta = new Map(models.map((model) => [model.id, model]));
            }
        }
        catch { /* 远端不可用：回退兜底目录 */ }
    }
    /**
     * 模型接受的输入模态 —— **逐模型**判定，不是按 provider 一刀切。
     *
     * 判据是远端 `display_config.multimodal`（见
     * {@link TraeRemoteModel.multimodal} 的实测记录）：
     *
     * - `true` → `['text', 'image']`
     * - `false` / **未声明** → `['text']`（保守：兜底表没有该字段，
     *   且「远端没说」不等于「远端支持」）
     *
     * ⚠️ **这里返回的 `image` 是 DSH 的准入闸门**：不声明 `image` 时，图片会在
     * **附件入库阶段**就被拒（`session/attachment-invalid`），用户看到
     * 「当前模型不支持图片」——而图根本没发到上游。因此漏报 `image` 不只是
     * 「少个功能」，而是「连降级成文本占位符的机会都没有」。
     *
     * **历史缺陷**（Issue #IKHDKC）：早期这里恒返回 `['text']`（参数名甚至是
     * `_model`，即刻意忽略模型），理由是「SOLO 通道未见图片能力」—— 实测证伪：
     * 远端一直在目录里声明该能力，且直发图片后模型真的看得见。
     */
    inputModalitiesFor(model) {
        return this.remoteMeta.get(model)?.multimodal === true ? ['text', 'image'] : ['text'];
    }
    /**
     * 该模型所属的聊天通道（`function`）。
     *
     * ⚠️ **模型只在列出它的通道里可调用**：发错通道上游会回流内
     * `code=4001 param is invalid`（实测 `glm-5.1` 在 `solo_work_lite` 报错、
     * 在 `solo_agent_remote` 正常；`glm-5-turbo` 恰好相反）。
     * 远端目录里每条模型都带自己的 `function`；查不到时回退默认通道。
     */
    channelFor(model) {
        const channel = this.remoteMeta.get(model)?.function;
        return channel !== undefined && channel.length > 0 ? channel : this.product.function;
    }
    /**
     * 模型的上下文窗口：远端优先，兜底表次之。
     *
     * ⚠️ 开启 Max 模式时改用 `context_window_tokens.max`（1M）。两者**不能混用**：
     * 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，而上游按 200K 校验后
     * 拒绝（输入被截断或 4xx）。
     */
    contextWindowFor(model) {
        const meta = this.remoteMeta.get(model);
        if (this.maxModeFor(model)) {
            return meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS;
        }
        return meta?.contextWindow ?? this.fallbackIndex.get(model)?.contextWindow;
    }
    /**
     * 该模型本次是否启用 **Max 模式**（1M 上下文）。
     *
     * 三个条件缺一不可（对齐 `Trae2api-cn/trae_remote_client.py:249-277`）：
     * 1. 产品级开关（`DSH_TRAE_MAX_MODE`）未关 —— **默认开启**，用户要求
     *    「上下文用最大的那一档」；显式设 `0` / `false` 才关回 200K；
     * 2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套
     *    Max 参数，上游会拒绝（`_max_mode_requested` 的注释明写
     *    "Never fabricate max limits for a model the account config does not mark"）；
     * 3. 若配置了白名单，模型须在其中。
     */
    maxModeFor(model) {
        if (this.product.maxMode !== true)
            return false;
        const meta = this.remoteMeta.get(model);
        if (meta === undefined || meta.maxMode !== true)
            return false;
        const whitelist = this.product.maxModeModels;
        if (whitelist !== undefined && whitelist.length > 0 && !whitelist.includes('*')) {
            return whitelist.includes(model);
        }
        return true;
    }
    /**
     * 模型可选的推理强度档位（`reasoning_effort_config`）。
     *
     * TRAE 的 `options` 是**单值字符串**（既是产品侧档位名、也是 wire 值），
     * 与 LobsterAI 的 `level` / `openclawLevel` 双字段形态不同，故不需要映射表
     * 之外的转换（命名仅用于展示）。
     *
     * 不声明 `reasoning` 的两种情形：
     * - 远端没有该配置 → UI 显示「当前模型未提供推理等级」（而不是给个发了没用的档位）
     * - `support_thinking === false` → 远端明确说不支持思考
     *
     * `defaultEffort` 必须落在 `efforts` 内（DSH 会拿它直接发请求），远端数据
     * 不一致时退化为不声明默认值。
     */
    reasoningFor(model) {
        const config = this.remoteMeta.get(model)?.reasoningConfig;
        if (config === undefined)
            return undefined;
        if (config.supportThinking === false)
            return undefined;
        if (config.options.length === 0)
            return undefined;
        const efforts = config.options.map((option) => ({
            id: ReasoningEffortId(option),
            name: TRAE_EFFORT_NAMES[option] ?? option,
        }));
        // ⚠️ 默认档**优先采信上游 `default_level`**（见 {@link defaultTraeEffort}）。
        // 早期实现一律取最强档（用户当时要求「所有模型默认用 max」），代价是思考
        // token 与正文共享 `completion_tokens`、正文更早撞上限。改为采信上游后：
        // 实测 6 个模型里 4 个上游给的就是次高档 `high`，而 `glm-5.3` / `kimi-k3`
        // 上游自己选的是 `extra_high` —— 机械取「次高档」会把后两者无谓降档，
        // 故以**上游的判断**为准，而不是自己定一条规则。
        const fallback = strongestTraeEffort(config.options);
        const chosen = defaultTraeEffort(config, fallback);
        return {
            efforts,
            ...chosen !== undefined ? { defaultEffort: ReasoningEffortId(chosen) } : {},
        };
    }
    /**
     * 模型的输出上限：远端优先 → 兜底表 → 产品级兜底值。
     *
     * ⚠️ 实测远端主流模型声明的是 **32000**，而兜底表旧值写的 128000 会让
     * DSH 索要一个上游不接受的值。远端可用时一律以远端为准。
     */
    maxOutputTokensFor(model) {
        const meta = this.remoteMeta.get(model);
        // Max 模式下 `model_detail_list` 的 `__max` 那条声明的输出上限才是准的
        // （实测 `custom_model_1M__max` 384000 vs `__dev` 64000）。
        if (this.maxModeFor(model) && meta?.maxModeOutputTokens !== undefined) {
            return meta.maxModeOutputTokens;
        }
        return meta?.maxOutputTokens
            ?? this.product.fallbackMaxOutputTokens;
    }
    /**
     * 静态兜底模型目录。
     *
     * 始终过滤 `isHidden === true` 的条目（这些是上游内部/隐藏模型，不应出现在
     * 对话模型目录中）。与远端路径的过滤逻辑一致（`parseTraeBatchModelList` 中也
     * 硬性过滤 `isHidden === true`）。
     */
    staticFallbackModels() {
        return this.product.fallbackModels
            .filter((model) => model.isHidden !== true)
            .map((model) => ({ id: model.id, name: model.name }));
    }
    /**
     * 完整模型目录（**不应用用户黑名单**）。
     *
     * ## 为什么需要它
     *
     * `listModels` 会按用户黑名单过滤（Jet Hub「显示列表」开关），于是**被关闭的
     * 模型不在其返回值里**。而设置页必须把关闭的模型也渲染出来（否则用户无法重新
     * 打开），RPC 层只能凭黑名单的 key（裸 id）补回 —— 那条路径拿不到展示名，
     * 只能回退成裸 id，**倍率与模型显示名随之丢失**（用户报障：「关闭的就没有显示
     * 倍率，关闭的应该也显示倍率」）。
     *
     * 故这里提供「不过滤黑名单」的目录，由 `model.list` 端点使用：它据此拿到
     * 每个 id 的**真实展示名（含倍率）**，再自行回填 `disabled` 状态。
     * 对话框模型选择器读的仍是 `listModels`（已过滤），可见性行为不变。
     */
    listAllModels() {
        // 过滤逻辑与 `listModels` 的第一、二层一致（usage / config_switch /
        // is_invisible_to_user 已在解析器里剔除；这里再挡 isHidden 与 is_custom_model），
        // **唯一区别是不套用户黑名单**。
        const source = this.remoteModels === undefined
            ? this.staticFallbackModels()
            : this.remoteModels.filter((model) => isTraeModelCallable(model) && model.isHidden !== true);
        return source.map((model) => ({ id: model.id, name: traeDisplayName(model) }));
    }
    async listModels(_provider) {
        // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
        // 不必拉（省掉一次无谓的 HTTP 请求）。没有任何已登录账号时返回空数组，让
        // DSH 的 `buildModelCatalog`（它 `.filter(group => group.models.length > 0)`）
        // 把整个 provider 分组隐藏，减少模型选择列表的臃肿（见 providerCatalogVisible）。
        // ⚠️ 这里必须返回 `[]` 而**不能抛错**：抛错会被归入 catalog 的 `failures`，
        // 界面上反而多出一条 provider 报错。
        if (!await providerCatalogVisible(this.options.accountPool, this.product.id))
            return [];
        await this.ensureRemoteModels();
        // 过滤逻辑分两层：
        //
        // 第一层（解析时，`parseTraeBatchModelList`）：硬性过滤 `usage !==
        // chat_completion` / `config_switch === false` / `is_invisible_to_user ===
        // true`。这些条件对 batch 端点（全功能配置表）有意义，避免 summary /
        // custom_model / multimodal 等非对话条目塞满目录。
        //
        // 第二层（运行时，`listAllModels`）：硬性过滤 `isHidden === true`（兜底表
        // 路径没有解析器，在 `staticFallbackModels` 里过滤；远端路径由解析器过滤，
        // 但测试绕过解析器直接喂 `TraeRemoteModel[]`，故此处再补一刀保持一致性）+
        // `is_custom_model === true`（自定义模型，需用户在 IDE 内绑定供应商，本
        // 插件调不通，一律 4001）。
        //
        // ⚠️ `is_invisible_to_user` **不再由 `hideInternalModels` 控制**：新设计
        // 要求目录与官方 Auto Mode 选择器一致，隐藏模型不在目录中展示。
        const source = this.listAllModels();
        const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
        const listed = disabled === undefined || disabled.size === 0
            ? source
            : source.filter((model) => !disabled.has(model.id));
        return listed.map((model) => ({
            provider: this.product.id,
            id: model.id,
            name: model.name,
            // ⚠️ 逐模型判定（远端 `display_config.multimodal`）—— 早期这里硬编码
            // `['text']`，导致 DSH 在附件准入阶段就拒掉图片（Issue #IKHDKC）。
            inputModalities: this.inputModalitiesFor(model.id),
        }));
    }
    async resolveModel(provider, model, _signal) {
        await this.ensureRemoteModels();
        const remoteName = this.remoteMeta.get(model)?.name;
        const resolved = {
            provider,
            id: model,
            name: remoteName ?? this.fallbackIndex.get(model)?.name ?? model,
            // ⚠️ 与 listModels 同源：必须逐模型判定，否则准入闸门仍会拦下图。
            inputModalities: this.inputModalitiesFor(model),
        };
        const contextWindow = this.contextWindowFor(model);
        if (contextWindow !== undefined)
            resolved.context = { contextWindow };
        const maxTokens = this.maxOutputTokensFor(model);
        if (maxTokens !== undefined)
            resolved.defaultMaxTokens = maxTokens;
        // 推理强度档位：远端 `reasoning_effort_config` 权威（见 reasoningFor）。
        const reasoning = this.reasoningFor(model);
        if (reasoning !== undefined)
            resolved.reasoning = reasoning;
        return resolved;
    }
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 0. 确保远端目录已加载 —— 发送时要用它决定该模型走哪个通道
        //    （`channelFor`）。`prepareCall` 通常已通过 `resolveModel` 触发过，
        //    这里只作兜底（已加载时是空操作）。
        await this.ensureRemoteModels();
        // 1. 获取凭据（过期则先静默续期）
        let credential = await this.options.resolveCredential();
        if (credential === undefined || isTraeExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential();
        }
        if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('trae: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // 2. 记录当前账号
        let currentAccountId = '';
        if (this.options.accountPool) {
            try {
                currentAccountId = await this.options.accountPool.findAccountIdByCredential(this.product.id, credential.access_token);
            }
            catch {
                // 账号不匹配不影响请求
            }
        }
        // 3. 图片：按**模型**判定是否接受，并把字节读成 data URL
        //
        // ⚠️ **不能无条件拒绝**：实测（2026-09-21）TRAE 上游真的支持图片 ——
        // 远端目录里 `display_config.multimodal` 一直在声明该能力，且直发图片后
        // 模型确实读到了像素（红图答「红色」、蓝图答「蓝色」、无图答「无法确定」）。
        // 早期这里无条件抛错（理由「SOLO 通道不支持图片」），配合 `inputModalities`
        // 恒为 `['text']`，导致图片在**附件准入阶段**就被 DSH 拒掉（用户报障
        // Issue #IKHDKC）。
        //
        // 现在：`multimodal !== true` 的模型仍明确报错（实测 `DeepSeek-V4-Pro-Official`
        // 收到图后答「无法确定」、思考链说「但没有图片」，证明该标志是权威判据）；
        // `multimodal === true` 的模型读字节并转成 data URL 随请求发出。
        //
        // 宁可显式报错（DSH 会据此把图片投影成文本占位符），也不要静默吞掉。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        // `imageUrls` 为 undefined 表示「本请求没有图片」；非 undefined（含空 Map）
        // 时序列化层会把带图的 user 消息升级为多模态 parts。空 Map 不能降级为
        // undefined —— 那会让「图片存在但字节读取失败」的占位符也被跳过。
        let imageUrls;
        if (imageRefs.size > 0) {
            if (!this.inputModalitiesFor(options.model).includes('image')) {
                throw new LlmError(`trae: model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
            }
            if (this.options.readImage === undefined) {
                throw new LlmError('trae: image input requires the attachment service; '
                    + 'confirm the profile loads @deepseek-ai/dsh-attachment-local.', 'UNSUPPORTED_CONTENT');
            }
            imageUrls = new Map();
            for (const [id, ref] of imageRefs) {
                const image = await this.options.readImage(ref);
                if (image === undefined)
                    continue;
                imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
            }
        }
        // ⚠️ **tools / tool_choice 必须放进源的 OpenAI 对象里再交给
        // `transformToSOLOBody`**，不能在转换之后再补 —— SOLO 上游要求
        // `function.parameters` 是 **JSON 字符串**（OpenAI 标准是对象），
        // 那一步序列化发生在 `normalizeTools` 内部，只对**转换时已存在**的
        // tools 生效。若在转换后赋值，parameters 会保持对象形态发给上游，
        // 被反序列化拒绝（且错误信息不会指向这里）。
        //
        // ⚠️ 同理，messages 必须**先**经 `serializeTraeMessages` 转成 OpenAI
        // 传输格式（tool_calls / role:'tool' / 纯文本 content）。DSH 的
        // 原生 content 块（tool-call / tool-result / reasoning）不是 SOLO 认识的
        // 结构，原样下发会让模型看不到工具调用与工具结果（详见该函数注释）。
        const wireMessages = serializeTraeMessages(options.messages, imageUrls);
        const openaiBody = {
            model: options.model,
            messages: wireMessages,
            stream: true,
        };
        if (options.tools !== undefined && options.tools.length > 0) {
            openaiBody.tools = options.tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }));
        }
        if (options.temperature !== undefined)
            openaiBody.temperature = options.temperature;
        // 输出额度收敛到上游安全上限（默认 64000，见 clampTraeMaxTokens）。
        // 不收敛时客户端索要 131072 会把上游打成 4xx。
        const maxTokens = clampTraeMaxTokens(options.maxTokens);
        if (maxTokens !== undefined)
            openaiBody.max_tokens = maxTokens;
        if (options.stop !== undefined && options.stop.length > 0)
            openaiBody.stop = options.stop;
        // 推理强度：DSH 注入的 `reasoningEffort` 原样透传给上游的 `reasoning_effort`。
        //
        // 取值来自 `resolveModel` 声明的 `reasoning.efforts`（即远端
        // `reasoning_effort_config.options` 的字符串），故这里不做白名单校验 ——
        // 校验只会把「远端新增档位」变成静默丢弃。
        if (options.reasoningEffort !== undefined) {
            openaiBody.reasoning_effort = options.reasoningEffort;
        }
        // Max 模式（1M 上下文）：成套覆盖 `max_tokens` / `prompt_max_tokens` /
        // `context_window_size` 并注入 `strategy=max`（见 traeMaxModeFields）。
        //
        // ⚠️ 必须在 `clampTraeMaxTokens` **之后**执行：Max 会话的输出上限由远端
        // `__max` 明细声明（可能高于 64K 安全线），被 clamp 覆盖会让 Max 请求
        // 与常规请求的输出预算相同、失去意义。
        if (this.maxModeFor(options.model)) {
            const meta = this.remoteMeta.get(options.model);
            Object.assign(openaiBody, traeMaxModeFields(meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS, meta?.maxModeOutputTokens));
        }
        // system 提示并入 messages 顶部（同样要在转换之前，以便 content 被规范化）。
        if (options.system !== undefined && options.system.length > 0) {
            openaiBody.messages = [
                { role: 'system', content: options.system },
                ...wireMessages,
            ];
        }
        // 历史裁剪：必须在序列化**之后**做（裁剪的是 wire 消息，不是 DSH 块）。
        // 超限时从最早的非系统消息开始整轮丢弃，且不切断 tool_call/tool 配对。
        openaiBody.messages = trimTraeHistory(openaiBody.messages);
        // 一次性完成 OpenAI → SOLO 转换（含 messages 规范化、tools 序列化、
        // tool_choice 归一化、config_name 注入），并**按模型路由通道** ——
        // 同一模型只在列出它的通道里可调用（发错通道会得到流内 4001）。
        const bodyObj = transformToSOLOBody(openaiBody, undefined, this.channelFor(options.model));
        const body = JSON.stringify(bodyObj);
        // 4. 发送请求（401/403 时刷新一次凭据后重试）
        let response = await this.send(credential, body, options);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential();
            if (refreshed === undefined || refreshed.access_token.length === 0) {
                throw new LlmError('trae: credential expired and refresh failed', 'AUTH', { status: response.status });
            }
            credential = refreshed;
            response = await this.send(credential, body, options);
        }
        if (!response.ok) {
            let errorText = await response.text().catch(() => '');
            let lastStatus = response.status;
            let lastKind = classifyTraeError(response.status, errorText);
            if (this.options.accountPool && shouldRotateTraeAccount(lastKind)) {
                const tried = new Set();
                if (currentAccountId)
                    tried.add(currentAccountId);
                const maxRotate = TRAE_MAX_ROTATE - 1;
                for (let round = 0; round < maxRotate; round++) {
                    if (currentAccountId && recordsTraeRateLimit(lastKind)) {
                        await this.options.accountPool.updateModelRateLimit(currentAccountId, options.model, Date.now() + TRAE_RATE_LIMIT_FALLBACK_MS);
                    }
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
                    lastStatus = response.status;
                    lastKind = classifyTraeError(response.status, errorText);
                    if (!shouldRotateTraeAccount(lastKind))
                        break;
                }
                throw new LlmError(`trae: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`, lastKind === 'quota-exceeded' ? 'QUOTA_EXCEEDED' : httpErrorCode(lastStatus), { status: lastStatus });
            }
            if (lastKind === 'quota-exceeded') {
                throw new LlmError(`trae: 积分不足（${errorDetail(errorText)}）`, 'QUOTA_EXCEEDED', { status: lastStatus });
            }
            throw new LlmError(`trae: ${errorDetail(errorText)}`, httpErrorCode(lastStatus), { status: lastStatus });
        }
        // 5. 消费 SSE 流（SOLO → OpenAI 转换）
        //
        // 空响应（HTTP 200 但一个事件都没发）**重试一次**。这是安全的：
        // `consumeSse` 只在「尚未产出任何 chunk」时抛该错误，因此不存在
        // 「已经吐了一半再重放」的重复计费风险（对齐 CN 项目的
        // `TRAE_REMOTE_WORK_FALLBACK` 语义：只在首个模型事件之前允许重试）。
        for (let attempt = 0;; attempt++) {
            try {
                yield* this.consumeSse(response, options);
                return;
            }
            catch (error) {
                const empty = error instanceof LlmError
                    && error.message.includes('upstream returned no events');
                if (!empty || attempt >= 1)
                    throw error;
                if (options.signal?.aborted)
                    throw error;
                response = await this.send(credential, body, options);
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new LlmError(`trae: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status });
                }
            }
        }
    }
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    async send(credential, body, options) {
        this.sendCount += 1;
        const headers = new Headers(traeSOLOHeaders(credential, this.product, true, this.machineIdGeneration()));
        try {
            return await this.fetchImpl(`${this.product.agentHost}/api/agent/v3/llm_utils_chat`, {
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
                throw new LlmError(`trae: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
            }
            throw error;
        }
    }
    /**
     * 当前应使用的机器指纹代次。
     *
     * **默认恒为 0（不轮换）** —— 只有显式设置
     * `DSH_TRAE_ROTATE_MACHINE_ID=1` 时才按每 4 次请求递增一代。
     *
     * 默认关闭的原因见 {@link deriveRotatingMachineId}：轮换能降低端点风控，
     * 但会让设备身份漂移，与「machine_id 登录后绝不变」的既定约束冲突。
     * 该开关是出现集中 401/风控时的第一个可尝试手段。
     */
    machineIdGeneration() {
        if (process.env.DSH_TRAE_ROTATE_MACHINE_ID !== '1')
            return 0;
        return Math.floor(this.sendCount / TRAE_MACHINE_ID_ROTATE_EVERY);
    }
    /**
     * 消费 SOLO 自定义 SSE 流，转为 OpenAI StreamChunk。
     *
     * SOLO 事件格式（solosse.go）：
     * ```
     * event:output
     * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
     *
     * event:token_usage
     * data:{"prompt_tokens":21,"completion_tokens":142,...}
     *
     * event:done
     * data:{"finish_reason":"stop"}
     *
     * event:error
     * data:{"code":4008,"message":"quota exceeded"}
     * ```
     */
    async *consumeSse(response, options) {
        if (!response.body)
            throw new LlmError('trae: empty model response body', 'EMPTY_RESPONSE');
        const blocks = [];
        let nextIndex = 0;
        /**
         * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
         * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
         *
         * 与 buddy 同因：`reasoning_tokens` **计入** `completion_tokens`，思考陷入
         * 病态重复就把输出额度烧光、正文零产出，而 `finish` 若是 `stop`，UI 上
         * 完全看不出错误。
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
         */
        const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined;
        let proseLoopDetected = false;
        /** `</think:hex>` 泄漏探测（跨帧，收尾再切分）。 */
        let proseHasThinkTag = false;
        /**
         * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
         * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
         *
         * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
         * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
         * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
         */
        const suppressor = createBlankReasoningSuppressor();
        const toolCalls = new Map();
        const toolOrder = [];
        const toolIds = new Map();
        let buffer = '';
        let streamEnded = false;
        let finishReason;
        // SSE 事件累积状态（跨行累积 event + data）
        let currentEvent = '';
        let currentData = '';
        // 会话 id（从 metadata 事件获取，但非必需）
        let gotAnyContent = false;
        /**
         * 是否收到过**任何**可解析的上游事件。
         *
         * ## 为什么需要它
         *
         * 上游有时会「会话创建成功、HTTP 200、然后一个事件都不发就结束流」
         * （CN 项目称之为 empty response，见 `main.py:3391-3408`）。这不是
         * 正常的空回复，而是可重试的瞬时故障。
         *
         * 关键是**只在首个模型事件之前**才允许重试：一旦已有 output / usage /
         * tool_calls 事件，重放请求会让上游**重复计费并可能重复执行工具**。
         * 因此本标记只在「一个事件都没收到」时才让调用方重试。
         */
        let sawAnyUpstreamEvent = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let firstTokenReceived = false;
        try {
            for (;;) {
                if (streamEnded)
                    break;
                let result;
                try {
                    const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
                    const phase = firstTokenReceived ? 'chunk' : 'first-token';
                    result = await readWithIdleTimeout(reader, timeoutMs, 'trae', options.signal, phase);
                    if (!result.done)
                        firstTokenReceived = true;
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw error;
                    if (error instanceof LlmError)
                        throw error;
                    if (isTransportError(error)) {
                        throw new LlmError(`trae: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
                    }
                    throw error;
                }
                if (result.done)
                    break;
                buffer += decoder.decode(result.value, { stream: true });
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    // 空行 = 事件分隔符 → 解析累积的事件
                    if (line.trim().length === 0) {
                        if (currentEvent.length > 0) {
                            const ev = parseTraeSSELine(currentEvent, currentData);
                            currentEvent = '';
                            currentData = '';
                            if (ev === undefined)
                                continue;
                            // 任何**可解析**的上游事件（含 metadata / timing_cost）都算
                            // 「上游确实开工了」——此后绝不重放请求（见 sawAnyUpstreamEvent）。
                            sawAnyUpstreamEvent = true;
                            // 分发事件
                            switch (ev.event) {
                                case 'output': {
                                    const delta = {};
                                    if (ev.response !== undefined && ev.response.length > 0) {
                                        delta.content = ev.response;
                                        gotAnyContent = true;
                                    }
                                    if (ev.reasoningContent !== undefined && ev.reasoningContent.length > 0) {
                                        delta.reasoning_content = ev.reasoningContent;
                                    }
                                    if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
                                        delta.tool_calls = ev.toolCalls;
                                    }
                                    if (Object.keys(delta).length > 0) {
                                        // 按块类型分发
                                        if (delta.content !== undefined) {
                                            let block = blocks.find(c => c.kind === 'text');
                                            if (block === undefined) {
                                                block = { index: nextIndex++, kind: 'text', text: '' };
                                                blocks.push(block);
                                                yield { type: 'block-start', index: block.index, blockType: 'text' };
                                            }
                                            // 正文死循环守卫（见 `proseLoopGuard` 注释）。命中后只停止
                                            // 累积与发射，绝不 `reader.cancel()`、绝不改 finish reason。
                                            if (proseLoopGuard !== undefined) {
                                                if (proseLoopGuard.observe(delta.content))
                                                    proseLoopDetected = true;
                                            }
                                            // `</think:hex>` 泄漏探测（跨帧，收尾再切分）。
                                            if (!proseHasThinkTag && delta.content.includes('think:'))
                                                proseHasThinkTag = true;
                                            if (!proseLoopDetected) {
                                                block.text += delta.content;
                                                yield { type: 'text-delta', index: block.index, text: delta.content };
                                            }
                                        }
                                        if (delta.reasoning_content !== undefined) {
                                            // 死循环守卫：命中后不再累积、不再发射。
                                            //
                                            // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` +
                                            // `break`）在本 chunk 的行循环**全部处理完之后**、外层
                                            // `for (;;)` 末尾执行（见下方 ★ 止损块）—— 这样同一 chunk
                                            // 里已到达的 `token_usage` / `done` 仍会被处理。
                                            //
                                            // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：
                                            // 它会连带跳过本帧位于 reasoning 分支**之后**的处理。
                                            // 本 provider 的 `usage` 走**独立** `token_usage` 事件、
                                            // 不在此帧内，故被丢的是**同帧的 `tool_calls`**（一个
                                            // `output` 事件确实可能同时携带两者，实测复现）。故用
                                            // `if (!loopDetected)` 守卫分支体。
                                            if (loopGuard !== undefined) {
                                                if (loopGuard.observe(delta.reasoning_content))
                                                    loopDetected = true;
                                            }
                                            if (!loopDetected) {
                                                // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
                                                // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
                                                const emit = suppressor.feed(delta.reasoning_content);
                                                if (emit !== undefined) {
                                                    let block = blocks.find(c => c.kind === 'reasoning');
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
                                        if (delta.tool_calls !== undefined) {
                                            const calls = delta.tool_calls;
                                            for (const call of calls) {
                                                const wireIndex = typeof call.index === 'number' ? call.index : 0;
                                                if (typeof call.id === 'string' && call.id.length > 0)
                                                    toolIds.set(wireIndex, call.id);
                                                const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
                                                let block = toolCalls.get(wireIndex);
                                                if (block === undefined) {
                                                    block = { index: nextIndex++, text: '', callId, announced: false };
                                                    toolCalls.set(wireIndex, block);
                                                }
                                                block.callId = callId;
                                                const callFn = call.function;
                                                const fn = typeof callFn === 'object' && callFn !== null ? callFn : undefined;
                                                if (fn !== undefined && typeof fn.name === 'string' && fn.name.length > 0) {
                                                    block.name = fn.name;
                                                }
                                                const fragment = fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : '';
                                                block.text += fragment;
                                                // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` /
                                                // `buddy-adapter.ts` 同因同修）。只跳过收尾的 `block-end`
                                                // 不够 —— `BlockAssembler` 会把没有 block-end 的 partial
                                                // 也组装成 `name:''`，污染会话后让下游端点以 400 拒绝请求。
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
                                        }
                                    }
                                    break;
                                }
                                case 'token_usage': {
                                    if (ev.usage !== undefined) {
                                        const promptTokens = typeof ev.usage.prompt_tokens === 'number' ? ev.usage.prompt_tokens : 0;
                                        const completionTokens = typeof ev.usage.completion_tokens === 'number' ? ev.usage.completion_tokens : 0;
                                        const reasoningTokens = typeof ev.usage.reasoning_tokens === 'number' ? ev.usage.reasoning_tokens : undefined;
                                        yield {
                                            type: 'usage',
                                            usage: {
                                                inputTokens: promptTokens,
                                                outputTokens: completionTokens,
                                                ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
                                            },
                                        };
                                    }
                                    break;
                                }
                                case 'done':
                                    if (ev.finishReason !== undefined) {
                                        finishReason = ev.finishReason;
                                    }
                                    streamEnded = true;
                                    break;
                                case 'error': {
                                    // 上游 event:error → 作为业务错误抛出
                                    // 如果是配额/plan 限流等可换号的错误，不应该走到这里（错误响应走 HTTP 400+ 路径）
                                    // 但如果流内出现 error，按不可重试处理
                                    if (ev.errorCode !== undefined && ev.errorMessage !== undefined) {
                                        throw new LlmError(traeStreamErrorMessage(ev.errorCode, ev.errorMessage, options.model), ev.errorCode === 1005 || ev.errorCode === 4008 ? 'QUOTA_EXCEEDED' : 'SERVER');
                                    }
                                    break;
                                }
                            }
                        }
                        continue;
                    }
                    // 行处理
                    const trimmed = line.trim();
                    if (trimmed.startsWith('event:')) {
                        currentEvent = trimmed.slice(6).trim();
                    }
                    else if (trimmed.startsWith('data:')) {
                        currentData += trimmed.slice(5); // SOLO data 可能会跨行拼接
                    }
                    // 注释行（":"）或其他忽略
                }
                // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
                // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
                // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
                //
                // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
                // 的 `token_usage` / `done` 事件因此仍会被处理，但命中后**立即**退出，
                // 不再读下一块。
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
        // ── 空响应判定（可重试信号）──
        //
        // 一个上游事件都没收到 = 上游静默结束事件流，属于**可重试的瞬时故障**，
        // 不是「模型决定不说话」。抛 TRANSPORT 让 DSH 的常规重试机制接管，
        // 同时保留精确原因（CN 项目同样把该情形归类为 retryable empty response）。
        //
        // 注意：这里**不能**改成返回一个空的正常 finish —— 那会让用户看到
        // 「模型回复为空」这种毫无线索的结果，且不会触发任何重试。
        if (!sawAnyUpstreamEvent) {
            throw new LlmError('trae: upstream returned no events (empty response before first model event)', 'TRANSPORT');
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
         *
         * ⚠️ 上方 `!sawAnyUpstreamEvent` 的 TRANSPORT 抛错**先于**本判据：
         * 「一个上游事件都没收到」是更具体的可重试信号，不该被泛化的零块判据
         * （EMPTY_RESPONSE）覆盖 —— 与 `kind !== 'stop'` 不改写同一条道理。
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
                    arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text),
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
            // 正文死循环截断：只保留循环前的干净前缀。
            // ⚠️ **不改 finish reason**：工具调用仍要被执行。
            const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
                ? textOut.slice(0, proseLoopGuard.cutAt)
                : textOut;
            // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
            const cleaned = stripCourseLeakIfEnabled(truncated);
            // ⚠️ 归位后正文可能为空串 —— 空块会污染会话，且 DSH 的
            // `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，故仍有产出。
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
        // 丢弃了无名 tool-call 且没有留下任何可用调用时，报 max-tokens 而非 stop ——
        // 否则模型本意调工具、harness 却认为「正常答完了」（无报错中断）。
        const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text));
        const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced);
        const reason = loopDetected
            // 思考死循环：截断并报可重试。**优先级最高** —— 循环中生成的工具调用
            // 参数不可信；且若无可用调用，落到 `stop` 会让任务静默中断。
            ? { kind: 'max-tokens' }
            : finishReason === 'length'
                || (finishReason === undefined && toolOrder.length > 0)
                || argsTruncated
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
}
/**
 * 请求体历史字符上限。
 *
 * ## 为什么必须有（对齐 `Trae2api-cn` 的实测结论）
 *
 * 上游在 query 超过约 **500K 字符**时会**静默结束事件流** —— 不报错、不返回
 * 错误码，流就那么断掉。这是最难排查的一类失败：日志里看到的是「模型没有
 * 回复」，而不是任何 4xx/5xx。CN 项目为此设了两道闸门：
 * `TRAE_REMOTE_MAX_HISTORY_CHARS=480000`（压缩阶段）与
 * `TRAE_REMOTE_QUERY_MAX_CHARS=480000`（扁平化 query 的硬上限）。
 *
 * 这里取其**下沿**并在裁剪后仍可能超限时兜底，避免请求打到那个静默阈值。
 * 可通过 `DSH_TRAE_MAX_HISTORY_CHARS` 覆盖。
 */
function resolveMaxHistoryChars() {
    const raw = Number.parseInt(process.env.DSH_TRAE_MAX_HISTORY_CHARS ?? '', 10);
    if (Number.isFinite(raw) && raw > 0)
        return raw;
    return 480_000;
}
/** 估算一条 wire 消息的字符体量（按 JSON 序列化长度）。 */
function wireMessageSize(message) {
    try {
        return JSON.stringify(message).length;
    }
    catch {
        return 0;
    }
}
/**
 * 把 wire 消息裁剪到字符预算以内。
 *
 * ## 三条不可违反的约束
 *
 * 1. **从最早的非系统消息开始丢**，最近的历史（尤其本轮工具结果）必须保住 ——
 *    丢尾部会让模型丢失当前任务上下文，比丢开头更糟。
 * 2. **绝不切断 tool_call / tool 配对**：`tool` 消息必须紧跟其 `tool_calls`
 *    所在的那条 assistant 消息。丢一半会被上游以 400 拒绝整个请求，所以这里
 *    以「轮」为单位裁剪 —— 带 `tool_calls` 的 assistant 连同其后连续的
 *    `tool` 结果一起处理。
 * 3. **system 消息永不裁剪**（无论它出现在哪个位置），它是行为约束，
 *    丢了比丢历史更危险。
 *
 * 已经是 OpenAI wire 形状的消息（本函数只接受 `serializeTraeMessages` 的产物）。
 *
 * @param messages 已序列化的 wire 消息（system 已并入）
 * @param maxChars 字符预算（默认 480000）
 */
function trimTraeHistory(messages, maxChars = resolveMaxHistoryChars()) {
    let total = messages.reduce((sum, message) => sum + wireMessageSize(message), 0);
    if (total <= maxChars)
        return messages;
    // ── 1. 先切成「可丢弃的轮次」与「不可丢弃的 system」──
    //
    // 不假设 system 都在开头：历史里可能夹着 system（如 developer 角色被归一化）。
    // 用显式的 keep 标记逐条判断，而不是靠下标切片 —— 后者在 system 不连续时会
    // 错位。
    const drop = new Set();
    let index = 0;
    while (index < messages.length && total > maxChars) {
        if (messages[index].role === 'system') {
            index += 1;
            continue;
        }
        // 收集本轮：本条 + 其后连续的 tool 结果。
        const roundStart = index;
        let roundEnd = index + 1;
        if (Array.isArray(messages[index].tool_calls) && messages[index].tool_calls.length > 0) {
            while (roundEnd < messages.length && messages[roundEnd].role === 'tool')
                roundEnd++;
        }
        for (let cursor = roundStart; cursor < roundEnd; cursor++) {
            drop.add(cursor);
            total -= wireMessageSize(messages[cursor]);
        }
        index = roundEnd;
    }
    // 裁剪后仍超限（例如单条 system 提示就超预算）：不再继续丢 —— 继续丢只会把
    // 请求变成空内容，同样失败且更难诊断，交由上游定夺。
    return messages.filter((_, position) => !drop.has(position));
}
/**
 * 在 `ctx.llm` 上注册 TRAE provider 路由与适配器。
 */
export function registerTraeLlm(ctx, options) {
    const product = options.product ?? TRAE;
    ctx.llm.registerConfigurableProviders([
        {
            provider: product.id,
            displayName: product.displayName,
            // 0.1.7 起 settings 命名空间只能是 profile 条目 id（见 settingsNamespaceFor）。
            settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
            settingsPath: [],
        },
    ]);
    const adapter = new TraeAdapter(options);
    ctx.llm.registerAdapter([product.id], adapter);
    // 返回实例：Jet Hub 的「显示列表」需要它的 `listAllModels()`（不受用户黑名单
    // 影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 不透传自定义方法，
    // 故必须由调用方持有引用。
    return adapter;
}
//# sourceMappingURL=trae-adapter.js.map