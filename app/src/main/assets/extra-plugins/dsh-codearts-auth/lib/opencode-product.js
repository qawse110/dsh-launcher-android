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
    baseUrl: 'https://opencode.ai/inference',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    // ⚠️ 与本仓库其余 provider 的流式超时常量同档（保守值）。
    chatHeaderTimeoutMs: 60_000,
    chatChunkTimeoutMs: 120_000,
    // ⚠️ 匿名凭证是**字面量** `public`：opencode 官方 CLI 在没有 key 时自己就用它
    // （其 provider.ts 的 opencode 分支：`options: ok ? {} : { apiKey: 'public' }`）。
    anonymousKey: 'public',
    // V2 UA；旧版 CLI 探测值由 opencodeUserAgent 拦截，不能降级到已失效的协议。
    defaultUserAgent: 'opencode/latest/2.0.29/cli',
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
 * ⚠️ 本插件实现的**唯一**模型协议：OpenAI chat completions。
 *
 * models.dev 的 `provider.api` 正是**协议端点**的权威字段，而实测按它分组与
 * 「我们实现了哪些协议」逐格吻合（2026-10-17 实测 85 条远端目录）：
 *
 * | `provider.api` | 条数 | 本插件 |
 * |---|---|---|
 * | `…/inference/openai/v1` | 56 | ✅ 已实现 |
 * | `…/inference/anthropic/v1` | 17 | ❌ 未实现（实测 `/v1/messages` 恒 500） |
 * | `…/inference/google/v1beta` | 8 | ❌ 未实现（Gemini 原生协议） |
 * | （无该字段） | 4 | ⚠️ 不知道 ⇒ 交本地兜底表决定 |
 *
 * ⚠️ **比较必须逐字相等**：models.dev 给的是**带域名**的绝对 URL，而上面
 * 表格里的短形态只是文档缩写。写成 `endsWith('/inference/openai/v1')` 也能过，
 * 但那会让「未来新增一个同后缀的第三方端点」被误判成可达。
 */
export const OPENCODE_CHAT_PROTOCOL_API = 'https://opencode.ai/inference/openai/v1';
/**
 * 兜底模型表（**以真机实测为准**，2026-10-01 / 2026-10-17 更新）。
 *
 * ## ⚠️⚠️ 它的职责已经收窄为**只在能力表不可用时**兜底（Issue IKM9LR）
 *
 * 改前这张表**同时**是「网络失败的兜底目录」与「协议可达性白名单」，而后者
 * 意味着**每上一个新模型都要手工加一行** —— Zen 于 2026-10 上线
 * `deepseek-v4.1-flash-free` / `glm-5.3-flash-free` 时，远端 `/v1/models`
 * **明明下发了**，却因为不在表里被过滤掉，用户在选择器里完全看不到
 * （症状与「上游没有这个模型」同形，极难自查）。
 *
 * ⇒ 现在「可达性」由 models.dev 的 `provider.api` 决定（见
 * {@link isReachableOpencodeModel}），这张表退回它本来的职责：**兜底**。
 * 表外模型在**能力表可用时**照常出现；只有能力表也拿不到时才回落到这里。
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
    // ⚠️ 这两个官方 docs 标注走 `/v1/models/{id}`（Gemini 风格），但**实测
    // chat 端点也通** ⇒ 按 chat 处理。**以实测为准，不以 docs 为准。**
    { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, contextWindow: 262144 },
    { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, contextWindow: 262144 },
    // ── 2026-10-17 实测新增（Issue IKM9LR：远端已下发但被硬编码表挡掉）──
    // ⚠️ 「已实测可用」= 用本插件自己的请求形状打过至少一次 200 并拿到正文。
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', isFree: true, contextWindow: 200000 },
    { id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', isFree: true, contextWindow: 200000 },
    { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', isFree: true, contextWindow: 1048576 },
    // ── 需付费 key（chat 端点；实测匿名为 401）──
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, contextWindow: 262144 },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', isFree: false, contextWindow: 262144 },
    { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, contextWindow: 262144 },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m2.7', name: 'minimax M2.7', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m3', name: 'minimax M3', isFree: false, contextWindow: 262144 },
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', isFree: false, contextWindow: 262144 },
];
/**
 * ⚠️⚠️ **已移除的两个条目**（2026-10-17 实测）—— 别加回来，除非重新实测通过。
 *
 * 保留这段注释而不是默默删掉，是因为「它们曾经可用」这件事本身有解释力：
 * 目录会漂移，而漂移的方向是**上游单方面废弃**。
 *
 * - `mimo-v2.5-free` → **HTTP 410 `ModelDeprecated`**，上游报文点名
 *   「Use mimo-v2.6-flash-free instead」⇒ 已被同族的 `mimo-v2.6-flash-free` 取代，
 *   两条并存只会让用户选到一个必然失败的。
 * - `nemotron-3-ultra-free` → **远端 `/v1/models` 已不再下发**它，且实测 503
 *   「Upstream error from Nvidia: Service temporarily overloaded」。
 *
 * ⚠️ 这两条**恰恰说明**可达性判据不能只靠本地表：只要远端还在下发，
 * 目录层就挡不住废弃模型 —— 只能靠运行时错误分类（`410` / `ModelDeprecated`）
 * 给用户可行动的文案。
 */
