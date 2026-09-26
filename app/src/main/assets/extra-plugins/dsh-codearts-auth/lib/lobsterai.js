/**
 * LobsterAI（有道龙虾）协议常量、凭据结构与纯函数。
 *
 * 本模块只放**常量与纯函数**（无网络副作用，除显式的 fetcher 注入函数），
 * 与 `src/buddy.ts` 在 CodeBuddy 体系里的角色一致。网络流程见：
 * - `src/lobsterai-oauth.ts` —— 登录
 * - `src/lobsterai-auth.ts` —— 凭据服务（续期 / 状态）
 * - `src/lobsterai-adapter.ts` —— chat 转发
 * - `src/lobsterai-credits.ts` —— 签到与余额
 *
 * ## 协议速览（来源：`lobsterai2api`，实证见 docs/lobsterai-integration-plan.md §4）
 *
 * | 用途 | 方法 | 路径 | 认证 |
 * |---|---|---|---|
 * | 换 token | POST | `/api/auth/exchange` | 无 |
 * | 续期 | POST | `/api/auth/refresh` | 无（**不带 Authorization**） |
 * | 对话 | POST | `/api/proxy/v1/chat/completions` | Bearer |
 * | 模型列表 | GET | `/api/models/available` | Bearer |
 * | 积分余额 | GET | `/api/user/profile-summary` | Bearer |
 *
 * **统一信封** `{code, msg, data}`：`code !== 0` 即失败。
 * 唯一例外是 chat 端点 —— 它返回**裸 SSE，不套信封**。
 */
import { createHash } from 'node:crypto';
import { jwtExpiresAtMs } from './buddy.js';
// ── 端点路径 ──
/** 授权码换 token。 */
export const LOBSTERAI_EXCHANGE_PATH = '/api/auth/exchange';
/** 静默续期。 */
export const LOBSTERAI_REFRESH_PATH = '/api/auth/refresh';
/** 可用模型列表。 */
export const LOBSTERAI_MODELS_PATH = '/api/models/available';
/**
 * 对话端点（OpenAI 兼容，**仅支持 SSE**）。
 *
 * 积分余额端点（`/api/user/profile-summary`）刻意**不在此处**定义：
 * 唯一使用方是 `src/lobsterai-credits.ts`，常量就近定义在那里。
 * 曾经两处各定义一份同名常量，端点一旦变更只改一处会让语义分叉，
 * 且没有任何测试会失败 —— 单一真相源比「集中放一起」更重要。
 */
export const LOBSTERAI_CHAT_PATH = '/api/proxy/v1/chat/completions';
/** 登录回调路径（对齐 `cmd/login/main.go:35` 的 `callbackPath`）。 */
export const LOBSTERAI_CALLBACK_PATH = '/auth/callback';
/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const LOBSTERAI_REQUEST_TIMEOUT_MS = 30_000;
/** 登录流程总超时（毫秒）；对齐 `main.go:36` 的 10 分钟回调窗口。 */
export const LOBSTERAI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * 客户端版本号缓存有效期（毫秒，12 小时）。
 *
 * 版本号是**日期式**的（如 `2026.9.4`），变更频率极低（客户端发版节奏），
 * 而签到每次都要带它 —— 不缓存会让每次签到多一次跨域请求。
 */
export const LOBSTERAI_VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export function readStringField(source, key) {
    const value = source[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}
/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
export function readNumberField(source, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))
        return Number(value);
    return undefined;
}
/**
 * 解析 `{code, msg, data}` 信封。
 *
 * 三条判定（对齐 `main.go:143-150` 与 `sigin.py:44-48` 的双重校验）：
 *
 * 1. 响应体必须是对象；
 * 2. `code` 必须为 `0`；
 * 3. `data` 必须是**对象** —— 非对象一律视为失败。
 *
 * 第 3 条尤其重要：`sigin.py:46-47` 用它判定「accessToken 可能已失效」——
 * 上游在凭据失效时倾向于返回 `code:0` 但 `data:null`，
 * 只看 code 会把这种情况当成成功，随后在解引用时崩在更远的地方。
 */
