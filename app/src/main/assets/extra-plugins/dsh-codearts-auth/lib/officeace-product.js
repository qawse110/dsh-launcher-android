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
 *
 * ## ⚠️⚠️ `contextWindow`：初版全是**估值**，2026-10-15 真机取证后逐项改正
 *
 * 初版这一列没有任何实测依据：GLM 三行的 `202_752` 与 CodeArts 表里的 `GLM-5.2`
 * **逐字相同**（见 `llm-adapter.ts` 的 `CONTEXT_WINDOWS`），`deepseek-v4.1-flash`
 * 的 `196_608` 则查无出处。实测它**比真实上限小 5.3 倍** —— 后果不是报错而是
 * **静默降级**：DSH 的自动压缩阈值是 `0.8 × contextWindow ≈ 157K`
 * （`dsh-compaction-basic`），于是上下文一涨到 157K 就被压缩，
 * **1M 的能力永远吃不到**（用户报障「上下文窗口是不是设错了」的根因）。
 *
 * 取证**不必穷举**：故意发一个远超上限的 prompt，上游在**推理前**就拒绝，
 * 并在报文里**自报上限**（被拒请求不产生生成费用）。另用**针尖试验**交叉验证：
 * 密码放最**头部**、提问放最**尾部**，`prompt_tokens = 1_020_054` 时模型仍
 * **准确答出**密码 ⇒ 不只是「请求被接受」，也**不是**网关静默截断头部。
 *
 * | 模型 | 上游原话（`POST {maasBaseUrl}/v2/chat/completions`） | 取值 |
 * |---|---|---|
 * | `deepseek-v4.1-flash` | `input token limit is 1048576` | `1_048_576` |
 * | `deepseek-v4-flash` | `… must less than the maximum input length 1044480` | `1_044_480` |
 * | `glm-5.2` | 同上句式，`1044480` | `1_044_480` |
 * | `glm-5.1` | 同上句式，`196608` | `196_608` |
 * | `kimi-k2.6` | 同上句式，`262144` | `262_144` |
 * | `qwen3-32b` / `qwen3-30b-a3b` | `maximum context length is 131072 tokens` | `131_072`（**原值即正确**）|
 * | `glm-5.3` | 只回 `Prompt exceeds max length`，**不给数** ⇒ 改走**夹逼**（见下）| `1_048_576` |
 *
 * ⚠️ `glm-5.3` 是唯一**不给数**的模型，故用**夹逼**取证（2026-10-15 实测）：
 * `1_200_004` 拒、`1_050_038` 拒、**`1_048_025` 接受（200）**
 * ⇒ 上限落在 `(1_048_025, 1_050_038]`，区间宽 2_013 且**只含一个整数兆**
 * （1 MiB = `1_048_576`）⇒ 取值确定。
 * ⚠️ 它的**针尖问句没判成**：`glm-5.3` 是思考型模型，`max_tokens` 被
 * `reasoning_content` 吃满后 `content` 恒为空 —— 那是**判分口径**问题不是截断
 * （探针的输出预算已从 128 提到 2048），窗口结论**不依赖**针尖。
 *
 * ⚠️ 填的是**输入上限**（上游措辞就是 `input token limit`），而 DSH 的
 * `contextWindow` 是「输入 + 输出」的总容量 ⇒ 这样填是**偏保守**的：
 * 压缩阈值稳稳落在上游硬限之下。
 * ⚠️ `/v2/models` **不返回任何窗口元数据**，故上表是这一列**唯一**的依据；
 * 上游改值只能靠重跑探针发现（脚本见 `docs/agent-notes/providers-officeace.md`）。
 *
 * ⚠️ `maxTokens` 同样能自报：`deepseek-v4.1-flash` / `deepseek-v4-flash` 是
 * `max_tokens range is [1, 393216]`，GLM 三兄弟是 `[0, 131072]`，
 * `kimi-k2.6` 连 `2_000_000` 都不拒（**未取到上限**，故留保守值）。
 * 但 ⚠️ **目前没有任何代码读 `maxTokens`**（`resolveModel` 只下发 `contextWindow`
 * 与模态）⇒ 它是**死字段**，填了不生效；要用得先接 `defaultMaxTokens`。
 */
export const OFFICEACE_MODELS = [
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 131_072 },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_044_480, maxTokens: 131_072 },
    { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 196_608, maxTokens: 131_072 },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxTokens: 393_216, multimodal: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_044_480, maxTokens: 393_216 },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 262_144, maxTokens: 131_072, multimodal: true },
    { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: 131_072, maxTokens: 65_536 },
    { id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', contextWindow: 131_072, maxTokens: 65_536 },
];
/** 单模型上限兜底（目录未返回时用）。 */
export const FALLBACK_CONTEXT_WINDOW = 131_072;
//# sourceMappingURL=officeace-product.js.map