const FREE_IDS = new Set(OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id));
const REACHABLE_IDS = new Set(OPENCODE_FALLBACK_MODELS.map((m) => m.id));
/**
 * ⚠️ **协议可达性的远端覆盖表**（Issue IKM9LR）。
 *
 * 由 `opencode-capability.ts` 在归一 models.dev 时注入：`id → chatProtocol`。
 * 设为 `undefined`（模块未加载 / 能力表为空）时**全部退回本地兜底表**，
 * 那正是冷启动首帧的行为 —— 宁可少几个模型，也不要「什么都不显示」。
 */
let remoteReachability;
/**
 * ⚠️⚠️ **「能力表已被读过」的钩子**（2026-10-17 独立审计 P1 的根治）。
 *
 * ## 为什么需要它：判据曾依赖**调用顺序**，而顺序不可靠
 *
 * 两张远端表由 `opencode-capability.ts` 归一时注入，而注入发生在
 * **读能力表**的那一刻。于是判据的正确性依赖「每个调用点都先读一次能力表」。
 *
 * ⚠️ 实测这条依赖**被打破过**（我自己的修复引入的回归，审计独立发现）：
 *  `OpencodeAdapter.stream()` → `pickSlot()` → `isFreeOpencodeModel()`
 *   **不经过** `loadOpencodeCatalog`（那只在目录路径上），而当时顺序约束
 *   被押在 `loadOpencodeCatalog` 里 ⇒ 冷启动首帧对一个
 *   「远端标免费但本地表没有」的模型（实测 `glm-5-free`，models.dev 真实存在）
 *   判成收费 ⇒ 匿名槽被跳过 ⇒ 抛
 *   `MISSING_CREDENTIAL`「请先添加账号」，**而同一个模型在目录里明明可见**
 *   （实测：目录 1 条含该模型，stream 抛 MISSING_CREDENTIAL）。
 *   实测这类模型有 **37 个**（远端免费 46 − 本地表免费 9）。
 *   issue 报的那两个恰好已在本地表里，所以表面看不出来。
 *
 * ## 修法：把「有没有读过」变成**判据自身的事实**，而不是顺序约束
 *
 * 读判据时若两张表还是 `undefined`，就地读一次能力表（同步、零网络），
 * 由 {@link OPENCODE_CAPABILITY_HOOK} 回调完成注入。
 *
 * ⇒ 判据**自给自足**：任何调用点、任何顺序都得到同一答案，
 *   不再依赖「谁先谁后」这种跨文件的隐式约定。
 *
 * ⚠️ 为什么不在每个调用点补一句前置读：那就是我上一版的做法，
 *   实测证明它（a）漏了 `stream` 这条路径，（b）让两处同款代码看起来
 *   「都需要」而其实一处冗余。（c) 守卫只能钉住其中一处。
 */
let OPENCODE_CAPABILITY_HOOK;
/**
 * 注册「读能力表」的动作（由 `opencode-capability.ts` 在模块加载时调用）。
 *
 * ⚠️ **必须是模块加载期注册**，不能等到第一次归一 —— 否则冷启动首帧
 * （能力表尚未被任何路径读过）钩子还没注册，判据会退回本地表。
 */
export function setOpencodeCapabilityHook(hook) {
    OPENCODE_CAPABILITY_HOOK = hook;
}
/**
 * 确保两张远端表已注入（幂等；读判据时自动调用）。
 *
 * ⚠️ 只在表为 `undefined` 时触发 —— 已注入时**零开销**，
 * 不会让热路径（`listModels` 逐条过滤）反复读能力表。
 */
function ensureRemoteTables() {
    if (remoteReachability !== undefined && remoteFreeOverride !== undefined)
        return;
    OPENCODE_CAPABILITY_HOOK?.();
}
/**
 * 注入远端可达性表（**唯一定义处**在 `opencode-capability.ts`）。
 *
 * ⚠️ 传 `undefined` 表示「远端不可用」，调用方会退回本地表 —— 这是**刻意的**：
 * 能力表来自 5 MB 的外部站点，读不到是高频状态而非理论边界，而退回本地表
 * 得到的目录「少几个新模型但都能用」，严格优于「一个都不显示」。
 */