export function parseLobsteraiEnvelope(body) {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, code: -1, message: '响应不是 JSON 对象' };
    }
    const record = body;
    const code = readNumberField(record, 'code') ?? -1;
    const message = readStringField(record, 'msg') || readStringField(record, 'message');
    if (code !== 0) {
        return { ok: false, code, message: message.length > 0 ? message : `code=${code}` };
    }
    const data = record.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return {
            ok: false,
            code,
            message: message.length > 0 ? message : 'data 为空（accessToken 可能已失效）',
        };
    }
    return { ok: true, data: data };
}
// ── 过期时间与可刷新判定 ──
/**
 * 从凭据的 `expires_at` 解析毫秒时间戳。
 *
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601 三种形态，与
 * `src/buddy.ts:credentialExpiresAtMs` 的解析口径一致（详见那里的说明）。
 *
 * 后备来源：`expires_at` 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 * Go 注释（`main.go:317`）说明「实测 HS512 access token 30 天」，
 * 故 access token 是 JWT，`exp` 是权威过期时刻。
 */
export function lobsteraiCredentialExpiresAtMs(credential) {
    const raw = credential.expires_at;
    if (typeof raw === 'string' && raw.length > 0) {
        if (/^\d+$/.test(raw)) {
            const value = Number(raw);
            return value > 1_000_000_000_000 ? value : value * 1000;
        }
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed))
            return parsed;
    }
    return jwtExpiresAtMs(credential.access_token);
}
/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与 Rust/Go 侧一致）。 */
export function isLobsteraiExpired(credential) {
    const expiresAt = lobsteraiCredentialExpiresAtMs(credential);
    return expiresAt === undefined ? false : Date.now() >= expiresAt;
}
/** 凭据是否携带可静默续期的 refresh_token。 */
export function isLobsteraiRefreshable(credential) {
    return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}
// ── 身份载荷（exchange / refresh / models 共用） ──
/**
 * 构造 `keyfrom` 身份载荷。
 *
 * 对应 Go 的 `Auth.KeyfromBody()`（`auth.go:37-50`）。三个字段的含义：
 *
 * - `firstKeyfrom` —— 首次登录时间戳，标识「这个账号是什么时候开始用的」；
 * - `latestKeyfrom` —— 最近活动时间戳，随每次调用更新；
 * - `version` —— 客户端版本号（**动态真值**，见 §7.2 R11 的说明）；
 * - `uuid` / `userId` —— 可选，缺失时不带该键（而非带空串）。
 *
 * `uuid` / `userId` 缺省时**删除键**而不是写空串：Go 的 `if a.Uuid != ""`
 * 就是「有才带」，空串可能被服务端当成非法值。
 */
export function lobsteraiKeyfromBody(credential, clientVersion) {
    const body = {
        firstKeyfrom: credential.first_keyfrom ?? '',
        // 直接用凭据里**存储的**值，不取当前时刻 —— 严格对齐 Go 的
        // `KeyfromBody()`（`auth.go:37-50`）：它读的就是 `a.LatestKeyfrom`，
        // 而 `RefreshToken`（`client.go:137-145`）从不更新该字段。
        // 因此 Go 每次续期发的都是「登录时的那一刻」，本插件照做。
        latestKeyfrom: credential.latest_keyfrom ?? '',
        version: clientVersion,
    };
    if (credential.uuid !== undefined && credential.uuid.length > 0)
        body.uuid = credential.uuid;
    if (credential.user_id !== undefined && credential.user_id.length > 0)
        body.userId = credential.user_id;
    return body;
}
/**
 * 构造续期请求体 = keyfrom 载荷 + `refreshToken`。
 *
 * `latestKeyfrom` 与 `firstKeyfrom` 都用**凭据里存储的原值**，不取当前时刻
 * （对齐 Go：`KeyfromBody()` 读 `a.LatestKeyfrom`，而 `RefreshToken`
 * 从不更新该字段）。详见 {@link lobsteraiKeyfromBody} 的说明。
 *
 * 注意 `version` 由调用方传入而非在函数内取全局缓存：这样本函数是纯函数、
 * 可完整单测，也不把「版本号从哪来」这个决策硬编码进来。
 */
