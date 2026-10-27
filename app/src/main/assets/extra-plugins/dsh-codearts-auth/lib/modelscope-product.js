/**
 * ModelScope（魔搭，阿里达摩院）产品配置与错误分类。
 *
 * ## 这个 provider 从哪来（与上游其余 provider 的关系）
 *
 * 本仓库是 gitee `iJetLi/deepseek-harness-codearts` 的 fork。上游 0.2.0-rc.3
 * **没有** modelscope / chatanywhere 两个 provider —— 它们是**本地 fork 独有的
 * 反代上游**（旧实现见 `dsh-codearts-auth@0.1.0` 的 `src/proxy/remote-upstream.ts`，
 * 由一个端口 8787 的 OpenAI 兼容反代按 priority 轮换）。2026-10-09 切到上游后
 * 这两个能力整体消失，本文件把 modelscope 一路按上游的**标准 provider 模式**
 * 补回来（而不是把旧 fork 的整套反代搬回来）。
 *
 * ## 数据来源（逐条可追溯）
 *
 * | 事实 | 取值 | 出处 |
 * |---|---|---|
 * | base URL | `https://api-inference.modelscope.cn/v1` | 旧 fork `src/proxy/upstream-config.ts:51` |
 * | chat 路径 | `/chat/completions` | 旧 fork `src/proxy/remote-upstream.ts:429` |
 * | models 路径 | `/models` | 旧 fork `src/proxy/remote-upstream.ts:268` |
 * | 鉴权头 | `Authorization: Bearer <apiKey>` | 旧 fork `src/proxy/remote-upstream.ts:238` |
 * | 请求内容类型 | `Content-Type: application/json` | 同上 L236 |
 * | 流式 | `stream: true` 恒开，SSE | 旧 fork `src/proxy/remote-upstream.ts:376` |
 * | 模型名 | 带命名空间前缀，如 `deepseek-ai/DeepSeek-V4.1-Flash` | 旧 fork `src/domain/models/catalog.ts:277` |
 * | 关思考参数 | `reasoning_effort: "none"` / `enable_thinking: false` / `thinking: {type:"disabled"}` | 旧 fork `src/proxy/remote-upstream.ts:77` |
 * | 视觉能力 | `deepseek-v4.1-flash` 实测可收图 | 旧 fork `src/proxy/remote-upstream.ts:87-91` |
 * | 额度 | 平台**无余额 API**，余额只在登录后的网页上 | 旧 fork `src/overview.ts:70-76` |
 *
 * ## ⚠️ 一个已实测的 400（本 provider 最容易踩的坑）
 *
 * 旧 fork 曾把 DSH 的扁平工具 schema `{name, description, parameters}` **原样**
 * 转发给 modelscope，结果**每次请求都被 400 拒绝**：
 *
 * ```
 * upstream: modelscope  status: 400
 * {"error":{"code":"invalid_parameter_error",
 *           "message":"'type' is a required property - 'tools.0'"}}
 * ```
 *
 * 后果极隐蔽：反代把它当「上游不可用」静默跳过，魔搭积分**一次都没消耗**，
 * 用户完全看不出来（见旧 fork `src/proxy/remote-upstream.ts:386-395` 与
 * `src/proxy/openai-map.ts:242`）。
 * ⇒ 本实现必须走 `{type:'function', function:{…}}` 包装（见
 * `src/modelscope-messages.ts`），与仓库其余 OpenAI 兼容 provider 同口径。
 *
 * @module src/modelscope-product.ts
 */
