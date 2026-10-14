/**
 * Accio（阿里 Accio Work）LLM 适配器。
 *
 * 骨架取自 `src/trae-adapter.ts` / `src/lobsterai-adapter.ts`（`LlmAdapter` 子类 +
 * `createModelCatalog` 共享目录骨架 + `prepareCall` 包装），但**协议层完全不同**：
 *
 * | 项 | Accio | Trae / LobsterAI |
 * |---|---|---|
 * | 信封 | Gemini 风格（`contents` / `parts` / `system_instruction`），键 **snake_case** | OpenAI 风格 |
 * | 鉴权 | **token 在 body**（放 `Authorization` 头恒流内 402） | Bearer / Cloud-IDE-JWT |
 * | 响应 | 顶层 `content.parts[]` + `thought` 标记 | OpenAI SSE / SOLO 自定义事件 |
 * | 签名 | **不需要**（实测不带 `pctb-x-*` 同样 200） | 无 / WASM 加密 |
 *
 * ## 复用边界
 *
 * - 帧归一化与消费：`src/accio-messages.ts` 的 `consumeAccioSse`（内部复用
 *   `consumeGeminiSse`）。本文件**不重写** SSE 解析。
 * - 目录解析：`normalizeAccioModel` / `parseAccioCatalog` 的**唯一实现**在
 *   `src/accio-auth.ts`，本文件只 `import` 并**再导出**（兼容导入路径）——
 *   「同一语义两套判据」是本仓库首条红线。
 *
 * ## ⚠️ 三处**实测**修正（2026-10-13，真实凭据，唯一变量对照）
 *
 * 1. **`system_instruction` 必须是字符串**（⚠️ **源头已修**，本条只留作背景）。
 *    `buildAccioBody` **初版**产出 Gemini 风格对象 `{parts:[{text}]}`，实测**恒**回
 *    `HTTP 200 + 流内 {"error_code":"400","error_message":"Invalid request format"}`；
 *    同一文本改成字符串则 200。官方客户端 proto 里该字段本就是 `string`。
 *    ⚠️ 该纯函数已由 **commit `3034d03`** 修正为直接产出**字符串**，
 *    `tests/unit/accio-product.spec.ts` 也同步锁定**字符串**形态。
 *    ⇒ {@link AccioAdapter.stream} 里对 `system_instruction` 的改写**保留为
 *    纵深防御**（不改写也正确；把「wire 上该键必为字符串」这条硬约束显式写在
 *    适配器里，纯函数或上游形状若再次漂移仍能兜住）。**刻意不删。**
 *
 * 2. **工具调用是分片的，且共享消费者不合并**。上游把**一次**调用拆成多帧
 *    （首帧 `{id,name}` 无参数，后续帧**重复完整的** `args_json`）。
 *    `consumeAccioSse` 对每个 `functionCall` part 各产出一个**独立**的
 *    tool-call 块 ⇒ 一次调用会变成 N 个块（首个参数 `{}`），harness 会
 *    **执行 N 次**。合并职责归适配器（设计如此）⇒ 见
 *    {@link accioToolCallMergeTransform}。
 *
 * 3. **思考关不掉**。`includeThoughts` / `thinkingBudget` / `thinkingLevel` /
 *    `reasoningEffort` 四类字段逐格实测：思考字符数**一个都没变**
 *    （`reasoningEffort=off` 甚至回 505）。⇒ 会话命名只能走
 *    `planSessionTitleThinking` 的**抬预算**兜底（issue IKKVDH）。
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { createModelCatalog } from './model-catalog.js';
// ⚠️ 对外 id 的归一规则**必须与聚合共用**（见 `accioModelIdOf` 的注释）。
import { normalizeNameKey } from './canonical-models.js';
import { RemoteCatalogGate } from './remote-catalog-gate.js';
import { broadcastCatalogChanged } from './catalog-broadcast.js';
import { registerAdapterIdempotent } from './llm-register-compat.js';
import { reportLedgerAccount } from './token-ledger.js';
import { planSessionTitleThinking } from './session-title.js';
import { ACCIO, ACCIO_LLM_PATH, ACCIO_REQUEST_TIMEOUT_MS, } from './accio-product.js';
import { accioHeaders, accioRequestId, accioSgK, buildAccioBody, isAccioExpired, } from './accio.js';
import { consumeAccioSse, serializeAccioMessages, toAccioTools } from './accio-messages.js';
import { normalizeHarnessMessages } from './message-shape.js';
// ⚠️ 图片守卫必须复用**共享的递归收集器**（它按 `tool-result` 递归下钻）——
// 本仓库其余适配器（buddy / lobsterai / trae / gemini / cline / qoder / …）全部走它，
// 不在这里手写第三份判据（「同一语义两套判据」是首条红线）。
import { collectImages } from './openai-compat.js';
import { resolveToolPairing } from './sse.js';
// ⚠️ 目录解析的**唯一实现**在 `accio-auth.ts`（`AccioAuth.fetchModels` 用的就是它们）。
// 本文件只再导出，**不写第二份** —— 否则就是本仓库红线「同一语义两套判据」。
import { normalizeAccioModel, parseAccioCatalog } from './accio-auth.js';
export { normalizeAccioModel, parseAccioCatalog };
/** 本适配器注册的 provider 路由名。 */
export const ACCIO_PROVIDER = 'accio';
/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ 与 `ACCIO_REQUEST_TIMEOUT_MS`（30s，整个请求的上限）**不是一回事**：
 * 这里是「多久没有新字节就认定流卡死」。上游生成大工具参数期间可能长时间不
 * flush，裸 `reader.read()` 会无限期挂起（症状「发消息后永远转圈」）。
 * 归 `TIMEOUT`（可重试）。
 */
export const ACCIO_SSE_IDLE_TIMEOUT_MS = 120_000;
/**
 * 进程内稳定的 `utdid`（设备标识）兜底值。
 *
 * ⚠️ **实测上游不校验它**：真机值、自造值、完全不带、空串四种情况下
 * 上游都返回正常内容帧。故一个进程内稳定的本地值即可满足协议形状。
 * Task 7 的接线层可从 `~/.accio/utdid` 注入真实值（`options.utdid`）。
 *
 * 形状对齐实测值（24 字符、base64url 字符集）。
 */
