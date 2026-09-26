/**
 * Cline 产品配置。
 *
 * ## 为什么是**第七套**独立配置
 *
 * Cline 与既有六个 provider **都不同源**，且差异点与任何一个都不重合：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder | trae | **cline** |
 * |------|----------|-----------------|-----------|-------|------|-----------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码 | ExchangeToken | **WorkOS 设备码** |
 * | 续期 | refresh_token | refresh_token | + 身份字段 | + machine_id | refreshToken 轮换 | **`{refreshToken, grantType}`** |
 * | 鉴权头 | SDK-HMAC | Bearer | Bearer | Bearer（WASM 签名头） | Cloud-IDE-JWT | **`Bearer workos:<jwt>`** |
 * | 推理体 | 华为自有 | 腾讯自有 | 有道自有 | WASM 加密 | SOLO 格式 | **标准 OpenAI** |
 *
 * 共用的是架构**模式**（产品差异收敛到单一真相源、账号池、限流切换），
 * 不是任何一个既有 Product 类型 —— 与 Qoder / TRAE 的处理方式一致。
 *
 * ## 数据来源
 *
 * 全部来自本机 Cline 桌面端产物逆向 + 实测（2026-09-25）：
 * - 二进制：`C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
 * - 真实凭据：`C:\Users\Jet\.cline\data\settings\providers.json`
 *
 * 排查脚本（均为只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取
 * 二进制字符串窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
 * `probe-cline-balance.mjs`、`probe-cline-chat.mjs`。
 *
 * 详细取证见 `docs/superpowers/specs/2026-09-25-cline-provider-design.md` §2。
 */
/**
 * 兜底模型目录（内嵌 `BUILTIN_MODEL_CATALOG.cline` 段 + 远端 `free` 数组实测）。
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
 * `deepseek/deepseek-v4.1-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 deepseek」之类的模糊匹配判免费。
 *
 * ⚠️ 远端 `/api/v1/models` 的 460 个 id 里**根本没有 `cline-free/*`**
 * （实测 `Select-String 'cline-free/'` 零命中）—— 免费模型**只**由
 * `recommended-models` 下发。这是「只调 `/models` 会看不到任何免费模型」的原因。
 *
 * ⚠️ 内嵌目录**缺 `cline-free/gemini-3.8-flash`**（远端 `free` 有），
 * 故这里把它补进兜底表；否则离线时用户看不到截图里的那个模型。
 */
const CLINE_FALLBACK_MODELS = [
    // ── 免费模型（远端 `free` 数组实测 2026-09-25，共 5 个）──
    // 这 5 个正是用户截图里的清单。
    {
        id: 'stealth/space-bunny-alpha',
        name: 'Space Bunny Alpha',
        contextWindow: 1_000_000,
        maxTokens: 524_288,
        supportsImage: true,
        isFree: true,
        description: 'Blazing-fast inference with 1M context',
    },
    {
        id: 'cline-free/mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        supportsImage: true,
        isFree: true,
        description: 'Mixture-of-Experts architecture with 309B total parameters',
    },
    {
        id: 'cline-free/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        supportsImage: true,
        isFree: true,
        description: 'Fast and efficient with 1M context window',
    },
    {
        // ⚠️ 内嵌目录里**没有**这一条（只有远端 `free` 数组下发），元数据取自
        // 远端 description + 同名 `google/gemini-3.8-flash` 的目录实测值。
        //
        // ⚠️ **输出上限是 65536，不要照抄其它免费模型的 131072**（真实缺陷，
        // 用户报障 2026-09-25）：给该模型发 `max_tokens=131072` 会被上游的
        // vertex provider 以 400 拒绝 —— "has a maxOutputTokens value of 131072
        // but the supported range is from 1 (inclusive) to 65537 (exclusive)"，
        // 即上限就是 65536，与内嵌目录一致。
        id: 'cline-free/gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        supportsImage: true,
        isFree: true,
        description: "Google's most intelligent Flash model",
    },
    {
        id: 'cline-free/muse-spark-1.3-contributor',
        name: 'Muse Spark 1.3 Contributor',
        contextWindow: 1_048_576,
        maxTokens: 943_718,
        supportsImage: true,
        isFree: true,
        description: 'Meta\u2019s multimodal reasoning model for experimentation, learning, '
            + 'and early-stage agentic, multi-agent, and coding workflows.',
    },
];
/**
 * Cline 全 provider 统一的思考档位（**顺序即 UI 展示顺序**）。
 *
 * ## 为什么所有模型共用一张表
 *
 * 远端**不下发**档位：`/api/v1/models` 只有 `{id, object, created, owned_by}`，
 * `recommended-models` 只有 `{id, name, description, tags}`；sidecar 里
 * `/api/v1/` 的 21 个路径中也没有任何模型详情端点。档位只存在于客户端
 * 内嵌 `BUILTIN_MODEL_CATALOG`，而那张表覆盖不了远端 460 个 id。
 *
 * 故按产品决策对**所有**模型统一给这 5 档。已知局限：对不在内嵌目录里的
 * 模型，档位是猜的 —— 但上游对不认识的档位**静默忽略而不报错**
 * （实测 `reasoning_effort: 'banana'` 返回 HTTP 200 且思考量为 0），
 * 所以最坏情况是「开关无效」，不会是「请求失败」。
 *
 * ## `id` 与 `name` 刻意不同（wire 值 ≠ 展示名）
 *
 * Cline IDE 的档位菜单是 None/Low/Medium/High/**Extra**（用户截图实测），
 * 而上游认的 wire 值是 `none/low/medium/high/max`。最高档的对应关系是
 * **行为实测**出来的，不是从二进制反推的：
 *
 * | effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
 * |---|---|
 * | 不传 / `none` | 0（**不传 = 不思考**） |
 * | `low` | 67 |
 * | `medium` | 379 |
 * | `high` | 294 |
 * | `xhigh` | **259（与 high 无可辨差异 → 伪档位，跳过）** |
 * | `max` | **1192（high 的 4 倍 → 最高档）** |
 *
 * 旁证：sidecar 权重表 `{ max:1, xhigh:0.95, high:0.8, medium:0.5, low:0.2, ... }`
 * 同样确认 `max` 在 `xhigh` 之上。
 *
 * ⚠️ **把 `id` 与 `name` 当成同一个概念会让用户找不到档位** —— 与本项目
 * LobsterAI 那条「wire 值 ≠ 展示名」的教训同源。
 */
