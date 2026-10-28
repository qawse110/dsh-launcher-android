/**
 * ModelScope（魔搭）的凭据结构、过期判定、请求头与模型 id 处理。
 *
 * ## 凭据形态
 *
 * 魔搭用的是**长期 API Key**（控制台「访问令牌」页生成，形如
 * `ms-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），**没有 refresh 端点** ——
 * 与 ZCode / Loomy 同属「凭据是静态材料」那一类，与 codearts / buddy / qoder /
 * trae / cline / raccoon / minimax / gemini 的 OAuth 续期链**不同源**。
 *
 * 旧 fork 的凭据存法（`src/proxy/upstream-config.ts` 的
 * `credentialRefForUpstream`）是**裸字符串**或 **JSON 数组**（号池）：
 *
 * ```ts
 * // 旧 fork index.ts:104-115
 * const raw = resolved.value.trim()
 * if (raw.startsWith('[')) { …号池… } else if (raw.length > 0) { upstreamKeys.set(cfg.name, [raw]) }
 * ```
 *
 * 那种形态**只服务于反代**（`buildRemoteUpstreams` 需要同步拿 key 列表），
 * 而上游 0.2.0-rc.3 **没有反代** —— 账号由 `AccountPool` 管理、凭据经
 * `ctx.credentials` 按 ref 解析。
 * ⇒ 本实现采用**上游统一形态**：一条账号一份 JSON 凭据。
 *
 * ## ⚠️ 字段名必须是 `access_token`
 *
 * `AccountPool.findAccountIdByCredential` 对**非 codearts** 的 provider
 * 统一取 `access_token` 作身份标识（`src/account-pool.ts:1271`）：
 *
 * ```ts
 * const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
 * ```
 *
 * 若这里改名成 `api_key`（opencode 那种写法），限流记录的账号归属会**恒匹配
 * 失败且静默** —— 重测/重置按钮清不掉任何标记。故**沿用 `access_token`**。
 *
 * `docs/adding-a-new-provider.md` 的检查清单把这条写成了硬性要求：
 * 「非 `codearts` 的 provider 凭据含 `access_token` 字段」。
 *
 * @module src/modelscope.ts
 */
import { MODELSCOPE } from './modelscope-product.js';
/**
 * 解析凭据里的过期时刻（毫秒）。
 *
 * ⚠️ **读取时兼容秒级时间戳**（`> 1e12` 视为毫秒，否则视为秒）——
 * 与 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。不兼容会让
 * 「上游/历史误写成秒」的值被当成 1970 年 ⇒ **恒判已过期**、无谓续期。
 *
 * @returns 毫秒时间戳；字段缺失或不可解析时 `undefined`。
 */
export function modelscopeCredentialExpiresAtMs(credential) {
    const raw = credential?.expires_at;
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return undefined;
    // 秒级（10 位）与毫秒级（13 位）的分界取 1e12。
    return parsed > 1e12 ? parsed : parsed * 1000;
}
/**
 * 凭据是否已过期。
 *
 * ⚠️⚠️ **没有 `expires_at` 时恒返回 `false`（= 未过期），这不是省事。**
 *
 * 魔搭的 API Key 默认长期有效，凭据里因此通常**根本没有过期时间**。若把
 * 「读不到」判成「已过期」，后果是：
 * - 界面每张账号卡片都会显示红色「有效期：已过期」；
 * - 续期定时器每轮都把它挑出来（本 provider 又没有 refresh 端点可调）；
 * - 用户以为账号坏了，实际一切正常。
 *
 * 与 Loomy 同口径：「读不到就说读不到」，不把未知当失效。
 * 真正的失效由**上游 401** 反映（适配器按需给出可读文案）。
 */
export function isModelscopeExpired(credential) {
    const expiresAt = modelscopeCredentialExpiresAtMs(credential);
    if (expiresAt === undefined)
        return false;
    return expiresAt <= Date.now();
}
/**
 * 凭据是否**具备可续期的材料**。
 *
 * ⚠️ **恒为 `false`**，且这是**诚实标记而非状态**：魔搭没有任何 refresh 端点，
 * API Key 只能由用户回控制台重新生成。标 `true` 会让 UI 显示「可自动续期」
 * ——一个永远不会发生的承诺（与 Loomy 的 `isLoomyRefreshable` 同因）。
 *
 * 账号落池时 `refreshable` 必须写 `false`（见 `modelscope-rpc.ts`）。
 */
