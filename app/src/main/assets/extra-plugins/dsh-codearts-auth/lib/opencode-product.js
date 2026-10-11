/**
 * OpenCode Zen 产品配置与错误分类。
 *
 * ## 数据来源（设计文档 §0）
 *
 * 1. 端点 / 免费模型清单：官方 docs https://opencode.ai/docs/zen/ （2026-10-01 采集）
 * 2. 错误类型名：opencode 官方源码 `packages/opencode/src/session/retry.ts`
 *    （`FreeUsageLimitError` / `GoUsageLimitError` + `retry-after` 头）
 *
 * ## ⚠️ 为什么按「错误类型名」而不是「状态码」分类
 *
 * 本仓库 qoder 曾因「用错误码的默认归类代替业务语义判断」把确定性的额度耗尽
 * 当成可重试的 SERVER 而白重试 5 次；minimax 也曾把 402 归 AUTH 让用户
 * 看不到「去充值」这个唯一有效动作。Zen 的额度错误可能带 400/401/403/429
 * 任一状态码，唯一稳定的信号是**响应体里的错误类型名**。
 *
 * ## ⚠️ 身份结论（本 provider 设计的基石）
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码逐行核对：
 * 无 machine-id / deviceId / 安装 ID / 遥测）。身份只有三个维度：
 * **出口 IP、API key（账号）、随机会话 id**。
 * ⇒ 「换一台 PC」在协议层等价于「换一个 key 或换一个出口 IP」，
 * 指纹派生的作用是**防关联**与满足形状门禁，不是换配额桶。
 */
// `retry-after` 的解析已收敛到 `src/retry-after.ts`（原先本文件与
// `opencode-adapter.ts` 各有一份几乎逐字相同的私有实现）。
import { retryAfterMsFromRecord } from './retry-after.js';
export const OPENCODE = {
    id: 'opencode',
    // ⚠️ 必须与客户端 `PROVIDERS` 里的 label 逐字一致（rail 宽度算式依赖它，
    // 且 `opencode-client-panel.spec.ts` 有跨文件一致性断言）。
    displayName: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    // ⚠️ 与本仓库其余 provider 的流式超时常量同档（保守值）。
    chatHeaderTimeoutMs: 60_000,
    chatChunkTimeoutMs: 120_000,
    // ⚠️ 匿名凭证是**字面量** `public`：opencode 官方 CLI 在没有 key 时自己就用它
    // （其 provider.ts 的 opencode 分支：`options: ok ? {} : { apiKey: 'public' }`）。
    anonymousKey: 'public',
    // ⚠️ 兜底 UA 版本号。接线层会用真机 `opencode --version` 的结果覆盖它。
    defaultUserAgent: 'opencode/1.18.22',
    /**
     * 模型能力元数据源（**远端**，能力的主来源）。
     *
     * ⚠️ 不是 `/zen/v1/models` —— 实测它只返回 `id`/`object`/`created`/
     * `owned_by` 四个字段，**不含任何能力信息**（85 条全如此）。
     * 能力在 **models.dev** 的 `opencode` 条目里，官方 CLI 自己就用它
     * （`packages/core/src/models-dev.ts`）。见 `opencode-capability.ts`。
     */
    modelsDevUrl: 'https://models.dev/api.json',
    /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档）。 */
    modelsDevTtlMs: 60 * 60 * 1000,
};
export const OPENCODE_MODELS_DEV_URL = OPENCODE.modelsDevUrl;
export const OPENCODE_MODELS_DEV_TTL_MS = OPENCODE.modelsDevTtlMs;
/**
 * 兜底模型表（**以真机实测为准**，2026-10-01）。
 *
 * ⚠️ 每条都对应 `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`
 * 里一次成功的真实请求。`isFree` 的含义是「**匿名通道**（`Bearer public`）
 * 能否使用」，不是官方定价表的 Free 标记 —— 这是本插件唯一关心的维度。
 *
 * ⚠️ `ling-3.0-flash-fin-free` **已移除**：官方 docs 说它走 `/v1/messages`
 * （Anthropic），而该端点当前对匿名与付费 key 都返回 500（与 body 形态无关），
 * chat 端点则是 404 路由不存在 ⇒ 它在两条通道上都不可用，留在目录里只会
 * 让用户点到一个必然失败的模型。
 */
