/**
 * Accio 的协议常量、凭据结构与纯函数。
 *
 * ## 协议总览（全部 2026-10-12 实测，详见 `docs/agent-notes/providers-accio.md`）
 *
 * ```
 * POST {gateway}/api/adk/llm/generateContent?sg_k={md5(requestId)}
 *   headers: Content-Type / Accept: text/event-stream / utdid / version / appKey:'OneChat'
 *   body   : Gemini 风格信封（键 snake_case）+ token（★ 必须在 body，放 Authorization 头恒 402）
 * ```
 *
 * ⚠️ **不需要 SecurityGuard 签名**（实测：不带 `pctb-x-*` 同样 200）。
 * 参考实现把它当必需，故背上了 `security_guard.node` 与一串阿里 DLL —— 本实现不需要。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ACCIO } from './accio-product.js';
/**
 * 秒→毫秒归一化。**所有**写入 `expires_at` 的地方都必须经过它。
 *
 * @param raw 上游 `expiresAt`（**秒**）或已是毫秒的值。
 * ⚠️ `> 1e12` 视为已是毫秒（防御性：容忍上游某天改单位）。
 */
export function accioExpiresAtMs(raw) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0)
        return undefined;
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}
/** 凭据的过期时刻（毫秒）；读不到返回 `undefined`（**不伪装成 0**）。 */
export function accioCredentialExpiresAtMs(credential) {
    return accioExpiresAtMs(credential?.expires_at);
}
/** 是否已过期。读不到过期时间时视为**未过期**（让适配器按需续期兜底）。 */
export function isAccioExpired(credential) {
    const at = accioCredentialExpiresAtMs(credential);
    if (at === undefined)
        return false;
    return at <= Date.now();
}
/** 是否可续期 —— ⚠️ 只要求 `refresh_token` 非空（不读池里的 `refreshable`）。 */
export function isAccioRefreshable(credential) {
    return typeof credential?.refresh_token === 'string' && credential.refresh_token !== '';
}
/** 一次请求的 id（也用于 `sg_k` 与 `message_id` 的派生）。 */
export function accioRequestId() {
    return `req-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
/** `sg_k` = md5(requestId) 的 hex。 */
export function accioSgK(requestId) {
    return createHash('md5').update(requestId, 'utf8').digest('hex');
}
/**
 * `message_id` —— ⚠️ **必填**，缺它上游回 400（与其它字段无关）。
 *
 * 掺入随机量：同一 `requestId` 连续两次不能相同（上游可能按它去重）。
 */
export function accioMessageId(requestId) {
    return createHash('md5').update(`${requestId}:${randomBytes(16).toString('hex')}`, 'utf8').digest('hex');
}
/**
 * camelCase → snake_case（递归），与官方客户端的 `Vn()` 同口径。
 *
 * ⚠️ `undefined` 的键**整个丢掉**：保留会让 JSON 里出现 `null`，
 * 而上游对 `system_instruction: null` 之类的处理与「键不存在」不同。
 */
export function accioToSnake(value) {
    if (Array.isArray(value))
        return value.map((v) => accioToSnake(v));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (v === undefined)
                continue;
            out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = accioToSnake(v);
        }
        return out;
    }
    return value;
}
/**
 * 构造请求体（已 snake_case 化）。
 *
 * ⚠️ 四处硬约束（逐条实测 / 逐字逆向）：
 * 1. `empid` / `tenant` / `iai_tag` **必须空串**（真实值会被拒）；
 * 2. `message_id` **必填**；
 * 3. `token` 必须在 **body**（放 `Authorization` 头恒流内 402）；
 * 4. ⚠️⚠️ **`system_instruction` 是「字符串」，不是 `{parts:[{text}]}` 对象**。
 *    本函数初版照 Gemini 的 `systemInstruction.parts` 形态产出**对象**，
 *    实测**恒回 `HTTP 200` + 流内 `400`**（Task 6 真机验证）。
 *    **权威证据**（官方 proto，`gateway-worker.js`）：
 *    `systemInstruction: gt(e.systemInstruction) ? globalThis.String(e.systemInstruction) : …`
 *    —— 两处都用 `String()` 归一；诊断路径的判据同样是
 *    `typeof t.system_instruction === 'string'`。
 *    ⇒ Accio 与 Gemini 在这一格上**不同形**，别照搬 Gemini。
 */
export function buildAccioBody(options) {
    const camel = {
        model: options.model,
        empid: '',
        tenant: '',
        iaiTag: '',
        requestId: options.requestId,
        userRequestId: options.requestId,
        contents: options.contents,
        // ⚠️ 字符串原样传（不要包成 { parts: [...] }），空串时不产出该键
        systemInstruction: options.systemInstruction === undefined || options.systemInstruction === ''
            ? undefined
            : options.systemInstruction,
        // ⚠️⚠️ **tools 的 JSON Schema 必须保持「字符串化」**（`toAccioTools` 里
        //    `JSON.stringify(fn.parameters)` ⇒ `parameters_json`），**不得**改成包装形态
        //    `{ function_declarations: [{ name, parameters: {…对象…} }] }`。
        //
        //    理由：下面的 `accioToSnake` 会**递归下钻对象与数组**，而**不下钻字符串**。
        //    参数名（`filePath` / `oldString` …）是**数据**，不是协议字段：
        //    · 保持字符串 ⇒ 它们逐字节原样送到上游，不在改写路径上，安全；
        //    · 改成对象   ⇒ 递归 snake 化会把 `filePath` **静默改写成** `file_path`，
        //      与调用方按原 schema 消费的那份定义**失配**，且没有任何报错。
        //    （本仓库首条红线「同一份语义两套判据」的变体：这里是 schema 被当协议字段改写。）
        //
        //    ⚠️ 实测依据见 `docs/agent-notes/providers-accio.md` §4.1.2：
        //    真机探针用的就是扁平字符串形态，上游回了正确的 `function_call` 帧。
        tools: options.tools !== undefined && options.tools.length > 0 ? options.tools : undefined,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        stopSequences: [],
        properties: {
            utdid: options.utdid,
            version: ACCIO.appVersion,
            appKey: ACCIO.appKey,
            normalizedResponse: 'true',
        },
        token: options.accessToken,
        messageId: accioMessageId(options.requestId),
        incremental: true,
    };
    const body = accioToSnake(camel);
    // ⚠️ properties 子树**不参与** camel→snake 转换：实测成功的形状里
    //    `appKey` 是驼峰、而 `normalized_response` 是 snake（两种键形混用）。
    //    参考实现与官方客户端都只往里补 `normalized_response`，不转换它。
    //    走通用递归转换会把它改成 `app_key` —— 那是**未实测**的形状。
    body.properties = {
        utdid: options.utdid,
        version: ACCIO.appVersion,
        appKey: ACCIO.appKey,
        normalized_response: 'true',
    };
    return body;
}
/** 请求头。⚠️ **不带** SecurityGuard 的 `pctb-x-*`（实测不必需）。 */
export function accioHeaders(options) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        utdid: options.utdid,
        version: ACCIO.appVersion,
        appKey: ACCIO.appKey,
    };
    if (typeof options.sgcookie === 'string' && options.sgcookie !== '') {
        headers.sgcookie = options.sgcookie;
    }
    return headers;
}
//# sourceMappingURL=accio.js.map