export function isModelscopeRefreshable(_credential) {
    return false;
}
/** 凭据的身份串（限流记录归属用；取不到时返回空串）。 */
export function modelscopeIdentityOf(credential) {
    return typeof credential?.access_token === 'string' ? credential.access_token : '';
}
/**
 * 把 API Key 打码成 `ms-…尾 4 位`（UI 一律用它，**绝不**展示明文）。
 *
 * ## ⚠️ 为什么取**尾 4** 位
 *
 * 与 `modelscopeSlotNamesOf`（账号 id 由**尾 8 位**派生）同一口径 ⇒ 用户在
 * 「账号 id」「凭据 ref」「卡片上的打码」三处看到的是同一段指纹，能互相核对。
 *
 * ⚠️ 形状不合法的**返回空串**而不是回显原文 —— 打码函数绝不能成为「把任意
 * 输入原样显示」的通道（否则用户粘贴了一段错误文本时会被整串上屏）。
 */
export function maskModelscopeKey(key) {
    if (typeof key !== 'string')
        return '';
    const trimmed = key.trim();
    // ⚠️ 与 `KEY_PATTERN`（modelscope-rpc.ts）同款形状：前缀 + 至少 16 位。
    if (!/^ms-[A-Za-z0-9_-]{16,}$/.test(trimmed))
        return '';
    return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}
/**
 * 构造发往魔搭的请求头。
 *
 * 逐字对齐旧 fork `src/proxy/remote-upstream.ts:234-241`：
 * `Content-Type: application/json` + `Authorization: Bearer <key>`，
 * 另加 `Accept`。
 *
 * ## ⚠️ Accept 必须**按用途区分**（旧 fork 实测踩到 406）
 *
 * 旧 fork 原本 `/models` 与 `/chat/completions` 共用 `text/event-stream`，
 * 而部分平台（实测 **ChatAnywhere**）的 `/models` 只接受 `application/json`，
 * 发 `text/event-stream` 会返回 **406** ⇒ 该上游模型列表**永远失败**。
 * 后果隐蔽：拉不到时上层只是静默跳过该上游，它提供的模型全部缺失。
 *
 * 魔搭本身未实测到 406，但这里**照样按用途区分** —— 判据不该依赖
 * 「另一个平台碰巧不校验」这种易变的外部事实（与 `PROBE_SYSTEM` 的取舍同因）。
 *
 * @param apiKey  API Key（空串时仍产出合法头，由调用方先判「有没有凭据」）。
 * @param accept  `'application/json'`（列举模型）或 `'text/event-stream'`（对话）。
 */
export function modelscopeHeaders(apiKey, accept = 'text/event-stream') {
    return {
        'content-type': 'application/json',
        accept,
        authorization: `Bearer ${apiKey}`,
    };
}
/** 对话端点全 URL。 */
export function modelscopeChatUrl(product = MODELSCOPE) {
    return `${product.baseUrl}${product.chatPath}`;
}
/** 模型目录端点全 URL。 */
export function modelscopeModelsUrl(product = MODELSCOPE) {
    return `${product.baseUrl}${product.modelsPath}`;
}
/**
 * 归一化模型 id。
 *
 * 魔搭的 `/v1/models` 返回的是**带命名空间前缀**的真实 id
 * （例：`deepseek-ai/DeepSeek-V4.1-Flash`），必须**原样**发给上游 ——
 * 剥掉 `deepseek-ai/` 会得到 404（"model not found"）。
 *
 * ⚠️ 本函数**只做去空白**，**刻意不做**任何前缀剥离/大小写归一。
 * 存在的意义是：把「调用方忘了 trim」这类失误收敛到一处，并让
 * 「不剥前缀」这条判据有一处可被单测点名的地方。
 * （对照：`canonical-models.ts` 的归一化是**给聚合分组用**的，绝不能回流到
 * 发请求的 model 字段上 —— 那是 qoder 那条「id 是内部代号」教训的同族。）
 */
export function normalizeModelscopeModelId(raw) {
    return raw.trim();
}
//# sourceMappingURL=modelscope.js.map