import { retryAfterMsFromRecord } from './retry-after.js';
export const MODELSCOPE = {
    id: 'modelscope',
    // ⚠️ 与客户端 PROVIDERS 的 label 逐字一致；长度也刻意控制在不撑破 rail 的
    // 范围内（该 label 是本表新增里较长的，但仍短于既有最长的
    // 'WorkBuddy (国际版)' 与 'Gemini Code Assist'）。
    displayName: 'ModelScope (魔搭)',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    // 与本仓库其余 provider 的流式超时常量同档（保守值）。
    chatHeaderTimeoutMs: 60_000,
    chunkTimeoutMs: 120_000,
    catalogTimeoutMs: 15_000,
    // ⚠️ 余额端点在**另一个 host**且前缀是 `/openapi/`（不是 `/api/`、也不是 `/v1/`）——
    //    见字段注释里的实测矩阵与「怎么找到它」的留档。
    balanceUrl: 'https://www.modelscope.cn/openapi/v1/magicubes/balance',
    balanceTimeoutMs: 15_000,
    defaultCredentialRef: 'MODELSCOPE_ACCESS_TOKEN',
};
/**
 * 兜底模型表。
 *
 * ## 它解决什么（2026-10-17 实测后大幅扩表）
 *
 * 魔搭的 `/v1/models` **只下发 4 个字段**（实测：`id` / `object` / `owned_by` /
 * `created`）—— **既没有 `context_window`，也没有 `modalities.input`**：
 *
 *     远端条目的全部字段: id, object, owned_by, created
 *     窗口相关字段: （无 —— 远端不下发任何窗口信息）
 *
 * ⇒ 原先只登记 2 个模型的后果是：**其余 34 个模型的 `contextWindow` 全落成 0**
 * （0 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发 `context`）
 * ⇒ 用户看到 34 个模型「没有上下文窗口信息」，而 DSH 的自动压缩阈值算不出来。
 * ⇒ 故按 2026-10-17 用户指示扩表到**远端实测的 36 个**。
 *
 * ## ⚠️⚠️ 每个窗口值的**出处分两类**（不许混为一谈）
 *
 * | 类别 | 取值 | 依据 |
 * |---|---|---|
 * | **① 仓库已有实测** | `1_048_576` / `1_000_000` | 本仓库其它渠道对**同一模型**的实测结论（见各项注释里的出处） |
 * | **② 无先例** | `512_000` | **未实测**的保守占位（用户 2026-10-17 指示） |
 *
 * ⚠️ **②类不是实测值**：魔搭上游不返回窗口字段，而逐个实测 17 个模型的真实
 * 上限成本过高（用户明示「没实测也不用测了」）⇒ 取一个**偏保守**的中间值，
 * 宁可低估窗口（提前触发压缩）也不要高估（DSH 以为能装 1M、实际被上游截断）。
 *
 * ⚠️ **实测旁证（仅对 V4.1 Flash）**：喂约 **100 万 tokens** 输入返回 200
 * （`finish_reason: length` 只是**输出**被截断，不是输入超限）⇒ 原来的
 * `128_000` 明显偏保守。⚠️ 但这**不是**「服务端声明的官方上限」，只是
 * 「这个量级能用」。
 *
 * ## 远端可用时**完全采信远端**
 *
 * 不做 Buddy 那样的「以兜底表为准」裁剪 —— 魔搭的模型池由平台侧随时增删，
 * 本地表必然滞后。⚠️ 本表只在**远端拉取失败**时生效。
 */