export function setRemoteOpencodeReachability(table) {
    remoteReachability = table;
}
/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ## ⚠️ 判据优先级：**远端 models.dev 的 cost > 本地表**（Issue IKM9LR）
 *
 * 改前只看本地表，于是 Zen 新上线的免费模型（issue 里的
 * `deepseek-v4.1-flash-free` / `glm-5.3-flash-free`）在能力表里明明
 * `cost: {input: 0, output: 0}`，却被判成「收费」⇒ 匿名用户看不到它们
 * （判据的第二个 bug，与可达性那个同源但独立）。
 *
 * ⚠️ 仍保留**未知即 false**：表外且远端也没有判据时，不放给匿名槽 ——
 * 那是保守方向，宁可要求用户加一个付费账号，也不能给一个必然 403 的模型。
 */
export function isFreeOpencodeModel(id) {
    ensureRemoteTables();
    const remote = remoteFreeOverride?.get(id);
    if (remote !== undefined)
        return remote;
    return FREE_IDS.has(id);
}
/**
 * 该模型在我们**已实现**的通道里是否存在（协议可达）。
 *
 * ## ⚠️⚠️ 判据改成**远端优先、本地兜底**（Issue IKM9LR 的主缺陷）
 *
 * ### 改前：只有本地表
 *
 * `GET /v1/models` 返回全部 85 个模型，且**不含任何协议信息**（字段只有
 * id/object/created/owned_by）。改前靠 `REACHABLE_IDS` 这张硬编码表来挡
 * `claude-*` / `gemini-*` 等我们**未实现协议**的模型（否则用户点下去只会拿到
 * 404/401/500）—— 但**同一张表也把新上线的免费模型挡掉了**。
 *
 * 真实报障（IKM9LR）：`deepseek-v4.1-flash-free` 与 `glm-5.3-flash-free`
 * 已被 Zen 官方公告免费提供、远端 `/v1/models` **确实下发**，
 * 本插件却因不在表里而在选择器里**完全消失** —— 与「上游没这个模型」同形。
 *
 * ### 改后：models.dev 的 `provider.api` 才是权威
 *
 * 实测（2026-10-17）按 `provider.api` 分组与「我们实现了哪些协议」逐格吻合：
 * `openai/v1` 56 条 ✅ / `anthropic/v1` 17 条 ❌（实测 `/v1/messages` 恒 500）/
 * `google/v1beta` 8 条 ❌（Gemini 原生协议）/ 无该字段 4 条 ⚠️不知道；
 * 而改前那 14 条本地表条目**全部**落在 `openai/v1` 内、零反例。
 *
 * ### 三格语义（缺一不可）
 *
 * | 远端 `provider.api` | 结论 |
 * |---|---|
 * | `openai/v1` | **可达** |
 * | 其它协议 | **不可达** |
 * | **条目缺失** | ⚠️ 不知道 ⇒ **退回本地表**（不是「不可达」） |
 *
 * ⚠️ 第三格是刻意的：`jev-1.13-free` 无条目且实测回
 * `400 ModelProtocolUnsupported`，但**那是一条属于那个模型的实测结论**，
 * 推广成「无条目即不可达」会让未来所有新模型凭空消失。
 *
 * ### ⚠️ 这道闸**管不了**的三样（只能靠运行时错误分类兜）
 *
 * ① 地域封锁：`beam-free` 的 `provider.api` 就是 `openai/v1`，实测 403
 * `RegionError`（按出口 IP 判，目录层无从预知）；
 * ② 上游不稳定：`glm-5.3-flash-free` 实测约 2/5 概率 429；
 * ③ 废弃：`mimo-v2.5-free` 回 410，只要远端还下发就挡不住。
 */
export function isReachableOpencodeModel(id) {
    ensureRemoteTables();
    const remote = remoteReachability?.get(id);
    if (remote !== undefined)
        return remote;
    return REACHABLE_IDS.has(id);
}
/**
 * 远端免费判定的覆盖表（`id → isFree`），由 `opencode-capability.ts` 注入。
 *
 * ⚠️ 与 {@link setRemoteOpencodeReachability} **刻意分开**：两者来自同一次
 * 归一，但语义不同（协议 vs 计价）、失效原因也不同（协议会随我们实现新协议
 * 变，计价只随上游定价变）。合成一个 setter 会让「改协议时顺手改了计价」
 * 成为可能。
 */
let remoteFreeOverride;
/** 注入远端免费判定表（见 {@link setRemoteOpencodeReachability} 的口径）。 */
export function setRemoteOpencodeFreeFlags(table) {
    remoteFreeOverride = table;
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