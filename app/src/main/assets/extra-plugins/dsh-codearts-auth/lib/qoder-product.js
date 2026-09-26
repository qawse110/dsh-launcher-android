/**
 * Qoder 产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * Qoder 的协议与现有四个 provider **都不同源**：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder |
 * |------|----------|-----------------|-----------|-------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码轮询 |
 * | 续期 | refresh_token | refresh_token | refresh_token + 身份字段 | refresh_token + machine_id |
 * | 签名 | HMAC-SHA256 | 无 | 无 | 无（推理） |
 *
 * 且 `BuddyProduct.id` 是字面量联合 `'buddy' | 'workbuddy'`，加值会牵动
 * `productById` / `registerBuddyLlm` 一串调用点。故这里定义**平行**的
 * `QoderProduct` —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * 全部来自本机 Qoder 0.3.4 产物逆向 + 实测，详见
 * `docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 * 逆向目标：
 * - `C:\Users\Jet\AppData\Local\Programs\Qoder\resources\app.asar`
 * - `...\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
 *   （字符串经 `_$d = base64 → XOR("tqrRVttEZQ4G")` 编码）
 */
/**
 * 模型目录（**实测数据**，2026-09-20）。
 *
 * ## `id` 是目录 key，且**必须走加密端点**
 *
 * 这些 key（`qfmodel` / `dmodel` / …）是 Qoder 客户端的**真实模型标识**，
 * 但公开的 `/model/v1/chat/completions` **不认它们**：
 *
 * ```
 * {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\""}
 * ```
 *
 * 客户端真实推理走**加密端点**（见 `src/qoder-wasm.ts`）：
 * ```
 * POST {host}/algo/api/v2/service/pro/sse/agent_chat_generation
 *      ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * body: <WASM 加密>
 * ```
 * 该端点**认这些 key**（实测 17 个全部可用）。
 *
 * ⚠️ 但请求体**必须带 `business` 字段**（见 `src/qoder-adapter.ts`）：
 * 缺了服务端会把请求路由到故障节点 `oa_qwen-plus-2025-04-28` 并返回
 * `[FAIL]node:... msg:Execution failed`。`qfmodel` 曾因此被误判为
 * 「服务端故障」（而 IDE 里同一模型完全正常）。
 *
 * ## ⚠️ 两套名字不可混用（踩过两次的坑）
 *
 * | 名字来源 | 示例 | 用途 |
 * |---|---|---|
 * | **目录 key**（本表） | `qfmodel` / `dmodel` | **加密端点**的 `model` 字段 |
 * | 通用名 | `qwen-flash` / `qwen-plus` | 公开端点的 `model` 字段（**不是**同一批模型） |
 *
 * 早期误把目录 key 发给公开端点 → `Unsupported model`；
 * 又误以为只有 11 个可用 → 表里换成通用名，结果拿到的是 Qwen3.5/2.5
 * 而非 Qwen3.8 系列（用户报障）。
 *
 * ## 数据来源
 *
 * 从本机 Qoder 的 `~/.qoder/.models/{uid}/catalog-v6` 解密取得
 * （`model_cache_decrypt`），字段逐项实测。
 *
 * ## 字段口径
 *
 * - `contextWindow`：目录 `max_input_tokens`。
 * - `supportsImage`：目录 `is_vl`（实测全为 true）。
 * - `supportsThinking`：目录 `is_reasoning`。
 * - `isFree`：目录 `is_free`（仅 Qwen3.8-Max / Qwen3.8-Flash）。
 * - `priceFactor`：目录 `price_factor`（**实测 2026-09-21，逐条对照本机
 *   catalog-v6 的 `chat` 场景**）。注意 `qfmodel` 的值是 **0**（免费），
 *   0 是合法值不能当缺失处理。
 * - `originalPriceFactor`：目录 `original_price_factor`（仅部分模型下发）。
 * - `promotion`：目录 `promotion`（错峰折扣，三档实测）。
 * - `efforts`：目录 `thinking_config.enabled.efforts` 的键。
 */
const QODER_FALLBACK_MODELS = [
    // ⚠️ 全部数值逐条对照本机 catalog-v6 实测（2026-09-21）。早期版本多处为
    // 手工估值，与真实值**大范围不符**（14 个模型有偏差，如 `smodel` 写 3.2
    // 实际 8、`qmodel_38max` 写 0.5 实际 0.2），用户据此报障。
    // 改动本表时必须重新对照 catalog，不要凭印象填。
    //
    // 字段顺序：id, 展示名, 上下文, vl, reasoning, free, 倍率
    { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
    { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
    // ⚠️ `is_reasoning: false` 但 `thinking_config.enabled` 为真 —— 上游确实
    // 提供档位选择，故 `efforts` 保留；而请求体的 `isReasoning` 取 `is_reasoning`。
    { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
    { id: 'efficient', name: 'Efficient', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
    { id: 'smodel', name: 'Sonus', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
    { id: 'cmodel', name: 'Cantus', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
    // 免费额度模型（is_free=true）：e2e 探针默认用它们以免消耗积分。
    // ⚠️ `priceFactor` 是**采集时刻的生效价**（窗口内为折后价），原价在
    // `promotion.beforePromotionPriceFactor`；展示时本地推算当前价。
    {
        id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 180_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'],
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    },
    {
        // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失 —— 见接口注释。
        id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 180_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'],
    },
    {
        id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
        priceFactor: 0.1, originalPriceFactor: 0.5,
        promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 2 折' },
    },
    {
        id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
        priceFactor: 0.04,
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    },
    { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 180_000, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ['high', 'low', 'max'] },
    // ⚠️ 该模型**未下发 `max_input_tokens`**，此处取 `context_config` 里
    // `is_default: true` 的那档（200K）。
    { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ['high', 'low', 'max'] },
    { id: 'gmodel', name: 'GLM-5.3', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'] },
    { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'] },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'] },
    { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'] },
    { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 180_000, supportsImage: true, supportsThinking: false, priceFactor: 0.2 },
];
/** Qoder provider 配置（国际版）。 */
export const QODER = {
    id: 'qoder',
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    inferBase: 'https://api2-v2.qoder.sh',
    encryptedInferBase: 'https://api2.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    testClientId: 'e93fe488-5778-4c35-a6fc-0f54ed7b3139',
    clientMetadata: {
        client_type: '5',
        business_product: 'cli',
        business_type: 'agent',
        scene: 'assistant',
    },
    // 官方桌面客户端身份（源码常量 `Mh.clientType`）。仅用于 `/sash/` 端点。
    sashClientType: '10',
    userAgentPrefix: 'qoder',
    defaultCredentialRef: 'QODER_ACCESS_TOKEN',
    fallbackModels: QODER_FALLBACK_MODELS,
};
/** 全部 Qoder 产品配置（当前只有一个，保留数组以便将来扩展中国版）。 */
export const ALL_QODER_PRODUCTS = [QODER];
/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 分开：
 * 三者返回**不同类型**，合并会让调用方拿到联合类型后不得不做类型收窄。
 */
export function qoderProductById(id) {
    return ALL_QODER_PRODUCTS.find((product) => product.id === id);
}
//# sourceMappingURL=qoder-product.js.map