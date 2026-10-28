/**
 * TRAE（字节跳动 TRAE IDE）产品配置。
 *
 * ## 数据来源
 *
 * 基于对 `E:\Workplace\APP\Golang\trae2api` 的逆向分析（2026-08），
 * 以及上游项目 `Sliverkiss/traework2api` 的实测结果。
 *
 * - API 端点：`trae2api/internal/upstream/constants.go`（实测可用的 SOLO 免费通道）；
 * - 客户端常量：同一文件，版本号 `0.1.52` / `20260811` 为实测可获取 glm-5.3 的最低版本；
 * - 兜底模型表：`trae2api/internal/server/handler.go:247-280` 的 staticModels；
 * - 登录 URL 格式：`trae2api/internal/server/login.go` 的 `BuildLoginURL`。
 *
 * ## 为什么是独立接口而非复用 BuddyProduct/LobsteraiProduct
 *
 * TRAE 与二者都不同源：
 * - 与 BuddyProduct 差异：认证用 ExchangeToken（轮换 refreshToken）而非 external-link 轮询；
 *   请求头用 `Cloud-IDE-JWT` 而非 `Bearer`；chat 端点需要 payload 格式转换；
 *   SSE 格式自定（非 OpenAI 标准），需独立解析。
 * - 与 LobsteraiProduct 差异：chat 端点使用 POST + JSON body + 自定义 SSE；
 *   认证协议不同（OAuth code + ExchangeToken，non-localhost 可回调）；
 *   凭据中需持久化 machine_id/device_id 等设备指纹。
 *
 * 因此这里定义**平行**的 `TraeProduct`：共用的是架构模式（产品差异收敛到单一真相源），
 * 不是那个类型。
 */
/** 上游 API 基址（Agent 服务）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru';
/** 签到/积分/Ug 基址。 */
export const TRAE_UG_HOST = 'https://api.trae.cn';
/** OAuth/认证基址。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn';
/** 登录门户基址。 */
export const TRAE_CONSOLE_HOST = 'https://www.trae.cn';
/**
 * 兜底模型目录（32 个，对齐 Go 端 staticModels）。
 *
 * 来源：`handler.go:247-280`，2026-08 实测快照。
 * 顺序照抄 Go 端，不重排。远端可用时完全采信远端，本表只在远端整体失败时顶替。
 */
const TRAE_FALLBACK_MODELS = [
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
    { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
    { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
    { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
    { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
    { id: 'browser_use_subagent', name: 'Browser Use Subagent', contextWindow: 200_000, isHidden: true },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
    { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
    { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
    { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
    { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
    { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
    { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
    { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
    { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
    { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200_000 },
    { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200_000 },
    { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200_000 },
    { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200_000 },
    { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200_000 },
    { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200_000 },
    { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200_000 },
    { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200_000 },
    { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200_000 },
    { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200_000 },
    { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200_000 },
    { id: 'explore_sub_agent_v13', name: 'Explore Sub Agent V13', contextWindow: 200_000, isHidden: true },
    { id: 'explore_sub_agent_v2', name: 'Explore Sub Agent V2', contextWindow: 200_000, isHidden: true },
    { id: 'summary', name: 'Summary', contextWindow: 200_000, isHidden: true },
];
/**
 * **可调用通道白名单**（顺序即优先级，详见 `TraeProduct.channels` 的注释）。
 *
 * 内容来自逐通道实测（2026-10-04）：只放行在
 * `/api/agent/v3/llm_utils_chat` 下真正可调用的 15 个 function。
 * `chat` / `builder` / `inline_chat` 实测稳定被拒，**不得**放入；
 * `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils`
 * 目录恒空，放进来也无意义。
 *
 * 前三条是通用通道（官方 Auto Mode 用的就是它们），其余为专用通道：
 * - `solo_agent`：**首位**，对应 Auto Mode 的模型列表，包含最多的模型
 *   （实测 18 条）与 `display_contact_config` / `reasoning_effort_config`。
 * - `solo_work_lite`：本项目既有通道。⚠️ 历史注释说 `glm-5-turbo` / `sagitta`
 *   在此可用 —— 那两个模型**已从目录下架**（2026-10-04 实测不在任何通道里），
 *   该说法是过期快照，不要据此断言。
 * - `solo_agent_remote`：补上 agent 专有模型（`glm-5.1` / `kimi-k2.7-code` 等）。
 *
 * 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖。
 */
export const TRAE_CHANNELS = resolveChannelList(process.env.DSH_TRAE_CHANNELS);
/** 解析 `DSH_TRAE_CHANNELS`；空/非法时回退默认通道列表。 */
function resolveChannelList(raw) {
    const fallback = [
        // ── 通用通道（顺序即优先级）──
        'solo_agent',
        'solo_work_lite',
        'solo_agent_remote',
        'solo_work_remote',
        'solo_agent_lite',
        // ── 专用通道（只有通用通道都不含某模型时才会命中）──
        'chat_v3',
        'builder_v3',
        'solo_coder',
        'solo_design_lite',
        'solo_design_remote',
        'git_ai',
        'code_reviewer',
        'code_review_summary',
        'multimodal',
        'system_diagnosis',
    ];
    if (raw === undefined)
        return fallback;
    const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    return parsed.length > 0 ? parsed : fallback;
}
/** 解析布尔型开关环境变量；只有显式真值才算开启。 */
function isTruthyFlag(raw) {
    if (raw === undefined)
        return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}
/**
 * 解析 `DSH_TRAE_MAX_MODE`；**默认开启**（用户要求「上下文用最大的那一档」）。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭 —— 与
 * `isTruthyFlag` 的「默认关」语义相反，故单列一个函数，不要混用。
 */
function resolveMaxModeFlag(raw) {
    if (raw === undefined)
        return true;
    const value = raw.trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}
/**
 * 解析 `DSH_TRAE_MAX_MODELS` 白名单。
 *
 * 留空返回 `undefined`（而非空数组）：空数组在下游是「白名单存在但什么都不匹配」
 * 的语义，会把 Max 模式**全部**关掉，与「留空 = 全部生效」相反。
 */
function resolveMaxModeModels(raw) {
    if (raw === undefined)
        return undefined;
    const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    return parsed.length > 0 ? parsed : undefined;
}
/**
 * TRAE provider 配置。
 */
export const TRAE = {
    id: 'trae',
    displayName: 'TRAE (字节)',
    agentHost: TRAE_AGENT_HOST,
    ugHost: TRAE_UG_HOST,
    oauthHost: TRAE_OAUTH_HOST,
    consoleHost: TRAE_CONSOLE_HOST,
    clientId: 'en1oxy7wnw8j9n',
    appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    deviceBrand: 'Apple',
    osVersion: 'macOS 15.7.4',
    function: 'solo_work_lite',
    channels: TRAE_CHANNELS,
    fallbackMaxOutputTokens: 32_000,
    maxMode: resolveMaxModeFlag(process.env.DSH_TRAE_MAX_MODE),
    maxModeModels: resolveMaxModeModels(process.env.DSH_TRAE_MAX_MODELS),
    hideInternalModels: isTruthyFlag(process.env.DSH_TRAE_HIDE_INTERNAL),
    pluginVersion: '2.3.62834',
    defaultCredentialRef: 'TRAE_ACCESS_TOKEN',
    userAgent: 'Trae/0.1.52',
    fallbackModels: TRAE_FALLBACK_MODELS,
};
//# sourceMappingURL=trae-product.js.map