export function lobsteraiRefreshBody(credential, clientVersion) {
    return {
        ...lobsteraiKeyfromBody(credential, clientVersion),
        refreshToken: credential.refresh_token,
    };
}
/**
 * 解析 exchange / refresh 响应里的令牌与用户信息。
 *
 * `expiresIn` 允许缺失：Go 在缺失时回退解 JWT `exp`（`main.go:313-319`），
 * 本插件在 {@link buildLobsteraiCredential} 里做同样的兜底。
 */
export function parseLobsteraiTokenPayload(data) {
    const user = typeof data.user === 'object' && data.user !== null
        ? data.user
        : {};
    const expiresIn = readNumberField(data, 'expiresIn');
    return {
        accessToken: readStringField(data, 'accessToken'),
        refreshToken: readStringField(data, 'refreshToken'),
        ...expiresIn === undefined ? {} : { expiresIn },
        userId: readStringField(user, 'id'),
        yid: readStringField(user, 'yid'),
        accountUserId: readStringField(user, 'userId'),
        nickname: readStringField(user, 'nickname'),
    };
}
/**
 * 解析账号唯一 ID，按**四级**回退（严格对齐 `main.go:297-306`）：
 *
 * `user.id` → `user.userId` → `user.yid` → `sha256(accessToken)` 前 16 位。
 *
 * 前三者是服务端字段，不同账号形态下哪个非空并不固定（个人号与企业号不同）；
 * 末级哈希兜底保证**任何情况下都能得到一个稳定 ID** —— 否则空 uid 会让
 * 账号池里多个账号互相覆盖（`addAccount` 按 id 去重）。
 *
 * 哈希取 hex 前 16 字符，与 Go 的 `fmt.Sprintf("%x", sha256.Sum256(...))[:16]`
 * 完全一致 —— 这是与 `lobsterai2api` 生成的 `auths/lobsterai-{uid}.json`
 * 逐字节对照的前提。
 *
 * ⚠️ **刻意不在 `yid` 与哈希之间插入 JWT `sub` 回退**：Go 没有这一级，
 * 插进去会让「服务端三个 user 字段皆空」的账号在本插件得到 `sub`、
 * 而在 Go 得到 16 位哈希 —— 同一账号两种 uid，破坏上述对照能力。
 * 稀有路径上与参考实现分叉，比多兜一层更糟。
 */
export function resolveLobsteraiUid(payload) {
    for (const candidate of [payload.userId, payload.accountUserId, payload.yid]) {
        if (candidate !== undefined && candidate.length > 0)
            return candidate;
    }
    return createHash('sha256').update(payload.accessToken).digest('hex').slice(0, 16);
}
/**
 * 由令牌载荷组装可持久化的凭据。
 *
 * `expires_at` 的取值顺序（**与 Go 一致**，`main.go:313-319`）：
 * 1. `expiresIn`（相对秒数）→ 以**当前时刻**为基准换算；
 * 2. 缺失时用 access token 的 JWT `exp`；
 * 3. 都拿不到则留空（`credentialExpiresAtMs` 会再尝试 JWT，仍失败则
 *    「不判定过期」——见 `isLobsteraiExpired`）。
 *
 * ⚠️ 基准取当前时刻而非 JWT `iat`：Go 用的是 `time.Now()`，
 * 与 Buddy 侧（用 iat）不同。保持与 Go 一致以便对照排查。
 *
 * `uuid` / `first_keyfrom` / `latest_keyfrom` 必须由调用方提供 ——
 * 它们不在响应里，而是登录流程自己生成的状态（见 `lobsterai-oauth.ts`）。
 */
