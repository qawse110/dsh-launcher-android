/**
 * Codely（Unity 团结引擎）产品配置。
 *
 * ## 数据来源（2026-10-20，真实凭据实测 + 官方客户端逆向）
 *
 * - **模型目录**：`GET https://codely.tuanjie.cn/api/model-status`（Bearer
 *   access_token）→ 200，报文形如：
 *
 *   ```json
 *   { "windowStart": "…", "stale": false, "scope": "public", "seriesHours": 24,
 *     "models": [ { "modelGroup": "codely-basic", "tokPerS": 101.3,
 *                   "errorPct": 0.3, "ttftP90S": 4.5, "requestCount": 3036,
 *                   "status": "operational", "trend": [...] }, … ] }
 *   ```
 *
 *   ⚠️ 它是**运行状态**端点（健康页同源），不是 `/v1/models`：给出的是
 *   `modelGroup`（= 可直接当模型 id 用，官方 CLI 的 `-m codely-basic` 实测
 *   可推理）与 `status`（`operational` / `degraded` / `outage`）。
 *   ⇒ 本插件把它当**目录来源**用时，只取 `modelGroup`，**不把 `status`
 *   拼进模型名**：状态是分钟级波动的运行态，拼进 `name` 会让目录与
 *   `resolveModel` 的显示名漂移（两份名字不同源是仓库记过的缺陷形态）。
 *
 * - **推理网关**：`https://codely-litellm.tuanjie.cn/v1`（OpenAI 兼容），
 *   鉴权为 `sk-` CLI API Key + `X-Codely-Signature`（HMAC 签名）。
 *   ⚠️ **签名密钥尚未取得**（见 `codely-adapter.ts` 模块头），故本渠道
 *   当前**只有目录、没有推理**。
 *
 * ## 为什么是独立接口（平行而非继承）
 *
 * 与 `TraeProduct` / `OfficeAceProduct` 同款处理：Codely 的目录端点与鉴权
 * 形态都与其余家不同源（Bearer + 状态页目录，而不是 OpenAI `/v1/models`），
 * 共用的是架构模式（产品差异收敛到单一真相源），不是那个类型。
 */
/**
 * 兜底模型目录（8 个，**逐字来自 `/api/model-status` 实测**）。
 *
 * ⚠️ `name` 一律取 `modelGroup` 原样值：上游没有下发任何展示名，按本仓库
 *   「绝不编造」红线，不写「Codely 基础版」这类看似官方的中文假名。
 *
 * ⚠️ **不声明 `contextWindow` / `maxTokens`**：官方客户端配置里确有
 *   `context=202752` / `maxTokens=16384`，但那是**全局默认**（出现在
 *   `remote-*.yaml` 顶层，不是逐模型下发）⇒ 逐模型照抄等于把默认值编造成
 *   该模型的能力。未知即不声明（与 `officeace-adapter.ts` 同一取舍）。
 *
 * ⚠️ 8 个里 `KIMI-K3` / `codely-vl` 实测为 `outage`、`codely-core` 为
 *   `degraded` —— **仍然全量列出**：状态是波动的运行态，目录因临时故障
 *   隐藏模型会让「模型消失」与「模型下架」同形（仓库记过的缺陷形态）。
 */
export const CODERLY_FALLBACK_MODELS = [
    { id: 'codely-core', name: 'codely-core' },
    { id: 'codely-basic', name: 'codely-basic' },
    { id: 'codely-flash', name: 'codely-flash' },
    { id: 'codely-air', name: 'codely-air' },
    { id: 'codely-vl', name: 'codely-vl' },
    { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'GLM-5.3-FLASH', name: 'GLM-5.3-FLASH' },
    { id: 'KIMI-K3', name: 'KIMI-K3' },
];
/** Codely provider 配置。 */
export const CODERLY = {
    id: 'codely',
    displayName: 'Codely (Unity)',
    apiBase: 'https://codely.tuanjie.cn',
    modelStatusPath: '/api/model-status',
    chatHost: 'https://codely-litellm.tuanjie.cn/v1',
    userAgent: 'codely-vscode/4.3.0',
    fallbackModels: CODERLY_FALLBACK_MODELS,
};
//# sourceMappingURL=codely-product.js.map