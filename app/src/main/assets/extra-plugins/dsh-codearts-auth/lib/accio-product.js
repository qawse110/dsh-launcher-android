/**
 * Accio（阿里 Accio Work）provider 的产品配置 —— **唯一真相源**。
 *
 * ## 与其它 product 的形态关系
 *
 * 与 `LobsteraiProduct` / `TraeProduct` / `MinimaxProduct` **平行而非继承**：
 * 那些字段全部围绕各自协议设计，对 Accio 无一有意义。
 *
 * ## 区域（`cn` / `global`）
 *
 * ⚠️ **gateway 恒同一个**（`phoenix-gw.alibaba.com`），与区域无关；
 * 只有**登录页域名**不同。区域由服务端按账号下发（`userinfo.routeRegion`，实测 `CN`）。
 * 故区域是**登录参数**，不是第二个 provider id（用户 2026-10-12 裁定）——
 * 这也避免了「两个 provider 共用同一 gateway」给用户带来的困惑。
 *
 * ## 数据来源
 *
 * 全部来自 2026-10-12 的逐字逆向（`app.asar`）与本机实测。
 * 详见 `docs/agent-notes/providers-accio.md`。
 */
// ── 端点路径 ────────────────────────────────────────────────────────────
export const ACCIO_TOKEN_EXCHANGE_PATH = '/api/oauth/token';
export const ACCIO_REFRESH_PATH = '/api/auth/refresh_token';
export const ACCIO_LLM_PATH = '/api/adk/llm/generateContent';
export const ACCIO_CATALOG_PATH = '/api/llm/config/v2';
export const ACCIO_USERINFO_PATH = '/api/auth/userinfo';
export const ACCIO_SUBSCRIPTION_PATH = '/api/entitlement/currentSubscription';
export const ACCIO_QUOTA_PATH = '/api/entitlement/quota';
// ── 超时 ────────────────────────────────────────────────────────────────
export const ACCIO_REQUEST_TIMEOUT_MS = 30_000;
/** 登录等待回调的上限（10 分钟，与 trae 同量级）。 */
export const ACCIO_LOGIN_TIMEOUT_MS = 600_000;
export const ACCIO_REGIONS = Object.freeze(['cn', 'global']);
const LOGIN_BASE = Object.freeze({
    cn: 'https://www.accio-ai.com',
    global: 'https://zh.accio.com',
});
/**
 * 兜底模型表 —— **2026-10-12 实测的 15 个可见模型**，按倍率升序。
 *
 * ⚠️ 只作**离线回退**：`modelCode` 非人类可读，无法凭名字手写维护，
 * 远端目录永远是首选（见 `accio-adapter.ts` 的 `listModels`）。
 */
const FALLBACK_MODELS = Object.freeze([
    { id: '1Drift-N8kP2Q7wR5mX', name: 'Qwen 3.8 27B', contextWindow: 512_000, supportsImage: true, multiple: 0.013 },
    { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
    { id: '1Chronos-F53X9nQ3rT8w', name: 'GLM 5.3 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
    { id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.045 },
    { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
    { id: '1Chronos-dX3cV9sA2mK7', name: 'GLM 5.1', contextWindow: 200_000, supportsImage: false, multiple: 0.12 },
    { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
    { id: '1Drift-A3bM5nK8pQ2w', name: 'Qwen 3.5 A3B', contextWindow: 256_000, supportsImage: false, multiple: 0.13 },
    { id: '1Synapse-G5aJ8wL1dV4s', name: 'Kimi K2.6', contextWindow: 256_000, supportsImage: true, multiple: 0.14 },
    { id: '1Chronos-L53W8nP2qR6m', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
    { id: '1Chronos-G5p2V9sA2mK7', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
    { id: '1Nova-bW7yT4kL9pN2', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsImage: false, multiple: 0.17 },
    { id: '1Drift-T3TB6WS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1_000_000, supportsImage: true, multiple: 0.44 },
    { id: '1Orbit-I9eY4tK8bW1f', name: 'Professional', contextWindow: 1_000_000, supportsImage: true, multiple: 1 },
    { id: '1Orbit-Q7hN3xR6cP2m', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
]);
export const ACCIO = {
    id: 'accio',
    displayName: 'Accio (阿里)',
    gatewayBaseUrl: 'https://phoenix-gw.alibaba.com',
    loginBaseUrlOf(region) {
        return LOGIN_BASE[region] ?? LOGIN_BASE.cn;
    },
    clientId: 'accio-work',
    defaultCredentialRef: 'ACCIO_ACCESS_TOKEN',
    appKey: 'OneChat',
    appVersion: '0.34.4',
    fallbackModels: FALLBACK_MODELS,
};
//# sourceMappingURL=accio-product.js.map