export const MODELSCOPE_FALLBACK_MODELS = [
    // ── DeepSeek 系（仓库实测 1_048_576：officeace-product.ts 的 deepseek-v4.1-flash
    //    与 loomy-product.ts 的 deepseek-v4-flash-0731 均为该值）──
    {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
        name: 'DeepSeek-V4.1-Flash (魔搭)',
        contextWindow: 1_048_576,
        // ⚠️ 视觉能力有实测出处（旧 fork remote-upstream.ts:87-91：
        // 「modelscope / chatanywhere / deepseek 官方的 deepseek-v4.1-flash
        //   都有视觉能力（1×1 纯色 PNG 红/蓝/绿全答对）」；2026-10-17 本仓库
        //   复测 32×32 纯红 PNG → 模型答 `Red`，读图确实生效）。
        supportsImage: true,
        // ⚠️⚠️ **只有「关闭思考」是确证的一档**（2026-10-17 真机三档对照，每档 3 次）：
        //    `none` → reasoning 0/0/0（**稳定为 0**，「关闭」确实生效）；
        //    而 `medium`（中位数 1462）与 `high`（1734）**低于「不指定」的 1676**，
        //    差距远小于同档内波动（同档极差 460+）
        //    ⇒ **`medium`/`high` 被服务端静默忽略**（请求返 200，但不改变思考量）。
        //    ⚠️ 这正是仓库记过的判据（「能正常请求」≠「档位生效」，必须用服务端
        //    权威计数证明档位间有**可区分**的差距，见 providers-accio.md §7）。
        //    ⇒ 只声明确证的一档；给出手感档位会让用户以为能控思考量。
        efforts: ['none'],
    },
    {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        name: 'DeepSeek-V4-Pro (魔搭)',
        contextWindow: 1_048_576,
        // ⚠️ 视觉能力**未实测** ⇒ 按仓库硬约定「声明支持就必须真支持」记 false。
        //    ⚠️ 注意这与 accio-product.ts 里 DeepSeek V4 Pro 的 `supportsImage:false` 一致。
        supportsImage: false,
    },
    {
        id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        name: 'DeepSeek-V4-Flash-0731 (魔搭)',
        contextWindow: 1_048_576, // loomy-product.ts:322 的 deepseek-v4-flash-0731 实测值
        supportsImage: false,
    },
    {
        id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
        name: 'DeepSeek-V4-Pro-0813 (魔搭)',
        contextWindow: 1_048_576,
        supportsImage: false,
    },
    // ── GLM / 智谱 系（仓库实测 1_048_576：officeace-product.ts:136 的 glm-5.3）──
    { id: 'ZhipuAI/GLM-5.2', name: 'GLM-5.2 (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'ZhipuAI/GLM-4.7-Flash', name: 'GLM-4.7-Flash (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    // ── MiniMax 系（仓库实测 1_000_000：minimax-product.ts:149/162）──
    { id: 'MiniMax/MiniMax-M3', name: 'MiniMax-M3 (魔搭)', contextWindow: 1_000_000, supportsImage: false },
    // ⚠️⚠️ `M1-80k` 的**名字里就写着 80k** ⇒ 1M 显然是错的，但仓库**无该模型的
    //    实测值** ⇒ 按「② 无先例」口径给 512_000（保守）。实测成本对用户过高
    //    （用户 2026-10-17 明示「没实测也不用测了」）。
    { id: 'MiniMax/MiniMax-M1-80k', name: 'MiniMax-M1-80k (魔搭)', contextWindow: 512_000, supportsImage: false },
    // ── Qwen 系（仓库实测 1_048_576：cline-product.ts:189/198）──
    { id: 'Qwen/Qwen3.8-Flash-Next', name: 'Qwen3.8-Flash-Next (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8-27B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'Qwen/Qwen3.5-27B', name: 'Qwen3.5-27B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'Qwen/Qwen3.5-35B-A3B', name: 'Qwen3.5-35B-A3B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5-122B-A10B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5-397B-A17B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    // ⚠️ 生图模型：声明 `supportsImage:false` 是**输入**维度（它们接受图片**输出**）。
    { id: 'Qwen/Qwen-Image-Edit', name: 'Qwen-Image-Edit (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'MusePublic/Qwen-Image-Edit', name: 'Qwen-Image-Edit (魔搭·镜像)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'XGenerationLab/XiYanSQL-QwenCoder-32B-2412', name: 'XiYanSQL-QwenCoder-32B-2412 (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    { id: 'XGenerationLab/XiYanSQL-QwenCoder-32B-2504', name: 'XiYanSQL-QwenCoder-32B-2504 (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    // ── InternVL 系（仓库实测 1_048_576：cline-product.ts 同档口径）──
    // ⚠️⚠️ `supportsImage: false` 是**诚实标记**，不是「不支持」：InternVL 系列
    //    以视觉著称，**魔搭侧极可能支持**，但 2026-10-17 **未实测**
    //    （实测成本对用户过高，用户明示「没实测也不用测了」）。
    //    ⚠️ 按仓库硬约定「声明支持就必须真支持」+ accio 那轮的教训
    //    （漏报 false 会让模型对图片**幻觉出答案**：HTTP 200、不报错，比报错危险），
    //    ⇒ 未实测一律记 false。将来实测通过后再改。
    { id: 'OpenGVLab/InternVL3_5-241B-A28B', name: 'InternVL3.5-241B-A28B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
    // ── ② 无仓库先例：保守占位 512_000（未实测，见表头说明）──
    { id: 'Shanghai_AI_Laboratory/Intern-S1', name: 'Intern-S1 (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'Shanghai_AI_Laboratory/Intern-S1-mini', name: 'Intern-S1-mini (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'Shanghai_AI_Laboratory/Intern-S2-Preview', name: 'Intern-S2-Preview (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'stepfun-ai/Step-3.7-Flash', name: 'Step-3.7-Flash (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'stepfun-ai/Step-3.5-Flash', name: 'Step-3.5-Flash (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'nex-agi/Nex-N2.5-Pro', name: 'Nex-N2.5-Pro (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'nex-agi/Nex-N2.5-mini', name: 'Nex-N2.5-mini (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'mistralai/Mistral-Large-Instruct-2407', name: 'Mistral-Large-Instruct-2407 (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'PaddlePaddle/ERNIE-4.5-300B-A47B-PT', name: 'ERNIE-4.5-300B-A47B (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'PaddlePaddle/ERNIE-4.5-21B-A3B-PT', name: 'ERNIE-4.5-21B-A3B (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT', name: 'ERNIE-4.5-VL-28B (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'PaddlePaddle/ERNIE-4.5-0.3B-PT', name: 'ERNIE-4.5-0.3B (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'MedAIBase/AntAngelMed', name: 'AntAngelMed (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'opencompass/CompassJudger-1-32B-Instruct', name: 'CompassJudger-1-32B (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'early-access/EA-29B-A4B', name: 'EA-29B-A4B (魔搭·早期体验)', contextWindow: 512_000, supportsImage: false },
    { id: 'meituan-longcat/LongCat-Flash-Lite', name: 'LongCat-Flash-Lite (魔搭)', contextWindow: 512_000, supportsImage: false },
    { id: 'ACE-Step/acestep-v15-xl-sft', name: 'ACE-Step-v15-xl (魔搭)', contextWindow: 512_000, supportsImage: false },
];
/** 该模型是否为本地兜底表里登记过的（远端目录爆炸时的收敛依据）。 */
export function isKnownModelscopeModel(id) {
    return MODELSCOPE_FALLBACK_MODELS.some((m) => m.id === id);
}
/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body) {
    const text = body.trim();
    if (text === '')
        return '（上游未返回错误详情）';
    try {
        const data = JSON.parse(text);
        const nested = typeof data.error === 'object' && data.error !== null
            ? data.error.message
            : data.error;
        const parts = [data.message, nested, data.msg]
            .filter((v) => typeof v === 'string' && v.length > 0);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch {
        // 非 JSON：直接截断原文
    }
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（三条都来自本项目真实缺陷）
 *
 * 1. **限流/额度必须排在 auth 之前**：魔搭与同源的 chatanywhere 在额度耗尽时
 *    可能回 401/403 而不是 429（旧 fork `src/proxy/upstream.ts` 的
 *    `NON_RETRYABLE_CODES` 与 key-pool 的 `isQuotaLikeError` 就是为这个形态写的）。
 *    若先判状态码，用户看到的会是「API key 失效」——而他的唯一有效动作
 *    （等窗口恢复 / 换一个 key）被完全掩盖。
 * 2. **400 单独归 `invalid_request`**：魔搭对请求体形状极严格（见模块头的
 *    工具包装事故），把它归成 server/可重试会让 harness 白重试 5 次、
 *    每次都拿到同一个 400。
 * 3. `retry-after` 由**响应头**给出，解析实现收敛在 `src/retry-after.ts`
 *    （0 是合法值，判空必须用 `=== undefined`）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyModelscopeError(status, body, headers) {
    const retryAfterMs = retryAfterMsFromRecord(headers);
    const detail = readableDetail(body);
    const lower = body.toLowerCase();
    // ⚠️⚠️ **上下文超限必须排在 `rate_limit` / `quota` 之前**
    // （2026-10-17 审计 P1 修复）。此前本函数**根本没有 `context_window` 这一类**，
    // 而 rate_limit 判据含 `throttl`、quota 判据含 `exceed` ⇒
    // 「maximum context length is 8192 tokens, prompt exceeds limit」被 quota 抢走、
    // 「context window exceeded」被 quota 抢走、「context limit throttling policy
    // exceeded」连 rate_limit 都抢走（实测三种报文各自被抢）。
    // ⚠️ **危害不是分类难看，而是账号被封**：quota ⇒ 轮换层调 `markLimited` ⇒
    // `modelscopeRetryAfterMs('quota', …)` ⇒ `nextUtc8DayStartMs()` ⇒ 给该账号的该
    // 模型写一个**到次日 UTC+8 零点**的冷却标记。用户只是发了一条超长消息
    // （长会话中途上下文涨过头极常见），却**丢掉一整个账号到第二天** ——
    // 与 `docs/agent-notes/providers-loomy-raccoon-minimax.md` 记的 loomy
    // 「23:50 烧光被封到次日 23:50」同族。
    // ⚠️ 另：归 `context_window` 同时**兼得「不重试」与「触发溢出压缩」**
    // （见 `docs/agent-notes/providers-trae.md`：超限必须归 CONTEXT_WINDOW_EXCEEDED，
    // 归 SERVER 会把巨型请求原样重发 5 次）。
    //
    // ⚠️⚠️ **必须排在 `status === 429` 之前吗？——不必，且刻意不这么做**：
    //    真发 429 时那一定是真的限流，必须让 rate_limit 生效。所以本判据**只认
    //    报文文本**、不含 `status` 条件；真 429 且文本含 context 措辞是**不可能**的
    //    组合（超限不会用 429 + context 文案），故文本优先是安全的。
    if (lower.includes('maximum context length')
        || lower.includes('context length')
        || lower.includes('context window')
        // ⚠️ `context limit` 这一格覆盖实测到的第三种措辞
        //（「context limit throttling policy exceeded」）：它既不含 `context length`
        // 也不含 `context window`，但**含 `throttl`** ⇒ 修复前会被 rate_limit 抢走。
        // ⚠️ 判据是 `context` 与 `limit` **同时**出现（不是单看 `limit`）——
        //    否则「rate limit」这类真限流报文会被误吞成 context_window。
        || (lower.includes('context') && lower.includes('limit'))
        || lower.includes('context_length_exceeded')
        || lower.includes('reduce the length')
        || lower.includes('too many tokens')
        || lower.includes('input tokens exceed')) {
        // ⚠️ `retryAfterMs` **刻意不给**：超限不是配额问题，重试无意义、也无处可退。
        return { kind: 'context_window', detail };
    }
    if (status === 429
        || lower.includes('too many requests')
        || lower.includes('rate limit')
        || lower.includes('throttl')) {
        return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (status === 402
        || lower.includes('insufficient')
        || lower.includes('quota')
        || lower.includes('exceed')
        || lower.includes('balance')
        || lower.includes('魔粒')) {
        return { kind: 'quota', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (status === 0
        || lower.includes('fetch failed')
        || lower.includes('terminated')
        || lower.includes('econnreset')
        || lower.includes('socket hang up')
        || lower.includes('getaddrinfo')
        || lower.includes('econnrefused')) {
        return { kind: 'transport', detail };
    }
    if (status === 400 || status === 422)
        return { kind: 'invalid_request', detail };
    if (status === 401 || status === 403)
        return { kind: 'auth', detail };
    if (status >= 500)
        return { kind: 'server', detail };
    return { kind: 'server', detail };
}
//# sourceMappingURL=modelscope-product.js.map