const FALLBACK_UTDID = `accio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
/**
 * 把 `modelDisplayName` 与**计费倍率**拼成展示名：`模型名 · x倍率`。
 *
 * ## 为什么倍率必须进 `name`（不是 `description`）
 *
 * composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读）——
 * 倍率写进 description 等于没写。倍率跨度 0.013 ~ 2.8（**215 倍**），
 * 是用户选型时最重要的信号。
 *
 * ## 三条边界
 *
 * - **倍率 1 照拼**（`1` 不是「无」）；
 * - **倍率 0 照拼**（免费是**合法**倍率，与「没有倍率信息」语义不同，
 *   故判据必须是 `!== undefined` 而不是真值判断）；
 * - **非有限值不拼**（不产出 `xNaN` / `xInfinity`）。
 *
 * 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`。
 */
export function displayNameOfAccioModel(model) {
    const multiple = model.multiple;
    if (multiple === undefined || !Number.isFinite(multiple))
        return model.name;
    return `${model.name} · x${multiple}`;
}
/**
 * 把一个 accio 模型条目映射成 DSH 的**思考档位声明**；无可声明时返回 `undefined`。
 *
 * ## ⚠️ 核心判据：`efforts` 为空但 `defaultEffort` 有值时，也要**声明一档**
 *
 * 用户要求原文：「需要有档位**即使是只有一档也要显示**，使用远端真实下发的档位」。
 *
 * 远端实测（38 条）：只有 7 条给了 `reasoningEfforts` 数组；而 **5 条只给了
 * `defaultReasoningEffort`、数组是 `null`**（GLM-5.3 `max` / GLM-5.2 `max` /
 * GLM 5.3 Flash `max` / DeepSeek V4.1 Flash `high` / DeepSeek V4 Pro `high` /
 * MiniMax M3 `adaptive`）。⚠️ 这几个的 default **实测发过去服务端接受**
 * （`max` 与 `adaptive` 都 ✅ 返回正常正文）⇒ 它就是一个**真实可用的档位**。
 *
 * ⇒ 三格判据（**顺序不可换**）：
 *
 * | 形态 | 声明 |
 * |---|---|
 * | `efforts` 非空 | 全部档位；`defaultEffort` **落在集合内才带**（DSH 会校验，指到集合外会抛 `UNSUPPORTED_REASONING_EFFORT`） |
 * | `efforts` 空、`defaultEffort` 有值 | **单档**（就声明那一个） |
 * | 两者都无 | **不声明**（`undefined`）—— 编造档位 = 让用户选一个服务端不认的值 |
 *
 * ## 显示名
 *
 * ⚠️ **原样用上游的档位 id 当 `name`**，不做「low→低」这类翻译：
 * - 这些 id 是**服务端认的字面量**（要原样回发），译成中文会让用户
 *   在排查时对不上日志；
 * - 本仓库既有先例：`cline` 的档位用 `CLINE_REASONING_EFFORTS` 的**固定英文名**
 *   （`Low` / `Medium` / …）—— 名字属于**展示层契约**，而 accio 的 id 本身
 *   已经是可读英文，无需再造一份映射表（造了就有「两处判据」腐坏风险）。
 */
export function accioReasoningOf(model) {
    const declared = model.efforts ?? [];
    const fallback = model.defaultEffort;
    // ── 格 1：远端给了档位数组（可能同时给 default） ──
    if (declared.length > 0) {
        return {
            efforts: declared.map((id) => ({ id: ReasoningEffortId(id), name: id })),
            // ⚠️ `defaultEffort` **必须落在 `efforts` 内**才带：DSH 会校验，
            //    指到集合外会让整条记录的档位声明被丢弃（`model-catalog.ts` 里那段
            //    `legal` 检查）—— 那不是崩溃，但会让「默认档」静默消失。
            ...fallback !== undefined && declared.includes(fallback)
                ? { defaultEffort: ReasoningEffortId(fallback) }
                : {},
        };
    }
    // ── 格 2：只有 default（数组是 null）⇒ **单档**（用户要求的「只有一档也要显示」）──
    if (fallback !== undefined) {
        return {
            efforts: [{ id: ReasoningEffortId(fallback), name: fallback }],
            defaultEffort: ReasoningEffortId(fallback),
        };
    }
    // ── 格 3：两者都无 ⇒ 不声明（不编造） ──
    return undefined;
}
/**
 * 一个 accio 模型条目的**对外 id**（DSH 目录里的 `id`，也是注入给模型的身份）。
 *
 * ## 为什么必须是「人话」（用户要求，2026-10-13）
 *
 * 用户追问（附模型自报截图）：「为什么现在还是回复中的模型不是标准模型 id」。
 *
 * 上游 `modelCode` 形如 `1Drift-F8hS3mK7pL2n` —— **故意不可读**的内部代号，
 * 真名只在 `modelDisplayName` 里。而 DSH 把 `CatalogEntry.id` 注入给模型当身份
 * ⇒ 模型只能自报一串乱码（它自己也无从知道那是哪个基座）。
 *
 * ⇒ 对外 id 改用**展示名归一后的 slug**（`qwen-3-8-flash`）。
 *
 * ## ⚠️ 与聚合**共用同一套归一规则**
 *
 * 用 `normalizeNameKey`（`canonical-models.ts`），**不自己写第二份**：
 * 聚合的规范键就是这么算的，两处若各写一份必然漂移 —— 而漂移的后果是
 * 「直连看到的 id」与「聚合里的键」对不上，用户无法把两处对应起来。
 *
 * ## ⚠️ 兜底：归一后为空时回退原始 id
 *
 * 展示名可能是空白 / 只由分隔符组成（`'·'`）⇒ 归一后得空串 ⇒ 若原样返回，
 * DSH 的目录校验会因**空 id** 抛 `INVALID_CATALOG`，**整个 provider 不可用**。
 * ⇒ 宁可回退成一个不可读但非空的 id（与改造前行为一致），也不产出空串。
 */