export const CLINE_REASONING_EFFORTS = [
    { id: 'none', name: 'None' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Extra' },
];
/**
 * 默认思考档位。
 *
 * ⚠️ **声明它会改变默认行为**：实测「不传 `reasoning_effort` → 模型完全不思考」，
 * 而 `dsh-client-ui-model-selection` 在用户未手动选择时会自动采用
 * `model.reasoning.defaultEffort`（`state.current?.reasoningEffort ?? defaultEffort`）。
 * 即声明后 Cline 从「默认不思考」变成「默认 High 思考」，与 IDE 一致，
 * 代价是思考 token 计入 `completion_tokens`。这是**用户明确要求**的变更。
 */
export const CLINE_DEFAULT_REASONING_EFFORT = 'high';
/** Cline provider 配置（生产环境）。 */
export const CLINE = {
    id: 'cline',
    displayName: 'Cline',
    apiBase: 'https://api.cline.bot',
    appBase: 'https://app.cline.bot',
    workOsBase: 'https://api.workos.com',
    workOsClientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
    clientHeaders: {
        'HTTP-Referer': 'https://cline.bot',
        'X-Title': 'Cline',
        'X-IS-MULTIROOT': 'false',
        'X-CLIENT-TYPE': 'cline-sdk',
    },
    tokenPrefix: 'workos:',
    defaultCredentialRef: 'CLINE_ACCESS_TOKEN',
    fallbackModels: CLINE_FALLBACK_MODELS,
};
/** 全部 Cline 产品配置（当前只有一个，保留数组以便将来扩展 staging）。 */
export const ALL_CLINE_PRODUCTS = [CLINE];
/** 按 provider id 取 Cline 产品配置；未知 id 返回 undefined。 */
export function clineProductById(id) {
    return ALL_CLINE_PRODUCTS.find((product) => product.id === id);
}
// ── 端点路径常量 ──
// 抽成常量而非散落字面量：登录、续期、模型、余额四处都要用，
// 且它们**全部挂在 `apiBase` 下**（WorkOS 那两个例外，挂 `workOsBase`）。
/** 设备码授权（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHORIZATION_PATH = '/user_management/authorize/device';
/** 设备码 token 轮询（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHENTICATE_PATH = '/user_management/authenticate';
/** 注册 WorkOS token（换 Cline 自己的 token，挂 `apiBase`）。 */
export const CLINE_REGISTER_PATH = '/api/v1/auth/register';
/** 续期（挂 `apiBase`）。 */
export const CLINE_REFRESH_PATH = '/api/v1/auth/refresh';
/** 推理（OpenAI 兼容，挂 `apiBase`）。 */
export const CLINE_CHAT_PATH = '/api/v1/chat/completions';
/** 全量模型 id 列表（挂 `apiBase`）。 */
export const CLINE_MODELS_PATH = '/api/v1/models';
/** 推荐模型（含 **`free` 数组**，挂 `apiBase`，**无需认证**）。 */
export const CLINE_RECOMMENDED_MODELS_PATH = '/api/v1/ai/cline/recommended-models';
/** 账号信息（挂 `apiBase`）。 */
export const CLINE_ME_PATH = '/api/v1/users/me';
//# sourceMappingURL=cline-product.js.map