export const OPENCODE_FALLBACK_MODELS = [
    // ── 匿名可用（chat 端点，无需 key）──
    { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 262144 },
    { id: 'space-bunny-free', name: 'Space Bunny Free', isFree: true, contextWindow: 262144 },
    { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', isFree: true, contextWindow: 262144 },
    { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', isFree: true, contextWindow: 262144 },
    { id: 'mimo-v2.5-free', name: 'MiMo-V2.5 Free', isFree: true, contextWindow: 262144 },
    // ⚠️ 这两个官方 docs 标注走 `/v1/models/{id}`（Gemini 风格），但**实测
    // chat 端点也通** ⇒ 按 chat 处理。**以实测为准，不以 docs 为准。**
    { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, contextWindow: 262144 },
    { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, contextWindow: 262144 },
    // ── 需付费 key（chat 端点；实测匿名为 401）──
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, contextWindow: 262144 },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', isFree: false, contextWindow: 262144 },
    { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, contextWindow: 262144 },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m2.7', name: 'minimax M2.7', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m3', name: 'minimax M3', isFree: false, contextWindow: 262144 },
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', isFree: false, contextWindow: 262144 },
];
const FREE_IDS = new Set(OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id));
const REACHABLE_IDS = new Set(OPENCODE_FALLBACK_MODELS.map((m) => m.id));
/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ⚠️ **未知模型返回 false**：远端目录可能含表外的新免费模型，
 * 但在未实测前把它们放给匿名槽只会换来 403/500；宁可要求用户加一个付费账号。
 */
export function isFreeOpencodeModel(id) {
    return FREE_IDS.has(id);
}
/**
 * 该模型在我们**已实现并实测可达**的通道里是否存在。
 *
 * ## 为什么远端目录必须过这道闸（真实报障 2026-10-01）
 *
 * `GET /v1/models` 返回全部 84 个模型，且**不含任何协议信息**
 * （字段只有 id/object/created/owned_by）。若直接把它们交给 DSH，
 * 用户会在选择器里看到 `ling-3.0-flash-fin-free`、`claude-*`、
 * `gpt-*` 等模型 —— 点下去只会拿到 404/401/500。
 *
 * ⇒ 目录**只暴露本表内的模型**；表外的新模型要等实测确认端点后再加进来。
 * （表本身也来自实测：见 `2026-10-02-opencode-zen-endpoint-matrix.md`。）
 */
export function isReachableOpencodeModel(id) {
    return REACHABLE_IDS.has(id);
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
 * 把一次失败的 HTTP 响应归类为语义化的错误。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyOpencodeError(status, body, headers) {
    const retryAfterMs = retryAfterMsFromRecord(headers);
    const detail = readableDetail(body);
    const lower = body.toLowerCase();
    // ⚠️ **顺序即优先级**：限流语义必须在 auth 之前判 —— 上游的额度错误
    // 经常带 401/403 状态码，若先判状态码会把「额度用尽」误报成「key 失效」，
    // 用户的唯一有效动作（等窗口恢复 / 切下一个账号）会被完全掩盖。
    if (body.includes('FreeUsageLimitError')) {
        return { kind: 'free_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (body.includes('GoUsageLimitError')) {
        return { kind: 'go_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (body.includes('FreeTierError')) {
        // 形状门禁：伪装形态被拒。**不重试也不换槽**（我们每槽发的是同一套形状，
        // 换槽重试无意义），如实透传让人知道「伪装需跟进上游更新」。
        return { kind: 'free_tier', detail };
    }
    if (status === 429 || lower.includes('too many requests') || lower.includes('rate limit')) {
        return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (status === 0 || lower.includes('fetch failed') || lower.includes('terminated')
        || lower.includes('econnreset') || lower.includes('socket hang up')
        || lower.includes('getaddrinfo') || lower.includes('econnrefused')) {
        return { kind: 'transport', detail };
    }
    // ⚠️⚠️ **402 必须单独归类**（真实报障 2026-10-01）：
    // 实测付费 key 余额耗尽时上游回 `402
    // {"error":{"type":"server_error","message":"...Insufficient account funds"}}`。
    // 若落进下面的 `status >= 500` 之外、又被 `httpErrorCode` 归成 `SERVER`，
    // 用户看到的是「服务端故障，请重试」—— 而重试永远不会成功（要充值）。
    // 必须映射到 QUOTA_EXCEEDED，UI 才能给出「去充值」这个唯一有效动作。
    if (status === 402 || lower.includes('insufficient account funds')
        || lower.includes('insufficient funds') || lower.includes('insufficient balance')) {
        return { kind: 'quota', detail };
    }
    if (status === 401 || status === 403)
        return { kind: 'auth', detail };
    if (status >= 500)
        return { kind: 'server', detail };
    return { kind: 'auth', detail };
}
//# sourceMappingURL=opencode-product.js.map