export function accioModelIdOf(model) {
    const slug = normalizeNameKey(model.name);
    return slug === '' ? model.id : slug;
}
/**
 * 由**对外 slug** 反查上游 `modelCode`（上行请求必须用它）；查不到则**原样返回**。
 *
 * ⚠️ **上行绝不能发 slug**：Accio 的推理端点只认 `modelCode`，发 slug 会请求打空，
 * 而症状是「模型不回复」这种极具误导性的形态。
 *
 * ⚠️ **查不到时原样返回入参**（不抛错、不返回空串）：
 * - 用户可能手填一个 id（DSH 允许），此时应由**上游**报错，而不是在这里
 *   静默变成空模型名（那会让请求发到一个空 `model` 字段）；
 * - 抛错则会把这个未知 id 变成一次**本地失败**，掩盖上游的真实错误信息。
 */
export function accioModelCodeOf(models, slug) {
    const hit = models.find((model) => accioModelIdOf(model) === slug);
    return hit === undefined ? slug : hit.id;
}
/** 把内容载荷展平为纯文本（与 `accio-messages.ts` 的 `flattenText` 同口径）。 */
function contentToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('');
}
/**
 * 把 **DSH 原生消息块** 转成 `serializeAccioMessages` 认得的 **OpenAI 传输形状**。
 *
 * ## 为什么必须有这一层（真实缺陷，本任务的测试当场抓到）
 *
 * `serializeAccioMessages`（Task 3）是按 **OpenAI 形状**实现的：
 * 它读 `message.tool_calls[]`（`{id, function:{name,arguments}}`）与
 * `message.tool_call_id` / `message.name`。而 DSH 交给适配器的是**原生块**：
 *
 * ```jsonc
 * { "role": "assistant", "content": [{ "type": "tool-call", "id": "c1", "name": "read_file", "arguments": "…" }] }
 * { "role": "tool", "toolCallId": "c1", "content": "…" }        // 0.1.7 一等消息
 * ```
 *
 * 直接把原生块喂进去的后果是**全字段静默丢失**（实测）：
 * `tool_calls` 不存在 ⇒ 一个 `functionCall` 都不产出；`tool_call_id` 不存在 ⇒
 * `functionResponse.id` 落成空串、`name` 也落成空串 —— 而 Accio 的
 * `functionResponse` **按 name 配对**，空 name 的响应等于把工具结果丢掉。
 *
 * 这与 `trae-adapter.ts` / `lobsterai-adapter.ts` 的 `serializeMessages`
 * 是**同一步骤、同一原因**（那两家的注释里记着同一个真实缺陷）。
 *
 * ## 两条既有防线必须保留
 *
 * 1. **入口先 `normalizeHarnessMessages`**（DSH 0.1.7 把工具结果改为一等
 *    `role:'tool'` 消息）—— 漏掉它 `tool-result` 判据恒不命中，
 *    `resolveToolPairing` 会把 assistant 的 `tool_calls` **整体剔除**；
 * 2. **孤儿工具调用/结果必须剔除**（上游对无法配对的条目回 400）。
 */