export function buildLobsteraiCredential(payload, session) {
    const expiresAt = payload.expiresIn !== undefined && payload.expiresIn > 0
        ? String(Date.now() + payload.expiresIn * 1000)
        : (() => {
            const exp = jwtExpiresAtMs(payload.accessToken);
            return exp === undefined ? '' : String(exp);
        })();
    const uid = resolveLobsteraiUid(payload);
    return {
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
        expires_at: expiresAt,
        uid,
        user_id: payload.accountUserId !== undefined && payload.accountUserId.length > 0
            ? payload.accountUserId
            : (payload.yid ?? ''),
        nickname: payload.nickname ?? '',
        uuid: session.uuid,
        first_keyfrom: session.firstKeyfrom,
        latest_keyfrom: session.latestKeyfrom,
    };
}
/**
 * 用续期结果更新凭据（保留服务端未返回的字段）。
 *
 * **所有身份字段一律沿用旧值**（`uuid` / `first_keyfrom` / `latest_keyfrom`
 * / `uid` / `user_id` / `nickname`）：LobsterAI 的 refresh 响应只带令牌，
 * 不含 account 对象。
 *
 * ⚠️ `latest_keyfrom` **刻意不更新为当前时刻**（虽然字段名叫「最近活动」）——
 * 严格对齐 Go：`RefreshToken`（`client.go:137-145`）只改 token 与过期时间，
 * `LatestKeyfrom` 永久停留在登录时那一刻，续期时原样回发。
 * 语义上「刷新即活动、理应更新」是更直觉的读法，但 Go 是唯一在生产验证过的
 * 实现；若服务端对该字段有校验，自作聪明地更新会让续期失败，
 * 而这不是能从代码推导出来的，需要实测支撑（见计划文档 §7.2）。
 */
export function applyLobsteraiRefresh(previous, payload, nowMs = Date.now()) {
    const expiresAt = payload.expiresIn !== undefined && payload.expiresIn > 0
        ? String(nowMs + payload.expiresIn * 1000)
        : (() => {
            const exp = jwtExpiresAtMs(payload.accessToken);
            return exp === undefined ? (previous.expires_at ?? '') : String(exp);
        })();
    return {
        ...previous,
        access_token: payload.accessToken,
        // refresh 响应可能不返回新 refreshToken（沿用旧的），不能覆盖成空串。
        refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
        expires_at: expiresAt,
    };
}
// ── 请求头 ──
/**
 * 构造带 Bearer 的通用请求头。
 *
 * 只设四个头：LobsterAI **不认** CodeBuddy 那套
 * `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` 归属头，
 * 带上不仅无用，还可能让服务端按错误的客户端形态归因。
 */
export function lobsteraiAuthHeaders(credential, product, accept = 'application/json') {
    return {
        Authorization: `Bearer ${credential.access_token}`,
        Accept: accept,
        'Content-Type': 'application/json',
        'User-Agent': product.userAgent,
    };
}
/**
 * 构造对话请求头。
 *
 * 比 {@link lobsteraiAuthHeaders} 多两个 `X-LobsterAI-Client-*` 头，
 * `Accept` 为 SSE。这两个头来自 `client.go:94-101` 的实测实现：
 * `Capabilities` 声明客户端支持的 agentic 协议版本（影响工具调用行为），
 * `Version` 是客户端版本号（**用动态真值**，见下方说明）。
 *
 * 注意 `X-LobsterAI-Client-Version` 用传入的 `clientVersion` 而非
 * `product.fallbackClientVersion`：Go 侧一直发假值 `0.1.0` 未被拒绝，
 * 说明服务端不强校验，但**没有理由继续发假值**。
 */
export function lobsteraiChatHeaders(credential, product, clientVersion) {
    return {
        ...lobsteraiAuthHeaders(credential, product, 'text/event-stream, application/json'),
        'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
        'X-LobsterAI-Client-Version': clientVersion,
    };
}
/**
 * 构造**模型列表**请求头（`GET /api/models/available`）。
 *
 * 与 {@link lobsteraiChatHeaders} 同样带两个 `X-LobsterAI-Client-*` 头，
 * 只是 `Accept` 为 JSON 而非 SSE。
 *
 * **这两个头在本端点是必需的，不是可有可无的元数据**（2026-09-17 实测）：
 * 服务端按 `X-LobsterAI-Client-Capabilities` 声明的能力**过滤模型集合** ——
 * 不带该头时 `kimi-k3` 不会出现在返回里（25 个模型），带上 `kimi-k3-agentic-v1`
 * 才返回 26 个。IDE 侧走的就是 `buildServerModelCapabilityHeaders`，
 * 与本函数同形。
 *
 * 早先的实现用 {@link lobsteraiAuthHeaders}（只有 4 个基础头）请求本端点，
 * 因此即使解析正确也会**永久缺少 kimi-k3**。`X-LobsterAI-Client-Version`
 * 同理用动态真值。
 */
