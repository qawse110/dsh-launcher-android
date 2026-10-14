/**
 * OfficeAce（华为 ModelArts MaaS 办公助手）产品配置。
 *
 * ## 架构：与 AutoClaw 相反，**直连云端可行**
 *
 * AutoClaw 的上游被阿里云 WAF 锁死（拦 `X-Authorization`），必须经本机网关。
 * OfficeAce 相反：它本地 `127.0.0.1:3004` 的 API 是**明文 JS**（`packages/api/dist`），
 * 鉴权逻辑白纸黑字，云端端点接受标准 HTTP 鉴权 ⇒ **纯 Node 直连即可**。
 *
 * ## 鉴权（2026-10-12 实测打通）
 *
 * ```
 * Authorization: Basic base64(model_app_key + ":" + model_app_secret)
 * ```
 *
 * 凭据存放链（全部本机可读，无需 OfficeAce 运行）：
 *
 * 1. **Redis 6399**（OfficeAce 内置，密码在 Windows 凭据管理器
 *    `OfficeClaw/redis/password`，同一 Windows 用户可直接 `CredRead`）；
 * 2. 键 `office-claw:oc:session:user:<userId>` 的 JSON 里
 *    `providerState.modelInfo.model_auth_info.model_app_key|model_app_secret`；
 * 3. 华为 OAuth `refresh_token` 也在同一 JSON（`providerState.credential`，
 *    实测有效期 30 天），到期可静默续期。
 *
 * ## 模型
 *
 * `/v2/models` 返回 11 个：GLM-5.1/5.2/5.3、DeepSeek-V4(.1)、Qwen3(30B/32B)、
 * Kimi-K2.6、盘古 2.0（pro/flash）。实测 `toolCallingSupported: true`。
 *
 * ⚠️ 端点返回 **`reasoning_content`**（思考链独立字段），流式解析需兼容。
 */
/** 华为 MaaS 端点（OfficeAce 预置账号走这个代理域）。 */
const DEFAULT_BASE_URL = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com';
/** 官方 MaaS 直连域（`/v2/models` 同样可用）。 */
export const OFFICIAL_MAAK_BASE_URL = 'https://api.modelarts-maas.com';
export const OFFICEACE = {
    id: 'officeace',
    displayName: 'OfficeAce',
    quotaUnit: 'Token',
    defaultBaseUrl: DEFAULT_BASE_URL,
    chatPath: '/v2/chat/completions',
    modelsPath: '/v2/models',
    requestTimeoutMs: 600_000,
    headerTimeoutMs: 180_000,
    chunkTimeoutMs: 300_000,
};
/**
 * DSH 侧暴露的模型（精选常用的 8 个；全部 11 个里 2 个 test 档不暴露）。
 *
 * ⚠️ 网关 `/v2/models` 返回的是平台目录，**不保证该账号已订阅**——但预置账号
 * 实测全目录可用（2026-10-12 仅测 glm-5.2，其余按目录暴露）。
 *
 * ## `multimodal`（2026-10-13 实测）
 *
 * `/v2/models` **不返回任何能力元数据**（只有 id），故逐个用 1×1 红色 PNG 以
 * 标准 OpenAI `image_url` parts 实测（`probe-image.js` / `probe-image2.js`）：
 *
 * | 模型 | 图片输入 | 证据 |
 * |---|---|---|
 * | `deepseek-v4.1-flash` | ✅ | HTTP 200，正常描述图片内容 |
 * | `kimi-k2.6` | ✅ | HTTP 200，正常描述图片内容 |
 * | `deepseek-v4-flash` | ❌ | 400 ModelArts.81001 参数校验失败 |
 * | `glm-5.3` / `5.2` / `5.1` | ❌ | 400 ModelArts.81001（content[1] 字段不认） |
 * | `qwen3-32b` / `30b-a3b` | ❌ | 400 「is not a multimodal model」（服务端明说） |
 *
 * ⚠️ 此表是 **DSH 图片准入闸门**的依据（`listModels` 的 `inputModalities`）：
 * 不声明 `image` 时附件在入库阶段就被拒。漏报只是少个功能；**误报**会让
 * 用户选了不支持图片的模型却收到含图请求 —— 上游 400，一轮对话报废。
 * 故只登记**实测通过**的，未测的宁可漏报。
 */
export const OFFICEACE_MODELS = [
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 202_752, maxTokens: 131_072 },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202_752, maxTokens: 131_072 },
    { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 202_752, maxTokens: 131_072 },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 196_608, maxTokens: 131_072, multimodal: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 196_608, maxTokens: 131_072 },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 196_608, maxTokens: 131_072, multimodal: true },
    { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: 131_072, maxTokens: 65_536 },
    { id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', contextWindow: 131_072, maxTokens: 65_536 },
];
/** 单模型上限兜底（目录未返回时用）。 */
export const FALLBACK_CONTEXT_WINDOW = 131_072;
//# sourceMappingURL=officeace-product.js.map