export function toAccioWireMessages(messages) {
    const normalized = normalizeHarnessMessages(messages);
    const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
    // ⚠️ 先扫全消息建 `tool-call id → name` 映射：上游的 `functionResponse`
    // **按 name 配对**（`serializeAccioMessages` 读 `message.name`），而 0.1.7 的
    // 一等 `tool` 消息**不带 name** —— 不建这张表就永远回填不出工具名。
    const toolNames = new Map();
    for (const message of normalized) {
        if (!Array.isArray(message.content))
            continue;
        for (const block of message.content) {
            const b = block;
            if (b !== null && typeof b === 'object' && b.type === 'tool-call') {
                toolNames.set(String(b.id), String(b.name ?? ''));
            }
        }
    }
    const wire = [];
    for (const message of normalized) {
        if (message.role === 'assistant') {
            const content = Array.isArray(message.content) ? message.content : [];
            const toolCalls = content
                .filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-call')
                .filter((block) => keepCallIds.has(String(block.id)))
                .map((block) => ({
                id: String(block.id),
                type: 'function',
                function: {
                    name: String(block.name),
                    // ⚠️ 必须是**原始参数串**（`serializeAccioMessages` 原样透传成 `argsJson`）。
                    arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
                },
            }));
            wire.push({
                role: 'assistant',
                content: contentToText(message.content),
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        if (message.role === 'system') {
            wire.push({ role: 'system', content: contentToText(message.content) });
            continue;
        }
        // user / tool 角色：工具结果搭载在 user 消息里（0.1.5 形状）或是一等消息（0.1.7，
        // 已被归一化层降级），此处统一展开为独立的 `role:'tool'` 传输消息。
        const content = Array.isArray(message.content) ? message.content : [];
        const toolResults = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-result');
        const text = contentToText(message.content);
        if (text.length > 0 || toolResults.length === 0)
            wire.push({ role: 'user', content: text });
        for (const result of toolResults) {
            const id = String(result.toolCallId);
            // 丢弃孤儿工具结果（没有对应 tool_call 同样会被上游拒绝）。
            if (!keepResultIds.has(id))
                continue;
            wire.push({
                role: 'tool',
                tool_call_id: id,
                // ⚠️ **name 必须回填**：Accio 的 `functionResponse` 按 name 配对。
                name: toolNames.get(id) ?? '',
                content: contentToText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
/** 安全读取 `Error.message`。 */
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
/** 传输级错误判定（网络抖动，归可重试的 `TRANSPORT`）。 */
function isTransportError(error) {
    if (!(error instanceof Error))
        return false;
    const message = error.message.toLowerCase();
    if (error.name.startsWith('UND_ERR_'))
        return true;
    if (message.includes('fetch failed'))
        return true;
    if (message.includes('terminated') || message.includes('econnreset'))
        return true;
    if (message.includes('epipe') || message.includes('socket hang up'))
        return true;
    return false;
}
/**
 * HTTP 状态码 → provider-neutral 错误码。
 *
 * ⚠️ **402 必须归 `QUOTA_EXCEEDED`**（不得归 `SERVER`）：`SERVER` 在 harness 的
 * `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` /
 * `TRANSPORT`）里 ⇒ 额度耗尽这种**确定性**失败会被原样重发 5 次（退避约 15.5 秒），
 * 每次都必然同样失败。这与 trae 的 4006 是同一类错误归因。
 */
function httpErrorCode(status) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 402)
        return 'QUOTA_EXCEEDED';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400)
        return 'INVALID_REQUEST';
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/** 从错误体里抠出可读 detail（**逐字保留服务端原文**，不吞）。 */
function errorDetail(body) {
    try {
        const data = JSON.parse(body);
        const parts = [
            typeof data.error_code === 'string' || typeof data.error_code === 'number'
                ? `error_code=${String(data.error_code)}` : undefined,
            typeof data.error_message === 'string' ? data.error_message : undefined,
            typeof data.code === 'string' || typeof data.code === 'number' ? `code=${String(data.code)}` : undefined,
            typeof data.message === 'string' ? data.message : undefined,
            typeof data.error === 'string' ? data.error : undefined,
        ].filter((value) => value !== undefined);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch { /* 非 JSON 错误体：原样返回 */ }
    return body;
}
/**
 * 把访问令牌写进请求体（**唯一**的 token 落点）。
 *
 * ## 为什么必须有这个函数（真实缺陷，本轮修复）
 *
 * Accio 的令牌走的是 **body 的 `token` 字段**（放 `Authorization` 头恒流内 402，
 * 见文件头），而 `send()` 只把 `credential` 用于 `sgcookie` **请求头**。
 * 于是「401/403 后刷新凭据再重试」这条分支原先**重发的是刷新前的旧 token**
 * —— 结构上不可能成功，`refresh()` 白烧一次 `refresh_token`
 * （AGENTS.md 记着同型事故：反复消费 `refresh_token` ⇒ `invalid_grant` ⇒ 账号被标死）。
 *
 * ⚠️ 更糟的是 harness 兜不住：`AUTH` **不在** `DEFAULT_RETRYABLE_CODES`
 * （`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）里，
 * 所以一个本可自愈的凭据会退化成**硬失败**。
 *
 * ## 为什么是「原地改一个键」而不是「重建 body」
 *
 * `message_id` 与 `request_id` 必须**逐字节不变**（它们是**一次逻辑请求**的身份；
 * 重建 body 会经 `accioMessageId()` 掺入新的随机量，等于换了请求身份）。
 * 故这里只覆盖 token 这一个字段，其余键（含 `properties` / `sg_k` 依赖的
 * `request_id`）原样保留。
 */
function applyAccessToken(body, accessToken) {
    body.token = accessToken;
}
/**
 * 合并一次工具调用的多个参数分片。
 *
 * ## 实测形状（2026-10-13，三轮取样，每次都是同一形态）
 *
 * ```
 * frame#8  {"function_call":{"id":"call_x","name":"read_file"}}                              ← 无参数
 * frame#9  {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * frame#10 {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * ```
 *
 * 即**首帧无参数、后续帧重复完整的参数**（不是增量、也不是逐帧增长）。
 * 但「重复全量」与「逐帧增长」在真机上都可能出现，故本函数两种都处理：
 *
 * 1. **累积式**（后一份以前一份为前缀）⇒ 取**最后一份**（它就是全量）；
 * 2. **增量式**（不是前缀关系）⇒ 把各片段**依次拼接**。
 *
 * 两条分支都不编造内容：全为空时返回空串，由调用方决定是否省略 `args_json`。
 */
export function mergeAccioToolArgs(fragments) {
    const nonEmpty = fragments.filter((fragment) => fragment !== '');
    if (nonEmpty.length === 0)
        return '';
    let cumulative = true;
    for (let i = 1; i < nonEmpty.length; i++) {
        if (!nonEmpty[i].startsWith(nonEmpty[i - 1])) {
            cumulative = false;
            break;
        }
    }
    if (cumulative)
        return nonEmpty[nonEmpty.length - 1];
    let merged = '';
    for (const fragment of nonEmpty) {
        // 已包含在累积值里（同一份全量重复）⇒ 直接替换；否则当作增量追加。
        merged = fragment.startsWith(merged) ? fragment : merged + fragment;
    }
    return merged;
}
/**
 * 把 Accio 的**分片**工具调用合并成「一次调用一帧」的 SSE 改写流。
 *
 * ## 为什么必须由适配器做（而不是共享消费者）
 *
 * `consumeAccioSse` → `consumeGeminiSse` 对每个 `functionCall` part 各产出一个
 * **独立且完整**的 tool-call 块（它把 `args_json` 一次性发完再关块，不做跨帧累积）。
 * 实测把上面的三帧喂进去得到 **3 个** tool-call 块，首个参数是 `{}`：
 *
 * ```
 * block-end {type:'tool-call', name:'read_file', arguments:'{}'}            ← 空参数
 * block-end {type:'tool-call', name:'read_file', arguments:'{"file_path":"a.txt"}'}
 * block-end {type:'tool-call', name:'read_file', arguments:'{"file_path":"a.txt"}'}
 * ```
 *
 * ⇒ 不合并的后果是 harness **执行同一个工具 N 次**（首个还带空参数）。
 *
 * ## 四条纪律
 *
 * 1. **只缓冲工具调用 part**：同一帧里的**非工具 part（正文 / `thought`）原样
 *    透传**，绝不丢 —— 上游确实会把 `text` 与 `function_call` 放在**同一帧**里
 *    （本函数的用例覆盖该形态）；整帧丢弃会**静默吞掉正文**。
 * 2. **流序**：flush 缓冲时把它排在**当前行之前** —— 工具调用仍出现在
 *    它后面那些帧（usage / finish）之前，与上游顺序一致；
 * 3. **按 `id` 分组**：不同 `id` 是不同调用，绝不误合并；
 * 4. **非 `data:` 行原样透传**（注释心跳、空行分隔符都不能丢）。
 *
 * ## ⚠️ 已知边界（如实登记，不改）
 *
 * 缓冲只在「遇到没有工具调用的帧」或流结束时 flush。若上游把**同一次**调用的分片
 * 与正文**交错**下发（`call(id)` → `text` → `call(id,args)`），中间的正文帧会触发
 * 一次提前 flush ⇒ 该调用会被拆成两块（首块无参数）。
 *
 * **实测未出现该形态**：三轮取样的分片帧都是**连续**到达的
 * （如 frame#13/#14/#15）。要彻底消除它必须把正文也缓冲到流结束 —— 那会**牺牲
 * 首字延迟**（TTFT）并让正文与思考的增量下发全部失效，代价远大于收益。
 * ⇒ 保留当前策略；若将来真机上观测到交错，应先取证再改。
 */
export function accioToolCallMergeTransform() {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    /** 本次待合并的调用：`id` → 已见到的参数片段（**保持首见顺序**）。 */
    const pending = new Map();
    /** 把已缓冲的调用拼成**一帧**交出去（无缓冲时是空操作）。 */
    const flushPending = (out) => {
        if (pending.size === 0)
            return;
        const parts = [];
        for (const entry of pending.values()) {
            const args = mergeAccioToolArgs(entry.fragments);
            parts.push({
                function_call: {
                    id: entry.id,
                    name: entry.name,
                    // ⚠️ 参数为空时**省略**该键（与上游「首帧无参数」同形），
                    // 不写空串 —— 那会让消费侧解析出一个空参数对象。
                    ...args === '' ? {} : { args_json: args },
                },
            });
        }
        pending.clear();
        out.push(`data: ${JSON.stringify({ content: { role: 'model', parts }, partial: true })}`);
    };
    /** 处理一行；把要交出的行推进 `out`。 */
    const handleLine = (line, out) => {
        if (!line.startsWith('data:')) {
            out.push(line);
            return;
        }
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') {
            flushPending(out);
            out.push(line);
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(payload);
        }
        catch {
            flushPending(out);
            out.push(line);
            return;
        }
        const frame = parsed;
        const parts = frame?.content?.parts;
        if (!Array.isArray(parts)) {
            flushPending(out);
            out.push(line);
            return;
        }
        const isCall = (part) => part !== null && typeof part === 'object'
            && part.function_call !== undefined;
        const callParts = parts.filter(isCall);
        // 本帧没有工具调用：把缓冲 flush 到**本行之前**，再原样交出本行。
        if (callParts.length === 0) {
            flushPending(out);
            out.push(line);
            return;
        }
        /**
         * ⚠️ **本帧混有非工具 part 时，必须把那些 part 原样发出**（真实缺陷，自审抓到）：
         * 上游会把 `text` 与 `function_call` 放进**同一帧**的 `parts` 里，
         * 整帧吸收进缓冲会**静默吞掉正文**（模型写的话凭空消失）。
         *
         * ⚠️ **顺序不可颠倒**：先发本帧的非工具 part，**再**把工具 part 收进缓冲。
         * 反过来（先 flush 再收）会把**同一个调用**拆成两个块 ——
         * 首帧 flush 出的那个还没有参数，正是本函数要消灭的形态。
         * 缓冲要等到「某个没有工具调用的帧」或流结束才 flush（见上面的提前 return）。
         */
        const otherParts = parts.filter((part) => !isCall(part));
        if (otherParts.length > 0) {
            out.push(`data: ${JSON.stringify({ ...frame, content: { ...frame.content, parts: otherParts } })}`);
        }
        for (const part of callParts) {
            const call = part.function_call;
            const id = typeof call.id === 'string' && call.id !== '' ? call.id : `anon-${pending.size}`;
            const name = typeof call.name === 'string' ? call.name : '';
            const args = typeof call.args_json === 'string' ? call.args_json : '';
            const entry = pending.get(id);
            if (entry === undefined)
                pending.set(id, { id, name, fragments: args === '' ? [] : [args] });
            else {
                if (name !== '')
                    entry.name = name;
                if (args !== '')
                    entry.fragments.push(args);
            }
        }
    };
    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            const out = [];
            for (const line of lines) {
                const trimmedEnd = line.endsWith('\r') ? line.slice(0, -1) : line;
                handleLine(trimmedEnd, out);
            }
            if (out.length > 0)
                controller.enqueue(encoder.encode(`${out.join('\n')}\n`));
        },
        flush(controller) {
            // ⚠️ 先刷解码器里的残留多字节序列，再处理余量 —— 否则跨 chunk 的
            // 最后一个字符（以及最后一条事件）会被丢弃。
            buffer += decoder.decode();
            const out = [];
            if (buffer !== '')
                handleLine(buffer, out);
            flushPending(out);
            if (out.length > 0)
                controller.enqueue(encoder.encode(out.join('\n')));
        },
    });
}
/**
 * Accio 模型适配器。
 */
export class AccioAdapter extends LlmAdapter {
    options;
    product;
    fetchImpl;
    utdid;
    /** 远端目录缓存（成功拉取后永久保留）。 */
    remoteModels;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
    catalogGate;
    /** 共享目录骨架（门控 → 读目录 → 黑名单 → 回填 → 三态）。 */
    catalog;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? ACCIO;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.utdid = options.utdid ?? FALLBACK_UTDID;
        this.catalogGate = new RemoteCatalogGate(options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded });
        this.catalog = createModelCatalog({ accountPool: options.accountPool }, {
            product: this.product,
            loadCatalog: () => this.loadCatalogEntries(),
            syncCatalog: () => this.syncCatalogEntries(),
            // ⚠️⚠️ **刻意不提供 `unknownModelInputModalities`**：未知 id 同样
            // **省略** `inputModalities`（= 未知）。理由见 `toCatalogEntry` 的长注释 ——
            // 本 provider 的图片通路未实测，写 `['text']` 就是把「未知」写成
            // 「明确不支持」（AGENTS.md 的静默失效格）。
        });
    }
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     */
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /** 懒加载远端模型目录（仅拉取一次；失败/空结果走闸门冷却）。 */
    async ensureRemoteModels() {
        const fetchRemote = this.options.fetchRemoteModels;
        if (this.remoteModels !== undefined || fetchRemote === undefined)
            return;
        await this.catalogGate.run(async () => {
            const models = await fetchRemote();
            if (models.length === 0)
                return false;
            this.remoteModels = models;
            return true;
        });
    }
    /**
     * 把本家条目转成共享骨架的中间结构。
     *
     * ## ⚠️⚠️ `inputModalities` 的三态决策（本文件最重要的一个判据）
     *
     * `normalizeAccioModel` 把上游的 `multimodal` 压成**二值**
     * （`supportsImage: row.multimodal === true`），于是 `false` **同时**表示
     * 「上游明确说 false」与「上游没有这个字段」—— 两种语义被折叠成一个布尔。
     *
     * 而 DSH 的 `inputModalities` 是**三态**：
     * - 数组 = 已知能力；
     * - **省略 = 未知**（交给宿主判断）；
     * - `['text']` = **明确声明不支持图片**（图片会被拒）。
     *
     * ### 本适配器的选择：**恒省略**（= 未知）
     *
     * 判据是**本 provider 的图片通路整体未实测**（`ACCIO_IMAGE_PIXEL_BUDGET` 只是
     * 预留的接入点，`serializeAccioMessages` 的 `flattenText` 也只保留 text 块）。
     * 在这种前提下：
     *
     * - 写 `['text','image']` 是**编造能力** —— 上游 `multimodal: true` 只说明
     *   **目录声明**，没有任何一次真实图片请求被验证过（设计 §10 的 U-D 未验证项）；
     * - 写 `['text']` 是**把「未知」写成「明确不支持」** —— 一旦将来接上图片通路，
     *   这个明确的否定会让 DSH 在**附件准入阶段**就拒掉图片，且症状是静默的
     *   （`buddy` 实测过同一形态：能力表拿不到就静默关掉图片能力）；
     * - **省略**是唯一诚实的编码：既不放行一个未验证的能力，也不断言一个未验证的否定。
     *
     * ⚠️ **代价是图片会走到适配器**（DSH 对「未知」不投影）—— 故
     * {@link AccioAdapter.stream} 在收到图片时**显式抛 `UNSUPPORTED_CONTENT`**，
     * 绝不静默丢弃（静默丢弃会让用户以为模型看到了图）。
     *
     * ⚠️ **不采用「读原始 row」的替代方案**：那要求适配器自己再解析一遍目录
     * （`fetchRemoteModels` 返回的已是归一化后的 `AccioFallbackModel`），
     * 等于在本文件重写第二份解析器 —— 本仓库首条红线。
     * 若将来接上图片通路，正确的改法是给 `AccioFallbackModel` 加一个**三态字段**
     * （在 `accio-auth.ts` 一处落地），而不是在这里开第二份解析。
     */
    toCatalogEntry(model) {
        const reasoning = accioReasoningOf(model);
        return {
            // ⚠️ **对外 id 是「人话」slug**（用户要求，2026-10-13）：上游 `modelCode`
            //    形如 `1Drift-…` 是内部代号，而 DSH 会把它注入给模型当身份 ⇒
            //    模型只能自报乱码。上行仍用 `modelCode`（见 `stream` 的 `accioModelCodeOf`）。
            id: accioModelIdOf(model),
            // 倍率写进 `name`（**不是** `description`）：composer 的模型切换菜单只渲染 name。
            name: displayNameOfAccioModel(model),
            // ⚠️ `resolveModel` 用**不带倍率**的裸名 ⇒ 显式提供 `bareName`。
            bareName: model.name,
            // ⚠️⚠️ 刻意**省略**（见上）：三态里的「未知」。
            ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
            ...model.maxTokens !== undefined && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
                ? { maxTokens: model.maxTokens }
                : {},
            ...reasoning === undefined ? {} : { reasoning },
        };
    }
    /** 本家全部条目（远端优先，未落地时回退兜底表）。 */
    catalogEntries() {
        const source = this.remoteModels ?? this.product.fallbackModels;
        return source.map((model) => this.toCatalogEntry(model));
    }
    async loadCatalogEntries() {
        await this.ensureRemoteModels();
        return this.catalogEntries();
    }
    /**
     * 同步视图（`listAllModels` 用）。
     *
     * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读缓存，
     * 未落地时回退兜底表（否则冷缓存下返回空数组，设置页会把 provider
     * 误显示成「已关闭」）。
     */
    syncCatalogEntries() {
        return this.catalogEntries();
    }
    async listModels(provider) {
        return this.catalog.listModels(provider);
    }
    async resolveModel(provider, model, signal) {
        return this.catalog.resolveModel(provider, model, signal);
    }
    /**
     * 全量目录（**不套用户黑名单**），带最终展示名（含倍率）。
     *
     * 设置页必须能渲染已关闭的模型（否则用户无法重新打开），而 `listModels`
     * 会按黑名单过滤掉它们 ⇒ RPC 层只能凭裸 id 补回、展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。
     */
    listAllModels() {
        return this.catalog.listAllModels();
    }
    /**
     * 兼容 0.1.1-rc.2+：`LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`。**必须包它**（PR !66 的教训：
     * 包装适配器时漏了 `prepareCall` 会让凭据续期 / 模型解析走偏，
     * 且记账包装也会静默失效）。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        // 1. 图片：本 provider 的通路**未实测**，故 `inputModalities` 是省略（未知）
        //    ⇒ DSH 不会在附件准入阶段拦下图片，图片会走到这里。
        //    ⚠️ **必须显式报错**：`serializeAccioMessages` 的 `flattenText` 只保留
        //    `type === 'text'` 的块，静默放行等于把图片**静默丢掉**
        //    （用户以为模型看到了图）—— 与本函数承诺的「绝不静默丢弃」直接矛盾。
        //
        //    ⚠️⚠️ **扫描必须递归**（真实缺陷，本轮修复）：`normalizeHarnessMessages`
        //    刻意**整体保留** `content` 数组，而 `tool-result` 块的 `content` 里
        //    可以内嵌 `image`（本仓库其余适配器都按该形状收图）。只扫**顶层**
        //    `message.content` 会让这种嵌套图片**绕过守卫**，然后被 `flattenText`
        //    悄悄丢掉 —— 守卫形同虚设。
        //    ⇒ 复用共享的 `collectImages`（`src/openai-compat.ts`），它按
        //    `tool-result` **递归下钻**，与 buddy / lobsterai / trae / gemini /
        //    cline / qoder / raccoon / minimax / zcode 同一实现（不手写第二份判据）。
        const imageRefs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, imageRefs);
        }
        if (imageRefs.size > 0) {
            throw new LlmError('accio: 本 provider 的图片通路尚未实测，暂不支持图片输入', 'UNSUPPORTED_CONTENT');
        }
        /**
         * 1b. ⚠️⚠️ **`options.model` 是「人话」slug，上行的 body 必须用上游 `modelCode`**。
         *
         * 对外 id 自 2026-10-13 起是 slug（`qwen-3-8-flash`），因为 DSH 把
         * `CatalogEntry.id` 注入给模型当身份 —— 用上游代号会让模型只会自报乱码
         * （用户追问「为什么不是标准模型 id」）。
         *
         * ⚠️ 但**上游只认 `modelCode`** ⇒ 这里必须映射回去。漏了这一步的后果：
         * 请求体带上 slug、服务端不认，症状是「模型不回复」这种**极具误导性**的形态
         * （不是参数错误）。故本行是**功能承重**，不是装饰。
         *
         * ⚠️ 未知 id **原样透传**（`accioModelCodeOf` 的语义）：用户手填的 id 应由
         * 上游报错，本地不得静默改成空模型名。
         */
        const sourceModels = this.remoteModels ?? this.product.fallbackModels;
        const wireModel = accioModelCodeOf(sourceModels, options.model);
        // 2. 凭据（过期则先静默续期）。
        // ⚠️ 传 `options.model`：多账号池按它过滤限流账号（与 trae 同因）。
        let credential = await this.options.resolveCredential(options.model);
        if (credential === undefined || isAccioExpired(credential)) {
            await this.options.refresh();
            credential = await this.options.resolveCredential(options.model);
        }
        if (credential === undefined || credential.access_token === '') {
            throw new LlmError('accio: no usable credential; log in first', 'MISSING_CREDENTIAL');
        }
        // 3. 记录当前账号（Token 账本用；失败不影响请求）。
        if (this.options.accountPool !== undefined) {
            try {
                const accountId = await this.options.accountPool.findAccountIdByCredential(this.product.id, credential.access_token);
                if (accountId !== '')
                    reportLedgerAccount(this.product.id, accountId);
            }
            catch { /* 账号不匹配不影响请求 */ }
        }
        // 4. 会话命名的思考与预算决策（issue IKKVDH）。
        // ⚠️ Accio **关不掉思考**（实测四类字段全部无效，见文件头第 3 条）⇒
        // `declaredEfforts` 恒为空 ⇒ 走 `planSessionTitleThinking` 的**抬预算**分支
        // （64 → 512），否则思考会把 64 token 吃满、正文零产出、标题静默失败。
        const titlePlan = planSessionTitleThinking({
            purpose: options.purpose,
            requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
            declaredEfforts: [],
            maxTokens: options.maxTokens,
        });
        // 5. 构造信封。
        //
        // ⚠️ **必须先经 `toAccioWireMessages`** 把 DSH 原生块转成 OpenAI 传输形状：
        // `serializeAccioMessages` 读的是 `tool_calls[]` / `tool_call_id` / `name`，
        // 原生块里这三个字段一个都不存在（见该函数的说明 —— 后果是工具调用与
        // 工具结果**全字段静默丢失**）。
        const requestId = accioRequestId();
        const wireMessages = toAccioWireMessages(options.messages);
        /**
         * ⚠️ `options.system` 是 `GenerateOptions` 的**独立字段**，不在 `messages` 里。
         * `serializeAccioMessages` 只从 messages 里抽 system ⇒ 不显式插进去，
         * system prompt 会被**整体静默丢弃**（模型收不到任何系统指令）。
         */
        if (options.system !== undefined && options.system !== '') {
            wireMessages.unshift({ role: 'system', content: options.system });
        }
        const { contents, systemInstruction } = serializeAccioMessages(wireMessages);
        const body = buildAccioBody({
            // ⚠️ **上行用 `wireModel`（= 上游 `modelCode`），不是 `options.model`（slug）** ——
            //    见上面 1b 的说明。这是本次改动最容易漏、且后果最隐蔽的一处。
            model: wireModel,
            accessToken: credential.access_token,
            contents,
            systemInstruction,
            // ⚠️ `toAccioTools` 同样吃 **OpenAI 形状**（`{type:'function',function:{…}}`），
            // 而 DSH 给的是**扁平** `ToolSchema`（`{name,description,parameters}`）——
            // 不包一层会得到 `undefined`（工具一个都不下发）。
            tools: toAccioTools((options.tools ?? []).map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            }))),
            ...options.temperature === undefined ? {} : { temperature: options.temperature },
            // ⚠️ `maxOutputTokens` **必须下发**（不能只用来过滤）。
            ...titlePlan.maxTokens === undefined ? {} : { maxOutputTokens: titlePlan.maxTokens },
            utdid: this.utdid,
            requestId,
        });
        /**
         * ⚠️ **`system_instruction` 必须是字符串**（实测缺陷，见文件头第 1 条）。
         *
         * ⚠️ **源头已修**：`buildAccioBody` 初版产出 Gemini 风格对象 `{parts:[{text}]}`，
         * 而 Accio 的推理端点**只接受字符串** —— 对象形态实测**恒**回
         * `HTTP 200 + 流内 {"error_code":"400","error_message":"Invalid request format"}`，
         * 症状是「模型没返回内容」而不是参数错误（极具误导性）。
         * **commit `3034d03`** 已把该纯函数改成直接产出字符串，
         * `tests/unit/accio-product.spec.ts` 也同步锁定字符串形态。
         *
         * ⇒ 这里的改写**保留为纵深防御**（不改写也正确）：把「wire 上该键必为字符串」
         * 这条硬约束显式落在适配器里，纯函数或上游形状若再次漂移仍能兜住。
         * **刻意不删。**
         */
        if (systemInstruction !== '')
            body.system_instruction = systemInstruction;
        else
            delete body.system_instruction;
        if (options.stop !== undefined && options.stop.length > 0)
            body.stop_sequences = options.stop;
        // 6. 发送（401/403 时刷新一次凭据后重试一次）。
        //
        // ⚠️⚠️ **重试前必须把新令牌写回 body**（真实缺陷，本轮修复）：
        // 令牌在 `body.token` 里，而 `send()` 只从 `credential` 取 `sgcookie` 头 ⇒
        // 不更新 body 就是「刷新后重发旧 token」，该分支**结构性失效**
        // （且 `AUTH` 不在 harness 的可重试集合里，兜不住）。
        // 用 {@link applyAccessToken} 与初次构造走**同一条**落点，避免第二处写法漂移。
        applyAccessToken(body, credential.access_token);
        let response = await this.send(credential, body, options);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            await this.options.refresh();
            const refreshed = await this.options.resolveCredential(options.model);
            if (refreshed === undefined || refreshed.access_token === '') {
                throw new LlmError('accio: credential expired and refresh failed', 'AUTH', {
                    status: response.status,
                });
            }
            credential = refreshed;
            // ⚠️ 只覆盖令牌：`message_id` / `request_id` / `properties` 必须保持原值
            //（同一次逻辑请求，重建 body 会换掉请求身份）。
            applyAccessToken(body, credential.access_token);
            response = await this.send(credential, body, options);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            // ⚠️ 402 / 额度不足 ⇒ `QUOTA_EXCEEDED`（见 `httpErrorCode` 的说明）。
            throw new LlmError(`accio: ${errorDetail(text)}`, httpErrorCode(response.status), {
                status: response.status,
            });
        }
        if (response.body === null) {
            throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE');
        }
        /**
         * ⚠️⚠️ **必须校验 `content-type`：HTTP 200 也可能是一张风控拦截页**
         * （2026-10-13 真机实测发现，与本仓库记过的「流内 402 被 HTTP 200 掩盖」同型）。
         *
         * ## 现象
         *
         * 请求**不带 `utdid`**（或只放 header 不放 `properties.utdid`）时，阿里网关回：
         * - **HTTP `200`**（不是 4xx！）；
         * - `content-type: text/html;charset=UTF-8`；
         * - body 是一段跳转脚本：`<a id="a-link" href="https://bixi-intl.alicdn.com/punish/…">`
         *   + `window._config_ = {"action":"deny",…}` + `<!--rgv587_flag:sm-->`。
         *
         * ## 不校验的后果（**静默**）
         *
         * 这段 HTML 会被喂给 SSE 解析器 ⇒ **一帧都解析不出来** ⇒ 最终报
         * 「模型未返回任何内容块」。用户看到的是「模型不回复」，而真因是**风控**，
         * 排查方向完全错（本轮实测就曾被它误导成「档位无效」）。
         *
         * ## 为什么判 `content-type` 而不是判 body 文本
         *
         * 正常响应恒为 `text/event-stream`（实测）；而 body 文本的形态（脚本内容、
         * 域名、标记）都可能变 —— 判结构比判内容稳。
         *
         * ⚠️ 归类 `SERVER`（**不重试**）：风控是**身份/环境**问题，原样重发只会
         * 再被拦（与 `trae-adapter.ts` 的 4006 不重试同理）。
         */
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            // ⚠️ 读 body 只为**把服务端原文带给用户/日志**（诊断用），失败不影响判据。
            const peek = await response.text().catch(() => '');
            throw new LlmError(`accio: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
                + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。`
                + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`, 'SERVER', { status: response.status });
        }
        // 7. 消费 SSE。
        //
        // ⚠️ **流内 402 由 `consumeAccioSse` 抛 `QUOTA_EXCEEDED`**（HTTP 仍是 200）。
        //    这里**绝不 catch-and-rewrap** —— 重包会丢掉额度语义、把它降级成
        //    「模型没返回内容」（Task 3 修过的真实缺陷）。
        //
        // ⚠️ 工具调用分片先经 `accioToolCallMergeTransform` 合并（见该函数的说明）。
        const merged = response.body.pipeThrough(accioToolCallMergeTransform());
        yield* consumeAccioSse({
            body: merged,
            ...options.signal === undefined ? {} : { signal: options.signal },
            idleTimeoutMs: ACCIO_SSE_IDLE_TIMEOUT_MS,
        });
    }
    /** 发起一次推理请求；网络失败映射为可重试的 `TRANSPORT`。 */
    async send(credential, body, options) {
        const requestId = String(body.request_id);
        const url = `${this.product.gatewayBaseUrl}${ACCIO_LLM_PATH}?sg_k=${accioSgK(requestId)}`;
        const headers = accioHeaders({
            utdid: this.utdid,
            ...credential.sgcookie === undefined ? {} : { sgcookie: credential.sgcookie },
        });
        try {
            return await this.fetchImpl(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options.signal ?? AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
            });
        }
        catch (error) {
            if (options.signal?.aborted)
                throw error;
            if (isTransportError(error)) {
                throw new LlmError(`accio: transport error: ${errorMessage(error)}`, 'TRANSPORT', {
                    cause: error,
                });
            }
            throw error;
        }
    }
}
/**
 * 在 `ctx.llm` 上注册 Accio provider 路由与适配器。
 */
export function registerAccioLlm(ctx, options) {
    const product = options.product ?? ACCIO;
    const adapter = new AccioAdapter({
        ...options,
        // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
        // 另写一份 emit —— 两份实现必然漂移。
        onCatalogLoaded: () => broadcastCatalogChanged(ctx),
    });
    registerAdapterIdempotent(ctx.llm, [product.id], adapter);
    // 返回实例：Jet Hub 的「显示列表」需要它的 `listAllModels()`。
    return adapter;
}
//# sourceMappingURL=accio-adapter.js.map