export function lobsteraiModelsHeaders(credential, product, clientVersion) {
    return {
        ...lobsteraiAuthHeaders(credential, product, 'application/json'),
        'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
        'X-LobsterAI-Client-Version': clientVersion,
    };
}
/**
 * 构造无认证请求头（exchange / refresh 用）。
 *
 * 这两个端点**不需要** `Authorization` —— 换 token 时还没有 token，
 * 续期时服务端只认请求体里的 `refreshToken`（`auth.go:104-108` 的
 * `authHeaders` 同样不设该头）。
 */
export function lobsteraiAnonymousHeaders(product) {
    return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': product.userAgent,
    };
}
// ── 客户端版本号 ──
/**
 * 校验并解析日期式版本号。
 *
 * 正则对齐 `sigin.py:16-18` 的 `version_key`：
 * `^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$` —— 主干为点分数字，
 * 允许一个可选的预发布后缀（如 `2026.9.4-beta.1`）。
 *
 * 之所以要**校验**而不是直接采信：版本号是签到接口的必填 query 参数，
 * 若上游返回 `null` / 空串 / HTML 错误页，把它拼进 URL 会让签到以一个
 * 更费解的错误失败。提前拒绝能给出「版本格式异常」这种可读原因
 * （对齐 `sigin.py:27-28` 的 `RuntimeError`）。
 *
 * @returns 归一化后的版本字符串；格式非法时返回 undefined。
 */
export function parseClientVersion(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    if (!/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(trimmed))
        return undefined;
    return trimmed;
}
/**
 * 从更新接口的响应体里取出 `data.value.version`。
 *
 * 该响应的结构与业务接口**不同**（见 `LOBSTERAI_CLIENT_VERSION_API` 说明）：
 * `code`/`msg` 在外层，载荷在 `data.value`。实测形状：
 * `{data:{value:{version:"2026.9.4", date, windowsX64:{url}, ...}}, code:0, msg:"OK"}`。
 */
export function parseClientVersionFromUpdate(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const outer = body.data;
    if (typeof outer !== 'object' || outer === null)
        return undefined;
    const value = outer.value;
    if (typeof value !== 'object' || value === null)
        return undefined;
    return parseClientVersion(value.version);
}
/**
 * 客户端版本号解析器（带进程内缓存与兜底）。
 *
 * 抽取成类而非模块级单例：模块级可变状态会让单元测试互相污染
 * （某个用例写入缓存后，后续用例就再也不会走到真实拉取分支）。
 * 生产侧在 `src/lobsterai-auth.ts` 里持有一个实例即可。
 */
export class LobsteraiClientVersionResolver {
    options;
    cached;
    cachedAt = 0;
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * 解析当前客户端版本号。
     *
     * 顺序：进程内缓存（未过期）→ 请求上游更新接口 → 兜底常量。
     *
     * **失败不回退到抛错**（与 `sigin.py:73-76` 的「整个脚本放弃签到」不同）：
     * 返回 `fallbackClientVersion` 并在返回值里标出 `source`，
     * 让调用方能决定是否记日志。理由见 `LOBSTERAI_FALLBACK_CLIENT_VERSION` 说明。
     */
    async resolve(product) {
        const now = this.options.now?.() ?? Date.now();
        const ttl = this.options.ttlMs ?? LOBSTERAI_VERSION_CACHE_TTL_MS;
        if (this.cached !== undefined && now - this.cachedAt < ttl) {
            return { version: this.cached, source: 'cache' };
        }
        const fetched = this.options.fetcher ?? fetch;
        try {
            const response = await fetched(product.clientVersionApi, {
                method: 'GET',
                headers: { Accept: 'application/json', 'User-Agent': product.userAgent },
                signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
            });
            if (response.ok) {
                const version = parseClientVersionFromUpdate(await response.json());
                if (version !== undefined) {
                    this.cached = version;
                    this.cachedAt = now;
                    return { version, source: 'remote' };
                }
            }
        }
        catch {
            // 网络/解析失败：走兜底。刻意不缓存兜底值 ——
            // 缓存会让一次瞬时故障在 TTL 内持续影响后续请求。
        }
        return { version: product.fallbackClientVersion, source: 'fallback' };
    }
    /** 清空缓存（测试与「强制刷新版本号」场景用）。 */
    clear() {
        this.cached = undefined;
        this.cachedAt = 0;
    }
}
//# sourceMappingURL=lobsterai.js.map